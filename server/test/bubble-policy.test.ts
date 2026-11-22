import assert from "node:assert/strict";
import test from "node:test";

import { resolveBubbleCollapse, shouldSplitBubbles } from "../src/agent/bubble-policy.js";

test("分泡门禁：文字轮开、语音轮关、任务面轮关", () => {
  assert.equal(shouldSplitBubbles({ segmentable: true, voiceMode: false }), true);
  assert.equal(shouldSplitBubbles({ segmentable: true, voiceMode: true }), false);
  assert.equal(shouldSplitBubbles({ segmentable: false, voiceMode: false }), false);
});

test("收口判定：有泡且无塌缩/撤回/场景单泡 → 保留分泡", () => {
  assert.deepEqual(
    resolveBubbleCollapse({
      hasBubbles: true,
      utteranceCollapse: false,
      streamResetSent: false,
      sceneSingleBubble: false,
      renderedReply: false,
    }),
    { bubbleSplitLive: true },
  );
});

test("收口判定：任一塌缩条件成立 → 整段替换", () => {
  const base = {
    hasBubbles: true,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    renderedReply: false,
  };
  for (const patch of [
    { hasBubbles: false },
    { utteranceCollapse: true },
    { streamResetSent: true },
    { sceneSingleBubble: true },
    { renderedReply: true },
  ]) {
    assert.equal(
      resolveBubbleCollapse({ ...base, ...patch }).bubbleSplitLive,
      false,
      JSON.stringify(patch),
    );
  }
});

test("分泡只服务闲聊：信息类回复（卡/结构化正文）即使有泡也收成一条", () => {
  assert.equal(
    resolveBubbleCollapse({
      hasBubbles: true,
      utteranceCollapse: false,
      streamResetSent: false,
      sceneSingleBubble: false,
      renderedReply: true,
    }).bubbleSplitLive,
    false,
  );
});
