/**
 * 地理围栏引擎（位置方案 C）。
 *
 * 围栏定义：name / lat / lng / radiusMeters / event(enter|leave|both) /
 * actionType(reminder|agent_task|webhook) / actionConfig。
 * 每次位置上报时用 Haversine 判定在栏内/栏外，与上次状态比对产生
 * enter/leave 事件，经 notifier 交给装配层分发动作（提醒 / Agent 任务 / webhook）。
 *
 * 安全与隐私：
 *   - 围栏只能由用户显式创建（geofence.create 工具 / 未来 UI），默认无围栏；
 *   - 事件全量走审计（装配层 notifier 写 audit.log）；
 *   - 状态（在栏内/外）持久化，重启不重复触发；首次见到位置只建立基线不发事件；
 *   - 围栏任意两次触发之间有最小间隔（防边界抖动的 enter/leave 交替刷事件）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getLocationDbPath } from "../config/location-env.js";
import { haversineMeters } from "./geo-utils.js";

export type GeofenceEventKind = "enter" | "leave" | "both";
export type GeofenceActionType = "reminder" | "agent_task" | "webhook";

export type GeofenceDefinition = {
  id: string;
  actorId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  event: GeofenceEventKind;
  actionType: GeofenceActionType;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GeofenceTriggeredEvent = {
  fence: GeofenceDefinition;
  kind: "enter" | "leave";
  distanceMeters: number;
  at: string;
  location: { latitude: number; longitude: number };
};

export type GeofenceInput = {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  event: GeofenceEventKind;
  actionType: GeofenceActionType;
  actionConfig: Record<string, unknown>;
  enabled?: boolean;
};

export type GeofenceOptions = {
  dbPath?: string;
  now?: () => Date;
  /** 围栏两次触发的最小间隔（任意方向，防边界抖动交替），缺省 5 分钟 */
  minTriggerGapMs?: number;
};

export const GEOFENCE_EVENT_KINDS: GeofenceEventKind[] = ["enter", "leave", "both"];
export const GEOFENCE_ACTION_TYPES: GeofenceActionType[] = ["reminder", "agent_task", "webhook"];

const NAME_MAX = 80;
const RADIUS_MIN = 20;
const RADIUS_MAX = 10_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS geofences (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius_meters REAL NOT NULL,
  event TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geofences_actor ON geofences(actor_id);

CREATE TABLE IF NOT EXISTS geofence_states (
  fence_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  inside INTEGER NOT NULL DEFAULT 0,
  last_event TEXT,
  last_event_at TEXT
);
`;

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fromJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToFence(row: Record<string, unknown>): GeofenceDefinition {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    event: (row.event as GeofenceEventKind) ?? "enter",
    actionType: (row.action_type as GeofenceActionType) ?? "reminder",
    actionConfig: fromJson(row.action_config as string | null),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 校验 webhook URL：必须是 http/https 且主机不是内网/环回/链路本地地址。
 *
 * 围栏配置经 Agent 工具由 LLM 生成后直传，不能信任其指向公网；地理围栏
 * webhook 若允许 127.0.0.1 / 169.254.169.254 / RFC1918 等地址，会构成
 * SSRF 面（探测本机服务、云元数据端点）。创建时校验 + 分发时复检双层把关。
 *
 * 已知局限：域名形式的主机不做 DNS 解析（解析到私网的 rebinding 场景
 * 未覆盖）——要彻底封死需在分发时 resolve-then-check，暂无必要。
 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // WHATWG URL 的 IPv6 hostname 保留方括号，先剥掉
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (host.includes(":")) {
    // IPv6：环回 / 未指定 / 唯一本地 fc00::/7 / 链路本地 fe80::/10；
    // IPv4-mapped 还原成点分十进制后按 v4 规则复检（WHATWG URL 会把
    // ::ffff:127.0.0.1 归一化成十六进制形式 ::ffff:7f00:1，两种都要认）
    if (host.startsWith("::ffff:")) {
      const rest = host.slice("::ffff:".length);
      if (rest.includes(".")) return isPublicHttpUrl(`http://${rest}`);
      const groups = rest.split(":");
      if (groups.length === 2) {
        const hi = Number.parseInt(groups[0], 16);
        const lo = Number.parseInt(groups[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPublicHttpUrl(`http://${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
        }
      }
      return false;
    }
    if (host === "::1" || host === "::") return false;
    if (/^f[cd]/.test(host)) return false;
    if (/^fe[89ab]/.test(host)) return false;
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false; // 本网络 / 私网 / 环回
    if (a === 169 && b === 254) return false; // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return false; // 私网
    if (a === 192 && b === 168) return false; // 私网
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  return true; // 公网域名
}

/**
 * 由围栏名称推断地点语义。
 *
 * 围栏是用户自己命名的（"家"、"公司"、"健身房"），名称本身就是最强的语义
 * 信号——比坐标聚类可靠。关键词表刻意保守：只认明确的家/公司，其余一律
 * other，宁可不知道也不猜错（猜错会让 Agent 说出「你已经到家了」这种话）。
 */
export function inferPlaceKind(name: string | undefined | null): "home" | "work" | "other" {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return "other";
  if (/(^|[^a-z])(home|house|apartment)([^a-z]|$)/.test(n) || /家|住处|住宅|宿舍|家里/.test(n)) {
    return "home";
  }
  if (/(^|[^a-z])(work|office|company)([^a-z]|$)/.test(n) || /公司|办公室|单位|工位|上班/.test(n)) {
    return "work";
  }
  return "other";
}

/** 校验围栏输入（工具层与服务层共用一份口径）。 */export function validateGeofenceInput(input: Partial<GeofenceInput>): string | null {
  const name = String(input.name ?? "").trim();
  if (!name) return "缺少围栏名称 name";
  if (name.length > NAME_MAX) return `围栏名称过长（≤${NAME_MAX} 字符）`;

  const lat = Number(input.latitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return "latitude 须为 -90..90 的有效纬度";
  const lng = Number(input.longitude);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return "longitude 须为 -180..180 的有效经度";

  const radius = Number(input.radiusMeters);
  if (!Number.isFinite(radius) || radius < RADIUS_MIN || radius > RADIUS_MAX) {
    return `radiusMeters 须为 ${RADIUS_MIN}..${RADIUS_MAX} 米`;
  }

  if (!GEOFENCE_EVENT_KINDS.includes(input.event as GeofenceEventKind)) {
    return `event 须为 ${GEOFENCE_EVENT_KINDS.join(" / ")} 之一`;
  }
  if (!GEOFENCE_ACTION_TYPES.includes(input.actionType as GeofenceActionType)) {
    return `actionType 须为 ${GEOFENCE_ACTION_TYPES.join(" / ")} 之一`;
  }

  const cfg = (input.actionConfig ?? {}) as Record<string, unknown>;
  switch (input.actionType) {
    case "reminder": {
      const title = String(cfg.title ?? "").trim();
      if (!title) return "reminder 动作缺少 actionConfig.title";
      break;
    }
    case "agent_task": {
      const goal = String(cfg.goal ?? "").trim();
      if (!goal) return "agent_task 动作缺少 actionConfig.goal";
      break;
    }
    case "webhook": {
      const url = String(cfg.url ?? "").trim();
      if (!isPublicHttpUrl(url)) {
        return "webhook 动作需要合法的外网 actionConfig.url（http/https，禁止内网/环回地址）";
      }
      break;
    }
  }
  return null;
}

export class GeofenceService {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;
  private readonly minTriggerGapMs: number;
  private notifier:
    | ((event: GeofenceTriggeredEvent) => void | Promise<void>)
    | null = null;
  /** 围栏配置变更通知（新建/删除/启停）：装配层据此把最新配置推给在线客户端
   *  重新注册系统围栏。不下发就只在重连时生效，用户新建围栏后会「明明设了却不触发」。 */
  private onChanged: ((actorId: string) => void) | null = null;

  constructor(opts?: GeofenceOptions) {
    const file = opts?.dbPath ?? getLocationDbPath();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.now = opts?.now ?? (() => new Date());
    this.minTriggerGapMs = opts?.minTriggerGapMs ?? 5 * 60 * 1000;
  }

  /** 配置变更出口（装配层接：向该 actor 的在线连接重新下发围栏）。 */
  setOnChanged(fn: ((actorId: string) => void) | null): void {
    this.onChanged = fn;
  }

  private fireChanged(actorId: string): void {
    try {
      this.onChanged?.(actorId);
    } catch (err) {
      console.log(`[GeofenceService] 变更通知失败（忽略）: ${err}`);
    }
  }

  /** 事件出口（装配层接：审计 + 按 actionType 分发动作）。 */
  setNotifier(fn: ((event: GeofenceTriggeredEvent) => void | Promise<void>) | null): void {
    this.notifier = fn;
  }

  create(actorId: string, input: GeofenceInput): GeofenceDefinition | { error: string } {
    const invalid = validateGeofenceInput(input);
    if (invalid) return { error: invalid };
    const nowIso = this.now().toISOString();
    const fence: GeofenceDefinition = {
      id: `gf_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      actorId,
      name: String(input.name).trim(),
      latitude: Number(input.latitude),
      longitude: Number(input.longitude),
      radiusMeters: Number(input.radiusMeters),
      event: input.event,
      actionType: input.actionType,
      actionConfig: input.actionConfig ?? {},
      enabled: input.enabled !== false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.db
      .prepare(
        `INSERT INTO geofences
          (id, actor_id, name, latitude, longitude, radius_meters, event, action_type, action_config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fence.id,
        fence.actorId,
        fence.name,
        fence.latitude,
        fence.longitude,
        fence.radiusMeters,
        fence.event,
        fence.actionType,
        toJson(fence.actionConfig),
        fence.enabled ? 1 : 0,
        fence.createdAt,
        fence.updatedAt,
      );
    this.fireChanged(actorId);
    return fence;
  }

  list(actorId: string): GeofenceDefinition[] {
    const rows = this.db
      .prepare(`SELECT * FROM geofences WHERE actor_id = ? ORDER BY created_at DESC`)
      .all(actorId) as Record<string, unknown>[];
    return rows.map(rowToFence);
  }

  get(actorId: string, id: string): GeofenceDefinition | null {
    const row = this.db
      .prepare(`SELECT * FROM geofences WHERE actor_id = ? AND id = ?`)
      .get(actorId, id) as Record<string, unknown> | undefined;
    return row ? rowToFence(row) : null;
  }

  delete(actorId: string, id: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM geofences WHERE actor_id = ? AND id = ?`)
      .run(actorId, id);
    this.db.prepare(`DELETE FROM geofence_states WHERE fence_id = ?`).run(id);
    const removed = Number(info.changes) > 0;
    if (removed) this.fireChanged(actorId);
    return removed;
  }

  setEnabled(actorId: string, id: string, enabled: boolean): GeofenceDefinition | null {
    const info = this.db
      .prepare(`UPDATE geofences SET enabled = ?, updated_at = ? WHERE actor_id = ? AND id = ?`)
      .run(enabled ? 1 : 0, this.now().toISOString(), actorId, id);
    if (Number(info.changes) === 0) return null;
    this.fireChanged(actorId);
    return this.get(actorId, id);
  }

  /**
   * 处理一次位置上报：Haversine 判定各围栏 inside/outside，与持久化状态比对，
   * 产生 enter/leave 事件（经 notifier 发出）。返回本次触发的事件列表。
   *
   * 首次见到某围栏的位置只建立基线（不发事件）——用户创建围栏时人已在栏内，
   * 不应立刻触发「到达」；leave 后再次 enter 才是真正的事件。
   */
  processLocationReport(
    actorId: string,
    loc: { latitude: number; longitude: number },
  ): GeofenceTriggeredEvent[] {
    const fences = this.list(actorId).filter((f) => f.enabled);
    if (fences.length === 0) return [];
    const atIso = this.now().toISOString();
    const triggered: GeofenceTriggeredEvent[] = [];

    for (const fence of fences) {
      const distance = haversineMeters(loc, fence);
      const inside = distance <= fence.radiusMeters;
      const state = this.db
        .prepare(`SELECT * FROM geofence_states WHERE fence_id = ?`)
        .get(fence.id) as Record<string, unknown> | undefined;
      const known = state !== undefined;
      const wasInside = known ? Number(state.inside) === 1 : null;
      const lastEventAtMs = known ? Date.parse(String(state.last_event_at ?? "")) : NaN;

      // 只推进 inside 基线；last_event / last_event_at 是防抖记账，不能被覆盖
      this.db
        .prepare(
          `INSERT INTO geofence_states (fence_id, actor_id, inside)
           VALUES (?, ?, ?)
           ON CONFLICT(fence_id) DO UPDATE SET inside = excluded.inside`,
        )
        .run(fence.id, actorId, inside ? 1 : 0);

      if (!known || wasInside === null || wasInside === inside) continue;
      const kind: "enter" | "leave" = inside ? "enter" : "leave";
      if (fence.event !== "both" && fence.event !== kind) continue;
      // 防抖：围栏任意事件触发后有冷却期（边界抖动是 enter/leave 快速交替，
      // 不是同方向重复——冷却按「上一事件」计而非「同方向上一事件」）。
      // 冷却期内的换向仍推进基线但不发事件：10 分钟内的往返属于噪声，
      // 到达/离开的语义信号（回家过夜 / 出门上班）不受影响。
      if (Number.isFinite(lastEventAtMs) && this.now().getTime() - lastEventAtMs < this.minTriggerGapMs) {
        continue;
      }

      this.db
        .prepare(`UPDATE geofence_states SET last_event = ?, last_event_at = ? WHERE fence_id = ?`)
        .run(kind, atIso, fence.id);

      const event: GeofenceTriggeredEvent = {
        fence,
        kind,
        distanceMeters: Math.round(distance),
        at: atIso,
        location: { latitude: loc.latitude, longitude: loc.longitude },
      };
      triggered.push(event);
      if (this.notifier) {
        try {
          const out = this.notifier(event);
          if (out && typeof (out as Promise<void>).catch === "function") {
            void (out as Promise<void>).catch((err) => {
              console.log(`[GeofenceService] 事件分发失败（忽略）: ${err}`);
            });
          }
        } catch (err) {
          console.log(`[GeofenceService] 事件分发异常（忽略）: ${err}`);
        }
      }
    }
    return triggered;
  }

  /**
   * 判定当前位置落在哪个围栏内（不产生事件、不推进状态）。
   *
   * 用途是**情境快照**的 placeKind（在家 / 在公司 / 在别处）：这是 State 层
   * 需要的语义状态，与「到达/离开」事件是两件事——事件是一次性通知，状态是
   * 持续事实。多个围栏重叠时取半径最小的那个（更具体的地点）。
   */
  matchPlace(
    actorId: string,
    loc: { latitude: number; longitude: number },
  ): { fence: GeofenceDefinition; kind: "home" | "work" | "other"; radiusMeters: number } | null {
    const fences = this.list(actorId).filter((f) => f.enabled);
    let best: { fence: GeofenceDefinition; kind: "home" | "work" | "other"; radiusMeters: number } | null =
      null;
    for (const fence of fences) {
      const distance = haversineMeters(loc, fence);
      if (distance > fence.radiusMeters) continue;
      if (best && fence.radiusMeters >= best.radiusMeters) continue;
      best = { fence, kind: inferPlaceKind(fence.name), radiusMeters: fence.radiusMeters };
    }
    return best;
  }

  close(): void {
    this.db.close();
  }
}
