/// 真·分绿泡（2026-09-28，2026-11-10 改版）：MobileChatController 分泡链路测试。
///
/// 2026-11-10 节奏改版：分泡 chunk 只进缓冲不直接落屏，泡完成（下一泡开 /
/// done 收口）才入揭示队列按 ≥600ms 间隔逐泡整条弹出——打字机效果下线，
/// 观感是助手像真人一样一条一条发消息。
///
/// 覆盖：
/// - 分泡 chunk 缓冲：流式期间不落屏、旧泡完成入队、flush 后按序整泡落屏
/// - done 对账：服务端文本为准、漏收补建（走揭示队列）、卡片挂末泡、
///   多泡 text 块过滤、占位泡撤除
/// - 塌缩：finalTextReplacesStream 删泡落单泡（含占位让位防 id 撞车）
/// - 回归：非分泡单泡链路行为不变
/// - 跨轮隔离：他轮 trace 的缓冲泡不受本轮 done 影响
library;

import "dart:io";

import "package:fake_async/fake_async.dart";
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

  test("分泡 chunk 组装：流式只缓冲不落屏，flush 后按序整泡弹出", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(turnStarted());
    expect(c.messages.length, 1, reason: "turn_started 建占位");
    expect(c.messages.first.streaming, isTrue);

    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "哎，在呢。"));
    expect(c.messages.length, 1,
        reason: "流式泡不直接落屏，正文在缓冲里；占位泡继续展示生成中");
    expect(c.messages.first.messageId, "assistant-trace-1");

    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "还没睡吧？"));
    expect(c.messages.length, 1, reason: "同泡 chunk 继续缓冲");

    c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "有什么事？"));
    expect(c.messages.length, 1, reason: "b1 完成入队未揭示，b2 开始缓冲");

    c.debugFlushBubbleReveals();
    expect(c.messages.length, 3, reason: "占位 + 两泡按序落屏");
    expect(c.messages[1].messageId, "assistant-trace-1-b1");
    expect(c.messages[1].text, "哎，在呢。还没睡吧？",
        reason: "同泡 chunk 缓冲拼接");
    expect(c.messages[1].streaming, isFalse, reason: "整泡落屏即定稿");
    expect(c.messages[2].messageId, "assistant-trace-1-b2");
    expect(c.messages[2].text, "有什么事？");
    expect(c.messages[2].streaming, isFalse);
  });

  test("done 对账：逐泡定稿、服务端文本为准、占位撤除、多泡块只留非 text 块", () {
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
    expect(c.messages.where((m) => _isBubbleMsg(m.messageId)).length, 0,
        reason: "done 后泡还在揭示队列里，尚未落屏");
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 2, reason: "占位被 done 撤除，两泡落屏");
    expect(c.messages.every((m) => !m.streaming), isTrue, reason: "全部定稿");
    expect(c.messages[0].text, "哎，在呢。", reason: "服务端对账文本为准");
    expect(c.messages[1].text, "有什么事？");
    // 卡片挂末泡，text 块被过滤（防整段复读）
    expect(c.messages[0].replyBlocks, isNull);
    expect(c.messages[1].replyBlocks, isNotNull);
    expect(c.messages[1].replyBlocks!.length, 1);
    expect(c.messages[1].replyBlocks!.first["type"], "card");
    expect(c.isProcessing, isFalse);
  });

  test("done 对账：漏收 b2 chunk 时按对账走揭示队列补建", () {
    final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
    addTearDown(c.dispose);
    c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "在呢。"));
    c.debugHandleWsEvent(done(
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": "在呢。"},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": "说吧。"},
      ],
    ));
    expect(c.messages.where((m) => _isBubbleMsg(m.messageId)).length, 0,
        reason: "补建泡先进揭示队列，按间隔弹出");
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 2, reason: "b2 补建落屏");
    expect(c.messages[1].messageId, "assistant-trace-1-b2");
    expect(c.messages[1].text, "说吧。");
    expect(c.messages[1].streaming, isFalse);
  });

  test("塌缩：finalTextReplacesStream 删全部分泡落单泡（占位让位不撞 id）", () {
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
    expect(c.messages.length, 1, reason: "分泡（含占位）全部删除，只落塌缩单泡");
    expect(c.messages.first.messageId, "assistant-trace-1");
    expect(c.messages.first.text, "重写后的完整新版本回复。");
    expect(c.messages.first.streaming, isFalse);
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 1, reason: "塌缩后揭示队列已清空，不弹旧泡");
  });

  test("分泡轮 media_ready 挂占位泡，不开幻影占位", () {
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
    expect(c.messages.length, 1, reason: "流式锚点占位已存在，不得新建");
    expect(c.messages.first.pendingMediaCards, isNotNull);
  });

  test("照片流式挂占位、done 后清空，最终卡片只挂末泡渲染一次", () {
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
    expect(c.messages.where((m) => m.pendingMediaCards != null).length, 1,
        reason: "照片同一时刻只挂一条消息（流式锚点占位）");
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
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 2, reason: "占位撤除，两泡落屏");
    expect(
      c.messages.every((m) => m.pendingMediaCards == null),
      isTrue,
      reason: "done 后流式临时照片必须清空，否则同一批照片挂两处被渲染两次",
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

  test("跨轮隔离：他轮 trace 的缓冲泡不受本轮 done 收口影响", () {
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
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 1, reason: "A 轮泡落屏；B 轮泡仍在缓冲中不落屏");
    expect(c.messages.first.messageId, "assistant-trace-A-b1");
    expect(c.messages.first.streaming, isFalse);

    // B 轮自己的 done 收口后，B 泡才走自己的揭示队列落屏
    c.debugHandleWsEvent(done(
      traceId: "trace-B",
      bubbles: <Map<String, dynamic>>[
        <String, dynamic>{"id": "assistant-trace-B-b1", "text": "B 轮第一泡。"},
      ],
    ));
    c.debugFlushBubbleReveals();
    expect(c.messages.length, 2);
    expect(c.messages[1].messageId, "assistant-trace-B-b1");
    expect(c.messages[1].text, "B 轮第一泡。");
    expect(c.messages[1].streaming, isFalse);
  });

  test("揭示泵：泡整条落屏、done 后末泡按间隔补排（fakeAsync 计时）", () {
    fakeAsync((FakeAsync async) {
      final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
      c.debugHandleWsEvent(chunk("assistant-trace-1-b1", "第一泡。"));
      c.debugHandleWsEvent(chunk("assistant-trace-1-b2", "第二泡。"));
      // b1 完成（b2 开）即入队；事件循环转起来之前不落屏
      expect(
        c.messages.where((m) => m.messageId.endsWith("-b1")).length,
        0,
        reason: "定时器未触发，泡不落屏",
      );
      async.elapse(const Duration(milliseconds: 50));
      expect(
        c.messages.where((m) => m.messageId == "assistant-trace-1-b1").length,
        1,
        reason: "队首泡整条落屏（不做逐字打字）",
      );
      expect(
        c.messages
            .firstWhere((m) => m.messageId == "assistant-trace-1-b1")
            .streaming,
        isFalse,
        reason: "整泡落屏即定稿",
      );
      expect(
        c.messages.where((m) => m.messageId.endsWith("-b2")).length,
        0,
        reason: "b2 未完成（无下一泡/done），仍缓冲",
      );
      c.debugHandleWsEvent(done(
        finalText: "第一泡。第二泡。",
        bubbles: <Map<String, dynamic>>[
          <String, dynamic>{"id": "assistant-trace-1-b1", "text": "第一泡。"},
          <String, dynamic>{"id": "assistant-trace-1-b2", "text": "第二泡。"},
        ],
      ));
      async.elapse(const Duration(seconds: 2));
      expect(
        c.messages.where((m) => m.messageId == "assistant-trace-1-b2").length,
        1,
        reason: "done 收口后末泡按间隔整泡落屏",
      );
      c.dispose();
    });
  });
}

/// 判定消息 id 是否为分泡 id（与控制器内 `_isBubbleId` 同正则语义）。
bool _isBubbleMsg(String messageId) =>
    RegExp(r"^assistant-(.+)-b(\d+)$").hasMatch(messageId);
