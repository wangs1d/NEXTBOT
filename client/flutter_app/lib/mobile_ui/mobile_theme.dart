import "package:flutter/material.dart";

import "../core/theme/app_typography.dart";

/// 手机端配色(浅 / 深两套)。
///
/// 遵循「简洁现代、白黑为主」的方向:
/// - 浅色:白底 + 近黑文字,强调色收敛为纯净黑,点缀低饱和蓝用于链接。
/// - 深色:近黑底 + 亮白文字,用户气泡翻转为白底黑字,与浅色视觉对称。
/// - 与桌面端 [AppTheme] 完全独立,互不影响。
@immutable
class MobilePalette {
  const MobilePalette({
    required this.background,
    required this.surface,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.accent,
    required this.onAccent,
    required this.link,
    required this.userBubble,
    required this.userBubbleText,
    required this.assistantBubble,
    required this.assistantBubbleText,
    required this.divider,
    required this.online,
    required this.innerFieldBackground,
  });

  /// 页面底色(极浅灰,白黑之间)
  final Color background;

  /// 卡片 / 输入栏底
  final Color surface;

  /// 主文字(近黑)
  final Color textPrimary;

  /// 次要文字
  final Color textSecondary;

  /// 弱化文字 / 时间
  final Color textMuted;

  /// 强调色(发送按钮 / 图标)
  final Color accent;

  /// 强调色上的文字/图标颜色
  final Color onAccent;

  /// 链接(低饱和蓝,极少量点缀)
  final Color link;

  /// 用户气泡底
  final Color userBubble;

  /// 用户气泡文字
  final Color userBubbleText;

  /// 助手气泡底(浅灰)
  final Color assistantBubble;

  /// 助手文字(近黑)
  final Color assistantBubbleText;

  /// 分隔线
  final Color divider;

  /// 在线状态点
  final Color online;

  /// 输入框内层背景(比页面略亮)
  final Color innerFieldBackground;

  static const MobilePalette light = MobilePalette(
    background: Color(0xFFF7F7F8),
    surface: Color(0xFFFFFFFF),
    textPrimary: Color(0xFF111112),
    textSecondary: Color(0xFF70707A),
    textMuted: Color(0xFFA6A6AF),
    accent: Color(0xFF000000),
    onAccent: Colors.white,
    link: Color(0xFF3B82F6),
    userBubble: Color(0xFF000000),
    userBubbleText: Color(0xFFFFFFFF),
    assistantBubble: Color(0xFFECECEF),
    assistantBubbleText: Color(0xFF1A1A1C),
    divider: Color(0xFFEDEDEF),
    online: Color(0xFF22C55E),
    innerFieldBackground: Color(0xFFF2F2F4),
  );

  static const MobilePalette dark = MobilePalette(
    background: Color(0xFF121214),
    surface: Color(0xFF1B1B1E),
    textPrimary: Color(0xFFF2F2F4),
    textSecondary: Color(0xFF9A9AA2),
    textMuted: Color(0xFF6C6C75),
    accent: Color(0xFFFFFFFF),
    onAccent: Color(0xFF000000),
    link: Color(0xFF5B9DFF),
    userBubble: Color(0xFFFFFFFF),
    userBubbleText: Color(0xFF000000),
    assistantBubble: Color(0xFF26262B),
    assistantBubbleText: Color(0xFFE9E9EC),
    divider: Color(0xFF26262B),
    online: Color(0xFF22C55E),
    innerFieldBackground: Color(0xFF26262B),
  );
}

/// 手机端(App)主题工具。
abstract final class MobileTheme {
  /// 按当前 [BuildContext] 的亮度解析配色(深色主题下自动切换)。
  static MobilePalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
          ? MobilePalette.dark
          : MobilePalette.light;

  /// 输入框圆角(现代极简,大圆角)。
  static const double inputRadius = 24;

  /// 气泡圆角(用户 / 助手可对称)。
  static const double bubbleRadius = 20;

  /// 浅色主题。
  static ThemeData get light => _build(MobilePalette.light, Brightness.light);

  /// 深色主题。
  static ThemeData get dark => _build(MobilePalette.dark, Brightness.dark);

  /// 兼容别名:浅色主题。
  static ThemeData get material => light;

  static ThemeData _build(MobilePalette p, Brightness brightness) {
    final bool isLight = brightness == Brightness.light;
    final ColorScheme cs = ColorScheme(
      brightness: brightness,
      primary: p.accent,
      onPrimary: p.onAccent,
      secondary: p.accent,
      onSecondary: p.onAccent,
      error: const Color(0xFFE5484D),
      onError: Colors.white,
      surface: p.surface,
      onSurface: p.textPrimary,
      onSurfaceVariant: p.textSecondary,
      outline: p.divider,
      outlineVariant: p.divider,
      surfaceContainerHighest: p.assistantBubble,
      surfaceContainerHigh: p.innerFieldBackground,
      surfaceContainer: p.background,
      surfaceContainerLow: p.surface,
      surfaceContainerLowest: p.surface,
    );

    final ThemeData theme = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: cs,
      scaffoldBackgroundColor: p.background,
      splashFactory: InkSparkle.splashFactory,
      // 全局字体族跟随桌面统一 MiSans,移动端同样内嵌生效
      fontFamily: "MiSans",
      fontFamilyFallback: const [
        "PingFang SC",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "sans-serif",
      ],
      appBarTheme: AppBarTheme(
        backgroundColor: p.surface,
        foregroundColor: p.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
        titleTextStyle: TextStyle(
          color: p.textPrimary,
          fontSize: 17,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.2,
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: p.accent,
        selectionColor:
            (isLight ? const Color(0x22000000) : const Color(0x33FFFFFF)),
        selectionHandleColor: p.accent,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor:
            isLight ? const Color(0xFF1A1A1C) : const Color(0xFFE9E9EC),
        contentTextStyle: TextStyle(
          color: isLight ? Colors.white : const Color(0xFF000000),
          fontSize: 14,
        ),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(14)),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: p.divider,
        thickness: 1,
        space: 1,
      ),
      // 手机端关闭全部水波纹 / focus ring 的高亮过渡,更克制
      focusColor: Colors.transparent,
      hoverColor: Colors.transparent,
      highlightColor:
          isLight ? const Color(0x0D000000) : const Color(0x14FFFFFF),
    );
    // 统一排版:与桌面端共用同一套行高 token
    return theme.copyWith(
      textTheme: AppTypography.applyLineHeights(theme.textTheme),
    );
  }
}
