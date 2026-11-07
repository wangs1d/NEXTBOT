import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 系统级地理围栏（Sense 层的「到达/离开」事件源）。
///
/// 为什么必须下沉到客户端：
///  - Android 8+ 应用在后台（非前台服务）时，系统把定位更新限制成「每小时几次」，
///    请求更短的 interval 也兑现不了。靠上报流在服务端算「有没有进围栏」，
///    在后台**根本判不出来**。
///  - Android `/ iOS` 都提供系统托管的围栏 API（本端用 `LocationManager.
///    addProximityAlert`，iOS 对应 `CLCircularRegion`，上限约 20 个）：由系统
///    位置服务判定并唤醒 App，**App 被杀死也能触发**，且几乎不耗电。
///
/// 触发语义：原生只回报「进了/离开了哪个 fenceId」，具体动作（提醒/任务/webhook）
/// 一律由服务端决定——端上不执行任何业务。
class ClientGeofenceService {
  ClientGeofenceService._();

  static const MethodChannel _method = MethodChannel("private_ai_agent/geofence");
  static const EventChannel _events = EventChannel("private_ai_agent/geofence_events");

  static StreamSubscription<dynamic>? _sub;

  /// 同步围栏配置到系统（幂等：先清空本应用注册的全部围栏再重新注册）。
  /// 非 Android（桌面/Web）静默跳过——那里没有系统围栏，位置上报走按需/常驻。
  static Future<void> sync(List<Map<String, dynamic>> fences) async {
    if (kIsWeb || !Platform.isAndroid) return;
    try {
      await _method.invokeMethod<void>("sync", <String, dynamic>{"fences": fences});
      debugPrint("[ClientGeofenceService] 已同步 ${fences.length} 个系统围栏");
    } catch (e) {
      // 权限不足/系统不支持一律静默：服务端仍可按上报流判围栏（降级不报错）
      debugPrint("[ClientGeofenceService] 围栏同步失败(降级为服务端判定): $e");
    }
  }

  /// 清空系统围栏（用户删除全部围栏 / 退出登录）。
  static Future<void> clear() async {
    if (kIsWeb || !Platform.isAndroid) return;
    try {
      await _method.invokeMethod<void>("clear");
    } catch (e) {
      debugPrint("[ClientGeofenceService] 围栏清除失败(忽略): $e");
    }
  }

  /// 取出「App 未运行期间」积压的围栏事件并清空原生队列。
  ///
  /// 原生在海报触发时若 Dart 侧不可达，会把事件写进 SharedPreferences；App 下次
  /// 启动/回到前台时取走补报（带原始触发时刻，服务端按龄期如实标注）。
  static Future<List<Map<String, dynamic>>> drainPending() async {
    if (kIsWeb || !Platform.isAndroid) return const <Map<String, dynamic>>[];
    try {
      final List<dynamic>? raw =
          await _method.invokeMethod<List<dynamic>>("drainPending");
      if (raw == null) return const <Map<String, dynamic>>[];
      return raw
          .whereType<Map<dynamic, dynamic>>()
          .map((Map<dynamic, dynamic> e) => e.cast<String, dynamic>())
          .toList(growable: false);
    } catch (e) {
      debugPrint("[ClientGeofenceService] 围栏事件补报读取失败(忽略): $e");
      return const <Map<String, dynamic>>[];
    }
  }

  /// 订阅实时围栏事件（App 进程存活时由系统广播直接送达）。
  ///
  /// 原生侧发的是 JSON 字符串（跨通道类型最稳定），这里统一解成 Map。
  static void listen(void Function(Map<String, dynamic> event) onEvent) {
    if (kIsWeb || !Platform.isAndroid) return;
    if (_sub != null) return;
    _sub = _events.receiveBroadcastStream().listen(
      (dynamic raw) {
        final Map<String, dynamic>? parsed = _decode(raw);
        if (parsed != null) onEvent(parsed);
      },
      onError: (Object e) => debugPrint("[ClientGeofenceService] 围栏事件流出错: $e"),
    );
  }

  static Map<String, dynamic>? _decode(dynamic raw) {
    try {
      if (raw is String) {
        final dynamic json = jsonDecode(raw);
        return json is Map ? json.cast<String, dynamic>() : null;
      }
      if (raw is Map) return raw.cast<String, dynamic>();
    } catch (e) {
      debugPrint("[ClientGeofenceService] 围栏事件解析失败: $e");
    }
    return null;
  }

  static Future<void> dispose() async {
    await _sub?.cancel();
    _sub = null;
  }
}
