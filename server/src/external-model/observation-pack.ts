/**
 * ObservationPack：大体积工具结果的句柄化存储 + obs_recall 读回。
 *
 * 借鉴 NVlabs/SoL-Pi 的 ObservationPack 机制（MIT）：
 * 工具结果被 compactToolOutputForLlm 压缩 / foldOldWaveToolChains 折叠后，原文此前
 * 永久离开模型上下文——模型需要细节时只能重新执行原工具（再付一次延迟与费用，
 * 且非幂等工具有副作用风险）。本模块在压缩发生时把完整原文归档为稳定句柄
 * （obs_N），并暴露 obs_recall 工具读回：
 *  - 归档在压缩点（openai-compatible-tool-loop 主执行路径）完成，附一行读回提示；
 *  - replan 折叠摘要逐行追加句柄标注，模型可按句柄回读旧波原文；
 *  - WP1（借鉴 codebase-memory-mcp「结构索引+定向读取」）：归档时用 content-map
 *    构建确定性结构索引，obs_recall 支持 mode="outline" 看目录、query=关键词
 *    定向跳转，替代线性盲翻页；无 map/无 query 时保持原 offset/limit 分页不变；
 *  - 存储有上限（条数 / 总字符 / 会话数），超限 FIFO 淘汰最旧条目；
 *  - 读不到（句柄失效/不存在）时返回可恢复错误，模型重跑原工具即可，无静默丢数据。
 *
 * 执行位置：obs_recall 与 tool_search 桥接同属循环层元工具——在
 * streamCompletionWithTools 的执行器分发处直接服务，不进 ToolRegistry、
 * 不走超时竞速与确定性重试管线（读回是纯内存切片）。
 */

import { buildContentMap, renderOutline, resolveQueryWindow, type SemanticHint } from "./content-map.js";

/** obs_recall 的注册表名（无 `.`，API 名与注册表名一致）。 */
export const OBS_RECALL_TOOL_NAME = "obs_recall";

/** 原文低于该字符数不归档（读回价值不足以抵消提示 token）。 */
const OBS_PACK_ARCHIVE_MIN_CHARS = 2_000;
/** 压缩节省低于该字符数不归档（内容几乎无损时提示是纯噪音）。 */
const OBS_PACK_HINT_MIN_SAVED_CHARS = 600;
/** 单次读回默认/上限字符数（对齐 replan 折叠预算的数量级，防止一次读回爆上下文）。 */
const OBS_RECALL_DEFAULT_LIMIT_CHARS = 4_000;
const OBS_RECALL_MAX_LIMIT_CHARS = 12_000;
/** 单个 pack 的容量上限：条数与总字符。超限 FIFO 淘汰最旧条目。 */
const OBS_PACK_MAX_ENTRIES = 32;
const OBS_PACK_MAX_TOTAL_CHARS = 400_000;
/** 跨轮复用的 pack 按 session 缓存的容量上限（LRU 插入序淘汰）。 */
const SESSION_PACK_MAX = 32;

export interface ArchivedObservation {
  id: string;
  toolName: string;
  /** 完整原文（compactToolOutputForLlm 的 rawText，即 strip 后的 JSON 序列化文本）。 */
  text: string;
  chars: number;
  /**
   * 确定性结构索引（WP1，content-map.ts）：归档时构建，供 obs_recall 的
   * mode="outline" 与 query=关键词 定向读取。构建失败时缺省（走线性分页）。
   */
  map?: import("./content-map.js").ContentMap;
  /**
   * 与 map.sections 按下标对齐的节向量（WP1.1 精确度优化）：归档后由注入的
   * embedder 异步富集，recall(query) 时与 query 向量做余弦混合打分。
   * 未富集/富集失败时缺省（纯词面打分）。
   */
  sectionVectors?: Float32Array[];
  /** 归档时的 tool_call_id（折叠摘要按它反查句柄；桥接路径可能没有）。 */
  toolCallId?: string;
  archivedAt: number;
}

export type ObsRecallOutcome =
  | {
      ok: true;
      result: {
        /** 与其他工具结果一致的自报成功标志（tool 消息直接序列化 result）。 */
        ok: true;
        id: string;
        tool: string;
        totalChars: number;
        offset: number;
        returnedChars: number;
        /** null 表示已到末尾；否则提示模型用该 offset 继续。 */
        nextOffset: number | null;
        text: string;
        /** mode="outline" 时返回结构索引文本（此时 text 为空）。 */
        kind?: string;
        outline?: string;
        /** query 定向读取时命中的节标题（按得分降序，最多 3 个）。 */
        matched?: string[];
        /** 次优候选节标题——top 窗口没找到答案时换词重试的导航提示。 */
        alternatives?: string[];
        /** top 窗口缺直接证据（零词面命中且语义弱），建议换关键词或线性翻页。 */
        lowConfidence?: boolean;
      };
    }
  | { ok: false, error: string };

export class ObservationPack {
  private seq = 0;
  private readonly entries = new Map<string, ArchivedObservation>();
  private readonly byToolCallId = new Map<string, string>();
  private totalChars = 0;

  /** 当前已归档条数（测试与诊断用）。 */
  get size(): number {
    return this.entries.size;
  }

  get totalArchivedChars(): number {
    return this.totalChars;
  }

  /**
   * 归档一条完整原文。低于阈值或参数非法返回 null（调用方不发提示）。
   * 容量超限时 FIFO 淘汰最旧条目，保证长会话后续轮次仍可归档。
   */
  archive(toolName: string, toolCallId: string | undefined, rawText: string): ArchivedObservation | null {
    if (typeof rawText !== "string" || rawText.length < OBS_PACK_ARCHIVE_MIN_CHARS) return null;
    // 单条即超总上限：放弃归档，且不为此淘汰既有条目
    if (rawText.length > OBS_PACK_MAX_TOTAL_CHARS) return null;
    while (
      this.entries.size + 1 > OBS_PACK_MAX_ENTRIES ||
      this.totalChars + rawText.length > OBS_PACK_MAX_TOTAL_CHARS
    ) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) return null;
      this.dropEntry(oldestId);
    }
    const id = `obs_${++this.seq}`;
    // WP1：归档时顺带构建确定性结构索引（几百字符；失败不影响归档本身）
    let map: ArchivedObservation["map"];
    try {
      map = buildContentMap(rawText);
    } catch {
      map = undefined;
    }
    const entry: ArchivedObservation = {
      id,
      toolName,
      text: rawText,
      chars: rawText.length,
      ...(map ? { map } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      archivedAt: Date.now(),
    };
    // WP1.1：有结构索引时异步富集节向量（不阻塞归档与主链路；失败静默退化词面打分）
    if (map && map.sections.length > 0) {
      void enrichEntryVectors(entry);
    }
    this.entries.set(id, entry);
    this.totalChars += entry.chars;
    if (toolCallId) this.byToolCallId.set(toolCallId, id);
    return entry;
  }

  /** 按 tool_call_id 反查句柄（折叠摘要标注用）。 */
  idForToolCall(toolCallId: string): string | undefined {
    return this.byToolCallId.get(toolCallId);
  }

  /**
   * 读回。三种模式（WP1）：
   *  - mode="outline"：返回确定性结构索引（不返回正文），模型先看目录再定向读；
   *  - 带 query：按 ContentMap 打分定位最相关节，直接返回该窗口（定向跳转）；
   *  - 默认（无 mode/query）：与原行为完全一致，按 offset/limit 线性分页。
   * offset/limit 做防御性归一（负数/浮点/越界），切片不劈开 surrogate pair，
   * 返回值携带 nextOffset 供续页。
   */
  recall(args: unknown): ObsRecallOutcome {
    const parsedId =
      args && typeof args === "object" && typeof (args as { id?: unknown }).id === "string"
        ? (args as { id: string }).id.trim()
        : "";
    if (!parsedId) {
      return { ok: false, error: this.unknownIdError("", "缺少必填参数 id（形如 obs_1）") };
    }
    const entry = this.entries.get(parsedId);
    if (!entry) {
      return { ok: false, error: this.unknownIdError(parsedId) };
    }
    const rawLimit = (args as { limit?: unknown }).limit;
    let limit = Number.parseInt(String(rawLimit ?? OBS_RECALL_DEFAULT_LIMIT_CHARS), 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = OBS_RECALL_DEFAULT_LIMIT_CHARS;
    limit = Math.min(limit, OBS_RECALL_MAX_LIMIT_CHARS);

    const mode =
      typeof (args as { mode?: unknown }).mode === "string"
        ? ((args as { mode: string }).mode as "outline" | "text")
        : "text";
    const query =
      typeof (args as { query?: unknown }).query === "string"
        ? ((args as { query: string }).query as string).trim()
        : "";

    if (mode === "outline") {
      if (!entry.map) {
        return { ok: false, error: `${parsedId} 无结构索引（内容过短或构建失败），请用 offset/limit 分页读回。` };
      }
      return {
        ok: true,
        result: {
          ok: true,
          id: entry.id,
          tool: entry.toolName,
          totalChars: entry.chars,
          offset: 0,
          returnedChars: 0,
          nextOffset: null,
          text: "",
          kind: entry.map.kind,
          outline: renderOutline(entry.map),
        },
      };
    }

    // text 模式：query 定向跳转 → 无 query 或无 map 时退回线性分页
    let windowOffset: number | null = null;
    let matched: string[] | undefined;
    let alternatives: string[] | undefined;
    let lowConfidence: boolean | undefined;
    if (query && entry.map) {
      try {
        // WP1.1：调用方可注入预计算的 query 向量（tool-loop 在分发前异步取得），
        // 与归档时富集的节向量做混合打分；任一侧缺失自动退化为纯词面
        const semantic: SemanticHint | undefined =
          entry.sectionVectors && isVectorLike((args as { queryVector?: unknown }).queryVector)
            ? { queryVector: (args as { queryVector: ArrayLike<number> }).queryVector, sectionVectors: entry.sectionVectors }
            : undefined;
        const window = resolveQueryWindow(entry.map, entry.text, query, limit, semantic);
        if (window) {
          windowOffset = window.offset;
          matched = window.matchedTitles;
          if (window.alternatives && window.alternatives.length > 0) alternatives = window.alternatives;
          if (window.lowConfidence) lowConfidence = true;
        }
      } catch {
        windowOffset = null;
      }
    }

    let offset: number;
    if (windowOffset !== null) {
      offset = windowOffset;
    } else {
      const rawOffset = (args as { offset?: unknown }).offset;
      offset = Number.parseInt(String(rawOffset ?? "0"), 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
    }

    const clampedOffset = Math.min(offset, entry.chars);
    const slice = safeSliceText(entry.text, clampedOffset, clampedOffset + limit);
    const nextOffset = slice.end < entry.chars ? slice.end : null;
    return {
      ok: true,
      result: {
        ok: true,
        id: entry.id,
        tool: entry.toolName,
        totalChars: entry.chars,
        offset: slice.start,
        returnedChars: slice.text.length,
        nextOffset,
        text: slice.text,
        ...(matched ? { matched } : {}),
        ...(alternatives ? { alternatives } : {}),
        ...(lowConfidence ? { lowConfidence } : {}),
      },
    };
  }

  private dropEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalChars -= entry.chars;
    if (entry.toolCallId && this.byToolCallId.get(entry.toolCallId) === id) {
      this.byToolCallId.delete(entry.toolCallId);
    }
  }

  private unknownIdError(id: string, prefix?: string): string {
    const available = [...this.entries.keys()];
    const availableText = available.length
      ? `当前可读回的句柄：${available.slice(-8).join(", ")}。`
      : "当前没有可读回的结果（本轮会话尚无被归档的大结果）。";
    const head = prefix ?? `obs 句柄不存在或已失效（可能来自更早的会话）：${id}。`;
    return `${head}${availableText}若所需内容已无法读回，请重新调用原工具获取。`;
  }
}

/**
 * surrogate pair 安全切片：起止点若落在增补平面字符（如 emoji）中间，回退一位，
 * 被让出的半个字符归入下一页，保证每次读回的 text 都可安全编码。
 */
export function safeSliceText(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (s > 0 && s < text.length && isHigh(text.charCodeAt(s - 1)) && isLow(text.charCodeAt(s))) {
    s -= 1;
  }
  if (e > s && e < text.length && isHigh(text.charCodeAt(e - 1)) && isLow(text.charCodeAt(e))) {
    e -= 1;
  }
  return { text: text.slice(s, e), start: s, end: e };
}

/**
 * 压缩点调用：原文足够大 且 压缩确实省了足够多字符 才归档。
 * 返回 null 表示不值得归档（调用方不发提示、不占容量）。
 */
export function archiveIfWorthwhile(
  pack: ObservationPack,
  toolName: string,
  toolCallId: string | undefined,
  rawText: string | undefined,
  compactedContent: string | undefined,
): ArchivedObservation | null {
  if (!rawText) return null;
  const saved = rawText.length - (compactedContent?.length ?? 0);
  if (saved < OBS_PACK_HINT_MIN_SAVED_CHARS) return null;
  return pack.archive(toolName, toolCallId, rawText);
}

/** 追加在压缩后 tool 消息尾部的读回提示（一行）。带结构索引时附带定向读法。 */
export function buildObservationRecallHint(obs: ArchivedObservation): string {
  if (obs.map && obs.map.sections.length > 0) {
    return (
      `[obs_recall 可用] 本条结果已压缩（原文 ${obs.chars} 字符）。` +
      `先看结构：obs_recall(id="${obs.id}", mode="outline")；` +
      `或带关键词定向读取：obs_recall(id="${obs.id}", query="关键词", limit=4000)。` +
      `query 未命中时改用结果原文中的关键词重试。不要重新执行原工具。`
    );
  }
  return (
    `[obs_recall 可用] 本条结果已压缩（原文 ${obs.chars} 字符）。` +
    `需要更多细节时调用 obs_recall(id="${obs.id}", offset=0, limit=4000) 分页读回原文，不要重新执行原工具。`
  );
}

// ── WP1.1 语义富集：可注入 embedder + 归档后异步节向量 + query 向量 ──
// 降级链：未注入/端点缺失/请求失败 → 无向量 → obs_recall 自动退化为纯词面打分。

/** 批量嵌入接口：返回向量与输入一一对应；失败/不可用时返回 null（不抛错）。 */
export type ObservationEmbedder = (texts: string[]) => Promise<Float32Array[] | null>;

let obsEmbedder: ObservationEmbedder | null = null;
/** 真实端点接线状态：true=已尝试（无论成败），失败后按间隔重试。 */
let wired = false;
let lastWireFailedAt = 0;
const WIRE_RETRY_MS = 5 * 60 * 1000;
/** 单节参与嵌入的文本长度上限（标题 + 节头，控制成本）。 */
const EMBED_TEXT_CHARS = 512;

/** 注入嵌入实现（测试注入 mock；生产由本模块自动接线 OpenAI 兼容端点）。传 null 卸载。 */
export function setObservationEmbedder(fn: ObservationEmbedder | null): void {
  obsEmbedder = fn;
  wired = true; // 显式注入视为最终决定，不再自动接线
}

function isVectorLike(v: unknown): v is ArrayLike<number> {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { length?: unknown }).length === "number" &&
    (v as { length: number }).length > 0
  );
}

/** 自动接线：显式开启 AGENT_OBS_CONTENT_EMBEDDING 且配置了 OpenAI 兼容端点时才启用
 * （默认关——灰度哲学：语义增强按需开启，测试环境零网络请求）。 */
async function ensureEmbedderWired(): Promise<ObservationEmbedder | null> {
  if (obsEmbedder) return obsEmbedder;
  if (wired && Date.now() - lastWireFailedAt < WIRE_RETRY_MS) return null;
  wired = true;
  const flag = process.env.AGENT_OBS_CONTENT_EMBEDDING?.trim().toLowerCase();
  if (!(flag === "1" || flag === "true" || flag === "on")) return null;
  try {
    const { resolveEmbeddingEndpoint, fetchOpenAiCompatibleEmbeddings } = await import(
      "../services/openai-embedding-client.js"
    );
    if (!resolveEmbeddingEndpoint()) return null;
    obsEmbedder = async (texts: string[]) => {
      try {
        const { vectors } = await fetchOpenAiCompatibleEmbeddings({ inputs: texts, timeoutMs: 8_000 });
        return vectors.map((v) => Float32Array.from(v));
      } catch {
        lastWireFailedAt = Date.now();
        return null;
      }
    };
    return obsEmbedder;
  } catch {
    lastWireFailedAt = Date.now();
    return null;
  }
}

/** 归档后异步富集节向量（fire-and-forget；任何失败静默，词面打分兜底）。 */
async function enrichEntryVectors(entry: ArchivedObservation): Promise<void> {
  const embedder = await ensureEmbedderWired();
  if (!embedder || !entry.map) return;
  try {
    const texts = entry.map.sections.map(
      (s) => `${s.title} ${entry.text.slice(s.offset, s.offset + Math.min(s.chars, EMBED_TEXT_CHARS))}`,
    );
    const vectors = await embedder(texts);
    if (vectors && vectors.length === entry.map.sections.length) {
      entry.sectionVectors = vectors;
    }
  } catch {
    /* 静默：保持无向量，词面打分兜底 */
  }
}

/**
 * 取 query 向量（tool-loop 在分发 obs_recall 前调用；无 embedder/失败返回 null）。
 * 嵌入客户端自带 TTL 缓存，同一 query 重复读回不重复计费。
 */
export async function embedObsQuery(query: string): Promise<Float32Array | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const embedder = await ensureEmbedderWired();
  if (!embedder) return null;
  try {
    const vectors = await embedder([trimmed]);
    return vectors?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── 会话级复用（2026-11-01 默认关闭）：同一 session 的后续对话轮可读回此前轮次归档的结果 ──
// 代价是原文在内存里常驻（最多 32 个会话 × 40 万字符），且进程重启即丢——它并不是
// 持久化存储，只是「本轮压缩掉的长结果暂时留个读回入口」。默认改为按轮丢弃：
// 模型回复完这一轮就不再需要读回，下一轮缺细节让它重跑工具（幂等工具）或直接问用户。
// 需要跨轮读回时显式 OBS_PACK_CROSS_TURN=1。
const sessionPacks = new Map<string, ObservationPack>();

function crossTurnReuseEnabled(): boolean {
  const raw = process.env.OBS_PACK_CROSS_TURN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function getObservationPack(sessionId?: string): ObservationPack {
  if (!sessionId || !crossTurnReuseEnabled()) return new ObservationPack();
  const existing = sessionPacks.get(sessionId);
  if (existing) return existing;
  const pack = new ObservationPack();
  sessionPacks.set(sessionId, pack);
  if (sessionPacks.size > SESSION_PACK_MAX) {
    const oldest = sessionPacks.keys().next().value;
    if (oldest !== undefined) sessionPacks.delete(oldest);
  }
  return pack;
}

/** 轮次结束主动释放（跨轮复用开启时才有实际数据；未开启时是空操作）。 */
export function releaseObservationPack(sessionId?: string): void {
  if (sessionId) sessionPacks.delete(sessionId);
}

/** 测试专用：清空会话 pack 缓存。 */
export function resetObservationPacksForTest(): void {
  sessionPacks.clear();
}
