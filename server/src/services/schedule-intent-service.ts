import type { ExternalChatProvider } from "../external-model/types.js";
import { normalizeRemindBeforeMinutes, type ScheduleTaskCategory } from "./schedule-task-service.js";
import { extractReminderSubject, formatReminderMessage, isEchoLikeReminderCopy } from "./reminder-copy.js";

// 展示文案规整已抽到 reminder-copy.ts（createTask 落库闸口共用）；此处按旧出口转发，
// 既有调用方（schedule-user-reply / 测试）不受影响。
export { extractReminderSubject, formatReminderMessage };

export type ScheduleDraft = {
  title?: string;
  /** 简洁展示标题（用于「今日安排」紧凑列表：无指令词/无时间词，如「吃药」） */
  shortTitle?: string;
  description: string;
  kind: "reminder" | "action" | "weather_brief";
  /** 行程分类：itinerary=行程/正事（默认）；trivia=生活琐事（只后台提醒，不进「今日安排」） */
  category?: ScheduleTaskCategory;
  runAt: string;
  recurrence: "none" | "daily" | "weekly" | "yearly";
  /** 事件时长（分钟）；用于冲突检测。缺省 = 时间点提醒（无区间）。 */
  durationMinutes?: number;
  /** 事件地点（如「协和医院」「首都机场T3」）：提醒策略层据此估算路程安排出发预留。 */
  location?: string;
  /** 提前量提醒（分钟）：如 [15] = 到点前 15 分钟先提醒一次。仅用户明确说了提前量才填。 */
  remindBeforeMinutes?: number[];
  reminderMessage?: string;
  action?: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  };
};

/** 工具/API 在创建前需向用户确认重复方式时的固定提示（给模型读 tool.result）。 */
export const SCHEDULE_RECURRENCE_CONFIRM_HINT =
  "用户尚未说明提醒是否重复。请先向用户确认：这是一次性提醒、每天重复、还是连续一段时间？在用户明确回答前不要创建提醒，也不要声称已设置成功。";

export type TaskRecurrenceSuggestion = {
  suggestedType: "once" | "daily" | "continuous" | "weekly" | "yearly";
  confidence: "high" | "medium" | "low";
  reason: string;
  question: string;
  examples?: string[];
};

export type ScheduleIntentParseResult =
  | { matched: true; draft: ScheduleDraft }
  | {
      matched: false;
      needsRecurrenceConfirm: true;
      draft: ScheduleDraft;
      hint: string;
      suggestion?: TaskRecurrenceSuggestion;
    }
  | { matched: false; hint: string };

export class ScheduleIntentService {
  constructor(private readonly externalChat: ExternalChatProvider | null = null) {}

  /**
   * 内部子调用一律走 ephemeral + 独立会话键（2026-10-23 上下文污染根修）。
   *
   * 事故实证（`Nextbot-dev/data/chat-threads.json` 真实用户线程）：
   *
   *   user:      你是提醒文案助手。用户让助手到点提醒自己做一件事…（整段内部提示词）
   *   assistant: {"shortTitle":"去游泳","reminderMessage":"到点了，快去游泳吧"}
   *
   * 两个内部调用（解析器 / 文案转写）此前把**主聊天 sessionId** 直接传给
   * provider，且没置 `ephemeralTurn`。`streamCompletion` 于是把内部提示词当
   * 用户发言 push 进主线程、把 JSON 当助手发言落库。后果正是用户看到的两件事：
   *   1. 下一轮主模型把「用户让我转写提醒文案」当真实指令 → 重走一遍提醒流程
   *      （重复设置）、或对着 JSON 再说一遍（重复回复）；
   *   2. 内部 JSON/提示词进 recap 与记忆抽取 → 复读、污染。
   *
   * ephemeral 轮次的 `msgs` 是空数组、所有落库分支都被 `!ephemeral` 短路，
   * 主线程与持久化零接触；独立 session 键再兜一层（即便某 provider 忽略
   * ephemeral，也不会落到用户线程）。
   */
  private internalStreamOpts(stage: string): {
    ephemeralTurn: true;
    disableThinking: true;
    maxThreadMessages: number;
    auditStage: string;
  } {
    return {
      ephemeralTurn: true,
      disableThinking: true,
      maxThreadMessages: 0,
      auditStage: stage,
    };
  }

  /** 解析并判断是否可立即创建（提醒类在未说明重复时会要求先追问）。 */
  async parseForCreate(
    sessionId: string,
    userText: string,
    options?: { userTimezone?: string; now?: Date },
  ): Promise<ScheduleIntentParseResult> {
    const draft = await this.resolveDraft(sessionId, userText, options?.userTimezone, options?.now);
    if (!draft) {
      return {
        matched: false,
        hint: "未能解析时间或事项。请包含具体时刻或相对时间，如「一分钟后提醒我吃药」「明天 9:00 提醒我开会」。",
      };
    }
    if (draft.kind === "reminder" && needsRecurrenceConfirmation(userText)) {
      const suggestion = analyzeTaskRecurrencePattern(userText, draft);
      // 高置信一次性直接创建（2026-10-13 根修「没进日程」）：「取快递/开会/挂号」
      // 等一次性事项此前被重复确认闸门拦下（matched=false），而模型在确认问答
      // 之间口头宣称「已设置」——任务从未落库，日程页自然看不到。对齐 Siri/
      // ChatGPT「先建后说」语义：一次性先建（用户可再改/再删），没建才是事故。
      if (suggestion.suggestedType === "once" && suggestion.confidence === "high") {
        return { matched: true, draft };
      }
      return {
        matched: false,
        needsRecurrenceConfirm: true,
        draft,
        hint: SCHEDULE_RECURRENCE_CONFIRM_HINT,
        suggestion,
      };
    }
    return { matched: true, draft };
  }

  /** 仅解析草案（不拦截重复确认）；供预览接口使用。 */
  async parse(
    sessionId: string,
    userText: string,
    options?: { userTimezone?: string; now?: Date },
  ): Promise<ScheduleDraft | null> {
    return this.resolveDraft(sessionId, userText, options?.userTimezone, options?.now);
  }

  private async resolveDraft(
    sessionId: string,
    userText: string,
    userTimezone?: string,
    now?: Date,
  ): Promise<ScheduleDraft | null> {
    const ruleDraft = this.parseByRule(userText, userTimezone, now);
    if (ruleDraft) {
      return this.ensureReminderCopy(sessionId, userText, applyRecurrenceFromUserText(userText, ruleDraft));
    }
    const modelDraft = await this.parseByModel(sessionId, userText, userTimezone);
    if (!modelDraft) return null;
    return this.ensureReminderCopy(
      sessionId,
      userText,
      applyRecurrenceFromUserText(userText, backfillDurationFromUserText(userText, modelDraft)),
      true,
    );
  }

  /**
   * 提醒展示文案的生成权在模型，正则只做兜底（2026-10-21 根修）：
   * 规则路径没有语言判断力，extractReminderSubject 一旦失手（括号时间、口语变体）
   * 会把回声原句当「干净事项」放行——「4分钟后（17:40）提醒我去游泳」的文案
   * 就这样原样落库。模型在场时到点文案一律由模型转写（agent 口吻是语言任务，
   * 模板写不出「到点了，快去游泳吧」）；模型不可用/失败才落到
   * extractReminderSubject + formatReminderMessage 的正则兜底。唯一免调用通道：
   * 整句解析的模型草稿已在同一次调用里写好干净文案（fromModel 且非回声）。
   */
  private async ensureReminderCopy(
    sessionId: string,
    userText: string,
    draft: ScheduleDraft,
    fromModel = false,
  ): Promise<ScheduleDraft> {
    if (draft.kind !== "reminder") return draft;
    const copyClean = this.isCleanReminderCopy(draft);
    if (!this.externalChat?.isEnabled()) {
      return copyClean ? draft : this.fallbackReminderCopy(draft, userText);
    }
    if (copyClean && fromModel) return draft;
    const rewritten = await this.rewriteCopyByModel(sessionId, userText);
    if (rewritten) {
      return {
        ...draft,
        shortTitle: rewritten.shortTitle ?? draft.shortTitle,
        reminderMessage: rewritten.reminderMessage ?? draft.reminderMessage,
      };
    }
    // 模型调用失败：有干净文案就保留（模板/模型草稿），否则正则兜底重推导
    return copyClean ? draft : this.fallbackReminderCopy(draft, userText);
  }

  private isCleanReminderCopy(draft: ScheduleDraft): boolean {
    const message = draft.reminderMessage?.trim() ?? "";
    const short = draft.shortTitle?.trim() ?? "";
    return (
      message.length > 0 &&
      short.length > 0 &&
      !isEchoLikeReminderCopy(message) &&
      !isEchoLikeReminderCopy(short)
    );
  }

  /** 模型不可用时的正则兜底：从原句重推导（可能仍有残缺，但不会比现状差）。 */
  private fallbackReminderCopy(draft: ScheduleDraft, userText: string): ScheduleDraft {
    const message = draft.reminderMessage?.trim() ?? "";
    const short = draft.shortTitle?.trim() ?? "";
    const subject = extractReminderSubject(userText);
    return {
      ...draft,
      shortTitle:
        short && !isEchoLikeReminderCopy(short)
          ? draft.shortTitle
          : subject === "到点提醒"
            ? undefined
            : subject,
      reminderMessage:
        message && !isEchoLikeReminderCopy(message)
          ? draft.reminderMessage
          : formatReminderMessage(subject),
    };
  }

  /** 请模型把用户原句转写成到点时 agent 口吻的提醒文案（单次小调用）。 */
  private async rewriteCopyByModel(
    sessionId: string,
    userText: string,
  ): Promise<{ shortTitle?: string; reminderMessage?: string } | null> {
    if (!this.externalChat?.isEnabled()) return null;
    const prompt = [
      "你是提醒文案助手。用户让助手到点提醒自己做一件事，下面是用户原句。",
      "请把它转写成到点时展示的两条文案，用助手（agent）主动提醒用户的口吻：",
      '1. reminderMessage：到点推送文案，像助手在身边催用户去做这件事，如「到点了，快去游泳吧」「时间到了，该吃药啦」；不复述用户原句，不出现「提醒我」类指令词，不带任何时间表述（时刻会单独展示），不把用户对助手的称呼写进文案。',
      "2. shortTitle：不超过 8 字的纯事项短标题（如「去游泳」），无指令词、无时间词、无标点。",
      "只返回 JSON，不要输出 markdown 或解释：{\"shortTitle\":\"...\",\"reminderMessage\":\"...\"}",
      `用户原句：${userText}`,
    ].join("\n");
    try {
      const text = await this.externalChat.streamCompletion(
        // 独立会话键：内部子调用不得复用主聊天线程（见 internalStreamOpts 注释）。
        `schedule_copy:${sessionId}`,
        { text: prompt },
        () => {
          // 后台转写，不需要流式回传。
        },
        undefined,
        this.internalStreamOpts("schedule_copy"),
      );
      const json = safeParseJsonObject(text);
      if (!json) return null;
      const reminderMessage = String(json.reminderMessage ?? "").trim();
      if (!reminderMessage || isEchoLikeReminderCopy(reminderMessage)) return null;
      const shortTitle = String(json.shortTitle ?? "").trim();
      return {
        shortTitle: shortTitle && !isEchoLikeReminderCopy(shortTitle) ? shortTitle : undefined,
        reminderMessage,
      };
    } catch {
      return null;
    }
  }

  private async parseByModel(
    sessionId: string,
    userText: string,
    userTimezone?: string,
  ): Promise<ScheduleDraft | null> {
    if (!this.externalChat?.isEnabled()) return null;
    const now = new Date();
    const tz = (userTimezone?.trim() || "Asia/Shanghai") as string;
    // 使用 Intl 按用户时区格式化当前时间，避免依赖服务器操作系统时区
    const localTimeStr = now.toLocaleString("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const nowIso = now.toISOString();
    const prompt = [
      "你是任务解析器。请把用户句子解析为定时任务 JSON。",
      `当前用户本地时间：${localTimeStr}（时区 ${tz}，ISO: ${nowIso}）。所有相对时间（X 分钟后/小时后、明天、今天 HH:MM）必须基于此时间换算为 ISO-8601 字符串。`,
      "中文数字映射：一/壹/壹=1，二/贰/两=2，三/叁=3，…，十=10，十一=11，…二十=20。",
      "只返回 JSON，不要输出 markdown 或解释。",
      "若无法解析，返回 {\"ok\":false}。",
      "可解析格式示例：明天 09:00 提醒我开会；今天 18:00 调用 https://api.com/sync 同步；每天 7:00 天气提醒（kind 为 weather_brief）。",
      "recurrence 规则：仅当用户明确说出「每天/每日/每周/每年」等重复词时用 daily、weekly 或 yearly；明确单次（仅一次/明天/今天/后天）用 none。",
      "若只有时刻与提醒事项、未说明单次或每天/每周/每年，返回 {\"ok\":false,\"reason\":\"needs_recurrence\"}，不要猜测 recurrence。",
      "若用户要「天气/气温/穿衣/带伞」类定时简报，kind 用 weather_brief，不要填 reminderMessage 或 action。",
      "category：行程/正事用 itinerary；喝水/睡觉/锻炼等生活琐事用 trivia（照常提醒，不进今日安排）；不确定用 itinerary。",
      "JSON 结构：",
      "{",
      '  "ok": true,',
      '  "task": {',
      '    "title": "完整标题，如「记得提醒我3点吃药」（可选；reminder 可不填，由 reminderMessage 自动生成）",',
      '    "shortTitle": "简洁展示标题，用于「今日安排」紧凑列表：去掉时间与「记得/提醒我/帮我/给我」等指令词，只保留核心事项，如「记得提醒我3点吃药」→「吃药」；用户对助手的称呼（如「小弟」「老哥」）不是事项，也要去掉。必须是干净的事项词（≤12字），出现时间词/指令词/悬空的「的」开头都算错；不要复述原句。reminder 必填，其他类型与 title 相同或更短（可选)",',
      '    "description": "用户原句",',
      '    "kind": "reminder|action|weather_brief",',
      '    "category": "itinerary|trivia",',
      '    "runAt": "ISO-8601 string",',
      '    "recurrence": "none|daily|weekly|yearly",',
      '    "durationMinutes": "事件时长（分钟，整数，可选）。用户说了起止时间（如「9点到10点半开会」→ 90）或明确时长（「开会1小时」→ 60）时必须填写；只说「X点提醒我做某事」没有时长概念时省略",',
      '    "location": "事件地点（可选）。用户说了具体地点（如「去协和医院看牙」「首都机场T3」）就填；系统据此估算路程并动态安排分级提醒（前晚备忘/起床闹钟/出发预留）；没说地点就不填",',
      '    "remindBeforeMinutes": "提前量提醒（分钟数组，可选）。仅当用户明确说出提前量（如「提前15分钟提醒我开会」→ [15]）时填写；用户没说就省略——系统会按事项时间/重要程度/地点自动安排分级提醒，不要替用户默认填 [15]",',
      '    "reminderMessage": "到点时展示给用户的友好提醒，如「该吃药啦！记得按时服药」而非「喊我睡觉」或「睡觉」；不要把用户对助手的称呼（如「小弟」）写进文案（仅 reminder）。禁止复述用户原句（「11点提醒我吃饭」这类回声是错的），禁止带时间表述——到点时刻会单独展示，文案只说事本身",',
      '    "action": { "url": "https://...", "method": "POST", "body": {} }',
      "  }",
      "}",
      `用户输入：${userText}`,
    ].join("\n");
    try {
      const text = await this.externalChat.streamCompletion(
        // 同上：解析器是内部子调用，必须 ephemeral + 独立会话键。
        `schedule_parse:${sessionId}`,
        { text: prompt },
        () => {
          // HTTP 路由不需要流式回传。
        },
        undefined,
        this.internalStreamOpts("schedule_parse"),
      );
      const json = safeParseJsonObject(text);
      if (!json || json.ok !== true || !json.task) return null;
      const task = validateDraft(json.task);
      return task;
    } catch {
      return null;
    }
  }

  private parseByRule(userText: string, userTimezone?: string, now?: Date): ScheduleDraft | null {
    const normalized = userText.trim();
    const runAt = parseDateTimeFromPrompt(normalized, userTimezone, now);
    if (!runAt) return null;
    const recurrence = inferRecurrenceFromUserText(normalized);
    const durationMinutes = parseDurationFromUserText(normalized);
    const urlMatch = normalized.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      return {
        title: "AI 动作任务",
        description: normalized,
        kind: "action",
        runAt: runAt.toISOString(),
        recurrence,
        action: {
          url: urlMatch[0],
          method: /GET/i.test(normalized) ? "GET" : "POST",
          body: { prompt: normalized },
        },
      };
    }
    if (isWeatherBriefIntent(normalized)) {
      return {
        title: "每日天气与穿衣提示",
        description: normalized,
        kind: "weather_brief",
        // 周期性天气简报属例行琐事；一次性（如「明早提醒我带伞」）是真实安排，保持展示
        category: recurrence === "none" ? undefined : "trivia",
        runAt: runAt.toISOString(),
        recurrence,
      };
    }
    if (isReminderIntent(normalized)) {
      const reminderText = extractReminderSubject(normalized);
      return {
        shortTitle: reminderText === "到点提醒" ? undefined : reminderText,
        description: normalized,
        kind: "reminder",
        // 规则路径没有 LLM，用保守关键词兜底识别琐事（宁漏勿误：漏判只是多展示一条，误判会藏掉正事）
        category: RULE_PATH_TRIVIA_PATTERN.test(normalized) ? "trivia" : undefined,
        runAt: runAt.toISOString(),
        recurrence,
        durationMinutes,
        remindBeforeMinutes: parseRemindBeforeFromUserText(normalized),
        reminderMessage: formatReminderMessage(reminderText),
      };
    }
    return null;
  }
}

/** 规则路径（无 LLM）的琐事兜底识别：仅命中明确的自我照顾类措辞才判 trivia。 */
const RULE_PATH_TRIVIA_PATTERN =
  /喝水|喝口水|补水|睡觉|午睡|小睡|小憩|午休|休息一下|休息一会儿|休息会儿|运动|锻炼|健身|散步|伸懒腰|活动筋骨|活动一下|远眺|护眼|眨眨眼|上厕所/;

/** 数字 token 解析（不受 0-23 小时上限约束）：阿拉伯数字 + 中文小写数字（如 90、两、三十五）。 */
function parseCountToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (/^\d{1,4}$/.test(t)) return Number(t);
  return parseChineseHourToken(t);
}

/** 从用户原句抽取事件时长（分钟）：支持「9点到10点半」区间与「1小时/90分钟/一个半小时」时长表述。 */
export function parseDurationFromUserText(text: string): number | undefined {
  // 先剥离「提前X分钟/小时」状语（相对偏移而非时长），再做时长抽取
  const normalized = text
    .trim()
    .replace(
      /提前\s*[零一二两三四五六七八九十\d]{1,3}\s*(?:个)?\s*(?:半)?\s*(?:分钟|小时|钟头)/g,
      " ",
    );
  const timeToken = String.raw`\d{1,2}[:：]\d{2}|\d{1,2}\s*点(?:半|\d{1,2}\s*分?)?|[零一二两三四五六七八九十]{1,4}\s*点(?:半|\d{1,2}\s*分?)?`;
  const range = normalized.match(
    new RegExp(`(${timeToken})\\s*(?:到|至|~|-|—)\\s*(${timeToken})`),
  );
  if (range) {
    const start = parseHourMinuteFromPrompt(range[1]!);
    const end = parseHourMinuteFromPrompt(range[2]!);
    if (start && end) {
      let diff = end.hours * 60 + end.minutes - (start.hours * 60 + start.minutes);
      if (diff < 0) diff += 24 * 60; // 跨零点
      if (diff > 0 && diff <= 12 * 60) return diff;
    }
  }
  // 「一个半小时」（须先于「X小时」匹配，避免只吃到「个小时」）
  const andHalf = normalized.match(/([零一二两三四五六七八九十]{1,3}|\d+)\s*个半小时/);
  if (andHalf) {
    const h = parseCountToken(andHalf[1]!);
    if (h != null && h > 0 && h <= 12) return h * 60 + 30;
  }
  const hours = normalized.match(
    /([零一二两三四五六七八九十]{1,3}|\d+)?\s*(?:个)?\s*(半)?\s*(?:小时|钟头)(?!后|之后|前)/,
  );
  if (hours && (hours[1] || hours[2])) {
    const base = hours[1] ? parseCountToken(hours[1]) ?? 0 : 0;
    if (base > 24) return undefined;
    return base * 60 + (hours[2] ? 30 : 0);
  }
  const minutes = normalized.match(/([零一二两三四五六七八九十]{1,3}|\d+)\s*分钟(?!后|之后|以内|前)/);
  if (minutes) {
    const m = parseCountToken(minutes[1]!);
    if (m != null && m > 0 && m <= 720) return m;
  }
  return undefined;
}

/** 从用户原句抽取提前量（分钟）：「提前10分钟提醒我开会」→ [10]；「提前30/90/120分钟」均可（提前量不是小时，勿用 0-23 的小时解析器）。 */
export function parseRemindBeforeFromUserText(text: string): number[] | undefined {
  const m = text.trim().match(/提前\s*([零一二两三四五六七八九十]{1,3}|\d+)\s*分钟/);
  if (!m) return undefined;
  const n = parseCountToken(m[1]!);
  if (n == null || n <= 0 || n > 7 * 24 * 60) return undefined;
  return [n];
}

function safeParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function validateDraft(input: unknown): ScheduleDraft | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const title = String(v.title ?? "").trim();
  const shortTitle = String(v.shortTitle ?? "").trim() || undefined;
  const description = String(v.description ?? "").trim();
  const kind = v.kind;
  const runAt = String(v.runAt ?? "");
  const recurrence = v.recurrence;
  const validKind = kind === "reminder" || kind === "action" || kind === "weather_brief";
  const validRecurrence =
    recurrence === "none" ||
    recurrence === "daily" ||
    recurrence === "weekly" ||
    recurrence === "yearly";
  if (!description || !validKind || !validRecurrence) return null;
  const runAtDate = new Date(runAt);
  if (Number.isNaN(runAtDate.getTime())) return null;
  const category: ScheduleTaskCategory | undefined =
    v.category === "trivia" || v.category === "itinerary" ? v.category : undefined;
  const durationRaw = Number(v.durationMinutes);
  const durationMinutes =
    Number.isFinite(durationRaw) && durationRaw > 0 && durationRaw <= 24 * 60
      ? Math.round(durationRaw)
      : undefined;
  const remindBeforeMinutes = normalizeRemindBeforeMinutes(v.remindBeforeMinutes);
  const location = String(v.location ?? "").trim() || undefined;
  if (kind === "weather_brief") {
    if (!title) return null;
    return { title, shortTitle, description, kind: "weather_brief", category, runAt: runAtDate.toISOString(), recurrence };
  }
  if (kind === "reminder") {
    // reminderMessage 缺省不回填 description（那等于构造性回声）：留空交给
    // ensureReminderCopy 统一补齐（模型转写优先，正则兜底）。
    const reminderMessage = String(v.reminderMessage ?? "").trim() || undefined;
    return {
      description,
      shortTitle,
      kind,
      category,
      runAt: runAtDate.toISOString(),
      recurrence,
      durationMinutes,
      location,
      remindBeforeMinutes,
      reminderMessage,
    };
  }
  if (!title) return null;
  const actionObj = v.action as Record<string, unknown> | undefined;
  const url = String(actionObj?.url ?? "").trim();
  if (!url) return null;
  const methodRaw = String(actionObj?.method ?? "POST").toUpperCase();
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodRaw)
    ? (methodRaw as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
    : "POST";
  return {
    title,
    shortTitle,
    description,
    kind,
    category,
    runAt: runAtDate.toISOString(),
    recurrence,
    durationMinutes,
    action: { url, method, body: actionObj?.body },
  };
}

/** 用户是否已明确单次或重复（明确则可直接创建，无需追问）。 */
export function isRecurrenceExplicit(userText: string): boolean {
  const normalized = userText.trim();
  if (parseRelativeDateTimeFromPrompt(normalized)) return true;
  if (inferRecurrenceFromUserText(normalized) !== "none") return true;
  if (isAlarmStyleReminder(normalized) && parseDateTimeFromPrompt(normalized)) return true;
  if (
    /仅一次|就一次|单次|一次性的|仅此一次|只提醒一次|只叫一次|不要重复|不用每天|不重复|别重复/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/明天|今天|后天|今早|今晚|明早|明晚|大后天/.test(normalized)) return true;
  return false;
}

/** 提醒类且能解析出时间，但未说明是否重复 → 须先向用户确认。 */
export function needsRecurrenceConfirmation(userText: string): boolean {
  const normalized = userText.trim();
  if (!isReminderIntent(normalized)) return false;
  if (isWeatherBriefIntent(normalized)) return false;
  if (/https?:\/\/[^\s]+/i.test(normalized)) return false;
  if (!parseDateTimeFromPrompt(normalized)) return false;
  return !isRecurrenceExplicit(normalized);
}

export function buildRecurrenceConfirmToolResult(
  draft: ScheduleDraft,
  suggestion?: TaskRecurrenceSuggestion,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ok: true,
    matched: false,
    needsRecurrenceConfirm: true,
    hint: SCHEDULE_RECURRENCE_CONFIRM_HINT,
    parsedNextRunAt: draft.runAt,
    parsedReminderMessage: draft.reminderMessage ?? draft.description,
  };

  if (suggestion) {
    result.suggestedQuestion = suggestion.question;
    result.suggestedType = suggestion.suggestedType;
    result.confidence = suggestion.confidence;
    result.reason = suggestion.reason;
    if (suggestion.examples) {
      result.examples = suggestion.examples;
    }
  } else {
    result.suggestedQuestion = "这是一次性提醒，还是每天重复，或者连续一段时间（比如接下来3天）？";
  }

  return result;
}

/** 智能分析任务内容，推断最可能的重复类型并提供询问建议 */
export function analyzeTaskRecurrencePattern(userText: string, draft: ScheduleDraft): TaskRecurrenceSuggestion {
  const normalized = userText.trim();
  const subject = (draft.reminderMessage ?? draft.description).trim();

  const ONCE_PATTERNS = [
    { pattern: /开会|会议|讨论|评审|汇报|演示|面试|约会|聚餐|吃饭|见面|拜访|签合同|交报告|提交|截止|deadline/i, reason: "这类任务通常有明确的时间点，一般只发生一次" },
    { pattern: /买.*?票|订.*?房|预订|预约|挂号|取件|快递|发货/i, reason: "这类任务通常是一次性的具体事项" },
    { pattern: /接.*?(人|机|孩子)|送.*?(人|机|孩子)|去.*?(机场|车站|医院)/i, reason: "接送类任务通常是一次性的行程安排" },
    { pattern: /还书|还钱|还款|缴费|付.*?款|续费/i, reason: "支付/归还类任务通常有明确的单次时间点" },
    { pattern: /生日.*?(派对|聚会|庆祝|礼物)|纪念.*?(日|活动)|节日.*?(准备|购物|安排)/i, reason: "特殊日期的活动通常是一次性的" },
  ];

  const DAILY_PATTERNS = [
    { pattern: /吃药|服药|用药|喝药|胰岛素|打针/i, reason: "用药提醒通常需要每日重复" },
    { pattern: /喝水|补水|运动|锻炼|健身|跑步|瑜伽|散步|冥想/i, reason: "健康习惯类提醒通常建议每日重复" },
    { pattern: /打卡|签到|学习|背单词|阅读|写日记|记账/i, reason: "日常习惯养成类任务通常适合每日重复" },
    { pattern: /喂.*?(宠物|猫|狗|鱼)|铲屎|遛狗/i, reason: "宠物照料通常需要每日重复" },
    { pattern: /备份|同步|清理.*?(缓存|垃圾|邮件)|整理.*?(桌面|文件)/i, reason: "维护类任务通常建议定期重复" },
    { pattern: /新闻.*?(推送|简报|早报|日报|推送)|推送.*?新闻|简报|早报|日报|每天.*?(搜|查|看|推送).*?新闻/i, reason: "新闻/简报/早报类任务通常是长期的每日信息推送需求" },
  ];

  const CONTINUOUS_PATTERNS = [
    { pattern: /接下来.*?(\d+).*?(天|周|小时)|连续.*?(\d+).*?(天|周|小时)|持续.*?(\d+).*?(天|周|小时)/i, reason: "用户明确提到了持续时间" },
    { pattern: /这周|本周|这几天|最近.*?几天/i, reason: "用户提到了一个时间段范围" },
    { pattern: /疗程|训练计划|备考|复习|冲刺|项目.*?(周期|阶段)/i, reason: "这类任务通常需要在特定周期内连续执行" },
  ];

  for (const { pattern, reason } of ONCE_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(subject)) {
      return {
        suggestedType: "once",
        confidence: "high",
        reason,
        question: `这个「${subject}」看起来像是一次性任务。${reason} 我应该设置为一次性提醒吗？`,
        examples: [
          "✅ 就设置一次性的",
          "📅 其实我想每天重复",
          "⏰ 接下来一周每天都提醒我",
        ],
      };
    }
  }

  if (isNewsBriefIntent(normalized) || isNewsBriefIntent(subject)) {
    return {
      suggestedType: "daily",
      confidence: "high",
      reason: "新闻/简报/早报类任务是长期的信息推送需求，建议设置为每天自动推送",
      question: `「${subject}」看起来像是日常信息推送需求。你想设置为每天永久性自动推送吗？`,
      examples: [
        "✅ 好的，每天永久推送（推荐）",
        "📅 只需要今天一次",
        "📆 仅工作日推送（周一到周五）",
        "⏰ 接下来一周每天推送",
      ],
    };
  }

  for (const { pattern, reason } of CONTINUOUS_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(subject)) {
      const durationMatch = normalized.match(/(?:接下来|连续|持续)\s*(\d+)\s*(天|周|小时)/i);
      const duration = durationMatch ? `${durationMatch[1]}${durationMatch[2]}` : "一段时间";
      return {
        suggestedType: "continuous",
        confidence: "high",
        reason,
        question: `你提到了"${duration}"，是想在这段时间内每天重复提醒吗？`,
        examples: [
          `✅ 是的，${duration}内每天提醒`,
          "🔄 改为每天长期重复",
          "❌ 只需要一次就好",
        ],
      };
    }
  }

  for (const { pattern, reason } of DAILY_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(subject)) {
      return {
        suggestedType: "daily",
        confidence: "medium",
        reason,
        question: `这个「${subject}」看起来像是日常习惯。${reason} 你想设置为每天重复吗？`,
        examples: [
          "✅ 好的，每天重复",
          "📅 这次只需要一次",
          "📆 每周一到周五就行（工作日）",
          "⏰ 接下来7天每天提醒我",
        ],
      };
    }
  }

  if (isAlarmStyleReminder(normalized)) {
    return {
      suggestedType: "daily",
      confidence: "high",
      reason: "起床/闹钟类提醒通常是每天的日常需求",
      question: "这是一个起床/闹钟提醒。你想设置为每天重复吗？（大多数人的闹钟都是每天响的）",
      examples: [
        "✅ 每天都响（推荐）",
        "📅 只要明天一次",
        "📆 仅工作日（周一到周五）",
      ],
    };
  }

  return {
    suggestedType: "once",
    confidence: "low",
    reason: "未能从任务内容推断出明确的重复模式",
    question: `关于「${subject}」的提醒，你想怎么设置重复方式？`,
    examples: [
      "📅 就这一次",
      "🔄 每天重复",
      "📆 每周重复",
      "⏰ 接下来几天连续提醒",
    ],
  };
}

/** 起床/闹钟类：用户未说「仅一次/明天」时默认每天重复，避免误拦创建。 */
function isAlarmStyleReminder(text: string): boolean {
  return /叫我起床|起床|闹钟|叫醒|定时叫/.test(text.trim());
}

/** 从用户原句推断重复规则（未明确重复词则单次 none；闹钟类默认可每天）。 */
export function inferRecurrenceFromUserText(userText: string): "none" | "daily" | "weekly" | "yearly" {
  const normalized = userText.trim();
  if (parseRelativeDateTimeFromPrompt(normalized)) return "none";
  if (/每年|每一年|每逢|周年|生日/.test(normalized)) return "yearly";
  if (/每周|每星期|每个星期|礼拜/.test(normalized)) return "weekly";
  if (
    /每天|每日|天天|每个工作日|工作日每天|每天早晨|每天早上|每晚|每天晚上|夜里每天/.test(
      normalized,
    )
  ) {
    return "daily";
  }
  if (
    isAlarmStyleReminder(normalized) &&
    !/仅一次|就一次|单次|一次性的|仅此一次|只提醒一次|只叫一次|不要重复|不用每天|不重复|别重复|明天|后天|今天|今早|今晚|明早|明晚|大后天/.test(
      normalized,
    )
  ) {
    return "daily";
  }
  return "none";
}

function applyRecurrenceFromUserText(userText: string, draft: ScheduleDraft): ScheduleDraft {
  const recurrence = inferRecurrenceFromUserText(userText);
  if (draft.recurrence === recurrence) return draft;
  return { ...draft, recurrence };
}

/** LLM 路径漏填时长时用规则抽取回填（规则路径已在 parseByRule 内计算）。 */
function backfillDurationFromUserText(userText: string, draft: ScheduleDraft): ScheduleDraft {
  if (draft.durationMinutes != null) return draft;
  const duration = parseDurationFromUserText(userText);
  if (duration == null) return draft;
  return { ...draft, durationMinutes: duration };
}

/** 闹钟/叫醒类意图（含口语「叫我起床」等，不必出现「提醒」二字） */
function isReminderIntent(text: string): boolean {
  return /提醒我|提醒一下|提醒|闹钟|叫我起床|喊我起床|起床|叫醒|叫我|喊我|定时叫|定时提醒/.test(
    text,
  );
}

/** 天气/穿衣类定时简报（与普通「提醒我」区分：须含下列关键词之一） */
function isWeatherBriefIntent(text: string): boolean {
  return /(天气|气温|穿衣|天气预报|天气提醒|出门穿|带伞)/.test(text);
}

/** 新闻/简报/早报/日报类定时推送（识别为长期每日任务，避免误判为临时性任务） */
function isNewsBriefIntent(text: string): boolean {
  return /(新闻.*?(推送|简报|早报|日报)|推送.*?新闻|科技新闻|每日新闻|每天.*?新闻|新闻早报|新闻日报|资讯.*?(推送|简报)|早报|日报|简报)/.test(text);
}

function validClock(hours: number, minutes: number): boolean {
  return (
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59
  );
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文小写数字 → 0–23 点（如 七→7，十一→11，二十三→23） */
function parseChineseHourToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n <= 23 ? n : null;
  }
  if (t === "十") return 10;
  if (t.startsWith("十")) {
    const rest = t.slice(1);
    if (!rest) return 10;
    const ones = CN_DIGIT[rest[0]!];
    return ones != null ? 10 + ones : null;
  }
  if (t.endsWith("十")) {
    const head = t.slice(0, -1);
    if (!head) return 10;
    const tens = CN_DIGIT[head[0]!];
    return tens != null ? tens * 10 : null;
  }
  if (t.includes("十")) {
    const [head, tail] = t.split("十");
    const tens = head ? (CN_DIGIT[head] ?? (head === "" ? 1 : null)) : 1;
    const ones = tail ? (CN_DIGIT[tail] ?? 0) : 0;
    if (tens == null) return null;
    return tens * 10 + ones;
  }
  const single = CN_DIGIT[t];
  return single != null ? single : null;
}

/** 根据 早上/下午/晚上 等修饰词将 1–11 点映射到 24 小时制（今晚/明晚 也按晚上算） */
function applyDayPeriodHint(hours: number, text: string): number {
  if (/今晚|明晚|晚上|夜间|半夜|傍晚/.test(text) && hours >= 1 && hours <= 11) return hours + 12;
  if (/下午/.test(text) && hours >= 1 && hours <= 11) return hours + 12;
  return hours;
}

/** 从文案解析时、分：支持 14:30、7点、7点半、七点、十一点半、早上七点 */
function parseHourMinuteFromPrompt(text: string): { hours: number; minutes: number } | null {
  const colon = text.match(/(\d{1,2})[:：](\d{2})/);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
  }

  const cnHalf = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点半/,
  );
  if (cnHalf) {
    const hours = parseChineseHourToken(cnHalf[1]!);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), 30)) {
      return { hours: applyDayPeriodHint(hours, text), minutes: 30 };
    }
  }

  const half = text.match(/(\d{1,2})\s*点半/);
  if (half) {
    // 时段词映射对数字形态同样生效（2026-10-13 修复）：「晚上7点半」此前因
    // 阿拉伯数字分支未过 applyDayPeriodHint 被解析成 07:30
    const hours = applyDayPeriodHint(Number(half[1]), text);
    if (validClock(hours, 30)) return { hours, minutes: 30 };
  }

  const cnPointSub = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点\s*(\d{1,2})\s*分?/,
  );
  if (cnPointSub && !text.includes("点半")) {
    const hours = parseChineseHourToken(cnPointSub[1]!);
    const minutes = Number(cnPointSub[2]);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), minutes)) {
      return { hours: applyDayPeriodHint(hours, text), minutes };
    }
  }

  const pointSub = text.match(/(\d{1,2})\s*点\s*(\d{1,2})\s*分?/);
  if (pointSub && !text.includes("点半")) {
    const hours = applyDayPeriodHint(Number(pointSub[1]), text);
    const minutes = Number(pointSub[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
  }

  const cnPointOnly = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点(?!半|[要摘分])/,
  );
  if (cnPointOnly) {
    const hours = parseChineseHourToken(cnPointOnly[1]!);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), 0)) {
      return { hours: applyDayPeriodHint(hours, text), minutes: 0 };
    }
  }

  const pointOnly = text.match(/(\d{1,2})\s*点(?!半|[要摘分])/);
  if (pointOnly) {
    const hours = applyDayPeriodHint(Number(pointOnly[1]), text);
    if (validClock(hours, 0)) return { hours, minutes: 0 };
  }
  return null;
}

/** 供测试与即时提醒快路径：解析用户句中的可执行时间点（相对或绝对）。 */
export function parseScheduleTimeFromPrompt(text: string, timezone?: string, now?: Date): Date | null {
  return parseDateTimeFromPrompt(text, timezone, now);
}

const RELATIVE_TIME_STRIP_RE =
  /(?:半(?:个)?(?:小时|钟头)|\d+\s*秒(?:钟)?|[一二两三四五六七八九十]{1,3}|\d+)\s*(?:个)?(?:分钟|小时|钟头)(?:后|之后|以内)?|半(?:个)?(?:小时|钟头)(?:后|之后)?/g;

function parseRelativeDateTimeFromPrompt(text: string, now: Date = new Date()): Date | null {
  const normalized = text.trim();

  if (/半(?:个)?(?:小时|钟头)(?:后|之后)?/.test(normalized)) {
    return new Date(now.getTime() + 30 * 60 * 1000);
  }

  const secNum = normalized.match(/(\d+)\s*秒(?:钟)?(?:后|之后)?/);
  if (secNum) {
    const n = Number(secNum[1]);
    if (n > 0 && n <= 86400) return new Date(now.getTime() + n * 1000);
  }

  const minNum = normalized.match(/(\d+)\s*分钟(?:后|之后|以内)?/);
  if (minNum) {
    const n = Number(minNum[1]);
    if (n > 0 && n <= 10080) return new Date(now.getTime() + n * 60 * 1000);
  }

  const cnMin = normalized.match(
    /([一二两三四五六七八九十]{1,3})\s*(?:个)?分钟(?:后|之后|以内)?/,
  );
  if (cnMin) {
    const n = parseChineseHourToken(cnMin[1]!);
    if (n != null && n > 0 && n <= 10080) return new Date(now.getTime() + n * 60 * 1000);
  }

  const hrNum = normalized.match(/(\d+)\s*小时(?:后|之后)?/);
  if (hrNum) {
    const n = Number(hrNum[1]);
    if (n > 0 && n <= 168) return new Date(now.getTime() + n * 3600 * 1000);
  }

  const cnHr = normalized.match(/([一二两三四五六七八九十]{1,3})\s*(?:个)?小时(?:后|之后)?/);
  if (cnHr) {
    const n = parseChineseHourToken(cnHr[1]!);
    if (n != null && n > 0 && n <= 168) return new Date(now.getTime() + n * 3600 * 1000);
  }

  return null;
}

function parseDateTimeFromPrompt(text: string, timezone?: string, now: Date = new Date()): Date | null {
  // 「提前X分钟/小时」是提醒偏移不是事件锚点：先剥掉再做时间解析，
  // 否则「提前30分钟提醒我」会被相对时间正则误读成「30分钟后」（事件变成半小时后）。
  const anchorText = text.replace(
    /提前\s*[零一二两三四五六七八九十\d]{1,3}\s*(?:个)?\s*(?:半)?\s*(?:分钟|小时|钟头)/g,
    " ",
  );
  const relative = parseRelativeDateTimeFromPrompt(anchorText, now);
  if (relative) return relative;

  const hm = parseHourMinuteFromPrompt(anchorText);
  if (!hm) return null;
  const { hours, minutes } = hm;
  const tz = timezone?.trim();
  const base = tz ? getLocalDateInTimezone(now, tz) : now;
  const target = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hours,
    minutes,
    0,
    0,
  );
  if (/后天/.test(anchorText)) target.setDate(target.getDate() + 2);
  else if (/明天|明晚/.test(anchorText)) target.setDate(target.getDate() + 1);
  const utc = tz ? toUtcFromLocalTime(target, tz) : target;
  if (utc.getTime() <= now.getTime()) {
    // 就近未来回退（2026-10-13 根修「18:00 说 7点半 → 次日 07:30」）：
    // 裸「X点半/X点」（1–11 点、无 早上/上午/凌晨/半夜/中午 时段词、无 明天/后天
    // 日期偏移）解析结果早于当前时，先尝试 +12h 的下午/晚上解释——18:00 说
    // 「7点半」最自然的理解是当天 19:30 而非次日 07:30，对齐 chrono-node
    // forwardDate 的就近未来语义。带显式时段词的保持字面语义（「早上8点」在
    // 18:00 说就是明早 8 点）。
    const hasExplicitAmWord = /早上|上午|凌晨|半夜|中午/.test(anchorText);
    const hasExplicitDayShift = /明天|后天/.test(anchorText);
    if (!hasExplicitAmWord && !hasExplicitDayShift && hours >= 1 && hours <= 11) {
      const pmTarget = new Date(target.getTime());
      pmTarget.setHours(hours + 12);
      const pmUtc = tz ? toUtcFromLocalTime(pmTarget, tz) : pmTarget;
      if (pmUtc.getTime() > now.getTime()) return pmUtc;
    }
    target.setDate(target.getDate() + 1);
    return tz ? toUtcFromLocalTime(target, tz) : target;
  }
  return utc;
}

function getLocalDateInTimezone(now: Date, timezone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const v: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  return new Date(v.year, v.month - 1, v.day, v.hour ?? 0, v.minute ?? 0, v.second ?? 0);
}

function toUtcFromLocalTime(localTime: Date, timezone: string): Date {
  const y = localTime.getFullYear();
  const mo = localTime.getMonth();
  const d = localTime.getDate();
  const h = localTime.getHours();
  const mi = localTime.getMinutes();
  const s = localTime.getSeconds();

  let tentative = new Date(Date.UTC(y, mo, d, h, mi, s));
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(tentative);
  const tzVals: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") tzVals[p.type] = Number(p.value);
  }
  let deltaMs =
    ((h - (tzVals.hour ?? 0)) * 60 + (mi - (tzVals.minute ?? 0))) * 60000 +
    (s - (tzVals.second ?? 0)) * 1000;
  if (deltaMs > 43200000) deltaMs -= 86400000;
  if (deltaMs < -43200000) deltaMs += 86400000;
  return new Date(tentative.getTime() + deltaMs);
}
