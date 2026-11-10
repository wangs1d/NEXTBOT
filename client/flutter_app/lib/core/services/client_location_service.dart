import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:flutter_timezone/flutter_timezone.dart";
import "package:geolocator/geolocator.dart";
import "package:http/http.dart" as http;
import "nb_http.dart";

import "../config/api_config.dart";

/// 前端 GPS 定位结果（随 chat.user_message 上报；服务端用经纬度逆地理，不用 IP）。
///
/// 2026-11-10 精确定位引擎：坐标本身不构成可信位置，必须携带精度元数据
/// （这个 fix 有多准、何时采的）服务端才能做质量裁决——与主流 App
/// （Android FusedLocationProvider 的 accuracy / iOS CLLocationManager 的
/// horizontalAccuracy）同一范式。
class ClientLocationPayload {
  const ClientLocationPayload({
    required this.latitude,
    required this.longitude,
    this.city,
    this.district,
    this.region,
    this.country,
    this.timezone,
    this.label,
    this.accuracyMeters,
    this.altitudeMeters,
    this.speedMps,
    this.headingDegrees,
    this.capturedAt,
  });

  final double latitude;
  final double longitude;
  final String? city;
  final String? district;
  final String? region;
  final String? country;
  final String? timezone;
  final String? label;
  /// 水平精度半径（米，68% 置信）；null=设备未提供
  final double? accuracyMeters;
  /// 海拔（米）
  final double? altitudeMeters;
  /// 瞬时速度（米/秒）
  final double? speedMps;
  /// 航向（度，0=正北顺时针）
  final double? headingDegrees;
  /// fix 采集时刻（UTC ISO）；null=设备未提供
  final String? capturedAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "latitude": latitude,
        "longitude": longitude,
        if (city != null && city!.isNotEmpty) "city": city,
        if (district != null && district!.isNotEmpty) "district": district,
        if (region != null && region!.isNotEmpty) "region": region,
        if (country != null && country!.isNotEmpty) "country": country,
        if (timezone != null && timezone!.isNotEmpty) "timezone": timezone,
        if (label != null && label!.isNotEmpty) "label": label,
        if (accuracyMeters != null) "accuracyMeters": accuracyMeters,
        if (altitudeMeters != null) "altitudeMeters": altitudeMeters,
        if (speedMps != null) "speedMps": speedMps,
        if (headingDegrees != null) "headingDegrees": headingDegrees,
        if (capturedAt != null && capturedAt!.isNotEmpty) "capturedAt": capturedAt,
      };

  factory ClientLocationPayload.fromJson(Map<String, dynamic> json) {
    return ClientLocationPayload(
      latitude: (json["latitude"] as num).toDouble(),
      longitude: (json["longitude"] as num).toDouble(),
      city: json["city"] as String?,
      district: json["district"] as String?,
      region: json["region"] as String?,
      country: json["country"] as String?,
      timezone: json["timezone"] as String?,
      label: json["label"] as String?,
      accuracyMeters: (json["accuracyMeters"] as num?)?.toDouble(),
      altitudeMeters: (json["altitudeMeters"] as num?)?.toDouble(),
      speedMps: (json["speedMps"] as num?)?.toDouble(),
      headingDegrees: (json["headingDegrees"] as num?)?.toDouble(),
      capturedAt: json["capturedAt"] as String?,
    );
  }
}

typedef LocationPrefsReader = Future<dynamic> Function(String key);
typedef LocationPrefsWriter = Future<void> Function(String key, dynamic value);

class ClientLocationService {
  ClientLocationService._();

  static const String _prefsKey = "clientLocationCache";
  static const String _consentKey = "clientLocationConsent";
  static const String _residentKey = "clientLocationResident";
  static ClientLocationPayload? _cached;
  static DateTime? _cachedAt;
  /// 仅供 App 启动预热使用；聊天发消息走 `getCurrentLocationForChat()` 实时拉取。
  static const Duration _cacheTtl = Duration(minutes: 10);

  static LocationPrefsReader? _readPref;
  static LocationPrefsWriter? _writePref;
  /// `null` 尚未询问；`true`/`false` 用户已选择。
  /// 默认 `true`：让 Agent 实时拿到用户位置；用户可在权限弹窗里显式「暂不允许」回退。
  static bool? _locationConsent = true;
  /// 常驻定位开关（用户显式开启；开启后走「始终允许」权限 + 位移触发的后台上报）。
  static bool? _residentEnabled;
  /// 常驻定位流订阅（Android 走前台服务保活；iOS 依赖 Always 授权的 Significant-change）。
  static StreamSubscription<Position>? _residentSub;

  /// 注入本地持久化（如 IsarLocalHistoryStore.savePreference）。
  static void bindPreferences({
    required LocationPrefsReader read,
    required LocationPrefsWriter write,
  }) {
    _readPref = read;
    _writePref = write;
  }

  static Future<bool?> getLocationConsent() async {
    if (_locationConsent != null) return _locationConsent;
    if (_readPref == null) return true;
    final dynamic raw = await _readPref!(_consentKey);
    if (raw == null) return true;
    _locationConsent = raw == true;
    return _locationConsent;
  }

  static Future<void> setLocationConsent(bool allowed) async {
    _locationConsent = allowed;
    if (_writePref != null) {
      await _writePref!(_consentKey, allowed);
    }
    if (!allowed) {
      clearCache();
      // 撤回定位同意 = 连常驻一起停（权限都没了，流留着只报错）
      await setResidentLocationEnabled(false);
    }
  }

  // ─── 常驻定位（始终允许 + 位移触发上报） ───────────────────────────

  /// 常驻开关（持久化）。`null` 从未设置；开启需用户显式选择。
  static Future<bool> getResidentLocationEnabled() async {
    if (_residentEnabled != null) return _residentEnabled!;
    if (_readPref == null) return false;
    final dynamic raw = await _readPref!(_residentKey);
    _residentEnabled = raw == true;
    return _residentEnabled!;
  }

  static Future<void> setResidentLocationEnabled(bool enabled) async {
    _residentEnabled = enabled;
    if (_writePref != null) {
      await _writePref!(_residentKey, enabled);
    }
    if (!enabled) {
      await stopResidentTracking();
    }
  }

  /// 升级到「始终允许」：iOS 在已授 WhileUsing 后再调 requestPermission 会弹
  /// Always 升级框；Android 10+ 的二级弹窗含「始终允许」，11+ 可能落在系统设置，
  /// 此时打开本应用的定位设置页引导。返回最终拿到的权限档位。
  static Future<LocationPermission> ensureAlwaysPermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationPermission.denied;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.whileInUse) {
      permission = await Geolocator.requestPermission();
      // Android 11+ 二级弹窗可能只给「仅本次」：仍差一级时引导去系统设置
      if (permission == LocationPermission.whileInUse) {
        await Geolocator.openLocationSettings();
        permission = await Geolocator.checkPermission();
      }
    }
    return permission;
  }

  static bool get isResidentTrackingActive => _residentSub != null;

  /// 启动常驻定位流（位移 ≥ [distanceFilterMeters] 米才产一次 fix，不动不报——
  /// 不是 GPS 轮询，省电）。Android 走前台服务常驻（通知栏可见、可随时关）；
  /// iOS 依赖 Always 授权 + 系统对位移事件的唤醒。
  /// 返回 false 表示前置条件不满足（未开开关 / 定位同意撤回 / 权限不够），未启动。
  static Future<bool> startResidentTracking({
    required void Function(ClientLocationPayload payload) onFix,
    int distanceFilterMeters = 150,
  }) async {
    if (isResidentTrackingActive) return true;
    final bool consent = await getLocationConsent() == true;
    final bool enabled = await getResidentLocationEnabled();
    if (!consent || !enabled) return false;
    final LocationPermission permission = await ensureAlwaysPermission();
    if (permission != LocationPermission.always) {
      debugPrint(
        "[ClientLocationService] 常驻定位需要「始终允许」权限，当前: $permission（暂不启动，等下次引导）",
      );
      return false;
    }
    try {
      LocationSettings settings;
      if (defaultTargetPlatform == TargetPlatform.android) {
        settings = AndroidSettings(
          accuracy: LocationAccuracy.medium,
          distanceFilter: distanceFilterMeters,
          foregroundNotificationConfig: const ForegroundNotificationConfig(
            notificationTitle: "NEXTBOT 位置服务",
            notificationText: "让 Agent 在你位置变化时知道（可在系统设置关闭）",
            notificationChannelName: "resident_location",
            setOngoing: true,
            enableWakeLock: true,
          ),
        );
      } else {
        settings = LocationSettings(
          accuracy: LocationAccuracy.medium,
          distanceFilter: distanceFilterMeters,
        );
      }
      _residentSub = Geolocator.getPositionStream(locationSettings: settings)
          .listen((Position position) async {
        // 常驻流同样带全量精度元数据（服务端据此区分可信/降级 fix）
        final ClientLocationPayload payload = await _payloadFrom(position);
        await _remember(payload);
        onFix(payload);
      }, onError: (Object e) {
        debugPrint("[ClientLocationService] 常驻定位流出错: $e");
      });
      debugPrint("[ClientLocationService] 常驻定位已启动（位移阈值 ${distanceFilterMeters}m）");
      return true;
    } catch (e) {
      debugPrint("[ClientLocationService] 常驻定位启动失败: $e");
      return false;
    }
  }

  static Future<void> stopResidentTracking() async {
    await _residentSub?.cancel();
    _residentSub = null;
  }

  /// 获取实时位置（右侧天气面板/启动预热路径）。
  /// GPS 优先：内存缓存未过期（10 分钟内）直接复用，过期则重新拉真实定位，
  /// 磁盘缓存仅作失败兜底——不再因为持久化缓存「看似新鲜」而长期停留在旧坐标
  /// （曾导致天气面板固定在旧位置，如一直显示上海的天气）。
  static Future<ClientLocationPayload?> getCurrentLocation() async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      if (consent != true) {
        return _cached ?? await _loadFromDisk();
      }
    }
    final DateTime now = DateTime.now();
    if (_cached != null &&
        _cachedAt != null &&
        now.difference(_cachedAt!) < _cacheTtl) {
      return _cached;
    }

    // 内存缓存已过期/缺失：从磁盘取缓存作兜底，然后强制拉一次新鲜 GPS。
    final ClientLocationPayload? disk = await _loadFromDisk();
    return _fetchFresh(disk);
  }

  /// 聊天发消息专用：每次都拉新 GPS，确保 Agent 拿到的是用户当下位置。
  /// 失败时回退到磁盘/内存缓存；不阻塞消息发送。
  static Future<ClientLocationPayload?> getCurrentLocationForChat() async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      if (consent != true) {
        return _cached ?? await _loadFromDisk();
      }
    }
    final ClientLocationPayload? disk = await _loadFromDisk();
    return _fetchFresh(disk);
  }

  /// 服务端 `agent.location_request` 专用：纯坐标快回，不做客户端逆地理
  /// （服务端拿到坐标后自己反查城市）。
  ///
  /// 快速窗口契约：服务端 requestLocation 只等 12s，本方法任何分支总时长
  /// 封顶 8s——GPS 直接走 medium 单次尝试（high 冷启动在无 GPS 硬件的桌面
  /// 上必挂满 timeLimit 才轮到下一个，是按需定位超时的根源），外层再兜一层
  /// 总超时。拿不到就返回 null，由服务端落「最近已知位置」兜底（带龄期）；
  /// 绝不拿磁盘旧缓存冒充实时坐标——那会把无龄期的旧坐标写进服务端缓存。
  static Future<ClientLocationPayload?> getCurrentLocationForAgentReply() async {
    try {
      return await _fetchAgentReplyCoords()
          .timeout(const Duration(seconds: 8));
    } catch (e) {
      debugPrint("[ClientLocationService] 按需定位未取到坐标（回 null 交服务端兜底）: $e");
      return null;
    }
  }

  static Future<ClientLocationPayload?> _fetchAgentReplyCoords() async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      if (consent != true) return null;
    }
    final LocationPermission permission = await _ensurePermission();
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      debugPrint("[ClientLocationService] 定位权限未授予，按需回包回 null");
      return null;
    }
    // 快速窗口契约：服务端只等 12s，本方法外层封顶 8s。引擎预算 6s：
    // last-known 快路毫秒级；高精度流拿到 ≤150m 的 fix 即刻返回，预算耗尽
    // 给最佳 fix；GPS 零 fix 时降级中精度 4s（在 6s 预算内）。
    final Position? position = await _fetchPrecisePosition(
      budget: const Duration(seconds: 6),
      maxAccuracyMeters: 150,
    );
    if (position == null) return null;
    return _payloadFrom(position);
  }

  /// 读取设备真实 IANA 时区（如 America/New_York）；失败返回 null（不上报，交服务端判定）。
  static Future<String?> _deviceTimezone() async {
    try {
      final TimezoneInfo tzInfo = await FlutterTimezone.getLocalTimezone();
      final String tz = tzInfo.identifier;
      if (tz.trim().isNotEmpty) return tz.trim();
    } catch (e) {
      debugPrint("[ClientLocationService] 获取设备时区失败: $e");
    }
    return null;
  }

  // ─── 精确定位引擎（2026-11-10）──────────────────────────────────────
  //
  // 主流范式（Android FusedLocationProviderClient.getCurrentLocation 的
  // maxUpdateAgeMillis/accuracy + iOS CLLocationManager requestLocation）：
  //   1. 快路：系统 last-known fix 足够新且足够准 → 毫秒级直接采用。
  //   2. 精路：开高精度定位流，拿到第一个满足精度门槛的 fix 立即返回；
  //      预算耗尽仍未达标则返回其中精度最好的一个（带真实精度元数据）。
  //   3. 降级：高精度流一个 fix 都没有（室内/搜星慢/无 GPS 硬件）才退
  //      中精度（WiFi/基站）再给一小段预算。
  //
  // 与旧实现的本质区别：不再「high 挂满超时→退 medium→无脑采纳第一个
  // fix」，而是带精度门槛的择优；低精度 fix 永远以 accuracyMeters 如实
  // 上报，服务端可据此裁决。

  /// last-known fix 的最大可信龄期：超过它宁可重新定位。
  static const Duration _lastKnownMaxAge = Duration(seconds: 45);

  static Future<Position?> _fetchPrecisePosition({
    required Duration budget,
    required double maxAccuracyMeters,
  }) async {
    // 快路：last-known 足够新且达标 → 毫秒级返回。
    try {
      final Position? last = await Geolocator.getLastKnownPosition();
      if (last != null) {
        final Duration age = DateTime.now().difference(last.timestamp);
        if (age >= Duration.zero &&
            age <= _lastKnownMaxAge &&
            last.accuracy > 0 &&
            last.accuracy <= maxAccuracyMeters) {
          return last;
        }
      }
    } catch (e) {
      debugPrint("[ClientLocationService] last-known 读取失败（忽略，走精路）: $e");
    }

    // 精路：高精度流，预算内择优。
    final Position? best = await _collectBestFix(
      accuracy: LocationAccuracy.high,
      budget: budget,
      maxAccuracyMeters: maxAccuracyMeters,
    );
    if (best != null) return best;

    // 降级：高精度零 fix（室内/无 GPS 硬件的桌面）→ 中精度短预算。
    return _collectBestFix(
      accuracy: LocationAccuracy.medium,
      budget: const Duration(seconds: 4),
      maxAccuracyMeters: maxAccuracyMeters,
    );
  }

  /// 开一段定位流：返回第一个达标 fix；预算耗尽仍未达标则返回最佳者。
  static Future<Position?> _collectBestFix({
    required LocationAccuracy accuracy,
    required Duration budget,
    required double maxAccuracyMeters,
  }) async {
    Position? best;
    try {
      final Stream<Position> stream = Geolocator.getPositionStream(
        locationSettings: LocationSettings(
          accuracy: accuracy,
          distanceFilter: 0,
        ),
      ).timeout(budget, onTimeout: (EventSink<Position> sink) {
        sink.close();
      });
      await for (final Position position in stream) {
        // 模拟器/异常源可能报 (0,0)，直接丢弃
        if (position.latitude == 0 && position.longitude == 0) continue;
        if (best == null || position.accuracy < best.accuracy) {
          best = position;
        }
        if (position.accuracy > 0 && position.accuracy <= maxAccuracyMeters) {
          return position;
        }
      }
    } catch (e) {
      debugPrint("[ClientLocationService] ${accuracy.name} 定位流结束: $e");
    }
    return best;
  }

  /// Position → 带完整精度元数据的 payload。
  static Future<ClientLocationPayload> _payloadFrom(Position position) async {
    final double? heading =
        (position.heading >= 0 && !position.heading.isNaN) ? position.heading : null;
    return ClientLocationPayload(
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyMeters: position.accuracy > 0 ? position.accuracy : null,
      altitudeMeters: position.altitude,
      speedMps: position.speed >= 0 ? position.speed : null,
      headingDegrees: heading,
      capturedAt: position.timestamp.toUtc().toIso8601String(),
      timezone: await _deviceTimezone(),
      label:
          "${position.latitude.toStringAsFixed(4)}, ${position.longitude.toStringAsFixed(4)}",
    );
  }

  /// 实际执行一次精确定位 + 逆地理；任何异常都返回磁盘/内存兜底。
  static Future<ClientLocationPayload?> _fetchFresh(
    ClientLocationPayload? disk,
  ) async {
    try {
      final LocationPermission permission = await _ensurePermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        debugPrint("[ClientLocationService] 定位权限未授予，使用上次缓存");
        return disk ?? _cached;
      }

      final Position? position = await _fetchPrecisePosition(
        budget: const Duration(seconds: 7),
        maxAccuracyMeters: 100,
      );
      if (position == null) {
        debugPrint("[ClientLocationService] 预算内未取到任何 fix，回缓存兜底");
        return _cached ?? disk;
      }

      final ClientLocationPayload coordsPayload = await _payloadFrom(position);
      final ClientLocationPayload? resolved =
          await _reverseGeocodeViaServer(coordsPayload.latitude, coordsPayload.longitude);
      // 逆地理只补城市文本与时区（定位→当地时区的主路）；精度元数据原样保留
      final ClientLocationPayload merged = resolved == null
          ? coordsPayload
          : ClientLocationPayload(
              latitude: coordsPayload.latitude,
              longitude: coordsPayload.longitude,
              city: resolved.city,
              district: resolved.district,
              region: resolved.region,
              country: resolved.country,
              timezone: resolved.timezone ?? coordsPayload.timezone,
              label: resolved.label ?? coordsPayload.label,
              accuracyMeters: coordsPayload.accuracyMeters,
              altitudeMeters: coordsPayload.altitudeMeters,
              speedMps: coordsPayload.speedMps,
              headingDegrees: coordsPayload.headingDegrees,
              capturedAt: coordsPayload.capturedAt,
            );
      await _remember(merged);
      return merged;
    } catch (e) {
      debugPrint("[ClientLocationService] 获取定位失败: $e");
      return _cached ?? disk;
    }
  }

  /// 用户同意定位后预拉 GPS；未同意时不请求系统权限。
  static Future<void> warmUpGpsIfConsented() async {
    final bool? consent = await getLocationConsent();
    if (consent == true) {
      await getCurrentLocation();
    }
  }

  static void clearCache() {
    _cached = null;
    _cachedAt = null;
  }

  static Future<ClientLocationPayload?> _reverseGeocodeViaServer(
    double lat,
    double lon,
  ) async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/reverse").replace(
      queryParameters: <String, String>{
        "latitude": lat.toString(),
        "longitude": lon.toString(),
      },
    );
    final http.Response res = await NbHttp.get(uri, headers: const <String, String>{"Accept": "application/json"})
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) {
      debugPrint("[ClientLocationService] 逆地理失败 HTTP ${res.statusCode}");
      return null;
    }
    final Map<String, dynamic> body =
        jsonDecode(res.body) as Map<String, dynamic>;
    if (body["ok"] != true) return null;
    final Map<String, dynamic>? loc =
        (body["location"] as Map?)?.cast<String, dynamic>();
    if (loc == null) return null;

    return ClientLocationPayload(
      latitude: lat,
      longitude: lon,
      city: loc["city"] as String?,
      district: loc["district"] as String?,
      region: loc["region"] as String?,
      country: loc["country"] as String?,
      timezone: loc["timezone"] as String?,
      label: loc["label"] as String?,
    );
  }

  static Future<void> _remember(ClientLocationPayload payload) async {
    _cached = payload;
    _cachedAt = DateTime.now();
    debugPrint("[ClientLocationService] 定位: ${payload.label ?? payload.city}");
    if (_writePref != null) {
      // 持久化真实定位时间戳，供下次启动判断缓存是否过期（不再重置为"现在"）。
      await _writePref!(
        _prefsKey,
        <String, dynamic>{
          "cachedAt": _cachedAt!.toIso8601String(),
          "location": payload.toJson(),
        },
      );
    }
  }

  static Future<ClientLocationPayload?> _loadFromDisk() async {
    if (_readPref == null) return null;
    try {
      final dynamic raw = await _readPref!(_prefsKey);
      // 新格式：{ cachedAt, location } —— 恢复真实时间戳，过期判断才有意义。
      if (raw is Map && raw["location"] is Map) {
        final Map<String, dynamic> loc =
            (raw["location"] as Map).cast<String, dynamic>();
        final ClientLocationPayload payload =
            ClientLocationPayload.fromJson(loc);
        final DateTime? cachedAt =
            DateTime.tryParse(raw["cachedAt"]?.toString() ?? "");
        _cached = payload;
        _cachedAt = cachedAt;
        return payload;
      }
      // 旧格式：直接是 payload（无时间戳）——视为过期，强制下次重新拉真实 GPS。
      if (raw is Map) {
        final ClientLocationPayload payload =
            ClientLocationPayload.fromJson(raw.cast<String, dynamic>());
        _cached = payload;
        _cachedAt = null;
        return payload;
      }
    } catch (e) {
      debugPrint("[ClientLocationService] 读取缓存失败: $e");
    }
    return null;
  }

  static Future<LocationPermission> _ensurePermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationPermission.denied;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission;
  }

  /// 在用户于弹窗中选择「开启定位」后调用。
  static Future<void> requestGpsAfterConsent() async {
    await setLocationConsent(true);
    await getCurrentLocation();
  }
}
