/**
 * 记忆目录（Memory Inventory）——元认知层。
 *
 * 让 agent "知道自己记住了什么"：
 *   - 统计 KV 记忆条目的规模、时间分布（今天/昨天/N天前）、高频主题；
 *   - 生成一段自然语言目录摘要（"我对你的了解：…"）注入 prompt 元认知区，
 *     用户问"你知道我什么"时 LLM 有真实依据可答，减少编造；
 *   - 暴露覆盖缺口（长期空白领域），供诊断。
 *
 * 数据源：KvSummaryLike（AgentMemorySyncService）的 memory_summary /
 * memory_preferences / memory_facts / memory_open_loops 等行式条目。
 * 纯规则统计，不调 LLM，结果带短 TTL 缓存（每 actor 60s）。
 */

export interface KvEntriesLike {
  /** 与 AgentMemorySyncService.getSnapshot 同构：读取该 actor 的 KV 记忆条目快照 */
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
}

export interface MemoryInventoryStats {
  totalLines: number;
  byKey: Array<{ key: string; lines: number }>;
  timeDistribution: { today: number; yesterday: number; lastWeek: number; older: number; unknown: number };
  topTopics: Array<{ topic: string; count: number }>;
  gaps: string[];
}

export interface MemoryInventoryReport {
  stats: MemoryInventoryStats;
  /** 自然语言目录摘要（注入 prompt 用，空串表示无记忆） */
  summary: string;
}

const INVENTORY_KEYS = [
  "memory_summary",
  "memory_preferences",
  "memory_facts",
  "memory_commitments",
  "memory_open_loops",
  "memory_current_mission",
];

const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "这", "那", "有", "不", "就",
  "都", "也", "还", "又", "要", "会", "能", "今天", "昨天", "明天", "现在", "之前", "之后",
  "用户", "助手", "the", "and", "for", "with", "that", "this",
]);

/** 从记忆行提取主题词（中文 2-6 字段 + 英文词） */
function extractTopics(text: string): string[] {
  const words: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,15}/g) ?? []) {
    if (!STOP_WORDS.has(w)) words.push(w);
  }
  for (const seg of text.match(/[\u4e00-\u9fa5]{2,6}/g) ?? []) {
    if (!STOP_WORDS.has(seg)) words.push(seg);
  }
  return words;
}

/** 从行前缀 [2026-08-23 ...] 或 [今天] 提取时间桶 */
function classifyTimeBucket(line: string, now = new Date()): "today" | "yesterday" | "lastWeek" | "older" | "unknown" {
  const m = line.match(/^\[([^\]]+)\]/);
  if (!m) return "unknown";
  const tag = m[1].trim();
  if (tag === "今天") return "today";
  if (tag === "昨天") return "yesterday";
  const daysAgo = tag.match(/^(\d+)天前$/);
  if (daysAgo) {
    const n = parseInt(daysAgo[1], 10);
    if (n <= 7) return "lastWeek";
    return "older";
  }
  // ISO 日期前缀
  const date = tag.match(/^(\d{4}-\d{2}-\d{2})/);
  if (date) {
    const d = new Date(`${date[1]}T00:00:00`);
    if (Number.isFinite(d.getTime())) {
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
      if (diffDays <= 0) return "today";
      if (diffDays === 1) return "yesterday";
      if (diffDays <= 7) return "lastWeek";
      return "older";
    }
  }
  return "unknown";
}

function toLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export class MemoryInventory {
  private readonly cache = new Map<string, { at: number; report: MemoryInventoryReport }>();
  private readonly ttlMs: number;
  private readonly kv: KvEntriesLike | null;

  constructor(kv: KvEntriesLike | null, ttlMs = 60_000) {
    this.kv = kv;
    this.ttlMs = ttlMs;
  }

  private async readEntries(actorId: string): Promise<Record<string, string>> {
    if (!this.kv) return {};
    const out: Record<string, string> = {};
    try {
      const snapshot = this.kv.getSnapshot(actorId, INVENTORY_KEYS);
      const entries = snapshot?.entries;
      if (entries) {
        for (const key of INVENTORY_KEYS) {
          const v = entries[key];
          if (typeof v === "string" && v.trim()) out[key] = v;
        }
      }
    } catch {
      /* KV 读取失败返回已收集部分（可能为空） */
    }
    return out;
  }

  /** 生成目录报告（带 TTL 缓存） */
  async getReport(actorId: string): Promise<MemoryInventoryReport> {
    const cached = this.cache.get(actorId);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.report;

    const entries = await this.readEntries(actorId);
    const now = new Date();
    const byKey: Array<{ key: string; lines: number }> = [];
    const timeDistribution = { today: 0, yesterday: 0, lastWeek: 0, older: 0, unknown: 0 };
    const topicFreq = new Map<string, number>();
    let totalLines = 0;

    for (const key of INVENTORY_KEYS) {
      const lines = toLines(entries[key]);
      if (lines.length === 0) continue;
      byKey.push({ key, lines: lines.length });
      totalLines += lines.length;
      for (const line of lines) {
        timeDistribution[classifyTimeBucket(line, now)]++;
        for (const topic of extractTopics(line)) {
          topicFreq.set(topic, (topicFreq.get(topic) ?? 0) + 1);
        }
      }
    }

    const topTopics = [...topicFreq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([topic, count]) => ({ topic, count }));

    // 覆盖缺口：核心画像类条目为空时提示。
    // 档案字段（称呼/职业/居住地…）现由结构化事实库权威持有，KV memory_facts 里
    // 不再保留副本（2026-10-09 单一权威源）——判定「基本事实」覆盖必须把事实库
    // 算进来，否则会把有档案的用户误报成缺口。
    let hasStructuredFacts = false;
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      hasStructuredFacts =
        (getMemoryComponents().factStore?.getActiveFacts?.(actorId)?.length ?? 0) > 0;
    } catch {
      /* 记忆系统未装配 */
    }
    const gaps: string[] = [];
    if (!entries["memory_preferences"]) gaps.push("偏好");
    if (!entries["memory_facts"] && !hasStructuredFacts) gaps.push("基本事实");
    if (!entries["memory_commitments"] && !entries["memory_open_loops"]) gaps.push("待办与承诺");

    const stats: MemoryInventoryStats = { totalLines, byKey, timeDistribution, topTopics, gaps };
    const report: MemoryInventoryReport = { stats, summary: buildSummary(stats) };
    this.cache.set(actorId, { at: Date.now(), report });
    return report;
  }

  /** 清缓存（写入新记忆后调用，保证下一轮目录新鲜） */
  invalidate(actorId: string): void {
    this.cache.delete(actorId);
  }

  /**
   * 同步读取缓存摘要（prompt 注入用）：
   * 缓存未命中返回空串（本轮不注入，下一轮可用了再注入）。
   * 缓存由 getReport 写入；brain-center cognize 阶段 fire-and-forget
   * 调 getInventorySummary 刷新，保证 prompt 构建时缓存大概率新鲜。
   */
  getCachedSummary(actorId: string): string {
    const hit = this.cache.get(actorId);
    return hit ? hit.report.summary : "";
  }
}

// ─── 全局单例（装配处 set，prompt-context-builder 同步 get）──────────
let globalInventory: MemoryInventory | null = null;

export function setGlobalMemoryInventory(inv: MemoryInventory | null): void {
  globalInventory = inv;
}

export function getGlobalMemoryInventory(): MemoryInventory | null {
  return globalInventory;
}

function buildSummary(stats: MemoryInventoryStats): string {
  if (stats.totalLines === 0) return "";
  const parts: string[] = [];
  const labelOf = (key: string): string => {
    switch (key) {
      case "memory_summary": return "长期记忆";
      case "memory_preferences": return "偏好";
      case "memory_facts": return "基本事实";
      case "memory_commitments": return "承诺";
      case "memory_open_loops": return "未闭环事项";
      case "memory_current_mission": return "当前使命";
      default: return key;
    }
  };
  const keyPart = stats.byKey
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 4)
    .map((k) => `${labelOf(k.key)} ${k.lines} 条`)
    .join("、");
  parts.push(`我对你现有 ${stats.totalLines} 条记忆（${keyPart}）`);

  const { today, yesterday, lastWeek } = stats.timeDistribution;
  const fresh = today + yesterday + lastWeek;
  if (fresh > 0) parts.push(`其中近 7 天新增/更新 ${fresh} 条`);
  if (stats.topTopics.length > 0) {
    parts.push(`高频话题：${stats.topTopics.slice(0, 4).map((t) => `${t.topic}(${t.count})`).join("、")}`);
  }
  if (stats.gaps.length > 0) {
    parts.push(`尚未了解的：${stats.gaps.join("、")}`);
  }
  return parts.join("；") + "。";
}
