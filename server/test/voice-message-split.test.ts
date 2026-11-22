import assert from "node:assert/strict";
import test from "node:test";
import { splitVoiceMessageText } from "../src/tools/agent-voice-tools.js";

test("短语音保持一条", () => {
  assert.deepEqual(splitVoiceMessageText("好的，知道了。"), ["好的，知道了。"]);
});

test("长回复按句拆成多条，顺序与内容不丢", () => {
  const text =
    "先不用急着下这个结论，我查一下。大哥，算是开放了，但这次还只是小范围开闸，不是全面放开。" +
    "11月21日，特斯拉开始推送 FSD V15 监督版，首批只给早期体验计划（EAP）成员，在美国。" +
    "马斯克说大规模推送要等到12月，跟假日更新一起。只支持 HW4 车型，HW3 的老车升不了。" +
    "官方说安全关键场景的处理能力提升约25倍，新增了实时可视化。" +
    "所以，你要是问的是“现在能不能用”，那得看你开的是哪款车、有没有 EAP 名额。";
  const segments = splitVoiceMessageText(text);
  assert.ok(segments.length > 1, "长回复必须拆成多条语音");
  assert.equal(segments.join(""), text, "拆条不能丢字或改顺序");
  assert.ok(segments.every((segment) => segment.length <= 110));
});

test("无标点长句按上限硬切", () => {
  const text = "啊".repeat(250);
  const segments = splitVoiceMessageText(text);
  assert.ok(segments.length >= 3);
  assert.equal(segments.join(""), text);
  assert.ok(segments.every((segment) => segment.length <= 110));
});

test("空文本不产生语音条", () => {
  assert.deepEqual(splitVoiceMessageText("   \n "), []);
});

test("超长文本最多 12 条，避免刷屏", () => {
  const text = "这是一句测试语音内容。".repeat(200);
  const segments = splitVoiceMessageText(text);
  assert.ok(segments.length <= 12);
  assert.equal(segments.join(""), text);
});
