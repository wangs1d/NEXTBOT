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
import type { PlaceSemanticsService } from "./place-semantics-service.js";

export type LocationIngestDeps = {
  /** 位置历史存储；null=未开启（隐私默认），整条历史链路静默 */
  history: LocationHistoryService | null;
  /** 地理围栏引擎；null=未装配 */
  geofence: GeofenceService | null;
  /**
   * 地点语义（家/公司/常去地点）；null=未装配。
   * 与围栏的关系：用户确认的语义 > 用户显式围栏 > 自动推断语义。
   */
  places?: PlaceSemanticsService | null;
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
  /**
   * 每次上报的语义观察（不受频控影响）：地点转换触发器用。
   * 与 onLocationReported 的区别是它只看「状态是否变化」，不需要历史入库。
   */
  onLocationObserved?: (actorId: string, loc: ClientLocationWire, source: LocationSampleSource) => void;
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

    // 频控判定（2026-11-13 调整）：只挡「样本入库密度」，**不再连带丢弃围栏判定**。
    // 此前 return false 写在 processLocationReport 之前，而围栏边界抖动恰恰产生
    // 高频上报 —— 于是「刚到家/刚出门」这类真实事件经常被 10s 窗口吞掉，
    // 表现为围栏不触发。现在把频控只作用于 history.record，围栏判定始终执行。
    const rateLimited = this.isRateLimited(actorId);

    let sampleId: number | null = null;
    if (!rateLimited && this.deps.history) {
      try {
        sampleId = this.deps.history.record(actorId, loc, source).id;
      } catch (err) {
        console.log(`[LocationIngest] 历史写入失败（忽略）: ${err}`);
      }
    }
    // 逆地理补行政区：快照与历史样本共用同一份结果。放在落库之后执行，
    // 才能把结果回填到刚插入的这条样本（sampleId）。
    this.inflightEnrichment = this.enrichLocation(actorId, loc, sampleId);
    try {
      this.deps.geofence?.processLocationReport(actorId, loc);
    } catch (err) {
      console.log(`[LocationIngest] 围栏判定失败（忽略）: ${err}`);
    }
    // 语义观察同样不受频控影响：地点转换必须看到尽可能多的可信 fix，
    // 否则「刚到家」恰好落在 10s 窗口内会被吞掉（与围栏判定的教训一致）。
    try {
      this.deps.onLocationObserved?.(actorId, loc, source);
    } catch (err) {
      console.log(`[LocationIngest] 语义观察失败（忽略）: ${err}`);
    }
    if (rateLimited) return false;
    try {
      this.deps.onLocationReported?.(actorId, loc, source);
    } catch (err) {
      console.log(`[LocationIngest] 上报消费回调失败（忽略）: ${err}`);
    }
    return true;
  }

  /** 频控判定：命中则跳过历史落库（并推进窗口），但不影响围栏判定。 */
  private isRateLimited(actorId: string): boolean {
    if (this.minIntervalMs <= 0) return false;
    const nowMs = this.now();
    const last = this.lastIngestAt.get(actorId) ?? 0;
    if (nowMs - last < this.minIntervalMs) return true;
    this.lastIngestAt.set(actorId, nowMs);
    return false;
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
        // 用户确认过的地点语义 > 用户显式围栏 > 自动推断地点。
        // 围栏是「用户设置的触发器」，语义地点是「用户认可的事实」——后者更硬。
        const semantic = this.deps.places?.matchCached(actorId, loc);
        const fence = this.deps.geofence?.matchPlace(actorId, loc);
        if (semantic?.record.confirmed) {
          place = {
            kind: semantic.record.kind,
            label: semantic.record.label ?? semantic.record.poiName ?? undefined,
          };
        } else if (fence) {
          place = { kind: fence.kind, label: fence.fence.name };
        } else if (semantic) {
          place = {
            kind: semantic.record.kind,
            label: semantic.record.label ?? semantic.record.poiName ?? undefined,
          };
        }
      } catch {
        /* 围栏/语义查询失败：placeKind 保持 unknown，不影响坐标快照 */
      }
      context.updateLocation(actorId, loc, source, place);
      // 坐标→时区/行政区的逆地理修正由 ingest 在落库后统一执行（见 enrichLocation）。
    } catch (err) {
      console.log(`[LocationIngest] 快照更新失败（忽略）: ${err}`);
    }
  }

  /** 测试钩子：等待在途逆地理修正落盘（生产路径 fire-and-forget 不等）。 */
  async waitForEnrichmentForTest(): Promise<void> {
    await this.inflightEnrichment;
  }

  private async enrichLocation(
    actorId: string,
    loc: ClientLocationWire,
    sampleId: number | null = null,
  ): Promise<void> {
    const context = this.deps.context;
    const geocode = this.deps.reverseGeocode ?? reverseGeocodeCoordinates;
    try {
      const hit = await geocode(loc.latitude, loc.longitude);
      if (!hit) return;
      // 传上报时坐标：逆地理在途期间若位置又更新，快照会拒绝这次旧修正，
      // 避免把 A 点的门牌/地标挂到 B 点上（精确地址时代的错位事故）。
      context?.enrichLocationFromGeocode(actorId, hit, {
        latitude: loc.latitude,
        longitude: loc.longitude,
      });
      // 历史样本同步回填行政区（2026-11-16 根修）：此前逆地理只写内存快照，
      // location_samples 留下大量 city=null 的坐标样本，地点语义无法回答
      // 「家在哪个城市」。回填与快照共用同一份 hit，零额外网络。
      if (sampleId != null) {
        try {
          this.deps.history?.enrich(
            sampleId,
            {
              label: hit.address?.trim() || hit.label,
              city: hit.city,
              district: hit.district,
              region: hit.region,
              country: hit.country,
              timezone: hit.timezone,
            },
            { latitude: loc.latitude, longitude: loc.longitude },
          );
        } catch (err) {
          console.log(`[LocationIngest] 历史行政区回填失败（忽略）: ${err}`);
        }
      }
    } catch {
      /* 逆地理失败：快照保持客户端原值，resolveClock 走原有降级链 */
    }
  }
}
