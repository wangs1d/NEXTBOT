/**
 * 晚间 digest 服务（Task 15 场景A 生活节律）——「明日速览」。
 *
 * 与晨报（MorningBriefingService）互补：晨报面向"今天怎么安排"，晚间 digest
 * 只面向"明天要准备什么"。全部确定性聚合，零 LLM：
 *   - 明日行程（ScheduleTaskService 次日任务 + 各预告段时刻）
 *   - 次日天气与预警（WeatherService.getBrief().tomorrow + 预警检测）
 *   - 截止事项 DDL L2 档（DdlRadarService.forEvening）
 *   - 近期重要日子（7 天窗口，2026-11-04 从晨报迁来：生日/纪念日属于
 *     「提前准备」的信息，跟睡前这段对话更搭，晨报只留下当日祝福提醒）
 *
 * 送达链路参考晨报：调度器（EveningDigestScheduler）到点触发 → 装配层
 * onDigestTriggered → WS 推送（ServerEventType.EveningDigest）。
 *
 * 2026-10-13 定调：本 digest 即「明日速览」（原名「睡前备忘」，2026-10-24 与
 * 客户端卡名对齐）——narrationText 是唯一文案源
 * （通知/卡片/口播路径统一），只说「明天的事」；天气/穿衣不上文案
 * （2026-11-06 用户定稿：卡上的「明天天气」块已有，narration 再说就是重复），
 * 活人感短句。
 * 2026-10-24 收敛（用户拍板）：删「今日回顾」与「行程超支」两块——今日回顾
 * 从来不进文案也不上卡片（纯白算），超支属消费提醒不进睡前场景。
 */

import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DdlItem } from "./ddl-radar-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherLocation, WeatherPrefsService } from "./weather-prefs-service.js";
import {
  importantDayTypeLabel,
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

export interface EveningDigest {
  date: string;
  /** 明日行程条目（2026-10-16 口径：日程统一叫「行程」） */
  tomorrowSchedule: EveningDigestScheduleItem[];
  /** 次日天气（既无天气位置偏好、也无定位兜底时 null） */
  tomorrowWeather: EveningDigestTomorrowWeather | null;
  // 穿衣建议已整体移除（2026-11-06 用户定稿：穿衣信息也不要）
  /** 口语化播报文本（供 TTS / 消息气泡） */
  narrationText: string;
  /**
   * DDL 三级提醒梯度的 L2 档（2026-10-22 大学生线）：
   * 明天到期（tier=tomorrow）+ 今天已过期还没交（tier=today 且 overdue）。
   * 由 DdlRadarService 确定性扫描，未注入 radar 时整块省略。
   * L1（2~3 天后）与 L3（当天早晨）走晨报；这里只承担"明晚要交"。
   */
  deadlineReminders?: DdlItem[];
  /**
   * 近期重要日子（2026-11-04 从晨报迁来）：7 天窗口内的生日/纪念日，
   * 按剩余天数升序。无记录时整块省略。
   */
  importantDays?: ImportantDay[];
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
   * DDL 雷达（大学生线 L2 档）：明日截止事项取数口。未注入 = 不做 DDL 块。
   * 只读扫描，不推送——投递由本服务自身的睡前出口完成，避免与承诺板
   * 分钟级梯度提醒撞车。
   */
  ddlRadar?: DdlRadarLike | null;
  /**
   * 重要日子存储（2026-11-04 迁入）：读 care.set_important_date 写入的
   * important_dates KV。未注入 = 不做该块。
   */
  importantDaysStore?: ImportantDaysStoreLike;
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

/**
 * DDL 事实行（供 LLM prompt）：相对日期 + 时刻 + 标题。
 * 过期的显式标「已过期」，避免模型把它说成"明天要交"。
 */
function formatDeadlineFacts(items: DdlItem[]): string {
  return items
    .map((i) => {
      const d = new Date(i.dueAt);
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const dayWord = i.tier === "tomorrow" ? "明天" : i.overdue ? "今天已过" : "今天";
      return `${dayWord} ${hm} 《${i.title}》`;
    })
    .join("；");
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
   * 生成晚间 digest（确定性聚合，零 LLM；任一源缺失/失败 → 该块省略）。
   * opts.previewDate（YYYY-MM-DD，被预告的那天）：跨零点补推用——把「今天」
   * 虚拟成 previewDate 前一天，digest.date / 明日行程筛选 / 文案日期标签随之
   * 对齐（不传 = 实时口径，明天 = 真实明天）。DDL 块是真实时钟扫描，补推口径
   * 下 tier 时点错位，整块省略。
   */
  async generateDigest(
    sessionId: string,
    opts: { previewDate?: string; skipNarration?: boolean } = {},
  ): Promise<EveningDigest> {
    const previewMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec((opts.previewDate ?? "").trim());
    // 虚拟今天 = 被预告日前一天（时刻取正午；生成逻辑只看日期不看时刻）
    const now = previewMatch
      ? new Date(Number(previewMatch[1]), Number(previewMatch[2]) - 1, Number(previewMatch[3]) - 1, 12)
      : new Date();
    const tomorrowKey = localDateKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    );
    const [tomorrowSchedule, tomorrowBundle] = await Promise.all([
      this.fetchTomorrowSchedule(sessionId, now).catch(() => [] as EveningDigestScheduleItem[]),
      this.fetchTomorrowBundle(sessionId, tomorrowKey).catch((e) => {
        // 天气块整块静默省略过太多次（Open-Meteo 抖动 / 无定位），留一行可查痕迹
        console.warn(
          `[EveningDigest] 明日天气块省略：${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }),
    ]);

    const digest: EveningDigest = {
      date: localDateKey(now),
      tomorrowSchedule,
      tomorrowWeather: tomorrowBundle,
      narrationText: "",
    };
    // L2 档：明天到期 + 今天已过期未交（过期项按时间自然排在前面）。
    // 补推口径（previewDate）下 radar 按真实时钟分 tier，时点错位 → 省略
    if (!previewMatch) {
      const ddl = this.fetchDeadlineReminders(sessionId);
      if (ddl.length > 0) digest.deadlineReminders = ddl;
    }
    // 近期重要日子（7 天窗口，确定性读取，零 LLM）：生日/纪念日要提前备一句，
    // 睡前这段对话比清晨更合适（2026-11-04 从晨报迁来）。
    // 补推口径用虚拟"今天"计算剩余天数，与 date 标签保持一致。
    const importantDays = readUpcomingImportantDays(this.deps.importantDaysStore, sessionId, {
      now,
    });
    if (importantDays.length > 0) digest.importantDays = importantDays;
    digest.narrationText = opts.skipNarration
      ? ""
      : await this.composeNarrationText(sessionId, digest);
    return digest;
  }

  /** DDL L2 取数：radar 未注入 / 抛错 → 空数组（整块省略），不阻塞 digest */
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
   * agent 提示词：数据段 = 「需要提前提醒的信息」（2026-10-13 用户拍板口径，
   * 不只日程——日程各自主预告段：起床闹钟/该出门了时刻一并进入）。
   * 口吻归 soulProvider（SpeechHub system 单点，人格+记忆+语境多因素），
   * user 段不放人格设定、不放禁令模板（2026-11-06：禁令/人设一律不加，
   * 只删数据，禁止事项交给人格纪律承担）；仅保留内容性要求。
   */
  private buildNarrationPrompt(d: EveningDigest): string {
    // 明天日期从 digest.date（今日本地键）推导，不新取时钟
    const [y, mo, da] = d.date.split("-").map(Number);
    const tomorrow = new Date(y, (mo ?? 1) - 1, (da ?? 1) + 1);
    const week = ["日", "一", "二", "三", "四", "五", "六"];
    const dateLabel = `${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日 周${week[tomorrow.getDay()]}`;

    const scheduleLines =
      d.tomorrowSchedule.length > 0
        ? d.tomorrowSchedule
            .map((s) => {
              const base = `${s.time ?? "时间待定"} ${s.title}`;
              return s.advanceNotes?.length
                ? `${base}（${s.advanceNotes.join("、")}）`
                : base;
            })
            .join("；")
        : "无";

    // 2026-11-06 用户定稿：天气/穿衣不进文案数据面——卡上「明天天气」块
    // （温度/现象/预警/穿衣行）已完整承载，narration 再说就是重复。

    const dataLines = [
      `- 明天（${dateLabel}）的行程：${scheduleLines}`,
    ];
    if (d.deadlineReminders && d.deadlineReminders.length > 0) {
      dataLines.push(`- 截止事项（必须提）：${formatDeadlineFacts(d.deadlineReminders)}`);
    }
    if (d.importantDays && d.importantDays.length > 0) {
      dataLines.push(
        `- 近期重要日子：${d.importantDays
          .slice(0, 3)
          .map(
            (i) =>
              `${i.name}的${importantDayTypeLabel(i.type)}` +
              (i.daysUntil === 0
                ? "（今天）"
                : i.daysUntil === 1
                  ? "（明天）"
                  : `（${i.daysUntil} 天后）`),
          )
          .join("；")}`,
      );
    }

    return [
      // 口吻不在这里定：agent 人格走 soulProvider（SpeechHub system 单点），
      // 由人格、记忆、语境等多种因素决定；user 段只给任务与数据（2026-11-06）。
      "根据下面的信息，写今晚睡前要发给用户的一条消息正文。",
      "",
      "需要提前提醒的信息：",
      ...dataLines,
      "",
      "写法：",
      "- 一到两句，短句。只挑最早或最要紧的那件事说，别把日程从头到尾念一遍。" +
        "时间要口语化，比如「九点半有个周会」，不要写成「9:30 项目周会」这种条目。",
      "- 有截止事项的话必须提，这是睡前最该交代的一句：说明天/今天什么时候要交什么，" +
        "像「明天下午三点前那个数据结构的作业得交了」；超过两件只说最紧的那一件+一共几件，" +
        "别把清单念一遍，也别加「别忘了」「切记」这类催促腔。",
      "- 有近期重要日子（生日/纪念日）的话顺口带一句，像「后天妈生日，别忘了」；" +
        "只提最近的那一个，别把名单念一遍。",
      "- 明天没安排就轻松带过一句，不许编事，也不许硬凑。",
      "- 松弛不等于贫嘴：「就下雨这点事」「不就个XX」这种把正事说成玩笑的轻浮腔不许有，" +
        "提醒要正经给，收尾可以随意。",
      "- 可以有自然的语气词或一句收尾（「记得定闹钟」「早点睡」），但别每次都一个套路。",
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
   * 2026-11-06 口径更新：天气/穿衣不上文案（卡上「明天天气」块已承载），
   * 睡前文案只说「明天的事」，活人感短句、用「你」；简报腔不出现。
   */
  private composeNarration(d: EveningDigest): string {
    const items = d.tomorrowSchedule;
    const n = items.length;
    const ddlBit = deadlineBit(d.deadlineReminders);
    const dayBit = importantDaysBit(d.importantDays);

    // 明天没安排：干脆的不打扰，没数据不硬凑
    if (n === 0) {
      return `明天没安排，想睡就多睡会儿。${ddlBit}${dayBit}`;
    }

    const first = items[0]!;
    const when = first.time ? `${first.time}的` : "";
    let line: string;
    if (n === 1) {
      line = `明天就一件事：${when}${first.title}，到点我叫你。`;
    } else if (n <= 3) {
      const rest = items
        .slice(1)
        .map((s) => (s.time ? `${s.time}的${s.title}` : s.title));
      line = `明天 ${n} 件事：${when}${first.title}，还有${rest.join("、")}。到点我都会提醒你。`;
    } else {
      line = `明天 ${n} 件事，最早${when}${first.title}，剩下的到时候我会说。`;
    }

    // DDL L2 档：明天要交的（兜底模板也要交代，不能只有 LLM 版本才有）
    if (ddlBit) line += ddlBit;
    // 近期重要日子：只提最近的那一个
    if (dayBit) line += dayBit;
    return line;
  }
}

/** DDL 一句（确定性兜底文案用）：只报最近一件 + 剩余件数，不念清单 */
function deadlineBit(items: DdlItem[] | undefined): string {
  if (!items || items.length === 0) return "";
  const first = items[0]!;
  const d = new Date(first.dueAt);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const when = first.overdue
    ? `今天 ${hm} 那个已经过点了`
    : first.tier === "tomorrow"
      ? `明天 ${hm} 前`
      : `今天 ${hm} 前`;
  const rest = items.length > 1 ? `，另外还有 ${items.length - 1} 项要交` : "";
  return ` ${when}要交「${first.title}」${rest}。`;
}

/**
 * 近期重要日子一句（兜底模板用）：只提最近的那一个，不念名单。
 * 生日/纪念日是「提前准备」信息，睡前带一句比早上才说更有用。
 */
function importantDaysBit(items: ImportantDay[] | undefined): string {
  if (!items || items.length === 0) return "";
  const first = items[0]!;
  const label = importantDayTypeLabel(first.type);
  const when =
    first.daysUntil === 0
      ? "就是今天"
      : first.daysUntil === 1
        ? "就是明天"
        : `还有 ${first.daysUntil} 天`;
  return `另外${first.name}的${label}${when}。`;
}
