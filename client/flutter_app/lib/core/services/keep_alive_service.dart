/// 后台保活桥 —— 拉起原生 MessageBridgeForegroundService 低优常驻前台服务。
///
/// 2026-11-10 根修：App 切后台（进程未杀）成为 cached 进程后会被
/// Cached Apps Freezer 整体冻结——Dart 引擎全部线程挂起，WS 心跳停摆，
/// 服务端主动消息/提醒静默丢失（「提醒静默过了、消息不出来」的根因）。
/// 前台服务进程永不冻结，主聊天 WS 因此在后台持续在线；事件到达后的
/// 系统通知转化由 main.dart 各 WS 分发点与 AmbientFeedsController 负责。
///
/// 调用时机铁律：必须在 App 前台时 start（Android 12+ 禁止后台启动前台
/// 服务）——bootstrap 启动期与回前台 resumed 各拉一次，START_STICKY 兜底。
library;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

class KeepAliveService {
  KeepAliveService._();

  static const MethodChannel _channel = MethodChannel("nextbot/keep_alive");

  /// 拉起前台保活服务。幂等（重复 start 只是重投 onStartCommand）。
  static Future<bool> start() async {
    try {
      return await _channel.invokeMethod<bool>("start") ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException catch (e) {
      debugPrint("[keep-alive] start failed: ${e.code} ${e.message}");
      return false;
    }
  }

  /// 停止前台服务。注意：消息桥接（PhoneCaptureService.startBridgeService）
  /// 复用同一个服务，当前保活为常驻策略，Dart 侧不主动调 stop。
  static Future<void> stop() async {
    try {
      await _channel.invokeMethod<void>("stop");
    } on Exception {
      /* ignore */
    }
  }

  static Future<bool> isRunning() async {
    try {
      return await _channel.invokeMethod<bool>("isRunning") ?? false;
    } on Exception {
      return false;
    }
  }

  /// 请求电池优化豁免（2026-11-12）：前台服务仍被 ROM 冻结时的关键兜底。
  /// 已豁免则空转返回 true；未豁免会拉起系统确认对话框，用户点一次
  /// 「允许」永久生效。失败（无权限/系统拒绝）返回 false，不影响运行。
  static Future<bool> ensureBatteryExemption() async {
    try {
      return await _channel.invokeMethod<bool>("ensureBatteryExempt") ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException catch (e) {
      debugPrint("[keep-alive] battery exemption failed: ${e.code} ${e.message}");
      return false;
    }
  }

  /// 电池优化是否已被豁免（诊断上报用）。
  static Future<bool> isBatteryExempt() async {
    try {
      return await _channel.invokeMethod<bool>("isBatteryExempt") ?? false;
    } on Exception {
      return false;
    }
  }
}
