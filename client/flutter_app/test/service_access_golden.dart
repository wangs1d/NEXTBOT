/// 「服务接入」实际效果图生成器（2026-10-20）。
///
/// 运行 `flutter test --update-goldens test/service_access_golden.dart`
/// 生成 test/goldens/ 下两张 PNG：
///  - desktop_service_access.png —— 桌面设置页「服务接入」分区（邮箱盯梢胶囊）
///  - mobile_service_access.png  —— 手机端「服务接入」页（滚到邮箱盯梢胶囊）
///
/// 走真实本机 dev server（把 flutter_test 的 HttpOverrides 置空放开真实 HTTP）——
/// 呈现的是生产组件 + 真实数据下的实际效果，不是手搭的示意图。
/// 默认 flutter test（不带 --update-goldens）不写图也不比对，避免网络差异误报。
library;

import "dart:io" show File, HttpOverrides, Platform;

import "package:flutter/foundation.dart" show debugDefaultTargetPlatformOverride;
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/settings/settings_page.dart";
import "package:nextbot/mobile_ui/mobile_service_access_page.dart";
import "package:nextbot/mobile_ui/mobile_theme.dart";

/// 加载 MiSans 正文与 MaterialIcons 图标字体（测试环境默认不加载，
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

  try {
    final String cacheDir =
        File(Platform.resolvedExecutable).parent.parent.parent.parent.path;
    final File iconFont =
        File("$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf");
    final FontLoader icons = FontLoader("MaterialIcons")
      ..addFont(iconFont
          .readAsBytes()
          .then((Uint8List bytes) => ByteData.view(bytes.buffer)));
    await icons.load();
  } catch (_) {
    // 找不到字体时图标退化为豆腐块，不影响版面其余部分
  }
}

/// 等首屏数据落地：pump 与等待都放进 runAsync，让真实 IO 事件循环跑起来
/// （widget 自己的 http 调用在 fake-async 区里发起的，必须在真实区里完成）。
Future<void> _pumpWithRealHttp(
  WidgetTester tester,
  Widget app, {
  int ms = 1500,
}) async {
  await tester.runAsync(() async {
    await tester.pumpWidget(app);
    await Future<void>.delayed(Duration(milliseconds: ms));
  });
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 250));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await _loadFonts();
    // flutter_test 默认把 HTTP 全部挡成 400；放开以直连本机 dev server
    HttpOverrides.global = null;
    // 窗口标题栏按钮走 window_manager 插件（测试环境无原生实现）：给出确定应答
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel("window_manager"),
      (MethodCall call) async => call.method == "isMaximized" ? false : null,
    );
  });

  testWidgets("桌面设置页 · 服务接入分区", (WidgetTester tester) async {
    // flutter_test 默认平台是 android，「服务接入」分区按 Windows 闸出现
    // （foundation 调试变量必须在测试体内复位，addTearDown 晚于不变量检查）
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    tester.view.physicalSize = const Size(1280, 820);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await _pumpWithRealHttp(
      tester,
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.of(AppThemeVariant.dark),
        home: const SettingsPage(),
      ),
    );

    // 切到「服务接入」分区（邮箱胶囊 + 状态快照）
    await tester.tap(find.text("服务接入"));
    await tester.pump();
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 900)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(SettingsPage),
        matchesGoldenFile("goldens/desktop_service_access.png"),
      );
    }
    debugDefaultTargetPlatformOverride = null;
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  });

  testWidgets("手机端服务接入页 · 邮箱盯梢胶囊", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 880);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await _pumpWithRealHttp(
      tester,
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: MobileTheme.light,
        home: const MobileServiceAccessPage(),
      ),
    );
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 500)));
    await tester.pump();

    // 滚到邮箱盯梢胶囊（页面末尾那块）
    await tester.scrollUntilVisible(
      find.text("邮箱盯梢"),
      320,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    await tester.pump(const Duration(milliseconds: 200));

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("goldens/mobile_service_access.png"),
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  });
}
