/**
 * 晚间 digest 服务（Task 15 场景A 生活节律）——「今日回顾 + 明日预告」。
 *
 * 与晨报（MorningBriefingService）互补：晨报面向"今天怎么安排"，晚间 digest
 * 面向"今天过了什么 + 明天要准备什么"。全部确定性聚合，零 LLM：
 *   - 今日回顾：journal 当日记录要点（DailyJournalService.readTodayLines）
 *   - 明日预告：明日行程（ScheduleTaskService 次日任务）
 *              + 次日天气与预警（WeatherService.getBrief().tomorrow + 预警检测）
 *              + 明日穿衣（buildClothingAdvice 同源）
 *
 * 送达链路参考晨报：调度器（EveningDigestScheduler）到点触发 → 装配层
 * onDigestTriggered → WS 推送（ServerEventType.EveningDigest）。
 *
 * 2026-10-13 定调：本 digest 即「睡前备忘」——narrationText 是唯一文案源
 * （通知/卡片/口播路径统一），只说「明天的事」+ 可行动的天气，活人感短句。
 */

import type { DailyJournalService, JournalHit } from "./daily-journal-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import { buildClothingAdvice, detectSevereWeatherAlerts } from "./weather-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";

/** 今日回顾：journal 当日要点（最多呈现条数） */
const TODAY_HIGHLIGHT_MAX = 6;

export interface EveningDigestScheduleItem {
  id: string;
  title: string;
  time?: string;
  /**
   * 该事项的预告段时刻（2026-10-13 口径：需要提前提醒的信息都进 prompt）。
   * 来源 = 任务 preReminders 的唤醒/出发段（night_before 是今晚的睡前备忘
   * 本身，不重复进明日数据），预渲染成「7:20 叫你起床」式短句供 agent 消化。
   */
  advanceNotes?: string[];
}

export interface EveningDigestTomorrowWeather {
  text: string;
  minC: number;
  maxC: number;
  rainPct: number;
  /** 次日预警标签（暴雨/高温/大风/寒潮等；空数组 = 无预警） */
  alerts: string[];
}

export interface EveningDigest {
  date: string;
  /** 今日回顾：journal 当日记录要点（时间 + 角色 + 首句） */
  todayHighlights: JournalHit[];
  /** 明日预告：行程条目（2026-10-16 口径：日程统一叫「行程」） */
  tomorrowSchedule: EveningDigestScheduleItem[];
  /** 明日预告：次日天气（未配置天气位置时 null） */
  tomorrowWeather: EveningDigestTomorrowWeather | null;
  /**
   * 明日穿衣建议（2026-10-16：早间简报的天气/穿衣迁来睡前提醒）。
   * 复用 weather-service 的 buildClothingAdvice（与 weather_brief 定时任务同源），
   * 以明天最高温定层级、明天降水/天气码定雨具等提示；无明日天气时 null。
   */
  outfitTip: string | null;
  /** 口语化播报文本（供 TTS / 消息气泡） */
  narrationText: string;
}

export type EveningDigestDeps = {
  journalService?: DailyJournalService | null;
  scheduleTaskService?: ScheduleTaskService;
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
  /**
   * 文案生成 agent（2026-10-13 定调：文案交给 agent，不硬编码）。
   * 传入结构化的明日信息，agent 动态产出睡前文案；未注入/失败/空输出
   * 回退确定性模板（composeNarration），不阻塞 digest 主链路。
   * 与晨报同款模式（ephemeralTurn 单次小调用，克制调用）。
   * 第二参 opts.systemPrompt = agent 自身 soul（人格·静态块）——文案受
   * agent 本人性格影响，换人设产出味道跟着变（2026-10-13 定调）。
   */
  llmComplete?: (
    prompt: string,
    opts?: { systemPrompt?: string },
  ) => Promise<string>;
  /**
   * agent soul 取用口（装配层组装：agent 名 + 用户称呼 + 关系档 + 学到
   * 的适配，主对话 buildPersonaStaticBlock 同源）。未注入 = 不带 system，
   * 文案只受睡前 prompt 自身约束。
   */
  soulProvider?: (sessionId: string) => string | null;
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

  /** 生成晚间 digest（确定性聚合，零 LLM；任一源缺失/失败 → 该块省略） */
  async generateDigest(sessionId: string): Promise<EveningDigest> {
    const now = new Date();
    const [todayHighlights, tomorrowSchedule, tomorrowBundle] = await Promise.all([
      this.fetchTodayHighlights(sessionId).catch(() => [] as JournalHit[]),
      this.fetchTomorrowSchedule(sessionId, now).catch(() => [] as EveningDigestScheduleItem[]),
      this.fetchTomorrowBundle(sessionId).catch(() => ({
        weather: null,
        outfitTip: null,
      })),
    ]);

    const digest: EveningDigest = {
      date: localDateKey(now),
      todayHighlights,
      tomorrowSchedule,
      tomorrowWeather: tomorrowBundle.weather,
      outfitTip: tomorrowBundle.outfitTip,
      narrationText: "",
    };
    digest.narrationText = await this.composeNarrationText(sessionId, digest);
    return digest;
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
      systemPrompt = this.deps.soulProvider?.(sessionId) ?? undefined;
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
   * 不只日程+天气——日程各自主预告段：起床闹钟/该出门了时刻一并进入）；
   * 要求段 = 用户定稿原文（朋友发微信、只说一件事、时间口语化、活人感禁令）。
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
    const w = d.tomorrowWeather;
    const weatherLine = w
      ? `${w.text}，${w.minC.toFixed(0)}-${w.maxC.toFixed(0)}度，降水概率${w.rainPct}%` +
        (w.alerts.length > 0 ? `，预警：${w.alerts.join("、")}` : "")
      : null;

    const dataLines = [
      `- 明天（${dateLabel}）的行程：${scheduleLines}`,
    ];
    if (weatherLine) dataLines.push(`- 明天天气：${weatherLine}`);
    if (d.outfitTip) dataLines.push(`- 明天穿衣：${d.outfitTip}`);

    return [
      "你是用户最熟的那个朋友，晚上临睡前顺口提一嘴明天的事。" +
        "语气松弛、靠谱，像发微信，不是秘书做汇报，也不用寒暄。",
      "你会拿到：需要提前提醒的信息（明天的日程/预告时刻、天气和穿衣）。",
      "",
      "需要提前提醒的信息：",
      ...dataLines,
      "",
      "写法：",
      "- 一到两句，短句。只挑最早或最要紧的那件事说，别把日程从头到尾念一遍。" +
        "时间要口语化，比如「九点半有个周会」，不要写成「9:30 项目周会」这种条目。",
      "- 明天天气和穿衣要说（这是睡前备忘的正经内容，不是可省项）：预警优先；" +
        "合起来最多一小句，像「明天22度，短袖就行」这样自然带过，别写成播报。",
      "- 明天没安排就轻松带过一句，不许编事，也不许硬凑。",
      "- 可以有自然的语气词或一句收尾（「记得定闹钟」「早点睡」），但别每次都一个套路。",
      "- 不要：敬语、「亲爱的」「您好」、「温馨提示」、汇报腔、排比、书面语、emoji、标题、引号、换行、任何解释。",
      "只输出消息正文本身。",
    ].join("\n");
  }

  /** 今日回顾 1/2：journal 当日记录要点（按时间顺序，U/A/fact 行精简） */
  private async fetchTodayHighlights(sessionId: string): Promise<JournalHit[]> {
    if (!this.deps.journalService) return [];
    const lines = await this.deps.journalService.readTodayLines(sessionId);
    // 回顾要点优先保留 user/fact 行（用户做了什么/说了什么），assistant 行次之
    const ranked = [...lines].sort((a, b) => {
      const rank = (h: JournalHit) => (h.role === "user" ? 0 : h.role === "fact" ? 1 : 2);
      return rank(a) - rank(b);
    });
    return ranked.slice(0, TODAY_HIGHLIGHT_MAX);
  }

  /** 明日预告 1/2：次日行程（schedule 服务） */
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
          const title = clipItemTitle(t.reminderMessage || t.title || "日程安排");
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

  /**
   * 明日预告 2/2：次日天气 + 预警检测 + 明日穿衣建议（weather-service 每日数据）。
   * 穿衣复用 buildClothingAdvice（weather_brief 定时任务同源）：以明天最高温定
   * 衣物层级、明天降水概率/天气码定雨具防滑提示；与天气块同取自一次 getBrief。
   */
  private async fetchTomorrowBundle(
    sessionId: string,
  ): Promise<{ weather: EveningDigestTomorrowWeather | null; outfitTip: string | null }> {
    const { weatherService, weatherPrefsService } = this.deps;
    if (!weatherService || !weatherPrefsService) {
      return { weather: null, outfitTip: null };
    }
    const prefs = weatherPrefsService.get(sessionId);
    if (!prefs) return { weather: null, outfitTip: null };
    const brief = await weatherService.getBrief(
      prefs.latitude,
      prefs.longitude,
      prefs.timezone || "Asia/Shanghai",
      prefs.label,
    );
    if (!brief.tomorrow) return { weather: null, outfitTip: null };
    const t = brief.tomorrow;
    const weather: EveningDigestTomorrowWeather = {
      text: t.weatherText,
      minC: t.minC,
      maxC: t.maxC,
      rainPct: t.rainPct,
      alerts: detectSevereWeatherAlerts(t),
    };
    const outfitTip = buildClothingAdvice({
      currentTempC: t.maxC,
      todayMinC: t.minC,
      todayMaxC: t.maxC,
      peakRainPct: t.rainPct,
      weatherCode: t.weatherCode,
      windKmh: 0,
    });
    return { weather, outfitTip };
  }

  /**
   * 确定性兜底文案（LLM 未注入/失败/空输出时降级用，不再是文案主源）。
   * 2026-10-16 口径更新（天气/穿衣自早间简报迁来）：睡前文案说「明天的事」+
   * 明日天气与穿衣建议，活人感短句、用「你」；简报腔不出现。
   */
  private composeNarration(d: EveningDigest): string {
    const items = d.tomorrowSchedule;
    const n = items.length;
    const bit = weatherOutfitBit(d);

    // 明天没安排：天气穿衣照说，没数据才干脆的不打扰（bit 去掉「明天」主语避免重复）
    if (n === 0) {
      if (bit) {
        return `明天没安排，${bit.replace(/^明天/, "")}`;
      }
      return `明天没安排，想睡就多睡会儿。`;
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

    // 明日天气 + 穿衣（雨具等行动提示由 outfitTip 内含，预警一并提及）
    if (bit) {
      line += ` ${bit}`;
    }
    return line;
  }
}

/**
 * 明日天气+穿衣一句（兜底模板用；无明日天气 → 空串整句省略）。
 * 2026-10-16 简短口径（用户拍板）：穿衣只报一个层级 + 一个行动项，
 * 不念 buildClothingAdvice 全串（分号长串是给 LLM 的信息源，不是播报文案）。
 */
function weatherOutfitBit(d: EveningDigest): string {
  const w = d.tomorrowWeather;
  if (!w) return "";
  const layer =
    w.maxC >= 28 ? "短袖"
    : w.maxC >= 20 ? "长袖"
    : w.maxC >= 12 ? "外套"
    : w.maxC >= 5 ? "厚外套"
    : "羽绒服";
  const rainy = w.rainPct >= 40 || w.text.includes("雨");
  const snowy = w.text.includes("雪");
  const action = snowy ? "注意防滑" : rainy ? "记得带伞" : "";
  // 预警标签与天气文本重复（如「雷暴」既是 text 又是 alert）时不二次播报
  const alerts = w.alerts.filter((a) => !w.text.includes(a));
  const alertPart = alerts.length > 0 ? `，${alerts.join("、")}预警` : "";
  const actionPart = action ? `，${action}` : "";
  return `明天${w.text}${w.minC.toFixed(0)}~${w.maxC.toFixed(0)}度${alertPart}，${layer}${actionPart}。`;
}
