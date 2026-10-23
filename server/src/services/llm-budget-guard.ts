import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/data-dir.js";

/**
 * LLM 预算闸门（BudgetGuard，2026-09-19 P1-2）。
 *
 * 背景：token 审计（llm-token-audit）只记不拦——失控会话（循环调用/后台任务
 * 风暴）没有任何闸门。本模块在审计打点处顺带记账，按 会话 / 用户·日 两个维度
 * 累计，阈值触发分级动作：
 *   - 80%：WARN 日志（每会话/日只告警一次）
 *   - 100%：EXCEEDED 标志——重活派发被拒（dispatchBackgroundTask）、任务面
 *     能力束全量注入退化为纯 Core；主对话永不硬断（助理不可用是更差的产品状态）
 *
 * 记账口径：优先 API usage 真实值（apiPrompt+apiCompletion），无 usage 时退
 * 估算值。与审计文件共享数据源但独立内存记账（读盘仅用于重启后恢复当日累计，
 * 尽力而为，丢了就从头计——宁可少记不多记）。
 *
 * 配置（env，0 = 关闭该维度）：
 *   AGENT_LLM_BUDGET_SESSION_TOKENS  会话上限，默认 500_000
 *   AGENT_LLM_BUDGET_DAILY_TOKENS    单用户单日上限，默认 2_000_000
 */

export type BudgetScope = "session" | "daily";

export type BudgetStatus = {
  scope: BudgetScope;
  key: string;
  usedTokens: number;
  limitTokens: number;
  /** none | warn(≥80%) | exceeded(≥100%) */
  level: "none" | "warn" | "exceeded";
};

/**
 * 告警出口（2026-09-28 上线护栏）：阈值命中（warn/exceeded 各一次）时回调。
 * budget-guard 本身零 DI，装配处注入（如站内信通知）；不设置则仅 console 告警。
 */
export type BudgetAlertSink = (status: BudgetStatus) => void;

let alertSink: BudgetAlertSink | null = null;

export function setBudgetAlertSink(sink: BudgetAlertSink | null): void {
  alertSink = sink;
}

function fireAlertSink(status: BudgetStatus): void {
  if (!alertSink) return;
  try {
    alertSink(status);
  } catch {
    // 告警出口故障不影响记账主流程
  }
}

const SESSION_LIMIT = envTokens("AGENT_LLM_BUDGET_SESSION_TOKENS", 500_000);
const DAILY_LIMIT = envTokens("AGENT_LLM_BUDGET_DAILY_TOKENS", 2_000_000);
const MAX_SESSIONS = 500;

/** sessionId/actorId → 累计 token */
const sessionBuckets = new Map<string, number>();
/** actorId|YYYY-MM-DD → 累计 token */
const dailyBuckets = new Map<string, number>();
/** 已告警标记（每 key 只 WARN 一次） */
const warnedKeys = new Set<string>();

function envTokens(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function classifyLevel(used: number, limit: number): "none" | "warn" | "exceeded" {
  if (limit <= 0) return "none";
  if (used >= limit) return "exceeded";
  if (used >= limit * 0.8) return "warn";
  return "none";
}

/**
 * 记账 + 阈值判定（llm-token-audit.recordLlmUsage 单点调用）。
 * @returns 命中 warn/exceeded 的维度列表（空数组 = 正常）
 */
export function recordBudgetUsage(input: {
  sessionId?: string;
  actorId?: string;
  tokens: number;
}): BudgetStatus[] {
  if (input.tokens <= 0) return [];
  const hit: BudgetStatus[] = [];
  const sessionKey = input.sessionId?.trim() || input.actorId?.trim() || "";
  const dailyKey = input.actorId?.trim()
    ? `${input.actorId.trim()}|${todayKey()}`
    : "";

  if (SESSION_LIMIT > 0 && sessionKey) {
    const used = (sessionBuckets.get(sessionKey) ?? 0) + input.tokens;
    sessionBuckets.set(sessionKey, used);
    if (sessionBuckets.size > MAX_SESSIONS) {
      // 淘汰最旧（Map 迭代序即插入序）：防长期运行内存膨胀
      const oldest = sessionBuckets.keys().next().value;
      if (oldest !== undefined) {
        sessionBuckets.delete(oldest);
        warnedKeys.delete(`session:warn:${oldest}`);
        warnedKeys.delete(`session:exceeded:${oldest}`);
      }
    }
    const level = classifyLevel(used, SESSION_LIMIT);
    if (level !== "none") {
      // 每 key 每档（warn/exceeded）只告警一次：80% 提示一次、100% 再提示一次
      const warnKey = `session:${level}:${sessionKey}`;
      if (!warnedKeys.has(warnKey)) {
        warnedKeys.add(warnKey);
        if (level === "warn") {
          console.warn(
            `[BudgetGuard] 会话 token 达 ${Math.round((used / SESSION_LIMIT) * 100)}%（${used}/${SESSION_LIMIT}）session=${sessionKey}`,
          );
        } else {
          console.warn(
            `[BudgetGuard] 会话 token 超限（${used}/${SESSION_LIMIT}），重活派发将被拒 session=${sessionKey}`,
          );
        }
        fireAlertSink({ scope: "session", key: sessionKey, usedTokens: used, limitTokens: SESSION_LIMIT, level });
      }
      hit.push({ scope: "session", key: sessionKey, usedTokens: used, limitTokens: SESSION_LIMIT, level });
    }
  }

  if (DAILY_LIMIT > 0 && dailyKey) {
    const used = (dailyBuckets.get(dailyKey) ?? 0) + input.tokens;
    dailyBuckets.set(dailyKey, used);
    if (dailyBuckets.size > MAX_SESSIONS) {
      const oldest = dailyBuckets.keys().next().value;
      if (oldest !== undefined) {
        dailyBuckets.delete(oldest);
        warnedKeys.delete(`daily:warn:${oldest}`);
        warnedKeys.delete(`daily:exceeded:${oldest}`);
      }
    }
    const level = classifyLevel(used, DAILY_LIMIT);
    if (level !== "none") {
      const warnKey = `daily:${level}:${dailyKey}`;
      if (!warnedKeys.has(warnKey)) {
        warnedKeys.add(warnKey);
        console.warn(
          `[BudgetGuard] 单日 token ${level === "exceeded" ? "超限" : "达告警线"}（${used}/${DAILY_LIMIT}）actor=${dailyKey}`,
        );
        fireAlertSink({ scope: "daily", key: dailyKey, usedTokens: used, limitTokens: DAILY_LIMIT, level });
      }
      hit.push({ scope: "daily", key: dailyKey, usedTokens: used, limitTokens: DAILY_LIMIT, level });
    }
  }
  return hit;
}

/** 会话维度是否超限（重活派发/全量注入的判定入口）。 */
export function isSessionBudgetExceeded(sessionId?: string, actorId?: string): boolean {
  const key = sessionId?.trim() || actorId?.trim() || "";
  if (SESSION_LIMIT <= 0 || !key) return false;
  return (sessionBuckets.get(key) ?? 0) >= SESSION_LIMIT;
}

/** 用户·日维度是否超限。 */
export function isDailyBudgetExceeded(actorId?: string): boolean {
  if (DAILY_LIMIT <= 0 || !actorId?.trim()) return false;
  return (dailyBuckets.get(`${actorId.trim()}|${todayKey()}`) ?? 0) >= DAILY_LIMIT;
}

/** 诊断快照（/api 或日志用）。 */
export function getBudgetSnapshot(sessionId?: string): {
  limits: { session: number; daily: number };
  trackedSessions: number;
  todaySessions: number;
  currentSession?: BudgetStatus;
} {
  const snapshot: ReturnType<typeof getBudgetSnapshot> = {
    limits: { session: SESSION_LIMIT, daily: DAILY_LIMIT },
    trackedSessions: sessionBuckets.size,
    todaySessions: dailyBuckets.size,
  };
  const key = sessionId?.trim();
  if (key) {
    const used = sessionBuckets.get(key) ?? 0;
    snapshot.currentSession = {
      scope: "session",
      key,
      usedTokens: used,
      limitTokens: SESSION_LIMIT,
      level: classifyLevel(used, SESSION_LIMIT),
    };
  }
  return snapshot;
}

/** 测试专用：清空记账。 */
export function resetBudgetGuardForTest(): void {
  sessionBuckets.clear();
  dailyBuckets.clear();
  warnedKeys.clear();
}

/** 重启后尽力恢复当日/近期累计（读审计 NDJSON 的最后 5000 行，丢了从头计）。 */
export function restoreBudgetFromAuditFile(): void {
  try {
    const base = process.env.PA_DATA_DIR?.trim() || getDataDir();
    const lines = readFileSync(join(base, "llm-token-audit.ndjson"), "utf8")
      .trim()
      .split("\n")
      .slice(-5000);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as {
          sessionId?: string;
          actorId?: string;
          apiPromptTokens?: number;
          apiCompletionTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
        };
        const apiTokens = (rec.apiPromptTokens ?? 0) + (rec.apiCompletionTokens ?? 0);
        const tokens = apiTokens > 0 ? apiTokens : (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0);
        if (tokens > 0) recordBudgetUsage({ sessionId: rec.sessionId, actorId: rec.actorId, tokens });
      } catch {
        /* 单行损坏忽略 */
      }
    }
  } catch {
    /* 审计文件缺失：从头计 */
  }
}
