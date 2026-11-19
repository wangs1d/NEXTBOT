/**
 * 视频卡「点击即在应用内播放」真链探针（2026-10-02）。
 *
 * 背景：媒体卡（`_MediaCard` / `MediaInlineRow` 里的视频条目）原先只下发
 * pageUrl，前端点击一律 `launchUrl` 把用户丢到浏览器——用户诉求是「双面板里看」，
 * 不是跳站外。本探针验证修完后整链：
 *   1. search_videos 真执行（搜候选 → 并发解析可播流 → items 回写 videoUrl）；
 *   2. extractMediaCards（生产同款组卡）把可播流落成 `playableUrl`（经
 *      /agent/media/proxy 代理 + referer 破防盗链）；
 *   3. 无流的条目不带 playableUrl（前端才降级打开播放页）；
 *   4. 首条 playableUrl 真能取回视频字节（常驻实例代理优先，未起服务则直连）。
 *
 * 用法：cd server && npx tsx scripts/probe-video-card-playable.ts [查询词]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

const RESIDENT_BASE = process.env.PROBE_RESIDENT_BASE ?? "http://127.0.0.1:3000";
const QUERY = process.argv.slice(2).join(" ").trim() || "猫咪 搞笑 合集";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function note(msg: string): void {
  console.log(`      · ${msg}`);
}

async function main(): Promise<void> {
  console.log(`[0] query=${QUERY}`);

  // ---------- 1. search_videos 真执行：候选 → 并发解析可播流 ----------
  const { VideoGrabService, setVideoGrabServiceRef } = await import(
    "../src/services/video-grab-service.js"
  );
  const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
  const { enrichVideosWithPlayable } = await import("../src/tools/video-tools.js");

  const videoGrabService = new VideoGrabService();
  setVideoGrabServiceRef(videoGrabService);

  const search = new UpstreamSearchService(null as never);
  const t0 = Date.now();
  const raw = await search.searchVideos(QUERY, 8);
  const { items } = await enrichVideosWithPlayable(raw, videoGrabService, 3);
  const playable = items.filter((it) => String((it as { videoUrl?: string }).videoUrl ?? "").trim());
  console.log(`[1] ${Date.now() - t0}ms items=${items.length} playable=${playable.length}`);
  if (items.length === 0) fail("未搜到任何视频候选（搜索源全挂？）");
  if (playable.length === 0) fail("候选页均未解析出可播放流——视频卡只能退化成链接");

  // ---------- 2. 生产同款组卡：可播流必须落成 playableUrl ----------
  const { extractMediaCards } = await import("../src/services/tool-result-processor.js");
  const cards = extractMediaCards("search_videos", {
    provider: raw.provider,
    mediaType: "video",
    items,
    notes: raw.notes,
  } as unknown as Record<string, unknown>);
  console.log(`[2] cards=${cards.length}`);
  for (const c of cards.slice(0, 6)) {
    const ok = Boolean(c.playableUrl);
    console.log(
      `      ${ok ? "✔面板" : "✘外链"} ${String(c.title ?? "").slice(0, 28)} | playable=${(c.playableUrl ?? "-").slice(0, 62)}`,
    );
  }
  const firstPlayable = cards.find((c) => c.playableUrl);
  if (!firstPlayable) fail("组卡后没有任何条目带 playableUrl——前端视频卡仍会跳浏览器");
  if (!firstPlayable.playableUrl!.startsWith("/agent/media/proxy?url=")) {
    fail(`playableUrl 未走后端代理：${firstPlayable.playableUrl}`);
  }
  if (!firstPlayable.playableUrl!.includes("referer=")) fail("playableUrl 缺 referer（防盗链会拦截）");

  // ---------- 3. 无流条目不带 playableUrl（前端才降级开播放页） ----------
  const noStream = cards.filter((c) => !c.playableUrl);
  console.log(`[3] 无流条目=${noStream.length}（这些才降级为打开播放页）`);
  for (const c of noStream.slice(0, 3)) {
    if (c.playableUrl !== undefined) fail(`无流条目却带了 playableUrl：${String(c.title)}`);
  }

  // ---------- 4. 字节校验：首条 playableUrl 真能取回视频 ----------
  const base = RESIDENT_BASE.replace(/\/$/, "");
  let resident = false;
  try {
    const ping = await fetch(`${base}/agent/media/proxy?url=${encodeURIComponent("https://example.com/")}`, {
      signal: AbortSignal.timeout(6_000),
    });
    resident = ping.status < 500;
  } catch {
    resident = false;
  }
  const rel = firstPlayable.playableUrl!;
  const rawUrl = decodeURIComponent(rel.replace(/^\/agent\/media\/proxy\?url=/, "").split("&referer=")[0]!);
  const pageUrl = firstPlayable.pageUrl ?? "";
  const url = resident ? `${base}${rel}` : rawUrl;
  const headers: Record<string, string> = resident
    ? {}
    : {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0",
        referer: pageUrl || "https://www.bilibili.com/",
      };
  console.log(`[4] ${resident ? "常驻代理" : "直连兜底"} ${url.slice(0, 70)}…`);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  const buf = await res.arrayBuffer();
  const ctype = res.headers.get("content-type") ?? "";
  console.log(`[4] HTTP ${res.status} ${ctype} ${(buf.byteLength / 1024).toFixed(0)}KB`);
  if (!res.ok) fail(`视频流请求失败 HTTP ${res.status}`);
  if (buf.byteLength < 60_000) fail(`视频字节过小(${buf.byteLength})，疑似错误响应`);
  if (!/video|octet-stream|mpegurl/.test(ctype)) fail(`content-type 非视频：${ctype}`);

  console.log("\n=== ALL PASS：视频卡点击 → playableUrl → 应用内双栏面板播放（不再跳外链）===");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
