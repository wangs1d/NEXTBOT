/**
 * done 阶段确定性附卡链（单一事实源）。
 *
 * chat-user-message 在 assistant_done 前按固定顺序附加确定性卡片/媒体标记，
 * 此前该顺序内联在 handler 里，无法被测试覆盖——「单测全绿但真实轮次漏卡」
 * 的接线缺口（weather/wallet/calendar/shopping/video 只接了单工具直跑路径）
 * 正是在这里漏掉的。抽出为纯函数后，测试可用与 handler 完全相同的顺序与
 * 输入回放真实轮次（tool-loop 内执行、reply.toolName 为空）。
 *
 * 顺序即优先级（先附上的卡生效，后续 attach 各自含结构化标记 guard 让位）：
 *   1. travel_itinerary 行程卡（直跑 + loop 冷层回捞，handler 解析后传入）
 *   2. weather 天气卡（loop 多次调用合并为一张多地卡）
 *   3. search_result 搜索卡（loop 多次调用按 url 去重合并；搜索类媒体有产出
 *      时整卡让位——照片是主形态，意图仲裁见 searchMediaHasItems）
 *   4. 其余注册工具卡（wallet/schedule/order/比价…，按执行顺序取第一张）
 *   5. video 媒体标记（[RENDER_AS:video]，loop 捕获优先、直跑回执兜底）
 */

import {
  attachSearchResultCardFromExecuted,
  attachWeatherResultCardFromExecuted,
  tryAttachToolResultCard,
} from "./tool-card-registry.js";
import {
  attachTravelItineraryCard,
  attachVideoMediaMarker,
  containsTravelItineraryCard,
} from "./tool-result-processor.js";
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";

/** 一次真实工具执行的回执（来自 onExternalToolExecuted 或直跑 toolResult）。 */
export interface ExecutedToolReceipt {
  toolName: string;
  result: Record<string, unknown>;
}

/** 行程回执裁决产物：toolName/result 成对，拿不到行程时均为 undefined。 */
export interface TravelReceiptResolution {
  toolName?: "travel.plan-itinerary";
  result?: Record<string, unknown>;
}

const DEFAULT_TRAVEL_FALLBACK_WINDOW_MS = 60 * 1000;

/**
 * done 阶段行程回执裁决（单一事实源）：WS 对话路径与任务面收尾共用。
 *
 * 行程卡是确定性附卡（不依赖 LLM 转发），但「拿到行程原始数据」的链路有
 * 多条且都会漏拍：直跑回执挂在 reply.toolName，tool-loop 执行靠
 * onToolExecuted 捕获，而缓存重放 / 升级段边缘 / 旧构建 hook 断线时捕获
 * 会是空的——此前任务面收尾没有兜底，卡片就永远附不上（漏卡根因）。
 * 这里按优先级统一裁决：
 *   1. 本轮真实执行回执（直跑 toolResult 或 onToolExecuted 捕获，等价）；
 *      回执是瘦身摘要也直接放行——attachTravelItineraryCard 内部会按
 *      planId 从冷层补全量 days；
 *   2. 捕获为空 → 冷层近窗回捞兜底：只认窗口内新生成的行程，
 *      正文/目标点名目的地优先，否则取最新一份（规划轮正文可能不含
 *      目的地全名）。窗口默认 60s，任务面可放宽（执行可能排队）。
 */
export function resolveTravelReceipt(input: {
  replyToolName?: string;
  replyToolResult?: Record<string, unknown>;
  executedReceipt?: Record<string, unknown>;
  goal?: string;
  finalText?: string;
  fallbackWindowMs?: number;
  nowMs?: number;
}): TravelReceiptResolution {
  const now = input.nowMs ?? Date.now();

  // 1. 本轮真实执行回执优先
  const executed =
    input.executedReceipt ??
    (input.replyToolName === "travel.plan-itinerary"
      ? input.replyToolResult
      : undefined);
  if (executed && typeof executed === "object") {
    // 本轮确实尝试过规划：成功才附卡，失败不回捞旧行程误挂到失败轮
    if (typeof executed.ok !== "boolean" || executed.ok) {
      return { toolName: "travel.plan-itinerary", result: executed };
    }
    return {};
  }

  // 2. 冷层近窗回捞（捕获漏拍兜底）
  const window = input.fallbackWindowMs ?? DEFAULT_TRAVEL_FALLBACK_WINDOW_MS;
  const candidates = travelPlanStore
    .listSummaries(5)
    .filter((s) => now - s.createdAt < window);
  if (candidates.length === 0) return {};
  const haystack = `${input.goal ?? ""}\n${input.finalText ?? ""}`;
  const picked =
    candidates.find(
      (s) => s.destination && haystack.includes(s.destination),
    ) ?? candidates[0];
  const plan = travelPlanStore.get(picked.planId);
  if (!plan || plan.days.length === 0) return {};
  return {
    toolName: "travel.plan-itinerary",
    result: plan as unknown as Record<string, unknown>,
  };
}

/* ────────────────────────────────────────────────────────────
 * 手写行程检测（2026-10-08 确定性兜底）
 *
 * 失败模式（travel-plans 落盘自 9/28 零新增实证）：模型把完整行程手写成
 * markdown 表格/多方案清单，全程不调 travel.plan-itinerary → 行程卡整轮缺席，
 * 手机/桌面的行程卡点击界面形同虚设。检测走「领域词 × 结构特征」双闸：
 *   - 领域词（景点/门票/景区/攻略…）先行：排除日常日程表（会议/提醒带时间）
 *     的误触发——「明天的行程 09:00 开会」这类回复不该补跑旅游规划；
 *   - 结构特征（时间格 ≥4 / 多方案标题 / 多天标题）：只有真的写了行程表
 *     才命中，泛泛聊旅游不触发。
 * 误触发代价 = 多跑一次 10~30s 规划 + 多挂一张行程卡；漏触发代价 = 卡片缺席。
 * 结构特征保证误触发率极低，宁挂勿漏。
 * ──────────────────────────────────────────────────────────── */

const ITINERARY_TIME_CELL_RE = /\b\d{1,2}[:：]\d{2}\b/g;
const STRONG_TRAVEL_TOPIC_RE =
  /景点|景区|门票|游玩|旅游|攻略|自由行|民宿|青旅|骑行|漂流|徒步|登高|古城|古镇|温泉|滑雪|出海|夜景|小吃|美食街/;
const PLAN_OPTION_HEADING_RE = /方案\s*[A-Za-z0-9一二三四五六]/g;
const DAY_HEADING_RE = /Day\s*\d|第[一二三四五六七\d]+天/gi;

/** 回复是否为「模型手写的完整行程」（应附行程卡但没调规划工具）。 */
export function looksLikeHandwrittenItinerary(text: string): boolean {
  const t = text ?? "";
  if (!STRONG_TRAVEL_TOPIC_RE.test(t)) return false;
  const timeCells = t.match(ITINERARY_TIME_CELL_RE)?.length ?? 0;
  if (timeCells >= 4) return true;
  const planHeadings = t.match(PLAN_OPTION_HEADING_RE)?.length ?? 0;
  if (planHeadings >= 2) return true;
  const dayHeadings = t.match(DAY_HEADING_RE)?.length ?? 0;
  return dayHeadings >= 2;
}

/** 从用户原话 + 手写行程文本里嗅探天数（补跑入参用，best-effort：说不清就缺省）。 */
export function sniffItineraryDays(texts: ReadonlyArray<string>): number | undefined {
  const joined = texts.join("\n");
  if (/两日|两天|2天/.test(joined)) return 2;
  if (/三日|三天|3天/.test(joined)) return 3;
  if (/一日|一天|1天/.test(joined)) return 1;
  return undefined;
}

/**
 * 行程卡缺席自检判据（2026-10-12 贵阳轮「行程卡整轮缺席」埋点，纯函数便于回归）。
 *
 * 症状：行程规划轮结束时正文里**没有** travel_itinerary 卡——用户诉求未兑现，
 * 且下游出口闸会把该轮判成「工具全败」，模型于是手写逐日行程直穿气泡（无卡、
 * 裸 markdown）。事故形态：回执被 30s 预算击杀（ok=false）→ resolveTravelReceipt
 * 返回 {} → 无卡。
 *
 * 判据分两档，**硬档锚在确定性事实上**——不能只靠 LLM 的 travel_query（该字段
 * 来自路由模型，可能缺省/抖动；且事故里路由是成功的，与回执被杀无因果，单点
 * 兜底会漏报）：
 *   - "hard"：本轮真跑过规划工具 或 拿到过行程回执，却无卡 → 必然是 bug。
 *   - "soft"：路由判为行程轮 且 正文是一段手写行程 → 高置信嫌疑（事故原形态）。
 *   - null：有卡，或既没规划迹象也没手写行程（正常闲聊/引用旧方案）。
 *
 * @returns 命中档位；未命中返回 null。
 */
export function classifyTravelCardMissing(input: {
  finalText: string;
  /** 本轮真执行过 travel.plan-itinerary（含确定性预执行，无论成败）。 */
  travelPlanningAttempted: boolean;
  /** 本轮拿到过行程回执（travelReceiptResolution.toolName 非空）。 */
  travelReceiptPresent: boolean;
  /** 路由理解：是否行程轮（LLM 字段，可能 undefined）。 */
  travelQuery?: boolean;
}): "hard" | "soft" | null {
  if (containsTravelItineraryCard(input.finalText)) return null;
  if (input.travelPlanningAttempted || input.travelReceiptPresent) return "hard";
  if (input.travelQuery === true && looksLikeHandwrittenItinerary(input.finalText)) {
    return "soft";
  }
  return null;
}

export interface DeterministicCardChainInput {
  /** processAssistantText 之后的正文（LLM 口语回复，可能已含 L2 卡块）。 */
  text: string;
  /** 行程：toolName + 已解析出完整 days 的回执（冷层回捞由 handler 完成后传入）。 */
  travelToolName?: string;
  travelResult?: Record<string, unknown>;
  /** tool-loop 聚合的天气回执（按执行顺序）。 */
  weatherResults?: ReadonlyArray<ExecutedToolReceipt>;
  /** tool-loop 聚合的搜索回执（按执行顺序）。 */
  searchResults?: ReadonlyArray<ExecutedToolReceipt>;
  /**
   * 本轮搜索类媒体（search_images/search_images_batch/search_videos）是否有
   * 真实产出（extractMediaCards 组装出卡）。true 时 search_result 文字卡整卡
   * 让位——照片是主形态，文字列表冗余；false/缺省时搜索卡照常附（零图兜底）。
   * image.generate 生图不算搜索证据，不计入。
   */
  searchMediaHasItems?: boolean;
  /** 其余注册工具回执（wallet/calendar/shopping…，按执行顺序）。 */
  registryResults?: ReadonlyArray<ExecutedToolReceipt>;
  /** 视频抓取回执（loop 捕获在前、直跑兜底在后；取最后一条）。 */
  videoResults?: ReadonlyArray<ExecutedToolReceipt>;
}

/** 按 done 阶段真实顺序附加全部确定性卡片/媒体标记，返回最终文本。 */
export function attachDeterministicCards(input: DeterministicCardChainInput): string {
  let text = input.text;
  text = attachTravelItineraryCard(text, input.travelToolName, input.travelResult);
  text = attachWeatherResultCardFromExecuted(text, input.weatherResults ?? []);
  text = attachSearchResultCardFromExecuted(text, input.searchResults ?? [], {
    yieldToSearchMedia: input.searchMediaHasItems === true,
  });
  for (const mt of input.registryResults ?? []) {
    const marked = tryAttachToolResultCard(text, mt.toolName, mt.result);
    if (marked) {
      text = marked;
      break;
    }
  }
  const video = input.videoResults?.[input.videoResults.length - 1];
  if (video) {
    text = attachVideoMediaMarker(text, video.toolName, video.result);
  }
  return text;
}
