/**
 * 手机端对话式首启引导回归（2026-11-09 改版）：
 *  1. 开场白为确定性两泡：嗨+注册称呼+管家定位一泡，直接问 agent 名字一泡；
 *     取名卡随第二泡挂载下发（onboarding.name_choices，messageId 对齐）。
 *  2. 答案抽取：名字的确定性解析，抽不到不推进阶段；明确的「叫我X」补称呼事实。
 *  3. 端到端状态机：只跑一次、桌面端不触发、称呼进 structured_facts、
 *     名字走统一改名管道、完成后 hint 消失。
 *
 * 全部用内存假件，不碰真实数据；prefs/账号落盘路径在 import 前指向临时目录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testTmp = join(
  tmpdir(),
  `mobile-onboarding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.AGENT_ACCOUNTS_FILE = join(testTmp, "accounts.json");
process.env.USER_PREFERENCES_FILE = join(testTmp, "prefs.json");

const {
  buildIntroBubbles,
  extractUserAlias,
  extractAgentName,
  explicitUserAlias,
  readOnboardingStage,
  ONBOARDING_STATE_KV_KEY,
} = await import("../src/services/onboarding-state.js");
const { OnboardingIntroService } = await import("../src/services/onboarding-intro-service.js");
const { registerMemoryComponents } = await import("../src/agentic-memory/index.js");

test("intro: 开场白确定性两泡，带注册称呼时问候带名字", () => {
  const [first, second] = buildIntroBubbles("阿哲");
  assert.ok(first.startsWith("嗨，阿哲，"), "问候要带上用户名称");
  assert.ok(first.includes("私人管家"), "定位是私人管家");
  assert.ok(first.includes("😊"), "笑脸收尾");
  assert.ok(first.includes("交给我就好"), "生活事务交给管家");
  assert.equal(second, "你想叫我什么呢，之后你也可以修改。");
});

test("intro: 没有注册称呼时退化为无名字问候（不出现空占位）", () => {
  const [first, second] = buildIntroBubbles(undefined);
  assert.equal(first, "嗨，我是你的私人管家，以后生活中的事情交给我就好 😊");
  const [firstBlank] = buildIntroBubbles("   ");
  assert.equal(firstBlank, first, "纯空白称呼视同缺失");
  assert.ok(second.includes("想叫我什么"));
});

test("extract: 称呼与名字的口语句式、尾缀、引号", () => {
  assert.equal(extractUserAlias("叫我阿哲就行"), "阿哲");
  assert.equal(extractUserAlias("叫我「王哥」吧"), "王哥");
  assert.equal(extractUserAlias("阿哲"), "阿哲");
  assert.equal(extractUserAlias("明天早上提醒我开会"), null);
  assert.equal(explicitUserAlias("叫我阿哲就行"), "阿哲", "明确句式才算自我称呼");
  assert.equal(explicitUserAlias("阿哲"), null, "短名兜底不算明确自我称呼");
  assert.equal(extractAgentName("叫你小来包吧"), "小来包");
  assert.equal(extractAgentName("你就叫晚潮好了"), "晚潮");
  assert.equal(extractAgentName("小来包"), "小来包");
  assert.equal(extractAgentName("叫我阿哲就行"), null, "「叫我X」是自我称呼，不是给 agent 取名");
  assert.equal(extractAgentName("帮我查一下明天天气"), null);
});

type FakeDeps = ReturnType<typeof makeDeps>;

function makeDeps(accountDisplayName?: string) {
  const kv = new Map<string, string>();
  const pushes: string[] = [];
  const broadcasts: string[] = [];
  const facts: { field: string; value: string }[] = [];
  const renames: string[] = [];
  const now = () => 1_762_000_000_000;

  const memorySync = {
    getSnapshot(_actorId: string, keys?: string[]) {
      const entries: Record<string, string> = {};
      for (const key of keys ?? []) {
        if (kv.has(`${_actorId}:${key}`)) entries[key] = kv.get(`${_actorId}:${key}`)!;
      }
      return { revision: 1, entries };
    },
    async setEntryAndWait(actorId: string, key: string, value: string) {
      kv.set(`${actorId}:${key}`, String(value));
      return true;
    },
    async seedIfAbsent(actorId: string, key: string, value: string) {
      const k = `${actorId}:${key}`;
      if (kv.has(k)) return false;
      kv.set(k, String(value));
      return true;
    },
    appendMemorySummaryLine() {},
  };
  const wsRegistry = {
    trySend(_actorId: string, data: string) {
      broadcasts.push(data);
      return true;
    },
    trySendToDeviceClasses(_actorId: string, data: string, classes: string[]) {
      assert.deepEqual(classes, ["mobile"]);
      pushes.push(data);
      return true;
    },
  };
  const accounts = {
    getByActorId() {
      return accountDisplayName ? { displayName: accountDisplayName } : undefined;
    },
    async register(_actorId: string, displayName: string) {
      renames.push(displayName);
      return { accountId: "acc-1" };
    },
    async markSetupComplete() {},
    async updateDisplayName(_actorId: string, displayName: string) {
      renames.push(displayName);
      return { accountId: "acc-1" };
    },
  };
  const factStore = {
    applyFact(input: { field: string; value: string }) {
      facts.push({ field: input.field, value: input.value });
      return { changed: true };
    },
    getFact(_actorId: string, field: string) {
      const hit = facts.find((f) => f.field === field);
      return hit ? { value: hit.value } : null;
    },
  };
  registerMemoryComponents({ factStore: factStore as never });

  const service = new OnboardingIntroService({
    accounts: accounts as never,
    memorySync: memorySync as never,
    wsRegistry: wsRegistry as never,
    now,
    secondBubbleDelayMs: 0,
  });
  return { service, kv, pushes, broadcasts, facts, renames, memorySync };
}

test("flow: 开场白两泡+取名卡随第二泡下发，注册称呼进事实库", async () => {
  const d: FakeDeps = makeDeps("小明");
  await d.service.maybeStart("u1", "mobile");
  // 两泡 + 一张取名卡（onboarding.name_choices 帧）
  assert.equal(d.pushes.length, 3, "问候泡 + 问名泡 + 取名卡");
  const bubbleFrames = d.pushes.filter((p) => p.includes("first_meeting_intro"));
  assert.equal(bubbleFrames.length, 2);
  const first = JSON.parse(bubbleFrames[0]!).payload;
  const second = JSON.parse(bubbleFrames[1]!).payload;
  assert.match(first.text, /嗨，小明，/);
  assert.ok(first.text.includes("😊"));
  assert.equal(second.text, "你想叫我什么呢，之后你也可以修改。");
  // 第二泡带服务端 messageId，取名卡挂同一个 id
  assert.ok(second.messageId, "第二泡带 messageId");
  const cardFrame = d.pushes.find((p) => p.includes("onboarding.name_choices"));
  assert.ok(cardFrame, "取名卡帧已推送");
  const cardPayload = JSON.parse(cardFrame!).payload;
  assert.equal(cardPayload.messageId, second.messageId, "卡与泡同 messageId");
  assert.equal(cardPayload.choices.length, 3, "三个候选名");
  assert.match(cardPayload.title, /想叫我什么/);
  // 注册称呼立即落 structured_facts
  assert.deepEqual(d.facts, [{ field: "称呼", value: "小明" }]);
  // 状态机直接进「等取名」阶段
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "awaiting_agent_name");
  assert.ok(d.service.nameChoiceCardFor("u1"), "等取名阶段可补挂取名卡");
  assert.match(d.service.hintForTurn("u1") ?? "", /等用户给你取名/);

  await d.service.onUserText("u1", "叫你小来包吧");
  assert.deepEqual(d.renames, ["小来包"], "走统一改名管道");
  assert.ok(d.broadcasts.some((b) => b.includes("identity_renamed")), "广播给两端刷新顶栏");
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "done");
  assert.equal(d.service.hintForTurn("u1"), undefined);
  assert.equal(d.service.nameChoiceCardFor("u1"), null, "名字定了不再下发取名卡");

  // 重连/再登录不得重复发开场白
  const before = d.pushes.length;
  await d.service.maybeStart("u1", "mobile");
  assert.equal(d.pushes.length, before);
  assert.ok(d.kv.has(`u1:${ONBOARDING_STATE_KV_KEY}`));
});

test("flow: 等取名阶段「叫我X」只补称呼事实，不推进阶段不改 agent 名", async () => {
  const d: FakeDeps = makeDeps();
  await d.service.maybeStart("u2", "mobile");
  d.facts.length = 0;
  await d.service.onUserText("u2", "叫我阿哲就行");
  assert.deepEqual(d.facts, [{ field: "称呼", value: "阿哲" }]);
  assert.equal(readOnboardingStage(d.memorySync as never, "u2"), "awaiting_agent_name");
  assert.deepEqual(d.renames, [], "没有把自我称呼当成 agent 名");

  await d.service.onUserText("u2", "明天早上七点叫我起床");
  assert.equal(d.facts.length, 1, "任务句不误收");
  assert.deepEqual(d.renames, []);

  await d.service.onUserText("u2", "叫你小来包吧");
  assert.deepEqual(d.renames, ["小来包"]);
  assert.equal(readOnboardingStage(d.memorySync as never, "u2"), "done");
});

test("flow: 桌面端不触发", async () => {
  const d: FakeDeps = makeDeps();
  await d.service.maybeStart("u3", "desktop");
  assert.equal(d.pushes.length, 0);
  assert.equal(readOnboardingStage(d.memorySync as never, "u3"), null);
});

/**
 * 端到端（全真实件）：新用户首次在手机端登录是否触发引导。
 * 唯一假件是 WS socket（收帧探针）；KV / 账号 / prefs / sqlite 事实库 /
 * 连接注册表全部是生产实现，文件与库都落在临时目录。
 */
test("e2e: 真实 KV+账号+prefs+事实库下，新用户手机端首连触发引导并两端共享落库", async () => {
  const {
    AgentMemorySyncService,
  } = await import("../src/services/agent-memory-sync-service.js");
  const { AgentAccountService } = await import("../src/services/agent-account-service.js");
  const { WsConnectionRegistry } = await import("../src/services/ws-connection-registry.js");
  const { StructuredFactStore } = await import("../src/agentic-memory/structured-fact-store.js");
  const { openAgenticSqlite } = await import("../src/agentic-memory/sqlite-store.js");
  const { getUserPreferences, patchAgentProfile } = await import(
    "../src/routes/http/user-preferences.js"
  );
  const { AGENT_NAME_KV_KEY, parseAgentIdentityKv } = await import(
    "../src/services/agent-identity.js"
  );

  const actor = "fresh-user@example.com";
  const kvFile = join(testTmp, "kv-e2e.json");
  const memorySync = new AgentMemorySyncService(kvFile);
  const accounts = new AgentAccountService();
  const factStore = new StructuredFactStore(openAgenticSqlite(join(testTmp, "facts-e2e.db")));
  registerMemoryComponents({ factStore: factStore as never });

  // 注册（新流程：称呼在注册表单填写，落账号 displayName）
  await accounts.register(actor, "小明", actor);

  // 真实连接注册表 + 假手机 socket（只当收帧探针）
  const phoneFrames: string[] = [];
  const registry = new WsConnectionRegistry();
  registry.register(
    actor,
    { readyState: 1, send: (data: string) => phoneFrames.push(data) } as never,
    { deviceClass: "mobile" },
  );

  const service = new OnboardingIntroService({
    accounts,
    memorySync: memorySync as never,
    wsRegistry: registry,
    now: () => 1_762_000_000_000,
    secondBubbleDelayMs: 0,
  });

  // 1) 新用户手机端首次 session.init → 触发：两泡 + 取名卡推到手机 socket
  await service.maybeStart(actor, "mobile");
  const introFrames = phoneFrames.filter((f) => f.includes("first_meeting_intro"));
  assert.equal(introFrames.length, 2, "问候 + 问名两泡都送达手机端");
  const firstBubble = JSON.parse(introFrames[0]!).payload;
  assert.match(firstBubble.text, /嗨，小明，/, "问候带注册称呼");
  assert.ok(
    phoneFrames.some((f) => f.includes("onboarding.name_choices")),
    "取名卡帧已推送",
  );
  assert.equal(factStore.getFact(actor, "称呼")?.value, "小明", "注册称呼落事实库");
  assert.equal(readOnboardingStage(memorySync as never, actor), "awaiting_agent_name");

  // 2) 重连（真实注册表再登记一次）不重复打扰
  await service.maybeStart(actor, "mobile");
  assert.equal(
    phoneFrames.filter((f) => f.includes("first_meeting_intro")).length,
    2,
    "重连后不再发开场白",
  );

  // 3) 答名字 → 走真实统一改名管道：KV + 账号 + prefs + identity_renamed 广播
  await service.onUserText(actor, "叫你小来包吧");
  const identity = parseAgentIdentityKv(
    memorySync.getSnapshot(actor, [AGENT_NAME_KV_KEY]).entries[AGENT_NAME_KV_KEY],
  );
  assert.equal(identity?.displayName, "小来包", "prompt 自我认知 KV 已更新");
  assert.equal(
    getUserPreferences(actor).agentProfile?.displayName,
    "小来包",
    "prefs 显示名已更新（手机顶栏/桌面端同源）",
  );
  assert.ok(
    phoneFrames.some((f) => f.includes("identity_renamed")),
    "改名广播已发到手机端",
  );
  assert.equal(readOnboardingStage(memorySync as never, actor), "done");

  // 4) 重启级持久化：用同一 KV 文件新开实例（生产启动由 bootstrap 显式 load）
  const reloaded = new AgentMemorySyncService(kvFile);
  await reloaded.load();
  assert.equal(readOnboardingStage(reloaded as never, actor), "done", "重启后不重复引导");

  // 5) 桌面端老账号（已有名字）手机端登录只标完成、不打扰
  const veteran = "veteran@example.com";
  patchAgentProfile(veteran, { displayName: "老伙计" }, { allowIdentity: true });
  await service.maybeStart(veteran, "mobile");
  assert.equal(readOnboardingStage(memorySync as never, veteran), "done");
  assert.ok(
    !phoneFrames.some((f) => f.includes(veteran)),
    "老账号没有收到任何引导帧",
  );
});
