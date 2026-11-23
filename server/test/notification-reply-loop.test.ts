// 「回复」闭环单测（2026-11-29，PRD §4.3）：通知栏输入框里的一句话怎么变成主会话
// 的一轮对话，以及 agent 的应答怎么回到**同一条通知**上。
//
// 这条链路最容易在真机上翻车的三件事，这里逐条钉死：
//   1. 回复按钮必须是 kind=input（服务端把默认 kind 写死成 execute 的话，通知栏
//      就只剩一个按下去没有输入框的按钮，用户那句话根本没地方打）；
//   2. 应答必须带着**根意图 id** 下去——通知 id 由 intentId 算出，换成新一轮的
//      intentId 就会原地再多弹一条通知（同一条话题变成两条，第二条的按钮还是死的）；
//   3. 轮次封顶必须在服务端算（轮次落在意图上、随 action-intents.json 持久化），
//      否则重启后第 4 轮又长出一个回复框，永远收不了口。
import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionIntentService } from "../src/proactivity/action-intent-service.js";
import { ActionIntentStore, type ActionIntent } from "../src/proactivity/action-intent-store.js";
import {
  MAX_REPLY_ROUNDS,
  NOTIFY_ACTION,
  buildNotifyActions,
  buildReplyRoundActions,
  registerIntentForProposal,
} from "../src/proactivity/notification-actions.js";
import { registerNotificationActionExecutors } from "../src/proactivity/notification-action-executors.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { notificationIdFor } from "../src/proactivity/notification-id.js";
import type { ClientActionIntent } from "../src/proactivity/action-intent-service.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const SECRET = "test-secret-for-notification-reply-0123456789";

function pulseProposal(over: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p1",
    actorId: "user-a",
    kind: "agent_pulse",
    tier: "social",
    importance: "low",
    dedupKey: "k1",
    title: "",
    summary: "在外面呢？这是去哪儿",
    evidence: [],
    createdAt: 0,
    source: "test",
    suppressDefaultActions: true,
    ...over,
  };
}

/** 假管道：只记录 outcome，其余执行器用不到 */
function fakePipeline() {
  const outcomes: Array<{ deliveryId: string; outcome: string }> = [];
  return {
    outcomes,
    pipeline: {
      recordOutcome: (deliveryId: string, outcome: "accepted" | "dismissed" | "snoozed") => {
        outcomes.push({ deliveryId, outcome });
        return true;
      },
      requeueProposal: () => true,
      resolveConfirmationByKind: () => ({ ok: true, message: "好" }),
    },
  };
}

type IngestCall = {
  actorId: string;
  text: string;
  messageId: string;
  rootIntentId: string;
  round: number;
};
type PushCall = {
  actorId: string;
  title: string;
  text: string;
  rootIntentId: string;
  round: number;
  actionIntent?: ClientActionIntent;
};

/**
 * 一套「通知栏回复」的装配替身：ingest 返回一句可控的 agent 应答，
 * push 用一个 promise 通知测试「异步那一跳已经跑完」（执行器是秒回 + 后台跑轮的，
 * 不等这个 promise 就会读到空数组——那是时序问题，不是功能问题）。
 */
function makeReplyPort(opts: { reply?: string; delayMs?: number } = {}) {
  const ingested: IngestCall[] = [];
  const pushed: PushCall[] = [];
  let wake: () => void = () => {};
  let waiting: Promise<void> = Promise.resolve();
  const reset = () => {
    waiting = new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  reset();
  const port = {
    ingestUserTurn: async (input: IngestCall) => {
      ingested.push(input);
      // 真实的一轮 agent 要几秒到十几秒：这里用宏任务模拟，测试才能看出
      // 「执行器有没有同步等它」
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { ok: true as const, reply: opts.reply ?? "刚从诊所出来，顺路买点菜" };
    },
    pushFollowUp: (input: PushCall) => {
      pushed.push(input);
      wake();
      return { ok: true };
    },
    /** 等这一轮的异步应答推完（没推东西的分支不能把测试挂住，所以带个兜底） */
    settle: async (maxMs = 400) => {
      await Promise.race([waiting, new Promise((r) => setTimeout(r, maxMs))]);
      reset();
    },
    ingested,
    pushed,
  };
  return port;
}

function makeService(): { svc: ActionIntentService; store: ActionIntentStore } {
  const store = new ActionIntentStore();
  return { svc: new ActionIntentService({ store, secret: SECRET }), store };
}

/** 起一条可回复的主动消息：签 root intent，返回它的回复 token */
function firstRoundToken(svc: ActionIntentService, p: ProactiveProposal): string {
  const intent = registerIntentForProposal(svc, p, {
    title: p.title,
    body: p.summary,
    deliveryId: "d_first",
  });
  assert.ok(intent, "可回复的提案必须登记出意图（否则通知栏没有按钮）");
  const view = svc.renderForClient(intent as ActionIntent);
  const reply = view.actions.find((a) => a.actionId === NOTIFY_ACTION.chatReply);
  assert.ok(reply, "通知栏上要有「回复」这枚按钮");
  assert.equal(reply.kind, "input", "回复必须是 input：否则通知里没有输入框");
  assert.equal(reply.allowFreeFormInput, true);
  return reply.token;
}

test("跟进/闲聊类主动消息在通知栏拿到「回复」输入框（§4.3 步骤 1）", () => {
  // 纯告知（suppressDefaultActions）：只给回复框——「知道了/稍后再说」那种
  // 按下去不改变任何状态的假按钮仍然不给
  const pulse = buildNotifyActions(pulseProposal());
  assert.equal(pulse.length, 1);
  assert.equal(pulse[0]?.actionId, NOTIFY_ACTION.chatReply);
  assert.equal(pulse[0]?.kind, "input");
  assert.equal(pulse[0]?.inputLabel, "回一句");

  // 有标题的跟进：回复 + 知道了（并排两个，不再多）
  const follow = buildNotifyActions(
    pulseProposal({ kind: "task_followup", title: "上午那个会", suppressDefaultActions: false }),
  );
  assert.equal(follow.length, 2);
  assert.equal(follow[0]?.actionId, NOTIFY_ACTION.chatReply);
  assert.equal(follow[1]?.actionId, NOTIFY_ACTION.acknowledge);

  // 不可回答的种类不受影响（默认双按钮原样）
  const other = buildNotifyActions(
    pulseProposal({ kind: "proactivity.test", suppressDefaultActions: false }),
  );
  assert.deepEqual(
    other.map((a) => a.actionId),
    [NOTIFY_ACTION.acknowledge, NOTIFY_ACTION.snooze],
  );

  // 自带真动作的提案优先用自带的，不被回复挤掉额度
  const own = buildNotifyActions(
    pulseProposal({
      notifyOptions: [{ action: "schedule_complete", label: "去过了", ref: "task-swim" }],
    }),
  );
  assert.deepEqual(own.map((a) => a.actionId), [NOTIFY_ACTION.scheduleComplete]);

  // L2 仍然一个按钮都不放（回复框也是打断）
  assert.equal(
    buildNotifyActions(
      pulseProposal({
        utility: {
          risk: { reversible: false, financialImpact: "high", dataSensitivity: "normal", thirdPartyImpact: false },
          authorization: "explicit",
        },
      }),
    ).length,
    0,
  );

  // 触发源也可以显式声明回复角色（联合类型之外，按字符串再认一次）
  const declared = buildNotifyActions(
    pulseProposal({
      kind: "morning_brief",
      suppressDefaultActions: false,
      notifyOptions: [{ action: "chat_reply" as never, label: "回一句" }],
    }),
  );
  assert.equal(declared[0]?.actionId, NOTIFY_ACTION.chatReply);
  assert.equal(declared[0]?.kind, "input");
});

test("通知栏回复落成主会话的一句 user turn，并原地更新同一条通知（§4.3 步骤 3-4）", async () => {
  const { svc } = makeService();
  const { pipeline, outcomes } = fakePipeline();
  const port = makeReplyPort({ reply: "好，那我 6 点在门口等你", delayMs: 60 });
  registerNotificationActionExecutors(svc, { pipeline, notificationReply: port });

  const token = firstRoundToken(svc, pulseProposal());
  const started = Date.now();
  const out = await svc.execute(token, { input: "  6 点门口见  " });
  assert.equal(out.ok, true);
  // 执行器必须**秒回**（客户端点按钮走的是通知回调的后台 isolate，只等 12 秒）
  assert.ok(Date.now() - started < 50, `回执耗时 ${Date.now() - started}ms，同步等了那一轮`);
  assert.match(out.ok ? out.result.message : "", /收到/);
  // 回执那一刻应答还没推出去：同步等一轮 agent 会撞上 isolate 超时，
  // 用户看到的是「连不上服务器」，而实际上消息已落库、回复正在生成
  assert.equal(port.pushed.length, 0, "回执之前不该同步等 agent 那一轮");

  await port.settle();
  assert.equal(port.ingested.length, 1, "回复只落一条 user turn");
  const turn = port.ingested[0]!;
  assert.equal(turn.actorId, "user-a");
  assert.equal(turn.text, "6 点门口见", "首尾空白被收掉");
  assert.equal(turn.round, 1);
  assert.match(turn.messageId, /^notification-reply-/, "落流 id 带来源标记");
  assert.ok(turn.messageId.endsWith("-1"), "id 里带轮次（同轮重复提交在落库层幂等）");

  // 应答推回通知：intentId 必须是**根**意图（通知 id 由它算出，才谈得上原地更新）
  assert.equal(port.pushed.length, 1);
  const push = port.pushed[0]!;
  assert.equal(push.text, "好，那我 6 点在门口等你");
  assert.equal(push.round, 2);
  const root = turn.rootIntentId;
  assert.equal(push.rootIntentId, root);
  assert.equal(push.actionIntent?.intentId, root, "下一轮动作视图仍挂在根意图上");
  assert.notEqual(push.actionIntent?.intentId, undefined);
  // 但 token 签的是新意图（各轮独立幂等），所以第二轮的按钮是新凭据
  const next = push.actionIntent?.actions.find((a) => a.actionId === NOTIFY_ACTION.chatReply);
  assert.ok(next, "第二轮通知上还得有回复框");
  const verified = svc.verify(next!.token);
  assert.ok(!("error" in verified));
  assert.equal(verified.intent.intentId !== root, true, "每一轮是一枚独立意图");
  assert.equal(notificationIdFor(verified.intent.intentId) === notificationIdFor(root), false);
  assert.equal(verified.intent.replyRound?.round, 2);

  // 用户肯回话 = 这次主动找对了人（回灌频控）
  assert.deepEqual(outcomes, [{ deliveryId: "d_first", outcome: "accepted" }]);

  // 同一枚 token 连点两下：不再重复落流（一句话在主会话里出现两遍是最难看的错）
  const again = await svc.execute(token, { input: "6 点门口见" });
  assert.equal(again.ok, true);
  await port.settle();
  assert.equal(port.ingested.length, 1, "幂等：重复点击不再落第二句");
});

test("空输入不放行（点了回复但什么都没打，不许假装收到了）", async () => {
  const { svc } = makeService();
  const { pipeline } = fakePipeline();
  const port = makeReplyPort();
  registerNotificationActionExecutors(svc, { pipeline, notificationReply: port });
  const token = firstRoundToken(svc, pulseProposal());
  const out = await svc.execute(token, { input: "   " });
  assert.equal(out.ok, false);
  await port.settle();
  assert.equal(port.ingested.length, 0);
  assert.equal(port.pushed.length, 0);
});

test("端口未装配时如实失败（不放一个按下去石沉大海的输入框）", async () => {
  const { svc } = makeService();
  const { pipeline } = fakePipeline();
  registerNotificationActionExecutors(svc, { pipeline });
  const token = firstRoundToken(svc, pulseProposal());
  const out = await svc.execute(token, { input: "在的" });
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.error, /没装配/);
});

test("连续三轮封顶：第四轮通知上只剩「打开对话」，没有输入框（§4.3 步骤 5）", async () => {
  const { svc } = makeService();
  const { pipeline } = fakePipeline();
  const port = makeReplyPort();
  registerNotificationActionExecutors(svc, { pipeline, notificationReply: port });

  // 沿着真实 token 走满 MAX_REPLY_ROUNDS 轮：每轮的回复框都来自上一轮推下来的视图
  let token = firstRoundToken(svc, pulseProposal());
  for (let round = 1; round <= MAX_REPLY_ROUNDS; round++) {
    const res = await svc.execute(token, { input: `第 ${round} 句` });
    assert.equal(res.ok, true);
    await port.settle();
    const push = port.pushed[port.pushed.length - 1]!;
    assert.equal(port.ingested.length, round);
    const actions = push.actionIntent?.actions ?? [];
    if (round < MAX_REPLY_ROUNDS) {
      assert.deepEqual(
        actions.map((a) => a.actionId),
        [NOTIFY_ACTION.chatReply],
        `第 ${round + 1} 轮该还能接着回`,
      );
      assert.equal(actions[0]?.kind, "input");
    } else {
      assert.deepEqual(
        actions.map((a) => a.actionId),
        [NOTIFY_ACTION.openChat],
        "三轮用完 → 只留「打开对话」",
      );
      assert.equal(actions[0]?.kind, "execute", "打开对话是导航，不是输入框");
    }
    const next = actions[0];
    assert.ok(next);
    token = next!.token;
  }
  // 第四轮点「打开对话」：不再落流、不再推应答
  const open = await svc.execute(token, {});
  assert.equal(open.ok, true);
  await port.settle();
  assert.equal(port.ingested.length, MAX_REPLY_ROUNDS);
  assert.equal(port.pushed.length, MAX_REPLY_ROUNDS);

  // 收口规则本身（单测另一头：直接问 buildReplyRoundActions）
  assert.deepEqual(
    buildReplyRoundActions({ kind: "agent_pulse", title: "" }, MAX_REPLY_ROUNDS + 1).map((a) => a.actionId),
    [NOTIFY_ACTION.openChat],
  );
});

test("出站帧：仍是 agent.proactive_message，带 notification_reply 来源与横幅归属端", () => {
  const sent: string[] = [];
  const delivery = new ProactiveDeliveryService({
    trySend: (_actorId, json) => {
      sent.push(json);
      return true;
    },
  });
  const root = "ai_root_1";
  const actionIntent = {
    intentId: root,
    title: "",
    body: "6 点门口见",
    risk: "L0" as const,
    expiresAt: Date.now() + 60_000,
    actions: [
      {
        actionId: NOTIFY_ACTION.chatReply,
        label: "回复",
        kind: "input" as const,
        token: "ai1.x.y",
        allowFreeFormInput: true,
      },
    ],
  };
  const res = delivery.deliverNotificationReply({
    actorId: "user-a",
    title: "回你一句",
    text: "好，那我 6 点在门口等你",
    rootIntentId: root,
    round: 2,
    actionIntent,
  });
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  const frame = JSON.parse(sent[0]!) as {
    type: string;
    payload: Record<string, unknown> & { messageId: string; deliveryId: string };
  };
  // 事件类型不变 = 客户端已有的「前台落流 / 后台同 id 更新通知 / 非归属端不弹横幅」
  // 三段判定原样生效，不需要新事件类型、不需要改 main.dart
  assert.equal(frame.type, "agent.proactive_message");
  assert.equal(frame.payload["source"], "notification_reply");
  assert.deepEqual(frame.payload["reply"], { rootIntentId: root, round: 2 });
  assert.equal(frame.payload["notifyOn"], "mobile", "横幅钉在回话的这一端（通知栏只在手机上）");
  assert.equal(frame.payload["display"], undefined, "回信不是新打扰，不抢弹窗");
  const payloadIntent = frame.payload["actionIntent"] as { intentId: string };
  assert.equal(payloadIntent.intentId, root, "通知 id 由它算出：同一条通知原地更新");
  assert.match(frame.payload.messageId, /^proactive-/);
  // 两端都在线时电脑端也要看到这条应答：投递走全端 fan-out（trySend），
  // 只是不在那一端弹横幅
  assert.equal(sent.length, 1);

  // 无在线设备：如实返回失败（应答仍已在主会话线程里，重连能看到）
  const offline = new ProactiveDeliveryService({ trySend: () => false });
  const r2 = offline.deliverNotificationReply({
    actorId: "user-a",
    title: "回你一句",
    text: "在的",
    rootIntentId: root,
    round: 2,
  });
  assert.deepEqual(r2, { ok: false, reason: "no_online_device" });
});
