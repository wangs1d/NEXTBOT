/**
 * 图片搜索词净化契约（2026-11-09 用户定稿）。
 *
 * 用户口径：「搜索人物照片走必应的时候，query 只能使用纯人名」。
 * 复现（本地真链 cn.bing.com/images/search）：
 *   q=「鞠婧祎」           → 8/8 张都是本人
 *   q=「鞠婧祎 写真 照片」 → 8/8 张无关（家居招聘海报 / 二十大报告）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeImageSearchQuery } from "../src/services/image-query-normalizer.js";

test("人物照片：空格分词 query 只留人名", () => {
  assert.equal(normalizeImageSearchQuery("鞠婧祎 写真 照片"), "鞠婧祎 写真");
  assert.equal(normalizeImageSearchQuery("鞠婧祎 照片 高清"), "鞠婧祎");
  assert.equal(normalizeImageSearchQuery("刘亦菲 高清 图片"), "刘亦菲");
  assert.equal(normalizeImageSearchQuery("鞠婧祎 最新 近照"), "鞠婧祎");
});

test("具体图片类型词保留（壁纸/头像/表情包/写真 是有效检索词）", () => {
  assert.equal(normalizeImageSearchQuery("鞠婧祎 壁纸"), "鞠婧祎 壁纸");
  assert.equal(normalizeImageSearchQuery("鞠婧祎 头像"), "鞠婧祎 头像");
  assert.equal(normalizeImageSearchQuery("星空壁纸"), "星空壁纸");
});

test("人物照片：无空格整串剥尾部噪声词（含结构助词）", () => {
  assert.equal(normalizeImageSearchQuery("鞠婧祎高清图片"), "鞠婧祎");
  assert.equal(normalizeImageSearchQuery("帮我搜几张刘亦菲最近的照片"), "刘亦菲");
  assert.equal(normalizeImageSearchQuery("刘亦菲的照片"), "刘亦菲");
});

test("景物/商品：语义限定词原样保留", () => {
  assert.equal(normalizeImageSearchQuery("黄山 云海 日出"), "黄山 云海 日出");
  assert.equal(normalizeImageSearchQuery("马尔代夫 水屋"), "马尔代夫 水屋");
  assert.equal(normalizeImageSearchQuery("平潭岛蓝眼泪荧光海 夜景实拍"), "平潭岛蓝眼泪荧光海 夜景实拍");
});

test("剥完不剩主体 → 回退原词（绝不下发空 query）", () => {
  assert.equal(normalizeImageSearchQuery("来点图"), "来点图");
  assert.equal(normalizeImageSearchQuery("照片"), "照片");
  assert.equal(normalizeImageSearchQuery(""), "");
  assert.equal(normalizeImageSearchQuery("   "), "");
});
