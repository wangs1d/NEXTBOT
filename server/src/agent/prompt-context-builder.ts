import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { getMemoryComponents } from "../agentic-memory/index.js";
import { CAPABILITY_DOMAINS, type CapabilityDomain } from "./agent-capabilities.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  buildCurrentTimePrompt,
  formatKvValueForPrompt,
  formatPersonalityCorePrompt,
  sliceMemoryEntriesToPromptContext,
} from "./prompt-builder.js";
import { buildTaskContextPrompt } from "./task-context.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import { SKILL_MANAGE_CHAT_TOOLS } from "../tools/skill-manage-tools.js";
import type { SkillManager } from "../skills/index.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import {
  AGENT_NAME_KV_KEY,
  buildIdentityNameLine,
  parseAgentIdentityKv,
} from "../services/agent-identity.js";
import {
  buildSchedulePromptSnapshot,
} from "../services/schedule-prompt-snapshot.js";
import {
  buildTravelStatePrompt,
} from "../services/travel-prompt-snapshot.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getConversationTimelineService } from "../services/conversation-timeline.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { getMemoryManagerService } from "../services/memory-manager-service.js";
import { getGlobalMemoryInventory } from "../brain/memory-inventory.js";
import { shouldRecallLongTerm } from "./recall-gate.js";
import type { TurnUnderstanding } from "./task-router.js";
import type { PersonalityCore } from "../brain/types.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ToolLoopAfterBatchInfo,
} from "../external-model/types.js";
import type { PersonalizationPromptSlice } from "../services/user-personalization/user-personalization-service.js";
import { dedupeMemoryLines, semanticFingerprint, contentTokenSet, tokenOverlapRatio } from "../services/memory-record-utils.js";
import { markInjectedMemory } from "../services/memory-echo-guard.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import type { FeatureCatalog } from "../catalog/index.js";
import { redactSensitiveText } from "../utils/redact.js";

const WORLD_CACHE_TTL_MS = 5_000;

/**
 * 追问锚点块（2026-10-10 语义化重写）：由模型判定的 reference 驱动。
 * 只说清「承接对象」帮指代对齐，不携带推进旧任务的压力——原「FU|anchor=...」
 * 密文 + 词表判定（把「你叫我什么？」误判成追问轮锚到上一条旅游回复）已退役。
 */
function buildFollowUpAnchorFromUnderstanding(
  understanding?: TurnUnderstanding,
): string | undefined {
  if (!understanding || understanding.reference === "none") return undefined;
  const target =
    understanding.reference === "prev_assistant"
      ? "你（Agent）上一条回复"
      : understanding.reference === "prev_user_request"
        ? "用户自己上一条请求"
        : "更早的对话/长期记忆";
  return [
    `【追问锚点】模型判定：用户这句话在承接${target}。`,
    "- 回应本句前先对齐承接对象（它指什么、哪个方案、哪个对象），别答成新话题；",
    "- 若用户本句实际开启了新话题，直接回应新话题，绝不把旧话题硬扯进来；",
    "- 锚点只影响指代消解，不构成继续旧任务的承诺。",
  ].join("\n");
}

/**
 * STM 会话情景记忆 与 journal 当日日志检索 双轨去重（P0-3）。
 * 同一批"今天早些时候的对话"可能同时出现在 STM（延续/指代轮注入原文，保真度高）
 * 与 journal 命中里。过滤掉与 STM 上下文词法重叠 ≥ 0.7 的 journal 行，
 * 只保留 STM 没覆盖的（跨 session / 更早时间段）行，防止同一内容双份注入导致重复/串台。
 * 无法解析的裸行（非 "[time role] content" 格式）原样保留。
 */
function dedupeJournalVsStm(journalRecall?: string, stmContext?: string): string | undefined {
  if (!journalRecall || !stmContext) return journalRecall;

  const stmTokens = contentTokenSet(stmContext);
  const kept: string[] = [];
  for (const line of journalRecall.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    // journal 行格式为 "[标签 时间·角色] 内容"，取第一个 ] 之后作为内容做词汇重叠比对
    const content = t.startsWith("[") ? t.slice(t.indexOf("]") + 1).trim() : t;
    if (!content) {
      kept.push(line);
      continue;
    }
    const overlap = tokenOverlapRatio(contentTokenSet(content), stmTokens);
    if (overlap < 0.7) {
      kept.push(line);
    }
  }
  return kept.length > 0 ? kept.join("\n") : undefined;
}

/**
 * 从 `userLocation` 注入串（如「…，时区 Asia/Shanghai。…」）提取用户 IANA 时区。
 * 抽不出则返回 undefined，调用方回退到服务器进程时区。
 */
function extractUserTimezoneFromLocation(userLocation?: string): string | undefined {
  if (!userLocation) return undefined;
  const m = userLocation.match(/时区\s+([A-Za-z]+(?:\/[A-Za-z0-9_+.-]+)*)/);
  return m?.[1]?.trim() || undefined;
}

/**
 * 【运行环境】块（2026-10-07）：用户此刻从哪类设备发消息（WS 连接自报 platform）。
 * 手机端=小屏移动场景：回复短、别发大段排版/表格；但**不**因为人在手机旁就放弃
 * 电脑远控——手机上同样能调 desktop.* 工具代用户操作他那台已配对的电脑
 * （2026-10-09 改：原句「涉及电脑端才能做的事就直说稍后在电脑上办」会压制远控，
 * 用户人在外面正是最需要手机遥控电脑的时候）。
 * 电脑端=桌面场景：可正常交付卡片/多段内容。缺省（未登记/旧客户端/程序化调用）
 * 不注入——模型按对话语境自行判断，避免错误标注。
 */
export function buildDeviceEnvironmentBlock(
  deviceClass?: "desktop" | "mobile",
): string | undefined {
  if (deviceClass === "mobile") {
    return (
      "【运行环境】用户此刻在手机 App 上和你对话（小屏、可能不在电脑前）。" +
      "回复保持口语短句，不写长文/表格/多级列表。" +
      "涉及电脑才能做的事，别让用户自己去电脑上点——你具备电脑远控能力，可直接调用 " +
      "desktop.* 工具（如 desktop.visual.screenshot 截图、desktop.open 打开程序/网页/文件、" +
      "desktop.uia_query 看界面元素、desktop.run_input 键鼠操作、desktop.run_automation 控件操作、" +
      "desktop.window 切窗口、desktop.clipboard 剪贴板）在用户那台已配对的电脑上代他执行。" +
      "只有确实需要用户本人站到电脑前动手（插拔设备、物理接触等）时才让他过去；" +
      "那台电脑未在线或未配对时直说没连上，不要假装已经办了。"
    );
  }
  if (deviceClass === "desktop") {
    return "【运行环境】用户此刻在电脑桌面端和你对话，可以正常交付结构化内容与卡片。";
  }
  return undefined;
}

/**
 * 人格层能力自述块。
 *
 * 能力总览不再手写枚举（手写必然过时——agent 会照着旧清单否认自己其实有的能力，
 * 如「邮箱接不进来」事故），而是从 FeatureCatalog（启动时汇聚真实工具注册表/skill/
 * MCP 自动生成）派生：项目新增能力注册即自动出现在这里，无需改任何 prompt。
 */
function buildCompactAgentCapsPrompt(featureCatalog?: FeatureCatalog | null): string {
  const lines: string[] = [];
  if (featureCatalog) {
    lines.push(...featureCatalog.toPromptLines());
  } else {
    lines.push(
      "【能力概览】你是主 Agent，可直接处理日常对话，并按需调用时间、天气、搜索、日程、钱包、社交与 Agent World 相关工具。",
    );
  }
  lines.push(
    "【调度原则】简单问题直接回答；需要实时信息时先查再答；复杂或多步骤任务交给后台任务执行流程处理。",
    "【执行约束】涉及消费、转账、桌面高权限操作或状态敏感任务时，必须先读取对应工具返回的实时状态，不凭记忆假设。",
    "【真人感·行动宣告】本轮要调信息型/动作型工具（搜索、查日程、查余额、下单、派后台任务等）时，先用一句口语化的短话告诉用户你要去做什么（如「我先搜一下…」「我看下今天的日程…」），只说这一句就立刻调用工具——不要在调用工具之前展开思考、分析、列计划或自我讨论，那些内容一律不要写给用户；然后在同一回合基于真实返回回答，不要只宣告不行动。若声明要办某事却无法实际执行，务必明确告诉用户办不到，禁止用「我去查/稍后告诉你」这类空口承诺替代真实结果。档案/记忆类写入（profile.update、interest.manage 等）静默执行，不需要宣告，也不需要向用户交代写入过程。",
    "以上能力总览来自真实装配的工具注册表——没列出的能力可先用 agent.query_capabilities 查询确认，不要凭印象断言自己没有某能力。",
  );
  return lines.join("\n");
}

const WORLD_DOMAIN_RULES: Array<{ domains: CapabilityDomain[]; pattern: RegExp }> = [
  { domains: ["world"], pattern: /agent world|world\.|free_market|open_registry|世界点数|点数|技能商店|注册|市场/i },
  { domains: ["social_feed", "world"], pattern: /社交|推文|帖子|动态|评论|点赞|social/i },
  { domains: ["aip", "world"], pattern: /aip|提案|协议|联盟|投票/i },
];

interface WorldCacheEntry {
  data: {
    registered: boolean;
    credits: number;
    ownedSkillIds: string[];
  };
  at: number;
}

const worldCacheByActor = new Map<string, WorldCacheEntry>();

function getCachedWorldState(worldService: WorldService, actorId: string): WorldCacheEntry["data"] {
  const now = Date.now();
  const cached = worldCacheByActor.get(actorId);
  if (cached && now - cached.at < WORLD_CACHE_TTL_MS) {
    return cached.data;
  }
  const state = worldService.getOrCreateRoom(actorId, actorId);
  const data = {
    // 有效注册：世界挑战注册 或 宿主已注册账号（另一处登录不重走注册）
    registered: worldService.isAgentWorldRegistered(actorId),
    credits: state.agentWorldCredits,
    ownedSkillIds: state.ownedSkillIds,
  };
  worldCacheByActor.set(actorId, { data, at: now });
  return data;
}

function detectRelevantCapabilityDomains(userText: string | undefined): CapabilityDomain[] {
  const text = userText?.trim() ?? "";
  if (!text) return [];
  const detected = new Set<CapabilityDomain>();
  for (const rule of WORLD_DOMAIN_RULES) {
    if (!rule.pattern.test(text)) continue;
    for (const domain of rule.domains) {
      if (domain !== "all") detected.add(domain);
    }
  }
  return [...detected];
}

function compactPromptBlock(
  text: string | undefined,
  maxChars: number,
  importance?: "high" | "normal" | "low",
  preserve?: "head" | "tail" | "both",
): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  // Phase 6.2：低重要性内容压缩更激进（取 70% 上限），高价值保持原值。
  // 用于 lifeThemeMemory 等"背景性"上下文，不损失主对话能力。
  const effectiveLimit =
    importance === "low"
      ? Math.floor(maxChars * 0.7)
      : importance === "high"
        ? maxChars
        : maxChars;
  if (trimmed.length <= effectiveLimit) return trimmed;
  // Phase 6.2 修正：支持首尾保留模式，避免单纯截断丢失末尾关键内容。
  // dreamMemory 等跨会话整理结果用 "both"：保留开场（最近在意的）+ 末尾（核心主题/淡忘），
  // 中间被省略号替换，保持记忆连续性。
  if (preserve === "both") {
    const headLen = Math.floor(effectiveLimit * 0.6);
    const tailLen = Math.max(0, effectiveLimit - headLen - 6);
    const head = trimmed.slice(0, headLen).trimEnd();
    const tail = trimmed.slice(trimmed.length - tailLen).trimStart();
    return `${head}\n...[省略中间]...\n${tail}`;
  }
  if (preserve === "tail") {
    const tailLen = effectiveLimit - 3;
    return `...${trimmed.slice(trimmed.length - tailLen).trimStart()}`;
  }
  // default "head"
  return `${trimmed.slice(0, Math.max(0, effectiveLimit - 3)).trimEnd()}...`;
}

function compactSchemaField(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/**
 * 文件画像 + memoryManager 派生摘要合并（2026-09-29 互斥改合并）：
 * 文件画像（LLM 抽取的当前事实）为主位；派生摘要与画像不重复的行追加在后。
 * 产物进稳定层【用户长期画像】，吃 prefix cache——画像只在真变更时断一次缓存。
 */
export function mergeUserProfilePromptSources(
  fileProfile: string | undefined,
  managerSummary: string | undefined,
): string | undefined {
  if (!fileProfile) return managerSummary;
  if (!managerSummary) return fileProfile;
  const fileLines = new Set(
    fileProfile
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const extraLines = managerSummary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !fileLines.has(l));
  return extraLines.length > 0 ? `${fileProfile}\n${extraLines.join("\n")}` : fileProfile;
}

function splitPromptLines(block: string | undefined): string[] {
  return (block ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupePromptBlock(block: string | undefined, existingFingerprints: Set<string>): string | undefined {
  if (!block) return undefined;
  const lines = dedupeMemoryLines(splitPromptLines(block), { preferLatest: false });
  const kept = lines.filter((line) => {
    const fp = semanticFingerprint(line) || line;
    if (existingFingerprints.has(fp)) return false;
    existingFingerprints.add(fp);
    return true;
  });
  return kept.length > 0 ? kept.join("\n") : undefined;
}

/**
 * 本轮寻址块（2026-09-29 P0-1 缓存优化）：用户最新消息命中的理解话题/事实
 * 字段清单，沉底注入动态层。等价承接旧版「← 本轮提问相关，基于此回答」的
 * 逐条寻址标记——标记原在稳定层逐行移动，每轮改变稳定层字节，打断 DeepSeek
 * 前缀缓存（实测改一行命中 98%→27%）。无命中返回 undefined 零注入。
 */
export function formatTurnAddressingBlock(
  matchedTopics: string[],
  matchedFields: string[],
): string | undefined {
  const topics = [...new Set(matchedTopics.filter(Boolean))].slice(0, 6);
  const fields = [...new Set(matchedFields.filter(Boolean))].slice(0, 6);
  if (topics.length === 0 && fields.length === 0) return undefined;
  const lines: string[] = [
    "【本轮寻址】",
    "（本轮用户消息涉及以下档案条目，回答对应问题时直接引用其当前值）",
  ];
  if (topics.length > 0) lines.push(`- 理解话题：${topics.join("、")}`);
  if (fields.length > 0) lines.push(`- 事实字段：${fields.join("、")}`);
  return lines.join("\n");
}

export function formatNarrativeRecallPrompt(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;

  const rawLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const items: string[] = [];
  for (const line of rawLines) {
    if (items.length >= 6) break;

    // 跳过系统头/任务复述/说明行（非用户记忆内容）
    if (
      /^(记忆重构结果|当前任务|以下内容为|以下为与|以下为|Mem0|记忆图联想|长期叙事|履历摘录|【)/i.test(line)
    ) {
      continue;
    }

    // 提取真实记忆正文：支持 reconstructRecall 事实行 / 长期叙事摘录编号行 / 普通行
    let content = line;
    const numbered = line.match(/^\d+\.\s*\[[^\]]+\]\s*(.+)$/);
    const bracketNum = line.match(/^\[\d+\]\s*(.+)$/);
    if (numbered?.[1]) content = numbered[1];
    else if (bracketNum?.[1]) content = bracketNum[1];

    // HumanLike 图会记录 HermesLoop 对话节点；它们对"上次聊了什么/最后说了什么"很关键，
    // 不能整条过滤。先把日志壳转成可读对话记忆，再进入 prompt。
    let conversationLogLine = content;
    if (content.startsWith('{"line":')) {
      try {
        const parsed = JSON.parse(content) as { line?: unknown };
        if (typeof parsed.line === "string") {
          conversationLogLine = parsed.line;
        }
      } catch {
        /* keep raw content */
      }
    }
    const directAssistantDone = conversationLogLine.match(
      /^(?:HermesLoop|EvolutionLoop): assistantDone user="(.+?)" reply="(.+?)"$/i,
    );
    if (directAssistantDone?.[1] && directAssistantDone?.[2]) {
      content = `对话记录：用户说「${directAssistantDone[1]}」，Agent 回复「${directAssistantDone[2]}」`;
    }

    // 过滤无信息量的工具日志 / 时间戳（保留已转换的 assistantDone 对话节点）
    if (content.length < 2) continue;
    if (
      /^\[ts:|^Tool interaction (succeeded|failed)|^\{"line":"(?:HermesLoop|EvolutionLoop): toolBatch/i.test(content)
    ) {
      continue;
    }

    items.push(compactSchemaField(content, 200));
  }

  if (items.length === 0) return undefined;

  return [`NR|hits=${items.length}`, ...items.map((item, index) => `- r${index + 1}|${item}`)].join(
    "\n",
  );
}

export type BuildPromptContextInput = {
  actorId: string;
  sessionId?: string;
  userText?: string;
  narrativeRecall?: string;
  interruptedContext?: string;
  userLocation?: string;
  /** 常去地点背景块（DBSCAN 纯算法挖掘，agent-core 传入，零 LLM） */
  frequentPlaces?: string;
  /**
   * 发送消息的设备类别（2026-10-07）：desktop | mobile。WS 连接自报，
   * 注入【运行环境】块让模型感知手机/电脑（手机端短回复、不引导桌面操作）。
   * 缺省（程序化调用方/旧客户端）不注入。
   */
  deviceClass?: "desktop" | "mobile";
  personalization?: PersonalizationPromptSlice;
  /**
   * 当前 thread 非 system 消息数。用于长期快照注入门控（recall-gate）：
   * 新会话开场（thread ≤ 2）才注入 memoryContinuity / relationshipMemory /
   * lifeThemeMemory / dreamMemory / yesterdayHighlight 等长期快照块，
   * 普通轮次跳过（避免"昨天/前天的对话"每轮污染当前上下文——串台根治）。
   * 缺省 undefined 时快照门控退化为仅文本线索触发（保守，不误判新会话）。
   */
  threadMessageCount?: number;
  /**
   * #1 统一门控单点（串台根治）：由 agent-core 在决策层计算并透传——
   * 等于「召回未触发 ∥ topic_switch 抑制」。为 true 时，KV 长期字段
   * (memory_facts/preferences/commitments/open_loops/session_recap/
   * memory_current_mission/memory_summary) 与图谱 narrativeRecall 走同一
   * 白名单，话题切换时不注入任何跨会话长期记忆（persona 稳定人设除外）。
   */
  longTermRecallSuppressed?: boolean;
  /**
   * 向量预筛命中（P0-4）：agent-core 侧 regex 白名单未触发，但廉价向量检索
   * 判定当前话题与长期记忆强相关（top1 ≥ 阈值）。为 true 时与白名单命中等效，
   * 放行 KV 长期字段与图谱召回（topic_switch 抑制仍然优先）。
   */
  semanticRecallHit?: boolean;
  /**
   * recall-gate 白名单判定结果（门控单点化）：cognize 已用完整输入评估过，
   * agent-core 透传至此。提供时不再本地重评 shouldRecallLongTerm（消除
   * 多处独立评估的漂移空间）；缺省时保持本地评估（向后兼容其他调用方）。
   */
  recallGateTriggered?: boolean;
  /**
   * 本轮语义理解标记（2026-10-10 词表判定退役）：L1 路由 LLM 产出的追问锚定/
   * 记忆召回/日程/旅行等语境标记。追问锚点、scheduleSnapshot、travelState、
   * dailyDigest 抑制与各上下文块压缩档全部改读此处——缺省（路由失败）时一律
   * 按「无特殊处理」（最小注入）执行。
   */
  understanding?: TurnUnderstanding;
  /**
   * 当前工作记忆摘要（来自 WorkingMemoryCortex.toSummary）。
   * 作为独立块注入 system prompt，不再拼入 narrativeRecall，
   * 避免被 formatNarrativeRecallPrompt 的条目上限截断或块结构被拍平。
   */
  workingMemorySummary?: string;
  /**
   * 最近对话回顾（thread 较短时注入，用于指代消解）。
   * 仅在 thread 消息 < 12 条时填充（由 agent-core 做 dedup 判定）。
   * 作为独立块注入，"非用户最新指令"提示由 buildLayeredSystemPrompt 统一添加。
   */
  recentConversationHistory?: string;
  /**
   * 当日对话日志检索命中（DailyJournalService.searchToday 结果，短期记忆）。
   * 只扫当天；过往日期已固化进长期记忆图，跨天由图谱/KV 召回兜底。
   * 作为独立块注入——拼进 narrativeRecall 会被 formatNarrativeRecallPrompt
   * 的条目上限/免责头过滤/字符压缩拍平（workingMemorySummary 同款旧 bug）。
   * 与 STM 会话情景记忆是双轨（同一批对话两处都可能命中），组装端做指纹去重。
   */
  journalRecall?: string;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  /** 深度优化：用户画像（来自 OnlineLearningCortex），注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
  userPattern?: {
    topics: string[];
    preferredToolDomain?: string;
    negativeFeedbackCount: number;
    learningActive?: boolean;
  };
  /**
   * 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围。
   * complex 路由时由 ToolPlanningCortex.planTools 产出，让 LLM 按规划顺序调用工具，
   * 避免乱试或遗漏关键工具。
   */
  toolPlan?: {
    task: string;
    toolChain: Array<{ name: string; purpose: string; critical?: boolean }>;
    reasoning: string;
    estimatedTokens: number;
    estimatedCalls: number;
  };
  /**
   * 语义意图理解结果（LLM 解析）。注入 system prompt，让主 LLM 明确用户真实意图。
   */
  semanticIntent?: string;
  /**
   * 本轮车道（agent-core 路由结果）：顺嘴搭车块只允许进对话面（chat），
   * 任务面交付形态单一、旁注会污染结构化输出，故按车道门控。
   */
  plane?: string;
};

export type PromptContextLayers = {
  /** Stable prefix: identity, durable persona, values, and ability boundaries. */
  stable: AgentPromptMemoryContext;
  /** Session context: user/project state that can change across sessions but not every token. */
  context: AgentPromptMemoryContext;
  /** Turn-volatile context: time, recalls, task hints, emotion, and current tool plan. */
  volatile: AgentPromptMemoryContext;
};

function pickPromptContextLayers(memory: AgentPromptMemoryContext): PromptContextLayers {
  const stable: AgentPromptMemoryContext = {};
  const context: AgentPromptMemoryContext = {};
  const volatile: AgentPromptMemoryContext = {};

  for (const [key, value] of Object.entries(memory) as Array<
    [keyof AgentPromptMemoryContext, string | undefined]
  >) {
    if (!value) continue;
    if (
      key === "persona" ||
      key === "personalityCore" ||
      key === "values" ||
      key === "abilities" ||
      key === "agentCaps"
    ) {
      stable[key] = value;
    } else if (
      key === "worldCaps" ||
      key === "userProfile" ||
      key === "userProfileSummary" ||
      key === "memorySummary" ||
      key === "memoryPreferences" ||
      key === "memoryFacts" ||
      key === "memoryCommitments" ||
      key === "memoryOpenLoops" ||
      key === "sessionRecap" ||
      key === "relationshipGuidance" ||
      key === "relationshipMemory" ||
      key === "lifeThemeMemory" ||
      key === "dreamMemory" ||
      key === "memoryContinuity" ||
      key === "skillIndex"
    ) {
      context[key] = value;
    } else if (key === "replyStyleMode") {
      // 联合类型字段（"chat" | "task"），不能走下方 string 兜底
      volatile.replyStyleMode = value as AgentPromptMemoryContext["replyStyleMode"];
    } else {
      volatile[key] = value;
    }
  }

  return { stable, context, volatile };
}

function flattenPromptContextLayers(layers: PromptContextLayers): AgentPromptMemoryContext {
  return {
    ...layers.stable,
    ...layers.context,
    ...layers.volatile,
  };
}

export class PromptContextBuilder {
  constructor(
    private readonly deps: {
      agentMemorySyncService: AgentMemorySyncService | null;
      worldService: WorldService | null;
      skillManager: SkillManager | null;
      virtualPhoneService: VirtualPhoneService | null;
      scheduleTaskService?: ScheduleTaskService | null;
      shortTermMemoryGateway?: ShortTermMemoryGatewayService | null;
      featureCatalog?: FeatureCatalog | null;
    },
  ) {}

  private personalityProvider: ((actorId: string) => PersonalityCore | null) | null = null;

  /**
   * 用户兴趣关注列表拉取器（InterestWatcher.listForPrompt 的薄包装）。
   * 每轮 assembleMemory 拉取注入【用户兴趣关注列表】块：
   *  - 让 agent 知道用户在长期关注什么（话题接得住、聊得深）
   *  - 附工具引导：听到新的长期兴趣时调 interest.manage 记录
   * 无兴趣时返回 null（零注入）。
   */
  private interestListProvider: ((actorId: string) => string | null) | null = null;

  /**
   * 注入用户兴趣列表拉取器（InterestWatcher 接线；通常经 agent-core 转发）。
   * 无列表时不注入任何 prompt 块（零开销）。
   */
  setInterestListProvider(fn: ((actorId: string) => string | null) | null): void {
    this.interestListProvider = fn;
  }

  /**
   * 当下状态拉取器（WorldBoard.current 格式化，agent-core 转发注入）。
   * 每轮注入【当下状态】块：屏幕焦点/在线状态 + 顺嘴纪律锚点。
   * 无新鲜信号返回 null（零注入）。
   */
  private currentStateProvider: ((actorId: string) => string | null) | null = null;

  setCurrentStateProvider(fn: ((actorId: string) => string | null) | null): void {
    this.currentStateProvider = fn;
  }

  /**
   * 顺嘴机会拉取器（主动性搭车通道，agent-core 经 proactivityHub 转发注入）。
   * 返回即交付——每轮至多一条挂起意图；仅对话面调用（plane=chat 门控在
   * assembleMemory 内做）。provider 内部自带频控/TTL。
   */
  private turnAsideProvider: ((actorId: string) => string | null) | null = null;

  setTurnAsideProvider(fn: ((actorId: string) => string | null) | null): void {
    this.turnAsideProvider = fn;
  }

  /**
   * 注入人格内核拉取器（通常来自 BrainCenter.getPersonalityCore → MemoryCortex.getPersonalityCore）。
   * assembleMemory 会调用它获取结构化人格内核，格式化后填入 memory.personalityCore，
   * 由 buildLayeredSystemPrompt 注入 system prompt 稳定前缀的【人格内核】块，防止单次对话导致人格漂移。
   */
  setPersonalityProvider(fn: (actorId: string) => PersonalityCore | null): void {
    this.personalityProvider = fn;
  }

  build(input: BuildPromptContextInput): AgentStreamOptions | undefined {
    const layers = pickPromptContextLayers(this.assembleMemory(input));
    const memory = flattenPromptContextLayers(layers);
    // #7 记忆注入审计日志（诊断用，可 grep "mem-inject-audit"）：记录本轮实际注入了哪些
    // 记忆块、是否被统一门控抑制（topic_switch/未触发），便于定位每次"串台"由哪一块引起。
    if (memory) {
      const gated = input.longTermRecallSuppressed ? "suppressed" : "allowed";
      const injected = (Object.keys(memory) as (keyof AgentPromptMemoryContext)[])
        .filter((k) => memory[k] != null && memory[k] !== "")
        .join(",");
      console.log(`[mem-inject-audit] actor=${input.actorId} gate=${gated} injected=[${injected}]`);
    }
    const hasMemory = this.hasMemoryContent(memory);
    const chatToolsExtra = this.sessionSkillTools(input.actorId);
    const toolLoop =
      input.onToolLoopAfterBatch != null
        ? { onAfterToolBatch: input.onToolLoopAfterBatch }
        : undefined;

    if (!hasMemory && !toolLoop && (!chatToolsExtra || chatToolsExtra.length === 0)) {
      return undefined;
    }

    return {
      ...(hasMemory ? { promptContext: { memory } } : {}),
      ...(toolLoop ? { toolLoop } : {}),
      ...(chatToolsExtra?.length ? { chatToolsExtra } : {}),
    };
  }

  private assembleMemory(input: BuildPromptContextInput): AgentPromptMemoryContext {
    const config = getAgentRuntimeConfig();
    const userText = input.userText?.trim() ?? "";
    // 本轮语义理解标记（L1 路由产出）：追问/锚定/日程/旅行判定全部读此处，
    // 缺省（路由失败）按「无特殊处理」执行——误注入=串台，漏注入=少点可选上下文。
    // 命名区分：本变量是本轮路由语义；下方 `understanding` 是用户理解档案块（另一概念）。
    const turnUnderstanding = input.understanding;
    const followUpTurn = turnUnderstanding?.isFollowUp === true;
    const digestService = getDailyDigestService();
    const memoryManager = getMemoryManagerService();

    // 长期记忆注入门控（记忆架构重构，单一开关）：memoryContinuity / relationshipMemory /
    // lifeThemeMemory / dreamMemory / yesterdayHighlight / KV 长期字段这类"历史整理快照"
    // 每轮无条件注入是串台根因（昨天/前天的对话被当成当前上下文）。
    // 统一走 recall-gate 白名单：新会话开场（仅本 session 首条用户消息）/ 显式记忆线索 /
    // 个人事实陈述 / 长会话指代升级时才注入，且未被 topic_switch 抑制。
    // 未命中时只保留稳定人设（persona/values/abilities），长期记忆交给 brain.recall
    // 工具按需检索（结果以 tool 消息进上下文，身份隔离天然防串台）。
    const longTermEnabled =
      !input.longTermRecallSuppressed &&
      // 门控单点化：cognize 评估的判定结果直接复用；未透传时本地评估（兼容其他调用方）
      (input.recallGateTriggered ??
        shouldRecallLongTerm({
          text: userText,
          threadMessageCount: input.threadMessageCount,
          understanding: turnUnderstanding,
        }).trigger) ||
      input.semanticRecallHit === true;

    let fromKv: AgentPromptMemoryContext = {};
    const memoryKeys = config.memoryPrompt.promptMemoryKeys;
    if (
      this.deps.agentMemorySyncService &&
      memoryKeys &&
      memoryKeys.length > 0
    ) {
      // 拆人设/动态记忆：persona/values/abilities 属稳定人设 L3 人格层，始终注入；
      // 2026-10-06 治啰嗦 P1：v3 的「画像层常驻」收窄——memory_facts/preferences 与
      // 情节层同走召回门控（它们与结构化事实块/长期画像高度重叠，常驻注入就是
      // 「上下文里到处是可提及素材」的啰嗦来源）。恒驻速览由【用户档案·结构化事实】
      // 块承担（确定性字段：称呼/身份/稳定偏好）。
      const STABLE_MEMORY_KEYS = new Set(["persona", "values", "abilities"]);
      const PROFILE_MEMORY_KEYS = new Set(["memory_facts", "memory_preferences"]);
      const EPISODIC_MEMORY_KEYS = new Set([
        "memory_summary",
        "memory_current_mission",
        "memory_commitments",
        "memory_open_loops",
        "session_recap",
      ]);
      const snapshotKeys = memoryKeys.filter(
        (key) =>
          STABLE_MEMORY_KEYS.has(key) ||
          (longTermEnabled && (PROFILE_MEMORY_KEYS.has(key) || EPISODIC_MEMORY_KEYS.has(key))),
      );
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, snapshotKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries, userText || undefined);
      const kvCurrentMission = compactPromptBlock(formatKvValueForPrompt(entries["memory_current_mission"]), 240);
      if (kvCurrentMission) {
        fromKv.taskContext = [`current-mission-from-memory: ${kvCurrentMission}`].join("\n");
      }
    }

    // 名字自我认知：agent.update_identity 写入的 agent.name KV 不在 memoryKeys 配置内，
    // 这里定点拉取并拼进 persona 稳定前缀首行——让 Agent 每轮都知道自己叫什么、
    // 名字是谁取的。名字极低频变化，放稳定层不会打爆 prefix cache。
    if (this.deps.agentMemorySyncService) {
      const identityRaw = this.deps.agentMemorySyncService
        .getSnapshot(input.actorId, [AGENT_NAME_KV_KEY])
        .entries[AGENT_NAME_KV_KEY];
      const identity = parseAgentIdentityKv(identityRaw);
      if (identity) {
        const nameLine = buildIdentityNameLine(identity);
        fromKv.persona = fromKv.persona ? `${nameLine}\n${fromKv.persona}` : nameLine;
      }
    }

    const agentCaps =
      config.memoryPrompt.agentCapsInPrompt &&
      (this.deps.featureCatalog || this.deps.skillManager)
        ? buildCompactAgentCapsPrompt(this.deps.featureCatalog)
        : undefined;

    const relevantDomains = detectRelevantCapabilityDomains(userText);
    let worldCaps: string | undefined;
    if (
      this.deps.worldService &&
      config.memoryPrompt.worldCapsInPrompt &&
      relevantDomains.includes("world")
    ) {
      const ws = getCachedWorldState(this.deps.worldService, input.actorId);
      const ownedSkills = ws.ownedSkillIds.length ? ws.ownedSkillIds.join("、") : "（无）";
      worldCaps = [
        `【Agent World】注册：${ws.registered ? "已注册" : "未注册"}｜点数：${ws.credits}｜技能：${ownedSkills}`,
        "需要完整世界状态、商店、市场或 world.* 工具细节时，调用 agent.query_capabilities(domain='world')。",
      ].join("\n");
    }

    // 压缩为一句指令（原头尾两段长指令 ~120 字符，语义不变）。
    const interruptedContext = input.interruptedContext?.trim()
      ? `【上一轮被打断的旧回复残留，仅供背景；不要承接/提及/道歉，直接干净地回答用户新消息】\n${input.interruptedContext.trim()}`
      : undefined;

    // 追问降权策略（记忆架构重构后简化）：长期记忆字段已由 longTermEnabled 单一门控，
    // 门控未命中时直接为 undefined，不再需要追问压缩分支；追问场景仅保留
    // 短期上下文（STM/recentHistory/followUpAnchor）的差异化长度，服务指代消解。
    // dailyDigest 仍只在非追问场景注入（digest 与追问语义无关，省 token）
    const dailyDigest =
      followUpTurn || !userText
        ? undefined
        : digestService.getRelevantPromptDigest(input.actorId, userText);
    const userProfileFromManager =
      memoryManager?.getProfileForPrompt(input.actorId) ?? undefined;
    // P2-1 元认知：同步读记忆目录缓存（cognize 阶段刷新，60s TTL；未命中为空串跳过注入）
    const memoryInventorySummary = compactPromptBlock(
      getGlobalMemoryInventory()?.getCachedSummary(input.actorId) ?? "",
      220,
    );
    const memoryContinuity =
      longTermEnabled
        ? memoryManager?.getContinuityForPrompt(input.actorId) ?? undefined
        : undefined;
    const relationshipMemory =
      longTermEnabled
        ? memoryManager?.getRelationshipMemoryForPrompt(input.actorId) ?? undefined
        : undefined;
    const lifeThemeMemory =
      longTermEnabled
        ? memoryManager?.getLifeThemeMemoryForPrompt(input.actorId) ?? undefined
        : undefined;
    const dreamMemory =
      longTermEnabled
        ? memoryManager?.getDreamMemoryForPrompt(input.actorId) ?? undefined
        : undefined;
    // 优化 2：主动跨天 recall，注入昨天/前天的关键事件
    const yesterdayHighlight =
      longTermEnabled
        ? memoryManager?.getYesterdayHighlightForPrompt(input.actorId) ?? undefined
        : undefined;
    // 追问锚点（2026-10-10 语义化重写）：原「FU|anchor=...」密文 + 词表判定退役。
    // 仅当模型判定本轮话头锚定上文（reference ≠ none）时注入，锚文本改用自然
    // 语言说清「承接对象」——只解决指代对齐，不催促推进旧任务（「你叫我什么？」
    // 被硬编码判成追问轮、锚到上一条旅游回复导致答非所问的教训）。
    const followUpAnchor = buildFollowUpAnchorFromUnderstanding(turnUnderstanding);
    // scheduleSnapshot 注入：模型判定的日程语义（schedule_query）或追问轮注入
    // ——追问轮 agent 回头确认「正事」，权威日程快照能纠正 recap/挂起栈的记忆偏差。
    const scheduleSnapshot =
      this.deps.scheduleTaskService != null &&
      (turnUnderstanding?.scheduleQuery === true || followUpTurn)
        ? buildSchedulePromptSnapshot(
            this.deps.scheduleTaskService,
            input.actorId,
            turnUnderstanding?.scheduleQuery === true,
          )
        : undefined;
    // 行程状态热层：仅模型判定本轮在问行程/旅行时注入一行回执列表（目的地/日期/planId），
    // 完整明细不进上下文，由 travel.get-itinerary 按需回查（见 travel-prompt-snapshot.ts）
    const travelState =
      turnUnderstanding?.travelQuery === true ? buildTravelStatePrompt(userText) : undefined;
    const taskContext =
      config.memoryPrompt.taskContextInPrompt && userText
        ? compactPromptBlock(buildTaskContextPrompt(userText, turnUnderstanding), 320)
        : undefined;
    // 追问场景扩容：900 → 1500 字，保留更多任务脉络
    const shortTermTaskContextLimit = followUpTurn ? 1500 : 900;
    const shortTermTaskContext =
      input.sessionId && this.deps.shortTermMemoryGateway
        ? compactPromptBlock(
            this.deps.shortTermMemoryGateway.buildPromptContext(input.sessionId, userText, turnUnderstanding),
            shortTermTaskContextLimit,
          )
        : undefined;
    // 当日日志检索块：独立注入（不拼 narrativeRecall，防 formatNarrativeRecallPrompt 拍平）。
    // 与 STM 会话情景记忆双轨去重：同一批今天早些时候的对话，STM（延续/指代轮注入原文、
    // 保真度高）优先保留；journal 命中与 STM 词汇重叠 ≥ 0.7 的行剔除，只留 STM 没覆盖的
    // （跨 session / 更早时间段的行）。
    const journalRecall = compactPromptBlock(
      dedupeJournalVsStm(input.journalRecall, shortTermTaskContext),
      700,
    );
    // 2026-09-06：聊天路径不再并入全局 Agent 风格指纹（agent-style-profile，
    // 固定平均句长/语气词）——全局固定指纹与"语感跟着用户走"直接打架。
    // 主动消息路径（create-app-services PROACTIVE_SYSTEM_PROMPT）继续使用它。
    const toneGuidance = compactPromptBlock(input.personalization?.toneGuidance, 480);
    const rawUserProfile = compactPromptBlock(input.personalization?.userProfile, 700);
    // 仿人记忆连续性：提升阈值让更多召回记忆能被 LLM 看到，避免关键上下文被截断
    const narrativeRecall = compactPromptBlock(formatNarrativeRecallPrompt(input.narrativeRecall), 800);
    // 工作记忆摘要 / 最近对话回顾：作为独立块注入，不走 formatNarrativeRecallPrompt。
    // 修复"上下文跳转"：原实现把它们拼到 narrativeRecall 末尾，被 formatNarrativeRecallPrompt
    // 的 slice(0,4) 当作召回条目丢弃，或块结构被拍平、hint 被正则误杀。
    // 追问场景适度压缩（仍注入，保留指代消解线索），非追问保持原长度。
    const workingMemorySummaryLimit = followUpTurn ? 300 : 600;
    const workingMemorySummary = compactPromptBlock(input.workingMemorySummary, workingMemorySummaryLimit);
    const recentConversationHistoryLimit = followUpTurn ? 500 : 900;
    const recentConversationHistory = compactPromptBlock(
      input.recentConversationHistory,
      recentConversationHistoryLimit,
    );
    const compactDailyDigest = compactPromptBlock(dailyDigest, 420);
    // followUpAnchor 追问场景扩容：180 → 400 字，增加指代消解线索
    const followUpAnchorLimit = followUpTurn ? 400 : 180;
    const compactFollowUpAnchor = compactPromptBlock(followUpAnchor, followUpAnchorLimit);
    const compactScheduleSnapshot = compactPromptBlock(scheduleSnapshot, 360);
    const compactTravelState = compactPromptBlock(travelState, 300);
    // 长期记忆字段压缩（追问分支已随单一门控移除，只保留常规压缩策略）：
    // - lifeThemeMemory：背景性上下文，用 low importance 压到 280*0.7≈196 字（保留前 N 个主题）
    // - dreamMemory：跨会话整理结果，含「核心主题」高价值抽象，不能用 low 压缩会丢末尾主题。
    //   改用 normal importance + preserve="both"：保留开场（最近在意的）+ 末尾（核心主题/淡忘），
    //   中间被省略号替换，既省 token 又保住记忆连续性。
    const userProfileFromManagerCompact = userProfileFromManager;
    const memoryContinuityCompact = memoryContinuity;
    const relationshipMemoryCompact = compactPromptBlock(relationshipMemory, 480, "normal");
    const lifeThemeMemoryCompact = compactPromptBlock(lifeThemeMemory, 280, "low");
    const dreamMemoryCompact = compactPromptBlock(dreamMemory, 500, "normal", "both");
    // 2026-09-29 互斥改合并：文件画像（LLM 抽取的当前事实）升稳定层【用户长期画像】主位，
    // manager 派生摘要非重复行追加；原互斥（manager 存在即弃文件画像）导致画像被挤掉。
    const userProfileSummary = mergeUserProfilePromptSources(
      rawUserProfile,
      userProfileFromManagerCompact,
    );
    // 冷启动引导（P2）：画像还没有任何真实事实（模板/空）且是会话首轮时，
    // 给一句自然破冰提示——新用户第一周画像未成形，agent 主动了解而不是干等。
    // 画像成形或非首轮后自动消失（模板闸双重门控，零常驻成本）。
    const onboardingHint =
      !userProfileSummary &&
      userText &&
      (input.threadMessageCount == null || input.threadMessageCount <= 1)
        ? "【初次见面】\n你还不认识这位用户。可以自然地了解一个称呼或对方最近在忙什么——问一句就好，别连环盘问，下轮也别重复问。"
        : undefined;

    // 深度优化：用户画像注入（来自 OnlineLearningCortex）
    let userPatternBlock: string | undefined;
    if (input.userPattern) {
      const up = input.userPattern;
      const lines: string[] = [];
      if (up.topics.length > 0) lines.push(`用户近期关注话题：${up.topics.join("、")}`);
      if (up.preferredToolDomain) lines.push(`用户偏好工具领域：${up.preferredToolDomain}`);
      if (up.negativeFeedbackCount > 0) lines.push(`用户近期否定反馈次数：${up.negativeFeedbackCount}`);
      if (up.learningActive === true) lines.push(`用户处于学习活跃期`);
      if (lines.length > 0) {
        userPatternBlock = `【用户画像】\n${lines.join("\n")}`;
      }
    }

    // 深度优化：工具规划链注入（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围
    let toolPlanBlock: string | undefined;
    if (input.toolPlan && input.toolPlan.toolChain.length > 0) {
      try {
        const tp = input.toolPlan;
        const lines: string[] = [
          `【建议工具链】`,
          `任务：${tp.task}`,
          `依据：${tp.reasoning}`,
          `建议按以下顺序调用工具：`,
          ...tp.toolChain.map((t, i) =>
            `  ${i + 1}. ${t.name} — ${t.purpose}${t.critical ? '（关键路径）' : ''}`,
          ),
          // 「预估 token/调用次数」行已删：内部估算值对 LLM 决策无信息量，纯占字符。
        ];
        toolPlanBlock = lines.join("\n");
      } catch (err) {
        console.log(`[PromptContextBuilder] toolPlan 注入失败（忽略）: ${err}`);
      }
    }

    // 用户兴趣关注列表（InterestWatcher 接线）：注入【用户兴趣关注列表】块。
    // 让 agent 知道用户在长期关注什么（话题接得住）；附工具引导：听到新的长期
    // 兴趣时调 interest.manage 记录。无列表时零注入。
    let interestListBlock: string | undefined;
    if (this.interestListProvider) {
      try {
        const list = this.interestListProvider(input.actorId);
        if (list) {
          interestListBlock = [
            `【用户兴趣关注列表】`,
            `（后台按常聊话题维护；话题被提起时自然接住、别背诵清单；出现新的长期兴趣时用 interest.manage 的 add/touch 记录，明确不喜欢用 remove）`,
            list,
          ].join("\n");
        }
      } catch (err) {
        console.log(`[PromptContextBuilder] 兴趣列表注入失败（忽略）: ${err}`);
      }
    }

    const seenMemory = new Set<string>();
    const dedupedMemorySummary = dedupePromptBlock(fromKv.memorySummary, seenMemory);
    const dedupedNarrativeRecall = dedupePromptBlock(narrativeRecall, seenMemory);
    const dedupedDailyDigest = dedupePromptBlock(compactDailyDigest, seenMemory);
    // 对话时间线事实：首次对话/累计轮次/最近对话（ConversationTimelineService，
    // 每轮 turn-lifecycle 更新；无记录返回 null 零注入）。
    let conversationTimeline: string | undefined;
    try {
      conversationTimeline =
        getConversationTimelineService()?.getTimelineForPrompt(input.actorId) ?? undefined;
    } catch (err) {
      console.log(`[PromptContextBuilder] 时间线注入失败（忽略）: ${err}`);
    }
    fromKv = {
      ...fromKv,
      ...(dedupedMemorySummary ? { memorySummary: dedupedMemorySummary } : { memorySummary: undefined }),
    };

    // 用户理解档案块（2026-10-06 治啰嗦 P1）：改走召回门控——它是「agent 对用户的
    // 理解记录」，属情节性素材，常驻注入会推高闲聊轮的「什么都想提」压力。
    // 恒驻速览由【用户档案·结构化事实】承担（确定字段+称呼礼仪单一权威）。
    const understanding = longTermEnabled
      ? this.buildUserUnderstandingBlock(input.actorId, userText)
      : { stableBlock: undefined, matchedTopics: [] as string[] };
    const userUnderstandingBlock = understanding.stableBlock;

    // 结构化事实块：用户档案字段的确定性记录（KV 式精确寻址，无条件注入=用户速览）；
    // P0-1 后字节稳定渲染，命中字段进 turnAddressing 动态块。
    const facts = this.buildUserFactsBlock(input.actorId, userText);
    const userFactsBlock = facts.stableBlock;

    // 本轮寻址块（P0-1）：沉底注入动态层，等价承接旧版逐条寻址标记。
    const turnAddressingBlock = formatTurnAddressingBlock(
      understanding.matchedTopics,
      facts.matchedFields,
    );

    // 互斥：shortTermTaskContext 非空时跳过 taskContext，避免语义重叠字段同时以完整长度注入
    const effectiveTaskContext = shortTermTaskContext ? undefined : taskContext;

    // 人格内核（personality 域）：每轮从 MemoryCortex 拉取，格式化后注入 system prompt 稳定前缀防漂移。
    // 注意：不受追问轮影响——人格内核是稳定身份层，非本轮上下文。
    const rawPersonalityCore = this.personalityProvider?.(input.actorId) ?? null;
    const personalityCore = rawPersonalityCore
      ? compactPromptBlock(formatPersonalityCorePrompt(rawPersonalityCore), 400)
      : undefined;

    // 当下状态（P0 2026-10-01「顺嘴要贴此刻」）：状态板 current 层格式化注入，
    // 陈旧信号 provider 内自判不注入。失败零阻塞。
    let currentUserState: string | undefined;
    if (this.currentStateProvider) {
      try {
        currentUserState = this.currentStateProvider(input.actorId) ?? undefined;
      } catch (err) {
        console.log(`[PromptContextBuilder] 当下状态注入失败（忽略）: ${err}`);
      }
    }

    // 顺嘴机会（P1 主动性搭车通道）：挂起的 low 意图织入回复末尾。仅对话面
    // （任务面旁注会污染结构化交付）；取走即交付，provider 内自带频控/TTL。
    let turnAside: string | undefined;
    if (this.turnAsideProvider && input.plane === "chat") {
      try {
        turnAside = this.turnAsideProvider(input.actorId) ?? undefined;
      } catch (err) {
        console.log(`[PromptContextBuilder] 顺嘴机会注入失败（忽略）: ${err}`);
      }
    }

    const promptMemory: AgentPromptMemoryContext = {
      ...fromKv,
      // 【当前时间】每轮注入（2026-10-07 用户拍板，撤 10-06 按需闸对本块的控制）：
      // 一行动态文本，走动态层不伤 prefix cache；缺它模型会拿「没有注入时间」当
      // 借口拒绝办事（真机实证：「明天天气」轮自称无时间无天气权限）。【对话时间轴】
      // 块仍按需放行（abstract-chat-provider 侧 time-context-gate 判定不变）。
      currentTime: buildCurrentTimePrompt(new Date(), extractUserTimezoneFromLocation(input.userLocation)),
      ...(buildDeviceEnvironmentBlock(input.deviceClass)
        ? { deviceEnvironment: buildDeviceEnvironmentBlock(input.deviceClass) }
        : {}),
      ...(personalityCore ? { personalityCore } : {}),
      ...(currentUserState ? { currentUserState } : {}),
      ...(turnAside ? { turnAside } : {}),
      ...(fromKv.taskContext || effectiveTaskContext || shortTermTaskContext
        ? { taskContext: [fromKv.taskContext, effectiveTaskContext, shortTermTaskContext].filter(Boolean).join("\n\n") }
        : {}),
      ...(toneGuidance
        ? { toneGuidance }
        : {}),
      ...(userUnderstandingBlock ? { userUnderstanding: userUnderstandingBlock } : {}),
      ...(userFactsBlock ? { userFacts: userFactsBlock } : {}),
      ...(turnAddressingBlock ? { turnAddressing: turnAddressingBlock } : {}),
      ...(input.personalization?.relationshipGuidance
        ? { relationshipGuidance: input.personalization.relationshipGuidance }
        : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(dedupedNarrativeRecall
        ? { narrativeRecall: dedupedNarrativeRecall }
        : {}),
      // 工作记忆 / 最近对话回顾：独立块，不参与跨字段语义去重（结构化上下文，非召回条目）
      ...(workingMemorySummary ? { workingMemorySummary } : {}),
      ...(recentConversationHistory ? { recentConversationHistory } : {}),
      // 当日对话日志检索：当天 md 承载的对话历史，注入供 agent 读取当前对话历史（短期记忆）
      ...(journalRecall ? { journalRecall } : {}),
      ...(dedupedDailyDigest ? { dailyDigest: dedupedDailyDigest } : {}),
      ...(userProfileSummary ? { userProfileSummary } : {}),
      ...(onboardingHint ? { onboardingHint } : {}),
      ...(memoryContinuityCompact ? { memoryContinuity: memoryContinuityCompact } : {}),
      ...(relationshipMemoryCompact ? { relationshipMemory: relationshipMemoryCompact } : {}),
      ...(lifeThemeMemoryCompact ? { lifeThemeMemory: lifeThemeMemoryCompact } : {}),
      ...(dreamMemoryCompact ? { dreamMemory: dreamMemoryCompact } : {}),
      // 优化 2：跨天事件回顾，压缩到 200 字（非追问场景）
      ...(yesterdayHighlight && !followUpTurn
        ? { yesterdayHighlight: compactPromptBlock(yesterdayHighlight, 200) }
        : {}),
      ...(interruptedContext ? { interruptedContext: interruptedContext } : {}),
      ...(compactFollowUpAnchor ? { followUpAnchor: compactFollowUpAnchor } : {}),
      ...(compactScheduleSnapshot ? { scheduleSnapshot: compactScheduleSnapshot } : {}),
      ...(compactTravelState ? { travelState: compactTravelState } : {}),
      // 规则画像块（OnlineLearningCortex）单独走动态层【用户档案】画像槽；
      // 文件画像已升稳定层（userProfileSummary），不再在此合并避免双注入
      ...(userPatternBlock ? { userProfile: userPatternBlock } : {}),
      ...(toolPlanBlock ? { toolPlan: toolPlanBlock } : {}),
      ...(interestListBlock ? { interestList: interestListBlock } : {}),
      // commitmentBoard（未兑现承诺块）不再构建：prompt-assembler 从不渲染该字段，
      // 每轮白查一次承诺板。承诺信息仍经 KV memory_commitments 与 epitome 注入。
      ...(conversationTimeline ? { conversationTimeline } : {}),
      ...(input.semanticIntent ? { semanticIntent: input.semanticIntent } : {}),
      // 2026-08-20 修复「对话面第二句说没拿到定位」：
      // 此前 assembleMemory 只用 input.userLocation 提取时区给 currentTime,从未把它
      // 写进 promptMemory。LLM 在对话面查天气/位置类问题时,系统 prompt 缺失
      // 【用户位置】块,工具调用只能传空参,工具返回「没有拿到真实定位」错误,LLM 在
      // 第二句(正文气泡)复述工具错误为「没拿到你的定位」,与同会话前面对话
      // 矛盾。修复:在 promptMemory 顶层注入 userLocation 字段,下游 prompt-builder
      // (行 672/785) 会自动格式化为「【用户位置】\n${userLocation}」块。
      // 注:userIsStatingData 已在 agent-core.ts:846-848 提前过滤「陈述具体数据」
      // 场景,这里不需要再判定。
      ...(input.userLocation ? { userLocation: input.userLocation } : {}),
      ...(input.frequentPlaces ? { frequentPlaces: input.frequentPlaces } : {}),
      ...(this.buildSkillIndexPrompt(userText) ?? {}),
    };

    // 防召回循环：登记本轮实际注入的记忆条目。写入整合链路
    // （memory-consolidation-service）会据此过滤"模型复述注入记忆"产生的
    // 回声候选——注入回上下文的内容不再被提取为新记忆（OpenClaw 2.0 同款结构）。
    try {
      markInjectedMemory(input.actorId, promptMemory.userUnderstanding);
      markInjectedMemory(input.actorId, promptMemory.userFacts);
      markInjectedMemory(input.actorId, promptMemory.narrativeRecall);
      markInjectedMemory(input.actorId, promptMemory.memorySummary);
      markInjectedMemory(input.actorId, promptMemory.memoryPreferences);
      markInjectedMemory(input.actorId, promptMemory.memoryFacts);
      markInjectedMemory(input.actorId, promptMemory.memoryCommitments);
      markInjectedMemory(input.actorId, promptMemory.memoryOpenLoops);
      markInjectedMemory(input.actorId, promptMemory.sessionRecap);
      markInjectedMemory(input.actorId, promptMemory.userProfile);
      markInjectedMemory(input.actorId, promptMemory.userProfileSummary);
      markInjectedMemory(input.actorId, promptMemory.memoryContinuity);
      markInjectedMemory(input.actorId, promptMemory.relationshipMemory);
      markInjectedMemory(input.actorId, promptMemory.lifeThemeMemory);
      markInjectedMemory(input.actorId, promptMemory.dreamMemory);
      markInjectedMemory(input.actorId, promptMemory.yesterdayHighlight);
      markInjectedMemory(input.actorId, promptMemory.dailyDigest);
    } catch (err) {
      console.log(`[PromptContextBuilder] 注入记忆登记失败（忽略）: ${err}`);
    }

    // 注入 prompt 前对 memory/facts 等用户内容字段做 PII 脱敏（手机号/邮箱/IP/身份证/银行卡）
    return this.redactMemoryFields(promptMemory);
  }

  /**
   * 用户理解档案块：agent 对用户理解的结构化沉淀（topic + 理解句 + 性质标注
   * + 演变历史）。无条件注入（当前理解档案，非历史召回，不受 longTermEnabled
   * 门控）。
   *
   * 2026-09-29 P0-1 缓存优化：渲染不再带 per-turn 寻址标记——标记位置随用户
   * 措辞逐轮移动会让稳定层逐轮变字节，打断 DeepSeek 前缀缓存（实测改一行
   * 命中 98%→27%）。字节稳定渲染 + 命中话题走 turnAddressing 动态块沉底，
   * "我老婆是谁"仍直达当前理解。
   */
  private buildUserUnderstandingBlock(
    actorId: string,
    userText: string,
  ): { stableBlock: string | undefined; matchedTopics: string[] } {
    try {
      const store = getMemoryComponents().understandingStore;
      if (!store) return { stableBlock: undefined, matchedTopics: [] };
      const matchedTopics = store
        .matchTopicsInText(actorId, userText)
        .map((n) => n.topic.trim())
        .filter(Boolean);
      return { stableBlock: store.renderForPrompt(actorId) ?? undefined, matchedTopics };
    } catch (err) {
      console.log(`[PromptContextBuilder] 用户理解块构建失败（忽略）: ${err}`);
      return { stableBlock: undefined, matchedTopics: [] };
    }
  }

  /**
   * 结构化事实块：用户档案字段的确定性记录（称呼/职业/居住地/技术栈…）。
   * 无条件注入（当前档案，非历史召回）。同 P0-1：字节稳定渲染，命中字段走
   * turnAddressing 动态块沉底，"我是做什么工作的"直达当前值。
   */
  private buildUserFactsBlock(
    actorId: string,
    userText: string,
  ): { stableBlock: string | undefined; matchedFields: string[] } {
    try {
      const store = getMemoryComponents().factStore;
      if (!store) return { stableBlock: undefined, matchedFields: [] };
      const matchedFields = store
        .matchFieldsInText(actorId, userText)
        .map((f) => f.field.trim())
        .filter(Boolean);
      return { stableBlock: store.renderForPrompt(actorId) ?? undefined, matchedFields };
    } catch (err) {
      console.log(`[PromptContextBuilder] 结构化事实块构建失败（忽略）: ${err}`);
      return { stableBlock: undefined, matchedFields: [] };
    }
  }

  /**
   * 构建可复用技能轻量索引（Level 0 渐进式召回）。
   *
   * 参考 skill_index 设计：只注入 name + description + skillType + tags 的
   * 紧凑列表（上限 20 条 / 总 500 字符），不含 doc 全文。让 LLM 感知"我有这些
   * 沉淀的技能"，遇到相关任务时先用 skill.view 工具加载全文（Level 1）再复用。
   *
   * 2026-09-29 P0-1：技能索引在稳定层，按本轮 userText 相关性重排会让稳定层
   * 逐轮变字节（同 grounded 标记问题）。改为纯名称序（确定性），技能发现走
   * Level 1 的 skill.view 按需加载，不依赖索引排序的先后。
   */
  private buildSkillIndexPrompt(_userText: string | undefined): { skillIndex: string } | undefined {
    if (!this.deps.skillManager) return undefined;
    let manifests;
    try {
      manifests = this.deps.skillManager.list(true);
    } catch {
      return undefined;
    }
    if (!manifests || manifests.length === 0) return undefined;

    const sorted = [...manifests].sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    for (const m of sorted.slice(0, 20)) {
      const skillType = m.skillType ?? "code";
      const desc = m.description.replace(/\s+/g, " ").slice(0, 80);
      const tags = (m.tags ?? []).slice(0, 3).join("/");
      lines.push(`- ${m.name}（${skillType}）：${desc}${tags ? `｜${tags}` : ""}`);
    }
    const indexBlock = lines.join("\n");
    if (indexBlock.length > 500) {
      // 超出上限：按行截断到 500 字符
      const truncated: string[] = [];
      let len = 0;
      for (const line of lines) {
        if (len + line.length + 1 > 500) break;
        truncated.push(line);
        len += line.length + 1;
      }
      return {
        skillIndex: `【可复用技能索引】\n${truncated.join("\n")}`,
      };
    }
    return {
      skillIndex: `【可复用技能索引】\n${indexBlock}`,
    };
  }

  /**
   * 对注入 prompt 的 memory/facts 等用户内容字段做 PII 脱敏。
   * 覆盖承载用户记忆/事实/画像的字段（手机号→***PHONE***、邮箱→***EMAIL***、
   * IP→***IP***、身份证→***ID***、银行卡→***BANK***）。
   * 不脱敏能力说明/时间/人格内核等非用户内容字段。
   */
  private redactMemoryFields(ctx: AgentPromptMemoryContext): AgentPromptMemoryContext {
    const redact = (v: string | undefined): string | undefined =>
      v ? redactSensitiveText(v) : undefined;
    return {
      ...ctx,
      memorySummary: redact(ctx.memorySummary),
      memoryFacts: redact(ctx.memoryFacts),
      userFacts: redact(ctx.userFacts),
      turnAddressing: redact(ctx.turnAddressing),
      memoryPreferences: redact(ctx.memoryPreferences),
      memoryCommitments: redact(ctx.memoryCommitments),
      memoryOpenLoops: redact(ctx.memoryOpenLoops),
      memoryContinuity: redact(ctx.memoryContinuity),
      relationshipMemory: redact(ctx.relationshipMemory),
      lifeThemeMemory: redact(ctx.lifeThemeMemory),
      dreamMemory: redact(ctx.dreamMemory),
      yesterdayHighlight: redact(ctx.yesterdayHighlight),
      narrativeRecall: redact(ctx.narrativeRecall),
      dailyDigest: redact(ctx.dailyDigest),
      userProfileSummary: redact(ctx.userProfileSummary),
      userProfile: redact(ctx.userProfile),
      taskContext: redact(ctx.taskContext),
      travelState: redact(ctx.travelState),
      sessionRecap: redact(ctx.sessionRecap),
      workingMemorySummary: redact(ctx.workingMemorySummary),
      recentConversationHistory: redact(ctx.recentConversationHistory),
      journalRecall: redact(ctx.journalRecall),
    };
  }

  private hasMemoryContent(memory: AgentPromptMemoryContext): boolean {
    return (
      Boolean(memory.persona) ||
      Boolean(memory.personalityCore) ||
      Boolean(memory.values) ||
      Boolean(memory.abilities) ||
      Boolean(memory.memorySummary) ||
      Boolean(memory.agentCaps) ||
      Boolean(memory.worldCaps) ||
      Boolean(memory.narrativeRecall) ||
      Boolean(memory.dailyDigest) ||
      Boolean(memory.memoryPreferences) ||
      Boolean(memory.memoryFacts) ||
      Boolean(memory.memoryCommitments) ||
      Boolean(memory.memoryOpenLoops) ||
      Boolean(memory.sessionRecap) ||
      Boolean(memory.interruptedContext) ||
      Boolean(memory.userLocation) ||
      Boolean(memory.taskContext) ||
      Boolean(memory.userProfile) ||
      Boolean(memory.relationshipGuidance) ||
      Boolean(memory.toneGuidance) ||
      Boolean(memory.userProfileSummary) ||
      Boolean(memory.memoryInventory) ||
      Boolean(memory.memoryContinuity) ||
      Boolean(memory.relationshipMemory) ||
      Boolean(memory.lifeThemeMemory) ||
      Boolean(memory.dreamMemory) ||
      Boolean(memory.yesterdayHighlight) ||
      Boolean(memory.followUpAnchor) ||
      Boolean(memory.scheduleSnapshot) ||
      Boolean(memory.travelState) ||
      Boolean(memory.toolPlan) ||
      Boolean(memory.skillIndex) ||
      Boolean(memory.currentTime) ||
      Boolean(memory.deviceEnvironment) ||
      Boolean(memory.workingMemorySummary) ||
      Boolean(memory.recentConversationHistory) ||
      Boolean(memory.semanticIntent)
    );
  }

  /**
   * 会话技能工具公开入口（2026-10-10 P0-1）：chat 车道语料装配
   * （agent-core.buildChatLaneExplicitOpts）需要把技能工具并进语料，
   * 否则技能族（travel.* / alipay.* / merchant.* … 全部技能）在对话面
   * 既不可见、也进不了延迟目录（tool_discover 召回不到）。
   * 与 build() 产出的 chatToolsExtra 同一数据源，调用方负责按名去重。
   */
  getChatSkillTools(actorId: string): ChatCompletionTool[] {
    return this.sessionSkillTools(actorId) ?? [];
  }

  private sessionSkillTools(actorId: string): ChatCompletionTool[] | undefined {
    const tools: ChatCompletionTool[] = [];
    if (this.deps.worldService && this.deps.skillManager) {
      const sessionTools = buildSessionSkillChatTools(actorId, this.deps.worldService, this.deps.skillManager);
      tools.push(...sessionTools);
    }
    // 技能管理工具（skill.list / skill.view / skill.manage）始终暴露：
    // 让 LLM 自主查询轻量索引、按需加载 procedural 全文、沉淀/修补经验。
    // 与 PromptContextBuilder.buildSkillIndexPrompt 的 Level 0 索引配套使用。
    tools.push(...SKILL_MANAGE_CHAT_TOOLS);
    return tools.length ? tools : undefined;
  }
}
