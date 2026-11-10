/// 排版与代码高亮回归测试（原 typography_and_typewriter_test：
/// 2026-11-10 打字机全量下线，TypewriterReveal 组随类一并删除）。
library;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:highlight/highlight.dart" as hl;

import "package:nextbot/core/theme/app_typography.dart";
import "package:nextbot/features/chat/code_highlight.dart";

void main() {
  group("buildHighlightedCode", () {
    test("dart 代码高亮:关键字着色为 TextSpan 树", () {
      const TextStyle base = TextStyle(fontSize: 13);
      final TextSpan span = buildHighlightedCode(
        'void main() { print("hi"); }',
        "dart",
        base,
        CodeHighlightTheme.dark,
      );
      expect(span.children, isNotNull);
      // "void" 是 dart 关键字,应命中 keyword 配色
      final String flat = _flatten(span);
      expect(flat, contains("void"));
      expect(_hasColoredChild(span, const Color(0xFFC678DD)), isTrue);
    });

    test("未知语言回退纯文本(不抛异常)", () {
      const TextStyle base = TextStyle(fontSize: 13);
      final TextSpan span = buildHighlightedCode(
        "随便一些内容 not-a-language",
        "no-such-lang",
        base,
        CodeHighlightTheme.light,
      );
      // 未知语言要么整体回退纯文本、要么按普通节点解析,内容必须完整保留
      expect(_flatten(span), "随便一些内容 not-a-language");
    });

    test("无语言时自动检测", () {
      const TextStyle base = TextStyle(fontSize: 13);
      final TextSpan span = buildHighlightedCode(
        '<html><body>hi</body></html>',
        null,
        base,
        CodeHighlightTheme.dark,
      );
      // 自动检测出 html 后应有子 span(标签着色)
      expect(span.children, isNotNull);
      expect(_flatten(span), contains("html"));
    });

    test("highlight 包可用性冒烟:dart 语言解析非空", () {
      final hl.Result r = hl.highlight.parse("void main() {}", language: "dart");
      expect(r.nodes, isNotNull);
      expect(r.nodes, isNotEmpty);
    });
  });

  group("AppTypography", () {
    test("applyLineHeights 写入正文/标题行高", () {
      final TextTheme themed = AppTypography.applyLineHeights(
        const TextTheme(bodyMedium: TextStyle(fontSize: 14)),
      );
      expect(themed.bodyMedium!.height, AppTypography.bodyLineHeight);
      expect(themed.titleMedium!.height, AppTypography.headingLineHeight);
      // label 档不动(M3 默认)
      expect(themed.labelLarge, isNull);
    });

    test("inlineCode 缩一号并使用等宽字体", () {
      final TextStyle style = AppTypography.inlineCode(
        const TextStyle(fontSize: 14),
        const Color(0x11000000),
      );
      expect(style.fontFamily, AppTypography.monoFontFamily);
      expect(style.fontSize, 13);
      expect(style.backgroundColor, const Color(0x11000000));
    });
  });
}

String _flatten(TextSpan span) {
  final StringBuffer buf = StringBuffer();
  void walk(InlineSpan s) {
    if (s is TextSpan) {
      buf.write(s.text ?? "");
      s.children?.forEach(walk);
    }
  }

  walk(span);
  return buf.toString();
}

bool _hasColoredChild(TextSpan span, Color color) {
  bool walk(InlineSpan s) {
    if (s is TextSpan) {
      if (s.style?.color == color) return true;
      return s.children?.any(walk) ?? false;
    }
    return false;
  }

  return walk(span);
}
