/**
 * intent-router（意图路由表 + JSON 解析）单元测试。
 * 路由表是"模型提案、代码裁决"架构的权威数据——每个标签的执行契约在此锁定。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { parseIntentJson, routePlanForIntent, isIntentLabel, INTENT_LABELS } = await import(
  "../src/agent/intent-router.js"
);

test("路由表：每个意图标签都有确定的执行契约", () => {
  for (const label of INTENT_LABELS) {
    const plan = routePlanForIntent(label);
    assert.ok(plan, `标签 ${label} 必须在路由表中`);
    assert.ok(["chat", "task"].includes(plan.plane), "必须有执行平面");
    assert.ok(Array.isArray(plan.capabilities), "capabilities 必须是数组");
    assert.ok(Number.isInteger(plan.budget) && plan.budget >= 0, "budget 必须是非负整数");
    assert.ok(["flash", "pro"].includes(plan.tier), "必须有模型档位");
    // 对话面零工具契约：无能力束、零预算
    if (plan.plane === "chat") {
      assert.equal(plan.capabilities.length, 0, "对话面不得携带能力束");
      assert.equal(plan.budget, 0, "对话面预算必须为 0");
    } else {
      assert.ok(plan.capabilities.length > 0, "任务面必须声明能力束");
      assert.ok(plan.budget > 0, "任务面必须有正预算");
    }
  }
});

test("路由表：对话面三标签零工具；实时/媒体轻预算任务面；写数据按 write 束裁剪、多步全量高预算", () => {
  const chat = routePlanForIntent("chat");
  assert.equal(chat.plane, "chat");
  assert.equal(chat.tier, "flash");

  for (const label of ["knowledge_qa", "meta_capability"] as const) {
    assert.equal(routePlanForIntent(label).plane, "chat");
  }

  const realtime = routePlanForIntent("realtime_lookup");
  assert.equal(realtime.plane, "task");
  // 2026-10-12 架构收敛：外部查证是一个族，模态（网页/图片/视频）选择归还
  // 执行模型——realtime 束必须含 media，否则标签误标时正确工具不可见。
  assert.deepEqual(realtime.capabilities, ["search", "media"]);
  assert.equal(realtime.budget, 3, "router-first 下最低 3 波：discover→call→作答");
  assert.equal(realtime.tier, "flash", "单点查询用 Flash 档，省 token");

  const media = routePlanForIntent("media_retrieval");
  assert.equal(media.plane, "task");
  assert.deepEqual(media.capabilities, ["media", "search"]);
  assert.equal(media.budget, 3, "router-first 下最低 3 波");

  // 2026-09-08：action_write 归位对话面——提醒/日程是单工具秒级动作，前台
  // 直调 reminder.plan/calendar 当场办成，不派后台、不出任务回执；重写动作
  // （下单/支付/发消息）由前台模型经 task.dispatch 自决派后台。
  const write = routePlanForIntent("action_write");
  assert.equal(write.plane, "chat");
  assert.deepEqual(write.capabilities, []);
  assert.equal(write.budget, 0);
  assert.equal(write.tier, "flash");

  const multi = routePlanForIntent("multi_step_task");
  assert.equal(multi.plane, "task");
  assert.deepEqual(multi.capabilities, ["full"]);
  assert.equal(multi.budget, 4, "router-first 下 pro 档 4 波");
});

test("parseIntentJson：规范 JSON 输出", () => {
  const parsed = parseIntentJson('{"intent":"realtime_lookup","confidence":0.87}');
  assert.deepEqual(parsed, { intent: "realtime_lookup", confidence: 0.87 });
});

test("parseIntentJson：剥 [ts:] 前缀 + 夹带噪声仍可解析", () => {
  const parsed = parseIntentJson('[ts:2026-09-02 00:00:00|周二] {"intent":"media_retrieval","confidence":0.8} 以上。');
  assert.equal(parsed?.intent, "media_retrieval");
  assert.equal(parsed?.confidence, 0.8);
});

test("parseIntentJson：confidence 越界钳制与字符串数字", () => {
  assert.equal(parseIntentJson('{"intent":"chat","confidence":1.7}')?.confidence, 1);
  assert.equal(parseIntentJson('{"intent":"chat","confidence":"0.6"}')?.confidence, 0.6);
  assert.equal(parseIntentJson('{"intent":"chat"}')?.confidence, 0.75, "缺省置信度取中性默认");
});

test("parseIntentJson：JSON 失败时降级全文标签词扫描", () => {
  assert.equal(parseIntentJson("realtime_lookup")?.intent, "realtime_lookup");
  // 降级扫描置信度打折（触发上游 fail-safe）
  assert.equal(parseIntentJson("media")?.confidence, 0.5);
});

test("parseIntentJson：完全无法解析 → null（调用方保守降级任务面）", () => {
  assert.equal(parseIntentJson(""), null);
  assert.equal(parseIntentJson(undefined), null);
  assert.equal(parseIntentJson("嗯嗯好的"), null);
});

test("isIntentLabel：封闭集校验", () => {
  assert.equal(isIntentLabel("chat"), true);
  assert.equal(isIntentLabel("nope"), false);
  assert.equal(isIntentLabel(42), false);
});
