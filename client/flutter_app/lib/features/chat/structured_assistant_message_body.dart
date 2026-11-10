import "package:flutter/material.dart";

import "../../core/theme/app_typography.dart";
import "../../core/utils/content_summary_parser.dart";
import "accent_panel.dart";
import "content_summary_detail_formatter.dart";

class StructuredAssistantMessageBody extends StatelessWidget {
  const StructuredAssistantMessageBody({
    super.key,
    required this.text,
    required this.cs,
    required this.textTheme,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    // 渲染层兜底（2026-10-10 搜图轮 CONTENT_SUMMARY 裸 JSON 泄漏）：本组件是
    // 多条路由共用的正文渲染器，收到的文本若混入摘要块（mediaCards 分支 /
    // RENDER_AS:structured / 历史落库消息），块没有折叠卡消费者，会整段以裸
    // JSON 渲染。这里统一剥掉——块要么被专属路由消费，要么在此消失，绝不透出。
    // 展示形态声明兜底：本组件是多条路由共用的正文渲染器，媒体卡片分支与
    // 历史落库消息可能带着 [RENDER_AS:xxx]/[RENDER_HINT:xxx] 进来，一律剥除。
    final String normalized =
        _stripRenderMarkers(ContentSummaryParser.stripSummaryBlocks(text))
            .replaceAll("\r\n", "\n")
            .trimRight();
    if (normalized.isEmpty) {
      return const SizedBox.shrink();
    }

    final _StructuredMessageParts parts = _splitStructuredMessage(normalized);
    final TextStyle bodyStyle = AppTypography.assistantBody(textTheme, cs);

    if (!parts.structured) {
      return buildInlineMarkdownText(
        normalized,
        bodyStyle,
        cs: cs,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (parts.lead.isNotEmpty)
          AccentPanel(
            cs: cs,
            accentColor: cs.outline,
            accentAlpha: 0.5,
            fillAlpha: 0.08,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            child: buildInlineMarkdownText(
              parts.lead,
              bodyStyle.copyWith(
                fontWeight: FontWeight.w500,
                color: cs.onSurfaceVariant,
              ),
              cs: cs,
            ),
          ),
        if (parts.lead.isNotEmpty && parts.body.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppTypography.space2),
            child: buildContentDivider(cs),
          ),
        if (parts.body.isNotEmpty)
          ...formatContentSummaryDetailLines(
            parts.body,
            cs,
            textTheme,
            // 聊天正文的表格带「表格」卡头（标题 + 一键复制），数据交付
            // 是一张明确的卡，不是散在正文里的线条（2026-11-06）。
            tableCardHeader: true,
          ),
      ],
    );
  }
}

class _StructuredMessageParts {
  const _StructuredMessageParts({
    required this.lead,
    required this.body,
    required this.structured,
  });

  final String lead;
  final String body;
  final bool structured;
}

_StructuredMessageParts _splitStructuredMessage(String text) {
  final List<String> lines = text.split("\n");
  final List<String> nonEmpty =
      lines.where((String line) => line.trim().isNotEmpty).toList();
  if (nonEmpty.length < 2) {
    return _StructuredMessageParts(lead: "", body: text, structured: false);
  }

  final int sectionCount =
      nonEmpty.where((String line) => _isSectionLikeLine(line)).length;
  final int listCount =
      nonEmpty.where((String line) => _isListLikeLine(line)).length;
  final int blankLines =
      lines.where((String line) => line.trim().isEmpty).length;
  final bool hasFenceBlock = nonEmpty.any(
    (String line) =>
        line.trimLeft().startsWith("```") || line.trimLeft().startsWith(">"),
  );
  final bool hasTable = nonEmpty.any(isMarkdownTableRow);
  final bool hasSections = sectionCount > 0;
  final bool hasList = listCount > 0;
  final bool likelyStructured = sectionCount >= 2 ||
      listCount >= 3 ||
      (hasSections && hasList) ||
      hasFenceBlock ||
      hasTable ||
      (blankLines >= 2 &&
          text.length >= 220 &&
          (sectionCount >= 1 || listCount >= 2));
  if (!likelyStructured) {
    return _StructuredMessageParts(lead: "", body: text, structured: false);
  }

  final int firstBlank = lines.indexWhere((String line) => line.trim().isEmpty);
  if (firstBlank <= 0) {
    return _StructuredMessageParts(lead: "", body: text, structured: true);
  }

  final String lead = lines.take(firstBlank).join("\n").trim();
  final String body = lines.skip(firstBlank + 1).join("\n").trim();
  // lead 首行是 markdown 标题（### / 一、）时不算口语开场白：标题该留在正文
  // 走块级渲染（### 前缀剥除、层级样式），进了 lead 面板就会以内联排版把
  // 「### 方案 A」的井号原样漏出来（2026-10-08 手机端 markdown 裸露回归）。
  final String leadFirstLine = lead.split("\n").first.trim();
  final bool leadIsHeading =
      RegExp(r"^(#{1,6})\s+").hasMatch(leadFirstLine) ||
      RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]").hasMatch(leadFirstLine);
  final bool keepLead = lead.isNotEmpty &&
      !leadIsHeading &&
      lead.length <= 120 &&
      body.length >= 60 &&
      (sectionCount >= 2 ||
          listCount >= 3 ||
          (hasSections && hasList) ||
          blankLines >= 2);

  return _StructuredMessageParts(
    lead: keepLead ? lead : "",
    body: keepLead ? body : text,
    structured: true,
  );
}

/// 剥离展示形态声明（[RENDER_AS:xxx] / [RENDER_HINT:xxx]）：整行独占时删行，
/// 行内嵌时就地删除并保留其余文本。
String _stripRenderMarkers(String input) {
  if (!input.contains("[RENDER_")) return input;
  final RegExp token = RegExp(r"\[RENDER_(?:HINT|AS):\w+\]");
  final List<String> out = <String>[];
  for (final String line in input.split("\n")) {
    final String stripped = line.replaceAll(token, "");
    if (stripped.trim().isEmpty && line.trim().isNotEmpty) continue;
    out.add(stripped);
  }
  return out.join("\n");
}

bool _isListLikeLine(String line) {
  final String trimmed = line.trim();
  return RegExp(r"^[-•*→▸‣⁃◦·]\s+").hasMatch(trimmed) ||
      RegExp(r"^\d+[.)]\s+").hasMatch(trimmed);
}

bool _isSectionLikeLine(String line) {
  final String trimmed = line.trim();
  if (trimmed.isEmpty) return false;
  if (RegExp(r"^(#{1,6})\s+").hasMatch(trimmed)) return true;
  if (RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]").hasMatch(trimmed)) return true;
  if (trimmed.length > 42) return false;
  if (!(trimmed.contains("：") || trimmed.contains(":"))) return false;
  if (trimmed.contains("。")) return false;
  if (_isListLikeLine(trimmed)) return false;
  return true;
}
