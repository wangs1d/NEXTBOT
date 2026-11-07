import { z } from "zod";

/** WebSocket `chat.user_message` 附带的前端定位（优先于 IP 地理库）。 */
export const clientLocationWireSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  city: z.string().max(120).optional(),
  /** 区/县，如「红花岗区」 */
  district: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  timezone: z.string().max(80).optional(),
  /** 展示用，如「贵州省 · 遵义市」 */
  label: z.string().max(200).optional(),
  /** 上报来源标注：continuous=持续模式定时上报；缺省视为按需/面板主动上报 */
  source: z.enum(["continuous", "ondemand", "report"]).optional(),
  /**
   * 触发原因（持续感知）：geofence=系统围栏唤醒后上报（App 可能刚被唤醒），
   * startup=连接建立补报，manual=用户主动/面板。用于服务端区分「事件驱动」
   * 与「按需拉取」，并如实标注龄期。
   */
  trigger: z.enum(["geofence", "startup", "manual"]).optional(),
  /** 围栏触发时的围栏 id 与原始触发时刻（ISO），用于审计与去重 */
  fenceId: z.string().max(80).optional(),
  triggeredAt: z.string().max(64).optional(),
});

export type ClientLocationWire = z.infer<typeof clientLocationWireSchema>;

/**
 * 设备时钟快照（2026-11-05 时间感知重构）。
 *
 * 时区是**设备属性**，不是地理信息：系统自己就知道（运营商 NITZ / 系统设置），
 * 零权限、零网络、跨时区落地即切换。此前时区只能由 GPS 逆地理链路带上来，
 * 抓不到 fix 就退回服务器时区（境外全错）。本契约让客户端在每条消息上无条件
 * 直报，与定位完全解耦。
 *
 * `at` 必须是**绝对时刻**（带 Z 或 offset 的 ISO）：裸本地时间在服务端会被按
 * 服务器时区解析，跨时区时直接错开数小时。
 */
export const clientClockWireSchema = z.object({
  /** 设备 IANA 时区，如 Asia/Shanghai；服务端会校验可被 Intl 解析 */
  timezone: z.string().min(1).max(80).optional(),
  /** 当前 UTC 偏移（分钟，含夏令时），用于识别「时区字符串与偏移不一致」 */
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  /** 设备瞬时时刻（ISO8601，必须带 Z 或 offset） */
  at: z.string().min(1).max(64).optional(),
  /** 采集来源：event=系统时区变更事件；snapshot=前台/消息随行快照 */
  source: z.enum(["event", "snapshot"]).optional(),
});

export type ClientClockWire = z.infer<typeof clientClockWireSchema>;

export type ClientGeoContext = {
  clientIp?: string;
  clientLocation?: ClientLocationWire;
};

export function parseClientLocation(raw: unknown): ClientLocationWire | undefined {
  const parsed = clientLocationWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseClientClock(raw: unknown): ClientClockWire | undefined {
  const parsed = clientClockWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
