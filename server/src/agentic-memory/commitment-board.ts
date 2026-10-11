/**
 * 方案 C：承诺草稿板（Commitment Board）。
 *
 * 与日程（schedule）不同：日程是「确定时间要发生的事」，由 ScheduleTaskService
 * 负责；承诺是「对话中某方答应了某事」的社会性契约——可能没有明确时间、
 * 可能依赖别的事项、违约需要升级提醒。本模块管承诺的生命周期：
 *
 *   candidate（低置信候选池）
 *     → pending_confirmation（自动提取 0.5-0.8，待下次对话轻量确认）
 *     → active（>0.8 直接创建 / 确认后 / 显式工具创建）
 *     → fulfilled | cancelled | broken（超时且升级次数耗尽）
 *
 * 双通道（用户决策 2026-09-04）：
 *   - 自动提取：ingest 写入钩子 → commitment-extractor LLM 识别 →
 *     ingestExtracted 按置信度分级落板，证据必须写入语义账本（方案 B）
 *     并回填 evidenceLedgerIds；
 *   - 显式工具：commitment.create/update/cancel/confirm/list（source=manual），
 *     先行实现，可独立测试。
 *
 * 扫描循环（缺省 5 分钟）：临近提醒（deadline - remindBeforeMin 内一次性提醒）、
 * 超时升级（deadline + escalateAfterMin 起反复升级，封顶 maxEscalations 后判
 * broken）、依赖检查（依赖的承诺未 fulfilled 则冻结提醒与升级）。
 * 提醒/升级事件经 notifier 回调发出（装配层接到 proactivity 投递），
 * 未注入时降级为控制台日志。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { getCommitmentScanIntervalMin, isCommitmentBoardEnabled } from "./env.js";
import { openAgenticSqlite, fromJsonColumn, toJsonColumn } from "./sqlite-store.js";
import type { AgenticLedger } from "./ledger.js";
import { semanticFingerprint } from "../services/memory-record-utils.js";

// ============================================================
// 类型
// ============================================================

export type CommitmentStatus =
  | "candidate"
  | "pending_confirmation"
  | "active"
  | "fulfilled"
  | "cancelled"
  | "broken"
  | "superseded";

export type CommittedBy = "user" | "agent" | "third_party";

/**
 * 第三方联系渠道（代催真实外发的目标地址）。channelId 来自 message-hub
 * 既有会话；外发经 MessagePlatformGateway（微信/QQ/飞书 HTTP bridge），
 * 未配置 bridge URL 时网关降级为本地排队（delivered=false）。
 */
export interface CommitmentContact {
  platform: "wechat" | "qq" | "feishu" | "generic";
  channelId: string;
  participantId?: string;
  participantName?: string;
}

export interface EscalationPolicy {
  /** 临近提醒提前量（分钟）；仅当未配置 remindBeforeMinTiers 时作为单一提醒档（兼容旧数据） */
  remindBeforeMin: number;
  /** 梯度提醒档位（分钟，降序）：每档进入 deadline-beforeMin 窗口后发一次，先温和后紧迫（如 24h 温和 / 2h 紧迫） */
  remindBeforeMinTiers: number[];
  /** 超时后升级间隔（分钟）；未配置 escalateAfterMinSchedule 时作为固定间隔 */
  escalateAfterMin: number;
  /** 升级退避节奏（分钟，按升级次数取值，末位兜底）：如 [60,360,1440] = 1h/6h/隔天，避免连环骚扰 */
  escalateAfterMinSchedule: number[];
  /** 最大升级次数；耗尽后判 broken */
  maxEscalations: number;
}

export interface CommitmentRecord {
  id: string;
  actorId: string;
  text: string;
  committedBy: CommittedBy;
  status: CommitmentStatus;
  /** ISO 截止时间；null = 无明确期限（不参与提醒/升级，仅依赖检查） */
  deadline: string | null;
  /** 依赖项（承诺 id 或外部引用；板上 id 未 fulfilled 视为阻塞） */
  dependencies: string[];
  escalationPolicy: EscalationPolicy;
  evidenceLedgerIds: string[];
  source: "auto" | "manual";
  confidence: number | null;
  /** 承诺类别（报价/交付/会面/转账…自动提取产出或手动指定），经验学习按类聚合作弊者 */
  category: string | null;
  reminderSentAt: string | null;
  /** 已发送的梯度提醒档位（分钟值），每档只发一次 */
  reminderTiersSent: number[];
  /** 待确认承诺的确认提醒发送时间（一次性，confirm_reminder 防重） */
  confirmReminderSentAt: string | null;
  escalationCount: number;
  lastEscalatedAt: string | null;
  dependencyBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  brokenAt: string | null;
  /** 证据被作废（用户否认/来源撤回）时的时间戳——幽灵幻觉治理的终点标记 */
  supersededAt: string | null;
  notes: string | null;
  /** 第三方承诺的联系渠道（third_party 且需代催时登记；manual create/update 通道写入） */
  contact: CommitmentContact | null;
}

export type CommitmentEventType =
  | "reminder"
  | "confirm_reminder"
  | "escalation"
  | "broken"
  | "pending_expired"
  | "dependency_unblocked"
  | "dependency_blocked"
  | "deadline_shifted";

export interface CommitmentEvent {
  type: CommitmentEventType;
  commitment: CommitmentRecord;
  message: string;
  /** 提醒语气档（gradient reminder）：先温和后紧迫 */
  tone?: "gentle" | "urgent";
  at: string;
}

export type CommitmentNotifier = (event: CommitmentEvent) => void;

/**
 * 承诺 → 日程物化出口（装配层注入；程序层单向桥，日程侧失败只记日志不回传）。
 * 分工定调：承诺板管召回与催办（梯度提前提醒/超时升级），日程只负责
 * 「到点那一响」与展示面（今日安排/冲突检测/早报）——见 commitment-schedule-outlet.ts。
 */
export type CommitmentScheduleOutlet = {
  /** active 且 deadline 有效时物化/改期（幂等）；返回 taskId，未物化返回 null。 */
  upsertFromCommitment(record: CommitmentRecord): Promise<string | null>;
  /** 承诺进入终态或撤掉期限时，撤下已物化的日程。 */
  withdrawFromCommitment(record: CommitmentRecord): Promise<void>;
  /**
   * 时基下发（可选）：承诺板注入时把自身时钟传给出口，
   * 保证出口的「未来时间闸」与板扫描同一时基。
   */
  setNow?(now: () => Date): void;
};

export interface CommitmentCreateInput {
  actorId: string;
  text: string;
  committedBy: CommittedBy;
  deadline?: string | null;
  dependencies?: string[];
  escalationPolicy?: Partial<EscalationPolicy>;
  evidenceLedgerIds?: string[];
  source?: "auto" | "manual";
  confidence?: number | null;
  category?: string | null;
  notes?: string | null;
  /** 自动提取通道的初始状态（缺省 active；提取器按置信度传入） */
  status?: CommitmentStatus;
  /** 第三方联系渠道（代催外发目标；缺省 null = 只提醒用户不代发） */
  contact?: CommitmentContact | null;
}

/** 自动提取的原始承诺（LLM 输出，见 commitment-extractor.ts） */
export interface ExtractedCommitment {
  text: string;
  committedBy: CommittedBy;
  deadline: string | null;
  confidence: number;
  evidence: string;
  /** 承诺类别（报价/交付/会面/转账/其他），缺失时归 "其他" */
  category?: string;
}

export interface CommitmentScanReport {
  scanned: number;
  reminders: number;
  /** 本轮发出的待确认承诺确认提醒数（confirm_reminder） */
  confirmReminders: number;
  escalations: number;
  broken: number;
  pendingExpired: number;
  unblocked: number;
  /** 本轮新被发现阻塞的承诺数 */
  blocked: number;
}

interface CommitmentRow {
  id: string;
  actor_id: string;
  text: string;
  committed_by: string;
  status: string;
  deadline: string | null;
  dependencies: string;
  escalation_policy: string;
  evidence_ledger_ids: string;
  source: string;
  confidence: number | null;
  category: string | null;
  reminder_sent_at: string | null;
  reminder_tiers_sent: string;
  confirm_reminder_sent_at: string | null;
  escalation_count: number;
  last_escalated_at: string | null;
  dependency_blocked: number;
  created_at: string;
  updated_at: string;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  broken_at: string | null;
  superseded_at: string | null;
  notes: string | null;
  contact: string | null;
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  remindBeforeMin: 30,
  // 梯度提醒（用户规格 2026-09-04）：deadline 前 24h 温和提醒 + 2h 紧迫提醒，超时再升级
  remindBeforeMinTiers: [1440, 120],
  escalateAfterMin: 60,
  // 升级退避：1h → 6h → 隔天，避免连环骚扰
  escalateAfterMinSchedule: [60, 360, 1440],
  maxEscalations: 3,
};

const TERMINAL_STATUSES: ReadonlySet<CommitmentStatus> = new Set([
  "fulfilled",
  "cancelled",
  "broken",
  "superseded",
]);

function toRecord(row: CommitmentRow): CommitmentRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    text: row.text,
    committedBy: row.committed_by as CommittedBy,
    status: row.status as CommitmentStatus,
    deadline: row.deadline,
    dependencies: fromJsonColumn<string[]>(row.dependencies, []),
    escalationPolicy: {
      ...DEFAULT_ESCALATION_POLICY,
      ...fromJsonColumn<Partial<EscalationPolicy>>(row.escalation_policy, {}),
    },
    evidenceLedgerIds: fromJsonColumn<string[]>(row.evidence_ledger_ids, []),
    source: row.source === "auto" ? "auto" : "manual",
    confidence: row.confidence,
    category: row.category,
    reminderSentAt: row.reminder_sent_at,
    reminderTiersSent: fromJsonColumn<number[]>(row.reminder_tiers_sent, []),
    confirmReminderSentAt: row.confirm_reminder_sent_at,
    escalationCount: row.escalation_count,
    lastEscalatedAt: row.last_escalated_at,
    dependencyBlocked: row.dependency_blocked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fulfilledAt: row.fulfilled_at,
    cancelledAt: row.cancelled_at,
    brokenAt: row.broken_at,
    supersededAt: row.superseded_at,
    notes: row.notes,
    contact: fromJsonColumn<CommitmentContact | null>(row.contact, null),
  };
}

let idSeq = 0;

function nextCommitmentId(): string {
  idSeq = (idSeq + 1) % 100000;
  return `cmt_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** 截止时间解析：空/缺省 → null；非法 → error（创建时也接受已过去，便于补录） */
type DeadlineParse = { ok: true; value: string | null } | { ok: false; error: string };

function parseDeadline(raw: string | null | undefined): DeadlineParse {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true, value: null };
  const ts = Date.parse(String(raw));
  if (!Number.isFinite(ts)) return { ok: false, error: `deadline 无法解析为时间：${String(raw)}` };
  return { ok: true, value: new Date(ts).toISOString() };
}

// ============================================================
// 主服务
// ============================================================

export class CommitmentBoard {
  private readonly db: SqliteDatabase;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private notifier: CommitmentNotifier | null = null;
  private scheduleOutlet: CommitmentScheduleOutlet | null = null;

  constructor(
    db?: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        committed_by TEXT NOT NULL,
        status TEXT NOT NULL,
        deadline TEXT,
        dependencies TEXT NOT NULL DEFAULT '[]',
        escalation_policy TEXT NOT NULL,
        evidence_ledger_ids TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        confidence REAL,
        category TEXT,
        reminder_sent_at TEXT,
        reminder_tiers_sent TEXT NOT NULL DEFAULT '[]',
        confirm_reminder_sent_at TEXT,
        escalation_count INTEGER NOT NULL DEFAULT 0,
        last_escalated_at TEXT,
        dependency_blocked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        fulfilled_at TEXT,
        cancelled_at TEXT,
        broken_at TEXT,
        superseded_at TEXT,
        notes TEXT,
        contact TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_scan ON commitments(status);
      CREATE INDEX IF NOT EXISTS idx_commitments_actor ON commitments(actor_id, status);
    `);
    // 旧库列迁移（gradient reminder / superseded 为后加列）
    const existingCols = new Set(
      (this.db.prepare(`PRAGMA table_info(commitments)`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    if (!existingCols.has("reminder_tiers_sent")) {
      this.db.exec(`ALTER TABLE commitments ADD COLUMN reminder_tiers_sent TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!existingCols.has("superseded_at")) {
      this.db.exec(`ALTER TABLE commitments ADD COLUMN superseded_at TEXT`);
    }
    if (!existingCols.has("category")) {
      this.db.exec(`ALTER TABLE commitments ADD COLUMN category TEXT`);
    }
    if (!existingCols.has("confirm_reminder_sent_at")) {
      this.db.exec(`ALTER TABLE commitments ADD COLUMN confirm_reminder_sent_at TEXT`);
    }
    if (!existingCols.has("contact")) {
      this.db.exec(`ALTER TABLE commitments ADD COLUMN contact TEXT`);
    }
  }

  close(): void {
    this.stopScan();
    this.db.close();
  }

  /** 注入提醒/升级出口（装配层接 proactivity 投递；未注入时降级日志） */
  setNotifier(notifier: CommitmentNotifier | null): void {
    this.notifier = notifier;
  }

  /** 注入日程物化出口（装配层接 ScheduleTaskService；未注入时承诺不落日程，行为不变） */
  setScheduleOutlet(outlet: CommitmentScheduleOutlet | null): void {
    this.scheduleOutlet = outlet;
    // 时基对齐：出口的「未来时间闸」必须跟着板的时钟走。
    // 否则装配层给板注入了冻结时钟、出口却偷读真实时钟时，
    // 真实时间越过 fixture 日期后所有承诺静默不物化（且只有一行 error 日志）。
    try {
      outlet?.setNow?.(this.now);
    } catch (err) {
      console.error("[commitment-board] 出口时基下发失败（忽略）:", err);
    }
  }

  private emit(
    type: CommitmentEventType,
    commitment: CommitmentRecord,
    message: string,
    tone?: "gentle" | "urgent",
  ): void {
    const event: CommitmentEvent = { type, commitment, message, ...(tone ? { tone } : {}), at: this.now().toISOString() };
    if (this.notifier) {
      try {
        this.notifier(event);
      } catch (err) {
        console.error("[commitment-board] notifier 抛错（忽略）:", err);
      }
    } else {
      console.info(`[commitment-board] ${type}: ${message}`);
    }
  }

  // ------------------------------------------------------------
  // CRUD（显式工具通道 + 状态机）
  // ------------------------------------------------------------

  create(input: CommitmentCreateInput): CommitmentRecord | { error: string } {
    const text = input.text?.trim();
    if (!text) return { error: "承诺内容（text）不能为空" };
    if (!input.actorId) return { error: "actorId 不能为空" };
    if (!["user", "agent", "third_party"].includes(input.committedBy)) {
      return { error: `committedBy 必须是 user/agent/third_party，收到 ${input.committedBy}` };
    }

    const deadlineParsed = parseDeadline(input.deadline);
    if (!deadlineParsed.ok) return { error: deadlineParsed.error };
    const deadline = deadlineParsed.value;

    const nowIso = this.now().toISOString();
    const record: CommitmentRecord = {
      id: nextCommitmentId(),
      actorId: input.actorId,
      text,
      committedBy: input.committedBy,
      status: input.status ?? "active",
      deadline: deadline as string | null,
      dependencies: [...new Set(input.dependencies ?? [])],
      escalationPolicy: this.defaultPolicyFor(
        input.actorId,
        input.committedBy,
        input.escalationPolicy,
        input.category,
      ),
      evidenceLedgerIds: input.evidenceLedgerIds ?? [],
      source: input.source ?? "manual",
      confidence:
        typeof input.confidence === "number" && Number.isFinite(input.confidence)
          ? Math.max(0, Math.min(1, input.confidence))
          : null,
      category: input.category?.trim() || null,
      reminderSentAt: null,
      reminderTiersSent: [],
      confirmReminderSentAt: null,
      escalationCount: 0,
      lastEscalatedAt: null,
      dependencyBlocked: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      fulfilledAt: null,
      cancelledAt: null,
      brokenAt: null,
      supersededAt: null,
      notes: input.notes ?? null,
      contact: input.contact ?? null,
    };

    this.insert(record);
    this.syncScheduleOutlet(null, record);
    return record;
  }

  private insert(record: CommitmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO commitments
           (id, actor_id, text, committed_by, status, deadline, dependencies, escalation_policy,
            evidence_ledger_ids, source, confidence, category, reminder_sent_at, reminder_tiers_sent,
            confirm_reminder_sent_at, escalation_count, last_escalated_at, dependency_blocked,
            created_at, updated_at, fulfilled_at, cancelled_at, broken_at, superseded_at, notes, contact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.actorId,
        record.text,
        record.committedBy,
        record.status,
        record.deadline,
        toJsonColumn(record.dependencies) ?? "[]",
        toJsonColumn(record.escalationPolicy) ?? "{}",
        toJsonColumn(record.evidenceLedgerIds) ?? "[]",
        record.source,
        record.confidence,
        record.category,
        record.reminderSentAt,
        toJsonColumn(record.reminderTiersSent) ?? "[]",
        record.confirmReminderSentAt,
        record.escalationCount,
        record.lastEscalatedAt,
        record.dependencyBlocked ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.fulfilledAt,
        record.cancelledAt,
        record.brokenAt,
        record.supersededAt,
        record.notes,
        toJsonColumn(record.contact) ?? null,
      );
  }

  get(id: string): CommitmentRecord | null {
    const row = this.db.prepare(`SELECT * FROM commitments WHERE id = ?`).get(id) as
      | CommitmentRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  /** 更新可变字段（text/deadline/dependencies/policy/notes/contact）。状态流转走专用方法。 */
  update(
    id: string,
    fields: {
      text?: string;
      deadline?: string | null;
      dependencies?: string[];
      escalationPolicy?: Partial<EscalationPolicy>;
      notes?: string | null;
      contact?: CommitmentContact | null;
    },
  ): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (TERMINAL_STATUSES.has(existing.status)) {
      return { error: `承诺已处于终态 ${existing.status}，不可更新` };
    }

    let deadline = existing.deadline;
    const oldDeadline = existing.deadline;
    if (fields.deadline !== undefined) {
      const parsed = parseDeadline(fields.deadline);
      if (!parsed.ok) return { error: parsed.error };
      deadline = parsed.value;
      // 期限变更后重置提醒（含梯度档/确认提醒）/升级计时，避免旧期限的已提醒状态卡住新期限
      existing.reminderSentAt = null;
      existing.reminderTiersSent = [];
      existing.confirmReminderSentAt = null;
      existing.lastEscalatedAt = null;
    }

    const next: CommitmentRecord = {
      ...existing,
      ...(fields.text !== undefined && fields.text.trim() ? { text: fields.text.trim() } : {}),
      deadline,
      dependencies:
        fields.dependencies !== undefined
          ? [...new Set(fields.dependencies)]
          : existing.dependencies,
      escalationPolicy:
        fields.escalationPolicy !== undefined
          ? { ...existing.escalationPolicy, ...fields.escalationPolicy }
          : existing.escalationPolicy,
      notes: fields.notes !== undefined ? fields.notes : existing.notes,
      contact: fields.contact !== undefined ? fields.contact : existing.contact,
      updatedAt: this.now().toISOString(),
    };
    this.persist(next);
    // 延期传播（用户规格 2026-09-04）：上游改期 → 依赖它的承诺按原有时差自动顺延
    if (
      oldDeadline !== null &&
      next.deadline !== null &&
      Date.parse(next.deadline) > Date.parse(oldDeadline)
    ) {
      this.propagateDeadlineFrom(next, Date.parse(next.deadline) - Date.parse(oldDeadline));
    }
    return next;
  }

  /**
   * 延期传播：沿依赖有向图把「上游延期 deltaMs」传递给下游——
   * 下游新 deadline = 原 deadline + delta，只顺延不提前；逐级传递（A→B→C）。
   * visited 防环；板上不存在的依赖引用（外部 id）跳过。
   */
  private propagateDeadlineFrom(shifted: CommitmentRecord, deltaMs: number): CommitmentRecord[] {
    if (deltaMs <= 0) return [];
    const results: CommitmentRecord[] = [];
    const visited = new Set<string>([shifted.id]);
    let queue: Array<{ record: CommitmentRecord; deltaMs: number }> = [{ record: shifted, deltaMs }];

    while (queue.length > 0) {
      const batch = queue.splice(0);
      const batchById = new Map(batch.map((b) => [b.record.id, b.deltaMs]));
      const dependents = this
        .list({ status: ["active", "pending_confirmation", "candidate"], limit: 10000 })
        .filter(
          (c) =>
            !visited.has(c.id) &&
            c.deadline !== null &&
            c.dependencies.some((d) => batchById.has(d)),
        );
      queue = [];
      for (const dep of dependents) {
        visited.add(dep.id);
        const delta = Math.max(
          ...dep.dependencies.filter((d) => batchById.has(d)).map((d) => batchById.get(d) ?? 0),
          0,
        );
        if (delta <= 0) continue;
        const newDeadlineMs = Date.parse(dep.deadline!) + delta;
        const next: CommitmentRecord = {
          ...dep,
          deadline: new Date(newDeadlineMs).toISOString(),
          reminderSentAt: null,
          reminderTiersSent: [],
          lastEscalatedAt: null,
          updatedAt: this.now().toISOString(),
        };
        this.persist(next);
        results.push(next);
        queue.push({ record: next, deltaMs: delta });
        this.emit(
          "deadline_shifted",
          next,
          `上游承诺改期，「${next.text}」的截止时间已自动顺延至 ${next.deadline}`,
        );
      }
    }
    return results;
  }

  /** 确认：pending_confirmation → active（低置信自动提取的补确认通道） */
  confirm(id: string): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (existing.status !== "pending_confirmation") {
      return { error: `仅 pending_confirmation 状态可确认，当前 ${existing.status}` };
    }
    const next: CommitmentRecord = {
      ...existing,
      status: "active",
      updatedAt: this.now().toISOString(),
      reminderSentAt: null, // 确认后重新计时提醒
    };
    this.persist(next);
    return next;
  }

  /** 兑现：active → fulfilled */
  fulfill(id: string): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (existing.status !== "active" && existing.status !== "pending_confirmation") {
      return { error: `仅 active/pending_confirmation 可标记兑现，当前 ${existing.status}` };
    }
    const nowIso = this.now().toISOString();
    const next: CommitmentRecord = {
      ...existing,
      status: "fulfilled",
      updatedAt: nowIso,
      fulfilledAt: nowIso,
    };
    this.persist(next);
    return next;
  }

  /** 取消：任意非终态 → cancelled */
  cancel(id: string, reason?: string): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (TERMINAL_STATUSES.has(existing.status)) {
      return { error: `承诺已处于终态 ${existing.status}，不可取消` };
    }
    const nowIso = this.now().toISOString();
    const next: CommitmentRecord = {
      ...existing,
      status: "cancelled",
      updatedAt: nowIso,
      cancelledAt: nowIso,
      notes: reason ? `${existing.notes ? `${existing.notes}；` : ""}取消原因：${reason}` : existing.notes,
    };
    this.persist(next);
    return next;
  }

  /**
   * 标记承诺为 superseded（证据被作废——用户否认说过/来源撤回）。
   * 幽灵幻觉治理的承诺侧终点：证据不作数，承诺跟着作废。
   */
  markSuperseded(id: string, by: string, reason: string): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (TERMINAL_STATUSES.has(existing.status)) {
      return { error: `承诺已处于终态 ${existing.status}，不可作废` };
    }
    const nowIso = this.now().toISOString();
    const next: CommitmentRecord = {
      ...existing,
      status: "superseded",
      supersededAt: nowIso,
      updatedAt: nowIso,
      notes: `${existing.notes ? `${existing.notes}；` : ""}作废（${by}）：${reason}`,
    };
    this.persist(next);
    return next;
  }

  /**
   * 按账本证据批量作废：evidenceLedgerIds 命中任一凭证的未终态承诺 → superseded。
   * 由 provenance 的 evidenceVoided 钩子调用（create-app-services 接线）。
   */
  supersedeByEvidence(evidenceLedgerIds: string[], by: string, reason: string): CommitmentRecord[] {
    if (evidenceLedgerIds.length === 0) return [];
    const targets = new Set(evidenceLedgerIds);
    const hits = this
      .list({ status: ["candidate", "pending_confirmation", "active"], limit: 10000 })
      .filter((c) => c.evidenceLedgerIds.some((e) => targets.has(e)));
    const out: CommitmentRecord[] = [];
    for (const c of hits) {
      const marked = this.markSuperseded(c.id, by, reason);
      if (marked && "id" in marked) out.push(marked);
    }
    return out;
  }

  /**
   * 经验学习（轻量启发）：同 actor 同承诺方累计 ≥2 次违约（broken）后，
   * 新承诺的提醒档位自动提前为 3天/1天/2小时——"总是拖延，下次早点提醒"。
   * 有 category 时按「承诺方+类别」聚合（报价类总拖延 ≠ 会面类总拖延）；
   * 仅在调用方未显式指定提醒档位时生效；显式传入 remindBeforeMin 的旧调用
   * 自动降级为单档语义（tiers=[remindBeforeMin]），保持向后兼容。
   */
  private defaultPolicyFor(
    actorId: string,
    committedBy: CommittedBy,
    requested?: Partial<EscalationPolicy>,
    category?: string | null,
  ): EscalationPolicy {
    const merged: EscalationPolicy = { ...DEFAULT_ESCALATION_POLICY, ...requested };
    // 显式只传固定升级间隔（未同时配置退避档）时清空默认档：
    // 扫描侧 schedule 优先于固定间隔，不清空会让调用方自定义的
    // escalateAfterMin 被默认 [60,360,1440] 静默覆盖
    if (requested?.escalateAfterMin !== undefined && requested?.escalateAfterMinSchedule === undefined) {
      merged.escalateAfterMinSchedule = [];
    }
    if (requested?.remindBeforeMinTiers !== undefined) return merged;
    if (requested?.remindBeforeMin !== undefined) {
      merged.remindBeforeMinTiers = [requested.remindBeforeMin];
      return merged;
    }
    // 向后兼容：显式传 escalateAfterMin（旧固定间隔语义）且未给退避表时，
    // 清空默认退避表——固定间隔优先，不被新的退避节奏覆盖
    if (requested?.escalateAfterMin !== undefined && requested?.escalateAfterMinSchedule === undefined) {
      merged.escalateAfterMinSchedule = [];
    }
    const cat = category?.trim() || "其他";
    const brokenCount = this
      .list({ actorId, status: ["broken"], committedBy, limit: 1000 })
      .filter((c) => (c.category?.trim() || "其他") === cat).length;
    if (brokenCount >= 2) merged.remindBeforeMinTiers = [4320, 1440, 120];
    return merged;
  }

  /** 违约模式统计（按承诺方；经验学习的可观测面） */
  getFailurePattern(actorId: string): Record<CommittedBy, number> {
    const out: Record<CommittedBy, number> = { user: 0, agent: 0, third_party: 0 };
    for (const c of this.list({ actorId, status: ["broken"], limit: 1000 })) {
      out[c.committedBy] += 1;
    }
    return out;
  }

  /** 违约模式按类别细分（"报价类总拖延"这类模式的直接证据源） */
  getFailurePatternByCategory(actorId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.list({ actorId, status: ["broken"], limit: 1000 })) {
      const key = `${c.committedBy}:${c.category?.trim() || "其他"}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  list(opts?: {
    actorId?: string;
    status?: CommitmentStatus | CommitmentStatus[];
    committedBy?: CommittedBy;
    limit?: number;
  }): CommitmentRecord[] {
    const conds: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.actorId) {
      conds.push("actor_id = ?");
      params.push(opts.actorId);
    }
    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (statuses.length > 0) {
        conds.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    if (opts?.committedBy) {
      conds.push("committed_by = ?");
      params.push(opts.committedBy);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM commitments ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts?.limit ?? 100) as CommitmentRow[];
    return rows.map(toRecord);
  }

  private persist(record: CommitmentRecord): void {
    const prev = this.get(record.id);
    this.db
      .prepare(
        `UPDATE commitments SET
           text = ?, deadline = ?, dependencies = ?, escalation_policy = ?,
           evidence_ledger_ids = ?, status = ?, reminder_sent_at = ?,
           reminder_tiers_sent = ?, confirm_reminder_sent_at = ?,
           escalation_count = ?, last_escalated_at = ?,
           dependency_blocked = ?, updated_at = ?, fulfilled_at = ?, cancelled_at = ?,
           broken_at = ?, superseded_at = ?, notes = ?, category = ?, contact = ?
         WHERE id = ?`
      )
      .run(
        record.text,
        record.deadline,
        toJsonColumn(record.dependencies) ?? "[]",
        toJsonColumn(record.escalationPolicy) ?? "{}",
        toJsonColumn(record.evidenceLedgerIds) ?? "[]",
        record.status,
        record.reminderSentAt,
        toJsonColumn(record.reminderTiersSent) ?? "[]",
        record.confirmReminderSentAt,
        record.escalationCount,
        record.lastEscalatedAt,
        record.dependencyBlocked ? 1 : 0,
        record.updatedAt,
        record.fulfilledAt,
        record.cancelledAt,
        record.brokenAt,
        record.supersededAt,
        record.notes,
        record.category,
        toJsonColumn(record.contact) ?? null,
        record.id,
      );
    this.syncScheduleOutlet(prev, record);
  }

  /**
   * 承诺状态/期限变化 → 同步日程物化出口（单向桥，失败只记日志）。
   * persist 是全部状态流转的唯一写入口（含延期传播、扫描判 broken），在此挂钩
   * 一处覆盖所有迁移；create() 的首次插入单独调本方法。
   */
  private syncScheduleOutlet(prev: CommitmentRecord | null, next: CommitmentRecord): void {
    if (!this.scheduleOutlet) return;
    const withdraw = (reason: string) => {
      void this.scheduleOutlet!.withdrawFromCommitment(next).catch((err) => {
        console.error(`[commitment-board] 日程撤下失败（忽略，${reason}）:`, err);
      });
    };
    try {
      if (next.status === "active") {
        if (next.deadline) {
          void this.scheduleOutlet.upsertFromCommitment(next).catch((err) => {
            console.error("[commitment-board] 承诺物化日程失败（忽略）:", err);
          });
        } else if (prev && prev.status === "active") {
          withdraw("active 撤掉期限");
        }
        return;
      }
      if (prev && prev.status === "active") {
        withdraw(`状态 ${prev.status} → ${next.status}`);
      }
    } catch (err) {
      console.error("[commitment-board] 日程物化出口异常（忽略）:", err);
    }
  }

  // ------------------------------------------------------------
  // 自动提取通道（LLM 识别结果 → 置信度分级落板）
  // ------------------------------------------------------------

  /**
   * 自动提取分级落板（用户决策 2026-09-04）：
   *   confidence > 0.8            → 直接创建 active
   *   0.5 ≤ confidence ≤ 0.8      → 创建 pending_confirmation（下次对话轻量确认）
   *   confidence < 0.5            → 写入候选池（status=candidate，不提醒不升级）
   * 每条 evidence 必须先写入语义账本并回填 evidenceLedgerIds；
   * 同 actor 同语义指纹的未终态承诺幂等跳过（对话重放/多次提取防重）。
   */
  ingestExtracted(
    actorId: string,
    extracted: ExtractedCommitment[],
    opts: { sourceRef: string; ledger?: AgenticLedger | null },
  ): CommitmentRecord[] {
    const created: CommitmentRecord[] = [];
    const activeFingerprints = new Set(
      this.list({ actorId, limit: 1000 })
        .filter((c) => !TERMINAL_STATUSES.has(c.status))
        .map((c) => semanticFingerprint(c.text) || c.text.trim()),
    );

    for (const item of extracted) {
      const text = item.text?.trim();
      if (!text) continue;

      // 用户约束（2026-09-04）：自动提取必须关联账本证据——无证据项直接丢弃
      if (opts.ledger && !item.evidence?.trim()) continue;

      const fp = semanticFingerprint(text) || text;
      if (activeFingerprints.has(fp)) continue; // 幂等：已有同语义未终态承诺

      // 证据先行落账（无 ledger 时跳过证据关联，承诺照常创建）
      const evidenceLedgerIds: string[] = [];
      if (opts.ledger && item.evidence?.trim()) {
        const rec = opts.ledger.append({
          actorId,
          claim: item.evidence.trim(),
          sourceRef: opts.sourceRef,
          sourceType: "chat",
          confidence: item.confidence,
          metadata: { commitmentEvidence: true, commitmentText: text },
        });
        if (rec) evidenceLedgerIds.push(rec.id);
      }

      const status: CommitmentStatus =
        item.confidence > 0.8 ? "active" : item.confidence >= 0.5 ? "pending_confirmation" : "candidate";

      const result = this.create({
        actorId,
        text,
        committedBy: item.committedBy,
        deadline: item.deadline,
        source: "auto",
        confidence: item.confidence,
        evidenceLedgerIds,
        category: item.category,
        status,
      });
      if (result && "id" in result) {
        created.push(result);
        activeFingerprints.add(fp);
      }
    }
    return created;
  }

  /** 候选池晋升（人工/确认对话后把 candidate 转为待确认或激活） */
  promoteCandidate(id: string, to: "pending_confirmation" | "active"): CommitmentRecord | { error: string } {
    const existing = this.get(id);
    if (!existing) return { error: `承诺不存在：${id}` };
    if (existing.status !== "candidate") {
      return { error: `仅 candidate 可晋升，当前 ${existing.status}` };
    }
    const next: CommitmentRecord = { ...existing, status: to, updatedAt: this.now().toISOString() };
    this.persist(next);
    return next;
  }

  // ------------------------------------------------------------
  // 扫描循环：临近提醒 / 超时升级 / 依赖检查
  // ------------------------------------------------------------

  /**
   * 单轮扫描（可注入 now 供测试）。处理顺序：
   *   1. 依赖检查：板上依赖未 fulfilled → blocked（冻结提醒/升级）；
   *      全部满足 → 解除阻塞并发出 dependency_unblocked。
   *   2. 临近提醒：active 且 deadline 进入 remindBeforeMin 窗口，一次性提醒。
   *   3. 确认提醒：pending_confirmation 且 deadline 进入最大提醒档窗口，
   *      发一次 confirm_reminder（"还算数吗"）——待确认池的轻量确认出口。
   *   4. 待确认过期：pending_confirmation 超 deadline 未确认 → broken。
   *   5. 超时升级：active 且超 deadline，按 escalateAfterMin 间隔升级，
   *      次数耗尽后判 broken。
   */
  async scanOnce(nowInput?: Date): Promise<CommitmentScanReport> {
    const now = nowInput ?? this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const report: CommitmentScanReport = {
      scanned: 0,
      reminders: 0,
      confirmReminders: 0,
      escalations: 0,
      broken: 0,
      pendingExpired: 0,
      unblocked: 0,
      blocked: 0,
    };

    const byId = new Map<string, CommitmentRecord>();
    const live = this.list({ status: ["active", "pending_confirmation", "candidate"], limit: 10000 });
    for (const c of live) byId.set(c.id, c);
    // 终态承诺不参与扫描，但必须参与依赖判定：broken/cancelled/superseded 的上游
    // 仍要阻塞下游（否则上游一失败，下游反而"看不见"依赖、照常推进）
    for (const c of this.list({ status: ["broken", "cancelled", "superseded"], limit: 10000 })) {
      byId.set(c.id, c);
    }

    for (const commitment of live) {
      report.scanned += 1;

      // 1) 依赖检查
      const boardDeps = commitment.dependencies
        .map((dep) => byId.get(dep))
        .filter((dep): dep is CommitmentRecord => Boolean(dep));
      const blocked = boardDeps.some((dep) => dep.status !== "fulfilled");
      if (blocked !== commitment.dependencyBlocked) {
        const next: CommitmentRecord = {
          ...commitment,
          dependencyBlocked: blocked,
          updatedAt: nowIso,
        };
        this.persist(next);
        byId.set(next.id, next);
        if (!blocked) {
          report.unblocked += 1;
          this.emit(
            "dependency_unblocked",
            next,
            `承诺依赖已全部就绪，恢复推进：「${next.text}」`,
          );
        } else {
          // 上游失败（broken/cancelled/superseded）→ 明确提醒用户上游出问题了
          report.blocked += 1;
          const deadDeps = boardDeps
            .filter((d) => d.status === "broken" || d.status === "cancelled" || d.status === "superseded")
            .map((d) => `「${d.text}」(${d.status})`)
            .join("、");
          this.emit(
            "dependency_blocked",
            next,
            deadDeps
              ? `承诺被阻塞：依赖的 ${deadDeps} 已未兑现，需要你关注上游：「${next.text}」`
              : `承诺被阻塞：依赖的承诺尚未兑现：「${next.text}」`,
          );
        }
        continue; // 状态刚翻转，下一轮再进入提醒/升级判定
      }
      if (commitment.status === "candidate") continue; // 候选池不参与时间驱动
      if (commitment.dependencyBlocked) continue; // 阻塞中冻结提醒与升级

      if (!commitment.deadline) continue;
      const deadlineMs = Date.parse(commitment.deadline);

      // 2) 梯度临近提醒（仅 active；pending 未确认不催）：
      //    档位降序排列（24h → 2h…），每档进入 deadline-beforeMin 窗口后发一次，
      //    先温和（提供帮助）后紧迫（催办）；超时后进入升级分支。
      if (commitment.status === "active") {
        const sent = new Set(commitment.reminderTiersSent);
        const tiers = [...activeRemindTiers(commitment.escalationPolicy)].sort((a, b) => b - a);
        const dueTier = tiers.find(
          (tier) => !sent.has(tier) && nowMs >= deadlineMs - tier * 60_000 && nowMs < deadlineMs,
        );
        if (dueTier !== undefined) {
          const tone = toneForTier(dueTier);
          const next: CommitmentRecord = {
            ...commitment,
            reminderSentAt: nowIso,
            reminderTiersSent: [...commitment.reminderTiersSent, dueTier],
            updatedAt: nowIso,
          };
          this.persist(next);
          byId.set(next.id, next);
          report.reminders += 1;
          const remaining = formatRemaining(deadlineMs - nowMs);
          this.emit(
            "reminder",
            next,
            tone === "gentle"
              ? `距承诺截止还有 ${remaining}（${next.deadline}）：${committedLabel(next.committedBy)}「${next.text}」，需要我帮忙准备吗？`
              : `距承诺截止仅剩 ${remaining}：「${next.text}」还没完成（截止 ${next.deadline}）`,
            tone,
          );
          continue;
        }
      }

      // 3) 确认提醒（仅 pending_confirmation）：进入最大提醒档窗口后发一次
      //    "还算数吗"——待确认池（自动提取 0.5-0.8 置信度）的轻量确认出口。
      //    不乘置信度折算（提案侧）：确认是消解不确定性的动作，价值不打折。
      if (commitment.status === "pending_confirmation" && nowMs < deadlineMs) {
        const confirmWindowMin = Math.max(...activeRemindTiers(commitment.escalationPolicy));
        if (
          !commitment.confirmReminderSentAt &&
          nowMs >= deadlineMs - confirmWindowMin * 60_000
        ) {
          const next: CommitmentRecord = {
            ...commitment,
            confirmReminderSentAt: nowIso,
            updatedAt: nowIso,
          };
          this.persist(next);
          byId.set(next.id, next);
          report.confirmReminders += 1;
          this.emit(
            "confirm_reminder",
            next,
            `待确认承诺临近截止：「${next.text}」（截止 ${next.deadline}），还约定这件事吗？`,
          );
          continue;
        }
      }

      const overdueBase = commitment.lastEscalatedAt ?? commitment.deadline;
      const overdueBaseMs = Date.parse(overdueBase);

      // 3) 待确认过期
      if (commitment.status === "pending_confirmation" && nowMs > deadlineMs) {
        const next: CommitmentRecord = {
          ...commitment,
          status: "broken",
          brokenAt: nowIso,
          updatedAt: nowIso,
        };
        this.persist(next);
        byId.set(next.id, next);
        report.pendingExpired += 1;
        report.broken += 1;
        this.emit(
          "pending_expired",
          next,
          `待确认承诺超过截止未确认，已关闭：「${next.text}」`,
        );
        continue;
      }

      // 4) 超时升级与判 broken（仅 active）。升级节奏带退避：
      //    escalateAfterMinSchedule 按已升级次数取值（末位兜底），未配置回退固定 escalateAfterMin
      if (commitment.status !== "active" || nowMs <= deadlineMs) continue;
      const schedule = commitment.escalationPolicy.escalateAfterMinSchedule;
      const stepMin =
        schedule && schedule.length > 0
          ? commitment.escalationCount < schedule.length
            ? schedule[commitment.escalationCount]!
            : schedule[schedule.length - 1]!
          : commitment.escalationPolicy.escalateAfterMin;
      const dueMs = overdueBaseMs + stepMin * 60_000;
      if (nowMs < dueMs) continue;

      if (commitment.escalationCount < commitment.escalationPolicy.maxEscalations) {
        const next: CommitmentRecord = {
          ...commitment,
          escalationCount: commitment.escalationCount + 1,
          lastEscalatedAt: nowIso,
          updatedAt: nowIso,
        };
        this.persist(next);
        byId.set(next.id, next);
        report.escalations += 1;
        this.emit(
          "escalation",
          next,
          `承诺已超时，第 ${next.escalationCount}/${next.escalationPolicy.maxEscalations} 次升级：` +
            `${committedLabel(next.committedBy)}「${next.text}」（截止 ${next.deadline}）`,
        );
      } else {
        const next: CommitmentRecord = {
          ...commitment,
          status: "broken",
          brokenAt: nowIso,
          updatedAt: nowIso,
        };
        this.persist(next);
        byId.set(next.id, next);
        report.broken += 1;
        this.emit(
          "broken",
          next,
          `承诺超时且升级次数耗尽，判定违约：「${next.text}」`,
        );
      }
    }

    return report;
  }

  /** actor 级清理（memory-clear-service 级联调用） */
  purgeActor(actorId: string): number {
    const res = this.db.prepare(`DELETE FROM commitments WHERE actor_id = ?`).run(actorId);
    return res.changes;
  }

  /** 各状态承诺计数（health 快照用） */
  statsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM commitments GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** 启动扫描循环（间隔 AGENT_COMMITMENT_SCAN_INTERVAL_MIN，缺省 5 分钟） */
  startScan(): void {
    if (this.scanTimer) return;
    const intervalMin = getCommitmentScanIntervalMin();
    this.scanTimer = setInterval(() => {
      void this.scanOnce().catch((err) =>
        console.error("[commitment-board] 扫描失败:", err instanceof Error ? err.message : err),
      );
    }, intervalMin * 60_000);
    this.scanTimer.unref();
    console.info(`[commitment-board] 扫描循环已启动（间隔 ${intervalMin}min）`);
  }

  stopScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

function committedLabel(by: CommittedBy): string {
  if (by === "user") return "用户承诺";
  if (by === "agent") return "我（Agent）承诺";
  return "第三方承诺";
}

// ============================================================
// 承诺方差异化提案构建（接入 proactivity 管道的映射层）
// ============================================================

export type CommitmentProposalDraft = {
  /** must=绕过社交预算直投；social=走预算仲裁（低价值承诺可能被仲裁沉默） */
  tier: "must" | "social";
  importance: "critical" | "high" | "medium" | "low";
  kind: string;
  title: string;
  directText: string;
  dedupKey: string;
  /** true=代发催促等动作需用户授权确认后才能执行 */
  needsAuthorization: boolean;
  /** 代催目标渠道（承诺登记了 contact 才有；批准后按此真实外发） */
  contact?: CommitmentContact;
};

/**
 * 承诺事件 → 主动性提案草稿。
 *
 * 差异化（用户规格 2026-09-04）：
 *   - user：温和提醒附带帮助提议；超时督促但不越权执行（文案明确"不替你执行"）；
 *   - agent：自跟踪；超时文案给出「自动重试 / 用户定夺」选项；
 *   - third_party：履约跟踪；超时建议用户主动联系，可代发催促（needsAuthorization=true）。
 *
 * 价值分级仲裁：自动提取且置信度 <0.8 的低价值承诺降为 social 档——
 * "不是所有承诺超时都要打扰用户"，由管道预算仲裁决定是否沉默。
 * superseded 等信息性事件返回 null（保持沉默，不打扰）。
 */
export function commitmentProposalFromEvent(
  event: CommitmentEvent,
): CommitmentProposalDraft | null {
  const c = event.commitment;
  const isLowValue = c.source === "auto" && (c.confidence ?? 1) < 0.8;
  const tier: "must" | "social" = isLowValue ? "social" : "must";

  const importanceByType: Record<CommitmentEventType, "critical" | "high" | "medium" | null> = {
    reminder: event.tone === "urgent" ? "high" : "medium",
    confirm_reminder: "medium",
    escalation: "high",
    broken: "critical",
    dependency_blocked: "high",
    pending_expired: "medium",
    dependency_unblocked: "medium",
    deadline_shifted: "medium",
  };
  const importance = importanceByType[event.type];
  if (!importance) return null;

  const by = c.committedBy;
  let kind = "action.commitment";
  let title = "";
  let directText = "";
  let needsAuthorization = false;

  if (event.type === "reminder") {
    const urgent = event.tone === "urgent";
    if (by === "user") {
      title = urgent ? "承诺即将到期" : "承诺提醒";
      directText = urgent
        ? `提醒：「${c.text}」快到截止时间了（${c.deadline}），需要我搭把手吗？`
        : `温和提醒：「${c.text}」，距截止（${c.deadline}）还有一天左右，需要我帮你准备点什么吗？`;
    } else if (by === "agent") {
      title = urgent ? "我的承诺即将到期" : "我的承诺进展提醒";
      directText = `我承诺的「${c.text}」临近截止（${c.deadline}）${urgent ? "，正在加紧处理" : ""}，有进展我会第一时间同步。`;
    } else {
      title = urgent ? "第三方承诺即将到期" : "第三方履约提醒";
      directText = `跟踪到「${c.text}」临近截止（${c.deadline}），需要我帮你确认对方的进展吗？`;
    }
  } else if (event.type === "escalation") {
    const progress = `（第 ${c.escalationCount}/${c.escalationPolicy.maxEscalations} 次）`;
    if (by === "user") {
      title = `承诺已超时${progress}`;
      directText = `「${c.text}」已超过约定时间（${c.deadline}）还没完成。要调整计划，还是我帮你分担一部分？（我不会替你直接执行）`;
    } else if (by === "agent") {
      title = `我的承诺超时${progress}，请求介入`;
      directText = `我承诺的「${c.text}」超时了（截止 ${c.deadline}）。我可以自动重试或调整方案，也可以由你来定夺，怎么处理？`;
    } else {
      kind = "action.commitment.nudge";
      needsAuthorization = true;
      title = `第三方未履约${progress}`;
      directText = c.contact
        ? `对方承诺的「${c.text}」超时未兑现（截止 ${c.deadline}）。我可以代你在 ${c.contact.participantName ?? c.contact.channelId} 那边发一条催促消息（发送前会先经你确认），或者你自己联系。`
        : `对方承诺的「${c.text}」超时未兑现（截止 ${c.deadline}）。建议你主动联系确认；需要的话我可以代你发一条催促消息（发送前会先经你确认）。`;
    }
  } else if (event.type === "broken") {
    if (by === "agent") {
      title = "我的承诺未能完成";
      directText = `很抱歉，我承诺的「${c.text}」最终未能完成（截止 ${c.deadline}）。我会复盘原因并调整后续计划。`;
    } else {
      title = by === "user" ? "承诺已判定违约" : "第三方承诺已判定违约";
      directText = `「${c.text}」多次超时未兑现，已判定违约（截止 ${c.deadline}）。`;
    }
  } else if (event.type === "dependency_unblocked") {
    title = "上一步完成，可以推进了";
    directText = `依赖的承诺已完成，「${c.text}」现在可以开始了（截止 ${c.deadline}）。`;
  } else if (event.type === "dependency_blocked") {
    title = "承诺被上游阻塞";
    directText = `「${c.text}」依赖的承诺未兑现，暂时无法推进（截止 ${c.deadline}），需要你关注上游。`;
  } else if (event.type === "confirm_reminder") {
    title = "这条承诺还算数吗？";
    directText = `之前提到「${c.text}」（截止 ${c.deadline}），还约定这件事吗？确认后我会帮你盯着；不是的话我把它关掉。`;
  } else if (event.type === "deadline_shifted") {
    title = "承诺截止时间已自动顺延";
    directText = `上游承诺改期，「${c.text}」的截止时间已自动顺延至 ${c.deadline}。`;
  } else {
    // pending_expired
    title = "待确认承诺已关闭";
    directText = `「${c.text}」超过截止仍未确认，已自动关闭。`;
  }

  return {
    tier,
    importance,
    kind,
    title,
    directText,
    // dedupKey 携带 deadline 代次：承诺改期后板子侧梯度档重置时，
    // 管道侧的同 tone 提醒不会被 wasDeliveredRecently 误吞（P0 修复 2026-09-04）
    dedupKey: `commitment:${c.id}:${event.type}:${
      event.type === "escalation" ? c.escalationCount : (event.tone ?? "")
    }:${c.deadline ?? "none"}`,
    needsAuthorization,
    ...(kind === "action.commitment.nudge" && c.contact ? { contact: c.contact } : {}),
  };
}

/**
 * 组装代催外发文案（确定性拼接，零 LLM）：以用户口吻、注明代发，
 * 对方回复会进入该会话由用户接管。
 */
export function composeCommitmentNudgeText(c: CommitmentRecord): string {
  const deadline = c.deadline ? `（原定 ${c.deadline}）` : "";
  return `【代催】你好，想跟进一下「${c.text}」${deadline}的进展～这边有点等它落地，方便的时候同步一下，谢谢！`;
}

// ============================================================
// 梯度提醒辅助
// ============================================================

/** 生效提醒档：显式 tiers 优先；未配置时回退单一 remindBeforeMin（旧数据兼容） */
function activeRemindTiers(policy: EscalationPolicy): number[] {
  if (policy.remindBeforeMinTiers && policy.remindBeforeMinTiers.length > 0) {
    return policy.remindBeforeMinTiers;
  }
  return [policy.remindBeforeMin];
}

function toneForTier(tierMin: number): "gentle" | "urgent" {
  return tierMin <= 120 ? "urgent" : "gentle";
}

function formatRemaining(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) return `${Math.round(min / 60)} 小时`;
  return `${Math.round(min / 1440)} 天`;
}

export function createCommitmentBoardIfEnabled(
  db?: SqliteDatabase,
  now?: () => Date,
): CommitmentBoard | null {
  if (!isCommitmentBoardEnabled()) return null;
  const board = new CommitmentBoard(db, now);
  board.startScan();
  return board;
}
