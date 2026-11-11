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

/// 各模块 owned 事件类型的唯一目录（单一事实源）。
///
/// 以前模块的 `subscribe(types: {...})` 与归属表各写一份事件名，改一处忘一处
/// 就漏收（双源漂移）。现在模块订阅一律引用本目录；[WsEventRouter.routes]
/// 里的分类也以本目录为准（`ws_event_router_test` 强制校验两者一致：新增
/// 类型必须先在这里登记，并想清楚它在两端的归属）。
class WsEventCatalog {
  const WsEventCatalog._();

  /// 闹钟引擎（root 域）：建钟/改期同步、到点触发、即时提醒投递。
  static const Set<String> alarmEngine = <String>{
    "alarm.sync",
    "alarm.trigger",
    "reminder.deliver",
  };

  /// 日程触达 + 环境消息编排（auto 域）：到点提醒、日程变更同步、
  /// 站内信即时提醒、Agent 间消息。
  static const Set<String> ambientFeeds = <String>{
    "schedule.tasks_changed",
    "schedule.reminder_fired",
    "inbox.message",
    "agent.peer_message",
  };

  /// 媒体播放（root 域）。
  static const Set<String> mediaPlayback = <String>{
    "agent.media.play",
    "agent.media.pause",
    "agent.media.resume",
    "agent.media.stop",
  };

  /// 桌面端定位回包（root 域；手机端该事件归聊天控制器，root 域收不到）。
  static const Set<String> locationResponder = <String>{
    "agent.location_request",
  };

  /// 日程本地落库（root 域）。
  static const Set<String> scheduleToolResultSync = <String>{"tool.result"};

  /// 逐句 TTS 流式帧（root 域，自带 traceId 过滤）。
  static const Set<String> pureVoiceSpeech = <String>{"chat.assistant_speech"};

  /// 连接态（状态型事件，见 [WsEventRouter.stateEventTypes]）。
  ///
  /// 只放**可重放的状态**：新订阅者晚到时补投一次仍然成立（「现在已连上」
  /// 「现在断了」）。`ws_auth_expired` 是一次性告警，不能进这里——否则每次
  /// 重建订阅者都会被补投一次「登录失效」，把用户无故踢回登录页。
  static const Set<String> connectionState = <String>{
    "ws_connected",
    "ws_disconnected",
    "connection_error",
  };
}

/// WS 事件路由器。
///
/// 数据流：`WsChatService.shared.events` → [attach] → [routes] 分拣 →
/// [rootEvents] / [chatEvents] 两条通道 + 模块订阅者直投。
///
/// 由此得到的结构性保证：
/// - 同一条业务事件只会投给**一个**通道（落盘/ack/通知只发生一次）；
/// - 归属表是唯一事实源，新增事件只在 [routes] 加一行；
/// - 未登记的事件默认 [rootOnly]，不会因为忘记登记而丢失；
/// - 业务模块经 [subscribe] 自订阅自己的事件类型（单连接 + 事件总线），
///   main.dart 根监听器只保留强绑定 UI State 的分支，不再做手工接线；
/// - 模块投递走**每订阅者串行异步信箱**：[dispatch] 永不等模块 handler，
///   WS 接收循环不被任何模块阻塞；同一模块的事件按到达顺序串行执行
///   （alarm.sync 先于 alarm.trigger 的语义不因异步而乱序）；不同模块
///   之间并行互不等待；handler 的同步/异步异常统一被总线捕获隔离；
/// - 信箱**有界 + 可合并**：handler 挂起时队列不会无界堆积（超限丢最旧并
///   记日志），声明为可合并的幂等状态同步事件只保留最新一条；
/// - **状态型事件带 last-value**：[stateEventTypes] 里的连接态事件会被缓存，
///   晚到的订阅者订阅时自动补投一次当前值——修掉「事件发出时还没人监听 →
///   永久显示已断开」的事故形态（2026-11-10）。
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
    // 客户端自产的投递失败（重投次数用尽）：只有聊天控制器能把它变成可见提示。
    "chat_delivery_failed": WsEventRoute.chatOnly,
    // ── 服务端统一错误帧（error.event）──
    // 两端都要收：桌面端根分发器负责关闭对应窗口/toast；手机端聊天控制器
    // 必须看到「服务端明确拒收本条消息」，否则投递失败会表现为无限「我看看」
    // （2026-11-11 actor 不一致被 FORBIDDEN 丢弃，控制器完全收不到任何信号）。
    "error.event": WsEventRoute.both,
    "card.update": WsEventRoute.chatOnly,

    // ── 日程（手机端日程页由聊天控制器驱动；模块订阅走 auto 域）──
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

  /// 状态型事件（连接态语义）。
  ///
  /// 这类事件是**状态**而不是**动作**：晚到的订阅者需要的是「当前值」，错过
  /// 一次就再也补不回来。2026-11-10 的「连接一直断开」正是这样发生的——
  /// 连接在 app 启动早期就建好，`ws_connected` 发出时聊天通道还没有监听者，
  /// 被 no-listener 保护丢弃，控制器永远以为没连上。
  static const Set<String> stateEventTypes = WsEventCatalog.connectionState;

  /// 当前端是否为手机（桌面端没有聊天控制器，chatOnly 一律回落 root）。
  bool _mobile = false;

  final StreamController<Map<String, dynamic>> _rootEvents =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Map<String, dynamic>> _chatEvents =
      StreamController<Map<String, dynamic>>.broadcast();

  /// 模块订阅者（单连接 + 事件总线的模块级直投名单）。
  final List<WsBusSubscription> _subscribers = <WsBusSubscription>[];

  /// 最近一次状态型事件（供新订阅者补投；只保留最新一条，避免补投出
  /// 「先连后断」的自相矛盾序列）。
  Map<String, dynamic>? _lastStateEvent;

  // ── 轻量遥测（排查用，不持久化）──
  final Map<String, int> _typeCounts = <String, int>{};
  final List<String> _recentTypes = <String>[];
  static const int _recentTypesLimit = 50;
  int _droppedNoListener = 0;

  /// 根分发器通道（桌面全量；手机端只收 rootOnly / both）。
  Stream<Map<String, dynamic>> get rootEvents => _rootEvents.stream;

  /// 手机聊天控制器通道（只收 chatOnly / both）。
  Stream<Map<String, dynamic>> get chatEvents => _chatEvents.stream;

  StreamSubscription<Map<String, dynamic>>? _source;

  bool get isAttached => _source != null;

  /// 各类事件累计收到条数（类型 → 次数）。
  Map<String, int> get typeCounts => Map<String, int>.unmodifiable(_typeCounts);

  /// 最近到达的事件类型（最多 [_recentTypesLimit] 条，按到达顺序）。
  List<String> get recentTypes => List<String>.unmodifiable(_recentTypes);

  /// 因 UI 通道无监听者而被丢弃的事件数（排查「为什么没反应」的第一指标）。
  int get droppedNoListener => _droppedNoListener;

  /// 绑定端类型。必须在 [attach] 之前调用。
  void bindPlatform({required bool isMobile}) => _mobile = isMobile;

  /// 接入唯一连接的事件源（幂等）。
  void attach(Stream<Map<String, dynamic>> source) {
    if (_source != null) return;
    _source = source.listen(dispatch);
  }

  /// 分拣一条事件（[WsEventRouter] 的唯一边界，测试可直接调用）。
  ///
  /// 投递顺序：先同步入队模块订阅者（服务单例常驻，不受 UI 通道监听是否
  /// 在场影响），再推 UI 通道（broadcast 流异步派发）。两种投递共用同一份
  /// 「平台路由资格」判断，保证同一事件对同一订阅者至多一次。
  @visibleForTesting
  void dispatch(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    _recordTelemetry(type);
    if (stateEventTypes.contains(type)) {
      // 状态型事件保留最新值：新订阅者订阅时补投（见 [subscribe]）。
      _lastStateEvent = event;
    }
    final WsEventRoute route = routes[type] ?? WsEventRoute.rootOnly;
    final bool rootEligible = !_mobile || route != WsEventRoute.chatOnly;
    final bool chatEligible =
        _mobile && (route == WsEventRoute.chatOnly || route == WsEventRoute.both);
    _deliverToSubscribers(
      type,
      event,
      rootEligible: rootEligible,
      chatEligible: chatEligible,
    );
    if (rootEligible) _push(_rootEvents, event, type);
    if (chatEligible) _push(_chatEvents, event, type);
  }

  void _recordTelemetry(String type) {
    if (type.isEmpty) return;
    _typeCounts[type] = (_typeCounts[type] ?? 0) + 1;
    _recentTypes.add(type);
    if (_recentTypes.length > _recentTypesLimit) {
      _recentTypes.removeRange(0, _recentTypes.length - _recentTypesLimit);
    }
  }

  /// 测试隔离：清空遥测与状态缓存（不影响订阅者）。
  @visibleForTesting
  void resetTelemetry() {
    _typeCounts.clear();
    _recentTypes.clear();
    _droppedNoListener = 0;
    _lastStateEvent = null;
  }

  /// 模块级订阅：业务模块声明自己 owned 的事件类型，由总线直投。
  ///
  /// - [module] 仅用于日志/排查（订阅者异常时定位模块）；
  /// - [types] 为 null 时订阅 scope 语义内的**每一条**事件（仅限内部
  ///   自带类型过滤的服务，如 SharedBrowserHost.handleServerEvent）；
  /// - [coalesceTypes] 里的类型在队列积压时只保留最新一条（幂等「全量状态
  ///   同步」语义，如 alarm.sync：补三次和补最后一次等价）；
  /// - [scope] 决定平台路由资格（见 [WsSubscribeScope]）；
  /// - 订阅者异常被逐个捕获，互不影响、也不影响 UI 通道；
  /// - 若该订阅者关心连接态且已有状态缓存，**立即补投一次当前值**——模块
  ///   不必再自己写「订阅后查一次 isConnected」的补丁。
  WsBusSubscription subscribe({
    required String module,
    Set<String>? types,
    required WsEventHandler onEvent,
    WsSubscribeScope scope = WsSubscribeScope.auto,
    Set<String> coalesceTypes = const <String>{},
  }) {
    final WsBusSubscription sub = WsBusSubscription._(
      this,
      module,
      types == null ? null : Set<String>.of(types),
      onEvent,
      scope,
      Set<String>.of(coalesceTypes),
    );
    _subscribers.add(sub);
    _replayStateTo(sub);
    return sub;
  }

  /// 状态补投：新订阅者若关心最近一次状态型事件，立刻补一条当前值。
  ///
  /// 只补「最新那一条」——补多条会造出「先连后断」的矛盾序列；没有历史值
  /// 时不补，避免伪造「已连接」。
  void _replayStateTo(WsBusSubscription sub) {
    final Map<String, dynamic>? last = _lastStateEvent;
    if (last == null) return;
    final String type = last["type"] as String? ?? "";
    final Set<String>? types = sub.types;
    if (types != null && !types.contains(type)) return;
    if (!_eligible(sub.scope, type)) return;
    sub._enqueue(last);
  }

  /// 平台路由资格：一条事件该不该投给某个订阅域。
  bool _eligible(WsSubscribeScope scope, String type) {
    final WsEventRoute route = routes[type] ?? WsEventRoute.rootOnly;
    final bool rootEligible = !_mobile || route != WsEventRoute.chatOnly;
    final bool chatEligible = _mobile &&
        (route == WsEventRoute.chatOnly || route == WsEventRoute.both);
    return switch (scope) {
      WsSubscribeScope.root => rootEligible,
      WsSubscribeScope.chat => chatEligible,
      WsSubscribeScope.auto => rootEligible || chatEligible,
    };
  }

  void _deliverToSubscribers(
    String type,
    Map<String, dynamic> event, {
    required bool rootEligible,
    required bool chatEligible,
  }) {
    // 用下标遍历：订阅/退订只发生在业务线程（handler 之外），不需要快照拷贝。
    for (int i = 0; i < _subscribers.length; i++) {
      final WsBusSubscription sub = _subscribers[i];
      if (sub._cancelled) continue;
      final bool wants = switch (sub.scope) {
        WsSubscribeScope.root => rootEligible,
        WsSubscribeScope.chat => chatEligible,
        WsSubscribeScope.auto => rootEligible || chatEligible,
      };
      if (!wants) continue;
      final Set<String>? types = sub.types;
      if (types != null && !types.contains(type)) continue;
      // 异步信箱：dispatch 永不等待模块 handler（WS 接收循环零阻塞），
      // 同一订阅者内部串行保序，异常（含 async 抛出）由信箱统一捕获。
      sub._enqueue(event);
    }
  }

  void _push(
    StreamController<Map<String, dynamic>> channel,
    Map<String, dynamic> event,
    String type,
  ) {
    if (channel.isClosed) return;
    if (!channel.hasListener) {
      // 手机聊天页尚未构建（首帧前）的事件会走到这里。状态型事件已由
      // [_lastStateEvent] 兜底补投，其余属正常丢弃——但必须计数，否则
      // 下次排查「为什么没反应」又要从头猜。
      _droppedNoListener++;
      if (kDebugMode) {
        debugPrint("[ws-router] drop '$type' (no listener)");
      }
      return;
    }
    channel.add(event);
  }

  void dispose() {
    unawaited(_source?.cancel());
    _source = null;
    for (final WsBusSubscription sub in List<WsBusSubscription>.of(_subscribers)) {
      sub.cancel();
    }
    _subscribers.clear();
    unawaited(_rootEvents.close());
    unawaited(_chatEvents.close());
  }
}

/// 模块订阅域：决定一条事件是否有资格投给该订阅者。
enum WsSubscribeScope {
  /// 只收**根通道资格**的事件：桌面全量；手机端只收 rootOnly / both。
  /// 与 main.dart 根监听器今天的行为完全一致（迁出分支的默认域）。
  root,

  /// 只收**聊天通道资格**的事件：仅手机端（chatOnly / both）。
  chat,

  /// 本端路由到哪里就收哪里（每端至多一次）：桌面全量；手机端
  /// chatOnly / rootOnly / both 都收——模块自己 owned 的类型无论
  /// 归属表怎么调整都归它，不再关心端差异。
  auto,
}

typedef WsEventHandler = FutureOr<void> Function(Map<String, dynamic> event);

/// 模块订阅句柄（[WsEventRouter.subscribe] 的返回值）。
///
/// 信箱语义：
/// - **串行**：同一订阅者的事件按到达顺序逐条执行，前一个 await 结束才下一条；
/// - **有界**：待执行队列上限 [maxPending]，超限丢最旧并记日志（handler 挂起
///   时不会无界堆积内存/延迟）；
/// - **可合并**：声明在 [coalesceTypes] 的类型在积压时只保留最新一条；
/// - **异常隔离**：单次失败只记日志，队列与后续事件照常推进。
class WsBusSubscription {
  WsBusSubscription._(
    this._router,
    this.module,
    this.types,
    this.onEvent,
    this.scope,
    this.coalesceTypes,
  );

  final WsEventRouter _router;
  final String module;

  /// 关心的事件类型（null = scope 语义内全量）。
  final Set<String>? types;
  final WsEventHandler onEvent;
  final WsSubscribeScope scope;

  /// 积压时可合并的事件类型（只保留最新一条）。
  final Set<String> coalesceTypes;

  /// 待执行队列上限：超限丢最旧（背压兜底，防 handler 挂起时无界增长）。
  static const int maxPending = 64;

  final List<Map<String, dynamic>> _pending = <Map<String, dynamic>>[];
  bool _draining = false;
  bool _cancelled = false;

  /// 待执行事件条数（测试/排查用）。
  @visibleForTesting
  int get pendingCount => _pending.length;

  void _enqueue(Map<String, dynamic> event) {
    if (_cancelled) return;
    final String type = event["type"] as String? ?? "";
    if (coalesceTypes.contains(type)) {
      _pending.removeWhere((Map<String, dynamic> e) => e["type"] == type);
    }
    if (_pending.length >= maxPending) {
      final Map<String, dynamic> dropped = _pending.removeAt(0);
      debugPrint(
        "[ws-router] '$module' queue full ($maxPending), "
        "dropped oldest '${dropped["type"]}'",
      );
    }
    _pending.add(event);
    if (_draining) return;
    _draining = true;
    unawaited(_drain());
  }

  Future<void> _drain() async {
    try {
      while (_pending.isNotEmpty && !_cancelled) {
        final Map<String, dynamic> event = _pending.removeAt(0);
        final String type = event["type"] as String? ?? "";
        try {
          // Future.sync：同步抛出与返回的 Future 一并纳入捕获范围。
          await Future<void>.sync(() => onEvent(event));
        } catch (e, st) {
          debugPrint(
            "[ws-router] subscriber '$module' failed on '$type': $e\n$st",
          );
        }
      }
    } finally {
      _draining = false;
    }
  }

  /// 退订（模块销毁/测试隔离用）。当前正在执行的那一条会跑完，**排队中
  /// 尚未开始的事件直接丢弃**（退订后不再产生副作用）。
  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    _pending.clear();
    _router._subscribers.remove(this);
  }
}

/// 从事件信封中取 payload 的统一入口（订阅者 handler 里用）。
Map<String, dynamic> wsEventPayload(Map<String, dynamic> event) =>
    (event["payload"] as Map?)?.cast<String, dynamic>() ??
    <String, dynamic>{};
