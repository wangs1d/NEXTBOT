import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAndSelectStrategy,
  isPhotoDeliveryRound,
  PHOTO_DELIVERY_INSTRUCTION,
} from "../src/agent/synthesis-strategy.js";

/**
 * 回归背景（2026-10-06「搜照片回一堆废话」修复）：
 * 纯图轮（search_images 成功、无文字检索结果）此前走常规数据质量分档，
 * medium/high 档的「信息用足、按主题分节」会把照片轮教成
 * 「已确认的/能说的/没查到的」三段式盘点正文。照片轮的交付是图本身，
 * 每张照片下方已由 image-caption-service 自动附一句画面解读，正文应一两句话收束。
 */

test("纯图轮命中 photo_delivery 策略，注入交图专用指令", () => {
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "search_images",
        ok: true,
        result: {
          provider: "anysearch",
          items: [
            { title: "刘浩存 白裙 写真", mediaUrl: "/agent/images/a.png", pageUrl: "https://example.com/1" },
            { title: "刘浩存 红毯 银白色礼服", mediaUrl: "/agent/images/b.png", pageUrl: "https://example.com/2" },
          ],
        },
      },
    ],
    "搜搜刘浩存的照片",
  );
  assert.equal(directive.strategy, "photo_delivery");
  assert.equal(directive.instruction, PHOTO_DELIVERY_INSTRUCTION);
  assert.match(directive.instruction, /不要按主题分节|严禁按主题分节/);
});

test("图文混合轮（search_web 也成功）不走 photo_delivery，仍按常规分档", () => {
  const directive = evaluateAndSelectStrategy(
    [
      { toolName: "search_images", ok: true, result: { items: [{ title: "图", mediaUrl: "/agent/images/a.png" }] } },
      { toolName: "search_web", ok: true, result: { items: [{ title: "新闻", snippet: "正文" }] } },
    ],
    "刘浩存最近怎么样",
  );
  assert.notEqual(directive.strategy, "photo_delivery");
});

test("媒体意图轮即使有网页结果也强制 photo_delivery（2026-10-21 根修）", () => {
  const directive = evaluateAndSelectStrategy(
    [
      { toolName: "search_images", ok: true, result: { items: [{ title: "图", mediaUrl: "/agent/images/a.png" }] } },
      { toolName: "search_web", ok: true, result: { items: [{ title: "新闻", snippet: "正文" }] } },
    ],
    "我老婆最近的照片",
    "media_retrieval",
  );
  assert.equal(directive.strategy, "photo_delivery");
  assert.equal(directive.instruction, PHOTO_DELIVERY_INSTRUCTION);
});

test("search_images 失败的轮次不是纯图轮", () => {
  assert.equal(
    isPhotoDeliveryRound([{ toolName: "search_images", ok: false }]),
    false,
  );
});

test("只有 search_images_batch 成功（对比出图流）不算纯图轮", () => {
  assert.equal(
    isPhotoDeliveryRound([{ toolName: "search_images_batch", ok: true }]),
    false,
  );
});
