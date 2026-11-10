/**
 * 会话级「已展示图片」账本契约（2026-11-09）。
 *
 * 背景：用户真机反馈「再来几张时返回了前面已经返回过的照片」。根因有两处：
 *   1. 工具结果缓存（tool-registry + tool-metadata 的 cachePolicy）把同 query
 *      的上一轮结果原样复用 —— 已由两端移除 search_images 的缓存资格解决；
 *   2. 图库对同一 query 的召回池稳定，单轮只展示 4 张，追轮必然重排到老图 ——
 *      由本账本过滤掉「本会话已展示过」的图解决。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  filterUnseenMedia,
  mediaItemShownKeys,
  mediaShownKey,
  rememberShownMedia,
  resetMediaShownLedgerForTests,
} from "../src/services/media-shown-ledger.js";

afterEach(() => resetMediaShownLedgerForTests());

const img = (id: string) => ({
  pageUrl: `https://example.com/a/${id}.html`,
  mediaUrl: `https://cdn.example.com/p/${id}.jpg?sig=1`,
});

test("键归一化：去 query/hash、忽略本地转存路径", () => {
  assert.equal(mediaShownKey("https://CDN.example.com/p/a.jpg?sig=1#x"), "cdn.example.com/p/a.jpg");
  assert.equal(mediaShownKey("/agent/images/sess/123-abc.png"), "");
  assert.deepEqual(mediaItemShownKeys(img("1c14-9bfc1fd0926b4d9")), [
    "path:cdn.example.com/p/1c14-9bfc1fd0926b4d9.jpg",
    "img:1c14-9bfc1fd0926b4d9.jpg",
  ]);
  // 没有原图 URL 才退化为按来源页判重
  assert.deepEqual(mediaItemShownKeys({ pageUrl: "https://news.example.com/x/1.html" }), [
    "page:news.example.com/x/1.html",
  ]);
});

test("同一张图的不同尺寸变体（文件名哈希相同）判为同图", () => {
  const big = { mediaUrl: "https://n.sinaimg.cn/sinakd/533/w2000h3333/20251222/1c14-9bfc1fd0926b4d99ac6e1475ac7fcacc.jpg" };
  const small = { mediaUrl: "https://n.sinaimg.cn/sinakd/792/w640h952/20251222/1c14-9bfc1fd0926b4d99ac6e1475ac7fcacc.jpg" };
  rememberShownMedia("s1", [big]);
  assert.equal(filterUnseenMedia("s1", [small]).length, 0);
});

test("同会话第二轮过滤掉已展示的图，不同会话互不影响", () => {
  const batch1 = [img("a"), img("b"), img("c")];
  rememberShownMedia("s1", batch1);
  const pool = [img("a"), img("b"), img("c"), img("d"), img("e")];
  assert.deepEqual(filterUnseenMedia("s1", pool).map((x) => x.mediaUrl), [img("d").mediaUrl, img("e").mediaUrl]);
  // 另一个会话没看过，池子原样
  assert.equal(filterUnseenMedia("s2", pool).length, 5);
  // 没有 sessionId（旅行 POI / 商品图）不参与去重
  assert.equal(filterUnseenMedia("", pool).length, 5);
});

test("账本对同图不同尺寸参数视作同一张（query 被归一化掉）", () => {
  rememberShownMedia("s1", [{ mediaUrl: "https://cdn.example.com/p/a.jpg?w=1200" }]);
  const rest = filterUnseenMedia("s1", [{ mediaUrl: "https://cdn.example.com/p/a.jpg?w=640&sig=2" }]);
  assert.equal(rest.length, 0);
});

test("TTL 过期后允许再次展示同一张", () => {
  const t0 = 1_000_000;
  rememberShownMedia("s1", [img("a")], t0);
  assert.equal(filterUnseenMedia("s1", [img("a")], t0 + 60_000).length, 0);
  // 31 分钟后账本过期
  assert.equal(filterUnseenMedia("s1", [img("a")], t0 + 31 * 60_000).length, 1);
});
