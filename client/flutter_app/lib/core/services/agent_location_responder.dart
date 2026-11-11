import "dart:async";

import "package:flutter/foundation.dart";

import "client_location_service.dart";
import "ws_chat_service.dart";
import "ws_event_router.dart"
    show WsEventRouter, WsSubscribeScope, WsEventCatalog, wsEventPayload;

/// 桌面端定位回包器（事件总线自订阅模块）。
///
/// 服务端按需请求实时位置（agent.location_request）：拉一次 GPS、纯坐标
/// 秒回（不做客户端逆地理）：服务端拿到坐标后自行反查城市，避免客户端
/// 逆地理 HTTP 把回包拖超时（服务端 requestLocation 只等 12s）。
///
/// 原为 main.dart 根监听器内联分支，2026-11-10 收口为本模块。归属表里
/// agent.location_request 是 chatOnly：手机端由聊天控制器处理，本订阅
/// scope=root 在手机端收不到该事件（桌面走 chatOnly 回落），两端互不重复。
class AgentLocationResponder {
  AgentLocationResponder._();

  static final AgentLocationResponder instance = AgentLocationResponder._();

  static bool _busWired = false;

  /// 事件总线自订阅（main.dart 装配时调用一次；幂等）。
  static void ensureBusSubscription() {
    if (_busWired) return;
    _busWired = true;
    WsEventRouter.instance.subscribe(
      module: "agent-location-responder",
      types: WsEventCatalog.locationResponder,
      scope: WsSubscribeScope.root,
      onEvent: (Map<String, dynamic> event) => _reply(wsEventPayload(event)),
    );
  }

  static Future<void> _reply(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString() ?? "";
    final ClientLocationPayload? loc =
        await ClientLocationService.getCurrentLocationForAgentReply();
    // 拿不到坐标也回 jobId 空包：让服务端立即结算（resolve null），
    // 不白等满 12s 超时（与手机端 _handleLocationRequest 同语义）。
    final bool sent = WsChatService.shared.sendEvent(
      "client.location_report",
      <String, dynamic>{
        if (jobId.isNotEmpty) "jobId": jobId,
        ...?loc?.toJson(),
      },
    );
    if (!sent) {
      debugPrint("[location-responder] sendEvent queued (offline): jobId=$jobId");
    }
  }
}
