export type ContentCategory =
  | "news"
  | "article"
  | "search_result"
  | "webpage"
  | "document"
  | "code"
  | "data"
  | "list"
  | "multi_section"
  | "table"
  | "general";

export interface BriefPoint {
  icon: string;
  text: string;
  section?: string;
}

export interface ContentSummary {
  id: string;
  category: ContentCategory;
  title: string;
  briefPoints: BriefPoint[];
  detailContent: string;
  cardIcon: string;
  cardLabel: string;
  sections?: SectionInfo[];
  metadata?: {
    source?: string;
    url?: string;
    date?: string;
    author?: string;
    wordCount?: number;
    itemCount?: number;
    sectionCount?: number;
    hasTable?: boolean;
    hasList?: boolean;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface SectionInfo {
  title: string;
  pointCount: number;
}

export interface SummarizeOptions {
  maxLength?: number;
  briefPointCount?: number;
  forceSummary?: boolean;
}

const CATEGORY_CONFIG: Record<ContentCategory, { 
  icon: string; 
  label: string;
  cardIcon: string;
  briefIcons: string[];
}> = {
  news: { 
    icon: "📰", 
    label: "资讯",
    cardIcon: "☰",
    briefIcons: ["🔥", "💡", "⚡", "🚀", "✨", "📌", "🎯", "💬"]
  },
  article: { 
    icon: "📄", 
    label: "文章",
    cardIcon: "☰",
    briefIcons: ["📝", "📖", "🔍", "💭", "⭐", "🎨"]
  },
  search_result: { 
    icon: "🔍", 
    label: "搜索结果",
    cardIcon: "☰",
    briefIcons: ["🔎", "📊", "🌐", "💡", "📋"]
  },
  webpage: { 
    icon: "🌐", 
    label: "网页",
    cardIcon: "☰",
    briefIcons: ["🔗", "📄", "ℹ️", "📍"]
  },
  document: { 
    icon: "📋", 
    label: "文档",
    cardIcon: "☰",
    briefIcons: ["📑", "📝", "📎", "📁"]
  },
  code: { 
    icon: "💻", 
    label: "代码",
    cardIcon: "☰",
    briefIcons: ["⚙️", "🔧", "🐛", "✅", "📦"]
  },
  data: { 
    icon: "📊", 
    label: "调研报告",
    cardIcon: "☰",
    briefIcons: ["📈", "📉", "🗂️", "📌", "🔢"]
  },
  list: {
    icon: "📋",
    label: "清单",
    cardIcon: "☰",
    briefIcons: ["✅", "📌", "🔹", "▸", "•", "→"]
  },
  multi_section: {
    icon: "📑",
    label: "汇总",
    cardIcon: "☰",
    briefIcons: ["📌", "🔖", "📎", "🏷️", "📁", "📂"]
  },
  table: {
    icon: "📊",
    label: "数据表",
    cardIcon: "☰",
    briefIcons: ["📊", "📈", "📉", "📋", "🔢"]
  },
  general: { 
    icon: "📝", 
    label: "详情",
    cardIcon: "☰",
    briefIcons: ["📌", "💡", "⭐", "📋"]
  },
};

/** 低于此字数不启用摘要折叠卡（原 800 过高导致实际对话几乎不触发；现降为 400） */
const SUMMARY_MIN_CHARS = 400;

const CONTENT_SUMMARY_MARKER = "[CONTENT_SUMMARY_V2_START]";

function generateId(): string {
  return `sum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 模型自声明的展示形态标记行（[RENDER_HINT:xxx] / [RENDER_AS:xxx]）。
 * 只属于渲染路由信号，不属于正文——若不在文本开头（extractLlmRenderHint
 * 只剥离首处标记），会随 detailContent 漏进面板/弹窗正文，这里整行剥离。
 */
const RENDER_DECLARATION_LINE_RE = /^[ \t]*\[RENDER_(?:HINT|AS):\w+\][ \t]*$/;

function stripRenderDeclarationLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !RENDER_DECLARATION_LINE_RE.test(line))
    .join("\n")
    .trim();
}

/**
 * detailContent 首行与卡片标题重复时删掉该行：标题（extractTitle）通常
 * 取自正文首行导语，面板/弹窗顶栏已展示标题，正文再复读一遍属于冗余。
 */
function stripLeadingTitleEcho(content: string, title: string): string {
  const titleTrim = title.trim();
  if (!titleTrim) return content;
  const lines = content.split("\n");
  const firstIdx = lines.findIndex((line) => line.trim());
  if (firstIdx === -1) return content;
  const first = lines[firstIdx].trim();
  const firstSansHash = first.replace(/^#{1,3}\s+/, "").trim();
  const echoed =
    first === titleTrim ||
    firstSansHash === titleTrim ||
    (titleTrim.length >= 12 && first.includes(titleTrim));
  if (!echoed) return content;
  lines.splice(firstIdx, 1);
  return lines.join("\n").trim();
}

function looksLikeCapabilityOrToolDump(content: string): boolean {
  const lineCount = content.split("\n").length;
  if (lineCount < 6) return false;
  return (
    /当前可用.*工具|【宿主能力|【Agent World】|wallet\.|search_web|master_invoke/.test(
      content,
    ) && lineCount >= 8
  );
}

/**
 * 摘要折叠资格：仅当内容「长 + 结构化」时启用——与 render-hint-service 的
 * summary_card 判定一致，避免路由到摘要卡却生成失败退回纯文本。
 *
 * 结构化 = 有板块标题（multi_section/多节）/ 有表格 / 列表+段落混排；
 * 纯长段落（无板块无表格无列表）不折叠，保持原样展示。
 */
export function isEligibleForSummaryCard(
  _category: ContentCategory,
  content: string,
  features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    lineCount: number;
    sectionCount: number;
    listItemCount: number;
  },
): boolean {
  if (content.length < SUMMARY_MIN_CHARS) return false;
  if (features.hasSections) return true;
  if (features.hasTable) return true;
  if (features.hasList && features.listItemCount >= 3 && features.lineCount >= 6) return true;
  return false;
}

function detectContentType(content: string): {
  category: ContentCategory;
  features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    hasLongParagraphs: boolean;
    lineCount: number;
    sectionCount: number;
    listItemCount: number;
  };
} {
  const lines = content.split("\n");
  const lineCount = lines.length;
  
  let sectionCount = 0;
  let listItemCount = 0;
  let tableLikeLines = 0;
  let longParaCount = 0;

  const sectionPatterns = [
    /^#{1,3}\s+/,
    /^(一|二|三|四|五|六|七|八|九|十)[、.．]/,
    /^\d+[、.．)\]]/,
    /^(第[一二三四五六七八九十]+[部分章节])/,
    /^\[.*?\]/,
    /^(##|###|####)\s+/,
  ];

  const listPatterns = [
    /^[\s]*[-•*→▸‣⁃◦·]\s+/,
    /^[\s]*\d+[.)]\s+/,
    /^\*\*.+\*\*[:：]/,
    /^[""「『【].+[""」』】]/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of sectionPatterns) {
      if (pattern.test(trimmed)) {
        sectionCount++;
        break;
      }
    }

    for (const pattern of listPatterns) {
      if (pattern.test(trimmed)) {
        listItemCount++;
        break;
      }
    }

    if (trimmed.includes("|") && trimmed.split("|").length >= 4) {
      tableLikeLines++;
    }

    if (trimmed.length > 150 && !listPatterns.some(p => p.test(trimmed))) {
      longParaCount++;
    }
  }

  const hasSections = sectionCount >= 2;
  const hasList = listItemCount >= 3;
  const hasTable = tableLikeLines >= 2 || (content.includes("|") && content.split("\n").filter(l => l.includes("|")).length >= 3);
  const hasLongParagraphs = longParaCount >= 2;

  let category: ContentCategory = "general";

  if (hasSections && sectionCount >= 3) {
    category = "multi_section";
  } else if (hasTable && tableLikeLines > listItemCount) {
    category = "table";
  } else if (hasList && listItemCount > sectionCount * 2) {
    category = "list";
  } else if (hasLongParagraphs && lineCount < 10) {
    category = "article";
  } else if (
    /调研|研究报告|分析报告|行业报告|竞品分析/.test(content) ||
    (/核心结论|数据支撑|研究结论/.test(content) && (hasSections || hasTable))
  ) {
    category = "data";
  } else if (content.includes("新闻") || content.includes("最新") || content.includes("日报")) {
    category = "news";
  } else if (content.includes("搜索") || content.includes("结果")) {
    category = "search_result";
  }

  return {
    category,
    features: {
      hasSections,
      hasList,
      hasTable,
      hasLongParagraphs,
      lineCount,
      sectionCount,
      listItemCount,
    }
  };
}

function detectCategory(content: string, source?: string): ContentCategory {
  const lowerSource = (source ?? "").toLowerCase();

  if (lowerSource.includes("news")) return "news";
  if (lowerSource.includes("search")) return "search_result";
  if (
    lowerSource.includes("report") ||
    lowerSource.includes("research") ||
    lowerSource.includes("survey")
  ) {
    return "data";
  }

  return detectContentType(content).category;
}

function extractTitle(content: string, category: ContentCategory): string {
  const lines = content.split("\n").filter((line) => line.trim());
  const config = CATEGORY_CONFIG[category];
  const today = new Date().toISOString().split("T")[0];

  const titlePatterns = [
    /^#{1,2}\s+(.+)$/,
    /^(一|二|三|四|五)[、.．\s](.+)$/,
    /^\[(.+?)\]$/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    for (const pattern of titlePatterns) {
      const match = trimmed.match(pattern);
      if (match && match[1] && match[1].length < 100) {
        return match[1].trim();
      }
    }
    
    if (trimmed.length > 8 && trimmed.length < 120 && !trimmed.startsWith("-") && !trimmed.startsWith("*")) {
      return trimmed;
    }
  }

  return `${config.label}_${today}`;
}

interface ParsedSection {
  title: string;
  items: string[];
  rawText: string;
}

function parseSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = content.split("\n");
  
  let currentSection: ParsedSection | null = null;
  
  const sectionHeaderPattern = /^#{1,3}\s+|(?:^|\n)(?:[一二三四五六七八九十]+[、.．]|(?:##?\s+))/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (!trimmed) continue;

    const isSectionHeader = sectionHeaderPattern.test(trimmed) || 
      (/^(一|二|三|四|五|六|七|八|九|十)[、.．]/.test(trimmed) && trimmed.length < 30);

    if (isSectionHeader) {
      if (currentSection) {
        sections.push(currentSection);
      }
      
      const title = trimmed.replace(/^#+\s*/, "").replace(/^[一二三四五六七八九十]+[、.．]\s*/, "");
      currentSection = {
        title,
        items: [],
        rawText: "",
      };
    } else if (currentSection) {
      if (trimmed.length > 5 && !isMediaOnlyLine(trimmed)) {
        currentSection.items.push(trimmed);
        currentSection.rawText += (currentSection.rawText ? "\n" : "") + trimmed;
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections.length > 0 ? sections : [{ title: "", items: lines.filter(l => l.trim()), rawText: content }];
}

function truncateBrief(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

/**
 * 媒体行判定：markdown 图片/链接行（`![alt](url)` / `[alt](url)` / 裸 URL 行）。
 * 要点提取只吃文字内容——图片行混进 briefPoints 会变成「!alt(url)」式垃圾要点
 * （2026-10-10 搜图轮实测），链接行则把 URL 混进摘要文案。
 */
function isMediaOnlyLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) return true; // 纯 markdown 图片
  if (/^\[[^\]]*\]\([^)]*\)$/.test(t)) return true; // 纯 markdown 链接
  if (/^!?\S+\((?:https?:\/\/|\/)[^)]*\)$/.test(t) && !/\s/.test(t)) return true; // 被剥过括号的 !alt(url) 残形
  if (/^https?:\/\/\S+$/.test(t)) return true; // 裸 URL 行
  return false;
}

function isGenericSummaryTitle(title: string, category: ContentCategory): boolean {
  const config = CATEGORY_CONFIG[category];
  return (
    !title ||
    title.length < 3 ||
    title.startsWith(`${config.label}_`) ||
    /^\d{4}-\d{2}-\d{2}$/.test(title)
  );
}

/** 按内容关键词推断任务主体（如科技新闻、旅游计划） */
const TASK_SUBJECT_RULES: ReadonlyArray<{ pattern: RegExp; subject: string }> = [
  { pattern: /旅游|行程|景点|攻略|自驾|民宿|机票|签证|出境|酒店预订|自由行/, subject: "旅游计划" },
  { pattern: /菜谱|美食|餐厅|探店|小吃|餐饮/, subject: "美食推荐" },
  { pattern: /科技|人工智能|AI\b|芯片|互联网|数码|发布会|大模型|机器人/, subject: "科技新闻" },
  { pattern: /财经|股票|基金|股市|经济|央行|利率|理财/, subject: "财经资讯" },
  { pattern: /健康|医疗|养生|用药|体检/, subject: "健康资讯" },
  { pattern: /健身|运动|训练计划|减脂|增肌/, subject: "运动计划" },
  { pattern: /教育|学习|课程|考试|培训|备考/, subject: "学习资料" },
  { pattern: /育儿|亲子|宝宝|儿童/, subject: "育儿指南" },
  { pattern: /装修|家居|买房|租房|软装/, subject: "家居生活" },
  { pattern: /婚礼|婚庆|婚宴/, subject: "婚礼筹备" },
  { pattern: /购物|商品|比价|电商|优惠|种草/, subject: "购物推荐" },
  { pattern: /日程|待办|会议|提醒|排期|周报|月报/, subject: "日程安排" },
  { pattern: /招聘|简历|面试|求职|offer/i, subject: "求职指导" },
  { pattern: /天气|气温|降水|预报|台风/, subject: "天气预报" },
  { pattern: /电影|剧集|综艺|娱乐|明星/, subject: "娱乐资讯" },
  { pattern: /体育|赛事|球赛|奥运|世界杯/, subject: "体育资讯" },
  { pattern: /汽车|新能源|试驾|车市/, subject: "汽车资讯" },
  { pattern: /政策|法规|条例|政府|通知/, subject: "政策解读" },
  { pattern: /代码|函数|API|程序|编程|Bug|调试|部署/i, subject: "技术文档" },
  { pattern: /步骤|教程|如何|操作指引|说明书|上手/, subject: "操作指南" },
  { pattern: /调研|研究报告|竞品|行业分析|市场分析|白皮书/, subject: "调研报告" },
  { pattern: /新闻|头条|简报|早报|晚报|舆情|要闻/, subject: "新闻资讯" },
];

const CATEGORY_SUBJECT_FALLBACK: Record<ContentCategory, string> = {
  news: "新闻资讯",
  article: "文章阅读",
  search_result: "检索结果",
  webpage: "网页摘录",
  document: "文档资料",
  code: "技术文档",
  data: "调研报告",
  list: "任务清单",
  multi_section: "专题汇总",
  table: "数据表格",
  general: "内容详情",
};

export function inferTaskSubject(
  content: string,
  category: ContentCategory,
  rawTitle: string,
): string {
  const titleHint = rawTitle.trim();
  if (
    !isGenericSummaryTitle(titleHint, category) &&
    titleHint.length >= 4 &&
    titleHint.length <= 18 &&
    /计划|攻略|指南|简报|总结|报告|清单|方案|安排|推荐|资讯|新闻/.test(titleHint)
  ) {
    return titleHint;
  }

  const sample = `${titleHint}\n${content}`.slice(0, 4000);
  for (const rule of TASK_SUBJECT_RULES) {
    if (rule.pattern.test(sample)) {
      return rule.subject;
    }
  }

  return CATEGORY_SUBJECT_FALLBACK[category];
}

function resolveCardTitle(
  rawTitle: string,
  subjectLabel: string,
  category: ContentCategory,
): string {
  if (!isGenericSummaryTitle(rawTitle, category) && rawTitle.length <= 48) {
    return rawTitle.trim();
  }
  return subjectLabel;
}

/** 精简区要点：直接从正文提取真实内容（实际条目/句子）作为简洁介绍——
 *  用户在气泡里读到的是内容本身的预览，不是「主要涵盖哪些板块」式的目录转述。 */
function extractOverviewHighlights(
  content: string,
  category: ContentCategory,
  features: {
    hasSections: boolean;
    hasList: boolean;
    listItemCount: number;
  },
  maxCount: number,
): BriefPoint[] {
  const config = CATEGORY_CONFIG[category];
  const icons = config.briefIcons;
  const points: BriefPoint[] = [];
  let index = 0;

  const push = (text: string) => {
    if (index >= maxCount) return;
    const clean = text.trim();
    if (clean.length < 4) return;
    points.push({
      icon: icons[index % icons.length],
      text: truncateBrief(clean, 100),
    });
    index++;
  };

  if (features.hasSections) {
    // 分板块内容：各板块轮询取第 1、2、… 条真实要点，
    // 保证摘要在板块间均衡覆盖，且每条都是正文里的实际信息
    const sections = parseSections(content);
    for (let round = 0; round < maxCount && index < maxCount; round++) {
      for (const section of sections) {
        if (index >= maxCount) break;
        const item = section.items[round];
        if (item) push(item);
      }
    }
  } else if (features.hasList && features.listItemCount >= 3) {
    // 清单内容：直接取前若干条真实列表项
    for (const line of content.split("\n")) {
      if (index >= maxCount) break;
      const clean = line
        .trim()
        .replace(/^[\s]*[-•*→▸‣⁃◦·#*]+\s*/, "")
        .replace(/^[""「『【]/, "")
        .replace(/[""」』】]$/, "")
        .trim();
      if (clean.length >= 6 && !isMediaOnlyLine(clean)) push(clean);
    }
  } else {
    // 纯段落：取开头几句完整句子
    const sentences = content
      .split(/[。！？.!?]/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 12 && s.length <= 200);
    for (let i = 0; i < Math.min(sentences.length, maxCount); i++) {
      push(sentences[i]);
    }
  }

  return points;
}

/** 精简区：从正文提取的真实要点（气泡里折叠卡上方的简洁介绍）。
 *  不再拼接「全文约 N 字 / 主要涵盖…」式的元信息，全部为真实内容预览。 */
function extractBriefPoints(
  content: string,
  category: ContentCategory,
  maxCount: number = 6,
): BriefPoint[] {
  const contentType = detectContentType(content);
  return extractOverviewHighlights(
    content,
    category,
    contentType.features,
    maxCount,
  );
}

export function createContentSummary(
  content: string,
  options: SummarizeOptions & { source?: string } = {}
): ContentSummary | null {
  const {
    maxLength = SUMMARY_MIN_CHARS,
    briefPointCount = 6,
    forceSummary = false,
    source,
  } = options;

  if (!content || !content.trim()) {
    return null;
  }

  if (content.includes(CONTENT_SUMMARY_MARKER) || looksLikeCapabilityOrToolDump(content)) {
    return null;
  }

  // 先剥离模型声明的渲染标记行再做结构/标题/正文提取，保证 detailContent 干净
  const renderCleaned = stripRenderDeclarationLines(content);
  const contentType = detectContentType(renderCleaned);
  const category = detectCategory(renderCleaned, source);

  const eligible =
    forceSummary ||
    isEligibleForSummaryCard(category, renderCleaned, contentType.features);

  if (!eligible) {
    return null;
  }

  const config = CATEGORY_CONFIG[category];
  const rawTitle = extractTitle(renderCleaned, category);
  const subjectLabel = inferTaskSubject(renderCleaned, category, rawTitle);
  const cardTitle = resolveCardTitle(rawTitle, subjectLabel, category);
  const detailContent = stripLeadingTitleEcho(renderCleaned, cardTitle);

  const briefPoints = extractBriefPoints(
    renderCleaned,
    category,
    briefPointCount,
  );
  if (briefPoints.length === 0) {
    return null;
  }
  
  let sections: SectionInfo[] | undefined;
  if (contentType.features.hasSections) {
    const parsed = parseSections(renderCleaned);
    sections = parsed.map(s => ({
      title: s.title || "未命名",
      pointCount: s.items.length,
    }));
  }

  console.log(`[ContentSummary] Created: ${category}, subject=${subjectLabel}, ${briefPoints.length} points`);

  return {
    id: generateId(),
    category,
    title: cardTitle,
    briefPoints,
    detailContent,
    cardIcon: config.cardIcon,
    cardLabel: subjectLabel,
    sections,
    metadata: {
      source,
      subjectLabel,
      wordCount: detailContent.length,
      itemCount: briefPoints.length,
      sectionCount: sections?.length,
      hasTable: contentType.features.hasTable,
      hasList: contentType.features.hasList,
    },
    createdAt: new Date().toISOString(),
  };
}

export function formatContentSummaryForChat(summary: ContentSummary): string {
  const summaryData = JSON.stringify({
    type: "content_summary_v2",
    id: summary.id,
    category: summary.category,
    title: summary.title,
    cardIcon: summary.cardIcon,
    cardLabel: summary.cardLabel,
    subjectLabel: summary.cardLabel,
    briefCount: summary.briefPoints.length,
    // 简洁要点：气泡里在折叠卡上方展示的概要内容（详情在右侧面板/卡片内）
    briefPoints: summary.briefPoints.map((point) => ({
      icon: point.icon,
      text: point.text,
    })),
    detailContent: summary.detailContent,
    sections: summary.sections,
    metadata: summary.metadata ?? {},
  });

  // 卡片自身已渲染 cardLabel + title，正文不再重复输出同一文案，
  // 气泡里只保留卡片占位 <details_card />（旧版在此处插一行 titleLine，
  // 导致「先一段文案、卡片又复用同一文案」的冗余）。
  return `[CONTENT_SUMMARY_V2_START]
${summaryData}
[CONTENT_SUMMARY_V2_END]

<details_card ref="${summary.id}" />`;
}

/**
 * 从文本中摘出 CONTENT_SUMMARY_V2 块为结构化卡（结构化通道迁移，2026-10-10）。
 *
 * 返回：
 *   - card：块内 JSON 载荷（损坏时为 null，但整块仍会从 text 剥离——载荷坏了
 *     也不能让它以裸 JSON 透出）；
 *   - text：剥离整块与孤儿 details_card 后的正文。文本通道从此不再携带摘要块，
 *     卡片随 chat.assistant_done 的 summaryCard 字段下发。
 */
export function extractContentSummaryCard(
  text: string,
): { card: Record<string, unknown> | null; text: string } {
  if (!text || !text.includes(CONTENT_SUMMARY_MARKER)) {
    return { card: null, text };
  }
  const match = text.match(
    /\[CONTENT_SUMMARY_V2_START\]([\s\S]*?)\[CONTENT_SUMMARY_V2_END\]/,
  );
  let card: Record<string, unknown> | null = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).type === "content_summary_v2"
      ) {
        card = parsed as Record<string, unknown>;
      }
    } catch {
      // 载荷损坏：按无卡处理，整块仍剥离（宁缺毋滥）
    }
  }
  return { card, text: stripContentSummaryBlock(text) };
}

/**
 * 从文本中剥离整个 CONTENT_SUMMARY_V2 块（标记对 + JSON 载荷 + 尾随 details_card）。
 *
 * 定位（不变量，2026-10-10 搜图轮裸 JSON 泄漏）：摘要块是一种「路由资产」——
 * 它只允许被消费（客户端折叠卡渲染），绝不允许以裸文本透出。任何把媒体卡设为
 * 本轮主形态的出口（mediaCards 非空）都必须调用本函数确定性剥离；客户端渲染层
 * 另有同语义兜底。与模型无关：换任何模型，块要么被路由消费、要么在这里消失。
 */
export function stripContentSummaryBlock(text: string): string {
  if (!text) return text;
  let out = text;
  if (out.includes(CONTENT_SUMMARY_MARKER)) {
    out = out.replace(
      /\[CONTENT_SUMMARY_V2_START\][\s\S]*?\[CONTENT_SUMMARY_V2_END\][ \t]*/g,
      "",
    );
  }
  // 孤儿 details_card 占位行无条件清（历史数据可能单独残留——占位符本身
  // 没有独立消费者，留着的唯一归宿就是裸文本泄漏）
  out = out.replace(/^[ \t]*<details_card\s+ref="[^"]*"\s*\/>[ \t]*$/gm, "");
  return out
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 纯文本格式（微信/Claw 端）：直接输出正文内容，不展示概要元信息。
 */
export function formatContentSummaryForPlainText(summary: ContentSummary): string {
  return summary.detailContent?.trim() ?? "";
}

export function shouldSummarizeContent(content: string, threshold: number = SUMMARY_MIN_CHARS): boolean {
  if (!content?.trim()) return false;
  if (content.includes(CONTENT_SUMMARY_MARKER)) return false;
  if (looksLikeCapabilityOrToolDump(content)) return false;
  if (content.length < threshold) return false;

  const contentType = detectContentType(content);
  const category = detectCategory(content);
  return isEligibleForSummaryCard(category, content, contentType.features);
}
