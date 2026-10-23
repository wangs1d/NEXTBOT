/// 会出卡片的轮次不流式（2026-10-08）：`chat.stream_reset` 链路测试。
///
/// 服务端确认本轮将携带结构化卡片后先推 reset 撤回已流正文，再静默，
/// 最终由 `chat.assistant_done` 一次性结构化下发。覆盖：
/// - 普通轮：清空已流正文、保留占位泡，done 后结构化内容落位
/// - 分泡轮：流式泡清空（已定稿泡由 done 塌缩统一收口）
/// - 兜底：无 traceId 时清当前流式泡；他轮 trace 不误伤
/// - reset 保留已挂照片（pendingMediaCards）
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

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

  Map<String, dynamic> turnStarted({String traceId = "trace-1"}) =>
      <String, dynamic>{
        "type": "chat.turn_started",
        "payload": <String, dynamic>{"traceId": traceId},
      };

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

  Map<String, dynamic> streamReset({String? traceId}) =>
      <String, dynamic>{
        "type": "chat.stream_reset",
        "payload": <String, dynamic>{
          if (traceId != null) "traceId": traceId,
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

  Map<String, dynamic> mediaReady({
    String traceId = "trace-1",
  }) =>
      <String, dynamic>{
        "type": "chat.media_ready",
        "payload": <String, dynamic>{
          // 服务端 media_ready 的 messageId 恒为基础 id
          "messageId": "assistant-$traceId",
          "traceId": traceId,
          "cards": <Map<String, dynamic>>[
            <String, dynamic>{"type": "image", "title": "万峰林"},
          ],
        },
      };

  test("普通轮：reset 清空已流正文、保留占位泡，done 后结构化内容落位", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(turnStarted());
    c.debugHandleWsEvent(chunk("assistant-trace-1", "兴义两日游可以这样安排，"));
    expect(c.messages.first.text, "兴义两日游可以这样安排，");

    c.debugHandleWsEvent(streamReset(traceId: "trace-1"));
    expect(c.messages.length, 1, reason: "占位泡保留");
    expect(c.messages.first.text, isEmpty, reason: "已流正文被撤回");
    expect(c.messages.first.streaming, isTrue, reason: "回到生成中观感");

    c.debugHandleWsEvent(done(
      messageId: "assistant-trace-1",
      finalText: "兴义两日游安排如下。",
      replacesStream: true,
      replyBlocks: <Map<String, dynamic>>[
        <String, dynamic>{
          "type": "card",
          "card": <String, dynamic>{"kind": "travel-plan"},
        },
      ],
    ));
    expect(c.messages.length, 1);
    expect(c.messages.first.text, "兴义两日游安排如下。");
    expect(c.messages.first.streaming, isFalse);
    expect(c.messages.first.replyBlocks, isNotNull, reason: "结构化卡片落位");
  });

  test("分泡轮：reset 只清流式泡，done 塌缩统一收口", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "第一泡先说说路线。"));
    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "第二泡继续补住宿。"));
    expect(c.messages.length, 2);
    expect(c.messages[0].streaming, isFalse, reason: "新泡开=旧泡完");

    c.debugHandleWsEvent(streamReset(traceId: "trace-1"));
    expect(c.messages[0].text, "第一泡先说说路线。",
        reason: "已定稿泡不再回改，交给 done 塌缩");
    expect(c.messages[1].text, isEmpty, reason: "流式泡正文撤回");
    expect(c.messages[1].streaming, isTrue);

    c.debugHandleWsEvent(done(
      finalText: "路线与住宿的完整结构化回复。",
      replacesStream: true,
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "第一泡先说说路线。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "第二泡继续补住宿。"},
      ],
    ));
    expect(c.messages.length, 1, reason: "分泡塌缩落单泡");
    expect(c.messages.first.messageId, "assistant-trace-1");
    expect(c.messages.first.text, "路线与住宿的完整结构化回复。");
    expect(c.messages.first.streaming, isFalse);
  });

  test("兜底：无 traceId 时清当前流式泡", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1", "正在打的一段话。"));
    expect(c.messages.first.text, "正在打的一段话。");

    c.debugHandleWsEvent(streamReset());
    expect(c.messages.first.text, isEmpty, reason: "回落到 _streamingMessageId");
    expect(c.messages.first.streaming, isTrue);
  });

  test("他轮 trace 不误伤", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-A-b1", "A 轮正文。", traceId: "trace-A"));
    c.debugHandleWsEvent(chunk("assistant-trace-B-b1", "B 轮正文。", traceId: "trace-B"));

    c.debugHandleWsEvent(streamReset(traceId: "trace-A"));
    expect(c.messages[0].text, isEmpty, reason: "trace-A 被撤回");
    expect(c.messages[1].text, "B 轮正文。", reason: "trace-B 不受影响");
  });

  test("reset 保留已挂照片（pendingMediaCards）", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1", "找了几张图给你。"));
    c.debugHandleWsEvent(mediaReady());
    expect(c.messages.first.pendingMediaCards, isNotNull);

    c.debugHandleWsEvent(streamReset(traceId: "trace-1"));
    expect(c.messages.first.text, isEmpty);
    expect(c.messages.first.pendingMediaCards, isNotNull, reason: "照片不随正文撤回");
  });
}
