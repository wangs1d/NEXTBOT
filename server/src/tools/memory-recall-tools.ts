// 记忆回查工具：把短期记忆网关的会话情景台账（EpisodicTurn + BM25）
// 暴露为模型可调用的检索入口。
//
// 设计动机（压缩 + 按需展开，对齐 OpenClaw 2.0 Lossless Claw 思路）：
// 会话历史经滚动摘要/修剪后细节会"被压缩掉"，此前模型没有任何工具能把
// 原始轮次捞回来（数据都在 short-term-task-stack.json，缺的只是工具暴露层）。
// 有了本工具，"有损摘要"升级为"压缩 + 按需展开"。
//
// 2026-10-10 补 memory.recall_history（主流三层记忆的 Recall 层拼图）：
// 分类索引视图落地后，跨会话细节（瞬时旧事原话/被收起的条目）已不常驻上下文，
// 模型"知道有、查不了"——本工具把持久化线程（chat-threads.json + notes）的
// 历史原文暴露为按需检索入口，返回带时间的原文片段。检索动作本身就是闸：
// 模型想引用旧细节必须显式调用，可审计、带时间。

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolRegistry } from "./tool-registry.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import type { ChatThreadPersistence } from "../external-model/chat-thread-persist.js";
import {
  parseMessageTimestamp,
  readMessageTimestampPrefix,
} from "../external-model/chat-thread-store.js";

/** memory.recall_episodic —— 回查当前会话的原始对话轮次 */
export const MEMORY_RECALL_EPISODIC_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory.recall_episodic",
    description:
      "回查当前会话的原始对话记录（逐轮原文检索）。当用户追问刚才/之前说过的具体细节、或你需要核对本会话内出现过的原话而最近对话窗口已看不到时调用。返回与 query 最相关的若干轮对话原文（用户问句 + 你的回复 + 时间）。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要回查的内容关键词或问题，越具体命中越准",
        },
        k: {
          type: "integer",
          description: "返回轮数，默认 6，最大 20",
          default: 6,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/**
 * memory.recall_history —— 跨会话回查历史对话原文（2026-10-10）。
 * 与 recall_episodic 的分工：episodic=当前会话逐轮；history=当前会话之外的
 * 更早会话/主动会话/笔记线程。recap 只留索引不留细节，细节从这里按需取。
 */
export const MEMORY_RECALL_HISTORY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory.recall_history",
    description:
      "跨会话回查更早的历史对话原文（当前会话之外的以往对话、主动会话、笔记线程）。当用户提到『上次/之前/那天』说过或聊过的具体内容、或上下文摘要只有索引没有细节而你确需引用原话时调用。返回带发生时间的原文片段——引用时以返回的原文和时间为准，不要凭印象把旧事说成『刚才』。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要回查的内容关键词或问题，越具体命中越准",
        },
        k: {
          type: "integer",
          description: "返回片段数，默认 6，最大 20",
          default: 6,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const MEMORY_RECALL_CHAT_TOOLS: ChatCompletionTool[] = [
  MEMORY_RECALL_EPISODIC_TOOL,
  MEMORY_RECALL_HISTORY_TOOL,
];

// ── 跨会话检索实现（纯函数，便于单测） ─────────────────────────────

export type HistoryHit = {
  sessionId: string;
  sessionKind: "主会话" | "主动会话" | "笔记" | "其他";
  /** 发生时间（消息自带时间戳优先，缺省回退会话 updatedAt 并加「约」前缀） */
  time: string;
  /** 时间来源：message=消息自带 [ts:] 前缀（精确到分）；session=线程 updatedAt（粗粒度） */
  timeSource: "message" | "session";
  role: "用户" | "助手";
  text: string;
  score: number;
};

const HIT_TEXT_MAX_CHARS = 260;

/** 从 session key 归类会话形态（用于结果标注）。 */
function sessionKindOf(sessionId: string): HistoryHit["sessionKind"] {
  if (sessionId.startsWith("proactive:")) return "主动会话";
  if (sessionId.startsWith("notes:")) return "笔记";
  if (sessionId.startsWith("master:")) return "主会话";
  if (sessionId.includes(":")) return "其他";
  return "主会话";
}

/** CJK 按字 bigram + 连续 ASCII 词元，供朴素相关度打分。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const ascii of text.matchAll(/[a-zA-Z0-9_#@.]{2,}/g)) {
    tokens.push(ascii[0].toLowerCase());
  }
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2));
  if (cjk.length === 1) tokens.push(cjk);
  return tokens;
}

/** 朴素相关度：query 词元在候选文本中的命中数（去重词元计权重）。 */
function scoreText(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0 || !text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of new Set(queryTokens)) {
    if (!t) continue;
    let idx = lower.indexOf(t);
    let hits = 0;
    while (idx >= 0 && hits < 3) {
      hits++;
      idx = lower.indexOf(t, idx + t.length);
    }
    score += hits;
  }
  return score;
}

function extractTextContent(msg: { role: string; content?: unknown }): string | null {
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts = msg.content
      .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => String((p as { text?: string }).text ?? ""));
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

function formatTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * 跨会话历史检索：在该 actor 名下的全部持久化线程（排除当前会话）里做
 * 关键词相关度检索，返回带时间的原文片段。recap/系统注入块不算原文，跳过。
 */
export function searchCrossSessionHistory(
  persistence: ChatThreadPersistence,
  opts: { actorId: string; excludeSessionId?: string; query: string; k?: number },
): HistoryHit[] {
  const actorId = opts.actorId?.trim();
  const query = opts.query?.trim();
  if (!actorId || !query) return [];
  const k = Number.isFinite(opts.k) && (opts.k as number) > 0 ? Math.min(20, Math.floor(opts.k as number)) : 6;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // exclude 语义（2026-10-10 真实数据探针校准）：运行时裸 actorId=当前活跃
  // 线程（每轮落盘），master:{actorId}=boot 时 migrate 合并出的历史线程——
  // 后者正是跨会话回查的正当目标，不得排除。只对称处理「传入 key 带
  // master:/notes: 前缀」时连带排除其裸形式。
  const excludeId = opts.excludeSessionId?.trim() || null;
  const excludeKeys = new Set<string>();
  if (excludeId) {
    excludeKeys.add(excludeId);
    if (excludeId.startsWith("master:")) excludeKeys.add(excludeId.slice("master:".length));
    if (excludeId.startsWith("notes:")) excludeKeys.add(excludeId.slice("notes:".length));
  }

  const hits: HistoryHit[] = [];
  for (const thread of persistence.getActorThreads(actorId)) {
    if (excludeKeys.has(thread.sessionId)) continue;
    const kind = sessionKindOf(thread.sessionId);
    const sessionFallbackTime = formatTime(new Date(thread.updatedAt || Date.now()));
    for (const msg of thread.messages) {
      const raw = extractTextContent(msg);
      if (!raw) continue;
      // 摘要区/关键钉区是常驻注入的索引，不是"历史原文"——跳过防自引用
      if (raw.includes("[session-recap]")) continue;
      if (raw.includes("<system-reminder")) continue;
      const prefixed = readMessageTimestampPrefix(raw);
      const body = (prefixed ? prefixed.rest : raw).trim();
      if (!body) continue;
      const score = scoreText(queryTokens, body);
      if (score <= 0) continue;
      const ts = parseMessageTimestamp(raw);
      hits.push({
        sessionId: thread.sessionId,
        sessionKind: kind,
        // 线程 updatedAt 是"最后活跃时间"，把它渲染成精确时刻会把旧消息
        // 显示成"刚刚"（2026-10-10 真实探针复现：10-09 的原话显示成 02:21，
        // 恰好诱导「刚才你说」式错位）——必须加「约」并标注粗粒度来源。
        time: ts ? formatTime(ts) : `约 ${sessionFallbackTime}`,
        timeSource: ts ? "message" : "session",
        role: msg.role === "user" ? "用户" : "助手",
        text: body.length > HIT_TEXT_MAX_CHARS ? `${body.slice(0, HIT_TEXT_MAX_CHARS)}…` : body,
        score,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || b.time.localeCompare(a.time));
  return hits.slice(0, k);
}

export function registerMemoryRecallTools(
  toolRegistry: ToolRegistry,
  deps: {
    shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
    /** 跨会话检索的数据源（chat-threads.json + notes 持久层）；缺省时 history 工具不注册 */
    chatThreadPersistence?: ChatThreadPersistence | null;
  },
): void {
  if (!deps.shortTermMemoryGateway) return;

  toolRegistry.register("memory.recall_episodic", async (input, context) => {
    const gateway = deps.shortTermMemoryGateway!;
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      return { ok: false, error: "缺少 query 参数：请给出要回查的内容关键词或问题。" };
    }
    const kRaw = Number(input.k);
    const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.min(20, Math.floor(kRaw)) : 6;

    const turns = gateway.searchEpisodic(context.sessionId, query, k);
    if (turns.length === 0) {
      return {
        ok: true,
        turns: [],
        message:
          "当前会话没有检索到相关对话轮次。若内容可能在更早的会话，请改用 memory.recall_history 跨会话回查。",
      };
    }

    return {
      ok: true,
      turns: turns.map((t) => ({
        idx: t.idx,
        time: new Date(t.ts).toISOString().slice(0, 16).replace("T", " "),
        user: t.user,
        assistant: t.assistant,
      })),
      message: `已按相关度返回 ${turns.length} 轮会话原文（idx 为会话内轮次序号，越大越新）。引用时忠实于原文，不要凭印象补细节。`,
    };
  });

  const persistence = deps.chatThreadPersistence ?? null;
  if (!persistence) return;

  toolRegistry.register("memory.recall_history", async (input, context) => {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      return { ok: false, error: "缺少 query 参数：请给出要回查的内容关键词或问题。" };
    }
    const kRaw = Number(input.k);
    const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.min(20, Math.floor(kRaw)) : 6;

    const actorId = (context.userId ?? context.sessionId ?? "").trim();
    if (!actorId) {
      return { ok: false, error: "无法确定用户身份（无 userId/sessionId），拒绝跨会话检索。" };
    }

    const hits = searchCrossSessionHistory(persistence, {
      actorId,
      excludeSessionId: context.sessionId,
      query,
      k,
    });
    if (hits.length === 0) {
      return {
        ok: true,
        hits: [],
        message: "历史会话中没有检索到相关原文。请如实告知用户查不到，不要凭印象编造细节。",
      };
    }

    return {
      ok: true,
      hits: hits.map((h) => ({
        time: h.time,
        session: h.sessionKind,
        role: h.role,
        text: h.text,
      })),
      message:
        `已按相关度返回 ${hits.length} 段历史原文（带发生时间）。引用规则：` +
        `①忠实于原文与时间，这些是更早会话的内容，必须按时间说（如『你 X 天前提到』），` +
        `不得说成『刚才/刚刚』；` +
        `②时间以『约』开头的是该会话最后更新时间（非消息精确发生时刻），` +
        `叙述时只能用『之前/更早时候』等模糊表述，禁止当作精确时刻引用。`,
    };
  });
}
