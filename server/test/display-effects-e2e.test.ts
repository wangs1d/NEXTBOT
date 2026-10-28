/**
 * 展示效果端到端触发测试（真实轮次回放）。
 *
 * 与既有单测的区别：单测验证「给定理想输入，纯函数产出正确的卡」；
 * 本文件回放 chat-user-message done 阶段的**真实处理顺序**——
 *   1. processAssistantText（tool-loop 路径条件：reply.toolName/toolResult 均空）
 *   2. attachDeterministicCards（行程→天气→搜索→注册工具→视频，与 handler 同序）
 * 验证每一种文本展示效果在真实链路条件下确实被触发，而不是只验证函数正确。
 *
 * 背景：weather/wallet/calendar/shopping/video 的附卡此前只接在单工具直跑
 * 路径上，单测全绿但真实对话全部漏卡。本文件就是防回归的接线层测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getToolResultProcessor,
  extractMediaCards,
} from "../src/services/tool-result-processor.js";
import {
  attachDeterministicCards,
  type ExecutedToolReceipt,
} from "../src/services/deterministic-card-chain.js";

const processor = getToolResultProcessor();

interface ExecutedScenario {
  weather?: ReadonlyArray<ExecutedToolReceipt>;
  search?: ReadonlyArray<ExecutedToolReceipt>;
  registry?: ReadonlyArray<ExecutedToolReceipt>;
  video?: ReadonlyArray<ExecutedToolReceipt>;
  travel?: { toolName: string; result: Record<string, unknown> };
  /** 搜索类媒体（search_images 等）有真实产出 → 文字搜索卡让位 */
  searchMediaHasItems?: boolean;
}

/** 回放一次真实 tool-loop 轮次：LLM 末轮只输出正文，工具回执从回调聚合。 */
function runLoopTurn(userText: string, llmFinalText: string, executed: ExecutedScenario = {}): string {
  // ① processAssistantText：loop 路径下 toolName/toolResult 均为空
  let finalText = processor.processAssistantText(llmFinalText, {
    userText,
    toolName: undefined,
    toolResult: undefined,
  });
  // ② done 阶段确定性附卡链（与 chat-user-message.ts 完全同序）
  finalText = attachDeterministicCards({
    text: finalText,
    travelToolName: executed.travel?.toolName,
    travelResult: executed.travel?.result,
    weatherResults: executed.weather,
    searchResults: executed.search,
    searchMediaHasItems: executed.searchMediaHasItems,
    registryResults: executed.registry,
    videoResults: executed.video,
  });
  return finalText;
}

/** 与前端 AgentResultParser 相同协议的卡块解析（marker + JSON）。 */
function parseCardBlock(text: string): Record<string, unknown> | null {
  const m = text.match(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─────────────────────────── L1 工具绑定卡（确定性） ───────────────────────────

test("weather: 天气问答 → 口语前导 + weather 卡（真实回归场景）", () => {
  const out = runLoopTurn(
    "明天天气怎么样",
    "王哥，明天兴义有毛毛雨，19-25°C，降水概率 92%——出门带把伞，薄外套够了。",
    {
      weather: [
        {
          toolName: "weather.get_local",
          result: {
            ok: true,
            summary: "明天兴义有毛毛雨",
            weatherText: "毛毛雨",
            todayRangeC: "19–25",
            humidityPct: 88,
            windKmh: 9,
            peakRainPct: 92,
            clothingAdvice: "出门带把伞，薄外套够了",
            locationLabel: "贵州 · 兴义",
          },
        },
      ],
    },
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 weather 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "weather");
  assert.ok(out.startsWith("王哥，明天兴义有毛毛雨"), "LLM 口语前导正文应保留在卡前");
  const items = card.items as Array<{ text: string }>;
  assert.ok(items.some((i) => i.text.includes("92%")), "降水概率应进卡条目");
  assert.equal(card.footer, "出门带把伞，薄外套够了");
});

test("search: 新闻搜索 → search_result 卡（条目带 url）", () => {
  const out = runLoopTurn("最近有什么科技新闻", "帮你扫了眼今天科技圈的新鲜事：", {
    search: [
      {
        toolName: "search_web",
        result: {
          ok: true,
          items: [
            { title: "某厂发布新芯片", url: "https://news.example.com/a", snippet: "3nm 工艺量产" },
            { title: "开源模型登顶榜单", url: "https://news.example.com/b", snippet: "评测分数创新高" },
            { title: "卫星互联网新进展", url: "https://news.example.com/c", snippet: "低轨组网加速" },
          ],
        },
      },
    ],
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 search_result 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "search_result");
  const items = card.items as Array<{ url?: string }>;
  assert.ok(items.length >= 3);
  assert.ok(items.every((i) => !!i.url), "每个条目应带 url 供前端跳转");
});

test("search×media 意图仲裁：搜照片轮次带 search_web 回执 → 文字卡整卡让位", () => {
  // 真实场景（2026-09-22 17:26 轮）：规划波次并行派 search_images + search_web，
  // 照片经 mediaCards 渲染后，8 条文字搜索列表再叠一张卡属冗余（用户定调）。
  const out = runLoopTurn(
    "搜索她的照片",
    "她的近况照片帮你看了一圈，最近的动态也在正文里说过了。",
    {
      searchMediaHasItems: true,
      search: [
        {
          toolName: "search_web",
          result: {
            ok: true,
            items: [
              { title: "刘浩存 2026-08-07 专访", url: "https://news.example.com/a", snippet: "央视专访" },
              { title: "刘浩存-维基百科", url: "https://wiki.example.com/b", snippet: "剧目列表" },
            ],
          },
        },
      ],
    },
  );
  assert.equal(parseCardBlock(out), null, `有图轮次不应附任何文字卡，实际: ${out.slice(0, 300)}`);
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), "不应残留卡片标记");
  assert.ok(out.startsWith("她的近况照片帮你看了一圈"), "口语正文应完整保留");
});

test("search×media 零图兜底：搜图全挂时文字卡照常附", () => {
  const searchReceipts: ReadonlyArray<ExecutedToolReceipt> = [
    {
      toolName: "search_web",
      result: {
        ok: true,
        items: [{ title: "唯一的信息来源", url: "https://news.example.com/a", snippet: "s" }],
      },
    },
  ];
  // searchMediaHasItems 缺省（= 媒体 0 产出）→ 不让位，文字卡兜底
  const out = runLoopTurn("搜索她的照片", "照片源这轮没拿到，先把查到的资料放这里。", {
    search: searchReceipts,
  });
  const card = parseCardBlock(out);
  assert.ok(card, `零图轮应兜底附文字卡，实际: ${out.slice(0, 300)}`);
  assert.equal(card.cardType, "search_result");
});

test("wallet: 查余额 → wallet 卡", () => {
  const out = runLoopTurn("我还有多少钱", "查了一下，你的余额情况在这里：", {
    registry: [
      { toolName: "wallet.get_balance", result: { ok: true, balance: 1286.5, currency: "CNY" } },
    ],
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 wallet 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "wallet");
  assert.equal(card.title, "钱包余额");
});

test("schedule: 查日程 → schedule 卡", () => {
  const out = runLoopTurn("我今天有什么安排", "今天的日程帮你看过了：", {
    registry: [
      {
        toolName: "calendar.list_tasks",
        result: {
          ok: true,
          count: 2,
          tasks: [
            { title: "项目周会", nextRunAt: "2026-09-16T10:00:00" },
            { title: "给妈妈打电话", nextRunAt: "2026-09-16T20:00:00" },
          ],
        },
      },
    ],
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 schedule 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "schedule");
  assert.equal((card.items as unknown[]).length, 2);
});

test("order: 查订单 → order 卡", () => {
  const out = runLoopTurn("我最近的订单到哪了", "你的订单状态都帮你确认了：", {
    registry: [
      {
        toolName: "shopping.order.list",
        result: {
          ok: true,
          count: 2,
          orders: [
            { platform: "京东", title: "机械键盘", status: "shipped", amountCny: 349 },
            { platform: "淘宝", title: "咖啡豆", status: "paid", amountCny: 89 },
          ],
        },
      },
    ],
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 order 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "order");
});

test("compare prices: 比价 → 专属 price_compare 卡", () => {
  const out = runLoopTurn("这款耳机哪里买便宜", "三个平台的价格我都比了一遍：", {
    registry: [
      {
        toolName: "shopping.compare.prices",
        result: {
          ok: true,
          query: "无线耳机",
          groups: [
            {
              matchType: "exact",
              offers: [{ priceCny: 299, platform: "京东", title: "无线耳机", shop: "官方旗舰店" }],
            },
            {
              matchType: "exact",
              offers: [{ priceCny: 289, platform: "拼多多", title: "无线耳机", shop: "数码专营店" }],
            },
          ],
          bestOffer: { priceCny: 289, platform: "拼多多" },
        },
      },
    ],
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上比价卡，实际文本: ${out}`);
  assert.equal(card.cardType, "price_compare");
  assert.ok(Array.isArray(card.priceCompare?.groups));
  assert.ok(String(card.title).includes("比价结果"));
});

test("travel: 规划行程 → travel_itinerary 卡", () => {
  const out = runLoopTurn("帮我规划去大理玩两天", "大理两天的行程给你排好了，慢慢看：", {
    travel: {
      toolName: "travel.plan-itinerary",
      result: {
        ok: true,
        destination: "大理",
        title: "大理两日慢游",
        days: [
          {
            date: "2026-09-20",
            items: [
              { type: "attraction", name: "洱海生态廊道", startTime: "09:30" },
              { type: "food", name: "喜洲破酥粑粑", startTime: "12:00" },
            ],
          },
          {
            date: "2026-09-21",
            items: [{ type: "attraction", name: "崇圣寺三塔", startTime: "10:00" }],
          },
        ],
      },
    },
  });
  const card = parseCardBlock(out);
  assert.ok(card, `应附上 travel_itinerary 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "travel_itinerary");
  assert.ok(card.travelPlan, "行程卡应携带结构化 travelPlan");
});

test("media: 搜图 → mediaCards 结构化字段（独立下发，非文本标记）", () => {
  const cards = extractMediaCards("search_images", {
    ok: true,
    items: [
      {
        title: "洱海日落",
        thumbnailUrl: "https://img.example.com/erhai_thumb.jpg",
        mediaUrl: "https://img.example.com/erhai.jpg",
        width: 1600,
        height: 900,
        source: "示例图库",
      },
      {
        title: "古城夜景",
        thumbnailUrl: "https://img.example.com/gucheng.jpg",
        mediaUrl: "https://img.example.com/gucheng_full.jpg",
        width: 1200,
        height: 800,
      },
    ],
  });
  assert.ok(cards.length === 2, `应提取出 2 张媒体卡，实际 ${cards.length}`);
  assert.equal(cards[0].type, "image");
  assert.ok(cards[0].thumbnailUrl, "缩略图地址必须存在，否则前端无图可渲染");
});

test("video: 解析视频链接 → [RENDER_AS:video] + [VIDEO_MEDIA_START] 媒体标记", () => {
  const out = runLoopTurn("这个视频帮我解析下", "解析好了，直接点开就能看：", {
    video: [
      {
        toolName: "video.grab",
        result: {
          ok: true,
          videoUrl: "https://proxy.example.com/stream/x.mp4",
          playPageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "示例视频",
        },
      },
    ],
  });
  assert.ok(out.includes("[RENDER_AS:video]"), `应带视频渲染标记，实际文本: ${out}`);
  assert.ok(out.includes("[VIDEO_MEDIA_START]"), "应带视频媒体块");
});

// ─────────────────────── L2 / 文本形态效果（模型输出形态驱动） ───────────────────────

test("steps: 口语化步骤回答（编号列表）→ steps 卡", () => {
  const out = runLoopTurn(
    "路由器总连不上怎么办",
    "路由器连不上可以先这样排查：\n1. 拔掉电源等半分钟再插回去\n2. 确认光猫的指示灯是绿色常亮\n3. 用手机连 2.4G 频段再试一次\n都不行的话跟我说下卡在第几步。",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 steps 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "steps");
});

test("metric: 参数罗列（标签：数值）→ metric 卡", () => {
  const out = runLoopTurn(
    "这台手机的参数怎么样",
    "这台机器的关键参数给你列一下：\n- 重量：199克\n- 屏幕：6.7英寸\n- 电池：5000毫安\n- 厚度：7.8毫米",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 metric 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "metric");
});

test("timeline: 带钟点的日程 → timeline 卡", () => {
  const out = runLoopTurn(
    "帮我看看周六安排",
    "周六的安排给你排好了：\n- 09:30 朝阳区图书馆还书\n- 14:00 剪头发\n- 18:30 老张的生日饭局",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 timeline 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "timeline");
});

test("progress: 百分比进度 → progress 卡", () => {
  const out = runLoopTurn(
    "这周任务进展如何",
    "这周的任务进展：\n- 代码评审 80%\n- 单元测试 65%\n- 文档更新 40%",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 progress 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "progress");
});

test("chips: 短标签并列 → chips 卡", () => {
  const out = runLoopTurn(
    "周末去哪玩比较好",
    "周末可以考虑这几个地方：\n- 环湖绿道\n- 旧书市集\n- 滨江夜市\n- 美术馆\n- 天文馆",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 chips 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "chips");
});

test("fold_list: 8 条以上带数量的长清单 → fold_list 卡", () => {
  const out = runLoopTurn(
    "周末露营要带什么",
    "采购清单我给你列全了：\n- 牛奶 2盒\n- 鸡蛋 1打\n- 吐司 1袋\n- 苹果 3个\n- 咖啡豆 1包\n- 泡面 1箱\n- 矿泉水 1提\n- 纸巾 1提",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 fold_list 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "fold_list");
});

test("comparison_table: 方案A/B 成对对比 → comparison_table 卡", () => {
  const out = runLoopTurn(
    "这两台笔记本怎么选",
    "两台对比下来是这样：\n- 方案A：轻薄便携，适合差旅\n- 方案B：性能强劲，适合剪辑\n- 方案A：续航 12 小时\n- 方案B：续航 8 小时",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 comparison_table 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "comparison_table");
});

test("quote: markdown 引用块 → quote 卡", () => {
  const out = runLoopTurn(
    "聊聊我最近总失眠的事",
    "聊了这么多，其实就一句话：\n> 先把睡眠稳住，其他的事都有解。\n昨晚十一点放下手机试试看。",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 quote 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "quote");
  assert.ok(String(card.title).includes("睡眠"), "引用正文应作为卡标题");
});

test("data_brief: 数字密集快报 → [RENDER_AS:data_brief] + KPI payload", () => {
  const out = runLoopTurn(
    "今天行情怎么样",
    "今天A股收盘，创业板指报 2876.54 点（+2.01%），两市全天成交额 1.2万亿，北向资金净流入 85.6亿，半导体板块领涨，涨幅达到 3.2%。",
  );
  assert.ok(out.includes("[RENDER_AS:data_brief]"), `应带 data_brief 渲染标记，实际文本: ${out}`);
  assert.ok(out.includes("[DATA_BRIEF_START]"), "应带 KPI payload 块");
});

test("summary_card: 800 字以上结构化长文 → 折叠摘要卡", () => {
  const section = (n: number) =>
    `## 第${n}部分 标题\n这里是正文段落，展开讲一些细节内容，用来把整体篇幅撑过折叠门槛。行文尽量自然，包含具体的例子与说明。\n`;
  const longDoc = Array.from({ length: 8 }, (_, i) => section(i + 1)).join("\n");
  const out = runLoopTurn("帮我整理这份资料", longDoc);
  assert.ok(
    out.includes("[CONTENT_SUMMARY_V2_START]"),
    `长文应折叠为摘要卡，实际文本长度 ${out.length}，前 200 字: ${out.slice(0, 200)}`,
  );
});

test("markdown 表格长文（真实回归：比价回复）→ 折叠摘要且 detail 保留表格", () => {
  const tableDoc = [
    "大哥，结论先给你：同一『舒适型』档下，住的对比在主要区别。",
    "",
    "| 出发地 | 日期 | 人数 | 住4晚每晚 | 合计 |",
    "|---|---|---|---|---|",
    "| 马尔代夫 | 09-05~09-09 | 4 | ¥1504 | ¥6016 |",
    "| 成都 | 08-31~09-02 | 2 | ¥644 | ¥1288 |",
    "| 巴厘岛（印尼） | 08-31~09-06 | 6 | ¥483 | ¥2898 |",
    "| 三亚 | 09-01~09-03 | 2 | ¥384 | ¥768 |",
    "",
    "住得起的排序（单价）：三亚 < 巴厘岛 < 成都 < 马尔代夫。总价排序反而是巴厘岛（¥2898）> 三亚、成都——因为巴厘岛住了 6 晚，三亚和成都只住了 2 晚，总价别直接比，口径不一样。目前未知的部分：马尔代夫还有一个更贵的方案（08-31~09-04，预算约 ¥15360），这次没拿到它的分档报价。基于已有知识推断：马尔代夫贵在岛上住宿本身（水上屋/度假岛基本都是唯一选择），三亚便宜在三亚湾、大东海一带普通型酒店供给极多、竞争强，成都属主要城市，价格水平正常。真要比出「哪里更值」，最好把同一档位、同一时间段拉齐了看——你这四个行程分别落在 8 月底和 9 月初，三亚和马尔代夫都撞上暑期尾巴，价格会偏高。要不要我再找一个 4 晚、同一个时间段把这四个地方重新拉一道？那样才比得干净。",
  ].join("\n");
  const out = runLoopTurn("比较目的地酒店价格", tableDoc);
  assert.ok(
    out.includes("[CONTENT_SUMMARY_V2_START]"),
    `表格长文应折叠为摘要卡（客户端 detail 用 MarkdownTableWidget 渲染），实际: ${out.slice(0, 200)}`,
  );
  // detailContent 必须原样保留表格行——表格被拆/丢会退化成管道符散文
  const m = out.match(/\[CONTENT_SUMMARY_V2_START\]([\s\S]*?)\[CONTENT_SUMMARY_V2_END\]/);
  assert.ok(m, "应携带完整摘要块");
  const payload = JSON.parse(
    m![1].replace(/^\s*\{?/, "{").match(/\{[\s\S]*\}/)?.[0] ?? "{}",
  ) as { detailContent?: string };
  assert.ok(
    (payload.detailContent ?? "").includes("| 马尔代夫 | 09-05~09-09 |"),
    "detail 应保留表格数据行",
  );
  assert.ok(
    (payload.detailContent ?? "").includes("|---"),
    "detail 应保留表头分隔行（MarkdownTableWidget 依赖它识别表格）",
  );
});

test("markdown 表格短文 → [RENDER_AS:structured]（表格不落纯文本）", () => {
  const shortTable = [
    "两档价格给你拉齐了：",
    "",
    "| 档位 | 每晚 |",
    "|---|---|",
    "| 舒适型 | ¥644 |",
    "| 高端型 | ¥1504 |",
  ].join("\n");
  const out = runLoopTurn("三亚酒店什么价位", shortTable);
  assert.ok(
    out.includes("[RENDER_AS:structured]"),
    `含表格的短文也应走富文本（表格可渲染），实际: ${out}`,
  );
  assert.ok(
    !/^\s*\|/m.test(out.replace("[RENDER_AS:structured]\n", "")) === false ||
      out.includes("| 档位 | 每晚 |"),
    "表格行应保留给客户端表格渲染器",
  );
});

test("structured: 用户意图词（整理/清单）→ [RENDER_AS:structured] 富文本", () => {
  const out = runLoopTurn(
    "帮我把这几条整理成一个清单",
    "好的，按优先级排好如下，搬东西的纸箱要先备齐，然后是易碎品的缓冲材料，最后才是清洁用品。",
  );
  assert.ok(out.includes("[RENDER_AS:structured]"), `意图词应触发富文本，实际文本: ${out}`);
});

test("structured: 模型把 [RENDER_AS:structured] 复述在正文结尾 → 残留声明剥除不泄漏", () => {
  // 真实回归：模型照抄历史消息格式，在回复结尾复述 [RENDER_AS:structured]。
  // 旧逻辑只剥开头一处标记，结尾的声明被客户端当字面文本渲染在卡片下方。
  const out = runLoopTurn(
    "帮我把这几条整理成一个清单",
    "好的，按优先级排好如下，搬东西的纸箱要先备齐，然后是易碎品的缓冲材料。\n[RENDER_AS:structured]",
  );
  assert.ok(out.startsWith("[RENDER_AS:structured]\n"), `权威标记应唯一前置，实际: ${out.slice(0, 120)}`);
  const markerCount = (out.match(/\[RENDER_AS:structured\]/g) ?? []).length;
  assert.equal(markerCount, 1, `结尾复述的声明应被剥掉，实际标记数: ${markerCount}，全文: ${out}`);
  assert.ok(out.includes("按优先级排好如下"), "正文内容应保留");
});

test("L2 卡块: 模型主动声明卡片 JSON → 校验后原样透传", () => {
  const out = runLoopTurn(
    "耳机怎么连手机",
    "设置步骤给你单独放卡里了。\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"steps\",\"title\":\"三步完成配对\",\"items\":[{\"type\":\"num\",\"text\":\"长按耳机按键进入配对\"},{\"type\":\"num\",\"text\":\"在手机蓝牙列表选择耳机\"},{\"type\":\"num\",\"text\":\"听到提示音即连接成功\"}],\"footer\":\"\"}\n[AGENT_RESULT_CARD_END]\n连不上的时候再来找我。",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `L2 卡块应透传，实际文本: ${out}`);
  assert.equal(card.cardType, "steps");
  assert.equal(card.title, "三步完成配对");
  assert.ok(out.startsWith("设置步骤给你单独放卡里了。"), "卡前引导语应保留");
  assert.ok(out.includes("连不上的时候再来找我。"), "卡后收尾语应保留");
});

test("L2 RENDER_HINT: 模型声明 structured → 标记注入且 hint 行不泄漏", () => {
  const out = runLoopTurn(
    "说说你对我的了解",
    "[RENDER_HINT:structured]\n分三点说：\n1. 你偏好晚上十一点后安静\n2. 你常在周五回家\n3. 你在意咖啡豆的新鲜度",
  );
  assert.ok(out.includes("[RENDER_AS:structured]"), `应注入渲染标记，实际文本: ${out}`);
  assert.ok(!out.includes("[RENDER_HINT:"), "L2 hint 声明行应被剥掉，不得泄漏给用户");
});

test("carousel: 3 条以上带图条目 → carousel 轮播卡", () => {
  const out = runLoopTurn(
    "拍星空有什么机位推荐",
    "这几个机位的样片你看下：\n- 日出机位 https://img.example.com/sunrise.jpg\n- 逆光机位 https://img.example.com/backlight.jpg\n- 长曝机位 https://img.example.com/exposure.jpg",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 carousel 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "carousel");
});

test("compare: A/B 各一条带图条目 → compare 双图滑杆", () => {
  const out = runLoopTurn(
    "帮我看看这两张调色差别",
    "同一机位的直出和成片：\n- A 原图直出 https://img.example.com/raw.jpg\n- B 后期调色 https://img.example.com/edit.jpg",
  );
  const card = parseCardBlock(out);
  assert.ok(card, `应切出 compare 卡，实际文本: ${out}`);
  assert.equal(card.cardType, "compare");
});

// ─────────────────────────────── 反向：不该上卡的场景 ───────────────────────────────

test("plain: 纯闲聊 → 保持纯文本，不硬塞形态", () => {
  const out = runLoopTurn("在吗", "在的，怎么了？");
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `闲聊不应上卡，实际文本: ${out}`);
  assert.ok(!out.includes("[RENDER_AS:"), "闲聊不应注入渲染标记");
});
