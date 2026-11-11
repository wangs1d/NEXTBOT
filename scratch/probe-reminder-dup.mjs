/**
 * 探针：复现「设置提醒出两张一样的提醒确认卡」。
 * 模拟真实链路：full（processAssistantText 等价）→ cards-only（done 补卡等价）→
 * buildReplyBlocks / buildRenderEnvelope，数每层 [AGENT_RESULT_CARD_START] 的数量。
 * 用法：cd server && node --import tsx ../scratch/probe-reminder-dup.mjs
 */
import { renderTurn } from "../server/src/render/turn.js";
import { buildReplyBlocks } from "../server/src/services/reply-envelope.js";
import { buildRenderEnvelope } from "../server/src/render/protocol.js";
import { effectStatusOf } from "../server/src/render/index.js";

const receipt = {
  ok: true,
  action: "create",
  taskId: "task-1",
  nextRunAt: "2026-11-13T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  title: "开会",
  reminderMessage: "开会",
  whenSpoken: "明天",
  recurrence: "none",
};

const count = (label, text) => {
  const n = (text.match(/\[AGENT_RESULT_CARD_START\]/g) || []).length;
  console.log(`${label}: card markers = ${n}`);
  return n;
};

// ── 场景 A：回执只进 reminder 捕获列表（旧行为）──
{
  const effects = [{ tool: "calendar", status: effectStatusOf(receipt), result: receipt }];
  const full = renderTurn({ text: "好，明天 9 点提醒你开会", effects }, "full");
  count("A full", full.text);
  const done = renderTurn({ text: full.text, effects }, "cards-only");
  count("A cards-only", done.text);
}

// ── 场景 B：2026-11-11 复合重构后，calendar 有了 registry builder，
//     同一份回执同时进 reminder 捕获列表与 registryResults（去重后仍应 1 张）──
{
  const effects = [
    { tool: "calendar", status: effectStatusOf(receipt), result: receipt },
    { tool: "calendar", status: effectStatusOf(receipt), result: receipt },
  ];
  const full = renderTurn({ text: "好，明天 9 点提醒你开会", effects }, "full");
  count("B full", full.text);
  const done = renderTurn({ text: full.text, effects }, "cards-only");
  count("B cards-only", done.text);
  const env = buildRenderEnvelope({
    finalText: done.text,
    legacyBlocks: buildReplyBlocks(done.text),
  });
  const cards = env.blocks.filter((b) => b.type === "card");
  console.log(`B envelope card blocks = ${cards.length}, cardTypes=${env.meta.cardTypes.join(",")}`);
}

// ── 场景 C：模型同一轮真的调了两次 calendar（两个 taskId）→ 应合并成一张卡两行 ──
{
  const receipt2 = { ...receipt, taskId: "task-2" };
  const effects = [
    { tool: "calendar", status: effectStatusOf(receipt), result: receipt },
    { tool: "calendar", status: effectStatusOf(receipt), result: receipt2 },
  ];
  const full = renderTurn({ text: "好，明天 9 点提醒你开会", effects }, "full");
  count("C full", full.text);
}
