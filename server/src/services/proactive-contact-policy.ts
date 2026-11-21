import type {
  PersonalizationRelationshipState,
  PersonalizationStyleProfileState,
  PersonalizationTimeRhythmState,
} from "./user-personalization/user-personalization-service.js";

export type ProactiveContactChannel = "websocket" | "voice" | "phone_call";

export type ProactiveContactPreferenceState = {
  channelAffinity: Record<ProactiveContactChannel, number>;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxDailyProactiveContacts: number;
  voiceUrgencyThreshold: number;
  phoneUrgencyThreshold: number;
  lastUpdatedAt: string;
};

export type ProactiveContactDecisionInput = {
  actorId: string;
  category?: string;
  urgency: number;
  confidence: number;
  tags: string[];
  wsConnected: boolean;
  recentContactCountHour: number;
  recentContactCountDay: number;
  relationship: PersonalizationRelationshipState | null;
  timeRhythm: PersonalizationTimeRhythmState | null;
  styleProfile: PersonalizationStyleProfileState | null;
  preference: ProactiveContactPreferenceState | null;
  now?: Date;
};

export type ProactiveContactDecision = {
  allowed: boolean;
  channel: ProactiveContactChannel;
  quietHours: boolean;
  disturbanceScore: number;
  reason: string;
  rationale: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeHour(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(23, Math.max(0, Math.round(raw)));
}

function isHourWithinRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function defaultPreference(
  rhythm: PersonalizationTimeRhythmState | null,
): ProactiveContactPreferenceState {
  return {
    channelAffinity: {
      websocket: 0.62,
      voice: 0.46,
      phone_call: 0.3,
    },
    quietHoursStart: rhythm?.lateNightTolerance && rhythm.lateNightTolerance >= 0.7 ? 0 : 23,
    quietHoursEnd: rhythm?.lateNightTolerance && rhythm.lateNightTolerance >= 0.7 ? 6 : 8,
    maxDailyProactiveContacts: 6,
    voiceUrgencyThreshold: 6.6,
    phoneUrgencyThreshold: 8.7,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function defaultContactPreferenceState(): ProactiveContactPreferenceState {
  return defaultPreference(null);
}

export class ProactiveContactPolicyService {
  decide(input: ProactiveContactDecisionInput): ProactiveContactDecision {
    const now = input.now ?? new Date();
    const preference = input.preference ?? defaultPreference(input.timeRhythm);
    // 禁音时段已移除（2026-11-20）：contact 决策不再按时段拦截。
    // quietHours 字段保留恒为 false，供个性化学习链路（learnPreference）兼容。
    const emergency =
      input.category === "warning" || input.urgency >= 8.8 || input.tags.includes("risk");
    const proactiveTolerance = input.relationship?.proactiveTolerance ?? 0.5;
    const rapport = input.relationship?.rapport ?? 0.35;

    const disturbanceScore = clamp(
      input.recentContactCountHour * 0.18 +
        input.recentContactCountDay * 0.07 +
        (1 - proactiveTolerance) * 0.18 +
        (rapport < 0.4 ? 0.08 : 0) +
        (input.wsConnected ? 0 : 0.1),
      0,
      1,
    );

    const rationale: string[] = [
      `urgency=${input.urgency.toFixed(2)}`,
      `confidence=${input.confidence.toFixed(2)}`,
      `recentHour=${input.recentContactCountHour}`,
      `recentDay=${input.recentContactCountDay}`,
      "active_window",
    ];

    // 质量驱动：移除每日配额硬限。
    // 真实有价值的信号（高 urgency / warning 类）不再被 daily_contact_budget_exceeded 拦截。
    // 保留该指标供前端展示与个性化学习，但不再阻断推送。

    if (disturbanceScore >= 0.92 && !emergency) {
      return {
        allowed: false,
        channel: "websocket",
        quietHours: false,
        disturbanceScore,
        reason: "disturbance_score_too_high",
        rationale,
      };
    }

    let channel: ProactiveContactChannel = "websocket";
    const phoneThreshold = clamp(preference.phoneUrgencyThreshold, 7.8, 9.5);
    const voiceThreshold = clamp(preference.voiceUrgencyThreshold, 5.5, 8.3);
    const voiceAffinity = preference.channelAffinity.voice ?? 0.46;
    const phoneAffinity = preference.channelAffinity.phone_call ?? 0.3;
    const directness = input.relationship?.directnessPreference ?? 0.5;
    const careStyle = input.styleProfile?.careStyle ?? "gentle";

    if (
      (emergency && !input.wsConnected) ||
      (input.urgency >= phoneThreshold && phoneAffinity >= 0.28 && input.confidence >= 0.72)
    ) {
      channel = "phone_call";
      rationale.push("phone_call_selected");
    } else if (
      (input.urgency >= voiceThreshold && voiceAffinity >= 0.42) ||
      (input.category === "care" && careStyle !== "direct" && input.urgency >= 6) ||
      (!input.wsConnected && input.urgency >= 6.2)
    ) {
      channel = "voice";
      rationale.push("voice_selected");
    }

    if (directness >= 0.72 && input.category === "planning") {
      channel = "websocket";
      rationale.push("prefer_text_for_direct_planning");
    }

    return {
      allowed: true,
      channel,
      quietHours: false,
      disturbanceScore,
      reason: "contact_allowed",
      rationale,
    };
  }

  learnPreference(
    current: ProactiveContactPreferenceState | null,
    params: {
      channel: ProactiveContactChannel;
      responded: boolean;
      responseTimeMs?: number;
      feedback?: "positive" | "negative" | "neutral";
      quietHours?: boolean;
    },
  ): ProactiveContactPreferenceState {
    const base = current ?? defaultPreference(null);
    const next: ProactiveContactPreferenceState = {
      ...base,
      channelAffinity: { ...base.channelAffinity },
      lastUpdatedAt: new Date().toISOString(),
    };

    const responseBoost = params.responded ? 0.06 : -0.05;
    const speedBoost =
      params.responded && (params.responseTimeMs ?? Number.POSITIVE_INFINITY) <= 120_000 ? 0.04 : 0;
    const feedbackBoost =
      params.feedback === "positive" ? 0.05 : params.feedback === "negative" ? -0.08 : 0;

    next.channelAffinity[params.channel] = clamp(
      next.channelAffinity[params.channel] + responseBoost + speedBoost + feedbackBoost,
      0.05,
      0.95,
    );

    if (params.quietHours && !params.responded) {
      next.maxDailyProactiveContacts = Math.max(3, next.maxDailyProactiveContacts - 1);
      next.quietHoursStart = normalizeHour(next.quietHoursStart - 1, 22);
      next.quietHoursEnd = normalizeHour(next.quietHoursEnd + 1, 8);
      next.phoneUrgencyThreshold = clamp(next.phoneUrgencyThreshold + 0.15, 7.8, 9.7);
    } else if (params.quietHours && params.responded && params.feedback !== "negative") {
      next.phoneUrgencyThreshold = clamp(next.phoneUrgencyThreshold - 0.08, 7.8, 9.7);
    }

    return next;
  }
}
