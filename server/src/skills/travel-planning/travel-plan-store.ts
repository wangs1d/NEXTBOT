/**
 * 行程持久化存储（单例，进程内缓存 + 磁盘落盘）
 *
 * 职责：travel.plan-itinerary 生成行程后按 planId 落盘，供跨轮/跨重启的
 * 「按需回查」——LLM 上下文只留极简回执（summarizeItinerary），明细永远
 * 不进对话历史；用户追问时由 travel.get-itinerary 工具从这里读取。
 *
 * 分层架构（见 travel-planning-skills.ts 头注释）：
 *   热层  = prompt 状态快照（buildTravelStatePrompt，一行目的地/日期）
 *   冷层  = 本存储的完整明细（get-itinerary 按天粒度按需读取）
 *
 * 存储：data/travel-plans/{planId}.json 单文件单行程（planId 含时间戳唯一），
 * 进程内 Map 索引 + 惰性磁盘读；写入同步刷盘（行程生成是低频事件）。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from "node:fs";
import path from "node:path";

/**
 * 行程条目统一结构：StoredTravelPlan 与 TravelItinerarySnapshot 共用同一份定义
 * （替代三套各自维护的近似结构体），编辑/重排链路（transportFromPrev/visitDuration）
 * 也依赖该结构在两条数据通路间保持一致。
 */
export interface StoredDayItem {
  type: string;
  name: string;
  startTime: string;
  latitude: number;
  longitude: number;
  address: string;
  priceInfo: string;
  description: string;
  tips?: string[];
  images?: string[];
  /**
   * 打卡视频（travel 视频下放）：真实相关的播放页，每站最多 1 条
   * （TravelPoiVideoService 从严过滤后落盘；无命中 = 无字段，宁缺毋滥）。
   */
  videos?: TravelPlanStopVideo[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat，无则省略） */
  splatUrl?: string;
  /** 从上一个条目出发的交通腿（首项无；编辑局部重排时按新坐标重算） */
  transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
  /** 建议游览/用餐时长（分钟；编辑局部重排用它保持原排时口径） */
  visitDuration?: number;
  /** 画像推荐理由（travel 双端②：「为什么推荐给你」，有画像信号才有） */
  recommendReason?: string;
  /**
   * 时间锚点：该条目时刻被用户/预订明确钉住（如显式指定 startTime 的新增条目）。
   * 局部重排（retimeDayAfterEdit）保留其 startTime 只重算交通腿，之后按此时钟
   * 顺推；客户端在行程页渲染「· 时间锚点」徽章。
   */
  anchor?: boolean;
  reviews?: unknown[];
  /**
   * 以下为规划主线 S4 字段贯通补齐：核实与编辑链路需要条目自带的原信息，
   * 此前只落盘展示字段，冷层回读再核实（verifyItinerary）就拿不到开放时间。
   */
  /** 规划服务内的条目 ID（编辑/预订按 ID 定位，名称可能重名） */
  itemId?: string;
  /** POI 缓存原始 ID（图片复用、缓存回写） */
  poiId?: string;
  /** 结束时刻（ISO，与 startTime 同口径；核实闸算停留窗口要用） */
  endTime?: string;
  /** POI 公示营业时间（核实闸的原始输入，原文保留不预处理） */
  openingHours?: string;
  /** 联系电话（预约/改期时用户要打的那个号） */
  phone?: string;
  /** POI 评分（真实点评聚合口径） */
  rating?: number;
  /** 标签（室内/夜景/菜系等，核实与筛选依据） */
  tags?: string[];
  /** 一句话种草：为什么去 */
  why?: string;
  /** 出片建议（来自 POI 实测机位数据，无则省略） */
  photoTip?: string;
  /** 避坑提示 */
  pitfall?: string;
  /** 预订提示（酒店/付费景点） */
  bookingNote?: string;
}

export interface StoredTravelPlan {
  /** 行程 ID（travel-planning-service 生成，形如 plan-1788076649218） */
  planId: string;
  /** 数据可信度（real/knowledge/synthetic），前端据此展示数据来源角标 */
  dataQuality?: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  /** 目的地地理编码中心（前端地图初始化定位用，替代客户端内置默认中心） */
  center?: { latitude: number; longitude: number };
  /** 落盘时间（毫秒）；save 未传时自动补 */
  createdAt?: number;
  /** 乐观锁版本：每次 save 自增；编辑请求须携带当前版本，不匹配返回 409 */
  version?: number;
  /** 用户原始诉求（规划输入，供回查时还原语境） */
  requestInput?: string;
  /** 用户偏好标签 */
  preferences?: string[];
  /** 目的地一句话简介（行程卡海报区展示） */
  intro?: string;
  /** 出行随身物品叮嘱（行程卡「记得带」胶囊） */
  packing?: string[];
  /** 出发日天气一句话摘要（Open-Meteo 实时预报；行程桌面页顶栏天气胶囊展示） */
  weather?: string;
  /** 目的地代表性封面（行程卡海报区背景；冷层回读建卡时随 travelPlan 下发） */
  coverImage?: string;
  /** 候选 POI 池（含未排入日程的备选，前端地图常驻展示） */
  pois?: Array<{
    id?: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    address?: string;
    rating?: number;
  }>;
  /** 总实付（pricingSummary.totalFinal，冗余一份避免读全文） */
  totalCost?: number;
  /**
   * 预算档位（travel 双端⑥）：规划时从 TripPreferences.budget 存档，
   * 预算守门（当日消费 vs 档位日上限 → 超支进晚间摘要）的判定依据；
   * 未传 = 不守门（宁缺毋滥，不硬算）。
   */
  budgetTier?: 'low' | 'mid' | 'high';
  /**
   * 用户行程进度（跨端共享的「已走/当前站」；设备状态，编辑乐观锁不因此自增）。
   * day/stop 为 0 基索引，stop 指该天 items 的当前站。
   */
  progress?: { day: number; stop: number; updatedAt: number };
  /** 规划会话 ID：接驳提醒的推送目标（提醒跟随规划时的用户会话） */
  sessionId?: string;
  days: Array<{
    date: string;
    items: StoredDayItem[];
  }>;
  /** 交通大段（高铁/航班，travel-upgrade-plan P2）：接驳提醒调度器的扫描数据源 */
  transferSegments?: TravelTransferSegment[];
  /** 旅行人格分型（travel 双端③）：攻略页头部徽章展示（结构随 personalization 下发） */
  persona?: { id: string; label: string; desc: string };
  /**
   * 到访足迹（travel 双端⑦）：导航「已到达」时记录的站点点位（day/stop 为
   * 0 基索引，与 progress 同口径）。回忆录的数据源之一；无导航记录 = 无足迹
   * 条目（宁缺毋滥，不用计划站点冒充到访）。
   */
  visits?: TravelPlanVisit[];
  /**
   * 核实闸结果（travel 主线 F3）：规划完成后逐站核验的开放时间/闭馆日/预约/密度
   * 冲突清单。落盘是为了让桌面行程页与简报卡在同一份事实上说话（编辑后可重跑）。
   */
  verification?: {
    issues: Array<{
      level: "block" | "warn" | "info";
      kind: string;
      day: number;
      stop: number;
      name: string;
      message: string;
      suggestion?: string;
    }>;
    summary: string | null;
    checkedAt: string;
  };
  /**
   * 规划槽位（travel 主线 F0）：结构化诉求 + 每项来源，供简报卡回读时还原
   * 「这版怎么排的」。sources 只记来源档位，不记推断过程。
   */
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
  /** 点名地点里没排进去的名字（如实交代，不静默丢弃） */
  wishlistMissed?: string[];
  /**
   * 行程状态（预订后置的「满意门」）：draft=还在调，approved=用户说满意了。
   * 缺省按 draft 处理；travel.approve-plan 置 approved，
   * 同目的地的 travel_booking.search/book 在未定稿时先要一句「就按这版订」。
   */
  status?: "draft" | "approved";
  /** 用户确认满意的时间戳（毫秒）：预订窗口以此为准 */
  approvedAt?: number;
}

/** 单条到访足迹（回忆录⑦）：同站重复到达只记首次 */
export interface TravelPlanVisit {
  day: number;
  stop: number;
  name: string;
  /** 到达时刻（毫秒时间戳） */
  arrivedAt: number;
}

/** 单条打卡视频（travel 视频下放）：真实播放页，每站最多 1 条 */
export interface TravelPlanStopVideo {
  /** 播放页直链（白名单域：B站/抖音/小红书/YouTube） */
  url: string;
  /** 视频标题（来自搜索结果原题，未做 LLM 改写） */
  title: string;
  /** 来源站标识（bilibili/douyin/xiaohongshu/youtube） */
  source: string;
  /** 时长文本（搜索源给出才有） */
  duration?: string;
}

/** 与 travel-planning-service 的 TransferSegment 同构（冷层独立定义，避免循环依赖） */
export interface TravelTransferSegment {
  type: 'flight' | 'train';
  role: 'arrival' | 'departure';
  no: string;
  depTime?: string;
  arrTime?: string;
  from: string;
  to: string;
  pickupConfirmed?: boolean;
  pickupDismissed?: boolean;
}

/** 行程摘要（内存索引条目，列表查询不再触达磁盘与全量 JSON.parse） */
interface PlanSummaryEntry {
  planId: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  /** 站点总数（全部天的条目数之和；归档页预览 meta 免二次请求） */
  stopCount: number;
  /** 行程进度摘要（归档页「进行中 Day x/y」徽章免二次请求；无记录省略） */
  progress?: { day: number; stop: number };
  totalCost?: number;
  /** 目的地封面（行程归档列表卡片背景；无则省略，客户端渐变兜底） */
  coverImage?: string;
  /** 规划会话（预算守门按 sessionId 找今日进行中行程用） */
  sessionId?: string;
  createdAt: number;
}

const MAX_PLANS = 50;

class TravelPlanStore {
  private root: string;
  /** planId → 计划（进程内缓存；磁盘为权威源，未命中惰性读） */
  private mem = new Map<string, StoredTravelPlan>();
  /** planId → 摘要（懒构建 + save/prune 增量维护；null 表示尚未构建） */
  private summaryIndex: Map<string, PlanSummaryEntry> | null = null;

  constructor() {
    // 测试可用 TRAVEL_PLAN_STORE_DIR 覆盖存储目录（默认 data/travel-plans）
    this.root = path.resolve(
      process.env.TRAVEL_PLAN_STORE_DIR || path.join(getDataDir(), "travel-plans"),
    );
    this.ensureDir(this.root);
  }

  /** 保存/覆盖行程（同步落盘；planId 冲突时后写覆盖）。version 每次保存自增。 */
  save(plan: StoredTravelPlan): void {
    if (!plan.planId) return;
    // 磁盘为权威源：内存未命中时惰性读盘，保证版本号跨重启连续
    const prev = this.get(plan.planId);
    const withTs: StoredTravelPlan = {
      ...plan,
      createdAt: plan.createdAt ?? Date.now(),
      version: (prev?.version ?? 0) + 1,
    };
    // 自增后的版本只活在这份克隆里：不写回调用方手里的对象，编辑端点就会把旧
    // version 当载荷下发，客户端下一次乐观锁请求必 409（桌面就地编辑实测）
    plan.version = withTs.version;
    this.mem.set(plan.planId, withTs);
    try {
      fs.writeFileSync(
        this.planPath(plan.planId),
        JSON.stringify(withTs),
        "utf8",
      );
    } catch (err) {
      console.error("[TravelPlanStore] save failed:", err);
    }
    this.summaryIndex?.set(plan.planId, this.buildSummary(withTs));
    this.prune();
  }

  /** 按 planId 读行程：内存未命中时惰性读磁盘 */
  get(planId: string): StoredTravelPlan | null {
    const cached = this.mem.get(planId);
    if (cached) return cached;
    try {
      const raw = fs.readFileSync(this.planPath(planId), "utf8");
      const parsed = JSON.parse(raw) as StoredTravelPlan;
      if (parsed?.planId) {
        this.mem.set(parsed.planId, parsed);
        return parsed;
      }
    } catch {
      // 不存在/损坏 → null
    }
    return null;
  }

  /**
   * 更新行程进度（设备状态，跨端共享「已走/当前站」）。
   * 直接改内存 + 刷盘，不走 save() —— 进度更新不应自增编辑乐观锁版本，
   * 否则手机端走一半行程会让桌面端并发的编辑请求全部 409。
   */
  updateProgress(planId: string, day: number, stop: number): boolean {
    const plan = this.get(planId);
    if (!plan) return false;
    const prev = plan.progress;
    if (prev && prev.day === day && prev.stop === stop) return true;
    plan.progress = { day, stop, updatedAt: Date.now() };
    this.mem.set(planId, plan);
    this.summaryIndex?.set(planId, this.buildSummary(plan));
    try {
      fs.writeFileSync(this.planPath(planId), JSON.stringify(plan), "utf8");
    } catch (err) {
      console.error("[TravelPlanStore] updateProgress failed:", err);
    }
    return true;
  }

  /** 按目的地名找最近一份行程（大小写/首尾空格不敏感，摘要索引上匹配后按 planId 取全量） */
  findByDestination(destination: string): StoredTravelPlan | null {
    const key = destination.trim().toLowerCase();
    if (!key) return null;
    let bestId: string | null = null;
    let bestTs = -1;
    for (const s of this.ensureSummaryIndex().values()) {
      if ((s.destination ?? "").trim().toLowerCase() === key && s.createdAt > bestTs) {
        bestTs = s.createdAt;
        bestId = s.planId;
      }
    }
    return bestId ? this.get(bestId) : null;
  }

  /**
   * 满意门落定（travel 主线 F5）：用户确认这版方案后置 approved。
   * 仿 updateProgress 直改内存 + 刷盘，不自增编辑乐观锁——定稿不是改内容，
   * 不能让用户正在编辑的桌面面板下一次 PATCH 撞 409。
   */
  approvePlan(planId: string): boolean {
    const plan = this.get(planId);
    if (!plan) return false;
    if (plan.status === "approved") return true;
    plan.status = "approved";
    plan.approvedAt = Date.now();
    this.mem.set(planId, plan);
    try {
      fs.writeFileSync(this.planPath(planId), JSON.stringify(plan), "utf8");
    } catch {
      /* 落盘失败不影响本轮定稿判定 */
    }
    return true;
  }

  /**
   * 目的地最近一份行程（预订闸用）：预订诉求命中某城市时，先看该城最近的行程
   * 有没有定稿。窗口收窄到「这次规划还热乎」的 2 小时——三天前排过的行程不该
   * 拦住用户今天单独订酒店。
   */
  findRecentForDestination(destination: string, withinMs = 2 * 60 * 60 * 1000): StoredTravelPlan | null {
    const plan = this.findByDestination(destination);
    if (!plan?.createdAt) return null;
    return Date.now() - plan.createdAt <= withinMs ? plan : null;
  }

  /**
   * 接驳提醒调度器（transfer-watch-service）的数据口：
   * 扫描含交通大段的全部行程（全量 get，行程总量 ≤50 可承受）。
   */
  listPlansWithTransfers(): StoredTravelPlan[] {
    const out: StoredTravelPlan[] = [];
    for (const s of this.ensureSummaryIndex().values()) {
      const plan = this.get(s.planId);
      if (plan?.transferSegments?.length) out.push(plan);
    }
    return out;
  }

  /**
   * 更新某交通段的接驳状态（用户确认/拒绝后调用，落盘防重复打扰）。
   * 仿 updateProgress：直改内存+刷盘，不走 save() 不自增编辑乐观锁。
   */
  setTransferPickupState(planId: string, segmentNo: string, state: 'confirmed' | 'dismissed'): boolean {
    const plan = this.get(planId);
    if (!plan) return false;
    const seg = plan.transferSegments?.find((s) => s.no === segmentNo);
    if (!seg) return false;
    if (state === 'confirmed') {
      seg.pickupConfirmed = true;
      seg.pickupDismissed = false;
    } else {
      seg.pickupDismissed = true;
      seg.pickupConfirmed = false;
    }
    this.mem.set(planId, plan);
    try {
      fs.writeFileSync(this.planPath(planId), JSON.stringify(plan), "utf8");
    } catch (err) {
      console.error("[TravelPlanStore] setTransferPickupState failed:", err);
    }
    return true;
  }

  /**
   * 记录到访足迹（回忆录⑦）：导航 arrive 时调用，按 day+stop 去重（重复到达
   * 只保留首次）。仿 updateProgress：直改内存+刷盘，不走 save() 不自增编辑乐观锁。
   */
  recordVisit(planId: string, visit: TravelPlanVisit): boolean {
    const plan = this.get(planId);
    if (!plan) return false;
    if (!plan.visits) plan.visits = [];
    const dup = plan.visits.some((v) => v.day === visit.day && v.stop === visit.stop);
    if (!dup) plan.visits.push(visit);
    this.mem.set(planId, plan);
    try {
      fs.writeFileSync(this.planPath(planId), JSON.stringify(plan), "utf8");
    } catch (err) {
      console.error("[TravelPlanStore] recordVisit failed:", err);
    }
    return true;
  }

  /**
   * 落盘某站的打卡视频（travel 视频下放）：后台视频回填命中后调用。
   * 仿 recordVisit：直改内存+刷盘，不走 save() 不自增编辑乐观锁。
   */
  setStopVideos(planId: string, day: number, stop: number, videos: TravelPlanStopVideo[]): boolean {
    const plan = this.get(planId);
    const item = plan?.days?.[day]?.items?.[stop];
    if (!plan || !item) return false;
    if (videos.length > 0) item.videos = videos.slice(0, 1); // 每站只留 1 条
    this.mem.set(planId, plan);
    try {
      fs.writeFileSync(this.planPath(planId), JSON.stringify(plan), "utf8");
    } catch (err) {
      console.error("[TravelPlanStore] setStopVideos failed:", err);
    }
    return true;
  }

  /**
   * 删除行程：内存 + 摘要索引 + 磁盘文件一并移除。
   * 归档页「删除行程」用；不存在返回 false。
   */
  remove(planId: string): boolean {
    const existed = this.get(planId) != null;
    this.mem.delete(planId);
    this.summaryIndex?.delete(planId);
    if (!existed) return false;
    try {
      fs.unlinkSync(this.planPath(planId));
    } catch {
      // 文件已在（prune 竞态等）→ 视为已删除
    }
    return true;
  }

  /**
   * 全部行程摘要（新→旧），供状态快照与列表查询。
   * 只读内存摘要索引：save/prune 增量维护，启动后首次调用才扫一次磁盘建索引。
   */
  listSummaries(limit = 5): Array<{
    planId: string;
    destination: string;
    title: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    stopCount: number;
    progress?: { day: number; stop: number };
    totalCost?: number;
    coverImage?: string;
    sessionId?: string;
    createdAt: number;
  }> {
    return [...this.ensureSummaryIndex().values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
      .map((s) => ({
        planId: s.planId,
        destination: s.destination,
        title: s.title,
        startDate: s.startDate,
        endDate: s.endDate,
        dayCount: s.dayCount,
        stopCount: s.stopCount,
        ...(s.progress ? { progress: { ...s.progress } } : {}),
        ...(s.totalCost != null ? { totalCost: s.totalCost } : {}),
        ...(s.coverImage ? { coverImage: s.coverImage } : {}),
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        createdAt: s.createdAt,
      }));
  }

  private buildSummary(plan: StoredTravelPlan): PlanSummaryEntry {
    return {
      planId: plan.planId,
      destination: plan.destination ?? "",
      title: plan.title ?? "",
      startDate: plan.startDate ?? "",
      endDate: plan.endDate ?? "",
      dayCount: plan.days?.length ?? 0,
      stopCount:
        plan.days?.reduce((sum, day) => sum + (day.items?.length ?? 0), 0) ?? 0,
      ...(plan.progress
        ? { progress: { day: plan.progress.day, stop: plan.progress.stop } }
        : {}),
      ...(plan.totalCost != null ? { totalCost: plan.totalCost } : {}),
      ...(plan.coverImage ? { coverImage: plan.coverImage } : {}),
      ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
      createdAt: plan.createdAt ?? 0,
    };
  }

  /** 摘要索引懒构建：磁盘文件逐个经 get() 读一次（并入 mem 缓存），此后不再触盘 */
  private ensureSummaryIndex(): Map<string, PlanSummaryEntry> {
    if (this.summaryIndex) return this.summaryIndex;
    const idx = new Map<string, PlanSummaryEntry>();
    try {
      for (const f of fs.readdirSync(this.root)) {
        if (!f.endsWith(".json")) continue;
        const plan = this.get(f.replace(/\.json$/, ""));
        if (plan) idx.set(plan.planId, this.buildSummary(plan));
      }
    } catch {
      // 目录不可读 → 只用内存
    }
    for (const plan of this.mem.values()) idx.set(plan.planId, this.buildSummary(plan));
    this.summaryIndex = idx;
    return idx;
  }

  /** 超限清理：只删磁盘文件（保留最近 MAX_PLANS 份），同步维护摘要索引 */
  private prune(): void {
    const all = [...this.ensureSummaryIndex().values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const s of all.slice(MAX_PLANS)) {
      this.mem.delete(s.planId);
      this.summaryIndex?.delete(s.planId);
      try {
        fs.unlinkSync(this.planPath(s.planId));
      } catch {
        // ignore
      }
    }
  }

  private planPath(planId: string): string {
    // planId 由服务生成（plan-<ts>），仍做一层文件名净化防路径注入
    const safe = planId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    return path.join(this.root, `${safe || "plan"}.json`);
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

export const travelPlanStore = new TravelPlanStore();
