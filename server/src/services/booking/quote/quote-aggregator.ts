/**
 * 报价聚合器：并行拉取所有支持的源 → 归一 → 比价排序。
 *
 * 行为契约：
 *   - 任一源失败/超时不影响整体；失败源如实记入 sources[].error
 *   - 全部源都无报价时 ok=false（带各源原因），调用方如实转告
 *   - 报价按「总价升序」排列 = 比价列表；同价按源优先级（api > database/list > scraped > estimated）
 */

import type { ToolContext } from "../../../tools/tool-registry.js";
import {
  compareQuotes,
  type QuoteAggregate,
  type QuoteAggregatorOptions,
  type QuotePriceSource,
  type QuoteRequest,
  type QuoteSource,
  type QuoteSourceOutcome,
} from "./quote-source.js";

const SOURCE_RANK: Record<QuotePriceSource, number> = {
  api: 0,
  database: 1,
  list: 2,
  scraped: 3,
  estimated: 4,
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class QuoteAggregator {
  private readonly sources: QuoteSource[];
  private readonly timeoutMs: number;
  private readonly maxQuotes: number;
  private readonly now: () => number;

  constructor(sources: QuoteSource[], opts: QuoteAggregatorOptions = {}) {
    this.sources = sources;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxQuotes = opts.maxQuotes ?? 20;
    this.now = opts.now ?? (() => Date.now());
  }

  async aggregate(req: QuoteRequest, ctx: ToolContext): Promise<QuoteAggregate> {
    const applicable = this.sources.filter((s) => s.supports(req.type));
    const outcomes = await Promise.all(
      applicable.map(async (source): Promise<QuoteSourceOutcome> => {
        try {
          const result = await withTimeout(
            source.fetch(req, ctx),
            source.timeoutMs ?? this.timeoutMs,
            source.label,
          );
          if (result.ok) {
            return { source: source.id, label: source.label, ok: true, quotes: result.quotes };
          }
          return { source: source.id, label: source.label, ok: false, error: result.error, quotes: [] };
        } catch (e) {
          return {
            source: source.id,
            label: source.label,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            quotes: [],
          };
        }
      }),
    );

    // 去重：同源同票（source+type+code/name+amount）只留一条
    const seen = new Set<string>();
    const quotes: QuoteAggregate["quotes"] = [];
    for (const outcome of outcomes) {
      for (const q of outcome.quotes) {
        const key = `${q.source}|${q.type}|${q.code ?? q.name ?? ""}|${q.amountCny}|${q.nights ?? 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        quotes.push(q);
      }
    }
    quotes.sort((a, b) => {
      const byPrice = compareQuotes(a, b);
      if (byPrice !== 0) return byPrice;
      return SOURCE_RANK[a.priceSource] - SOURCE_RANK[b.priceSource];
    });

    const trimmed = quotes.slice(0, this.maxQuotes);
    const ok = trimmed.length > 0;
    const failed = outcomes.filter((o) => !o.ok || o.quotes.length === 0);
    const noteParts: string[] = [];
    if (ok) {
      const best = trimmed[0];
      noteParts.push(`共 ${trimmed.length} 条报价，最低 ¥${best.amountCny}${best.nights && best.nights > 1 ? `/晚×${best.nights}` : ""}（${best.sourceLabel}，${best.priceSource === "api" ? "实时API" : best.priceSource === "scraped" ? "页面代查" : best.priceSource === "estimated" ? "估算" : "价格库"}）`);
    }
    if (failed.length > 0) {
      noteParts.push(`未取到报价的源：${failed.map((f) => `${f.label}${f.error ? `（${f.error}）` : ""}`).join("、")}`);
    }
    return {
      ok,
      quotes: trimmed,
      sources: outcomes,
      note: noteParts.join("；") || "所有报价源均无结果，请检查查询条件（城市/日期/车次）",
    };
  }
}
