/// 「问 Agent」启动器：行程页/行程归档 → 回到聊天并把问题预填进输入框。
///
/// 与 [TravelPlanLauncher] 同款「静态回调注册」方案：
/// - 主壳（main.dart）启动时调用 [setHandler] 注册回调（popUntil 回到
///   根路由 + 切到对话 tab + 预填输入框并聚焦）；
/// - 行程界面等深层 widget 不关心聊天如何实现，只调用 [ask]。
///
/// 预填而非直接发送：用户可以补充或修改问题再发。
class TravelAskLauncher {
  TravelAskLauncher._();

  static void Function(String message)? _handler;

  /// 主壳在启动时注册「回到聊天 + 预填输入框」回调。
  static void setHandler(void Function(String message) handler) {
    _handler = handler;
  }

  /// 请求回到聊天并预填一条以行程为上下文的消息（不自动发送）。
  static void ask(String message) {
    _handler?.call(message);
  }
}
