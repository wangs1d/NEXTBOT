/// 浏览器驱动端口（framework-free）。
library;

import "dart:typed_data";
///
/// 动作编排层（[BrowserActionExecutor]）、协议层与注入运行时都只依赖本抽象；
/// 具体引擎（webview_windows / flutter_inappwebview / WebView2 直托管 / 其他）
/// 通过实现 [BrowserDriver] 接入，换引擎时动作层零改动。
///
/// 约定：
///   - 全部方法幂等友好（start 可重复调用）
///   - 引擎不支持的能力通过 [BrowserCapabilities] 声明 false，
///     执行器据此自动降级（如无截图能力则失败结果不带截图），而非报错
///   - evaluateScript 的入参/出参都是纯 JS 与 JSON 可序列化值，不含引擎类型

/// 页面加载状态（引擎枚举的协议化映射）。
enum DriverLoadingState { idle, loading, loaded, error }

/// 引擎能力声明。
class BrowserCapabilities {
  const BrowserCapabilities({
    this.screenshot = false,
    this.documentBootstrap = false,
  });

  /// [BrowserDriver.captureScreenshot] 可用（返回非 null）。
  final bool screenshot;

  /// 支持按「文档创建即执行」常驻安装脚本（如 WebView2 的
  /// addScriptToExecuteOnDocumentCreated）。不支持时执行器退化为
  /// 每次动作前内联安装。
  final bool documentBootstrap;
}

/// 驱动启动参数（引擎无关）。
class BrowserStartOptions {
  const BrowserStartOptions({
    this.documentBootstrapScript,
    this.additionalArguments,
  });

  /// 文档级常驻脚本（能力支持时生效）。
  final String? documentBootstrapScript;

  /// 引擎附加启动参数（如 WebView2 的 --remote-debugging-port）。
  /// 仅在引擎环境尚未初始化时生效（进程内只初始化一次）。
  final String? additionalArguments;
}

/// 浏览器引擎适配端口。
abstract class BrowserDriver {
  BrowserCapabilities get capabilities;

  bool get isReady;

  String? get lastError;

  Stream<String> get urlStream;

  Stream<String> get titleStream;

  Stream<DriverLoadingState> get loadingStateStream;

  /// 幂等启动。环境级参数（[BrowserStartOptions.additionalArguments]）只在
  /// 引擎环境首次初始化时有效，因此应在进程启动早期调用。
  Future<void> start(BrowserStartOptions options);

  Future<void> dispose();

  Future<void> loadUrl(String url);

  Future<void> goBack();

  Future<void> goForward();

  Future<void> reload();

  Future<void> stopLoading();

  /// 设置页面缩放（1.0 = 100%）。引擎不支持时返回 false。
  Future<bool> setZoomFactor(double factor);

  /// 在当前页面上下文执行 JS，返回 JSON 可序列化结果（异步引擎实现应等待求值完成）。
  Future<dynamic> evaluateScript(String script);

  /// 按「文档创建即执行」安装脚本；能力不支持时返回 false。
  Future<bool> installDocumentBootstrap(String script);

  /// 截取当前帧（PNG 字节）；能力不支持时返回 null。
  Future<Uint8List?> captureScreenshot();
}
