/**
 * 位置上报接入管线（位置方案 A 的服务端落点）。
 *
 * WS 层收到 `client.location_report` 后调用 ingest()，把同一条位置喂给：
 *   1. 位置历史（方案 B：须显式开启——continuous 或 LOCATION_HISTORY_ENABLED=1）
 *   2. 地理围栏引擎（方案 C：有围栏才判 enter/leave，事件经 notifier 分发）
 *   3. 到达触发器（方案 D：常去地点到达 → 主动意图）
 *
 * 入口带 per-actor 最小间隔频控（缺省 10s）：WS 层对位置上报没有速率限制，
 * 有 bug 或恶意的客户端高频上报会放大 SQLite 写入与围栏判定开销。被频控
 * 丢弃的上报直接跳过（返回 false），按需请求的 resolve 不受影响——那在
 * LocationCoordinator 内完成。
 *
 * 全部 fire-and-forget：任何消费方失败都不影响位置协调器主链路。
 */

import type { ClientLocationWire } from "@nextbot/agent-protocol";

import {
  reverseGeocodeCoordinates,
  type ReverseGeocodeHit,
} from "./reverse-geocode-service.js";
import type { ActorContextService, ActorPlaceKind } from "./actor-context-service.js";
import type { GeofenceService } from "./geofence-service.js";
import type { LocationHistoryService, LocationSampleSource } from "./location-history-service.js";

export type LocationIngestDeps = {
  /** 位置历史存储；null=未开启（隐私默认），整条历史链路静默 */
  history: LocationHistoryService | null;
  /** 地理围栏引擎；null=未装配 */
  geofence: GeofenceService | null;
  /**
   * 情境快照（State 层）：每次上报同步更新当前位置与 placeKind。
   *
   * 这是「持续感知」的落点——消费方（prompt / 工具）只读快照，不再向客户端
   * 发按需请求。频控丢弃的上报也要更新快照（见 ingest 注释）：状态是「最新
   * 事实」，事件流才是「按频率采样」。
   */
  context?: ActorContextService | null;
  /** 上报后的后续消费（如方案 D 到达触发器） */
  onLocationReported?: (actorId: string, loc: ClientLocationWire, source: LocationSampleSource) => void;
  /** 同一 actor 两次入库的最小间隔（毫秒），0=关闭频控；缺省 10s */
  minIntervalMs?: number;
  /** 时钟注入（测试用），缺省 Date.now */
  now?: () => number;
  /**
   * 坐标→时区反解器（测试可注入假实现）；缺省 reverseGeocodeCoordinates。
   * 进程内 30min LRU 缓存 + in-flight 去重，同坐标重复上报零网络。
   */
  reverseGeocode?: (latitude: number, longitude: number) => Promise<ReverseGeocodeHit | null>;
};

export class LocationIngestPipeline {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly lastIngestAt = new Map<string, number>();
  /** 最近一次在途逆地理修正（测试同步等待用）。 */
  private inflightEnrichment: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LocationIngestDeps) {
    this.minIntervalMs = deps.minIntervalMs ?? 10_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 处理一次上报。返回 false 表示被频控丢弃（未落历史、未判围栏、未触发后续）。 */
  ingest(actorId: string, loc: ClientLocationWire, source: LocationSampleSource): boolean {
    // 快照先更新：频控只该限制「样本入库密度」，不该让 Agent 看到过期状态。
    // 用户刚到家正好卡在 10s 窗口内，prompt 仍必须知道他在家。
    this.updateContext(actorId, loc, source);

    if (this.minIntervalMs > 0) {
      const nowMs = this.now();
      const last = this.lastIngestAt.get(actorId) ?? 0;
      if (nowMs - last < this.minIntervalMs) return false;
      this.lastIngestAt.set(actorId, nowMs);
    }

    if (this.deps.history) {
      try {
        this.deps.history.record(actorId, loc, source);
      } catch (err) {
        console.log(`[LocationIngest] 历史写入失败（忽略）: ${err}`);
      }
    }
    try {
      this.deps.geofence?.processLocationReport(actorId, loc);
    } catch (err) {
      console.log(`[LocationIngest] 围栏判定失败（忽略）: ${err}`);
    }
    try {
      this.deps.onLocationReported?.(actorId, loc, source);
    } catch (err) {
      console.log(`[LocationIngest] 上报消费回调失败（忽略）: ${err}`);
    }
    return true;
  }

  /** 更新情境快照（含 placeKind）；任何失败都不影响主链路。 */
  private updateContext(
    actorId: string,
    loc: ClientLocationWire,
    source: LocationSampleSource,
  ): void {
    const context = this.deps.context;
    if (!context) return;
    try {
      let place: { kind: ActorPlaceKind; label?: string } | undefined;
      try {
        const hit = this.deps.geofence?.matchPlace(actorId, loc);
        if (hit) place = { kind: hit.kind, label: hit.fence.name };
      } catch {
        /* 围栏查询失败：placeKind 保持 unknown，不影响坐标快照 */
      }
      context.updateLocation(actorId, loc, source, place);
      // 坐标→时区逆地理修正（2026-11-10 真机时间错乱根治）：客户端上报的
      // location.timezone 是设备读数回声，设备钟坏了会把 GMT 写进快照，
      // resolveClock 的 geo 冲突保护就拿 GMT 比 GMT 永远不触发。这里用
      // 服务端反解结果覆盖修正（fire-and-forget，任何失败静默——修正缺席
      // 只是退回旧行为，绝不阻塞上报主链路）。缓存命中时零网络。
      this.inflightEnrichment = this.enrichLocation(actorId, loc);
    } catch (err) {
      console.log(`[LocationIngest] 快照更新失败（忽略）: ${err}`);
    }
  }

  /** 测试钩子：等待在途逆地理修正落盘（生产路径 fire-and-forget 不等）。 */
  async waitForEnrichmentForTest(): Promise<void> {
    await this.inflightEnrichment;
  }

  private async enrichLocation(actorId: string, loc: ClientLocationWire): Promise<void> {
    const context = this.deps.context;
    if (!context) return;
    const geocode = this.deps.reverseGeocode ?? reverseGeocodeCoordinates;
    try {
      const hit = await geocode(loc.latitude, loc.longitude);
      if (hit) context.enrichLocationFromGeocode(actorId, hit);
    } catch {
      /* 逆地理失败：快照保持客户端原值，resolveClock 走原有降级链 */
    }
  }
}
