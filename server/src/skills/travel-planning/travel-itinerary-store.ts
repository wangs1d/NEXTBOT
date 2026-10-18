/**
 * 行程结构化数据桥（单例）
 *
 * travel.plan-itinerary 执行成功后将结构化行程（按天拆分、保留坐标/价格/地址等
 * 关键字段）写入本模块；agent-result-formatter 在产出 travel_itinerary 卡时读取并
 * 注入卡片 JSON 的 travelPlan 字段。
 *
 * 前端双面板（travel_plan_panel.dart）优先直读 travelPlan 渲染，无结构化数据时
 * 才回退到从卡片 items 文本正则解析 —— 让双面板从「文本解析」升级为「结构化直读」。
 *
 * 并发安全：内部按「目的地」键控保留最近 8 份快照。两个不同目的地的规划并发时，
 * formatter 通过 findForText 按卡片文本中的目的地名匹配对应快照，
 * 修复了旧版「只留一份、后写覆盖先写」导致的串卡问题。
 */
import type { StoredDayItem } from "./travel-plan-store.js";

export interface TravelItinerarySnapshot {
  /** 产生该行程的工具名（用于匹配 travel_itinerary 卡） */
  toolName: string;
  /** 写入时间戳（毫秒） */
  ts: number;
  /** 行程 ID（travel-planning-service 生成，形如 plan-1788076649218；供前端面板调行程路由域编辑/预订/分享） */
  planId: string;
  /** 数据可信度（real/knowledge/synthetic），前端据此展示数据来源角标 */
  dataQuality?: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  /** 目的地地理编码中心（前端地图初始化定位用，替代客户端内置默认中心） */
  center?: { latitude: number; longitude: number };
  /** 目的地一句话简介（行程卡海报区展示；知识库未命中时缺省） */
  intro?: string;
  /** 出行随身物品叮嘱（行程卡「记得带」胶囊） */
  packing?: string[];
  /** 出发日天气一句话摘要（Open-Meteo 实时预报；行程桌面页顶栏天气胶囊展示） */
  weather?: string;
  /**
   * 目的地代表性封面（行程卡海报区背景）：目的地本身的形象照（维基百科条目
   * 主图优先），前端海报优先于任何条目实拍图使用。解析失败缺省。
   */
  coverImage?: string;
  /** 旅行人格分型（travel 双端③）：攻略页头部徽章展示，随快照透传（结构同 StoredTravelPlan.persona） */
  persona?: { id: string; label: string; desc: string };
  days: Array<{
    date: string;
    /** 与 StoredTravelPlan 共用同一份条目结构（StoredDayItem） */
    items: StoredDayItem[];
  }>;
  /**
   * 候选 POI 池（规划涉及的酒店/餐厅/景点全量摘要，含未排入日程的备选）。
   * 前端地图以 dayIndex=null 展示 → 默认全量显示、按天过滤时也常驻，满足
   * 「规划的酒店/吃饭/游玩地都要有 POI 展示」。
   */
  pois?: Array<{
    id?: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    address?: string;
    rating?: number;
  }>;
}

const MAX_RECENT = 8;
/** 快照有效窗口（与 formatter 的旧时效检查一致）：过旧不注入，防旧行程串卡 */
const FRESH_MS = 2 * 60 * 1000;

class TravelItineraryStore {
  private last: TravelItinerarySnapshot | null = null;
  /** 最近快照，按目的地去重、新在前 */
  private recent: TravelItinerarySnapshot[] = [];

  set(snapshot: TravelItinerarySnapshot): void {
    this.last = snapshot;
    this.recent = [
      snapshot,
      ...this.recent.filter((s) => s.destination !== snapshot.destination),
    ].slice(0, MAX_RECENT);
  }

  /** 最新一份快照（兼容旧调用方） */
  get(): TravelItinerarySnapshot | null {
    return this.last;
  }

  /**
   * 按卡片文本挑选匹配快照：
   * 1. 优先取「目的地名出现在文本中且未过期」的快照（并发规划时按目的地区分）；
   * 2. 兜底返回最新快照（仍受 2 分钟时效约束）。
   */
  findForText(text: string, freshnessMs: number = FRESH_MS): TravelItinerarySnapshot | null {
    const now = Date.now();
    if (text) {
      for (const s of this.recent) {
        if (s.destination && now - s.ts < freshnessMs && text.includes(s.destination)) {
          return s;
        }
      }
    }
    return this.last && now - this.last.ts < freshnessMs ? this.last : null;
  }

  clear(): void {
    this.last = null;
    this.recent = [];
  }
}

export const travelItineraryStore = new TravelItineraryStore();
