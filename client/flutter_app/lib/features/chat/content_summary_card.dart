import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/theme/app_typography.dart";
import "../../core/utils/content_summary_parser.dart";
import "accent_panel.dart";
import "content_summary_detail_formatter.dart";

class ContentSummaryMessageBody extends StatelessWidget {
  const ContentSummaryMessageBody({
    super.key,
    required this.summary,
    required this.briefText,
    this.extraText = "",
    this.structuredItems = const <ContentSummaryItem>[],
    this.onCardTap,
  });

  final ContentSummaryDataV2 summary;
  final String briefText;
  final String extraText;
  final List<ContentSummaryItem> structuredItems;
  final VoidCallback? onCardTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextStyle bodyStyle = AppTypography.assistantBody(
      Theme.of(context).textTheme,
      cs,
    );

    // 冗余守卫：历史消息的 brief 可能就是卡片的「label：title」原文（旧版
    // 服务端会在卡前重复输出同一行文案），此时不再渲染，标题由卡片自身展示；
    // 新消息服务端已不再输出该行，brief 通常为空或为真实的前导说明。
    final String brief = briefText.trim();
    final String cardTitle = summary.title.trim();
    final bool briefDuplicatesCard =
        cardTitle.isNotEmpty && brief.contains(cardTitle);

    // 卡外速览移除（2026-10-28，向豆包折叠策略看齐）：briefPoints 与卡内
    // 文档预览同源提取，渲染出来必然是「卡外一遍、卡内再一遍」的复读。
    // 豆包的摘要卡没有这层——卡片本身就是文档（标题 + 导读 + 结构预览 +
    // 查看全文），气泡侧只留 briefText 前导说明与 extraText 尾注。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (brief.isNotEmpty && !briefDuplicatesCard) ...<Widget>[
          _BriefContentPreview(
            content: brief,
            style: bodyStyle,
          ),
          const SizedBox(height: AppTypography.space3),
        ],
        if (structuredItems.isNotEmpty) ...<Widget>[
          _StructuredItemsPanel(items: structuredItems),
          const SizedBox(height: AppTypography.space3),
        ],
        ContentSummaryDetailCard(
          summary: summary,
          onTap: onCardTap,
        ),
        if (extraText.trim().isNotEmpty &&
            extraText.trim() != briefText.trim()) ...<Widget>[
          const SizedBox(height: AppTypography.space2),
          buildInlineMarkdownText(extraText.trim(), bodyStyle, cs: cs),
        ],
      ],
    );
  }
}

/// 折叠卡：卡内正文的「文档缩略图」——标题栏 + 导语 + 前几个板块，
/// 底部渐隐表示后面还有内容，点击进右侧面板看全文。
class ContentSummaryDetailCard extends StatelessWidget {
  const ContentSummaryDetailCard({
    super.key,
    required this.summary,
    this.onTap,
  });

  final ContentSummaryDataV2 summary;
  final VoidCallback? onTap;

  static const double _previewHeight = 160;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String title =
        summary.title.trim().isEmpty ? summary.cardLabel : summary.title.trim();
    final List<_PreviewLine> lines = _previewLines(summary.detailContent ?? "");

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Ink(
          width: double.infinity,
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow.withValues(alpha: 0.65),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: cs.outline.withValues(alpha: 0.2)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
                child: Row(
                  children: <Widget>[
                    Container(
                      width: 22,
                      height: 22,
                      decoration: BoxDecoration(
                        color: cs.primary.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Icon(
                        _cardIconFor(summary.category),
                        size: 13,
                        color: cs.primary.withValues(alpha: 0.95),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14.5,
                          height: 1.2,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.2,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              _divider(cs),
              if (lines.isNotEmpty) ...<Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                  child: Container(
                    height: _previewHeight,
                    width: double.infinity,
                    decoration: BoxDecoration(
                      color: cs.surfaceContainerHighest.withValues(alpha: 0.3),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: cs.outline.withValues(alpha: 0.12),
                      ),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: ShaderMask(
                        blendMode: BlendMode.dstIn,
                        shaderCallback: (Rect bounds) => const LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: <Color>[
                            Colors.white,
                            Colors.white,
                            Colors.transparent,
                          ],
                          stops: <double>[0, 0.8, 1],
                        ).createShader(bounds),
                        child: SingleChildScrollView(
                          physics: const NeverScrollableScrollPhysics(),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(11, 9, 11, 0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                for (final _PreviewLine line in lines)
                                  _PreviewLineView(line: line, cs: cs),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                _divider(cs),
              ],
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 7, 10, 7),
                child: Row(
                  children: <Widget>[
                    Text(
                      "查看全文",
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: cs.onSurfaceVariant.withValues(alpha: 0.9),
                      ),
                    ),
                    const Spacer(),
                    Icon(
                      Icons.chevron_right,
                      size: 16,
                      color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static Widget _divider(ColorScheme cs) {
    return Container(
      height: 1,
      color: cs.outline.withValues(alpha: 0.16),
    );
  }
}

enum _PreviewKind { heading, bullet, paragraph }

class _PreviewLine {
  const _PreviewLine(this.kind, this.text);

  final _PreviewKind kind;
  final String text;
}

/// 正文拆成卡片预览行：板块标题 / 条目 / 普通段落，最多取 10 行
List<_PreviewLine> _previewLines(String content) {
  final List<_PreviewLine> out = <_PreviewLine>[];
  for (final String raw in content.split("\n")) {
    final String line = raw.trim();
    if (line.isEmpty || RegExp(r"^-{3,}$").hasMatch(line)) continue;
    final RegExpMatch? heading = RegExp(r"^#{1,4}\s+(.+)$").firstMatch(line);
    if (heading != null) {
      out.add(_PreviewLine(_PreviewKind.heading, heading.group(1)!.trim()));
    } else if (RegExp(r"^[-*•]\s+").hasMatch(line)) {
      out.add(
        _PreviewLine(
          _PreviewKind.bullet,
          line.replaceFirst(RegExp(r"^[-*•]\s+"), ""),
        ),
      );
    } else if (RegExp(r"^\d+[.、]\s*").hasMatch(line)) {
      out.add(
        _PreviewLine(
          _PreviewKind.bullet,
          line.replaceFirst(RegExp(r"^\d+[.、]\s*"), ""),
        ),
      );
    } else if (!line.startsWith("|") &&
        !line.startsWith(">") &&
        !line.startsWith("```")) {
      out.add(_PreviewLine(_PreviewKind.paragraph, line));
    }
    if (out.length >= 16) break;
  }
  return out;
}

class _PreviewLineView extends StatelessWidget {
  const _PreviewLineView({required this.line, required this.cs});

  final _PreviewLine line;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    switch (line.kind) {
      case _PreviewKind.heading:
        return Padding(
          padding: const EdgeInsets.only(top: 5, bottom: 4),
          child: Text(
            line.text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              height: 1.3,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.2,
              color: cs.onSurface,
            ),
          ),
        );
      case _PreviewKind.bullet:
        return Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: _bulletText(),
        );
      case _PreviewKind.paragraph:
        return Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Text(
            _stripInlineMarkers(line.text),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11.5,
              height: 1.45,
              color: cs.onSurfaceVariant.withValues(alpha: 0.9),
            ),
          ),
        );
    }
  }

  /// 条目：`**要点**：说明` 的要点加粗，其余弱化；单行截断以露出更多板块
  Widget _bulletText() {
    final String text = _stripLinks(line.text);
    final RegExpMatch? lead =
        RegExp(r"^\*\*(.+?)\*\*\s*[：:]\s*(.*)$").firstMatch(text);
    final TextStyle base = TextStyle(
      fontSize: 11.5,
      height: 1.45,
      color: cs.onSurface.withValues(alpha: 0.78),
    );
    if (lead == null) {
      return Text(
        _stripInlineMarkers(text),
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
        style: base,
      );
    }
    return Text.rich(
      TextSpan(
        children: <TextSpan>[
          TextSpan(
            text: "${lead.group(1)}：",
            style: base.copyWith(
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
            ),
          ),
          TextSpan(text: _stripInlineMarkers(lead.group(2) ?? "")),
        ],
      ),
      maxLines: 4,
      overflow: TextOverflow.ellipsis,
      style: base,
    );
  }

  static String _stripLinks(String text) =>
      text.replaceAllMapped(RegExp(r"\[(.+?)\]\((.+?)\)"), (m) => m.group(1)!);

  static String _stripInlineMarkers(String text) =>
      _stripLinks(text).replaceAll(RegExp(r"\*\*|__|`"), "");
}

IconData _cardIconFor(String category) {
  switch (category) {
    case "news":
      return Icons.newspaper_outlined;
    case "code":
      return Icons.code;
    case "data":
    case "table":
      return Icons.table_chart_outlined;
    case "list":
      return Icons.checklist;
    case "search_result":
      return Icons.travel_explore_outlined;
    default:
      return Icons.article_outlined;
  }
}

/// 简洁内容预览组件 - 智能格式化概括性文本
class _BriefContentPreview extends StatelessWidget {
  const _BriefContentPreview({
    required this.content,
    required this.style,
  });

  final String content;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<String> lines = content.split("\n");
    final bool hasBulletPoints =
        lines.any((line) => line.trim().startsWith("•"));

    if (!hasBulletPoints) {
      // 纯文本模式：直接显示，轻微底色突出摘要性质（与引用块同源面板组件）
      return AccentPanel(
        cs: cs,
        accentAlpha: 0.45,
        fillAlpha: 0.12,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: buildInlineMarkdownText(content, style, cs: cs),
      );
    }

    // 列表项模式：格式化显示每个要点
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: lines.map((String line) {
        final String trimmed = line.trim();
        if (trimmed.isEmpty) return const SizedBox(height: 4);

        if (trimmed.startsWith("•")) {
          final String itemText = trimmed.substring(1).trim();
          return Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: cs.primary.withValues(alpha: 0.7),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: buildInlineMarkdownText(
                    itemText,
                    style.copyWith(
                      height: AppTypography.bodyLineHeight,
                    ),
                    cs: cs,
                  ),
                ),
              ],
            ),
          );
        }

        return Padding(
          padding: const EdgeInsets.only(bottom: AppTypography.space1),
          child: buildInlineMarkdownText(
            trimmed,
            style.copyWith(
              color: cs.onSurfaceVariant,
              fontSize: style.fontSize != null ? style.fontSize! - 1 : 13,
            ),
            cs: cs,
          ),
        );
      }).toList(),
    );
  }
}

/// 内嵌结构化条目面板：用于把 `search_web` 等工具回显的 items 数组渲染为可点击的卡片列表。
/// 取代旧版「raw JSON 塞进 _BriefContentPreview」导致的乱码渲染。
class _StructuredItemsPanel extends StatelessWidget {
  const _StructuredItemsPanel({required this.items});

  final List<ContentSummaryItem> items;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 上限 6 条：避免长列表压塌对话气泡；超过 6 条时在面板底部追加「+N 更多」提示
    const int maxVisible = 6;
    final List<ContentSummaryItem> visible = items.take(maxVisible).toList();
    final int overflow = items.length - visible.length;

    return AccentPanel(
      cs: cs,
      accentAlpha: 0.45,
      fillAlpha: 0.18,
      radius: 10,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(left: 2, top: 2, bottom: 6),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.travel_explore_outlined,
                  size: 14,
                  color: cs.primary.withValues(alpha: 0.75),
                ),
                const SizedBox(width: 6),
                Text(
                  "检索结果（${items.length}）",
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.primary.withValues(alpha: 0.85),
                    height: 1.2,
                  ),
                ),
              ],
            ),
          ),
          ...visible.map(
            (ContentSummaryItem item) => Padding(
              padding: const EdgeInsets.only(bottom: AppTypography.space1),
              child: _StructuredItemRow(item: item),
            ),
          ),
          if (overflow > 0)
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text(
                "…还有 $overflow 条，详见详情卡",
                style: TextStyle(
                  fontSize: AppTypography.caption,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _StructuredItemRow extends StatelessWidget {
  const _StructuredItemRow({required this.item});

  final ContentSummaryItem item;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme textTheme = Theme.of(context).textTheme;
    final String? meta = _formatMeta();

    return InkWell(
      onTap: item.url == null ? null : () => _launch(item.url!),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Container(
              margin: const EdgeInsets.only(top: 6),
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                color: cs.primary.withValues(alpha: 0.55),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    item.title.isNotEmpty ? item.title : "(无标题)",
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.bodyMedium?.copyWith(
                      color: item.url != null ? cs.primary : cs.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if ((item.snippet ?? "").isNotEmpty) ...<Widget>[
                    const SizedBox(height: 2),
                    buildInlineMarkdownText(
                      item.snippet!,
                      textTheme.bodySmall!.copyWith(
                        color: cs.onSurfaceVariant,
                        height: AppTypography.bodyLineHeight,
                      ),
                      cs: cs,
                    ),
                  ],
                  if (meta != null) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                        color: cs.onSurfaceVariant,
                        fontSize: AppTypography.micro,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String? _formatMeta() {
    final List<String> parts = <String>[];
    if ((item.source ?? "").isNotEmpty) parts.add(item.source!);
    if ((item.publishedAt ?? "").isNotEmpty) parts.add(item.publishedAt!);
    if (parts.isEmpty) return null;
    return parts.join(" · ");
  }

  Future<void> _launch(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // 静默失败：避免打不开链接时阻塞聊天
    }
  }
}
