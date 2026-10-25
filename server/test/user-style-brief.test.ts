/**
 * 用户画像浅层影响（UserStyleBrief + SpeechPolisher styleBrief 注入）单测。
 *
 * 覆盖：
 *   1. 投影：行数/字符双上限、段头过滤、空画像 → null（宁缺勿错）
 *   2. TTL 缓存：5min 内不重读画像
 *   3. SpeechPolisher：styleBrief 注入 → system prompt 携带画像浅层背景；
 *     未注入 → 与旧版一致；读取抛错 → 回退不阻塞
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createUserStyleBrief } from "../src/brain/user-style-brief.js";
import { SpeechPolisher } from "../src/proactivity/speech-polisher.js";

const PROFILE = [
  "【基本信息】",
  "称呼：老铁",
  "所在地：贵州兴义",
  "职业：后端开发",
  "【沟通偏好】",
  "直接说结论，别铺垫",
  "【兴趣】",
  "喝咖啡，爬山",
].join("\n");

test("style-brief：投影行数上限 + 段头过滤 + 空画像 null", async () => {
  let reads = 0;
  const brief = createUserStyleBrief({
    readProfile: async (actorId) => {
      reads += 1;
      return actorId === "empty" ? "" : PROFILE;
    },
    maxLines: 4,
    maxChars: 320,
  });
  const out = await brief("u1");
  assert.ok(out);
  assert.equal(out!.split("\n").length, 4, "最多 4 行");
  assert.ok(!out!.includes("【"), "段头不入摘要");
  assert.ok(out!.includes("称呼：老铁"), "basic 段优先保留");
  assert.equal(await brief("empty"), null, "空画像 → null（回退无画像）");

  // TTL 缓存：同 actor 二次调用不重读
  const before = reads;
  await brief("u1");
  assert.equal(reads, before, "TTL 内走缓存");
});

test("style-brief：字符上限截断 + 画像读取失败降级 null", async () => {
  const brief = createUserStyleBrief({
    readProfile: async () => "称呼：老铁\n职业：后端开发\n这一行特别长".repeat(50),
    maxChars: 60,
  });
  const out = await brief("u1");
  assert.ok(out && out.length <= 62, "总字符受 maxChars 约束");

  const broken = createUserStyleBrief({
    readProfile: async () => {
      throw new Error("db locked");
    },
  });
  assert.equal(await broken("u1"), null, "读取失败降级，不阻塞旁路生成");
});

// ───────────────────── SpeechPolisher 注入 ─────────────────────

type Capture = { systemPrompt?: string; text: string };

function makeChat() {
  const captures: Capture[] = [];
  const chat = {
    isEnabled: () => true,
    async streamCompletion(
      _thread: string,
      input: { text: string },
      onDelta: (d: string) => void,
      _x?: unknown,
      opts?: { systemPromptOverride?: string },
    ) {
      captures.push({ systemPrompt: opts?.systemPromptOverride, text: input.text });
      onDelta("好的呀，马上到。");
    },
  };
  return { chat, captures };
}

const POLISH_INPUT = {
  kind: "price_watch_hit",
  sessionId: "u1",
  facts: { item: "XM6", price: "¥800" },
  fallback: "你盯的耳机降价了。",
} as const;

test("speech-polisher：styleBrief 注入 → system prompt 携带画像浅层背景", async () => {
  const { chat, captures } = makeChat();
  const polisher = new SpeechPolisher({
    chat: () => chat as never,
    dataPath: ".tmp-polisher-style-test",
    styleBrief: async () => "称呼：老铁\n所在地：贵州兴义",
    nowFn: () => new Date("2026-10-23T10:00:00Z"),
  });
  const out = await polisher.polish({ ...POLISH_INPUT });
  assert.equal(out, "好的呀，马上到。");
  const sys = captures[0]!.systemPrompt ?? "";
  assert.ok(sys.includes("私人助理"), "基础人设仍在");
  assert.ok(sys.includes("用户画像浅层背景"), "注入画像段");
  assert.ok(sys.includes("称呼：老铁"), "画像行在 system prompt 里");
});

test("speech-polisher：未注入 styleBrief → 与旧版一致；读取抛错不阻塞", async () => {
  const { chat, captures } = makeChat();
  const plain = new SpeechPolisher({
    chat: () => chat as never,
    dataPath: ".tmp-polisher-style-test",
    nowFn: () => new Date("2026-10-23T10:00:00Z"),
  });
  await plain.polish({ ...POLISH_INPUT });
  assert.ok(!(captures[0]!.systemPrompt ?? "").includes("用户画像浅层背景"), "无画像段");

  const broken = new SpeechPolisher({
    chat: () => chat as never,
    dataPath: ".tmp-polisher-style-test",
    styleBrief: async () => {
      throw new Error("boom");
    },
    nowFn: () => new Date("2026-10-23T10:00:00Z"),
  });
  const out = await broken.polish({ ...POLISH_INPUT });
  assert.equal(out, "好的呀，马上到。", "画像读取抛错 → 照常润色");
});
