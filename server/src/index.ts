import { loadServerEnv } from "./config/load-server-env.js";
import { setupGlobalHttpAgent } from "./config/http-agent.js";
import { exitIfDevPortInUse, isDevListenConflict } from "./utils/port-in-use.js";
import { getRuntimeConfig, getRuntimeTopologyConfig, getServerEdition, getHttpsRuntimeConfig } from "./config/env.js";
import { startDevHttpsListener } from "./utils/dev-https.js";

// remote 拓扑下本入口（embedded 单进程形态）不再使用：改用 runtime-main + gateway-main，
// 否则会出现双世界装配与 sidecar 端口冲突。
if (getRuntimeTopologyConfig().mode === "remote") {
  console.error(
    "[server] RUNTIME_MODE=remote 下请运行 runtime 进程与 gateway：npm run start:runtime / start:gateway（开发态 npm run dev:remote）",
  );
  process.exit(2);
}

// ─── 全局 HTTP Agent 配置：必须在第一次 fetch 之前执行 ───
// 配置 undici 连接池 / keepAlive / strictContentLength=false，
// 从根源上减少 undici Parser 在 socket 异常关闭时抛出 AssertionError 的频率。
setupGlobalHttpAgent();
import {
  createExternalChatProviderFromEnv,
  resolvePrimaryExternalModelBinding,
} from "./external-model/index.js";
import { createAppServices } from "./bootstrap/create-app-services.js";
import { initializeRuntimeState } from "./bootstrap/initialize-runtime-state.js";
import { startDesktopBridgeAutoClient } from "./services/desktop-bridge-auto-starter.js";
import { startFunasrServer } from "./services/funasr-auto-starter.js";
import { startOpenClawModelSyncWatcher } from "./services/openclaw-config-sync.js";
import {
  isWechatClawBridgeEnabled,
  readWechatClawBridgeConfig,
} from "./services/wechat-claw-bridge-service.js";
import { isWechatClawFeatureEnabled } from "./services/openclaw-gateway-client.js";
import { isTcpPortInUse } from "./utils/port-in-use.js";
import { startAdaptiveConcurrency } from "./services/concurrency-limiter.js";

// server/.env + server/.env.local 已在 load-server-env.ts 模块加载时自动执行

// ─── 提前声明 shutdown（避免 uncaughtException 触发时遇到 const 暂时性死区） ───
let shutdown: (() => void) | null = null;

// ─── 全局异常处理：防止未捕获异常导致进程意外崩溃 ───

// 判定是否为 undici HTTP parser 在 socket 异常关闭时抛出的良性断言错误。
// 这类错误源自 node:internal/deps/undici 的 Parser.finish / onHttpSocketEnd，
// 属于网络层偶发问题（对端在响应未完成时 RST 或 FIN），与业务逻辑无关，
// 且从 socket 事件回调同步抛出、无法被业务 try/catch 捕获。
// 若让这类错误触发 shutdown，会因一次外部网络抖动拖垮整个后端。
function isBenignUndiciParserError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stack = err.stack ?? "";
  if (!stack.includes("node:internal/deps/undici")) return false;
  // 典型特征：AssertionError [ERR_ASSERTION]: false == true
  // 或 stack 中出现 Parser.finish / onHttpSocketEnd
  return (
    err.name === "AssertionError" ||
    stack.includes("Parser.finish") ||
    stack.includes("onHttpSocketEnd")
  );
}

process.on("uncaughtException", (err: Error) => {
  // undici parser 的良性断言错误：仅记录警告，不退出进程，不触发 shutdown
  if (isBenignUndiciParserError(err)) {
    console.warn(
      "[WARN] swallowed benign undici parser error (socket closed mid-response):",
      err.message,
    );
    return;
  }
  console.error("[FATAL] uncaughtException:", err.message || err);
  console.error(err.stack || "(no stack)");
  // 记录错误后优雅退出，让外部进程管理器（如 node --watch / pm2）决定是否重启
  shutdown?.();
  setTimeout(() => process.exit(1), 2000).unref();
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown");
  const stack = reason instanceof Error ? reason.stack ?? "" : "";
  console.error("[WARN] unhandledRejection:", msg);
  // 不退出进程，仅记录警告；如果是严重错误会触发后续的 uncaughtException
});

await exitIfDevPortInUse(getRuntimeConfig().port);

const runtime = getRuntimeConfig();
const externalChatProbe = createExternalChatProviderFromEnv();
if (externalChatProbe?.isEnabled()) {
  // 日志里的模型名按 provider 自己的键位取（此前只认 MOONSHOT/OPENAI/MINIMAX，
  // 配 deepseek 时会打出别家的模型名，看着像 provider 没生效）。
  const probeModel =
    resolvePrimaryExternalModelBinding()?.model ??
    process.env.MOONSHOT_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.MINIMAX_MODEL ??
    "default";
  console.log(
    `[external-model] 已启用 ${externalChatProbe.displayLabel}（${probeModel}）`,
  );
} else {
  console.warn(
    "[external-model] 未启用：请在 server/.env 配置 MOONSHOT_API_KEY / MINIMAX_API_KEY / DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重启服务",
  );
}
// ─── FunASR 自启动：必须在 createAppServices 之前，让 FunAsrAdapter.isEnabled() 返回 true ───
// 子进程 spawn 是异步的，但 BASE_URL 同步写入 env；adapter 实例化时就能看到。
// 首次下模型期间 ASR 请求会 connection refused（adapter 内部 catch 返回空文本）。
const stopFunasrEarly = startFunasrServer({
  log: (line) => console.log(line),
});
const services = await createAppServices();
await initializeRuntimeState(services);
try {
  await services.app.listen({
    port: runtime.port,
    host: "0.0.0.0",
  });
} catch (err) {
  if (isDevListenConflict(err)) process.exit(0);
  throw err;
}

// ─── HTTPS 双监听：浏览器访问 https://<本机IP>:3443/chat 时地址栏不再显示"不安全" ───
// 与 HTTP 同实例同路由（含 wss）；HTTP 端口行为零变化，Flutter/WS 客户端不受影响。
// 失败（无 openssl / 端口占用 / 自动信任被拒）只降级提示，不阻塞启动。
let devHttpsHandle: Awaited<ReturnType<typeof startDevHttpsListener>> = null;
try {
  devHttpsHandle = await startDevHttpsListener(services.app, getHttpsRuntimeConfig(), (line) =>
    services.app.log.info(line),
  );
} catch (err) {
  services.app.log.warn(`[https] HTTPS 监听启动失败，回退纯 HTTP：${err instanceof Error ? err.message : String(err)}`);
}

// ─── Webhook: Agent 上线事件（通过 HookBus 自动外推） ───
services.hookBus.emit("agent.online", {
  port: runtime.port,
  version: "1.0",
  uptime: new Date().toISOString(),
});

// 发行版本横幅（打包冒烟会断言本行，用于证明 .env 的 NEXTBOT_EDITION 真实生效）
services.app.log.info(
  `[edition] NEXTBOT_EDITION=${getServerEdition()} —— ${
    getServerEdition() === "oss"
      ? "开源版：内测独占能力（旅游/虚拟电话/好友/比价/社交外联/手机桥接）已剔除"
      : "内测版：能力全量"
  }`,
);

// Phase 2：启动自适应并发控制（AIMD 动态调整全局 turn 并发上限）
startAdaptiveConcurrency();

const stopDesktopBridge = startDesktopBridgeAutoClient({
  port: runtime.port,
  log: (line) => services.app.log.info(line),
});
const stopOpenClawModelSync = isWechatClawBridgeEnabled(process.env)
  ? (() => {
      const bridge = readWechatClawBridgeConfig(process.env);
      console.log(
        `[wechat-claw] 消息桥已启用 → POST http://127.0.0.1:${bridge.serverPort}/integrations/wechat-claw/bridge/chat（OpenClaw 插件 before_dispatch）`,
      );
      if (isWechatClawFeatureEnabled(process.env)) {
        const gwPort = Number(
          process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789",
        );
        void isTcpPortInUse(gwPort, "127.0.0.1").then((inUse) => {
          if (!inUse) {
            console.warn(
              `[wechat-claw] Gateway 未在 127.0.0.1:${gwPort} 监听，微信将无法回复。请重启 dev:all 或单独运行: openclaw gateway`,
            );
          }
        });
      }
      return () => {};
    })()
  : startOpenClawModelSyncWatcher(process.env);

const performShutdown = (): void => {
  // ─── Webhook: Agent 下线事件（通过 HookBus 自动外推） ───
  services.hookBus.emit("agent.offline", {
    port: runtime.port,
    reason: "graceful_shutdown",
    timestamp: new Date().toISOString(),
  });
  // 统一记忆写入者：关停前尽力补一次候选整合（队列已持久化，失败也不丢数据）
  void import("./services/memory-consolidation-service.js").then(
    ({ getMemoryConsolidationService }) => {
      getMemoryConsolidationService()?.flushAll().catch(() => {});
    },
  );
  services.webhookService.stop();
  stopDesktopBridge();
  stopFunasrEarly();
  stopOpenClawModelSync();
  void devHttpsHandle?.close();
  void services.app.close().finally(() => process.exit(0));
};
shutdown = performShutdown;
process.once("SIGINT", performShutdown);
process.once("SIGTERM", performShutdown);
const worldStandalone = process.env.AGENT_WORLD_STANDALONE_URL?.trim() || "http://127.0.0.1:3333";
console.log(
  `[dev] server http://127.0.0.1:${runtime.port} | Agent World ${worldStandalone}`,
);
