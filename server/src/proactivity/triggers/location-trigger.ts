// ProactivityHub —— 位置到达触发器（位置方案 D）
//
// 位置上报流（持续模式）→ 判定「到达常去地点」→ 主动行为：
//   常去地点来自位置历史的 DBSCAN 挖掘（方案 B），当前坐标落入
//   地点簇半径内且冷却期已过 → 经 ProactivityHub 走 speak 闭环，
//   由 ProactionCortex 生成自然的主动话术（如到家问候/顺手提醒）。
//
// 克制原则：
//   - 只对到访次数达标的地点触发（默认 ≥8 次：真的是常去，不是路过）；
//   - 同一地点 6 小时冷却（一天最多提一次，避免每次回家都唠叨）；
//   - 冷却基线取 max(进程内上次触发, 该地点最近样本时刻)：后者让冷却跨重启
//     生效——用户持续停留在某地时 place.lastSeenAt 始终新鲜，重启不会把
//     「一直在家」误判成「刚到家」；离开超过冷却期后自然恢复触发资格；
//   - 挖掘结果按 actor 缓存 10 分钟（DBSCAN 不必每次上报都跑）；
//   - 未开启位置历史时永远不触发（history 为 null 即整条链路静默）。
import type { ProactiveIntent } from "../proactivity-types.js";
import type { FrequentPlace, LocationHistoryService } from "../../services/location-history-service.js";
import { haversineMeters } from "../../services/geo-utils.js";

export type LocationTriggerDeps = {
  history: LocationHistoryService | Pick<LocationHistoryService, "mineFrequentPlaces"> | null;
  submitIntent: (intent: ProactiveIntent) => void;
  now?: () => Date;
  /** 到达判定半径（米）：距地点质心 ≤ radius + margin 视为到达 */
  arrivalMarginMeters?: number;
  /** 同一地点两次触发的冷却（缺省 6h） */
  cooldownMs?: number;
  /** 地点到访次数门槛（缺省 8） */
  minVisits?: number;
};

/** 常去地点挖掘结果缓存时长：DBSCAN 每 10 分钟刷一次足够 */
const MINE_CACHE_MS = 10 * 60 * 1000;

/** 到达常去地点的主动意图（纯函数，测试直调） */
export function buildLocationArrivalIntent(actorId: string, place: FrequentPlace): ProactiveIntent {
  const where = place.label?.trim() || `常去地点（${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}）`;
  return {
    actorId,
    kind: "location_arrival",
    importance: "low",
    title: `用户到达常去地点：${where}`,
    summary:
      `用户刚到达常去地点「${where}」（近 7 天到访 ${place.visitCount} 次）。` +
      `像家人注意到对方到家了一样自然地打个招呼即可：一句简短的到达问候，` +
      `若上下文里有和这个地点/时间相关的待办（拿快递、买菜、休息）可顺带轻提，` +
      `没有就只问好，别编造任务。`,
    mode: "speak",
    source: "location",
    // 共同键显式给地点名（2026-10-19 二期）：这是这次开口真正"属于哪个主题"。
    // 不给的话推断会在长句里挑出「地点」这种无区分度的词，把不相干的到达绑到一起；
    // 地点名（"家"/"公司"）才是能与位置源其他发现汇聚的真实键。
    subject: where,
  };
}

export class LocationTrigger {
  private readonly deps: LocationTriggerDeps;
  private readonly cooldownMs: number;
  private readonly minVisits: number;
  private readonly arrivalMarginMeters: number;
  /** actor → { places, minedAt }：挖掘缓存 */
  private readonly mineCache = new Map<string, { places: FrequentPlace[]; minedAt: number }>();
  /** actor|placeId → 上次触发时刻 */
  private readonly lastFiredAt = new Map<string, number>();

  constructor(deps: LocationTriggerDeps) {
    this.deps = deps;
    this.cooldownMs = deps.cooldownMs ?? 6 * 60 * 60 * 1000;
    this.minVisits = deps.minVisits ?? 8;
    this.arrivalMarginMeters = deps.arrivalMarginMeters ?? 100;
  }

  /**
   * 用户清除位置历史等场景：丢弃该 actor 的挖掘缓存与冷却记录。
   * 已删除的数据不再驱动主动行为（下次上报时重新挖掘）。
   */
  invalidate(actorId: string): void {
    this.mineCache.delete(actorId);
    const prefix = `${actorId}|`;
    for (const key of [...this.lastFiredAt.keys()]) {
      if (key.startsWith(prefix)) this.lastFiredAt.delete(key);
    }
  }

  /** 位置上报入口（LocationIngestPipeline 每次上报调用；fire-and-forget 语义） */
  handleLocationReport(
    actorId: string,
    loc: { latitude: number; longitude: number },
  ): ProactiveIntent | null {
    if (!this.deps.history) return null;
    const now = this.deps.now?.() ?? new Date();
    const cached = this.mineCache.get(actorId);
    if (!cached || now.getTime() - cached.minedAt > MINE_CACHE_MS) {
      const places = this.deps.history.mineFrequentPlaces(actorId);
      this.mineCache.set(actorId, { places, minedAt: now.getTime() });
    }
    const places = this.mineCache.get(actorId)?.places ?? [];

    for (const place of places) {
      if (place.visitCount < this.minVisits) continue;
      const distance = haversineMeters(loc, place);
      if (distance > place.radiusMeters + this.arrivalMarginMeters) continue;
      const key = `${actorId}|${place.id}`;
      // 冷却基线 = max(进程内上次触发, 该地点最近一次样本时刻)：见类注释第 3 条
      const lastSeenMs = Date.parse(place.lastSeenAt);
      const last = Math.max(
        this.lastFiredAt.get(key) ?? 0,
        Number.isFinite(lastSeenMs) ? lastSeenMs : 0,
      );
      if (now.getTime() - last < this.cooldownMs) continue;
      this.lastFiredAt.set(key, now.getTime());
      const intent = buildLocationArrivalIntent(actorId, place);
      try {
        this.deps.submitIntent(intent);
      } catch (err) {
        console.log(`[LocationTrigger] 提交到达意图失败（忽略）: ${err}`);
      }
      return intent;
    }
    return null;
  }
}
