import "dart:async";
import "dart:io";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/foundation.dart";

import "../config/media_url.dart";
import "../../features/chat/media_disk_cache.dart";
import "ws_event_router.dart"
    show WsEventRouter, WsSubscribeScope, WsEventCatalog, wsEventPayload;

/// session.init 上报给服务端的能力声明：本客户端已实现 agent.media.* 消费
/// （MediaPlaybackService 经事件总线自订阅（ensureBusSubscription）后置 true，
/// 服务端 media.play 工具因此放行）。注意：只有在装配层实际调用了
/// ensureBusSubscription 之后才允许声明，否则又回到
/// 2026-09-12 的"信令发了但没人消费"假成功事故。
const bool kMediaPlaybackCapability = true;

/// 外部 CDN（如音乐平台）对非浏览器 UA 直接 403，取字节时补一个浏览器 UA。
const Map<String, String> _kBrowserUaHeader = <String, String>{
  "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/// 音频字节下载上限（长音频比图片宽限）。
const Duration _kAudioFetchTimeout = Duration(seconds: 60);

/// 当前播放状态快照（供 UI 悬浮条/迷你播放器消费；UI 接入不在本任务范围）。
class MediaNowPlaying {
  const MediaNowPlaying({
    required this.trackId,
    this.title,
    this.artist,
    this.durationMs,
    this.playing = false,
    this.paused = false,
    this.error,
  });

  final String trackId;
  final String? title;
  final String? artist;
  final int? durationMs;
  /// 真在出声（play 成功且未暂停；暂停/出错/播完均为 false——诚实状态）
  final bool playing;
  final bool paused;
  /// 最近一次错误（urlError / 播放失败原因）；无错误为 null
  final String? error;

  MediaNowPlaying copyWith({
    String? trackId,
    String? title,
    String? artist,
    int? durationMs,
    bool? playing,
    bool? paused,
    String? error,
    bool clearError = false,
  }) {
    return MediaNowPlaying(
      trackId: trackId ?? this.trackId,
      title: title ?? this.title,
      artist: artist ?? this.artist,
      durationMs: durationMs ?? this.durationMs,
      playing: playing ?? this.playing,
      paused: paused ?? this.paused,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// 平台播放适配层：把 audioplayers 的平台调用收敛到 4 个可覆盖方法，
/// 状态机测试注入 fake 即可，不必 mock audioplayers 本体。
class MediaPlaybackAdapter {
  /// 播放完成广播（自然播完 / stop 均可能触发；service 据此收敛状态）
  final StreamController<void> onCompletedController =
      StreamController<void>.broadcast();

  /// 播放失败广播（adapter 内部失败时 push 错误文案）
  final StreamController<String> onErrorController =
      StreamController<String>.broadcast();

  Stream<void> get onCompleted => onCompletedController.stream;
  Stream<String> get onError => onErrorController.stream;

  Future<void> play(String url) async {}
  Future<void> pause() async {}
  Future<void> resume() async {}
  Future<void> stop() async {}
  void dispose() {}
}

/// 默认实现：内部只持有一个 AudioPlayer（懒创建、跨曲目复用）。
///
/// 播放路径（2026-11-12 统一）：先经 [MediaDiskCache] 落到本地，再
/// `DeviceFileSource` 播本地文件——播放器发不出 `Authorization` 头的问题从
/// 根上绕开，URL 里不再需要 `?token=`；顺带拿到「重播秒开 + 离线可回放」。
class AudioPlayersAdapter extends MediaPlaybackAdapter {
  AudioPlayer? _player;
  StreamSubscription<void>? _completeSub;

  AudioPlayer _ensurePlayer() {
    if (_player != null) return _player!;
    final AudioPlayer player = AudioPlayer();
    player.setReleaseMode(ReleaseMode.stop);
    _completeSub = player.onPlayerComplete.listen((_) {
      if (!onCompletedController.isClosed) onCompletedController.add(null);
    });
    _player = player;
    return player;
  }

  Future<void> _disposeQuietly(AudioPlayer p) async {
    try {
      await p.dispose();
    } catch (_) {}
  }

  @override
  Future<void> play(String url) async {
    final AudioPlayer player = _ensurePlayer();
    // UrlSource 发不出 Authorization 头，过去只能靠 URL 里带 ?token=（凭证进
    // URL → 磁盘缓存键随续期漂移、token 进访问日志）。现在统一先经磁盘缓存层
    // 取字节（NbHttp 带凭证头 + 401 静默续期 + LRU 落盘），播放器只播本地文件：
    // 全平台同一条路径，重播直接命中本地，没网也能回放。
    final String resolved = MediaUrl.resolve(url);
    final File? local = await MediaDiskCache.instance.fileFor(
      resolved,
      extraHeaders: _kBrowserUaHeader,
      timeout: _kAudioFetchTimeout,
    );
    if (local != null) {
      await player.play(DeviceFileSource(local.path));
      return;
    }
    // 磁盘层不可用（缓存目录写不进去等）→ 兜底直连流播，至少还能出声。
    await player.play(UrlSource(resolved));
  }

  @override
  Future<void> pause() async {
    await _player?.pause();
  }

  @override
  Future<void> resume() async {
    await _player?.resume();
  }

  @override
  Future<void> stop() async {
    await _player?.stop();
  }

  @override
  void dispose() {
    _completeSub?.cancel();
    _completeSub = null;
    final AudioPlayer? p = _player;
    _player = null;
    if (p != null) {
      unawaited(_disposeQuietly(p));
    }
  }
}

/// 媒体音乐播放服务（单例）：消费服务端 `agent.media.*` WS 事件，真正出声。
///
/// 用法（main.dart 接线，一处即闭环）：
///   _ws.events.listen((event) {
///     ...
///     unawaited(MediaPlaybackService.instance.handleMediaEvent(type, payload));
///   });
///
/// 设计要点：
///   - 任何时候只有一首歌在播：新 play 自动顶掉旧的（单 AudioPlayer 语义）
///   - 诚实状态：urlError / 播放失败 / 暂停 / 播完 都如实反映在 [nowPlaying]，
///     绝不在没出声时报告 playing=true
///   - 平台调用全部收敛在 [MediaPlaybackAdapter]，测试注入 fake 即可
class MediaPlaybackService {
  MediaPlaybackService._() : _adapter = AudioPlayersAdapter();

  /// 测试可注入 fake adapter
  MediaPlaybackService.withAdapter(MediaPlaybackAdapter adapter)
      : _adapter = adapter;

  static final MediaPlaybackService instance = MediaPlaybackService._();

  static bool _busWired = false;

  /// 事件总线自订阅（main.dart 装配时调用一次；幂等）。
  ///
  /// agent.media.play/pause/resume/stop 归本模块 owned，main 根监听器不再接线。
  static void ensureBusSubscription() {
    if (_busWired) return;
    _busWired = true;
    WsEventRouter.instance.subscribe(
      module: "media-playback",
      types: WsEventCatalog.mediaPlayback,
      scope: WsSubscribeScope.root,
      onEvent: (Map<String, dynamic> event) => instance.handleMediaEvent(
        event["type"] as String? ?? "",
        wsEventPayload(event),
      ),
    );
  }

  final MediaPlaybackAdapter _adapter;
  StreamSubscription<void>? _completeSub;
  StreamSubscription<void>? _errorSub;
  bool _initialized = false;

  MediaNowPlaying? _nowPlaying;
  /// 当前播放状态（无任何播放记录时为 null）
  MediaNowPlaying? get nowPlaying => _nowPlaying;

  final List<VoidCallback> _listeners = <VoidCallback>[];

  /// 注册状态变更监听（UI 后续接入用；回调内读取 [nowPlaying] 快照）
  void addListener(VoidCallback listener) => _listeners.add(listener);

  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  void _attachAdapterStreams() {
    if (_initialized) return;
    _initialized = true;
    _completeSub = _adapter.onCompleted.listen((_) {
      // 自然播完：playing/paused 归位，保留曲目信息供 UI 显示"刚播完"
      _update(_nowPlaying?.copyWith(playing: false, paused: false));
    });
    _errorSub = _adapter.onError.listen((String message) {
      _update(_nowPlaying?.copyWith(playing: false, paused: false, error: message));
    });
  }

  void _update(MediaNowPlaying? next) {
    _nowPlaying = next;
    for (final VoidCallback l in List<VoidCallback>.of(_listeners)) {
      try {
        l();
      } catch (_) {}
    }
  }

  /// WS 事件统一入口：处理 agent.media.play/pause/resume/stop。
  /// 未识别的事件类型静默忽略（不消费其他模块的事件）。
  Future<void> handleMediaEvent(String type, Map<String, dynamic> payload) async {
    switch (type) {
      case "agent.media.play":
        await _handlePlay(payload);
        break;
      case "agent.media.pause":
        await _handlePause();
        break;
      case "agent.media.resume":
        await _handleResume();
        break;
      case "agent.media.stop":
        await _handleStop();
        break;
      default:
        break;
    }
  }

  Future<void> _handlePlay(Map<String, dynamic> payload) async {
    final String trackId = payload["trackId"]?.toString() ?? "";
    final String? url = payload["url"]?.toString();
    final String? urlError = payload["urlError"]?.toString();
    final MediaNowPlaying base = MediaNowPlaying(
      trackId: trackId,
      title: payload["title"]?.toString(),
      artist: payload["artist"]?.toString(),
      durationMs: payload["durationMs"] is int
          ? payload["durationMs"] as int
          : int.tryParse(payload["durationMs"]?.toString() ?? ""),
    );

    // 服务端 URL 解析失败（无版权/超时）：如实暴露错误状态，绝不假装在放
    if (url == null || url.isEmpty) {
      _update(base.copyWith(
        error: urlError ?? "事件未携带可播放 URL",
      ));
      return;
    }

    _attachAdapterStreams();
    _update(base.copyWith(playing: false, paused: false, clearError: true));
    try {
      await _adapter.play(url);
      // play 成功返回 = 音频真正开始出声
      _update(_nowPlaying?.copyWith(playing: true, paused: false, clearError: true));
    } catch (e) {
      debugPrint("[MediaPlayback] 播放失败：$e");
      _update(_nowPlaying?.copyWith(
        playing: false,
        paused: false,
        error: "播放失败：$e",
      ));
    }
  }

  Future<void> _handlePause() async {
    final MediaNowPlaying? cur = _nowPlaying;
    if (cur == null) return;
    try {
      await _adapter.pause();
      _update(cur.copyWith(playing: false, paused: true));
    } catch (e) {
      _update(cur.copyWith(error: "暂停失败：$e"));
    }
  }

  Future<void> _handleResume() async {
    final MediaNowPlaying? cur = _nowPlaying;
    if (cur == null) return;
    try {
      await _adapter.resume();
      _update(cur.copyWith(playing: true, paused: false, clearError: true));
    } catch (e) {
      _update(cur.copyWith(error: "恢复失败：$e"));
    }
  }

  Future<void> _handleStop() async {
    final MediaNowPlaying? cur = _nowPlaying;
    if (cur == null) return;
    try {
      await _adapter.stop();
    } catch (e) {
      debugPrint("[MediaPlayback] stop 失败：$e");
    }
    // stop 语义：清空播放状态（与服务端 media.stop 对齐）
    _update(null);
  }

  /// 应用退出时调用
  Future<void> dispose() async {
    await _completeSub?.cancel();
    await _errorSub?.cancel();
    _completeSub = null;
    _errorSub = null;
    _initialized = false;
    _adapter.dispose();
    _listeners.clear();
  }
}
