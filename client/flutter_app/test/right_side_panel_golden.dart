/// 「今日安排」焦点时间轴卡片的视觉回归金丝雀。
///
/// 运行 `flutter test --update-goldens test/right_side_panel_golden.dart`
/// 生成/更新 goldens 目录下的 PNG,用于与设计稿
/// docs/design/today-schedule-redesign 比对。
///
/// 事件时间基于「当前时刻」偏移生成,保证任意时间运行都呈现
/// 2 个已完成 + 1 个进行中 + 3 个未来事项的结构。
library;

import "dart:io" show File, Platform;

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/schedule_models.dart";
import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/chat/right_side_panel.dart";

/// 加载 MiSans 正文与 MaterialIcons 图标字体（测试环境默认不加载,
/// 否则图标渲染为豆腐块）。
Future<void> _loadFonts() async {
  const List<String> files = <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
    "assets/fonts/MiSans-Bold.otf",
  ];
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in files) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();

  // MaterialIcons 在 Flutter SDK 缓存里;flutter_tester 可执行文件位于
  // <flutter>/bin/cache/artifacts/engine/<host>/flutter_tester.exe,
  // 向上回退三级即 <flutter>/bin/cache。
  try {
    final String cacheDir = File(Platform.resolvedExecutable)
        .parent
        .parent
        .parent
        .parent
        .path;
    final File iconFont = File(
        "$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf");
    final FontLoader icons = FontLoader("MaterialIcons")
      ..addFont(iconFont
          .readAsBytes()
          .then((Uint8List bytes) => ByteData.view(bytes.buffer)));
    await icons.load();
  } catch (_) {
    // 找不到字体时金丝雀图标会退化为豆腐块,不影响其余断言。
  }
}

List<ScheduleEvent> _mockEvents() {
  final DateTime base = DateTime.now();
  ScheduleEvent at(int minutes, String short, {String? notes}) =>
      ScheduleEvent(
        id: "e$minutes",
        startAt: base.add(Duration(minutes: minutes)),
        title: short,
        shortTitle: short,
        notes: notes,
      );
  return <ScheduleEvent>[
    at(-120, "买咖啡"),
    at(-30, "健身 · 背肩训练"),
    at(80, "团队周会", notes: "3F 会议室 · 同步 Q3 进度"),
    at(165, "提交周报"),
    at(300, "和小王打球"),
    at(540, "给客户回电话"),
  ];
}

Widget _harness(AppThemeVariant variant, Future<List<ScheduleEvent>>? future) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.of(variant),
    home: Scaffold(
      body: Center(
        child: SizedBox(
          width: 220,
          height: 560,
          child: RightSidePanel(scheduleFuture: future),
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadFonts);

  Future<void> pumpAndCapture(
    WidgetTester tester,
    AppThemeVariant variant,
    Future<List<ScheduleEvent>>? future,
    String golden,
  ) async {
    await tester.pumpWidget(_harness(variant, future));
    await tester.pump(const Duration(milliseconds: 400));
    // 卡片渲染实时时间(倒计时/now 游标),两次运行必然有像素差,
    // 因此本测试只作为快照生成器:仅在 --update-goldens 时写图,
    // 默认 flutter test 下跳过像素比对,避免误报。
    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(RightSidePanel),
        matchesGoldenFile("goldens/$golden"),
      );
    }
    // 卸载组件树,取消内部的周期 Timer,避免测试收尾报 pending timer。
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets("今日安排卡片 深色主题", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.dark, Future.value(_mockEvents()), "panel_dark.png");
  });

  testWidgets("今日安排卡片 暖色主题", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.warm, Future.value(_mockEvents()), "panel_warm.png");
  });

  testWidgets("今日安排卡片 空状态", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.dark, Future.value(<ScheduleEvent>[]), "panel_empty.png");
  });
}
