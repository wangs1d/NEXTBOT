// ContextSnapshot —— 主动性判断的**共享上下文**（2026-11-25 接缝 2）。
//
// 病根：AgentPulse 自己拼 aggregate、IntelJudge 自己拼 styleBrief + 目录行、
// 映射规则读世界板——三处对「用户此刻是什么状态、还有什么没聊完」各说各话。
// 同一个用户，一句话在 pulse 眼里是「他刚回来」，在情报判断眼里只是 presence=active。
//
// 修法：**一份只读快照，三个判断入口共用**。本模块只做归一与格式化（零 LLM、
// 零 IO）：调用方把已经拿到的原始值是传进来，输出稳定结构 + 稳定版号，
// 诊断接口据此回答「这句话是基于哪一版上下文说的」。
import type { PresenceState } from "./pipeline-types.js";

export type PlaceSnapshot = {
  kind: "home" | "work" | "other" | "unknown";
  label?: string;
  city?: string;
  poi?: string;
  updatedMinutesAgo?: number;
};

export type ActivitySnapshot = "still" | "walking" | "vehicle" | "unknown";
export type MoodSnapshot = "positive" | "negative" | "stressed";

export type SharedContextSnapshot = {
  actorId: string;
  at: number;
  /** 稳定版号（内容变一点就变）：提案 evidence 记录它，事后能归因 */
  version: string;
  presence: { state: PresenceState; sinceMinutes?: number } | null;
  screenFocus: { kind: string; sinceMinutes?: number } | null;
  place: PlaceSnapshot | null;
  /** 位置超过 2h 视为旧数据，这里直接置 null（不让「你在公司」变成瞎猜） */
  activity: ActivitySnapshot | null;
  mood: MoodSnapshot | null;
  idleMinutes: number | null;
  /** 没聊完 / 没结果的事（接话的锚点；宁少勿滥，最多 5 条） */
  openLoops: string[];
  interests: string[];
  findings: string[];
  recentTurns: string[];
};

export type SharedContextInput = {
  actorId: string;
  at?: number;
  presence?: { state?: string; since?: number } | null;
  screenFocus?: { kind?: string; since?: number } | null;
  place?: PlaceSnapshot | null;
  activity?: ActivitySnapshot | null;
  mood?: MoodSnapshot | null;
  idleMinutes?: number | null;
  openLoops?: string[];
  interests?: string[];
  findings?: string[];
  recentTurns?: string[];
};

/** 位置的新鲜期：超过 2h 的「你还在公司」是瞎猜，宁可不提 */
export const PLACE_FRESH_MS = 2 * 60 * 60_000;
/** openLoops 上限：太多会把 prompt 变成待办清单，反而没有锚点 */
const MAX_OPEN_LOOPS = 5;

function sinceMinutes(since: number | undefined, at: number): number | undefined {
  if (typeof since !== "number" || !Number.isFinite(since)) return undefined;
  return Math.max(0, Math.round((at - since) / 60_000));
}

function dedupe(lines: Array<string | null | undefined>, limit?: number): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = String(raw ?? "").trim();
    if (!line || out.includes(line)) continue;
    out.push(line);
  }
  return limit !== undefined ? out.slice(0, limit) : out;
}

/**
 * 从已拿到的原始值构建共享快照（纯函数，可单测）。
 * 位置新鲜度在这里统一判断——调用方不必各自记得「>2h 丢掉」。
 */
export function buildSharedContext(input: SharedContextInput): SharedContextSnapshot {
  const at = input.at ?? Date.now();
  const presenceState = input.presence?.state;
  const presence: SharedContextSnapshot["presence"] =
    presenceState === "active" || presenceState === "idle" || presenceState === "offline"
      ? {
          state: presenceState,
          ...(sinceMinutes(input.presence?.since, at) !== undefined
            ? { sinceMinutes: sinceMinutes(input.presence?.since, at) }
            : {}),
        }
      : null;
  const focusKind = input.screenFocus?.kind;
  const screenFocus =
    focusKind && focusKind !== "unknown"
      ? {
          kind: focusKind,
          ...(sinceMinutes(input.screenFocus?.since, at) !== undefined
            ? { sinceMinutes: sinceMinutes(input.screenFocus?.since, at) }
            : {}),
        }
      : null;
  const place =
    input.place && (input.place.updatedMinutesAgo === undefined || input.place.updatedMinutesAgo * 60_000 <= PLACE_FRESH_MS)
      ? input.place
      : null;
  const snapshot: SharedContextSnapshot = {
    actorId: input.actorId,
    at,
    version: "",
    presence,
    screenFocus,
    place,
    activity: input.activity ?? null,
    mood: input.mood ?? null,
    idleMinutes: input.idleMinutes ?? null,
    openLoops: dedupe(input.openLoops ?? [], MAX_OPEN_LOOPS),
    interests: dedupe(input.interests ?? []),
    findings: dedupe(input.findings ?? []),
    recentTurns: dedupe(input.recentTurns ?? []),
  };
  snapshot.version = contextVersion(snapshot);
  return snapshot;
}

/**
 * 没聊完的事：在办目标 + 已过点未完成的单次日程 + 待跟进的承诺。
 * 只收已经确定的、用户自己提过的事——凭空编一个「上次说到一半」比不说更糟。
 */
export function collectOpenLoops(input: {
  activeGoal?: string | null;
  overdueTasks?: Array<{ title: string }>;
  followUps?: Array<{ event: string }>;
}): string[] {
  return dedupe(
    [
      input.activeGoal ? `还在办：${input.activeGoal}` : null,
      ...(input.overdueTasks ?? []).map((t) => (t.title ? `还没弄完：${t.title}` : null)),
      ...(input.followUps ?? []).map((f) => (f.event ? `还没聊到：${f.event}` : null)),
    ],
    MAX_OPEN_LOOPS,
  );
}

/**
 * 稳定版号：只对**事实**取哈希，不对"正在走的时钟"取。
 *
 * 排除项：at、sinceMinutes、updatedMinutesAgo、idleMinutes —— 它们每分钟都在变，
 * 进来会让同一份上下文每次调用都换版号，诊断里就永远对不上"这句话基于哪版事实"。
 */
export function contextVersion(s: Omit<SharedContextSnapshot, "version">): string {
  const stable = JSON.stringify([
    s.presence?.state ?? null,
    s.screenFocus?.kind ?? null,
    s.place ? [s.place.kind, s.place.label ?? "", s.place.city ?? "", s.place.poi ?? ""] : null,
    s.activity,
    s.mood,
    s.openLoops,
    s.interests,
    s.findings,
    s.recentTurns,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 「在线：active（已持续 8 分钟）」——pulse 材料与情报判断共用同一套人话 */
export function presenceText(s: SharedContextSnapshot): string | null {
  if (!s.presence) return null;
  const min = s.presence.sinceMinutes;
  return `${s.presence.state}${min !== undefined ? `（已持续 ${min} 分钟）` : ""}`;
}

const FOCUS_LABEL: Record<string, string> = {
  coding: "写代码",
  terminal: "终端操作",
  browsing: "浏览网页",
  video: "看视频",
  game: "打游戏",
  office: "办公文档",
  chat: "聊天",
  music: "听音乐",
};

export function screenFocusText(s: SharedContextSnapshot): string | null {
  if (!s.screenFocus) return null;
  const label = FOCUS_LABEL[s.screenFocus.kind] ?? s.screenFocus.kind;
  const min = s.screenFocus.sinceMinutes;
  return `${label}${min !== undefined ? `（已持续 ${min} 分钟）` : ""}`;
}

export function placeText(s: SharedContextSnapshot): string | null {
  if (!s.place || s.place.kind === "unknown") return null;
  const where =
    s.place.label?.trim() ||
    (s.place.kind === "home" ? "家" : s.place.kind === "work" ? "公司" : "外面");
  return [where, s.place.poi?.trim() || s.place.city?.trim() || "", typeof s.place.updatedMinutesAgo === "number" ? `${s.place.updatedMinutesAgo} 分钟前的位置` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function activityText(s: SharedContextSnapshot): string | null {
  if (!s.activity || s.activity === "unknown") return null;
  return s.activity === "vehicle" ? "在车上/开车" : s.activity === "walking" ? "在走路" : "待着没动";
}

export function moodText(s: SharedContextSnapshot): string | null {
  if (!s.mood) return null;
  return s.mood === "negative" ? "情绪偏低" : s.mood === "stressed" ? "压力大/有点累" : "状态不错";
}

/**
 * 给情报判断（IntelJudge）的人话上下文块。
 * 与 pulse 的 prompt 同源，但不复述 pulse 的「开口理由」——判断口径各自独立，
 * 事实只允许有一份。
 */
export function sharedContextPromptLines(s: SharedContextSnapshot): string[] {
  const lines: string[] = [];
  const state: string[] = [];
  const p = presenceText(s);
  if (p) state.push(`在线：${p}`);
  const f = screenFocusText(s);
  if (f) state.push(`屏幕：${f}`);
  if (state.length) lines.push(`【他此刻状态】${state.join("；")}`);
  const place = placeText(s);
  if (place) lines.push(`【他此刻在哪】${place}`);
  const act = activityText(s);
  if (act) lines.push(`【他在动吗】${act}`);
  const mood = moodText(s);
  if (mood) lines.push(`【他最近的状态】${mood}`);
  if (s.openLoops.length) lines.push(`【没聊完的事】\n${s.openLoops.map((x) => `- ${x}`).join("\n")}`);
  if (s.interests.length) lines.push(`【他关注的话题】${s.interests.join("；")}`);
  if (s.recentTurns.length) {
    lines.push(`【最近对话（他已经知道，不要重复）】\n${s.recentTurns.map((t) => `- ${t}`).join("\n")}`);
  }
  if (s.idleMinutes === null) {
    lines.push("【距上次对话】还没聊过");
  } else {
    const mins = Math.max(0, Math.round(s.idleMinutes));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    lines.push(`【距上次对话】${h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`}前`);
  }
  return lines;
}
