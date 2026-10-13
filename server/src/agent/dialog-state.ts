/**
 * 会话级对话状态账本（2026-10-12 架构收敛：路由输入从「裸 user 原文」升级为
 * 「结构化对话状态」）。
 *
 * 根因回顾（2026-10-12 双事故同源）：路由 LLM 只看得到最近 4 条 **user** 消息
 * （chat-user-message 只过滤 role==="user"），看不到 assistant 回复与本轮真实
 * 执行过的工具——上一轮「搜照片已交付」在路由器眼里只剩「用户提过照片」，
 * 加上 prompt 里「短追问按继承话题判」的旧指令，分类器被历史带偏是结构性必然
 * （真实事故：自我介绍「真名叫王铭川…」被贴 media_retrieval → 照片凭空出现）。
 *
 * 主流对齐：Coze/Dify 的意图节点喂的是结构化对话状态（上一轮意图/动作/交付），
 * ChatGPT/Claude 原生 function calling 更是让决策者看到完整对话。本模块把
 * 「上一轮干了什么」从对话流里显式提出来，供路由 prompt 消费——决策者终于
 * 看得到执行者做过的事。
 *
 * 写入点：chat-user-message done 阶段（每轮必经，intent + 全部真实执行过的
 * 工具名）。读取点：下一轮路由（buildRoutePrompt 的「上一轮对话状态」块）。
 * 全内存、LRU 封顶、任何失败静默（状态缺失只退回旧行为，不阻塞聊天）。
 */

export type DialogTurnState = {
  /** 用户消息原文（截断存储） */
  userText: string;
  /** 该轮路由意图（路由失败时 "unknown"） */
  intent: string;
  /** 该轮真实执行过的工具名（保序去重） */
  tools: string[];
};

const MAX_SESSIONS = 500;
const MAX_TURNS_PER_SESSION = 6;
const USER_TEXT_MAX = 80;

class DialogStateStore {
  private sessions = new Map<string, DialogTurnState[]>();

  /** 媒体交付工具 → 状态行注记（让「照片已交付」语义显性，防承接语被带偏成 realtime）。 */
  private static MEDIA_DELIVERY_TOOLS = new Set([
    "search_images",
    "search_images_batch",
    "search_videos",
    "image.generate",
  ]);

  private static deliveryNote(turn: DialogTurnState): string {
    const isMedia = turn.tools.some((t) => DialogStateStore.MEDIA_DELIVERY_TOOLS.has(t));
    return isMedia ? "（媒体结果已交付给用户）" : "";
  }

  recordTurn(sessionId: string, turn: DialogTurnState): void {
    const sid = (sessionId ?? "").trim();
    if (!sid) return;
    const list = this.sessions.get(sid) ?? [];
    list.push({
      userText: (turn.userText ?? "").slice(0, USER_TEXT_MAX),
      intent: turn.intent || "unknown",
      tools: [...new Set(turn.tools.filter(Boolean))].slice(0, 8),
    });
    while (list.length > MAX_TURNS_PER_SESSION) list.shift();
    this.sessions.set(sid, list);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
  }

  recentTurns(sessionId: string, n = 3): DialogTurnState[] {
    const list = this.sessions.get((sessionId ?? "").trim());
    if (!list || list.length === 0) return [];
    return list.slice(-Math.max(1, n));
  }

  lastIntent(sessionId: string): string | undefined {
    const list = this.recentTurns(sessionId, 1);
    const last = list[list.length - 1];
    return last && last.intent !== "unknown" ? last.intent : undefined;
  }

  /**
   * 路由 prompt 的状态行（最旧在前）。
   * 形态：`- 用户：「…」→ 意图 media_retrieval｜已执行工具：search_images`
   * 无记录返回空数组（调用方回退旧行为）。
   */
  promptLines(sessionId: string, n = 3): string[] {
    return this.recentTurns(sessionId, n).map((t) => {
      const tools = t.tools.length > 0 ? `｜已执行工具：${t.tools.join("、")}` : "";
      return `- 用户：「${t.userText}」→ 意图 ${t.intent}${tools}${DialogStateStore.deliveryNote(t)}`;
    });
  }

  resetForTest(): void {
    this.sessions.clear();
  }
}

export const dialogStateStore = new DialogStateStore();
