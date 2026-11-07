import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart" show Factory;
import "package:flutter/gestures.dart"
    show OneSequenceGestureRecognizer;
import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle;
import "package:webview_flutter/webview_flutter.dart";

/// EmotionBallView —— Android/iOS 实现：webview_flutter 内嵌 emotion-ball
/// 表情球引擎。
///
/// 与桌面 Windows WebView2 实现（emotion_ball_view_io.dart）共用同一份
/// 自包含宿主页 `assets/emotion_ball/host.html`（全部引擎 JS 内联、无外部
/// 依赖），经 `loadHtmlString` 加载，表情切换走
/// `window.__ball.setEmotion(id)`，保证两端表情视觉完全一致。
class EmotionBallViewMobile extends StatefulWidget {
  const EmotionBallViewMobile({
    super.key,
    this.emotion = "02",
    this.size,
    this.bodyColor,
    this.eyeColor,
    this.showEffects = false,
    this.eyeScale,
    this.fitBounce = false,
  });

  /// 当前表情 ID（emotion-ball 的 emotionId，如 "02" 待机 / "30" 思考中）。
  final String emotion;

  /// 小球显示尺寸（正方形边长），null 时撑满父级约束。
  final double? size;

  /// 球体主题色（传入后眼球默认白色）；null 时用引擎默认配色。
  final Color? bodyColor;
  final Color? eyeColor;

  /// 彩带/撒花等特效层，默认关闭：小尺寸下特效会被裁成杂色碎片。
  final bool showEffects;

  /// 眼睛占比放大系数（小尺寸下保证表情可读）。
  final double? eyeScale;

  /// 弹跳头顶余量：扩高画布给弹跳顶点留空间。
  final bool fitBounce;

  @override
  State<EmotionBallViewMobile> createState() => _EmotionBallViewMobileState();
}

class _EmotionBallViewMobileState extends State<EmotionBallViewMobile> {
  WebViewController? _controller;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  Future<void> _init() async {
    try {
      final String html = await _buildHostHtml();
      final WebViewController controller = WebViewController()
        ..setBackgroundColor(Colors.transparent)
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        // 表情引擎无外链；拦截意外导航（如引擎异常跳 http(s)）防吃掉交互。
        ..setNavigationDelegate(
          NavigationDelegate(
            onNavigationRequest: (NavigationRequest request) {
              final Uri uri = Uri.parse(request.url);
              if (uri.scheme == "http" || uri.scheme == "https") {
                return NavigationDecision.prevent;
              }
              return NavigationDecision.navigate;
            },
          ),
        )
        ..loadHtmlString(html);
      if (!mounted) return;
      setState(() => _controller = controller);
    } catch (_) {
      // WebView 初始化失败：保持占位透明，不挡聊天。
    }
  }

  /// 生成注入 boot 配置后的宿主 HTML（初始表情/体色一次性写入）。
  Future<String> _buildHostHtml() async {
    final String html = await rootBundle
        .loadString("assets/emotion_ball/host.html");
    final Map<String, Object?> boot = <String, Object?>{
      "emotion": widget.emotion,
      if (widget.bodyColor != null) "bodyColor": _hex(widget.bodyColor!),
      if (widget.eyeColor != null) "eyeColor": _hex(widget.eyeColor!),
      if (widget.showEffects) "effects": true,
      if (widget.eyeScale != null) "eyeScale": widget.eyeScale,
      if (widget.fitBounce) "fitBounce": true,
    };
    return html.replaceAll("__BALL_BOOT_JSON__", jsonEncode(boot));
  }

  static String _hex(Color color) {
    // RGB 十六进制（ARGB 掩掉 alpha）；桌面 io 实现里曾误写 18 进制导致
    // 体色失效，此处用正确进制，两端引擎收到的都是合法 #rrggbb。
    return "#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, "0")}";
  }

  @override
  void didUpdateWidget(covariant EmotionBallViewMobile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.bodyColor != oldWidget.bodyColor ||
        widget.eyeColor != oldWidget.eyeColor ||
        widget.showEffects != oldWidget.showEffects ||
        widget.fitBounce != oldWidget.fitBounce) {
      // 主题色/特效开关/画布余量只在引擎构造时生效，变化需要重建页面。
      _controller = null;
      unawaited(_init());
      return;
    }
    final WebViewController? controller = _controller;
    if (widget.emotion != oldWidget.emotion && controller != null) {
      final String id = widget.emotion.replaceAll("'", "");
      unawaited(
        controller.runJavaScript(
          "window.__ball && window.__ball.setEmotion('$id');",
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final WebViewController? controller = _controller;
    if (controller == null) {
      // 初始化中或失败：保持占位尺寸但完全透明，避免出现任何杂色图形。
      return SizedBox(width: widget.size, height: widget.size);
    }
    return SizedBox(
      width: widget.size,
      height: widget.size,
      // gestureRecognizers 置空：WebView 不认领任何手势，列表滚动/胶囊点击
      // 全部穿透，小球只负责播放表情。
      child: WebViewWidget(
        controller: controller,
        gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
      ),
    );
  }
}
