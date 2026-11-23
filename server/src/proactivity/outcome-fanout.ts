// 主动触达结果的统一回灌出口（2026-11-23 主动触达 M1，需求文档 §4.6）。
//
// 病根（R5）：「用户点了按钮 / 把它忽略了」这件事，此前分散在三条各自为政的路上——
// HTTP 回传路由喂校准器、对话内反馈喂节律、通知按钮谁也不喂。同一个动作从不同面
// 发生，学习信号就只从不同面产生，谁也调不准。
//
// 现在只有一条路：管道写库后发 `proactive.outcome` hook，本模块是唯一订阅方，
// 在这里分发给各学习器。各模块不再自己监听各自的回调，也不再由路由代喂。
//
// 口径：**只认用户真表过态的** outcome。delivered / viewed / opened 是展示事实，
// 进分母只会稀释信号（与 outcome-store 的 DECIDED_OUTCOMES 同一口径）。
import type { HookBus } from "../services/hooks/hook-bus.js";
import type { ReminderFeedbackOutcome } from "../rhythm/types.js";

/** 与 outcome-store.ts 的 DECIDED_OUTCOMES、rhythm 的 ReminderFeedbackOutcome 同一套词表 */
const DECIDED: ReadonlySet<string> = new Set([
  "accepted",
  "replied",
  "snoozed",
  "dismissed",
  "ignored",
]);

export type OutcomeFanoutDeps = {
  /** alert 档阈值呼吸（CostCalibrator.observe） */
  calibrate?: (outcome: string) => void;
  /** 节律接受度：把「这条主动消息被怎么对待」记成一次接触反馈 */
  contactOutcome?: (actorId: string, outcome: ReminderFeedbackOutcome, at: Date) => void;
  /** 提醒槽位时刻自适应（只在能定位到具体日程时才有意义） */
  reminderSlot?: (actorId: string, taskId: string, outcome: ReminderFeedbackOutcome, at: Date) => void | Promise<void>;
};

export function subscribeProactiveOutcomeFanout(
  hookBus: HookBus,
  deps: OutcomeFanoutDeps,
): () => void {
  return hookBus.subscribeType("proactive.outcome", (event) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const outcome = typeof data.outcome === "string" ? data.outcome : "";
    if (!DECIDED.has(outcome)) return;
    const actorId = typeof event.actorId === "string" ? event.actorId : "";
    const at = typeof data.at === "number" ? new Date(data.at) : new Date();
    const decided = outcome as ReminderFeedbackOutcome;

    try {
      deps.calibrate?.(outcome);
    } catch {
      /* 校准失败不影响其余下游 */
    }
    if (!actorId) return;
    try {
      deps.contactOutcome?.(actorId, decided, at);
    } catch {
      /* 节律未装配 / 抛错都不该吞掉后面的槽位学习 */
    }
    // 提醒槽位：只有带业务实体 ref 的投递（到点提醒的「完成 / 推迟」）能归到具体日程
    const ref = typeof data.ref === "string" ? data.ref : "";
    if (!ref || !deps.reminderSlot) return;
    try {
      void Promise.resolve(deps.reminderSlot(actorId, ref, decided, at)).catch(() => {});
    } catch {
      /* 槽位学习失败忽略 */
    }
  });
}
