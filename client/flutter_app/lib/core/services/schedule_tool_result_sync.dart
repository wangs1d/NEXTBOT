import "dart:async";

import "package:flutter/foundation.dart";

import "../db/isar_local_history_store.dart";
import "schedule_reminder_sync.dart";
import "ws_event_router.dart"
    show WsEventRouter, WsSubscribeScope, WsEventCatalog, wsEventPayload;

/// tool.result → 本地日程镜像同步（事件总线自订阅模块）。
///
/// 日程类工具（calendar.create_task / calendar_create_from_text /
/// calendar.delete_task 等）执行成功后，把结果落到本地日程镜像（Isar）
/// 并触发日程/日历面板刷新信号。原为 main.dart 根监听器内联分支
/// （桌面/手机共用同一段代码），2026-11-10 收口为本模块：tool.result 是
/// both 归属，scope=root 两端各投一次，与迁出前行为一致。
class ScheduleToolResultSync {
  ScheduleToolResultSync._();

  static final ScheduleToolResultSync instance = ScheduleToolResultSync._();

  static bool _busWired = false;
  IsarLocalHistoryStore? _store;

  /// UI 端口：日程/日历面板刷新信号（main 装配时注入 _notifyScheduleViewsChanged）。
  void Function()? _onViewsChanged;

  /// 总线自订阅 + 端口装配（main 装配时调用一次；幂等）。
  static void ensureBusSubscription({
    required IsarLocalHistoryStore store,
    void Function()? onViewsChanged,
  }) {
    instance._store = store;
    instance._onViewsChanged = onViewsChanged;
    if (_busWired) return;
    _busWired = true;
    WsEventRouter.instance.subscribe(
      module: "schedule-tool-result-sync",
      types: WsEventCatalog.scheduleToolResultSync,
      scope: WsSubscribeScope.root,
      onEvent: (Map<String, dynamic> event) =>
          instance._sync(wsEventPayload(event)),
    );
  }

  Future<void> _sync(Map<String, dynamic> payload) async {
    final IsarLocalHistoryStore? store = _store;
    if (store == null) return;
    final Map<String, dynamic>? result =
        (payload["result"] as Map?)?.cast<String, dynamic>();
    final String toolName = payload["toolName"]?.toString() ?? "";
    final bool toolOk = payload["ok"] == true;
    if (!toolOk || result == null) return;
    try {
      final String normalizedTool = toolName.replaceAll("_", ".");
      if (normalizedTool == "calendar.delete_task") {
        final String? deletedId = result["taskId"]?.toString();
        if (deletedId != null && deletedId.isNotEmpty) {
          await removeLocalScheduleForDeletedTask(store, deletedId);
          _onViewsChanged?.call();
        }
      } else {
        final bool synced =
            await upsertLocalScheduleFromToolResult(store, toolName, result);
        if (synced) {
          _onViewsChanged?.call();
        }
      }
    } catch (e, st) {
      debugPrint("[schedule] tool.result sync failed: $e\n$st");
    }
  }
}
