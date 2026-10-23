/**
 * ToolCallGuard —— 敏感工具（金额/不可逆）的持久幂等 + 审计卫士。
 *
 * 缺口闭合（2026-09-19）：
 *   1. 幂等：此前写操作只有"轮内去重"（用完即丢）+ 内存 TTL 缓存（重启丢失），
 *      依赖 60s 结果缓存的跨轮重试（升级重跑/exit gate 续跑）在窗口外可能
 *      重复下单/重复转账。现在：money/irreversible 类工具同 actor+工具+参数
 *      的成功结果在 TTL 内（默认 10min，env TOOL_IDEMPOTENCY_TTL_MS）持久拦截，
 *      直接回放上次结果并附 guardNote（模型据此如实告知用户"刚办过，未重复执行"）。
 *   2. 审计：敏感工具此前只有 token 遥测，args/结果不留痕，出事无法回溯。
 *      现在每次调用（成功+失败）追加 tool-audit.ndjson（参数值脱敏）。
 *
 * 数据源：data/tool-guard/（idempotency.json 写穿原子替换；audit.ndjson 追加+轮转）。
 * 判级：services/tool-risk.ts 的 classifyToolRisk（单一口径）。
 */
import { getDataDir } from "../config/data-dir.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { classifyToolRisk, isSensitiveTool } from "./tool-risk.js";
import { readJson, writeJson } from "../proactivity/persist-file.js";

export type ToolGuardReplay = { result: Record<string, unknown>; enqueuedAt: number };

type IdempotencyEntry = { expiresAt: number; result: Record<string, unknown> };

const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IDEMPOTENCY_ENTRIES = 500;
/** 审计/幂等只对 money/irreversible 生效；write 类量太大且无资金风险 */
export { isSensitiveTool };

export type ToolCallGuardOptions = {
  dirPath: string;
  nowFn?: () => number;
};

/** 参数键名命中即脱敏（值替换为 ***） */
const REDACT_ARG_KEY_RE = /password|passwd|secret|token|otp|验证码|authorization|credential|pin|cvv/i;

export class ToolCallGuard {
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly nowFn: () => number;
  private readonly idempotencyPath: string;
  private readonly auditPath: string;
  private readonly ttlMs: number;

  constructor(private readonly opts: ToolCallGuardOptions) {
    this.nowFn = opts.nowFn ?? Date.now;
    this.idempotencyPath = join(opts.dirPath, "idempotency.json");
    this.auditPath = join(opts.dirPath, "tool-audit.ndjson");
    const parsed = Number.parseInt(process.env.TOOL_IDEMPOTENCY_TTL_MS ?? "", 10);
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000;
    this.restore();
  }

  private restore(): void {
    const raw = readJson<Record<string, IdempotencyEntry>>(this.idempotencyPath, {});
    const now = this.nowFn();
    let restored = 0;
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object" || entry.expiresAt <= now) continue;
      this.idempotency.set(key, entry);
      restored += 1;
    }
    if (restored > 0) console.log(`[ToolCallGuard] 幂等表已恢复 ${restored} 条`);
  }

  /** 幂等窗口（分钟，诊断展示用） */
  ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }

  /**
   * 幂等查询：TTL 内同 actor+工具+参数 的成功调用 → 回放上次结果。
   * 仅对 money/irreversible 生效；过期/超量条目顺手清理。
   */
  checkReplay(actorId: string, tool: string, args: Record<string, unknown>): ToolGuardReplay | null {
    if (!isSensitiveTool(tool)) return null;
    const now = this.nowFn();
    for (const [k, v] of this.idempotency) if (v.expiresAt <= now) this.idempotency.delete(k);
    const entry = this.idempotency.get(this.key(actorId, tool, args));
    if (!entry || entry.expiresAt <= now) return null;
    return { result: { ...entry.result }, enqueuedAt: entry.expiresAt - this.ttlMs };
  }

  /** 执行后记账：敏感工具审计全量（成败都记），幂等只记成功 */
  record(
    actorId: string,
    tool: string,
    args: Record<string, unknown>,
    ok: boolean,
    result: Record<string, unknown>,
  ): void {
    if (!isSensitiveTool(tool)) return;
    const at = this.nowFn();
    this.appendAudit({ at, actorId, tool, risk: classifyToolRisk(tool), ok, args: redactArgs(args), result });
    if (!ok) return;
    this.idempotency.set(this.key(actorId, tool, args), { expiresAt: at + this.ttlMs, result: snapshot(result) });
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest === undefined) break;
      this.idempotency.delete(oldest);
    }
    writeJson(this.idempotencyPath, Object.fromEntries(this.idempotency));
  }

  private key(actorId: string, tool: string, args: Record<string, unknown>): string {
    return `${actorId}::${tool}::${stableStringify(args)}`;
  }

  private appendAudit(rec: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      if (existsSync(this.auditPath) && statSync(this.auditPath).size > AUDIT_LOG_MAX_BYTES) {
        try {
          renameSync(this.auditPath, `${this.auditPath}.1`);
        } catch {
          /* 轮转失败继续追加 */
        }
      }
      appendFileSync(this.auditPath, `${JSON.stringify(rec)}\n`);
    } catch {
      /* 审计失败不影响主链路 */
    }
  }
}

/** 参数脱敏：键名命中 REDACT_ARG_KEY_RE → *** ；其余 JSON 原样（截断防超大） */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (REDACT_ARG_KEY_RE.test(k)) {
      out[k] = "***";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactArgs(v as Record<string, unknown>);
    } else {
      out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
    }
  }
  return out;
}

/** 稳定序列化：键递归排序，同参数同键（跨轮/跨进程一致） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function snapshot(result: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  } catch {
    return { ok: true };
  }
}

const globalForToolGuard = globalThis as unknown as { __toolCallGuard?: ToolCallGuard };

/** 进程级单例（data/tool-guard/ 为持久化根目录）。 */
export function getToolCallGuard(): ToolCallGuard {
  globalForToolGuard.__toolCallGuard ??= new ToolCallGuard({
    dirPath: join(getDataDir(), "tool-guard"),
  });
  return globalForToolGuard.__toolCallGuard;
}
