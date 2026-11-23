/**
 * 待办块的权威读取（2026-11-12）
 *
 * 背景：`memory_open_loops` / `memory_commitments` 两个 KV 槽已停写，
 * 待办的权威源是 `agentic_memory.db#commitments`（状态机 + 截止时间）。
 * 本模块负责把这批行渲染成 prompt 块，替代原来的 KV 槽。
 *
 * 设计：
 *   - 纯函数 `renderCommitmentBlock(rows, now)` 负责格式化，可单测；
 *   - `loadActiveCommitments()` 负责查库，失败/不可用返回空（零注入，不阻塞本轮）；
 *   - 30s 缓存，避免每轮打库。
 */

import { openAgenticSqlite } from "../agentic-memory/sqlite-store.js";

export type CommitmentRow = {
  id: string;
  text: string;
  deadline: string | null;
  createdAt: string;
  category?: string | null;
};

const MAX_ITEMS = 3;
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; value: CommitmentRow[] }>();

/** 纯格式化：逾期优先，其次按截止时间升序，无截止最后。 */
export function renderCommitmentBlock(rows: readonly CommitmentRow[], now = Date.now()): string | undefined {
  if (rows.length === 0) return undefined;
  const scored = rows
    .map((r) => {
      const due = r.deadline ? Date.parse(r.deadline) : NaN;
      const overdueDays = Number.isFinite(due) && due < now ? Math.floor((now - due) / 86_400_000) : 0;
      return { r, due: Number.isFinite(due) ? due : Number.POSITIVE_INFINITY, overdueDays };
    })
    .sort((a, b) => {
      if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
      return a.due - b.due;
    })
    .slice(0, MAX_ITEMS);

  const lines = scored.map(({ r, due, overdueDays }) => {
    const text = r.text.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!Number.isFinite(due)) return `- ${text}`;
    const day = new Date(due).toISOString().slice(5, 10).replace("-", "/");
    return overdueDays > 0 ? `- ${text}（已逾期 ${overdueDays} 天，截止 ${day}）` : `- ${text}（截止 ${day}）`;
  });
  return lines.join("\n");
}

/**
 * 【待办与承诺】只放**要去做的事**。§3.5 的跟进事件（source='follow_up'，同一张
 * commitments 表 kind='follow_up' 的行）不注入这里：它的到期时刻总是最近，混进来会
 * 把真待办挤出 top3，而跟进的开口由触点计划经统一管道负责，不需要模型自己想起来。
 */
function query(actorId: string): CommitmentRow[] {  const db = openAgenticSqlite();
  try {
    const rows = db
      .prepare(
        `SELECT id, text, deadline, created_at as createdAt, category
         FROM commitments
         WHERE actor_id = ? AND status = 'active'
           AND source <> 'follow_up'
         ORDER BY COALESCE(deadline, '9999') ASC, created_at DESC
         LIMIT ?`,
      )
      .all(actorId, MAX_ITEMS * 3) as CommitmentRow[];
    return rows.filter((r) => r?.text?.trim());
  } finally {
    db.close();
  }
}

/** 查库 + 缓存；任何异常返回空（待办不可用不应影响本轮对话）。 */
export function getActiveCommitments(actorId: string, now = Date.now()): CommitmentRow[] {
  const hit = cache.get(actorId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = query(actorId);
    cache.set(actorId, { at: now, value });
    return value;
  } catch (err) {
    console.log(`[commitments] 查询失败（按无待办处理）: ${err}`);
    cache.set(actorId, { at: now, value: [] });
    return [];
  }
}

/** prompt 入口：无待办返回 undefined（零注入）。 */
export function buildCommitmentPrompt(actorId: string, now = Date.now()): string | undefined {
  return renderCommitmentBlock(getActiveCommitments(actorId, now), now);
}

/** 测试与写入后失效用。 */
export function invalidateCommitmentCache(actorId?: string): void {
  if (actorId) cache.delete(actorId);
  else cache.clear();
}
