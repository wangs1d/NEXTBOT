import assert from "node:assert/strict";
import test from "node:test";

import {
  decideFinalPlan,
  decideStreamPlan,
  type PresentationPlan,
} from "../src/agent/bubble-policy.js";

const singleStream: PresentationPlan = {
  owner: "single",
  replacesStream: false,
  reason: "task-surface",
};

test("开始裁决：闲聊开泡、语音关泡、任务面关泡", () => {
  assert.equal(
    decideStreamPlan({ segmentable: true, voiceMode: false }).owner,
    "bubbles",
  );
  assert.equal(
    decideStreamPlan({ segmentable: true, voiceMode: true }).owner,
    "single",
  );
  assert.equal(
    decideStreamPlan({ segmentable: false, voiceMode: false }).owner,
    "single",
  );
});

test("结束裁决：有泡且无收口条件 → 保留分泡，不替换流", () => {
  const plan = decideFinalPlan({
    stream: decideStreamPlan({ segmentable: true, voiceMode: false }),
    hasBubbles: true,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    bodyRewritten: false,
    presentationBlocks: false,
  });
  assert.deepEqual(plan, {
    owner: "bubbles",
    replacesStream: false,
    reason: "chat",
  });
});

test("结束裁决：任一收口条件成立 → 单条并整段替换", () => {
  const base = {
    stream: decideStreamPlan({ segmentable: true, voiceMode: false }),
    hasBubbles: true,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    bodyRewritten: false,
    presentationBlocks: false,
  };
  for (const patch of [
    { utteranceCollapse: true, reason: "utterance-collapse" },
    { streamResetSent: true, reason: "stream-reset" },
    { sceneSingleBubble: true, reason: "scene-single-bubble" },
    { bodyRewritten: true, reason: "body-rewritten" },
    { presentationBlocks: true, reason: "presentation-blocks" },
  ]) {
    const plan = decideFinalPlan({ ...base, ...patch });
    assert.equal(plan.owner, "single", JSON.stringify(patch));
    assert.equal(plan.replacesStream, true, JSON.stringify(patch));
    assert.equal(plan.reason, patch.reason, JSON.stringify(patch));
  }
});

test("结束裁决：无泡 → 单条，但没有可替换的流", () => {
  const plan = decideFinalPlan({
    stream: decideStreamPlan({ segmentable: true, voiceMode: false }),
    hasBubbles: false,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    bodyRewritten: true,
    presentationBlocks: true,
  });
  assert.equal(plan.owner, "single");
  assert.equal(plan.replacesStream, false);
  assert.equal(plan.reason, "no-bubbles");
});

test("单调收窄：开始判 single 的轮次，结束不允许重新开泡", () => {
  const plan = decideFinalPlan({
    stream: singleStream,
    hasBubbles: true,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    bodyRewritten: false,
    presentationBlocks: false,
  });
  assert.equal(plan.owner, "single");
  assert.equal(plan.replacesStream, false);
  assert.equal(plan.reason, "stream-task-surface");
});

test("分泡只服务闲聊：信息类回复（正文重排 / 展示块）即使有泡也收成一条", () => {
  const base = {
    stream: decideStreamPlan({ segmentable: true, voiceMode: false }),
    hasBubbles: true,
    utteranceCollapse: false,
    streamResetSent: false,
    sceneSingleBubble: false,
    bodyRewritten: false,
    presentationBlocks: false,
  };
  assert.equal(
    decideFinalPlan({ ...base, bodyRewritten: true }).owner,
    "single",
  );
  assert.equal(
    decideFinalPlan({ ...base, presentationBlocks: true }).owner,
    "single",
  );
});
