/// 桌面端渲染实测（2026-11-26，统一管道）：把真实服务链路抓到的 WS 帧挂到桌面端
/// 真实渲染组件 ChatPage 上，验证屏幕上内容不重复、末句不丢。
///
/// 帧来源：`server/scripts/probe-unified-pipeline.mjs` 连本地真 server 跑一轮，
/// `PROBE_DUMP` 落盘的 chat.assistant_chunk / chat.assistant_done 原始事件——
/// 不是手造数据。桌面端 main.dart 的 WS 接线不在覆盖范围（那需要登录态），
/// 覆盖的是「同样的帧进了桌面端渲染层会长成什么样」。
///
/// 跑法：
///   flutter test test/desktop_chat_render_real_frames_test.dart ^
///     --dart-define=E2E_FRAMES=C:\path\real_chain_frames.json
library;

import "dart:convert";
import "dart:io";
import "dart:typed_data" show ByteData;
import "dart:ui" as ui show Image, ImageByteFormat;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show RenderRepaintBoundary;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/chat_page.dart";

const String _framesPath = String.fromEnvironment(
  "E2E_FRAMES",
  defaultValue: r"C:\Users\Administrator\AppData\Local\Temp\real_chain_frames.json",
);
const String _shotDir = String.fromEnvironment(
  "E2E_SHOT_DIR",
  defaultValue: r"C:\Users\Administrator\AppData\Local\Temp",
);

List<String> _units(String text) => text
    .split(RegExp(r"[\n。！？!?；;]"))
    .map((String s) => s.replaceAll(RegExp(r"\s+"), ""))
    .where((String s) => s.length >= 6)
    .toList();

List<String> _duplicates(String text) {
  final Map<String, int> counts = <String, int>{};
  for (final String u in _units(text)) {
    counts[u] = (counts[u] ?? 0) + 1;
  }
  return counts.entries
      .where((MapEntry<String, int> e) => e.value > 1)
      .map((MapEntry<String, int> e) => '${e.value}次 "${e.key}"')
      .toList();
}

void main() {
  testWidgets("真实帧 → 桌面端 ChatPage：屏幕内容不重复", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1440, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final File file = File(_framesPath);
    expect(file.existsSync(), isTrue, reason: "先跑探针抓帧：$_framesPath 不存在");
    final List<dynamic> frames = jsonDecode(file.readAsStringSync()) as List<dynamic>;

    // 1) 桌面端流式累计：同 messageId 续写（main.dart _appendChunkToMessageList 语义）
    final Map<String, StringBuffer> byBlock = <String, StringBuffer>{};
    final List<String> order = <String>[];
    Map<String, dynamic>? donePayload;
    for (final dynamic f in frames) {
      final Map<String, dynamic> map = f as Map<String, dynamic>;
      final Map<String, dynamic> payload = map["payload"] as Map<String, dynamic>;
      if (map["type"] == "chat.assistant_chunk") {
        final String id = payload["messageId"].toString();
        if (!byBlock.containsKey(id)) {
          byBlock[id] = StringBuffer();
          order.add(id);
        }
        byBlock[id]!.write(payload["chunk"] ?? "");
      } else if (map["type"] == "chat.assistant_done") {
        donePayload = payload;
      }
    }
    expect(donePayload, isNotNull, reason: "抓帧里没有 done，轮次没跑完");
    final String streamed = order.map((String id) => byBlock[id]!.toString()).join("");

    // 2) done 收口后的服务端账本：bubbles 快照 + 卡片块
    final List<dynamic> bubbles = (donePayload!["bubbles"] ?? <dynamic>[]) as List<dynamic>;
    final List<Map<String, dynamic>> blocks =
        ((donePayload["blocks"] ?? <dynamic>[]) as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .toList();
    final String bubbleText = bubbles
        .map((dynamic b) => (b as Map<String, dynamic>)["text"].toString())
        .join("\n");

    // 桌面端定稿：done 之后按气泡账本落定（卡片挂末条）
    final List<ChatMessage> messages = <ChatMessage>[
      ChatMessage(
        messageId: "u-1",
        sessionId: "desktop-e2e",
        role: "user",
        text: "（真链抓帧回放）",
        timestamp: DateTime(2026, 11, 26),
      ),
      for (int i = 0; i < bubbles.length; i++)
        ChatMessage(
          messageId: bubbles[i]["id"].toString(),
          sessionId: "desktop-e2e",
          role: "assistant",
          text: bubbles[i]["text"].toString(),
          timestamp: DateTime(2026, 11, 26),
          replyBlocks: i == bubbles.length - 1 && blocks.isNotEmpty ? blocks : null,
        ),
    ];

    final List<String> log = <String>[];
    log.add("[desktop-render] 帧数=${frames.length} 流式块=${order.length} 泡=${bubbles.length} 信封块=${blocks.length}");
    log.add("[desktop-render] 流式累计=${streamed.length}字 泡账本=${bubbleText.length}字");
    log.add(
      "[desktop-render] 流式累计 ≡ 泡账本（去空白）: "
      "${streamed.replaceAll(RegExp(r"\s+"), "") == bubbleText.replaceAll(RegExp(r"\s+"), "")}",
    );

    final GlobalKey shotKey = GlobalKey(debugLabel: "desktopRenderShot");
    await tester.pumpWidget(MaterialApp(
      home: RepaintBoundary(
        key: shotKey,
        child: Scaffold(
          body: ChatPage(
            messages: messages,
            controller: TextEditingController(),
            onSend: () {},
          ),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final List<String> onScreen = <String>[];
    for (final Text t in tester.widgetList<Text>(find.byType(Text, skipOffstage: false))) {
      final String s = (t.data ?? "").trim();
      if (s.isNotEmpty) onScreen.add(s);
    }
    final String joined = onScreen.join("\n");
    log.add("[desktop-render] 屏幕 Text 控件数=${onScreen.length} 可见字符=${joined.length}");
    log.add("[desktop-render] 屏幕重复单元: ${_duplicates(joined)}");
    log.add("[desktop-render] 屏幕正文:\n$joined");

    final ui.Image image = await (shotKey.currentContext!.findRenderObject()!
        as RenderRepaintBoundary)
        .toImage(pixelRatio: 1.0);
    final ByteData? bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    final String shot =
        "${_shotDir}\\desktop_render_${DateTime.now().millisecondsSinceEpoch}.png";
    await File(shot).writeAsBytes(bytes!.buffer.asUint8List());
    log.add("[desktop-render] 渲染截图 → $shot");

    final String report = log.join("\n");
    debugPrint(report);
    print(report);
    await File("${_shotDir}\\desktop_render_report.txt").writeAsString(report, flush: true);

    expect(_duplicates(joined), isEmpty, reason: "桌面端屏幕上同一行/句出现多次");
    expect(
      streamed.replaceAll(RegExp(r"\s+"), "") == bubbleText.replaceAll(RegExp(r"\s+"), ""),
      isTrue,
      reason: "流式放出的内容与 done 气泡账本不一致",
    );
    expect(joined.trim(), isNotEmpty);
  });
}
