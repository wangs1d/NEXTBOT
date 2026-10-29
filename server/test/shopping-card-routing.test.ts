/**
 * 商务轮卡片路由：比价/商品推荐/下单轮次的主形态是专属卡
 * （price_compare / product_pick / order），正文不再折叠成摘要卡——
 * 摘要卡标记会让 done 阶段的 L1 专属卡 guard 让位，比价轮就只剩一张摘要卡。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ToolResultProcessor } from "../src/services/tool-result-processor.js";
import { attachDeterministicCards } from "../src/services/deterministic-card-chain.js";
import { inferTaskSubject } from "../src/services/content-summary-service.js";
import { classifyRenderHint } from "../src/services/render-hint-service.js";

/** 小米17 Pro 比价轮的正文（822 字，含二级标题 + 表格 + 列表 → 旧逻辑必折叠） */
const COMPARE_REPLY = `小米17 Pro 这次只找到一条报价，王哥，别急，我先跟你说清楚现在能确定多少。

## 📦 目前确认的报价

| 项目 | 内容 |
|---|---|
| 价格 | **¥3,749** |
| 店铺 | 海宝数码（淘宝） |
| 标题 | MIUI、小米 Xiaomi 17 Pro、徕卡、第五代骁龙8至尊版、5G |
| 匹配度 | 精确匹配，标题和型号高度吻合 |

## ⚠️ 还缺什么

- **只有一个平台**：这次只搜了淘宝，京东、天猫、拼多多都没有数据，所以这个 3749 是"淘宝最低"，不是"全网最低"
- **存储版本目前未知**：标题里只有"5G"，没写是 12+256 还是 16+512。这机器一档差价能到五六百，版本不明，这价格就没法判断贵不贵
- **是否国行全新、能不能开票、是不是官方渠道，目前都未知**：海宝数码不是官方旗舰店，属于第三方商家
- **是否现货、有没有赠品、保修怎么算，目前也都未知**

## 💡 基于已有知识推断，不是查证结果

小米17 Pro 是今年的新机，搭载第五代骁龙8至尊版，主打徕卡影像。按小米 Pro 系列的定价习惯，首发一般落在 5000 以上，3749 这个价明显低于正常新机价位。

这种价差通常有三种可能：版本缩水、渠道货或拆封机、活动价或者补贴。前两种最需要警惕。

## 🔧 买之前先把三件事问清楚

1. **存储版本**：12+256、16+512 要问明白，还有颜色
2. **是否全新未激活、能不能开正规发票**：发票是保修的依据
3. **是不是官方渠道或者授权店**：不是的话，保修可能要自己找小米售后

你把想要的版本和预算告诉我，我再单独去京东、天猫那边翻一遍。`;

const COMPARE_TOOL_RESULT = {
  ok: true,
  query: "小米17pro",
  platforms: ["taobao"],
  searchedPlatforms: ["taobao"],
  groups: [
    {
      query: "小米17pro",
      matchType: "exact",
      offers: [
        {
          platform: "淘宝",
          title: "MIUI 小米 Xiaomi 17 Pro 徕卡 第五代骁龙8至尊版 5G",
          shop: "海宝数码",
          priceCny: 3749,
          url: "https://item.taobao.com/item.htm?id=1",
        },
      ],
      offersCount: 1,
    },
  ],
  bestOffer: { platform: "淘宝", priceCny: 3749 },
  bestIndex: null,
};

test("比价轮：正文不折叠成摘要卡，专属 price_compare 卡附上", () => {
  const processor = new ToolResultProcessor();
  const body = processor.processAssistantText(COMPARE_REPLY, {
    userText: "帮我比价这个商品：小米17pro",
    suppressSummaryCard: true,
  });
  assert.ok(
    !body.includes("[CONTENT_SUMMARY_V2_START]"),
    "商务轮正文不应折叠成摘要卡",
  );

  const finalText = attachDeterministicCards({
    text: body,
    registryResults: [
      { toolName: "shopping.compare.prices", result: COMPARE_TOOL_RESULT },
    ],
  });
  assert.ok(
    finalText.includes("[AGENT_RESULT_CARD_START]"),
    "专属卡应真正附上（摘要卡标记不再让位）",
  );
  const cardJson = finalText.slice(
    finalText.indexOf("[AGENT_RESULT_CARD_START]"),
    finalText.indexOf("[AGENT_RESULT_CARD_END]"),
  );
  assert.ok(cardJson.includes('"cardType":"price_compare"'), "卡型应为 price_compare");
  assert.ok(cardJson.includes("3749"), "卡面应带真实报价");
});

test("商务意图（问句含比价）即使没有工具回执也不折叠", () => {
  const hint = classifyRenderHint(COMPARE_REPLY, {
    userText: "帮我比价这个商品：小米17pro",
  });
  assert.notEqual(hint.type, "summary_card");
});

test("非商务长文档仍折叠（新闻摘要不受影响）", () => {
  const longNews = `${COMPARE_REPLY}\n\n## 补充说明\n${"这条消息的来源和发布时间还没核对完，按内容判断是这两天的事。".repeat(20)}`;
  const hint = classifyRenderHint(longNews, {
    userText: "查一下今天的重要新闻",
  });
  assert.equal(hint.type, "summary_card");
});

test("卡面主体按问句推断：比价问句不吃店铺名里的「数码」", () => {
  assert.equal(
    inferTaskSubject(COMPARE_REPLY, "帮我比价这个商品：小米17pro"),
    "购物推荐",
  );
  assert.equal(
    inferTaskSubject("今天是几号", "查一下今天的重要新闻"),
    "新闻资讯",
  );
});
