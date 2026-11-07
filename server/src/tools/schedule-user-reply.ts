import { formatReminderMessage } from "../services/schedule-intent-service.js";

/** 到点提醒展示文案：补全过短的口语片段。 */
export function formatReminderDisplayMessage(subject: string): string {
  const s = subject.trim();
  if (!s) return "到点提醒";
  if (/[啦啊哦哟！!]$/.test(s)) return s;
  if (/^该.+[啦啊哦哟！!]?$/.test(s)) return s;
  if (s.length >= 3 && !/提醒|喊|叫/.test(s)) return s;
  return formatReminderMessage(s);
}
