// 时间展示：存绝对时刻，读的时候才渲染成相对时间。
//
// 面板 JSON / 判断提示词里的时间若存成「今天 10:32」这类字符串，跨过午夜就会说谎；
// 所以所有持久化字段都是 epoch ms，展示一律走这里。

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 相对日期 + 钟点：今天 10:32 / 昨天 21:05 / 明天 09:00 / 10月26日 08:00 / 2025年3月2日 */
export function formatRelativeClock(ms: number, now: number): string {
  const today = dayKey(now);
  const target = dayKey(ms);
  if (target === today) return `今天 ${clockOf(ms)}`;
  const dayDiff = Math.round((Date.parse(`${target}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / DAY);
  if (dayDiff === -1) return `昨天 ${clockOf(ms)}`;
  if (dayDiff === 1) return `明天 ${clockOf(ms)}`;
  const d = new Date(ms);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clockOf(ms)}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clockOf(ms)}`;
}

/** 离目标还有多久 / 过去多久：还有 14 小时、已过 8 分钟、刚刚 */
export function formatDistance(ms: number, now: number): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  if (abs < MINUTE) return "刚刚";
  const prefix = delta > 0 ? "还有" : "已过";
  if (abs < HOUR) return `${prefix} ${Math.round(abs / MINUTE)} 分钟`;
  if (abs < DAY) return `${prefix} ${Math.round(abs / HOUR)} 小时`;
  if (abs < 7 * DAY) return `${prefix} ${Math.round(abs / DAY)} 天`;
  return delta > 0 ? "还有很久" : "很久以前";
}

/** 目录行里的一行时间：今天 10:32（还有 3 小时） */
export function formatWhen(ms: number, now: number): string {
  return `${formatRelativeClock(ms, now)}（${formatDistance(ms, now)}）`;
}
