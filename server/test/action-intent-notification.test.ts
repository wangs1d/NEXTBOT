// 「通知即界面」单测（2026-11-13）：动作意图的签发 / 验签 / 幂等 / 过期 / 归属，
// 以及通知 id 的跨端一致性口径。
//
// 这套东西的失败模式都很隐蔽：token 验不过 → 按钮点了没反应；幂等漏了 → 连点两下
// 执行两遍（取消续费执行两次还好，付款执行两次就是事故）。所以逐条钉死。
import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { ActionIntentService } from "../src/proactivity/action-intent-service.js";
import { ActionIntentStore } from "../src/proactivity/action-intent-store.js";
import { notificationIdFor } from "../src/proactivity/notification-id.js";
import {
  buildNotifyActions,
  classifyNotifyRisk,
  NOTIFY_ACTION,
} from "../src/proactivity/notification-actions.js";
import { registerActionIntentRoutes } from "../src/routes/http/action-intents.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const SECRET = "test-secret-for-action-intent-0123456789";

function makeService(nowFn?: () => number): {
  svc: ActionIntentService;
  store: ActionIntentStore;
} {
  const store = new ActionIntentStore(undefined, nowFn);
  return { svc: new ActionIntentService({ store, secret: SECRET, nowFn }), store };
}

function baseIntentActions(): Array<{
  actionId: string;
  label: string;
  kind: "execute" | "input";
  payload?: Record<string, unknown>;
}> {
  return [
    { actionId: NOTIFY_ACTION.acknowledge, label: "好就这么办", kind: "execute" },
    { actionId: NOTIFY_ACTION.snooze, label: "稍后再说", kind: "execute" },
  ];
}

test("签发的 token 可验签，且每个动作一枚独立 token", () => {
  const { svc } = makeService();
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  assert.equal(view.actions.length, 2);
  const tokens = view.actions.map((a) => a.token);
  assert.notEqual(tokens[0], tokens[1]);
  for (const action of view.actions) {
    const verified = svc.verify(action.token);
    assert.ok(!("error" in verified), `验签应通过：${action.actionId}`);
    assert.equal(verified.intent.intentId, intent.intentId);
    assert.equal(verified.action.actionId, action.actionId);
  }
});

test("篡改过的 token 一律拒绝（签名不匹配）", () => {
  const { svc } = makeService();
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  const tampered = `${view.actions[0].token.slice(0, -2)}xx`;
  const verified = svc.verify(tampered);
  assert.ok("error" in verified);
  assert.equal(verified.code, "bad_signature");
});

test("过期意图拒绝执行（通知可能几小时后才被看到）", () => {
  let now = 1_000_000;
  const { svc } = makeService(() => now);
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
    ttlMs: 1000,
  });
  const view = svc.renderForClient(intent);
  now += 2000;
  const verified = svc.verify(view.actions[0].token);
  assert.ok("error" in verified);
  assert.equal(verified.code, "expired");
});

test("执行一次后幂等：连点两下只执行一次", async () => {
  const { svc } = makeService();
  let executions = 0;
  svc.registerExecutor(NOTIFY_ACTION.acknowledge, () => {
    executions += 1;
    return { ok: true, message: "好" };
  });
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  const first = await svc.execute(view.actions[0].token);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyExecuted, false);
  const second = await svc.execute(view.actions[0].token);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyExecuted, true);
  assert.equal(executions, 1, "执行器只能被调用一次");
});

test("无执行器的动作如实报错，不静默成功", async () => {
  const { svc } = makeService();
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  const out = await svc.execute(view.actions[0].token);
  assert.equal(out.ok, false);
  assert.equal(out.code, "no_executor");
});

test("归属不符的动作被拒（token 外流到别人手里）", async () => {
  const { svc } = makeService();
  svc.registerExecutor(NOTIFY_ACTION.acknowledge, () => ({ ok: true, message: "好" }));
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  const out = await svc.execute(view.actions[0].token, { actorId: "user-b" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "actor_mismatch");
});

test("通知 id 口径：稳定、有界、跨端可对齐", () => {
  // 这几个期望值由**独立实现**算出（Python + Dart 两侧同名实现同值）：
  //   ai_abc123_7 → 1226519742 / ai_test_1 → 978619408
  //   d_m123_1 → 996190925 / 你好世界 → 157454421
  // 服务端与客户端任一端改了算法，这里立刻红——通知 id 错位会让同一条决策
  // 跨层投递变成两条通知（其中一条的按钮是死的），这是最难在真机上发现的坑。
  assert.equal(notificationIdFor("ai_abc123_7"), 1226519742);
  assert.equal(notificationIdFor("ai_test_1"), 978619408);
  assert.equal(notificationIdFor("d_m123_1"), 996190925);
  assert.equal(notificationIdFor("你好世界"), 157454421);
  const id = notificationIdFor("ai_abc123_7");
  assert.ok(id >= 0 && id < 2_000_000_000, `通知 id 必须落在华为 notify_id 上限内：${id}`);
  // 不同 key 不同 id（否则不同决策会互相覆盖）
  assert.notEqual(notificationIdFor("ai_a"), notificationIdFor("ai_b"));
});

test("风险分级：L2 提案在通知栏不放执行按钮", () => {
  const proposal = (over: Partial<ProactiveProposal>): ProactiveProposal => ({
    proposalId: "p1",
    actorId: "user-a",
    kind: "proactivity.test",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "标题",
    summary: "摘要",
    evidence: [],
    createdAt: 0,
    source: "test",
    ...over,
  });
  const l0 = proposal({});
  assert.equal(classifyNotifyRisk(l0), "L0");
  assert.ok(buildNotifyActions(l0).length > 0);

  const l2 = proposal({
    utility: {
      risk: {
        reversible: false,
        financialImpact: "high",
        dataSensitivity: "normal",
        thirdPartyImpact: false,
      },
      authorization: "explicit",
    },
  });
  assert.equal(classifyNotifyRisk(l2), "L2");
  assert.equal(buildNotifyActions(l2).length, 0, "L2 提案不放执行按钮");
});

test("ask_first 提案给的是批准/拒绝（真的拍板），不是告知类按钮", () => {
  const proposal: ProactiveProposal = {
    proposalId: "p2",
    actorId: "user-a",
    kind: "proactivity.confirm",
    tier: "must",
    importance: "high",
    dedupKey: "k2",
    title: "替你催一下？",
    summary: "发送前会先经你确认",
    evidence: [],
    createdAt: 0,
    source: "test",
    confirmAction: { label: "发吧" },
  };
  const actions = buildNotifyActions(proposal);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].actionId, NOTIFY_ACTION.approve);
  assert.equal(actions[0].label, "发吧");
  assert.equal(actions[1].actionId, NOTIFY_ACTION.decline);
});

test("并排按钮最多 2 个（2026-11-19 用户拍板，原为 3）", () => {
  const proposal: ProactiveProposal = {
    proposalId: "p3",
    actorId: "user-a",
    kind: "proactivity.test",
    tier: "must",
    importance: "high",
    dedupKey: "k3",
    title: "标题",
    summary: "摘要",
    evidence: [],
    createdAt: 0,
    source: "test",
  };
  assert.ok(buildNotifyActions(proposal).length <= 2);
  assert.equal(buildNotifyActions(proposal).length, 2, "默认告知类也只给收下/稍后两项");
});

test("提案自带选项优先：文案随内容生成，且仍受两项上限 + 真执行器映射", () => {
  const proposal: ProactiveProposal = {
    proposalId: "p4",
    actorId: "user-a",
    kind: "morning_brief",
    tier: "social",
    importance: "low",
    dedupKey: "k4",
    title: "晨间简报",
    summary: "摘要",
    evidence: [],
    createdAt: 0,
    source: "test",
    notifyOptions: [
      { action: "acknowledge", label: "去看看消息" },
      { action: "snooze", label: "稍后再说" },
      { action: "dismiss", label: "不用了" }, // 第三项应被上限砍掉
      { action: "acknowledge", label: "  " }, // 空文案应被丢弃
    ],
  };
  const actions = buildNotifyActions(proposal);
  assert.equal(actions.length, 2, "最多两项");
  assert.equal(actions[0].actionId, NOTIFY_ACTION.acknowledge);
  assert.equal(actions[0].label, "去看看消息", "文案来自提案内容，不是硬编码");
  assert.equal(actions[1].actionId, NOTIFY_ACTION.snooze);
  assert.equal(actions[1].label, "稍后再说");
});

test("HTTP 端点：execute 走完验签→执行→幂等，且篡改 token 被拒", async () => {
  const { svc } = makeService();
  let executions = 0;
  svc.registerExecutor(NOTIFY_ACTION.acknowledge, () => {
    executions += 1;
    return { ok: true, message: "好，就这么定了" };
  });
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const token = svc.renderForClient(intent).actions[0].token;

  const app = Fastify();
  registerActionIntentRoutes(app, { actionIntentService: svc });
  await app.ready();

  const first = await app.inject({
    method: "POST",
    url: "/api/action-intents/execute",
    payload: { token },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as { ok: boolean; message: string };
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.message, "好，就这么定了");

  // 连点两下：第二次不重复执行
  const second = await app.inject({
    method: "POST",
    url: "/api/action-intents/execute",
    payload: { token },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(executions, 1, "HTTP 层同样必须幂等");

  // 篡改 token → 400，不执行
  const bad = await app.inject({
    method: "POST",
    url: "/api/action-intents/execute",
    payload: { token: `${token.slice(0, -2)}xx` },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(executions, 1);

  // 查状态
  const state = await app.inject({
    method: "GET",
    url: `/api/action-intents/${intent.intentId}`,
  });
  assert.equal(state.statusCode, 200);
  const stateBody = state.json() as { ok: boolean; intent: { state: string } };
  assert.equal(stateBody.intent.state, "executed");

  await app.close();
});

test("一个意图只拍一次板：拍完一个，其余互斥按钮全部作废", async () => {
  const { svc } = makeService();
  const executed: string[] = [];
  svc.registerExecutor(NOTIFY_ACTION.acknowledge, () => {
    executed.push("ack");
    return { ok: true, message: "好" };
  });
  svc.registerExecutor(NOTIFY_ACTION.snooze, () => {
    executed.push("snooze");
    return { ok: true, message: "稍后" };
  });
  const intent = svc.register({
    actorId: "user-a",
    kind: "proactivity.test",
    title: "标题",
    body: "正文",
    actions: baseIntentActions(),
  });
  const view = svc.renderForClient(intent);
  const first = await svc.execute(view.actions[0].token);
  assert.equal(first.ok, true);
  // 第二个（互斥）按钮：不再执行
  const second = await svc.execute(view.actions[1].token);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyExecuted, true);
  assert.deepEqual(executed, ["ack"], "互斥按钮不能被同时执行");
});
