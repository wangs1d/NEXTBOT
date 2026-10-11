import "dart:async";
import "dart:io" show Platform;
import "dart:typed_data";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 原生 PCM 流式播放器封装（Windows：waveOut 多缓冲轮转）。
///
/// 全双工实时语音的语音出口：服务端把助手回复切成小块 PCM16 逐段下发，
/// 这里逐块直写原生播放器，首块到达（原生侧攒够约 60ms 预缓冲）就出声——
/// 不必像 [TtsPlayer] 那样等整段音频到齐、resolve、写临时文件再交给播放器，
/// 首字延迟因此只取决于 MiniMax 首包。
///
/// 仅 Windows 端有原生实现；其它平台 [start] 返回 false，调用方回落。
class PcmStreamPlayer {
  PcmStreamPlayer._();

  static final PcmStreamPlayer instance = PcmStreamPlayer._();

  static const MethodChannel _channel = MethodChannel("pai/pcm_player");

  bool _handlerInstalled = false;
  bool _active = false;
  Completer<void>? _drain;

  /// 原生把已入队音频播完后回调（用于解除半双工麦克风门控）。
  void Function()? onCompleted;

  bool get isPlaying => _active;

  void _installHandler() {
    if (_handlerInstalled) return;
    _handlerInstalled = true;
    _channel.setMethodCallHandler((MethodCall call) async {
      if (call.method == "onComplete") {
        _active = false;
        final Completer<void>? c = _drain;
        _drain = null;
        if (c != null && !c.isCompleted) c.complete();
        onCompleted?.call();
      }
      return null;
    });
  }

  /// 开一段新流（自动停掉上一段）。返回 false = 原生播放器不可用
  /// （非 Windows / 通道未注册），调用方应回落其它播放路径。
  Future<bool> start({int sampleRate = 24000, int channels = 1}) async {
    if (!Platform.isWindows) return false;
    _installHandler();
    _drain = null;
    try {
      final bool ok =
          await _channel.invokeMethod<bool>("start", <String, dynamic>{
            "sampleRate": sampleRate,
            "channels": channels,
          }) ??
          false;
      _active = ok;
      return ok;
    } on MissingPluginException {
      return false;
    } on PlatformException catch (e) {
      debugPrint("[PcmStreamPlayer] start failed: $e");
      return false;
    }
  }

  /// 逐块追加 PCM16 数据（fire-and-forget，高频调用不串行等待）。
  void write(Uint8List pcm) {
    if (!_active || pcm.isEmpty) return;
    unawaited(_invokeWrite(pcm));
  }

  /// 标记输入结束；返回的 Future 在原生把已入队音频播完后完成。
  Future<void> finish() {
    if (!_active) return Future<void>.value();
    final Completer<void> c = Completer<void>();
    _drain = c;
    unawaited(_invokeFinish(c));
    return c.future;
  }

  /// 立即停止（打断）：丢弃全部缓冲，原生不发完成回调。
  Future<void> stop() async {
    _active = false;
    _drain = null;
    if (!Platform.isWindows) return;
    try {
      await _channel.invokeMethod<void>("stop");
    } catch (_) {}
  }

  Future<void> _invokeWrite(Uint8List pcm) async {
    try {
      await _channel.invokeMethod<void>("write", pcm);
    } catch (_) {}
  }

  Future<void> _invokeFinish(Completer<void> c) async {
    try {
      await _channel.invokeMethod<void>("finish");
    } catch (_) {
      if (!c.isCompleted) c.complete();
    }
  }
}
