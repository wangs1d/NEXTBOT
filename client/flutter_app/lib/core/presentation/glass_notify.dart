import "dart:io" show Directory, File;
import "dart:math" as math;
import "dart:ui" as ui show Image, ImageByteFormat;
import "dart:ui" show ImageFilter;

import "package:flutter/foundation.dart";
import "package:flutter/gestures.dart" show PointerEnterEvent, PointerExitEvent;
import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show RenderRepaintBoundary;
import "package:flutter/scheduler.dart" show SchedulerBinding;

import "../services/client_update_checker.dart";

/// ═══════════════════════════════════════════════════════════════════
/// 玻璃态通知卡（移植自用户定稿的 Meoo 演示页，黑白单色毛玻璃）：
/// - 真实毛玻璃：backdrop blur(28) + saturate(150%)
/// - 玻璃反光：顶部 1px 高光渐变线 + 135° 斜向反光层 + 细噪点
/// - 层叠景深：后卡逐级上移 6px、缩 2.2%、微模糊（0.8px/级，封顶 2.4）
/// - 倒计时进度条：随存活时长收缩，悬停暂停
/// - 入场：blur(6) + 上滑 14px + scale(.94)，460ms easeOutExpo 系曲线
/// - 退场：blur(5) + 上滑 10px + scale(.96)，280ms
///
/// 用法：MaterialApp.builder 包一层 GlassNotifyHost(child: child)，
/// 任意处 GlassNotify.show(...)。组件挂在 navigator 之上，
/// 不遮挡路由、不影响路由外点击（命中区域仅卡片本身）。
/// ═══════════════════════════════════════════════════════════════════

enum GlassNotifyVariant { info, success, warning, error, loading }

/// 关闭原因：action=点了操作按钮，dismissed=点了关闭 ×，
/// expired=倒计时走完，displaced=被更新的通知挤出队列
enum GlassNotifyCloseReason { action, dismissed, expired, displaced }

typedef GlassNotifyCloseCallback = void Function(GlassNotifyCloseReason reason);

class GlassNotifyAction {
  const GlassNotifyAction({
    required this.label,
    required this.onPressed,
    this.emphasized = false,
  });

  final String label;
  final VoidCallback onPressed;

  /// true = 实心胶囊（演示页「立即重启」），false = 描边胶囊（「稍后」）
  final bool emphasized;
}

class GlassNotifyEntry {
  GlassNotifyEntry({
    required this.id,
    required this.title,
    required this.message,
    required this.variant,
    required this.duration,
    required this.showProgress,
    required this.dismissible,
    required this.actions,
    required this.onClose,
  });

  final String id;
  final String title;
  final String message;
  final GlassNotifyVariant variant;

  /// 零时长 = 常驻（不自动关闭、无进度条）
  final Duration duration;
  final bool showProgress;
  final bool dismissible;
  final List<GlassNotifyAction> actions;
  final GlassNotifyCloseCallback? onClose;

  /// 以下字段由 GlassNotify 内部维护
  bool leaving = false;
  GlassNotifyCloseReason closeReason = GlassNotifyCloseReason.expired;
}

class GlassNotify extends ChangeNotifier {
  GlassNotify._();

  static final GlassNotify instance = GlassNotify._();

  /// 同屏上限（演示页 0/4），超出时最旧的非退场卡先退场
  static const int maxVisible = 4;

  // ── 调试自捕获（仅 debug 且显式开启时生效）─────────────────────
  // RepaintBoundary 由 GlassNotifyHost 在 debug 构建下挂在最外层。通知弹出后
  // 直接从渲染树出图存 PNG 到系统临时目录，不依赖屏幕抓取（Flutter 的
  // DComp 窗口用 PrintWindow 只会拍到黑帧）。真机验收时置 true。
  static final GlobalKey debugCaptureKey =
      GlobalKey(debugLabel: "glassNotifyCapture");
  static bool debugSelfCapture = false;
  int _debugCaptureSeq = 0;

  Future<void> _debugSelfCapture(int delayMs) async {
    final BuildContext? ctx = debugCaptureKey.currentContext;
    final RenderRepaintBoundary? boundary =
        ctx?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null || boundary.debugNeedsLayout) return;
    await Future<void>.delayed(Duration(milliseconds: delayMs));
    try {
      final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
      final ByteData? bytes =
          await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      if (bytes == null) return;
      final String path =
          "${Directory.systemTemp.path}\\glass_selfcap_${_debugCaptureSeq++}.png";
      await File(path).writeAsBytes(bytes.buffer.asUint8List());
      debugPrint("[glass-notify] self-capture saved: $path");
    } catch (e) {
      debugPrint("[glass-notify] self-capture failed: $e");
    }
  }

  final List<GlassNotifyEntry> _entries = <GlassNotifyEntry>[];
  int _seq = 0;

  static List<GlassNotifyEntry> get entries =>
      List<GlassNotifyEntry>.unmodifiable(instance._entries);

  /// 返回通知 id，供调用方后续定向 [dismiss]（如加载卡→结果卡的替换）。
  static String show({
    required String title,
    String message = "",
    GlassNotifyVariant variant = GlassNotifyVariant.info,
    Duration duration = const Duration(milliseconds: 4500),
    bool showProgress = true,
    bool dismissible = true,
    List<GlassNotifyAction> actions = const <GlassNotifyAction>[],
    GlassNotifyCloseCallback? onClose,
  }) {
    final GlassNotifyEntry entry = GlassNotifyEntry(
      id: "glass-notify-${instance._seq++}",
      title: title,
      message: message,
      variant: variant,
      duration: duration,
      showProgress: showProgress,
      dismissible: dismissible,
      actions: actions,
      onClose: onClose,
    );
    instance._push(entry);
    return entry.id;
  }

  static void dismiss(String id, GlassNotifyCloseReason reason) {
    instance._beginLeave(id, reason);
  }

  static void clear() {
    for (final GlassNotifyEntry e
        in List<GlassNotifyEntry>.of(instance._entries)) {
      instance._beginLeave(e.id, GlassNotifyCloseReason.displaced);
    }
  }

  void _push(GlassNotifyEntry entry) {
    _entries.insert(0, entry); // 新卡插最前（最上层）
    // 调试自捕获：出图两次（入场完成 + 层叠稳定后）
    if (kDebugMode && debugSelfCapture) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _debugSelfCapture(1400);
        _debugSelfCapture(3200);
      });
    }
    int active = _entries.where((GlassNotifyEntry e) => !e.leaving).length;
    for (int i = _entries.length - 1; i >= 0 && active > maxVisible; i--) {
      final GlassNotifyEntry e = _entries[i];
      if (!e.leaving) {
        e.leaving = true;
        e.closeReason = GlassNotifyCloseReason.displaced;
        active--;
      }
    }
    _notify();
  }

  void _beginLeave(String id, GlassNotifyCloseReason reason) {
    for (final GlassNotifyEntry e in _entries) {
      if (e.id == id && !e.leaving) {
        e.leaving = true;
        e.closeReason = reason;
        _notify();
        return;
      }
    }
  }

  /// 卡片退场动画结束后由卡片回调：真正移除并触发 onClose（此时视觉已消失）
  void finalizeRemove(String id) {
    final int idx = _entries.indexWhere((GlassNotifyEntry e) => e.id == id);
    if (idx < 0) return;
    final GlassNotifyEntry e = _entries.removeAt(idx);
    e.onClose?.call(e.closeReason);
    _notify();
  }

  void _notify() {
    notifyListeners();
  }
}

/// 挂在 MaterialApp.builder 最外层：child（navigator）之下正常渲染，
/// 通知卡片浮于所有路由之上
class GlassNotifyHost extends StatelessWidget {
  const GlassNotifyHost({super.key, required this.child});

  final Widget? child;

  /// 顶部避开自绘标题栏（kWindowTitleBarHeight=40）+ 12
  static const double topInset = 52;
  static const double sideInset = 20;

  @override
  Widget build(BuildContext context) {
    Widget overlay = Stack(
      textDirection: TextDirection.ltr,
      children: <Widget>[
        // 垫底预热：应用内容之下先渲染一块迷你玻璃面，提前编译
        // BackdropFilter/ImageFiltered 着色器，首次弹真卡不掉帧
        const _GlassWarmUp(),
        if (child != null) child!,
        const Positioned(
          top: topInset,
          right: sideInset,
          child: _GlassToastStack(),
        ),
      ],
    );
    // debug 构建下包一层 RepaintBoundary，供调试自捕获出图
    if (kDebugMode) {
      overlay = RepaintBoundary(key: GlassNotify.debugCaptureKey, child: overlay);
    }
    return overlay;
  }
}

// ═══════════════════════════════════════════════════════════════════
/// 玻璃管线预热：启动稳定 1s 后，在应用内容之下（Stack 垫底）渲染 200ms
/// 一块迷你玻璃面（同款 BackdropFilter+渐变滤镜栈），把着色器编译提前到
/// 启动期，用户看到的第一张真卡不再因现场编译掉帧。
// ═══════════════════════════════════════════════════════════════════

class _GlassWarmUp extends StatefulWidget {
  const _GlassWarmUp();

  @override
  State<_GlassWarmUp> createState() => _GlassWarmUpState();
}

class _GlassWarmUpState extends State<_GlassWarmUp> {
  bool _warming = false;

  @override
  void initState() {
    super.initState();
    SchedulerBinding.instance.addPostFrameCallback((_) {
      Future<void>.delayed(const Duration(seconds: 1), () {
        if (!mounted) return;
        setState(() => _warming = true);
        Future<void>.delayed(const Duration(milliseconds: 200), () {
          if (mounted) setState(() => _warming = false);
        });
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_warming) return const SizedBox.shrink();
    // 低透明度+垫底双层保险：即便应用内容有透明区域也几乎不可见
    return Positioned(
      left: 0,
      top: 0,
      child: IgnorePointer(
        child: Opacity(
          opacity: 0.03,
          child: SizedBox(
            width: 120,
            height: 64,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: const Color.fromRGBO(30, 30, 30, 0.55),
                    // 与真卡同款 135° 斜向反光滤镜栈
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      stops: const <double>[0.0, 0.42, 0.62, 1.0],
                      colors: <Color>[
                        Colors.white.withValues(alpha: 0.14),
                        Colors.transparent,
                        Colors.transparent,
                        Colors.black.withValues(alpha: 0.08),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
/// 调色板：与演示页 CSS 变量一一对应
// ═══════════════════════════════════════════════════════════════════

class _GlassPalette {
  const _GlassPalette({
    required this.fill,
    required this.fillStrong,
    required this.line,
    required this.lineStrong,
    required this.sheen,
    required this.ink,
    required this.inkSoft,
    required this.emphasisText,
    required this.shadow,
    required this.noise,
  });

  // 暗色玻璃（--glass-fill 等演示页变量按 oklch → sRGB 换算）
  static final _GlassPalette dark = _GlassPalette(
    fill: const Color.fromRGBO(30, 30, 30, 0.55),
    fillStrong: const Color.fromRGBO(48, 48, 48, 0.62),
    line: Colors.white.withValues(alpha: 0.16),
    lineStrong: Colors.white.withValues(alpha: 0.30),
    sheen: Colors.white.withValues(alpha: 0.34),
    ink: const Color(0xFFFCFCFC),
    inkSoft: Colors.white.withValues(alpha: 0.66),
    emphasisText: const Color(0xFF0D0D0D),
    shadow: Colors.black.withValues(alpha: 0.55),
    noise: Colors.white.withValues(alpha: 0.05),
  );

  // 浅色玻璃（暖色主题配白色玻璃）
  static final _GlassPalette light = _GlassPalette(
    fill: Colors.white.withValues(alpha: 0.55),
    fillStrong: Colors.white.withValues(alpha: 0.68),
    line: Colors.white.withValues(alpha: 0.55),
    lineStrong: Colors.white.withValues(alpha: 0.78),
    sheen: Colors.white.withValues(alpha: 0.85),
    ink: const Color(0xFF0D0D0D),
    inkSoft: const Color(0xFF0D0D0D).withValues(alpha: 0.62),
    emphasisText: Colors.white,
    shadow: const Color(0xFF161616).withValues(alpha: 0.22),
    noise: Colors.black.withValues(alpha: 0.045),
  );

  final Color fill;
  final Color fillStrong;
  final Color line;
  final Color lineStrong;
  final Color sheen;
  final Color ink;
  final Color inkSoft;
  final Color emphasisText;
  final Color shadow;
  final Color noise;
}

// ═══════════════════════════════════════════════════════════════════
/// 堆叠容器
// ═══════════════════════════════════════════════════════════════════

class _GlassToastStack extends StatelessWidget {
  const _GlassToastStack();

  @override
  Widget build(BuildContext context) {
    final _GlassPalette palette =
        Theme.of(context).brightness == Brightness.dark
            ? _GlassPalette.dark
            : _GlassPalette.light;
    return AnimatedBuilder(
      animation: GlassNotify.instance,
      builder: (BuildContext context, _) {
        final List<GlassNotifyEntry> entries = GlassNotify.entries;
        if (entries.isEmpty) {
          return const SizedBox.shrink();
        }
        return LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double width = math.min(
              380.0,
              constraints.maxWidth - GlassNotifyHost.sideInset,
            );
            // 卡片浮在 MaterialApp.builder 层、不在 Material 子树内，
            // 必须显式提供 DefaultTextStyle，否则 debug 构建会画黄色双下划线
            return DefaultTextStyle(
              style: Theme.of(context).textTheme.bodyMedium ??
                  const TextStyle(),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  for (int i = 0; i < entries.length; i++)
                    _GlassToastCard(
                      key: ValueKey<String>(entries[i].id),
                      entry: entries[i],
                      stackIndex: i,
                      palette: palette,
                      width: width,
                    ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
/// 单张通知卡
// ═══════════════════════════════════════════════════════════════════

class _GlassToastCard extends StatefulWidget {
  const _GlassToastCard({
    super.key,
    required this.entry,
    required this.stackIndex,
    required this.palette,
    required this.width,
  });

  final GlassNotifyEntry entry;
  final int stackIndex;
  final _GlassPalette palette;
  final double width;

  @override
  State<_GlassToastCard> createState() => _GlassToastCardState();
}

class _GlassToastCardState extends State<_GlassToastCard>
    with TickerProviderStateMixin {
  // 演示页入场曲线 cubic-bezier(0.22, 1, 0.36, 1)
  static const Curve _enterCurve = Cubic(0.22, 1.0, 0.36, 1.0);

  late final AnimationController _enter = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 460),
  )..forward();

  late final AnimationController _exit = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 280),
  );

  AnimationController? _progress;
  bool _hovered = false;
  bool _exitStarted = false;
  bool _finalized = false;

  @override
  void initState() {
    super.initState();
    updateCheckTrace("glass card initState id=${widget.entry.id} title=${widget.entry.title}");
    if (widget.entry.duration > Duration.zero) {
      _progress = AnimationController(
        vsync: this,
        duration: widget.entry.duration,
      )..addStatusListener(_onProgressStatus);
      if (!widget.entry.leaving) {
        _progress!.forward();
      }
    }
  }

  void _onProgressStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) {
      GlassNotify.dismiss(widget.entry.id, GlassNotifyCloseReason.expired);
    }
  }

  @override
  void dispose() {
    _enter.dispose();
    _exit.dispose();
    _progress?.dispose();
    super.dispose();
  }

  void _setHovered(bool hovered) {
    if (_hovered == hovered) return;
    setState(() => _hovered = hovered);
    final AnimationController? p = _progress;
    if (p == null ||
        p.status != AnimationStatus.forward ||
        widget.entry.leaving) {
      return;
    }
    if (hovered) {
      p.stop(); // 悬停暂停倒计时（演示页行为）
    } else {
      p.forward(); // 从当前进度恢复
    }
  }

  void _requestClose(GlassNotifyCloseReason reason) {
    GlassNotify.dismiss(widget.entry.id, reason);
  }

  void _finalize() {
    if (_finalized) return;
    _finalized = true;
    GlassNotify.instance.finalizeRemove(widget.entry.id);
  }

  @override
  Widget build(BuildContext context) {
    final GlassNotifyEntry entry = widget.entry;

    // 退场启动（entry.leaving 由管理器就地置位，build 侧触发最可靠）
    if (entry.leaving &&
        !_exitStarted &&
        _exit.status != AnimationStatus.completed) {
      _exitStarted = true;
      _progress?.stop();
      _exit.forward();
    }

    // 入场 × 退场 因子相乘，中途任意时刻转退场都平滑
    final double enterT = _enterCurve.transform(_enter.value);
    final double exitT = Curves.easeOutCubic.transform(_exit.value);
    final double opacity = enterT * (1.0 - exitT);
    final double baseDy = -14.0 * (1.0 - enterT) - 10.0 * exitT;
    final double baseScale = (0.94 + 0.06 * enterT) * (1.0 - 0.04 * exitT);

    if (entry.leaving && !_finalized && _exit.value >= 1.0) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _finalize();
      });
    }

    Widget card = _buildSurface();

    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: widget.stackIndex.toDouble()),
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
      builder: (BuildContext context, double depth, Widget? child) {
        // 层叠景深：后卡上移 6px/级、缩 2.2%/级、微模糊 0.8px/级（封顶 2.4）。
        // 入场/退场不再动画内容模糊——每帧 saveLayer+变σ模糊叠加 BackdropFilter
        // 重渲染是掉帧主因，只留透明度+位移+缩放后视觉几乎无差（2026-09-22 卡顿优化）。
        final double dy = baseDy - 6.0 * depth;
        final double scale = baseScale * (1.0 - 0.022 * depth);
        final double blur = math.min(2.4, 0.8 * depth);

        Widget result = Opacity(
          opacity: opacity.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, dy),
            child: Transform.scale(
              scale: scale,
              child: blur < 0.05
                  ? child
                  : ImageFiltered(
                      imageFilter: ImageFilter.blur(
                        sigmaX: blur,
                        sigmaY: blur,
                      ),
                      child: child,
                    ),
            ),
          ),
        );
        return result;
      },
      child: card,
    );
  }

  // ── 玻璃卡面 ─────────────────────────────────────────────────────

  Widget _buildSurface() {
    final _GlassPalette p = widget.palette;
    return MouseRegion(
      onEnter: (PointerEnterEvent _) => _setHovered(true),
      onExit: (PointerExitEvent _) => _setHovered(false),
      cursor: SystemMouseCursors.basic,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(end: _hovered ? 1.0 : 0.0),
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
        builder: (BuildContext context, double hoverT, Widget? child) {
          // 静置三层影 → 悬停深影（演示页 hover: 0 26px 60px -16px）
          final List<BoxShadow> shadows = <BoxShadow>[
            BoxShadow.lerp(
              BoxShadow(
                offset: const Offset(0, 18),
                blurRadius: 44,
                spreadRadius: -12,
                color: p.shadow,
              ),
              BoxShadow(
                offset: const Offset(0, 26),
                blurRadius: 60,
                spreadRadius: -16,
                color: p.shadow,
              ),
              hoverT,
            )!,
            BoxShadow(
              offset: const Offset(0, 2),
              blurRadius: 10,
              spreadRadius: -4,
              color: p.shadow,
            ),
          ];
          // 定宽是硬约束：卡片内部 Stack→Row(Expanded) 依赖有界宽度
          return SizedBox(
            width: widget.width,
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: p.line),
                boxShadow: shadows,
              ),
              child: child!,
            ),
          );
        },
        child: ClipRRect(
          borderRadius: BorderRadius.circular(15),
          child: BackdropFilter(
            // backdrop-filter: blur(28px)。演示页另带 saturate(150%)，
            // 本应用为黑白单色 UI，背景近乎灰度，饱和度层视觉增益为零故省去
            filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
            child: Container(
              decoration: BoxDecoration(color: p.fill),
              // 135° 斜向反光层：白 14% → 透明 42%~62% → 黑 8%
              foregroundDecoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  stops: const <double>[0.0, 0.42, 0.62, 1.0],
                  colors: <Color>[
                    Colors.white.withValues(alpha: 0.14),
                    Colors.transparent,
                    Colors.transparent,
                    Colors.black.withValues(alpha: 0.08),
                  ],
                ),
              ),
              child: Stack(
                children: <Widget>[
                  // 细噪点：去塑料感
                  Positioned.fill(
                    child: IgnorePointer(
                      child: RepaintBoundary(
                        child: CustomPaint(
                          painter: _GlassNoisePainter(p.noise),
                        ),
                      ),
                    ),
                  ),
                  // 顶部 1px 高光渐变线（玻璃上缘反光）
                  Positioned(
                    left: 0,
                    right: 0,
                    top: 0,
                    child: Container(
                      height: 1,
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          stops: const <double>[0.0, 0.5, 1.0],
                          colors: <Color>[
                            p.sheen.withValues(alpha: 0),
                            p.sheen,
                            p.sheen.withValues(alpha: 0),
                          ],
                        ),
                      ),
                    ),
                  ),
                  // 正文
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 13, 12, 14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        _buildIconChip(),
                        const SizedBox(width: 10),
                        Expanded(child: _buildBody()),
                      ],
                    ),
                  ),
                  // 倒计时进度条
                  if (_progress != null && widget.entry.showProgress)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: AnimatedBuilder(
                        animation: _progress!,
                        builder: (BuildContext context, _) {
                          // scaleX 1→0，中心收缩（与演示页 transform-origin 一致）
                          final double remain = 1.0 - _progress!.value;
                          return Align(
                            alignment: Alignment.center,
                            child: FractionallySizedBox(
                              widthFactor: remain,
                              child: Container(
                                height: 2,
                                decoration: BoxDecoration(
                                  gradient: LinearGradient(
                                    stops: const <double>[0.0, 0.5, 1.0],
                                    colors: <Color>[
                                      widget.palette.ink.withValues(alpha: 0),
                                      widget.palette.ink.withValues(alpha: 0.45),
                                      widget.palette.ink.withValues(alpha: 0),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildIconChip() {
    final _GlassPalette p = widget.palette;
    final bool loading = widget.entry.variant == GlassNotifyVariant.loading;
    final IconData icon = switch (widget.entry.variant) {
      GlassNotifyVariant.success => Icons.check_rounded,
      GlassNotifyVariant.warning => Icons.warning_amber_rounded,
      GlassNotifyVariant.error => Icons.error_outline_rounded,
      GlassNotifyVariant.loading => Icons.refresh,
      GlassNotifyVariant.info => Icons.info_outline_rounded,
    };
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: p.fillStrong,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: p.lineStrong),
      ),
      alignment: Alignment.center,
      child: loading
          ? SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2.1,
                strokeCap: StrokeCap.round,
                color: p.ink,
              ),
            )
          : Icon(icon, size: 17, color: p.ink),
    );
  }

  Widget _buildBody() {
    final GlassNotifyEntry e = widget.entry;
    final _GlassPalette p = widget.palette;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                e.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15,
                  height: 1.25,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.15,
                  color: p.ink,
                ),
              ),
            ),
            if (e.dismissible) _buildCloseButton(),
          ],
        ),
        if (e.message.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              e.message,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13.5,
                height: 1.45,
                color: p.inkSoft,
              ),
            ),
          ),
        if (e.actions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final GlassNotifyAction a in e.actions) _buildPill(a),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildCloseButton() {
    final _GlassPalette p = widget.palette;
    return SizedBox(
      width: 26,
      height: 26,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _requestClose(GlassNotifyCloseReason.dismissed),
        child: Icon(Icons.close, size: 15, color: p.ink.withValues(alpha: 0.55)),
      ),
    );
  }

  Widget _buildPill(GlassNotifyAction action) {
    final _GlassPalette p = widget.palette;
    final bool solid = action.emphasized;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () {
        action.onPressed();
        _requestClose(GlassNotifyCloseReason.action);
      },
      child: Container(
        // 固定 32px 高、居中排版：不依赖字号行高推算，中文墨迹不会溢出胶囊
        height: 32,
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: solid ? p.ink : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: solid
              ? null
              : Border.all(color: p.lineStrong),
        ),
        child: Text(
          action.label,
          style: TextStyle(
            fontSize: 13,
            height: 1.2,
            fontWeight: FontWeight.w600,
            color: solid ? p.emphasisText : p.ink,
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
/// 细噪点纹理（演示页 .glass-noise：3px 网格 0.5px 圆点）
// ═══════════════════════════════════════════════════════════════════

class _GlassNoisePainter extends CustomPainter {
  const _GlassNoisePainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..color = color;
    const double step = 3;
    for (double y = step / 2; y < size.height; y += step) {
      for (double x = step / 2; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 0.5, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _GlassNoisePainter oldDelegate) =>
      oldDelegate.color != color;
}
