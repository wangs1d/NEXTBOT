import type { MemoryItem, MemoryRecallItem } from "../types.js";

export type ExperienceLifecycleStatus =
  | "raw"
  | "interpreted"
  | "generalized"
  | "verified"
  | "contradicted"
  | "archived"
  | "forgotten";

export type BeliefStatus = "active" | "disputed" | "deprecated";

export type LearningFeedbackOutcome =
  | "success"
  | "failure"
  | "correction"
  | "contradiction";

export interface LearningEpisode {
  id: string;
  actorId: string;
  sourceMemoryId: string;
  sourceKind: MemoryItem["kind"];
  status: ExperienceLifecycleStatus;
  observation: string;
  interpretation: string;
  lesson: string;
  tags: string[];
  evidence: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface BeliefRecord {
  id: string;
  actorId: string;
  claim: string;
  status: BeliefStatus;
  confidence: number;
  supportEpisodeIds: string[];
  contradictingEpisodeIds: string[];
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: string;
  updatedAt: string;
}

export interface LearningFeedback {
  actorId: string;
  beliefId?: string;
  episodeId?: string;
  outcome: LearningFeedbackOutcome;
  note: string;
  evidence?: string[];
  occurredAt?: string;
}

export interface LearningSnapshot {
  actorId: string;
  episodes: LearningEpisode[];
  beliefs: BeliefRecord[];
  updatedAt: string;
}

type ActorLearningState = {
  episodes: LearningEpisode[];
  beliefs: BeliefRecord[];
};

/**
 * 经验学习落盘适配器（P0，2026-10-20）：内存 store 重启即失 → 落盘后跨重启存活。
 * 由 LifeModelStore 提供实现（life_beliefs / life_episodes 表）；结构兼容即可。
 */
export interface LearningPersistenceLike {
  saveBeliefs(actorId: string, beliefs: BeliefRecord[]): void;
  loadBeliefs(actorId: string): BeliefRecord[];
  saveEpisodes(actorId: string, episodes: LearningEpisode[]): void;
  loadEpisodes(actorId: string): LearningEpisode[];
}

const MAX_EPISODES_PER_ACTOR = 200;
const MAX_BELIEFS_PER_ACTOR = 120;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stableToken(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function extractTags(text: string, metadata?: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  const rawTags = metadata?.tags;
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag === "string" && tag.trim()) tags.add(tag.trim().slice(0, 32));
    }
  }
  for (const word of normalizeText(text).split(/[\s,.;:!?，。；：！？、]+/)) {
    if (word.length >= 2 && tags.size < 8) tags.add(word.slice(0, 32));
  }
  return [...tags];
}

function inferOutcome(item: MemoryItem): LearningFeedbackOutcome | null {
  const outcome = item.metadata?.outcome;
  if (
    outcome === "success" ||
    outcome === "failure" ||
    outcome === "correction" ||
    outcome === "contradiction"
  ) {
    return outcome;
  }
  const text = item.content.toLowerCase();
  if (/fail|error|wrong|bug|regress|失败|错误|不对|纠正|修正/.test(text)) return "failure";
  if (/success|worked|passed|成功|通过|有效/.test(text)) return "success";
  return null;
}

function initialConfidence(item: MemoryItem, outcome: LearningFeedbackOutcome | null): number {
  const importance = item.importance ?? "medium";
  const importanceScore =
    importance === "critical" ? 0.85 : importance === "high" ? 0.75 : importance === "medium" ? 0.55 : 0.35;
  const feedbackScore =
    typeof item.metadata?.userFeedbackScore === "number"
      ? clamp01((item.metadata.userFeedbackScore + 1) / 2)
      : 0.5;
  const outcomeScore =
    outcome === "success" ? 0.72 : outcome === "failure" ? 0.62 : outcome ? 0.5 : 0.45;
  return clamp01(importanceScore * 0.45 + feedbackScore * 0.25 + outcomeScore * 0.3);
}

function shouldLearnFrom(item: MemoryItem): boolean {
  if (item.kind === "experience" || item.kind === "event" || item.kind === "procedure") return true;
  if (item.importance === "critical" || item.importance === "high") return true;
  if (inferOutcome(item)) return true;
  return false;
}

function buildLesson(item: MemoryItem, outcome: LearningFeedbackOutcome | null): string {
  const content = normalizeText(item.content);
  const explicitLesson = item.metadata?.lesson;
  if (typeof explicitLesson === "string" && explicitLesson.trim()) return normalizeText(explicitLesson);
  if (outcome === "failure") return `When a similar situation appears, avoid repeating this failed pattern: ${content}`;
  if (outcome === "success") return `This pattern is likely useful in similar situations: ${content}`;
  if (outcome === "correction") return `Prefer the corrected version over the earlier assumption: ${content}`;
  if (outcome === "contradiction") return `Treat the earlier related belief as uncertain until reverified: ${content}`;
  return `Use this experience as weak evidence for future similar situations: ${content}`;
}

function resolveBeliefKey(episode: LearningEpisode, item?: MemoryItem): string {
  const rawKey = item?.metadata?.learningBeliefKey;
  if (typeof rawKey === "string" && rawKey.trim()) return stableToken(rawKey);
  return stableToken(episode.lesson) || stableToken(episode.observation);
}

function mergeConfidence(previous: number, incoming: number): number {
  return clamp01(previous * 0.72 + incoming * 0.28);
}

export class MemoryExperienceLearningLoop {
  private readonly store = new Map<string, ActorLearningState>();
  /** 落盘适配器（P0）：非空时 getState 先 hydrate、变更后写穿 */
  private persistence: LearningPersistenceLike | null = null;
  private readonly hydratedActors = new Set<string>();

  /** 注入落盘适配器（装配层接线；LifeModelStore 实例）。 */
  setPersistence(p: LearningPersistenceLike | null): void {
    this.persistence = p;
  }

  observeMemoryItem(actorId: string, item: MemoryItem): LearningEpisode | null {
    if (!shouldLearnFrom(item)) return null;
    const now = nowIso();
    const outcome = inferOutcome(item);
    const sourceMemoryId =
      typeof item.metadata?.memoryId === "string"
        ? item.metadata.memoryId
        : `${item.source ?? "memory"}:${item.timestamp}:${stableToken(item.content)}`;
    const confidence = initialConfidence(item, outcome);
    const episode: LearningEpisode = {
      id: `episode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorId,
      sourceMemoryId,
      sourceKind: item.kind,
      status: outcome ? "generalized" : "interpreted",
      observation: normalizeText(item.content).slice(0, 1200),
      interpretation:
        typeof item.metadata?.interpretation === "string"
          ? normalizeText(item.metadata.interpretation)
          : outcome
            ? `Observed ${outcome} feedback from a concrete episode.`
            : "Observed a salient episode that may generalize later.",
      lesson: buildLesson(item, outcome),
      tags: extractTags(item.content, item.metadata),
      evidence: [normalizeText(item.content).slice(0, 500)],
      confidence,
      createdAt: now,
      updatedAt: now,
    };

    const state = this.getState(actorId);
    state.episodes.unshift(episode);
    state.episodes = state.episodes.slice(0, MAX_EPISODES_PER_ACTOR);
    this.upsertBeliefFromEpisode(state, episode, outcome, item);
    this.persist(actorId, state);
    return episode;
  }

  recordFeedback(feedback: LearningFeedback): BeliefRecord | null {
    const state = this.getState(feedback.actorId);
    const target =
      (feedback.beliefId && state.beliefs.find((b) => b.id === feedback.beliefId)) ||
      (feedback.episodeId && state.beliefs.find((b) => b.supportEpisodeIds.includes(feedback.episodeId!))) ||
      null;
    if (!target) return null;

    const now = feedback.occurredAt ?? nowIso();
    target.useCount += 1;
    target.lastUsedAt = now;
    if (feedback.outcome === "success") {
      target.successCount += 1;
      target.confidence = clamp01(target.confidence + 0.08);
      if (target.status === "disputed" && target.confidence >= 0.55) target.status = "active";
    } else if (feedback.outcome === "failure" || feedback.outcome === "correction") {
      target.failureCount += 1;
      target.confidence = clamp01(target.confidence - 0.12);
      if (feedback.outcome === "correction" || target.confidence < 0.45) target.status = "disputed";
    } else {
      target.failureCount += 1;
      target.confidence = clamp01(target.confidence - 0.18);
      target.status = target.confidence < 0.25 ? "deprecated" : "disputed";
    }
    target.updatedAt = now;

    if (feedback.episodeId) {
      const episode = state.episodes.find((e) => e.id === feedback.episodeId);
      if (episode) {
        episode.status =
          feedback.outcome === "success"
            ? "verified"
            : feedback.outcome === "contradiction"
              ? "contradicted"
              : episode.status;
        episode.evidence.unshift(feedback.note);
        episode.updatedAt = now;
      }
    }
    this.persist(feedback.actorId, state);
    return target;
  }

  recallLearningContext(actorId: string, query: string, limit = 5): MemoryRecallItem[] {
    const state = this.getState(actorId);
    const terms = extractTags(query);
    const scored = state.beliefs
      .filter((belief) => belief.status !== "deprecated")
      .map((belief) => {
        const haystack = `${belief.claim} ${belief.supportEpisodeIds.join(" ")}`.toLowerCase();
        const overlap = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
        const score = clamp01(belief.confidence * 0.7 + Math.min(0.3, overlap * 0.08));
        return { belief, score };
      })
      .filter((entry) => entry.score > 0.18)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ belief, score }) => ({
      content: `belief: ${belief.claim} | confidence=${belief.confidence.toFixed(2)} | status=${belief.status}`,
      domain: "semantic",
      source: "experience_learning_loop",
      importance: belief.confidence >= 0.75 ? "high" : "medium",
      score,
      timestamp: belief.updatedAt,
    }));
  }

  getSnapshot(actorId: string): LearningSnapshot {
    const state = this.getState(actorId);
    return {
      actorId,
      episodes: state.episodes.map((episode) => ({ ...episode, tags: [...episode.tags], evidence: [...episode.evidence] })),
      beliefs: state.beliefs.map((belief) => ({
        ...belief,
        supportEpisodeIds: [...belief.supportEpisodeIds],
        contradictingEpisodeIds: [...belief.contradictingEpisodeIds],
      })),
      updatedAt: nowIso(),
    };
  }

  private getState(actorId: string): ActorLearningState {
    const existing = this.store.get(actorId);
    if (existing) return existing;
    const created: ActorLearningState = { episodes: [], beliefs: [] };
    // 首次访问：从盘内 hydrate（P0，跨重启存活）
    if (this.persistence && !this.hydratedActors.has(actorId)) {
      this.hydratedActors.add(actorId);
      try {
        created.episodes = this.persistence.loadEpisodes(actorId);
        created.beliefs = this.persistence.loadBeliefs(actorId);
      } catch (err) {
        console.log(`[ExperienceLearning] hydrate 失败（忽略）: ${err}`);
      }
    }
    this.store.set(actorId, created);
    return created;
  }

  /** 写穿落盘（P0）：变更后把信念/经历同步到盘。 */
  private persist(actorId: string, state: ActorLearningState): void {
    if (!this.persistence) return;
    try {
      this.persistence.saveBeliefs(actorId, state.beliefs);
      this.persistence.saveEpisodes(actorId, state.episodes);
    } catch (err) {
      console.log(`[ExperienceLearning] 落盘失败（忽略）: ${err}`);
    }
  }

  private upsertBeliefFromEpisode(
    state: ActorLearningState,
    episode: LearningEpisode,
    outcome: LearningFeedbackOutcome | null,
    item?: MemoryItem,
  ): void {
    const key = resolveBeliefKey(episode, item);
    const beliefId = `belief-${key || episode.id}`;
    const existing = state.beliefs.find((belief) => belief.id === beliefId);
    if (existing) {
      existing.confidence = mergeConfidence(existing.confidence, episode.confidence);
      if (!existing.supportEpisodeIds.includes(episode.id)) existing.supportEpisodeIds.unshift(episode.id);
      if (outcome === "contradiction" && !existing.contradictingEpisodeIds.includes(episode.id)) {
        existing.contradictingEpisodeIds.unshift(episode.id);
        existing.status = "disputed";
        existing.confidence = clamp01(existing.confidence - 0.12);
      }
      existing.updatedAt = episode.updatedAt;
      return;
    }

    state.beliefs.unshift({
      id: beliefId,
      actorId: episode.actorId,
      claim: episode.lesson,
      status: outcome === "contradiction" ? "disputed" : "active",
      confidence: episode.confidence,
      supportEpisodeIds: [episode.id],
      contradictingEpisodeIds: outcome === "contradiction" ? [episode.id] : [],
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      updatedAt: episode.updatedAt,
    });
    state.beliefs = state.beliefs.slice(0, MAX_BELIEFS_PER_ACTOR);
  }
}
