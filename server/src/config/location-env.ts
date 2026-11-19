/**
 * 位置能力（持续上报 / 历史存储 / 地理围栏 / 节律联动）环境变量。
 *
 * 隐私设计原则：
 *   - 缺省 continuous（2026-11-19 起）：Agent 需要持续知道用户位置；显式
 *     LOCATION_TRACKING_MODE=ondemand 可退回「只在需要时拉一次 GPS」；
 *   - 位置历史存储可显式关闭（用户可控）；
 *   - 历史数据只落本地 SQLite（data/location/），不上传任何云端；
 *   - 用户可随时清除历史（工具 / clearHistory），地理围栏事件全量审计。
 */

import { getDataDir } from "./data-dir.js";
import { join } from "node:path";

export type LocationTrackingMode = "ondemand" | "continuous";

/**
 * 位置上报模式：缺省 continuous（客户端按间隔定时上报，Agent 持续可知）；
 * 显式 ondemand/off/0/false 退回按需拉取。未知值一律按 continuous 处理，
 * 避免拼写错误把「持续感知」静默降级成「几乎不更新」。
 */
export function getLocationTrackingMode(): LocationTrackingMode {
  const raw = process.env.LOCATION_TRACKING_MODE?.trim().toLowerCase();
  if (raw === "ondemand" || raw === "off" || raw === "0" || raw === "false") {
    return "ondemand";
  }
  return "continuous";
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
 * 常去地点/日行程挖掘（画像投影与 place 工具）依赖历史样本，默认关闭则永远为空。
 * 数据只落本地 SQLite（data/location/），不上传云端，可用 LOCATION_HISTORY_ENABLED=0 关闭。
 */
export function isLocationHistoryEnabled(mode: LocationTrackingMode = getLocationTrackingMode()): boolean {
  const raw = process.env.LOCATION_HISTORY_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/**
 * 历史轨迹保留天数（缺省 7 天），超期样本由惰性清理删除。
 *
 * 7 天是隐私与可用性的折中：足够覆盖一个完整周（日行程 / 工作日习惯），
 * 又不至于让本地轨迹长期堆积。日行程与习惯都按需实时查询，不做常驻缓存，
 * 保留期改小后不存在「缓存里还留着已删数据」的问题。
 */
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

/**
 * 是否把常去地点自动注册成 observe 系统围栏（缺省关闭）。
 *
 * App 退后台/被杀后，持续轮询会被系统限流；只有系统围栏能在后台拿到
 * 「进了/离开了哪个常去地点」。默认不开是隐私边界：推断出来的地点
 * 不自动写进系统定位服务，需部署方显式开启。
 */
export function isAutoObserveFrequentPlacesEnabled(): boolean {
  const raw = process.env.LOCATION_AUTO_OBSERVE_FREQUENT_PLACES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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

/**
 * 已上报位置的可复用窗口（秒，缺省 15 分钟）：窗口内的位置直接给工具用，
 * 不再向客户端下发一次按需 GPS。必须 ≥ 客户端主动上报间隔，否则位置类工具
 * 每次都要现拉一次 GPS，拉不到就整轮没有数据。夹紧到 60s..6h。
 */
export function getLocationReuseWindowMs(): number {
  const v = Number.parseInt(process.env.LOCATION_REUSE_WINDOW_SEC ?? "", 10);
  const sec = Number.isFinite(v) && v > 0 ? v : 900;
  return Math.min(Math.max(sec, 60), 21600) * 1000;
}

/** 最近已知位置的最大龄期（分钟，缺省 120）：超过即视为不可用，返回 null。 */
export function getLocationLastKnownMaxAgeMs(): number {
  const v = Number.parseInt(process.env.LOCATION_LAST_KNOWN_MAX_AGE_MIN ?? "", 10);
  const min = Number.isFinite(v) && v > 0 ? v : 120;
  return Math.min(min, 7 * 24 * 60) * 60_000;
}
