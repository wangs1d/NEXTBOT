/**
 * 域注册表（DomainRegistry）——工具归属的唯一事实源（2026-10-01 S0 统一）。
 *
 * 此前工具归属散在三张表：lane-tool-sets.CAPABILITY_TOOL_PREFIXES（束投影）、
 * resolve-chat-tools.CAPABILITY_TOOL_PREFIXES（delegate 裁剪的私有副本）、
 * 本文件 TOOL_CATEGORIES（域推断）——同一问题三个答案。现收敛为本表一个答案，
 * 三个消费点：束投影（路由预载）、域卡（能力面展示）、域拉取（tool_discover
 * 按域确定性取族）。
 *
 * 等价性约束（test/domain-registry.test.ts 锁定）：search/media/write/desktop
 * 四束的域投影结果 ⊇ 旧前缀表结果（search 束有意识的超集 = internet.* 归入）。
 * 无前缀命中的工具落 misc 兜底域（卡片仍可见，测试限制 misc 规模防堆积）。
 */

export type DomainDef = {
  /** 域唯一标识 */
  name: string;
  /** 卡片面一句话摘要（域卡/域拉取结果共用） */
  summary: string;
  /** 匹配该域工具的 registryName 前缀（startsWith 语义） */
  prefixes: string[];
  /** 多归属：除 prefix 匹配外额外归属此域的工具注册名 */
  secondaryTools: string[];
};

/** 兼容旧引用（域推断/词表消费方） */
export type ToolCategoryDef = DomainDef;

export const DOMAIN_REGISTRY: DomainDef[] = [
  {
    name: "search",
    summary: "联网检索/深读网页/热搜榜/情报核实",
    prefixes: ["search", "fetch_web", "deep_search", "hot_rankings", "info.", "internet."],
    secondaryTools: [],
  },
  {
    name: "weather",
    summary: "天气/气温/预报",
    prefixes: ["weather."],
    secondaryTools: [],
  },
  {
    name: "clock",
    summary: "时间/日期/位置",
    prefixes: ["clock."],
    secondaryTools: [],
  },
  {
    name: "media",
    summary: "找图/找视频/壁纸/摄像头画面",
    prefixes: ["photo", "vision.", "media", "image"],
    secondaryTools: ["search_images", "search_images_batch", "search_videos", "video.grab"],
  },
  {
    name: "calendar",
    summary: "日程/会议/待办的创建与查询",
    prefixes: ["calendar."],
    secondaryTools: ["reminder.plan"],
  },
  {
    name: "reminder",
    summary: "提醒/闹钟/定时通知",
    prefixes: ["reminder."],
    secondaryTools: ["phone.call_user"],
  },
  {
    name: "commitment",
    summary: "承诺管理（记下答应的事/兑现追踪）",
    prefixes: ["commitment."],
    secondaryTools: [],
  },
  {
    name: "geofence",
    summary: "位置围栏（到家/离家触发提醒）",
    prefixes: ["geofence."],
    secondaryTools: [],
  },
  {
    name: "care",
    summary: "长期关怀（重要日期/节奏习惯）",
    prefixes: ["care."],
    secondaryTools: [],
  },
  {
    name: "message",
    summary: "消息读取与回复（微信/QQ/飞书/短信/邮件，含代发建议）",
    prefixes: ["messages."],
    secondaryTools: [],
  },
  {
    name: "email",
    summary: "邮件/短信主动发送（收件由邮件盯件自动进消息中心）",
    prefixes: ["email.", "sms."],
    secondaryTools: [],
  },
  {
    name: "phone",
    summary: "电话/短信/号码管理",
    prefixes: ["phone."],
    secondaryTools: [],
  },
  {
    name: "voice",
    summary: "语音合成/转写/语音消息",
    prefixes: ["voice."],
    secondaryTools: [],
  },
  {
    name: "wallet",
    summary: "钱包/支付/账单/转账",
    prefixes: ["wallet.", "payment.", "alipay."],
    secondaryTools: [
      "budget.calculate",
      "payment.create_order",
      "payment.query_order",
      "alipay.check-wallet",
      "alipay.apply-wallet",
      "alipay.submit-payment",
      "alipay.query-payment",
      "alipay.pay-402",
      "alipay.proxy-trade",
      "alipay.merchant-list",
      "alipay.merchant-order",
    ],
  },
  {
    name: "budget",
    summary: "预算/费用测算",
    prefixes: ["budget."],
    secondaryTools: [],
  },
  {
    name: "shopping",
    summary: "购物推荐/比价",
    prefixes: ["shopping."],
    secondaryTools: [],
  },
  {
    name: "wechat",
    summary: "微信接入（扫码登录/连接状态）",
    prefixes: ["wechat."],
    secondaryTools: [],
  },
  {
    name: "smart_home",
    summary: "智能家居控制（灯/空调/窗帘/插座）",
    prefixes: ["smart_home."],
    secondaryTools: [],
  },
  {
    name: "device",
    summary: "设备状态与控制",
    prefixes: ["device."],
    secondaryTools: [],
  },
  {
    name: "surface",
    summary: "桌面浮层展示（召唤/收起悬浮卡）",
    prefixes: ["surface."],
    secondaryTools: [],
  },
  {
    name: "embodiment",
    summary: "桌面化身移动/窗口定位",
    prefixes: ["embodiment."],
    secondaryTools: [],
  },
  {
    name: "desktop",
    summary: "桌面自动化（开应用/截图/UIA操作/shell）",
    prefixes: ["desktop", "agent_browser", "shared_browser", "screen"],
    secondaryTools: ["browser.session.list"],
  },
  {
    name: "browser",
    summary: "浏览器会话/网页导航",
    prefixes: ["browser."],
    secondaryTools: ["fetch_web", "search_web"],
  },
  {
    name: "agent",
    summary: "智能体自我与跨agent协作（注册/能力查询）",
    prefixes: ["agent."],
    secondaryTools: [],
  },
  {
    name: "proactivity",
    summary: "主动性反馈（确认/解释/校准）",
    prefixes: ["proactivity."],
    secondaryTools: [],
  },
  {
    name: "interest",
    summary: "关注点管理（追踪人物/话题动态）",
    prefixes: ["interest."],
    secondaryTools: [],
  },
  {
    name: "self",
    summary: "自我能力（自定义技能创建/分析/进化）",
    prefixes: ["self."],
    secondaryTools: [],
  },
  {
    name: "world",
    summary: "Agent World 注册/房间/好友联络（world.link.*）",
    prefixes: ["world."],
    secondaryTools: [],
  },
  {
    name: "aip",
    summary: "AIP 协议分发",
    prefixes: ["aip."],
    secondaryTools: [],
  },
  {
    name: "travel",
    summary: "行程规划/POI/路线/目的地信息（技能注册，生产环境可见）",
    prefixes: ["travel."],
    secondaryTools: [],
  },
  {
    name: "code",
    summary: "代码沙箱（运行/读写文件，生产环境可见）",
    prefixes: ["code."],
    secondaryTools: [],
  },
  {
    name: "misc",
    summary: "其他工具",
    prefixes: [],
    secondaryTools: [],
  },
];

/** 兼容旧引用 */
export const TOOL_CATEGORIES: ToolCategoryDef[] = DOMAIN_REGISTRY;

/**
 * 派生域摘要表（2026-10-10 根修配套）：技能族/长尾域不手工登记进 DOMAIN_REGISTRY，
 * 而是由注册名前缀自动成域（见 derivedDomainForTool），此表只负责给这些域一句
 * 可读摘要。缺省时用通用文案，不影响域可用性。
 *
 * 为什么需要它：历史上每个新技能族都要手工往 DOMAIN_REGISTRY 加域/加 secondaryTools
 * ——travel 加了、alipay 加了、habit/booking/picture/finance/virtual-phone/agentworld
 * 忘了加，六族全落 misc（实测 misc 35 个 > 域卡 14 上限 → 21 个工具从能力面消失、
 * 按域 tool_discover 返回「未知能力域」、L1 域预载整族漏召）。逐族补白名单="打地鼠"，
 * 正解是「前缀即域」的确定性派生 + 本表补可读性。
 */
export const DERIVED_DOMAIN_SUMMARIES: Record<string, string> = {
  habit: "习惯养成（打卡/规律提醒/习惯清单）",
  booking: "预订下单（机票/酒店/门票的支付与出票）",
  picture: "照片/图库（生成/美化/整理/回忆）",
  finance: "记账与账单导入（邮箱/文本账单接入）",
  "virtual-phone": "虚拟手机号（申请/状态查询）",
  agentworld: "Agent World 身份（注册/改名/验证）",
};

/** 桥接元工具：不参与任何域归属（可见性由 prepareTools 控制） */
const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_discover", "tool_describe", "tool_call"]);

/**
 * 前缀派生域（2026-10-10 根修）：注册表显式前缀都没命中时，取注册名的首段
 * （`.` 之前）作为该工具的域——技能族工具（habit.create-rule → habit）与长尾
 * 工具（video.find → video）因此自动成域，不必手工登记。无点号名返回 null。
 *
 * 确定性：纯字符串切分，同注册名恒同结果。
 */
export function derivedDomainForTool(registryName: string): string | null {
  const idx = registryName.indexOf(".");
  if (idx <= 0) return null;
  return registryName.slice(0, idx);
}

/**
 * 工具的域归属（≥1 个）。桥工具返回空。
 *
 * 解析顺序（2026-10-10 起）：
 *   1. DOMAIN_REGISTRY 显式前缀 / secondaryTools 命中 → 用显式域（语义最准）；
 *   2. 未命中但注册名含 `.` → 首段作派生域（技能族/长尾域自动可见，根治手工白名单漂移）；
 *   3. 其余（无点号无名）→ misc 兜底。
 *
 * 确定性：同注册名恒同结果（域卡/域拉取/束投影共用）。
 */
export function domainsForTool(registryName: string): string[] {
  if (BRIDGE_TOOL_NAMES.has(registryName)) return [];
  const result: string[] = [];
  for (const def of DOMAIN_REGISTRY) {
    if (def.prefixes.some((p) => registryName.startsWith(p)) || def.secondaryTools.includes(registryName)) {
      result.push(def.name);
    }
  }
  if (result.length > 0) return result;
  const derived = derivedDomainForTool(registryName);
  return derived ? [derived] : ["misc"];
}

/** 显式域定义查找（DOMAIN_REGISTRY 内）。 */
export function domainDefByName(name: string): DomainDef | undefined {
  return DOMAIN_REGISTRY.find((d) => d.name === name);
}

/** 是否 DOMAIN_REGISTRY 显式登记的域（false = 前缀派生的技能族/长尾域；misc 属显式）。 */
export function isExplicitDomain(name: string): boolean {
  return DOMAIN_REGISTRY.some((d) => d.name === name);
}

/**
 * 域定义解析（含派生域）：显式域优先返回注册表定义；否则合成一个派生域定义
 * （summary 取自 DERIVED_DOMAIN_SUMMARIES 或通用文案，前缀 = `<域>.`）。
 *
 * 消费方：tool_discover 按域拉取（域拉取/域卡用同一份定义，防口径漂移）。
 * 注意：域是否**可用**由「目录里是否有该域成员」裁定（见 handlers），
 * 本函数只负责「有没有这个域的形状」，不保证域非空。
 */
export function resolveDomainDef(name: string): DomainDef {
  const explicit = domainDefByName(name);
  if (explicit) return explicit;
  return {
    name,
    summary: DERIVED_DOMAIN_SUMMARIES[name] ?? `扩展能力（${name}）`,
    prefixes: [`${name}.`],
    secondaryTools: [],
  };
}

/**
 * 路由能力束 → 域集合（束投影=预载的域全族）。
 * 等价性（相对旧前缀表）：media/write/desktop 精确等价；search 为有意识超集
 * （internet.* 归入检索域——realtime 轮可用情报核实工具，质量增益）。
 */
export const ROUTE_BEAM_DOMAINS: Record<string, string[]> = {
  search: ["search", "weather", "clock"],
  media: ["media"],
  write: [
    "calendar",
    "reminder",
    "voice",
    "phone",
    "shopping",
    "commitment",
    "wallet",
    "agent",
    "surface",
    "smart_home",
  ],
  desktop: ["desktop"],
  full: [],
};

/** 域全族工具（注册表序内按语料序，确定性）。 */
export function toolsInDomain<T extends { type: string; function?: { name?: string } }>(
  corpus: T[],
  domain: string,
): T[] {
  return corpus.filter((t) => {
    const name = t.type === "function" ? t.function?.name ?? "" : "";
    return Boolean(name) && domainsForTool(name).includes(domain);
  });
}

/** 工具是否归属任一束域（束投影/delegate 裁剪共用的判定原语）。 */
export function toolInCapabilityDomains(registryName: string, capabilities: string[]): boolean {
  if (capabilities.includes("full")) return false;
  const wanted = new Set(capabilities.flatMap((cap) => ROUTE_BEAM_DOMAINS[cap] ?? []));
  if (wanted.size === 0) return false;
  return domainsForTool(registryName).some((d) => wanted.has(d));
}

/** 兼容旧消费方（adaptive-catalog 域推断仍以词表为输入）。 */
export function getEntryCategoryNames(
  registryName: string,
  categoryDefs: ToolCategoryDef[],
): string[] {
  const result: string[] = [];
  for (const cat of categoryDefs) {
    if (cat.prefixes.some((p) => registryName.startsWith(p))) {
      result.push(cat.name);
    }
    if (cat.secondaryTools.includes(registryName) && !result.includes(cat.name)) {
      result.push(cat.name);
    }
  }
  return result;
}
