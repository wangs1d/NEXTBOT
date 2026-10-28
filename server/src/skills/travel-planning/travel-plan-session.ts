import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../../external-model/resolve-provider.js";
import { geocodeCity } from "../../services/weather-service.js";
import { travelPlanStore } from "./travel-plan-store.js";
import type {
  GuideCandidate,
  PlanningResult,
  PlanningService,
  TransferSegment,
} from "./travel-planning-service.js";
import {
  lookupTransportOptions,
  lookupHotelOptions,
  type TransportOptionDetail,
  type HotelOptionDetail,
} from "./travel-live-pricing.js";
import { auditChatCompletion } from "../../services/llm-token-audit.js";
import {
  extractWishlist,
  extractFoodWishlist,
  extractParty,
  paceForParty,
  extractPreferences,
  extractHotelFocus,
} from "./intent-parser.js";
import { findReservationRule } from "./travel-poi-dossier.js";
import { resolveOriginFromLocation } from "./travel-origin.js";
import { getDataDir } from "../../config/data-dir.js";
import type { LocationCoordinator } from "../../services/location-coordinator.js";
import fs from "node:fs";
import path from "node:path";

// 出发地主动定位用（2026-10-27）：runTurn/fallbackTurn 深处拿不到 deps，
// 路由注册期把 coordinator 绑到模块级。
let planSessionLocationCoordinator: LocationCoordinator | null = null;
function bindPlanSessionLocationCoordinator(coordinator: LocationCoordinator | null): void {
  planSessionLocationCoordinator = coordinator;
}

// ═══════════════════════════════════════════════════════════════════
// 行程规划会话（v3 旅游界面 · Agent 驱动规划流）
//
// 用户一句话发起 → LLM 编排器逐轮决定「说什么 / 信息还缺什么 / 下一张
// 问题卡问什么」。问题卡没有任何硬编码清单：问哪个维度、问题文案、
// 选项（贴合用户已说过的内容，如「5、6天」→ 5天/6天）全部由编排器按
// 上下文真实生成；已给出（含模糊表达、「随便」类回答）的信息一律不再
// 追问。服务端只做硬护栏：没拿到目的地不出卡、已答过的维度不再出卡、
// 追问轮数封顶，防连环查户口。全部对齐后先出「必玩/住宿/美食」图文筛选
// 卡（文字介绍 + 实拍图 + 实时价）；勾选后再给一张自选补充卡（用户自己写
// 非去不可的景点/酒店/餐厅，可跳过），两处心愿合并后客户端调 generate → 复用
// PlanningService.generateItinerary 真实生成并经 travelPlanStore 落盘（与聊天
// travel.plan-itinerary 同一冷层，归档页列表自然沉淀）。生成后先只回预算
// 明细（门票/房价/餐饮人均/往返大交通均来自实时报价，取不到的标「待核价」
// 且不计入合计），用户 approve 之后才下发最终草案 + planId。
//
// 会话持久化（2026-10-26）：内存 Map + 磁盘双层（data/travel-plan-sessions/{id}.json，
// 单文件单会话，惰性读盘）。内存 2h TTL 清出后磁盘仍在，客户端可凭 sessionId
// 恢复对话；GET /travel/plan-sessions 列历史会话，磁盘 30 天过期随清扫删除。
// 生成的行程本体仍由 travelPlanStore 冷层承担，这里只保对话流本身。
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

/** 档案栏「已定条」的一项：已确认的事实，或未定的关键维度（客户端灰显）。 */
export type PlanSessionDossierFact = {
  /** 维度 id（destination/days/origin/party/budget/transport/picks/stay/food） */
  id: string;
  /** 维度名（去哪儿 / 玩几天 / 和谁去…） */
  label: string;
  /** 结论展示文案；state=todo 时为空串 */
  value: string;
  /** set=已定 / todo=还缺 */
  state: "set" | "todo";
};

/** 档案栏五步进度轨的一项。 */
export type PlanSessionDossierStep = {
  id: "gather" | "guide" | "extras" | "budget" | "plan";
  label: string;
  state: "done" | "active" | "todo";
};

/**
 * 右侧行程档案栏快照：全部由会话状态确定性推出，不让编排器复述一遍，
 * 避免「卡片说一套、档案说一套」。钱与风险不下发——客户端手里已有
 * 预算卡与草案核实结果，从流里读比再算一份更不容易口径打架。
 */
export type PlanSessionDossier = {
  /** 行程头，如「成都 · 3 天 · 北京出发」 */
  head: string;
  steps: PlanSessionDossierStep[];
  facts: PlanSessionDossierFact[];
};

/** 卡面指标胶囊：服务端算好的成品文案 + 这条数的来源，客户端原样渲染不换算。 */
export type PlanSessionGuideMetric = {
  kind: "rating" | "price" | "distance" | "heat" | "favorite";
  label: string;
  source: string;
};

/** 筛选卡条目：名称挂真数指标 + 文字介绍 + 实拍图。没取到的指标不下发。 */
export type PlanSessionGuideItem = {
  name: string;
  intro: string;
  photos: string[];
  address?: string;
  metrics: PlanSessionGuideMetric[];
  /** 服务端恒 false：勾选全部交给用户，不替用户预选 */
  picked: boolean;
};

export type PlanSessionGuideCat = {
  key: "view" | "stay" | "food";
  label: string;
  items: PlanSessionGuideItem[];
  /** 这一段的排序依据，由实际参与排序的信号拼出来 */
  sortNote: string;
  /** 住宿段的落位参照点（离哪儿近），其余段不下发 */
  anchor?: { id: string; label: string; why: string };
};

/** 同行人 → 节奏的推断结论（卡片内展示，可改，不单独出问题卡）。 */
export type PlanSessionPaceInfer = {
  /** 推断的节奏档：松弛 / 均衡 / 紧凑 */
  pace: string;
  /** 具体到「每天几站、几点出门」的说明 */
  detail: string;
  /** 用户可改的三个档位 */
  options: string[];
};

// ────────────────────── 预订选择卡（酒店/机票/高铁，2026-10-27） ──────────────────────

/** 预订卡的大交通选项（飞猪实时班次；票价取不到时 amount=null，卡面标「待核价」）。 */
export type PlanSessionBookingTransport = {
  key: string;
  mode: "flight" | "train";
  no?: string;
  carrier?: string;
  outbound?: TransportOptionDetail["outbound"];
  inbound?: TransportOptionDetail["inbound"];
  amount: number | null;
  durationMin?: number;
  bookingUrl?: string;
  viaHub?: string;
  /** 服务端推荐位（有实价且耗时合理的最低价），只作标记不替用户选 */
  recommended?: boolean;
};

/** 预订卡的酒店选项（飞猪在售酒店，每晚价）。 */
export type PlanSessionBookingHotel = {
  key: string;
  name: string;
  amount: number | null;
  rating?: number;
  star?: string;
  near?: string;
  image?: string;
  bookingUrl?: string;
  fromPicks?: boolean;
  recommended?: boolean;
};

/** 预订选择卡数据：会话内留存，供 /booking 回传校验与 generate 落实选择。 */
export type PlanSessionBookingData = {
  origin: string;
  destination: string;
  checkIn?: string;
  checkOut?: string;
  nights: number;
  transports: PlanSessionBookingTransport[];
  hotels: PlanSessionBookingHotel[];
  /** 用户已确认的选择（key 回传；不订=缺省） */
  selection?: { transportKey?: string; hotelKey?: string };
  /** 飞猪体验模式：部分价格被平台脱敏，卡面如实说明 */
  trial?: boolean;
  preparedAt: number;
};

export type PlanSessionCard =
  | {
      type: "guide";
      stage: string;
      title: string;
      destination: string;
      cats: PlanSessionGuideCat[];
    }
  | {
      type: "weather";
      title: string;
      sub: string;
      days: PlanSessionWeatherDay[];
      tip: string;
    }
  | {
      /** 大交通与住宿预订选择卡：飞猪实时班次/房价，选中项进预算与行程。 */
      type: "booking";
      stage: string;
      title: string;
      sub: string;
      origin: string;
      destination: string;
      checkIn?: string;
      checkOut?: string;
      nights: number;
      transports: PlanSessionBookingTransport[];
      hotels: PlanSessionBookingHotel[];
      /** 已确认的回显选择（恢复会话时原样带回） */
      selection?: { transportKey?: string; hotelKey?: string };
      trial?: boolean;
    }
  | {
      /** 筛选卡之后的自选补充：直写非去不可的地方/酒店/餐厅（可全部留空）。 */
      type: "wishlist";
      stage: string;
      title: string;
      sub: string;
      /** 筛选卡已勾选（展示用，用户可对照着补） */
      selected: { view: string[]; stay: string[]; food: string[] };
      placeholders: { view: string; stay: string; food: string };
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
      /** 选项 → 推断结论（目前只有同行人卡：选了就顺带定节奏） */
      infer?: Record<string, PlanSessionPaceInfer>;
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
  /** 未取到实时价、标「待核价」且不计入合计的条目数 */
  pendingItems?: number;
};

/** 相邻两站之间的真实交通腿（OSRM 路网优先，失败降级估算）。 */
export type PlanSessionDraftLeg = {
  mode: string;
  durationMin: number;
  distanceKm?: number;
  note?: string;
};

/** 方案里的单站：时间、停留时长、交通、开放/预约、以及该站的核实问题。 */
export type PlanSessionDraftStop = {
  time: string;
  endTime?: string;
  name: string;
  type: "hotel" | "attraction" | "restaurant";
  leg?: PlanSessionDraftLeg;
  /** 建议游览/用餐时长（分钟） */
  visitDuration?: number;
  /** 官方/POI 公示开放时间（占位文案不下发） */
  openingHours?: string;
  /** 需要提前预约/预订的提示（知识库或 POI 标注，含渠道口径） */
  booking?: string;
  /** 实时价展示文案（如 ¥68 / ¥644/晚 / 待核价） */
  price?: string;
  /** 该站的核实问题（闭馆日/停止入场/预约/开放时间未取到） */
  issues?: string[];
};

export type PlanSessionDraftDay = {
  label: string;
  /** 站点名串联（旧字段，列表摘要用） */
  stops: string;
  date?: string;
  theme?: string;
  weather?: string;
  /** 当天在路上合计分钟数（含酒店出发与返回） */
  travelMin?: number;
  items: PlanSessionDraftStop[];
};

/** 逐站核实结果（闭馆日/开放时段/停止入场/预约/密度）。 */
export type PlanSessionVerification = {
  summary: string | null;
  checkedAt: string;
  issues: Array<{
    level: "block" | "warn" | "info";
    kind: string;
    day: number;
    stop: number;
    name: string;
    message: string;
    suggestion?: string;
  }>;
};

export type PlanSessionDraft = {
  planId: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  /** 逐日方案：每站带时间/交通/开放预约，可直接照着走 */
  days: PlanSessionDraftDay[];
  totalCost?: number;
  /** 核实闸结果：哪站闭馆、哪些要提前预约、哪段排太满 */
  verification?: PlanSessionVerification;
  /** 点名但没排进日程的地点（如实交代，不静默丢弃） */
  wishlistMissed?: string[];
};

export type PlanSessionTurn = {
  ok: true;
  sessionId: string;
  /**
   * gathering=还有问题待对齐 / guide_ready=待勾选筛选卡 /
   * wishlist_ready=待补充自选地点 / booking_ready=待选大交通与住宿 /
   * ready=信息齐可生成 / budget_ready=已算好预算待确认 /
   * generated=用户确认后已出最终方案
   */
  state:
    | "gathering"
    | "guide_ready"
    | "wishlist_ready"
    | "booking_ready"
    | "ready"
    | "budget_ready"
    | "generated";
  /** Agent 话语（可为空串） */
  say: string;
  /** 本轮新增卡片（前端追加到流末尾） */
  cards: PlanSessionCard[];
  draft: PlanSessionDraft | null;
  /** budget_ready / generated 阶段的预算明细 */
  budget: PlanSessionBudget | null;
  /** 核实闸摘要（闭馆日/需预约/排太满；生成后随预算一起给，确认前就能看到风险） */
  verification?: PlanSessionVerification | null;
  /** 右侧档案栏快照（每轮随回执重算，客户端整栏替换） */
  dossier: PlanSessionDossier;
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

export type PlanSession = {
  id: string;
  createdAt: number;
  updatedAt: number;
  destination?: string;
  days?: number;
  startDate?: string;
  endDate?: string;
  /** 出发地（大交通实时价必需；未知则不报价，如实标「未含」） */
  origin?: string;
  /** 出发地来源：located=按用户定位补的默认值（预算/简报如实标注，不冒充用户原话） */
  originSource?: "located";
  /** 用户定位解析出的默认出发地（会话创建时从 LocationCoordinator 最近缓存被动读取；缓存为空时首轮回填会主动要一次 GPS） */
  locatedOrigin?: { city: string; region: string; locatedAt: number };
  /** 每会话至多主动向客户端要一次 GPS（防止每轮都等 12s 定位超时） */
  originLocateAttempted?: boolean;
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
  /** 种草筛选候选（首次信息齐时生成；目的地变化后重生成） */
  guide?: { destination: string; cats: PlanSessionGuideCat[] };
  guideSent: boolean;
  /** 用户在筛选卡上勾选的条目（景点/住宿/餐厅） */
  guideSelections?: { view: string[]; stay: string[]; food: string[] };
  /** 筛选后用户自己补的地点/酒店/餐厅（自由输入，与勾选合并后进入规划） */
  extras?: { view: string[]; stay: string[]; food: string[]; note?: string };
  /** 已发出补充卡、还在等用户回（自由文本也当补充处理） */
  awaitingExtras?: boolean;
  /** 补完心愿后的预订选择（大交通/酒店真实班次与房价；用户选完才生成） */
  booking?: PlanSessionBookingData;
  /** 已发出预订选择卡、还在等用户回（暂不预订也算答复） */
  awaitingBooking?: boolean;
};

/** 追问卡总数封顶：到顶后不再出卡，目的地在手就直接出方案。 */
const MAX_QUESTION_TURNS = 8;

// ======================== 会话存储（内存 + 磁盘双层） ========================

/** 内存 TTL：清出后磁盘仍在（可恢复），不是删除。 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** 磁盘留存期：30 天后随清扫删除（规划会话是短生命周期数据，不是档案）。 */
const SESSION_DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 测试可用 TRAVEL_PLAN_SESSIONS_DIR 覆盖存储目录（默认 data/travel-plan-sessions）
const SESSIONS_DIR = path.resolve(
  process.env.TRAVEL_PLAN_SESSIONS_DIR || path.join(getDataDir(), "travel-plan-sessions"),
);
const sessions = new Map<string, PlanSession>();
let sessionsDirReady = false;

function ensureSessionsDir(): void {
  if (sessionsDirReady) return;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  sessionsDirReady = true;
}

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${path.basename(id)}.json`);
}

/** 每轮变更后落盘（同步写：规划是低频交互，与 travelPlanStore 同一口径）。 */
function saveSession(session: PlanSession): void {
  sessions.set(session.id, session);
  try {
    ensureSessionsDir();
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(session), "utf8");
  } catch (err) {
    console.error("[travel-plan-session] save failed:", err);
  }
}

/** 内存未命中 → 惰性读盘：服务重启 / 内存被 TTL 清出后凭 sessionId 仍可续聊。 */
function getSession(id: string): PlanSession | null {
  const cached = sessions.get(id);
  if (cached) return cached;
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(id), "utf8")) as PlanSession;
    if (parsed?.id && Array.isArray(parsed.history)) {
      sessions.set(parsed.id, parsed);
      return parsed;
    }
  } catch {
    // 不存在/损坏 → null
  }
  return null;
}

/** 双层清扫：内存 2h 清出（磁盘保留可恢复）；磁盘 30 天过期删除。 */
function pruneSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(SESSIONS_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > SESSION_DISK_TTL_MS) fs.rmSync(p, { force: true });
      } catch {
        // 单个文件失败不影响其余
      }
    }
  } catch (err) {
    console.error("[travel-plan-session] prune failed:", err);
  }
}

function newSessionId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ======================== LLM 编排器 ========================

type Orchestration = {
  updates: {
    destination: string | null;
    origin: string | null;
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
    session.origin ? `出发地=${session.origin}` : "出发地=未知",
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
  const located = session.locatedOrigin;
  const locAgeMin = located ? Math.floor((Date.now() - located.locatedAt) / 60_000) : 0;
  const locAgeText =
    locAgeMin < 60 ? `${Math.max(1, locAgeMin)} 分钟前` : `${Math.floor(locAgeMin / 60)} 小时前`;
  const locationBlock = located
    ? `【用户定位】${located.region ? `${located.region} · ` : ""}${located.city}（GPS 定位于 ${locAgeText}）。这是系统后台定位，不是用户说的话。\n`
    : "";

  const system =
    "你是行程规划会话的编排器，逐轮决定「回复什么、信息还缺什么、下一张问题卡问什么」。" +
    `今天是 ${today}。\n` +
    `【当前已知】${knownStateText(session)}\n` +
    `【已确认问答】\n${qa}\n` +
    locationBlock +
    "\n只输出 JSON：\n" +
    '{"updates":{"destination":"目的地|null","origin":"出发城市|null","days":天数|null,"startDate":"YYYY-MM-DD|null","endDate":"YYYY-MM-DD|null"},' +
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
    "7. 预算类问题 question.id 固定写 budget；选项带档位词锚点（经济/舒适/品质/豪华），可加口语后缀（如「舒适 · 性价比」），保证下游规划引擎能识别；必给 placeholder（如「或直接填个大概预算，如：人均 3000」）并 allowNote=true，用户可以不选档位、只填金额作答。用户自报了金额时，answerUpdates 的 budget 答案写成「自报¥N · 档位」，档位由你结合目的地与天数判断（经济/舒适/品质/豪华），金额原样保留。\n" +
    "8. 问得像朋友聊天，不要查户口：目的地+天数/日期之外，最多再挑 2 个有用的维度问（出发地/预算/大交通/同行人…按需取用），其余交给生成引擎。具体玩哪些景点、住哪家酒店、吃什么由下一步的图文筛选卡负责，绝对不要问这些。同行人类问题的 question.id 固定写 party，options 给 2~5 个同行人（一个人/情侣/朋友/带父母/带孩子…，选项要写成能认出同行关系的词，卡片才能顺手给出节奏推断）。同行人已知后绝不再单独问节奏：节奏按同行人自动定（情侣、家人→松弛；朋友→紧凑；独自→均衡），卡片会把推断结果显示出来让用户改。只有用户主动说「想紧凑/想放松」或与同行人明显矛盾时，在 say 里确认一句即可，不出节奏卡。\n" +
    "8.1 大交通要按真实票价算，必须先有出发地：用户没说出发地时，优先把【用户定位】城市当默认出发地——updates.origin 直接填该城市，say 里顺带自然说一句「按你的定位从X出发」，绝不出 origin 问题卡；只有【用户定位】缺失时才问「从哪儿出发」（question.id 固定用 origin，multi=false），选项可给几个常见城市或让用户直接说。用户明确表示不坐大交通/不用管交通，就不必再问。\n" +
    "9. 信息足够出方案时 ready=true 且 question=null（前提：目的地与天数/日期都已定；其余维度问到 1~2 个就够），不要为了凑进度而问。\n" +
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
export function normalizeOrchestration(
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
    origin:
      typeof upd.origin === "string" && upd.origin.trim()
        ? upd.origin.trim().slice(0, 40)
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
      const rawId = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 24) : "more";
      const id = /^(origin|departure|departureCity|depart|from)$/i.test(rawId)
        ? "origin"
        : /^(budget|yusuan|预算)$/i.test(rawId)
          ? "budget"
          : rawId;
      // 预算卡必须留自由填写入口：LLM 漏给 placeholder/allowNote 时确定性补上
      const budgetFill = id === "budget";
      const effAllowNote = allowNote || budgetFill;
      const effPlaceholder =
        placeholder ?? (budgetFill ? "或直接填个大概预算，如：人均 3000" : undefined);
      question = {
        id,
        stage:
          typeof o.stage === "string" && o.stage.trim()
            ? o.stage.trim().slice(0, 12)
            : "还想确认",
        title,
        multi: o.multi === true,
        options,
        ...(effPlaceholder ? { placeholder: effPlaceholder } : {}),
        ...(effAllowNote ? { allowNote: true } : {}),
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

/** 口语出发地 → 城市名（「从北京出发」→ 北京；「北京/天津都行」取第一个）。 */
function normalizeOrigin(text: string): string {
  const first = text.split(/[、,，/／（(]/)[0]!.trim();
  return first
    .replace(/^从/, "")
    .replace(/(出发|起飞|走|过去|过来)$/g, "")
    .trim()
    .slice(0, 20);
}

function applyOriginAnswer(session: PlanSession): void {
  if (session.origin) return;
  const hit = session.answers.find(
    (a) => a.id === "origin" || /出发地|从哪|哪儿出发|从哪里出发/.test(a.question),
  );
  if (!hit) return;
  const value = normalizeOrigin(hit.answer);
  if (value && !/^(不想|不用|不要|随便|都行|先不选|到地再说)/.test(value)) {
    session.origin = value;
  }
}

/**
 * 出发地按定位兜底（2026-10-26，2026-10-27 增主动定位）：编排器/正则都没拿到
 * 出发地时用用户定位城市当默认出发地（标 located，简报/预算如实标注）。
 * 两级定位来源：
 *   1. 会话创建时被动读到的 LocationCoordinator 缓存（locatedOrigin）；
 *   2. 缓存为空时主动向在线客户端要一次 GPS（requestAnyLocation，每会话至多
 *      一次——防每轮都等 12s 超时）。用户反问「怎么又要我问从哪出发」事故的
 *      根因就是只有①：客户端 48h 内没上报过，被动缓存永远为空。
 * say 没提及时补一句说明。回填后 filterQuestion 自然拦掉 origin 卡。
 */
export async function backfillOriginFromLocation(session: PlanSession, say: string): Promise<string> {
  if (session.origin) return say;
  if (!session.locatedOrigin && !session.originLocateAttempted) {
    session.originLocateAttempted = true;
    const coordinator = planSessionLocationCoordinator;
    if (coordinator) {
      const loc = await coordinator.requestAnyLocation("travel.origin").catch(() => null);
      if (loc) {
        const resolved = await resolveOriginFromLocation(loc).catch(() => null);
        if (resolved) {
          session.locatedOrigin = { ...resolved, locatedAt: Date.now() };
          console.log(`[travel-plan-session] 出发地主动定位成功：${resolved.city}（${resolved.region || "未知省份"}）`);
        }
      }
    }
  }
  if (!session.locatedOrigin) return say;
  const { city } = session.locatedOrigin;
  session.origin = city;
  session.originSource = "located";
  return say.includes(city) ? say : `${say}出发地按你的定位取${city}。`;
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
async function fallbackTurn(session: PlanSession): Promise<PlanSessionTurn> {
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
  const originMatch =
    /从([^，。！？\s]{2,10}?)(?:出发|起飞|走)/.exec(lastUser) ??
    /^([^，。！？\s]{2,8})出发/.exec(lastUser.trim());
  if (originMatch?.[1] && originMatch[1] !== session.destination) {
    session.origin = normalizeOrigin(originMatch[1]);
  }
  deriveEndFromStart(session);

  const days = effectiveDays(session);
  const ready = Boolean(session.destination) && days != null;
  session.ready = ready;
  let say = !session.destination
    ? "想去哪儿玩？直接告诉我目的地。"
    : days == null
      ? `${session.destination}好地方！打算玩几天？说天数或日期都行。`
      : "信息差不多齐了，我来出一版方案。";
  if (session.destination) say = await backfillOriginFromLocation(session, say);
  session.history.push({ role: "assistant", content: say });
  return {
    ok: true,
    sessionId: session.id,
    state: ready ? "ready" : "gathering",
    say,
    cards: [],
    draft: null,
    budget: null,
    dossier: buildDossier(session, ready ? "ready" : "gathering"),
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
 * 节奏档的口语说明（密度上限与 paceCapFor 一致：2/3/4 站）。
 * 同行人定了就直接给结论，用户点「改」才展开这三档。
 */
const PACE_INFER_TEXT: Record<
  "relaxed" | "balanced" | "intensive",
  { pace: string; detail: string }
> = {
  relaxed: { pace: "松弛", detail: "每天 2–3 站 · 慢一点出门 · 留午休" },
  balanced: { pace: "均衡", detail: "每天 3 站 · 正常作息" },
  intensive: { pace: "紧凑", detail: "每天 4 站 · 早出晚归" },
};

const PARTY_QUESTION_TITLE = /和谁|同行|谁一起|几个人|带谁|谁去|同伴/;
const PACE_QUESTION_TITLE = /节奏|特种兵|慢逛|怎么玩|怎么走|走多快/;

function isPartyQuestion(q: { id: string; title: string }): boolean {
  return q.id === "party" || PARTY_QUESTION_TITLE.test(q.title);
}

/** 同行人已知（点选答过，或原话/历史里读得出来）：节奏就不再单独问。 */
function partyKnown(session: PlanSession): boolean {
  if (session.answers.some((a) => a.id === "party")) return true;
  const text = [
    session.originalMessage,
    ...session.history.map((h) => h.content),
    ...session.answers.map((a) => a.answer),
  ].join("；");
  return Boolean(extractParty(text));
}

/** 同行人各选项 → 节奏推断（判不出同行人的选项不挂，避免瞎猜）。 */
export function paceInferForOptions(
  options: string[],
): Record<string, PlanSessionPaceInfer> | undefined {
  const out: Record<string, PlanSessionPaceInfer> = {};
  const alternatives = [
    PACE_INFER_TEXT.relaxed.pace,
    PACE_INFER_TEXT.balanced.pace,
    PACE_INFER_TEXT.intensive.pace,
  ];
  for (const option of options) {
    const party = extractParty(option);
    const pace = party ? paceForParty(party) : undefined;
    if (!pace) continue;
    out[option] = {
      pace: PACE_INFER_TEXT[pace].pace,
      detail: PACE_INFER_TEXT[pace].detail,
      options: alternatives,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ======================== 右侧行程档案栏 ========================

/** 五步进度轨：与规划流的真实阶段一一对应。 */
const DOSSIER_STEPS: Array<{ id: PlanSessionDossierStep["id"]; label: string }> = [
  { id: "gather", label: "问答" },
  { id: "guide", label: "挑想去" },
  { id: "extras", label: "补心愿" },
  { id: "budget", label: "核预算" },
  { id: "plan", label: "出方案" },
];

/** 会话状态 → 当前停在哪一步（generated 视为五步全走完）。预订选择并入「核预算」步。 */
const DOSSIER_ACTIVE_INDEX: Record<PlanSessionTurn["state"], number> = {
  gathering: 0,
  guide_ready: 1,
  wishlist_ready: 2,
  booking_ready: 1,
  ready: 3,
  budget_ready: 3,
  generated: 5,
};

/** 没点选、但原话里读得出的同行人 → 档案栏文案。 */
const PARTY_DOSSIER_LABEL: Record<
  NonNullable<ReturnType<typeof extractParty>>,
  string
> = {
  solo: "一个人",
  solo_female: "一个人",
  couple: "和伴侣",
  family: "带家人",
  friends: "和朋友",
};

/** 「先不选/随便」这类占位回答不算已定。 */
const UNANSWERED = /^(先不选|到地再说|随便|都行|不用|再说|没想好)/;

/** 维度答案（点选与原话交代都算），命不中或属占位回答返回 null。 */
function answerValueOf(
  session: PlanSession,
  ids: string[],
  titleHint: RegExp,
): string | null {
  const hit = session.answers.find((a) => ids.includes(a.id) || titleHint.test(a.question));
  if (!hit) return null;
  const v = hit.answer.split("（")[0]!.trim();
  return v && !UNANSWERED.test(v) ? v : null;
}

/** 同行人文案：点选优先，其次从原话里认（认出来就不该再出现在「还缺」里）。 */
function partyValueOf(session: PlanSession): string | null {
  const answered = answerValueOf(session, ["party"], PARTY_QUESTION_TITLE);
  if (answered) return answered.split("、")[0]!.trim();
  const fromText = extractParty(
    [session.originalMessage, ...session.answers.map((a) => a.answer)].join("；"),
  );
  return fromText ? PARTY_DOSSIER_LABEL[fromText] : null;
}

/** 节奏档：走规划引擎同一套识别（用户明说优先，其次同行人默认）。 */
function paceValueOf(session: PlanSession): string | null {
  const pace = extractPreferences(
    composePlanningInput(session),
    undefined,
    session.destination ?? "",
  ).pace;
  return pace ? PACE_INFER_TEXT[pace].pace : null;
}

/** 地名串展示：最多列 3 个，其余折成「等 N 处」。 */
function briefNames(names: string[]): string {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  const head = unique.slice(0, 3).join("、");
  return unique.length > 3 ? `${head} 等 ${unique.length} 处` : head;
}

function dossierFactsOf(session: PlanSession): PlanSessionDossierFact[] {
  const facts: PlanSessionDossierFact[] = [];
  // 关键维度恒挂（没定就标 todo，让用户看见还欠什么）
  const core = (id: string, label: string, value: string | null | undefined): void => {
    const v = (value ?? "").trim();
    facts.push({ id, label, value: v, state: v ? "set" : "todo" });
  };
  // 选问维度只在已定时出现
  const optional = (id: string, label: string, value: string | null | undefined): void => {
    const v = (value ?? "").trim();
    if (v) facts.push({ id, label, value: v, state: "set" });
  };

  const days = effectiveDays(session);
  core("destination", "去哪儿", session.destination);
  core(
    "days",
    "玩几天",
    days
      ? `${days} 天${session.startDate ? ` · ${session.startDate.slice(5)} 起` : ""}`
      : session.startDate
        ? `${session.startDate.slice(5)} 出发`
        : null,
  );
  core(
    "origin",
    "从哪儿走",
    session.origin
      ? `${session.origin}${session.originSource === "located" ? "（定位）" : ""}出发`
      : null,
  );
  const party = partyValueOf(session);
  const pace = paceValueOf(session);
  core("party", "和谁去", party ? [party, pace].filter(Boolean).join(" · ") : null);
  optional("budget", "预算档", answerValueOf(session, ["budget"], /预算|花费|住宿标准/));
  optional("transport", "大交通", answerValueOf(session, ["transport", "traffic"], /交通|怎么去|往返/));
  optional(
    "picks",
    "想去",
    briefNames([...(session.guideSelections?.view ?? []), ...(session.extras?.view ?? [])]),
  );
  optional(
    "stay",
    "住",
    briefNames([...(session.guideSelections?.stay ?? []), ...(session.extras?.stay ?? [])]),
  );
  optional(
    "food",
    "吃",
    briefNames([...(session.guideSelections?.food ?? []), ...(session.extras?.food ?? [])]),
  );
  return facts.slice(0, 9);
}

/**
 * 档案栏快照：头 + 五步轨 + 已定条。会话状态一变就重算，客户端整栏替换，
 * 不留本地副本（避免刷新恢复、重进页面时两处不一致）。
 */
export function buildDossier(
  session: PlanSession,
  state: PlanSessionTurn["state"],
): PlanSessionDossier {
  const active = DOSSIER_ACTIVE_INDEX[state] ?? 0;
  const days = effectiveDays(session);
  return {
    head: [
      session.destination ?? "目的地待定",
      days ? `${days} 天` : null,
      session.origin ? `${session.origin}出发` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    steps: DOSSIER_STEPS.map((s, i) => ({
      id: s.id,
      label: s.label,
      state: (i < active ? "done" : i === active ? "active" : "todo") as PlanSessionDossierStep["state"],
    })),
    facts: dossierFactsOf(session),
  };
}

/**
 * 服务端硬护栏：没拿到目的地不出卡（文字问）；已答过的维度不再出卡
 * （改答案走 answerUpdates，不走重问）；天数已有定值时不再出天数卡。
 */
export function filterQuestion(
  session: PlanSession,
  q: NextQuestion | null,
): NextQuestion | null {
  if (!q) return null;
  if (!session.destination) return null;
  if (session.answers.some((a) => a.id === q.id)) {
    console.warn(`[travel-plan-session] 编排器想重问已答维度「${q.id}」，已拦截`);
    return null;
  }
  // 同行人已知时节奏是推论，不是新题：不再单出一张节奏卡（改节奏在同行人卡里）。
  if ((q.id === "pace" || PACE_QUESTION_TITLE.test(q.title)) && partyKnown(session)) {
    console.warn(`[travel-plan-session] 同行人已知，节奏卡「${q.title}」已拦截`);
    return null;
  }
  if ((q.id === "days" || q.id === "dates") && effectiveDays(session) != null) {
    return null;
  }
  if (q.id === "origin" && session.origin) {
    return null;
  }
  return q;
}

/** 三类候选的展示名（与主对话种草卡一致）。 */
const GUIDE_LABELS: Record<"view" | "stay" | "food", string> = {
  view: "必玩景点",
  stay: "住宿推荐",
  food: "美食推荐",
};

/** 三段筛选的先后顺序：先景点、再住宿、最后吃的，每段一张独立卡。 */
const GUIDE_ORDER: Array<"view" | "stay" | "food"> = ["view", "stay", "food"];

const GUIDE_SHORT_LABELS: Record<"view" | "stay" | "food", string> = {
  view: "景点",
  stay: "住宿",
  food: "美食",
};

const GUIDE_STAGE_TITLES: Record<"view" | "stay" | "food", (dest: string) => string> = {
  view: (d) => `${d} · 先挑想去的景点`,
  stay: (d) => `${d} · 再挑住的地方`,
  food: (d) => `${d} · 最后挑吃的`,
};

/** 每段卡出场时的引导语（段间过渡与打字岔开的召回都用它）。 */
const GUIDE_STAGE_INVITE: Record<"view" | "stay" | "food", string> = {
  view: "先挑想去的景点，勾掉不想要的——",
  stay: "接着挑住的地方——",
  food: "最后一轮，挑几家想吃的馆子——",
};

/**
 * 分段筛选进行到哪段：有候选但还没勾定的一段；全部勾完返回 null。
 * 「勾定」= guideSelections 里该段有勾选（每段至少勾一处或交给代选）。
 */
function pendingGuideStage(session: PlanSession): "view" | "stay" | "food" | null {
  if (!session.guideSent || !session.guide) return null;
  for (const key of GUIDE_ORDER) {
    const cat = session.guide.cats.find((c) => c.key === key);
    if (!cat || cat.items.length === 0) continue;
    if ((session.guideSelections?.[key]?.length ?? 0) === 0) return key;
  }
  return null;
}

/** 当前段的筛选卡：只带这一段的候选，标题与口播都按段走。 */
function guideCardForStage(
  session: PlanSession,
  stage: "view" | "stay" | "food",
): PlanSessionCard | null {
  const cat = session.guide?.cats.find((c) => c.key === stage);
  if (!session.guide || !cat) return null;
  return {
    type: "guide",
    stage: "挑一挑",
    title: GUIDE_STAGE_TITLES[stage](session.guide.destination),
    destination: session.guide.destination,
    cats: [cat],
  };
}

/**
 * 会话状态标签（GET /:id 与 GET /travel/plan-sessions 共用，口径必须一致）。
 * 与客户端 _PlanningStageState 的恢复渲染分支一一对应。
 */
function sessionStateLabel(session: PlanSession): PlanSessionTurn["state"] {
  if (session.budgetApproved) return "generated";
  if (session.budget) return "budget_ready";
  if (session.awaitingExtras) return "wishlist_ready";
  if (session.awaitingBooking && session.booking) return "booking_ready";
  if (session.ready && pendingGuideStage(session)) return "guide_ready";
  if (session.ready) return "ready";
  return "gathering";
}

/**
 * 恢复用的「当前挂起卡」：筛选卡段 / 补心愿卡可以确定性重建；
 * choice 问题卡的选项不落盘（编排器每轮现生成），恢复不了 → 返回 null，
 * 客户端退化为「继续说一句」即可，下一轮回执自然带新卡。
 */
function resumeCardFor(session: PlanSession): PlanSessionCard | null {
  if (session.budgetApproved) return null;
  if (session.awaitingExtras) {
    return buildWishlistCard(session.guideSelections ?? { view: [], stay: [], food: [] });
  }
  if (session.awaitingBooking && session.booking) return bookingCardFor(session);
  if (session.ready) {
    const stage = pendingGuideStage(session);
    return stage ? guideCardForStage(session, stage) : null;
  }
  return null;
}

/**
 * 信息齐后、出方案前的候选生成：真实候选（文字介绍 + 实拍图 + 实时价），
 * 全量存进 session.guide，由三段筛选卡逐段下发。生成失败返回 false 走
 * 「直接出方案」，不让筛选环节挡住主链路。
 */
async function buildGuideCandidates(
  session: PlanSession,
  service: PlanningService,
): Promise<boolean> {
  if (!session.destination) return false;
  try {
    // 落位诉求从用户原话里抽（「住得离兵马俑近点」）：抽到才按距离重排住宿段。
    const focus = extractHotelFocus(composePlanningInput(session));
    const g = await service.buildDestinationGuide(session.destination, 6, {
      ...(focus ? { hotelFocus: focus.focus, hotelFocusRef: focus.ref } : {}),
    });
    const toItems = (list: GuideCandidate[]): PlanSessionGuideItem[] =>
      list.map((c) => ({
        name: c.name,
        intro: c.intro ?? "",
        photos: c.photos,
        ...(c.address ? { address: c.address } : {}),
        metrics: c.metrics,
        picked: false,
      }));
    const allCats: PlanSessionGuideCat[] = [
      {
        key: "view",
        label: GUIDE_LABELS.view,
        items: toItems(g.view),
        sortNote: g.sortNotes.view,
      },
      {
        key: "stay",
        label: GUIDE_LABELS.stay,
        items: toItems(g.stay),
        sortNote: g.sortNotes.stay,
        ...(g.stayAnchor
          ? {
              anchor: {
                id: g.stayAnchor.id,
                label: g.stayAnchor.label,
                why: g.stayAnchor.why,
              },
            }
          : {}),
      },
      {
        key: "food",
        label: GUIDE_LABELS.food,
        items: toItems(g.food),
        sortNote: g.sortNotes.food,
      },
    ];
    const cats = allCats.filter((c) => c.items.length > 0);
    if (cats.length === 0) return false;
    session.guide = { destination: g.destination, cats };
    return true;
  } catch (err) {
    console.warn(
      "[travel-plan-session] 筛选候选生成失败，直接出方案:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** 筛选卡之后的自选补充卡：写名字即可，留空表示没有。 */
function buildWishlistCard(
  selections: { view: string[]; stay: string[]; food: string[] },
): PlanSessionCard {
  return {
    type: "wishlist",
    stage: "再补一句",
    title: "还有非去不可的地方吗？",
    sub: "勾选已记下。想加景点、酒店或餐厅，直接写名字（多个用顿号/逗号分隔）；没有就点跳过。",
    selected: selections,
    placeholders: {
      view: "例如：都江堰、熊猫基地",
      stay: "例如：太古里附近的酒店",
      food: "例如：陈麻婆豆腐",
    },
  };
}

// ────────────────────── 预订选择卡：准备 / 下发 / 落实 ──────────────────────

function addDaysISO(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** 预订卡文案：飞猪实时班次/房价，选中进预算与行程，可不订。 */
function bookingCardFor(session: PlanSession): PlanSessionCard | null {
  const b = session.booking;
  if (!b) return null;
  return {
    type: "booking",
    stage: "订行程",
    title: `${b.origin ? `${b.origin} → ` : ""}${b.destination} · 大交通与住宿`,
    sub:
      "班次与房价来自飞猪实时查询。选中的会按它的价格进预算、写进行程（车次/航班带接驳提醒），也可以先不订、按实时最低价做参考。",
    origin: b.origin,
    destination: b.destination,
    ...(b.checkIn ? { checkIn: b.checkIn } : {}),
    ...(b.checkOut ? { checkOut: b.checkOut } : {}),
    nights: b.nights,
    transports: b.transports,
    hotels: b.hotels,
    ...(b.selection ? { selection: b.selection } : {}),
    ...(b.trial ? { trial: true } : {}),
  };
}

/**
 * 补完心愿后的预订选择准备（2026-10-27）：往返大交通（机票/高铁）与目的地酒店
 * 全部来自飞猪实时查询——票价取不到（体验模式脱敏/未公布）就置 null 由卡面
 * 标「待核价」，绝不编造。出发地未知或同城不查大交通（只给酒店）。
 * 成功返回 true（session.booking 已就绪、awaitingBooking 置位）；失败/两手空
 * 返回 false，调用方维持原「ready 直接生成」路径，不让预订卡挡主链路。
 */
async function prepareBooking(session: PlanSession): Promise<boolean> {
  if (!session.destination) return false;
  // 已在等用户选：复用现有卡，不重复打外网查询（用户没点卡、又发消息的场景）
  if (session.awaitingBooking && session.booking) return true;
  // 用户已确认过选择：不重发卡（选择已落实进生成链路）
  if (session.booking?.selection) return false;
  const days = effectiveDays(session);
  // 晚数 = 天数-1（当天往返按 1 晚口径，与预算一致）；无天数按 1 晚
  const nightCount = days ? Math.max(1, days - 1) : 1;
  const checkIn = session.startDate || undefined;
  const checkOut =
    session.endDate || (checkIn ? addDaysISO(checkIn, nightCount) : undefined);
  const trial = process.env.FLYAI_TRIAL === "1";
  try {
    const origin = (session.origin ?? "").trim();
    const differentCity =
      !!origin && origin.replace(/\s/g, "") !== session.destination.replace(/\s/g, "");
    const [transportRes, hotels] = await Promise.all([
      differentCity
        ? lookupTransportOptions({
            origin,
            originRegion: session.locatedOrigin?.region || undefined,
            destination: session.destination,
            ...(checkIn ? { startDate: checkIn } : {}),
            ...(checkOut ? { endDate: checkOut } : {}),
          })
        : Promise.resolve({ flights: [], trains: [] }),
      lookupHotelOptions({
        city: session.destination,
        names: mergedWishlists(session).stay,
        ...(checkIn ? { checkIn } : {}),
        ...(checkOut ? { checkOut } : {}),
      }),
    ]);
    // 大交通：机票在前、高铁在后，key 稳定（t0..）供 /booking 回传校验
    const transportList = [...transportRes.flights, ...transportRes.trains];
    const priced = transportList.filter((t) => t.amount != null && t.durationMin != null && t.durationMin <= 12 * 60);
    const recommendedKey = priced.length
      ? priced.reduce((a, b) => ((a.amount ?? 0) <= (b.amount ?? 0) ? a : b)).no
      : undefined;
    const transports: PlanSessionBookingTransport[] = transportList.map((t, i) => ({
      key: `t${i}`,
      mode: t.mode,
      ...(t.no ? { no: t.no } : {}),
      ...(t.carrier ? { carrier: t.carrier } : {}),
      ...(t.outbound ? { outbound: t.outbound } : {}),
      ...(t.inbound ? { inbound: t.inbound } : {}),
      amount: t.amount,
      ...(t.durationMin ? { durationMin: t.durationMin } : {}),
      ...(t.bookingUrl ? { bookingUrl: t.bookingUrl } : {}),
      ...(t.viaHub ? { viaHub: t.viaHub } : {}),
      ...(t.no && t.no === recommendedKey ? { recommended: true } : {}),
    }));
    // 酒店：勾选置顶（fromPicks），推荐位给有实价里最便宜的
    const hotelPriced = hotels.filter((h) => h.amount != null);
    const recommendedHotel = hotelPriced.length
      ? hotelPriced.reduce((a, b) => (a.amount ?? 0) <= (b.amount ?? 0) ? a : b).name
      : undefined;
    const hotelOptions: PlanSessionBookingHotel[] = hotels.map((h, i) => ({
      key: `h${i}`,
      name: h.name,
      amount: h.amount,
      ...(h.rating ? { rating: h.rating } : {}),
      ...(h.star ? { star: h.star } : {}),
      ...(h.near ? { near: h.near } : {}),
      ...(h.image ? { image: h.image } : {}),
      ...(h.bookingUrl ? { bookingUrl: h.bookingUrl } : {}),
      ...(h.fromPicks ? { fromPicks: true } : {}),
      ...(h.name === recommendedHotel ? { recommended: true } : {}),
    }));
    if (transports.length === 0 && hotelOptions.length === 0) return false;
    session.booking = {
      origin,
      destination: session.destination,
      ...(checkIn ? { checkIn } : {}),
      ...(checkOut ? { checkOut } : {}),
      nights: nightCount,
      transports,
      hotels: hotelOptions,
      ...(trial ? { trial: true } : {}),
      preparedAt: Date.now(),
    };
    session.awaitingBooking = true;
    return true;
  } catch (err) {
    console.warn(
      "[travel-plan-session] 预订选择准备失败，直接生成:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** 预订卡提交后的回话：报出所选班次/酒店，或如实说明按参考价走。 */
function bookingSayOf(session: PlanSession): string {
  const b = session.booking;
  if (!b) return "";
  const t = b.selection?.transportKey
    ? b.transports.find((x) => x.key === b.selection!.transportKey)
    : undefined;
  const h = b.selection?.hotelKey
    ? b.hotels.find((x) => x.key === b.selection!.hotelKey)
    : undefined;
  const parts: string[] = [];
  parts.push(
    t
      ? `大交通按你选的${t.mode === "flight" ? "航班" : "车次"}${t.no ?? ""}算${
          t.amount != null ? `（往返 ¥${t.amount}）` : "（票价以订票页为准）"
        }`
      : "大交通先按实时最低价做预算参考",
  );
  parts.push(
    h ? `住宿按你选的「${h.name}」排` : "住宿按行程里的酒店实时价算",
  );
  return `${parts.join("；")}，记下了。`;
}

/**
 * 信息齐后、进「选一选」之前先过预订选择卡：prepareBooking 成功 →
 * booking_ready 轮（含预订卡）；失败/两手空 → null，调用方继续原筛选/生成路径。
 */
async function bookingTurnOrNull(session: PlanSession): Promise<PlanSessionTurn | null> {
  const prepared = await prepareBooking(session);
  if (!prepared) return null;
  const card = bookingCardFor(session);
  if (!card) return null;
  const say = "先把大交通和住宿定一下——都是实时班次和房价，选中的会算进预算和行程，不合适就先不订。";
  session.history.push({ role: "assistant", content: say });
  return {
    ok: true,
    sessionId: session.id,
    state: "booking_ready",
    say,
    cards: [card],
    draft: null,
    budget: null,
    dossier: buildDossier(session, "booking_ready"),
  };
}

/** 三段筛选全部勾完：记账 + 进补心愿（endpoint 内使用，抽出来复用代选路径）。 */
function finalizeGuideTurn(
  session: PlanSession,
  selections: { view: string[]; stay: string[]; food: string[] },
  persist = false,
): PlanSessionTurn {
  session.guideSelections = selections;
  session.extras = undefined;
  session.awaitingExtras = true;
  session.ready = true;
  session.pendingQuestion = undefined;
  const parts: string[] = [];
  if (selections.view.length) parts.push(`必玩 ${selections.view.join("、")}`);
  if (selections.stay.length) parts.push(`住宿 ${selections.stay.join("、")}`);
  if (selections.food.length) parts.push(`美食 ${selections.food.join("、")}`);
  const say = `就按这几处来排：${parts.join("；")}。还有非去不可、但不在列表里的地方吗？没有就直接算预算。`;
  session.history.push({ role: "user", content: `（筛选）${parts.join("；")}` });
  session.history.push({ role: "assistant", content: say });
  session.answers = session.answers.filter((a) => a.id !== "guide");
  session.answers.push({ id: "guide", question: "想玩哪些", answer: parts.join("；") });
  if (persist) saveSession(session);
  return {
    ok: true,
    sessionId: session.id,
    state: "wishlist_ready",
    say,
    cards: [buildWishlistCard(selections)],
    draft: null,
    budget: null,
    dossier: buildDossier(session, "wishlist_ready"),
  };
}

function uniqNames(list: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const name = (raw ?? "").trim();
    if (name.length < 2 || name.length > 40) continue;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, 12);
}

/**
 * 记录用户自选补充（卡片输入或自由文本抠出的名字）。
 * 只并入 extras，不动筛选卡勾选本身——两处来源在生成时合并。
 * 返回本次新增的名字（去重后），用于回话。
 */
function recordExtras(
  session: PlanSession,
  input: { view?: string[]; stay?: string[]; food?: string[]; note?: string },
): string[] {
  const cur = session.extras ?? { view: [], stay: [], food: [] };
  const before = new Set([...cur.view, ...cur.stay, ...cur.food].map((n) => n.toLowerCase()));
  const merged = {
    view: uniqNames([...cur.view, ...(input.view ?? [])]),
    stay: uniqNames([...cur.stay, ...(input.stay ?? [])]),
    food: uniqNames([...cur.food, ...(input.food ?? [])]),
    ...(input.note?.trim()
      ? { note: input.note.trim().slice(0, 200) }
      : cur.note
        ? { note: cur.note }
        : {}),
  };
  session.extras = merged;
  return [...merged.view, ...merged.stay, ...merged.food].filter(
    (n) => !before.has(n.toLowerCase()),
  );
}

/** 合并后的心愿清单（筛选勾选 + 自选补充），生成时交给规划引擎。 */
function mergedWishlists(session: PlanSession): {
  view: string[];
  stay: string[];
  food: string[];
} {
  const sel = session.guideSelections;
  const ext = session.extras;
  return {
    view: uniqNames([...(sel?.view ?? []), ...(ext?.view ?? [])]),
    stay: uniqNames([...(sel?.stay ?? []), ...(ext?.stay ?? [])]),
    food: uniqNames([...(sel?.food ?? []), ...(ext?.food ?? [])]),
  };
}

/**
 * 统一轮处理（消息轮 / 点选轮同一链路）：编排器产出回应 + 下一张问题
 * 卡 + ready 判定，护栏过滤违规问题，天气面板穿插。
 */
async function runTurn(
  session: PlanSession,
  service?: PlanningService,
): Promise<PlanSessionTurn> {
  // 新一轮信息进入：上一版预算/草案作废，重新对齐后由客户端再触发生成。
  session.draft = null;
  session.budget = undefined;
  session.budgetApproved = false;

  const orch = await orchestrateTurn(session);
  if (!orch) return await fallbackTurn(session);

  const prevDestination = session.destination;
  if (orch.updates.destination) session.destination = orch.updates.destination;
  if (orch.updates.origin) session.origin = normalizeOrigin(orch.updates.origin);
  if (orch.updates.days) session.days = orch.updates.days;
  if (orch.updates.startDate) session.startDate = orch.updates.startDate;
  if (orch.updates.endDate) session.endDate = orch.updates.endDate;
  deriveEndFromStart(session);
  applyAnswerUpdates(session, orch.answerUpdates);
  applyOriginAnswer(session);

  let ready = Boolean(session.destination) && orch.ready;
  let say = await backfillOriginFromLocation(session, orch.say);
  // 目的地换了：旧候选和勾选全部作废，重新出一版筛选卡（预订选择一并作废）
  if (session.destination !== prevDestination) {
    session.guide = undefined;
    session.guideSent = false;
    session.guideSelections = undefined;
    session.extras = undefined;
    session.awaitingExtras = false;
    session.booking = undefined;
    session.awaitingBooking = false;
  }
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
    const infer = isPartyQuestion(question)
      ? paceInferForOptions(question.options)
      : undefined;
    cards.push({
      type: "choice",
      id: question.id,
      stage: question.stage,
      title: question.title,
      multi: question.multi,
      options: question.options,
      ...(question.placeholder ? { placeholder: question.placeholder } : {}),
      ...(question.allowNote ? { allowNote: true } : {}),
      ...(infer ? { infer } : {}),
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

  // 编排器给了过渡语却没给下一问、也没判 ready：不能把用户晾在「没有卡可点」
  // 的空轮里。目的地和天数都在手时按 ready 继续，筛选/预算由后端确定性接管。
  if (!ready && !question && session.destination && effectiveDays(session) != null) {
    ready = true;
  }

  if (!say) {
    say = ready
      ? "信息齐了，我来算一版预算。"
      : session.destination
        ? `${session.destination}安排上，还有一两个想确认的。`
        : "想去哪儿玩？";
  }

  // 信息齐 → 先过预订选择卡（大交通+住宿，真实班次与房价；选一选之前定乘坐
  // 方式），再生成全量候选，下发第一段（景点）筛选卡。三段依次勾完才进入
  // 生成，选中的地点作为心愿清单交给规划引擎。
  if (ready && service && !session.guideSent && !session.guideSelections) {
    const bt = await bookingTurnOrNull(session);
    if (bt) {
      session.updatedAt = Date.now();
      return bt;
    }
    const built = await buildGuideCandidates(session, service);
    if (built) {
      session.guideSent = true;
      session.ready = true;
      session.pendingQuestion = undefined;
      const stage = pendingGuideStage(session);
      const guideCard = stage ? guideCardForStage(session, stage) : null;
      if (guideCard && stage) {
        const guideSay = `${session.destination}的候选整理好了，住宿和美食后面接着挑。${GUIDE_STAGE_INVITE[stage]}`;
        session.history.push({ role: "assistant", content: guideSay });
        return {
          ok: true,
          sessionId: session.id,
          state: "guide_ready",
          say: guideSay,
          cards: [...cards.filter((c) => c.type !== "choice"), guideCard],
          draft: null,
          budget: null,
          dossier: buildDossier(session, "guide_ready"),
        };
      }
    }
  }

  // 分段筛选进行中、用户却先打了字：说的景点/餐厅照收进补充心愿，再续发当前段的卡。
  const stage = pendingGuideStage(session);
  if (ready && service && stage && session.guide) {
    const lastUser =
      [...session.history].reverse().find((h) => h.role === "user")?.content ?? "";
    const added = recordExtras(session, {
      view: extractWishlist(lastUser, session.destination),
      food: extractFoodWishlist(lastUser),
      note: lastUser,
    });
    const say = added.length
      ? `${added.slice(0, 6).join("、")}记下了，会并入心愿。${GUIDE_STAGE_INVITE[stage]}`
      : GUIDE_STAGE_INVITE[stage];
    session.pendingQuestion = undefined;
    session.history.push({ role: "assistant", content: say });
    return {
      ok: true,
      sessionId: session.id,
      state: "guide_ready",
      say,
      cards: [guideCardForStage(session, stage)!],
      draft: null,
      budget: null,
      dossier: buildDossier(session, "guide_ready"),
    };
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
    dossier: buildDossier(session, ready ? "ready" : "gathering"),
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
 * 避免落回引擎默认档；自报金额的答案由编排器补写成「自报¥N · 档位」，
 * 靠档位词命中，纯金额判不出档位时返回 null（走引擎默认档）。
 */
export function budgetTierHintOf(answer: string): string | null {
  const v = answer.split("（")[0]!.trim();
  if (BUDGET_TIER_HINT[v]) return BUDGET_TIER_HINT[v]!;
  if (/经济|便宜|省钱|穷游/.test(v)) return BUDGET_TIER_HINT["经济"]!;
  if (/不差钱|豪华|高端|奢|五星|品质/.test(v)) return "预算高端";
  if (/舒适|中端|四星|中等|适中/.test(v)) return BUDGET_TIER_HINT["舒适"]!;
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
function buildBudget(result: PlanningResult, session: PlanSession): PlanSessionBudget {
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
  const transport = pricing?.transport;
  return {
    currency: pricing?.currency ?? "CNY",
    total,
    original: pricing?.totalOriginal ?? total,
    discount: pricing?.totalDiscount ?? 0,
    items: [
      transport
        ? {
            key: "transport",
            label: transport.label,
            amount: transport.amount,
            note: transport.note,
          }
        : {
            key: "transport",
            label: "交通",
            amount: null,
            note: session.origin
              ? "已按出发地查询，暂未取到实时票价，按实际购票计算"
              : "未提供出发地，往返大交通未计入；补充出发地可接实时票价",
          },
      { key: "hotel", label: "住宿", amount: hotel, note: `${nights} 晚 · 实时房价` },
      { key: "ticket", label: "门票", amount: tickets, note: "实时票价" },
      { key: "food", label: "餐饮", amount: food, note: "按每日餐厅人均累计" },
    ],
    pricingMode: pricing?.pricingMode ?? "estimated",
    warnings: pricing?.warnings ?? [],
    ...(pricing?.pendingItems ? { pendingItems: pricing.pendingItems } : {}),
  };
}

/** ISO 时刻 → HH:mm（方案卡只展示钟点）。 */
function clockOf(iso?: string): string {
  if (!iso) return "";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

function buildVerification(result: PlanningResult): PlanSessionVerification | undefined {
  const v = result.verification;
  if (!v) return undefined;
  return {
    summary: v.summary,
    checkedAt: v.checkedAt,
    issues: v.issues.map((i) => ({
      level: i.level,
      kind: i.kind,
      day: i.day,
      stop: i.stop,
      name: i.name,
      message: i.message,
      ...(i.suggestion ? { suggestion: i.suggestion } : {}),
    })),
  };
}

/** 逐日方案：时间、两站间交通、停留时长、开放/预约、以及该站核实问题。 */
function buildDraftDays(result: PlanningResult): PlanSessionDraftDay[] {
  const issues = result.verification?.issues ?? [];
  return result.days.map((day, dayIdx) => {
    const items: PlanSessionDraftStop[] = day.items.map((it, stopIdx) => {
      const booking: string[] = [];
      if (it.bookingNote) booking.push(it.bookingNote);
      if (it.type === "attraction") {
        const rule = findReservationRule(it.name, it.openingHours);
        if (rule && rule.required !== "no" && !booking.includes(rule.advice)) {
          booking.push(rule.advice);
        }
      }
      const stopIssues = issues
        .filter((x) => x.day === dayIdx && x.stop === stopIdx)
        .map((x) => (x.suggestion ? `${x.message}（${x.suggestion}）` : x.message));
      const openingHours =
        it.openingHours && !/以现场公示为准/.test(it.openingHours)
          ? it.openingHours
          : undefined;
      return {
        time: clockOf(it.startTime),
        ...(it.endTime ? { endTime: clockOf(it.endTime) } : {}),
        name: it.name,
        type: it.type,
        ...(it.transportFromPrev ? { leg: it.transportFromPrev } : {}),
        ...(it.visitDuration ? { visitDuration: it.visitDuration } : {}),
        ...(openingHours ? { openingHours } : {}),
        ...(booking.length > 0 ? { booking: booking.join("；") } : {}),
        ...(it.priceInfo ? { price: it.priceInfo } : {}),
        ...(stopIssues.length > 0 ? { issues: stopIssues } : {}),
      };
    });
    const travelMin = day.items.reduce(
      (sum, it) => sum + (it.transportFromPrev?.durationMin ?? 0),
      0,
    );
    return {
      label: `Day ${dayIdx + 1}`,
      stops: day.items.slice(0, 6).map((it) => it.name).join(" → ") || "当日暂无安排",
      ...(day.date ? { date: day.date } : {}),
      ...(day.theme ? { theme: day.theme } : {}),
      ...(day.dayWeather ? { weather: day.dayWeather } : {}),
      travelMin,
      items,
    };
  });
}

/** 真实生成：复用 PlanningService 主链路 + travelPlanStore 落盘 */
async function generateDraft(
  session: PlanSession,
  service: PlanningService,
): Promise<{ draft: PlanSessionDraft; budget: PlanSessionBudget }> {
  const wish = mergedWishlists(session);
  const input = composePlanningInput(session);
  // 同行人既决定默认节奏（planning-service 的 paceForParty），也决定住宿/餐饮取向；
  // 原文里说过就结构化传下去，避免只靠 input 正则二次解析。
  const party = extractParty(input);
  // 预订选择卡的用户选择（booking_ready 轮之后）：所选酒店置顶住宿心愿；
  // 所选班次构造成真实 TransferSegment（含 ISO 时刻，行程按班次时刻排接驳），
  // 有实价时再传 selectedTransport 让预算直接用所选价，不再现查。
  const bk = session.booking;
  const pickTransport = bk?.selection?.transportKey
    ? bk.transports.find((t) => t.key === bk.selection!.transportKey)
    : undefined;
  const pickHotel = bk?.selection?.hotelKey
    ? bk.hotels.find((h) => h.key === bk.selection!.hotelKey)
    : undefined;
  const stayWish =
    pickHotel && !wish.stay.includes(pickHotel.name)
      ? [pickHotel.name, ...wish.stay]
      : wish.stay;
  const transferSegs: TransferSegment[] = [];
  if (pickTransport?.outbound) {
    const leg = pickTransport.outbound;
    transferSegs.push({
      type: pickTransport.mode,
      role: "arrival",
      no: pickTransport.no ?? "",
      ...(leg.depISO ? { depTime: leg.depISO } : {}),
      ...(leg.arrISO ? { arrTime: leg.arrISO } : {}),
      from: leg.from || session.origin || "出发地",
      to: leg.to || session.destination || "目的地",
    });
  }
  if (pickTransport?.inbound) {
    const leg = pickTransport.inbound;
    transferSegs.push({
      type: pickTransport.mode,
      role: "departure",
      no: pickTransport.no ?? "",
      ...(leg.depISO ? { depTime: leg.depISO } : {}),
      ...(leg.arrISO ? { arrTime: leg.arrISO } : {}),
      from: leg.from || session.destination || "目的地",
      to: leg.to || session.origin || "出发地",
    });
  }
  const selectedTransport =
    pickTransport && pickTransport.amount != null
      ? (() => {
          const kind = pickTransport.mode === "flight" ? "往返机票" : "往返火车票";
          return {
            mode: pickTransport.mode,
            amount: pickTransport.amount,
            label: pickTransport.no ? `${kind}（${pickTransport.no}）` : kind,
            ...(pickTransport.viaHub ? { viaHub: pickTransport.viaHub } : {}),
          };
        })()
      : undefined;
  const result = await service.generateItinerary({
    input,
    destination: session.destination,
    days: effectiveDays(session) ?? undefined,
    preferences: preferencesOf(session),
    // 结构化槽位：勾选 + 自选补充都真正进入规划（wishlist 会定向补搜并置顶）
    ...(wish.view.length ? { wishlist: wish.view } : {}),
    ...(stayWish.length ? { stayWishlist: stayWish } : {}),
    ...(wish.food.length ? { foodWishlist: wish.food } : {}),
    ...(party ? { party } : {}),
    ...(session.origin ? { origin: session.origin } : {}),
    ...(session.origin && session.originSource === "located" && session.locatedOrigin
      ? { originRegion: session.locatedOrigin.region || undefined, originSource: "located" as const }
      : {}),
    ...(session.startDate ? { startDate: session.startDate } : {}),
    ...(transferSegs.length ? { transfers: transferSegs } : {}),
    ...(selectedTransport ? { selectedTransport } : {}),
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
      ...(result.verification ? { verification: result.verification } : {}),
      ...(result.wishlistMissed?.length ? { wishlistMissed: result.wishlistMissed } : {}),
      slots: {
        ...(session.origin ? { origin: session.origin } : {}),
        ...(session.originSource === "located" && session.origin ? { sources: { origin: "located" } } : {}),
        ...(session.startDate ? { startDate: session.startDate } : {}),
        ...(party ? { party } : {}),
        ...(result.preferences?.diningStyle
          ? { diningStyle: result.preferences.diningStyle }
          : {}),
        ...(result.preferences?.hotelFocus
          ? { hotelFocus: result.preferences.hotelFocus }
          : {}),
        ...(result.preferences?.hotelFocusRef
          ? { hotelFocusRef: result.preferences.hotelFocusRef }
          : {}),
        ...(wish.view.length ? { wishlist: wish.view } : {}),
        ...(wish.food.length ? { foodWishlist: wish.food } : {}),
      },
      days: result.days.map((day) => ({
        date: day.date ?? "",
        items: day.items.map((item) => ({
          itemId: item.itemId,
          poiId: item.poiId,
          type: item.type,
          name: item.name,
          startTime: item.startTime ?? item.name,
          endTime: item.endTime,
          latitude: item.latitude,
          longitude: item.longitude,
          address: item.address ?? "",
          phone: item.phone,
          rating: item.rating,
          openingHours: item.openingHours,
          tags: item.tags,
          priceInfo: item.priceInfo ?? "",
          description: item.description ?? "",
          bookingNote: item.bookingNote,
          why: item.why,
          photoTip: item.photoTip,
          pitfall: item.pitfall,
          tips: item.tips,
          images: item.images,
          splatUrl: item.splatUrl,
          transportFromPrev: item.transportFromPrev,
          visitDuration: item.visitDuration,
        })),
      })),
    });
  }
  const verification = buildVerification(result);
  const draft: PlanSessionDraft = {
    planId,
    title: result.title || `${result.destination}行程`,
    destination: result.destination,
    startDate: result.startDate ?? "",
    endDate: result.endDate ?? "",
    days: buildDraftDays(result),
    ...(result.pricingSummary?.totalFinal != null
      ? { totalCost: result.pricingSummary.totalFinal }
      : {}),
    ...(verification ? { verification } : {}),
    ...(result.wishlistMissed?.length ? { wishlistMissed: result.wishlistMissed } : {}),
  };
  const budget = buildBudget(result, session);
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

const guideSelectSchema = z.object({
  view: z.array(z.string().min(1).max(40)).max(20).optional(),
  stay: z.array(z.string().min(1).max(40)).max(20).optional(),
  food: z.array(z.string().min(1).max(40)).max(20).optional(),
  /** 「全部交给你」：按推荐度代选 */
  delegate: z.boolean().optional(),
});

/** 筛选后的自选补充：全部字段可空（用户直接跳过也合法）。 */
const extrasSchema = z.object({
  view: z.array(z.string().min(1).max(40)).max(12).optional(),
  stay: z.array(z.string().min(1).max(40)).max(12).optional(),
  food: z.array(z.string().min(1).max(40)).max(12).optional(),
  note: z.string().max(200).optional(),
});

/** 预订选择卡提交：大交通/酒店各至多选一项，也可全不选（不订就不进预算）。 */
const bookingSchema = z.object({
  transportKey: z.string().min(1).max(8).optional(),
  hotelKey: z.string().min(1).max(8).optional(),
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
 *   POST /travel/plan-session/:id/guide {view?,stay?,food?,delegate?} 提交筛选卡勾选
 *   POST /travel/plan-session/:id/generate   真实生成（10~120s，客户端显示 typing）
 *   GET   /travel/plan-sessions        历史会话列表（规划界面的历史对话入口）
 *   GET   /travel/plan-session/:id      会话状态 + history（刷新恢复 / 继续上次规划）
 */
export function registerTravelPlanSessionRoutes(
  app: FastifyInstance,
  deps: { travelPlanningService?: PlanningService; locationCoordinator?: LocationCoordinator },
): void {
  // 回填/主动定位需要 coordinator（runTurn 等深处拿不到 deps），注册期绑定一次
  bindPlanSessionLocationCoordinator(deps.locationCoordinator ?? null);
  app.get("/travel/plan-session/_meta", async () => ({
    domain: "travel-plan-session",
    endpoints: [
      "POST   /travel/plan-session            {message} 一句话发起规划会话",
      "POST   /travel/plan-session/:id/turn   {message} 或 {cardId,values,note?} 追加一轮（每轮至多一张问题卡，题目与选项由 LLM 编排器生成）",
      "POST   /travel/plan-session/:id/guide  {view?,stay?,food?,delegate?} 提交筛选卡勾选（景点→住宿→美食三段依次勾选）",
      "POST   /travel/plan-session/:id/extras {view?,stay?,food?,note?} 提交筛选后的自选补充（可空）",
      "POST   /travel/plan-session/:id/booking {transportKey?,hotelKey?} 提交预订选择卡（实时机票/高铁/酒店，可全不选=先不订）",
      "POST   /travel/plan-session/:id/generate   信息齐后真实生成并返回预算明细（待确认）",
      "POST   /travel/plan-session/:id/approve    用户确认预算后下发最终草案",
      "GET    /travel/plan-session/:id        会话状态 + history + dossier + resumeCard（刷新恢复 / 继续上次规划）",
      "GET    /travel/plan-sessions?limit=30  历史规划会话列表（按最近更新排序，供客户端「历史对话」入口）",
    ],
    note: "会话落盘 data/travel-plan-sessions/{id}.json：内存 2h 清出可恢复，磁盘 30 天过期；行程本体由 travelPlanStore 冷层承担",
  }));

  // 历史规划会话列表（旅游界面「规划」tab 的历史对话入口）
  app.get("/travel/plan-sessions", async (request) => {
    const query = (request.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
    pruneSessions();
    const list: Array<{
      id: string;
      createdAt: number;
      updatedAt: number;
      destination: string | null;
      days: number | null;
      startDate: string | null;
      endDate: string | null;
      originalMessage: string;
      state: string;
      turnCount: number;
      lastUserMessage: string;
    }> = [];
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
          if (!f.endsWith(".json")) continue;
          try {
            const parsed = JSON.parse(
              fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"),
            ) as PlanSession;
            if (!parsed?.id || !Array.isArray(parsed.history)) continue;
            const lastUser = [...parsed.history].reverse().find((h) => h.role === "user");
            list.push({
              id: parsed.id,
              createdAt: parsed.createdAt,
              updatedAt: parsed.updatedAt,
              destination: parsed.destination ?? null,
              days: effectiveDays(parsed),
              startDate: parsed.startDate ?? null,
              endDate: parsed.endDate ?? null,
              originalMessage: parsed.originalMessage,
              state: sessionStateLabel(parsed),
              turnCount: parsed.history.length,
              lastUserMessage: lastUser?.content ?? parsed.originalMessage,
            });
          } catch {
            // 单个损坏文件跳过，不挡列表
          }
        }
      }
    } catch (err) {
      console.error("[travel-plan-session] list failed:", err);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, sessions: list.slice(0, limit) };
  });

  // 一句话发起
  app.post("/travel/plan-session", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const body = startSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: body.error.flatten() });
    }
    pruneSessions();
    const message = body.data.message.trim();
    // 出发地按定位兜底（2026-10-26）：plan-session 是独立 HTTP 会话、没有 actorId，
    // 这里被动读 LocationCoordinator 最近一次定位缓存（个人 agent 单用户语义，
    // 多端在线取最新上报），逆地理出城市存会话——编排器与回填都据此用定位
    // 出发地，不再反问「从哪个城市出发」。只读缓存，绝不向客户端要 GPS。
    let locatedOrigin: PlanSession["locatedOrigin"];
    if (deps.locationCoordinator) {
      const latest = deps.locationCoordinator.getLatest();
      if (latest) {
        const resolved = await resolveOriginFromLocation(latest.payload).catch(() => null);
        if (resolved) {
          locatedOrigin = { ...resolved, locatedAt: latest.at };
          console.log(
            `[travel-plan-session] 出发地按定位兜底：${resolved.city}（${resolved.region || "未知省份"}，` +
              `定位于 ${Math.round((Date.now() - latest.at) / 60_000)} 分钟前）`,
          );
        }
      }
    }
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
      guideSent: false,
      ...(locatedOrigin ? { locatedOrigin } : {}),
    };
    sessions.set(session.id, session);
    // 发起即落盘：哪怕首轮编排失败/进程中断，会话也已留痕可恢复
    saveSession(session);
    const turn = await runTurn(session, deps.travelPlanningService);
    session.updatedAt = Date.now();
    saveSession(session);
    return turn;
  });

  // 继续对话 / 点选回传
  app.post<{ Params: { id: string } }>("/travel/plan-session/:id/turn", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();

    const asChoice = choiceTurnSchema.safeParse(request.body);
    if (asChoice.success) {
      const { cardId, values, note } = asChoice.data;
      recordChoiceAnswer(session, cardId, values, note);
      const turn = await runTurn(session, deps.travelPlanningService);
      session.updatedAt = Date.now();
      saveSession(session);
      return turn;
    }

    const asMessage = messageTurnSchema.safeParse(request.body);
    if (asMessage.success) {
      const message = asMessage.data.message.trim();
      session.history.push({ role: "user", content: message.slice(0, 600) });
      // 补充阶段：用户不用卡、直接说「还想加 XX」也照收（不走编排器，避免又把话题拉回追问）。
      if (session.awaitingExtras) {
        const skip = /^(没有|没了|不用|不补|就这样|直接|开始|算吧|可以了|没有其他)/.test(message);
        const added = skip
          ? []
          : recordExtras(session, {
              view: extractWishlist(message, session.destination),
              food: extractFoodWishlist(message),
              note: message,
            });
        session.awaitingExtras = false;
        session.ready = true;
        const say =
          added.length > 0
            ? `加上 ${added.slice(0, 6).join("、")}，我去核实时价、排行程和预算。`
            : "好，就按勾选的来，我先算一版实时预算。";
        session.history.push({ role: "assistant", content: say });
        session.updatedAt = Date.now();
        saveSession(session);
        return {
          ok: true,
          sessionId: session.id,
          state: "ready",
          say,
          cards: [] as PlanSessionCard[],
          draft: null,
          budget: null,
          dossier: buildDossier(session, "ready"),
        } satisfies PlanSessionTurn;
      }
      const turn = await runTurn(session, deps.travelPlanningService);
      session.updatedAt = Date.now();
      saveSession(session);
      return turn;
    }
    return reply.code(400).send({ ok: false, error: "body 需为 {message} 或 {cardId,values,note?}" });
  });

  // 筛选卡确认（分段）：每段勾选当即记账，最后一段勾完才进入补心愿。
  app.post<{ Params: { id: string } }>(
    "/travel/plan-session/:id/guide",
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
      }
      const body = guideSelectSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      if (!session.guide) {
        return reply.code(409).send({ ok: false, error: "候选已失效，请重新发起规划" });
      }
      const stage = pendingGuideStage(session);
      if (!stage) {
        return reply.code(409).send({ ok: false, error: "筛选已完成，继续后面的步骤即可" });
      }
      session.updatedAt = Date.now();
      const allowed = (key: "view" | "stay" | "food"): Set<string> =>
        new Set(session.guide!.cats.find((c) => c.key === key)?.items.map((i) => i.name) ?? []);
      const pick = (key: "view" | "stay" | "food", list?: string[]): string[] =>
        (list ?? []).filter((n) => allowed(key).has(n)).slice(0, 20);
      const merged = (): { view: string[]; stay: string[]; food: string[] } => ({
        view: session.guideSelections?.view ?? [],
        stay: session.guideSelections?.stay ?? [],
        food: session.guideSelections?.food ?? [],
      });

      if (body.data.delegate) {
        // 「全部交给你」：剩余各段按推荐序代选（景点3/住宿2/美食2），直接进补心愿。
        const topN: Record<"view" | "stay" | "food", number> = { view: 3, stay: 2, food: 2 };
        const selections = merged();
        for (const key of GUIDE_ORDER) {
          if (selections[key].length > 0) continue;
          const cat = session.guide.cats.find((c) => c.key === key);
          if (cat && cat.items.length > 0) {
            selections[key] = cat.items.slice(0, topN[key]).map((i) => i.name);
          }
        }
        return finalizeGuideTurn(session, selections, true);
      }

      const picks = pick(stage, body.data[stage]);
      if (picks.length === 0) {
        return reply
          .code(400)
          .send({ ok: false, error: `至少勾选一处${GUIDE_SHORT_LABELS[stage]}，或选择「全部交给你」` });
      }
      session.guideSelections = { ...merged(), [stage]: picks };
      session.history.push({
        role: "user",
        content: `（筛选·${GUIDE_SHORT_LABELS[stage]}）${picks.join("、")}`,
      });
      const next = pendingGuideStage(session);
      if (next) {
        const pickedSay = picks.slice(0, 6).join("、");
        const say = `${GUIDE_SHORT_LABELS[stage]}就按这几处：${pickedSay}。${GUIDE_STAGE_INVITE[next]}`;
        session.history.push({ role: "assistant", content: say });
        saveSession(session);
        return {
          ok: true,
          sessionId: session.id,
          state: "guide_ready",
          say,
          cards: [guideCardForStage(session, next)!],
          draft: null,
          budget: null,
          dossier: buildDossier(session, "guide_ready"),
        } satisfies PlanSessionTurn;
      }
      return finalizeGuideTurn(session, session.guideSelections!, true);
    },
  );

  /**
   * 筛选后的自选补充：{view?,stay?,food?,note?}，全部可空。
   * 名字并入心愿清单，note 进入规划输入（可由 extractPreferences 识别附近/落位等诉求）。
   */
  app.post<{ Params: { id: string } }>(
    "/travel/plan-session/:id/extras",
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
      }
      if (!session.guideSelections) {
        return reply
          .code(409)
          .send({ ok: false, error: "还没完成筛选，先勾选必玩/住宿/美食" });
      }
      const body = extrasSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      session.updatedAt = Date.now();
      const note = body.data.note?.trim() ?? "";
      const added = recordExtras(session, {
        view: body.data.view,
        stay: body.data.stay,
        food: body.data.food,
        note: note || undefined,
      });
      session.awaitingExtras = false;
      session.ready = true;
      if (added.length > 0 || note) {
        session.history.push({
          role: "user",
          content: `（补充心愿）${[...added, note].filter(Boolean).join("；")}`.slice(0, 200),
        });
      }
      const say =
        added.length > 0
          ? `加上 ${added.slice(0, 6).join("、")}，我去核实时价、排行程和预算。`
          : note
            ? "记下了，我按这个偏好去排，先算一版实时预算。"
            : "好，就按勾选的来，我先算一版实时预算。";
      session.history.push({ role: "assistant", content: say });
      saveSession(session);
      return {
        ok: true,
        sessionId: session.id,
        state: "ready",
        say,
        cards: [] as PlanSessionCard[],
        draft: null,
        budget: null,
        dossier: buildDossier(session, "ready"),
      } satisfies PlanSessionTurn;
    },
  );

  // 预订选择卡提交：{transportKey?,hotelKey?}（均可空 = 先不订）。
  // 选择落进 session.booking.selection，generate 时据此落实预算与行程交通段。
  app.post<{ Params: { id: string } }>(
    "/travel/plan-session/:id/booking",
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
      }
      const body = bookingSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      if (!session.booking || !session.awaitingBooking) {
        return reply.code(409).send({ ok: false, error: "当前没有待确认的预订选择" });
      }
      const { transportKey, hotelKey } = body.data;
      if (transportKey && !session.booking.transports.some((t) => t.key === transportKey)) {
        return reply.code(400).send({ ok: false, error: "所选大交通不在候选项里，请刷新后重选" });
      }
      if (hotelKey && !session.booking.hotels.some((h) => h.key === hotelKey)) {
        return reply.code(400).send({ ok: false, error: "所选酒店不在候选项里，请刷新后重选" });
      }
      session.updatedAt = Date.now();
      session.booking.selection = {
        ...(transportKey ? { transportKey } : {}),
        ...(hotelKey ? { hotelKey } : {}),
      };
      session.awaitingBooking = false;
      session.ready = true;
      const t = transportKey
        ? session.booking.transports.find((x) => x.key === transportKey)
        : undefined;
      const h = hotelKey ? session.booking.hotels.find((x) => x.key === hotelKey) : undefined;
      const picked: string[] = [];
      if (t) picked.push(`大交通：${t.mode === "flight" ? "航班" : "车次"} ${t.no ?? ""}`.trim());
      if (h) picked.push(`住宿：${h.name}`);
      session.history.push({
        role: "user",
        content: picked.length > 0 ? `（预订）${picked.join("；")}` : "（预订）先不订，按参考价排",
      });
      const say = bookingSayOf(session);
      session.history.push({ role: "assistant", content: say });
      saveSession(session);
      // 预订选择落定 → 进「选一选」：现做景点/住宿/美食候选，下发第一段筛选卡。
      // 候选构建失败/服务缺失时回 ready 兜底，流程不卡死。
      const service = deps.travelPlanningService;
      if (service) {
        try {
          const built = await buildGuideCandidates(session, service);
          const stage = built ? pendingGuideStage(session) : null;
          const guideCard = stage ? guideCardForStage(session, stage) : null;
          if (guideCard && stage) {
            session.guideSent = true;
            const guideSay = `班次和住宿记下了。${session.destination}的候选整理好了，住宿和美食后面接着挑。${GUIDE_STAGE_INVITE[stage]}`;
            session.history.push({ role: "assistant", content: guideSay });
            session.updatedAt = Date.now();
            saveSession(session);
            return {
              ok: true,
              sessionId: session.id,
              state: "guide_ready",
              say: guideSay,
              cards: [guideCard],
              draft: null,
              budget: null,
              dossier: buildDossier(session, "guide_ready"),
            } satisfies PlanSessionTurn;
          }
        } catch (err) {
          console.warn(
            "[travel-plan-session] 预订提交后筛选候选构建失败，直接生成:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      session.updatedAt = Date.now();
      saveSession(session);
      return {
        ok: true,
        sessionId: session.id,
        state: "ready",
        say,
        cards: [] as PlanSessionCard[],
        draft: null,
        budget: null,
        dossier: buildDossier(session, "ready"),
      } satisfies PlanSessionTurn;
    },
  );

  // 真实生成（与聊天 travel.plan-itinerary 同一引擎与冷层）
  app.post<{ Params: { id: string } }>("/travel/plan-session/:id/generate", async (request, reply) => {
    if (!requireService(deps, reply)) return;
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();
    if (!session.destination) {
      return reply.code(400).send({ ok: false, error: "还没确定目的地，先告诉我想去哪儿" });
    }
    try {
      const { budget, draft } = await generateDraft(session, deps.travelPlanningService!);
      session.updatedAt = Date.now();
      saveSession(session);
      const total = budget.total > 0 ? `¥${budget.total.toLocaleString("zh-CN")}` : "待核价";
      const transportItem = budget.items.find((i) => i.key === "transport");
      const transportAmount = transportItem?.amount;
      // 无直飞按枢纽转机计价时，say 里直接点明（「经贵阳转机」），明细在预算卡 note
      const viaHub =
        transportAmount != null
          ? /转机（经(.+?)）/.exec(transportItem?.label ?? "")?.[1]
          : undefined;
      const transportNote = transportAmount
        ? viaHub
          ? `含往返大交通（经${viaHub}转机）`
          : "含往返大交通"
        : "大交通未含";
      const pendingNote = budget.pendingItems ? `，${budget.pendingItems} 项待核价未计入` : "";
      const verifyNote = draft.verification?.summary
        ? `；${draft.verification.summary}已列进最终方案`
        : "";
      return {
        ok: true,
        sessionId: session.id,
        state: "budget_ready",
        say: `预算算好了：住宿/门票/餐饮${transportAmount ? "/交通" : ""}合计约 ${total}（${transportNote}${pendingNote}）${verifyNote}。确认后我再出最终方案。`,
        cards: [] as PlanSessionCard[],
        draft: null,
        budget,
        verification: draft.verification ?? null,
        dossier: buildDossier(session, "budget_ready"),
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
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期，请重新发起" });
    }
    session.updatedAt = Date.now();
    if (!session.draft || !session.budget) {
      return reply.code(400).send({ ok: false, error: "预算还没算好，先完成信息对齐" });
    }
    session.budgetApproved = true;
    saveSession(session);
    return {
      ok: true,
      sessionId: session.id,
      state: "generated",
      say: "方案出好了：每站的时刻、两站间距离、开放与预约提醒都写在卡片里；想改随时告诉我。",
      cards: [] as PlanSessionCard[],
      draft: session.draft,
      // 预算卡已在流程里展示过，这里只下发草案，避免客户端重复挂预算卡
      budget: null,
      verification: session.draft.verification ?? null,
      dossier: buildDossier(session, "generated"),
    } satisfies PlanSessionTurn;
  });

  // 会话状态（客户端刷新恢复 / 继续上次规划）：带 history 让客户端重建对话流，
  // dossier 整份快照、resumeCard 是当前挂起卡（choice 卡选项不落盘、重建不了时为 null）
  app.get<{ Params: { id: string } }>("/travel/plan-session/:id", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ ok: false, error: "会话不存在或已过期" });
    }
    const state = sessionStateLabel(session);
    return {
      ok: true,
      sessionId: session.id,
      state,
      destination: session.destination ?? null,
      origin: session.origin ?? null,
      days: effectiveDays(session),
      answers: session.answers,
      guideSelections: session.guideSelections ?? null,
      extras: session.extras ?? null,
      draft: session.draft,
      budget: session.budget ?? null,
      history: session.history,
      dossier: buildDossier(session, state),
      resumeCard: resumeCardFor(session),
    };
  });
}
