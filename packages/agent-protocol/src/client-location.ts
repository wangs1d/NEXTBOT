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
  /**
   * 精确位置（2026-11-14）：完整门牌地址与最近地标。旧客户端不填也没关系——
   * 服务端会用高德逆地理补齐；带上来则省一次外网反查。
   */
  address: z.string().max(300).optional(),
  /** 街道/乡镇（如「下五屯街道」） */
  township: z.string().max(120).optional(),
  /** 最近地标/AOI 名称（如「九华苑」）；poiDistanceMeters 为到该地标的距离（米） */
  poi: z.string().max(200).optional(),
  poiDistanceMeters: z.number().finite().nonnegative().max(100_000).optional(),
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
  // ─── 定位精度元数据（2026-11-10 精确定位引擎）────────────────────────
  // 主流范式（Android FusedLocationProvider / iOS CLLocationManager）：坐标
  // 本身不构成可信位置，必须携带「这个 fix 有多准、何时采的」才可被服务端
  // 做质量裁决（精度门槛、龄期校验、降级策略）。全部可选以兼容旧客户端。
  /** 水平精度半径（米，68% 置信），即坐标真实位置有 68% 概率在此半径内 */
  accuracyMeters: z.number().finite().nonnegative().max(100_000).optional(),
  /** 海拔（米） */
  altitudeMeters: z.number().finite().min(-1000).max(10_000).optional(),
  /** 瞬时速度（米/秒，非负） */
  speedMps: z.number().finite().nonnegative().max(400).optional(),
  /** 航向（度，0=正北顺时针） */
  headingDegrees: z.number().finite().min(0).max(360).optional(),
  /** fix 采集时刻（ISO，带 Z 或 offset）。缺省由服务端按接收时刻处理 */
  capturedAt: z.string().max(64).optional(),
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

/**
 * 围栏注册回执（`client.geofence_report`）。
 *
 * 服务端下发围栏后，客户端必须如实回报「系统围栏是否真的注册成功」：
 *  - 失败项逐条给原因（权限缺失 / 系统定位关闭 / addProximityAlert 异常）；
 *  - 权限与定位开关是**诊断字段**：Android 10+ 没有「始终允许」定位，
 *    App 被杀后围栏不会触发，但注册 API 仍返回成功——不带上这一层，
 *    服务端会把「注册成功但永不触发」当成正常；
 *  - lastBootRestore 是上次开机重建的结果（开机时无连接，只能下次连上补报）。
 *
 * 全部字段宽松校验：回执坏了不能影响主链路。
 */
export const geofenceSyncReportSchema = z.object({
  ok: z.boolean(),
  platform: z.enum(["android", "ios", "other"]).optional(),
  /** 本次要求注册的围栏数（含 disabled 已过滤后的在线配置） */
  requested: z.number().int().min(0).max(200),
  /** 实际注册成功的数量 */
  registered: z.number().int().min(0).max(200),
  failures: z
    .array(
      z.object({
        fenceId: z.string().max(80),
        /** 机器可读原因，如 missing_location_permission / location_disabled / register_failed: ... */
        reason: z.string().max(200),
      }),
    )
    .max(200)
    .optional(),
  /** 非致命问题，如 background_location_not_granted */
  warnings: z.array(z.string().max(120)).max(20).optional(),
  permission: z.object({ fine: z.boolean(), background: z.boolean() }).optional(),
  providersEnabled: z.boolean().optional(),
  lastBootRestore: z
    .object({
      registered: z.number().int().min(0).max(200),
      total: z.number().int().min(0).max(200),
      at: z.string().max(64),
    })
    .optional(),
  /** 同步过程整体失败（通道不可用/异常）时的原样错误 */
  error: z.string().max(300).optional(),
  /** 回执生成时刻（ISO） */
  at: z.string().max(64).optional(),
  /** 同步耗时（毫秒），用于诊断 ROM 卡顿 */
  durationMs: z.number().int().min(0).max(600_000).optional(),
});

export type GeofenceSyncReportWire = z.infer<typeof geofenceSyncReportSchema>;

export function parseGeofenceSyncReport(raw: unknown): GeofenceSyncReportWire | undefined {
  const parsed = geofenceSyncReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

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
