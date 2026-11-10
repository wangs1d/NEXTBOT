/**
 * Actor 情境快照（持续感知架构的 State 层，2026-11-05 重构）。
 *
 * 背景：旧架构把「位置」当一次 RPC 查询（requestLocation 等 12s 回包），把
 * 「时间」当位置的派生（时区只能由 GPS 逆地理链路上带，抓不到 fix 就回落
 * 服务器时区）。结果是任一环失败时间就错，且 prompt 装配被迫在超时/不阻塞
 * 之间反复打补丁。
 *
 * 本服务把感知结果收敛成 **一个持续存在的快照**：
 *   - 时区与位置各自独立的 `observedAt` 与 `source`——位置可能三小时没变
 *     （人在家本来就不该有事件），时区却是刚确认的，旧结构无法表达这种差异；
 *   - 时区来源四源择优（设备事件 → 设备快照 → 逆地理 → 用户档案 → 服务器），
 *     **绝不猜**：任何一源都比「猜 Asia/Shanghai」准；
 *   - 消费方（prompt 装配、时钟工具）同步读快照，零 IO 零阻塞，陈旧就如实
 *     标龄期，不追问、不拉取。
 *
 * 平台事实（决定设计取向）：Android 8+ 后台定位被系统限制成「每小时几次」，
 * iOS significantChange 仅 1-2 次/小时且 ±1-3km。所以「持续感知」的正确含义
 * 是**持续可知**（事件来了就更新状态，没事件说明状态没变），而不是持续采样。
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ClientClockWire, ClientLocationWire } from "@nextbot/agent-protocol";

import { getDataDir } from "../config/data-dir.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import type { ReverseGeocodeHit } from "./reverse-geocode-service.js";

export type ActorActivity = "still" | "walking" | "vehicle" | "unknown";
export type ActorPlaceKind = "home" | "work" | "other" | "unknown";

/** 时钟状态：IANA 时区是权威，偏移只作一致性校验与展示。 */
export type ActorClockState = {
  timezone: string;
  utcOffsetMinutes?: number;
  observedAt: number;
  /** event=系统时区变更事件；snapshot=前台/消息随行快照；legacy-location=旧客户端仅随位置带 */
  source: "event" | "snapshot" | "legacy-location";
};

export type ActorLocationState = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  label?: string;
  city?: string;
  district?: string;
  region?: string;
  country?: string;
  /** 定位当时上报的时区（逆地理产物），只作时钟的第三优先源，不覆盖设备时区 */
  timezone?: string;
  observedAt: number;
  source: string;
  placeKind: ActorPlaceKind;
  placeLabel?: string;
};

export type ActorContext = {
  actorId: string;
  clock?: ActorClockState;
  location?: ActorLocationState;
  activity?: ActorActivity;
  activityObservedAt?: number;
  updatedAt: number;
};

/** 时区解析来源，按权威度降序；`server` 表示所有来源都不可用（应告警）。 */
export type ClockSourceName =
  | "client-event"
  | "client-snapshot"
  | "geo"
  | "profile"
  | "server";

export type ResolvedUserClock = {
  timezone: string;
  source: ClockSourceName;
  utcOffsetMinutes?: number;
};

export type ResolveUserClockInput = {
  clientTimezone?: string;
  clientUtcOffsetMinutes?: number;
  clientSource?: "event" | "snapshot";
  geoTimezone?: string;
  profileTimezone?: string;
  /** 服务器进程时区；缺省读 Intl，测试可注入 */
  serverTimezone?: string;
  /** 冲突判定的基准时刻（毫秒）；缺省 Date.now，测试可注入 */
  nowMs?: number;
};

const TZ_VALID_CACHE = new Map<string, boolean>();

/**
 * 校验 IANA 时区可被 Intl 解析。
 *
 * 只做「能不能格式化」这一件事：客户端可能上报 `"UTC+8"`、空串、或历史脏值，
 * 直接塞进 `Intl.DateTimeFormat` 会抛 RangeError 并让整轮 prompt 装配失败。
 */
export function isValidIanaTimezone(tz: string | undefined | null): boolean {
  const value = tz?.trim();
  if (!value) return false;
  const cached = TZ_VALID_CACHE.get(value);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    ok = true;
  } catch {
    ok = false;
  }
  if (TZ_VALID_CACHE.size > 256) TZ_VALID_CACHE.clear();
  TZ_VALID_CACHE.set(value, ok);
  return ok;
}

/** 服务器进程时区（最后兜底，且调用方应记录告警）。 */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 时区四源择优。
 *
 * 设计取向（与旧实现的关键差别）：
 *  1. **设备时区优先于定位时区与服务器时区**，且不因「旧」而降级——但有一个
 *     冲突例外（2026-11-06 模拟器事故）：设备直报与定位链路时区的 UTC 偏移
 *     冲突时改信定位。设备直报不是铁板一块——Android 模拟器默认 GMT、桌面
 *     进程可能被 TZ 环境变量劫持（Dart VM 尊重 TZ），这两类「设备直报」与
 *     用户屏幕上的钟无关；坐标 → 城市时区是独立证据链。真旅行者的冲突窗口
 *     只有几分钟（过境后系统时区与首个 GPS fix 先后到达），定位很快跟上。
 *  2. **逆地理时区只作兜底**（无冲突时）。它是「坐标 → 外网 → 城市级 tz」
 *     的推断产物，在时区边界（美西南、中澳、俄罗斯）会错，且外网失败时曾经
 *     硬编码 Asia/Shanghai（用户在美国也报北京时间）。
 *  3. 任何一源都比「服务器时区」准，所以 `server` 是失败信号，不是正常分支。
 */
export function resolveUserClock(input: ResolveUserClockInput): ResolvedUserClock {
  const clientTz = input.clientTimezone?.trim();
  // 设备时区字符串 ↔ 自报偏移 ↔ geo 三方对账（2026-11-10 真机实证加固）：
  // 同一台手机的两个读数通道可以互相矛盾（时钟快照 GMT/0、定位通道
  // Asia/Shanghai，见 data/location/actor-context.json 2378709729@qq.com）。
  // 字符串与自报偏移矛盾时**不作废字符串**——那可能只是跨夏令时的过期快照
  // （洛杉矶 PDT→PST 实测会误伤）；正确语义是：geo 偏移与设备自报偏移一致
  // 时（设备钟与定位互相印证）信 geo，否则保留字符串（没有更优源时矮子里
  // 拔将军）。设备整台钟都错的场景由 geo 冲突保护 + 逆地理修正兜住。
  if (isValidIanaTimezone(clientTz)) {
    const geoTz = input.geoTimezone?.trim();
    const geoValid = isValidIanaTimezone(geoTz);
    const atMs = input.nowMs ?? Date.now();
    const clientStringOffset = zoneOffsetMinutes(clientTz!, atMs);
    const reportedOffset =
      typeof input.clientUtcOffsetMinutes === "number" ? input.clientUtcOffsetMinutes : undefined;
    if (
      reportedOffset !== undefined &&
      clientStringOffset !== undefined &&
      clientStringOffset !== reportedOffset &&
      geoValid &&
      zoneOffsetMinutes(geoTz!, atMs) === reportedOffset
    ) {
      // 字符串过期/损坏，但 geo 与设备钟偏移互相印证 → 信 geo
      return { timezone: geoTz!, source: "geo" };
    }
    if (geoValid && geoTz !== clientTz) {
      const geoOffset = zoneOffsetMinutes(geoTz!, atMs);
      if (
        clientStringOffset !== undefined &&
        geoOffset !== undefined &&
        clientStringOffset !== geoOffset
      ) {
        return { timezone: geoTz!, source: "geo" };
      }
    }
    return {
      timezone: clientTz!,
      source: input.clientSource === "event" ? "client-event" : "client-snapshot",
      utcOffsetMinutes: input.clientUtcOffsetMinutes,
    };
  }

  const geoTz = input.geoTimezone?.trim();
  if (isValidIanaTimezone(geoTz)) {
    return { timezone: geoTz!, source: "geo" };
  }

  const profileTz = input.profileTimezone?.trim();
  if (isValidIanaTimezone(profileTz)) {
    return { timezone: profileTz!, source: "profile" };
  }

  return { timezone: input.serverTimezone ?? serverTimezone(), source: "server" };
}

/**
 * 某时区在某一时刻的 UTC 偏移（分钟）。
 *
 * 用于两件事：把设备上报的 `utcOffsetMinutes` 与 IANA 规则对齐（识别客户端
 * 时区字符串过期）、以及时钟偏差诊断（设备钟 vs 服务端钟）。
 */
export function zoneOffsetMinutes(timezone: string, atMs: number): number | undefined {
  if (!isValidIanaTimezone(timezone)) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(atMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const hour = get("hour") % 24;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
  } catch {
    return undefined;
  }
}

/** 位置龄期的人读描述（绝不把旧位置说成实时）。 */
export function describeLocationAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "刚更新";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 5) return "实时";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 时钟偏差诊断值：设备时刻与服务端时刻之差（正=设备快）。 */
export function clockSkewMs(clientAt: string | undefined, serverNowMs: number): number | undefined {
  const raw = clientAt?.trim();
  if (!raw) return undefined;
  // 裸本地时间（无 Z / 无 offset）不参与诊断：解析结果依赖运行环境时区，
  // 会产生假偏差（旧 Android 客户端曾这么发）。
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed - serverNowMs;
}

export type ActorContextServiceOptions = {
  /** 缺省 data/location/actor-context.json */
  persistPath?: string;
  /** 时钟注入（测试用）；缺省 Date.now */
  now?: () => number;
  serverTimezone?: string;
  /** 内存快照上限，超出按 updatedAt 淘汰最旧（缺省 5000） */
  maxActors?: number;
  /** 落盘节流（缺省 5s；0=每次更新立即写） */
  persistThrottleMs?: number;
};

type PersistedShape = {
  version: 1;
  contexts: ActorContext[];
};

/**
 * 情境快照存储。
 *
 * 内存优先、落盘异步节流：位置/时钟更新都在消息热路径上，同步 IO 会直接
 * 拖慢首字。进程重启后从磁盘恢复，避免每次冷启动都退回服务器时区。
 */
export class ActorContextService {
  private readonly contexts = new Map<string, ActorContext>();
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly serverTz: string;
  private readonly maxActors: number;
  private readonly persistThrottleMs: number;
  private persistTimer: NodeJS.Timeout | null = null;
  private lastPersistAt = 0;
  private closed = false;
  /**
   * 在途落盘任务。`afterUpdate` 是热路径上的 fire-and-forget，若不记账，
   * `flush()`/`close()` 只等自己那次写——先发的那次仍可能在进程退出（或测试
   * 目录被删）之后落地，产生 ENOENT 噪音与丢写。
   */
  private readonly inflightPersists = new Set<Promise<void>>();

  constructor(opts?: ActorContextServiceOptions) {
    this.persistPath =
      opts?.persistPath ?? join(getDataDir(), "location", "actor-context.json");
    this.now = opts?.now ?? (() => Date.now());
    this.serverTz = opts?.serverTimezone ?? serverTimezone();
    this.maxActors = Math.max(64, opts?.maxActors ?? 5000);
    this.persistThrottleMs = Math.max(0, opts?.persistThrottleMs ?? 5_000);
    this.loadFromDisk();
  }

  /** 写入设备时钟快照。无有效时区时不动快照（不清空既有值）。 */
  updateClock(actorId: string, clock: ClientClockWire | undefined): ActorContext | null {
    const tz = clock?.timezone?.trim();
    if (!actorId || !isValidIanaTimezone(tz)) return null;
    const ctx = this.ensure(actorId);
    const at = this.now();
    ctx.clock = {
      timezone: tz!,
      utcOffsetMinutes:
        typeof clock?.utcOffsetMinutes === "number" ? clock.utcOffsetMinutes : undefined,
      observedAt: at,
      source: clock?.source === "event" ? "event" : "snapshot",
    };
    ctx.updatedAt = at;
    this.afterUpdate();
    return ctx;
  }

  /** 写入位置快照（定位、围栏、到访事件共用）。 */
  updateLocation(
    actorId: string,
    loc: ClientLocationWire | undefined,
    source: string,
    place?: { kind: ActorPlaceKind; label?: string },
  ): ActorContext | null {
    if (!actorId || !loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      return null;
    }
    const ctx = this.ensure(actorId);
    const at = this.now();
    // 龄期诚实原则：capturedAt 是 fix 的真实采集时刻（设备钟），能用就用——
    // 否则传输/排队延迟会被抹掉，服务端把 5 分钟前的坐标当"刚刚"。
    // 设备钟不可信（偏差过大）时回退服务端接收时刻。
    let observedAt = at;
    if (loc.capturedAt) {
      const capturedMs = Date.parse(loc.capturedAt);
      if (Number.isFinite(capturedMs)) {
        const skewMs = Math.abs(at - capturedMs);
        observedAt = skewMs <= 10 * 60_000 ? capturedMs : at;
      }
    }
    ctx.location = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracyMeters: typeof loc.accuracyMeters === "number" && loc.accuracyMeters > 0
        ? loc.accuracyMeters
        : undefined,
      label: loc.label?.trim() || undefined,
      city: loc.city?.trim() || undefined,
      district: loc.district?.trim() || undefined,
      region: loc.region?.trim() || undefined,
      country: loc.country?.trim() || undefined,
      timezone: loc.timezone?.trim() || undefined,
      observedAt,
      source,
      placeKind: place?.kind ?? "unknown",
      placeLabel: place?.label?.trim() || undefined,
    };
    // 兼容旧客户端：只随位置带时区、没有独立时钟通道。仅在没有更权威的
    // 设备直报时才采用，且标记为 legacy-location（便于观测谁还在老版本）。
    // 设备时区变了（换城市/手动改时区）必须跟进：legacy 钟的权威源就是
    // 客户端设备本身，抱着第一次上报的旧时区等于用错钟。
    if (isValidIanaTimezone(loc.timezone)) {
      const tz = loc.timezone!.trim();
      if (!ctx.clock) {
        ctx.clock = { timezone: tz, observedAt: at, source: "legacy-location" };
      } else if (ctx.clock.source === "legacy-location" && ctx.clock.timezone !== tz) {
        ctx.clock = { timezone: tz, observedAt: at, source: "legacy-location" };
      }
    }
    ctx.updatedAt = at;
    this.afterUpdate();
    return ctx;
  }

  /**
   * 用服务端逆地理结果修正位置快照（2026-11-10 真机时间错乱根治）。
   *
   * 背景：`updateLocation` 落库的 `location.timezone` 是客户端上报原样回声，
   * 而客户端时区读数可能是错的（真机实证：设备钟通道报 GMT+0，人却在贵州）。
   * 快照里 geo 时区被同一个坏读数污染后，resolveClock 的 geo 冲突保护拿
   * GMT 比 GMT 永远不触发 →【当前时间】块按 UTC 渲染 → 手机端"没有时间感知"。
   *
   * 这里用坐标反解（reverse-geocode-service，open-meteo timezone=auto）的
   * 时区**覆盖** location.timezone（仅当反解成功且为合法 IANA 时区）；文本
   * 字段（label/city/district/region/country）只补空、不改写。设备钟原值
   * 仍留在 clock 块不动——存储层如实记录上报，解析层（resolveClock）拿
   * 修正后的 geo 时区与设备钟做偏移冲突裁决，冲突时信定位。
   */
  enrichLocationFromGeocode(actorId: string, hit: ReverseGeocodeHit): void {
    const ctx = this.contexts.get(actorId);
    const loc = ctx?.location;
    if (!ctx || !loc) return;
    const at = this.now();
    if (isValidIanaTimezone(hit.timezone) && hit.timezone !== loc.timezone) {
      loc.timezone = hit.timezone;
    }
    if (!loc.label?.trim() && hit.label?.trim()) loc.label = hit.label.trim();
    if (!loc.city?.trim() && hit.city?.trim()) loc.city = hit.city.trim();
    if (!loc.district?.trim() && hit.district?.trim()) loc.district = hit.district.trim();
    if (!loc.region?.trim() && hit.region?.trim()) loc.region = hit.region.trim();
    if (!loc.country?.trim() && hit.country?.trim()) loc.country = hit.country.trim();
    ctx.updatedAt = at;
    this.afterUpdate();
  }

  /** 写入运动状态（CoreMotion / Activity Recognition 融合结果）。 */
  updateActivity(actorId: string, activity: ActorActivity): ActorContext | null {
    if (!actorId) return null;
    const ctx = this.ensure(actorId);
    const at = this.now();
    ctx.activity = activity;
    ctx.activityObservedAt = at;
    ctx.updatedAt = at;
    this.afterUpdate();
    return ctx;
  }

  get(actorId: string): ActorContext | undefined {
    return this.contexts.get(actorId);
  }

  /**
   * 解析当前时钟。优先设备直报，其次定位时区，最后服务器时区。
   * `profileTimezone` 由调用方从用户档案注入（当前生产未接，保留扩展位）。
   */
  resolveClock(actorId: string, profileTimezone?: string): ResolvedUserClock {
    const ctx = this.contexts.get(actorId);
    return resolveUserClock({
      clientTimezone: ctx?.clock?.timezone,
      clientUtcOffsetMinutes: ctx?.clock?.utcOffsetMinutes,
      clientSource: ctx?.clock?.source === "event" ? "event" : "snapshot",
      geoTimezone: ctx?.location?.timezone,
      profileTimezone,
      serverTimezone: this.serverTz,
    });
  }

  /** 位置龄期（毫秒）；无位置返回 undefined。 */
  locationAgeMs(actorId: string): number | undefined {
    const observedAt = this.contexts.get(actorId)?.location?.observedAt;
    if (observedAt == null) return undefined;
    return Math.max(0, this.now() - observedAt);
  }

  /** 用户清除位置数据时同步清空（不得留下已删除位置的残余快照）。 */
  clear(actorId: string): void {
    if (this.contexts.delete(actorId)) this.afterUpdate();
  }

  /** 仅清位置，保留时钟（隐私开关通常只针对位置）。 */
  clearLocation(actorId: string): void {
    const ctx = this.contexts.get(actorId);
    if (!ctx?.location) return;
    delete ctx.location;
    ctx.updatedAt = this.now();
    this.afterUpdate();
  }

  size(): number {
    return this.contexts.size;
  }

  /** 立即落盘（测试/退出钩子用）。先等齐在途写入，再补一次最终快照。 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // 等齐在途写入再补最终快照：persist 在调用瞬间就同步捕获 payload，
    // 若较早的那次写在最终写之后落地，会把新快照覆盖回旧值。
    const pending = [...this.inflightPersists];
    if (pending.length > 0) await Promise.allSettled(pending);
    await this.persist();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private ensure(actorId: string): ActorContext {
    let ctx = this.contexts.get(actorId);
    if (!ctx) {
      ctx = { actorId, updatedAt: this.now() };
      this.contexts.set(actorId, ctx);
    }
    return ctx;
  }

  private afterUpdate(): void {
    this.evictIfNeeded();
    if (this.closed) return;
    if (this.persistThrottleMs === 0) {
      void this.trackPersist();
      return;
    }
    if (this.persistTimer) return;
    const wait = Math.max(0, this.persistThrottleMs - (this.now() - this.lastPersistAt));
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.trackPersist();
    }, wait);
    this.persistTimer.unref?.();
  }

  /** 落盘并入账，供 flush 等待（fire-and-forget 但可追踪）。 */
  private trackPersist(): Promise<void> {
    const task = this.persist();
    this.inflightPersists.add(task);
    const done = () => this.inflightPersists.delete(task);
    task.then(done, done);
    return task;
  }

  private evictIfNeeded(): void {
    if (this.contexts.size <= this.maxActors) return;
    const entries = [...this.contexts.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < drop; i++) {
      const victim = entries[i];
      if (victim) this.contexts.delete(victim.actorId);
    }
  }

  private async persist(): Promise<void> {
    this.lastPersistAt = this.now();
    const payload: PersistedShape = {
      version: 1,
      contexts: [...this.contexts.values()],
    };
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      await writeJsonAtomic(this.persistPath, payload);
    } catch (err) {
      console.log(`[ActorContext] 落盘失败（忽略，内存快照仍有效）: ${err}`);
    }
  }

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed?.version !== 1 || !Array.isArray(parsed.contexts)) return;
      for (const ctx of parsed.contexts) {
        if (!ctx?.actorId) continue;
        // 恢复时丢弃非法时区（历史脏数据或不兼容写法）
        if (ctx.clock && !isValidIanaTimezone(ctx.clock.timezone)) delete ctx.clock;
        this.contexts.set(ctx.actorId, ctx);
      }
      if (this.contexts.size > 0) {
        console.log(`[ActorContext] 已恢复 ${this.contexts.size} 个 actor 快照`);
      }
    } catch {
      /* 首次启动/文件损坏：从空快照开始，不影响主链路 */
    }
  }
}
