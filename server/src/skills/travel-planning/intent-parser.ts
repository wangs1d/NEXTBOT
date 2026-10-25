/**
 * 意图解析器（A1 拆分：自 travel-planning-service 抽出的纯函数模块）
 *
 * 职责：从用户自然语言中解析规划要素——目的地 / 天数 / 结构化偏好。
 * 三层优先级：用户原文 > 目的地常识（applyDestinationDefaults）> 系统默认。
 * 无状态纯函数，可独立单测。
 */
import type { TripPreferences } from "./travel-planning-service.js";

// ======================== 目的地解析 ========================

/**
 * 已知热门目的地表（同时是「这个字符串像不像个目的地」的判据）。
 *
 * 抽地名的两条路径都可能吐出脏词（「就按你」「上海想」），下游拿它去覆盖模型参数
 * 之前必须过这张表——宁可漏判，不可把对的改成垃圾。
 */
const KNOWN_DESTINATIONS = [
  // 国内
  '云南大理','大理','云南丽江','丽江','北京','上海','杭州','成都','西安','厦门','三亚',
  '桂林','拉萨','青岛','重庆','南京','苏州','长沙','张家界','哈尔滨','武汉','广州',
  '深圳','香港','澳门','台北','昆明','黄山','九寨沟','张家界','敦煌','乌镇','凤凰古城',
  '平遥古城','周庄','西塘','千岛湖','普陀山','峨眉山','武夷山','泰山','华山','衡山',
  '嵩山','恒山','五台山','长白山','天池','喀纳斯','吐鲁番','喀什','稻城亚丁','四姑娘山',
  '莫干山','安吉','千岛湖','普陀山','雁荡山','天台山',
  // 国外
  '东京','大阪','京都','奈良','北海道','富士山','曼谷','清迈','普吉岛','苏梅岛',
  '巴厘岛','新加坡','吉隆坡','马六甲','首尔','釜山','济州岛','巴黎','罗马','伦敦',
  '纽约','悉尼','迪拜','伊斯坦布尔','开罗','马尔代夫','塞班岛','长滩岛','岘港',
  '芽庄','富国岛','暹粒','斯里兰卡','马尔代夫','斐济','大溪地','塞舌尔','毛里求斯',
  '布拉格','阿姆斯特丹','巴塞罗那','雅典','圣托里尼','威尼斯','佛罗伦萨',
];

/** 是否已知目的地名（精确匹配，供下游做「可信地名」闸门）。 */
export function isKnownDestinationName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.trim();
  return KNOWN_DESTINATIONS.includes(n);
}

/** 指代/意愿/规划动词/语气词——出现在「地名」里说明它是抽脏了的句子片段。 */
const NON_DESTINATION_CHARS = /[我你他她它们这那哪怎什想要会能可帮请定排弄搞做办吧嘛呢吗啊]/;

/**
 * 嗅探结果是否像可信地名：命中已知地名表，或是不含指代/动词/语气词的纯汉字短串。
 * 后者是为了小块目的地（兴义、婺源）不被误拒——它们不在表里，但字面干净。
 */
export function looksLikeDestinationName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 2 || n.length > 8) return false;
  if (isKnownDestinationName(n)) return true;
  return /^[\u4e00-\u9fff]+$/.test(n) && !NON_DESTINATION_CHARS.test(n);
}

/**
 * 出发地判定（2026-10-24 三亚/成都串味事故）：`从成都出发去三亚`、`成都到三亚`
 * 里的成都都是出发地。中文没有格标记，只能看紧邻的连接词。
 */
function isDepartureMention(text: string, name: string, at: number): boolean {
  const after = text.slice(at + name.length, at + name.length + 4).replace(/[^一-鿿]/g, "");
  const before = text.slice(Math.max(0, at - 2), at).replace(/[^一-鿿]/g, "");
  if (/^(出发|起飞|动身|到|去|飞)/.test(after)) return true;
  return /(从|自|在)$/.test(before);
}

/**
 * 从用户输入中提取目的地名称
 * 支持丰富的中文表达模式，优先匹配已知热门目的地
 */
export function extractDestination(input: string, explicitDest?: string): string {
  if (explicitDest && explicitDest.trim()) return explicitDest.trim();

  const text = input.trim();

  // ===== 策略0: 清理异常字符（emoji/乱码/控制字符）=====
  // 防止 destination 变成 "??????" 或 "未去莫干山民宿假放松为"
  const cleanedText = text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // emoji
    .replace(/[\uFFFD\uFFFC\uFF1F\uFF1A]/g, ' ')               // 替换字符/全角问号
    .replace(/[?？！!。，,]/g, ' ')                              // 标点
    .replace(/\s+/g, ' ')
    .trim();
  const workText = cleanedText || text;

  // ===== 策略1: 已知热门目的地优先匹配 =====
  // 按**在原文中出现的位置**择优，不按列表顺序：旧实现取「列表里第一个命中的城市」，
  // 于是「帮我规划三亚3天…从成都出发」被列表里排在三亚前面的成都抢走目的地
  // （实测：整份行程按成都排站，用户点名的三亚两岛零命中）。
  const sortedKnown = [...KNOWN_DESTINATIONS].sort((a, b) => b.length - a.length);
  const hits: Array<{ name: string; at: number }> = [];
  for (const dest of sortedKnown) {
    const at = workText.indexOf(dest);
    if (at >= 0) hits.push({ name: dest, at });
  }
  if (hits.length > 0) {
    // 同位置取最长（「云南大理」优先于「大理」），再取最早出现且不是出发地的那个
    hits.sort((a, b) => a.at - b.at || b.name.length - a.name.length);
    const picked = hits.find((h) => !isDepartureMention(workText, h.name, h.at));
    const dest = (picked ?? hits[0]).name;
    console.log(`[PlanningService] 目的地命中已知列表: ${dest}`);
    return dest;
  }

  // ===== 策略2: 正则模式匹配 =====
  const patterns = [
    // "我想去XXX玩/旅游/旅行"  - 限制目的地在 "去" 和 "玩/游" 之间的关键短语
    /(?:我想?去|前往|想去|计划去|准备去|要去)\s*([^\s,，。！？!?]{2,8}?)(?:\s*(?:玩|旅游|旅行|游玩|度假|逛|转|看看|考察))/,
    // "去XXX玩/游"
    /^(?:想)?(?:去|游览|参观|游玩|到)\s*([^\s,，。！？!?]{2,8})$/,
    // "XXX N天/日游/之旅" - 限制2-6个汉字，避免匹配整段
    /([^\s,，。！？!?]{2,6})(?:\s*\d+\s*[天日周]\s*(?:之)?游|之旅|旅游)/,
    // "XXX + 数字天" (如 "大理5天")
    /([^\s,，。！？!?]{2,6})\s+(\d+)\s*[天日]/,
  ];

  for (const p of patterns) {
    const m = workText.match(p);
    if (m && m[1]) {
      const dest = m[1].trim();
      if (dest.length >= 2 && dest.length <= 8) {
        console.log(`[PlanningService] 正则匹配目的地: ${dest}`);
        return dest;
      }
    }
  }

  // ===== 策略3: 提取前几个有意义的词作为目的地兜底 =====
  // 过滤掉动词和无关词
  const cleaned = workText
    .replace(/(?:我想?去|前往|想去|计划去|准备去|要去|到|玩|旅游|旅行|游玩|度|逛|转|看看|喜欢|希望|想要|需要|大概|大约|左右|预算|费用|花费|多少钱|放松|度假|为主|为主酒店|主酒店|主美食|主景点|未去|没去|不去|即将去)/g, '')
    .replace(/[天日个周月]/g, '')
    .replace(/\d+/g, '')
    .trim();

  const words = cleaned.split(/[\s,，、]+/).filter(w => w.length >= 2 && w.length <= 6);
  if (words.length > 0) {
    // 优先取第一个看起来像地名的词（含有"山/岛/城/湖/海/镇/村"等地理关键词）
    const geoWord = words.find(w => /[山川岛城湖海镇村寨古城]/.test(w));
    const dest = geoWord || words[0];
    if (dest && dest.length >= 2 && dest.length <= 8) {
      console.log(`[PlanningService] 兜底提取目的地: ${dest} (原文: ${input})`);
      return dest;
    }
  }

  // 真正的兜底：取前4个汉字（不再延长，避免出现"未去莫干山..."）
  const safe = workText.replace(/\s/g, '').slice(0, 4);
  console.warn(`[PlanningService] 无法提取目的地，使用前4字: ${safe} (原文: ${input})`);
  return safe || '未指定';
}

/**
 * 提取行程天数，支持丰富中文表达
 *  - "3天 / 三日 / 5天"
 *  - "一周 / 一个星期 / 两个星期 / 3周 / 两周半"
 *  - "半个月 / 10天"
 */
export function extractDays(input: string): number | null {
  // 数字+天/日
  const m = input.match(/(\d+)\s*[天日]/);
  if (m && m[1]) return Math.min(30, Math.max(1, parseInt(m[1])));

  // X周 / X星期（支持中文数字 + 任意个"个"等量词）
  const weekMatch = input.match(/([一二三四五六七八九十\d]+)\s*(?:个)?\s*(?:周|星期)/);
  if (weekMatch && weekMatch[1]) {
    const cnNum: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    const w = weekMatch[1];
    const n = cnNum[w] ?? parseInt(w) ?? 1;
    return Math.min(30, n * 7);
  }

  // 半个月
  if (/半\s*个?[月]/.test(input)) return 15;

  return null;
}

// ======================== 心愿/餐厅/同行人/出发信息 ========================

/** 切分并列点名的地点/餐厅（「想去看A、B和C」→ [A,B,C]） */
function splitNames(chunk: string): string[] {
  return chunk
    .split(/[、，,;；+和与及跟]| 或 /)
    .map((s) =>
      s
        .replace(/^[「『《“"'【(（\s]+/, "")
        .replace(/[」』》”"')】）\s]+$/, "")
        .replace(/^(的|了|吧|呢|呀)/, "")
        .replace(/^(看|游|逛|去|吃|参观|打卡|拜访|住)/, "")
        .replace(/(玩|旅游|旅行|看看|逛|一趟|打卡|一下|店|那家)$/g, "")
        .trim(),
    )
    .filter((s) => s.length >= 2 && s.length <= 16);
}

/** 菜系/业态词不是餐厅名，「想吃海鲜」走 diningStyle 而不是 wishlist（避免「没找到」噪音） */
const FOOD_CATEGORY_WORDS = [
  '海鲜','火锅','烧烤','小吃','日料','西餐','韩餐','泰餐','中餐','当地美食','特色美食','路边摊','夜市',
  '早餐','午餐','晚餐','咖啡','甜品','奶茶','素食','清真','自助餐','农家菜','私房菜','本地菜','辣','清淡',
];

const TRAVEL_VERB_TAILS = ['玩', '旅游', '旅行', '度假', '游', '看看', '转转', '逛'];

/**
 * 心愿景点（用户点名必须排进去的地点）。
 * 已知噪声源：「想去成都玩」里的城市就是目的地本身——传入 destName 剔掉，
 * 否则心愿闸会对整城做一次无意义搜索并回报「没找到」。
 */
export function extractWishlist(input: string, destName?: string): string[] {
  const text = input.replace(/\s+/g, " ");
  const out: string[] = [];
  const patterns = [
    /(?:一定要去|必须去|非去不可|心心念念|特别想去看|想去看看|想去看|想去|要去|想打卡|打卡|点名要去|特意想去看)\s*([^。！？!?；;，,\s]{2,40})/g,
    /(?:把|将)\s*([^。！？!?；;，,\s]{2,24}?)(?:排进|加进|放进|安排进|排到|列入)/g,
    /(?:愿望清单|心愿|必去清单|一定要去的(?:地方|景点|地方是)?)[：:]?\s*([^。！？!?；;，,\s]{2,40})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const name of splitNames(m[1] ?? "")) {
        if (out.includes(name)) continue;
        if (destName && (name === destName || name.includes(destName) || destName.includes(name))) continue;
        if (TRAVEL_VERB_TAILS.some((t) => name.endsWith(t))) continue;
        if (FOOD_CATEGORY_WORDS.includes(name)) continue;
        if (/^(什么|哪些|哪|它|他们|这边|那边|附近|当地|景点|餐厅|酒店|民宿)$/.test(name)) continue;
        out.push(name);
      }
    }
  }
  return out.slice(0, 8);
}

/** 点名餐厅（「想吃那家蜀香居、陈麻婆」）；菜系词走 diningStyle 不当餐厅名 */
export function extractFoodWishlist(input: string): string[] {
  const text = input.replace(/\s+/g, " ");
  const out: string[] = [];
  const patterns = [
    /(?:想吃|要吃|想去吃|务必吃|一定要吃|打卡这家|据说好吃想去|帮我排一家)\s*([^。！？!?；;，,\s]{2,40})/g,
    /(?:餐厅|饭店|馆子)(?:选|去|吃|叫)?[：:]?\s*([^。！？!?；;，,\s]{2,24})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const name of splitNames(m[1] ?? "")) {
        if (out.includes(name)) continue;
        if (FOOD_CATEGORY_WORDS.includes(name)) continue;
        if (/^(什么|哪些|哪|它|本地|当地|特色|附近)$/.test(name)) continue;
        out.push(name);
      }
    }
  }
  return out.slice(0, 6);
}

/** 吃饭倾向：本地人常去（老字号/苍蝇馆子）vs 网红打卡店 */
export function extractDiningStyle(input: string): 'local' | 'trendy' | 'mixed' | undefined {
  // 否定小句先摘掉（「别带我去网红店」不是想要网红店），再判两边
  const stripped = input.toLowerCase().replace(/(别|不要|不去|不想|不喜欢|不偏好|拒绝|讨厌)[^，,。！？;；]{0,10}/g, "");
  const local = /本地人|老字号|苍蝇馆子|地道|街坊|居民区|非网红|不去网红|游客店/.test(stripped);
  const trendy = /网红|打卡店|漂亮饭|出片餐厅|米其林|黑珍珠|小红书很火|很火的店/.test(stripped);
  if (local && trendy) return "mixed";
  if (local) return "local";
  if (trendy) return "trendy";
  return undefined;
}

/** 同行人构成（画像/原文都给；kids/elderly 仍由 extractPreferences 单独承载） */
export function extractParty(input: string): 'solo' | 'solo_female' | 'couple' | 'family' | 'friends' | undefined {
  const text = input;
  if (/(一个女生|女生一人|女 solo|姐妹俩|闺蜜俩|两个女生|一个人.{0,4}(女|她))/.test(text)) return "solo_female";
  if (/(情侣|对象|男朋友|女朋友|蜜月|两个人|两人|俩人|二人|新婚)/.test(text)) return "couple";
  if (/(一家三口|带孩子|带娃|亲子|全家|一家人|父母|爸妈|爹妈|老人|长辈)/.test(text)) return "family";
  if (/(朋友|同学|同事|闺蜜|兄弟|几个人|组团|团)/.test(text)) return "friends";
  if (/(一个人|独自|单独|独行|自己一人|solo)/.test(text)) return "solo";
  return undefined;
}

/**
 * 出发地（大交通方式判定的前提）。
 * 「从上海出发去成都」→ 上海；「上海飞大理」→ 上海。动词前置形式优先，
 * 避免把目的地误读成出发地。
 */
export function extractOrigin(input: string, destName?: string): string | undefined {
  const text = input.replace(/\s+/g, "");
  const patterns = [
    /(?:从|自)\s*([\u4e00-\u9fa5A-Za-z]{2,8}?)(?:出发|动身|飞|坐|乘|搭乘|自驾|开车|高铁|动车|到|去|直飞)/,
    /([一-龥A-Za-z]{2,8})(?:直飞|飞|坐高铁到|高铁到|开车到)\s*([\u4e00-\u9fa5A-Za-z]{2,8})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const cand = m?.[1]?.trim();
    if (!cand) continue;
    if (destName && (cand === destName || cand.includes(destName) || destName.includes(cand))) continue;
    if (/^(这里|这边|本地|现在|目前|家|家里)$/.test(cand)) continue;
    return cand;
  }
  return undefined;
}

const CN_WEEKDAY: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
const HOLIDAY_MD: Record<string, [number, number]> = {
  '元旦': [1, 1], '五一': [5, 1], '劳动节': [5, 1], '国庆': [10, 1], '十一': [10, 1], '圣诞': [12, 25],
};

function toISO(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** 中文/阿拉伯数量词 → 整数（「三天后」的三与 3 都要认） */
function cnInt(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[token] ?? 0;
}

/**
 * 出发日 YYYY-MM-DD（纯日历算术，本地时区）。
 * 支持：ISO/年月日、明天/后天/大后天、N 天后、下周X/这周X/周X、周末/下周末、
 * 元旦/五一/国庆/圣诞。月日已过 → 顺延到明年（跨年不说「明年」也合理）。
 * 农历节日（春节/端午/中秋）不猜日期——宁缺毋滥，交给用户或 Agent 显式传参。
 */
export function extractStartDate(input: string, now: Date = new Date()): string | undefined {
  const text = input.replace(/\s+/g, "");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const iso = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (iso) return toISO(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const candidate = new Date(today.getFullYear(), m - 1, d);
      // 已过 → 明年（跨年前后的「1月2日走」不能排到昨天）
      if (candidate < today) return toISO(candidate.getFullYear() + 1, m, d);
      return toISO(candidate.getFullYear(), m, d);
    }
  }

  if (/大后天/.test(text)) return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + 3);
  if (/后天/.test(text)) return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + 2);
  if (/明天/.test(text)) return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + 1);
  const inDays = text.match(/(\d{1,2}|[一二两三四五六七八九十])\s*(?:天|日)后/);
  if (inDays) {
    const n = cnInt(inDays[1] ?? "1");
    if (n > 0) return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + n);
  }

  const nextWd = text.match(/(?:下个?|这下个?|本)?(?:周|星期)([一二三四五六日天])/);
  if (/下(?:个)?(周|星期)/.test(text) && nextWd) {
    const target = CN_WEEKDAY[nextWd[1] ?? '一'] ?? 1;
    const delta = ((target - today.getDay() + 7) % 7 || 7) + 7;
    return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + delta);
  }
  if (/下周末/.test(text)) {
    const delta = ((6 - today.getDay() + 7) % 7 || 7) + 7;
    return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + delta);
  }
  if (nextWd) {
    const target = CN_WEEKDAY[nextWd[1] ?? '一'] ?? 1;
    const delta = (target - today.getDay() + 7) % 7;
    return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + (delta === 0 ? 7 : delta));
  }
  if (/(这)?周末/.test(text)) {
    const delta = (6 - today.getDay() + 7) % 7;
    return toISO(today.getFullYear(), today.getMonth() + 1, today.getDate() + (delta === 0 ? 0 : delta));
  }
  for (const [name, [m, d]] of Object.entries(HOLIDAY_MD)) {
    if (text.includes(name)) {
      const candidate = new Date(today.getFullYear(), m - 1, d);
      if (candidate < today) return toISO(today.getFullYear() + 1, m, d);
      return toISO(today.getFullYear(), m, d);
    }
  }
  return undefined;
}

/**
 * 住宿落位诉求：靠海 / 近机场 / 近车站 / 近某景点 / 市中心。
 * 「住得离兵马俑近点」这类点名（attraction + ref）是用户真实诉求里最常见、
 * 也最容易被「景点质心」逻辑忽略的一档，必须单独抽出交给选房逻辑。
 */
export function extractHotelFocus(
  input: string,
): { focus: 'seaside' | 'airport' | 'station' | 'attraction' | 'downtown'; ref?: string } | undefined {
  const text = input.replace(/\s+/g, "");
  // 「住得离兵马俑近点」与「住在兵马俑附近的酒店」是两条句式：前者带离/距，
  // 后者把参照点放在 附近 之前——分开抽，混用会把「的酒店」当成景点名。
  const near = text.match(/(?:住|酒店|住宿|房间)[^。！？;；，,]{0,8}?(?:离|距|靠近|挨着)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:高铁站|火车站|机场|站|门口)?)\s*(?:近|最近|方便|不远)?/);
  const named = text.match(/(?:住在|住|酒店|住宿)(?:在)?([^。！？;；，,]{2,16}?)(?:附近|旁边|边上)/);
  if (/(住|酒店|住宿)[^。！？;；，,]{0,6}?(靠海|海景|海边|沙滩|一线海)/.test(text)) return { focus: 'seaside' };
  if (/(机场|航班|飞机)[^。！？;；，,]{0,4}?(近|方便|接驳)|离机场近|赶早班机|转机/.test(text)) return { focus: 'airport' };
  if (/(高铁|火车|动车|车站)[^。！？;；，,]{0,4}?(近|方便)|离车站近|出站方便/.test(text)) return { focus: 'station' };
  const rawRef = near?.[1] ?? named?.[1];
  const ref = rawRef
    ?.replace(/^(的|了|在|是|去|到)/, "")
    ?.replace(/(的)?(酒店|住宿|民宿|客栈|附近|旁边|边上|门口|站)$/g, "")
    .trim();
  if (ref && ref.length >= 2 && !/^(这里|那边|景点|市区|市中心|地铁|哪个|什么)/.test(ref)) {
    return { focus: 'attraction', ref };
  }
  if (/(市中心|市区|老城|步行商圈|交通方便)/.test(text)) return { focus: 'downtown' };
  return undefined;
}

// ======================== 偏好解析 ========================

/**
 * 从自然语言 + 自由文本标签 + 目的地常识中抽取结构化偏好
 * 优先级：用户原文 > 目的地常识 > 用户画像 > 系统默认；
 * opts.explicit（工具入参 / 简报卡回传）是用户答过的话，与原文同权（标 user）。
 */
export function extractPreferences(
  input: string,
  rawPrefs?: string[],
  destName?: string,
  profileHints?: { photoDriven?: boolean; experienceDriven?: boolean },
  opts?: {
    now?: Date;
    explicit?: {
      origin?: string;
      startDate?: string;
      party?: TripPreferences['party'];
      wishlist?: string[];
      foodWishlist?: string[];
      stayWishlist?: string[];
      hotelFocus?: TripPreferences['hotelFocus'];
      hotelFocusRef?: string;
    };
  },
): TripPreferences {
  const text = `${input || ''} ${(rawPrefs || []).join(' ')}`.toLowerCase();
  const has = (kw: string | RegExp) => (kw instanceof RegExp ? kw.test(text) : text.includes(kw));

  const prefs: TripPreferences = {
    raw: rawPrefs ? [...rawPrefs] : [],
    seaside: false,
    pool: false,
    activities: false,
    kids: false,
    elderly: false,
    pace: 'balanced',
    activityMix: 'mixed',
    photoDriven: false,
    experienceDriven: false,
    sources: {
      seaside: 'default',
      pool: 'default',
      activities: 'default',
      kids: 'default',
      elderly: 'default',
      pace: 'default',
      activityMix: 'default',
      budget: 'default',
      cuisine: 'default',
      hotelTier: 'default',
      photoDriven: 'default',
      experienceDriven: 'default',
      wishlist: 'default',
      foodWishlist: 'default',
      diningStyle: 'default',
      party: 'default',
      origin: 'default',
      startDate: 'default',
      hotelFocus: 'default',
      hotelFocusRef: 'default',
    },
  };

  // —— 用户原文层 ——
  // 海边 / 海景 / 滨海岸
  if (has(/海[边滨景]?/) || has(/海[滨岸]/) || has(/靠海/) || has(/沙滩/) || has(/海岛/) || has(/beach|seaside|ocean/)) {
    prefs.seaside = true; prefs.sources.seaside = 'user';
  }

  // 泳池
  if (has(/泳池/) || has(/游泳池/) || has(/pool|swimming/)) {
    prefs.pool = true; prefs.sources.pool = 'user';
  }

  // 游玩项目 / 活动 / 玩什么
  if (
    has(/有什么好玩的/) || has(/好玩的项目/) || has(/玩什么/) || has(/有什么项目/) ||
    has(/游玩项目/) || has(/娱乐项目/) || has(/活动/) || has(/体验/) || has(/activities|tour|sightseeing/)
  ) {
    prefs.activities = true; prefs.sources.activities = 'user';
  }

  // 同行人
  if (has(/带[小孩宝宝孩子]/) || has(/亲子/) || has(/全家/) || has(/一家人/)) {
    prefs.kids = true; prefs.sources.kids = 'user';
  }
  if (has(/带[老人父母长辈]/) || has(/父母/) || has(/老人/)) {
    prefs.elderly = true; prefs.sources.elderly = 'user';
  }

  // 出片向：漂亮饭/网红打卡/机位优先（travel-upgrade-plan 偏好信号）
  if (
    has(/出片/) || has(/漂亮饭/) || has(/网红打卡/) || has(/网红店/) || has(/打卡点/) ||
    has(/机位/) || has(/氛围感/) || has(/拍照好看/) || has(/好拍/) || has(/适合拍照/)
  ) {
    prefs.photoDriven = true; prefs.sources.photoDriven = 'user';
  }

  // 体验向：项目/玩法优先
  if (
    has(/体验感/) || has(/好玩的项目/) || has(/刺激/) || has(/户外/) || has(/徒步/) ||
    has(/露营/) || has(/潜水/) || has(/滑雪/) || has(/钓鱼/) || has(/垂钓/) ||
    has(/越野/) || has(/漂流/) || has(/蹦极/) || has(/自驾穿越/)
  ) {
    prefs.experienceDriven = true; prefs.sources.experienceDriven = 'user';
  }

  // 节奏
  if (has(/休闲/) || has(/慢游/) || has(/度假/) || has(/放松/) || has(/悠闲/) || has(/懒/)) {
    prefs.pace = 'relaxed'; prefs.sources.pace = 'user';
  } else if (has(/紧凑/) || has(/高效/) || has(/深度游/) || has(/打卡/) || has(/多去/)) {
    prefs.pace = 'intensive'; prefs.sources.pace = 'user';
  }

  // 活动类型偏好
  if (has(/文化/) || has(/古迹/) || has(/历史/) || has(/博物馆/) || has(/寺庙/)) {
    prefs.activityMix = 'culture'; prefs.sources.activityMix = 'user';
  } else if (has(/自然/) || has(/山水/) || has(/徒步/) || has(/国家公园/) || has(/风景/)) {
    prefs.activityMix = 'nature'; prefs.sources.activityMix = 'user';
  } else if (has(/娱乐/) || has(/乐园/) || has(/购物/) || has(/夜生活/)) {
    prefs.activityMix = 'entertainment'; prefs.sources.activityMix = 'user';
  }

  // 预算档
  if (has(/省[钱一点]?/) || has(/便宜/) || has(/经济/) || has(/穷游/) || has(/预算[不紧]?[太多高]/)) {
    prefs.budget = 'low'; prefs.sources.budget = 'user';
  } else if (has(/豪华/) || has(/高端/) || has(/奢/) || has(/奢华/) || has(/五星/)) {
    prefs.budget = 'high'; prefs.sources.budget = 'user';
  } else if (has(/舒适/) || has(/中端/) || has(/四星/)) {
    prefs.budget = 'mid'; prefs.sources.budget = 'user';
  }

  // 住宿档次（仅影响酒店排序）
  if (has(/豪华酒店/) || has(/五星/) || has(/高端住宿/) || has(/奢华/)) {
    prefs.hotelTier = 'luxury'; prefs.sources.hotelTier = 'user';
  } else if (has(/经济/) || has(/青旅/) || has(/民宿/) || has(/客栈/)) {
    prefs.hotelTier = 'budget'; prefs.sources.hotelTier = 'user';
  } else if (has(/舒适/) || has(/精品/) || has(/四星/)) {
    prefs.hotelTier = 'mid'; prefs.sources.hotelTier = 'user';
  }

  // 菜系
  const cuisineMap: Array<[RegExp, string]> = [
    [/海鲜/, '海鲜'],
    [/中餐|中国菜|中厨/, '中餐'],
    [/日料|日本菜|寿司|刺身/, '日料'],
    [/韩餐|韩国|烤肉|韩式/, '韩餐'],
    [/西餐|法国|意面|意大利|牛排/, '西餐'],
    [/泰餐|泰国|冬阴功/, '泰餐'],
    [/火锅|麻辣/, '火锅'],
    [/烧烤|撸串/, '烧烤'],
    [/甜品|咖啡|下午茶/, '甜品'],
    [/当地|本地|特色/, '当地特色'],
  ];
  for (const [re, name] of cuisineMap) {
    if (re.test(text)) {
      prefs.cuisine = name; prefs.sources.cuisine = 'user';
      break;
    }
  }

  // —— 心愿点 / 点名餐厅 / 同行人 / 出发信息（原文层，用户答过的 explicit 同权） ——
  const fullText = `${input || ''} ${(rawPrefs || []).join(' ')}`;
  const explicit = opts?.explicit;
  const cleanList = (list?: string[]): string[] =>
    (list ?? []).map((s) => (s ?? "").trim()).filter((s) => s.length >= 2 && s.length <= 24).slice(0, 8);

  const wlExplicit = cleanList(explicit?.wishlist);
  const wl = wlExplicit.length > 0 ? wlExplicit : extractWishlist(fullText, destName);
  if (wl.length > 0) {
    prefs.wishlist = wl;
    prefs.sources.wishlist = 'user';
  }
  const fwExplicit = cleanList(explicit?.foodWishlist);
  const fw = fwExplicit.length > 0 ? fwExplicit : extractFoodWishlist(fullText);
  if (fw.length > 0) {
    prefs.foodWishlist = fw;
    prefs.sources.foodWishlist = 'user';
  }
  const swExplicit = cleanList(explicit?.stayWishlist);
  if (swExplicit.length > 0) {
    prefs.stayWishlist = swExplicit;
    prefs.sources.stayWishlist = 'user';
  }
  const style = extractDiningStyle(fullText);
  if (style) {
    prefs.diningStyle = style;
    prefs.sources.diningStyle = 'user';
  }
  const partyExplicit = explicit?.party;
  const party = partyExplicit ?? extractParty(fullText);
  if (party) {
    prefs.party = party;
    prefs.sources.party = 'user';
  }

  const originExplicit = explicit?.origin?.trim();
  const origin = originExplicit || extractOrigin(fullText, destName);
  if (origin) {
    prefs.origin = origin;
    prefs.sources.origin = 'user';
  }
  const startExplicit = explicit?.startDate?.trim();
  const startDate = (startExplicit && /^\d{4}-\d{2}-\d{2}$/.test(startExplicit) ? startExplicit : undefined)
    || extractStartDate(fullText, opts?.now);
  if (startDate) {
    prefs.startDate = startDate;
    prefs.sources.startDate = 'user';
  }
  const focusExplicit = explicit?.hotelFocus;
  const focusParsed = focusExplicit ? undefined : extractHotelFocus(fullText);
  const focus = focusExplicit ?? focusParsed?.focus;
  if (focus) {
    prefs.hotelFocus = focus;
    prefs.sources.hotelFocus = 'user';
    const ref = explicit?.hotelFocusRef ?? focusParsed?.ref;
    if (ref) {
      prefs.hotelFocusRef = ref;
      prefs.sources.hotelFocusRef = 'user';
    }
  }

  // —— 目的地常识层（用户没说就补） ——
  if (destName) applyDestinationDefaults(destName, prefs);

  // —— 用户画像层（UserFact travel_style 兜底；不覆盖原文/目的地层） ——
  if (profileHints?.photoDriven && prefs.sources.photoDriven === 'default') {
    prefs.photoDriven = true; prefs.sources.photoDriven = 'profile';
  }
  if (profileHints?.experienceDriven && prefs.sources.experienceDriven === 'default') {
    prefs.experienceDriven = true; prefs.sources.experienceDriven = 'profile';
  }
  // 吃饭倾向兜底：出片向（画像或原文）→ 网红/漂亮饭优先；体验向 → 本地馆子优先。
  // 标 profile 让简报卡能说清「这是按你的习惯推的」，用户一眼可否掉。
  if (!prefs.diningStyle) {
    if (prefs.photoDriven) {
      prefs.diningStyle = 'trendy';
      prefs.sources.diningStyle = prefs.sources.photoDriven === 'user' ? 'user' : 'profile';
    } else if (prefs.experienceDriven) {
      prefs.diningStyle = 'local';
      prefs.sources.diningStyle = prefs.sources.experienceDriven === 'user' ? 'user' : 'profile';
    }
  }

  // —— 系统默认层 ——
  if (!prefs.hotelTier) {
    prefs.hotelTier = 'mid'; prefs.sources.hotelTier = 'default';
  }
  if (!prefs.budget) {
    prefs.budget = 'mid'; prefs.sources.budget = 'default';
  }

  return prefs;
}

/**
 * 根据目的地常识补全偏好（用户没说时启用，但来源标为 destination）
 */
function applyDestinationDefaults(destName: string, prefs: TripPreferences): void {
  const n = destName.toLowerCase();

  // 海岛/海滨 → 默认 seaside + pool
  const islandKw = ['巴厘岛','bali','马尔代夫','maldives','普吉','phuket','三亚','沙巴','sabah',
                   '长滩','boracay','沙美','苏梅','koh samui','岘港','danang','芽庄','nha trang',
                   '宿务','cebu','长崎','冲绳','okinawa','济州','jeju','关岛','guam',
                   '斐济','fiji','塞班','saipan','帕劳','palau','印尼','印度尼西亚','indonesia'];
  if (islandKw.some(k => n.includes(k)) && prefs.sources.seaside === 'default') {
    prefs.seaside = true; prefs.sources.seaside = 'destination';
    if (prefs.sources.pool === 'default') { prefs.pool = true; prefs.sources.pool = 'destination'; }
    if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'mixed'; }
  }

  // 日本 → 美食/温泉/文化
  if (/日本|japan|东京|大阪|京都|奈良|北海道|富士山/.test(n)) {
    if (!prefs.cuisine) { prefs.cuisine = '日料'; prefs.sources.cuisine = 'destination'; }
    if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'culture'; prefs.sources.activityMix = 'destination'; }
  }
  // 韩国
  if (/韩国|korea|首尔|釜山|济州/.test(n)) {
    if (!prefs.cuisine) { prefs.cuisine = '韩餐'; prefs.sources.cuisine = 'destination'; }
  }
  // 泰国
  if (/泰国|thailand|曼谷|清迈|普吉|苏梅/.test(n)) {
    if (!prefs.cuisine) { prefs.cuisine = '泰餐'; prefs.sources.cuisine = 'destination'; }
  }
  // 东南亚综合
  if (/越南|新加坡|马来西亚|印尼|菲律宾|柬埔寨/.test(n)) {
    if (prefs.sources.activities === 'default') { prefs.activities = true; prefs.sources.activities = 'destination'; }
  }

  // 欧洲
  if (/法国|巴黎|意大利|罗马|英国|伦敦|西班牙|巴塞罗那|德国|瑞士|荷兰|希腊|葡萄牙/.test(n)) {
    if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'culture'; prefs.sources.activityMix = 'destination'; }
    if (prefs.sources.pace === 'default') { prefs.pace = 'balanced'; } // 步行多
  }

  // 阿联酋/迪拜 → 豪华
  if (/迪拜|阿联酋|dubai|uae/.test(n) && prefs.sources.hotelTier === 'default') {
    prefs.hotelTier = 'luxury'; prefs.sources.hotelTier = 'destination';
  }

  // 印度/尼泊尔/高原 → 节奏放松
  if (/印度|尼泊尔|不丹|拉萨|西藏|秘鲁|玻利维亚|肯尼亚/.test(n)) {
    if (prefs.sources.pace === 'default') { prefs.pace = 'relaxed'; prefs.sources.pace = 'destination'; }
  }

  // 带孩子常见目的地 → 默认亲子
  if (/日本|东京|disney|迪士尼|新加坡|环球影城/.test(n) && prefs.sources.kids === 'default') {
    // 仅当目的地含迪士尼/环球影城等亲子关键词
    if (/迪士尼|环球影城|legoland|乐高/.test(n)) {
      prefs.kids = true; prefs.sources.kids = 'destination';
    }
  }
}
