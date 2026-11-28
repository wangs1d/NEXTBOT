import "dart:async";

import "package:flutter/foundation.dart" show Factory;
import "package:flutter/gestures.dart" show OneSequenceGestureRecognizer;
import "package:flutter/material.dart";
import "package:webview_flutter/webview_flutter.dart";

import "../../core/config/api_config.dart";

class DigitalHumanView extends StatefulWidget {
  const DigitalHumanView({
    super.key,
    this.mini = false,
    this.active = true,
  });

  final bool mini;
  final bool active;

  /// 数字人页面地址（mini = 圆框流，detail = 完整舞台）。
  /// 抽成纯函数便于单测锁定「桌面/手机共用同一条本地服务链路」。
  @visibleForTesting
  static Uri resolveUri({required bool mini, String? base}) {
    return Uri.parse(base ?? ApiConfig.digitalHumanBase)
        .resolve(mini ? "/?mode=mini" : "/?mode=detail");
  }

  @override
  State<DigitalHumanView> createState() => DigitalHumanViewState();
}

class DigitalHumanViewState extends State<DigitalHumanView>
    with WidgetsBindingObserver {
  WebViewController? _controller;
  bool _lifecycleActive = true;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_init());
  }

  Future<void> _init() async {
    try {
      final Uri uri =
          DigitalHumanView.resolveUri(mini: widget.mini);
      final WebViewController controller = WebViewController()
        ..setBackgroundColor(Colors.transparent)
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setNavigationDelegate(NavigationDelegate(
          onNavigationRequest: (NavigationRequest request) {
            final Uri? target = Uri.tryParse(request.url);
            return target?.origin == uri.origin
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onPageFinished: (_) => unawaited(_applyActive()),
        ))
        ..loadRequest(uri);
      if (!mounted) return;
      setState(() {
        _controller = controller;
        _failed = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _failed = true);
    }
  }

  Future<void> _applyActive() async {
    final WebViewController? controller = _controller;
    if (controller == null) return;
    final bool active = widget.active && _lifecycleActive;
    try {
      await controller.runJavaScript(
        "window.__avatar && window.__avatar.setPaused(${!active});",
      );
    } catch (_) {
      // 页面切换期间 WebView 可能已销毁。
    }
  }

  Future<void> reloadAvatar() async {
    final WebViewController? controller = _controller;
    if (controller == null) return;
    try {
      await controller.runJavaScript(
        "window.__avatar && window.__avatar.reloadAvatar();",
      );
    } catch (_) {
      // 服务端已广播 avatar_changed，页面尚未就绪时无需重复处理。
    }
  }

  /// 切换数字人倾听态：用户说话时头像注视镜头并小幅点头。
  /// 经页面 WS 转到 avatar 服务；数字人开口说话时服务端自动挂起倾听微动。
  Future<void> setListening(bool listening) async {
    final WebViewController? controller = _controller;
    if (controller == null) return;
    try {
      await controller.runJavaScript(
        "window.__avatar && window.__avatar.setListening($listening);",
      );
    } catch (_) {
      // 页面切换期间 WebView 可能已销毁。
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _lifecycleActive = state == AppLifecycleState.resumed;
    unawaited(_applyActive());
  }

  @override
  void didUpdateWidget(covariant DigitalHumanView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.mini != oldWidget.mini) {
      unawaited(_init());
      return;
    }
    if (widget.active != oldWidget.active) unawaited(_applyActive());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final WebViewController? controller = _controller;
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
    return WebViewWidget(
      controller: controller,
      gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
    );
  }
}
