import {
  allowWorldHttpMutations,
  UnifiedClientEventType,
  unifiedGovernanceProbeSchema,
  unifiedHumanDirectiveSchema,
  unifiedMemoryGetSchema,
  unifiedMemoryPatchSchema,
  unifiedQuotaAdjustSchema,
} from "@nextbot/agent-world";
import { UnifiedErrorCode } from "../protocol-unified-errors.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "../services/audit-service.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export const PROTOCOL_UNIFIED_TOOL_NAMES = [
  "protocol.unified.quota_adjust",
  "protocol.unified.memory_patch",
  "protocol.unified.memory_get",
  "protocol.unified.human_directive",
  "protocol.unified.governance_probe",
] as const;

/**
 * 与 WebSocket `protocol.unified.*` 对齐的进程内工具，供外部模型 function calling 使用。
 * 记忆/配额等 actor 以 {@link resolveActorId}（`userId` 优先）为准，忽略入参中的跨主体伪造。
 */
export function registerProtocolUnifiedTools(
  registry: ToolRegistry,
  deps: {
    computeQuotaService: ComputeQuotaService;
    agentMemorySyncService: AgentMemorySyncService;
    auditService: AuditService;
    unifiedIdempotencyService: UnifiedIdempotencyService;
  },
): void {
  const { computeQuotaService, agentMemorySyncService, auditService, unifiedIdempotencyService } = deps;

  registry.register("protocol.unified.quota_adjust", async (input, context) => {
    const actorId = resolveActorId(context);
    const parsed = unifiedQuotaAdjustSchema.safeParse({
      ...input,
      sessionId: actorId,
      userId: context.userId,
    });
    if (!parsed.success) throw new Error(`${UnifiedErrorCode.ValidationError}: ${parsed.error.message}`);
    const cached = unifiedIdempotencyService.get(actorId, "protocol.unified.quota_adjust", parsed.data.requestId);
    if (cached) return { ...cached, deduped: true };
    const adj = computeQuotaService.adjust(actorId, parsed.data.op, parsed.data.units);
    const st = computeQuotaService.getState(actorId);
    const result = !adj.ok
      ? { ok: false, code: UnifiedErrorCode.BadRequest, reason: adj.reason, ...st }
      : { ok: true, op: parsed.data.op, units: parsed.data.units, ...st };
    unifiedIdempotencyService.set(actorId, "protocol.unified.quota_adjust", parsed.data.requestId, result);
    return result;
  });

  registry.register("protocol.unified.memory_patch", async (input, context) => {
    const actorId = resolveActorId(context);
    const parsed = unifiedMemoryPatchSchema.safeParse({
      ...input,
      sessionId: actorId,
      userId: context.userId,
    });
    if (!parsed.success) throw new Error(`${UnifiedErrorCode.ValidationError}: ${parsed.error.message}`);
    const cached = unifiedIdempotencyService.get(actorId, "protocol.unified.memory_patch", parsed.data.requestId);
    if (cached) return { ...cached, deduped: true };
    const patchResult = await agentMemorySyncService.applyPatch(
      actorId,
      parsed.data.basisRevision,
      parsed.data.patches,
    );
    if (!patchResult.ok) {
      const failed = {
        ok: false,
        code: UnifiedErrorCode.BadRequest,
        reason: patchResult.reason,
        currentRevision: patchResult.currentRevision,
      };
      unifiedIdempotencyService.set(actorId, "protocol.unified.memory_patch", parsed.data.requestId, failed);
      return failed;
    }
    const snap = agentMemorySyncService.getSnapshot(actorId);
    const result = { ok: true, revision: patchResult.revision, entries: snap.entries };
    unifiedIdempotencyService.set(actorId, "protocol.unified.memory_patch", parsed.data.requestId, result);
    return result;
  });

  registry.register("protocol.unified.memory_get", async (input, context) => {
    const actorId = resolveActorId(context);
    const parsed = unifiedMemoryGetSchema.safeParse({
      ...input,
      sessionId: actorId,
      userId: context.userId,
    });
    if (!parsed.success) throw new Error(`${UnifiedErrorCode.ValidationError}: ${parsed.error.message}`);
    const snap = agentMemorySyncService.getSnapshot(actorId, parsed.data.keys);
    return { ok: true, revision: snap.revision, entries: snap.entries };
  });

  registry.register("protocol.unified.human_directive", async (input, context) => {
    const actorId = resolveActorId(context);
    const parsed = unifiedHumanDirectiveSchema.safeParse({
      ...input,
      sessionId: actorId,
      userId: context.userId,
    });
    if (!parsed.success) throw new Error(`${UnifiedErrorCode.ValidationError}: ${parsed.error.message}`);
    const cached = unifiedIdempotencyService.get(actorId, "protocol.unified.human_directive", parsed.data.requestId);
    if (cached) return { ...cached, deduped: true };
    if (parsed.data.scope === "partition" && !parsed.data.partitionId?.trim()) {
      throw new Error(`${UnifiedErrorCode.ValidationError}: scope=partition 时必须提供 partitionId`);
    }
    const receivedAt = new Date().toISOString();
    await auditService.record({
      type: UnifiedClientEventType.HumanDirective,
      source: "tool",
      sessionId: actorId,
      scope: parsed.data.scope,
      partitionId: parsed.data.partitionId,
      priority: parsed.data.priority ?? "normal",
      text: parsed.data.text,
      traceId: parsed.data.traceId,
      chatUserMessageId: context.chatUserMessageId,
    });
    const result = {
      ok: true,
      receivedAt,
      scope: parsed.data.scope,
      partitionId: parsed.data.partitionId,
    };
    unifiedIdempotencyService.set(actorId, "protocol.unified.human_directive", parsed.data.requestId, result);
    return result;
  });

  registry.register("protocol.unified.governance_probe", async (input, context) => {
    const actorId = resolveActorId(context);
    const parsed = unifiedGovernanceProbeSchema.safeParse({
      ...input,
      sessionId: actorId,
      userId: context.userId,
    });
    if (!parsed.success) throw new Error(`${UnifiedErrorCode.ValidationError}: ${parsed.error.message}`);
    const action = parsed.data.action;
    const allowed = action !== "world.http.mutation" || allowWorldHttpMutations();
    return {
      ok: true,
      allowed,
      action,
      rulesApplied: ["world.http.mutation<=ALLOW_WORLD_HTTP_MUTATIONS"],
    };
  });
}
