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
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat，无则省略） */
  splatUrl?: string;
  /** 从上一个条目出发的交通腿（首项无；编辑局部重排时按新坐标重算） */
  transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
  /** 建议游览/用餐时长（分钟；编辑局部重排用它保持原排时口径） */
  visitDuration?: number;
  /**
   * 时间锚点：该条目时刻被用户/预订明确钉住（如显式指定 startTime 的新增条目）。
   * 局部重排（retimeDayAfterEdit）保留其 startTime 只重算交通腿，之后按此时钟
   * 顺推；客户端在行程页渲染「· 时间锚点」徽章。
   */
  anchor?: boolean;
  reviews?: unknown[];
  videos?: Array<Record<string, unknown>>;
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
   * 用户行程进度（跨端共享的「已走/当前站」；设备状态，编辑乐观锁不因此自增）。
   * day/stop 为 0 基索引，stop 指该天 items 的当前站。
   */
  progress?: { day: number; stop: number; updatedAt: number };
  days: Array<{
    date: string;
    items: StoredDayItem[];
  }>;
}

/** 行程摘要（内存索引条目，列表查询不再触达磁盘与全量 JSON.parse） */
interface PlanSummaryEntry {
  planId: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  totalCost?: number;
  /** 目的地封面（行程归档列表卡片背景；无则省略，客户端渐变兜底） */
  coverImage?: string;
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
      process.env.TRAVEL_PLAN_STORE_DIR || path.join(process.cwd(), "data", "travel-plans"),
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
    totalCost?: number;
    coverImage?: string;
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
        ...(s.totalCost != null ? { totalCost: s.totalCost } : {}),
        ...(s.coverImage ? { coverImage: s.coverImage } : {}),
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
      ...(plan.totalCost != null ? { totalCost: plan.totalCost } : {}),
      ...(plan.coverImage ? { coverImage: plan.coverImage } : {}),
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
