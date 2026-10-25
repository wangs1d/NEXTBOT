import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../../external-model/resolve-provider.js";
import { geocodeCity } from "../../services/weather-service.js";
import { travelPlanStore } from "./travel-plan-store.js";
import type { PlanningResult, PlanningService } from "./travel-planning-service.js";
import { auditChatCompletion } from "../../services/llm-token-audit.js";

// ═══════════════════════════════════════════════════════════════════
// 行程规划会话（v3 旅游界面 · Agent 驱动规划流）
//
// 用户一句话发起 → LLM 编排器逐轮决定「说什么 / 信息还缺什么 / 下一张
// 问题卡问什么」。问题卡没有任何硬编码清单：问哪个维度、问题文案、
// 选项（贴合用户已说过的内容，如「5、6天」→ 5天/6天）全部由编排器按
// 上下文真实生成；已给出（含模糊表达、「随便」类回答）的信息一律不再
// 追问。服务端只做硬护栏：没拿到目的地不出卡、已答过的维度不再出卡、
// 追问轮数封顶，防连环查户口。
// 全部对齐后客户端调 generate → 复用 PlanningService.generateItinerary
// 真实生成并经 travelPlanStore 落盘（与聊天 travel.plan-itinerary 同一
// 冷层，归档页列表自然沉淀）。生成后先只回预算明细（住宿/门票/餐饮
// 来自真实报价，大交通未接入报价如实标注），用户 approve 之后才下发
// 最终草案 + planId。
//
// 会话状态为内存态（2h TTL 惰性清扫）：规划是短生命周期交互，持久化由
// 行程冷层承担；服务重启后用户重新发一句话即可。
// ═══════════════════════════════════════════════════════════════════

// ======================== 卡片 / 回执类型 ========================

export type PlanSessionWeatherDay = {
  /** 展示日期，如 "10-15 周四" */
  dateLabel: string;
  /** 天气文案（WMO 码中文） */
  text: string;
  hi: number;
  lo: number;
};

/** 已确认的一问一答（编排器据此避免重复追问）。 */
export type PlanSessionAnswer = {
  /** 维度语义 id（编排器自拟，如 days/budget/transport/hotel/food/companions） */
  id: string;
  /** 问题原文（卡片 title） */
  question: string;
  /** 用户确认的答案 */
  answer: string;
};

/** 卡片顶部的进度摘要（已答/总数 + 已确认要点）。 */
export type PlanSessionProgress = {
  done: number;
  total: number;
  summary: string;
};

export type PlanSessionCard =
  | {
      type: "weather";
      title: string;
      sub: string;
      days: PlanSessionWeatherDay[];
      tip: string;
    }
  | {
      type: "choice";
      /** 维度语义 id（编排器生成，点选回传原样带回） */
      id: string;
      /** 阶段名（卡片头部，如「大交通」「住宿」） */
      stage: string;
      title: string;
      /** 是否多选 */
      multi: boolean;
      options: string[];
      /** 已知偏好回填提示（展示在卡片备注行，用户可改选） */
      prefill?: string[];
      /** 补充输入占位（吃的忌口 / 日期的自由输入） */
      placeholder?: string;
      /** 允许直接输入文本作答（天数日期） */
      allowNote?: boolean;
      progress?: PlanSessionProgress;
    };

/** 预算确认卡明细：金额来自真实报价，null 表示该类目尚未接入计价。 */
export type PlanSessionBudgetItem = {
  key: "transport" | "hotel" | "ticket" | "food";
  label: string;
  amount: number | null;
  note?: string;
};

export type PlanSessionBudget = {
  currency: string;
  total: number;
  original: number;
  discount: number;
  items: PlanSessionBudgetItem[];
  pricingMode: string;
  warnings: string[];
};

export type PlanSessionDraft = {
  planId: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  /** 逐日草案行（真实条目名，Day N → 站点名串联） */
  days: Array<{ label: string; stops: string }>;
  totalCost?: number;
};

export type PlanSessionTurn = {
  ok: true;
  sessionId: string;
  /**
   * gathering=还有问题待对齐 / ready=信息齐可生成 /
   * budget_ready=已算好预算待确认 / generated=用户确认后已出最终方案
   */
  state: "gathering" | "ready" | "budget_ready" | "generated";
  /** Agent 话语（可为空串） */
  say: string;
  /** 本轮新增卡片（前端追加到流末尾） */
  cards: PlanSessionCard[];
  draft: PlanSessionDraft | null;
  /** budget_ready / generated 阶段的预算明细 */
  budget: PlanSessionBudget | null;
};

// ======================== 会话状态 ========================

/** 编排器产出的下一张问题卡（内部形态，出卡前还要过服务端护栏）。 */
type NextQuestion = {
  id: string;
  stage: string;
  title: string;
  multi: boolean;
  options: string[];
  placeholder?: string;
  allowNote?: boolean;
};

type PlanSession = {
  id: string;
  createdAt: number;
  updatedAt: number;
  destination?: string;
  days?: number;
  startDate?: string;
  endDate?: string;
  /** 用户原始诉求（generate 时并入规划 input，extractPreferences 继续生效） */
  originalMessage: string;
  /** 已确认问答（id 命中的维度不再出卡） */
  answers: PlanSessionAnswer[];
  /** 当前挂起的问题卡（客户端答完即由回执换下一张） */
  pendingQuestion?: { id: string; question: string };
  /** 对话历史（含点选回传，编排器的完整上下文） */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** 编排器判定信息已齐（另有轮数封顶兜底） */
  ready: boolean;
  /** 已发出的追问卡轮数（防无限连环问） */
  questionTurns: number;
  draft: PlanSessionDraft | null;
  /** 已算好、待用户确认的预算明细 */
  budget?: PlanSessionBudget;
  budgetApproved: boolean;
  /** 天气面板只发一次（目的地明确后的那一轮） */
  weatherSent: boolean;
};

/** 追问卡总数封顶：到顶后不再出卡，目的地在手就直接出方案。 */
const MAX_QUESTION_TURNS = 8;

// ======================== 会话存储（内存 + TTL） ========================

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map<string, PlanSession>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function newSessionId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ======================== LLM 编排器 ========================

type Orchestration = {
  updates: {
    destination: string | null;
    days: number | null;
    startDate: string | null;
    endDate: string | null;
  };
  /** 用户在消息里直接交代/修改的维度（覆盖 answers 旧值） */
  answerUpdates: Array<{ id: string; question: string; answer: string }>;
  say: string;
  ready: boolean;
  progress: PlanSessionProgress;
  question: NextQuestion | null;
};

function knownStateText(session: PlanSession): string {
  const parts: string[] = [
    session.destination ? `目的地=${session.destination}` : "目的地=未知",
  ];
  if (session.days) parts.push(`天数=${session.days}天`);
  else if (session.startDate && session.endDate) {
    parts.push(`日期=${session.startDate}~${session.endDate}`);
  } else parts.push("天数/日期=未知");
  return parts.join("；");
}

/**
 * 编排器（一次 LLM 调用/轮）：提取本轮信息 + 决定回应、下一张问题卡、
 * ready 判定。问题与选项全部按上下文生成，服务端不提供任何题目模板；
 * 无 key/调用失败返回 null 走降级路径。
 */
async function orchestrateTurn(session: PlanSession): Promise<Orchestration | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm) return null;
  const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
  const model = process.env.TRAVEL_SESSION_MODEL?.trim() || llm.model || "gpt-4.1-mini";
  const now = new Date();
  const two = (v: number): string => String(v).padStart(2, "0");
  const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const qa =
    session.answers.length > 0
      ? session.answers.map((a) => `- ${a.question}：${a.answer}`).join("\n")
      : "（暂无）";

  const system =
    "你是行程规划会话的编排器，逐轮决定「回复什么、信息还缺什么、下一张问题卡问什么」。" +
    `今天是 ${today}。\n` +
    `【当前已知】${knownStateText(session)}\n` +
    `【已确认问答】\n${qa}\n\n` +
    "只输出 JSON：\n" +
    '{"updates":{"destination":"目的地|null","days":天数|null,"startDate":"YYYY-MM-DD|null","endDate":"YYYY-MM-DD|null"},' +
    '"answerUpdates":{"维度id":{"question":"维度名","answer":"用户给的答案"}},' +
    '"say":"口语回应","ready":false,' +
    '"progress":{"done":2,"total":4,"summary":"已确认要点"},' +
    '"question":{"id":"维度id","stage":"2-4字阶段名","title":"口语问题","multi":false,' +
    '"options":["选项"],"placeholder":"可选自由输入占位","allowNote":false}|null}\n' +
    "硬规则：\n" +
    "1. updates 只填本轮用户消息里新增或明确修改的信息；未提及一律 null，禁止编造。「5、6天」这类未定的模糊表达不填 days。\n" +
    "2. 用户在消息里直接交代或修改的维度写进 answerUpdates（覆盖旧值）；点选回答已自动记录，不必重复写。\n" +
    "3. 【已确认问答】和对话历史里出现过的信息一律视为已知：绝不再问、say 里不反问。「随便/都行/到地再说」也算已确认，不再问该维度。\n" +
    "4. question 只问规划行程确实需要、且目前还不知道的信息。目的地未定时 question=null，用 say 文字问去哪儿；天数/日期未定时优先问它。\n" +
    "5. 用户给过模糊表达的顺着它问：选项必须贴合用户原话与目的地（说了「5、6天」→ options [\"5天\",\"6天\"]、title「5天还是6天？」），禁止与上下文无关的通用选项。\n" +
    "6. 每轮最多一问；options 2~6 个、每个 ≤8 字；multi 仅在确实可多选时 true；天数/日期类问题可给 placeholder（如「或直接说日期，如：10月1日出发」）并 allowNote=true。\n" +
    "7. 预算类问题的选项带档位词锚点（经济/舒适/品质/豪华），可加口语后缀（如「舒适 · 性价比」），保证下游规划引擎能识别。\n" +
    "8. 问得像朋友聊天，不要查户口：目的地+天数/日期之外，再挑 2~3 个最有价值的维度问（预算/大交通/住宿/饮食/同行人/节奏/兴趣…按需取用），其余交给生成引擎。\n" +
    "9. 信息足够出方案时 ready=true 且 question=null（前提：目的地与天数/日期都已定），不要为了凑进度而问。\n" +
    "10. progress.done=已确认维度数、total=预计总数（3~6）、summary 用「 · 」串已确认要点（如「新疆 · 5天 · 舒适」）。\n" +
    "11. say ≤40 字、口语化、不复读用户原话、不列清单；ready 时 say 表达「信息齐了，我来出方案」。";

  const history = session.history.slice(-16).map((h) => ({
    role: h.role,
    content: h.content.slice(0, 300),
  }));

  const baseParams = {
    model,
    temperature: 0.3,
    max_tokens: 700,
    response_format: { type: "json_object" as const },
    messages: [{ role: "system", content: system }, ...history],
  };
  const requestContent = async (extra: Record<string, unknown>): Promise<string> => {
    const response = await openai.chat.completions.create({
      ...baseParams,
      ...extra,
    } as never);
    auditChatCompletion({
      stage: "travel_plan",
      messages: baseParams.messages,
      completion: response,
      model,
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  };

  try {
    let parsed = tryParseJson(await requestContent(bypassChatRequestExtras()));
    if (!parsed) {
      // deepseek-flash 实测缺陷：json_object + 关思考在长提示词下整段空白 content。
      // 去掉思考开关（保留 json_object）重试一次即可拿到正常 JSON。
      console.warn("[travel-plan-session] 编排器首轮输出空白/不可解析，开思考重试一次");
      parsed = tryParseJson(await requestContent({}));
    }
    if (!parsed) return null;
    return normalizeOrchestration(parsed, session);
  } catch (err) {
    console.warn(
      "[travel-plan-session] 编排失败（走降级路径）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** 从模型输出里抠 JSON：容忍 ```json 围栏和前后杂文。 */
function tryParseJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** LLM 输出做钳制与兜底，坏字段静默丢弃而不是整轮失败。 */
function normalizeOrchestration(
  raw: Record<string, unknown>,
  session: PlanSession,
): Orchestration {
  const upd = (raw.updates ?? {}) as Record<string, unknown>;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const updates = {
    destination:
      typeof upd.destination === "string" && upd.destination.trim()
        ? upd.destination.trim().slice(0, 40)
        : null,
    days:
      typeof upd.days === "number" && upd.days > 0 && upd.days <= 30
        ? Math.round(upd.days)
        : null,
    startDate:
      typeof upd.startDate === "string" && dateRe.test(upd.startDate)
        ? upd.startDate
        : null,
    endDate: typeof upd.endDate === "string" && dateRe.test(upd.endDate) ? upd.endDate : null,
  };

  const answerUpdates: Array<{ id: string; question: string; answer: string }> = [];
  const rawAnswers = (raw.answerUpdates ?? {}) as Record<string, unknown>;
  for (const [id, val] of Object.entries(rawAnswers)) {
    const answer =
      typeof val === "string"
        ? val.trim()
        : typeof val === "object" &&
            val !== null &&
            typeof (val as { answer?: unknown }).answer === "string"
          ? ((val as { answer: string }).answer).trim()
          : "";
    if (!id || !answer) continue;
    const question =
      typeof val === "object" &&
      val !== null &&
      typeof (val as { question?: unknown }).question === "string"
        ? ((val as { question: string }).question).trim().slice(0, 20)
        : id;
    answerUpdates.push({ id: id.slice(0, 24), question, answer: answer.slice(0, 60) });
  }

  let question: NextQuestion | null = null;
  const q = raw.question;
  if (q !== null && q !== undefined && typeof q === "object") {
    const o = q as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 40) : "";
    const options = Array.isArray(o.options)
      ? (o.options as unknown[])
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          .map((v) => v.trim().slice(0, 12))
          .slice(0, 6)
      : [];
    const placeholder =
      typeof o.placeholder === "string" && o.placeholder.trim()
        ? o.placeholder.trim().slice(0, 40)
        : undefined;
    const allowNote = o.allowNote === true;
    if (title && (options.length >= 2 || (allowNote && placeholder))) {
      question = {
        id: typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 24) : "more",
        stage:
          typeof o.stage === "string" && o.stage.trim()
            ? o.stage.trim().slice(0, 12)
            : "还想确认",
        title,
        multi: o.multi === true,
        options,
        ...(placeholder ? { placeholder } : {}),
        ...(allowNote ? { allowNote: true } : {}),
      };
    }
  }

  return {
    updates,
    answerUpdates,
    say: typeof raw.say === "string" ? raw.say.trim().slice(0, 120) : "",
    ready: raw.ready === true,
    progress: clampProgress(raw.progress, session),
    question,
  };
}

/** LLM 进度做钳制；拿不到就按会话状态确定性兜底。 */
function clampProgress(raw: unknown, session: PlanSession): PlanSessionProgress {
  const p = (raw ?? {}) as { done?: unknown; total?: unknown; summary?: unknown };
  const done =
    typeof p.done === "number" && Number.isFinite(p.done)
      ? Math.max(0, Math.min(8, Math.round(p.done)))
      : 0;
  let total =
    typeof p.total === "number" && Number.isFinite(p.total)
      ? Math.max(1, Math.min(8, Math.round(p.total)))
      : 5;
  if (total < done) total = Math.min(8, done);
  const summary =
    typeof p.summary === "string" && p.summary.trim()
      ? p.summary.trim().slice(0, 40)
      : stateSummary(session);
  return { done, total, summary };
}

function stateSummary(session: PlanSession): string {
  const parts: string[] = [];
  if (session.destination) parts.push(session.destination);
  const days = effectiveDays(session);
  if (days) parts.push(`${days}天`);
  for (const a of session.answers) {
    const v = a.answer.split("（")[0]!.trim();
    if (v && !/^(先不选|到地再说|随便|都行)/.test(v) && parts.length < 4) parts.push(v);
  }
  return parts.join(" · ");
}

function applyAnswerUpdates(
  session: PlanSession,
  updates: Array<{ id: string; question: string; answer: string }>,
): void {
  for (const u of updates) {
    const i = session.answers.findIndex((a) => a.id === u.id);
    if (i >= 0) {
      session.answers[i] = {
        id: u.id,
        question: u.question || session.answers[i]!.question,
        answer: u.answer,
      };
    } else {
      session.answers.push({ id: u.id, question: u.question || u.id, answer: u.answer });
    }
  }
}

// ======================== 降级路径（LLM 不可用） ========================

/** 从自由文本里解析起止日期（支持 2026-10-01 / 10月1日）。 */
function parseDateRange(note: string): {
  startDate?: string;
  endDate?: string;
  days?: number;
} {
  const now = new Date();
  const yearNow = now.getFullYear();
  const two = (v: number): string => String(v).padStart(2, "0");
  const valid = (m: number, d: number): boolean =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31;

  const isoMatches = [...note.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)].map((m) => ({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  }));
  const cnMatches = [...note.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?/g)].map((m) => ({
    year: m[1] ? Number(m[1]) : undefined,
    month: Number(m[2]),
    day: Number(m[3]),
  }));
  const matches = (isoMatches.length > 0 ? isoMatches : cnMatches).filter((d) =>
    valid(d.month, d.day),
  );
  if (matches.length === 0) return {};

  const normalize = (m: { year?: number; month: number; day: number }): string => {
    let year = m.year ?? yearNow;
    const stamp = Date.UTC(year, m.month - 1, m.day);
    if (m.year == null && stamp < Date.UTC(yearNow, now.getMonth(), now.getDate())) {
      year += 1;
    }
    return `${year}-${two(m.month)}-${two(m.day)}`;
  };
  const startDate = normalize(matches[0]!);
  if (matches.length >= 2) {
    const endDate = normalize(matches[1]!);
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    const days =
      !Number.isNaN(start) && !Number.isNaN(end) && end >= start
        ? Math.round((end - start) / 86_400_000) + 1
        : undefined;
    return { startDate, endDate, ...(days ? { days } : {}) };
  }
  return { startDate };
}

/** 只给了出发日期 + 天数时补齐返回日（天气窗口/草案展示用）。 */
function deriveEndFromStart(session: PlanSession): void {
  if (session.days && session.startDate && !session.endDate) {
    const start = Date.parse(`${session.startDate}T00:00:00Z`);
    if (!Number.isNaN(start)) {
      const end = new Date(start + (session.days - 1) * 86_400_000);
      const two = (v: number): string => String(v).padStart(2, "0");
      session.endDate = `${end.getUTCFullYear()}-${two(end.getUTCMonth() + 1)}-${two(end.getUTCDate())}`;
    }
  }
}

/**
 * 降级轮：正则抓目的地/天数/日期，只用文字问最关键的缺口，不出卡
 * （问题卡全部由编排器生成，没有编排器就没有卡）。
 */
function fallbackTurn(session: PlanSession): PlanSessionTurn {
  const lastUser =
    [...session.history].reverse().find((h) => h.role === "user")?.content ?? "";
  const destMatch =
    /去([^，。！？\s]{2,12}?)(玩|旅游|度假|出差|待|逛)/.exec(lastUser) ??
    /^([^，。！？\s]{2,8})(三日|三天|四日|四天|五天|两日|两天)游?$/.exec(lastUser.trim());
  if (destMatch) session.destination = destMatch[1]!.trim();
  const dayMatch = /(\d+)\s*天/.exec(lastUser);
  if (dayMatch) session.days = Math.min(30, Math.max(1, Number(dayMatch[1])));
  const range = parseDateRange(lastUser);
  if (range.startDate) session.startDate = range.startDate;
  if (range.endDate) session.endDate = range.endDate;
  if (!session.days && range.days) session.days = range.days;
  deriveEndFromStart(session);

  const days = effectiveDays(session);
  const ready = Boolean(session.destination) && days != null;
  session.ready = ready;
  const say = !session.destination
    ? "想去哪儿玩？直接告诉我目的地。"
    : days == null
      ? `${session.destination}好地方！打算玩几天？说天数或日期都行。`
      : "信息差不多齐了，我来出一版方案。";
  session.history.push({ role: "assistant", content: say });
  return {
    ok: true,
    sessionId: session.id,
    state: ready ? "ready" : "gathering",
    say,
    cards: [],
    draft: null,
    budget: null,
  };
}

// ======================== 天气面板（真实 Open-Meteo 逐日预报） ========================

const WMO_TEXT: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨", 61: "小雨", 63: "中雨",
  65: "大雨", 66: "冻雨", 67: "强冻雨", 71: "小雪", 73: "中雪", 75: "大雪",
  77: "雪粒", 80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "小阵雪",
  86: "阵雪", 95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type DailyForecast = {
  date: string;
  code: number;
  hi: number;
  lo: number;
  rainPct: number;
};

/** 拉目的地 16 天内逐日预报（失败返回空数组，面板整体省略） */
async function fetchDailyForecast(
  destination: string,
): Promise<{ label: string; days: DailyForecast[] } | null> {
  try {
    const geo = await geocodeCity(destination);
    if (!geo) return null;
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      timezone: "auto",
      daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
      forecast_days: "16",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: Array<number | null>;
      };
    };
    const d = data.daily;
    if (!d?.time?.length) return null;
    const days: DailyForecast[] = d.time.map((t, i) => ({
      date: t,
      code: d.weather_code?.[i] ?? 0,
      hi: Math.round(d.temperature_2m_max?.[i] ?? 0),
      lo: Math.round(d.temperature_2m_min?.[i] ?? 0),
      rainPct: d.precipitation_probability_max?.[i] ?? 0,
    }));
    return { label: geo.name || destination, days };
  } catch {
    return null;
  }
}

function dateLabelOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date.slice(5);
  const two = (v: number): string => String(v).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${WEEKDAY_LABEL[d.getDay()]}`;
}

/** 行程窗口内的预报日（起点越界时退化为未来 3 天） */
function pickForecastDays(
  days: DailyForecast[],
  startDate?: string,
  endDate?: string,
): DailyForecast[] {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  let picked: DailyForecast[] = [];
  if (startDate && startDate >= todayKey) {
    picked = days.filter((d) => d.date >= startDate && (!endDate || d.date <= endDate));
  }
  if (picked.length === 0) picked = days.slice(0, 3);
  return picked.slice(0, 5);
}

function buildWeatherTip(picked: DailyForecast[]): string {
  const rainy = picked.find((d) => d.rainPct >= 40 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(d.code));
  const minLo = Math.min(...picked.map((d) => d.lo));
  const span = Math.max(...picked.map((d) => d.hi)) - minLo;
  const parts: string[] = [];
  if (rainy) parts.push(`${rainy.date.slice(5)}有降水——那天排室内点位更稳`);
  if (minLo <= 12) parts.push("早晚偏凉，带件薄外套");
  if (span >= 12) parts.push("昼夜温差大，建议洋葱式穿脱");
  if (parts.length === 0) parts.push("整体适宜出行，行程按户外点位编排");
  return parts.join("；");
}

/** 规划流里是否穿插天气面板。当前产品口径暂不展示；保留实现，恢复时改这里。 */
const PLAN_SESSION_WEATHER_ENABLED = false;

/** 目的地明确后只补一次天气面板（真实预报；失败静默省略，下轮不重复试）。 */
async function maybeWeatherCard(session: PlanSession): Promise<PlanSessionCard | null> {
  if (!PLAN_SESSION_WEATHER_ENABLED) return null;
  if (!session.destination || session.weatherSent) return null;
  const card = await buildWeatherCard(
    session.destination,
    session.startDate,
    session.endDate,
  );
  if (card) session.weatherSent = true;
  return card;
}

async function buildWeatherCard(
  destination: string,
  startDate?: string,
  endDate?: string,
): Promise<PlanSessionCard | null> {
  const forecast = await fetchDailyForecast(destination);
  if (!forecast || forecast.days.length === 0) return null;
  const picked = pickForecastDays(forecast.days, startDate, endDate);
  return {
    type: "weather",
    title: `目的地天气 · ${forecast.label}`,
    sub: picked.length > 0 ? `${picked[0]!.date.slice(5)} ~ ${picked[picked.length - 1]!.date.slice(5)}` : "",
    days: picked.map((d) => ({
      dateLabel: dateLabelOf(d.date),
      text: WMO_TEXT[d.code] ?? "—",
      hi: d.hi,
      lo: d.lo,
    })),
    tip: buildWeatherTip(picked),
  };
}

// ======================== 轮处理 ========================

/** 天数：显式天数优先；只给了起止日期时按日期差推导。 */
function effectiveDays(session: PlanSession): number | null {
  if (session.days) return session.days;
  if (session.startDate && session.endDate) {
    const start = Date.parse(`${session.startDate}T00:00:00Z`);
    const end = Date.parse(`${session.endDate}T00:00:00Z`);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
    }
  }
  return null;
}

/**
 * 服务端硬护栏：没拿到目的地不出卡（文字问）；已答过的维度不再出卡
 * （改答案走 answerUpdates，不走重问）；天数已有定值时不再出天数卡。
 */
function filterQuestion(
  session: PlanSession,
  q: NextQuestion | null,
): NextQuestion | null {
  if (!q) return null;
  if (!session.destination) return null;
  if (session.answers.some((a) => a.id === q.id)) {
    console.warn(`[travel-plan-session] 编排器想重问已答维度「${q.id}」，已拦截`);
    return null;
  }
  if ((q.id === "days" || q.id === "dates") && effectiveDays(session) != null) {
    return null;
  }
  return q;
}

/**
 * 统一轮处理（消息轮 / 点选轮同一链路）：编排器产出回应 + 下一张问题
 * 卡 + ready 判定，护栏过滤违规问题，天气面板穿插。
 */
async function runTurn(session: PlanSession): Promise<PlanSessionTurn> {
  // 新一轮信息进入：上一版预算/草案作废，重新对齐后由客户端再触发生成。
  session.draft = null;
  session.budget = undefined;
  session.budgetApproved = false;

  const orch = await orchestrateTurn(session);
  if (!orch) return fallbackTurn(session);

  if (orch.updates.destination) session.destination = orch.updates.destination;
  if (orch.updates.days) session.days = orch.updates.days;
  if (orch.updates.startDate) session.startDate = orch.updates.startDate;
  if (orch.updates.endDate) session.endDate = orch.updates.endDate;
  deriveEndFromStart(session);
  applyAnswerUpdates(session, orch.answerUpdates);

  let ready = Boolean(session.destination) && orch.ready;
  let say = orch.say;
  // ready 却天数/日期两头空：判不住，降回 gathering 并文字补问天数。
  if (ready && effectiveDays(session) == null) {
    ready = false;
    if (!orch.question) say = "天数还没定——打算玩几天？直接说天数或日期都行。";
  }

  const cards: PlanSessionCard[] = [];
  const wx = await maybeWeatherCard(session);
  if (wx) cards.push(wx);

  const capReached = session.questionTurns >= MAX_QUESTION_TURNS;
  const question = ready || capReached ? null : filterQuestion(session, orch.question);
  if (question) {
    session.questionTurns += 1;
    session.pendingQuestion = { id: question.id, question: question.title };
    cards.push({
      type: "choice",
      id: question.id,
      stage: question.stage,
      title: question.title,
      multi: question.multi,
      options: question.options,
      ...(question.placeholder ? { placeholder: question.placeholder } : {}),
      ...(question.allowNote ? { allowNote: true } : {}),
      progress: clampProgress(orch.progress, session),
    });
  } else {
    session.pendingQuestion = undefined;
  }

  // 追问轮数封顶：不再出卡，目的地在手就直接出方案，避免查户口循环。
  if (!ready && capReached && session.destination) {
    ready = true;
    say = "该确认的都确认得差不多了，我先按现在这些信息出方案，不合适再调。";
    session.pendingQuestion = undefined;
  }

  if (!say) {
    say = ready
      ? "信息齐了，我来算一版预算。"
      : session.destination
        ? `${session.destination}安排上，还有一两个想确认的。`
        : "想去哪儿玩？";
  }

  session.ready = ready;
  session.history.push({
    role: "assistant",
    content: (
      say + (session.pendingQuestion ? `（问题卡·${session.pendingQuestion.question}）` : "")
    ).slice(0, 200),
  });

  return {
    ok: true,
    sessionId: session.id,
    state: ready ? "ready" : "gathering",
    say,
    cards,
    draft: null,
    budget: null,
  };
}

/** 点选/自由输入回传 → 问答记录 + 历史（编排器下一轮据此继续）。 */
function recordChoiceAnswer(
  session: PlanSession,
  cardId: string,
  values: string[],
  note?: string,
): void {
  const pending = session.pendingQuestion;
  const text = (note ?? "").trim();
  const answer =
    values.length > 0
      ? values.join("、") + (text ? `（补充：${text}）` : "")
      : text || "先不选，到地再说";
  // 客户端答的可能是流里的旧卡：只有对上挂起卡才用它的问法并清挂起。
  const label = pending && pending.id === cardId ? pending.question : cardId;
  const entry: PlanSessionAnswer = {
    id: cardId,
    question: label,
    answer: answer.slice(0, 80),
  };
  const i = session.answers.findIndex((a) => a.id === cardId);
  if (i >= 0) session.answers[i] = entry;
  else session.answers.push(entry);
  session.history.push({
    role: "user",
    content: `（点选）${entry.question}：${entry.answer}`.slice(0, 200),
  });
  if (pending && pending.id === cardId) session.pendingQuestion = undefined;
}

// ======================== 草案与真实生成 ========================

/** 预算档位 → 规划引擎能识别的偏好原文（extractPreferences 关键词映射）。 */
const BUDGET_TIER_HINT: Record<string, string> = {
  经济: "预算经济；住宿经济",
  舒适: "预算适中",
  品质: "预算高端",
  豪华: "预算豪华；住宿豪华酒店",
};

/**
 * 口语预算答案 → 引擎档位关键词（与 extractPreferences 同词表）。
 * 编排器生成的选项是自然语言（「不差钱随便玩」），这里兜住同义表达，
 * 避免落回引擎默认档。
 */
function budgetTierHintOf(answer: string): string | null {
  const v = answer.split("（")[0]!.trim();
  if (BUDGET_TIER_HINT[v]) return BUDGET_TIER_HINT[v]!;
  if (/经济|便宜|省钱|穷游/.test(v)) return BUDGET_TIER_HINT["经济"]!;
  if (/不差钱|豪华|高端|奢|五星|品质/.test(v)) return "预算高端";
  if (/舒适|中端|四星|中等/.test(v)) return BUDGET_TIER_HINT["舒适"]!;
  return null;
}

function composePlanningInput(session: PlanSession): string {
  const parts: string[] = [session.originalMessage];
  // 会话里用户说过的每句话都保留（extractPreferences 直接吃自然语言）。
  for (const h of session.history) {
    if (h.role !== "user" || h.content.startsWith("（点选）")) continue;
    if (h.content !== session.originalMessage && !parts.includes(h.content)) {
      parts.push(h.content);
    }
  }
  for (const a of session.answers) {
    const v = a.answer.trim();
    if (!v || /^(先不选|到地再说|随便|都行)/.test(v)) continue;
    if (a.id === "budget") {
      const hint = budgetTierHintOf(v);
      if (hint) parts.push(hint);
    }
    parts.push(`${a.question}：${v}`);
  }
  const days = effectiveDays(session);
  if (days) parts.push(`行程${days}天`);
  if (session.startDate) parts.push(`${session.startDate}出发`);
  if (session.endDate) parts.push(`${session.endDate}返回`);
  return parts.join("；");
}

function preferencesOf(session: PlanSession): string[] {
  const prefs = new Set<string>();
  for (const a of session.answers) {
    const v = a.answer.trim();
    if (v && !/^(先不选|到地再说|随便|都行)/.test(v)) prefs.add(v);
  }
  return [...prefs];
}

/**
 * 预算明细：与 _summarizePricing 同口径（住宿首条 × 晚数、门票/餐饮逐条累加）。
 * 大交通（往返票）当前没有真实报价源，amount 置 null，由卡面如实标注。
 */
function buildBudget(result: PlanningResult): PlanSessionBudget {
  const nights = Math.max(1, result.days.length - 1);
  let hotel = 0;
  let tickets = 0;
  let food = 0;
  let hotelSeen = false;
  for (const day of result.days) {
    for (const item of day.items) {
      const quote = item.priceQuote;
      if (!quote) continue;
      if (item.type === "hotel") {
        if (!hotelSeen) {
          hotel += quote.finalPrice * nights;
          hotelSeen = true;
        }
      } else if (item.type === "attraction") {
        tickets += quote.finalPrice;
      } else if (item.type === "restaurant") {
        food += quote.finalPrice;
      }
    }
  }
  const pricing = result.pricingSummary;
  const total = pricing?.totalFinal ?? hotel + tickets + food;
  return {
    currency: pricing?.currency ?? "CNY",
    total,
    original: pricing?.totalOriginal ?? total,
    discount: pricing?.totalDiscount ?? 0,
    items: [
      {
        key: "transport",
        label: "交通",
        amount: null,
        note: "往返大交通未接入实时票价，按实际购票计算",
      },
      { key: "hotel", label: "住宿", amount: hotel, note: `${nights} 晚` },
      { key: "ticket", label: "门票", amount: tickets },
      { key: "food", label: "餐饮", amount: food },
    ],
    pricingMode: pricing?.pricingMode ?? "estimated",
    warnings: pricing?.warnings ?? [],
  };
}

/** 真实生成：复用 PlanningService 主链路 + travelPlanStore 落盘 */
async function generateDraft(
  session: PlanSession,
  service: PlanningService,
): Promise<{ draft: PlanSessionDraft; budget: PlanSessionBudget }> {
  const result = await service.generateItinerary({
    input: composePlanningInput(session),
    destination: session.destination,
    days: effectiveDays(session) ?? undefined,
    preferences: preferencesOf(session),
  });
  const planId = String(result.id ?? "");
  if (planId) {
    travelPlanStore.save({
      planId,
      dataQuality: typeof result.dataQuality === "string" ? result.dataQuality : "real",
      destination: result.destination,
      title: result.title,
      startDate: result.startDate ?? "",
      endDate: result.endDate ?? "",
      center: result.center,
      requestInput: session.originalMessage,
      preferences: preferencesOf(session),
      intro: result.travelInfo?.intro,
      packing: result.travelInfo?.packing,
      weather: result.weather,
      coverImage: result.coverImage,
      pois: result.pois.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        latitude: p.latitude,
        longitude: p.longitude,
        address: p.address,
        rating: p.rating,
      })),
      totalCost: result.pricingSummary?.totalFinal,
      days: result.days.map((day) => ({
        date: day.date ?? "",
        items: day.items.map((item) => ({
          type: item.type,
          name: item.name,
          startTime: item.startTime ?? item.name,
          latitude: item.latitude,
          longitude: item.longitude,
          address: item.address ?? "",
          priceInfo: item.priceInfo ?? "",
          description: item.description ?? "",
          tips: item.tips,
          images: item.images,
          splatUrl: item.splatUrl,
          transportFromPrev: item.transportFromPrev,
          visitDuration: item.visitDuration,
        })),
      })),
    });
  }
  const draft: PlanSessionDraft = {
    planId,
    title: result.title || `${result.destination}行程`,
    destination: result.destination,
    startDate: result.startDate ?? "",
    endDate: result.endDate ?? "",
    days: result.days.map((day, i) => ({
      label: `Day ${i + 1}`,
      stops:
        day.items
          .slice(0, 6)
          .map((it) => it.name)
          .join(" → ") || "当日暂无安排",
    })),
    ...(result.pricingSummary?.totalFinal != null
      ? { totalCost: result.pricingSummary.totalFinal }
      : {}),
  };
  const budget = buildBudget(result);
  session.draft = draft;
  session.budget = budget;
  session.budgetApproved = false;
  return { draft, budget };
}

// ======================== 路由注册 ========================

const startSchema = z.object({
  message: z.string().min(1).max(600),
});

const messageTurnSchema = z.object({
  message: z.string().min(1).max(600),
});

const choiceTurnSchema = z.object({
  cardId: z.string().min(1).max(40),
  values: z.array(z.string().min(1).max(30)).max(8),
  note: z.string().max(80).optional(),
});

/** 统一 503：规划服务未装配 */
function requireService(
  deps: { travelPlanningService?: PlanningService },
  reply: FastifyReply,
): boolean {
  if (!deps.travelPlanningService) {
    void reply.code(503).send({ ok: false, error: "规划服务未装配，规划会话不可用" });
    return false;
  }
  return true;
}

/**
 * 规划会话路由域（v3 旅游界面规划流专用）：
 *   POST /travel/plan-session           {message} 一句话发起
 *   POST /travel/plan-session/:id/turn  {message} 继续说 / {cardId,values,note} 点选回传
 *   POST /travel/plan-session/:id/generate   真实生成（10~120s，客户端显示 typing）
 *   GET   /travel/plan-session/:id      会话状态（刷新恢复）
 */
export function registerTravelPlanSessionRoutes(
  app: FastifyInstance,
  deps: { travelPlanningService?: PlanningService },
): void {
  app.get("/travel/plan-session/_meta", async () => ({
    domain: "travel-plan-session",
    endpoints: [
      "POST   /travel/plan-session            {message} 一句话发起规划会话",
      "POST   /travel/plan-session/:id/turn   {message} 或 {cardId,values,note?} 追加一轮（每轮至多一张问题卡，题目与选项由 LLM 编排器生成）",
      "POST   /travel/plan-session/:id/generate   信息齐后真实生成并返回预算明细（待确认）",
      "POST   /travel/plan-session/:id/approve    用户确认预算后下发最终草案",
      "GET    /travel/plan-session/:id        会话状态（客户端刷新恢复）",
    ],
    note: "会话为内存态（2h TTL）；持久化由 travelPlanStore 冷层承担",
  }));

  // 一句话发起
  app.post("/travel/plan-session", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const body = startSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: body.error.flatten() });
    }
    pruneSessions();
    const message = body.data.message.trim();
    const session: PlanSession = {
      id: newSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      originalMessage: message,
      answers: [],
      history: [{ role: "user", content: message }],
      ready: false,
      questionTurns: 0,
      draft: null,
      budgetApproved: false,
      weatherSent: false,
    };
    sessions.set(session.id, session);
    const turn = await runTurn(session);
    session.updatedAt = Date.now();
    return turn;
  });

  // 继续对话 / 点选回传
  app.post<{ Params: { id: string } }>("/travel/plan-session/:id/turn", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const session = sessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();

    const asChoice = choiceTurnSchema.safeParse(request.body);
    if (asChoice.success) {
      const { cardId, values, note } = asChoice.data;
      recordChoiceAnswer(session, cardId, values, note);
      const turn = await runTurn(session);
      session.updatedAt = Date.now();
      return turn;
    }

    const asMessage = messageTurnSchema.safeParse(request.body);
    if (asMessage.success) {
      session.history.push({
        role: "user",
        content: asMessage.data.message.trim().slice(0, 600),
      });
      const turn = await runTurn(session);
      session.updatedAt = Date.now();
      return turn;
    }
    return reply.code(400).send({ ok: false, error: "body 需为 {message} 或 {cardId,values,note?}" });
  });

  // 真实生成（与聊天 travel.plan-itinerary 同一引擎与冷层）
  app.post<{ Params: { id: string } }>("/travel/plan-session/:id/generate", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const session = sessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();
    if (!session.destination) {
      return reply.code(400).send({ ok: false, error: "还没确定目的地，先告诉我想去哪儿" });
    }
    try {
      const { budget } = await generateDraft(session, deps.travelPlanningService!);
      const total = budget.total > 0 ? `¥${budget.total.toLocaleString("zh-CN")}` : "待核价";
      return {
        ok: true,
        sessionId: session.id,
        state: "budget_ready",
        say: `预算算好了：住宿/门票/餐饮合计约 ${total}（大交通未接入报价）。确认后我再出最终方案。`,
        cards: [] as PlanSessionCard[],
        draft: null,
        budget,
      } satisfies PlanSessionTurn;
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: err instanceof Error ? err.message : "生成失败，请稍后重试",
        hint: "生成失败不产出估算行程（真实数据保证），可稍后重试或调整需求",
      });
    }
  });

  // 预算确认：用户看过明细并同意后才下发最终草案
  app.post<{ Params: { id: string } }>("/travel/plan-session/:id/approve", async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();
    if (!session.draft || !session.budget) {
      return reply.code(400).send({ ok: false, error: "预算还没算好，先完成信息对齐" });
    }
    session.budgetApproved = true;
    return {
      ok: true,
      sessionId: session.id,
      state: "generated",
      say: "方案出好了，点开卡片可以看逐日安排；想改随时告诉我。",
      cards: [] as PlanSessionCard[],
      draft: session.draft,
      // 预算卡已在流程里展示过，这里只下发草案，避免客户端重复挂预算卡
      budget: null,
    } satisfies PlanSessionTurn;
  });

  // 会话状态（客户端刷新恢复）
  app.get<{ Params: { id: string } }>("/travel/plan-session/:id", async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期" });
    }
    return {
      ok: true,
      sessionId: session.id,
      state: session.budgetApproved
        ? "generated"
        : session.budget
          ? "budget_ready"
          : session.ready
            ? "ready"
            : "gathering",
      destination: session.destination ?? null,
      days: effectiveDays(session),
      answers: session.answers,
      draft: session.draft,
      budget: session.budget ?? null,
    };
  });
}
