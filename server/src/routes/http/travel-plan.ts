import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  travelPlanStore,
  type StoredTravelPlan,
} from "../../skills/travel-planning/travel-plan-store.js";
import { travelShareStore } from "../../skills/travel-planning/travel-share-store.js";
import { travelFavoritesStore } from "../../skills/travel-planning/travel-favorites-store.js";
import {
  pricingService,
  formatQuotePriceInfo,
  type MemberTier,
  type BoundPlatform,
  type PriceQuote,
  type PricingContext,
} from "../../skills/travel-planning/pricing-service.js";
import type { PlanningService } from "../../skills/travel-planning/travel-planning-service.js";
import {
  travelMediaStore,
  type PoiMediaType,
} from "../../skills/travel-planning/travel-media-store.js";

/** 行程条目类型（与 PlanningService 的 POI 三分类一致） */
const POI_TYPES = ["attraction", "hotel", "restaurant"] as const;
type PoiType = (typeof POI_TYPES)[number];

/**
 * 存量行程读取时从媒体库带图（本地直读，不写库、不动版本）。
 *
 * 生成期载荷缺图（媒体库当时没有、阶段 2.5 后台回填晚到）的条目，只要媒体库
 * 后来补上了（Wikimedia/必应回填、/travel-poi/details 补图播种），读取路径就把
 * 图带出去——归档/手机端/编辑刷新全部受益，无需重新生成行程。
 * imageUrls 可注入（单测用假库）；默认走媒体库。仅对完全没图的条目补图。
 */
export function decoratePlanWithMedia<
  P extends {
    days: Array<{ items: Array<{ type: string; name: string; images?: string[] }> }>;
  },
>(
  plan: P,
  imageUrls: (type: string, name: string) => string[] = (t, n) =>
    travelMediaStore.imageUrls(t as PoiMediaType, n),
): P {
  let touched = false;
  const days = plan.days.map((day) => ({
    ...day,
    items: day.items.map((item) => {
      if (item.images?.length) return item;
      const urls = imageUrls(item.type, item.name);
      if (!urls.length) return item;
      touched = true;
      return { ...item, images: urls };
    }),
  }));
  return touched ? { ...plan, days } : plan;
}

/** 会员等级（pricing-service.MemberTier 的运行时枚举，用于请求校验） */
const MEMBER_TIERS = ["normal", "silver", "gold", "diamond", "platinum"] as const;

/** 绑定平台代码（pricing-service.PlatformCode 的运行时枚举） */
const PLATFORM_CODES = [
  "booking",
  "agoda",
  "trip",
  "ctrip",
  "fliggy",
  "meituan",
  "dianping",
  "klook",
  "kkday",
] as const;

/**
 * 纯字符串形式绑定平台时的默认账户等级（对齐各平台静态权益表的中档等级，
 * 折扣计算把 accountLevel 传给 pricing-service 的平台优惠匹配）。
 */
const DEFAULT_PLATFORM_LEVEL: Record<(typeof PLATFORM_CODES)[number], string> = {
  booking: "genius-1",
  agoda: "silver",
  trip: "silver",
  ctrip: "silver",
  fliggy: "F1",
  meituan: "yellow",
  dianping: "yellow",
  klook: "priority",
  kkday: "member",
};

// ======================== 请求 schema ========================

const indexParamsSchema = z.object({
  planId: z.string().min(1).max(80),
  dayIndex: z.coerce.number().int().min(0),
  itemIndex: z.coerce.number().int().min(0),
});

const dayIndexParamsSchema = z.object({
  planId: z.string().min(1).max(80),
  dayIndex: z.coerce.number().int().min(0),
});

const planIdParamsSchema = z.object({
  planId: z.string().min(1).max(80),
});

/** 条目编辑：body 中出现的字段替换原条目对应字段（未出现的保留原值） */
const itemPatchSchema = z.object({
  type: z.enum(POI_TYPES).optional(),
  name: z.string().min(1).max(120).optional(),
  startTime: z.string().min(1).max(40).optional(),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
  address: z.string().max(300).optional(),
  priceInfo: z.string().max(200).optional(),
  description: z.string().max(3000).optional(),
  tips: z.array(z.string().max(300)).max(9).optional(),
  images: z.array(z.string().max(1000)).max(20).optional(),
});

const commentSchema = z.object({
  comment: z.string().min(1).max(500),
});

/** 新增条目：type + name（名称或关键词，走 searchPois 定位）；startTime 显式指定时作为重排锚点 */
const itemAddSchema = z.object({
  type: z.enum(POI_TYPES),
  name: z.string().min(1).max(120),
  startTime: z.string().min(1).max(40).optional(),
});

const poiSearchQuerySchema = z.object({
  destination: z.string().min(1).max(80),
  type: z.enum(POI_TYPES),
  keyword: z.string().max(80).optional(),
});

/** 绑定平台：对象形式含账户等级（对齐 3D-Travel state.boundPlatforms），字符串形式按默认等级 */
const boundPlatformSchema = z.union([
  z.object({
    platform: z.enum(PLATFORM_CODES),
    accountLevel: z.string().min(1).max(40),
    displayName: z.string().max(60).optional(),
  }),
  z.enum(PLATFORM_CODES),
]);

/** 收藏全量同步 body（C5） */
const favoritesSyncSchema = z.object({
  favorites: z.array(z.string().min(1).max(120)).max(500),
});

const bookingSchema = z.object({
  memberTier: z.enum(MEMBER_TIERS).optional(),
  boundPlatforms: z.array(boundPlatformSchema).max(9).optional(),
});

/**
 * 行程路由域：面向前端行程面板的编辑/搜索/预订/分享能力（一比一移植 3D-Travel
 * 服务端部分）。数据源为 travelPlanStore 落盘的完整行程（planId 由
 * travel.plan-itinerary 生成并随 travel_itinerary 卡下发前端）。
 *
 * - 编辑：PATCH/DELETE 按天/条目索引修改；POST 新增条目（searchPois 定位 + 局部重排）；
 *   comment 端点「提意见换一个」——按原条目类型与坐标经规划引擎找同类替代 POI 并用
 *   PricingService 重新计价；坐标变更（替换/PATCH/新增/删除）后均按新坐标局部重排当天时间轴。
 * - 搜索：GET /travel/poi-search 供单项编辑器搜索备选 POI。
 * - 预订：按酒店×晚数/门票×1/餐厅人均×1 逐项报价并汇总优惠。
 * - 分享：8 位分享码 ↔ planId 映射（travel-share-store 单文件持久化）。
 *
 * travelPlanningService 未装配时所有端点返回 503（仿 not enabled 模式）。
 */
export function registerTravelPlanRoutes(app: FastifyInstance, deps: { travelPlanningService?: PlanningService }): void {
  /** 统一 503：规划服务未装配。返回 false 表示已发送错误响应 */
  const requireService = (reply: FastifyReply): boolean => {
    if (!deps.travelPlanningService) {
      void reply.code(503).send({ ok: false, error: "规划服务未装配，行程路由域不可用" });
      return false;
    }
    return true;
  };

  /** 按 planId 取行程；不存在时发送 404 并返回 null */
  const requirePlan = (reply: FastifyReply, planId: string): StoredTravelPlan | null => {
    const plan = travelPlanStore.get(planId);
    if (!plan) {
      void reply.code(404).send({ ok: false, error: `行程不存在：${planId}` });
      return null;
    }
    return plan;
  };

  /** 按天/条目索引取条目；越界时发送 400 并返回 null */
  const requireItem = (
    reply: FastifyReply,
    plan: StoredTravelPlan,
    dayIndex: number,
    itemIndex: number,
  ): StoredTravelPlan["days"][number]["items"][number] | null => {
    const day = plan.days[dayIndex];
    const item = day?.items[itemIndex];
    if (!item) {
      void reply.code(400).send({
        ok: false,
        error: `索引越界：dayIndex=${dayIndex}（共 ${plan.days.length} 天），itemIndex=${itemIndex}`,
      });
      return null;
    }
    return item;
  };

  /**
   * 乐观锁校验（A6）：请求携带 If-Match（或 x-plan-version）头时须与当前版本一致，
   * 不一致返回 409——防止面板与聊天编辑、双开面板互相覆盖。版本由 store 每次保存自增。
   */
  const checkVersion = (reply: FastifyReply, plan: StoredTravelPlan, request: { headers: Record<string, unknown> }): boolean => {
    const raw =
      (request.headers["if-match"] as string | undefined) ??
      (request.headers["x-plan-version"] as string | undefined);
    if (raw == null || raw === "") return true;
    const expected = Number(String(raw).replace(/^"|"$/g, ""));
    if (!Number.isFinite(expected)) return true;
    if ((plan.version ?? 0) !== expected) {
      void reply.code(409).send({
        ok: false,
        error: `行程已被其他操作修改（当前版本 ${plan.version}，请求基于 ${expected}），请刷新后重试`,
        currentVersion: plan.version,
      });
      return false;
    }
    return true;
  };

  /** 用 PricingService 为条目报价（按类型选计价入口） */
  const quoteFor = (name: string, tags: string[], type: PoiType, ctx: PricingContext): PriceQuote => {
    if (type === "hotel") return pricingService.quoteHotel(name, tags, ctx);
    if (type === "attraction") return pricingService.quoteAttraction(name, tags, ctx);
    return pricingService.quoteRestaurant(name, tags, ctx);
  };

  /** 绑定平台入参 → pricing-service 的 BoundPlatform（字符串形式按默认账户等级） */
  const normalizePlatforms = (raw: z.infer<typeof bookingSchema>["boundPlatforms"]): BoundPlatform[] | undefined => {
    if (!raw || raw.length === 0) return undefined;
    return raw.map((p) =>
      typeof p === "string"
        ? { platform: p, accountLevel: DEFAULT_PLATFORM_LEVEL[p], displayName: p }
        : { platform: p.platform, accountLevel: p.accountLevel, displayName: p.displayName ?? p.platform },
    );
  };

  // ======================== 行程读取 ========================

  /** 行程摘要列表（新→旧，最多 20 份），供面板「我的行程」选择 */
  app.get("/travel/plans", async (_request, reply) => {
    if (!requireService(reply)) return;
    return { ok: true, plans: travelPlanStore.listSummaries(20) };
  });

  /** 端点自述清单（与其他路由域一致的自我描述） */
  app.get("/travel/plans/_meta", async () => ({
    domain: "travel-plan",
    endpoints: [
      "GET    /travel/plans                                行程摘要列表（≤20）",
      "GET    /travel/plans/:planId                        完整行程（404 若不存在）",
      "DELETE /travel/plans/:planId                        删除整份行程（含分享码映射）",
      "PATCH  /travel/plans/:planId/progress              {day,stop} 上报行程进度（设备状态，不动版本）",
      "GET    /travel/plans/:planId/progress              行程进度（无记录为 null）",
      "GET    /travel/plans/:planId/signal                实时信号（rain/behind，Agent 侧确定性判定）",
      "PATCH  /travel/plans/:planId/days/:dayIndex/items/:itemIndex   {type?,name?,startTime?,latitude?,longitude?,address?,priceInfo?,description?,tips?,images?}",
      "DELETE /travel/plans/:planId/days/:dayIndex/items/:itemIndex   删除条目",
      "POST   /travel/plans/:planId/days/:dayIndex/items              {type,name,startTime?} 新增条目（searchPois 定位 + 局部重排）",
      "POST   /travel/plans/:planId/days/:dayIndex/items/:itemIndex/comment   {comment} 提意见换一个（局部重排）",
      "GET    /travel/poi-search?destination=&type=&keyword=          单项编辑器备选搜索（≤8 条）",
      "POST   /travel/plans/:planId/booking                {memberTier?,boundPlatforms?} 预订报价",
      "POST   /travel/plans/:planId/share                  生成/复用 8 位分享码",
      "GET    /travel/share/:code                          按分享码读完整行程",
      "GET    /travel/share/:code/page                     分享 H5 只读页（手机浏览器可直接打开）",
      "GET    /travel/favorites                            收藏列表（type:name 键）",
      "POST   /travel/favorites                            {favorites:[…]} 全量同步收藏",
    ],
    note: "planId 来自 travel_itinerary 卡 travelPlan.planId；分享码读取使用独立前缀 /travel/share/:code 避免与 :planId 参数段歧义",
  }));

  /** 完整行程（前端双面板直读/编辑的权威数据源） */
  app.get<{ Params: { planId: string } }>("/travel/plans/:planId", async (request, reply) => {
    if (!requireService(reply)) return;
    const parsed = planIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const plan = requirePlan(reply, parsed.data.planId);
    if (!plan) return;
    return { ok: true, plan: decoratePlanWithMedia(plan) };
  });

  /** 删除整份行程（归档页管理动作）：落盘文件 + 内存 + 分享码映射一并清理 */
  app.delete<{ Params: { planId: string } }>("/travel/plans/:planId", async (request, reply) => {
    if (!requireService(reply)) return;
    const parsed = planIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const removed = travelPlanStore.remove(parsed.data.planId);
    if (!removed) {
      return reply.code(404).send({ ok: false, error: `行程不存在：${parsed.data.planId}` });
    }
    travelShareStore.removeForPlan(parsed.data.planId);
    return { ok: true };
  });

  // ======================== 行程编辑 ========================

  /** 替换/微调单个条目：body 中出现的字段覆盖原值，直接返回更新后的完整 plan（顶层即 plan 对象） */
  app.patch<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const patch = itemPatchSchema.safeParse(request.body);
      if (!patch.success) {
        return reply.code(400).send({ ok: false, error: patch.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      if (!checkVersion(reply, plan, request)) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      // 坐标被改动时，该条目起的交通腿/时间已失真 → 局部重排（与 skill replace 同口径）
      const coordChanged =
        (patch.data.latitude != null && patch.data.latitude !== item.latitude) ||
        (patch.data.longitude != null && patch.data.longitude !== item.longitude);
      plan.days[params.data.dayIndex]!.items[params.data.itemIndex] = { ...item, ...patch.data };
      if (coordChanged) {
        await deps.travelPlanningService!.retimeDayAfterEdit(
          plan.days[params.data.dayIndex]!.items,
          params.data.itemIndex,
        );
      }
      travelPlanStore.save(plan);
      return plan;
    },
  );

  /** 删除单个条目，直接返回更新后的完整 plan（顶层即 plan 对象） */
  app.delete<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      if (!checkVersion(reply, plan, request)) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      plan.days[params.data.dayIndex]!.items.splice(params.data.itemIndex, 1);
      // 局部重排：删除点之后条目的交通腿/时间按新相邻关系重算
      if (plan.days[params.data.dayIndex]!.items.length > params.data.itemIndex) {
        await deps.travelPlanningService!.retimeDayAfterEdit(
          plan.days[params.data.dayIndex]!.items,
          params.data.itemIndex,
        );
      }
      travelPlanStore.save(plan);
      return plan;
    },
  );

  /** 新增条目：type+name 经 searchPois 定位（精确名优先），追加到该天末尾并局部重排当天时间轴 */
  app.post<{ Params: { planId: string; dayIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const service = deps.travelPlanningService!;
      const params = dayIndexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const body = itemAddSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      if (!checkVersion(reply, plan, request)) return;
      const day = plan.days[params.data.dayIndex];
      if (!day) {
        return reply.code(400).send({
          ok: false,
          error: `索引越界：dayIndex=${params.data.dayIndex}（共 ${plan.days.length} 天）`,
        });
      }
      let candidates: Awaited<ReturnType<typeof service.searchPois>> = [];
      try {
        candidates = await service.searchPois(plan.destination, body.data.type, body.data.name, 5);
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: `候选 POI 搜索失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (candidates.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: `「${plan.destination}」未找到匹配地点（关键词：${body.data.name}），可改用 GET /travel/poi-search 浏览候选`,
        });
      }
      const exact = candidates.find(
        (c) => c.name.trim().toLowerCase() === body.data.name.trim().toLowerCase(),
      );
      const poi = exact ?? candidates[0]!;
      const quote = quoteFor(poi.name, poi.tags || [], body.data.type, {
        destination: plan.destination,
        preferences: {},
      });
      const explicitStart = body.data.startTime?.trim();
      day.items.push({
        type: body.data.type,
        name: poi.name,
        // 占位时刻：局部重排会按新坐标与当天时钟重算（显式指定 startTime 时作为锚点保留）
        startTime: explicitStart || "19:00",
        // 显式指定时刻 = 用户钉住该时间 → 标记时间锚点（重排保护 + 客户端徽章）
        ...(explicitStart ? { anchor: true } : {}),
        latitude: poi.latitude,
        longitude: poi.longitude,
        address: poi.address || "",
        priceInfo: formatQuotePriceInfo(quote),
        description: service.describePoi(poi, body.data.type),
        ...(poi.splatUrl ? { splatUrl: poi.splatUrl } : {}),
        reviews: [],
        videos: [],
      });
      // 局部重排（P0）：新条目起的当天时间轴按真实坐标重算
      await service.retimeDayAfterEdit(day.items, day.items.length - 1, {
        keepFirstStartTime: Boolean(explicitStart),
      });
      travelPlanStore.save(plan);
      return plan;
    },
  );

  /** 「提意见换一个」：按原条目类型与坐标找同类替代 POI，重新计价后替换（保留原 startTime），直接返回更新后的完整 plan */
  app.post<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex/comment",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const service = deps.travelPlanningService!;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const body = commentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      if (!checkVersion(reply, plan, request)) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      if (!(POI_TYPES as readonly string[]).includes(item.type)) {
        return reply.code(400).send({ ok: false, error: `该条目类型（${item.type}）不支持换一换` });
      }
      const type = item.type as PoiType;
      let poi;
      try {
        poi = await service.findAlternativePoi(type, item.latitude, item.longitude, item.name, body.data.comment);
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: `替代 POI 搜索失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!poi) {
        return reply.code(404).send({
          ok: false,
          error: "未找到可替换的同类地点：附近搜索无结果，请稍后重试或直接编辑条目内容",
        });
      }
      const quote = quoteFor(poi.name, poi.tags || [], type, {
        destination: plan.destination,
        preferences: {},
      });
      plan.days[params.data.dayIndex]!.items[params.data.itemIndex] = {
        ...item,
        type,
        name: poi.name,
        latitude: poi.latitude,
        longitude: poi.longitude,
        address: poi.address || item.address,
        priceInfo: formatQuotePriceInfo(quote),
        description: service.describePoi(poi, type),
        tips: item.tips,
        images: poi.images && poi.images.length > 0 ? poi.images : [],
        reviews: [],
        videos: [],
      };
      // 局部重排（P0）：新坐标变了，被替换条目起的交通腿与时间全部按新位置重算
      await service.retimeDayAfterEdit(
        plan.days[params.data.dayIndex]!.items,
        params.data.itemIndex,
      );
      travelPlanStore.save(plan);
      return plan;
    },
  );

  // ======================== 行程进度（跨端共享「已走/当前站」） ========================

  const progressSchema = z.object({
    day: z.coerce.number().int().min(0).max(60),
    stop: z.coerce.number().int().min(0).max(200),
  });

  /**
   * 上报行程进度（设备状态）：手机端切站时防抖上报，桌面端/下次打开恢复。
   * 不做版本校验、不自增乐观锁 —— 进度不是内容编辑，避免手机端走行程
   * 把桌面端并发的编辑请求打成 409。
   */
  app.patch<{ Params: { planId: string } }>(
    "/travel/plans/:planId/progress",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const parsed = planIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const body = progressSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      const ok = travelPlanStore.updateProgress(
        parsed.data.planId,
        body.data.day,
        body.data.stop,
      );
      if (!ok) {
        return reply.code(404).send({ ok: false, error: "plan not found" });
      }
      const plan = travelPlanStore.get(parsed.data.planId);
      return { ok: true, progress: plan?.progress ?? null };
    },
  );

  /** 读取行程进度（无进度记录时 progress 为 null） */
  app.get<{ Params: { planId: string } }>(
    "/travel/plans/:planId/progress",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const parsed = planIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const plan = travelPlanStore.get(parsed.data.planId);
      if (!plan) {
        return reply.code(404).send({ ok: false, error: "plan not found" });
      }
      return { ok: true, progress: plan.progress ?? null };
    },
  );

  // ======================== 行程实时信号（Agent 侧感知，页面只被动呈现） ========================

  /** 从条目 startTime（"HH:mm" / "YYYY-MM-DDTHH:mm:00"）取当日分钟 */
  const startMinOf = (startTime: string): number => {
    const m = /(\d{1,2}):(\d{2})/.exec(startTime ?? "");
    if (!m) return 9 * 60;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  /**
   * 行程实时信号：Agent 侧感知（设计稿 PA_TRAVEL_SIGNAL 的确定性判定薄版）。
   * - rain：目的地实时天气（PlanningService.signalWeather，Open-Meteo）判当日雨天；
   * - behind：当天行程 + 用户进度站点的建议时段已过 20 分钟仍停在原地。
   * tired（体力感知）暂无感知源，不返回。客户端在行程页呈现气泡与节奏文案，
   * 页面不做任何主动改判 —— 与「前端只呈现，重排在 Agent 侧」契约一致。
   */
  app.get<{ Params: { planId: string } }>(
    "/travel/plans/:planId/signal",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const parsed = planIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const plan = requirePlan(reply, parsed.data.planId);
      if (!plan) return;

      const now = new Date();
      const two = (v: number): string => v.toString().padStart(2, "0");
      const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
      const nowMin = now.getHours() * 60 + now.getMinutes();

      let event: "rain" | "behind" | null = null;
      let mood: string | null = null;
      let note: string | null = null;

      // ① 目的地实时天气 → rain（老桩/未注入 signalWeather 时跳过）
      if (plan.center) {
        const svc = deps.travelPlanningService!;
        const wx =
          typeof svc.signalWeather === "function"
            ? await svc.signalWeather(plan.center).catch(() => null)
            : null;
        if (wx?.rainy) {
          event = "rain";
          mood = "雨天室内";
          note = `Agent 感知到目的地天气变化（${wx.summaryLine}）· 室内安排已优先`;
        }
      }

      // ② 当天行程 + 进度站点时段已过 → behind
      if (!event && plan.progress) {
        const day = plan.days[plan.progress.day];
        if (day && day.date === today) {
          const cur = day.items[plan.progress.stop];
          if (cur) {
            const endMin = startMinOf(cur.startTime) + (cur.visitDuration ?? 60);
            if (nowMin > endMin + 20) {
              event = "behind";
              mood = "追赶中";
              note = `Agent 感知到进度落后 · 「${cur.name}」的建议时段已过，正在为你压缩后续停留`;
            }
          }
        }
      }

      return { ok: true, event, mood, note, checkedAt: now.getTime() };
    },
  );

  // ======================== POI 搜索（单项编辑器） ========================

  /** 搜索目的地指定类型 POI 备选（≤8 条，含计价后的 priceInfo） */
  app.get("/travel/poi-search", async (request, reply) => {
    if (!requireService(reply)) return;
    const service = deps.travelPlanningService!;
    const parsed = poiSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { destination, type, keyword } = parsed.data;
    try {
      const pois = await service.searchPois(destination, type, keyword, 8);
      return { ok: true, pois };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `POI 搜索失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ======================== 预订报价 ========================

  /**
   * 预订报价：从行程提取预订项——酒店 × 住宿晚数（plan.days 数）、景点门票 ×1、
   * 餐厅人均 ×1；逐项走 PricingService 报价（会员等级 + 绑定平台优惠）并汇总。
   */
  app.post<{ Params: { planId: string } }>("/travel/plans/:planId/booking", async (request, reply) => {
    if (!requireService(reply)) return;
    const params = planIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: params.error.flatten() });
    }
    const body = bookingSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: body.error.flatten() });
    }
    const plan = requirePlan(reply, params.data.planId);
    if (!plan) return;

    const ctx: PricingContext = {
      destination: plan.destination,
      preferences: {},
      memberTier: body.data.memberTier,
      boundPlatforms: normalizePlatforms(body.data.boundPlatforms),
    };
    const nights = Math.max(1, plan.days.length);
    const items: Array<{
      name: string;
      type: PoiType;
      unitPrice: number;
      count: number;
      originalPrice: number;
      finalPrice: number;
      /** 折扣标签数组（前端直接展示） */
      discounts: string[];
      /** 折扣明细（member/platformBenefits，调试与详情用） */
      discountDetail?: PriceQuote["breakdown"];
    }> = [];
    let totalOriginal = 0;
    let totalFinal = 0;
    for (const day of plan.days) {
      for (const item of day.items) {
        if (!(POI_TYPES as readonly string[]).includes(item.type)) continue;
        const type = item.type as PoiType;
        const quote = quoteFor(item.name, [], type, ctx);
        const count = type === "hotel" ? nights : 1;
        const originalPrice = quote.originalPrice * count;
        const finalPrice = quote.finalPrice * count;
        const labels: string[] = [];
        if (quote.breakdown?.member?.label) labels.push(quote.breakdown.member.label);
        for (const benefit of quote.breakdown?.platformBenefits ?? []) {
          if (benefit.label) labels.push(benefit.label);
        }
        items.push({
          name: item.name,
          type,
          // 折后单价（对齐 3D-Travel 展示口径：finalUnit × 数量）
          unitPrice: quote.finalPrice,
          count,
          originalPrice,
          finalPrice,
          discounts: labels,
          ...(labels.length > 0 ? { discountDetail: quote.breakdown } : {}),
        });
        totalOriginal += originalPrice;
        totalFinal += finalPrice;
      }
    }
    return {
      ok: true,
      items,
      totalOriginal,
      totalFinal,
      totalSaved: totalOriginal - totalFinal,
    };
  });

  // ======================== 收藏同步（C5） ========================

  /** 收藏列表（key 为「type:name」，与客户端本地收藏同键格式） */
  app.get("/travel/favorites", async () => ({
    ok: true,
    favorites: travelFavoritesStore.list(),
  }));

  /** 全量同步收藏（客户端 toggle 后 fire-and-forget 调用） */
  app.post("/travel/favorites", async (request, reply) => {
    const body = favoritesSyncSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: body.error.flatten() });
    }
    const favorites = travelFavoritesStore.replaceAll(body.data.favorites);
    return { ok: true, favorites };
  });

  // ======================== 分享 ========================

  /** 生成 8 位分享码（同一行程重复分享复用已有码） */
  app.post<{ Params: { planId: string } }>("/travel/plans/:planId/share", async (request, reply) => {
    if (!requireService(reply)) return;
    const params = planIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: params.error.flatten() });
    }
    const plan = requirePlan(reply, params.data.planId);
    if (!plan) return;
    return { ok: true, shareCode: travelShareStore.codeFor(plan.planId) };
  });

  /** 按分享码读完整行程（只读分享视图；独立前缀避免与 :planId 参数段匹配歧义） */
  app.get<{ Params: { code: string } }>("/travel/share/:code", async (request, reply) => {
    if (!requireService(reply)) return;
    const code = request.params.code.trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return reply.code(400).send({ ok: false, error: "分享码格式非法" });
    }
    const planId = travelShareStore.resolve(code);
    if (!planId) {
      return reply.code(404).send({ ok: false, error: `分享码无效：${code}` });
    }
    const plan = requirePlan(reply, planId);
    if (!plan) return;
    return { ok: true, plan };
  });

  /**
   * 分享 H5 只读页（B6）：分享码离开客户端后的传播载体。
   * 自包含单文件 HTML（内联样式，无外部资源），手机浏览器直接打开即可阅读；
   * 每个条目附高德/Google 地图跳转链接。数据与 /travel/share/:code 同源。
   */
  app.get<{ Params: { code: string } }>("/travel/share/:code/page", async (request, reply) => {
    if (!requireService(reply)) return;
    const code = request.params.code.trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return reply.code(400).type("text/html; charset=utf-8").send("<h1>分享码格式非法</h1>");
    }
    const planId = travelShareStore.resolve(code);
    const plan = planId ? travelPlanStore.get(planId) : null;
    if (!plan) {
      return reply.code(404).type("text/html; charset=utf-8").send(
        renderSharePage(null, code),
      );
    }
    return reply.type("text/html; charset=utf-8").send(renderSharePage(plan, code));
  });
}

/** HTML 转义（分享页渲染用户生成内容用） */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SHARE_PAGE_TYPE_LABEL: Record<string, string> = {
  attraction: "景点",
  hotel: "酒店",
  restaurant: "餐厅",
};

/** 渲染分享只读页（plan 为 null 时输出 404 文案） */
function renderSharePage(
  plan: StoredTravelPlan | null,
  code: string,
): string {
  if (!plan) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享码无效</title></head><body style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#101418;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><div style="font-size:40px">🧭</div><p>分享码无效或行程已被清理：${esc(code)}</p></div></body></html>`;
  }
  const daysHtml = plan.days
    .map((day, di) => {
      const rows = (day.items ?? [])
        .map((it) => {
          const maps = Number.isFinite(it.latitude) && Number.isFinite(it.longitude)
            ? `https://uri.amap.com/marker?position=${it.longitude},${it.latitude}&name=${encodeURIComponent(it.name)}`
            : null;
          return `<li><div class="t">${esc(it.startTime ?? "")}<span class="tag">${esc(SHARE_PAGE_TYPE_LABEL[it.type] ?? it.type)}</span></div><div class="n">${esc(it.name)}</div>${it.priceInfo ? `<div class="p">${esc(it.priceInfo)}</div>` : ""}${it.address ? `<div class="a">${esc(it.address)}</div>` : ""}${maps ? `<a class="m" href="${esc(maps)}" target="_blank" rel="noopener">地图查看 →</a>` : ""}</li>`;
        })
        .join("");
      return `<section class="day"><h2>Day ${di + 1} · ${esc(day.date ?? "")}</h2><ul>${rows || "<li class='empty'>当天暂无安排</li>"}</ul></section>`;
    })
    .join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(plan.title || `${plan.destination}行程`)}</title><style>
body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#101418;color:#e8eaed;margin:0;padding:24px 16px 48px}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#9aa0a6;font-size:13px;margin-bottom:20px}
.day{background:#1a2027;border-radius:14px;padding:16px;margin-bottom:14px}
.day h2{font-size:15px;margin:0 0 10px;color:#8ab4f8}
ul{list-style:none;margin:0;padding:0}
li{padding:10px 0;border-bottom:1px solid #232a32}
li:last-child{border-bottom:0}
li.empty{color:#5f6368}
.t{font-size:12px;color:#9aa0a6}
.tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;font-size:11px;background:#23303d;color:#8ab4f8}
.n{font-size:15px;font-weight:600;margin-top:2px}
.p{font-size:13px;color:#81c995;margin-top:2px}
.a{font-size:12px;color:#9aa0a6;margin-top:2px}
.m{display:inline-block;margin-top:6px;font-size:12px;color:#8ab4f8;text-decoration:none}
.foot{color:#5f6368;font-size:11px;text-align:center;margin-top:24px}
</style></head><body><div class="wrap"><h1>${esc(plan.title || `${plan.destination}行程`)}</h1><div class="sub">${esc(plan.destination)} · ${esc(plan.startDate ?? "")} ~ ${esc(plan.endDate ?? "")}${plan.totalCost ? ` · 预算约 ¥${esc(Math.round(plan.totalCost))}` : ""}</div>${daysHtml}<div class="foot">由 Private-Agent 行程规划生成 · 分享码 ${esc(code)} · 价格为估算参考</div></div></body></html>`;
}
