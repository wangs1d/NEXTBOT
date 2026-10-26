import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";

/// 旅游功能跨表面共享强调色（随 [AppThemeVariant] 对齐）。
///
/// - dark：跟随 App 深色主题的中性灰阶（#D4D4D8 强调 / #2C2C2C 按钮底），
///   不再使用霓虹青，界面与主侧栏、主对话保持同一套灰阶；
/// - warm：奶油白主题下收敛为低饱和蓝绿，与 `AppPalette.warm*` 的
///   按钮（#EAF3FF 底 / #0055B8 字）和强调色一致。
///
/// 海报照片遮罩、地图画布等「恒深色底」上的元素不适用本调色板
///（两类底色下都用白色系保证可读，见各使用处注释）。
class TravelPalette {
  const TravelPalette({
    required this.accent,
    required this.accentBg,
    required this.onAccentBg,
    required this.green,
    required this.orange,
    required this.purple,
  });

  /// 主强调色（图标 / 描边 / 文字强调，用在主题 surface 上）。
  final Color accent;

  /// 实底按钮背景（FilledButton 类）。
  final Color accentBg;

  /// 实底按钮前景。
  final Color onAccentBg;

  /// 次强调：酒店 / 成功 / 正向状态。
  final Color green;

  /// 次强调：餐厅 / 价格 / 提醒。
  final Color orange;

  /// 次强调：交通 / 信息。
  final Color purple;

  /// 按当前 App 主题变体取调色板（热切换后 rebuild 自动跟随）。
  static TravelPalette of(BuildContext context) =>
      AppThemeController.instance.value == AppThemeVariant.warm
          ? warm
          : dark;

  /// 深色主题（默认）：中性灰阶，与主侧栏 / 主对话一致。
  static const TravelPalette dark = TravelPalette(
    accent: Color(0xFFD4D4D8),
    accentBg: Color(0xFF2C2C2C),
    onAccentBg: Color(0xFFE8E8E8),
    green: Color(0xFF1ED7A6),
    orange: Color(0xFFD7B85A),
    purple: Color(0xFF8B5CF6),
  );

  /// 暖色主题：低饱和蓝绿，对齐 warm 主题的 FilledButton 与强调配色。
  static const TravelPalette warm = TravelPalette(
    accent: Color(0xFF0055B8),
    accentBg: Color(0xFFEAF3FF),
    onAccentBg: Color(0xFF0055B8),
    green: Color(0xFF0E9F6E),
    orange: Color(0xFFB45309),
    purple: Color(0xFF6B5CA5),
  );
}
