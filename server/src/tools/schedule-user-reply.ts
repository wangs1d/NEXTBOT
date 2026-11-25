/**
 * 到点提醒展示文案（2026-11-25 用户定调）：文案只由模型在创建时写好，
 * 投递层不再二次改写口吻（此前对含「喊/叫/提醒」的文案套「该X啦」模板，
 * 产出「该闹钟喊醒我啦」类垃圾）。这里只做 trim 与空值兜底。
 */
export function formatReminderDisplayMessage(subject: string): string {
  return subject.trim() || "到点提醒";
}
