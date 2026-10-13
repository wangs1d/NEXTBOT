import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart" show defaultTargetPlatform, kIsWeb;
import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";
import "package:video_player/video_player.dart";

import "../../core/config/api_config.dart";
import "../../core/services/video_preview_launcher.dart";
import "media_disk_cache.dart";

/// 视频媒体数据模型（对应后端 [VIDEO_MEDIA_START] 标记中的 JSON）。
class VideoMediaData {
  const VideoMediaData({
    required this.mediaType,
    required this.mediaUrl,
    this.thumbnailUrl,
    this.pageUrl,
    this.title,
    this.author,
    this.durationSeconds,
    this.notes = const <String>[],
  });

  final String mediaType;
  final String mediaUrl;
  final String? thumbnailUrl;
  final String? pageUrl;
  final String? title;
  final String? author;
  final num? durationSeconds;
  final List<String> notes;

  factory VideoMediaData.fromJson(Map<String, dynamic> json) {
    return VideoMediaData(
      mediaType: json["mediaType"]?.toString() ?? "video",
      mediaUrl: json["mediaUrl"]?.toString() ?? "",
      thumbnailUrl: json["thumbnailUrl"]?.toString(),
      pageUrl: json["pageUrl"]?.toString(),
      title: json["title"]?.toString(),
      author: json["author"]?.toString(),
      durationSeconds: json["durationSeconds"] is num
          ? json["durationSeconds"] as num
          : null,
      notes: json["notes"] is List
          ? (json["notes"] as List).map((Object? e) => e?.toString() ?? "").where((String s) => s.trim().isNotEmpty).toList()
          : const <String>[],
    );
  }
}

/// 从文本中解析第一个 [VIDEO_MEDIA_START]...END 块。
/// 解析成功返回数据与剥离该块后的剩余文本；无匹配返回 null。
({VideoMediaData? media, String cleaned}) parseVideoMediaBlock(String text) {
  const String start = "[VIDEO_MEDIA_START]";
  const String end = "[VIDEO_MEDIA_END]";
  final int startIdx = text.indexOf(start);
  if (startIdx < 0) {
    return (media: null, cleaned: text);
  }
  final int endIdx = text.indexOf(end, startIdx);
  final String cleaned = text.replaceFirst(
    RegExp(RegExp.escape(start) + r"[\s\S]*?" + RegExp.escape(end)),
    "",
  ).replaceAll(RegExp(r"\n{3,}"), "\n\n").trim();

  if (endIdx <= startIdx) {
    return (media: null, cleaned: cleaned);
  }
  final String jsonStr = text
      .substring(startIdx + start.length, endIdx)
      .trim();
  if (jsonStr.isEmpty) return (media: null, cleaned: cleaned);
  try {
    final dynamic decoded = jsonDecode(jsonStr);
    if (decoded is Map<String, dynamic>) {
      final VideoMediaData media = VideoMediaData.fromJson(decoded);
      if (media.mediaUrl.trim().isEmpty) {
        return (media: null, cleaned: cleaned);
      }
      return (media: media, cleaned: cleaned);
    }
  } catch (_) {
    // JSON 解析失败：仅剥离标记，不展示播放器
  }
  return (media: null, cleaned: cleaned);
}

/// 内联视频播放器：
///   - 优先 video_player 内联播放（Android / iOS / Web）
///   - Windows 桌面无 video_player 原生实现，点击后自动用系统默认播放器
///     打开真实视频流（url_launcher），保证「能真实播放」而不只是死链接
///   - 封面、播放地址均为后端代理地址（经 /agent/media/proxy 避免跨域/防盗链）
class AgentInlineVideoPlayer extends StatefulWidget {
  const AgentInlineVideoPlayer({
    super.key,
    required this.data,
    this.maxWidth = 320,
  });

  final VideoMediaData data;
  final double maxWidth;

  @override
  State<AgentInlineVideoPlayer> createState() => _AgentInlineVideoPlayerState();
}

class _AgentInlineVideoPlayerState extends State<AgentInlineVideoPlayer> {
  VideoPlayerController? _controller;
  Future<void>? _initFuture;
  bool _playing = false;
  bool _failed = false;
  String? _errorText;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  Timer? _progressTimer;

  String get _mediaUrl => _resolveMediaUrl(widget.data.mediaUrl);
  String? get _thumbnailUrl => widget.data.thumbnailUrl == null
      ? null
      : _resolveMediaUrl(widget.data.thumbnailUrl!);
  String? get _pageUrl => widget.data.pageUrl;

  @override
  void dispose() {
    _progressTimer?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  /// Windows 桌面：video_player 无原生实现，打开右侧双栏视频面板
  /// （WebView2 承载 HTML5 <video>，应用内真内联播放）。
  bool get _shouldUseSystemPlayer =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  void _openPanelPlayer() {
    VideoPreviewLauncher.open(
      url: _mediaUrl,
      pageUrl: _pageUrl,
    );
  }

  void _startPlayback() async {
    if (_playing || _initFuture != null) return;
    if (_shouldUseSystemPlayer) {
      _openPanelPlayer();
      return;
    }
    final VideoPlayerController controller =
        VideoPlayerController.networkUrl(Uri.parse(_mediaUrl));
    _controller = controller;
    setState(() {
      _initFuture = controller.initialize();
      _failed = false;
    });
    try {
      await _initFuture;
      if (!mounted) return;
      controller.play();
      setState(() {
        _playing = true;
        _duration = controller.value.duration;
      });
      _progressTimer?.cancel();
      _progressTimer = Timer.periodic(const Duration(milliseconds: 300), (_) {
        if (!mounted || !controller.value.isInitialized) return;
        setState(() {
          _position = controller.value.position;
          _duration = controller.value.duration;
        });
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _failed = true;
        _errorText = "内联播放不可用（$e）";
      });
    }
  }

  void _togglePlay() {
    final VideoPlayerController? c = _controller;
    if (c == null || !c.value.isInitialized) return;
    if (c.value.isPlaying) {
      c.pause();
    } else {
      c.play();
    }
    setState(() => _playing = c.value.isPlaying);
  }

  void _showFullscreen() {
    // Windows 桌面：video_player 无原生实现，交给右侧视频面板
    if (_shouldUseSystemPlayer) {
      _openPanelPlayer();
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _FullscreenVideoPage(data: widget.data),
      ),
    );
  }

  String _formatDuration(Duration d) {
    final int total = d.inSeconds;
    if (total <= 0) return "00:00";
    final int h = total ~/ 3600;
    final int m = (total % 3600) ~/ 60;
    final int s = total % 60;
    String two(int v) => v.toString().padLeft(2, "0");
    return h > 0 ? "$h:${two(m)}:${two(s)}" : "${two(m)}:${two(s)}";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final VideoPlayerController? c = _controller;

    final Widget player;
    if (c != null && c.value.isInitialized) {
      player = Stack(
        fit: StackFit.expand,
        children: <Widget>[
          GestureDetector(
            onTap: _togglePlay,
            child: Center(
              child: AspectRatio(
                aspectRatio: c.value.aspectRatio,
                child: VideoPlayer(c),
              ),
            ),
          ),
          // 播放/暂停控制条
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              color: Colors.black.withValues(alpha: 0.55),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                children: <Widget>[
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    iconSize: 20,
                    color: Colors.white,
                    onPressed: _togglePlay,
                    icon: Icon(
                      c.value.isPlaying
                          ? Icons.pause_rounded
                          : Icons.play_arrow_rounded,
                    ),
                  ),
                  Expanded(
                    child: VideoProgressIndicator(
                      c,
                      allowScrubbing: true,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      colors: VideoProgressColors(
                        playedColor: cs.primary,
                        bufferedColor: Colors.white38,
                        backgroundColor: Colors.white24,
                      ),
                    ),
                  ),
                  Text(
                    "${_formatDuration(_position)} / ${_formatDuration(_duration)}",
                    style: const TextStyle(color: Colors.white, fontSize: 11),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    iconSize: 18,
                    color: Colors.white70,
                    onPressed: _showFullscreen,
                    icon: const Icon(Icons.fullscreen_rounded),
                  ),
                  if (_pageUrl != null)
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      iconSize: 18,
                      color: Colors.white70,
                      onPressed: () => _launchUrl(_pageUrl!),
                      icon: const Icon(Icons.open_in_new_rounded),
                    ),
                ],
              ),
            ),
          ),
        ],
      );
    } else {
      // 封面 + 播放按钮
      final String? thumb = _thumbnailUrl;
      player = InkWell(
        onTap: _startPlayback,
        borderRadius: BorderRadius.circular(10),
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: thumb != null
                  ? CachedMediaImage(
                      url: thumb,
                      width: widget.maxWidth,
                      height: 178,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => _VideoThumbPlaceholder(
                        icon: Icons.videocam_outlined,
                        color: cs.surfaceContainerHighest,
                        foreground: cs.onSurfaceVariant,
                      ),
                      loadingBuilder: (BuildContext context) =>
                          _VideoThumbPlaceholder(
                        icon: Icons.videocam_outlined,
                        color: cs.surfaceContainerHighest,
                        foreground: cs.onSurfaceVariant,
                        showSpinner: true,
                      ),
                    )
                  : _VideoThumbPlaceholder(
                      icon: Icons.videocam_outlined,
                      color: cs.surfaceContainerHighest,
                      foreground: cs.onSurfaceVariant,
                    ),
            ),
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.45),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.play_arrow_rounded,
                color: Colors.white,
                size: 34,
              ),
            ),
            if (widget.data.durationSeconds != null &&
                widget.data.durationSeconds! > 0)
              Positioned(
                right: 8,
                bottom: 8,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    _formatDuration(
                      Duration(seconds: widget.data.durationSeconds!.toInt()),
                    ),
                    style: const TextStyle(color: Colors.white, fontSize: 11),
                  ),
                ),
              ),
          ],
        ),
      );
    }

    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: widget.maxWidth),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 标题 / 作者
          if ((widget.data.title?.trim().isNotEmpty ?? false) ||
              (widget.data.author?.trim().isNotEmpty ?? false))
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (widget.data.title?.trim().isNotEmpty ?? false)
                    Text(
                      widget.data.title!.trim(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                        height: 1.35,
                      ),
                    ),
                  if (widget.data.author?.trim().isNotEmpty ?? false)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        widget.data.author!.trim(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: cs.onSurfaceVariant,
                          height: 1.3,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: AspectRatio(aspectRatio: 16 / 9, child: player),
          ),
          if (_failed)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: <Widget>[
                  Icon(Icons.error_outline, size: 14, color: cs.error),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _errorText ?? "内联播放失败",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: cs.error),
                    ),
                  ),
                  if (_pageUrl != null)
                    TextButton(
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                      onPressed: () => _launchUrl(_pageUrl!),
                      child: const Text("去原链接"),
                    )
                  else
                    TextButton(
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                      onPressed: () => _launchUrl(_mediaUrl),
                      child: const Text("浏览器打开"),
                    ),
                ],
              ),
            ),
          if (_shouldUseSystemPlayer)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                "点击将在右侧面板中播放",
                style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }
}

class _VideoThumbPlaceholder extends StatelessWidget {
  const _VideoThumbPlaceholder({
    required this.icon,
    required this.color,
    required this.foreground,
    this.showSpinner = false,
  });

  final IconData icon;
  final Color color;
  final Color foreground;
  final bool showSpinner;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 320,
      height: 178,
      color: color,
      alignment: Alignment.center,
      child: showSpinner
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(icon, color: foreground, size: 34),
    );
  }
}

/// 全屏视频页：内联播放器的放大版。
class _FullscreenVideoPage extends StatefulWidget {
  const _FullscreenVideoPage({required this.data});

  final VideoMediaData data;

  @override
  State<_FullscreenVideoPage> createState() => _FullscreenVideoPageState();
}

class _FullscreenVideoPageState extends State<_FullscreenVideoPage> {
  VideoPlayerController? _controller;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final String url = _resolveMediaUrl(widget.data.mediaUrl);
    final VideoPlayerController controller =
        VideoPlayerController.networkUrl(Uri.parse(url));
    _controller = controller;
    try {
      await controller.initialize();
      await controller.play();
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final VideoPlayerController? c = _controller;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          widget.data.title?.trim().isNotEmpty ?? false
              ? widget.data.title!.trim()
              : "视频",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: <Widget>[
          if (widget.data.pageUrl != null)
            IconButton(
              tooltip: "打开原链接",
              icon: const Icon(Icons.open_in_new_rounded),
              onPressed: () => _launchUrl(widget.data.pageUrl!),
            ),
        ],
      ),
      body: Center(
        child: _failed
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(Icons.error_outline, color: cs.error, size: 40),
                  const SizedBox(height: 12),
                  const Text("视频加载失败", style: TextStyle(color: Colors.white70)),
                  const SizedBox(height: 8),
                  if (widget.data.pageUrl != null)
                    TextButton(
                      onPressed: () => _launchUrl(widget.data.pageUrl!),
                      child: const Text("去原链接播放"),
                    ),
                ],
              )
            : (c != null && c.value.isInitialized)
                ? GestureDetector(
                    onTap: () {
                      if (c.value.isPlaying) {
                        c.pause();
                      } else {
                        c.play();
                      }
                      setState(() {});
                    },
                    child: Center(
                      child: AspectRatio(
                        aspectRatio: c.value.aspectRatio,
                        child: Stack(
                          fit: StackFit.expand,
                          children: <Widget>[
                            VideoPlayer(c),
                            if (!c.value.isPlaying)
                              const Center(
                                child: Icon(
                                  Icons.play_circle_outline_rounded,
                                  color: Colors.white,
                                  size: 64,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  )
                : const CircularProgressIndicator(),
      ),
    );
  }
}

/// 解析媒体 URL：相对地址（/agent/...）拼上后端 base。
String _resolveMediaUrl(String url) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  final String base = ApiConfig.httpBase;
  if (url.startsWith("/")) return "$base$url";
  return "$base/$url";
}

Future<void> _launchUrl(String url) async {
  final Uri? uri = Uri.tryParse(url);
  if (uri == null) return;
  try {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    // 忽略打开失败
  }
}
