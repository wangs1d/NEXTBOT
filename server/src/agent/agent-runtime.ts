import type { WorldService } from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import type { MoodInferenceService } from "../services/mood-inference-service.js";
import { AgentCore } from "../services/agent-core.js";
import type { SkillManager } from "../skills/index.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { NarrativeMemoryPort } from "../services/narrative-memory-port.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import type { LifeSignalHubService } from "../services/life-signal-hub-service.js";

/**
 * Agent「大脑」装配依赖：CLI/网关等多入口共用同一 AIAgent 核心，本仓库为 AgentCore。
 */
export type AgentCoreDependencies = {
  toolRegistry: ToolRegistry;
  externalChat: ExternalChatProvider | null;
  computeQuotaService: ComputeQuotaService | null;
  agentMemorySyncService?: AgentMemorySyncService | null;
  userPersonalizationService?: UserPersonalizationService | null;
  worldService?: WorldService | null;
  skillManager?: SkillManager | null;
  narrativeMemory?: NarrativeMemoryPort | null;
  virtualPhoneService?: VirtualPhoneService | null;
  scheduleTaskService?: ScheduleTaskService | null;
  shortTermMemoryGateway?: ShortTermMemoryGatewayService | null;
  moodInferenceService?: MoodInferenceService | null;
  lifeSignalHubService?: LifeSignalHubService | null;
};

/**
 * 构造平台无关的 Agent 编排核心，供 WebSocket、HTTP 或后续批任务入口复用。
 */
export function createAgentCore(deps: AgentCoreDependencies): AgentCore {
  return new AgentCore(
    deps.toolRegistry,
    deps.externalChat,
    deps.computeQuotaService,
    deps.agentMemorySyncService ?? null,
    deps.userPersonalizationService ?? null,
    deps.worldService ?? null,
    deps.skillManager ?? null,
    deps.narrativeMemory ?? null,
    deps.virtualPhoneService ?? null,
    deps.scheduleTaskService ?? null,
    deps.shortTermMemoryGateway ?? null,
    deps.moodInferenceService ?? null,
    deps.lifeSignalHubService ?? null,
  );
}
