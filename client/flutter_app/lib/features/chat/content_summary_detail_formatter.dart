import "dart:async";
import "dart:math" as math;

import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/services/image_preview_launcher.dart";
import "../../core/theme/app_typography.dart";
import "accent_panel.dart";
import "code_highlight.dart";
import "media_thumbnail.dart";

class MarkdownTableCellData {
  const MarkdownTableCellData({
    required this.text,
    this.colspan = 1,
    this.rowspan = 1,
    this.skip = false,
  });

  final String text;
  final int colspan;
  final int rowspan;
  final bool skip;
}

bool isMarkdownTableRow(String line) {
  final String trimmed = line.trim();
  if (!trimmed.contains("|")) return false;
  return parseMarkdownTableCells(trimmed).length >= 2;
}

bool isMarkdownTableSeparator(String line) {
  final String trimmed = line.trim();
  if (!trimmed.contains("|") || !trimmed.contains("-")) return false;
  return RegExp(r"^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$")
      .hasMatch(trimmed);
}

List<String> parseMarkdownTableCells(String line) {
  String inner = line.trim();
  if (inner.startsWith("|")) inner = inner.substring(1);
  if (inner.endsWith("|")) inner = inner.substring(0, inner.length - 1);
  return inner.split("|").map((String cell) => cell.trim()).toList();
}

MarkdownTableCellData parseMarkdownTableCell(String raw) {
  final String trimmed = raw.trim();
  if (trimmed == "^" || trimmed == "^^") {
    return const MarkdownTableCellData(text: "", skip: true);
  }

  int colspan = 1;
  int rowspan = 1;
  String text = trimmed;

  final RegExp spanPattern = RegExp(
    r"^\{(?:colspan|c)=(\d+)\}(?:\{(?:rowspan|r)=(\d+)\})?\s*",
  );
  final RegExp rowSpanOnly = RegExp(r"^\{(?:rowspan|r)=(\d+)\}\s*");

  RegExpMatch? match = spanPattern.firstMatch(text);
  if (match != null) {
    colspan = int.parse(match.group(1)!);
    if (match.group(2) != null) {
      rowspan = int.parse(match.group(2)!);
    }
    text = text.substring(match.end);
  } else {
    match = rowSpanOnly.firstMatch(text);
    if (match != null) {
      rowspan = int.parse(match.group(1)!);
      text = text.substring(match.end);
    }
  }

  return MarkdownTableCellData(
    text: text,
    colspan: colspan,
    rowspan: rowspan,
  );
}

/// 内容区分隔线（HR / 导语后分隔）的唯一来源。
/// 此前 HR、导语后、dividerTheme 三处三种透明度/粗细，同屏不一致。
Widget buildContentDivider(ColorScheme cs) {
  return Divider(
    height: 1,
    thickness: 1,
    color: cs.outline.withValues(alpha: 0.2),
  );
}

List<Widget> formatContentSummaryDetailLines(
  String content,
  ColorScheme cs,
  TextTheme textTheme, {
  Map<int, GlobalKey>? sectionKeys,
  List<String>? sectionTitles,
}) {
  final RegExp sectionHeader = RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]");
  final RegExp markdownHeader = RegExp(r"^(#{1,6})\s+");
  // 列表捕获缩进（group 1），用于嵌套层级缩进展示
  final RegExp listItem = RegExp(r"^([ \t]*)[-•*→▸‣⁃◦·]\s+(.*)$");
  final RegExp orderedListItem = RegExp(r"^([ \t]*)(\d+[.)])\s+(.*)$");
  // markdown 分隔线（--- / *** / ___）：标杆排版用它划分大板块
  final RegExp horizontalRule = RegExp(r"^(-{3,}|\*{3,}|_{3,})$");

  final TextStyle bodyStyle = AppTypography.assistantBody(textTheme, cs);

  // 普通段落行：非空且不属于任何结构块（标题/列表/表格/代码/引用/图片/分隔线）
  bool isPlainLine(String rawLine) {
    final String trimmed = rawLine.trim();
    if (trimmed.isEmpty) return false;
    if (horizontalRule.hasMatch(trimmed)) return false;
    if (trimmed.startsWith("```") || trimmed.startsWith(">")) return false;
    if (sectionHeader.hasMatch(trimmed) || markdownHeader.hasMatch(trimmed)) {
      return false;
    }
    if (_isCompactSectionHeader(trimmed, listItem, orderedListItem)) {
      return false;
    }
    if (listItem.hasMatch(rawLine) || orderedListItem.hasMatch(rawLine)) {
      return false;
    }
    if (isMarkdownTableRow(trimmed)) return false;
    if (_standaloneImageLine(trimmed) != null) return false;
    return true;
  }

  final List<String> lines = content.split("\n");
  final List<Widget> widgets = <Widget>[];
  int index = 0;
  // 上一块是否为列表：列表 → 段落过渡时补一个组间距，衔接前后节奏
  bool lastWasList = false;

  while (index < lines.length) {
    final String trimmed = lines[index].trim();
    final String rawLine = lines[index];

    // 空行不再单独补高度：段间距统一由段落自身的 bottom 提供，
    // 消灭「单换行分段挤、空行分段松」的疏密不一致。
    if (trimmed.isEmpty) {
      index++;
      continue;
    }

    if (horizontalRule.hasMatch(trimmed)) {
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(
            top: AppTypography.space2,
            bottom: AppTypography.space3,
          ),
          child: buildContentDivider(cs),
        ),
      );
      lastWasList = false;
      index++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      // 代码块：```lang 可选语言 → 语言头部 + 可复制代码体（分层卡片）
      final String opener = trimmed;
      String? language;
      if (opener.length > 3) {
        final String rest = opener.substring(3).trim();
        final List<String> parts = rest.split(RegExp(r"\s+")).toList()
          ..removeWhere((e) => e.isEmpty);
        language = parts.isEmpty ? null : parts.first;
      }
      final int start = index;
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        index++;
      }
      if (index < lines.length) index++;
      final String code = lines.sublist(start + 1, index - 1).join("\n");
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(
            bottom: AppTypography.space3,
            top: AppTypography.space1,
          ),
          child: _CodeBlockWidget(
            code: code,
            language: language,
            cs: cs,
            textTheme: textTheme,
          ),
        ),
      );
      lastWasList = false;
      continue;
    }

    if (trimmed.startsWith(">")) {
      final int start = index;
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        index++;
      }
      final String quote = lines
          .sublist(start, index)
          .map((String line) => line.trim().replaceFirst(RegExp(r"^>\s?"), ""))
          .join("\n");
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(
            bottom: AppTypography.space3,
            top: AppTypography.space1,
          ),
          child: _BlockquoteWidget(text: quote, cs: cs, textTheme: textTheme),
        ),
      );
      lastWasList = false;
      continue;
    }

    if (sectionHeader.hasMatch(trimmed) ||
        markdownHeader.hasMatch(trimmed) ||
        _isCompactSectionHeader(trimmed, listItem, orderedListItem)) {
      final String title = markdownHeader.hasMatch(trimmed)
          ? trimmed.replaceFirst(markdownHeader, "").trim()
          : trimmed;
      final int level = _headingLevel(trimmed, markdownHeader, sectionHeader);
      final GlobalKey? key =
          _matchSectionKey(title, sectionTitles, sectionKeys);
      // 首块是标题时折叠 top 间距：文档开头顶格，不留无来源的空行
      final bool isFirstBlock = widgets.isEmpty;
      widgets.add(
        Padding(
          key: key,
          padding: EdgeInsets.only(
            top: isFirstBlock
                ? 0
                : level == 1
                    ? AppTypography.space4
                    : AppTypography.space2,
            bottom: level == 1 ? AppTypography.space2 : AppTypography.space1,
          ),
          child: level == 1
              ? _Level1Heading(
                  title: title,
                  cs: cs,
                  textTheme: textTheme,
                )
              : _Level2Heading(
                  title: title,
                  tertiary: level >= 3,
                  cs: cs,
                  textTheme: textTheme,
                ),
        ),
      );
      lastWasList = false;
      index++;
      continue;
    }

    // 独占一行的图片（markdown 图 / 裸图片 URL）→ 块级渲染：
    // 不再作为 220×150 固定缩略图塞进行内撑乱行高。
    final String? standaloneImage = _standaloneImageLine(trimmed);
    if (standaloneImage != null) {
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(
            top: AppTypography.space1,
            bottom: AppTypography.space3,
          ),
          child: _BlockImage(url: standaloneImage, cs: cs),
        ),
      );
      lastWasList = false;
      index++;
      continue;
    }

    // 列表（含嵌套）：按原始行的前导空白计算层级缩进（2 空格一级，最多 3 级）
    final RegExpMatch? bulletMatch = listItem.firstMatch(rawLine);
    final RegExpMatch? orderedMatch =
        bulletMatch == null ? orderedListItem.firstMatch(rawLine) : null;
    if (bulletMatch != null || orderedMatch != null) {
      final RegExpMatch m = bulletMatch ?? orderedMatch!;
      final String indentStr = m.group(1)!;
      final String itemText = (bulletMatch != null
              ? bulletMatch.group(2)!
              : orderedMatch!.group(3)!)
          .trim();
      final String marker = bulletMatch != null ? "•" : orderedMatch!.group(2)!;
      final int depth =
          (indentStr.replaceAll("\t", "  ").length / 2).round().clamp(0, 3);
      // 有序列表编号右对齐：1. 与 10. 的正文起点保持对齐，不随位数错位
      final TextAlign markerAlign =
          bulletMatch != null ? TextAlign.left : TextAlign.right;
      widgets.add(
        Padding(
          padding: EdgeInsets.only(
            left: 4.0 + depth * 18,
            bottom: AppTypography.space1,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SizedBox(
                width: 22,
                child: Text(
                  marker,
                  textAlign: markerAlign,
                  style: TextStyle(color: cs.onSurfaceVariant),
                ),
              ),
              Expanded(
                child: buildInlineMarkdownText(itemText, bodyStyle, cs: cs),
              ),
            ],
          ),
        ),
      );
      lastWasList = true;
      index++;
      continue;
    }

    if (isMarkdownTableRow(trimmed)) {
      final int start = index;
      while (index < lines.length && isMarkdownTableRow(lines[index].trim())) {
        index++;
      }
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(
            bottom: AppTypography.space3,
            top: AppTypography.space1,
          ),
          child: MarkdownTableWidget(
            lines: lines.sublist(start, index),
            cs: cs,
            textTheme: textTheme,
          ),
        ),
      );
      lastWasList = false;
      continue;
    }

    // 普通段落：连续普通行合并为一段（Text 保留软换行），段间距统一 8。
    final int start = index;
    while (index < lines.length && isPlainLine(lines[index])) {
      index++;
    }
    final String paragraph = lines.sublist(start, index).join("\n").trim();
    widgets.add(
      Padding(
        padding: EdgeInsets.only(
          top: lastWasList ? AppTypography.space1 : 0,
          bottom: AppTypography.space2,
        ),
        child: buildInlineMarkdownText(paragraph, bodyStyle, cs: cs),
      ),
    );
    lastWasList = false;
  }

  return widgets;
}

bool _isCompactSectionHeader(
  String line,
  RegExp listItem,
  RegExp orderedListItem,
) {
  if (line.length < 4 || line.length > 42) return false;
  if (!(line.contains("：") || line.contains(":"))) return false;
  if (line.contains("。")) return false;
  if (listItem.hasMatch(line) || orderedListItem.hasMatch(line)) return false;
  if (line.startsWith(">") || line.startsWith("```")) return false;
  return true;
}

/// 标题层级判定（用于视觉层级区分）：
///   level 1：# / ## / 一、二、三、 → 大标题（左侧强调条）
///   level 2：### / #### / 「标题：」短行 → 次级标题
///   level 3：#####+ → 三级标题（弱化显示）
int _headingLevel(
  String line,
  RegExp markdownHeader,
  RegExp sectionHeader,
) {
  final RegExpMatch? md = markdownHeader.firstMatch(line);
  if (md != null) {
    final int hashCount = md.group(1)!.length;
    if (hashCount <= 2) return 1;
    if (hashCount <= 4) return 2;
    return 3;
  }
  if (sectionHeader.hasMatch(line)) return 1;
  return 2;
}

/// 一级标题：左侧强调条 + 更大字重（对应「一、」「# / ##」）。
class _Level1Heading extends StatelessWidget {
  const _Level1Heading({
    required this.title,
    required this.cs,
    required this.textTheme,
  });

  final String title;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return AccentPanel(
      cs: cs,
      radius: 6,
      accentAlpha: 0.55,
      fillAlpha: 0.10,
      padding: const EdgeInsets.only(left: 9, top: 3, bottom: 3),
      child: buildInlineMarkdownText(
        title,
        textTheme.titleMedium!.copyWith(
          color: cs.onSurface,
          fontWeight: FontWeight.w800,
          height: AppTypography.headingLineHeight,
          letterSpacing: -0.2,
        ),
        cs: cs,
      ),
    );
  }
}

/// 二级/三级标题：次级字号，三级弱化为 onSurfaceVariant。
class _Level2Heading extends StatelessWidget {
  const _Level2Heading({
    required this.title,
    required this.tertiary,
    required this.cs,
    required this.textTheme,
  });

  final String title;
  final bool tertiary;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return buildInlineMarkdownText(
      title,
      textTheme.titleSmall!.copyWith(
        color: tertiary ? cs.onSurfaceVariant : cs.onSurface,
        fontWeight: FontWeight.w700,
        height: AppTypography.headingLineHeight,
      ),
      cs: cs,
    );
  }
}

GlobalKey? _matchSectionKey(
  String title,
  List<String>? sectionTitles,
  Map<int, GlobalKey>? sectionKeys,
) {
  if (sectionTitles == null || sectionKeys == null) return null;
  for (int i = 0; i < sectionTitles.length; i++) {
    final String sectionTitle = sectionTitles[i].trim();
    if (title.contains(sectionTitle) || sectionTitle.contains(title)) {
      return sectionKeys[i];
    }
  }
  return null;
}

/// 行内 markdown 文本入口。识别器生命周期由 [InlineMarkdownText] 托管。
/// [trailingInline] 可选：拼在末尾的行内组件（打字机光标等），随文本换行流式排布。
Widget buildInlineMarkdownText(
  String text,
  TextStyle baseStyle, {
  required ColorScheme cs,
  Widget? trailingInline,
  int? maxLines,
}) {
  return InlineMarkdownText(
    text: text,
    baseStyle: baseStyle,
    cs: cs,
    trailing: trailingInline,
    maxLines: maxLines,
  );
}

/// 行内 markdown 渲染（加粗/链接/行内 code/删除线/图片）。
///
/// 链接的 [TapGestureRecognizer] 必须有人 dispose：此前内联创建、无人持有，
/// 每次重建都泄漏一个识别器；这里集中登记，销毁时机分两代——
/// 当前帧正在渲染的不能立刻销毁（旧渲染树尚存活），延迟到下一帧后统一释放。
class InlineMarkdownText extends StatefulWidget {
  const InlineMarkdownText({
    super.key,
    required this.text,
    required this.baseStyle,
    required this.cs,
    this.trailing,
    this.maxLines,
  });

  final String text;
  final TextStyle baseStyle;
  final ColorScheme cs;

  /// 拼在末尾的行内组件（WidgetSpan），如打字机光标。
  final Widget? trailing;

  /// 限定行数（超出省略），空值按自然换行
  final int? maxLines;

  @override
  State<InlineMarkdownText> createState() => _InlineMarkdownTextState();
}

class _InlineMarkdownTextState extends State<InlineMarkdownText> {
  List<TapGestureRecognizer> _active = <TapGestureRecognizer>[];
  List<TapGestureRecognizer> _stale = <TapGestureRecognizer>[];

  void _disposeAll(List<TapGestureRecognizer> list) {
    for (final TapGestureRecognizer recognizer in list) {
      recognizer.dispose();
    }
  }

  @override
  void dispose() {
    _disposeAll(_active);
    _disposeAll(_stale);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_stale.isNotEmpty) {
      final List<TapGestureRecognizer> doomed = _stale;
      _stale = <TapGestureRecognizer>[];
      WidgetsBinding.instance.addPostFrameCallback((_) => _disposeAll(doomed));
    }

    final List<TapGestureRecognizer> recognizers = <TapGestureRecognizer>[];
    final List<InlineSpan> spans = parseInlineMarkdownSpans(
      widget.text,
      widget.baseStyle,
      widget.cs,
      recognizers: recognizers,
    );
    _stale = _active;
    _active = recognizers;

    if (spans.length == 1 && spans.first is TextSpan) {
      final TextSpan only = spans.first as TextSpan;
      if (only.style == widget.baseStyle && only.recognizer == null) {
        if (widget.trailing == null) {
          return Text(
            only.text ?? "",
            style: widget.baseStyle,
            maxLines: widget.maxLines,
            overflow: widget.maxLines == null
                ? TextOverflow.clip
                : TextOverflow.ellipsis,
          );
        }
        return Text.rich(
          TextSpan(
            style: widget.baseStyle,
            children: <InlineSpan>[
              TextSpan(text: only.text ?? ""),
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: widget.trailing!,
              ),
            ],
          ),
          maxLines: widget.maxLines,
          overflow: widget.maxLines == null
              ? TextOverflow.clip
              : TextOverflow.ellipsis,
        );
      }
    }
    if (widget.trailing != null) {
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: widget.trailing!,
        ),
      );
    }
    return Text.rich(
      TextSpan(style: widget.baseStyle, children: spans),
      maxLines: widget.maxLines,
      overflow:
          widget.maxLines == null ? TextOverflow.clip : TextOverflow.ellipsis,
    );
  }
}

List<InlineSpan> parseInlineMarkdownSpans(
  String text,
  TextStyle baseStyle,
  ColorScheme cs, {
  List<TapGestureRecognizer>? recognizers,
}) {
  final RegExp tokenPattern = RegExp(
    r"(!\[[^\]]*\]\([^)]+\)|\*\*.+?\*\*|~~.+?~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|_(.+?)_)",
  );

  if (!tokenPattern.hasMatch(text)) {
    return _parsePlainLinks(text, baseStyle, cs, recognizers);
  }

  final List<InlineSpan> spans = <InlineSpan>[];
  int cursor = 0;

  for (final RegExpMatch match in tokenPattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.addAll(
        _parsePlainLinks(
          text.substring(cursor, match.start),
          baseStyle,
          cs,
          recognizers,
        ),
      );
    }

    final String token = match.group(0)!;
    if (token.startsWith("**") && token.endsWith("**")) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: baseStyle.copyWith(fontWeight: FontWeight.w700),
        ),
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: baseStyle.copyWith(
            decoration: TextDecoration.lineThrough,
            color: cs.onSurfaceVariant,
          ),
        ),
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      // 行内 code：圆角浅底胶囊。backgroundColor 无法圆角且色块顶满行盒，
      // 改用 WidgetSpan 容器绘制底色；字号 -1 的基线策略见 AppTypography。
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.65),
              borderRadius:
                  BorderRadius.circular(AppTypography.inlineCodeRadius),
            ),
            child: Text(
              token.substring(1, token.length - 1),
              style: AppTypography.inlineCodeForeground(baseStyle),
            ),
          ),
        ),
      );
    } else if (token.startsWith("![")) {
      // markdown 图片: ![alt](url) → 渲染为内嵌网络图片缩略图，点击应用内预览
      final RegExp imgPattern = RegExp(r"^!\[(.+?)\]\((.+?)\)$");
      final RegExpMatch? imgMatch = imgPattern.firstMatch(token);
      if (imgMatch != null) {
        final String url = imgMatch.group(2)!;
        spans.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.top,
            child: _InlineImage(url: url, cs: cs),
          ),
        );
      } else {
        spans.add(TextSpan(text: token));
      }
    } else if (token.startsWith("[")) {
      // markdown 链接: [text](url) → 渲染为文字链接
      final RegExp linkPattern = RegExp(r"^\[(.+?)\]\((.+?)\)$");
      final RegExpMatch? linkMatch = linkPattern.firstMatch(token);
      if (linkMatch != null) {
        final String label = linkMatch.group(1)!;
        final String url = linkMatch.group(2)!;
        final TapGestureRecognizer recognizer = TapGestureRecognizer()
          ..onTap = () => launchUrlFromText(url);
        recognizers?.add(recognizer);
        spans.add(
          TextSpan(
            text: label,
            style: baseStyle.copyWith(
              color: cs.primary,
              fontWeight: FontWeight.w700,
            ),
            recognizer: recognizer,
          ),
        );
      } else {
        spans.add(TextSpan(text: token));
      }
    } else {
      final String? italic = match.group(2) ?? match.group(3);
      spans.add(
        TextSpan(
          text: italic ?? token,
          style: baseStyle.copyWith(fontStyle: FontStyle.italic),
        ),
      );
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor)));
  }

  return spans;
}

/// 把纯文本段中的裸 URL（未被 markdown 包裹的 http/https 地址）
/// 转成可点击的文字链接：显示域名、主色加粗、点击打开外部浏览器，
/// 避免一长串原始地址直接暴露在正文里。
List<InlineSpan> _parsePlainLinks(
  String text,
  TextStyle baseStyle,
  ColorScheme cs,
  List<TapGestureRecognizer>? recognizers,
) {
  final RegExp urlRe = RegExp(r'https?://[^\s]+');
  if (!urlRe.hasMatch(text)) {
    return <InlineSpan>[TextSpan(text: text)];
  }

  final List<InlineSpan> spans = <InlineSpan>[];
  int cursor = 0;
  for (final RegExpMatch m in urlRe.allMatches(text)) {
    if (m.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, m.start)));
    }
    final String raw = m.group(0)!;
    final String url = raw.replaceAll(RegExp(r'[),.;，。！？、]+$'), '');
    if (url.isEmpty) continue;
    if (_isImageUrl(url)) {
      // 裸图片 URL → 直接渲染为网络图片缩略图
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.top,
          child: _InlineImage(url: url, cs: cs),
        ),
      );
    } else {
      final TapGestureRecognizer recognizer = TapGestureRecognizer()
        ..onTap = () => launchUrlFromText(url);
      recognizers?.add(recognizer);
      spans.add(
        TextSpan(
          text: _linkLabel(url),
          style: baseStyle.copyWith(
            color: cs.primary,
            fontWeight: FontWeight.w700,
          ),
          recognizer: recognizer,
        ),
      );
    }
    cursor = m.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor)));
  }
  return spans;
}

/// 独占一行的图片识别：markdown 图 / 裸图片 URL，返回图片地址。
final RegExp _standaloneImgMarkdown = RegExp(r"^!\[[^\]]*\]\(([^)\s]+)\)$");
final RegExp _standaloneImgBareUrl = RegExp(
  r"^(https?://[^\s]+\.(?:jpe?g|png|gif|webp|avif|bmp|svg)(?:\?[^\s]*)?)$",
  caseSensitive: false,
);

String? _standaloneImageLine(String trimmed) {
  final RegExpMatch? md = _standaloneImgMarkdown.firstMatch(trimmed);
  if (md != null) return md.group(1);
  final RegExpMatch? bare = _standaloneImgBareUrl.firstMatch(trimmed);
  if (bare != null) return bare.group(1);
  return null;
}

/// 从 URL 生成简短文字标签：取域名并去掉 www，作为文字链接的显示文本。
String _linkLabel(String url) {
  final Uri? uri = Uri.tryParse(url);
  final String host = (uri == null || uri.host.isEmpty) ? url : uri.host;
  final String clean = host.replaceFirst(RegExp(r'^www\.'), '');
  return clean.isEmpty ? url : clean;
}

/// 判断 URL 是否指向图片资源（按扩展名）。
bool _isImageUrl(String url) {
  return RegExp(
    r'\.(jpe?g|png|gif|webp|bmp|svg|avif|heic)(\?|#|$)',
    caseSensitive: false,
  ).hasMatch(url);
}

Future<void> launchUrlFromText(String url) async {
  final Uri? uri = Uri.tryParse(url);
  if (uri == null) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

class _CodeBlockWidget extends StatefulWidget {
  const _CodeBlockWidget({
    required this.code,
    required this.language,
    required this.cs,
    required this.textTheme,
  });

  final String code;
  final String? language;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  State<_CodeBlockWidget> createState() => _CodeBlockWidgetState();
}

class _CodeBlockWidgetState extends State<_CodeBlockWidget> {
  bool _copied = false;
  Timer? _resetTimer;

  // 高亮结果缓存:同一段代码只在内容/语言变化时重新解析
  String? _highlightedCode;
  String? _highlightedLanguage;
  TextSpan? _highlightSpan;

  @override
  void dispose() {
    _resetTimer?.cancel();
    super.dispose();
  }

  Future<void> _copyCode() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 1600), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  /// 复制成功反馈色按亮度取值：greenAccent 在浅色头部上对比度不足，
  /// 浅色主题改用深绿；不再硬编码主题外颜色。
  Color _copiedColor(Brightness brightness) => brightness == Brightness.dark
      ? const Color(0xFF7CE8B1)
      : const Color(0xFF177A4C);

  /// 按当前亮度选择深色 / 浅色高亮主题;代码区用固定底色,
  /// 保证高亮配色在桌面深色 / 暖色 / 移动端主题下都可读。
  CodeHighlightTheme _highlightTheme(Brightness brightness) =>
      brightness == Brightness.dark
          ? CodeHighlightTheme.dark
          : CodeHighlightTheme.light;

  TextSpan _highlightSpanFor(TextStyle codeStyle, CodeHighlightTheme theme) {
    if (_highlightSpan == null ||
        _highlightedCode != widget.code ||
        _highlightedLanguage != widget.language) {
      _highlightSpan = buildHighlightedCode(
        widget.code,
        widget.language,
        codeStyle,
        theme,
      );
      _highlightedCode = widget.code;
      _highlightedLanguage = widget.language;
    }
    return _highlightSpan!;
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final TextTheme textTheme = widget.textTheme;
    final bool hasLanguage = (widget.language ?? "").isNotEmpty;
    final Brightness brightness = Theme.of(context).brightness;
    final CodeHighlightTheme theme = _highlightTheme(brightness);
    final Color copiedColor = _copiedColor(brightness);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 头部：语言徽标 + 复制按钮
            Container(
              padding: const EdgeInsets.only(left: 12, right: 4),
              height: 34,
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.75),
                border: Border(
                  bottom: BorderSide(
                    color: cs.outline.withValues(alpha: 0.14),
                  ),
                ),
              ),
              child: Row(
                children: <Widget>[
                  Icon(
                    Icons.code_rounded,
                    size: 13,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      hasLanguage ? widget.language! : "代码",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                            color: cs.onSurfaceVariant,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.3,
                          ) ??
                          const TextStyle(
                            fontSize: AppTypography.micro,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.3,
                          ),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: _copyCode,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      minimumSize: const Size(0, 28),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                    ),
                    icon: Icon(
                      _copied ? Icons.check_rounded : Icons.copy_rounded,
                      size: 13,
                      color: _copied ? copiedColor : cs.primary,
                    ),
                    label: Text(
                      _copied ? "已复制" : "复制",
                      style: textTheme.labelSmall?.copyWith(
                            color: _copied ? copiedColor : cs.primary,
                            fontWeight: FontWeight.w600,
                          ) ??
                          TextStyle(
                            fontSize: AppTypography.micro,
                            color: _copied ? copiedColor : cs.primary,
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                  ),
                ],
              ),
            ),
            // 代码体:语法高亮 + 横向滚动(长行不折行,保留代码缩进结构)
            Container(
              width: double.infinity,
              color: theme.background,
              padding: const EdgeInsets.all(12),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: SelectableText.rich(
                  _highlightSpanFor(
                    textTheme.bodySmall!.copyWith(
                      fontFamily: AppTypography.monoFontFamily,
                      height: AppTypography.compactLineHeight,
                    ),
                    theme,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BlockquoteWidget extends StatelessWidget {
  const _BlockquoteWidget({
    required this.text,
    required this.cs,
    required this.textTheme,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return AccentPanel(
      cs: cs,
      accentAlpha: 0.45,
      fillAlpha: 0.12,
      child: buildInlineMarkdownText(
        text,
        textTheme.bodyMedium!.copyWith(
          color: cs.onSurfaceVariant,
          height: AppTypography.bodyLineHeight,
        ),
        cs: cs,
      ),
    );
  }
}

class MarkdownTableWidget extends StatelessWidget {
  const MarkdownTableWidget({
    super.key,
    required this.lines,
    required this.cs,
    required this.textTheme,
  });

  final List<String> lines;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    final List<List<MarkdownTableCellData>> parsedRows = lines
        .map((String line) => parseMarkdownTableCells(line.trim())
            .map(parseMarkdownTableCell)
            .toList())
        .where((List<MarkdownTableCellData> cells) => cells.isNotEmpty)
        .toList();

    if (parsedRows.isEmpty) return const SizedBox.shrink();

    List<MarkdownTableCellData>? headerCells;
    List<List<MarkdownTableCellData>> bodyRows = parsedRows;

    if (parsedRows.length >= 2 && isMarkdownTableSeparator(lines[1].trim())) {
      headerCells = parsedRows.first;
      bodyRows = parsedRows.skip(2).toList();
    }

    final List<List<MarkdownTableCellData>> allRows =
        <List<MarkdownTableCellData>>[
      if (headerCells != null) headerCells,
      ...bodyRows,
    ];

    int columnCount = allRows.fold<int>(
      0,
      (int max, List<MarkdownTableCellData> row) {
        int count = 0;
        for (final MarkdownTableCellData cell in row) {
          if (!cell.skip) count += cell.colspan;
        }
        return count > max ? count : max;
      },
    );
    // Cap columnCount to prevent unbounded layout overflow from malformed markdown tables.
    columnCount = columnCount.clamp(0, 20);

    final List<List<bool>> occupied = List<List<bool>>.generate(
      allRows.length + 4,
      (_) => List<bool>.filled(columnCount + 4, false),
    );

    final List<Widget> tableRows = <Widget>[];

    for (int rowIndex = 0; rowIndex < allRows.length; rowIndex++) {
      final List<MarkdownTableCellData> row = allRows[rowIndex];
      final bool isHeader = headerCells != null && rowIndex == 0;
      // 扁平表格：单元格不再画四周全框（相邻单元格双线叠印发闷），
      // 只留横向分隔线；纵向靠列距与表头底色分区，外框由容器提供。
      final bool isLastRow = rowIndex == allRows.length - 1;
      final List<Widget> cells = <Widget>[];
      int colIndex = 0;

      for (final MarkdownTableCellData cell in row) {
        while (colIndex < columnCount && occupied[rowIndex][colIndex]) {
          colIndex++;
        }
        if (colIndex >= columnCount) break;

        if (cell.skip) {
          continue;
        }

        for (int r = 0; r < cell.rowspan; r++) {
          for (int c = 0; c < cell.colspan; c++) {
            occupied[rowIndex + r][colIndex + c] = true;
          }
        }

        // 表格正文在 bodySmall 基础上上调一档到 secondary（13），
        // 12 在桌面端密度下偏小，阅读费劲。
        final TextStyle cellStyle = textTheme.bodySmall!.copyWith(
          fontSize: AppTypography.secondary,
          color: cs.onSurface,
          height: AppTypography.compactLineHeight,
          fontWeight: isHeader ? FontWeight.w700 : FontWeight.w400,
        );

        cells.add(
          Expanded(
            flex: cell.colspan,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: isHeader
                    ? cs.primaryContainer.withValues(alpha: 0.28)
                    : null,
                border: isLastRow
                    ? null
                    : Border(
                        bottom: BorderSide(
                          color: isHeader
                              ? cs.primary.withValues(alpha: 0.35)
                              : cs.outline.withValues(alpha: 0.14),
                          width: isHeader ? 1.2 : 1,
                        ),
                      ),
              ),
              child: buildInlineMarkdownText(
                cell.text,
                isHeader ? cellStyle.copyWith(color: cs.primary) : cellStyle,
                cs: cs,
              ),
            ),
          ),
        );

        colIndex += cell.colspan;
      }

      tableRows.add(IntrinsicHeight(
          child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: cells)));
    }

    // 一律压回容器宽内平铺（2026-10-12）：此前 maxWidth=列数*140，天气等
    // 3-4 列数据表在手机端必然超宽 → 横向滑动才能看全。单元格文本自动
    // 换行后表格恒与容器等宽，所有数据一屏展示；横向滚动仅保留为极端
    // 场景（不可断行的长 token 溢出）的安全阀，正常内容不会触发。
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints box) {
        final double availableWidth =
            box.maxWidth.isFinite ? box.maxWidth : 280.0;
        return DecoratedBox(
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: cs.outline.withValues(alpha: 0.16)),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minWidth: math.min(280.0, availableWidth),
                  maxWidth: availableWidth,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: tableRows,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 块级图片：独占一行、限宽 560、16:9 裁切，点击走应用内预览面板
/// （此前点行内图片直接跳外部浏览器，与媒体卡的预览体验不一致）。
class _BlockImage extends StatelessWidget {
  const _BlockImage({required this.url, required this.cs});

  final String url;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: AspectRatio(
          aspectRatio: 16 / 9,
          child: GestureDetector(
            onTap: () => ImagePreviewLauncher.open(
              url: url,
              title: "图片预览",
              anchorContext: context,
            ),
            child: MediaThumbnail(url: url, cs: cs, borderRadius: 10),
          ),
        ),
      ),
    );
  }
}

/// markdown 图片内嵌组件：渲染网络图片缩略图（夹在文字行内的小图），
/// 点击打开应用内预览面板。
/// 由 [parseInlineMarkdownSpans] 中的 `![alt](url)` 语法触发。
class _InlineImage extends StatelessWidget {
  const _InlineImage({
    required this.url,
    required this.cs,
  });

  final String url;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: GestureDetector(
        onTap: () => ImagePreviewLauncher.open(
          url: url,
          title: "图片预览",
          anchorContext: context,
        ),
        child: MediaThumbnail(
          url: url,
          cs: cs,
          width: 220,
          height: 150,
          borderRadius: 8,
        ),
      ),
    );
  }
}
