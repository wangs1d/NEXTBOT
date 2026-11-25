/// 统一管道真实链路 E2E — 桌面端（2026-11-26）。
///
/// 真 Windows 进程跑桌面端生产入口（PrivateAiApp → main.dart 的 WS 接线 →
/// features/chat/chat_page.dart 渲染），连本地真 server、走真模型，桌面端屏幕
/// 上每个行/句单元只允许出现一次——用户报的「封泡之后又把文字+表格整段渲染
/// 一遍」在桌面端同样要成立。渲染 PNG 与文本报告落 %TEMP% 供目检。
///
/// 跑法（server 需在 3000 起着）：
///   flutter test integration_test/real_chain_desktop_chat_e2e_test.dart -d windows ^
///     --dart-define=HTTP_BASE=http://127.0.0.1:3000 ^
///     --dart-define=WS_URL=ws://127.0.0.1:3000/ws ^
///     --dart-define=E2E_PROMPT="用表格列一下黄金白银今天的涨跌，再看看我这边天气"
library;

import "dart:io" show Directory, File;
import "dart:typed_data" show ByteData;
import "dart:ui" as ui show Image, ImageByteFormat;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show RenderRepaintBoundary;
import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";

import "package:nextbot/main.dart" show PrivateAiApp;

const String _prompt = String.fromEnvironment(
  "E2E_PROMPT",
  defaultValue: "哈哈今天好累，用表格列一下黄金白银今天的涨跌，再看看我这边的天气",
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

/// 屏幕上真实画出来的文本（Text 控件）。
List<String> _screenTexts(WidgetTester tester) {
  final List<String> out = <String>[];
  for (final Text t in tester.widgetList<Text>(
    find.byType(Text, skipOffstage: false),
  )) {
    final String s = (t.data ?? "").trim();
    if (s.isNotEmpty) out.add(s);
  }
  for (final EditableText e in tester.widgetList<EditableText>(
    find.byType(EditableText, skipOffstage: false),
  )) {
    final String s = e.controller.text.trim();
    if (s.isNotEmpty) out.add(s);
  }
  return out;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets("桌面端真服务对话：渲染不重复、末句不丢", (WidgetTester tester) async {
    final GlobalKey shotKey = GlobalKey(debugLabel: "desktopE2eShot");
    await tester.pumpWidget(RepaintBoundary(
      key: shotKey,
      child: const PrivateAiApp(),
    ));

    final List<String> log = <String>[];
    Future<void> shot(String name) async {
      final RenderRepaintBoundary? b = shotKey.currentContext?.findRenderObject()
          as RenderRepaintBoundary?;
      if (b == null) return;
      final ui.Image image = await b.toImage(pixelRatio: 1.0);
      final ByteData? bytes = await image.toByteData(
        format: ui.ImageByteFormat.png,
      );
      image.dispose();
      if (bytes == null) return;
      final String path =
          "${Directory(_shotDir).path}\\desktop_e2e_${name}_${DateTime.now().millisecondsSinceEpoch}.png";
      await File(path).writeAsBytes(bytes.buffer.asUint8List());
      log.add("[desktop-e2e] 截图 $name → $path");
    }

    // 等首启（门禁/会话读盘/WS 建连）
    for (int i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 500));
      if (find.byType(TextField).evaluate().isNotEmpty) break;
    }
    await shot("boot");
    log.add("[desktop-e2e] TextField 数=${find.byType(TextField).evaluate().length}");
    log.add("[desktop-e2e] 首屏文本: ${_screenTexts(tester).take(12).toList()}");

    expect(
      find.byType(TextField).evaluate().isNotEmpty,
      isTrue,
      reason: "没进桌面端聊天页（大概率停在登录门禁），屏幕文本见报告",
    );

    final Finder composer = find.byType(TextField).first;
    await tester.enterText(composer, _prompt);
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send).evaluate().isNotEmpty
        ? find.byIcon(Icons.send).first
        : composer);
    await tester.pump();
    log.add("[desktop-e2e] 已提交提示词: $_prompt");

    // 等本轮收口：屏幕正文连续 4 次采样不变（最长 300s）
    String last = "";
    int stable = 0;
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 300));
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(seconds: 1));
      final String joined = _screenTexts(tester).join("\n");
      if (joined.length > 40 && joined == last) {
        if (++stable >= 4) break;
      } else {
        stable = 0;
      }
      last = joined;
    }

    final String screen = _screenTexts(tester).join("\n");
    log.add("[desktop-e2e] 屏幕文本总长=${screen.length}");
    log.add("[desktop-e2e] 渲染层重复单元: ${_duplicates(screen)}");
    log.add("[desktop-e2e] 屏幕正文:\n$screen");
    await shot("settled");

    final String report = log.join("\n");
    debugPrint(report);
    print(report);
    await File(
      "${Directory(_shotDir).path}\\desktop_e2e_report.txt",
    ).writeAsString(report, flush: true);

    expect(_duplicates(screen), isEmpty, reason: "桌面端屏幕上同一行/句被画了多次");
    expect(screen.contains(_prompt), isTrue, reason: "用户消息未落屏");
  }, timeout: const Timeout(Duration(minutes: 12)));
}
