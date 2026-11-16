/**
 * 通知栏动作集（2026-11-13「通知即界面」）——把一条主动提案翻译成通知栏上可点的按钮。
 *
 * 三条硬规则（来自设计稿，改动前先看那三行）：
 *   1. **每个按钮背后必须有一个真接口**。NEXTBOT 不在物理世界里，「放快递柜」
 *      这种动作一个都执行不了——所以动作集只覆盖纯软件决策。
 *   2. **按钮 ≤ 3**。Android 折叠区最多展示 3 个，多了等于没有。
 *   3. **L2（花钱/不可逆）提案不放执行按钮**，只给「去确认」——通知栏是低承诺
 *      环境，误触成本远高于对话内确认。
 *
 * 动作 id 是**跨渲染面共享**的：聊天卡的按钮和通知栏的按钮用的是同一个 id，
 * 因此同一个动作在两个面上只有一套语义、一套审计、一套失败处理。
 */
import type { ActionIntent, ActionIntentAction, ActionRisk } from "./action-intent-store.js";
import type { ActionIntentService } from "./action-intent-service.js";
import type { ProactiveProposal } from "./pipeline-types.js";

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
} as const;

/** Android 折叠区最多 3 个按钮 */
export const MAX_NOTIFY_ACTIONS = 3;

/** 推迟重投的默认间隔（ms）：30 分钟 */
export const DEFAULT_SNOOZE_MS = 30 * 60_000;

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
 * 构造这条提案在通知栏上的动作集。
 *
 * 两种形态：
 *   · ask_first 提案（带 confirmAction）→ 批准 / 拒绝（真正拍板）
 *   · 告知类提案 → 收下 / 稍后 / 不用了（把「要不要回一句话」变成「点一下」）
 *
 * L2 提案：两种形态都不给执行按钮，只给一个「去确认」——把不可逆动作留在
 * 用户明确知情的环境里做。
 */
export function buildNotifyActions(p: ProactiveProposal): ActionIntentAction[] {
  const risk = classifyNotifyRisk(p);
  // L2（花钱 / 不可逆）：通知栏**不放执行按钮**。
  // 通知栏是低承诺环境，误触成本远高于对话内确认——这类动作只在用户明确知情的
  // 环境里做。通知正文会写明「我不能替你静默做」，点开通知进 App 处理。
  if (risk === "L2") return [];

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
          label: "好就这么办",
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
        {
          actionId: NOTIFY_ACTION.dismiss,
          label: "不用了",
          kind: "execute",
          payload: { kind: p.kind, title: p.title },
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
  });
}
