/**
 * 晚间 digest 服务（Task 15 场景A 生活节律）——「明日预览」。
 *
 * 2026-11-23 §3.4 分工写死（docs/prd-mobile-proactive-2026-11-23.md）：
 * **日程和截止事项只在早安出现；明日预览只讲天气，再加一两句闲聊。**
 * 于是本服务一次取数、两个出口：
 *   - digest（主动推送面）= 次日天气 / 穿衣带伞 + 一两句闲聊 + 周日作息周报，
 *     **不再列**明日行程、截止事项（DDL L2）、近期重要日子；
 *   - facts（问答数据面）= 完整明日事实（行程 + 天气 + DDL + 重要日子），
 *     只在用户主动问「明天有什么安排」时经 tomorrow-preview-bridge 注入
 *     `tomorrow_preview` 场景——那是问答不是主动推送，不受分工限制。
 *
 * 搬走的内容没有丢：重要日子（生日/纪念日）搬回早安卡
 * （MorningBriefingService.importantDays，2026-11-04 那次搬到夜里、这次按
 * §3.4 搬回去）；行程与 DDL 本来就是早安的三源合并（已有）。
 *
 * 没内容不发兜底话术（§3.4「没内容时」一行）：天气正常拿到就只发天气（有闲聊
 * 素材就加一两句）；天气拉取失败且没有闲聊素材 → narrationText 留空，调度器据此
 * 判 skipped，绝不硬凑「明天不用操心，早点睡」这类垫话。
 *
 * 送达链路不变：调度器（EveningDigestScheduler）到点触发 → 装配层
 * onDigestTriggered → WS 推送（ServerEventType.EveningDigest）。
 * 文案仍是 2026-10-13 那条定调：narrationText 唯一文案源（通知/卡片/口播共用），
 * 主路交 agent 产出、兜底走确定性模板。2026-11-06「天气不上文案」的前提（卡上
 * 有行程可说）已随分工消失，现在天气就是这一格的全部内容，文案必须说天气。
 * 2026-10-24 收敛：删「今日回顾」与「行程超支」两块（白算 + 不属睡前场景）。
 */

import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DdlItem } from "./ddl-radar-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherLocation, WeatherPrefsService } from "./weather-prefs-service.js";
import {
  readUpcomingImportantDays,
  type ImportantDay,
  type ImportantDaysStoreLike,
} from "./important-days-shared.js";

export interface EveningDigestScheduleItem {
  id: string;
  title: string;
  time?: string;
  /**
   * 该事项的预告段时刻（2026-10-13 口径：需要提前提醒的信息都进 prompt）。
   * 来源 = 任务 preReminders 的唤醒/出发段（night_before 是今晚的睡前备忘
   * 本身，不重复进明日数据），预渲染成「7:20 叫你起床」式短句供 agent 消化。
   * 2026-10-26 用户拍板：advanceNotes 只进文案 prompt，不再上卡片
   * （卡上行程 = 时刻 + 简短标题两列，预告信息由 narration 承担）。
   * 2026-11-23 §3.4：本条目整体退到**问答数据面**（TomorrowPreviewFacts）——
   * 主动推送的明日预览不再列行程，行程是早安的内容。
   */
  advanceNotes?: string[];
}

export interface EveningDigestTomorrowWeather {
  text: string;
  minC: number;
  maxC: number;
  /**
   * 明日降雨最集中的钟点段（如「下午 14–17 点」，达标线 40%），取自
   * weather-service 的 brief.tomorrow.rainWindow；未达标/取不到时省略。
   * 概率百分比不下发——用户口径：百分比无信息量，要的是「几点会下」。
   */
  rainWindowLabel?: string;
  /** 次日预警标签（暴雨/高温/大风/寒潮等；空数组 = 无预警） */
  alerts: string[];
}

/**
 * 问答数据面（2026-11-23 §3.4）：用户主动问「明天有什么安排」时要答全的
 * 那份事实。形状与 `tomorrow-preview.scene` 的 `PreviewDigestLike` 对齐，
 * 场景侧不需要区分新旧载荷。
 */
export interface TomorrowPreviewFacts {
  /** 今日本地日期键（YYYY-MM-DD）：场景据此推「明天」标签与 DDL 相对时刻 */
  date: string;
  /** 明日行程（schedule 服务次日任务 + 各预告段时刻） */
  tomorrowSchedule: EveningDigestScheduleItem[];
  /** 次日天气（既无天气位置偏好、也无定位兜底时 null） */
  tomorrowWeather: EveningDigestTomorrowWeather | null;
  /**
   * DDL 三级提醒梯度的 L2 档（明天到期 + 今天已过期未交）。
   * 主动推送面已按 §3.4 去掉这块，问答面照旧回答。
   */
  deadlineReminders?: DdlItem[];
  /** 近期重要日子（7 天窗口内的生日/纪念日，按剩余天数升序） */
  importantDays?: ImportantDay[];
}

/**
 * 主动推送面 = 卡上的「明日预览」（§3.4 分工后的形状）。
 * 只有天气与一两句闲聊：日程 / 截止事项 / 重要日子在本载荷里根本不存在
 * （不是空数组，是整块删字段）——旧卡面读到 key 才会渲染，缺 key 自然什么都不出。
 */
export interface EveningDigest {
  date: string;
  /** 次日天气（既无天气位置偏好、也无定位兜底时 null） */
  tomorrowWeather: EveningDigestTomorrowWeather | null;
  /**
   * 闲聊素材（§3.4「可接今天聊过的事、当天承诺跟进、节律关怀」）：
   * 最多两句，由装配层的取用口给；没有就整块省略。
   */
  chatLines?: string[];
  /**
   * 周日作息周报（§10 需求八：每周日搭在明日预览 slot）：
   * 平均入睡/起床、与上周对比、一句建议（不说教）。非周日或无数据 → 省略。
   */
  rhythmReport?: string[];
  /** 口语化播报文本（供 TTS / 消息气泡 / 通知单行）；无内容时空串（= 不发） */
  narrationText: string;
}

/** 一次取数的两个出口（装配层/调度器用，避免跑两遍天气与日程查询） */
export interface EveningPreviewBundle {
  digest: EveningDigest;
  facts: TomorrowPreviewFacts;
}

/** 闲聊素材取用口的返回形状 */
export interface EveningPreviewMaterial {
  /** 可接的话头：今天聊过的事 / 当天承诺跟进 / 节律关怀，一条一句 */
  lines?: string[];
  /** 作息周报行（装配层只在周日给） */
  weeklyRhythmReport?: string[];
}

/**
 * 主动推送的明日预览到底有没有内容可发（§3.4「没内容时」那一格：天气拉取
 * 失败且没有闲聊素材 → skipped，不发，也不发兜底话术）。
 *
 * narrationText 一起判空是投递侧的硬要求：客户端拿到空文案会整张卡丢弃
 * （EveningDigest 事件在 text 为空时直接 return），与其推一张空卡，
 * 不如按 skipped 留痕。调度器（EveningDigestScheduler）是唯一调用方。
 */
export function hasEveningDigestContent(d: EveningDigest): boolean {
  if (d.narrationText.trim().length === 0) return false;
  return (
    d.tomorrowWeather !== null ||
    (d.chatLines?.length ?? 0) > 0 ||
    (d.rhythmReport?.length ?? 0) > 0
  );
}

/** DDL 雷达最小结构接口（避免与扫描器实现耦合） */
export interface DdlRadarLike {
  forEvening(
    sessionId: string,
    actorId?: string,
  ): { tomorrow: DdlItem[]; overdue: DdlItem[] };
}

export type EveningDigestDeps = {
  scheduleTaskService?: ScheduleTaskService;
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
  /**
   * 天气定位兜底（2026-10-23）：`weatherPrefsService` 只有 PUT /weather/prefs 一个
   * 写入口、客户端从不调用，于是明日速览常年「天气我这儿没真实数据」。装配层
   * 在这里注入被动定位来源（位置历史的最新定位样本）。
   * 与晨报不同，睡前是后台定时路径：不做按需 GPS 请求（会唤醒手机并等 12s）。
   */
  locationProvider?: (sessionId: string) => Promise<WeatherLocation | null>;
  /**
   * 文案生成 agent（2026-10-13 定调：文案交给 agent，不硬编码）。
   * 传入结构化的明日信息，agent 动态产出睡前文案；未注入/失败/空输出
   * 回退确定性模板（composeNarration），不阻塞 digest 主链路。
   * 与晨报同款模式（ephemeralTurn 单次小调用，克制调用）。
   * 第二参 opts.systemPrompt = agent 自身 soul（【人格】块）——文案受
   * agent 本人性格影响，换人设产出味道跟着变。
   */
  llmComplete?: (
    prompt: string,
    opts?: { systemPrompt?: string },
  ) => Promise<string>;
  /**
   * agent soul 取用口：走 SpeechHub.buildSystemPrompt 装配（人格 + 通用纪律 +
   * 画像浅层，与主对话同源）。未注入 = 不带 system，文案只受睡前 prompt 自身约束。
   */
  soulProvider?: (sessionId: string) => string | null | Promise<string | null>;
  /**
   * DDL 雷达（大学生线 L2 档）：**只喂问答数据面**（facts.deadlineReminders）。
   * 2026-11-23 §3.4：截止事项不再进主动推送的明日预览——早安才是讲截止的地方。
   * 未注入 = 问答面也不带这块；只读扫描，不推送——投递由本服务自身的睡前出口
   * 完成，避免与承诺板分钟级梯度提醒撞车。
   */
  ddlRadar?: DdlRadarLike | null;
  /**
   * 重要日子存储：读 important_dates KV 中的
   * important_dates KV。**只喂问答数据面**（§3.4：生日/纪念日搬回早安卡，
   * 夜里那张卡不再列）。未注入 = 不做该块。
   */
  importantDaysStore?: ImportantDaysStoreLike;
  /**
   * 闲聊素材取用口（2026-11-23 §3.4）：明日预览除了天气只允许一两句闲聊，
   * 素材来自触点计划里已落进本 slot 的 social 候选 / 节律关怀 / 周日作息周报，
   * 由装配层注入（服务侧不新造数据源、不开新调度器）。
   * 未注入 / 抛错 / 返回空 = 只发天气；天气也拿不到 → narrationText 为空，
   * 调度器判 skipped。
   */
  previewMaterialProvider?: (
    sessionId: string,
    ctx: { date: string; isSunday: boolean },
  ) =>
    | EveningPreviewMaterial
    | null
    | undefined
    | Promise<EveningPreviewMaterial | null | undefined>;
};

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本地 HH:mm（明日日程条目时刻；服务器本地时区，与调度器的 getHours 同口径） */
function localTimeHm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 条目标题钳长（睡前文案一行一项，超长截断兜底） */
function clipItemTitle(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "日程安排";
  return s.length <= 20 ? s : `${s.slice(0, 20)}…`;
}

/** 闲聊最多两句（§3.4「明日预览只讲天气，再加一两句闲聊」） */
const CHAT_LINES_MAX = 2;
/** 单条闲聊/周报行的上卡长度（超长截断兜底——通知是一行表面） */
const CHAT_LINE_MAX_CHARS = 60;
/** 作息周报最多行数（周日那一格：入睡/起床 + 对比 + 一句建议） */
const RHYTHM_REPORT_MAX = 3;
/** 昼夜温差达到这个数才提一句「外套别脱」（太小是噪声） */
const TEMP_SWING_MIN = 8;

/**
 * 素材行清洗：trim + 压平换行 + 剥前缀标点 + 钳长 + 限量。
 * 素材由外部取用口给（触点计划的 social 候选、节律关怀文案），形状不保证，
 * 这里做最后一道确定性收口——空行一律丢掉，绝不拿空串凑数。
 */
function cleanMaterialLines(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const s = String(entry ?? "")
      .replace(/\s*\n+\s*/g, " ")
      .trim();
    if (!s) continue;
    out.push(s.length <= CHAT_LINE_MAX_CHARS ? s : `${s.slice(0, CHAT_LINE_MAX_CHARS - 1)}…`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 天气事实行（供 LLM prompt）：现象 + 温度区间 + 雨时段 + 预警。
 * §3.4 之后天气就是这一格的正文主体，所以它重新回到文案数据面
 * （2026-11-06「天气不上文案」的前提是卡上有行程可说，现在没有了）。
 */
function formatWeatherFacts(w: EveningDigestTomorrowWeather | null): string {
  if (!w) return "（明天天气没取到，不要编）";
  const bits = [w.text, `${w.minC}~${w.maxC}℃`].filter((s) => String(s ?? "").trim());
  const head = bits.join(" ");
  const swing = Math.abs(w.maxC - w.minC);
  const extras: string[] = [];
  if (w.rainWindowLabel) extras.push(`雨集中在${w.rainWindowLabel}`);
  if (swing >= TEMP_SWING_MIN) extras.push(`早晚差 ${Math.round(swing)} 度`);
  if (w.alerts.length > 0) extras.push(`预警：${w.alerts.join("、")}`);
  return [head, ...extras].filter(Boolean).join("；") || "（明天天气没取到，不要编）";
}

/** agent 输出净化：去包裹引号/围栏、压平换行、钳长——通知是一行表面 */
function sanitizeNarration(raw: string): string {
  let s = (raw ?? "").trim();
  // 剥 markdown 代码围栏
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // 剥一层包裹引号（模型偶发把文案当引用输出）
  s = s.replace(/^[「"'“]+/, "").replace(/[」"'”]+$/, "").trim();
  // 换行压成空格（通知单行）
  s = s.replace(/\s*\n+\s*/g, " ").trim();
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

export class EveningDigestService {
  constructor(private readonly deps: EveningDigestDeps = {}) {}

  /**
   * 主动推送面（明日预览卡）：天气 + 一两句闲聊（§3.4）。
   * 一次取数同时算出问答面，见 buildPreviewBundle。
   */
  async generateDigest(
    sessionId: string,
    opts: { previewDate?: string; skipNarration?: boolean } = {},
  ): Promise<EveningDigest> {
    return (await this.buildPreviewBundle(sessionId, opts)).digest;
  }

  /**
   * 问答数据面（§3.4 例外通道）：用户在对话里问「明天有什么安排」时答全——
   * 行程 + 天气 + 截止事项 + 重要日子。这是问答不是主动推送，不受分工限制。
   * 零 LLM（skipNarration 语义在这里恒成立）。
   */
  async generatePreviewFacts(
    sessionId: string,
    opts: { previewDate?: string } = {},
  ): Promise<TomorrowPreviewFacts> {
    return (await this.buildPreviewBundle(sessionId, { ...opts, skipNarration: true })).facts;
  }

  /**
   * 一次取数、两个出口（确定性聚合；任一源缺失/失败 → 该块省略）。
   * opts.previewDate（YYYY-MM-DD，被预告的那天）：跨零点补推用——把「今天」
   * 虚拟成 previewDate 前一天，date / 明日行程筛选 / 文案日期标签随之对齐
   * （不传 = 实时口径，明天 = 真实明天）。DDL 块是真实时钟扫描，补推口径
   * 下 tier 时点错位，整块省略。
   */
  async buildPreviewBundle(
    sessionId: string,
    opts: { previewDate?: string; skipNarration?: boolean } = {},
  ): Promise<EveningPreviewBundle> {
    const previewMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec((opts.previewDate ?? "").trim());
    // 虚拟今天 = 被预告日前一天（时刻取正午；生成逻辑只看日期不看时刻）
    const now = previewMatch
      ? new Date(Number(previewMatch[1]), Number(previewMatch[2]) - 1, Number(previewMatch[3]) - 1, 12)
      : new Date();
    const tomorrowKey = localDateKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    );
    const [tomorrowSchedule, tomorrowBundle, material] = await Promise.all([
      this.fetchTomorrowSchedule(sessionId, now).catch(() => [] as EveningDigestScheduleItem[]),
      this.fetchTomorrowBundle(sessionId, tomorrowKey).catch((e) => {
        // 天气块整块静默省略过太多次（Open-Meteo 抖动 / 无定位），留一行可查痕迹
        console.warn(
          `[EveningDigest] 明日天气块省略：${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }),
      // 闲聊素材与问答面数据并行取：它只喂文案，取不到就当没有
      this.fetchChatMaterial(sessionId, now),
    ]);

    const facts: TomorrowPreviewFacts = {
      date: localDateKey(now),
      tomorrowSchedule,
      tomorrowWeather: tomorrowBundle,
    };
    // L2 档（问答面专属，2026-11-23 §3.4 后不再上主动推送的卡）：
    // 明天到期 + 今天已过期未交（过期项按时间自然排在前面）。
    // 补推口径（previewDate）下 radar 按真实时钟分 tier，时点错位 → 省略
    if (!previewMatch) {
      const ddl = this.fetchDeadlineReminders(sessionId);
      if (ddl.length > 0) facts.deadlineReminders = ddl;
    }
    // 近期重要日子（7 天窗口，确定性读取，零 LLM）：主动推送面已按 §3.4 撤下
    // （展示位搬回早安卡），这里只留给问答面——问「明天有什么安排」照旧要说。
    // 补推口径用虚拟"今天"计算剩余天数，与 date 标签保持一致。
    const importantDays = readUpcomingImportantDays(this.deps.importantDaysStore, sessionId, {
      now,
    });
    if (importantDays.length > 0) facts.importantDays = importantDays;

    const digest: EveningDigest = {
      date: localDateKey(now),
      tomorrowWeather: tomorrowBundle,
      ...(material.lines.length > 0 ? { chatLines: material.lines } : {}),
      // 作息周报只搭周日那一格（§10 需求八）；取用口在非周日给了也不上卡
      ...(now.getDay() === 0 && material.weeklyRhythmReport.length > 0
        ? { rhythmReport: material.weeklyRhythmReport }
        : {}),
      narrationText: "",
    };
    digest.narrationText = opts.skipNarration
      ? ""
      : await this.composeNarrationText(sessionId, digest);
    return { digest, facts };
  }

  /** 闲聊素材取用口：未注入 / 抛错 / 返回空 → 两块都空数组（只发天气，不硬凑） */
  private async fetchChatMaterial(
    sessionId: string,
    now: Date,
  ): Promise<{ lines: string[]; weeklyRhythmReport: string[] }> {
    const provider = this.deps.previewMaterialProvider;
    if (!provider) return { lines: [], weeklyRhythmReport: [] };
    try {
      const raw = await provider(sessionId, {
        date: localDateKey(now),
        isSunday: now.getDay() === 0,
      });
      return {
        lines: cleanMaterialLines(raw?.lines, CHAT_LINES_MAX),
        weeklyRhythmReport: cleanMaterialLines(raw?.weeklyRhythmReport, RHYTHM_REPORT_MAX),
      };
    } catch (e) {
      console.warn(
        `[EveningDigest] 闲聊素材取用失败（只发天气）：${e instanceof Error ? e.message : String(e)}`,
      );
      return { lines: [], weeklyRhythmReport: [] };
    }
  }

  /** DDL L2 取数（问答面）：radar 未注入 / 抛错 → 空数组（整块省略），不阻塞 digest */
  private fetchDeadlineReminders(sessionId: string): DdlItem[] {
    if (!this.deps.ddlRadar) return [];
    try {
      const { tomorrow, overdue } = this.deps.ddlRadar.forEvening(sessionId);
      return [...overdue, ...tomorrow].sort(
        (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt),
      );
    } catch {
      return [];
    }
  }

  /**
   * 文案生成主路：agent 动态产出（结构化信息 → LLM），兜底 = 确定性模板。
   * 2026-10-13 定调（用户拍板）：「文案交给 agent，把信息交给 agent，
   * 动态给出对应的文案，不需要硬编码」——模板只作 LLM 未注入/失败/空
   * 输出时的降级，不再是文案主源。
   */
  private async composeNarrationText(sessionId: string, d: EveningDigest): Promise<string> {
    const fallback = this.composeNarration(d);
    const llm = this.deps.llmComplete;
    if (!llm) return fallback;
    let systemPrompt: string | undefined;
    try {
      systemPrompt = (await this.deps.soulProvider?.(sessionId)) ?? undefined;
    } catch {
      /* soul 取用失败不阻塞文案 */
    }
    try {
      const cleaned = sanitizeNarration(
        await llm(this.buildNarrationPrompt(d), { systemPrompt }),
      );
      return cleaned.length > 0 ? cleaned : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * agent 提示词：数据段 = 「明天天气 + 可聊的素材」（2026-11-23 §3.4 分工）。
   * 行程 / 截止事项 / 重要日子在这里根本不存在——它们只属于早安那张卡，
   * 数据面删净比写禁令可靠（模型看不到就不会说）。
   * 口吻归 soulProvider（SpeechHub system 单点，人格+记忆+语境多因素），
   * user 段不放人格设定、不放禁令模板（2026-11-06：禁令/人设一律不加，
   * 只删数据）；仅保留内容性要求。
   */
  private buildNarrationPrompt(d: EveningDigest): string {
    // 明天日期从 digest.date（今日本地键）推导，不新取时钟
    const [y, mo, da] = d.date.split("-").map(Number);
    const tomorrow = new Date(y, (mo ?? 1) - 1, (da ?? 1) + 1);
    const week = ["日", "一", "二", "三", "四", "五", "六"];
    const dateLabel = `${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日 周${week[tomorrow.getDay()]}`;

    const dataLines = [`- 明天（${dateLabel}）的天气：${formatWeatherFacts(d.tomorrowWeather)}`];
    if (d.rhythmReport && d.rhythmReport.length > 0) {
      dataLines.push(`- 这周的作息（周日才有一条）：${d.rhythmReport.join("；")}`);
    }
    if (d.chatLines && d.chatLines.length > 0) {
      dataLines.push(`- 可以顺带聊一句的素材：${d.chatLines.join("；")}`);
    }

    return [
      // 口吻不在这里定：agent 人格走 soulProvider（SpeechHub system 单点），
      // 由人格、记忆、语境等多种因素决定；user 段只给任务与数据（2026-11-06）。
      "根据下面的信息，写今晚「明日预览」要发给用户的一条消息正文。",
      "",
      "这一格只回答一个问题：明天出门要跟天气打什么招呼。日程和要交的东西归早上那张卡说，这里不重复。",
      "",
      "素材：",
      ...dataLines,
      "",
      "写法：",
      "- 一到两句，短句。天气只挑最要紧的那一点说（要不要带伞 / 早晚温差 / 有没有预警），" +
        "说人话：「明早有点凉，午后能到 22 度」「雨大概在下午两点多到五点，伞放包里」，" +
        "不要念数字表，也不要一行一条报数据。",
      "- 有温差就说穿衣上的那句，有雨就说带伞，有预警就正经提一句别看天气就出门；" +
        "天气平平常就一句带过，不用硬找话说。",
      "- 有素材就顺口加一两句闲聊（接今天聊过的事、作息上的关心），最多两句；" +
        "素材为空就只说天气，不许编没发生的事，也不许硬凑「今天过得真快」这类空话。",
      "- 有作息周报就带一句，只报数字和一句建议，不说教、不评判。",
      "- 松弛不等于贫嘴：「就下雨这点事」「不就个XX」这种把正事说成玩笑的轻浮腔不许有，" +
        "提醒要正经给，收尾可以随意。",
      "- 可以有自然的语气词或一句收尾（「伞放包里」），但别每次都一个套路。",
      "- 不要：敬语、「亲爱的」、「您好」、「温馨提示」、汇报腔、排比、书面语、emoji、标题、引号、换行、任何解释。",
      "只输出消息正文本身。",
    ].join("\n");
  }

  /** 次日行程（schedule 服务） */
  private async fetchTomorrowSchedule(
    sessionId: string,
    now: Date,
  ): Promise<EveningDigestScheduleItem[]> {
    if (!this.deps.scheduleTaskService) return [];
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowKey = localDateKey(tomorrowStart);
    try {
      const tasks = this.deps.scheduleTaskService.listTasksBySession(sessionId);
      return tasks
        .filter((t) => {
          const ts = Date.parse(t.nextRunAt ?? t.runAt ?? "");
          if (Number.isNaN(ts)) return false;
          return localDateKey(new Date(ts)) === tomorrowKey;
        })
        .slice(0, 5)
        .map((t) => {
          const ts = Date.parse(t.nextRunAt ?? t.runAt ?? "");
          // 2026-10-26 用户拍板：行程区只放简短文字描述（shortTitle 口径，
          // 如「看牙医」），不把提醒原文（reminderMessage「到点了该干嘛」）
          // 原封搬进卡片——顶部 narration 已承担活人描述。
          const title = clipItemTitle(t.shortTitle || t.title || "日程安排");
          // 预告段 → 绝对时刻短句（唤醒/出发段；night_before 排除）
          const advanceNotes = (t.preReminders ?? [])
            .filter(
              (p) =>
                p.stage !== "night_before" &&
                Number.isFinite(p.offsetMinutes) &&
                p.offsetMinutes > 0,
            )
            .map((p) => ({
              at: Number.isNaN(ts) ? null : ts - p.offsetMinutes * 60_000,
              label: p.label,
            }))
            .filter((p): p is { at: number; label: string } => p.at !== null)
            .sort((a, b) => a.at - b.at)
            .map((p) => `${localTimeHm(p.at)}${p.label}`);
          return {
            id: t.taskId,
            title,
            // 本地 HH:mm（2026-10-13 修复：原 slice(11,16) 取的是 UTC 时刻，
            // 东八区文案「9:00」实际是 17:00，差 8 小时）
            time: Number.isNaN(ts) ? undefined : localTimeHm(ts),
            ...(advanceNotes.length > 0 ? { advanceNotes } : {}),
          };
        });
    } catch {
      return [];
    }
  }

  /** 次日天气 + 预警检测（weather-service 每日数据；穿衣已移除，2026-11-06）。
   * 天气按日历日期从 brief.daily 取「被预告那天」（previewDateKey）：跨零点补推
   * 时 brief.tomorrow 指向真实明天，日期已错位不能再用；当日无数据 → 省略。
   */
  private async fetchTomorrowBundle(
    sessionId: string,
    previewDateKey: string,
  ): Promise<EveningDigestTomorrowWeather | null> {
    const { weatherService } = this.deps;
    if (!weatherService) {
      return null;
    }
    const loc = await this.resolveWeatherLocation(sessionId);
    if (!loc) return null;
    const brief = await weatherService.getBrief(
      loc.latitude,
      loc.longitude,
      // 定位没带时区时按坐标推导（auto），不用服务端本机时区兜底
      loc.timezone || "auto",
      loc.label,
    );
    const dailyItems = brief.daily ?? [];
    const dayIndex = dailyItems.findIndex((d) => d.date === previewDateKey);
    const t = dayIndex >= 0 ? dailyItems[dayIndex]! : null;
    if (!t) {
      // 日期 miss 多半是定位坐标与「明天」的历法错位（如模拟器假定位：坐标在
      // 美国、daily 按坐标时区只有 2 天，北京历法的明天不在窗口内）。2026-11-05
      // 排查确认这条路径原本静默返回、一行痕迹不留，卡了半天排查——留下来源。
      console.log(
        `[EveningDigest] 明日天气日期未命中 previewDateKey=${previewDateKey} ` +
          `daily=[${dailyItems.map((d) => d.date).join(",")}] → 明日天气块省略`,
      );
      return null;
    }
    // brief.tomorrow 的雨时段指向 API 的真实明天（daily[1]）；跨零点补推
    // （previewDate）时日期错位，时段不能张冠李戴，只在两者对齐时带上
    const rainWindow = dayIndex === 1 ? brief.tomorrow?.rainWindow : undefined;
    const weather: EveningDigestTomorrowWeather = {
      text: t.weatherText,
      minC: t.minC,
      maxC: t.maxC,
      ...(rainWindow?.label ? { rainWindowLabel: rainWindow.label } : {}),
      alerts: detectSevereWeatherAlerts(t),
    };
    return weather;
  }

  /** 明日天气的定位来源：用户显式保存的天气位置 > 装配层的被动定位兜底 */
  private async resolveWeatherLocation(sessionId: string): Promise<WeatherLocation | null> {
    const prefs = this.deps.weatherPrefsService?.get(sessionId);
    if (prefs) {
      return {
        latitude: prefs.latitude,
        longitude: prefs.longitude,
        timezone: prefs.timezone,
        label: prefs.label,
      };
    }
    const live = await this.deps.locationProvider?.(sessionId);
    if (!live) {
      console.log("[EveningDigest] 无天气位置偏好、无可用定位 → 明日天气块省略");
      return null;
    }
    return live;
  }

  /**
   * 确定性兜底文案（LLM 未注入/失败/空输出时降级用，不再是文案主源）。
   * 2026-11-23 §3.4 口径：只说天气 + 素材里那一两句；**没素材不凑话**——
   * 天气也拿不到时返回空串，调度器据此判 skipped（PRD：没内容不发兜底话术，
   * 原来那句「明天没安排，想睡就多睡会儿」随行程块一起撤下）。
   */
  private composeNarration(d: EveningDigest): string {
    const parts: string[] = [];
    const weather = weatherBit(d.tomorrowWeather);
    if (weather) parts.push(weather);
    // 作息周报（周日）与闲聊素材：素材本身就是人话行，只补句号，不改写
    for (const line of d.rhythmReport ?? []) parts.push(ensureSentence(line));
    for (const line of d.chatLines ?? []) parts.push(ensureSentence(line));
    return parts.join("").trim();
  }
}

/** 素材行 → 一句话（末尾没标点就补个句号；空行不产出任何字符） */
function ensureSentence(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return /[。！？!?；;，.]$/.test(s) ? s : `${s}。`;
}

/**
 * 兜底文案的天气句（确定性模板也要说天气——§3.4 之后这就是这一格的正文）：
 * 现象 + 温度、温差、预警、雨时段，只挑用得上的，不念数据表。
 */
function weatherBit(w: EveningDigestTomorrowWeather | null): string {
  if (!w) return "";
  const text = String(w.text ?? "").trim();
  const hasRange = Number.isFinite(w.minC) && Number.isFinite(w.maxC);
  const swing = hasRange ? Math.round(Math.abs(w.maxC - w.minC)) : 0;
  const head = [text, hasRange ? `${w.minC}~${w.maxC}℃` : ""].filter(Boolean).join("，");
  const parts: string[] = [];
  if (head) parts.push(`明天${head}。`);
  if (swing >= TEMP_SWING_MIN) parts.push(`早晚差 ${swing} 度，外套别收起来。`);
  const alerts = (w.alerts ?? []).map((a) => String(a ?? "").trim()).filter(Boolean);
  if (alerts.length > 0) parts.push(`明天有${alerts.join("、")}预警。`);
  if (w.rainWindowLabel) parts.push(`雨大概集中在${w.rainWindowLabel}，伞放包里。`);
  else if (/雨|雪/.test(text)) parts.push("出门记得带伞。");
  return parts.join("");
}
