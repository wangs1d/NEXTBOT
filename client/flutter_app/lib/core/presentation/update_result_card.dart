import "dart:async";
import "dart:ui" show ImageFilter;

import "package:flutter/material.dart";

import "../../widgets/app_sidebar.dart";
import "../services/client_update_checker.dart";
import "../services/client_update_installer.dart";
import "client_update_dialog.dart";
import "client_update_flow_view.dart";
import "glass_notify.dart";

/// ═══════════════════════════════════════════════════════════════════
/// 「检查更新」结果浮卡：锚定在侧栏「检查更新」按钮正上方（左上角对齐、
/// 上移 8px），非模态——无遮罩、不影响浮卡外的任何点击，仅 × / 按钮可关。
/// - 发现新版本：版本对比 + 「立即升级」「暂不更新」，常驻直到用户处理；
///   点「立即升级」就地进入应用内下载流程（进度 → 重启完成更新），不跳浏览器
/// - 检查失败：原因 + 「重试」，8s 自动收起
/// 视觉与右上角玻璃通知卡（glass_notify.dart）同一套黑白玻璃语言，
/// 入场/退场同一节奏（fade + 上滑 + blur）。
///
/// 挂载与玻璃卡同架构：MaterialApp.builder 里包 UpdateResultCardHost，
/// 位于 navigator 之上、GlassNotifyHost 之内，不依赖 Overlay/路由。
/// ═══════════════════════════════════════════════════════════════════

/// 当前挂载的浮卡宿主/卡片状态（文件私有全局，避免公共 API 暴露私有类型）
_UpdateResultCardHostState? _updateCardHostState;

class _UpdateCardPillSpec {
  const _UpdateCardPillSpec({
    required this.label,
    required this.onTap,
    this.emphasized = false,
  });

  final String label;
  final VoidCallback onTap;

  /// true = 实心胶囊（主操作），false = 描边胶囊（次操作）
  final bool emphasized;
}

/// 一张浮卡的内容描述；以其身份作卡片 key，换卡即重建
class _UpdateCardSpec {
  const _UpdateCardSpec({
    required this.title,
    required this.message,
    required this.icon,
    required this.autoClose,
    required this.actions,
    this.notes = "",
  });

  final String title;
  final String message;
  final String notes;
  final IconData icon;

  /// true = 检查失败等瞬时提示，8s 无操作自动收起；
  /// false = 需要用户决策（升级与否），常驻
  final bool autoClose;
  final List<_UpdateCardPillSpec> actions;
}

/// 当前浮卡内容（null = 无卡）；Host 监听它渲染
final ValueNotifier<_UpdateCardSpec?> _updateCardController =
    ValueNotifier<_UpdateCardSpec?>(null);

/// 浮卡内进行中的更新下载流程（null = 静态卡）；卡片监听它把操作区
/// 换成下载进度/重启更新（ClientUpdateFlowView），流程结束即还原
final ValueNotifier<ClientUpdateFlowController?> _cardFlowController =
    ValueNotifier<ClientUpdateFlowController?>(null);

class UpdateResultCard {
  UpdateResultCard._();

  /// 手动「检查更新」的结果分流（不弹居中弹窗；检查期间的可见反馈由
  /// 调用方承担——侧栏按钮图标换转圈）：
  /// - 已是最新 → 右上角玻璃通知卡轻提示（短暂即逝）
  /// - 发现新版本 / 检查失败 → 更新按钮正上方浮卡（非模态）
  /// - 仅强锁（低于 minVersion）保留不可关闭的居中弹窗，与启动检查同一出口
  static Future<void> runManualUpdateCheck(
    BuildContext context, {
    bool forceRefresh = false,
  }) async {
    updateCheckTrace("ui manual-check begin${forceRefresh ? " (forced)" : ""}");
    final ClientUpdateCheckResult? result =
        await checkClientUpdate(forceRefresh: forceRefresh);
    updateCheckTrace("ui check returned, card routing");
    if (!context.mounted) return;
    if (result == null) {
      showFailure(
        onRetry: () =>
            unawaited(runManualUpdateCheck(context, forceRefresh: true)),
      );
      return;
    }
    if (result.status == ClientUpdateStatus.forcedUpdate) {
      await showClientUpdateDialog(
        context: context,
        manifest: result.manifest,
        localVersion: result.localVersion,
        forced: true,
      );
      return;
    }
    if (result.status == ClientUpdateStatus.optionalUpdate) {
      showUpdate(
        localVersion: result.localVersion,
        latestVersion: result.manifest.latest,
        notes: result.manifest.notes,
        downloadUrl: result.manifest.url,
      );
      return;
    }
    updateCheckTrace("ui glass-card show (upToDate)");
    GlassNotify.show(
      title: "已是最新版本",
      message: "当前版本 v${result.localVersion}",
      variant: GlassNotifyVariant.success,
    );
  }

  /// 发现新版本：常驻浮卡，用户点「立即升级 / 暂不更新 / ×」才收起
  static void showUpdate({
    required String localVersion,
    required String latestVersion,
    String notes = "",
    required String downloadUrl,
  }) {
    _updateCardController.value = _UpdateCardSpec(
      title: "发现新版本 v$latestVersion",
      message: "当前 v$localVersion → 最新 v$latestVersion",
      notes: notes,
      icon: Icons.upgrade_rounded,
      autoClose: false,
      actions: <_UpdateCardPillSpec>[
        _UpdateCardPillSpec(
          label: "立即升级",
          emphasized: true,
          onTap: () => startFlow(
            downloadUrl: downloadUrl,
            latestVersion: latestVersion,
          ),
        ),
        const _UpdateCardPillSpec(
          label: "暂不更新",
          onTap: UpdateResultCard.dismiss,
        ),
      ],
    );
  }

  /// 浮卡内进入下载流程：操作区就地换成进度条 → 「重启完成更新」。
  /// 不跳浏览器、不关卡；下载流为全局共享单飞（2026-10-28 主流式）——
  /// 若后台已在预下载（左下角胶囊），这里直接并入同一条流的进度展示。
  static void startFlow({
    required String downloadUrl,
    required String latestVersion,
  }) {
    sharedUpdateFlow(downloadUrl: downloadUrl, version: latestVersion);
    ensureSharedUpdateDownloading();
    _cardFlowController.value = activeSharedUpdateFlow;
  }

  /// 只解绑不取消：共享流归全局所有，浮卡关闭后后台预下载继续
  /// （左下角胶囊仍在反映进度）；重试等入口可重新挂回。
  static void _disposeFlow() {
    _cardFlowController.value = null;
  }

  /// 检查失败：浮卡提示 + 重试，8s 无操作自动收起
  static void showFailure({required VoidCallback onRetry}) {
    _updateCardController.value = _UpdateCardSpec(
      title: "检查更新失败",
      message: "网络异常或服务不可用，请稍后重试",
      icon: Icons.error_outline_rounded,
      autoClose: true,
      actions: <_UpdateCardPillSpec>[
        _UpdateCardPillSpec(label: "重试", emphasized: true, onTap: onRetry),
      ],
    );
  }

  /// 带退场动画收起（× / 操作按钮 / 自动收起走这里）；进行中的下载一并取消
  static void dismiss() {
    _disposeFlow();
    _updateCardHostState?.beginExit();
  }
}

/// 挂在 MaterialApp.builder（GlassNotifyHost 内层）：child（navigator）
/// 之下正常渲染，浮卡经 LayerLink 锚到更新按钮正上方、浮于所有路由之上
class UpdateResultCardHost extends StatefulWidget {
  const UpdateResultCardHost({super.key, required this.child});

  final Widget? child;

  @override
  State<UpdateResultCardHost> createState() => _UpdateResultCardHostState();
}

class _UpdateResultCardHostState extends State<UpdateResultCardHost> {
  _UpdateResultCardState? _cardState;

  void beginExit() => _cardState?.beginExit();

  @override
  void initState() {
    super.initState();
    _updateCardHostState = this;
    _updateCardController.addListener(_onSpecChanged);
  }

  @override
  void dispose() {
    _updateCardController.removeListener(_onSpecChanged);
    if (_updateCardHostState == this) {
      _updateCardHostState = null;
    }
    super.dispose();
  }

  void _onSpecChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final _UpdateCardSpec? spec = _updateCardController.value;
    return Stack(
      textDirection: TextDirection.ltr,
      children: <Widget>[
        if (widget.child != null) widget.child!,
        if (spec != null)
          Positioned(
            left: 0,
            top: 0,
            child: CompositedTransformFollower(
              link: AppSidebar.updateButtonLink,
              // 卡片底缘贴按钮顶缘上方 8px：卡片向上生长，不遮按钮、不出窗底
              targetAnchor: Alignment.topLeft,
              followerAnchor: Alignment.bottomLeft,
              offset: const Offset(0, -8),
              // 卡片浮在 builder 层、不在 Material 子树内，必须显式提供
              // DefaultTextStyle，否则 debug 构建文字画黄色双下划线
              child: DefaultTextStyle(
                style: Theme.of(context).textTheme.bodyMedium ??
                    const TextStyle(),
                child: _UpdateResultCard(
                  key: ValueKey<_UpdateCardSpec>(spec),
                  spec: spec,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _UpdateResultCard extends StatefulWidget {
  const _UpdateResultCard({super.key, required this.spec});

  final _UpdateCardSpec spec;

  @override
  State<_UpdateResultCard> createState() => _UpdateResultCardState();
}

class _UpdateResultCardState extends State<_UpdateResultCard>
    with SingleTickerProviderStateMixin {
  static const double _cardWidth = 320;

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
  )..addStatusListener(_onStatus);

  Timer? _autoCloseTimer;
  bool _exiting = false;

  @override
  void initState() {
    super.initState();
    _updateCardHostState?._cardState = this;
    _cardFlowController.addListener(_onFlowChanged);
    _controller.forward();
    if (widget.spec.autoClose) {
      _autoCloseTimer = Timer(
        const Duration(seconds: 8),
        UpdateResultCard.dismiss,
      );
    }
  }

  void _onFlowChanged() {
    if (mounted) setState(() {});
  }

  void _onStatus(AnimationStatus status) {
    if (!_exiting) return;
    // 退场走 reverse，终态是 dismissed（completed 只在 forward 到 1.0 时出现）
    if (status == AnimationStatus.dismissed) {
      // 播完才真正摘卡；若退场期间已换新卡，则不能动新卡的内容
      if (_updateCardController.value == widget.spec) {
        _updateCardController.value = null;
      }
    }
  }

  void beginExit() {
    if (_exiting) return;
    _exiting = true;
    _autoCloseTimer?.cancel();
    _controller.reverse();
  }

  @override
  void dispose() {
    _autoCloseTimer?.cancel();
    _cardFlowController.removeListener(_onFlowChanged);
    if (_updateCardHostState?._cardState == this) {
      _updateCardHostState?._cardState = null;
    }
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 必须经 AnimatedBuilder 订阅控制器触发重建——否则动画走完卡面仍停在
    // 第 0 帧（opacity 0）整卡不可见（真机 E2E 抓出过此 bug）。
    // 静态卡面作为 child 只构建一次。
    return AnimatedBuilder(
      animation: _controller,
      child: _buildCard(context),
      builder: (BuildContext context, Widget? child) {
        // fade + 上滑 10px。不再动画内容模糊（ImageFiltered 每帧
        // saveLayer+变σ模糊叠加卡面 BackdropFilter 是掉帧主因）。
        final double t = Curves.easeOutCubic.transform(_controller.value);
        final double dy = 10.0 * (1.0 - t);

        return Opacity(
          opacity: t.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, dy),
            child: child,
          ),
        );
      },
    );
  }

  Widget _buildCard(BuildContext context) {
    // 配色全部从主题 ColorScheme 推导：深色/暖米白两套主题各自成立，
    // 不再写死黑白玻璃的纯黑纯白（暖色主题下墨色/描边/底色随主题走）；
    // 仅顶部反光线与 135° 斜向反光层是玻璃镜面细节，两种主题下保持白色
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool dark = cs.brightness == Brightness.dark;
    final Color fill = cs.surfaceContainer.withValues(alpha: dark ? 0.62 : 0.72);
    final Color fillStrong =
        cs.surfaceContainerHigh.withValues(alpha: dark ? 0.72 : 0.9);
    final Color line = cs.outline.withValues(alpha: dark ? 0.45 : 0.6);
    final Color lineStrong = cs.outline.withValues(alpha: dark ? 0.8 : 1.0);
    final Color sheen = Colors.white.withValues(alpha: dark ? 0.34 : 0.85);
    final Color ink = cs.onSurface;
    final Color inkSoft = cs.onSurfaceVariant;
    // 次操作胶囊描边：outline 在暖色主题的奶白玻璃上过淡（近乎隐形），
    // 改用 onSurface 半透明——深色下≈原白描边观感，暖色下清晰可辨
    final Color pillLine = ink.withValues(alpha: 0.28);
    final Color shadow = dark
        ? Colors.black.withValues(alpha: 0.55)
        : const Color(0xFF161616).withValues(alpha: 0.22);

    return SizedBox(
      width: _cardWidth,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: line),
          boxShadow: <BoxShadow>[
            BoxShadow(
              offset: const Offset(0, 18),
              blurRadius: 44,
              spreadRadius: -12,
              color: shadow,
            ),
            BoxShadow(
              offset: const Offset(0, 2),
              blurRadius: 10,
              spreadRadius: -4,
              color: shadow,
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(15),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
            child: Container(
              decoration: BoxDecoration(color: fill),
              // 135° 斜向反光层，与玻璃通知卡一致
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
                            sheen.withValues(alpha: 0),
                            sheen,
                            sheen.withValues(alpha: 0),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 13, 12, 14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: fillStrong,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: lineStrong),
                          ),
                          alignment: Alignment.center,
                          child: Icon(widget.spec.icon, size: 17, color: ink),
                        ),
                        const SizedBox(width: 10),
                        Expanded(child: _buildBody(ink, inkSoft, pillLine)),
                      ],
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

  Widget _buildBody(
    Color ink,
    Color inkSoft,
    Color line,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                widget.spec.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15,
                  height: 1.25,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.15,
                  color: ink,
                ),
              ),
            ),
            _buildCloseButton(ink),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            widget.spec.message,
            style: TextStyle(
              fontSize: 13.5,
              height: 1.45,
              color: inkSoft,
            ),
          ),
        ),
        if (widget.spec.notes.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              widget.spec.notes,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                height: 1.4,
                color: inkSoft.withValues(alpha: 0.85),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: _cardFlowController.value != null
              // 下载进行中：操作区整体让位给进度/重启流程（暂不更新=回到静态卡）
              ? ClientUpdateFlowView(
                  controller: _cardFlowController.value!,
                  showCancel: true,
                  onDismiss: _closeCardFlow,
                )
              : Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    for (final _UpdateCardPillSpec a in widget.spec.actions)
                      _buildPill(a, ink, line),
                  ],
                ),
        ),
      ],
    );
  }

  /// 收起浮卡内的下载流程、还原静态卡（共享流只解绑不取消，后台继续）
  void _closeCardFlow() {
    _cardFlowController.value = null;
  }

  Widget _buildCloseButton(Color ink) {
    return SizedBox(
      width: 26,
      height: 26,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: UpdateResultCard.dismiss,
        child: Icon(Icons.close, size: 15, color: ink.withValues(alpha: 0.55)),
      ),
    );
  }

  /// 主/次操作直接用主题按钮：颜色随主题（含暖色）自动走，与升级弹窗
  /// 的 FilledButton 同一语言；shrinkWrap 保持胶囊几何。
  /// 行高不写 1.0：旧运行时按纯字面行盒（13px）算按钮高、无视纵向
  /// 内边距，中文墨迹（≈1.3em）直接溢出胶囊；改 1.2 并以 32px 最小
  /// 高度兜底，无论运行时怎么算高，文字都包得住。
  Widget _buildPill(_UpdateCardPillSpec spec, Color ink, Color line) {
    const TextStyle textStyle = TextStyle(
      fontSize: 13,
      height: 1.2,
      fontWeight: FontWeight.w600,
    );
    if (spec.emphasized) {
      return FilledButton(
        onPressed: spec.onTap,
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const StadiumBorder(),
          textStyle: textStyle,
        ),
        child: Text(spec.label),
      );
    }
    return OutlinedButton(
      onPressed: spec.onTap,
      style: OutlinedButton.styleFrom(
        foregroundColor: ink,
        side: BorderSide(color: line),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
        textStyle: textStyle,
      ),
      child: Text(spec.label),
    );
  }
}
