import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../../external-model/resolve-provider.js";
import { geocodeCity } from "../../services/weather-service.js";
import { travelPlanStore } from "./travel-plan-store.js";
import type { PlanningService } from "./travel-planning-service.js";
import { auditChatCompletion } from "../../services/llm-token-audit.js";

// ═══════════════════════════════════════════════════════════════════
// 行程规划会话（v3 旅游界面 · Agent 驱动规划流）
//
// 用户一句话发起 → LLM 解析目的地/天数/日期/已表达偏好 → 按需返回卡片：
//   - weather  天气面板（Open-Meteo 真实逐日预报，只在规划流中出现）
//   - choice   出行方式/住房/吃的选择卡（已知偏好不重复问）
// 全部对齐后客户端调 generate → 复用 PlanningService.generateItinerary
// 真实生成并经 travelPlanStore 落盘（与聊天 travel.plan-itinerary 同一冷层，
// 归档页列表自然沉淀），返回真实逐日草案 + planId；客户端「生成完整行程」
// 直达完整行程界面（/travel/plans/:planId）。
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
      id: "transport" | "hotel" | "food";
      title: string;
      /** 是否多选 */
      multi: boolean;
      options: string[];
      /** 已知偏好回填提示（展示在卡片备注行，用户可改选） */
      prefill?: string[];
      /** 单行补充输入占位（吃的卡的忌口/过敏） */
      placeholder?: string;
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
  /** gathering=还有卡片待对齐 / ready=信息齐可生成 / generated=已出草案 */
  state: "gathering" | "ready" | "generated";
  /** Agent 话语（可为空串） */
  say: string;
  /** 本轮新增卡片（前端追加到流末尾） */
  cards: PlanSessionCard[];
  draft: PlanSessionDraft | null;
};

// ======================== 槽位目录（与设计稿 v3 一致） ========================

const SLOT_OPTIONS: Record<"transport" | "hotel" | "food", string[]> = {
  transport: ["租车自驾", "预定打车", "公共交通", "到地再说"],
  hotel: ["舒适型酒店", "特色民宿", "度假酒店", "经济连锁"],
  food: ["本地特色", "能吃辣", "清淡", "海鲜", "小吃街探索"],
};

const SLOT_TITLE: Record<"transport" | "hotel" | "food", string> = {
  transport: "出行方式怎么解决？",
  hotel: "住房偏向哪种？",
  food: "吃的上有什么讲究？",
};

type SlotId = keyof typeof SLOT_OPTIONS;

/** 会话内槽位取值（多选一律存数组） */
type SessionSlots = Partial<Record<SlotId, string[]>> & { foodNote?: string };

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
  /** 用户消息里已表达/明确说不用问的槽位（不再出卡） */
  settled: Set<SlotId>;
  slots: SessionSlots;
  /** 已出过卡的槽位（避免重复出卡） */
  asked: Set<SlotId>;
  draft: PlanSessionDraft | null;
};

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

// ======================== 偏好记忆回填（已知偏好不重复问） ========================

/**
 * 同目的地历史行程偏好标签（与 travel-planning-skills 的 B3 机制同源逻辑）：
 * 近期行程（≤8 份）里目的地匹配的 preferences 去重返回。规划会话用它把
 * 已知槽位直接回填（不出卡），Agent 提问不重复用户已说过的事。
 */
function recallDestinationPreferenceLabels(dest: string): string[] {
  try {
    const text = dest.toLowerCase().trim();
    if (!text) return [];
    const matched: string[] = [];
    for (const s of travelPlanStore.listSummaries(8)) {
      const d = (s.destination || "").toLowerCase().trim();
      if (!d || (!text.includes(d) && !d.includes(text))) continue;
      const plan = travelPlanStore.get(s.planId);
      for (const p of plan?.preferences ?? []) {
        const label = p.trim();
        if (label && !matched.includes(label)) matched.push(label);
      }
      if (matched.length >= 8) break;
    }
    return matched.slice(0, 8);
  } catch {
    return [];
  }
}

/** 偏好标签 → 槽位回填（标签精确命中目录项才算） */
function prefillSlotsFromLabels(labels: string[], slots: SessionSlots, settled: Set<SlotId>): void {
  for (const label of labels) {
    for (const id of Object.keys(SLOT_OPTIONS) as SlotId[]) {
      if (slots[id]?.length) continue;
      if (SLOT_OPTIONS[id].some((o) => o === label || label.includes(o) || o.includes(label))) {
        slots[id] = [label];
        settled.add(id);
      }
    }
  }
}

// ======================== LLM 意图解析 ========================

type ParsedIntent = {
  destination: string | null;
  days: number | null;
  startDate: string | null;
  endDate: string | null;
  slots: Partial<Record<SlotId, string[]>>;
  foodNote: string | null;
  skipAsking: SlotId[];
  say: string;
};

function slotCatalogForPrompt(): string {
  return Object.entries(SLOT_OPTIONS)
    .map(([id, opts]) => `${id}(${opts.join("/")})`)
    .join("；");
}

/** LLM 意图解析（一次调用；无 key/失败返回 null 走确定性兜底） */
async function parseIntentByLlm(
  message: string,
  session: PlanSession,
): Promise<ParsedIntent | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm) return null;
  const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
  const model = process.env.TRAVEL_SESSION_MODEL?.trim() || llm.model || "gpt-4.1-mini";
  const now = new Date();
  const two = (v: number): string => String(v).padStart(2, "0");
  const known = [
    session.destination ? `目的地=${session.destination}` : null,
    session.days ? `天数=${session.days}` : null,
    session.startDate ? `开始=${session.startDate}` : null,
    session.endDate ? `结束=${session.endDate}` : null,
    Object.entries(session.slots)
      .filter(([k]) => k !== "foodNote")
      .map(([k, v]) => `${k}=${(v as string[]).join("/")}`)
      .join(","),
  ]
    .filter(Boolean)
    .join("；");

  try {
    const intentSystem =
      "你是行程规划助手的意图解析器。今天是 " +
      `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}。` +
      "从用户消息提取旅游意图，只输出 JSON：" +
      '{"destination":"目的地|null","days":天数|null,"startDate":"YYYY-MM-DD|null",' +
      '"endDate":"YYYY-MM-DD|null","slots":{"transport":[..]|null,"hotel":[..]|null,"food":[..]|null},' +
      '"foodNote":"忌口/过敏等补充|null","skipAsking":[],"say":"一句自然的中文回应"}。' +
      `槽位目录：${slotCatalogForPrompt()}。` +
      "规则：未提及的字段一律 null/空，禁止编造；slots 只在用户明确表达该偏好时填目录中的选项；" +
      "用户已确认不用问的事项放进 skipAsking（如「住的随便」→ skipAsking:[\"hotel\"]）；" +
      "say ≤40 字、口语化、不复读用户原话、不列清单；已知信息不要在 say 里反问。" +
      (known ? `会话已知：${known}。` : "");
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: intentSystem },
        { role: "user", content: message.slice(0, 600) },
      ],
      ...bypassChatRequestExtras(),
    });
    auditChatCompletion({
      stage: "travel_plan",
      messages: [
        { role: "system", content: intentSystem },
        { role: "user", content: message.slice(0, 600) },
      ],
      completion: response,
      model,
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const pickSlot = (raw: unknown): string[] | null => {
      if (!Array.isArray(raw)) return null;
      const vals = raw
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0 && v.length <= 20);
      return vals.length > 0 ? vals.slice(0, 6) : null;
    };
    const slotKeys = ["transport", "hotel", "food"] as const;
    const slots: Partial<Record<SlotId, string[]>> = {};
    const rawSlots = (parsed.slots ?? {}) as Record<string, unknown>;
    for (const k of slotKeys) {
      const v = pickSlot(rawSlots[k]);
      if (v) slots[k] = v;
    }
    const skip = Array.isArray(parsed.skipAsking)
      ? (parsed.skipAsking as unknown[]).filter(
          (v): v is SlotId => typeof v === "string" && v in SLOT_OPTIONS,
        )
      : [];
    const days =
      typeof parsed.days === "number" && parsed.days > 0 && parsed.days <= 30
        ? Math.round(parsed.days)
        : null;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const say = typeof parsed.say === "string" ? parsed.say.trim().slice(0, 80) : "";
    return {
      destination:
        typeof parsed.destination === "string" && parsed.destination.trim()
          ? parsed.destination.trim().slice(0, 40)
          : null,
      days,
      startDate:
        typeof parsed.startDate === "string" && dateRe.test(parsed.startDate)
          ? parsed.startDate
          : null,
      endDate:
        typeof parsed.endDate === "string" && dateRe.test(parsed.endDate)
          ? parsed.endDate
          : null,
      slots,
      foodNote:
        typeof parsed.foodNote === "string" && parsed.foodNote.trim()
          ? parsed.foodNote.trim().slice(0, 60)
          : null,
      skipAsking: skip,
      say,
    };
  } catch (err) {
    console.warn(
      "[travel-plan-session] 意图解析失败（走确定性兜底）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** 确定性兜底解析（LLM 不可用时）：去X/目的地后缀 + N 天 */
function parseIntentFallback(message: string, session: PlanSession): ParsedIntent {
  const destMatch =
    /去([^，。！？\s]{2,12}?)(玩|旅游|度假|出差|待|逛)/.exec(message) ??
    /^([^，。！？\s]{2,8})(三日|三天|四日|四天|五天|两日|两天)游?$/.exec(message.trim());
  const dayMatch = /(\d+)\s*天/.exec(message);
  return {
    destination: destMatch ? destMatch[1]!.trim() : session.destination ?? null,
    days: dayMatch ? Math.min(30, Number(dayMatch[1])) : session.days ?? null,
    startDate: null,
    endDate: null,
    slots: {},
    foodNote: null,
    skipAsking: [],
    say: "收到，我们先把目的地和天数对齐。",
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

// ======================== 卡片编排 ========================

/** 当前还缺的槽位（未填且未 settled） */
function missingSlots(session: PlanSession): SlotId[] {
  return (Object.keys(SLOT_OPTIONS) as SlotId[]).filter(
    (id) => !session.slots[id]?.length && !session.settled.has(id),
  );
}

function isReady(session: PlanSession): boolean {
  return Boolean(session.destination) && missingSlots(session).length === 0;
}

/** 缺槽位 → 选择卡（已出过的不重复出） */
function buildChoiceCards(session: PlanSession): PlanSessionCard[] {
  const cards: PlanSessionCard[] = [];
  for (const id of missingSlots(session)) {
    if (session.asked.has(id)) continue;
    session.asked.add(id);
    cards.push({
      type: "choice",
      id,
      title: SLOT_TITLE[id],
      multi: id === "food",
      options: SLOT_OPTIONS[id],
      ...(id === "food" ? { placeholder: "忌口 / 过敏，如：不吃香菜" } : {}),
    });
  }
  return cards;
}

/** 确定性短应答（choice 轮零 LLM 调用） */
function choiceAck(session: PlanSession, remaining: SlotId[]): string {
  if (remaining.length === 0) {
    return `好，都记下了。${session.destination ?? ""}的行程这就开始编排，稍等。`;
  }
  return "记下了。还有" + remaining.map((id) => SLOT_TITLE[id].replace("怎么解决？", "").replace("偏向哪种？", "").replace("上有什么讲究？", "")).join("和") + "想跟你对齐一下。";
}

// ======================== 草案与真实生成 ========================

/** 会话状态 → 规划引擎 input（原话 + 结构化补充，extractPreferences 继续生效） */
function composePlanningInput(session: PlanSession): string {
  const parts: string[] = [session.originalMessage];
  const slots = session.slots;
  if (slots.transport?.length) parts.push(`出行方式：${slots.transport.join("/")}`);
  if (slots.hotel?.length) parts.push(`住房：${slots.hotel.join("/")}`);
  if (slots.food?.length) parts.push(`吃的：${slots.food.join("/")}`);
  if (slots.foodNote) parts.push(`忌口注意：${slots.foodNote}`);
  if (session.days) parts.push(`行程${session.days}天`);
  if (session.startDate) parts.push(`${session.startDate}出发`);
  return parts.join("；");
}

function preferencesOf(session: PlanSession): string[] {
  const prefs = new Set<string>();
  for (const id of ["transport", "hotel", "food"] as SlotId[]) {
    for (const v of session.slots[id] ?? []) {
      if (v !== "到地再说") prefs.add(v);
    }
  }
  if (session.slots.foodNote) prefs.add(session.slots.foodNote);
  return [...prefs];
}

/** 真实生成：复用 PlanningService 主链路 + travelPlanStore 落盘 */
async function generateDraft(
  session: PlanSession,
  service: PlanningService,
): Promise<PlanSessionDraft> {
  const result = await service.generateItinerary({
    input: composePlanningInput(session),
    destination: session.destination,
    days: session.days,
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
  session.draft = draft;
  return draft;
}

// ======================== 路由注册 ========================

const startSchema = z.object({
  message: z.string().min(1).max(600),
});

const messageTurnSchema = z.object({
  message: z.string().min(1).max(600),
});

const choiceTurnSchema = z.object({
  cardId: z.enum(["transport", "hotel", "food"]),
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

/** 消息轮共用处理：LLM 解析 → 回填 → 天气卡 + 缺槽卡 */
async function handleMessageTurn(
  session: PlanSession,
  message: string,
  service: PlanningService,
): Promise<PlanSessionTurn> {
  const parsed = (await parseIntentByLlm(message, session)) ?? parseIntentFallback(message, session);
  if (parsed.destination) session.destination = parsed.destination;
  if (parsed.days) session.days = parsed.days;
  if (parsed.startDate) session.startDate = parsed.startDate;
  if (parsed.endDate) session.endDate = parsed.endDate;
  if (parsed.foodNote) session.slots.foodNote = parsed.foodNote;
  for (const [id, vals] of Object.entries(parsed.slots) as Array<[SlotId, string[]]>) {
    if (vals.length > 0) {
      session.slots[id] = vals;
      session.settled.add(id);
    }
  }
  for (const id of parsed.skipAsking) session.settled.add(id);

  // 已知偏好回填（首个目的地出现时做一次，命中即免问）
  if (session.destination) {
    prefillSlotsFromLabels(
      recallDestinationPreferenceLabels(session.destination),
      session.slots,
      session.settled,
    );
  }

  const cards: PlanSessionCard[] = [];
  // 天气面板：目的地已知的轮次补发（真实预报；失败静默省略）
  if (session.destination) {
    const wx = await buildWeatherCard(session.destination, session.startDate, session.endDate);
    if (wx) cards.push(wx);
  }
  cards.push(...buildChoiceCards(session));

  const state = isReady(session) ? "ready" : "gathering";
  const say =
    parsed.say ||
    (state === "ready"
      ? `收到！${session.destination ?? ""}的行程信息齐了，我来编排。`
      : `收到！${session.destination ? `${session.destination}安排上。` : ""}`);
  return { ok: true, sessionId: session.id, state, say, cards, draft: session.draft };
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
      "POST   /travel/plan-session/:id/turn   {message} 或 {cardId,values,note?} 追加一轮",
      "POST   /travel/plan-session/:id/generate   信息齐后真实生成（复用 PlanningService + 落盘）",
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
    const session: PlanSession = {
      id: newSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      originalMessage: body.data.message.trim(),
      settled: new Set(),
      slots: {},
      asked: new Set(),
      draft: null,
    };
    sessions.set(session.id, session);
    return handleMessageTurn(session, session.originalMessage, deps.travelPlanningService!);
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
      const valid = SLOT_OPTIONS[cardId];
      const filtered = values.filter((v) => valid.includes(v));
      if (filtered.length > 0) session.slots[cardId] = filtered;
      if (cardId === "food" && note?.trim()) session.slots.foodNote = note.trim();
      session.settled.add(cardId);
      const remaining = missingSlots(session);
      const cards = buildChoiceCards(session);
      const state = isReady(session) ? "ready" : "gathering";
      return {
        ok: true,
        sessionId: session.id,
        state,
        say: choiceAck(session, remaining),
        cards,
        draft: session.draft,
      } satisfies PlanSessionTurn;
    }

    const asMessage = messageTurnSchema.safeParse(request.body);
    if (asMessage.success) {
      return handleMessageTurn(session, asMessage.data.message, deps.travelPlanningService!);
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
      return reply.code(400).send({ ok: false, error: "还没确定目的地，先告诉 Agent 想去哪儿" });
    }
    try {
      const draft = await generateDraft(session, deps.travelPlanningService!);
      return {
        ok: true,
        sessionId: session.id,
        state: "generated",
        say: "草案出来了，看看顺不顺。",
        cards: [] as PlanSessionCard[],
        draft,
      } satisfies PlanSessionTurn;
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `行程生成失败：${err instanceof Error ? err.message : String(err)}`,
        hint: "生成失败不产出估算行程（真实数据保证），可稍后重试或调整需求",
      });
    }
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
      state: session.draft ? "generated" : isReady(session) ? "ready" : "gathering",
      destination: session.destination ?? null,
      days: session.days ?? null,
      slots: { ...session.slots },
      draft: session.draft,
    };
  });
}
