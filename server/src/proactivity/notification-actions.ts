/**
 * 通知栏动作集（2026-11-13「通知即界面」）——把一条主动提案翻译成通知栏上可点的按钮。
 *
 * 三条硬规则（来自设计稿，改动前先看那三行）：
 *   1. **每个按钮背后必须有一个真接口**。NEXTBOT 不在物理世界里，「放快递柜」
 *      这种动作一个都执行不了——所以动作集只覆盖纯软件决策。
 *   2. **按钮 ≤ 2**（2026-11-19 用户拍板：最多两个并排，不要多）。原来 ≤ 3，
 *      但第三项（「不用了」）是负反馈、极少有人点，白占一行。现在并排两项为主。
 *   3. **L2（花钱/不可逆）提案不放执行按钮**，只给「去确认」——通知栏是低承诺
 *      环境，误触成本远高于对话内确认。
 *
 * 选项来源（2026-11-19「按内容动态生成」）：
 *   提案自带 notifyOptions → 直接用（触发源按本条真实内容声明，文案各不相同）；
 *   没有自带 → 按 confirmAction 走通用默认（ask_first=批准/拒绝，告知类=收下/稍后）。
 *   任何情况下都被 MAX_NOTIFY_ACTIONS=2 与 L2 风险闸收口。
 *   跟进/闲聊类（REPLYABLE_KINDS）额外给「回复」输入框（2026-11-29 §4.3）：
 *   回的一句话落成主会话一个 user turn，agent 的回复再用**同一条通知**原地更新，
 *   连续 MAX_REPLY_ROUNDS 轮后收口为「打开对话」——通知栏不是聊天窗口。
 *
 * 动作 id 是**跨渲染面共享**的：聊天卡的按钮和通知栏的按钮用的是同一个 id，
 * 因此同一个动作在两个面上只有一套语义、一套审计、一套失败处理。
 */
import type { ActionIntent, ActionIntentAction, ActionRisk } from "./action-intent-store.js";
import { OPEN_CHAT_ACTION_ID, openChatAction } from "./action-intent-service.js";
import type { ActionIntentService } from "./action-intent-service.js";
import type { ProactiveProposal, ProposalNotifyOption } from "./pipeline-types.js";

/** 通知栏动作 id 族（聊天卡与通知栏共用） */
export const NOTIFY_ACTION = {
  /** 收下/知道了：这条我记下了，按这个来 */
  acknowledge: "proactivity.acknowledge",
  /** 稍后再说：把这件事推迟重投 */
  snooze: "proactivity.snooze",
  /** 不用了：不再提这件事 */
  dismiss: "proactivity.dismiss",
  /** 批准（ask_first 提案）：真的去做 */
  approve: "proactivity.approve",
  /** 拒绝（ask_first 提案）：别做 */
  decline: "proactivity.decline",
  // ── 领域动作（2026-11-23 通知闭环 M1）：按下去真的回写业务状态 ──
  /** 快递已取件 → 台账置 resolved */
  parcelPicked: "parcel.picked",
  /** 账单已处理（已还/已缴）→ 台账置 resolved */
  billSettled: "bill.settled",
  /** 日程完成 → ScheduleTaskService.completeTask */
  scheduleComplete: "schedule.complete",
  /** 日程推迟 → ScheduleTaskService.snoozeTask */
  scheduleSnooze: "schedule.snooze",
  // ── 「回复」闭环（2026-11-29 §4.3）：通知栏里直接回一句话，不打断手里的事 ──
  /** 内联输入框回复 → 落成主会话一个 user turn（source=notification_reply）+ 触发一轮 agent */
  chatReply: "chat.reply",
  /** 打开对话：只做导航（客户端 showsUserInterface=true），回复轮次用完后的唯一留存按钮。
   *  id 用签发端的常量：§4.4 决策半屏页额外挂的这一枚不在 intent.actions 里，
   *  验签侧按这个 id 放行，两处必须逐字一致。 */
  openChat: OPEN_CHAT_ACTION_ID,
} as const;

/** 并排最多 2 个按钮（2026-11-19 用户拍板，原为 3） */
export const MAX_NOTIFY_ACTIONS = 2;

/**
 * 同一条通知上最多几轮内联回复（2026-11-29 §4.3 步骤 5）。
 * 超过就退回「打开对话」——通知栏是三行高的界面，第 4 轮起该把用户带回会话，
 * 而不是把聊天塞进通知栏里。
 */
export const MAX_REPLY_ROUNDS = 3;

/**
 * 值得给「回复」输入框的主动消息种类（§4.2 表「跟进 / 闲聊」那一行）。
 * 判定集中在这里：新增种类加一行即可，别处不写字面量。
 */
export const REPLYABLE_KINDS: ReadonlySet<string> = new Set(["agent_pulse", "task_followup"]);

/** 构造回复/打开对话按钮只需要这两样（提案本体结构上就满足，执行器在后续轮次
 *  手上只有意图，所以类型放轻到这里） */
export type NotifyActionMeta = { kind: string; title: string };

/** 这条提案是否值得在通知栏里直接回一句话 */
export function isReplyableProposal(p: NotifyActionMeta): boolean {
  return REPLYABLE_KINDS.has(p.kind);
}

/**
 * 「回复」这枚按钮（kind=input → Android RemoteInput）。
 * payload 带 kind/title 只为回执文案能指回原话题；真正的线程归属在
 * `ActionIntent.replyRound` 上（同一条通知的多轮回复要落进同一个线程）。
 */
export function buildChatReplyAction(p: NotifyActionMeta): ActionIntentAction {
  return {
    actionId: NOTIFY_ACTION.chatReply,
    label: "回复",
    kind: "input",
    inputLabel: "回一句",
    allowFreeFormInput: true,
    payload: { kind: p.kind, title: p.title },
  };
}

/** 「打开对话」：按下去把用户带回会话（不做 POST，见客户端 _onTap 注释）。
 *  文案与 id 复用 §4.4 半屏页那一处常量，两个面上「打开对话」永远是同一枚动作。 */
export function buildOpenChatAction(p: NotifyActionMeta): ActionIntentAction {
  return { ...openChatAction(), payload: { kind: p.kind, title: p.title } };
}

/**
 * 回复线程第 n 轮之后通知上还剩什么按钮（§4.3 步骤 5）。
 * round = 即将开始的这一轮（1 起）：还在额度内 → 继续给回复框；用完 → 只留「打开对话」。
 */
export function buildReplyRoundActions(
  p: NotifyActionMeta,
  round: number,
): ActionIntentAction[] {
  return round > MAX_REPLY_ROUNDS ? [buildOpenChatAction(p)] : [buildChatReplyAction(p)];
}

/**
 * 一条意图所在的回复线程：根意图 id + 当前轮次。
 * 第一轮没有 root（它自己就是根）——根 id 是客户端「同一条通知原地更新」的
 * 身份依据（通知 id 由它算出），所以每一轮都必须带同一个根出去。
 */
export function replyThreadOf(intent: ActionIntent): { rootIntentId: string; round: number } {
  return {
    rootIntentId: intent.replyRound?.rootIntentId ?? intent.intentId,
    round: intent.replyRound?.round ?? 1,
  };
}

/** 推迟重投的默认间隔（ms）：30 分钟 */
export const DEFAULT_SNOOZE_MS = 30 * 60_000;

/** 日程推迟的默认间隔（ms）：15 分钟（设计稿「15 分钟后」） */
export const DEFAULT_SCHEDULE_SNOOZE_MS = 15 * 60_000;

/**
 * 风险分级（L0/L1/L2）——决定通知栏放不放执行按钮、有效期多长。
 * 依据提案自己声明的 utility.risk（触发源声明或由行动步骤推导）。
 * 没有声明 → 按 L0 放行（宁可多给按钮，也不要把可逆动作卡死在对话里）。
 */
export function classifyNotifyRisk(p: ProactiveProposal): ActionRisk {
  const risk = p.utility?.risk;
  if (!risk) return "L0";
  if (risk.financialImpact === "high") return "L2";
  if (!risk.reversible && risk.thirdPartyImpact) return "L2";
  if (!risk.reversible) return "L1";
  if (risk.thirdPartyImpact) return "L1";
  return "L0";
}

/**
 * 触发源显式声明「这条可以在通知栏里回一句」的选项角色（§4.3）。
 * `ProposalNotifyOption.action` 是只读的封闭联合类型进不来这个角色，
 * 就以字符串承载、在这里按字符串再认一次。
 */
export const CHAT_REPLY_ROLE = "chat_reply";

/**
 * 把提案自带的语义选项映射成真动作。每个 `action` 都对应 notification-action-executors
 * 里已注册的执行器——文案可以随内容变，背后干的活始终是那一套真接口。
 */
function optionToAction(p: ProactiveProposal, opt: ProposalNotifyOption): ActionIntentAction | null {
  const kind = "execute" as const;
  const title = p.title;
  const basePayload = { kind: p.kind, title };
  // 「回复」角色（见 CHAT_REPLY_ROLE 注释）：不是 execute，必须在这里截走，
  // 否则就会被下面那句 `const kind = "execute"` 拍成一个按下去没有输入框的执行按钮。
  if ((opt.action as string) === CHAT_REPLY_ROLE) return buildChatReplyAction(p);
  switch (opt.action) {
    case "acknowledge":
      return { actionId: NOTIFY_ACTION.acknowledge, label: opt.label, kind, payload: basePayload };
    case "snooze":
      return {
        actionId: NOTIFY_ACTION.snooze,
        label: opt.label,
        kind,
        payload: {
          ...basePayload,
          delayMs: opt.delayMs ?? DEFAULT_SNOOZE_MS,
          // 推迟要重新入队 → 必须带上提案本体（已投递的提案已出队，服务端手上没有了）
          proposal: p,
        },
      };
    case "dismiss":
      return { actionId: NOTIFY_ACTION.dismiss, label: opt.label, kind, payload: basePayload };
    case "approve":
      return {
        actionId: NOTIFY_ACTION.approve,
        label: opt.label,
        kind,
        payload: { ...basePayload, confirmId: p.confirmAction?.label },
      };
    case "decline":
      return { actionId: NOTIFY_ACTION.decline, label: opt.label, kind, payload: basePayload };
    // 领域动作：没有 ref 就不知道改哪条业务记录 → 丢弃（不放一个按了没用的按钮）
    case "parcel_picked":
      return opt.ref
        ? { actionId: NOTIFY_ACTION.parcelPicked, label: opt.label, kind, payload: { ...basePayload, ref: opt.ref } }
        : null;
    case "bill_settled":
      return opt.ref
        ? { actionId: NOTIFY_ACTION.billSettled, label: opt.label, kind, payload: { ...basePayload, ref: opt.ref } }
        : null;
    case "schedule_complete":
      return opt.ref
        ? { actionId: NOTIFY_ACTION.scheduleComplete, label: opt.label, kind, payload: { ...basePayload, ref: opt.ref } }
        : null;
    case "schedule_snooze":
      return opt.ref
        ? {
            actionId: NOTIFY_ACTION.scheduleSnooze,
            label: opt.label,
            kind,
            payload: { ...basePayload, ref: opt.ref, delayMs: opt.delayMs ?? DEFAULT_SCHEDULE_SNOOZE_MS },
          }
        : null;
    default:
      return null;
  }
}

/**
 * 构造这条提案在通知栏上的动作集（最多两个，2026-11-19）。
 *
 * 选项来源优先级：
 *   1. 提案自带 `notifyOptions` —— 触发源按本条真实内容生成，文案各不相同（推荐）；
 *   2. 跟进/闲聊类（REPLYABLE_KINDS）→ 「回复」输入框（+ 知道了）——§4.3；
 *   3. ask_first 提案（带 confirmAction）→ 批准 / 拒绝（真正拍板）；
 *   4. 其余告知类 → 收下 / 稍后再说（把「要不要回一句话」变成「点一下」）。
 *
 * L2 提案：任何形态都不给执行按钮，只留「去确认」——把不可逆动作留在用户
 * 明确知情的环境里做。空文案项一律丢弃，避免渲染出没字的可点按钮。
 */
export function buildNotifyActions(p: ProactiveProposal): ActionIntentAction[] {
  const risk = classifyNotifyRisk(p);
  // L2（花钱 / 不可逆）：通知栏**不放执行按钮**。
  // 通知栏是低承诺环境，误触成本远高于对话内确认——这类动作只在用户明确知情的
  // 环境里做。通知正文会写明「我不能替你静默做」，点开通知进 App 处理。
  if (risk === "L2") return [];

  // ① 提案自带选项：按内容动态生成的按钮优先（空文案过滤后仍可能为空 → 回退默认）
  if (p.notifyOptions?.length) {
    const own = p.notifyOptions
      .filter((opt) => opt.label?.trim())
      .slice(0, MAX_NOTIFY_ACTIONS)
      .map((opt) => optionToAction(p, opt))
      .filter((a): a is ActionIntentAction => a !== null);
    if (own.length > 0) return own;
  }

  // ①'' 「回复」闭环（2026-11-29 §4.3）：跟进/闲聊类主动消息在通知栏里就能回一句话。
  // 注意它与 suppressDefaultActions 的关系：那个开关否掉的是「知道了 / 稍后再说」
  // 这种按下去不改变任何状态的假按钮；回复框是**真动作**（落成主会话一个 user turn
  // 并触发一轮 agent 回复），所以抑制默认按钮的可回答消息照样给回复框。
  // 已经有自带真动作的提案不插回复——两个并排的额度留给那些动作（① 优先）。
  if (isReplyableProposal(p)) {
    const reply = buildChatReplyAction(p);
    if (p.suppressDefaultActions) return [reply];
    const ack: ActionIntentAction = {
      actionId: NOTIFY_ACTION.acknowledge,
      label: "知道了",
      kind: "execute",
      payload: { kind: p.kind, title: p.title },
    };
    return [reply, ack].slice(0, MAX_NOTIFY_ACTIONS);
  }

  // ①' 触发源明确说过「这条没有可拍板的事」：不给默认双按钮。
  // 告知/闲聊类提案套「知道了 / 稍后再说」等于两个按了不改变任何状态的假按钮；
  // 宁可没有动作行，也不要骗用户。（映射丢弃后的空选项也走这里）
  if (p.suppressDefaultActions) return [];

  // ② 通用默认：ask_first=批准/拒绝，告知类=收下/稍后（最多两项）
  const base: ActionIntentAction[] = p.confirmAction
    ? [
        {
          actionId: NOTIFY_ACTION.approve,
          label: p.confirmAction.label?.trim() || "就这么办",
          kind: "execute",
          payload: { kind: p.kind, title: p.title, confirmId: p.confirmAction.label },
        },
        {
          actionId: NOTIFY_ACTION.decline,
          label: "先不用",
          kind: "execute",
          payload: { kind: p.kind, title: p.title },
        },
      ]
    : [
        {
          actionId: NOTIFY_ACTION.acknowledge,
          label: "知道了",
          kind: "execute",
          payload: { kind: p.kind, title: p.title },
        },
        {
          actionId: NOTIFY_ACTION.snooze,
          label: "稍后再说",
          kind: "execute",
          payload: {
            kind: p.kind,
            title: p.title,
            delayMs: DEFAULT_SNOOZE_MS,
            // 推迟要重新入队 → 必须带上提案本体（已投递的提案已出队，服务端手上没有了）
            proposal: p,
          },
        },
      ];

  return base.slice(0, MAX_NOTIFY_ACTIONS);
}

/**
 * 为一条提案登记动作意图（WS 投递与离线推送**共用这一个入口**——此前两处各写一遍
 * 相同的 register 逻辑，是同一份逻辑的两个拷贝）。
 *
 * 返回 undefined = 这条提案不值得登记（没有按钮且不是 L2，通知里没有决策可做）。
 * 调用方拿返回值自己 renderForClient——签发失败由调用方兜底（通知照发，只是没按钮）。
 */
export function registerIntentForProposal(
  svc: ActionIntentService,
  p: ProactiveProposal,
  opts: { title: string; body: string; deliveryId: string },
): ActionIntent | undefined {
  const actions = buildNotifyActions(p);
  const risk = classifyNotifyRisk(p);
  // L2 提案没有按钮，但仍登记意图：客户端靠 intentId 找回这个决策（点开进 App 处理）
  if (actions.length === 0 && risk !== "L2") return undefined;
  return svc.register({
    actorId: p.actorId,
    kind: p.kind,
    title: opts.title,
    body: opts.body.slice(0, 300),
    summary: p.summary?.slice(0, 160),
    risk,
    actions,
    deliveryId: opts.deliveryId,
    // 通知栏回复线程的第 1 轮挂在这条意图上（§4.3）：后续每一轮都带同一个
    // rootIntentId，据此把「同一条通知原地更新」和「第几轮该收口」算出来。
    ...(actions.some((a) => a.actionId === NOTIFY_ACTION.chatReply)
      ? { replyRound: { round: 1 } }
      : {}),
  });
}
