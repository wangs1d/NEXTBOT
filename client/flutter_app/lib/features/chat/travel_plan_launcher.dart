import "../../core/utils/agent_result_parser.dart";

/// 行程规划面板启动器：行程卡(travel_itinerary) → 独立规划界面 的桥接。
///
/// 与 `image_preview_launcher.dart` 同款「静态回调注册」方案：
/// - 主壳(main.dart)启动时调用 [setHandler] 注册一个打开独立窗口的方法；
/// - 卡片等深层 widget 不关心界面如何实现，只需调用 [open] 触发打开。
class TravelPlanLauncher {
  TravelPlanLauncher._();

  static void Function(AgentResultData data)? _handler;

  /// 按 planId 打开完整行程（手机端聊天内联规划出的最终方案）。
  static Future<void> Function(String planId)? _planIdHandler;

  /// 当前最近一次打开的行程卡片数据（面板打开后可读取）。
  static AgentResultData? last;

  /// 主壳在启动时注册独立窗口打开回调。
  static void setHandler(void Function(AgentResultData data) handler) {
    _handler = handler;
  }

  /// 主壳注册「按 planId 拉完整行程并打开详情页」回调。
  static void setPlanIdHandler(Future<void> Function(String planId) handler) {
    _planIdHandler = handler;
  }

  /// 请求以独立界面展示行程规划。
  static void open(AgentResultData data) {
    last = data;
    _handler?.call(data);
  }

  /// 请求按 planId 展示完整行程。
  static Future<void> openPlanById(String planId) async {
    await _planIdHandler?.call(planId);
  }
}
