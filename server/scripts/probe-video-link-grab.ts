/**
 * 视频链接解析真链探针（2026-10-02 video.grab 补模型入口配套）。
 *
 * 验证「用户给链接 → 模型召回 video.grab → 解析出无水印流 → 确定性附视频媒体卡」全链：
 *   1. RuntimeKernel.planTurn：含抖音短链的消息是否 pin 中 video.grab（scoped 档）；
 *   2. provider.streamCompletion 生产同源解析（pinnedToolNames 透传）：真实 LLM 是否真的调 video.grab；
 *   3. attachVideoMediaMarker（生产同款确定性附卡）：回复是否带 [VIDEO_MEDIA_START] + /agent/media/proxy 地址；
 *   4. 拿媒体卡里的 mediaUrl/thumbnailUrl 打常驻实例真机代理路由，验证真能取回视频/封面字节（Windows 端系统播放器吃的就是这份流）。
 *
 * 唯一合成点：search 工具束（search_images/search_videos/fetch_web 等）注册桩——
 * 解析场景模型不应调用它们，桩仅兜底防误调用炸轮。
 *
 * 用法：cd server && npx tsx scripts/probe-video-link-grab.ts
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

const RESIDENT_BASE = process.env.PROBE_RESIDENT_BASE ?? "http://127.0.0.1:3000";
const USER_TEXT =
  "7.72 gYd:/ 复制打开抖音，看看【王者荣耀的作品】这个操作教学太细节了兄弟们 https://v.douyin.com/72yTQE/ 帮我解析一下这个视频，我要无水印的";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // ---------- 1. kernel pin：链接消息必须 pin 中 video.grab ----------
  const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
  const kernel = getRuntimeKernel();
  kernel.update({ enabled: true } as never);
  const plan = kernel.planTurn(USER_TEXT);
  console.log(`[1] pinned=[${plan.pinnedToolNames.join(",")}] profile=${plan.toolExposureProfile}`);
  if (!plan.pinnedToolNames.includes("video.grab")) {
    fail("含抖音短链的消息未 pin 中 video.grab");
  }
  if (plan.toolExposureProfile !== "scoped") {
    fail(`期望 scoped 档，实际 ${plan.toolExposureProfile}`);
  }

  // ---------- 2. 真实 LLM 轮：生产同源解析 + 真实执行器 ----------
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const { VideoGrabService, setVideoGrabServiceRef } = await import("../src/services/video-grab-service.js");
  const { registerVideoTools } = await import("../src/tools/video-tools.js");
  const { ToolRegistry } = await import("../src/tools/tool-registry.js");

  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) fail("外部模型 provider 未启用");

  const videoGrabService = new VideoGrabService();
  setVideoGrabServiceRef(videoGrabService);
  const registry = new ToolRegistry() as never as { register: (n: string, h: unknown) => void; execute: (n: string, a: unknown, c?: unknown) => Promise<{ ok: boolean; result: Record<string, unknown> }> };
  registerVideoTools(registry as never, videoGrabService);
  // 合成点：search 束桩（解析场景不应被调用）
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 桩，不应调用` } });
  for (const name of ["search_web", "search_images", "search_videos", "fetch_web"]) {
    registry.register(name, stub.bind(null, name));
  }

  const calls: Array<{ name: string; ok: boolean; result: Record<string, unknown> }> = [];
  const toolCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      let r: { ok: boolean; result: Record<string, unknown> };
      try {
        const out = await (registry as never as { execute: (n: string, a: unknown, c?: unknown) => Promise<{ ok: boolean; result: Record<string, unknown> }> }).execute(name, args, { actorId: "video-probe" });
        r = { ok: Boolean(out?.ok), result: (out?.result ?? {}) as Record<string, unknown> };
      } catch (err) {
        r = { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
      calls.push({ name, ok: r.ok, result: r.result });
      return r;
    },
  };

  const sessionId = `video-grab-probe-${Date.now()}`;
  let final = "";
  const t0 = Date.now();
  final = await (provider as never as { streamCompletion: (s: string, m: unknown, d: () => void, c: unknown, o: unknown) => Promise<string> }).streamCompletion(
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
  console.log(`[2] ${Date.now() - t0}ms calls=[${calls.map((c) => `${c.name}${c.ok ? "" : "(fail)"}`).join(",") || "无"}] reply=${final.length}字`);

  const videoCalls = calls.filter((c) => c.name === "video.grab");
  const videoCall = videoCalls[videoCalls.length - 1];
  if (!videoCall) fail(`模型未调用 video.grab（实际：${calls.map((c) => c.name).join(",") || "无"}）`);
  if (!videoCall.ok) fail(`video.grab 执行失败：${JSON.stringify(videoCall.result).slice(0, 300)}`);
  const videoUrl = String(videoCall.result.videoUrl ?? "");
  if (!videoUrl) fail(`video.grab 结果无可播放流：${JSON.stringify(videoCall.result).slice(0, 300)}`);
  console.log(`[2] videoUrl=${videoUrl.slice(0, 90)}… title=${String(videoCall.result.title ?? "").slice(0, 40)}`);

  // ---------- 3. 生产同款确定性附卡 ----------
  const { attachVideoMediaMarker } = await import("../src/services/tool-result-processor.js");
  const marked = attachVideoMediaMarker(final, "video.grab", videoCall.result);
  const m = /\[VIDEO_MEDIA_START\]\n([\s\S]*?)\n\[VIDEO_MEDIA_END\]/.exec(marked);
  if (!m) fail("回复未附 [VIDEO_MEDIA_START] 媒体标记");
  const payload = JSON.parse(m![1]!) as { mediaUrl?: string; thumbnailUrl?: string; title?: string; pageUrl?: string };
  if (!payload.mediaUrl?.includes("/agent/media/proxy?url=")) fail(`mediaUrl 非代理地址：${payload.mediaUrl}`);
  console.log(`[3] 标记 OK  mediaUrl=${payload.mediaUrl.slice(0, 80)}…  thumb=${payload.thumbnailUrl ? "有" : "无"}`);
  console.log(`[3] 回复正文（剥标记后首 120 字）：${marked.split("[RENDER_AS:video]")[1]?.split("[VIDEO_MEDIA_START]")[0]?.trim().slice(0, 120) ?? "(空)"}`);

  // ---------- 4. 真机代理路由：验证视频/封面字节可取回（系统播放器吃的流） ----------
  const base = RESIDENT_BASE.replace(/\/$/, "");
  const checkUrl = async (rel: string, kind: string, minBytes: number): Promise<void> => {
    const res = await fetch(`${base}${rel}`, { signal: AbortSignal.timeout(45_000) });
    const buf = await res.arrayBuffer();
    const ctype = res.headers.get("content-type") ?? "";
    console.log(`[4] ${kind} HTTP ${res.status} ${ctype} ${(buf.byteLength / 1024).toFixed(0)}KB`);
    if (!res.ok) fail(`${kind} 代理请求失败 HTTP ${res.status}`);
    if (buf.byteLength < minBytes) fail(`${kind} 字节过小(${buf.byteLength})，疑似错误响应`);
    if (kind === "视频" && !/video|octet-stream/.test(ctype)) fail(`视频 content-type 异常：${ctype}`);
  };
  await checkUrl(payload.mediaUrl!, "视频", 100_000);
  if (payload.thumbnailUrl) await checkUrl(payload.thumbnailUrl, "封面", 5_000);

  console.log("\n=== ALL PASS：链接召回 → 真实解析 → 媒体卡附上 → 代理流可播放 ===");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
