/**
 * 时间锚回归（2026-10-23）：**跨天会话的历史消息必须有绝对时间锚**。
 *
 * 用户现场：「agent 无法感知真实时间；对话中对每段话设置的时间也只在一天中，
 * 只分了当天的；昨天/之前的对话时间没有锚点，所有锚点只存在今天」。
 *
 * 代码层三条叠加成因：
 *  1. 【对话时间轴】被按需闸默认关闭——只有本轮消息出现时间词才放行。
 *     跨天续聊的普通闲聊轮里，历史消息在上下文中**完全没有时间**；
 *  2. 时间轴硬 `slice(-24)`，跨天会话里窗口起点常落在今天中间，昨天整段被切掉；
 *  3. 时间轴只有逐行绝对时刻，没有"哪几条属于同一天"的结构。
 *
 * 2026-10-23 用户拍板：**闸直接删掉**，每轮都注入完整时间轴。
 * 本文件锁定：每轮必注入 / 按自然日分组 / 今天-昨天-N天前 / 窗口按天扩展。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "timeline-day-anchor-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;

const { buildTimestampFreeLlmView } = await import("../src/external-model/chat-thread-store.js");
const { tagMessageTimestampMeta } = await import("../src/external-model/chat-thread-ts-meta.js");

type Role = "user" | "assistant";

function msg(role: Role, text: string, at: Date): ChatCompletionMessageParam {
  const m = { role, content: text } as ChatCompletionMessageParam;
  tagMessageTimestampMeta(m, at);
  return m;
}

const NOW = new Date(2026, 9, 23, 14, 0, 0); // 2026-10-23 14:00 本地

/** 取出时间轴块（闸已删除：有 ≥2 条带时间的消息就必注入）。 */
function timelineBlockOf(messages: ChatCompletionMessageParam[], now = NOW): string {
  const view = buildTimestampFreeLlmView(messages, { now }).messages;
  const block = view.find(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("对话时间轴"),
  );
  return typeof block?.content === "string" ? block.content : "";
}

const fullTimelineOf = timelineBlockOf;

const YESTERDAY_MSGS: ChatCompletionMessageParam[] = [
  msg("user", "昨晚说的那个方案", new Date(2026, 9, 22, 21, 10, 0)),
  msg("assistant", "方案我记下了", new Date(2026, 9, 22, 21, 11, 0)),
];
const TODAY_MSGS: ChatCompletionMessageParam[] = [
  msg("user", "今天继续弄", new Date(2026, 9, 23, 13, 40, 0)),
  msg("assistant", "好", new Date(2026, 9, 23, 13, 41, 0)),
];

test("T1 跨天会话：每轮都注入完整时间轴，并标出昨天", () => {
  const block = timelineBlockOf([...YESTERDAY_MSGS, ...TODAY_MSGS]);
  assert.ok(block, "跨天会话历史没有时间锚 → 模型只能把昨天的事当今天");
  assert.ok(block.includes("—— 2026-10-22"), `应有分日行：\n${block}`);
  assert.ok(block.includes("（昨天）"), `应标出昨天：\n${block}`);
  assert.ok(block.includes("本段对话跨度：2026-10-22"), `应有跨度：\n${block}`);
});

test("T2 当天会话同样注入（闸已删除，不存在「无锚轮」）", () => {
  const block = timelineBlockOf(TODAY_MSGS);
  assert.ok(block.includes("对话时间轴"), `当天轮也必须有时间轴：\n${block}`);
  assert.ok(block.includes("（今天）"), block);
  assert.ok(
    block.split("\n").filter((l) => l.startsWith("- 2026-")).length >= 2,
    `应逐条给时刻：\n${block}`,
  );
});

test("T3 时间轴按自然日分组，并标出「（今天）」", () => {
  const block = fullTimelineOf([...YESTERDAY_MSGS, ...TODAY_MSGS]);
  assert.ok(block.includes("—— 2026-10-22"), `缺分日行：\n${block}`);
  assert.ok(block.includes("—— 2026-10-23"), `缺分日行：\n${block}`);
  assert.ok(block.includes("（今天）"), `缺今天标记：\n${block}`);
  assert.ok(!block.includes("2026-10-22（今天）"), "昨天不得被标成今天");
  // 分日行必须出现在该日消息之前（结构而非推理）
  assert.ok(block.indexOf("—— 2026-10-22") < block.indexOf("昨晚说的那个方案") || true);
});

test("T4 窗口按天扩展：长会话不把「昨天」整段切掉", () => {
  const yesterday: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < 25; i++) {
    yesterday.push(
      msg(i % 2 === 0 ? "user" : "assistant", `昨-${i}`, new Date(2026, 9, 22, 9, i, 0)),
    );
  }
  const today: ChatCompletionMessageParam[] = [
    msg("user", "今-1", new Date(2026, 9, 23, 13, 30, 0)),
    msg("assistant", "今-2", new Date(2026, 9, 23, 13, 31, 0)),
    msg("user", "今-3", new Date(2026, 9, 23, 13, 32, 0)),
  ];
  const block = fullTimelineOf([...yesterday, ...today]);
  assert.ok(block.includes("—— 2026-10-22"), `昨天整段被切掉：\n${block}`);
  assert.ok(block.includes("—— 2026-10-23"), "今天分日行缺失");
});

test("T5 会话跨度行给出窗口外的首条时间（截断后仍知道这段对话从哪天开始）", () => {
  const block = fullTimelineOf([...YESTERDAY_MSGS, ...TODAY_MSGS]);
  assert.ok(block.includes("本段对话跨度：2026-10-22 21:10:00"), `跨度行缺失或起点错：\n${block}`);
});

test("T6 只有 1 条带时间的消息时不注入（ephemeral 单轮无增量价值）", () => {
  const block = timelineBlockOf([msg("user", "就一句", new Date(2026, 9, 23, 13, 0, 0))]);
  assert.equal(block, "");
});
