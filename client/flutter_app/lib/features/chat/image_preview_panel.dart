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

/// 手机端全屏图片查看页：窄屏（< kWideLayoutBreakpoint）没有右侧双栏，
/// 媒体卡点击后直接推全屏路由，复用 [ImagePreviewPanel] 的大图/切换能力。
///
/// 用法见 [showImagePreviewFullScreen]。
Future<void> showImagePreviewFullScreen(
  BuildContext context, {
  required List<String> urls,
  int index = 0,
  String? source,
}) {
  return Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (BuildContext context) => _ImagePreviewFullScreenPage(
        urls: urls,
        index: index,
        source: source,
      ),
    ),
  );
}

class _ImagePreviewFullScreenPage extends StatelessWidget {
  const _ImagePreviewFullScreenPage({
    required this.urls,
    required this.index,
    this.source,
  });

  final List<String> urls;
  final int index;
  final String? source;

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
          source?.trim().isNotEmpty == true ? source!.trim() : "图片预览",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      body: GestureDetector(
        // 点击图片区（含白色留白）任意处退出全屏；导航按钮/缩放手势
        // 在手势竞技场中优先级更高（更深层），不会误触退出。
        behavior: HitTestBehavior.translucent,
        onTap: () => Navigator.of(context).pop(),
        child: ImagePreviewPanel(
          urls: urls,
          index: index,
          showSidebar: false,
        ),
      ),
    );
  }
}
