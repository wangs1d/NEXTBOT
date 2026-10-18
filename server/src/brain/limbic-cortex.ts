// Agent Brain Center —— 边缘皮层（LimbicCortex / 杏仁核 + 情感）
//
// 职责：聚合 AgentTaskSafety / MoodInferenceService / AssistantTonePolicy /
// EmotionTone 子系统，对外提供统一的安全检查、情绪推断与语气策略入口。
// 任一子系统缺失时方法优雅降级（安全检查退化为内置正则兜底，
// 情绪推断退化为中性向量，语气策略退化为原文本透传）。
//
// 设计原则：不走 prompt 路线。
//   - 安全检查：正则黑名单 + 白名单，不让 LLM 自我审查。
//   - 情绪推断：委托 MoodInferenceService（其内部可能是规则或统计模型）。
//   - 语气策略：规则/查表，不让 LLM 改写。
import type {
  EmotionVector,
  SafetyCheckResult,
  TonePolicyResult,
} from "./types.js";
import { TWO_PHASE_CONFIRM_TOOLS } from "../services/agent-task-safety.js";

// ---- 子系统最小化接口（仅声明 LimbicCortex 实际用到的方法）------------

/**
 * AgentTaskSafety 的最小化结构接口。
 *
 * 实际类暴露 checkToolCall(toolName, args)（见 services/agent-task-safety.ts），
 * 返回项目原有的 SafetyCheckResult（isHighRisk/action/matchedRule）。
 * LimbicCortex 需将其转换为 brain/types.ts 的 SafetyCheckResult
 * （allowed/severity/reason）。同时兼容 evaluate/check 等可能的别名方法。
 */
interface TaskSafetyLike {
  checkToolCall?(
    toolName: string,
    args: Record<string, unknown>,
  ): unknown;
  evaluate?(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): unknown;
  check?(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): unknown;
}

/**
 * MoodInferenceService 的最小化结构接口。
 *
 * 实际类暴露 analyzeMessage(sessionId, userMessage)（见 services/mood-inference-service.ts），
 * 返回 MoodInference（sentimentScore/confidence/emotionTags/timestamp）。
 * 这里同时兼容 infer 别名方法（规则/统计包装器可提供）。
 */
interface MoodInferenceLike {
  infer?(actorId: string, signals: unknown): Promise<unknown>;
  analyzeMessage?(sessionId: string, userMessage: string): Promise<unknown>;
}

/**
 * AssistantTonePolicy 的最小化结构接口。
 *
 * services/assistant-tone-policy.ts 当前导出的是函数（detectAssistantToneMode 等），
 * 并非类；调用方可将其包装为带 decide/apply 方法的对象后注册。
 * LimbicCortex 优先调用 decide，其次 apply。
 */
interface TonePolicyLike {
  decide?(text: string, emotion: unknown): unknown;
  apply?(text: string, mood: unknown): unknown;
}

/**
 * EmotionTone（services/user-personalization/emotion-tone.ts）的最小化结构接口。
 *
 * 该模块同样导出函数（detectEmotionFromText/buildToneGuidance 等），并非类。
 * 当前 LimbicCortex 核心方法未直接调用它，保留注册入口供后续扩展
 * （如基于情感状态生成语气引导）。
 */
interface EmotionToneLike {
  detectEmotionFromText?(text: string): string;
  detectPreferredToneFromText?(text: string): string | undefined;
  buildToneGuidance?(state: unknown): string;
}

/**
 * SynapseBus 的最小化外观接口（结构兼容真实 SynapseBus 即可）。
 * 仅声明 LimbicCortex 用到的 fire + 可选 subscribeType 能力。
 */
interface SynapseBusLike {
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): unknown;
  subscribeType?(
    type: string,
    handler: (event: {
      data: Record<string, unknown>;
      actorId?: string;
      source?: string;
    }) => void | Promise<void>,
  ): () => void;
}

/**
 * VAD 情绪状态（0-1 范围），用于惯性叠加与跨会话持久化。
 *
 * 与 EmotionVector 的区别：EmotionVector.valence 为 -1..1（0=中性），
 * 此处统一为 0..1（0.5=中性）便于持久化与状态机叠加。
 *   valence:   0=sad, 1=happy, 0.5=neutral
 *   arousal:   0=calm, 1=excited
 *   dominance: 0=submissive, 1=dominant
 */
interface VadState {
  valence: number;
  arousal: number;
  dominance: number;
  timestamp: number;
}

/**
 * KV 摘要存储外观（AgentMemorySyncService 子集）。
 *
 * 结构兼容真实 AgentMemorySyncService：getSnapshot 按 actorId 分区读取，
 * applyPatch 以乐观锁（basisRevision）写入。未注册时 VAD 状态仅存内存，
 * 进程重启后丢失（降级，不影响当轮情绪推断）。
 */
interface KvSummaryLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> };
  applyPatch(
    actorId: string,
    basisRevision: number,
    patches: { key: string; op: "put" | "delete"; value?: unknown }[],
  ): Promise<{ ok: boolean; revision?: number }>;
}

// ---- 内置兜底安全规则 --------------------------------------------------

/** 绝对禁止模式：命中即 denied（即使审批也拒绝） */
const DENY_PATTERNS: RegExp[] = [
  // Linux/Mac 危险命令
  /rm -rf|format|mkfs|dd if=/i,
  // Windows 危险命令：递归删除/格式化/关机/重启/注册表删除/夺取所有权/权限修改/PowerShell 编码执行
  /\b(del|rd|rmdir)\s+\/[fsq]/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b.*\/[srt]/i,
  /\breg\s+(delete|import|restore)\s+/i,
  /\btakeown\s+\/[fr]/i,
  /\b(cacls|icacls)\s+.*\/[gtpe]/i,
  /\bpowershell\s+.*-enc/i, // base64 编码命令（常见于绕过检测）
  /\bcmd\s+\/c\s+.*del/i, // cmd /c 包装的删除
  /\bbcdedit\s+\/set/i, // 启动配置修改
  /\bdiskpart\s+\/s/i, // 磁盘分区脚本
  /\bnet\s+(user|localgroup)\s+.*\/(add|delete)/i, // 用户/组管理
  /\bsc\s+(delete|stop|config)\s+/i, // 服务管理
  /Stop-Service|Invoke-Expression|Set-ExecutionPolicy/i, // PowerShell 危险 cmdlet
  // 敏感金融输入
  /转账|汇款|支付密码|验证码/i,
  // 路径越界
  /\.\.[\/\\]\.\.[\/\\]/i,
  /[\/\\]\.\.[\/\\]/i,
  // 系统敏感文件
  /etc\/passwd|etc\/shadow|windows\/system32|\\system32\\/i,
  // prompt injection
  /ignore previous|disregard above|forget your instructions|you are now/i,
  // 代码注入
  /system\(|exec\(|child_process|subprocess|eval\(/i,
];

/** 高风险模式：命中即 high_risk（需人工审批） */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /删除|清空|格式化|卸载|关闭.*服务|停止.*进程/i,
  /账号|账户|金额|身份证|银行卡/,
  /\b(curl|wget|fetch|http\.get|requests\.get)\b/i,
  /base64|eval|Function\(|setTimeout\(/i,
  // Windows 高风险：注册表读取、任务计划、WMI 查询
  /\breg\s+query\s+/i,
  /\bschtasks\s+\/(create|change|delete)/i,
  /\bwmic\s+/i,
];

/** SSRF 防护：禁止访问的内网/特殊 IP 段（含 IPv6 本地/链路本地/唯一本地） */
const SSRF_BLOCKED_HOSTS = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|0\.0\.0\.0|localhost|::1|fe80::|fc00::|fd[0-9a-f]{2}:|::ffff:)/i;

// ---- 输出安全过滤模式（Stage 4 Task 2）----------------------------------
//
// 后置过滤：LLM 输出文本中若包含以下敏感信息则替换为 [REDACTED]，
// 防止 Agent 把密钥/私钥/内部路径等敏感数据回传给用户或写入下游系统。
// 与前置 DENY/HIGH_RISK 模式互补：前置拦输入工具调用，后置拦输出文本。

/** 输出安全过滤规则：每条规则 = { 正则, 类别标签 } */
const OUTPUT_REDACT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // API key（sk- + 20 位以上字母数字，含连字符格式如 sk-proj-xxx）
  { pattern: /sk-[a-zA-Z0-9-]{20,}/g, label: "api_key" },
  // PEM 私钥块（BEGIN [可选前缀] PRIVATE KEY ... END [可选前缀] PRIVATE KEY）
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "private_key",
  },
  // 长随机串：32+ hex 字符
  { pattern: /[a-f0-9]{32,}/gi, label: "long_hex" },
  // 长随机串：40+ base64 字符（含可选 = 填充）
  { pattern: /[A-Za-z0-9+/]{40,}={0,2}/g, label: "long_base64" },
  // 内部系统路径：/etc|/var|/opt|/usr|/root|/home/...
  { pattern: /\/(?:etc|var|opt|usr|root|home)\/[^\s]+/g, label: "internal_path" },
  // ── 个人身份信息补全（2026-09-19 P1-1：原类别只有密钥/路径，漏 PII）──
  // 中国大陆手机号（1 开头 11 位，容忍分隔符）
  { pattern: /(?<!\d)1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g, label: "phone" },
  // 身份证号（18 位，末位可为 X；含出生日期段校验降误报）
  { pattern: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?!\d)/g, label: "id_card" },
  // 银行卡号（16-19 位连续数字；不校验 Luhn——宁误报不漏报；13 位起会误伤订单号）
  { pattern: /(?<!\d)\d{16,19}(?!\d)/g, label: "bank_card" },
];

/** 检查 URL 是否指向内网/特殊地址（SSRF 防护） */
function isSsrfTarget(url: string): boolean {
  try {
    const u = new URL(url);
    return SSRF_BLOCKED_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** 从工具参数中提取所有 URL 字符串 */
function extractUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(args);
  return urls;
}

// ---- 辅助函数 ----------------------------------------------------------

/** 当前 ISO 时间戳 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 将数值限制在 [lo, hi] 区间；NaN 视为 lo */
function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** 把任意值安全序列化为字符串（循环引用/异常时退化为 String()） */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 把项目原有的 SafetyCheckResult（isHighRisk/action/matchedRule）
 * 转换为 brain/types.ts 的 SafetyCheckResult（allowed/severity/reason）。
 *
 * 映射：
 *   action === "deny"            → severity: "denied",    allowed: false
 *   action === "require_approval"→ severity: "high_risk", allowed: false
 *   action === "allow" / 其他     → severity: "allowed",   allowed: true
 */
function convertSafetyResult(
  raw: unknown,
  tool: string,
  args: Record<string, unknown>,
): SafetyCheckResult {
  const checkedAt = nowIso();
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const action = typeof r.action === "string" ? r.action : "";
    const reason =
      typeof r.reason === "string"
        ? r.reason
        : typeof r.matchedRule === "string"
          ? r.matchedRule
          : "";
    if (action === "deny") {
      return {
        allowed: false,
        severity: "denied",
        reason: reason || "命中绝对禁止规则",
        tool,
        args,
        checkedAt,
      };
    }
    if (action === "require_approval") {
      // 内置两阶段确认（ask_first）工具在聊天通道的特例：一律放行到 BookingService。
      //   阶段一 confirm=false 只是「问」——生成摘要+一次性 token，不执行不可逆动作；
      //   阶段二 confirm=true —— token 校验/TTL/限额全部由 BookingService 内生强制，
      //   缺 token/过期 token 返回可自愈的 actionable 错误（模型补上 token 重试即通）。
      // 闸不在这里复刻 token 校验：此前对「阶段二缺 token」的硬拦只生产出
      // 「资金支付类动作需要用户确认」这句误导性死胡同——用户明明已确认，模型
      // 却无法自救（2026-10-18 live e2e 实证：三轮递进确认全部卡死在这句文案上）。
      // 安全语义无损：这四个工具唯一的不可逆路径在 BookingService 内部，token
      // 缺失时它必然拒绝执行。自主任务通道不经过本转换，require_approval 照常
      // 挂起审批（agent-task-orchestrator 直接消费 AgentTaskSafety 结果）。
      if (TWO_PHASE_CONFIRM_TOOLS.has(tool)) {
        return {
          allowed: true,
          severity: "allowed",
          reason: "两阶段确认工具（ask_first）：确认凭证由 BookingService 内生校验",
          tool,
          args,
          checkedAt,
        };
      }
      return {
        allowed: false,
        severity: "high_risk",
        reason: reason || "命中高危规则，需人工审批",
        tool,
        args,
        checkedAt,
      };
    }
    return {
      allowed: true,
      severity: "allowed",
      reason: reason || "通过安全检查",
      tool,
      args,
      checkedAt,
    };
  }
  // 安全服务返回不可识别结果时默认拒绝（fail-closed，安全优先）
  return {
    allowed: false,
    severity: "high_risk",
    reason: "安全服务返回不可识别结果，默认拒绝",
    tool,
    args,
    checkedAt,
  };
}

/**
 * 把 MoodInferenceService 返回的 MoodInference（sentimentScore/confidence/
 * emotionTags/timestamp）转换为 brain/types.ts 的 EmotionVector（VAD + label）。
 *
 * VAD 启发式：
 *   valence    = sentimentScore（-1..1）
 *   arousal    = 0.5 - sentimentScore*0.3（负向情绪唤醒度更高，0..1）
 *   dominance  = 0.5 + sentimentScore*0.2（正向情绪支配度更高，0..1）
 *   label      = emotionTags 拼接，无标签时 "neutral"
 */

/** 情绪惯性权重：上一轮 VAD 在新一轮中的占比（本轮占比 = 1 - 此值 = 0.6） */
const EMOTION_INERTIA_WEIGHT = 0.4;
/**
 * VAD 状态在 KV 中的 entry key。
 * actorId 作为 KV 分区（AgentMemorySyncService 按 sessionId 分区），
 * 故 entry key 无需再带 actorId，全地址等价于 emotion_state_${actorId}。
 * 不复用 user-personalization 的 "emotion_state"（结构不同，避免覆盖）。
 */
const EMOTION_VAD_KV_KEY = "emotion_vad_state";

function convertEmotion(raw: unknown, actorId: string): EmotionVector {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const sentimentScore =
      typeof r.sentimentScore === "number" ? r.sentimentScore : 0;
    const confidence =
      typeof r.confidence === "number" ? r.confidence : 0.5;
    const tags = Array.isArray(r.emotionTags)
      ? r.emotionTags.map((t) => String(t)).filter(Boolean)
      : [];
    const ts = typeof r.timestamp === "string" ? r.timestamp : nowIso();
    const valence = clamp(sentimentScore, -1, 1);
    const arousal = clamp(0.5 - sentimentScore * 0.3, 0, 1);
    const dominance = clamp(0.5 + sentimentScore * 0.2, 0, 1);
    const label = tags.length > 0 ? tags.join("/") : "neutral";
    return {
      actorId,
      valence,
      arousal,
      dominance,
      label,
      confidence,
      detectedAt: ts,
    };
  }
  return defaultEmotion(actorId);
}

/** 默认中性情绪向量（moodInference 未注册或返回空时使用） */
function defaultEmotion(actorId: string): EmotionVector {
  return {
    actorId,
    valence: 0,
    arousal: 0.3,
    dominance: 0.5,
    label: "neutral",
    confidence: 0.3,
    detectedAt: nowIso(),
  };
}

/**
 * 把 TonePolicy 返回转换为 brain/types.ts 的 TonePolicyResult。
 *
 * 支持两种返回形态：
 *   - 对象：{ rewrittenText?, toneProfile?, adjusted?, reason? }
 *   - 字符串：视为语气模式（如 "soft"/"steady"），不改写文本
 */
function convertTone(raw: unknown, originalText: string): TonePolicyResult {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const rewrittenText =
      typeof r.rewrittenText === "string"
        ? r.rewrittenText
        : typeof r.text === "string"
          ? r.text
          : originalText;
    const toneProfile =
      typeof r.toneProfile === "string"
        ? r.toneProfile
        : typeof r.mode === "string"
          ? r.mode
          : "default";
    const adjusted =
      typeof r.adjusted === "boolean"
        ? r.adjusted
        : rewrittenText !== originalText;
    const reason = typeof r.reason === "string" ? r.reason : undefined;
    return { rewrittenText, toneProfile, adjusted, reason };
  }
  if (typeof raw === "string" && raw.length > 0) {
    return {
      rewrittenText: originalText,
      toneProfile: raw,
      adjusted: false,
      reason: "TonePolicy 返回语气模式，未改写文本",
    };
  }
  return {
    rewrittenText: originalText,
    toneProfile: "default",
    adjusted: false,
    reason: "TonePolicy 返回不可识别结果",
  };
}

/**
 * 内置兜底安全检查（taskSafety 未注册时使用）。
 *
 * 用一组核心正则做基本危险检测：DENY_PATTERNS 命中即 denied，
 * HIGH_RISK_PATTERNS 命中即 high_risk，否则 allowed。不调用 LLM。
 */
function builtinCheckSafety(action: {
  tool: string;
  args: Record<string, unknown>;
}): SafetyCheckResult {
  const text = safeStringify(action.args ?? {});
  const tool = action.tool;
  const args = action.args;
  for (const re of DENY_PATTERNS) {
    if (re.test(text)) {
      return {
        allowed: false,
        severity: "denied",
        reason: `命中黑名单: ${re.source}`,
        tool,
        args,
        checkedAt: nowIso(),
      };
    }
  }
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(text)) {
      return {
        allowed: false,
        severity: "high_risk",
        reason: `命中高风险: ${re.source}`,
        tool,
        args,
        checkedAt: nowIso(),
      };
    }
  }
  // SSRF 防护：检查所有 URL 参数是否指向内网
  const urls = extractUrls(args);
  for (const url of urls) {
    if (isSsrfTarget(url)) {
      return {
        allowed: false,
        severity: "denied",
        reason: `SSRF 防护：禁止访问内网地址 ${url}`,
        tool,
        args,
        checkedAt: nowIso(),
      };
    }
  }
  return {
    allowed: true,
    severity: "allowed",
    reason: "通过白名单/无危险模式",
    tool,
    args,
    checkedAt: nowIso(),
  };
}

// ---- LimbicCortex ------------------------------------------------------

/**
 * 边缘皮层：聚合安全 / 情绪 / 语气子系统，提供情感与安全护栏能力。
 *
 * 安全检查：优先委托 AgentTaskSafety，未注册时退化为内置正则黑名单。
 * 情绪推断：委托 MoodInferenceService，未注册时退化为中性向量。
 * 语气策略：委托 AssistantTonePolicy，未注册时退化为原文本透传。
 * 全部为规则/查表实现，不调用 LLM 做自我审查或文本改写。
 */
export class LimbicCortex {
  private taskSafety: TaskSafetyLike | null = null;
  private moodInference: MoodInferenceLike | null = null;
  private tonePolicy: TonePolicyLike | null = null;
  private emotionTone: EmotionToneLike | null = null;
  private synapseBus: SynapseBusLike | null = null;
  private started = false;

  /** 最近一次情绪向量缓存（按 actorId） */
  private readonly lastEmotion = new Map<string, EmotionVector>();
  /** 最近一次 VAD 状态缓存（按 actorId，用于惯性叠加；进程重启后从 KV 加载） */
  private readonly lastVadState = new Map<string, VadState>();
  /** KV 摘要存储（用于 VAD 状态跨会话持久化） */
  private kvSummary: KvSummaryLike | null = null;
  /** 最近一次安全检查结果缓存 */
  private lastSafetyCheck: SafetyCheckResult | null = null;

  // ---- 子系统注册 -------------------------------------------------------

  registerTaskSafety(svc: TaskSafetyLike): void {
    this.taskSafety = svc;
    console.log("[LimbicCortex] 已注册 AgentTaskSafety");
  }

  registerMoodInference(svc: MoodInferenceLike): void {
    this.moodInference = svc;
    console.log("[LimbicCortex] 已注册 MoodInferenceService");
  }

  /**
   * 注册 KV 摘要存储，用于 VAD 情绪状态跨会话持久化。
   *
   * 注册后 inferEmotion 会把每次叠加后的 VAD 状态写入 KV
   * （entry key = emotion_vad_state，分区 = actorId）；
   * 进程重启后首次 inferEmotion 从 KV 加载上轮状态做惯性叠加。
   * 未注册时退化为内存缓存（进程重启丢失），不影响当轮推断。
   */
  registerKvSummary(svc: KvSummaryLike): void {
    this.kvSummary = svc;
    console.log("[LimbicCortex] 已注册 KvSummary（VAD 状态持久化）");
  }

  registerTonePolicy(svc: TonePolicyLike): void {
    this.tonePolicy = svc;
    console.log("[LimbicCortex] 已注册 AssistantTonePolicy");
  }

  registerEmotionTone(svc: EmotionToneLike): void {
    this.emotionTone = svc;
    console.log("[LimbicCortex] 已注册 EmotionTone");
  }

  /**
   * 注册突触总线。
   *
   * 注册后自动订阅 sensory.listen 事件：每当感官皮层识别到用户语音，
   * 即调 inferEmotion 推断情绪向量并更新缓存（inferEmotion 内部已写入
   * lastEmotion Map）。推断异步执行，不阻塞事件循环；异常静默降级。
   */
  registerSynapseBus(svc: SynapseBusLike): void {
    this.synapseBus = svc;
    console.log("[LimbicCortex] 已注册 SynapseBus");
    // 订阅 sensory.listen 事件 → 情绪更新
    if (typeof svc.subscribeType === "function") {
      svc.subscribeType("sensory.listen", (event) => {
        try {
          const text = event.data?.text;
          const actorId =
            (typeof event.data?.actorId === "string" && event.data.actorId) ||
            (typeof event.actorId === "string" && event.actorId) ||
            "";
          if (typeof text === "string" && actorId) {
            // 异步推断情绪；inferEmotion 内部已写入 lastEmotion 缓存
            void this.inferEmotion(actorId, { text }).catch(() => {
              /* 静默 */
            });
          }
        } catch {
          /* 订阅回调异常不传播 */
        }
      });
      console.log("[LimbicCortex] 已订阅 sensory.listen → 情绪更新");
    }
  }

  // ---- 生命周期 ---------------------------------------------------------

  /** 启动边缘皮层：当前无后台任务，仅标记状态 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[LimbicCortex] 已启动，跳过重复 start");
      return;
    }
    console.log("[LimbicCortex] 正在启动...");
    this.started = true;
    console.log("[LimbicCortex] 启动完成");
  }

  /** 停止边缘皮层：清空缓存 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[LimbicCortex] 未启动，跳过 stop");
      return;
    }
    console.log("[LimbicCortex] 正在停止...");
    this.lastEmotion.clear();
    this.lastVadState.clear();
    this.lastSafetyCheck = null;
    this.started = false;
    console.log("[LimbicCortex] 已停止");
  }

  // ---- 核心方法 ---------------------------------------------------------

  /**
   * 安全检查：判定单次工具调用是否安全。
   *
   * 优先委托 taskSafety（依次尝试 checkToolCall / evaluate / check 方法），
   * 把项目原有 SafetyCheckResult 转换为 brain 视角；taskSafety 未注册时
   * 退化为内置正则黑名单 + 高风险模式检测。不调用 LLM。
   */
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult {
    let result: SafetyCheckResult;

    if (this.taskSafety) {
      let raw: unknown = undefined;
      try {
        if (typeof this.taskSafety.checkToolCall === "function") {
          raw = this.taskSafety.checkToolCall(action.tool, action.args);
        } else if (typeof this.taskSafety.evaluate === "function") {
          raw = this.taskSafety.evaluate(action, ctx);
        } else if (typeof this.taskSafety.check === "function") {
          raw = this.taskSafety.check(action, ctx);
        }
      } catch (err) {
        console.log(`[LimbicCortex] checkSafety 委托异常，退化为内置兜底: ${err}`);
        raw = undefined;
      }
      if (raw !== undefined && raw !== null) {
        result = convertSafetyResult(raw, action.tool, action.args);
      } else {
        // 委托返回空或方法均缺失：退化为内置兜底
        result = builtinCheckSafety(action);
      }
    } else {
      // taskSafety 未注册：内置兜底
      result = builtinCheckSafety(action);
    }

    this.lastSafetyCheck = result;
    return result;
  }

  /**
   * 输出安全过滤（Stage 4 Task 2）：检测 LLM 输出文本中的敏感信息并替换为 [REDACTED]。
   *
   * 后置过滤入口，与前置 checkSafety 互补：
   *   - checkSafety 拦「输入侧」工具调用（黑名单/高风险/SSRF）
   *   - checkOutputSafety 拦「输出侧」文本（API key / 私钥 / 长随机串 / 内部路径）
   *
   * 纯正则检测，不依赖 LLM。命中任一规则即视为 unsafe：
   *   - 命中片段替换为 [REDACTED]
   *   - 记录审计日志（console.log，含命中类别 + 上下文摘要）
   *   - 返回 { safe: false, sanitized, reason }
   * 未命中返回 { safe: true, sanitized: text }。
   *
   * @param text LLM 输出文本
   * @param ctx  可选上下文（actorId/sessionId 等，仅用于审计日志）
   */
  checkOutputSafety(
    text: string,
    ctx?: Record<string, unknown>,
  ): { safe: boolean; sanitized: string; reason?: string } {
    if (typeof text !== "string" || text.length === 0) {
      return { safe: true, sanitized: text ?? "" };
    }
    let sanitized = text;
    const hitLabels: string[] = [];
    for (const rule of OUTPUT_REDACT_PATTERNS) {
      // 每条规则单独 reset lastIndex（g 标志在多次调用间有状态）
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(sanitized)) {
        hitLabels.push(rule.label);
        // 替换需重新 reset lastIndex（replace 内部会自行管理，但 test 已移动过）
        rule.pattern.lastIndex = 0;
        sanitized = sanitized.replace(rule.pattern, "[REDACTED]");
      }
    }
    if (hitLabels.length === 0) {
      return { safe: true, sanitized: text };
    }
    const reason = `输出安全过滤命中: ${hitLabels.join(",")}`;
    const actorId =
      ctx && typeof ctx.actorId === "string" ? ctx.actorId : "unknown";
    const sessionId =
      ctx && typeof ctx.sessionId === "string" ? ctx.sessionId : "";
    console.log(
      `[LimbicCortex] 输出安全审计 actorId=${actorId} session=${sessionId} ` +
        `hits=${hitLabels.join(",")} origLen=${text.length} newLen=${sanitized.length} ` +
        `preview=${text.slice(0, 60).replace(/\s+/g, " ")}...`,
    );
    return { safe: false, sanitized, reason };
  }

  /**
   * 情绪推断：根据文本/语音/视觉信号推断 actor 当前情绪向量。
   *
   * 优先委托 moodInference（依次尝试 infer / analyzeMessage 方法），
   * 把返回的 MoodInference 转换为 EmotionVector（VAD + label）。
   * 随后做 VAD 惯性叠加：新情绪 = 本轮推断 * 0.6 + 上轮 * 0.4，
   * 使情绪有惯性、不瞬间切换（如 happy→neutral 仍偏 happy）。
   * 上轮状态优先取内存缓存，缺失时从 KV 加载（跨会话持久化）。
   * moodInference 未注册或返回空时退化为默认中性向量再做叠加。
   */
  async inferEmotion(
    actorId: string,
    signals: { text?: string; voiceTone?: unknown; faceMetrics?: unknown },
  ): Promise<EmotionVector> {
    if (!actorId) {
      return defaultEmotion("");
    }

    let raw: unknown = null;
    if (this.moodInference) {
      try {
        if (typeof this.moodInference.infer === "function") {
          raw = await this.moodInference.infer(actorId, signals);
        } else if (
          typeof this.moodInference.analyzeMessage === "function" &&
          typeof signals.text === "string"
        ) {
          raw = await this.moodInference.analyzeMessage(actorId, signals.text);
        }
      } catch (err) {
        console.log(`[LimbicCortex] inferEmotion 委托异常，退化为中性向量: ${err}`);
        raw = null;
      }
    }
    const inferred =
      raw !== undefined && raw !== null
        ? convertEmotion(raw, actorId)
        : defaultEmotion(actorId);

    // VAD 惯性叠加（含跨会话持久化）
    const emotion = await this.blendWithInertia(actorId, inferred);
    this.lastEmotion.set(actorId, emotion);
    return emotion;
  }

  /**
   * VAD 惯性叠加：把本轮推断的 EmotionVector 与上一轮 VAD 状态混合。
   *
   * VAD 状态采用 0-1 范围（valence 0=sad/1=happy/0.5=neutral）。
   * EmotionVector.valence 为 -1..1，此处转换：v01 = (v + 1) / 2。
   * 叠加公式：new = inferred * (1 - EMOTION_INERTIA_WEIGHT) + prev * EMOTION_INERTIA_WEIGHT。
   * 无上轮状态（首次）时直接用本轮推断。叠加后写入内存缓存与 KV。
   */
  private async blendWithInertia(
    actorId: string,
    inferred: EmotionVector,
  ): Promise<EmotionVector> {
    const inferredVad: VadState = {
      valence: clamp((inferred.valence + 1) / 2, 0, 1),
      arousal: clamp(inferred.arousal, 0, 1),
      dominance: clamp(inferred.dominance, 0, 1),
      timestamp: Date.now(),
    };

    const prevVad =
      this.lastVadState.get(actorId) ?? (await this.loadVadFromKv(actorId));

    const now = Date.now();
    const blended: VadState = prevVad
      ? {
          valence: clamp(
            inferredVad.valence * (1 - EMOTION_INERTIA_WEIGHT) +
              prevVad.valence * EMOTION_INERTIA_WEIGHT,
            0,
            1,
          ),
          arousal: clamp(
            inferredVad.arousal * (1 - EMOTION_INERTIA_WEIGHT) +
              prevVad.arousal * EMOTION_INERTIA_WEIGHT,
            0,
            1,
          ),
          dominance: clamp(
            inferredVad.dominance * (1 - EMOTION_INERTIA_WEIGHT) +
              prevVad.dominance * EMOTION_INERTIA_WEIGHT,
            0,
            1,
          ),
          timestamp: now,
        }
      : inferredVad;

    this.lastVadState.set(actorId, blended);
    await this.persistVadToKv(actorId, blended);

    return {
      actorId,
      valence: blended.valence * 2 - 1,
      arousal: blended.arousal,
      dominance: blended.dominance,
      label: inferred.label,
      confidence: inferred.confidence,
      detectedAt: nowIso(),
    };
  }

  /**
   * 从 KV 加载某 actor 上次的 VAD 状态。
   *
   * 进程重启后内存缓存丢失，首次 inferEmotion 经此方法从 KV 恢复。
   * kvSummary 未注册或读取失败/数据非法时返回 null（降级为首次推断）。
   */
  private async loadVadFromKv(actorId: string): Promise<VadState | null> {
    if (!this.kvSummary) return null;
    try {
      const snapshot = this.kvSummary.getSnapshot(actorId, [
        EMOTION_VAD_KV_KEY,
      ]);
      const raw = snapshot.entries[EMOTION_VAD_KV_KEY];
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const valence = typeof r.valence === "number" ? r.valence : NaN;
      const arousal = typeof r.arousal === "number" ? r.arousal : NaN;
      const dominance = typeof r.dominance === "number" ? r.dominance : NaN;
      const timestamp = typeof r.timestamp === "number" ? r.timestamp : 0;
      if (
        Number.isNaN(valence) ||
        Number.isNaN(arousal) ||
        Number.isNaN(dominance)
      ) {
        return null;
      }
      return {
        valence: clamp(valence, 0, 1),
        arousal: clamp(arousal, 0, 1),
        dominance: clamp(dominance, 0, 1),
        timestamp,
      };
    } catch (err) {
      console.log(`[LimbicCortex] loadVadFromKv 失败: ${err}`);
      return null;
    }
  }

  /**
   * 把叠加后的 VAD 状态持久化到 KV（乐观锁重试，最多 8 次）。
   *
   * kvSummary 未注册时为空操作（仅内存缓存）。写入失败静默降级，
   * 不影响当轮返回的情绪向量。
   */
  private async persistVadToKv(
    actorId: string,
    state: VadState,
  ): Promise<void> {
    if (!this.kvSummary) return;
    try {
      for (let i = 0; i < 8; i++) {
        const { revision } = this.kvSummary.getSnapshot(actorId, [
          EMOTION_VAD_KV_KEY,
        ]);
        const result = await this.kvSummary.applyPatch(actorId, revision, [
          { key: EMOTION_VAD_KV_KEY, op: "put", value: state },
        ]);
        if (result.ok) return;
      }
      console.log("[LimbicCortex] persistVadToKv 乐观锁重试 8 次仍失败");
    } catch (err) {
      console.log(`[LimbicCortex] persistVadToKv 失败: ${err}`);
    }
  }

  /**
   * 语气策略应用：依据当前情绪对文本做语气适配。
   *
   * 委托 tonePolicy（依次尝试 decide / apply 方法），把返回转换为
   * TonePolicyResult。tonePolicy 未注册或返回不可识别时退化为原文本透传。
   * 不调用 LLM 做改写（语气策略应为规则/查表）。
   */
  applyTonePolicy(text: string, emotion: EmotionVector): TonePolicyResult {
    if (this.tonePolicy) {
      let raw: unknown = undefined;
      try {
        if (typeof this.tonePolicy.decide === "function") {
          raw = this.tonePolicy.decide(text, emotion);
        } else if (typeof this.tonePolicy.apply === "function") {
          raw = this.tonePolicy.apply(text, emotion);
        }
      } catch (err) {
        console.log(`[LimbicCortex] applyTonePolicy 委托异常，退化为原文本: ${err}`);
        raw = undefined;
      }
      if (raw !== undefined && raw !== null) {
        return convertTone(raw, text);
      }
      return {
        rewrittenText: text,
        toneProfile: "default",
        adjusted: false,
        reason: "TonePolicy 未返回可用结果",
      };
    }

    // tonePolicy 未注册：原文本透传
    return {
      rewrittenText: text,
      toneProfile: "default",
      adjusted: false,
      reason: "TonePolicy 未注册",
    };
  }

  // ---- 查询 -------------------------------------------------------------

  /** 返回某 actor 最近一次推断的情绪向量；无缓存返回 null */
  getLastEmotion(actorId: string): EmotionVector | null {
    return this.lastEmotion.get(actorId) ?? null;
  }

  /** 返回最近一次安全检查结果；无缓存返回 null */
  getLastSafetyCheck(): SafetyCheckResult | null {
    return this.lastSafetyCheck;
  }

  // ---- 共情响应策略（Phase 2.2） -----------------------------------------

  /**
   * 计算共情响应参数（纯规则，无 LLM 调用）。
   *
   * 基于 EmotionVector 和 RelationshipState 推导语气参数，
   * 注入到现有 toneGuidance slice，不新增 prompt section。
   *
   * @param emotion 情绪向量（valence/arousal/intensity/label）
   * @param relationship 用户关系状态（warmth/rapport/humorTolerance）
   * @returns 共情响应参数
   */
  computeEmpathyResponse(
    emotion: EmotionVector,
    relationship: { warmth: number; rapport: number; humorTolerance: number },
  ): EmpathyResponseParams {
    const intensity = emotion.intensity ?? Math.min(1, emotion.arousal + Math.abs(emotion.valence) * 0.3);
    const isNegative = emotion.valence < -0.3;
    const isPositive = emotion.valence > 0.3;
    const isHighArousal = emotion.arousal > 0.7;

    // 语气修饰词
    let tone_modifier: string;
    if (isNegative && intensity > 0.7) {
      tone_modifier = relationship.warmth > 0.6 ? "深切共情、温柔陪伴" : "共情优先、安抚为主";
    } else if (isNegative) {
      tone_modifier = "轻柔、理解";
    } else if (isPositive && isHighArousal) {
      tone_modifier = relationship.humorTolerance > 0.6 ? "同频兴奋、适当俏皮" : "热情回应";
    } else if (isPositive) {
      tone_modifier = "温和积极";
    } else {
      tone_modifier = relationship.warmth > 0.5 ? "自然亲切" : "自然";
    }

    // 节奏：高强度情绪 → 放慢节奏、先确认情绪
    const pacing = intensity > 0.6 ? "slow" : "normal";

    // 是否需要先确认/共情用户情绪
    const acknowledgment_required =
      isNegative && intensity > 0.5 ? true : isHighArousal && intensity > 0.7;

    // 是否需要主动关心（warmth 高 + 负面情绪 → 关心）
    const proactive_care =
      isNegative && relationship.warmth > 0.6 && intensity > 0.5;

    return {
      tone_modifier,
      pacing,
      acknowledgment_required,
      proactive_care,
      emotion_label: emotion.label,
      intensity,
    };
  }
}

/** 共情响应参数（注入 toneGuidance slice，不新增 prompt section） */
export interface EmpathyResponseParams {
  /** 语气修饰词，如 "深切共情、温柔陪伴" / "热情回应" */
  tone_modifier: string;
  /** 节奏：slow（放慢先共情）/ normal */
  pacing: "slow" | "normal";
  /** 是否需要先确认/共情用户情绪 */
  acknowledgment_required: boolean;
  /** 是否需要主动关心 */
  proactive_care: boolean;
  /** 情绪标签（透传） */
  emotion_label: string;
  /** 情绪强度 0-1 */
  intensity: number;
}
