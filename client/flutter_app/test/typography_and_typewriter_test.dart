import "package:fake_async/fake_async.dart";
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:highlight/highlight.dart" as hl;

import "package:nextbot/core/theme/app_typography.dart";
import "package:nextbot/features/chat/code_highlight.dart";
import "package:nextbot/features/chat/typewriter_reveal.dart";

void main() {
  group("TypewriterReveal", () {
    test("非动画模式直接显示全文", () {
      final TypewriterReveal tw = TypewriterReveal("你好世界", animate: false);
      expect(tw.revealed, "你好世界");
      expect(tw.isPartial, isFalse);
      expect(tw.active, isFalse);
      tw.dispose();
    });

    test("流式追加逐字 reveal,句末按句长停顿", () {
      fakeAsync((FakeAsync async) {
        final TypewriterReveal tw =
            TypewriterReveal("第一句。第二句", animate: true);
        // 初始为空,开始打字
        async.elapse(const Duration(milliseconds: 10));
        expect(tw.isRevealing, isTrue);

        // 打完第一句(含句号,共 4 字):4 次 20ms tick
        async.elapse(const Duration(milliseconds: 200));
        expect(tw.revealed, "第一句。");
        expect(tw.isPartial, isTrue);

        // 句末停顿(短句 260ms)后继续打第二句
        async.elapse(const Duration(milliseconds: 300));
        expect(tw.revealed.length, greaterThan(4));

        // 打完全部内容后停止
        async.elapse(const Duration(seconds: 2));
        expect(tw.isPartial, isFalse);
        expect(tw.isRevealing, isFalse);
        tw.dispose();
      });
    });

    test("内容被替换时直接显示全文", () {
      fakeAsync((FakeAsync async) {
        final TypewriterReveal tw = TypewriterReveal("原始内容", animate: true);
        async.elapse(const Duration(milliseconds: 60));
        // 先打出一部分,确认处于打字中
        expect(tw.isRevealing, isTrue);
        // 完全不同的内容(非前缀延伸)→ 立即全文
        tw.updateTarget("替换后的内容");
        expect(tw.revealed, "替换后的内容");
        expect(tw.isRevealing, isFalse);
        tw.dispose();
      });
    });

    test("前缀延伸时从中途继续逐字 reveal", () {
      fakeAsync((FakeAsync async) {
        final TypewriterReveal tw =
            TypewriterReveal("一二三四五", animate: true);
        async.elapse(const Duration(milliseconds: 50));
        final int revealedSoFar = tw.revealed.length;
        expect(revealedSoFar, inInclusiveRange(1, 4));

        tw.updateTarget("一二三四五六七八九十");
        async.elapse(const Duration(seconds: 1));
        expect(tw.revealed, "一二三四五六七八九十");
        tw.dispose();
      });
    });

    test("showAll 立即显示全文", () {
      fakeAsync((FakeAsync async) {
        final TypewriterReveal tw = TypewriterReveal("慢慢打字", animate: true);
        async.elapse(const Duration(milliseconds: 10));
        tw.showAll();
        expect(tw.revealed, "慢慢打字");
        expect(tw.active, isFalse);
        tw.dispose();
      });
    });
  });

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
