import { getDataDir } from "../config/data-dir.js";
import type { MemoryManagerService } from "./memory-manager-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { UnifiedExtraction } from "../agentic-memory/unified-extractor.js";
import { isReverseAddressClaim } from "../agentic-memory/unified-extractor.js";
import type { StructuredFactStore } from "../agentic-memory/structured-fact-store.js";
import { tailCategoryFor, tailKindOf } from "../agentic-memory/structured-fact-store.js";
import { extractFactSubject, type UserFactKind } from "./user-fact-store.js";
import {
  compileRunInputHash,
  getMemoryCompileLedger,
  normalizeCompileDay,
  type CompileOp,
  type MemoryCompileLedger,
} from "../agentic-memory/memory-compile-ledger.js";
import {
  detectProfileFieldFromText,
  normalizeDetectedProfileFact,
} from "../memory/fact-vocabulary.js";
import { getDailyJournalService } from "./daily-journal-service.js";
import { getDailyDigestService } from "./daily-digest-service.js";
import { getShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { UserFactStore } from "./user-fact-store.js";
import OpenAI from "openai";
import { mkdir } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import { maybeRunSoulReflection } from "../agent/soul-store.js";
import { auditChatCompletion } from "./llm-token-audit.js";
import {
  getDefaultProfileConsolidator,
  type ProfileConsolidationStats,
} from "./profile-write-scheduler.js";

export type NightlySleepAgentReport = {
  runAt: string;
  actorIds: string[];
  /**
   * 当日 journal 固化计数（含工具结果事件行）：用于确认事件结果是否真的进了
   * 长期记忆；本轮无固化内容时缺省。
   */
  journalFixation?: {
    actors: number;
    lines: number;
    eventLines: number;
    failed: number;
  };
  /**
   * 夜间结构化抽取的质量/成本指标（M4）：一次 LLM 调用产出的 op 数、
   * 被拒 op（无证据/非法）、冲突裁决数、重复事实数。
   */
  extraction?: {
    llmCalls: number;
    factsApplied: number;
    /** 承诺类条目数（权威源 commitments 表，不计入 factsApplied） */
    commitmentsRouted: number;
    conflictsResolved: number;
    rejectedOps: number;
    duplicates: number;
    themes: number;
  };
  /** 编译账本差异：已应用 / 幂等跳过 / 重放整段 */
  compile?: {
    appliedOps: number;
    duplicatedOps: number;
    replayedRuns: number;
  };
  reports: Array<{
    actorId: string;
    dailyCleanupCount: number;
    weeklyMergedCount: number;
    monthlyAbstractedCount: number;
    consistencyFlagCount: number;
    knowledgePromotedCount: number;
    compressionRate: number;
    estimatedRecallPrecision: number;
    plannedActions: number;
    executedActions: number;
    stageReports: Array<{
      stage: string;
      changed: number;
      notes: string[];
    }>;
  }>;
};

export type NightModeConfig = {
  enabled: boolean;
  nightStartHour: number;
  nightEndHour: number;
  timezone: string;
  consolidationBatchSize: number;
};

const DEFAULT_CONFIG: NightModeConfig = {
  enabled: true,
  nightStartHour: 23,
  nightEndHour: 6,
  timezone: "Asia/Shanghai",
  consolidationBatchSize: 50,
};

/**
 * 固化噪音行过滤（P2-6）：U/A 闲聊/语气填充行不进入长期记忆，避免固化噪音污染召回。
 * 高信号行（prefer/fact/commit）不过滤；用户实义陈述与助手有效回答保留。
 */
const CONSOLIDATE_NOISE_RE =
  /^(?:嗯+|哦+|噢+|啊+|诶+|哎|哈|嘿|哟|哦哦|嗯嗯|好的?|好嘞|好滴|好呀|好耶|行|可以|知道了|明白|收到|了解|懂了|是的?|对(?:的|呀|吧)?|没错|随便|没啥|没事|无妨|拜拜|再见|晚安|早上好|下午好|晚上好|你好|嗨|呵呵+|嘿嘿+|哈哈+|算了|好吧|行吧|就这样|没了|没有|不知道|不清楚|不晓得|谢谢(?:你|您)?|多谢|感谢|不用了|别客气|不客气|好的谢谢|可以可以|okk?|okay|sure|yeah|yes|no|thx|thanks?)[。！？!?~,.，\s]*$/i;

/** 内容去掉句读后过短且无实义（如"好的。""嗯""哈哈"）也视为噪音 */
export function isNoiseLogLine(role: string, content: string): boolean {
  if (role === "fact" || role === "prefer" || role === "commit") return false;
  const text = content.replace(/\s+/g, "").replace(/[，。！？!?、；;,.\s]/g, "");
  if (!text) return true;
  return CONSOLIDATE_NOISE_RE.test(content) || text.length <= 1;
}

export type SolidifyVerdict = {
  solidify: boolean;
  reason:
    | "ok"
    | "assistant_self_talk"
    | "noise"
    | "bare_question"
    | "one_shot_reminder"
    | "task_instruction";
};

/** 一次性提醒回执（"一分钟后提醒我…"）：由日程/提醒系统承载，不进长期记忆 */
const ONE_SHOT_REMINDER_TEXT_RE =
  /((?:\d+|[一二两三四五六七八九十半]+)\s*(?:秒|分(?:钟)?|小时|天))[^，。！？,.!?]{0,4}?(?:提醒|喊|叫)/;

/** 工具调用 / 动作指令：是"要去做的事"，不是"关于用户的事实" */
const TOOL_CALL_TEXT_RE = /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/i;
const TOOL_WORD_RE = /(请使用|调用|工具)/;
const ACTION_VERB_RE = /(发一条|发消息|打个电话|打电话|拨出|订一|买一|查一下|播放|设个|创建|删除|看看|找个|找一下|安排|加个|预约|规划|搜索|搜几张|搜几|整理|生成|写一|做个)/;
/** 状态陈述标记：出现这些词说明在讲"我是谁/我要什么"，即便含动作词也值得保留 */
const STATE_MARKER_RE = /(我是|我在|我住|我喜欢|我不吃|我的|叫我|记住|记一下|记下)/;

/**
 * journal 行是否值得固化进长期记忆（2026-11-12 固化过滤）。
 *
 * 实测问题（真实用户 226 行 journal 回放）：
 *   - 旧规则会固化 223 行（98.7%），其中 105 行是助手自述（46%）；
 *   - 另有大量"请使用 xxx 工具给好友发消息"这类动作指令，被当成用户事实；
 *   - 同一句话既落 U 行又落 prefer 行，固化后变成两条。
 *
 * 规则：助手发言 / commit 派生存 / 寒暄 / 短问句 / 一次性提醒 / 动作指令 一律不固化；
 * 用户的状态陈述（我是/我在/我喜欢/叫我…）与 fact 事件行保留。
 */
export function shouldSolidifyJournalLine(role: string, content: string): SolidifyVerdict {
  // commit 行只由助手承诺句派生（journalLinesFromText 的 assistant 分支），
  // 与 A 行同源；承诺的权威是 commitments 表，不进长期记忆。
  if (role === "A" || role === "commit") {
    return { solidify: false, reason: "assistant_self_talk" };
  }
  if (isNoiseLogLine(role, content)) return { solidify: false, reason: "noise" };
  const text = content.trim();
  if (!text) return { solidify: false, reason: "noise" };
  // 问句（带问号，或以 吗/呢/嘛 收尾）：答案才是信息，问答原文保留在 L0
  if ((/[？?]$/.test(text) && text.length <= 30) || /(?:吗|呢|嘛)$/.test(text)) {
    return { solidify: false, reason: "bare_question" };
  }
  // 只有话题没有陈述（"明天天气"/"后天日程"）：也是问句，不是事实
  if (/^(?:今天|明天|后天|大后天|现在|这周|下周)?(?:的)?(?:天气|时间|几点|日程|行程|温度)[呢啊呀？?]?$/.test(text)) {
    return { solidify: false, reason: "bare_question" };
  }
  // 疑问词收尾/内含（"今天天气怎么样"/"我老婆是谁"/"我真名叫什么"）
  if (
    /(谁|什么|啥|哪个|哪里|哪儿|多少|几点|怎么样|如何|为什么|干嘛|多久)/.test(text) &&
    text.length <= 40 &&
    !/(我是|我叫|我在|我住|我喜欢|我的)/.test(text)
  ) {
    return { solidify: false, reason: "bare_question" };
  }
  // 纯客套（"谢谢 哈哈哈"）
  if (/^(?:(?:谢谢|多谢|感谢|好|行|嗯|哦|哈+|呵+|嘿+|啊+|哎)[\s，。！？~,.!?]*)+$/.test(text)) {
    return { solidify: false, reason: "noise" };
  }
  // 去句读后过短（"我就存"）：无信息量
  if (text.replace(/[\s，。！？!?、；;,.]/g, "").length <= 3) {
    return { solidify: false, reason: "noise" };
  }
  if (ONE_SHOT_REMINDER_TEXT_RE.test(text)) {
    return { solidify: false, reason: "one_shot_reminder" };
  }
  // 钟点型叫醒/提醒（"明天早上8点叫我起床"）：同样归日程系统
  if (/(?:\d{1,2}|[一二三四五六七八九十]+)\s*点.{0,8}(?:叫|喊|提醒)/.test(text)) {
    return { solidify: false, reason: "one_shot_reminder" };
  }
  if (/叫[我你].{0,4}(?:起床|吃饭|睡觉|出门)/.test(text)) {
    return { solidify: false, reason: "one_shot_reminder" };
  }
  // 动作指令 / 工具调用：是"要我做事"，不是"关于你的事实"
  const looksLikeAction =
    TOOL_CALL_TEXT_RE.test(text) || TOOL_WORD_RE.test(text) || ACTION_VERB_RE.test(text);
  if (looksLikeAction && !STATE_MARKER_RE.test(text)) {
    return { solidify: false, reason: "task_instruction" };
  }
  return { solidify: true, reason: "ok" };
}

/** 事实文本归一（去空白/句读、小写），用于批内与跨批去重 */
function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？!?、；;,.\s]/g, "").toLowerCase();
}

/**
 * 夜间抽到的一条事实。
 *
 * profile：标准档案字段（称呼/职业/居住地…）的字段名 + 短值。
 * 有它就走权威库（structured_facts），没有就留在长尾事实库（行式 JSON）。
 * 词表口径见 memory/fact-vocabulary.ts。
 */
export type NightlyExtractedFact = {
  kind: "preference" | "fact" | "commitment";
  text: string;
  profile?: { field: string; value: string };
};

/**
 * M1-④：无 LLM 时的确定性事实兜底。
 *
 * 白天 journal 已给高信号行打了 fact/prefer/commit 角色标签（写入侧规则
 * 抽取，零模型）。夜间直接按标签落库，保证「没有模型也能固化事实」。
 */
export function deriveDeterministicFacts(transcript: string): {
  facts: NightlyExtractedFact[];
  duplicates: number;
} {
  const kindMap = { prefer: "preference", fact: "fact", commit: "commitment" } as const;
  const seen = new Set<string>();
  const facts: NightlyExtractedFact[] = [];
  let duplicates = 0;
  for (const line of transcript.split("\n")) {
    const m = line.match(/^\[[^\]]*\s(fact|prefer|commit)\]\s*(.+)$/);
    if (!m) continue;
    const kind = kindMap[m[1] as keyof typeof kindMap];
    const text = m[2]!.trim().slice(0, 200);
    if (!text) continue;
    const key = `${kind}|${normalizeFactText(text)}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    facts.push({ kind, text });
  }
  return { facts: facts.slice(0, 24), duplicates };
}

/**
 * legacy user-facts JSON 长尾 → structured_facts(category=tail:*)，按值去重幂等。
 * 夜间固化与一次性迁移脚本共用这一份落库逻辑（写权限归本服务）。
 */
export async function migrateLegacyTailFactValues(
  structured: StructuredFactStore,
  actorId: string,
  facts: ReadonlyArray<{ kind: UserFactKind; subject: string; value: string; confidence?: number }>,
  writer: string,
): Promise<number> {
  let migrated = 0;
  for (const fact of facts) {
    const value = fact.value.trim();
    if (!value) continue;
    // 幂等与同义合并全部交给写入口的判重闸（同值 touch、近义 ignored=duplicate）
    const applied = structured.applyFact(
      {
        actorId,
        field: fact.subject || extractFactSubject(fact.kind, value),
        value,
        confidence: fact.confidence,
        sourceRef: "migrate:user-facts-json",
        category: tailCategoryFor(fact.kind),
      },
      writer,
    );
    if (applied?.changed) migrated += 1;
  }
  return migrated;
}

// ─── 经历沉淀（episodic → semantic）────────────────────────────────────────
// 夜间把 life_episodes 里「用户说过的话」提炼成长期事实。只做确定性判定：
// 自称/显式偏好直接收，行为重复要求跨 ≥2 个不同日期；一次性提醒、动作指令、
// 口头禅一律不收。写入走 applyFact（同值 touch，不做同义猜测），零新增模型调用。

export interface SedimentEpisodeRow {
  id: string;
  observation: string;
  sourceKind?: string | null;
  createdAt: string;
}

export type SedimentReason =
  | "declaration"
  | "preference"
  | "recurrence"
  | "noise"
  | "one_shot"
  | "instruction"
  | "covered"
  | "deferred"
  | "insufficient_evidence";

export interface SedimentDecision {
  text: string;
  core: string;
  kind: UserFactKind;
  episodeIds: string[];
  days: string[];
  accepted: boolean;
  reason: SedimentReason;
}

export interface SedimentStats {
  decisions: SedimentDecision[];
  applied: number;
  covered: number;
  rejected: number;
  /** 本轮因单轮上限未写、下轮再判的条数 */
  deferred: number;
}

/** 长尾事实入图的最小外观（HumanLikeMemoryService.linkTailFactNodes 结构兼容即可） */
export type TailFactLinker = (
  actorId: string,
  facts: ReadonlyArray<{
    id: string;
    value: string;
    field: string;
    kind: string | null;
    confidence: number | null;
  }>,
) => Promise<{ linked: number; alreadyLinked: number; skipped: number }>;

/** 认知图孤立节点重连的最小外观（HumanLikeMemoryService.relinkIsolatedNodes） */
export type GraphRelinker = (
  actorId: string,
  limit?: number,
) => Promise<{ relinked: number; remaining: number }>;

const GRAPH_RELINK_LIMIT = 150;

const SEDIMENT_WINDOW_DAYS = 30;
const SEDIMENT_MAX_PER_RUN = 3;
/** 自称/声明：讲「我是谁/我要什么」，不是一次性动作 */
const SEDIMENT_DECLARATION_RE =
  /(?:我|本人)(?:(?:老婆|老公|女朋友|男朋友|对象)(?:是|叫)|住在|住[^哪？?\s]|喜欢|习惯|不吃|过敏|是[^谁什哪？?\s]{2,})/;
const SEDIMENT_PREFERENCE_RE = /(?:喜欢|偏好|讨厌|不爱|习惯|每次|总是|以后都|以后别|别再|最怕)/;
const SEDIMENT_IMPERATIVE_RE = /^(?:帮|请|给我|打开|查|搜|看|来几|比一|提醒)/;
const SEDIMENT_NOISE_RE = /^(?:[?？!！。.…~～]+|弟|完成了吗|好的?|嗯+|哦+|在吗|你好|哈哈+|嘿嘿+)$/;

/** 片段 observation → 用户当时的请求原话（工具轨迹取 userRequest，事件行取「用户问：」） */
export function extractEpisodeRequest(observation: string): string {
  const text = (observation ?? "").trim();
  if (!text) return "";
  const quoted = text.match(/userRequest="([^"]{1,160})"/);
  if (quoted?.[1]) return quoted[1].trim();
  if (/^用户问[：:]/.test(text)) {
    return text
      .replace(/^用户问[：:]\s*/, "")
      .replace(/（路由[：:][^）]*）\s*$/, "")
      .trim();
  }
  if (/^Tool interaction\b/i.test(text)) return "";
  return text;
}

export function classifySedimentEpisodes(
  episodes: ReadonlyArray<SedimentEpisodeRow>,
  now: Date = new Date(),
): SedimentDecision[] {
  const cutoff = now.getTime() - SEDIMENT_WINDOW_DAYS * 86_400_000;
  const decisions: SedimentDecision[] = [];
  const groups = new Map<string, { text: string; ids: string[]; days: Set<string> }>();
  for (const ep of episodes) {
    const at = Date.parse(ep.createdAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const day = ep.createdAt.slice(0, 10);
    const request = extractEpisodeRequest(ep.observation).replace(/\s+/g, " ").trim();
    const core = request.replace(/[\s，。！？!?、；;,.]/g, "");
    if (!request || core.length < 3 || SEDIMENT_NOISE_RE.test(request) || CONSOLIDATE_NOISE_RE.test(request)) {
      decisions.push({
        text: request || ep.observation.slice(0, 40),
        core,
        kind: "fact",
        episodeIds: [ep.id],
        days: [day],
        accepted: false,
        reason: "noise",
      });
      continue;
    }
    const group = groups.get(core) ?? { text: request, ids: [], days: new Set<string>() };
    if (!group.ids.includes(ep.id)) group.ids.push(ep.id);
    group.days.add(day);
    groups.set(core, group);
  }

  for (const group of groups.values()) {
    const days = [...group.days].sort();
    let kind: UserFactKind = "fact";
    let accepted = false;
    let reason: SedimentReason;
    if (SEDIMENT_DECLARATION_RE.test(group.text)) {
      accepted = true;
      reason = "declaration";
    } else if (SEDIMENT_PREFERENCE_RE.test(group.text)) {
      accepted = true;
      reason = "preference";
      kind = "preference";
    } else if (ONE_SHOT_REMINDER_TEXT_RE.test(group.text)) {
      reason = "one_shot";
    } else if (ACTION_VERB_RE.test(group.text) || SEDIMENT_IMPERATIVE_RE.test(group.text)) {
      reason = "instruction";
    } else if (days.length >= 2) {
      accepted = true;
      reason = "recurrence";
    } else {
      reason = "insufficient_evidence";
    }
    decisions.push({
      text: group.text,
      core: group.text.replace(/[\s，。！？!?、；;,.]/g, ""),
      kind,
      episodeIds: group.ids,
      days,
      accepted,
      reason,
    });
  }
  return decisions;
}

export function sedimentEpisodesToFacts(
  structured: StructuredFactStore,
  actorId: string,
  episodes: ReadonlyArray<SedimentEpisodeRow>,
  writer: string,
  now: Date = new Date(),
): SedimentStats {
  const decisions = classifySedimentEpisodes(episodes, now);
  let applied = 0;
  let covered = 0;
  let rejected = 0;
  let deferred = 0;
  for (const d of decisions) {
    if (!d.accepted) {
      rejected += 1;
      continue;
    }
    if (applied >= SEDIMENT_MAX_PER_RUN) {
      d.reason = "deferred";
      deferred += 1;
      continue;
    }
    const result = structured.applyFact(
      {
        actorId,
        field: extractFactSubject(d.kind, d.text),
        value: d.text,
        confidence: d.reason === "recurrence" ? 0.62 : 0.78,
        sourceRef: `sediment:${d.episodeIds.slice(0, 4).join(",")}`,
        category: tailCategoryFor(d.kind),
      },
      writer,
    );
    // 值与夜间抽取同一种形态（用户原话，不加「用户说过：」前缀）：两种写法
    // 各存一份才是重复条目的来源，改源头比在库里猜同义便宜。
    if (result?.changed) applied += 1;
    else {
      d.reason = "covered";
      covered += 1;
    }
  }
  return { decisions, applied, covered, rejected, deferred };
}

function loadNightConfig(): NightModeConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: process.env.NIGHT_MEMORY_MODE !== "0",
    nightStartHour:
      Number.parseInt(process.env.NIGHT_START_HOUR ?? "", 10) || DEFAULT_CONFIG.nightStartHour,
    nightEndHour:
      Number.parseInt(process.env.NIGHT_END_HOUR ?? "", 10) || DEFAULT_CONFIG.nightEndHour,
  };
}

export class NightlyMemoryTaskService {
  private readonly config: NightModeConfig;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isNightMode = false;
  /**
   * per-actor 夜间处理水位线（actorId → 已处理日 key）。
   *
   * 原实现是全局 lastProcessedDay：任一 actor 触发后当天其余 actor 全被
   * 挡住；晚睡/后进入 sleeping 的 actor 只能等次日补跑。改为逐 actor 水位，
   * 每个 actor 独立补跑自己的当日 journal。
   */
  private lastProcessedDayByActor = new Map<string, string>();
  /**
   * 水位是否已从磁盘加载（2026-11-12 幂等加固）。
   * 原来只存内存：进程重启后同一晚会再跑一遍——实测 2026-10-21 15:02 与 16:01
   * 两次夜间报告，计划动作被重复计算。
   */
  private runStateLoaded = false;
  /** 正在处理中的 actor（防止同一 actor 的夜间任务并发重入） */
  private readonly actorsInFlight = new Set<string>();
  private memoryManager: MemoryManagerService | null = null;
  private factStore: UserFactStore | null = null;
  /** 经历片段来源（life_episodes）；未注入时跳过经历沉淀 */
  private lifeModel: { loadEpisodes(actorId: string): SedimentEpisodeRow[] } | null = null;
  /**
   * 长尾事实入认知图（装配层注入 HumanLikeMemoryService.linkTailFactNodes）。
   * 增量写入由事实库的写后钩子入图，这里只补改动之前留下的存量。
   */
  private tailFactLinker: TailFactLinker | null = null;
  private memorySync: AgentMemorySyncService | null = null;
  private narrativeMemory: NarrativeMemoryPort | null = null;
  /**
   * AwarenessCortex 引用（可选）。
   * 注入后，dreaming 触发条件从"仅时间窗"升级为"时间窗 + sleeping 状态"双条件，
   * 避免用户深夜还在密集对话时强行触发 dreaming 造成竞态。
   *
   * 动态窗口扩展（2026-10-16 接口统一）：夜间窗口从 UserTimingService
   * 统一取用口取（多源：节律活跃学习 > 在场足迹 > 会话睡眠窗口），
   * 不再直连 AwarenessCortex.getLearnedSleepWindow。
   */
  private userTiming: {
    sleepWindow(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
  } | null = null;
  /** AwarenessCortex（dreaming 触发用：observe 轮询活动状态；窗口取数已移交 UserTimingService） */
  private awarenessCortex: {
    observe(actorId: string): { activity: string } | null;
  } | null = null;
  /**
   * 记录已触发 dreaming 的 actor，避免同一夜间重复触发。
   * key: actorId, value: 当晚首次触发时间 ISO。
   */
  private dreamingTriggeredActors = new Map<string, string>();
  private readonly reportFilePath =
    process.env.AGENT_MEMORY_SLEEP_REPORT_FILE?.trim() ??
    join(getDataDir(), "nightly-memory-reports.json");
  private latestReport: NightlySleepAgentReport | null = null;
  /** 本轮 journal 固化计数（runNightTasks 开始时清零） */
  private lastJournalFixation: NightlySleepAgentReport["journalFixation"] | null = null;
  /** 本轮结构化抽取指标（M4 报告用） */
  private lastExtractionMetrics: NonNullable<NightlySleepAgentReport["extraction"]> | null = null;
  /** 本轮编译账本差异（已应用 / 幂等跳过 / 整段重放） */
  private lastCompileMetrics: NonNullable<NightlySleepAgentReport["compile"]> | null = null;
  private compileLedgerService: MemoryCompileLedger | null = null;
  private recentReports: NightlySleepAgentReport[] = [];

  /** 编译账本惰性打开；SQLite 不可用时夜间照常跑（降级为不幂等）。 */
  private compileLedger(): MemoryCompileLedger {
    if (!this.compileLedgerService) this.compileLedgerService = getMemoryCompileLedger();
    return this.compileLedgerService;
  }

  constructor(config?: Partial<NightModeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    memoryManager: MemoryManagerService | null,
    memorySync: AgentMemorySyncService | null,
    narrativeMemory?: NarrativeMemoryPort | null,
  ): void {
    this.memoryManager = memoryManager;
    this.memorySync = memorySync;
    this.narrativeMemory = narrativeMemory ?? null;
  }

  /**
   * 注入 AwarenessCortex（缺口 3 修复）。
   *
   * 注入后：
   * - tick() 在夜间会检测每个 actor 的 sleeping 状态
   * - 只对处于 sleeping 状态的 actor 触发 dreaming
   * - 保留"昼夜切换兜底"：若用户整夜不睡，夜→昼切换时补跑
   * （动态夜间窗口 2026-10-16 起改走 setUserTiming 注入的统一取用口）
   */
  setAwarenessCortex(
    svc: {
      observe(actorId: string): { activity: string } | null;
    } | null,
  ): void {
    this.awarenessCortex = svc;
    console.log(
      `[NightlyMemory] ${svc ? "已注入 AwarenessCortex（dreaming 双条件触发已启用）" : "AwarenessCortex 已清除"}`,
    );
  }

  /** 注入用户时刻统一取用口（夜间模式动态窗口的数据来源，2026-10-16 接口统一） */
  setUserTiming(
    svc: {
      sleepWindow(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
    } | null,
  ): void {
    this.userTiming = svc;
  }

  startScheduler(): void {
    if (!this.config.enabled || this.schedulerTimer) return;

    this.updateNightMode();
    this.schedulerTimer = setInterval(() => this.tick(), 60_000);
    console.log(
      `[NightlyMemory] Scheduler started. Night mode: ${this.config.nightStartHour}:00-${this.config.nightEndHour}:00 (${this.config.timezone})`,
    );
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  isInNightMode(): boolean {
    return this.isNightMode;
  }

  getLatestReport(): NightlySleepAgentReport | null {
    return this.latestReport;
  }

  getRecentReports(): NightlySleepAgentReport[] {
    return [...this.recentReports];
  }

  shouldDeferConsolidation(): boolean {
    return this.config.enabled && !this.isNightMode;
  }

  async forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    slotResync?: Record<string, { facts: number; preferences: number; keptRecent: number }>;
    /** ⑥ 巩固流水线收尾统计（关闭的悬空问句 / 生成的一日回顾条数 / 遗忘衰减扫描） */
    pipeline?: {
      recaps: number;
      questionsClosed: number;
      decay?: { scanned: number; decayed: number; pruned: number };
    };
    error?: string;
  }> {
    const result = {
      consolidated: false,
      archived: false,
      pipeline: undefined as
        | {
            recaps: number;
            questionsClosed: number;
            decay?: { scanned: number; decayed: number; pruned: number };
          }
        | undefined,
      error: undefined as string | undefined,
    };
    this.lastJournalFixation = null;
    this.lastExtractionMetrics = null;
    this.lastCompileMetrics = { appliedOps: 0, duplicatedOps: 0, replayedRuns: 0 };

    try {
      await this.extractFactsFromJournals();
      await this.consolidateUserProfiles();
      await this.sedimentEpisodicFacts();
      await this.linkExistingTailFacts();
      await this.relinkIsolatedGraphNodes();
      // 顺序修复（M1-②）：memory_summary 巩固必须先读当天 journal 行；
      // consolidateDailyJournals 固化成功后会删除 journal md，放到后面就再也读不到。
      await this.consolidateSummaries();
      await this.consolidateDailyJournals();
      // archived = 当日 journal 已固化进长期图（单一固化入口）。
      // 原先此处还有一轮「DailyDigest 归档 → 长期图」，与 consolidateDailyJournals
      // 对同批当天对话双写长期记忆，已移除——白天只写 journal 一份原始流水。
      result.archived = true;
      result.pipeline = await this.runDreamPhase();
      result.consolidated = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error("[NightlyMemory] Force run failed:", err);
    }

    return result;
  }

  private tick(): void {
    const wasNight = this.isNightMode;
    this.updateNightMode();

    if (!wasNight && this.isNightMode) {
      // 昼→夜 切换：不再立即触发，而是等待 sleeping 状态（缺口 3 修复）
      // 若未注入 awarenessCortex，则回退到原立即触发行为（向后兼容）
      if (!this.awarenessCortex) {
        console.log("[NightlyMemory] Night mode activated (无 awarenessCortex，回退立即触发)");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Night mode activated, waiting for sleeping state to trigger dreaming...");
        // 进入夜间时清空已触发记录，让新夜晚的 sleeping 重新触发
        this.dreamingTriggeredActors.clear();
      }
    }

    // 缺口 3 修复：夜间每分钟检测 sleeping 状态，逐 actor 触发 dreaming
    if (this.isNightMode && this.awarenessCortex) {
      this.checkSleepingAndTriggerDreaming().catch((err) => {
        console.error("[NightlyMemory] Sleeping-triggered dreaming failed:", err);
      });
    }

    if (wasNight && !this.isNightMode) {
      // 夜→昼 切换：兜底补跑（若整夜未触发）
      if (this.hasDueActors()) {
        console.log("[NightlyMemory] Day mode activated, running missed night tasks as fallback");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Fallback night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Day mode activated, night tasks already processed");
      }
    }

    this.checkMidnightRollover();
  }

  /**
   * 检查每个 actor 的 sleeping 状态，对首次进入 sleeping 的 actor 触发 dreaming。
   *
   * - 注入了 awarenessCortex 才生效
   * - 每个 actor 每晚只触发一次（dreamingTriggeredActors 去重）
   * - sleeping 判定由 awareness-cortex.ts 完成（30min 无桌面活动 + 23:00-6:00）
   */
  private async checkSleepingAndTriggerDreaming(): Promise<void> {
    if (!this.awarenessCortex) return;
    const today = this.getTodayKey();
    // 新一天开始时清空已触发记录。
    // 注意：这里存的是 getTodayKey()（服务器本地日期），不能再存 UTC ISO 再
    // slice(0,10) 比——服务器在 Asia/Shanghai 时，凌晨 00:00-08:00 的 UTC 日期
    // 是前一天，两边永远不等 → 每分钟 clear 一次 → 「entered sleeping」日志
    // 每分钟刷一轮、observe() 白跑（2026-11-11 排查发现）。
    if (this.dreamingTriggeredActors.size > 0) {
      const firstTriggerDay = this.dreamingTriggeredActors.values().next().value;
      if (firstTriggerDay !== undefined && firstTriggerDay !== today) {
        this.dreamingTriggeredActors.clear();
      }
    }

    const actorIds = this.getAllActorIds();
    for (const actorId of actorIds) {
      if (this.dreamingTriggeredActors.has(actorId)) continue;
      try {
        const state = this.awarenessCortex.observe(actorId);
        if (state?.activity === "sleeping") {
          console.log(`[NightlyMemory] Actor ${actorId} entered sleeping, triggering dreaming...`);
          this.dreamingTriggeredActors.set(actorId, today);
          // 逐 actor 触发：只处理该 actor 的当日流水，后睡者独立补跑，
          // 不再被其他 actor 的全局水位线挡住（M1-①）。
          await this.runNightTasks([actorId]);
        }
      } catch (err) {
        // observe 失败不阻塞其他 actor
        console.log(`[NightlyMemory] observe(${actorId}) failed: ${err}`);
      }
    }
  }

  /**
   * 判定当前是否处于夜间模式。
   *
   * 动态窗口优先级（2026-10-16 接口统一）：
   * 1. UserTimingService.sleepWindow 学到的个性化窗口（多源合并：节律活跃
   *    学习 > 在场足迹 > 会话睡眠窗口，样本门槛由各源自行把关）
   * 2. 否则回退到 config.nightStartHour/nightEndHour（默认 23-6 或 env 配置）
   *
   * 多 actor 场景：只要有任一 actor 学习到个性化窗口，就采用该窗口。
   * （通常一个主机只有一个主用户，多 actor 时取第一个有效的即可）
   */
  private updateNightMode(): void {
    const now = new Date();
    // 使用分钟精度判定，避免 23:30 进入 sleeping 但整点判定还在白天的问题
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(now);
    const [h, m] = hourStr.split(":").map(Number);
    const hourDecimal = h + m / 60;

    // 尝试获取动态学习到的窗口（统一取用口）
    let startHour = this.config.nightStartHour;
    let endHour = this.config.nightEndHour;
    let usingDynamic = false;
    if (this.userTiming) {
      for (const actorId of this.getAllActorIds()) {
        const learned = this.userTiming.sleepWindow(actorId);
        if (learned) {
          startHour = learned.startHour;
          endHour = learned.endHour;
          usingDynamic = true;
          break;
        }
      }
    }

    // 跨天窗口（start > end，如 23.5→6.25）：hour >= start OR hour < end
    // 同天窗口（start < end，如 13→14 午休）：start <= hour < end
    if (startHour > endHour) {
      this.isNightMode = hourDecimal >= startHour || hourDecimal < endHour;
    } else {
      this.isNightMode = hourDecimal >= startHour && hourDecimal < endHour;
    }

    // 动态窗口切换日志（仅在切换时打印一次，避免每分钟刷屏）
    if (usingDynamic && !this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 动态睡眠窗口已启用：${startHour.toFixed(2)}→${endHour.toFixed(2)}（基于用户习惯学习）`,
      );
      this.loggedDynamicWindow = true;
    } else if (!usingDynamic && this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 回退默认睡眠窗口：${startHour}:00→${endHour}:00（学习样本不足）`,
      );
      this.loggedDynamicWindow = false;
    }
  }
  private loggedDynamicWindow = false;

  /**
   * 夜间任务主入口。actorIds 缺省处理全部 actor；传参时只处理这些 actor
   * （sleeping 逐 actor 触发用）。每个 actor 有独立当日水位线，重复触发是幂等的。
   */
  /** 持久化水位文件（一小份 JSON，只存 actor→已处理日期） */
  private runStatePath(): string {
    return join(getDataDir(), "nightly-run-state.json");
  }

  private loadRunState(): void {
    if (this.runStateLoaded) return;
    this.runStateLoaded = true;
    try {
      const raw = readFileSync(this.runStatePath(), "utf8");
      const parsed = JSON.parse(raw) as { lastProcessedDay?: Record<string, string> };
      for (const [actorId, day] of Object.entries(parsed.lastProcessedDay ?? {})) {
        if (typeof day === "string" && day) this.lastProcessedDayByActor.set(actorId, day);
      }
    } catch {
      /* 首次运行/文件缺失：从空水位开始 */
    }
  }

  private persistRunState(): void {
    try {
      const path = this.runStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          { version: 1, lastProcessedDay: Object.fromEntries(this.lastProcessedDayByActor) },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      console.warn(`[NightlyMemory] 水位持久化失败（不影响本轮）：${err}`);
    }
  }

  private async runNightTasks(actorIds?: string[]): Promise<void> {
    this.loadRunState();
    const today = this.getTodayKey();
    const candidates = (actorIds ?? this.getAllActorIds()).filter(
      (id) => this.lastProcessedDayByActor.get(id) !== today && !this.actorsInFlight.has(id),
    );
    if (candidates.length === 0) return;

    // 先占位避免并发重入；失败时回滚，允许下一次补跑
    for (const id of candidates) this.actorsInFlight.add(id);
    this.lastJournalFixation = null;
    this.lastCompileMetrics = { appliedOps: 0, duplicatedOps: 0, replayedRuns: 0 };

    console.log(`[NightlyMemory] Running night tasks for ${candidates.join(",")} (${today})`);

    try {
      // 巩固管线（episodic → semantic）：journal 固化前先把日志批处理成稳定事实
      // （写入结构化槽位，latest-wins 归并）。夜间常规只有这一次 LLM 调用；
      // 无 LLM 时退化为 journal fact/prefer/commit 标签行的确定性落库（M1-④）。
      await this.extractFactsFromJournals(candidates);
      await this.consolidateUserProfiles(candidates);
      await this.runSoulReflectionIfDue(candidates);
      // 顺序修复（M1-②）：摘要巩固读 journal 必须在 journal 删除之前。
      await this.consolidateSummaries(candidates);
      await this.consolidateDailyJournals(candidates);
      await this.runDreamPhase(candidates);
      await this.migrateLegacyTailFacts(candidates);
      // M3：提交后不变量自检（同 kind+subject 不得双 active / active 必须有非空证据值）。
      await this.auditFactStoreInvariants(candidates);
      await this.cleanupOldStorage();
      for (const id of candidates) {
        this.lastProcessedDayByActor.set(id, today);
        this.actorsInFlight.delete(id);
      }
      this.persistRunState();
      console.log("[NightlyMemory] All night tasks completed successfully");
    } catch (err) {
      for (const id of candidates) this.actorsInFlight.delete(id);
      console.error("[NightlyMemory] Night tasks error:", err);
    }
  }

  /** 是否存在今天尚未处理的 actor（昼夜切换兜底 / 调度判定用） */
  private hasDueActors(): boolean {
    this.loadRunState();
    const today = this.getTodayKey();
    return this.getAllActorIds().some(
      (id) => this.lastProcessedDayByActor.get(id) !== today && !this.actorsInFlight.has(id),
    );
  }

  /**
   * M3 提交后不变量自检（确定性，零 LLM）：
   * - 同一 kind+subject 槽位不得同时存在两条活跃事实；
   * - 活跃事实必须有非空的值（证据）。
   * 只审计告警，不做自动改写——异常暴露给报告/日志，避免静默双写漂移。
   */
  private async auditFactStoreInvariants(actorIds: string[]): Promise<void> {
    try {
      const structured = await this.getStructuredFactStore();
      const legacy = this.getFactStore();
      for (const actorId of actorIds) {
        // 长尾事实的家是 structured_facts（category=tail:*）；JSON 库只在
        // 结构化库不可用时才是写入侧，此时按同一口径审计它的存量。
        const facts = structured
          ? structured
              .getTailFacts(actorId)
              .map((f) => ({ key: f.field, value: f.value }))
          : (await legacy.getFacts(actorId)).map((f) => ({
              key: `${f.kind}:${f.subject}`,
              value: f.value,
            }));
        const seen = new Set<string>();
        let anomalies = 0;
        for (const fact of facts) {
          if (seen.has(fact.key)) anomalies += 1;
          seen.add(fact.key);
          if (!fact.value.trim()) anomalies += 1;
        }
        if (anomalies > 0) {
          console.warn(
            `[NightlyMemory] 不变量自检: actor=${actorId} 发现 ${anomalies} 条异常（双 active / 空证据）`,
          );
        }
      }
    } catch (err) {
      console.warn("[NightlyMemory] 不变量自检失败:", err);
    }
  }

  /**
   * 存量收敛：legacy user-facts JSON 里的长尾事实搬进 structured_facts
   * （category=tail:<kind>）。幂等——按值去重，已存在的跳过；JSON 不再被
   * 写入，迁移完成后只是只读历史。
   */
  private async migrateLegacyTailFacts(actorIds: string[]): Promise<void> {
    const structured = await this.getStructuredFactStore();
    if (!structured) return;
    let migrated = 0;
    for (const actorId of actorIds) {
      try {
        migrated += await migrateLegacyTailFactValues(
          structured,
          actorId,
          await this.getFactStore().getFacts(actorId),
          "NightlyMemoryTaskService",
        );
      } catch (err) {
        console.warn(`[NightlyMemory] 长尾事实迁移失败（actor=${actorId}）:`, err);
      }
    }
    if (migrated > 0) {
      console.log(`[NightlyMemory] 长尾事实迁移: ${migrated} 条 user-facts JSON → structured_facts(tail:* )`);
    }
  }

  /** memory_summary 已下线：夜间不再维护该槽，当前状态由读侧编译器从权威库重建。 */
  private async consolidateSummaries(_actorIds?: string[]): Promise<void> {}

  /**
   * 灵魂周级反思：复用夜间事实提炼阶段拼好的精简流水（零额外读盘）。
   * 周级门禁在 soul-store 内部（changelog 最近一条 ≥7 天才调 LLM），
   * 每周最多一次；LLM 缺失/失败静默跳过，绝不影响后续固化阶段。
   */
  private async runSoulReflectionIfDue(actorIds?: string[]): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal) return;
    try {
      for (const actorId of actorIds ?? this.getAllActorIds()) {
        const built = await this.buildNightlyTranscript(journal, actorId);
        if (!built) continue;
        const soul = await maybeRunSoulReflection({ transcript: built.transcript });
        if (soul.applied) {
          console.log(`[NightlyMemory] Soul reflection applied (${soul.reason})`);
        }
        // M1-⑥：原 return 让多 actor 时只处理第一个；改为继续遍历（soul-store
        // 自带 7 天门禁，后续 actor 不会产生额外 LLM 调用）。
      }
    } catch (err) {
      console.error("[NightlyMemory] Soul reflection failed:", err);
    }
  }

  /** 从未固化 journal 行拼装精简流水（夜间事实提炼 / 灵魂反思共用） */
  private async buildNightlyTranscript(
    journal: NonNullable<ReturnType<typeof getDailyJournalService>>,
    actorId: string,
  ): Promise<{ transcript: string; observedOn: string } | null> {
    const unconsolidated = await journal.getUnconsolidatedLines(actorId);
    if (unconsolidated.length === 0) return null;

    const transcriptLines: string[] = [];
    let observedOn: string | null = null;
    for (const { dateKey, lines } of unconsolidated) {
      // 观察日 = 本批日志覆盖的最大日历日（跨天补跑时一次调用只记 1 天证据，
      // 保守口径：习惯多日门槛靠不同「运行日」累积，不因一次补跑灌水）
      if (/^\d{4}-\d{2}-\d{2}/.test(dateKey)) {
        const day = dateKey.slice(0, 10);
        if (!observedOn || day > observedOn) observedOn = day;
      }
      for (const line of lines) {
        const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
        if (!m) continue;
        const roleMatch = m[2]!.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
        if (!roleMatch) continue;
        const role = roleMatch[2]!;
        const content = roleMatch[3]!.slice(0, 300);
        // 夜间事实提炼的原料同样过固化过滤：否则 LLM 会把助手发言
        // 提炼成"用户事实"（实测 ledger 42% 助手自述的另一条来源）。
        if (!shouldSolidifyJournalLine(role, content).solidify) continue;
        transcriptLines.push(`[${dateKey} ${m[1]} ${role}] ${content}`);
      }
    }
    if (transcriptLines.length < 4) return null;
    return {
      transcript: transcriptLines.slice(-120).join("\n"),
      observedOn: observedOn ?? new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * 当日对话日志固化（记忆架构重构核心环节）：
   * - 消费 DailyJournal 未固化日志行（含跨天补跑——服务器隔夜未开机也能追上）；
   * - 写入 narrative 长期记忆（journal:consolidate 来源，偏好/事实行高信号）；
   * - 固化完成后标记已处理并删除对应 md（内容已入 LTM，文件只承载未固化当天记忆）。
   */
  private async consolidateDailyJournals(actorIds?: string[]): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal || !this.narrativeMemory) return;

    const targets = actorIds ?? this.getAllActorIds();
    const ledger = this.compileLedger();
    const compile = (this.lastCompileMetrics ??= {
      appliedOps: 0,
      duplicatedOps: 0,
      replayedRuns: 0,
    });
    let totalIngested = 0;
    let totalEventLines = 0;
    let totalFailed = 0;
    let totalAssistantSkipped = 0;
    let consolidatedActors = 0;

    for (const actorId of targets) {
      try {
        const unconsolidated = await journal.getUnconsolidatedLines(actorId);
        if (unconsolidated.length === 0) continue;

        const dateKeys: string[] = [];
        const consumedTurnIds: string[] = [];
        const failedDates = new Set<string>();
        let eventLines = 0;
        let failed = 0;
        let assistantSkipped = 0;
        let duplicateSkipped = 0;
        /** 同一 actor 本次固化已消费的内容（U 行与 prefer/fact 行会重复同一句） */
        const seenSolidified = new Set<string>();
        for (const { dateKey, lines, turnIds } of unconsolidated) {
          let ingested = 0;
          let noiseSkipped = 0;
          for (const line of lines) {
            // 行格式: - [HH:mm] sessId? U|A|fact|prefer|commit: content
            const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
            if (!m) continue;
            const time = m[1]!;
            const body = m[2]!;
            const roleMatch = body.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
            if (!roleMatch) continue;
            const role = roleMatch[2]!;
            const content = roleMatch[3]!;
            // 事件行带 `e-<key>` 短标记：还原来源事件 id，LTM 条目保留可追溯性
            const journalToken = roleMatch[1] ?? "";
            const provenance =
              role === "fact" && /^e-[\w-]+$/.test(journalToken)
                ? { sourceEventIds: [`evt:${actorId}:${journalToken.slice(2)}`] }
                : {};
            // P2-6 + 2026-11-12：固化过滤。助手发言（A/commit 派生）不进长期记忆；
            // 寒暄/短问句/一次性提醒/动作指令也跳过（fact/prefer 状态陈述保留）。
            const verdict = shouldSolidifyJournalLine(role, content);
            if (!verdict.solidify) {
              if (verdict.reason === "assistant_self_talk") assistantSkipped += 1;
              else noiseSkipped += 1;
              continue;
            }
            // 同一句话可能同时落 U 行与 prefer/fact 行：按归一内容去重，只固化一次。
            const dedupeKey = normalizeFactText(content);
            if (seenSolidified.has(dedupeKey)) {
              duplicateSkipped += 1;
              continue;
            }
            seenSolidified.add(dedupeKey);
            // 幂等键：同一 actor 同一天同一行（时间+角色+归一内容）只固化一次。
            // 失败路径不落账本，原文保持 pending，下轮会重试。
            const fixationOp: CompileOp = {
              actorId,
              day: dateKey,
              stage: "fixate",
              opType: "journal.line",
              target: `${time}|${role}|${dedupeKey}`,
              eventTime: `${dateKey}T${time}:00`,
            };
            if (ledger.hasOp(fixationOp)) {
              duplicateSkipped += 1;
              compile.duplicatedOps += 1;
              continue;
            }
            // 白天统一写入已存过同一句话 → 夜间固化不再写第二份（仍记 op，
            // 避免第二天把同一行当成未处理重跑）。
            if (this.narrativeMemory.wasRecentlyWritten?.(actorId, content)) {
              ledger.markOp(fixationOp);
              duplicateSkipped += 1;
              compile.duplicatedOps += 1;
              continue;
            }
            const roleLabel = role === "U" ? "用户" : role === "A" ? "助手" : role;
            const isEventLine = provenance.sourceEventIds !== undefined;
            const highSignal = role === "prefer" || role === "fact" || role === "commit";
            // 2026-09-12 token 治理（P0-A）：固化行直存（infer:false），不再逐行二次抽取。
            // 同批对话内容白天已由统一写入者 extractUnified 抽取过并写入同一存储；夜间
            // 逐行 ingest 每行再触发一次 extractUnified 属纯重复（产生的重复记忆还要靠
            // 次日 24h 生命周期审查再花 LLM 清理）。固化的价值是 episodic 时间线——
            // 原文直存即可；语义提升由 extractFactsFromJournals 的整批事实提炼承担。
            const fixationText = `[日志固化 ${dateKey} ${time}·${roleLabel}] ${content}`;
            const fixationExtraction: UnifiedExtraction = {
              decision: highSignal ? "remember" : "decay",
              memories: [fixationText],
              corrections: [],
              understandings: [],
              facts: [],
              forget: [],
              referents: [],
              // 工具结果事件跨情境价值低于用户陈述：低一档，按生命周期正常淡出
              importance: isEventLine ? 0.5 : highSignal ? 0.7 : 0.3,
            };
            try {
              const outcome = await this.narrativeMemory!.writeDecided(
                actorId,
                fixationText,
                "journal:consolidate",
                { context: "main", highSignal, ...provenance },
                fixationExtraction,
              );
              // 只有真正落库（或未配置落库侧）才允许后续删除 journal 原文
              if (outcome === undefined || outcome.persisted) {
                ledger.markOp(fixationOp);
                compile.appliedOps += 1;
                ingested += 1;
                if (isEventLine) eventLines += 1;
              } else {
                failed += 1;
                failedDates.add(dateKey);
                console.error(
                  `[NightlyMemory] journal 行固化未落库（保留原文待重试）: actor=${actorId} date=${dateKey}`,
                );
              }
            } catch (err) {
              failed += 1;
              failedDates.add(dateKey);
              console.log(`[NightlyMemory] journal 行固化失败（跳过该行）: ${err}`);
            }
          }
          // 当天存在任何未落库的行时，整天都不标记已固化，避免删除后不可重试。
          // 纯噪音轮次（全部被 isNoiseLogLine 过滤）同样视为已消费，否则永远 pending。
          // 一天只要"全部行都被处理过"（落库/被过滤）就算消费完成；否则永远 pending。
          // 2026-11-12：assistantSkipped / duplicateSkipped 也是有效处理结果，必须计入，
          // 否则整天都是助手发言时会被无限重跑。
          if (
            (ingested > 0 ||
              noiseSkipped > 0 ||
              assistantSkipped > 0 ||
              duplicateSkipped > 0 ||
              lines.length === 0) &&
            !failedDates.has(dateKey)
          ) {
            dateKeys.push(dateKey);
            consumedTurnIds.push(...turnIds);
          }
          totalIngested += ingested;
        }
        totalEventLines += eventLines;
        totalFailed += failed;
        totalAssistantSkipped += assistantSkipped;
        if (assistantSkipped > 0 || duplicateSkipped > 0) {
          console.log(
            `[NightlyMemory] actor=${actorId} 固化过滤：跳过助手发言 ${assistantSkipped} 行、` +
              `重复内容 ${duplicateSkipped} 行（均不进长期记忆）`,
          );
        }

        if (failedDates.size > 0) {
          // 失败日期保持 pending：turns 原文不丢，outbox 记录 attempts 供次日重试
          journal.recordConsolidationFailure(
            actorId,
            [...failedDates],
            "journal line consolidation failed",
          );
        }

        if (dateKeys.length > 0) {
          await journal.markConsolidated(actorId, dateKeys, consumedTurnIds);
          consolidatedActors += 1;
          console.log(
            `[NightlyMemory] journal 固化: actor=${actorId} dates=${dateKeys.join(",")} 已入长期记忆`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] journal consolidation failed for ${actorId}:`, err);
      }
    }

    if (totalIngested > 0) {
      this.lastJournalFixation = {
        actors: consolidatedActors,
        lines: totalIngested,
        eventLines: totalEventLines,
        failed: totalFailed,
      };
      console.log(
        `[NightlyMemory] journal consolidation total ingested: ${totalIngested} lines` +
          (totalEventLines > 0 ? `（事件行 ${totalEventLines}）` : "") +
          (totalFailed > 0 ? `，失败 ${totalFailed}` : ""),
      );
    } else if (totalFailed > 0) {
      // 全部未落库：保留原文，但要把失败暴露出来，避免静默
      this.lastJournalFixation = {
        actors: consolidatedActors,
        lines: 0,
        eventLines: totalEventLines,
        failed: totalFailed,
      };
      console.error(
        `[NightlyMemory] journal consolidation 全部未落库，原文已保留待重试：失败 ${totalFailed} 行`,
      );
    } else {
      this.lastJournalFixation = null;
    }
  }

  /**
   * ⑥ 巩固流水线收尾（一次跑完，2026-11-08）。
   *
   * 与现有 dreaming 共用同一入口，不新建独立巩固器：
   *   日结摘要（digest）→ 事实升格（extractFactsFromJournals 已在上游完成）
   *   → 关闭悬空问句（STM 会话状态槽）→ 一句话回顾（digest summaryLayer）
   *
   * 问句本体不删除：①原文窗口与情景日志里的 agent 问句保持原样，这里只清
   * 「待追问」标记，保证夜间之后不会跨天复读同一个问题。
   */
  private async runConsolidationPipeline(actorIds?: string[]): Promise<{
    recaps: number;
    questionsClosed: number;
    decay: { scanned: number; decayed: number; pruned: number };
  }> {
    const questionsClosed = getShortTermMemoryGatewayService()?.closePendingQuestions() ?? 0;
    const targets = actorIds ?? this.getAllActorIds();

    const digest = getDailyDigestService();
    let recaps = 0;
    for (const actorId of targets) {
      try {
        if (digest.consolidateDayRecap(actorId)) recaps += 1;
      } catch (err) {
        console.error(`[NightlyMemory] day recap failed for ${actorId}:`, err);
      }
    }

    // P2 遗忘曲线收尾：巩固之后统一跑一次衰减/剪枝（共享曲线 + 访问频率 + 情绪显著度）。
    // 通过注入的 decayRunner 调用 MemoryForgettingController，避免 nightly ⇄ brain 循环依赖。
    const decay = { scanned: 0, decayed: 0, pruned: 0 };
    if (this.decayRunner) {
      try {
        const stats = await this.decayRunner(targets);
        decay.scanned = stats.scanned;
        decay.decayed = stats.decayed;
        decay.pruned = stats.pruned;
      } catch (err) {
        console.error("[NightlyMemory] decay sweep failed (ignored):", err);
      }
    }

    console.log(
      `[NightlyMemory] Consolidation pipeline: questionsClosed=${questionsClosed} recaps=${recaps} ` +
        `decay(scanned=${decay.scanned}/decayed=${decay.decayed}/pruned=${decay.pruned})`,
    );
    return { recaps, questionsClosed, decay };
  }

  /** 注入遗忘衰减扫描（create-app-services 注册 MemoryForgettingController 时接线） */
  setDecayRunner(
    fn:
      | ((actorIds: string[]) => Promise<{ scanned: number; decayed: number; pruned: number }>)
      | null,
  ): void {
    this.decayRunner = fn;
  }

  private decayRunner:
    | ((actorIds: string[]) => Promise<{ scanned: number; decayed: number; pruned: number }>)
    | null = null;

  /** 事实主库（懒初始化；可用 USER_FACT_STORE_DIR 覆盖存储目录，测试注入用） */
  getFactStore(): UserFactStore {
    if (!this.factStore) {
      const dir = process.env.USER_FACT_STORE_DIR?.trim();
      this.factStore = dir ? new UserFactStore(dir) : new UserFactStore();
    }
    return this.factStore;
  }

  /**
   * 计划到期扫描（独立入口，2026-10-19 P0 修复）。
   *
   * 之前挂在 extractFactsFromJournals 的 actor 循环里，被该方法开头两道早退
   * （!journal / !llm）挡住——没有 LLM 配置的环境计划**永远不会 lapsed**，
   * 防线形同虚设。本方法无任何早退：所有登记 actor 无条件扫一遍。
   *
   * 调用时机：夜间任务 + 服务启动补扫（进程白天重启也不漏一天）。
   * @returns 本轮降级为 lapsed 的计划条数
   */
  async runPlanSweepForAllActors(now: Date = new Date()): Promise<number> {
    let total = 0;
    try {
      const structured = await this.getStructuredFactStore();
      if (!structured) return 0;
      for (const actorId of this.getAllActorIds()) {
        try {
          total += structured.sweepUpcomingPlans(actorId, now);
        } catch (err) {
          console.warn(`[NightlyMemory] 计划到期扫描失败（跳过该 actor） ${actorId}:`, err);
        }
      }
    } catch (err) {
      console.warn("[NightlyMemory] 计划到期扫描整体失败（忽略）:", err);
    }
    return total;
  }

  /**
   * 结构化事实库（计划到期扫描 + 档案字段落位用）。动态导入避免
   * nightly ⇄ agentic-memory 的静态循环；未装配时返回 null（夜间任务照常跑）。
   */
  private async getStructuredFactStore(): Promise<StructuredFactStore | null> {
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      return getMemoryComponents().factStore ?? null;
    } catch {
      return null;
    }
  }

  setFactStore(store: UserFactStore): void {
    this.factStore = store;
  }

  /** 注入经历片段来源（LifeModelStore），启用夜间「经历 → 长期事实」沉淀。 */
  setLifeModelStore(store: { loadEpisodes(actorId: string): SedimentEpisodeRow[] } | null): void {
    this.lifeModel = store;
  }

  /** 注入长尾事实入图回调（HumanLikeMemoryService），启用夜间存量补节点。 */
  setTailFactLinker(linker: TailFactLinker | null): void {
    this.tailFactLinker = linker;
  }

  /**
   * 经历沉淀：把近 30 天片段里用户明确说过的偏好/自称沉淀为长尾事实。
   * 只做确定性判定，零模型调用；一次性指令与口头禅在闸门处丢弃。
   */
  private async sedimentEpisodicFacts(actorIds?: string[]): Promise<void> {
    const structured = await this.getStructuredFactStore();
    if (!structured || !this.lifeModel) return;
    for (const actorId of actorIds ?? this.getAllActorIds()) {
      try {
        const episodes = this.lifeModel.loadEpisodes(actorId);
        if (episodes.length === 0) continue;
        const stats = sedimentEpisodesToFacts(
          structured,
          actorId,
          episodes,
          "NightlyMemoryTaskService",
        );
        const byReason = stats.decisions.reduce<Record<string, number>>((acc, d) => {
          acc[d.reason] = (acc[d.reason] ?? 0) + 1;
          return acc;
        }, {});
        console.log(
          `[NightlyMemory] 经历沉淀: actor=${actorId} 片段=${episodes.length} ` +
            `新增=${stats.applied} 已覆盖=${stats.covered} 未采纳=${stats.rejected}` +
            (stats.deferred > 0 ? ` 顺延=${stats.deferred}` : "") +
            ` 依据=${JSON.stringify(byReason)}`,
        );
      } catch (err) {
        console.error(`[NightlyMemory] 经历沉淀失败（跳过该 actor） ${actorId}:`, err);
      }
    }
  }

  /**
   * 存量长尾事实补建认知图节点（幂等、零模型调用）。
   * 增量在事实库写后钩子里就入图了；这一步只负责把钩子接通之前留下的历史补齐，
   * 已建过节点的由 linkTailFactNodes 自己按 tailFactId 跳过。
   */
  private async linkExistingTailFacts(actorIds?: string[]): Promise<void> {
    const linker = this.tailFactLinker;
    if (!linker) return;
    const structured = await this.getStructuredFactStore();
    if (!structured) return;
    for (const actorId of actorIds ?? this.getAllActorIds()) {
      try {
        const tails = structured.getTailFacts(actorId);
        if (tails.length === 0) continue;
        const stats = await linker(
          actorId,
          tails.map((f) => ({
            id: f.id,
            value: f.value,
            field: f.field,
            kind: tailKindOf(f.category),
            confidence: f.confidence,
          })),
        );
        console.log(
          `[NightlyMemory] 长尾入图: actor=${actorId} 长尾=${tails.length} ` +
            `新建节点=${stats.linked} 已有=${stats.alreadyLinked} 跳过=${stats.skipped}`,
        );
      } catch (err) {
        console.error(`[NightlyMemory] 长尾事实入图失败（跳过该 actor） ${actorId}:`, err);
      }
    }
  }

  /**
   * 存量孤立节点重连（幂等、零模型调用）：图侧建边过去只看最近 200 个候选，
   * 老记忆因此拿不到边、联想路到不了。这里把零边的活跃节点重连一遍。
   */
  private async relinkIsolatedGraphNodes(actorIds?: string[]): Promise<void> {
    const relinker = this.graphRelinker;
    if (!relinker) return;
    for (const actorId of actorIds ?? this.getAllActorIds()) {
      try {
        const stats = await relinker(actorId, GRAPH_RELINK_LIMIT);
        if (stats.relinked > 0) {
          console.log(
            `[NightlyMemory] 孤立节点重连: actor=${actorId} 重连=${stats.relinked}` +
              (stats.remaining > 0 ? ` 待收敛=${stats.remaining}` : ""),
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] 孤立节点重连失败（跳过该 actor） ${actorId}:`, err);
      }
    }
  }

  /** 注入孤立节点重连口（HumanLikeMemoryService）。 */
  setGraphRelinker(relinker: GraphRelinker | null): void {
    this.graphRelinker = relinker;
  }

  private graphRelinker: GraphRelinker | null = null;

  /**
   * 注入画像批抽取口（T2，2026-10-22 三层写入调度）。缺省用
   * profile-write-scheduler 的默认实现（UserProfileAggregator 唯一写入路径）。
   * 测试注入 fake 以断言 WAL 候选消费与 checkpoint 语义。
   */
  setProfileConsolidator(
    fn: ((actorId: string) => Promise<ProfileConsolidationStats>) | null,
  ): void {
    this.profileConsolidator = fn;
  }

  private profileConsolidator:
    | ((actorId: string) => Promise<ProfileConsolidationStats>)
    | null = null;

  /**
   * 画像批抽取（每 actor 每晚最多 1 次 LLM）：读 turn-wal 自 checkpoint 以来的
   * 轮次（候选优先，预算内非候选补位）→ 批量 extractUnified → 确定性落位 →
   * 推进 checkpoint。自 checkpoint 起没有新轮次才零成本跳过。
   */
  private async consolidateUserProfiles(actorIds?: string[]): Promise<void> {
    const consolidate = this.profileConsolidator ?? getDefaultProfileConsolidator();
    for (const actorId of actorIds ?? this.getAllActorIds()) {
      try {
        const s = await consolidate(actorId);
        if (s.processed > 0 || s.topUpProcessed > 0) {
          console.log(
            `[NightlyMemory] 画像批抽取: actor=${actorId} 候选=${s.candidates} 处理=${s.processed} ` +
              `补位=${s.topUpProcessed} ops=${s.opsCount} 旁路产物=${s.sideChannels} ` +
              `applied=${s.applied} checkpoint=${s.checkpointAdvanced ? "已推进" : "未推进"}` +
              (s.extractionFailed ? "（抽取失败，下晚重试）" : ""),
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] 画像批抽取失败（跳过该 actor） ${actorId}:`, err);
      }
    }
  }

  /**
   * 夜间事实提炼（巩固管线 episodic → semantic）：
   * 在 journal 固化前，把当日（含跨天补跑）对话日志一次性喂给 LLM，
   * 抽取"值得跨会话记住"的稳定偏好/事实/承诺，写入结构化记忆槽位
   * （AgentMemorySyncService.appendMemorySummaryLine 会按 subject/slot
   * 自动做 latest-wins 归并，旧值被新值替换而不是无限累积）。
   *
   * 设计要点：
   * - 单 actor 单次 LLM 批处理调用（替代逐条实时写入决策，便宜且质量更高）；
   * - 只处理有未固化 journal 行的 actor（buildNightlyTranscript 返回 null 直接跳过）；
   * - LLM 不可用 / 提炼失败 → 静默跳过该 actor，不影响后续固化与 dreaming；
   * - 行文本按 kind 加类型前缀，命中槽位分类正则后自动归入对应槽位。
   *
   * @returns 每个 actor 实际落库的事实条数（日志用）
   */
  private async extractFactsFromJournals(actorIds?: string[]): Promise<Map<string, number>> {
    const appliedCounts = new Map<string, number>();
    const journal = getDailyJournalService();
    if (!journal || !this.memorySync) return appliedCounts;
    const llm = resolvePrimaryLlmClientConfig();

    const metrics: NonNullable<NightlySleepAgentReport["extraction"]> = {
      llmCalls: 0,
      factsApplied: 0,
      commitmentsRouted: 0,
      conflictsResolved: 0,
      rejectedOps: 0,
      duplicates: 0,
      themes: 0,
    };
    this.lastExtractionMetrics = metrics;
    const ledger = this.compileLedger();
    const compile = { appliedOps: 0, duplicatedOps: 0, replayedRuns: 0 };
    this.lastCompileMetrics = compile;

    const targets = actorIds ?? this.getAllActorIds();
    for (const actorId of targets) {
      try {
        const built = await this.buildNightlyTranscript(journal, actorId);
        if (!built) continue;

        // 幂等水位：同一批日志（inputHash 相同）已完整抽取过 → 整段跳过，
        // 不再重复调用 LLM，也不会把同一条事实二次落库。
        const day = normalizeCompileDay(built.observedOn);
        const run = ledger.beginRun({
          actorId,
          day,
          stage: "extract",
          inputHash: compileRunInputHash(built.transcript),
        });
        if (run.replay) {
          compile.replayedRuns += 1;
          console.log(`[NightlyMemory] fact extraction 重放跳过: actor=${actorId} day=${day}`);
          continue;
        }

        let facts: NightlyExtractedFact[] = [];
        if (llm) {
          // M2：夜间唯一一次结构化 LLM 调用（facts + conflicts + themes 合并输出，
          // 每条带 evidence 行号；非法/无证据 op 丢弃）。
          const ops = await this.extractNightlyOps(llm, built.transcript);
          metrics.llmCalls += 1;
          metrics.rejectedOps += ops.rejected;
          metrics.themes += ops.themes;
          metrics.conflictsResolved += ops.conflicts.length;
          facts = [
            ...ops.facts,
            ...ops.conflicts.map((c) => ({ kind: c.kind, text: c.text })),
          ];
        }

        // M1-④：无 LLM / LLM 未产出时，用 journal 的 fact/prefer/commit 标签行
        // 确定性落库——不引入额外模型调用，保证夜间仍有事实增量。
        if (facts.length === 0) {
          const derived = deriveDeterministicFacts(built.transcript);
          metrics.duplicates += derived.duplicates;
          facts = derived.facts;
        }
        if (facts.length === 0) {
          ledger.finishRun(run.runId, { applied: 0, duplicated: 0 });
          ledger.advanceWatermark(actorId, day);
          continue;
        }

        // M4 去重：批内重复不再重复落库。
        const seen = new Set<string>();
        const unique: typeof facts = [];
        for (const fact of facts) {
          const key = `${fact.kind}|${normalizeFactText(fact.text)}`;
          if (seen.has(key)) {
            metrics.duplicates += 1;
            continue;
          }
          seen.add(key);
          unique.push(fact);
        }
        if (unique.length === 0) {
          ledger.finishRun(run.runId, { applied: 0, duplicated: 0 });
          ledger.advanceWatermark(actorId, day);
          continue;
        }

        const { canonical, commitments, duplicated } = await this.applyNightlyFacts(
          actorId,
          unique,
          day,
          ledger,
        );
        // 口径分离：承诺归 commitments 表，不进事实主库，也不算「事实已落库」。
        // 旧实现把两者相加计入 factsApplied，报告里的数字比真实落库事实高一倍。
        appliedCounts.set(actorId, canonical);
        metrics.factsApplied += canonical;
        metrics.commitmentsRouted += commitments;
        metrics.duplicates += duplicated;
        compile.appliedOps += canonical + commitments;
        compile.duplicatedOps += duplicated;
        ledger.finishRun(run.runId, {
          applied: canonical + commitments,
          duplicated,
        });
        ledger.advanceWatermark(actorId, day);
      } catch (err) {
        console.error(`[NightlyMemory] fact extraction failed for ${actorId}:`, err);
      }
    }
    return appliedCounts;
  }

  /**
   * 事实落库：**档案字段 → 权威库（structured_facts）**，其余 → 长尾事实库
   * （行式 JSON）；承诺/待办 → commitments 表（只统计，不写长期记忆）。
   *
   * 2026-11-13（词表统一）：此前夜间抽到的档案字段类事实（称呼/职业/居住地…）
   * 与对话内统一抽取**各存一份、字段名还不一样**（这里的 subject 是
   * 「身份/居住地/项目/配偶」，那边是标准档案字段）。同一件事两个口径，
   * 召回时自相矛盾。现在：
   *   - 模型给了标准字段（field+value）→ 直接落权威库，行式库不再存；
   *   - 没给但句式能认出来（"职业：后端开发"/"用户住在兴义"）→ 同样落权威库；
   *   - 认不准 → 留长尾事实库（宁可长尾，也不要把猜错的值写进权威库）。
   */
  private async applyNightlyFacts(
    actorId: string,
    facts: NightlyExtractedFact[],
    day: string,
    ledger: MemoryCompileLedger,
  ): Promise<{ canonical: number; commitments: number; profileRouted: number; duplicated: number }> {
    let canonical = 0;
    let commitments = 0;
    let profileRouted = 0;
    let duplicated = 0;
    for (const fact of facts) {
      const text = fact.text.trim().slice(0, 200);
      if (!text) continue;
      const normalized = normalizeFactText(text);
      if (fact.kind === "preference" || fact.kind === "fact") {
        // 档案字段优先：模型给的字段优先，认不出才从句式里兜底识别。
        const detected = fact.profile ?? detectProfileFieldFromText(text);
        if (detected) {
          const op: CompileOp = {
            actorId,
            day,
            stage: "extract",
            opType: "fact.profile",
            target: detected.field,
            value: detected.value,
          };
          if (ledger.hasOp(op)) {
            duplicated += 1;
            continue;
          }
          const applied = await this.applyProfileFact(actorId, detected.field, detected.value, text);
          if (applied) {
            ledger.markOp(op);
            profileRouted += 1;
            canonical += 1;
            continue; // 权威库已持有，不再往行式库存第二份
          }
        }
        // 稳定偏好/事实 → 长尾事实（structured_facts category=tail:<kind>）。
        // subject 归一 + latest-wins 与档案字段同规则；档案字段类已在上面
        // 被识别并落权威库，这里只剩认不出的长尾，不会顶掉档案字段值。
        const tailOp: CompileOp = {
          actorId,
          day,
          stage: "extract",
          opType: "fact.tail",
          target: normalized,
          value: text,
        };
        if (ledger.hasOp(tailOp)) {
          duplicated += 1;
          continue;
        }
        const structuredStore = await this.getStructuredFactStore();
        const tailWritten = structuredStore
          ? structuredStore.applyFact(
              {
                actorId,
                field: extractFactSubject(fact.kind, text),
                value: text,
                confidence: 0.7,
                sourceRef: "nightly-extract",
                category: tailCategoryFor(fact.kind),
              },
              "NightlyMemoryTaskService",
            ) !== null
          : false;
        if (!tailWritten) {
          // 降级：结构化事实库不可用（未启用/被拒）时才退回行式 JSON 库。
          await this.getFactStore().upsertFact(actorId, {
            kind: fact.kind,
            value: text,
            source: "nightly-extract",
            confidence: 0.7,
          });
        }
        ledger.markOp(tailOp);
        canonical += 1;
      } else {
        // 承诺/待办（时效性内容）：权威源是 commitments 表（状态机 + 截止时间）。
        // 白天 writeDecided 已把承诺写入 commitments 表，这里只统计数量，
        // 账本仍登记 op，避免同一批日志重复累加报告数字。
        const op: CompileOp = {
          actorId,
          day,
          stage: "extract",
          opType: "commitment.observed",
          target: normalized,
        };
        if (ledger.hasOp(op)) {
          duplicated += 1;
          continue;
        }
        ledger.markOp(op);
        commitments += 1;
      }
    }
    if (canonical > 0) {
      // 事实的权威 = structured_facts（档案字段）/ 长尾事实库（其余），
      // prompt 直接读事实档案块，不经 KV 槽位。
      console.log(
        `[NightlyMemory] 事实提炼: actor=${actorId} 主库 ${canonical} 条` +
          (profileRouted > 0 ? `（其中档案字段 ${profileRouted} 条走权威库）` : "") +
          `；承诺 ${commitments} 条归 commitments（不入长期记忆）`,
      );
    } else if (commitments > 0) {
      console.log(`[NightlyMemory] 事实提炼: actor=${actorId} 承诺 ${commitments} 条归 commitments`);
    }
    return { canonical, commitments, profileRouted, duplicated };
  }

  /**
   * 档案字段落权威库（structured_facts）。
   *
   * 置信度给 0.55（低于 0.6 的「低置信」阈值）——夜间抽取是批量猜测，
   * 提示层会把它标成〔置信度低〕，模型转述时不会把话说满。
   * 返回是否真的落库（没有 factStore 时返回 false，调用方退回长尾事实库）。
   */
  private async applyProfileFact(
    actorId: string,
    field: string,
    value: string,
    sourceText: string,
  ): Promise<boolean> {
    try {
      const factStore = await this.getStructuredFactStore();
      if (!factStore) return false;
      const result = factStore.applyFact(
        {
          actorId,
          field,
          value,
          sourceRef: `nightly:${sourceText.slice(0, 60)}`,
          confidence: 0.55,
        },
        "NightlyMemoryTaskService",
      );
      return !!result;
    } catch (err) {
      console.warn("[NightlyMemory] 档案字段落权威库失败（退回长尾事实库）:", err);
      return false;
    }
  }

  /**
   * M2：单次结构化夜间 LLM 调用。
   *
   * 一次输出 facts + conflicts + themes，每条 op 必须带 evidence 行号
   * （对应下方带 #n 前缀的日志行）。证据缺失/越界/类型非法的 op 直接丢弃，
   * 避免模型凭空生成记忆。超长一天由 buildNightlyTranscript 的尾部截断做
   * 确定性压缩（最多 120 行 / 12k 字符），只有超长且仍有高信号时才允许补调一次。
   */
  private async extractNightlyOps(
    llm: { apiKey: string; baseURL?: string; model?: string },
    transcript: string,
  ):
    Promise<{
      facts: NightlyExtractedFact[];
      conflicts: Array<{ kind: "preference" | "fact"; text: string }>;
      themes: number;
      rejected: number;
    }> {
    const empty = { facts: [], conflicts: [], themes: 0, rejected: 0 };
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
    const model =
      process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || llm.model || "gpt-4.1-mini";
    const lines = transcript.split("\n");
    const numbered = lines.map((line, i) => `#${i + 1} ${line}`).join("\n").slice(0, 12_000);
    const maxEvidenceId = lines.length;
    try {
      const durableSystem =
        "你是记忆巩固器。从对话日志中提取「值得跨会话长期记住」的用户信息，忽略闲聊、临时上下文和一次性任务细节。" +
        "每条日志行以 #n 标注行号。只输出 JSON：" +
        '{"facts":[{"kind":"preference|fact|commitment","text":"...","field":"称呼|职业|居住地|技术栈|生日|公司|学历","value":"短值","evidence":[n]}],' +
        '"conflicts":[{"kind":"preference|fact","text":"...","evidence":[n]}],' +
        "\"themes\":[{\"text\":\"...\",\"evidence\":[n]}]}，facts 最多 12 条。" +
        "evidence 必须是实际支撑该条目的日志行号；没有证据的条目一律不要输出。" +
        "规则：preference=稳定偏好/习惯（text 需含「喜欢/偏好/讨厌/习惯」等词）；" +
        "fact=稳定身份/背景事实（text 以「用户」开头或用无主语短语，如「用户住在兴义」「职业：后端开发」）；" +
        "commitment=需要后续跟进的承诺或待办（text 需含「我会/我将/计划/待办」等词）；" +
        "conflicts=与已知长期记忆矛盾的新陈述（取新值，系统按「显式纠正>新近>置信度>证据数」裁决）。" +
        "【档案字段】称呼/职业/居住地/技术栈/生日/公司/学历 这类字段有专属权威库，" +
        "遇到时除 text 外必须额外输出 field（上述标准字段名之一）与 value（≤12 字、无主语的短值，" +
        "如 value=兴义）；不属于这七类的条目不要输出 field/value 两个键。" +
        "习惯纪律：单日/单次观察到的行为不得写成 preference 或带「习惯/总是/每天」字样的 fact；" +
        "设提醒/定闹钟≠事件已发生：「用户定了9点闹钟」不能推出「用户9点起床」，更不能推出作息习惯；" +
        "一次性事务（比价、下单、当次安排）不提取为 fact/preference。" +
        "归属铁律：日志行 [日期 时间 A] 是助手发言、[日期 时间 U] 才是用户自述；助手话里的「你」指用户、「我」指助手。" +
        "「喊你X/叫你X/以后喊你X」是助手对用户的称呼（方向 Agent→用户），只能写成「用户希望被称作「X」」，" +
        "绝不能写成「用户把助手称作X」或「用户称呼助手为X」；只有 U/fact/prefer 行可作为用户事实的证据。" +
        "text 用第三人称中文短句（以「用户」开头或无主语短语），禁止以「我/我的」开头。" +
        '没有可提取内容时返回 {"facts":[]}。';
      const response = await openai.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: durableSystem },
          { role: "user", content: numbered },
        ],
        ...bypassChatRequestExtras(),
      });
      auditChatCompletion({
        stage: "nightly_task",
        messages: [
          { role: "system", content: durableSystem },
          { role: "user", content: numbered },
        ],
        completion: response,
        model,
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return empty;

      const parsed = JSON.parse(content) as {
        facts?: Array<{
          kind?: string;
          text?: string;
          field?: unknown;
          value?: unknown;
          evidence?: unknown;
        }>;
        conflicts?: Array<{ kind?: string; text?: string; evidence?: unknown }>;
        themes?: Array<{ text?: string; evidence?: unknown }>;
      };

      let rejected = 0;
      const validKind = (k: unknown, allowed: string[]): k is string =>
        typeof k === "string" && allowed.includes(k);
      const hasEvidence = (evidence: unknown): boolean =>
        Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every(
          (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= maxEvidenceId,
        );

      const facts: NightlyExtractedFact[] = [];
      for (const f of parsed.facts ?? []) {
        if (
          f &&
          typeof f.text === "string" &&
          f.text.trim() &&
          !isReverseAddressClaim(f.text) &&
          validKind(f.kind, ["preference", "fact", "commitment"]) &&
          hasEvidence(f.evidence)
        ) {
          facts.push({
            kind: f.kind as "preference" | "fact" | "commitment",
            text: f.text.trim(),
            // 档案字段（2026-11-13 词表统一）：模型给的 field/value 必须能归一到
            // 标准档案字段、值得像短值，否则一律视为「没给」。
            ...(normalizeDetectedProfileFact(f.field, f.value)
              ? { profile: normalizeDetectedProfileFact(f.field, f.value)! }
              : {}),
          });
        } else {
          rejected += 1;
        }
      }

      const conflicts: Array<{ kind: "preference" | "fact"; text: string }> = [];
      for (const c of parsed.conflicts ?? []) {
        if (
          c &&
          typeof c.text === "string" &&
          c.text.trim() &&
          !isReverseAddressClaim(c.text) &&
          validKind(c.kind, ["preference", "fact"]) &&
          hasEvidence(c.evidence)
        ) {
          conflicts.push({ kind: c.kind as "preference" | "fact", text: c.text.trim() });
        } else {
          rejected += 1;
        }
      }

      let themes = 0;
      for (const t of parsed.themes ?? []) {
        if (t && typeof t.text === "string" && t.text.trim() && hasEvidence(t.evidence)) themes += 1;
        else rejected += 1;
      }

      return { facts: facts.slice(0, 12), conflicts, themes, rejected };
    } catch (err) {
      console.log(`[NightlyMemory] extractNightlyOps LLM 调用失败（降级为确定性兜底）: ${err}`);
      return empty;
    }
  }

  /**
   * 夜间记忆巩固（确定性，零 LLM）。
   *
   * 留存评分改由 memory-manager 的时间衰减/信号正则计算；画像是对话内
   * upsert 维护的，这里不再触发整文重写。因此即使遍历全部历史 actor，
   * 也只是本地计算，不再产生 LLM 调用。
   */
  private async runDreamPhase(actorIds?: string[]): Promise<{
    recaps: number;
    questionsClosed: number;
    decay: { scanned: number; decayed: number; pruned: number };
  }> {
    // ⑥ 巩固流水线：与 dreaming 同一入口、一次跑完（日结回顾 + 关闭悬空问句），
    // 之后才进入 cleanup → merge → reinforce → weaken 睡眠阶段。
    const pipeline = await this.runConsolidationPipeline(actorIds);

    const targets = (actorIds ?? this.getAllActorIds()).slice(
      0,
      this.config.consolidationBatchSize,
    );
    if (targets.length === 0) return pipeline;

    console.log(
      `[NightlyMemory] Sleep agent phase: cleanup -> merge -> reinforce -> weaken for ${targets.length} actors`,
    );

    // memory_summary 巩固已在 journal 固化前由 consolidateSummaries 完成；
    // 这里只跑长期记忆图的确定性睡眠阶段（cleanup/merge/promote/weaken）。
    const sleepReports = this.narrativeMemory
      ? await this.narrativeMemory.runSleepConsolidation(targets).catch((err) => {
          console.error("[NightlyMemory] Human-like sleep consolidation failed:", err);
          return null;
        })
      : null;
    const hasSleepReports = Array.isArray(sleepReports) && sleepReports.length > 0;
    if (hasSleepReports || this.lastJournalFixation || this.lastCompileMetrics) {
      await this.recordSleepAgentReport(targets, hasSleepReports ? sleepReports : [], this.lastJournalFixation);
    }
    return pipeline;
  }

  private async recordSleepAgentReport(
    actorIds: string[],
    reports: Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>,
    journalFixation: NightlySleepAgentReport["journalFixation"] | null = null,
  ): Promise<void> {
    const payload: NightlySleepAgentReport = {
      runAt: new Date().toISOString(),
      actorIds,
      ...(journalFixation ? { journalFixation } : {}),
      ...(this.lastExtractionMetrics ? { extraction: { ...this.lastExtractionMetrics } } : {}),
      ...(this.lastCompileMetrics ? { compile: { ...this.lastCompileMetrics } } : {}),
      reports,
    };
    this.latestReport = payload;
    this.recentReports.unshift(payload);
    this.recentReports = this.recentReports.slice(0, 30);

    try {
      await writeJsonAtomic(this.reportFilePath, this.recentReports);
    } catch (err) {
      console.error("[NightlyMemory] Failed to persist sleep agent report:", err);
    }
  }

  /**
   * 存量清理（2026-11-13 起仅为一次性存量清除）：
   * `data/long-term-memory/` 已无写者——「长期归档同步」步骤随 syncToLongTermStorage
   * 一并删除（该目录内容与 KV memory_summary 逐字节相同，只是同一份数据的第二个副本）。
   * 这里只负责把升级前遗留的旧文件按 30 天 TTL 清掉，之后该目录不再产生新文件。
   */
  private async cleanupOldStorage(): Promise<void> {
    try {
      const prunedOps = this.compileLedger().prune();
      if (prunedOps > 0) {
        console.log(`[NightlyMemory] 编译账本裁剪: ${prunedOps} 条过期 op`);
      }
    } catch (err) {
      console.log(`[NightlyMemory] 编译账本裁剪失败（忽略）: ${err}`);
    }
    // 清理过期的长期存储归档（升级前存量；保留近期文件以免误删刚升级的数据）
    try {
      const longTermDir = join(getDataDir(), "long-term-memory");
      let files: string[] = [];
      try {
        files = readdirSync(longTermDir);
      } catch {
        return; // 目录不存在则跳过
      }
      const now = Date.now();
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
      let cleanedCount = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(longTermDir, file);
        try {
          const stat = statSync(filePath);
          if (now - stat.mtimeMs > MAX_AGE_MS) {
            unlinkSync(filePath);
            cleanedCount++;
          }
        } catch {
          // 单文件清理失败不阻塞
        }
      }
      if (cleanedCount > 0) {
        console.log(`[NightlyMemory] Cleanup: removed ${cleanedCount} expired long-term archive files`);
      }
    } catch (err) {
      console.log(`[NightlyMemory] cleanupOldStorage 失败: ${err}`);
    }
  }

  private checkMidnightRollover(): void {
    // per-actor 水位线按「当天 key」比较，跨天自然失配并重新触发；
    // 这里只裁掉长期不再活跃 actor 的旧记录，避免 Map 无限增长。
    const today = this.getTodayKey();
    for (const [actorId, day] of this.lastProcessedDayByActor) {
      if (day !== today) this.lastProcessedDayByActor.delete(actorId);
    }
  }

  private getAllActorIds(): string[] {
    const actorIds = new Set<string>();
    for (const actorId of this.memorySync?.listSessionIds?.() ?? []) {
      if (actorId && actorId !== "system") actorIds.add(actorId);
    }
    // journal 目录兜底：digest 依赖移除后，用当日/历史 journal 目录补充 actor 列表
    for (const actorId of getDailyJournalService()?.listActorIds?.() ?? []) {
      if (actorId) actorIds.add(actorId);
    }
    return [...actorIds];
  }

  private getTodayKey(): string {
    return this.formatDateKey(new Date());
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    if (this.isNightMode) {
      console.log("[NightlyMemory] Shutdown in night mode, running final tasks...");
      await this.forceRunNightTasks();
    }
  }
}

let singleton: NightlyMemoryTaskService | null = null;

export function getNightlyMemoryTaskService(): NightlyMemoryTaskService | null {
  return singleton;
}

export function initNightlyMemoryTaskService(
  config?: Partial<NightModeConfig>,
): NightlyMemoryTaskService | null {
  const cfg = loadNightConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new NightlyMemoryTaskService(config);
  return singleton;
}
