import "dart:async";
import "dart:io";

import "package:flutter/material.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/config/api_config.dart";
import "digital_human_view_mobile.dart" as mobile;

/// 数字人视图 —— Windows WebView2 实现。
///
/// 项目约定：WebView2 只允许经 `webview_windows` 插件加载（runner 里
/// `sphere_overlay_window.cpp` 注释：one loader per process）。`webview_flutter`
/// 在 Windows 上没有实现，直接用会落到 fallback 图标 —— 所以这里单独分化。
///
/// 手机端（Android/iOS）转交 [mobile.DigitalHumanViewMobile] 同链路实现。
class DigitalHumanView extends StatefulWidget {
  const DigitalHumanView({
    super.key,
    this.mini = false,
    this.active = true,
  });

  final bool mini;
  final bool active;

  /// 数字人页面地址（mini = 圆框流，detail = 完整舞台）。
  static Uri resolveUri({required bool mini, String? base}) {
    return Uri.parse(base ?? ApiConfig.digitalHumanBase)
        .resolve(mini ? "/?mode=mini" : "/?mode=detail");
  }

  @override
  State<DigitalHumanView> createState() => DigitalHumanViewState();
}

class DigitalHumanViewState extends State<DigitalHumanView>
    with WidgetsBindingObserver {
  WebviewController? _controller;
  final GlobalKey<mobile.DigitalHumanViewState> _mobileKey =
      GlobalKey<mobile.DigitalHumanViewState>();
  bool _initializing = false;
  bool _failed = false;
  bool _lifecycleActive = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (Platform.isWindows) {
      unawaited(_initWebView());
    }
  }

  Future<void> _initWebView() async {
    if (_initializing || _controller != null) return;
    _initializing = true;
    WebviewController? controller;
    try {
      controller = WebviewController();
      await controller.initialize();
      // mini 页面 html.mini-mode 自身就是 transparent 背景。
      await controller.setBackgroundColor(const Color(0x00000000));
      await controller.loadUrl(
        DigitalHumanView.resolveUri(mini: widget.mini).toString(),
      );
      if (!mounted) {
        controller.dispose();
        return;
      }
      setState(() {
        _controller = controller;
        _failed = false;
      });
      unawaited(_applyActive());
    } catch (e) {
      debugPrint("[DigitalHumanView] WebView2 init failed: $e");
      controller?.dispose();
      if (mounted) setState(() => _failed = true);
    } finally {
      _initializing = false;
    }
  }

  Future<void> _applyActive() async {
    final bool active = widget.active && _lifecycleActive;
    final WebviewController? controller = _controller;
    if (controller != null) {
      try {
        await controller.executeScript(
          "window.__avatar && window.__avatar.setPaused(${!active});",
        );
      } catch (_) {
        // 页面尚未就绪，忽略。
      }
    }
    // 手机端由 mobile.DigitalHumanView 自行处理 active，无需在此转发。
  }

  Future<void> reloadAvatar() async {
    final WebviewController? controller = _controller;
    if (controller != null) {
      try {
        await controller.executeScript(
          "window.__avatar && window.__avatar.reloadAvatar();",
        );
      } catch (_) {
        // 服务端已广播 avatar_changed，页面尚未就绪时无需重复处理。
      }
      return;
    }
    await _mobileKey.currentState?.reloadAvatar();
  }

  /// 切换数字人倾听态：用户说话时头像注视镜头并小幅点头。
  /// 经页面 WS 转到 avatar 服务；数字人开口说话时服务端自动挂起倾听微动。
  Future<void> setListening(bool listening) async {
    final WebviewController? controller = _controller;
    if (controller != null) {
      try {
        await controller.executeScript(
          "window.__avatar && window.__avatar.setListening($listening);",
        );
      } catch (_) {
        // 页面尚未就绪，忽略。
      }
      return;
    }
    await _mobileKey.currentState?.setListening(listening);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _lifecycleActive = state == AppLifecycleState.resumed;
    unawaited(_applyActive());
  }

  @override
  void didUpdateWidget(covariant DigitalHumanView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.mini != oldWidget.mini && Platform.isWindows) {
      _controller?.dispose();
      _controller = null;
      unawaited(_initWebView());
      return;
    }
    if (widget.active != oldWidget.active) unawaited(_applyActive());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    _controller = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!Platform.isWindows) {
      return mobile.DigitalHumanView(
        key: _mobileKey,
        mini: widget.mini,
        active: widget.active,
      );
    }
    final WebviewController? controller = _controller;
    if (_failed || controller == null) {
      // 服务未就绪/初始化中：用 Muse 数字人形象兜底，而不是空白或占位图标。
      return Image.asset(
        "assets/agent_avatars/muse.png",
        width: double.infinity,
        height: double.infinity,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.high,
      );
    }
    return Webview(controller);
  }
}
