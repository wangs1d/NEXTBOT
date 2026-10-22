import type { BrainCenter } from "../../brain/index.js";
import type { AgentStreamOptions } from "../../external-model/types.js";
import type { LlmExecutionMode } from "../task-router.js";

export type ToolPolicyResolverDeps = {
  getBrainCenter: () => BrainCenter | null;
};

export class ToolPolicyResolver {
  constructor(private readonly deps: ToolPolicyResolverDeps) {}

  resolveExposureProfile(mode: LlmExecutionMode): AgentStreamOptions["toolExposureProfile"] {
    return mode === "task" ? "delegate" : "contextual";
  }

  resolveRankingHint(actorId: string): AgentStreamOptions["toolRankingHint"] {
    // 2026-10-22：EvolutionLoopService（evolution_profile 工具排序画像）已删除——
    // 主 chat 车道被 stabilizeToolOrderForSession 会话冻结中和，数据全是测试灌水。
    // 排序提示只剩 cautiousNamespaces（高危工具降权，源自记忆皮层 belief 快照）。
    const cautiousNamespaces = this.resolveCautiousNamespaces(actorId);
    if (cautiousNamespaces.length === 0) return undefined;
    return { cautiousNamespaces };
  }

  private resolveCautiousNamespaces(actorId: string): string[] {
    const snapshot = this.deps.getBrainCenter()?.getLearningSnapshot(actorId);
    if (!snapshot) return [];

    const namespaces = new Set<string>();
    for (const belief of snapshot.beliefs) {
      if (belief.status === "deprecated") continue;
      if (belief.failureCount <= belief.successCount) continue;
      if (!/tool|using|risky|failed|failure/i.test(belief.claim)) continue;

      const match = belief.claim.match(/\busing\s+(.+?)\s+is\s+risky\b/i);
      const rawTools = match?.[1] ?? "";
      for (const toolName of rawTools.split(",")) {
        const namespace = this.pickNamespace(toolName.trim());
        if (namespace) namespaces.add(namespace);
      }
      if (namespaces.size >= 4) break;
    }
    return [...namespaces];
  }

  private pickNamespace(toolName: string): string | null {
    if (!toolName) return null;
    const dotIndex = toolName.indexOf(".");
    if (dotIndex > 0) return toolName.slice(0, dotIndex);
    const underscoreIndex = toolName.indexOf("_");
    if (underscoreIndex > 0) return toolName.slice(0, underscoreIndex);
    return toolName === "unknown" ? null : "misc";
  }
}
