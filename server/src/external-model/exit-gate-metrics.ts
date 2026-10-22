/**
 * 出口闸触发率看板（2026-10-22，架构文档 L4 ·「每闸记触发率」红线）。
 *
 * 设计目的：闸是验钞机不是补丁机。某道闸持续高触发 = 上游（工具描述/常驻
 * 准入/prompt）有病，正确动作是回去改描述，**不是再加闸**。没有数字就
 * 没有这个闭环——本模块给每个 gateReason 记触发次数与独立会话数，并记
 * 完成轮数作为分母，触发率一算便知。
 *
 * 落盘：data/metrics/exit-gate-metrics.json（进程内计数 + 防抖写盘），
 * 重启后保留历史（按日分桶，30 天截断）。查询走 GET /metrics/exit-gate。
 *
 * 无依赖叶子模块：tool-loop 可安全 import，不成环。
 */
import fs from "node:fs";
import path from "node:path";

type ReasonStats = { count: number; sessions: Set<string> };

const fireByReason = new Map<string, ReasonStats>();
let turnsFinished = 0;
let startedAt = new Date().toISOString();

const DATA_FILE = path.resolve(
  process.cwd(),
  "data/metrics/exit-gate-metrics.json",
);
const KEEP_DAYS = 30;
const FLUSH_EVERY = 20;

/** 记录一次闸触发。 */
export function recordExitGateFire(reason: string, sessionId?: string): void {
  const stat = fireByReason.get(reason) ?? { count: 0, sessions: new Set<string>() };
  stat.count += 1;
  if (sessionId) stat.sessions.add(sessionId);
  fireByReason.set(reason, stat);
  if (turnsFinished > 0 && totalFires() % FLUSH_EVERY === 0) flush();
}

/** 记录一轮完成（分母：所有走过工具循环收尾的轮次）。 */
export function recordTurnFinished(): void {
  turnsFinished += 1;
  if (turnsFinished % FLUSH_EVERY === 0) flush();
}

function totalFires(): number {
  let n = 0;
  for (const s of fireByReason.values()) n += s.count;
  return n;
}

/** 只读快照（供 HTTP 端点与日志）。 */
export function snapshotExitGateMetrics(): {
  since: string;
  turnsFinished: number;
  totalFires: number;
  fireRate: string;
  byReason: Array<{ reason: string; count: number; sessions: number; rateOfTurns: string }>;
} {
  const byReason = [...fireByReason.entries()]
    .map(([reason, s]) => ({
      reason,
      count: s.count,
      sessions: s.sessions.size,
      rateOfTurns: turnsFinished > 0 ? `${((s.count / turnsFinished) * 100).toFixed(1)}%` : "-",
    }))
    .sort((a, b) => b.count - a.count);
  const total = totalFires();
  return {
    since: startedAt,
    turnsFinished,
    totalFires: total,
    fireRate: turnsFinished > 0 ? `${((total / turnsFinished) * 100).toFixed(1)}%` : "-",
    byReason,
  };
}

/** 同步落盘（按日分桶，KEEP_DAYS 截断）。失败静默——看板不能影响主链路。 */
function syncFlush(): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    let history: Record<string, unknown> = {};
    if (fs.existsSync(DATA_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, unknown>;
      } catch {
        history = {};
      }
    }
    const days = Object.keys(history)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
      .slice(-KEEP_DAYS + 1);
    const next: Record<string, unknown> = {};
    for (const k of days) next[k] = history[k];
    next[day] = {
      since: startedAt,
      turnsFinished,
      byReason: Object.fromEntries(
        [...fireByReason.entries()].map(([r, s]) => [r, { count: s.count }]),
      ),
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 1), "utf8");
  } catch {
    /* 落盘失败静默 */
  }
}

function flush(): void {
  syncFlush();
}

process.on("exit", () => {
  if (totalFires() > 0 || turnsFinished > 0) syncFlush();
});
