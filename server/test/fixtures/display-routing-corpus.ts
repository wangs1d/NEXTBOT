/**
 * 展示路由金样本语料库（golden corpus）。
 *
 * 两层展示路由（卡片级 routeDisplayEffect / 消息级 classifyRenderHint）
 * 的权重、阈值与正则大多围绕真实误判案例手工调出，历史上这些案例只活在
 * 代码注释里。本文件把它们沉淀为可机读样本：任何阈值/权重调整后跑
 * `npm run eval:routing`（或直接跑 display-routing-corpus.test.ts）即可
 * 得到准确率与混淆矩阵，避免「修好一个案例、悄悄弄坏另一个」。
 *
 * 样本来源：
 *   - test/display-effect-router.test.ts 的既有断言（语义等价搬运）；
 *   - display-effect-router.ts / render-hint-service.ts / agent-result-formatter.ts
 *     注释中记录的真实误判/漏判案例；
 *   - 对比卡（comparison_table）与工具名分词匹配的新增回归场景。
 */

export interface CardCase {
  name: string;
  input: {
    toolName?: string;
    title: string;
    items: Array<{ text: string; type?: string }>;
    fullText?: string;
    footer?: string;
    numberedItemRatio?: number;
  };
  expected: string;
}

export interface HintCase {
  name: string;
  text: string;
  toolName?: string;
  userText?: string;
  expected: string;
}

const items = (texts: string[]) => texts.map((text) => ({ text, type: "num" }));

// ─────────────────────────────────────────────────────────────────────────────
// 卡片级路由语料（routeDisplayEffect）
// ─────────────────────────────────────────────────────────────────────────────

export const CARD_CORPUS: CardCase[] = [
  // ── 工具信号兜底 ──
  {
    name: "tool: weather strong fallback",
    input: { title: "查询结果", items: items(["晴转多云"]), toolName: "weather.get" },
    expected: "weather",
  },
  {
    name: "tool: content beats strong tool (progress over weather)",
    input: {
      title: "今日天气",
      items: items(["湿度 60%", "降水概率 80%", "紫外线 50%"]),
      toolName: "weather.get",
    },
    expected: "progress",
  },
  {
    name: "tool: calendar/schedule strong",
    input: { title: "日程", items: items(["09:00 开会"]), toolName: "calendar.list_tasks" },
    expected: "schedule",
  },
  {
    name: "tool: wallet strong",
    input: { title: "账单", items: items(["支出 100 元"]), toolName: "wallet.list" },
    expected: "wallet",
  },
  {
    name: "tool: order strong",
    input: { title: "订单", items: items(["已发货"]), toolName: "order.query" },
    expected: "order",
  },
  {
    name: "tool: file strong",
    input: { title: "文件", items: items(["a.pdf"]), toolName: "file.read" },
    expected: "file",
  },
  {
    name: "tool: media strong",
    input: { title: "图片", items: items(["结果"]), toolName: "search_images" },
    expected: "media",
  },
  {
    name: "tool: search_web 不再映射展示效果（2026-11-05 定稿）",
    input: { title: "搜索", items: items(["条目"]), toolName: "search_web" },
    expected: "",
  },
  {
    name: "tool: plan_trip weak → timeline",
    input: { title: "行程", items: items(["day1"]), toolName: "plan_trip" },
    expected: "timeline",
  },
  // ── 工具名分词精确匹配回归（原 includes 宽匹配误命中）──
  {
    name: "tool-token: profile_view must not hit file card",
    input: { title: "资料", items: items(["用户资料条目"]), toolName: "profile_view" },
    expected: "",
  },
  {
    name: "tool-token: prepay_query must not hit order card",
    input: { title: "查询", items: items(["预付结果条目"]), toolName: "prepay_query" },
    expected: "",
  },
  {
    name: "tool-token: reschedule_task still hits schedule card",
    input: { title: "改期", items: items(["周五下午"]), toolName: "schedule_task" },
    expected: "schedule",
  },
  // ── steps ──
  {
    name: "steps: 第X步 markers",
    input: {
      title: "安装步骤",
      items: items(["第1步 下载安装包", "第2步 双击运行", "第3步 完成配置"]),
    },
    expected: "steps",
  },
  {
    name: "steps: Step N markers",
    input: { title: "Setup", items: items(["Step 1 download", "Step 2 run", "Step 3 finish"]) },
    expected: "steps",
  },
  {
    name: "steps: numbered items",
    input: { title: "流程", items: items(["1. 打开水龙头", "2. 涂泡沫", "3. 冲干净"]) },
    expected: "steps",
  },
  {
    name: "steps: tutorial title lowers threshold",
    input: {
      title: "新手教程",
      items: items(["先注册账号", "1. 登录账号", "2. 完善资料", "绑定手机"]),
    },
    expected: "steps",
  },
  {
    name: "steps intent: 先/再 connectives stay plain (photo-chat regression)",
    input: {
      title: "",
      items: items([
        "给你找了几张景甜的，偏温婉甜美那一挂",
        "也有套海蓝色亮片薄纱裙的，带点清凉性感味",
        "你先看看合不合口味",
        "要是想要更性感火辣的那种",
        "我再往红毯活动造型那边翻翻",
      ]),
      fullText:
        "给你找了几张景甜的，偏温婉甜美那一挂，也有套海蓝色亮片薄纱裙的，带点清凉性感味。" +
        "你先看看合不合口味。要是想要更性感火辣的那种，我再往红毯活动造型那边翻翻。",
    },
    expected: "",
  },
  // ── progress ──
  {
    name: "progress: percent majority",
    input: { title: "本周完成度", items: items(["任务A 45%", "任务B 75%", "任务C 90%"]) },
    expected: "progress",
  },
  {
    name: "progress: score majority",
    input: { title: "评分", items: items(["外观 90/100", "性能 85/100", "续航 70/100"]) },
    expected: "progress",
  },
  {
    name: "progress: below half → generic",
    input: { title: "杂项", items: items(["任务A 45%", "备注一", "备注二", "备注三"]) },
    expected: "",
  },
  // ── metric ──
  {
    name: "metric: label:value pairs",
    input: {
      title: "本月概览",
      items: items(["销售额：1.2万", "新增用户：3400人", "复购率：38%"]),
    },
    expected: "metric",
  },
  {
    name: "metric: two items",
    input: { title: "屏幕参数", items: items(["尺寸：6.7英寸", "重量：199g"]) },
    expected: "metric",
  },
  {
    name: "metric: narrative label+value+unit",
    input: { title: "", items: [], fullText: "这款屏幕尺寸是6.7英寸，重量199克，峰值亮度2000尼特。" },
    expected: "metric",
  },
  {
    name: "metric: dual representation survives prose noise (calendar tool)",
    input: {
      toolName: "calendar.list_tasks",
      title: "手机参数",
      items: items(["屏幕尺寸：6.7英寸", "机身重量：199g", "峰值亮度：2000nit"]),
      fullText:
        "帮你整理好了这款手机的参数。\n- 屏幕尺寸：6.7英寸\n- 机身重量：199g\n- 峰值亮度：2000nit\n需要我再对比续航吗",
    },
    expected: "metric",
  },
  // ── timeline ──
  {
    name: "timeline: clock-marked items",
    input: {
      title: "周末安排",
      items: items(["09:00 起床吃早餐", "10:30 健身房", "12:00 午饭", "14:00 电影"]),
    },
    expected: "timeline",
  },
  {
    name: "timeline: weekday items",
    input: { title: "行程", items: items(["周六 逛展", "周日 爬山", "周一 收心"]) },
    expected: "timeline",
  },
  {
    // 路由器层面：timeline 意图分（明天/后天）会命中；2 条目无钟点的形态
    // 门控在 formatter 的 ByForm 二次门拦下（见 display-effect-router.test.ts
    // 「2-item day-word-only narrative stays plain」）。此处锁定路由器行为。
    name: "timeline: 2-item day-words fire intent at router (formatter gates downstream)",
    input: { title: "", items: [], fullText: "明天上午可能下雨，后天下午就放晴了。" },
    expected: "timeline",
  },
  {
    name: "timeline: 第X天 narrative",
    input: {
      title: "",
      items: [],
      fullText: "第一天去乌布看梯田，第二天去圣泉寺，第三天金巴兰看日落。",
    },
    expected: "timeline",
  },
  // ── chips ──
  {
    name: "chips: short tags",
    input: { title: "你的兴趣标签", items: items(["健身", "摄影", "烘焙", "旅行", "桌游"]) },
    expected: "chips",
  },
  {
    // chips 在路由器里只信结构化条目（SEMANTIC_REEXTRACT_INELIGIBLE，语义
    // 重切分会制造伪标签行）；语义路径的顿号列举由 formatter 把语义条目作为
    // input.items 传入后再上卡（见 display-effect-router.test.ts 顿号用例）。
    name: "chips: 顿号 enumeration with extracted entries",
    input: { title: "去超市需要买", items: items(["苹果", "香蕉", "橙子", "牛奶", "鸡蛋"]) },
    expected: "chips",
  },
  {
    name: "chips: overlong item breaks tag shape",
    input: { title: "标签", items: items(["健身", "摄影", "周末长距离骑行训练"]) },
    expected: "",
  },
  // ── fold_list ──
  {
    name: "fold_list: 10-item list",
    input: {
      title: "购物清单",
      items: items(Array.from({ length: 10 }, (_, i) => `清单条目 ${i + 1}`)),
    },
    expected: "fold_list",
  },
  {
    name: "fold_list: 7 items stay generic",
    input: {
      title: "购物清单",
      items: items(Array.from({ length: 7 }, (_, i) => `清单条目 ${i + 1}`)),
    },
    expected: "",
  },
  // ── carousel ──
  {
    name: "carousel: image urls majority",
    input: {
      title: "推荐商品",
      items: items([
        "产品A ¥299 https://img.example.com/a.jpg",
        "产品B ¥399 https://img.example.com/b.png",
        "产品C ¥499 https://img.example.com/c.webp",
      ]),
    },
    expected: "carousel",
  },
  // ── compare / comparison_table ──
  {
    name: "compare: two A/B image entries (before/after slider)",
    input: {
      title: "",
      items: items([
        "A 持妆前 https://img.example.com/before.jpg",
        "B 持妆后 https://img.example.com/after.jpg",
      ]),
      fullText: "对比一下持妆效果",
    },
    expected: "compare",
  },
  {
    name: "comparison_table: bare A/B text pairs",
    input: {
      title: "对比",
      items: items(["A", "B"]),
      toolName: "compare_products",
    },
    expected: "comparison_table",
  },
  {
    name: "comparison_table: 方案A/B pairs with 对比 intent",
    input: {
      title: "",
      items: items(["方案A 便宜", "方案B 灵活", "看你预算"]),
      fullText: "方案A和方案B有什么区别？哪个更适合我？",
    },
    expected: "comparison_table",
  },
  {
    name: "comparison_table: bare A/B semantic items",
    input: {
      title: "",
      items: [],
      fullText: "两款手机的区别主要在屏幕和续航。A便宜些，B性能强，看你怎么选。",
    },
    expected: "comparison_table",
  },
  // ── travel_itinerary ──
  {
    name: "travel: numbered itinerary under travel.* keeps travel card",
    input: {
      toolName: "travel.plan",
      title: "巴厘岛5日行程",
      items: items(["到达乌布，入住酒店", "圣泉寺+梯田", "情人崖看日落"]),
      fullText: "巴厘岛5日行程：\n1. 到达乌布，入住酒店\n2. 圣泉寺+梯田\n3. 情人崖看日落",
      numberedItemRatio: 1,
    },
    expected: "travel_itinerary",
  },
  {
    name: "travel: same shape without travel.* stays steps",
    input: {
      title: "待办清单",
      items: items(["买菜", "取快递", "交水电费"]),
      numberedItemRatio: 1,
    },
    expected: "steps",
  },
  // ── quote ──
  {
    name: "quote: quoted title only",
    input: { title: "「今天的不开心就到此为止吧」", items: [] },
    expected: "quote",
  },
  {
    name: "quote: conclusion lead",
    input: { title: "总之，这套方案的性价比最高", items: [] },
    expected: "quote",
  },
  // ── 通用卡兜底 ──
  {
    name: "generic: plain short list",
    input: { title: "已完成的任务", items: items(["买菜", "取快递", "交水电费"]) },
    expected: "",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 消息级路由语料（classifyRenderHint）
// ─────────────────────────────────────────────────────────────────────────────

export const HINT_CORPUS: HintCase[] = [
  {
    name: "image tool → image_text",
    text: "识别结果：这是一张办公室场景照片，桌上有笔记本电脑。",
    toolName: "vision.ocr",
    expected: "image_text",
  },
  {
    name: "search tool + 3-10 list items → long_text（不出搜索卡）",
    text: "- Node.js 官方文档\n- MDN 教程\n- 掘金社区文章",
    toolName: "search_web",
    expected: "long_text",
  },
  {
    name: "search tool + intent short list → long_text（搜索轮统一富文本）",
    text: "- 方案A 便宜\n- 方案B 灵活\n- 方案C 折中",
    toolName: "search_web",
    userText: "帮我对比一下这几个方案的区别",
    expected: "long_text",
  },
  {
    name: "numeric brief (KPI dense, no list) → plain（data_brief 已退役，数字密集正文不出卡）",
    text: "今日A股收盘：上证指数 3567.89 点，涨幅 +1.23%；创业板指 2876.54 点，涨幅 +2.01%；两市成交额 1.2万亿元，北向资金净流入 56 亿元。",
    expected: "plain",
  },
  {
    name: "weather tool prose (no list/kpi) → plain（打分层退役，天气卡由 L1 工具绑定承接）",
    text: "今天晴，气温 25°C，微风。",
    toolName: "weather.get_local",
    expected: "plain",
  },
  {
    name: "short text + 3-12 list items → result_card",
    text: "备忘：\n- 买菜\n- 取快递\n- 交水电费",
    expected: "result_card",
  },
  {
    name: "task-done + 2 list items → result_card",
    text: "已帮你记下：\n- 周三下午 3 点牙医预约\n- 周五交季度报告",
    expected: "result_card",
  },
  {
    name: "media search tool + list → result_card",
    text: "- 日落海滩 https://img.example.com/1.jpg\n- 雪山湖泊 https://img.example.com/2.jpg\n- 樱花街道 https://img.example.com/3.jpg",
    toolName: "search_images",
    expected: "result_card",
  },
  {
    name: "lead + 2-item list → plain（brief 退役只认 L2 声明；2 条目低于切卡门槛）",
    text: "今日待办：\n- 回复客户邮件\n- 提交报销单",
    expected: "plain",
  },
  {
    name: "long structured (≥800) → summary_card",
    text:
      "一、市场概况\n" +
      "本周A股市场整体呈现震荡上行格局，上证指数累计上涨 2.3%，深证成指上涨 1.8%，市场情绪整体偏暖，" +
      "两市成交额连续五个交易日维持在万亿元上方，显示增量资金仍在缓慢入场，投资者风险偏好有所回升。\n" +
      "二、板块表现\n" +
      "科技板块领涨，半导体与算力方向涨幅居前；新能源板块紧随其后，光伏产业链出现明显修复；消费板块" +
      "表现平淡，白酒与家电小幅回调；金融板块中银行股护盘迹象明显，券商股午后放量拉升，带动市场人气。\n" +
      "三、下周展望\n" +
      "关注美联储议息会议对全球市场流动性的影响，以及国内政策面的边际变化，重点留意宏观流动性预期与" +
      "产业政策落地节奏对风险偏好的扰动，同时警惕外部地缘因素带来的短期波动。\n" +
      "四、操作建议\n" +
      "建议保持均衡配置，逢低关注科技成长方向，控制整体仓位在六成以内，避免追高单一热门赛道，对高位股" +
      "保持谨慎，耐心等待缩量回踩后的低吸机会。\n" +
      "五、风险提示\n" +
      "以上内容仅为个人观察与梳理，不构成任何投资建议，市场有风险，决策需独立判断。\n" +
      "六、附注与口径说明\n" +
      "文中提到的涨跌幅均为本周收盘口径，成交额为沪深两市合并统计，北向资金数据来自交易所公开披露，" +
      "因统计时点差异可能与第三方平台存在小幅出入；板块涨跌以申万一级行业分类为准，个股表现以区间" +
      "涨跌幅度排序，剔除新股与停牌标的；文中引用的宏观数据均来自官方已发布的公开信息，涉及预期的" +
      "部分已明确标注为市场一致预期而非确定结果，读者在参考时需结合自身持仓结构与风险承受能力判断，" +
      "不宜将文中任何单一指标作为买卖依据。此外，文中涉及的行业景气度判断属于中期视角的定性描述，" +
      "与短期交易节奏并不等价；对于仓位较重或使用杠杆的读者，更应关注回撤控制与流动性安排，避免在" +
      "情绪波动较大的时段集中调仓；文中列举的历史区间表现仅用于说明波动特征，不代表未来收益的任何" +
      "承诺，若后续公开数据出现修订，相关结论需要同步更新，届时以最新披露口径为准；" +
      "本文所引用的历史区间数据仅供说明波动特征，读者如需据此操作，应自行完成交叉验证。",
    expected: "summary_card",
  },
  {
    name: "long plain paragraph (≥300, no structure) → long_text",
    text:
      "今天去了一趟老城区，走了很多小时候常走的巷子，很多店铺都换了模样，但巷口那家早餐店还在，" +
      "老板娘还是记得我爱吃甜豆浆配油条。坐在角落吃完早餐，看着来来往往的行人，忽然觉得时间过得" +
      "真快，城市一直在变，但总有些东西留了下来。回家的路上顺便去了趟书店，翻了几页散文集，心情" +
      "平静了很多。晚上把拍的照片整理了一下，挑了几张发给了朋友，他们说想下个月一起来走走，去" +
      "看看那家早餐店和巷子口的邮筒，还有小时候放学路上总要去买一本贴纸的小卖部。这些年大家各自" +
      "忙着自己的事情，见面的机会越来越少，但一说起小时候的事，话题就怎么也停不下来。这样的一天" +
      "没有什么大事发生，却让人觉得踏实，好像生活本来就应该是这个样子，慢慢悠悠，不慌不忙。",
    expected: "long_text",
  },
  {
    name: "short chat → plain",
    text: "好的，我知道了。",
    expected: "plain",
  },
  {
    name: "capability dump → plain",
    text:
      "当前可用工具列表：\nwallet.list\nwallet.transfer\nsearch_web\nfile.read\nweather.get\n" +
      "calendar.list_tasks\norder.query\nmedia.search",
    expected: "plain",
  },
  {
    name: "intent word + short no-list → long_text(structured)",
    text: "整理好了：三份材料已归档。",
    userText: "帮我把这些资料整理一下",
    expected: "long_text",
  },
  {
    name: "markdown table in short text → long_text",
    text: "| 型号 | 价格 |\n|---|---|\n| A | 100 |\n| B | 200 |",
    expected: "long_text",
  },
];
