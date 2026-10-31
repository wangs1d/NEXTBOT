import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";

import { resolveLyricByMeta } from "../../services/media-lyric-service.js";
import { resolveTrackPlayUrl } from "../../services/media-music-service.js";

/**
 * 媒体音乐流代理路由（客户端直连失败时的兜底）：
 *
 *   GET /api/media/stream-proxy?trackId=<网易云曲目ID>
 *
 * 背景：`agent.media.play` 事件把网易云的播放 URL 直接下发给客户端，但该 URL
 * （m7/m8.music.net.cn 等）存在防盗链/UA 限制，部分网络环境下客户端直连 403。
 * 本路由由服务端先 resolveTrackPlayUrl(trackId) 解析出真实 URL，再代为拉流转发：
 *   - 透传 Range 请求头，支持 audioplayers seek / 断点续播
 *   - 透传 Content-Type / Content-Length / Content-Range / Accept-Ranges
 *   - 客户端断开时主动销毁上游连接，避免资源泄漏
 *
 * 安全边界：只接受 trackId（上游 URL 完全由网易云接口决定），不做任意 URL 开放
 * 代理——通用 URL 代理已有 /agent/media/proxy（video-files.ts），不要混淆两者。
 *
 * 与 /agent/media/proxy 的取舍：本路由多一步"trackId → URL"解析且上游固定为
 * 网易云，逻辑足够独立；复用 video-files.ts 的 proxyStream 需要先改它导出内部
 * 函数（增大并行改动冲突面），故此处自带一份精简透传实现。
 */

/** 浏览器 UA（网易云音频 CDN 对非浏览器 UA 会 403） */
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 注册媒体流代理路由。无外部依赖（URL 解析走模块级 LRU 缓存），注册处一行即可。 */
export function registerMediaStreamProxyRoutes(app: FastifyInstance): void {
  app.get("/api/media/stream-proxy", async (request, reply) => {
    const query = (request.query ?? {}) as { trackId?: string };
    const trackId = String(query.trackId ?? "").trim();
    if (!trackId) {
      return reply.code(400).send({ ok: false, reason: "trackId 不能为空" });
    }

    // 解析播放 URL：无版权/超时等失败一律如实 4xx/5xx + JSON 原因，绝不重定向到编造地址
    const resolved = await resolveTrackPlayUrl(trackId);
    if (!resolved.ok) {
      return reply.code(404).send({ ok: false, reason: resolved.error });
    }

    let target: URL;
    try {
      target = new URL(resolved.url);
    } catch {
      return reply.code(502).send({ ok: false, reason: "上游返回的播放地址无效" });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return reply.code(502).send({ ok: false, reason: "仅支持 http/https 上游" });
    }

    return proxyAudioStream(request, reply, target);
  });
}

/**
 * 注册本地播放歌曲的歌词查询路由：
 *
 *   GET /api/media/lyric?title=&artist=&album=&duration=
 *
 * 客户端从系统 SMTC 拿到正在播放的曲目元数据后请求本接口。未命中/无歌词
 * 以 200 + `matched:false` + `reason` 如实返回，让客户端展示原因而不是空卡；
 * 只有标题缺失才是 400。
 */
export function registerMediaLyricRoutes(app: FastifyInstance): void {
  app.get("/api/media/lyric", async (request, reply) => {
    const query = (request.query ?? {}) as {
      title?: string;
      artist?: string;
      album?: string;
      duration?: string;
    };
    const title = String(query.title ?? "").trim();
    if (!title) {
      return reply.code(400).send({ ok: false, reason: "title 不能为空" });
    }

    const durationSec = Number(query.duration ?? 0);
    const result = await resolveLyricByMeta({
      title,
      artist: String(query.artist ?? "").trim() || undefined,
      album: String(query.album ?? "").trim() || undefined,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
    });
    return reply.send(result);
  });
}


/** 透传代理：转发 Range 并回流上游音频流（精简自 video-files.ts 的 proxyStream）。 */
function proxyAudioStream(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
): Promise<void> {
  return new Promise((resolve) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      "user-agent": WEB_USER_AGENT,
      accept: "*/*",
      referer: "https://music.163.com/",
    };
    // Range 透传：audioplayers 拖动/续播会带 Range 头，不透传则 seek 全部失败
    const range = request.headers.range;
    if (typeof range === "string" && range) headers.range = range;

    const upReq = transport(
      target,
      { method: "GET", headers },
      (upRes: IncomingMessage) => {
        const status = upRes.statusCode ?? 200;
        if (status >= 400) {
          upRes.resume();
          reply.code(502).send({ ok: false, reason: `上游返回 ${status}` });
          resolve();
          return;
        }
        const contentType = upRes.headers["content-type"];
        if (contentType) void reply.header("Content-Type", contentType);
        const contentLength = upRes.headers["content-length"];
        if (contentLength) void reply.header("Content-Length", contentLength);
        const contentRange = upRes.headers["content-range"];
        if (contentRange) void reply.header("Content-Range", contentRange);
        void reply.header("Accept-Ranges", upRes.headers["accept-ranges"] ?? "bytes");
        void reply.header("Cache-Control", "public, max-age=600");
        void reply.header("Access-Control-Allow-Origin", "*");
        void reply.header("Access-Control-Allow-Headers", "Range");
        void reply.header(
          "Access-Control-Expose-Headers",
          "Content-Length, Content-Range, Accept-Ranges",
        );

        void reply.code(status);
        void reply.send(upRes);
        upRes.on("end", () => resolve());
        upRes.on("error", () => resolve());
      },
    );

    // 客户端断开时销毁上游连接
    request.raw.on("close", () => {
      if (!reply.sent) return;
      upReq.destroy();
    });

    // 仅覆盖"建连/响应首包"的等待；进入流式后由 upRes 的 end/error 收尾
    upReq.setTimeout(15_000, () => {
      upReq.destroy(new Error("stream-proxy upstream connect timeout"));
    });

    upReq.on("error", (err: Error) => {
      if (reply.sent) return;
      reply.code(502).send({ ok: false, reason: `代理失败: ${err.message}` });
      resolve();
    });

    upReq.end();
  });
}
