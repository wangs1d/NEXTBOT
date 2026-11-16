// 「Agent 正在控制浏览器」右上角悬浮窗 · 真壳视觉实测。
//
// 渲染**真实** MobileHomePage + **真实** MobileChatController（自建 WS 连接），
// 重放真链探针（scratch/probe-mobile-browser-preview.mjs）抓到的真实事件序列
// （agent_browser tool.call + 全视口预览帧），截图落盘供人眼核验：
// 悬浮窗是否出现在右上角、画面是否完整、与 NEXTBOT 黑底白字风格是否一致。
library;

import "dart:convert";
import "dart:io";
import "dart:typed_data";
import "dart:ui" as ui;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart";
import "package:flutter_test/flutter_test.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_browser_preview_overlay.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_home.dart";

import "helpers/temp_path_provider.dart";

/// 空历史存储：不碰本机共享 Isar。
class _EmptyHistoryStore implements LocalHistoryStore {
  @override
  dynamic noSuchMethod(Invocation invocation) {
    final Symbol member = invocation.memberName;
    if (member == #listSessions) {
      return Future<List<ChatSession>>.value(<ChatSession>[]);
    }
    if (member == #listMessages) {
      return Future<List<ChatMessage>>.value(<ChatMessage>[]);
    }
    if (member == #migrateAssistantTimestampFrames) {
      return Future<int>.value(0);
    }
    return Future<dynamic>.value(null);
  }
}

HttpServer? _wsServer;

/// 真链探针抓到的真实帧（example.com 全视口截图，JPEG）。
final String _realFrameBase64 =
    base64Encode(File("test/fixtures/browser_preview_frame.jpg").readAsBytesSync());

void main() {
  setUpAll(() async {
    _wsServer = await HttpServer.bind("127.0.0.1", 0);
    _wsServer!.listen((HttpRequest req) async {
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        final WebSocket ws = await WebSocketTransformer.upgrade(req);
        ws.listen((_) {});
      } else {
        await req.response.close();
      }
    });
  });

  tearDownAll(() async {
    await _wsServer?.close(force: true);
    _wsServer = null;
  });

  setUp(() {
    PathProviderPlatform.instance = TempPathProviderPlatform();
  });

  testWidgets("浏览器任务中：右上角悬浮窗出现并展示真实页面帧", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final MobileChatController controller = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${_wsServer!.port}",
      historyStore: _EmptyHistoryStore(),
    );
    // 不 addTearDown(dispose)：MobileHomePage.dispose 会释放注入的控制器，
    // 这里再释放一次会 double-dispose（connection ValueNotifier 二次销毁）。

    final GlobalKey repaintKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: repaintKey,
          child: MobileHomePage(chatController: controller),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    // ── 重放真链事件序列（与服务端探针一致）──────────────────────────
    // 1) agent_browser.open 的 tool.call：悬浮窗应立即点亮（首帧未到）。
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{
        "toolName": "agent_browser",
        "input": <String, dynamic>{"action": "open", "url": "https://example.com"},
      },
    });
    await tester.pump(const Duration(milliseconds: 400));
    expect(controller.browserPreviewVisible, isTrue,
        reason: "tool.call 一到悬浮窗就要出现（即时反馈）");

    // 2) 预览帧（真实 example.com 截图）。
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.browser.preview",
      "payload": <String, dynamic>{
        "sessionId": "probe",
        "action": "open",
        "url": "https://example.com/",
        "imageBase64": _realFrameBase64,
        "mode": "headless",
      },
    });
    await tester.pump(const Duration(milliseconds: 600));

    expect(controller.browserPreviewImage, isNotNull);
    expect(controller.browserPreviewUrl, "https://example.com/");

    expect(controller.browserPreviewImage, isNotNull);
    expect(controller.browserPreviewUrl, "https://example.com/");

    // 测试环境里 JPEG 解码是真异步：取画面区 Image 的**同一个** provider
    // 实例（State 稳定缓存），runAsync 里 precacheImage 完成 real decode——
    // 同一 provider 的 ImageStreamCompleter 收到完成回调，下一帧即出图。
    final BuildContext homeContext = tester.element(find.byType(MobileHomePage));
    final Image previewImage = tester.widget<Image>(
      find.descendant(
        of: find.byType(MobileBrowserPreviewOverlay),
        matching: find.byType(Image),
      ).first,
    );
    await tester.binding.runAsync(() async {
      await precacheImage(previewImage.image, homeContext);
    });
    await tester.pump();

    // ── 截图落盘 ──────────────────────────────────────────────────
    final RenderRepaintBoundary boundary =
        tester.renderObject<RenderRepaintBoundary>(find.byKey(repaintKey));
    await tester.binding.runAsync(() async {
      final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.png);
      File("test/goldens/browser_preview_overlay.png")
          .writeAsBytesSync(data!.buffer.asUint8List());
    });

    // 3) 收口：悬浮窗熄灭。
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_done",
      "payload": <String, dynamic>{"messageId": "m1", "finalText": "看完了"},
    });
    await tester.pump(const Duration(milliseconds: 400));
    expect(controller.browserPreviewVisible, isFalse, reason: "任务收口自动熄灭");

    // 4) 排干：真实握手完成后连接层可能挂了一次性 timer（心跳/对账），
    //    大步进走完 fake 时间，避免「收尾仍有 pending timer」的偶发 invariant。
    await tester.pump(const Duration(seconds: 90));
    await tester.pump(const Duration(seconds: 90));
  });
}
