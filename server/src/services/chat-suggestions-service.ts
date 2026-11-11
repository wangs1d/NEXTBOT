/**
 * 聊天推荐项服务（「为你推荐」的服务端数据源）。
 *
 * 设计约束：
 * - 每条推荐必须绑定真实能力：capabilityId 指向能力就绪注册表
 *   （capability-readiness-service）的条目 id；未就绪（needs_config/disabled）
 *   的能力不会进推荐。capabilityId 为 null 表示依赖内置工具，永远可用。
 * - 抽样在服务端做：核心组（core，无配置依赖）保证至少 CORE_MIN 条在场，
 *   其余位置轮换补足，调用间天然轮换。
 * - 个性化必须带用户身份（getChatSuggestions 的 actorId）：无身份 = 完全不
 *   个性化（纯轮换），绝不回退到「全体用户混算」——那是跨用户串数据事故。
 * - 使用习惯层：habit-loop 的工具执行观察（configureChatSuggestionUsageSource
 *   注入）先按 obs.actorId === actorId 过滤，再按 toolSignals 归到推荐项；
 *   近 14 天里有 ≥2 天真实用过的能力视为「在用」——保底在场（最多 2 条，
 *   不挤占轮换与上新位）并切换为「回访版」文案（usedPrompt），
 *   personalized=true 供客户端/取证区分。
 * - 画像层：UserPersonalizationService 的行为信号（behavior signals，
 *   configureChatSuggestionProfileSource 注入）按 interestKey 给对应推荐项
 *   加权（加权随机抽样，不打乱核心保底与轮换性质）。信号是累计计数，
 *   按占总信号比例归一，总量不足 PROFILE_MIN_SIGNALS 不加权（防单次提及
 *   与冷启动噪声）。
 * - experimental 从就绪注册表透传，客户端渲染「实验」徽标。
 */
import { listCapabilityStatuses } from "./capability-readiness-service.js";

export interface ChatSuggestion {
  id: string;
  /** 指向能力就绪注册表条目；null = 内置工具，永远就绪 */
  capabilityId: string | null;
  /** 能力标签（胶囊上的小字标，如「日程」「打车」） */
  tag: string;
  /** 示例任务文案（点击即作为用户消息发出） */
  prompt: string;
  experimental: boolean;
  /** true = 文案按该用户真实使用习惯生成（回访版），false = 默认介绍版 */
  personalized: boolean;
}

/** 工具执行观察（habit-loop observations 的结构化最小面） */
export interface SuggestionUsageObservation {
  actorId: string;
  tool: string;
  at: number;
}

/** 画像快照（UserPersonalizationService.getBehaviorSignals 的结构化最小面） */
export interface SuggestionProfileSnapshot {
  shoppingInterest: number;
  planningInterest: number;
  companionNeed: number;
  privacyConcern: number;
}

interface SuggestionPoolEntry {
  id: string;
  capabilityId: string | null;
  tag: string;
  prompt: string;
  /** 核心组：无配置依赖，抽样时保证至少 CORE_MIN 条在场 */
  core: boolean;
  /** 「回访版」文案：该能力近期在用时替换 prompt 展示 */
  usedPrompt?: string;
  /** 工具名使用信号（精确匹配或前缀匹配），非空才参与个性化 */
  toolSignals?: string[];
  /** 画像兴趣轴：behavior signals 里驱动加权的信号键 */
  interestKey?: "shopping" | "planning";
  /** 画像加权上限幅度：boost = interestWeight × min(1, 信号占比) */
  interestWeight?: number;
}

const CORE_MIN = 3;
const SAMPLE_MAX = 5;
/** 近 N 天里有 ≥RETURNING_MIN_ACTIVE_DAYS 天用过 → 视为「在用」 */
const RETURNING_WINDOW_DAYS = 14;
const RETURNING_MIN_ACTIVE_DAYS = 2;
/** 「在用」能力保底在场的上限：不挤占轮换与上新位 */
const ALWAYS_IN_MAX = 2;
/** 画像加权门槛：行为信号总量不足此值时不加权（冷启动/单次提及不算画像） */
const PROFILE_MIN_SIGNALS = 6;

const SUGGESTION_POOL: SuggestionPoolEntry[] = [
  // —— 核心组：无需配置，来自内置工具 / 必就绪能力 ——
  {
    id: "weather-today",
    capabilityId: null,
    tag: "天气",
    prompt: "看看今天天气怎么样，出门要不要带伞",
    usedPrompt: "看看今明两天天气，有没有降温降雨",
    toolSignals: ["weather."],
    core: true,
  },
  {
    id: "schedule-create",
    capabilityId: null,
    tag: "日程",
    prompt: "帮我记个日程，周六上午十点去牙医",
    usedPrompt: "帮我看看这周的日程，找个空档加个安排",
    toolSignals: ["calendar.", "reminder."],
    interestKey: "planning",
    interestWeight: 1.2,
    core: true,
  },
  {
    id: "web-research",
    capabilityId: "web_search",
    tag: "搜索",
    prompt: "帮我查一下这周末有什么展，挑个值得去的",
    usedPrompt: "帮我查查这周有什么新动态，挑重点讲给我",
    toolSignals: ["search_web", "search_images", "search_videos", "web_search"],
    core: true,
  },
  {
    id: "shopping-compare",
    capabilityId: null,
    tag: "购物",
    prompt: "帮我比比价，选台性价比高的空气炸锅",
    usedPrompt: "再帮我比比价，看看最近想买的降没降价",
    toolSignals: ["shopping.compare", "shopping.suggest"],
    interestKey: "shopping",
    interestWeight: 1.2,
    core: true,
  },
  {
    id: "memory-save",
    capabilityId: "agentic_memory",
    tag: "记忆",
    prompt: "记住我喝咖啡不加糖，以后点单都按这个来",
    usedPrompt: "我又有一条新偏好，记一下，以后都按这个来",
    toolSignals: ["brain.remember", "memory.remember"],
    core: true,
  },
  {
    id: "morning-brief",
    capabilityId: "proactive",
    tag: "早报",
    prompt: "每天早上八点给我一份早报",
    interestKey: "planning",
    interestWeight: 0.8,
    core: true,
  },
  // —— 就绪才展示：配置解锁后自动进池 ——
  {
    id: "travel-ticket",
    capabilityId: "travel_booking",
    tag: "订票",
    prompt: "下周五去上海，帮我比比高铁和机票的价格",
    usedPrompt: "这周末想短途出行，帮我看看高铁和机票价格",
    toolSignals: ["travel_booking.", "travel."],
    interestKey: "planning",
    interestWeight: 0.5,
    core: false,
  },
  {
    id: "ride-book",
    capabilityId: "ride_hailing",
    tag: "打车",
    prompt: "帮我叫辆车，四十分钟后去机场，帮我盯着行程",
    usedPrompt: "等下要出门，提前帮我叫好车、盯着行程",
    toolSignals: ["ride"],
    core: false,
  },
  {
    id: "luckin-order",
    capabilityId: "luckin_coffee",
    tag: "点咖啡",
    prompt: "帮我点一杯冰美式，到店自取",
    usedPrompt: "想喝瑞幸了，老样子来一杯，到店自取",
    toolSignals: ["luckin"],
    core: false,
  },
  {
    id: "errand-run",
    capabilityId: "meituan_errand",
    tag: "跑腿",
    prompt: "帮我跑腿买束花送回家",
    usedPrompt: "再帮我跑个腿，买点水果送回家",
    toolSignals: ["meituan", "errand"],
    core: false,
  },
  {
    id: "home-control",
    capabilityId: "home_assistant",
    tag: "家居",
    prompt: "把客厅灯调暗一点，十点半自动关",
    usedPrompt: "把家里灯光调成观影模式，十点半自动关",
    toolSignals: ["smart_home.", "home_assistant."],
    core: false,
  },
  {
    id: "image-gen",
    capabilityId: "image_gen",
    tag: "画图",
    prompt: "帮我画一张黑白极简风格的头像",
    usedPrompt: "再帮我画一张，这次换个新风格",
    toolSignals: ["image.generate"],
    core: false,
  },
];

/** 用量观察源（bootstrap 注入 habit-loop 观察流；null = 无个性化） */
let usageSource: (() => readonly SuggestionUsageObservation[]) | null = null;

/** 画像源（bootstrap 注入 UserPersonalizationService 行为信号；null = 无画像加权） */
let profileSource: ((actorId: string) => SuggestionProfileSnapshot | null) | null = null;

export function configureChatSuggestionUsageSource(
  source: (() => readonly SuggestionUsageObservation[]) | null,
): void {
  usageSource = source;
}

export function configureChatSuggestionProfileSource(
  source: ((actorId: string) => SuggestionProfileSnapshot | null) | null,
): void {
  profileSource = source;
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 加权随机抽样（不放回）：权重恒 ≥1，保持轮换性质的同时让画像项更常在场 */
function weightedSampleWithoutReplacement<T>(items: readonly T[], weight: (t: T) => number, count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    let total = 0;
    for (const item of pool) total += weight(item);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      r -= weight(pool[i] as T);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0] as T);
  }
  return out;
}

function matchesToolSignal(entry: SuggestionPoolEntry, tool: string): boolean {
  if (!entry.toolSignals?.length || !tool) return false;
  return entry.toolSignals.some((m) => tool === m || tool.startsWith(m));
}

/** 画像兴趣加权：信号按占总信号比例归一，总量不足门槛返回 0 */
function profileBoost(entry: SuggestionPoolEntry, profile: SuggestionProfileSnapshot | null): number {
  if (!profile || !entry.interestKey || !entry.interestWeight) return 0;
  const total =
    profile.shoppingInterest + profile.planningInterest + profile.companionNeed + profile.privacyConcern;
  if (!Number.isFinite(total) || total < PROFILE_MIN_SIGNALS) return 0;
  const raw = entry.interestKey === "shopping" ? profile.shoppingInterest : profile.planningInterest;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return entry.interestWeight * Math.min(1, raw / total);
}

/** 近 N 天活跃天数（本地日期去重）与最近一次使用时间；仅统计该 actorId 自己的观察 */
function computeUsageStats(
  eligible: readonly SuggestionPoolEntry[],
  usage: readonly SuggestionUsageObservation[],
  now: Date,
  actorId: string,
): Map<string, { activeDays: Set<string>; lastAt: number }> {
  const windowStart = now.getTime() - RETURNING_WINDOW_DAYS * 86_400_000;
  const stats = new Map<string, { activeDays: Set<string>; lastAt: number }>();
  for (const obs of usage) {
    if (!actorId || obs.actorId !== actorId) continue;
    if (!Number.isFinite(obs.at) || obs.at < windowStart || obs.at > now.getTime() + 60_000) {
      continue;
    }
    for (const entry of eligible) {
      if (!matchesToolSignal(entry, obs.tool)) continue;
      let s = stats.get(entry.id);
      if (!s) {
        s = { activeDays: new Set(), lastAt: 0 };
        stats.set(entry.id, s);
      }
      s.activeDays.add(localDateKey(new Date(obs.at)));
      s.lastAt = Math.max(s.lastAt, obs.at);
    }
  }
  return stats;
}

/**
 * 全量推荐（HTTP /api/chat/suggestions 的数据源，纯内存计算，无 IO）。
 *
 * @param actorId 当前用户身份；为空 = 无个性化（纯轮换），绝不混算他人数据
 */
export function getChatSuggestions(now: Date = new Date(), actorId = ""): { suggestions: ChatSuggestion[] } {
  const readyById = new Map(
    listCapabilityStatuses()
      .capabilities.filter((c) => c.state === "ready")
      .map((c) => [c.id, c]),
  );

  const eligible = SUGGESTION_POOL.filter(
    (e) => e.capabilityId === null || readyById.has(e.capabilityId),
  );

  const usageStats = computeUsageStats(eligible, usageSource?.() ?? [], now, actorId);
  const isReturning = (e: SuggestionPoolEntry): boolean =>
    (usageStats.get(e.id)?.activeDays.size ?? 0) >= RETURNING_MIN_ACTIVE_DAYS;

  // 「在用」能力保底在场（按活跃天数优先，最多 ALWAYS_IN_MAX 条），
  // 其余位置按画像加权轮换——个性化加权与发现新能力并存。
  const returningSorted = eligible
    .filter(isReturning)
    .sort(
      (a, b) =>
        (usageStats.get(b.id)?.activeDays.size ?? 0) -
          (usageStats.get(a.id)?.activeDays.size ?? 0) ||
        (usageStats.get(b.id)?.lastAt ?? 0) - (usageStats.get(a.id)?.lastAt ?? 0),
    )
    .slice(0, ALWAYS_IN_MAX);
  const alwaysIn = new Set(returningSorted);
  const picked = [...returningSorted];

  const profile = actorId ? (profileSource?.(actorId) ?? null) : null;
  const remaining = shuffle(eligible.filter((e) => !alwaysIn.has(e)));
  for (const entry of weightedSampleWithoutReplacement(
    remaining,
    (e) => 1 + profileBoost(e, profile),
    SAMPLE_MAX - picked.length,
  )) {
    picked.push(entry);
  }

  // 随机优先，保底修复：样本里核心组不足 CORE_MIN 时，用未入样的核心条目
  // 替换尾部的非核心条目（保底位从尾部补，前 ALWAYS_IN_MAX 个个性化位不动）
  let coreCount = picked.filter((e) => e.core).length;
  if (coreCount < CORE_MIN) {
    const inPicked = new Set(picked);
    const replacementCores = shuffle(
      eligible.filter((e) => e.core && !inPicked.has(e)),
    );
    for (let i = picked.length - 1; i >= 0 && coreCount < CORE_MIN; i -= 1) {
      const slot = picked[i];
      if (slot && !slot.core) {
        const replacement = replacementCores.shift();
        if (!replacement) break;
        picked[i] = replacement;
        coreCount += 1;
      }
    }
  }

  return {
    suggestions: picked.map((e) => {
      const returning = isReturning(e) && Boolean(e.usedPrompt);
      return {
        id: e.id,
        capabilityId: e.capabilityId,
        tag: e.tag,
        prompt: returning ? e.usedPrompt! : e.prompt,
        experimental:
          e.capabilityId !== null
            ? (readyById.get(e.capabilityId)?.experimental ?? false)
            : false,
        personalized: returning,
      };
    }),
  };
}

/** 本地时区日期键（YYYY-MM-DD）：活跃天数按自然日去重 */
function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
