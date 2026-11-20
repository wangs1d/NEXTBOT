// Agent Brain Center — OnlineLearningCortex（在线学习皮层）
//
// 职责：从对话流式学习用户偏好、习惯、禁忌。
//   像海马体的模式分离 + 纹状体的习惯形成，从每次交互中微调用户画像。
//
// 核心机制：
//   1. observe(input, route, outcome)：每轮 cognize 后调用，流式更新
//   2. extractPreference(text)：从文本提取偏好信号（关键词驱动，不调 LLM）
//   3. applyToPrompt(prompt)：把用户画像注入 system prompt
//   4. 用户画像结构：preferences / habits / taboos / interactionStyle
//   5. 统一打分机制：stability × confidence = effectiveWeight
//      - stability：证据累积度（0-1），由信号类型和观察次数决定
//      - confidence：来源可靠度（0-1）
//      - effectiveWeight：实际影响权重，决定 prompt 注入强度
//
// 深度链接：
//   - cognize 阶段 3 记忆写入后调用 observe
//   - applyToPrompt 由 PromptContextBuilder 调用（暂只暴露接口，由 agent-core 接入）
//   - 流式更新（不批量），每次 cognize 都微调
//
// 设计要点：
//   - 纯规则匹配，不调 LLM（避免幻觉）
//   - 与 MemoryCortex 区分：Memory 是事件记忆，OnlineLearning 是用户画像
//   - 画像有衰减机制：长期未观察的偏好降权
//   - 隐私保护：taboo 类信息不写入持久化（仅内存）
//   - 全维度渐进式更新：所有维度（偏好/习惯/禁忌/风格）都通过统一打分机制
//     平滑过渡，不会因单次表达突然漂移

import type { RuleRouteDecision } from "./rule-router.js";

// ============================================================================
// 信号类型 — 决定响应速度
// ============================================================================

/**
 * 信号强度分类。
 *
 * 不同信号类型有不同的响应速度：
 * - explicit_strong：用户明确声明（"我喜欢X"），1-2 轮生效
 * - explicit_weak：用户弱表达（"X还行"），3-4 轮生效
 * - inferred：从行为推断（路由模式），5+ 轮生效
 * - style_request：风格类请求（"简洁一点"），渐进过渡
 */
export type SignalType = "explicit_strong" | "explicit_weak" | "inferred" | "style_request";

/** 信号类型 → 首次 stability 初始值 */
const SIGNAL_INITIAL_STABILITY: Record<SignalType, number> = {
  explicit_strong: 0.35,
  explicit_weak: 0.15,
  inferred: 0.08,
  style_request: 0.20,
};

/** 信号类型 → 每次观察的 stability 增量 */
const SIGNAL_STABILITY_STEP: Record<SignalType, number> = {
  explicit_strong: 0.30,
  explicit_weak: 0.18,
  inferred: 0.10,
  style_request: 0.25,
};

/** 信号类型 → 首次 confidence 初始值 */
const SIGNAL_INITIAL_CONFIDENCE: Record<SignalType, number> = {
  explicit_strong: 0.8,
  explicit_weak: 0.5,
  inferred: 0.4,
  style_request: 0.6,
};

// ============================================================================
// 数据结构
// ============================================================================

/** 用户画像 */
export interface UserProfile {
  actorId: string;
  /** 偏好（喜欢什么） */
  preferences: UserPatternEntry[];
  /** 习惯（经常做什么） */
  habits: UserPatternEntry[];
  /** 禁忌（避免做什么） */
  taboos: UserPatternEntry[];
  /** 交互风格（简洁/详细/正式/随意） */
  interactionStyle: UserPatternEntry;
  /** 交互风格过渡状态（平滑过渡用，undefined 表示不在过渡中） */
  styleTransition?: StyleTransition;
  /** 时区偏好 */
  timezone?: string;
  /** 语言偏好 */
  language?: string;
  /** 最近更新 */
  lastUpdated: string;
  /** 总观察次数 */
  totalObservations: number;
  /** 深度优化：用户近期关注话题列表 */
  topics: string[];
  /** 深度优化：用户偏好工具领域（如 search/desktop/compute） */
  preferredToolDomain?: string;
  /** 深度优化：否定/纠正反馈累计次数 */
  negativeFeedbackCount: number;
  /** 深度优化：是否处于学习活跃期（高频提问/探索） */
  learningActive?: boolean;
}

/**
 * 单条用户画像条目。
 *
 * 打分机制：
 * - stability（稳定度 0-1）：证据累积度，由信号类型和观察次数决定
 * - confidence（置信度 0-1）：来源可靠度
 * - effectiveWeight = stability × confidence：实际影响权重
 *
 * 生效分级：
 * - effectiveWeight >= 0.6 → 确定性引导："用户喜欢X"
 * - effectiveWeight >= 0.3 → 概率性引导："用户可能喜欢X"
 * - effectiveWeight >= 0.15 → 提示性引导："用户似乎偏好X"
 * - effectiveWeight < 0.15 → 不注入 prompt
 */
export interface UserPatternEntry {
  key: string;
  value: string;
  /** 置信度（0-1，来源可靠度） */
  confidence: number;
  /** 稳定度（0-1，证据累积度） */
  stability: number;
  /** 观察次数 */
  observations: number;
  /** 信号类型 */
  signalType: SignalType;
  /** 来源（"explicit" 用户明说 / "inferred" 从行为推断） */
  source: "explicit" | "inferred";
  /** 最后观察时间 */
  lastSeen: string;
}

/**
 * 交互风格过渡状态。
 *
 * 当用户说"简洁一点"时，不从 balanced 直接跳 concise，
 * 而是记录一个渐变过程，每次 observe 推进 progress，
 * 直到 progress >= 1.0 完成过渡。
 */
export interface StyleTransition {
  /** 起始风格 */
  fromValue: string;
  /** 目标风格 */
  toValue: string;
  /** 过渡进度 0.0~1.0 */
  progress: number;
  /** 每次观察的增量（显式 0.3，推断 0.15） */
  step: number;
  /** 开始时间 */
  startedAt: string;
  /** 最后更新时间 */
  lastUpdated: string;
}

// ============================================================================
// 偏好信号关键词（规则驱动）
// ============================================================================

const PREFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  category: "preferences" | "habits" | "taboos" | "interactionStyle";
  key: string;
  value: string;
  signalType: SignalType;
}> = [
  // 显式强偏好（explicit_strong）
  { pattern: /我喜欢|我爱好|我偏爱|我爱吃|我爱看|我就喜欢|我特别喜欢/i, category: "preferences", key: "preference", value: "extracted", signalType: "explicit_strong" },
  { pattern: /我不喜欢|我讨厌|我反感|别给我|我最讨厌/i, category: "taboos", key: "dislike", value: "extracted", signalType: "explicit_strong" },
  { pattern: /不要|别再|以后不要|禁止|绝对不要/i, category: "taboos", key: "forbidden", value: "extracted", signalType: "explicit_strong" },
  // 显式弱表达（explicit_weak）
  { pattern: /还行|还可以|挺好的|不错|一般般|勉强/i, category: "preferences", key: "weak_preference", value: "extracted", signalType: "explicit_weak" },
  // 交互风格（style_request）
  { pattern: /简洁|简短|直接说|别啰嗦/i, category: "interactionStyle", key: "style", value: "concise", signalType: "style_request" },
  { pattern: /详细|展开|多说点|讲清楚/i, category: "interactionStyle", key: "style", value: "detailed", signalType: "style_request" },
  { pattern: /正式|专业|严谨/i, category: "interactionStyle", key: "style", value: "formal", signalType: "style_request" },
  { pattern: /随便|轻松|随意/i, category: "interactionStyle", key: "style", value: "casual", signalType: "style_request" },
  // 推断的习惯（inferred）
  { pattern: /每天|经常|通常|总是/i, category: "habits", key: "frequency", value: "extracted", signalType: "inferred" },
];

// 路由 → 习惯推断
const ROUTE_TO_HABIT: Record<string, { key: string; value: string }> = {
  complex: { key: "task_preference", value: "complex_tasks" },
  fast: { key: "task_preference", value: "simple_qa" },
};

// ============================================================================
// 常量
// ============================================================================

const STABILITY_MAX = 1.0;
const CONFIDENCE_MAX = 1.0;
const DECAY_THRESHOLD_MS = 7 * 24 * 60 * 60_000; // 7 天未观察 → 降权
const DECAY_AMOUNT = 0.1;

/** effectiveWeight 分级阈值 */
const WEIGHT_DEFINITIVE = 0.6; // >= 确定性引导
const WEIGHT_PROBABLE = 0.3; // >= 概率性引导
const WEIGHT_HINT = 0.15; // >= 提示性引导
// < WEIGHT_HINT → 不注入

/**
 * 在线学习皮层。
 *
 * 从对话流式学习用户画像，不调 LLM，纯规则匹配。
 * 每轮 cognize 后调用 observe，applyToPrompt 由上层注入。
 *
 * 全维度渐进式打分：
 *   所有画像维度（偏好/习惯/禁忌/风格）通过统一打分机制平滑演化。
 *   stability × confidence = effectiveWeight，决定实际影响强度。
 */
export class OnlineLearningCortex {
  /** actorId → 用户画像 */
  private readonly profiles = new Map<string, UserProfile>();
  /** actorId → 连续提问计数（用于检测学习活跃期） */
  private readonly queryCounts = new Map<string, number>();

  /** 统计 */
  private observeCount = 0;
  private preferenceExtractedCount = 0;
  private tabooExtractedCount = 0;

  /** 获取用户画像（不存在时初始化空画像） */
  getProfile(actorId: string): UserProfile {
    let profile = this.profiles.get(actorId);
    if (!profile) {
      profile = {
        actorId,
        preferences: [],
        habits: [],
        taboos: [],
        interactionStyle: {
          key: "style",
          value: "balanced",
          confidence: 0.3,
          stability: 0.2,
          observations: 0,
          signalType: "inferred",
          source: "inferred",
          lastSeen: new Date().toISOString(),
        },
        lastUpdated: new Date().toISOString(),
        totalObservations: 0,
        topics: [],
        preferredToolDomain: undefined,
        negativeFeedbackCount: 0,
        learningActive: undefined,
      };
      this.profiles.set(actorId, profile);
    }
    return profile;
  }

  /**
   * 观察一次交互，流式更新画像。
   * cognize 阶段 3 调用。
   */
  observe(
    actorId: string,
    input: { text: string },
    route: RuleRouteDecision,
    _outcome?: { success: boolean; response?: string },
  ): UserProfile {
    this.observeCount++;
    const profile = this.getProfile(actorId);
    profile.totalObservations++;
    profile.lastUpdated = new Date().toISOString();
    const now = new Date().toISOString();

    // 1. 推进交互风格过渡（每轮被动推进，实现平滑渐变）
    // 放在 PREFERENCE_PATTERNS 之前：先推进上一轮的被动过渡，再处理本轮主动信号
    this.tickTransition(profile, now);

    // 1.5 关键词匹配提取偏好
    for (const p of PREFERENCE_PATTERNS) {
      if (p.pattern.test(input.text)) {
        const match = input.text.match(p.pattern);
        const after = match ? input.text.slice(match.index! + match[0].length).trim().slice(0, 100) : "";
        const value = p.value === "extracted" ? (after || "unknown") : p.value;

        this.upsertEntry(
          profile,
          p.category,
          p.key,
          value,
          p.signalType,
          now,
        );

        if (p.category === "preferences") this.preferenceExtractedCount++;
        if (p.category === "taboos") this.tabooExtractedCount++;
      }
    }

    // 2. 从路由推断习惯
    const habitInfer = ROUTE_TO_HABIT[route.mode];
    if (habitInfer) {
      this.upsertEntry(profile, "habits", habitInfer.key, habitInfer.value, "inferred", now);
    }

    // 3. 衰减长期未观察的画像
    this.applyDecay(profile);

    // 4. 深度优化：追踪否定/纠正反馈（observe 中不再计数，由专门的 recordCorrection 处理）

    // 5. 深度优化：提取话题关键词（简单分词，取前 3 个有意义的词）
    const topicWords = input.text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !/^(你好|请问|我想|我要|你能|帮我|可以|吗|了|的|是|在|有|和|就|都|而|及|与|着|或|一个|没有|我们|他们|你们|这个|那个|这些|那些)$/i.test(w))
      .slice(0, 3);
    for (const word of topicWords) {
      if (!profile.topics.includes(word)) {
        profile.topics.push(word);
        if (profile.topics.length > 10) profile.topics.shift();
      }
    }

    // 6. 深度优化：追踪偏好工具领域
    const domainFromRoute: Record<string, string> = {
      search: "search",
      compute: "compute",
      browser: "browser",
    };
    for (const [key, domain] of Object.entries(domainFromRoute)) {
      if (input.text.toLowerCase().includes(key)) {
        profile.preferredToolDomain = domain;
        break;
      }
    }

    // 7. 深度优化：检测学习活跃期（连续提问判定为活跃）
    const qc = (this.queryCounts.get(actorId) ?? 0) + 1;
    this.queryCounts.set(actorId, qc);
    if (qc >= 3) {
      profile.learningActive = true;
    }

    this.profiles.set(actorId, profile);
    return profile;
  }

  // ==========================================================================
  // 统一打分机制 — 所有维度共用
  // ==========================================================================

  /**
   * 计算条目的有效权重。
   * effectiveWeight = stability × confidence
   */
  private getEffectiveWeight(entry: UserPatternEntry): number {
    return entry.stability * entry.confidence;
  }

  /**
   * 根据有效权重获取生效级别。
   * - "definitive"：确定性引导
   * - "probable"：概率性引导
   * - "hint"：提示性引导
   * - "none"：不注入
   */
  private getWeightLevel(entry: UserPatternEntry): "definitive" | "probable" | "hint" | "none" {
    const w = this.getEffectiveWeight(entry);
    if (w >= WEIGHT_DEFINITIVE) return "definitive";
    if (w >= WEIGHT_PROBABLE) return "probable";
    if (w >= WEIGHT_HINT) return "hint";
    return "none";
  }

  /**
   * 插入或更新画像条目（统一打分，全维度渐进式更新）。
   *
   * 核心原则：
   * - 不直接替换已有值，同 key 不同 value 的条目可以共存
   * - 每次观察推进 stability，由信号类型决定步长
   * - effectiveWeight 决定实际影响，低权重条目不会突然改变行为
   */
  private upsertEntry(
    profile: UserProfile,
    category: "preferences" | "habits" | "taboos" | "interactionStyle",
    key: string,
    value: string,
    signalType: SignalType,
    now: string,
  ): void {
    // 交互风格使用平滑过渡逻辑
    if (category === "interactionStyle") {
      this.upsertInteractionStyle(profile, value, signalType, now);
      return;
    }

    const list = profile[category];
    const existing = list.find((e) => e.key === key && e.value === value);

    if (existing) {
      // 已有条目 → 推进 stability 和 confidence
      existing.observations++;
      existing.stability = Math.min(
        STABILITY_MAX,
        existing.stability + SIGNAL_STABILITY_STEP[signalType],
      );
      existing.confidence = Math.min(
        CONFIDENCE_MAX,
        existing.confidence + 0.1,
      );
      existing.lastSeen = now;
      // 信号类型升级：如果新信号更强，升级
      if (this.signalRank(signalType) > this.signalRank(existing.signalType)) {
        existing.signalType = signalType;
      }
      if (signalType !== "inferred") existing.source = "explicit";
    } else {
      // 新条目 → 用信号类型决定初始 stability 和 confidence
      const entry: UserPatternEntry = {
        key,
        value,
        confidence: SIGNAL_INITIAL_CONFIDENCE[signalType],
        stability: SIGNAL_INITIAL_STABILITY[signalType],
        observations: 1,
        signalType,
        source: signalType === "inferred" ? "inferred" : "explicit",
        lastSeen: now,
      };
      list.push(entry);
    }
  }

  /** 信号类型排名（用于升级判定） */
  private signalRank(s: SignalType): number {
    switch (s) {
      case "explicit_strong": return 4;
      case "style_request": return 3;
      case "explicit_weak": return 2;
      case "inferred": return 1;
    }
  }

  /**
   * 平滑更新交互风格。
   *
   * 核心原则：不直接替换 value，而是通过 StyleTransition 逐步过渡。
   * - 相同风格 → 增加 stability 和 confidence
   * - 不同风格 → 开始/推进过渡，progress 逐步增加直到 1.0 完成
   */
  private upsertInteractionStyle(
    profile: UserProfile,
    value: string,
    signalType: SignalType,
    now: string,
  ): void {
    // 情况 1：相同风格 → 增加 stability 和 confidence
    if (profile.interactionStyle.value === value) {
      profile.interactionStyle.observations++;
      profile.interactionStyle.stability = Math.min(
        STABILITY_MAX,
        profile.interactionStyle.stability + SIGNAL_STABILITY_STEP[signalType],
      );
      profile.interactionStyle.confidence = Math.min(
        CONFIDENCE_MAX,
        profile.interactionStyle.confidence + 0.1,
      );
      profile.interactionStyle.lastSeen = now;
      if (signalType !== "inferred") {
        profile.interactionStyle.source = "explicit";
        profile.interactionStyle.signalType = signalType;
      }
      return;
    }

    // 情况 2：已经在过渡到目标风格 → 推进进度
    if (profile.styleTransition && profile.styleTransition.toValue === value) {
      profile.styleTransition.progress = Math.min(
        1.0,
        profile.styleTransition.progress + profile.styleTransition.step,
      );
      profile.styleTransition.lastUpdated = now;
      profile.interactionStyle.observations++;
      profile.interactionStyle.lastSeen = now;

      // 过渡完成 → 切换 value
      if (profile.styleTransition.progress >= 1.0) {
        profile.interactionStyle.value = profile.styleTransition.toValue;
        profile.interactionStyle.stability = Math.min(
          STABILITY_MAX,
          profile.interactionStyle.stability + SIGNAL_STABILITY_STEP[signalType],
        );
        profile.interactionStyle.confidence = Math.min(
          CONFIDENCE_MAX,
          profile.interactionStyle.confidence + 0.1,
        );
        if (signalType !== "inferred") {
          profile.interactionStyle.source = "explicit";
          profile.interactionStyle.signalType = signalType;
        }
        profile.styleTransition = undefined;
      }
      return;
    }

    // 情况 3：全新的风格切换 → 建立过渡状态
    const step = signalType === "style_request" ? 0.3 : 0.15;
    profile.styleTransition = {
      fromValue: profile.interactionStyle.value,
      toValue: value,
      progress: step,
      step,
      startedAt: now,
      lastUpdated: now,
    };
    profile.interactionStyle.observations = 1;
    profile.interactionStyle.stability = SIGNAL_INITIAL_STABILITY[signalType];
    profile.interactionStyle.confidence = SIGNAL_INITIAL_CONFIDENCE[signalType];
    profile.interactionStyle.signalType = signalType;
    profile.interactionStyle.lastSeen = now;
    profile.interactionStyle.source = signalType === "inferred" ? "inferred" : "explicit";
  }

  /** 衰减：长期未观察的画像降权 */
  private applyDecay(profile: UserProfile): void {
    const now = Date.now();
    const allEntries = [
      ...profile.preferences,
      ...profile.habits,
      ...profile.taboos,
      profile.interactionStyle,
    ];
    for (const entry of allEntries) {
      const age = now - new Date(entry.lastSeen).getTime();
      if (age > DECAY_THRESHOLD_MS) {
        entry.confidence = Math.max(0, entry.confidence - DECAY_AMOUNT);
        entry.stability = Math.max(0, entry.stability - DECAY_AMOUNT);
      }
    }
    // 清理 confidence=0 或 stability=0 的条目
    profile.preferences = profile.preferences.filter((e) => e.confidence > 0 && e.stability > 0);
    profile.habits = profile.habits.filter((e) => e.confidence > 0 && e.stability > 0);
    profile.taboos = profile.taboos.filter((e) => e.confidence > 0 && e.stability > 0);
    // 长期未交互 → 过渡状态也降权
    if (profile.styleTransition) {
      const age = now - new Date(profile.styleTransition.lastUpdated).getTime();
      if (age > DECAY_THRESHOLD_MS) {
        profile.styleTransition.progress = Math.max(0, profile.styleTransition.progress - 0.1);
        if (profile.styleTransition.progress <= 0) {
          profile.styleTransition = undefined;
        }
      }
    }
  }

  /**
   * 获取当前生效的交互风格（考虑过渡状态）。
   *
   * 评级规则：
   * - progress >= 1.0 → 目标风格（过渡完成）
   * - progress >= 0.66 → 目标风格
   * - progress >= 0.33 → 混合风格（from_to）
   * - progress < 0.33 → 起始风格（刚开始过渡）
   */
  getEffectiveStyle(actorId: string): string {
    const profile = this.getProfile(actorId);
    if (!profile.styleTransition) return profile.interactionStyle.value;

    const p = profile.styleTransition.progress;
    if (p >= 1.0) return profile.styleTransition.toValue;
    if (p >= 0.66) return profile.styleTransition.toValue;
    if (p >= 0.33) return `${profile.styleTransition.fromValue}_${profile.styleTransition.toValue}`;
    return profile.styleTransition.fromValue;
  }

  /**
   * 推进过渡状态（每轮 observe 调用一次）。
   * 在用户没有再次明确要求的情况下，被动推进进度。
   * 步长 0.05，约 20 轮后完全过渡。
   */
  private tickTransition(profile: UserProfile, now: string): void {
    if (!profile.styleTransition) return;
    if (profile.styleTransition.progress >= 1.0) {
      profile.interactionStyle.value = profile.styleTransition.toValue;
      profile.styleTransition = undefined;
      return;
    }

    profile.styleTransition.progress = Math.min(1.0, profile.styleTransition.progress + 0.05);
    profile.styleTransition.lastUpdated = now;
    profile.interactionStyle.lastSeen = now;

    if (profile.styleTransition.progress >= 1.0) {
      profile.interactionStyle.value = profile.styleTransition.toValue;
      profile.interactionStyle.confidence = Math.min(CONFIDENCE_MAX, profile.interactionStyle.confidence + 0.1);
      profile.styleTransition = undefined;
    }
  }

  // ==========================================================================
  // Prompt 注入 — 按 effectiveWeight 分级
  // ==========================================================================

  /** 把用户画像注入 prompt（供 PromptContextBuilder 调用） */
  applyToPrompt(actorId: string): string {
    const profile = this.getProfile(actorId);
    const lines: string[] = [];

    // 偏好 — 按权重分级注入
    if (profile.preferences.length > 0) {
      const prefLines = this.formatEntriesByWeight(profile.preferences, "偏好");
      if (prefLines) lines.push(prefLines);
    }

    // 禁忌 — 权重 >= hint 才注入
    if (profile.taboos.length > 0) {
      const tabooLines = this.formatEntriesByWeight(profile.taboos, "禁忌", true);
      if (tabooLines) lines.push(tabooLines);
    }

    // 交互风格
    if (profile.interactionStyle.observations > 0) {
      if (profile.styleTransition) {
        const pct = Math.round(profile.styleTransition.progress * 100);
        lines.push(
          `交互风格偏好：正在从 ${profile.styleTransition.fromValue} 向 ${profile.styleTransition.toValue} 过渡（${pct}%）`,
        );
      } else {
        const level = this.getWeightLevel(profile.interactionStyle);
        if (level !== "none") {
          const w = this.getEffectiveWeight(profile.interactionStyle);
          const prefix = level === "definitive" ? "" : level === "probable" ? "可能" : "似乎";
          lines.push(
            `交互风格偏好：${prefix}${profile.interactionStyle.value}（权重=${w.toFixed(2)}）`,
          );
        }
      }
    }

    // 习惯
    if (profile.habits.length > 0) {
      const habitLines = this.formatEntriesByWeight(profile.habits, "习惯");
      if (habitLines) lines.push(habitLines);
    }

    return lines.length > 0 ? `【用户画像（在线学习）】\n${lines.join("\n")}` : "";
  }

  /**
   * 按有效权重分级格式化条目。
   * - definitive → "用户喜欢X"
   * - probable → "用户可能喜欢X"
   * - hint → "用户似乎偏好X"
   * - none → 不输出
   */
  private formatEntriesByWeight(
    entries: UserPatternEntry[],
    label: string,
    isTaboo: boolean = false,
  ): string {
    const definitive: string[] = [];
    const probable: string[] = [];
    const hint: string[] = [];

    for (const e of entries) {
      const level = this.getWeightLevel(e);
      const w = this.getEffectiveWeight(e);
      const detail = `${e.key}: ${e.value}（权重=${w.toFixed(2)}）`;

      if (level === "definitive") {
        definitive.push(`  - ${detail}`);
      } else if (level === "probable") {
        probable.push(`  - ${detail}`);
      } else if (level === "hint") {
        hint.push(`  - ${detail}`);
      }
    }

    const parts: string[] = [];
    if (definitive.length > 0) {
      parts.push(`用户${label}：\n${definitive.join("\n")}`);
    }
    if (probable.length > 0) {
      parts.push(`用户可能${label}：\n${probable.join("\n")}`);
    }
    if (hint.length > 0) {
      parts.push(`用户似乎有此${label}：\n${hint.join("\n")}`);
    }

    return parts.join("\n");
  }

  // ==========================================================================
  // 主动学习 / 纠正
  // ==========================================================================

  /** 显式设置画像（用户主动告知"我喜欢X"时由 DecisionHub 调用） */
  setExplicitPreference(actorId: string, key: string, value: string): void {
    const profile = this.getProfile(actorId);
    this.upsertEntry(profile, "preferences", key, value, "explicit_strong", new Date().toISOString());
    this.preferenceExtractedCount++;
    this.profiles.set(actorId, profile);
  }

  /**
   * 记录用户纠正反馈，触发主动学习循环。
   *
   * 当用户说"不是这样/你错了/应该是X"时，OnlineLearningCortex 做三件事：
   *   1. 增加 negativeFeedbackCount（影响路由：高频否定 → 升级到 complex）
   *   2. 降权最近 3 轮内提取的偏好/习惯（stability × 0.5，最多降到 0.05）
   *   3. 从纠正文本中提取"正确的"信号（用户说"应该是X" → 提取 X 作为新偏好）
   *
   * @param actorId 当前 actor
   * @param correctionText 用户纠正文本（如"不是这样，应该是Python"）
   * @returns 更新后的用户画像
   */
  recordCorrection(actorId: string, correctionText: string): UserProfile {
    const profile = this.getProfile(actorId);
    const now = new Date().toISOString();

    // 1. 增加否定反馈计数
    profile.negativeFeedbackCount++;

    // 2. 降权最近偏好/习惯（stability × 0.5，下限 0.05）
    const downgradeEntry = (entry: UserPatternEntry): void => {
      entry.stability = Math.max(0.05, entry.stability * 0.5);
      entry.confidence = Math.max(0.1, entry.confidence * 0.8);
      entry.lastSeen = now;
    };
    for (const entry of profile.preferences) {
      if (entry.observations <= 3) downgradeEntry(entry);
    }
    for (const entry of profile.habits) {
      if (entry.observations <= 3) downgradeEntry(entry);
    }

    // 3. 从纠正文本提取"正确的"信号
    const shouldBeMatch = correctionText.match(/应该是["""]?([^，。！？\s""]{1,20})["""]?/i);
    if (shouldBeMatch) {
      const correctValue = shouldBeMatch[1].trim();
      if (correctValue) {
        // 纠正的值作为 explicit_strong 偏好（高初始 stability）
        this.upsertEntry(profile, "preferences", "corrected_preference", correctValue, "explicit_strong", now);
        // 降权旧的同 key 偏好（不删除，让它们自然衰减）
        for (const entry of profile.preferences) {
          if (entry.key !== "corrected_preference" && entry.observations <= 3) {
            entry.stability = Math.max(0.05, entry.stability * 0.5);
          }
        }
      }
    }

    profile.lastUpdated = now;
    this.profiles.set(actorId, profile);
    return profile;
  }

  /** 显式设置禁忌 */
  setExplicitTaboo(actorId: string, key: string, value: string): void {
    const profile = this.getProfile(actorId);
    this.upsertEntry(profile, "taboos", key, value, "explicit_strong", new Date().toISOString());
    this.tabooExtractedCount++;
    this.profiles.set(actorId, profile);
  }

  // ==========================================================================
  // 统计 / 生命周期
  // ==========================================================================

  getStats(): {
    profileCount: number;
    observeCount: number;
    preferenceExtractedCount: number;
    tabooExtractedCount: number;
  } {
    return {
      profileCount: this.profiles.size,
      observeCount: this.observeCount,
      preferenceExtractedCount: this.preferenceExtractedCount,
      tabooExtractedCount: this.tabooExtractedCount,
    };
  }

  async start(): Promise<void> {
    console.log("[OnlineLearningCortex] 启动完成");
  }
  async stop(): Promise<void> {
    this.profiles.clear();
    console.log("[OnlineLearningCortex] 已停止");
  }
}
