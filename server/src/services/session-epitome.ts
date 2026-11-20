/**
 * 跨会话开放环路（Session Epitome）—— 记忆连续性优化 Phase 2
 *
 * 背景缺口：`recentConversationHistory` 只在会话内注入；换会话后，
 * 上一会话的"未完成请求、Agent 承诺、进行中状态"没有显式传递，
 * 这正是"换了会话就跳转/失忆"的常见根源。
 *
 * 本模块模拟人类的"跨会话记忆"：
 * - 每轮 cognize 结束后，从本轮对话提取开放环路（open loops：未完成请求）、
 *   承诺（Agent commitments）、偏好（用户偏好/事实）；
 * - 按 actor 持久化到 KV（key `session_epitome`），增量合并、去重、限量；
 * - 新会话开场（thread 较短）时注入【上一会话待办】块，让连续性跨会话延续。
 *
 * 设计约束：
 * - 规则驱动提取（复用 memory-signal 正则），不调 LLM，低延迟可测；
 * - KV 持久化失败静默降级（不影响对话主链路）；
 * - 分类互斥：同一行只归入一类，避免重复。
 */

import type { MemoryItem } from "../brain/types.js";
import { AGENT_COMMITMENT_RE, MEMORY_EXPLICIT_RE } from "../agent/memory-signal.js";
import { isPollutedMemoryLine } from "../agent/memory-line-hygiene.js";
import { contentTokenSet, normalizeMemoryLine, tokenOverlapRatio } from "./memory-record-utils.js";

export type EpitomeEntryKind = "open_loop" | "commitment" | "preference";

export interface SessionEpitomeEntries {
  openLoops: string[];
  commitments: string[];
  preferences: string[];
}

export interface SessionEpitomeSnapshot extends SessionEpitomeEntries {
  updatedAt: string;
  revision: number;
}

/** record() 返回值：合并后快照 + 本轮被关闭（检测为已完成）的 open loop 原文。 */
export interface RecordEpitomeResult {
  snapshot: SessionEpitomeSnapshot;
  /** 本轮被完成语义关闭的 open loops —— 供 ProactivityHub 触发"待办完成恭喜"。 */
  closedLoops: string[];
}

/** 内部存储条目（P3：带创建时间，支持 TTL 过滤与完成检测）。 */
interface EpitomeEntry {
  text: string;
  createdAt: string;
}

/** KV 持久化适配器（与 KvSummaryLike 同形状）。 */
export interface EpitomeKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

export const EPITOME_KV_KEY = "session_epitome";

const MAX_ENTRIES_PER_KIND = 6;
/** open loop 生命周期（P3）：7 天未被完成/提及即过期，不再注入【上一会话待办】。 */
const OPEN_LOOP_TTL_MS = 7 * 86_400_000;
/** 完成语义（P3）：用户表示某事已搞定/不再需要时，关闭对应的 open loop。 */
const LOOP_DONE_RE = /搞[定掂]|办[完妥]|已完成|已经完成|做完了|解决了|处理完|不用了|不需要了|取消/i;
/** loop 与本轮文本的词重叠阈值：足够高才认定"说的是同一件事"。 */
const LOOP_CLOSE_OVERLAP = 0.2;

// 用户请求信号（开放环路）：请求/待办/安排/提醒 语义
const USER_REQUEST_RE = /请|帮我|需要|想要|安排|提醒|订|买|查|分析|总结|继续|修复|优化|看看|做一个|我要|我想/i;
// 进行中/未完成语义
const OPEN_LOOP_RE = /还没|尚未|未完成|待办|稍后|回头|之后再|记得帮我|别忘/i;

function nowIso(): string {
  return new Date().toISOString();
}

function clampList(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const normalized = typeof item === "string" ? item.trim().replace(/\s+/g, " ") : "";
    if (!normalized || normalized.length < 4) continue;
    const key = normalizeMemoryLine(normalized).slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 从一行文本归类 epitome 条目（互斥：只归入一类）。
 * 优先判定 open loop（请求语义）→ commitment（Agent 承诺）→ preference（偏好/事实）。
 */
export function classifyEpitomeLine(line: string): EpitomeEntryKind | null {
  const t = typeof line === "string" ? line.trim() : "";
  if (!t || t.length < 4) return null;
  // 显式前缀优先（detectMemorySignals / recap 行的结构化前缀）
  if (/^\[用户要求记住\]|^\[Agent 承诺\/结论\]|^\[用户偏好\]|^\[用户事实\]/.test(t)) {
    if (t.startsWith("[Agent 承诺/结论]")) return "commitment";
    if (t.startsWith("[用户要求记住]")) return "preference";
    return "preference";
  }
  // 写入侧行体检（2026-11-20 根修）：协议残留 / 逐字对话行不进 epitome。
  // 此前只有注入侧（memory-line-hygiene）兜底，「委派子 Agent 处理：」这类
  // 结构性残留从写入侧漏进长期库，存量脏行由此产生。判定全部是结构性
  // （协议标记 / 角色前缀），不做语言层猜测。
  if (isPollutedMemoryLine(t)) return null;
  // Agent 承诺优先于请求：承诺行常含"提醒/安排/设置"等与请求重合的词
  // （如"已为你设置提醒"），必须先判承诺，否则会被请求规则截胡。
  if (AGENT_COMMITMENT_RE.test(t)) return "commitment";
  if (OPEN_LOOP_RE.test(t) || USER_REQUEST_RE.test(t)) return "open_loop";
  if (MEMORY_EXPLICIT_RE.test(t)) return "preference";
  return null;
}

/**
 * 从本轮对话提取 epitome 条目。
 * @param query 用户输入
 * @param writes 本轮认知产出的记忆写入（MemoryItem[]）
 * @param assistantText 可选：Agent 回复文本（提取承诺）
 */
export function extractEpitomeEntries(
  query: string,
  writes: MemoryItem[] = [],
  assistantText?: string,
): SessionEpitomeEntries {
  const openLoops: string[] = [];
  const commitments: string[] = [];
  const preferences: string[] = [];

  const push = (kind: EpitomeEntryKind, line: string): void => {
    const t = typeof line === "string" ? line.trim() : "";
    if (!t || t.length < 4) return;
    if (kind === "open_loop") openLoops.push(t);
    else if (kind === "commitment") commitments.push(t);
    else preferences.push(t);
  };

  // 1) 用户输入：请求语义 → 开放环路；显式记住 → 偏好
  if (query) {
    const q = query.trim();
    const kind = classifyEpitomeLine(q);
    if (kind === "open_loop") push("open_loop", q);
    else if (kind === "preference") push("preference", q);
  }

  // 2) 记忆写入：按 content 归类
  for (const w of writes) {
    if (!w || typeof w.content !== "string") continue;
    const kind = classifyEpitomeLine(w.content);
    if (kind) push(kind, w.content);
  }

  // 3) Agent 回复：承诺/结论
  if (assistantText) {
    const kind = classifyEpitomeLine(assistantText);
    if (kind === "commitment") push("commitment", assistantText);
  }

  return {
    openLoops: clampList(openLoops, MAX_ENTRIES_PER_KIND),
    commitments: clampList(commitments, MAX_ENTRIES_PER_KIND),
    preferences: clampList(preferences, MAX_ENTRIES_PER_KIND),
  };
}

/** 旧 KV 条目兼容解析：string（旧格式）或 { text, createdAt }（新格式）。 */
function parseEntryList(value: unknown): EpitomeEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x): EpitomeEntry | null => {
      if (typeof x === "string") return x.trim() ? { text: x.trim(), createdAt: "" } : null;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const text = typeof o.text === "string" ? o.text.trim() : "";
        const createdAt = typeof o.createdAt === "string" ? o.createdAt : "";
        return text ? { text, createdAt } : null;
      }
      return null;
    })
    .filter((x): x is EpitomeEntry => x !== null);
}

/** 内部存储快照（条目带时间戳）。 */
interface StoredEpitomeSnapshot {
  openLoops: EpitomeEntry[];
  commitments: EpitomeEntry[];
  preferences: EpitomeEntry[];
  updatedAt: string;
  revision: number;
}

function emptyStored(): StoredEpitomeSnapshot {
  return { openLoops: [], commitments: [], preferences: [], updatedAt: "", revision: 0 };
}

/** 解析 KV 值为内部快照（兼容旧 string[] 格式）。 */
function parseStored(value: unknown): StoredEpitomeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  return {
    openLoops: parseEntryList(o.openLoops),
    commitments: parseEntryList(o.commitments),
    preferences: parseEntryList(o.preferences),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
    revision: typeof o.revision === "number" ? o.revision : 0,
  };
}

/**
 * 存量清洗（2026-11-20 根修）：KV 里的历史脏行（写入侧洞补上之前入库的）
 * 读取时剔除并回写。与 memory-line-hygiene 同哲学：判据全部结构性
 * （协议残留 / 角色前缀行），不做语言层猜测，无命中时字节恒定。
 */
function sanitizeStoredSnapshot(stored: StoredEpitomeSnapshot): StoredEpitomeSnapshot {
  const baseKeep = (e: EpitomeEntry): boolean => {
    const t = typeof e?.text === "string" ? e.text.trim() : "";
    if (!t) return false;
    // 结构化前缀行（含 [Agent 承诺/结论] commitment）是合法形态，豁免污染判定
    if (/^\[(?:用户要求记住|用户偏好|用户事实|Agent 承诺\/结论|关键钉)\]/.test(t)) return true;
    if (isPollutedMemoryLine(t)) return false;
    return true;
  };
  const filterList = (
    list: EpitomeEntry[],
    keep: (e: EpitomeEntry) => boolean,
  ): EpitomeEntry[] | null => {
    const out = list.filter(keep);
    return out.length === list.length ? null : out;
  };
  const openLoops = filterList(stored.openLoops, baseKeep);
  const commitments = filterList(stored.commitments, baseKeep);
  const preferences = filterList(stored.preferences, baseKeep);
  if (openLoops === null && commitments === null && preferences === null) return stored;
  return {
    openLoops: openLoops ?? stored.openLoops,
    commitments: commitments ?? stored.commitments,
    preferences: preferences ?? stored.preferences,
    updatedAt: stored.updatedAt,
    revision: stored.revision,
  };
}

/**
 * 跨会话开放环路存储：进程内 per-actor 缓存 + KV 懒加载持久化。
 * 纯逻辑可单测；KvLike 可注入 mock。
 *
 * P3 生命周期：
 * - open loop 带 createdAt，超过 TTL（7 天）在 get() 时过滤（过期不再注入）；
 * - 完成检测：record 传入本轮对话文本（turnText），含完成语义且与某 loop 词重叠
 *   足够高时关闭该 loop（"这事搞定了"不再出现在下一会话的待办里）。
 */
export class SessionEpitomeStore {
  private kv: EpitomeKvLike | null;
  private cache = new Map<string, StoredEpitomeSnapshot>();

  constructor(kv: EpitomeKvLike | null = null) {
    this.kv = kv;
  }

  /** 绑定 KV 持久化适配器。 */
  attach(kv: EpitomeKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): StoredEpitomeSnapshot {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let snapshot = emptyStored();
    if (this.kv) {
      try {
        const raw = this.kv.getSnapshot(actorId, [EPITOME_KV_KEY]);
        if (raw?.entries?.[EPITOME_KV_KEY]) snapshot = parseStored(raw.entries[EPITOME_KV_KEY]) ?? emptyStored();
      } catch {
        /* KV 读取失败使用空快照 */
      }
    }
    // 存量清洗：剔除写入侧洞产生的历史脏行；有剔除即回写 KV（revision 由 persist 自增）
    const cleaned = sanitizeStoredSnapshot(snapshot);
    this.cache.set(actorId, cleaned);
    if (cleaned !== snapshot) this.persist(actorId);
    return cleaned;
  }

  private persist(actorId: string): void {
    if (!this.kv?.setEntry) return;
    const cached = this.cache.get(actorId);
    if (!cached) return;
    cached.revision += 1;
    try {
      this.kv.setEntry(actorId, EPITOME_KV_KEY, cached);
    } catch {
      /* 持久化失败不阻塞 */
    }
  }

  /**
   * 增量合并本轮提取的条目（去重、限量、关闭已完成 loop），并持久化。
   * @param opts.turnText 本轮用户输入 + Agent 回复（用于 open loop 完成检测）
   * @returns 合并后快照 + 本轮被关闭的 open loops（供主动恭喜触发）
   */
  record(actorId: string, entries: SessionEpitomeEntries, opts?: { turnText?: string }): RecordEpitomeResult {
    const current = this.load(actorId);
    const now = nowIso();
    const toEntries = (texts: string[]): EpitomeEntry[] =>
      clampList(texts, MAX_ENTRIES_PER_KIND).map((text) => ({ text, createdAt: now }));

    // P3 完成检测：本轮文本含完成语义且与存量 loop 足够相关 → 关闭
    const survivedLoops = closeCompletedLoops(current.openLoops, opts?.turnText);
    // 被关闭项 diff 透出（引用相等：closeCompletedLoops 只 filter 不复制条目）
    const closedLoops = current.openLoops
      .filter((loop) => !survivedLoops.includes(loop))
      .map((loop) => loop.text);

    const merge = (existing: EpitomeEntry[], incoming: EpitomeEntry[]): EpitomeEntry[] => {
      const merged = [...incoming, ...existing.map((e) => ({ ...e, createdAt: e.createdAt || now }))];
      const seen = new Set<string>();
      return merged.filter((e) => {
        const key = normalizeMemoryLine(e.text).slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, MAX_ENTRIES_PER_KIND);
    };

    const next: StoredEpitomeSnapshot = {
      openLoops: merge(survivedLoops, toEntries(entries.openLoops)),
      commitments: merge(current.commitments, toEntries(entries.commitments)),
      preferences: merge(current.preferences, toEntries(entries.preferences)),
      updatedAt: now,
      revision: current.revision,
    };
    this.cache.set(actorId, next);
    this.persist(actorId);
    return { snapshot: this.toSnapshot(next), closedLoops };
  }

  /** 读取某 actor 的 epitome 快照（open loop 过滤 TTL 过期条目）。 */
  get(actorId: string): SessionEpitomeSnapshot {
    return this.toSnapshot(this.load(actorId));
  }

  private toSnapshot(stored: StoredEpitomeSnapshot): SessionEpitomeSnapshot {
    const now = Date.now();
    const alive = (e: EpitomeEntry): boolean => {
      const ts = Date.parse(e.createdAt);
      // createdAt 为空（旧格式存量）保留，等下轮 record 补时间戳
      return !Number.isFinite(ts) || now - ts < OPEN_LOOP_TTL_MS;
    };
    return {
      openLoops: stored.openLoops.filter(alive).map((e) => e.text),
      commitments: stored.commitments.map((e) => e.text),
      preferences: stored.preferences.map((e) => e.text),
      updatedAt: stored.updatedAt,
      revision: stored.revision,
    };
  }
}

/** 完成检测：turnText 含完成语义时，关闭与之词重叠达标的存量 loop。 */
function closeCompletedLoops(loops: EpitomeEntry[], turnText: string | undefined): EpitomeEntry[] {
  if (!turnText || !LOOP_DONE_RE.test(turnText) || loops.length === 0) return loops;
  const turnTokens = contentTokenSet(turnText);
  return loops.filter(
    (loop) => tokenOverlapRatio(turnTokens, contentTokenSet(loop.text)) < LOOP_CLOSE_OVERLAP,
  );
}

// ── 轮次门控（记忆链路 LLM 调用收敛 / 降频改造）───────────────

/** 一轮对话的提取原料快照（轻量引用，供批量提取）。 */
export interface EpitomeTurnSnapshot {
  /** 用户输入原文（open loop 提取的第一来源） */
  query: string;
  /** 本轮认知产出的记忆写入（MemoryItem[]） */
  writes: MemoryItem[];
  /** Agent 回复文本（提取承诺） */
  assistantText?: string;
}

/**
 * 从环境变量读取 epitome 提取轮次间隔。
 * 默认 5；非法值或 <1 按 5 处理（传 1 即恢复每轮提取的旧行为由调用方 clamp 保证）。
 */
export function loadSessionEpitomeEveryNTurns(): number {
  const raw = process.env.SESSION_EPITOME_EVERY_N_TURNS?.trim();
  if (!raw) return 5;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}

/**
 * session epitome 提取轮次门控：把「每轮提取」降频为「每 N 轮批量提取」。
 *
 * 背景：epitome 提取本身是纯规则（零 LLM），但每轮提取意味着每轮一次 KV 写与
 * revision 自增；按 N 轮批量可把写频降为 1/N。
 *
 * - 常规触发：轮次计数达 everyNTurns（SESSION_EPITOME_EVERY_N_TURNS，默认 5）
 *   时，把 pending 中累积的 N 轮快照一次性批量提取；
 * - 会话边界兜底：新会话开场轮（thread 极短）检测到 pending 有上一会话残留
 *   时立即批量提取——上一会话最后一轮的待办不丢；新会话开场注入
 *   【上一会话待办】（buildRecentConversationHistoryBlock 读 KV session_epitome）
 *   前数据已落盘（提取为同步纯内存操作，无竞态）；
 * - pending 只存轻量引用（每 actor 最多 N 条快照），提取后即清空。
 */
export class SessionEpitomeTurnGate {
  private readonly everyNTurns: number;
  private state = new Map<string, { turns: number; pending: EpitomeTurnSnapshot[] }>();

  constructor(everyNTurns: number = loadSessionEpitomeEveryNTurns()) {
    this.everyNTurns = Math.max(1, Math.floor(everyNTurns));
  }

  /**
   * 登记一轮；返回应提取的轮次批次（空数组 = 本轮不提取）。
   * @param opts.newSession 本轮是否为会话开场（thread 极短，兜底信号）
   */
  registerTurn(
    actorId: string,
    snapshot: EpitomeTurnSnapshot,
    opts?: { newSession?: boolean },
  ): EpitomeTurnSnapshot[] {
    const st = this.state.get(actorId) ?? { turns: 0, pending: [] };
    // 会话边界兜底：上一会话有残留未提取 → 连同本轮立即批量提取
    const boundary = Boolean(opts?.newSession) && st.pending.length > 0;
    st.pending.push(snapshot);
    st.turns += 1;
    if (boundary || st.turns >= this.everyNTurns) {
      const batch = st.pending;
      this.state.delete(actorId);
      return batch;
    }
    this.state.set(actorId, st);
    return [];
  }
}
