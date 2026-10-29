import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";
import "../../core/utils/content_summary_parser.dart";

/// 弹窗左侧竖向目录：可展开/收起，便于快速跳转到各板块并给正文让出宽度。
class ContentSummaryBookmarkRail extends StatefulWidget {
  const ContentSummaryBookmarkRail({
    super.key,
    required this.sections,
    required this.activeIndex,
    required this.onSectionTap,
    this.collapsed = false,
    this.onToggleCollapsed,
  });

  final List<ContentSummarySectionInfo> sections;
  final int activeIndex;
  final ValueChanged<int> onSectionTap;
  final bool collapsed;
  final VoidCallback? onToggleCollapsed;

  static const double expandedWidth = 156;
  static const double collapsedWidth = 44;

  @override
  State<ContentSummaryBookmarkRail> createState() =>
      _ContentSummaryBookmarkRailState();
}

class _ContentSummaryBookmarkRailState
    extends State<ContentSummaryBookmarkRail> {
  final ScrollController _scrollController = ScrollController();
  bool _canScrollUp = false;
  bool _canScrollDown = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_updateScrollHints);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateScrollHints());
  }

  @override
  void didUpdateWidget(ContentSummaryBookmarkRail oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateScrollHints());
  }

  @override
  void dispose() {
    _scrollController.removeListener(_updateScrollHints);
    _scrollController.dispose();
    super.dispose();
  }

  void _updateScrollHints() {
    if (!_scrollController.hasClients) return;
    final double maxExtent = _scrollController.position.maxScrollExtent;
    final double offset = _scrollController.offset;
    final bool canUp = offset > 2;
    final bool canDown = offset < maxExtent - 2;
    if (canUp != _canScrollUp || canDown != _canScrollDown) {
      setState(() {
        _canScrollUp = canUp;
        _canScrollDown = canDown;
      });
    }
  }

  void _scrollBy(double delta) {
    if (!_scrollController.hasClients) return;
    final double target = (_scrollController.offset + delta)
        .clamp(0.0, _scrollController.position.maxScrollExtent);
    _scrollController.animateTo(
      target,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool collapsed = widget.collapsed;

    return Container(
      width: collapsed
          ? ContentSummaryBookmarkRail.collapsedWidth
          : ContentSummaryBookmarkRail.expandedWidth,
      decoration: BoxDecoration(
        border: Border(
          right: BorderSide(color: cs.outline.withValues(alpha: 0.12)),
        ),
      ),
      child: collapsed
          ? _CollapsedRail(cs: cs, onExpand: widget.onToggleCollapsed)
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _RailHeader(cs: cs, onCollapse: widget.onToggleCollapsed),
                Expanded(
                  child: Stack(
                    children: <Widget>[
                      ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.fromLTRB(8, 2, 8, 16),
                        itemCount: widget.sections.length,
                        itemBuilder: (BuildContext context, int index) {
                          final ContentSummarySectionInfo section =
                              widget.sections[index];
                          return _BookmarkItem(
                            title: section.title,
                            active: index == widget.activeIndex,
                            cs: cs,
                            onTap: () => widget.onSectionTap(index),
                          );
                        },
                      ),
                      if (_canScrollUp)
                        Positioned(
                          top: 0,
                          left: 0,
                          right: 0,
                          child: _VerticalScrollHint(
                            cs: cs,
                            up: true,
                            onTap: () => _scrollBy(-100),
                          ),
                        ),
                      if (_canScrollDown)
                        Positioned(
                          bottom: 0,
                          left: 0,
                          right: 0,
                          child: _VerticalScrollHint(
                            cs: cs,
                            up: false,
                            onTap: () => _scrollBy(100),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

/// 展开态顶栏：左侧收起按钮（与目录条目起点对齐）。
class _RailHeader extends StatelessWidget {
  const _RailHeader({required this.cs, required this.onCollapse});

  final ColorScheme cs;
  final VoidCallback? onCollapse;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: Row(
        children: <Widget>[
          const SizedBox(width: 8),
          _RailIconButton(
            icon: Icons.keyboard_double_arrow_left,
            tooltip: "收起目录",
            cs: cs,
            onTap: onCollapse,
          ),
        ],
      ),
    );
  }
}

class _CollapsedRail extends StatelessWidget {
  const _CollapsedRail({required this.cs, required this.onExpand});

  final ColorScheme cs;
  final VoidCallback? onExpand;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        const SizedBox(height: 8),
        _RailIconButton(
          icon: Icons.keyboard_double_arrow_right,
          tooltip: "展开目录",
          cs: cs,
          onTap: onExpand,
        ),
      ],
    );
  }
}

class _RailIconButton extends StatelessWidget {
  const _RailIconButton({
    required this.icon,
    required this.tooltip,
    required this.cs,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final ColorScheme cs;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 500),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            width: 28,
            height: 28,
            child: Icon(
              icon,
              size: 18,
              color: cs.onSurfaceVariant.withValues(alpha: 0.75),
            ),
          ),
        ),
      ),
    );
  }
}

class _BookmarkItem extends StatelessWidget {
  const _BookmarkItem({
    required this.title,
    required this.active,
    required this.cs,
    required this.onTap,
  });

  final String title;
  final bool active;
  final ColorScheme cs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: active
            ? cs.onSurface.withValues(alpha: 0.05)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          hoverColor: cs.onSurface.withValues(alpha: 0.04),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                height: 1.3,
                color: active
                    ? AppPalette.readerLink
                    : cs.onSurfaceVariant.withValues(alpha: 0.85),
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _VerticalScrollHint extends StatelessWidget {
  const _VerticalScrollHint({
    required this.cs,
    required this.up,
    required this.onTap,
  });

  final ColorScheme cs;
  final bool up;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: up ? Alignment.topCenter : Alignment.bottomCenter,
              end: up ? Alignment.bottomCenter : Alignment.topCenter,
              colors: <Color>[
                cs.surfaceContainerHighest.withValues(alpha: 0.95),
                cs.surfaceContainerHighest.withValues(alpha: 0),
              ],
            ),
          ),
          child: Icon(
            up ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
            size: 16,
            color: cs.onSurfaceVariant.withValues(alpha: 0.7),
          ),
        ),
      ),
    );
  }
}
