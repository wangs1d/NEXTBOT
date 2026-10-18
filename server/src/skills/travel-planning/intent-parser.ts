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

  // ===== 策略1: 已知热门目的地优先匹配（最高优先级）=====
  const knownDestinations = [
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

  const lowerText = workText.toLowerCase();
  // 按关键词长度倒序，优先匹配最长的（比如"云南大理"优先于"大理"）
  const sortedKnown = [...knownDestinations].sort((a, b) => b.length - a.length);
  for (const dest of sortedKnown) {
    if (lowerText.includes(dest.toLowerCase()) || workText.includes(dest)) {
      console.log(`[PlanningService] 目的地命中已知列表: ${dest}`);
      return dest;
    }
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

// ======================== 偏好解析 ========================

/**
 * 从自然语言 + 自由文本标签 + 目的地常识中抽取结构化偏好
 * 优先级：用户原文 > 目的地常识 > 系统默认
 * profileHints：用户画像（UserFact travel 类别）兜底——原文没说的 style 用画像补，
 * 来源标 profile，不覆盖用户本轮原话。
 */
export function extractPreferences(
  input: string,
  rawPrefs?: string[],
  destName?: string,
  profileHints?: { photoDriven?: boolean; experienceDriven?: boolean },
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

  // —— 目的地常识层（用户没说就补） ——
  if (destName) applyDestinationDefaults(destName, prefs);

  // —— 用户画像层（UserFact travel_style 兜底；不覆盖原文/目的地层） ——
  if (profileHints?.photoDriven && prefs.sources.photoDriven === 'default') {
    prefs.photoDriven = true; prefs.sources.photoDriven = 'profile';
  }
  if (profileHints?.experienceDriven && prefs.sources.experienceDriven === 'default') {
    prefs.experienceDriven = true; prefs.sources.experienceDriven = 'profile';
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
