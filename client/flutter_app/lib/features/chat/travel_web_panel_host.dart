import "dart:async";
import "dart:io" show Platform;
import "dart:ui" show Color;

import "package:webview_windows/webview_windows.dart";

import "../../core/config/api_config.dart";
import "travel_web_panel_controller.dart";

/// 整页 WebView 行程面板的进程级共享宿主（单例）。
///
/// webview_windows 为 Composition 模式：控制器持有渲染纹理，可被不同挂载点
/// （右侧面板 / 全屏页）按需渲染同一内容。面板与全屏共用同一实例 ——
/// 打开/关闭面板、进出全屏都不再重新加载地图（页面常驻），
/// 仅在 loadPlan 时切换数据。
///
/// 页面单一来源：加载本机 server 的 /travel-map/desktop?host=1（行迹桌面页，
/// 与行程卡点击进入的独立窗口同一份页面；不再打包第二份 HTML 资产）。
/// 宿主模式下数据由 Dart 桥 loadPlan 注入，不走 ?id= 取数；
/// 实拍图/瓦片代理与页面同源直连，无需任何地址注入。
///
/// 预加载：[preload] 后台初始化（隐藏渲染），首次打开面板零等待。
///
/// ⚠️ 只允许在「确定要用 WebView 的时机」调用（行程独立子进程启动时）。
/// 主应用禁止在启动/首页 initState 里预加载：WebView2 一旦创建就会产生
/// 内部顶层窗口，若滞留屏幕会变成透明"幽灵窗"拦截其他应用的点击
/// （曾实测盖住左半屏）；主进程路径由 TravelPlanPanel 挂载时懒加载兜底。
/// 兜底之兜底：runner 常驻 WebViewGhostGuard 看门狗会自动中和滞留窗口，
/// 即使幽灵窗再出现也不会拦截其他应用的点击。
class TravelWebPanelHost {
  TravelWebPanelHost._();

  static final TravelWebPanelHost instance = TravelWebPanelHost._();

  final TravelWebPanelController controller = TravelWebPanelController();

  WebviewController? _webviewController;
  StreamSubscription<dynamic>? _messageSub;
  Future<void>? _starting;
  String? _error;

  /// WebView 是否已初始化完成（可挂载 Webview 渲染）。
  bool get isInitialized => _webviewController != null;

  /// 共享 WebView 控制器（未初始化完成时为 null）。
  WebviewController? get webviewController => _webviewController;

  /// 初始化错误（宿主渲染占位提示用）。
  String? get error => _error;

  /// 幂等启动：App 启动/首次使用时调用，后台加载行程桌面页 + 地图。
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

  /// 进程级预加载入口（幂等，可在任意时机调用）。
  static void preload() {
    unawaited(instance.ensureStarted());
  }

  Future<void> _start() async {
    try {
      final WebviewController webviewController = WebviewController();
      await webviewController.initialize();
      await webviewController.setBackgroundColor(const Color(0xFF0B1220));
      await webviewController.setPopupWindowPolicy(
        WebviewPopupWindowPolicy.deny,
      );

      // JS → Dart：webMessage 事件转发给控制器分发
      _messageSub?.cancel();
      _messageSub = webviewController.webMessage.listen(
        controller.handleWebMessage,
      );

      // 加载本机 server 页面（单一来源）。host 模式：数据由 Dart 桥 loadPlan
      // 注入，页面不显示"未携带行程参数"空态。_cb 时间戳穿透长缓存：
      // 页面声明 max-age=86400，不带穿透参数时页面更新（路线/标点逻辑修订）
      // 会被 WebView2 磁盘缓存压住最长一天。
      // 桌面页 = /travel-map/desktop（「行迹」桌面版，行程独立窗口的 1:1 呈现）。
      final Uri base = Uri.parse(ApiConfig.httpBase);
      final Uri pageUri = base.replace(
        path: "${base.path}/travel-map/desktop".replaceAll("//", "/"),
        queryParameters: <String, String>{
          "host": "1",
          "_cb": DateTime.now().millisecondsSinceEpoch.toString(),
        },
      );
      await webviewController.loadUrl(pageUri.toString());

      // 等待页面脚本就绪（server 未启动/未就绪时导航不完成，executeScript
      // 会持续抛错）。约 12s 宽限，覆盖应用启动时 server 的拉起窗口。
      var pageReady = false;
      for (var attempt = 0; attempt < 24; attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
        try {
          final String probe = await webviewController
              .executeScript("window.__travelPanel ? '1' : '0'");
          if (probe.contains('1')) {
            pageReady = true;
            break;
          }
        } catch (_) {/* 页面尚未就绪，继续等 */}
      }
      if (!pageReady) {
        _error = "行程页面加载失败：本机服务未就绪（$pageUri）\n请确认应用服务已启动后重开行程";
        return;
      }

      // Dart → JS：注入脚本执行器（loadPlan 由各面板挂载点下发，未就绪时入队）
      await controller.attach(
        (String script) => webviewController.executeScript(script),
      );

      _webviewController = webviewController;
    } catch (e) {
      _error = "面板 WebView 初始化失败\n$e";
    }
  }
}
