/**
 * 手机端对话式首启引导回归（2026-11-07）：
 *  1. 两泡结构：问候独占一泡，能力介绍+问称呼一泡且只有一个句末问号；
 *  2. 答案抽取：称呼/名字的确定性解析，抽不到不推进阶段；
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
  INTRO_FALLBACK,
  splitIntroIntoBubbles,
  extractUserAlias,
  extractAgentName,
  readOnboardingStage,
  ONBOARDING_STATE_KV_KEY,
} = await import("../src/services/onboarding-state.js");
const { OnboardingIntroService } = await import("../src/services/onboarding-intro-service.js");
const { registerMemoryComponents } = await import("../src/agentic-memory/index.js");

test("intro: 兜底正文拆成两泡，第二泡只有一个句末问号", () => {
  const bubbles = splitIntroIntoBubbles(INTRO_FALLBACK);
  assert.equal(bubbles.length, 2);
  assert.match(bubbles[0]!, /今天正式上岗。$/);
  assert.ok(bubbles[1]!.includes("晨报"));
  assert.ok(bubbles[1]!.includes("怎么称呼你"));
  const body = bubbles[1]!.slice(0, -1);
  assert.ok(!/[。！？!?；;\n]/.test(body), "第二泡内部不能有句末标点/换行（否则会被切泡）");
});

test("intro: LLM 只给一段时也能按首个句末标点拆两泡", () => {
  const bubbles = splitIntroIntoBubbles("嗨，今天上岗。定提醒、管日程，先认识一下——平时怎么称呼你？");
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0], "嗨，今天上岗。");
  assert.ok(bubbles[1]!.endsWith("？"));
  assert.ok(bubbles[1]!.includes("定提醒"));
});

test("extract: 称呼与名字的口语句式、尾缀、引号", () => {
  assert.equal(extractUserAlias("叫我阿哲就行"), "阿哲");
  assert.equal(extractUserAlias("叫我「王哥」吧"), "王哥");
  assert.equal(extractUserAlias("阿哲"), "阿哲");
  assert.equal(extractUserAlias("明天早上提醒我开会"), null);
  assert.equal(extractAgentName("叫你小来包吧"), "小来包");
  assert.equal(extractAgentName("你就叫晚潮好了"), "晚潮");
  assert.equal(extractAgentName("小来包"), "小来包");
  assert.equal(extractAgentName("帮我查一下明天天气"), null);
});

type FakeDeps = ReturnType<typeof makeDeps>;

function makeDeps() {
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
      return null;
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
  const speech = {
    async speakRaw() {
      return INTRO_FALLBACK;
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
    speech: speech as never,
    now,
    secondBubbleDelayMs: 0,
  });
  return { service, kv, pushes, broadcasts, facts, renames, memorySync };
}

test("flow: 手机端只引导一次，称呼与名字都落账号级权威源", async () => {
  const d: FakeDeps = makeDeps();
  await d.service.maybeStart("u1", "mobile");
  assert.equal(d.pushes.length, 2, "问候 + 介绍提问共两泡");
  assert.ok(d.pushes.every((p) => p.includes("first_meeting_intro")));
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "awaiting_alias");
  assert.equal(
    d.service.nameChoiceCardFor("u1"),
    null,
    "问称呼阶段不给取名卡",
  );
  assert.match(d.service.hintForTurn("u1") ?? "", /补一句问称呼/);

  await d.service.onUserText("u1", "叫我阿哲就行");
  assert.deepEqual(d.facts, [{ field: "称呼", value: "阿哲" }]);
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "awaiting_agent_name");
  assert.match(d.service.hintForTurn("u1") ?? "", /接下来该问用户想怎么称呼你/);
  const card = d.service.nameChoiceCardFor("u1");
  assert.ok(card, "问名字阶段下发取名卡");
  assert.equal(card!.choices.length, 3, "三个候选名");
  assert.ok(card!.choices.every((c) => c.trim().length > 0));
  assert.match(card!.title, /怎么称呼我/);

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

test("flow: 桌面端不触发；一句话同时给称呼和名字时两步并一步", async () => {
  const d: FakeDeps = makeDeps();
  await d.service.maybeStart("u2", "desktop");
  assert.equal(d.pushes.length, 0);

  await d.service.maybeStart("u3", "mobile");
  await d.service.onUserText("u3", "叫我阿哲，叫你小来包吧");
  assert.deepEqual(d.facts, [{ field: "称呼", value: "阿哲" }]);
  assert.deepEqual(d.renames, ["小来包"]);
  assert.equal(readOnboardingStage(d.memorySync as never, "u3"), "done");
});

test("flow: 抽不到答案保持阶段，不误把任务句当成名字", async () => {
  const d: FakeDeps = makeDeps();
  await d.service.maybeStart("u4", "mobile");
  await d.service.onUserText("u4", "明天早上七点叫我起床");
  assert.equal(readOnboardingStage(d.memorySync as never, "u4"), "awaiting_alias");
  assert.equal(d.facts.length, 0);
  assert.equal(d.renames.length, 0);
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
    speech: null, // 不依赖 LLM：走 INTRO_FALLBACK，行为确定
    now: () => 1_762_000_000_000,
    secondBubbleDelayMs: 0,
  });

  // 1) 新用户手机端首次 session.init → 触发：两泡推到手机 socket，状态落真实 KV
  await service.maybeStart(actor, "mobile");
  const introFrames = phoneFrames.filter((f) => f.includes("first_meeting_intro"));
  assert.equal(introFrames.length, 2, "问候 + 介绍提问两泡都送达手机端");
  assert.equal(readOnboardingStage(memorySync as never, actor), "awaiting_alias");

  // 2) 重连（真实注册表再登记一次）不重复打扰
  await service.maybeStart(actor, "mobile");
  assert.equal(
    phoneFrames.filter((f) => f.includes("first_meeting_intro")).length,
    2,
    "重连后不再发开场白",
  );

  // 3) 答称呼 → 落真实 sqlite structured_facts
  await service.onUserText(actor, "叫我阿哲就行");
  assert.equal(factStore.getFact(actor, "称呼")?.value, "阿哲");
  assert.equal(readOnboardingStage(memorySync as never, actor), "awaiting_agent_name");

  // 4) 答名字 → 走真实统一改名管道：KV + 账号 + prefs + identity_renamed 广播
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

  // 5) 重启级持久化：用同一 KV 文件新开实例（生产启动由 bootstrap 显式 load）
  const reloaded = new AgentMemorySyncService(kvFile);
  await reloaded.load();
  assert.equal(readOnboardingStage(reloaded as never, actor), "done", "重启后不重复引导");

  // 6) 桌面端老账号（已有名字）手机端登录只标完成、不打扰
  const veteran = "veteran@example.com";
  patchAgentProfile(veteran, { displayName: "老伙计" }, { allowIdentity: true });
  await service.maybeStart(veteran, "mobile");
  assert.equal(readOnboardingStage(memorySync as never, veteran), "done");
  assert.ok(
    !phoneFrames.some((f) => f.includes(veteran)),
    "老账号没有收到任何引导帧",
  );
});
