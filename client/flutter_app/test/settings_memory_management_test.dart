import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/settings/settings_page.dart";

void main() {
  testWidgets("设置页记忆管理入口可打开并展示遗忘表单", (WidgetTester tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);

    try {
      await tester.pumpWidget(const MaterialApp(home: SettingsPage()));
      await tester.pumpAndSettle();

      await tester.tap(find.text("记忆管理"));
      await tester.pumpAndSettle();

      expect(find.text("忘掉一段记忆"), findsOneWidget);
      expect(find.text("确认遗忘"), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets("设置页模型分区不再提供声纹注册", (WidgetTester tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);

    try {
      await tester.pumpWidget(const MaterialApp(home: SettingsPage()));
      await tester.pumpAndSettle();

      await tester.tap(find.text("模型"));
      await tester.pumpAndSettle();

      expect(find.textContaining("声纹"), findsNothing);
      expect(find.text("录入声纹"), findsNothing);
      expect(find.text("清除声纹"), findsNothing);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
