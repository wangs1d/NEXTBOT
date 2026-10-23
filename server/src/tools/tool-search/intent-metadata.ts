import { getDataDir } from "../../config/data-dir.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type ToolIntentMetadata = {
  aliases?: string[];
  negativeAliases?: string[];
  examples?: string[];
  negativeExamples?: string[];
};

type ToolIntentRule = {
  exact?: string;
  prefix?: string;
  metadata: ToolIntentMetadata;
};

export type { ToolIntentRule };

type ToolIntentMetadataFile = {
  rules?: ToolIntentRule[];
};

const DEFAULT_TOOL_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shopping.",
    metadata: {
      aliases: ["shopping", "buy", "compare prices", "product recommendation", "购物", "比价", "推荐商品"],
      negativeAliases: ["phone call", "desktop movement", "weather lookup"],
      examples: ["compare prices for headphones", "recommend a power bank for travel"],
      negativeExamples: ["call me later", "move the desktop avatar"],
    },
  },
  {
    exact: "shopping.suggest",
    metadata: {
      aliases: ["buy product", "shopping advice", "买东西", "商品推荐", "买什么", "买什么好", "性价比", "求推荐", "种草", "双十一买什么"],
      examples: ["help me pick a laptop under budget", "双十一买什么耳机性价比高", "预算五千买什么笔记本"],
      negativeExamples: ["what time is it now"],
    },
  },
  {
    prefix: "budget.",
    metadata: {
      aliases: ["budget", "cost estimate", "expense planning", "预算", "花费"],
      negativeAliases: ["desktop screenshot", "phone reminder"],
      examples: ["estimate my trip budget"],
    },
  },
  {
    prefix: "weather.",
    metadata: {
      aliases: ["weather", "forecast", "temperature", "天气", "气温"],
      negativeAliases: ["shopping", "wallet transfer", "desktop automation"],
      examples: ["what's the weather in Beijing today"],
      negativeExamples: ["compare the price of a phone"],
    },
  },
  {
    prefix: "wallet.",
    metadata: {
      aliases: ["wallet", "balance", "transfer", "payment", "账单", "转账", "余额"],
      negativeAliases: ["weather", "screenshot", "call me"],
      examples: ["check my wallet balance"],
      negativeExamples: ["take a screenshot"],
    },
  },
  {
    prefix: "alipay.",
    metadata: {
      aliases: ["alipay", "支付宝", "AI付", "支付授权", "付款", "真实支付", "收银台", "402 payment"],
      negativeAliases: ["weather", "screenshot", "calendar reminder"],
      examples: ["开通支付宝AI付", "帮我用支付宝付款", "query alipay payment status"],
      negativeExamples: ["estimate my budget"],
    },
  },
  {
    prefix: "payment.",
    metadata: {
      aliases: ["payment", "pay order", "收银台", "支付订单", "扫码支付", "支付宝", "微信支付"],
      negativeAliases: ["weather", "desktop screenshot", "phone call"],
      examples: ["create an alipay order", "query payment order status"],
      negativeExamples: ["compare product prices"],
    },
  },
  {
    prefix: "phone.",
    metadata: {
      aliases: ["phone", "call", "message", "ring", "电话", "短信"],
      negativeAliases: ["shopping", "price compare", "weather"],
      examples: ["call me to remind me", "send me a phone reminder"],
      negativeExamples: ["recommend a headset"],
    },
  },
  {
    prefix: "voice.",
    metadata: {
      aliases: [
        "voice", "speak", "tts", "text to speech", "speech synthesis",
        "audio generation", "voice message", "朗读", "播报", "说话",
        "语音", "语音合成", "语音播报", "语音消息", "配音", "合成语音",
        "音频生成", "念给我听", "读给我听", "发语音",
      ],
      negativeAliases: ["shopping", "desktop screenshot", "wallet transfer"],
      examples: [
        "念给我听", "用语音告诉我", "发一条语音消息", "读一下这段话",
        "你能做语音合成吗", "帮我把这句话播报出来",
      ],
      negativeExamples: ["推荐一款耳机", "现在几点了"],
    },
  },
  {
    prefix: "calendar.",
    metadata: {
      aliases: ["calendar", "schedule", "todo", "reminder", "日程", "提醒", "待办"],
      negativeAliases: ["shopping", "desktop control"],
      examples: ["remind me tomorrow at 10am"],
      negativeExamples: ["read this webpage"],
    },
  },
  {
    prefix: "desktop.visual.",
    metadata: {
      aliases: ["desktop", "screenshot", "screen", "computer control", "桌面", "截图"],
      // 注意：这里不放 "automation"/"自动化"——desktop.run_automation 才是该语义的目标工具，
      // 避免 desktop.visual.*（如 screenshot/run_task）因通用 alias 抢走 top1。
      negativeAliases: ["weather", "shopping recommendation", "wallet balance"],
      examples: ["take a screenshot", "open the browser and click the search box"],
      negativeExamples: ["what's today's weather"],
    },
  },
  {
    exact: "desktop.visual.screenshot",
    metadata: {
      negativeAliases: [
        "automation task script",
        "run automation",
        "自动化任务脚本",
        "UIA pattern",
        "原生控件操作",
      ],
      negativeExamples: [
        "运行桌面自动化任务脚本",
        "用 UIA 操作 Windows 原生控件",
        "执行 run_automation 任务",
      ],
    },
  },
  {
    exact: "desktop.run_automation",
    metadata: {
      aliases: [
        "run automation script",
        "execute desktop automation task",
        "UIA native control operation",
        "运行桌面自动化任务脚本",
        "桌面控件原子操作",
        "UIA pattern 直接调用",
        "免抢焦点的桌面操作",
      ],
      negativeAliases: [
        "take a screenshot",
        "open the browser",
        "screenshot capture",
        "截屏",
        "打开浏览器",
        "全屏截图",
      ],
      examples: [
        "运行桌面自动化任务脚本",
        "用 UIA 操作 Windows 原生控件",
        "执行 run_automation 任务",
      ],
      negativeExamples: [
        "截一张桌面截图",
        "打开浏览器到百度",
      ],
    },
  },
  {
    exact: "desktop.open",
    metadata: {
      aliases: [
        "open app", "launch app", "open application", "open program", "open software",
        "打开软件", "打开应用", "打开App", "启动应用", "启动软件", "运行软件",
        "打开程序", "帮我打开", "打开抖音", "打开微信", "打开网易云", "打开记事本",
        "打开B站", "打开QQ音乐", "打开浏览器",
      ],
      negativeAliases: [
        "read webpage content",
        "读网页正文", "搜索网页内容",
      ],
      examples: [
        "打开抖音", "帮我打开微信", "打开网易云播放影月", "启动记事本", "open wechat",
      ],
      negativeExamples: [
        "读一下这个网页说了什么",
      ],
    },
  },
  {
    prefix: "embodiment.",
    metadata: {
      aliases: ["move", "roam", "avatar", "window", "移动", "漫游", "化身"],
      negativeAliases: ["price compare", "weather", "wallet bill"],
      examples: ["move a bit to the left"],
      negativeExamples: ["compare product prices"],
    },
  },
  {
    exact: "embodiment.window_place",
    metadata: {
      aliases: [
        "put window at position",
        "place avatar window at coordinates",
        "set window to specified position",
        "桌面角色窗口放到指定位置",
        "球形窗口精准定位",
        "把化身放到屏幕某个位置",
        "窗口精调",
      ],
      negativeAliases: [
        "random wander",
        "roam freely",
        "无目标随机漫游",
        "随便走走",
      ],
      examples: [
        "把桌面角色窗口放到右下角",
        "把球形化身窗口定位到屏幕中央",
        "把悬浮窗放到指定坐标",
        "move my avatar window to (0.5, 0.5)",
      ],
      negativeExamples: [
        "让桌面角色随便走走",
        "让窗口随机换个位置",
        "roam around the screen",
      ],
    },
  },
  {
    exact: "embodiment.roam",
    metadata: {
      aliases: ["3D 场景随机漫游", "无目标漫游", "随机走动", "自由漫游", "random roam", "free move", "漫游移动", "到处走走"],
      negativeAliases: ["放到指定位置", "定位", "坐标", "place at", "position"],
      examples: ["在 3D 场景里随机漫游", "让角色到处走走", "无目标移动"],
      negativeExamples: ["把窗口放到指定位置", "移动到坐标 (1,2,3)"],
    },
  },
  {
    exact: "embodiment.move",
    metadata: {
      aliases: ["移动到坐标", "场景内移动", "移动到指定位置", "move to coordinates", "scene move"],
      negativeAliases: ["随机漫游", "random roam", "无目标"],
      examples: ["移动到场景坐标 (1,2,3)", "移动到指定位置"],
      negativeExamples: ["随机漫游", "到处走走"],
    },
  },
  {
    exact: "embodiment.window_roam",
    metadata: {
      aliases: ["random window roam", "no-target window move", "随便换个位置", "随机挪一下窗口"],
      examples: ["让窗口随机换到别处", "no specific target, just move"],
      negativeExamples: [
        "把窗口放到指定位置",
        "定位到屏幕中央",
        "place the avatar at a specific position",
      ],
    },
  },
  {
    prefix: "browser.",
    metadata: {
      aliases: ["browser", "web page", "cookie", "page read", "浏览器", "网页"],
      negativeAliases: ["phone reminder", "weather only"],
      examples: ["read this webpage"],
      negativeExamples: ["call me later"],
    },
  },
  {
    prefix: "mcp.",
    metadata: {
      aliases: ["external tool", "integration", "file read", "platform tool", "外部工具", "平台工具"],
      negativeAliases: ["local time", "simple weather"],
      examples: ["use the external platform tool to read a file"],
    },
  },
  // ── 黄金回归集（test/tool-discover-golden-recall.test.ts）锁定的漏召场 ──
  // 别名是"用户口语里会出现的短语"：命中（query 整串包含别名）即把 registryName
  // 拼进检索变体，让 registry 通道给正确工具加权。只收高频、语义明确的表达。
  {
    exact: "search_web",
    metadata: {
      aliases: ["行情", "价格", "股价", "汇率", "涨跌", "新闻", "最新消息", "什么价"],
      examples: ["比特币现在什么价", "帮我搜一下最近的新闻"],
    },
  },
  {
    exact: "wallet.get_balance",
    metadata: {
      aliases: ["余额", "还有多少钱", "账上还有", "余额查询"],
      examples: ["我钱包还有多少钱", "查一下我的余额"],
    },
  },
  {
    exact: "fetch_web",
    metadata: {
      aliases: ["网页", "网址", "链接", "读了什么", "说了什么", "网页内容"],
      examples: ["读一下这个网页说了什么", "帮我打开这个链接看看内容"],
    },
  },
  {
    exact: "clock.get_current_time",
    metadata: {
      aliases: ["几点", "现在时间", "什么时间", "当前时间"],
      examples: ["现在几点了"],
    },
  },
  {
    exact: "search_images",
    metadata: {
      aliases: ["照片", "图片", "找图", "壁纸", "表情包", "头像"],
      examples: ["找几张猫的照片", "帮我找壁纸"],
    },
  },
  {
    exact: "smart_home.control_device",
    metadata: {
      aliases: ["开灯", "关灯", "灯光", "空调", "窗帘", "插座", "智能设备"],
      examples: ["把客厅的灯打开", "空调调到26度"],
    },
  },
  {
    exact: "vision.see_device",
    metadata: {
      aliases: ["摄像头", "监控", "看家", "看一下门口", "实时画面"],
      examples: ["看一下门口摄像头", "看看家里现在什么情况"],
    },
  },
  {
    exact: "geofence.create",
    metadata: {
      aliases: ["到家提醒", "离家提醒", "位置提醒", "围栏", "到家的时候", "离开公司"],
      examples: ["到家的时候提醒我拿快递", "离开公司提醒我打卡"],
      negativeAliases: ["定时提醒", "十分钟后"],
      negativeExamples: ["明天早上九点提醒我开会", "十分钟后提醒我", "定个提醒"],
    },
  },
  {
    exact: "care.rhythm_reminder",
    metadata: {
      aliases: ["每天提醒", "定期提醒", "天天提醒", "喝水提醒", "睡觉提醒", "运动提醒"],
      examples: ["每天提醒我喝水", "到点提醒我睡觉"],
    },
  },
  // ── calendar 族内区分（2026-09-08 新增 update_task/find_free_slots 后黄金回归防挤占）──
  // 前缀别名让所有 calendar.* 共享「日程/提醒/待办」，族内排名靠各自专属词。
  {
    exact: "reminder.plan",
    metadata: {
      aliases: ["提醒我", "定时提醒", "定个提醒", "设个提醒", "到点提醒"],
      examples: ["明天早上九点提醒我开会", "十分钟后提醒我", "提醒我交周报"],
      negativeAliases: ["取消提醒", "删除提醒"],
      negativeExamples: ["取消明天那个提醒", "把提醒删了"],
    },
  },
  {
    exact: "care.rhythm_reminder",
    metadata: {
      negativeAliases: ["取消提醒", "删除提醒", "暂停提醒", "改期提醒"],
      negativeExamples: ["取消明天那个提醒", "把提醒关掉", "那个提醒不要了"],
    },
  },
  {
    exact: "calendar.list_tasks",
    metadata: {
      aliases: ["有哪些日程", "我的日程", "有什么安排", "查看日程", "列出日程", "日程列表", "今天有什么安排"],
      examples: ["我有哪些日程", "看看我的日程安排", "列出本周的日程"],
    },
  },
  {
    exact: "calendar.find_free_slots",
    metadata: {
      aliases: ["什么时候有空", "有空时段", "空闲时间", "约时间", "帮我约", "几点有空"],
      examples: ["我明天什么时候有空", "帮我找个有空的时间约她", "下午有哪些空闲时段"],
      negativeExamples: ["我有哪些日程", "取消明天那个提醒", "明天早上九点提醒我开会"],
    },
  },
  {
    exact: "calendar.update_task",
    metadata: {
      aliases: ["改期", "换个时间", "推迟", "提前到", "改到", "暂停提醒", "恢复提醒"],
      examples: ["把会议改期到下午三点", "那个提醒推迟半小时", "暂停每天喝水的提醒"],
      negativeAliases: ["暂停音乐", "音乐暂停", "暂停视频", "暂停播放", "暂停导航"],
      negativeExamples: ["我有哪些日程", "取消明天那个提醒", "明天早上九点提醒我开会", "音乐暂停一下"],
    },
  },
  {
    exact: "smart_home.scene",
    metadata: {
      aliases: ["回家模式", "离家模式", "观影模式", "睡眠场景", "场景模式", "一键场景", "灯光场景"],
      examples: ["帮我打开回家模式", "切到观影模式", "启动睡眠场景"],
      negativeAliases: ["打开软件", "打开应用", "启动应用", "运行软件"],
    },
  },
  {
    exact: "interest.manage",
    metadata: {
      aliases: ["关注话题", "追踪动态", "盯着", "追更", "话题更新", "有新消息告诉我", "有更新提醒我"],
      examples: ["帮我一直盯着这个话题有新消息就告诉我", "关注这个话题有更新告诉我", "追一下这部剧的动态"],
      negativeAliases: ["发消息给", "回复消息", "语音消息"],
    },
  },
  {
    exact: "travel.plan-itinerary",
    metadata: {
      aliases: ["旅游攻略", "行程规划", "旅行计划", "自由行", "怎么安排", "帮我规划"],
      examples: ["帮我规划去成都玩5天的行程", "周末去周边游玩怎么安排", "十一去北京玩有什么攻略"],
    },
  },
  {
    exact: "travel.search-poi",
    metadata: {
      aliases: ["景点推荐", "好玩", "景点门票", "好吃的推荐", "酒店推荐"],
      examples: ["北京有什么好玩的景点", "成都有哪些必吃美食"],
      negativeAliases: ["打开软件", "启动应用"],
    },
  },
  // ── 技能族入口的意图先验（2026-10-10 根修）──
  // 技能族工具的 BM25 词面分天生低（英文点号名 + 简短描述 vs 中文口语 query），
  // 域派生只解决「可见性/按域拉取」，L1 预载仍需一条确切意图通道。这里按
  // travel.plan-itinerary 的既有范式给各族入口登记别名/例句——priorDirectMatchesForQuery
  // 命中即免 discover 直取（≤2 个/查询），把「要不要找这个族的工具」收回代码裁决。
  {
    exact: "habit.create-rule",
    metadata: {
      aliases: ["养成习惯", "建立习惯", "打卡", "以后每天", "每天都要", "帮我记着每天"],
      examples: [
        "记一下我每天早上要喝水的习惯",
        "帮我养成每天跑步的习惯",
        "以后每天八点提醒我做拉伸",
      ],
      negativeAliases: ["打开软件", "启动应用", "查一下天气"],
    },
  },
  {
    exact: "booking.travel-pay",
    metadata: {
      aliases: ["订机票", "买机票", "订酒店", "订火车票", "订门票", "帮我订一下"],
      examples: ["帮我订一下去三亚的机票", "订一间明晚的酒店", "买一张明天去上海的高铁票"],
      negativeAliases: ["规划行程", "行程怎么安排"],
    },
  },
  {
    exact: "picture.process",
    metadata: {
      aliases: ["修图", "修一下照片", "美化照片", "照片美化", "调色", "去水印"],
      examples: ["把我这张照片修一下", "帮我美化一下这张图", "把照片调个色"],
      negativeAliases: ["找照片", "搜照片", "生成图片"],
    },
  },
  {
    exact: "finance.ingest-text",
    metadata: {
      aliases: ["记账", "导入账单", "导入消费", "记一笔", "账单导入", "记到账上"],
      examples: [
        "帮我把这个月的账单导入记账",
        "把这段消费记录记到账上",
        "帮我记一笔吃饭花了一百块",
      ],
      negativeAliases: ["查余额", "看账单", "转账"],
    },
  },
  {
    exact: "virtual-phone.ensure-my-number",
    metadata: {
      aliases: ["虚拟手机号", "虚拟号", "申请手机号", "小号"],
      examples: ["给我申请一个虚拟手机号", "我需要一个虚拟号码"],
      negativeAliases: ["我的手机号是多少", "查看手机号"],
    },
  },
  {
    exact: "agentworld.registration-status",
    metadata: {
      aliases: ["Agent World 注册", "注册数字身份", "我的 agent world 状态"],
      examples: ["我的 Agent World 注册到哪一步了", "帮我看看数字身份注册状态"],
    },
  },
];

const DEFAULT_METADATA_PATH = resolve(getDataDir(), "tool-intent-metadata.json");
const RELOAD_INTERVAL_MS = 5_000;

let cachedRules = DEFAULT_TOOL_INTENT_RULES;
let cachedPath = "";
let cachedMtimeMs = -1;
let lastCheckedAt = 0;
let lastLoadedAt = 0;
let lastLoadError: string | null = null;

/**
 * 由 capability-modules 注入的额外规则。
 *
 * 启动时 {@link registerAllCapabilityModules} 调一次 `setExtraIntentRules`，
 * 把所有能力模块的 intent rules 合并进来。
 * 与磁盘配置文件不同，这部分是代码层静态规则，不需要热加载。
 */
let extraIntentRules: ToolIntentRule[] = [];

/**
 * 注入能力模块的意图规则。
 *
 * @param rules 来自 `capability-modules/index.ts` 的 `getAllCapabilityModuleIntentRules`
 */
export function setExtraIntentRules(rules: ToolIntentRule[]): void {
  extraIntentRules = rules.map(normalizeRule).filter((r): r is ToolIntentRule => r != null);
}

/** 取出所有规则（磁盘配置 + 能力模块注入），优先级：磁盘 > 能力模块 > DEFAULT。 */
function getEffectiveRules(): ToolIntentRule[] {
  const diskRules = loadIntentRulesFromDisk();
  if (extraIntentRules.length === 0) return diskRules;
  // disk 与 extra 都可能覆盖同一工具名，按出现顺序后者覆盖前者。
  // 这里把 extra 追加在 disk 后面，让 catalog.ts 的 getToolIntentMetadata 合并时
  // 把两边的 aliases / examples 都聚合（它本身就是 mergeUnique 的）。
  return [...diskRules, ...extraIntentRules];
}

export type ToolIntentMetadataState = {
  path: string;
  exists: boolean;
  usingDefaultRules: boolean;
  ruleCount: number;
  mtimeMs: number | null;
  lastCheckedAt: number;
  lastLoadedAt: number;
  lastLoadError: string | null;
};

function mergeUnique(parts: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of parts) {
    for (const item of list ?? []) {
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function normalizeRule(rule: ToolIntentRule): ToolIntentRule | null {
  if (!rule || typeof rule !== "object") return null;
  const exact = typeof rule.exact === "string" && rule.exact.trim() ? rule.exact.trim() : undefined;
  const prefix = typeof rule.prefix === "string" && rule.prefix.trim() ? rule.prefix.trim() : undefined;
  if (!exact && !prefix) return null;
  const metadata = rule.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
  return {
    ...(exact ? { exact } : {}),
    ...(prefix ? { prefix } : {}),
    metadata: {
      aliases: mergeUnique([Array.isArray(metadata.aliases) ? metadata.aliases.filter((v): v is string => typeof v === "string") : undefined]),
      negativeAliases: mergeUnique([Array.isArray(metadata.negativeAliases) ? metadata.negativeAliases.filter((v): v is string => typeof v === "string") : undefined]),
      examples: mergeUnique([Array.isArray(metadata.examples) ? metadata.examples.filter((v): v is string => typeof v === "string") : undefined]),
      negativeExamples: mergeUnique([Array.isArray(metadata.negativeExamples) ? metadata.negativeExamples.filter((v): v is string => typeof v === "string") : undefined]),
    },
  };
}

export function resolveToolIntentMetadataPath(): string {
  const override = process.env.AGENT_TOOL_INTENT_METADATA_PATH?.trim();
  return override ? resolve(override) : DEFAULT_METADATA_PATH;
}

function buildMetadataState(path: string): ToolIntentMetadataState {
  const exists = existsSync(path);
  let mtimeMs: number | null = null;
  if (exists) {
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = null;
    }
  }
  return {
    path,
    exists,
    usingDefaultRules: cachedRules === DEFAULT_TOOL_INTENT_RULES,
    ruleCount: cachedRules.length,
    mtimeMs,
    lastCheckedAt,
    lastLoadedAt,
    lastLoadError,
  };
}

function loadIntentRulesFromDisk(force = false): ToolIntentRule[] {
  const metadataPath = resolveToolIntentMetadataPath();
  if (!existsSync(metadataPath)) {
    cachedRules = DEFAULT_TOOL_INTENT_RULES;
    cachedPath = metadataPath;
    cachedMtimeMs = -1;
    lastCheckedAt = Date.now();
    lastLoadError = null;
    return DEFAULT_TOOL_INTENT_RULES;
  }

  const stat = statSync(metadataPath);
  const now = Date.now();
  if (
    !force &&
    cachedPath === metadataPath &&
    cachedMtimeMs === stat.mtimeMs &&
    now - lastCheckedAt < RELOAD_INTERVAL_MS
  ) {
    return cachedRules;
  }

  lastCheckedAt = now;
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as ToolIntentMetadataFile;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.map(normalizeRule).filter((rule): rule is ToolIntentRule => rule != null)
      : [];
    if (rules.length > 0) {
      cachedRules = rules;
      cachedPath = metadataPath;
      cachedMtimeMs = stat.mtimeMs;
      lastLoadedAt = now;
      lastLoadError = null;
      return cachedRules;
    }
  } catch (error) {
    lastLoadError = error instanceof Error ? error.message : String(error);
    console.warn("[tool-intent-metadata] Failed to load JSON config, using defaults:", error);
  }

  cachedRules = DEFAULT_TOOL_INTENT_RULES;
  cachedPath = metadataPath;
  cachedMtimeMs = stat.mtimeMs;
  lastLoadedAt = now;
  return cachedRules;
}

export function getToolIntentMetadata(toolName: string): ToolIntentMetadata {
  const rules = getEffectiveRules();
  const exactMatches = rules
    .filter((rule) => rule.exact === toolName)
    .map((rule) => rule.metadata);
  const prefixMatches = rules
    .filter((rule) => rule.prefix && toolName.startsWith(rule.prefix))
    .map((rule) => rule.metadata);
  const matches = [...prefixMatches, ...exactMatches];
  return {
    aliases: mergeUnique(matches.map((m) => m.aliases)),
    negativeAliases: mergeUnique(matches.map((m) => m.negativeAliases)),
    examples: mergeUnique(matches.map((m) => m.examples)),
    negativeExamples: mergeUnique(matches.map((m) => m.negativeExamples)),
  };
}

export function reloadToolIntentMetadata(): ToolIntentMetadataState {
  loadIntentRulesFromDisk(true);
  return buildMetadataState(resolveToolIntentMetadataPath());
}

export function getToolIntentMetadataState(): ToolIntentMetadataState {
  loadIntentRulesFromDisk();
  return buildMetadataState(resolveToolIntentMetadataPath());
}
