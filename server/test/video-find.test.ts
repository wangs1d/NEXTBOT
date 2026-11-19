// 按内容找视频（video.find）链路回归（2026-10-02 根修）：
//   1. 候选解析顺序必须 B 站优先——旧版「非 B 站页优先」在抖音页恒不出流的当下
//      会让并发名额被抖音占满、B 站候选轮不到解析，整条链路退化成只回链接；
//   2. 解析成功的条目**全部**回写 videoUrl（不止 limit 条），模型转述第 2/3 条
//      时前端同样能内联播放；
//   3. video.find 回执 → 确定性附播放卡，且正文不带任何文案（面板纯视频定稿）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { enrichVideosWithPlayable } from "../src/tools/video-tools.js";
import {
  attachVideoMediaMarker,
  extractMediaCards,
  resolveVideoMediaSource,
} from "../src/services/tool-result-processor.js";
import type { MediaSearchItem } from "../src/services/upstream-search-service.js";

type VideoSearchResult = {
  provider: string;
  mediaType: "video";
  items: MediaSearchItem[];
  notes: string[];
};

function item(title: string, pageUrl: string): MediaSearchItem {
  return { type: "video", title, pageUrl, source: "probe" };
}

/** 假 grab：抖音页恒失败（第三方解析通道已下线），B 站页恒出流 */
function fakeGrabService(seen: string[]): never {
  return {
    async grab(url: string) {
      seen.push(url);
      const isBili = /bilibili\.com/i.test(url);
      return {
        provider: isBili ? "bilibili-api" : "douyin",
        platform: isBili ? ("bilibili" as const) : ("douyin" as const),
        title: `title:${url.slice(-6)}`,
        author: "",
        description: "",
        videoUrl: isBili ? `https://cdn.example/${url.slice(-6)}.mp4` : undefined,
        playPageUrl: url,
        notes: [],
      };
    },
  } as never;
}

function searchOf(items: MediaSearchItem[]): VideoSearchResult {
  return { provider: "probe", mediaType: "video", items, notes: [] };
}

test("解析名额 B 站优先：抖音候选占满前排时 B 站页仍被解析到", async () => {
  const items = [
    item("抖音A", "https://www.douyin.com/video/111"),
    item("抖音B", "https://www.douyin.com/video/222"),
    item("抖音C", "https://www.douyin.com/video/333"),
    item("抖音D", "https://www.douyin.com/video/444"),
    item("抖音E", "https://www.douyin.com/video/555"),
    item("抖音F", "https://www.douyin.com/video/666"),
    item("B站1", "https://www.bilibili.com/video/av9001"),
    item("B站2", "https://www.bilibili.com/video/av9002"),
  ];
  const seen: string[] = [];
  const { items: out, playable } = await enrichVideosWithPlayable(
    searchOf(items) as never,
    fakeGrabService(seen),
    2,
  );
  // 旧排序（非 B 站优先 + 6 名额）下这里会是 0 条 —— 整条「按内容找视频」断在这
  assert.ok(playable.length > 0, "B 站候选必须被解析到");
  assert.equal(playable[0]!.playPageUrl, "https://www.bilibili.com/video/av9001");
  assert.ok(
    seen.filter((u) => u.includes("bilibili")).length >= 2,
    `B 站候选未进解析批次：${JSON.stringify(seen)}`,
  );
  assert.equal(out.filter((it) => (it as { videoUrl?: string }).videoUrl).length, 2);
});

test("回写覆盖全部解析成功条目，playable 按 limit 截断", async () => {
  const items = [
    item("B1", "https://www.bilibili.com/video/av1"),
    item("B2", "https://www.bilibili.com/video/av2"),
    item("B3", "https://www.bilibili.com/video/av3"),
  ];
  const seen: string[] = [];
  const { items: out, playable } = await enrichVideosWithPlayable(
    searchOf(items) as never,
    fakeGrabService(seen),
    1,
  );
  assert.equal(playable.length, 1, "playable 按 limit 截断");
  assert.equal(
    out.filter((it) => (it as { videoUrl?: string }).videoUrl).length,
    3,
    "解析成功的条目全部回写 videoUrl（模型转述非首条也能播放）",
  );
});

test("video.find 回执 → 播放卡取首个可播条目，且正文不带文案", () => {
  const result = {
    provider: "video.find",
    items: [
      { title: "无流候选", pageUrl: "https://www.douyin.com/video/1" },
      { title: "李白教学", pageUrl: "https://www.bilibili.com/video/av2", videoUrl: "https://cdn.example/a.mp4" },
      { title: "备用", pageUrl: "https://www.bilibili.com/video/av3", videoUrl: "https://cdn.example/b.mp4" },
    ],
  } as unknown as Record<string, unknown>;

  const source = resolveVideoMediaSource("video.find", result);
  assert.equal(source?.title, "李白教学", "取第一个带 videoUrl 的条目");

  const marked = attachVideoMediaMarker("给你找到一个视频，讲得挺清楚的，点开看看。", "video.find", result);
  assert.ok(marked.startsWith("[RENDER_AS:video]"));
  assert.ok(marked.includes("/agent/media/proxy?url="), "媒体地址必须走后端代理");
  const body = marked.split("[RENDER_AS:video]")[1]?.split("[VIDEO_MEDIA_START]")[0]?.trim() ?? "";
  assert.equal(body, "", "视频轮正文不得残留任何文案（面板纯视频）");
});

test("媒体卡带 playableUrl：视频卡点击走应用内面板，不再跳外链", () => {
  // 2026-10-02 根修：extractMediaCards 原先只下发 pageUrl，前端视频卡点击一律
  // launchUrl 打开浏览器——用户「看视频」被丢到站外。有流必须下发代理地址。
  const result = {
    provider: "search_videos",
    items: [
      {
        title: "猫咪合集",
        pageUrl: "https://www.bilibili.com/video/av77",
        thumbnailUrl: "https://i.example/thumb.jpg",
        videoUrl: "https://cdn.example/a.mp4",
      },
      { title: "无可播流", pageUrl: "https://www.douyin.com/video/9", thumbnailUrl: "https://i.example/t2.jpg" },
    ],
  } as unknown as Record<string, unknown>;
  const cards = extractMediaCards("search_videos", result);
  assert.equal(cards.length, 2);
  const playable = cards[0]!.playableUrl ?? "";
  assert.ok(playable.startsWith("/agent/media/proxy?url="), `可播流未下发：${JSON.stringify(cards[0])}`);
  assert.ok(playable.includes(encodeURIComponent("https://cdn.example/a.mp4")));
  assert.ok(playable.includes("referer="), "代理需带 referer 破防盗链");
  assert.equal(cards[1]!.playableUrl, undefined, "没解析出流的条目不下发 playableUrl（前端降级开播放页）");
});

test("视频卡排序：可播条目排在前，用户点开第一条就在应用内播", () => {
  // 无流条目原本可能占据前排（抖音页解析不出流的当下很常见），用户点第一张卡
  // 被丢到浏览器——看着就像「还是进链接」。有流的必须前置。
  const result = {
    provider: "search_videos",
    items: [
      { title: "抖音A", pageUrl: "https://www.douyin.com/video/1", thumbnailUrl: "https://i.example/a.jpg" },
      { title: "抖音B", pageUrl: "https://www.douyin.com/video/2", thumbnailUrl: "https://i.example/b.jpg" },
      { title: "B站可播", pageUrl: "https://www.bilibili.com/video/av3", thumbnailUrl: "https://i.example/c.jpg", videoUrl: "https://cdn.example/c.mp4" },
    ],
  } as unknown as Record<string, unknown>;
  const cards = extractMediaCards("search_videos", result);
  assert.equal(cards[0]!.title, "B站可播", `可播条目未前置：${cards.map((c) => c.title).join("|")}`);
  assert.ok(cards[0]!.playableUrl?.startsWith("/agent/media/proxy"));
});

test("video.find 无可播流时不吞掉模型正文（降级为文本+原链接）", () => {
  const result = {
    items: [{ title: "候选", pageUrl: "https://www.douyin.com/video/1" }],
  } as unknown as Record<string, unknown>;
  assert.equal(resolveVideoMediaSource("video.find", result), null);
  const text = "没找到能直接播放的，先看这个链接。";
  assert.equal(attachVideoMediaMarker(text, "video.find", result), text);
});
