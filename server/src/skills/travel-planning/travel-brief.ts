/**
 * 规划前置简报（travel 主线 F0/F1：brief 槽位 + 溯源 + 一次偏好问询）
 *
 * 设计约束（2026-10-24 用户拍板）：
 *   - **默认直出**：信息不足不阻塞规划。缺口按「推断 → 画像 → 目的地常识 → 默认」
 *     补齐并如实标注来源，行程照出；只有目的地本身缺失才谈不上下单。
 *   - **问到点上、只问一次**：规划回执附一张简报卡，把「我按哪些假设排的」摊开，
 *     并问用户有没有想去的景点/偏好的饭店——点一下下一轮就排进这版行程。
 *   - **溯源诚实**：每个槽位带 provenance（stated/asked/profile/inferred/default/
 *     unknown）。卡片只展示「不是你亲口说的」那几行，用户一眼知道该复核哪儿。
 *
 * 纯函数模块：不触网、不读存储、无状态，可独立单测。
 */
import type { TripPreferences } from "./travel-planning-service.js";
import { formatDateLabel, isValidISODate } from "./travel-date.js";

export type Provenance =
  | "stated" // 用户原话/明确回答过
  | "asked" // 简报卡追问后用户点的
  | "profile" // 用户画像长期偏好
  | "inferred" // 目的地常识/上下文推断
  | "located" // 按用户 GPS 定位补的默认值（出发地专用，如实标注可改）
  | "default" // 系统默认兜的
  | "unknown"; // 真的不知道

export type SlotKey =
  | "destination"
  | "days"
  | "origin"
  | "startDate"
  | "party"
  | "budget"
  | "hotelFocus"
  | "wishlist"
  | "foodWishlist"
  | "diningStyle";

export interface TravelBrief {
  destination: string | null;
  days: number | null;
  origin: string | null;
  startDate: string | null;
  /** 同行人一句话（'带孩子、带老人' / '一个人' / '2 位成人'） */
  party: string | null;
  budget: "low" | "mid" | "high" | null;
  /** 住宿落位诉求（'靠海' / '近机场' / '近车站' / '近人民公园' / '市中心'） */
  hotelFocus: string | null;
  wishlist: string[];
  foodWishlist: string[];
  diningStyle: "local" | "trendy" | "mixed" | null;
  provenance: Record<SlotKey, Provenance>;
}

const EMPTY: Record<SlotKey, Provenance> = {
  destination: "stated",
  days: "default",
  origin: "unknown",
  startDate: "unknown",
  party: "default",
  budget: "default",
  hotelFocus: "unknown",
  wishlist: "unknown",
  foodWishlist: "unknown",
  diningStyle: "unknown",
};

/** TripPreferences.sources 标签 → provenance（与 intent-parser 同一分层口径，不另起一套） */
function prov(tag: string | undefined): Provenance {
  switch (tag) {
    case "user":
      return "stated";
    case "asked":
      return "asked";
    case "profile":
      return "profile";
    case "destination":
      return "inferred";
    case "located":
      return "located";
    case "default":
      return "default";
    default:
      return "unknown";
  }
}

const BUDGET_LABEL: Record<"low" | "mid" | "high", string> = {
  low: "省钱档",
  mid: "舒适档",
  high: "高端档",
};

const DINING_LABEL: Record<"local" | "trendy" | "mixed", string> = {
  local: "本地人常去的馆子",
  trendy: "网红打卡店",
  mixed: "本地与网红搭配",
};

const PARTY_LABEL: Record<NonNullable<TripPreferences["party"]>, string> = {
  solo: "一个人",
  solo_female: "女生独自",
  couple: "情侣/两人",
  family: "家庭同行",
  friends: "朋友结伴",
};

const HOTEL_FOCUS_LABEL: Record<NonNullable<TripPreferences["hotelFocus"]>, string> = {
  seaside: "靠海",
  airport: "离机场近",
  station: "离车站近",
  attraction: "离景点近",
  downtown: "市中心",
};

/**
 * buildBrief 需要的偏好切片（TripPreferences 的结构子集）。
 * 放宽成结构化切片是为了让冷层存档（StoredTravelPlan.slots）也能直接回读成简报——
 * 桌面端重开行程页时讲的是同一份假设，不是重新解析一遍原文再猜一次。
 */
export type BriefSourceTag = "user" | "destination" | "default" | "profile" | "asked" | "located";
export type BriefPrefsLike = {
  budget?: "low" | "mid" | "high";
  origin?: string;
  startDate?: string;
  party?: TripPreferences["party"];
  diningStyle?: TripPreferences["diningStyle"];
  hotelFocus?: TripPreferences["hotelFocus"];
  hotelFocusRef?: string;
  wishlist?: string[];
  foodWishlist?: string[];
  sources: Partial<Record<string, BriefSourceTag>>;
};

export interface BuildBriefInput {
  /** extractDestination 的结果（服务侧持有，TripPreferences 里没有） */
  destination?: string;
  days?: number;
  /** 已解析的结构化偏好 */
  prefs?: BriefPrefsLike;
  /** 简报卡回传 / 工具显式入参（优先级最高） */
  explicit?: {
    origin?: string;
    startDate?: string;
    party?: TripPreferences["party"];
    wishlist?: string[];
    foodWishlist?: string[];
  };
  /** 服务端兜底出的出发日（原文没说时用，标 default 让卡片如实说「先这么定」） */
  inferredStartDate?: string;
  /** 画像里的吃饭倾向（原文/派生都没有时兜底） */
  profileDiningStyle?: "local" | "trendy";
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v.length >= 2 && v.length <= 24 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 8);
}

/**
 * 汇总简报槽位：explicit（用户答过）> prefs（原文抽取）> 画像/默认。
 * 优先级与 intent-parser 的分层一致，本函数只做「槽位 + 溯源」的第二视图，
 * 不重复做任何正则解析。
 */
export function buildBrief(input: BuildBriefInput = {}): TravelBrief {
  const { prefs, explicit } = input;
  const brief: TravelBrief = {
    destination: input.destination ?? null,
    days: input.days ?? null,
    origin: null,
    startDate: null,
    party: null,
    budget: prefs?.budget ?? null,
    hotelFocus: null,
    wishlist: [],
    foodWishlist: [],
    diningStyle: prefs?.diningStyle ?? input.profileDiningStyle ?? null,
    provenance: { ...EMPTY },
  };
  if (prefs) {
    brief.provenance.budget = prov(prefs.sources.budget);
    brief.provenance.diningStyle = prefs.diningStyle
      ? prov(prefs.sources.diningStyle)
      : input.profileDiningStyle
        ? "profile"
        : "unknown";
  } else if (input.profileDiningStyle) {
    brief.diningStyle = input.profileDiningStyle;
    brief.provenance.diningStyle = "profile";
  }

  if (input.days != null) brief.provenance.days = "stated";

  const originExplicit = explicit?.origin?.trim();
  brief.origin = originExplicit || prefs?.origin || null;
  // 溯源优先读落盘的 sources.origin（located=按定位补的默认值必须如实呈现，
  // 不能冒充「stated」）；无标注时维持旧口径「prefs 里有就当用户说过」
  brief.provenance.origin = originExplicit
    ? "asked"
    : prefs?.origin
      ? prefs.sources.origin
        ? prov(prefs.sources.origin)
        : "stated"
      : "unknown";

  const startExplicit = explicit?.startDate?.trim();
  if (startExplicit && isValidISODate(startExplicit)) {
    brief.startDate = startExplicit;
    brief.provenance.startDate = "asked";
  } else if (prefs?.startDate && isValidISODate(prefs.startDate)) {
    brief.startDate = prefs.startDate;
    brief.provenance.startDate = "stated";
  } else if (input.inferredStartDate) {
    brief.startDate = input.inferredStartDate;
    brief.provenance.startDate = "default";
  } else {
    brief.provenance.startDate = "unknown";
  }

  const partyExplicit = explicit?.party;
  const party = partyExplicit || prefs?.party;
  if (party) {
    brief.party = PARTY_LABEL[party];
    brief.provenance.party = partyExplicit ? "asked" : prov(prefs?.sources.party);
  }

  if (prefs?.hotelFocus) {
    const base = HOTEL_FOCUS_LABEL[prefs.hotelFocus];
    brief.hotelFocus = prefs.hotelFocus === "attraction" && prefs.hotelFocusRef
      ? `离${prefs.hotelFocusRef}近`
      : base;
    brief.provenance.hotelFocus = prov(prefs.sources.hotelFocus);
  }

  const wlExplicit = names(explicit?.wishlist);
  const wl = wlExplicit.length > 0 ? wlExplicit : names(prefs?.wishlist);
  if (wl.length > 0) {
    brief.wishlist = wl;
    brief.provenance.wishlist = wlExplicit.length > 0 ? "asked" : "stated";
  }
  const fwExplicit = names(explicit?.foodWishlist);
  const fw = fwExplicit.length > 0 ? fwExplicit : names(prefs?.foodWishlist);
  if (fw.length > 0) {
    brief.foodWishlist = fw;
    brief.provenance.foodWishlist = fwExplicit.length > 0 ? "asked" : "stated";
  }
  return brief;
}

/** 冷层存档里简报需要的那几行（StoredTravelPlan 的结构切片，避免依赖 store 类型） */
export interface StoredBriefSource {
  destination?: string;
  startDate?: string;
  endDate?: string;
  budgetTier?: "low" | "mid" | "high";
  slots?: {
    origin?: string;
    startDate?: string;
    party?: string;
    diningStyle?: string;
    hotelFocus?: string;
    hotelFocusRef?: string;
    wishlist?: string[];
    foodWishlist?: string[];
    sources?: Record<string, string>;
  };
  days?: Array<{ date?: string }>;
}

/**
 * 冷层存档 → 简报（回读路径）。天数按 days 数组长度、出发日按存档 startDate，
 * 槽位来源直接用落盘时记下的 sources——不做任何再解析，读到的就是当初排的那版。
 */
export function briefFromStoredPlan(plan: StoredBriefSource): TravelBrief {
  const slots = plan.slots ?? {};
  const sources: Partial<Record<string, BriefSourceTag>> = {};
  for (const [k, v] of Object.entries(slots.sources ?? {})) {
    if (v === "user" || v === "asked" || v === "profile" || v === "destination" || v === "default" || v === "located") {
      sources[k] = v;
    }
  }
  const prefs: BriefPrefsLike = {
    ...(plan.budgetTier ? { budget: plan.budgetTier } : {}),
    ...(slots.origin ? { origin: slots.origin } : {}),
    ...(slots.startDate ? { startDate: slots.startDate } : {}),
    ...(slots.party as TripPreferences["party"] ? { party: slots.party as TripPreferences["party"] } : {}),
    ...(slots.diningStyle as TripPreferences["diningStyle"]
      ? { diningStyle: slots.diningStyle as TripPreferences["diningStyle"] }
      : {}),
    ...(slots.hotelFocus as TripPreferences["hotelFocus"]
      ? { hotelFocus: slots.hotelFocus as TripPreferences["hotelFocus"] }
      : {}),
    ...(slots.hotelFocusRef ? { hotelFocusRef: slots.hotelFocusRef } : {}),
    ...(slots.wishlist?.length ? { wishlist: slots.wishlist } : {}),
    ...(slots.foodWishlist?.length ? { foodWishlist: slots.foodWishlist } : {}),
    sources,
  };
  const dayCount = plan.days?.length ?? 0;
  const brief = buildBrief({
    destination: plan.destination,
    days: dayCount > 0 ? dayCount : undefined,
    prefs,
    inferredStartDate: dayCount > 0 && !slots.startDate ? plan.startDate : undefined,
  });
  // 冷层里的出发日是排程实际用的那个（可能是服务端兜底的今天）：
  // 原文没说过就按 default 呈现「先这么定，可改」，不冒充用户说的
  if (plan.startDate && brief.provenance.startDate === "unknown") {
    brief.startDate = plan.startDate;
    brief.provenance.startDate = "default";
  }
  return brief;
}

export interface AssumptionRow {
  key: SlotKey;
  label: string;
  value: string;
  provenance: Provenance;
}

const SUFFIX: Record<Provenance, string> = {
  stated: "",
  asked: "（你刚补的）",
  profile: "（按你的习惯）",
  inferred: "（按目的地常规）",
  located: "（按定位，可改）",
  default: "（先这么定，可改）",
  unknown: "",
};

/**
 * 假设清单：只列需要用户复核的行（provenance≠stated），最多 6 行。
 * 缺信息的行如实写「没提到」，由下面的 questions 承接成一次可点的追问。
 */
export function briefAssumptions(brief: TravelBrief): AssumptionRow[] {
  const rows: AssumptionRow[] = [];
  const push = (key: SlotKey, label: string, value: string): void => {
    rows.push({ key, label, value, provenance: brief.provenance[key] });
  };

  push(
    "startDate",
    "出发日",
    brief.startDate
      ? `${formatDateLabel(brief.startDate)}${SUFFIX[brief.provenance.startDate] ?? ""}`
      : `没提到${SUFFIX.unknown}`,
  );
  push(
    "origin",
    "出发地",
    brief.origin ? `${brief.origin}${SUFFIX[brief.provenance.origin] ?? ""}` : "没提到（先不排大交通）",
  );
  push("party", "同行人", `${brief.party ?? "2 位成人"}${SUFFIX[brief.provenance.party] ?? ""}`);
  if (brief.budget) push("budget", "预算", `${BUDGET_LABEL[brief.budget]}${SUFFIX[brief.provenance.budget] ?? ""}`);
  if (brief.hotelFocus) push("hotelFocus", "住宿落位", `${brief.hotelFocus}${SUFFIX[brief.provenance.hotelFocus] ?? ""}`);
  if (brief.diningStyle) {
    push("diningStyle", "吃饭", `${DINING_LABEL[brief.diningStyle]}${SUFFIX[brief.provenance.diningStyle] ?? ""}`);
  }
  if (brief.wishlist.length > 0) push("wishlist", "心愿点", brief.wishlist.join("、"));
  if (brief.foodWishlist.length > 0) push("foodWishlist", "点名餐厅", brief.foodWishlist.join("、"));

  return rows.filter((r) => r.provenance !== "stated").slice(0, 6);
}

export interface BriefQuestion {
  id: "wishlist" | "foodWishlist" | "origin" | "startDate";
  title: string;
  hint: string;
}

/** 一次问完的偏好问询（默认 2 条，非阻塞：不点也照常出行程） */
export function briefOpenQuestions(brief: TravelBrief, max = 2): BriefQuestion[] {
  const qs: BriefQuestion[] = [];
  if (brief.wishlist.length === 0) {
    qs.push({ id: "wishlist", title: "有你一定要去的景点吗？", hint: "报名字，我把它钉进日程" });
  }
  if (brief.foodWishlist.length === 0) {
    qs.push({ id: "foodWishlist", title: "有想吃的餐厅吗？", hint: "没说就按本地＋网红搭配选店" });
  }
  if (!brief.origin) qs.push({ id: "origin", title: "从哪个城市出发？", hint: "决定自驾/高铁/飞机怎么排" });
  if (!brief.startDate) qs.push({ id: "startDate", title: "哪天走？", hint: "影响逐日天气与需预约场馆的放票日" });
  return qs.slice(0, max);
}

export interface BriefAnswers {
  origin?: string;
  startDate?: string;
  party?: TripPreferences["party"];
  wishlist?: string[];
  foodWishlist?: string[];
}

/** 简报卡/追问的回答并入简报（asked 层：覆盖推断与默认，不覆盖原话） */
export function applyBriefAnswers(brief: TravelBrief, answers: BriefAnswers): TravelBrief {
  const next: TravelBrief = { ...brief, provenance: { ...brief.provenance } };
  if (answers.origin?.trim() && brief.provenance.origin !== "stated") {
    next.origin = answers.origin.trim();
    next.provenance.origin = "asked";
  }
  if (answers.startDate && isValidISODate(answers.startDate) && brief.provenance.startDate !== "stated") {
    next.startDate = answers.startDate;
    next.provenance.startDate = "asked";
  }
  if (answers.party && brief.provenance.party !== "stated") {
    next.party = PARTY_LABEL[answers.party];
    next.provenance.party = "asked";
  }
  const wl = names(answers.wishlist);
  if (wl.length > 0) {
    next.wishlist = Array.from(new Set([...brief.wishlist, ...wl]));
    next.provenance.wishlist = "asked";
  }
  const fw = names(answers.foodWishlist);
  if (fw.length > 0) {
    next.foodWishlist = Array.from(new Set([...brief.foodWishlist, ...fw]));
    next.provenance.foodWishlist = "asked";
  }
  return next;
}

// ======================== 简报卡（确定性直出） ========================

export interface BriefCardInput {
  brief: TravelBrief;
  destination?: string;
  /** 候选池里有、但这版没排上的 POI：点一下即加入心愿（智能化而不是让用户想名字） */
  candidates?: Array<{ name: string; type?: string }>;
  /** 核实闸产出的问题（硬冲突/需预约），同卡随行展示 */
  issues?: Array<{ level: "block" | "warn" | "info"; message: string }>;
  /** 行程状态：未定稿时卡尾给一颗「满意了，按这个订」的定稿按钮 */
  status?: "draft" | "approved";
  /** 这一版的实付合计（价格透明的总账行；0/缺省不显示） */
  totalCost?: number;
}

export interface BriefCardPayload {
  title: string;
  items: Array<{ type: "check" | "warn" | "num"; text: string }>;
  footer: string;
  cardType: string;
  /** 卡型标识（cardType 留空走通用渲染，靠它做「本轮已附简报卡」去重） */
  cardKind: "travel_brief";
  actions: Array<{
    id: string;
    label: string;
    variant?: "primary" | "secondary" | "ghost";
    payload?: Record<string, unknown>;
  }>;
}

/**
 * 简报卡 = 假设摊开 + 核实提醒 + 一键补充。
 * 按钮 label 就是回传给模型的用户消息（本仓库无服务端 actionId 硬路由），
 * 所以每颗按钮都写成一句可以直接执行的话。
 */
export function buildBriefCardPayload(input: BriefCardInput): BriefCardPayload | null {
  const rows = briefAssumptions(input.brief);
  const issues = (input.issues ?? []).filter((i) => i.level !== "info" && i.message).slice(0, 4);
  const candidates = (input.candidates ?? [])
    .filter((c) => c.name && c.name.length >= 2 && c.name.length <= 20)
    .slice(0, 3);
  const questions = briefOpenQuestions(input.brief, 2);
  if (rows.length === 0 && issues.length === 0 && candidates.length === 0 && questions.length === 0) {
    return null;
  }

  const items: BriefCardPayload["items"] = [];
  const total = Number(input.totalCost);
  if (Number.isFinite(total) && total > 0) {
    items.push({ type: "num", text: `这一版预计 ¥${Math.round(total).toLocaleString("en-US")}` });
  }
  for (const r of rows) items.push({ type: "check", text: `${r.label}：${r.value}` });
  for (const it of issues) items.push({ type: it.level === "block" ? "warn" : "num", text: it.message });

  const actions: BriefCardPayload["actions"] = [];
  for (const c of candidates) {
    // 餐厅候选走吃饭槽位：点一下是「想吃这家」，不是「要去这个景点」
    const isFood = c.type === "restaurant" || c.type === "cafe" || c.type === "food";
    actions.push({
      id: `${isFood ? "foodWishlist" : "wishlist"}:${c.name}`,
      label: isFood ? `想吃「${c.name}」，排进吃饭` : `把「${c.name}」排进行程`,
      variant: "secondary",
      payload: isFood ? { foodWishlist: [c.name] } : { wishlist: [c.name] },
    });
  }
  // 满意门：定稿是「预订」的唯一入口，给一颗显式按钮（用户不必打字说「就这个」）
  if (input.status !== "approved") {
    actions.push({
      id: "plan:approve",
      label: "这版我满意了，就按这个订",
      variant: "primary",
      payload: { action: "approve_plan" },
    });
  }
  if (questions.some((q) => q.id === "wishlist")) {
    actions.push({
      id: "wishlist:ask",
      label: "我有想去的景点，报几个名字",
      variant: "ghost",
      payload: { slot: "wishlist" },
    });
  }
  if (questions.some((q) => q.id === "foodWishlist")) {
    actions.push({
      id: "food:ask",
      label: "我有想吃的餐厅，报几个名字",
      variant: "ghost",
      payload: { slot: "foodWishlist" },
    });
  }
  if (!input.brief.origin || !input.brief.startDate) {
    actions.push({
      id: "trip:ask",
      label: "补充出发地和出发日期",
      variant: "ghost",
      payload: { slot: "origin" },
    });
  }

  const dest = input.destination ?? input.brief.destination ?? "行程";
  const footer =
    issues.length > 0
      ? "提醒里的开放时间/预约规则以官方为准，出发前自己再确认一次。想改哪条直接说，或点下面的按钮——改满意了再谈预订。"
      : "想改哪条直接说，或点下面的按钮。改满意了再谈预订。";

  return {
    title: `这版怎么排的 · ${dest}`,
    items: items.slice(0, 8),
    footer,
    cardType: "",
    cardKind: "travel_brief",
    actions: actions.slice(0, 5),
  };
}
