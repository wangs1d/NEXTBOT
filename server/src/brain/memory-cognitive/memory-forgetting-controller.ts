// MemoryForgettingController —— 主动遗忘与再唤醒反弹子模块
//
// 实现 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md 中的
// "MemoryForgettingController 主动遗忘与再唤醒反弹" 子模块。
//
// 核心能力：
//  1. 连续打分（非睡眠期也衰减）：score = freq*0.4 + recency*0.3 + importance*0.2 + feedback*0.1
//  2. 压缩梯度：score < 0.5 时按梯度截断 recall 文本（非 LLM）
//  3. 连接剪枝：score < 0.1 时清除节点所有 edge
//  4. 再唤醒反弹：recall 命中 downranked/cold 节点时，frequencyScore += 0.3 + deletionStage 回退一级
//
// 设计原则：不让 LLM 决定是否遗忘/加强。所有判断均由规则计算。
//
// 接线（2026-08-29 Phase 2 完成）：
//  - continuousScore / pruneConnections：create-app-services 实例化时注册
//    humanLikeMemory，BrainStem 45s 心跳驱动衰减/剪枝；
//  - reawakenAndStrengthen：MemoryCortex 召回路径在命中 downranked/cold 节点后
//    经 triggerReawakenForFadedHits 触发（遗忘反弹）。

import type { MemoryDeletionStage } from "../../services/human-like-memory-service.js";

// ─── 外观接口（结构兼容即可，不依赖具体实现） ─────────────────────────

/** 节点最小化结构（仅含本模块所需字段） */
interface MemoryNodeLike {
  id: string;
  frequencyScore: number;
  recencyScore: number;
  importance: number;
  userFeedbackScore: number;
  accessCount: number;
  deletionStage: MemoryDeletionStage;
  lastAccessedAt: string;
}

/**
 * HumanLikeMemoryService 的最小化外观接口。
 * 真实实现已提供这些方法（Phase 2 已完成），结构兼容即可注入。
 */
export interface HumanLikeMemoryForgettingLike {
  /** 获取指定 actor 的所有节点 */
  getAllNodes(actorId: string): MemoryNodeLike[];
  /** 更新节点 deletionStage */
  updateDeletionStage(actorId: string, nodeId: string, stage: string): void;
  /** 再唤醒节点：frequencyScore += 0.3 + deletionStage 回退一级 */
  reawakenNode(actorId: string, nodeId: string): void;
  /** 清除节点所有 edge（保留节点本体） */
  pruneNodeEdges(actorId: string, nodeId: string): void;
}

/** SynapseBus 的最小化外观接口 */
export interface SynapseBusLike {
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): unknown;
}

// ─── 常量 ─────────────────────────────────────────────────────────

// deletionStage 推进顺序：active → downranked → cold → soft_deleted → hard_deleted
// 再唤醒回退方向相反。
const STAGE_ORDER: readonly MemoryDeletionStage[] = [
  "active",
  "downranked",
  "cold",
  "soft_deleted",
  "hard_deleted",
];

// ─── 控制器 ───────────────────────────────────────────────────────

/**
 * MemoryForgettingController —— 主动遗忘与再唤醒反弹控制器。
 *
 * 由 BrainStem 45s 心跳扫描触发 continuousScore；
 * recall 命中 downranked/cold 节点时触发 reawakenAndStrengthen。
 *
 * 降级行为：
 *  - BRAIN_MEMORY_FORGET_ENABLED=0 时，所有异步方法空操作
 *  - humanLike 未注入时，所有异步方法空操作
 *  - synapse 未注入时，reawakenAndStrengthen 仍执行 reawakenNode，仅跳过事件发射
 */
export class MemoryForgettingController {
  private humanLike: HumanLikeMemoryForgettingLike | null = null;
  private synapse: SynapseBusLike | null = null;

  // ─── 子系统注册 ─────────────────────────────────────────────────

  registerHumanLikeMemory(svc: HumanLikeMemoryForgettingLike): void {
    this.humanLike = svc;
  }

  registerSynapseBus(svc: SynapseBusLike): void {
    this.synapse = svc;
  }

  // ─── 配置读取（环境变量） ──────────────────────────────────────

  /** 本子模块是否启用（BRAIN_MEMORY_FORGET_ENABLED=0 时关闭） */
  private isEnabled(): boolean {
    return process.env.BRAIN_MEMORY_FORGET_ENABLED !== "0";
  }

  /** 剪枝阈值（score < 此值时清除节点 edge），缺省 0.1 */
  private getPruneThreshold(): number {
    const v = Number(process.env.BRAIN_MEMORY_FORGET_PRUNE_THRESHOLD);
    return Number.isFinite(v) && v > 0 ? v : 0.1;
  }

  /** 衰减阈值（score < 此值时推进 deletionStage 一级），缺省 0.2 */
  private getDecayThreshold(): number {
    const v = Number(process.env.BRAIN_MEMORY_FORGET_DECAY_THRESHOLD);
    return Number.isFinite(v) && v > 0 ? v : 0.2;
  }

  /** 再唤醒加成（frequencyScore 增量），缺省 0.3 */
  private getReawakenBoost(): number {
    const v = Number(process.env.BRAIN_MEMORY_FORGET_REAWAKEN_BOOST);
    return Number.isFinite(v) && v > 0 ? v : 0.3;
  }

  // ─── 公开方法 ───────────────────────────────────────────────────

  /**
   * 计算节点分数（纯函数，供外部调用）。
   * score = frequencyScore * 0.4 + recencyScore * 0.3 + importance * 0.2 + userFeedbackScore * 0.1
   */
  computeNodeScore(node: {
    frequencyScore: number;
    recencyScore: number;
    importance: number;
    userFeedbackScore: number;
  }): number {
    return (
      node.frequencyScore * 0.4 +
      node.recencyScore * 0.3 +
      node.importance * 0.2 +
      node.userFeedbackScore * 0.1
    );
  }

  /**
   * 连续打分器（BrainStem 45s 心跳触发）。
   *
   * - 对所有节点计算 score
   * - score < decayThreshold(0.2) 时推进 deletionStage 一级
   * - score < pruneThreshold(0.1) 时调用 pruneNodeEdges
   *
   * 不调 LLM。降级开关关闭或 humanLike 未注入时空操作。
   */
  async continuousScore(actorId: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.humanLike) return;

    const nodes = this.humanLike.getAllNodes(actorId);
    if (!nodes || nodes.length === 0) return;

    const decayThreshold = this.getDecayThreshold();
    const pruneThreshold = this.getPruneThreshold();

    for (const node of nodes) {
      const score = this.computeNodeScore(node);

      // 1) score < decayThreshold → 推进 deletionStage 一级
      if (score < decayThreshold) {
        const nextStage = this.nextStage(node.deletionStage);
        if (nextStage && nextStage !== node.deletionStage) {
          this.humanLike.updateDeletionStage(actorId, node.id, nextStage);
        }
      }

      // 2) score < pruneThreshold → 清除该节点所有 edge
      if (score < pruneThreshold) {
        this.humanLike.pruneNodeEdges(actorId, node.id);
      }
    }
  }

  /**
   * 再唤醒反弹（recall 命中 downranked/cold 节点时调用）。
   *
   * - 调用 humanLike.reawakenNode（内部 frequencyScore += 0.3 + deletionStage 回退一级）
   * - 发射 memory.reawakened 事件到 SynapseBus
   *
   * 不调 LLM。降级开关关闭或 humanLike 未注入时空操作；
   * synapse 未注入时仍执行 reawakenNode，仅跳过事件发射。
   */
  async reawakenAndStrengthen(actorId: string, nodeId: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.humanLike) return;

    this.humanLike.reawakenNode(actorId, nodeId);

    if (this.synapse) {
      try {
        this.synapse.fire(
          "memory.reawakened",
          {
            actorId,
            nodeId,
            boost: this.getReawakenBoost(),
            reawakenedAt: new Date().toISOString(),
          },
          { actorId, source: "memory_forgetting_controller" },
        );
      } catch (err) {
        console.log(`[MemoryForgettingController] fire memory.reawakened 失败: ${err}`);
      }
    }
  }

  /**
   * 连接剪枝（独立入口，continuousScore 内部也会调用）。
   *
   * - 对 score < pruneThreshold(0.1) 的节点调用 humanLike.pruneNodeEdges
   *
   * 不调 LLM。降级开关关闭或 humanLike 未注入时空操作。
   */
  async pruneConnections(actorId: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.humanLike) return;

    const nodes = this.humanLike.getAllNodes(actorId);
    if (!nodes || nodes.length === 0) return;

    const pruneThreshold = this.getPruneThreshold();
    for (const node of nodes) {
      const score = this.computeNodeScore(node);
      if (score < pruneThreshold) {
        this.humanLike.pruneNodeEdges(actorId, node.id);
      }
    }
  }

  /**
   * 压缩梯度（纯函数，非 LLM）——「该忘的退得掉」读侧体现。
   *
   * - score >= 0.5：原样返回
   * - 0.3 <= score < 0.5：保留 80% 内容（按字符长度截断）
   * - 0.1 <= score < 0.3：保留 50% 内容
   * - score < 0.1：保留 20% 内容（仅前 20% 字符 + "…"）
   *
   * 空文本直接返回空串。截断长度至少为 1 个字符。
   * 2026-10-22 接入 MemoryCortex.finalizeRecallItems：低遗忘分召回条目
   * 以残缺形式被想起（模拟记忆褪色），容量治理仍由 lifecycle TTL 两阶段遗忘承担。
   */
  compactRecallText(text: string, score: number): string {
    if (score >= 0.5) return text;
    if (text.length === 0) return text;

    let keepRatio: number;
    if (score >= 0.3) {
      keepRatio = 0.8;
    } else if (score >= 0.1) {
      keepRatio = 0.5;
    } else {
      keepRatio = 0.2;
    }

    const keepLen = Math.max(1, Math.floor(text.length * keepRatio));
    return text.slice(0, keepLen) + "…";
  }

  // ─── 内部工具 ───────────────────────────────────────────────────

  /**
   * 推进 deletionStage 一级。
   * active → downranked → cold → soft_deleted → hard_deleted
   * 已是 hard_deleted 时返回 null（不再推进）。
   */
  private nextStage(stage: MemoryDeletionStage): MemoryDeletionStage | null {
    const idx = STAGE_ORDER.indexOf(stage);
    if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
    return STAGE_ORDER[idx + 1];
  }
}
