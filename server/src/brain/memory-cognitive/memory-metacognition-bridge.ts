// Agent Brain Center — MemoryMetacognitionBridge（元记忆桥接器）
//
// 职责：桥接 MemoryCortex（元认知能力由本模块自身承载），
//   程序化实现"知之为知之，不知为不知"，防幻觉并触发自我探索。
//   **不通过 prompt 实现**——所有置信分层、防幻觉标记、探索触发都是规则计算。
//
// 核心机制：
//   1. 召回附带来源（provenance）与置信分层（confidenceTier）
//      - 调用 MemoryCortex.recall 获取基础召回
//      - 对每条 item 计算 confidenceTier（known / uncertain / unknown）
//      - 构造 MemoryProvenance（source / sourceType / capturedAt）
//   2. 低置信触发自我探索
//      - unknown 占比 > 阈值（默认 50%）时
//      - 不阻塞当前 recall 返回
//   3. 防幻觉过滤
//      - confidenceTier=unknown 的条目在 content 前附加显式标记
//      - 不删除条目（保留可用性，但明确不确定性）
//
// 设计要点：
//   - 纯规则计算，不调 LLM（避免幻觉）
//   - 任何依赖（MemoryCortex 等）
//     均可缺失，缺失时优雅降级
//   - BRAIN_MEMORY_METACOGNITION_ENABLED=0 可全局关闭，方法空操作

import type {
  MemoryRecallResult,
  MemoryRecallItem,
  MemoryProvenance,
  ConfidenceTier,
} from "../types.js";

// ============================================================
// 最小化外观接口（解耦具体实现，便于测试 mock）
// ============================================================

/**
 * MemoryCortex 的最小化外观接口。
 *
 * 只需要 recall 方法：拉取基础召回结果，桥接器在此之上附加 provenance / confidenceTier。
 */
export interface MemoryCortexLike {
  recall(
    actorId: string,
    query: string,
    opts?: { domain?: string; limit?: number },
  ): Promise<MemoryRecallResult>;
}

/**
 * 节点元信息外观（用于 confidenceTier 计算）。
 *
 * 由于 MemoryRecallItem 不直接携带 accessCount / correctness / verificationStatus，
 * 桥接器内部基于 item 字段构造此对象。
 */
export interface NodeMetaInfo {
  /** 节点 id（内容简易 hash） */
  nodeId: string;
  /** 召回次数（影响 confidenceTier：>= confirmThreshold 且 confirmed → known） */
  accessCount: number;
  /** 正确性状态：unknown / confirmed / suspected_error / rejected */
  correctness: string;
  /** 验证状态（历史字段，知识验证层已下线，恒为 undefined） */
  verificationStatus?: string;
  /** 来源标识 */
  source: string;
  /** 来源类型 */
  sourceType: "chat" | "tool" | "digest" | "world" | "system";
  /** 捕获时间 ISO */
  capturedAt: string;
}

// ============================================================
// 常量与配置
// ============================================================

/** 防幻觉标记前缀 */
const UNVERIFIED_MARKER = "【此信息未经证实，可能不准确】";

/** 默认探索触发阈值（unknown 占比） */
const DEFAULT_EXPLORE_THRESHOLD = 0.5;

/** 默认自动确认阈值（accessCount） */
const DEFAULT_CONFIRM_THRESHOLD = 3;

/** 合法的来源类型集合 */
const VALID_SOURCE_TYPES = new Set<string>(["chat", "tool", "digest", "world", "system"]);

// ============================================================
// 桥接器选项
// ============================================================

export interface MemoryMetacognitionBridgeOpts {
  /** 记忆皮层（基础召回来源）；null 时优雅降级为空召回 */
  memoryCortex?: MemoryCortexLike | null;
}

// ============================================================
// MemoryMetacognitionBridge
// ============================================================

/**
 * 元记忆桥接器。
 *
 * 桥接 MemoryCortex（召回）与元认知分层，
 * 程序化实现"知之为知之，不知为不知"。
 *
 * 用法：
 *   const bridge = new MemoryMetacognitionBridge({ memoryCortex, ... });
 *   const result = await bridge.recallWithProvenance(actorId, query);
 *   // result.items 已附带 provenance / confidenceTier
 *   // confidenceTier=unknown 的条目已附加防幻觉标记
 */
export class MemoryMetacognitionBridge {
  private readonly memoryCortex: MemoryCortexLike | null;

  constructor(opts: MemoryMetacognitionBridgeOpts = {}) {
    this.memoryCortex = opts.memoryCortex ?? null;
  }

  // ------------------------------------------------------------
  // 公开方法
  // ------------------------------------------------------------

  /**
   * 主入口：召回并附加来源与置信分层。
   *
   * 流程：
   *   1. 调用 memoryCortex.recall 获取基础召回
   *   2. 对每个 item 构造 NodeMetaInfo，计算 confidenceTier
   *   3. 构造 MemoryProvenance（source / sourceType / capturedAt）
   *   4. 对 confidenceTier=unknown 的条目附加防幻觉标记
   *   5. 异步触发自我探索（不阻塞）
   *   6. 返回扩展后的 MemoryRecallResult
   *
   * 不调 LLM。
   */
  async recallWithProvenance(
    actorId: string,
    query: string,
    opts?: { domain?: string; limit?: number; subQueries?: string[] },
  ): Promise<MemoryRecallResult> {
    // 降级开关
    if (!this.isEnabled()) {
      return this.emptyResult(actorId, query);
    }
    // memoryCortex 缺失时优雅降级
    if (!this.memoryCortex) {
      return this.emptyResult(actorId, query);
    }

    let baseResult: MemoryRecallResult;
    try {
      baseResult = await this.memoryCortex.recall(actorId, query, opts);
    } catch (e) {
      console.error("[MemoryMetacognitionBridge] memoryCortex.recall 失败，降级空召回:", e);
      return this.emptyResult(actorId, query);
    }

    // 对每个 item 计算 confidenceTier + 构造 provenance
    const enrichedItems: MemoryRecallItem[] = baseResult.items.map((item) => {
      const nodeMeta = this.buildNodeMeta(item);
      const confidenceTier = this.computeConfidenceTier(nodeMeta);
      const provenance: MemoryProvenance = {
        source: nodeMeta.source,
        sourceType: nodeMeta.sourceType,
        capturedAt: nodeMeta.capturedAt,
      };
      return { ...item, confidenceTier, provenance };
    });

    // 防幻觉过滤：unknown 条目附加标记
    const markedItems = this.markUnverified(enrichedItems);

    // 异步触发自我探索（不阻塞当前返回）
    void this.triggerSelfExplorationIfNeeded(actorId, markedItems, query);

    return { ...baseResult, items: markedItems };
  }

  /**
   * 规则计算置信分层。
   *
   * 优先级（verificationStatus 优先于 correctness + accessCount，验证层已下线恒走后者）：
   *   - verificationStatus = "verified" / "verified_strong" → "known"
   *   - verificationStatus = "pending_verification" → "uncertain"
   *   - verificationStatus = "disputed" / "rejected" → "unknown"
   *   - 无 verificationStatus 时按 correctness + accessCount：
   *     - correctness = "confirmed" 且 accessCount >= confirmThreshold → "known"
   *     - correctness = "confirmed" 但 accessCount < confirmThreshold → "uncertain"
   *     - correctness = "unknown" 且 accessCount < confirmThreshold → "unknown"
   *     - correctness = "suspected_error" / "rejected" → "unknown"
   *     - 其他 → "uncertain"
   *
   * 纯规则，不调 LLM。
   */
  computeConfidenceTier(nodeMeta: NodeMetaInfo): ConfidenceTier {
    // 降级开关：关闭时统一返回 uncertain（保守）
    if (!this.isEnabled()) {
      return "uncertain";
    }

    const v = nodeMeta.verificationStatus;

    // 1. verificationStatus 优先
    if (v === "verified" || v === "verified_strong") {
      return "known";
    }
    if (v === "pending_verification") {
      return "uncertain";
    }
    if (v === "disputed" || v === "rejected") {
      return "unknown";
    }

    // 2. 无 verificationStatus → 按 correctness + accessCount
    const confirmThreshold = this.confirmThreshold;
    const correctness = nodeMeta.correctness;
    const accessCount = nodeMeta.accessCount;

    if (correctness === "confirmed") {
      return accessCount >= confirmThreshold ? "known" : "uncertain";
    }
    if (correctness === "unknown") {
      return accessCount < confirmThreshold ? "unknown" : "uncertain";
    }
    if (correctness === "suspected_error" || correctness === "rejected") {
      return "unknown";
    }
    // 其他情况保守标记 uncertain
    return "uncertain";
  }

  /**
   * 防幻觉过滤：对 confidenceTier=unknown 的 item 附加显式标记。
   *
   * - 在 content 前附加 `【此信息未经证实，可能不准确】\n`
   * - 不删除任何条目（保留可用性，但明确不确定性）
   * - 返回新数组（不修改原数组）
   */
  markUnverified(items: MemoryRecallItem[]): MemoryRecallItem[] {
    if (!this.isEnabled()) {
      // 关闭时原样返回新数组（不附加标记）
      return items.slice();
    }
    return items.map((item) => {
      if (item.confidenceTier === "unknown") {
        return { ...item, content: `${UNVERIFIED_MARKER}\n${item.content}` };
      }
      return { ...item };
    });
  }

  /**
   * 触发自我探索：unknown 占比超阈值时异步学习。
   *
   * - 计算 unknown 占比
   * - 占比 > exploreThreshold 时：
   *   - 调用 metaCognition.markShouldExplore(actorId, "low_confidence_recall")（若可用）
   * - 不调 LLM
   *
   * 不会 await 它，因此调用方（如 recallWithProvenance）不会被阻塞。
   */
  async triggerSelfExplorationIfNeeded(
    actorId: string,
    items: MemoryRecallItem[],
    query: string,
  ): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (items.length === 0) {
      return;
    }
    const ratio = this.computeUnknownRatio(items);
    if (ratio <= this.exploreThreshold) {
      return;
    }
  }

  // ------------------------------------------------------------
  // 私有辅助
  // ------------------------------------------------------------

  /** 全局降级开关：BRAIN_MEMORY_METACOGNITION_ENABLED=0 时关闭 */
  private isEnabled(): boolean {
    const v = process.env.BRAIN_MEMORY_METACOGNITION_ENABLED;
    if (v == null) return true;
    return v.trim() !== "0";
  }

  /** 探索触发阈值（unknown 占比），缺省 0.5 */
  private get exploreThreshold(): number {
    const raw = process.env.BRAIN_MEMORY_METACOGNITION_EXPLORE_THRESHOLD;
    if (raw == null || raw.trim() === "") return DEFAULT_EXPLORE_THRESHOLD;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_EXPLORE_THRESHOLD;
  }

  /** 自动确认阈值（accessCount），缺省 3 */
  private get confirmThreshold(): number {
    const raw = process.env.BRAIN_MEMORY_METACOGNITION_CONFIRM_THRESHOLD;
    if (raw == null || raw.trim() === "") return DEFAULT_CONFIRM_THRESHOLD;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_CONFIRM_THRESHOLD;
  }

  /**
   * 基于 MemoryRecallItem 构造 NodeMetaInfo。
   *
   * MemoryRecallItem 不直接携带 accessCount / correctness / verificationStatus，
   * 这里：
   *   - source / sourceType / capturedAt 从 item.source / item.timestamp 派生
   *   - nodeId 从 content 派生（简易 hash）
   *   - accessCount / correctness / verificationStatus 使用保守默认值
   */
  private buildNodeMeta(item: MemoryRecallItem): NodeMetaInfo {
    const source = item.source ?? "system";
    const sourceType = this.deriveSourceType(source);
    const capturedAt = item.timestamp ?? new Date().toISOString();
    const nodeId = this.deriveNodeId(item.content);

    return {
      nodeId,
      // MemoryRecallItem 不携带 accessCount，保守取 0
      accessCount: 0,
      // MemoryRecallItem 不携带 correctness，保守取 "unknown"
      correctness: "unknown",
      source,
      sourceType,
      capturedAt,
    };
  }

  /** 从 source 字符串派生 sourceType */
  private deriveSourceType(source: string): "chat" | "tool" | "digest" | "world" | "system" {
    if (!source) return "system";
    // 精确匹配
    if (VALID_SOURCE_TYPES.has(source)) {
      return source as "chat" | "tool" | "digest" | "world" | "system";
    }
    // 前缀匹配（如 "tool:desktop.http_get" → "tool"）
    const head = source.split(/[:/-]/, 1)[0];
    if (head && VALID_SOURCE_TYPES.has(head)) {
      return head as "chat" | "tool" | "digest" | "world" | "system";
    }
    // knowledge-gap:web 视为 digest（LLM 摘要后的联网知识）
    if (source.startsWith("knowledge-gap")) {
      return "digest";
    }
    return "system";
  }

  /** 从 content 派生简易 nodeId（djb2 hash），用于关联验证服务 */
  private deriveNodeId(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
    }
    return `node-${(hash >>> 0).toString(36)}`;
  }

  /** 计算 unknown 条目占比 */
  private computeUnknownRatio(items: MemoryRecallItem[]): number {
    if (items.length === 0) return 0;
    const unknownCount = items.filter((it) => it.confidenceTier === "unknown").length;
    return unknownCount / items.length;
  }

  /** 构造空召回结果（降级时使用） */
  private emptyResult(actorId: string, query: string): MemoryRecallResult {
    return {
      actorId,
      query,
      items: [],
      domain: "semantic",
      mode: "single_domain",
      recalledAt: new Date().toISOString(),
    };
  }
}
