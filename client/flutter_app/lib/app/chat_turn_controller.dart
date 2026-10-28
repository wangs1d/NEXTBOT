/// 前台对话轮次控制器 —— 轮次 traceId 的收口
/// （原 `_PrivateAiAppState` 内联字段 `_pendingAgentUserMessageId`）。
///
/// 2026-10-28 用户明确：**不设操作上限时间**——原「3 分钟无轮次事件报超时」
/// 的 reply watchdog 已整体移除（Agent 长跑浏览器任务/工具链不再被客户端
/// 掐断）。轮次收尾完全由确定性事件驱动：chat.assistant_done / error.event /
/// 连接断开（main 直接调用收尾），这里只管 traceId 在途登记。纯状态机，可单测。
class ChatTurnController {
  ChatTurnController._();

  static final ChatTurnController instance = ChatTurnController._();

  /// 前台轮次 traceId（= 触发该轮的用户消息 id）；null 表示无前台轮次在途。
  /// 与岛/任务面的「后台任务」无关，仅描述聊天区当前前台轮次。
  String? activeTraceId;

  /// 新前台轮次开始：登记 traceId（历史上弦 watchdog 已移除）。
  void armTrace(String userMessageId) {
    activeTraceId = userMessageId;
  }

  /// 兼容空操作（原续弦接口；watchdog 移除后收尾由确定性事件驱动）。
  void resetTimer() {}

  /// 兼容空操作（原解除上弦接口；保留调用点避免散弹式改动）。
  void cancelTimer() {}

  bool get hasActiveTrace => activeTraceId != null;
}

/// 任务面活跃任务状态机（chat.task_update 生命周期驱动），
/// 计数驱动输入框上方「N 个任务后台进行中」状态条与岛任务条目。
class TaskPlaneState {
  final Set<String> _active = <String>{};

  int get activeCount => _active.length;

  bool get isEmpty => _active.isEmpty;

  /// 终态（done/failed/cancelled）移除、其余状态加入；返回是否发生变化。
  bool applyLifecycle({required String taskId, required String state}) {
    final bool terminal =
        state == "done" || state == "failed" || state == "cancelled";
    return terminal ? _active.remove(taskId) : _active.add(taskId);
  }

  void remove(String taskId) => _active.remove(taskId);

  void clear() => _active.clear();
}
