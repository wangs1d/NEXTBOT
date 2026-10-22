/**
 * 专注台账（本地 localStorage，按日期隔离）— FocusBoard 与打卡卡共用。
 * 只存事实（起止时间 + 分钟数），不做任何推测。
 */

export interface FocusBlock {
  start: number;
  end: number;
  minutes: number;
}

const STORE_KEY = "pai_focus_blocks_v1";

export const todayKey = (): string => new Date().toISOString().slice(0, 10);

export function loadTodayBlocks(): FocusBlock[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, FocusBlock[]>;
    const list = all[todayKey()];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveTodayBlock(block: FocusBlock): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, FocusBlock[]>;
    const key = todayKey();
    all[key] = [...(all[key] ?? []), block].slice(-48);
    // 只保留最近 7 天，避免无限增长
    const keys = Object.keys(all).sort().slice(-7);
    const trimmed: Record<string, FocusBlock[]> = {};
    for (const k of keys) trimmed[k] = all[k];
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch {
    /* 存储失败不阻塞计时 */
  }
}

/** 今日汇总（打卡卡 / 板头共用） */
export function todayStats(): { focusMinutes: number; sessions: number } {
  const blocks = loadTodayBlocks();
  return {
    focusMinutes: blocks.reduce((acc, b) => acc + b.minutes, 0),
    sessions: blocks.length,
  };
}
