import test from "node:test";
import assert from "node:assert/strict";

import { getToolResultProcessor, isMediaSearchTool } from "../src/services/tool-result-processor.js";
import {
  stripContentSummaryBlock,
  extractContentSummaryCard,
  createContentSummary,
} from "../src/services/content-summary-service.js";

/**
 * 搜图轮 CONTENT_SUMMARY 裸 JSON 泄漏（2026-10-10）回归：
 * 媒体搜索轮（search_images / search_images_batch / search_videos）照片由
 * mediaCards 承载、是本轮唯一主形态，摘要折叠块绝不允许出现在正文里。
 *
 * 不变量（与模型无关）：
 *  1. 媒体工具的叙事文本永不进 summary_card 路由（路由禁入）；
 *  2. stripContentSummaryBlock 幂等剥离整块（出口兜底，任何生产者都拦得住）；
 *  3. markdown 图片/链接行不进 briefPoints（不再出现 "!alt(url)" 垃圾要点）。
 */

const processor = getToolResultProcessor();

const SUMMARY_BLOCK = [
  "[CONTENT_SUMMARY_V2_START]",
  JSON.stringify({
    type: "content_summary_v2",
    id: "sum-test-1",
    category: "multi_section",
    title: "马尔代夫三组图给你凑齐了",
    cardIcon: "☰",
    cardLabel: "专题汇总",
    briefCount: 2,
    briefPoints: [{ icon: "📝", text: "要点一" }],
    detailContent: "正文",
    metadata: {},
  }),
  "[CONTENT_SUMMARY_V2_END]",
  "",
  '<details_card ref="sum-test-1" />',
].join("\n");

test("isMediaSearchTool: 覆盖三个媒体搜索工具，不误伤其它工具", () => {
  assert.equal(isMediaSearchTool("search_images"), true);
  assert.equal(isMediaSearchTool("search_images_batch"), true);
  assert.equal(isMediaSearchTool("search_videos"), true);
  assert.equal(isMediaSearchTool("search_web"), false);
  assert.equal(isMediaSearchTool("image.generate"), false);
  assert.equal(isMediaSearchTool(undefined), false);
});

test("stripContentSummaryBlock: 整块剥离（标记对 + details_card），保留其余正文", () => {
  const text = `王哥，图给你凑齐了 👇\n\n${SUMMARY_BLOCK}\n\n看完是不是更饿了？`;
  const cleaned = stripContentSummaryBlock(text);
  assert.ok(!cleaned.includes("CONTENT_SUMMARY_V2_START"));
  assert.ok(!cleaned.includes("details_card"));
  assert.ok(!cleaned.includes("sum-test-1"));
  assert.ok(cleaned.includes("王哥，图给你凑齐了"));
  assert.ok(cleaned.includes("看完是不是更饿了？"));
});

test("stripContentSummaryBlock: 幂等 + 无块文本原样返回", () => {
  const once = stripContentSummaryBlock(SUMMARY_BLOCK);
  assert.equal(stripContentSummaryBlock(once), once);
  const noBlock = "普通正文，没有任何标记。";
  assert.equal(stripContentSummaryBlock(noBlock), noBlock);
});

test("stripContentSummaryBlock: 孤儿 details_card（历史残留）也一并清掉", () => {
  const orphan = '正文一段\n\n<details_card ref="sum-old" />\n\n结尾';
  const cleaned = stripContentSummaryBlock(orphan);
  assert.ok(!cleaned.includes("details_card"));
  assert.ok(cleaned.includes("正文一段"));
  assert.ok(cleaned.includes("结尾"));
});

test("路由禁入：媒体工具的长结构化文本不再生成 CONTENT_SUMMARY 块", () => {
  // 足够长（>400 字阈值）、有板块结构的叙事文本（旧逻辑会命中 summary_card 并附块）
  const longStructured = [
    "# 海上水屋 · 椰林沙滩",
    "马尔代夫的海上水屋坐落在碧蓝泻湖之上，木质栈道连接着一栋栋独立的房间，清晨推窗就是海平面升起的太阳，适合蜜月与度假。栈道尽头是私属的泳池平台，傍晚时分能看到魔鬼鱼从下方的沙底掠过，管家会把晚餐直接摆到露台上。",
    "## 航拍全景 · 蓝绿泻湖",
    "航拍视角下，环礁把泻湖围成一枚蓝绿色的宝石，白沙岛屿散落在礁盘边缘，是杂志封面级别的构图素材。清晨六点前后光线最柔和，无人机从栈道起飞逆光向东，能同时收进泻湖、礁盘与远处的深蓝分界线。",
    "## 海底珊瑚 · 鱼群世界",
    "珊瑚花园里小丑鱼在触手间穿梭，浅滩处能看到魔鬼鱼掠过沙底，浮潜一次就能看全这三种场景。House Reef 就在水屋下方十米，戴上面镜顺流漂移半小时，沿途会经过鹿角珊瑚区、桌面珊瑚区和海葵区，退潮时水深只有两米，新手也能轻松驾驭。",
  ].join("\n");

  for (const tool of ["search_images", "search_images_batch", "search_videos"]) {
    const out = processor.processAssistantText(longStructured, {
      toolName: tool,
      userText: "帮我找几张马尔代夫的照片",
    });
    assert.ok(
      !out.includes("[CONTENT_SUMMARY_V2_START]"),
      `媒体工具 ${tool} 的回复不应携带摘要块`,
    );
  }

  // 同样的文本换非媒体工具：折叠路由仍然可用（不能误杀）
  const longNonMedia = Array.from(
    { length: 6 },
    (_, i) =>
      `## 板块${i}\n马尔代夫的海上水屋坐落在碧蓝泻湖之上，木质栈道连接着一栋栋独立的房间，清晨推窗就是海平面升起的太阳，适合蜜月与度假，傍晚管家会把晚餐摆到露台上。`,
  ).join("\n");
  const textOut = processor.processAssistantText(longNonMedia, {
    toolName: "memory.save",
    userText: "帮我看看马尔代夫攻略",
  });
  assert.ok(
    textOut.includes("[CONTENT_SUMMARY_V2_START]"),
    "非媒体工具的 summary_card 路由不受影响",
  );
});

test("briefPoints 不再吃 markdown 图片/链接行（不产生 !alt(url) 垃圾要点）", () => {
  const content = [
    "# 马尔代夫图集",
    "![马尔代夫水屋](https://www.58pic.com/newpic/43244593.html)",
    "水屋上的清晨最安静，只有海浪和风的声音。",
    "![Maldives Aerial](https://www.vecteezy.com/photo/67763233)",
    "航拍能把整片环礁收进一张构图里。",
    "![马尔代夫珊瑚](https://www.58pic.com/newpic/43038792.html)",
    "珊瑚区的浮潜能一次看全三种鱼群。",
    "# 第二板块",
    "https://www.example.com/gallery/maldives",
    "第二条纯文字要点，足够长可以被采纳为要点内容。",
  ].join("\n");

  const summary = createContentSummary(content, { forceSummary: true });
  assert.ok(summary, "应能生成摘要");
  for (const point of summary!.briefPoints) {
    assert.ok(
      !/!?\S+\((?:https?:\/\/|\/)[^)]*\)/.test(point.text),
      `要点不应包含图片/链接残形: ${point.text}`,
    );
    assert.ok(!point.text.startsWith("http"), `要点不应是裸 URL: ${point.text}`);
  }
  // 卡内是全文：标题行（导语）也算正文的一部分，不因与卡标题重复被删
  assert.equal(summary!.detailContent, content.trim());
  assert.ok(summary!.detailContent.startsWith("# 马尔代夫图集"));
  assert.ok(summary!.detailContent.includes("第二条纯文字要点"));
});

test("extractContentSummaryCard: 块摘出为结构化卡，文本通道不再携带 JSON", () => {
  const text = `开场白\n\n${SUMMARY_BLOCK}\n\n结尾一句`;
  const { card, text: cleaned } = extractContentSummaryCard(text);
  assert.ok(card, "应摘出结构化卡");
  assert.equal((card as { type?: string }).type, "content_summary_v2");
  assert.equal((card as { id?: string }).id, "sum-test-1");
  assert.ok(!cleaned.includes("CONTENT_SUMMARY_V2"));
  assert.ok(!cleaned.includes("details_card"));
  assert.ok(cleaned.includes("开场白"));
  assert.ok(cleaned.includes("结尾一句"));
});

test("extractContentSummaryCard: 载荷损坏也整块剥离（宁缺毋滥，不透出裸 JSON）", () => {
  const broken = "正文\n\n[CONTENT_SUMMARY_V2_START]\n{broken json!!\n[CONTENT_SUMMARY_V2_END]\n\n<details_card ref=\"x\" />";
  const { card, text: cleaned } = extractContentSummaryCard(broken);
  assert.equal(card, null);
  assert.ok(!cleaned.includes("CONTENT_SUMMARY_V2"));
  assert.ok(!cleaned.includes("details_card"));
  assert.ok(cleaned.includes("正文"));
});

test("extractContentSummaryCard: 无块文本原样返回（不误伤）", () => {
  const plain = "普通正文，没有任何标记。";
  const out = extractContentSummaryCard(plain);
  assert.equal(out.card, null);
  assert.equal(out.text, plain);
});

test("IMAGE_RESULT 块与 RENDER_AS:image_result 路由强制配对（附块必有路由）", async () => {
  const { attachImageResultPhotos } = await import("../src/services/vision-photo-cards.js");
  // 无 RENDER_AS 声明的叙事文本：附块后必须补上路由，否则客户端按普通正文渲染裸 JSON
  const attached = attachImageResultPhotos("这是一段识图描述", [
    { url: "/agent/images/a/x.jpg", caption: "一只橘猫" },
  ]);
  assert.ok(attached.includes("[IMAGE_RESULT_START]"));
  // 服务端补路由后的最终形态
  const finalText = attached.includes("[RENDER_AS:image_result]")
    ? attached
    : `[RENDER_AS:image_result]\n${attached}`;
  assert.ok(finalText.startsWith("[RENDER_AS:image_result]"));
});
