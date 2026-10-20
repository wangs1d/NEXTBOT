/** 关系摘要缓存 TTL：里程碑写入低频，60s 内的重复召回直读缓存即可 */
const RELATIONSHIP_SUMMARY_TTL_MS = 60_000;

/**
 * 关系图谱服务（Phase 1.2）
 *
 * 设计原则：
 * - 复用 HumanLikeMemoryService 的 relationship domain 存储（不新建存储后端）
 * - 里程碑检测基于规则（warmth 跳变、首次事件等），无 LLM 调用
 * - 提供 recordMilestone / getRelationshipTrajectory / getSharedExperiences API
 * - 输出压缩为 ≤ 200 char 片段，避免 prompt token 膨胀
 *
 * 存储格式：
 * - 使用 HumanLikeMemoryService.ingest(domain: "relationship") 写入
 * - metadata 区分 milestone / shared_experience / trajectory_point
 */

/** 关系里程碑类型 */
export type MilestoneType =
  | "first_meeting" // 首次见面
  | "first_vulnerability" // 首次倾诉
  | "first_conflict_resolved" // 首次冲突解决
  | "trust_established" // 信任建立
  | "rapport_milestone" // 关系里程碑（默契达成）
  | "shared_experience" // 共同经历
  | "emotional_shift"; // 情感转折

/** 关系里程碑记录 */
export interface RelationshipMilestone {
  type: MilestoneType;
  title: string;
  occurredAt: string;
  emotionalValence: number; // -1.0 (负面) 到 1.0 (正面)
  metadata?: Record<string, unknown>;
}

/** 关系轨迹时间线 */
export interface TrajectoryPoint {
  timestamp: string;
  warmth: number;
  rapport: number;
  event?: string;
}

/** 关系轨迹快照 */
export interface RelationshipTrajectory {
  milestones: RelationshipMilestone[];
  trajectory: TrajectoryPoint[];
  currentWarmth: number;
  currentRapport: number;
  totalInteractions: number;
}

/**
 * 生活模型收敛接口（2026-10-20，P1）：把 warmth/rapport 状态映射为一条
 * kind='self_agent' 的边，并追加变化轨迹点。由 LifeModelStore 提供实现。
 */
export interface LifeModelConvergenceLike {
  convergeRelationshipState(
    actorId: string,
    state: { warmth: number; rapport: number },
    changePoint?: { at: string; intimacy: number; sentiment: number; note?: string; triggerRef?: string },
  ): unknown;
  getSelfAgentEdge(actorId: string): { id: string; intimacy: number; sentiment: number } | null;
  getEdgeChangeLog(
    actorId: string,
    edgeId: string,
    limit?: number,
  ): Array<{ at: string; intimacy: number; sentiment: number; note?: string }>;
}

/** HumanLikeMemoryService 的最小依赖接口 */
export interface RelationshipStorageLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: {
      context?: "main" | "notes";
      domain?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  buildRecall(
    actorId: string,
    query: string,
    opts?: {
      source?: string;
      context?: "main" | "notes";
      explicitDomain?: string;
      crossDomain?: boolean;
      limit?: number;
      detailLevel?: "summary" | "detail" | "source";
    },
  ): Promise<{
    domainId: string;
    mode: "single_domain" | "cross_domain";
    recalledNodeIds: string[];
    confidence: number;
    text: string;
  }>;
}

/**
 * 关系图谱服务
 *
 * 封装 HumanLikeMemoryService 的 relationship domain，
 * 提供关系专用 API（里程碑/轨迹/共同经历）。
 */
export class RelationshipGraphService {
  private readonly storage: RelationshipStorageLike;
  /** 内存缓存：最近的关系状态快照（用于里程碑检测） */
  private lastWarmthMap = new Map<string, number>();
  private lastRapportMap = new Map<string, number>();
  /**
   * 摘要缓存：getRelationshipSummary 与 query 无关却挂在每轮默认召回上，
   * 底层是对固定 query 的完整 humanLike 召回（含 embedding）。TTL 内直读缓存。
   */
  private summaryCache = new Map<string, { text: string; ts: number }>();
  /** 生活模型收敛（P1）：非空时把 warmth/rapport 映射为 self_agent 边，摘要走结构化边 */
  private lifeModelStore: LifeModelConvergenceLike | null = null;

  constructor(storage: RelationshipStorageLike) {
    this.storage = storage;
  }

  /** 注入生活模型（装配层接线；LifeModelStore 实例）。 */
  setLifeModelStore(store: LifeModelConvergenceLike | null): void {
    this.lifeModelStore = store;
  }

  /**
   * 记录关系里程碑
   * @returns 写入的里程碑（或 null 如果写入失败）
   */
  async recordMilestone(
    actorId: string,
    milestone: RelationshipMilestone,
  ): Promise<RelationshipMilestone | null> {
    try {
      const text = `[${milestone.type}] ${milestone.title} (valence: ${milestone.emotionalValence.toFixed(2)}, at: ${milestone.occurredAt})`;
      await this.storage.ingest(actorId, text, "relationship_graph", {
        context: "main",
        domain: "relationship",
        metadata: {
          milestoneType: milestone.type,
          title: milestone.title,
          occurredAt: milestone.occurredAt,
          emotionalValence: milestone.emotionalValence,
          ...milestone.metadata,
        },
      });
      this.summaryCache.delete(actorId);
      return milestone;
    } catch (err) {
      console.log(`[RelationshipGraph] recordMilestone 失败: ${err}`);
      return null;
    }
  }

  /**
   * 基于关系状态变化检测并记录里程碑（规则驱动）
   *
   * @returns 触发的里程碑列表（可能为空）
   */
  async detectAndRecordMilestone(
    actorId: string,
    current: { warmth: number; rapport: number },
  ): Promise<RelationshipMilestone[]> {
    const triggered: RelationshipMilestone[] = [];
    const lastWarmth = this.lastWarmthMap.get(actorId) ?? 0.3;
    const lastRapport = this.lastRapportMap.get(actorId) ?? 0.3;
    const now = new Date().toISOString();

    // 信任建立：warmth 从 < 0.3 跳到 > 0.5
    if (lastWarmth < 0.3 && current.warmth >= 0.5) {
      const ms: RelationshipMilestone = {
        type: "trust_established",
        title: "信任建立",
        occurredAt: now,
        emotionalValence: 0.8,
      };
      triggered.push(ms);
      await this.recordMilestone(actorId, ms);
    }

    // 关系里程碑：rapport 从 < 0.4 跳到 > 0.65
    if (lastRapport < 0.4 && current.rapport >= 0.65) {
      const ms: RelationshipMilestone = {
        type: "rapport_milestone",
        title: "默契达成",
        occurredAt: now,
        emotionalValence: 0.7,
      };
      triggered.push(ms);
      await this.recordMilestone(actorId, ms);
    }

    // 情感转折：warmth 大幅下降（> 0.2）
    if (current.warmth < lastWarmth - 0.2) {
      const ms: RelationshipMilestone = {
        type: "emotional_shift",
        title: "关系降温",
        occurredAt: now,
        emotionalValence: -0.4,
      };
      triggered.push(ms);
      await this.recordMilestone(actorId, ms);
    }

    // 更新缓存
    this.lastWarmthMap.set(actorId, current.warmth);
    this.lastRapportMap.set(actorId, current.rapport);

    // 生活模型收敛（P1）：warmth/rapport 映射为 self_agent 边（与「我和妹妹的关系」
    // 同构）；有触发里程碑时追加一个轨迹点（triggerRef 指向里程碑标题）。零 LLM。
    if (this.lifeModelStore) {
      const last = triggered[triggered.length - 1];
      try {
        this.lifeModelStore.convergeRelationshipState(
          actorId,
          current,
          last
            ? {
                at: last.occurredAt,
                intimacy: current.warmth,
                sentiment: (current.rapport - 0.5) * 2,
                note: last.title,
              }
            : undefined,
        );
        this.summaryCache.delete(actorId);
      } catch (err) {
        console.log(`[RelationshipGraph] 生活模型收敛失败（忽略）: ${err}`);
      }
    }

    return triggered;
  }

  /**
   * 获取关系轨迹
   * @param timeRange 可选的时间范围过滤（毫秒时间戳）
   */
  async getRelationshipTrajectory(
    actorId: string,
    timeRange?: { from?: number; to?: number },
  ): Promise<RelationshipTrajectory> {
    try {
      const result = await this.storage.buildRecall(
        actorId,
        "关系里程碑 轨迹 共同经历",
        {
          explicitDomain: "relationship",
          limit: 20,
          detailLevel: "summary",
        },
      );

      const milestones = this.parseMilestonesFromText(result.text);

      // 过滤时间范围
      const filtered = timeRange
        ? milestones.filter((m) => {
            const ts = Date.parse(m.occurredAt);
            if (Number.isNaN(ts)) return true;
            if (timeRange.from && ts < timeRange.from) return false;
            if (timeRange.to && ts > timeRange.to) return false;
            return true;
          })
        : milestones;

      const currentWarmth = this.lastWarmthMap.get(actorId) ?? 0.5;
      const currentRapport = this.lastRapportMap.get(actorId) ?? 0.5;

      return {
        milestones: filtered,
        trajectory: this.buildTrajectory(filtered, currentWarmth, currentRapport),
        currentWarmth,
        currentRapport,
        totalInteractions: filtered.length,
      };
    } catch (err) {
      console.log(`[RelationshipGraph] getRelationshipTrajectory 失败: ${err}`);
      return {
        milestones: [],
        trajectory: [],
        currentWarmth: 0.5,
        currentRapport: 0.5,
        totalInteractions: 0,
      };
    }
  }

  /**
   * 获取关系记忆摘要（压缩为 ≤ 200 char，用于 prompt 注入）
   */
  async getRelationshipSummary(actorId: string): Promise<string> {
    const cached = this.summaryCache.get(actorId);
    if (cached && Date.now() - cached.ts < RELATIONSHIP_SUMMARY_TTL_MS) {
      return cached.text;
    }
    // 结构化边摘要（P1 收敛）：self_agent 边存在时以生活模型为准（含亲疏/情感轨迹），
    // 与人物关系同构；不再走文本 blob 解析。边不存在（尚未收敛）时回退旧路径。
    if (this.lifeModelStore) {
      try {
        const edge = this.lifeModelStore.getSelfAgentEdge(actorId);
        if (edge) {
          const log = this.lifeModelStore.getEdgeChangeLog(actorId, edge.id, 5).slice(-3);
          const trail = log
            .map((p) => `${p.note ?? "变化"}(${p.at.slice(0, 10)})`)
            .join("; ");
          const structured = `关系(生活模型边): intimacy=${edge.intimacy.toFixed(2)}, sentiment=${edge.sentiment.toFixed(2)}${trail ? `; ${trail}` : ""}`;
          const text = structured.length > 200 ? structured.slice(0, 197) + "..." : structured;
          this.summaryCache.set(actorId, { text, ts: Date.now() });
          return text;
        }
      } catch (err) {
        console.log(`[RelationshipGraph] 结构化边摘要失败（回退旧路径）: ${err}`);
      }
    }
    const trajectory = await this.getRelationshipTrajectory(actorId);
    if (trajectory.milestones.length === 0) {
      // 空结果也进缓存：无关系记忆的 actor 不必每轮重复完整召回
      this.summaryCache.set(actorId, { text: "", ts: Date.now() });
      return "";
    }

    // 只取最近 3 个里程碑，每个截断到 60 char
    const recent = trajectory.milestones.slice(-3);
    const lines = recent.map(
      (m) =>
        `${m.title}(${m.type}, valence:${m.emotionalValence.toFixed(1)})`,
    );
    const summary = `关系: warmth=${trajectory.currentWarmth.toFixed(2)}, rapport=${trajectory.currentRapport.toFixed(2)}; ${lines.join("; ")}`;

    // 压缩到 200 char
    const text = summary.length > 200 ? summary.slice(0, 197) + "..." : summary;
    this.summaryCache.set(actorId, { text, ts: Date.now() });
    return text;
  }

  // ---- 内部工具 ----

  private parseMilestonesFromText(text: string): RelationshipMilestone[] {
    if (!text) return [];
    const milestones: RelationshipMilestone[] = [];
    // 按 [type] 分割
    const parts = text.split(/\[(?:first_meeting|first_vulnerability|first_conflict_resolved|trust_established|rapport_milestone|shared_experience|emotional_shift)\]/);
    const types = text.match(/\[(first_meeting|first_vulnerability|first_conflict_resolved|trust_established|rapport_milestone|shared_experience|emotional_shift)\]/g);

    if (!types || types.length === 0) {
      // 无结构化标记，返回原始文本作为单个 shared_experience
      if (text.trim()) {
        milestones.push({
          type: "shared_experience",
          title: text.slice(0, 80),
          occurredAt: new Date().toISOString(),
          emotionalValence: 0,
        });
      }
      return milestones;
    }

    for (let i = 0; i < types.length; i++) {
      const type = types[i]!.replace(/[[\]]/g, "") as MilestoneType;
      const content = (parts[i + 1] || "").trim().slice(0, 120);
      const valenceMatch = content.match(/valence:\s*(-?[\d.]+)/);
      const atMatch = content.match(/at:\s*([^\),]+)/);

      milestones.push({
        type,
        title: content.split("(")[0]?.trim() || content.slice(0, 60),
        occurredAt: atMatch?.[1] || new Date().toISOString(),
        emotionalValence: valenceMatch ? Number.parseFloat(valenceMatch[1]) : 0,
      });
    }

    return milestones;
  }

  private buildTrajectory(
    milestones: RelationshipMilestone[],
    currentWarmth: number,
    currentRapport: number,
  ): TrajectoryPoint[] {
    const points: TrajectoryPoint[] = milestones.map((m) => ({
      timestamp: m.occurredAt,
      warmth: currentWarmth,
      rapport: currentRapport,
      event: m.title,
    }));
    // 添加当前状态
    points.push({
      timestamp: new Date().toISOString(),
      warmth: currentWarmth,
      rapport: currentRapport,
    });
    return points;
  }
}
