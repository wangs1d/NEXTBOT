/**
 * 任务完成系统推送（2026-11-24 用户拍板）。
 *
 * 任务在云端执行，杀掉手机 App 进程不影响结果落盘（appendTaskRecord 并入对话
 * thread，重开 App 拉历史可见）。缺口是「跑完那一刻用户不在线 → 没有弹窗」：
 * 用户要求任务跑完走手机系统推送通知，点开进 App 看历史。
 *
 * 语义（与 2026-11-24 删除全部重连兜底的定调一致）：
 *  - 在线已由 WS 直投送达 → 不推厂商通知，避免同一结果弹两遍；
 *  - 离线 → 推一次，厂商模板只放标题+短摘要（长结果看历史）；
 *  - 推送失败 → 记日志即丢弃，不入队、不重试、不等重连补投。
 *
 * 分层：只依赖 MobilePushService 的结构化接口，构造期晚绑定（proactivePushService
 * 在 bootstrap 下段才创建）。
 */

import type {
  PushAttemptResult,
  PushInput,
} from "../proactivity/mobile-push-service.js";

export type MobilePushPort = {
  hasChannel(actorId: string): boolean;
  push(input: PushInput): Promise<PushAttemptResult>;
};

export type TaskCompletionPushInput = {
  actorId: string;
  /** 任务结果正文（LLM 产物，可能很长；推送只取摘要） */
  text: string;
  /** 任务是否跑成；失败用不同通知标题 */
  ok?: boolean;
  /** WS 直投是否已把这一轮结果送达在线设备；true 则跳过厂商通知 */
  onlineDelivered: boolean;
};

export type TaskCompletionPushPort = (input: TaskCompletionPushInput) => void;

/** 厂商通知正文上限：锁屏横幅放不下长文，超出截断 */
const BODY_MAX_CHARS = 110;

/**
 * 从 LLM 结果里摘出适合厂商通知模板的短摘要：
 * 去代码块 / NEXT_UP 协议块 / Markdown 标记 / 换行，截前 110 字。
 */
export function taskCompletionPushSummary(raw: string): string {
  const flat = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[NEXT_[A-Z_]+[\s\S]*?\]/g, " ")
    .replace(/[#*`>|_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "点开看看结果";
  return flat.length > BODY_MAX_CHARS ? `${flat.slice(0, BODY_MAX_CHARS)}…` : flat;
}

/**
 * 构造任务完成推送端口。`getPush` 为晚绑定取值：无通道配置时是空操作，
 * 不阻断任务完成主链路。
 */
export function createTaskCompletionPush(
  getPush: () => MobilePushPort | null,
): TaskCompletionPushPort {
  let seq = 0;
  return (input) => {
    // 在线已送达 → 不重复弹厂商通知
    if (input.onlineDelivered) return;
    const push = getPush();
    if (!push?.hasChannel(input.actorId)) return;

    const deliveryId = `taskdone_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    void push
      .push({
        actorId: input.actorId,
        // 华为通道强制 title 非空（80100003 Illegal payload）
        title: input.ok === false ? "任务没跑成" : "任务跑完了",
        body: taskCompletionPushSummary(input.text),
        importance: "medium",
        // 华为自分类：任务类属「工作事项提醒」WORK（已在 KIND_CATEGORY 登记）
        kind: "task",
        deliveryId,
      })
      .then((result) => {
        if (!result.ok) {
          // 失败即丢弃：不重试、不入队、不等重连（2026-11-24 用户拍板）
          console.log(
            `[TaskCompletionPush] 推送失败（丢弃，不重试）actor=${input.actorId} provider=${result.provider} reason=${result.reason}`,
          );
        }
      })
      .catch((err) => {
        console.log(`[TaskCompletionPush] 推送异常（丢弃，不重试）actor=${input.actorId}: ${err}`);
      });
  };
}
