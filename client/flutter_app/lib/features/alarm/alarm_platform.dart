/// 闹钟平台桥 —— Android 精确闹钟（AlarmManager.setExactAndAllowWhileIdle）
/// 经 MethodChannel 调度；iOS 无对应能力（App 被杀后系统不允许第三方持续响铃），
/// 二阶段前的 iOS 路径由 flutter_local_notifications 的 zonedSchedule 本地通知承载
/// （30s 提示音承诺上限，见 docs/mobile-agent-reminder-alarm-design.md §6）。
library;

import "package:flutter/services.dart";

class AlarmPlatform {
  static const MethodChannel _channel = MethodChannel("nextbot/alarm_clock");

  static bool _unavailable = false; // 桌面端/桥未注册时置位，避免反复抛异常

  /// 原生通知动作回调（贪睡/关闭）：由 [attachActionHandler] 注册，AlarmEngine 消费。
  static void Function(String action, String alarmId)? onNativeAction;

  /// 注册原生 → Dart 的通知动作桥（引擎 init 时调用一次）
  static void attachActionHandler() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == "alarmAction") {
        final args = call.arguments;
        if (args is Map) {
          final action = args["action"]?.toString() ?? "";
          final alarmId = args["alarmId"]?.toString() ?? "";
          if (action.isNotEmpty && alarmId.isNotEmpty) {
            onNativeAction?.call(action, alarmId);
          }
        }
      }
      return null;
    });
  }

  /// 初始化配置：下发网关基址（Dart 不在场时，通知动作经原生 REST 兜底）
  static Future<void> configure({required String httpBase}) async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("configure", {"httpBase": httpBase});
    } on Exception {
      /* ignore */
    }
  }

  /// 预约精确闹钟（Android）。返回 false 表示桥不可用/精确闹钟权限缺失（调用方降级）。
  static Future<bool> scheduleNext({required String alarmId, required DateTime at, String label = ""}) async {
    if (_unavailable) return false;
    try {
      final ok = await _channel.invokeMethod<bool>("scheduleNext", {
        "alarmId": alarmId,
        "epochMs": at.millisecondsSinceEpoch,
        "label": label,
      });
      return ok ?? false;
    } on MissingPluginException {
      _unavailable = true;
      return false;
    } on PlatformException {
      return false;
    }
  }

  static Future<void> cancel(String alarmId) async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("cancel", {"alarmId": alarmId});
    } on Exception {
      /* 桥不可用时静默：本地库仍是事实源 */
    }
  }

  /// Android 12+ SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM 是否可用
  static Future<bool> canScheduleExact() async {
    if (_unavailable) return false;
    try {
      return await _channel.invokeMethod<bool>("canScheduleExact") ?? false;
    } on Exception {
      return false;
    }
  }

  /// 跳转系统"闹钟和提醒"授权页（Android 14 满屏 Intent / 精确闹钟权限）
  static Future<void> openExactAlarmSettings() async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("openExactAlarmSettings");
    } on Exception {
      /* ignore */
    }
  }

  /// 服务端兜底触发 / 本地测试：拉起响铃前台服务（Android）；其他平台 no-op。
  static Future<void> ringNow({required String alarmId, String label = "", String? ttsBase64}) async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("ringNow", {
        "alarmId": alarmId,
        "label": label,
        if (ttsBase64 != null) "ttsBase64": ttsBase64,
      });
    } on MissingPluginException {
      _unavailable = true;
    } on PlatformException {
      /* ignore */
    }
  }

  /// 停止响铃服务（贪睡/关闭后调用）
  static Future<void> stopRing() async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("stopRing");
    } on Exception {
      /* ignore */
    }
  }
}
