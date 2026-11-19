import "dart:async";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "ws_chat_service.dart";

/// 系统网络路径监听（2026-11-18 手机端「老是重连」治理）。
///
/// 移动网络下 Wi‑Fi ⇄ 蜂窝切换、飞行模式恢复都会让旧 TCP 连接静默失效：
/// socket 不报错、`closeCode` 仍是 null，只能等心跳 75s + 探测宽限才判死，
/// 用户要干等一分多钟。原生侧（KeepAlivePlugin）注册
/// `ConnectivityManager.registerDefaultNetworkCallback`，路径一变化就推到这里，
/// 由连接层立即探活/重建。
///
/// 非 Android（iOS/桌面/Web）当前不注册原生监听，仍走心跳兜底；返回值
/// 不重要，调用方无需分支。
class NetworkWatchService {
  NetworkWatchService._();

  static final NetworkWatchService instance = NetworkWatchService._();

  static const EventChannel _channel =
      EventChannel("nextbot/network_events");

  StreamSubscription<dynamic>? _subscription;
  String? _lastType;
  DateTime _lastNotifyAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _started = false;

  /// 开始监听（幂等）。应在 App 启动、WS 首次连接前调用。
  void start() {
    if (_started || kIsWeb || !Platform.isAndroid) return;
    _started = true;
    _subscription = _channel.receiveBroadcastStream().listen(
      (dynamic event) {
        final String type = event?.toString() ?? "";
        // "none" 是断网中间态：等恢复（下一个非 none）再触发，避免无网时
        // 反复重建连接制造退避风暴。
        if (type == "none") {
          _lastType = type;
          return;
        }
        final bool changed = _lastType != null && _lastType != type;
        _lastType = type;
        if (!changed) return;
        // 原生侧 onLost/onAvailable 可能连续下发两帧（先 none 再 wifi）：
        // 2s 内只处理一次，避免同一个切换拆两次链。
        final DateTime now = DateTime.now();
        if (now.difference(_lastNotifyAt) < const Duration(seconds: 2)) {
          return;
        }
        _lastNotifyAt = now;
        debugPrint("[net] path changed -> $type, probing ws link");
        WsChatService.shared.onNetworkChanged();
      },
      onError: (Object error) {
        // 原生监听不可用（旧系统/非 Android 实现）不影响业务，心跳仍兜底。
        debugPrint("[net] watch unavailable: $error");
      },
    );
  }

  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    _started = false;
  }
}
