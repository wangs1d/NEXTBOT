import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";
import "content_summary_detail_view.dart";

/// 豆包风格：点击详情卡后以独立弹窗展示完整内容。
/// 宽屏下详情卡默认在右侧双面板展开（main.dart contentSummary 分支），
/// 弹窗保留给窄窗口/无面板宿主的场景，
/// 标题统一由 [ContentSummaryDetailView] 的文档头展示。
class ContentSummaryDetailModal {
  ContentSummaryDetailModal._();

  static Future<void> show(
    BuildContext context,
    ContentSummaryDataV2 summary,
  ) {
    return showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: "关闭详情",
      barrierColor: Colors.black.withValues(alpha: 0.52),
      transitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (
        BuildContext context,
        Animation<double> animation,
        Animation<double> secondaryAnimation,
      ) {
        return _ContentSummaryDetailModalBody(summary: summary);
      },
      transitionBuilder: (
        BuildContext context,
        Animation<double> animation,
        Animation<double> secondaryAnimation,
        Widget child,
      ) {
        final Size size = MediaQuery.sizeOf(context);
        final bool wide = size.width >= 720;
        final Offset begin =
            wide ? const Offset(-0.08, 0) : const Offset(0, 0.06);
        final CurvedAnimation curved = CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
          reverseCurve: Curves.easeInCubic,
        );
        return FadeTransition(
          opacity: curved,
          child: SlideTransition(
            position:
                Tween<Offset>(begin: begin, end: Offset.zero).animate(curved),
            child: child,
          ),
        );
      },
    );
  }
}

class _ContentSummaryDetailModalBody extends StatefulWidget {
  const _ContentSummaryDetailModalBody({required this.summary});

  final ContentSummaryDataV2 summary;

  @override
  State<_ContentSummaryDetailModalBody> createState() =>
      _ContentSummaryDetailModalBodyState();
}

class _ContentSummaryDetailModalBodyState
    extends State<_ContentSummaryDetailModalBody> {
  Offset _dragOffset = Offset.zero;

  void _close() => Navigator.of(context).pop();

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Size size = MediaQuery.sizeOf(context);
    final bool wide = size.width >= 720;
    final ContentSummaryDataV2 summary = widget.summary;
    final List<ContentSummarySectionInfo>? sections = summary.sections;
    final bool showBookmarks = sections != null && sections.length > 1;

    final double panelWidth = wide
        ? (size.width * (showBookmarks ? 0.62 : 0.52)).clamp(520.0, 860.0)
        : size.width * 0.94;
    final double panelHeight = wide ? size.height * 0.92 : size.height * 0.88;

    final Widget panel = Material(
      color: cs.surfaceContainerLow,
      elevation: wide ? 24 : 16,
      shadowColor: Colors.black.withValues(alpha: 0.45),
      borderRadius: BorderRadius.circular(wide ? 16 : 18),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: panelWidth,
        height: panelHeight,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(cs),
            Expanded(child: ContentSummaryDetailView(summary: summary)),
          ],
        ),
      ),
    );

    final Offset basePosition =
        wide ? Offset(20 + _dragOffset.dx, _dragOffset.dy) : _dragOffset;

    return SafeArea(
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            child: GestureDetector(
              onTap: _close,
              behavior: HitTestBehavior.opaque,
              child: const SizedBox.expand(),
            ),
          ),
          if (wide)
            Align(
              alignment: Alignment.centerLeft,
              child: Transform.translate(
                offset: basePosition,
                child: panel,
              ),
            )
          else
            Center(
              child: Transform.translate(
                offset: basePosition,
                child: panel,
              ),
            ),
        ],
      ),
    );
  }

  /// 顶栏只保留拖拽柄与关闭：标题由正文文档头承担，避免同一标题重复出现。
  Widget _buildHeader(ColorScheme cs) {
    return GestureDetector(
      onPanUpdate: (DragUpdateDetails details) {
        setState(() => _dragOffset += details.delta);
      },
      child: Container(
        height: 36,
        padding: const EdgeInsets.fromLTRB(12, 0, 8, 0),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(color: cs.outline.withValues(alpha: 0.12)),
          ),
        ),
        child: Row(
          children: <Widget>[
            MouseRegion(
              cursor: SystemMouseCursors.grab,
              child: Icon(
                Icons.drag_indicator,
                size: 20,
                color: cs.onSurfaceVariant.withValues(alpha: 0.7),
              ),
            ),
            const Spacer(),
            IconButton(
              onPressed: _close,
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.close, size: 20, color: cs.onSurfaceVariant),
              tooltip: "关闭",
            ),
          ],
        ),
      ),
    );
  }
}
