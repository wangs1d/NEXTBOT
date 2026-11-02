/**
 * 分泡真链探针（2026-09-29 逗号永不切泡配套，参照 probe-confirm-round.ts 骨架）。
 *
 * 真实 LLM 闲聊轮：streamCompletion 的 onDelta 原样喂给生产同款 StreamSegmenter
 * （enableBubbleMode，泡间停顿置 0），逐泡记录后断言——
 *  1. 内容守恒：全部泡拼接后的可见内容 == 模型最终文本的可见内容（去空白/标点比对）；
 *  2. 边界合法：除最后一条外，每条泡都以句末标点收尾（。！？!?；;）——
 *     逗号/顿号等句中位置永不成为泡边界（2026-09-29 用户反馈："靠字数随便截断"
 *     导致「这是定律，/ 躲不掉的。」半截话泡）；
 *  3. 泡数不超 maxBubbles，无空泡。
 *
 * 另含一个零成本回归腿：把 2026-09-29 真机事故原句逐 delta 喂同款分段器，
 * 断言整句不被逗号拦腰截断。
 *
 * 用法：npx tsx scripts/probe-bubble-split.ts [--repeats=2]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repeats = Number.parseInt(process.argv.find((a) => a.startsWith("--repeats="))?.slice(10) ?? "2", 10) || 2;

const { StreamSegmenter } = await import("../src/agent/stream-segmenter.js");

type BubbleRecord = { text: string; bubble?: "new" | "continue" };

/** 生产同款分段器（零停顿），返回记录器。 */
function makeSegmenter(): { seg: InstanceType<typeof StreamSegmenter>; bubbles: BubbleRecord[] } {
  const bubbles: BubbleRecord[] = [];
  const seg = new StreamSegmenter((text, _phase, meta) => {
    bubbles.push({ text, bubble: meta?.bubble });
  }, {
    pauseMs: 0,
    interimReplyGapMs: 0,
    holdFirstSentence: false,
    segmentationEnabled: true,
    bubbleGapMinMs: 0,
    bubbleGapMaxMs: 0,
  });
  seg.enableBubbleMode();
  return { seg, bubbles };
}

/** 可见内容指纹：去空白与全部标点，只留字母/数字/汉字，用于内容守恒比对。 */
function fingerprint(s: string): string {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).join("");
}

import assert from "node:assert/strict";

const VISIBLE_RE = /[\p{L}\p{N}]/u;
const SENTENCE_END_TAIL_RE = /[。！？!?；;…]["'」』”）)\]*]*$/u;
const STRONG_BREAK_GAP_RE = /[\n。！？!?；;]/u;

/**
 * 分泡序列校验（对原始流 S 逐步走查）：
 * 1. 守恒：S 的可见字序列 == 各泡可见字序列依次拼接（游标逐一比对）；
 * 2. 边界：第 i 泡与第 i+1 泡之间的切点必须落在句末——前泡以句末标点收尾，
 *    或间隙里含句末标点/换行。逗号切点（「这是定律，/ 躲不掉的。」事故形态）
 *    两者皆不满足，必被抓出。continue 残差 = 流在句中自然结束、追加同泡，跳过。
 */
function verifyBubbles(S: string, bubbles: BubbleRecord[], label: string): void {
  assert(bubbles.length >= 1, `${label}: 至少一泡`);
  assert(
    bubbles.filter((b) => b.bubble === "new").length <= 4,
    `${label}: new 泡数超上限`,
  );
  for (const b of bubbles) {
    assert(b.text.length > 0, `${label}: 存在空泡`);
    assert(!/[，,、]$/u.test(b.text), `${label}: 泡以逗号收尾（半截话泡）→「…${b.text.slice(-12)}」`);
  }
  const positions: Array<{ first: number; last: number }> = [];
  let cursor = 0;
  const nextVisible = (from: number): number => {
    let i = from;
    while (i < S.length && !VISIBLE_RE.test(S[i])) i += 1;
    return i;
  };
  for (const b of bubbles) {
    let first = -1;
    let last = -1;
    for (const ch of b.text) {
      if (!VISIBLE_RE.test(ch)) continue;
      const i = nextVisible(cursor);
      assert(i < S.length, `${label}: 泡内容超出原始流（守恒失败）`);
      assert.equal(S[i], ch, `${label}: 泡内容与原始流不一致（守恒失败）@${i}`);
      if (first < 0) first = i;
      last = i;
      cursor = i + 1;
    }
    positions.push({ first, last });
  }
  for (let i = 0; i + 1 < bubbles.length; i += 1) {
    if (bubbles[i + 1].bubble === "continue") continue;
    const gap = S.slice(positions[i].last + 1, positions[i + 1].first);
    const ok =
      SENTENCE_END_TAIL_RE.test(bubbles[i].text.trim()) || STRONG_BREAK_GAP_RE.test(gap);
    assert(
      ok,
      `${label}: 第${i + 1}泡起点落在句中（切点间隙=${JSON.stringify(gap)}，前泡尾=「…${bubbles[i].text.slice(-10)}」）`,
    );
  }
}

async function main(): Promise<void> {
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[bubble-probe] 外部模型 provider 未启用，无法探针");
    process.exit(1);
  }

  // ── 回归腿（零成本）：2026-09-29 真机事故原句，逐 delta 喂生产同款分段器 ──
  {
    const incident = "国庆哪都人多，这是定律，躲不掉的。但能躲掉“最挤的那几个地方”。";
    const { seg, bubbles } = makeSegmenter();
    for (const ch of incident) seg.feed(ch);
    await seg.chain;
    await seg.flushFinal();
    verifyBubbles(incident, bubbles, "事故原句回归");
    assert.equal(
      bubbles.filter((b) => b.text.startsWith("躲不掉")).length,
      0,
      "事故原句回归: 不存在以依附半句「躲不掉的」开头的泡",
    );
    console.log(`[bubble-probe] 事故原句回归 ✓ → ${bubbles.length} 泡：${bubbles.map((b) => `「${b.text}」`).join(" / ")}`);
  }

  // ── 真链腿：真实 LLM 闲聊轮（截图同场景：国庆出游闲聊） ──
  const { buildPersonaPrompt } = await import("../src/agent/soul-store.js");
  const { buildPersonaMoodBlock } = await import("../src/agent/persona-core.js");
  const { finalizeChatSystemPrompt } = await import("../src/agent/prompt-builder.js");
  const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
  const kernel = getRuntimeKernel();
  const persona = buildPersonaPrompt({ userAlias: "王哥" });
  const mood = buildPersonaMoodBlock("casual_wit");
  const systemPrompt = [finalizeChatSystemPrompt(kernel.buildSessionSystem() ?? "", { tools: true }), persona]
    .filter(Boolean)
    .join("\n\n");

  const CASES = [
    "国庆想要出去玩 但是那里人都很多",
    "在吗，帮我看看这周末去哪儿玩人少一点",
  ];

  const results: Array<{ user: string; final: string; bubbles: BubbleRecord[]; ok: boolean; error?: string }> = [];
  for (const c of CASES) {
    for (let i = 0; i < repeats; i += 1) {
      const label = `${c}#${i}`;
      const { seg, bubbles } = makeSegmenter();
      const sessionId = `bubble-probe-${Date.now()}-${results.length}`;
      let fed = "";
      let final = "";
      try {
        final = await provider.streamCompletion(
          sessionId,
          { text: `${mood}\n\n${c}` },
          (delta: string) => {
            fed += delta;
            seg.feed(delta);
          },
          {
            executeTool: async () => ({ ok: false, result: { error: "probe: 工具未接" } }),
          } as never,
          {
            toolExposureProfile: "none",
            toolLoop: { maxRounds: 2 },
            turnIntent: "chat",
            ephemeralTurn: true,
            systemPromptOverride: systemPrompt,
          } as never,
        );
      } catch (err) {
        console.error(`[bubble-probe] 轮失败：${label} → ${err instanceof Error ? err.message : err}`);
        results.push({ user: c, final, bubbles, ok: false, error: String(err) });
        provider.clearSession?.(sessionId);
        continue;
      }
      provider.clearSession?.(sessionId);
      await seg.flushFinal();
      try {
        verifyBubbles(fed, bubbles, label);
        results.push({ user: c, final, bubbles, ok: true });
        console.log(`\n──── ${label} ────`);
        console.log(`[最终 ${final.length}字] ${bubbles.length} 泡：${bubbles.map((b) => `「${b.text.slice(0, 40)}${b.text.length > 40 ? "…" : ""}」`).join(" / ")}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ user: c, final, bubbles, ok: false, error: msg });
        console.error(`\n[bubble-probe] ✗ ${label}: ${msg}\n  泡序列：${bubbles.map((b) => `「${b.text.slice(0, 60)}」`).join(" / ")}`);
      }
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const summary = {
    label: "bubble-split-probe",
    turns: results.length,
    ok: okCount,
    rows: results.map((r) => ({ user: r.user, ok: r.ok, bubbles: r.bubbles.map((b) => b.text), error: r.error })),
  };
  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `bubble-split-probe-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), "utf8");
  console.log(`\n[bubble-probe] 通过 ${okCount}/${results.length}；明细 → ${outPath}`);
  if (okCount !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error("[bubble-probe] 探针异常", err);
  process.exit(1);
});
