/// 真机取证（2026-11-26 01:13 截图）：美股指数表格轮里，表格卡片出现两次——
/// 一条只有表格，紧随一条「正文 + 同一张表格」。本文件把该形态钉成回归用例：
/// 同一轮（同 trace）无论走分泡收口还是单条收口，正文在屏幕上只允许出现一次。
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

HttpServer? _wsServer;

const String prose = "比昨晚那波缓了点——昨晚纳指跌将近四个点，现在收窄到两个六。";
const String table =
    "| 指数 | 点位 | 涨跌 |\n|---|---|---|\n| 道琼斯 | 49752.95 | -0.53% |";
const String full = "$prose\n\n$table";

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

  Map<String, dynamic> streamReset({String traceId = "trace-1"}) =>
      <String, dynamic>{
        "type": "chat.stream_reset",
        "payload": <String, dynamic>{"traceId": traceId},
      };

  Map<String, dynamic> done({
    String traceId = "trace-1",
    String? messageId,
    String finalText = "",
    List<Map<String, dynamic>>? bubbles,
  }) =>
      <String, dynamic>{
        "type": "chat.assistant_done",
        "payload": <String, dynamic>{
          "traceId": traceId,
          if (messageId != null) "messageId": messageId,
          "finalText": finalText,
          if (bubbles != null) "bubbles": bubbles,
        },
      };

  /// 屏幕上整段正文的出现次数：任何一条气泡文本里含 full 即计一次；
  /// 分泡轮按「正文泡 + 表格泡」拼回整段再计。
  int occurrencesOnScreen(MobileChatController c) {
    final String joined =
        c.messages.map((m) => m.text).join("\n").replaceAll("\n\n", "\n");
    final String normalizedFull = full.replaceAll("\n\n", "\n");
    int n = 0;
    int i = joined.indexOf(normalizedFull);
    while (i >= 0) {
      n += 1;
      i = joined.indexOf(normalizedFull, i + normalizedFull.length);
    }
    return n;
  }

  int tableRowsOnScreen(MobileChatController c) =>
      c.messages.where((m) => m.text.contains("49752.95")).length;

  group("表格轮不重复", () {
    test("正常分泡收口：正文与表格各一次", () {
      final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
      addTearDown(c.dispose);
      c.debugHandleWsEvent(chunk("assistant-trace-1-b1", prose));
      c.debugHandleWsEvent(chunk("assistant-trace-1-b2", table));
      c.debugHandleWsEvent(done(messageId: "assistant-trace-1-b2", bubbles: [
        <String, dynamic>{"id": "assistant-trace-1-b1", "text": prose},
        <String, dynamic>{"id": "assistant-trace-1-b2", "text": table},
      ]));
      c.debugFlushBubbleReveals();
      expect(c.messages.length, 2);
      expect(tableRowsOnScreen(c), 1);
    });

    test("撤回轮：已落屏的泡必须随 reset 撤走，done 单条不再补一整段", () {
      final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
      addTearDown(c.dispose);
      c.debugHandleWsEvent(chunk("assistant-trace-1-b1", prose));
      c.debugHandleWsEvent(chunk("assistant-trace-1-b2", table));
      // 揭示泵已把两泡整泡落屏（streaming=false），随后服务端判定撤回
      c.debugFlushBubbleReveals();

      c.debugHandleWsEvent(streamReset());
      c.debugHandleWsEvent(done(
        messageId: "assistant-trace-1",
        finalText: full,
      ));
      c.debugFlushBubbleReveals();
      expect(
        tableRowsOnScreen(c),
        1,
        reason: "表格只应出现一次——撤回后 done 单条收口不得与已落屏泡并存",
      );
      expect(occurrencesOnScreen(c), lessThanOrEqualTo(1));
    });

    test("done 缺 bubbles 时不得在同 trace 已落泡后再补一条整段", () {
      final MobileChatController c = MobileChatController(wsBaseUrl: wsUrl());
      addTearDown(c.dispose);
      c.debugHandleWsEvent(chunk("assistant-trace-1-b1", prose));
      c.debugHandleWsEvent(chunk("assistant-trace-1-b2", table));
      c.debugFlushBubbleReveals();

      c.debugHandleWsEvent(done(
        messageId: "assistant-trace-1",
        finalText: full,
      ));
      c.debugFlushBubbleReveals();
      expect(
        tableRowsOnScreen(c),
        1,
        reason: "同一轮已按泡落屏，done 无对账数组时不得再落一条整段副本",
      );
      expect(c.messages.length, 1, reason: "本轮收成单条，不留分泡残行");
      expect(c.messages.first.messageId, "assistant-trace-1");
      expect(c.messages.first.text, full);
    });
  });
}
