/**
 * 渲染形态判断中心
 *
 * 把 LLM 的隐式输出形态显式化为渲染提示，
 * 供 `ToolResultProcessor.processAssistantText` 决定注入哪种卡片标记。
 *
 * 路由（竞争评分制，与 display-effect-router 同一套方法论，无硬优先级链）：
 *   候选形态并行评分 → 内容分为主判据（权重见 render-scoring.ts）、工具分兜底
 *   → 最高分当选 → 最高分低于 plain 门槛时回落普通正文。候选形态：
 *   - image_text    图片识别/OCR 场景（识图工具在场即形态成立，场景唯一）
 *   - long_text     搜索工具（search_web/info.*）：正文由模型总结，不出搜索卡
 *   - result_card   小汇报场景（≤300 字 + 列表；媒体搜索/天气工具有场景加成）
 *   - brief         简报增强（≤300 字 + 引导行 + 列表的晨报/资讯结构）
 *   - summary_card  长内容（≥800 字 + 结构化：板块/表格/列表+段落 → 折叠摘要）
 *   - long_text     其余长内容（≥300 字 / 意图 / 表格 → 结构化富文本）
 *   - plain         低于门槛的回落（闲聊、无结构短文、能力 dump）
 *
 * data_brief 已退役（2026-11-06 用户定稿）：KPI 网格卡对真实正文的标签截断
 * / 排版混乱不可控（出现「昨晚（」「递指涨超」这类碎片标签），数字密集正文
 * 一律按 markdown/普通正文输出，不再切快报卡；payload 提取器一并删除。
 *
 * summary_card 触发设计（2026-08-25 重构）：
 *   - 不再限定搜索工具：整理/对比/调研/攻略类长文（通常非搜索工具）同样折叠；
 *   - 不再排除 intent / 表格：这些恰恰是"标题+要点+详情抽屉"的高价值场景；
 *   - 唯一门槛是「长 + 结构化」：纯长段落（无板块/表格/列表）保持原样走 long_text，
 *     避免把一段话硬拆成摘要卡。
 *
 * 设计要点：
 *   - 不让 LLM 输出 renderHint 元数据（会污染正文且不可靠）
 *   - LLM 通过输出结构本身声明意图，本模块做显式化识别
 *   - 纯规则判断，无 LLM 调用，延迟 <1ms
 */


export type RenderHintType =
  | "plain"
  | "result_card"
  | "summary_card"
  | "long_text"
  | "image_text"
  | "brief";

export interface RenderHint {
  type: RenderHintType;
  /** 命中原因，便于日志排查 */
  reason: string;
  /** 是否因意图关键词触发结构化 */
  intent?: boolean;
}

export interface RenderHintContext {
  /** 最近一次调用的工具名，用于增强判断（如 weather.get_local 强制走小卡片） */
  toolName?: string;
  /** 用户原话，辅助判断是否为对话式回复 */
  userText?: string;
}

/** result_card 字数上限：超过则不算"小汇报"场景（整段对话 + 列表 + 追问） */
const RESULT_CARD_MAX_CHARS = 300;

/** 图片地址（2 条图片对列表判定用，与 display-effect-router 同一识别口径） */
const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#]\S*)?/i;
/** 结构化富文本字数下限：>300 字符倾向输出 Markdown 富文本 */
const STRUCTURED_TEXT_MIN_CHARS = 300;
/** summary_card 字数下限：≥800 字的长内容才考虑折叠（2026-10-28 定版，
 *  与 content-summary-service 同值；400 门槛过低导致短回复也出折叠卡） */
const SUMMARY_MIN_CHARS = 800;

/** 意图语义关键词：用户提问携带这些词 → 无视短字数，强制结构化富文本 */
const INTENT_KEYWORDS_RE =
  /整理|对比|总结|方案|清单|步骤|脑图|表格|分析|比较|规划|计划|推荐|排行|排名|区别|异同|优缺点|攻略|分类|归纳|梳理|教程/i;

/** 列表行正则：- / * / • / 1. / 1) / 1、 */
export const LIST_ITEM_RE = /^(?:[-*•]\s+|\d+[.)、]\s+)/u;

/** 天气汇报特征词 */
const WEATHER_HINT_RE = /°C|°|摄氏|气温|温度|天气|晴|阴|雨|雪|风\s*力|湿度/i;

/** 任务完成汇报关键词 */
const TASK_DONE_RE =
  /已为你|已完成|已规划|已创建|已设置|已整理|已安排|已添加|已删除|已更新|已帮你|已发/i;

/** 工具能力 dump（如「当前可用工具列表」），不应走卡片 */
const CAPABILITY_DUMP_RE =
  /当前可用.*工具|【宿主能力|【Agent World】|wallet\.|search_web|master_invoke/i;

/** 图片/视觉类工具正则 */
const IMAGE_TOOL_RE = /vision|image|photo|识图|图片|ocr|screenshot|capture/i;

const MEDIA_SEARCH_TOOLS = new Set(["search_images", "search_videos"]);

/** 搜索工具集合 */
const SEARCH_ELIGIBLE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "search_web",
  "fetch_web",
  "info.search",
  "info.read_webpage",
  "info.inspect_webpage",
  "info.navigate_site",
]);

function isSearchTool(toolName?: string): boolean {
  return !!toolName && SEARCH_ELIGIBLE_TOOLS.has(toolName);
}

function isImageTool(toolName?: string): boolean {
  if (toolName && MEDIA_SEARCH_TOOLS.has(toolName)) return false;
  return !!toolName && IMAGE_TOOL_RE.test(toolName);
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染形态判定（2026-09-16 打分层退役）：确定性规则链，首条命中即返回。
//
// 此前是候选形态并行竞争评分（内容分+工具分、plain 地板、平局序），实践证明
// 对日常中文对话的命中率极低且不可解释，已整体退役。现在的形态来源：
//   L1 工具绑定（tool-card-registry / attach* 确定性建卡，不经此处）
//   L2 模型声明（[RENDER_HINT:] / 卡片 JSON，processor 优先级 0 直通）
//   规则链（本函数）：只有硬信号才产生形态——工具在场 / KPI 计数 /
//   长文档折叠 / 列表切卡；无信号一律 plain。
// ─────────────────────────────────────────────────────────────────────────────

/** 形态判定共享信号（一次计算，规则链各分支共用）。 */
interface HintScoringContext {
  text: string;
  len: number;
  list: ListAnalysis;
  structural: ContentStructure;
  hasTable: boolean;
  hasIntent: boolean;
  /** 长结构化文档：有板块/表格且 ≥800 字（直接折叠摘要）。 */
  isLongDoc: boolean;
  isImageTool: boolean;
  isSearchTool: boolean;
  isMediaSearchTool: boolean;
  isWeatherTool: boolean;
}

function buildHintScoringContext(text: string, ctx?: RenderHintContext): HintScoringContext {
  const list = analyzeListStructure(text);
  const structural = analyzeContentStructure(text);
  const isWeatherTool = !!ctx?.toolName && ctx.toolName.startsWith("weather.");
  return {
    text,
    len: text.length,
    list,
    structural,
    hasTable: hasMarkdownTable(text),
    hasIntent: !!ctx?.userText && INTENT_KEYWORDS_RE.test(ctx.userText),
    isLongDoc:
      (structural.sectionCount >= 1 || hasMarkdownTable(text)) &&
      text.length >= SUMMARY_MIN_CHARS,
    isImageTool: isImageTool(ctx?.toolName),
    isSearchTool: isSearchTool(ctx?.toolName),
    isMediaSearchTool: !!ctx?.toolName && MEDIA_SEARCH_TOOLS.has(ctx.toolName),
    isWeatherTool,
  };
}

/**
 * 判断一段 assistant 文本应使用何种渲染形态（确定性规则链，首条命中即返回）。
 *
 * 规则顺序即优先级（每条都是硬信号，无评分、无竞争、无 plain 地板）：
 *   1. image_text    识图/OCR 工具在场（工具绑定语义）
 *   2. long_text     搜索工具在场 → 结构化富文本（不出搜索卡/来源清单）
 *   3. result_card   短文本（≤300 字）+ 3-12 条列表（markdown 列表切卡）
 *   4. summary_card  ≥800 字 + 结构化（板块/表格/列表混排）→ 折叠摘要
 *   5. long_text     意图/表格触发，或 ≥300 字长文（结构化富文本）
 *   6. plain         无硬信号 → 纯文本（不硬塞形态）
 *
 * brief 不在规则链：定时简报有独立注入路径；对话内 brief 只认 L2 模型声明。
 * data_brief 已退役（2026-11-06）：数字密集正文一律按 markdown/普通正文输出。
 *
 * @param text LLM 最终输出文本（未经标记注入）
 * @param ctx  上下文（工具名、用户原话等）
 */
export function classifyRenderHint(
  text: string,
  ctx?: RenderHintContext,
): RenderHint {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { type: "plain", reason: "empty" };
  }

  // 已带标记的直接放行（理论上不会进来，兜底）
  if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) {
    return { type: "plain", reason: "already-marked-summary" };
  }
  if (trimmed.includes("[AGENT_RESULT_CARD_START]")) {
    return { type: "plain", reason: "already-marked-result" };
  }

  // 工具能力 dump 强制走纯文本
  if (CAPABILITY_DUMP_RE.test(trimmed) && trimmed.split("\n").length >= 8) {
    return { type: "plain", reason: "capability-dump" };
  }

  const sc = buildHintScoringContext(trimmed, ctx);
  const hit = (type: RenderHintType, reason: string, intent?: boolean): RenderHint => ({
    type,
    reason: `${reason},len=${trimmed.length}`,
    intent,
  });

  // 1. 识图/OCR：工具在场即形态成立
  if (sc.isImageTool) return hit("image_text", "image-tool-present");

  // 2. 搜索工具：**不切搜索卡**，正文一律走结构化富文本（2026-11-05 用户定稿）。
  //    搜索回执只作为模型上下文，由模型自己总结；禁止「搜索结果」卡、来源清单
  //    或原始条目出现在任一客户端（桌面端/手机端一致）。
  if (sc.isSearchTool) return hit("long_text", "search-tool-summary", true);

  // 3. 短文本 + markdown 列表 → 列表切卡（findExtractableCardSegment 承接）
  //    data_brief 已退役（2026-11-06）：数字密集但无列表的正文直接落到
  //    后面的 summary_card / long_text / plain，按 markdown 排版输出。
  if (sc.len <= RESULT_CARD_MAX_CHARS && !sc.hasTable) {
    const n = sc.list.itemCount;
    if (n >= 3 && n <= 12) return hit("result_card", `list=${n}`);
    // 2 条但每条都带图片地址：compare 滑杆/双图对比的标志性载荷（媒体硬信号）
    if (
      n === 2 &&
      sc.list.items.length === 2 &&
      sc.list.items.every((t) => IMAGE_URL_RE.test(t))
    ) {
      return hit("result_card", "image-pair-list");
    }
    if (
      !sc.hasIntent &&
      n >= 2 &&
      TASK_DONE_RE.test(sc.text)
    ) {
      return hit("result_card", `task-done-list=${n}`);
    }
  }

  // 4. 长文档折叠：≥800 字 + 结构化（板块/表格/列表混排）
  //    「有没有专属卡」不在这里判断——决策层看到结构化面就不会走到这一步。
  if (sc.len >= SUMMARY_MIN_CHARS && sc.structural.structured) {
    return hit("summary_card", "long-structured-doc");
  }

  // 5. 结构化富文本：意图/表格触发（不设字数下限），或 ≥300 字长文
  if (sc.hasIntent || sc.hasTable) {
    return hit("long_text", "intent-or-table", true);
  }
  if (sc.len >= STRUCTURED_TEXT_MIN_CHARS) {
    return hit("long_text", `len=${sc.len}`);
  }

  return { type: "plain", reason: "no-hard-signal" };
}

/**
 * 文本结构分析：板块（markdown 标题 + 中文/数字序号标题）、列表、表格、普通段落。
 * summary_card 的"结构化"判定依据：有板块 / 有表格 / 列表+段落混排。
 */
export interface ContentStructure {
  /** 板块标题行数（# 标题、一、二、中文序号、数字+、序号节） */
  sectionCount: number;
  /** 列表行数（- * • / 1. 1) 1、） */
  listCount: number;
  /** 是否含 markdown 表格 */
  hasTable: boolean;
  /** 普通段落行数（排除标题/列表/表格行后 >0 的非空行） */
  paragraphCount: number;
  /** 是否有可供摘要折叠的结构化骨架 */
  structured: boolean;
}

/** 板块标题行：markdown 标题（#...）或中文序号标题（一、）或「N、」节标题。
 *  序号后的空白可选——中文标题惯例是「一、市场概况」紧排版，若强制 \s+
 *  会把最常见的中文板块结构漏算成普通段落。 */
export const SECTION_HEADING_RE =
  /^(?:#{1,6}\s+\S|[一二三四五六七八九十]{1,3}[、.．]\s*\S|\d{1,2}[、.．](?!\d)\s*\S)/;

export function analyzeContentStructure(text: string): ContentStructure {
  const lines = text.split(/\r?\n/);
  let sectionCount = 0;
  let listCount = 0;
  let paragraphCount = 0;
  let tableLikeLines = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (SECTION_HEADING_RE.test(line)) {
      sectionCount++;
      continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      listCount++;
      continue;
    }
    // 表格行：≥2 个 `|` 分隔符
    if (line.includes("|") && line.split("|").length >= 3) {
      tableLikeLines++;
      continue;
    }
    paragraphCount++;
  }

  const hasTable = tableLikeLines >= 2 || hasMarkdownTable(text);
  const structured =
    sectionCount >= 1 || hasTable || (listCount >= 3 && paragraphCount >= 1);

  return { sectionCount, listCount, hasTable, paragraphCount, structured };
}

/**
 * 分析文本的列表结构，返回列表行与非列表行。
 */
export interface ListAnalysis {
  itemCount: number;
  /** 非列表行（可能作为 title / footer） */
  nonListLines: string[];
  /** 列表项文本（已去掉前缀符号） */
  items: string[];
}

export function analyzeListStructure(text: string): ListAnalysis {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: string[] = [];
  const nonListLines: string[] = [];

  for (const line of lines) {
    const match = line.match(LIST_ITEM_RE);
    if (match) {
      items.push(line.slice(match[0].length).trim());
    } else {
      nonListLines.push(line);
    }
  }

  return {
    itemCount: items.length,
    nonListLines,
    items,
  };
}

/**
 * 判断文本是否含标准 Markdown 表格：≥2 行带 ≥2 个 `|` 分隔符的行
 * （表头 + 分隔行即满足，如 `| a | b |` + `|---|---|`）。
 */
export function hasMarkdownTable(text: string): boolean {
  let rowCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) continue;
    // 至少 2 个 | 分隔符 → 3 格以上，视为表格行
    if (trimmed.split("|").length >= 3) {
      rowCount++;
      if (rowCount >= 2) return true;
    }
  }
  return false;
}
