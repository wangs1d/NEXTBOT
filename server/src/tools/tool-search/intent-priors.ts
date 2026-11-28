import type { ResourceRecord } from "./registry/models.js";
import {
  DEFAULT_QUERY_CONSTRAINTS,
  type ParsedIntent,
  type QueryConstraints,
} from "./retrieval-intent.js";

export type RetrievalIntent = ParsedIntent & {
  domain_scores: Record<string, number>;
  capability_scores: Record<string, number>;
};

type IntentRule = {
  intent: string;
  pattern: RegExp;
  domains: Record<string, number>;
  capabilities?: Record<string, number>;
  confidence: number;
  read_only?: boolean;
};

const RULES: IntentRule[] = [
  {
    intent: "位置围栏触发",
    pattern: /到家|回到家|离家|离开家|离开公司|到公司的时候|到达.*(提醒|告诉我)|围栏/,
    domains: { geofence: 1 },
    confidence: 0.97,
  },
  {
    intent: "当前位置查询",
    pattern: /我现在|重新定位|我的位置|当前位置|我目前.*(在哪|位置)/,
    domains: { clock: 0.85, place: 0.15 },
    capabilities: { "clock.get_user_location": 1 },
    confidence: 0.97,
    read_only: true,
  },
  {
    intent: "常用地点管理",
    pattern: /我家|我住在哪|公司在哪|收藏的地方|常去的地方|记住我家|那是我家|忘掉我的家/,
    domains: { place: 1 },
    confidence: 0.96,
  },
  {
    intent: "附近地点搜索",
    pattern: /附近|周边/,
    domains: { geo: 0.8, place: 0.2 },
    capabilities: { "geo.place_search": 1 },
    confidence: 0.94,
    read_only: true,
  },
  {
    intent: "地点距离查询",
    pattern: /相距多远|距离多远|隔多远|有多远|几公里|多远/,
    domains: { geo: 0.85, travel: 0.15 },
    capabilities: { "geo.distance": 1 },
    confidence: 0.96,
    read_only: true,
  },
  {
    intent: "本地天气查询",
    pattern: /天气|下雨|下雪|冷不冷|热不热|带伞|气温|室外温度|外边.*(冷|热)/,
    domains: { weather: 1 },
    capabilities: { "weather.get_local": 1 },
    confidence: 0.97,
    read_only: true,
  },
  {
    intent: "网页正文读取",
    pattern: /网页|网址|链接|页面.*(正文|内容)|提取.*页面/,
    domains: { search: 0.55, browser: 0.45 },
    capabilities: { "search.fetch": 1 },
    confidence: 0.94,
    read_only: true,
  },
  {
    intent: "热搜查询",
    pattern: /热搜|热榜|热点|大家都在看/,
    domains: { search: 1 },
    capabilities: { "search.query": 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "联网搜索",
    pattern: /搜一下|搜索|查找|最新新闻|新闻/,
    domains: { search: 0.85, browser: 0.15 },
    capabilities: { "search.query": 1 },
    confidence: 0.9,
    read_only: true,
  },
  {
    intent: "价格与条件盯梢",
    pattern: /跌破|盯着.*(降息|股票|价格)|价格.*(降|通知)|降价.*(叫|告诉)|蹲.*降价/,
    domains: { watch: 1 },
    capabilities: { "watch.track": 1 },
    confidence: 0.96,
  },
  {
    intent: "兴趣关注管理",
    pattern: /我喜欢|不再关注|关注.*(手机|话题)|追更|关注点/,
    domains: { interest: 1 },
    capabilities: { "interest.manage": 1 },
    confidence: 0.93,
  },
  {
    intent: "个人资料与偏好",
    pattern: /记住我.*叫|以后叫我|不要超过|个人偏好|生活习惯/,
    domains: { life: 1 },
    capabilities: { "life.manage": 1 },
    confidence: 0.95,
  },
  {
    intent: "日程与提醒",
    pattern: /日程|会议|日历|闹钟|提醒我|定个.*提醒|有哪些安排|有什么安排|待办/,
    domains: { calendar: 1 },
    confidence: 0.93,
  },
  {
    intent: "主动任务查询",
    pattern: /主动任务|你.*设了.*任务|主动.*哪些|提议.*批准/,
    domains: { proactivity: 1 },
    capabilities: { "commitment.list": 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "财务账单查询",
    pattern: /花了多少|账单明细|记账|收支|消费记录/,
    domains: { finance: 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "钱包与支付",
    pattern: /钱包付款|支付授权|付款|余额/,
    domains: { wallet: 0.65, payment: 0.35 },
    confidence: 0.93,
  },
  {
    intent: "购物推荐",
    pattern: /推荐.*(耳机|手机|笔记本)|预算.*(挑|买)|买什么|性价比/,
    domains: { shopping: 1 },
    capabilities: { "shopping.suggest": 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "打车与行程",
    pattern: /打车|叫车|网约车|司机到哪|行程状态/,
    domains: { ride_hailing: 1 },
    confidence: 0.96,
  },
  {
    intent: "设备状态与画面",
    pattern: /摄像头|设备.*状态|有哪些设备|绑定设备/,
    domains: { device: 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "手机电量查询",
    pattern: /手机.*电/,
    domains: { phone: 1 },
    capabilities: { "phone.battery": 1 },
    confidence: 0.97,
    read_only: true,
  },
  {
    intent: "手机通知查询",
    pattern: /手机.*通知/,
    domains: { phone: 1 },
    capabilities: { "phone.notifications": 1 },
    confidence: 0.97,
    read_only: true,
  },
  {
    intent: "手机拍照",
    pattern: /手机.*拍/,
    domains: { phone: 1 },
    capabilities: { "phone.camera_capture": 1 },
    confidence: 0.97,
  },
  {
    intent: "手机通话",
    pattern: /打电话|通话/,
    domains: { phone: 1 },
    capabilities: { "phone.dial": 1 },
    confidence: 0.95,
  },
  {
    intent: "发送语音消息",
    pattern: /发.*语音消息|语音消息.*发/,
    domains: { voice: 1 },
    capabilities: { "voice.send_message": 1 },
    confidence: 0.97,
  },
  {
    intent: "语音播报",
    pattern: /用语音|语音跟我说|对我说|念给我听|读给我听|播报/,
    domains: { voice: 1 },
    capabilities: { "voice.speak": 1 },
    confidence: 0.96,
  },
  {
    intent: "发送短信",
    pattern: /发.*短信|短信.*(发送|发)/,
    domains: { phone: 0.7, email: 0.3 },
    capabilities: { "sms.send": 1 },
    confidence: 0.97,
  },
  {
    intent: "邮件查询",
    pattern: /新邮件|邮件/,
    domains: { email: 1 },
    capabilities: { "mail.recent": 1 },
    confidence: 0.94,
    read_only: true,
  },
  {
    intent: "浏览器登录态",
    pattern: /浏览器登录态|登录态/,
    domains: { browser: 1 },
    capabilities: { "browser.session.list": 1 },
    confidence: 0.95,
    read_only: true,
  },
  {
    intent: "好友通信",
    pattern: /好友.*(消息|申请)|给好友|回复好友|加好友/,
    domains: { world: 1 },
    capabilities: { "world.link": 1 },
    confidence: 0.95,
  },
  {
    intent: "助手能力查询",
    pattern: /你都能帮我做什么|你能做什么|你会什么|能力边界/,
    domains: { agent: 1 },
    confidence: 0.95,
    read_only: true,
  },
];

export function resolveRetrievalIntent(
  query: string,
  lexicalLeaders: Array<{ record: ResourceRecord; score: number }>,
): RetrievalIntent {
  const lexicalDomains = lexicalDomainPosterior(lexicalLeaders);
  const rule = RULES.find((candidate) => candidate.pattern.test(query));
  const lexicalConfidence = lexicalEvidenceConfidence(lexicalLeaders);
  const domainScores = rule
    ? normalizeScores(mergeScores(lexicalDomains, rule.domains, 0.25, 0.75))
    : lexicalDomains;
  const capabilityScores = normalizeScores(rule?.capabilities ?? {});
  const domainCandidates = rankedKeys(domainScores, 4, 0.02);
  const capabilityCandidates = rankedKeys(capabilityScores, 3, 0.02);
  const constraints: QueryConstraints = rule
    ? { ...DEFAULT_QUERY_CONSTRAINTS, read_only: rule.read_only ?? false }
    : DEFAULT_QUERY_CONSTRAINTS;

  return {
    intent: rule?.intent ?? query,
    domain_candidates: domainCandidates,
    primary_capability: capabilityCandidates[0] ?? (domainCandidates[0] ? `${domainCandidates[0]}.query` : ""),
    confidence: rule
      ? clamp(rule.confidence * 0.7 + lexicalConfidence * 0.3, 0.35, 0.97)
      : lexicalConfidence,
    query_constraints: constraints,
    param_extract: {},
    is_compound_task: false,
    sub_intents: [],
    domain_scores: domainScores,
    capability_scores: capabilityScores,
  };
}

function lexicalDomainPosterior(
  leaders: Array<{ record: ResourceRecord; score: number }>,
): Record<string, number> {
  const scores = new Map<string, number>();
  const total = leaders.reduce((sum, leader) => sum + Math.max(0, leader.score), 0);
  if (total <= 0) return {};
  for (const leader of leaders) {
    const domains = leader.record.level1.domain;
    if (domains.length === 0) continue;
    const share = Math.max(0, leader.score) / total / domains.length;
    for (const domain of domains) scores.set(domain, (scores.get(domain) ?? 0) + share);
  }
  return normalizeScores(Object.fromEntries(scores));
}

function lexicalEvidenceConfidence(
  leaders: Array<{ record: ResourceRecord; score: number }>,
): number {
  const first = leaders[0]?.score ?? 0;
  const second = leaders[1]?.score ?? 0;
  if (first <= 0) return 0.35;
  const margin = Math.max(0, (first - second) / first);
  const evidence = clamp(first / 0.7, 0, 1);
  return clamp(0.3 + evidence * 0.45 + margin * 0.25, 0.35, 0.97);
}

function mergeScores(
  first: Record<string, number>,
  second: Record<string, number>,
  firstWeight: number,
  secondWeight: number,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries(first)) merged[key] = (merged[key] ?? 0) + value * firstWeight;
  for (const [key, value] of Object.entries(second)) merged[key] = (merged[key] ?? 0) + value * secondWeight;
  return merged;
}

function normalizeScores(scores: Record<string, number>): Record<string, number> {
  const entries = Object.entries(scores).filter(([, value]) => Number.isFinite(value) && value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return {};
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

function rankedKeys(scores: Record<string, number>, limit: number, floor: number): string[] {
  return Object.entries(scores)
    .filter(([, value]) => value >= floor)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
