import "package:flutter/foundation.dart";
import "package:flutter_timezone/flutter_timezone.dart";

/// 设备时钟快照（时间感知的设备侧入口）。
///
/// 设计要点（2026-11-05 重构）：
///  - **时区是设备属性，不是地理信息**。系统自己就知道（运营商 NITZ / 系统
///    设置），拿它不需要定位权限、不联网、不耗电。此前时区只能由 GPS +
///    逆地理链路上带，抓不到 fix 就退回服务器时区（境外全错）。
///  - **`at` 必须是绝对时刻**（UTC ISO，带 Z）。裸本地时间在服务端会被按
///    服务器时区解析，跨时区直接错开数小时——旧 `timestamp` 字段就踩了这个坑。
///  - 每次调用都是纯内存/系统调用，无缓存也不需要缓存：调用成本 ≈ 一次
///    `DateTime.now()`，可以每条消息都带上。
class ClientClockService {
  ClientClockService._();

  /// 上一次上报的时区（仅用于「变化侦测」，判定是否需要主动补报）。
  static String? _lastTimezone;
  static int? _lastOffsetMinutes;

  /// 读取当前设备时钟快照（可直接作为 `clientClock` 字段并入 WS 载荷）。
  ///
  /// 返回结构：`{ timezone?, utcOffsetMinutes, at, source }`。
  /// 时区读取失败时不构造该字段（服务端会自行降级，绝不传空串）。
  static Future<Map<String, dynamic>> snapshot({
    String source = "snapshot",
  }) async {
    final DateTime now = DateTime.now();
    final String? tz = await _deviceTimezone();
    if (tz != null) {
      _lastTimezone = tz;
    }
    _lastOffsetMinutes = now.timeZoneOffset.inMinutes;
    return <String, dynamic>{
      if (tz != null) "timezone": tz,
      "utcOffsetMinutes": now.timeZoneOffset.inMinutes,
      // toUtc() 保证输出带 Z 的绝对时刻；直接 now.toIso8601String() 是无偏移的本地时间。
      "at": now.toUtc().toIso8601String(),
      "source": source,
    };
  }

  /// 预热设备时区（App 启动时调一次）。
  ///
  /// `session.init` 的发送必须**同步且先于补发消息**（顺序错会归错车道），
  /// 而读取 IANA 时区是异步平台调用。预热后 [snapshotSync] 能同步给出完整
  /// 快照；未预热时它仍会带 UTC 偏移与绝对时刻（服务端可据此降级）。
  static Future<void> warmUp() async {
    await _deviceTimezone();
  }

  /// 同步快照（用于必须同步构造的载荷，如 `session.init`）。
  ///
  /// 时区来自最近一次读取；未预热过时缺 `timezone` 字段，但一定带
  /// `utcOffsetMinutes` 与带 Z 的绝对时刻。
  static Map<String, dynamic> snapshotSync({String source = "snapshot"}) {
    final DateTime now = DateTime.now();
    final String? tz = _lastTimezone;
    _lastOffsetMinutes = now.timeZoneOffset.inMinutes;
    return <String, dynamic>{
      if (tz != null) "timezone": tz,
      "utcOffsetMinutes": now.timeZoneOffset.inMinutes,
      "at": now.toUtc().toIso8601String(),
      "source": source,
    };
  }

  /// 时区（含夏令时偏移）是否与上次上报不同。
  ///
  /// 用于「常驻连接期间用户跨时区」的场景：飞行/高铁落地后系统切换时区，
  /// 但用户可能很久不发消息，下一条主动消息仍带着旧时区。侦测到变化时调用
  /// [reportClockChange] 主动补报一次。
  static Future<bool> hasTimezoneChanged() async {
    final String? tz = await _deviceTimezone();
    final int offset = DateTime.now().timeZoneOffset.inMinutes;
    if (tz == null) return false;
    if (_lastTimezone == null) {
      _lastTimezone = tz;
      _lastOffsetMinutes = offset;
      return false;
    }
    return tz != _lastTimezone || offset != _lastOffsetMinutes;
  }

  /// 当前设备 IANA 时区（失败返回 null；不上报空值）。
  static Future<String?> _deviceTimezone() async {
    try {
      final TimezoneInfo info = await FlutterTimezone.getLocalTimezone();
      final String id = info.identifier.trim();
      if (id.isNotEmpty) return id;
    } catch (e) {
      debugPrint("[ClientClockService] 读取设备时区失败: $e");
    }
    return null;
  }
}
