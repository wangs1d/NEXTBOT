/**
 * 内置 Skill：旅游规划（travel.*）
 *
 * 来源：3D-Travel 项目的人工智能行程规划引擎（规则引擎 + POI 缓存 + 目的地知识库）
 * 被本项目 agent 直接接管：用户表达出行需求时，agent 调用以下 skill 完成规划。
 *
 * 能力组：
 *   - travel.plan-itinerary   主入口：生成完整行程（按天拆分景点/酒店/餐厅/交通/价格）
 *   - travel.search-poi       浏览目的地 POI（景点/酒店/餐厅）
 *   - travel.destination-info 目的地实用信息（签证/货币/最佳季节/应急等）
 *   - travel.compute-route    两点间交通计算
 *   - travel.get-itinerary    行程明细按需回查（冷层）
 *   - travel.edit-itinerary   聊天式行程编辑（删除/同类替换/字段微调）
 *
 * 数据流：缓存优先 → 网络实时搜索（高德/OSM，失败自动降级）→ 内置知识库/合成兜底。
 */
import type { SkillDefinition } from "../types.js";
import type { PlanningService, PlannedDay, POISummary } from "./travel-planning-service.js";
import { travelItineraryStore } from "./travel-itinerary-store.js";
import { travelPlanStore, type StoredTravelPlan } from "./travel-plan-store.js";
import { travelTileCache } from "../../services/travel-tile-cache.js";
import {
  pricingService,
  formatQuotePriceInfo,
  type PriceQuote,
} from "./pricing-service.js";

type Deps = {
  travelPlanningService: PlanningService;
  /** 旅行画像读取口（travel-upgrade-plan 画像引擎）：出片向/体验向等长期偏好，
   * 规划时静默并入偏好推断，用户无需每次重说。按 sessionId（=actorId）查询。 */
  getUserTravelProfile?: (sessionId?: string) => {
    photoDriven?: boolean;
    experienceDriven?: boolean;
    /** travel 双端②：攻略页「不感兴趣」累积的负向偏好（同类标签 + 具体 POI 名） */
    dislikeTags?: string[];
    dislikeNames?: string[];
    /** travel 双端③：旅行人格分型（徽章 + 每日密度微调） */
    persona?: { id: "shutter" | "explorer" | "curator" | "wanderer"; label: string; desc: string };
  } | undefined;
  /**
   * POI 打卡视频回填口（travel 视频下放）：行程落盘后后台补视频（fire-and-forget
   * 不阻塞规划），每景点最多 1 条真实相关播放页，命中写回 plan 冷层。
   * 未注入 = 不回填（视频块缺省，前端隐藏）。
   */
  poiVideoBackfill?: (plan: StoredTravelPlan) => void;
};

/** 按条目类型选计价入口（edit-itinerary 的 replace 路径复用 HTTP comment 端点的口径） */
function quoteByType(
  service: typeof pricingService,
  name: string,
  tags: string[],
  type: "attraction" | "hotel" | "restaurant",
  destination: string,
): PriceQuote {
  const ctx = { destination, preferences: {} };
  if (type === "hotel") return service.quoteHotel(name, tags, ctx);
  if (type === "attraction") return service.quoteAttraction(name, tags, ctx);
  return service.quoteRestaurant(name, tags, ctx);
}

/**
 * 行程条目字段映射（StoredDayItem 结构，travel-planning-service 的 days → 落盘/快照）。
 * 原先在 itineraryStore 与 planStore 两处各抄一份完全相同的映射，现统一于此。
 * transportFromPrev/visitDuration 一并落盘：编辑局部重排与前端展示依赖。
 */
function mapDaysToStored(days: PlannedDay[] | undefined) {
  return (days ?? []).map((day) => ({
    date: day.date ?? "",
    items: (day.items ?? []).map((item) => ({
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
      // travel 双端②：「为什么推荐给你」随冷层/快照透传到攻略页
      recommendReason: item.recommendReason,
    })),
  }));
}

/** 候选 POI 池映射（行程卡地图常驻展示用，两处写入共用） */
function mapPoisToStored(pois: POISummary[] | undefined) {
  return (pois ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    latitude: p.latitude,
    longitude: p.longitude,
    address: p.address,
    rating: p.rating,
  }));
}

/**
 * 行程编辑后刷新结构化快照：让同一会话内随后产出的 travel_itinerary 卡直读改后数据。
 * 由 StoredTravelPlan 重建快照（候选 POI 池/偏好等编辑路径不涉及的字段留空）。
 */
function refreshItinerarySnapshot(plan: StoredTravelPlan): void {
  if (!plan.destination) return;
  travelItineraryStore.set({
    toolName: "travel.edit-itinerary",
    ts: Date.now(),
    planId: plan.planId,
    ...(plan.dataQuality ? { dataQuality: plan.dataQuality } : {}),
    destination: plan.destination,
    title: plan.title,
    startDate: plan.startDate,
    endDate: plan.endDate,
    center: plan.center,
    // 海报区字段随编辑后冷层回读保留（封面/简介/叮嘱），海报不因编辑退回兜底
    ...(plan.intro ? { intro: plan.intro } : {}),
    ...(plan.packing ? { packing: plan.packing } : {}),
    ...(plan.coverImage ? { coverImage: plan.coverImage } : {}),
    // 旅行人格分型随编辑后快照保留（travel 双端③）
    ...(plan.persona ? { persona: plan.persona } : {}),
    days: plan.days.map((day) => ({
      date: day.date,
      items: day.items.map((item) => ({ ...item })),
    })),
  });
}

/**
 * B3 偏好记忆：召回同目的地历史行程中用户表达过的偏好标签。
 * 查询文本含目的地关键词的近期行程（≤2 份）→ 取 preferences 去重（≤6 个）。
 * 查不到返回空数组，不阻塞规划主流程。
 */
function recallSameDestinationPreferenceLabels(
  destOrInput: string,
  currentPrefs: string[],
): string[] {
  try {
    const summaries = travelPlanStore.listSummaries(8);
    const text = destOrInput.toLowerCase();
    const matched: string[] = [];
    for (const s of summaries) {
      const dest = (s.destination || "").toLowerCase();
      if (!dest || (!text.includes(dest) && !dest.includes(text))) continue;
      const plan = travelPlanStore.get(s.planId);
      for (const p of plan?.preferences ?? []) {
        const label = p.trim();
        if (label && !matched.includes(label) && !currentPrefs.includes(label)) {
          matched.push(label);
        }
      }
      if (matched.length >= 6) break;
    }
    return matched.slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * 生成结果中按天行程的摘要（LLM 工具返回值）。
 *
 * 瘦身原则：本返回值会整体进入 LLM 上下文。行程明细（按天条目/时间/坐标/
 * 图片/评论/价格/贴士）一律不下发——前端经 travelItineraryStore →
 * travel_itinerary 卡结构化直读完整数据并展开双面板，全程不经过 LLM。
 * LLM 只需要知道「规划成功了、大致是什么」：目的地/天数/日期/总花费 +
 * 少量亮点名（让口头转述自然），外加展示指令（禁止复述 JSON/逐条罗列）。
 * 5 天行程可省数千 token/轮。
 */
function summarizeItinerary(result: unknown): Record<string, unknown> {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "规划引擎未返回有效结果" };
  const days = Array.isArray(r.days) ? (r.days as Array<Record<string, unknown>>) : [];
  // 亮点：每天前 2 个条目名（只取名字，无任何明细），总量封顶 10 个
  const highlights: string[] = [];
  for (const day of days) {
    const items = Array.isArray(day?.items) ? (day.items as Array<Record<string, unknown>>) : [];
    for (const it of items.slice(0, 2)) {
      if (highlights.length >= 10) break;
      const name = typeof it?.name === "string" ? it.name.trim() : "";
      if (name) highlights.push(name);
    }
    if (highlights.length >= 10) break;
  }
  const pricing = r.pricingSummary as Record<string, unknown> | null | undefined;
  const totalFinal = Number(pricing?.totalFinal);
  const quality = typeof r.dataQuality === "string" ? r.dataQuality : "real";
  const qualityNote =
    quality === "synthetic"
      ? "（注意：当前为离线合成占位数据，请在回复中明确告知用户这是估算结果，建议联网后重新规划）"
      : quality === "knowledge"
        ? "（注意：当前为内置知识库数据，景点/酒店为真实地点但非实时搜索结果，可顺带向用户说明）"
        : "";
  return {
    ok: true,
    id: r.id,
    title: r.title,
    destination: r.destination,
    startDate: r.startDate,
    endDate: r.endDate,
    dayCount: days.length,
    ...(Number.isFinite(totalFinal) && totalFinal > 0 ? { totalCost: Math.round(totalFinal) } : {}),
    ...(highlights.length > 0 ? { highlights } : {}),
    dataQuality: quality,
    bookingHint:
      "用户想订行程中的酒店或机票时，直接用 travel_booking.search 实时比价（飞猪实时价，酒店/机票选项自带预订链接）" +
      "→ travel_booking.book 两阶段确认下单，无需让用户自己去平台下单。",
    displayNote:
      qualityNote +
      "完整行程会以独立的行程卡附在回复最末尾，卡面直接逐日展示安排，" +
      "用户点卡片上的「打开行程规划」可进入双面板查看全部明细，卡片保留在回复中供随时回看。" +
      "请勿在回复中复述 JSON、逐条罗列行程或重复任何明细数据；" +
      "用一两句话自然告知用户行程已排好（目的地/天数/亮点一句带过）即可。",
  };
}

export function createTravelPlanningBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { travelPlanningService, getUserTravelProfile, poiVideoBackfill } = deps;

  /** 1. 生成完整行程（主入口） */
  const plan_itinerary: SkillDefinition = {
    metadata: {
      name: "travel.plan-itinerary",
      version: "1.0.0",
      displayName: "生成旅游行程规划",
      description:
        "根据用户的目的地、天数与偏好生成完整结构化行程：按天拆分景点/酒店/餐厅，含时间安排、交通衔接、建议游览时长、小贴士、预订提示与价格汇总。" +
        "【强制调用】凡回复要给出具体行程安排（按天/按时段列景点、交通、餐厅的表格或清单），必须先调用本工具生成行程卡，" +
        "严禁不调工具自己手写逐日行程——系统会把结构化行程卡附在回复末尾（可点开看地图与逐日明细），手写文本没有这张卡。" +
        "触发表达包括但不限于「帮我规划去X的行程」「去X玩几天怎么安排」「X旅游攻略」「X自由行」「周末附近游玩」；" +
        "规划对话进行中用户只回复目的地名称（如单独发「兴义」）或天数/偏好时，同样视为规划请求，必须调用。" +
        "参数：input 为自然语言需求（如「去成都玩5天，喜欢美食和古迹，预算中等」）；destination 可显式指定目的地；days 指定天数；preferences 为偏好标签数组。" +
        "若 input 已含目的地/天数/偏好则无需重复传参。生成后可配合 travel.destination-info 补充签证/货币等实用信息。" +
        "用户想订行程中的酒店/机票时，接 travel_booking.search 实时比价（飞猪实时价，选项自带预订链接）→ travel_booking.book 两阶段确认下单。",
      kind: "builtin",
      tags: ["travel", "行程规划", "旅游", "攻略", "itinerary", "自由行", "出行"],
      icon: "🗺️",
      parameters: [
        { name: "input", type: "string", required: true, description: "用户自然语言需求（如「去成都玩5天，喜欢美食和古迹」）" },
        { name: "destination", type: "string", required: false, description: "目的地（如 成都/大理/东京），input 已含时可不传" },
        { name: "days", type: "number", required: false, description: "行程天数，默认 3" },
        { name: "preferences", type: "array", required: false, description: "偏好标签数组（如 ['美食','古迹','亲子']）" },
      ],
      outputSchema: {
        ok: "是否成功",
        id: "行程 ID",
        title: "行程标题",
        destination: "目的地",
        startDate: "开始日期 YYYY-MM-DD",
        endDate: "结束日期 YYYY-MM-DD",
        days: "按天行程 [{date, items:[{itemId,type,name,startTime,latitude,longitude,priceInfo,...}]}]",
        pois: "行程涉及 POI 摘要列表",
        travelInfo: "目的地实用信息",
        pricingSummary: "价格汇总",
      },
      permissions: ["network:external"],
      // 冷启动（缓存未命中：地理编码+POI搜索）仍需 10~30s，保留 120s；
      // 图片/评论/视频已改为本地媒体库直读 + 后台离线回填，不再占用请求时间
      timeoutMs: 120_000,
    },
    handler: async (input, execContext) => {
      const rawInput = typeof input.input === "string" ? input.input.trim() : "";
      if (!rawInput) {
        return { ok: false, error: "缺少必填参数 input：请描述出行需求，如「去成都玩5天，喜欢美食和古迹」" };
      }
      // B3 偏好记忆：同目的地历史行程中用户表达过的偏好自动并入本次规划
      // （用户没重说也生效；跨目的地偏好不强并，避免旧旅程标签污染新需求）
      const explicitDest =
        typeof input.destination === "string" && input.destination.trim() ? input.destination.trim() : undefined;
      const userPrefs = Array.isArray(input.preferences)
        ? input.preferences.filter((p): p is string => typeof p === "string")
        : undefined;
      const memoryPrefs = recallSameDestinationPreferenceLabels(explicitDest ?? rawInput, userPrefs ?? []);
      const mergedPrefs = [...(userPrefs ?? []), ...memoryPrefs.filter((p) => !(userPrefs ?? []).includes(p))];
      try {
        // 画像静默注入（travel-upgrade-plan 画像引擎）：UserFact 里的长期旅行
        // 偏好（出片向/体验向/负向偏好/人格分型）并入本次偏好推断；
        // 原文表达优先级更高（不覆盖）。任一字段存在即传（travel 双端②③）
        const profileHints = getUserTravelProfile?.(execContext?.sessionId);
        const result = await travelPlanningService.generateItinerary({
          input: rawInput,
          // 进度流式：规划引擎各阶段经 travel-progress-bus 汇报，聊天侧按 sessionId 订阅下发
          sessionId: execContext?.sessionId,
          destination: explicitDest,
          days: typeof input.days === "number" && input.days > 0 ? input.days : undefined,
          preferences: mergedPrefs.length > 0 ? mergedPrefs : undefined,
          ...(profileHints &&
          (profileHints.photoDriven ||
            profileHints.experienceDriven ||
            (profileHints.dislikeTags?.length ?? 0) > 0 ||
            (profileHints.dislikeNames?.length ?? 0) > 0 ||
            profileHints.persona)
            ? { profileHints }
            : {}),
        });
        const quality = typeof result.dataQuality === "string" ? result.dataQuality : "real";
        // 规划完成即预热底图瓦片（fire-and-forget）：用户点开行程地图时瓦片已在
        // 本机缓存，弱网/离线也秒开。失败静默，不阻塞规划主流程。
        try {
          const warmPois = result.days
            .flatMap((d) => d.items)
            .filter((it) => Number.isFinite(it.latitude) && Number.isFinite(it.longitude))
            .slice(0, 40)
            .map((it) => ({ latitude: it.latitude, longitude: it.longitude }));
          void travelTileCache
            .warmDestination(result.center, warmPois)
            .then((r) => console.log(`[Travel] 目的地瓦片预热完成: 新拉取${r.fetched} 已缓存${r.hitCache} 失败${r.failed}`))
            .catch(() => { /* 预热失败不影响规划 */ });
        } catch { /* 预热构建失败静默 */ }
        // 写入结构化行程数据桥：travel_itinerary 卡前端可直接消费，无需文本正则
        travelItineraryStore.set({
          toolName: "travel.plan-itinerary",
          ts: Date.now(),
          planId: String(result.id ?? ""),
          dataQuality: quality,
          destination: result.destination,
          title: result.title,
          startDate: result.startDate ?? "",
          endDate: result.endDate ?? "",
          // 目的地地理编码中心：前端地图以真实目的地为中心初始化
          center: result.center,
          // 行程卡海报区文案：目的地一句话简介 + 出行随身物品叮嘱
          intro: result.travelInfo?.intro,
          packing: result.travelInfo?.packing,
          // 出发日天气摘要：行程桌面页顶栏天气胶囊（无天气数据时缺省，前端隐藏）
          weather: result.weather,
          // 行程卡海报区背景：目的地代表性封面（维基百科主图优先，见规划服务）
          coverImage: result.coverImage,
          // 旅行人格分型徽章（travel 双端③）：有分型才透传，前端无值隐藏
          ...(result.preferences?.persona ? { persona: result.preferences.persona } : {}),
          days: mapDaysToStored(result.days),
          // 候选 POI 池：全量酒店/餐厅/景点摘要（含未排入日程的备选），前端地图一并展示
          pois: mapPoisToStored(result.pois),
        });
        // 冷层落盘：完整明细按 planId 持久化，供跨轮/跨重启的 travel.get-itinerary
        // 按需回查；LLM 上下文只留 summarizeItinerary 的极简回执
        const storedPlan: StoredTravelPlan = {
          planId: String(result.id ?? ""),
          dataQuality: quality,
          destination: result.destination,
          title: result.title,
          startDate: result.startDate ?? "",
          endDate: result.endDate ?? "",
          // 目的地地理编码中心：行程路由域回读（编辑后刷新）时前端地图仍可定位
          center: result.center,
          requestInput: rawInput,
          preferences: Array.isArray(input.preferences)
            ? input.preferences.filter((p): p is string => typeof p === "string")
            : undefined,
          // 卡片海报区文案与候选 POI 池：冷层补齐后，planId 直读建卡（A4）不缺数据
          intro: result.travelInfo?.intro,
          packing: result.travelInfo?.packing,
          weather: result.weather,
          coverImage: result.coverImage,
          // 旅行人格分型（travel 双端③）：冷层也存，bootById 直读建卡不缺徽章数据
          ...(result.preferences?.persona ? { persona: result.preferences.persona } : {}),
          pois: mapPoisToStored(result.pois),
          totalCost: (result as { pricingSummary?: { totalFinal?: number } }).pricingSummary
            ?.totalFinal,
          // 预算档位（travel 双端⑥）：预算守门的判定依据（超支进晚间摘要）
          ...(result.preferences?.budget ? { budgetTier: result.preferences.budget } : {}),
          days: mapDaysToStored(result.days),
          // 交通大段（高铁/航班）：接驳提醒调度器的扫描数据源（travel-upgrade-plan P2）
          transferSegments: result.transferSegments,
          // 规划会话：接驳提醒推送给该会话（多端 fan-out 由 WS 注册表承担）
          sessionId: execContext?.sessionId,
        };
        travelPlanStore.save(storedPlan);
        // POI 打卡视频回填（travel 视频下放）：落盘后后台逐景点补 1 条真实相关
        // 播放页（fire-and-forget，不阻塞规划回执；无命中站点不带视频）
        poiVideoBackfill?.(storedPlan);
        // 乐观锁基准：规划回执带 version，模型后续编辑（edit-itinerary）凭它做冲突校验
        const savedVersion = travelPlanStore.get(String(result.id ?? ""))?.version;
        return {
          ...summarizeItinerary(result),
          ...(savedVersion != null ? { version: savedVersion } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          error: `行程规划失败：${err instanceof Error ? err.message : String(err)}`,
          hint: "规划失败不会生成估算/占位行程（真实数据保证）。可稍后重试（多为网络波动），换个表达方式描述目的地，或先用 travel.search-poi 确认目的地支持情况",
        };
      }
    },
  };

  /** 2. 浏览目的地 POI */
  const search_poi: SkillDefinition = {
    metadata: {
      name: "travel.search-poi",
      version: "1.0.0",
      displayName: "搜索目的地景点/酒店/餐厅",
      description:
        "搜索指定目的地的景点、酒店、餐厅三类 POI（含名称/评分/地址/坐标，命中缓存直接返回，未命中自动实时搜索并缓存）。" +
        "当用户想了解「X 有什么好玩的/好吃的/住的」或在规划前查看目的地的 POI 候选时调用。可与 travel.plan-itinerary 配合使用。" +
        "用户要订其中某家酒店时，用 travel_booking.search 实时比价（飞猪实时价）→ travel_booking.book 两阶段确认下单。",
      kind: "builtin",
      tags: ["travel", "POI", "景点", "酒店", "餐厅", "目的地", "搜索"],
      icon: "📍",
      parameters: [
        { name: "destination", type: "string", required: true, description: "目的地名称（如 成都/大理/东京）" },
        { name: "type", type: "string", required: false, enum: ["attraction", "hotel", "restaurant"], description: "只返回指定类型 POI" },
      ],
      outputSchema: {
        destination: "目的地",
        center: "中心坐标",
        attractions: "景点列表 [{id,name,latitude,longitude,address,rating,tags}]",
        hotels: "酒店列表",
        restaurants: "餐厅列表",
        fromCache: "是否命中缓存",
      },
      permissions: ["network:external"],
      timeoutMs: 30_000,
    },
    handler: async (input) => {
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      if (!destination) {
        return { ok: false, error: "缺少必填参数 destination" };
      }
      try {
        const type = typeof input.type === "string" ? input.type : undefined;
        const result = await travelPlanningService.searchDestination(destination, type as any);
        const pick = (list: Array<Record<string, unknown>>) =>
          list.slice(0, 20).map((p) => ({
            id: p.id,
            name: p.name,
            latitude: p.latitude,
            longitude: p.longitude,
            address: p.address,
            rating: p.rating,
            tags: p.tags,
          }));
        return {
          ok: true,
          destination: result.destination,
          center: result.center,
          count: {
            attractions: result.attractions.length,
            hotels: result.hotels.length,
            restaurants: result.restaurants.length,
          },
          attractions: type && type !== "attraction" ? [] : pick(result.attractions as any),
          hotels: type && type !== "hotel" ? [] : pick(result.hotels as any),
          restaurants: type && type !== "restaurant" ? [] : pick(result.restaurants as any),
          fromCache: result.fromCache,
        };
      } catch (err) {
        return { ok: false, error: `POI 搜索失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 3. 目的地实用信息 */
  const destination_info: SkillDefinition = {
    metadata: {
      name: "travel.destination-info",
      version: "1.0.0",
      displayName: "查询目的地实用信息",
      description:
        "查询目的地的实用出行信息：签证类型、货币汇率、时区、语言、电压插座、最佳旅行季节、紧急电话、海关禁忌与旅行小贴士。" +
        "当用户询问「去X需要签证吗」「X 用什么货币」「X 最佳旅游时间」「X 有什么注意事项」或规划行程后需要补充目的地常识时调用。",
      kind: "builtin",
      tags: ["travel", "签证", "货币", "最佳季节", "时差", "目的地", "攻略"],
      icon: "🛂",
      parameters: [
        { name: "destination", type: "string", required: true, description: "目的地名称（如 巴厘岛/东京/巴黎）" },
      ],
      outputSchema: {
        ok: "是否成功",
        destination: "目的地",
        visa: "签证要求 {required,type,notes}",
        currency: "货币 {name,code,symbol,rateToCNY}",
        timezone: "时区 {name,offset}",
        language: "主要语言数组",
        voltage: "电压",
        socket: "插座类型",
        bestSeason: "最佳季节 {months,description}",
        emergency: "紧急联系电话",
        customs: "海关/习俗禁忌",
        tips: "旅行小贴士数组",
      },
      permissions: [],
      timeoutMs: 10_000,
    },
    handler: async (input) => {
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      if (!destination) {
        return { ok: false, error: "缺少必填参数 destination" };
      }
      try {
        const info = await travelPlanningService.getDestinationInfo(destination);
        return { ok: true, ...info };
      } catch (err) {
        return { ok: false, error: `目的地信息查询失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 4. 两点间交通计算 */
  const compute_route: SkillDefinition = {
    metadata: {
      name: "travel.compute-route",
      version: "1.0.0",
      displayName: "计算两点间交通",
      description:
        "计算两个地点之间的交通方式、预计耗时与距离。" +
        "from/to 支持「地名」（自动地理编码）或「纬度,经度」坐标。当用户询问「从A到B多远/多久」「两个景点之间怎么走」时调用。",
      kind: "builtin",
      tags: ["travel", "交通", "路线", "距离", "耗时", "route"],
      icon: "🚗",
      parameters: [
        { name: "from", type: "string", required: true, description: "起点（地名或「纬度,经度」）" },
        { name: "to", type: "string", required: true, description: "终点（地名或「纬度,经度」）" },
      ],
      outputSchema: {
        ok: "是否成功",
        mode: "交通方式（walking/driving/transit/cycling/taxi）",
        durationMin: "预计耗时（分钟）",
        distanceKm: "距离（公里）",
        note: "备注",
      },
      permissions: ["network:external"],
      timeoutMs: 15_000,
    },
    handler: async (input) => {
      const from = typeof input.from === "string" ? input.from.trim() : "";
      const to = typeof input.to === "string" ? input.to.trim() : "";
      if (!from || !to) {
        return { ok: false, error: "缺少必填参数 from 或 to" };
      }
      try {
        const result = await travelPlanningService.computeRoute(from, to);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: `交通计算失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 5. 行程明细回查（冷层按需读取，替代把明细常驻上下文） */
  const get_itinerary: SkillDefinition = {
    metadata: {
      name: "travel.get-itinerary",
      version: "1.0.0",
      displayName: "回查已生成的行程明细",
      description:
        "按 planId 或目的地回查已生成的行程明细（分天条目：时间/名称/价格/地址/贴士）。" +
        "行程规划完成后对话中只保留摘要，用户追问行程细节（如「第一天住哪」「第二天怎么安排」「酒店多少钱」）" +
        "或要求调整某天安排时调用此工具按需读取。不传 day 返回逐天概览（条目名级），传 day 返回该天完整明细。" +
        "两者都不传时返回最近几份行程列表（供确认用户指的是哪份）。",
      kind: "builtin",
      tags: ["travel", "行程", "回查", "明细", "itinerary"],
      icon: "🔎",
      parameters: [
        { name: "planId", type: "string", required: false, description: "行程 ID（回执中的 id 字段，如 plan-1788076649218）" },
        { name: "destination", type: "string", required: false, description: "目的地（无 planId 时按目的地匹配最近一份）" },
        { name: "day", type: "number", required: false, description: "天序号（1 起）。传入时返回该天完整明细，否则返回逐天概览" },
      ],
      outputSchema: {
        ok: "是否成功",
        plan: "行程概要 {planId,title,destination,startDate,endDate,dayCount,totalCost}",
        days: "逐天概览 [{date, items:[{type,name,startTime,priceInfo}]}]（不传 day 时）",
        dayDetail: "单天完整明细（传 day 时）：{date, items:[…含地址/描述/贴士/坐标]}",
        hint: "展示提示",
      },
      permissions: [],
      timeoutMs: 5_000,
    },
    handler: async (input) => {
      const planId = typeof input.planId === "string" ? input.planId.trim() : "";
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      const day = typeof input.day === "number" && input.day > 0 ? Math.floor(input.day) : 0;

      let plan = planId ? travelPlanStore.get(planId) : null;
      if (!plan && destination) plan = travelPlanStore.findByDestination(destination);
      if (!plan) {
        const recent = travelPlanStore.listSummaries(5);
        if (recent.length === 0) {
          return { ok: false, error: "还没有已保存的行程", hint: "可先用 travel.plan-itinerary 生成行程" };
        }
        return {
          ok: true,
          recentPlans: recent,
          hint: "未指定 planId/destination，以上是最近生成的行程列表；请确认后带上 planId 再查明细",
        };
      }

      const overview = {
        planId: plan.planId,
        title: plan.title,
        destination: plan.destination,
        startDate: plan.startDate,
        endDate: plan.endDate,
        dayCount: plan.days.length,
        // 乐观锁基准：模型编辑（edit-itinerary 的 version 参数）以此为准
        ...(plan.version != null ? { version: plan.version } : {}),
        ...(plan.totalCost != null ? { totalCost: plan.totalCost } : {}),
      };

      if (day > 0) {
        const d = plan.days[day - 1];
        if (!d) {
          return { ok: true, plan: overview, error: `只有 ${plan.days.length} 天，没有第 ${day} 天` };
        }
        return {
          ok: true,
          plan: overview,
          dayDetail: d,
          hint: "以上是完整天明细，仅用于回答用户本次追问；不要逐条复述，对话保持自然",
        };
      }

      // 概览：条目名级（不含描述/贴士/坐标），控制 token；index 供 edit-itinerary 定位
      return {
        ok: true,
        plan: overview,
        days: plan.days.map((d, dayIdx) => ({
          day: dayIdx + 1,
          date: d.date,
          items: d.items.map((it, itemIdx) => ({
            index: itemIdx + 1,
            type: it.type,
            name: it.name,
            startTime: it.startTime,
            priceInfo: it.priceInfo,
          })),
        })),
        hint: "day=天数（1 起），items[].index=条目序号（1 起）——两者即 travel.edit-itinerary 的定位参数。需要完整明细时带上 day 参数再调",
      };
    },
  };

  /** 5.5 接驳应答落盘（travel-upgrade-plan P2）：用户对接驳提醒说「要/不要」后，
   *  模型先调本工具把状态写回行程段（防调度器重复打扰），再说/走 ride_hailing。 */
  const pickup_answer: SkillDefinition = {
    metadata: {
      name: "travel.pickup-answer",
      version: "1.0.0",
      displayName: "记录接驳应答",
      description:
        "用户对接驳提醒（高铁/航班到站前询问是否预约滴滴）作出答复后，把答复落盘。" +
        "用户明确说需要接驳/要叫车 → accepted=true；明确拒绝/自己安排 → accepted=false。" +
        "落盘后若 accepted=true，继续调用 ride_hailing.quote → ride_hailing.book 真实下单" +
        "（scheduleAt 用票面到达时刻；起点=到达车站/机场，终点=行程酒店）。",
      kind: "builtin",
      tags: ["travel", "接驳", "滴滴", "pickup", "transfer"],
      icon: "🚕",
      parameters: [
        { name: "planId", type: "string", required: true, description: "行程 ID（接驳提醒事件里的 planId）" },
        { name: "segmentNo", type: "string", required: true, description: "车次/航班号（提醒事件 segment.no）" },
        { name: "accepted", type: "boolean", required: true, description: "用户是否需要接驳" },
      ],
      outputSchema: {
        ok: "是否成功",
        hint: "后续动作提示",
      },
      permissions: [],
      timeoutMs: 5_000,
    },
    handler: async (input) => {
      const planId = typeof input.planId === "string" ? input.planId.trim() : "";
      const segmentNo = typeof input.segmentNo === "string" ? input.segmentNo.trim() : "";
      const accepted = input.accepted === true;
      if (!planId || !segmentNo) {
        return { ok: false, error: "缺少 planId 或 segmentNo" };
      }
      const ok = travelPlanStore.setTransferPickupState(planId, segmentNo, accepted ? "confirmed" : "dismissed");
      if (!ok) return { ok: false, error: `行程 ${planId} 中没有车次/航班 ${segmentNo}` };
      return {
        ok: true,
        hint: accepted
          ? "已记录需要接驳。现在继续 ride_hailing.quote（起点=到达车站/机场，终点=行程酒店，scheduleAt=票面到达时刻），用户确认选项后 ride_hailing.book 下单"
          : "已记录不需要接驳，后续该段行程不再提醒",
      };
    },
  };

  /** 6. 编辑行程（聊天式修改：添加/删除/替换/微调单条目） */
  const edit_itinerary: SkillDefinition = {
    metadata: {
      name: "travel.edit-itinerary",
      version: "1.1.0",
      displayName: "编辑已有行程",
      description:
        "对已生成的行程做单条目修改，支持四种动作：" +
        "add（添加条目，如「第二天帮我加个博物馆」「把这家餐厅加到晚餐」，按名称/关键词定位 POI 后插入并重排当天时间）、" +
        "remove（删除条目，如「第二天太赶了去掉一个景点」）、" +
        "replace（同类替换条目，可带意见，如「这个餐厅换成安静点的」，按坐标找同类替代并重新计价）、" +
        "update（修改名称/时间/地址等字段）。" +
        "定位参数 day/item 均从 1 起，可用 travel.get-itinerary 的 days[].day 与 items[].index。" +
        "version 建议传上一次回执中的行程版本号：若行程刚被用户在面板上改过会返回冲突错误，此时应告知用户。" +
        "用户要求改行程/换地点/删掉某项时调用；需要多处修改时逐次调用（每次一个动作）。",
      kind: "builtin",
      tags: ["travel", "行程", "编辑", "修改", "替换", "添加", "itinerary"],
      icon: "✏️",
      parameters: [
        { name: "planId", type: "string", required: true, description: "行程 ID（回执中的 id 字段）" },
        { name: "action", type: "string", required: true, enum: ["add", "remove", "replace", "update"], description: "动作：add=添加 / remove=删除 / replace=同类替换 / update=修改字段" },
        { name: "day", type: "number", required: true, description: "天序号（1 起，对应 get-itinerary 的 day）" },
        { name: "item", type: "number", required: false, description: "条目序号（1 起，add 不需要；其余动作为必填，对应 get-itinerary 的 items[].index）" },
        { name: "type", type: "string", required: false, enum: ["attraction", "hotel", "restaurant"], description: "add 时的条目类型（景点/酒店/餐厅）" },
        { name: "name", type: "string", required: false, description: "add 时的地点名称或关键词（如「博物馆」「海底捞」），引擎自动定位 POI" },
        { name: "version", type: "number", required: false, description: "乐观锁版本号：传本次会话中见到的行程 version（规划/get-itinerary/编辑回执均返回），不一致时返回冲突错误" },
        { name: "comment", type: "string", required: false, description: "replace 时的替换意见（如「想要海景」「安静一点」）" },
        { name: "patch", type: "object", required: false, description: "update 时的字段补丁 {name?,startTime?,address?,priceInfo?,description?}" },
      ],
      outputSchema: {
        ok: "是否成功",
        planId: "行程 ID",
        action: "执行的动作",
        edited: "被修改条目的摘要 {name,startTime,priceInfo}",
        added: "add 时的新条目摘要",
        replacement: "replace 时的新条目摘要",
        version: "保存后的最新版本号（下次编辑带上）",
        dayCount: "修改后总天数",
        dayScheduleNote: "重排后当天偏晚时的提示（可选）",
        hint: "展示提示",
      },
      permissions: ["network:external"],
      timeoutMs: 60_000,
    },
    handler: async (input) => {
      const planId = typeof input.planId === "string" ? input.planId.trim() : "";
      const action = typeof input.action === "string" ? input.action.trim() : "";
      const dayIdx = typeof input.day === "number" && input.day > 0 ? Math.floor(input.day) - 1 : -1;
      const itemIdx = typeof input.item === "number" && input.item > 0 ? Math.floor(input.item) - 1 : -1;
      if (!planId || !action) {
        return { ok: false, error: "缺少必填参数 planId / action" };
      }
      if (!["add", "remove", "replace", "update"].includes(action)) {
        return { ok: false, error: `未知动作：${action}（支持 add/remove/replace/update）` };
      }
      const plan = travelPlanStore.get(planId);
      if (!plan) {
        return { ok: false, error: `行程不存在：${planId}`, hint: "可用 travel.get-itinerary 不带参数列出最近行程" };
      }
      // 乐观锁（A6）：模型带上它会话中见到的版本号，与面板编辑互斥——
      // 版本不一致说明行程刚被用户改过，拒绝覆盖并让模型转告用户
      const expectVersion = typeof input.version === "number" ? Math.floor(input.version) : undefined;
      if (expectVersion != null && plan.version != null && plan.version !== expectVersion) {
        return {
          ok: false,
          conflict: true,
          error: `行程版本冲突：当前版本 ${plan.version}，你基于版本 ${expectVersion} 编辑——行程可能刚被用户在行程面板上修改过。请先告知用户存在修改，再决定是否重新编辑（可先用 travel.get-itinerary 读取最新内容）`,
          currentVersion: plan.version,
        };
      }
      const day = plan.days[dayIdx];
      if (!day && action !== "add") {
        return { ok: false, error: `定位失败：行程只有 ${plan.days.length} 天，没有第 ${dayIdx + 1} 天` };
      }
      if (action === "add") {
        if (!day) {
          return { ok: false, error: `定位失败：行程只有 ${plan.days.length} 天，没有第 ${dayIdx + 1} 天` };
        }
        const type = typeof input.type === "string" ? input.type.trim() : "";
        if (!(["attraction", "hotel", "restaurant"] as const).includes(type as "attraction")) {
          return { ok: false, error: "add 需要有效参数 type：attraction/hotel/restaurant" };
        }
        const nameOrKeyword = typeof input.name === "string" ? input.name.trim() : "";
        if (!nameOrKeyword) {
          return { ok: false, error: "add 需要有效参数 name：地点名称或关键词（如「博物馆」「海底捞」）" };
        }
        const poiType = type as "attraction" | "hotel" | "restaurant";
        const typeLabel = poiType === "attraction" ? "景点" : poiType === "hotel" ? "酒店" : "餐厅";
        let candidates: Awaited<ReturnType<typeof travelPlanningService.searchPois>> = [];
        try {
          candidates = await travelPlanningService.searchPois(plan.destination, poiType, nameOrKeyword, 5);
        } catch (err) {
          return { ok: false, error: `候选搜索失败：${err instanceof Error ? err.message : String(err)}` };
        }
        if (candidates.length === 0) {
          return {
            ok: false,
            error: `「${plan.destination}」未找到匹配的${typeLabel}（关键词：${nameOrKeyword}）`,
            hint: "可换个说法重试，或用 travel.search-poi 浏览候选列表",
          };
        }
        const exact = candidates.find((c) => c.name.trim().toLowerCase() === nameOrKeyword.toLowerCase());
        const poi = exact ?? candidates[0]!;
        const quote = quoteByType(pricingService, poi.name, poi.tags || [], poiType, plan.destination);
        day.items.push({
          type: poiType,
          name: poi.name,
          // 占位时刻：局部重排会按新坐标与当天时钟重算（追加的餐厅按晚餐锚定）
          startTime: "19:00",
          latitude: poi.latitude,
          longitude: poi.longitude,
          address: poi.address || "",
          priceInfo: formatQuotePriceInfo(quote),
          description: travelPlanningService.describePoi(poi, poiType),
        });
        // 局部重排（P0）：新条目起的当天时间轴按真实坐标重算
        await travelPlanningService.retimeDayAfterEdit(day.items, day.items.length - 1);
        travelPlanStore.save(plan);
        refreshItinerarySnapshot(plan);
        const added = day.items[day.items.length - 1]!;
        const dayEndMin = day.items.length > 0 ? Number(added.startTime.slice(0, 2)) * 60 + Number(added.startTime.slice(3, 5)) : 0;
        return {
          ok: true,
          planId,
          action,
          added: { name: added.name, type: added.type, startTime: added.startTime, priceInfo: added.priceInfo },
          ...(plan.version != null ? { version: plan.version } : {}),
          dayCount: plan.days.length,
          ...(dayEndMin > 22 * 60 ? { dayScheduleNote: "该天安排已到深夜，建议提醒用户考虑删减其他条目或换到其他天" } : {}),
          displayNote:
            "行程已添加并保存，前端行程卡数据已同步刷新。请勿复述条目 JSON；" +
            "用一两句话告知用户加了什么（哪天、什么地点、大概排在几点）即可。",
        };
      }
      const item = day?.items[itemIdx];
      if (!item) {
        return { ok: false, error: `定位失败：第 ${dayIdx + 1} 天没有第 ${itemIdx + 1} 个条目（该天共 ${day?.items.length ?? 0} 项）` };
      }
      const before = { name: item.name, startTime: item.startTime, priceInfo: item.priceInfo };

      try {
        if (action === "remove") {
          day!.items.splice(itemIdx, 1);
          // 局部重排（P0）：删除点之后的条目交通腿/时间按新相邻关系重算
          if (day!.items.length > itemIdx) {
            await travelPlanningService.retimeDayAfterEdit(day!.items, itemIdx);
          }
        } else if (action === "replace") {
          const comment = typeof input.comment === "string" ? input.comment.trim() : "";
          if (!(["attraction", "hotel", "restaurant"] as const).includes(item.type as "attraction")) {
            return { ok: false, error: `该条目类型（${item.type}）不支持替换` };
          }
          const poi = await travelPlanningService.findAlternativePoi(
            item.type as "attraction" | "hotel" | "restaurant",
            item.latitude,
            item.longitude,
            item.name,
            comment,
          );
          if (!poi) {
            return { ok: false, error: "未找到可替换的同类地点（附近搜索无结果），可稍后重试或改用 update 直接修改" };
          }
          const type = item.type as "attraction" | "hotel" | "restaurant";
          const quote = quoteByType(pricingService, poi.name, poi.tags || [], type, plan.destination);
          day!.items[itemIdx] = {
            ...item,
            name: poi.name,
            latitude: poi.latitude,
            longitude: poi.longitude,
            address: poi.address || item.address,
            priceInfo: formatQuotePriceInfo(quote),
            description: travelPlanningService.describePoi(poi, type),
            images: poi.images && poi.images.length > 0 ? poi.images : [],
            reviews: [],
            videos: [],
          };
          // 局部重排（P0）：新坐标变了，被替换条目起的交通腿与时间全部按新位置重算
          await travelPlanningService.retimeDayAfterEdit(day!.items, itemIdx);
        } else {
          // update：字段补丁（字段级白名单，与 HTTP itemPatchSchema 一致的子集）
          const patch = (input.patch ?? {}) as Record<string, unknown>;
          const allowed = ["name", "startTime", "address", "priceInfo", "description"] as const;
          let applied = 0;
          for (const key of allowed) {
            const v = patch[key];
            if (typeof v === "string" && v.trim()) {
              (item as unknown as Record<string, unknown>)[key] = v.trim();
              applied += 1;
            }
          }
          if (applied === 0) {
            return { ok: false, error: "update 需要至少一个有效字段：name/startTime/address/priceInfo/description" };
          }
        }

        travelPlanStore.save(plan);
        // 同步刷新结构化快照：同一会话随后再出 travel_itinerary 卡时拿到的是改后数据
        refreshItinerarySnapshot(plan);
        const afterItems = plan.days[dayIdx]!.items;
        const editedItem =
          action === "remove" ? before : (afterItems[Math.min(itemIdx, afterItems.length - 1)] ?? before);
        return {
          ok: true,
          planId,
          action,
          edited: action === "remove" ? before : { name: editedItem.name, startTime: editedItem.startTime, priceInfo: editedItem.priceInfo },
          ...(action === "replace" ? { replacement: { name: editedItem.name } } : {}),
          ...(plan.version != null ? { version: plan.version } : {}),
          dayCount: plan.days.length,
          displayNote:
            "行程已修改并保存，前端行程卡数据已同步刷新。请勿复述条目 JSON；" +
            "用一两句话告知用户改了什么（哪天、哪个条目、换成了什么）即可。",
        };
      } catch (err) {
        return { ok: false, error: `行程编辑失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  return [plan_itinerary, search_poi, destination_info, compute_route, get_itinerary, pickup_answer, edit_itinerary];
}

/**
 * 注册旅游规划内置 Skills 到 SkillManager。
 */
export function registerTravelPlanningBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createTravelPlanningBuiltinSkills(deps)) {
    register(s);
  }
}