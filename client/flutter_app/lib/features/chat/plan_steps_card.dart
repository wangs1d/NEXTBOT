import "package:flutter/material.dart";

import "../../core/models/turn_state.dart";

/// 任务步骤条（2026-10-19，handoff 的可见面）。
///
/// 主流私人助理（Muse / Manus / Devin）的共同点是把 plan 摆到用户眼前，而不是
/// 藏在模型脑子里。这里做最小可用版：一条常驻卡片，显示步骤与进度；某一步需要
/// 用户自己动手时，把服务端下发的 handoff 说明摊开，并给一个「我已完成」按钮
/// （点击等价于发一句话，服务端据此把该步置 done 并继续）。
///
/// 不做的事：
///  - 不在这里做状态判断（一切以服务端 plan_step 事件为准）；
///  - 全部完成即自动收起（不给用户留一张没用的历史卡片）。
class PlanStepsCard extends StatelessWidget {
  const PlanStepsCard({
    super.key,
    required this.steps,
    required this.onConfirm,
  });

  final List<TurnPlanStep> steps;

  /// 用户点「我已完成，继续下一步」
  final VoidCallback onConfirm;

  @override
  Widget build(BuildContext context) {
    final List<TurnPlanStep> visible =
        steps.where((TurnPlanStep s) => s.id.trim().isNotEmpty).toList();
    if (visible.isEmpty) return const SizedBox.shrink();
    final int done =
        visible.where((TurnPlanStep s) => s.status == TurnStepStatus.ok).length;
    if (done == visible.length) return const SizedBox.shrink();

    final ColorScheme cs = Theme.of(context).colorScheme;
    TurnPlanStep? blocking;
    for (final TurnPlanStep s in visible) {
      if (s.status == TurnStepStatus.waiting) {
        blocking = s;
        break;
      }
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.6)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(Icons.checklist_rounded,
                        size: 15, color: cs.onSurfaceVariant),
                    const SizedBox(width: 6),
                    Text(
                      "任务步骤",
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      "$done/${visible.length}",
                      style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                for (final TurnPlanStep s in visible) _buildRow(context, s),
                if (blocking != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Row(
                    children: <Widget>[
                      FilledButton(
                        onPressed: onConfirm,
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 32),
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          textStyle: const TextStyle(fontSize: 12.5),
                        ),
                        child: const Text("我已完成，继续下一步"),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRow(BuildContext context, TurnPlanStep step) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool waiting = step.status == TurnStepStatus.waiting;
    final Color fg = switch (step.status) {
      TurnStepStatus.ok => cs.onSurfaceVariant,
      TurnStepStatus.err => cs.error,
      TurnStepStatus.waiting => cs.primary,
      TurnStepStatus.running => cs.onSurface,
      TurnStepStatus.pending => cs.onSurfaceVariant,
    };
    final Widget leading = switch (step.status) {
      TurnStepStatus.ok => Icon(Icons.check_circle_rounded, size: 14, color: fg),
      TurnStepStatus.err => Icon(Icons.error_outline_rounded, size: 14, color: fg),
      TurnStepStatus.waiting => Icon(Icons.pan_tool_alt_outlined, size: 14, color: fg),
      TurnStepStatus.running => SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(strokeWidth: 1.6, color: fg),
        ),
      TurnStepStatus.pending => Icon(Icons.circle_outlined, size: 13, color: fg),
    };

    return Padding(
      padding: const EdgeInsets.only(top: 3, bottom: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1.5),
            child: leading,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  step.title,
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.35,
                    color: fg,
                    decoration: step.status == TurnStepStatus.ok
                        ? TextDecoration.lineThrough
                        : null,
                    decorationColor: cs.onSurfaceVariant,
                  ),
                ),
                if (waiting && (step.instruction?.trim().isNotEmpty ?? false))
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      step.instruction!.trim(),
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        color: cs.primary,
                      ),
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
