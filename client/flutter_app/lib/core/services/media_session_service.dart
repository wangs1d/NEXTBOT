import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "soda_lyric_cache.dart";

/// 一条歌词行（时间轴来自网易云 LRC，t 为相对曲目开始的毫秒）。
class MediaLyricLine {
  const MediaLyricLine({
    required this.tMs,
    required this.text,
    this.translation,
  });

  final int tMs;
  final String text;
  final String? translation;
}

/// 本地播放器（Windows SMTC）上报的当前曲目快照。
class NowPlayingMedia {
  const NowPlayingMedia({
    required this.appId,
    required this.title,
    required this.artist,
    required this.album,
    required this.durationSec,
    required this.positionSec,
    required this.playing,
    required this.paused,
    required this.sampledAtMs,
  });

  final String appId;
  final String title;
  final String artist;
  final String album;
  final double durationSec;
  final double positionSec;
  final bool playing;
  final bool paused;
  final int sampledAtMs;

  bool get hasTrack => title.trim().isNotEmpty;

  /// 换歌判定键：任一字段变化都算新曲目。
  String get trackKey =>
      "$appId\u001f$title\u001f$artist\u001f$album\u001f${durationSec.round()}";

  String get displayLine => artist.trim().isEmpty ? title : "$title - $artist";

  /// 按墙钟外推当前进度（原生每 500ms 采样一次，之间靠这里插值）。
  double positionAt(DateTime now) {
    if (!playing) return positionSec;
    final double elapsedMs =
        now.millisecondsSinceEpoch - sampledAtMs.toDouble();
    final double position = positionSec + elapsedMs / 1000.0;
    if (durationSec > 0 && position > durationSec) return durationSec;
    return position < 0 ? 0 : position;
  }
}

/// 本地正在播放的曲目 + 歌词（Windows SMTC → 服务端 /api/media/lyric）。
///
/// 原生侧（windows/runner/media_session_watcher.cpp）按 500ms 采样 SMTC，
/// 经 MethodChannel `pai/media_session` 推 `onMediaSession`；换歌时这里拉一次
/// 歌词，之后逐行高亮由进度插值驱动，不再打网络。
class MediaSessionService {
  MediaSessionService._();

  static final MediaSessionService instance = MediaSessionService._();

  static const MethodChannel _channel = MethodChannel("pai/media_session");

  /// 歌词一次性推给原生岛（播放进度由原生按采样点自行插值，不走这里）。
  static const MethodChannel _islandChannel =
      MethodChannel("pai/dynamic_island");

  final http.Client _client = http.Client();

  bool _started = false;
  NowPlayingMedia? _nowPlaying;
  List<MediaLyricLine> _lyrics = const <MediaLyricLine>[];
  String? _lyricReason;
  String? _lyricTrackKey;
  int _lyricRequestSeq = 0;
  // 最近一次推给原生岛的歌词载荷：岛窗口晚于歌词请求建好时补推一次。
  Map<String, Object?>? _lastLyricPayload;
  DateTime _lastProgressLogAt = DateTime.fromMillisecondsSinceEpoch(0);

  NowPlayingMedia? get nowPlaying => _nowPlaying;
  List<MediaLyricLine> get lyrics => _lyrics;
  String? get lyricReason => _lyricReason;

  Future<void> start() async {
    if (_started || kIsWeb || !Platform.isWindows) return;
    _started = true;
    _channel.setMethodCallHandler(_handleNativeCall);
    try {
      final dynamic snapshot = await _channel.invokeMethod<dynamic>("requestNow");
      final Map<String, dynamic>? map = _asStringMap(snapshot);
      if (map != null) _applySnapshot(map);
    } catch (e) {
      debugPrint("[media-session] requestNow failed: $e");
    }
    debugPrint("[media-session] listening on pai/media_session");
  }

  /// 进度对应的歌词行索引；返回 -1 表示还没到第一行。
  ///
  /// 与 [lyrics] 配套使用：[lyrics] 为空时恒为 -1。
  int currentLineIndex([DateTime? now]) {
    final NowPlayingMedia? track = _nowPlaying;
    if (track == null || _lyrics.isEmpty) return -1;
    final int positionMs = (track.positionAt(now ?? DateTime.now()) * 1000).round();
    int index = -1;
    for (int i = 0; i < _lyrics.length; i++) {
      if (_lyrics[i].tMs <= positionMs) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }

  Future<void> _handleNativeCall(MethodCall call) async {
    if (call.method != "onMediaSession") return;
    final Map<String, dynamic>? map = _asStringMap(call.arguments);
    if (map != null) _applySnapshot(map);
  }

  static Map<String, dynamic>? _asStringMap(dynamic value) {
    if (value is! Map) return null;
    return value.map((key, item) => MapEntry(key.toString(), item));
  }

  void _applySnapshot(Map<String, dynamic> raw) {
    if (raw["hasSession"] != true) {
      _nowPlaying = null;
      return;
    }
    final NowPlayingMedia snapshot = NowPlayingMedia(
      appId: raw["appId"]?.toString() ?? "",
      title: raw["title"]?.toString() ?? "",
      artist: raw["artist"]?.toString() ?? "",
      album: raw["album"]?.toString() ?? "",
      durationSec: (raw["durationSec"] as num?)?.toDouble() ?? 0,
      positionSec: (raw["positionSec"] as num?)?.toDouble() ?? 0,
      playing: raw["playing"] == true,
      paused: raw["paused"] == true,
      sampledAtMs: (raw["sampledAtMs"] as num?)?.toInt() ?? 0,
    );
    if (!snapshot.hasTrack) {
      _nowPlaying = null;
      return;
    }

    final NowPlayingMedia? previous = _nowPlaying;
    _nowPlaying = snapshot;

    if (previous == null || previous.trackKey != snapshot.trackKey) {
      debugPrint(
        "[media-session] track changed: ${snapshot.displayLine}"
        " (${snapshot.durationSec.round()}s, ${snapshot.appId})",
      );
      unawaited(_loadLyrics(snapshot));
      return;
    }

    // 进度心跳：仅播放中按 5s 一条（暂停时位置不动，刷日志没有信息量）
    final DateTime now = DateTime.now();
    if (!snapshot.playing ||
        now.difference(_lastProgressLogAt).inSeconds < 5) {
      return;
    }
    _lastProgressLogAt = now;
    final int lineIndex = currentLineIndex(now);
    final String lineText = lineIndex >= 0 ? _lyrics[lineIndex].text : "（前奏）";
    debugPrint(
      "[media-session] ${snapshot.positionAt(now).toStringAsFixed(1)}s"
      " / ${snapshot.durationSec.toStringAsFixed(0)}s"
      " | line=${lineIndex >= 0 ? lineIndex + 1 : "-"}/${_lyrics.length}"
      " §$lineText",
    );
  }

  Future<void> _loadLyrics(NowPlayingMedia track) async {
    final int requestSeq = ++_lyricRequestSeq;
    _lyricTrackKey = track.trackKey;
    _lyrics = const <MediaLyricLine>[];
    _lyricReason = null;
    _lastLyricPayload = null;

    final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/media/lyric").replace(
      queryParameters: <String, String>{
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.durationSec.round().toString(),
      },
    );

    try {
      final http.Response response =
          await _client.get(uri).timeout(const Duration(seconds: 8));
      if (requestSeq != _lyricRequestSeq) return;

      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
      if (data["matched"] != true) {
        // 服务端词源没有时走汽水本地缓存兜底（汽水独家曲目的词只在本机）。
        final List<MediaLyricLine>? local =
            await SodaLyricCache.instance.resolve(track.title, track.artist);
        if (requestSeq != _lyricRequestSeq) return;
        if (local != null) {
          _lyrics = local;
          _lyricReason = null;
          debugPrint(
            "[media-session] lyric soda-cache: ${local.length} lines"
            " | trackKey=$_lyricTrackKey",
          );
          await _pushIslandLyrics(track.trackKey, _lyrics);
          return;
        }
        _lyricReason = data["reason"]?.toString() ?? "未找到歌词";
        debugPrint("[media-session] lyric miss: $_lyricReason");
        await _pushIslandLyrics(track.trackKey, const <MediaLyricLine>[],
            reason: _lyricReason);
        return;
      }

      final List<dynamic> rawLines = data["lines"] as List<dynamic>? ?? const [];
      _lyrics = rawLines
          .whereType<Map<dynamic, dynamic>>()
          .map((line) => MediaLyricLine(
                tMs: (line["t"] as num?)?.toInt() ?? 0,
                text: line["text"]?.toString() ?? "",
                translation: line["tr"]?.toString(),
              ))
          .toList(growable: false);

      final Map<dynamic, dynamic>? matchedTrack =
          data["track"] is Map ? data["track"] as Map<dynamic, dynamic> : null;
      debugPrint(
        "[media-session] lyric matched: ${matchedTrack?["name"]}"
        " / ${matchedTrack?["artist"]}"
        " | ${_lyrics.length} lines | translated=${data["translated"] == true}"
        " | trackKey=$_lyricTrackKey",
      );
      await _pushIslandLyrics(track.trackKey, _lyrics);
    } catch (e) {
      if (requestSeq != _lyricRequestSeq) return;
      _lyricReason = "歌词请求失败";
      debugPrint("[media-session] lyric request failed: $e");
      await _pushIslandLyrics(
          track.trackKey, const <MediaLyricLine>[], reason: _lyricReason);
    }
  }

  /// 推歌词给原生岛。换歌竞态由原生按 trackKey 再校验一次；
  /// 岛窗口尚未建好时保留载荷，窗口就绪后由 [repushIslandLyrics] 补推。
  Future<void> _pushIslandLyrics(String trackKey, List<MediaLyricLine> lines,
      {String? reason}) async {
    final Map<String, Object?> payload = <String, Object?>{
      "trackKey": trackKey,
      "reason": reason ?? "",
      "lines": <Map<String, Object?>>[
        for (final MediaLyricLine line in lines)
          <String, Object?>{
            "t": line.tMs / 1000.0,
            "text": line.text,
            "tr": line.translation ?? "",
          },
      ],
    };
    _lastLyricPayload = payload;
    try {
      final bool accepted = await _islandChannel
              .invokeMethod<bool>("setMusicLyrics", payload) ??
          false;
      if (!accepted) {
        debugPrint(
            "[media-session] island lyric push deferred (island not ready)");
      }
    } catch (e) {
      debugPrint("[media-session] island lyric push failed: $e");
    }
  }

  /// 岛窗口（重新）建好时补推最近一次歌词：歌词请求通常早于窗口创建，
  /// 只靠换歌触发会让首曲一直只显示歌名。
  Future<void> repushIslandLyrics() async {
    final Map<String, Object?>? payload = _lastLyricPayload;
    if (payload == null) return;
    try {
      await _islandChannel.invokeMethod<bool>("setMusicLyrics", payload);
    } catch (e) {
      debugPrint("[media-session] island lyric repush failed: $e");
    }
  }
}
