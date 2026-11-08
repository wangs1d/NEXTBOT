import "dart:math" as math;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:nextbot/features/chat/media_gallery.dart";
import "package:nextbot/mobile_ui/mobile_chat_page.dart";
import "package:nextbot/main_mobile.dart" as app;

/// 临时实测脚本（跑完即删）：真实链路验证收口后照片/正文各只有一个出口——
/// 同一张照片在渲染树里只出现一次（MediaGallery 是照片唯一渲染部件）。
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets("搜图回复里同一张照片只渲染一次", (WidgetTester tester) async {
    app.main();
    final Finder input = find.byWidgetPredicate(
      (Widget w) =>
          w is TextField && (w.decoration?.hintText ?? "").contains("发消息"),
    );
    final Finder debugSkip = find.text("跳过登录，先随便看看（调试）");
    final DateTime bootDeadline = DateTime.now().add(const Duration(seconds: 90));
    bool skippedLogin = false;
    while (DateTime.now().isBefore(bootDeadline)) {
      await tester.pump(const Duration(milliseconds: 500));
      if (input.evaluate().isNotEmpty) break;
      if (!skippedLogin && debugSkip.evaluate().isNotEmpty) {
        await tester.tap(debugSkip);
        skippedLogin = true;
        await tester.pump(const Duration(milliseconds: 500));
      }
    }
    expect(input, findsOneWidget, reason: "未进入聊天页");

    await tester.enterText(input, "找几张黄山风景的照片我看看");
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pump(const Duration(milliseconds: 300));

    bool sawPhoto = false;
    final DateTime photoDeadline =
        DateTime.now().add(const Duration(seconds: 180));
    while (DateTime.now().isBefore(photoDeadline)) {
      await tester.pump(const Duration(milliseconds: 500));
      if (find.byType(MediaGallery).evaluate().isNotEmpty) {
        sawPhoto = true;
        break;
      }
    }
    expect(sawPhoto, isTrue, reason: "180s 内没有出现任何照片，搜图链路没有跑通");
    await _pumpFor(tester, const Duration(seconds: 20));

    // 消息状态 dump：确认信封里 media_segments 只含 media 段（无文字段）
    final MobileChatPage page = tester.widget<MobileChatPage>(
      find.byType(MobileChatPage),
    );
    final controller = page.controller;
    if (controller != null) {
      for (final m in controller.messages) {
        if (m.envelopeBlocks == null && m.mediaCards == null) continue;
        // ignore: avoid_print
        print("MSG id=${m.messageId} env=${_briefBlocks(m.envelopeBlocks)}");
      }
    }

    // 照片统计：只数 MediaGallery（MediaInlineRow 内部含 Gallery，是唯一照片渲染部件）。
    // 多个照片块渲染同一张照片 → 同一 URL 出现在多个 Gallery → total > unique。
    int total = 0;
    final Set<String> unique = <String>{};
    for (final MediaGallery g
        in tester.widgetList<MediaGallery>(find.byType(MediaGallery))) {
      for (final String u in g.urls) {
        total++;
        unique.add(u.trim());
      }
    }
    // ignore: avoid_print
    print("PHOTOS total=$total unique=${unique.length}");
    expect(total, greaterThan(0), reason: "页面没有照片，无法判定");
    expect(total, equals(unique.length), reason: "同一张照片被渲染多次");
  });
}

Future<void> _pumpFor(WidgetTester tester, Duration duration) async {
  final DateTime end = DateTime.now().add(duration);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 500));
  }
}

String _briefBlocks(List<Map<String, dynamic>>? blocks) {
  if (blocks == null) return "null";
  return "[${blocks.map(_briefBlock).join(", ")}]";
}

String _briefBlock(Map<String, dynamic> b) {
  final String type = (b["type"] ?? "").toString();
  final Object? cards = b["cards"];
  final Object? segs = b["segments"];
  final String c = cards is List ? " cards=${cards.length}" : "";
  final String s = segs is List
      ? " segs=[${segs.whereType<Map>().map((Map e) => (e["type"] ?? "").toString() + (e["cards"] is List ? "(cards=${(e["cards"] as List).length})" : "")).join(", ")}]"
      : "";
  return "$type$c$s";
}
