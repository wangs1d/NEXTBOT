import "dart:async";
import "dart:typed_data";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/browser/browser_action_executor.dart";
import "package:nextbot/core/browser/browser_driver.dart";
import "package:nextbot/core/browser/shared_browser_protocol.dart"
    as proto;

/// 按 `SB.<fn>(...)` 调用名分发返回值的假驱动（不依赖任何引擎）。
class FakeDriver implements BrowserDriver {
  FakeDriver({
    this.capabilities = const BrowserCapabilities(),
    Map<String, dynamic>? responses,
  }) : responses = responses ?? <String, dynamic>{};

  @override
  final BrowserCapabilities capabilities;

  /// fn 名 → 每次调用的返回值队列（耗尽后取最后一个）或固定值。
  final Map<String, dynamic> responses;

  final List<String> scripts = [];
  final List<String> loadedUrls = [];
  final List<String> bootstraps = [];

  /// probe 的默认响应（未被 responses 覆盖时）。
  Map<String, dynamic> probeResponse = <String, dynamic>{"found": false};

  @override
  bool get isReady => true;

  @override
  String? get lastError => null;

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
  Future<void> loadUrl(String url) async => loadedUrls.add(url);

  @override
  Future<void> goBack() async {}

  @override
  Future<void> goForward() async {}

  @override
  Future<void> reload() async {}

  @override
  Future<void> stopLoading() async {}

  @override
  Future<bool> installDocumentBootstrap(String script) async {
    bootstraps.add(script);
    return capabilities.documentBootstrap;
  }

  @override
  Future<Uint8List?> captureScreenshot() async =>
      capabilities.screenshot ? Uint8List.fromList(<int>[1, 2, 3]) : null;

  @override
  Future<dynamic> evaluateScript(String script) async {
    scripts.add(script);
    final RegExpMatch? m =
        RegExp(r"SB\.(\w+)\(").firstMatch(script);
    final String fn = m?.group(1) ?? "";
    if (fn == "pageState") {
      return const <String, dynamic>{
        "url": "https://example.com/a",
        "title": "T",
        "readyState": "complete",
        "scrollY": 0,
        "scrollHeight": 100,
      };
    }
    if (!responses.containsKey(fn)) {
      if (fn == "probe") return probeResponse;
      return const <String, dynamic>{};
    }
    final dynamic v = responses[fn];
    if (v is List) {
      // 队列语义：逐个返回，最后一项无限重复（模拟"晚出现后一直存在"）
      return v.isEmpty
          ? <String, dynamic>{}
          : (v.length > 1 ? v.removeAt(0) : v.first);
    }
    return v;
  }
}

BrowserActionExecutor makeExecutor(
  FakeDriver driver, {
  List<proto.SbActionTrace>? traces,
  int waitMs = 120,
}) {
  return BrowserActionExecutor(
    driver: driver,
    runtimeSource: "function __installSharedBrowser(){}",
    onTrace: traces?.add,
    defaultWaitTimeoutMs: waitMs,
    pollIntervalMs: 5,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group("BrowserActionExecutor.navigate", () {
    test("非法 URL 返回 BAD_PARAMS 且不加载", () async {
      final FakeDriver driver = FakeDriver();
      final e = makeExecutor(driver);
      final r = await e.perform(proto.SbActions.navigate,
          <String, dynamic>{"url": "javascript:alert(1)"});
      expect(r["ok"], false);
      expect(r["code"], proto.SbErrors.badParams);
      expect(driver.loadedUrls, isEmpty);
    });

    test("合法 URL 加载并等待稳定 + 安装 _blank 拦截", () async {
      final FakeDriver driver = FakeDriver();
      final e = makeExecutor(driver);
      final r = await e.perform(proto.SbActions.navigate,
          <String, dynamic>{"url": "example.com"});
      expect(r["ok"], true);
      expect(driver.loadedUrls, <String>["https://example.com"]);
      expect(driver.scripts.join("\n"), contains("interceptBlank"));
    });
  });

  group("BrowserActionExecutor.click", () {
    test("元素晚出现：等待循环内重试直到 probe found 再点击", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["probe"] = <dynamic>[
        <String, dynamic>{"found": false},
        <String, dynamic>{
          "found": true,
          "ref": "e1",
          "text": "登录",
          "disabled": false,
          "covered": false,
        },
      ];
      driver.responses["clickAt"] = <String, dynamic>{"clicked": true, "ref": "e1"};
      final e = makeExecutor(driver, waitMs: 2000);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"text": "登录"});
      expect(r["ok"], true);
      expect(r["ref"], "e1");
      expect(driver.scripts.join("\n"), contains("SB.clickAt("));
    });

    test("禁用元素返回 DISABLED 且不点击", () async {
      final FakeDriver driver = FakeDriver();
      driver.probeResponse = <String, dynamic>{
        "found": true,
        "ref": "e2",
        "disabled": true,
        "covered": false,
      };
      final e = makeExecutor(driver, waitMs: 100);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"text": "提交"});
      expect(r["ok"], false);
      expect(r["code"], proto.SbErrors.disabled);
      expect(driver.scripts.join("\n"), isNot(contains("SB.clickAt(")));
    });

    test("持续被遮挡返回 COVERED", () async {
      final FakeDriver driver = FakeDriver();
      driver.probeResponse = <String, dynamic>{
        "found": true,
        "ref": "e3",
        "disabled": false,
        "covered": true,
        "coverer": "弹窗",
      };
      final e = makeExecutor(driver, waitMs: 80);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"text": "购买"});
      expect(r["ok"], false);
      expect(r["code"], proto.SbErrors.covered);
      expect(r["error"], contains("弹窗"));
    });

    test("ref 失效且无其他线索 → 提示重新 read_page", () async {
      final FakeDriver driver = FakeDriver();
      driver.probeResponse = <String, dynamic>{"found": false, "staleRef": true};
      final e = makeExecutor(driver, waitMs: 60);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"ref": "e9"});
      expect(r["ok"], false);
      expect(r["code"], proto.SbErrors.notFound);
      expect(r["error"], contains("read_page"));
    });

    test("缺定位参数返回 BAD_PARAMS", () async {
      final FakeDriver driver = FakeDriver();
      final e = makeExecutor(driver);
      final r = await e.perform(proto.SbActions.click, <String, dynamic>{});
      expect(r["code"], proto.SbErrors.badParams);
    });
  });

  group("BrowserActionExecutor.type", () {
    test("输入成功并回读校验", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["typeInto"] = <String, dynamic>{
        "typed": true,
        "ref": "e4",
        "value": "hello",
      };
      final e = makeExecutor(driver);
      final r = await e.perform(
          proto.SbActions.type, <String, dynamic>{"text": "hello"});
      expect(r["ok"], true);
      expect(r["value"], "hello");
    });

    test("页面吞输入 → 重试后仍为空返回 VERIFY_FAILED", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["typeInto"] = <String, dynamic>{
        "typed": true,
        "value": "",
      };
      final e = makeExecutor(driver, waitMs: 500);
      final r = await e.perform(
          proto.SbActions.type, <String, dynamic>{"text": "hello"});
      expect(r["ok"], false);
      expect(r["code"], proto.SbErrors.verifyFailed);
    });
  });

  group("BrowserActionExecutor.read_page / export_state", () {
    test("read_page 透传分页字段与元素", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["read"] = <String, dynamic>{
        "url": "https://example.com/a",
        "title": "T",
        "text": "正文",
        "offset": 4000,
        "total": 9000,
        "hasMore": true,
        "elements": <dynamic>[
          <String, dynamic>{"ref": "e1", "tag": "a", "text": "下一页"}
        ],
        "elementTotal": 1,
      };
      final e = makeExecutor(driver);
      final r = await e.perform(proto.SbActions.readPage,
          <String, dynamic>{"offset": 4000});
      expect(r["ok"], true);
      expect(r["hasMore"], true);
      expect((r["elements"] as List).length, 1);
    });

    test("export_state 附带 HttpOnly 限制说明", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["exportState"] = <String, dynamic>{
        "origin": "https://example.com",
        "cookie": "a=1",
        "localStorage": <String, dynamic>{},
        "sessionStorage": <String, dynamic>{},
        "limited": true,
      };
      final e = makeExecutor(driver);
      final r = await e.perform(proto.SbActions.exportState, <String, dynamic>{});
      expect(r["ok"], true);
      expect(r["limited"], true);
      expect(r["note"], contains("HttpOnly"));
    });
  });

  group("BrowserActionExecutor 失败截图与轨迹", () {
    test("引擎有截图能力时失败结果附 PNG", () async {
      final FakeDriver driver = FakeDriver(
        capabilities: const BrowserCapabilities(screenshot: true),
      );
      driver.probeResponse = <String, dynamic>{"found": false};
      final e = makeExecutor(driver, waitMs: 40);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"text": "x"});
      expect(r["ok"], false);
      expect(r["screenshotPng"], isNotNull);
    });

    test("引擎无截图能力时标记 screenshotAvailable=false", () async {
      final FakeDriver driver = FakeDriver();
      driver.probeResponse = <String, dynamic>{"found": false};
      final e = makeExecutor(driver, waitMs: 40);
      final r = await e.perform(
          proto.SbActions.click, <String, dynamic>{"text": "x"});
      expect(r["screenshotAvailable"], false);
    });

    test("每次动作发出轨迹（含耗时与结果）", () async {
      final FakeDriver driver = FakeDriver();
      driver.responses["probe"] = <String, dynamic>{
        "found": true,
        "ref": "e1",
        "text": "登录",
        "disabled": false,
        "covered": false,
      };
      driver.responses["clickAt"] = <String, dynamic>{"clicked": true};
      final traces = <proto.SbActionTrace>[];
      final e = makeExecutor(driver, traces: traces);
      await e.perform(proto.SbActions.click, <String, dynamic>{"text": "登录"});
      expect(traces, hasLength(1));
      expect(traces.first.ok, true);
      expect(traces.first.target, "登录");
    });
  });
}
