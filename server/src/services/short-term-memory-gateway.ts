import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { join } from "node:path";
import { Bm25LiteIndex } from "../agent/retrieval/bm25-lite.js";

export type TaskStackEntry = {
  taskId: string;
  title: string;
  status: "active" | "paused" | "completed";
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
};

type SessionTaskState = {
  activeTaskId: string | null;
  tasks: TaskStackEntry[];
  conversationMemory?: SessionConversationMemory;
};

/** 会话情景记忆：单窗口下保真收录每轮对话，供"可检索/反查/分层回顾"使用（不硬截断）。 */
export type EpisodicTurn = {
  /** 全局递增轮次号（跨会话单调，用于召回时的先后判定） */
  idx: number;
  user: string;
  assistant: string;
  ts: number;
};

/** 实体/事实台账条目：保留原句语义，而非只掐首句。 */
export type EpisodicFact = {
  kind: "preference" | "fact" | "context";
  sentence: string;
  ts: number;
};

export type PersistedSessionEpisodic = {
  turns: EpisodicTurn[];
  facts: EpisodicFact[];
};

type PersistedTaskState = {
  sessions: Record<string, SessionTaskState>;
  /** 会话全量情景记忆（按会话持久化，重启后可重建检索索引） */
  episodic?: Record<string, PersistedSessionEpisodic>;
  /** 跨会话单调递增的轮次计数（用于召回排序与先后判定） */
  episodicIdx?: number;
  /**
   * openLoops/agentCommitments 首次入栈时间台账（sessionId → 条目原文 → epoch ms）。
   * TTL 清理与结清判定的时间源；条目文本为 key（入栈时已去重规范化）。
   */
  loopFirstSeen?: Record<string, Record<string, number>>;
};

type SessionConversationMemory = {
  activeTopic: string | null;
  currentMission: string | null;
  carryForward: string[];
  preferences: string[];
  facts: string[];
  openLoops: string[];
  agentCommitments: string[];
  /** 连续 topic_switch 轮数（P2：连续切换 K 轮后旧 currentMission 失效置空） */
  topicSwitchStreak?: number;
  lastUpdated: string;
};

export type TaskSyncResult = {
  task: TaskStackEntry;
  resumed: boolean;
};

export type TaskTurnDisposition =
  | { action: "none" }
  | { action: "pause"; reason: string }
  | { action: "complete"; reason: string };

type TurnFocusKind = "task_followup" | "meta_debug" | "emotion_pause" | "topic_switch" | "new_task";

type TurnFocusResolution = {
  kind: TurnFocusKind;
  includeTaskScopedMemory: boolean;
  preserveRecentContext: boolean;
  reason: string;
};

const MEMORY_LIST_LIMIT = 6;
/** 会话情景记忆容量上限：全量原文入盘（零 token），仅保留最近 N 轮控制磁盘增长。 */
const EPISODIC_MAX_TURNS = 600;
/** 单轮 user/assistant 各自截取的最大字符（保真原文，仅防失控长文本撑爆磁盘） */
const EPISODIC_MAX_TURN_CHARS = 1200;
/** 实体/事实台账上限（原句去重保留，前缀优先） */
const EPISODIC_MAX_FACTS = 240;
/** 会话内即时检索返回的命中轮次上限（直接对应注入 prompt 的 token 费用） */
const EPISODIC_SEARCH_K = 4;
/** 会话内即时检索返回的命中原文总字符预算（控制 token 消耗） */
const EPISODIC_SEARCH_CHAR_BUDGET = 900;
/**
 * 助手承诺话术（2026-09-06 P2 收紧）。
 *
 * 旧版 /我会|我将|我先|稍后|接下来|我去|我帮你/i 过松：子串误伤（"被我将了一军"）
 * + 把过去时闲聊当承诺，导致 agentCommitments 堆满普通聊天句并随每轮注入。
 * 新版要求第一人称**未来动作 + 具体动作类型**；且判定对象改为**入栈的首句**
 * （此前对全文匹配、只存首句，承诺证据与存储内容脱节）。
 */
const ASSISTANT_COMMITMENT_RE =
  /(?:(?:我|这就|马上|回头|稍后|待会|今晚|明天|下午|晚上|一小时后|半小时后|\d+分钟(?:后|内)|等(?:我|一下))[^。！？\n]{0,8}(?:查|搜|办|做|弄|安排|订|买|发|送|整理|回复|回你|跟进|处理|通知|拿给你|给你)|i (?:will|'ll)|let me (?:check|search|find|handle))/i;

/** 疑问/请示语境不是承诺（"明天发你好吗"是请示不是承诺）。 */
const ASSISTANT_COMMITMENT_EXCLUDE_RE =
  /行不[?？]|好吗[?？]|好不好|要不要|怎么样[?？]|如何[?？]|可不可以|能不能|还是/;

/** P2：挂起栈容量上限（此前 MEMORY_LIST_LIMIT=6 且只进不出，跨天堆积）。 */
const OPEN_LOOPS_LIMIT = 5;
const AGENT_COMMITMENTS_LIMIT = 3;
/** P2：连续 topic_switch 达该轮数且无活动任务 → currentMission 置空。 */
const TOPIC_SWITCH_MISSION_RESET_STREAK = 2;
/** P2：结清判定阈值（条目与本轮助手回复的字符二元组重合度，实测完成场景 ≈0.36-0.6）。 */
const LOOP_SETTLE_OVERLAP = 0.45;

function resolveLoopTtlMs(): number {
  const raw = process.env.AGENT_STM_LOOP_TTL_MS?.trim();
  if (!raw) return 6 * 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 6 * 60 * 60 * 1000;
}

const USER_PREFERENCE_RE = /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|remember|prefer/i;
const USER_FACT_RE = /我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我需要/i;
const REQUEST_RE = /请|帮我|需要|想要|分析|总结|提醒|安排|继续|修复|优化|看看|做一个/i;
const CONTINUITY_TURN_RE =
  /^(?:这个|那个|这块|那块|它|他|她|他们|这些|那些|这里|那里|刚才那个|上面那个|继续|接着|往下|然后呢|再说说|展开|细说|具体点|详细点|怎么做|怎么办|咋办|改一下|修一下|优化一下|继续做|继续看|继续修|继续优化|this|that|it|they|continue|go on|next|then|fix it|improve it)(?:[。！？?!,.，\s]*|呢|啊|吧|哈|嘛|呀)*$/i;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeInput(text)
    .toLowerCase()
    .split(/[\s,.;:!?，。；：！？、/\\|()[\]{}<>]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function overlapScore(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

function isTaskSeekingTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  if (REQUEST_RE.test(normalized)) return true;
  if (normalized.length >= 18) return true;
  return false;
}

function isContinuityTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  if (CONTINUITY_TURN_RE.test(normalized)) return true;
  // 「重新」入表（2026-09-09）：「重新找/重新搜」类短指代此前不命中续接判定，
  // 被解析成 topic_switch → recent-context/episodic 块均不注入（短期记忆漏注入事故点）。
  if (normalized.length <= 12 && /^(?:这|那|它|他|她|继续|接着|然后|再|重新|改|修|看|做|this|that|it|next|then)/i.test(normalized)) {
    return true;
  }
  return false;
}

function hasMetaAgentDebugSignal(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return /agent|assistant|bot|模型|大模型|助手|智能体|回复|对话|话题|串台|跑题|切换话题|回复对象|上下文|记忆|短期记忆|焦点|归因|提示词|prompt|system|调试|路由|旧任务|上一轮|上次对话|旧话题/i.test(
    normalized,
  );
}

function hasEmotionPauseSignal(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return /好累|累呀|累了|心累|疲惫|烦死|烦了|崩溃|不想弄|先不想|歇一下|缓一下|太折腾|太难受|受不了了|tired|exhausted|overwhelmed/i.test(
    normalized,
  );
}

function isShortAffectiveTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return normalized.length <= 24 && hasEmotionPauseSignal(normalized);
}

function mergeContextSummary(previous: string, next: string, maxLen = 240): string {
  const prev = normalizeInput(previous);
  const incoming = normalizeInput(next);
  if (!prev) return incoming.slice(0, maxLen);
  if (!incoming || prev === incoming || prev.includes(incoming)) return prev.slice(0, maxLen);
  if (incoming.includes(prev)) return incoming.slice(0, maxLen);
  const merged = `${prev} / latest: ${incoming}`;
  return merged.length <= maxLen ? merged : `${prev.slice(0, 150)} / latest: ${incoming.slice(0, 70)}`;
}

function shouldPauseFromUserText(text: string): boolean {
  return /(先放一边|先暂停|暂停一下|等等再说|回头再做|晚点再弄|稍后继续|先不做了|先搁置)/i.test(text);
}

function shouldCompleteFromUserText(text: string): boolean {
  return /(搞定了|完成了|结束了|这个任务做完了|就这样吧|不用继续了|可以收尾了|已经处理好了)/i.test(text);
}

function shouldCompleteFromAssistantText(text: string): boolean {
  return /(已完成|已经完成|处理完成|任务完成|执行完成|已经为你.*(完成|处理好)|全部完成)/i.test(text);
}

function shouldPauseFromAssistantText(text: string): boolean {
  return /(已先暂停|先为你挂起|等待你确认后继续|后续可继续|你随时可以继续这个任务)/i.test(text);
}

function firstSentence(text: string, maxLen = 160): string {
  const normalized = normalizeInput(text);
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?\n]/)[0]?.trim() || normalized;
  return sentence.length > maxLen ? `${sentence.slice(0, maxLen - 3).trimEnd()}...` : sentence;
}

function pushUnique(target: string[], value: string, limit = MEMORY_LIST_LIMIT): void {
  const normalized = normalizeInput(value);
  if (!normalized) return;
  const deduped = target.filter((item) => normalizeInput(item) !== normalized);
  deduped.unshift(normalized);
  target.splice(0, target.length, ...deduped.slice(0, limit));
}

/**
 * 字符二元组重合度（P2 结清判定）：中文无空格分词，token 级 overlapScore 对
 * "帮我规划去马尔代夫" vs "马尔代夫行程搞定了"几乎必然为 0；bigram 重合度
 * 才能感知"同一事项被本轮对话正面处理"。
 */
function charBigrams(text: string): Set<string> {
  const t = normalizeInput(text).toLowerCase().replace(/[\s，。！？!?.,:：;；]/g, "");
  const set = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function bigramOverlapScore(a: string, b: string): number {
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const gram of A) if (B.has(gram)) hits += 1;
  return hits / Math.min(A.size, B.size);
}

/**
 * 承诺判定：对**入栈首句**（而非全文）做承诺匹配 + 疑问排除。旧实现对全文匹配、
 * 只存首句，导致承诺栈里堆满"哎哟，被我将了一军"这类首句与承诺无关的闲聊。
 */
function looksLikeAssistantCommitment(sentence: string): boolean {
  if (!sentence) return false;
  if (ASSISTANT_COMMITMENT_EXCLUDE_RE.test(sentence)) return false;
  return ASSISTANT_COMMITMENT_RE.test(sentence);
}

/**
 * 短 ping（P2 防带跑）：称呼/寒暄式超短消息（"小弟"/"在吗"/"哈哈"）。
 * 结构上不携带任何新指令，是"答旧话题还魂"的高发输入。
 */
function isShortPingTurn(text: string | undefined): boolean {
  const t = normalizeInput(text ?? "");
  if (!t || t.length > 4) return false;
  if (/[?？!！。，,]/.test(t)) return false;
  if (isContinuityTurn(t)) return false;
  if (REQUEST_RE.test(t)) return false;
  return true;
}

function createEmptyConversationMemory(): SessionConversationMemory {
  return {
    activeTopic: null,
    currentMission: null,
    carryForward: [],
    preferences: [],
    facts: [],
    openLoops: [],
    agentCommitments: [],
    lastUpdated: nowIso(),
  };
}

export class ShortTermMemoryGatewayService {
  private readonly filePath: string;
  private data: PersistedTaskState = { sessions: {} };
  private persistChain: Promise<void> = Promise.resolve();
  /** 会话级 BM25 索引缓存（searchEpisodic 用），key = sessionId */
  private episodicBmCache = new Map<string, { idx: Bm25LiteIndex; count: number; firstIdx: number }>();

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_SHORT_TERM_STACK_FILE?.trim() ?? join(process.cwd(), "data", "short-term-task-stack.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedTaskState;
      if (parsed?.sessions && typeof parsed.sessions === "object") {
        this.data = parsed;
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
    }
  }

  activateTask(sessionId: string, title: string, contextSummary: string): TaskStackEntry {
    const state = this.getSessionState(sessionId);
    const previousActive = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (previousActive && previousActive.status === "active") {
      previousActive.status = "paused";
      previousActive.updatedAt = nowIso();
    }

    const task: TaskStackEntry = {
      taskId: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      status: "active",
      contextSummary,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.tasks.unshift(task);
    state.tasks = state.tasks.slice(0, 20);
    state.activeTaskId = task.taskId;
    this.schedulePersist();
    return task;
  }

  syncTaskForTurn(sessionId: string, input: string): TaskSyncResult {
    const normalizedInput = normalizeInput(input);
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const focus = this.resolveTurnFocus(normalizedInput, active, state.conversationMemory);

    if (active && focus.includeTaskScopedMemory) {
      const activeScore = Math.max(
        overlapScore(`${active.title} ${active.contextSummary}`, normalizedInput),
        normalizedInput.toLowerCase().includes(active.title.toLowerCase()) ? 0.9 : 0,
      );
      if (activeScore >= 0.35) {
        active.contextSummary = mergeContextSummary(active.contextSummary, normalizedInput);
        active.updatedAt = nowIso();
        this.schedulePersist();
        return { task: active, resumed: false };
      }
      if (isContinuityTurn(normalizedInput)) {
        active.contextSummary = mergeContextSummary(active.contextSummary, normalizedInput);
        active.updatedAt = nowIso();
        this.schedulePersist();
        return { task: active, resumed: false };
      }
    }

    if (focus.includeTaskScopedMemory) {
      const pausedMatch = state.tasks
        .filter((task) => task.status === "paused")
        .map((task) => ({
          task,
          score: Math.max(
            overlapScore(`${task.title} ${task.contextSummary}`, normalizedInput),
            normalizedInput.toLowerCase().includes(task.title.toLowerCase()) ? 0.9 : 0,
          ),
        }))
        .sort((a, b) => b.score - a.score)[0];

      if (pausedMatch && pausedMatch.score >= 0.45) {
        const resumed = this.resumeTask(sessionId, pausedMatch.task.taskId);
        if (resumed) {
          resumed.contextSummary = mergeContextSummary(resumed.contextSummary, normalizedInput);
          resumed.updatedAt = nowIso();
          this.schedulePersist();
          return { task: resumed, resumed: true };
        }
      }
    }

    if (!focus.includeTaskScopedMemory && active) {
      return { task: active, resumed: false };
    }

    return {
      task: this.activateTask(sessionId, normalizedInput.slice(0, 36), normalizedInput.slice(0, 180)),
      resumed: false,
    };
  }

  pauseActiveTask(sessionId: string, contextSummary?: string): void {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (!active) return;
    active.status = "paused";
    if (contextSummary?.trim()) active.contextSummary = contextSummary.trim();
    active.updatedAt = nowIso();
    state.activeTaskId = null;
    this.schedulePersist();
  }

  resumeTask(sessionId: string, taskId: string): TaskStackEntry | null {
    const state = this.getSessionState(sessionId);
    const next = state.tasks.find((task) => task.taskId === taskId);
    if (!next) return null;
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (active && active.taskId !== taskId) {
      active.status = "paused";
      active.updatedAt = nowIso();
    }
    next.status = "active";
    next.updatedAt = nowIso();
    state.activeTaskId = next.taskId;
    this.schedulePersist();
    return next;
  }

  completeTask(sessionId: string, taskId: string): void {
    const state = this.getSessionState(sessionId);
    const task = state.tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    task.status = "completed";
    task.updatedAt = nowIso();
    if (state.activeTaskId === taskId) state.activeTaskId = null;
    this.schedulePersist();
  }

  reconcileTaskAfterTurn(sessionId: string, userText: string, assistantText: string): TaskTurnDisposition {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    if (!active) {
      this.observeConversationTurn(sessionId, userText, assistantText, { action: "none" });
      return { action: "none" };
    }

    const normalizedUser = normalizeInput(userText);
    const normalizedAssistant = normalizeInput(assistantText);

    if (shouldCompleteFromUserText(normalizedUser) || shouldCompleteFromAssistantText(normalizedAssistant)) {
      this.completeTask(sessionId, active.taskId);
      const disposition = { action: "complete", reason: "turn_completed" } as const;
      this.observeConversationTurn(sessionId, userText, assistantText, disposition);
      return disposition;
    }

    if (shouldPauseFromUserText(normalizedUser) || shouldPauseFromAssistantText(normalizedAssistant)) {
      this.pauseActiveTask(sessionId, normalizedUser.slice(0, 180) || active.contextSummary);
      const disposition = { action: "pause", reason: "turn_paused" } as const;
      this.observeConversationTurn(sessionId, userText, assistantText, disposition);
      return disposition;
    }

    const disposition = { action: "none" } as const;
    this.observeConversationTurn(sessionId, userText, assistantText, disposition);
    return disposition;
  }

  getTaskState(sessionId: string): SessionTaskState {
    const state = this.getSessionState(sessionId);
    return {
      activeTaskId: state.activeTaskId,
      tasks: [...state.tasks],
      conversationMemory: {
        ...state.conversationMemory!,
        currentMission: state.conversationMemory!.currentMission,
        carryForward: [...state.conversationMemory!.carryForward],
        preferences: [...state.conversationMemory!.preferences],
        facts: [...state.conversationMemory!.facts],
        openLoops: [...state.conversationMemory!.openLoops],
        agentCommitments: [...state.conversationMemory!.agentCommitments],
      },
    };
  }

  buildPromptContext(
    sessionId: string,
    currentInput?: string,
    understanding?: import("../agent/task-router.js").TurnUnderstanding,
  ): string | undefined {
    const state = this.getTaskState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 3);
    const completed = state.tasks.filter((task) => task.status === "completed").slice(0, 2);
    const lines: string[] = [];
    const memory = state.conversationMemory;
    // P2：读取路径 TTL 清理——陈年 openLoops/agentCommitments 到期即不再注入。
    if (memory) this.pruneLoopEntries(sessionId, memory);
    const focus = this.resolveTurnFocus(currentInput, active, memory);
    const includeTaskScopedMemory = focus.includeTaskScopedMemory;

    // P2 短 ping 防带跑：无活动任务时，称呼/寒暄式超短消息（"小弟"/"在吗"）
    // 结构上不携带新指令，显式告知 LLM 只回应这一声本身——"小弟"被拿去回答
    // 悬空天气问题的根源修补。
    if (!active && isShortPingTurn(currentInput)) {
      lines.push(
        "本条无新指令：对方只是称呼/寒暄，必须只回应这一声本身；不要延续任何旧话题、旧任务或未回答的问题。",
      );
    }

    if (active && includeTaskScopedMemory) {
      lines.push(`current-focus: ${active.title}`);
      lines.push(`important focus-summary: ${active.contextSummary}`);
    }
    if (paused.length > 0 && includeTaskScopedMemory) {
      lines.push(`suspended-tasks: ${paused.map((task) => `${task.title} | ${task.contextSummary}`).join(" || ")}`);
    }
    if (completed.length > 0 && includeTaskScopedMemory) {
      lines.push(`recently-completed: ${completed.map((task) => task.title).join(" | ")}`);
    }
    // 话题信号：检测当前输入与上一话题是「延续」还是「切换」，
    // 显式告诉 LLM 该基于上下文作答还是只回应本条新话题。
    // 实测（chat 模型）仍必须保留：#30 家具轮在无信号时被上一轮天气工具状态带跑、
    // #20 电影轮串入搬家/出差记忆。
    // 用 active.title + contextSummary 作为话题参照（contextSummary 含完整事实，如"华强科技/出差"）。
    const topicRef = active ? `${active.title} ${active.contextSummary}` : (memory?.activeTopic || null);
    const topicSignal = includeTaskScopedMemory ? this.buildTopicSignal(currentInput, topicRef) : undefined;
    if (topicSignal) {
      lines.push(`important ${topicSignal}`);
    }
    // 延续话题时强制注入最近对话原文（recent-context）：
    // #5 场景「我这次出差要去见哪家公司」被 shouldInjectTaskScopedMemory 判定为不相关，
    // 导致 carryForward 被拦掉、LLM 看不到上一轮用户原文 → 答「没存过」。
    const isTopicFollowUp = topicSignal?.startsWith("topic-followup") === true;
    const recentContext = this.selectRecentContextForFocus(memory?.carryForward ?? [], currentInput, focus);
    if (recentContext.length && (includeTaskScopedMemory || isTopicFollowUp || focus.preserveRecentContext)) {
      lines.push(`recent-context: ${recentContext.join(" || ")}`);
    }
    if (memory?.currentMission && includeTaskScopedMemory) {
      lines.push(`current-mission: ${memory.currentMission}`);
    }
    if (memory?.preferences.length) {
      lines.push(`session-preferences: ${memory.preferences.join(" || ")}`);
    }
    if (memory?.facts.length) {
      lines.push(`session-facts: ${memory.facts.join(" || ")}`);
    }
    if (memory?.openLoops.length && includeTaskScopedMemory) {
      lines.push(`open-loops: ${memory.openLoops.join(" || ")}`);
    }
    if (memory?.agentCommitments.length && includeTaskScopedMemory) {
      lines.push(`agent-commitments: ${memory.agentCommitments.join(" || ")}`);
    }

    // ---- 会话情景记忆注入（去硬截断）----
    // 仅在「延续/指代/回忆/短追问」轮次按需灌回命中的原文（episodic-context）：
    // 滚动上下文对中早期对话做了硬截断，但保真台账里留有原文。
    // 这里把命中的完整轮次灌回 prompt，让 LLM 能"看到"之前聊过的细节，
    // 从而回答"好想他→(刘浩存)"这类指代反查。命中即收费，未命中零开销。
    const episodicLines = this.buildEpisodicContextForInput(sessionId, currentInput, focus, isTopicFollowUp, memory, understanding);
    if (episodicLines.length) {
      lines.push(...episodicLines);
    }

    // incoming-turn 行已删除：当前用户消息本身就以 user 消息角色进入 messages 数组，
    // 在 STM 上下文块里再抄一份 ≤180 字符属纯重复注入。

    const { coreLines, compressedLines } = this.compressContext(lines);
    const merged = [...coreLines, ...compressedLines].slice(0, 12);
    if (merged.length === 0) return undefined;
    return ["STM project memory:", ...merged.map((line) => `- ${line}`)].join("\n");
  }

  /**
   * 只读判定当前轮用户输入的话题焦点（不修改任何状态）。
   * 供上层（agent-core）对长期记忆召回做门控：当焦点为 topic_switch
   * （用户已切换话题、无任务延续、无指代）时，应抑制跨会话/旧话题的长期记忆注入，
   * 避免"串台"——把别的会话记忆塞进当前新话题。
   */
  getTurnFocusKind(sessionId: string, currentInput: string): TurnFocusKind {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    return this.resolveTurnFocus(currentInput, active, state.conversationMemory).kind;
  }

  // 记忆架构重构：buildRecallQuery 已删除。
  // 原实现把当前任务/挂起任务/话题/使命/openLoops/用户偏好拼进长期记忆检索 query，
  // 导致每轮召回永远锚定旧任务簇（召回串台 + 幻觉根因）。
  // 新架构：长期检索由 agent/recall-gate.ts 白名单门控，query 只用用户原文。

  compressContext(lines: string[]): { coreLines: string[]; compressedLines: string[] } {
    const coreLines = lines.filter((line) => /重要|必须|务必|偏好|禁忌|记住|SOP|步骤|流程/.test(line)).slice(0, 8);
    const compressedLines = lines
      .filter((line) => !coreLines.includes(line))
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-10);
    return { coreLines, compressedLines };
  }

  private getSessionState(sessionId: string): SessionTaskState {
    if (!this.data.sessions[sessionId]) {
      this.data.sessions[sessionId] = {
        activeTaskId: null,
        tasks: [],
        conversationMemory: createEmptyConversationMemory(),
      };
    }
    if (!this.data.sessions[sessionId]!.conversationMemory) {
      this.data.sessions[sessionId]!.conversationMemory = createEmptyConversationMemory();
    }
    if (!this.data.episodic) this.data.episodic = {};
    if (!this.data.episodic[sessionId]) {
      this.data.episodic[sessionId] = { turns: [], facts: [] };
    }
    return this.data.sessions[sessionId]!;
  }

  /** 取全局递增轮次号（跨会话单调，用于召回时的先后判定）。 */
  private nextEpisodicIdx(): number {
    const next = (this.data.episodicIdx ?? 0) + 1;
    this.data.episodicIdx = next;
    return next;
  }

  private observeConversationTurn(
    sessionId: string,
    userText: string,
    assistantText: string,
    disposition: TaskTurnDisposition,
  ): void {
    const state = this.getSessionState(sessionId);
    const memory = state.conversationMemory ?? createEmptyConversationMemory();
    state.conversationMemory = memory;

    const userSentence = firstSentence(userText);
    const assistantSentence = firstSentence(assistantText);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const focus = this.resolveTurnFocus(userText, active, memory);
    const effectiveActive = focus.includeTaskScopedMemory ? active : null;

    memory.activeTopic =
      effectiveActive?.title || this.inferTopicFromUserText(userText) || memory.activeTopic || null;

    // P2：话题连续切换计数 + 陈年使命失效。旧契约 currentMission 无限期沿用
    // （"马尔代夫行程"跨天存活、每轮注入），是带跑新话题的串台燃料。
    if (focus.kind === "topic_switch" && !effectiveActive) {
      memory.topicSwitchStreak = (memory.topicSwitchStreak ?? 0) + 1;
      if ((memory.topicSwitchStreak ?? 0) >= TOPIC_SWITCH_MISSION_RESET_STREAK) {
        memory.currentMission = null;
      }
    } else {
      memory.topicSwitchStreak = 0;
    }
    memory.currentMission = this.inferMissionFromTurn(userText, assistantText, effectiveActive, memory.currentMission);

    if (USER_PREFERENCE_RE.test(userText)) {
      pushUnique(memory.preferences, userSentence);
    }
    if (USER_FACT_RE.test(userText)) {
      pushUnique(memory.facts, userSentence);
    }
    if (assistantSentence) {
      pushUnique(memory.carryForward, `assistant: ${assistantSentence}`, 4);
    }
    if (userSentence) {
      pushUnique(memory.carryForward, `user: ${userSentence}`, 4);
    }

    // P2 结清：先按本轮对话清掉已被正面处理的挂起项（完成/否决/接续），再做
    // 本轮入栈——旧契约只在任务 disposition=complete 时清理，闲聊轮 action 恒为
    // "none"，栈只进不出、跨天堆积。重新产生承诺/请求时下方 push 重新补入。
    this.settleLoopEntries(memory, userText, assistantText);

    // P2：承诺判定改用入栈首句（证据与存储内容一致），容量上限 3。
    if (assistantSentence && looksLikeAssistantCommitment(assistantSentence)) {
      pushUnique(memory.agentCommitments, assistantSentence, AGENT_COMMITMENTS_LIMIT);
      if (disposition.action !== "complete") {
        pushUnique(memory.openLoops, assistantSentence, OPEN_LOOPS_LIMIT);
      }
    }

    if (effectiveActive && disposition.action !== "complete") {
      pushUnique(memory.openLoops, `${effectiveActive.title} | ${effectiveActive.contextSummary}`, OPEN_LOOPS_LIMIT);
    } else if (!effectiveActive && REQUEST_RE.test(userText) && disposition.action === "none") {
      pushUnique(memory.openLoops, userSentence, OPEN_LOOPS_LIMIT);
    }

    if (disposition.action === "complete") {
      this.removeMatching(memory.openLoops, userText, assistantText, effectiveActive?.title);
      this.removeMatching(memory.agentCommitments, userText, assistantText, effectiveActive?.title);
    }

    if (disposition.action === "pause" && effectiveActive) {
      pushUnique(memory.openLoops, `${effectiveActive.title} | ${effectiveActive.contextSummary}`, OPEN_LOOPS_LIMIT);
    }

    // P2：TTL 清理 + 首见时间台账维护（新条目记为 now，已移除条目的 key 回收）。
    this.pruneLoopEntries(sessionId, memory);
    this.stampLoopEntries(sessionId, memory);

    memory.lastUpdated = nowIso();
    this.recordEpisodicTurn(sessionId, userText, assistantText);
    this.schedulePersist();
  }

  /**
   * 会话情景记忆：保真收录本轮 user/assistant 原文入盘（零 token）。
   * 单窗口滚动上下文对中早期对话做硬截断后，LLM 丢的是 token 空间，
   * 但这里保留的是原文本身——后续「会话内即时检索」/「锚点解析」可把命中的
   * 原文按需灌回 prompt，做到"不被剪、按需收费"。
   */
  private recordEpisodicTurn(sessionId: string, userText: string, assistantText: string): void {
    const user = normalizeInput(userText).slice(0, EPISODIC_MAX_TURN_CHARS);
    const assistant = normalizeInput(assistantText).slice(0, EPISODIC_MAX_TURN_CHARS);
    if (!user && !assistant) return;

    const epi = this.data.episodic?.[sessionId];
    if (!epi) return;

    epi.turns.push({
      idx: this.nextEpisodicIdx(),
      user,
      assistant,
      ts: Date.now(),
    });
    // 磁盘有界：仅保留最近 N 轮原文
    if (epi.turns.length > EPISODIC_MAX_TURNS) {
      epi.turns.splice(0, epi.turns.length - EPISODIC_MAX_TURNS);
    }

    this.recordEpisodicFacts(sessionId, user, assistant);
  }

  /** 实体/事实台账：保留原句语义（而非只掐首句），供「指代/反查锚点」精确命中。 */
  private recordEpisodicFacts(sessionId: string, userText: string, assistantText: string): void {
    const epi = this.data.episodic?.[sessionId];
    if (!epi) return;
    const now = Date.now();
    const candidates: Array<{ kind: EpisodicFact["kind"]; sentence: string }> = [];

    for (const sentence of this.splitSentences(userText)) {
      if (USER_FACT_RE.test(sentence)) candidates.push({ kind: "fact", sentence });
      else if (USER_PREFERENCE_RE.test(sentence)) candidates.push({ kind: "preference", sentence });
    }
    for (const sentence of this.splitSentences(assistantText)) {
      if (ASSISTANT_COMMITMENT_RE.test(sentence)) candidates.push({ kind: "context", sentence });
    }
    // 兜底：抽取对话中的实体性短句（2-24 字问句/陈述推进事实账），去虚词噪音
    if (candidates.length === 0) {
      for (const sentence of this.splitSentences(userText)) {
        const s = sentence.replace(/[。！？!?]/g, "").trim();
        if (s.length >= 2 && s.length <= 24 && this.isEntityLike(s)) {
          candidates.push({ kind: "fact", sentence: s });
          break;
        }
      }
    }

    for (const c of candidates) {
      const sentence = normalizeInput(c.sentence);
      if (!sentence) continue;
      const dup = epi.facts.some((f) => normalizeInput(f.sentence) === sentence);
      if (dup) continue;
      epi.facts.unshift({ kind: c.kind, sentence: sentence.slice(0, 120), ts: now });
    }
    if (epi.facts.length > EPISODIC_MAX_FACTS) {
      epi.facts.length = EPISODIC_MAX_FACTS;
    }
  }

  /** 把一段对话拆成句（支持中英文句末标点）。 */
  private splitSentences(text: string): string[] {
    if (!text) return [];
    return normalizeInput(text)
      .split(/[。！？!?；;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
  }

  /** 粗略判定是否为实体性短语（不含口语虚词/疑问尾缀的过短判断）。 */
  private isEntityLike(sentence: string): boolean {
    if (/^(?:你是|你是谁|你好|谢谢|好的|嗯|来了|在吗|继续|然后)$/i.test(sentence)) return false;
    return true;
  }

  /**
   * 固化取数接口（回喂长期记忆）：返回本会话的实体/事实台账原句。
   * 由长期记忆固化层（MemoryManagerService）消费，把保真原文写入长期记忆，
   * 从而让「跨会话召回」能拿到上一会话的细节，强化连续性。
   */
  getEpisodicConsolidationFacts(sessionId: string): EpisodicFact[] {
    const epi = this.data.episodic?.[sessionId];
    if (!epi) return [];
    return epi.facts.map((f) => ({ ...f }));
  }

  /**
   * 会话级 BM25 索引缓存：台账只在追加/修剪时变化。
   * firstIdx 未变 → 只增量 upsert 新轮次；前端修剪 / 缩短 → 整体重建。
   * maxDocs 固定为 EPISODIC_MAX_TURNS，增量追加期间不触发 LRU 淘汰。
   */
  private episodicBm25(sessionId: string, epi: PersistedSessionEpisodic): Bm25LiteIndex {
    const turns = epi.turns;
    const firstIdx = turns[0]?.idx ?? -1;
    const cached = this.episodicBmCache.get(sessionId);
    if (cached && cached.firstIdx === firstIdx && turns.length >= cached.count) {
      for (let i = cached.count; i < turns.length; i++) {
        const turn = turns[i]!;
        cached.idx.upsert(String(turn.idx), `${turn.user ?? ""} ${turn.assistant ?? ""}`);
      }
      cached.count = turns.length;
      return cached.idx;
    }
    const idx = new Bm25LiteIndex(EPISODIC_MAX_TURNS);
    for (const turn of turns) {
      idx.upsert(String(turn.idx), `${turn.user ?? ""} ${turn.assistant ?? ""}`);
    }
    // 防长驻进程会话数无界增长
    if (this.episodicBmCache.size >= 200) this.episodicBmCache.clear();
    this.episodicBmCache.set(sessionId, { idx, count: turns.length, firstIdx });
    return idx;
  }

  /**
   * 会话内即时检索（省 token 召回）：在保真台账上做零-embedding 词法检索，
   * 返回与 query 相关度最高的最近 K 轮原文。只把命中内容灌回 prompt。
   *
   * 打分升级（2026-08）：主排序改为 BM25（IDF 加权——"的/我/吗"这类高频字不再
   * 平权，罕见实词命中权重更高），保留原覆盖余弦作兜底（BM25 零命中时的短查询
   * 兜底），取二者较大值。台账 ≤600 条，索引按会话缓存，新轮次增量 upsert，
   * 前端修剪（超 EPISODIC_MAX_TURNS）时整体重建。
   */
  searchEpisodic(sessionId: string, query: string, k = EPISODIC_SEARCH_K): EpisodicTurn[] {
    const epi = this.data.episodic?.[sessionId];
    if (!epi || epi.turns.length === 0) return [];
    const q = normalizeInput(query);
    if (!q) return [];

    const bm25 = this.episodicBm25(sessionId, epi);
    const bm25Hits = new Map(
      bm25.search(query, epi.turns.length).map((h) => [h.id, h.score] as const),
    );

    const scored = epi.turns.map((turn) => {
      const userScore = this.episodicCosine(turn.user, q);
      const assistantScore = this.episodicCosine(turn.assistant, q);
      const cosine = Math.max(userScore, assistantScore * 0.9);
      const rawBm25 = bm25Hits.get(String(turn.idx)) ?? 0;
      // BM25 原始分平滑到 (0,1)（单调：分越高越接近 1），与余弦同尺度可比
      const bm25Norm = rawBm25 > 0 ? rawBm25 / (rawBm25 + 3) : 0;
      return { turn, score: Math.max(bm25Norm, cosine * 0.85) };
    });

    // 词法检索只保留有实际命中的轮次（>0），再按近因偏置排序（同分取更新的）
    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.turn.idx - a.turn.idx)
      .slice(0, k);

    // 去重：同一 idx 只保留一次
    const seen = new Set<number>();
    const out: EpisodicTurn[] = [];
    for (const h of hits) {
      if (seen.has(h.turn.idx)) continue;
      seen.add(h.turn.idx);
      out.push(h.turn);
    }
    return out;
  }

  /**
   * 指代/反查锚点解析：query 为指代/短追问（"好想他""那家公司"）时，
   * 先从事实台账精确反查最近匹配原句，再从最近原文轮次补齐上下文。
   */
  resolveEpisodicAnchors(sessionId: string, query: string): EpisodicTurn[] {
    const epi = this.data.episodic?.[sessionId];
    if (!epi) return [];
    const q = normalizeInput(query);
    if (!q) return [];

    // 1) 优先从事实台账反查：指代多半落在最近几个实体/事实原句上
    const anchorTimes: number[] = [];
    for (const f of epi.facts.slice(0, 40)) {
      if (this.factRelevance(f.sentence, q)) anchorTimes.push(f.ts);
    }
    // 2) 命中台账原句的 ts → 找到最近的完整轮次
    const anchorIdxs = new Set<number>();
    for (const t of epi.turns) {
      for (const at of anchorTimes) {
        if (Math.abs(t.ts - at) < 6 * 60 * 1000) anchorIdxs.add(t.idx);
      }
    }
    // 3) 兜底：最近 2 轮原文直接作上下文锚点（短追问默认指代最近内容）
    for (const recentIdx of epi.turns.slice(-2).map((t) => t.idx)) {
      anchorIdxs.add(recentIdx);
    }

    const out = epi.turns.filter((t) => anchorIdxs.has(t.idx)).slice(-EPISODIC_SEARCH_K);
    return out;
  }

  /**
   * 决定是否注入情景记忆并渲染为 prompt 行（命中即收 token，未命中零开销）。
   * 仅「延续/指代/回忆」轮次触发；话题切换（topic_switch）不注入，避免串台 + 省 token。
   */
  private buildEpisodicContextForInput(
    sessionId: string,
    currentInput: string | undefined,
    focus: TurnFocusResolution,
    isTopicFollowUp: boolean,
    memory?: SessionConversationMemory,
    understanding?: import("../agent/task-router.js").TurnUnderstanding,
  ): string[] {
    const input = normalizeInput(currentInput ?? "");
    if (!input) return [];

    // 指代/回忆判定（2026-10-10 词表判定退役）：优先读模型判定（追问轮/锚定
    // 上文/想回忆更早内容）；understanding 缺省（路由失败）退化为本地延续/回忆
    // 启发。纯指代短句（"好想他""那家公司"）即使被 resolveTurnFocus 视为
    // topic_switch（无任务锚点），仍是此前内容的延续，必须允许反查。
    const isReferent =
      (understanding
        ? understanding.isFollowUp ||
          understanding.reference !== "none" ||
          understanding.recallIntent
        : isContinuityTurn(input) || this.isRecallOrFollowUp(input)) ||
      /(他|她|他们|她们|它|这个|那个|这儿|那儿)/.test(input);
    // 真正干净的无关话题切换（无指代/回忆信号）才抑制注入，避免串台 + 省 token
    const isCleanSwitch = focus.kind === "topic_switch" && !focus.preserveRecentContext && !isTopicFollowUp;
    if (!isReferent && isCleanSwitch) return [];

    let turns: EpisodicTurn[] = [];
    if (isReferent) {
      // 指代：锚点反查最近原文 + 当前话题扩展后的会话检索，union 去重
      const anchors = this.resolveEpisodicAnchors(sessionId, input);
      const topicExpanded = memory?.activeTopic
        ? this.searchEpisodic(sessionId, normalizeInput(`${input} ${memory.activeTopic}`))
        : [];
      const seen = new Set<number>();
      for (const t of [...anchors, ...topicExpanded]) {
        if (seen.has(t.idx)) continue;
        seen.add(t.idx);
        turns.push(t);
      }
    } else {
      turns = this.searchEpisodic(sessionId, input);
    }
    if (turns.length === 0) return [];

    const parts: string[] = [];
    let budget = EPISODIC_SEARCH_CHAR_BUDGET;
    for (const t of turns) {
      let frag: string;
      if (t.user && t.assistant) {
        frag = `U:${t.user.slice(0, 90)} / A:${t.assistant.slice(0, 90)}`;
      } else if (t.user) {
        frag = `U:${t.user.slice(0, 120)}`;
      } else {
        frag = `A:${t.assistant.slice(0, 120)}`;
      }
      if (budget - frag.length <= 0) break;
      parts.push(frag);
      budget -= frag.length;
    }
    if (parts.length === 0) return [];
    return [
      `important episodic-memory: ${parts.join(" || ")}（以上为本会话此前若干轮的原文，非本轮新指令；如与本轮问题相关请直接引用其中内容作答，无关可忽略）`,
    ];
  }

  /** 事实台账单句相关度：query 实体词命中原句得分的轻量近似。 */
  private factRelevance(factSentence: string, query: string): number {
    let hit = 0;
    const factTokens = new Set(tokenize(factSentence));
    const qTokens = new Set(tokenize(query));
    // 中文场景：zhGrams 覆盖无空格分词
    const qGrams = this.zhGrams(query);
    const fGrams = this.zhGrams(factSentence);
    for (const g of qGrams) if (fGrams.has(g)) hit++;
    for (const t of qTokens) if (factTokens.has(t)) hit++;
    return hit > 0 ? 1 : 0;
  }

  /** 词法相关度（分数>0 即视为命中）：英文 token 集合命中率 与 中文 2-gram 命中率 取最大值。
 *  中文无空格分词，整句会被 tokenize 切成单个 token 导致精确 include 失效，
 *  因此中文场景依赖 zhGrams 二元组命中率，英文/实体词用 token 集合。 */
  private episodicCosine(text: string, query: string): number {
    if (!text) return 0;
    const a = tokenize(text);
    const b = tokenize(query);
    const bSet = new Set(b);
    let tokenHit = 0;
    for (const t of bSet) if (a.includes(t)) tokenHit++;
    const tokenScore = bSet.size > 0 ? tokenHit / bSet.size : 0;

    const ag = this.zhGrams(text);
    const bg = this.zhGrams(query);
    let gramHit = 0;
    for (const g of bg) if (ag.has(g)) gramHit++;
    const gramScore = bg.size > 0 ? gramHit / bg.size : 0;

    return Math.max(tokenScore, gramScore);
  }

  private inferTopicFromUserText(userText: string): string | null {
    const normalized = normalizeInput(userText);
    if (!normalized) return null;
    if (normalized.length <= 48) return normalized;
    return firstSentence(normalized, 48);
  }

  /** 中文 2-gram 词元集：解决中文无空格分词导致的 overlapScore 失效问题。 */
  private zhGrams(text: string): Set<string> {
    const chars = normalizeInput(text);
    const grams = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) {
      const g = chars.slice(i, i + 2);
      if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
    }
    return grams;
  }

  /** 中文 2-gram 相似度：衡量当前输入与上一话题的词汇重叠（0~1）。 */
  private topicSimilarity(input: string, topic: string): number {
    const a = this.zhGrams(input);
    const b = this.zhGrams(topic);
    if (a.size === 0 || b.size === 0) return 0;
    let hits = 0;
    for (const g of a) {
      if (b.has(g)) hits += 1;
    }
    return hits / Math.max(Math.min(a.size, b.size), 1);
  }

  /** 回忆/指代信号：询问"之前/上次/说过/记得"的内容，或短追问，都属于延续。 */
  private isRecallOrFollowUp(input: string): boolean {
    if (/之前|上次|说过|刚才|刚刚|前面|还记得|记得|来着|earlier|before|last time|you said|remember/i.test(input)) return true;
    // 事实问句：询问具体事实（公司/人名/名字/吃什么/多少钱/哪个城市等）通常是延续性追问
    if (/哪家|哪家公司|叫什么|姓什么|吃什么|几点|多少钱|多少预算|哪个城市|去哪里|是什么|哪位/i.test(input)) return true;
    if (/^(?:那个|这个|它|他|她|他们|那些|这里|那家|刚才那个|上面那个|continue|go on|then|next)/i.test(input)) return true;
    return false;
  }

  /**
   * 话题信号生成：判断当前输入相对上一话题是「延续」还是「切换」。
   * - 延续（指代/回忆/词汇重叠）：提示 LLM 基于会话上下文作答；
   * - 切换（明显不相关）：提示 LLM 只回应本条新话题，不延续旧话题内容。
   * 这是话题串台的程序层兜底：flash 模型对"平淡陈述句"容易回退到记忆中的旧话题。
   */
  private buildTopicSignal(currentInput: string | undefined, previousTopic: string | null): string | undefined {
    const input = normalizeInput(currentInput ?? "");
    if (!input || !previousTopic) return undefined;

    if (isContinuityTurn(input) || this.isRecallOrFollowUp(input)) {
      const topic = previousTopic.slice(0, 60);
      return `topic-followup: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀）：本条延续上一话题，必须基于会话上下文作答；若询问之前提过的事实（公司/人名/计划），直接根据上下文回答，不要说没存过。`;
    }

    const sim = this.topicSimilarity(input, previousTopic);
    if (sim >= 0.2) {
      const topic = previousTopic.slice(0, 60);
      return `topic-followup: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀）：本条与上一话题相关，必须基于会话上下文作答；若询问之前提过的事实，直接根据上下文回答。`;
    }

    const topic = previousTopic.slice(0, 60);
    return `topic-switched: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀，如"[话题切换]"）：用户已切换话题，本条必须只回应本条消息本身——不要延续上一话题的内容、不要引用上一轮的工具结果或记忆（如搬家/出差/天气），直接干净地作答。`;
  }

  private resolveTurnFocus(
    currentInput: string | undefined,
    active: TaskStackEntry | null,
    memory: SessionConversationMemory | undefined,
  ): TurnFocusResolution {
    const normalized = normalizeInput(currentInput ?? "");
    if (!normalized) {
      return {
        kind: "task_followup",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "empty_input",
      };
    }

    const metaDebug = hasMetaAgentDebugSignal(normalized);
    const emotionPause = hasEmotionPauseSignal(normalized);
    if (metaDebug) {
      return {
        kind: "meta_debug",
        includeTaskScopedMemory: false,
        preserveRecentContext: true,
        reason: emotionPause ? "meta_debug_with_emotion" : "meta_debug_signal",
      };
    }
    if (emotionPause && (isShortAffectiveTurn(normalized) || !isContinuityTurn(normalized))) {
      return {
        kind: "emotion_pause",
        includeTaskScopedMemory: false,
        preserveRecentContext: true,
        reason: "emotion_pause_signal",
      };
    }
    if (isTaskSeekingTurn(normalized)) {
      return {
        kind: active ? "task_followup" : "new_task",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "task_seeking_turn",
      };
    }
    if (isContinuityTurn(normalized) && (active || memory?.currentMission || memory?.openLoops.length)) {
      return {
        kind: "task_followup",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "continuity_turn",
      };
    }

    const anchors = [
      active ? `${active.title} ${active.contextSummary}` : "",
      memory?.currentMission ?? "",
      memory?.openLoops[0] ?? "",
    ].filter(Boolean);

    for (const anchor of anchors) {
      if (overlapScore(anchor, normalized) >= 0.25) {
        return {
          kind: "task_followup",
          includeTaskScopedMemory: true,
          preserveRecentContext: true,
          reason: "anchor_overlap",
        };
      }
    }

    return {
      kind: "topic_switch",
      includeTaskScopedMemory: false,
      preserveRecentContext: false,
      reason: "no_task_anchor",
    };
  }

  private selectRecentContextForFocus(
    carryForward: string[],
    currentInput: string | undefined,
    focus: TurnFocusResolution,
  ): string[] {
    if (carryForward.length === 0) return [];
    if (focus.includeTaskScopedMemory) return carryForward;

    const input = normalizeInput(currentInput ?? "");
    if (focus.kind === "meta_debug") {
      const selected = carryForward.filter(
        (line) => hasMetaAgentDebugSignal(line) || (input && overlapScore(line, input) >= 0.18),
      );
      return (selected.length > 0 ? selected : carryForward.slice(0, 2)).slice(0, 4);
    }

    if (focus.kind === "emotion_pause") {
      const metaContext = carryForward.filter((line) => hasMetaAgentDebugSignal(line));
      return (metaContext.length > 0 ? metaContext : carryForward.slice(0, 2)).slice(0, 4);
    }

    return [];
  }

  private shouldInjectTaskScopedMemory(
    currentInput: string | undefined,
    active: TaskStackEntry | null,
    memory: SessionConversationMemory | undefined,
  ): boolean {
    return this.resolveTurnFocus(currentInput, active, memory).includeTaskScopedMemory;
  }

  private inferMissionFromTurn(
    userText: string,
    assistantText: string,
    active: TaskStackEntry | null,
    previousMission: string | null,
  ): string | null {
    if (active) {
      return `${active.title} | ${active.contextSummary}`.slice(0, 180);
    }

    const userSentence = firstSentence(userText, 180);
    if (REQUEST_RE.test(userText) && userSentence) {
      return userSentence;
    }

    const assistantSentence = firstSentence(assistantText, 180);
    if (looksLikeAssistantCommitment(assistantSentence)) {
      return assistantSentence;
    }

    return previousMission;
  }

  private loopLedger(sessionId: string): Record<string, number> {
    if (!this.data.loopFirstSeen) this.data.loopFirstSeen = {};
    if (!this.data.loopFirstSeen[sessionId]) this.data.loopFirstSeen[sessionId] = {};
    return this.data.loopFirstSeen[sessionId]!;
  }

  /**
   * P2：openLoops/agentCommitments TTL 清理（读取与写入路径都调用）。
   * 旧契约只在任务 complete 时移除，闲聊轮 action 恒为 "none"——栈只进不出，
   * "四分钟后提醒我参加会议"这类早已过期的条目跨天堆积并被周期性注入。
   */
  private pruneLoopEntries(sessionId: string, memory: SessionConversationMemory): void {
    const ttl = resolveLoopTtlMs();
    if (ttl <= 0) return;
    const ledger = this.data.loopFirstSeen?.[sessionId];
    if (!ledger) return;
    const now = Date.now();
    const prune = (list: string[]): string[] => {
      if (list.length === 0) return list;
      const kept = list.filter((text) => {
        const seen = ledger[text];
        // 无台账记录的存量条目：宽限到下轮 observe 补记后再计时，不在读取路径误删
        return typeof seen !== "number" || now - seen <= ttl;
      });
      for (const text of list) {
        if (!kept.includes(text)) delete ledger[text];
      }
      return kept;
    };
    memory.openLoops = prune(memory.openLoops);
    memory.agentCommitments = prune(memory.agentCommitments);
  }

  /**
   * P2 结清：本轮助手回复与某条挂起事项高度重合（bigram ≥ 0.45）→ 该事项已被
   * 本轮正面处理（完成/否决/接续），从挂起栈移除。只看助手侧（用户重问不算
   * 结清——那恰是事项仍活跃的信号）；入栈在结清之后执行，本轮新产生的
   * 承诺/请求不受影响。
   */
  private settleLoopEntries(
    memory: SessionConversationMemory,
    _userText: string,
    assistantText: string,
  ): void {
    if (memory.openLoops.length === 0 && memory.agentCommitments.length === 0) return;
    const settle = (target: string[]): void => {
      const kept = target.filter(
        (entry) => bigramOverlapScore(entry, assistantText) < LOOP_SETTLE_OVERLAP,
      );
      target.splice(0, target.length, ...kept);
    };
    settle(memory.openLoops);
    settle(memory.agentCommitments);
  }

  /** P2：首见时间台账维护——新条目记为 now，已不在栈内的条目 key 回收。 */
  private stampLoopEntries(sessionId: string, memory: SessionConversationMemory): void {
    const ledger = this.loopLedger(sessionId);
    const now = Date.now();
    const valid = new Set([...memory.openLoops, ...memory.agentCommitments]);
    for (const key of Object.keys(ledger)) {
      if (!valid.has(key)) delete ledger[key];
    }
    for (const text of valid) {
      if (typeof ledger[text] !== "number") ledger[text] = now;
    }
  }

  private removeMatching(target: string[], ...candidates: Array<string | null | undefined>): void {
    const tokens = new Set(
      candidates
        .flatMap((value) => tokenize(value ?? ""))
        .filter((token) => token.length >= 2),
    );
    if (tokens.size === 0) return;
    const filtered = target.filter((line) => {
      const lineTokens = tokenize(line);
      return !lineTokens.some((token) => tokens.has(token));
    });
    target.splice(0, target.length, ...filtered);
  }

  /**
   * 清空指定会话的短期任务栈与情景记忆（内存 + 持久化），用于"清空聊天/失忆"。
   * 返回被清理的 session 数量。
   */
  clearSessions(sessionIds: string[]): number {
    let removed = 0;
    for (const sessionId of sessionIds) {
      if (this.data.sessions?.[sessionId]) {
        delete this.data.sessions[sessionId];
        removed++;
      }
      if (this.data.episodic?.[sessionId]) {
        delete this.data.episodic[sessionId];
      }
    }
    if (removed > 0) {
      this.schedulePersist();
      console.log(`[STM] clearSessions 完成：清理 ${removed} 个会话`);
    }
    return removed;
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(async () => {
      await writeJsonAtomic(this.filePath, this.data);
    });
  }
}

let singleton: ShortTermMemoryGatewayService | null = null;

export function getShortTermMemoryGatewayService(): ShortTermMemoryGatewayService | null {
  return singleton;
}

export async function initShortTermMemoryGatewayService(filePath?: string): Promise<ShortTermMemoryGatewayService> {
  if (singleton) return singleton;
  const service = filePath ? new ShortTermMemoryGatewayService(filePath) : new ShortTermMemoryGatewayService();
  await service.load();
  singleton = service;
  return service;
}
