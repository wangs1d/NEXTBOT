/**
 * 导航卡快照（进程内，短时效）。
 *
 * 用途：navigation.navigate 的工具回执会进入 LLM 上下文，路线几何（数百个点）
 * 绝不能塞进回执——否则既浪费 token，也可能被模型复述出来。这里把「地图要画的
 * 那份数据」存在服务端，工具只回一个 navigationCardId；tool-card-registry 建卡时
 * 按 id 取回，随 [AGENT_RESULT_CARD] 的结构化载荷下发前端。
 *
 * 与 travelItineraryStore 同构：卡一旦落库/落消息，载荷已内嵌，历史回看不再依赖本
 * Store；因此这里只需短 TTL（默认 5 分钟）。
 */

import type { NavTravelMode } from "./nav-provider.js";

/** 地图上的一个端点（坐标为 WGS-84：对话内底图是 OSM/Esri 系） */
export type NavigationMapPoint = {
  name: string;
  lat: number;
  lng: number;
};

export type NavigationCardSnapshot = {
  from: NavigationMapPoint | null;
  to: NavigationMapPoint | null;
  mode: NavTravelMode;
  distanceKm?: number;
  durationMin?: number;
  /** 路径折线 [lat, lng]（WGS-84）；公交/骑行或高德不可用时为空 */
  polyline: Array<[number, number]>;
  createdAt: number;
};

const TTL_MS = 5 * 60 * 1000;

class NavigationCardStore {
  private readonly items = new Map<string, NavigationCardSnapshot>();
  private seq = 0;

  set(snapshot: Omit<NavigationCardSnapshot, "createdAt">): string {
    this.prune();
    const id = `nav-${Date.now().toString(36)}-${++this.seq}`;
    this.items.set(id, { ...snapshot, createdAt: Date.now() });
    return id;
  }

  get(id: string): NavigationCardSnapshot | undefined {
    const hit = this.items.get(id.trim());
    if (!hit) return undefined;
    if (Date.now() - hit.createdAt > TTL_MS) {
      this.items.delete(id);
      return undefined;
    }
    return hit;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, snap] of this.items) {
      if (now - snap.createdAt > TTL_MS) this.items.delete(id);
    }
  }
}

export const navigationCardStore = new NavigationCardStore();
