// 内部事件流：客户端版本清单变化推送（2026-10-21，webhook 语义）
//
// GET /api/internal/manifest-events?token=<MANIFEST_EVENT_TOKEN>
//   —— text/event-stream 长连接。运行「更新控制面」的机器（ECS）上：
//   ① 订阅建立即全量推送当前所有清单（主/cloud/oss，订阅端按自身 edition 过滤）；
//   ② fs.watch 监听 config/ 下 client-manifest*.json，文件被改（发版 = 改文件）
//      防抖 300ms 后立即推送变化清单——发布方改完文件，下游（腾讯机云端网关、
//      byok 本地 runtime）秒级收到并广播 update.available 给在线客户端。
//   ③ 30s 注释行心跳保活（防 nginx proxy_read_timeout 默认 60s 掐链）。
//
// 安全：MANIFEST_EVENT_TOKEN 未配置时端点整体禁用（403）——只在控制面机器上配置；
// token 经 query 传递（SSE 客户端不方便带自定义头，与 ws token 同模式）。
// nginx 侧无需改配置：X-Accel-Buffering: no 响应头即关闭响应缓冲。
//
// 部署拓扑：ECS = 源（配 MANIFEST_EVENT_TOKEN）；腾讯机/本地 runtime = 订阅方
// （配 UPDATE_MANIFEST_SOURCE_URL + UPDATE_MANIFEST_EVENT_TOKEN，见
// services/client-update-pusher.ts）。

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readClientManifest } from "./client-manifest.js";

const CONFIG_DIR = join(process.cwd(), "config");
const MANIFEST_FILE_RE = /^client-manifest(?:\.([a-z0-9-]+))?\.json$/;
/** 订阅建立时全量推送的清单集合：主清单（edition=null）+ 已知分发版 */
const KNOWN_EDITIONS: (string | null)[] = [null, "cloud", "oss"];
const DEBOUNCE_MS = 300;
const PING_INTERVAL_MS = 30_000;

type StreamState = { timer: ReturnType<typeof setTimeout> | null };

export function registerInternalManifestEventRoutes(app: FastifyInstance): void {
  app.get("/api/internal/manifest-events", async (request, reply) => {
    const expected = process.env.MANIFEST_EVENT_TOKEN?.trim();
    const query = (request.query ?? {}) as { token?: string };
    // 未配置 token = 端点禁用（非控制面机器/未部署该机制时对外不可见）
    if (!expected || String(query.token ?? "") !== expected) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // 关键：nginx 依此头跳过响应缓冲——没有它 SSE 帧会被攒到断连才到达订阅方
      "x-accel-buffering": "no",
    });

    const push = (edition: string | null, manifest: Awaited<ReturnType<typeof readClientManifest>>): void => {
      if (raw.writableEnded || raw.destroyed) return;
      try {
        raw.write(`data: ${JSON.stringify({ edition, manifest })}\n\n`);
      } catch {
        /* 写失败由 close 清理路径收尾 */
      }
    };

    // 订阅建立：立即全量推一遍（订阅端以此做重连校准——断连期间漏掉的
    // 变化由这里补齐，无需依赖订阅端额外轮询）
    for (const edition of KNOWN_EDITIONS) {
      try {
        push(edition, await readClientManifest(edition));
      } catch {
        // 单份清单读取失败不影响其余（文件缺失时 readClientManifest 自带兜底）
      }
    }

    const state: StreamState = { timer: null };
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(CONFIG_DIR, (_event, filename) => {
        const name = String(filename ?? "");
        const m = MANIFEST_FILE_RE.exec(name);
        if (!m) return;
        if (state.timer) clearTimeout(state.timer);
        // 防抖：编辑器/脚本可能分多次写入同一文件，只推最终内容
        state.timer = setTimeout(() => {
          state.timer = null;
          const edition = m[1] ?? null;
          readClientManifest(edition)
            .then((manifest) => push(edition, manifest))
            .catch(() => {});
        }, DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        /* watch 失败（如目录异常）：连接保持，仅失去变化推送，订阅端重连可校准 */
      });
    } catch {
      // config 目录 watch 不可用：连接保持（仅全量推送可用），不做致命处理
    }

    const ping = setInterval(() => {
      try {
        if (!raw.writableEnded && !raw.destroyed) raw.write(": ping\n\n");
      } catch {
        /* 忽略 */
      }
    }, PING_INTERVAL_MS);

    const cleanup = (): void => {
      clearInterval(ping);
      if (state.timer) clearTimeout(state.timer);
      watcher?.close();
    };
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  });
}
