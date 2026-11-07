import test from "node:test";
import assert from "node:assert/strict";

import {
  getToolResultProcessor,
  attachVideoMediaMarker,
  attachMediaSearchMarker,
  sanitizeModelCardBlocks,
} from "../src/services/tool-result-processor.js";
import { attachDeterministicCards } from "../src/services/deterministic-card-chain.js";
import { effectStatusOf } from "../src/render/index.js";
import { stripMarkersToPlainText } from "../src/services/reply-envelope.js";

/**
 * 展示形态覆盖回归（渲染管线 L1/L2/L3 每种形态一条独立用例）。
 *
 * 目标：agent 回复的每一种展示形态都必须能被管线确定性触发——
 * 本文件是"效果覆盖表格"的机器可读事实源：哪个用例绿了，对应形态就是可达的。
 * 形态清单与 docs/render-architecture-optimization-plan.md 对齐。
 */

const processor = getToolResultProcessor();

/** 从文本中解析第一个 [AGENT_RESULT_CARD_START] 卡片 JSON。 */
function parseCard(text: string): Record<string, any> {
  const si = text.indexOf("[AGENT_RESULT_CARD_START]");
  const ei = text.indexOf("[AGENT_RESULT_CARD_END]");
  assert.ok(si !== -1 && ei > si, `应包含完整卡片标记，实际输出：${text.slice(0, 200)}`);
  return JSON.parse(text.slice(si + "[AGENT_RESULT_CARD_START]".length, ei).trim());
}

function parseAllCards(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const re = /\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g;
  for (const m of text.matchAll(re)) out.push(JSON.parse(m[1].trim()));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// L2 生成时声明：[RENDER_HINT:] 整体形态
// ─────────────────────────────────────────────────────────────────────────────

test("L2 brief：模型声明 [RENDER_HINT:brief] → [RENDER_AS:brief] 简报形态", () => {
  const out = processor.processAssistantText(
    "[RENDER_HINT:brief]\n早上好呀。今天天气不错，适合出门。\n上午有一个例会，别忘记带笔记本。\n下午没什么安排，可以自由支配。",
    { userText: "今天有什么安排" },
  );
  assert.ok(out.startsWith("[RENDER_AS:brief]"), `实际输出：${out.slice(0, 120)}`);
  assert.ok(!out.includes("[RENDER_HINT:"), "hint 标记应被剥掉");
});

test("L2 structured：模型声明 [RENDER_HINT:structured] → [RENDER_AS:structured] 富文本形态", () => {
  const out = processor.processAssistantText(
    "[RENDER_HINT:structured]\n## 租房注意事项\n\n签约前要核对房产证与房东身份证。\n\n押金条款要写明退还条件。\n\n- 水电费结清方式\n- 维修责任划分",
    { userText: "租房要注意什么" },
  );
  assert.ok(out.startsWith("[RENDER_AS:structured]"), `实际输出：${out.slice(0, 120)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 生成时声明：模型卡片块（校验/归一化/非法丢弃）
// ─────────────────────────────────────────────────────────────────────────────

test("L2 卡片块：模型输出的 steps 卡通过校验并补齐默认字段", () => {
  const out = processor.processAssistantText(
    "好的，安装步骤如下：\n[AGENT_RESULT_CARD_START]\n" +
      JSON.stringify({
        cardType: "steps",
        title: "软件安装步骤",
        items: [
          { type: "num", text: "下载安装包" },
          { type: "num", text: "运行安装程序" },
          { type: "num", text: "完成初始化配置" },
        ],
        footer: "全程约 5 分钟",
      }) +
      "\n[AGENT_RESULT_CARD_END]\n需要更详细的哪一步可以再问我。",
    { userText: "怎么安装这个软件" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "steps");
  assert.equal(card.title, "软件安装步骤");
  assert.equal(card.items.length, 3);
  // 归一化默认字段（与 formatAgentResultForChat 产物同构）
  assert.equal(card.avatar, "NB");
  assert.ok(typeof card.cardId === "string" && card.cardId.startsWith("card_"));
  assert.deepEqual(card.actions, []);
  // 前后正文保留
  assert.ok(out.includes("好的，安装步骤如下"));
  assert.ok(out.includes("需要更详细的哪一步"));
});

test("L2 卡片块：comparison_table 带 side A/B 的对比卡原样可达", () => {
  const out = processor.processAssistantText(
    "两个方案对比好了：\n[AGENT_RESULT_CARD_START]\n" +
      JSON.stringify({
        cardType: "comparison_table",
        title: "方案怎么选",
        items: [
          { type: "num", text: "价格便宜", side: "A", sideLabel: "地铁房" },
          { type: "num", text: "通勤 10 分钟", side: "A", sideLabel: "地铁房" },
          { type: "num", text: "价格贵 800/月", side: "B", sideLabel: "公司旁" },
          { type: "num", text: "通勤 5 分钟", side: "B", sideLabel: "公司旁" },
        ],
      }) +
      "\n[AGENT_RESULT_CARD_END]",
    { userText: "租房选地铁房还是公司旁" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "comparison_table");
  assert.equal(card.items.filter((i: any) => i.side === "A").length, 2);
  assert.equal(card.items.filter((i: any) => i.side === "B").length, 2);
});

test("L2 卡片块：JSON 损坏的模型卡整块丢弃，不泄漏原始 JSON", () => {
  const out = processor.processAssistantText(
    "结论如下：\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"steps\",\"title\":\"坏掉的卡\",,,\n[AGENT_RESULT_CARD_END]\n完啦",
    { userText: "测试" },
  );
  assert.ok(!out.includes("AGENT_RESULT_CARD"), `损坏块应被丢弃：${out}`);
  assert.ok(!out.includes("坏掉的卡"));
  assert.ok(out.includes("结论如下"));
});

test("L2 卡片块：缺 title / 空 items 的模型卡整块丢弃", () => {
  const out = processor.processAssistantText(
    "[AGENT_RESULT_CARD_START]\n" +
      JSON.stringify({ cardType: "steps", items: [] }) +
      "\n[AGENT_RESULT_CARD_END]",
    {},
  );
  assert.ok(!out.includes("AGENT_RESULT_CARD"), `应丢弃：${out}`);
});

test("sanitizeModelCardBlocks：条目字段白名单过滤 + 条目截断到 12", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ type: "num", text: `条目${i + 1}` }));
  const raw =
    "[AGENT_RESULT_CARD_START]\n" +
    JSON.stringify({ cardType: "fold_list", title: "清单", items: [{ type: "num", text: "a", evil: "x" }, ...items] }) +
    "\n[AGENT_RESULT_CARD_END]";
  const out = sanitizeModelCardBlocks(raw);
  const card = parseCard(out);
  assert.ok(card.items.length <= 12);
  assert.equal(card.items[0].evil, undefined, "白名单外字段应被剥掉");
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 确定性规则路由：markdown 结构信号（打分层已退役，只认硬形态）
// ─────────────────────────────────────────────────────────────────────────────

test("L3 metric：标签数值 markdown 列表 → metric 数据面板卡", () => {
  const out = processor.processAssistantText(
    "本月支出概况如下：\n- 餐饮：3500元\n- 交通：800元\n- 娱乐：1200元",
    { userText: "帮我总结下这个月支出" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "metric", `实际输出：${out.slice(0, 300)}`);
});

test("L3 timeline：时间戳 markdown 列表 → timeline 时间轴卡", () => {
  const out = processor.processAssistantText(
    "明天的安排是这样的：\n- 09:30 部门例会\n- 14:00 客户拜访\n- 18:30 健身",
    { userText: "明天怎么安排" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "timeline", `实际输出：${out.slice(0, 300)}`);
});

test("L3 steps：编号步骤列表 → steps 步骤卡", () => {
  const out = processor.processAssistantText(
    "wifi 安装步骤如下：\n1. 连接光猫网线\n2. 登录管理后台\n3. 设置 wifi 名称密码",
    { userText: "wifi 怎么安装" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "steps", `实际输出：${out.slice(0, 300)}`);
});

test("L3 守卫：无 markdown 结构的口语散文保持纯文本（散文打分已退役）", () => {
  // 语义打分层退役后，无列表/表格等硬结构信号的散文一律纯文本；
  // 模型声明（L2 卡片块/RENDER_HINT）才是散文上卡的通道。
  const out = processor.processAssistantText(
    "路由器重置只需两步，先长按 reset 键 8 秒，然后重新配置拨号上网就好了。",
    { userText: "路由器怎么重置" },
  );
  assert.ok(!out.includes("[AGENT_RESULT_CARD"), `不应上卡：${out.slice(0, 200)}`);
});

test("L3 quote：markdown 引用块 → quote 引用强调卡", () => {
  const out = processor.processAssistantText(
    "这本书里有句话特别好：\n> 种一棵树最好的时间是十年前，其次是现在。\n shared给你",
    { userText: "有什么好书摘推荐" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "quote", `实际输出：${out.slice(0, 300)}`);
});

test("L3 progress：百分比 markdown 列表 → progress 进度卡", () => {
  const out = processor.processAssistantText(
    "装修进度：\n- 水电改造 90%\n- 瓦工贴砖 60%\n- 木工进场 30%",
    { userText: "装修进度整理" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "progress", `实际输出：${out.slice(0, 300)}`);
});

test("L3 summary_card：超长结构化文档 → CONTENT_SUMMARY_V2 折叠摘要", () => {
  // 设计口径：summary_card = ≥800 字 + 结构化（板块/表格/列表混排）+ 主题可判
  // （主题判不出来时退富文本，不挂类目名硬折叠）。
  const longDoc =
    "## 城郊花鸟市场半日游记\n\n昨天我去了一趟城郊的花鸟市场，本来只是想随便逛逛，结果一进门就被门口那排多肉摊位吸住了。\n\n" +
    "### 多肉区\n摊主是位六十多岁的大爷，跟我讲了半个多小时怎么配土、怎么控水，还送了我两小盆砍头苗。\n" +
    "我最后买了三盆，加上送的一共五盆，总共花了四十块钱。他还教我怎么看叶片的饱满度，说买回去先别急着换盆，" +
    "放在散光的地方缓上一周，等根系稳住再动土，不然很容易黑腐。\n\n" +
    "### 水族区\n一整排鱼缸灯光打下来特别好看，我站在一个草缸前看了很久，缸里有一群红灯笼鱼游来游去。\n" +
    "老板说这缸造景他做了三个月，水草泥用的进口的，沉木是自己去山里捡的。他还提醒我，新手别一上来就养草缸，" +
    "先从裸缸配几条皮实的鱼练手，等水质稳定了再考虑水草和造景，不然光是藻类就够折腾的。\n\n" +
    "### 鸟区\n八哥会说话，鹦鹉会握手，最热闹的是一笼虎皮鹦鹉，叽叽喳喳吵得不行。老板说虎皮皮实好养，" +
    "但真要养得亲人，得每天固定时间上手互动，喂食的时候叫它的名字，时间长了它自己会往你手上凑。\n\n" +
    "最后拎着一袋多肉、一袋鱼食和一包鸟粮回家，感觉一下子回到了小时候逛集市的快乐。回来的公交上我一直在想，" +
    "这种烟火气十足的地方在城市里越来越少了，趁它还在，多去几次。到家之后我把多肉摆在阳台上，把鱼食收进柜子里，" +
    "又给家里那缸旧鱼换了水，忙完一抬头天都黑了。晚饭随便煮了碗面，吃的时候还在翻白天拍的照片，越看越觉得不虚此行。" +
    "下次打算早点去，赶在开市的时候看看新到的货，顺便问问老板有没有靠谱的养鱼社群可以一起交流。\n\n" +
    "### 花市区\n花市那边反而清净些，摊位上摆的多是绿萝、龟背竹这类好养的绿植，老板说最近卖得最好的是小型观叶，" +
    "年轻人租的房子不大，一盆放窗台就够了。我看中一盆琴叶榕，犹豫了半天没买，主要是怕自己出差多、照顾不过来，" +
    "回来路上还惦记着，想着下次要是还在就直接搬回家，顺便再挑一个尺寸合适的陶盆，配起来应该挺好看。回来的路上顺带买了两斤橘子，酸酸甜甜，正好解渴。";
  assert.ok(longDoc.length >= 800, `文本应≥800字，实际 ${longDoc.length}`);
  const out = processor.processAssistantText(longDoc, { userText: "讲讲你昨天去哪了" });
  assert.ok(
    out.includes("[CONTENT_SUMMARY_V2_START]"),
    `结构化长文应折叠摘要，实际输出前 200 字：${out.slice(0, 200)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 工具绑定：注册工具结构化回执直出卡
// ─────────────────────────────────────────────────────────────────────────────

test("L1 search_web：不回搜索卡，正文原样（2026-11-05 定稿：搜索只喂模型）", () => {
  const text = "帮你查了三篇口碑最高的攻略，要点我放在下面了。";
  const out = processor.processAssistantText(text, {
    toolName: "search_web",
    toolResult: {
      provider: "tavily",
      items: [
        { title: "鼓浪屿两日游攻略", url: "https://example.com/a", snippet: "经典路线", source: "马蜂窝" },
        { title: "厦门美食地图", url: "https://example.com/b", snippet: "八市全收录", source: "知乎" },
        { title: "环岛路骑行指南", url: "https://example.com/c", snippet: "日落时段推荐", source: "小红书" },
      ],
    },
  });
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `不应出搜索卡：${out.slice(0, 300)}`);
  assert.ok(out.includes("帮你查了三篇"), "模型正文应完整保留");
  // 搜索条目/来源/链接一律不上屏
  assert.ok(!out.includes("example.com"), "不应透出网址");
  assert.ok(!out.includes("马蜂窝"), "不应透出来源站点");
  assert.ok(!out.includes("鼓浪屿两日游攻略"), "不应逐条复述搜索条目");
});

test("L1 search 无卡：有图轮次与零图轮次都不附搜索卡", () => {
  const text = "照片都找出来了，近况在正文里说过了。";
  const withMedia = attachDeterministicCards({
    text,
    searchResults: [{
      toolName: "search_web",
      result: { items: [{ title: "不该出现的条目", url: "https://example.com/x", snippet: "s" }] },
    }],
    searchMediaHasItems: true,
  });
  assert.equal(withMedia, text, "有媒体主形态时原文返回");
  const noMedia = attachDeterministicCards({
    text,
    searchResults: [{
      toolName: "search_web",
      result: { items: [{ title: "不该出现的条目", url: "https://example.com/x", snippet: "s" }] },
    }],
  });
  assert.equal(noMedia, text, "零图兜底也不再附搜索卡");
});

test("L1 weather：weather.get_local 回执 → weather 专用卡", () => {
  const out = processor.processAssistantText("今天出门记得带伞。", {
    toolName: "weather.get_local",
    toolResult: {
      weatherText: "中雨 26°C",
      todayRangeC: "24~28°C",
      humidityPct: 88,
      windKmh: 12,
      peakRainPct: 70,
      locationLabel: "上海",
      clothingAdvice: "湿度大，穿速干衣物",
    },
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "weather");
  assert.equal(card.items[0].text, "中雨 26°C");
});

test("不变量：载荷自报 ok:false 的天气回执不出卡（空态警示卡已退役），失败由正文承担", () => {
  const out = processor.processAssistantText("这次没拿到天气数据。", {
    toolName: "weather.get_local",
    toolResult: { ok: false, error: "没有拿到真实定位，也没有可解析的城市名。" },
  });
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `失败轮不应出任何卡：${out.slice(0, 200)}`);
  assert.ok(!out.includes('"error"'), "工具载荷原文不应透出到正文");
});

test("不变量：effectStatusOf 按载荷真话归类", () => {
  assert.equal(effectStatusOf({ ok: false, error: "x" }), "error");
  assert.equal(effectStatusOf({ ok: true, temp: 1 }), "ok");
  assert.equal(effectStatusOf({ temp: 1 }), "ok");
  assert.equal(effectStatusOf(undefined), "ok");
  assert.equal(effectStatusOf({ ok: false }, true), "error");
});

test("不变量：行程载荷自报失败不附行程卡", () => {
  const out = attachDeterministicCards({
    text: "这轮行程没排出来。",
    travelToolName: "travel.plan-itinerary",
    travelResult: { ok: false, error: "没有找到符合条件的航班" },
  });
  assert.ok(!out.includes("travel_itinerary"), "失败载荷不该建行程卡");
});

test("L1 wallet：wallet.get_balance 回执 → wallet 专用卡", () => {
  const out = processor.processAssistantText("余额查好了。", {
    toolName: "wallet.get_balance",
    toolResult: { balance: 12345.67, currency: "CNY", summary: "人民币余额" },
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "wallet");
  assert.ok(card.items[0].text.includes("12345.67"));
});

test("L1 calendar：calendar.list_tasks 回执 → schedule 专用卡", () => {
  const out = processor.processAssistantText("明天有两个安排。", {
    toolName: "calendar.list_tasks",
    toolResult: {
      tasks: [
        { title: "部门例会", start: "2026-09-16T09:30:00" },
        { title: "牙医复诊", start: "2026-09-16T14:00:00" },
      ],
    },
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "schedule");
  assert.ok(card.items.length >= 2);
});

test("L1 比价：shopping.compare.prices 回执 → 比价结果卡", () => {
  const out = processor.processAssistantText("比价结果在这。", {
    toolName: "shopping.compare.prices",
    toolResult: {
      query: "戴森 V8 吸尘器",
      groups: [
        {
          matchType: "exact",
          offers: [
            { platform: "京东", title: "戴森 V8 Fluffy", priceCny: 1899, shop: "京东自营" },
            { platform: "天猫", title: "戴森 V8 Fluffy", priceCny: 2099, shop: "官方旗舰店" },
          ],
        },
        {
          matchType: "similar",
          offers: [{ platform: "拼多多", title: "戴森 V8 翻新版", priceCny: 1299, shop: "第三方" }],
        },
      ],
    },
  });
  const card = parseCard(out);
  // 比价卡已升级为专属 price_compare 卡型（结构化分组报价走 priceCompare 字段）
  assert.ok(card.title.includes("比价结果"), `实际标题：${card.title}`);
  assert.ok(card.items.every((i: any) => i.type === "num"));
  assert.ok(card.items[0].text.includes("1899"), `实际条目：${card.items[0].text}`);
});

test("L1 订单：shopping.order.list 回执 → order 专用卡", () => {
  const out = processor.processAssistantText("你的订单如下。", {
    toolName: "shopping.order.list",
    toolResult: {
      count: 2,
      orders: [
        { platform: "淘宝", title: "机械键盘", amountCny: 399, status: "paid" },
        { platform: "京东", title: "显示器支架", amountCny: 159, status: "shipped" },
      ],
    },
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "order");
});

// ─────────────────────────────────────────────────────────────────────────────
// 确定性抢救：模型脏 JSON 不透出，直接转卡
// ─────────────────────────────────────────────────────────────────────────────

test("抢救：模型回显搜索原始 JSON → 剥掉 JSON，不转卡", () => {
  const out = processor.processAssistantText(
    "查到了：\n" +
      JSON.stringify({
        items: [
          { title: "结果一", url: "https://example.com/x1", snippet: "s", source: "a" },
          { title: "结果二", url: "https://example.com/x2", snippet: "s", source: "b" },
        ],
        provider: "tavily",
      }),
    { toolName: "search_web" },
  );
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), "不再把搜索 JSON 转成卡");
  assert.ok(!out.includes('"provider"'), "原始 JSON 不应透出");
  assert.ok(!out.includes("example.com"), "来源链接不应透出");
  assert.equal(out.trim(), "", "整条只有公告句 + JSON 时不下发任何内容");
});

test("抢救：模型回显搜索 JSON 后还有正文 → 只留正文", () => {
  const out = processor.processAssistantText(
    "以下是搜索结果：\n" +
      JSON.stringify({
        items: [{ title: "唯一结果", url: "https://example.com/only", snippet: "s", source: "a" }],
        provider: "tavily",
      }) +
      "\n\n想了解哪条我再细讲。",
    { toolName: "search_web" },
  );
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(!out.includes('"provider"'), "原始包络不应透出到正文");
  assert.ok(!out.includes("以下是搜索结果"), "公告句丢弃");
  assert.equal(out.trim(), "想了解哪条我再细讲。", "模型自己写的收尾句保留");
});

test("抢救：模型回显行程 JSON → travel_itinerary 双面板卡", () => {
  const itinerary = JSON.stringify({
    ok: true,
    title: "马尔代夫2日游",
    destination: "马尔代夫",
    days: [
      {
        date: "2026-08-30",
        items: [
          { type: "hotel", name: "当地民宿", startTime: "2026-08-30T08:00:00" },
          { type: "attraction", name: "环礁浮潜", startTime: "2026-08-30T09:00:00" },
        ],
      },
    ],
  });
  const out = processor.processAssistantText(itinerary, { toolName: "travel.plan-itinerary" });
  const card = parseCard(out);
  assert.equal(card.cardType, "travel_itinerary");
  // 2026-09-17：行程卡不自动展开双面板，卡面直接逐日展示安排
  assert.equal(card.autoOpen, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 专项形态：image_result / video / media（data_brief 已退役 2026-11-06）
// ─────────────────────────────────────────────────────────────────────────────

test("形态 data_brief 退役：KPI 富集短报不再切快报卡，正文原样", () => {
  const out = processor.processAssistantText(
    "今日A股收盘：上证指数 3245.6 点，深证成指 10567.8 点，创业板指 2112.3 点。两市成交额 9800 亿元，北向资金净流入 45.2 亿元。",
    { userText: "今天股市怎么样" },
  );
  assert.ok(!out.includes("[RENDER_AS:data_brief]"), `实际输出：${out.slice(0, 200)}`);
  assert.ok(!out.includes("[DATA_BRIEF_START]"));
  assert.ok(out.includes("上证指数"), "正文应原样保留");
});

test("形态 image_result：识图工具 → [RENDER_AS:image_result]", () => {
  const out = processor.processAssistantText("照片里是一只橘猫，趴在键盘上睡觉，旁边有一杯咖啡。", {
    toolName: "vision.recognize",
    userText: "帮我看看这张照片",
  });
  assert.ok(out.startsWith("[RENDER_AS:image_result]"), `实际输出：${out.slice(0, 200)}`);
});

test("形态 video：video.grab 回执 → [RENDER_AS:video] + 内联播放块", () => {
  const out = attachVideoMediaMarker("找到了这个视频，直接点开看。", "video.grab", {
    videoUrl: "https://cdn.example.com/v.mp4",
    playPageUrl: "https://www.example.com/watch/1",
    title: "测试视频",
  });
  assert.ok(out.startsWith("[RENDER_AS:video]"));
  assert.ok(out.includes("[VIDEO_MEDIA_START]"));
  const block = out.slice(out.indexOf("[VIDEO_MEDIA_START]") + "[VIDEO_MEDIA_START]".length, out.indexOf("[VIDEO_MEDIA_END]"));
  const payload = JSON.parse(block.trim());
  assert.ok(String(payload.mediaUrl).includes("/agent/media/proxy"));
});

test("形态 media：search_images 回执 → media 卡片注入", () => {
  const out = attachMediaSearchMarker("这些图给你参考。", "search_images", {
    items: [
      { title: "图一", thumbnailUrl: "https://example.com/t1.png", mediaUrl: "https://example.com/m1.png" },
      { title: "图二", thumbnailUrl: "https://example.com/t2.png", mediaUrl: "https://example.com/m2.png" },
    ],
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "media");
  assert.equal(card.items.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 纯文本守卫：不该上卡的内容保持纯文本
// ─────────────────────────────────────────────────────────────────────────────

test("守卫：日常闲聊不上任何卡/标记", () => {
  const out = processor.processAssistantText("好呀，那就周六见！到时候我带点水果过去。", {
    userText: "周六聚一下？",
  });
  assert.ok(!out.includes("[AGENT_RESULT_CARD"), `闲聊不应出卡：${out}`);
  assert.ok(!out.includes("[RENDER_AS:"), `闲聊不应有形态标记：${out}`);
});

test("守卫：markdown 表格/代码块原样透传（客户端自渲染）", () => {
  const md =
    "对比如下：\n\n| 方案 | 价格 | 耗时 |\n| --- | --- | --- |\n| 高铁 | 550 | 6h |\n| 飞机 | 900 | 2h |\n\n```python\nprint('hi')\n```";
  const out = processor.processAssistantText(md, { userText: "高铁和飞机对比" });
  assert.ok(out.includes("| 方案 | 价格 | 耗时 |"), "表格应原样保留");
  assert.ok(out.includes("```python"), "代码块应原样保留");
});

// ─────────────────────────────────────────────────────────────────────────────
// plain 渠道编码器：同一富管线产物按渠道能力降级
// ─────────────────────────────────────────────────────────────────────────────

test("plain 编码：卡片块/标记还原为可读纯文本，JSON 绝不透出", () => {
  const rich =
    "帮你查好了：\n[AGENT_RESULT_CARD_START]\n" +
    JSON.stringify({
      avatar: "NB",
      title: "要点",
      items: [
        { type: "num", text: "攻略一: 要点", url: "https://example.com/a" },
        { type: "num", text: "攻略二: 要点", url: "https://example.com/b" },
      ],
      footer: "共 2 条",
      cardType: "",
      cardId: "card_x",
    }) +
    "\n[AGENT_RESULT_CARD_END]\n\n[RENDER_HINT:brief]\n需要我深入哪一篇？";
  const plain = stripMarkersToPlainText(rich);
  assert.ok(!plain.includes("AGENT_RESULT_CARD"), plain);
  assert.ok(!plain.includes("RENDER_HINT"), plain);
  assert.ok(!plain.includes('{"avatar"'), "JSON 不应透出");
  assert.ok(plain.includes("要点"));
  assert.ok(plain.includes("· 攻略一: 要点"));
  assert.ok(plain.includes("共 2 条"));
  assert.ok(plain.includes("帮你查好了"));
  assert.ok(plain.includes("需要我深入哪一篇？"));
});

test("plain 编码：损坏卡片块整块丢弃", () => {
  const plain = stripMarkersToPlainText(
    "结论：\n[AGENT_RESULT_CARD_START]\n{\"broken\":,,\n[AGENT_RESULT_CARD_END]\n完",
  );
  assert.ok(!plain.includes("broken"));
  assert.ok(plain.includes("结论"));
});
