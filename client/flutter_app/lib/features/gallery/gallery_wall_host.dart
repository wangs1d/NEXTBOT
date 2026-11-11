import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;
import "dart:io" show Platform;
import "dart:ui" show Color;

import "package:webview_windows/webview_windows.dart";

import "../../core/config/api_config.dart";
import "../../core/config/media_url.dart";

/// 3D 照片墙 WebView 宿主（进程级单例），模式与 [TravelWebPanelHost] 相同：
/// webview_windows Composition 模式，渲染纹理可被不同挂载点复用；
/// 页面单一来源 = 本机 server 的 /gallery-wall?host=1（自包含 HTML +
/// 本地 three.js vendor，无 CDN 依赖）。
///
/// ⚠️ 只允许在「确定要打开图库 tab」的时机懒启动（首次切入时）：
/// WebView2 创建即产生内部顶层窗口，启动期预加载会变成透明"幽灵窗"
/// 拦截其他应用点击（历史实测教训，见 TravelWebPanelHost 注释）。
///
/// Dart ⇄ JS 桥（页面侧 window.__galleryWall）：
///   Dart → JS : setPaused(bool) 离开 tab 暂停渲染省 GPU / flyToPhoto(id) 定位
///   JS → Dart : wallReady / openGrid(photoId) 回传管理视图切换意图
class GalleryWallHost {
  GalleryWallHost._();

  static final GalleryWallHost instance = GalleryWallHost._();

  WebviewController? _controller;
  StreamSubscription<dynamic>? _messageSub;
  Future<void>? _starting;
  String? _error;

  /// 页面 openGrid 意图回调（切到 2D 管理视图），由工作台页注册。
  void Function(String? photoId)? onOpenGrid;

  bool get isInitialized => _controller != null;

  WebviewController? get controller => _controller;

  String? get error => _error;

  /// 幂等启动：首次切入图库 tab 时调用。
  Future<void> ensureStarted() {
    final Future<void>? starting = _starting;
    if (starting != null) return starting;
    if (!Platform.isWindows) {
      _starting = Future<void>.value();
      return _starting!;
    }
    _starting = _start();
    return _starting!;
  }

  Future<void> _start() async {
    try {
      final WebviewController webviewController = WebviewController();
      await webviewController.initialize();
      await webviewController.setBackgroundColor(const Color(0xFF0A0A0A));
      await webviewController.setPopupWindowPolicy(
        WebviewPopupWindowPolicy.deny,
      );

      // JS → Dart：页面回传 openGrid（去管理视图）/ wallReady
      _messageSub?.cancel();
      _messageSub = webviewController.webMessage.listen(_handleWebMessage);

      // _cb 时间戳穿透长缓存：panel.html 服务端声明 max-age=3600，
      // 页面逻辑修订后不带穿透参数会被 WebView2 磁盘缓存压住。
      final Uri base = Uri.parse(ApiConfig.httpBase);
      final Uri pageUri = base.replace(
        path: "${base.path}/gallery-wall".replaceAll("//", "/"),
        queryParameters: <String, String>{
          "host": "1",
          // 页面与页内 /gallery-wall/layout、`<img>` 都要身份：
          // 有 token 时带 token（服务端会钉成同站 Cookie 并把 userId 钉成归属），
          // 未登录时带设备标识；邮箱不再进 URL，避免写进访问日志。
          ...MediaUrl.queryCredentials,
          "_cb": DateTime.now().millisecondsSinceEpoch.toString(),
        },
      );
      await webviewController.loadUrl(pageUri.toString());

      // 等页面脚本就绪（覆盖 server 拉起窗口），约 12s 宽限
      var pageReady = false;
      for (var attempt = 0; attempt < 24; attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
        try {
          final String probe = await webviewController
              .executeScript("window.__galleryWall ? '1' : '0'");
          if (probe.contains('1')) {
            pageReady = true;
            break;
          }
        } catch (_) {/* 页面尚未就绪，继续等 */}
      }
      if (!pageReady) {
        _error = "照片墙加载失败：本机服务未就绪\n请确认应用服务已启动后重试图库";
        return;
      }

      _controller = webviewController;
    } catch (e) {
      _error = "照片墙 WebView 初始化失败\n$e";
    }
  }

  void _handleWebMessage(dynamic message) {
    if (onOpenGrid == null) return;
    try {
      final dynamic decoded = message is String
          ? jsonDecode(message)
          : message;
      if (decoded is Map && decoded["type"] == "openGrid") {
        final Object? photoId = decoded["photoId"];
        onOpenGrid!(photoId is String && photoId.isNotEmpty ? photoId : null);
      }
    } catch (_) {/* 非 JSON 消息忽略 */}
  }

  Future<void> _run(String script) async {
    final WebviewController? webviewController = _controller;
    if (webviewController == null) return;
    try {
      await webviewController.executeScript(script);
    } catch (_) {/* 页面未就绪时静默 */}
  }

  /// 离开/回到图库 tab：暂停页面渲染循环与墙内视频（省 GPU）。
  Future<void> setPaused(bool paused) =>
      _run("window.__galleryWall && window.__galleryWall.setPaused(${paused ? 'true' : 'false'});");

  /// 聊天/预览联动：飞到指定照片。
  Future<void> flyToPhoto(String photoId) => _run(
      "window.__galleryWall && window.__galleryWall.flyToPhoto(${jsonEncode(photoId)});");

  /// 新照片/新分析后刷新布局（页面重取 /gallery-wall/layout）。
  Future<void> refresh() =>
      _run("window.__galleryWall && window.__galleryWall.refresh();");
}
