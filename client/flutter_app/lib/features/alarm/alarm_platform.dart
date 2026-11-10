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
  ///
  /// 默认音源是云端按动态话术实时合成的 mp3：建钟时 SpeechHub 生成 [voiceText]，
  /// 云端 TTS 按这句话合成 44.1kHz mp3 并随 alarm.sync 下发（[ttsBase64]），
  /// 原生层过音质门禁后落盘，只把路径放进 AlarmManager PendingIntent extra，
  /// 到点广播无需 WS / Dart 引擎 / 网络。端侧不再内置 ONNX 语音模型。
  ///
  /// [voiceText] 每次由当次上下文生成，音频也随之重新合成，不是预置录音；
  /// 云端 TTS 不可用时由系统 TextToSpeech 念这段话术，再兜底系统闹铃。
  /// [builtinVoice] 只用于 A/B 测试固定音色，指定时优先于云端 mp3。
  static Future<bool> scheduleNext({
    required String alarmId,
    required DateTime at,
    String label = "",
    String? ttsBase64,
    String? voiceText,
    String? builtinVoice,
  }) async {
    if (_unavailable) return false;
    try {
      final ok = await _channel.invokeMethod<bool>("scheduleNext", {
        "alarmId": alarmId,
        "epochMs": at.millisecondsSinceEpoch,
        "label": label,
        if (ttsBase64 != null && ttsBase64.isNotEmpty) "ttsBase64": ttsBase64,
        if (voiceText != null && voiceText.isNotEmpty) "voiceText": voiceText,
        if (builtinVoice != null && builtinVoice.isNotEmpty) "builtinVoice": builtinVoice,
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

  /// 「用完即删除」：删原生私有目录里该闹钟的动态 mp3 + pending 中的音频引用。
  /// 只在关闭 / 响完时调用；贪睡会再响一次，必须保留音频。幂等。
  static Future<void> releaseVoice(String alarmId) async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("releaseVoice", {"alarmId": alarmId});
    } on Exception {
      /* 桥不可用时静默：启动清扫会兜底清孤儿文件 */
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

  /// 跳转系统"闹钟和提醒"授权页（Android 12+ 精确闹钟权限）
  static Future<void> openExactAlarmSettings() async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("openExactAlarmSettings");
    } on Exception {
      /* ignore */
    }
  }

  /// 跳转 Android 14+ 全屏意图授权页 / 电池优化白名单页（原生闹钟可靠性开关）
  static Future<void> openAlarmReliabilitySettings() async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("openAlarmReliabilitySettings");
    } on Exception {
      /* ignore */
    }
  }

  static Future<bool> isBatteryOptimizationIgnored() async {
    if (_unavailable) return false;
    try {
      return await _channel.invokeMethod<bool>("isBatteryOptimizationIgnored") ?? false;
    } on Exception {
      return false;
    }
  }

  /// 服务端兜底触发 / 本地测试：拉起响铃前台服务（Android）；其他平台 no-op。
  ///
  /// [builtinVoice] 传 `diana` / `anna` / `alex` 时，用 APK 内置的那三个保留音色之一
  /// 跑完整响铃链路（锁屏通知 + 语音 + 接铃），完全离线、逐次一致，专门给端侧本地测试用。
  static Future<void> ringNow({
    required String alarmId,
    String label = "",
    String? ttsBase64,
    String? voiceText,
    String? builtinVoice,
  }) async {
    if (_unavailable) return;
    try {
      await _channel.invokeMethod<void>("ringNow", {
        "alarmId": alarmId,
        "label": label,
        if (ttsBase64 != null) "ttsBase64": ttsBase64,
        if (voiceText != null && voiceText.isNotEmpty) "voiceText": voiceText,
        if (builtinVoice != null && builtinVoice.isNotEmpty) "builtinVoice": builtinVoice,
      });
    } on MissingPluginException {
      _unavailable = true;
    } on PlatformException {
      /* ignore */
    }
  }

  /// APK 内置的三个保留音色清单（#1 diana / #6 anna / #2 alex），供本地测试面板枚举。
  static Future<List<Map<String, dynamic>>> listBuiltinVoices() async {
    if (_unavailable) return const [];
    try {
      final raw = await _channel.invokeMethod<List<dynamic>>("listBuiltinVoices") ?? const [];
      return raw
          .whereType<Map<dynamic, dynamic>>()
          .map((e) => e.map((k, v) => MapEntry(k.toString(), v)))
          .toList();
    } on MissingPluginException {
      _unavailable = true;
      return const [];
    } on PlatformException {
      return const [];
    }
  }

  /// 端侧本地测试入口：用指定保留音色立刻跑一次完整响铃链路（不写业务闹钟库）。
  static Future<void> testBuiltinVoice(String id, {String label = "内置音色测试"}) {
    return ringNow(
      alarmId: "builtin_voice_test_$id",
      label: label,
      builtinVoice: id,
    );
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
