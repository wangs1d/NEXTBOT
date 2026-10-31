/**
 * 引用锚点存储（Recall Anchor Store）—— 记忆连续性诊断（Phase 2）
 *
 * 记录每一轮 recall 实际注入的"记忆锚点"（query + 召回条目摘要），
 * 与记忆强度模型（memory-strength-model）、跨会话开放环路（session-epitome）配合，
 * 提供"连续性诊断"数据：最近注入了什么记忆、哪些被用户反馈降权、上一会话遗留了什么。
 *
 * 用途：
 * - 定位"上下文跳转"根因：看某轮注入了哪些记忆，与回复/反馈交叉比对；
 * - 调试记忆仲裁：确认 agentic / humanLike / narrative 多通道融合后实际进了 prompt 的条目。
 *
 * 设计约束：
 * - 条目 content 只存前 80 字符（诊断摘要，不进 prompt），避免 KV 膨胀；
 * - 每 actor 保留最近 MAX_RECORDS（8）条，写入时滚动淘汰；
 * - KV 持久化失败静默降级（不阻塞 recall 主链路）。
 */

import { STRENGTH_KV_KEY } from "../brain/memory-strength-model.js";
import { EPITOME_KV_KEY } from "./session-epitome.js";
import { RetentionMap, retentionMaxEntries } from "./resource-pool.js";

export interface RecallAnchorItem {
  /** 记忆正文摘要（前 80 字符） */
  content: string;
  score?: number;
  source?: string;
}

export interface RecallAnchorRecord {
  query: string;
  recalledAt: string;
  items: RecallAnchorItem[];
}

/** KV 持久化适配器（与 KvSummaryLike 同形状）。 */
export interface AnchorKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

export const ANCHOR_KV_KEY = "recall_anchors";
const MAX_RECORDS = 8;
const MAX_ITEM_CHARS = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, max = MAX_ITEM_CHARS): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function parseRecord(value: unknown): RecallAnchorRecord | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? (o.items as unknown[])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((it) => ({
          content: clip(typeof it.content === "string" ? it.content : ""),
          score: typeof it.score === "number" ? it.score : undefined,
          source: typeof it.source === "string" ? it.source : undefined,
        }))
        .filter((it) => it.content.length > 0)
    : [];
  return {
    query: typeof o.query === "string" ? o.query : "",
    recalledAt: typeof o.recalledAt === "string" ? o.recalledAt : nowIso(),
    items,
  };
}

/**
 * 引用锚点存储：进程内 per-actor 缓存 + KV 懒加载持久化。
 */
export class RecallAnchorStore {
  private kv: AnchorKvLike | null;
  /** 有界缓存：actor 数超上限按最近未用淘汰，空闲 6h 由资源池心跳清扫；重建只多一次 KV 读。 */
  private cache = new RetentionMap<RecallAnchorRecord[]>("recall-anchors", {
    maxEntries: retentionMaxEntries(2000),
    idleMs: 6 * 60 * 60_000,
  });

  constructor(kv: AnchorKvLike | null = null) {
    this.kv = kv;
  }

  attach(kv: AnchorKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): RecallAnchorRecord[] {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let records: RecallAnchorRecord[] = [];
    if (this.kv) {
      try {
        const raw = this.kv.getSnapshot(actorId, [ANCHOR_KV_KEY]);
        const stored = raw?.entries?.[ANCHOR_KV_KEY];
        if (Array.isArray(stored)) {
          records = stored
            .map(parseRecord)
            .filter((r): r is RecallAnchorRecord => r !== null)
            .slice(-MAX_RECORDS);
        }
      } catch {
        /* KV 读取失败使用空列表 */
      }
    }
    this.cache.set(actorId, records);
    return records;
  }

  private persist(actorId: string): void {
    if (!this.kv?.setEntry) return;
    const records = this.cache.get(actorId);
    if (!records) return;
    try {
      this.kv.setEntry(actorId, ANCHOR_KV_KEY, records);
    } catch {
      /* 持久化失败不阻塞 */
    }
  }

  /** 记录一轮 recall 的注入锚点（滚动保留最近 MAX_RECORDS 条）。 */
  record(actorId: string, query: string, items: RecallAnchorItem[]): void {
    const clippedItems = items
      .map((it) => ({
        content: clip(it.content),
        score: typeof it.score === "number" ? it.score : undefined,
        source: it.source,
      }))
      .filter((it) => it.content.length > 0);
    if (clippedItems.length === 0) return;

    const records = this.load(actorId);
    records.push({
      query: clip(query, 120),
      recalledAt: nowIso(),
      items: clippedItems.slice(0, 5),
    });
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }
    this.persist(actorId);
  }

  /** 读取某 actor 的最近召回锚点（诊断用）。 */
  get(actorId: string): RecallAnchorRecord[] {
    return this.load(actorId);
  }
}

/**
 * 连续性诊断快照：汇总最近召回锚点 + 反馈惩罚 + 跨会话开放环路。
 * 供 /brain/memory/continuity/diagnose 路由返回。
 */
export function buildContinuityDiagnosis(
  actorId: string,
  anchors: RecallAnchorRecord[],
  feedbackSnapshot: unknown,
  epitomeSnapshot: unknown,
): {
  actorId: string;
  recalledAt: string;
  recentRecalls: RecallAnchorRecord[];
  feedback: unknown;
  epitome: unknown;
} {
  return {
    actorId,
    recalledAt: nowIso(),
    recentRecalls: anchors,
    feedback: feedbackSnapshot,
    epitome: epitomeSnapshot,
  };
}

export { STRENGTH_KV_KEY as FEEDBACK_KV_KEY, EPITOME_KV_KEY };
