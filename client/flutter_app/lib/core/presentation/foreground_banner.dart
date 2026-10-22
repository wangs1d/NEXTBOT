/// 前台横幅弹窗抽象接口（2026-10-21 定调）。
///
/// 手机端主动触达（到点提醒预告/到点、主动消息告知类）的统一呈现出口：
/// 控制器层（AmbientFeedsController / MobileChatController）只依赖本接口，
/// 不感知具体呈现实现——应用内 SnackBar 横幅（现役）或将来替换的原生
/// heads-up 浮层都经本接口注入，控制器零改动。
///
/// 分流约定（与 AmbientFeedsController 同构）：
///  - 桌面端不注入本接口：预告与到点提醒由灵动岛（IslandReminderScheduler）
///    承担，注入位留空即自动走岛原路；
///  - 手机端由 MobileHomeState 注入实现；
///  - 前台走横幅；后台一律走 LocalNotificationService 系统通知，
///    与横幅实现解耦（那条分流在控制器层，不进本接口）。
abstract interface class ForegroundBanner {
  /// 展示一条前台横幅。[message] 为空时实现方只出加粗主行。
  Future<void> show(String title, String message);
}
