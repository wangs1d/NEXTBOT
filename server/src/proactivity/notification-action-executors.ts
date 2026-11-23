/**
 * 通知栏动作执行器（2026-11-13「通知即界面」）。
 *
 * 这里把 actionId 接到**真实的管道能力**上——每个按钮按下去都必须真的改变某个状态，
 * 否则就是骗人的按钮（用户点「取消续费」，结果什么都没发生，这比没有按钮更糟）。
 *
 * 五个动作全部零 LLM：
 *   proactivity.acknowledge  好就这么办 → 记 accepted（频控自适应据此回升）+ 回执
 *   proactivity.snooze       稍后再说   → 提案重新入队，30 分钟后重投
 *   proactivity.dismiss      不用了     → 记 dismissed（负反馈即时冷却）+ 回执
 *   proactivity.approve      就这么办   → ask_first 提案：走确认批准（**真的执行**）
 *   proactivity.decline      先不用     → ask_first 提案：关闭确认
 *
 * 领域动作（2026-11-23 通知闭环 M1）——回写业务，再记一次正反馈：
 *   parcel.picked            已取件     → BillParcelLedger.resolve
 *   bill.settled             已处理     → BillParcelLedger.resolve
 *   schedule.complete        完成       → ScheduleTaskService.completeTask
 *   schedule.snooze          N 分钟后   → ScheduleTaskService.snoozeTask
 *
 *
 * 「回复」闭环（2026-11-29 §4.3）——通知栏里回一句话就把事办完：
 *   chat.reply               回复       → 主会话一个 user turn（source=notification_reply）
 *                                          → 跑一轮 agent → 应答用**同一条通知**原地更新
 *   chat.open                打开对话   → 只做导航 + 记一次正反馈（轮次用完后的留存按钮）
 */
import type {
  ActionExecutionResult,
  ActionIntentService,
  ClientActionIntent,
} from "./action-intent-service.js";
import type { ActionIntent, ActionIntentAction } from "./action-intent-store.js";
import {
  DEFAULT_SCHEDULE_SNOOZE_MS,
  NOTIFY_ACTION,
  buildReplyRoundActions,
  replyThreadOf,
} from "./notification-actions.js";
import type { ProactiveProposal } from "./pipeline-types.js";

export type NotificationExecutorDeps = {
  /** 主动管道（执行动作的落点：回执/outcome/提案重投/确认推进） */
  pipeline: {
    recordOutcome: (
      deliveryId: string,
      outcome: "accepted" | "dismissed" | "snoozed",
      /** ref = 这条投递指向的业务实体（日程 taskId 等），提醒槽位学习要它才能归到具体时刻 */
      meta?: { surface?: string; ref?: string },
    ) => boolean;
    requeueProposal: (proposal: ProactiveProposal, deliverAfter: number) => boolean;
    resolveConfirmationByKind: (
      actorId: string,
      kind: string,
      approved: boolean,
    ) => { ok: boolean; message: string };
  } | null;
  /** 账单/快递台账（领域动作 parcel.picked / bill.settled 的落点；未注入 = 这两个按钮执行失败回执） */
  ledger?: {
    resolve(id: string, actorId: string): { id: string; title: string; category: string } | null;
  } | null;
  /** 日程服务（领域动作 schedule.complete / schedule.snooze 的落点） */
  schedule?: {
    getTask(taskId: string): { taskId: string; sessionId: string; title?: string; shortTitle?: string } | undefined;
    completeTask(taskId: string): Promise<{ changed: boolean }>;
    snoozeTask(taskId: string, minutes: number): Promise<{ nextRunAt: string | null }>;
  } | null;
  /**
   * 业务状态变化通知（2026-11-23 需求 §5.2）：领域按钮改完台账后回调，
   * 装配层据此刷新常驻通知与桌面小组件——「在通知上点已取件，3 秒内卡片同步」。
   * 日程类动作不用它：任务变更本身已走 setTaskChangeHandler 推送，再推一次就是重帧。
   */
  onBusinessChange?: (actorId: string) => void;
  /**
   * 「回复」闭环的两个端口（2026-11-29 §4.3）。本模块不认识 runtime，也不认识
   * WebSocket——落用户消息与推送应答的具体通道由装配层注入：
   *   ingestUserTurn  把通知栏里回的一句话落成主会话的一个 user turn 并跑一轮
   *                   agent（与 WS chat.user_message 同一条链路，同 AgentCore）；
   *   pushFollowUp    把 agent 的应答送回**同一条通知**（同 rootIntentId → 同通知 id）。
   * 未注入 = chat.reply 如实失败（不放一个按下去石沉大海的输入框）。
   */
  notificationReply?: {
    ingestUserTurn(input: {
      actorId: string;
      text: string;
      /** 稳定 id：同一轮重复提交在落库层幂等（客户端连点 / 网络重试只算一句） */
      messageId: string;
      rootIntentId: string;
      round: number;
    }): Promise<{ ok: true; reply: string } | { ok: false; message: string }>;
    pushFollowUp(input: {
      actorId: string;
      title: string;
      text: string;
      /**
       * 用户在通知栏里回的原话（§4.3 步骤 3）：应答事件带回这句话，客户端据此
       * 在对话流里落**唯一**一条用户气泡（落库端仍是 ingestUserTurn 那条，客户
       * 端不再另发 chat.user_message——多一条用户消息的老 leak 就是这么来的）。
       */
      userText?: string;
      rootIntentId: string;
      round: number;
      actionIntent?: ClientActionIntent;
    }): { ok: boolean; reason?: string };
  } | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 「一句话只落一次」闸门（§4.3 三连漏发的根修）。
 *
 * 通知点按在 flutter_local_notifications 里可能**同时**投递到主 isolate
 * （onDidReceiveNotificationResponse）与后台 isolate（…BackgroundResponse），
 * 客户端两个回调都会 POST /api/action-intents/execute（见
 * local_notification_service.dart 的 _onTap 注释）。而 ActionIntentService
 * 的幂等是「检查 state → await executor → markExecuted」，await 边界会让两个
 * 并发请求都从 pending 穿过去；落库层的 turn 级幂等此时也判不出重复（第一条
 * 的 assistant 还没落，isTurnAlreadyPersisted=false）。结果就是一次回复落成
 * 两条一样的用户消息、签出两枚下一轮意图、通知被第二张卡覆盖。
 *
 * 修法放在源头：执行器入口同步 check-and-set。Node 事件循环里同步段不会交错，
 * 同一个 (rootIntentId, round) 至多放行一次——后到的重复请求直接复用同一条
 * 秒回文案，不再落库、不再签轮、不再推送。容量上限只为防止长进程里键位无限
 * 增长（一轮回复的键活不过会话线程的生命周期，512 条线程绰绰有余）。
 */
const claimedReplyTurns = new Map<string, true>();
const MAX_CLAIMED_REPLY_TURNS = 512;
/** 一轮回复的身份证：根意图 + 轮次，唯一确定「用户在通知栏回的哪一句」 */
function replyTurnKey(rootIntentId: string, round: number): string {
  return `${rootIntentId}:${round}`;
}
function claimReplyTurn(key: string): boolean {
  if (claimedReplyTurns.has(key)) return false;
  claimedReplyTurns.set(key, true);
  if (claimedReplyTurns.size > MAX_CLAIMED_REPLY_TURNS) {
    const oldest = claimedReplyTurns.keys().next();
    if (!oldest.done) claimedReplyTurns.delete(oldest.value);
  }
  return true;
}

/** "15:15" 形式的本地时刻（回执文案用） */
function hhmm(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function registerNotificationActionExecutors(
  actionIntents: ActionIntentService,
  deps: NotificationExecutorDeps,
): void {
  const { pipeline, ledger, schedule, onBusinessChange } = deps;

  /** 领域动作成功后的统一正反馈：这条主动消息有用（频控回升 + hook 回灌） */
  const noteAccepted = (deliveryId: string | undefined, ref?: string): void => {
    if (deliveryId) pipeline?.recordOutcome(deliveryId, "accepted", ref ? { ref } : undefined);
  };

  /** 业务状态已变 → 通知装配层刷新常驻通知/小组件（失败不该拖垮动作回执） */
  const changed = (actorId: string): void => {
    try {
      onBusinessChange?.(actorId);
    } catch {
      /* 看板刷新失败不影响按钮回执 */
    }
  };

  /** 收下：告诉系统「这条有用」（频控回升），不给任何副作用 */
  actionIntents.registerExecutor(NOTIFY_ACTION.acknowledge, ({ intent, action }) => {
    if (intent.deliveryId) {
      pipeline?.recordOutcome(intent.deliveryId, "accepted");
    }
    const title = str(action.payload?.title) || intent.title;
    // 无标题消息（agent_pulse 定稿「不再有心跳回顾牌子」）不能拼成「好，就这么定了」
    return { ok: true, message: title ? `好，${title}就这么定了` : "好，记下了" };
  });

  /** 稍后再说：把这条提案重新入队，delayMs 后重投 */
  actionIntents.registerExecutor(NOTIFY_ACTION.snooze, ({ intent, action }) => {
    const proposal = action.payload?.proposal as ProactiveProposal | undefined;
    const delayMs = typeof action.payload?.delayMs === "number" ? action.payload.delayMs : 30 * 60_000;
    if (!proposal) {
      return { ok: false, message: "这条已经过期了，没法再推迟" };
    }
    if (!pipeline) {
      return { ok: false, message: "执行通道未装配" };
    }
    const at = Date.now() + delayMs;
    const ok = pipeline.requeueProposal(proposal, at);
    if (intent.deliveryId) pipeline.recordOutcome(intent.deliveryId, "snoozed");
    if (!ok) {
      return { ok: false, message: "这件事已经在队列里了，我到点再说" };
    }
    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    return { ok: true, message: `好，${minutes} 分钟后再提醒你` };
  });

  /** 不用了：记一次负反馈（频控即时降温），不再重投 */
  actionIntents.registerExecutor(NOTIFY_ACTION.dismiss, ({ intent }) => {
    if (intent.deliveryId) {
      pipeline?.recordOutcome(intent.deliveryId, "dismissed");
    }
    return { ok: true, message: "好，不再提这件事" };
  });

  /** 批准：ask_first 提案真的执行（与对话里回「可以」同一条路） */
  actionIntents.registerExecutor(NOTIFY_ACTION.approve, ({ intent, action }) => {
    const kind = str(action.payload?.kind) || intent.kind;
    if (!pipeline) return { ok: false, message: "执行通道未装配" };
    return pipeline.resolveConfirmationByKind(intent.actorId, kind, true);
  });

  /** 拒绝：关闭这条确认 */
  actionIntents.registerExecutor(NOTIFY_ACTION.decline, ({ intent, action }) => {
    const kind = str(action.payload?.kind) || intent.kind;
    if (!pipeline) return { ok: false, message: "执行通道未装配" };
    return pipeline.resolveConfirmationByKind(intent.actorId, kind, false);
  });

  // ───────────── 领域动作（2026-11-23 通知闭环 M1） ─────────────

  /** 快递已取件：台账置 resolved → 不再计入待取件（动态页/小组件/早安同步消失） */
  actionIntents.registerExecutor(NOTIFY_ACTION.parcelPicked, ({ intent, action }) => {
    const ref = str(action.payload?.ref);
    if (!ledger) return { ok: false, message: "台账没装配，回 App 里处理吧" };
    if (!ref) return { ok: false, message: "找不到是哪个快递了，回 App 里处理吧" };
    const entry = ledger.resolve(ref, intent.actorId);
    if (!entry) return { ok: false, message: "这个快递已经不在记录里了" };
    noteAccepted(intent.deliveryId);
    changed(intent.actorId);
    return { ok: true, message: "好，划掉了", detail: { ref, resolved: true } };
  });

  /** 账单已处理：台账置 resolved（金额仍计入月度汇总，只是不再当待办） */
  actionIntents.registerExecutor(NOTIFY_ACTION.billSettled, ({ intent, action }) => {
    const ref = str(action.payload?.ref);
    if (!ledger) return { ok: false, message: "台账没装配，回 App 里处理吧" };
    if (!ref) return { ok: false, message: "找不到是哪笔账单了，回 App 里处理吧" };
    const entry = ledger.resolve(ref, intent.actorId);
    if (!entry) return { ok: false, message: "这笔账单已经不在记录里了" };
    noteAccepted(intent.deliveryId);
    changed(intent.actorId);
    return { ok: true, message: "记下了", detail: { ref, resolved: true } };
  });

  /** 日程完成：单次任务置 completed（commitments 由装配层既有监听收口） */
  actionIntents.registerExecutor(NOTIFY_ACTION.scheduleComplete, async ({ intent, action }) => {
    const ref = str(action.payload?.ref);
    if (!schedule) return { ok: false, message: "日程服务没装配，回 App 里处理吧" };
    const task = ref ? schedule.getTask(ref) : undefined;
    if (!task) return { ok: false, message: "这条日程已经不在了" };
    // 归属核对：意图签发时的 actor 必须是任务的 session（防 token 外流后改别人的日程）
    if (task.sessionId !== intent.actorId) return { ok: false, message: "这条日程不属于当前账号" };
    await schedule.completeTask(ref);
    noteAccepted(intent.deliveryId, ref);
    return { ok: true, message: "已完成 ✓", detail: { ref } };
  });

  /** 日程推迟：delayMs 后再提醒一次（重复任务不支持，如实回执） */
  actionIntents.registerExecutor(NOTIFY_ACTION.scheduleSnooze, async ({ intent, action }) => {
    const ref = str(action.payload?.ref);
    if (!schedule) return { ok: false, message: "日程服务没装配，回 App 里处理吧" };
    const task = ref ? schedule.getTask(ref) : undefined;
    if (!task) return { ok: false, message: "这条日程已经不在了" };
    if (task.sessionId !== intent.actorId) return { ok: false, message: "这条日程不属于当前账号" };
    const delayMs =
      typeof action.payload?.delayMs === "number" ? action.payload.delayMs : DEFAULT_SCHEDULE_SNOOZE_MS;
    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    try {
      const next = await schedule.snoozeTask(ref, minutes);
      if (intent.deliveryId) pipeline?.recordOutcome(intent.deliveryId, "snoozed", { ref });
      const at = hhmm(next.nextRunAt);
      return { ok: true, message: at ? `${at} 再提醒你` : `${minutes} 分钟后再提醒你`, detail: { ref } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("recurring")) return { ok: false, message: "重复日程没法单次推迟，下一次会照常提醒" };
      return { ok: false, message: "推迟没成功，回 App 里改一下时间吧" };
    }
  });

  // ───────────── 「回复」闭环（2026-11-29 §4.3） ─────────────

  /**
   * 通知栏输入框里的一句话 → 主会话一个 user turn → agent 回一句 → 原地更新这条通知。
   *
   * 为什么这里必须先秒回、把 agent 那一轮丢到后台跑：客户端点按钮走的是**通知回调
   * 的后台 isolate**，它只等 12 秒（local_notification_actions.dart 的 timeout）。
   * 一轮带工具的 agent 回复动辄十几秒，同步等就会让用户看到「连不上服务器」——
   * 而实际上消息已经落库、回复正在生成。所以：签好下一轮 → 立刻回执「收到，我想想」
   * → 异步落流 + 跑轮 + 推送。异步失败只在服务端记日志（用户侧表现为这条通知停在
   * 「已回复」，点开对话仍能看到答没答上，不会谎报成功）。
   */
  actionIntents.registerExecutor(NOTIFY_ACTION.chatReply, ({ intent, input }) => {
    const text = str(input);
    if (!text) return { ok: false, message: "没收到你要回的话，点开通知再跟我说一句？" };
    const port = deps.notificationReply;
    if (!port) return { ok: false, message: "回复通道没装配，回 App 里跟我说吧" };

    const { rootIntentId, round } = replyThreadOf(intent);
    // 一次点按 = 一句话（源头闸门）：主 isolate 与后台 isolate 会把同一次提交
    // 各 POST 一次，execute() 的幂等在 await 边界竞态下拦不住双发。抢不到闸门
    // 的这一路不落库、不签下一轮、不推送，只复用同一条秒回文案（用户侧无感）。
    if (!claimReplyTurn(replyTurnKey(rootIntentId, round))) {
      return { ok: true, message: "收到，我想想要怎么回你" };
    }
    const nextRound = round + 1;
    const meta = { kind: intent.kind, title: intent.title };
    // 下一轮的动作先签好（回复框还在 → 连续聊；超过 MAX_REPLY_ROUNDS → 只剩「打开对话」）。
    // 必须在返回响应前签：token 要随这次的推送一起下去，事后补签就得再推一次通知。
    let nextView: ClientActionIntent | undefined;
    try {
      const next = actionIntents.register({
        actorId: intent.actorId,
        kind: intent.kind,
        title: intent.title,
        body: text.slice(0, 300),
        ...(intent.summary ? { summary: intent.summary } : {}),
        risk: intent.risk,
        actions: buildReplyRoundActions(meta, nextRound),
        replyRound: { rootIntentId, round: nextRound },
        ...(intent.deliveryId ? { deliveryId: intent.deliveryId } : {}),
      });
      nextView = actionIntents.renderForClient(next, { displayIntentId: rootIntentId });
    } catch (err) {
      console.warn(`[notify-action] chat.reply 下一轮意图签发失败（只回一句，不再给按钮）: ${err}`);
    }

    // 落流用的稳定 id：把它当作用户消息的 clientMessageId，重复提交在落库层幂等。
    const messageId = `notification-reply-${rootIntentId}-${round}`;
    void (async () => {
      const turn = await port.ingestUserTurn({
        actorId: intent.actorId,
        text,
        messageId,
        rootIntentId,
        round,
      });
      if (!turn.ok) {
        console.warn(`[notify-action] chat.reply 落流/回轮失败 actor=${intent.actorId}: ${turn.message}`);
        return;
      }
      const answer = turn.reply.trim();
      if (!answer) return;
      const pushed = port.pushFollowUp({
        actorId: intent.actorId,
        // 标题沿用原那条：同一条通知原地更新，用户看到的还是同一个话题
        title: intent.title || "回你一句",
        text: answer,
        // 用户原话随应答带回：客户端据此在对话流落唯一一条用户气泡
        userText: text,
        rootIntentId,
        round: nextRound,
        ...(nextView ? { actionIntent: nextView } : {}),
      });
      if (!pushed.ok) {
        console.log(
          `[notify-action] chat.reply 应答没能实时送达（${pushed.reason ?? "?"}），已落对话流 actor=${intent.actorId}`,
        );
      }
    })().catch((err) => {
      console.warn(`[notify-action] chat.reply 异步回合异常（已忽略）: ${err}`);
    });

    // 肯回话 = 这次主动找对了人（比点按钮更强的正反馈，回灌频控）
    noteAccepted(intent.deliveryId);
    return { ok: true, message: "收到，我想想要怎么回你" };
  });

  /**
   * 打开对话：回复轮次用完（§4.3 步骤 5）后通知上留的那一枚。
   * 通知栏那一面按下去只是把 App 拉到前台（Android 侧 showsUserInterface=true），
   * 不走 HTTP——回执的 show 会把刚被系统取消的通知原地复活。这个执行器是给
   * **另外两个渲染面**用的：聊天卡上的同名按钮，以及 §4.4 决策半屏页额外挂的
   * 那一枚（它不在 intent.actions 里，verify() 按 OPEN_CHAT_ACTION_ID 放行）——
   * 三处共用一个 actionId、一套审计，按下去记一次「这条我看了」。
   */
  actionIntents.registerExecutor(NOTIFY_ACTION.openChat, ({ intent }) => {
    if (intent.deliveryId) pipeline?.recordOutcome(intent.deliveryId, "accepted");
    return { ok: true, message: "好，回对话里说" };
  });
}
