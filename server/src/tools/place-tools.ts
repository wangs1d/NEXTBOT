/**
 * 地点语义与行程工具（place）——让 Agent 查询、确认、忘记「家/公司」，
 * 以及按天查询实际足迹（timeline）和多天出行习惯（habits）。
 *
 * 与 geofence 的区别：geofence 是「到达/离开触发动作」的触发器；place 是
 * 「这个地方是什么」的长期事实 + 从位置历史还原的日行程。用户说「那是我妈家」
 * 「公司在科技园」时改的是 place，不应该顺手建一个围栏。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "../services/audit-service.js";
import type { DayVisit, LocationHistoryService } from "../services/location-history-service.js";
import {
  formatPlaceAdminArea,
  type PlaceSemanticKind,
  type PlaceSemanticRecord,
  type PlaceSemanticsService,
} from "../services/place-semantics-service.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

const KINDS: PlaceSemanticKind[] = ["home", "work", "other"];

export const PLACE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "place",
      description:
        "地点语义与行程的统一入口（用 action 分流）：系统从位置历史里识别出的「家 / 公司 / 常去地点」，以及按天还原的实际足迹。\n" +
        "action=list：列出已识别的地点（含行政区/地址、置信度与证据）。用户问「你知道我住哪/公司在哪」「我常去哪」「我家在哪个城市」时先调用；回答城市必须用返回的 adminArea/city，不能拿当前定位城市顶替。推断未确认的结果只能当背景，不要在对话里断言。\n" +
        "action=confirm：用户明确确认或纠正某地点是什么（kind=home|work|other）。必须先用 list 拿到 id；用户说「我家在X」「我住在X」「公司搬到X」且 list 中有对应地点时，也应调用 confirm（同时传 label），只写进用户档案不算确认。确认后成为长期事实，自动推断不再覆盖。若用户纠正了名称（如「不是三家村小区，我家是九华苑」），同时传 label。\n" +
        "action=forget：忘掉地点语义。带 id 删除单个；不带 id 清空全部。用户说「忘掉我的家/公司」「别记我的位置」时调用。\n" +
        "action=timeline：查询某一天的实际足迹（停留 + 移动）。用户问「我今天去了哪」「今天行程」「昨天几点到的公司」「这周去过哪些地方」时调用。date 支持 today/yesterday/YYYY-MM-DD；days 可一次查最近 N 天（1..7）。\n" +
        "action=habits：查询最近 N 天的出行习惯（工作日/周末通常几点到、几点走、待多久）。用户问「我平时几点到公司」「我周末一般去哪」时调用。位置历史只保留 7 天，回看天数最大 7。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "confirm", "forget", "timeline", "habits"],
            description: "要执行的地点动作。",
          },
          id: { type: "string", description: "action=confirm/forget：地点 id（action=list 返回）" },
          kind: {
            type: "string",
            enum: ["home", "work", "other"],
            description: "action=confirm：用户确认的地点语义",
          },
          label: {
            type: "string",
            description:
              "action=confirm：用户纠正的地点名称（如「九华苑」）。不传则保留系统识别名称。",
          },
          date: {
            type: "string",
            description:
              "action=timeline：查询哪一天，today / yesterday / YYYY-MM-DD，缺省 today。",
          },
          days: {
            type: "number",
            description:
              "action=timeline：最近 N 天（1..7），给了它则忽略 date；action=habits：回看天数（默认 7，最大 7，与位置历史保留期一致）。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export function summarizePlace(record: PlaceSemanticRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label ?? record.poiName ?? null,
    // 行政区/地址必须一并给出：只回「九华苑」时模型无法回答「家在哪个城市」，
    // 会拿【当前位置】的城市顶替（2026-11-16 北海/兴义归因事故）。
    adminArea: formatPlaceAdminArea(record) || null,
    city: record.city,
    district: record.district,
    region: record.region,
    country: record.country,
    address: record.address,
    confidence: Math.round(record.confidence * 100) / 100,
    confirmed: record.confirmed,
    source: record.source,
    poiType: record.poiType,
    evidence: record.evidence.slice(0, 4),
    distinctDays: record.distinctDays,
    visitDays: record.visitDays,
    lastSeenAt: record.lastSeenAt,
  };
}

function summarizeDayVisit(
  service: PlaceSemanticsService,
  actorId: string,
  visit: DayVisit,
): Record<string, unknown> {
  const match = visit.kind === "stay" ? service.matchCached(actorId, visit) : null;
  const semantic = match?.record ?? null;
  const name =
    semantic?.label?.trim() ||
    semantic?.poiName?.trim() ||
    visit.label?.trim() ||
    (visit.city
      ? [visit.city, visit.district].filter(Boolean).join(" · ")
      : visit.kind === "trip"
        ? "移动中"
        : null);
  return {
    kind: visit.kind,
    startAt: visit.startAt,
    endAt: visit.endAt,
    startLocal: visit.startLocal,
    endLocal: visit.endLocal,
    durationMinutes: visit.durationMinutes,
    name,
    label: visit.label,
    city: visit.city,
    district: visit.district,
    placeId: semantic?.id ?? null,
    placeKind: semantic?.kind ?? null,
    confirmed: semantic?.confirmed ?? false,
    latitude: Math.round(visit.latitude * 1e6) / 1e6,
    longitude: Math.round(visit.longitude * 1e6) / 1e6,
    sampleCount: visit.sampleCount,
    accuracyMeters: visit.accuracyMeters,
  };
}

/** 注册 place 工具执行器（create-app-services 装配时调用） */
export function registerPlaceTools(
  registry: ToolRegistry,
  deps: {
    service: PlaceSemanticsService;
    audit?: AuditService | null;
    /** 位置历史（timeline/habits 数据源）；null=未开启，两个 action 如实失败 */
    history?: LocationHistoryService | null;
    /** 读取该 actor 的 IANA 时区（装配层接 actorContext.resolveClock） */
    getTimezone?: ((actorId: string) => string | undefined) | null;
    /** 语义变更后同步用户画像里的常去地点行（装配层接 syncPlacesToProfile） */
    onChanged?: ((actorId: string) => void) | null;
    /**
     * 用户确认家/公司后，装配层据此注册一个 observe 系统围栏：
     * App 被杀也能拿到 enter/leave，主动行为才真正闭环（不自动注册推断结果）。
     */
    onConfirmed?: ((actorId: string, record: PlaceSemanticRecord) => void) | null;
    /** 忘记地点语义时同步清理为它注册的 observe 系统围栏（隐私一致性） */
    onForgotten?: ((actorId: string, placeId?: string) => void) | null;
  },
): void {
  const { service, audit, history, getTimezone, onChanged, onConfirmed, onForgotten } = deps;

  const timezoneFor = (actorId: string): string =>
    getTimezone?.(actorId)?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  const handleList = async (_input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const records = await service.getPlaces(actorId);
    return { ok: true, count: records.length, places: records.map(summarizePlace) };
  };

  const handleConfirm = async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    const kind = String(input.kind ?? "").trim() as PlaceSemanticKind;
    if (!id) return { ok: false, error: "action=confirm 需要 id（先 action=list 查）" };
    if (!KINDS.includes(kind)) {
      return { ok: false, error: `kind 须为 ${KINDS.join(" / ")} 之一` };
    }
    const label = String(input.label ?? "").trim();
    const updated = service.confirm(actorId, id, kind, label || null);
    if (!updated) return { ok: false, error: `地点不存在: ${id}` };
    try {
      onChanged?.(actorId);
    } catch {
      /* 画像同步失败不影响确认结果 */
    }
    try {
      onConfirmed?.(actorId, updated);
    } catch {
      /* 系统围栏注册失败不影响确认结果（降级为服务端语义判定） */
    }
    void audit
      ?.record({
        type: "place.confirm",
        actorId,
        placeId: id,
        kind,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    return { ok: true, place: summarizePlace(updated) };
  };

  const handleForget = async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    const removed = id ? (service.remove(actorId, id) ? 1 : 0) : service.forget(actorId);
    try {
      onChanged?.(actorId);
    } catch {
      /* 缓存失效失败不影响删除结果 */
    }
    try {
      onForgotten?.(actorId, id || undefined);
    } catch {
      /* 系统围栏清理失败不影响删除结果（后续清历史会再兜底） */
    }
    void audit
      ?.record({
        type: "place.forget",
        actorId,
        placeId: id || null,
        removed,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    return { ok: true, removed };
  };

  const handleTimeline = async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    if (!history) {
      return {
        ok: false,
        error:
          "位置历史未开启，无法查询日行程。请让用户在设置中开启位置历史/持续定位。",
      };
    }
    const timezone = timezoneFor(actorId);
    const rawDays = Number(input.days);
    const days = Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.max(Math.trunc(rawDays), 1), 7)
      : 1;
    const timelines =
      days > 1
        ? history.dayTimelines(actorId, { days, timezone })
        : [history.dayTimeline(actorId, { date: String(input.date ?? "today"), timezone })];
    const items = timelines.map((timeline) => ({
      date: timeline.date,
      timezone: timeline.timezone,
      sampleCount: timeline.sampleCount,
      pathMeters: timeline.pathMeters,
      visits: timeline.visits.map((visit) => summarizeDayVisit(service, actorId, visit)),
    }));
    const count = items.reduce((sum, item) => sum + item.visits.length, 0);
    return {
      ok: true,
      timezone,
      days: items.length,
      count,
      timelines: items,
      message:
        count === 0
          ? "系统还没有这段时间足够的位置记录，无法还原行程。不要猜测用户去了哪；可以如实说暂时没有记录。"
          : "以下是系统从位置历史自动还原的足迹（停留 + 移动）。只按返回结果回答，不要编造没记录的地点；经纬度仅供工具入参，禁止向用户展示坐标数字。",
    };
  };

  const handleHabits = async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    if (!history) {
      return {
        ok: false,
        error: "位置历史未开启，无法推断出行习惯。请让用户在设置中开启位置历史/持续定位。",
      };
    }
    const timezone = timezoneFor(actorId);
    const rawDays = Number(input.days);
    // 位置历史保留期 7 天：再往前查只会是空数据，不要把「保留期外」说成「没记录」。
    const days = Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.max(Math.trunc(rawDays), 1), 7)
      : 7;
    const habits = await service.habits(actorId, { days, timezone });
    return {
      ok: true,
      timezone,
      days,
      count: habits.length,
      habits,
      message:
        habits.length === 0
          ? "位置记录还不足以推断出行习惯：需要连续多天、每天有几次可信定位。不要凭印象编造用户的作息。"
          : "以下是系统按最近多天日行程统计出的中位习惯（不是今天的具体行程）。时间以用户本地时区为准；只按返回结果回答。",
    };
  };

  registry.register("place", async (input, context) => {
    const action = String(input.action ?? "").trim();
    switch (action) {
      case "list":
        return handleList(input, context);
      case "confirm":
        return handleConfirm(input, context);
      case "forget":
        return handleForget(input, context);
      case "timeline":
        return handleTimeline(input, context);
      case "habits":
        return handleHabits(input, context);
      default:
        return {
          ok: false,
          error: `未知 action「${action || "(空)"}」，可选值：list、confirm、forget、timeline、habits`,
        };
    }
  });
}
