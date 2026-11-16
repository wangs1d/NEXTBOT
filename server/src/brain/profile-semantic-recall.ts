/**
 * 画像 query 相关性召回（2026-11-12 按需注入根修）。
 *
 * 背景：identity 类此前恒带全量注入（SNAPSHOT_CONSTANT_TAGS）——「问年龄连带
 * 报名字」的结构性根因：底账每轮摊在上下文里，模型无法区分本轮问的是哪个字段。
 * 业界共识（Mem0 / Zep / ChatGPT）：读取是 query 条件的——每轮拿用户原话对记忆
 * 条目做相关性检索，命中才注入，未命中零注入。意图词表路由整体退役（词表永远
 * 追不上语言的自然变化：「多少岁」恰好漏出 /多大|年龄|几岁/ 即现行案例）。
 *
 * 检索信号与主流对齐：语义向量为主——「我现在多少岁」与「生日：1995-03-12」
 * 字面零重叠、语义近邻，只有 embedding 能通。字段/值字面命中（T2，matchFactsInText）
 * 与 profile.query 工具（Agent 自查，Letta 型）作为补充通道。
 *
 * 两段式（绕开 prompt-context-builder 的同步 build 链）：
 *   1. prefetchProfileRecall（异步，agent-core 在 build() 前调用）：取画像事实池
 *      → query + 未缓存行文本一次性 embed（本地 bge-small-zh 端点，行向量按文本
 *      缓存、跨轮复用）→ 余弦打分 → 结果按 actor 缓存；
 *   2. recallProfileFieldsSync（同步，buildUserFactsBlock 内调用）：读缓存里命中
 *      本轮 query 的结果；未预取（端点不可用/时序异常）返回空 = 本轮退化为仅
 *      字面命中，宁可少注入不误注入。
 *
 * health 敏感类结构性排除（与旧 category 过滤同口径）：只能用户直提（T2）或
 * profile.query 显式取，不进语义自动注入。
 */

import { getMemoryComponents } from "../agentic-memory/index.js";
import { embedViaLocalEndpoint } from "../agentic-memory/local-embedding/local-embedding-endpoint.js";
import type { StructuredFact } from "../agentic-memory/structured-fact-store.js";

export type SemanticFactHit = { field: string; score: number };

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 语义命中分数线（bge-small-zh 余弦：相关短文本对经验值 ≥0.5，无关 ~0.3） */
const MIN_SCORE = numEnv("PROFILE_SEMANTIC_MIN_SCORE", 0.45);
/** 最多注入的字段数（命中再多也只取最相关的几行） */
const TOP_K = Math.max(1, Math.floor(numEnv("PROFILE_SEMANTIC_TOP_K", 3)));
/** 预取结果的时效：超过视为过期（query 每轮都变，正常轮内即取走） */
const PREFETCH_TTL_MS = 30_000;
/** 行向量缓存上限（行文本是稳定键，画像变更自然换键淘汰） */
const LINE_VEC_CACHE_CAP = 1024;

/** 画像行向量缓存：键 = 「字段：值」行文本（内容寻址，改值即换键） */
const lineVecCache = new Map<string, number[]>();
/** 预取结果缓存：actor → 本轮 query 的命中字段 */
const recallCache = new Map<string, { query: string; fields: string[]; at: number }>();

function cacheLineVec(line: string, vec: number[]): void {
  if (lineVecCache.size >= LINE_VEC_CACHE_CAP) {
    const oldest = lineVecCache.keys().next().value;
    if (oldest !== undefined) lineVecCache.delete(oldest);
  }
  lineVecCache.set(line, vec);
}

/** 候选事实池：active + 历史（此前/superseded）——「你以前住哪」也要能语义命中 */
function profileFactPool(actorId: string): StructuredFact[] {
  try {
    const store = getMemoryComponents().factStore;
    if (!store) return [];
    const active = store.getActiveFacts(actorId, "user");
    let past: StructuredFact[] = [];
    try {
      past = store.getPastFacts(actorId, undefined, "user");
    } catch {
      past = [];
    }
    return [...active, ...past];
  } catch {
    return [];
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * 纯打分：事实池 × query → 语义命中的字段（去重保最高分，分数阈值 + top-k 截断）。
 * embed 由调用方注入（真路径 = 本地端点；测试 = fake），失败返回空（诚实降级）。
 */
export async function semanticRecallFactFields(
  facts: StructuredFact[],
  query: string,
  embed: (texts: string[]) => Promise<number[][] | null>,
  opts?: { minScore?: number; topK?: number },
): Promise<SemanticFactHit[]> {
  const q = query.trim();
  if (!q || facts.length === 0) return [];

  // 行文本 =「字段：值」——字段名是语义钩子（生日/职业/居住地），值供实例对齐
  const lines = new Map<string, string>(); // lineText -> field
  for (const f of facts) {
    const value = f.value?.trim() ?? "";
    if (!value) continue;
    if ((f.category ?? "") === "health") continue; // 敏感类结构性排除
    const line = `${f.field}：${value}`;
    if (!lines.has(line)) lines.set(line, f.field.trim() || f.field);
  }
  if (lines.size === 0) return [];

  const lineTexts = [...lines.keys()];
  const uncached = lineTexts.filter((t) => !lineVecCache.has(t));
  const embedded = await embed([q, ...uncached]);
  if (!embedded || embedded.length !== 1 + uncached.length) return [];
  const qvec = embedded[0];
  uncached.forEach((text, i) => {
    const vec = embedded[1 + i];
    if (Array.isArray(vec)) cacheLineVec(text, vec);
  });

  const scored: SemanticFactHit[] = [];
  for (const [line, field] of lines) {
    const vec = lineVecCache.get(line);
    if (!vec) continue;
    scored.push({ field, score: cosine(qvec, vec) });
  }
  scored.sort((a, b) => b.score - a.score);

  const min = opts?.minScore ?? MIN_SCORE;
  const topK = opts?.topK ?? TOP_K;
  const out: SemanticFactHit[] = [];
  const seenField = new Set<string>();
  for (const hit of scored) {
    if (hit.score < min) break;
    if (seenField.has(hit.field)) continue;
    seenField.add(hit.field);
    out.push(hit);
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * 轮前预取（agent-core 在 promptContextBuilder.build() 前调用）：把本轮 query 的
 * 画像相关性结果算好放进缓存。任何失败静默吞掉（下游同步读不到 = 仅字面命中，
 * 不阻塞、不报错——预取是增强不是依赖）。
 */
export async function prefetchProfileRecall(actorId: string, query: string): Promise<void> {
  try {
    const q = query.trim();
    if (!actorId || !q) return;
    const facts = profileFactPool(actorId);
    if (facts.length === 0) return;
    const hits = await semanticRecallFactFields(facts, q, embedViaLocalEndpoint);
    recallCache.set(actorId, {
      query: q,
      fields: hits.map((h) => h.field),
      at: Date.now(),
    });
  } catch {
    // 预取失败不影响本轮：同步侧读不到缓存即退化
  }
}

/**
 * 同步读预取结果（buildUserFactsBlock 内调用）：query 与预取轮一致且未过期才返回。
 * 未命中返回空数组——本轮画像注入退化为「恒带称呼 + 字面命中」。
 */
export function recallProfileFieldsSync(actorId: string, query: string): string[] {
  const entry = recallCache.get(actorId);
  if (!entry) return [];
  if (entry.query !== query.trim()) return [];
  if (Date.now() - entry.at > PREFETCH_TTL_MS) return [];
  return entry.fields;
}

/** 测试隔离：清空全部缓存 */
export function __resetProfileSemanticRecallForTest(): void {
  lineVecCache.clear();
  recallCache.clear();
}
