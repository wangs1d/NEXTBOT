import "package:flutter/material.dart";

/// 卡片宽度令牌（2026-11-13 P0-7）。
///
/// **为什么要有这个**：改版前卡片宽度是**硬编码 390**，散落 11 处
/// （shopping_shared.dart / agent_result_card.dart 的 8 个分支 /
/// product_pick_card.dart / agent_action_choice_card.dart 等）。
/// 390 是 iPhone 14/15 的逻辑宽——在 430pt（Pro Max）/480pt（Android）机型上
/// 卡片右边空 40–90px，宽度不够；而桌面端又被聊天页的 `_contentMaxWidth=860`
/// 二次收窄，两头都不对。
///
/// **口径**：
/// - 手机（< 600pt）：**顶满可用宽度**（外层 padding 由聊天页负责），
///   保证商品图、商品名、价格、按钮都有完整横向空间；
/// - 宽屏（≥ 860pt）：与消息流同宽（860），不拉成横贯全屏的横幅；
/// - 两者之间（600–860pt）：**满宽不收窄**。
///
/// ⚠ 2026-11-13 修正：原先中屏走「视口宽 - 48」，等于在 600–860pt 区间
/// **凭空收窄 48px**——这会让聊天页文字换行变化，进而让聊天页滚动接管滑块的
/// 「总高估算」在拖动过程中跳变（`chat_scroll_takeover_test.dart` 断言
/// 「总高估算不摇摆」红）。收窄没有任何依据（原本 860 的约束在中屏本来就不
/// 生效），纯属副作用。改成 `min(视口宽, 860)` 后：
///   - 手机 375/390/430/480 → 满宽（用户要的「顶满横向宽度」）
///   - 中屏 600–860 → 满宽（与改造前**完全一致**，零回归）
///   - 桌面 ≥ 860 → 860（与改造前完全一致）
abstract final class CardMetrics {
  /// 桌面端与聊天页消息流同宽。
  static const double desktopMaxWidth = 860;

  /// 断点：小于此宽度视为手机。
  static const double phoneBreakpoint = 600;

  /// 断点：大于等于此宽度视为桌面。
  static const double desktopBreakpoint = 1000;

  /// 卡片最大宽度（随视口自适应）。
  static double maxWidth(BuildContext context) {
    final double w = MediaQuery.sizeOf(context).width;
    return w < desktopMaxWidth ? w : desktopMaxWidth;
  }

  /// 聊天页内容列宽度（与卡片同口径）。
  static double contentMaxWidth(BuildContext context) => maxWidth(context);
}
