/**
 * 位置能力（持续上报 / 历史存储 / 地理围栏 / 节律联动）环境变量。
 *
 * 隐私设计原则：
 *   - 所有位置追踪默认关闭：LOCATION_TRACKING_MODE 缺省 ondemand，
 *     仅 Agent 真正需要（如天气工具）时按需向客户端拉一次 GPS；
 *   - continuous 与位置历史存储都必须显式开启（用户可控）；
 *   - 历史数据只落本地 SQLite（data/location/），不上传任何云端；
 *   - 用户可随时清除历史（工具 / clearHistory），地理围栏事件全量审计。
 */

import { getDataDir } from "./data-dir.js";
import { join } from "node:path";

export type LocationTrackingMode = "ondemand" | "continuous";

/** 位置上报模式：continuous 时客户端按间隔定时上报；其余值一律按需（隐私优先）。 */
export function getLocationTrackingMode(): LocationTrackingMode {
  const raw = process.env.LOCATION_TRACKING_MODE?.trim().toLowerCase();
  return raw === "continuous" ? "continuous" : "ondemand";
}

/** 持续模式上报间隔（秒）：缺省 5 分钟，夹紧到 30s..1h（防客户端刷爆服务端）。 */
export function getLocationReportIntervalSec(): number {
  const v = Number.parseInt(process.env.LOCATION_REPORT_INTERVAL_SEC ?? "", 10);
  if (!Number.isFinite(v)) return 300;
  return Math.min(Math.max(v, 30), 3600);
}

/**
 * 位置历史存储开关：显式 env 优先。
 * 2026-09-05 调整：历史默认开启（未显式配置时不论 tracking 模式都落库）——
 * 常去地点挖掘（对话 prompt 的【常去地点】块）依赖历史样本，默认关闭则永远为空。
 * 数据只落本地 SQLite（data/location/），不上传云端，可用 LOCATION_HISTORY_ENABLED=0 关闭。
 */
export function isLocationHistoryEnabled(mode: LocationTrackingMode = getLocationTrackingMode()): boolean {
  const raw = process.env.LOCATION_HISTORY_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/** 历史轨迹保留天数（缺省 7 天），超期样本由惰性清理删除。 */
export function getLocationHistoryRetentionDays(): number {
  const v = Number.parseInt(process.env.LOCATION_HISTORY_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(v) && v > 0 && v <= 365 ? v : 7;
}

/** 位置 SQLite 库路径（缺省 data/location/location.db，纯本地不上云）。 */
export function getLocationDbPath(): string {
  return (
    process.env.AGENT_LOCATION_DB?.trim() ||
    join(getDataDir(), "location", "location.db")
  );
}

/** DBSCAN 常去地点聚类半径（米，缺省 150m：同一栋楼/小区口的样本聚成一簇）。 */
export function getLocationDbscanEpsMeters(): number {
  const v = Number.parseFloat(process.env.LOCATION_DBSCAN_EPS_METERS ?? "");
  return Number.isFinite(v) && v >= 30 && v <= 2000 ? v : 150;
}

/** DBSCAN 成簇最小样本数（缺省 20：约 1.5 小时持续上报才算「常去」）。 */
export function getLocationDbscanMinPoints(): number {
  const v = Number.parseInt(process.env.LOCATION_DBSCAN_MIN_POINTS ?? "", 10);
  return Number.isFinite(v) && v > 2 && v <= 2000 ? v : 20;
}
