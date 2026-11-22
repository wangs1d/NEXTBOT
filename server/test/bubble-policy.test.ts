import assert from "node:assert/strict";
import test from "node:test";

import {
  decidePresentation,
  splitReplyBubbles,
  type PresentationInputs,
} from "../src/agent/bubble-policy.js";

const chatBase: PresentationInputs = {
  voiceMode: false,
  segmentable: true,
  utteranceCollapse: false,
  sceneSingleBubble: false,
  bodyRewritten: false,
  presentationBlocks: false,
};

test("统一裁决：闲聊分泡，语音/任务面/塌缩/场景/重排/展示块一律单条", () => {
  assert.deepEqual(decidePresentation(chatBase), {
    owner: "bubbles",
    reason: "chat",
  });
  const cases: Array<[Partial<PresentationInputs>, string]> = [
    [{ voiceMode: true }, "voice"],
    [{ segmentable: false }, "task-surface"],
    [{ utteranceCollapse: true }, "utterance-collapse"],
    [{ sceneSingleBubble: true }, "scene-single-bubble"],
    [{ bodyRewritten: true }, "body-rewritten"],
    [{ presentationBlocks: true }, "presentation-blocks"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(
      decidePresentation({ ...chatBase, ...patch }),
      { owner: "single", reason },
      reason,
    );
  }
});

test("优先级：语音轮优先于一切（不因其它信号改变）", () => {
  assert.deepEqual(
    decidePresentation({
      ...chatBase,
      voiceMode: true,
      bodyRewritten: true,
      presentationBlocks: true,
    }),
    { owner: "single", reason: "voice" },
  );
});

test("出口分泡：单句闲聊保持单泡", async () => {
  const bubbles = await splitReplyBubbles("在呢，我在。");
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0], "在呢，我在。");
});

test("出口分泡：口语多句按句拆泡且不丢字", async () => {
  const bubbles = await splitReplyBubbles("在呢。好的。");
  assert.ok(bubbles.length >= 2);
  assert.equal(bubbles.join(""), "在呢。好的。");
});

test("出口分泡：多段口语按段落拆泡且不丢字", async () => {
  const text = "在呢。\n\n刚看你说今天要早点出门，闹钟我帮你往前调了十分钟。\n\n路上慢点，到了说一声。";
  const bubbles = await splitReplyBubbles(text);
  assert.ok(bubbles.length >= 2, `expected multi bubbles, got ${JSON.stringify(bubbles)}`);
  const joined = bubbles.join("");
  assert.equal(joined.replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("出口分泡：结构化列表不拆碎", async () => {
  const text = [
    "这周安排大概是这样：",
    "",
    "- 周一上午评审",
    "- 周三下午对齐",
    "- 周五出周报",
  ].join("\n");
  const bubbles = await splitReplyBubbles(text);
  const listBubble = bubbles.find((b) => b.includes("- 周一上午评审"));
  assert.ok(listBubble, "列表必须完整落在同一个泡里");
  assert.ok(listBubble.includes("- 周五出周报"), "列表条目不得被拆到不同泡");
});

test("出口分泡：空文本不产泡", async () => {
  assert.deepEqual(await splitReplyBubbles("   \n  "), []);
});
