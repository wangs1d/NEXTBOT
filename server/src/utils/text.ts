export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/**
 * 折叠相邻的完全相同行（包括跨多轮工具调用时 LLM 自带的「同句复述」）。
 * 不区分大小写、不去重非相邻行,避免误伤包含相同短语的并列项。
 * 用于清理最终回复里与「实时进度句」重复的尾巴,让用户只看到一次。
 */
export function dedupeAdjacentLines(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let lastNormalized = "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      // 保留空行作为段落分隔,不做折叠
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === lastNormalized) continue;
    out.push(raw);
    lastNormalized = normalized;
  }
  // 去掉尾部多余空行
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** 按句末标点切句（保留标点），空白折叠。 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?；;])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 句子规范化：去空白 + 小写，用于重复判定。 */
export function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 提取文本的句子集合（用于重复判定）。 */
export function sentenceSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const s of splitSentences(text)) set.add(normalizeSentence(s));
  return set;
}

/**
 * 剔除 incoming 中与 alreadySaid 句级重复的句子。
 * 用于 fast 主答后 complex 后台结果回传时去重，
 * 消除"整段一模一样出现两次"的重复 bug。
 *
 * 2026-11-23：逐句删除、其余字符（含换行）原样保留。旧实现用
 * splitSentences（空白折叠）+ join("")，一旦命中重复句就会把整段残余
 * 压成一行——分泡后列表项退化成「…在美国 - 马斯克说…」的流水。
 */
export function stripSentencesAlreadySaid(alreadySaid: string, incoming: string): string {
  if (!incoming?.trim()) return incoming ?? "";
  if (!alreadySaid?.trim()) return incoming;
  const said = sentenceSet(alreadySaid);
  // 与 splitSentences 同一套句末标点；\n 也作为断句边界，但不吞掉换行。
  const sentenceRe = /[^。！？!?；;\n]+[。！？!?；;]+|[^。！？!?；;\n]+(?=\n|$)/gu;
  let removed = false;
  const out = incoming.replace(sentenceRe, (sentence) => {
    if (said.has(normalizeSentence(sentence))) {
      removed = true;
      return "";
    }
    return sentence;
  });
  return removed ? out : incoming;
}

/**
 * 将 LLM 原始状态行转换为用户友好的简短动作描述。
 *
 * 设计原则：
 * - 不暴露工具名（如 search_web、browser.fetch_page）
 * - 不展示搜索结果的具体内容
 * - 仅描述 Agent 正在"哪里/如何"获取信息（来源/动作）
 * - 短文本（≤40字）保留原样，通常是简短的思考说明
 */
export function formatStatusForDisplay(rawLine: string): string {
  let t = rawLine.trim();
  if (!t) return "";
  // 先剥离 [ts:...] 时间戳前缀：LLM 在 tool loop 思考阶段常把对话历史的时间戳
  // 前缀"复述"进 fullText，若不清理会推到前端成乱码（如 [ts:2026-07-21 14:52:48|周二|13s…）
  t = t.replace(/^\[ts:[^\]]*\]\s*/gm, "").trim();
  if (!t) return "";
  // 短文本直接保留（通常是简短思考/动作说明，不会是结果内容）
  if (t.length <= 40) return t;

  // 网络搜索 / 信息检索类 → 描述为"从网络检索"
  if (
    /搜索|查找|检索|搜到|找到.*?(?:结果|信息|内容|以下)|根据.*?(?:搜索|查询|检索)|bing|必应|google/i.test(t)
  ) {
    return "正在从网络检索相关信息…";
  }

  // 记忆/历史回顾类
  if (/记忆|历史|回顾|之前.*?(?:聊过|说过|提到|讨论|记录|存档|过往)/i.test(t)) {
    return "正在查阅历史记忆…";
  }

  // 网页/链接浏览类
  if (/网页|页面|浏览|打开.*?(?:链接|网址|url|http)/i.test(t)) {
    return "正在浏览网页内容…";
  }

  // 社交平台检索类
  if (/微博|小红书|微信|公众号|抖音|朋友圈|社交/i.test(t)) {
    return "正在从社交平台检索信息…";
  }

  // 代码/技术文档类
  if (/代码|文档|github|仓库|api|接口/i.test(t)) {
    return "正在查阅技术资料…";
  }

  // 其他长文本：截断处理，避免展示大段内容
  return t.slice(0, 30) + "…";
}

/**
 * 错字归一化：单个破折号「—」冒充量词「一」。
 *
 * deepseek 系模型中文输出偶发把量词「一」打成「—」（2026-09-12 实测
 * 「在成都有—场品牌活动」）。合法破折号是双写「——」（前后不限汉字），
 * 单写「—」紧跟量词字的场景几乎只有这一种错字形态。
 * 只处理「汉字 + 单个— + 量词字」的窄模式，不动合法的「——」与表格/列表符号。
 */
const DASH_TYPO_MEASURE_CHARS =
  "场个次条只位名块件轮番步页篇部台趟遍圈顿口批位点列行排组串滴颗棵艘架节段份则首曲阵班杯片朵张辆栋座间家封道项笔句声";
const DASH_TYPO_RE = new RegExp(
  `([\\u4e00-\\u9fff])—(?!—)([${DASH_TYPO_MEASURE_CHARS}])`,
  "g",
);

export function normalizeDashTypos(text: string): string {
  if (!text || !text.includes("—")) return text;
  return text.replace(DASH_TYPO_RE, "$1一$2");
}
