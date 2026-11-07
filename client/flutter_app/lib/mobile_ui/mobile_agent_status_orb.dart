import "package:flutter/material.dart";

import "../core/presentation/emotion_ball_ids.dart";
import "../features/chat/mood_driven_emotion_ball.dart";
import "mobile_theme.dart";

/// 输入框上方的 Agent 状态徽标（独立悬浮组件）。
///
/// 形态：一颗 28px 的 emotion-ball **表情球**（与桌面端「思考中」状态条
/// 左侧的 bot 同引擎同款表情，`thinking`/`retrieving` 自动切换）+ 右侧
/// 短文案胶囊。定位：由调用方放在消息区与输入栏之间的独立状态带——
/// **不进输入框、不与输入框连体**。
///
/// 进度语义：有 [percent]（长工具心跳）→ 文案胶囊里显示百分比；无 →
/// 胶囊后缀跳动点。
///
/// 点表情球可收起/展开文案胶囊（默认展开），屏幕窄时用户能自己腾地方。
class MobileAgentStatusOrb extends StatefulWidget {
  const MobileAgentStatusOrb({
    super.key,
    required this.label,
    this.percent,
    this.busy = true,
    this.toolName,
  });

  /// 已裁决好的进行时文案（调用方保证非空）。
  final String label;

  /// 长工具心跳推进的百分比（0-100）；null 时胶囊显示跳动点。
  final int? percent;

  /// 是否仍在干活（false 时球停、点不跳）。
  final bool busy;

  /// 当前正在调用的工具名（非空 → 表情球切「检索资料」，对齐桌面思考条）。
  final String? toolName;

  @override
  State<MobileAgentStatusOrb> createState() => _MobileAgentStatusOrbState();
}

class _MobileAgentStatusOrbState extends State<MobileAgentStatusOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _spin = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  /// 文案胶囊是否展开（点小球切换）。
  bool _expanded = true;

  @override
  void initState() {
    super.initState();
    _setAnimating(widget.busy);
  }

  @override
  void didUpdateWidget(MobileAgentStatusOrb oldWidget) {
    super.didUpdateWidget(oldWidget);
    _setAnimating(widget.busy);
  }

  void _setAnimating(bool busy) {
    if (busy && !_spin.isAnimating) {
      _spin.repeat();
    } else if (!busy && _spin.isAnimating) {
      _spin.stop();
    }
  }

  @override
  void dispose() {
    _spin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => _expanded = !_expanded),
          child: _buildOrb(context),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsets.only(left: 6),
            child: _buildChip(p),
          ),
      ],
    );
  }

  /// 表情球：桌面「思考中」状态条同款（参数照抄 chat_page 思考条，
  /// 体色用手机主题 colorScheme.primary，小尺寸放大眼睛保证表情可读）。
  Widget _buildOrb(BuildContext context) {
    final String tool = widget.toolName?.trim() ?? "";
    return MoodDrivenEmotionBall(
      fallback: tool.isNotEmpty
          ? EmotionBallIds.retrieving
          : EmotionBallIds.thinking,
      toolOverride: tool.isNotEmpty ? EmotionBallIds.retrieving : null,
      size: 28,
      bodyColor: Theme.of(context).colorScheme.primary,
      eyeScale: 1.35,
    );
  }

  /// 文案胶囊：短、单行、可省略；配色跟输入栏同底，读起来像挂在角上的浮标。
  Widget _buildChip(MobilePalette p) {
    final int? percent = widget.percent;
    return Container(
      constraints: const BoxConstraints(maxWidth: 200),
      padding: const EdgeInsets.fromLTRB(9, 5, 9, 5),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: p.divider),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Flexible(
            child: Text(
              widget.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: p.textSecondary,
                fontSize: 12,
                height: 1.2,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          if (percent != null) ...<Widget>[
            const SizedBox(width: 6),
            Text(
              "$percent%",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 11.5,
                height: 1.2,
                fontWeight: FontWeight.w700,
              ),
            ),
          ] else if (widget.busy) ...<Widget>[
            const SizedBox(width: 3),
            _buildDots(p),
          ],
        ],
      ),
    );
  }

  Widget _buildDots(MobilePalette p) {
    return AnimatedBuilder(
      animation: _spin,
      builder: (BuildContext context, Widget? child) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.only(left: 2),
                child: Opacity(
                  opacity: 0.25 + 0.75 * _phase(_spin.value, i),
                  child: Container(
                    width: 3.5,
                    height: 3.5,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: p.textSecondary,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  double _phase(double t, int i) {
    final double phase = (t - i * 0.16) % 1;
    return phase < 0 ? 0 : 1 - (phase * 2 - 1).abs();
  }
}
