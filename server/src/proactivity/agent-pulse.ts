// AgentPulseService —— Muse 式「消息聚合 → agent 审阅 → 主动开口」（2026-10-25）。
//
// 取代 mapping-rules 的 digest_beat 固定节拍（原「心跳回顾」，10/16/21 点零 LLM
// 模板播报）。用户定稿的差异：
//   - 不再固定时间：聚合材料有新增才评审（delta 闸）；何时开口由材料到达决定；
//   - 不再有「心跳回顾」标题：产出就是一条普通的主动消息（正文一两句、无标题、
//     无列表），与 agent 自己说的话无异；
//   - 不再拼天气：天气归明日预告（晚间 digest）；
//   - 说不说、说什么由 agent（LLM）判断：没有值得说的事就输出 NOP，零投递。
//
// 打扰控制（2026-10-25 用户拍板删除确定性防打扰闸）：不再有静默时段/最小间隔/
// 每日上限/负反馈预检——是否打扰完全交给两层：agent 自己的自律（提示词「宁可
// 沉默，不可打扰」+ NOP）与统一管道的 social 层仲裁（去重/频控/择时）。唯一保留
// 的本地闸是材料 delta 指纹：材料没变不重复评审（省 token，不是打扰闸）。
//
// 语气统一：审阅产出初稿后过 SpeechPolisher（统一主动语气 + 用户画像语气浅层 +
// 模型钉位 + 每日熔断），与兴趣推送/比价到价等主动话术同一副嗓子；polisher 未
// 接入/失败时直接用初稿（表达永不因语气层失败而中断）。
import { readJson, writeJson } from "./persist-file.js";

/** 一次聚合并好的原料（给 agent 审阅用；刻意不含天气——天气归明日预告） */
export type PulseAggregate = {
  /** 未来 24h 日程（含 HH:mm 时刻；课表生成的周期日程展开后也在这里） */
  tasks: string[];
  /** 未读消息发送者（MessageHub unreadCount>0 的对端） */
  unread: string[];
  /** 预执行就绪的目标（答应过用户的事有结果了） */
  goals: string[];
  /** 用户关注话题行 */
  interests: string[];
  /** 进行中目标的一句话上下文（感知 → 目标桥） */
  goalLine?: string | null;
  /** 共享发现层里还没被任何出口说过的发现（"来源：内容"行；Muse 式聚合的主体） */
  findings?: string[];
  /** 用户此刻在线状态（含持续时长，如 "active（已持续 8 分钟）"）；世界板 current.presence */
  presence?: string | null;
  /** 用户此刻屏幕焦点（含持续时长，如 "写代码（已持续 52 分钟）"）；世界板 current.screenFocus */
  screenFocus?: string | null;
  /** 最近对话摘录（用户刚说过的话；"已知的事不要重复"的事实依据）——世界板 session.recentTurns */
  recentTurns?: string[];
};

export type AgentPulseDeps = {
  /** 当前用户（单用户机装；null = 不评审） */
  actorId: () => string | null;
  /** 聚合当前材料；null/全空 = 无材料（不评审，重置指纹） */
  aggregate: (actorId: string) => PulseAggregate | null;
  /** agent 审阅（单次小 LLM 调用；未注入 = 功能关闭） */
  llmComplete?: (prompt: string) => Promise<string>;
  /**
   * 统一主动语气层（SpeechPolisher.polish 薄包装）：把审阅初稿重写成与其它
   * 主动消息同一副嗓子的最终文案；失败/未接入回退 fallback（= 初稿）。
   */
  polish?: (input: {
    kind: string;
    sessionId: string;
    facts: Record<string, unknown>;
    fallback: string;
  }) => Promise<string>;
  /** 统一管道提交（ProactivePipeline.submitProposal 的薄包装） */
  submitProposal: (p: {
    proposalId: string;
    actorId: string;
    kind: string;
    tier: "must" | "social";
    importance: "low" | "medium" | "high" | "critical";
    dedupKey: string;
    title: string;
    summary: string;
    directText: string;
    evidence: string[];
    createdAt: number;
    source: string;
  }) => unknown;
  /** 状态落盘路径（重启不重评；缺省仅内存） */
  statePath?: string;
  nowFn?: () => number;
};

/** 轮询步长（只做廉价检查；LLM 仅在材料变化时调用） */
const CHECK_INTERVAL_MS = 10 * 60_000;
/** 启动后首次评审延迟（等装配完成；状态已落盘时通常直接指纹命中跳过） */
const FIRST_CHECK_DELAY_MS = 3 * 60_000;
/** LLM 审阅超时（超时按本批材料已评审处理，不重试） */
const REVIEW_TIMEOUT_MS = 30_000;
function isPulseEnabled(): boolean {
  return process.env.AGENT_PULSE !== "0";
}

type PulseState = {
  /** 上次已评审的材料指纹（同材料不重复评审/不重发） */
  lastSignature?: Record<string, string>;
};

/** 一次评审的完整留痕（测试端点 /api/test/trigger-agent-pulse 直接返回） */
export type PulseCheckResult = {
  enabled: boolean;
  actorId: string | null;
  /** 是否真正调用了 LLM 评审 */
  ran: boolean;
  /** 未评审/未开口原因：no_material / unchanged / in_flight / disabled / no_llm / nop / llm_error / sent */
  reason?: string;
  aggregate?: PulseAggregate | null;
  signature?: string;
  prompt?: string;
  /** LLM 原始输出（未清洗） */
  raw?: string;
  /** 清洗后的初稿；NOP = null */
  message?: string | null;
  /** 统一语气层最终文案；未接入语气层时与 message 相同 */
  finalText?: string | null;
  submitted?: boolean;
  /** 管道仲裁结果（delivered / deferred / merged / suppressed / silenced / throttled / expired / dropped） */
  verdict?: string;
  /** 本次材料来自测试端点 fixture（不写指纹，不污染真实评审状态） */
  fixture?: boolean;
};

/** 材料指纹：稳定 stringify 后 FNV-1a（内容变一点 → 指纹全变） */
export function pulseSignature(a: PulseAggregate): string {
  const stable = JSON.stringify([
    a.tasks,
    a.unread,
    a.goals,
    a.interests,
    a.goalLine ?? null,
    a.findings ?? [],
    // 此刻状态也在指纹里：状态变了（如用户回到电脑前）值得带着新语境重审一次
    a.presence ?? null,
    a.screenFocus ?? null,
    a.recentTurns ?? [],
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 清洗 LLM 输出：剥包裹/折叠成一句；NOP 或空 → null（不开口） */
export function sanitizePulseMessage(raw: string | undefined): string | null {
  let text = (raw ?? "").trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
  if (/^["'「『]/.test(text) && /["'」』]$/.test(text)) text = text.slice(1, -1).trim();
  if (!text) return null;
  if (/^(nop|silence|无|没有|没什么|无事)\s*[。.!！]?$/i.test(text)) return null;
  // 折行成一句（提示词已要求不列表，这里兜底折叠）
  text = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (text.length > 220) text = `${text.slice(0, 219)}…`;
  return text;
}

/** 降价/盯梢类消息判定：用户点名让 agent 盯的事有了结果 = 用户自己下的单，
 *  走 must 层随到随送（与专用盯价道 price_watch_hit 同语义，2026-10-25 用户定稿） */
const PRICE_NEWS_RE = /降价|价格|降到|打折|便宜|好价|比价|盯[着住的]/;
export function isPriceNews(text: string): boolean {
  return PRICE_NEWS_RE.test(text);
}

export function buildPulsePrompt(now: Date, a: PulseAggregate): string {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const material: string[] = [`现在时间：${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hhmm(now)}（周${weekday}）`];
  if (a.presence || a.screenFocus) {
    const state: string[] = [];
    if (a.presence) state.push(`在线：${a.presence}`);
    if (a.screenFocus) state.push(`屏幕：${a.screenFocus}`);
    material.push(`【用户此刻状态】${state.join("；")}`);
  }
  if (a.tasks.length) material.push(`【今日与未来 24h 安排】\n${a.tasks.map((t) => `- ${t}`).join("\n")}`);
  if (a.unread.length) material.push(`【未读消息】${a.unread.join("、")}`);
  if (a.goals.length) material.push(`【已备好的结果（答应过用户的事）】\n${a.goals.map((t) => `- ${t}`).join("\n")}`);
  if (a.interests.length) material.push(`【用户关注的话题】${a.interests.join("；")}`);
  if (a.goalLine) material.push(`【进行中的目标】${a.goalLine}`);
  if (a.findings?.length) material.push(`【还没跟用户说过的发现（邮件/日历/目标等渠道攒下的）】\n${a.findings.map((t) => `- ${t}`).join("\n")}`);
  if (a.recentTurns?.length) material.push(`【最近对话摘录（这些用户已经知道，不要重复提）】\n${a.recentTurns.map((t) => `- ${t}`).join("\n")}`);
  // 固定指令在前、逐次变化的材料在后：DeepSeek 前缀缓存按请求前缀命中，
  // 这个顺序让每次评审只有材料段是 cache miss（输入成本约降一个数量级）
  return [
    "你是用户的私人助理。你每隔一段时间会收到一批后台聚合的信息，请判断：现在是否值得主动给用户发一条消息？",
    "",
    "判断标准：",
    "- 只在确实有值得现在说的事时才开口：日程有冲突或马上要到期的安排、重要的人发来未读、答应过用户的事有了结果、用户关心的动态有了新进展。",
    "- 例行汇报、凑数、没有信息量的话一律不开口。宁可沉默，不可打扰。",
    "- 开口时机参考用户此刻状态：专注工作/离线时非必要不打断，刚回到电脑前、空闲时更适合说话。",
    "- 用户已知的事（最近对话里提过的、之前已经说过的）不要重复。",
    "",
    "输出要求：",
    "- 开口时像同伴随口说一句：一两句话、口语化、直接说事；不要标题、不要列表、不要 markdown、不要客套。一次只说最重要的一件事。",
    "- 只输出消息正文本身；如果没有值得说的，只输出 NOP。",
    "",
    "【本次聚合材料】",
    material.join("\n"),
  ].join("\n");
}

export class AgentPulseService {
  private readonly state: PulseState = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private readonly nowFn: () => number;

  constructor(private readonly deps: AgentPulseDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    if (deps.statePath) {
      try {
        const restored = readJson<PulseState>(deps.statePath, {});
        if (restored.lastSignature) this.state.lastSignature = restored.lastSignature;
      } catch {
        /* 损坏文件按空状态处理 */
      }
    }
  }

  start(): void {
    if (this.timer || !this.deps.llmComplete || !isPulseEnabled()) return;
    this.bootTimer = setTimeout(() => {
      void this.check();
    }, FIRST_CHECK_DELAY_MS);
    if (typeof this.bootTimer.unref === "function") this.bootTimer.unref();
    this.timer = setInterval(() => {
      void this.check();
    }, CHECK_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log("[AgentPulse] 已启动（Muse 式聚合评审；打扰控制=agent 自律 NOP + 管道 social 仲裁）");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  /** 主动触发一次评审（定时器/测试端点共用；返回完整留痕供检查）。
   *  fixture（测试端点）：注入替代材料走完全真实的评审/语气/投递链路，
   *  不写指纹不污染真实评审状态。 */
  async check(opts?: {
    force?: boolean;
    fixture?: Partial<PulseAggregate>;
  }): Promise<PulseCheckResult> {
    const enabled = isPulseEnabled() && !!this.deps.llmComplete;
    const actorId = this.deps.actorId();
    if (!enabled) return { enabled: false, actorId, ran: false, reason: "disabled" };
    if (!actorId) return { enabled, actorId, ran: false, reason: "no_actor" };
    if (this.inFlight) return { enabled, actorId, ran: false, reason: "in_flight" };
    this.inFlight = true;
    try {
      return await this.reviewOnce(actorId, opts?.force === true, opts?.fixture);
    } catch (err) {
      console.log(`[AgentPulse] 评审失败（忽略）: ${err}`);
      return { enabled, actorId, ran: false, reason: `error:${String(err).slice(0, 60)}` };
    } finally {
      this.inFlight = false;
    }
  }

  private async reviewOnce(
    actorId: string,
    force = false,
    fixture?: Partial<PulseAggregate>,
  ): Promise<PulseCheckResult> {
    const now = new Date(this.nowFn());
    const aggregate: PulseAggregate | null = fixture
      ? {
          tasks: fixture.tasks ?? [],
          unread: fixture.unread ?? [],
          goals: fixture.goals ?? [],
          interests: fixture.interests ?? [],
          goalLine: fixture.goalLine ?? null,
          findings: fixture.findings,
          presence: fixture.presence ?? null,
          screenFocus: fixture.screenFocus ?? null,
          recentTurns: fixture.recentTurns,
        }
      : this.deps.aggregate(actorId);
    const hasMaterial =
      aggregate !== null &&
      (aggregate.tasks.length > 0 ||
        aggregate.unread.length > 0 ||
        aggregate.goals.length > 0 ||
        aggregate.interests.length > 0 ||
        (aggregate.findings?.length ?? 0) > 0 ||
        !!aggregate.goalLine);
    if (!aggregate || !hasMaterial) {
      if (!fixture) this.setSignature(actorId, "");
      return { enabled: true, actorId, ran: false, reason: "no_material", aggregate, fixture: !!fixture };
    }
    const signature = pulseSignature(aggregate);
    const base = { enabled: true, actorId, aggregate, signature, fixture: !!fixture };
    // delta 闸：材料没变不评审（省 token；不是打扰闸——材料一变就再看）。
    // force（测试端点）绕过：重复评审同一材料看真实产出。
    if (!fixture && !force && this.signatureOf(actorId) === signature) {
      return { ...base, ran: false, reason: "unchanged" };
    }

    const prompt = buildPulsePrompt(now, aggregate);
    let raw: string | null = null;
    try {
      raw = await Promise.race([
        this.deps.llmComplete!(prompt),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), REVIEW_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.log(`[AgentPulse] LLM 评审异常（本批材料跳过）: ${err}`);
      // 评审失败也记账：同一批材料不反复重试（新材料会再次触发）
      if (!fixture) this.setSignature(actorId, signature);
      return { ...base, ran: true, reason: "llm_error", prompt, raw: String(err) };
    }
    const message = sanitizePulseMessage(raw ?? "");
    if (!message) {
      // agent 判断不值得说：记指纹，这批材料不再评审
      if (!fixture) this.setSignature(actorId, signature);
      return { ...base, ran: true, reason: "nop", prompt, raw: raw ?? "", message: null };
    }

    // 统一语气层：初稿 → 与其它主动消息同一副嗓子（失败回退初稿）
    let finalText = message;
    if (this.deps.polish) {
      try {
        finalText =
          (await this.deps.polish({
            kind: "agent_pulse",
            sessionId: actorId,
            facts: {
              draft: message,
              context: [
                aggregate.tasks.length ? `安排：${aggregate.tasks.join("；")}` : "",
                aggregate.unread.length ? `未读：${aggregate.unread.join("、")}` : "",
                aggregate.goals.length ? `备好的结果：${aggregate.goals.join("；")}` : "",
                aggregate.findings?.length ? `相关发现：${aggregate.findings.join("；")}` : "",
              ]
                .filter(Boolean)
                .join("。"),
            },
            fallback: message,
          })) || message;
      } catch {
        finalText = message;
      }
    }

    // 降价/盯梢类消息 = 用户点名要的事 → must 层随到随送（绕过社交预算与
    // 2h 冷却；与专用盯价道 price_watch_hit 同语义）。其余保持 social。
    const priceNews = isPriceNews(finalText);
    const decision = this.deps.submitProposal({
      proposalId: `p_${this.nowFn().toString(36)}_pulse`,
      actorId,
      kind: priceNews ? "agent_pulse_price" : "agent_pulse",
      tier: priceNews ? "must" : "social",
      importance: priceNews ? "medium" : "low",
      dedupKey: `agent_pulse:${fixture ? "fixture_" : ""}${signature}`,
      // 无标题（用户定稿：不再有「心跳回顾」牌子），正文即消息
      title: "",
      summary: finalText,
      directText: finalText,
      evidence: [
        "agent_pulse",
        `sig=${signature}`,
        ...(fixture ? ["fixture"] : []),
        ...(priceNews ? ["price_news_must"] : []),
        "muse_review",
      ],
      createdAt: this.nowFn(),
      source: "initiative",
    });
    if (!fixture) this.setSignature(actorId, signature);
    this.persist();
    const verdict =
      decision && typeof decision === "object" && "verdict" in decision
        ? String((decision as { verdict?: unknown }).verdict)
        : undefined;
    console.log(
      `[AgentPulse] 主动开口 actor=${actorId} sig=${signature} verdict=${verdict ?? "?"} text="${finalText.slice(0, 50)}"`,
    );
    return {
      ...base,
      ran: true,
      reason: "sent",
      prompt,
      raw: raw ?? "",
      message,
      finalText,
      submitted: true,
      verdict,
    };
  }

  private signatureOf(actorId: string): string {
    return this.state.lastSignature?.[actorId] ?? "";
  }

  private setSignature(actorId: string, signature: string): void {
    if ((this.state.lastSignature?.[actorId] ?? "") === signature) return;
    this.state.lastSignature = { ...this.state.lastSignature, [actorId]: signature };
    this.persist();
  }

  private persist(): void {
    if (!this.deps.statePath) return;
    try {
      writeJson(this.deps.statePath, this.state);
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }
}
