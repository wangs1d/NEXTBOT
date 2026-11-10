import "dart:async";

import "package:flutter/foundation.dart";

/// 每条 WS 事件的归属通道。
///
/// 主流做法（微信/Telegram/飞书同构）：连接层只管连接，**事件分发只有一个
/// 分拣点**，每类业务事件有唯一 owner，归属判断不允许散落多处。
enum WsEventRoute {
  /// 手机端业务动作的唯一 owner = 聊天控制器。
  /// 桌面端没有该控制器，自动回落 [rootOnly]。
  chatOnly,

  /// 只给根分发器：闹钟引擎、浏览器桥、来电、更新、媒体播放等全局动作。
  rootOnly,

  /// 两端都要：连接状态、工具进度这类「各自维护自己的 UI 状态」的事件。
  /// 不涉及落盘/上报/通知等一次性副作用，重复消费是安全的。
  both,
}

/// WS 事件路由器。
///
/// 数据流：`WsChatService.shared.events` → [attach] → [_routes] 分拣 →
/// [rootEvents] / [chatEvents] 两条通道。
///
/// 由此得到的结构性保证：
/// - 同一条业务事件只会投给**一个**通道（落盘/ack/通知只发生一次）；
/// - 归属表是唯一事实源，新增事件只在 [routes] 加一行；
/// - 未登记的事件默认 [rootOnly]，不会因为忘记登记而丢失。
class WsEventRouter {
  WsEventRouter._();

  static final WsEventRouter instance = WsEventRouter._();

  /// 归属表（唯一事实源）。
  ///
  /// 只有需要「手机端聊天控制器独占」或「两端都要」的事件才登记；
  /// 其余保持默认 [WsEventRoute.rootOnly]。
  static const Map<String, WsEventRoute> routes = <String, WsEventRoute>{
    // ── 聊天流（手机端只由聊天控制器渲染/落盘，根分发器不参与）──
    "chat.turn_started": WsEventRoute.chatOnly,
    "chat.assistant_interim": WsEventRoute.chatOnly,
    "chat.assistant_chunk": WsEventRoute.chatOnly,
    "chat.assistant_done": WsEventRoute.chatOnly,
    "chat.stream_reset": WsEventRoute.chatOnly,
    "chat.media_ready": WsEventRoute.chatOnly,
    "chat.agent_status": WsEventRoute.chatOnly,
    "chat.intent_detected": WsEventRoute.chatOnly,
    "chat.error": WsEventRoute.chatOnly,
    "card.update": WsEventRoute.chatOnly,

    // ── 日程（手机端日程页由聊天控制器驱动）──
    "schedule.reminder_fired": WsEventRoute.chatOnly,
    "schedule.tasks_changed": WsEventRoute.chatOnly,

    // ── 主动消息 / 提醒弹窗：落手机对话流 + 系统通知 + ack，只允许一次 ──
    "agent.proactive_message": WsEventRoute.chatOnly,
    "reminder_popup": WsEventRoute.chatOnly,

    // ── 语音类：手机端由控制器播 TTS 并弹通知（桌面端回落根分发器）──
    "agent.proactive_voice": WsEventRoute.chatOnly,
    "agent.voice.alarm": WsEventRoute.chatOnly,
    "agent.voice.speak": WsEventRoute.chatOnly,

    // ── 定位：一次事件只允许发一次 GPS 请求 / 一次回包 ──
    "agent.location_request": WsEventRoute.chatOnly,
    "agent.geofence_sync": WsEventRoute.chatOnly,

    // ── 其余手机端专属单次动作 ──
    "evening.digest": WsEventRoute.chatOnly,
    "agent.transfer_reminder": WsEventRoute.chatOnly,
    "identity_renamed": WsEventRoute.chatOnly,
    "onboarding.name_choices": WsEventRoute.chatOnly,

    // ── 连接状态：两端各自维护自己的 UI / 重连策略，无一次性副作用 ──
    "ws_connected": WsEventRoute.both,
    "ws_disconnected": WsEventRoute.both,
    "connection_error": WsEventRoute.both,

    // ── 工具进度：根分发器管输入框徽标/浏览器面板，控制器管思考态文案 ──
    "tool.call": WsEventRoute.both,
    "tool.result": WsEventRoute.both,
  };

  /// 当前端是否为手机（桌面端没有聊天控制器，chatOnly 一律回落 root）。
  bool _mobile = false;

  final StreamController<Map<String, dynamic>> _rootEvents =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Map<String, dynamic>> _chatEvents =
      StreamController<Map<String, dynamic>>.broadcast();

  /// 根分发器通道（桌面全量；手机端只收 rootOnly / both）。
  Stream<Map<String, dynamic>> get rootEvents => _rootEvents.stream;

  /// 手机聊天控制器通道（只收 chatOnly / both）。
  Stream<Map<String, dynamic>> get chatEvents => _chatEvents.stream;

  StreamSubscription<Map<String, dynamic>>? _source;

  bool get isAttached => _source != null;

  /// 绑定端类型。必须在 [attach] 之前调用。
  void bindPlatform({required bool isMobile}) => _mobile = isMobile;

  /// 接入唯一连接的事件源（幂等）。
  void attach(Stream<Map<String, dynamic>> source) {
    if (_source != null) return;
    _source = source.listen(dispatch);
  }

  /// 分拣一条事件（[WsEventRouter] 的唯一边界，测试可直接调用）。
  @visibleForTesting
  void dispatch(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    final WsEventRoute route = routes[type] ?? WsEventRoute.rootOnly;
    if (route == WsEventRoute.chatOnly && _mobile) {
      _push(_chatEvents, event, type);
      return;
    }
    _push(_rootEvents, event, type);
    if (route == WsEventRoute.both && _mobile) {
      _push(_chatEvents, event, type);
    }
  }

  void _push(
    StreamController<Map<String, dynamic>> channel,
    Map<String, dynamic> event,
    String type,
  ) {
    if (channel.isClosed) return;
    if (!channel.hasListener) {
      // 手机聊天页尚未构建（首帧前）时的连接状态事件会走到这里：属正常丢弃，
      // 不应静默——否则下次排查「为什么没反应」又要从头猜。
      debugPrint("[ws-router] drop '$type' (no listener)");
      return;
    }
    channel.add(event);
  }

  void dispose() {
    unawaited(_source?.cancel());
    _source = null;
    unawaited(_rootEvents.close());
    unawaited(_chatEvents.close());
  }
}
