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
 *   - search_result 搜索工具结果（3-10 条列表项 → 专用搜索结果卡片）
 *   - data_brief    数据快报（≥3 个 KPI 数据点 + 字数适中，数字密集短文）
 *   - result_card   小汇报场景（≤300 字 + 列表；媒体搜索/天气工具有场景加成）
 *   - brief         简报增强（≤300 字 + 引导行 + 列表的晨报/资讯结构）
 *   - summary_card  长内容（≥800 字 + 结构化：板块/表格/列表+段落 → 折叠摘要）
 *   - long_text     其余长内容（≥300 字 / 意图 / 表格 → 结构化富文本）
 *   - plain         低于门槛的回落（闲聊、无结构短文、能力 dump）
 *
 * data_brief 触发设计（2026-08-25 新增）：
 *   - 面向「数字密集」内容：行情速报、指标对比、统计总结、评测打分等，
 *     渲染为 结论 + KPI 网格 + 详情 的数据快报卡，避免数字淹没在段落里；
 *   - 边界：weather.* 工具走专用天气小卡片；有板块/表格的「长结构化文档」
 *     仍归 summary_card 折叠（文档结构 > 数据速览）；<60 字的一句带数字闲聊不触发。
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
  | "search_result"
  | "long_text"
  | "image_text"
  | "brief"
  | "data_brief";

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
/** data_brief 字数下限：短到一句话带数字的闲聊不触发 */
const DATA_BRIEF_MIN_CHARS = 60;
/** data_brief KPI 数据点下限：≥3 个数字/百分比/指标才算「数据快报」 */
const DATA_BRIEF_MIN_KPIS = 3;
/** data_brief 字数上限：超过则视为长文正文，不塞进快报卡 */
const DATA_BRIEF_MAX_CHARS = 800;

/**
 * 数据 KPI 数据点正则（data_brief 判定 + payload 提取共用检测）。
 * 两类 token 计数（引擎从左到右消费，互不重叠）：
 *   A. 数字 + 数据单位：12.5% / 3.2万亿 / 3567 点 / 85 元 / +1.23%
 *   B. 数据动词 + 数字：成交额 5600 / 同比增长 15%（单位缺失时的补救）
 */
const DATA_TOKEN_RE =
  /(?:[+\-−±]?\d[\d,]*(?:\.\d+)?\s*(?:%|万亿|亿元|万元|亿|万|点|元|美元|港元|台|辆|人次|公里|千米|度|级|倍|秒|分|小时|篇|条|家))|(?:(?:上涨|下跌|增长|下降|下滑|攀升|回落|同比|环比|净流入|净流出|成交额|成交|市值|营收|利润|评分|得分|涨幅|跌幅)\s*[:：]?\s*[+\-−±]?\d)/g;

/** 单从句内提取 KPI 值（单位可缺省，如「创业板指 2876.54（+2.01%）」） */
const DATA_VALUE_RE =
  /[+\-−±]?\d[\d,]*(?:\.\d+)?\s*(?:%|万亿|亿元|万元|亿|万|点|元|美元|港元|台|辆|人次|公里|千米|度|级|倍|秒|分|小时|篇|条|家)?/;

/** 从句内提取涨跌幅变化（带符号百分比） */
const DATA_CHANGE_RE = /[+\-−±]\d+(?:\.\d+)?%/;
/** 纯涨跌方向词（不作为独立 KPI 标签，而是挂到上一 KPI 的 change，如「涨 +1.23%」） */
const CHANGE_WORD_ONLY_RE =
  /^(?:上涨|下跌|上漲|下漲|收涨|收跌|涨|跌|升|降|攀升|回落|走强|走弱|上扬|下挫)$/;
/** 指标标签尾部的动词噪声（如「上证指数收于」→「上证指数」） */
const LABEL_TAIL_VERB_RE = /(?:收于|收报|报收|收在|现报|收盘报|收盘价)$/;
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
  kpiCount: number;
  hasTable: boolean;
  hasIntent: boolean;
  /** 长结构化文档：有板块/表格且 ≥800 字（数据快报让位给折叠摘要）。 */
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
    kpiCount: analyzeDataBrief(text).kpiCount,
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
 *   2. search_result 搜索工具 + 3-10 条列表，且无意图/表格让位
 *   3. data_brief    ≥3 个 KPI 数据点 + 60~800 字 + 非长文档
 *   4. result_card   短文本（≤300 字）+ 3-12 条列表（markdown 列表切卡）
 *   5. summary_card  ≥800 字 + 结构化（板块/表格/列表混排）→ 折叠摘要
 *   6. long_text     意图/表格触发，或 ≥300 字长文（结构化富文本）
 *   7. plain         无硬信号 → 纯文本（不硬塞形态）
 *
 * brief 不在规则链：定时简报有独立注入路径；对话内 brief 只认 L2 模型声明。
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

  // 2. 搜索工具 + 3-10 条列表；意图/表格在场时让位富文本
  if (sc.isSearchTool && !sc.hasIntent && !sc.hasTable) {
    const n = sc.list.itemCount;
    if (n >= 3 && n <= 10) return hit("search_result", "search-tool-list");
  }

  // 3. 数据快报：数字密集适中长文
  if (
    !sc.isWeatherTool &&
    sc.kpiCount >= DATA_BRIEF_MIN_KPIS &&
    sc.len >= DATA_BRIEF_MIN_CHARS &&
    sc.len <= DATA_BRIEF_MAX_CHARS &&
    !sc.isLongDoc
  ) {
    return hit("data_brief", `kpi=${sc.kpiCount}`);
  }

  // 4. 短文本 + markdown 列表 → 列表切卡（findExtractableCardSegment 承接）
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

  // 5. 长文档折叠：≥800 字 + 结构化（板块/表格/列表混排）
  if (sc.len >= SUMMARY_MIN_CHARS && sc.structural.structured) {
    return hit("summary_card", "long-structured-doc");
  }

  // 6. 结构化富文本：意图/表格触发（不设字数下限），或 ≥300 字长文
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
 * 数据快报分析：统计文本中的 KPI 数据点数量（data_brief 判定）。
 * 数据点 = 数字+数据单位（12.5% / 3.2万亿 / 3567 点）或 数据动词+数字（成交额 5600）。
 */
export interface DataBriefAnalysis {
  /** 识别出的 KPI 数据点数量 */
  kpiCount: number;
}

/** 统计文本中的 KPI 数据点数量 */
export function analyzeDataBrief(text: string): DataBriefAnalysis {
  const matches = text.match(DATA_TOKEN_RE) ?? [];
  return { kpiCount: matches.length };
}

/** 判断文本是否含至少一个 KPI 数据点（用于结论句判定） */
function containsDataToken(s: string): boolean {
  const m = s.match(DATA_TOKEN_RE);
  return !!m && m.length > 0;
}

export interface DataBriefPoint {
  /** 指标标签（如「上证指数」「同比」） */
  label: string;
  /** 数值（含单位，如「3567.89 点」「+15%」） */
  value: string;
  /** 可选涨跌幅变化（如「+1.23%」） */
  change?: string;
}

/** 数据快报 payload：结论 + KPI 网格 + 详情正文 */
export interface DataBriefPayload {
  /** 一句话结论（首句且不含 KPI 的短句），可为空 */
  conclusion: string;
  /** KPI 数据点（≤8 个） */
  kpis: DataBriefPoint[];
  /** 完整正文（excluding 结论），供「详情」查看 */
  restText: string;
}

/**
 * 从数据类正文中提取数据快报 payload。
 *
 * 提取策略（确定性、无 LLM）：
 *   1. 结论：首句字数 ≤40 且不含 KPI 数据点 → 作为一句话结论；
 *   2. KPI：按 [。！？!?；;\n] 切句、再按 [，,、；;] 切从句，
 *      从句中取「标签 + 数值（+单位）」，标签必须非空且不含数字；
 *      纯涨跌方向词从句（「涨 +1.23%」）不新建 KPI，挂到上一 KPI 的 change；
 *   3. 涨跌幅：[+−-1.23%] 从句内存在时挂到 change 字段，
 *      若本身就是数值（如「环比 +15%」）则保留为 value；
 *   4. 去重（label|value|change），上限 8 条；
 *   5. 详情：保留原文结构，仅从原文本移除结论句（不重排句子，保住列表/换行）。
 */
export function extractDataBriefPayload(text: string): DataBriefPayload {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return { conclusion: "", kpis: [], restText: "" };

  const sentences = trimmed
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?；;])/))
    .map((s) => s.trim())
    .filter(Boolean);

  let conclusion = "";
  const first = sentences[0];
  if (first && first.length <= 40 && !containsDataToken(first)) {
    conclusion = first.replace(/[。！？!?；;]$/, "");
  }

  const searchPool =
    conclusion && sentences.length > 1 ? sentences.slice(1) : sentences;

  const kpis: DataBriefPoint[] = [];
  const seen = new Set<string>();

  for (const sentence of searchPool) {
    if (kpis.length >= 8) break;
    for (const rawClause of sentence.split(/[，,、；;]/)) {
      if (kpis.length >= 8) break;
      const clause = rawClause.trim();
      if (!clause || clause.length > 80) continue;
      const valueMatch = clause.match(DATA_VALUE_RE);
      if (!valueMatch) continue;
      const idx = valueMatch.index ?? 0;
      // 标签 = 数值前缀文本，剔除前导标点/列表标记/数字序号；若仍含「：」取最后一段语义
      // （如「对比两款手机：A 款」→「A 款」）
      let label = clause
        .slice(0, idx)
        .replace(/^[\s：:，,、;；（(【[「"'、\-*•.．\d]+/, "")
        .trim();
      const lastColon = Math.max(label.lastIndexOf("："), label.lastIndexOf(":"));
      if (lastColon >= 0) label = label.slice(lastColon + 1).trim();
      // 尾部动词噪声（如「收于/报收」）与修饰语（如「为/是」），折叠内部空白
      label = label
        .replace(LABEL_TAIL_VERB_RE, "")
        .replace(/[为是：:]$/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!label || label.length > 20 || /\d/.test(label)) continue;
      if (label.length > 16) label = label.slice(-16);

      let value = valueMatch[0].trim();
      const changeMatch = clause.match(DATA_CHANGE_RE);
      let change: string | undefined;
      if (changeMatch) {
        const ch = changeMatch[0];
        if (value.includes(ch)) {
          const v2 = value.slice(0, value.indexOf(ch)).trim();
          if (v2) {
            value = v2;
          } else {
            value = ch;
            change = undefined;
          }
        } else if (value !== ch) {
          change = ch;
        }
      }
      if (!value) continue;

      // 纯涨跌方向词从句（「涨 +1.23%」「下跌 -0.45%」）：不新建 KPI，
      // 归并到上一 KPI 作为涨跌幅变化，避免出现「涨 / 跌」这类无信息量标签。
      if (CHANGE_WORD_ONLY_RE.test(label) && kpis.length > 0) {
        const previous = kpis[kpis.length - 1];
        if (previous.change == null) {
          previous.change = change ?? value;
        }
        continue;
      }

      const key = `${label}|${value}|${change ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const point: DataBriefPoint = { label, value };
      if (change) point.change = change;
      kpis.push(point);
    }
  }

  const restText =
    conclusion && first.length > 0 ? trimmed.replace(first, "").trim() : trimmed;

  return { conclusion, kpis, restText };
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
