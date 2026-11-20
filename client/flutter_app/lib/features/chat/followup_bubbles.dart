import "package:flutter/material.dart";

import "../../core/theme/app_typography.dart";

/// 接续建议（NEXT_UP）：模型给出的下一步任务句，逐条渲染成独立气泡。
///
/// 挂在对应 agent 消息正下方、左对齐（助手侧形态，圆角左上收口），一行一条；
/// 点击即把该句作为新消息发送（由调用方接线），不出现标题行。
class FollowUpBubbles extends StatelessWidget {
  const FollowUpBubbles({
    super.key,
    required this.prompts,
    required this.onTap,
    required this.bubbleColor,
    required this.textColor,
    this.bubbleRadius = 16,
    this.maxWidthFactor = 0.72,
    this.topSpacing = AppTypography.space2,
  });

  final List<String> prompts;
  final void Function(String prompt) onTap;

  /// 气泡底色 / 文字色：传入当前端助手气泡的配色。
  final Color bubbleColor;
  final Color textColor;

  final double bubbleRadius;

  /// 单条气泡最大宽度占可用宽度的比例。
  final double maxWidthFactor;

  /// 与上方 agent 消息之间的间距。
  final double topSpacing;

  @override
  Widget build(BuildContext context) {
    final List<String> items = <String>[
      for (final String prompt in prompts)
        if (prompt.trim().isNotEmpty) prompt,
    ];
    if (items.isEmpty) return const SizedBox.shrink();

    final TextStyle style =
        (Theme.of(context).textTheme.bodyMedium ?? const TextStyle()).copyWith(
      fontSize: AppTypography.body,
      height: AppTypography.uiLineHeight,
      color: textColor,
    );
    final BorderRadius radius = BorderRadius.only(
      topLeft: const Radius.circular(6),
      topRight: Radius.circular(bubbleRadius),
      bottomLeft: Radius.circular(bubbleRadius),
      bottomRight: Radius.circular(bubbleRadius),
    );

    return Padding(
      padding: EdgeInsets.only(top: topSpacing),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxWidth = constraints.maxWidth * maxWidthFactor;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int i = 0; i < items.length; i++)
                Padding(
                  padding: EdgeInsets.only(
                      top: i == 0 ? 0 : AppTypography.space2),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: maxWidth),
                    child: Material(
                      color: bubbleColor,
                      shape: RoundedRectangleBorder(borderRadius: radius),
                      clipBehavior: Clip.antiAlias,
                      child: InkWell(
                        onTap: () => onTap(items[i]),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 14, vertical: 9),
                          child: Text(items[i], style: style),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
