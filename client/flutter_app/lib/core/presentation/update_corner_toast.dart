import "dart:async";
import "dart:ui" show ImageFilter;

import "package:flutter/material.dart";

import "../services/client_update_installer.dart";
import "client_update_flow_view.dart";

/// ═══════════════════════════════════════════════════════════════════
/// 左下角更新提示胶囊（VS Code 式，2026-10-28）：
///   ┌───────────────────────────┐
///   │  新版本 5.9.3   [ 重启更新 ] │
///   └───────────────────────────┘
/// 服务端推 update.available（可选升级）或启动检查发现可选升级时，除灵动岛
/// 简短提示外，在窗口左下角（侧栏头像行上方）挂一枚常驻小胶囊——主流式
/// 行为：**显示的同时即开始后台静默预下载**（共享下载流，见
/// client_update_installer.dart 的 sharedUpdateFlow），胶囊实时反映进度，
/// 下完按钮变「重启更新」，一键静默安装重启；全程不跳浏览器、不抢焦点。
///
/// 非模态：不遮侧栏头像（bottom 预留头像行高度）。已最新推送（upToDate）
/// 即撤下并终止共享下载——与灵动岛提示同一撤下时机。
///
/// 挂载与玻璃卡同架构：MaterialApp.builder 里包 UpdateCornerToastHost，
/// 位于 navigator 之上，不依赖 Overlay/路由。
/// ═══════════════════════════════════════════════════════════════════

/// 当前胶囊内容（null = 无胶囊）；Host 监听它渲染
final ValueNotifier<_CornerToastSpec?> _cornerToastController =
    ValueNotifier<_CornerToastSpec?>(null);

/// 当前挂载的 Host 状态（dismiss 时就地触发退场动画）；未挂载为 null
_UpdateCornerToastHostState? _cornerToastHostState;

class _CornerToastSpec {
  const _CornerToastSpec({
    required this.latestVersion,
    required this.downloadUrl,
  });

  final String latestVersion;
  final String downloadUrl;
}

class UpdateCornerToast {
  UpdateCornerToast._();

  /// 发现新版本：常驻胶囊 + **立即开始后台预下载**（主流式）。
  /// 同版本重复推送幂等（保留既有下载进度，不因服务端重推重启下载）；
  /// 新版本号才换卡重建并切到新流的下载。
  static void showUpdate({
    required String latestVersion,
    required String downloadUrl,
  }) {
    final _CornerToastSpec? current = _cornerToastController.value;
    final bool sameVersion =
        current != null && current.latestVersion == latestVersion;
    _cornerToastController.value = _CornerToastSpec(
      latestVersion: latestVersion,
      downloadUrl: downloadUrl,
    );
    if (sameVersion) return; // 重推不打断进行中的共享下载
    sharedUpdateFlow(downloadUrl: downloadUrl, version: latestVersion);
    ensureSharedUpdateDownloading();
  }

  /// 已最新（用户在别处完成升级后的补推）即撤下，与灵动岛同时机；
  /// 共享下载流一并终止（该版本已无需下载）。
  static void dismiss() {
    disposeSharedUpdateFlow();
    _cornerToastHostState?.beginExit();
  }

  /// 测试复位：清空胶囊 spec 与宿主引用（全局单例状态不跨测试泄漏）
  @visibleForTesting
  static void debugReset() {
    _cornerToastController.value = null;
    _cornerToastHostState = null;
  }
}

/// 挂在 MaterialApp.builder（UpdateResultCardHost 之上）：child（navigator）
/// 之下正常渲染，胶囊定位在窗口左下角、浮于所有路由之上
class UpdateCornerToastHost extends StatefulWidget {
  const UpdateCornerToastHost({super.key, required this.child});

  final Widget? child;

  @override
  State<UpdateCornerToastHost> createState() => _UpdateCornerToastHostState();
}

class _UpdateCornerToastHostState extends State<UpdateCornerToastHost> {
  _CornerToastState? _toastState;

  void beginExit() => _toastState?.beginExit();

  @override
  void initState() {
    super.initState();
    _cornerToastHostState = this;
    _cornerToastController.addListener(_onSpecChanged);
  }

  @override
  void dispose() {
    _cornerToastController.removeListener(_onSpecChanged);
    if (_cornerToastHostState == this) {
      _cornerToastHostState = null;
    }
    super.dispose();
  }

  void _onSpecChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final _CornerToastSpec? spec = _cornerToastController.value;
    return Stack(
      textDirection: TextDirection.ltr,
      children: <Widget>[
        if (widget.child != null) widget.child!,
        if (spec != null)
          // 左下角：bottom 预留侧栏底部头像行（40px 头像 + 8px 底距）不遮挡
          Positioned(
            left: 12,
            bottom: 60,
            child: DefaultTextStyle(
              style:
                  Theme.of(context).textTheme.bodyMedium ?? const TextStyle(),
              child: _CornerToast(
                key: ValueKey<_CornerToastSpec>(spec),
                spec: spec,
              ),
            ),
          ),
      ],
    );
  }
}

class _CornerToast extends StatefulWidget {
  const _CornerToast({super.key, required this.spec});

  final _CornerToastSpec spec;

  @override
  State<_CornerToast> createState() => _CornerToastState();
}

class _CornerToastState extends State<_CornerToast>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 280),
  )..addStatusListener(_onStatus);

  bool _exiting = false;

  @override
  void initState() {
    super.initState();
    _cornerToastHostState?._toastState = this;
    _controller.forward();
  }

  void _onStatus(AnimationStatus status) {
    if (!_exiting) return;
    if (status == AnimationStatus.dismissed) {
      // 播完才真正摘胶囊；退场期间若已换新 spec，则不动新胶囊
      if (_cornerToastController.value == widget.spec) {
        _cornerToastController.value = null;
      }
    }
  }

  void beginExit() {
    if (_exiting) return;
    _exiting = true;
    _controller.reverse();
  }

  @override
  void dispose() {
    if (_cornerToastHostState?._toastState == this) {
      _cornerToastHostState?._toastState = null;
    }
    _controller.dispose();
    super.dispose();
  }

  /// 「重试」/兜底「立即更新」：确保共享流存在并进入下载
  void _startDownload() {
    sharedUpdateFlow(
      downloadUrl: widget.spec.downloadUrl,
      version: widget.spec.latestVersion,
    );
    ensureSharedUpdateDownloading();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    // 必须经 AnimatedBuilder 订阅控制器触发重建，否则动画停在第 0 帧
    // 整卡不可见（同 UpdateResultCard 的真机 E2E 教训）。入场 fade + 上滑。
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, _) {
        final double t = Curves.easeOutCubic.transform(_controller.value);
        return Opacity(
          opacity: t.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, 10 * (1.0 - t)),
            child: _buildPill(context),
          ),
        );
      },
    );
  }

  Widget _buildPill(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool dark = cs.brightness == Brightness.dark;
    // 胶囊底/描边随主题走；主按钮走「反色」：暗色主题=白底黑字（参考
    // VS Code），暖米白主题=墨底白字，两套主题都保持高对比主操作
    final Color pillBg = dark
        ? const Color(0xFF2B2B2B).withValues(alpha: 0.97)
        : cs.surfaceContainerHighest.withValues(alpha: 0.97);
    final Color line = cs.outline.withValues(alpha: dark ? 0.45 : 0.5);
    final Color ink = dark ? Colors.white : cs.onSurface;
    final Color btnBg = dark ? Colors.white : cs.onSurface;
    final Color btnFg = dark ? const Color(0xFF141414) : cs.surface;

    // 下载状态全部来自共享流（弹窗/浮卡/胶囊三入口进度互通）
    return ListenableBuilder(
      listenable: Listenable.merge(<Listenable?>[activeSharedUpdateFlow]),
      builder: (BuildContext context, _) => DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: line),
          boxShadow: <BoxShadow>[
            BoxShadow(
              offset: const Offset(0, 10),
              blurRadius: 28,
              spreadRadius: -8,
              color: Colors.black.withValues(alpha: dark ? 0.5 : 0.24),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(11.5),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
              decoration: BoxDecoration(color: pillBg),
              child: _buildContent(ink, btnBg, btnFg),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildContent(Color ink, Color btnBg, Color btnFg) {
    final ClientUpdateFlowController? flow = activeSharedUpdateFlow;
    final ClientUpdatePhase phase = flow?.phase ?? ClientUpdatePhase.idle;
    return switch (phase) {
      // 正常路径胶囊一亮即进入 downloading（显示即预下载），idle 只在
      // 共享流尚未建立时闪现
      ClientUpdatePhase.idle => _row(
          "新版本 ${widget.spec.latestVersion}",
          _actionButton("立即更新", btnBg, btnFg, onTap: _startDownload),
          ink,
        ),
      ClientUpdatePhase.downloading => _row(
          "新版本 ${widget.spec.latestVersion}",
          _progressChip(flow!, ink),
          ink,
        ),
      ClientUpdatePhase.downloaded => _row(
          "新版本 ${widget.spec.latestVersion}",
          _actionButton(
            "重启更新",
            btnBg,
            btnFg,
            onTap: () => unawaited(flow!.restartToUpdate()),
          ),
          ink,
        ),
      ClientUpdatePhase.launching => _row(
          "新版本 ${widget.spec.latestVersion}",
          _actionButton("正在更新…", btnBg, btnFg, onTap: null),
          ink,
        ),
      ClientUpdatePhase.failed => _row(
          "更新失败",
          _actionButton("重试", btnBg, btnFg, onTap: _startDownload),
          ink,
        ),
    };
  }

  Widget _row(String label, Widget trailing, Color ink) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 13,
            height: 1.2,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.1,
            color: ink,
          ),
        ),
        const SizedBox(width: 12),
        trailing,
      ],
    );
  }

  /// 主操作按钮：实心反色圆角矩形（参考 VS Code 的白底按钮），禁用态降透明
  Widget _actionButton(
    String label,
    Color bg,
    Color fg, {
    VoidCallback? onTap,
  }) {
    final bool enabled = onTap != null;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        constraints: const BoxConstraints(minHeight: 30),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg.withValues(alpha: enabled ? 1.0 : 0.45),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          label,
          maxLines: 1,
          style: TextStyle(
            fontSize: 12.5,
            height: 1.2,
            fontWeight: FontWeight.w600,
            color: fg.withValues(alpha: enabled ? 1.0 : 0.6),
          ),
        ),
      ),
    );
  }

  /// 下载中：按钮位置换成窄进度条 + 百分比（不改变胶囊高度节奏）
  Widget _progressChip(ClientUpdateFlowController flow, Color ink) {
    final double? value = flow.progress;
    final String caption = value == null
        ? formatMb(flow.received)
        : "${(value * 100).round().clamp(0, 100)}%";
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        SizedBox(
          width: 84,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: value,
              minHeight: 3,
              backgroundColor: ink.withValues(alpha: 0.22),
              valueColor: AlwaysStoppedAnimation<Color>(ink),
            ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          caption,
          style: TextStyle(
            fontSize: 11.5,
            height: 1.2,
            fontWeight: FontWeight.w600,
            color: ink.withValues(alpha: 0.8),
          ),
        ),
      ],
    );
  }
}
