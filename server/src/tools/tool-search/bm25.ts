import { reciprocalRankFusion } from "../../agent/retrieval/rrf.js";
import { getToolIntentMetadata } from "./intent-metadata.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "and", "or", "is", "are",
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "这", "那", "有", "和", "中",
]);

function pushToken(tokens: string[], raw: string): void {
  const t = raw.trim();
  if (!t || STOP_WORDS.has(t)) return;
  if (/[\u4e00-\u9fa5]/.test(t)) {
    if (t.length >= 2) tokens.push(t);
    for (let i = 0; i < t.length - 1; i++) {
      const bg = t.slice(i, i + 2);
      if (!STOP_WORDS.has(bg)) tokens.push(bg);
    }
    return;
  }
  if (t.length >= 2) tokens.push(t);
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(/[\u4e00-\u9fa5]+|[a-z0-9_.-]+/g)) {
    const t = match[0]?.trim();
    if (!t) continue;
    if (/[\u4e00-\u9fa5]/.test(t)) {
      pushToken(tokens, t);
      continue;
    }
    pushToken(tokens, t);
    for (const part of t.split(/[._-]/)) {
      pushToken(tokens, part);
    }
  }

  return tokens;
}

export type Bm25Document = {
  id: string;
  text: string;
};

type SearchAliasEntry = {
  registryName: string;
  searchAliases?: string[];
  /** 可选：catalog 构建时预计算的字符 trigram 集合，用于 trigram 排名加速 */
  trigramSet?: Set<string>;
};

export type Bm25Hit = {
  id: string;
  score: number;
};

export class Bm25Index {
  private readonly docs: Bm25Document[];
  private readonly docTokens: string[][];
  private readonly avgDl: number;
  private readonly df = new Map<string, number>();
  private readonly k1 = 1.2;
  private readonly b = 0.75;
  // ===== 倒排/预计算（优化：避免每次 search 重复 tokenize / 重建 tf） =====
  /** doc → token 集合（token overlap 通道直接复用，不再每次重算） */
  private readonly docTokenSets: Set<string>[];
  /** doc → term frequency Map（BM25 通道直接复用，不再每次重建） */
  private readonly tfCache: Map<string, number>[];
  /** token → docIds（倒排索引：BM25 只扫含 query token 的 doc） */
  private readonly postings: Map<string, number[]>;

  constructor(docs: Bm25Document[]) {
    this.docs = docs;
    this.docTokens = docs.map((d) => tokenize(d.text));
    this.docTokenSets = new Array(docs.length);
    this.tfCache = new Array(docs.length);
    this.postings = new Map<string, number[]>();
    let totalLen = 0;
    for (let i = 0; i < this.docTokens.length; i++) {
      const tokens = this.docTokens[i]!;
      totalLen += tokens.length;
      const seen = new Set<string>();
      const tf = new Map<string, number>();
      const tokenSet = new Set<string>();
      for (const t of tokens) {
        tokenSet.add(t);
        tf.set(t, (tf.get(t) ?? 0) + 1);
        if (seen.has(t)) continue;
        seen.add(t);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
        const list = this.postings.get(t) ?? [];
        list.push(i);
        this.postings.set(t, list);
      }
      this.docTokenSets[i] = tokenSet;
      this.tfCache[i] = tf;
    }
    this.avgDl = docs.length > 0 ? totalLen / docs.length : 0;
  }

  /**
   * token 的 BM25 IDF（意图先验直取的区分度加权用，2026-10-09）。
   * 与 rankByBm25 同公式。索引中无此 token 时返回 0——对重叠证据打分而言，
   * 「语料里没见过」≠「极稀有」：无 df 证据的 token（如 query 特有词）不构成
   * 意图证据，按最高区分度计会把先验通道击穿（实测「十一」零 df 满分泄漏）。
   */
  idfOf(token: string): number {
    const docFreq = this.df.get(token) ?? 0;
    const n = this.docs.length;
    if (n === 0 || docFreq === 0) return 0;
    return Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
  }

  search(query: string, limit: number, aliasEntries?: SearchAliasEntry[]): Bm25Hit[] {
    const queries = expandSearchQueries(query, aliasEntries);
    if (queries.length === 0 || this.docs.length === 0) return [];

    const bm25Ranking = this.rankByBm25(queries);
    const overlapRanking = this.rankByTokenOverlap(queries);
    const fuzzyRanking = rankByTrigramSimilarity(this.docs, queries, aliasEntries);
    const registryRanking = rankByRegistryName(this.docs, queries);

    const fused = reciprocalRankFusion(
      [bm25Ranking, overlapRanking, fuzzyRanking, registryRanking],
      40,
      Math.max(limit * 4, 12),
    );
    const boosted = applySearchRankingBoosts(
      fused.map((hit) => ({ id: hit.id, score: hit.rrf })),
      query,
      this.docs,
    );
    boosted.sort((a, b) => b.score - a.score);
    if (boosted.length > 0) return boosted.slice(0, limit);

    return rankBySubstringFallback(this.docs, queries, query).slice(0, limit);
  }

  /**
   * BM25 打分：利用倒排索引只扫「含 query token」的 doc，并用预计算的 tf。
   * 复杂度从 O(Q × D × L) 降到 O(sum(docFreq(qt)))。
   */
  private rankByBm25(queries: string[]): Array<{ id: string }> {
    const N = this.docs.length;
    const scoreById = new Map<string, number>();
    const avgDl = this.avgDl || 1;

    for (const query of queries) {
      const qTokens = tokenize(query);
      if (qTokens.length === 0) continue;
      // 合并同一 query 内重复 token，减少重复 doc 访问
      const qTokenSet = Array.from(new Set(qTokens));

      // 预聚合：收集所有候选 docIds（用倒排索引缩小扫描范围）
      const candidateDocs = new Set<number>();
      for (const qToken of qTokenSet) {
        const postings = this.postings.get(qToken);
        if (!postings) continue;
        for (const docIdx of postings) candidateDocs.add(docIdx);
      }
      if (candidateDocs.size === 0) continue;

      for (const docIdx of candidateDocs) {
        const tokens = this.docTokens[docIdx]!;
        const dl = tokens.length;
        if (dl === 0) continue;
        const tf = this.tfCache[docIdx]!;
        let score = 0;
        for (const qToken of qTokenSet) {
          const freq = tf.get(qToken) ?? 0;
          if (freq === 0) continue;
          const docFreq = this.df.get(qToken) ?? 0;
          const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
          const denom = freq + this.k1 * (1 - this.b + this.b * (dl / avgDl));
          score += idf * ((freq * (this.k1 + 1)) / denom);
        }
        if (score > 0) {
          scoreById.set(this.docs[docIdx]!.id, Math.max(scoreById.get(this.docs[docIdx]!.id) ?? 0, score));
        }
      }
    }

    return sortRanking(scoreById);
  }

  /** Token overlap：复用预计算 doc token Set，避免每次 search 重新 tokenize 全部 doc。 */
  private rankByTokenOverlap(queries: string[]): Array<{ id: string }> {
    const scoreById = new Map<string, number>();
    const N = Math.max(1, this.docs.length);

    for (const query of queries) {
      const queryTokens = Array.from(new Set(tokenize(query)));
      if (queryTokens.length === 0) continue;
      // IDF 加权：「什么/一下」这类全场通用 token 在大量 doc 里出现，
      // 裸计数会让短描述工具靠通用词登顶；idf 把权重集中到区分性 token 上。
      const qIdf = queryTokens.map((t) => Math.log(1 + N / ((this.df.get(t) ?? 0) + 0.5)));
      const qIdfSum = qIdf.reduce((s, v) => s + v, 0) || 1;

      for (let i = 0; i < this.docs.length; i++) {
        const docTokens = this.docTokenSets[i]!;
        if (docTokens.size === 0) continue;
        let sharedIdf = 0;
        for (let j = 0; j < queryTokens.length; j++) {
          if (docTokens.has(queryTokens[j]!)) sharedIdf += qIdf[j]!;
        }
        if (sharedIdf === 0) continue;
        const score = sharedIdf / Math.sqrt(qIdfSum * docTokens.size);
        scoreById.set(this.docs[i]!.id, Math.max(scoreById.get(this.docs[i]!.id) ?? 0, score));
      }
    }

    return sortRanking(scoreById);
  }
}

function rankByTrigramSimilarity(
  docs: Bm25Document[],
  queries: string[],
  aliasEntries?: SearchAliasEntry[],
): Array<{ id: string }> {
  const scoreById = new Map<string, number>();
  // 优先从 aliasEntries 拿预计算的 trigramSet（catalog 构建时已缓存），
  // 避免每次 search 都重算 O(D × L)。仅当 aliasEntries 缺失时才回退到原始重算。
  const docGramsCache =
    aliasEntries?.length && aliasEntries[0]?.trigramSet
      ? new Map(aliasEntries.map((e) => [e.registryName, e.trigramSet!]))
      : null;

  // gram 文档频率：跨全部 doc 统计每个 trigram 出现在多少个 doc 里（懒构建一次）。
  // 「什么/答应/一下」这类通用 gram 几乎每个描述都有，裸 shared 计数会让短描述
  // 工具凭通用 gram 登顶；按 1/df 加权后权重集中到区分性 gram（如「网页」「读取」）。
  let gramDf: Map<string, number> | null = null;
  const gramDfOf = (gram: string): number => {
    if (!gramDf) {
      gramDf = new Map<string, number>();
      const source = docGramsCache
        ? [...docGramsCache.values()]
        : docs.map((d) => buildCharacterTrigrams(d.text));
      for (const grams of source) {
        for (const g of grams) gramDf.set(g, (gramDf.get(g) ?? 0) + 1);
      }
    }
    return gramDf.get(gram) ?? 1;
  };

  for (const query of queries) {
    const queryGrams = buildCharacterTrigrams(query);
    if (queryGrams.size === 0) continue;

    for (const doc of docs) {
      const docGrams =
        docGramsCache?.get(doc.id) ??
        (docGramsCache == null ? buildCharacterTrigrams(doc.text) : null);
      if (!docGrams || docGrams.size === 0) continue;
      let shared = 0;
      for (const gram of queryGrams) {
        if (docGrams.has(gram)) shared += 1 / gramDfOf(gram);
      }
      if (shared === 0) continue;
      const score = shared / Math.sqrt(queryGrams.size * docGrams.size);
      scoreById.set(doc.id, Math.max(scoreById.get(doc.id) ?? 0, score));
    }
  }

  return sortRanking(scoreById);
}

function rankByRegistryName(docs: Bm25Document[], queries: string[]): Array<{ id: string }> {
  const scoreById = new Map<string, number>();
  const queryTokens = Array.from(new Set(queries.flatMap((query) => tokenize(query))));

  for (const doc of docs) {
    const idLower = doc.id.toLowerCase();
    const idNorm = idLower.replace(/\./g, "_");
    let score = 0;
    for (const token of queryTokens) {
      if (token.length < 2) continue;
      if (idLower === token || idNorm === token) score += 5;
      else if (idLower.startsWith(token) || idNorm.startsWith(token)) score += 2.5;
      else if (idLower.includes(token) || idNorm.includes(token)) score += 1;
    }
    if (score > 0) scoreById.set(doc.id, score);
  }

  return sortRanking(scoreById);
}

function rankBySubstringFallback(
  docs: Bm25Document[],
  queries: string[],
  rawQuery: string,
): Bm25Hit[] {
  const qLower = rawQuery.toLowerCase().trim();
  if (!qLower) return [];
  const fallbackById = new Map<string, number>();

  for (const query of queries) {
    const qTokens = tokenize(query);
    for (const doc of docs) {
      const textLower = doc.text.toLowerCase();
      const idLower = doc.id.toLowerCase();
      if (
        textLower.includes(qLower) ||
        idLower.includes(qLower) ||
        qTokens.some((token) => textLower.includes(token) || idLower.includes(token))
      ) {
        fallbackById.set(doc.id, Math.max(fallbackById.get(doc.id) ?? 0, 0.01));
      }
    }
  }

  return applySearchRankingBoosts(
    Array.from(fallbackById.entries()).map(([id, score]) => ({ id, score })),
    rawQuery,
    docs,
  ).sort((a, b) => b.score - a.score);
}

function sortRanking(scoreById: Map<string, number>): Array<{ id: string }> {
  return Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id }));
}

function buildCharacterTrigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return new Set();
  if (normalized.length <= 3) return new Set([normalized]);

  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 2; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

// 暴露给 catalog.ts 用于预计算 trigram 集合（避免每次 search 都重算）。
export { buildCharacterTrigrams, expandSearchQueries };

function registryNameSearchTokens(name: string): string[] {
  const segments = name.split(/[._-]+/).filter((s) => s.length >= 2);
  const underscored = name.replace(/\./g, "_");
  return [...segments, underscored !== name ? underscored : ""].filter(Boolean);
}

function applySearchRankingBoosts(
  hits: Bm25Hit[],
  query: string,
  docs: Bm25Document[],
): Bm25Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits;

  const docById = new Map(docs.map((d) => [d.id, d]));
  const qNorm = q.replace(/\s+/g, "_").replace(/\./g, "_");
  const qTokens = tokenize(q);

  return hits.map((hit) => {
    const doc = docById.get(hit.id);
    if (!doc) return hit;

    const idLower = hit.id.toLowerCase();
    const idNorm = idLower.replace(/\./g, "_");
    let boost = 0;

    if (idLower === q || idNorm === qNorm) boost += 8;
    else if (idLower.startsWith(q) || idNorm.startsWith(qNorm)) boost += 4;
    else if (idLower.includes(q) || idNorm.includes(qNorm)) boost += 2;

    const idSegments = hit.id.split(/[._-]+/).map((s) => s.toLowerCase());
    for (const token of qTokens) {
      if (token.length < 2) continue;
      if (idSegments.some((seg) => seg === token || seg.startsWith(token))) boost += 0.6;
    }

    return boost > 0 ? { ...hit, score: hit.score + boost } : hit;
  });
}

export function buildToolSearchText(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): { text: string; aliases: string[] } {
  const paramNames = extractParameterNames(tool.parameters);
  const paramValues = extractParameterValues(tool.parameters);
  const metadata = getToolIntentMetadata(tool.name);
  const aliases = [...toolSearchAliases(tool.name), ...(metadata.aliases ?? [])];
  const nameTokens = registryNameSearchTokens(tool.name);
  return {
    text: [
      tool.name,
      tool.description ?? "",
      ...nameTokens,
      ...paramNames,
      ...paramValues,
      ...aliases,
      ...(metadata.examples ?? []),
    ]
      .filter(Boolean)
      .join(" "),
    aliases,
  };
}

function toolSearchAliases(name: string): string[] {
  const aliases: string[] = [];
  const prefixRules: Array<{ prefix: string; words: string[] }> = [
    { prefix: "calendar.", words: ["日历", "日程", "待办", "提醒"] },
    { prefix: "phone.", words: ["电话", "短信", "联系", "call", "message"] },
    { prefix: "weather.", words: ["天气", "气温", "预报"] },
    { prefix: "shopping.", words: ["购物", "买东西", "比价", "推荐", "shopping", "buy"] },
    { prefix: "wallet.", words: ["钱包", "余额", "转账", "支付", "消费"] },
    { prefix: "memory.", words: ["记忆", "回忆", "笔记"] },
    { prefix: "schedule.", words: ["定时", "计划任务", "cron"] },
    { prefix: "desktop.visual.", words: ["截图", "屏幕", "键鼠", "computer"] },
    { prefix: "browser.", words: ["浏览器", "网页", "cookie", "页面"] },
    { prefix: "mcp.", words: ["外部工具", "平台", "文件", "mcp"] },
  ];
  for (const rule of prefixRules) {
    if (name.startsWith(rule.prefix)) aliases.push(...rule.words);
  }
  return aliases;
}

function extractParameterNames(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
}

function extractParameterValues(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];

  const values: string[] = [];
  for (const value of Object.values(props)) {
    if (!value || typeof value !== "object") continue;
    const schema = value as {
      enum?: unknown[];
      const?: unknown;
      description?: string;
      title?: string;
    };
    if (typeof schema.title === "string") values.push(schema.title);
    if (typeof schema.description === "string") values.push(schema.description);
    if (Array.isArray(schema.enum)) {
      for (const item of schema.enum) {
        if (typeof item === "string" || typeof item === "number") values.push(String(item));
      }
    }
    if (typeof schema.const === "string" || typeof schema.const === "number") {
      values.push(String(schema.const));
    }
  }
  return values;
}

function expandSearchQueries(query: string, aliasEntries?: SearchAliasEntry[]): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9._\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const variants = new Set<string>([trimmed, normalized]);

  const replacements: Array<[RegExp, string]> = [
    [/\bwechat\b/gi, "weixin 微信"],
    [/\bweixin\b/gi, "wechat 微信"],
    [/\bxhs\b/gi, "xiaohongshu 小红书"],
    [/\bdouyin\b/gi, "抖音 tiktok"],
    [/\bwx\b/gi, "wechat 微信"],
    [/\bwb\b/gi, "微博 weibo"],
    [/\bjd\b/gi, "京东 jd shopping 购物"],
    [/\btb\b/gi, "淘宝 taobao shopping 购物"],
    [/\bdy\b/gi, "抖音 douyin"],
    [/\bremind(er)?\b/gi, "提醒 reminder schedule calendar 闹钟"],
    [/\bcall\b/gi, "电话 phone call 拨打 呼叫"],
    [/\bmessage\b/gi, "短信 message send 发送"],
    [/\bbuy\b/gi, "购买 下单 buy order 购物"],
    [/\bbook\b/gi, "预订 预约 book reserve"],
    [/\bshop(ping)?\b/gi, "shopping buy compare recommend 购物 买"],
    [/\bcompare\b/gi, "compare suggest shopping prices 比价"],
    [/\bprice\b/gi, "price compare budget shopping 价格 省钱"],
    // 中文同义词扩展：BM25 单工具级文本匹配对中文近义词很弱，
    // 把常见口语/别名扩展成标准工具词，显著提升召回（如「配音」→ voice/tts）。
    // 注意：长精确词放前（语音合成/语音消息），避免被短词（语音）先替换吃掉。
    [/语音合成|合成语音|配音|音频(?:生成)?/gi, "语音合成 配音 音频 语音 voice speak tts speech"],
    [/语音消息|语音(?:播报|回复|对话|通话|提醒)/gi, "语音消息 语音播报 语音 voice speak send_message 播报"],
    [/念(?:给我听|出来)?|朗读|播报|读出来|说出来|发语音|用语音/gi, "朗读 播报 念 读出来 语音 speak voice tts"],
    [/提醒|闹钟|定时(?:提醒)?/gi, "提醒 reminder schedule calendar 闹钟"],
    [/日程|会议|待办|预约/gi, "日程 会议 待办 calendar schedule meeting"],
    [/截图|屏幕(?:截图|画面)?|截屏|截(?:个)?(?:图|屏)/gi, "截图 屏幕 截屏 screenshot desktop.visual"],
    [/搜(?:索|一下|一搜)|查一下|查询/gi, "搜索 查询 search search_web web"],
    [/\bsearch\b/gi, "search 搜索 查询 搜"],
    [/\bweather\b/gi, "weather 天气 气温 预报"],
    [/\bcalendar\b/gi, "calendar 日历 日程 会议 待办"],
    [/\bclock\b/gi, "clock 时间 时钟 日期 现在几点"],
    [/\bdesktop\b/gi, "desktop 桌面 电脑 计算机 自动化 shell 命令"],
    [/\bbrowser\b/gi, "browser 浏览器 网页 页面 标签"],
    [/\bwallet\b/gi, "wallet 钱包 余额 账单 支付 消费"],
    [/\bbudget\b/gi, "budget 预算 花销 算钱 计算"],
    [/\breminder\b/gi, "reminder 提醒 闹钟 定时"],
    [/\bnote(s)?\b/gi, "notes 笔记 记录 记忆"],
    [/\bfriend(s)?\b/gi, "friend 好友 朋友 agent 社交"],
    [/\bagent\b/gi, "agent 智能体 好友 消息 发送"],
    // 高频口语语义场 → 标准工具词（黄金回归集锁定的漏召场，见 test/tool-discover-golden-recall.test.ts）
    [/几点(?:了)?|现在时间|什么时间|当前时间/gi, "clock 时间 几点 当前 current_time"],
    [/价格|行情|多少钱|什么价|股价|汇率|涨跌|涨了|跌了|币价|净值/gi, "search_web 实时 行情 价格 查询 search 最新"],
    [/网页|网址|链接|这个页面|读了?什么|说了?什么|内容是什么/gi, "fetch_web 网页 读取 内容 page url read"],
    // URL 本体会把无关工具的 registry 词（如 example.com → self.generate_from_example）
    // 经 registry/trigram 通道顶到最前；归一化成 fetch 语义信号并消除噪声源。
    [/https?:\/\/\S+/gi, "fetch_web 网页 url page read 读取 内容"],
    [/摄像头|监控画面|看家|门口/gi, "摄像头 vision camera 监控 看一眼 画面"],
    [/(?:开|关|调)(?:一下)?灯|灯光|调亮|调暗|空调|窗帘|插座/gi, "smart_home 设备 开关 灯 空调 窗帘 control"],
    [/到家|回到家|离家|出门|离开公司|到达/gi, "geofence 位置 围栏 到达 离开 提醒"],
    [/每天提醒|定期提醒|天天提醒|周期提醒/gi, "每天 定时 提醒 rhythm 周期 reminder"],
    [/照片|图片|找图|壁纸|头像|表情包/gi, "图片 照片 search_images image photo 找图"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(trimmed)) {
      variants.add(trimmed.replace(pattern, replacement));
    }
  }

  const queryTokens = tokenize(normalized);
  const queryTokenSet = new Set(queryTokens);
  const addedVariants: string[] = [];
  const MAX_VARIANTS = 8; // 限制变体数，避免 BM25/Trigram 多路 RRF 跑 N 次
  if (aliasEntries?.length && queryTokens.length > 0) {
    // 别名命中规则：别名是"用户可能说出的短语"，只有 query 里真的出现了这个别名
    // （整串包含；或英文多词别名中有完整实词命中）才算。
    // 旧规则是"query 的任一 bigram 出现在别名串里"——中文 bigram 如「一下」「什么」
    // 会在无关工具的别名里撞上，于是把该工具的 registryName 拼进 query，
    // rankByRegistryName 再按前缀把同族工具整体推到最前，
    // 反而把纯 BM25 已排到 top-1 的正确工具挤下去（召回噪声的主来源之一）。
    type ScoredEntry = { entry: SearchAliasEntry; score: number };
    const scored: ScoredEntry[] = [];
    for (const entry of aliasEntries) {
      if (!entry.searchAliases?.length) continue;
      const score = aliasMatchScore(normalized, queryTokenSet, entry.searchAliases);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
      if (addedVariants.length >= MAX_VARIANTS) break;
      const v = `${trimmed} ${s.entry.registryName}`;
      variants.add(v);
      addedVariants.push(v);
    }
    // 把最相关 entry 的 alias 原文也拼进 query（帮助 token overlap / trigram 通道命中同义表达）
    if (scored.length > 0 && scored[0]!.entry.searchAliases) {
      const topAliases = scored[0]!.entry.searchAliases!.slice(0, 6).join(" ");
      variants.add(`${trimmed} ${topAliases}`);
    }
  }

  return Array.from(variants).filter(Boolean);
}

/**
 * 别名命中打分：
 *   - 中文/整串别名：normalized query 包含整个别名（长度 ≥ 2）→ 按别名长度计分（长别名更具体）；
 *   - 英文多词别名（含空格）：任一 ≥ 3 字符的实词等于 query token → 计 1 分。
 * 返回 0 表示不相关。
 */
function aliasMatchScore(
  normalizedQuery: string,
  queryTokenSet: Set<string>,
  aliases: string[],
): number {
  let score = 0;
  for (const raw of aliases) {
    const alias = raw.trim().toLowerCase();
    if (alias.length < 2) continue;
    if (normalizedQuery.includes(alias)) {
      score += Math.min(4, alias.length);
      continue;
    }
    if (alias.includes(" ")) {
      for (const word of alias.split(/\s+/)) {
        if (word.length >= 3 && !STOP_WORDS.has(word) && queryTokenSet.has(word)) {
          score += 1;
          break;
        }
      }
    }
  }
  return score;
}
