/**
 * 回复格式黄金集语料（端到端原始回复文本）。
 *
 * 与 display-routing-corpus.ts 的分工：
 *   - 那边：两个路由器（routeDisplayEffect / classifyRenderHint）的**孤立打分**，
 *     输入是预结构化对象 / 纯文本，期望是单个决策值；
 *   - 这里：完整管线 processAssistantText 的**端到端回放**——输入是 LLM 原始
 *     回复文本，覆盖文本切片（findExtractableCardSegment）、级联优先级
 *     （raw JSON 抢救 / blockquote / brief / data_brief / summary / long_text）
 *     与标记注入的相互作用，快照锁定最终产物。
 *
 * 样本来源：
 *   - agent-result-formatter.ts / render-hint-service.ts 注释中记录的
 *     历史补丁案例（如「result_card 压到 0.9 防 brief 翻盘」）；
 *   - 阈值边界（RESULT_CARD_MAX_CHARS=300 等），用运行时自校验的构造文本钉住；
 *   - 真实形态的高频漏卡样本（叙述体、中文顿号列举）。
 *
 * 维护：改动格式逻辑后跑 `npm run eval:reply-format -- --update` 重新生成快照，
 * 并**逐条人工审核**新快照是否符合该样本 note 声明的意图——快照锁的是现状，
 * 审核锁的是"现状是对的"。
 */

export interface ReplyFormatCase {
  name: string;
  /** 一句话声明该样本锚定什么（阈值 / 历史补丁 / 常见形态） */
  note: string;
  text: string;
  toolName?: string;
  userText?: string;
  plainTextMode?: boolean;
  /** 本轮工具结构化回执：注册工具（tool-card-registry）据此直出卡 */
  toolResult?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 应上卡（正样本：卡片链路各分支）
// ─────────────────────────────────────────────────────────────────────────────

const POSITIVE: ReplyFormatCase[] = [
  {
    name: "pos-weekend-itinerary-report",
    note: "文档协议示例原文（前导对话 + 3 条列表 + 追问）——项目对外承诺的标准形态",
    text: [
      "好的，耳机已下单，预计周六送达。",
      "",
      "本周末行程已为你规划：",
      "- 周六上午：去你说过的那家新店探店",
      "- 周六下午：健身 + 采购下周末食材",
      "- 周日：在家看你收藏的那部电影",
      "",
      "需要调整吗？",
    ].join("\n"),
  },
  {
    name: "pos-task-done-two-items",
    note: "任务完成汇报仅 2 条列表——钉住 scoreResultCard 的 TASK_DONE 0.9 分路径（历史上 0.8 会被 brief 0.85 翻盘）；当前 cardType 路由为 metric（时间数字信号），一并锁定",
    text: [
      "已为你设置好明天的闹钟：",
      "- 工作日 07:30 起床闹钟",
      "- 周末 09:00 起床闹钟",
      "",
      "要改时间随时说。",
    ].join("\n"),
  },
  {
    name: "pos-weather-tool-short",
    note: "天气工具 + 3 条列表——工具场景加成路径，cardType 应路由为 weather",
    text: ["明天天气不错：", "- 晴转多云", "- 气温 18~26℃", "- 微风"].join("\n"),
    toolName: "weather.get",
  },
  {
    name: "pos-ordered-steps",
    note: "全编号列表——numberedItemRatio=1，cardType 应路由为 steps",
    text: [
      "已为你创建好退货流程：",
      "1. 在订单页点击「申请售后」",
      "2. 选择退货原因并提交",
      "3. 等快递员上门取件",
    ].join("\n"),
  },
  {
    name: "pos-substeps-depth",
    note: "缩进子步骤（无数字，避开 data_brief 的 KPI 信号）——depth 透传（0=一级，1=子步骤），锚定切片器缩进推断",
    text: [
      "健身计划已经帮你排好了：",
      "- 热身放松",
      "  - 开合跳",
      "  - 高抬腿",
      "- 正式训练",
      "  - 卧推",
      "  - 划船",
      "- 拉伸整理",
    ].join("\n"),
  },
  {
    name: "pos-blockquote-quote",
    note: "markdown 引用块——无列表时的 quote 卡回退（纯程序路由，不依赖 LLM）",
    text: "> 少即是多。先做完，再做好。\n\n—— 今天的开发心得",
  },
  {
    name: "pos-llm-declared-card-hint",
    note: "LLM 主动声明 [RENDER_HINT:card]——最高优先级，直接进切卡",
    text: [
      "[RENDER_HINT:card]",
      "旅行清单已经帮你整理好：",
      "- 护照和身份证",
      "- 充电宝和转换插头",
      "- 防晒霜",
    ].join("\n"),
  },
  {
    name: "pos-raw-search-json-rescue",
    note: "LLM 把搜索工具原始 JSON 吐进正文——detectRawSearchResultJson 确定性转 search_result 卡，脏 JSON 不透出",
    text: JSON.stringify({
      items: [
        {
          title: "降噪耳机选购指南",
          url: "https://example.com/headphone-guide",
          snippet: "从降噪原理到佩戴舒适度的完整对比",
        },
        {
          title: "2026 年耳机评测汇总",
          url: "https://example.com/headphone-review",
          snippet: "10 款主流降噪耳机实测",
        },
      ],
    }),
  },
  {
    name: "pos-raw-travel-json-rescue",
    note: "LLM 把行程 JSON 吐进正文——detectRawTravelItineraryJson 确定性转 travel_itinerary 双面板卡",
    text: [
      "马尔代夫行程安排好啦：",
      JSON.stringify({
        ok: true,
        id: "plan-golden-1",
        title: "马尔代夫2日游",
        destination: "马尔代夫",
        startDate: "2026-09-10",
        endDate: "2026-09-11",
        days: [
          {
            date: "2026-09-10",
            items: [
              {
                type: "hotel",
                name: "当地民宿",
                startTime: "2026-09-10T08:00:00",
                description: "位置便利",
              },
              {
                type: "attraction",
                name: "当地自然风光区",
                startTime: "2026-09-10T09:00:00",
                description: "知名自然风光",
              },
            ],
          },
          {
            date: "2026-09-11",
            items: [
              {
                type: "attraction",
                name: "环礁潜水",
                startTime: "2026-09-11T10:00:00",
                description: "浮潜体验",
              },
            ],
          },
        ],
      }),
    ].join("\n"),
  },
  {
    name: "pos-media-search-tool",
    note: "媒体搜索工具 + 3 条带 URL——isMediaSearchTool 不限字数；线上媒体已改走 mediaCards 字段，此处锚定 processor 层行为",
    text: [
      "找到几张相关图片：",
      "- 日落海边 https://example.com/sunset.jpg",
      "- 城市夜景 https://example.com/night.jpg",
      "- 山间晨雾 https://example.com/mist.jpg",
    ].join("\n"),
    toolName: "search_images",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 工具结构化直出卡（B 阶段 tool-card-registry：LLM 纯叙述、无列表语法也上卡）
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_REGISTRY: ReplyFormatCase[] = [
  {
    name: "tool-weather-prose-no-list",
    note: "天气工具 + 纯叙述回复（零列表语法）——旧管线必漏卡，注册表直出 weather 卡",
    text: "明天天气不错，温度很舒服，适合出门走走。",
    toolName: "weather.get_local",
    toolResult: {
      ok: true,
      summary: "明天晴转多云，适合出行",
      weatherText: "晴转多云",
      todayRangeC: "18–26",
      humidityPct: 62,
      windKmh: 8,
      peakRainPct: 10,
      clothingAdvice: "早晚温差大，建议带件薄外套",
      locationLabel: "上海",
    },
  },
  {
    name: "tool-wallet-prose-no-list",
    note: "钱包工具 + 纯叙述回复——注册表直出 wallet 卡",
    text: "查好了，余额充足，放心花。",
    toolName: "wallet.get_balance",
    toolResult: { summary: "查询成功", balance: 1000, currency: "CNY" },
  },
  {
    name: "tool-calendar-prose-no-list",
    note: "日程工具 + 纯叙述回复——注册表直出 schedule 卡，时间取自 nextRunAt（截取格式化，不经 Date，跨时区稳定）",
    text: "接下来就这两个安排，都记着呢。",
    toolName: "calendar.list_tasks",
    toolResult: {
      ok: true,
      count: 2,
      tasks: [
        { taskId: "t1", title: "牙医复诊", nextRunAt: "2026-09-10T09:30:00", status: "active" },
        { taskId: "t2", title: "给妈妈打电话", nextRunAt: "2026-09-11T20:00:00", status: "active" },
      ],
    },
  },
  {
    name: "tool-unregistered-falls-through",
    note: "未注册工具 + toolResult——注册表返回 null，回退文本路由（纯叙述 → plain）",
    text: "笔记已经保存好了。",
    toolName: "notes.save",
    toolResult: { ok: true, id: "n1" },
  },
  {
    name: "tool-registered-but-plaintext-mode",
    note: "plainTextMode:true——注册表路径必须尊重开关（与语义路径的已知不一致相区分，本用例锁定新代码不做同样的事）",
    text: "明天天气不错，温度很舒服，适合出门走走。",
    toolName: "weather.get_local",
    plainTextMode: true,
    toolResult: {
      ok: true,
      summary: "明天晴转多云，适合出行",
      weatherText: "晴转多云",
      todayRangeC: "18–26",
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 不上卡（负样本：「前端很难见到卡片」的具体成因证据）
// ─────────────────────────────────────────────────────────────────────────────

const NEGATIVE: ReplyFormatCase[] = [
  {
    name: "neg-plain-narrative-chat",
    note: "纯叙述无列表语法——n<3 直接 0 分，日常对话最常见的形态",
    text:
      "今天过得怎么样？我记得你上午说要去见客户，如果聊得顺利，晚上可以奖励自己一顿好吃的。",
  },
  {
    name: "neg-chinese-enumeration-no-markdown",
    note: "中文顿号列举——语义上是清单但没有 markdown 前缀，LIST_ITEM_RE 不认，是最典型的高频漏卡形态",
    text: "你的快递、外卖和洗衣都已经安排好了，明天上午陆续到，注意查收。",
  },
  {
    name: "neg-two-items-no-task-done",
    note: "仅 2 条列表且无任务完成措辞——n<3 且 TASK_DONE 不命中，落入 brief/语义路径",
    text: ["冰箱里有这些：", "- 鸡蛋", "- 牛奶"].join("\n"),
  },
  {
    name: "neg-list-split-by-long-paragraph",
    note: "列表被长段落隔断（过渡行 >20 字）——findExtractableCardSegment 窗口断裂，切卡失败",
    text: [
      "关于周末的安排：",
      "- 周六上午探店",
      "另外我查了一下那家新店的评价，好评不少，排队情况据说周末会比较严重，建议早点出发，或者先取号再逛别的地方。",
      "- 周日下午健身",
      "- 周日晚看电影",
    ].join("\n"),
  },
  {
    name: "neg-kpi-list-suppressed-by-data-brief",
    note: "列表 + KPI 密集（DATA_TOKEN_RE 可识别的单位 ≥3 个、全文 ≥60 字）——data_brief 让位规则（result_card ×0.5）的历史语义：数字清单应上数据快报而非通用卡",
    text: [
      "本周进度小结：",
      "- 专注时长 320 分钟",
      "- 跑步 12 公里",
      "- 阅读 5 小时",
      "- 目标达成率 85%",
      "整体节奏比上周稳了很多，下周继续保持这个状态就行，不用刻意加量。",
    ].join("\n"),
  },
  {
    name: "neg-markdown-table-with-list",
    note: "表格在场——hasTable 直接否决 result_card，走 long_text/structured 渲染",
    text: [
      "对比一下两台笔记本：",
      "",
      "| 型号 | 价格 | 续航 |",
      "| ---- | ---- | ---- |",
      "| X1 | 9999 | 18h |",
      "| Air | 7999 | 15h |",
      "",
      "- X1 更贵但续航长",
      "- Air 性价比更高",
    ].join("\n"),
  },
  {
    name: "neg-long-structured-summary-card",
    note: "≥400 字结构化长文——走 summary_card 折叠（与 AgentResultCard 的边界：长内容归折叠卡）",
    text: [
      "帮你把这份健康指南整理好了：",
      "",
      "## 饮食",
      "每天保证一斤蔬菜、半斤水果，主食里加一点粗粮。蛋白质优先选鱼虾和豆制品，红肉控制在每周三次以内。晚饭尽量在七点前吃完，睡前三小时不要再进食，晚上饿了可以喝一杯温牛奶，但不要吃甜食，避免血糖波动影响睡眠质量。",
      "",
      "## 运动",
      "每周至少完成三次有氧，每次三十分钟以上，快走和游泳都可以。力量训练每周两次，重点放在下肢和核心，避免连续两天练同一部位。运动前要充分热身，运动后做十分钟的拉伸，这样既能减少受伤概率，也能缓解第二天的肌肉酸痛。",
      "",
      "## 睡眠",
      "固定作息时间，周末补觉不要超过一小时。睡前一小时远离手机，卧室温度保持在二十度左右更容易入睡。如果躺下二十分钟还没有睡意，可以起来看一会儿纸质书，等有困意再回到床上，不要在床上刷手机。",
      "",
      "## 复查",
      "每半年做一次体检，重点关注血脂和尿酸指标，如果有异常遵医嘱增加复查频率。体检前三天保持平时的饮食习惯，不要刻意清淡，也不要饮酒，这样结果才更接近真实水平。",
      "",
      "## 心态",
      "压力大的时候先做几次深呼吸，把注意力放回当下。可以每周给自己安排一段完全放空的缓冲时间，散散步、听听音乐都可以，长期紧绷的状态对血糖和血压都不友好。",
      "",
      "## 饮水",
      "每天把饮水量稳定在一千五百毫升到两千毫升之间，早上起床先喝一杯温水，白天分次小口喝，不要等口渴了才补。咖啡和浓茶尽量放在上午，下午换成淡茶或白水，这样夜里的睡眠不会被利尿作用打断。运动出汗多的时候，可以在水里加一点点盐，或者喝无糖的电解质水，别用含糖饮料代替。",
      "",
      "## 用眼",
      "看屏幕每四十分钟就抬头看远处两分钟，让睫状肌真正放松下来。室内光线要均匀，不要让台灯直接照在屏幕上产生反光。眼睛干涩的时候，先眨眼湿润，再用人工泪液，不要长期依赖清凉型眼药水。晚上关灯后尽量不看手机，实在要看就把亮度调到最低，并且开启护眼模式。每用眼一小时，可以用温热的毛巾敷一敷眼睛，促进睑板腺分泌，缓解干涩和酸胀。",
    ].join("\n"),
  },
  {
    name: "neg-plaintext-mode-disables-card",
    note: "【钉住已知不一致】plainTextMode:true 下语义/长文路径不受关卡约束，仍注入卡片且把前导句误切成假条目（「好的，」）——chat-turn-runner 传此标志的路径会漏卡；修复此缺陷后本快照应翻转为纯文本并更新本注",
    text: [
      "好的，耳机已下单，预计周六送达。",
      "",
      "本周末行程已为你规划：",
      "- 周六上午：去你说过的那家新店探店",
      "- 周六下午：健身 + 采购下周末食材",
      "- 周日：在家看你收藏的那部电影",
      "",
      "需要调整吗？",
    ].join("\n"),
    plainTextMode: true,
  },
  {
    name: "neg-already-marked-passthrough",
    note: "已含卡片标记的文本——直接放行不二次处理（防双重包裹）",
    text: [
      "前导说明。",
      "[AGENT_RESULT_CARD_START]",
      '{"title":"已有卡片","items":[{"type":"check","text":"条目一"},{"type":"check","text":"条目二"},{"type":"check","text":"条目三"}],"footer":""}',
      "[AGENT_RESULT_CARD_END]",
    ].join("\n"),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 阈值边界（运行时自校验，防止后续编辑悄悄破坏边界语义）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造恰好 targetLen 字的「标题 + 3 条列表 + 长叙述行」文本（自校验长度）。 */
function atExactLength(targetLen: number): string {
  const base = [
    "这几个习惯建议保持：",
    "- 早起后喝一杯温水",
    "- 午饭后散步十五分钟",
    "- 睡前做一组拉伸",
    "",
  ].join("\n");
  // 结尾叙述行须 >40 字，否则会被切片器收进卡片 footer，破坏「纯长度边界」语义
  const filler = "这个习惯对长期健康很有帮助，值得坚持下去。";
  const padLen = targetLen - base.length;
  if (padLen <= 40) {
    throw new Error(
      `边界语料构造失败：base ${base.length} 字，无法在 ${targetLen} 字内追加 >40 字的叙述行`,
    );
  }
  const tail = `另外补充一句：${filler.repeat(Math.floor(padLen / filler.length) + 1)}`;
  const final = (base + tail).slice(0, targetLen);
  if (final.length !== targetLen) {
    throw new Error(`边界语料构造失败：期望 ${targetLen} 字，实际 ${final.length} 字`);
  }
  return final;
}

const BOUNDARY: ReplyFormatCase[] = [
  {
    name: "edge-list-exactly-300-chars",
    note: "3 条列表 + 恰好 300 字（=RESULT_CARD_MAX_CHARS）——钉住上卡的闭区间边界",
    text: atExactLength(300),
  },
  {
    name: "edge-list-301-chars",
    note: "同样文本 301 字（>RESULT_CARD_MAX_CHARS）——钉住超限后跌出 result_card 的边界",
    text: atExactLength(301),
  },
];

export const REPLY_FORMAT_CORPUS: ReplyFormatCase[] = [
  ...POSITIVE,
  ...TOOL_REGISTRY,
  ...NEGATIVE,
  ...BOUNDARY,
];
