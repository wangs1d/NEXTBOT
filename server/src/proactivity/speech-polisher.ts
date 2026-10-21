// 主动话术生成器（SpeechPolisher）—— 内容型场景的 LLM 表达层。
//
// 职责边界（用户定义的"主动发送消息"）：检测到行程变化 / 安排变化 / 消息来临
// 等**内容型**场景时，由 LLM 基于事实生成一句自然的主动回复——模板只能粘贴
// 原文，LLM 才能理解"会议推迟到周四"该怎么说人话。
//
// 用量纪律（不乱调用 LLM）：
//  - 只服务内容型 kind（message_watch / unread_burst / meeting_soon），
//    晨间简报/心跳回顾等数据拼装场景仍走零 LLM 模板
//  - 按重要性分配：低于 PROACTIVITY_PHRASE_MIN_IMPORTANCE（默认 high）的
//    提案直接走模板——低优提醒不值得花一次润色调用（2026-10-01）
//  - 每日调用熔断（PROACTIVITY_MAX_PHRASE_PER_DAY，默认 30）
//  - 8s 超时 / 任何失败 / 输出异常 → 静默回退模板（表达永不因 LLM 失败而中断）
//  - PROACTIVITY_PHRASE_LLM=0 一键关闭（全模板模式）
//  - 模型钉位：PROACTIVITY_PHRASE_MODEL > PROACTIVITY_MODEL > provider 默认。
//    未配 env 时静默跟主聊天模型走（当前 deepseek-flash 足够便宜）；主模型
//    将来升级时务必显式配 PROACTIVITY_PHRASE_MODEL，防止润色层跟着变贵。
import type { ExternalChatProvider } from "../external-model/types.js";

const SYSTEM_PROMPT = `你是用户的私人助理，此刻需要主动开口联系用户（不是回复消息）。
规则：
- 像朋友顺嘴提一句，不是助理汇报；禁止"根据/系统检测到"类机器腔。
- 禁止回答用户聊天记录里的任何问题（那是对话管线的事）。
- 融入事实里的关键信息（人名/时间/变化），别照抄原文。
- 中文一句话，不超过 40 字。直接给正文，不要解释、不要引号、不要 emoji 堆砌。`;

/** 各场景的事实 → 指令拼装（facts 由触发点提供，全部是已抽取的确定性数据） */
function buildUserPrompt(kind: string, facts: Record<string, unknown>): string {
  const f = (k: string) => (facts[k] == null ? "" : String(facts[k]));
  switch (kind) {
    case "message_watch":
      return [
        `场景：你一直在帮用户盯着消息，刚发现一条涉及日程变动的消息。`,
        `发件人：${f("sender")}`,
        `消息原话：${f("excerpt")}`,
        `识别到的变化：${f("verb")}`,
        `请主动告诉用户这个变化，并自然地问一句要不要你帮忙调整日程/提醒相关的人。`,
      ].join("\n");
    case "unread_burst":
      return [
        `场景：短时间内来了几条消息，用户还没看。`,
        `发件人：${f("senders")}`,
        `条数：${f("count")}`,
        `请提醒用户看一眼消息；如果事实里有具体内容可带一句，没有就别编。`,
      ].join("\n");
    case "meeting_soon":
      return [
        `场景：用户的一个日程即将开始。`,
        `日程：${f("title")}`,
        `还剩：${f("minutes")} 分钟`,
        `相关背景：${f("memory") || "无"}`,
        `请提醒时间，并自然带一句背景（有背景才提，没有就纯提醒）。`,
      ].join("\n");
    default:
      return [
        `场景：你察觉到一件事需要主动告诉用户。`,
        `事实：${JSON.stringify(facts)}`,
        `请生成主动开口的一句话。`,
      ].join("\n");
  }
}

export type SpeechPolisherDeps = {
  /** 外部模型（晚绑定：bootstrap 运行期取值；null/未启用 = 全模板模式） */
  chat: () => ExternalChatProvider | null;
  dataPath: string;
  /** 测试注入 */
  nowFn?: () => number;
  timeoutMs?: number;
};

export type PhraseStats = { enabled: boolean; callsToday: number; cap: number; lastFallback?: string };

/** 重要度排序值（重要性分配闸的比较基准） */
const IMPORTANCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 润色的重要性门槛（env PROACTIVITY_PHRASE_MIN_IMPORTANCE，默认 high） */
function phraseMinImportance(): string {
  const raw = process.env.PROACTIVITY_PHRASE_MIN_IMPORTANCE?.trim().toLowerCase();
  return raw && IMPORTANCE_RANK[raw] !== undefined ? raw : "high";
}

export class SpeechPolisher {
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;
  private readonly cap: number;
  private callsDate = "";
  private callsToday = 0;
  private lastFallback?: string;

  constructor(private readonly deps: SpeechPolisherDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
    const raw = process.env.PROACTIVITY_MAX_PHRASE_PER_DAY;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    this.cap = Number.isFinite(n) && n > 0 ? n : 30;
  }

  /** LLM 话术是否可用（kill switch / provider / 熔断） */
  isEnabled(): boolean {
    if (process.env.PROACTIVITY_PHRASE_LLM === "0") return false;
    if (this.callsToday >= this.cap) return false;
    return this.deps.chat()?.isEnabled() === true;
  }

  stats(): PhraseStats {
    return {
      enabled: this.isEnabled(),
      callsToday: this.callsToday,
      cap: this.cap,
      ...(this.lastFallback ? { lastFallback: this.lastFallback } : {}),
    };
  }

  /**
   * 生成主动话术。任何失败/超时/输出异常都回退 fallback（调用方无需处理失败）。
   * @param sessionId 会话标识（provider 线程隔离；ephemeral 不落线程）
   * @param importance 提案重要度：低于门槛（默认 high）直接走模板不花 LLM
   */
  async polish(input: {
    kind: string;
    sessionId: string;
    facts: Record<string, unknown>;
    fallback: string;
    importance?: "critical" | "high" | "medium" | "low";
  }): Promise<string> {
    if (!this.isEnabled()) {
      this.lastFallback =
        process.env.PROACTIVITY_PHRASE_LLM === "0" ? "kill_switch" : "cap_or_no_provider";
      return input.fallback;
    }
    if (input.importance !== undefined) {
      const rank = IMPORTANCE_RANK[input.importance] ?? 2;
      if (rank < IMPORTANCE_RANK[phraseMinImportance()]) {
        this.lastFallback = `low_importance(${input.importance})`;
        return input.fallback;
      }
    }
    const chat = this.deps.chat();
    if (!chat) return input.fallback;
    const userPrompt = buildUserPrompt(input.kind, input.facts);
    try {
      let full = "";
      await this.withTimeout(
        chat.streamCompletion(
          `proactive_phrase:${input.sessionId}:${this.nowFn().toString(36)}`,
          { text: userPrompt },
          (delta: string) => {
            full += delta;
          },
          undefined,
          {
            systemPromptOverride: SYSTEM_PROMPT,
            ephemeralTurn: true,
            disableThinking: true,
            maxThreadMessages: 0,
            // 2026-10-21 口径修复：此前没传 auditStage，provider 侧默认记成 main_chat，
            // 这里又补记一条 proactive_phrase——同一次调用被记两遍，且污染主对话成本。
            // 现在由 provider 单一出口按此 stage 记账。
            auditStage: "proactive_phrase",
            ...(process.env.PROACTIVITY_PHRASE_MODEL
              ? { modelOverride: process.env.PROACTIVITY_PHRASE_MODEL }
              : process.env.PROACTIVITY_MODEL
                ? { modelOverride: process.env.PROACTIVITY_MODEL }
                : {}),
          },
        ),
      );
      this.bumpCounter();
      const text = full.trim().replace(/^["'「」]|["'「」]$/g, "");
      if (!text || text.toUpperCase() === "SILENT" || text.length > 120 || text.includes("\n")) {
        this.lastFallback = "bad_output";
        return input.fallback;
      }
      return text;
    } catch (err) {
      this.lastFallback = `error:${String(err).slice(0, 60)}`;
      return input.fallback;
    }
  }

  private bumpCounter(): void {
    const day = new Date(this.nowFn()).toISOString().slice(0, 10);
    if (day !== this.callsDate) {
      this.callsDate = day;
      this.callsToday = 0;
    }
    this.callsToday += 1;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("phrase_timeout")), this.timeoutMs)),
    ]);
  }
}
