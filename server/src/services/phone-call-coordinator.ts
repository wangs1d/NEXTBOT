import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerEventType } from "../protocol.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { normalizeDialNumber } from "../tools/phone-bridge-tools.js";
import type { AuditService } from "./audit-service.js";
import type { InboxSendInput } from "./inbox-service.js";

/**
 * 电话代办（phone_call.*）协调器 —— agent 代用户向第三方真人发起真实电话。
 *
 * 与「虚拟电话」（virtual-phone-service.ts，站内应用内来电 Agent→用户）是两个并行体系：
 * 仅借鉴其回复总线写法，不共享运行时、号码体系、会话存储与 UI 状态（docs/phone-call-architecture.md §〇）。
 *
 * P0 形态（脚本托管）：agent 不参与通话语音——
 *   prepare（校验+确认卡）→ 用户点击确认 → start（经手机桥拨出，手机端二次全屏确认，
 *   通话由用户亲自进行）→ 用户挂断后 finish（结构化结果回填：收件箱必达 + 给 LLM 的结果摘要）。
 * P1 将在同一状态机上叠加端侧实时语音回路（CallTransport 抽象预留）。
 *
 * 状态机：
 *   awaiting_confirm →(确认, start)→ dialing → active →(finish)→ summarized
 *         │(拒绝/过期)→ cancelled / expired            │(手机端取消/失败)→ cancelled / failed
 *
 * 安全硬约束（全部服务端强制）：
 *   - 确认门：start 必须能追溯到真实用户确认（确认卡点击 chat.user_action，或
 *     等待确认期间用户文本明确确认），LLM 自行调用 start 一律拒绝；
 *   - 紧急号码永拒（复用 phone-bridge-tools 的 normalizeDialNumber）；
 *   - 6 位纯数字拒绝（那是站内虚拟电话号，两体系互斥护栏）；
 *   - 频控：同号码 24h 上限 + 单 actor 日上限 + 静默时段（默认 22:00-08:00）；
 *   - 等待确认 TTL（默认 10 分钟）过期自动作废；
 *   - 全链路审计；对外输出一律脱敏号码。
 */

export type PhoneCallState =
  | "awaiting_confirm"
  | "cancelled"
  | "expired"
  | "dialing"
  | "active"
  | "summarized"
  | "failed";

export type PhoneCallOutcome =
  | "booked" // 预约/订座成功（含预约号）
  | "confirmed" // 对方确认了既有安排
  | "info_got" // 拿到所需信息
  | "callback_later" // 对方要求稍后再回电
  | "no_answer" // 无人接听/占线
  | "failed" // 诉求被拒/无法达成
  | "other"; // 其他（detail 必填）

export type PhoneCallSession = {
  callId: string;
  actorId: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  state: PhoneCallState;
  /** 被叫号码（归一化明文，仅存会话文件；对外/日志/列表一律 numberMasked） */
  number: string;
  numberMasked: string;
  contactName?: string;
  /** 一句话通话目标 */
  goal: string;
  /** 已知要素（人数/时间/联系人/订单号/特殊需求…） */
  facts: Record<string, unknown>;
  /** 必须问清的问题清单 */
  mustAsk: string[];
  /** 对方无法满足时的底线方案 */
  fallback?: string;
  /** 拨打前给用户的话术要点（P0 由用户亲自通话时参考） */
  script?: string;
  maxDurationSec: number;
  confirmedAt?: string;
  confirmedVia?: "card_click" | "text";
  /** 手机端拨号回执 state（dialing/dialer_opened/cancelled/...） */
  dialState?: string;
  activeAt?: string;
  endedAt?: string;
  summarizedAt?: string;
  outcome?: PhoneCallOutcome;
  outcomeDetail?: string;
  appointmentTime?: string;
  bookingRef?: string;
  followUps?: string[];
  /** 拒绝/取消原因（拒绝路径审计与 status 透传用） */
  rejectReason?: string;
};

export type PhoneCallPrepareInput = {
  number: string;
  contactName?: string;
  goal: string;
  facts?: Record<string, unknown>;
  mustAsk?: string[];
  fallback?: string;
  script?: string;
  maxDurationSec?: number;
  sessionId?: string;
};

export type PhoneCallFinishInput = {
  callId: string;
  outcome: PhoneCallOutcome;
  detail?: string;
  appointmentTime?: string;
  bookingRef?: string;
  followUps?: string[];
};

/** 手机桥依赖（结构化最小接口，便于单测注入 mock） */
export type PhoneCallBridgePort = {
  hasExecutor(actorId: string): boolean;
  invoke(
    actorId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; [key: string]: unknown }>;
};

/** 客户端推送依赖（ClientPushPort 的结构化子集） */
export type PhoneCallPushPort = {
  trySend(actorId: string, data: string): boolean;
};

/** 站内信依赖（结果回填必达通道；结构化最小接口） */
export type PhoneCallInboxPort = {
  send(input: InboxSendInput): Promise<unknown>;
};

export type PhoneCallConfig = {
  enabled: boolean;
  /** 同一被叫号码 24h 内最多拨出次数 */
  perNumber24hLimit: number;
  /** 单 actor 每自然日最多拨出次数 */
  dailyLimit: number;
  /** 静默时段 "HH:mm-HH:mm"（可跨午夜），时段内禁止拨出 */
  quietHours: string;
  /** 等待确认 TTL（毫秒），超时自动作废 */
  confirmTtlMs: number;
  /** 手机桥 dial 调用超时（含手机端全屏确认等待） */
  dialTimeoutMs: number;
  /** 默认单通时长上限（秒），输入可缩小、不可放大 */
  defaultMaxDurationSec: number;
};

const DEFAULT_CONFIG: PhoneCallConfig = {
  enabled: false,
  perNumber24hLimit: 2,
  dailyLimit: 20,
  quietHours: "22:00-08:00",
  confirmTtlMs: 10 * 60_000,
  dialTimeoutMs: 45_000,
  defaultMaxDurationSec: 300,
};

function envInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBoolean(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function configFromEnv(env: NodeJS.ProcessEnv = process.env): PhoneCallConfig {
  return {
    enabled: envBoolean(env.PHONE_CALL_ENABLED),
    perNumber24hLimit: envInt(env.PHONE_CALL_PER_NUMBER_24H_LIMIT, DEFAULT_CONFIG.perNumber24hLimit),
    dailyLimit: envInt(env.PHONE_CALL_DAILY_LIMIT, DEFAULT_CONFIG.dailyLimit),
    quietHours: (env.PHONE_CALL_QUIET_HOURS ?? DEFAULT_CONFIG.quietHours).trim(),
    confirmTtlMs: envInt(env.PHONE_CALL_CONFIRM_TTL_MS, DEFAULT_CONFIG.confirmTtlMs),
    dialTimeoutMs: envInt(env.PHONE_CALL_DIAL_TIMEOUT_MS, DEFAULT_CONFIG.dialTimeoutMs),
    defaultMaxDurationSec: envInt(env.PHONE_CALL_MAX_DURATION_SEC, DEFAULT_CONFIG.defaultMaxDurationSec),
  };
}

/** 号码脱敏：保留前 3 后 4（≥8 位）；短号保留前 2 后 2。 */
export function maskPhoneNumber(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length >= 8) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }
  if (digits.length >= 4) {
    return `${digits.slice(0, 2)}**${digits.slice(-2)}`;
  }
  return "****";
}

/** 静默时段判定；解析失败视为无静默时段（fail-open 仅影响可用性，不影响安全门）。 */
export function isInQuietHours(range: string, at: Date): boolean {
  const m = range.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
  const end = Number.parseInt(m[3], 10) * 60 + Number.parseInt(m[4], 10);
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  // 跨午夜（如 22:00-08:00）
  return minutes >= start || minutes < end;
}

/** 用户文本确认（仅在会话处于 awaiting_confirm 时被消费，兜底确认卡渲染失败的场景）。 */
const TEXT_CONFIRM_RE = /^(确认拨打|确认拨出|确认吧|确认|打吧|拨打吧|拨吧|可以打|可以拨打|打出去|同意拨打|就这么打|打给他吧|打给她吧|打给对方吧|打电话吧)[。！!~\s]*$/;

/** 拒绝原因 → 模型可向用户转述的一句话（诚实失败，禁止换个说法绕过确认门）。 */
function rejectResult(reason: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ok: false, rejected: true, reason, ...extra };
}

/** 索引行（列表/频控用，永不含明文号码） */
type PhoneCallIndexEntry = {
  callId: string;
  actorId: string;
  numberMasked: string;
  state: PhoneCallState;
  outcome?: PhoneCallOutcome;
  createdAt: string;
};

const INDEX_MAX_ENTRIES = 200;

export type PhoneCallCoordinatorDeps = {
  bridge: PhoneCallBridgePort;
  pushPort: PhoneCallPushPort;
  audit?: AuditService;
  inbox?: PhoneCallInboxPort;
  /** 会话落盘根目录（默认 data/phone-call） */
  dataDir?: string;
  /** 配置覆盖（测试注入用；未覆盖的字段回落 env → 默认值） */
  config?: Partial<PhoneCallConfig>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: { info(msg: string): void; warn(msg: string): void };
};

export class PhoneCallCoordinator {
  private readonly config: PhoneCallConfig;
  private readonly sessions = new Map<string, PhoneCallSession>();
  private loaded = false;
  private loadPromise?: Promise<void>;
  /** 同轮 start 去重：chatUserMessageId+callId → 已有结果（照 phone-bridge-tools 去重模式） */
  private readonly startDedup = new Map<string, Record<string, unknown>>();
  /** 站内信端口晚绑定（InboxService 在 bootstrap 中构造晚于本服务） */
  private inboxPort?: PhoneCallInboxPort;

  constructor(private readonly deps: PhoneCallCoordinatorDeps) {
    this.config = { ...configFromEnv(deps.env), ...deps.config };
  }

  /** bootstrap 装配段晚绑定站内信（结果回执必达通道）；重复调用以最后一次为准。 */
  setInbox(port: PhoneCallInboxPort): void {
    this.inboxPort = port;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private paths() {
    const root = this.deps.dataDir ?? join(getDataDir(), "phone-call");
    return { root, sessions: join(root, "sessions"), index: join(root, "index.json") };
  }

  // ── 持久化 ──────────────────────────────────────────────────────────

  /** 懒加载历史索引与会话文件（频控跨重启生效；坏文件跳过不阻断）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      const { sessions, index } = this.paths();
      let entries: PhoneCallIndexEntry[] = [];
      try {
        entries = JSON.parse(await readFile(index, "utf8")) as PhoneCallIndexEntry[];
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (this.sessions.has(entry.callId)) continue;
        try {
          const raw = JSON.parse(await readFile(join(sessions, `${entry.callId}.json`), "utf8")) as PhoneCallSession;
          // 历史未决会话：跨重启不再可信（确认上下文已丢失），一律按过期收口
          if (raw.state === "awaiting_confirm" || raw.state === "dialing") {
            raw.state = "expired";
            raw.rejectReason = "server_restart";
          }
          this.sessions.set(raw.callId, raw);
        } catch {
          // 单个会话文件损坏：跳过（频控统计少一条，可接受）
        }
      }
      this.loaded = true;
      this.deps.logger?.info(`[phone-call] 已加载 ${this.sessions.size} 条历史会话`);
    })();
    await this.loadPromise;
  }

  private async persist(session: PhoneCallSession): Promise<void> {
    session.updatedAt = this.now().toISOString();
    const { sessions, index } = this.paths();
    await writeJsonAtomic(join(sessions, `${session.callId}.json`), session);
    const entry: PhoneCallIndexEntry = {
      callId: session.callId,
      actorId: session.actorId,
      numberMasked: session.numberMasked,
      state: session.state,
      outcome: session.outcome,
      createdAt: session.createdAt,
    };
    const rest = [...this.sessions.values()]
      .filter((s) => s.callId !== session.callId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-INDEX_MAX_ENTRIES + 1);
    const indexEntries: PhoneCallIndexEntry[] = [...rest.map((s) => ({
      callId: s.callId,
      actorId: s.actorId,
      numberMasked: s.numberMasked,
      state: s.state,
      outcome: s.outcome,
      createdAt: s.createdAt,
    })), entry];
    await writeJsonAtomic(index, indexEntries);
  }

  // ── 状态推送 / 审计 ─────────────────────────────────────────────────

  private pushStatus(session: PhoneCallSession, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.pushPort.trySend(
        session.actorId,
        JSON.stringify({
          type: ServerEventType.PhoneCallStatusUpdate,
          payload: {
            callId: session.callId,
            state: session.state,
            numberMasked: session.numberMasked,
            contactName: session.contactName,
            goal: session.goal,
            outcome: session.outcome,
            rejectReason: session.rejectReason,
            updatedAt: session.updatedAt,
            ...extra,
          },
        }),
      );
    } catch {
      // 推送失败不影响主链路
    }
  }

  private async audit(action: string, session: PhoneCallSession, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.audit?.record({
        category: "phone_call",
        action,
        actorId: session.actorId,
        callId: session.callId,
        numberMasked: session.numberMasked,
        state: session.state,
        timestamp: this.now().getTime(),
        ...extra,
      });
    } catch {
      // 审计失败不阻断
    }
  }

  // ── 频控 / 时段 / 号码校验 ───────────────────────────────────────────

  private dialAttempts(actorId: string, sinceMs: number): PhoneCallSession[] {
    const cutoff = this.now().getTime() - sinceMs;
    return [...this.sessions.values()].filter((s) => {
      if (s.actorId !== actorId) return false;
      // 计入频控 = 真正发起过拨出（桥接被调用过）或正在拨出；未拨出的取消/过期不计
      if (!s.dialState && s.state !== "dialing") return false;
      const at = s.activeAt ?? s.updatedAt;
      return new Date(at).getTime() >= cutoff;
    });
  }

  private frequencyReject(actorId: string, number: string): string | null {
    const last24h = this.dialAttempts(actorId, 24 * 3600_000).filter((s) => s.number === number);
    if (last24h.length >= this.config.perNumber24hLimit) {
      return `同号码 24 小时内外呼已达上限（${this.config.perNumber24hLimit} 次），为防打扰暂不再拨。如确有必要请稍后或换时间再试。`;
    }
    const dayStart = new Date(this.now());
    dayStart.setHours(0, 0, 0, 0);
    const today = this.dialAttempts(actorId, 24 * 3600_000).filter(
      (s) => new Date(s.activeAt ?? s.updatedAt).getTime() >= dayStart.getTime(),
    );
    if (today.length >= this.config.dailyLimit) {
      return `今日外呼已达单日上限（${this.config.dailyLimit} 次），明天再试。`;
    }
    return null;
  }

  /**
   * 号码安全校验：紧急号码永拒 + 6 位纯数字（站内虚拟号）拒 + 长度合法性。
   * 返回 { number } 或 { error }。
   */
  private validateNumber(raw: string): { number?: string; error?: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { error: "缺少被叫号码" };
    if (/^\d{6}$/.test(trimmed.replace(/[^\d]/g, ""))) {
      return { error: "6 位纯数字是站内虚拟电话号（应用内通话体系），不能用于真实外呼；请提供对方真实手机号/固话。" };
    }
    const number = normalizeDialNumber(trimmed);
    if (!number) {
      return { error: `号码不合法或为紧急号码，已拒绝拨打：${trimmed}。紧急电话（110/119/120 等）任何情况下都不允许代拨。` };
    }
    return { number };
  }

  // ── prepare：校验 + 建会话 + 确认卡 ─────────────────────────────────

  async prepare(
    actorId: string,
    input: PhoneCallPrepareInput,
  ): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!this.config.enabled) {
      return rejectResult("电话代办能力未启用（PHONE_CALL_ENABLED=false）");
    }
    const goal = String(input.goal ?? "").trim();
    if (!goal) return rejectResult("缺少 goal（一句话通话目标），无法生成确认卡");

    const check = this.validateNumber(input.number);
    if (check.error) {
      return rejectResult(check.error);
    }
    const number = check.number!;

    const quiet = isInQuietHours(this.config.quietHours, this.now());
    if (quiet) {
      return rejectResult(
        `当前处于静默时段（${this.config.quietHours}），禁止外呼打扰他人。请稍后再试。`,
      );
    }

    // 单飞：同号码已有未决会话 → 返回现有 callId，不重复建卡
    const pending = [...this.sessions.values()].find(
      (s) =>
        s.actorId === actorId &&
        s.number === number &&
        (s.state === "awaiting_confirm" || s.state === "dialing" || s.state === "active"),
    );
    if (pending) {
      return {
        ok: true,
        deduped: true,
        callId: pending.callId,
        state: pending.state,
        numberMasked: pending.numberMasked,
        cardMarker: pending.state === "awaiting_confirm" ? buildConfirmCardMarker(pending) : undefined,
        summary:
          pending.state === "awaiting_confirm"
            ? "该号码已有一张待确认的拨打卡，请勿重复生成；引导用户点击卡片上的「确认拨打」。"
            : `该号码的通话已在进行/拨出中（state=${pending.state}），无需再次拨打。`,
      };
    }

    // 过期清扫：TTL 内未确认的旧会话作废（含同号码之外的）
    for (const s of this.sessions.values()) {
      if (s.actorId !== actorId || s.state !== "awaiting_confirm") continue;
      if (this.now().getTime() - new Date(s.createdAt).getTime() > this.config.confirmTtlMs) {
        s.state = "expired";
        s.rejectReason = "confirm_timeout";
        await this.persist(s);
        await this.audit("expire", s);
      }
    }

    const nowIso = this.now().toISOString();
    const session: PhoneCallSession = {
      callId: `pc_${randomUUID().slice(0, 12)}`,
      actorId,
      sessionId: input.sessionId,
      createdAt: nowIso,
      updatedAt: nowIso,
      state: "awaiting_confirm",
      number,
      numberMasked: maskPhoneNumber(number),
      contactName: input.contactName?.trim() || undefined,
      goal,
      facts: input.facts ?? {},
      mustAsk: (input.mustAsk ?? []).map((q) => String(q).trim()).filter(Boolean),
      fallback: input.fallback?.trim() || undefined,
      script: input.script?.trim() || undefined,
      maxDurationSec: Math.min(
        Math.max(30, Math.floor(input.maxDurationSec ?? this.config.defaultMaxDurationSec)),
        this.config.defaultMaxDurationSec,
      ),
    };
    this.sessions.set(session.callId, session);
    await this.persist(session);
    await this.audit("prepare", session);

    return {
      ok: true,
      callId: session.callId,
      state: session.state,
      numberMasked: session.numberMasked,
      // 确认卡：LLM 必须把 cardMarker 原样放在回复最前面（服务端 buildReplyBlocks
      // 确定性拆块，客户端 AgentActionChoiceCard 渲染按钮，点击经 chat.user_action 回传）。
      cardMarker: buildConfirmCardMarker(session),
      summary:
        "确认卡已生成。把 cardMarker 原样放在回复最前面，等待用户点击「确认拨打」。" +
        "用户点击确认后（下一轮）才可调用 phone_call.start；用户未点击确认时严禁调用 phone_call.start。" +
        "注意：这是真实电话（对方是真人、将产生话费），确认卡与话术要点中须如实说明。",
    };
  }

  // ── 确认门（connection.ts chat.user_action / chat-user-message 文本兜底调用）──

  /**
   * 消费确认卡按钮点击：actionId=phone_call_confirm 记录确认；phone_call_cancel 直接取消。
   * 这是确认门的权威证据源——LLM 无法伪造（点击在 WS 层被捕获并写入会话）。
   */
  observeCardAction(
    actorId: string,
    action: { cardId?: string; actionId?: string; payload?: Record<string, unknown> },
  ): void {
    const actionId = String(action.actionId ?? "");
    if (actionId !== "phone_call_confirm" && actionId !== "phone_call_cancel") return;
    const callId = String(action.payload?.callId ?? "");
    if (!callId) return;
    const session = this.sessions.get(callId);
    if (!session || session.actorId !== actorId) return;

    if (actionId === "phone_call_confirm") {
      if (session.state !== "awaiting_confirm") return;
      if (this.now().getTime() - new Date(session.createdAt).getTime() > this.config.confirmTtlMs) {
        session.state = "expired";
        session.rejectReason = "confirm_timeout";
        void this.persist(session).then(() => this.audit("expire", session)).catch(() => {});
        return;
      }
      session.confirmedAt = this.now().toISOString();
      session.confirmedVia = "card_click";
      void this.persist(session).then(() => this.audit("confirm", session, { via: "card_click" })).catch(() => {});
      this.pushStatus(session, { confirmed: true });
      return;
    }

    // 取消
    if (session.state !== "awaiting_confirm") return;
    session.state = "cancelled";
    session.rejectReason = "user_cancelled_card";
    void this.persist(session).then(() => this.audit("cancel", session)).catch(() => {});
    this.pushStatus(session);
  }

  /**
   * 文本兜底确认：会话等待确认期间，用户消息明确表达「确认拨打」时记录确认
   * （确认卡按钮渲染失败/旧客户端场景）。正则严格全短语匹配，避免误伤无关确认。
   */
  observeUserText(actorId: string, text: string): void {
    const trimmed = (text ?? "").trim();
    if (!trimmed || !TEXT_CONFIRM_RE.test(trimmed)) return;
    const pending = [...this.sessions.values()]
      .filter((s) => s.actorId === actorId && s.state === "awaiting_confirm")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!pending) return;
    if (this.now().getTime() - new Date(pending.createdAt).getTime() > this.config.confirmTtlMs) return;
    pending.confirmedAt = this.now().toISOString();
    pending.confirmedVia = "text";
    void this.persist(pending).then(() => this.audit("confirm", pending, { via: "text" })).catch(() => {});
    this.pushStatus(pending, { confirmed: true });
  }

  // ── start：确认门校验 → 经手机桥拨出 ────────────────────────────────

  async start(
    actorId: string,
    callId: string,
    opts: { phoneBridgeOnline?: boolean; chatUserMessageId?: string; sessionId?: string } = {},
  ): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!this.config.enabled) {
      return rejectResult("电话代办能力未启用（PHONE_CALL_ENABLED=false）");
    }
    const session = this.sessions.get(callId);
    if (!session || session.actorId !== actorId) {
      return rejectResult(`通话会话不存在：${callId}。请先用 phone_call.prepare 生成确认卡。`);
    }

    // 同轮去重：同一轮内对同一 callId 重复 start 返回既有结果（防模型重试双拨）
    const roundId = opts.chatUserMessageId || opts.sessionId || actorId;
    const dedupKey = `${roundId}:${callId}`;
    const deduped = this.startDedup.get(dedupKey);
    if (deduped) return { ...deduped, deduped: true };

    if (session.state === "awaiting_confirm") {
      // TTL 先判：等待确认（含已确认未拨出）超过窗口一律作废，防止陈旧确认被迟到执行
      if (this.now().getTime() - new Date(session.createdAt).getTime() > this.config.confirmTtlMs) {
        session.state = "expired";
        session.rejectReason = "confirm_timeout";
        await this.persist(session);
        await this.audit("expire", session);
        return rejectResult("确认已超时作废。请重新 phone_call.prepare 生成新的确认卡。", { callId, state: session.state });
      }
      if (!session.confirmedAt) {
        return rejectResult(
          "用户尚未确认：确认卡上的「确认拨打」未被点击（或用户文本未明确确认）。未经用户确认严禁拨出——这是硬约束，不能以任何理由绕过。",
          { callId, state: session.state },
        );
      }
    }
    if (session.state !== "awaiting_confirm") {
      return rejectResult(
        `会话状态为 ${session.state}（${session.rejectReason ?? "非待确认态"}），不能拨出。如需重试请重新 phone_call.prepare。`,
        { callId, state: session.state },
      );
    }

    const quiet = isInQuietHours(this.config.quietHours, this.now());
    if (quiet) {
      session.state = "cancelled";
      session.rejectReason = "quiet_hours";
      await this.persist(session);
      await this.audit("reject", session, { reason: "quiet_hours" });
      return rejectResult(`当前处于静默时段（${this.config.quietHours}），禁止外呼。`, { callId });
    }

    const freq = this.frequencyReject(actorId, session.number);
    if (freq) {
      session.state = "cancelled";
      session.rejectReason = "frequency_limit";
      await this.persist(session);
      await this.audit("reject", session, { reason: "frequency_limit" });
      return rejectResult(freq, { callId });
    }

    if (!opts.phoneBridgeOnline || !this.deps.bridge.hasExecutor(actorId)) {
      // 不消费会话：桥接恢复后可再次 start（确认仍有效，TTL 内）
      return {
        ok: false,
        retryable: true,
        callId,
        state: session.state,
        error: "手机桥接未在线：请在手机端 App 保持登录并启用桥接连接后重试（确认卡在有效期内仍然有效）。",
      };
    }

    session.state = "dialing";
    session.sessionId = opts.sessionId ?? session.sessionId;
    await this.persist(session);
    await this.audit("start", session);
    this.pushStatus(session);

    const result = await this.deps.bridge.invoke(
      actorId,
      "dial",
      {
        number: session.number,
        contactName: session.contactName ?? "",
        // 手机端全屏确认弹窗展示的拨号事由（用户在手机上的第二次确认依据）
        reason: `电话代办：${session.goal}`.slice(0, 80),
        mode: "direct",
      },
      this.config.dialTimeoutMs,
    );

    const dialState = String(result.state ?? "");
    session.dialState = dialState;

    if (result.ok && (dialState === "dialing" || dialState === "dialer_opened")) {
      session.state = "active";
      session.activeAt = this.now().toISOString();
      await this.persist(session);
      await this.audit("dial_ok", session, { dialState });
      this.pushStatus(session);
      const outcome: Record<string, unknown> = {
        ok: true,
        callId,
        state: session.state,
        dialState,
        numberMasked: session.numberMasked,
        summary:
          dialState === "dialing"
            ? "已在手机上确认并拨出，通话中（P0 为用户亲自通话）。通话结束后提醒用户告知结果，再调用 phone_call.finish 回填。"
            : "已打开手机拨号盘并填好号码，等用户在手机上按下拨号键。通话结束后调用 phone_call.finish 回填。",
      };
      this.startDedup.set(dedupKey, outcome);
      return outcome;
    }

    // 手机端确认被取消 / 拨号失败
    session.state = result.ok && dialState === "cancelled" ? "cancelled" : "failed";
    session.rejectReason = result.ok
      ? "device_confirm_cancelled"
      : `dial_failed:${String(result.error ?? dialState ?? "unknown")}`;
    await this.persist(session);
    await this.audit("dial_fail", session, { dialState, error: result.error });
    this.pushStatus(session);
    const failure: Record<string, unknown> = {
      ok: false,
      callId,
      state: session.state,
      error:
        dialState === "cancelled"
          ? "手机端确认被取消（用户拒绝或超时未确认），未拨出。"
          : `拨号未完成：${String(result.error ?? dialState ?? "手机端异常")}`,
      summary: "拨号未成功。可向用户说明后，经用户同意重新 phone_call.prepare。",
    };
    this.startDedup.set(dedupKey, failure);
    return failure;
  }

  // ── status / list / cancel ──────────────────────────────────────────

  async status(actorId: string, callId: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const session = this.sessions.get(callId);
    if (!session || session.actorId !== actorId) {
      return { ok: false, error: `通话会话不存在：${callId}` };
    }
    const elapsedSec =
      session.activeAt
        ? Math.floor((this.now().getTime() - new Date(session.activeAt).getTime()) / 1000)
        : 0;
    return {
      ok: true,
      callId,
      state: session.state,
      numberMasked: session.numberMasked,
      contactName: session.contactName,
      goal: session.goal,
      facts: session.facts,
      mustAsk: session.mustAsk,
      confirmed: Boolean(session.confirmedAt),
      confirmedVia: session.confirmedVia,
      dialState: session.dialState,
      outcome: session.outcome,
      elapsedSec,
      maxDurationSec: session.maxDurationSec,
      rejectReason: session.rejectReason,
    };
  }

  async list(actorId: string, limit = 10): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const items = [...this.sessions.values()]
      .filter((s) => s.actorId === actorId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(1, limit), 50))
      .map((s) => ({
        callId: s.callId,
        state: s.state,
        numberMasked: s.numberMasked,
        contactName: s.contactName,
        goal: s.goal,
        outcome: s.outcome,
        createdAt: s.createdAt,
      }));
    return { ok: true, items, summary: `共 ${items.length} 条外呼会话（号码已脱敏）。` };
  }

  async cancel(actorId: string, callId: string, reason = "user_cancelled"): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const session = this.sessions.get(callId);
    if (!session || session.actorId !== actorId) {
      return { ok: false, error: `通话会话不存在：${callId}` };
    }
    if (session.state !== "awaiting_confirm" && session.state !== "dialing") {
      return { ok: false, error: `会话状态为 ${session.state}，无需取消`, state: session.state };
    }
    session.state = "cancelled";
    session.rejectReason = reason;
    await this.persist(session);
    await this.audit("cancel", session, { reason });
    this.pushStatus(session);
    return { ok: true, callId, state: session.state, summary: "已取消该外呼会话。" };
  }

  // ── finish：挂断后结果回填 ──────────────────────────────────────────

  async finish(actorId: string, input: PhoneCallFinishInput): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!this.config.enabled) {
      return rejectResult("电话代办能力未启用（PHONE_CALL_ENABLED=false）");
    }
    const session = this.sessions.get(input.callId);
    if (!session || session.actorId !== actorId) {
      return { ok: false, error: `通话会话不存在：${input.callId}` };
    }
    if (session.state !== "active" && session.state !== "dialing") {
      return {
        ok: false,
        error: `会话状态为 ${session.state}，仅通话中（active/dialing）可回填结果`,
        state: session.state,
      };
    }
    const outcome = input.outcome;
    const validOutcomes: PhoneCallOutcome[] = ["booked", "confirmed", "info_got", "callback_later", "no_answer", "failed", "other"];
    if (!validOutcomes.includes(outcome)) {
      return { ok: false, error: `outcome 须为 ${validOutcomes.join("/")} 之一` };
    }
    if (outcome === "other" && !String(input.detail ?? "").trim()) {
      return { ok: false, error: "outcome=other 时必须填写 detail 说明实际结果" };
    }

    session.outcome = outcome;
    session.outcomeDetail = input.detail?.trim() || undefined;
    session.appointmentTime = input.appointmentTime?.trim() || undefined;
    session.bookingRef = input.bookingRef?.trim() || undefined;
    session.followUps = (input.followUps ?? []).map((f) => String(f).trim()).filter(Boolean);
    session.state = "summarized";
    session.endedAt = session.endedAt ?? this.now().toISOString();
    session.summarizedAt = this.now().toISOString();
    await this.persist(session);
    await this.audit("finish", session, {
      outcome,
      hasAppointmentTime: Boolean(session.appointmentTime),
      hasBookingRef: Boolean(session.bookingRef),
    });
    this.pushStatus(session);

    // 收件箱必达回执（离线也能在邮箱拉到）；WS 失败不影响主链路
    const inbox = this.inboxPort ?? this.deps.inbox;
    if (inbox) {
      try {
        const lines = [
          `对象：${session.contactName ? `${session.contactName} ` : ""}${session.numberMasked}`,
          `目标：${session.goal}`,
          `结果：${outcomeLabel(outcome)}${session.outcomeDetail ? `——${session.outcomeDetail}` : ""}`,
          session.appointmentTime ? `预约时间：${session.appointmentTime}` : "",
          session.bookingRef ? `预约号/凭据：${session.bookingRef}` : "",
          ...(session.followUps ?? []).map((f) => `后续：${f}`),
        ].filter(Boolean);
        await inbox.send({
          actorId,
          title: `📞 通话回执：${session.goal.slice(0, 24)}`,
          body: lines.join("\n"),
          kind: "phone_call",
          importance: outcome === "booked" || outcome === "confirmed" ? "normal" : "low",
          messageId: `phone_call_${session.callId}`,
        });
      } catch {
        // 收件箱失败不阻断结果返回
      }
    }

    return {
      ok: true,
      callId: input.callId,
      state: session.state,
      outcome,
      resultSummary: buildFinishSummary(session),
      summary:
        "结果已回填（会话归档 + 收件箱回执）。请向用户输出结果卡/摘要；" +
        (session.appointmentTime
          ? "含预约时间，建议提示用户是否写入日程（可用日程工具直接创建）。"
          : "") +
        (session.followUps?.length ? " 存在待办跟进项，提醒用户或建日程。" : ""),
    };
  }
}

/** 结果摘要（给 LLM 的结构化回填内容；号码脱敏） */
function buildFinishSummary(session: PhoneCallSession): string {
  const lines = [
    `与 ${session.contactName ? `${session.contactName}（${session.numberMasked}）` : session.numberMasked} 的通话已结束`,
    `目标：${session.goal}`,
    `结果：${outcomeLabel(session.outcome!)}`,
    session.outcomeDetail ? `详情：${session.outcomeDetail}` : "",
    session.appointmentTime ? `预约时间：${session.appointmentTime}` : "",
    session.bookingRef ? `预约号/凭据：${session.bookingRef}` : "",
    ...(session.followUps ?? []).map((f) => `待跟进：${f}`),
  ].filter(Boolean);
  return lines.join("\n");
}

function outcomeLabel(outcome: PhoneCallOutcome): string {
  switch (outcome) {
    case "booked": return "预约成功";
    case "confirmed": return "对方已确认";
    case "info_got": return "已获取信息";
    case "callback_later": return "对方要求稍后回电";
    case "no_answer": return "无人接听/占线";
    case "failed": return "未能达成";
    case "other": return "其他";
  }
}

/** 确认卡 marker：LLM 原样嵌入回复开头；服务端 buildReplyBlocks 拆块后客户端渲染按钮。 */
export function buildConfirmCardMarker(session: PhoneCallSession): string {
  const items: Array<Record<string, unknown>> = [
    { type: "num", text: `拨打对象：${session.contactName ? `${session.contactName} · ` : ""}${session.numberMasked}（真实号码）` },
    { type: "num", text: `通话目标：${session.goal}` },
  ];
  for (const [k, v] of Object.entries(session.facts ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    items.push({ type: "num", text: `已知要素 · ${k}：${String(v)}` });
  }
  if (session.mustAsk.length > 0) {
    items.push({ type: "num", text: `待确认事项：${session.mustAsk.join("；")}` });
  }
  if (session.fallback) {
    items.push({ type: "num", text: `底线方案：${session.fallback}` });
  }
  items.push({ type: "num", text: "⚠️ 这是真实电话：对方是真人、将产生真实话费；手机端还需二次确认" });
  const card = {
    cardType: "steps",
    title: "📞 确认拨打",
    items,
    footer: "点击「确认拨打」后，你的手机将弹出拨号确认并真实呼出（通话由你亲自进行）",
    cardId: `phone_call_${session.callId}`,
    actions: [
      { id: "phone_call_confirm", label: "确认拨打", variant: "primary", payload: { callId: session.callId } },
      { id: "phone_call_cancel", label: "取消", variant: "secondary", payload: { callId: session.callId } },
    ],
  };
  return `[AGENT_RESULT_CARD_START]\n${JSON.stringify(card)}\n[AGENT_RESULT_CARD_END]`;
}
