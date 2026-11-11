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
      aliases: ["shopping", "buy", "compare prices", "product recommendation", "购物", "比价", "推荐商品", "查订单", "订单状态"],
      negativeAliases: ["phone call", "desktop movement", "weather lookup"],
      examples: ["compare prices for headphones", "recommend a power bank for travel"],
      negativeExamples: ["call me later", "move the desktop avatar"],
    },
  },
  {
    exact: "shopping.order.track",
    metadata: {
      aliases: ["express delivery", "parcel tracking", "logistics", "tracking number", "快递", "包裹", "物流", "运单", "运单号", "快递到哪了", "到哪了", "查快递"],
      negativeAliases: ["takeout rider status", "desktop screenshot", "weather lookup"],
      examples: ["我的快递到哪了", "查一下这个订单的物流", "帮我看下淘宝订单发货没"],
      negativeExamples: ["外卖骑手到了吗", "帮我截个图"],
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
  // 设备控制入口没有专属词面前缀（工具名 smart_home 推不出灯/空调），
  // 用别名补足检索文本；这些词只进索引，不再触发任何直取。
  {
    exact: "smart_home",
    metadata: {
      aliases: [
        "灯", "客厅的灯", "开灯", "关灯", "灯光", "调亮", "调暗", "色温",
        "空调", "窗帘", "插座", "开关", "回家模式", "离家模式", "晚安模式",
        "智能家居", "智能设备", "家里设备",
      ],
      negativeAliases: [
        "打开应用", "打开软件", "打开程序", "截图", "截屏",
        "监控画面", "实时画面",
      ],
      examples: ["把客厅的灯打开", "空调调到26度", "打开回家模式", "把窗帘拉上"],
      negativeExamples: ["打开抖音", "帮我截个图", "看看家里的摄像头"],
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
    prefix: "phone",
    metadata: {
      aliases: ["phone", "call", "message", "ring", "电话", "短信"],
      negativeAliases: ["shopping", "price compare", "weather"],
      examples: ["call me to remind me", "send me a phone reminder"],
      negativeExamples: ["recommend a headset"],
    },
  },
  {
    prefix: "voice",
    metadata: {
      aliases: [
        "voice", "speak", "tts", "text to speech", "speech synthesis",
        "audio generation", "voice message", "朗读", "播报", "说话",
        "语音", "语音合成", "语音播报", "语音消息", "配音", "合成语音",
        "音频生成", "念给我听", "读给我听", "发语音",
      ],
      negativeAliases: ["shopping", "desktop screenshot", "wallet transfer", "好友消息", "加好友", "好友申请"],
      examples: [
        "念给我听", "用语音告诉我", "发一条语音消息", "读一下这段话",
        "你能做语音合成吗", "帮我把这句话播报出来",
      ],
      negativeExamples: ["推荐一款耳机", "现在几点了", "回复好友消息"],
    },
  },
  {
    exact: "calendar",
    metadata: {
      aliases: [
        "calendar", "schedule", "todo", "reminder", "日程", "提醒", "待办",
        "提醒我", "定时提醒", "定个提醒", "设个提醒", "到点提醒",
        "有哪些日程", "我的日程", "有什么安排", "查看日程", "列出日程", "日程列表", "今天有什么安排",
        "什么时候有空", "有空时段", "空闲时间", "约时间", "帮我约", "几点有空",
        "改期", "换个时间", "推迟", "提前到", "改到", "暂停提醒", "恢复提醒",
      ],
      negativeAliases: ["shopping", "desktop control", "到家", "回到家", "离家", "离开公司"],
      examples: ["remind me tomorrow at 10am", "我有哪些日程", "什么时候有空"],
      negativeExamples: ["read this webpage", "到家的时候提醒我拿快递"],
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
        // 设备控制不是「打开应用」：把用户最常见的家居说法明确排除，
        // 否则 desktop.open 会靠「打开」二字抢走 smart_home 的召回。
        "开灯", "关灯", "灯光", "客厅的灯", "台灯",
        "空调", "窗帘", "插座", "回家模式", "离家模式",
        "智能家居", "设备控制",
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
    exact: "web_search",
    metadata: {
      aliases: [
        "行情", "价格", "股价", "汇率", "涨跌", "新闻", "最新消息", "什么价",
        "照片", "图片", "找图", "壁纸", "表情包", "头像",
        // 复合 action 覆盖（2026-11-11）：天气/热搜/视频/深读各自要有词面入口
        "天气", "气温", "下雨", "温度", "空气质量",
        "热搜", "热点", "热榜", "榜单", "趋势",
        "视频", "短视频", "影片", "找个视频",
        "深度调研", "详细查一下", "多找几个来源", "核实一下",
      ],
      examples: [
        "比特币现在什么价", "帮我搜一下最近的新闻", "找几张猫的照片", "帮我找壁纸",
        "北京今天天气怎么样", "今天有什么热搜", "找个教做红烧肉的视频", "这个说法帮我核实一下",
      ],
    },
  },
  {
    exact: "web_fetch",
    metadata: {
      aliases: ["网页", "网址", "链接", "读了什么", "说了什么", "网页内容", "站内", "这个网站里", "点开这个链接"],
      examples: ["读一下这个网页说了什么", "帮我打开这个链接看看内容", "在这个网站里找一下报名入口"],
      negativeAliases: ["搜一下", "找几张", "热搜"],
    },
  },
  // ── 复合 action 覆盖（2026-11-11）：细分名收编后，各 action 的用户口语
  //    必须还能命中复合入口，否则模型看到的是空召回。──
  {
    exact: "world.link",
    metadata: {
      aliases: ["好友", "好友列表", "我的好友", "加好友", "添加好友", "好友申请", "谁加我", "发消息", "回复好友", "给好友", "私信", "发一句"],
      examples: ["给好友发消息", "回复好友消息", "看看我有哪些好友", "同意他的好友申请"],
      negativeAliases: ["语音消息", "朗读", "播报"],
      negativeExamples: ["把这段话念给我听"],
    },
  },
  {
    exact: "agent",
    metadata: {
      aliases: [
        "你会什么", "你能做什么", "能不能办", "能力边界", "支持什么",
        "待办", "任务进度", "办到哪", "跑完了吗",
        "改名字", "改名", "签名", "叫你什么",
        "主页", "简介", "自我介绍", "个人介绍",
        "档案", "画像", "用户资料", "我的资料", "我的信息", "你了解我",
      ],
      examples: ["你能做什么", "我之前让你办的事到哪一步了", "把自己的名字改成小满", "你还记得我的资料吗"],
      negativeAliases: ["帮我订", "购物", "下单", "agent 世界", "Agent 世界", "在线状态", "接入状态"],
    },
  },
  {
    exact: "proactivity",
    metadata: {
      aliases: ["怎么没提醒", "为什么没说", "怎么没动静", "没告诉我", "沉默", "为什么不提醒", "怎么不说话了", "太吵", "别提醒", "别发了", "打扰", "少提醒", "批准", "就这么办"],
      examples: ["你最近怎么没提醒我", "提醒太频繁了别发了", "这个提议我批准了"],
      negativeAliases: ["定时提醒", "日程", "待办"],
    },
  },
  {
    exact: "care",
    metadata: {
      aliases: ["生日", "纪念日", "重要日子", "重要日期", "结婚纪念", "我妈生日", "爸爸生日", "女朋友生日"],
      examples: ["记住我妈生日是5月20号", "我记了哪些重要日期", "把那个纪念日删掉"],
      negativeAliases: ["定时提醒", "十分钟后", "明天早上"],
    },
  },
  {
    exact: "device",
    metadata: {
      aliases: ["设备", "设备列表", "有哪些设备", "摄像头", "监控画面", "实时画面", "直播画面", "看家里"],
      examples: ["我有哪些绑定的设备", "打开客厅的摄像头看看", "看一下家里的实时画面"],
      negativeAliases: ["开灯", "关灯", "窗帘", "空调", "插座"],
    },
  },
  {
    exact: "aip",
    metadata: {
      aliases: ["协作", "协作状态", "配对", "联盟", "协作请求", "派给助手", "转给另一个 agent", "提案", "提议"],
      examples: ["我的协作状态怎么样", "把这个任务派给配对的助手", "看一下对方的提案"],
      negativeAliases: ["好友消息", "加好友"],
    },
  },
  {
    exact: "world",
    metadata: {
      aliases: ["世界状态", "在线状态", "我的世界", "Agent 世界", "接入状态", "开房间", "建房间", "创建房间", "注册挑战", "开放注册"],
      examples: ["我在 Agent 世界的状态怎么样", "给我开个房间", "帮我拿一下开放注册的挑战题"],
      negativeAliases: ["好友消息", "加好友", "发消息"],
    },
  },
  {
    exact: "smart_home",
    metadata: {
      aliases: ["开灯", "关灯", "灯光", "空调", "窗帘", "插座", "智能设备", "回家模式", "离家模式", "观影模式", "睡眠场景", "场景模式", "一键场景", "灯光场景"],
      examples: ["把客厅的灯打开", "空调调到26度", "帮我打开回家模式"],
      negativeAliases: ["打开软件", "打开应用", "启动应用", "运行软件"],
    },
  },
  {
    exact: "geofence",
    metadata: {
      aliases: ["到家提醒", "离家提醒", "位置提醒", "围栏", "到家的时候", "离开公司"],
      examples: ["到家的时候提醒我拿快递", "离开公司提醒我打卡"],
      negativeAliases: ["定时提醒", "十分钟后"],
      negativeExamples: ["明天早上九点提醒我开会", "十分钟后提醒我", "定个提醒"],
    },
  },
  {
    exact: "interest.manage",
    metadata: {
      aliases: ["关注话题", "追踪动态", "盯着", "追更", "话题更新", "有新消息告诉我", "有更新提醒我"],
      examples: ["帮我一直盯着这个话题有新消息就告诉我", "关注这个话题有更新告诉我", "追一下这部剧的动态"],
      // 价格变动不是"话题追踪"，归 watch.track（kind=price）。
      negativeAliases: ["发消息给", "回复消息", "语音消息", "降价", "价格变动", "商品价格", "打折降价"],
    },
  },
  // 统一盯梢入口（2026-11 补登记）：kind=price 的「盯降价」表达在 discover
  // 词面通道天生弱（英文点号名 + 无价格同义词），此前被 interest.manage 的
  // 「盯着」别名抢走。这里登记价格语义别名/例句，让 watch.track 拿到词面与先验双重命中。
  {
    exact: "watch.track",
    metadata: {
      aliases: [
        "盯着降价",
        "盯着这款",
        "降价了叫我",
        "降价通知",
        "价格变动",
        "价格监控",
        "监控价格",
        "关注价格",
        "降到多少钱",
        "便宜了叫我",
        "打折了叫我",
        "蹲降价",
      ],
      examples: [
        "帮我盯着这款耳机降价",
        "这个耳机降到800以内叫我",
        "帮我蹲一下这双鞋打折",
        "价格降了多少告诉我",
      ],
      negativeAliases: ["发消息给", "回复消息", "定时提醒", "定个提醒"],
    },
  },
  {
    exact: "travel.plan-itinerary",
    metadata: {
      aliases: [
        "旅游攻略", "行程规划", "旅行计划", "自由行", "怎么安排", "帮我规划",
        // 口语入口（2026-11-11）：用户很少说「规划行程」，更多是「有什么攻略/去X玩几天」。
        // 用带上下文的长短语而不是裸「攻略」——裸词会把「王者荣耀攻略」也拉进来。
        // 这些词只作检索文本，不触发直取；选择权仍在模型。
        "有什么攻略", "玩攻略", "旅行攻略", "游玩攻略", "玩几天", "玩什么", "去哪玩",
        "周边游", "短途游", "亲子游", "带娃去哪", "出游", "旅游", "旅行",
      ],
      negativeAliases: ["游戏攻略", "通关攻略", "装机攻略", "王者荣耀", "王者", "荣耀", "英雄联盟", "原神", "开黑", "出装", "副本", "手游"],
      examples: [
        "帮我规划去成都玩5天的行程",
        "周末去周边游玩怎么安排",
        "十一去北京玩有什么攻略",
        "去大理玩三天怎么安排",
      ],
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
  // 路程查询/出发建议（2026-11-05）：高德接入后这两条是「用户位置 × 目的地」的
  // 对话入口，且起点可省略（服务端按实时定位补）。词面分天生弱（点号英文名 +
  // 口语「多久/多远/几点出门」），必须登记别名走先验直取，否则模型搜不到、
  // 转而凭印象估时间。
  {
    exact: "travel.compute-route",
    metadata: {
      aliases: [
        "多远",
        "多久",
        "多长时间",
        "要多久",
        "开车多久",
        "过去多久",
        "走过去",
        "距离",
        "路程",
        "几公里",
        "怎么走",
        "从这到",
        "从我这到",
        "打车要多久",
      ],
      examples: [
        "我从这儿到国贸要多久",
        "去首都机场多远",
        "开车过去多长时间",
        "这地方离我几公里",
      ],
      negativeAliases: ["叫个车", "帮我打车", "订机票", "规划行程", "几点出门"],
    },
  },
  {
    exact: "travel.departure-advice",
    metadata: {
      aliases: [
        "几点出门",
        "几点出发",
        "最晚几点走",
        "来得及吗",
        "要不要早出门",
        "出发时间",
        "现在走",
        "提前多久出门",
      ],
      examples: [
        "明天八点的飞机几点出门",
        "我现在去机场来得及吗",
        "九点前要到公司几点走",
        "下雨要不要早点出门",
      ],
      negativeAliases: ["多远", "几公里", "帮我叫车", "规划行程"],
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
