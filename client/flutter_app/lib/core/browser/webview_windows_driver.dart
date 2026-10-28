import "dart:async";
import "dart:typed_data";

import "package:webview_windows/webview_windows.dart" as ww;

import "../services/windows_webview_bootstrap_io.dart"
    show bootstrapWindowsWebView, webviewAdditionalArguments;
import "browser_driver.dart";

/// webview_windows（WebView2）适配器。
///
/// 这是唯一允许 import `webview_windows` 插件的动作层文件：
/// 插件类型（WebviewController/LoadingState）在这里被翻译成端口协议，
/// 上层（执行器/宿主/协议）不出现任何引擎类型。换引擎 = 新增一个
/// BrowserDriver 实现类 + 在 SharedBrowserHost 里换一行构造。
class WebviewWindowsDriver implements BrowserDriver {
  final ww.WebviewController _controller = ww.WebviewController();
  final StreamController<String> _url = StreamController<String>.broadcast();
  final StreamController<String> _title = StreamController<String>.broadcast();
  final StreamController<DriverLoadingState> _loading =
      StreamController<DriverLoadingState>.broadcast();
  StreamSubscription<dynamic>? _urlSub;
  StreamSubscription<String>? _titleSub;
  StreamSubscription<ww.LoadingState>? _loadingSub;

  bool _ready = false;
  String? _error;

  @override
  BrowserCapabilities get capabilities => const BrowserCapabilities(
        // webview_windows 0.4.0 未暴露 capturePreview/CookieManager；
        // 换引擎（或升级插件）后在各自适配器里翻开关即可，上层零改动。
        screenshot: false,
        documentBootstrap: true,
      );

  @override
  bool get isReady => _ready;

  @override
  String? get lastError => _error;

  @override
  Stream<String> get urlStream => _url.stream;

  @override
  Stream<String> get titleStream => _title.stream;

  @override
  Stream<DriverLoadingState> get loadingStateStream => _loading.stream;

  /// 引擎控制器（仅供渲染层 Webview 组件挂载使用，动作层禁止使用）。
  ww.WebviewController get controller => _controller;

  @override
  Future<void> start(BrowserStartOptions options) async {
    if (_ready) return;
    // 环境只初始化一次；CDP 等附加参数必须在首个控制器创建前传入
    if (options.additionalArguments != null) {
      webviewAdditionalArguments = options.additionalArguments;
    }
    await bootstrapWindowsWebView();
    await _controller.initialize();
    await _controller.setPopupWindowPolicy(ww.WebviewPopupWindowPolicy.deny);
    await _controller.loadUrl("about:blank");

    _urlSub?.cancel();
    _urlSub = _controller.url.listen(_url.add);
    _titleSub?.cancel();
    _titleSub = _controller.title.listen(_title.add);
    _loadingSub?.cancel();
    _loadingSub = _controller.loadingState.listen((ww.LoadingState s) {
      switch (s) {
        case ww.LoadingState.none:
          _loading.add(DriverLoadingState.idle);
        case ww.LoadingState.loading:
          _loading.add(DriverLoadingState.loading);
        case ww.LoadingState.navigationCompleted:
          _loading.add(DriverLoadingState.loaded);
      }
    });

    // 文档级常驻安装注入运行时（每个新文档自动可用；动作前仍有幂等内联兜底）
    final String? bootstrapScript = options.documentBootstrapScript;
    if (bootstrapScript != null && bootstrapScript.isNotEmpty) {
      await installDocumentBootstrap(bootstrapScript);
    }
    // 2026-10-28 根因修复：上面的 loadUrl("about:blank") 先于 bootstrap 注册
    // 执行，首屏文档拿不到注入标记 → 服务端 CDP 桥无法按
    // window.__NB_SHARED_PANEL__ 识别面板页。这里给已存在的首屏文档补打
    // 标记（后续导航由 bootstrap 自动携带）。
    try {
      await _controller.executeScript("window.__NB_SHARED_PANEL__ = true;");
    } catch (_) {
      // 引擎未就绪等异常不阻塞启动；bootstrap 会在下个文档补上
    }
    _ready = true;
  }

  @override
  Future<void> dispose() async {
    await _urlSub?.cancel();
    await _titleSub?.cancel();
    await _loadingSub?.cancel();
    try {
      await _controller.dispose();
    } catch (_) {}
    _ready = false;
  }

  @override
  Future<void> loadUrl(String url) => _controller.loadUrl(url);

  @override
  Future<void> goBack() => _controller.goBack();

  @override
  Future<void> goForward() => _controller.goForward();

  @override
  Future<void> reload() => _controller.reload();

  @override
  Future<void> stopLoading() => _controller.stop();

  @override
  Future<dynamic> evaluateScript(String script) =>
      _controller.executeScript(script);

  @override
  Future<bool> installDocumentBootstrap(String script) async {
    try {
      await _controller.addScriptToExecuteOnDocumentCreated(script);
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Uint8List?> captureScreenshot() async => null;
}
