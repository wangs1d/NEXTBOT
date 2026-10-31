import "dart:async";
import "dart:convert";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/browser/browser_driver.dart";
import "package:nextbot/core/services/shared_browser_host.dart";
import "package:nextbot/features/browser/browser_page.dart";

/// 可控 href 的假驱动：host 的开/关面板语义测试用（不依赖任何引擎）。
class FakePanelDriver implements BrowserDriver {
  FakePanelDriver({this.href = "about:blank"});

  String href;
  final List<String> loaded = <String>[];
  final List<double> zooms = <double>[];

  @override
  bool get isReady => true;

  @override
  String? get lastError => null;

  @override
  BrowserCapabilities get capabilities => const BrowserCapabilities();

  @override
  Stream<String> get urlStream => const Stream<String>.empty();

  @override
  Stream<String> get titleStream => const Stream<String>.empty();

  @override
  Stream<DriverLoadingState> get loadingStateStream =>
      const Stream<DriverLoadingState>.empty();

  @override
  Future<void> start(BrowserStartOptions options) async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<void> loadUrl(String url) async {
    loaded.add(url);
    href = url;
  }

  @override
  Future<void> goBack() async {}

  @override
  Future<void> goForward() async {}

  @override
  Future<void> reload() async {}

  @override
  Future<void> stopLoading() async {}

  @override
  Future<bool> setZoomFactor(double factor) async {
    zooms.add(factor);
    return true;
  }

  @override
  Future<bool> installDocumentBootstrap(String script) async => true;

  @override
  Future<Uint8List?> captureScreenshot() async => null;

  @override
  Future<dynamic> evaluateScript(String script) async {
    if (script.contains("location.href")) {
      return jsonEncode(<String, String>{"href": href, "title": ""});
    }
    return jsonEncode(<String, String>{
      "readyState": "complete",
      "url": href,
      "title": "",
    });
  }
}

Future<FakePanelDriver> _bootHost({String href = "about:blank"}) async {
  final FakePanelDriver driver = FakePanelDriver(href: href);
  SharedBrowserHost.debugDriverFactory = () => driver;
  final SharedBrowserHost host = SharedBrowserHost.instance;
  host.dispose();
  await host.ensureStarted();
  return driver;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    SharedBrowserHost.debugDriverFactory = null;
  });

  group("面板关闭/重开语义", () {
    test("Agent 驱动的页面：关面板 → 回主页", () async {
      final FakePanelDriver driver = await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      await host.handleServerEvent("shared.browser.busy", <String, dynamic>{
        "busy": true,
      });
      await host.handleServerEvent("shared.browser.busy", <String, dynamic>{
        "busy": false,
      });

      await host.notifyPanelClosed();

      expect(driver.loaded.last, "about:blank");
      expect(host.atHome, isTrue);
    });

    test("用户自己的页面：关面板 → 保留，重开面板不重复导航", () async {
      final FakePanelDriver driver = await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      await host.submitQuery("https://example.com");
      expect(driver.loaded, contains("https://example.com"));

      await host.notifyPanelClosed();
      expect(driver.loaded, isNot(contains("about:blank")));

      // 引擎页还活着：重开面板只同步状态，不再导航
      await host.notifyPanelOpened();
      expect(host.atHome, isFalse);
      expect(
        driver.loaded.where((String u) => u == "https://example.com"),
        hasLength(1),
      );
    });

    test("引擎页被清空后重开面板 → 按记忆的用户页面恢复", () async {
      final FakePanelDriver driver = await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      await host.submitQuery("https://example.com");
      // 模拟引擎页丢失（CDP 侧被关 / 进程重启）：href 空了
      driver.href = "about:blank";
      host.currentUrl.value = "";

      await host.notifyPanelOpened();

      expect(driver.loaded.last, "https://example.com");
      expect(host.atHome, isFalse);
    });

    test("Agent busy 自动开面板时 → 不抢导航权", () async {
      final FakePanelDriver driver = await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      await host.submitQuery("https://example.com");
      driver.href = "about:blank";
      host.currentUrl.value = "";

      await host.handleServerEvent("shared.browser.busy", <String, dynamic>{
        "busy": true,
      });
      final int before = driver.loaded.length;
      await host.notifyPanelOpened();
      expect(driver.loaded.length, before);

      await host.handleServerEvent("shared.browser.busy", <String, dynamic>{
        "busy": false,
      });
    });

    test("用户点主页 → 清记忆，之后重开停在主页", () async {
      final FakePanelDriver driver = await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      await host.submitQuery("https://example.com");
      await host.goHome();
      expect(driver.loaded.last, "about:blank");

      await host.notifyPanelOpened();
      expect(
        driver.loaded.where((String u) => u == "https://example.com"),
        hasLength(1),
      );
      expect(host.atHome, isTrue);
    });
  });

  group("缩放", () {
    test("Ctrl+滚轮档位在 Chrome 阶梯上移动", () async {
      await _bootHost();
      final SharedBrowserHost host = SharedBrowserHost.instance;

      host.zoomFactor.value = 1.0;
      await host.applyZoomStep(1);
      expect(host.zoomFactor.value, 1.1);
      await host.applyZoomStep(-1);
      expect(host.zoomFactor.value, 1.0);
      await host.applyZoomStep(-1);
      expect(host.zoomFactor.value, 0.9);
      await host.applyZoomStep(-1);
      expect(host.zoomFactor.value, 0.8);
      // 到 50% 下边界后不再往下
      for (int i = 0; i < 10; i++) {
        await host.applyZoomStep(-1);
      }
      expect(host.zoomFactor.value, 0.5);
    });

    testWidgets("工具栏缩放胶囊：显示档位，点击回 100%", (WidgetTester tester) async {
      final FakePanelDriver driver = await _bootHost(href: "https://example.com");
      final SharedBrowserHost host = SharedBrowserHost.instance;
      host.zoomFactor.value = 0.9;
      host.currentUrl.value = "https://example.com";

      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BrowserPage(embedded: true)),
      ));
      await tester.pumpAndSettle();

      expect(find.text("90%"), findsOneWidget);
      await tester.tap(find.text("90%"));
      await tester.pumpAndSettle();
      expect(find.text("100%"), findsOneWidget);
      expect(host.zoomFactor.value, 1.0);
      expect(driver.zooms, contains(1.0));
    });
  });
}
