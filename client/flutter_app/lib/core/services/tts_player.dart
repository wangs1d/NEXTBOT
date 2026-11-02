import "dart:async";
import "dart:convert";
import "dart:io";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

import "../config/media_url.dart";

/// Windows 上 audioplayers_windows_plugin 的 BytesSource 会触发 native
/// 层 0xc0000005 access violation，Dart try-catch 无法捕获。
/// 统一走临时文件 + DeviceFileSource 绕过。
const bool _kWindowsSkipBytesSource = true;

/// 播放进度快照（position 实时更新；duration 就绪后非空）。
class TtsPlaybackProgress {
  const TtsPlaybackProgress({required this.position, this.duration});

  final Duration position;
  final Duration? duration;
}

/// 后台 TTS 音频播放器。
///
/// 用法：
///   1. Agent 推送 call_connecting 时调用 [TtsPlayer.playFromBase64]
///   2. 通话结束 / 用户挂断时调用 [TtsPlayer.stop] 或 [TtsPlayer.dispose]
///   3. 监听 [TtsPlayer.onCompleted] 处理播放完成事件
///
/// 设计要点：
///   - 任何时候只有一个 TTS 在播放（单例 AudioPlayer）
///   - 启动新 TTS 时会自动停掉旧的
///   - 播放完自动释放临时文件
///   - 不依赖任何 UI 组件（不弹窗、不 toast、不通知）
class TtsPlayer {
  TtsPlayer._();

  static final TtsPlayer instance = TtsPlayer._();

  AudioPlayer? _player;
  File? _tempFile;
  Completer<void>? _completionCompleter;
  /// 是否已在本次播放的收尾流程中（阻断 onPlayerComplete / stopped 重入）
  bool _ending = false;
  /// 播放代次：每次开播自增，用于保证一次播放的完成回调只下达一次
  int _playSeq = 0;
  /// 已完成回调下发的最高代次（-1 = 还没下发过）
  int _firedSeq = -1;

  /// 当前是否有 TTS 正在播放。
  ///
  /// 注：播完（onPlayerComplete）会先释放播放器再触发完成回调，因此本值
  /// 在 playFromBase64 返回到回调触发之间为 true，回调之后即归 false。
  /// 全双工语音用它做半双工门控，务必保证它不会卡在 true，否则麦克风上行
  /// 会被永久丢弃（表现为「通话接通了但说话没反应」）。
  bool get isPlaying => _player != null;

  /// 播放进度广播（今日简报悬浮窗波形进度等消费方）。
  final StreamController<TtsPlaybackProgress> _progressController =
      StreamController<TtsPlaybackProgress>.broadcast();
  StreamSubscription<Duration>? _positionSub;
  StreamSubscription<Duration>? _durationSub;
  Duration? _lastDuration;

  Stream<TtsPlaybackProgress> get onProgress => _progressController.stream;

  /// TTS 播放完成回调（正常播完 / 被 stop 都触发）
  final List<VoidCallback> _completionListeners = <VoidCallback>[];

  /// 开始播放回调（任何入口开播都会触发）。
  ///
  /// 全双工语音据此做半双工门控：agent.phone.voice_reply 这类不走 duplex
  /// 的播报路径也能被感知，避免扬声器声音被麦克风回采形成自激。
  final List<VoidCallback> _startListeners = <VoidCallback>[];

  /// 注册播放开始监听
  void addOnPlaybackStarted(VoidCallback listener) {
    if (!_startListeners.contains(listener)) _startListeners.add(listener);
  }

  /// 取消播放开始监听
  void removeOnPlaybackStarted(VoidCallback listener) {
    _startListeners.remove(listener);
  }

  void _fireStart() {
    for (final VoidCallback l in List<VoidCallback>.of(_startListeners)) {
      try {
        l();
      } catch (_) {}
    }
  }

  /// 注册播放完成监听（同一 listener 重复注册只会保留一份：main.dart 多个
  /// 通话入口都会注册同一个回调，不去重会累积导致重复触发）
  void addOnCompleted(VoidCallback listener) {
    if (!_completionListeners.contains(listener)) _completionListeners.add(listener);
  }

  /// 取消播放完成监听
  void removeOnCompleted(VoidCallback listener) {
    _completionListeners.remove(listener);
  }

  /// 从 base64 字符串播放 TTS
  ///
  /// [base64Str] 音频的 base64 编码；[format] 决定临时文件扩展名
  /// （mp3 = 简报/常规 TTS，wav = 全双工实时语音 tts.chunk）。
  Future<bool> playFromBase64(String base64Str, {String format = "mp3"}) async {
    if (base64Str.isEmpty) return false;
    try {
      final Uint8List bytes = base64Decode(base64Str);
      return await playFromBytes(bytes, format: format);
    } catch (e) {
      debugPrint("[TtsPlayer] base64 decode failed: $e");
      _fireCompletion();
      return false;
    }
  }

  /// 从字节数组播放 TTS
  Future<bool> playFromBytes(Uint8List bytes, {String format = "mp3"}) async {
    if (bytes.isEmpty) {
      _fireCompletion();
      return false;
    }
    // 停掉旧播放
    await _disposeCurrent(silent: true);

    final AudioPlayer player = AudioPlayer();
    _player = player;
    _completionCompleter = Completer<void>();
    final int seq = ++_playSeq;

    player.onPlayerComplete.listen((_) {
      unawaited(_handlePlaybackEnd(seq));
    });
    player.onPlayerStateChanged.listen((state) {
      if (state == PlayerState.stopped) {
        unawaited(_handlePlaybackEnd(seq));
      }
    });
    _attachProgressListeners(player);

    // Windows 上 BytesSource 会触发 native 层 0xc0000005 access violation
    // 直接走临时文件 + DeviceFileSource 绕过
    if (_kWindowsSkipBytesSource) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/tts_${DateTime.now().millisecondsSinceEpoch}.$format",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
        _fireStart();
        return true;
      } catch (e) {
        debugPrint("[TtsPlayer] play failed: $e");
        await _disposeCurrent(silent: true);
        return false;
      }
    }

    try {
      // 非 Windows 平台优先 BytesSource
      await player.play(BytesSource(bytes, mimeType: "audio/mpeg"));
      _fireStart();
      return true;
    } catch (e) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/tts_${DateTime.now().millisecondsSinceEpoch}.$format",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
        _fireStart();
        return true;
      } catch (e2) {
        debugPrint("[TtsPlayer] play failed: $e2");
        await _disposeCurrent(silent: true);
        return false;
      }
    }
  }

  /// 主动停止当前播放
  Future<void> stop() async {
    await _disposeCurrent(silent: false);
  }

  /// 从 URL 拉流播放（用于语音消息气泡点击重播）。
  ///
  /// [baseUrl] 服务端基础 URL（如 `http://127.0.0.1:3000`）；
  /// [mediaUrl] 服务端返回的可访问路径（如 `/agent/voice/messages/.../xxx.mp3`）。
  /// 拼接为完整 URL 后用 audioplayers 的 UrlSource 播放。
  Future<bool> playFromUrl(String fullUrl) async {
    if (fullUrl.isEmpty) {
      _fireCompletion();
      return false;
    }
    // 停掉旧播放
    await _disposeCurrent(silent: true);

    final AudioPlayer player = AudioPlayer();
    _player = player;
    _completionCompleter = Completer<void>();
    final int seq = ++_playSeq;

    player.onPlayerComplete.listen((_) {
      unawaited(_handlePlaybackEnd(seq));
    });
    player.onPlayerStateChanged.listen((state) {
      if (state == PlayerState.stopped) {
        unawaited(_handlePlaybackEnd(seq));
      }
    });
    _attachProgressListeners(player);

    try {
      await player.play(UrlSource(MediaUrl.resolve(fullUrl)));
      _fireStart();
      return true;
    } catch (e) {
      debugPrint("[TtsPlayer] playFromUrl failed: $e");
      await _disposeCurrent(silent: true);
      return false;
    }
  }

  /// 释放资源（应用退出时调用）
  Future<void> dispose() async {
    await _disposeCurrent(silent: true);
    _completionListeners.clear();
  }

  /// 挂接 position/duration 监听 → onProgress 广播（悬浮窗波形进度）。
  void _attachProgressListeners(AudioPlayer player) {
    _lastDuration = null;
    _positionSub = player.onPositionChanged.listen((Duration position) {
      if (_progressController.isClosed) return;
      _progressController.add(
        TtsPlaybackProgress(position: position, duration: _lastDuration),
      );
    });
    _durationSub = player.onDurationChanged.listen((Duration duration) {
      if (duration <= Duration.zero) return;
      _lastDuration = duration;
      if (_progressController.isClosed) return;
      _progressController.add(
        TtsPlaybackProgress(position: Duration.zero, duration: duration),
      );
    });
  }

  /// 播放自然结束（播完到底 / 播放器进入 stopped）。
  ///
  /// 必须先释放播放器再通知完成回调：consumers（尤其全双工语音的半双工门控）
  /// 在回调里依赖 [isPlaying] 归位，顺序反了会导致麦克风上行永久关闭。
  Future<void> _handlePlaybackEnd(int seq) async {
    if (_ending || seq != _playSeq || seq == _firedSeq) return;
    _ending = true;
    try {
      await _disposeCurrent(silent: true);
      _fireCompletion(seq);
    } finally {
      _ending = false;
    }
  }

  Future<void> _disposeCurrent({required bool silent}) async {
    await _positionSub?.cancel();
    await _durationSub?.cancel();
    _positionSub = null;
    _durationSub = null;
    if (_player != null) {
      // 先摘引用再释放：并发收尾时第二次调用看到的是 null，不会误伤新播放
      final AudioPlayer? p = _player;
      _player = null;
      try {
        await p!.stop();
      } catch (_) {}
      try {
        await p!.dispose();
      } catch (_) {}
    }
    final File? f = _tempFile;
    _tempFile = null;
    if (f != null) {
      try { if (await f.exists()) await f.delete(); } catch (_) {}
    }
    if (silent) {
      // 内部清理，不触发完成回调
      if (!(_completionCompleter?.isCompleted ?? true)) {
        _completionCompleter?.complete();
        _completionCompleter = null;
      }
    } else {
      // 主动 stop：按代次通知，避免与 stopped 事件双通道重复下发
      _fireCompletion(_playSeq);
    }
  }

  /// [seq] 非空时按播放代次去重：同一代次的完成回调只下达一次（避免
  /// onPlayerComplete 与 stopped 双通道、以及 stop() 抢占时重复通知）。
  void _fireCompletion([int? seq]) {
    if (seq != null) {
      if (seq == _firedSeq) return; // 本代已下发过
      _firedSeq = seq;
    }
    if (!(_completionCompleter?.isCompleted ?? true)) {
      _completionCompleter?.complete();
      _completionCompleter = null;
    }
    final List<VoidCallback> snapshot = List<VoidCallback>.of(_completionListeners);
    for (final VoidCallback l in snapshot) {
      try { l(); } catch (_) {}
    }
  }
}
