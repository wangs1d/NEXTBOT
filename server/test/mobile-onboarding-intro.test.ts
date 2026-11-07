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
  assert.match(d.service.hintForTurn("u1") ?? "", /补一句问称呼/);

  await d.service.onUserText("u1", "叫我阿哲就行");
  assert.deepEqual(d.facts, [{ field: "称呼", value: "阿哲" }]);
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "awaiting_agent_name");
  assert.match(d.service.hintForTurn("u1") ?? "", /接下来该问用户想怎么称呼你/);

  await d.service.onUserText("u1", "叫你小来包吧");
  assert.deepEqual(d.renames, ["小来包"], "走统一改名管道");
  assert.ok(d.broadcasts.some((b) => b.includes("identity_renamed")), "广播给两端刷新顶栏");
  assert.equal(readOnboardingStage(d.memorySync as never, "u1"), "done");
  assert.equal(d.service.hintForTurn("u1"), undefined);

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
