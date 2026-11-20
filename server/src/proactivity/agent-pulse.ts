// AgentPulseService —— 主动性模块的「消息聚合 → agent 审阅 → 主动开口」（2026-10-25）。
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
// 语气统一：审阅产出初稿后过 SpeechHub light 档（统一主动语气 + 用户画像语气浅层 +
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
  /** 共享发现层里还没被任何出口说过的发现（"来源：内容"行；主动性聚合的主体） */
  findings?: string[];
  /** 用户此刻在线状态（含持续时长，如 "active（已持续 8 分钟）"）；世界板 current.presence */
  presence?: string | null;
  /** 用户此刻屏幕焦点（含持续时长，如 "写代码（已持续 52 分钟）"）；世界板 current.screenFocus */
  screenFocus?: string | null;
  /** 最近对话摘录（用户刚说过的话；"已知的事不要重复"的事实依据）——世界板 session.recentTurns */
  recentTurns?: string[];
  /**
   * 距上次用户对话的分钟数（null = 从没聊过）。
   * 关系时钟的输入：>6h 才允许「没事找话说」的社交型开口。
   */
  idleMinutes?: number | null;
  /**
   * 没聊完 / 没结果的事（在办目标、待收尾的事、上次说到一半的话题）。
   * 「接一下上次的话」的锚点来源——没有锚点的主动消息就是 ping。
   */
  openLoops?: string[];
  /**
   * 你记得的他（2026-11-19）：称呼、城市、职业、稳定偏好这类画像事实，
   * 3-5 行、每行 ≤40 字。
   *
   * 为什么必须有：C 类「单纯打个招呼」在没有画像素材时只能产出
   * 「在吗 / 最近怎么样」这类空话——用户一眼就看出是模板。
   * 闲聊的锚点不该只来自「刚才发生了什么」，还该来自「我知道你是谁」。
   */
  rapport?: string[];
  /**
   * 此刻在哪（位置语义，2026-11-19）：闲聊最自然的锚点不是天气，是「我看到你在哪」。
   * kind: home / work / other；label 是常去地点的语义名（公司/健身房），
   * city/poi 兜底；updatedMinutesAgo > 120 就视为旧数据，不进 prompt。
   */
  place?: {
    kind: "home" | "work" | "other" | "unknown";
    label?: string;
    city?: string;
    poi?: string;
    updatedMinutesAgo?: number;
  } | null;
  /** 在动吗：still / walking / vehicle（和 place 组合出「你在外面？去哪」这类话头） */
  activity?: "still" | "walking" | "vehicle" | "unknown" | null;
  /** 最近情绪（只在非 neutral 时给）：情绪低时闲聊要收着，别自顾自唠 */
  mood?: "positive" | "negative" | "stressed" | null;
};

export type AgentPulseDeps = {
  /** 本轮评审的用户（多租户：一次 tick 覆盖所有活跃 actor；空数组 = 不评审） */
  actors: () => string[];
  /** 聚合当前材料；null/全空 = 无材料（不评审，重置指纹）。
   *  可返回 Promise：画像读取是异步的（闲聊需要「他是谁」这类素材）。 */
  aggregate: (actorId: string) => PulseAggregate | null | Promise<PulseAggregate | null>;
  /** agent 审阅（单次小 LLM 调用；未注入 = 功能关闭） */
  llmComplete?: (prompt: string) => Promise<string>;
  /**
   * 统一主动语气层（SpeechHub.speak 薄包装）：把审阅初稿重写成与其它
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

// ── 关系时钟（2026-11-19：主动性重构 P0）────────────────────────────
// 旧逻辑「材料全空 → 不评审」等于「没事发生就永不开口」，主动性退化成告警器。
// 关系时钟给「无材料」一条独立的评审通道：隔得够久、时间合适，就给它一次想
// 想要不要说句话的机会——说不说仍由 LLM 判断（NOP 合法）。
/** 距上次对话超过这么久，才允许纯社交型开口 */
export const SOCIAL_IDLE_MINUTES = 6 * 60;
/** 两次「无材料社交评审」的最小间隔（既是 token 闸也是打扰节流，一天最多 4 次） */
export const SOCIAL_REVIEW_GAP_MS = 4 * 60 * 60 * 1000;
/** 允许社交开口的时段：本地时间 [start, end) */
export const SOCIAL_ACTIVE_HOUR = { start: 8, end: 22 } as const;

function isSocialHour(now: Date): boolean {
  const h = now.getHours();
  return h >= SOCIAL_ACTIVE_HOUR.start && h < SOCIAL_ACTIVE_HOUR.end;
}

function isPulseEnabled(): boolean {
  return process.env.AGENT_PULSE !== "0";
}

type PulseState = {
  /** 上次已评审的材料指纹（同材料不重复评审/不重发） */
  lastSignature?: Record<string, string>;
  /** 上次「无材料社交评审」的时间戳（关系时钟节流） */
  lastSocialReviewAt?: Record<string, number>;
  /** 上次真正产出并提交了消息的时间戳（诊断 + 防连发） */
  lastSpokeAt?: Record<string, number>;
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
  /** 多用户 tick 时逐用户的完整结果（单用户不填） */
  results?: PulseCheckResult[];
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
    // 没聊完的事变了 = 值得带着新语境重审一次
    a.openLoops ?? [],
    // 此刻状态也在指纹里：状态变了（如用户回到电脑前）值得带着新语境重审一次
    a.presence ?? null,
    a.screenFocus ?? null,
    a.recentTurns ?? [],
    // 注：idleMinutes 刻意不进指纹——它每 10 分钟都在变，进来会让指纹闸失效、
    // 每轮都烧一次 LLM。关系时钟单独管「无事也评审」的节奏。
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 从画像 markdown 里抽「你记得的他」——给闲聊用的锚点事实。
 *
 * 为什么不直接把整份画像塞进 prompt：画像默认上限 3500 字，而 pulse 是一次
 * 小模型调用（省 token 是设计前提）。这里只取「key：value」型的短事实，
 * 5 行以内、每行 40 字封顶，足够让 C 类招呼像「认识的人」而不是模板。
 *
 * 敏感字段一律不进 prompt：主动消息会出现在锁屏/通知栏，
 * 记忆里的事不等于适合这个渠道说（主流陪伴产品的共同教训）。
 */
const RAPPORT_SENSITIVE = /密码|身份证|银行卡|卡号|手机号|电话号|住址|门牌|工资|薪|token|api[_-]?key|邮箱/i;

export function extractRapport(profile: string | undefined, max = 4): string[] {
  if (!profile) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of profile.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*\*{0,2}([^：:*#]{1,16})\*{0,2}[：:]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim().replace(/\*\*/g, "");
    if (!key || !value) continue;
    if (RAPPORT_SENSITIVE.test(key) || RAPPORT_SENSITIVE.test(value)) continue;
    const line = `${key}：${value.length > 40 ? `${value.slice(0, 39)}…` : value}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
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

export function buildPulsePrompt(
  now: Date,
  a: PulseAggregate,
  opts?: { socialPath?: boolean },
): string {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const material: string[] = [`现在时间：${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hhmm(now)}（周${weekday}）`];
  if (a.presence || a.screenFocus) {
    const state: string[] = [];
    if (a.presence) state.push(`在线：${a.presence}`);
    if (a.screenFocus) state.push(`屏幕：${a.screenFocus}`);
    material.push(`【用户此刻状态】${state.join("；")}`);
  }
  // 同一条安排可能被多条写入路径重复落库（去重收敛在 createTask，这里再兜一层：
  // 重复行会让审阅把「同一件事」误判成「两件事撞车」）。
  const tasks = [...new Set(a.tasks.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (tasks.length) material.push(`【今日与未来 24h 安排】\n${tasks.map((t) => `- ${t}`).join("\n")}`);
  if (a.unread.length) material.push(`【未读消息】${a.unread.join("、")}`);
  if (a.goals.length) material.push(`【已备好的结果（答应过用户的事）】\n${a.goals.map((t) => `- ${t}`).join("\n")}`);
  if (a.interests.length) material.push(`【用户关注的话题】${a.interests.join("；")}`);
  if (a.goalLine) material.push(`【进行中的目标】${a.goalLine}`);
  if (a.findings?.length) material.push(`【还没跟用户说过的发现（邮件/日历/目标等渠道攒下的）】\n${a.findings.map((t) => `- ${t}`).join("\n")}`);
  if (a.openLoops?.length) material.push(`【没聊完 / 没结果的事】\n${a.openLoops.map((t) => `- ${t}`).join("\n")}`);
  if (a.rapport?.length) material.push(`【你记得的他（闲聊时从这里找话头）】\n${a.rapport.map((t) => `- ${t}`).join("\n")}`);
  // 位置 + 活动：闲聊最自然的锚点——「我看到你在哪」比「今天降温了」具体得多
  if (a.place && a.place.kind !== "unknown") {
    const where = [
      a.place.label?.trim() ||
        (a.place.kind === "home" ? "家" : a.place.kind === "work" ? "公司" : "外面"),
      a.place.poi?.trim() || a.place.city?.trim() || "",
      typeof a.place.updatedMinutesAgo === "number"
        ? `${a.place.updatedMinutesAgo} 分钟前的位置`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    material.push(`【他此刻在哪】${where}`);
  }
  if (a.activity && a.activity !== "unknown") {
    const label = a.activity === "vehicle" ? "在车上/开车" : a.activity === "walking" ? "在走路" : "待着没动";
    material.push(`【他在动吗】${label}`);
  }
  if (a.mood) {
    const label =
      a.mood === "negative" ? "情绪偏低" : a.mood === "stressed" ? "压力大/有点累" : "状态不错";
    material.push(`【他最近的状态】${label}`);
  }
  if (a.recentTurns?.length) material.push(`【最近对话摘录（这些用户已经知道，不要重复提）】\n${a.recentTurns.map((t) => `- ${t}`).join("\n")}`);
  // 距上次对话：关系时钟的事实依据（C 类开口的唯一许可条件）
  if (a.idleMinutes === null) {
    material.push("【距上次对话】还没聊过（不要用「单纯招呼」这一类，先等用户开口）");
  } else if (typeof a.idleMinutes === "number") {
    const mins = Math.max(0, Math.round(a.idleMinutes));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    material.push(`【距上次对话】${h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`}前`);
  }
  // 固定指令在前、逐次变化的材料在后：DeepSeek 前缀缓存按请求前缀命中，
  // 这个顺序让每次评审只有材料段是 cache miss（输入成本约降一个数量级）
  return [
    "你是用户的私人助理。你每隔一段时间会有一次「想想要不要主动跟他说句话」的机会，请判断：现在值不值得发一条消息？",
    "",
    "开口有三种理由，满足任意一种就可以开口：",
    "A 有事：日程有冲突或马上要到期的安排、重要的人发来未读、答应过用户的事有了结果、用户关心的动态有了新进展。",
    "B 接话：接着最近对话或【没聊完的事】里的一件具体的事往下说一句。",
    "C 观察：从材料里挑一个你确实看见的信号——他在哪、在干什么、在动还是待着、屏幕停了多久——像朋友一样问一句或说一句。只有【距上次对话】超过 6 小时时才可以，且一天最多一次。",
    "",
    "判断标准：",
    "- C 类是好奇和搭话，不是叮嘱（「记得穿衣服」），也不是播报（「你现在在家」）：「你在外面呢？这是去哪儿」「还在公司啊」才是。没有真实观测就别硬编，改从【你记得的他】里找个具体话头。",
    "- 【他最近的状态】情绪低或压力大时，C 类收着说，别自顾自唠；宁可只说一句「今天还顺利吗」。",
    "- 只有【今日与未来 24h 安排】里的两个不同事项同一时刻才算冲突；时间照抄材料里的 HH:mm，不要取整成「六点整」，不要拿最近对话或记忆内容推断、编造冲突和事项。",
    "- 念一遍日程或未读数、没有信息增量的播报，不要开口。宁可沉默，不可打扰。",
    "- 用户关注的话题不是拿来念新闻的：挑一个角度说一句（「你之前提的那部剧更新了，评价两极」），比罗列标题有用。",
    "- 开口时机参考用户此刻状态：专注工作/离线时非必要不打断，刚回到电脑前、空闲时更适合说话；C 类在用户明显专注做事时不说。",
    "- 用户已知的事（最近对话里提过的、之前已经说过的）不要重复。",
    "- 但也不要因为「怕打扰」把自己藏起来：只要你有一件具体的事可以说，就说。",
    ...(opts?.socialPath
      ? [
          "- 这次没有新材料，你是靠「很久没说话了」拿到这次机会的：不要复述材料里已有的安排/未读，除非你能说出一个新角度（提醒他别忘了、发现时间撞了、问一句进展）。实在没有，就 NOP。",
        ]
      : []),
    "",
    "开口的硬要求：",
    "- 必须有一个具体锚点：某件事、某个时间、某个他关注的东西。禁止「在吗」「最近怎么样」「今天过得如何」这类放之四海皆准的空话——那种话对谁都成立，等于没说他。",
    "- C 类要留出口：可以是一句陈述、一个念头，用户不回也算完整，不要追着要回应。",
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
  /** 每个 actor 独立的进行中标记：一个人评审中不耽误别人 */
  private readonly inFlight = new Set<string>();
  private readonly nowFn: () => number;

  constructor(private readonly deps: AgentPulseDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    if (deps.statePath) {
      try {
        const restored = readJson<PulseState>(deps.statePath, {});
        if (restored.lastSignature) this.state.lastSignature = restored.lastSignature;
        if (restored.lastSocialReviewAt) this.state.lastSocialReviewAt = restored.lastSocialReviewAt;
        if (restored.lastSpokeAt) this.state.lastSpokeAt = restored.lastSpokeAt;
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
    console.log("[AgentPulse] 已启动（主动性聚合评审；打扰控制=agent 自律 NOP + 管道 social 仲裁）");
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
    /** 只评审指定用户（测试端点用）；缺省 = 本轮所有活跃用户 */
    actorId?: string;
  }): Promise<PulseCheckResult> {
    const enabled = isPulseEnabled() && !!this.deps.llmComplete;
    const targets = opts?.actorId ? [opts.actorId] : this.deps.actors();
    if (!enabled) {
      return { enabled: false, actorId: targets[0] ?? null, ran: false, reason: "disabled" };
    }
    if (targets.length === 0) {
      return { enabled, actorId: null, ran: false, reason: "no_actor" };
    }
    const results: PulseCheckResult[] = [];
    for (const actorId of targets) {
      results.push(await this.checkOne(actorId, enabled, opts));
    }
    // 单用户（定时路径的常见形态 / 测试端点指定）直接返回本体；多用户时
    // 返回首个真正跑过 LLM 的结果并附全量 results，便于排查。
    if (results.length === 1) return results[0]!;
    const primary = results.find((r) => r.ran) ?? results[0]!;
    return { ...primary, results };
  }

  private async checkOne(
    actorId: string,
    enabled: boolean,
    opts?: { force?: boolean; fixture?: Partial<PulseAggregate> },
  ): Promise<PulseCheckResult> {
    if (this.inFlight.has(actorId)) return { enabled, actorId, ran: false, reason: "in_flight" };
    this.inFlight.add(actorId);
    try {
      return await this.reviewOnce(actorId, opts?.force === true, opts?.fixture);
    } catch (err) {
      console.log(`[AgentPulse] 评审失败（忽略）actor=${actorId}: ${err}`);
      return { enabled, actorId, ran: false, reason: `error:${String(err).slice(0, 60)}` };
    } finally {
      this.inFlight.delete(actorId);
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
          idleMinutes: fixture.idleMinutes ?? null,
          openLoops: fixture.openLoops,
          rapport: fixture.rapport,
          place: fixture.place ?? null,
          activity: fixture.activity ?? null,
          mood: fixture.mood ?? null,
        }
      : await this.deps.aggregate(actorId);
    const hasMaterial =
      aggregate !== null &&
      (aggregate.tasks.length > 0 ||
        aggregate.unread.length > 0 ||
        aggregate.goals.length > 0 ||
        aggregate.interests.length > 0 ||
        (aggregate.findings?.length ?? 0) > 0 ||
        !!aggregate.goalLine);
    // 注：openLoops 只作「接话」的锚点素材，不计入 hasMaterial——它可能长期恒定
    // 存在（在办目标一直没结束），算进去会让「有意思的事」永远为真、关系时钟失效。
    // 关系时钟：材料没变（或压根没材料）时，也能拿到一次「想想要不要开口」的机会。
    // 这是「没事发生 = 永不开口」的结构性修复（见 docs/proactivity-initiative-redesign.md）。
    const socialDue = this.isSocialDue(actorId, now, aggregate);
    if (!aggregate || (!hasMaterial && !socialDue)) {
      if (!fixture) this.setSignature(actorId, "");
      return { enabled: true, actorId, ran: false, reason: "no_material", aggregate, fixture: !!fixture };
    }
    const signature = pulseSignature(aggregate);
    const materialChanged = this.signatureOf(actorId) !== signature;
    const base = { enabled: true, actorId, aggregate, signature, fixture: !!fixture };
    // delta 闸：材料没变不评审（省 token；不是打扰闸——材料一变就再看）。
    // force（测试端点）绕过；socialDue 也绕过（节奏改由关系时钟控制）。
    if (!fixture && !force && !materialChanged && !socialDue) {
      return { ...base, ran: false, reason: "unchanged" };
    }
    // 本次开口的理由不是「新材料」= 社交补位（招呼/接话/关心），决定语气与去重键。
    // 空材料也算社交补位。
    const socialPath = !hasMaterial || !materialChanged;
    // 无论材料评审还是社交评审，都记一次——下一次机会要等满 4h。
    if (!fixture) this.setLastSocialReviewAt(actorId, now.getTime());

    const prompt = buildPulsePrompt(now, aggregate, { socialPath });
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
              ...(aggregate.idleMinutes === undefined || aggregate.idleMinutes === null
                ? {}
                : { idleMinutes: aggregate.idleMinutes }),
              ...(socialPath ? { socialClock: true } : {}),
              context: [
                aggregate.tasks.length ? `安排：${aggregate.tasks.join("；")}` : "",
                aggregate.unread.length ? `未读：${aggregate.unread.join("、")}` : "",
                aggregate.goals.length ? `备好的结果：${aggregate.goals.join("；")}` : "",
                aggregate.findings?.length ? `相关发现：${aggregate.findings.join("；")}` : "",
                aggregate.openLoops?.length ? `没聊完的事：${aggregate.openLoops.join("；")}` : "",
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
    // 去重键：社交路径用「4h 时间桶」而不是材料指纹——空材料时指纹恒定，
    // 会让第二条社交消息被当成重复提案吞掉。桶宽 = 关系时钟间隔，正好一一对应。
    const dedupKey = socialPath
      ? `agent_pulse:social:${fixture ? "fixture_" : ""}${actorId}:${Math.floor(now.getTime() / SOCIAL_REVIEW_GAP_MS)}`
      : `agent_pulse:${fixture ? "fixture_" : ""}${signature}`;
    const decision = this.deps.submitProposal({
      proposalId: `p_${this.nowFn().toString(36)}_pulse`,
      actorId,
      kind: priceNews ? "agent_pulse_price" : "agent_pulse",
      tier: priceNews ? "must" : "social",
      importance: priceNews ? "medium" : "low",
      dedupKey,
      // 无标题（用户定稿：不再有「心跳回顾」牌子），正文即消息
      title: "",
      summary: finalText,
      directText: finalText,
      evidence: [
        "agent_pulse",
        `sig=${signature}`,
        ...(socialPath ? ["social_clock", `idle=${aggregate.idleMinutes ?? "?"}m`] : []),
        ...(fixture ? ["fixture"] : []),
        ...(priceNews ? ["price_news_must"] : []),
        "proactivity_review",
      ],
      createdAt: this.nowFn(),
      source: "initiative",
    });
    if (!fixture) this.setSignature(actorId, signature);
    if (!fixture) this.setLastSpokeAt(actorId, now.getTime());
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

  /**
   * 关系时钟：多久没跟人说话，就该有一次「想想要不要开口」的机会。
   *
   * 三个条件同时满足才放行——距上次对话 >6h、时段合适（8-22 点）、
   * 距上次评审满 4h（既省 token，也防 10min tick 连着问）。
   *
   * 注意它**不要求材料为空**：大多数用户每天都有一两条日程，材料恒定时指纹不变，
   * 旧逻辑下 agent 一天都不会开口——那正是「主动性弱」的日常形态。
   * 放行 ≠ 开口：仍由 LLM 判断，NOP 合法。
   */
  private isSocialDue(
    actorId: string,
    now: Date,
    aggregate: PulseAggregate | null,
  ): boolean {
    if (!aggregate) return false;
    if (!isSocialHour(now)) return false;
    const idle = aggregate.idleMinutes;
    if (typeof idle !== "number" || idle < SOCIAL_IDLE_MINUTES) return false;
    const last = this.state.lastSocialReviewAt?.[actorId] ?? 0;
    return now.getTime() - last >= SOCIAL_REVIEW_GAP_MS;
  }

  private setLastSocialReviewAt(actorId: string, at: number): void {
    this.state.lastSocialReviewAt = { ...this.state.lastSocialReviewAt, [actorId]: at };
    this.persist();
  }

  private setLastSpokeAt(actorId: string, at: number): void {
    this.state.lastSpokeAt = { ...this.state.lastSpokeAt, [actorId]: at };
    this.persist();
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
