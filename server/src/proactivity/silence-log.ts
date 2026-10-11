/**
 * 方案 B：沉默日志（Silence Log）。
 *
 * 与 suppressed（用户负反馈抑制）不同，silenced 是效用评估后**主动选择不动作**
 * （方案 A 评估器判 silence 分支）。每一次沉默都留痕，支持用户反问
 * 「你上周为什么没提醒我 XX」——按时间窗 + 关键词检索当时的评估依据
 * （净效用 / 风险分 / 命中规则），让"不作为"与"作为"同样可解释。
 *
 * 双写入方：
 *   - ProactivePipeline：仲裁 verdict=silenced（提案级沉默）
 *   - ProactivityHub：act 三分支判 silence（行动级沉默）
 * 持久化 data/proactivity/silence-log.json（未注入路径时内存态，测试用）。
 */
import { readJson, writeJson } from "./persist-file.js";

export type SilenceLogScope = "proposal" | "action" | "turn_aside" | "admission";

export type SilenceLogEntry = {
  at: number;
  actorId: string;
  kind: string;
  title: string;
  dedupKey?: string;
  source?: string;
  /**
   * 评估对象层级：
   *   proposal   = 管道提案
   *   action     = hub 行动计划
   *   turn_aside = 顺嘴挂起（等下轮织入）
   *   admission  = 时效准入闸拦截（话题年龄/相关性/静默/复活配额）
   */
  scope: SilenceLogScope;
  netUtility: number;
  riskScore: number;
  valueScore: number;
  /** 命中规则（如 net_utility_negative(...)） */
  reason: string;
};

interface SilenceFileShape {
  version: 1;
  entries: SilenceLogEntry[];
}

export type SilenceSearchOptions = {
  actorId?: string;
  /** 关键词：匹配 kind / title / reason（不区分大小写） */
  keyword?: string;
  /** 起始时刻 ms（如「上周」= now - 7d） */
  sinceMs?: number;
  kind?: string;
  limit?: number;
};

/** 保留上限（沉默是低频事件，500 条足够覆盖数月反问窗口） */
const MAX_ENTRIES = 500;

/** 同 dedupKey 沉默去重窗口：窗口内同因重复（如扫描重提交）不重复留痕 */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export class SilenceLog {
  private entries: SilenceLogEntry[] = [];
  private dirty = false;

  constructor(
    private readonly path?: string,
    private readonly maxEntries = MAX_ENTRIES,
  ) {
    if (path) {
      const raw = readJson<SilenceFileShape>(path, { version: 1, entries: [] });
      this.entries = raw.entries ?? [];
    }
  }

  /**
   * 记录一次沉默决策（管道 silenced / hub act silence 共用）。
   * 带 dedupKey 且窗口内已有同键记录时跳过（返回 false），防扫描重提交累积同因重复。
   */
  record(entry: SilenceLogEntry): boolean {
    if (entry.dedupKey) {
      const cutoff = entry.at - DEDUP_TTL_MS;
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (e.at < cutoff) break;
        if (e.dedupKey === entry.dedupKey) return false;
      }
    }
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.dirty = true;
    this.flush();
    return true;
  }

  /** 最近 limit 条沉默决策（时间倒序） */
  recent(limit = 20): SilenceLogEntry[] {
    return [...this.entries].slice(-limit).reverse();
  }

  /**
   * 检索沉默决策：支持「你上周为什么没提醒我 XX」类反问——
   * 时间窗（sinceMs）+ 关键词（XX 命中 kind/title/reason）+ actor 过滤。
   */
  search(opts: SilenceSearchOptions = {}): SilenceLogEntry[] {
    const kw = opts.keyword?.trim().toLowerCase();
    return [...this.entries]
      .reverse()
      .filter((e) => {
        if (opts.actorId && e.actorId !== opts.actorId) return false;
        if (opts.kind && e.kind !== opts.kind) return false;
        if (opts.sinceMs !== undefined && e.at < opts.sinceMs) return false;
        if (kw) {
          const hay = `${e.kind} ${e.title} ${e.reason}`.toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      })
      .slice(0, opts.limit ?? 20);
  }

  size(): number {
    return this.entries.length;
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    writeJson(this.path, { version: 1, entries: this.entries } satisfies SilenceFileShape);
    this.dirty = false;
  }
}
