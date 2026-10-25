/**
 * realtime 轮搜索词的确定性构造器（2026-09-13 根修）。
 *
 * 契约：realtime_lookup 轮必须有含实体的可执行搜索词，且这一点不能依赖模型
 * 自觉——路由器结构化输出里的 search_query 只是首选来源；模型缺省、或输出
 * 「我老婆 最近 在哪」这类代词查询词时（真实测试实证），由本模块**纯代码**
 * 消解指代：
 *   1. 用户当前消息剥停用词后仍有实体 → 原话即查询词（当前消息实体最优先）；
 *   2. 否则在上下文行（最近对话 + 记忆档案/profile 行）里做**候选实体频次
 *      统计**：剥离停用词后的 CJK 词串（2-4 字）与拉丁词，出现次数最多者
 *      胜出（人名/地名在真实记忆与对话里天然重复出现，频次压过偶发噪声），
 *      拼「实体 + 查询词」；
 *   3. 上下文也没有实体 → 查询词原样兜底（仍是可执行搜索词）。
 * 构造质量只影响搜索召回，不影响「是否真搜」——搜索触发由 agent-core 的
 * 前置检索门禁按「searchQuery 非空」确定性执行，与模型输出无关。
 */

/** 剥离后不应作为搜索实体的词：代词/疑问/时间/泛话题/口语/角色称谓/高频动词。 */
const ENTITY_STOPWORDS: string[] = [
  // 人称代词与角色称谓（指代词，不是实体本身）
  "我", "你", "他", "她", "它", "咱", "俺", "我们", "你们", "他们", "她们", "它们", "自己", "大家", "人家",
  "老公", "老婆", "女朋友", "男朋友", "对象", "媳妇", "哥哥", "姐姐", "弟弟", "妹妹", "用户", "本人", "人家",
  // 语气/助词/单字功能词
  "的", "了", "吗", "呢", "吧", "啊", "呀", "哦", "噢", "喔", "嘛", "么", "哈", "喂", "欸", "诶",
  "是", "有", "在", "去", "说", "要", "想", "看", "问", "跟", "和", "与", "就", "也", "都", "很",
  "挺", "不", "没", "还", "又", "才", "只", "被", "把", "让", "给", "对", "从", "到", "会", "能",
  "及", "并", "曾", "称", "等", "个", "这", "那",
  // 疑问/方位词
  "什么", "怎么", "怎样", "怎么样", "如何", "多少", "为什么", "为啥", "在哪", "哪里", "那儿", "那里", "哪儿", "哪些",
  // 时间词
  "最近", "近期", "近来", "今天", "昨天", "前天", "明天", "现在", "目前", "当前", "这两天", "这几天", "那天", "最近几天",
  "周日", "周一", "周二", "周三", "周四", "周五", "周六", "星期天", "星期六", "上午", "下午", "中午", "凌晨", "早上", "晚上",
  // 泛话题词（无实体区分度）
  "消息", "新闻", "动态", "近况", "情况", "状态", "行踪", "行程", "照片", "图片", "视频", "八卦", "爆料", "热搜", "瓜",
  // 高频动词/泛词（记忆 profile 行的谓语，不是实体）
  "知道", "告诉", "看看", "查查", "查一下", "搜搜", "搜一下", "搜索", "打听", "了解", "说说", "讲讲", "聊聊", "找找",
  "有没有", "是不是", "好不好", "行不行", "能不能", "还是", "就是", "然后", "一下", "这个", "那个",
  "关注", "关心", "喜欢", "主动", "要求", "查看", "使用", "倾向", "经常", "常", "偏", "高频",
  // 线程/recap 结构词（英文标签，会以高词频污染拉丁候选）
  "assistant", "user", "system", "session", "recap", "tool", "tools", "agent", "device",
];

const CJK_ENTITY_RE = /[\u4e00-\u9fff]{2,}/g;
const LATIN_ENTITY_RE = /\b[A-Za-z][A-Za-z0-9]{1,}\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 长词优先的停用词剥离正则（防「在哪里」被「在哪」先吃掉剩「里」）。 */
const STOPWORD_RE = new RegExp(
  [...ENTITY_STOPWORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
  "g",
);

/** 查询词规范化：仅折叠空白（格式化，非截断）——长度对齐主流 agent 交由模型
 * 自决与搜索后端自限，代码层不做任何字符切除（静默切半句破坏查询语义）。 */
function normalizeQuery(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 回复是否「宣称做过搜索/检索」（2026-09-13 搜索宣称一致性闸的词面半边）。
 *
 * 判据一半是服务端已知事实（本轮有没有真实搜索执行过/证据注入过——代码
 * 确定知道），词面只负责识别「宣称」行为本身，不做话题判定：系统没搜过而
 * 回复宣称搜过 = 确定性违约，与回复聊什么话题无关。
 */
const SEARCH_CLAIM_RE =
  /搜出来|搜到|搜过|搜了|搜了一圈|搜一遍|翻了|翻遍|查了|查过|查不到|查一圈|检索到|检索过|联网(?:搜索|查询|检索)|网上(?:查|搜)|各大?(?:平台|渠道)(?:都)?(?:翻|查|搜)|公开渠道/;

export function claimsWebSearch(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 2000) return false;
  return SEARCH_CLAIM_RE.test(t);
}

function stripStopwords(text: string): string {
  return (text ?? "").replace(STOPWORD_RE, " ");
}

/**
 * 剥行首称呼语（「王哥，…」）：assistant 回复恒以对用户的称呼开头，被称呼者
 * 是受话人不是所指实体，但词频极高（每条回复一次），频次统计里会压过真名
 * （真实测试实证「王哥 她最近在哪」）。称谓段 = 行首 1-4 个非标点字符 + 逗号。
 */
function stripLeadingVocative(line: string): string {
  return (line ?? "").replace(/^\s*[^\s，。；！？、]{1,4}[,，]/, " ");
}

/** 用户当前消息剥停用词后的首个实体：有则当前消息实体最优先。 */
function pickEntityFromText(text: string): string | null {
  const cleaned = stripStopwords(text);
  const cjk = [...cleaned.matchAll(CJK_ENTITY_RE)].map((m) => m[0]);
  if (cjk.length > 0) return cjk[0];
  const latin = [...cleaned.matchAll(LATIN_ENTITY_RE)].map((m) => m[0]);
  return latin.length > 0 ? latin[0] : null;
}

/** 角色/指代词表（用于识别「实体映射行」，如「称『老婆』→刘浩存」）。 */
const ROLE_WORD_RE = /她|他|老婆|老公|女朋友|男朋友|对象|媳妇/;

/**
 * 上下文行频次选实体。三个确定性判别信号（真实测试多轮打磨）：
 *   1. 频次：候选在各行出现次数；
 *   2. 角色同现加权 ×2：行内含用户消息同款角色词（她/老婆…）的行是「实体映射
 *      行」（如「关注演员刘浩存（称『老婆』）」），其候选更可能是所指实体；
 *   3. 长度加权 ×2：≥3 字候选（中文人名典型长度）压过 2 字称呼/泛词
 *      （王哥/用户/周日这类高频非实体词）。
 * CJK 候选严格优先于拉丁候选（recap 英文虚词 the/assistant 词频高但全是噪声）。
 * 返回 null 表示上下文无任何实体。
 */
function pickEntityFromContext(
  lines: string[],
): string | null {
  type Entry = { display: string; n: number; len: number; first: number; score: number };
  const cjk = new Map<string, Entry>();
  const latin = new Map<string, Entry>();
  let order = 0;
  const bump = (map: Map<string, Entry>, display: string, lineWeight: number): void => {
    const key = display.toLowerCase();
    const hit = map.get(key);
    if (hit) {
      hit.n += 1;
      hit.score += lineWeight;
    } else {
      map.set(key, { display, n: 1, len: display.length, first: order, score: lineWeight });
    }
    order += 1;
  };
  for (const line of lines) {
    const cleaned = stripStopwords(stripLeadingVocative(line));
    // 角色行判定用完整角色词表（不要求与用户消息同词）：用户说「她」，记忆里写
    // 的是「称『老婆』」——同一所指在不同语料里用词不同，任一角色词在行内即
    // 视为「实体映射行」（真实测试实证：按同词匹配会让映射行拿不到加权）。
    const lineWeight = ROLE_WORD_RE.test(line) ? 2 : 1;
    for (const m of cleaned.matchAll(CJK_ENTITY_RE)) {
      const run = m[0];
      if (run.length <= 4) {
        bump(cjk, run, lineWeight * (run.length >= 3 ? 2 : 1));
      } else {
        // 无分词的长串（修饰语+实体粘连）：只取头/尾 2-4 字滑窗作候选，
        // 长串整体不当候选（同频时 len 优先会让它压过真名）。
        for (const w of [2, 3, 4]) {
          bump(cjk, run.slice(0, w), lineWeight * (w >= 3 ? 2 : 1));
          bump(cjk, run.slice(-w), lineWeight * (w >= 3 ? 2 : 1));
        }
      }
    }
    for (const m of cleaned.matchAll(LATIN_ENTITY_RE)) bump(latin, m[0], lineWeight);
  }
  const bestOf = (counts: Map<string, Entry>): Entry | null => {
    let best: Entry | null = null;
    for (const e of counts.values()) {
      if (!best) {
        best = e;
        continue;
      }
      if (e.score !== best.score) {
        if (e.score > best.score) best = e;
        continue;
      }
      // 同分：长度最接近 3 字者优先（中文人名典型长度；4 字滑窗伪影/2 字称呼词退位）
      const eNameFit = Math.abs(e.len - 3);
      const bNameFit = Math.abs(best.len - 3);
      if (eNameFit < bNameFit || (eNameFit === bNameFit && e.first < best.first)) best = e;
    }
    return best;
  };
  return bestOf(cjk)?.display ?? bestOf(latin)?.display ?? null;
}

/**
 * 构造 realtime 轮的搜索词（确定性，无 LLM 参与）。
 * contextLines：最近对话（最旧在前）+ 记忆档案/profile 行——实体频次统计语料。
 */
export function composeRealtimeSearchQuery(
  userText: string,
  contextLines: string[] = [],
): string {
  const text = (userText ?? "").trim();
  if (!text) return "";
  // 当前消息自带实体 → 原话即查询词（实体已在其中，不重复拼接）
  if (pickEntityFromText(text)) return normalizeQuery(text);
  // 纯指代消息 → 上下文频次选实体，拼「实体 + 查询词」
  const entity = pickEntityFromContext(contextLines);
  if (entity) return normalizeQuery(`${entity} ${text}`);
  // 无任何实体 → 查询词兜底（仍是可执行的搜索词）
  return normalizeQuery(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// media 轮查询词的确定性构造器（2026-10-10，搜图轮「时有时无」根治的查询半边）
//
// 契约与 realtime 同构：路由器判 media_retrieval 后，查询词必须由**纯代码**构造
// 出来，不依赖模型自觉。图片/视频搜索词和网页搜索词的构造策略不同：命令动词
// （搜索/找/来几张）和媒体载体名词（照片/图片）对图库检索没有区分度，剥离后
// 剩余主体就是更好的查询词（「搜索几张马尔代夫的照片」→「马尔代夫」）。
// 剥完不剩主体（「来点图」）→ 退回 composeRealtimeSearchQuery 实体消解兜底。
// ─────────────────────────────────────────────────────────────────────────────

/** 媒体命令词/载体词：对图库检索无区分度，构造查询词时剥离。长词优先匹配。 */
const MEDIA_COMMAND_WORDS: string[] = [
  // 命令动词与口语变体
  "搜索", "搜一下", "搜搜", "搜个", "搜", "找找", "找一下", "找一找", "找些", "找",
  "查一下", "查查", "看看", "看下", "给我看", "给我", "帮我", "帮忙", "麻烦", "请问", "请",
  // 数量词与结构助词（「几个/那张/XX的照片」剥离后实体不粘连）
  "来几张", "来几", "来张", "来点", "几张", "几", "一些", "多来", "个", "张", "些", "的",
  // 媒体载体名词（壁纸/头像/表情包等**图片类型词不剥**——它们是有效检索词）
  "照片", "图片", "美图", "相片", "配图", "图",
  // 视频载体词（配合 mediaToolNameForText 选 search_videos）
  "视频", "影片", "录像", "短片", "片段",
  // 语气收尾
  "吧", "呀", "啊", "呢", "呗", "一下",
];

const MEDIA_COMMAND_RE = new RegExp(
  [...MEDIA_COMMAND_WORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
  "g",
);

/** 中文媒体轮常用的视频诉求判定：命中 → 确定性预执行 search_videos 而非 search_images。 */
const VIDEO_ASK_RE = /视频|影片|录像|短片|片段|视频了/;

export function mediaToolNameForText(text: string): "search_images" | "search_videos" {
  return VIDEO_ASK_RE.test(text ?? "") ? "search_videos" : "search_images";
}

/** 媒体载体词（图/视频类诉求的实体形态）。 */
const MEDIA_CARRIER_RE = /照片|图片|相片|图像|写真|图集|壁纸|头像|表情包|美图|视频|影片|短片|片段/;
/** 资讯诉求词：出现任一即说明用户要的是文字信息，不按纯媒体轮处理。 */
const INFO_NEED_RE = /新闻|动态|近况|消息|资料|介绍|是谁|哪位|谁|年龄|生日|作品|行程|价格|对比|区别|怎么样|怎么|为什么|多少|哪[儿里个些]/;

/**
 * 是否是「纯媒体请求」（2026-10-21 根修，投机检索的输入半边）。
 *
 * 只用于决定**要不要在路由结果出来前先发一次网页检索**：用户原话是媒体
 * 载体诉求（照片/图片/视频…）且没有资讯诉求词时，网页检索注定是白跑，
 * 而且一旦路由超时降级，投机结果还会被注入成「新闻证据」污染照片卡。
 * 命中即不投机；用户在问近况/资料/是谁时不算纯媒体（照常投机/走实时检索）。
 */
export function isMediaOnlyRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 60) return false;
  if (!MEDIA_CARRIER_RE.test(t)) return false;
  return !INFO_NEED_RE.test(t);
}

/**
 * 构造 media 轮的图片/视频搜索词（确定性，无 LLM 参与）。
 * contextLines：最近对话 + 记忆档案行（仅在全被命令词剥光时的实体兜底用）。
 */
export function composeMediaSearchQuery(
  userText: string,
  contextLines: string[] = [],
): string {
  const text = (userText ?? "").trim();
  if (!text) return "";
  // 1) 剥媒体命令词/载体词，剩余主体即查询词（保留原语序中的限定词）
  const stripped = text.replace(MEDIA_COMMAND_RE, " ").replace(/\s+/g, " ").trim();
  if (stripped.replace(/[，。！？、,.!?~～]/g, "").length >= 2) {
    return normalizeQuery(stripped);
  }
  // 2) 命令词吃光主体（「来点图」「找照片」）→ 实体消解兜底
  return composeRealtimeSearchQuery(text, contextLines);
}

// ─────────────────────────────────────────────────────────────────────────────
// travel 轮行程请求的确定性构造器（2026-10-10 P1，与 media/realtime 同构）
//
// 契约：路由判 travel_planning 后，travel.plan-itinerary 的调用参数必须由
// **纯代码**构造——「要不要规划」在意图判定处已定，「用什么参数调」不依赖模型。
// 构造质量只影响参数显式度，不影响调用正确性：travel.plan-itinerary 的 input
// 收自然语言原文（技能内部引擎自行抽取目的地/天数），destination/days 是代码
// 能确定性抽出的结构化增量。目的地抽不出（纯指代轮）→ 返回 destination 空，
// agent-core 不预执行（避免必然失败的空参调用），回退模型自决 + 域预载可见。
// ─────────────────────────────────────────────────────────────────────────────

export type TravelPlanRequest = {
  /** 自然语言需求原文（技能必填参数，恒为用户原话） */
  input: string;
  /** 代码抽取的目的地（抽不出则缺省） */
  destination?: string;
  /** 代码抽取的天数（抽不出则缺省） */
  days?: number;
};

/** 规划命令词/载体词：对目的地抽取无区分度，剥离后剩余主体即候选目的地。 */
const TRAVEL_COMMAND_WORDS: string[] = [
  // 敬语/命令框架
  "麻烦你", "麻烦", "帮帮我", "帮我", "帮忙", "给我", "我想", "想要", "我要",
  "请", "来一份", "来一个", "做一份", "做一个", "出一份", "出一个",
  // 规划动词
  "规划一下", "规划", "安排一下", "安排", "制定", "计划一下", "计划", "整理", "做",
  // 疑问功能词（「怎么安排」「如何规划」——不是目的地成分）
  "怎么", "怎样", "如何", "哪些", "什么", "推荐",
  // 行程载体词（含组合：「旅游攻略」「行程规划」长词优先）
  "行程规划", "旅游攻略", "旅游指南", "旅行攻略", "行程安排", "行程", "攻略", "路线",
  "旅游", "旅行", "自由行", "出游", "游玩", "指南",
  // 2026-10-12 补漏：载体词表缺「旅程/之旅」→ 用户原话「规划两天的贵阳旅程」抽出的
  // 目的地是「贵阳旅程」（4 字 CJK 整段被当成地名，见 sniffTravelDestination）。
  // 脏目的地让实时 POI 搜索空转（餐厅恒 0）→ 多跑一轮空类别重试（每轮死镜像 ~20s），
  // 直接推高规划耗时。同族其他载体词（旅游/旅行/游玩/出游）本就在表内。
  "旅程", "之旅", "出行", "度假",
  // 2026-10-24 串味事故补漏：礼貌前缀与规划动词同样是载体，不剥掉会与地名粘成
  // 一段 CJK（「帮我规划兴义」整口吞下），技能入口的地名闸门就只能拒收干净地名。
  "帮我规划", "帮我安排", "帮我", "帮忙", "请", "麻烦", "规划", "安排", "计划",
  // 方位/动作连接词
  "去", "到", "在", "玩", "逛", "游", "出发",
  // 「想」是意愿动词，粘在地名后会被 {2,6} CJK 连续段整口吞下（「上海想杭州」）
  "想",
  // 量词与结构助词
  "一份", "一个", "一下", "个", "的",
  // 时间限定（出发时间不是目的地：下周去三亚 → 三亚）
  "下周", "这周", "本周", "上周", "下个月", "下月", "这个月", "本月",
  "周末", "周一", "周二", "周三", "周四", "周五", "周六", "周日",
  "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期天",
  "今天", "明天", "后天", "国庆", "春节", "五一", "十一",
  // 模糊限定
  "大概", "大约", "差不多", "左右", "最多", "最好", "尽量",
  // 语气收尾
  "吧", "呀", "啊", "呢", "呗", "哦", "谢谢", "麻烦了",
];

const TRAVEL_COMMAND_RE = new RegExp(
  [...TRAVEL_COMMAND_WORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
  "g",
);

/** 中文数字 → 数值（天数抽取用） */
const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 抽取天数（确定性）。支持：「5天」「三天两夜」「一周」「两周」「一个星期」「周末」
 * 「两日游」。日期（「10月3日」）不当天数——「日」只在「X日游」形态才算。
 */
function sniffTravelDays(text: string): number | undefined {
  const t = text ?? "";
  const cnDay = t.match(/([一二两三四五六七八九十\d]+)\s*个?\s*天(?:\s*[一二两三四五六七八九十\d]+\s*夜)?/);
  if (cnDay) {
    const raw = cnDay[1] ?? "";
    const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : CN_NUM[raw];
    if (n != null && n >= 1 && n <= 30) return n;
  }
  const week = t.match(/([一二两三四五六七八九十\d]+)\s*个?\s*(?:个?星期|周)/);
  if (week) {
    const raw = week[1] ?? "";
    const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : CN_NUM[raw];
    if (n != null && n >= 1 && n <= 8) return n * 7;
  }
  const dayTour = t.match(/([一二两三四五六七八九十\d]+)\s*日\s*游/);
  if (dayTour) {
    const raw = dayTour[1] ?? "";
    const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : CN_NUM[raw];
    if (n != null && n >= 1 && n <= 30) return n;
  }
  if (/半\s*天/.test(t)) return 1;
  if (/周末/.test(t)) return 2;
  return undefined;
}

/**
 * 出发地判定（2026-10-24 三亚/成都串味事故）：必须在**未清洗**的原文上量——
 * 清洗会把「出发/到」这类角色线索一起擦掉。`从成都出发去三亚`、`成都到三亚4天`
 * 里的成都都是出发地，不是目的地。
 */
function isDepartureMention(rawText: string, name: string): boolean {
  const at = rawText.indexOf(name);
  if (at < 0) return false;
  const after = rawText
    .slice(at + name.length, at + name.length + 4)
    .replace(/[^一-鿿]/g, "");
  const before = rawText
    .slice(Math.max(0, at - 2), at)
    .replace(/[^一-鿿]/g, "");
  if (/^(出发|起飞|动身|到|去|飞)/.test(after)) return true;
  return /(从|自|在)$/.test(before);
}

/** 从剥净命令词/天数后的文本抽目的地：跳过出发地，取首个剩下的 2-6 字 CJK 串，退拉丁词。 */
function sniffTravelDestination(text: string): string | undefined {
  const cleaned = (text ?? "")
    .replace(/([一二两三四五六七八九十\d]+)\s*个?\s*(?:天|日|夜|个?星期|周)[两一二三四五六七八九十\d]*夜?/g, " ")
    .replace(/晚|夜/g, " ")
    .replace(TRAVEL_COMMAND_RE, " ");
  const cjk = [...cleaned.matchAll(/[\u4e00-\u9fff]{2,6}/g)]
    .map((m) => m[0])
    // 连接词粘在开头（「从成都出发」里的「从成都」）时剥掉；剩余不足 2 字不剥，
    // 免得「从江」「自贡」这类真地名被削成单字。
    .map((run) => (/^[从自在]/.test(run) && run.length > 2 ? run.slice(1) : run));
  if (cjk.length > 0) {
    // 全是出发地提及时退回首个候选（宁可给个次优目的地，也不能没有目的地）
    return cjk.find((run) => !isDepartureMention(text, run)) ?? cjk[0];
  }
  const latin = [...cleaned.matchAll(/\b[A-Za-z][A-Za-z0-9-]{1,}\b/g)].map((m) => m[0]);
  return latin.length > 0 ? latin[0] : undefined;
}

/**
 * 构造 travel_planning 轮的 travel.plan-itinerary 调用参数（确定性，无 LLM）。
 * contextLines：最近对话 + 记忆档案行（纯指代轮「规划个三天的行程」的目的地兜底）。
 * destination 抽不出时缺省——调用方（agent-core）按「无目的地不预执行」处理。
 */
export function composeTravelPlanRequest(
  userText: string,
  contextLines: string[] = [],
): TravelPlanRequest {
  const text = (userText ?? "").trim();
  if (!text) return { input: "" };
  const days = sniffTravelDays(text);
  const strippedForDest = text
    .replace(/([一二两三四五六七八九十\d]+)\s*个?\s*(?:天|日|夜|个?星期|周)/g, " ");
  let destination = sniffTravelDestination(strippedForDest);
  if (!destination) {
    // 纯指代轮：上下文实体消解兜底（「上周聊的三亚」→「三亚」）
    destination = pickEntityFromContext(contextLines) ?? undefined;
  }
  return {
    input: normalizeQuery(text),
    ...(destination ? { destination } : {}),
    ...(days != null ? { days } : {}),
  };
}

/**
 * 直接问「现在几点/今天几号/星期几」类当前时间问题（2026-10-11）。
 *
 * realtime 路由会把「现在几点」消解成搜索词「当前北京时间」走**网页搜索**，
 * 搜回来的是网页快照里爬取时刻的旧时间（真机实证：模型照抄快照答了
 * 「2026-05-08 周五 17:22」，与真实日期差了 5 个月）。时间这类确定性事实的
 * 证据源是**本地时钟**，不是网页——本判定用于在前置检索门禁里把时间问题
 * 重定向到 clock 证据（见 agent-core 的 runClockEvidence），绝不入搜索引擎。
 *
 * 口径收紧：只认「现在/当前/今天」限定的时间问句（「明天几点开会」是日程
 * 意图，不在此列）。
 */
export function isDirectCurrentTimeQuestion(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    /(现在|当前|此刻|今天|今日|今晚)[^。！？\n]{0,6}(几点|时间|日期|几号|多少号|星期|周[一二三四五六日天]|礼拜)/i.test(t) ||
    /几点了|现在几点|what time|current time|what('|’)?s the date/i.test(t)
  );
}
