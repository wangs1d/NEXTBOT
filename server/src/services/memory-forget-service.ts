import { getMemoryLifecycleService } from "../agentic-memory/memory-lifecycle-controller.js";
import { getAgenticMemoryRuntime } from "../agentic-memory/index.js";

export interface MemoryForgetResult {
  target: string;
  facts: number;
  understandings: number;
  memories: number;
  graphNodes: number;
  opId: string;
  skipped: string[];
}

/** 关键词遗忘的统一级联出口；对话工具与 HTTP 管理共用。 */
export async function forgetMemoryTarget(actorId: string, target: string): Promise<MemoryForgetResult> {
  const keyword = target.trim().toLowerCase();
  const result: MemoryForgetResult = {
    target,
    facts: 0,
    understandings: 0,
    memories: 0,
    graphNodes: 0,
    opId: "",
    skipped: [],
  };
  if (!actorId.trim() || keyword.length < 2) return result;

  const lifecycle = await getMemoryLifecycleService().execute({
    actorId,
    intent: "forget",
    target: { kind: "keyword", key: keyword },
    reason: "user_forget",
  });
  result.opId = lifecycle.opId;
  result.facts = Number((lifecycle.actions["forget:facts"] as { facts?: number } | undefined)?.facts ?? 0);
  result.understandings = Number((lifecycle.actions["forget:understandings"] as { understandings?: number } | undefined)?.understandings ?? 0);
  result.memories = Number((lifecycle.actions["forget:vector"] as { memories?: number } | undefined)?.memories ?? 0);
  result.graphNodes = Number((lifecycle.actions["forget:graph"] as { graphNodes?: number } | undefined)?.graphNodes ?? 0);
  if (!getAgenticMemoryRuntime()?.memory) result.skipped.push("memory(Mem0 未启用，向量记忆未清除)");
  return result;
}
