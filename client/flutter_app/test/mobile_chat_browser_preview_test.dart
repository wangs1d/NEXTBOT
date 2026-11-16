import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 空历史存储：不碰本机共享 Isar（共享库会残留旧消息，污染断言）。
class _EmptyHistoryStore implements LocalHistoryStore {
  @override
  dynamic noSuchMethod(Invocation invocation) {
    final dynamic member = invocation.memberName;
    if (member == #listSessions) {
      return Future<List<ChatSession>>.value(<ChatSession>[]);
    }
    if (member == #listMessages) {
      return Future<List<ChatMessage>>.value(<ChatMessage>[]);
    }
    if (member == #listPendingUserMessages) {
      return Future<List<Map<String, dynamic>>>.value(<Map<String, dynamic>>[]);
    }
    if (member == #migrateAssistantTimestampFrames) {
      return Future<int>.value(0);
    }
    if (member == #init ||
        member == #saveSession ||
        member == #saveMessage ||
        member == #deleteMessage ||
        member == #deleteMessagesForSession ||
        member == #clearAllMessages ||
        member == #savePreference) {
      return Future<void>.value();
    }
    if (member == #getPreference) {
      return Future<dynamic>.value(null);
    }
    return null;
  }
}

/// 本地 WebSocket 服务端：控制器构造即连接，连不上会走重连定时器并抛异步
/// 断连错误污染测试 zone，所以起真监听端。
HttpServer? _wsServer;

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

  Future<MobileChatController> newController() async {
    final MobileChatController controller = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${_wsServer!.port}",
      historyStore: _EmptyHistoryStore(),
    );
    await pumpEventQueue();
    return controller;
  }

  test("浏览器族 tool.call 点亮悬浮窗（首帧未到也有反馈）", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{
        "toolName": "agent_browser",
        "input": <String, dynamic>{"action": "open", "url": "https://example.com"},
      },
    });

    expect(controller.browserPreviewVisible, isTrue,
        reason: "浏览器工具一开始就要有可见反馈，不能全程静默");
    expect(controller.browserPreviewImage, isNull);
    expect(controller.browserPreviewAction, "open");
  });

  test("agent.browser.preview 更新画面与脚注", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.browser.preview",
      "payload": <String, dynamic>{
        "sessionId": "s1",
        "action": "click",
        "url": "https://www.jd.com/item/1",
        "imageBase64": "aGVsbG8=",
        "mode": "headless",
      },
    });

    expect(controller.browserPreviewVisible, isTrue);
    expect(controller.browserPreviewImage, "aGVsbG8=");
    expect(controller.browserPreviewUrl, "https://www.jd.com/item/1");
    expect(controller.browserPreviewAction, "click");
  });

  test("screencast stream 帧只更新画面，不覆盖动作标签", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    // 先来一个真实动作帧
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.browser.preview",
      "payload": <String, dynamic>{
        "sessionId": "s1",
        "action": "type",
        "url": "https://passport.jd.com",
        "imageBase64": "aGVsbG8=",
        "mode": "headless",
      },
    });
    expect(controller.browserPreviewAction, "type");

    // 连续流帧：画面和 URL 更新，但标题条动作保持「type」
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.browser.preview",
      "payload": <String, dynamic>{
        "sessionId": "s1",
        "action": "stream",
        "url": "https://passport.jd.com",
        "imageBase64": "ZmFmYQ==",
        "mode": "headless",
      },
    });

    expect(controller.browserPreviewImage, "ZmFmYQ==");
    expect(controller.browserPreviewAction, "type",
        reason: "stream 帧不能把标题条改成「正在推流」，动作短句保留最近真实动作");
    expect(controller.browserPreviewVisible, isTrue);
  });

  test("空帧不置位悬浮窗", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.browser.preview",
      "payload": <String, dynamic>{"imageBase64": ""},
    });

    expect(controller.browserPreviewVisible, isFalse);
  });

  test("手动关闭后隐藏；下一个浏览器任务重新点亮", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{"toolName": "shared_browser.navigate"},
    });
    expect(controller.browserPreviewVisible, isTrue);

    controller.dismissBrowserPreview();
    expect(controller.browserPreviewVisible, isFalse);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{"toolName": "browser.navigate"},
    });
    expect(controller.browserPreviewVisible, isTrue,
        reason: "新浏览器任务必须重新点亮（手动关闭只管当前一轮）");
  });

  test("非浏览器工具不点亮悬浮窗", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{"toolName": "web_search"},
    });

    expect(controller.browserPreviewVisible, isFalse);
  });

  test("轮次出错收口：悬浮窗熄灭", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "tool.call",
      "payload": <String, dynamic>{"toolName": "agent_browser"},
    });
    expect(controller.browserPreviewVisible, isTrue);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.error",
      "payload": <String, dynamic>{"message": "出错了"},
    });

    expect(controller.browserPreviewVisible, isFalse);
  });
}
