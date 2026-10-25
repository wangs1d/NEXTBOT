import "package:flutter/material.dart";

import "../../core/models/turn_state.dart";

/// 任务步骤条（2026-10-19，handoff 的可见面）。
///
/// 主流私人助理（Muse / Manus / Devin）的共同点是把 plan 摆到用户眼前，而不是
/// 藏在模型脑子里。这里做最小可用版：一条常驻卡片，显示步骤与进度；某一步需要
/// 用户自己动手时，把服务端下发的 handoff 说明摊开，并给一个「我已完成」按钮
/// （点击等价于发一句话，服务端据此把该步置 done 并继续）。
///
/// 感知动画（2026-10-25）：头部加滑动进度条（计数变化时平滑滑动）；running
/// 行整行呼吸脉动（「正在做」一眼可辨）；状态图标切换走淡入过渡；handoff
/// 等人行给强调底色 + 图标脉动（「等你操作」要醒目）；步骤增减时卡片高度
/// 平滑收展。
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
          child: AnimatedSize(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
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
                  // 进度条：计数变化时平滑滑动到新比例（感知「在做、在推进」）
                  TweenAnimationBuilder<double>(
                    tween: Tween<double>(begin: 0, end: done / visible.length),
                    duration: const Duration(milliseconds: 420),
                    curve: Curves.easeOutCubic,
                    builder: (BuildContext context, double v, _) => ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        value: v,
                        minHeight: 3,
                        backgroundColor:
                            cs.outlineVariant.withValues(alpha: 0.4),
                        valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  for (final TurnPlanStep s in visible) _buildRow(context, s),
                  if (blocking != null) ...<Widget>[
                    const SizedBox(height: 8),
                    Row(
                      children: <Widget>[
                        _Pulsing(
                          child: FilledButton(
                            onPressed: onConfirm,
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(0, 32),
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 14),
                              textStyle: const TextStyle(fontSize: 12.5),
                            ),
                            child: const Text("我已完成，继续下一步"),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRow(BuildContext context, TurnPlanStep step) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool waiting = step.status == TurnStepStatus.waiting;
    final bool running = step.status == TurnStepStatus.running;
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
    // 状态切换（running→ok 等）时图标淡入过渡，不硬切
    final Widget animatedLeading = AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      transitionBuilder: (Widget child, Animation<double> a) =>
          FadeTransition(opacity: a, child: child),
      child: KeyedSubtree(key: ValueKey<TurnStepStatus>(step.status), child: leading),
    );

    final Widget row = Padding(
      padding: const EdgeInsets.only(top: 3, bottom: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1.5),
            child: animatedLeading,
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

    // running 行整行呼吸脉动；waiting（handoff 等你操作）行给强调底色
    Widget wrapped = row;
    if (running) {
      wrapped = _Pulsing(
        low: 0.55,
        child: row,
      );
    }
    if (waiting) {
      wrapped = Container(
        margin: const EdgeInsets.only(top: 3, bottom: 3),
        padding: const EdgeInsets.fromLTRB(6, 3, 6, 3),
        decoration: BoxDecoration(
          color: cs.primary.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: cs.primary.withValues(alpha: 0.25)),
        ),
        child: _Pulsing(
          low: 0.7,
          child: row,
        ),
      );
    }
    return wrapped;
  }
}

/// 呼吸脉动容器：透明度在 [low]↔1 间往复循环（「正在做/等你操作」的动感）。
class _Pulsing extends StatefulWidget {
  const _Pulsing({required this.child, this.low = 0.6});

  final Widget child;
  final double low;

  @override
  State<_Pulsing> createState() => _PulsingState();
}

class _PulsingState extends State<_Pulsing>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  late final Animation<double> _opacity = Tween<double>(
    begin: widget.low,
    end: 1,
  ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: widget.child,
    );
  }
}
