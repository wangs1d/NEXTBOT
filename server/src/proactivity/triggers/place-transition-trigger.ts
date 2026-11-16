/**
 * 地点语义转换触发器 —— 位置方案 E 的「开口」环节。
 *
 * 与 geofence 的分工：
 *   - geofence 是用户预设的规则（到了 X 就提醒/起任务/回调）；
 *   - 本触发器只识别**语义变化**（回家、离家、到公司、到外地），把事实交给
 *     ProactivityHub，由话术层模型决定「问一句 / 给建议 / 沉默」——
 *     不在代码里写死每个场景该说什么。
 *
 * 克制原则：
 *   - 首次见到位置只建基线，不开口（避免重启后把「一直在家」当「刚到家」）；
 *   - 语义变化需要连续确认（默认 2 次可信上报；系统围栏事件算 1 次）；
 *   - 同一转换有冷却（回家/离家/到公司 12h，异地 24h）；
 *   - 低精度 fix（>500m）不参与判定——WiFi 漂移不能触发「到家」。
 */

import type { ProactiveIntent } from "../proactivity-types.js";
import { haversineMeters } from "../../services/geo-utils.js";

export type SemanticPlaceSnapshot = {
  placeId: string;
  kind: "home" | "work" | "other";
  /** 地点质心（判定离家/异地距离用） */
  latitude: number;
  longitude: number;
  label?: string;
  city?: string | null;
  /** 用户确认过的地点可以只凭一次可信 fix 判定 */
  confirmed?: boolean;
  radiusMeters?: number;
};

export type PlaceTransitionKind =
  | "home_arrival"
  | "home_departure"
  | "work_arrival"
  | "place_away";

export type PlaceTransitionTriggerDeps = {
  /** 当前坐标落到的已知地点（只返回高置信/已确认地点；无则 null） */
  resolvePlace: (actorId: string, loc: { latitude: number; longitude: number }) => SemanticPlaceSnapshot | null;
  /** 已确认/高置信的家（用于「离开家」和「异地」判定） */
  resolveHome: (actorId: string) => SemanticPlaceSnapshot | null;
  submitIntent: (intent: ProactiveIntent) => void;
  now?: () => Date;
  /** 需要连续几次可信上报才确认转换（缺省 2；geofence/已确认地点为 1） */
  confirmations?: number;
  /** 两次确认上报的最大间隔（缺省 30 分钟） */
  pendingMaxGapMs?: number;
  /** 同一转换冷却（缺省 12h） */
  cooldownMs?: number;
  /** 异地建议冷却（缺省 24h） */
  awayCooldownMs?: number;
  /** 距家多远算异地（缺省 50km） */
  awayDistanceMeters?: number;
};

type ActorState = {
  current: { place: SemanticPlaceSnapshot; at: number } | null;
  pending: { place: SemanticPlaceSnapshot; count: number; lastAt: number } | null;
  firedAt: Map<string, number>;
};

/** 构建一次语义转换的主动意图（纯函数，测试直调）。 */
export function buildPlaceTransitionIntent(
  actorId: string,
  kind: PlaceTransitionKind,
  next: SemanticPlaceSnapshot,
  prev: SemanticPlaceSnapshot | null,
  awayDistanceMeters?: number,
): ProactiveIntent {
  const nextName = next.label?.trim() || (next.kind === "home" ? "家" : next.kind === "work" ? "公司" : "外面");
  const prevName = prev?.label?.trim() || (prev?.kind === "home" ? "家" : prev?.kind === "work" ? "公司" : "外面");
  switch (kind) {
    case "home_arrival":
      return {
        actorId,
        kind: "place_home_arrival",
        importance: "low",
        title: `用户到家：${nextName}`,
        summary:
          `用户刚回到「${nextName}」。像家人注意到对方到家一样自然：` +
          `一句简短问候即可；只有上下文里确有和这个地点/时间相关的待办（拿快递、买菜、休息）才顺带轻提，` +
          `没有就只问好，别编造任务。`,
        mode: "speak",
        source: "location",
        subject: nextName,
      };
    case "home_departure":
      return {
        actorId,
        kind: "place_home_departure",
        importance: "low",
        title: `用户离家：${prevName}`,
        summary:
          `用户刚离开「${prevName}」。可以问一句今天要去哪/要不要看天气或路况，` +
          `但没有相关上下文就简短道个别，不要追问行程。`,
        mode: "speak",
        source: "location",
        subject: nextName,
      };
    case "work_arrival":
      return {
        actorId,
        kind: "place_work_arrival",
        importance: "low",
        title: `用户到公司：${nextName}`,
        summary:
          `用户刚到「${nextName}」。一句简短问候即可；若今天有日程或待办可以轻提一句，` +
          `没有就只问好，不要展开工作细节。`,
        mode: "speak",
        source: "location",
        subject: nextName,
      };
    case "place_away":
      return {
        actorId,
        kind: "place_new_city",
        importance: "low",
        title: `用户到了外地：${nextName}`,
        summary:
          `用户现在在「${nextName}」，离家约 ${Math.round((awayDistanceMeters ?? 0) / 1000)} 公里。` +
          `如果想给游玩/吃饭建议，必须先调用工具拿真实天气、地点或路线数据；` +
          `拿不到就如实说不知道，绝对不要编造景点、价格或营业时间。` +
          `如果用户没有出行意图，也可以只问一句「到了？」。`,
        mode: "speak",
        source: "location",
        subject: nextName,
      };
  }
}

export class PlaceTransitionTrigger {
  private readonly deps: PlaceTransitionTriggerDeps;
  private readonly confirmations: number;
  private readonly pendingMaxGapMs: number;
  private readonly cooldownMs: number;
  private readonly awayCooldownMs: number;
  private readonly awayDistanceMeters: number;
  private readonly states = new Map<string, ActorState>();

  constructor(deps: PlaceTransitionTriggerDeps) {
    this.deps = deps;
    this.confirmations = Math.max(1, deps.confirmations ?? 2);
    this.pendingMaxGapMs = deps.pendingMaxGapMs ?? 30 * 60 * 1000;
    this.cooldownMs = deps.cooldownMs ?? 12 * 60 * 60 * 1000;
    this.awayCooldownMs = deps.awayCooldownMs ?? 24 * 60 * 60 * 1000;
    this.awayDistanceMeters = deps.awayDistanceMeters ?? 50_000;
  }

  /** 清除该 actor 的状态（清位置历史/删地点语义时联动）。 */
  invalidate(actorId: string): void {
    this.states.delete(actorId);
  }

  /**
   * 处理一次位置上报。返回本次产生的意图（便于测试/审计），实际开口经
   * submitIntent 异步交给 ProactivityHub。
   */
  handleLocationReport(
    actorId: string,
    loc: {
      latitude: number;
      longitude: number;
      accuracyMeters?: number;
      trigger?: "geofence" | "startup" | "manual";
      city?: string;
      district?: string;
    },
  ): ProactiveIntent | null {
    // 低精度 fix 不参与语义转换：宁可晚一条，也不误报「到家」
    if (loc.accuracyMeters != null && loc.accuracyMeters > 500) return null;
    const now = this.deps.now?.() ?? new Date();
    const nowMs = now.getTime();
    const home = this.deps.resolveHome(actorId);
    const matched = this.deps.resolvePlace(actorId, loc);
    const place = matched ?? this.synthesizeAwayFromHome(loc, home);
    if (!place) return null;

    const state = this.stateOf(actorId);
    const prev = state.current?.place ?? null;

    // 首次见到位置只建基线（重启后用户一直在某地，不应立即开口）。
    // 基线不要求连续确认——它不产生任何副作用，越早建立越能接住下一次转换。
    if (!prev) {
      state.current = { place, at: nowMs };
      state.pending = null;
      return null;
    }

    const trusted = loc.trigger === "geofence" || place.confirmed === true;
    const required = trusted ? 1 : this.confirmations;

    // 迟滞：同一地点连续 N 次可信上报才确认，避免边界抖动/单点漂移
    if (state.pending && state.pending.place.placeId === place.placeId) {
      if (nowMs - state.pending.lastAt <= this.pendingMaxGapMs) {
        state.pending.count += 1;
        state.pending.lastAt = nowMs;
      } else {
        state.pending = { place, count: 1, lastAt: nowMs };
      }
    } else {
      state.pending = { place, count: 1, lastAt: nowMs };
    }
    if (state.pending.count < required) return null;

    state.current = { place, at: nowMs };
    state.pending = null;

    if (prev.placeId === place.placeId) return null;

    const distanceFromHome = home ? haversineMeters(loc, home) : undefined;
    const transition = this.classifyTransition(prev, place, distanceFromHome);
    if (!transition) return null;

    // 「异地」必须有明确证据：离家 > 50km 且带有城市/地点名。
    // 否则健身房、超市这类 other 地点也会被当成异地，变成每天一次无意义建议。
    let awayDistance: number | undefined;
    if (transition === "place_away") {
      if (!home || !place.label?.trim()) return null;
      if ((distanceFromHome ?? 0) < this.awayDistanceMeters) return null;
      awayDistance = distanceFromHome ?? 0;
    }

    // 冷却按「转换类型」而非地点 id：异地换景点仍属同一次出行，
    // 按 placeId 记会让用户一天内在不同景点各收一条建议。
    const cooldown = transition === "place_away" ? this.awayCooldownMs : this.cooldownMs;
    const key = transition;
    const lastFired = state.firedAt.get(key) ?? 0;
    if (nowMs - lastFired < cooldown) return null;
    state.firedAt.set(key, nowMs);
    const intent = buildPlaceTransitionIntent(actorId, transition, place, prev, awayDistance);
    try {
      this.deps.submitIntent(intent);
    } catch (err) {
      console.log(`[PlaceTransition] 提交意图失败（忽略）: ${err}`);
    }
    return intent;
  }

  private stateOf(actorId: string): ActorState {
    let state = this.states.get(actorId);
    if (!state) {
      state = { current: null, pending: null, firedAt: new Map() };
      this.states.set(actorId, state);
    }
    return state;
  }

  /** 不在任何已知地点、但已远离家：合成一个「外面」快照，用于离家/异地判定。 */
  private synthesizeAwayFromHome(
    loc: { latitude: number; longitude: number; city?: string; district?: string },
    home: SemanticPlaceSnapshot | null,
  ): SemanticPlaceSnapshot | null {
    if (!home) return null;
    const distance = haversineMeters(loc, home);
    const radius = home.radiusMeters ?? 150;
    if (distance <= radius + 250) return null;
    return {
      placeId: `away:${home.placeId}`,
      kind: "other",
      latitude: loc.latitude,
      longitude: loc.longitude,
      label: loc.city?.trim() || loc.district?.trim() || undefined,
      city: loc.city?.trim() || null,
      confirmed: false,
    };
  }

  private classifyTransition(
    prev: SemanticPlaceSnapshot,
    next: SemanticPlaceSnapshot,
    distanceFromHome?: number,
  ): PlaceTransitionKind | null {
    if (next.kind === "home" && prev.kind !== "home") return "home_arrival";
    // 异地优先于「离家」：从家直接到外地，用户需要的是旅游建议，不是一句道别
    const farAway =
      distanceFromHome != null && distanceFromHome >= this.awayDistanceMeters;
    if (farAway && next.label?.trim()) return "place_away";
    if (prev.kind === "home" && next.kind === "work") return "work_arrival";
    if (prev.kind === "home" && next.kind !== "home") return "home_departure";
    if (next.kind === "work" && prev.kind !== "work") return "work_arrival";
    if (next.kind === "other" && prev.kind !== "other") return "place_away";
    return null;
  }
}
