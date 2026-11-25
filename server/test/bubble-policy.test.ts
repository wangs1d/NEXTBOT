/**
 * 车道裁决单测（2026-11-25 车道架构）：
 * - 车道在 T0 定死：输入只有路由前/路由时就绪的信号
 * - 语音 / 任务面 / 整块交付场景 → 单条车道（不发文字块，done 一次交付）
 * - 闲聊 → 气泡车道（流式块即最终呈现，done 只做对账定稿）
 * - 旧 done 裁决（decidePresentation / splitReplyBubbles / 塌缩通道）必须不存在
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  decideTextLane,
  type TextLaneInputs,
} from "../src/agent/bubble-policy.js";

const chatBase: TextLaneInputs = {
  voiceMode: false,
  segmentable: true,
  sceneSingleBubble: false,
};

test("T0 裁决：闲聊走气泡车道，语音/任务面/整块场景走单条", () => {
  assert.deepEqual(decideTextLane(chatBase), { lane: "bubbles", reason: "chat" });
  const cases: Array<[Partial<TextLaneInputs>, string]> = [
    [{ voiceMode: true }, "voice"],
    [{ segmentable: false }, "task-surface"],
    [{ sceneSingleBubble: true }, "scene-single-bubble"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(
      decideTextLane({ ...chatBase, ...patch }),
      { lane: "single", reason },
      reason,
    );
  }
});

test("优先级：语音轮优先于一切（不因其它信号改变）", () => {
  assert.deepEqual(
    decideTextLane({ ...chatBase, voiceMode: true, sceneSingleBubble: true }),
    { lane: "single", reason: "voice" },
  );
});

test("旧 done 裁决必须退役：不存在 done 阶段的呈现权翻转", () => {
  const policy = readFileSync(new URL("../src/agent/bubble-policy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(policy, /export (async )?function (decidePresentation|splitReplyBubbles)/);
  assert.doesNotMatch(policy, /PresentationOwner/);
  const tracker = readFileSync(new URL("../src/agent/bubble-tracker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(tracker, /setFinalBubbles/, "气泡账本唯一写入路径是流式，不得有 done 重建入口");
});
