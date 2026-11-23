// 手机时机档位与打断成本（2026-11-23 主动触达 M1，需求文档 §3.7）。
//
// 为什么要单独一个文件：这张表是「手机状态下划线 → 数字」的唯一口径，
// presence-service（判档）、arbiter-v2（算成本）、diagnostics（解释「为什么现在不说」）
// 都要用，放任何一处都会造成另两处反向依赖。
//
// 成本 0–10，与 arbiter-v2 的 COST_WEIGHTS 同一量纲：
//   ≤3 直接放行、alert 档 ≤alertMid(默认 4.5) 放行、更高则挂起等停顿。
// 所以 phone_recent(4) 落在「普通消息等一等、重要消息照发」这一档，
// phone_away(5) 以上非重要消息就会挂起。
export type PhoneGrade =
  /** 解锁中、最近 2min 有交互 —— 最佳时机 */
  | "phone_active"
  /** 锁屏 < 15min —— 刚放下，还在手边 */
  | "phone_recent"
  /** 锁屏 > 15min，非夜间 —— 通知能看到，但不是即时 */
  | "phone_away"
  /** 通话中 —— 只放 must */
  | "in_call"
  /** 系统勿扰开启 —— 只放 must，且尊重系统 */
  | "dnd"
  /** 夜间 + 充电 + 锁屏 > 30min —— 只放 must */
  | "sleeping";

export const PHONE_GRADE_COST: Record<PhoneGrade, number> = {
  phone_active: 2,
  phone_recent: 4,
  phone_away: 5,
  in_call: 9,
  dnd: 10,
  sleeping: 10,
};

/** 手机档位 → 人话（诊断接口与「为什么」解释用） */
export const PHONE_GRADE_LABEL: Record<PhoneGrade, string> = {
  phone_active: "正在用手机",
  phone_recent: "刚放下手机",
  phone_away: "手机锁屏在手边外",
  in_call: "通话中",
  dnd: "开了勿扰",
  sleeping: "像在睡觉",
};
