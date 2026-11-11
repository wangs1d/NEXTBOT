import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";

/// 手机端 App 级装配的**唯一单源**（2026-11-10 白条修复教训收敛）。
///
/// 背景：曾经 main.dart（正式 APK 入口）与 main_mobile.dart（已删除的
/// 桌面调试入口）各自养一份系统栏装配，改了一边另一边不知道，表现为
/// 「模拟器调试一切正常、真机一点没变」。2026-11-10 调试入口废除后，
/// 手机 UI 一律走 main.dart 生产路径（模拟器/真机 flutter run），
/// 本模块是其 App 级装配的唯一来源。
///
/// 边界：只管「系统栏 / edge-to-edge」这一类窗口级装配；登录门禁、主题
/// 状态、会话恢复等业务装配仍归各入口流程（首启向导、控制面注册等
/// 生产链路只在 main.dart 中）。

/// 配置手机系统栏（幂等，main 阶段调用一次）：
/// 开 edge-to-edge + 状态栏/导航条全透明 + 关 Android 10+ 对比度遮罩。
///
/// Android 14 及以下 targetSdk 不会自动 edge-to-edge，系统导航条区域由
/// 系统主题涂色（App 深色 + 系统浅色时是刺眼白条）；显式开启后该区域透出
/// App 内容底色。桌面平台（Windows/macOS/Linux）与 Web 直接 no-op。
void configureMobileSystemUI() {
  if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return;
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      systemNavigationBarColor: Colors.transparent,
      // Android 10+ 对透明导航条强制加对比度遮罩，关掉才真正全透明
      systemNavigationBarContrastEnforced: false,
    ),
  );
}

/// 手机端系统栏 AnnotatedRegion：状态栏/导航条图标亮度按实际生效主题
/// （跟随系统时看平台亮度）切换，保证可读。包在每个手机端 MaterialApp
/// 的 home 外层——登录门禁（黑底）传 [ThemeMode.dark]，主壳传当前
/// [ThemeMode]。
class MobileSystemBars extends StatelessWidget {
  const MobileSystemBars({super.key, required this.themeMode, required this.child});

  /// 实际生效的主题档：主壳传 MaterialApp 的 themeMode；固定深底的页面
  /// （登录门禁）直接传 ThemeMode.dark。
  final ThemeMode themeMode;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final bool effectiveDark = switch (themeMode) {
      ThemeMode.dark => true,
      ThemeMode.light => false,
      ThemeMode.system =>
        MediaQuery.platformBrightnessOf(context) == Brightness.dark,
    };
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness:
            effectiveDark ? Brightness.light : Brightness.dark,
        systemNavigationBarColor: Colors.transparent,
        systemNavigationBarContrastEnforced: false,
        systemNavigationBarIconBrightness:
            effectiveDark ? Brightness.light : Brightness.dark,
      ),
      child: child,
    );
  }
}
