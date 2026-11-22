/**
 * 每轮位置感知钩子（Turn Location Hook，2026-11-22）。
 *
 * 背景（位置动态更新的架构缺陷）：
 *   旧链路的「当前位置」只有两个来源——客户端持续上报写入的快照，或工具执行时
 *   的一次按需 GPS。两者都不在「本轮」这个时间点上：快照可能是几小时前最后一次
 *   上报，prompt 却把它写成「用户当前所在地」；工具路径只在模型主动调工具时才
 *   触发，闲聊轮完全不刷新。结果是位置和时间不同级——时间每轮都是此刻，位置却
 *   带着旧数据进 prompt。
 *
 * 本钩子把位置拉齐到与【当前时间】同级的**每轮感知**：
 *   1. 每轮 prompt 装配前调用 run()：快照龄期在新鲜窗口（缺省 60s）内直接复用；
 *   2. 过期但有在线设备 → 在预算（缺省 2s）内向设备要一次 fix（复用协调器的
 *      新鲜缓存判定，命中缓存零网络）；端侧两个定位引擎并行赛跑、达标即回；
 *   3. 「先答后刷」：快照精度达标且龄期在复用窗口（缺省 120s）内，本轮直接用、
 *      刷新丢后台——连续对话不再每条消息都等一次 GPS（2026-11-22 提速）；
 *   4. 预算内拿不到就如实返回当前快照与龄期——prompt 侧按龄期标注，超龄不注入；
 *   5. 并发去重：同一 actor 的多个调用方（chat / 任务 / 主动消息）共享一次请求。
 *   6. 任何回包（含超预算迟到的）都会落快照，留给下一轮，请求不白发。
 *
 * 设计约束：
 *   - 绝不抛异常、绝不阻塞超过预算（钩子是 prompt 装配的前置，不是工具）；
 *   - 只做「感知」不做「决策」：写快照是幂等的状态更新，不触发主动性/围栏副作用
 *     （那些由 WS 收到 client.location_report 后的 LocationIngestPipeline 负责）；
 *   - 离线/无客户端能力时静默降级，不追问、不编造。
 */

import type { ClientLocationWire } from "@nextbot/agent-protocol";

import {
  getLocationPromptMaxAgeMs,
  getTurnLocationBudgetMs,
  getTurnLocationFreshSec,
  getTurnLocationMaxAccuracyMeters,
  getTurnLocationPrecisionRetrySec,
  getTurnLocationReuseMaxAgeSec,
  isTurnLocationHookEnabled,
} from "../config/location-env.js";
import type { LocationCoordinator } from "./location-coordinator.js";
import {
  describeLocationAge,
  type ActorContextService,
  type ActorLocationState,
  type ActorPlaceKind,
} from "./actor-context-service.js";
import type { PlaceSemanticsService } from "./place-semantics-service.js";

export type TurnLocationReason = "chat" | "task" | "proactive";

export type TurnLocationHookOptions = {
  reason?: TurnLocationReason;
  /** 覆盖新鲜窗口（毫秒，测试用） */
  freshMs?: number;
  /** 覆盖等待预算（毫秒，测试用；0=不等待设备） */
  budgetMs?: number;
};

/**
 * 本轮位置可用性快照（给调用方/日志用，不参与 prompt 文本拼装）。
 *
 * - `fresh`     快照在新鲜窗口内，无需请求
 * - `refreshed` 本钩子本轮向设备/协调器拿到了一次更新
 * - `stale`     有位置但已超出新鲜窗口（可能仍可用，由最大龄期二次裁决）
 * - `none`      没有位置/已超最大龄期，prompt 不应注入
 */
export type TurnLocationState = {
  available: boolean;
  ageMs?: number;
  /** 当前快照的水平精度（米）；未知=旧客户端未上报 */
  accuracyMeters?: number;
  /** 精度是否达到本轮门槛（unknown 视为达标，避免每轮空等） */
  precise: boolean;
  refreshed: boolean;
  source: "fresh" | "refreshed" | "stale" | "none";
};

export type TurnLocationHookDeps = {
  context?: ActorContextService | null;
  coordinator?: LocationCoordinator | null;
  /** 地点语义（可选）：刷新快照时顺手补 placeKind，避免暂时丢「在家/在公司」 */
  places?: PlaceSemanticsService | null;
  /** 时钟注入（测试用） */
  now?: () => number;
  /** 新鲜窗口（毫秒）；缺省 env */
  freshMs?: number;
  /** 等待设备预算（毫秒）；缺省 env */
  budgetMs?: number;
  /** prompt 位置块的最大可用龄期（毫秒）；缺省 env */
  maxAgeMs?: number;
  /** 精度门槛（米）：快照差于它则现拉高精度 fix；缺省 env（30） */
  maxAccuracyMeters?: number;
  /** 精度尝试失败冷却（毫秒）；缺省 env（90s） */
  precisionRetryMs?: number;
  /** 「先答后刷」复用窗口（毫秒）：精准快照在此窗口内本轮不等待；缺省 env（120s） */
  reuseMaxAgeMs?: number;
  /** kill switch；缺省 env */
  enabled?: boolean;
};

/** 客户端 capturedAt 与服务端时刻偏差超过该值即认为设备钟不可信（与快照写入同口径）。 */
const CAPTURED_AT_MAX_SKEW_MS = 10 * 60_000;

/** 「只发不等」模式的最小请求间隔：连续主动消息不各自发一轮 GPS。 */
const BACKGROUND_REQUEST_MIN_GAP_MS = 15_000;

function observedAtOf(loc: ClientLocationWire, nowMs: number): number {
  if (!loc.capturedAt) return nowMs;
  const captured = Date.parse(loc.capturedAt);
  if (!Number.isFinite(captured)) return nowMs;
  return Math.abs(nowMs - captured) <= CAPTURED_AT_MAX_SKEW_MS ? captured : nowMs;
}

/**
 * 位置 wire 的真实采集时刻（服务端时刻，毫秒）。
 *
 * 与快照写入同口径：设备 capturedAt 可用就用它（龄期不被传输延迟抹掉），
 * 设备钟可信度不足（偏差 >10min）或缺失则回退服务端接收时刻。
 * 供 prompt 装配在「消息自带位置 vs 快照」之间做同类比较。
 */
export function locationWireObservedAt(loc: ClientLocationWire, nowMs: number): number {
  return observedAtOf(loc, nowMs);
}

/**
 * 位置龄期裁决（prompt 注入唯一门）：超过最大可用龄期一律不当作「当前所在地」。
 *
 * 快照、落盘历史、active 决策共用这一条规则——此前散落在各消费方各自判断，
 * 容易出现「prompt 说不注入、工具又说可用」的口径分裂。
 */
export function isLocationAgeAcceptable(
  ageMs: number | undefined,
  maxAgeMs: number = getLocationPromptMaxAgeMs(),
): boolean {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return false;
  return ageMs <= Math.max(60_000, maxAgeMs);
}

/**
 * 精度是否达标（精度优先的判据）。
 *
 * - 精度未知（旧客户端未上报 / accuracyMeters ≤ 0）视为**达标**：不能因为拿不到
 *   数字就每轮空等 GPS；这种情况靠龄期窗口控制请求频率。
 * - 已知且差于 maxAccuracyMeters → 不达标，需要现场要一次高精度 fix。
 */
export function isLocationAccuracyAcceptable(
  accuracyMeters: number | undefined | null,
  maxAccuracyMeters: number = getTurnLocationMaxAccuracyMeters(),
): boolean {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters)) return true;
  if (accuracyMeters <= 0) return true;
  return accuracyMeters <= Math.max(5, maxAccuracyMeters);
}

export type PromptLocationSource = "client-message" | "snapshot" | "history";

export type SelectedPromptLocation = {
  location: ClientLocationWire;
  /** 真实采集时刻（服务端毫秒）；prompt 的龄期标注按它算 */
  observedAt: number;
  source: PromptLocationSource;
  /** 选中快照时回传（placeKind / 地点语义前缀用）；其它来源为 undefined */
  snapshot?: ActorLocationState;
};

export type SelectPromptLocationInput = {
  /** 本轮消息显式携带（少数程序化调用方） */
  clientLocation?: ClientLocationWire;
  /** 情境快照（每轮钩子会尽量刷新它） */
  snapshot?: ActorLocationState | null;
  /** 落盘历史最近一条（只在快照缺失时兜底） */
  historySample?: {
    latitude: number;
    longitude: number;
    city?: string | null;
    district?: string | null;
    region?: string | null;
    country?: string | null;
    label?: string | null;
    recordedAt: string;
  } | null;
  nowMs?: number;
  maxAgeMs?: number;
};

/**
 * prompt 位置选择（唯一裁决口）：消息自带 → 快照 → 落盘历史。
 *
 * 三者都按**真实采集时刻**做龄期裁决与新旧比较：
 *   - 消息自带位置若只是调用方缓存的旧坐标，不能因为「出现在本轮消息里」
 *     就盖过快照；
 *   - 快照/历史超过最大可用龄期一律不选——「最后已知」不得冒充「当前」。
 * 返回 undefined 表示本轮没有可用位置（prompt 不渲染位置块）。
 */
export function selectPromptLocation(
  input: SelectPromptLocationInput,
): SelectedPromptLocation | undefined {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? getLocationPromptMaxAgeMs();

  let location: ClientLocationWire | undefined = input.clientLocation;
  let observedAt = location ? observedAtOf(location, nowMs) : undefined;
  let source: PromptLocationSource = "client-message";
  let snapshot: ActorLocationState | undefined;

  const rawSnapshot = input.snapshot ?? undefined;
  if (rawSnapshot && isLocationAgeAcceptable(nowMs - rawSnapshot.observedAt, maxAgeMs)) {
    if (observedAt == null || rawSnapshot.observedAt >= observedAt) {
      location = {
        latitude: rawSnapshot.latitude,
        longitude: rawSnapshot.longitude,
        ...(rawSnapshot.accuracyMeters != null
          ? { accuracyMeters: rawSnapshot.accuracyMeters }
          : {}),
        ...(rawSnapshot.city ? { city: rawSnapshot.city } : {}),
        ...(rawSnapshot.district ? { district: rawSnapshot.district } : {}),
        ...(rawSnapshot.region ? { region: rawSnapshot.region } : {}),
        ...(rawSnapshot.country ? { country: rawSnapshot.country } : {}),
        ...(rawSnapshot.label ? { label: rawSnapshot.label } : {}),
        ...(rawSnapshot.address ? { address: rawSnapshot.address } : {}),
        ...(rawSnapshot.township ? { township: rawSnapshot.township } : {}),
        ...(rawSnapshot.poi ? { poi: rawSnapshot.poi } : {}),
        ...(rawSnapshot.poiDistanceMeters != null
          ? { poiDistanceMeters: rawSnapshot.poiDistanceMeters }
          : {}),
      };
      observedAt = rawSnapshot.observedAt;
      source = "snapshot";
      snapshot = rawSnapshot;
    }
  }

  const sample = input.historySample;
  if (!location && sample) {
    const at = Date.parse(sample.recordedAt);
    if (Number.isFinite(at) && isLocationAgeAcceptable(nowMs - at, maxAgeMs)) {
      location = {
        latitude: sample.latitude,
        longitude: sample.longitude,
        ...(sample.city ? { city: sample.city } : {}),
        ...(sample.district ? { district: sample.district } : {}),
        ...(sample.region ? { region: sample.region } : {}),
        ...(sample.country ? { country: sample.country } : {}),
        ...(sample.label ? { label: sample.label } : {}),
      };
      observedAt = at;
      source = "history";
    }
  }

  if (!location) return undefined;
  return { location, observedAt: observedAt ?? nowMs, source, ...(snapshot ? { snapshot } : {}) };
}

/**
 * 把快照格式化成人读的位置行（主动消息/非 prompt 装配方复用）。
 *
 * 只输出「是什么 + 多旧」，不做反问引导；超龄由调用方决定是否调用。
 */
export function formatActorLocationBrief(
  loc: ActorLocationState,
  ageMs: number,
): string | null {
  const label =
    loc.address?.trim() ||
    [loc.district?.trim(), loc.city?.trim(), loc.region?.trim()].filter(Boolean).join(" · ") ||
    loc.label?.trim() ||
    loc.poi?.trim() ||
    "";
  if (!label) return null;
  const poi =
    loc.poi?.trim() && !label.includes(loc.poi.trim())
      ? `；最近地标：${loc.poi.trim()}${
          loc.poiDistanceMeters != null ? `（约 ${Math.round(loc.poiDistanceMeters)} 米）` : ""
        }`
      : "";
  const age = describeLocationAge(ageMs);
  const ageNote = age === "实时" ? "定位：实时" : `定位：${age}，非实时`;
  return `用户当前所在地：${label}${poi}（${ageNote}）`;
}

export class TurnLocationHook {
  private readonly inflight = new Map<string, Promise<TurnLocationState>>();
  /** 上次「只发不等」后台请求的时刻（per actor），用于限流。 */
  private readonly backgroundAt = new Map<string, number>();
  /**
   * 精度尝试失败冷却（per actor）：室内/隧道拿不到高精度 fix 时，避免每轮硬等
   * 满预算把首字拖到 4s；冷却期内只复用现有位置。
   */
  private readonly precisionMissAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly budgetMs: number;
  private readonly maxAgeMs: number;
  private readonly maxAccuracyMeters: number;
  private readonly precisionRetryMs: number;
  /** 「先答后刷」窗口：精准快照在此龄期内本轮直接复用，刷新丢后台。 */
  private readonly reuseMaxAgeMs: number;
  private readonly enabled: boolean;

  constructor(private readonly deps: TurnLocationHookDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.freshMs = Math.max(0, deps.freshMs ?? getTurnLocationFreshSec() * 1000);
    this.budgetMs = Math.max(0, deps.budgetMs ?? getTurnLocationBudgetMs());
    this.maxAgeMs = Math.max(60_000, deps.maxAgeMs ?? getLocationPromptMaxAgeMs());
    this.maxAccuracyMeters = Math.max(
      5,
      deps.maxAccuracyMeters ?? getTurnLocationMaxAccuracyMeters(),
    );
    this.precisionRetryMs = Math.max(
      0,
      deps.precisionRetryMs ?? getTurnLocationPrecisionRetrySec() * 1000,
    );
    this.reuseMaxAgeMs = Math.max(
      0,
      deps.reuseMaxAgeMs ?? getTurnLocationReuseMaxAgeSec() * 1000,
    );
    this.enabled = deps.enabled ?? isTurnLocationHookEnabled();
  }

  /** 当前快照的龄期（毫秒）；无位置返回 undefined。 */
  private ageMs(actorId: string): number | undefined {
    const observedAt = this.deps.context?.get(actorId)?.location?.observedAt;
    if (observedAt == null) return undefined;
    return Math.max(0, this.now() - observedAt);
  }

  private accuracyOf(actorId: string): number | undefined {
    return this.deps.context?.get(actorId)?.location?.accuracyMeters;
  }

  private isPreciseEnough(actorId: string): boolean {
    return isLocationAccuracyAcceptable(this.accuracyOf(actorId), this.maxAccuracyMeters);
  }

  /** 精度不足且刚失败过 → 冷却中，本轮不再请求设备。 */
  private inPrecisionCooldown(actorId: string): boolean {
    if (this.precisionRetryMs <= 0) return false;
    const last = this.precisionMissAt.get(actorId);
    return last != null && this.now() - last < this.precisionRetryMs;
  }

  /**
   * 同步读取本轮位置状态（零 IO）：主动消息/旁路调用方在不想等待时用。
   * 只做龄期/精度裁决，不请求设备。
   */
  peek(actorId: string): TurnLocationState {
    const ageMs = this.ageMs(actorId);
    const accuracyMeters = this.accuracyOf(actorId);
    if (ageMs == null) {
      return { available: false, precise: false, refreshed: false, source: "none" };
    }
    if (!isLocationAgeAcceptable(ageMs, this.maxAgeMs)) {
      return {
        available: false,
        ageMs,
        ...(accuracyMeters != null ? { accuracyMeters } : {}),
        precise: this.isPreciseEnough(actorId),
        refreshed: false,
        source: "none",
      };
    }
    return {
      available: true,
      ageMs,
      ...(accuracyMeters != null ? { accuracyMeters } : {}),
      precise: this.isPreciseEnough(actorId),
      refreshed: false,
      source: ageMs <= this.freshMs ? "fresh" : "stale",
    };
  }

  /**
   * 每轮入口：确保快照尽量接近「此刻」。
   *
   * 并发安全：同一 actor 在途请求直接复用（返回同一个 Promise），
   * 避免 chat 与主动消息同一时刻各发一次 `agent.location_request`。
   */
  run(actorId: string, opts?: TurnLocationHookOptions): Promise<TurnLocationState> {
    if (!actorId) {
      return Promise.resolve({ available: false, precise: false, refreshed: false, source: "none" });
    }
    // 预算 0（主动消息）：绝不等待任何在途请求，直接读当前状态并顺手丢一个
    // 后台刷新；否则 chat 轮的 2s 在途请求会把「不等」变成最多等 2s。
    if (opts?.budgetMs === 0) {
      void this.doRun(actorId, opts).catch(() => {});
      return Promise.resolve(this.peek(actorId));
    }
    const prev = this.inflight.get(actorId);
    if (prev) return prev;
    const task = this.doRun(actorId, opts).catch((err): TurnLocationState => {
      console.log(`[turn-location-hook] 刷新失败（忽略）: ${err}`);
      return this.peek(actorId);
    });
    this.inflight.set(actorId, task);
    void task.finally(() => {
      if (this.inflight.get(actorId) === task) this.inflight.delete(actorId);
    });
    return task;
  }

  private async doRun(
    actorId: string,
    opts?: TurnLocationHookOptions,
  ): Promise<TurnLocationState> {
    const freshMs = Math.max(0, opts?.freshMs ?? this.freshMs);
    const budgetMs = Math.max(0, opts?.budgetMs ?? this.budgetMs);

    const ageBefore = this.ageMs(actorId);
    const preciseBefore = this.isPreciseEnough(actorId);
    // 「够用」必须同时满足：龄期在新鲜窗口内 + 精度达标（精度未知视为达标）。
    // 只有龄期新鲜但精度差（如后台连续流的 50m fix）→ 仍要向设备要一次高精度。
    if (ageBefore != null && ageBefore <= freshMs && preciseBefore) {
      return this.peek(actorId);
    }
    if (!this.enabled) return this.peek(actorId);

    const coordinator = this.deps.coordinator;
    // 设备不在线：协调器只能回 null（它不会问其他 actor 的连接）。不白等预算。
    if (!coordinator || !coordinator.hasSocket(actorId)) return this.peek(actorId);

    const startRequest = (): Promise<ClientLocationWire | null> =>
      coordinator
        .requestLocation(actorId, `turn:${opts?.reason ?? "chat"}`, {
          maxAgeMs: freshMs,
          // 精度优先：缓存差于门槛时让协调器绕开缓存、现场要一次高精度 fix。
          maxAccuracyMeters: this.maxAccuracyMeters,
        })
        // 回包一律落快照：即使本轮已超预算（"先答后刷"），迟到的 fix 也要留给
        // 下一轮——否则请求白发，下一轮还是旧位置。
        .then((loc) => {
          if (loc) this.apply(actorId, loc);
          return loc;
        })
        .catch(() => null);

    // 预算为 0 = 只发请求不等待：请求照常在后台完成并写快照，下一轮直接吃到。
    // 限一个最小间隔，避免连续主动消息各自发一轮 GPS 请求（同一位置没必要）。
    if (budgetMs === 0) {
      this.fireBackground(actorId, startRequest);
      return this.peek(actorId);
    }

    // 「先答后刷」（2026-11-22 提速）：位置既精准又在复用窗口内（缺省 2min），
    // 本轮不再等设备回包——直接用它回答，同时把刷新丢到后台。这样连续对话
    // 几乎每轮零等待，而下一轮吃到的是后台刚刷的新值；位置块的龄期始终如实标注。
    // 前提是精度达标：粗 fix（后台连续流的 30~60m）不走这条路，仍旧现拉。
    if (
      preciseBefore &&
      ageBefore != null &&
      this.reuseMaxAgeMs > 0 &&
      ageBefore <= this.reuseMaxAgeMs
    ) {
      this.fireBackground(actorId, startRequest);
      return this.peek(actorId);
    }

    // 精度不足且刚失败过：冷却期内先复用现有位置，避免每轮硬等满预算。
    if (!preciseBefore && this.inPrecisionCooldown(actorId)) return this.peek(actorId);

    const loc = await this.withBudget(startRequest(), budgetMs);

    const state = this.peek(actorId);
    // 这次尝试没换来达标精度（超时 / 只拿到粗 fix）：进入冷却，下一轮不再空等。
    // 冷却到期若仍不达标会再试；拿到达标 fix 立即解除。
    if (state.precise) {
      this.precisionMissAt.delete(actorId);
    } else {
      this.precisionMissAt.set(actorId, this.now());
    }
    if (!loc || !state.available) return state;
    return { ...state, refreshed: true, source: "refreshed" };
  }

  /**
   * 只发不等：请求在后台完成并写回快照，本轮不等待。
   *
   * 之前这里 `void startRequest()` 丢掉了回包——后台请求拿到的 fix 没人落快照，
   * 「下一轮直接吃到」只靠客户端自己的周期上报。现在回包照样 apply（幂等、只认更新
   * 的 capturedAt），才真的把新鲜度留给下一轮。
   */
  private fireBackground(
    actorId: string,
    startRequest: () => Promise<ClientLocationWire | null>,
  ): void {
    const nowMs = this.now();
    const last = this.backgroundAt.get(actorId) ?? 0;
    if (nowMs - last < BACKGROUND_REQUEST_MIN_GAP_MS) return;
    this.backgroundAt.set(actorId, nowMs);
    void startRequest();
  }

  /** 预算内等待，超时返回 null（在途请求不取消，回包仍会写快照）。 */
  private withBudget(
    p: Promise<ClientLocationWire | null>,
    budgetMs: number,
  ): Promise<ClientLocationWire | null> {
    return new Promise<ClientLocationWire | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, budgetMs);
      timer.unref?.();
      void p.then(
        (loc) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(loc);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  /**
   * 把刷新的坐标写回快照（幂等）。
   *
   * 只在拿到的 fix 比现有快照更新时写入——WS 路径（client.location_report →
   * LocationIngestPipeline）通常已经写过一次并带上 placeKind，这里不覆盖它。
   */
  private apply(actorId: string, loc: ClientLocationWire): void {
    const context = this.deps.context;
    if (!context) return;
    const nowMs = this.now();
    const observedAt = observedAtOf(loc, nowMs);
    const snapshot = context.get(actorId)?.location;
    if (snapshot && observedAt < snapshot.observedAt) return;
    // 同一采集时刻、但这次更准（高德/geolocator 并行时两个引擎可能给同一 stamp）：
    // 以精度更好者为准，别因为「不更新」把更准的 fix 丢掉。
    if (snapshot && observedAt === snapshot.observedAt) {
      const next = loc.accuracyMeters;
      const prev = snapshot.accuracyMeters;
      const better =
        typeof next === "number" && next > 0 && (prev == null || next < prev - 0.5);
      if (!better) return;
    }

    let place: { kind: ActorPlaceKind; label?: string } | undefined;
    try {
      const semantic = this.deps.places?.matchCached(actorId, loc);
      if (semantic) {
        place = {
          kind: semantic.record.kind,
          label: semantic.record.label ?? semantic.record.poiName ?? undefined,
        };
      }
    } catch {
      /* 语义查询失败：placeKind 退回 unknown，不影响坐标 */
    }
    context.updateLocation(actorId, loc, "turn-hook", place);
  }
}
