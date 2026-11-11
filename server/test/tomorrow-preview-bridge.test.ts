/**
 * 明日预览数据面桥（2026-11-05 接生产投递）。
 *
 * 锁三件事：
 *   1. 只在「问明日安排」时注入数据面（问天气/闲聊绝不能被抓走）；
 *   2. 取数失败/超时一律放弃注入——回复不能为了预览卡住；
 *   3. 注入的形状是 { eveningDigest }，与 tomorrow_preview 场景的约定一致。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PREVIEW_PAYLOAD_TIMEOUT_MS,
  registerPreviewDigestSource,
  resetPreviewDigestSource,
  resolvePreviewPayloads,
  wantsTomorrowPreview,
} from "../src/services/tomorrow-preview-bridge.js";

const DIGEST = {
  date: "2026-11-05",
  tomorrowSchedule: [{ id: "t1", title: "部门例会", time: "09:30" }],
  tomorrowWeather: { text: "多云", minC: 12, maxC: 22, alerts: [] },
  narrationText: "",
};

test("意图判定：问明日安排 → true", () => {
  for (const text of [
    "明天什么安排",
    "明天有啥安排吗",
    "明日行程",
    "明天的日程",
    "明早几点要出门",
    "明天呢",
    "说说明天",
    "明天我要做什么",
  ]) {
    assert.equal(wantsTomorrowPreview(text), true, text);
  }
});

test("意图判定：问天气 / 闲聊 / 非明日 → false（天气轮不能被 90 优先级场景抢走）", () => {
  for (const text of [
    "明天天气怎么样",
    "明天几点下雨",
    "明天要穿什么",
    "今天好累",
    "帮我订张机票",
    "后天有安排吗",
    "",
    // 2026-11-10 分泡回归：纯陈述的闲聊（顺带提明天）不算问安排——
    // 命中会把已分好的绿泡在 done 塌缩成一条（真链探针实证）
    "明天再去游泳",
    "游完了，明天再去游泳",
    "明天见",
  ]) {
    assert.equal(wantsTomorrowPreview(text), false, text);
  }
});

test("未注册取数口：不注入任何数据面", async () => {
  resetPreviewDigestSource();
  assert.equal(await resolvePreviewPayloads("s1", "明天什么安排"), undefined);
});

test("命中意图：注入 { eveningDigest }，形状与场景约定一致", async () => {
  registerPreviewDigestSource(() => DIGEST);
  const payloads = await resolvePreviewPayloads("s1", "明天什么安排");
  assert.deepEqual(payloads, { eveningDigest: DIGEST });
  resetPreviewDigestSource();
});

test("非命中意图：即使有数据也不注入（省一次渲染接管）", async () => {
  let called = 0;
  registerPreviewDigestSource(() => {
    called += 1;
    return DIGEST;
  });
  assert.equal(await resolvePreviewPayloads("s1", "明天天气怎么样"), undefined);
  assert.equal(called, 0);
  resetPreviewDigestSource();
});

test("取数抛错：静默放弃，不把异常抛进对话主链路", async () => {
  registerPreviewDigestSource(() => {
    throw new Error("db down");
  });
  assert.equal(await resolvePreviewPayloads("s1", "明天的安排"), undefined);
  resetPreviewDigestSource();
});

test("取数超时：按上限放弃（主对话优先，不让天气接口拖住回复）", async () => {
  registerPreviewDigestSource(() => new Promise(() => {}));
  const started = Date.now();
  const payloads = await resolvePreviewPayloads("s1", "明天什么安排");
  const elapsed = Date.now() - started;
  assert.equal(payloads, undefined);
  assert.ok(elapsed >= PREVIEW_PAYLOAD_TIMEOUT_MS - 100, `实际等待 ${elapsed}ms`);
  assert.ok(elapsed < PREVIEW_PAYLOAD_TIMEOUT_MS + 1500, `超出上限太多：${elapsed}ms`);
  resetPreviewDigestSource();
});
