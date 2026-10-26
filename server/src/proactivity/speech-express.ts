// 统一开口出口（SpeechHub）—— 所有 agent 主动开口的单一表达层。
//
// 2026-10-26 架构定稿（用户拍板）：说话与决策分离——「说不说/何时说」归
// BrainCenter.decide（社交）/ 映射规则+管道（必达触达），「怎么说」只归本模块。
// 取代 SpeechPolisher（per-kind 场景提示词已否决：away_return 专用 prompt 实测
// 被打回）与 ProactiveOutreachExecutor 的硬编码 system prompt。
//
// 块装配（对齐 prompt-assembler 的按需加载契约：字段空=块不渲染，稳定在前）：
//   system = 【人格·静态】(agent/SOUL.md → soul-store，主对话同源)
//          + 【语感基准】few-shot（与聊天同一副嗓子，sessionId 轮换）
//          + 单一通用【主动开口】指令块（禁 per-kind：kind 只决定 facts 材料
//            与触达约束，不生成指令文本）
//          + 画像浅层（称呼/偏好）
//   user   = 触发源给的材料（speak() 标准拼装 / speakRaw() 调用方自有任务文本，
//            如明日预告的数据段——场景语义属材料，不属人格）。
//
// 两档：
//   - light：已决定要说，只润色。零工具、单句输出、不否决（必达类语义）。
//   - full ：先做事再说。调用方（outreach executor）自带工具循环与拟人分段，
//     本模块只负责 system 块装配与用量记账。
//
// 用量纪律（继承 SpeechPolisher 全套）：kill switch（PROACTIVITY_PHRASE_LLM=0）/
// 日熔断（PROACTIVITY_MAX_PHRASE_PER_DAY，默认 30）/ 重要度门槛（
// PROACTIVITY_PHRASE_MIN_IMPORTANCE，默认 high——低优提醒不值得花润色）/
// 超时（默认 8s）。任何失败静默回退 fallback，表达永不因 LLM 失败而中断。
import type { ExternalChatProvider } from "../external-model/types.js";

/** 档位：light = 必达润色（不否决）；full = 先做事再开口（调用方持工具循环） */
export type SpeechTier = "light" | "full";

export type SpeechImportance = "critical" | "high" | "medium" | "low";

/** 统一开口请求（light 档标准路径；kind 仅进材料与审计，绝不生成指令） */
export type SpeechRequest = {
  kind: string;
  sessionId: string;
  title?: string;
  summary?: string;
  facts?: Record<string, unknown>;
  /** LLM 失败/异常/输出不合格时的回退正文（调用方必给，永不空口） */
  fallback: string;
  tier: SpeechTier;
  importance?: SpeechImportance;
  /** 输出字数上限（默认 40；明日预告 narration 等可放宽） */
  maxChars?: number;
  /** light 档默认禁换行；多句正文（如 narration）可放开 */
  allowNewlines?: boolean;
};

export type SpeechHubDeps = {
  /** 外部模型（晚绑定：bootstrap 运行期取值；null/未启用 = 全模板模式） */
  chat: () => ExternalChatProvider | null;
  dataPath: string;
  /**
   * 人格·静态（专门提示文件）：agent/SOUL.md → soul-store（identity 冻结层 +
   * disposition 演化层）→ buildPersonaStaticBlock，与主对话同字节。晚绑定。
   */
  personaPrompt?: (sessionId: string) => string | null;
  /** agent 风格指纹（few-shot 语感基准，与聊天同一副嗓子） */
  voiceProfile?: (sessionId: string) => string | null;
  /** 用户画像浅层（称呼/沟通偏好/所在地） */
  styleBrief?: (sessionId: string) => Promise<string | null> | string | null;
  nowFn?: () => number;
  timeoutMs?: number;
};

export type SpeechStats = { enabled: boolean; callsToday: number; cap: number; lastFallback?: string };

/** 重要度排序值（重要性分配闸的比较基准） */
const IMPORTANCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 润色的重要性门槛（env PROACTIVITY_PHRASE_MIN_IMPORTANCE，默认 high） */
function phraseMinImportance(): string {
  const raw = process.env.PROACTIVITY_PHRASE_MIN_IMPORTANCE?.trim().toLowerCase();
  return raw && IMPORTANCE_RANK[raw] !== undefined ? raw : "high";
}

/**
 * 单一通用【主动开口】指令块（唯一任务指令，禁 per-kind 扩展）。
 * 档位差异只在此一行的能力/长度约束——light 零工具单句；full 允许先查证。
 */
function taskInstruction(tier: SpeechTier, maxChars: number, multiline = false): string {
  const base = [
    "【主动开口】你是用户的私人助理，此刻需要主动联系用户（不是回复消息）。",
    "- 像朋友顺嘴提一句，不是助理汇报；禁止「根据/系统检测到」类机器腔。",
    "- 禁止回答用户聊天记录里的任何问题（那是对话管线的事）。",
    "- 融入事实里的关键信息（人名/时间/变化），别照抄原文。",
    "- 直接给正文，不要解释、不要引号、不要 emoji 堆砌。",
  ];
  if (tier === "light") {
    base.push(
      multiline
        ? `- 中文两三句以内（不超过 ${maxChars} 字），口语化，可换段。`
        : `- 中文一句话，不超过 ${maxChars} 字，不换行。`,
    );
  } else {
    base.push(
      "- 先判断是否需要查证或操作（天气/新闻/日程/消息等）：需要就先调用工具拿到真实结果再开口；说出口的部分简短，不超过 30 字。",
    );
  }
  return base.join("\n");
}

/** 标准材料段：触发源给的事实（JSON 平铺，模型自行取舍，别照抄） */
function buildFactsUserPrompt(req: SpeechRequest): string {
  const lines = [`场景：${req.kind}`];
  if (req.title) lines.push(`信号：${req.title}`);
  if (req.summary) lines.push(`摘要：${req.summary}`);
  if (req.facts && Object.keys(req.facts).length > 0) {
    lines.push(`事实材料：${JSON.stringify(req.facts)}`);
  }
  lines.push("请基于以上材料主动开口（说出口的话，不是给你的指令）。");
  return lines.join("\n");
}

export class SpeechHub {
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;
  private readonly cap: number;
  private readonly personaPrompt?: SpeechHubDeps["personaPrompt"];
  private readonly voiceProfile?: SpeechHubDeps["voiceProfile"];
  private readonly styleBrief?: SpeechHubDeps["styleBrief"];
  private callsDate = "";
  private callsToday = 0;
  private lastFallback?: string;

  constructor(private readonly deps: SpeechHubDeps) {
    this.personaPrompt = deps.personaPrompt;
    this.voiceProfile = deps.voiceProfile;
    this.styleBrief = deps.styleBrief;
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

  stats(): SpeechStats {
    return {
      enabled: this.isEnabled(),
      callsToday: this.callsToday,
      cap: this.cap,
      ...(this.lastFallback ? { lastFallback: this.lastFallback } : {}),
    };
  }

  /**
   * system 块装配（唯一人格注入点）：人格·静态 → 语感基准 → 通用指令 → 画像浅层。
   * 全块可选——缺失即不渲染，回退纯指令块（老行为）。
   */
  async buildSystemPrompt(opts: {
    sessionId: string;
    kind: string;
    tier: SpeechTier;
    maxChars?: number;
    /** light 档多句正文（如明日预告 narration）：指令行换成两三句口径 */
    multiline?: boolean;
  }): Promise<string> {
    const blocks: string[] = [];
    try {
      const soul = this.personaPrompt?.(opts.sessionId);
      if (soul) blocks.push(soul);
    } catch {
      /* soul 读取失败不阻塞 */
    }
    try {
      const voice = this.voiceProfile?.(opts.sessionId);
      if (voice) blocks.push(voice);
    } catch {
      /* 语感基准读取失败不阻塞 */
    }
    blocks.push(taskInstruction(opts.tier, opts.maxChars ?? 40, opts.multiline ?? false));
    try {
      const brief = await this.styleBrief?.(opts.sessionId);
      if (brief) {
        blocks.push(
          "用户画像浅层背景（细节区分用；没提到的不要编，与事实冲突时以事实为准）：\n" + brief,
        );
      }
    } catch {
      /* 画像读取失败不阻塞 */
    }
    return blocks.filter(Boolean).join("\n\n");
  }

  /**
   * light 档端到端：装配 system → LLM 单句生成 → 输出校验 → 失败回退 fallback。
   * 任何失败都只记 lastFallback，绝不抛出（表达永不中断）。
   */
  async speak(req: SpeechRequest): Promise<string> {
    return this.speakRaw({ ...req, userPrompt: buildFactsUserPrompt(req) });
  }

  /**
   * 统一 system + 调用方自有任务文本（场景语义属材料）：明日预告 narration 等
   * 数据段/结构要求复杂的调用方走此口——人格与纪律仍单点，任务文本留在 user 轮。
   */
  async speakRaw(req: SpeechRequest & { userPrompt: string }): Promise<string> {
    if (!this.isEnabled()) {
      this.lastFallback =
        process.env.PROACTIVITY_PHRASE_LLM === "0" ? "kill_switch" : "cap_or_no_provider";
      return req.fallback;
    }
    // 重要度门槛仅 light 档承担：低优提醒不值得花润色（full 档已由 decide 裁决过）
    if (req.tier === "light" && req.importance !== undefined) {
      const rank = IMPORTANCE_RANK[req.importance] ?? 2;
      if (rank < IMPORTANCE_RANK[phraseMinImportance()]) {
        this.lastFallback = `low_importance(${req.importance})`;
        return req.fallback;
      }
    }
    const chat = this.deps.chat();
    if (!chat) return req.fallback;
    let systemPrompt: string;
    try {
      systemPrompt = await this.buildSystemPrompt({
        sessionId: req.sessionId,
        kind: req.kind,
        tier: req.tier,
        maxChars: req.maxChars,
        multiline: req.allowNewlines,
      });
    } catch {
      systemPrompt = taskInstruction(req.tier, req.maxChars ?? 40, req.allowNewlines);
    }
    try {
      let full = "";
      await this.withTimeout(
        chat.streamCompletion(
          `proactive_phrase:${req.sessionId}:${this.nowFn().toString(36)}`,
          { text: req.userPrompt },
          (delta: string) => {
            full += delta;
          },
          undefined,
          {
            ephemeralTurn: true,
            disableThinking: true,
            maxThreadMessages: 0,
            // 块装配结果（人格·静态 + 语感 + 通用纪律 + 画像）由此注入 system
            systemPromptOverride: systemPrompt,
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
      const text = this.validateOutput(full, req);
      if (text === null) return req.fallback;
      return text;
    } catch (err) {
      this.lastFallback = `error:${String(err).slice(0, 60)}`;
      return req.fallback;
    }
  }

  /** full 档（outreach executor）用量记账：LLM 调用完成后调用 */
  recordUsage(): void {
    this.bumpCounter();
  }

  /** 输出校验：空/SILENT/超长/换行（light 未放开时）→ null（回退 fallback） */
  private validateOutput(raw: string, req: SpeechRequest): string | null {
    const text = raw.trim().replace(/^["'「」]|["'「」]$/g, "");
    if (!text || text.toUpperCase() === "SILENT") {
      this.lastFallback = "bad_output";
      return null;
    }
    const maxChars = req.maxChars ?? 40;
    const limit = req.tier === "light" ? Math.max(maxChars + 30, 120) : 120;
    if (text.length > limit) {
      this.lastFallback = `too_long(${text.length}>${limit})`;
      return null;
    }
    if (req.tier === "light" && !req.allowNewlines && text.includes("\n")) {
      this.lastFallback = "multiline";
      return null;
    }
    return text;
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
