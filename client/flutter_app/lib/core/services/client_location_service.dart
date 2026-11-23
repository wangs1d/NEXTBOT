import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart" show MethodChannel, MissingPluginException, PlatformException;
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

  // ─── 高德定位（2026-11-18）─────────────────────────────────────────
  // Android 端接 AMapLocationClient 做「GPS + WiFi + 基站 + 传感器」融合定位，
  // 精度档位 Hight_Accuracy + GpsFirst，是设备硬件的上限；geolocator 保留为
  // 回退（未配 key / 非 Android / SDK 初始化失败时静默降级）。
  // 坐标系：高德返回 GCJ-02，原生层已转回 WGS-84，与服务端「WGS→GCJ 再逆地理」
  // 的口径一致，避免二次偏移。
  static const MethodChannel _amapChannel =
      MethodChannel("private_ai_agent/amap_location");
  /// 与 KeepAlivePlugin 共用桥：原生「始终允许」定位设置页深链。
  static const MethodChannel _keepAliveChannel = MethodChannel("nextbot/keep_alive");
  /// 一旦确定不可用（无 key / 插件缺失）就本进程内不再尝试，避免每次定位都付一次失败开销。
  static bool _amapUsable = true;
  /// `null` 尚未选择；`true`/`false` 用户已选择。
  ///
  /// 手机端首次保持 `null`（而不是默认 `true`），否则 [getLocationConsent] 永远
  /// 非空、启动弹窗被跳过——「始终允许（后台持续）」就永远没有入口。桌面端没有
  /// 「始终允许」这个概念，沿用默认同意。
  static bool? _locationConsent;
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

  /// 手机端需要用户显式选择定位同意（弹窗里有「始终允许」）；桌面端没有该概念。
  static bool get _needsExplicitConsent =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  static Future<bool?> getLocationConsent() async {
    if (_locationConsent != null) return _locationConsent;
    if (_readPref == null) return _needsExplicitConsent ? null : true;
    final dynamic raw = await _readPref!(_consentKey);
    if (raw == null) return _needsExplicitConsent ? null : true;
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
  /// Always 升级框；Android 10+ 的二级弹窗含「始终允许」，11+ 的弹窗里已经没有
  /// 这个选项，必须打开**本应用的权限设置页**（设置 → 应用 → 权限 → 位置 →
  /// 「允许所有时间」）手动选。注意不能用 openLocationSettings——那是设备的
  /// 定位总开关页，上面根本没有「始终允许」。返回最终拿到的权限档位。
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
      // 仍只到「使用期间」：Android 11+ 只能去应用权限页选「允许所有时间」。
      if (permission == LocationPermission.whileInUse) {
        await Geolocator.openAppSettings();
        permission = await Geolocator.checkPermission();
      }
    }
    return permission;
  }

  /// 手机端进主壳首次询问：直接请求系统定位权限（使用期间），不再经应用内
  /// 卡片弹窗（2026-11-19 删除）。返回 true/false = 系统对本次请求给出的真实
  /// 答复；返回 null = 本次没能问到（定位服务未开 / 请求未受理 / 插件异常），
  /// 调用方不得把它记成用户拒绝。
  static Future<bool?> requestSystemLocationPermission() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return null;
      }
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.whileInUse ||
          permission == LocationPermission.always) {
        return true;
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return false;
      }
      // undetermined / restricted / disabled：弹窗没起来，不算用户否决
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 引导用户开启「始终允许」（2026-11-20）：Android 12+ 原生深链直达本应用的
  /// 「位置权限」单页（那一页里就有「允许所有时间」，比应用详情页少点 3 层）；
  /// Android 10-11 原生回退应用详情页。返回 false = 深链不可用（低版本/异常），
  /// 调用方兜底 [ensureAlwaysPermission]（API ≤30 的二级弹窗里有「始终允许」，
  /// iOS 走系统的 Always 升级框）。最终授权必须用户手动确认，无程序化通道。
  static Future<bool> openAlwaysLocationSettings() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return false;
    try {
      return await _keepAliveChannel
              .invokeMethod<bool>("openAlwaysLocationSettings") ??
          false;
    } on Exception {
      return false;
    }
  }

  static bool get isResidentTrackingActive => _residentSub != null;

  /// 最近一次 fix（常驻流/按需定位都会刷新）：后台心跳用它回传「仍在原处」。
  static ClientLocationPayload? get lastKnownPayload => _cached;

  /// 最近一次 fix 的本地记录时刻（后台心跳的新鲜度门槛）。
  static DateTime? get lastKnownRecordedAt => _cachedAt;

  /// 是否已拿到「始终允许」——纯检查，不触发任何权限弹窗（后台路径用）。
  static Future<bool> hasAlwaysPermission() async {
    try {
      return await Geolocator.checkPermission() == LocationPermission.always;
    } catch (_) {
      return false;
    }
  }

  /// 服务端 continuous 驱动：绕过用户本地常驻开关（服务端已显式要求持续定位），
  /// 但仍然要求定位同意 + 「始终允许」权限；高精度、位移阈值 50m。
  static Future<bool> startServerContinuousTracking({
    required void Function(ClientLocationPayload payload) onFix,
  }) {
    return startResidentTracking(
      onFix: onFix,
      distanceFilterMeters: 50,
      accuracy: LocationAccuracy.high,
      ignoreUserToggle: true,
    );
  }

  /// 启动常驻定位流（位移 ≥ [distanceFilterMeters] 米才产一次 fix，不动不报——
  /// 不是 GPS 轮询，省电）。Android 走前台服务常驻（通知栏可见、可随时关）；
  /// iOS 依赖 Always 授权 + 系统对位移事件的唤醒。
  /// 返回 false 表示前置条件不满足（未开开关 / 定位同意撤回 / 权限不够），未启动。
  static Future<bool> startResidentTracking({
    required void Function(ClientLocationPayload payload) onFix,
    int distanceFilterMeters = 150,
    LocationAccuracy accuracy = LocationAccuracy.medium,
    bool ignoreUserToggle = false,
  }) async {
    if (isResidentTrackingActive) return true;
    final bool consent = await getLocationConsent() == true;
    if (!consent) return false;
    if (!ignoreUserToggle && !await getResidentLocationEnabled()) return false;
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
          accuracy: accuracy,
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
          accuracy: accuracy,
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

  // ─── 每轮位置钩子（服务端 reason=turn:*，2026-11-22）─────────────────
  //
  // 服务端每轮 prompt 装配前会要一次「此刻位置」。2026-11-22 定调**精度优先**：
  // 缓存只有在「够新 + 够准」时才复用，否则现拉一次高精度 fix（高德
  // Hight_Accuracy + GpsFirst，目标 ≤10m），拿不到才退回最近一次缓存——
  // 旧坐标如实带 capturedAt / accuracyMeters，绝不伪装成精准定位。
  //
  // 为什么不无脑复用：后台连续流（continuous）的 fix 常态 30~60m，密集街区
  // 会跨街/错门牌；「位置每轮更新」不等于「位置足够准」。
  /// 缓存可复用的最大龄期：3min → 60s（准确优先）。1 分钟内的 fix 才敢当
  /// 「此刻」用；走动 1.4m/s 时 3 分钟已偏 250m，门牌必错。
  static const Duration _turnFastFixMaxAge = Duration(seconds: 60);
  /// 复用缓存要求的水平精度（米）：与服务端 LOCATION_TURN_MAX_ACCURACY_M 对齐（15）。
  static const double _turnPreciseMaxAccuracyMeters = 15;
  /// 移动中不复用缓存（走路/骑行/开车）：坐标在变，缓存再准也是「上一处」。
  static const double _turnMovingSpeedMps = 1.2;
  /// 每轮现拉预算：服务端等 2.6s，这里给 2.4s——**端侧必须先于服务端收口**，
  /// 否则回包永远晚到一轮。两个引擎并行且 ≤15m 即回，通常 0.8~1.8s 收口，
  /// 2.4s 只兜「GPS 需要多几个 fix 收敛」的情况。
  static const Duration _turnFetchBudget = Duration(milliseconds: 2400);
  /// 后台预热预算（本轮没拿到达标精度时用，不影响本轮响应）。
  static const Duration _warmBudget = Duration(milliseconds: 6000);
  static DateTime? _lastWarmAt;

  /// 每轮对话位置钩子专用（纯坐标，不做客户端逆地理）。
  static Future<ClientLocationPayload?> getCurrentLocationForTurn() async {
    final bool? consent = await getLocationConsent();
    // 用户显式拒绝过定位：不回任何坐标（系统权限兜底在下面的定位调用里）。
    if (consent == false) return null;

    final ClientLocationPayload? cached = _cached;
    final DateTime? cachedAt = _cachedAt;
    final double? cachedSpeed = cached?.speedMps;
    final bool moving = cachedSpeed != null && cachedSpeed > _turnMovingSpeedMps;
    if (cached != null &&
        cachedAt != null &&
        !moving &&
        DateTime.now().difference(cachedAt) <= _turnFastFixMaxAge &&
        _accuracyUnknownOrWithin(cached.accuracyMeters, _turnPreciseMaxAccuracyMeters)) {
      return cached;
    }

    try {
      final ClientLocationPayload? precise = await _fetchPreciseCoords(
        budget: _turnFetchBudget,
      );
      if (precise != null) return precise;
    } catch (e) {
      debugPrint("[ClientLocationService] 每轮高精度定位未取到（回最近一次）: $e");
    }
    final ClientLocationPayload? fallback = cached ?? await _loadFromDisk();
    // 本轮只拿到粗 fix / 旧缓存：后台继续追一次高精度（节流 20s，只更新本地缓存），
    // 下一轮服务端要位置时就是「秒回且达标」，不用再等 GPS。
    if (!_accuracyUnknownOrWithin(fallback?.accuracyMeters, _turnPreciseMaxAccuracyMeters)) {
      _warmTurnCache();
    }
    return fallback;
  }

  /// 精度未知（旧通道/旧设备未上报）视为「无法判断 → 允许复用」：
  /// 不能因为拿不到数字就每轮白等一次 GPS。
  static bool _accuracyUnknownOrWithin(double? accuracyMeters, double limitMeters) {
    if (accuracyMeters == null || accuracyMeters <= 0) return true;
    return accuracyMeters <= limitMeters;
  }

  /// 后台预热：本轮响应已经发出，这里只为下一轮把「精度达标的新鲜 fix」准备好。
  /// 失败/超时都静默（预热是优化，不是功能），20s 内不重复触发。
  static void _warmTurnCache() {
    final DateTime now = DateTime.now();
    final DateTime? last = _lastWarmAt;
    if (last != null && now.difference(last) < const Duration(seconds: 20)) return;
    _lastWarmAt = now;
    unawaited(
      _fetchPreciseCoords(budget: _warmBudget).then<void>((ClientLocationPayload? p) async {
        if (p == null) return;
        await _remember(p);
      }).catchError((Object e) {
        debugPrint("[ClientLocationService] 后台预热定位失败（忽略）: $e");
      }),
    );
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
      // 服务端 requestLocation 等 12s：端侧收口略早于服务端（11s），
      // 给室内/冷启动 GPS 留更多收敛时间，减少「预选位置出不来」。
      return await _fetchAgentReplyCoords()
          .timeout(const Duration(seconds: 11));
    } catch (e) {
      debugPrint("[ClientLocationService] 按需定位未取到坐标（回 null 交服务端兜底）: $e");
      return null;
    }
  }

  static Future<ClientLocationPayload?> _fetchAgentReplyCoords() {
    // 工具按需路径（服务端等 12s）：给足 10s，高德 + geolocator 并行共享预算。
    return _fetchPreciseCoords(budget: const Duration(milliseconds: 10000));
  }

  /// 高精度取点（高德 ⇄ geolocator **并行赛跑**，达标即回）。
  ///
  /// 2026-11-22 二改（提速）：原来「高德先跑满预算 → 不够准再给 geolocator
  /// 剩余时间」，串行最坏要 4s+；现在两个引擎同时开跑，任何一个先给出
  /// ≤ acceptAccuracyMeters（缺省 15m，与服务端精度门槛一致）的 fix 就立刻返回，
  /// 都只有粗 fix 才等到预算耗尽取两者里最好的。这样常见场景 0.8~2s 出结果，
  /// 精度门槛不降（仍是服务端 15m 判据）。
  static Future<ClientLocationPayload?> _fetchPreciseCoords({
    required Duration budget,
    double targetAccuracyMeters = 10,
    double acceptAccuracyMeters = 15,
  }) async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      // 2026-11-19 根修（「开了系统权限还说看不见」）：只有**显式拒绝**（false）
      // 才在这里拦截。consent == null（从未在 App 内弹窗选择）不再直接掐死——
      // 用户在系统设置里授予了定位权限本身就是意图表达，放行交给下面的
      // 系统权限检查裁定：权限在就正常定位，不在照样回 null。
      if (consent == false) return null;
    }
    final LocationPermission permission = await _ensurePermission();
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      debugPrint("[ClientLocationService] 定位权限未授予，按需回包回 null");
      return null;
    }

    final Completer<ClientLocationPayload?> completer =
        Completer<ClientLocationPayload?>();
    ClientLocationPayload? best;
    double bestAccuracy = double.infinity;
    int pending = 2;

    void consider(ClientLocationPayload? payload) {
      if (payload != null) {
        final double raw = payload.accuracyMeters ?? 0;
        // 精度未知按「达标」处理（旧设备/旧通道不给数字时不能空等）。
        final double acc = raw > 0 ? raw : 0;
        if (acc < bestAccuracy) {
          bestAccuracy = acc;
          best = payload;
        }
        if (acc <= acceptAccuracyMeters && !completer.isCompleted) {
          completer.complete(best);
          return;
        }
      }
      pending -= 1;
      if (pending <= 0 && !completer.isCompleted) completer.complete(best);
    }

    unawaited(
      _amapFix(timeout: budget, maxAccuracyMeters: targetAccuracyMeters)
          .then(consider)
          .catchError((Object e) {
        debugPrint("[ClientLocationService] 高德分支异常: $e");
        consider(null);
        return null;
      }),
    );
    unawaited(
      _fetchPrecisePosition(
        budget: budget,
        maxAccuracyMeters: targetAccuracyMeters,
      ).then((Position? p) async {
        consider(p == null ? null : await _payloadFrom(p));
      }).catchError((Object e) {
        debugPrint("[ClientLocationService] geolocator 分支异常: $e");
        consider(null);
        return null;
      }),
    );

    // 两个引擎各自带预算，这里再兜一层（防某个通道卡住不回调）。
    return completer.future.timeout(
      budget + const Duration(milliseconds: 400),
      onTimeout: () => best,
    );
  }

  static bool _isAccurateEnough(double? accuracyMeters, double maxAccuracyMeters) {
    return accuracyMeters != null &&
        accuracyMeters > 0 &&
        accuracyMeters <= maxAccuracyMeters;
  }

  /// 高德单次高精度取点（Android 原生 AMapLocationClient，Hight_Accuracy + GpsFirst）。
  /// 未配 key / 非 Android / SDK 异常时返回 null，由 geolocator 回退，不阻塞主链路。
  static Future<ClientLocationPayload?> _amapFix({
    required Duration timeout,
    required double maxAccuracyMeters,
  }) async {
    if (!_amapUsable || defaultTargetPlatform != TargetPlatform.android) return null;
    try {
      final Map<dynamic, dynamic>? raw =
          await _amapChannel.invokeMethod<Map<dynamic, dynamic>>(
        "getCurrentLocation",
        <String, dynamic>{
          "timeoutMs": timeout.inMilliseconds,
          "maxAccuracyMeters": maxAccuracyMeters,
        },
      ).timeout(timeout + const Duration(seconds: 2));
      if (raw == null) return null;
      final double lat = (raw["latitude"] as num?)?.toDouble() ?? 0;
      final double lon = (raw["longitude"] as num?)?.toDouble() ?? 0;
      if (lat == 0 && lon == 0) return null;
      final int? capturedAtMs = (raw["capturedAtMs"] as num?)?.toInt();
      return ClientLocationPayload(
        latitude: lat,
        longitude: lon,
        accuracyMeters: (raw["accuracyMeters"] as num?)?.toDouble(),
        altitudeMeters: (raw["altitudeMeters"] as num?)?.toDouble(),
        speedMps: (raw["speedMps"] as num?)?.toDouble(),
        headingDegrees: (raw["headingDegrees"] as num?)?.toDouble(),
        capturedAt: capturedAtMs != null
            ? DateTime.fromMillisecondsSinceEpoch(capturedAtMs, isUtc: true)
                .toIso8601String()
            : null,
        timezone: await _deviceTimezone(),
        label: "${lat.toStringAsFixed(6)}, ${lon.toStringAsFixed(6)}",
      );
    } on MissingPluginException {
      _amapUsable = false;
      return null;
    } on PlatformException catch (e) {
      // 无 key / 初始化失败属确定性不可用：本进程内不再重试（避免每次定位多付一次失败开销）；
      // 超时类错误保留重试，下次可能拿到 fix。
      if (e.code == "amap_key_missing" ||
          e.code == "amap_init_failed" ||
          e.code == "amap_start_failed") {
        _amapUsable = false;
      }
      debugPrint("[ClientLocationService] 高德定位不可用: ${e.code} ${e.message}");
      return null;
    } catch (e) {
      debugPrint("[ClientLocationService] 高德定位异常: $e");
      return null;
    }
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
  /// 45s → 20s（准确优先）：40s 前的 fix 哪怕精度 8m，人可能已走 50m。
  static const Duration _lastKnownMaxAge = Duration(seconds: 20);

  static Future<Position?> _fetchPrecisePosition({
    required Duration budget,
    required double maxAccuracyMeters,
  }) async {
    // 总预算 deadline：高精度流用满预算后，降级的中精度流只能用**剩余时间**。
    // 旧实现固定再给 4s，实际总耗时 10s+，外层 8s 超时会把整次定位直接判死。
    final DateTime deadline = DateTime.now().add(budget);

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

    // 降级：高精度零 fix（室内/无 GPS 硬件的桌面）→ 剩余预算内的中精度。
    final Duration remaining = deadline.difference(DateTime.now());
    if (remaining < const Duration(milliseconds: 500)) return null;
    final Duration mediumBudget = remaining < const Duration(seconds: 4)
        ? remaining
        : const Duration(seconds: 4);
    return _collectBestFix(
      accuracy: LocationAccuracy.medium,
      budget: mediumBudget,
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
          "${position.latitude.toStringAsFixed(6)}, ${position.longitude.toStringAsFixed(6)}",
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

      // 精度门槛（2026-11-18）：50m → 10m，与聊天按需路径统一。50m 的 fix
      // 做逆地理会落到隔壁街区/小区，用户问「我现在在哪」就答错门牌；
      // 达不到时仍返回最佳 fix 并如实携带 accuracyMeters，由服务端决定降级展示。
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 8));
      final ClientLocationPayload? amap = await _amapFix(
        timeout: const Duration(milliseconds: 5000),
        maxAccuracyMeters: 10,
      );
      Position? position;
      final Duration remaining = deadline.difference(DateTime.now());
      if (!_isAccurateEnough(amap?.accuracyMeters, 10) &&
          remaining >= const Duration(milliseconds: 500)) {
        position = await _fetchPrecisePosition(
          budget: remaining,
          maxAccuracyMeters: 10,
        );
      }

      // 高德 fix 优先（精度达标时 geolocator 已跳过）；否则用 geolocator 的结果。
      final ClientLocationPayload? coordsPayload = position != null
          ? await _payloadFrom(position)
          : amap;
      if (coordsPayload == null) {
        debugPrint("[ClientLocationService] 预算内未取到任何 fix，回缓存兜底");
        return _cached ?? disk;
      }

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
