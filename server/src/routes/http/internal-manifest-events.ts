// 内部事件流：客户端版本清单变化推送（2026-10-21，webhook 语义）
//
// GET /api/internal/manifest-events  （头 x-manifest-event-token: <MANIFEST_EVENT_TOKEN>）
//   —— text/event-stream 长连接。运行「更新控制面」的机器（ECS）上：
//   ① 订阅建立即全量推送当前所有清单（主/cloud/oss，订阅端按自身 edition 过滤）；
//   ② fs.watch 监听 config/ 下 client-manifest*.json，文件被改（发版 = 改文件）
//      防抖 300ms 后立即推送变化清单——发布方改完文件，订阅进程秒级收到并广播
//      update.available 给在线客户端。
//   ③ 30s 注释行心跳保活（防 nginx proxy_read_timeout 默认 60s 掐链）。
//
// 安全：MANIFEST_EVENT_TOKEN 未配置时端点整体禁用（403）；口令只走
// x-manifest-event-token 请求头——query 串会原样落进 nginx access.log 与进程请求
// 日志，等于控制面凭证常驻写盘。
//
// 可达范围：控制面内部端点，不对公网开放。订阅方必须是同机进程（nginx 侧
// allow 127.0.0.1 / deny all，进程又只监听 LISTEN_HOST=127.0.0.1）；控制面自己
// 回环订阅，这样握着客户端 wss 的那台机器就是广播方。装机客户端不订阅这里，
// 它们走公开 GET /api/client/manifest——口令绝不进安装包。
// nginx 侧无需改配置：X-Accel-Buffering: no 响应头即关闭响应缓冲。
//
// 部署拓扑：控制面 = 源 + 自订阅方（MANIFEST_EVENT_TOKEN 与
// UPDATE_MANIFEST_SOURCE_URL=http://127.0.0.1:<port> + UPDATE_MANIFEST_EVENT_TOKEN
// 同机配置，订阅侧见 services/client-update-pusher.ts）。

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readClientManifest } from "./client-manifest.js";

const CONFIG_DIR = join(process.cwd(), "config");
/** 订阅端传口令的头（与 services/client-update-pusher.ts 同一常量）。 */
export const MANIFEST_EVENT_TOKEN_HEADER = "x-manifest-event-token";
const MANIFEST_FILE_RE = /^client-manifest(?:\.([a-z0-9-]+))?\.json$/;
/** 订阅建立时全量推送的清单集合：主清单（edition=null）+ 已知分发版 */
const KNOWN_EDITIONS: (string | null)[] = [null, "cloud", "oss"];
const DEBOUNCE_MS = 300;
const PING_INTERVAL_MS = 30_000;

type StreamState = { timer: ReturnType<typeof setTimeout> | null };

/**
 * 订阅口令核对：未配置 MANIFEST_EVENT_TOKEN 即端点禁用（非控制面机器/未部署该机制时
 * 对外不可见）；口令只认请求头，query 里的 token 一律忽略。
 */
export function manifestEventAuthorized(
  headers: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = env.MANIFEST_EVENT_TOKEN?.trim();
  if (!expected) return false;
  const rawHeader = headers[MANIFEST_EVENT_TOKEN_HEADER];
  const headerToken = typeof rawHeader === "string" ? rawHeader.trim() : "";
  return headerToken === expected;
}

export function registerInternalManifestEventRoutes(app: FastifyInstance): void {
  app.get("/api/internal/manifest-events", async (request, reply) => {
    if (!manifestEventAuthorized(request.headers)) {
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
