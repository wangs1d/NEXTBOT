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

import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "ongoing_status_service.dart";
import "phone_state_reporter.dart";

class KeepAliveService {
  KeepAliveService._();

  static const MethodChannel _channel = MethodChannel("nextbot/keep_alive");

  /// 拉起前台保活服务。幂等（重复 start 只是重投 onStartCommand）。
  ///
  /// 2026-11-23：保活起来后顺带启动两个同进程的常驻能力——
  ///   - [PhoneStateReporter]：手机状态上报（在场判定 + 15 分钟桶）；
  ///   - [OngoingStatusService]：把这条保活通知刷成今日状态栏。
  /// 两者自身都幂等，bootstrap 与回前台的重复调用是空转。
  static Future<bool> start() async {
    try {
      final bool ok = await _channel.invokeMethod<bool>("start") ?? false;
      try {
        PhoneStateReporter.instance.start();
      } catch (e) {
        debugPrint("[keep-alive] phone state reporter start failed: $e");
      }
      try {
        unawaited(OngoingStatusService.instance.start());
      } catch (e) {
        debugPrint("[keep-alive] ongoing status start failed: $e");
      }
      return ok;
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

  /// 电池优化是否已被豁免（诊断上报 / 保活引导展示用）。
  static Future<bool> isBatteryExempt() async {
    try {
      return await _channel.invokeMethod<bool>("isBatteryExempt") ?? false;
    } on Exception {
      return false;
    }
  }

  /// 弹系统「电池优化豁免」授权框（已豁免时原生直接返回 true，不重复弹）。
  ///
  /// 2026-11-22：生产日志实证断开的同一秒进程消失（死前 0.4s 仍在写存活心跳），
  /// 而 `batteryExempt` 全程 false —— 系统回收进程是断连的根因。这个授权框是
  /// 唯一能由 App 主动发起的解法；国产 ROM 还须叠加「应用启动管理」白名单。
  static Future<bool> requestBatteryExempt() async {
    try {
      return await _channel.invokeMethod<bool>("requestBatteryExempt") ?? false;
    } on Exception {
      return false;
    }
  }

  /// 打开厂商「应用启动管理」页（自启动 / 关联启动 / 后台活动）。
  ///
  /// 国产 ROM 的这层管理绕过 AOSP 进程优先级，是"前台服务在跑却照样被杀"
  /// 的真正开关。AOSP 无统一入口，原生侧按厂商逐个尝试后回落应用详情页。
  static Future<bool> openAppStartupSettings() async {
    try {
      return await _channel.invokeMethod<bool>("openAppStartupSettings") ?? false;
    } on Exception {
      return false;
    }
  }
}
