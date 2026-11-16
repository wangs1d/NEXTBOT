import "dart:async";
import "dart:collection";
import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart" as crypto;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../../core/config/media_url.dart";
import "../../core/services/nb_http.dart";

/// 聊天媒体磁盘缓存（2026-10-12 预缓存根治）。
///
/// 根因：服务端早已把搜图落盘为 `/agent/images/*.png` 并随 `chat.assistant_done`
/// 持久化进手机本地历史（Isar），但客户端全部用裸 `Image.network` 加载——
/// Flutter 引擎只有**内存**缓存（进程重启即空），服务端下发的
/// `Cache-Control: immutable` 也被无视 → 每次冷启动历史照片逐张重新下载，
/// 出现「重开后要缓存一段时间才能展示」。
///
/// 本模块把媒体字节按 `sha256(url)` 落盘到应用支持目录 `media_cache/`：
///   - 命中 → [CachedMediaImage] 直接 FileImage 秒解，零网络；
///   - 未命中 → 下载落盘，失败回退网络直连，不影响展示；
///   - 双通道（2026-11-12）：前台渲染 6 路 / 后台预取 2 路，预取永不挤占
///     屏上正在等的图（此前共用 4 路，预取一开就变成「图一张张慢慢浮出来」）；
///   - 容量封顶 [maxCacheBytes]，超限按最久未访问淘汰（LRU）；
///   - [warm] 供启动期/历史恢复后并发预热（命中磁盘即秒出）。
class MediaDiskCache {
  MediaDiskCache._();
  static final MediaDiskCache instance = MediaDiskCache._();

  /// 磁盘缓存总容量上限（与服务端图片 30 天 immutable 头对齐量级）。
  static const int maxCacheBytes = 300 * 1024 * 1024;

  /// 前台（屏幕正在渲染的图）并发上限：给足通道，滚到即出。
  static const int _foregroundLane = 6;

  /// 后台预取并发上限：显式压低，保证预取不会把前台通道挤住。
  // 2026-11-13 预取通道 2 → 4：预取对象是几十 KB 级 webp 缩略图，2 路时
  // 一轮 120 张的预热要串行好几拨——用户中途进资料库还是「图一张张浮出来」。
  // 4 路后整轮时间减半，且仍远小于前台 6 路，屏上图不被挤。
  static const int _prefetchLane = 4;

  static const Duration _downloadTimeout = Duration(seconds: 20);

  /// 单测辅助：清空磁盘缓存。
  ///
  /// 缓存跨测试用例共享同一个目录——「先 200 落盘、后 404 验回退」这类用例
  /// 会因前一条留下的文件直接命中而永远走不到失败分支。
  @visibleForTesting
  Future<void> clearForTest() async {
    _resolved.clear();
    final Directory? dir = await _ensureDir();
    if (dir == null) return;
    try {
      for (final FileSystemEntity e in dir.listSync()) {
        if (e is File) await e.delete();
      }
    } catch (e) {
      debugPrint("[MediaDiskCache] 测试清缓存失败(忽略): $e");
    }
  }

  /// 单测注入点：替换真实取字节（默认 NbHttp）。
  ///
  /// 存在的理由：图片字节现在统一经磁盘缓存层下载，widget 测试里既不能靠
  /// `debugNetworkImageHttpClientProvider`（那只管 NetworkImage），也不该让
  /// 测试真等一次 20s 超时。返回的 response 走与线上完全相同的落盘/回退链路。
  @visibleForTesting
  static Future<http.Response> Function(Uri uri, Map<String, String>? headers)?
      debugFetch;

  Directory? _cacheDir;
  Future<Directory?>? _dirFuture;
  final Map<String, Future<File?>> _inFlight = <String, Future<File?>>{};
  // 会话内已解析成功的「稳定 URL → 缓存文件」内存表：[peekFile] 靠它让
  // 新挂载的 [CachedMediaImage] 首帧直接出图（翻页/重建不再闪占位帧）。
  final Map<String, File> _resolved = <String, File>{};
  final _Lane _foreground = _Lane(_foregroundLane);
  final _Lane _prefetch = _Lane(_prefetchLane);
  bool _evicting = false;

  /// 同步查询该 URL 的本地缓存文件（会话内解析成功过即命中）。
  ///
  /// 存在的意义：[CachedMediaImage] 的 FutureBuilder 无论磁盘命中多快，
  /// 都要先经历一帧 `waiting`（占位/空白）——翻页提交、列表重建时新建的
  /// 图片 state 因此必闪一帧。这里同步返回已解析文件，state 以「有数据」
  /// 起步，首帧就是真图。文件可能已被 LRU 淘汰，命中后仍校验存在性。
  File? peekFile(String url) {
    final String trimmed = url.trim();
    if (trimmed.isEmpty ||
        !(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) {
      return null;
    }
    final File? file = _resolved[_stableOf(trimmed)];
    if (file == null) return null;
    try {
      if (file.existsSync() && file.lengthSync() > 0) return file;
    } catch (_) {}
    _resolved.remove(_stableOf(trimmed));
    return null;
  }

  /// 缓存键里一律剔除的「易变凭证参数」。
  ///
  /// token 有 TTL，`needsRefresh` 每轮续期都会换新值；一旦它进了缓存键，
  /// 换 token 就等于把 300MB 缓存整库作废——用户看到的是"照片又要重新加载一遍"。
  /// 这里做键归一是最后一道保险：即便某条调用链仍把 token 塞进了 URL，
  /// 同一张图在 token 轮换前后也命中同一个文件。
  static const Set<String> _volatileParams = <String>{
    "token",
    "access_token",
    "nb_token",
    "auth",
    // 未登录设备走 `?userId=inst_…`；它只证明身份、不选择内容。
    // 一并剔除 → 未登录时的缓存与登录后同一个桶，登录/换 token 都不重下。
    "userId",
  };

  /// URL → 缓存文件名（内容无关的稳定键；同 URL 恒同一文件）。
  String keyFor(String url) => crypto.sha256
      .convert(const Utf8Encoder().convert(_stableOf(url)))
      .toString();

  /// 去掉易变凭证参数后的稳定形态（无此类参数时原样返回，零开销）。
  static String _stableOf(String url) {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null || uri.queryParameters.isEmpty) return url;
    if (!uri.queryParameters.keys.any(_volatileParams.contains)) return url;
    final Map<String, String> kept = <String, String>{
      for (final MapEntry<String, String> e in uri.queryParameters.entries)
        if (!_volatileParams.contains(e.key)) e.key: e.value,
    };
    return Uri(
      scheme: uri.scheme,
      userInfo: uri.userInfo.isEmpty ? null : uri.userInfo,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: uri.path,
      queryParameters: kept.isEmpty ? null : kept,
    ).toString();
  }

  Future<Directory?> _ensureDir() {
    return _dirFuture ??= () async {
      try {
        // 2026-11-12 改存应用支持目录：原 getTemporaryDirectory() 在 Android
        // 映射到 cacheDir，系统低存储时会被整目录清掉 / 换包安装也不保证保留，
        // 冷启动又得全量重下（「每次打开照片都要重新转一会」的直接原因之一）。
        // 支持目录只在卸载时清除，语义与「媒体加速缓存」一致。
        final Directory base = await getApplicationSupportDirectory();
        final Directory dir = Directory(
          "${base.path}${Platform.pathSeparator}media_cache",
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
  ///
  /// 走**前台通道**：屏幕正在等这张图，不能被后台预取排队拖住。
  ///
  /// 顺带承担「发不出请求头的播放器」的取字节职责（2026-11-12）：音视频播放器
  /// 自己发不了 `Authorization` 头，过去只能靠 URL 里带 `?token=`；现在先经这里
  /// 用 NbHttp（带头、401 续期重放）落盘，播放器播本地文件即可，URL 不必再带凭证。
  ///
  /// [extraHeaders] 供调用方补充 UA 等（外部 CDN 对非浏览器 UA 会 403）。
  /// [timeout] 大文件（音频）可比图片放宽，默认 20s。
  Future<File?> fileFor(
    String url, {
    Map<String, String>? extraHeaders,
    Duration? timeout,
  }) =>
      _fileFor(
        url,
        prefetch: false,
        extraHeaders: extraHeaders,
        timeout: timeout,
      );

  Future<File?> _fileFor(
    String url, {
    required bool prefetch,
    Map<String, String>? extraHeaders,
    Duration? timeout,
  }) {
    final String trimmed = url.trim();
    if (trimmed.isEmpty ||
        !(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) {
      return Future<File?>.value(null);
    }
    // 用稳定键去重：仅差一个 ?token= 的两个地址是同一张图，没必要下两遍
    // （并发落盘还会互踩同一个 .part 文件）。
    final String stable = _stableOf(trimmed);
    final Future<File?>? running = _inFlight[stable];
    if (running != null) return running;
    final Future<File?> fut = _fileForInner(
      trimmed,
      prefetch: prefetch,
      extraHeaders: extraHeaders,
      timeout: timeout,
    );
    _inFlight[stable] = fut;
    return fut.whenComplete(() => _inFlight.remove(stable));
  }

  Future<File?> _fileForInner(
    String url, {
    required bool prefetch,
    Map<String, String>? extraHeaders,
    Duration? timeout,
  }) async {
    final Directory? dir = await _ensureDir();
    if (dir == null) return null;
    final File target = File("${dir.path}${Platform.pathSeparator}${keyFor(url)}");
    try {
      if (target.existsSync() && target.lengthSync() > 0) {
        // 触摸访问时间供 LRU 淘汰（失败不影响返回）。
        unawaited(
          target.setLastModified(DateTime.now()).catchError((_) => target),
        );
        _resolved[_stableOf(url)] = target;
        return target;
      }
    } catch (_) {}
    return _download(
      url,
      target,
      prefetch: prefetch,
      extraHeaders: extraHeaders,
      timeout: timeout,
    );
  }

  Future<File?> _download(
    String url,
    File target, {
    required bool prefetch,
    Map<String, String>? extraHeaders,
    Duration? timeout,
  }) async {
    final _Lane lane = prefetch ? _prefetch : _foreground;
    await lane.acquire();
    try {
      // 走统一出口：同源媒体带设备凭证，401/403 时静默续期后重放一次。
      // 裸 http.get 只有「当时的」凭证，token 过期后历史照片会整片加载不出。
      final Uri uri = Uri.parse(url);
      final Future<http.Response> Function(Uri, Map<String, String>?) fetch =
          debugFetch ??
              (Uri u, Map<String, String>? h) => NbHttp.get(u, headers: h);
      final http.Response resp = await fetch(uri, extraHeaders)
          .timeout(timeout ?? _downloadTimeout);
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
      _resolved[_stableOf(url)] = target;
      return target;
    } catch (e) {
      debugPrint("[MediaDiskCache] 下载失败(回退网络直连): $e");
      return null;
    } finally {
      lane.release();
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

  /// 预热一批媒体 URL（冷启动/启动期调用）：落盘后 [CachedMediaImage]
  /// 渲染即秒解。走**后台通道**（4 路），永远不会把前台渲染的图挤到队尾——
  /// 这正是「预取一开，屏上的图反而一张张慢慢浮出来」的根因。
  void warm(Iterable<String> urls) {
    final Set<String> seen = <String>{};
    for (final String raw in urls) {
      final String url = raw.trim();
      if (url.isEmpty || !seen.add(url)) continue;
      unawaited(_fileFor(url, prefetch: true));
    }
  }
}

/// 下载通道：前台（屏幕上真在等）与后台（预取）各一条，
/// 前台拿满 6 路，预取最多 4 路，互不抢占。
class _Lane {
  _Lane(this.limit);

  final int limit;
  int _active = 0;
  final Queue<Completer<void>> _waiters = Queue<Completer<void>>();

  Future<void> acquire() async {
    if (_active < limit) {
      _active += 1;
      return;
    }
    final Completer<void> waiter = Completer<void>();
    _waiters.add(waiter);
    await waiter.future; // 槽位由 release 直接移交，计数不变
  }

  void release() {
    if (_waiters.isNotEmpty) {
      _waiters.removeFirst().complete();
    } else if (_active > 0) {
      _active -= 1;
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
    this.cacheWidth,
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

  /// 解码宽度（物理像素）。缩略图窗按显示宽度的 3~4 倍解码，既清晰又不
  /// 把 4000px 原图整张塞进内存。
  final int? cacheWidth;
  final bool gaplessPlayback;
  final WidgetBuilder? loadingBuilder;
  final Widget Function(BuildContext, Object error, StackTrace?)? errorBuilder;

  @override
  State<CachedMediaImage> createState() => _CachedMediaImageState();
}

class _CachedMediaImageState extends State<CachedMediaImage> {
  late Future<File?> _fileFuture;
  // 内存表命中的已解析文件：FutureBuilder 以「有数据」起步，首帧直接出图，
  // 翻页提交/列表重建时不再闪一帧占位。
  File? _initialFile;

  @override
  void initState() {
    super.initState();
    _initialFile = MediaDiskCache.instance.peekFile(widget.url);
    _fileFuture = MediaDiskCache.instance.fileFor(widget.url);
  }

  @override
  void didUpdateWidget(covariant CachedMediaImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _initialFile = MediaDiskCache.instance.peekFile(widget.url);
      _fileFuture = MediaDiskCache.instance.fileFor(widget.url);
    }
  }

  Image _networkImage({required bool withLoading}) {
    return Image.network(
      widget.url,
      // 直连回退同样要带凭证：周界鉴权开启后无 token 的图片只会拿到 401
      headers: MediaUrl.headersFor(widget.url),
      fit: widget.fit,
      width: widget.width,
      height: widget.height,
      alignment: widget.alignment,
      filterQuality: widget.filterQuality ?? FilterQuality.medium,
      cacheWidth: widget.cacheWidth,
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
      initialData: _initialFile,
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
            cacheWidth: widget.cacheWidth,
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
