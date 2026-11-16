import "../../core/ui/card_metrics.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../../core/utils/agent_result_parser.dart";
import "agent_result_card.dart";
import "content_summary_detail_formatter.dart";

/// "选择型"卡片 —— 在 [AgentResultCard] 的基础上,在底部追加一排抉择按钮,
/// 让用户无需打字即可完成"周末去不去"、"确认/取消"、"订阅/忽略"这类高频选择。
///
/// 与 [AgentResultCard] 的边界:
///   - 用途:**用户决策入口**;不是汇报卡片
///   - 数据:沿用 `AgentResultData`,但 `actions` 必须非空(否则不应走本组件)
///   - 行为:点击后按钮进入禁用/已选态,触发 [onAction] 回调(由外层决定如何发送)
///
/// 视觉规范(与聊天消息流保持低对比,不喧宾夺主):
///   - 主按钮:实心 `primary` 背景 + `onPrimary` 文字
///   - 次按钮:`surface` 背景 + `outline` 描边 + `onSurface` 文字
///   - 按钮宽度:2 个等分,3+ 个按内容自适应(max 4 个),超过 4 个走纵向堆叠
class AgentActionChoiceCard extends StatefulWidget {
  const AgentActionChoiceCard({
    super.key,
    required this.data,
    this.onAction,
  });

  final AgentResultData data;

  /// 按钮点击回调。外层负责把 action 转成 user message 发到后端。
  final void Function(AgentResultAction action)? onAction;

  @override
  State<AgentActionChoiceCard> createState() => _AgentActionChoiceCardState();
}

class _AgentActionChoiceCardState extends State<AgentActionChoiceCard>
    with SingleTickerProviderStateMixin {
  /// 已点击的 action id(空字符串 = 未选)。
  /// 点击后立即锁定,避免网络往返期间用户重复点击同一按钮。
  String _selectedId = "";

  /// 多选模式(actions 带 multiSelect)：已勾选的 action id 集合。
  /// 勾选多个后,「确认选择」一次性提交全部。
  final Set<String> _selectedIds = <String>{};

  /// 是否处于多选模式(由任一 action 的 payload.multiSelect 决定)。
  bool get _isMultiSelect =>
      widget.data.actions.any((AgentResultAction a) =>
          (a.payload["multiSelect"] as bool?) == true);

  /// 按下时的缩放动画控制器(0.0 = 正常, 1.0 = 按下缩小态)
  late final AnimationController _pressController;
  late final Animation<double> _pressAnim;

  @override
  void initState() {
    super.initState();
    _pressController = AnimationController(
      duration: const Duration(milliseconds: 110),
      reverseDuration: const Duration(milliseconds: 150),
      vsync: this,
    );
    _pressAnim = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _pressController, curve: Curves.easeOut),
    );
  }

  @override
  void dispose() {
    _pressController.dispose();
    super.dispose();
  }

  void _handleTap(AgentResultAction action) {
    if (_isMultiSelect) {
      // 多选模式：勾选/取消勾选项；「确认选择」一次性提交全部已选项
      if (action.id == "select_confirm") {
        if (_selectedIds.isEmpty) return;
        HapticFeedback.mediumImpact();
        setState(() => _selectedId = action.id);
        widget.onAction?.call(_mergedSelectionAction(action));
        return;
      }
      if (action.id == "select_cancel") {
        HapticFeedback.selectionClick();
        setState(() {
          _selectedId = action.id;
          _selectedIds.clear();
        });
        widget.onAction?.call(action);
        return;
      }
      // 普通勾选项：切换选中态（确认前可反复改）
      HapticFeedback.selectionClick();
      setState(() {
        if (_selectedIds.contains(action.id)) {
          _selectedIds.remove(action.id);
        } else {
          _selectedIds.add(action.id);
        }
      });
      return;
    }
    if (_selectedId.isNotEmpty) return; // 已锁定
    // 触觉反馈：中等力度的冲击感，比 selectionClick 更"实在"
    HapticFeedback.mediumImpact();
    setState(() => _selectedId = action.id);
    widget.onAction?.call(action);
  }

  /// 多选模式下勾选/取消勾选某个列表项（index 为 items 下标）。
  void _toggleItemSelection(int index) {
    HapticFeedback.selectionClick();
    setState(() {
      final String id = "$index";
      if (_selectedIds.contains(id)) {
        _selectedIds.remove(id);
      } else {
        _selectedIds.add(id);
      }
    });
  }

  /// 多选确认时，把已勾选项的 label 合并进单个 action 的 payload，
  /// 供后端一次性拿到用户勾选的多个选项。
  AgentResultAction _mergedSelectionAction(AgentResultAction confirmAction) {
    final List<String> chosen = <String>[
      for (final int i in _selectedIds.map(int.parse))
        if (i >= 0 && i < widget.data.items.length)
          widget.data.items[i].text,
    ];
    return AgentResultAction(
      id: confirmAction.id,
      label: '已选择：${chosen.join("、")}',
      variant: confirmAction.variant,
      payload: <String, dynamic>{
        ...confirmAction.payload,
        "selected": chosen,
        "selectedIds": _selectedIds.toList(growable: false),
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<AgentResultAction> actions = widget.data.actions;
    if (actions.isEmpty) {
      // 防御:上游错误地把空 actions 路由到这里时,降级为纯文本卡。
      return AgentResultCard(data: widget.data);
    }

    // 视觉密度:与 AgentResultCard 保持一致
    const EdgeInsets padding = EdgeInsets.fromLTRB(14, 12, 14, 12);
    const double radius = 12;
    const double titleSize = 14;
    const double itemSize = 13;
    const double footerSize = 12.5;
    const double titleGap = 8;
    const double listItemGap = 3;
    const double buttonGap = 8;
    final Color titleColor = cs.onSurface;
    final Color itemColor = cs.onSurface.withValues(alpha: 0.82);
    final Color footerColor = cs.onSurfaceVariant;
    final Color dividerColor = cs.outline.withValues(alpha: 0.28);

    final bool hasHeader = widget.data.title.isNotEmpty ||
        widget.data.items.isNotEmpty ||
        widget.data.footer.isNotEmpty;

    return SizedBox(
      width: double.infinity,
      child: Container(
        // 与 AgentResultCard 一致:最大 360,避免宽屏拉成横幅
        constraints: BoxConstraints(maxWidth: CardMetrics.maxWidth(context)),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(color: dividerColor),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (hasHeader)
              Padding(
                padding: padding,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (widget.data.title.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: titleGap),
                        child: Text(
                          widget.data.title,
                          style: TextStyle(
                            fontSize: titleSize,
                            fontWeight: FontWeight.w600,
                            color: titleColor,
                            height: 1.45,
                          ),
                          softWrap: true,
                        ),
                      ),
                    ...widget.data.items.asMap().entries.map(
                        (MapEntry<int, AgentResultItem> e) {
                      final int index = e.key;
                      final AgentResultItem it = e.value;
                      final bool multi = _isMultiSelect;
                      final bool checked = multi && _selectedIds.contains("$index");
                      final Widget row = Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          if (multi)
                            Padding(
                              padding: const EdgeInsets.only(top: 1),
                              child: Icon(
                                checked
                                    ? Icons.check_circle
                                    : Icons.radio_button_unchecked,
                                size: 18,
                                color: checked
                                    ? cs.primary
                                    : cs.outline,
                              ),
                            )
                          else
                            _ItemMark(type: it.type, colorScheme: cs),
                          const SizedBox(width: 8),
                          Expanded(
                            child: _InlineMarkdownBody(
                              it.text,
                              style: TextStyle(
                                fontSize: itemSize,
                                color: itemColor,
                                height: 1.55,
                              ),
                              colorScheme: cs,
                            ),
                          ),
                        ],
                      );
                      return Padding(
                        padding:
                            const EdgeInsets.symmetric(vertical: listItemGap),
                        child: multi
                            ? InkWell(
                                onTap: () => _toggleItemSelection(index),
                                borderRadius: BorderRadius.circular(6),
                                child: row,
                              )
                            : row,
                      );
                    }),
                    if (widget.data.footer.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: titleGap),
                        child: Text(
                          widget.data.footer,
                          style: TextStyle(
                            fontSize: footerSize,
                            color: footerColor,
                            height: 1.5,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            // 按钮区:与正文用顶部边框分割,形成"操作区"视觉
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              decoration: BoxDecoration(
                border: hasHeader
                    ? Border(top: BorderSide(color: dividerColor, width: 1))
                    : null,
              ),
              child: _buildActionRow(context, actions, buttonGap),
            ),
          ],
        ),
      ),
    );
  }

  /// 按钮布局策略:
  ///   - 1 个:占满宽度
  ///   - 2 个:等分(主左次右,与截图一致)
  ///   - 3~4 个:等分一行
  ///   - 5+ 个:降级为纵向堆叠(等宽),避免挤压
  Widget _buildActionRow(
    BuildContext context,
    List<AgentResultAction> actions,
    double gap,
  ) {
    if (actions.length == 1) {
      return _buildButton(context, actions.first, expanded: true);
    }
    if (actions.length <= 4) {
      return Row(
        children: <Widget>[
          for (int i = 0; i < actions.length; i++) ...<Widget>[
            if (i > 0) SizedBox(width: gap),
            Expanded(child: _buildButton(context, actions[i])),
          ],
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (int i = 0; i < actions.length; i++) ...<Widget>[
          if (i > 0) SizedBox(height: gap),
          _buildButton(context, actions[i], expanded: true),
        ],
      ],
    );
  }

  /// 单个按钮:用 Material + InkWell 实现,获得完整的 ripple + highlight 效果。
  /// 配合 AnimatedScale 做按下缩放,以及 HapticFeedback 触觉反馈。
  Widget _buildButton(
    BuildContext context,
    AgentResultAction action, {
    bool expanded = false,
  }) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isPrimary =
        action.variant != "secondary" && action.variant != "ghost";
    final bool isDisabled = _selectedId.isNotEmpty;
    final bool isSelected = _selectedId == action.id;

    // 颜色策略:
    //   - primary + 未选:`primary` 实心 + `onPrimary` 文字(主按钮)
    //   - secondary + 未选:`surface` 背景 + `outline` 描边 + `onSurface` 文字(次按钮)
    //   - 已选:`primary.withValues(alpha: 0.12)` 背景 + 描边 + 主色文字(可读且区分)
    //   - 禁用但非已选:降低饱和度,文字置灰
    final Color bg;
    final Color fg;
    final Color border;
    final Color splashColor;
    final Color highlightColor;
    if (isSelected) {
      bg = cs.primary.withValues(alpha: 0.14);
      fg = cs.primary;
      border = cs.primary.withValues(alpha: 0.5);
      splashColor = cs.primary.withValues(alpha: 0.12);
      highlightColor = cs.primary.withValues(alpha: 0.08);
    } else if (isPrimary) {
      bg = cs.primary;
      fg = cs.onPrimary;
      border = cs.primary;
      // 主按钮:用 onPrimary 的 ripple(在深色背景上可见)
      splashColor = cs.onPrimary.withValues(alpha: 0.22);
      highlightColor = cs.onPrimary.withValues(alpha: 0.14);
    } else {
      bg = cs.surface;
      fg = isDisabled
          ? cs.onSurface.withValues(alpha: 0.4)
          : cs.onSurface.withValues(alpha: 0.85);
      border = cs.outline.withValues(alpha: isDisabled ? 0.2 : 0.45);
      splashColor = cs.primary.withValues(alpha: 0.16);
      highlightColor = cs.primary.withValues(alpha: 0.08);
    }

    // 按下时缩放 0.94(明显可感知)+ 背景色加深 8%(模拟物理按压凹陷感)
    // 同时做双重触觉:onTapDown 轻触 + onTap 中等冲击(释放确认)
    final Widget buttonContent = AnimatedBuilder(
      animation: _pressAnim,
      builder: (BuildContext context, Widget? child) {
        final double scale = 1.0 - _pressAnim.value * 0.06;
        // 按下时背景色混入少量黑色,形成"凹陷"视觉
        final Color pressedBg =
            Color.lerp(bg, Colors.black, _pressAnim.value * 0.09) ?? bg;
        return Transform.scale(
          scale: scale,
          child: Material(
            color: pressedBg,
            borderRadius: BorderRadius.circular(8),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: isDisabled ? null : () => _handleTap(action),
              onTapDown: isDisabled
                  ? null
                  : (_) {
                      _pressController.forward();
                      // 按下瞬间:轻触反馈
                      HapticFeedback.lightImpact();
                    },
              onTapUp: isDisabled
                  ? null
                  : (_) {
                      _pressController.reverse();
                    },
              onTapCancel: () => _pressController.reverse(),
              borderRadius: BorderRadius.circular(8),
              splashColor: splashColor,
              highlightColor: highlightColor,
              child: Container(
                constraints: const BoxConstraints(minHeight: 38),
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: border, width: 1),
                ),
                child: Text(
                  action.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: fg,
                    height: 1.2,
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );

    return SizedBox(
      width: expanded ? double.infinity : null,
      child: buttonContent,
    );
  }
}

/// 列表项前缀符号（✓ / • / !）。与 AgentResultCard 内部实现一致,
/// 这里重复一份避免跨文件耦合(后续若统一可提取到共享文件)。
class _ItemMark extends StatelessWidget {
  const _ItemMark({required this.type, required this.colorScheme});

  final String type;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final String glyph;
    final Color color;
    final double size;
    switch (type) {
      case "warn":
        glyph = "!";
        color = const Color(0xFFFBBF24);
        size = 13;
        break;
      case "num":
        glyph = "•";
        color = colorScheme.primary;
        size = 16;
        break;
      case "check":
      default:
        glyph = "✓";
        color = const Color(0xFF34D399);
        size = 13;
        break;
    }
    return Container(
      width: 16,
      alignment: Alignment.center,
      child: Text(
        glyph,
        style: TextStyle(
          color: color,
          fontSize: size,
          fontWeight: FontWeight.w700,
          height: 1.4,
        ),
      ),
    );
  }
}

class _InlineMarkdownBody extends StatelessWidget {
  const _InlineMarkdownBody(
    this.text, {
    required this.style,
    required this.colorScheme,
  });

  final String text;
  final TextStyle style;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    return buildInlineMarkdownText(text, style, cs: colorScheme);
  }
}
