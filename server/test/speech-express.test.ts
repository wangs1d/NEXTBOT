// SpeechHub（统一开口出口）单测：light 档 LLM 话术 + 模板兜底 + 用量熔断
// + 块装配（人格·静态/语感/画像浅层按需注入）+ speakRaw（调用方自有任务文本）。
// 全部用 mock chat provider（零外网、零真实 LLM）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpeechHub } from "../src/proactivity/speech-express.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

type Capture = { systemPrompt?: string; text: string };

function mockChat(reply: string | Error, delayMs = 0): ExternalChatProvider & { calls: number; captures: Capture[] } {
  const state = { calls: 0 };
  const captures: Capture[] = [];
  const provider = {
    isEnabled: () => true,
    async streamCompletion(
      _sessionId: string,
      input: { text: string },
      onDelta: (d: string) => void,
      _x?: unknown,
      opts?: { systemPromptOverride?: string },
    ): Promise<void> {
      state.calls += 1;
      captures.push({ systemPrompt: opts?.systemPromptOverride, text: input.text });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (reply instanceof Error) throw reply;
      onDelta(reply);
    },
  } as unknown as ExternalChatProvider & { calls: number; captures: Capture[] };
  Object.defineProperty(provider, "calls", { get: () => state.calls });
  (provider as { captures: Capture[] }).captures = captures;
  return provider;
}

function makeHub(
  chat: ExternalChatProvider | null,
  opts: { maxPerDay?: number; timeoutMs?: number; extra?: Partial<ConstructorParameters<typeof SpeechHub>[0]> } = {},
) {
  if (opts.maxPerDay !== undefined) process.env.PROACTIVITY_MAX_PHRASE_PER_DAY = String(opts.maxPerDay);
  const hub = new SpeechHub({
    chat: () => chat,
    dataPath: mkdtempSync(join(tmpdir(), "speech-hub-")),
    timeoutMs: opts.timeoutMs ?? 8_000,
    ...opts.extra,
  });
  delete process.env.PROACTIVITY_MAX_PHRASE_PER_DAY;
  return hub;
}

const FALLBACK = "刚帮你盯着消息呢——有人发来「会议推迟」，要我帮你改日程吗？";

test("speak: LLM 正常生成 → 返回话术并记账", async () => {
  const chat = mockChat("李雷说会议推迟了，要我帮你把日历改到周四吗？");
  const hub = makeHub(chat);
  const out = await hub.speak({
    kind: "message_watch",
    sessionId: "u1",
    facts: { sender: "李雷", excerpt: "会议推迟到周四", verb: "推迟" },
    fallback: FALLBACK,
    tier: "light",
  });
  assert.equal(chat.calls, 1);
  assert.ok(out.includes("李雷"), `LLM 话术含人名: ${out}`);
  assert.equal(hub.stats().callsToday, 1);
  assert.equal(hub.stats().enabled, true);
  // 材料段：facts 进 user prompt，kind 不生成指令
  const sent = chat.captures[0]!;
  assert.ok(sent.text.includes("李雷"), "事实材料在 user prompt");
  assert.ok(sent.text.includes("message_watch"), "场景标识在材料段");
});

test("speak: LLM 失败/超时 → 模板兜底永不中断表达", async () => {
  const errChat = mockChat(new Error("provider down"));
  const hub1 = makeHub(errChat);
  assert.equal(
    await hub1.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" }),
    FALLBACK,
  );
  assert.ok(hub1.stats().lastFallback?.startsWith("error:"), "失败原因留痕");

  const slowChat = mockChat("太慢了", 300);
  const hub2 = makeHub(slowChat, { timeoutMs: 50 });
  assert.equal(
    await hub2.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" }),
    FALLBACK,
  );
});

test("speak: 输出异常（SILENT/过长/多行）→ 兜底", async () => {
  for (const bad of ["SILENT", "x".repeat(150), "第一行\n第二行"]) {
    const hub = makeHub(mockChat(bad));
    const out = await hub.speak({ kind: "unread_burst", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
    assert.equal(out, FALLBACK, `异常输出应兜底: ${bad.slice(0, 10)}`);
  }
  // allowNewlines 放开后多行合法（明日预告 narration 形态）
  const hub = makeHub(mockChat("第一行\n第二行"));
  const out = await hub.speak({
    kind: "evening_digest", sessionId: "u1", facts: {}, fallback: FALLBACK,
    tier: "light", allowNewlines: true, maxChars: 150,
  });
  assert.equal(out, "第一行\n第二行", "多句正文在放开后合法");
});

test("speak: 每日熔断——超 cap 后走模板且不再调 LLM", async () => {
  const chat = mockChat("好的短句");
  const hub = makeHub(chat, { maxPerDay: 2 });
  await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  assert.equal(chat.calls, 2);
  const out = await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  assert.equal(chat.calls, 2, "熔断后不再调用");
  assert.equal(out, FALLBACK);
  assert.equal(hub.stats().enabled, false);
});

test("speak: kill switch 与无 provider 直接模板（零调用）", async () => {
  process.env.PROACTIVITY_PHRASE_LLM = "0";
  const chat = mockChat("不会走到这");
  const hub = makeHub(chat);
  assert.equal(
    await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" }),
    FALLBACK,
  );
  assert.equal(chat.calls, 0);
  delete process.env.PROACTIVITY_PHRASE_LLM;

  const hub2 = makeHub(null);
  assert.equal(
    await hub2.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" }),
    FALLBACK,
  );
  assert.equal(hub2.stats().enabled, false);
});

test("speak: 重要性分配——低于门槛直接模板不花调用，高优照常润色", async () => {
  const chat = mockChat("李雷说会议推迟，要我帮你改到周四吗？");
  const hub = makeHub(chat);
  const low = await hub.speak({
    kind: "unread_burst", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light", importance: "low",
  });
  assert.equal(low, FALLBACK);
  assert.equal(chat.calls, 0);
  assert.equal(hub.stats().lastFallback, "low_importance(low)");
  const high = await hub.speak({
    kind: "message_watch", sessionId: "u1", facts: { sender: "李雷" }, fallback: FALLBACK, tier: "light", importance: "high",
  });
  assert.equal(chat.calls, 1);
  assert.ok(high.includes("李雷"));
  // 门槛可放宽到 medium（env）
  process.env.PROACTIVITY_PHRASE_MIN_IMPORTANCE = "medium";
  const med = await hub.speak({
    kind: "unread_burst", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light", importance: "medium",
  });
  delete process.env.PROACTIVITY_PHRASE_MIN_IMPORTANCE;
  assert.equal(chat.calls, 2, "门槛放宽后 medium 也润色");
  assert.notEqual(med, FALLBACK);
});

test("块装配：soul/语感/画像按需注入，字段空=块不渲染", async () => {
  const chat = mockChat("好的短句");
  const hub = makeHub(chat, {
    extra: {
      personaPrompt: () => "# 人格·静态\n你是 NEXTBOT。",
      voiceProfile: () => "【语感基准】\n短句、平调。",
      styleBrief: async () => "称呼：老铁",
    },
  });
  await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  const sys = chat.captures[0]!.systemPrompt ?? "";
  assert.ok(sys.includes("人格·静态"), "soul 块在最前");
  assert.ok(sys.includes("语感基准"), "语感块其次");
  assert.ok(sys.includes("【主动开口】"), "通用指令块");
  assert.ok(sys.includes("一句话"), "light 档单句约束");
  assert.ok(sys.indexOf("人格·静态") < sys.indexOf("【主动开口】"), "稳定块在指令块之前");
  assert.ok(sys.includes("称呼：老铁"), "画像浅层沉底");

  // 全缺 → 回退纯指令块（老行为）
  const chat2 = mockChat("好的短句");
  const plain = makeHub(chat2);
  await plain.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  const sys2 = chat2.captures[0]!.systemPrompt ?? "";
  assert.ok(sys2.includes("【主动开口】"));
  assert.ok(!sys2.includes("人格·静态"), "无人格块");
});

test("按需加载矩阵：任一块单独缺失不渲染，其余块不受影响", async () => {
  const SOUL = "SOUL-MARK 人格·静态";
  const VOICE = "VOICE-MARK 语感基准";
  const BRIEF = "BRIEF-MARK 称呼：老铁";
  const mk = (extra: Record<string, unknown>) => {
    const chat = mockChat("好的短句");
    const hub = makeHub(chat, { extra });
    return { chat, hub };
  };
  const probe = async (extra: Record<string, unknown>) => {
    const { chat, hub } = mk(extra);
    await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
    return chat.captures[0]!.systemPrompt ?? "";
  };
  // 只给 soul → 语感/画像缺席，其余照常
  const onlySoul = await probe({ personaPrompt: () => SOUL });
  assert.ok(onlySoul.includes(SOUL) && !onlySoul.includes(VOICE) && !onlySoul.includes(BRIEF), "单 soul");
  // 只给语感 → soul/画像缺席
  const onlyVoice = await probe({ voiceProfile: () => VOICE });
  assert.ok(onlyVoice.includes(VOICE) && !onlyVoice.includes(SOUL) && !onlyVoice.includes(BRIEF), "单语感");
  // 只给画像 → soul/语感缺席，且画像沉底指令块之后
  const onlyBrief = await probe({ styleBrief: async () => BRIEF });
  assert.ok(onlyBrief.includes(BRIEF) && !onlyBrief.includes(SOUL) && !onlyBrief.includes(VOICE), "单画像");
  assert.ok(onlyBrief.indexOf("【主动开口】") < onlyBrief.indexOf(BRIEF), "画像仍在指令块之后");
  // soul 抛错 = 块缺失，不拖垮装配（对齐「读取失败不阻塞」契约）
  const brokenSoul = await probe({ personaPrompt: () => { throw new Error("boom"); }, voiceProfile: () => VOICE });
  assert.ok(brokenSoul.includes(VOICE) && !brokenSoul.includes("SOUL-MARK"), "异常提供者按缺失处理");
});

test("装配确定性：同输入同字节（prefix cache 友好），档位只变指令行", async () => {
  const chat = mockChat("好的短句");
  const hub = makeHub(chat, {
    extra: {
      personaPrompt: () => "# 人格·静态\n你是 NEXTBOT。",
      styleBrief: async () => "称呼：老铁",
    },
  });
  const req = { sessionId: "u1", kind: "away_return", facts: {}, fallback: FALLBACK } as const;
  const a = await hub.buildSystemPrompt({ ...req, tier: "full" });
  const b = await hub.buildSystemPrompt({ ...req, tier: "full" });
  assert.equal(a, b, "同请求两次装配字节一致");
  const light = await hub.buildSystemPrompt({ ...req, tier: "light" });
  const full = await hub.buildSystemPrompt({ ...req, tier: "full" });
  assert.notEqual(light, full, "档位差异体现在指令行");
  // 指令行之外完全一致（人格/画像跨档共享，不重复装配）
  const strip = (s: string) => s.split("\n\n").filter((x) => !x.includes("【主动开口】")).join("\n\n");
  assert.equal(strip(light), strip(full), "非指令块跨档共享");
});

test("buildSystemPrompt: full 档带先查证指令；speakRaw 直通调用方任务文本", async () => {
  const chat = mockChat("好的短句");
  const hub = makeHub(chat);
  const full = await hub.buildSystemPrompt({ sessionId: "u1", kind: "away_return", tier: "full" });
  assert.ok(full.includes("调用工具"), "full 档允许先做事");

  const raw = await hub.speakRaw({
    kind: "evening_digest",
    sessionId: "u1",
    tier: "light",
    allowNewlines: true,
    maxChars: 150,
    fallback: FALLBACK,
    userPrompt: "明日预告数据段：日程 A；天气小雨",
  });
  assert.equal(raw, "好的短句");
  assert.ok(chat.captures[0]!.text.includes("明日预告数据段"), "调用方任务文本直通 user 轮");
});

test("recordUsage: full 档计入同一熔断池", async () => {
  const chat = mockChat("好的短句");
  const hub = makeHub(chat, { maxPerDay: 1 });
  hub.recordUsage();
  const out = await hub.speak({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK, tier: "light" });
  assert.equal(chat.calls, 0, "full 档占掉配额后 light 档被熔断");
  assert.equal(out, FALLBACK);
});
