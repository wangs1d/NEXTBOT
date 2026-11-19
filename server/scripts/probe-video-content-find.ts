/**
 * 按内容找视频真链探针（2026-10-02 video.find 配套）。
 *
 * 验证「用户只说想看什么（不给链接）→ 模型召回 video.find → 搜候选 → 解析出
 * 可播放流 → 确定性附视频媒体卡 → 代理能取回真实字节」全链：
 *   1. RuntimeKernel.planTurn：纯内容诉求是否 pin 中 video.find，且把只出链接的
 *      search_videos 剔除（模型选错工具是这条链最大的历史坑）；
 *   2. video.find 真实执行（Bing 视频 + B站搜索 双源 → 并发 grab 解析流）；
 *   3. attachVideoMediaMarker（生产同款确定性附卡）：回复只留播放卡、不带文案；
 *   4. 拿媒体卡里的 mediaUrl/thumbnailUrl 打常驻实例代理路由（或直连带 referer
 *      兜底），验证真能取回视频/封面字节；
 *   5. 真实 LLM 轮（provider 启用时）：模型是否真的选 video.find 而非 search_videos。
 *
 * 用法：cd server && npx tsx scripts/probe-video-content-find.ts [查询词]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

const RESIDENT_BASE = process.env.PROBE_RESIDENT_BASE ?? "http://127.0.0.1:3000";
const QUERY = process.argv.slice(2).join(" ").trim() || "王者荣耀 李白 打野教学";
/** 模拟用户原始说法（纯内容诉求、不带任何链接） */
const USER_TEXT = `来个${QUERY}的视频看看`;

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function note(msg: string): void {
  console.log(`      · ${msg}`);
}

async function main(): Promise<void> {
  console.log(`[0] query=${QUERY}\n[0] userText=${USER_TEXT}`);

  // ---------- 1. kernel pin：纯内容诉求必须 pin video.find，且剔除 search_videos ----------
  const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
  const kernel = getRuntimeKernel();
  kernel.update({ enabled: true } as never);
  const plan = kernel.planTurn(USER_TEXT);
  console.log(`[1] pinned=[${plan.pinnedToolNames.join(",")}] profile=${plan.toolExposureProfile}`);
  if (!plan.pinnedToolNames.includes("video.find")) {
    fail("纯内容看片诉求未 pin 中 video.find");
  }
  if (plan.pinnedToolNames.includes("search_videos")) {
    fail("纯内容看片诉求仍暴露 search_videos（会诱导模型只回链接列表）");
  }

  // ---------- 2. video.find 真实执行：搜候选 → 并发解析可播放流 ----------
  const { VideoGrabService, setVideoGrabServiceRef } = await import(
    "../src/services/video-grab-service.js"
  );
  const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
  const { registerVideoTools } = await import("../src/tools/video-tools.js");
  const { ToolRegistry } = await import("../src/tools/tool-registry.js");

  const videoGrabService = new VideoGrabService();
  setVideoGrabServiceRef(videoGrabService);

  const search = new UpstreamSearchService(null as never);
  const registry = new ToolRegistry() as never as {
    register: (n: string, h: unknown) => void;
    execute: (n: string, a: unknown, c?: unknown) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  };
  registerVideoTools(registry as never, videoGrabService, search);
  // 合成点：search 束桩（video.find 场景不应被模型/链路依赖）
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 桩，不应调用` } });
  for (const name of ["search_web", "search_images", "search_videos", "fetch_web"]) {
    registry.register(name, stub.bind(null, name));
  }

  const t0 = Date.now();
  const out = await registry.execute("video.find", { query: QUERY, limit: 2 }, { actorId: "video-find-probe" });
  const ms = Date.now() - t0;
  const result = (out?.result ?? {}) as {
    items?: Array<Record<string, unknown>>;
    notes?: string[];
  };
  const items = Array.isArray(result.items) ? result.items : [];
  const playable = items.filter((it) => String(it.videoUrl ?? "").trim());
  console.log(`[2] ${ms}ms items=${items.length} playable=${playable.length} notes=${JSON.stringify(result.notes ?? [])}`);
  for (const it of items.slice(0, 6)) {
    console.log(
      `      ${String(it.videoUrl ?? "").trim() ? "✔" : "✘"} ${String(it.platform ?? "-")} ${String(it.title ?? "").slice(0, 34)} | ${String(it.pageUrl ?? "").slice(0, 60)}`,
    );
  }
  if (!out?.ok) fail(`video.find 执行失败：${JSON.stringify(result).slice(0, 300)}`);
  if (items.length === 0) fail("video.find 未搜到任何候选（搜索源全挂？）");
  if (playable.length === 0) fail("候选页均未解析出可播放流——「按内容找视频」链路断裂");

  const first = playable[0]!;
  console.log(`[2] 首选：${String(first.title ?? "").slice(0, 40)} / ${String(first.author ?? "")} / ${String(first.platform ?? "")}`);

  // ---------- 3. 生产同款确定性附卡：正文只留播放卡、不带文案 ----------
  const { attachVideoMediaMarker } = await import("../src/services/tool-result-processor.js");
  const marked = attachVideoMediaMarker("给你找到一个视频，讲得挺清楚的，点开看看。", "video.find", result);
  const m = /\[VIDEO_MEDIA_START\]\n([\s\S]*?)\n\[VIDEO_MEDIA_END\]/.exec(marked);
  if (!m) fail("回复未附 [VIDEO_MEDIA_START] 媒体标记");
  const payload = JSON.parse(m![1]!) as { mediaUrl?: string; thumbnailUrl?: string; title?: string };
  if (!payload.mediaUrl?.includes("/agent/media/proxy?url=")) fail(`mediaUrl 非代理地址：${payload.mediaUrl}`);
  const bodyText = marked.split("[RENDER_AS:video]")[1]?.split("[VIDEO_MEDIA_START]")[0]?.trim() ?? "";
  console.log(`[3] 标记 OK  mediaUrl=${payload.mediaUrl.slice(0, 80)}…  thumb=${payload.thumbnailUrl ? "有" : "无"}`);
  console.log(`[3] 正文残留文案=「${bodyText.slice(0, 60)}」${bodyText ? "" : "（空，符合「面板播放不带文案」定稿）"}`);
  if (bodyText) fail(`视频轮正文仍带文案：${bodyText.slice(0, 80)}`);

  // ---------- 4. 字节校验：优先打常驻实例代理路由，未起服务则直连带 referer 兜底 ----------
  const pageUrl = String(first.playPageUrl ?? first.pageUrl ?? "").trim();
  const rawUrl = String(first.videoUrl ?? "").trim();
  const base = RESIDENT_BASE.replace(/\/$/, "");
  const checkUrl = async (rel: string, kind: string, minBytes: number): Promise<void> => {
    const res = await fetch(`${base}${rel}`, { signal: AbortSignal.timeout(45_000) });
    const buf = await res.arrayBuffer();
    const ctype = res.headers.get("content-type") ?? "";
    console.log(`[4] ${kind} HTTP ${res.status} ${ctype} ${(buf.byteLength / 1024).toFixed(0)}KB`);
    if (!res.ok) fail(`${kind} 代理请求失败 HTTP ${res.status}`);
    if (buf.byteLength < minBytes) fail(`${kind} 字节过小(${buf.byteLength})，疑似错误响应`);
    if (kind === "视频" && !/video|octet-stream|mpegurl/.test(ctype)) fail(`视频 content-type 异常：${ctype}`);
  };
  let resident = false;
  try {
    const ping = await fetch(`${base}/agent/media/proxy?url=${encodeURIComponent(rawUrl)}`, {
      method: "GET",
      headers: { range: "bytes=0-1" },
      signal: AbortSignal.timeout(8_000),
    });
    resident = ping.status < 500;
  } catch {
    resident = false;
  }
  if (resident) {
    await checkUrl(payload.mediaUrl!, "视频", 60_000);
    if (payload.thumbnailUrl) await checkUrl(payload.thumbnailUrl, "封面", 3_000);
  } else {
    note(`常驻实例(${base})不可达，直连上游带 referer 兜底校验`);
    for (const [kind, url, minBytes] of [
      ["视频", payload.mediaUrl!.replace(/^\/agent\/media\/proxy\?url=/, "").split("&referer=")[0]!, 60_000],
      ["封面", (payload.thumbnailUrl ?? "").replace(/^\/agent\/media\/proxy\?url=/, "").split("&referer=")[0]!, 3_000],
    ] as Array<[string, string, number]>) {
      if (!url) {
        console.log(`[4] ${kind} 无（跳过）`);
        continue;
      }
      const res = await fetch(decodeURIComponent(url), {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0", referer: pageUrl || "https://www.bilibili.com/" },
        signal: AbortSignal.timeout(45_000),
      });
      const buf = await res.arrayBuffer();
      console.log(`[4] ${kind} 直连 HTTP ${res.status} ${res.headers.get("content-type") ?? ""} ${(buf.byteLength / 1024).toFixed(0)}KB`);
      if (!res.ok) fail(`${kind} 直连失败 HTTP ${res.status}`);
      if (buf.byteLength < minBytes) fail(`${kind} 字节过小(${buf.byteLength})`);
    }
  }

  // ---------- 5. 真实 LLM 轮：模型是否真的选 video.find ----------
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.log("[5] 外部模型未启用，跳过 LLM 轮（链路 1-4 已覆盖确定性部分）");
  } else {
    const calls: Array<{ name: string; ok: boolean; result: Record<string, unknown> }> = [];
    const toolCtx = {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        let r: { ok: boolean; result: Record<string, unknown> };
        try {
          const o = await registry.execute(name, args, { actorId: "video-find-probe" });
          r = { ok: Boolean(o?.ok), result: (o?.result ?? {}) as Record<string, unknown> };
        } catch (err) {
          r = { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
        }
        calls.push({ name, ok: r.ok, result: r.result });
        return r;
      },
    };
    const sessionId = `video-find-probe-${Date.now()}`;
    const t1 = Date.now();
    const final = await (
      provider as never as {
        streamCompletion: (s: string, m: unknown, d: () => void, c: unknown, o: unknown) => Promise<string>;
      }
    ).streamCompletion(
      sessionId,
      { text: USER_TEXT },
      () => {},
      toolCtx,
      {
        toolExposureProfile: plan.toolExposureProfile,
        pinnedToolNames: plan.pinnedToolNames,
        agentAccessMode: "full",
        toolLoop: { maxRounds: 3 },
        turnIntent: "chat",
      } as never,
    );
    provider.clearSession?.(sessionId);
    console.log(`[5] ${Date.now() - t1}ms calls=[${calls.map((c) => `${c.name}${c.ok ? "" : "(fail)"}`).join(",") || "无"}] reply=${final.length}字`);
    const findCalls = calls.filter((c) => c.name === "video.find");
    if (findCalls.length === 0) {
      fail(`模型未调用 video.find（实际：${calls.map((c) => c.name).join(",") || "无"}）`);
    }
    console.log(`[5] 模型命中 video.find ✔（${findCalls.length} 次）`);
  }

  console.log("\n=== ALL PASS：内容诉求 → video.find → 可播流 → 播放卡（无文案）→ 字节可取回 ===");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
