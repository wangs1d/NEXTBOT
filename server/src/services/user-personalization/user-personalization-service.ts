import type { AgentMemorySyncService } from "../agent-memory-sync-service.js";
import { isDirectFactQuery } from "../../agent/direct-fact-query.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import { EmotionRecognitionService } from "../emotion-recognition-service.js";
import { PersonalityAdjuster } from "../../brain/personality-adjuster.js";
import type { PersonalityAdjustmentInput } from "../../brain/personality-adjuster.js";
import type { PersonalityCore } from "../../brain/types.js";
import {
  buildToneGuidance,
  defaultEmotionState,
  detectEmotionFromText,
  detectPreferredToneFromText,
  dominantRecentEmotion,
  pushEmotion,
  type EmotionLabel,
  type EmotionState,
  type PreferredTone,
} from "./emotion-tone.js";
import {
  applyProfilePatches,
  extractProfilePatches,
  syncPreferredToneInProfile,
  truncateProfileForPrompt,
} from "./profile-heuristics.js";
import { UserProfileStore, hasRealProfileContent } from "./user-profile-store.js";
import { projectProfileMarkdown } from "./profile-fact-authority.js";
import {
  decayFactStore,
  defaultFactStore,
  extractFactCandidates,
  mergeFactCandidates,
  toFactStore,
  travelFactOf,
  type FactCandidate,
  type UserFactStore,
} from "./user-profile-facts.js";

/**
 * 旅行人格分型（travel 双端③）：由 UserFact travel 类聚合出的轻量画像标签。
 * 随规划载荷下发攻略页展示，并参与每日景点密度微调。
 */
export interface TravelPersona {
  id: "shutter" | "explorer" | "curator" | "wanderer";
  label: string;
  desc: string;
}
import {
  defaultContactPreferenceState,
  ProactiveContactPolicyService,
  type ProactiveContactChannel,
  type ProactiveContactPreferenceState,
} from "../proactive-contact-policy.js";

const EMOTION_STATE_KEY = "emotion_state";
const USER_PROFILE_KV_KEY = "user_profile";
const USER_BEHAVIOR_SIGNAL_KEY = "user_behavior_signal";
const USER_PROFILE_FACTS_KEY = "user_profile_facts";
const USER_RELATIONSHIP_KEY = "user_relationship_state";
const USER_TIME_RHYTHM_KEY = "user_time_rhythm";
const USER_STYLE_PROFILE_KEY = "user_style_profile";
const USER_CONTACT_PREFERENCE_KEY = "user_contact_preference";
const USER_REPLY_LENGTH_PROFILE_KEY = "user_reply_length_profile";
const USER_BEHAVIOR_BASELINE_KEY = "behavior_baseline";
const BASELINE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BASELINE_ACTIVE_PROBABILITY_THRESHOLD = 0.3;
const BASELINE_SWITCH_POINT_DELTA = 0.1;

type BehaviorSignals = {
  shoppingInterest: number;
  planningInterest: number;
  companionNeed: number;
  privacyConcern: number;
  updatedAt: string;
};

type RelationshipState = {
  warmth: number;
  humorTolerance: number;
  proactiveTolerance: number;
  encouragementNeed: number;
  directnessPreference: number;
  rapport: number;
  lastUpdatedAt: string;
};

type TimeRhythmState = {
  activeHours: Record<string, number>;
  receptiveHours: Record<string, number>;
  weekdayActivity: Record<string, number>;
  weekdayReceptive: Record<string, number>;
  lateNightTolerance: number;
  weekendTolerance: number;
  lastUpdatedAt: string;
};

type BehaviorBaselineSwitchPoint = {
  hour: number;
  direction: "up" | "down";
};

type BehaviorBaselineActivePeriod = {
  start: number;
  end: number;
};

export type BehaviorBaseline = {
  hourlyActivityProbability: number[];
  activePeriods: BehaviorBaselineActivePeriod[];
  switchPoints: BehaviorBaselineSwitchPoint[];
  sampleCount: number;
  lastUpdated: number;
};

type StyleProfileState = {
  banterLevel: number;
  playfulTolerance: number;
  cuteTolerance: number;
  teasingTolerance: number;
  followUpTolerance: number;
  expressiveTolerance: number;
  careStyle: "gentle" | "playful" | "direct";
  motivationStyle: "encouraging" | "steady" | "push";
  initiativeStyle: "reserved" | "balanced" | "proactive";
  lastUpdatedAt: string;
};

type ReplyLengthProfileState = {
  avgUserChars: number;
  shortPreferenceScore: number;
  longPreferenceScore: number;
  recentUserChars: number[];
  sampleCount: number;
  lastUpdatedAt: string;
};
const contactPolicy = new ProactiveContactPolicyService();

const TONE_ZH: Record<PreferredTone, string> = {
  humor: "幽默轻松",
  formal: "正式专业",
  warm: "温馨亲切",
  balanced: "自然均衡",
};

function weekdayKey(date: Date): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()] ?? "unknown";
}

export function isUserPersonalizationEnabled(): boolean {
  const raw = process.env.AGENT_USER_PERSONALIZATION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

function profileLlmEveryNTurns(): number {
  const n = Number.parseInt(process.env.AGENT_USER_PROFILE_LLM_EVERY_N ?? "8", 10);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

function toEmotionState(v: unknown): EmotionState {
  if (!v || typeof v !== "object") return defaultEmotionState();
  const o = v as Record<string, unknown>;
  const recent = Array.isArray(o.recent)
    ? o.recent.filter((x): x is EmotionState["recent"][number] =>
        x === "positive" || x === "neutral" || x === "negative" || x === "stressed",
      )
    : [];
  const preferredTone =
    o.preferredTone === "humor" ||
    o.preferredTone === "formal" ||
    o.preferredTone === "warm" ||
    o.preferredTone === "balanced"
      ? o.preferredTone
      : "balanced";
  return {
    recent: recent.slice(-6),
    preferredTone,
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
    turnCount: Number(o.turnCount) || 0,
  };
}

function defaultBehaviorSignals(): BehaviorSignals {
  return {
    shoppingInterest: 0,
    planningInterest: 0,
    companionNeed: 0,
    privacyConcern: 0,
    updatedAt: new Date().toISOString(),
  };
}

function defaultRelationshipState(): RelationshipState {
  return {
    warmth: 0.5,
    humorTolerance: 0.5,
    proactiveTolerance: 0.5,
    encouragementNeed: 0.4,
    directnessPreference: 0.5,
    rapport: 0.35,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultTimeRhythmState(): TimeRhythmState {
  return {
    activeHours: {},
    receptiveHours: {},
    weekdayActivity: {},
    weekdayReceptive: {},
    lateNightTolerance: 0.35,
    weekendTolerance: 0.45,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultStyleProfileState(): StyleProfileState {
  return {
    banterLevel: 0.4,
    playfulTolerance: 0.45,
    cuteTolerance: 0.35,
    teasingTolerance: 0.32,
    followUpTolerance: 0.48,
    expressiveTolerance: 0.42,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultReplyLengthProfileState(): ReplyLengthProfileState {
  return {
    avgUserChars: 36,
    shortPreferenceScore: 0,
    longPreferenceScore: 0,
    recentUserChars: [],
    sampleCount: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function toContactPreferenceState(v: unknown): ProactiveContactPreferenceState {
  if (!v || typeof v !== "object") return defaultContactPreferenceState();
  const o = v as Record<string, unknown>;
  const channelAffinityRaw =
    o.channelAffinity && typeof o.channelAffinity === "object"
      ? (o.channelAffinity as Record<string, unknown>)
      : {};
  const channelAffinity = {
    websocket: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.websocket) || 0.62)),
    voice: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.voice) || 0.46)),
    phone_call: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.phone_call) || 0.3)),
  };
  return {
    channelAffinity,
    quietHoursStart: Math.min(23, Math.max(0, Number(o.quietHoursStart) || 23)),
    quietHoursEnd: Math.min(23, Math.max(0, Number(o.quietHoursEnd) || 8)),
    maxDailyProactiveContacts: Math.min(
      12,
      Math.max(2, Number(o.maxDailyProactiveContacts) || 6),
    ),
    voiceUrgencyThreshold: Math.min(9, Math.max(5.5, Number(o.voiceUrgencyThreshold) || 6.6)),
    phoneUrgencyThreshold: Math.min(9.7, Math.max(7.8, Number(o.phoneUrgencyThreshold) || 8.7)),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function toRelationshipState(v: unknown): RelationshipState {
  if (!v || typeof v !== "object") return defaultRelationshipState();
  const o = v as Record<string, unknown>;
  const clamp = (n: unknown, fallback: number) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.min(1, Math.max(0, x));
  };
  return {
    warmth: clamp(o.warmth, 0.5),
    humorTolerance: clamp(o.humorTolerance, 0.5),
    proactiveTolerance: clamp(o.proactiveTolerance, 0.5),
    encouragementNeed: clamp(o.encouragementNeed, 0.4),
    directnessPreference: clamp(o.directnessPreference, 0.5),
    rapport: clamp(o.rapport, 0.35),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function toTimeRhythmState(v: unknown): TimeRhythmState {
  if (!v || typeof v !== "object") return defaultTimeRhythmState();
  const o = v as Record<string, unknown>;
  const asNumMap = (value: unknown): Record<string, number> =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {};
  return {
    activeHours: asNumMap(o.activeHours),
    receptiveHours: asNumMap(o.receptiveHours),
    weekdayActivity: asNumMap(o.weekdayActivity),
    weekdayReceptive: asNumMap(o.weekdayReceptive),
    lateNightTolerance: Math.min(1, Math.max(0, Number(o.lateNightTolerance) || 0.35)),
    weekendTolerance: Math.min(1, Math.max(0, Number(o.weekendTolerance) || 0.45)),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function defaultBehaviorBaseline(): BehaviorBaseline {
  return {
    hourlyActivityProbability: Array.from({ length: 24 }, () => 0),
    activePeriods: [],
    switchPoints: [],
    sampleCount: 0,
    lastUpdated: 0,
  };
}

function toBehaviorBaseline(v: unknown): BehaviorBaseline {
  if (!v || typeof v !== "object") return defaultBehaviorBaseline();
  const o = v as Record<string, unknown>;
  const probRaw = Array.isArray(o.hourlyActivityProbability)
    ? o.hourlyActivityProbability
    : [];
  const hourlyActivityProbability = Array.from({ length: 24 }, (_, h) => {
    const n = Number(probRaw[h]);
    return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : 0;
  });
  const activePeriods: BehaviorBaselineActivePeriod[] = Array.isArray(o.activePeriods)
    ? o.activePeriods
        .map((p): BehaviorBaselineActivePeriod | null => {
          if (!p || typeof p !== "object") return null;
          const pe = p as Record<string, unknown>;
          const startRaw = Number(pe.start);
          const endRaw = Number(pe.end);
          if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return null;
          const start = Math.min(23, Math.max(0, Math.floor(startRaw)));
          const end = Math.min(23, Math.max(0, Math.floor(endRaw)));
          return { start, end: Math.max(end, start) };
        })
        .filter((p): p is BehaviorBaselineActivePeriod => p !== null)
    : [];
  const switchPoints: BehaviorBaselineSwitchPoint[] = Array.isArray(o.switchPoints)
    ? o.switchPoints
        .map((p): BehaviorBaselineSwitchPoint | null => {
          if (!p || typeof p !== "object") return null;
          const pe = p as Record<string, unknown>;
          const hourRaw = Number(pe.hour);
          if (!Number.isFinite(hourRaw)) return null;
          const direction: "up" | "down" =
            pe.direction === "up" ? "up" : pe.direction === "down" ? "down" : "up";
          return { hour: Math.min(23, Math.max(0, Math.floor(hourRaw))), direction };
        })
        .filter((p): p is BehaviorBaselineSwitchPoint => p !== null)
    : [];
  const sampleCountRaw = Number(o.sampleCount);
  const lastUpdatedRaw = Number(o.lastUpdated);
  return {
    hourlyActivityProbability,
    activePeriods,
    switchPoints,
    sampleCount: Number.isFinite(sampleCountRaw) && sampleCountRaw >= 0 ? sampleCountRaw : 0,
    lastUpdated: Number.isFinite(lastUpdatedRaw) && lastUpdatedRaw >= 0 ? lastUpdatedRaw : 0,
  };
}

function buildBaselineFromRhythm(rhythm: TimeRhythmState): BehaviorBaseline {
  const hourlyCounts = Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, "0");
    return rhythm.activeHours[key] ?? 0;
  });
  const rawTotal = hourlyCounts.reduce((a, b) => a + b, 0);
  const total = rawTotal > 0 ? rawTotal : 1;
  const hourlyActivityProbability = hourlyCounts.map((c) => c / total);

  const activePeriods: BehaviorBaselineActivePeriod[] = [];
  let periodStart: number | null = null;
  for (let h = 0; h < 24; h++) {
    const active = hourlyActivityProbability[h] > BASELINE_ACTIVE_PROBABILITY_THRESHOLD;
    if (active && periodStart === null) {
      periodStart = h;
    } else if (!active && periodStart !== null) {
      activePeriods.push({ start: periodStart, end: h - 1 });
      periodStart = null;
    }
  }
  if (periodStart !== null) {
    activePeriods.push({ start: periodStart, end: 23 });
  }

  const switchPoints: BehaviorBaselineSwitchPoint[] = [];
  for (let h = 1; h < 24; h++) {
    const diff = hourlyActivityProbability[h] - hourlyActivityProbability[h - 1];
    if (Math.abs(diff) > BASELINE_SWITCH_POINT_DELTA) {
      switchPoints.push({ hour: h, direction: diff > 0 ? "up" : "down" });
    }
  }

  return {
    hourlyActivityProbability,
    activePeriods,
    switchPoints,
    sampleCount: rawTotal,
    lastUpdated: Date.now(),
  };
}

function toStyleProfileState(v: unknown): StyleProfileState {
  if (!v || typeof v !== "object") return defaultStyleProfileState();
  const o = v as Record<string, unknown>;
  const clamp = (n: unknown, fallback: number) =>
    Math.min(1, Math.max(0, Number(n) || fallback));
  return {
    banterLevel: clamp(o.banterLevel, 0.4),
    playfulTolerance: clamp(o.playfulTolerance, 0.45),
    cuteTolerance: clamp(o.cuteTolerance, 0.35),
    teasingTolerance: clamp(o.teasingTolerance, 0.32),
    followUpTolerance: clamp(o.followUpTolerance, 0.48),
    expressiveTolerance: clamp(o.expressiveTolerance, 0.42),
    careStyle:
      o.careStyle === "playful" || o.careStyle === "direct" ? o.careStyle : "gentle",
    motivationStyle:
      o.motivationStyle === "encouraging" || o.motivationStyle === "push"
        ? o.motivationStyle
        : "steady",
    initiativeStyle:
      o.initiativeStyle === "reserved" || o.initiativeStyle === "proactive"
        ? o.initiativeStyle
        : "balanced",
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function detectDynamicStyleSignals(userText: string): {
  playful: number;
  cute: number;
  teasing: number;
  followUp: number;
  expressive: number;
} {
  const text = userText.trim();
  return {
    playful:
      /(搞笑|幽默|逗|贫|皮一点|别太端着|松弛一点|活一点|梗|好玩|哈哈|笑死|乐了)/i.test(text)
        ? 0.14
        : 0,
    cute:
      /(卖萌|可爱一点|软一点|奶一点|撒娇|萌一点|乖一点)/i.test(text)
        ? 0.14
        : 0,
    teasing:
      /(损我|吐槽|内涵|阴阳|怼|别太正经|调侃我|嘴我两句)/i.test(text)
        ? 0.12
        : 0,
    followUp:
      /(追问|多问一句|继续问我|顺着聊|陪我聊|别只答完就停)/i.test(text)
        ? 0.15
        : 0,
    expressive:
      /[!！~～哈哈嘿嘿哇呀啦捏呗嘛嘞诶欸]|😂|😅|🥹|🤔|😎|🥲/u.test(text)
        ? 0.08
        : 0,
  };
}

/**
 * 对方语感数据行（2026-09-06 替代原 buildAdaptiveStyleGuidance 的 6 条容忍度说教）。
 *
 * 隐性跟随用户 = 给模型"对方现在什么语感"的观察数据，让模型自己模仿，
 * 而不是给"可以调侃/少堆语气词"这类指令腔（说教本身就是机械感来源）。
 * 只描述事实：当前这条消息的长度/情绪符号 + 长期平均长度。无用户消息时不注入。
 */
function buildRegisterMirrorLine(
  userText: string,
  replyLength: ReplyLengthProfileState,
): string | undefined {
  const text = userText.trim();
  if (!text) return undefined;
  const parts: string[] = [];
  const chars = text.replace(/\s+/g, "").length;
  parts.push(`这条约 ${chars} 字`);
  const expressive = /[!！~～哈哈嘿嘿哇呀啦捏呗嘛嘞诶欸]|😂|😅|🥹|🤔|😎|🥲/u.test(text);
  parts.push(expressive ? "带情绪符号、语气松" : "语气平");
  if (replyLength.sampleCount >= 3) {
    parts.push(`长期均约 ${Math.round(replyLength.avgUserChars)} 字`);
  }
  return `对方语感：${parts.join("、")}。`;
}

function relationshipSummaryLine(
  state: RelationshipState,
  replyLength: ReplyLengthProfileState,
  userText?: string,
): string {
  // 极端偏好才提示，默认行为交给【说话方式】稳定层（管家底色/伙伴面），不再重复。
  // 玩笑容忍度改由 buildRegisterKnobLine 的调子旋钮承担（含情绪门控）。
  const lines: string[] = [];
  if (state.directnessPreference >= 0.68) {
    lines.push("用户偏好直接表达，先给结论。");
  }
  const mirror = userText ? buildRegisterMirrorLine(userText, replyLength) : undefined;
  if (mirror) lines.push(mirror);
  return lines.join("\n");
}

/**
 * 调子旋钮（2026-09-11）：【说话方式·伙伴面】调子菜单的当轮放行开关。
 * 只在两端输出——松弛（可调侃/损/阴阳）或收起；中间态返回空串，
 * 走【说话方式】稳定层的默认底色，不占动态 token。
 * 情绪门控优先于容忍度：用户情绪低/压力大时即使平时爱玩梗也收起。
 */
function buildRegisterKnobLine(
  relationship: RelationshipState,
  emotion: EmotionState,
): string {
  const mood = dominantRecentEmotion(emotion.recent);
  if (mood === "negative" || mood === "stressed") {
    return "本轮调子：收着，只沉稳坦诚，不调侃不玩梗。";
  }
  if (relationship.humorTolerance >= 0.7 && relationship.warmth >= 0.55) {
    return "本轮调子：松弛，可调侃、可损、可阴阳，但不冲用户本人。";
  }
  if (relationship.humorTolerance <= 0.35) {
    return "本轮调子：收着，不玩梗不调侃。";
  }
  return "";
}

function toReplyLengthProfileState(v: unknown): ReplyLengthProfileState {
  if (!v || typeof v !== "object") return defaultReplyLengthProfileState();
  const o = v as Record<string, unknown>;
  const recentUserChars = Array.isArray(o.recentUserChars)
    ? o.recentUserChars
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x >= 0)
        .slice(-8)
    : [];
  return {
    avgUserChars: Math.max(1, Number(o.avgUserChars) || 36),
    shortPreferenceScore: Math.max(0, Number(o.shortPreferenceScore) || 0),
    longPreferenceScore: Math.max(0, Number(o.longPreferenceScore) || 0),
    recentUserChars,
    sampleCount: Math.max(0, Number(o.sampleCount) || recentUserChars.length || 0),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

/**
 * 长度偏好归类（供人格静态块适配行）：与 buildReplyLengthGuidance 的长期
 * 判定同阈值；样本不足（<3）返回 undefined——零信号不注入。
 */
export function classifyReplyLengthPreference(
  profile: ReplyLengthProfileState,
): "short" | "medium" | "detailed" | undefined {
  if (profile.sampleCount < 3) return undefined;
  if (
    profile.shortPreferenceScore > profile.longPreferenceScore + 1.2 &&
    profile.avgUserChars <= 28
  ) {
    return "short";
  }
  if (
    profile.longPreferenceScore > profile.shortPreferenceScore + 1.2 &&
    profile.avgUserChars >= 65
  ) {
    return "detailed";
  }
  return "medium";
}

function buildReplyLengthGuidance(userText: string, profile: ReplyLengthProfileState): string {  const text = userText.trim();
  const compactText = text.replace(/\s+/g, "");
  const shortExplicit =
    /(简单说|简短点|短一点|一句话|一两句|别展开|直接说结论|长话短说|太长不看|简洁点)/i.test(text);
  const longExplicit =
    /(详细说|展开说|具体一点|多说点|讲清楚|完整方案|详细分析|一步一步|越详细越好)/i.test(text);
  if (longExplicit) {
    return "本轮长度控制：用户明确要详细，信息给全，但仍先给结论，再展开，避免空话。";
  }
  if (isDirectFactQuery(text)) {
    return "本轮长度控制：这是单一事实查询，默认压到「结论 + 1句依据」；不要重复总结，也不要顺手追问。";
  }
  if (shortExplicit || compactText.length <= 18) {
    return "本轮长度控制：尽量压到 1~2 句，先给结论，没被追问就别展开。";
  }
  if (
    profile.sampleCount >= 3 &&
    profile.shortPreferenceScore > profile.longPreferenceScore + 1.2 &&
    profile.avgUserChars <= 28
  ) {
    return "本轮长度控制：这个用户长期更偏短回复，默认压缩表达，2 句左右优先，非必要不展开。";
  }
  if (
    profile.sampleCount >= 3 &&
    profile.longPreferenceScore > profile.shortPreferenceScore + 1.2 &&
    profile.avgUserChars >= 65
  ) {
    return "本轮长度控制：这个用户长期接受稍展开的说明，可以多给一点上下文，但仍先讲重点。";
  }
  if (compactText.length <= 60) {
    return "本轮长度控制：以短回复为主，2~4 句内解决；只保留必要信息，同一事实不要重复解释两遍。";
  }
  return "本轮长度控制：默认中短回复，先回答核心问题，再按需要补充；避免重复总结、重复铺垫和连续追问。";
}

// timeRhythmSummaryLine / behaviorSummaryLine 已删（2026-09-06 瘦身）：
// 二者只被 getPromptSlice 的 toneGuidance 引用——触达时段/渠道偏好属于主动推送
// 调度信息，与本轮回复风格无关；行为倾向（英文行）语义已被用户理解档案/画像覆盖。
// 底层 State 的学习（applyTimeRhythmSignals / applyBehaviorSignals）保留不变。

function toBehaviorSignals(v: unknown): BehaviorSignals {
  if (!v || typeof v !== "object") return defaultBehaviorSignals();
  const o = v as Record<string, unknown>;
  return {
    shoppingInterest: Number(o.shoppingInterest) || 0,
    planningInterest: Number(o.planningInterest) || 0,
    companionNeed: Number(o.companionNeed) || 0,
    privacyConcern: Number(o.privacyConcern) || 0,
    updatedAt:
      typeof o.updatedAt === "string" && o.updatedAt
        ? o.updatedAt
        : new Date().toISOString(),
  };
}

function detectBehaviorSignals(userText: string): Partial<BehaviorSignals> {
  const t = userText.toLowerCase();
  return {
    shoppingInterest:
      /(buy|shopping|price|deal|discount|coupon|amazon|walmart|costco|购买|比价|优惠|省钱)/i.test(t)
        ? 1
        : 0,
    planningInterest:
      /(plan|schedule|calendar|todo|reminder|deadline|安排|计划|日程|提醒|待办)/i.test(t)
        ? 1
        : 0,
    companionNeed:
      /(chat with me|talk to me|陪我|陪伴|孤独|lonely|support me|安慰)/i.test(t) ? 1 : 0,
    privacyConcern:
      /(privacy|private|data|delete|export|gdpr|ccpa|隐私|删除数据|导出数据)/i.test(t)
        ? 1
        : 0,
  };
}

function contactPreferenceSummaryLine(
  preference: ProactiveContactPreferenceState,
  rhythm: TimeRhythmState,
): string {
  const rankedChannels = Object.entries(preference.channelAffinity)
    .sort((a, b) => b[1] - a[1])
    .map(([channel]) => channel)
    .slice(0, 2)
    .join(", ");
  return `Preferred proactive contact: ${rankedChannels}; quiet hours ${String(preference.quietHoursStart).padStart(2, "0")}:00-${String(preference.quietHoursEnd).padStart(2, "0")}:00; daily contact budget ${preference.maxDailyProactiveContacts}; late-night tolerance ${rhythm.lateNightTolerance.toFixed(2)}.`;
}

export type PersonalizationPromptSlice = {
  userProfile?: string;
  toneGuidance?: string;
  relationshipGuidance?: string;
  /** 关系亲密度（0~1）：人格模块换算关系档位（persona-core.resolveRelationshipTier） */
  rapport?: number;
  /** 学到的调侃容忍度（0~1）：人格 mood 档 gate + 静态块适配行 */
  humorTolerance?: number;
  /** 学到的语气偏好（EmotionState.preferredTone）：静态块适配行 */
  preferredTone?: "humor" | "formal" | "warm" | "balanced";
  /** 学到的回复长度倾向：静态块适配行（样本不足时缺省） */
  lengthPreference?: "short" | "medium" | "detailed";
};

export type PersonalizationRelationshipState = ReturnType<typeof toRelationshipState>;
export type PersonalizationBehaviorSignals = ReturnType<typeof toBehaviorSignals>;
export type PersonalizationTimeRhythmState = ReturnType<typeof toTimeRhythmState>;
export type PersonalizationStyleProfileState = ReturnType<typeof toStyleProfileState>;
export type PersonalizationContactPreferenceState = ReturnType<typeof toContactPreferenceState>;
export type PersonalizationReplyLengthProfileState = ReturnType<typeof toReplyLengthProfileState>;
export type PersonalizationUnderstandingSnapshot = {
  relationship: PersonalizationRelationshipState;
  behavior: PersonalizationBehaviorSignals;
  timeRhythm: PersonalizationTimeRhythmState;
  styleProfile: PersonalizationStyleProfileState;
  contactPreference: PersonalizationContactPreferenceState;
  replyLengthProfile: PersonalizationReplyLengthProfileState;
  contactSummary: string;
};

/**
 * MemoryCortex 最小化外观接口（仅暴露人格内核读写，避免循环依赖）。
 *
 * UserPersonalizationService 通过此接口在 observeTurnAsync 中驱动 PersonalityAdjuster，
 * 后者调用 getPersonalityCore / setPersonalityCore 完成人格微调。
 */
interface MemoryCortexLike {
  getPersonalityCore(actorId: string): PersonalityCore;
  setPersonalityCore(actorId: string, core: PersonalityCore): void;
}

/** 把 EmotionRecognitionService 的细粒度中文标签映射回粗粒度 EmotionLabel */
function fineEmotionToCoarse(fineLabel: string): EmotionLabel {
  switch (fineLabel) {
    case "开心":
    case "兴奋":
    case "感激":
      return "positive";
    case "悲伤":
    case "愤怒":
      return "negative";
    case "焦虑":
      return "stressed";
    default:
      return "neutral";
  }
}

/** 根据细粒度情绪标签推断偏好语气（仅高置信度时覆盖） */
function inferPreferredToneFromFineEmotion(fineLabel: string): PreferredTone | null {
  switch (fineLabel) {
    case "悲伤":
    case "焦虑":
    case "疲惫":
      return "warm";
    case "开心":
    case "兴奋":
    case "感激":
      return "humor";
    case "愤怒":
      return "balanced";
    default:
      return null;
  }
}

export class UserPersonalizationService {
  private readonly store = new UserProfileStore();
  private readonly fallbackState = new Map<string, unknown>();
  /** 情绪识别服务（L1 规则 + L2 LLM mini） */
  private readonly emotionRecognition: EmotionRecognitionService;
  /** 人格自适应微调器（纯规则，clamp ±30%） */
  private readonly personalityAdjuster: PersonalityAdjuster;
  /** MemoryCortex 引用，用于人格内核读写（registerMemoryCortex 注入） */
  private memoryCortex: MemoryCortexLike | null = null;
  /**
   * 关系状态观察者（2026-10-20，Life Model P1）：每轮 applyRelationshipSignals 更新
   * warmth/rapport 后回调，供 RelationshipGraphService 做规则化里程碑检测并收敛为
   * self_agent 边（零 LLM）。装配层注入；未注入时不回调。
   */
  private relationshipStateObserver:
    | ((actorId: string, state: { warmth: number; rapport: number }) => void)
    | null = null;
  /** 触达结果外发监听（Task 20 节律引擎桥接，registerContactOutcomeListener 注入） */
  private contactOutcomeListener:
    | ((actorId: string, params: { responded: boolean; feedback?: string; at: Date }) => void)
    | null = null;

  constructor(
    private readonly memory: AgentMemorySyncService | null,
    private readonly externalChat: ExternalChatProvider | null = null,
  ) {
    this.emotionRecognition = new EmotionRecognitionService(this.externalChat);
    this.personalityAdjuster = new PersonalityAdjuster();
  }

  /** 注入 MemoryCortex 引用，激活人格自适应微调闭环 */
  registerMemoryCortex(mc: MemoryCortexLike): void {
    this.memoryCortex = mc;
  }

  /** 注入关系状态观察者（Life Model 收敛：里程碑检测 + self_agent 边）。 */
  setRelationshipStateObserver(
    cb: ((actorId: string, state: { warmth: number; rapport: number }) => void) | null,
  ): void {
    this.relationshipStateObserver = cb;
  }

  async getPromptSlice(actorId: string, userText?: string): Promise<PersonalizationPromptSlice> {
    if (!isUserPersonalizationEnabled()) return {};
    let state = this.loadEmotionState(actorId);
    let behavior = this.loadBehaviorSignals(actorId);
    let relationship = this.loadRelationshipState(actorId);
    let rhythm = this.loadTimeRhythmState(actorId);
    let style = this.loadStyleProfileState(actorId);
    let replyLength = this.loadReplyLengthProfileState(actorId);
    if (userText?.trim()) {
      // 各 apply* 承担状态学习（副作用），即使产出不再渲染也保留调用，
      // 保证风格/节奏画像持续演化
      state = this.applyUserSignals(actorId, userText, state);
      behavior = this.applyBehaviorSignals(actorId, userText, behavior);
      relationship = this.applyRelationshipSignals(actorId, userText, relationship, state, behavior);
      // 关系状态 → 生活模型收敛（规则化里程碑检测，零 LLM；装配层注入观察者）
      try {
        this.relationshipStateObserver?.(actorId, {
          warmth: relationship.warmth,
          rapport: relationship.rapport,
        });
      } catch {
        /* 观察者失败不影响个性化主流程 */
      }
      rhythm = this.applyTimeRhythmSignals(actorId, rhythm);
      style = this.applyStyleProfile(actorId, userText, relationship, behavior, style);
      replyLength = this.applyReplyLengthProfile(actorId, userText, replyLength);
    }
    const profile = await this.store.read(actorId);
    const maxChars = Number.parseInt(process.env.AGENT_USER_PROFILE_PROMPT_MAX_CHARS ?? "3500", 10);
    const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 3500;
    // 结构感知截断：超长时先丢备注/兴趣等次要 section，绝不丢【基本信息】里的姓名/所在地
    // 模板画像（无任何真实事实）不注入：省 token 且不给 LLM 喂「待了解」占位噪声
    const userProfile = hasRealProfileContent(profile) ? truncateProfileForPrompt(profile, cap) : undefined;
    // 2026-09-06 瘦身：toneGuidance 只保留本轮长度控制 + 情绪语气（有显著情绪才多行）。
    // 删除：基础回复纪律（与【说话方式】稳定层基准重复）、触达时段/渠道/行为倾向/事实摘要
    // （与回复风格无关或已有独立块）。风格基准单点在 prompt-assembler 的【说话方式】块。
    // 2026-09-11：relationshipGuidance 前置调子旋钮（伙伴面调子的当轮放行开关）。
    return {
      userProfile,
      rapport: relationship.rapport,
      humorTolerance: relationship.humorTolerance,
      preferredTone: state.preferredTone,
      lengthPreference: classifyReplyLengthPreference(replyLength),
      toneGuidance: [
        userText?.trim() ? buildReplyLengthGuidance(userText, replyLength) : undefined,
        buildToneGuidance(state),
      ].filter(Boolean).join("\n"),
      relationshipGuidance: [
        buildRegisterKnobLine(relationship, state),
        relationshipSummaryLine(relationship, replyLength, userText),
      ].filter(Boolean).join("\n"),
    };
  }

  /**
   * chat 面轻量切片（2026-09-29 画像接通对话面）：只读文件画像，零副作用——
   * 不走 getPromptSlice 的 apply* 状态学习序列（那些由 finalizeTurn 的
   * observeTurn 每轮承担，chat 面再跑一遍会双写）；语气仍由 mood/风格闸单点管，
   * 不注入 toneGuidance/relationshipGuidance（避免双头）。
   * 模板画像（无真实事实）返回空切片，不占 token。
   */
  async getProfileOnlySlice(actorId: string): Promise<PersonalizationPromptSlice> {
    if (!isUserPersonalizationEnabled()) return {};
    const profile = await this.store.read(actorId);
    if (!hasRealProfileContent(profile)) return {};
    const maxChars = Number.parseInt(process.env.AGENT_USER_PROFILE_PROMPT_MAX_CHARS ?? "3500", 10);
    const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 3500;
    return { userProfile: truncateProfileForPrompt(profile, cap) };
  }

  getRelationshipState(actorId: string): PersonalizationRelationshipState {
    return this.loadRelationshipState(actorId);
  }

  getBehaviorSignals(actorId: string): PersonalizationBehaviorSignals {
    return this.loadBehaviorSignals(actorId);
  }

  getTimeRhythmState(actorId: string): PersonalizationTimeRhythmState {
    return this.loadTimeRhythmState(actorId);
  }

  /**
   * 回填 LifeRhythmEngine 学到的按小时触达接受度（Task 20 出口 B）。
   *
   * 引擎给的是 0..1 归一化分数，而本服务的 receptiveHours 是"该小时用户
   * 在场且 receptive 的累计次数"（ContactPolicy 按相对大小消费）。直接覆写
   * 会破坏量纲——这里把两套分布各自归一化后按 0.6/0.4 加权混合，再按当前
   * 总量重新标定回计数尺度，保证与既有消费方语义兼容。
   */
  applyLearnedReceptivity(actorId: string, learnedByHour: Record<string, number>): void {
    const current = this.loadTimeRhythmState(actorId);
    const normalize = (map: Record<string, number>): number[] => {
      const arr = new Array<number>(24).fill(0);
      let total = 0;
      for (let h = 0; h < 24; h++) {
        const v = Number(map[String(h)]) || 0;
        arr[h] = v;
        total += v;
      }
      if (total <= 0) return arr;
      return arr.map((v) => v / total);
    };
    const learned = normalize(learnedByHour);
    const existing = normalize(current.receptiveHours);
    const blended = learned.map((v, h) => v * 0.6 + existing[h]! * 0.4);
    const total = blended.reduce((sum, v) => sum + v, 0);
    const scale = total > 0 ? Math.max(24, Object.values(current.receptiveHours).reduce((s, v) => s + v, 0)) / total : 0;
    const next: TimeRhythmState = {
      ...current,
      receptiveHours: Object.fromEntries(blended.map((v, h) => [String(h), Math.round(v * scale)])),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_TIME_RHYTHM_KEY, next);
  }

  /**
   * 注册触达结果外发监听（Task 20：桥接到 LifeRhythmEngine.recordContactOutcome）。
   * 只暴露最小参数面，不影响既有 observeContactOutcome 调用方。
   */
  registerContactOutcomeListener(
    listener: (actorId: string, params: { responded: boolean; feedback?: string; at: Date }) => void,
  ): void {
    this.contactOutcomeListener = listener;
  }

  getBehaviorBaseline(actorId: string): BehaviorBaseline {
    return this.loadBehaviorBaseline(actorId);
  }

  getStyleProfileState(actorId: string): PersonalizationStyleProfileState {
    return this.loadStyleProfileState(actorId);
  }

  getContactPreferenceState(actorId: string): PersonalizationContactPreferenceState {
    return this.loadContactPreferenceState(actorId);
  }

  observeContactOutcome(
    actorId: string,
    params: {
      channel: ProactiveContactChannel;
      responded: boolean;
      responseTimeMs?: number;
      feedback?: "positive" | "negative" | "neutral";
      quietHours?: boolean;
    },
  ): void {
    const current = this.loadContactPreferenceState(actorId);
    const next = contactPolicy.learnPreference(current, params);
    this.saveJsonState(actorId, USER_CONTACT_PREFERENCE_KEY, next);
    this.contactOutcomeListener?.(actorId, {
      responded: params.responded,
      feedback: params.feedback,
      at: new Date(),
    });
  }

  getUnderstandingSnapshot(actorId: string): PersonalizationUnderstandingSnapshot {
    const relationship = this.loadRelationshipState(actorId);
    const behavior = this.loadBehaviorSignals(actorId);
    const timeRhythm = this.loadTimeRhythmState(actorId);
    const styleProfile = this.loadStyleProfileState(actorId);
    const contactPreference = this.loadContactPreferenceState(actorId);
    const replyLengthProfile = this.loadReplyLengthProfileState(actorId);
    return {
      relationship,
      behavior,
      timeRhythm,
      styleProfile,
      contactPreference,
      replyLengthProfile,
      contactSummary: contactPreferenceSummaryLine(contactPreference, timeRhythm),
    };
  }

  observeTurn(actorId: string, userText: string, assistantText: string): void {
    if (!isUserPersonalizationEnabled()) return;
    void this.observeTurnAsync(actorId, userText, assistantText).catch(() => {});
  }

  /**
   * 是否由聚合器（UserProfileAggregator）承担 USER_PROFILE.md 的画像事实写入。
   * 由 bootstrap 注入；为 true 时本服务不再走正则 patches 与周期性 LLM 整文件重写，
   * 避免与聚合器的 LLM 结构化抽取互相覆盖（旧正则曾把「我叫什么？」的
   * 疑问词"什么"写成称呼，污染画像）。
   */
  private profileWritesDelegatedToAggregator = false;

  setProfileWritesDelegatedToAggregator(delegated: boolean): void {
    this.profileWritesDelegatedToAggregator = delegated;
  }

  private async observeTurnAsync(actorId: string, userText: string, assistantText: string): Promise<void> {
    const md = await this.store.read(actorId);
    let nextMd = md;
    if (!this.profileWritesDelegatedToAggregator) {
      const patches = extractProfilePatches(userText);
      if (patches.length > 0) nextMd = applyProfilePatches(nextMd, patches);
    }
    let state = this.loadEmotionState(actorId);
    nextMd = syncPreferredToneInProfile(nextMd, TONE_ZH[state.preferredTone]);
    // 单一权威源：档案字段行以结构化事实库为准（投影后再落盘/KV，避免两处两个值）
    nextMd = await this.projectProfileFieldAuthority(actorId, nextMd);
    // 内容无变化则跳过文件写，缩小与聚合器（LLM 抽取）read-modify-write 的竞态窗口；
    // KV 副本仍同步，保证 prompt 后备基底与最新画像一致。
    if (nextMd !== md) await this.store.write(actorId, nextMd);
    this.syncProfileKv(actorId, nextMd);
    this.updateFactStore(actorId, userText);
    this.learnFromAssistantStyle(actorId, assistantText);

    // ---- 情绪识别簇集成 ----
    // 用 EmotionRecognitionService（L1 规则 + L2 LLM mini）做更精细的情绪识别，
    // 高置信度时回写粗粒度 EmotionLabel 并推断 preferredTone。
    if (userText.trim()) {
      try {
        const result = await this.emotionRecognition.recognize(actorId, userText, {
          recentEmotions: state.recent,
        });
        if ((result.emotion.confidence ?? 0) >= 0.6) {
          const coarseLabel = fineEmotionToCoarse(result.emotion.label);
          // 替换最近一条情绪（不额外 increment turnCount，因 applyUserSignals 已 +1）
          if (state.recent.length > 0 && state.recent[state.recent.length - 1] !== coarseLabel) {
            state = {
              ...state,
              recent: [...state.recent.slice(0, -1), coarseLabel],
              lastUpdatedAt: new Date().toISOString(),
            };
            this.saveEmotionState(actorId, state);
          }
          // 高置信度情绪推断 preferredTone
          const inferredTone = inferPreferredToneFromFineEmotion(result.emotion.label);
          if (inferredTone && inferredTone !== state.preferredTone) {
            state = { ...state, preferredTone: inferredTone };
            this.saveEmotionState(actorId, state);
          }
        }
      } catch {
        // 情绪识别失败不阻塞主流程
      }
    }

    // ---- 人格簇集成 ----
    // 每 N turn 触发 PersonalityAdjuster 微调 MemoryCortex.personalityCache
    if (this.memoryCortex && state.turnCount > 0) {
      const relationship = this.loadRelationshipState(actorId);
      const style = this.loadStyleProfileState(actorId);
      const input: PersonalityAdjustmentInput = {
        relationship,
        style,
        preferredTone: state.preferredTone,
        turnCount: state.turnCount,
      };
      const adjusted = this.personalityAdjuster.tryAdjust(
        actorId,
        input,
        () => this.memoryCortex!.getPersonalityCore(actorId),
        (core) => this.memoryCortex!.setPersonalityCore(actorId, core),
      );
      if (adjusted) {
        console.log(`[UserPersonalization] 人格微调已应用: actor=${actorId}, turn=${state.turnCount}`);
      }
    }

    const everyN = profileLlmEveryNTurns();
    // 画像事实写入已交给聚合器的每轮 LLM 结构化抽取时，
    // 不再做周期性 LLM 整文件重写（避免与增量抽取互相覆盖）。
    if (
      !this.profileWritesDelegatedToAggregator &&
      everyN > 0 &&
      state.turnCount > 0 &&
      state.turnCount % everyN === 0
    ) {
      await this.refineProfileWithLlm(actorId, userText, nextMd);
    }
  }

  private learnFromAssistantStyle(actorId: string, assistantText: string): void {
    const text = assistantText.trim();
    if (!text) return;
    const current = this.loadStyleProfileState(actorId);
    const next: StyleProfileState = {
      ...current,
      followUpTolerance: Math.min(
        1,
        Math.max(0, current.followUpTolerance * 0.98 + (/[?？]$/u.test(text) ? 0.02 : 0)),
      ),
      expressiveTolerance: Math.min(
        1,
        Math.max(0, current.expressiveTolerance * 0.98 + (/[!！~～]|😂|😅|🥹|🤔|😎|🥲/u.test(text) ? 0.02 : 0)),
      ),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_STYLE_PROFILE_KEY, next);
  }

  private applyUserSignals(actorId: string, userText: string, state: EmotionState): EmotionState {
    const emotion = detectEmotionFromText(userText);
    let next = pushEmotion(state, emotion);
    const tone = detectPreferredToneFromText(userText);
    if (tone) next = { ...next, preferredTone: tone };
    this.saveEmotionState(actorId, next);
    return next;
  }

  private loadEmotionState(actorId: string): EmotionState {
    return toEmotionState(this.readState(actorId, EMOTION_STATE_KEY));
  }

  private loadFactStore(actorId: string) {
    return toFactStore(this.readState(actorId, USER_PROFILE_FACTS_KEY));
  }

  private loadRelationshipState(actorId: string): RelationshipState {
    return toRelationshipState(this.readState(actorId, USER_RELATIONSHIP_KEY));
  }

  private loadTimeRhythmState(actorId: string): TimeRhythmState {
    return toTimeRhythmState(this.readState(actorId, USER_TIME_RHYTHM_KEY));
  }

  private loadStyleProfileState(actorId: string): StyleProfileState {
    return toStyleProfileState(this.readState(actorId, USER_STYLE_PROFILE_KEY));
  }

  private loadContactPreferenceState(actorId: string): ProactiveContactPreferenceState {
    return toContactPreferenceState(this.readState(actorId, USER_CONTACT_PREFERENCE_KEY));
  }

  private loadReplyLengthProfileState(actorId: string): ReplyLengthProfileState {
    return toReplyLengthProfileState(this.readState(actorId, USER_REPLY_LENGTH_PROFILE_KEY));
  }

  private applyRelationshipSignals(
    actorId: string,
    userText: string,
    current: RelationshipState,
    emotion: EmotionState,
    behavior: BehaviorSignals,
  ): RelationshipState {
    const text = userText.toLowerCase();
    const dynamic = detectDynamicStyleSignals(userText);
    const humorBoost = /(调侃|开玩笑|搞笑|幽默|逗我|别太严肃|轻松一点|humor)/i.test(text) ? 0.12 : 0;
    const warmthBoost = /(安慰|鼓励|陪我|温柔|耐心|温暖|辛苦了|谢谢你)/i.test(text) ? 0.12 : 0;
    const directnessBoost = /(直接点|别绕|简短|一句话|别啰嗦|straight|direct)/i.test(text) ? 0.12 : 0;
    const proactiveBoost = behavior.planningInterest > 0 || behavior.companionNeed > 0 ? 0.08 : 0;
    const stressPenalty = emotion.recent.includes("stressed") || emotion.recent.includes("negative") ? 0.08 : 0;
    const rapportBoost = humorBoost * 0.45 + warmthBoost * 0.4 + proactiveBoost * 0.25 + (behavior.companionNeed > 0 ? 0.03 : 0);
    const next: RelationshipState = {
      warmth: Math.min(1, Math.max(0, current.warmth + warmthBoost - stressPenalty / 2)),
      humorTolerance: Math.min(1, Math.max(0, current.humorTolerance + humorBoost - stressPenalty / 2)),
      proactiveTolerance: Math.min(1, Math.max(0, current.proactiveTolerance + proactiveBoost - stressPenalty)),
      encouragementNeed: Math.min(1, Math.max(0, current.encouragementNeed + stressPenalty + (behavior.companionNeed > 0 ? 0.05 : 0))),
      directnessPreference: Math.min(1, Math.max(0, current.directnessPreference + directnessBoost)),
      rapport: Math.min(1, Math.max(0, current.rapport + rapportBoost - stressPenalty / 3)),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_RELATIONSHIP_KEY, next);
    return next;
  }

  private applyTimeRhythmSignals(actorId: string, current: TimeRhythmState): TimeRhythmState {
    const now = new Date();
    const hour = String(now.getHours()).padStart(2, "0");
    const day = weekdayKey(now);
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    const next: TimeRhythmState = {
      activeHours: { ...current.activeHours, [hour]: (current.activeHours[hour] ?? 0) + 1 },
      receptiveHours: { ...current.receptiveHours, [hour]: (current.receptiveHours[hour] ?? 0) + 1 },
      weekdayActivity: { ...current.weekdayActivity, [day]: (current.weekdayActivity[day] ?? 0) + 1 },
      weekdayReceptive: { ...current.weekdayReceptive, [day]: (current.weekdayReceptive[day] ?? 0) + 1 },
      lateNightTolerance:
        now.getHours() >= 23 || now.getHours() <= 2 ? Math.min(1, current.lateNightTolerance + 0.02) : current.lateNightTolerance,
      weekendTolerance: weekend ? Math.min(1, current.weekendTolerance + 0.02) : current.weekendTolerance,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_TIME_RHYTHM_KEY, next);
    this.maybeRefreshBehaviorBaseline(actorId, next);
    return next;
  }

  private loadBehaviorBaseline(actorId: string): BehaviorBaseline {
    return toBehaviorBaseline(this.readState(actorId, USER_BEHAVIOR_BASELINE_KEY));
  }

  private saveBehaviorBaseline(actorId: string, baseline: BehaviorBaseline): void {
    this.saveJsonState(actorId, USER_BEHAVIOR_BASELINE_KEY, baseline);
  }

  private maybeRefreshBehaviorBaseline(actorId: string, rhythm: TimeRhythmState): void {
    const baseline = this.loadBehaviorBaseline(actorId);
    if (Date.now() - baseline.lastUpdated <= BASELINE_REFRESH_INTERVAL_MS) return;
    const refreshed = buildBaselineFromRhythm(rhythm);
    this.saveBehaviorBaseline(actorId, refreshed);
  }

  private applyStyleProfile(
    actorId: string,
    userText: string,
    relationship: RelationshipState,
    behavior: BehaviorSignals,
    current: StyleProfileState,
  ): StyleProfileState {
    const text = userText.toLowerCase();
    const dynamic = detectDynamicStyleSignals(userText);
    const humorLift = Math.max(0, relationship.humorTolerance - 0.5);
    const warmthLift = Math.max(0, relationship.warmth - 0.5);
    const rapportLift = Math.max(0, relationship.rapport - 0.5);
    const directLift = Math.max(0, relationship.directnessPreference - 0.5);
    const next: StyleProfileState = {
      banterLevel: Math.min(
        1,
        Math.max(
          0,
          current.banterLevel * 0.92 +
            humorLift * 0.08 +
            rapportLift * 0.05 +
            dynamic.playful * 0.5 -
            directLift * 0.03,
        ),
      ),
      playfulTolerance: Math.min(
        1,
        Math.max(
          0,
          current.playfulTolerance * 0.94 + dynamic.playful + humorLift * 0.05 + rapportLift * 0.03,
        ),
      ),
      cuteTolerance: Math.min(
        1,
        Math.max(
          0,
          current.cuteTolerance * 0.94 +
            dynamic.cute +
            (/(?:\u53ef\u7231|\u5356\u840c|\u840c)/i.test(userText) ? 0.04 : 0) +
            warmthLift * 0.03,
        ),
      ),
      teasingTolerance: Math.min(
        1,
        Math.max(
          0,
          current.teasingTolerance * 0.95 +
            dynamic.teasing +
            (relationship.rapport > 0.55 ? 0.03 : 0) +
            humorLift * 0.03 -
            Math.max(0, relationship.encouragementNeed - 0.55) * 0.04,
        ),
      ),
      followUpTolerance: Math.min(
        1,
        Math.max(
          0,
          current.followUpTolerance * 0.95 +
            dynamic.followUp +
            (behavior.companionNeed > 0 ? 0.04 : 0) +
            (behavior.planningInterest > 0 ? 0.02 : 0),
        ),
      ),
      expressiveTolerance: Math.min(
        1,
        Math.max(
          0,
          current.expressiveTolerance * 0.94 + dynamic.expressive + warmthLift * 0.05 + rapportLift * 0.02,
        ),
      ),
      careStyle:
        /(?:\u5b89\u6170|\u6e29\u67d4|\u966a\u6211|\u6162\u4e00\u70b9)/i.test(userText)
          ? 'gentle'
          : ((relationship.humorTolerance > 0.7 && relationship.rapport > 0.6) ||
                current.playfulTolerance > 0.6 ||
                dynamic.playful > 0.1) &&
              relationship.encouragementNeed < 0.78
            ? 'playful'
            : relationship.directnessPreference > 0.7
              ? 'direct'
              : current.careStyle,
      motivationStyle:
        /(?:\u9f13\u52b1|\u6253\u6c14|\u5938\u6211)/i.test(userText)
          ? 'encouraging'
          : /(?:\u50ac\u6211|\u63a8\u6211|\u76ef\u7740\u6211)/i.test(userText)
            ? 'push'
            : current.motivationStyle,
      initiativeStyle:
        relationship.proactiveTolerance > 0.7 || behavior.planningInterest > 4
          ? 'proactive'
          : relationship.proactiveTolerance < 0.4
            ? 'reserved'
            : 'balanced',
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_STYLE_PROFILE_KEY, next);
    return next;
  }

  private applyReplyLengthProfile(
    actorId: string,
    userText: string,
    current: ReplyLengthProfileState,
  ): ReplyLengthProfileState {
    const text = userText.trim();
    const chars = text.replace(/\s+/g, "").length;
    const shortExplicit =
      /(简单说|简短点|短一点|一句话|一两句|别展开|直接说结论|长话短说|太长不看|简洁点)/i.test(text);
    const longExplicit =
      /(详细说|展开说|具体一点|多说点|讲清楚|完整方案|详细分析|一步一步|越详细越好)/i.test(text);
    const recentUserChars = [...current.recentUserChars, chars].slice(-8);
    const sampleCount = current.sampleCount + 1;
    const avgUserChars =
      current.sampleCount <= 0
        ? chars
        : Number(((current.avgUserChars * current.sampleCount + chars) / sampleCount).toFixed(2));
    const next: ReplyLengthProfileState = {
      avgUserChars,
      shortPreferenceScore: Math.max(0, current.shortPreferenceScore * 0.92 + (shortExplicit ? 1.2 : chars <= 20 ? 0.45 : 0)),
      longPreferenceScore: Math.max(0, current.longPreferenceScore * 0.92 + (longExplicit ? 1.2 : chars >= 90 ? 0.35 : 0)),
      recentUserChars,
      sampleCount,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_REPLY_LENGTH_PROFILE_KEY, next);
    return next;
  }

  /**
   * 旅行画像读取口（travel-upgrade-plan 画像引擎 + travel 双端②③）：规划工具
   * 生成行程前取用——出片向/体验向 style 兜底 + POI 负向偏好（同类衰减依据）+
   * 旅行人格分型（攻略页徽章 + 每日密度）。信号查不到返回空对象，不阻塞规划。
   */
  getTravelProfile(actorId: string): {
    photoDriven?: boolean;
    experienceDriven?: boolean;
    dislikeTags?: string[];
    dislikeNames?: string[];
    persona?: TravelPersona;
  } {
    try {
      const store = this.loadFactStore(actorId);
      const style = travelFactOf(store, "travel_style");
      const dislikeTags = store.facts
        .filter((f) => f.category === "travel" && f.key === "poi_dislike" && f.value)
        .map((f) => f.value);
      const dislikeNames = store.facts
        .filter((f) => f.category === "travel" && f.key === "poi_dislike_name" && f.value)
        .map((f) => f.value);
      const persona = this.deriveTravelPersona(store, style);
      if (!style && !dislikeTags.length && !dislikeNames.length && !persona) return {};
      return {
        ...(style === "photo_driven" ? { photoDriven: true } : {}),
        ...(style === "experience_driven" ? { experienceDriven: true } : {}),
        ...(dislikeTags.length ? { dislikeTags: dislikeTags.slice(0, 12) } : {}),
        ...(dislikeNames.length ? { dislikeNames: dislikeNames.slice(0, 24) } : {}),
        ...(persona ? { persona } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * 旅行人格分型（travel 双端③）：UserFact travel 类聚合 → 规则分型。
   * 优先级：style 显式分型 > 负反馈证据≥3（挑剔）> 有旅行事实（随性）。
   * 无任何旅行事实返回 null——攻略页不展示人格徽章，宁缺毋滥不硬凑。
   */
  private deriveTravelPersona(store: UserFactStore, style?: string): TravelPersona | null {
    const travelFacts = store.facts.filter((f) => f.category === "travel");
    if (!travelFacts.length) return null;
    if (style === "photo_driven") {
      return { id: "shutter", label: "出片收集家", desc: "走到哪拍到哪，机位与光线优先" };
    }
    if (style === "experience_driven") {
      return { id: "explorer", label: "体验沉浸派", desc: "玩法与在地感优先，不赶路不打卡" };
    }
    const dislikeEvidence = travelFacts
      .filter((f) => f.key === "poi_dislike" || f.key === "poi_dislike_name")
      .reduce((sum, f) => sum + Math.max(1, f.evidenceCount), 0);
    if (dislikeEvidence >= 3) {
      return { id: "curator", label: "挑剔策展人", desc: "不合口味的一票否决，留下的都是精华" };
    }
    return { id: "wanderer", label: "随性漫游者", desc: "不设限的旅程，走到哪算哪" };
  }

  /**
   * POI 负向偏好写入口（travel 双端①，2026-10-18）：攻略页「不感兴趣」反馈
   * 回写 UserFact——按 POI 标签写 travel.poi_dislike（同类衰减的依据，证据
   * 越多 confidence 越高、下次规划同类降权越狠），POI 名单独写
   * travel.poi_dislike_name（下轮规划直接点名排除）。零阻塞：写失败只记日志。
   */
  recordPoiDislike(actorId: string, poiName: string, tags: string[], fallbackKind?: string): void {
    if (!this.memory) return;
    const candidates: FactCandidate[] = [];
    for (const tag of tags) {
      const v = tag.trim().slice(0, 24);
      if (v) candidates.push({ category: "travel", key: "poi_dislike", value: v });
    }
    if (!candidates.length && fallbackKind) {
      candidates.push({ category: "travel", key: "poi_dislike", value: fallbackKind });
    }
    const name = poiName.trim().slice(0, 40);
    if (name) candidates.push({ category: "travel", key: "poi_dislike_name", value: name });
    void this.mergeFactsLocked(actorId, candidates).catch(() => {});
  }

  /** UserFact 乐观锁合并（CAS 重试 ≤8 次；对话抽取与显式反馈共用） */
  private async mergeFactsLocked(actorId: string, candidates: FactCandidate[]): Promise<void> {
    if (!this.memory || !candidates.length) return;
    for (let i = 0; i < 8; i++) {
      const { revision, entries } = this.memory.getSnapshot(actorId, [USER_PROFILE_FACTS_KEY]);
      const current = toFactStore(entries[USER_PROFILE_FACTS_KEY]);
      const merged = mergeFactCandidates(decayFactStore(current), candidates);
      const r = await this.memory.applyPatch(actorId, revision, [{ key: USER_PROFILE_FACTS_KEY, op: "put", value: merged }]);
      if (r.ok) return;
    }
  }

  private updateFactStore(actorId: string, userText: string): void {
    if (!this.memory || !userText.trim()) return;
    void this.updateFactStoreAsync(actorId, userText);
  }

  private async updateFactStoreAsync(actorId: string, userText: string): Promise<void> {
    const candidates = extractFactCandidates(userText);
    await this.mergeFactsLocked(actorId, candidates);
  }

  private loadBehaviorSignals(actorId: string): BehaviorSignals {
    return toBehaviorSignals(this.readState(actorId, USER_BEHAVIOR_SIGNAL_KEY));
  }

  private applyBehaviorSignals(actorId: string, userText: string, current: BehaviorSignals): BehaviorSignals {
    const delta = detectBehaviorSignals(userText);
    const next: BehaviorSignals = {
      shoppingInterest: current.shoppingInterest + (delta.shoppingInterest ?? 0),
      planningInterest: current.planningInterest + (delta.planningInterest ?? 0),
      companionNeed: current.companionNeed + (delta.companionNeed ?? 0),
      privacyConcern: current.privacyConcern + (delta.privacyConcern ?? 0),
      updatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_BEHAVIOR_SIGNAL_KEY, next);
    return next;
  }

  private saveEmotionState(actorId: string, state: EmotionState): void {
    this.saveJsonState(actorId, EMOTION_STATE_KEY, state);
  }

  private saveJsonState(actorId: string, key: string, value: unknown): void {
    if (!this.memory) {
      this.fallbackState.set(`${actorId}:${key}`, value);
      return;
    }
    void this.saveJsonStateAsync(actorId, key, value);
  }

  private readState(actorId: string, key: string): unknown {
    if (!this.memory) return this.fallbackState.get(`${actorId}:${key}`);
    return this.memory.getSnapshot(actorId, [key]).entries[key];
  }

  private async saveJsonStateAsync(actorId: string, key: string, value: unknown): Promise<void> {
    if (!this.memory) return;
    for (let i = 0; i < 8; i++) {
      const { revision } = this.memory.getSnapshot(actorId, [key]);
      const r = await this.memory.applyPatch(actorId, revision, [{ key, op: "put", value }]);
      if (r.ok) return;
    }
  }

  private syncProfileKv(actorId: string, md: string): void {
    this.saveJsonState(actorId, USER_PROFILE_KV_KEY, md);
  }

  private async refineProfileWithLlm(actorId: string, latestUserText: string, currentMd: string): Promise<void> {
    if (!this.externalChat?.isEnabled()) return;
    const mood = dominantRecentEmotion(this.loadEmotionState(actorId).recent);
    const prompt = [
      "你是用户画像整理助手。根据现有 USER_PROFILE.md 与用户最近一句话，输出更新后的完整 Markdown。",
      "要求：保留原有有效信息；合并重复；不要编造用户未提及的事实；章节保持：基本信息、兴趣与习惯、沟通偏好、备注。",
      `用户最近说：${latestUserText.slice(0, 300)}`,
      `近期情绪倾向（供沟通偏好参考，勿当医疗诊断）：${mood}`,
      "",
      "当前 USER_PROFILE.md：",
      currentMd.slice(-4000),
    ].join("\n");
    let out = "";
    await this.externalChat.streamCompletion(
      `profile-refine:${actorId}:${Date.now()}`,
      { text: prompt },
      (delta) => {
        out += delta;
      },
      undefined,
      {
        ephemeralTurn: true,
        systemPromptOverride: "只输出 Markdown 正文，不要代码围栏，不要解释。以 # 用户画像 开头。",
        maxThreadMessages: 1,
        disableThinking: true,
      },
    );
    const trimmed = out.trim();
    if (!trimmed.startsWith("#")) return;
    // 单一权威源：整文重写同样受权威投影约束
    const projected = await this.projectProfileFieldAuthority(actorId, trimmed);
    await this.store.write(actorId, projected);
    this.syncProfileKv(actorId, projected);
  }

  /**
   * 画像档案字段权威投影（单一权威源，2026-10-09）：
   * 「基本信息」里的档案字段（称呼/职业/居住地…）以结构化事实库当前值为准，
   * 去别名重复行、清行内历史注解。记忆系统未装配/无权威值 → 原样返回。
   */
  private async projectProfileFieldAuthority(actorId: string, md: string): Promise<string> {
    try {
      const { getMemoryComponents } = await import("../../agentic-memory/index.js");
      const facts = getMemoryComponents().factStore?.getActiveFacts?.(actorId) ?? [];
      if (facts.length === 0) return md;
      return projectProfileMarkdown(md, facts);
    } catch {
      return md;
    }
  }
}
