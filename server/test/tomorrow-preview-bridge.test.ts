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
import { EveningDigestService } from "../src/services/evening-digest-service.js";
import {
  renderTomorrowPreviewFacts,
  type PreviewDigestLike,
} from "../src/render/scenes/tomorrow-preview.scene.js";

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

// ─── 2026-11-23 §3.4：问答面与推送面分工 ────────────────────────────────
// 主动推送的「明日预览」只剩天气 + 一两句闲聊，问答必须吃 generatePreviewFacts
// 那份完整事实。装配层的取数口一旦接错面（把 digest 当 facts 喂进来），下面
// 第一例会直接红——这是这条链路唯一的自动化防线（本文件不 import 装配层）。
const digestSvc = () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = new Date(
    tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9, 30,
  ).toISOString();
  return new EveningDigestService({
    scheduleTaskService: {
      listTasksBySession: () => [
        { taskId: "t1", title: "部门例会", nextRunAt: iso, runAt: iso, reminderMessage: "" },
      ],
    } as never,
  });
};

test("问答取数口接 facts：聊天里问「明天有什么安排」事实块仍列全行程", async () => {
  const svc = digestSvc();
  registerPreviewDigestSource((sessionId) => svc.generatePreviewFacts(sessionId));
  const payloads = await resolvePreviewPayloads("s1", "明天有什么安排");
  assert.ok(payloads?.eveningDigest, "命中明日意图必须有载荷");
  const block = renderTomorrowPreviewFacts(payloads!.eveningDigest as PreviewDigestLike);
  assert.match(block, /行程：/);
  assert.match(block, /- 09:30 部门例会/);
  resetPreviewDigestSource();
});

test("推送载荷里没有行程面：接错源就会漏答（缺键 ≠ 明天没日程）", async () => {
  const svc = digestSvc();
  const pushOnly = await svc.generateDigest("s1");
  assert.equal("tomorrowSchedule" in pushOnly, false);
  const block = renderTomorrowPreviewFacts(pushOnly as unknown as PreviewDigestLike);
  // 睡前的推送载荷喂进场景，一个行程字都不出——所以问答侧必须吃 facts
  assert.doesNotMatch(block, /行程：|部门例会/);
});

