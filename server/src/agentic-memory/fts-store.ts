/**
 * FTS 关键词第三路（混合检索 P0）：SQLite FTS5 全文索引 over Mem0 记忆。
 *
 * 动机：语义向量检索对专名/技术栈/型号等低语义密度 query 弱（embedding 把
 * 词面信息"平均化"），词法匹配强；此前关键词信号只存在于认知图侧
 * hybridRetrieve 的 bigram 重叠打分，Mem0 记忆没有可检索的词面索引——
 * 本模块补齐 BM25 路，作为 bridge 融合召回的第三路 rank 参与 RRF。
 *
 * 实现要点：
 *   - 分词复用 memory-record-utils 的 tokenize（中文 bigram + 英文词），索引侧
 *     把 token 以空格拼接后交给 FTS5 unicode61（每个 token 一个词元），查询侧
 *     同法解析——中文场景的「穷人 BM25」，无需自定义 tokenizer；
 *   - AND 优先（全部 query bigram 命中，高精度）；空结果时 OR + bm25 排序 +
 *     覆盖率过滤兜底（部分词面命中仍有价值）；
 *   - bm25 分数映射到 (0.5, 1) 的单调区间，仅排序语义——RRF 只消费 rank；
 *   - 写入走 ingest 落库钩子（与账本同源取数），删除走 lifecycle 删除通知；
 *     Mem0 infer 的 UPDATE 事件同 id upsert 覆盖；存量数据启动时一次性回填。
 *
 * 与相邻存储的分工：不与 mem_fts 之外的表共享 schema；context 过滤沿用
 * retrieval 的「缺省视为 main」兼容语义（旧数据 payload 无 context 字段）。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isMemoryFtsEnabled, getMemoryFtsTopK } from "./env.js";
import { openAgenticSqlite } from "./sqlite-store.js";
import { actorIdVariants } from "./actor-key.js";
import { tokenize } from "../services/memory-record-utils.js";
import {
  classifyMemorySourceRole,
  normalizeMemorySourceRole,
  type MemorySourceRole,
} from "../services/memory-source-role.js";

/** 单条 FTS 命中（rank 列表元素；score 仅排序语义） */
export interface FtsMemoryCandidate {
  memoryId: string;
  content: string;
  /** 词面相关分（bm25 单调映射到 (0.5, 1]），RRF 只消费 rank */
  score: number;
  createdAt?: string;
  highSignal?: boolean;
  importance?: number;
  /** 原始 context 字段（可能缺失；缺省视为 main 的过滤由调用方语义决定，此处一并实现） */
  context?: string;
  sourceRole?: MemorySourceRole;
}

export interface FtsIndexItem {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  /** Mem0 侧创建时间（回填时来自 getAll 结果；实时写入取当前时间） */
  createdAt?: string;
}

/** Mem0 侧最小外观（存量回填用；与 bridge 的 BridgeMem0Like.getAll 同形） */
export interface FtsMem0Like {
  getAll?(config?: { topK?: number; filters?: { user_id?: string } }): Promise<{
    results?: Array<{ id: string; memory?: string; metadata?: Record<string, unknown>; createdAt?: string }>;
  }>;
}

/** context 过滤与 retrieval.contextMatches 同语义：缺省视为 main（旧数据兼容） */
function contextMatches(rawContext: unknown, want: "main" | "notes" | "any"): boolean {
  if (want === "any") return true;
  if (rawContext === undefined || rawContext === null || rawContext === "") return want === "main";
  return rawContext === want;
}

/** FTS5 MATCH 词元：双引号包裹防词内特殊符号；分词产物不含引号，无需转义 */
function toMatchExpression(tokens: string[], op: "AND" | "OR"): string {
  return tokens.map((t) => `"${t}"`).join(` ${op} `);
}

export class AgenticMemoryFtsStore {
  private readonly db: SqliteDatabase;
  /** FTS5 不可用（极老 SQLite）时整体降级为空结果，不阻塞召回 */
  private readonly ftsUnavailable: boolean;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
          tokens,
          memory_id UNINDEXED,
          actor_id UNINDEXED,
          context UNINDEXED,
          content UNINDEXED,
          created_at UNINDEXED,
          high_signal UNINDEXED,
          importance UNINDEXED
        );
      `);
      this.ftsUnavailable = false;
    } catch (err) {
      console.warn(
        "[agentic-memory] FTS5 初始化失败（关键词路降级为空）:",
        err instanceof Error ? err.message : err,
      );
      this.ftsUnavailable = true;
    }
  }

  /**
   * 索引写入（upsert by memory_id）：infer 的 UPDATE 与重复写入同 id 覆盖。
   * 同步 SQLite 写（μs 级），调用方（落库钩子）无需 fire-and-forget。
   */
  indexMemories(actorId: string, items: FtsIndexItem[]): void {
    if (this.ftsUnavailable || items.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO mem_fts (tokens, memory_id, actor_id, context, content, created_at, high_signal, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteById = this.db.prepare(`DELETE FROM mem_fts WHERE memory_id = ?`);
    const run = this.db.transaction((rows: FtsIndexItem[]) => {
      for (const item of rows) {
        const text = (item.memory ?? "").trim();
        if (!item.id || !text) continue;
        // 助手时间线不进词法索引；用户事实与旧版未标色文本保留词法召回能力。
        const meta = item.metadata ?? {};
        const sourceRole =
          normalizeMemorySourceRole(meta.sourceRole) ?? classifyMemorySourceRole(text);
        if (sourceRole === "assistant") {
          deleteById.run(item.id);
          continue;
        }
        const tokens = tokenize(text);
        if (tokens.length === 0) continue;
        deleteById.run(item.id);
        insert.run(
          tokens.join(" "),
          item.id,
          actorId,
          typeof meta.context === "string" ? meta.context : null,
          text,
          item.createdAt ?? (typeof meta.createdAt === "string" ? meta.createdAt : null),
          meta.highSignal === true ? 1 : 0,
          Number.isFinite(Number(meta.importance)) ? Number(meta.importance) : null,
        );
      }
    });
    try {
      run(items);
    } catch (err) {
      console.warn("[agentic-memory] FTS 索引写入失败（忽略）:", err instanceof Error ? err.message : err);
    }
  }

  /** 批量移除（lifecycle 删除通知同源 id 列表） */
  remove(memoryIds: string[]): void {
    if (this.ftsUnavailable || memoryIds.length === 0) return;
    try {
      const ids = memoryIds.filter(Boolean);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        this.db
          .prepare(
            `DELETE FROM mem_fts WHERE memory_id IN (${chunk.map(() => "?").join(",")})`,
          )
          .run(...chunk);
      }
    } catch (err) {
      console.warn("[agentic-memory] FTS 索引删除失败（忽略）:", err instanceof Error ? err.message : err);
    }
  }

  /** actor 级清理（memory-clear-service 级联调用） */
  purgeActor(actorId: string): number {
    if (this.ftsUnavailable) return 0;
    try {
      return this.db.prepare(`DELETE FROM mem_fts WHERE actor_id = ?`).run(actorId).changes;
    } catch {
      return 0;
    }
  }

  /**
   * 词面检索：AND 精确（全部 query token 命中，高精度）→ 空时 OR + bm25 排序
   * + 「稀有 token 区分性」兜底。context=notes 下推过滤；main/any 由后置
   * contextMatches 兜住旧数据（缺省=main）。
   *
   * 兜底规则：长自然语言 query 的 bigram 全 AND 过严（「猫叫什么名字」会因
   * 什么/名字 拆进 bigram 而漏检），纯覆盖率又会被通用 bigram（用户/户的）
   * 刷满。取中道——只保留命中至少一个「稀有」query token 的行：稀有 = 在
   * OR 候选集内 df ≤ max(1, 25%×|候选集|)。单个稀有大词（专名/术语/独特
   * 动词搭配）是强词面信号；只命中通用 bigram 的行不进 rank 列表。
   */
  search(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any"; topK?: number },
  ): FtsMemoryCandidate[] {
    if (this.ftsUnavailable) return [];
    const query = queryText.trim();
    if (!query) return [];
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const context = opts?.context ?? "main";
    const topK = opts?.topK ?? getMemoryFtsTopK();
    // context=main 需后置过滤掉 notes 行，多取候选池防截断
    const fetchLimit = context === "notes" ? topK : topK * 3;

    const selectBase = `
      SELECT memory_id, context, content, created_at, high_signal, importance,
             bm25(mem_fts) AS rank_score
      FROM mem_fts
      WHERE mem_fts MATCH ? AND actor_id = ?
    `;

    const mapRows = (rows: Array<Record<string, unknown>>): FtsMemoryCandidate[] =>
      rows
        .filter((row) => contextMatches(row.context, context))
        .map((row) => {
          // bm25 返回负值（越负越相关），rel = 1/(1+e^raw) 单调映射到 (0.5, 1)；仅排序语义
          const raw = Number(row.rank_score);
          const score = Number.isFinite(raw) ? Math.min(1, 1 / (1 + Math.exp(raw))) : 0.5;
          return {
            memoryId: String(row.memory_id ?? ""),
            content: String(row.content ?? ""),
            score,
            sourceRole: classifyMemorySourceRole(String(row.content ?? "")),
            ...(typeof row.created_at === "string" && row.created_at ? { createdAt: row.created_at } : {}),
            ...(row.high_signal === 1 ? { highSignal: true } : {}),
            ...(Number.isFinite(Number(row.importance)) ? { importance: Number(row.importance) } : {}),
            ...(typeof row.context === "string" && row.context ? { context: row.context } : {}),
          };
        });

    const runQuery = (match: string): Array<Record<string, unknown>> =>
      this.db
        .prepare(`${selectBase} ORDER BY rank_score ASC LIMIT ?`)
        .all(match, actorId, fetchLimit) as Array<Record<string, unknown>>;

    try {
      // 第一优先：AND（全部 token 命中）
      const andRows = runQuery(toMatchExpression(tokens, "AND"));
      if (andRows.length > 0) return mapRows(andRows).slice(0, topK);

      // 兜底：OR + bm25 排序 + 稀有 token 区分性过滤（单 token 时 AND 已覆盖）
      if (tokens.length === 1) return [];
      const orRows = mapRows(runQuery(toMatchExpression(tokens, "OR")));
      if (orRows.length === 0) return [];
      const queryTokenSet = [...new Set(tokens)];
      const rowTokenSets = orRows.map((row) => new Set(tokenize(row.content)));
      const dfByToken = new Map<string, number>();
      const matchedPerRow = rowTokenSets.map((rowTokens) => {
        const matched = queryTokenSet.filter((t) => rowTokens.has(t));
        for (const t of matched) dfByToken.set(t, (dfByToken.get(t) ?? 0) + 1);
        return matched;
      });
      const rareMaxDf = Math.max(1, Math.ceil(orRows.length * 0.25));
      const distinctive = orRows.filter((_, i) =>
        (matchedPerRow[i] ?? []).some((t) => (dfByToken.get(t) ?? 0) <= rareMaxDf),
      );
      return distinctive.slice(0, topK);
    } catch (err) {
      console.warn("[agentic-memory] FTS 检索失败（忽略）:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * 存量回填：FTS 上线前的旧记忆没有索引，启动时 fire-and-forget 一次
   * （与 bridge.backfillLinks 同款模式）。幂等：按 memory_id upsert 覆盖。
   * actorIds：候选 actor 名单（调用方从 session/journal 登记处汇入）；
   * mem0ai v3 getAll 强制 filters.user_id（裸 topK 必抛），按 actor 逐形式扫。
   */
  async backfillFromMem0(
    memory: FtsMem0Like | null | undefined,
    actorIds?: string[],
  ): Promise<{ indexed: number }> {
    if (!memory?.getAll) return { indexed: 0 };
    const candidates = [...new Set((actorIds ?? []).flatMap((a) => actorIdVariants(a)))];
    if (candidates.length === 0) return { indexed: 0 };
    const records: Awaited<ReturnType<NonNullable<FtsMem0Like["getAll"]>>>["results"] = [];
    try {
      for (const variant of candidates) {
        const allResult = await memory.getAll({ topK: 10000, filters: { user_id: variant } });
        records.push(...(allResult.results ?? []));
      }
    } catch {
      return { indexed: 0 };
    }
    const byActor = new Map<string, FtsIndexItem[]>();
    for (const rec of records) {
      if (!rec?.id || !rec.memory) continue;
      const actorId = typeof rec.metadata?.actorId === "string" ? rec.metadata.actorId : "";
      if (!actorId) continue;
      const list = byActor.get(actorId) ?? [];
      list.push({ id: rec.id, memory: rec.memory ?? "", metadata: rec.metadata, createdAt: rec.createdAt });
      byActor.set(actorId, list);
    }
    let indexed = 0;
    for (const [actorId, items] of byActor) {
      this.indexMemories(actorId, items);
      indexed += items.length;
    }
    if (indexed > 0) {
      console.info(`[agentic-memory] FTS 存量回填完成：${indexed} 条记忆建立词面索引`);
    }
    return { indexed };
  }

  stats(): { rows: number; unavailable: boolean } {
    if (this.ftsUnavailable) return { rows: 0, unavailable: true };
    try {
      const row = this.db.prepare(`SELECT count(*) AS n FROM mem_fts`).get() as { n: number };
      return { rows: Number(row.n ?? 0), unavailable: false };
    } catch {
      return { rows: 0, unavailable: true };
    }
  }

  close(): void {
    this.db.close();
  }
}

export function createMemoryFtsStoreIfEnabled(db?: SqliteDatabase): AgenticMemoryFtsStore | null {
  if (!isMemoryFtsEnabled()) return null;
  try {
    return new AgenticMemoryFtsStore(db);
  } catch (err) {
    console.warn(
      "[agentic-memory] FTS store 初始化失败（关键词路关闭）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
