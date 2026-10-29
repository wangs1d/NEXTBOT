import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";
import "../../core/theme/app_typography.dart";
import "../../core/utils/content_summary_parser.dart";
import "content_summary_detail_formatter.dart";
import "content_summary_section_nav.dart";

/// 内容详情正文视图：左侧板块书签栏 + 右侧滚动正文（markdown 分行渲染）
/// + 底部来源标签，滚动时自动同步高亮当前板块。
///
/// 从 ContentSummaryDetailModal 的内容区抽出共用：
/// 弹窗（窄屏/无面板宿主时）与右侧双面板（main.dart contentSummary 分支，
/// 标题由面板 chrome 顶栏展示）都渲染它，避免两份滚动同步/板块跳转逻辑各自漂移。
class ContentSummaryDetailView extends StatefulWidget {
  const ContentSummaryDetailView({super.key, required this.summary});

  final ContentSummaryDataV2 summary;

  @override
  State<ContentSummaryDetailView> createState() =>
      _ContentSummaryDetailViewScreenState();
}

class _ContentSummaryDetailViewScreenState
    extends State<ContentSummaryDetailView> {
  final ScrollController _scrollController = ScrollController();
  final Map<int, GlobalKey> _sectionKeys = <int, GlobalKey>{};
  int _activeSectionIndex = 0;
  bool _railCollapsed = false;

  @override
  void initState() {
    super.initState();
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections != null) {
      for (int i = 0; i < sections.length; i++) {
        _sectionKeys[i] = GlobalKey();
      }
    }
    _scrollController.addListener(_syncActiveSectionFromScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_syncActiveSectionFromScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _syncActiveSectionFromScroll() {
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections == null || sections.isEmpty) return;

    int? nearestIndex;
    double nearestDistance = double.infinity;

    for (int i = 0; i < sections.length; i++) {
      final GlobalKey? key = _sectionKeys[i];
      final BuildContext? ctx = key?.currentContext;
      if (ctx == null) continue;
      final RenderObject? renderObject = ctx.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.hasSize) continue;

      final Offset position = renderObject.localToGlobal(Offset.zero);
      final double distance = (position.dy - 160).abs();
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    if (nearestIndex != null && nearestIndex != _activeSectionIndex) {
      setState(() => _activeSectionIndex = nearestIndex!);
    }
  }

  void _scrollToSection(int index) {
    setState(() => _activeSectionIndex = index);
    final GlobalKey? key = _sectionKeys[index];
    final BuildContext? ctx = key?.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 280),
        curve: Curves.easeOutCubic,
        alignment: 0.08,
      );
      return;
    }

    _scrollToSectionFallback(index);
  }

  void _scrollToSectionFallback(int index) {
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections == null || sections.isEmpty) return;

    final String targetTitle = sections[index].title.trim();
    final String content = widget.summary.detailContent?.trim() ?? "";
    if (content.isEmpty) return;

    final RegExp sectionHeader = RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]");
    final RegExp markdownHeader = RegExp(r"^#{1,6}\s+");
    final List<String> lines = content.split("\n");

    double offset = 0;
    const double lineHeight = 28;
    bool found = false;

    for (final String line in lines) {
      final String trimmed = line.trim();
      if (trimmed.isEmpty) {
        offset += 6;
        continue;
      }

      final bool isHeader =
          sectionHeader.hasMatch(trimmed) || markdownHeader.hasMatch(trimmed);
      if (isHeader) {
        final String title = markdownHeader.hasMatch(trimmed)
            ? trimmed.replaceFirst(markdownHeader, "").trim()
            : trimmed;
        if (title.contains(targetTitle) || targetTitle.contains(title)) {
          found = true;
          break;
        }
      }
      offset += lineHeight;
    }

    if (!found || !_scrollController.hasClients) return;
    _scrollController.animateTo(
      offset.clamp(0.0, _scrollController.position.maxScrollExtent),
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final ContentSummaryDataV2 summary = widget.summary;
    final List<ContentSummarySectionInfo>? sections = summary.sections;
    final bool showBookmarks = sections != null && sections.length > 1;

    final String rawContent = summary.detailContent?.trim() ?? "";
    // 消毒：剥离裸露的 [RENDER_HINT]/[RENDER_AS] 标记行 + 删除与标题重复的首行导语
    final String cleaned = rawContent.isEmpty
        ? ""
        : ContentSummaryParser.sanitizeDetailContent(rawContent, summary.title);
    final String content = cleaned.trim().isNotEmpty ? cleaned : "暂无详细内容";

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (showBookmarks)
          ContentSummaryBookmarkRail(
            sections: sections,
            activeIndex: _activeSectionIndex,
            onSectionTap: _scrollToSection,
            collapsed: _railCollapsed,
            onToggleCollapsed: () =>
                setState(() => _railCollapsed = !_railCollapsed),
          ),
        Expanded(
          child: Scrollbar(
            controller: _scrollController,
            thumbVisibility: true,
            child: SingleChildScrollView(
              controller: _scrollController,
              padding: const EdgeInsets.fromLTRB(
                AppTypography.space5,
                AppTypography.space4,
                AppTypography.space5,
                AppTypography.space5 + AppTypography.space4,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _DocumentHeader(
                    summary: summary,
                    cs: cs,
                    textTheme: Theme.of(context).textTheme,
                  ),
                  ...formatContentSummaryDetailLines(
                    content,
                    cs,
                    Theme.of(context).textTheme,
                    sectionKeys: _sectionKeys,
                    sectionTitles: sections
                        ?.map((ContentSummarySectionInfo s) => s.title)
                        .toList(),
                    linkColor: AppPalette.readerLink,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 阅读态文档头：大标题（主体｜日期）+ 作者/修改时间元信息行。
class _DocumentHeader extends StatelessWidget {
  const _DocumentHeader({
    required this.summary,
    required this.cs,
    required this.textTheme,
  });

  final ContentSummaryDataV2 summary;
  final ColorScheme cs;
  final TextTheme textTheme;

  String get _title {
    final String subject = ContentSummaryParser.taskSubject(summary);
    final DateTime? created = summary.createdAt?.toLocal();
    if (created == null) return subject;
    return "$subject｜${created.year}年${created.month}月${created.day}日";
  }

  String get _modifiedLabel {
    final DateTime? created = summary.createdAt?.toLocal();
    if (created == null) return "";
    final DateTime now = DateTime.now();
    final int dayDiff = DateTime(now.year, now.month, now.day)
        .difference(DateTime(created.year, created.month, created.day))
        .inDays;
    if (dayDiff <= 0) return "今天修改";
    if (dayDiff == 1) return "昨天修改";
    if (created.year == now.year) return "${created.month}月${created.day}日修改";
    return "${created.year}年${created.month}月${created.day}日修改";
  }

  String get _author {
    final Object? source = summary.metadata?["source"];
    if (source == null || source.toString().trim().isEmpty) return "";
    return "来源：${source.toString().trim()}";
  }

  @override
  Widget build(BuildContext context) {
    final String subject = ContentSummaryParser.taskSubject(summary);
    final String avatarChar =
        subject.isEmpty ? "·" : String.fromCharCode(subject.runes.first);
    final String meta = <String>[
      if (_author.isNotEmpty) _author,
      if (_modifiedLabel.isNotEmpty) _modifiedLabel,
    ].join(" · ");

    return Padding(
      padding: const EdgeInsets.only(bottom: AppTypography.space5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            _title,
            style: textTheme.titleLarge?.copyWith(
              fontSize: AppTypography.docTitle,
              fontWeight: FontWeight.w800,
              height: AppTypography.headingLineHeight,
              letterSpacing: -0.2,
              color: cs.onSurface,
            ),
          ),
          if (meta.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppTypography.space3),
            Row(
              children: <Widget>[
                Container(
                  width: 24,
                  height: 24,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: cs.surfaceContainerHighest.withValues(alpha: 0.8),
                    shape: BoxShape.circle,
                  ),
                  child: Text(
                    avatarChar,
                    style: TextStyle(
                      fontSize: AppTypography.micro,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: AppTypography.space2),
                Container(
                  width: 1,
                  height: 12,
                  color: cs.outline.withValues(alpha: 0.4),
                ),
                const SizedBox(width: AppTypography.space2),
                Flexible(
                  child: Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: AppTypography.secondary,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
