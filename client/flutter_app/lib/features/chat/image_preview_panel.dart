import "dart:typed_data";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
// import "../../core/services/image_preview_launcher.dart";
// （图库入口暂时隐藏：恢复「在照片墙中查看」按钮时需一并恢复本 import）
import "media_disk_cache.dart";

/// 图片预览面板左侧预留的空白侧栏宽度（仅占位留白，为后续侧边栏内容预留位置）。
const double kImagePreviewSidebarWidth = 56.0;

/// 右侧双栏的「图片预览」面板：
/// 在右侧分栏中展示单张网络图片原图（多图时底部保留页码计数）。
///
/// [urls] 为同一绿泡内的全部照片，切换按钮居中叠加在图片两侧，
/// 末张点击「下一张」会回到第一张（循环）；若只有单张则不显示按钮。
/// 顶栏（标题 + 关闭按钮）由主壳的 common 右分栏 header 提供。
class ImagePreviewPanel extends StatefulWidget {
  const ImagePreviewPanel({
    super.key,
    required this.urls,
    required this.index,
    this.source,
    this.showSidebar = true,
  });

  /// 同一绿泡内全部照片（已 resolve 的完整地址列表）。
  final List<String> urls;

  /// 当前要展示的照片位次。
  final int index;

  final String? source;

  /// 是否显示左侧窄栏（桌面右分栏用）。手机全屏页无侧栏，传 false 省出宽度。
  final bool showSidebar;

  @override
  State<ImagePreviewPanel> createState() => _ImagePreviewPanelState();
}

class _ImagePreviewPanelState extends State<ImagePreviewPanel> {
  late int _index;

  int get _count => widget.urls.isEmpty ? 1 : widget.urls.length;

  int _clamp(int i) {
    if (widget.urls.isEmpty) return 0;
    return i.clamp(0, _count - 1);
  }

  @override
  void initState() {
    super.initState();
    _index = _clamp(widget.index);
  }

  @override
  void didUpdateWidget(covariant ImagePreviewPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 从聊天列表重新打开其它照片时，同步到新的位置；
    // 面板内部的上一张/下一张切换不会重建 widget，因此不会触发这里。
    if (widget.urls != oldWidget.urls || widget.index != oldWidget.index) {
      final List<String> oldShown = oldWidget.urls;
      final int oldIdx = oldWidget.urls.isEmpty
          ? 0
          : oldWidget.index.clamp(0, oldWidget.urls.length - 1);
      bool sameTarget = false;
      if (oldShown.isNotEmpty && widget.urls.isNotEmpty) {
        final String oldUrl = oldShown[oldIdx.clamp(0, oldShown.length - 1)];
        sameTarget = oldUrl == widget.urls[_clamp(widget.index)];
      }
      if (!sameTarget) {
        _index = _clamp(widget.index);
      }
    }
  }

  bool get _canNav => _count > 1;

  // ── 手势（2026-11-04 手机端）：左右滑屏切图 ──
  // 用 Listener 收原始指针事件（不进竞技场，避免被 InteractiveViewer 的
  // 平移手势抢走）；位移阈值判定，导航按钮的纯点击不会误触。
  Offset? _swipeOrigin;

  /// 当前变换（读取缩放系数：放大状态下平移图片不触发切图）。
  final TransformationController _transform = TransformationController();

  void _handleSwipeStart(PointerDownEvent e) => _swipeOrigin = e.position;

  void _handleSwipeEnd(PointerUpEvent e) {
    final Offset? origin = _swipeOrigin;
    _swipeOrigin = null;
    if (origin == null) return;
    final Offset delta = e.position - origin;
    if (delta.dy.abs() > 80) return;
    // 放大状态（scale > 1）下横向拖动是平移大图，不切图
    if (_transform.value.getMaxScaleOnAxis() > 1.01) return;
    if (delta.dx > 80) {
      _prev(); // 右滑 = 上一张（与相册方向一致）
    } else if (delta.dx < -80) {
      _next(); // 左滑 = 下一张
    }
  }

  void _prev() {
    if (!_canNav) return;
    _transform.value = Matrix4.identity();
    setState(() => _index = (_index - 1 + _count) % _count);
  }

  void _next() {
    if (!_canNav) return;
    // 循环：末张点击「下一张」回到第一张
    _transform.value = Matrix4.identity();
    setState(() => _index = (_index + 1) % _count);
  }

  @override
  void dispose() {
    _transform.dispose();
    _aspectStream?.removeListener(_aspectListener!);
    super.dispose();
  }

  // ── 页码指示点（抖音式）：贴在照片下沿外一点，常显但低调 ──
  // 需要知道照片实际渲染高度（BoxFit.contain 居中后上下留白对称），
  // 用 ImageStream 拿原图宽高比 + LayoutBuilder 尺寸算出照片下沿位置。
  final Map<String, double> _aspectCache = <String, double>{};
  ImageStream? _aspectStream;
  ImageStreamListener? _aspectListener;
  String? _trackingUrl;
  double? _aspect; // 当前图 width / height

  /// 跟踪当前照片的宽高比（幂等，build 里调用）。
  void _trackAspect() {
    final String url = _resolvedUrl;
    if (_trackingUrl == url) return;
    _trackingUrl = url;
    _aspect = _aspectCache[url];
    _aspectStream?.removeListener(_aspectListener!);
    _aspectListener = null;
    _aspectStream = null;
    if (url.isEmpty || _aspect != null) return;
    // 尺寸从磁盘缓存文件解出（带凭证头、落盘持久）；磁盘层不可用时静默保持
    // 默认点位，不再发起裸网络流请求。
    MediaDiskCache.instance.warm(<String>[url]);
    final String trackingUrl = url;
    MediaDiskCache.instance.fileFor(url).then((file) {
      if (file == null || !mounted || _trackingUrl != trackingUrl) return;
      final ImageStream stream = FileImage(file)
          .resolve(createLocalImageConfiguration(context));
      late final ImageStreamListener listener;
      listener = ImageStreamListener((ImageInfo info, bool _) {
        final double ar = info.image.width / info.image.height;
        _aspectCache[trackingUrl] = ar;
        stream.removeListener(listener);
        if (_trackingUrl == trackingUrl && mounted) {
          setState(() => _aspect = ar);
        }
      });
      _aspectListener = listener;
      _aspectStream = stream;
      stream.addListener(listener);
    });
  }

  /// 页码指示点：每张照片一个小点；紧贴照片下沿外 6px（照片占满高度时
  /// 落在照片底部内沿），当前张纯白提亮，其余半透明白。带淡黑投影，
  /// 白色留白背景下也能看见（只不那么明显）。
  Widget _buildDots(BoxConstraints c) {
    if (_count <= 1) return const SizedBox.shrink();
    double bottom = 8;
    final double? ar = _aspect;
    if (ar != null && ar > 0) {
      final double containH = c.maxWidth / ar;
      if (containH < c.maxHeight) {
        // 竖向有留白：照片下沿距底部 gap/2，点贴在外面 6px
        bottom = (c.maxHeight - containH) / 2 + 6;
      }
    }
    return Positioned(
      left: 0,
      right: 0,
      bottom: bottom,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          for (int i = 0; i < _count; i++)
            Container(
              margin: EdgeInsets.only(left: i == 0 ? 0 : 6),
              width: 6.0,
              height: 6.0,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i == _index
                    ? Colors.white
                    : Colors.white.withValues(alpha: 0.38),
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.25),
                    blurRadius: 2,
                    offset: const Offset(0, 1),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String get _currentUrl {
    if (widget.urls.isEmpty) {
      return "";
    }
    return widget.urls[_index];
  }

  String get _resolvedUrl {
    final String u = _currentUrl.trim();
    if (u.isEmpty) return u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    final String base = ApiConfig.httpBase;
    return u.startsWith("/") ? "$base$u" : "$base/$u";
  }

  /// 当前照片是否为图库资产（/picture/assets/{id}/...）；是则提取照片 id，
  /// 供「在照片墙中查看」入口判断显隐与定位。
  String? get _galleryPhotoId {
    final Match? m =
        RegExp(r"/picture/assets/([A-Za-z0-9_-]+)/").firstMatch(_currentUrl);
    return m?.group(1);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    _trackAspect();
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 左侧窄栏：图库照片时显示「照片墙查看」入口（3D 墙 flyToPhoto），
        // 非图库图源（生成图等）保持纯占位留白；手机全屏页不显示
        if (widget.showSidebar)
          Container(
            width: kImagePreviewSidebarWidth,
            decoration: BoxDecoration(
              color: cs.surface,
              border: Border(
                right: BorderSide(color: cs.outline.withValues(alpha: 0.2)),
              ),
            ),
            child: _galleryPhotoId == null
                ? null
                : Column(
                    children: <Widget>[
                      const SizedBox(height: 10),
                      // 「在照片墙中查看」入口暂时隐藏（图库功能暂不接入）
                      // IconButton(
                      //   tooltip: "在照片墙中查看",
                      //   icon: Icon(
                      //     Icons.view_in_ar_rounded,
                      //     size: 20,
                      //     color: cs.onSurfaceVariant,
                      //   ),
                      //   onPressed: () =>
                      //       ImagePreviewLauncher.onOpenInWall?.call(_galleryPhotoId!),
                      // ),
                    ],
                  ),
          ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 原图主体：等比放大展示，居中，可双击缩小/放大
              Expanded(
                child: Listener(
                  onPointerDown: _handleSwipeStart,
                  onPointerUp: _handleSwipeEnd,
                  child: LayoutBuilder(
                    builder: (BuildContext context, BoxConstraints c) {
                      return Stack(
                        fit: StackFit.expand,
                        children: <Widget>[
                          Container(
                            color: cs.surfaceContainerLow,
                            alignment: Alignment.center,
                            child: InteractiveViewer(
                              key: ValueKey<String>(_currentUrl),
                              transformationController: _transform,
                              minScale: 0.6,
                              maxScale: 6,
                              child: Center(
                                child: CachedMediaImage(
                                  url: _resolvedUrl,
                                  fit: BoxFit.contain,
                                  errorBuilder: (BuildContext context,
                                          Object error, StackTrace? stackTrace) {
                                    return _fallback(cs);
                                  },
                                  loadingBuilder: (BuildContext context) =>
                                      const SizedBox(
                                    width: 36,
                                    height: 36,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2.5),
                                  ),
                                ),
                              ),
                            ),
                          ),
                          _buildDots(c),
                        ],
                      );
                    },
                  ),
                ),
              ),
              // 底部信息条：不再展示标题文案，仅保留多图页码计数与来源
              if (_count > 1 ||
                  (widget.source != null &&
                      widget.source!.trim().isNotEmpty))
                Container(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                  decoration: BoxDecoration(
                    color: cs.surface,
                    border: Border(
                      top:
                          BorderSide(color: cs.outline.withValues(alpha: 0.2)),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      if (widget.source != null &&
                          widget.source!.trim().isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            widget.source!,
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
            ],
          ),
        ),
      ],
    );
  }

  Widget _fallback(ColorScheme cs) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(Icons.broken_image_outlined, size: 48, color: cs.onSurfaceVariant),
        const SizedBox(height: 8),
        Text(
          "图片加载失败",
          style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
        ),
      ],
    );
  }
}

/// 相对地址（/agent/images/... 等）按 httpBase 补全；http(s) 原样返回。
String _resolveMediaUrl(String url) {
  final String u = url.trim();
  if (u.isEmpty ||
      u.startsWith("http://") ||
      u.startsWith("https://")) {
    return u;
  }
  final String base = ApiConfig.httpBase;
  return u.startsWith("/") ? "$base$u" : "$base/$u";
}

/// 图片加载失败的占位（全屏查看页与预览面板共用）。
Widget _brokenImagePlaceholder(BuildContext context) {
  final ColorScheme cs = Theme.of(context).colorScheme;
  return Column(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      Icon(Icons.broken_image_outlined, size: 48, color: cs.onSurfaceVariant),
      const SizedBox(height: 8),
      Text(
        "图片加载失败",
        style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
      ),
    ],
  );
}

/// URL 版全屏图片查看页（跟手分页，相册式）：助手发的媒体卡、资料库照片墙
/// 等一切有 URL 的照片统一入口。多图切换为**跟手分页**：拖动时当前图与邻图
/// 同屏平移（能同时看到前后两张），松手按位移过半 / 横向速度吸附；缩放由
/// InteractiveViewer 承担，放大态下拖动只平移大图、不切图。
Future<void> showImagePreviewFullScreenFromUrls(
  BuildContext context, {
  required List<String> urls,
  int index = 0,
  String? source,
}) {
  final List<String> valid = urls
      .map((String u) => u.trim())
      .where((String u) => u.isNotEmpty)
      .toList(growable: false);
  if (valid.isEmpty) return Future<void>.value();
  return Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (BuildContext context) => _PagedPreviewFullScreenPage(
        pages: <WidgetBuilder>[
          for (final String u in valid)
            (BuildContext pageContext) => Center(
                  child: CachedMediaImage(
                    url: _resolveMediaUrl(u),
                    fit: BoxFit.contain,
                    gaplessPlayback: true,
                    loadingBuilder: (BuildContext context) => const SizedBox(
                      width: 36,
                      height: 36,
                      child:
                          CircularProgressIndicator(strokeWidth: 2.5),
                    ),
                    errorBuilder: (BuildContext context, Object error,
                            StackTrace? stackTrace) =>
                        _brokenImagePlaceholder(context),
                  ),
                ),
        ],
        index: index.clamp(0, valid.length - 1),
        source: source,
      ),
    ),
  );
}

/// 字节版全屏图片查看页：用户气泡里**自己发出的照片**只有内存字节、
/// 没有 URL（服务端不回显用户图），点开后在这里看大图。
///
/// 多图切换为**跟手分页**（2026-11-10，相册式）：拖动时当前图与邻图同屏
/// 平移（能同时看到前后两张），松手按位移过半 / 横向速度吸附。缩放由
/// InteractiveViewer 承担（minScale=1 保证未缩放时它对拖拽零视觉响应，
/// 与分页平移不打架）；放大态下拖动只平移大图、不切图。
Future<void> showImagePreviewFullScreenFromBytes(
  BuildContext context, {
  required List<Uint8List> images,
  int index = 0,
  String? source,
}) {
  final List<Uint8List> valid =
      images.where((Uint8List b) => b.isNotEmpty).toList(growable: false);
  if (valid.isEmpty) return Future<void>.value();
  return Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (BuildContext context) => _PagedPreviewFullScreenPage(
        pages: <WidgetBuilder>[
          for (final Uint8List b in valid)
            (BuildContext pageContext) => Center(
                  child: Image.memory(
                    b,
                    fit: BoxFit.contain,
                    gaplessPlayback: true,
                  ),
                ),
        ],
        index: index.clamp(0, valid.length - 1),
        source: source,
      ),
    ),
  );
}

/// 全屏图片查看页统一实现（URL 版 / 字节版共用）：[pages] 第 i 项返回
/// 第 i 张图的展示 widget。跟手分页拖拽逻辑见 [showImagePreviewFullScreenFromBytes] 注释。
class _PagedPreviewFullScreenPage extends StatefulWidget {
  const _PagedPreviewFullScreenPage({
    required this.pages,
    required this.index,
    this.source,
  });

  final List<WidgetBuilder> pages;
  final int index;
  final String? source;

  @override
  State<_PagedPreviewFullScreenPage> createState() =>
      _PagedPreviewFullScreenPageState();
}

class _PagedPreviewFullScreenPageState
    extends State<_PagedPreviewFullScreenPage>
    with SingleTickerProviderStateMixin {
  late int _index = widget.index;

  // 缩放态（InteractiveViewer）：放大后拖动=平移大图，不参与分页。
  final TransformationController _transform = TransformationController();
  bool _zoomed = false;

  // ── 跟手分页拖拽 ──
  // raw Listener 只观察指针（不进手势竞技场，事件必达）；InteractiveViewer
  // 在 scale=1 时 pan 被钳制为零位移，与这里的平移互不干扰。
  double _dx = 0; // 当前分页位移（<0 露出下一张，>0 露出上一张）
  bool _dragging = false;
  int _pointers = 0;
  int _lastMoveMs = 0;
  double _lastVx = 0; // 最近一次 move 的横向速度（px/s，拖拽判定用）
  double _width = 0;

  late final AnimationController _snap = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 230),
  );
  double _snapFrom = 0;
  double _snapTo = 0;

  @override
  void initState() {
    super.initState();
    _transform.addListener(_onTransformChanged);
    _snap.addListener(() {
      final double t = Curves.easeOutCubic.transform(_snap.value);
      setState(() => _dx = _snapFrom + (_snapTo - _snapFrom) * t);
    });
    _snap.addStatusListener((AnimationStatus status) {
      if (status != AnimationStatus.completed) return;
      final double to = _snapTo;
      _snapFrom = 0;
      _snapTo = 0;
      _snap.value = 0; // listener 把 _dx 归零
      if (_width > 0 && to.abs() >= _width - 1) {
        // 吸附到邻图：提交索引，重置缩放
        final int delta = to < 0 ? 1 : -1;
        _transform.value = Matrix4.identity();
        _zoomed = false;
        setState(() {
          _index = (_index + delta).clamp(0, widget.pages.length - 1);
        });
      }
    });
  }

  void _onTransformChanged() {
    final bool zoomed = _transform.value.getMaxScaleOnAxis() > 1.01;
    if (zoomed == _zoomed) return;
    _zoomed = zoomed;
    if (_zoomed && _dx != 0) {
      // 拖拽途中起手势捏合：分页位移先弹回，让位给大图平移
      _startSnap(0);
    }
  }

  void _startSnap(double target) {
    if (target == _dx) {
      if (_dx != 0) setState(() => _dx = 0);
      return;
    }
    _snapFrom = _dx;
    _snapTo = target;
    _snap.forward(from: 0);
  }

  bool get _canPrev => _index > 0;
  bool get _canNext => _index < widget.pages.length - 1;

  void _onPointerDown(PointerDownEvent e) {
    _pointers += 1;
    if (_pointers > 1 || _zoomed) {
      // 多指（捏合）或已在放大态：不进入分页拖拽，已在拖拽中的先弹回
      _dragging = false;
      if (_dx != 0) _startSnap(0);
      return;
    }
    _snap.stop();
    _dragging = true;
    _lastMoveMs = 0;
    _lastVx = 0;
  }

  void _onPointerMove(PointerMoveEvent e) {
    if (!_dragging || _zoomed || _width <= 0) return;
    final int ms = e.timeStamp.inMilliseconds;
    if (_lastMoveMs > 0) {
      final int dt = ms - _lastMoveMs;
      if (dt >= 8) {
        _lastVx = e.delta.dx / dt * 1000;
      }
    }
    _lastMoveMs = ms;
    // 边界钳制：第一张不往右露、最后一张不往左露
    final double lo = _canNext ? -_width : 0;
    final double hi = _canPrev ? _width : 0;
    setState(() => _dx = (_dx + e.delta.dx).clamp(lo, hi));
  }

  void _onPointerUp(PointerUpEvent e) {
    _pointers = (_pointers - 1).clamp(0, 1 << 30);
    _finishDrag();
  }

  void _onPointerCancel(PointerCancelEvent e) {
    _pointers = (_pointers - 1).clamp(0, 1 << 30);
    _finishDrag(forceBack: true);
  }

  /// 松手吸附：位移过半 或 快速轻扫（|vx|>1000px/s）→ 换图；否则弹回。
  void _finishDrag({bool forceBack = false}) {
    _dragging = false;
    if (_width <= 0) return;
    if (_dx == 0) return;
    final double half = _width / 2;
    bool toNext = false;
    bool toPrev = false;
    if (!forceBack) {
      if (_dx < -half || _lastVx < -1000) {
        toNext = _canNext;
      } else if (_dx > half || _lastVx > 1000) {
        toPrev = _canPrev;
      }
    }
    if (toNext) {
      _startSnap(-_width);
    } else if (toPrev) {
      _startSnap(_width);
    } else {
      _startSnap(0);
    }
  }

  @override
  void dispose() {
    _transform.dispose();
    _snap.dispose();
    super.dispose();
  }

  Widget _neighborPage(int i) => Center(
        child: widget.pages[i](context),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        elevation: 0,
        leading: const CloseButton(color: Colors.white),
        title: Text(
          widget.source?.trim().isNotEmpty == true
              ? widget.source!.trim()
              : "图片预览",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      body: GestureDetector(
        // 点击任意处退出全屏；缩放/拖拽由更深层持有，不会误触退出。
        behavior: HitTestBehavior.translucent,
        onTap: () => Navigator.of(context).pop(),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints c) {
            _width = c.maxWidth;
            return Stack(
              fit: StackFit.expand,
              children: <Widget>[
                Listener(
                  behavior: HitTestBehavior.translucent,
                  onPointerDown: _onPointerDown,
                  onPointerMove: _onPointerMove,
                  onPointerUp: _onPointerUp,
                  onPointerCancel: _onPointerCancel,
                  child: Stack(
                    fit: StackFit.expand,
                    children: <Widget>[
                      // 邻图只在拖拽时挂载（省内存），与当前图同屏平移
                      if (_dx > 0 && _canPrev)
                        Positioned(
                          left: _dx - _width,
                          width: _width,
                          top: 0,
                          bottom: 0,
                          child: _neighborPage(_index - 1),
                        ),
                      Positioned(
                        left: _dx,
                        width: _width,
                        top: 0,
                        bottom: 0,
                        child: InteractiveViewer(
                          key: ValueKey<int>(_index),
                          transformationController: _transform,
                          minScale: 1.0,
                          maxScale: 6,
                          child: Center(
                            child: widget.pages[_index](context),
                          ),
                        ),
                      ),
                      if (_dx < 0 && _canNext)
                        Positioned(
                          left: _dx + _width,
                          width: _width,
                          top: 0,
                          bottom: 0,
                          child: _neighborPage(_index + 1),
                        ),
                    ],
                  ),
                ),
                // 页码指示：多图时贴底部居中，纯白低调
                if (widget.pages.length > 1)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 14,
                    child: IgnorePointer(
                      child: Center(
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.45),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            "${_index + 1} / ${widget.pages.length}",
                            style: const TextStyle(
                              fontSize: 12,
                              color: Colors.white,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
