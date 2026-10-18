/**
 * 连续导航会话服务（手机端通用能力，旅游规划为首个使用方）。
 *
 * 解决的问题：多地点行程里用户不必「导一段 → 手动找下一站 → 再导一段」，
 * 一份会话串起整条地点链，用户逐段确认，页面跳去导航源再回来可无损恢复。
 *
 * 状态机（阶段流转由用户手动按钮驱动，暂不做 GPS 自动判定；
 * 项目已有定位能力，自动检测留作后续增强）：
 *
 *   going（前往中）--arrive--> stay（已到达 · 停留/游玩中）
 *   stay  --depart--> 下一站 going（最后一站 depart → done）
 *   going --skip  --> 下一站 going（跳过当前目标）
 *   任意态 --end   --> done
 *
 * 存储：进程内存，键 = planId（一份行程同时只有一个活跃会话，重建即替换）。
 * 会话状态放服务端的原因：页面导航去高德网页后再返回时整页重载，
 * 只有服务端状态能无损恢复进度；Agent 侧后续也可据此感知导航进行时。
 */

import { randomUUID } from "node:crypto";
import { getNavigationProvider, type NavStopInput, type NavTravelMode } from "./nav-provider.js";

export type NavPhase = "going" | "stay" | "done";

export interface NavSession {
  id: string;
  planId: string;
  providerId: string;
  /** 站点链（本次连续导航的地点串，来自行程当日的站点） */
  stops: NavStopInput[];
  startIdx: number;
  /** 当前目标站下标 */
  curIdx: number;
  phase: NavPhase;
  mode: NavTravelMode;
  createdAt: number;
  updatedAt: number;
}

/** 会话对外的完整快照：状态 + 由导航源实时拼出的当前段链接 */
export interface NavSessionView extends NavSession {
  /** phase=going 时为当前段导航链接；stay/done 为 null */
  legUrl: string | null;
  /** 进度辅助字段（省得每个调用方自己算） */
  total: number;
  legIndex: number;
}

const MAX_STOPS = 24;
const NAME_MAX = 80;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const MODES: ReadonlySet<string> = new Set(["driving", "walking", "transit", "cycling"]);

export class NavigationSessionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

/** 站点入参校验（系统边界：来自页面提交，必须显式校验） */
function normalizeStops(raw: unknown): NavStopInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new NavigationSessionError("stops is required");
  }
  if (raw.length > MAX_STOPS) {
    throw new NavigationSessionError(`stops exceeds ${MAX_STOPS}`);
  }
  return raw.map((item) => {
    const s = (item ?? {}) as Partial<NavStopInput>;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, NAME_MAX) : "";
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    if (!name) throw new NavigationSessionError("stop name is required");
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new NavigationSessionError(`stop "${name}" has invalid lat`);
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new NavigationSessionError(`stop "${name}" has invalid lng`);
    }
    return { name, lat, lng };
  });
}

export class NavigationSessionService {
  /** 键 = planId（活跃会话），done 会话不占活跃键 */
  private active = new Map<string, NavSession>();

  create(
    planId: string,
    input: {
      stops: unknown;
      startIndex?: number;
      providerId?: string;
      mode?: string;
    },
  ): NavSessionView {
    const pid = typeof planId === "string" ? planId.trim().slice(0, 120) : "";
    if (!pid) throw new NavigationSessionError("planId is required");
    const stops = normalizeStops(input.stops);
    const startIdx = clampInt(Number(input.startIndex ?? 0) || 0, 0, stops.length - 1);
    const mode = (input.mode && MODES.has(input.mode) ? input.mode : "driving") as NavTravelMode;
    const provider = getNavigationProvider(input.providerId);
    const now = Date.now();
    // 同一行程重建会话 = 旧会话作废（用户重新选起点）
    const session: NavSession = {
      id: randomUUID().replace(/-/g, "").slice(0, 16),
      planId: pid,
      providerId: provider.id,
      stops,
      startIdx,
      curIdx: startIdx,
      phase: "going",
      mode,
      createdAt: now,
      updatedAt: now,
    };
    this.active.set(pid, session);
    return this.view(session);
  }

  /** 当前活跃会话（done 不算活跃）；无则 null */
  getActive(planId: string): NavSessionView | null {
    const s = this.active.get(planId);
    if (!s) return null;
    if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
      this.active.delete(planId);
      return null;
    }
    return this.view(s);
  }

  arrive(planId: string): NavSessionView {
    const s = this.mustGet(planId);
    if (s.phase === "going") s.phase = "stay";
    s.updatedAt = Date.now();
    return this.view(s);
  }

  depart(planId: string): NavSessionView {
    const s = this.mustGet(planId);
    if (s.phase === "going") throw new NavigationSessionError("not arrived yet", 409);
    this.advance(s);
    return this.view(s);
  }

  skip(planId: string): NavSessionView {
    const s = this.mustGet(planId);
    if (s.phase !== "going") throw new NavigationSessionError("skip only while going", 409);
    this.advance(s);
    return this.view(s);
  }

  end(planId: string): NavSessionView {
    const s = this.mustGet(planId);
    s.phase = "done";
    s.updatedAt = Date.now();
    const view = this.view(s);
    this.active.delete(planId); // done 后不再占活跃键
    return view;
  }

  /** 前进到下一站；已是最后一站则收束为 done */
  private advance(s: NavSession): void {
    s.updatedAt = Date.now();
    if (s.curIdx >= s.stops.length - 1) {
      s.phase = "done";
      this.active.delete(s.planId);
      return;
    }
    s.curIdx += 1;
    s.phase = "going";
  }

  private mustGet(planId: string): NavSession {
    const s = this.active.get(planId);
    if (!s) throw new NavigationSessionError("no active navigation session", 404);
    if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
      this.active.delete(planId);
      throw new NavigationSessionError("navigation session expired", 404);
    }
    return s;
  }

  /** 当前段导航链接：going 才有；上一站坐标作起点（首段交给导航源自定位） */
  private legUrl(s: NavSession): string | null {
    if (s.phase !== "going") return null;
    const to = s.stops[s.curIdx];
    if (!to) return null;
    const from = s.curIdx > 0 ? (s.stops[s.curIdx - 1] ?? null) : null;
    return getNavigationProvider(s.providerId).buildLegUrl({ from, to, mode: s.mode });
  }

  private view(s: NavSession): NavSessionView {
    return {
      ...s,
      stops: s.stops.map((p) => ({ ...p })),
      legUrl: this.legUrl(s),
      total: s.stops.length - s.startIdx,
      legIndex: s.curIdx - s.startIdx + 1,
    };
  }
}

export const navigationSessions = new NavigationSessionService();
