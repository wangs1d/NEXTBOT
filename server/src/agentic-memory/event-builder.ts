/**
 * 事件记忆（L0）构造器：把一轮对话 + 工具轨迹压成一条确定性事件。
 *
 * 这里不调 LLM、不做语义改写——kind / status / entities / payload 全部由
 * 工具名、结果结构和固定正则推导，保证同一轮重复构造字节一致（幂等）。
 * 原文只留摘要（默认 500 字，脱敏后截断），完整原文仍在 turn-wal。
 */

import { redactSensitiveText } from "../utils/redact.js";
import { stripMarkersToPlainText } from "../services/reply-envelope.js";
import { getEventMaxToolTraces, getEventSummaryMaxChars } from "./env.js";

export type EventStatus = "ok" | "empty" | "failed" | "partial" | "invalid";

export type EventToolTrace = {
  toolName: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: Record<string, unknown>;
};

export type MemoryEventRecord = {
  id: string;
  actorId: string;
  sessionId: string | null;
  messageId: string | null;
  /** 事件发生时刻（本轮 ts） */
  eventTime: string;
  /** 入库时刻 */
  recordedAt: string;
  kind: string;
  status: EventStatus;
  userText: string;
  answerText: string;
  entities: string[];
  payload: Record<string, unknown>;
  refs: Record<string, unknown>;
  context: "main" | "notes";
};

export type TurnEventInput = {
  actorId: string;
  userText: string;
  assistantText: string;
  ts: string;
  sessionId?: string;
  messageId?: string;
  context?: "main" | "notes";
  toolTraces?: EventToolTrace[];
};

/** 工具名 → 事件 kind（有序匹配，首个命中生效）。新增业务域只加一行。 */
const KIND_RULES: Array<[RegExp, string]> = [
  [/^shopping\.compare\./, "price_compare"],
  [/^shopping\.order\./, "order"],
  [/^shopping\.suggest$/, "shopping_suggest"],
  [/^weather\./, "weather_query"],
  [/^calendar\.(create|update|delete|batch|move)/, "schedule_write"],
  [/^calendar\./, "schedule_query"],
  [/^task\./, "task_write"],
  [/^travel\.(plan|approve|edit|packing|departure|pickup)/, "travel_plan"],
  [/^travel\./, "travel_query"],
  [/^media\./, "media"],
  [/^(search_web|deep_search|web_search|search_images)$/, "web_search"],
  [/^clock\./, "clock_query"],
  [/^(email|sms)\./, "message"],
  [/^phone\./, "phone_call"],
  [/^(ride_hailing|ride)\./, "ride"],
  [/^health\./, "health"],
  [/^ledger\.|^finance\./, "finance"],
];

/** 元工具/支撑管线不改变「这轮做过什么」的判定（与 tool-loop 的实质工具同口径）。 */
const META_TOOLS = new Set<string>([
  "tool_discover",
  "tool_search",
  "tool.list",
  "tool.describe",
  "skill.list",
  "skill.load",
]);

export function isSubstantiveTool(toolName: string): boolean {
  return !META_TOOLS.has(toolName);
}

export function kindForTool(toolName: string): string {
  for (const [re, kind] of KIND_RULES) {
    if (re.test(toolName)) return kind;
  }
  const domain = toolName.split(".")[0];
  return domain ? `tool:${domain}` : "tool";
}

/** 结果里常见的「内容数组」键：非空即视为有实质产出。 */
const CONTENT_ARRAY_KEYS = [
  "products",
  "groups",
  "offers",
  "items",
  "results",
  "list",
  "tasks",
  "quotes",
  "data",
  "records",
  "watches",
  "matches",
  "posts",
];

/** ok=true 但没有任何内容 → empty（查过没结果也是事实，必须留下）。 */
function isEffectivelyEmpty(result: Record<string, unknown>): boolean {
  let sawArray = false;
  for (const key of CONTENT_ARRAY_KEYS) {
    const value = result[key];
    if (!Array.isArray(value)) continue;
    sawArray = true;
    if (value.length > 0) return false;
  }
  if (sawArray) return true;
  if (typeof result.count === "number") return result.count === 0;
  return false;
}

function deriveStatus(traces: EventToolTrace[]): EventStatus {
  const substantive = traces.filter((t) => isSubstantiveTool(t.toolName));
  if (substantive.length === 0) return "ok";
  const okTraces = substantive.filter((t) => t.ok);
  const failedCount = substantive.length - okTraces.length;
  const emptyCount = okTraces.filter((t) => isEffectivelyEmpty(t.result)).length;
  if (failedCount === substantive.length) return "failed";
  if (failedCount > 0) return "partial";
  if (emptyCount === substantive.length) return "empty";
  if (emptyCount > 0) return "partial";
  return "ok";
}

/** 主 kind：取第一条实质工具；纯闲聊轮为 chat_turn。 */
function deriveKind(traces: EventToolTrace[]): string {
  const substantive = traces.filter((t) => isSubstantiveTool(t.toolName));
  return substantive.length > 0 ? kindForTool(substantive[0].toolName) : "chat_turn";
}

/**
 * 3C 整机却报出两位数价格：几乎必然是配件/定金/非整机价。
 * 只用于给事件定性（status=invalid），比价卡展示仍按原结果走。
 */
const THINKING_DEVICE_RE = /手机|iPhone|iPad|MacBook|笔记本|电脑|显示器|耳机|相机|Pro\b|Max\b|Ultra\b/i;

export function looksLikeAccessoryPrice(query: unknown, price: unknown): boolean {
  if (typeof query !== "string") return false;
  if (typeof price !== "number" || !Number.isFinite(price)) return false;
  return price > 0 && price < 100 && THINKING_DEVICE_RE.test(query);
}

/** 比价轮的最低价是否可疑（仅在可比、有最低价时判定）。 */
function isSuspectPriceCompare(traces: EventToolTrace[]): boolean {
  const trace = traces.find(
    (t) => t.ok && isSubstantiveTool(t.toolName) && kindForTool(t.toolName) === "price_compare",
  );
  if (!trace) return false;
  const result = trace.result as Record<string, unknown>;
  if (result.bestIndex !== 0) return false;
  const best = result.bestOffer as Record<string, unknown> | null | undefined;
  const query = typeof result.query === "string" ? result.query : trace.input.query;
  return looksLikeAccessoryPrice(query, best?.priceCny);
}

const PLATFORM_LABELS: Record<string, string> = {
  taobao: "淘宝",
  tmall: "天猫",
  jd: "京东",
  pdd: "拼多多",
};

export type EventJournalEntry = {
  /** journal 行首的短标记（≤10 位 [\w-]）：固化时据此还原来源事件 id */
  token: string;
  content: string;
};

/**
 * 实质事件压成当天 journal 的一行（零 LLM）：与对话流水共用同一个未固化文件，
 * 夜间由既有 journal 固化链路统一进长期记忆，不再有独立的夜间事件 LLM 步骤。
 * 只覆盖结构化结果会丢失的域；其余事件原文已在 journal 的 U/A 行里。
 */
export function buildEventJournalEntry(event: MemoryEventRecord): EventJournalEntry | null {
  const content = describeEventOutcome(event);
  if (!content) return null;
  const key = event.id.slice(event.id.lastIndexOf(":") + 1);
  const token = /^[\w-]{1,8}$/.test(key) ? `e-${key}` : "";
  return { token, content };
}

/** 首个实质工具名（判断 create/delete 之类动作语义用）。 */
function primaryToolName(payload: Record<string, unknown>): string {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return "";
  for (const item of tools) {
    const name = (item as Record<string, unknown> | null)?.tool;
    if (typeof name === "string" && isSubstantiveTool(name)) return name;
  }
  return "";
}

function describePriceCompare(event: MemoryEventRecord): string | null {
  const query =
    typeof event.payload.query === "string" && event.payload.query.trim()
      ? event.payload.query.trim().slice(0, 60)
      : event.userText.slice(0, 40);
  if (!query) return null;

  const best = event.payload.bestOffer as Record<string, unknown> | null | undefined;
  const price = typeof best?.priceCny === "number" ? best.priceCny : null;
  const platform = typeof best?.platform === "string" ? best.platform : "";

  if (event.status === "invalid") {
    return price != null
      ? `[比价] ${query} → ¥${price} 疑似配件/非整机价，未计入最低价`
      : `[比价] ${query} → 未取得有效报价`;
  }
  if (event.status === "failed") return `[比价] ${query} → 查询失败`;
  if (event.payload.bestIndex === 0 && price != null) {
    const label = PLATFORM_LABELS[platform] ?? platform;
    return `[比价] ${query} → ${label ? `${label} ` : ""}¥${price}`;
  }
  if (event.status === "empty") return `[比价] ${query} → 未查到报价`;
  return `[比价] ${query} → 未取得同规格可比最低价`;
}

function describeWeather(event: MemoryEventRecord): string | null {
  const summary = typeof event.payload.summary === "string" ? event.payload.summary.trim() : "";
  if (!summary) return null;
  return `[天气] ${summary}`;
}

function describeScheduleWrite(event: MemoryEventRecord): string | null {
  if (!/\.(create|batch_create|create_from_text)$/.test(primaryToolName(event.payload))) {
    return null;
  }
  const title =
    typeof event.payload.title === "string" && event.payload.title.trim()
      ? event.payload.title.trim().slice(0, 60)
      : "";
  if (!title) return null;
  // 回执时间字段 2026-11-05 由 nextRunAtLocal（`11/6 11:00`）改为口语版 whenSpoken
  // （`明天上午十一点`）；记忆描述两种都认，旧事件仍可回放。
  const rawWhen = (key: string) => {
    const v = event.payload[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const when = rawWhen("whenSpoken") || rawWhen("nextRunAtLocal");
  return `[日程] ${when ? `${when} ` : ""}${title}`;
}

function describeEventOutcome(event: MemoryEventRecord): string | null {
  switch (event.kind) {
    case "price_compare":
      return describePriceCompare(event);
    case "weather_query":
      return describeWeather(event);
    case "schedule_write":
      return describeScheduleWrite(event);
    default:
      return null;
  }
}

/** 摘要只留人能读懂的话：协议标记/结构化块先剥掉，再脱敏截断。 */
export function summarizeEventText(text: string, maxChars = getEventSummaryMaxChars()): string {
  let plain = stripMarkersToPlainText(text ?? "");
  // 未闭合的结构块（模型漏写 END）剥不掉 JSON，从块起点整段丢弃
  const orphan = plain.search(
    /\[(?:AGENT_RESULT_CARD|IMAGE_RESULT|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|NEXT_UP)_START\]/,
  );
  if (orphan >= 0) plain = plain.slice(0, orphan);
  // 模型偶发写成 `[RENDER_HINT]:brief`（冒号在括号外），标准剥离器认不出
  plain = plain.replace(/\[RENDER_(?:HINT|AS)\][:：]?[ \t]*[A-Za-z_]*\]?/g, " ");
  const redacted = redactSensitiveText(plain).trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…`;
}

function pushEntity(list: string[], raw: unknown): void {
  if (typeof raw !== "string") return;
  const value = redactSensitiveText(raw.trim());
  if (!value || value.length > 40) return;
  if (!list.includes(value)) list.push(value);
}

/**
 * 商品型号：品牌词 + 数字 + 可选型号后缀（小米18 Pro / iPhone 16 Pro Max）。
 * 品牌用固定清单而不是「任意中文」，否则「帮我比一下小米18 Pro」会把前面的
 * 口语整段并进实体。清单外的新品牌靠工具入参 query 兜住。
 */
const MODEL_BRANDS = [
  "小米", "红米", "华为", "荣耀", "苹果", "三星", "索尼", "一加", "真我", "魅族",
  "努比亚", "联想", "戴尔", "惠普", "华硕", "宏碁", "微星", "雷蛇", "罗技", "佳能",
  "尼康", "富士", "大疆", "戴森", "飞利浦", "松下", "美的", "格力", "海尔", "西门子",
  "博世", "九阳", "苏泊尔", "特斯拉", "比亚迪", "理想", "蔚来", "小鹏", "问界", "极氪",
  "oppo", "vivo", "iqoo", "realme", "honor", "xiaomi", "redmi", "huawei", "apple",
  "samsung", "sony", "iphone", "ipad", "macbook", "imac", "airpods", "pixel", "galaxy",
  "surface", "thinkpad", "xps", "rog", "legion", "switch", "ps5",
];
const MODEL_RE = new RegExp(
  `(?:${MODEL_BRANDS.join("|")})\\s?[A-Za-z]{0,10}\\s?\\d{1,4}` +
    `(?:\\s?(?:Pro\\s?Max|Pro|Max|Ultra|Plus|Mini|Lite|SE|Air|Note|Fold|Flip))?\\b`,
  "gi",
);

/** 工具入参里能代表「对象」的字段名。 */
const ENTITY_INPUT_KEYS = ["query", "keyword", "topic", "title", "name", "destination", "city", "location"];

/** 从纯文本抽商品型号实体（自动召回触发与实体过滤共用）。 */
export function extractModelEntities(text: string): string[] {
  const entities: string[] = [];
  for (const match of text.matchAll(MODEL_RE)) pushEntity(entities, match[0]);
  return entities;
}

function extractEntities(
  userText: string,
  traces: EventToolTrace[],
  payload: Record<string, unknown>,
): string[] {
  const entities: string[] = [];
  for (const entity of extractModelEntities(userText)) pushEntity(entities, entity);
  for (const trace of traces) {
    for (const key of ENTITY_INPUT_KEYS) pushEntity(entities, trace.input[key]);
  }
  pushEntity(entities, payload.query);
  pushEntity(entities, payload.topic);
  const urlSource = `${userText}\n${JSON.stringify(payload)}`;
  for (const match of urlSource.matchAll(/https?:\/\/([^/\s"\\]+)/g)) {
    pushEntity(entities, match[1]);
  }
  return entities.slice(0, 12);
}

/** 标量白名单：只保留可安全落库的小字段，数组只留短标量数组，长数组记条数。 */
function pickScalarPayload(
  source: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(source)) {
    if (kept >= 24) break;
    if (value == null) continue;
    if (typeof value === "string") {
      const text = redactSensitiveText(value);
      if (text.length <= 300) {
        out[key] = text;
        kept += 1;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      kept += 1;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length <= 10 && value.every((v) => typeof v === "string" || typeof v === "number")) {
        out[key] = value.map((v) => (typeof v === "string" ? redactSensitiveText(v) : v));
      } else {
        out[`${key}Count`] = value.length;
      }
      kept += 1;
      continue;
    }
    if (typeof value === "object" && depth === 0) {
      const nested = pickScalarPayload(value as Record<string, unknown>, depth + 1);
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
        kept += 1;
      }
    }
  }
  return out;
}

function buildToolPayload(traces: EventToolTrace[]): Record<string, unknown> {
  const limited = traces.slice(0, getEventMaxToolTraces());
  const primary = limited.find((t) => isSubstantiveTool(t.toolName));
  const payload: Record<string, unknown> = {};
  if (primary) {
    Object.assign(payload, pickScalarPayload(primary.result));
    if (primary.ok === false && !payload.error) {
      payload.error = "工具返回失败";
    }
  }
  payload.tools = limited.map((t) => ({
    tool: t.toolName,
    ok: t.ok,
    input: pickScalarPayload(t.input),
  }));
  return payload;
}

/** djb2：无 messageId 时的稳定哈希键。 */
function hashKey(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function buildEventId(actorId: string, messageId: string | undefined, ts: string, userText: string): string {
  const key = messageId?.trim() || `h${hashKey(`${ts}|${userText.slice(0, 160)}`)}`;
  return `evt:${actorId}:${key}`;
}

export function buildTurnEvent(input: TurnEventInput): MemoryEventRecord {
  const traces = input.toolTraces ?? [];
  const maxChars = getEventSummaryMaxChars();
  const kind = deriveKind(traces);
  const payload = buildToolPayload(traces);
  const suspectPrice = kind === "price_compare" && isSuspectPriceCompare(traces);
  if (suspectPrice) payload.suspect = "accessory";
  return {
    id: buildEventId(input.actorId, input.messageId, input.ts, input.userText),
    actorId: input.actorId,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    eventTime: input.ts,
    recordedAt: new Date().toISOString(),
    kind,
    status: suspectPrice ? "invalid" : deriveStatus(traces),
    userText: summarizeEventText(input.userText, maxChars),
    answerText: summarizeEventText(input.assistantText, maxChars),
    entities: extractEntities(input.userText, traces, payload),
    payload,
    refs: {
      messageId: input.messageId ?? null,
      sessionId: input.sessionId ?? null,
      toolCalls: traces.length,
    },
    context: input.context ?? "main",
  };
}
