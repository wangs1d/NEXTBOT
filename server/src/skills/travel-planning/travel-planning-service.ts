/**
 * 智能行程规划服务
 *
 * 架构：实时搜索 + 持久化共享缓存
 *
 * 数据流：
 *   用户输入 → 解析目的地/天数 → 查缓存 → 命中?直接返回 : 调POI源搜索→存缓存→返回
 *
 * API来源（2026-10-15 OSM Overpass 退役，POI 换消费级源）：
 *   - 高德 v3 place/text: 国内 POI 搜索（景点/酒店/餐厅/咖啡茶馆，extensions=all 带实拍图）
 *   - Foursquare Places v3: 国际 POI 搜索（按类别 ID 分池，rating/photos 平台校验）
 *   - Nominatim: 仅地理编码（地名→坐标）
 *
 * 缓存：POICacheManager（文件持久化 + 内存加速，全局共享）
 */

import type { Coordinates, AgentTrace } from './types.js';
import https from 'node:https';
import { poiCache, type CacheEntry, type RawPOI } from './poi-cache-manager.js';
import { searchFoursquarePois, isFoursquareConfigured } from './foursquare-service.js';
import { pricingService, formatQuotePriceInfo, type MemberTier, type PriceQuote, type BoundPlatform, type PricingContext } from './pricing-service.js';
import { travelMediaStore } from './travel-media-store.js';
import { fetchBingPhotoUrls } from './bing-photos.js';
import { destinationCoverStore, type DestinationCoverSource } from './travel-destination-cover-store.js';
import { compressImage } from '../../services/image-caption-service.js';
import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from '../../external-model/resolve-provider.js';
import { modelSupportsVision } from '../../external-model/vision-support.js';
import OpenAI from 'openai';
import fs from 'node:fs';
import { WeatherService, type WeatherBrief } from '../../services/weather-service.js';
import { knowledgeBase } from './knowledge-base.js';
import { extractDays, extractDestination, extractPreferences } from './intent-parser.js';
import { travelFavoritesStore } from './travel-favorites-store.js';
import { emitTravelProgress } from './travel-progress-bus.js';
import { gcj02ToWgs84 } from './coord-transform.js';

/** 编排阶段的交通腿结果（OSRM 或 haversine 估算） */
type TransportLeg = { mode: string; durationMin: number; distanceKm: number; note?: string };

/** 单个时段的天气语境（供天气×时段智能排程） */
interface SlotWeatherCtx {
  rainy: boolean;
  hot: boolean;
  cold: boolean;
  precipPct: number;
}

/** 整日天气语境：上午/下午/晚间三段 + 全天聚合（天气获取失败时为 null，按中性天气排程） */
interface TripWeatherCtx {
  morning: SlotWeatherCtx;
  afternoon: SlotWeatherCtx;
  evening: SlotWeatherCtx;
  /** 白天（上午或下午）有雨 → 全天内景区分需室内优先 */
  isRainyDay: boolean;
  isHotDay: boolean;
  isColdDay: boolean;
  /** 一句话摘要（提示文案用） */
  summary: string;
}

/** 单个行程日的天气包：时段化语境 + 当天一句话摘要（天气获取失败 ctx=null，按中性天气排程） */
interface TripDayWeather {
  ctx: TripWeatherCtx | null;
  summary?: string;
}

/** 降雨相关 WMO 天气码（Open-Meteo） */
const RAIN_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// ==================== 行程级二级缓存 ====================
// 相同的 目的地+天数+偏好 组合，在 POI 缓存未刷新时整份行程直接复用。
// POI 缓存 set 时 createdAt 变化 → 行程缓存自然失效；图片回写不进 createdAt，
// 二次规划仍享受图片命中（见 collectMediaForDays）。
const ITINERARY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ITINERARY_CACHE_MAX = 48;
const itineraryCache = new Map<
  string,
  { ts: number; poiUpdatedAt: string; result: PlanningResult }
>();

/** 写入行程缓存（超过上限踢掉最旧的） */
function cacheItinerary(key: string, entry: { ts: number; poiUpdatedAt: string; result: PlanningResult }): void {
  itineraryCache.set(key, entry);
  if (itineraryCache.size <= ITINERARY_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of itineraryCache) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) itineraryCache.delete(oldestKey);
}

// ======================== 类型定义 ========================

export interface PlanningRequest {
  input: string;
  destination?: string;
  days?: number;
  preferences?: string[];
  /** 用户会员等级（normal/silver/gold/diamond/platinum） */
  memberTier?: MemberTier;
  /** 已绑定的外部平台账户（Booking/Agoda/携程/美团 等，OAuth 授权后传入） */
  boundPlatforms?: BoundPlatform[];
  /** 会话 ID（可选）：传入时通过 travel-progress-bus 向聊天侧流式汇报规划进度 */
  sessionId?: string;
}

/**
 * 从用户自然语言解析出的结构化偏好
 * （与 request.preferences 并集：自由文本标签 + 抽取出的语义标签 + 目的地常识 + 默认值）
 */
export interface TripPreferences {
  /** 原始自由文本标签 */
  raw: string[];
  /** 靠海/海景/海滨/沙滩 */
  seaside: boolean;
  /** 酒店带泳池（内置或室外） */
  pool: boolean;
  /** 想要更多游玩/活动项目（拉满每天景点数） */
  activities: boolean;
  /** 适合带小孩/亲子 */
  kids: boolean;
  /** 适合带老人 */
  elderly: boolean;
  /** 节奏：relaxed(2个景点/天) / balanced(3个) / intensive(4个) */
  pace: 'relaxed' | 'balanced' | 'intensive';
  /** 活动类型偏好：culture / nature / entertainment / mixed（自动从目的地下发） */
  activityMix: 'culture' | 'nature' | 'entertainment' | 'mixed';
  /** 预算档位：low / mid / high */
  budget?: 'low' | 'mid' | 'high';
  /** 菜系偏好：中餐/海鲜/西餐/日料/... */
  cuisine?: string;
  /** 住宿档次（提取自"豪华/精品/经济"等） */
  hotelTier?: 'budget' | 'mid' | 'luxury';
  /** 偏好来源标签：user=用户原文说 / destination=目的地常识 / default=系统默认 */
  sources: Record<keyof Omit<TripPreferences, 'raw' | 'sources'>, 'user' | 'destination' | 'default'>;
}

/**
 * 目的地实用信息（用户没主动问也补上）
 */
export interface TravelInfo {
  destination: string;
  visa: { required: boolean; type: '免签' | '落地签' | '电子签' | '需签证' | '另纸签'; notes?: string };
  currency: { name: string; code: string; symbol: string; rateToCNY?: number };
  timezone: { name: string; offset: string };
  language: string[];
  voltage: string;
  socket: string;
  bestSeason: { months: string[]; description: string };
  emergency: { police?: string; ambulance?: string; touristHotline?: string; chinaEmbassy?: string };
  customs: string[];
  tips: string[];
  /** 目的地一句话简介（行程卡海报区展示；知识库未命中时缺省，前端隐藏该行） */
  intro?: string;
  /** 出行随身物品叮嘱（行程卡「记得带」胶囊；知识库命中取条目，否则按通用模板） */
  packing?: string[];
}

export interface PlannedDay {
  date: string;
  items: ItineraryItem[];
  /** 当天天气一句话摘要（逐日预报；天气获取失败缺省，前端隐藏式消费） */
  dayWeather?: string;
}

export interface ItineraryItem {
  itemId: string;
  /** 对应 POI 缓存中的原始 id（用于图片复用/缓存回写） */
  poiId?: string;
  type: 'hotel' | 'attraction' | 'restaurant';
  name: string;
  description: string;
  startTime: string;
  endTime?: string;
  /** 从前一个item过来的交通方式+时长+距离（首项无） */
  transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
  /** 建议游览时长（分钟） */
  visitDuration?: number;
  /** 当地小贴士（用户没问也补） */
  tips?: string[];
  /** 预订提示（酒店/付费景点） */
  bookingNote?: string;
  latitude: number;
  longitude: number;
  rating: number;
  priceInfo: string;
  address: string;
  phone: string;
  openingHours: string;
  tags: string[];
  images: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL */
  splatUrl?: string;
  // 酒店特有
  pricePerNight?: number;
  starRating?: number;
  rooms?: Array<{ name: string; pricePerNight: number; capacity: number; amenities: string[]; image: string }>;
  // 景点特有
  ticketPrice?: number;
  category?: string;
  // 餐厅特有
  avgPrice?: number;
  priceLevel?: number;
  cuisine?: string;
  menuItems?: Array<Record<string, unknown>>;
  // 真实价格 + 优惠明细（来自 PricingService）
  priceQuote?: PriceQuote;
}

export interface PlanningResult {
  id: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  destination: string;
  center: Coordinates;
  days: PlannedDay[];
  pois: POISummary[];
  preferences: TripPreferences;
  /** 行程附加实用信息（用户没问也补） */
  travelInfo: TravelInfo;
  /** 整体价格汇总（货币/总原价/总优惠/总实付/价格模式） */
  pricingSummary?: {
    currency: 'CNY' | 'USD' | 'IDR' | 'JPY' | 'THB' | 'EUR' | 'HKD';
    totalOriginal: number;
    totalDiscount: number;
    totalFinal: number;
    memberTier?: MemberTier;
    boundPlatforms?: BoundPlatform[];
    pricingMode: 'real-api' | 'real-database' | 'estimated';
    warnings: string[];
  };
  fromCache: boolean;
  /** 出发日天气一句话摘要（Open-Meteo 实时预报；天气获取失败缺省，前端隐藏天气胶囊） */
  weather?: string;
  /**
   * 目的地代表性封面（行程卡海报区背景）：目的地本身的形象照，非任何单个
   * POI 的照片。解析链见 resolveDestinationCover（维基百科条目主图优先）。
   * 解析失败缺省 undefined —— 海报退回条目实拍/渐变兜底，不放占位图。
   */
  coverImage?: string;
  /** 数据可信度：real=实时API数据 / knowledge=知识库真实POI / synthetic=离线合成占位（前端需明示用户） */
  dataQuality?: "real" | "knowledge" | "synthetic";
}

export interface POISummary {
  id: string;
  name: string;
  type: 'attraction' | 'hotel' | 'restaurant';
  latitude: number;
  longitude: number;
  address: string;
  rating: number;
  cost?: string;
  description?: string;
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL */
  splatUrl?: string;
}

// ======================== OpenStreetMap / 高德地图 配置 ========================

/**
 * POI 名称可信度过滤（真实数据保证）：
 * OSM/高德会返回大量非旅游 POI（事故多发段、公厕、停车场、收费站、施工段…），
 * 这类名称混进行程会直接毁掉整份规划的可信度。命中黑名单的一律丢弃。
 */
const POI_NAME_BLACKLIST = [
  '事故', '公厕', '厕所', '洗手间', '停车场', '收费站', '加油', '充电桩',
  '垃圾', '污水', '殡仪', '火葬', '墓', '变电站', '配电', '水厂', '污水处理',
  '施工', '工地', '限速', '测速', '监控', '红绿灯', '信号灯', '公交站',
  '地铁站入口', '出入口', '售票处', '检票口', '充值', '营业厅', '警务',
  '派出所', '消防', '急诊', '发热门诊', '隔离', '收费站', '养护', '道班',
  // 单位内部食堂在 OSM 里常挂 amenity=restaurant，被当「餐厅」排进行程（用户实测踩坑）
  '食堂',
  // 高德脏 POI（2026-10-15 实证：keywords「公园」会命中挂错类目的机构/地名）
  '居委会', '村委会', '工作委员会', '社区服务', '绿道', '管理处', '工作站',
  '服务区', '养护站', '道班房', '门禁', '值班室',
];

function isPlausiblePoiName(name: string): boolean {
  const n = (name || '').trim();
  if (n.length < 2 || n.length > 30) return false;
  if (POI_NAME_BLACKLIST.some((bad) => n.includes(bad))) return false;
  // 纯数字/纯符号名（如「1号」「①」）对行程毫无意义
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(n)) return false;
  // 纯 ASCII 字母数字混排单 token（如「Mounbar423」）是 OSM 脏 name 标签的典型
  // 形态；带空格/连字符的正常店名（「Bar 423」「798艺术区」不受影响——后者含 CJK）
  if (/^[A-Za-z\d]+$/.test(n) && /[A-Za-z]/.test(n) && /\d/.test(n)) return false;
  return true;
}

/**
 * 配图查询限定词：给图搜补一个类型词（「同兴山庄 酒店」「黄鹤楼 景点」）。
 * 通用名 POI 不加限定词时图搜会返回大量不相关实拍（停车场/街景）；
 * 名称已含该词时不再重复（「XX酒店」不再拼成「XX酒店 酒店」）。
 */
function imageQualifierFor(type: string, poiName: string): string | undefined {
  const labels: Array<[RegExp, string]> = [
    [/^(attraction|sight|shopping|indoor|other)$/, '景点'],
    [/^(hotel|stay)$/, '酒店'],
    [/^(restaurant|food)$/, '美食'],
  ];
  const row = labels.find(([re]) => re.test(type || ''));
  if (!row) return undefined;
  const label = row[1];
  return (poiName || '').includes(label) ? undefined : label;
}

const OSM_NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

// ===== Wikimedia 图片搜索配置 =====
// 文件名黑名单：排除地图、图标、标记等非实拍图
const WIKI_BLOCKED_PATTERNS = [
  /map/i, /icon/i, /logo/i, /flag/i, /\bpin\b/i, /marker/i, /symbol/i,
  /svg$/i, /sign/i, /coat[_-]?of[_-]?arms/i, /pictogram/i, /emblem/i,
  /blank[_-]?flag/i, /no[_-]?image/i, /placeholder/i, /locator/i,
];
const WIKI_MIN_WIDTH = 640;
const WIKI_MIN_HEIGHT = 480;
const WIKI_GPS_MAX_RADIUS_KM = 50; // EXIF GPS 校验半径

// ===== 图库水印站（2026-10-15）=====
// 摄图网等图库的 CDN 预览图都烙着站标水印（699pic 实证：贵阳封面中幅
// 「摄图网 699pic.com」水印），做封面/POI 实拍图版权与观感双输；当前主模型
// MiniMax-M3 无视觉能力，rankCoverWithVlm 终审闸结构性缺席，host 级黑名单
// 是仅存的画质过滤（与 WIKI_BLOCKED_PATTERNS 文件名黑名单同族）。
const STOCK_WATERMARK_HOST_SUFFIXES = [
  '699pic.com',      // 摄图网（贵阳封面实测水印）
  'nipic.com',       // 我图网
  'vcg.com',         // 视觉中国
  'gettyimages.com', // Getty
  'ibaotu.com',      // 包图网
  '51yuansu.com',    // 觅元素
  'gaoding.com',     // 稿定设计
  '818ps.com',       // 稿定旗下
  'photophoto.cn',   // 图行天下
  'quanjing.com',    // 全景网
] as const;

function isStockWatermarkHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return STOCK_WATERMARK_HOST_SUFFIXES.some(
      (s) => host === s || host.endsWith(`.${s}`),
    );
  } catch {
    return false;
  }
}

// ===== 必应图片搜索（2026-10-12 起为 POI 配图的主源）=====
// 为什么是必应而不是 Wikimedia：本机网络下 commons.wikimedia.org 与
// zh.wikipedia.org 实测 http=000（10~12s 超时），配图链路因此只有 3.4% 覆盖率；
// cn.bing.com/images/async 实测 200 / 0.55s。Wikimedia 保留为兜底（网络恢复时可用）。
const BING_IMAGES_BASE = 'https://cn.bing.com/images/async';
const BING_IMAGES_TIMEOUT_MS = 6000;
/** 必应图片要浏览器 UA（默认 UA 会被拒）；候选尺寸无法从列表页拿，
    宽高校验留到下载落地时做（见 P2 照片本地化）。 */
const BING_IMAGES_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
/** 一次抓取的候选上限（多图轮播够用；过多会拖慢后台回填） */
const BING_MAX_IMAGES = 4;
/** Wikimedia 可达性探测：单次上限 3s、结果缓存 10 分钟（与熔断窗口同宽） */
const WIKI_IMAGES_PROBE_TIMEOUT_MS = 3000;
const WIKI_IMAGES_PROBE_TTL_MS = 10 * 60 * 1000;

// ===== 封面终审视觉侧车（2026-10-15）=====
// 主模型无视觉能力时（当前 MiniMax-M3），用 SiliconFlow 的 Qwen3-VL 看图
// 终审——质量闸从「必应首图抽签」恢复为「看图把关」（水印/街景/行政区图
// 都拦得住）。复用既有 SILICONFLOW_API_KEY，TRAVEL_COVER_VLM_MODEL 可换型号。
const COVER_VLM_SIDECAR_BASE_URL = 'https://api.siliconflow.cn/v1';
// Qwen2.5-VL 系已从 SF 下架（models.list 实证），现役为 Qwen3-VL；
// 选图只需输出一个序号，8B 最快最省，TRAVEL_COVER_VLM_MODEL 可换
// （SF 可用：Qwen3-VL-8B/32B-Instruct、Qwen3-VL-30B-A3B-Instruct）
const COVER_VLM_SIDECAR_MODEL =
  process.env.TRAVEL_COVER_VLM_MODEL || 'Qwen/Qwen3-VL-8B-Instruct';

/** 图片搜索端口：宿主可注入既有搜索服务；未注入时服务内部走必应直抓 */
export interface TravelImageSearchPort {
  /** 按查询词取真实图片 URL（返回空数组表示无结果，不抛错） */
  searchImages(query: string, limit?: number): Promise<string[]>;
}

/**
 * 视频/评论能力已于 2026-10-12 下线（评论的数据来源是视频评论区，无视频即无评论）。
 * 媒体库现只承载照片一类。对应的存储端口、过滤函数与装配注入一并移除。
 */

/** 备用地理编码（Photon，OSM 数据的免费检索服务），Nominatim 失败时切换而非直接抛错 */
const PHOTON_GEOCODE_BASE = 'https://photon.komoot.io/api';
/** 地理编码超时：冷启动主要延迟来源，从 20s 压到 8s（Overpass 6s / OSRM 5s 同量级） */
const GEOCODE_REQUEST_TIMEOUT_MS = 8000;
const PHOTON_REQUEST_TIMEOUT_MS = 6000;
// OSM Overpass POI 链路已整体退役（2026-10-15）：OSM 是地图贡献数据，旅游区脏 POI
// 反复踩坑（居民小区挂 tourism=hotel、单位食堂挂 amenity=restaurant、乱码单 token 名），
// 且镜像在大陆网络下超时频发曾把规划耗时推穿预算。POI 源现为：
// 国内 → 高德（AMAP_WEB_KEY）；国际 → Foursquare（FSQ_API_KEY，foursquare-service.ts）；
// 两者皆不可用时仅回退知识库真实 POI，绝不合成占位。
const USER_AGENT = 'TravelPlanner3D/1.0 (Educational Project)';

/**
 * 封面候选关键词预排序（按文件名打分，分高者排前；同分保持原序）。
 * 2026-09-28 选图升级的兜底闸：VLM 不可用/超时时，保证「洱海全景」排在
 * 「太和街道全景」前面——旅游代表性词加分，街道/行政区词减分。
 */
export function scoreCoverCandidate(url: string): number {
  let name = url;
  try {
    name = decodeURIComponent(url);
  } catch { /* 保留原串 */ }
  let score = 0;
  // 旅游代表性意象（自然风光/地标）
  for (const [re, s] of [
    [/湖|lake/i, 4],
    [/海|江|河|溪/, 3],
    [/海湾|海滩|沙滩|bay|beach/i, 3],
    [/雪山|山|mountain|mont/i, 2],
    [/古城|古镇|老街|old\s?town|heritage/i, 3],
    [/塔|pagoda|temple|寺|庙|教堂|cathedral|宫殿|palace|fort/i, 2],
    [/天际线|skyline|全景|panorama/i, 1],
    [/风景|风光|景色|scenery|landscape|view/i, 2],
    [/日落|日出|黄昏|sunset|sunrise|黄昏|dusk|dawn/i, 2],
    [/公园|park|花园|garden/i, 1],
  ] as Array<[RegExp, number]>) {
    if (re.test(name)) score += s;
  }
  // 非旅游代表性/用户明确嫌弃的意象
  for (const [re, s] of [
    [/街道|街景|马路|道路|street|roadway/i, -5],
    [/行政|区政府|办公楼|district|townhall|municipal/i, -4],
    [/路口|交叉口|立交|高架|intersection|overpass/i, -4],
    [/室内|interior|会议室|conference/i, -3],
    [/特写|人像|closeup|portrait/i, -2],
    [/地图|示意图|map|chart/i, -3],
    [/婚礼|wedding|宴会|banquet/i, -3],
    // 黑白/单色摄影几乎必是历史档案或艺术作品而非当代旅游形象照
    [/黑白|单色|monochrome|black.?and.?white|b&w/i, -6],
    [/绘画|画室|艺术作品|painting|artwork|sculpture|雕塑/i, -5],
  ] as Array<[RegExp, number]>) {
    if (re.test(name)) score += s;
  }
  return score;
}

// ======================== 高德地图配置 ========================

/** 从环境变量读取高德API Key */
const AMAP_KEY = process.env.AMAP_WEB_KEY || '';
/** 高德POI搜索基础URL */
const AMAP_POI_BASE = 'https://restapi.amap.com/v3/place/text';
/** 高德请求超时 */
const AMAP_REQUEST_TIMEOUT_MS = 8000;

/**
 * 高德全局节流队列（2026-10-15）：个人开发者 QPS=3，规划链路并发 7 路
 * （3 类×2页 + 茶歇池）会触发 CUQPS_HAS_EXCEEDED_THE_LIMIT——实测第 2 页与
 * 茶歇池整批被限流丢掉。所有 amapSearchPOI 的 HTTP 请求统一进队列，相邻
 * 请求间隔 ≥350ms；CUQPS 命中时由调用方退避后原参重试（见 fetchAmapPage）。
 */
const AMAP_MIN_INTERVAL_MS = 350;
let amapQueueTail: Promise<void> = Promise.resolve();
function amapThrottledFetch(url: string): Promise<Response> {
  const run = amapQueueTail.then(
    () => fetch(url, { signal: AbortSignal.timeout(AMAP_REQUEST_TIMEOUT_MS) }),
    () => fetch(url, { signal: AbortSignal.timeout(AMAP_REQUEST_TIMEOUT_MS) }), // 前序失败不阻塞后续
  );
  amapQueueTail = run.then(
    () => new Promise<void>((r) => setTimeout(r, AMAP_MIN_INTERVAL_MS)),
    () => new Promise<void>((r) => setTimeout(r, AMAP_MIN_INTERVAL_MS)),
  );
  return run;
}

/** CUQPS 退避时长：躲过限流窗口后原参重试一次 */
const AMAP_CUQPS_BACKOFF_MS = 1200;

/**
 * 判断目的地是否为国内（中国大陆）
 * 基于已知国内城市列表 + 省份关键词判断
 */
function isDomesticDestination(destName: string): boolean {
  return knowledgeBase.isDomesticDestination(destName);
}

/**
 * Nominatim 多候选择优（纯函数，可单测）。
 * 地名歧义时第一个结果常是乡镇/小区/POI 而非城市本身：
 *   1) 过滤掉明显非聚落类（建筑物/设施）候选
 *   2) 行政中心类（city/town/village/municipality/county）优先
 *   3) 同类中按 Nominatim 的 importance 降序，缺省保序
 */
export function pickBestNominatim(
  candidates: Array<Record<string, unknown>>,
  _query: string,
): Record<string, unknown> | null {
  if (!candidates.length) return null;
  const CITY_CLASSES = new Set(['place']);
  const CITY_TYPES = new Set(['city', 'town', 'village', 'municipality', 'county', 'borough', 'suburb']);
  const scored = candidates.map((item, idx) => {
    const cls = String(item.class ?? '');
    const type = String(item.type ?? '');
    const importance = typeof item.importance === 'number' ? item.importance : 0;
    let score = importance * 10 - idx * 0.1; // 同分保序
    if (CITY_CLASSES.has(cls) && CITY_TYPES.has(type)) score += 100;
    else if (cls === 'boundary' || cls === 'administrative') score += 50;
    else if (CITY_TYPES.has(type)) score += 30;
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.item;
}

/**
 * 高德POI类型编码（2026-10-15 按实测三级分类修正）：
 * - 景点: 110000 风景名胜 | 140100 博物馆 | 140200 展览馆 | 080501 游乐场
 * - 酒店: 060000
 * - 餐厅: 050000
 */
const AMAP_POI_TYPES: Record<string, string> = {
  // 2026-10-15 实测修正：旧集合 130000|190100~190500 是套错的分类面码（高德
  // 三级分类 110000=风景名胜、140100=博物馆、080501=游乐场），死码过滤失效后
  // keywords 模糊匹配漏进道路/居委会等脏 POI（「公园新村路」实证）。
  attraction: '110000|140100|140200|080501', // 风景名胜族 + 博物馆/展览馆 + 游乐场
  hotel: '060000',
  restaurant: '050000',
};

// ======================== 排序/评分权重配置 ========================

/**
 * 评分与排序权重集中配置（替代散落在排序函数里的魔法数字）。
 * 调整排序手感只改这里；语义见各字段名与使用处注释。
 */
const SCORING = {
  /** 收藏命中加权（「type:name」精确匹配） */
  favoriteBoost: 3,
  /** 酒店偏好加分 */
  hotel: { seaside: 5, pool: 4, kids: 2, elderly: 2, luxuryTier: 3, budgetTier: 3 },
  /** 餐厅偏好加分（目的地排序阶段） */
  restaurant: { cuisineMatch: 4, seaside: 2 },
  /** 景点偏好加分 + 天气×室内外修正 */
  attraction: {
    activities: 2, seaside: 3, kids: 2,
    indoorRainy: 5, indoorHot: 3, outdoorRainy: -5, outdoorHot: -2,
    nightView: 1.5, eveningOnly: 1,
  },
  /** 顺路餐厅选择：距离(distWeight) + 评分(ratingWeight) + 偏好加分 - 复用惩罚 */
  routePick: {
    distanceWeight: 0.6,
    distanceBase: 100,
    distanceScale: 1.5,
    ratingWeight: 0.25,
    ratingFallback: 4.0,
    ratingScale: 5,
    cuisineMatch: 15,
    seasideMatch: 8,
    budgetMatch: 5,
    reusePenalty: 10,
  },
} as const;

// ======================== 主服务类 ========================

export class PlanningService {

  /** 当天行程最晚结束时间（分钟，21:00）。超预算的景点顺延丢弃，时钟不再绕回次日。 */
  private static readonly DAY_END_MIN = 21 * 60;

  /** 交通腿缓存（坐标 ~100m 网格），OSRM 结果 24h 复用 */
  private legCache = new Map<string, { transport: TransportLeg; ts: number }>();

  /** OSRM 熔断：不可用时 10 分钟内直接走本地估算，避免编排被外网超时拖住 */
  private osrmDisabledUntil = 0;

  /** 同目的地并发搜索去重：key → in-flight Promise（防缓存击穿打出 N 份外网请求） */
  private inFlightSearches = new Map<string, Promise<CacheEntry>>();

  /**
   * Wikimedia 可达性探测缓存。
   *
   * 本机网络下 commons/zh.wikipedia 实测 http=000（每次 10~12s 超时）。链路里
   * 每个 POI 都要先跑一遍 Wikimedia 才会返回空 —— 后台回填是 3 并发 × 2 次重试，
   * 等于每个 POI 白烧 ~24s。用一次轻量探测把它变成「窗口内直接跳过」。
   */
  private wikiImagesProbedAt = 0;
  private wikiImagesReachableCache = false;

  /**
   * @param weatherService 可选天气服务（未注入则跳过天气感知，按中性天气排程）
   * @param imageSearch 可选图片搜索端口（未注入时走内置必应图片抓取）
   *
   * 2026-10-12：原第三/四个构造参数（videoSearch / reviewSearch）随视频能力下线移除。
   */
  constructor(
    private readonly weatherService?: WeatherService,
    private readonly imageSearch?: TravelImageSearchPort,
  ) {}

  /**
   * 编排阶段的交通腿查询：OSRM 真实路网优先（带 24h 缓存），失败降级 haversine 估算。
   * OSRM 一次失败即熔断 10 分钟（本批其余腿与后续规划直接走本地估算）。
   */
  private async transportLeg(fromLat: number, fromLon: number, toLat: number, toLon: number): Promise<TransportLeg> {
    const key = `${fromLat.toFixed(3)},${fromLon.toFixed(3)}|${toLat.toFixed(3)},${toLon.toFixed(3)}`;
    const hit = this.legCache.get(key);
    if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return hit.transport;

    let transport: TransportLeg;
    if (Date.now() < this.osrmDisabledUntil) {
      transport = this.computeTransport(fromLat, fromLon, toLat, toLon);
    } else {
      const osrm = await this.osrmRoute(fromLat, fromLon, toLat, toLon);
      if (osrm) {
        transport = osrm;
      } else {
        this.osrmDisabledUntil = Date.now() + 10 * 60 * 1000;
        transport = this.computeTransport(fromLat, fromLon, toLat, toLon);
      }
    }

    this.legCache.set(key, { transport, ts: Date.now() });
    // 简单容量上限：FIFO 淘汰
    if (this.legCache.size > 500) {
      const oldest = this.legCache.keys().next().value;
      if (oldest) this.legCache.delete(oldest);
    }
    return transport;
  }

  /**
   * 本地评论聚合分与 POI 原始评分混合：
   * 媒体库无评论 → 原样返回；评论 <5 条按数量线性加权，≥5 条以本地评论为主。
   */
  private effectiveRating(poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): number {
    const agg = travelMediaStore.aggregate(type, poi.name);
    if (!agg || agg.ratingCount === 0) return poi.rating || 0;
    const w = Math.min(1, agg.ratingCount / 5);
    const base = poi.rating || 0;
    return base > 0 ? base * (1 - w) + agg.ratingAvg * w : agg.ratingAvg;
  }

  /**
   * 主入口：根据用户输入生成完整行程
   */
  /** 规划进度上报（sessionId 缺省时为 no-op） */
  private reportProgress(sessionId: string | undefined, stage: string, message: string): void {
    emitTravelProgress(sessionId, stage, message);
  }

  /** 用户收藏键集合（C5 收藏加权，「type:name」精确匹配；读取失败为空集） */
  private get favoriteKeys(): Set<string> {
    try {
      return travelFavoritesStore.favoriteKeys();
    } catch {
      return new Set();
    }
  }

  /**
   * POI 缓存过期后台刷新（stale-while-revalidate）：
   * 命中缓存但已过 TTL 时先用旧数据服务当前请求，同时异步重搜并写缓存。
   * in-flight 去重保证并发触发只打一份外网请求；失败静默（旧数据仍可用）。
   */
  private refreshStaleCacheInBackground(destName: string, entry: CacheEntry): void {
    if (!poiCache.isStale(entry)) return;
    const normalizedKey = entry.queryKey || destName.toLowerCase().trim();
    console.log(`[PlanningService] POI 缓存已过期(${destName})，后台刷新中（本次请求继续用旧数据）`);
    void this.searchAndCache(destName, normalizedKey).catch((err: unknown) => {
      console.warn(`[PlanningService] 后台刷新失败(${destName}):`, err instanceof Error ? err.message : String(err));
    });
  }

  /** 由 POI raw.source 推导数据可信度（缓存命中同样适用：raw 随缓存落盘） */
  private deriveDataQuality(data: CacheEntry['data']): 'real' | 'knowledge' | 'synthetic' {
    const all = [...data.attractions, ...data.hotels, ...data.restaurants];
    if (all.some((p) => p.raw?.source === 'fallback')) return 'synthetic';
    if (all.some((p) => p.raw?.source === 'known-poi-db')) return 'knowledge';
    return 'real';
  }

  async generateItinerary(request: PlanningRequest): Promise<PlanningResult> {
    const t0 = Date.now();
    console.log(`[PlanningService] 开始规划: "${request.input}"`);

    // 1. 解析用户输入
    const destName = extractDestination(request.input, request.destination);
    const dayCount = request.days || extractDays(request.input) || 3;
    const preferences = extractPreferences(request.input, request.preferences, destName);
    const normalizedDest = destName.toLowerCase().trim();

    this.reportProgress(request.sessionId, "resolve", `正在规划「${destName}」${dayCount}天行程，解析偏好中…`);

    console.log(
      `[PlanningService] 目的地: ${destName}, 天数: ${dayCount}, 偏好: ` +
      `海边=${preferences.seaside} 泳池=${preferences.pool} 活动=${preferences.activities} ` +
      `节奏=${preferences.pace} 混合=${preferences.activityMix} ` +
      `餐系=${preferences.cuisine ?? '-'} 档次=${preferences.hotelTier ?? '-'}` +
      (preferences.raw.length ? ` 原文=[${preferences.raw.join(',')}]` : '')
    );

    // 2. 查缓存
    let cacheEntry = poiCache.get(normalizedDest);
    let fromCache = !!cacheEntry;

    if (!cacheEntry) {
      // 3. 缓存未命中 → 实时搜索
      console.log(`[PlanningService] 缓存未命中，开始实时搜索...`);
      this.reportProgress(request.sessionId, "search", `正在搜索「${destName}」的景点/酒店/餐厅（实时数据）…`);
      cacheEntry = await this.searchAndCache(destName, normalizedDest, request.sessionId, dayCount);
      fromCache = false;
    } else {
      console.log(`[PlanningService] 缓存命中! (已访问${cacheEntry.accessCount}次)`);
      this.reportProgress(request.sessionId, "search", `已命中「${destName}」本地缓存，正在编排行程…`);
      // 过期不阻塞：本次先用旧数据出结果，后台刷新（set 会更新 createdAt，
      // 行程级二级缓存随之自然失效，下次请求拿到新数据）
      this.refreshStaleCacheInBackground(destName, cacheEntry);
    }

    // 搜索完成即播报真实统计：让用户看到规划基于多少家真实 POI，而不是黑盒转圈
    this.reportProgress(
      request.sessionId,
      "search",
      `已找到 ${cacheEntry.data.attractions.length} 个景点 · ${cacheEntry.data.hotels.length} 家酒店 · ` +
      `${cacheEntry.data.restaurants.length} 家餐厅，开始编排行程`,
    );

    // 真实数据保证（防御）：历史遗留缓存若混有合成占位 POI，拒绝编排并提示重新搜索
    if (this.deriveDataQuality(cacheEntry.data) === "synthetic") {
      throw new Error(`「${destName}」的本地缓存含占位数据，已拒绝生成估算行程；POI 缓存将自动刷新，请稍后重试`);
    }

    // 3.5 生成日期范围（提前：逐日天气需要 startDate 对齐预报日期）
    const today = new Date();
    const startDate: string = today.toISOString().split('T')[0] ?? '';
    const endDate: string = new Date(today.getTime() + (dayCount - 1) * 86400000).toISOString().split('T')[0] ?? '';

    // 3.6 天气感知：Day1 实况（结果摘要/兜底）+ 逐日预报（每天按当天天气排程；
    // 2026-10-15 根修——旧实现只拉当天逐小时，多天行程 Day2+ 全用 Day1 天气分槽）。
    // 失败降级为中性天气，不阻塞规划。
    const weatherCtx = await this.fetchDestinationWeather(cacheEntry.center, destName);
    const perDayWeather = await this.fetchPerDayWeather(cacheEntry.center, destName, startDate, dayCount);
    // 排序聚合语境：任一天有雨/高温即整体修正室内外偏好（只排序不删除，保守不逐日翻烧饼）
    const rankedWeatherCtx: TripWeatherCtx = (() => {
      const ctxs = perDayWeather.map(d => d?.ctx).filter((c): c is TripWeatherCtx => !!c);
      const base = weatherCtx ?? ctxs[0];
      if (!base) return {
        morning: { rainy: false, hot: false, cold: false, precipPct: 0 },
        afternoon: { rainy: false, hot: false, cold: false, precipPct: 0 },
        evening: { rainy: false, hot: false, cold: false, precipPct: 0 },
        isRainyDay: false, isHotDay: false, isColdDay: false, summary: '',
      };
      return {
        ...base,
        isRainyDay: base.isRainyDay || ctxs.some(c => c.isRainyDay),
        isHotDay: base.isHotDay || ctxs.some(c => c.isHotDay),
        isColdDay: base.isColdDay || ctxs.some(c => c.isColdDay),
      };
    })();
    // 茶歇候选池（咖啡/茶馆）与主链路并行搜索，buildDaysFast 消费
    const cafePoolPromise = this.searchCafePool(cacheEntry.center, destName);

    // 3.6 语义属性打标（室内/室外/夜景/夜间专属，幂等，兼容旧缓存无标签数据）
    this.enrichPoiAttributes(cacheEntry.data.attractions);
    this.enrichPoiAttributes(cacheEntry.data.hotels);
    this.enrichPoiAttributes(cacheEntry.data.restaurants);

    // 4. 行程级二级缓存：同 目的地+天数+偏好+天气 且 POI 数据未刷新时整体复用
    //    （省去重排序+编排+图片匹配，二次规划毫秒级返回；天气签名变化自动重算）
    //    key 只取结构化字段：preferences.raw 是用户原文标签（换个说法就变），
    //    放进 key 会导致缓存永不命中；sources 仅是标签来源审计，同理排除。
    const weatherSig = perDayWeather
      .map(d => {
        const c = d?.ctx;
        return c
          ? `${c.morning.rainy ? 1 : 0}${c.afternoon.rainy ? 1 : 0}${c.evening.rainy ? 1 : 0}${c.isHotDay ? 1 : 0}`
          : 'N';
      })
      .join('');
    const prefSig = JSON.stringify([
      preferences.seaside, preferences.pool, preferences.activities, preferences.kids, preferences.elderly,
      preferences.pace, preferences.activityMix, preferences.budget ?? '', preferences.cuisine ?? '', preferences.hotelTier ?? '',
    ]);
    const itinKey =
      `itin|${normalizedDest}|${dayCount}|${prefSig}|${weatherSig}`;
    const cachedItin = itineraryCache.get(itinKey);
    if (
      cachedItin &&
      cachedItin.poiUpdatedAt === cacheEntry.createdAt &&
      Date.now() - cachedItin.ts < ITINERARY_CACHE_TTL_MS
    ) {
      console.log(`[PlanningService] 【行程缓存命中】直接返回 ${destName} ${dayCount}天行程（免重算+免抓图）`);
      // 深拷贝返回：调用方（编辑链路/序列化）一旦 mutate 不得污染缓存内对象
      return structuredClone(cachedItin.result);
    }

    // 6. 依据偏好+天气对POI排序/筛选（只排序不删除，保留回退池）
    const ranked = this.rankPOIsByPreferences(
      cacheEntry.data.attractions,
      cacheEntry.data.hotels,
      cacheEntry.data.restaurants,
      preferences,
      rankedWeatherCtx
    );
    const tParsed = Date.now() - t0;

    // 7. 提取目的地实用信息（用户没问也补）
    const travelInfo = this.extractTravelInfo(destName);

    // 8. 构建每天的行程（两阶段：先构建数据，再并行获取图片）
    const pricingCtx: import('./pricing-service.js').PricingContext = {
      destination: destName,
      preferences: { hotelTier: preferences.hotelTier, budget: preferences.budget },
      memberTier: request.memberTier,
      boundPlatforms: request.boundPlatforms,
      startDate,
    };

    // === 阶段1.5：目的地代表性封面解析（与阶段1并行，不增加串行耗时）===
    // 行程卡海报区背景必须是「目的地本身最具代表性的真实照片」（维基百科条目
    // 主图优先，见 resolveDestinationCover），它是目的地级形象照而非某个 POI
    // 的照片；磁盘缓存命中时微秒级返回，首次解析约 1~10s 且全程有界。
    let coverSettled = false;
    const coverPromise: Promise<string | undefined> = this
      .resolveDestinationCover(destName, cacheEntry.center,
        ranked.attractions.slice(0, 3).map((a) => a.name))
      .then((url) => { coverSettled = true; return url; });

    // === 阶段1：构建行程数据（聚类+交通腿+排时，交通腿走 OSRM 缓存）===
    this.reportProgress(request.sessionId, "schedule", "正在按天气与偏好编排每日行程…");
    console.log(`[PlanningService] 阶段1：构建行程数据...`);
    const tBuild0 = Date.now();
    const cafes = await cafePoolPromise;
    const { days: daysRaw, pois } = await this.buildDaysFast(
      dayCount, startDate,
      ranked.attractions, ranked.hotels, ranked.restaurants,
      cacheEntry.center, preferences, travelInfo, pricingCtx,
      perDayWeather, cafes, request.sessionId
    );
    const tBuild = Date.now() - tBuild0;

    // === 阶段2：媒体装配（纯本地读：媒体库/POI 缓存直图，网络抓取已移出请求路径）===
    this.reportProgress(request.sessionId, "media", "正在装配图片与点评…");
    const tMedia0 = Date.now();
    // 茶歇 cafe 不在缓存三桶（attractions/hotels/restaurants）里，findCachedPOIImages
    // 查不到——这里把 cafe 已抓到的实拍图（2026-10-15 高德图退役后仅剩 FSQ
    // photos，国际茶歇）按 poiId 透传进媒体装配；国内茶歇无图进 missing，
    // 与其他 POI 同走 web 图搜后台回填。
    const cafeImagesByPoiId = new Map<string, string[]>(
      cafes.filter(c => (c.images?.length ?? 0) > 0).map(c => [c.id, c.images!]),
    );
    const { imageMap, missing } = this.collectMediaForDays(daysRaw, cacheEntry, cafeImagesByPoiId);

    // 海报封面：阶段1期间并行解析，此时仍未完成才需要等待并汇报进度
    // （缓存命中时已就绪，秒回）。解析失败保持 undefined，海报由前端退回
    // 条目实拍/渐变兜底——宁可没有也不放与地点不符的占位图。
    if (!coverSettled) {
      this.reportProgress(request.sessionId, "media", `正在获取「${destName}」的代表性实景照片…`);
    }
    const coverImage = await coverPromise;

    const days = this.enrichDaysWithMedia(daysRaw, imageMap);
    const tMedia = Date.now() - tMedia0;

    // 缺图 POI 交给后台回填（TRAVEL_MEDIA_BACKFILL=off 时关闭自动抓取，
    // 由管理员经 /travel/media/backfill 手动触发或后台上传），不阻塞本次请求
    if (missing.length > 0 && PlanningService.AUTO_BACKFILL_ENABLED) {
      this.backfillMediaBackground(missing, cacheEntry);
    }

    // 8. 汇总价格
    const pricingSummary = this._summarizePricing(days, pricingCtx);

    const result: PlanningResult = {
      id: `plan-${Date.now()}`,
      title: this.buildTitle(destName, dayCount, preferences),
      description: request.input,
      startDate,
      endDate,
      destination: destName,
      center: cacheEntry.center,
      days,
      pois,
      preferences,
      travelInfo,
      pricingSummary,
      fromCache,
      coverImage,
      weather: weatherCtx?.summary || undefined,
      dataQuality: this.deriveDataQuality(cacheEntry.data),
    };

    // 9. 写入行程级二级缓存（POI 数据刷新时由 createdAt 差异自然失效）。
    //    缓存内存深拷贝：调用方持有的是原始对象，mutate 不影响缓存。
    cacheItinerary(itinKey, {
      ts: Date.now(),
      poiUpdatedAt: cacheEntry.createdAt,
      result: structuredClone(result),
    });

    console.log(
      `[PlanningService] 规划完成: ${destName} ${dayCount}天 | 解析+取数 ${tParsed}ms, 编排 ${tBuild}ms, 媒体装配 ${tMedia}ms, 总计 ${Date.now() - t0}ms` +
      ` | 图片 ${imageMap.size} 个POI本地直读, 缺图 ${missing.length} 个转后台回填`,
    );

    return result;
  }

  /**
   * Skill 只读入口：搜索目的地 POI（景点/酒店/餐厅）。
   * 走缓存优先 → 网络实时搜索 → 内置知识库真实POI兜底（无合成占位），返回扁平 POI 摘要列表。
   */
  async searchDestination(destName: string, type?: 'attraction' | 'hotel' | 'restaurant'): Promise<{
    destination: string;
    center: Coordinates;
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
    fromCache: boolean;
  }> {
    const normalizedDest = destName.toLowerCase().trim();
    let cacheEntry: CacheEntry | null = null;
    let fromCache = false;
    try {
      cacheEntry = poiCache.get(normalizedDest);
      fromCache = !!cacheEntry;
      if (!cacheEntry) {
        cacheEntry = await this.searchAndCache(destName, normalizedDest);
      } else {
        // 过期后台刷新：当前请求继续用旧数据，不阻塞
        this.refreshStaleCacheInBackground(destName, cacheEntry);
      }
    } catch {
      // 网络/地理编码失败时降级到内置知识库（真实地点）；
      // 知识库也未命中 → 抛错诚实失败，绝不编造 0,0 占位中心
      const known = this.findKnownPOIs(destName);
      const knownCenter = this.findKnownCoordinates(destName)?.center;
      if (!known && !knownCenter) {
        throw new Error(`目的地「${destName}」实时搜索失败且无本地知识库数据，请稍后重试`);
      }
      cacheEntry = {
        destination: destName,
        queryKey: normalizedDest,
        data: {
          attractions: known?.attractions ?? [],
          hotels: known?.hotels ?? [],
          restaurants: known?.restaurants ?? [],
        },
        center: knownCenter ?? { latitude: 0, longitude: 0 },
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        accessCount: 0,
      };
    }
    return {
      destination: destName,
      center: cacheEntry.center,
      attractions: cacheEntry.data.attractions,
      hotels: cacheEntry.data.hotels,
      restaurants: cacheEntry.data.restaurants,
      fromCache,
    };
  }

  /**
   * 公开入口：为 POI 生成行程条目描述文本（替代条目替换时复用规划引擎的文案口径）。
   * 只依赖 name/tags，searchPois 候选（无 id）与完整 RawPOI 均可传入。
   */
  describePoi(
    poi: Pick<RawPOI, 'name'> & Partial<Pick<RawPOI, 'tags' | 'rating' | 'address'>>,
    type: 'attraction' | 'hotel' | 'restaurant',
  ): string {
    return this.generateDescription(poi, type);
  }

  /**
   * 公开入口：编辑后对该天局部重排（替换/新增/删除条目后时间轴修复）。
   *
   * 从 fromItemIndex 起按条目新坐标重算交通腿（复用 transportLeg：OSRM 优先 + 24h
   * 缓存，未涉及编辑点的腿全部缓存命中）并顺序重排 startTime，修掉「替换后坐标变了
   * 但时间还是旧的」的错位；重排复用编排期的口径——餐厅按午/晚餐时段锚定，景点受
   * 当天预算（DAY_END_MIN）口径约束：编辑路径不丢弃条目，只保证时间轴自洽，
   * 超预算信息通过返回值 dayEndMin 透出，由调用方决定是否提示用户。
   *
   * keepFirstStartTime=true 时保留 fromItemIndex 条目的原 startTime 作为锚点
   * （HTTP 面板新增条目显式指定时间时使用），其余场景一律按新坐标顺推。
   */
  async retimeDayAfterEdit<
    T extends {
      type: string;
      startTime: string;
      latitude: number;
      longitude: number;
      visitDuration?: number;
      anchor?: boolean;
      transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
    },
  >(
    items: T[],
    fromItemIndex: number,
    opts?: { keepFirstStartTime?: boolean },
  ): Promise<{ dayEndMin: number }> {
    const parseMin = (hhmm: string): number => {
      // 兼容 "HH:MM" 与 "YYYY-MM-DD HH:MM"（取其中的时刻部分）
      const m = /(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
      if (!m) return 9 * 60;
      return Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]));
    };
    const formatTime = (min: number) =>
      `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
    const defaultPrefs: TripPreferences = {
      raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false,
      pace: 'balanced', activityMix: 'mixed',
      sources: {
        seaside: 'default', pool: 'default', activities: 'default', kids: 'default',
        elderly: 'default', pace: 'default', activityMix: 'default',
        budget: 'default', cuisine: 'default', hotelTier: 'default',
      },
    };
    const visitOf = (it: T): number =>
      it.type === 'restaurant' ? 75 : it.visitDuration ?? this.inferVisitDuration('attraction', defaultPrefs);
    const setLeg = (it: T, leg: TransportLeg | undefined): void => {
      if (!leg) return;
      it.transportFromPrev = {
        mode: leg.mode,
        durationMin: leg.durationMin,
        ...(leg.distanceKm != null ? { distanceKm: leg.distanceKm } : {}),
        ...(leg.note ? { note: leg.note } : {}),
      };
    };

    let clock = 9 * 60;
    let prevPoint: { lat: number; lon: number } | null = null;

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;

      // 未触及前缀：只推进时钟与位置基点
      if (i < fromItemIndex) {
        clock = Math.max(clock, parseMin(it.startTime) + (it.type === 'hotel' ? 60 : visitOf(it)));
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      // 酒店条目：保留原时刻（编排期只把酒店放在 08:00 锚点），只重算入腿
      if (it.type === 'hotel') {
        if (prevPoint) {
          setLeg(it, await this.transportLeg(prevPoint.lat, prevPoint.lon, it.latitude, it.longitude));
        }
        clock = Math.max(clock, parseMin(it.startTime) + 60);
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      const leg = prevPoint
        ? await this.transportLeg(prevPoint.lat, prevPoint.lon, it.latitude, it.longitude)
        : undefined;

      // 时间锚点条目（it.anchor）：时刻被用户/预订钉住不可动 —— 只重算交通腿，
      // 时钟对齐到锚点时刻后顺推（设计稿「随时重排，时间锚点不动」的服务端语义）
      if (it.anchor) {
        setLeg(it, leg);
        clock = Math.max(clock, parseMin(it.startTime)) + visitOf(it);
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      // 显式锚点：保留该条目原 startTime，只重算其交通腿，之后按此时钟顺推
      if (opts?.keepFirstStartTime && i === fromItemIndex) {
        it.startTime = it.startTime || formatTime(clock);
        setLeg(it, leg);
        clock = parseMin(it.startTime) + visitOf(it);
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      if (it.type === 'restaurant') {
        // 午/晚餐锚定（与编排期一致）：原 startTime 在 15 点前视为午餐
        const lunch = parseMin(it.startTime) < 15 * 60;
        const mealTime = lunch
          ? Math.max(11 * 60, Math.min(13 * 60, clock))
          : Math.max(17.5 * 60, clock + 30);
        it.startTime = formatTime(mealTime);
        setLeg(it, leg);
        clock = mealTime + 75;
      } else {
        const arrival = clock + (leg?.durationMin ?? 0);
        it.startTime = formatTime(arrival);
        setLeg(it, leg);
        clock = arrival + visitOf(it);
      }
      prevPoint = { lat: it.latitude, lon: it.longitude };
    }

    return { dayEndMin: clock };
  }

  /**
   * 公开入口：按类型+坐标找「同类替代 POI」（行程面板「提意见换一个」）。
   * 复用现有 POI 源周边搜索（以条目坐标为圆心，不做地理编码）：
   * 排除同名 POI → 按 comment 关键词粗略加权（命中名称/标签越多越靠前）→
   * 关键词全不命中时自然回退「距离最近」→ 取排序后第一个。
   * 找不到候选（网络失败/无结果）返回 null，由调用方决定 404 语义。
   */
  async findAlternativePoi(
    type: 'attraction' | 'hotel' | 'restaurant',
    latitude: number,
    longitude: number,
    excludeName: string,
    comment?: string,
  ): Promise<RawPOI | null> {
    const center: Coordinates = { latitude, longitude };
    let candidates: RawPOI[] = [];
    try {
      if (type === 'hotel') candidates = await this.searchHotels(center, '');
      else if (type === 'restaurant') candidates = await this.searchRestaurants(center, '');
      else candidates = await this.searchAttractions(center, '');
    } catch (err) {
      console.warn(`[PlanningService] 替代 POI 搜索失败(${type}):`, err instanceof Error ? err.message : String(err));
      return null;
    }
    const exclude = excludeName.trim().toLowerCase();
    const pool = candidates.filter(p => p.name && p.name.trim().toLowerCase() !== exclude);
    if (pool.length === 0) return null;

    // comment 关键词粗略分词（保留 ≥2 字符 token），命中名称/标签加分
    const keywords = (comment ?? '')
      .split(/[\s，。！？、,.!?;；:：()（）[\]【】]+/)
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 2);
    const scored = pool.map(poi => {
      const hay = `${poi.name} ${(poi.tags || []).join(' ')}`.toLowerCase();
      let score = keywords.reduce((acc, kw) => (hay.includes(kw) ? acc + 100 : acc), 0);
      score -= this.haversineKm(latitude, longitude, poi.latitude, poi.longitude);
      return { poi, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.poi ?? null;
  }

  /**
   * 公开入口：搜索目的地指定类型 POI（行程面板「单项编辑器」备选搜索）。
   * 走 searchDestination 的缓存/网络/知识库全链路，可按关键词粗滤名称/标签，
   * 逐条用 PricingService 报价生成 priceInfo，最多返回 limit 条。
   */
  async searchPois(
    destination: string,
    type: 'attraction' | 'hotel' | 'restaurant',
    keyword?: string,
    limit: number = 8,
  ): Promise<Array<{
    name: string;
    type: 'attraction' | 'hotel' | 'restaurant';
    latitude: number;
    longitude: number;
    address: string;
    priceInfo: string;
    tags: string[];
    /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（缓存 POI 带有时透传） */
    splatUrl?: string;
  }>> {
    const result = await this.searchDestination(destination, type);
    const bucket = type === 'hotel' ? result.hotels : type === 'restaurant' ? result.restaurants : result.attractions;
    const kw = keyword?.trim().toLowerCase() ?? '';
    const matched = kw
      ? bucket.filter(p => `${p.name} ${(p.tags || []).join(' ')}`.toLowerCase().includes(kw))
      : bucket;
    const pricingCtx: PricingContext = { destination, preferences: {} };
    return matched.slice(0, Math.max(1, limit)).map(p => {
      const quote = type === 'hotel'
        ? pricingService.quoteHotel(p.name, p.tags || [], pricingCtx)
        : type === 'attraction'
          ? pricingService.quoteAttraction(p.name, p.tags || [], pricingCtx)
          : pricingService.quoteRestaurant(p.name, p.tags || [], pricingCtx);
      return {
        name: p.name,
        type,
        latitude: p.latitude,
        longitude: p.longitude,
        address: p.address,
        priceInfo: formatQuotePriceInfo(quote),
        tags: p.tags || [],
        ...(p.splatUrl ? { splatUrl: p.splatUrl } : {}),
      };
    });
  }

  /**
   * Skill 只读入口：获取目的地实用信息（签证/货币/最佳季节/通信等），无匹配时返回默认。 */
  async getDestinationInfo(destName: string): Promise<TravelInfo> {
    return this.extractTravelInfo(destName);
  }

  /**
   * Skill 只读入口：计算两点间交通（模式/时长/距离）。
   * from/to 支持 "纬度,经度" 或 "地名"（自动地理编码）。
   */
  async computeRoute(from: string | Coordinates, to: string | Coordinates): Promise<{
    mode: string;
    durationMin: number;
    distanceKm: number;
    note?: string;
  }> {
    const resolve = async (p: string | Coordinates): Promise<Coordinates> => {
      if (typeof p !== 'string') return p;
      const trimmed = p.trim();
      const parts = trimmed.split(',').map(s => Number(s.trim()));
      if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
        return { latitude: parts[0], longitude: parts[1] };
      }
      const geo = await this.geocode(trimmed);
      return geo.center;
    };
    const [fromC, toC] = await Promise.all([resolve(from), resolve(to)]);

    // 优先用 OSRM 真实路网（免费、无需 key）；请求失败/超时自动降级直线估算
    const viaOSRM = await this.osrmRoute(
      fromC.latitude, fromC.longitude, toC.latitude, toC.longitude,
    );
    if (viaOSRM) {
      console.log(`[PlanningService] OSRM 路网路线: ${viaOSRM.distanceKm.toFixed(1)}km / ${viaOSRM.durationMin}min`);
      return viaOSRM;
    }
    return this.computeTransport(fromC.latitude, fromC.longitude, toC.latitude, toC.longitude);
  }

  /**
   * OSRM 开放路由服务：返回两点间真实路网（驾车优先）的耗时/距离。
   * - 服务器地址可用 env TRAVEL_ROUTE_API_BASE 覆盖（默认公共 demo 节点）
   * - 任何失败（网络/超时/无路由）返回 null，由调用方降级到 haversine 估算
   */
  private async osrmRoute(
    fromLat: number, fromLon: number, toLat: number, toLon: number,
  ): Promise<{ mode: string; durationMin: number; distanceKm: number; note?: string } | null> {
    try {
      const base = (process.env.TRAVEL_ROUTE_API_BASE || 'https://router.project-osrm.org').replace(/\/+$/, '');
      const url =
        `${base}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}` +
        `?overview=false&alternatives=false&steps=false`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const data = await res.json() as {
        code?: string;
        routes?: Array<{ distance?: number; duration?: number }>;
      };
      const route = data?.routes?.[0];
      if (data?.code !== 'Ok' || !route) return null;

      const km = (route.distance ?? 0) / 1000;
      if (!(km > 0)) return null;
      const durationMin = Math.max(1, Math.round((route.duration ?? 0) / 60));
      // 按真实距离分档推断交通方式（与 haversine 估算的口径一致）
      const mode = km < 1 ? '步行' : km < 5 ? '打车/Grab' : km < 30 ? '包车/网约车' : '城际交通';
      return { mode, durationMin, distanceKm: km, note: km < 1 ? '短距离' : undefined };
    } catch {
      return null; // 网络/超时/解析失败 → 上层降级
    }
  }

  /** Skill 只读入口：健康自检（缓存数据量 + 内置知识覆盖） */
  async healthCheck(): Promise<{
    cachedDestinations: number;
    poiCacheStats: { memoryEntries: number; fileEntries: number };
  }> {
    const stats = poiCache.getStats();
    return {
      cachedDestinations: poiCache.listCachedDestinations().length,
      poiCacheStats: { memoryEntries: stats.memoryEntries, fileEntries: stats.fileEntries },
    };
  }

  /**
   * 将 agent 返回的 itinerary 转换为 PlanningResult
   * - 已是 PlanningResult 格式（含 id/days/destination）→ 直接用
   * - LLM 输出格式（含 days）→ 包装为 PlanningResult（补齐缺失字段）
   * - 其他/空 → 返回 null 触发降级
   */
  private toPlanningResult(
    itinerary: unknown,
    request: PlanningRequest,
  ): PlanningResult | null {
    if (!itinerary || typeof itinerary !== 'object') return null;
    const obj = itinerary as Record<string, unknown>;

    // 已是 PlanningResult 格式
    if ('id' in obj && 'days' in obj && 'destination' in obj) {
      return itinerary as PlanningResult;
    }

    // LLM 输出格式 { days: [...] } → 包装
    if ('days' in obj && Array.isArray(obj.days)) {
      const destName = request.destination || extractDestination(request.input, request.destination);
      const today = new Date();
      const startDate = today.toISOString().split('T')[0] ?? '';
      return {
        id: `plan-agent-${Date.now()}`,
        title: request.input.slice(0, 50),
        description: request.input,
        startDate,
        endDate: startDate,
        destination: destName,
        center: { latitude: 0, longitude: 0 },
        days: obj.days as PlannedDay[],
        pois: [],
        preferences: extractPreferences(request.input, request.preferences, destName),
        travelInfo: this.extractTravelInfo(destName),
        fromCache: false,
      };
    }

    return null;
  }

  /**
   * 汇总整个行程的价格：按 dayCount 折算酒店晚数、聚合景点/餐厅
   */
  private _summarizePricing(days: PlannedDay[], ctx: import('./pricing-service.js').PricingContext): PlanningResult['pricingSummary'] {
    let totalOriginal = 0, totalFinal = 0;
    const warnings: string[] = [];
    const nightCount = Math.max(1, days.length - 1);

    const hotelQuotes: PriceQuote[] = [];
    const attractionQuotes: PriceQuote[] = [];
    const restaurantQuotes: PriceQuote[] = [];

    days.forEach(day => {
      (day.items || []).forEach(it => {
        if (it.type === 'hotel') {
          // hotel: 价格只算一次（取首次），qty = nightCount
          if (hotelQuotes.length === 0 && it.priceQuote) {
            hotelQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice * nightCount;
            totalFinal += it.priceQuote.finalPrice * nightCount;
          }
        } else if (it.type === 'attraction') {
          if (it.priceQuote) {
            attractionQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice;
            totalFinal += it.priceQuote.finalPrice;
          }
        } else if (it.type === 'restaurant') {
          if (it.priceQuote) {
            restaurantQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice;
            totalFinal += it.priceQuote.finalPrice;
          }
        }
      });
    });

    // 价格模式提示
    const mode = (process.env.PRICING_MODE as 'real-api' | 'real-database' | 'estimated') || 'real-database';
    if (mode === 'estimated') {
      warnings.push('当前为估算价，建议在预订平台核对后再下单');
    } else if (mode === 'real-database') {
      warnings.push('价格来自真实市场数据库，最终以下单平台为准');
    } else {
      warnings.push('价格来自实时预订 API，下单时可能因库存/汇率小幅波动');
    }

    // 绑定平台提示
    if (ctx.boundPlatforms && ctx.boundPlatforms.length) {
      const names = ctx.boundPlatforms.map(p => p.displayName).filter(Boolean);
      if (names.length) {
        warnings.push(`已应用绑定平台优惠：${names.join('、')}`);
      }
    } else {
      warnings.push('未绑定任何平台账户，价格为非会员参考价；绑定 Booking/Agoda/携程/美团 等平台可享真实会员优惠');
    }

    return {
      currency: 'CNY',
      totalOriginal,
      totalDiscount: totalOriginal - totalFinal,
      totalFinal,
      memberTier: ctx.memberTier,
      boundPlatforms: ctx.boundPlatforms,
      pricingMode: mode,
      warnings,
    };
  }


  // ======================== 行程附加实用信息 ========================

  /**
   * 提供目的地实用信息：签证、货币、时区、最佳季节、紧急、禁忌、贴士
   * 用户没问也补
   */
  private extractTravelInfo(destName: string): TravelInfo {
    const info = this.findKnownTravelInfo(destName);
    if (info) return info;
    // 兜底：通用模板
    return {
      destination: destName,
      visa: { required: false, type: '免签', notes: '请以最新使领馆公告为准' },
      currency: { name: '当地货币', code: 'XXX', symbol: '' },
      timezone: { name: '当地时间', offset: 'UTC+0' },
      language: ['当地官方语言'],
      voltage: '220V / 50Hz',
      socket: '双孔欧标（建议带万能转换头）',
      bestSeason: { months: ['全年'], description: '请按当地气候选择合适季节出行' },
      emergency: { police: '110', ambulance: '120', touristHotline: '请查询当地旅游热线', chinaEmbassy: '请查询中国驻当地使馆电话' },
      customs: ['尊重当地风俗', '遵守公共场所秩序'],
      tips: ['建议出发前购买旅游保险', '保留好护照/签证/票据复印件'],
      packing: ['证件/身份证', '充电器与转换插头', '常用药品', '防晒/雨具按季节'],
    };
  }

  private findKnownTravelInfo(destName: string): TravelInfo | null {
    // KnownTravelInfo 为结构类型（visa.type 未收窄为字面量联合），数据文件即 schema 来源
    return knowledgeBase.findKnownTravelInfo(destName) as TravelInfo | null;
  }

  // ======================== 实时搜索 + 缓存写入 ========================

  /**
   * 调用POI搜索API并存入缓存（同 key 并发共享同一个 Promise，防缓存击穿：
   * Nominatim 有 1 req/s 使用政策，并发重复请求容易触发限流拉长所有请求）。
   */
  private async searchAndCache(destName: string, normalizedKey: string, sessionId?: string, dayCount = 3): Promise<CacheEntry> {
    const inFlight = this.inFlightSearches.get(normalizedKey);
    if (inFlight) {
      console.log(`[PlanningService] 并发去重: 复用「${destName}」进行中的搜索请求`);
      return inFlight;
    }
    const task = this.doSearchAndCache(destName, normalizedKey, sessionId, dayCount).finally(() => {
      this.inFlightSearches.delete(normalizedKey);
    });
    this.inFlightSearches.set(normalizedKey, task);
    return task;
  }

  private async doSearchAndCache(destName: string, normalizedKey: string, sessionId?: string, dayCount = 3): Promise<CacheEntry> {
    console.log(`[PlanningService] 正在搜索: ${destName} ...`);

    // Step 1: 地理编码 → 获取中心坐标
    const geoResult = await this.geocode(destName);
    const center = geoResult.center;
    console.log(`[PlanningService] 地理编码成功: [${center.longitude}, ${center.latitude}]`);

    // Step 2: 根据国内外分流选择数据源
    const domestic = isDomesticDestination(destName);
    let attractions: RawPOI[], hotels: RawPOI[], restaurants: RawPOI[];

    if (domestic) {
      // ===== 国内：高德地图 POI 搜索 =====
      console.log(`[PlanningService] 检测到国内目的地，使用高德地图API`);
      const amapResult = await this.searchWithAmap(center, destName);
      attractions = amapResult.attractions;
      hotels = amapResult.hotels;
      restaurants = amapResult.restaurants;

      // 高德无结果（key 缺失/接口异常）时降级到 Foursquare（全球覆盖，国内主干城市亦有数据）
      if (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0) {
        console.warn(`[PlanningService] 高德无结果，尝试Foursquare降级...`);
        const fsqResult = await this.searchWithFoursquare(center, destName);
        attractions = fsqResult.attractions;
        hotels = fsqResult.hotels;
        restaurants = fsqResult.restaurants;
      }
    } else {
      // ===== 国外：Foursquare Places API =====
      console.log(`[PlanningService] 检测到国外目的地，使用Foursquare API`);
      const fsqResult = await this.searchWithFoursquare(center, destName);
      attractions = fsqResult.attractions;
      hotels = fsqResult.hotels;
      restaurants = fsqResult.restaurants;
    }

    // Step 2.4: 类别缺口二次搜索（按行程需求补齐，结果合并）：
    // 首轮 25km 半径对度假海岛/郊区古城常偏浅——酒店餐厅远在半径外，而景点
    // 数量不足会让「第 2 天起无景点可排」。以天数推导需求下限（景点 4/天、
    // 餐厅 2/天、酒店至少 10 家候选），不足的类别放宽到 60km 重查并按名去重合并。
    const needAttractions = Math.min(32, dayCount * 4);
    const needHotels = 10;
    const needRestaurants = Math.min(24, dayCount * 2 + 4);
    if (
      attractions.length < needAttractions ||
      hotels.length < needHotels ||
      restaurants.length < needRestaurants
    ) {
      const WIDE_RADIUS = 60000;
      const needAttr = attractions.length < needAttractions;
      const needHotel = hotels.length < needHotels;
      const needRest = restaurants.length < needRestaurants;
      console.warn(
        `[PlanningService] 类别缺口(景点${attractions.length}/${needAttractions} 酒店${hotels.length}/${needHotels} ` +
        `餐厅${restaurants.length}/${needRestaurants}，${dayCount}天)，扩大到 ${WIDE_RADIUS / 1000}km 二次搜索...`,
      );
      this.reportProgress(sessionId, 'search', `部分类别结果不足，正在扩大范围重搜…`);
      const [a2, h2, r2] = await Promise.all([
        needAttr ? this.searchAttractions(center, destName, WIDE_RADIUS) : Promise.resolve<RawPOI[]>([]),
        needHotel ? this.searchHotels(center, destName, WIDE_RADIUS) : Promise.resolve<RawPOI[]>([]),
        needRest ? this.searchRestaurants(center, destName, WIDE_RADIUS) : Promise.resolve<RawPOI[]>([]),
      ]);
      // 合并而非替换：首轮结果是精确半径内的更相关结果，二次结果按名去重后追加
      const mergeByName = (base: RawPOI[], extra: RawPOI[]): RawPOI[] => {
        const seen = new Set(base.map(p => (p.name || '').trim().toLowerCase()).filter(Boolean));
        for (const p of extra) {
          const k = (p.name || '').trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          base.push(p);
        }
        return base;
      };
      if (needAttr) attractions = mergeByName(attractions, a2);
      if (needHotel) hotels = mergeByName(hotels, h2);
      if (needRest) restaurants = mergeByName(restaurants, r2);
    }

    console.log(
      `[PlanningService] 搜索完成: 景点${attractions.length} 酒店${hotels.length} 餐厅${restaurants.length}` +
      ` (数据源: ${domestic ? '高德' : 'Foursquare'})`
    );

    // Step 2.5: 类别缺口补齐（鲁棒性）：任一类别为空而知名库有该类别数据时，
    // 用知识库真实 POI 补齐。避免「酒店有、景点/餐厅空」的部分搜索结果被缓存
    // 永久污染该目的地（缓存命中后直接编排出 0 个景点/餐厅的残缺行程）。
    if (attractions.length === 0 || hotels.length === 0 || restaurants.length === 0) {
      const known = this.findKnownPOIs(destName);
      if (known) {
        if (attractions.length === 0 && known.attractions.length > 0) {
          console.log(`[PlanningService] 景点结果为空，用知名库补齐 ${known.attractions.length} 个`);
          attractions = known.attractions;
        }
        if (hotels.length === 0 && known.hotels.length > 0) {
          console.log(`[PlanningService] 酒店结果为空，用知名库补齐 ${known.hotels.length} 个`);
          hotels = known.hotels;
        }
        if (restaurants.length === 0 && known.restaurants.length > 0) {
          console.log(`[PlanningService] 餐厅结果为空，用知名库补齐 ${known.restaurants.length} 个`);
          restaurants = known.restaurants;
        }
      }
    }

    // Step 3: 所有 API 都返回空结果时，只回退到知识库真实地点；
    // 知识库也未命中 → 抛错诚实失败，绝不生成合成占位行程。
    let knowledgeFallback = false;
    if (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0) {
      console.warn(`[PlanningService] 所有API均无结果，尝试知识库真实POI兜底`);
      this.reportProgress(sessionId, 'search', '实时搜索暂不可用，正在改用内置真实地点库…');
      const known = this.knownPoiFallback(destName);
      if (known) {
        attractions = known.attractions;
        hotels = known.hotels;
        restaurants = known.restaurants;
        knowledgeFallback = true;
      } else {
        throw new Error(
          `目的地「${destName}」的实时数据暂不可用（POI 搜索无结果且无本地知识库），已拒绝生成估算行程；请稍后重试或换个目的地表达`,
        );
      }
    }

    // Step 4: 写入缓存（内存+文件持久化，全局共享）。
    // 知识库兜底与空结果都不落缓存：一次网络故障降级的数据不应在 TTL 内
    // 阻止后续重试拿到实时数据。
    // 「景点+餐厅双空、只有酒店」的残缺结果同样不缓存：这正是 2026-10-11
    // 「新疆行程只有酒店」事故的污染源——注释声称防部分污染，实际条件漏了
    // 「KB 未命中时部分空照样落盘」，7 天 TTL 内该目的地的行程一直是残缺版。
    const coreCategoriesEmpty = attractions.length === 0 && restaurants.length === 0;
    if (knowledgeFallback || coreCategoriesEmpty || (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0)) {
      console.warn(
        `[PlanningService] 跳过 POI 缓存写入（${knowledgeFallback ? "知识库兜底" : coreCategoriesEmpty ? "核心类别（景点+餐厅）全空，防残缺结果污染" : "空结果"} 不缓存）`,
      );
      return {
        destination: destName,
        queryKey: normalizedKey,
        data: { attractions, hotels, restaurants },
        center,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        accessCount: 0,
      };
    }
    // set 第一参数是目的地原文（内部自会 normalize）；传 normalizedKey 会把
    // hex 串当目的地再 hash 一遍，刷新结果落进永远读不到的双重 key 下，
    // 表现为「后台刷新成功但下次请求仍用陈旧坏缓存」。
    const entry = poiCache.set(destName, { attractions, hotels, restaurants }, center);

    return entry;
  }

  /**
   * 通过 Foursquare 搜索 POI（国外/备选数据源）
   */
  private async searchWithFoursquare(center: Coordinates, destName: string): Promise<{
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  }> {
    let [attractions, hotels, restaurants] = await Promise.all([
      this.searchAttractions(center, destName),
      this.searchHotels(center, destName),
      this.searchRestaurants(center, destName),
    ]);

    // 空类别重试：接口存在瞬时 429/超时，单轮全挂时其余类别往往成功——
    // 部分缺失的行程比全空更糟（Step 2.5 只兜全空场景）。
    // 仅对空类别补一轮串行重试，非空类别不重复消耗 API 配额。
    if (attractions.length === 0 || hotels.length === 0 || restaurants.length === 0) {
      console.warn(
        `[PlanningService] Foursquare 部分类别为空(景点${attractions.length}/酒店${hotels.length}/餐厅${restaurants.length})，空类别重试一轮...`,
      );
      const [a2, h2, r2] = await Promise.all([
        attractions.length === 0 ? this.searchAttractions(center, destName) : Promise.resolve<RawPOI[]>([]),
        hotels.length === 0 ? this.searchHotels(center, destName) : Promise.resolve<RawPOI[]>([]),
        restaurants.length === 0 ? this.searchRestaurants(center, destName) : Promise.resolve<RawPOI[]>([]),
      ]);
      if (attractions.length === 0) attractions = a2;
      if (hotels.length === 0) hotels = h2;
      if (restaurants.length === 0) restaurants = r2;
    }

    return { attractions, hotels, restaurants };
  }

  /**
   * 真实数据兜底：仅回退到知识库中的真实地点（名称/坐标可在高德/Google Maps 查到）。
   * 历史版本在此处用 Math.random 生成「当地中心景区」等合成占位 POI——那是在向用户
   * 提供编造数据，已彻底移除。知识库未命中时返回 null，由调用方诚实失败（不落缓存、
   * 不生成行程），用户会收到明确的重试提示而不是一份假行程。
   */
  private knownPoiFallback(destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } | null {
    const known = this.findKnownPOIs(destName);
    if (known) {
      console.log(`[PlanningService] 使用${destName}的知识库真实POI数据（非实时，已标注 dataQuality=knowledge）`);
      return known;
    }
    return null;
  }

  /**
   * 知名目的地真实POI数据库
   * 所有名称均为真实存在的地点，可在高德/Google Maps上搜索到
   * 包含近似坐标（用于地图展示）
   */
  private findKnownPOIs(destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } | null {
    return knowledgeBase.findKnownPOIs(destName);
  }

  // ======================== OpenStreetMap API 调用 ========================

  /**
   * Nominatim 地理编码：地名 → 经纬度
   */
  private async geocode(query: string): Promise<{ center: Coordinates; displayName: string }> {
    // 提速优化：先查本地已知坐标表。命中则毫秒级返回，跳过 Nominatim 网络请求。
    // 绝大多数热门/常见目的地都命中本地表，首询可省掉最长 20s 的地理编码网络等待，
    // 只有冷门目的地才回落到 Nominatim 兜底。
    const knownLocal = this.findKnownCoordinates(query);
    if (knownLocal) {
      console.log(
        `[OSM] 使用本地坐标: ${knownLocal.name} [${knownLocal.center.longitude}, ${knownLocal.center.latitude}]`,
      );
      return { center: knownLocal.center, displayName: knownLocal.name };
    }

    const url = `${OSM_NOMINATIM_BASE}?` +
      `q=${encodeURIComponent(query)}&format=json&limit=3&addressdetails=1&accept-language=zh`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(GEOCODE_REQUEST_TIMEOUT_MS),
      });

      const data = await res.json() as Array<Record<string, unknown>>;

      if (data && data.length > 0) {
        // 多候选择优：歧义地名（如「大理」可能命中乡镇/小区）取第一个会定错位。
        // 优先行政中心类结果（city/town/municipality），同类中取 importance 最高者。
        const item = pickBestNominatim(data, query);
        if (item) {
          const lat = parseFloat(String(item.lat));
          const lon = parseFloat(String(item.lon));

          return {
            center: { latitude: lat, longitude: lon },
            displayName: String(item.display_name ?? '') || query,
          };
        }
      }

      throw new Error('未找到地理位置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OSM] 地理编码失败(${query}):`, msg);
      // 备用 geocoder：Nominatim 超时/限流时切 Photon 重试，而不是直接抛错走知识库
      const photon = await this.geocodeByPhoton(query);
      if (photon) {
        console.log(`[OSM] Photon 备用命中: ${photon.displayName} [${photon.center.longitude}, ${photon.center.latitude}]`);
        return photon;
      }
      // 知识库坐标兜底（真实地点坐标，可在地图上查到）
      const known = this.findKnownCoordinates(query);
      if (known) {
        console.log(`[OSM] 使用已知坐标: ${known.name} [${known.center.longitude}, ${known.center.latitude}]`);
        return { center: known.center, displayName: known.name };
      }
      // 诚实失败：绝不返回猜测坐标。历史版本兜底到「中国中心」——那会让整个行程
      // 建在错误的坐标上（假数据），现已改为向上抛错由调用方明确告知用户。
      throw new Error(`无法定位目的地「${query}」（地理编码服务不可用或地名无法识别）`);
    }
  }

  /**
   * Photon 备用地理编码（photon.komoot.io，免费、无需 Key）。
   * 失败返回 null 由调用方继续降级，绝不抛错。
   */
  private async geocodeByPhoton(query: string): Promise<{ center: Coordinates; displayName: string } | null> {
    try {
      const url = `${PHOTON_GEOCODE_BASE}?q=${encodeURIComponent(query)}&limit=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(PHOTON_REQUEST_TIMEOUT_MS),
      });
      const json = await res.json() as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: Record<string, unknown>;
        }>;
      };
      const coords = json.features?.[0]?.geometry?.coordinates;
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
      const p = json.features?.[0]?.properties ?? {};
      const displayName = [p.name, p.city, p.country].filter((v) => typeof v === 'string' && v).join(', ') || query;
      return { center: { latitude: coords[1]!, longitude: coords[0]! }, displayName };
    } catch {
      return null;
    }
  }

  /**
   * 已知目的地坐标表（当OSM地理编码不可用时的兜底）
   * 覆盖国内外热门旅游目的地
   */
  private findKnownCoordinates(query: string): { name: string; center: Coordinates } | null {
    return knowledgeBase.findKnownCoordinates(query);
  }

  // ======================== Foursquare API 调用（国际目的地 POI 源） ========================

  /**
   * Foursquare 搜索景点（替代 Overpass：消费级场馆数据，名称/分类/照片经平台校验）
   * 浅池口径与国内高德对齐（2026-10-15）：25 条覆盖 5 天 × intensive 4 景/天编排上限
   */
  private async searchAttractions(center: Coordinates, _cityHint: string, radius = 25000): Promise<RawPOI[]> {
    const results = await searchFoursquarePois(center, 'attraction', radius, 25);
    return results.filter(p => isPlausiblePoiName(p.name));
  }

  /**
   * Foursquare 搜索酒店（类别 19012 覆盖 Hotel 全型；民宿/客栈国际场景以类别名为准）
   */
  private async searchHotels(center: Coordinates, _cityHint: string, radius = 25000): Promise<RawPOI[]> {
    const results = await searchFoursquarePois(center, 'hotel', radius, 12);
    return results.filter(p => isPlausiblePoiName(p.name));
  }

  /**
   * Foursquare 搜索餐厅（类别 13065 Restaurant；每天午+晚两餐 × 5 天 = 10 餐，20 个留去重余量）
   */
  private async searchRestaurants(center: Coordinates, _cityHint: string, radius = 20000): Promise<RawPOI[]> {
    const results = await searchFoursquarePois(center, 'restaurant', radius, 20);
    return results.filter(p => isPlausiblePoiName(p.name));
  }

  /**
   * Foursquare 搜索咖啡厅/茶座（茶歇/午休条目专用，见 buildDaysFast 茶歇编排）
   */
  private async searchCafes(center: Coordinates, radius = 15000): Promise<RawPOI[]> {
    const results = await searchFoursquarePois(center, 'cafe', radius, 10);
    return results.filter(p => isPlausiblePoiName(p.name));
  }

  /**
   * 茶歇候选池（国内外分流）：国内走高德咖啡/茶馆（050000 餐饮服务下），
   * 国际走 Foursquare Coffee Shop。规划编排用，不进 POI 主缓存（量小、随行随搜）。
   */
  private async searchCafePool(center: Coordinates, destName: string): Promise<RawPOI[]> {
    try {
      if (isDomesticDestination(destName)) {
        const cityHint = this.extractCityName(destName);
        // 浅池：每天至多 1 次茶歇 × 5 天 = 5，10 个留足余量
        const list = await this.amapSearchPOI('咖啡厅|咖啡馆|茶馆|茶室|甜品', cityHint, 'restaurant', 10, 1);
        return list.filter(p => isPlausiblePoiName(p.name));
      }
      return await this.searchCafes(center);
    } catch (err) {
      console.warn(`[PlanningService] 茶歇候选池搜索失败（不影响主流程）: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }


  // ======================== 高德地图 API 调用 ========================

  /**
   * 高德POI关键词搜索（国内目的地使用）
   * 文档: https://lbs.amap.com/api/webservice/guide/api/search
   */
  private async amapSearchPOI(
    keywords: string,
    city: string,
    poiType: 'attraction' | 'hotel' | 'restaurant',
    limit: number = 10,
    pages: number = 1
  ): Promise<RawPOI[]> {
    if (!AMAP_KEY) {
      console.warn('[Amap] 未配置 AMAP_WEB_KEY，跳过高德搜索');
      return [];
    }

    const typeCode = AMAP_POI_TYPES[poiType] || '';
    const collected: Array<{
      id: string;
      name: string;
      location: string; // "lng,lat"（GCJ-02）
      address: string;
      tel?: string;
      type?: string;
      typecode?: string;
      pname?: string;
      cityname?: string;
      adname?: string;
      rating?: string;
      cost?: string;
      /** extensions=all 返回的实拍图（title/url）——规划条目真实照片的第一手来源 */
      photos?: Array<{ title?: string; url?: string }>;
      biz_ext?: { rating?: string; cost?: string };
    }> = [];

    // 分页拉取：单页 25 条上限，多页攒够候选池（多天行程每天 2~4 个景点，
    // 池子不足会导致后面几天无景点可排）。任一页提前耗尽即停。
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        key: AMAP_KEY,
        keywords,
        city,
        types: typeCode,
        output: 'json',
        offset: '25',
        page: String(page),
        extensions: 'all', // 深度信息：biz_ext.rating/cost（base 档两者皆缺）；photos 已不消费（2026-10-15 高德图退役）
      });

      const url = `${AMAP_POI_BASE}?${params.toString()}`;
      console.log(`[Amap] 搜索${poiType}: keywords="${keywords}", city="${city}", page=${page}`);

      try {
        // 单页请求：走全局节流队列；CUQPS 限流退避后原参重试一次
        const fetchPage = async (): Promise<{ status?: string; info?: string; pois?: typeof collected }> => {
          const res = await amapThrottledFetch(url);
          if (!res.ok) {
            console.warn(`[Amap] HTTP ${res.status}: ${url.slice(0, 80)}`);
            return { status: '0', info: `HTTP_${res.status}` };
          }
          return (await res.json()) as { status?: string; info?: string; pois?: typeof collected };
        };
        let data = await fetchPage();
        if (data.status !== '1' && /CUQPS/i.test(data.info || '')) {
          await new Promise((r) => setTimeout(r, AMAP_CUQPS_BACKOFF_MS));
          data = await fetchPage();
        }

        if (data.status !== '1' || !data.pois || data.pois.length === 0) {
          if (page === 1) console.warn(`[Amap] 无结果或错误: ${data.info || 'unknown'}`);
          break;
        }

        collected.push(...data.pois);
        if (collected.length >= limit) break;
        if (data.pois.length < 25) break; // 末页提前耗尽
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Amap] 搜索失败(${keywords}):`, msg);
        break;
      }
    }

    if (collected.length === 0) return [];
    console.log(`[Amap] 找到 ${collected.length} 个${poiType} (共${pages}页)`);

    // limit 同时约束总池深（单页 offset=25 时 push 后才检查翻页，需显式截断）
    return collected.slice(0, limit).flatMap((poi, idx): RawPOI[] => {
      const parts = (poi.location || ',').split(',').map(Number);
      const lon: number = parts[0] ?? 0;
      const lat: number = parts[1] ?? 0;
      // 无名 POI 直接丢弃（历史版本兜底生成「地点N」占位名——那是编造数据，已移除）
      const name = (poi.name || '').trim();
      if (!name) return [];
      // 坐标系统一（关键）：高德返回 GCJ-02「火星坐标」，直接入库会让国内 POI
      // 在 WGS-84 底图（Carto/Esri/OSM/OSRM）上整体偏移 300~700 米。
      // 入库前统一转 WGS-84，全链路（缓存/行程/地图/算路）单边 WGS-84。
      const wgs = gcj02ToWgs84(lat, lon);
      // 评分优先 biz_ext.rating（all 档才有），base 档的顶层 rating 仅兜底。
      // 实拍图不再随搜索种子（2026-10-15 定调：高德实拍=商家门脸/位置示意图，
      // 观感差整批退役），POI 一律无图进装配 → missing → 后台 web 图搜回填
      // （search image 端口 → 必应，见 fetchRealImages）。
      const amapRating = poi.biz_ext?.rating
        ? parseFloat(poi.biz_ext.rating)
        : (poi.rating ? parseFloat(poi.rating) : NaN);
      return [{
        id: `amap-${poi.id || idx}`,
        name,
        latitude: Number.isFinite(wgs.latitude) ? wgs.latitude : 0,
        longitude: Number.isFinite(wgs.longitude) ? wgs.longitude : 0,
        address: poi.address || `${poi.cityname || ''}${poi.adname || ''}${name}`,
        type: poiType,
        rating: Number.isFinite(amapRating) && amapRating > 0 ? amapRating : 4.0,
        tags: [
          poi.type || poiType,
          poi.typecode || '',
          poi.pname || '',
          poi.cityname || '',
          poi.adname || '',
        ].filter(Boolean),
        images: [],
        raw: { ...poi, source: 'amap', coordSystem: 'wgs84 (converted from gcj02)' },
      }];
    }).filter(poi =>
      poi.latitude !== 0
      && Number.isFinite(poi.latitude)
      && Number.isFinite(poi.longitude)
      // 高德 keywords 检索会带出挂错类目的机构/地名（「河滨公园居委会」实证），统一过名称闸
      && isPlausiblePoiName(poi.name),
    );
  }

  /**
   * 通过高德API搜索国内目的地的全部POI
   * 浅池编排（2026-10-15 用户定调）：每类 1 页收够编排量即可——聚类/选酒店/
   * 顺路选餐只需一个浅候选池，多拉是浪费。实拍图随 extensions=all 同批返回
   * （photos 仅 URL 数组，payload 极轻），只服务最终入选条目，不二次逐条拉详情
   * （那会在 QPS 节流下多出 15+ 请求、多等 ~5s）。池子有 7 天缓存，冷启动才走网络。
   */
  private async searchWithAmap(center: Coordinates, destName: string): Promise<{
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  }> {
    // 用城市名作为搜索关键词和城市限定
    const cityHint = this.extractCityName(destName);

    const [attractions, hotels, restaurants] = await Promise.all([
      // 景点：风景名胜 + 知名景点关键词；25 条覆盖 5 天 × intensive 4 景/天的编排上限
      this.amapSearchPOI('旅游景点|景点|景区|公园|名胜|古迹|博物馆|古镇|古城|寺庙|海滩|雪山|湖泊', cityHint, 'attraction', 25, 1),
      // 酒店：主酒店优选（质心距离+评分）12 个候选足够
      this.amapSearchPOI('酒店|宾馆|民宿|客栈|度假村|旅馆', cityHint, 'hotel', 12, 1),
      // 餐厅：每天午+晚两餐 × 5 天 = 10 餐，20 个留去重余量
      this.amapSearchPOI('餐厅|美食|饭店|小吃|火锅|烧烤|咖啡|茶馆|特色菜|当地菜', cityHint, 'restaurant', 20, 1),
    ]);

    return { attractions, hotels, restaurants };
  }

  /**
   * 从目的地名称中提取城市名（用于高德API的city参数）
   * 处理如 "云南大理" → "大理", "云南丽江" → "丽江"
   */
  private extractCityName(destName: string): string {
    // 常见省份前缀去除
    const provincePrefixes = [
      '云南','四川','浙江','江苏','山东','河南','湖北','湖南','广东','福建','安徽',
      '江西','河北','山西','辽宁','吉林','黑龙江','陕西','甘肃','青海','贵州','台湾',
      '内蒙古','广西','西藏','宁夏','新疆','海南','香港','澳门',
    ];
    let city = destName.trim();
    for (const prefix of provincePrefixes) {
      if (city.startsWith(prefix)) {
        city = city.slice(prefix.length).trim();
        break;
      }
    }
    // 如果提取后太短，返回原始名称
    return city.length >= 2 ? city : destName.trim();
  }

  // ======================== 行程构建 ========================

  /**
   * Haversine 距离（公里）
   */
  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * 根据两点距离推算交通方式与时长
   */
  private computeTransport(fromLat: number, fromLon: number, toLat: number, toLon: number): { mode: string; durationMin: number; distanceKm: number; note?: string } {
    const km = this.haversineKm(fromLat, fromLon, toLat, toLon);
    if (km < 1) {
      return { mode: '步行', durationMin: Math.max(5, Math.round(km * 14)), distanceKm: km, note: '短距离' };
    }
    if (km < 5) {
      return { mode: '打车/Grab', durationMin: Math.round(km * 3 + 5), distanceKm: km };
    }
    if (km < 30) {
      return { mode: '包车/网约车', durationMin: Math.round(km * 1.5 + 5), distanceKm: km };
    }
    return { mode: '城际交通', durationMin: Math.round(km * 1.0 + 15), distanceKm: km, note: '距离较远，建议预留更多时间' };
  }

  /**
   * 估算游览/用餐时长（分钟）
   */
  private inferVisitDuration(type: 'hotel' | 'attraction' | 'restaurant', prefs: TripPreferences): number {
    if (type === 'hotel') return 30; // 入住/退房办理
    if (type === 'restaurant') return 75;
    // attraction
    let base = 120;
    if (prefs.pace === 'relaxed') base = 150;
    else if (prefs.pace === 'intensive') base = 90;
    if (prefs.activities) base += 30; // 体验型更久
    return base;
  }

  /**
   * 根据偏好为每个 item 生成小贴士（用户没问也补）
   */
  private generateItemTips(
    poi: RawPOI,
    type: 'hotel' | 'attraction' | 'restaurant',
    prefs: TripPreferences,
    travelInfo: TravelInfo
  ): string[] {
    const tips: string[] = [];
    if (type === 'hotel') {
      tips.push('建议提前1-2周预订，价格更优且可选房型更多');
      if (prefs.pool) tips.push('可向酒店确认泳池开放时间，部分需另付费');
      if (prefs.seaside) tips.push('海景房建议指定高层，体验更佳');
    } else if (type === 'attraction') {
      if (prefs.activities) tips.push('建议提前在官方渠道购票，避免现场排队');
      tips.push('建议工作日上午或下午4点后错峰，避开旅行团');
      const tagStr = (poi.tags || []).join(' ');
      if (/temple|寺庙/.test(tagStr)) tips.push('需着装得体，覆盖肩膀与膝盖');
      if (/beach|海/.test(tagStr)) tips.push('请做好防晒并看管好个人物品');
    } else if (type === 'restaurant') {
      tips.push('高峰期建议提前订位或错峰前往');
      if (prefs.cuisine) tips.push(`本地推荐尝试${prefs.cuisine}菜`);
    }
    if (travelInfo.tips.length) {
      // 抽 1 条目的地通用贴士
      tips.push(travelInfo.tips[0] ?? '请遵守当地秩序');
    }
    return tips.slice(0, 3);
  }

  /**
   * 酒店/付费景点的预订提示
   */
  private generateBookingNote(
    poi: RawPOI,
    type: 'hotel' | 'attraction' | 'restaurant',
    prefs: TripPreferences
  ): string | undefined {
    if (type === 'hotel') {
      const season = prefs.kids ? '亲子房通常需提前确认床型' : '旺季建议提前2周以上预订';
      return season;
    }
    if (type === 'attraction') {
      const tagStr = (poi.tags || []).join(' ');
      if (/fee|ticket|paid|门票/.test(tagStr)) {
        return '建议通过官方/合作平台预订电子票，凭二维码入场';
      }
    }
    return undefined;
  }

  /**
   * 根据偏好+天气对POI进行重排序（不删除，只把更匹配的放前面）
   *
   * 天气感知（B3）：雨天/高温时把室内景点前置、室外景点后置；
   * 夜景/夜间专属景点小幅前置，具体晚间分槽在 buildDaysFast 中进一步处理。
   */
  private rankPOIsByPreferences(
    attractions: RawPOI[],
    hotels: RawPOI[],
    restaurants: RawPOI[],
    prefs: TripPreferences,
    weather?: TripWeatherCtx | null
  ): { attractions: RawPOI[]; hotels: RawPOI[]; restaurants: RawPOI[] } {
    const score = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): number => {
      const hay = `${poi.name} ${(poi.tags || []).join(' ')}`.toLowerCase();
      let s = this.effectiveRating(poi, type); // 本地评论聚合分混合（媒体库优先）
      // C5 收藏加权：用户收藏过的地点（type:name 精确匹配，餐厅与景点同名互不污染）
      if (this.favoriteKeys.has(`${type}:${poi.name}`)) s += SCORING.favoriteBoost;
      if (type === 'hotel') {
        if (prefs.seaside && /(海|滩|湾|beach|bay|coast|seaside|ocean)/i.test(hay)) s += SCORING.hotel.seaside;
        if (prefs.pool && /(泳池|游泳池|pool|swimming)/i.test(hay)) s += SCORING.hotel.pool;
        if (prefs.kids && /(亲子|家庭|儿童|kid|family)/i.test(hay)) s += SCORING.hotel.kids;
        if (prefs.elderly && /(无障碍|电梯|安静|elevator|accessible)/i.test(hay)) s += SCORING.hotel.elderly;
        if (prefs.hotelTier === 'luxury' && /(豪华|五星|resort|residence)/i.test(hay)) s += SCORING.hotel.luxuryTier;
        if (prefs.hotelTier === 'budget' && /(青旅|民宿|客栈|经济|hostel)/i.test(hay)) s += SCORING.hotel.budgetTier;
      } else if (type === 'restaurant') {
        if (prefs.cuisine) {
          const re = new RegExp(prefs.cuisine, 'i');
          if (re.test(hay)) s += SCORING.restaurant.cuisineMatch;
        }
        if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) s += SCORING.restaurant.seaside;
      } else if (type === 'attraction') {
        if (prefs.activities) s += SCORING.attraction.activities; // 想看"有什么好玩的" → 把景点都前置
        if (prefs.seaside && /(海|滩|湾|岛|beach|coast|reef|dive|潜水|冲浪)/i.test(hay)) s += SCORING.attraction.seaside;
        if (prefs.kids && /(乐园|动物园|主题|family|amusement|zoo)/i.test(hay)) s += SCORING.attraction.kids;
        if (weather) {
          const t = poi.tags || [];
          if (t.includes('indoor')) {
            // 雨天/高温 → 室内景点优先
            if (weather.isRainyDay) s += SCORING.attraction.indoorRainy;
            if (weather.isHotDay) s += SCORING.attraction.indoorHot;
          } else if (t.includes('outdoor')) {
            if (weather.isRainyDay) s += SCORING.attraction.outdoorRainy;
            if (weather.isHotDay) s += SCORING.attraction.outdoorHot;
          }
          // 夜景/夜间专属：整体小幅前置（晚间分槽时进一步放大）
          if (t.includes('nightview')) s += SCORING.attraction.nightView;
          if (t.includes('eveningOnly')) s += SCORING.attraction.eveningOnly;
        }
      }
      return s;
    };

    const sortBy = (arr: RawPOI[], t: 'attraction' | 'hotel' | 'restaurant') =>
      [...arr].sort((a, b) => score(b, t) - score(a, t));

    return {
      attractions: sortBy(attractions, 'attraction'),
      hotels: sortBy(hotels, 'hotel'),
      restaurants: sortBy(restaurants, 'restaurant'),
    };
  }

  /**
   * 天气感知取数：拉取目的地当天/预报天气 → 时段化语境。
   * 失败时返回 null（按中性天气排程），绝不阻塞规划主流程。
   */
  private async fetchDestinationWeather(center: Coordinates, destName: string): Promise<TripWeatherCtx | null> {
    if (!this.weatherService) return null;
    try {
      const brief = await this.weatherService.getBrief(center.latitude, center.longitude, 'auto', destName);
      const ctx = this.buildWeatherContext(brief);
      console.log(
        `[PlanningService] 天气感知: ${destName} ${brief.summaryLine} | ` +
        `上午${ctx.morning.rainy ? '☔' : '☀'} 下午${ctx.afternoon.rainy ? '☔' : '☀'} 晚间${ctx.evening.rainy ? '☔' : '☀'} ` +
        `室内优先=${ctx.isRainyDay} 高温=${ctx.isHotDay}`
      );
      return ctx;
    } catch (err) {
      console.warn(`[PlanningService] 天气获取失败，按中性天气规划: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 逐日天气感知（2026-10-15 根修）：Open-Meteo 一次请求 forecast_days=N，
   * 按行程日期对齐，折叠为 上午/下午/晚间 三段语境——多天行程每天用自己的
   * 天气排程（旧实现只拉当天，Day2+ 全用 Day1 天气）。
   * 失败/预报未覆盖的日期 → null（中性天气），绝不阻塞规划主流程。
   */
  private async fetchPerDayWeather(
    center: Coordinates,
    destName: string,
    startDate: string,
    dayCount: number,
  ): Promise<Array<TripDayWeather | null>> {
    if (!this.weatherService) return Array.from({ length: dayCount }, () => null);
    try {
      const forecast = await this.weatherService.getMultiDayForecast(center.latitude, center.longitude, dayCount);
      const byDate = new Map(forecast.days.map(d => [d.date, d]));
      const out: Array<TripDayWeather | null> = [];
      for (let i = 0; i < dayCount; i++) {
        const date = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().split('T')[0] ?? '';
        const day = byDate.get(date);
        if (!day || day.hourly.length === 0) { out.push(null); continue; }
        out.push({
          ctx: this.foldHourlyToCtx(day.hourly),
          summary: `${day.weatherText}，${Math.round(day.minC)}–${Math.round(day.maxC)}°C，降水概率 ${Math.round(day.rainPct)}%`,
        });
      }
      console.log(
        `[PlanningService] 逐日天气: ${destName} ` +
        out.map((d, i) => `D${i + 1}${d?.ctx ? (d.ctx.isRainyDay ? '☔' : d.ctx.isHotDay ? '🔥' : '☀') : '∅'}`).join(' '),
      );
      return out;
    } catch (err) {
      console.warn(`[PlanningService] 逐日天气获取失败，按中性天气规划: ${err instanceof Error ? err.message : String(err)}`);
      return Array.from({ length: dayCount }, () => null);
    }
  }

  /** 将逐小时行折叠为 上午/下午/晚间 三时段天气语境（逐日复用；buildWeatherContext 的行级抽取） */
  private foldHourlyToCtx(rows: Array<{
    hour?: string;
    time?: string;
    temperatureC: number;
    precipitationProbabilityPct?: number;
    weatherCode: number;
  }>): TripWeatherCtx {
    const slotCtx = (hours: number[]): SlotWeatherCtx => {
      const sel = rows.filter(r => {
        const h = parseInt((r.hour || r.time || '').split(':')[0] || '0', 10);
        return hours.includes(h);
      });
      const precipPct = sel.length ? Math.max(...sel.map(r => r.precipitationProbabilityPct ?? 0)) : 0;
      const maxTemp = sel.length ? Math.max(...sel.map(r => r.temperatureC ?? -999)) : -999;
      const hasRain = sel.some(r => RAIN_WEATHER_CODES.has(r.weatherCode));
      return { rainy: hasRain || precipPct >= 60, hot: maxTemp >= 32, cold: maxTemp <= 5, precipPct };
    };
    const morning = slotCtx([9, 10, 11, 12]);
    const afternoon = slotCtx([13, 14, 15, 16]);
    const evening = slotCtx([18, 19, 20, 21]);
    return {
      morning,
      afternoon,
      evening,
      isRainyDay: morning.rainy || afternoon.rainy,
      isHotDay: morning.hot || afternoon.hot,
      isColdDay: morning.cold || afternoon.cold,
      summary: '',
    };
  }

  /**
   * 行程实时信号 · 目的地天气（供 /travel/plans/:planId/signal 查询）。
   * 返回一句话摘要 + 当日是否雨天；未注入天气服务/失败 → null，绝不阻塞。
   */
  async signalWeather(
    center: Coordinates,
  ): Promise<{ summaryLine: string; rainy: boolean } | null> {
    if (!this.weatherService) return null;
    try {
      const brief = await this.weatherService.getBrief(center.latitude, center.longitude, 'auto');
      const ctx = this.buildWeatherContext(brief);
      return { summaryLine: brief.summaryLine, rainy: ctx.isRainyDay };
    } catch {
      return null;
    }
  }

  /** 将 Open-Meteo 逐小时预报折叠为 上午/下午/晚间 三时段天气语境 */
  private buildWeatherContext(brief: WeatherBrief): TripWeatherCtx {
    const slotCtx = (hours: number[]): SlotWeatherCtx => {
      const rows = brief.hourlyForecast.filter(f => {
        const h = parseInt((f.hour || f.time || '').split(':')[0] || '0', 10);
        return hours.includes(h);
      });
      const precipPct = rows.length ? Math.max(...rows.map(r => r.precipitationProbabilityPct ?? 0)) : 0;
      const maxTemp = rows.length ? Math.max(...rows.map(r => r.temperatureC ?? -999)) : -999;
      const hasRain = rows.some(r => RAIN_WEATHER_CODES.has(r.weatherCode));
      return { rainy: hasRain || precipPct >= 60, hot: maxTemp >= 32, cold: maxTemp <= 5, precipPct };
    };
    const morning = slotCtx([9, 10, 11, 12]);
    const afternoon = slotCtx([13, 14, 15, 16]);
    const evening = slotCtx([18, 19, 20, 21]);
    return {
      morning,
      afternoon,
      evening,
      isRainyDay: morning.rainy || afternoon.rainy,
      isHotDay: morning.hot || afternoon.hot,
      isColdDay: morning.cold || afternoon.cold,
      summary: brief.summaryLine,
    };
  }

  /**
   * 语义属性打标（B1）：根据 名称 + 原始 tags + 已有标签 推导 室内/室外/混合、夜景、夜间专属。
   * 幂等（已含目标标签则跳过），随缓存/内存复用，供天气×时段排序与分槽使用。
   */
  private enrichPoiAttributes(list: RawPOI[]): void {
    if (!list) return;
    for (const poi of list) {
      const existing = poi.tags || [];
      if (existing.includes('indoor') || existing.includes('outdoor') || existing.includes('mixed')) {
        continue; // 已打标，跳过
      }
      const rawTags = (poi.raw as { tags?: Record<string, unknown> } | undefined)?.tags;
      const hay = `${poi.name} ${existing.join(' ')} ${rawTags ? Object.values(rawTags).join(' ') : ''}`;

      // 室内（博物馆/水族馆/商场/展览/剧院/购物/温泉等）
      const indoorRe = /(博物馆|美术馆|科技馆|科学馆|水族馆|海洋馆|图书馆|展览|展馆|展厅|剧院|演出剧场|商场|购物中心|商城|购物|免税|室内|乐园室内|蜡像|纪念馆|艺术馆|画廊|电影院|影城|冰雪世界|水世界|温泉|水疗|spa|书店|密室|剧本杀|保龄球|健身房|室内冰场)/i;
      // 室外（公园/海滩/山/湖/塔/峡谷/瀑布/草原/森林/观景台等）
      const outdoorRe = /(公园|海滩|沙滩|海滨|海边|山|峰|湖|江|河|海景|塔|寺庙|古寺|大佛|峡谷|瀑布|草原|森林|湿地|观景台|观景|缆车|索道|动物园|植物园|户外|游乐场|过山车|漂流|潜水|冲浪|骑行|徒步|露营|景区|风景|岛|湾|沙滩浴场)/i;

      const tags = new Set<string>(existing);
      if (indoorRe.test(hay) && !outdoorRe.test(hay)) tags.add('indoor');
      else if (outdoorRe.test(hay) && !indoorRe.test(hay)) tags.add('outdoor');
      else tags.add('mixed');

      // 夜景/晚上适合（观景台/夜市/灯光秀/酒吧/摩天轮等）
      const nightRe = /(夜景|观景台|观景塔|夜市|灯光秀|灯光|灯会|烟花|烟花秀|酒吧|club|夜店|江景|海景餐厅|天台|露台|屋顶|夜游|游船|摩天轮|演出|演艺|show)/i;
      if (nightRe.test(hay)) tags.add('nightview');

      // 仅夜间开放（夜市/酒吧/夜店/夜间演出）
      const eveningOnlyRe = /(夜市|酒吧|夜店|club|夜间演出|夜场|灯会|烟花秀|夜游)/i;
      if (eveningOnlyRe.test(hay)) tags.add('eveningOnly');

      poi.tags = Array.from(tags);
    }
  }

  /** 单个景点在某时段天气下的适宜分（用于分槽贪心指派） */
  private slotScore(a: RawPOI, rainy: boolean, hot: boolean): number {
    const t = a.tags || [];
    if (t.includes('indoor')) return (rainy || hot) ? 3 : 1;
    if (t.includes('outdoor')) return rainy ? 0 : 2;
    return 1; // mixed / 未知 → 中性
  }

  /**
   * 按 天气×时段 拆分当天景点（B4）：
   * - eveningOnly / nightview → 晚间槽（夜景/夜市夜间游玩）
   * - 其余景点按上午/下午天气贪心指派（雨天/高温把室内放对应槽，晴天室外优先）
   * - 各槽内保持地理聚类原有顺序（不重排，减小路程）
   */
  private splitAttractionsBySlot(
    dayAttrs: RawPOI[],
    weather?: TripWeatherCtx | null
  ): { morning: RawPOI[]; afternoon: RawPOI[]; evening: RawPOI[] } {
    const evening: RawPOI[] = [];
    const rest: RawPOI[] = [];
    for (const a of dayAttrs) {
      const t = a.tags || [];
      if (t.includes('eveningOnly')) { evening.push(a); continue; }
      if (t.includes('nightview') && evening.length < 1) { evening.push(a); continue; }
      rest.push(a);
    }

    const n = rest.length;
    const morningCap = Math.ceil(n / 2);
    const morning: RawPOI[] = [];
    const afternoon: RawPOI[] = [];
    const mRain = weather?.morning.rainy ?? false;
    const mHot = weather?.morning.hot ?? false;
    const aRain = weather?.afternoon.rainy ?? false;
    const aHot = weather?.afternoon.hot ?? false;
    for (const a of rest) {
      if (morning.length >= morningCap) { afternoon.push(a); continue; }
      if (afternoon.length >= n - morningCap) { morning.push(a); continue; }
      (this.slotScore(a, aRain, aHot) > this.slotScore(a, mRain, mHot) ? afternoon : morning).push(a);
    }
    return { morning, afternoon, evening };
  }

  /** 生成"为何这样排"的天气/时段说明文案（B5，追加到条目贴士） */
  private slotNote(
    entry: { slot?: 'morning' | 'afternoon' | 'evening'; poi: RawPOI },
    weather: TripWeatherCtx | null | undefined,
    slot: 'morning' | 'afternoon' | 'evening'
  ): string {
    if (!weather) return '';
    const t = entry.poi.tags || [];
    const w = slot === 'morning' ? weather.morning : slot === 'evening' ? weather.evening : weather.afternoon;
    const notes: string[] = [];
    if (w.rainy && t.includes('indoor')) notes.push('今日有雨，已为您改排室内');
    if (slot === 'evening' && (t.includes('nightview') || t.includes('eveningOnly'))) notes.push('此景点适合傍晚/晚间前往，已安排在夜晚时段');
    if (weather.isHotDay && slot !== 'evening' && !t.includes('indoor')) notes.push('白天较热，注意防晒补水');
    if (w.rainy && !t.includes('indoor') && t.includes('outdoor')) notes.push('预计有雨，请备好雨具');
    return notes.join('；');
  }

  /**
   * 依据偏好生成行程标题，例如「巴厘岛7日游·海景泳池」
   */
  private buildTitle(destName: string, dayCount: number, prefs: TripPreferences): string {
    const base = `${destName}${dayCount}日游`;
    const tags: string[] = [];
    if (prefs.seaside) tags.push('海景');
    if (prefs.pool) tags.push('泳池');
    if (prefs.kids) tags.push('亲子');
    if (prefs.elderly) tags.push('适老');
    if (prefs.cuisine) tags.push(prefs.cuisine);
    if (prefs.hotelTier === 'luxury') tags.push('豪华');
    else if (prefs.hotelTier === 'budget') tags.push('经济');
    if (prefs.pace === 'relaxed') tags.push('休闲');
    else if (prefs.pace === 'intensive') tags.push('深度');
    return tags.length ? `${base}·${tags.join('/')}` : base;
  }

  /**
   * 将原始POI数据构建为每天的行程项目
   *
   * 改进点：
   * 1. 按地理位置聚类分配景点（而非按索引切片）
   * 2. 每天内用最近邻算法优化游览顺序（减少往返路程）
   * 3. 每天合理分配午餐/晚餐餐厅
   * 4. 根据实际交通时间动态安排时间点
   */

  // ======================== 两阶段优化：快速构建 + 并行图片 ========================

  /**
   * 阶段1：快速构建行程数据（不获取图片，纯数据操作，<100ms完成）
   * 图片在阶段2通过 collectMediaForDays 本地装配（评论/视频能力已下线）
   */
  private async buildDaysFast(
    dayCount: number,
    startDate: string,
    attractions: RawPOI[],
    hotels: RawPOI[],
    restaurants: RawPOI[],
    center: Coordinates,
    preferences: TripPreferences,
    travelInfo: TravelInfo,
    pricingCtx: import('./pricing-service.js').PricingContext,
    perDayWeather: Array<TripDayWeather | null>,
    cafes: RawPOI[],
    sessionId?: string
  ): Promise<{ days: PlannedDay[]; pois: POISummary[] }> {
    const allPois: POISummary[] = [];

    // A4：过滤非法坐标（(0,0)/非有限值/越界），避免把 POI 画到错误位置
    const isValidCoord = (p: RawPOI): boolean =>
      isFinite(p.latitude) && isFinite(p.longitude) &&
      !(p.latitude === 0 && p.longitude === 0) &&
      Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
    attractions = attractions.filter(isValidCoord);
    hotels = hotels.filter(isValidCoord);
    restaurants = restaurants.filter(isValidCoord);

    const toSummary = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): POISummary | null => {
      if (!isValidCoord(poi)) return null;
      return {
        id: poi.id, name: poi.name, type,
        latitude: poi.latitude, longitude: poi.longitude,
        address: poi.address, rating: poi.rating ?? 4.5,
        cost: poi.tags?.[0], description: poi.tags?.join(','),
        splatUrl: poi.splatUrl,
      };
    };
    attractions.forEach(a => { const s = toSummary(a, 'attraction'); if (s) allPois.push(s); });
    hotels.forEach(h => { const s = toSummary(h, 'hotel'); if (s) allPois.push(s); });
    restaurants.forEach(r => { const s = toSummary(r, 'restaurant'); if (s) allPois.push(s); });
    cafes.forEach(c => { const s = toSummary(c, 'restaurant'); if (s) allPois.push(s); });

    const paceCap: Record<TripPreferences['pace'], number> = { relaxed: 2, balanced: 3, intensive: 4 };
    let maxAttractionsPerDay = paceCap[preferences.pace];
    if (preferences.activities) maxAttractionsPerDay += 1;
    if (preferences.elderly) maxAttractionsPerDay = Math.max(2, maxAttractionsPerDay - 1);

    if (preferences.activityMix !== 'mixed') {
      const want = preferences.activityMix;
      attractions = [...attractions].sort((a, b) => {
        const tagA = `${a.name} ${(a.tags || []).join(' ')}`.toLowerCase();
        const tagB = `${b.name} ${(b.tags || []).join(' ')}`.toLowerCase();
        const score = (h: string) => {
          if (want === 'culture' && /(museum|church|temple|castle|monument|memorial|historic|寺庙|古迹|博物馆|文化)/.test(h)) return 2;
          if (want === 'nature' && /(park|garden|nature|mountain|volcano|beach|water|森林|山|湖|海|自然|风景|公园)/.test(h)) return 2;
          if (want === 'entertainment' && /(mall|amusement|theme_park|zoo|market|乐园|购物|娱乐)/.test(h)) return 2;
          return 0;
        };
        return score(tagB) - score(tagA);
      });
    }

    // 住宿锚定与优选（2026-10-15「从住宿开始规划」）：先定酒店，再围绕酒店
    // 聚类/编排每天行程。旧实现盲取搜索结果第一个（可能离全部景点几十公里）。
    const primaryHotel = this.pickPrimaryHotel(hotels, attractions, preferences);
    // 起点优先用酒店（第一天入住后出发、其余天从酒店往返），无酒店退回目的地中心
    const startPoint: Coordinates = primaryHotel
      ? { latitude: primaryHotel.latitude, longitude: primaryHotel.longitude }
      : center;

    // 地理聚类分配景点（farthest-first 初始化 + 空簇回收 + 每天内 NN+2-opt 排序）
    const clusteredDays = this.clusterAttractionsByGeo(attractions, dayCount, startPoint, maxAttractionsPerDay);
    // 餐厅去重：按名称去除重复
    const seenRestNames = new Set<string>();
    const dedupedRestaurants = restaurants.filter(r => {
      const key = (r.name || '').trim().toLowerCase();
      if (key && !seenRestNames.has(key)) { seenRestNames.add(key); return true; }
      return false;
    });
    const usedRestaurantIds = new Set<string>();
    const restaurantUsageCount = new Map<string, number>();
    // 茶歇候选与正餐分池分账：候选池独立，避免同一杯咖啡被两轮选择互斥占位
    const usedCafeIds = new Set<string>();
    const cafeUsageCount = new Map<string, number>();

    /**
     * 第一步：确定每天访问序列（酒店→上午景点→午餐→茶歇→下午景点→晚餐→晚间景点）。
     * 午/晚餐先按位置锚定（午餐靠上午最后景点、晚餐靠下午最后景点），时间后面统一排。
     * 景点拆分采用 天气×时段 槽位法（B4，逐日语境）：夜间专属/夜景→晚间，其余按当天上午/下午天气贪心指派。
     * 茶歇（吃玩休息节奏）：当天下午 hot/rainy 必排室内咖啡/茶馆；晴天 relaxed 排、intensive 不排。
     * 每日午/晚餐无条件安排（即使当天暂无景点，也保证「每天都是完整的一天」）。
     */
    interface DaySequence {
      date: string;
      hotel?: RawPOI;
      entries: Array<{ kind: 'attraction' | 'lunch' | 'tea' | 'dinner'; poi: RawPOI; slot?: 'morning' | 'afternoon' | 'evening'; note?: string }>;
    }
    const sequences: DaySequence[] = [];
    for (let i = 0; i < dayCount; i++) {
      const date = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().split('T')[0] ?? startDate;
      const dayAttrs = clusteredDays[i] || [];
      const dayWx = perDayWeather[i]?.ctx ?? null;
      const { morning: morningAttrs, afternoon: afternoonAttrs, evening: eveningAttrs } = this.splitAttractionsBySlot(dayAttrs, dayWx);

      const entries: DaySequence['entries'] = [];
      for (const attr of morningAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'morning' });

      // 午餐：靠近上午最后一个景点（顺路用餐）；无景点时锚定酒店/目的地中心。
      // 雨天优先室内（商场/美食广场类），晴天原序。
      if (dedupedRestaurants.length > 0) {
        const lunchRef = morningAttrs.length > 0
          ? morningAttrs[morningAttrs.length - 1]!
          : (afternoonAttrs.length > 0 ? afternoonAttrs[0]! : primaryHotel ?? null);
        if (lunchRef) {
          const lunchRest = this.pickRestaurantOnRoute(
            dedupedRestaurants, lunchRef.latitude, lunchRef.longitude,
            usedRestaurantIds, preferences, restaurantUsageCount,
            dayWx?.morning.rainy || dayWx?.afternoon.rainy ? 'indoor' : undefined,
          );
          if (lunchRest) {
            usedRestaurantIds.add(lunchRest.id);
            restaurantUsageCount.set(lunchRest.id, (restaurantUsageCount.get(lunchRest.id) || 0) + 1);
            entries.push({ kind: 'lunch', poi: lunchRest });
          }
        }
      }

      // 茶歇/午休：插在午餐与下午景点之间，锚定下午第一个景点（顺路）。
      // hot/rainy 必排（贴士写明原因）；晴天仅 relaxed 节奏排；intensive 晴天不排。
      const aWx = dayWx?.afternoon;
      const teaMandatory = !!(aWx && (aWx.hot || aWx.rainy));
      const teaOptional = !teaMandatory && preferences.pace === 'relaxed';
      if ((teaMandatory || teaOptional) && cafes.length > 0) {
        const teaRef = afternoonAttrs.length > 0 ? afternoonAttrs[0]! : primaryHotel ?? null;
        if (teaRef) {
          const cafe = this.pickRestaurantOnRoute(cafes, teaRef.latitude, teaRef.longitude, usedCafeIds, preferences, cafeUsageCount);
          if (cafe) {
            usedCafeIds.add(cafe.id);
            cafeUsageCount.set(cafe.id, (cafeUsageCount.get(cafe.id) || 0) + 1);
            const teaNote = aWx?.rainy
              ? '午后有雨，安排室内茶歇避雨休整'
              : aWx?.hot
                ? '午后炎热，安排茶歇避暑补水'
                : '节奏舒缓：午后茶歇小憩';
            entries.push({ kind: 'tea', poi: cafe, note: teaNote });
          }
        }
      }

      for (const attr of afternoonAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'afternoon' });

      // 晚餐：靠近下午最后一个景点（顺路用餐）；无下午景点时退回上午最后景点
      if (dedupedRestaurants.length > 0) {
        const dinnerRef = afternoonAttrs.length > 0
          ? afternoonAttrs[afternoonAttrs.length - 1]!
          : (morningAttrs.length > 0 ? morningAttrs[morningAttrs.length - 1]! : primaryHotel ?? null);
        if (dinnerRef) {
          const dinnerRest = this.pickRestaurantOnRoute(dedupedRestaurants, dinnerRef.latitude, dinnerRef.longitude, usedRestaurantIds, preferences, restaurantUsageCount);
          if (dinnerRest) {
            usedRestaurantIds.add(dinnerRest.id);
            restaurantUsageCount.set(dinnerRest.id, (restaurantUsageCount.get(dinnerRest.id) || 0) + 1);
            entries.push({ kind: 'dinner', poi: dinnerRest });
          }
        }
      }

      // B4：晚间景点（夜景/夜市/夜间演出等）排到晚餐后，夜晚时段游览
      for (const attr of eveningAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'evening' });

      sequences.push({ date, hotel: primaryHotel, entries });
    }

    /**
     * 第 1.5 步：容量预排（顺延而非丢弃）。
     * 用 haversine 估算（×1.25 安全余量，OSRM 实际路网普遍更长）逐天试装：
     * 当天装不下的景点顺延到下一天（保持 上午段→午餐前 / 晚餐后 的结构位），
     * 末天装不下的进入 overflow 池，第四步补位时统一再分配。
     * 修复「第一天排满、后面几天没内容」：景点不再因某天预算满而凭空消失。
     */
    const dayEndCap = (dayIdx: number, slot?: string) => {
      if (slot === 'evening') return PlanningService.DAY_END_MIN + 90;
      // 暴雨日提前收工（吃玩休息节奏 2026-10-15）：下午降水概率 ≥80% 且判雨时，
      // 下午槽上限提前 90 分钟——装不下的景点走既有顺延/补位机制挪到其它天，
      // 而不是冒雨硬排。
      const wx = perDayWeather[dayIdx]?.ctx;
      if (slot === 'afternoon' && wx?.afternoon.rainy && wx.afternoon.precipPct >= 80) {
        return PlanningService.DAY_END_MIN - 90;
      }
      return PlanningService.DAY_END_MIN;
    };
    const estimateDay = (seq: DaySequence, dayIdx: number): DaySequence['entries'] => {
      let t = 9 * 60;
      let prev: { lat: number; lon: number } | null = seq.hotel
        ? { lat: seq.hotel.latitude, lon: seq.hotel.longitude }
        : null;
      const overflow: DaySequence['entries'] = [];
      for (const entry of seq.entries) {
        if (entry.kind === 'attraction') {
          const transportMin = prev
            ? Math.round(this.computeTransport(prev.lat, prev.lon, entry.poi.latitude, entry.poi.longitude).durationMin * 1.25)
            : 0;
          const visitMin = this.inferVisitDuration('attraction', preferences);
          if (prev && t + transportMin + visitMin > dayEndCap(dayIdx, entry.slot)) {
            overflow.push(entry);
            continue; // 顺延项不推进时钟、不更新锚点
          }
          t += transportMin + visitMin;
        } else if (entry.kind === 'lunch') {
          t = Math.max(11 * 60, Math.min(13 * 60, t)) + 75;
        } else if (entry.kind === 'tea') {
          // 茶歇 45 分钟：午餐结束（≤13:15）后落到 13:30 起排
          t = Math.max(t, 13.5 * 60) + 45;
        } else {
          t = Math.max(17.5 * 60, t + 30) + 75;
        }
        prev = { lat: entry.poi.latitude, lon: entry.poi.longitude };
      }
      return overflow;
    };
    const overflowPool: DaySequence['entries'] = [];
    for (let i = 0; i < dayCount; i++) {
      const seq = sequences[i]!;
      const overflow = estimateDay(seq, i);
      if (overflow.length === 0) continue;
      if (i + 1 < dayCount) {
        // 顺延到下一天：常规景点插到午餐前（上午段），晚间景点插到晚餐后
        const morningLike = overflow.filter(e => e.slot !== 'evening').map(e => ({ ...e, slot: 'morning' as const }));
        const eveningLike = overflow.filter(e => e.slot === 'evening');
        const next = sequences[i + 1]!;
        let insertAt = next.entries.findIndex(e => e.kind === 'lunch');
        if (insertAt < 0) insertAt = next.entries.findIndex(e => e.kind === 'dinner');
        if (insertAt < 0) insertAt = next.entries.length;
        next.entries.splice(Math.max(0, insertAt), 0, ...morningLike);
        if (eveningLike.length > 0) {
          const dinIdx = next.entries.findIndex(e => e.kind === 'dinner');
          next.entries.splice(dinIdx < 0 ? next.entries.length : dinIdx + 1, 0, ...eveningLike);
        }
        console.log(`[PlanningService] Day${i + 1} 装不下 ${overflow.length} 个景点，顺延到 Day${i + 2}`);
      } else {
        overflowPool.push(...overflow);
      }
    }

    /**
     * 第二步：并行计算所有交通腿（OSRM 真实路网优先 + 缓存，失败降级 haversine）。
     * 腿按「起点POI→终点POI」配对缓存（替代旧的 天:序号 键）：补位/顺延改变条目
     * 序号后腿仍然有效，试排与重排无需重算。先收集全部腿再一次并发发出。
     */
    const legKey = (fromId: string, toId: string) => `${fromId}->${toId}`;
    const legMap = new Map<string, TransportLeg>();
    const pendingLegs: Array<{ key: string; fromLat: number; fromLon: number; toLat: number; toLon: number }> = [];
    const seenPair = new Set<string>();
    sequences.forEach((seq) => {
      let prev: { id: string; lat: number; lon: number } | null = seq.hotel
        ? { id: 'hotel', lat: seq.hotel.latitude, lon: seq.hotel.longitude }
        : null;
      seq.entries.forEach((entry) => {
        if (prev) {
          const key = legKey(prev.id, entry.poi.id);
          if (!seenPair.has(key)) {
            seenPair.add(key);
            pendingLegs.push({
              key,
              fromLat: prev.lat, fromLon: prev.lon,
              toLat: entry.poi.latitude, toLon: entry.poi.longitude,
            });
          }
        }
        prev = { id: entry.poi.id, lat: entry.poi.latitude, lon: entry.poi.longitude };
      });
    });
    if (pendingLegs.length > 0) {
      this.reportProgress(sessionId, 'route', `正在计算 ${pendingLegs.length} 段真实路网交通耗时（OSRM）…`);
    }
    await Promise.all(pendingLegs.map(async (leg) => {
      legMap.set(leg.key, await this.transportLeg(leg.fromLat, leg.fromLon, leg.toLat, leg.toLon));
    }));

    const formatTime = (min: number) =>
      `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

    /**
     * 第三步：排时间（单天纯函数，可重复执行供试排）。
     * 景点受当天预算约束：装不下的进入 dropped（不再静默消失，第四步补位）；
     * 午/晚餐固定时段锚定，永远保留。
     */
    const timeDay = (dayIdx: number): { items: ItineraryItem[]; endMin: number; dropped: DaySequence['entries'] } => {
      const seq = sequences[dayIdx]!;
      const items: ItineraryItem[] = [];
      let currentTimeMin = 9 * 60;
      let lastPoint: { lat: number; lon: number } | null = seq.hotel
        ? { lat: seq.hotel.latitude, lon: seq.hotel.longitude }
        : null;
      let lastPointId = 'hotel';
      const dropped: DaySequence['entries'] = [];

      if (dayIdx === 0 && seq.hotel) {
        const checkin = this.convertToItemSync(seq.hotel, 'hotel', seq.date, '08:00', preferences, travelInfo, pricingCtx);
        checkin.tips = [...(checkin.tips || []), '第一天办理入住、寄存行李后出发；早餐建议在酒店或出发途中解决'];
        items.push(checkin);
        currentTimeMin = 9 * 60;
      }

      for (const entry of seq.entries) {
        const legFor = (): TransportLeg | undefined => {
          if (!lastPoint) return undefined;
          // 配对腿优先（OSRM 真实路网）；新出现的配对（试排插入）降级 haversine 估算
          return legMap.get(legKey(lastPointId, entry.poi.id))
            ?? this.computeTransport(lastPoint.lat, lastPoint.lon, entry.poi.latitude, entry.poi.longitude);
        };

        if (entry.kind === 'attraction') {
          const leg = legFor();
          const transportMin = lastPoint ? (leg?.durationMin ?? 0) : 0;
          const visitMin = this.inferVisitDuration('attraction', preferences);
          // 当天预算：装不下 → 记入 dropped 待补位（晚间槽上限放宽到 22:30）
          if (lastPoint && currentTimeMin + transportMin + visitMin > dayEndCap(dayIdx, entry.slot)) {
            dropped.push(entry);
            continue;
          }
          const item = this.convertToItemSync(entry.poi, 'attraction', seq.date, formatTime(currentTimeMin), preferences, travelInfo, pricingCtx);
          // B5：追加"为何这样排"的天气/时段说明（逐日语境：用当天天气，不再全行程共用 Day1）
          const slotNoteText = this.slotNote({ slot: entry.slot, poi: entry.poi }, perDayWeather[dayIdx]?.ctx ?? null, entry.slot ?? 'morning');
          if (slotNoteText) item.tips = [...(item.tips || []), slotNoteText];
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          lastPointId = entry.poi.id;
          currentTimeMin += transportMin + visitMin;
        } else if (entry.kind === 'lunch') {
          const lunchTime = Math.max(11 * 60, Math.min(13 * 60, currentTimeMin));
          const item = this.convertToItemSync(entry.poi, 'restaurant', seq.date, formatTime(lunchTime), preferences, travelInfo, pricingCtx);
          const leg = legFor();
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          lastPointId = entry.poi.id;
          currentTimeMin = lunchTime + 75;
        } else if (entry.kind === 'tea') {
          const teaTime = Math.max(13.5 * 60, currentTimeMin);
          const item = this.convertToItemSync(entry.poi, 'restaurant', seq.date, formatTime(teaTime), preferences, travelInfo, pricingCtx);
          const leg = legFor();
          if (leg) item.transportFromPrev = leg;
          item.tips = [...(item.tips || []), entry.note || '午后茶歇，稍作休整'];
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          lastPointId = entry.poi.id;
          currentTimeMin = teaTime + 45;
        } else {
          const dinnerTime = Math.max(17.5 * 60, currentTimeMin + 30);
          const item = this.convertToItemSync(entry.poi, 'restaurant', seq.date, formatTime(dinnerTime), preferences, travelInfo, pricingCtx);
          const leg = legFor();
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          lastPointId = entry.poi.id;
          currentTimeMin = dinnerTime + 75;
        }
      }

      // 每天以酒店收尾（住宿锚点）：
      // - 有实质行程（≥1 个非酒店条目）→ 追加「返回酒店休整」；
      // - 当天完全没排进行程点（POI 池不足）→ 追加酒店自由活动锚点，
      //   保证任何一天都不会是空白，用户也能在地图/时间线上看到每天的住宿。
      // 房费只计一次（_summarizePricing 取首个酒店报价 × 晚数），不会因逐日条目重复计价。
      if (seq.hotel) {
        const hasNonHotelItem = items.some(it => it.name !== seq.hotel!.name);
        if (hasNonHotelItem) {
          const retTimeMin = Math.min(22 * 60, currentTimeMin + 30);
          const retItem = this.convertToItemSync(seq.hotel, 'hotel', seq.date, formatTime(retTimeMin), preferences, travelInfo, pricingCtx);
          retItem.tips = [...(retItem.tips || []), '今日行程结束，返回酒店休整'];
          // 次日早餐提示（末天收尾无「次日」，不加）
          if (dayIdx < dayCount - 1) {
            retItem.tips = [...(retItem.tips || []), '次日早餐建议在酒店解决，或出发前顺路吃本地早点'];
          }
          items.push(retItem);
        } else if (items.length === 0) {
          const leisureItem = this.convertToItemSync(seq.hotel, 'hotel', seq.date, formatTime(10 * 60), preferences, travelInfo, pricingCtx);
          leisureItem.tips = [
            ...(leisureItem.tips || []),
            '当天实时数据未覆盖足够的景点，建议酒店休闲或自由探索周边；可在行程里手动添加想去的地点',
          ];
          items.push(leisureItem);
        }
      }

      return { items, endMin: currentTimeMin, dropped };
    };

    const days: PlannedDay[] = [];
    const dayDropped: DaySequence['entries'][] = [];
    for (let i = 0; i < dayCount; i++) {
      const r = timeDay(i);
      days.push({ date: sequences[i]!.date, items: r.items, dayWeather: perDayWeather[i]?.summary });
      dayDropped.push(r.dropped);
    }
    // 末天顺延出来的景点并入补位池
    if (overflowPool.length > 0 && dayCount > 0) {
      dayDropped[dayCount - 1]!.push(...overflowPool);
    }

    /**
     * 第四步：每日完整性补位。
     * 被时间预算挤出的景点按「地理最近且有余额的天」尝试回填：对该天试排，
     * 试排能容纳（该景点不再被挤出）才接受。保证多天行程里景点均匀铺满，
     * 而不是集中在头几天、后面几天空空荡荡。
     */
    const nearestDistToDay = (d: number, poi: RawPOI): number => {
      const seq = sequences[d]!;
      const points: Coordinates[] = seq.entries.map(e => ({ latitude: e.poi.latitude, longitude: e.poi.longitude }));
      if (seq.hotel) points.push({ latitude: seq.hotel.latitude, longitude: seq.hotel.longitude });
      if (points.length === 0) points.push(center);
      return Math.min(...points.map(p => this.haversineKm(p.latitude, p.longitude, poi.latitude, poi.longitude)));
    };
    for (let srcDay = 0; srcDay < dayCount; srcDay++) {
      const from = dayDropped[srcDay]!;
      if (from.length === 0) continue;
      const stillDropped: DaySequence['entries'] = [];
      for (const entry of from) {
        let placed = false;
        const order = Array.from({ length: dayCount }, (_, d) => d)
          .sort((a, b) => nearestDistToDay(a, entry.poi) - nearestDistToDay(b, entry.poi));
        for (const d of order) {
          const seq = sequences[d]!;
          const trialEntry: DaySequence['entries'][number] = { ...entry, slot: entry.slot === 'evening' ? 'evening' : 'morning' };
          const trial = [...seq.entries];
          let insertAt = trialEntry.slot === 'evening'
            ? trial.findIndex(e => e.kind === 'dinner') + 1
            : trial.findIndex(e => e.kind === 'lunch');
          if (insertAt <= 0) insertAt = trial.length;
          trial.splice(insertAt, 0, trialEntry);
          const saved = seq.entries;
          seq.entries = trial;
          const ret = timeDay(d);
          if (!ret.dropped.some(de => de.poi.id === trialEntry.poi.id)) {
            days[d] = { date: seq.date, items: ret.items };
            dayDropped[d] = ret.dropped;
            placed = true;
            console.log(`[PlanningService] 补位: 「${trialEntry.poi.name}」排入 Day${d + 1}`);
            break;
          }
          seq.entries = saved; // 试排失败回滚，尝试下一天
        }
        if (!placed) stillDropped.push(entry);
      }
      dayDropped[srcDay] = stillDropped;
    }

    const attractionTotal = days.reduce((n, d) => n + d.items.filter(it => it.type === 'attraction').length, 0);
    const mealTotal = days.reduce((n, d) => n + d.items.filter(it => it.type === 'restaurant').length, 0);
    const hotelTotal = days.reduce((n, d) => n + d.items.filter(it => it.type === 'hotel').length, 0);
    const daysWithAttractions = days.filter(d => d.items.some(it => it.type === 'attraction')).length;
    this.reportProgress(
      sessionId,
      'schedule',
      `已编排完成：${dayCount} 天 · ${attractionTotal} 个景点 · ${mealTotal} 次用餐 · ${hotelTotal} 处住宿安排`,
    );
    console.log(
      `[PlanningService] 每日完整性: ${daysWithAttractions}/${dayCount} 天有景点安排，` +
      `补位后仍未排入 ${dayDropped.reduce((n, l) => n + l.length, 0)} 个景点（POI 池/时间预算所限）`,
    );

    return { days, pois: allPois };
  }

  /**
   * 住宿锚定优选（2026-10-15「从住宿开始规划」）：旧实现盲取搜索结果第一个，
   * 可能离全部景点几十公里。这里以景点加权质心距离为主权重，叠加评分、
   * 偏好匹配与名称可信度综合选主酒店，之后每天行程围绕该酒店聚类编排。
   */
  private pickPrimaryHotel(
    hotels: RawPOI[],
    attractions: RawPOI[],
    prefs: TripPreferences,
  ): RawPOI | undefined {
    if (hotels.length === 0) return undefined;

    // 景点加权质心：排序靠前的景点（代表性强/评分高）权重更高
    let wSum = 0;
    let latSum = 0;
    let lonSum = 0;
    attractions.slice(0, 12).forEach((a, i) => {
      const w = 12 - i;
      wSum += w;
      latSum += a.latitude * w;
      lonSum += a.longitude * w;
    });
    const cLat = wSum > 0 ? latSum / wSum : (attractions[0]?.latitude ?? hotels[0]!.latitude);
    const cLon = wSum > 0 ? lonSum / wSum : (attractions[0]?.longitude ?? hotels[0]!.longitude);

    let best = hotels[0]!;
    let bestScore = -Infinity;
    for (const h of hotels) {
      // 距离主权重：每远 1km 扣 10 分，10km 外归零
      const dist = this.haversineKm(cLat, cLon, h.latitude, h.longitude);
      const distScore = Math.max(0, 100 - dist * 10);
      const blended = this.effectiveRating(h, 'hotel');
      let score = distScore + (blended > 0 ? blended : SCORING.routePick.ratingFallback) * 6;

      const hay = `${h.name} ${(h.tags || []).join(' ')}`.toLowerCase();
      if (prefs.seaside && /(海|滩|湾|beach|bay|coast|seaside|ocean)/i.test(hay)) score += SCORING.hotel.seaside;
      if (prefs.pool && /(泳池|游泳池|pool|swimming)/i.test(hay)) score += SCORING.hotel.pool;
      if (prefs.hotelTier === 'luxury' && /(豪华|五星|resort|residence)/i.test(hay)) score += SCORING.hotel.luxuryTier;
      if (prefs.hotelTier === 'budget' && /(青旅|民宿|客栈|经济|hostel)/i.test(hay)) score += SCORING.hotel.budgetTier;
      // 名称可信度加分：正规酒店业态词（压民宿公寓/杂项噪音）
      if (/(酒店|饭店|宾馆|度假村|hotel|resort|suites|inn)/i.test(hay)) score += 6;

      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }

  /**
   * 选择距离参考点最近且未被使用的餐厅（顺路餐厅）
   * 综合评分 = 距离(60%) + 评分(25%) + 偏好匹配(15%)
   * 结合用户喜好（菜系/预算/海景）和网上推荐（评分/评价数）
   */
  private pickRestaurantOnRoute(
    restaurants: RawPOI[],
    refLat: number,
    refLon: number,
    usedIds: Set<string>,
    prefs: TripPreferences,
    usageCount?: Map<string, number>,
    /** 雨天传 'indoor'：给已打 indoor 标签的候选加分（无室内候选时自然回落） */
    indoorHint?: 'indoor'
  ): RawPOI | null {
    if (restaurants.length === 0) return null;

    let candidates = restaurants.filter(r => !usedIds.has(r.id));
    if (candidates.length === 0) {
      if (!usageCount || usageCount.size === 0) return null;
      let minUse = Infinity;
      for (const [, count] of usageCount) {
        if (count < minUse) minUse = count;
      }
      candidates = restaurants.filter(r => (usageCount.get(r.id) || 0) <= minUse);
      if (candidates.length === 0) candidates = restaurants;
    }

    let best = candidates[0] ?? null;
    let bestScore = -Infinity;
    for (const r of candidates) {
      const dist = this.haversineKm(refLat, refLon, r.latitude, r.longitude);
      const distScore = Math.max(0, SCORING.routePick.distanceBase - dist * SCORING.routePick.distanceScale);
      // 评分采用本地评论聚合分混合（无本地评论时退回默认口径）
      const blended = this.effectiveRating(r, 'restaurant');
      const ratingScore = (blended > 0 ? blended : SCORING.routePick.ratingFallback) * SCORING.routePick.ratingScale;
      let prefScore = 0;
      const hay = `${r.name} ${(r.tags || []).join(' ')}`.toLowerCase();
      if (prefs.cuisine) {
        const re = new RegExp(prefs.cuisine, 'i');
        if (re.test(hay)) prefScore += SCORING.routePick.cuisineMatch;
      }
      if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) prefScore += SCORING.routePick.seasideMatch;
      if (prefs.budget === 'low' && /(小吃|快餐|平价|local|经济)/i.test(hay)) prefScore += SCORING.routePick.budgetMatch;
      if (prefs.budget === 'high' && /(精致|高档|fine|dining|luxury)/i.test(hay)) prefScore += SCORING.routePick.budgetMatch;
      if (indoorHint === 'indoor' && (r.tags || []).includes('indoor')) prefScore += SCORING.routePick.cuisineMatch;

      const usePenalty = (usageCount?.get(r.id) || 0) * SCORING.routePick.reusePenalty;
      const totalScore =
        distScore * SCORING.routePick.distanceWeight + ratingScore * SCORING.routePick.ratingWeight + prefScore - usePenalty;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        best = r;
      }
    }
    return best;
  }

  /**
   * 阶段2（请求路径内）：媒体装配 —— 纯本地读，不发任何网络请求。
   *
   * 取图优先级：媒体库本地上传/精选图 > POI 缓存中已落盘的回填图（wikimedia）。
   * 两级都未命中的 POI 进入 missing 列表，交由 backfillMediaBackground 离线回填。
   * 同时从媒体库带出评论（最新3条）与视频（≤5条）供行程卡片直读。
   */
  private collectMediaForDays(
    days: PlannedDay[],
    entry: CacheEntry | null,
    /** 缓存三桶之外的图源直通（茶歇 cafe 等）：poiId → 实拍图，查缓存无果后兜底 */
    extraImagesByPoiId?: Map<string, string[]>,
  ): {
    imageMap: Map<string, string[]>;
    missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }>;
  } {
    // 收集所有唯一 POI（含坐标，去重）
    const poiSet = new Map<string, {
      poiId?: string;
      type: ItineraryItem['type'];
      name: string;
      lat: number;
      lon: number;
    }>();
    for (const day of days) {
      for (const item of day.items) {
        const key = `${item.type}-${item.itemId}`;
        if (!poiSet.has(key)) {
          poiSet.set(key, {
            poiId: item.poiId,
            type: item.type,
            name: item.name,
            lat: item.latitude,
            lon: item.longitude,
          });
        }
      }
    }

    const imageMap = new Map<string, string[]>();
    const missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }> = [];

    for (const [key, info] of poiSet) {
      // 1. 媒体库：本地上传/精选优先，其次历史回填图
      let images = travelMediaStore.imageUrls(info.type, info.name, 'user');
      if (images.length === 0) images = travelMediaStore.imageUrls(info.type, info.name, 'wikimedia');
      // 2. POI 缓存中已落盘的回填图（旧数据兜底）
      if (images.length === 0 && info.poiId) {
        images = this.findCachedPOIImages(entry, info.type, info.poiId);
      }
      // 3. 缓存外直通图源（茶歇 cafe 等）：POI 搜索时已抓到的实拍图
      if (images.length === 0 && info.poiId && extraImagesByPoiId) {
        images = extraImagesByPoiId.get(info.poiId) ?? [];
      }

      // 只有**完全没图**的 POI 才进回填队列（视频/评论已下线，不再是回填判据）
      if (images.length > 0) imageMap.set(key, images);
      else {
        missing.push({
          poiId: info.poiId,
          type: info.type,
          name: info.name,
          latitude: info.lat,
          longitude: info.lon,
        });
      }
    }

    console.log(`[PlanningService] 媒体装配(本地直读): ${imageMap.size}/${poiSet.size} 个POI有图`);
    return { imageMap, missing };
  }

  /** 自动回填开关：TRAVEL_MEDIA_BACKFILL=off 时只走管理员手动触发/本地上传 */
  private static readonly AUTO_BACKFILL_ENABLED =
    (process.env.TRAVEL_MEDIA_BACKFILL ?? 'on').toLowerCase() !== 'off';

  /**
   * POI 媒体补全：补齐**照片**（缺图才补，已有就跳过）。
   * 供 /travel/media/backfill 与旅行数据维护服务调用。
   *
   * 返回本次实际新增的数量——调用方（数据维护服务）据此汇报「补了什么、补了几条」。
   *
   * 2026-10-12：视频与评论随视频能力下线移除，媒体库只剩照片一类；
   * 但返回结构保留 videos/reviews 恒为 0，避免调用方（维护服务 + 其前端快照接口）
   * 为了一个永远是 0 的字段去改类型。
   */
  async backfillMediaForPoi(
    name: string,
    type: ItineraryItem['type'],
    latitude?: number,
    longitude?: number,
  ): Promise<{ images: number; videos: number; reviews: number }> {
    const coords =
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined;
    const before = travelMediaStore.aggregate(type, name);

    if (!before || before.imageCount === 0) {
      let fetched = await this.fetchSingleWithRetry(name, type, latitude, longitude);
      if (fetched.length === 0) {
        // Wikimedia 盖不住的长尾 POI（酒店/小馆）由必应兜底
        try {
          fetched = await fetchBingPhotoUrls(name, 3);
        } catch {
          fetched = [];
        }
      }
      if (fetched.length > 0) {
        const localized = await travelMediaStore.localizeAndAttach(type, name, fetched, coords);
        return { images: localized.length, videos: 0, reviews: 0 };
      }
    }
    return { images: 0, videos: 0, reviews: 0 };
  }

  /**
   * 阶段2.5（后台，不阻塞请求）：缺图 POI 的离线回填。
   * Wikimedia 抓取（复用原有校验链）成功后同时写入媒体库与 POI 缓存，
   * 下次规划请求路径内直接命中。同目的地同时只跑一轮（并发 3）。
   */
  private backfillInFlight = new Set<string>();
  private backfillMediaBackground(
    missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }>,
    entry: CacheEntry | null,
  ): void {
    const tag = entry?.destination ?? 'unknown';
    if (this.backfillInFlight.has(tag)) {
      console.log(`[PlanningService] 后台媒体回填进行中，跳过本次: ${tag}`);
      return;
    }
    this.backfillInFlight.add(tag);
    console.log(`[PlanningService] 后台媒体回填启动: ${tag}，${missing.length} 个POI（不阻塞当前请求）`);

    void (async () => {
      const CONCURRENCY = 3;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor++;
          if (idx >= missing.length) return;
          const info = missing[idx]!;
          const coords = { latitude: info.latitude, longitude: info.longitude };
          try {
            // 三类媒体各自判断「缺不缺」、互不阻塞：缺图补图、缺视频抓视频、
            // 缺评论抓口碑。任一失败只影响自己那一项，不牵连其余。
            const agg = travelMediaStore.aggregate(info.type, info.name);

            if (!agg || agg.imageCount === 0) {
              let fetched = await this.fetchSingleWithRetry(info.name, info.type, info.latitude, info.longitude);
              if (fetched.length === 0) {
                // Wikimedia 盖不住的长尾 POI（酒店/小馆）由必应兜底
                try {
                  fetched = await fetchBingPhotoUrls(info.name, 3);
                } catch {
                  fetched = [];
                }
              }
              if (fetched.length > 0) {
                // 先落地本机（内容寻址去重）再回写 POI 缓存：这样载荷里带的就是本地
                // 资产路径，前端不再依赖第三方图床，弱网/离线也能出图。
                const localized = await travelMediaStore.localizeAndAttach(info.type, info.name, fetched, coords);
                // 同步写回 POI 缓存（请求路径内的旧数据兜底层）
                if (entry && info.poiId) {
                  poiCache.updatePOIImages(entry.destination, info.type, info.poiId, localized);
                }
              }
            }

          } catch { /* 单点失败不影响整体 */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));
      console.log(`[PlanningService] 后台媒体回填完成: ${tag}`);
    })().finally(() => this.backfillInFlight.delete(tag));
  }

  /**
   * 单 POI 图片抓取：失败自动重试 1 次（300ms 起指数退避）
   * 仅由后台回填调用，不再出现在请求路径上。
   */
  private async fetchSingleWithRetry(
    poiName: string,
    type: string,
    lat?: number,
    lon?: number,
  ): Promise<string[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const images = await this.fetchRealImages(poiName, type, lat, lon);
        if (images.length > 0) return images;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }
    // 第二次结果若无图也返回空，交由上层跳过；网络失败则抛出
    if (lastErr !== undefined) throw lastErr;
    return [];
  }

  /**
   * 从 POI 缓存条目中取出某 POI 已落盘的图片
   */
  private findCachedPOIImages(
    entry: CacheEntry | null,
    type: ItineraryItem['type'],
    poiId?: string,
  ): string[] {
    if (!entry || !poiId) return [];
    const listKey = `${type}s` as keyof CacheEntry['data'];
    const list = entry.data[listKey];
    if (!list) return [];
    // 2026-10-15 高德实拍图退役：新搜索不再种子实拍图，但 7 天期磁盘缓存里
    // 还烤着旧的高德图 URL（aos-comment.amap.com / store.is.autonavi.com），
    // 读取时按 host 过滤丢弃，缓存自然过期后这段就是空过滤。
    return (list.find((p) => p.id === poiId)?.images ?? [])
      .filter((u) => !/^https?:\/\/[^/]*(amap|autonavi)\.com\//i.test(u));
  }

  /**
   * 将本地媒体装配回行程数据：只挂图片。
   * 2026-10-12：评论/视频能力下线后，这里不再有第二类媒体可装配。
   */
  private enrichDaysWithMedia(
    daysRaw: PlannedDay[],
    imageMap: Map<string, string[]>,
  ): PlannedDay[] {
    return daysRaw.map(day => ({
      ...day,
      items: day.items.map(item => {
        const images = imageMap.get(`${item.type}-${item.itemId}`);
        if (!images || images.length === 0) return item;
        return { ...item, images };
      }),
    }));
  }

  /**
   * 同步版本 convertToItem（纯数据构建）
   * 图片/评论/视频在阶段2通过 collectMediaForDays 本地装配
   */
  private convertToItemSync(
    poi: RawPOI,
    type: ItineraryItem['type'],
    date: string,
    time: string,
    preferences: TripPreferences,
    travelInfo: TravelInfo,
    pricingCtx: import('./pricing-service.js').PricingContext
  ): ItineraryItem {
    const startTime = `${date}T${time}:00`;
    const images: string[] = []; // 图片留空，阶段2并行填充

    const visitMin = this.inferVisitDuration(type, preferences);
    const [hh, mm] = time.split(':').map(n => parseInt(n, 10));
    const endTotalMin = (hh ?? 0) * 60 + (mm ?? 0) + visitMin;
    const endTime = `${date}T${String(Math.floor(endTotalMin / 60) % 24).padStart(2, '0')}:${String(endTotalMin % 60).padStart(2, '0')}:00`;

    let priceQuote: PriceQuote;
    if (type === 'hotel') priceQuote = pricingService.quoteHotel(poi.name, poi.tags || [], pricingCtx);
    else if (type === 'attraction') priceQuote = pricingService.quoteAttraction(poi.name, poi.tags || [], pricingCtx);
    else priceQuote = pricingService.quoteRestaurant(poi.name, poi.tags || [], pricingCtx);

    const priceInfo = this._formatPriceInfo(priceQuote);

    const baseItem: ItineraryItem = {
      itemId: `${type}-${poi.id}-${Date.now()}`,
      poiId: poi.id,
      type,
      name: poi.name,
      description: this.generateDescription(poi, type, preferences),
      startTime,
      endTime,
      visitDuration: visitMin,
      tips: this.generateItemTips(poi, type, preferences, travelInfo),
      bookingNote: this.generateBookingNote(poi, type, preferences),
      latitude: poi.latitude,
      longitude: poi.longitude,
      rating: poi.rating || 0,
      priceInfo,
      address: poi.address || `${poi.name}地址`,
      phone: (() => { const t = (poi.raw?.tags) as Record<string,string>|undefined; return t?.['phone'] || t?.['contact:phone'] || t?.['telephone'] || '暂无公开电话'; })(),
      openingHours: (() => {
        const osmHours = (poi.raw?.tags as Record<string,string>|undefined)?.['opening_hours'];
        if (osmHours) return osmHours;
        return type === 'hotel' ? '24小时前台 · 14:00入住 12:00退房' :
               type === 'attraction' ? '开放时间请以现场公示为准' : '开放时间请以现场公示为准';
      })(),
      tags: this.generateTags(type, poi.rating || 0, preferences),
      images,
      splatUrl: poi.splatUrl,
      priceQuote,
    };

    if (type === 'hotel') {
      baseItem.pricePerNight = priceQuote.finalPrice;
      baseItem.starRating = (poi.rating && poi.rating > 0) ? Math.min(5, Math.max(1, Math.round(poi.rating))) : undefined;
      const amenitySet = new Set<string>(['WiFi', '空调', '独立卫浴']);
      const osmAmenities = (poi.raw?.tags) as Record<string,string> | undefined;
      if (osmAmenities) {
        if (osmAmenities['swimming_pool']) amenitySet.add('泳池');
        if (osmAmenities['wifi'] || osmAmenities?.['internet_access']) amenitySet.add('WiFi');
        if (osmAmenities['parking']) amenitySet.add('停车场');
        if (osmAmenities['restaurant']) amenitySet.add('餐厅');
        if (osmAmenities['air_conditioning']) amenitySet.add('空调');
      }
      if (preferences.seaside) amenitySet.add('海景房');
      if (preferences.pool) amenitySet.add('泳池');
      if (preferences.kids) amenitySet.add('亲子设施');
      if (preferences.elderly) amenitySet.add('无障碍');
      const amenities = Array.from(amenitySet);
      baseItem.rooms = [
        { name: '标准间', pricePerNight: priceQuote.finalPrice, capacity: 2, amenities, image: '' },
        { name: '豪华房', pricePerNight: Math.round(priceQuote.finalPrice * 1.4), capacity: 2, amenities: [...amenities, '观景窗'], image: '' },
      ];
    } else if (type === 'attraction') {
      baseItem.ticketPrice = priceQuote.finalPrice;
      baseItem.category = this.inferCategory(poi.tags || [], preferences);
    } else if (type === 'restaurant') {
      baseItem.avgPrice = priceQuote.finalPrice;
      baseItem.priceLevel = baseItem.avgPrice < 50 ? 1 : baseItem.avgPrice < 100 ? 2 : 3;
      baseItem.cuisine = preferences.cuisine || this.inferCuisine(poi.tags || [], poi.name);
      baseItem.menuItems = [
        { name: '招牌推荐', price: priceQuote.finalPrice, desc: '招牌菜品', image: '', isSignature: true, tag: '招牌' },
        { name: '经典菜', price: Math.round(priceQuote.finalPrice * 0.7), desc: '经典做法', image: '', isSignature: true, tag: '必点' },
      ];
    }

    return baseItem;
  }

  /**
   * 按地理位置将景点聚类到各天，并在每天内优化游览顺序
   *
   * 算法：
   * 1. K-means 聚类：将景点按位置分到 N 天（N=dayCount）
   * 2. 每天内最近邻排序：从酒店/中心出发，每次选最近的下一个点
   */
  private clusterAttractionsByGeo(
    attractions: RawPOI[],
    dayCount: number,
    startPoint: Coordinates,
    maxPerDay: number
  ): RawPOI[][] {
    // 去重：按名称（忽略大小写/空格）去除重复景点
    const seenNames = new Set<string>();
    const deduped: RawPOI[] = [];
    for (const a of attractions) {
      const key = (a.name || '').trim().toLowerCase();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        deduped.push(a);
      }
    }
    attractions = deduped;

    if (attractions.length === 0) return Array.from({ length: dayCount }, () => []);

    const result: RawPOI[][] = Array.from({ length: dayCount }, () => []);

    // 如果景点少于天数：按距起点远近顺序逐日分配（避免全堆在第一天）
    if (attractions.length <= dayCount) {
      const sorted = [...attractions].sort((a, b) =>
        this.haversineKm(startPoint.latitude, startPoint.longitude, a.latitude, a.longitude) -
        this.haversineKm(startPoint.latitude, startPoint.longitude, b.latitude, b.longitude));
      sorted.forEach((attr, idx) => {
        result[idx % dayCount]?.push(attr);
      });
      this.reorderDays(result, dayCount, startPoint, maxPerDay);
      return result;
    }

    // ===== Step 1: farthest-first 初始化聚类中心（确定性与散布性兼顾）=====
    // 首个中心取距起点最近的景点；其后每轮选「距已有中心最小距离最大」的点，
    // 避免旧网格初始化（经度只按 i%3 摆 3 列）在天数>3 时中心重叠、聚出空簇。
    const centroids: Array<{ lat: number; lon: number }> = [];
    {
      const first = attractions.reduce((best, a) => {
        const d = this.haversineKm(startPoint.latitude, startPoint.longitude, a.latitude, a.longitude);
        const bd = this.haversineKm(startPoint.latitude, startPoint.longitude, best.latitude, best.longitude);
        return d < bd ? a : best;
      }, attractions[0]!);
      centroids.push({ lat: first.latitude, lon: first.longitude });
      while (centroids.length < dayCount) {
        let far = attractions[0]!;
        let farDist = -1;
        for (const a of attractions) {
          const minD = Math.min(...centroids.map(c => this.haversineKm(a.latitude, a.longitude, c.lat, c.lon)));
          if (minD > farDist) {
            farDist = minD;
            far = a;
          }
        }
        centroids.push({ lat: far.latitude, lon: far.longitude });
      }
    }

    // ===== Step 2: K-means 迭代（最多10轮）=====
    const clusters: number[] = new Array(attractions.length).fill(0);

    for (let iter = 0; iter < 10; iter++) {
      // 分配每个点到最近的中心
      let changed = false;
      for (let i = 0; i < attractions.length; i++) {
        const a = attractions[i]!;
        let bestCluster = 0;
        let bestDist = Infinity;
        for (let c = 0; c < dayCount; c++) {
          const dist = this.haversineKm(a.latitude, a.longitude, centroids[c]!.lat, centroids[c]!.lon);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }
        if (clusters[i] !== bestCluster) {
          clusters[i] = bestCluster;
          changed = true;
        }
      }

      // 更新聚类中心
      for (let c = 0; c < dayCount; c++) {
        const members = attractions.filter((_, i) => clusters[i] === c);
        if (members.length > 0) {
          centroids[c] = {
            lat: members.reduce((s, m) => s + m.latitude, 0) / members.length,
            lon: members.reduce((s, m) => s + m.longitude, 0) / members.length,
          };
        }
      }

      if (!changed) break; // 收敛
    }

    // ===== Step 3: 将聚类结果分配到每天 =====
    for (let i = 0; i < attractions.length; i++) {
      const cluster = clusters[i] ?? 0;
      result[cluster]?.push(attractions[i]!);
    }

    // ===== Step 3.5: 空簇回收：从最大簇借走离空簇中心最近的点 =====
    for (let c = 0; c < dayCount; c++) {
      if ((result[c]?.length ?? 0) > 0) continue;
      let biggest = -1;
      let biggestLen = 1;
      for (let d = 0; d < dayCount; d++) {
        if ((result[d]?.length ?? 0) > biggestLen) {
          biggestLen = result[d]!.length;
          biggest = d;
        }
      }
      if (biggest < 0) break;
      let stealIdx = -1;
      let stealDist = Infinity;
      for (let j = 0; j < result[biggest]!.length; j++) {
        const p = result[biggest]![j]!;
        const d = this.haversineKm(p.latitude, p.longitude, centroids[c]!.lat, centroids[c]!.lon);
        if (d < stealDist) {
          stealDist = d;
          stealIdx = j;
        }
      }
      if (stealIdx >= 0) {
        result[c]!.push(result[biggest]!.splice(stealIdx, 1)[0]!);
      }
    }

    // ===== Step 4: 每天内按最近邻 + 2-opt 优化顺序 =====
    this.reorderDays(result, dayCount, startPoint, maxPerDay);

    // 处理未被分配的景点（被 maxPerDay 截断的，重新分配到有空位的日期）
    // 用 ID 集合追踪已分配的景点，避免重复添加
    const assignedIds = new Set<string>();
    for (let d = 0; d < dayCount; d++) {
      for (const poi of result[d] ?? []) {
        if (poi.id) assignedIds.add(poi.id);
      }
    }
    const unassigned = attractions.filter(a => !assignedIds.has(a.id));
    const touchedDays = new Set<number>();
    unassigned.forEach((attr) => {
      // 找有空位且距离该景点最近的日期加入
      let bestDay = -1;
      let bestDist = Infinity;
      for (let d = 0; d < dayCount; d++) {
        if ((result[d]?.length ?? 0) >= maxPerDay) continue;
        const dayPois = result[d] ?? [];
        if (dayPois.length === 0) {
          bestDay = d;
          break;
        }
        // 计算到该日期已有景点的最近距离
        const minDist = Math.min(...dayPois.map(p => this.haversineKm(p.latitude, p.longitude, attr.latitude, attr.longitude)));
        if (minDist < bestDist) {
          bestDist = minDist;
          bestDay = d;
        }
      }
      if (bestDay >= 0) {
        result[bestDay]!.push(attr);
        touchedDays.add(bestDay);
      }
    });

    // 补位后受影响的天重跑排序（否则补进去的点会破坏最优邻接序）
    if (touchedDays.size > 0) {
      this.reorderDays(result, dayCount, startPoint, maxPerDay);
    }

    console.log(`[PlanningService] 地理聚类完成: ${result.map((d, i) => `Day${i+1}:${d.length}个景点`).join(', ')}`);
    return result;
  }

  /**
   * 每天内排序：从起点最近邻出发，再做 2-opt 改进（开放式路径，消除交叉），
   * 最后截断到 maxPerDay。天数少、点少，2-opt 全量扫描代价可忽略。
   */
  private reorderDays(
    result: RawPOI[][],
    dayCount: number,
    startPoint: Coordinates,
    maxPerDay: number,
  ): void {
    const pathLen = (arr: RawPOI[]): number => {
      let s = 0;
      let prev: Coordinates = startPoint;
      for (const p of arr) {
        s += this.haversineKm(prev.latitude, prev.longitude, p.latitude, p.longitude);
        prev = { latitude: p.latitude, longitude: p.longitude };
      }
      return s;
    };

    for (let d = 0; d < dayCount; d++) {
      const dayPois = result[d]!;
      if (dayPois.length <= 1) continue;

      // 最近邻：从起点出发
      const ordered: RawPOI[] = [];
      const visited = new Set<number>();
      let current: Coordinates = startPoint;
      for (let count = 0; count < dayPois.length; count++) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let j = 0; j < dayPois.length; j++) {
          if (visited.has(j)) continue;
          const dist = this.haversineKm(current.latitude, current.longitude, dayPois[j]!.latitude, dayPois[j]!.longitude);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = j;
          }
        }
        if (bestIdx >= 0) {
          visited.add(bestIdx);
          const chosen = dayPois[bestIdx]!;
          ordered.push(chosen);
          current = { latitude: chosen.latitude, longitude: chosen.longitude };
        }
      }

      // 2-opt 改进：若反转某段能缩短路径则采纳（有守卫上限，防极端退化）
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 20) {
        improved = false;
        const base = pathLen(ordered);
        for (let i = 0; i < ordered.length - 1; i++) {
          for (let k = i + 1; k < ordered.length; k++) {
            const cand = [...ordered.slice(0, i), ...ordered.slice(i, k + 1).reverse(), ...ordered.slice(k + 1)];
            if (pathLen(cand) < base - 1e-9) {
              ordered.length = 0;
              ordered.push(...cand);
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
      }

      result[d] = ordered.slice(0, maxPerDay); // 限制每天最大数量
    }
  }

  /**
   * 格式化价格显示文本
   *  - 优惠时：¥实付 (原价¥xx · 优惠yy)
   *  - 无优惠：¥原价
   *  - 免费：免费
   */
  private _formatPriceInfo(q: PriceQuote): string {
    return formatQuotePriceInfo(q);
  }

  // ======================== 辅助方法 ========================

  private generateImages(type: string, poiName: string, lat?: number, lon?: number): Promise<string[]> {
    return this.fetchRealImages(poiName, type, lat, lon);
  }

  /**
   * 可达源配图：宿主注入的搜索端口优先，否则内置必应图片抓取。
   *
   * 顺序与"权威性"无关，只跟实测连通性有关：Wikimedia 在本机网络下要白等
   * 10~12s 超时才返回空，必应 0.55s。返回空数组表示两个可达源都没拿到图，
   * 由调用方决定是否再试 Wikimedia（兜底）。
   */
  private async fetchReachableImages(poiName: string, qualifier?: string): Promise<string[]> {
    const query =
      [poiName.replace(/[()（）·•・]/g, ' ').replace(/\s+/g, ' ').trim(), qualifier?.trim()]
        .filter(Boolean)
        .join(' ');
    if (!poiName.replace(/[()（）·•・]/g, ' ').trim()) return [];
    if (this.imageSearch) {
      try {
        const viaPort = await this.imageSearch.searchImages(query, BING_MAX_IMAGES);
        const clean = (viaPort ?? []).filter((u) => typeof u === 'string' && /^https?:/i.test(u));
        if (clean.length > 0) {
          console.log(`[ImageSearch] ${query}: 搜索端口命中 ${clean.length} 张`);
          return clean.slice(0, BING_MAX_IMAGES);
        }
      } catch { /* 端口失败：降级到内置抓取 */ }
    }
    const bing = await this.fetchBingImages(query);
    if (bing.length > 0) {
      console.log(`[ImageSearch] ${query}: 必应命中 ${bing.length} 张`);
    }
    return bing;
  }

  /**
   * 必应图片抓取（POI 配图主源）。
   *
   * 只做「取候选 URL」这一件事：列表页拿不到尺寸元数据，宽高校验与落地留存
   * 交给下载阶段（照片本地化）——不在这一步臆造过滤条件。
   */
  private async fetchBingImages(query: string, limit = BING_MAX_IMAGES): Promise<string[]> {
    try {
      const url =
        `${BING_IMAGES_BASE}?q=${encodeURIComponent(query)}` +
        `&first=0&count=${Math.max(8, limit * 2)}&mmasync=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': BING_IMAGES_UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(BING_IMAGES_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const html = (await res.text()).replace(/&quot;/g, '"');
      const urls: string[] = [];
      for (const m of html.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)) {
        const u = m[1];
        if (!u || urls.includes(u)) continue;
        // 与 Wikimedia 同口径的脏图过滤（图标/地图/logo/水印占位等）
        const tail = u.split('/').pop() ?? '';
        if (WIKI_BLOCKED_PATTERNS.some((p) => p.test(tail))) continue;
        // 图库水印站：预览图烙站标，一律不入候选
        if (isStockWatermarkHost(u)) continue;
        urls.push(u);
        if (urls.length >= limit) break;
      }
      return urls;
    } catch {
      return []; // 抓取失败不抛：调用方还有 Wikimedia 兜底与前端渐变兜底
    }
  }

  /**
   * Wikimedia 是否可达（带 10 分钟窗口缓存）。
   *
   * 探测本身用极轻量的 siteinfo 查询，且复用已有的双通道 `wikimediaJson`
   * （直连 + v6 代理并行取首个非空），所以"不可达"也能在 3s 内判定，
   * 而不是等完整搜索链跑完的 10~12s。
   */
  private async wikiImagesReachable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.wikiImagesProbedAt < WIKI_IMAGES_PROBE_TTL_MS) {
      return this.wikiImagesReachableCache;
    }
    this.wikiImagesProbedAt = now;
    const probe = await this.wikimediaJson(
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&meta=siteinfo',
      WIKI_IMAGES_PROBE_TIMEOUT_MS,
    );
    this.wikiImagesReachableCache = probe != null;
    console.log(
      this.wikiImagesReachableCache
        ? '[ImageSearch] Wikimedia 可达，兜底源已启用（10 分钟内复用该结论）'
        : '[ImageSearch] Wikimedia 不可达，配图仅走可达源（10 分钟内不再探测）',
    );
    return this.wikiImagesReachableCache;
  }

  /**
   * 获取 POI 的真实图片（多重地理+名称校验，确保图片对应真实地点）
   *
   * 三阶段策略（从最准确到兜底）：
   * 1. **Wikimedia geosearch**：在 POI 坐标 1km 范围内搜索带图片的 Wiki 实体
   *    → 准确度最高（按地理位置过滤）
   * 2. **Wikimedia 文本搜索 + 名称匹配**：搜 "POI名 + 城市" 再校验图片元数据
   *    → 兜底策略，确保热门 POI 也能找到
   * 3. **过滤规则**：
   *    - 最小尺寸 640x480（排除图标/标记/小图）
   *    - 文件名黑名单：map、icon、logo、flag、pin、marker、symbol、svg
   *    - 名称白名单：必须包含 POI 名关键词（中文或英文/拼音）
   *    - GPS 校验（如有 EXIF GPS，必须在 POI 50km 范围内）
   */
  private async fetchRealImages(poiName: string, type: string, lat?: number, lon?: number): Promise<string[]> {
    if (!poiName) return [];

    const MIN_WIDTH = WIKI_MIN_WIDTH;
    const MIN_HEIGHT = WIKI_MIN_HEIGHT;
    const MAX_RADIUS_KM = WIKI_GPS_MAX_RADIUS_KM;
    const poiNameClean = poiName.replace(/[()（）·•・]/g, '').trim();
    const poiNameHasCJK = /[\u4e00-\u9fa5]/.test(poiNameClean);

    const isBlocked = (filename: string): boolean =>
      WIKI_BLOCKED_PATTERNS.some(p => p.test(filename));

    /**
     * 计算字符串相似度（基于字符集合重合度）
     */
    const similarity = (a: string, b: string): number => {
      if (!a || !b) return 0;
      const setA = new Set(a.toLowerCase().replace(/\s+/g, ''));
      const setB = new Set(b.toLowerCase().replace(/\s+/g, ''));
      let intersect = 0;
      setA.forEach(c => { if (setB.has(c)) intersect++; });
      return intersect / Math.max(setA.size, setB.size);
    };

    /**
     * 从图片信息中提取名称关键词
     */
    const extractNameFromTitle = (title: string): string => {
      return title
        .replace(/^File:/i, '')
        .replace(/\.(jpg|jpeg|png|webp|gif|svg)$/i, '')
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    /**
     * 校验图片元数据是否符合 POI
     * [fromGeo] 候选来自 geosearch（已按坐标 1.5km 锚定地点）：中文 POI 名 vs
     * 拉丁文件名的字符集相似度恒为 0——那是跨语言，不是不匹配；此时跳过名称
     * 门槛（GPS 校验仍然兜底）。文本搜索候选无坐标锚定，维持严格名称校验。
     */
    const validateImage = (imageinfo: any, fileTitle: string, fromGeo = false): boolean => {
      const filename = fileTitle.replace(/^File:/i, '');

      // 1. 名称黑名单
      if (isBlocked(filename)) return false;

      // 2. 尺寸过滤
      const w = imageinfo?.width || 0;
      const h = imageinfo?.height || 0;
      if (w > 0 && h > 0 && (w < MIN_WIDTH || h < MIN_HEIGHT)) return false;

      // 3. 名称相似度（至少 30% 字符重合；地理候选跨语言时豁免）
      const nameInTitle = extractNameFromTitle(fileTitle);
      const sim = similarity(poiNameClean, nameInTitle);
      const titleHasCJK = /[\u4e00-\u9fa5]/.test(nameInTitle);
      const crossLanguage = poiNameHasCJK && !titleHasCJK;
      if (sim < 0.3 && !(fromGeo && crossLanguage)) return false;

      // 4. EXIF GPS 校验（如有，必须在 50km 内）
      if (lat !== undefined && lon !== undefined && imageinfo?.metadata) {
        const meta = Array.isArray(imageinfo.metadata) ? imageinfo.metadata : [];
        // Wikimedia 返回的 metadata 数组里可能包含 GPS 字段
        const gpsLat = parseFloat(String(meta.find((m: any) => m?.name === 'GPSLatitude')?.value || 'NaN'));
        const gpsLon = parseFloat(String(meta.find((m: any) => m?.name === 'GPSLongitude')?.value || 'NaN'));
        if (!isNaN(gpsLat) && !isNaN(gpsLon)) {
          const dist = this.haversineKm(lat, lon, gpsLat, gpsLon);
          if (dist > MAX_RADIUS_KM) {
            console.log(`[ImageFilter] 拒绝: ${filename} (GPS距离${dist.toFixed(1)}km超限)`);
            return false;
          }
        }
      }

      return true;
    };

    try {
      // ===== 阶段0：可达源优先（实测连通性决定顺序，不是"哪个源更权威"）=====
      // Wikimedia 在本机网络下每次都要白等 10~12s 超时，放前面等于让每个 POI
      // 先付一轮罚金；必应图片实测 0.55s。宿主注入的搜索端口优先于内置抓取。
      const reachable = await this.fetchReachableImages(poiName, imageQualifierFor(type, poiName));
      if (reachable.length > 0) return reachable;

      // Wikimedia 是兜底源：不可达时直接跳过，别让每个 POI 都先付一轮超时罚金
      if (!(await this.wikiImagesReachable())) {
        console.log(`[ImageSearch] ${poiName}: 跳过 Wikimedia（本机网络不可达）`);
        return [];
      }

      // ===== 阶段1：Wikimedia geosearch（按坐标）=====
      // geosearch 返回的是百科「条目」标题，需先取条目配图清单得到 File: 标题，
      // 再查 Commons imageinfo（旧实现把条目标题直接当 Commons File 查，必然落空）
      if (lat !== undefined && lon !== undefined) {
        const geoResults = await this.wikimediaGeosearch(poiName, lat, lon, 1500);
        if (geoResults.length > 0) {
          console.log(`[ImageSearch] ${poiName}: geosearch命中${geoResults.length}个实体`);
          const validImages = await this.fetchImagesFromWikiArticles(
            geoResults,
            (info, title) => validateImage(info, title, true),
          );
          if (validImages.length >= 2) return validImages;
          // 不够则继续尝试
          if (validImages.length === 1) {
            const stage2 = await this.wikimediaTextSearch(poiName, lat, lon, validateImage);
            return [...validImages, ...stage2].slice(0, 4);
          }
        }
      }

      // ===== 阶段2：Wikimedia 文本搜索 + 坐标校验 =====
      const textResults = await this.wikimediaTextSearch(poiName, lat, lon, validateImage);
      if (textResults.length > 0) return textResults;

      // 阶段3 全部失败，返回空数组（前端将回退到地标通用图）
      console.log(`[ImageSearch] ${poiName}: 未找到匹配的真实图片`);
      return [];
    } catch (err) {
      console.warn(`[ImageSearch] ${poiName} 失败:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * 维基百科条目 → 条目配图（两段式）：
   * en.wikipedia prop=images 取条目内 File: 清单 → Commons imageinfo 取真实 URL。
   * 图片经过过滤器初筛（旗帜/地图/站点图标等全站共用文件不进入校验）。
   */
  private async fetchImagesFromWikiArticles(
    articleTitles: string[],
    validate?: (info: any, fileTitle: string) => boolean,
  ): Promise<string[]> {
    if (articleTitles.length === 0) return [];
    const fileTitles: string[] = [];
    const params = new URLSearchParams({
      action: 'query',
      titles: articleTitles.slice(0, 10).join('|'),
      prop: 'images',
      imlimit: '40',
      format: 'json',
      origin: '*',
    });
    const data = await this.wikimediaJson(`https://en.wikipedia.org/w/api.php?${params.toString()}`, 5000) as {
      query?: { pages?: Record<string, { images?: Array<{ title: string }> }> };
    } | null;
    if (!data) return [];
    {
      const pages = data.query?.pages || {};
      for (const pageId in pages) {
        for (const img of pages[pageId]?.images ?? []) {
          const title = img.title;
          if (!title || !/^File:/i.test(title)) continue;
          const lower = title.toLowerCase();
          if (
            /flag|map|icon|logo|symbol|coat[_-]?of[_-]?arms|locator|pictogram|edit-?|ambox|question_book|padlock|commons-logo|wikipedia|wikivoyage|wikidata|osm|notice/.test(lower)
          ) {
            continue;
          }
          if (!fileTitles.includes(title)) fileTitles.push(title);
        }
      }
    }
    if (fileTitles.length === 0) return [];
    return await this.fetchImageUrlsByTitles(fileTitles, validate);
  }

  /** 封面解析总截止：候选池（并行）+ 预排序 + VLM 终审共用（各阶段按剩余预算竞速） */
  private static readonly COVER_DEADLINE_MS = 15_000;

  /** VLM 终审单次看图选优的独立超时（与候选池预算分开计） */
  private static readonly COVER_VLM_TIMEOUT_MS = 12_000;

  /**
   * Wikimedia/Wikidata API 取 JSON：默认出口与 IPv6 定向两路并发，任一路先
   * 拿到合法 JSON 即用（默认出口结果优先）。原因：国内网络 IPv4 出口到
   * Wikimedia 常被重置或静默丢包（实测 ECONNRESET ~11s / 无响应），而
   * 移动/联通 IPv6 出口可达（实测 <1s）；Node fetch 默认解析走不通，等它
   * 失败再串行重试会把延迟翻倍。两路都落空返回 null，调用方按「未命中」处理。
   */
  private async wikimediaJson(urlStr: string, timeoutMs: number): Promise<any | null> {
    const winner = await this.firstNonNull([
      this.wikimediaFetchJson(urlStr, timeoutMs),
      this.wikimediaV6Json(urlStr, timeoutMs),
    ]);
    return winner ?? null;
  }

  /** 任一路先拿到非空 JSON 即胜出；全部落空返回 undefined（各路按契约不 reject） */
  private async firstNonNull(ps: Array<Promise<any | null>>): Promise<any | null | undefined> {
    return new Promise((resolve) => {
      let pending = ps.length;
      let settled = false;
      for (const p of ps) {
        p.then((v) => {
          if (settled) return;
          if (v != null) {
            settled = true;
            resolve(v);
          } else if (--pending === 0) {
            settled = true;
            resolve(undefined);
          }
        });
      }
    });
  }

  /** 默认网络栈的 fetch：网络层失败（超时/重置/拒连）或 HTTP ≥400 返回 null */
  private async wikimediaFetchJson(urlStr: string, timeoutMs: number): Promise<any | null> {
    try {
      const res = await fetch(urlStr, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** IPv6 定向请求（node:https，family=6）：主机无 IPv6 记录或网络不通时快速失败返回 null */
  private wikimediaV6Json(urlStr: string, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      let u: URL;
      try {
        u = new URL(urlStr);
      } catch {
        return resolve(null);
      }
      const req = https.request(
        {
          host: u.hostname,
          family: 6,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              if ((res.statusCode ?? 500) >= 400) return resolve(null);
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /**
   * 目的地代表性封面解析（行程卡海报区背景的唯一数据源）。
   *
   * 2026-09-28 选图升级（用户反馈「背景图选择太随意」：维基条目主图给大理
   * 选了张街道全景）：从「第一个来源命中即用」改为「多候选池 + 预排序 +
   * 视觉模型终审」。
   *
   * 候选池（并行、预算内竞速）：
   *   a. zh/en.wikipedia 条目主图（pageimages）；
   *   b. Wikidata P18 图像；
   *   c. 目的地中心地理锚定实拍 + Commons 文本搜索（fetchDestinationCover）；
   *   d. 风景向文本搜索（「{目的地}风景」/「{目的地} scenery」）——百科主图
   *      常是行政区划条目的街景/行政区图，风景向查询直接把洱海/古城类照片
   *      拉进候选池。
   * 全链路经 WIKI_BLOCKED_PATTERNS（旗/图/徽标/地图不进）+ 最小尺寸过滤。
   *
   * 终审两段：
   *   1. 关键词预排序（scoreCoverCandidate：湖/山/古城/塔加分，街道/道路减分）；
   *   2. 视觉模型终审（主模型支持视觉时，取预排序前 5 张看图选出最具旅游
   *      代表性的一张；不可用/超时/失败静默回退预排序第一）。
   *
   * 结果落 destinationCoverStore（30 天 TTL），重复规划零网络开销；换图时
   * 旧 URL 登记升级映射（markSuperseded/registerCoverDir），历史卡片自动换新。
   * 失败返回 undefined——宁可让海报走渐变兜底，不放与目的地不符的占位图。
   */
  /** 迁移失败备忘（进程内）：每个目的地的存量远程封面只尝试迁移一次，失败不再重试拖慢请求路径 */
  private coverMigrationFailed = new Set<string>();

  /**
   * 强制刷新目的地封面（管理端）：驱逐缓存 → 走完整解析链（候选池含网搜
   * 风景源 + VLM 终审）重选 → 新旧不同时登记升级映射。历史卡片烤死的旧
   * URL 经 /travel/media/assets 与 /travel/media/remote 出口的升级映射自动
   * 换发新封面；客户端海报另会活取当前封面，磁盘缓存也不会钉死旧图。
   * 解析失败返回 url: undefined（不回写旧值，下次规划自然重试）。
   */
  async refreshDestinationCover(
    destName: string,
    center?: Coordinates,
    attractionNames: string[] = [],
  ): Promise<{ url?: string; changed: boolean }> {
    const stale = destinationCoverStore.peek(destName);
    destinationCoverStore.evict(destName);
    const url = await this.resolveDestinationCover(destName, center, attractionNames);
    // 驱逐后 resolveDestinationCover 内部看不到旧图，升级映射在此登记
    if (url && stale && stale.url !== url) {
      destinationCoverStore.markSuperseded(destName, stale.url);
    }
    return { url, changed: !!url && !!stale && stale.url !== url };
  }

  private async resolveDestinationCover(
    destName: string,
    center: Coordinates | undefined,
    attractionNames: string[] = [],
  ): Promise<string | undefined> {
    const cached = destinationCoverStore.get(destName);
    if (cached) {
      // 已是本机 assets 路径 → 直接用
      if (cached.url.startsWith('/travel/media/assets/')) return cached.url;
      // 存量远程 URL（wikimedia）在客户端网络不可直连（Flutter 不走系统代理）
      // → 迁移落盘为本机路径；失败记入备忘不再重试（2026-09-28 抓取通道已修为
      //   双路竞速，正常一次即成），本进程内后续命中直接回远程原 URL
      if (this.coverMigrationFailed.has(destName)) return cached.url;
      const migrated = await travelMediaStore.saveRemoteAsset(`dest-cover-${destName}`, cached.url, 8_000);
      if (migrated) {
        destinationCoverStore.registerCoverDir(destName, migrated);
        // 迁移即换图：旧远程 URL 登记升级映射（存量卡片烤的远程缩略 URL 走
        // 代理时被改发当前封面）
        destinationCoverStore.markSuperseded(destName, cached.url);
        destinationCoverStore.set(destName, { url: migrated, source: cached.source });
        console.log(`[ImageSearch] 目的地封面「${destName}」: 远程封面已落盘本地 (${migrated})`);
        return migrated;
      }
      this.coverMigrationFailed.add(destName);
      return cached.url;
    }
    // 被 TTL 淘汰的旧封面仍在历史卡片里烤着：换图前取出，供升级映射登记
    const stale = destinationCoverStore.peek(destName);
    const t0 = Date.now();
    try {
      // ===== 阶段1：候选池（并行，预算内竞速）=====
      const pool = await this.collectCoverCandidates(destName, center, attractionNames, () =>
        PlanningService.COVER_DEADLINE_MS - (Date.now() - t0));
      if (pool.urls.length === 0) return undefined;

      // ===== 阶段2：关键词预排序 =====
      const ranked = [...pool.urls].sort(
        (a, b) => scoreCoverCandidate(b) - scoreCoverCandidate(a),
      );
      // 视觉终审名单：预排序前 6 + 网搜风景候选补位（网搜 URL 多为 CDN 缩略
      // 地址，文件名无关键词可打分，预排序排名天然吃亏；不补位就进不了
      // VLM 视野，终审选不出真正的风景照）。上限 8 张控制看图开销。
      const review = ranked.slice(0, 6);
      for (const u of pool.webHits) {
        if (review.length >= 8) break;
        if (!review.includes(u)) review.push(u);
      }

      // ===== 阶段3：视觉模型终审（不可用/失败回退预排序第一）=====
      let winner = ranked[0]!;
      let source: DestinationCoverSource = 'wikimedia';
      const vlmPick = await this.rankCoverWithVlm(destName, review);
      if (vlmPick) {
        winner = vlmPick;
        source = 'vlm-pick';
      }

      const local = await travelMediaStore.saveRemoteAsset(`dest-cover-${destName}`, winner, 8_000);
      const url = local ?? winner;
      if (!local) this.coverMigrationFailed.add(destName);
      if (local) destinationCoverStore.registerCoverDir(destName, local);
      // 旧封面（含 TTL 淘汰的）与本次不同的 → 登记升级映射，历史卡片自动换新
      if (stale && stale.url !== url) destinationCoverStore.markSuperseded(destName, stale.url);
      destinationCoverStore.set(destName, { url, source });
      console.log(
        `[ImageSearch] 目的地封面「${destName}」: 候选 ${pool.urls.length} 张（网搜风景 ${pool.webHits.length}）` +
        `${vlmPick ? '，VLM 终审选出' : '，关键词预排序首推'} ${local ? '(已落盘本地)' : '(远程)'} (${Date.now() - t0}ms)`,
      );
      return url;
    } catch (err) {
      console.warn(`[ImageSearch] 目的地封面「${destName}」解析失败:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  /**
   * 封面候选池：百科主图（zh/en 全收）+ Wikidata P18 + 地理锚定/文本搜索 +
   * 风景向搜索 + 网搜风景（search-api/必应），全部并行发起，各自带独立超时
   * （慢源不拖垮快源），去重后截断到 maxCandidates。
   *
   * 返回 urls（候选池，招牌景点与网搜风景优先桶在前）与 webHits（网搜风景
   * 命中——供视觉终审名单补位，见 resolveDestinationCover）。
   */
  private async collectCoverCandidates(
    destName: string,
    center: Coordinates | undefined,
    attractionNames: string[],
    remaining: () => number,
    maxCandidates = 10,
  ): Promise<{ urls: string[]; webHits: string[] }> {
    const clean = destName.replace(/[（(].*?[)）]/g, '').trim() || destName;
    const plausible: (info: any, title: string) => boolean = (info, title) =>
      this.isPlausibleWikiPhoto(info, title);
    // 行程招牌景点名搜索（2026-09-28 用户反馈「大理应该是洱海」）：目的地级
    // 搜索词（「大理 风景」）在 Commons 命中质量不稳定，而行程排序前几的
    // 景点名（洱海/崇圣寺三塔）搜出来的必然是该景点本身——这是把「用户要的
    // 画面」确定性拉进候选池的最短路径。
    const attractionTasks: Array<Promise<string[]>> = [
      // 网搜风景候选（2026-10-15「贵阳封面是张灰暗岩刻」）：Wikimedia 家族对
      // 国内目的地常只有行政区划/岩刻/街景类照片，风景覆盖率低；上游图片
      // 搜索按「{目的地} 风景」拿到的必然是旅游风景照，与招牌景点同级进
      // 优先桶。URL 无 host 限制风险：终选封面经 saveRemoteAsset 落盘本机，
      // 客户端只接触本机资产路径。
      this.coverWebSearchCandidates(clean),
      ...attractionNames
        .filter((n) => n && n.trim() && n.trim() !== clean)
        .slice(0, 3)
        .map((name) => this.wikimediaTextSearch(name.trim(), undefined, undefined, plausible).then((u) => u.slice(0, 2))),
    ];
    const tasks: Array<Promise<string[]>> = [
      this.wikipediaLeadImages(destName),
      this.wikidataLeadImage(destName).then((u) => (u ? [u] : [])),
      this.fetchDestinationCover(destName, center),
      // 条目内配图（en 大理市条目里有洱海/崇圣寺三塔类形象照，常优于条目主图）
      this.fetchImagesFromWikiArticles([clean, `${clean} City`].filter(Boolean), plausible),
      // 风景向文本搜索：无景点名可用时的泛化兜底（有招牌景点名时冗余且浪费节流预算）
      ...(attractionNames.length > 0
        ? []
        : [
            this.wikimediaTextSearch(`${clean} 风景`, undefined, undefined, plausible).then((u) => u.slice(0, 3)),
            this.wikimediaTextSearch(`${clean} scenery`, undefined, undefined, plausible).then((u) => u.slice(0, 3)),
          ]),
      ...attractionTasks,
    ];
    // 网搜风景任务在 attractionTasks[0]（tasks 中的下标据此推算）
    const webSearchIdx = tasks.length - attractionTasks.length;
    // 错峰起跑（每路 +300ms）：Wikimedia 对同 IP 并发突发节流（实测 9 路齐发
    // 全被掐空、单发正常），串行化起跑换取稳定返回
    const settled = await Promise.allSettled(
      tasks.map((p, i) =>
        this.raceDeadline(
          i === 0 ? p : new Promise<string[]>((resolve) => setTimeout(() => resolve(p as Promise<string[]>), i * 300)),
          Math.max(2_000, remaining()),
        ),
      ),
    );
    // 景点名搜到的图与网搜风景排池首（与目的地强锚定，保证进入 VLM 视野
    // 前 6），其余来源按原顺序跟随，去重后截断
    const attractionResults: string[][] = [];
    const otherResults: string[][] = [];
    let webHits: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!;
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      if (i === webSearchIdx) {
        webHits = r.value;
        // 网搜风景与招牌景点同级进优先桶（attractionResults 排池首）；
        // webHits 另行记录供终审名单补位。曾漏 push 进桶——Wikimedia 不可达
        // 时池子直接空掉，封面刷新恒返 undefined（2026-10-15 探针实证）。
        if (r.value.length > 0) attractionResults.push(r.value);
        continue;
      }
      const bucket = i > webSearchIdx ? attractionResults : otherResults;
      bucket.push(r.value);
    }
    const pool: string[] = [];
    const seen = new Set<string>();
    for (const list of [...attractionResults, ...otherResults]) {
      for (const url of list) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        pool.push(url);
      }
    }
    const urls = pool.slice(0, maxCandidates);
    const seenUrls = new Set(urls);
    return {
      urls,
      // 网搜风景里被截断挤掉的也要记录（终审补位名单只收最终池内的 URL）
      webHits: webHits.filter((u) => seenUrls.has(u)),
    };
  }

  /**
   * 网搜风景候选（2026-10-15）：封面候选池的网搜补充源。宿主注入的图片
   * 搜索端口优先（search-api/上游聚合），无结果回退内置必应直抓；两组查询
   * 词串行补量，上限 6 张。返回空数组表示无结果，绝不抛出。
   */
  private async coverWebSearchCandidates(destName: string): Promise<string[]> {
    const queries = [`${destName} 风景`, `${destName} 旅游`];
    const out: string[] = [];
    for (const q of queries) {
      if (out.length >= 6) break;
      // 端口结果统一过滤（图库水印站拦掉 + 去重）
      const pushable = (u: unknown): u is string =>
        typeof u === 'string' && /^https?:/i.test(u)
        && !isStockWatermarkHost(u) && !out.includes(u);
      // 端口优先但限时 4.5s 竞速（上游搜索 API 慢/挂起不让整链陪葬）；
      // 必应兜底按「过滤后为空」而非「原始为空」判定——端口返回纯图库
      // 水印站时全被拦掉，曾硬吃空结果致生产池子空转（贵阳实证）
      let portUrls: string[] = [];
      if (this.imageSearch) {
        portUrls = await Promise.race([
          this.imageSearch.searchImages(q, 6).catch(() => [] as string[]),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4_500)),
        ]) ?? [];
      }
      let urls: string[] = portUrls.filter(pushable);
      if (urls.length === 0) {
        try {
          urls = (await this.fetchBingImages(q, 6)).filter(pushable);
        } catch { urls = []; }
      }
      out.push(...urls);
    }
    return out.slice(0, 6);
  }

  /**
   * 封面候选字节加载（终审看图用）：本地资产直读；远程 URL 走
   * resolveOrFetchRemote 双路下载+磁盘缓存（普通 fetch 在国内 IPv4 出口到
   * wikimedia 全超时——caption 服务 loadImageBytes 的 plain fetch 正因此
   * 拿不到候选图导致终审静默跳过，2026-09-28 改走双路）。
   * 返回压缩后的 base64（宽 ≤640），任何一步失败返回 null。
   */
  private async loadCoverBytes(url: string): Promise<{ base64: string; mime: string } | null> {
    try {
      let buf: Buffer;
      let mime = 'image/jpeg';
      const local = url.match(/^\/travel\/media\/assets\/([^/]+)\/([^/]+)$/);
      if (local) {
        const full = travelMediaStore.resolveAssetPath(local[1]!, local[2]!);
        if (!full) return null;
        buf = await fs.promises.readFile(full);
      } else if (/^https?:\/\//i.test(url)) {
        const hit = await travelMediaStore.resolveOrFetchRemote(url, 15_000);
        if (!hit) return null;
        buf = await fs.promises.readFile(hit.file);
        mime = hit.mime;
      } else {
        return null;
      }
      if (buf.length === 0) return null;
      const compressed = await compressImage(buf, mime);
      return compressed ?? { base64: buf.toString('base64'), mime };
    } catch {
      return null;
    }
  }

  /**
   * 视觉模型终审：把候选封面按顺序看图，选出最适合做「{目的地}」旅游行程卡
   * 封面的一张。主模型不支持视觉/未配置/超时/失败一律返回 null（调用方回退
   * 关键词预排序结果）。整体失败绝不抛出。
   *
   * 这道闸是选图质量的最终保证：Commons 文本搜索存在同名污染（如「大理」
   * 命中画家 Salvador Dalí 的作品），关键词打分器识别不了这类语义错误，
   * 只有看图才能拒掉。
   */
  private async rankCoverWithVlm(destName: string, urls: string[]): Promise<string | null> {
    if (urls.length < 2) return null;
    // 终审通道：主模型有视觉能力直用；无视觉（当前 MiniMax-M3，主链终审恒
    // 缺席——贵阳封面水印图漏网根因之一）降级 SiliconFlow Qwen2.5-VL 侧车，
    // 复用既有 SILICONFLOW_API_KEY（TRAVEL_COVER_VLM_MODEL 可换型号）。
    // 两路都不可用才回退关键词预排序。
    const cfg = resolvePrimaryLlmClientConfig();
    let apiKey = '';
    let baseURL = '';
    let model = '';
    let mainModel = false;
    if (cfg?.apiKey && cfg.model && modelSupportsVision(cfg.model)) {
      apiKey = cfg.apiKey;
      baseURL = cfg.baseURL;
      model = cfg.model;
      mainModel = true;
    } else if (process.env.SILICONFLOW_API_KEY?.trim()) {
      apiKey = process.env.SILICONFLOW_API_KEY.trim();
      baseURL = COVER_VLM_SIDECAR_BASE_URL;
      model = COVER_VLM_SIDECAR_MODEL;
    }
    if (!apiKey || !baseURL || !model) return null;
    try {
      // 并行取字节（串行 6 张曾把终审拖到 15s+）；有一张拿不到就无法保证
      // 序号对齐，整批放弃——曾静默 return null，闸悄悄失效无人知，留痕
      const bytes = await Promise.all(urls.map((u) => this.loadCoverBytes(u)));
      const images: Array<{ base64: string; mime: string }> = [];
      for (let i = 0; i < bytes.length; i++) {
        const img = bytes[i];
        if (!img) {
          console.info(`[ImageSearch] 封面终审放弃: 候选 ${i + 1} 字节加载失败 ${urls[i]}`);
          return null;
        }
        images.push(img);
      }
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        {
          type: 'text',
          text:
            `以下是 ${images.length} 张「${destName}」的候选封面照片（按顺序编号 1~${images.length}）。` +
            '请为旅游行程卡选出最佳封面：最能代表目的地旅游形象（地标/自然风光/城市天际线），构图美观、画面干净；' +
            '排除普通街景、行政区照片、特写人像、室内、杂乱场景，以及画面中带水印/站标/署名文字的图片。',
        },
        ...images.map((img) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${img.mime};base64,${img.base64}` },
        })),
      ];
      const client = new OpenAI({
        apiKey,
        baseURL,
        timeout: PlanningService.COVER_VLM_TIMEOUT_MS,
        maxRetries: 0,
      });
      const resp = await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              '你是旅游内容选图师。用户给出候选照片和目的地名，你只输出 JSON：' +
              '{"best": 序号}。序号是 1 起始的整数，必须是给出的候选之一；不要输出任何其他文字。',
          },
          { role: 'user', content },
        ],
        temperature: 0.2,
        // 思考特性附加参数只对主模型生效（provider 档案表按主模型声明）；
        // SF 侧车是 OpenAI 兼容端点，多余参数可能 400
        ...(mainModel ? bypassChatRequestExtras() : {}),
      });
      const raw = (resp.choices?.[0]?.message?.content ?? '').trim();
      const m = raw.match(/"best"\s*:\s*(\d+)/);
      if (!m) {
        console.info(`[ImageSearch] 封面终审无有效输出（回退预排序）: ${raw.slice(0, 120) || '(空)'}`);
        return null;
      }
      const idx = Number(m[1]) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= urls.length) {
        console.info(`[ImageSearch] 封面终审序号越界（回退预排序）: ${m[1]}`);
        return null;
      }
      return urls[idx]!;
    } catch (err) {
      console.info(
        `[ImageSearch] 封面终审失败（回退预排序）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 在 ms 毫秒预算内竞速：超时返回 null（底层请求留给 AbortSignal 自行收尾） */
  private async raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
    if (ms <= 500) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 维基百科条目主图（prop=pageimages）：百科为条目选定的代表性照片。
   * zh/en 两库并行查询（zh 命中优先——与用户语言一致；重定向自动跟随，
   * 「杭州市」也能命中「杭州」条目）；文件名过黑名单（旗/图/徽标），
   * 返回 1200px 缩略图（海报展示尺寸，避免原图数 MB 的加载开销）。
   */
  private async wikipediaLeadImage(destName: string): Promise<string | null> {
    const both = await this.wikipediaLeadImages(destName);
    return both[0] ?? null;
  }

  /** 双库条目主图全收（封面候选池用）：zh/en 各自的主图都进池，供预排序+终审挑选 */
  private async wikipediaLeadImages(destName: string): Promise<string[]> {
    const clean = destName.replace(/[（(].*?[)）]/g, '').trim();
    if (!clean) return [];
    const attempts = await Promise.allSettled(
      ['zh.wikipedia.org', 'en.wikipedia.org'].map((host) => this.pageImageThumb(host, clean)),
    );
    const urls: string[] = [];
    for (const r of attempts) {
      if (r.status === 'fulfilled' && r.value && !urls.includes(r.value)) urls.push(r.value);
    }
    return urls;
  }

  /** 单库 pageimages 查询：返回条目主图 1200px 缩略图，未命中/出错返回 null */
  private async pageImageThumb(host: string, title: string): Promise<string | null> {    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      redirects: '1',
      prop: 'pageimages',
      piprop: 'thumbnail|name',
      pithumbsize: '1200',
      format: 'json',
      origin: '*',
    });
    const data = await this.wikimediaJson(`https://${host}/w/api.php?${params.toString()}`, 4000) as {
      query?: { pages?: Record<string, { pageimage?: string; thumbnail?: { source?: string; width?: number; height?: number } }> };
    } | null;
    if (!data) return null;
    for (const page of Object.values(data.query?.pages || {})) {
      const fileTitle = page.pageimage;
      const thumb = page.thumbnail;
      if (!fileTitle || !thumb?.source) continue;
      if (WIKI_BLOCKED_PATTERNS.some((p) => p.test(fileTitle))) continue;
      // 主图过小（低于条目配图门槛）多为杂项插图而非形象照，弃用
      const w = thumb.width || 0;
      if (w > 0 && w < WIKI_MIN_WIDTH) continue;
      return thumb.source;
    }
    return null;
  }

  /**
   * Wikidata P18「图像」：维基数据给实体登记的代表性图片（与百科条目主图
   * 同源）。zhwiki/enwiki 两站并行查实体；P18 只是文件名，真实 URL 与尺寸
   * 校验走 Commons imageinfo（1200px 缩略图）。国内网络 wikipedia 主站常被
   * 阻断而 wikidata/commons 可达，此层是「百科形象照」在该环境下的主通道。
   *
   * 注意 wbgetentities 不跟重定向，且中文条目名常带行政后缀（杭州→杭州市、
   * 东京→东京都），故按「原名/市/都/县」变体批量查；用户给的名字本身可能
   * 就是完整条目名（千岛湖/故宫），原名永远在候选里。
   */
  private async wikidataLeadImage(destName: string): Promise<string | null> {
    const clean = destName.replace(/[（(].*?[)）]/g, '').trim();
    if (!clean) return null;
    const zhVariants = Array.from(new Set([clean, `${clean}市`, `${clean}都`, `${clean}县`])).join('|');
    const fetchP18 = async (site: string, titles: string): Promise<string | null> => {
      const params = new URLSearchParams({
        action: 'wbgetentities',
        sites: site,
        titles,
        props: 'claims',
        format: 'json',
        origin: '*',
      });
      const data = await this.wikimediaJson(`https://www.wikidata.org/w/api.php?${params.toString()}`, 4000) as {
        entities?: Record<string, { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> }>;
      } | null;
      if (!data) return null;
      for (const entity of Object.values(data.entities || {})) {
        // 未命中的标题返回 -1 行（无 claims），自然跳过
        const raw = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const file = raw.trim().replace(/^File:/i, '');
        if (!file || WIKI_BLOCKED_PATTERNS.some((p) => p.test(file))) continue;
        const urls = await this.fetchImageUrlsByTitles([`File:${file}`], (info) => {
          const w = info?.width || 0;
          const h = info?.height || 0;
          if (w > 0 && h > 0 && (w < WIKI_MIN_WIDTH || h < WIKI_MIN_HEIGHT)) return false;
          return true;
        });
        if (urls.length > 0) return urls[0]!;
      }
      return null;
    };
    const attempts = await Promise.allSettled([
      fetchP18('zhwiki', zhVariants),
      fetchP18('enwiki', clean),
    ]);
    for (const r of attempts) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return null;
  }

  /**
   * 宽松照片校验（封面/POI 共用）：黑名单（旗/图/徽标/地图）+ 文件类型 +
   * 最小尺寸。文件类型闸拒绝 PDF/DJVU/SVG 等文档渲染页（Commons 文本搜索
   * 常把「规划.pdf」一类文件当图片返回，其 imageinfo 有尺寸、能骗过旧闸）。
   */
  private isPlausibleWikiPhoto(info: any, fileTitle: string): boolean {
    const filename = fileTitle.replace(/^File:/i, '');
    if (WIKI_BLOCKED_PATTERNS.some(p => p.test(filename))) return false;
    // 文档/非照片类型：PDF、SVG 矢量、DJVU、音频视频、图纸
    if (/\.(pdf|djvu|svg|tif|tiff|webm|ogv|oga|mid|wav|mp3|xcf)$/i.test(filename)) return false;
    // Commons 文档缩略 URL 形如 .../page1-960px-xxx.pdf.jpg，扩展名伪装成 jpg
    if (/page\d+-\d+px-.*\.(pdf|djvu)/i.test(filename)) return false;
    const w = info?.width || 0;
    const h = info?.height || 0;
    if (w > 0 && h > 0 && (w < WIKI_MIN_WIDTH || h < WIKI_MIN_HEIGHT)) return false;
    return true;
  }

  /**
   * 目的地封面：以目的地中心为锚的宽松抓取（条目配图优先，Commons 文本搜索兜底）。
   * 仅做 黑名单 + 最小尺寸 过滤——候选已地理锚定，且常为跨语言名称，不做名称相似度门槛。
   * 供 resolveDestinationCover 的第 3 优先级（百科形象照未命中时的实拍兜底）。
   */
  private async fetchDestinationCover(destName: string, center?: Coordinates): Promise<string[]> {
    if (!center) return [];
    const t0 = Date.now();
    const permissive: (info: any, fileTitle: string) => boolean = (info, fileTitle) =>
      this.isPlausibleWikiPhoto(info, fileTitle);
    try {
      // 文本搜索与地理搜索并发起跑：地理链路（en.wikipedia geosearch → 条目配图）
      // 在 wikipedia 主站被阻断的网络里要耗满超时，串行等待会把文本搜索挤出
      // 截止预算；地理结果命中时优先用（坐标锚定更强），否则用文本结果。
      const textPromise = this.wikimediaTextSearch(destName, center.latitude, center.longitude, permissive);
      let images: string[] = [];
      const articles = await this.wikimediaGeosearch(destName, center.latitude, center.longitude, 8000);
      if (articles.length > 0) {
        images = await this.fetchImagesFromWikiArticles(articles, permissive);
      }
      if (images.length === 0) {
        images = await textPromise;
      }
      console.log(
        `[ImageSearch] 目的地封面「${destName}」: ${images.length} 张 (${Date.now() - t0}ms)`,
      );
      return images.slice(0, 6);
    } catch (err) {
      console.warn(`[ImageSearch] 目的地封面「${destName}」失败:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Wikimedia 地理搜索：返回指定坐标 1.5km 范围内的所有 Wiki 条目标题
   */
  private async wikimediaGeosearch(poiName: string, lat: number, lon: number, radiusMeters: number = 1500): Promise<string[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=${radiusMeters}&gslimit=10&format=json&origin=*`;
    const data = await this.wikimediaJson(url, 4000) as { query?: { geosearch?: Array<{ title: string }> } } | null;
    if (!data) return [];
    return (data.query?.geosearch || []).map(g => g.title);
  }

  /**
   * Wikimedia 文本搜索：搜索 "POI名"，返回匹配的图片文件名
   */
  private async wikimediaTextSearch(poiName: string, lat?: number, lon?: number, validate?: (img: any, title: string) => boolean): Promise<string[]> {
    const query = encodeURIComponent(poiName);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${query}&srnamespace=6&srlimit=20&format=json&origin=*`;
    const data = await this.wikimediaJson(url, 5000) as { query?: { search?: Array<{ title: string }> } } | null;
    if (!data) return [];
    const titles = (data.query?.search || []).map(s => s.title);
    return await this.fetchImageUrlsByTitles(titles, validate);
  }

  /**
   * 批量获取多个文件名的真实图片URL（带尺寸+元数据过滤）
   */
  private async fetchImageUrlsByTitles(titles: string[], validate?: (img: any, title: string) => boolean): Promise<string[]> {
    if (titles.length === 0) return [];
    const validUrl = validate || (() => true);

    // Wikimedia API 一次最多50个 title
    const chunks: string[][] = [];
    for (let i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));

    const imageUrls: string[] = [];
    for (const chunk of chunks) {
      const params = new URLSearchParams({
        action: 'query',
        titles: chunk.join('|'),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: '1200',
        format: 'json',
        origin: '*',
      });
      const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
      const data = await this.wikimediaJson(url, 5000) as {
        query?: { pages?: Record<string, { title: string; imageinfo?: Array<any> }> }
      } | null;
      if (!data) continue;
      {
        const pages = data.query?.pages || {};
        for (const pageId in pages) {
          const page = pages[pageId];
          if (!page?.imageinfo?.[0]) continue;
          const info = page.imageinfo[0];
          const thumbUrl = info.thumburl || info.url;
          if (!thumbUrl) continue;
          if (validUrl(info, page.title)) {
            imageUrls.push(thumbUrl);
            if (imageUrls.length >= 5) return imageUrls;
          }
        }
      }
    }
    return imageUrls;
  }

  private generateDescription(poi: Pick<RawPOI, 'name'> & Partial<Pick<RawPOI, 'tags' | 'rating' | 'address'>>, type: string, prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string {
    const tags = poi.tags || [];
    const tagStr = tags.slice(0, 3).join('、');

    // 防御：如果 poi.name 异常长（> 25字，可能包含用户输入）则截断显示
    const safeName = poi.name && poi.name.length <= 25
      ? poi.name
      : (poi.name ? poi.name.slice(0, 20) + '...' : '该地点');

    switch (type) {
      case 'attraction': {
        const base = `${safeName}是当地热门景点${tagStr ? `，属于${tagStr}类别` : ''}，风景优美，值得专程前往游览。`;
        if (prefs.activities) return `${base}本次行程优先为你安排体验型游玩项目，建议预留充足时间。`;
        return base;
      }
      case 'hotel': {
        const notes: string[] = [];
        if (prefs.seaside) notes.push('近海/海景');
        if (prefs.pool) notes.push('自带泳池');
        if (prefs.kids) notes.push('亲子设施齐全');
        if (prefs.elderly) notes.push('无障碍/安静');
        const noteStr = notes.length ? `，匹配你提到的${notes.join('、')}` : '';
        return `${safeName}位置便利，设施齐全${noteStr}，是当地受欢迎的住宿选择。`;
      }
      case 'restaurant': {
        const cuisine = prefs.cuisine ? `主打${prefs.cuisine}` : '本地风味';
        return `${safeName}是当地知名美食地点，${cuisine}，深受食客喜爱。`;
      }
      default:
        return `${safeName}，值得一去的好地方。`;
    }
  }

  private generateTags(type: string, rating: number, prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string[] {
    const tags: string[] = [];
    if (type === 'attraction') {
      tags.push('热门景点', '必打卡');
      if (prefs.activities) tags.push('游玩项目');
      if (prefs.seaside) tags.push('海景相关');
      if (prefs.kids) tags.push('亲子推荐');
      if (rating >= 4.6) tags.push('高评分推荐');
    } else if (type === 'hotel') {
      tags.push('优质住宿');
      if (prefs.seaside) tags.push('海景房');
      if (prefs.pool) tags.push('自带泳池');
      if (prefs.kids) tags.push('亲子友好');
      if (prefs.elderly) tags.push('适老');
      if (prefs.hotelTier === 'luxury') tags.push('豪华');
      else if (prefs.hotelTier === 'budget') tags.push('经济实惠');
      if (rating >= 4.6) tags.push('高评分推荐');
    } else if (type === 'restaurant') {
      tags.push('美食推荐');
      if (prefs.cuisine) tags.push(prefs.cuisine);
      if (rating >= 4.6) tags.push('高分必吃');
    }
    return tags;
  }

  /**
   * 兼容旧接口：仅给免费/付费标记。所有真实价格由 PricingService 提供
   */
  private inferPrice(type: string, poi: RawPOI): string {
    if (type === 'attraction') {
      const hasFee = poi.tags?.some(t =>
        t.includes('fee') || t.includes('ticket') || t.includes('paid')
      );
      return hasFee ? '需门票' : '免费';
    }
    // 酒店/餐厅的真实价格 + 优惠统一在 convertToItem 里通过 PricingService 计算
    return '请以实时报价为准';
  }

  private parseCost(priceStr: string | undefined | null): number | null {
    if (!priceStr) return null;
    const m = priceStr.match(/(\d+)/);
    return m && m[1] ? parseInt(m[1]) : null;
  }

  private inferCategory(tags: string[], prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string {
    if (tags.some(t => /park|garden|nature|beach|water|mountain|volcano/.test(t))) {
      return prefs.seaside ? '海岛自然风光' : '自然风光';
    }
    if (tags.some(t => /museum|church|temple|castle|monument|memorial|historic/.test(t))) return '历史文化';
    if (tags.some(t => /mall|shop|market|amusement|theme_park|zoo/.test(t))) return '休闲娱乐';
    return '综合景点';
  }

  private inferCuisine(tags: string[], name: string): string {
    if (tags.some(t => /chinese|asian|japanese|korean|italian|french|thai|indian|mexican/.test(t))) {
      const match = tags.find(t => /chinese|asian|japanese|korean|italian|french|thai|indian|mexican/.test(t));
      if (match) return match.charAt(0).toUpperCase() + match.slice(1);
    }
    return '本地特色';
  }
}
