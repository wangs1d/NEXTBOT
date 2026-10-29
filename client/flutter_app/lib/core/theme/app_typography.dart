import "package:flutter/material.dart";

/// 全局排版 token(桌面端与手机端共用)。
///
/// 项目内所有文字排版统一引用这里的字号/行高,不再手写字面量:
/// - 字号收敛为 8 档阶梯,消灭 10.5 / 12.8 之类的碎片化取值;
/// - 行高收敛为 4 档:正文 1.6(CJK 长文阅读最优)、标题 1.3、
///   紧凑(表格/代码)1.5、控件单行 1.4;
/// - [applyLineHeights] 把行高写入 M3 默认 TextTheme,
///   未显式覆盖行高的样式自动继承同一套值。
abstract final class AppTypography {
  // ═══════════════════════════════════════════════════════════
  // 字号阶梯(唯一允许使用的档位)
  // ═══════════════════════════════════════════════════════════

  /// 大标题 / 数字展示
  static const double display = 20;

  /// 阅读态文档大标题(摘要详情等)
  static const double docTitle = 24;

  /// 页面标题 / 一级标题
  static const double title = 17;

  /// 区块标题
  static const double heading = 15;

  /// 移动端正文(触屏阅读偏大一号)
  static const double bodyLarge = 16;

  /// 桌面端正文
  static const double body = 14;

  /// 辅助说明文字
  static const double secondary = 13;

  /// 次要信息 / 头像旁名称
  static const double caption = 12;

  /// 时间戳 / 徽标等最小可读文字
  static const double micro = 11;

  // ═══════════════════════════════════════════════════════════
  // 间距阶梯(唯一允许使用的档位,消灭 5/6/7/10 之类碎片化取值)
  // ═══════════════════════════════════════════════════════════

  /// 紧贴元素:行内小组件、列表项内微调
  static const double space1 = 4;

  /// 同组元素:列表项之间、段落之间
  static const double space2 = 8;

  /// 邻组元素:正文与卡片、卡片与卡片之间
  static const double space3 = 12;

  /// 大板块间距 / 容器内边距
  static const double space4 = 16;

  /// 页面级留白
  static const double space5 = 24;

  // ═══════════════════════════════════════════════════════════
  // 行高(4 档)
  // ═══════════════════════════════════════════════════════════

  /// 正文(CJK 长文阅读最优)
  static const double bodyLineHeight = 1.6;

  /// 标题
  static const double headingLineHeight = 1.3;

  /// 紧凑内容(表格单元格 / 代码块)
  static const double compactLineHeight = 1.5;

  /// 控件 / 单行 UI 文字
  static const double uiLineHeight = 1.4;

  /// 等宽字体族(代码块 / 行内 code)。
  static const String monoFontFamily = "monospace";

  /// 头像与「名称/时间行」的顶部对齐偏移:
  /// 行盒顶部自带半行距 leading,取 (行盒高 - 字号) / 2,
  /// 让头像盒顶部与文字字形顶部对齐;字号/行高调整后自动跟随。
  static double get avatarHeaderOffset =>
      (caption * headingLineHeight - caption) / 2;

  /// 把统一行高写入 M3 默认 [TextTheme](display/title/body 档),
  /// label 档(按钮/徽标)保持 M3 默认不动。
  static TextTheme applyLineHeights(TextTheme base) {
    TextStyle withHeight(TextStyle? style, double height) =>
        (style ?? const TextStyle()).copyWith(height: height);

    return base.copyWith(
      displayLarge: withHeight(base.displayLarge, headingLineHeight),
      displayMedium: withHeight(base.displayMedium, headingLineHeight),
      displaySmall: withHeight(base.displaySmall, headingLineHeight),
      headlineLarge: withHeight(base.headlineLarge, headingLineHeight),
      headlineMedium: withHeight(base.headlineMedium, headingLineHeight),
      headlineSmall: withHeight(base.headlineSmall, headingLineHeight),
      titleLarge: withHeight(base.titleLarge, headingLineHeight),
      titleMedium: withHeight(base.titleMedium, headingLineHeight),
      titleSmall: withHeight(base.titleSmall, headingLineHeight),
      bodyLarge: withHeight(base.bodyLarge, bodyLineHeight),
      bodyMedium: withHeight(base.bodyMedium, bodyLineHeight),
      bodySmall: withHeight(base.bodySmall, compactLineHeight),
    );
  }

  /// 行内 code 样式:等宽字体、略缩一号、浅底色。
  /// 与 MiSans 混排时靠「字号 -1 + 继承正文行高」尽量保持基线对齐。
  static TextStyle inlineCode(TextStyle base, Color background) {
    return base.copyWith(
      fontFamily: monoFontFamily,
      fontSize: (base.fontSize ?? body) - 1,
      backgroundColor: background,
    );
  }

  /// 行内 code 前景样式(无底色版本):底色与圆角由容器绘制,
  /// 见 content_summary_detail_formatter 的行内 code WidgetSpan。
  static TextStyle inlineCodeForeground(TextStyle base) {
    return base.copyWith(
      fontFamily: monoFontFamily,
      fontSize: (base.fontSize ?? body) - 1,
    );
  }

  /// 行内 code 底色圆角的圆角半径。
  static const double inlineCodeRadius = 4;

  /// 助手正文的唯一来源:onSurface 全不透明 + 1.6 行高。
  /// 此前 replyBlocks 路径 0.85 透明度、结构化路径全不透明,同屏两种灰度;
  /// 统一从这里取,消灭双轨。
  static TextStyle assistantBody(TextTheme textTheme, ColorScheme cs) {
    return textTheme.bodyMedium!.copyWith(
      color: cs.onSurface,
      height: bodyLineHeight,
    );
  }
}
