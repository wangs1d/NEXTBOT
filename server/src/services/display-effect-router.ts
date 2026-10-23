/**
 * 文本展示效果动态路由器（独立模块，纯程序层，无 LLM 参与）。
 *
 * 职责：给定一次结构化输出信号（toolName + title/items/footer），
 * 决定前端使用哪种「文本展示效果」（cardType）。
 *
 * 接线：
 *   - 服务端：agent-result-formatter.formatAgentResultForChat 在产出
 *     [AGENT_RESULT_CARD] 前调用 routeDisplayEffect 注入 cardType；
 *     tool-result-processor 对 markdown 引用块（> xxx）走 quote 提取。
 *   - 前端：features/chat/display_effects/ 模块按 cardType 渲染对应组件，
 *     分发表见 agent_result_card.dart 的 AgentResultCard.build。
 *
 * 架构（声明式动态评分，替代旧的固定优先级链）：
 *   收集候选 → 逐候选评分 → 最高分当选，全程数据驱动，无线性抢名额：
 *   - 候选来源一「工具路由表」：[TOOL_RULES] 一条规则一个效果，强工具
 *     （语义唯一场景）score=1，弱工具（宽泛关键字）score=0.5 只给倾向；
 *   - 候选来源二「内容评分器注册表」：[CONTENT_SCORERS] 每种内容效果
 *     一个独立 text 形态评分函数（0-1），互相竞争、各自可测。形态评分
 *     跑在「双表征」上：结构化条目（formatter 掐出的真实列表）与语义
 *     条目（fullText 掐出的自然表达）各评一次取高者——谁更能揭示内容
 *     形态就听谁的，避免用语义碎片整体替换列表条目造成的比例稀释
 *     （如 metric 的 every() 校验被前导碎句打破，1.0 掉到 0.5 丢卡）；
 *   - 聚合：[scoreDisplayEffects] 按 [CANDIDATE_ORDER] 显式顺序产出每个
 *     候选的 (contentScore, toolScore, score) 明细分，score =
 *     contentScore×CONTENT_WEIGHT + toolScore×TOOL_WEIGHT（截断 1）；
 *     fold_list/chips 这类「只描述怎么摆、不描述是什么」的通用容器，
 *     在存在指向其他效果的强工具信号时内容分降权（GENERIC_CONTAINER_*），
 *     不再抢走工具专属卡（如 search_web 的长清单误判成 fold_list）；
 *   - 决策：[routeDisplayEffect] 在明细分上取最高分；得分相同（含浮点
 *     误差）保留先被评分的候选，即 CANDIDATE_ORDER 次序（平局兜底）。
 *
 *   语义约定：
 *   - 内容信号是主判据（权重 0.78）：文本形态决定效果；同一段内容可能
 *     同时长得像时间轴和数据面板，由得分定胜负而非规则先后顺序。
 *   - 工具信号是兜底/加成（权重 0.45）：无内容信号时强工具保证落在
 *     正确场景；弱工具只给倾向分，可被高置信内容压过——同一个 plan 工具，
 *     输出是 A/B 对比就落在 compare，输出是时间线才走 timeline。
 *
 * 新增展示效果的扩展步骤：
 *   1. DisplayEffectType 加类型名；
 *   2. 内容型效果：在 CONTENT_SCORERS 注册一个评分函数（含场景注释），
 *      并加入 CANDIDATE_ORDER；工具型效果：在 TOOL_RULES 加一条规则
 *      （强工具语义唯一，弱工具给倾向）；
 *   3. 前端 display_effects/ 加对应组件并在 AgentResultCard 分发表注册；
 *   4. test/display-effect-router.test.ts 补用例。
 */

import { LIST_ITEM_RE } from "./render-hint-service.js";
import {
  aggregateScore,
  clamp01,
  COMPARISON_INTENT_RE,
  CONTENT_WEIGHT,
  ratio,
  TOOL_WEIGHT,
} from "./render-scoring.js";
import type { DisplayEffectType } from "@nextbot/agent-protocol";

/** 展示效果类型枚举的唯一契约源：@nextbot/agent-protocol（display-effects.ts）。 */
export type { DisplayEffectType };

/** 路由输入：一次结构化输出的全部信号。 */
export interface DisplayRouteInput {
  /** 最近调用的工具名（可为空——纯文本路径没有工具信号）。 */
  toolName?: string;
  /** 卡片标题。 */
  title: string;
  /** 结构化条目（text 为剥掉列表前缀后的正文）。 */
  items: ReadonlyArray<{ text: string; type?: string }>;
  /**
   * 原始全文（未切分）。提供后，「内容语义」成为主判据：
   * 即使 LLM 没用 `-`/`1.` 列表语法，也能按语义掐出条目（分层叙述、
   * 一是…二是…、首先…最后…、顿号列举等），不再强依赖列表格式。
   * 形态评分跑「双表征」：结构化条目与语义条目各评一次取高者，
   * 而不是用语义条目整体替换（替换会稀释比例、打破严格形态校验）。
   */
  fullText?: string;
  /** 卡片 footer（追问/补充说明）。 */
  footer?: string;
  /**
   * 原文列表行的顺序编号占比（0-1）：列表前缀 `1. ` `2、` 被剥离后
   * 步骤信号会丢失，formatter 在剥离前统计编号行比例并传入。
   * ≥0.8 视为顺序步骤列表。
   */
  numberedItemRatio?: number;
}

/** 单个候选的评分明细（路由决策可观测、可测试、可审计）。 */
export interface DisplayEffectScore {
  type: DisplayEffectType;
  /** 文本形态分（0-1），未命中为 0。 */
  contentScore: number;
  /** 工具场景分（0-1），强工具 1 / 弱工具 0.5 / 无 0。 */
  toolScore: number;
  /** 聚合分 = contentScore×CONTENT_WEIGHT + toolScore×TOOL_WEIGHT（截断 1）。 */
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合权重：CONTENT_WEIGHT / TOOL_WEIGHT / ratio / clamp01 / aggregateScore
// 统一从 render-scoring.ts 引入（与消息级路由共享同一套聚合内核）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 工具名分词：按非字母数字切分并归一（>3 字符的复数去尾 s），供片段精确匹配。
 * 取代旧的 includes() 宽匹配——includes("file") 会误命中 profile_view，
 * includes("pay") 会误命中 prepay_query；分词后 "profile_view" 的片段是
 * {profile, view}，不会撞上 {file}。
 */
function toolTokens(toolName: string): Set<string> {
  const raw = toolName.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(
    raw.map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具路由表（数据驱动；强工具=语义唯一场景，弱工具=宽泛倾向）
// ─────────────────────────────────────────────────────────────────────────────

/** 工具信号强度：与 TOOL_SCORE 关联，决定工具分权重。 */
type ToolStrength = "strong" | "weak";

/** 工具信号强度 → 工具分。弱工具只给倾向，可被高置信内容压过。 */
const TOOL_SCORE: Record<ToolStrength, number> = { strong: 1, weak: 0.5 };

/** 一条工具路由规则：工具名命中 → 该效果获得对应强度的工具分。 */
interface ToolRule {
  effect: DisplayEffectType;
  strength: ToolStrength;
  /** toolName 已小写；tokens 为分词结果（见 toolTokens）。 */
  test: (toolName: string, tokens: Set<string>) => boolean;
}

/** 工具路由规则表；命中顺序即规则顺序，首个命中生效（等价于旧的先判先赢）。 */
const TOOL_RULES: ReadonlyArray<ToolRule> = [
  // ── 强工具（语义唯一场景，无内容信号时保底）──
  // 旅游行程：独立于 plan/行程 等宽泛关键字，务必置于弱工具之前。
  { effect: "travel_itinerary", strength: "strong", test: (t) => t.startsWith("travel.") },
  { effect: "weather", strength: "strong", test: (t) => t.startsWith("weather.") },
  {
    effect: "schedule",
    strength: "strong",
    test: (_t, tok) => tok.has("calendar") || tok.has("schedule"),
  },
  { effect: "wallet", strength: "strong", test: (t) => t.startsWith("wallet.") },
  // 财务深度能力（finance.*）：订阅清单走折叠列表、预算执行走数据面板、
  // 消费分析给数据面板倾向、报告导出走文件卡
  {
    effect: "fold_list",
    strength: "strong",
    test: (t) => t === "finance.list_subscriptions",
  },
  {
    effect: "metric",
    strength: "strong",
    test: (t) => t === "finance.get_budget_status",
  },
  { effect: "metric", strength: "weak", test: (t) => t === "finance.analyze_spending" },
  { effect: "file", strength: "strong", test: (t) => t === "finance.export_report" },
  {
    effect: "order",
    strength: "strong",
    test: (_t, tok) =>
      tok.has("order") || tok.has("payment") || tok.has("pay") || tok.has("alipay"),
  },
  { effect: "file", strength: "strong", test: (_t, tok) => tok.has("file") },
  {
    effect: "media",
    strength: "strong",
    test: (t) => t === "search_images" || t === "search_videos",
  },
  {
    effect: "search_result",
    strength: "strong",
    test: (t) => t === "search_web" || t.startsWith("info."),
  },
  // ── 弱工具（宽泛关键字命中，只给倾向分；分词精确匹配避免误命中）──
  {
    effect: "compare",
    strength: "weak",
    test: (t, tok) => tok.has("compare") || tok.has("pk") || tok.has("vs") || /对比/.test(t),
  },
  {
    effect: "timeline",
    strength: "weak",
    test: (t, tok) => tok.has("timeline") || tok.has("plan") || /行程/.test(t),
  },
  {
    effect: "media",
    strength: "weak",
    test: (t, tok) =>
      tok.has("image") || tok.has("photo") || tok.has("vision") || /识图|图片/.test(t),
  },
];

/** 匹配工具路由表：首个命中规则生效；未命中返回 null。 */
function matchToolSignal(
  toolName: string,
): { effect: DisplayEffectType; score: number; strength: ToolStrength } | null {
  if (!toolName) return null;
  const tokens = toolTokens(toolName);
  for (const rule of TOOL_RULES) {
    if (rule.test(toolName, tokens))
      return { effect: rule.effect, score: TOOL_SCORE[rule.strength], strength: rule.strength };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用容器让位（fold_list/chips 只描述「怎么摆」，不描述「是什么」）
// ─────────────────────────────────────────────────────────────────────────────

/** 通用容器效果集合：纯摆放形态，对内容语义零主张。 */
const GENERIC_CONTAINER_EFFECTS: ReadonlySet<DisplayEffectType> = new Set(["fold_list", "chips"]);

/** 通用容器在强工具（指向其他效果）在场时的内容分折减系数。 */
const GENERIC_CONTAINER_DISCOUNT = 0.5;

/**
 * 语义再切分不可用的形态：chips 只信结构化条目。语义碎片剥掉尾部句读后
 * （"最后加上调料拌一拌。"→"最后加上调料拌一拌"）看起来就像短标签，
 * 实则是叙述碎片——重新切分只会制造伪标签行。
 */
const SEMANTIC_REEXTRACT_INELIGIBLE: ReadonlySet<DisplayEffectType> = new Set(["chips"]);

// ─────────────────────────────────────────────────────────────────────────────
// 内容信号正则（每条规则独立可测）
// ─────────────────────────────────────────────────────────────────────────────

/** 步骤标记：第X步 / 第X阶段 / 第X部分 / Step N / 「数字.」「数字、」「数字)」「中文序号、」开头。 */
const STEP_MARK_RE =
  /^(?:第\s*[一二三四五六七八九十百\d]+\s*[步阶段部]|step\s*\d+|\d{1,2}\s*[.、)）]\s*\S|[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S)/i;

/** 步骤语义标题：标题含教程/流程等词时降低步骤标记的命中门槛。 */
const STEP_TITLE_RE = /(教程|步骤|流程|怎么弄|怎么操作|怎么设置|怎么用|操作指南|攻略|安装|配置|入门)/i;

/** 数值信号：百分比（45%）或分数（90/100）。
 *  分数形态要求前后紧邻字符不是数字或斜杠——排除日期（2026/09/13 里的 09/13）
 *  被误判为分数导致时间戳/日期文本误上 progress 卡（真实回放案例）。 */
const VALUE_RE =
  /(?:\d+(?:\.\d+)?)\s*%|(?<![\d/.])\d{1,3}\s*\/\s*\d{1,3}(?![\d/])/;

/** metric 条目：短标签 + 冒号 + 数值（可带 ≤6 字符单位），无百分比。 */
const METRIC_ITEM_RE = /^[^：:，,。！？\n]{1,14}[：:]\s*[+-]?\d[\d,.，]*\s*\S{0,6}$/;

/** 图片 URL（用于 carousel 内容判定）。 */
const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#]\S*)?/i;

/**
 * 时间标记：HH:mm / HH:mm-HH:mm / 周X / 今天明天后天 / X月X日 / MM-dd / 第X天。
 * 第X天：多日行程叙事（"第一天去乌布，第二天…"）的时间锚点。
 */
const TIME_MARK_RE =
  /^(?:(?:早上|上午|中午|下午|傍晚|晚上|凌晨|夜里)\s*)?(?:\d{1,2}[:：]\d{2}(?:[-~]\d{1,2}[:：]\d{2})?|\d{1,2}点(?:半|钟|半钟)?)|周[一二三四五六日天]|今天|明天|后天|第\s*[一二三四五六七八九十百\d]+\s*天|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2}/;

/** 引用式标题：含引号或结论性引导词。 */
const QUOTE_TITLE_RE = /[“”「『]|一句话|结论|重点|提醒|注意|金句/;
const QUOTE_LEAD_RE = /^(总之|总而言之|核心|简单说|说白了)/;

/** 对比内容标记：条目内含 vs/PK/对比 等明确对比词（纯文本 A/B 对比识别）。 */
const COMPARE_MARK_RE = /(?:^|\s)(?:vs\.?|pk)\b|对比/i;

/** timeline 2 条目场景的钟点要求：必须含 HH:mm / X点 / X月X日（日期泛指词不算）。 */
const CLOCK_MARK_RE = /(?:\d{1,2}[:：]\d{2})|(?:\d{1,2}点)|(?:\d{1,2}月\d{1,2}[日号]?)/;

/**
 * A/B 标签条目：条目以裸 A/B 开头，且后面不是 ASCII 字母数字（排除
 * App/AI/Apple 等以 A 开头的普通词）。捕获组取标签字母。
 * 不认「方案A/产品B」等带前缀形态——那是选项枚举（产品A/产品B 常见于
 * 普通清单），不是 A/B 对峙；对比语义由意图分或对比词承接。
 */
const AB_LABEL_RE = /^([ABab])(?![A-Za-z0-9])/;

/** chips 短标签上限（字符数），超过则不算标签。 */
const CHIP_MAX_LEN = 10;

/** fold_list 折叠门槛：条目数 ≥ 该值时长清单折叠展示。 */
const FOLD_MIN_ITEMS = 8;

// ─────────────────────────────────────────────────────────────────────────────
// 内容评分器注册表（一个效果一个独立评分函数，互相竞争、各自可测）
// ─────────────────────────────────────────────────────────────────────────────

type ContentScorer = (input: DisplayRouteInput) => number;

/**
 * 内容评分器注册表：效果 → 其文本形态评分函数（0-1，0=不匹配）。
 * 新增内容型效果在此注册，并在 CANDIDATE_ORDER 加入该效果。
 */
const CONTENT_SCORERS: Readonly<Partial<Record<Exclude<DisplayEffectType, "">, ContentScorer>>> = {
  steps: scoreSteps,
  progress: scoreProgress,
  carousel: scoreCarousel,
  timeline: scoreTimeline,
  metric: scoreMetric,
  fold_list: scoreFoldList,
  chips: scoreChips,
  quote: scoreQuote,
  comparison_table: scoreComparisonTable,
  compare: scoreCompare,
  travel_itinerary: scoreTravelItinerary,
};

/**
 * 候选效果显式顺序：既是评分遍历顺序，也是得分并列（含浮点误差）时的
 * 平局兜底次序——先被评分的候选在 score 相同时胜出。
 */
const CANDIDATE_ORDER: ReadonlyArray<DisplayEffectType> = [
  "steps",
  "progress",
  "carousel",
  "timeline",
  "travel_itinerary",
  "metric",
  "fold_list",
  "chips",
  "quote",
  "comparison_table",
  "compare",
];

/** steps：多数条目带步骤标记；标题含教程/流程语义时门槛放宽到 0.4；编号列表也算。 */
function scoreSteps(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const stepHits = items.filter((it) => STEP_MARK_RE.test(it.text.trim())).length;
  const r = ratio(stepHits, n);
  let score = 0;
  if (r >= 0.6) score = r;
  else if (STEP_TITLE_RE.test(input.title) && r >= 0.4) score = Math.min(r + 0.1, 0.8);
  // 条目前缀被剥离的纯顺序编号列表（numberedItemRatio ≥0.8）也是步骤语义
  if ((input.numberedItemRatio ?? 0) >= 0.8) score = Math.max(score, 1);
  // 2 条目门槛收紧：显式步骤标记全命中，或原文编号行占比 ≥0.8（前缀已被
  // extractSemanticItems 剥掉时的编号证据），两形态证据都是硬的，给 0.8 档；
  // 防「先A，再B」式口语碎句上卡。
  if (n === 2) {
    return r === 1 || (input.numberedItemRatio ?? 0) >= 0.8 ? Math.max(score, 0.8) : 0;
  }
  return score;
}

/** progress：≥2 条命中百分比/分数且过半 → 按命中比例给分。 */
function scoreProgress(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const valueHits = items.filter((it) => VALUE_RE.test(it.text)).length;
  const r = ratio(valueHits, n);
  return valueHits >= 2 && r >= 0.5 ? r : 0;
}

/** carousel：多数条目内嵌图片 URL → 前端横滑轮播。 */
function scoreCarousel(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  // 恰好两条 A/B 标签的带图条目是 compare 双图滑杆的典型载荷
  // （前后对比/两两对比），轮播不抢——3 条以上才轮播。
  if (n === 2) {
    const labels = items.map((it) => AB_LABEL_RE.exec(it.text.trim())?.[1]?.toUpperCase() ?? null);
    if (labels.includes("A") && labels.includes("B")) return 0;
  }
  const imgHits = items.filter((it) => IMAGE_URL_RE.test(it.text)).length;
  const r = ratio(imgHits, n);
  return r >= 0.8 ? r : 0;
}

/**
 * timeline（内容判定）：多数条目以时间标记开头 → 时间轴。
 * 与 metric 并行评分：`09:00 xxx` 也能匹配「标签:数值」，由得分决胜负。
 * 2 条目场景门槛收紧：必须全部命中且都带钟点（X点/HH:mm）——「上午10点例会，
 * 下午3点见客户」上卡；「明天下雨，后天放晴」这类日期泛指不上卡。
 */
function scoreTimeline(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const timeHits = items.filter((it) => TIME_MARK_RE.test(it.text.trim())).length;
  const r = ratio(timeHits, n);
  if (r < 0.6) return 0;
  if (n === 2 && !(r === 1 && items.every((it) => CLOCK_MARK_RE.test(it.text)))) return 0;
  return r;
}

/**
 * metric：2-6 条全部为「短标签：数值(+单位)」——关键指标面板。
 * 口语无冒号变体：≥3 条「标签+数值+单位」（重量199克 / 北京25度），标签以
 * 了/过/着 结尾的动作短语（等了30分钟）不算，防止把活动流水当数据面板。
 * 百分比不算口语单位——「湿度 60%」类条目是 progress 的领域，由 progress 承接。
 */
function scoreMetric(input: DisplayRouteInput): number {
  const n = input.items.length;
  if (n < 2 || n > 6) return 0;
  if (input.items.every((it) => METRIC_ITEM_RE.test(it.text.trim()))) return 1;
  if (n >= 3 && input.items.every((it) => isNarrativeMetricItem(it.text.trim()))) return 0.85;
  return 0;
}

/** 口语指标条目：短标签（≤8 字，可带 是/为）+ 数值 + 单位（≤4 字，非百分比）。 */
function isNarrativeMetricItem(t: string): boolean {
  // 子句碎片带尾部句读（"重量199克，"），评分前剥离
  const s = t.replace(TRAILING_PUNCT_RE, "").trim();
  const m = s.match(
    /^(\D{1,8}?)(?:是|为)?\s*[+\-−±]?\d+(?:\.\d+)?(?:\s*[+\-−±]\d+(?:\.\d+)?)?\s*[一-龥a-zA-Z°]{1,4}$/,
  );
  if (!m) return false;
  const label = m[1].replace(/[是为]$/, "").trim();
  if (!label) return false;
  // 动作短语（等了/喝了/走了）不是指标标签
  return !/[了过着]$/.test(label);
}

/** fold_list：长清单（≥8 条）折叠展示，避免刷屏；条数越多分越高。 */
function scoreFoldList(input: DisplayRouteInput): number {
  const n = input.items.length;
  return n >= FOLD_MIN_ITEMS ? clamp01(0.6 + (n - FOLD_MIN_ITEMS) / 20) : 0;
}

/**
 * chips：≥4 条短标签。允许 ≤1 条非标签混入（纯标签占比 ≥0.8）——顿号切分
 * 后首条常带引导词（"去超市需要买：苹果"），其余是纯标签。
 * 排除信号（结构化条目不是标签）：句末标点、百分比/分数、
 * 含数字（`清单条目 1`/`09:00 起床`）、时间前缀（`周一 开会`）。
 */
function scoreChips(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 4) return 0;
  const tagHits = items.filter((it) => isShortTag(it.text.trim())).length;
  const r = ratio(tagHits, n);
  return tagHits >= 4 && r >= 0.8 ? r : 0;
}

function isShortTag(t: string): boolean {
  return (
    t.length > 0 &&
    t.length <= CHIP_MAX_LEN &&
    !/[。！？；，、：]/.test(t) &&
    !VALUE_RE.test(t) &&
    !/\d/.test(t) &&
    !TIME_MARK_RE.test(t)
  );
}

/**
 * quote：无条目且 title 是引用式单句（结构化载荷直发场景；
 * markdown 引用块路径由 formatter 的 extractQuoteSegment 走，不经过这里）。
 */
function scoreQuote(input: DisplayRouteInput): number {
  const t = input.title.trim();
  return input.items.length === 0 && t && (QUOTE_TITLE_RE.test(t) || QUOTE_LEAD_RE.test(t)) ? 1 : 0;
}

/**
 * 文本 A/B 对比双栏卡（cardType = "comparison_table"）：
 * 条目呈 A/B 标签成对出现（裸 A/B 开头，或「方案A：…」「产品B：…」带前缀
 * 冒号形态），两侧各 ≥1 条即构成可双栏展示的文本对比。
 * 与 compare（双图滑杆）的分工：滑杆必须两侧各有可解析图片——条目含图片
 * URL 时本评分器让位；纯文本对比不再落进「路由到 compare → 前端静默回退
 * 通用卡」的断链。
 */
/**
 * 带前缀词的 A/B 条目：「方案A…」「产品B：…」——选项枚举形态。裸 A/B 由
 * AB_LABEL_RE 承接；带前缀词的形态（compare 的 abPair 刻意不认，避免把
 * 普通清单当 A/B 对峙）在 comparison_table 里恰恰是对比表想要的成对结构。
 */
const AB_COLUMN_RE = /^(?:方案|产品|选项|品牌|款)\s*([ABab])(?![A-Za-z0-9])/;

function scoreComparisonTable(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  // 含图片 URL 的条目是 compare 双图滑杆的领域，文本对比卡不抢
  if (items.some((it) => IMAGE_URL_RE.test(it.text))) return 0;
  let a = 0;
  let b = 0;
  for (const it of items) {
    const t = it.text.trim();
    let label = AB_LABEL_RE.exec(t)?.[1]?.toUpperCase() ?? null;
    if (!label) {
      label = AB_COLUMN_RE.exec(t)?.[1]?.toUpperCase() ?? null;
    }
    if (label === "A") a++;
    else if (label === "B") b++;
  }
  // 两侧各 ≥2 条：结构完整的对比表
  if (a >= 2 && b >= 2) return 0.9;
  // 两侧各 ≥1 条：两行薄对比（「A便宜些 / B性能强」）
  if (a >= 1 && b >= 1) return 0.65;
  return 0;
}

/**
 * compare 内容形态（双图对比滑杆）：多数条目带明确对比词，或条目呈 A/B
 * 标签对峙——但滑杆必须两侧各有一张可解析图片，条目不含任何图片 URL 时
 * 返回 0（纯文本对比由 comparison_table 承接，避免「路由到 compare 但
 * 前端因无图回退通用卡」的路由-渲染断链）。
 */
function scoreCompare(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  if (!items.some((it) => IMAGE_URL_RE.test(it.text))) return 0;
  const cmpHits = items.filter((it) => COMPARE_MARK_RE.test(it.text)).length;
  const r = ratio(cmpHits, n);
  const labels = items.map((it) => AB_LABEL_RE.exec(it.text.trim())?.[1]?.toUpperCase() ?? null);
  // 恰好两条 A/B 带图条目（前后对比）是滑杆的标志性载荷，给足置信；
  // 3 条以上带图 A/B 更适合轮播/图廊，只给常规对峙分。
  const abPair =
    labels.includes("A") && labels.includes("B") ? (n === 2 ? 0.9 : 0.55) : 0;
  return Math.max(r >= 0.6 ? r : 0, abPair);
}

/** 日程标记（旅游行程形态）：条目以 第X天 / Day N 开头。 */
const DAY_MARK_RE = /^(?:第\s*[一二三四五六七八九十百\d]+\s*天|day\s*\d+\b)/i;

/**
 * travel_itinerary 内容亲和评分：仅 travel.* 强工具在场时计分——工具划定
 * 场景，条目形态（第X天/Day N/编号列表）提供内容证据，两者互证才给分，
 * 无工具时恒为 0（普通编号清单绝不误判成行程卡）。
 *
 * 动机：编号行程（1. 2. 3. / 第1天…）按形态是合法 steps（编号占比 ≥0.8 →
 * 分 1 → 0.78），会压过 travel_itinerary 的纯工具分 0.45，导致 formatter
 * 丢失 travelPlan 结构化注入、双面板行程卡退化为通用步骤卡。
 */
function scoreTravelItinerary(input: DisplayRouteInput): number {
  if (!(input.toolName ?? "").trim().toLowerCase().startsWith("travel.")) return 0;
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const dayHits = items.filter((it) => DAY_MARK_RE.test(it.text.trim())).length;
  const r = ratio(dayHits, n);
  let score = r >= 0.5 ? Math.max(r, 0.8) : 0;
  if ((input.numberedItemRatio ?? 0) >= 0.6) score = Math.max(score, 0.9);
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容语义提取与意图评分（不依赖列表语法，兑现「内容信号为主判据」）
// ─────────────────────────────────────────────────────────────────────────────

/** 语义条目有效性：非标题引导行、非问句、非纯语气、长度适中。 */
function isValidSemanticEntry(entry: string): boolean {
  const t = entry.trim();
  if (t.length < 2 || t.length > 80) return false;
  // 标题/列表引导行（如「屏幕参数：」「你的兴趣标签：」）不当作条目
  if (/[：:]\s*$/.test(t)) return false;
  if (/[？?]\s*$|们?\s*(呢|啊|哦)\s*$|^(好的|好的呀|嗯|好的呢|好滴|没问题)\b/.test(t)) return false;
  return true;
}

/** 条目尾部句读（句号/分号/逗号等）在子句切分时残留在条目尾部，剥离后再入库。 */
const TRAILING_PUNCT_RE = /[。！？!?；;，,、.]+$/;

/** 分项引导词切分点（在逗号前一个引导词处断开）。 */
const SEMANTIC_SPLIT_RE =
  /[，,](?=一是|二是|三是|四是|五是|首先|其次|再次|最后|然后|接着|其一|其二|其三|第一|第二)/;

/** 句/短句切分点：句号、分号、逗号、顿号后的位置（仅作用于非列表行，不拆列表条目）。
 * 顿号列举（"苹果、香蕉、橙子、牛奶"）是中文最高频的并列形态，必须切开才能
 * 被语义路径看见；但「中文数字+顿号」（一、二、）是序号而非并列，不切——
 * 否则行内枚举"…：一、交报表；二、…"的步骤信号会被劈碎。
 * 子句碎片保留尾部句读，chips 的标点护栏照常生效。 */
const SEMANTIC_CLAUSE_RE =
  /(?<=[。；;，,])\s*|(?<=[、])(?<![一二三四五六七八九十]、)\s*/;

/**
 * 从原始全文掐出语义条目，不依赖 `-`/`1.` 列表符号。
 *
 * 按「行 → 分项引导词 → 句号/分号」逐级切分，再过滤无效片段（问句、
 * 纯语气、过长/过短行）。适合 LLM 用分层叙述、一是…二是…、首先…最后…、
 * 顿号列举等自然表达时，仍然能提取出可评分的条目集。
 *
 * @param text 原始全文
 * @returns 语义条目正文数组（已剥列表前缀、不含编号）
 */
export function extractSemanticItems(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const out: string[] = [];

  for (const raw of lines) {
    // 已是列表行 → 剥前缀作为单条目，不继续拆
    const listMatch = raw.match(LIST_ITEM_RE);
    if (listMatch) {
      const text_ = raw.slice(listMatch[0].length).replace(TRAILING_PUNCT_RE, "").trim();
      if (isValidSemanticEntry(text_)) out.push(text_);
      continue;
    }
    // 序号标题行（一、二、 / 1. / #）：本身是条目
    if (/^(?:[一二三四五六七八九十]{1,3}[、.．]|#+\s+)\S+/.test(raw)) {
      const text_ = raw
        .replace(/^(?:[一二三四五六七八九十]{1,3}[、.．]|#+\s+)/, "")
        .replace(TRAILING_PUNCT_RE, "")
        .trim();
      if (isValidSemanticEntry(text_)) out.push(text_);
      continue;
    }
    // 只取有实质句子的行（过滤纯标题短句、过渡语）
    const segments = raw.split(SEMANTIC_SPLIT_RE);
    for (const seg of segments) {
      const clauses = seg.split(SEMANTIC_CLAUSE_RE).map((s) => s.trim()).filter(Boolean);
      for (const clause of clauses) {
        // 剥尾部顿号：顿号切分的并列项（"香蕉、"）顿号残留会让 chips 的
        // 标点护栏全部拒判。
        let text_ = clause.replace(/[、]+$/, "").trim();
        // 短并列项的句尾句号（"鸡蛋。"）同样剥掉——整条 ≤4 字纯名词短语的
        // 句号是行文习惯而非碎片信号（必须锚定整条，否则长碎片
        // "就可以开吃了。"的尾句号也会被剥掉、伪装成标签）。
        text_ = text_.replace(/^([^，,。！？；;、\d]{1,4})[。．]+$/, "$1").trim();
        if (isValidSemanticEntry(text_)) out.push(text_);
      }
    }
  }
  return out;
}

/** 全文语义意图信号：给对应效果一个内容分加成（0 = 无信号）。 */
const SEMANTIC_INTENT_SCORERS: Readonly<
  Partial<Record<Exclude<DisplayEffectType, "">, (fullText: string) => number>>
> = {
  // steps：只认成套的顺序话语标记（≥2 个不同标记才给意图分）。
  // 「先/再」单独出现只是口语连接词，不构成步骤语义（真实误判案例：
  // 「你先看看合不合口味…我再往红毯活动造型那边翻翻」这句纯闲聊曾被
  // 切成 8 条编号碎片上步骤卡）——降级为辅助证据：仅在已有一个强标记
  // （首先/然后/最后/第X步…）时参与计数，保住「先A，再B，最后C」这类
  // 真步骤叙述；真教程/流程带列表语法的由形态评分器承接。
  steps: (t) => {
    const markers = new Set(
      t.match(/(?:首先|其次|再次|然后|接着|最后|第[一二三四五六七八九十百\d]+步)/g) ?? [],
    );
    if (markers.size >= 2) return 0.62;
    // 辅助证据：已有强标记时，「先/再」可补足第二个标记（"先A，再B，最后C"）
    if (markers.size >= 1 && /先|再/.test(t)) return 0.62;
    return 0;
  },
  compare: (t) =>
    // 词表见 render-scoring.COMPARISON_INTENT_RE（两层路由共用，含中文 \b
    // 边界陷阱的处理说明：\b 只追在 vs/pk 之后，中文词后不能用）。
    // 另：compare 卡是双图滑杆，正文不含图片 URL 时意图分归零——纯文本
    // 对比由 comparison_table 按形态承接，避免路由到 compare 后前端因无图
    // 静默回退通用卡的路由-渲染断链。
    /https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#]\S*)?/i.test(t) &&
    COMPARISON_INTENT_RE.test(t)
      ? 0.62
      : 0,
  timeline: (t) =>
    /(?:周[一二三四五六日天]|今天|明天|后天|昨天|\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}|先后|之后|安排|日程)/i.test(t)
      ? 0.45
      : 0,
  // metric：只认「标签 + 冒号 + 数值」结构，避免「9点开会/2本书/50元」等闲聊被误判成数据卡
  metric: (t) => {
    const pairs = (t.match(/[^：:\n，。,]{1,14}[：:]\s*[+\-−±]?\d[\d,.，]*\s*\S{0,6}/g) ?? []).length;
    return pairs >= 2 ? 0.5 : 0;
  },
};

/**
 * 从 fullText 提取语义条目（每次评分只提取一次，供双表征形态评分复用）。
 * 返回 null 表示无 fullText 或没有可用语义条目。
 */
function extractSemanticItemsOnce(
  input: DisplayRouteInput,
): Array<{ text: string; type: string }> | null {
  if (!input.fullText) return null;
  const semantic = extractSemanticItems(input.fullText).map((text) => ({ text, type: "num" }));
  return semantic.length > 0 ? semantic : null;
}

/**
 * 全文语义意图分：对指定效果查询 fullText 的意图信号。
 * 形态分不足但语义意图明确时，作为 contentScore 的兜底加成。
 */
function semanticIntentScore(type: Exclude<DisplayEffectType, "">, input: DisplayRouteInput): number {
  if (!input.fullText) return 0;
  return SEMANTIC_INTENT_SCORERS[type]?.(input.fullText) ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合与决策
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对所有候选效果并行评分，返回评分明细分（按 CANDIDATE_ORDER 排序，
 * 仅含 contentScore 或 toolScore 任一 >0 的候选）。
 * 独立导出：路由决策可观测、可测试；也是 routeDisplayEffect 的唯一数据源。
 */
export function scoreDisplayEffects(
  input: DisplayRouteInput,
  opts: { semanticIntent?: boolean } = {},
): DisplayEffectScore[] {
  const { semanticIntent = true } = opts;
  const toolSignal = matchToolSignal((input.toolName ?? "").trim());
  const results: DisplayEffectScore[] = [];
  // 双表征：语义条目只提取一次，与结构化条目并行参与形态评分
  const semanticItems = extractSemanticItemsOnce(input);

  const addCandidate = (type: DisplayEffectType) => {
    if (type === "") return;
    const scorer = CONTENT_SCORERS[type];
    // 双表征形态评分：结构化条目（formatter 从真实列表段掐出的条目）与
    // 语义条目（fullText 按语义掐出的自然表达条目）各自打分取高者——
    // 谁更能揭示内容形态就听谁的。不再用语义碎片「整体替换」结构化条目：
    // 替换会让前导碎句混入条目集，稀释命中比例、打破 metric 的 every()
    // 校验（1.0 掉到 0.5，遇到强工具竞争即丢卡）。
    let contentScore = scorer?.(input) ?? 0;
    if (semanticItems && !SEMANTIC_REEXTRACT_INELIGIBLE.has(type)) {
      const semanticForm = scorer?.({ ...input, items: semanticItems }) ?? 0;
      if (semanticForm > contentScore) contentScore = semanticForm;
    }
    // 全文语义意图兜底（默认开启）：形态不足但意图明确（如"对比/怎么选/首先然后"）
    if (semanticIntent) {
      const intent = semanticIntentScore(type, input);
      if (intent > contentScore) contentScore = intent;
    }
    // 通用容器让位：fold_list/chips 对「内容是什么」零主张，存在指向其他
    // 效果的强工具信号时降权，不抢工具专属卡（真实误判案例：search_web 的
    // 9 条结果被 fold_list 以 0.507 vs 0.45 抢走）。弱工具只是倾向分，不触发。
    if (
      GENERIC_CONTAINER_EFFECTS.has(type) &&
      toolSignal?.strength === "strong" &&
      toolSignal.effect !== type
    ) {
      contentScore *= GENERIC_CONTAINER_DISCOUNT;
    }
    const toolScore = toolSignal && toolSignal.effect === type ? toolSignal.score : 0;
    if (contentScore <= 0 && toolScore <= 0) return;
    results.push({
      type,
      contentScore,
      toolScore,
      score: aggregateScore(contentScore, toolScore),
    });
  };

  // 1) 内容型候选：全部并行评分（CANDIDATE_ORDER 顺序即平局兜底次序）
  for (const type of CANDIDATE_ORDER) addCandidate(type);
  // 2) 纯工具型候选（weather/schedule/wallet/order/file/search_result/media 等，
  //   无内容评分器）：工具命中时追加为候选
  if (toolSignal && !CANDIDATE_ORDER.includes(toolSignal.effect)) addCandidate(toolSignal.effect);

  return results;
}

/** 在评分明细上取最高分当选（用于 route* 主入口与语义卡片构造）。 */
function pickBest(scores: DisplayEffectScore[]): DisplayEffectType {
  let best: DisplayEffectType = "";
  let bestScore = 0;
  for (const d of scores) {
    // 严格大于：首个同分者保留
    if (d.score > bestScore + 1e-9) {
      bestScore = d.score;
      best = d.type;
    }
  }
  return best;
}

/**
 * 展示效果动态路由主入口（纯函数）。
 *
 * 在 [scoreDisplayEffects] 明细分上取最高分当选；得分相同（含浮点误差）
 * 时保留顺序靠前者（CANDIDATE_ORDER 兜底）。全部候选 0 分 → 通用列表卡（""）。
 */
export function routeDisplayEffect(input: DisplayRouteInput): DisplayEffectType {
  return pickBest(scoreDisplayEffects(input));
}

/**
 * 纯形态路由：关闭全文语义意图加成，仅凭条目形态/结构判定。
 * 用于「普通文本/长文 → 内容卡片」路径的守门——只有显而易见的结构化内容
 * （步骤/指标/折叠/时序/对比标签等）才上卡，避免闲聊因弱意图被误判成卡片。
 */
export function routeDisplayEffectByForm(input: DisplayRouteInput): DisplayEffectType {
  return pickBest(scoreDisplayEffects(input, { semanticIntent: false }));
}

/**
 * 是否存在 markdown 引用块（> 开头且剥掉标记后仍有实质内容的行）。
 * 供 tool-result-processor 决定是否走引用卡提取（纯程序路由，无 LLM）。
 */
export function hasBlockquote(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((raw) => {
      const t = raw.trim();
      if (!t.startsWith(">")) return false;
      return t.replace(/^>\s*/, "").trim().length >= 4;
    });
}