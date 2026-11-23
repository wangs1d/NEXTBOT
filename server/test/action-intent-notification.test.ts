// 「通知即界面」单测（2026-11-13）：动作意图的签发 / 验签 / 幂等 / 过期 / 归属，
// 以及通知 id 的跨端一致性口径。
//
// 这套东西的失败模式都很隐蔽：token 验不过 → 按钮点了没反应；幂等漏了 → 连点两下
// 执行两遍（取消续费执行两次还好，付款执行两次就是事故）。所以逐条钉死。
import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { ActionIntentService } from "../src/proactivity/action-intent-service.js";
import type { ClientActionIntent } from "../src/proactivity/action-intent-service.js";
import { ActionIntentStore } from "../src/proactivity/action-intent-store.js";
import { notificationIdFor } from "../src/proactivity/notification-id.js";
import {
  buildNotifyActions,
  buildReplyRoundActions,
  classifyNotifyRisk,
  NOTIFY_ACTION,
} from "../src/proactivity/notification-actions.js";
import { registerNotificationActionExecutors } from "../src/proactivity/notification-action-executors.js";
import { registerActionIntentRoutes } from "../src/routes/http/action-intents.js";
import { registerAccessAuthHook } from "../src/routes/http/auth.js";
import { AccessAuthService } from "../src/services/access-auth-service.js";
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

test("suppressDefaultActions：没有真动作时不再回退「知道了 / 稍后再说」", () => {
  const base: ProactiveProposal = {
    proposalId: "p5",
    actorId: "user-a",
    kind: "agent_pulse",
    tier: "social",
    importance: "low",
    dedupKey: "k5",
    title: "",
    summary: "在外面呢？这是去哪儿",
    evidence: [],
    createdAt: 0,
    source: "test",
    suppressDefaultActions: true,
  };
  // 2026-11-29 §4.3：这条消息从此**可以回一句**了——「回复」输入框是真动作
  // （落成主会话一个 user turn + 触发一轮 agent），不在「假按钮」之列；
  // 「知道了 / 稍后再说」仍然不给。
  const actions = buildNotifyActions(base);
  assert.equal(actions.length, 1, "纯告知/闲聊只剩回复框，不配假按钮");
  assert.equal(actions[0]?.actionId, NOTIFY_ACTION.chatReply);
  assert.equal(actions[0]?.kind, "input");
  // 不可回答的种类照旧一个按钮都不放
  assert.deepEqual(
    buildNotifyActions({ ...base, kind: "morning_brief", notifyOptions: [] }),
    [],
  );
  // 自带真动作时照常渲染（抑制只关默认回退，不关显式选项）
  const own = buildNotifyActions({
    ...base,
    notifyOptions: [{ action: "schedule_complete", label: "去过了", ref: "task-swim" }],
  });
  assert.equal(own.length, 1);
  assert.equal(own[0]?.actionId, NOTIFY_ACTION.scheduleComplete);
  assert.equal(own[0]?.label, "去过了");
  assert.equal((own[0]?.payload as { ref?: string } | undefined)?.ref, "task-swim");
});

test("领域选项缺 ref 时被丢弃（不放按了不知道改哪条记录的按钮）", () => {
  const proposal: ProactiveProposal = {
    proposalId: "p6",
    actorId: "user-a",
    kind: "agent_pulse",
    tier: "social",
    importance: "low",
    dedupKey: "k6",
    title: "",
    summary: "11 点的游泳还去吗",
    evidence: [],
    createdAt: 0,
    source: "test",
    notifyOptions: [
      { action: "schedule_snooze", label: "改天再说" }, // 没 ref → 丢弃
      { action: "schedule_complete", label: "去过了", ref: "task-swim" },
    ],
  };
  const actions = buildNotifyActions(proposal);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.actionId, NOTIFY_ACTION.scheduleComplete);
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

test("严格周界下执行端点免设备凭据：一次性 token 本身就是授权", async () => {
  // 回归背景（2026-11-23 真机）：开启 ACCESS_AUTH_REQUIRED 后，通知栏/聊天卡的
  // 按钮请求先被周界按「无 Bearer」401 掉，用户看到「需要访问凭证：请登录后重试」，
  // 签好的 action token 根本没机会验签。执行端点必须精确放行——它的授权边界
  // 是 body 里那枚 HMAC 签名、绑定归属、限时且幂等的一次性 token。
  const prev = process.env.ACCESS_AUTH_REQUIRED;
  process.env.ACCESS_AUTH_REQUIRED = "1";
  try {
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
    const token = svc.renderForClient(intent).actions[0].token;

    const app = Fastify();
    // 与生产装配同序：周界 hook 先挂，再注册路由
    registerAccessAuthHook(app, new AccessAuthService());
    registerActionIntentRoutes(app, { actionIntentService: svc });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/action-intents/execute",
      payload: { token },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(executions, 1);

    // 精确放行而非整族放开：查状态端点仍按设备凭据裁决（客户端不用它）
    const state = await app.inject({
      method: "GET",
      url: `/api/action-intents/${intent.intentId}`,
    });
    assert.equal(state.statusCode, 401, "查询端点不应被顺带放开");

    await app.close();
  } finally {
    if (prev === undefined) delete process.env.ACCESS_AUTH_REQUIRED;
    else process.env.ACCESS_AUTH_REQUIRED = prev;
  }
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

// ────────── §4.3「在通知里直接回一句」闭环回归（2026-11-29） ──────────
// 钉死三件事（真机上翻过车的）：
//  1. 一次通知栏提交可能**同时**投递到主 isolate 与后台 isolate（flutter_local_notifications
//     的双回调，见客户端 local_notification_service.dart 的 _onTap 注释），两路 POST 在
//     execute() 的「检查 → await 执行 → markExecuted」里交错，幂等闸拦不住双发 ——
//     一次回复就会落成两条用户消息、签出两枚下一轮意图、通知被第二张卡覆盖。
//  2. 应答事件必须把用户原话带回（userText），且客户端可见 intentId 钉在根意图上 ——
//     通知 id 由 intentId 算出（两端同一算法），同 id = 原地更新而不是第二张卡。
//  3. 连续回复满 3 轮后只剩「打开对话」（§4.3 步骤 5），空文本永远不落库。
type IngestRec = { text: string; messageId: string; round: number };
type PushRec = {
  userText?: string;
  rootIntentId: string;
  round: number;
  actionIntent?: ClientActionIntent;
};

function makeReplyHarness(): {
  svc: ActionIntentService;
  ingests: IngestRec[];
  pushes: PushRec[];
} {
  const { svc } = makeService();
  const ingests: IngestRec[] = [];
  const pushes: PushRec[] = [];
  registerNotificationActionExecutors(svc, {
    pipeline: null,
    notificationReply: {
      ingestUserTurn: async (i) => {
        ingests.push({ text: i.text, messageId: i.messageId, round: i.round });
        return { ok: true as const, reply: "好，那我把游泳改约到周末" };
      },
      pushFollowUp: (i) => {
        pushes.push(i);
        return { ok: true as const };
      },
    },
  });
  return { svc, ingests, pushes };
}

/** 执行器里的落流/推送跑在异步 IIFE：等一个宏任务让 mock 结算完毕 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("§4.3 一次回复只落一条用户消息：双 isolate 并发重复提交被源头闸门吃掉", async () => {
  const { svc, ingests, pushes } = makeReplyHarness();
  const meta = { kind: "agent_pulse", title: "还去不去 11 点的游泳" };
  const intent = svc.register({
    actorId: "user-a",
    kind: meta.kind,
    title: meta.title,
    body: "外面下雨了",
    actions: buildReplyRoundActions(meta, 1),
    replyRound: { round: 1 },
  });
  const view = svc.renderForClient(intent);
  const replyAction = view.actions.find((a) => a.actionId === NOTIFY_ACTION.chatReply);
  assert.ok(replyAction, "agent_pulse 应有「回复」输入框");
  assert.equal(
    replyAction.kind,
    "input",
    "回复动作必须是 input kind（客户端据此渲染 RemoteInput），不能被硬编码成 execute",
  );

  // 同一次点按的两路 POST 并发进来（主 isolate + 后台 isolate）
  const results = await Promise.all([
    svc.execute(replyAction.token, { input: "不去了", actorId: "user-a" }),
    svc.execute(replyAction.token, { input: "不去了", actorId: "user-a" }),
  ]);
  assert.ok(results.every((r) => r.ok), "两路都给成功回执——幂等，不对用户报错");
  await settle();

  assert.equal(ingests.length, 1, "一次回复只允许落库一条用户消息");
  assert.equal(ingests[0].text, "不去了");
  assert.equal(ingests[0].messageId, `notification-reply-${intent.intentId}-1`);
  assert.equal(pushes.length, 1, "应答只推一次——第二张卡就是从这里冒出来的");
  assert.equal(pushes[0].userText, "不去了", "应答事件带回用户原话（客户端据此落唯一一条用户气泡）");

  // 同一条通知原地更新：客户端可见 intentId 钉在根意图 → 通知 id 不变
  const nextView = pushes[0].actionIntent;
  assert.ok(nextView, "第二轮还在线：应答要带下一轮的动作");
  assert.equal(nextView.intentId, intent.intentId, "intentId 钉在根意图（不是新起一条通知的 id）");
  assert.equal(
    notificationIdFor(nextView.intentId),
    notificationIdFor(intent.intentId),
    "服务端口径：跨轮通知 id 相同（与客户端 notification_id.dart 同源算法）",
  );
});

test("§4.3 轮次闸门：连回三轮后通知上只剩「打开对话」", async () => {
  const { svc, ingests, pushes } = makeReplyHarness();
  const meta = { kind: "task_followup", title: "快递到丰巢了" };
  const root = svc.register({
    actorId: "user-a",
    kind: meta.kind,
    title: meta.title,
    body: "取件码 8-3-9012",
    actions: buildReplyRoundActions(meta, 1),
    replyRound: { round: 1 },
  });
  let view = svc.renderForClient(root);
  for (let round = 1; round <= 3; round++) {
    const token = view.actions.find((a) => a.actionId === NOTIFY_ACTION.chatReply)?.token ?? "";
    assert.ok(token, `第 ${round} 轮该还有「回复」输入框`);
    await svc.execute(token, { input: `第${round}轮回话`, actorId: "user-a" });
    await settle();
    view = pushes[pushes.length - 1].actionIntent ?? view;
  }
  assert.equal(ingests.length, 3, "每轮各且仅各落一条用户消息");
  assert.equal(ingests.map((i) => i.messageId).join("|"), [1, 2, 3].map((r) => `notification-reply-${root.intentId}-${r}`).join("|"));
  assert.equal(
    view.actions.find((a) => a.actionId === NOTIFY_ACTION.chatReply),
    undefined,
    "三轮用完之后不再给回复框（§4.3 步骤 5）",
  );
  assert.equal(view.actions[0]?.actionId, NOTIFY_ACTION.openChat);
  assert.equal(view.actions[0]?.kind, "execute");
  assert.equal(notificationIdFor(view.intentId), notificationIdFor(root.intentId), "轮次用完仍是原地更新同一条通知");
});

test("§4.3 空回复不落库：空文本连闸门都进不去", async () => {
  const { svc, ingests, pushes } = makeReplyHarness();
  const meta = { kind: "agent_pulse", title: "在忙吗" };
  const intent = svc.register({
    actorId: "user-a",
    kind: meta.kind,
    title: meta.title,
    body: "随便问问",
    actions: buildReplyRoundActions(meta, 1),
    replyRound: { round: 1 },
  });
  const view = svc.renderForClient(intent);
  const res = await svc.execute(view.actions[0].token, { input: "   ", actorId: "user-a" });
  assert.equal(res.ok, false, "空话不带过闸门");
  await settle();
  assert.equal(ingests.length, 0, "空文本永远不会变成一条用户消息（漏发里的『两条空的』就是这类写入）");
  assert.equal(pushes.length, 0);
});
