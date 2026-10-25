/**
 * 早间简报聚合服务：将日程、笔记、兴趣热搜命中等合并为一份「早间简报」。
 *
 * 依赖为可选 —— 当宿主未注入对应服务时返回占位数据，
 * 保证该服务可独立实例化与调用。
 *
 * 2026-10-16：天气与穿衣建议移出早间简报（迁往睡前提醒 EveningDigest）；
 * 本服务仅保留内部天气抓取供恶劣天气预警检测（onSevereWeatherAlert 联动）。
 *
 * 第四源「兴趣热搜命中」（2026-08-29）：读 data/interest-watch.json 中该 actor 的
 * 兴趣列表（字段结构见 proactivity/interest-watcher.ts），结合 hot-rankings.ts 的
 * 实时热搜聚合做简单 includes 匹配，最多取 3 条；无命中则整体省略该块。
 */
import { getDataDir } from "../config/data-dir.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isTriviaTask } from "./schedule-task-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import type { NotesService } from "./notes-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";
import { fetchHotRankings } from "./hot-rankings.js";
import { normalizeFp } from "../proactivity/interest-watcher.js";
import { resolvePoliteAppellation } from "./user-personalization/appellation.js";
import { fetchIPLocation } from "./ip-geolocation.js";
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";
import { stripProtocolMarkersForDirectOut } from "./reply-envelope.js";
import type { UserPreferences } from "../routes/http/user-preferences.js";
import type { DdlItem } from "./ddl-radar-service.js";

/**
 * 内部天气快照：仅供生成期恶劣天气预警检测（onSevereWeatherAlert 联动），
 * 不再作为简报内容块下发（2026-10-16 天气/穿衣迁往睡前提醒）。
 */
interface MorningBriefingWeather {
  temperature?: number;
  condition?: string;
  description?: string;
  /** WMO 天气码（Task 15 预警检测要素） */
  weatherCode?: number;
  /** 当日最高/最低温（预警检测要素） */
  maxC?: number;
  minC?: number;
  /** 风速 km/h（预警检测要素） */
  windKmh?: number;
}

export interface MorningBriefingScheduleItem {
  id: string;
  title: string;
  time?: string;
}

export interface MorningBriefingPendingNote {
  id: string;
  title: string;
}

/**
 * 待办跟进（可选块）：今日简报不只播新闻，还要回报"之前交代的事"。
 *  - pending：记忆 KV memory_open_loops（待办/承诺槽位）里还没完成的事，
 *    最新在前，最多 3 条（已剥掉时间戳/话题前缀）；
 *  - doneTodayCount：今天已办结的日程/提醒数。
 * 全空 → 省略该字段。
 */
export interface MorningBriefingTodoFollowups {
  pending: string[];
  doneTodayCount: number;
}

/**
 * 兴趣热搜命中条目（第四源）：用户关注的话题撞上当日热搜。
 * interest 是命中的兴趣名，title/platform/url/hot 来自热搜聚合条目。
 */
export interface MorningBriefingInterestHit {
  interest: string;
  title: string;
  platform: string;
  url?: string;
  hot?: string;
}

/**
 * 近期重要日子条目（第五源）：用户经 care.set_important_date 录入的
 * 生日/纪念日（KV key: important_dates），7 天窗口内按剩余天数升序。
 * 字段结构与 care-reminder-tools.ts 的 ImportantDateRecord 对齐。
 */
export interface MorningBriefingImportantDay {
  id: string;
  /** 人物或事件名称，如"妈妈"、"结婚纪念日" */
  name: string;
  /** MM-DD 格式（年度周期） */
  date: string;
  type: "birthday" | "anniversary" | "custom";
  /** 关系标签，如"母亲"、"配偶" */
  relationship?: string;
  /** 备注（交往摘要，供祝福草稿参考） */
  notes?: string;
  /** 距今天数：0=今天，1=明天…… */
  daysUntil: number;
}

/** 晨报行程段：今天落在行程区间内 → 第一站提醒（确定性读行程仓库，无 LLM） */
export interface MorningBriefingTravel {
  planId: string;
  title: string;
  destination: string;
  /** 当天第一站（无排程天为 null） */
  firstStop: { name: string; startTime: string } | null;
  /** 出发日天气一句话摘要（规划时取，可能为空） */
  weather: string | null;
  /** 随身叮嘱（packing 前 3 条） */
  packing: string[];
}

export interface MorningBriefing {
  date: string;
  todaySchedule: MorningBriefingScheduleItem[];
  pendingNotes: MorningBriefingPendingNote[];
  /**
   * 行程段（可选块，第六源）：今天落在某份行程区间内（startDate ≤ 今天 ≤ endDate）
   * → 当天第一站 + 目的地/天气 + 随身叮嘱；无进行中行程时省略该字段。
   */
  travel?: MorningBriefingTravel;
  /** 兴趣热搜命中（可选块）：无命中时省略该字段，三源结构不受影响 */
  interestHits?: MorningBriefingInterestHit[];
  /** 待办跟进（可选块）：之前交代的未完成事项 + 今日已办结数；全空时省略 */
  todoFollowups?: MorningBriefingTodoFollowups;
  /** 近期重要日子（可选块，7 天窗口）：无记录时省略该字段 */
  upcomingImportantDays?: MorningBriefingImportantDay[];
  /** 用户称呼（可选）：记忆「称呼」行的得体称呼（用户指定优先，大名→「王先生」式）；问候语用 */
  appellation?: string;
  /**
   * DDL 三级提醒梯度的 L3 + L1 档（2026-10-22 大学生线）：
   * today = 今天到期或已过期（置顶，比日程更紧）；soon = 2~3 天后到期（一行汇总）。
   * 由 DdlRadarService 确定性扫描；未注入 radar 或两档皆空时整块省略。
   * L2（明天到期）走明日速览卡，不在晨报重复。
   */
  deadlines?: MorningBriefingDeadlines;
  agentGreeting: string;
}

export interface MorningBriefingDeadlines {
  today: DdlItem[];
  soon: DdlItem[];
}

export interface MorningBriefingNarration {
  /** 口语化文本（供 TTS 播报） */
  narrationText: string;
  /** 结构化简报 */
  briefing: MorningBriefing;
}

/** AgentMemorySyncService 的最小依赖接口（读 important_dates KV，避免重类型耦合） */
export interface ImportantDaysStoreLike {
  getSnapshot(sessionId: string, keys?: string[]): {
    revision: number;
    entries: Record<string, unknown>;
  };
}

/** 结构化事实库的最小依赖接口（读「称呼」字段，避免重类型耦合） */
export interface BriefingFactStoreLike {
  getFact(
    actorId: string,
    field: string,
    entity?: string,
  ): { field: string; value: string } | null;
}

export type MorningBriefingDeps = {
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
  scheduleTaskService?: ScheduleTaskService;
  notesService?: NotesService;
  getSessionPrefs?: (sessionId: string) => UserPreferences;
  /**
   * 客户端定位（GPS，比 IP 准）：用户未配置天气城市时的优先兜底。
   * 装配层接 LocationCoordinator（requestLocation 优先新鲜缓存，
   * 客户端在线时按需向设备要一次实时定位，离线/拒绝 → null）。
   */
  requestClientLocation?: (
    sessionId: string,
  ) => Promise<
    | {
        latitude: number;
        longitude: number;
        label?: string;
        city?: string;
        timezone?: string;
      }
    | null
  >;
  /** 兴趣池文件路径（第四源；默认 data/interest-watch.json，与 InterestWatcher 一致） */
  interestWatchPath?: string;
  /** 重要日子存储（第五源；读 care.set_important_date 写入的 important_dates KV） */
  agentMemorySyncService?: ImportantDaysStoreLike;
  /**
   * 结构化事实库（用户称呼源）：与首启向导/聊天面同走 factStore 的「称呼」
   * 字段（agent 叫用户的称呼，如「王哥」）。绝不回退账号 displayName——
   * 那是 agent 的网络名（用户叫 agent），方向反了会拿 agent 名称呼用户。
   */
  factStore?: BriefingFactStoreLike;
  /**
   * 当天命中重要日子回调（Task 17 人情关系）：每日扫描挂晨报调度，
   * 当天命中（daysUntil=0）且当日未触发过时回调一次（内部按 sessionId|id 去重）。
   * 装配层接：单次 LLM 祝福草稿 → ProactivityHub life_reminder 主动提醒。
   */
  onImportantDayToday?: (sessionId: string, day: MorningBriefingImportantDay) => void;
  /**
   * 恶劣天气预警联动回调（Task 15 生活节律）：晨报生成时检测当日预警
   * （暴雨/高温/大风/寒潮等确定性规则），预警命中且当日有日程时回调一次
   * （内部按日去重）。装配层接 ProactivityHub weather_alert kind 合并提醒。
   */
  onSevereWeatherAlert?: (sessionId: string, alerts: string[], scheduleCount: number) => void;
  /**
   * 播报稿口语润色（单次小 LLM 调用，ephemeral 不污染会话）：把确定性事实
   * 重写成有温度的口语稿。未注入/失败/超长 → 回退确定性模板（composeNarration），
   * 绝不阻塞简报主链路。装配层用 externalChat.streamCompletion 薄包装。
   */
  llmComplete?: (prompt: string) => Promise<string>;
  /**
   * DDL 雷达（大学生线 L3/L1 档）：今天截止 + 这周还要交的取数口。
   * 未注入 = 不做 DDL 块；只读扫描，不推送。
   */
  ddlRadar?: {
    forMorning(
      sessionId: string,
      actorId?: string,
    ): { today: DdlItem[]; soon: DdlItem[] };
  } | null;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 早间播报固定时段（服务器本地时间）：[05:00, 12:00)，窗口外一律不播报 */
export const BRIEFING_WINDOW_START_MIN = 5 * 60;
export const BRIEFING_WINDOW_END_MIN = 12 * 60;

/** HH:mm 是否落在早间播报时段内 */
export function isWithinBriefingWindow(hhmm: string): boolean {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= BRIEFING_WINDOW_START_MIN && mins < BRIEFING_WINDOW_END_MIN;
}

/** 简报只在早上播报，问候语固定为早安（不再按小时切换下午/晚间问候） */
const MORNING_GREETING = "早上好！新的一天开始了，这是你的早间简报。";

/** 今日本地区间（00:00 至次日 00:00），供日程「今日」过滤，与 /api/schedule today 对齐 */
function todayLocalRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** ISO 时间 → 本地 HH:mm（24 小时制，播报稿与卡片共用）；非法输入返回空串 */
function formatHhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * DDL 一句（晨报确定性兜底文案）：今天截止置顶，只报最近一件 + 件数，
 * 再加一句"这周还有 N 项"。过期的显式说过点，避免误读成"还没到"。
 */
function formatDeadlinesBit(d: MorningBriefingDeadlines | undefined): string {
  if (!d) return "";
  const { today, soon } = d;
  const parts: string[] = [];
  if (today.length > 0) {
    const first = today[0]!;
    const due = new Date(first.dueAt);
    const hm = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
    if (first.overdue) {
      parts.push(`《${first.title}》已经过点了`);
    } else {
      parts.push(`今天 ${hm} 前要交《${first.title}》`);
    }
    if (today.length > 1) parts.push(`今天一共 ${today.length} 项截止`);
  }
  if (soon.length > 0) {
    parts.push(`这周还有 ${soon.length} 项要交`);
  }
  return parts.length > 0 ? `${parts.join("，")}。` : "";
}

function formatScheduleBit(items: MorningBriefingScheduleItem[]): string {
  const top = items.slice(0, 3);
  const rest = items.length - top.length;
  const bits = top.map((item) => {
    if (item.time) {
      return `${item.time}的${item.title}`;
    }
    return item.title;
  });
  let sentence = `今天有${top.length}个安排：${bits.join("、")}。`;
  if (rest > 0) {
    sentence = `${sentence}另外还有${rest}项可以晚点再看。`;
  }
  return sentence;
}

function formatNotesBit(items: MorningBriefingPendingNote[]): string {
  const titles = items.slice(0, 3).map((n) => n.title);
  return `还有${items.length}条笔记没看过：${titles.join("、")}，有空可以翻翻。`;
}

/** 兴趣热搜块最多呈现条数（无命中则整块省略） */
const INTEREST_HITS_MAX = 3;
/** 兴趣匹配的热搜抓取条数（与 InterestWatcher 的 HOT_FETCH_LIMIT 对齐，覆盖各平台榜单头部） */
const INTEREST_HITS_FETCH_LIMIT = 50;

function formatInterestHitsBit(items: MorningBriefingInterestHit[]): string {
  const titles = items.map((h) => h.title);
  return `你关注的话题上热搜了：${titles.join("、")}。`;
}

/** 重要日子扫描窗口（天）：晨报只呈现 7 天内的近期日子 */
const UPCOMING_DAYS_WINDOW = 7;
/** 晨报"近期重要日子"块最多呈现条数 */
const UPCOMING_DAYS_MAX = 5;

/** 重要日子类型中文标签 */
export function importantDayTypeLabel(type: MorningBriefingImportantDay["type"]): string {
  switch (type) {
    case "birthday":
      return "生日";
    case "anniversary":
      return "纪念日";
    default:
      return "特殊日子";
  }
}

/**
 * 计算 MM-DD 距今天数（0=今天；今年的日期已过则按明年计，年度周期日子永不为负）。
 * 格式非法返回 -1（调用方过滤）。
 */
export function daysUntilMMdd(mmdd: string, now: Date = new Date()): number {
  const m = mmdd.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return -1;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target.getTime() < todayStart.getTime()) {
    target = new Date(now.getFullYear() + 1, month - 1, day);
  }
  return Math.round((target.getTime() - todayStart.getTime()) / 86_400_000);
}

function formatImportantDaysBit(items: MorningBriefingImportantDay[]): string {
  const bits = items.slice(0, 3).map((d) => {
    const label = importantDayTypeLabel(d.type);
    if (d.daysUntil === 0) return `今天就是${d.name}的${label}`;
    if (d.daysUntil === 1) return `明天是${d.name}的${label}`;
    return `${d.name}的${label}（${d.date}）还有${d.daysUntil}天`;
  });
  return `近期重要日子：${bits.join("、")}。`;
}

function countChineseChars(text: string): number {
  const matches = text.match(/[一-龥]/g);
  return matches ? matches.length : 0;
}

/** 待办跟进块上限：未完成事项最多播报条数 */
const TODO_FOLLOWUPS_MAX = 3;/** 单条未完成事项的展示截断长度 */
const TODO_FOLLOWUPS_ITEM_MAX_CHARS = 30;

/**
 * 剥掉记忆槽位行头部连续的内部标签（[时间戳][topic:…][fast-path][decay]
 * [语义类][Agent 承诺/结论]…），只留正文。标签层数不固定，循环剥到头。
 */
function stripMemoryLineMeta(line: string): string {
  let text = line.trim();
  while (/^\[[^\]]*\]\s*/.test(text)) {
    text = text.replace(/^\[[^\]]*\]\s*/, "");
  }
  return text.trim();
}

function formatTodoFollowupsBit(todo: MorningBriefingTodoFollowups): string {
  const bits: string[] = [];
  if (todo.pending.length > 0) {
    bits.push(`你之前交代的事还有 ${todo.pending.length} 件没办：${todo.pending.join("、")}`);
  }
  if (todo.doneTodayCount > 0) {
    bits.push(`今天已完成 ${todo.doneTodayCount} 件安排`);
  }
  return bits.length > 0 ? `${bits.join("；")}。` : "";
}

/**
 * 把简报结构化事实压成润色 prompt 的「事实材料」块（每行一条，只含真实数据，
 * 不含任何措辞润色——语气交给 LLM，事实只来自这里）。
 */
export function buildNarrationFacts(briefing: MorningBriefing): string {
  const lines: string[] = [];
  // DDL 放在最前：今天截止比日程更硬，模型看到的第一条应是最紧的事
  const ddl = briefing.deadlines;
  if (ddl && ddl.today.length > 0) {
    lines.push(
      `今天截止（必须说）：${ddl.today
        .map((i) => {
          const d = new Date(i.dueAt);
          const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          return `${hm} ${i.title}${i.overdue ? "（已过点）" : ""}`;
        })
        .join("；")}`,
    );
  }
  if (ddl && ddl.soon.length > 0) {
    lines.push(
      `这两三天内还要交（只需提一句件数，不逐条念）：${ddl.soon
        .map((i) => i.title)
        .join("、")}`,
    );
  }
  if (briefing.todaySchedule.length > 0) {
    lines.push(
      `今日日程：${briefing.todaySchedule
        .slice(0, 5)
        .map((s) => (s.time ? `${s.time} ${s.title}` : s.title))
        .join("；")}`,
    );
  }
  const todo = briefing.todoFollowups;
  if (todo) {
    if (todo.pending.length > 0) {
      lines.push(`之前交代还没办的事：${todo.pending.join("；")}`);
    }
    if (todo.doneTodayCount > 0) lines.push(`今天已完成安排：${todo.doneTodayCount}件`);
  }
  if (briefing.pendingNotes.length > 0) {
    lines.push(
      `未复习笔记：${briefing.pendingNotes.length}条（${briefing.pendingNotes
        .slice(0, 3)
        .map((n) => n.title)
        .join("、")}）`,
    );
  }
  const hits = briefing.interestHits ?? [];
  if (hits.length > 0) {
    lines.push(`关注话题上热搜：${hits.map((h) => h.title).join("、")}`);
  }
  const travel = briefing.travel;
  if (travel) {
    const first = travel.firstStop;
    lines.push(
      `今天在${travel.destination}的行程「${travel.title}」里` +
        (first ? `，第一站 ${first.startTime} ${first.name}` : "") +
        (travel.packing.length > 0 ? `；记得带${travel.packing.join("、")}` : ""),
    );
  }
  const days = briefing.upcomingImportantDays ?? [];
  if (days.length > 0) {
    lines.push(
      `近期重要日子：${days
        .slice(0, 3)
        .map(
          (d) =>
            `${d.name}的${importantDayTypeLabel(d.type)}` +
            (d.daysUntil === 0 ? "（就是今天）" : d.daysUntil === 1 ? "（明天）" : `（还剩${d.daysUntil}天）`),
        )
        .join("；")}`,
    );
  }
  if (briefing.appellation) lines.push(`对用户的称呼：${briefing.appellation}`);
  return lines.length > 0 ? lines.join("\n") : "（今天没有任何日程、待办或资讯）";
}

/** 润色 prompt：小而克制的单次调用——事实只来自材料，语气口语化、有温度 */
export function buildNarrationPrompt(briefing: MorningBriefing): string {
  return [
    "你是用户的私人智能管家。写一段今早的简报播报稿，像熟人的贴心助手随口在耳边说几句，不是新闻播音。",
    "",
    "事实材料（只能用这些信息，禁止编造任何日程、数字或事件）：",
    buildNarrationFacts(briefing),
    "",
    "要求：",
    "1. 口语、自然，像熟人随口聊；可贴合材料内容带半句贴心话（比如下雨记得带伞）。",
    "2. 禁止官方腔和播音腔：不要「为您播报」「请注意」「以下是今日」这类词。",
    "3. 不要问候语、不要日期星期（卡片抬头已有）；直接从内容说起。",
    "4. 时间一律原样保留 HH:mm 写法（如 09:30）。",
    "5. 只说材料里有的板块；材料为空就轻松地说今天没什么安排。",
    "5.1 材料里有「今天截止」的必须说出来（最紧的事，通常放第一句），超过两件只说最紧的一件加一共几件；「这两天还要交」的只带一句件数，不逐条念，也不要用「切记」「别忘了」催促腔。",
    "6. 禁止空话和客套收尾：不许出现「祝你今天顺利」「我随时在这儿」「想起来喊我一声」「有事随时找我」这类句子；也不许模糊地提「你之前交代的事」「我一直给你留着」——要提待办就说出材料里的具体事项，没有具体事项就一个字都不提。",
    "7. 篇幅由内容决定：有几条说几句，宁短勿凑，全文不超过 140 字，1~4 句。",
    "8. 直接输出播报稿正文，不要引号、前缀或任何解释。",
  ].join("\n");
}

/** 清洗 LLM 输出：去围栏/引号/换行，只留正文一行；协议标记确定性剥除 */
export function sanitizeNarrationText(raw: string): string {
  let text = (raw ?? "").trim();
  const fenced = text.match(/```(?:[a-z]*)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  // 直出出口收口：简报润色是绕过聊天管线的 LLM 出口，不能只靠
  // ephemeralTurn 不注入协议的单点防御（2026-09-24 晨报泄漏教训）。
  text = stripProtocolMarkersForDirectOut(text);
  text = text.replace(/\s*\n+\s*/g, " ").trim();
  // 去掉成对包裹引号
  text = text.replace(/^[「"'“”]+/, "").replace(/[」"'“”]+$/, "").trim();
  return text;
}

export class MorningBriefingService {
  /** 当天命中回调去重表：sessionId|id → 最后触发日期（每日至多回调一次） */
  private readonly importantDayFired = new Map<string, string>();
  /** 恶劣天气预警去重表：sessionId → 最后触发日期（每日至多回调一次） */
  private readonly severeWeatherFired = new Map<string, string>();

  constructor(private readonly deps: MorningBriefingDeps = {}) {}

  async generateBriefing(sessionId: string): Promise<MorningBriefing> {
    const prefs = this.deps.getSessionPrefs?.(sessionId);
    const sections = prefs?.morningBriefing.sections ?? {
      schedule: true,
      notes: true,
    };

    // 天气抓取仅供恶劣天气预警检测（结果不再进简报内容，2026-10-16 迁往睡前提醒）
    const [weather, todaySchedule, pendingNotes, interestHits] = await Promise.all([
      this.fetchWeather(sessionId).catch(() => null),
      sections.schedule ? this.fetchTodaySchedule(sessionId) : Promise.resolve([]),
      sections.notes ? this.fetchPendingNotes(sessionId) : Promise.resolve([]),
      // 第四源：兴趣热搜命中（可选块；失败/无命中 → 空数组 → 省略该块）
      this.fetchInterestHits(sessionId).catch(() => [] as MorningBriefingInterestHit[]),
    ]);

    // 恶劣天气预警联动（Task 15 生活节律）：晨报生成时检测当日预警
    // （确定性规则：暴雨/雷暴/冻雨/大雪/高温/寒潮/大风）→ 预警命中且
    // 当日有日程时回调一次（装配层接 ProactivityHub weather_alert 合并提醒，
    // 内部按日去重，30min 频控冷却由 FrequencyGovernor 兜底）。
    if (weather) {
      const alerts = detectSevereWeatherAlerts({
        weatherCode: weather.weatherCode,
        weatherText: weather.condition,
        maxC: weather.maxC,
        minC: weather.minC,
        windKmh: weather.windKmh,
      });
      if (alerts.length > 0 && todaySchedule.length > 0) {
        this.fireSevereWeatherAlert(sessionId, alerts, todaySchedule.length);
      }
    }

    // 第五源：近期重要日子（7 天窗口，确定性读取 KV，无 LLM）。
    // 当天命中（daysUntil=0）→ onImportantDayToday 回调（装配层接祝福草稿 +
    // ProactivityHub life_reminder），内部按日去重保证每日至多触发一次。
    const upcomingImportantDays = this.fetchUpcomingImportantDays(sessionId);
    for (const day of upcomingImportantDays) {
      if (day.daysUntil === 0) this.fireImportantDayToday(sessionId, day);
    }

    // 用户称呼（确定性读取 KV，无 LLM）：问候语用
    const appellation = this.resolveAppellation(sessionId);

    // 待办跟进（确定性读取，无 LLM）：之前交代未完成 + 今日已办结
    const todoFollowups = this.fetchTodoFollowups(sessionId);

    // 第六源：行程段（确定性读行程仓库，无 LLM）——今天落在某份行程区间内
    // → 当天第一站 + 天气叮嘱（行前主动提醒）
    const travel = await this.fetchTravelToday().catch(() => null);

    // 第七源：DDL（确定性扫描，无 LLM）——今天截止置顶、这周还要交的只汇总一行。
    // 大学生线三级梯度的 L3/L1 档（L2 在明日速览卡，不在晨报重复）。
    const deadlines = this.fetchDeadlines(sessionId);

    return {
      date: todayIsoDate(),
      todaySchedule,
      pendingNotes,
      // 无命中时省略该字段（可选块）
      ...(interestHits.length > 0 ? { interestHits } : {}),
      // 待办跟进（可选块）：全空时省略
      ...(todoFollowups ? { todoFollowups } : {}),
      // 无近期日子时省略该字段（可选块）
      ...(upcomingImportantDays.length > 0 ? { upcomingImportantDays } : {}),
      // 行程段（可选块）：无进行中行程时省略
      ...(travel ? { travel } : {}),
      // DDL（可选块）：两档皆空时省略
      ...(deadlines ? { deadlines } : {}),
      // 用户称呼（可选）：无称呼时省略该字段
      ...(appellation ? { appellation } : {}),
      agentGreeting: MORNING_GREETING,
    };
  }

  /** DDL 取数：radar 未注入 / 抛错 / 两档皆空 → null（整块省略） */
  private fetchDeadlines(sessionId: string): MorningBriefingDeadlines | null {
    if (!this.deps.ddlRadar) return null;
    try {
      const { today, soon } = this.deps.ddlRadar.forMorning(sessionId);
      if (today.length === 0 && soon.length === 0) return null;
      return { today, soon };
    } catch {
      return null;
    }
  }

  /** 行程段取数：今天 ∈ [startDate, endDate] 的最近一份行程 → 当天第一站 */
  private async fetchTravelToday(): Promise<MorningBriefingTravel | null> {
    const two = (v: number): string => v.toString().padStart(2, "0");
    const now = new Date();
    const today =
      `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
    const summaries = travelPlanStore.listSummaries(20);
    for (const s of summaries) {
      if (s.startDate > today || s.endDate < today) continue;
      const plan = travelPlanStore.get(s.planId);
      if (!plan) continue;
      const day =
        plan.days.find((d) => d.date === today) ?? plan.days[0] ?? null;
      const first = day?.items[0] ?? null;
      // startTime 可能是 "HH:mm" 或 "YYYY-MM-DDTHH:mm:00"，统一抽出 HH:mm
      const raw = first?.startTime ?? "";
      const m = /(\d{1,2}:\d{2})/.exec(raw);
      return {
        planId: plan.planId,
        title: plan.title,
        destination: plan.destination,
        firstStop: first
          ? { name: first.name, startTime: m ? m[1]! : raw }
          : null,
        weather: plan.weather ?? null,
        packing: (plan.packing ?? []).slice(0, 3),
      };
    }
    return null;
  }

  async narrateBriefing(sessionId: string): Promise<MorningBriefingNarration> {
    const briefing = await this.generateBriefing(sessionId);
    const narrationText =
      (await this.polishNarration(briefing)) ?? this.composeNarration(briefing);
    return { narrationText, briefing };
  }

  /**
   * 播报稿口语润色（单次小 LLM 调用）：输入确定性事实材料，输出有温度的
   * 口语稿。失败/输出为空/中文字数超 200（预算失控视为不可信）→ 返回 null，
   * 调用方回退确定性模板（composeNarration），绝不阻塞简报。
   * 2026-09-24：不再给短稿补「祝你今天顺利」垫尾——篇幅由内容定，宁短勿凑。
   */
  private async polishNarration(briefing: MorningBriefing): Promise<string | null> {
    const llmComplete = this.deps.llmComplete;
    if (!llmComplete) return null;
    try {
      const text = sanitizeNarrationText(await llmComplete(buildNarrationPrompt(briefing)));
      if (!text) return null;
      const cn = countChineseChars(text);
      if (cn > 200) return null;
      return text;
    } catch (err) {
      console.log(`[MorningBriefing] 播报稿 LLM 润色失败（回退模板）: ${err}`);
      return null;
    }
  }

  private async fetchWeather(sessionId: string): Promise<MorningBriefingWeather | null> {
    const { weatherService, weatherPrefsService } = this.deps;
    if (!weatherService) return null;

    // 坐标来源优先级：用户配置的天气城市 > 客户端 GPS（实时/缓存） >
    // 出口 IP 定位（后端直接拉取；均确定性 HTTP/WS，无 LLM）。
    const prefs = weatherPrefsService?.get(sessionId);
    let latitude: number;
    let longitude: number;
    let timezone: string;
    let label: string | undefined;
    const clientLocation = prefs ? null : await this.fetchClientLocation(sessionId);
    if (prefs) {
      latitude = prefs.latitude;
      longitude = prefs.longitude;
      timezone = prefs.timezone || "Asia/Shanghai";
      label = prefs.label;
    } else if (clientLocation) {
      latitude = clientLocation.latitude;
      longitude = clientLocation.longitude;
      timezone = clientLocation.timezone || "Asia/Shanghai";
      label = clientLocation.label || clientLocation.city || undefined;
    } else {
      const ipLocation = await fetchIPLocation();
      if (!ipLocation) return null;
      latitude = ipLocation.latitude;
      longitude = ipLocation.longitude;
      timezone = ipLocation.timezone;
      label = ipLocation.label || undefined;
    }

    try {
      const brief = await weatherService.getBrief(latitude, longitude, timezone, label);
      return {
        temperature: brief.currentTempC,
        condition: brief.weatherText,
        description: brief.summaryLine,
        // Task 15 预警检测要素（weather-code / 温度极值 / 风速）
        weatherCode: brief.weatherCode,
        maxC: brief.todayMaxC,
        minC: brief.todayMinC,
        windKmh: brief.windKmh,
      };
    } catch {
      return null;
    }
  }

  /** 客户端定位（GPS）：失败/离线/拒绝 → null（调用方继续走 IP 兜底） */
  private async fetchClientLocation(
    sessionId: string,
  ): Promise<
    | { latitude: number; longitude: number; label?: string; city?: string; timezone?: string }
    | null
  > {
    try {
      return (await this.deps.requestClientLocation?.(sessionId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 今日日程（真实当日数据）：按本日 00:00–24:00 区间过滤（与 /api/schedule
   * today 一致），只播报今天确有实例的任务；时间格式化为本地 HH:mm
   * （此前直接拼 nextRunAt 原始 ISO 串，播报稿/卡片会读出整串时间戳）。
   * 与「今日安排」展示同规则剔除琐事类任务（睡觉/喝水等 trivia 分类、
   * 节律标记旧数据）——简报只播开会、通知这类正经日程。
   */
  private async fetchTodaySchedule(sessionId: string): Promise<MorningBriefingScheduleItem[]> {
    const { scheduleTaskService } = this.deps;
    if (!scheduleTaskService) return [];
    try {
      const tasks = scheduleTaskService
        .listTasksBySession(sessionId, todayLocalRange())
        .filter((t) => !isTriviaTask(t));
      return tasks.slice(0, 10).map((t) => ({
        id: t.taskId,
        title: t.reminderMessage || t.title || "",
        time: formatHhmm(
          t.status === "completed" ? (t.lastRunAt ?? t.runAt) : (t.nextRunAt ?? t.runAt),
        ),
      }));
    } catch {
      return [];
    }
  }

  private async fetchPendingNotes(sessionId: string): Promise<MorningBriefingPendingNote[]> {
    const { notesService } = this.deps;
    if (!notesService) return [];
    try {
      const notes = notesService.listNotes({ sessionId, limit: 10 });
      return notes
        .filter((n) => (n.reviewCount ?? 0) === 0)
        .slice(0, 5)
        .map((n) => ({ id: n.id, title: n.title }));
    } catch {
      return [];
    }
  }

  /**
   * 待办跟进（确定性读取，无 LLM）：
   *  - pending：记忆 KV memory_open_loops（待办/承诺槽位，行格式
   *    「[时间戳] [话题] 正文」，追加序尾部最新）最新 3 条，剥前缀只留正文；
   *  - doneTodayCount：今日已办结的日程/提醒数（status=completed 且
   *    完成时间在今天）。
   * 两项全空 → null（省略该块）。
   */
  private fetchTodoFollowups(sessionId: string): MorningBriefingTodoFollowups | null {
    const pending = this.fetchOpenLoops(sessionId);
    const doneTodayCount = this.fetchDoneTodayCount(sessionId);
    if (pending.length === 0 && doneTodayCount <= 0) return null;
    return { pending, doneTodayCount };
  }

  private fetchOpenLoops(sessionId: string): string[] {
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return [];
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, [
        "memory_open_loops",
      ]);
      const raw = typeof entries.memory_open_loops === "string" ? entries.memory_open_loops : "";
      return raw
        .split("\n")
        .filter(Boolean)
        // fast-path 写入时决策为 decay 的行 = 判定为临时/易衰减内容，
        // 不作为「待办」呈给用户（2026-09-24：此前剥不净标签还截断成乱码，
        // 正是播报稿含糊提「之前交代的事」的诱因）。
        .filter((line) => !line.includes("[fast-path][decay]"))
        .slice(-TODO_FOLLOWUPS_MAX)
        .reverse()
        .map((line) => stripMemoryLineMeta(line).slice(0, TODO_FOLLOWUPS_ITEM_MAX_CHARS))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private fetchDoneTodayCount(sessionId: string): number {
    const { scheduleTaskService } = this.deps;
    if (!scheduleTaskService) return 0;
    try {
      // 本地当日区间比对（ISO 串是 UTC，按 UTC 日期前缀比对会漏计早晨完成的）
      const now = new Date();
      const dayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).getTime();
      const dayEnd = dayStart + 86_400_000;
      return scheduleTaskService
        .listAllTasks()
        .filter((t) => {
          if (t.sessionId !== sessionId || t.status !== "completed") return false;
          // 与「今日安排」同口径：琐事提醒（睡觉/喝水等）不算进"已完成安排"
          if (isTriviaTask(t)) return false;
          const doneAtMs = new Date(t.lastRunAt ?? t.runAt ?? "").getTime();
          return Number.isFinite(doneAtMs) && doneAtMs >= dayStart && doneAtMs < dayEnd;
        })
        .length;
    } catch {
      return 0;
    }
  }

  /**
   * 第五源：近期重要日子（确定性，无 LLM）。
   * 读 KV important_dates（care.set_important_date 写入），过滤 7 天窗口内
   * 的年度周期日子，按剩余天数升序取前 5 条。存储缺失/格式异常 → 空数组（省略该块）。
   */
  private fetchUpcomingImportantDays(sessionId: string): MorningBriefingImportantDay[] {
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return [];
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, ["important_dates"]);
      const records = Array.isArray(entries.important_dates) ? entries.important_dates : [];
      const now = new Date();
      const days: MorningBriefingImportantDay[] = [];
      for (const r of records) {
        const rec = r as {
          id?: unknown;
          name?: unknown;
          date?: unknown;
          type?: unknown;
          relationship?: unknown;
          notes?: unknown;
        };
        if (typeof rec.name !== "string" || !rec.name.trim()) continue;
        if (typeof rec.date !== "string") continue;
        const daysUntil = daysUntilMMdd(rec.date, now);
        if (daysUntil < 0 || daysUntil > UPCOMING_DAYS_WINDOW) continue;
        days.push({
          id: typeof rec.id === "string" && rec.id ? rec.id : `${rec.name}|${rec.date}`,
          name: rec.name.trim(),
          date: rec.date,
          type:
            rec.type === "anniversary" || rec.type === "custom" ? rec.type : "birthday",
          ...(typeof rec.relationship === "string" && rec.relationship.trim()
            ? { relationship: rec.relationship.trim() }
            : {}),
          ...(typeof rec.notes === "string" && rec.notes.trim() ? { notes: rec.notes.trim() } : {}),
          daysUntil,
        });
      }
      return days.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, UPCOMING_DAYS_MAX);
    } catch {
      return [];
    }
  }

  /**
   * 用户称呼：与首启向导/聊天面同源——factStore 的「称呼」字段（agent 叫
   * 用户的称呼，如「王哥」），交给共享的 resolvePoliteAppellation 做得体化
   * （用户指定优先；大名转「王先生」式称呼——问候绝不直呼大名）。
   * factStore 未装配/无记录时兜底读记忆同步 KV 的 user_profile「称呼」行；
   * 都取不到 → 空串（省略该字段，问候不带称呼，也绝不回退成大名，更绝不
   * 回退账号 displayName——那是 agent 的网络名）。
   */
  private resolveAppellation(sessionId: string): string {
    try {
      const fact = this.deps.factStore?.getFact(sessionId, "称呼");
      const value = fact?.value?.trim();
      if (value) return resolvePoliteAppellation(value);
    } catch {
      /* fall through 到 KV 兜底 */
    }
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return "";
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, [
        "user_profile",
      ]);
      const profile = entries.user_profile;
      if (typeof profile !== "string") return "";
      const m = profile.match(/^\s*(?:[-*]\s*)?称呼[：:]\s*(.+)$/m);
      if (!m) return "";
      return resolvePoliteAppellation(m[1]);
    } catch {
      return "";
    }
  }

  /** 当天命中回调（每日去重）：sessionId|id → 今日已触发则跳过，防止多次生成简报重复打扰 */
  private fireImportantDayToday(sessionId: string, day: MorningBriefingImportantDay): void {
    const key = `${sessionId}|${day.id}`;
    const today = todayIsoDate();
    if (this.importantDayFired.get(key) === today) return;
    this.importantDayFired.set(key, today);
    try {
      this.deps.onImportantDayToday?.(sessionId, day);
    } catch (err) {
      console.log(`[MorningBriefing] 重要日子回调失败（忽略）: ${err}`);
    }
  }

  /** 恶劣天气预警回调（每日去重）：同日多次生成简报只提醒一次 */
  private fireSevereWeatherAlert(
    sessionId: string,
    alerts: string[],
    scheduleCount: number,
  ): void {
    const today = todayIsoDate();
    if (this.severeWeatherFired.get(sessionId) === today) return;
    this.severeWeatherFired.set(sessionId, today);
    try {
      this.deps.onSevereWeatherAlert?.(sessionId, alerts, scheduleCount);
    } catch (err) {
      console.log(`[MorningBriefing] 恶劣天气预警回调失败（忽略）: ${err}`);
    }
  }

  /**
   * 第四源：当日兴趣热搜命中。
   * 读 data/interest-watch.json 中该 actor 的兴趣列表（字段结构同
   * proactivity/interest-watcher.ts 的 WatchInterest；actorId 缺省时与 sessionId
   * 同值，见 agent/actor-id.ts 的回退规则），拉一次实时热搜聚合后做简单
   * includes 匹配（归一化后 title 包含兴趣名），按榜单顺序最多取 3 条。
   * 用户要求：不要今日热搜兜底——未配置兴趣/当日无命中/拉取失败 →
   * 空数组（省略该块）。
   */
  private async fetchInterestHits(sessionId: string): Promise<MorningBriefingInterestHit[]> {
    const path =
      this.deps.interestWatchPath ??
      process.env.INTEREST_WATCH_FILE ??
      join(getDataDir(), "interest-watch.json");

    // 兴趣池文件不存在（用户从未设置兴趣）→ 直接省略，不触发网络请求
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }

    const interests = this.readInterestNames(raw, sessionId);
    if (interests.length === 0) return [];

    const { items } = await fetchHotRankings(INTEREST_HITS_FETCH_LIMIT);
    if (items.length === 0) return [];

    const hits: MorningBriefingInterestHit[] = [];
    const seenTitles = new Set<string>();
    for (const item of items) {
      if (hits.length >= INTEREST_HITS_MAX) break;
      const titleFp = normalizeFp(item.title);
      if (!titleFp || seenTitles.has(titleFp)) continue;
      const matched = interests.find((name) => {
        const fp = normalizeFp(name);
        return fp.length >= 2 && titleFp.includes(fp);
      });
      if (!matched) continue;
      seenTitles.add(titleFp);
      hits.push({
        interest: matched,
        title: item.title,
        platform: item.platform,
        ...(item.url ? { url: item.url } : {}),
        ...(item.hot ? { hot: item.hot } : {}),
      });
    }
    return hits;
  }

  /** 解析兴趣池文件，取该 actor 启用中的兴趣名（列表按 lastSeenAt 倒序，近期兴趣优先命中） */
  private readInterestNames(rawJson: string, actorId: string): string[] {
    try {
      const data = JSON.parse(rawJson) as {
        interests?: Array<{
          actorId?: string;
          name?: unknown;
          enabled?: boolean;
          lastSeenAt?: number;
        }>;
      };
      return (data.interests ?? [])
        .filter(
          (i) =>
            i &&
            i.actorId === actorId &&
            i.enabled !== false &&
            typeof i.name === "string" &&
            i.name.trim().length >= 2,
        )
        .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
        .map((i) => (i.name as string).trim());
    } catch {
      return [];
    }
  }

  private composeNarration(briefing: MorningBriefing): string {
    const parts: string[] = [];
    // 播报稿对齐设计稿（design/daily-briefing-floating.html）：问候与日期由
    // 卡片头（greeting/meta 行）展示，正文直接从内容开始，不再重复
    // 「下午好，今天9月10日周四」。天气/穿衣已迁往睡前提醒，不再进播报稿。

    // DDL（第七源）：今天截止要置顶——比日程更硬，先说要交什么
    const ddlBit = formatDeadlinesBit(briefing.deadlines);
    if (ddlBit) parts.push(ddlBit);

    if (briefing.todaySchedule.length > 0) {
      parts.push(formatScheduleBit(briefing.todaySchedule));
    }

    // 待办跟进（可选块）：之前交代未完成 + 今日已办结——简报不只播新闻，
    // 还要回报用户交办事宜的进展
    const todo = briefing.todoFollowups;
    if (todo) {
      const todoBit = formatTodoFollowupsBit(todo);
      if (todoBit) parts.push(todoBit);
    }

    if (briefing.pendingNotes.length > 0) {
      parts.push(formatNotesBit(briefing.pendingNotes));
    }

    // 第四源：兴趣热搜命中（可选块，无命中时整体省略）
    const interestHits = briefing.interestHits ?? [];
    if (interestHits.length > 0) {
      parts.push(formatInterestHitsBit(interestHits));
    }

    // 第五源：近期重要日子（可选块，无记录时整体省略）
    const upcomingDays = briefing.upcomingImportantDays ?? [];
    if (upcomingDays.length > 0) {
      parts.push(formatImportantDaysBit(upcomingDays));
    }

    // 第六源：行程段（可选块）——今天在行程中 → 第一站提醒
    const travel = briefing.travel;
    if (travel) {
      const first = travel.firstStop;
      parts.push(
        `今天在${travel.destination}的行程继续` +
          (first ? `，第一站 ${first.startTime} 是${first.name}` : "") +
          (travel.packing.length > 0 ? `，记得带${travel.packing.join("、")}` : ""),
      );
    }

    // 全空（个人数据源都没配置/没命中）→ 明确说明，不输出空荡荡的纯问候
    if (parts.length === 0) {
      parts.push("今天日程空空的，可以轻松点过。");
    }

    // 2026-09-24 用户定调：没有事情就到这儿为止——不再追加「祝你今天顺利」
    // 「我随时在这儿」这类客套垫话，说完事实即收；仅保留超长截断防播报失控。
    let text = parts.join("").trim();
    if (countChineseChars(text) > 150) {
      text = `${text.slice(0, 149).trimEnd()}…`;
    }
    return text;
  }
}

/**
 * 祝福草稿生成（Task 17 人情关系管家）：单次 LLM 调用，
 * 输入 = 关系标签 + 交往摘要（notes）+ 日子类型；LLM 未注入/失败时
 * 退化为确定性模板草稿（克制原则：草稿一次 LLM，绝不阻塞提醒主链路）。
 * 生成后由装配层作为 life_reminder 提醒内容附带，供用户改写后发送。
 */
export async function generateImportantDayBlessing(
  day: MorningBriefingImportantDay,
  llmComplete?: (prompt: string) => Promise<string>,
): Promise<string> {
  const label = importantDayTypeLabel(day.type);
  const rel = day.relationship?.trim() || "亲友";
  const deterministic = `祝${day.name}${label}快乐！愿你往后的日子平安顺遂，开心的事源源不断。`;

  if (!llmComplete) return deterministic;
  try {
    const prompt =
      `你是用户的私人生活管家。今天（${day.date}）是用户${rel}「${day.name}」的${label}。` +
      `请以用户的口吻代拟一条发给${day.name}的祝福，要求：` +
      `1）1 到 3 句话，真诚自然，不用华丽套话；` +
      `2）尽量结合这份背景信息（没有就自然带过）：${day.notes ?? "（无备注）"}；` +
      `3）直接输出祝福正文，不要任何解释、引号或前后缀。`;
    const text = (await llmComplete(prompt))?.trim();
    return text || deterministic;
  } catch (err) {
    console.log(`[MorningBriefing] 祝福草稿 LLM 生成失败（退化为模板）: ${err}`);
    return deterministic;
  }
}
