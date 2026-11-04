/**
 * 早间简报聚合服务：**只回答「今天怎么安排」**，把今天的所有硬信息合并成一栏。
 *
 * 依赖为可选 —— 当宿主未注入对应服务时返回占位数据，
 * 保证该服务可独立实例化与调用。
 *
 * 2026-10-16：天气与穿衣建议移出早间简报（迁往睡前提醒 EveningDigest）；
 * 本服务仅保留内部天气抓取供恶劣天气预警检测（onSevereWeatherAlert 联动）。
 *
 * 2026-11-04 用户拍板的信息分层（本文件据此收敛，只剩两个内容块）：
 *  - 「今日日程」= 普通日程 + 今天截止的 DDL + 在途行程当天第一站，**三源合并**
 *    成一栏按时间排序（此前 DDL/行程只进播报稿、卡面上看不见）；
 *  - 「待办跟进」= 之前交代还没办的事；
 *  - 兴趣热搜 → 归话题追踪模块（proactivity/interest-watcher.ts 后台轮询 +
 *    ProactivityHub 主动在对话里说出来），晨报不再重复播；
 *  - 待复习笔记 → 删除（没人看的复习队列，纯占版面）；
 *  - 近期重要日子 → 迁往「明日速览」（evening-digest-service.ts）；本服务只保留
 *    「当天命中 → 祝福草稿 + life_reminder」的副作用，不再展示。
 */
import { isTriviaTask } from "./schedule-task-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";
import { resolvePoliteAppellation } from "./user-personalization/appellation.js";
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";
import { stripProtocolMarkersForDirectOut } from "./reply-envelope.js";
import { dropExpiredCommitmentLines } from "./memory-record-utils.js";
import {
  importantDayTypeLabel,
  daysUntilMMdd,
  readUpcomingImportantDays,
  type ImportantDay,
  type ImportantDaysStoreLike,
} from "./important-days-shared.js";
import type { UserPreferences } from "../routes/http/user-preferences.js";
import type { DdlItem } from "./ddl-radar-service.js";

// 兼容存量导入方（测试/装配层沿用晨报命名），口径统一由 important-days-shared 提供
export type MorningBriefingImportantDay = ImportantDay;
export { importantDayTypeLabel, daysUntilMMdd };
export type { ImportantDaysStoreLike };

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
  /**
   * 条目来源（2026-11-04 三源合并进「今日日程」一栏）：
   *  - schedule：普通日程（默认，存量数据不带该字段按此处理）
   *  - deadline：今天到期 / 已过点的 DDL（比日程更硬，标题由展示端加「截止：」前缀）
   *  - travel：在途行程的当天第一站（仅手机端，标题由展示端加「行程：」前缀）
   */
  kind?: "schedule" | "deadline" | "travel";
  /** 附加说明（如截止项「已过点」），无则不出现 */
  note?: string;
}

/**
 * 待办跟进（可选块）：今日简报不只播新闻，还要回报"之前交代的事"。
 *  - pending：记忆 KV memory_open_loops（待办/承诺槽位）里还没完成的事，
 *    最新在前，最多 3 条（已剥掉时间戳/话题前缀与内部口径前缀）；
 *  - doneTodayCount：今天已办结的日程/提醒数。
 * 全空 → 省略该字段。
 */
export interface MorningBriefingTodoFollowups {
  pending: string[];
  doneTodayCount: number;
}

/**
 * 晨报生成选项。
 * in-progress 行程（今天落在行程区间内）的消息与提醒只投手机端，
 * 电脑端每日简报不带行程条目——默认 false，仅手机端 / 手机启动简报显式开启。
 */
export interface MorningBriefingOptions {
  includeInProgressTravel?: boolean;
}

export interface MorningBriefing {
  date: string;
  /**
   * 今日日程（2026-11-04 三源合并）：普通日程 + 今天截止的 DDL + 在途行程第一站，
   * 按时刻升序（无时刻的排最后）。DDL 与行程不再有独立块，也不再只活在播报稿里。
   */
  todaySchedule: MorningBriefingScheduleItem[];
  /** 待办跟进（可选块）：之前交代的未完成事项 + 今日已办结数；全空时省略 */
  todoFollowups?: MorningBriefingTodoFollowups;
  /**
   * 2~3 天内到期的 DDL 件数（可选）：只在播报稿里带一句「这周还有 N 项要交」，
   * 不上卡（卡面「今日日程」只收今天的事）。0 / 缺省 → 不提。
   */
  deadlineSoonCount?: number;
  /** 用户称呼（可选）：记忆「称呼」行的得体称呼（用户指定优先，大名→「王先生」式）；问候语用 */
  appellation?: string;
  agentGreeting: string;
}

export interface MorningBriefingNarration {
  /** 口语化文本（供 TTS 播报） */
  narrationText: string;
  /** 结构化简报 */
  briefing: MorningBriefing;
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
  /** 重要日子存储（读 care.set_important_date 写入的 important_dates KV；仅供当日命中祝福回调） */
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
 * 条目的口语化说法（播报稿用）：截止/行程各有自己的说法，
 * 普通日程走「时刻的标题」——三源合进一栏后不能都套一个句式。
 */
function narrationItemLabel(item: MorningBriefingScheduleItem): string {
  if (item.kind === "deadline") {
    if (item.note === "已过点") return `《${item.title}》已经过点`;
    return item.time ? `${item.time} 前要交《${item.title}》` : `今天要交《${item.title}》`;
  }
  if (item.kind === "travel") {
    return item.time ? `${item.time} 出发去${item.title}` : `今天的行程是${item.title}`;
  }
  return item.time ? `${item.time}的${item.title}` : item.title;
}

function formatScheduleBit(items: MorningBriefingScheduleItem[]): string {
  const top = items.slice(0, 3);
  const rest = items.length - top.length;
  const bits = top.map(narrationItemLabel);
  let sentence = `今天有${top.length}个安排：${bits.join("、")}。`;
  if (rest > 0) {
    sentence = `${sentence}另外还有${rest}项可以晚点再看。`;
  }
  return sentence;
}

/** 「这周还有 N 项要交」一句（DDL soon 档只在播报稿带一句，不上卡） */
function formatDeadlineSoonBit(count: number | undefined): string {
  if (!count || count <= 0) return "";
  return `这两三天内还有 ${count} 项要交。`;
}

/** 合并后的今日条目上限（截止+行程+日程一起算，防一屏刷不完） */
const TODAY_SCHEDULE_MAX = 12;

/**
 * 三源合并排序：按时刻升序（无时刻的排最后），并钳总量。
 * 「HH:mm」定长字符串可直接字典序比较，无需解析成时间。
 */
function sortScheduleItems(items: MorningBriefingScheduleItem[]): MorningBriefingScheduleItem[] {
  return [...items]
    .sort((a, b) => {
      const ta = a.time ?? "";
      const tb = b.time ?? "";
      if (ta === tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta.localeCompare(tb);
    })
    .slice(0, TODAY_SCHEDULE_MAX);
}

function countChineseChars(text: string): number {
  const matches = text.match(/[一-龥]/g);
  return matches ? matches.length : 0;
}

/** 待办跟进块上限：未完成事项最多播报条数 */
const TODO_FOLLOWUPS_MAX = 3;
/**
 * 单条未完成事项的展示上限（字）。
 * 2026-11-04：原为 30 字硬截，恰好把「…以便计算最划」切在半句上；放宽到 60 字
 * 并在有截断时补省略号——卡面本来就有两行 clamp，硬截只会制造断句。
 */
const TODO_FOLLOWUPS_ITEM_MAX_CHARS = 60;

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

/** 内部记账前缀（夜间提炼写的「承诺：」、抽取文本自带的「待办：」）不面向用户 */
const INTERNAL_PREFIX_RE = /^(?:(?:承诺|待办|计划|后续|未完成|待办事项)\s*[：:]\s*)+/;

/**
 * 记忆行 → 可读的一条待办：剥标签、剥内部口径前缀、超长补省略号。
 * 反面教材（2026-11-04 用户截图）：卡面直出「承诺: 待办：用户需提供三个平台的
 * 价格和对应版本，以便计算最划」——前缀是内部记账、结尾断在半句。
 */
export function cleanOpenLoopText(line: string): string {
  const body = stripMemoryLineMeta(line).replace(INTERNAL_PREFIX_RE, "").trim();
  if (body.length <= TODO_FOLLOWUPS_ITEM_MAX_CHARS) return body;
  return `${body.slice(0, TODO_FOLLOWUPS_ITEM_MAX_CHARS - 1).trimEnd()}…`;
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
  const ddlToday = briefing.todaySchedule.filter((i) => i.kind === "deadline");
  if (ddlToday.length > 0) {
    lines.push(
      `今天截止（必须说）：${ddlToday
        .map((i) => `${i.time ?? ""} ${i.title}${i.note ? `（${i.note}）` : ""}`.trim())
        .join("；")}`,
    );
  }
  if (briefing.deadlineSoonCount && briefing.deadlineSoonCount > 0) {
    lines.push(
      `这两三天内还要交（只需提一句件数，不逐条念）：${briefing.deadlineSoonCount} 项`,
    );
  }
  const planItems = briefing.todaySchedule.filter((i) => i.kind !== "deadline");
  if (planItems.length > 0) {
    lines.push(
      `今日日程：${planItems
        .slice(0, 5)
        .map((s) => {
          if (s.kind === "travel") return `${s.time ?? ""} 在途行程 ${s.title}`.trim();
          return s.time ? `${s.time} ${s.title}` : s.title;
        })
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

  async generateBriefing(
    sessionId: string,
    options: MorningBriefingOptions = {},
  ): Promise<MorningBriefing> {
    const prefs = this.deps.getSessionPrefs?.(sessionId);
    // sections.notes 已废弃（待复习笔记整块删除，2026-11-04），只保留日程开关
    const sections = prefs?.morningBriefing.sections ?? { schedule: true, notes: false };

    // 天气抓取仅供恶劣天气预警检测（结果不再进简报内容，2026-10-16 迁往睡前提醒）
    const [weather, scheduleItems, ddlToday, ddlSoonCount, travelItem] = await Promise.all([
      this.fetchWeather(sessionId).catch(() => null),
      sections.schedule ? this.fetchTodaySchedule(sessionId) : Promise.resolve([]),
      // DDL 今天截止档：直接并进「今日日程」，不再单独成块
      Promise.resolve(this.fetchDeadlineToday(sessionId)),
      Promise.resolve(this.fetchDeadlineSoonCount(sessionId)),
      // 在途行程当天第一站：也是日程条目（仅手机端）
      options.includeInProgressTravel
        ? this.fetchTravelItem(sessionId).catch(() => null)
        : Promise.resolve(null),
    ]);

    // 三源合并：截止置前 → 行程 → 日程，整体按时刻升序（无时刻排最后）
    const todaySchedule = sortScheduleItems([
      ...ddlToday,
      ...(travelItem ? [travelItem] : []),
      ...scheduleItems,
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
      if (alerts.length > 0 && scheduleItems.length > 0) {
        this.fireSevereWeatherAlert(sessionId, alerts, scheduleItems.length);
      }
    }

    // 近期重要日子：展示位已迁往「明日速览」（2026-11-04），晨报只保留
    // 「当天命中 → 祝福草稿 + life_reminder」的副作用——祝福要在当天早上发出，
    // 挪到夜里就晚了。内部按日去重保证每日至多触发一次。
    for (const day of readUpcomingImportantDays(this.deps.agentMemorySyncService, sessionId)) {
      if (day.daysUntil === 0) this.fireImportantDayToday(sessionId, day);
    }

    // 用户称呼（确定性读取 KV，无 LLM）：问候语用
    const appellation = this.resolveAppellation(sessionId);

    // 待办跟进（确定性读取，无 LLM）：之前交代未完成 + 今日已办结
    const todoFollowups = this.fetchTodoFollowups(sessionId);

    return {
      date: todayIsoDate(),
      todaySchedule,
      // 待办跟进（可选块）：全空时省略
      ...(todoFollowups ? { todoFollowups } : {}),
      // 2~3 天内到期的件数：只在播报稿里带一句，不上卡
      ...(ddlSoonCount > 0 ? { deadlineSoonCount: ddlSoonCount } : {}),
      // 用户称呼（可选）：无称呼时省略该字段
      ...(appellation ? { appellation } : {}),
      agentGreeting: MORNING_GREETING,
    };
  }

  /**
   * DDL 今天档 → 日程条目（今天到期 / 已过点）。
   * 2026-11-04 合并：DDL 以前只活在播报稿里、卡面看不到；现在归进「今日日程」。
   */
  private fetchDeadlineToday(sessionId: string): MorningBriefingScheduleItem[] {
    if (!this.deps.ddlRadar) return [];
    try {
      const { today } = this.deps.ddlRadar.forMorning(sessionId);
      return today.map((item) => {
        const due = new Date(item.dueAt);
        const hm = Number.isFinite(due.getTime())
          ? `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`
          : "";
        return {
          id: item.id,
          title: item.title,
          kind: "deadline" as const,
          ...(hm ? { time: hm } : {}),
          ...(item.overdue ? { note: "已过点" } : {}),
        };
      });
    } catch {
      return [];
    }
  }

  /** DDL soon 档件数（2~3 天后到期）：只喂播报稿一句汇总 */
  private fetchDeadlineSoonCount(sessionId: string): number {
    if (!this.deps.ddlRadar) return 0;
    try {
      return this.deps.ddlRadar.forMorning(sessionId).soon.length;
    } catch {
      return 0;
    }
  }

  /**
   * 在途行程 → 今日日程条目（2026-11-04 合并）：今天 ∈ [startDate, endDate] 的
   * 本 actor 最近一份行程，取当天第一站。只给手机端（电脑端不响），因此由
   * includeInProgressTravel 控制是否取。
   */
  private async fetchTravelItem(actorId: string): Promise<MorningBriefingScheduleItem | null> {
    const two = (v: number): string => v.toString().padStart(2, "0");
    const now = new Date();
    const today =
      `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
    const summaries = travelPlanStore.listSummariesForActor(actorId, 20);
    for (const s of summaries) {
      if (s.startDate > today || s.endDate < today) continue;
      const plan = travelPlanStore.getForActor(actorId, s.planId);
      if (!plan) continue;
      const day =
        plan.days.find((d) => d.date === today) ?? plan.days[0] ?? null;
      const first = day?.items[0] ?? null;
      // startTime 可能是 "HH:mm" 或 "YYYY-MM-DDTHH:mm:00"，统一抽出 HH:mm
      const raw = first?.startTime ?? "";
      const m = /(\d{1,2}:\d{2})/.exec(raw);
      const title = first
        ? `${plan.destination} · ${first.name}`
        : `${plan.destination} · ${plan.title}`;
      return {
        id: `travel:${plan.planId}`,
        title,
        kind: "travel",
        ...(m ? { time: m[1]! } : {}),
        ...(first ? {} : { note: "行程日" }),
      };
    }
    return null;
  }

  async narrateBriefing(
    sessionId: string,
    options: MorningBriefingOptions = {},
  ): Promise<MorningBriefingNarration> {
    const briefing = await this.generateBriefing(sessionId, options);
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

    // 坐标来源优先级：用户配置的天气城市 > 客户端 GPS（实时/缓存）。
    // 出口 IP 定位那条兜底已删除：它拿的是**服务器出口 IP** 的城市（实证：本机 IP 落在
    // 广州、用户人在兴义；上云后更是服务器所在城市），报出来的天气与用户无关。
    // 没有用户定位 → 天气块省略，宁缺毋错。
    const prefs = weatherPrefsService?.get(sessionId);
    let latitude: number;
    let longitude: number;
    let timezone: string;
    let label: string | undefined;
    const clientLocation = prefs ? null : await this.fetchClientLocation(sessionId);
    if (prefs) {
      latitude = prefs.latitude;
      longitude = prefs.longitude;
      timezone = prefs.timezone?.trim() || "auto";
      label = prefs.label;
    } else if (clientLocation) {
      latitude = clientLocation.latitude;
      longitude = clientLocation.longitude;
      timezone = clientLocation.timezone?.trim() || "auto";
      label = clientLocation.label || clientLocation.city || undefined;
    } else {
      return null;
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
      const lines = raw
        .split("\n")
        .filter(Boolean)
        // fast-path 写入时决策为 decay 的行 = 判定为临时/易衰减内容，
        // 不作为「待办」呈给用户（2026-09-24：此前剥不净标签还截断成乱码，
        // 正是播报稿含糊提「之前交代的事」的诱因）。
        .filter((line) => !line.includes("[fast-path][decay]"));
      // 2026-11-04 老账不消失的根因修补：聊天 prompt 注入侧一直过 72h 保鲜期
      // （prompt-builder → dropExpiredCommitmentLines），早报这条读路径漏了，
      // 于是同一件「比价」的事能连播好几天。这里与 chat 同口径。
      return dropExpiredCommitmentLines(lines)
        .slice(-TODO_FOLLOWUPS_MAX)
        .reverse()
        .map(cleanOpenLoopText)
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

  private composeNarration(briefing: MorningBriefing): string {
    const parts: string[] = [];
    // 播报稿对齐设计稿（design/daily-briefing-floating.html）：问候与日期由
    // 卡片头（greeting/meta 行）展示，正文直接从内容开始，不再重复
    // 「下午好，今天9月10日周四」。天气/穿衣已迁往睡前提醒，不再进播报稿。

    // 今日日程（三源合并：截止 / 行程 / 普通日程）按时刻排好，逐条念最紧的前三条
    if (briefing.todaySchedule.length > 0) {
      parts.push(formatScheduleBit(briefing.todaySchedule));
    }

    // 2~3 天内到期的件数：一句话带过，不逐条念
    const soonBit = formatDeadlineSoonBit(briefing.deadlineSoonCount);
    if (soonBit) parts.push(soonBit);

    // 待办跟进（可选块）：之前交代未完成 + 今日已办结——简报不只播新闻，
    // 还要回报用户交办事宜的进展
    const todo = briefing.todoFollowups;
    if (todo) {
      const todoBit = formatTodoFollowupsBit(todo);
      if (todoBit) parts.push(todoBit);
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
