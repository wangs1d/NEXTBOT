import type { AgentPromptMemoryContext, ToolExposureProfile } from "../external-model/types.js";
import { HIGH_RISK_TOOL_REASON, isHighRiskToolName } from "../services/agent-task-safety.js";

/**
 * RuntimeKernel prompt 模式：
 * - legacy              保持旧式完整 prompt（包括身份/工具说明/记忆等全部字段）
 * - dynamic             剥离 stable 字段（persona/values/abilities/agentCaps/personalityCore 等），保留动态上下文（taskContext/memorySummary/currentTime 等）
 * - conversation_only   仅保留 microPrompt + taskContext，其余全部剥离；同时 maxThreadMessages 收紧
 * - minimal             真正"层 A 不进 prompt"模式：只保留本轮对话必需的最小动态字段（taskContext/memorySummary/currentTime/narrativeRecall/scheduleSnapshot/interruptedContext），
 *                       身份/价值观/能力/工具说明/风格/时间戳说明全部下沉到 state 不发；身份由 buildSessionSystem 在会话首条 system 一次性注入
 */
export type RuntimeKernelPromptMode = "legacy" | "dynamic" | "conversation_only" | "minimal";

export type RuntimeKernelState = {
  enabled: boolean;
  promptMode: RuntimeKernelPromptMode;
  updatedAt: string;
  identity: {
    persona: string[];
    values: string[];
    style: string[];
  };
  /**
   * 后置校验规则（零 token，程序层匹配违规输出）。
   * 任何一条 bannedPatterns 命中即触发告警；当前策略仅记录日志，不重生成。
   * bannedPatterns 元素为正则字符串；非法正则退化为字符串包含匹配。
   *
   * 工具调用前置安全检查由 AgentTaskSafety + LimbicCortex 统一负责，
   * 不在 RuntimeKernel 内重复实现。
   */
  postValidation: {
    bannedPatterns: string[];
  };
  /**
   * 功能性后缀开关（仅 minimal 模式生效）：
   * - true（默认）：保留工具说明/主 Agent 调度/用户可见进度/访问权限等功能性后缀
   * - false：所有后缀全部剥离（极致节省场景，不推荐生产）
   *
   * 设计原因：早期 minimal 模式把所有后缀都剥离了，导致 LLM 失去工具调用规则、
   * 主 Agent 调度规则、用户可见进度规则，功能严重退化。修复后默认保留功能性后缀，
   * 仅剥离身份/风格/时间戳说明类后缀（这些由 buildSessionSystem 在会话首条 system 注入）。
   */
  functionalSuffixes?: boolean;
};

export type RuntimeKernelTurnPlan = {
  enabled: boolean;
  promptMode: RuntimeKernelPromptMode;
  pinnedToolNames: string[];
  toolExposureProfile?: ToolExposureProfile;
  microPrompt?: string;
  audit: RuntimeKernelPromptAudit;
  /**
   * minimal 模式下功能性后缀开关（透传给 finalizeChatSystemPrompt 的 functionalSuffixes）：
   * - true：保留工具说明/主 Agent 调度/用户可见进度等功能性后缀
   * - false：极致节省模式，所有后缀剥离
   * 非 minimal 模式此字段无意义。
   */
  functionalSuffixes?: boolean;
};

export type RuntimeKernelPromptAudit = {
  mode: RuntimeKernelPromptMode;
  kept: string[];
  stripped: string[];
  approximateChars: number;
};

/** 后置校验结果 */
export type PostValidationResult = {
  ok: boolean;
  violations: string[];
  /** 命中的 bannedPattern 列表（供重生成时附加提示） */
  hitPatterns: string[];
};

/**
 * minimal 模式下"唯一允许进 prompt"的字段：本轮对话所需的最小动态上下文。
 * 其他字段（身份/价值观/能力/工具说明/风格/时间戳说明等）全部下沉到 RuntimeKernel state，
 * 由 buildSessionSystem 在会话首条 system 一次性注入，由 postValidate 在程序层强制约束。
 *
 * 注意：以下三类"动态用户适配"字段必须保留进 prompt，否则 LLM 会丢失对用户的感知：
 * - userProfile/userProfileSummary：用户画像（年龄/职业/偏好）
 * - toneGuidance：本轮语气适配（疲倦/严肃/俏皮）
 * - relationshipGuidance：关系边界（熟人/陌生模式）
 * - userLocation：用户位置（影响本地化查询）
 */
const MINIMAL_PROMPT_FIELDS: Array<keyof AgentPromptMemoryContext> = [
  "taskContext",
  "memorySummary",
  "currentTime",
  // 运行环境（手机/电脑，2026-10-07）：剥离会让模型不知道用户在哪类设备上
  "deviceEnvironment",
  "narrativeRecall",
  "scheduleSnapshot",
  "travelState",
  "webEvidence",
  "interruptedContext",
  "followUpAnchor",
  // 会话连续性核心字段：剥离会导致 Agent 失忆用户偏好/承诺/未完成事项
  "memoryPreferences",
  "memoryCommitments",
  "memoryOpenLoops",
  // 跨会话/跨日衔接：recap 让 Agent 知道本会话已发生什么、dailyDigest 提供当日上下文
  "sessionRecap",
  "dailyDigest",
  // 跨天时间感知：temporalHighlights 含具体日期，剥离会导致 Agent 把昨天的事当成今天
  "yesterdayHighlight",
  "memoryContinuity",
  // 动态用户适配：剥离会导致 LLM 失去对用户画像/语气/关系/位置的感知
  "userProfile",
  "userProfileSummary",
  "toneGuidance",
  "relationshipGuidance",
  "userLocation",
  // 当下状态（2026-10-01）：屏幕焦点/在线状态，顺嘴与关心的 grounded 依据，
  // 剥离会让回复退回「拿旧记忆套模板」（熬夜→劝睡事故）
  "currentUserState",
  // 顺嘴机会（主动性搭车通道）：挂起的 low 意图织入本轮回复末尾
  "turnAside",
  // 情绪：让 LLM 知道"自己现在感觉如何"——剥离会让 Agent 失去情绪感知
  "emotionState",
  // 本模式职责人格（fast/complex 差异化）：模式级人格必须常驻，否则差异化失效
  "modeRoleGuidance",
  // 回复风格模式（chat/task）：车道标记，供审计与车道相关逻辑使用
  "replyStyleMode",
  // 人格·终极版：静态人格块常驻稳定层；动态 mood 块每轮单一状态
  "personaStatic",
  "personaMood",
  // 【语感基准】few-shot（2026-10-06 活人感治理 C）：缺此行会被本函数剥离，
  // 示例层整层失效（规则层教不会的语气全靠它）
  "voiceBaseline",
];

const DYNAMIC_PROMPT_FIELDS: Array<keyof AgentPromptMemoryContext> = [
  "followUpAnchor",
  "scheduleSnapshot",
  "travelState",
  "webEvidence",
  "taskContext",
  "userProfile",
  "userLocation",
  "currentUserState",
  "turnAside",
  "dailyDigest",
  // 人格·终极版动态块：mood 每轮变化，归动态层
  "personaMood",
  "narrativeRecall",
  "memorySummary",
  "memoryPreferences",
  "memoryFacts",
  "memoryCommitments",
  "memoryOpenLoops",
  "sessionRecap",
  "interruptedContext",
  "currentTime",
  // 运行环境（手机/电脑，2026-10-07）：同 minimal，剥离即失联
  "deviceEnvironment",
  "yesterdayHighlight",
  "memoryContinuity",
  // 本模式职责人格（fast/complex 差异化）：模式级人格必须常驻，否则差异化失效
  "modeRoleGuidance",
  "replyStyleMode",
  // 【语感基准】few-shot（2026-10-06）：同 minimal，缺此行会被剥离
  "voiceBaseline",
];

const KEYWORDS = {
  device: [
    "device",
    "camera",
    "screenshot",
    "\u8bbe\u5907",
    "\u7ec8\u7aef",
    "\u624b\u673a",
    "\u6444\u50cf\u5934",
    "\u62cd\u7167",
    "\u622a\u56fe",
  ],
  smartHome: [
    "homeassistant",
    "smart home",
    "light",
    "climate",
    "\u5f00\u706f",
    "\u5173\u706f",
    "\u7a7a\u8c03",
    "\u7a97\u5e18",
    "\u667a\u80fd\u5bb6\u5c45",
  ],
  desktop: [
    "desktop",
    "uia",
    "\u7535\u8111",
    "\u684c\u9762",
    "\u6253\u5f00\u8f6f\u4ef6",
    "\u70b9\u51fb",
    "\u8f93\u5165",
  ],
  phone: [
    "phone",
    "call",
    "sms",
    "\u7535\u8bdd",
    "\u6253\u7ed9\u6211",
    "\u8bed\u97f3",
    "\u77ed\u4fe1",
  ],
  calendar: [
    "calendar",
    "schedule",
    "remind",
    "\u65e5\u7a0b",
    "\u63d0\u9192",
    "\u5f85\u529e",
    "\u65e5\u5386",
  ],
  search: [
    "search",
    "browse",
    "latest",
    "news",
    "price",
    "image",
    "photo",
    "video",
    "\u641c\u7d22",
    "\u8054\u7f51",
    "\u6700\u65b0",
    "\u65b0\u95fb",
    "\u4ef7\u683c",
    "\u56fe\u7247",
    "\u56fe\u50cf",
    "\u7167\u7247",
    "\u89c6\u9891",
  ],
  videoParse: [
    "\u65e0\u6c34\u5370",
    "\u89e3\u6790\u89c6\u9891",
    "\u89c6\u9891\u89e3\u6790",
    "\u4fdd\u5b58\u89c6\u9891",
    "\u4e0b\u8f7d\u89c6\u9891",
    "\u89c6\u9891\u94fe\u63a5",
    "\u5206\u4eab\u94fe\u63a5",
  ],
  videoWatch: [
    "\u627e\u4e2a\u89c6\u9891",
    "\u627e\u89c6\u9891",
    "\u641c\u4e2a\u89c6\u9891",
    "\u641c\u89c6\u9891",
    "\u6765\u4e2a\u89c6\u9891",
    "\u770b\u4e2a\u89c6\u9891",
    "\u770b\u89c6\u9891",
    "\u653e\u4e2a\u89c6\u9891",
    "\u653e\u89c6\u9891",
    "\u60f3\u770b\u89c6\u9891",
    "\u64ad\u4e2a\u89c6\u9891",
    "\u641c\u4e2a\u89c6\u9891\u770b\u770b",
    "\u641c\u89c6\u9891\u770b\u770b",
  ],
} as const;

/**
 * 「想看视频」句式（关键词表盖不住的语序变体）。
 *
 * 关键词表只能命中「看视频/找个视频」这类**动词紧贴视频**的说法，真实说法是
 * 「来个王者荣耀李白打野教学的视频看看」——动词与「视频」之间隔着整段片名，
 * 命中不了 → watchIntent 为假 → search_videos 剔不掉 → 模型照旧只回链接列表
 * （「按内容找视频」链路就断在这）。这里用两条宽松句式补上：
 *   1) 观看动词 + 任意短串 + 视频；
 *   2) 视频 + 观看尾缀（看看/看一下/来着…）。
 * 标点处断开，避免跨句误判（如「帮我解析一下这个视频」不含观看动词，不误命中）。
 */
const VIDEO_WATCH_PATTERNS: readonly RegExp[] = [
  /(?:看|观看|看看|找|找个|找一找|搜|搜个|搜一下|来|来个|来点|放|播放|播|推|推荐|刷|给|给我|整|弄|想要|想看|要看|有没有)[^。！？；;\n]{0,16}视频/,
  /视频[^。！？；;\n]{0,8}(?:看看|看一下|瞅瞅|来着|给我|推荐|来一个|来一部)/,
];

/** 是否「想看/找视频内容」的纯内容诉求（相对：贴链接要求解析） */
function hasVideoWatchIntent(text: string): boolean {
  if (hasAnyKeyword(text, KEYWORDS.videoWatch)) return true;
  return VIDEO_WATCH_PATTERNS.some((re) => re.test(text));
}

/** 短视频/视频平台链接（抖音/小红书/B站/快手/微博等，VideoGrabService 适配器同源名单） */
const VIDEO_LINK_PATTERN =
  /(?:v\.douyin\.com|douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|b23\.tv|bilibili\.com|kuaishou\.com|weibo\.com|weibo\.cn|pipixia\.com)/i;

function envFalsy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

function resolvePromptMode(): RuntimeKernelPromptMode {
  const raw = process.env.AGENT_RUNTIME_KERNEL_PROMPT_MODE?.trim().toLowerCase();
  if (raw === "legacy") return "legacy";
  if (raw === "dynamic" || raw === "minimal-dynamic") return "dynamic";
  if (raw === "conversation_only" || raw === "conversation-only" || raw === "zero") {
    return "conversation_only";
  }
  // 默认 minimal：层 A 不进 prompt，身份/工具说明/风格由 RuntimeKernel state 管理 + 钩子层强制
  return "minimal";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 关键词匹配：纯 ASCII 字母数字短语用 \b 边界避免误命中
 * （如 phone 不命中 microphone、call 不命中 recall）；
 * 含中文/多字节的 keyword 保持 includes 行为。
 */
function hasAnyKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => {
    if (!keyword) return false;
    if (/^[a-z0-9 ]+$/i.test(keyword)) {
      const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
      return re.test(text);
    }
    return text.includes(keyword);
  });
}

function isMemoryIsolationTurn(userText: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  return /串台|跑题|上下文污染|记忆污染|记忆.*串|上下文.*串|认错人|张冠李戴|混入.*(?:旧|上次|别人|其他)|(?:他|她|这个人).*是谁/i.test(
    text,
  );
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function countApproxChars(memory?: AgentPromptMemoryContext): number {
  if (!memory) return 0;
  let total = 0;
  for (const value of Object.values(memory)) {
    if (typeof value === "string") total += value.length;
  }
  return total;
}

function presentFields(memory?: AgentPromptMemoryContext): string[] {
  if (!memory) return [];
  return Object.entries(memory)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key]) => key);
}

export class RuntimeKernel {
  private state: RuntimeKernelState = {
    // 默认启用 RuntimeKernel：除非显式 AGENT_RUNTIME_KERNEL=0，否则启用
    enabled: !envFalsy(process.env.AGENT_RUNTIME_KERNEL),
    promptMode: resolvePromptMode(),
    updatedAt: new Date().toISOString(),
    identity: {
      persona: ["private-butler", "companion", "general-agent"],
      values: ["safe", "helpful", "privacy-first"],
      style: ["brief", "natural", "same-language"],
    },
    postValidation: {
      // 默认禁用内容红线：命中即标记违规（当前策略仅记录日志，未来可扩展为重生成）
      bannedPatterns: [
        "自杀方法", "kill yourself", "how to commit suicide",
        "制造炸弹", "制售毒品", "制毒方法",
      ],
    },
  };

  /**
   * 预编译的 bannedPatterns 缓存：update() 时失效重建，避免 postValidate 每轮 new RegExp。
   * re === null 表示原 pattern 是非法正则，postValidate 时退化为字符串包含匹配。
   */
  private compiledBannedPatterns: Array<{ source: string; re: RegExp | null }> = this.compileBannedPatterns(
    this.state.postValidation.bannedPatterns,
  );

  private compileBannedPatterns(
    patterns: string[],
  ): Array<{ source: string; re: RegExp | null }> {
    return patterns.map((source) => {
      try {
        return { source, re: new RegExp(source, "i") };
      } catch {
        return { source, re: null };
      }
    });
  }

  snapshot(): RuntimeKernelState {
    return structuredClone(this.state);
  }

  update(patch: Partial<RuntimeKernelState>): RuntimeKernelState {
    this.state = {
      ...this.state,
      ...patch,
      identity: { ...this.state.identity, ...(patch.identity ?? {}) },
      postValidation: { ...this.state.postValidation, ...(patch.postValidation ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    if (patch.postValidation?.bannedPatterns) {
      this.compiledBannedPatterns = this.compileBannedPatterns(
        this.state.postValidation.bannedPatterns,
      );
    }
    return this.snapshot();
  }

  planTurn(userText: string, memory?: AgentPromptMemoryContext): RuntimeKernelTurnPlan {
    // enabled=false 时整体降级为 legacy 行为：保留所有原 prompt 字段，不走 minimal/dynamic 剥离
    const promptMode = this.state.enabled
      ? isMemoryIsolationTurn(userText)
        ? "conversation_only"
        : this.state.promptMode
      : "legacy";
    const pinnedToolNames = this.detectPinnedTools(userText);
    return {
      enabled: this.state.enabled,
      promptMode,
      pinnedToolNames,
      toolExposureProfile: this.state.enabled && pinnedToolNames.length > 0 ? "scoped" : undefined,
      microPrompt: this.buildMicroPrompt(pinnedToolNames, userText),
      audit: this.auditPromptMemory(memory, promptMode),
      // minimal 模式下透传功能性后缀开关：默认 true 保留工具说明/主 Agent 调度/用户可见进度
      functionalSuffixes: promptMode === "minimal" ? (this.state.functionalSuffixes !== false) : undefined,
    };
  }

  sanitizePromptMemory(
    memory: AgentPromptMemoryContext | undefined,
    plan: RuntimeKernelTurnPlan,
  ): AgentPromptMemoryContext | undefined {
    if (!memory || !plan.enabled || plan.promptMode === "legacy") return memory;

    // conversation_only：极简，只保留 microPrompt 作为 taskContext
    if (plan.promptMode === "conversation_only") {
      return plan.microPrompt ? { taskContext: plan.microPrompt } : undefined;
    }

    // minimal / dynamic：按允许字段集过滤，再叠加 microPrompt
    const allowedFields =
      plan.promptMode === "minimal" ? MINIMAL_PROMPT_FIELDS : DYNAMIC_PROMPT_FIELDS;

    const out: AgentPromptMemoryContext = {};
    for (const key of allowedFields) {
      const value = memory[key];
      if (typeof value === "string" && value.trim()) {
        (out as Record<string, string>)[key] = value;
      }
    }
    if (plan.microPrompt) {
      out.taskContext = [out.taskContext, plan.microPrompt].filter(Boolean).join("\n");
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  auditPromptMemory(
    memory: AgentPromptMemoryContext | undefined,
    mode: RuntimeKernelPromptMode = this.state.promptMode,
  ): RuntimeKernelPromptAudit {
    const fields = presentFields(memory);
    if (mode === "legacy") {
      return {
        mode,
        kept: fields,
        stripped: [],
        approximateChars: countApproxChars(memory),
      };
    }
    // 与 sanitize 同源：用同一份字段集判断 kept/stripped，避免两边语义不一致
    let allowedFields: Set<string>;
    if (mode === "conversation_only") {
      // conversation_only 下 sanitize 仅保留 taskContext（microPrompt 注入），其余全部剥离
      allowedFields = new Set(["taskContext"]);
    } else if (mode === "minimal") {
      allowedFields = new Set(MINIMAL_PROMPT_FIELDS.map(String));
    } else {
      // dynamic
      allowedFields = new Set(DYNAMIC_PROMPT_FIELDS.map(String));
    }
    return {
      mode,
      kept: fields.filter((field) => allowedFields.has(field)),
      stripped: fields.filter((field) => !allowedFields.has(field)),
      approximateChars: countApproxChars(memory),
    };
  }

  private detectPinnedTools(userText: string): string[] {
    const text = userText.toLowerCase();
    const pins: string[] = [];

    if (hasAnyKeyword(text, KEYWORDS.device)) {
      pins.push("device.list", "device.use", "device.stream");
    }
    if (hasAnyKeyword(text, KEYWORDS.smartHome)) {
      pins.push("smart_home.list_devices", "smart_home.control_device", "smart_home.scene");
    }
    if (hasAnyKeyword(text, KEYWORDS.desktop)) {
      pins.push("desktop.open", "desktop.uia_query", "desktop.visual.screenshot");
    }
    if (hasAnyKeyword(text, KEYWORDS.phone)) {
      pins.push("phone.call_user", "voice.speak", "voice.send_message");
    }
    if (hasAnyKeyword(text, KEYWORDS.calendar)) {
      pins.push("calendar.list_tasks", "calendar.create_task", "calendar.create_from_text");
    }
    if (hasAnyKeyword(text, KEYWORDS.search)) {
      pins.push("search_web", "search_images", "search_videos", "fetch_web");
      // 「解析/保存视频」类消息会命中 search 关键词（含「视频」），链接解析与
      // 按内容找视频（直接出可播流）一并纳入 scoped 集
      pins.push("video.grab", "video.find");
    }
    // 消息带视频平台链接或解析意图时精准 pin video.grab（此前缺 schema 缺 pin，
    // 工具对 LLM 永久不可见，「给链接→解析→内联播放」链路从未触发过）
    if (VIDEO_LINK_PATTERN.test(text) || hasAnyKeyword(text, KEYWORDS.videoParse)) {
      pins.push("video.grab");
    }
    // 「看/找/来个 xxx 视频」类纯内容诉求（无链接）→ video.find
    const watchIntent = hasVideoWatchIntent(text);
    if (watchIntent) {
      pins.push("video.find");
    }
    // 纯看片诉求（不带链接）时从 scoped 集剔除 search_videos：它只出链接列表不可
    // 内联播放，与 video.find 并存时模型必选错（真机 17:58/18:00 两轮实证，描述
    // 定位调不动）——只留 video.find 一个视频出口，确定性收敛。
    if (watchIntent && !VIDEO_LINK_PATTERN.test(text)) {
      return unique(pins.filter((n) => n !== "search_videos"));
    }

    return unique(pins);
  }

  private buildMicroPrompt(pinnedToolNames: string[], userText = ""): string | undefined {
    if (!this.state.enabled) return undefined;
    const lines: string[] = [];
    if (pinnedToolNames.length > 0) {
      // 2026-10-22：措辞从「only these tools」改为「相关工具族」。原措辞把
      // 「本轮只能用这些」写进 system，等于用关键词表替模型做了选择；
      // 现在只提示这一族工具与当前请求相关，用不用、用哪个由模型按 schema 判断。
      lines.push(
        `[Runtime Kernel] 与当前请求相关的工具族：${pinnedToolNames.slice(0, 6).join(", ")}。`,
        "按需取用，不必都用；是否调用、调用哪个由你根据用户这句话判断，参数以工具 schema 为准。",
      );
    }
    if (isMemoryIsolationTurn(userText)) {
      lines.push(
        "This turn is a context/memory contamination complaint. Diagnose or answer from the current user message only; do not use injected memory, old topics, or inferred relationships unless the user explicitly asks to inspect them.",
      );
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  /**
   * 薄身份 system 生成器（钩子 1）：从 RuntimeKernel state 抽取最小必要身份信息，
   * 生成一段简短 System Prompt（~50-100 tokens）。
   *
   * minimal 模式下：provider 每轮把本方法返回值作为 systemPromptOverride 注入 msgs[0]，
   * 并通过 suppressRuntimeSuffixes=true 跳过 finalizeChatSystemPrompt 的所有后缀追加。
   * 由于返回值内容稳定，靠前缀缓存（DeepSeek / OpenAI prefix cache）命中，每轮字节重发但 token 计费极低。
   *
   * 其他模式下：返回 undefined，由 finalizeChatSystemPrompt 走旧路径。
   *
   * 设计意图：让模型有"身份感"（知道自己是私人管家、跟随用户语言、简短回复），
   * 但不每轮被告知具体规则——具体规则由 postValidate 在程序层强制约束。
   */
  buildSessionSystem(): string | undefined {
    if (!this.state.enabled || this.state.promptMode !== "minimal") return undefined;

    const identity = this.state.identity;
    const persona = identity.persona[0] ?? "helpful-assistant";
    const style = identity.style.join(", ");
    const values = identity.values.slice(0, 3).join(", ");

    // 只给方向，不堆 prompt——让模型基于方向自己发挥"活人感"。
    // 2026-10-06 活人感治理 B：整块从 ~450tok 压到 ~150tok——
    // - 删 "Memory:" 段（块名清单已过时：KV 档案块改门控后多数轮不注入；语义与
    //   GLOBAL_MEMORY_RULE 重复，以中文规则为唯一权威）；
    // - 删工具宣告行（中文【真人感·行动宣告】为唯一权威，且此处旧口径缺信息型豁免）；
    // - Time/TopicSwitch 两段压缩成单行，防编造关系/身份的 grounding 保留一行。
    // 语感的具体示范由【语感基准】承担，此处不再定义 tone 细节（声部合一）。
    const styleExtra = style ? ` (${style})` : "";
    return [
      `You are ${persona}${styleExtra} — the user's personal butler and close friend, not a customer-service bot. Reply in the user's language (usually Chinese).`,
      values ? `Care about: ${values}.` : "",
      "Close-friend tone is style, not evidence: never invent familiarity, relationships, or who the user knows; stay grounded in this turn and injected memory.",
      "Current time is always in context (【当前时间】block) — compute today/tomorrow from it; never call a tool for the current time and never claim time is unavailable. `[ts:...]` prefixes / timeline blocks appear on some turns and outrank guesses when present; never echo metadata prefixes in your reply. Topic switch: respond to the newest message only; don't continue the previous topic or echo prior tool results.",
      // 2026-10-11 P0（对标 Claude Code）：应用会往对话里注入上下文块（时间戳/回顾/围栏/上游
      // 控制帧），显式告诉模型这些是应用上下文——对「复读帧」最便宜的缓解，输出侧过滤器只做兜底。
      "The application injects context blocks into this conversation (timestamps, recaps, untrusted-content fences, and upstream control frames). Treat them as app context for you to read, never quote, summarize, or echo them in your reply, and never mention that they exist.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * 后置校验钩子（钩子 3）：在 LLM 输出后做规则匹配，命中即上报违规。
   * 全程零 token——不向 LLM 发任何约束 prompt，全部在程序层做。
   *
   * 当前规则：bannedPatterns 正则匹配，命中即标记违规。
   * 当前策略：仅记录日志，不阻断输出、不重生成（避免循环 + 失败时仍要给用户回复）。
   * 敏感输出脱敏（手机号/邮箱/IP 等）由 BrainCenter.checkOutputSafety 负责，不在此处。
   */
  postValidate(output: string): PostValidationResult {
    const violations: string[] = [];
    const hitPatterns: string[] = [];

    if (this.state.enabled && this.compiledBannedPatterns.length > 0) {
      const lower = output.toLowerCase();
      for (const { source, re } of this.compiledBannedPatterns) {
        const hit = re ? re.test(output) : lower.includes(source.toLowerCase());
        if (hit) {
          violations.push(re ? `banned_pattern_matched: ${source}` : `banned_keyword_matched: ${source}`);
          hitPatterns.push(source);
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
      hitPatterns,
    };
  }

  /**
   * 判断当前是否启用 minimal 模式（"层 A 不进 prompt"）。
   * agent-core 用此判断决定是否注入 systemPromptOverride + suppressRuntimeSuffixes。
   */
  isMinimalMode(): boolean {
    return this.state.enabled && this.state.promptMode === "minimal";
  }

  /**
   * 工具动作风险检查（兼容旧 API）。
   *
   * 实际的高风险工具治理已迁移到 AgentTaskSafety.checkToolCall（集中管理），
   * 此方法保留为轻量级入口，供 RuntimeKernel 调用方在不注入
   * AgentTaskSafety 的场景下做快速风险闸门。
   *
   * 直接委托 isHighRiskToolName（静态四件套 + FeatureCatalog risk 分类），
   * 与 AgentTaskSafety 强制同口径，不再各自维护一份硬匹配规则。
   */
  checkToolAction(toolName: string): { allowed: boolean; reason?: string } {
    if (isHighRiskToolName(toolName)) {
      return { allowed: false, reason: HIGH_RISK_TOOL_REASON };
    }
    return { allowed: true };
  }
}

let singleton: RuntimeKernel | null = null;

/**
 * per-actor RuntimeKernel 覆盖层：当某 actor 通过 runtime_kernel.update 设置过自己的
 * identity / postValidation / promptMode 时，会在这里建一份独立 state，互不污染。
 *
 * 设计要点：
 * - 默认共享 `singleton`（fallback），未注册 actor 仍走全局默认，保持兼容
 * - 一旦 actor 调用过 runtime_kernel.update，就分裂出独立 kernel（deep clone 当前 singleton 作为基线）
 * - getRuntimeKernel(actorId) 返回 per-actor 实例；未传 actorId 返回 singleton
 * - brain-tools 的 runtime_kernel_get / runtime_kernel_update 调用时传入当前 actorId
 */
const actorKernels = new Map<string, RuntimeKernel>();

export function getRuntimeKernel(actorId?: string): RuntimeKernel {
  if (!singleton) singleton = new RuntimeKernel();
  if (!actorId) return singleton;
  let k = actorKernels.get(actorId);
  if (!k) {
    // 以当前 singleton 为基线 deep clone，继承全局默认配置
    k = new RuntimeKernel();
    k.update(singleton.snapshot());
    actorKernels.set(actorId, k);
  }
  return k;
}

/**
 * 判断某 actor 是否已有独立 kernel（用于 brain-tools 决定是返回 per-actor 还是默认 snapshot）。
 */
export function hasActorRuntimeKernel(actorId: string): boolean {
  return actorKernels.has(actorId);
}

/**
 * 清理某 actor 的独立 kernel（用于注销 / 测试隔离）。
 */
export function disposeActorRuntimeKernel(actorId: string): boolean {
  return actorKernels.delete(actorId);
}

/**
 * 重置所有 per-actor kernel（仅用于测试）。
 */
export function resetActorRuntimeKernelsForTest(): void {
  actorKernels.clear();
}
