/// 真·分绿泡（2026-09-28）：MobileChatController 分泡链路测试。
///
/// 覆盖：
/// - 分泡 chunk 组装：占位让位、新泡开=旧泡完、逐泡累积
/// - done 对账：服务端文本为准、漏收补建、卡片挂末泡、多泡 text 块过滤
/// - 塌缩：finalTextReplacesStream 删泡落单泡
/// - 回归：非分泡单泡链路行为不变
import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 本地 WebSocket 服务器：控制器构造即连接，连不上会走重连定时器并触发
/// web_socket 包的异步断连错误污染测试 zone。起真监听端最稳。
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

  String wsUrl() => "ws://127.0.0.1:${_wsServer!.port}";

  Map<String, dynamic> chunk(
    String messageId,
    String text, {
    String traceId = "trace-1",
  }) =>
      <String, dynamic>{
        "type": "chat.assistant_chunk",
        "payload": <String, dynamic>{
          "messageId": messageId,
          "traceId": traceId,
          "chunk": text,
          "phase": "stream",
        },
      };

  Map<String, dynamic> done({
    String traceId = "trace-1",
    String? messageId,
    String finalText = "",
    List<Map<String, dynamic>>? bubbles,
    bool replacesStream = false,
    List<Map<String, dynamic>>? mediaCards,
    List<Map<String, dynamic>>? replyBlocks,
  }) =>
      <String, dynamic>{
        "type": "chat.assistant_done",
        "payload": <String, dynamic>{
          "traceId": traceId,
          if (messageId != null) "messageId": messageId,
          "finalText": finalText,
          if (bubbles != null) "bubbles": bubbles,
          if (replacesStream) "finalTextReplacesStream": true,
          if (mediaCards != null) "mediaCards": mediaCards,
          if (replyBlocks != null) "blocks": replyBlocks,
        },
      };

  Map<String, dynamic> turnStarted({String traceId = "trace-1"}) =>
      <String, dynamic>{
        "type": "chat.turn_started",
        "payload": <String, dynamic>{"traceId": traceId},
      };

  test("分泡 chunk 组装：占位让位、两泡独立、旧泡先定稿", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(turnStarted());
    expect(c.messages.length, 1, reason: "turn_started 建占位");
    expect(c.messages.first.streaming, isTrue);

    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "哎，在呢。"));
    expect(c.messages.length, 1, reason: "空占位让位给第一泡");
    expect(c.messages.first.messageId, "assistant-trace-1-b1");
    expect(c.messages.first.text, "哎，在呢。");
    expect(c.messages.first.streaming, isTrue);

    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "还没睡吧？"));
    expect(c.messages.first.text, "哎，在呢。还没睡吧？", reason: "同泡 chunk 续写");

    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "有什么事？"));
    expect(c.messages.length, 2);
    expect(c.messages[0].streaming, isFalse, reason: "新泡开=旧泡完");
    expect(c.messages[1].messageId, "assistant-trace-1-b2");
    expect(c.messages[1].text, "有什么事？");
    expect(c.messages[1].streaming, isTrue);
  });

  test("done 对账：逐泡定稿、服务端文本为准、多泡块只留非 text 块", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "哎，在呢。"));
    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "有什么事？"));
    c.debugHandleWsEvent(done(
      finalText: "哎，在呢。有什么事？",
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "哎，在呢。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "有什么事？"},
      ],
      replyBlocks: <Map<String, dynamic>>[
        <String, dynamic>{"type": "text", "text": "哎，在呢。有什么事？"},
        <String, dynamic>{"type": "card", "card": <String, dynamic>{"kind": "x"}},
      ],
    ));
    expect(c.messages.length, 2);
    expect(c.messages.every((m) => !m.streaming), isTrue, reason: "全部定稿");
    expect(c.messages[0].text, "哎，在呢。");
    expect(c.messages[1].text, "有什么事？");
    // 卡片挂末泡，text 块被过滤（防整段复读）
    expect(c.messages[0].replyBlocks, isNull);
    expect(c.messages[1].replyBlocks, isNotNull);
    expect(c.messages[1].replyBlocks!.length, 1);
    expect(c.messages[1].replyBlocks!.first["type"], "card");
    expect(c.isProcessing, isFalse);
  });

  test("done 对账：漏收 b2 chunk 时按对账补建", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "在呢。"));
    c.debugHandleWsEvent(done(
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "在呢。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "说吧。"},
      ],
    ));
    expect(c.messages.length, 2, reason: "b2 补建");
    expect(c.messages[1].messageId, "assistant-trace-1-b2");
    expect(c.messages[1].text, "说吧。");
    expect(c.messages[1].streaming, isFalse);
  });

  test("塌缩：finalTextReplacesStream 删全部分泡落单泡", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "旧版说法一。"));
    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "旧版说法二。"));
    c.debugHandleWsEvent(done(
      finalText: "重写后的完整新版本回复。",
      replacesStream: true,
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "旧版说法一。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "旧版说法二。"},
      ],
    ));
    expect(c.messages.length, 1, reason: "分泡全部删除，只落塌缩单泡");
    expect(c.messages.first.messageId, "assistant-trace-1");
    expect(c.messages.first.text, "重写后的完整新版本回复。");
    expect(c.messages.first.streaming, isFalse);
  });

  test("分泡轮 media_ready 挂当前泡，不开幻影占位", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "找了几张图。"));
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.media_ready",
      "payload": <String, dynamic>{
        // 服务端 media_ready 的 messageId 恒为基础 id
        "messageId": "assistant-trace-1",
        "traceId": "trace-1",
        "cards": <Map<String, dynamic>>[
          <String, dynamic>{"type": "image", "title": "t"},
        ],
      },
    });
    expect(c.messages.length, 1, reason: "不得新建 assistant-trace-1 占位");
    expect(c.messages.first.pendingMediaCards, isNotNull);
  });

  test("照片同一时刻只挂一条消息：新泡开时顺移，done 后只由末泡渲染一次", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "我去找几张。"));
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.media_ready",
      "payload": <String, dynamic>{
        "messageId": "assistant-trace-1",
        "traceId": "trace-1",
        "cards": <Map<String, dynamic>>[
          <String, dynamic>{"type": "image", "title": "a"},
          <String, dynamic>{"type": "image", "title": "b"},
        ],
      },
    });
    expect(c.messages.first.pendingMediaCards, isNotNull, reason: "流式阶段先展示");
    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "给你挑了两张。"));
    expect(c.messages[0].pendingMediaCards, isNull, reason: "旧泡定稿必须交还照片");
    expect(c.messages[1].pendingMediaCards, isNotNull, reason: "照片顺移到当前流式泡，全程只有一条消息持有");
    c.debugHandleWsEvent(done(
      finalText: "我去找几张。给你挑了两张。",
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "我去找几张。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "给你挑了两张。"},
      ],
      mediaCards: <Map<String, dynamic>>[
        <String, dynamic>{"type": "image", "title": "a"},
        <String, dynamic>{"type": "image", "title": "b"},
      ],
    ));
    expect(c.messages.length, 2);
    expect(
      c.messages.every((m) => m.pendingMediaCards == null),
      isTrue,
      reason: "done 后早推临时照片必须清空，否则同一批照片挂在旧泡+末泡被渲染两次",
    );
    expect(c.messages[1].mediaCards!.length, 2, reason: "最终卡片只挂末泡一次");
  });

  test("回归：非分泡单泡链路行为不变", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(turnStarted());
    c.debugHandleWsEvent(chunk("assistant-trace-1", "单泡正文。"));
    expect(c.messages.length, 1);
    expect(c.messages.first.messageId, "assistant-trace-1");
    expect(c.messages.first.text, "单泡正文。");
    c.debugHandleWsEvent(done(
      messageId: "assistant-trace-1",
      finalText: "单泡正文定稿。",
    ));
    expect(c.messages.length, 1);
    expect(c.messages.first.text, "单泡正文定稿。", reason: "finalText 整段替换");
    expect(c.messages.first.streaming, isFalse);
  });

  test("ChatMessage 分泡 id 与 trace 提取（同桌面端正则语义）", () {
    // 通过补建路径间接验证 id 解析：非同 trace 的泡不互相干扰
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-A-b1", "A 轮第一泡。"));
    c.debugHandleWsEvent(chunk("assistant-trace-B-b1", "B 轮第一泡。"));
    c.debugHandleWsEvent(done(
      traceId: "trace-A",
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-A-b1", "text": "A 轮第一泡。"},
      ],
    ));
    // trace-B 的流式泡不应被 trace-A 的 done 定稿或删除
    expect(c.messages.length, 2);
    expect(c.messages[1].messageId, "assistant-trace-B-b1");
    expect(c.messages[1].streaming, isTrue, reason: "他轮泡不受本轮收口影响");
  });
}
