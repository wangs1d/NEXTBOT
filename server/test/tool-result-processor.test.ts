import test from "node:test";
import assert from "node:assert/strict";

import {
  getToolResultProcessor,
  attachTravelItineraryCard,
  stripMediaCardMarker,
  containsTravelItineraryCard,
  buildInterleavedRenderBlocks,
  buildCaptionedRenderBlocks,
  allImageCardsHaveCaption,
  isFlatImageGallery,
  type MediaCardItem,
} from "../src/services/tool-result-processor.js";
import { travelItineraryStore } from "../src/skills/travel-planning/travel-itinerary-store.js";

/**
 * 工具结果处理器：LLM 把 travel.plan-itinerary 行程 JSON 直接吐到回复里时，
 * 应确定性转成 travel_itinerary 双面板卡（而非脏 JSON 透出）。
 */

const processor = getToolResultProcessor();

/** 构造 summarizeItinerary 形态的行程 JSON（与真实工具返回一致的瘦身结构）。 */
function buildItineraryJson(): string {
  return JSON.stringify({
    ok: true,
    id: "plan-1788076649218",
    title: "马尔代夫2日游-海景/泳池/豪华",
    description: "去马尔代夫度蜜月玩2天，预算无限制，要最顶级的体验，住私人小岛",
    destination: "马尔代夫",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    center: [73.2207, 4.1755],
    days: [
      {
        date: "2026-08-30",
        items: [
          {
            type: "hotel",
            name: "当地民宿",
            startTime: "2026-08-30T08:00:00",
            visitDuration: "30",
            rating: 4.66,
            priceInfo: "¥3,840",
            description: "当地民宿位置便利，设施齐全",
            tips: ["建议提前1-2周预订，价格更优且可选房型更多"],
            bookingNote: "旺季季节建议提前2周以上预订",
          },
          {
            type: "attraction",
            name: "当地自然风光区",
            startTime: "2026-08-30T09:00:00",
            visitDuration: "120",
            rating: 4.3,
            priceInfo: "免费",
            description: "当地知名自然风光",
          },
        ],
      },
      {
        date: "2026-08-31",
        items: [
          {
            type: "restaurant",
            name: "老城海鲜餐厅",
            startTime: "2026-08-31T12:00:00",
            rating: 4.5,
            priceInfo: "¥420",
          },
        ],
      },
    ],
    pois: [{ name: "当地民宿", type: "hotel", rating: 4.66 }],
    pricingSummary: {
      currency: "CNY",
      totalOriginal: 4260,
      totalDiscount: 0,
      totalFinal: 4260,
      pricingMode: "estimated",
      warnings: [],
    },
    fromCache: false,
  });
}

/** 从文本中解析 [AGENT_RESULT_CARD_START] 卡片 JSON。 */
function parseCard(text: string): Record<string, any> {
  const si = text.indexOf("[AGENT_RESULT_CARD_START]");
  const ei = text.indexOf("[AGENT_RESULT_CARD_END]");
  assert.ok(si !== -1 && ei > si, "应包含完整卡片标记");
  return JSON.parse(text.slice(si + "[AGENT_RESULT_CARD_START]".length, ei).trim());
}

test("raw travel itinerary JSON → travel_itinerary card with structured travelPlan", () => {
  const out = processor.processAssistantText(buildItineraryJson(), {
    toolName: "travel.plan-itinerary",
  });
  const card = parseCard(out);
  assert.equal(card.cardType, "travel_itinerary");
  assert.equal(card.title, "马尔代夫2日游-海景/泳池/豪华");
  // 逐天摘要行（Day N 前缀供前端预览胶囊）
  assert.ok(card.items.length === 2, "两天行程应产生两条 Day 摘要");
  assert.match(card.items[0].text, /^Day 1 · 2026-08-30：/);
  assert.match(card.items[0].text, /当地民宿 → 当地自然风光区/);
  // 结构化数据：store 未命中时由回显 JSON 构建，天/条目骨架完整
  assert.ok(card.travelPlan, "应携带 travelPlan 结构化数据");
  assert.equal(card.travelPlan.destination, "马尔代夫");
  assert.equal(card.travelPlan.days.length, 2);
  assert.equal(card.travelPlan.days[0].items.length, 2);
  assert.equal(card.travelPlan.days[0].items[0].name, "当地民宿");
  // 卡片外不得残留原始 JSON
  assert.ok(!out.includes('"ok":true'), "不应透出原始 JSON 字段");
});

test("travel itinerary JSON with lead text keeps lead outside the card", () => {
  const out = processor.processAssistantText(
    `王哥，行程给你排好了：\n${buildItineraryJson()}\n\n需要我调整哪一段吗？`,
    { toolName: "travel.plan-itinerary" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "travel_itinerary");
  // JSON 块外的引导/收尾正文保留在卡片前后
  assert.ok(out.includes("王哥，行程给你排好了："));
  assert.ok(out.includes("需要我调整哪一段吗？"));
});

test("travel itinerary JSON prefers fresh store snapshot (with images/reviews)", () => {
  travelItineraryStore.set({
    toolName: "travel.plan-itinerary",
    ts: Date.now(),
    destination: "马尔代夫",
    title: "马尔代夫2日游-海景/泳池/豪华",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    days: [
      {
        date: "2026-08-30",
        items: [
          {
            type: "hotel",
            name: "水上屋",
            startTime: "2026-08-30T08:00:00",
            latitude: 4.1755,
            longitude: 73.2207,
            address: "North Malé Atoll",
            priceInfo: "¥8,800",
            description: "带私人泳池的水上屋",
            images: ["/agent/images/hotel/水上屋/a.png"],
            reviews: [{ author: "旅人", rating: 5, text: "蜜月首选" }],
          },
        ],
      },
    ],
  });
  try {
    const out = processor.processAssistantText(buildItineraryJson(), {
      toolName: "travel.plan-itinerary",
    });
    const card = parseCard(out);
    // 快照按目的地名匹配命中 → 注入全量数据（含图片/评论），而非回显 JSON 的瘦身版
    assert.equal(card.travelPlan.days[0].items[0].name, "水上屋");
    assert.ok(Array.isArray(card.travelPlan.days[0].items[0].images));
  } finally {
    travelItineraryStore.clear();
  }
});

test("search result JSON still routes to search_result card (no false take-over)", () => {
  const out = processor.processAssistantText(
    JSON.stringify({
      items: [
        { title: "马尔代夫旅游攻略", url: "https://example.com/maldives", snippet: "最佳季节…" },
        { title: "蜜月选岛指南", url: "https://example.com/guide", snippet: "一价全包…" },
      ],
      provider: "bing",
    }),
    { toolName: "search_web" },
  );
  const card = parseCard(out);
  assert.equal(card.cardType, "search_result");
});

test("JSON with days but no itinerary item structure is not converted", () => {
  const out = processor.processAssistantText(
    JSON.stringify({ days: ["周一", "周二"], note: "天气讨论" }),
    { toolName: "weather.forecast" },
  );
  // 行程检测器不应接管：即使下游语义路径对普通 JSON 生成其它卡片，
  // 也绝不能是 travel_itinerary（无行程条目结构时不满足签名）
  if (out.includes("[AGENT_RESULT_CARD_START]")) {
    const card = parseCard(out);
    assert.notEqual(card.cardType, "travel_itinerary");
  }
});

test("plainTextMode renders readable summary without raw JSON", () => {
  const out = processor.processAssistantText(buildItineraryJson(), {
    toolName: "travel.plan-itinerary",
    plainTextMode: true,
  });
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(!out.includes('{"ok"'));
  assert.ok(out.includes("马尔代夫2日游-海景/泳池/豪华"));
  assert.ok(out.includes("Day 1 · 2026-08-30"));
});

test("footer aggregates day count, item count and pricing summary", () => {
  const out = processor.processAssistantText(buildItineraryJson(), {
    toolName: "travel.plan-itinerary",
  });
  const card = parseCard(out);
  assert.match(card.footer, /共 2 天 · 3 项安排/);
  assert.match(card.footer, /预计约 ¥/);
});

// ─────────────────────────────────────────────────────────────────────────────
// attachTravelItineraryCard：确定性附卡（工具返回瘦身后的主卡片路径）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造原始工具结果形态（含坐标/媒体字段，比 summarizeItinerary 更全）。 */
function buildRawToolResult(): Record<string, unknown> {
  return {
    ok: true,
    id: "plan-1788076649218",
    title: "马尔代夫2日游-海景/泳池/豪华",
    destination: "马尔代夫",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    days: [
      {
        date: "2026-08-30",
        items: [
          {
            type: "hotel",
            name: "水上屋",
            startTime: "2026-08-30T08:00:00",
            latitude: 4.1755,
            longitude: 73.2207,
            address: "North Malé Atoll",
            priceInfo: "¥8,800",
            description: "带私人泳池",
            images: ["/agent/images/hotel/水上屋/a.png"],
            reviews: [{ author: "旅人", rating: 5, text: "蜜月首选" }],
          },
        ],
      },
    ],
  };
}

test("attach: plain LLM reply + raw tool result → card appended (autoOpen=false, plan on card face)", () => {
  const reply = "帮你排好啦，马尔代夫 2 天，第一天住水上屋，安排直接看下面行程卡～";
  const out = attachTravelItineraryCard(reply, "travel.plan-itinerary", buildRawToolResult());
  const card = parseCard(out);
  assert.equal(card.cardType, "travel_itinerary");
  // 2026-09-17：行程以回复末尾的独立规划卡呈现，不再自动弹出双面板
  assert.equal(card.autoOpen, false, "行程卡不应自动展开双面板");
  // 卡面逐日展示安排（Day 摘要条目）
  assert.ok(Array.isArray(card.items) && card.items.length > 0, "卡面应携带逐日安排条目");
  // LLM 口头回复保留为卡前导
  assert.ok(out.startsWith(reply));
  // 原始工具结果的全量字段透传（坐标/图片/评论）
  assert.equal(card.travelPlan.days[0].items[0].latitude, 4.1755);
  assert.deepEqual(card.travelPlan.days[0].items[0].images, ["/agent/images/hotel/水上屋/a.png"]);
  assert.equal(card.travelPlan.days[0].items[0].reviews.length, 1);
});

test("attach: no double card when reply already carries a card marker", () => {
  const reply = `行程好了\n[AGENT_RESULT_CARD_START]\n{"cardType":"travel_itinerary","title":"已有卡"}\n[AGENT_RESULT_CARD_END]`;
  const out = attachTravelItineraryCard(reply, "travel.plan-itinerary", buildRawToolResult());
  assert.equal(out, reply);
});

test("attach: non-travel tool or empty days → unchanged", () => {
  const reply = "普通回复";
  assert.equal(attachTravelItineraryCard(reply, "search_web", buildRawToolResult()), reply);
  assert.equal(
    attachTravelItineraryCard(reply, "travel.plan-itinerary", { ok: true, days: [] }),
    reply,
  );
  assert.equal(attachTravelItineraryCard(reply, "travel.plan-itinerary", undefined), reply);
});

// ─────────────────────────────────────────────────────────────────────────────
// 卡前确定性短介绍（2026-10-11 用户要求：前面一段简短介绍 + 后面跟旅游卡片）
//
// 事故背景：真实轮次 finalText 61 字全是上游 harness 控制帧
//   <system>\n[trajectory-slicing]\n接下来的回复被分到两条轨迹…
// 被出口守卫剥净后正文为空 → 回复只剩一张卡（「只有卡片、没有介绍」）。
// ─────────────────────────────────────────────────────────────────────────────

const LEAKED_HARNESS_FRAME =
  "<system>\n[trajectory-slicing]\n接下来的回复被分到两条轨迹，#1 紧接本段，#2 紧接 #1。";

test("attach: 正文为空（内部帧被剥净）→ 卡前补确定性短介绍", () => {
  const cleaned = processor.processAssistantText(LEAKED_HARNESS_FRAME);
  assert.equal(cleaned, "", "整条 harness 控制帧应被出口守卫剥净");
  const out = attachTravelItineraryCard(cleaned, "travel.plan-itinerary", buildRawToolResult());
  const card = parseCard(out);
  assert.equal(card.cardType, "travel_itinerary");
  const lead = out.slice(0, out.indexOf("[AGENT_RESULT_CARD_START]")).trim();
  assert.ok(lead.length > 0, "卡前应有介绍，不能只有卡片");
  assert.ok(lead.includes("马尔代夫"), "介绍点到目的地");
  assert.ok(lead.includes("共 1 天") || lead.includes("1天"), "介绍带上天数口径");
  assert.ok(lead.includes("打开行程规划"), "介绍给出下一步入口");
  assert.ok(out.trimEnd().endsWith("[AGENT_RESULT_CARD_END]"), "卡片仍在末尾");
});

test("attach: 模型有口语回复时不注入介绍（原样保留）", () => {
  const reply = "帮你排好啦，马尔代夫 2 天，第一天住水上屋～";
  const out = attachTravelItineraryCard(reply, "travel.plan-itinerary", buildRawToolResult());
  assert.ok(out.startsWith(reply));
  assert.ok(!out.includes("我给你排好了"), "有正文时不再补介绍");
});

// ─────────────────────────────────────────────────────────────────────────────
// stripMediaCardMarker：媒体卡轮次剥除残留卡片块，但 travel_itinerary 必须保留
// ─────────────────────────────────────────────────────────────────────────────

test("strip: generic card blocks removed, surrounding text kept", () => {
  const text =
    "前导文字\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"media\",\"title\":\"图集\"}\n[AGENT_RESULT_CARD_END]\n尾随文字";
  const out = stripMediaCardMarker(text);
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(out.includes("前导文字"));
  assert.ok(out.includes("尾随文字"));
});

test("strip: travel_itinerary card preserved even among generic blocks (autoOpen + travelPlan intact)", () => {
  const travelCard =
    "[AGENT_RESULT_CARD_START]\n" +
    JSON.stringify({
      cardType: "travel_itinerary",
      title: "马尔代夫2日游",
      autoOpen: true,
      travelPlan: { destination: "马尔代夫", days: [{ date: "2026-08-30", items: [] }] },
    }) +
    "\n[AGENT_RESULT_CARD_END]";
  const text =
    `介绍\n[AGENT_RESULT_CARD_START]\n{"cardType":"media","title":"图集"}\n[AGENT_RESULT_CARD_END]\n${travelCard}\n结语`;
  const out = stripMediaCardMarker(text);
  assert.ok(out.includes(travelCard), "行程卡必须原样保留");
  const kept = parseCard(out);
  assert.equal(kept.cardType, "travel_itinerary");
  assert.equal(kept.autoOpen, true);
  assert.ok(!out.includes('"cardType":"media"'), "通用媒体卡仍应被剥除");
  assert.ok(out.includes("介绍") && out.includes("结语"), "卡片外文本不受影响");
});

// ─────────────────────────────────────────────────────────────────────────────
// attachTravelItineraryCard：正文已有「非行程」卡片时仍要附行程卡
// （通用卡没有结构化数据，缺卡会让行程卡缺逐日安排与面板数据）
// ─────────────────────────────────────────────────────────────────────────────

test("attach: generic card in reply → travel card still appended after it", () => {
  const reply =
    "行程好了\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"\",\"title\":\"LLM 列表卡\"}\n[AGENT_RESULT_CARD_END]";
  const out = attachTravelItineraryCard(reply, "travel.plan-itinerary", buildRawToolResult());
  assert.ok(out.startsWith(reply), "原正文（含通用卡）保留在前");
  // 附加的行程卡在通用卡之后，携带结构化数据且不自动展开双面板
  const second = out.indexOf("[AGENT_RESULT_CARD_START]", reply.length - 1);
  assert.ok(second !== -1, "应追加第二张卡");
  const card = JSON.parse(
    out.slice(second + "[AGENT_RESULT_CARD_START]".length, out.indexOf("[AGENT_RESULT_CARD_END]", second)).trim(),
  );
  assert.equal(card.cardType, "travel_itinerary");
  assert.equal(card.autoOpen, false);
});

test("attach: existing travel_itinerary card → still no double card", () => {
  const reply =
    "行程好了\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"travel_itinerary\",\"title\":\"已有行程卡\",\"autoOpen\":true}\n[AGENT_RESULT_CARD_END]";
  const out = attachTravelItineraryCard(reply, "travel.plan-itinerary", buildRawToolResult());
  assert.equal(out, reply);
  assert.equal(containsTravelItineraryCard(reply), true);
});

test("containsTravelItineraryCard: only true for parsable travel_itinerary blocks", () => {
  assert.equal(containsTravelItineraryCard("纯文本"), false);
  assert.equal(
    containsTravelItineraryCard(
      "[AGENT_RESULT_CARD_START]\n{\"cardType\":\"media\"}\n[AGENT_RESULT_CARD_END]",
    ),
    false,
  );
  assert.equal(
    containsTravelItineraryCard(
      "前缀\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"travel_itinerary\"}\n[AGENT_RESULT_CARD_END]",
    ),
    true,
  );
  // LLM 抄坏的 JSON → 不算行程卡
  assert.equal(
    containsTravelItineraryCard(
      "[AGENT_RESULT_CARD_START]\n{\"cardType\":\"travel_itinerary\"\n[AGENT_RESULT_CARD_END]",
    ),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// stripMediaCardMarker 剥除策略（2026-08-30）：只剥与 mediaCards 重复的
// cardType=media 卡；搜索结果卡/通用列表卡等文本场景卡必须保留
// ─────────────────────────────────────────────────────────────────────────────

test("strip: non-media cards (search_result etc.) are preserved", () => {
  const searchCard =
    "[AGENT_RESULT_CARD_START]\n" +
    JSON.stringify({ cardType: "search_result", title: "搜索结果", items: [{ text: "a: b" }] }) +
    "\n[AGENT_RESULT_CARD_END]";
  const out = stripMediaCardMarker(`正文\n${searchCard}\n结语`);
  assert.ok(out.includes(searchCard), "非 media 卡不能被剥掉");
});

test("strip: corrupted card JSON removed (no raw JSON leak)", () => {
  const out = stripMediaCardMarker(
    "前导\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"media\"\n[AGENT_RESULT_CARD_END]\n尾随",
  );
  assert.ok(!out.includes("cardType"), "损坏 JSON 不透出");
  assert.ok(out.includes("前导") && out.includes("尾随"));
});

// ─────────────────────────────────────────────────────────────────────────────
// buildInterleavedRenderBlocks（2026-08-30）：一图一段介绍的交错顺序
// ─────────────────────────────────────────────────────────────────────────────

/** 造 N 张无分组的图片卡。 */
function buildPhotoCards(n: number): MediaCardItem[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "image" as const,
    title: `图片结果${i + 1}`,
    thumbnailUrl: `https://example.com/img${i + 1}.png`,
  }));
}

test("renderBlocks: single-group photos split one-per-cluster, photo before its intro text", () => {
  const text = "第一段介绍。第二段介绍。第三段介绍。第四段介绍。";
  const blocks = buildInterleavedRenderBlocks(text, buildPhotoCards(4));
  const types = blocks.map((b) => b.type);
  // 期望节奏：图1 → 段1 → 图2 → 段2 → 图3 → 段3 → 图4 → 段4
  assert.deepEqual(types, [
    "media", "text", "media", "text", "media", "text", "media", "text",
  ]);
  // 每个媒体块只放 1 张图（不再两张一簇）
  for (const b of blocks) {
    if (b.type === "media") assert.equal(b.cards.length, 1);
  }
  // 照片在前、介绍段紧随其后，正文一字不丢
  const joined = blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  assert.ok(joined.includes("第一段介绍"));
  assert.ok(joined.includes("第四段介绍"));
});

test("renderBlocks: more photos than paragraphs → extras join the last cluster", () => {
  const text = "第一段。第二段。";
  const blocks = buildInterleavedRenderBlocks(text, buildPhotoCards(3));
  const mediaBlocks = blocks.filter((b) => b.type === "media");
  assert.equal(mediaBlocks.length, 2);
  assert.equal(mediaBlocks[0].type === "media" && mediaBlocks[0].cards.length, 1);
  assert.equal(mediaBlocks[1].type === "media" && mediaBlocks[1].cards.length, 2);
});

test("renderBlocks: all original text preserved (no keyword swallowed by anchors)", () => {
  const text = "水屋是马代特色。沙滩别墅也不错。";
  const cards: MediaCardItem[] = [
    { type: "image", title: "水屋", thumbnailUrl: "https://example.com/a.png" },
    { type: "image", title: "沙滩", thumbnailUrl: "https://example.com/b.png" },
  ];
  const blocks = buildInterleavedRenderBlocks(text, cards);
  const joined = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  // 「水屋」「沙滩别墅」等关键词不能被锚点吞掉
  assert.ok(joined.includes("水屋是马代特色"), "关键词正文必须保留");
  assert.ok(joined.includes("沙滩别墅也不错"), "关键词正文必须保留");
  // 照片出现在对应介绍文字之前
  const firstMediaIdx = blocks.findIndex((b) => b.type === "media");
  const firstTextIdx = blocks.findIndex((b) => b.type === "text");
  assert.ok(firstMediaIdx < firstTextIdx, "图在介绍文字之前");
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCaptionedRenderBlocks（2026-09-03）：有真实图片描述时的 Coze 式排版
// ─────────────────────────────────────────────────────────────────────────────

/** 造 N 张带 caption 的图片卡。 */
function buildCaptionedPhotoCards(n: number): MediaCardItem[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "image" as const,
    title: `图片结果${i + 1}`,
    thumbnailUrl: `https://example.com/img${i + 1}.png`,
    caption: `第${i + 1}张的描述`,
  }));
}

test("captioned renderBlocks: text stays whole, photos follow with captions", () => {
  const text = "这是整体介绍。这是补充建议。";
  const blocks = buildCaptionedRenderBlocks(text, buildCaptionedPhotoCards(3));
  const types = blocks.map((b) => b.type);
  // 正文一个 text 块在前，照片一个 media 块在后（不再切句锚定）
  assert.deepEqual(types, ["text", "media"]);
  assert.equal(blocks[0].type === "text" && blocks[0].text, text);
  assert.equal(blocks[1].type === "media" && blocks[1].cards.length, 3);
  // 每张卡都带着自己的描述
  const media = blocks[1];
  assert.ok(media.type === "media");
  assert.deepEqual(
    media.cards.map((c) => c.caption),
    ["第1张的描述", "第2张的描述", "第3张的描述"],
  );
});

test("captioned renderBlocks: compare groups preserved as separate media blocks", () => {
  const cards: MediaCardItem[] = [
    { type: "image", title: "a", thumbnailUrl: "u1", caption: "ca", groupTitle: "水屋", side: "A", sideLabel: "马代" },
    { type: "image", title: "b", thumbnailUrl: "u2", caption: "cb", groupTitle: "水屋", side: "B", sideLabel: "印尼" },
    { type: "image", title: "c", thumbnailUrl: "u3", caption: "cc", groupTitle: "沙屋", side: "A", sideLabel: "马代" },
    { type: "image", title: "d", thumbnailUrl: "u4", caption: "cd", groupTitle: "沙屋", side: "B", sideLabel: "印尼" },
  ];
  const blocks = buildCaptionedRenderBlocks("对比介绍。", cards);
  const mediaBlocks = blocks.filter((b) => b.type === "media");
  // 两个对比维度各自成块，组内元数据原样保留
  assert.equal(mediaBlocks.length, 2);
  assert.ok(mediaBlocks[0].type === "media" && mediaBlocks[0].groupTitle === "水屋");
  assert.ok(mediaBlocks[0].type === "media" && mediaBlocks[0].sideA === "马代");
  assert.ok(mediaBlocks[1].type === "media" && mediaBlocks[1].groupTitle === "沙屋");
});

test("allImageCardsHaveCaption: true only when every image card has non-empty caption", () => {
  assert.equal(allImageCardsHaveCaption([]), false);
  assert.equal(allImageCardsHaveCaption(buildPhotoCards(2)), false);
  assert.equal(allImageCardsHaveCaption(buildCaptionedPhotoCards(2)), true);
  // 视频卡不要求 caption，不影响判定
  const mixed: MediaCardItem[] = [
    ...buildCaptionedPhotoCards(1),
    { type: "video", title: "v", thumbnailUrl: "" },
  ];
  assert.equal(allImageCardsHaveCaption(mixed), true);
  // 部分图片卡缺 caption → 回退旧路径
  const partial: MediaCardItem[] = [
    ...buildCaptionedPhotoCards(1),
    ...buildPhotoCards(1),
  ];
  assert.equal(allImageCardsHaveCaption(partial), false);
});

test("isFlatImageGallery: 无分组的单次搜图 = 平铺图集，强制走一图一句版式", () => {
  // 无 caption 也要按平铺图集处理：照片之间不再允许切段交错正文
  assert.equal(isFlatImageGallery(buildPhotoCards(3)), true);
  assert.equal(isFlatImageGallery(buildCaptionedPhotoCards(2)), true);
  // 对比分组（groupTitle/side）不是平铺图集，保留原交错锚定
  const grouped: MediaCardItem[] = [
    { type: "image", title: "a", thumbnailUrl: "u1", groupTitle: "水屋", side: "A" },
    { type: "image", title: "b", thumbnailUrl: "u2", groupTitle: "水屋", side: "B" },
  ];
  assert.equal(isFlatImageGallery(grouped), false);
  // 混合视频/图片不是平铺图集
  assert.equal(
    isFlatImageGallery([{ type: "video", title: "v", thumbnailUrl: "" }]),
    false,
  );
  assert.equal(isFlatImageGallery([]), false);
});

// ── 2026-10-11 变体声明剥离（[RENDER_AS]:xxx，括号在冒号前闭合）─────────
import { stripResidualRenderDeclarations as _stripResidual } from "../src/services/tool-result-processor.js";

test("stripResidualRenderDeclarations：剥变体 [RENDER_AS]:structured（行内嵌与独占行）", () => {
  assert.equal(
    _stripResidual("行程攻略结尾[RENDER_AS]:structured"),
    "行程攻略结尾",
  );
  assert.equal(
    _stripResidual("第一段\n[RENDER_HINT]:brief\n第二段"),
    "第一段\n第二段",
  );
  assert.equal(
    _stripResidual("规范形 [RENDER_AS:structured] 与变体 [RENDER_AS]:structured 都剥"),
    "规范形  与变体  都剥",
  );
});
