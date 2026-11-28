import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { actorIdVariants } from "./actor-key.js";
import { getMemoryComponents, getAgenticMemoryRuntime } from "./index.js";
import { retireMemoriesForFactChange } from "./fact-supersede.js";
import { getMemorySuppressionStore } from "./memory-suppression.js";
import { getMemoryReinforcementStore } from "./memory-reinforcement.js";
import {
  getMemoryLifecycleOpStore,
  type MemoryLifecycleOpStore,
} from "./memory-lifecycle-ops.js";
import type { MemoryRecord } from "./memory-record.js";
import { getHumanLikeMemoryService } from "../services/human-like-memory-service.js";
import { getGlobalMemoryInventory } from "../brain/memory-inventory.js";

export type MemoryLifecycleIntent = "upsert" | "supersede" | "suppress" | "forget";

export type MemoryLifecycleTarget =
  | { kind: "record"; record: MemoryRecord; text: string; source: string; options?: Record<string, unknown> }
  | { kind: "fact_field"; field: string; newValue: string; previousValues: string[] }
  | { kind: "field"; key: string }
  | { kind: "text"; key: string }
  | { kind: "keyword"; key: string }
  | { kind: "memory_ids"; ids: string[] }
  | { kind: "source_ref"; sourceRef: string };

export interface MemoryLifecycleRequest {
  opId?: string;
  actorId: string;
  intent: MemoryLifecycleIntent;
  target: MemoryLifecycleTarget;
  reason?: string;
  sourceRef?: string;
}

export interface MemoryLifecycleAction {
  id: string;
  store: "narrative" | "vector" | "facts" | "understandings" | "graph" | "suppression" | "provenance" | "bridge" | "inventory";
  operation: "upsert" | "supersede" | "suppress" | "forget" | "invalidate";
  payload: Record<string, unknown>;
}

export interface MemoryLifecyclePlan {
  opId: string;
  actorId: string;
  intent: MemoryLifecycleIntent;
  actions: MemoryLifecycleAction[];
}

export type MemoryLifecycleExecutor = (
  action: MemoryLifecycleAction,
  plan: MemoryLifecyclePlan,
) => Promise<unknown>;

export interface MemoryLifecycleResult {
  opId: string;
  intent: MemoryLifecycleIntent;
  actorId: string;
  status: "completed";
  actions: Record<string, unknown>;
}

function actionId(store: string, operation: string): string {
  return `${operation}:${store}`;
}

export function planMemoryLifecycle(input: MemoryLifecycleRequest): MemoryLifecyclePlan {
  const opId = input.opId?.trim() || randomUUID();
  const base = { opId, actorId: input.actorId, intent: input.intent };
  const target = input.target;

  if (input.intent === "upsert" && target.kind === "record") {
    return {
      ...base,
      actions: [{
        id: actionId("narrative", "upsert"),
        store: "narrative",
        operation: "upsert",
        payload: { record: target.record, text: target.text, source: target.source, options: target.options },
      }],
    };
  }

  if (input.intent === "supersede" && target.kind === "fact_field") {
    return {
      ...base,
      actions: [{
        id: actionId("vector", "supersede"),
        store: "vector",
        operation: "supersede",
        payload: {
          field: target.field,
          newValue: target.newValue,
          previousValues: target.previousValues,
        },
      }],
    };
  }

  if (input.intent === "suppress" && (target.kind === "field" || target.kind === "text")) {
    return {
      ...base,
      actions: [{
        id: actionId("suppression", "suppress"),
        store: "suppression",
        operation: "suppress",
        payload: { kind: target.kind, key: target.key, reason: input.reason },
      }],
    };
  }

  if (input.intent === "forget") {
    if (target.kind === "memory_ids") {
      return {
        ...base,
        actions: [{
          id: actionId("vector", "forget"),
          store: "vector",
          operation: "forget",
          payload: { ids: target.ids },
        }],
      };
    }
    if (target.kind === "source_ref") {
      return {
        ...base,
        actions: [{
          id: actionId("provenance", "invalidate"),
          store: "provenance",
          operation: "invalidate",
          payload: { sourceRef: target.sourceRef, reason: input.reason ?? "source_invalidated" },
        }],
      };
    }
    if (target.kind === "field") {
      return {
        ...base,
        actions: [{
          id: actionId("facts", "forget"),
          store: "facts",
          operation: "forget",
          payload: { field: target.key },
        }],
      };
    }
    if (target.kind === "keyword") {
      const payload = { keyword: target.key.trim().toLowerCase() };
      return {
        ...base,
        actions: [
          { id: actionId("facts", "forget"), store: "facts", operation: "forget", payload },
          { id: actionId("understandings", "forget"), store: "understandings", operation: "forget", payload },
          { id: actionId("graph", "forget"), store: "graph", operation: "forget", payload },
          { id: actionId("vector", "forget"), store: "vector", operation: "forget", payload },
          { id: actionId("bridge", "forget"), store: "bridge", operation: "forget", payload },
          { id: actionId("suppression", "forget"), store: "suppression", operation: "forget", payload: { ...payload, keyword: target.key.trim() } },
          { id: actionId("inventory", "invalidate"), store: "inventory", operation: "invalidate", payload: {} },
        ],
      };
    }
  }

  throw new Error(`unsupported memory lifecycle request: ${input.intent}/${target.kind}`);
}

async function deleteVectorMemories(ids: string[]): Promise<{ memories: number }> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { memories: 0 };
  const runtime = getAgenticMemoryRuntime();
  if (!runtime?.memory) return { memories: 0 };
  const deleted = runtime.lifecycle
    ? await runtime.lifecycle.deleteByIds(unique)
    : await (async () => {
        const confirmed: string[] = [];
        for (const id of unique) {
          await runtime.memory.delete(id);
          confirmed.push(id);
        }
        return confirmed;
      })();
  getMemoryComponents().fts?.remove(deleted);
  return { memories: deleted.length };
}

export async function executeMemoryLifecycleAction(
  action: MemoryLifecycleAction,
  plan: MemoryLifecyclePlan,
): Promise<unknown> {
  const components = getMemoryComponents();
  const payload = action.payload;

  if (action.store === "suppression" && action.operation === "suppress") {
    return getMemorySuppressionStore()?.add(
      plan.actorId,
      payload.kind as "field" | "text",
      String(payload.key),
      typeof payload.reason === "string" ? payload.reason : undefined,
    ) ?? null;
  }

  if (action.store === "vector" && action.operation === "supersede") {
    return retireMemoriesForFactChange({
      memory: getAgenticMemoryRuntime()?.memory ?? null,
      reinforcement: getMemoryReinforcementStore() ?? null,
      actorId: plan.actorId,
      field: String(payload.field),
      newValue: String(payload.newValue),
      previousValues: Array.isArray(payload.previousValues) ? payload.previousValues.map(String) : [],
    });
  }

  if (action.store === "facts" && action.operation === "forget") {
    if (typeof payload.field === "string") {
      return { facts: components.factStore?.clearFact(plan.actorId, payload.field) ?? 0 };
    }
    return { facts: components.factStore?.clearMatching(plan.actorId, String(payload.keyword)) ?? 0 };
  }

  if (action.store === "understandings" && action.operation === "forget") {
    return {
      understandings: components.understandingStore?.clearMatching(plan.actorId, String(payload.keyword)) ?? 0,
    };
  }

  if (action.store === "graph" && action.operation === "forget") {
    const keyword = String(payload.keyword);
    return { graphNodes: getHumanLikeMemoryService()?.forgetMatching(plan.actorId, keyword) ?? 0 };
  }

  if (action.store === "vector" && action.operation === "forget") {
    if (Array.isArray(payload.ids)) return deleteVectorMemories(payload.ids.map(String));
    const keyword = String(payload.keyword);
    const ids = new Set<string>();
    for (const node of getHumanLikeMemoryService()?.getAllNodes(plan.actorId) ?? []) {
      if (!node.summary.toLowerCase().includes(keyword)) continue;
      for (const id of Array.isArray(node.metadata?.mem0Ids) ? node.metadata.mem0Ids : []) {
        if (typeof id === "string") ids.add(id);
      }
    }
    const runtime = getAgenticMemoryRuntime();
    if (runtime?.memory) {
      for (const variant of actorIdVariants(plan.actorId)) {
        const all = (await runtime.memory.getAll({
          topK: 10000,
          filters: { user_id: variant },
        })) as { results?: Array<{ id: string; memory?: string; metadata?: { actorId?: string } }> };
        for (const item of all.results ?? []) {
          if ((item.metadata?.actorId ?? plan.actorId) !== plan.actorId) continue;
          if (String(item.memory ?? "").toLowerCase().includes(keyword)) ids.add(item.id);
        }
      }
    }
    return deleteVectorMemories([...ids]);
  }

  if (action.store === "bridge" && action.operation === "forget") {
    await components.bridge?.syncForgetting(plan.actorId);
    return { synced: true };
  }

  if (action.store === "suppression" && action.operation === "forget") {
    getMemorySuppressionStore()?.rememberForgotten(plan.actorId, String(payload.keyword));
    return { remembered: true };
  }

  if (action.store === "inventory" && action.operation === "invalidate") {
    getGlobalMemoryInventory()?.invalidate(plan.actorId);
    return { invalidated: true };
  }

  if (action.store === "provenance" && action.operation === "invalidate") {
    return (await components.provenance?.invalidateSource(
      String(payload.sourceRef),
      String(payload.reason ?? "source_invalidated"),
    )) ?? null;
  }

  throw new Error(`no executor for ${action.operation}/${action.store}`);
}

const actionExecutors = new Map<string, MemoryLifecycleExecutor>();

export function registerMemoryLifecycleExecutor(
  actionId: string,
  executor: MemoryLifecycleExecutor,
): void {
  actionExecutors.set(actionId, executor);
}

async function executeRegisteredAction(
  action: MemoryLifecycleAction,
  plan: MemoryLifecyclePlan,
): Promise<unknown> {
  const executor = actionExecutors.get(action.id);
  return executor ? executor(action, plan) : executeMemoryLifecycleAction(action, plan);
}

export class MemoryLifecycleService {
  private readonly opTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: MemoryLifecycleOpStore = getMemoryLifecycleOpStore(),
    private readonly executor: MemoryLifecycleExecutor = executeRegisteredAction,
  ) {}

  async execute(
    input: MemoryLifecycleRequest,
    executor?: MemoryLifecycleExecutor,
  ): Promise<MemoryLifecycleResult> {
    const plan = planMemoryLifecycle(input);
    return this.serialize(plan.opId, async () => {
      const request = { ...input, opId: plan.opId };
      const existing = this.store.get(plan.opId);
      const persistedRequest = JSON.parse(JSON.stringify(request)) as unknown;
      if (existing && !isDeepStrictEqual(existing.request, persistedRequest)) {
        throw new Error(`记忆生命周期 opId 已用于不同请求: ${plan.opId}`);
      }
      this.store.enqueue({ ...request, request });
      return this.run(plan, executor);
    });
  }

  async replay(opId: string, executor?: MemoryLifecycleExecutor): Promise<MemoryLifecycleResult> {
    const op = this.store.get(opId);
    if (!op) throw new Error(`memory lifecycle operation not found: ${opId}`);
    return this.serialize(opId, () => this.run(planMemoryLifecycle(op.request as MemoryLifecycleRequest), executor));
  }

  private serialize<T>(opId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.opTails.get(opId) ?? Promise.resolve();
    const next = previous.then(task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.opTails.set(opId, tail);
    void tail.then(() => {
      if (this.opTails.get(opId) === tail) this.opTails.delete(opId);
    });
    return next;
  }

  private async run(
    plan: MemoryLifecyclePlan,
    executor: MemoryLifecycleExecutor = this.executor,
  ): Promise<MemoryLifecycleResult> {
    const completed = this.store.completedActionIds(plan.opId);
    const results: Record<string, unknown> = this.store.actionResults(plan.opId);
    const runExecutor = executor ?? this.executor;
    this.store.markRunning(plan.opId);
    for (const action of plan.actions) {
      if (completed.has(action.id)) continue;
      try {
        results[action.id] = await runExecutor(action, plan);
        this.store.completeAction({ opId: plan.opId, actionId: action.id, result: results[action.id] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.failAction({ opId: plan.opId, actionId: action.id, error: message });
        throw err;
      }
    }
    const result: MemoryLifecycleResult = {
      opId: plan.opId,
      intent: plan.intent,
      actorId: plan.actorId,
      status: "completed",
      actions: results,
    };
    this.store.complete(plan.opId, result);
    return result;
  }
}

let singleton: MemoryLifecycleService | null = null;

export function getMemoryLifecycleService(): MemoryLifecycleService {
  singleton ??= new MemoryLifecycleService();
  return singleton;
}

export async function retryPendingMemoryLifecycleOperations(): Promise<number> {
  const service = getMemoryLifecycleService();
  let retried = 0;
  for (const op of getMemoryLifecycleOpStore().retryable()) {
    try {
      await service.replay(op.opId);
      retried += 1;
    } catch (err) {
      console.warn(
        `[memory-lifecycle] 重放失败 op=${op.opId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return retried;
}
