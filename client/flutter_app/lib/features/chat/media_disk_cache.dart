import "dart:async";
import "dart:collection";
import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart" as crypto;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

/// 聊天媒体磁盘缓存（2026-10-12 预缓存根治）。
///
/// 根因：服务端早已把搜图落盘为 `/agent/images/*.png` 并随 `chat.assistant_done`
/// 持久化进手机本地历史（Isar），但客户端全部用裸 `Image.network` 加载——
/// Flutter 引擎只有**内存**缓存（进程重启即空），服务端下发的
/// `Cache-Control: immutable` 也被无视 → 每次冷启动历史照片逐张重新下载，
/// 出现「重开后要缓存一段时间才能展示」。
///
/// 本模块把媒体字节按 `sha256(url)` 落盘到应用缓存目录 `media_cache/`：
///   - 命中 → [CachedMediaImage] 直接 FileImage 秒解，零网络；
///   - 未命中 → 有界并发（4 路）下载落盘，失败回退网络直连，不影响展示；
///   - 容量封顶 [maxCacheBytes]，超限按最久未访问淘汰（LRU）；
///   - [warm] 供冷启动历史恢复后并发预热（命中磁盘即秒出）。
class MediaDiskCache {
  MediaDiskCache._();
  static final MediaDiskCache instance = MediaDiskCache._();

  /// 磁盘缓存总容量上限（与服务端图片 30 天 immutable 头对齐量级）。
  static const int maxCacheBytes = 300 * 1024 * 1024;

  /// 并发下载上限（与 TravelImageWarmer 的 4 路同量级，避免冷启动挤爆弱网）。
  static const int _maxConcurrentDownloads = 4;

  static const Duration _downloadTimeout = Duration(seconds: 20);

  Directory? _cacheDir;
  Future<Directory?>? _dirFuture;
  final Map<String, Future<File?>> _inFlight = <String, Future<File?>>{};
  final Queue<Completer<void>> _slotWaiters = Queue<Completer<void>>();
  int _activeDownloads = 0;
  bool _evicting = false;

  /// URL → 缓存文件名（内容无关的稳定键；同 URL 恒同一文件）。
  String keyFor(String url) =>
      crypto.sha256.convert(const Utf8Encoder().convert(url)).toString();

  Future<Directory?> _ensureDir() {
    return _dirFuture ??= () async {
      try {
        final Directory tmp = await getTemporaryDirectory();
        final Directory dir = Directory(
          "${tmp.path}${Platform.pathSeparator}media_cache",
        );
        if (!dir.existsSync()) dir.createSync(recursive: true);
        return _cacheDir = dir;
      } catch (e) {
        debugPrint("[MediaDiskCache] 缓存目录不可用(降级网络直连): $e");
        return null;
      }
    }();
  }

  /// 取 URL 对应的本地缓存文件；未命中则下载落盘后返回。
  /// 任何失败返回 null（调用方回退网络直连展示，绝不阻塞 UI）。
  Future<File?> fileFor(String url) {
    final String trimmed = url.trim();
    if (trimmed.isEmpty ||
        !(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) {
      return Future<File?>.value(null);
    }
    final Future<File?>? running = _inFlight[trimmed];
    if (running != null) return running;
    final Future<File?> fut = _fileForInner(trimmed);
    _inFlight[trimmed] = fut;
    return fut.whenComplete(() => _inFlight.remove(trimmed));
  }

  Future<File?> _fileForInner(String url) async {
    final Directory? dir = await _ensureDir();
    if (dir == null) return null;
    final File target = File("${dir.path}${Platform.pathSeparator}${keyFor(url)}");
    try {
      if (target.existsSync() && target.lengthSync() > 0) {
        // 触摸访问时间供 LRU 淘汰（失败不影响返回）。
        unawaited(
          target.setLastModified(DateTime.now()).catchError((_) => target),
        );
        return target;
      }
    } catch (_) {}
    return _download(url, target);
  }

  Future<File?> _download(String url, File target) async {
    await _acquireSlot();
    try {
      final http.Response resp = await http
          .get(Uri.parse(url))
          .timeout(_downloadTimeout);
      if (resp.statusCode != 200 || resp.bodyBytes.isEmpty) return null;
      final File tmp = File("${target.path}.part");
      await tmp.writeAsBytes(resp.bodyBytes, flush: true);
      try {
        await tmp.rename(target.path);
      } catch (_) {
        // 跨盘/占用时 rename 失败 → 复制兜底
        await tmp.copy(target.path);
        try {
          await tmp.delete();
        } catch (_) {}
      }
      unawaited(_evictIfNeeded());
      return target;
    } catch (e) {
      debugPrint("[MediaDiskCache] 下载失败(回退网络直连): $e");
      return null;
    } finally {
      _releaseSlot();
    }
  }

  Future<void> _acquireSlot() async {
    if (_activeDownloads < _maxConcurrentDownloads) {
      _activeDownloads += 1;
      return;
    }
    final Completer<void> waiter = Completer<void>();
    _slotWaiters.add(waiter);
    await waiter.future; // 槽位由 _releaseSlot 直接移交，计数不变
  }

  void _releaseSlot() {
    if (_slotWaiters.isNotEmpty) {
      _slotWaiters.removeFirst().complete();
    } else if (_activeDownloads > 0) {
      _activeDownloads -= 1;
    }
  }

  /// 超容量时按「最久未访问」淘汰到 80%（批量删除，异步不阻塞下载链路）。
  Future<void> _evictIfNeeded() async {
    if (_evicting || _cacheDir == null) return;
    _evicting = true;
    try {
      final List<FileSystemEntity> entries = _cacheDir!.listSync();
      final List<File> files = <File>[
        for (final FileSystemEntity e in entries)
          if (e is File && !e.path.endsWith(".part")) e,
      ];
      int total = 0;
      final List<(File, DateTime)> stamped = <(File, DateTime)>[];
      for (final File f in files) {
        try {
          total += await f.length();
          stamped.add((f, await f.lastModified()));
        } catch (_) {}
      }
      if (total <= maxCacheBytes) return;
      stamped.sort((a, b) => a.$2.compareTo(b.$2)); // 最旧优先
      final int target = (maxCacheBytes * 0.8).floor();
      int removed = 0;
      for (final (File, DateTime) entry in stamped) {
        if (total - removed <= target) break;
        try {
          final int len = await entry.$1.length();
          await entry.$1.delete();
          removed += len;
        } catch (_) {}
      }
    } catch (e) {
      debugPrint("[MediaDiskCache] 淘汰失败(忽略): $e");
    } finally {
      _evicting = false;
    }
  }

  /// 预热一批媒体 URL（冷启动历史恢复后调用）：有界并发落盘，命中后
  /// [CachedMediaImage] 渲染即秒解。全程静默容错。
  void warm(Iterable<String> urls) {
    final Set<String> seen = <String>{};
    for (final String raw in urls) {
      final String url = raw.trim();
      if (url.isEmpty || !seen.add(url)) continue;
      unawaited(fileFor(url));
    }
  }
}

/// 磁盘缓存版网络图片：[Image.network] 的drop-in替换。
///
/// 渲染优先级：磁盘命中 → `Image.file` 秒解；未命中 → 等待下载落盘
/// （走 [loadingBuilder] 占位）；下载失败/缓存不可用 → 回退 [Image.network]
/// 直连（保持既有行为，磁盘层故障不破坏展示）。
class CachedMediaImage extends StatefulWidget {
  const CachedMediaImage({
    super.key,
    required this.url,
    this.fit,
    this.width,
    this.height,
    this.alignment = Alignment.center,
    this.filterQuality,
    this.gaplessPlayback = false,
    this.loadingBuilder,
    this.errorBuilder,
  });

  final String url;
  final BoxFit? fit;
  final double? width;
  final double? height;
  final AlignmentGeometry alignment;
  final FilterQuality? filterQuality;
  final bool gaplessPlayback;
  final WidgetBuilder? loadingBuilder;
  final Widget Function(BuildContext, Object error, StackTrace?)? errorBuilder;

  @override
  State<CachedMediaImage> createState() => _CachedMediaImageState();
}

class _CachedMediaImageState extends State<CachedMediaImage> {
  late Future<File?> _fileFuture;

  @override
  void initState() {
    super.initState();
    _fileFuture = MediaDiskCache.instance.fileFor(widget.url);
  }

  @override
  void didUpdateWidget(covariant CachedMediaImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _fileFuture = MediaDiskCache.instance.fileFor(widget.url);
    }
  }

  Image _networkImage({required bool withLoading}) {
    return Image.network(
      widget.url,
      fit: widget.fit,
      width: widget.width,
      height: widget.height,
      alignment: widget.alignment,
      filterQuality: widget.filterQuality ?? FilterQuality.medium,
      gaplessPlayback: widget.gaplessPlayback,
      loadingBuilder: withLoading
          ? (BuildContext context, Widget child, ImageChunkEvent? progress) {
              if (progress == null) return child;
              return widget.loadingBuilder?.call(context) ?? _defaultLoading();
            }
          : null,
      errorBuilder: widget.errorBuilder != null
          ? (BuildContext context, Object e, StackTrace? s) =>
              widget.errorBuilder!(context, e, s)
          : null,
    );
  }

  Widget _defaultLoading() => const SizedBox.shrink();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<File?>(
      future: _fileFuture,
      builder: (BuildContext context, AsyncSnapshot<File?> snap) {
        final File? file = snap.data;
        if (file != null) {
          return Image.file(
            file,
            fit: widget.fit,
            width: widget.width,
            height: widget.height,
            alignment: widget.alignment,
            filterQuality: widget.filterQuality ?? FilterQuality.medium,
            gaplessPlayback: true,
            errorBuilder: widget.errorBuilder != null
                ? (BuildContext context, Object e, StackTrace? s) =>
                    widget.errorBuilder!(context, e, s)
                : (BuildContext context, Object e, StackTrace? s) =>
                    _networkImage(withLoading: true),
          );
        }
        if (snap.hasError) {
          // 磁盘层故障 → 回退网络直连（既有行为兜底）
          return _networkImage(withLoading: true);
        }
        if (snap.connectionState != ConnectionState.done) {
          // 下载中：有自定义占位用自定义，否则保持加载占位
          return widget.loadingBuilder?.call(context) ?? _defaultLoading();
        }
        // done 且无文件（下载失败/URL 非法）→ 网络直连重试一次
        return _networkImage(withLoading: true);
      },
    );
  }
}
