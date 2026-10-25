/**
 * Gateway 进程入口（remote 拓扑下的可替换外壳适配器）。
 *
 * 职责（刻意保持轻薄，不含任何 Agent/服务装配）：
 *   - 对外监听 GATEWAY_PORT（默认同 PORT/3000）；
 *   - WS 隧道：客户端 ⇄ gateway ⇄ runtime 内部 /ws 一一对应转发，
 *     会话语义（session.init、桥接注册、心跳）全部由 runtime 处理；
 *   - HTTP 反向代理：除本进程健康端点外，全部转发到 runtime 内部 HTTP 端口
 *     （REST 数据接口、/chat 页面、/agent 媒体静态文件等原样可用）；
 *   - 链路健康巡检：runtime 链路断开时对外返回 503，恢复后自动放行。
 *
 * 换外壳 = 实现一个新的 gateway 进程；runtime 后台进程与其内存话、任务、
 * 记忆完全不受影响。
 */
import { loadServerEnv } from "./config/load-server-env.js";
import { setupGlobalHttpAgent } from "./config/http-agent.js";
import { getRuntimeTopologyConfig } from "./config/env.js";
import { writeServerInstance } from "./config/server-instance.js";

setupGlobalHttpAgent();
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { Readable } from "node:stream";
import { WebSocket } from "ws";

const topology = getRuntimeTopologyConfig();
// gateway 入口本身即 remote 形态的意图：仅当显式声明 embedded 时退出（防止双世界）
if (process.env.RUNTIME_MODE?.trim().toLowerCase() === "embedded") {
  console.error("[gateway] RUNTIME_MODE=embedded 下无需 gateway；单进程形态请运行 index.ts（npm run start:server）");
  process.exit(2);
}

const runtimeHttpOrigin = `http://127.0.0.1:${topology.runtimeHttpPort}`;
const runtimeWsOrigin = `ws://127.0.0.1:${topology.runtimeHttpPort}/ws`;

const app = Fastify({
  logger: false,
  bodyLimit: 128 * 1024 * 1024,
  requestTimeout: 0,
});
await app.register(websocket);

// 任意 Content-Type 按原始字节缓冲后转发（不解析、不改写）
app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
  done(null, body);
});

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function forwardableHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 隧道中的活跃连接计数（健康端点观测用）。 */
let activeTunnels = 0;

app.get("/__gateway/health", async () => {
  let runtimeAlive = false;
  try {
    const probe = await fetch(`${runtimeHttpOrigin}/`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    runtimeAlive = !!probe || (await isRuntimeWsAlive());
  } catch {
    runtimeAlive = await isRuntimeWsAlive();
  }
  return {
    ok: true,
    gateway: { port: topology.gatewayPort, activeTunnels },
    runtime: { httpOrigin: runtimeHttpOrigin, alive: runtimeAlive },
    timestamp: new Date().toISOString(),
  };
});

async function isRuntimeWsAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new WebSocket(runtimeWsOrigin);
    const finish = (ok: boolean) => {
      probe.removeAllListeners();
      try {
        probe.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    probe.once("open", () => finish(true));
    probe.once("error", () => finish(false));
    setTimeout(() => finish(false), 2000);
  });
}

// HTTP 反向代理（catch-all，含已注册过的具体路径——register 顺序在 websocket 之后）
app.route({
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  url: "/*",
  handler: async (request, reply) => {
    const target = `${runtimeHttpOrigin}${request.url}`;
    let upstream: Response;
    try {
      const rawBody = request.body as Buffer | undefined;
      const body = rawBody
        ? (new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength) as BodyInit)
        : undefined;
      upstream = await fetch(target, {
        method: request.method,
        headers: forwardableHeaders(request.headers),
        body,
        redirect: "manual",
        signal: request.raw.aborted ? AbortSignal.abort() : undefined,
      });
    } catch {
      reply.code(503).send({ ok: false, error: "runtime 进程不可达（检查 runtime-main 是否已启动）" });
      return;
    }
    reply.code(upstream.status);
    for (const [key, value] of upstream.headers) {
      const lower = key.toLowerCase();
      // fetch 自动解压 gzip/br，重发 content-length 会导致字节数失配；统一由 reply 重算
      if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") continue;
      reply.header(key, value);
    }
    if (request.method === "HEAD" || upstream.status === 204 || upstream.status === 304 || !upstream.body) {
      reply.send();
      return;
    }
    // 流式转发：媒体/语音等大响应不在 gateway 进程缓冲，直接 pipe
    reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
  },
});

// WS 隧道：每个客户端连接 ↔ runtime /ws 一一对应
app.get("/ws", { websocket: true }, (socket, request) => {
  activeTunnels += 1;
  // 上游未就绪时先缓存客户端帧（session.init 等首帧不丢）
  const earlyFrames: Buffer[] = [];
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    activeTunnels -= 1;
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };

  // 保留客户端 query（部分客户端以 query 传 token/标记）
  const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
  const upstreamSocket = new WebSocket(runtimeWsOrigin + query);
  const upstream = upstreamSocket;

  upstreamSocket.on("open", () => {
    for (const frame of earlyFrames) upstreamSocket.send(frame);
    earlyFrames.length = 0;
  });

  socket.on("message", (data: Buffer) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(data);
    else if (earlyFrames.length < 64) earlyFrames.push(data);
  });

  socket.on("close", teardown);
  socket.on("error", teardown);
  upstreamSocket.on("close", () => {
    // runtime 断开/重启：结束本客户端连接，由客户端既有重连逻辑恢复
    teardown();
  });
  upstreamSocket.on("error", teardown);

  upstreamSocket.on("message", (data: Buffer) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  });
});

const shutdown = (): void => {
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// 与 runtime-main 同策略：未处理 rejection 只记录不退出——gateway 是对外入口，
// 单次旁路异常不应击穿整个边缘进程（uncaughtException 仍按 Node 默认崩溃）。
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown");
  console.error("[gateway][WARN] unhandledRejection:", msg);
});

await app.listen({ port: topology.gatewayPort, host: "0.0.0.0" });
// 身份档案：端口被谁、用哪个数据根占着（启动器与 watchdog 据此做异数据根互斥）
writeServerInstance(topology.gatewayPort, "gateway");
console.log(
  `[gateway] ws/http -> http://127.0.0.1:${topology.gatewayPort} (tunnel → ${runtimeHttpOrigin}) | health: /__gateway/health`,
);
