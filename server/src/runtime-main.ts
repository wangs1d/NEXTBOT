/**
 * Agent Runtime 独立后台进程入口（remote 拓扑）。
 *
 * 与 index.ts（embedded 单进程形态）的差异：
 *   - 完整世界装配 + 状态加载 + 侧车子进程全部保留（runtime 拥有服务图、
 *     工具、技能、记忆、Brain/Body 与全部文件持久化）；
 *   - HTTP/WS 监听内部回环端口（RUNTIME_HTTP_PORT，默认 3211），仅供
 *     gateway 隧道/反代与本机调试访问，不对局域网暴露；
 *   - 额外启动 runtime 链路（RUNTIME_LINK_PORT，默认 3210），把
 *     RuntimeFacade 以 RPC 形式暴露给非隧道型网关/外壳。
 *
 * 换外壳 = 替换/重启 gateway 进程；本进程内会话、记忆、自主任务跨外壳存活。
 */
import { loadServerEnv } from "./config/load-server-env.js";
import { setupGlobalHttpAgent } from "./config/http-agent.js";
import { getRuntimeTopologyConfig } from "./config/env.js";

setupGlobalHttpAgent();
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createExternalChatProviderFromEnv } from "./external-model/index.js";
import { createAppServices } from "./bootstrap/create-app-services.js";
import { initializeRuntimeState } from "./bootstrap/initialize-runtime-state.js";
import { startDesktopBridgeAutoClient } from "./services/desktop-bridge-auto-starter.js";
import { startFunasrServer } from "./services/funasr-auto-starter.js";
import { startOpenClawModelSyncWatcher } from "./services/openclaw-config-sync.js";
import { isWechatClawBridgeEnabled } from "./services/wechat-claw-bridge-service.js";
import { startAdaptiveConcurrency } from "./services/concurrency-limiter.js";
import { createActiveTurnRegistry } from "./runtime/link/link-protocol.js";
import { startRuntimeLinkServer } from "./runtime/link/link-server.js";
import { DirectRuntimeAdapter } from "./runtime/runtime-facade.js";

// 数据目录锚定：持久化默认基于 cwd/data，守护进程无论从哪个目录启动都固定到 server/
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (resolve(process.cwd()) !== serverRoot) process.chdir(serverRoot);

const topology = getRuntimeTopologyConfig();
// 端口语义重定向：runtime 进程内一切「自己端口」的引用（桌面桥自连、日志）
// 都应指向内部 HTTP 端口而非对外 gateway 端口。
process.env.PORT = String(topology.runtimeHttpPort);

let shutdown: (() => void) | null = null;

process.on("uncaughtException", (err: Error) => {
  console.error("[runtime][FATAL] uncaughtException:", err.message || err);
  console.error(err.stack || "(no stack)");
  shutdown?.();
  setTimeout(() => process.exit(1), 2000).unref();
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown");
  console.error("[runtime][WARN] unhandledRejection:", msg);
});

const externalChatProbe = createExternalChatProviderFromEnv();
console.log(
  externalChatProbe?.isEnabled()
    ? `[runtime] external model: ${externalChatProbe.displayLabel}`
    : "[runtime] external model 未启用（.env 配置 API_KEY 后生效）",
);

// FunASR 须在装配前自启动（BASE_URL 同步写入 env）
const stopFunasrEarly = startFunasrServer({ log: (line) => console.log(line) });

const services = await createAppServices();
await initializeRuntimeState(services);

// 内部 HTTP/WS 监听（gateway 隧道与反代的上游）
await services.app.listen({ port: topology.runtimeHttpPort, host: "127.0.0.1" });

// runtime 链路：RuntimeFacade RPC（非隧道型网关/外壳用）
const activeTurns = createActiveTurnRegistry();
const linkServer = await startRuntimeLinkServer({
  port: topology.runtimeLinkPort,
  token: topology.runtimeLinkToken,
  facade: new DirectRuntimeAdapter(services.agentCore),
  activeTurns,
});

services.hookBus.emit("agent.online", {
  port: topology.runtimeHttpPort,
  version: "1.0",
  uptime: new Date().toISOString(),
});

startAdaptiveConcurrency();

const stopDesktopBridge = startDesktopBridgeAutoClient({
  port: topology.runtimeHttpPort,
  log: (line) => console.log(line),
});
const stopOpenClawModelSync = isWechatClawBridgeEnabled(process.env)
  ? () => {}
  : startOpenClawModelSyncWatcher(process.env);

const performShutdown = (): void => {
  services.hookBus.emit("agent.offline", {
    port: topology.runtimeHttpPort,
    reason: "graceful_shutdown",
    timestamp: new Date().toISOString(),
  });
  services.webhookService.stop();
  stopDesktopBridge();
  stopFunasrEarly();
  stopOpenClawModelSync();
  void linkServer.close().finally(() => {
    void services.app.close().finally(() => process.exit(0));
  });
};
shutdown = performShutdown;
process.once("SIGINT", performShutdown);
process.once("SIGTERM", performShutdown);

console.log(
  `[runtime] http://127.0.0.1:${topology.runtimeHttpPort} (internal) | link ws://127.0.0.1:${linkServer.port} | mode=remote`,
);
