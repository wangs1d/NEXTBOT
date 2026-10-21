import type { ActionKind, FeatureClass, LifeDomain, RiskLevel, TriggerKind } from "./types.js";
import { LIFE_DOMAINS } from "./types.js";

/**
 * 分类映射表（纯函数，零依赖 —— 可被 AgentTaskSafety / 习惯闭环 / 测试直接用）。
 *
 * 匹配顺序：exact 全名 → prefix 前缀（最长优先）→ 域默认值兜底。
 * 未命中任何规则的名单独暴露（FeatureCatalog 启动校验 warn），避免新能力静默漏分类。
 */

/** 各生活域的默认分类（规则未声明的维度从这里补）。 */
const DOMAIN_DEFAULTS: Record<LifeDomain, { action: ActionKind; risk: RiskLevel }> = {
  travel: { action: "query", risk: "read" },
  dining: { action: "query", risk: "read" },
  home: { action: "manage", risk: "write" },
  finance: { action: "query", risk: "read" },
  health: { action: "query", risk: "read" },
  social: { action: "communicate", risk: "write" },
  media: { action: "execute", risk: "write" },
  learning: { action: "manage", risk: "write" },
  work: { action: "manage", risk: "write" },
  comms: { action: "communicate", risk: "write" },
  self: { action: "manage", risk: "write" },
  system: { action: "query", risk: "read" },
};

interface ClassRule {
  exact?: string;
  prefix?: string;
  domain: LifeDomain;
  action?: ActionKind;
  trigger?: TriggerKind;
  risk?: RiskLevel;
}

/**
 * 分类规则表。
 *
 * 维护约定：新能力落地时在这里补一行；顺序无关（匹配时 exact 优先、
 * prefix 按长度降序），注释带场景。
 */
const RULES: ClassRule[] = [
  // ── travel 出行 ──
  { exact: "booking.travel-pay", domain: "travel", action: "book", risk: "spend" },
  { exact: "booking.travel-pay-check", domain: "travel", action: "query", risk: "read" },
  { exact: "booking.travel-issue", domain: "travel", action: "manage", risk: "write" },
  { exact: "travel.arrival-monitor", domain: "travel", action: "manage", trigger: "proactive", risk: "write" },
  { exact: "travel.arrival-status", domain: "travel", action: "query", risk: "read" },
  { exact: "travel.pickup-set", domain: "travel", action: "manage", risk: "write" },
  { exact: "travel.pickup-send", domain: "travel", action: "communicate", risk: "outbound" },
  { exact: "travel.arrival-ride", domain: "travel", action: "book", risk: "spend" },
  { exact: "travel_booking.search", domain: "travel", action: "query", risk: "read" },
  { exact: "travel_booking.book", domain: "travel", action: "book", risk: "spend" },
  { exact: "travel_booking.status", domain: "travel", action: "query", risk: "read" },
  { exact: "travel_booking.cancel", domain: "travel", action: "manage", risk: "write" },
  { exact: "travel_booking.refund", domain: "travel", action: "manage", risk: "write" },
  { exact: "ride_hailing.book", domain: "travel", action: "book", risk: "spend" },
  { prefix: "ride_hailing.", domain: "travel" },
  { exact: "meituan.create_order", domain: "dining", action: "book", risk: "spend" },
  { prefix: "geofence", domain: "travel", action: "manage", trigger: "event", risk: "write" },
  { prefix: "weather.", domain: "travel" },
  { prefix: "travel.", domain: "travel" },
  // ── dining 餐饮 ──
  { prefix: "restaurant.", domain: "dining" },
  { exact: "restaurant.book", domain: "dining", action: "book", risk: "spend" },
  { prefix: "meituan.", domain: "dining" },
  // ── home 居家 ──
  { prefix: "home_service.", domain: "home" },
  { exact: "home_service.book", domain: "home", action: "book", risk: "spend" },
  { prefix: "smart_home", domain: "home", action: "execute", risk: "write" },
  { prefix: "device.", domain: "home" },
  // ── finance 财务 ──
  { exact: "alipay.submit-payment", domain: "finance", action: "book", risk: "spend" },
  { exact: "alipay.pay-402", domain: "finance", action: "book", risk: "spend" },
  { exact: "alipay.proxy-trade", domain: "finance", action: "book", risk: "spend" },
  { exact: "alipay.query-payment", domain: "finance", action: "query", risk: "read" },
  { prefix: "alipay.", domain: "finance" },
  { exact: "wallet.transfer", domain: "finance", action: "book", risk: "spend" },
  { exact: "wallet.purchase", domain: "finance", action: "book", risk: "spend" },
  { exact: "wallet.recharge", domain: "finance", action: "book", risk: "spend" },
  { prefix: "wallet.", domain: "finance" },
  // 查支付方式/查订单是只读，exact 前置；家族前缀默认 spend
  { exact: "payment.list_methods", domain: "finance", action: "query", risk: "read" },
  { exact: "payment.query_order", domain: "finance", action: "query", risk: "read" },
  { prefix: "payment.", domain: "finance", action: "book", risk: "spend" },
  { exact: "shopping.order.place", domain: "finance", action: "book", risk: "spend" },
  { exact: "shopping.pay.submit", domain: "finance", action: "book", risk: "spend" },
  { exact: "shopping.pay.check", domain: "finance", action: "query", risk: "read" },
  { prefix: "shopping.", domain: "finance" },
  { prefix: "finance.", domain: "finance" },
  { prefix: "subscription", domain: "finance", action: "query", risk: "read" },
  // ── health 健康 ──
  { prefix: "health.", domain: "health" },
  // ── social 社交 ──
  // 拉时间线/搜帖是只读，必须 exact 前置；落进家族默认 outbound 会触发高危确认闸
  { exact: "social.get_feed", domain: "social", action: "query", risk: "read" },
  { exact: "social.search_posts", domain: "social", action: "query", risk: "read" },
  { prefix: "social.", domain: "social", action: "communicate", risk: "outbound" },
  { exact: "email.send", domain: "social", action: "communicate", risk: "outbound" },
  { exact: "sms.send", domain: "social", action: "communicate", risk: "outbound" },
  { prefix: "email.", domain: "social" },
  { prefix: "sms.", domain: "social" },
  { prefix: "message", domain: "social" },
  // 微信接入：扫码登录/查连接状态都是用户在环的轻操作，按只读处理
  { prefix: "wechat.", domain: "social", action: "query", risk: "read" },
  { prefix: "friend.", domain: "self", action: "manage", risk: "write" },
  // ── media 娱乐 ──
  { prefix: "media.", domain: "media" },
  { prefix: "image.", domain: "media" },
  { prefix: "video", domain: "media" },
  { prefix: "search_image", domain: "media", action: "query", risk: "read" },
  // ── learning 学习 ──
  { exact: "notes.search", domain: "learning", action: "query", risk: "read" },
  { exact: "notes.list", domain: "learning", action: "query", risk: "read" },
  { prefix: "notes.", domain: "learning" },
  { prefix: "internet.research", domain: "learning", action: "query", risk: "read" },
  // ── work 生产力 ──
  { prefix: "calendar.", domain: "work" },
  { prefix: "reminder", domain: "work", trigger: "scheduled" },
  { prefix: "care", domain: "work", trigger: "scheduled" },
  { prefix: "commitment", domain: "work" },
  { exact: "file.write_text", domain: "work", action: "execute", risk: "write" },
  { prefix: "file.", domain: "work", action: "query", risk: "read" },
  { prefix: "code.", domain: "work", action: "execute", risk: "write" },
  { prefix: "desktop.", domain: "work", action: "execute", risk: "write" },
  { prefix: "agent_browser.", domain: "work", action: "execute", risk: "write" },
  { prefix: "shared_browser.", domain: "work", action: "execute", risk: "write" },
  // ── comms 通讯触达 ──
  // phone.call_user：Agent 打给用户本人的站内 App 来电（无话费、不触第三方），
  // 属 App 内触达（同 surface/notification 档），不是「外发第三方」——错标 outbound
  // 会被 brain 安全门当高危拦死且聊天车道无确认出口，功能整体不可用（2026-10-04 真链探针实证）。
  { exact: "phone.call_user", domain: "comms", action: "communicate", risk: "write" },
  { prefix: "phone.", domain: "comms" },
  // virtual* 仅有号码申领/状态/解析三个管理类 skill（无真实外发），同上不属 outbound
  { prefix: "virtual", domain: "comms", action: "communicate", risk: "write" },
  { prefix: "voice.", domain: "comms", action: "execute" },
  { prefix: "rhythm-reminder", domain: "comms", trigger: "scheduled" },
  { prefix: "schedule-user-reply", domain: "comms" },
  { exact: "surface", domain: "comms", action: "communicate", risk: "write" },
  { prefix: "surface.", domain: "comms", action: "communicate", risk: "write" },
  { prefix: "notification", domain: "comms", action: "communicate", risk: "write" },
  // ── self 自身 ──
  { exact: "memory.invalid", domain: "self", action: "manage", risk: "write" },
  { prefix: "memory.", domain: "self", action: "query", risk: "read" },
  { exact: "brain.recall", domain: "self", action: "query", risk: "read" },
  { exact: "brain.remember", domain: "self", action: "manage", risk: "write" },
  { prefix: "brain.", domain: "self" },
  { prefix: "self.", domain: "self", action: "execute", risk: "write" },
  { prefix: "skill.", domain: "self" },
  { prefix: "habit.", domain: "self", action: "automate" },
  { prefix: "world.", domain: "self" },
  { prefix: "agentworld.", domain: "self" },
  { prefix: "aip", domain: "self" },
  { prefix: "agent.", domain: "self" },
  { prefix: "master_invoke_sub_agent", domain: "self", action: "execute", risk: "write" },
  { prefix: "body.", domain: "self", action: "execute", risk: "write" },
  { prefix: "embodiment", domain: "self", action: "execute", risk: "write" },
  { prefix: "task-dispatch", domain: "self", trigger: "event" },
  { prefix: "proactivity", domain: "self", trigger: "event" },
  { prefix: "market-signal", domain: "self", trigger: "event", action: "query" },
  { prefix: "life-signal", domain: "self", trigger: "event", action: "query" },
  // ── system 系统基础 ──
  { prefix: "clock.", domain: "system", action: "query", risk: "read" },
  { prefix: "search", domain: "system", action: "query", risk: "read" },
  { exact: "fetch_web", domain: "system", action: "query", risk: "read" },
  { prefix: "fetch_web", domain: "system", action: "query", risk: "read" },
  { prefix: "upstream", domain: "system", action: "query", risk: "read" },
  { exact: "tool_discover", domain: "system", action: "manage", risk: "system" },

  { prefix: "hot_rankings", domain: "system", action: "query", risk: "read" },
];

/** MCP server alias → 生活域（MCP 工具名形如 mcp.<alias>.<tool>）。 */
const MCP_ALIAS_DOMAINS: Record<string, LifeDomain> = {
  didi: "travel",
  yby6: "media",
};

/** 系统兜底分类（未命中任何规则；FeatureCatalog 会把这类名单独 warn 出来）。 */
export const FALLBACK_CLASS: FeatureClass = {
  domain: "system",
  action: "query",
  trigger: "chat",
  risk: "read",
};

/** 是否命中过映射规则（false = 走了兜底，调用方应提示补表）。 */
export function isClassifiedByRule(name: string): boolean {
  return matchRule(name) != null;
}

/** 纯名称分类：exact → 最长前缀 → 兜底。 */
export function classifyFeatureByName(name: string): FeatureClass {
  const rule = matchRule(name);
  if (!rule) return { ...FALLBACK_CLASS };
  const defaults = DOMAIN_DEFAULTS[rule.domain];
  return {
    domain: rule.domain,
    action: rule.action ?? defaults.action,
    trigger: rule.trigger ?? "chat",
    risk: rule.risk ?? defaults.risk,
  };
}

/** MCP 工具分类（按 server alias；未登记 alias 落 system）。 */
export function classifyMcpTool(name: string, serverAlias: string): FeatureClass {
  const domain = MCP_ALIAS_DOMAINS[serverAlias] ?? "system";
  const defaults = DOMAIN_DEFAULTS[domain];
  return { domain, action: defaults.action, trigger: "chat", risk: defaults.risk };
}

function matchRule(name: string): ClassRule | null {
  const n = name.trim();
  if (!n) return null;
  // exact 优先
  for (const rule of RULES) {
    if (rule.exact === n) return rule;
  }
  // 最长前缀优先
  let best: ClassRule | null = null;
  let bestLen = 0;
  for (const rule of RULES) {
    if (!rule.prefix) continue;
    if (n.startsWith(rule.prefix) && rule.prefix.length > bestLen) {
      best = rule;
      bestLen = rule.prefix.length;
    }
  }
  return best;
}

// --------------------------------------------------------------------- //
// tool-search 意图规则生成（合并进 intent-metadata 的 BM25 调权）
// --------------------------------------------------------------------- //

/** 各生活域的检索提示词（生成 ToolIntentRule 的 aliases）。 */
const DOMAIN_SEARCH_HINTS: Record<LifeDomain, string[]> = {
  travel: ["travel", "trip", "flight", "train", "hotel", "出行", "旅游", "行程", "订票", "机票", "高铁", "酒店", "接站", "接机", "打车", "天气"],
  dining: ["restaurant", "takeout", "errand", "餐厅", "订座", "外卖", "跑腿", "美食"],
  home: ["home service", "smart home", "device", "家政", "保洁", "维修", "智能家居", "设备", "灯光", "空调"],
  finance: ["pay", "payment", "wallet", "billing", "shopping", "支付", "付款", "钱包", "转账", "记账", "账单", "购物", "下单", "比价"],
  health: ["health", "fitness", "健康", "运动", "体重", "睡眠", "体检"],
  social: ["email", "message", "social post", "邮件", "短信", "发消息", "朋友圈", "发帖", "微博"],
  media: ["music", "play", "image", "video", "音乐", "播放", "画图", "生图", "视频"],
  learning: ["notes", "research", "笔记", "总结", "复习", "研究", "调研"],
  work: ["calendar", "schedule", "file", "code", "desktop", "日程", "提醒", "文档", "代码", "电脑", "浏览器"],
  comms: ["call", "notify", "voice", "电话", "打给我", "语音", "播报", "通知", "提醒我"],
  self: ["memory", "habit", "profile", "world", "记忆", "记住", "习惯", "自动化", "画像", "自我"],
  system: ["time", "search web", "几点", "时间", "搜索", "查一下"],
};

/** 生成生活域级意图规则（prefix → 域检索词），供 setExtraIntentRules 合并。 */
export function buildCatalogIntentRules(): Array<{ prefix: string; metadata: { aliases: string[]; negativeAliases?: string[] } }> {
  const prefixByDomain = new Map<LifeDomain, Set<string>>();
  for (const rule of RULES) {
    if (!rule.prefix) continue;
    const set = prefixByDomain.get(rule.domain) ?? new Set<string>();
    set.add(rule.prefix);
    prefixByDomain.set(rule.domain, set);
  }
  const rules: Array<{ prefix: string; metadata: { aliases: string[] } }> = [];
  for (const domain of LIFE_DOMAINS) {
    const prefixes = [...(prefixByDomain.get(domain) ?? [])].sort((a, b) => b.length - a.length);
    // 每个域取最长的 3 条前缀生成规则，避免规则爆炸
    for (const prefix of prefixes.slice(0, 3)) {
      rules.push({ prefix, metadata: { aliases: DOMAIN_SEARCH_HINTS[domain] } });
    }
  }
  return rules;
}
