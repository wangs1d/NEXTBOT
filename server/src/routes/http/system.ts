import type { FastifyInstance } from "fastify";
import {
  UNIFIED_LAYER_MANIFEST,
  UNIFIED_PROTOCOL_VERSION,
  UnifiedClientEventType,
  UnifiedServerEventType,
} from "@nextbot/agent-world";
import { PROTOCOL_UNIFIED_TOOL_NAMES } from "../../tools/protocol-unified-tools.js";
import type { HttpRouteDeps } from "./types.js";
import type { BrainCenter } from "../../brain/brain-center.js";

/**
 * 系统级：健康检查（根路径，便于探针与旧文档链接）。
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: Pick<HttpRouteDeps, "upstreamSearchService" | "brainCenter">,
): void {
  app.get("/health", async () => ({ ok: true }));

  /** AWP v0.1：无鉴权元数据，供外部 Agent 发现入口与事件名。 */
  app.get("/.well-known/agent-world", async () => ({
    awp: "0.1",
    websocketPath: "/ws",
    registration: {
      challengePath: "/world/register/challenge",
      verifyPath: "/world/register/verify",
      statusPath: "/world/register/status",
      agentQuickPath: "/world/register/agent_quick",
    },
    worldPartition: {
      attachClientEvent: "world.partition.attach",
      detachClientEvent: "world.partition.detach",
      snapshotServerEvent: "world.partition.snapshot",
      deltaServerEvent: "world.partition.delta",
      presenceServerEvent: "world.presence.update",
    },
    room: {
      createTool: "world.room.create",
      sharedRoomIdPrefix: "wr-",
      queryParams: ["roomId", "expectedRevision（HTTP POST 部分接口）"],
    },
    aip: {
      version: "0.1",
      wsClientEvent: "aip.dispatch",
      tools: ["aip.dispatch", "aip.list_my_state", "aip.get_proposal"],
      statePath: "/agent/aip/state",
      peerMessageType: "agent.peer_message",
    },
    unifiedProtocol: {
      version: UNIFIED_PROTOCOL_VERSION,
      wsClientEvents: Object.values(UnifiedClientEventType),
      wsServerEvents: Object.values(UnifiedServerEventType),
      tools: [...PROTOCOL_UNIFIED_TOOL_NAMES],
      http: {
        quotaPath: "/protocol/unified/quota",
        memoryPath: "/protocol/unified/memory",
      },
      layers: UNIFIED_LAYER_MANIFEST,
    },
  }));
  app.get("/system/upstream-health", async () => {
    const health = await deps.upstreamSearchService.checkUpstreamHealth();
    return { ok: true, ...health };
  });

  /** 并发控制实时指标：全局 turn + 按工具类别的 active/queued/max。 */
  app.get("/system/concurrency", async () => {
    const { getConcurrencyStats } = await import("../../services/concurrency-limiter.js");
    return { ok: true, ...getConcurrencyStats() };
  });

  /** Brain 模块健康状态（仅 brain 启用时有效）。 */
  app.get("/brain/health", async () => {
    const bc = deps.brainCenter;
    if (!bc) return { ok: false, reason: "BrainCenter 未启用" };
    return { ok: true, ...bc.getHealth() };
  });
}
