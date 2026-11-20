import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;
import "../core/services/nb_http.dart";
import "package:url_launcher/url_launcher.dart";

import "../app/ambient_feeds_controller.dart";
import "../app/phone_call_controller.dart";
import "../core/config/api_config.dart";
import "../core/db/isar_local_history_store.dart";
import "../core/db/local_history_store.dart";
import "../core/models/chat_models.dart";
import "../core/services/access_auth_api.dart";
import "../core/services/agent_name_store.dart";
import "../core/services/attention_api.dart";
import "../core/services/client_clock_service.dart";
import "../core/services/client_geofence_service.dart";
import "../core/services/client_location_service.dart";
import "../core/services/local_notification_service.dart";
import "../core/services/local_notification_actions.dart";
import "../core/services/tts_player.dart";
import "../core/services/ws_chat_service.dart";
import "../core/services/ws_event_router.dart";
import "../core/utils/agent_activity_label.dart";
import "../core/utils/agent_result_parser.dart";
import "../core/utils/assistant_text_sanitizer.dart";
import "../core/utils/server_history_parser.dart";
import "../core/vision/vision_wire_frame.dart";
import "../features/chat/history_media_warmer.dart";
import "../features/chat/render_envelope_dispatcher.dart"
    show extractEnvelopeBlocks;
import "../features/chat/travel_plan_launcher.dart";
import "../features/chat/travel_plan_archive.dart";

// ===== 真·分绿泡（2026-09-28）：气泡拆分消息 id 工具（与桌面端 main.dart 同构）=====
final RegExp _bubbleIdPattern = RegExp(r"^assistant-(.+)-b(\d+)$");

/// 是否为分泡消息 id（`assistant-<traceId>-bN`，服务端 BubbleTracker 分配）。
bool _isBubbleId(String messageId) => _bubbleIdPattern.hasMatch(messageId);

/// 从分泡消息 id 提取轮次 traceId；非分泡 id 返回 null。
String? _bubbleTraceOf(String messageId) =>
    _bubbleIdPattern.firstMatch(messageId)?.group(1);

/// 分泡揭示队列条目（2026-11-10）：泡完成才整泡落屏的排队单元。
class _PendingBubbleReveal {
  _PendingBubbleReveal({
    required this.bubbleId,
    required this.traceId,
    required this.sessionId,
  });

  final String bubbleId;
  final String traceId;
  final String sessionId;
}

/// 一个线程（主会话 / 某条旁聊）一轮对话的运行态（2026-11-12 P1 多会话并发）。
///
/// 此前这些状态是控制器全局单份：旁聊生成中锁死会话切换（canSwitchSession），
/// 用户必须等回复收口才能回主会话。改为按线程键各一份后，多线程可同时各跑
/// 各的 turn，流式事件按 threadId 落回各自的线程桶，切换不再被锁。
class _ThreadTurnState {
  /// Agent 是否正在该线程思考 / 生成中。
  bool processing = false;

  /// 该线程当前流式助手消息 id（占位泡锚点）。
  String? streamingMessageId;

  /// 当前正在调用的工具名（`tool.call` 置位、`tool.result`/收尾清空）。
  String? currentToolName;

  /// 服务端 `chat.agent_status` 的口语化进度。
  String? agentStatusLine;

  /// 长工具心跳推进的百分比（0-100，服务端封顶 90）。
  int? agentStatusPercent;

  /// 本轮已进入「拆解计划」阶段（v2 `chat.intent_detected` 且带 plan）。
  bool planPhase = false;

  /// 本轮已派出子 Agent（v2 且带 subAgents / agent_status delegate_start）。
  bool delegatePhase = false;

  /// 本轮首个正文 chunk 是否已到（决定「快说完了」文案）。
  bool sawChunk = false;

  /// 当前正在缓冲的分泡 id（null = 没有正在收 chunk 的泡）。
  String? activeBubbleId;

  /// 当前正在缓冲的泡所属 trace。
  String? activeBubbleTrace;

  /// 投递无响应看门狗（每线程一份：旁聊与主会话可各自在途）。
  Timer? deliveryStallTimer;
  bool deliveryStallNotified = false;

  /// 清空「正在干什么」的全部状态（不动 [deliveryStallTimer]，由调用方管理）。
  void resetActivity() {
    currentToolName = null;
    agentStatusLine = null;
    agentStatusPercent = null;
    planPhase = false;
    delegatePhase = false;
    sawChunk = false;
    processing = false;
  }
}

/// 手机端对话控制器：复用 [WsChatService] 连接与桌面端同一后端，数据/会话自动同步。
///
/// 协议(与桌面端一致)：
/// - 连接成功 → `session.init`(携带 userId/sessionId,后端按 userId 绑定 actor,两端同步)
/// - 发送 → `chat.user_message`(messageId/text/timestamp/userId/agentAccessMode)
/// - 接收 → `chat.turn_started/interim`(思考态)、`chat.assistant_chunk`(流式正文)、
///   `chat.media_ready`(边说边出图临时照片)、`chat.assistant_done`(收尾最终文本,
///   含结构化 mediaCards/renderBlocks 字段,与桌面端一致)
class MobileChatController extends ChangeNotifier {
  /// 是否跑在 flutter_test 里（框架注入 FLUTTER_TEST=true）。
  /// 测试必须自建连接：共享连接会连真实地址，把网络异步异常灌进全局流，
  /// 让本该纯内存的单测成片失败。
  static bool get _isFlutterTest =>
      !kIsWeb && Platform.environment["FLUTTER_TEST"] == "true";

  MobileChatController({String? wsBaseUrl, LocalHistoryStore? historyStore})
      : _ownsConnection = wsBaseUrl != null || _isFlutterTest {
    // 生产形态复用进程内唯一连接（WsChatService.shared）：服务端只登记一条
    // 连接，心跳/重连/在途重投只有一份。只有测试注入 wsBaseUrl / 跑在
    // flutter_test 里时才自建独立连接——否则单测会连生产地址、把异步异常
    // 灌进全局流。
    _service = _ownsConnection
        ? WsChatService(url: wsBaseUrl ?? ApiConfig.wsUrl)
        : WsChatService.shared;
    // 事件走路由器 chat 通道（ws_event_router.dart 归属表）：只收 chatOnly /
    // both，本控制器是这批业务事件的唯一 owner。测试自建连接时直连自己的事件流。
    _subscription = _ownsConnection
        ? _service.events.listen(_onWsEvent)
        : WsEventRouter.instance.chatEvents.listen(_onWsEvent);
    // 【订阅后同步连接状态】（2026-11-10「连接一直断开」误报根修）
    // shared 连接在 app 启动早期就建立（main.dart _bootstrap），`ws_connected`
    // 是一次性事件——发出时 chat 通道往往还没有监听者，被路由器的
    // no-listener 保护丢弃；错过这一次，本控制器 isConnected 永久 false，
    // 聊天页显示「已断开」而实际连接健康（服务端视角零重连）。与桌面端
    // main.dart `if (_ws.isConnected) _onWsConnected()` 同款补丁：订阅后
    // 立即查询一次，已连则本地重放 ws_connected（补定位/时钟/围栏装配）。
    if (!_ownsConnection && _service.isConnected) {
      _onWsEvent(<String, dynamic>{
        "type": "ws_connected",
        "payload": <String, dynamic>{
          "connectedAt": DateTime.now().toIso8601String(),
          "replayed": true,
        },
      });
    }
    _service.connect();
    _store = historyStore ?? IsarLocalHistoryStore(userPin: ApiConfig.localPin);
    unawaited(_bootstrapHistory());
  }

  /// 是否自持连接：仅测试注入 `wsBaseUrl` 时为 true。共享连接归进程所有，
  /// 控制器销毁时只解订阅，绝不 close（否则根状态的闹钟/提醒链路一起断）。
  final bool _ownsConnection;
  late final WsChatService _service;
  StreamSubscription? _subscription;

  /// 本地历史存储（聊天气泡落盘，重启后恢复；测试可注入内存实现）。
  late final LocalHistoryStore _store;

  /// 服务端线程历史拉取去重闸（每个线程只拉一次）。
  final Set<String> _serverHistoryPulled = <String>{};

  /// 是否已连上过一次（区分首连与重连：重连要做漏消息对账，见 ws_connected）。
  bool _everConnected = false;

  /// 对话历史(含正在流式生成的助手消息)。
  ///
  /// 2026-11-07 旁聊：每个线程（主会话 / 各个旁聊）各自一份消息列表，
  /// [messages] 永远指向当前激活线程，切换会话只切指针、不搬消息。
  final Map<String, List<ChatMessage>> _sessionMessages =
      <String, List<ChatMessage>>{};

  /// 主会话本地线程键（服务端主线程 = 裸 actorId）。
  String get _mainSessionKey => ApiConfig.effectiveActorId;

  /// 主会话线程的消息桶（主动消息落流的唯一去处）。
  List<ChatMessage> get _mainThreadMessages =>
      _sessionMessages.putIfAbsent(_mainSessionKey, () => <ChatMessage>[]);

  List<ChatMessage> get messages => _sessionMessages.putIfAbsent(
        _activeSessionKey,
        () => <ChatMessage>[],
      );

  /// 手机端聊天内联规划流（null = 未在规划）。
  ///
  /// 2026-11-14：手机端不再跳转 TravelPlanArchivePage，命中规划意图后
  /// 在聊天流末尾内联渲染 plan-session 问答流（与桌面共用状态机）。
  TravelPlanFlowController? _planFlow;
  TravelPlanFlowController? get planFlow => _planFlow;
  bool get isPlanFlowActive => _planFlow != null && !_planFlow!.completed;
  int _planFlowRevision = 0;

  /// 内联规划流每次状态变化自增：聊天页据此保持贴底。
  int get planFlowRevision => _planFlowRevision;

  /// 发起内联规划流：seed 原话由 controller 发起 plan-session。
  void _startPlanFlow(String seed) {
    _planFlow?.removeListener(_onPlanFlowChanged);
    _planFlow?.dispose();
    final TravelPlanFlowController flow = TravelPlanFlowController();
    flow.addListener(_onPlanFlowChanged);
    _planFlow = flow;
    unawaited(flow.start(seed));
    notifyListeners();
  }

  void _onPlanFlowChanged() {
    _planFlowRevision++;
    notifyListeners();
  }

  /// 关闭内联规划流（「结束规划」/ 会话销毁）：聊天恢复普通发送。
  void closePlanFlow() {
    final TravelPlanFlowController? flow = _planFlow;
    if (flow == null) return;
    flow.removeListener(_onPlanFlowChanged);
    flow.dispose();
    _planFlow = null;
    notifyListeners();
  }

  /// 规划会话中的用户话术：进聊天气泡（本地留存），不进 WS。
  ChatMessage _appendPlanUserMessage(String text) {
    final ChatMessage m = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _activeSessionKey,
      role: "user",
      text: text,
      timestamp: DateTime.now(),
    );
    messages.add(m);
    _settleNameCards();
    notifyListeners();
    return m;
  }

  /// 当前激活会话的本地线程键（主会话 = actorId；旁聊 = `side:<actor>:<id>`）。
  String _activeSessionKey = ApiConfig.effectiveActorId;

  /// 当前激活会话发给服务端的 sessionId（主会话用连接级 sessionId）。
  String _activeServerSessionId = ApiConfig.effectiveActorId;

  /// 当前旁聊 id（null = 主会话）。
  String? _activeSideSessionId;

  /// 当前旁聊标题（顶栏展示）。
  String? _activeSideTitle;

  /// 当前是否处于旁聊（独立上下文）。
  bool get isSideChatActive => _activeSideSessionId != null;

  /// 当前旁聊线程键（null = 主会话）。
  String? get activeSideSessionId => _activeSideSessionId;

  /// 当前旁聊标题（null = 主会话）。
  String? get activeSideTitle => _activeSideTitle;

  // ===== 线程级 turn 运行态（2026-11-12 P1 多会话并发）=====
  //
  // 每个线程键（主会话 = actorId；旁聊 = `side:<actor>:<id>`）一份
  // [_ThreadTurnState]：流式占位 / 工具状态 / 处理中标志全部随线程走。
  // 服务端 turn 级载荷带 threadId（2026-11-12 起），事件按它落回正确线程；
  // 旧服务端缺省时退回当前激活线程（与旧行为一致）。

  final Map<String, _ThreadTurnState> _turnStates = <String, _ThreadTurnState>{};

  _ThreadTurnState _turnOf(String key) =>
      _turnStates.putIfAbsent(key, _ThreadTurnState.new);

  /// 当前激活线程的 turn 运行态。
  _ThreadTurnState get _turn => _turnOf(_activeSessionKey);

  /// 当前激活线程正在调用的工具名（状态球用）。
  String? get currentToolName => _turn.currentToolName;

  /// 当前激活线程的长工具心跳百分比（状态球用）。
  int? get agentStatusPercent => _turn.agentStatusPercent;

  /// 当前激活线程是否正在生成（UI 状态条 / 滚动判断用）。
  bool get isProcessing => _turn.processing;

  /// 是否允许切换会话：多会话并发后恒为 true——流式事件按 threadId 落回
  /// 各自线程，切换不再有串线程风险（2026-11-12 P1 根治）。
  bool get canSwitchSession => true;

  // ===== Agent 浏览器工作悬浮窗（2026-11-12）=====
  //
  // 手机端没有可见内置浏览器（WebView2 仅 Windows）：agent_browser 在服务端
  // 无头 Chromium 里执行，每步动作后经 `agent.browser.preview` 推页面截图。
  // 浏览器族工具（agent_browser / shared_browser / browser.*）的 tool.call
  // 先点亮悬浮窗（首帧未到时显示「正在打开浏览器」），任务收口/出错时熄灭。

  /// 浏览器任务进行中（悬浮窗开关；预览帧全局唯一，后到的帧覆盖前一帧）。
  bool _browserTaskActive = false;

  /// 用户手动关闭后不再自动弹出（直到下一个浏览器任务重新点亮）。
  bool _browserPreviewDismissed = false;

  /// 最近一帧页面截图（JPEG base64；null = 尚未收到帧）。
  String? browserPreviewImage;

  /// 最近一帧对应的页面 URL（悬浮窗脚注）。
  String? browserPreviewUrl;

  /// 最近一帧对应的动作名（open/click/type/scroll/wait_for/screenshot）。
  String? browserPreviewAction;

  /// 最后一帧到达后多久自动熄灭（毫秒）。
  ///
  /// 2026-11-19 用户要求：「浏览器框要到最后信息给出再关闭，不要一 handoff
  /// 就关」。服务的显式 `action=end` 帧是主关闭信号；这个无帧 TTL 只是兜底
  /// （连接半断、服务端没来得及补 end 时不至于永久挂着一个死窗口）。
  ///
  /// 2026-11-20：4.5s 太短——留驻等扫码的登录页画面本就静止，帧间隔放宽到
  /// 数秒，且用户中途发消息时旧回合收口，稍一停顿窗口就没了。兜底拉长到
  /// 60s，真正关闭靠服务端页面释放时推的 end 帧。
  static const Duration _browserPreviewIdleTtl = Duration(seconds: 60);
  Timer? _browserPreviewIdleTimer;

  /// 仍在推流的浏览器会话 id（服务端每张页面一个）。
  ///
  /// 关闭按会话计：多平台登录时几家登录页同时留驻，先登录成功的那家收起
  /// 自己的流不能把还开着的另一家一起关掉。
  final Set<String> _browserPreviewSessions = <String>{};

  /// 右上角悬浮窗是否可见：浏览器任务进行中且未被用户手动关掉。
  bool get browserPreviewVisible =>
      _browserTaskActive && !_browserPreviewDismissed;

  /// 用户点悬浮窗关闭：只藏 UI，不中断任务；下一个浏览器任务会重新点亮。
  void dismissBrowserPreview() {
    if (!_browserPreviewDismissed) {
      _browserPreviewDismissed = true;
      notifyListeners();
    }
  }

  /// 工具名是否属于「会真开云端浏览器」的族（悬浮窗触发面）。
  ///
  /// 2026-11-14 扩到购物族：比价/搜索/下单/查单同样在服务端无头 Chromium 里跑，
  /// 手机端没有可见浏览器，也只能靠这个悬浮窗呈现 Agent 的工作画面。
  /// 纯数据动作不点亮（否则窗口会一直停在「正在打开浏览器」的占位态）：
  /// - `shopping.compare` 只有 prices/research 真开页面，watch_* 只是本地监控；
  /// - `shopping.order.list`、`shopping.pay.submit`、`shopping.suggest` 不开云端页面。
  static const Set<String> _cloudBrowserShoppingTools = <String>{
    "shopping.order.search",
    "shopping.order.place",
    "shopping.order.track",
    "shopping.order.cancel",
    "shopping.pay.check",
  };

  /// 工具入参没有 action 字段时，悬浮窗标题用的动作兜底（别让上一把工具的
  /// 动作名串到这一把上）。
  static const Map<String, String> _toolDefaultPreviewAction = <String, String>{
    "shopping.order.search": "search",
    "shopping.order.place": "place",
    "shopping.order.track": "track",
    "shopping.order.cancel": "cancel",
    "shopping.pay.check": "check",
    "browser.fetch_page": "open",
  };

  static bool _toolUsesCloudBrowser(String name, Object? input) {
    final String t = name.trim().toLowerCase();
    if (t.startsWith("agent_browser") || t.startsWith("shared_browser")) return true;
    if (t == "shopping.compare") {
      final String action =
          input is Map ? (input["action"]?.toString().trim().toLowerCase() ?? "") : "";
      // 缺省（模型不填 action）就是真去开页面比价：不点亮会让整轮比价
      // 完全没有画面（用户以为「浏览器没启动」）。只有 watch_* 是纯本地。
      if (action.isEmpty) return true;
      return action == "prices" || action == "research";
    }
    if (_cloudBrowserShoppingTools.contains(t)) return true;
    // browser.* 里只有 browser.session.list 是纯本地查询，不开页面。
    if (t.startsWith("browser")) return t != "browser.session.list";
    return false;
  }

  /// agent.browser.preview：服务端推来的页面画面帧。
  ///
  /// [action] 有两种来源：具体动作名（open/click/type/…，随动作回执推）和
  /// "stream"（CDP screencast 连续帧）。stream 帧只更新画面，动作短句保留
  /// 最近一个真实动作——标题条永远描述「在做哪一步」而不是「在推流」。
  ///
  /// "end"（2026-11-20）：服务端页面真正释放时补发，按 browserSessionId 摘掉
  /// 对应会话；最后一个会话结束才熄灭悬浮窗——多平台同时留驻时不会被先结束
  /// 的那一家提前关掉。
  void _handleBrowserPreview(Map<String, dynamic> payload) {
    final String action = payload["action"]?.toString() ?? "";
    final String sid = payload["browserSessionId"]?.toString().trim() ?? "";
    if (action == "end") {
      if (sid.isNotEmpty) {
        _browserPreviewSessions.remove(sid);
        if (_browserPreviewSessions.isNotEmpty) {
          _armBrowserPreviewIdleTtl();
          notifyListeners();
          return;
        }
      } else {
        _browserPreviewSessions.clear();
      }
      _extinguishBrowserPreview();
      return;
    }
    final String img = payload["imageBase64"]?.toString() ?? "";
    if (img.isEmpty) return;
    browserPreviewImage = img;
    browserPreviewUrl = payload["url"]?.toString();
    if (action.isNotEmpty && action != "stream") browserPreviewAction = action;
    // 新会话重新点亮（用户此前点 × 关掉后，只有新任务能再弹出来）；
    // 同一会话的后续帧不覆盖用户的关闭决定。
    final bool newSession = sid.isNotEmpty && !_browserPreviewSessions.contains(sid);
    if (sid.isNotEmpty) _browserPreviewSessions.add(sid);
    _browserTaskActive = true;
    if (newSession) _browserPreviewDismissed = false;
    _armBrowserPreviewIdleTtl();
    notifyListeners();
  }

  /// 兜底熄灭：连续 [_browserPreviewIdleTtl] 没有新帧才算任务真的结束。
  void _armBrowserPreviewIdleTtl() {
    _browserPreviewIdleTimer?.cancel();
    _browserPreviewIdleTimer = Timer(_browserPreviewIdleTtl, () {
      _browserPreviewIdleTimer = null;
      _extinguishBrowserPreview();
    });
  }

  /// 熄灭浏览器悬浮窗（无帧兜底 / 用户手动关 / 全部会话结束）。
  void _extinguishBrowserPreview() {
    _browserPreviewIdleTimer?.cancel();
    _browserPreviewIdleTimer = null;
    _browserPreviewSessions.clear();
    if (!_browserTaskActive && !_browserPreviewDismissed) return;
    _browserTaskActive = false;
    _browserPreviewDismissed = false;
    notifyListeners();
  }

  /// 服务端 turn 级载荷的归属线程键；旧服务端无 threadId 时退回激活线程。
  String _threadKeyOf(Map<String, dynamic> payload) {
    final String t = payload["threadId"]?.toString() ?? "";
    return t.isNotEmpty ? t : _activeSessionKey;
  }

  /// traceId → 线程键：turn_started / chunk 首到时登记，错误帧按 trace 归位。
  final Map<String, String> _traceThread = <String, String>{};

  void _rememberTraceThread(String? traceId, String threadKey) {
    if (traceId == null || traceId.isEmpty) return;
    _traceThread[traceId] = threadKey;
    if (_traceThread.length > 200) {
      _traceThread.remove(_traceThread.keys.first);
    }
  }

  /// 进入旁聊（独立线程）：切到该线程的消息桶 → 恢复本地历史 → 拉服务端线程历史。
  Future<bool> enterSideChat({required String sessionId}) async {
    if (sessionId.trim().isEmpty || sessionId == _activeSessionKey) return true;
    _activateSession(
      sessionId.trim(),
      serverSessionId: sessionId.trim(),
      sideSessionId: sessionId.trim(),
    );
    notifyListeners();
    await _loadSessionHistory(sessionId.trim());
    return true;
  }

  /// 删除旁聊后清本地痕迹：服务端线程已由 DELETE 清空，本地 store / 内存桶
  /// 也要同步移除；若删的是当前旁聊则先退回主会话。
  Future<void> forgetSideChat(String sessionId) async {
    if (sessionId.trim().isEmpty) return;
    if (_activeSessionKey == sessionId) {
      await returnToMain();
    }
    _sessionMessages.remove(sessionId);
    _serverHistoryPulled.remove(sessionId);
    try {
      await _store.deleteMessagesForSession(sessionId);
    } catch (e) {
      debugPrint("[MobileChatController] 删除旁聊本地历史失败: $e");
    }
    notifyListeners();
  }

  /// 旁聊标题变化（列表重命名后同步顶栏）。
  void setActiveSideTitle(String? title) {
    _activeSideTitle = (title ?? "").trim().isEmpty ? null : title!.trim();
    notifyListeners();
  }

  /// 回到主会话（主线程消息原样保留）。
  Future<void> returnToMain() async {
    if (_activeSessionKey == _mainSessionKey) return;
    _activateSession(_mainSessionKey, serverSessionId: ApiConfig.effectiveActorId);
    notifyListeners();
    await _loadSessionHistory(_mainSessionKey);
  }

  void _activateSession(
    String key, {
    required String serverSessionId,
    String? sideSessionId,
  }) {
    _activeSessionKey = key;
    _activeServerSessionId = serverSessionId;
    _activeSideSessionId = sideSessionId;
    _activeSideTitle = null;
    // 线程级运行态不再清（2026-11-12 P1）：各线程的流式占位 / 处理中标志
    // 随线程持久，切走再切回来 UI 状态无缝续显。旧服务端未带 threadId 的
    // 事件仍按 _threadKeyOf 退回激活线程，与旧行为一致。
    notifyListeners();
  }

  /// Agent 是否正在思考 / 生成中 —— 见 [_ThreadTurnState.processing]（按线程隔离）。

  /// 连接状态文案(用于顶栏状态点)。
  bool isConnected = false;

  /// 连接状态通知器(「我的」页账号卡监听展示在线/离线)。
  final ValueNotifier<bool> connection = ValueNotifier<bool>(false);

  /// 底层 WS 服务(邮箱页等同源复用,避免双连接)。
  WsChatService get service => _service;

  /// 错误提示(轻提示用)。
  String? errorMessage;

  /// 错误提示自动消失定时器：报错条只临时展示，不再常驻输入框上方
  /// （此前「单帧超过 4194304 字节」这类原始报错会一直挂着）。
  Timer? _errorHintClearTimer;

  // ===== 分泡逐泡揭示（2026-11-10）：打字机下线后的新节奏 =====
  //
  // 分泡轮的流式 chunk 不再直接进 messages 打字，而是先攒进缓冲；
  // 泡完成（下一泡开 / done 收口）才入揭示队列，由定时器按固定间隔
  // 逐泡整条弹出——观感是助手像真人一样一条一条发消息，泡与泡之间
  // 有停顿，而不是第一泡打字机、第二泡瞬发。

  /// 两条揭示泡之间的最小间隔。
  // 逐条弹的节奏（2026-11-19 用户：「要一条一条弹出，不要一下全部发送」）：
  // 工具轮收口时两条信息常在 done 帧同时到，600ms 在真机上几乎看不出先后；
  // 拉到 850ms 才有「一句话说完再接下一句」的对话感。
  static const Duration _bubbleRevealGap = Duration(milliseconds: 850);

  /// 待揭示泡队列条目：泡 id + 所属 trace + 落屏目标会话（中途切会话时
  /// 泡仍落回它自己的线程，不窜到当前激活会话）。
  ///
  /// 定义在 MobileChatController 之外（库私有顶层），避免 this 绑定问题。
  final List<_PendingBubbleReveal> _revealQueue = <_PendingBubbleReveal>[];

  /// 流式中未落屏的泡正文缓冲（bubbleId -> 已缓冲正文）。
  final Map<String, String> _bubbleBuffers = <String, String>{};

  /// 泡首次 chunk 到达时所在的会话线程键（揭示时按它落屏）。
  final Map<String, String> _bubbleSessionOf = <String, String>{};

  /// done 对账下发的最终文本覆盖（揭示时优先于缓冲文本）。
  final Map<String, String> _revealFinalText = <String, String>{};

  /// done 对账下发的末泡附件（mediaCards/summaryCard/块序列/followups）。
  final Map<String, Map<String, dynamic>> _revealAttachments =
      <String, Map<String, dynamic>>{};

  /// 当前正在缓冲的泡 id / trace —— 已并入各线程的 [_ThreadTurnState]
  /// （activeBubbleId / activeBubbleTrace），按线程隔离（2026-11-12 P1）。

  /// 揭示定时器与上一泡揭示时刻（实现泡间最小间隔）。
  Timer? _revealTimer;
  DateTime _lastBubbleRevealAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 输入框上方状态条要显示的文案；`null` = 当前没在干活，条不显示。
  ///
  /// 裁决逻辑见 `core/utils/agent_activity_label.dart`：工具族映射优先，
  /// 服务端口语化进度补位，最后按阶段兜底——保证任何任务都有话可说。
  /// 只反映**当前激活线程**的运行态（其他线程各自维护一份）。
  String? get activityLabel {
    final String tool = _turn.currentToolName?.trim() ?? "";
    final bool hasLive = (_turn.agentStatusLine?.trim().isNotEmpty ?? false);
    if (!_turn.processing && tool.isEmpty && !hasLive) return null;
    return resolveAgentActivityLabel(
      toolName: tool,
      liveLine: _turn.agentStatusLine,
      planning: _turn.planPhase,
      delegating: _turn.delegatePhase,
      streaming: _turn.sawChunk,
    );
  }

  /// 清空指定线程「正在干什么」的全部状态（工具名 / 口语化进度 / 百分比 / 阶段）。
  void _resetActivityState(String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    t.deliveryStallTimer?.cancel();
    t.deliveryStallTimer = null;
    t.deliveryStallNotified = false;
    t.resetActivity();
    // 注意（2026-11-19）：这里**不再**熄灭浏览器悬浮窗。工具轮收口时登录页
    // 往往还停在浏览器里等用户扫码（服务端继续推流），一收口就关会让用户
    // 在扫码期间看不到任何画面。改为「无帧 4.5s 自动熄灭」。
  }

  /// 离线补发进行中闸（防 ws_connected 风暴期间并发 flush 乱序重复发送）。
  bool _flushingPending = false;

  /// 投递无响应的看门狗（UI 侧）：发出后长时间连协议级 ack 都没回来，
  /// 界面必须从「我看看」切到一句能解释的话，而不是无限转圈。
  /// 每线程一份（2026-11-12 P1）：旁聊与主会话可各自在途互不干扰。
  static const String _deliveryStallHint = "网络似乎不太顺，正在自动重试…";
  /// 服务端拒收后的过渡提示（连接层正在补发 session.init 并重投）。
  static const String _identityResyncHint = "正在重新同步账号身份，消息会自动重发…";

  void _armDeliveryStallWatch(String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    t.deliveryStallTimer?.cancel();
    t.deliveryStallNotified = false;
    t.deliveryStallTimer = Timer(const Duration(seconds: 12), () {
      if (!t.processing || t.sawChunk) return;
      t.deliveryStallNotified = true;
      errorMessage = _deliveryStallHint;
      notifyListeners();
    });
  }

  void _clearDeliveryStallWatch() {
    // 入站事件说明链路有回应：清掉当前激活线程的看门狗即可；
    // 其他线程的看门狗由各自线程的入站事件 / 收口负责。
    final _ThreadTurnState t = _turn;
    t.deliveryStallTimer?.cancel();
    t.deliveryStallTimer = null;
    if (t.deliveryStallNotified) {
      t.deliveryStallNotified = false;
      if (errorMessage == _deliveryStallHint) errorMessage = null;
    }
  }

  /// 时区变化侦测定时器（15 分钟）。
  ///
  /// 只是一次内存比对（读系统时区 + `DateTime.timeZoneOffset`），不触发定位、
  /// 不联网，耗电可忽略。真正兜底的是「每条消息随行带 clientClock」，这个
  /// 定时器只覆盖「用户长时间不发消息但 Agent 会主动说话」的场景。
  Timer? _clockWatchTimer;

  /// 打开一个新会话：仅清空本地内存，仍连接同一后端。
  void reset() {
    messages.clear();
    for (final _ThreadTurnState t in _turnStates.values) {
      t.deliveryStallTimer?.cancel();
      t.deliveryStallTimer = null;
      t.resetActivity();
      t.streamingMessageId = null;
      t.activeBubbleId = null;
      t.activeBubbleTrace = null;
    }
    _traceThread.clear();
    _discardRevealState();
    notifyListeners();
  }

  /// 清空分泡揭示的全部状态（缓冲 / 队列 / 附件 / 活跃泡）。
  void _discardRevealState() {
    _revealTimer?.cancel();
    _revealTimer = null;
    _revealQueue.clear();
    _bubbleBuffers.clear();
    _bubbleSessionOf.clear();
    _revealFinalText.clear();
    _revealAttachments.clear();
    for (final _ThreadTurnState t in _turnStates.values) {
      t.activeBubbleId = null;
      t.activeBubbleTrace = null;
    }
  }

  // ===== 聊天历史持久化（2026-10-08）：本地落盘 + 服务端线程漫游回填 =====

  /// 启动加载：本地 store 恢复历史 → 再拉服务端线程回填跨端消息。
  /// 全程静默容错（存储不可写/网络不可达都只降级为内存态，不阻塞聊天）。
  Future<void> _bootstrapHistory() async {
    try {
      await _store.init();
      try {
        await _store.saveSession(ChatSession(
          sessionId: _activeSessionKey,
          title: "默认会话",
          createdAt: DateTime.now(),
        ));
      } catch (_) {
        // 会话头写失败不影响消息恢复
      }
      final List<ChatMessage> loaded =
          await _store.listMessages(ApiConfig.effectiveActorId);
      // recap 回显过滤（2026-10-12）：本地库已落盘的「摘要整块复述」气泡在加载层
      // 剔除（非破坏性——store 数据不动，仅不再显示）。与服务端 isRecapEchoText 同判据。
      final List<ChatMessage> visible = loaded
          .where((m) =>
              m.role != "assistant" ||
              stripRecapEchoBlocks(m.text).trim().isNotEmpty)
          .toList();
      if (visible.isNotEmpty) {
        _mergeLoadedMessages(visible);
        notifyListeners();
        // 冷启动媒体预热（2026-10-12 预缓存）：历史照片提前并发落盘到磁盘
        // 缓存，滚到对应消息直接命中秒出——这是「重开后照片要重新缓存一段
        // 时间」问题的根治半边（渲染端已统一走 CachedMediaImage）。
        _warmHistoryMedia(visible);
      }
    } catch (e) {
      debugPrint("[MobileChatController] 本地历史加载失败(降级内存态): $e");
    }
    unawaited(_pullServerHistory());
  }

  /// 当前会话历史加载（本地 store → 服务端线程回填）；已加载过的线程直接跳过。
  Future<void> _loadSessionHistory(String key) async {
    final List<ChatMessage> bucket = _sessionMessages.putIfAbsent(
      key,
      () => <ChatMessage>[],
    );
    if (bucket.isEmpty) {
      try {
        final List<ChatMessage> loaded = await _store.listMessages(key);
        final List<ChatMessage> visible = loaded
            .where((m) =>
                m.role != "assistant" ||
                stripRecapEchoBlocks(m.text).trim().isNotEmpty)
            .toList();
        if (visible.isNotEmpty) {
          if (bucket.isEmpty) {
            bucket.addAll(visible);
          } else {
            final Set<String> memoryIds =
                bucket.map((m) => m.messageId).toSet();
            bucket.insertAll(
              0,
              visible.where((m) => !memoryIds.contains(m.messageId)).toList(),
            );
          }
          if (_activeSessionKey == key) notifyListeners();
          _warmHistoryMedia(visible);
        }
      } catch (e) {
        debugPrint("[MobileChatController] 线程本地历史加载失败: $e");
      }
    }
    await _pullServerHistoryFor(key);
  }

  /// 把本地加载的历史并入内存：无内存消息直接铺入；已有消息（加载期间
  /// 用户已发消息的竞态窗口）按 messageId 去重后前置旧消息，保序不覆盖。
  void _mergeLoadedMessages(List<ChatMessage> loaded) {
    final List<ChatMessage> target = messages;
    if (target.isEmpty) {
      target.addAll(loaded);
      return;
    }
    final Set<String> memoryIds = target.map((m) => m.messageId).toSet();
    final List<ChatMessage> older =
        loaded.where((m) => !memoryIds.contains(m.messageId)).toList();
    if (older.isEmpty) return;
    target.insertAll(0, older);
  }

  /// 冷启动媒体预热：收集历史消息里全部媒体卡地址（mediaCards / renderBlocks
  /// 媒体块 / 瞬态 pendingMediaCards），归一为绝对 URL 后交给磁盘缓存有界
  /// 并发预热。全程静默，不阻塞聊天恢复。
  ///
  /// 实现已抽到 [warmChatHistoryMedia]，与桌面端 main.dart 启动恢复共用同一份
  /// 采集口径（2026-11-12：桌面端此前完全没有预热，冷启动历史照片全靠现下）。
  void _warmHistoryMedia(List<ChatMessage> msgs) {
    warmChatHistoryMedia(msgs);
  }

  /// 卡片就地更新（card.update）——把服务端回传的新卡写回**同一条消息**。
  ///
  /// 为什么改 text 标记而不是另存一份卡片对象：客户端的历史回放、复制、落盘
  /// 都以 text 里的 [AGENT_RESULT_CARD_START] 块为唯一真相源。只替换标记块，
  /// 当轮显示、重启后回放、复制出的文本三处同时一致，不需要第四份状态。
  void _applyCardUpdate(Map<String, dynamic> payload) {
    final String messageId = (payload["messageId"] ?? "").toString();
    if (messageId.isEmpty) return;
    final int idx =
        messages.indexWhere((ChatMessage m) => m.messageId == messageId);
    if (idx < 0) return;
    final ChatMessage msg = messages[idx];
    final Object? card = payload["card"];
    if (card is! Map) {
      // 服务端明确报错：卡片停在原态，只用一条提示告知，不伪造新卡
      final String err = (payload["error"] ?? "").toString().trim();
      if (err.isNotEmpty) {
        errorMessage = _friendlyErrorText(err);
        _armErrorHintAutoClear();
        notifyListeners();
      }
      return;
    }
    final Map<String, dynamic> cardMap = Map<String, dynamic>.from(card);
    final String block =
        "[AGENT_RESULT_CARD_START]\n${jsonEncode(cardMap)}\n[AGENT_RESULT_CARD_END]";
    final RegExp marker =
        RegExp(r"\[AGENT_RESULT_CARD_START\][\s\S]*?\[AGENT_RESULT_CARD_END\]");
    // text 是气泡正文，卡只活在结构化块（envelopeBlocks/replyBlocks/
    // renderBlocks）里。无标记块时**绝不**把卡 JSON 追加进 text：分泡轮的信封
    // 没有 text 块，渲染层只能回退直读 text——写进去标记和 JSON 就整块漏进
    // 气泡（2026-11-15 删除提醒后卡片原地变「已取消」即此形态）。
    // 唯一例外是历史消息的 text 本身携带标记块：原位换新，保持文本投影同步。
    final String nextText =
        marker.hasMatch(msg.text) ? msg.text.replaceFirst(marker, block) : msg.text;
    final ChatMessage replaced = msg.copyWith(
      text: nextText,
      renderBlocks: msg.renderBlocks == null
          ? null
          : _swapCardBlock(msg.renderBlocks!, cardMap),
      replyBlocks: msg.replyBlocks == null
          ? null
          : _swapCardBlock(msg.replyBlocks!, cardMap),
      // v2 信封块（P4）：同一张卡的三条视图同步换新，渲染层信封优先才不会
      // 把旧态卡再画回来。
      envelopeBlocks: msg.envelopeBlocks == null
          ? null
          : _swapCardBlock(msg.envelopeBlocks!, cardMap),
    );
    messages[idx] = replaced;
    _persist(replaced);
    notifyListeners();
  }

  /// 把块序列里的第一张卡换成新卡；没有卡块就补在末尾（保序，不动文字/媒体）。
  List<Map<String, dynamic>> _swapCardBlock(
    List<Map<String, dynamic>> blocks,
    Map<String, dynamic> card,
  ) {
    final List<Map<String, dynamic>> next = <Map<String, dynamic>>[];
    bool swapped = false;
    for (final Map<String, dynamic> b in blocks) {
      if (!swapped && (b["type"]?.toString() ?? "") == "card") {
        next.add(<String, dynamic>{"type": "card", "card": card});
        swapped = true;
      } else {
        next.add(b);
      }
    }
    if (!swapped) next.add(<String, dynamic>{"type": "card", "card": card});
    return next;
  }

  /// 取名卡挂载（onboarding.name_choices）：服务端只给候选名与抬头，卡片归属
  /// 是本轮最后一条回复气泡（messageId 命中）。开场白第二泡还在排队等揭示时
  /// 卡会先到——先暂存，气泡落屏那一刻再补挂（见 [_attachPendingNameCard]）。
  void _applyNameChoices(Map<String, dynamic> payload) {
    final String messageId = (payload["messageId"] ?? "").toString();
    if (messageId.isEmpty) return;
    final int idx =
        messages.indexWhere((ChatMessage m) => m.messageId == messageId);
    if (idx < 0) {
      // 泡还没揭示（首启引导依次到达）：暂存，等它落屏再挂。
      if (_introQueue.any((ChatMessage q) => q.messageId == messageId)) {
        _pendingNameCards[messageId] = payload;
      }
      return;
    }
    final List<String> choices =
        (payload["choices"] as List<dynamic>? ?? const <dynamic>[])
            .map((Object? e) => (e ?? "").toString().trim())
            .where((String e) => e.isNotEmpty)
            .toList(growable: false);
    if (choices.isEmpty) return;
    messages[idx] = messages[idx].copyWith(
      nameChoices: choices,
      nameCardTitle: (payload["title"] ?? "").toString(),
    );
    // 落盘 + 立即刷新：开场白取名卡随主动消息下发时，后续没有 done 帧
    // 触发重建，不主动 notify 用户要等下一次交互才能看到卡。
    _persist(messages[idx]);
    notifyListeners();
  }

  /// 早到没处挂的取名卡（第二泡还在排队时先到）：气泡落屏那一刻补挂。
  void _attachPendingNameCard(String messageId) {
    final Map<String, dynamic>? payload = _pendingNameCards.remove(messageId);
    if (payload == null) return;
    _applyNameChoices(payload);
  }

  /// 用户一开口（点选候选名或自己打字）就收起取名卡：答复已发出，卡不再有效。
  /// 仍在排队的卡一并丢弃，避免用户说完名字后又冒出一张过期的卡。
  void _settleNameCards() {
    _pendingNameCards.clear();
    for (int i = 0; i < messages.length; i++) {
      final ChatMessage m = messages[i];
      if (m.nameChoices == null || m.nameChoices!.isEmpty) continue;
      messages[i] = m.copyWith(nameChoices: const <String>[]);
    }
  }

  /// 消息落盘（fire-and-forget；失败静默，聊天主链路绝不因存储阻塞）。
  void _persist(ChatMessage message) {
    unawaited(
      _store.saveMessage(message).catchError((Object e) {
        debugPrint("[MobileChatController] 消息落盘失败: $e");
      }),
    );
  }

  /// 服务端线程历史拉取：主会话走 WAL 全量（`full=1`），旁聊走 `sessionId=`
  /// 指定的独立线程（服务端只读该线程最近一段）。按 user 锚去重后落本地。
  Future<int> _pullServerHistoryFor(String key) async {
    if (_serverHistoryPulled.contains(key)) return 0;
    _serverHistoryPulled.add(key);
    final bool isSide = key.startsWith("side:");
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/chat-data/history")
          .replace(queryParameters: <String, String>{
        "userId": ApiConfig.effectiveActorId,
        "limit": "200",
        if (isSide) "sessionId": key else "full": "1",
      });
      final http.Response res = await NbHttp.get(uri,
              headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return 0;
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      // 旁聊历史必须严格属于请求的会话键。服务端一旦把请求钉到别的线程
      // （周界身份改写 / 路由缺陷），合并进来的就是主会话历史，且
      // _mergeServerTurnsFor 会逐条 _persist 落盘，污染会永久留在这条旁聊里。
      // 宁可本次不回填，也不能把别人的对话写进新会话（2026-11-11 回归）。
      final String returnedSessionId = body["sessionId"]?.toString() ?? "";
      if (isSide && returnedSessionId != key) {
        debugPrint(
          "[MobileChatController] 旁聊历史响应 sessionId 不匹配，丢弃: "
          "expected=$key actual=$returnedSessionId",
        );
        return 0;
      }
      final List<dynamic> raw = body["messages"] as List<dynamic>? ?? const [];
      // 载荷解析走共享纯函数（2026-11-13）：与桌面端 main.dart 同一份实现，
      // 真·分绿泡轮逐泡建消息，重装后历史形态与当轮实时一致。
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: raw,
        sessionKey: key,
      );
      final List<ChatMessage> incoming = parsed.messages;
      // 分泡重建消息的 id 集合，供 _mergeServerTurnsFor 调整去重口径
      // （同文分泡是刻意形态，不互相吞并）。
      final Set<String> bubbleBackfillIds = <String>{
        for (int i = 0; i < incoming.length; i++)
          if (parsed.fromBubbles[i]) incoming[i].messageId,
      };
      if (incoming.isEmpty) return 0;
      return _mergeServerTurnsFor(
        key,
        incoming,
        bubbleBackfillIds: bubbleBackfillIds,
      );
    } catch (e) {
      debugPrint("[MobileChatController] 服务端历史拉取失败(跳过回填): $e");
      return 0;
    }
  }

  /// 兼容入口：主会话首次启动加载；重连对账复用（返回回填条数）。
  Future<int> _pullServerHistory() => _pullServerHistoryFor(_mainSessionKey);

  /// 重连对账：补拉服务端历史并回填漏掉的轮次；App 在后台时把漏收的
  /// 回复/主动消息按最后一条补系统通知（横幅触达）。
  Future<void> _reconcileAfterReconnect() async {
    final int backfilled = await _pullServerHistory();
    if (backfilled <= 0) return;
    debugPrint("[MobileChatController] 重连对账回填 $backfilled 条漏收消息");
    if (!_appBackgrounded) return;
    final List<ChatMessage> list = _sessionMessages[_mainSessionKey] ??
        const <ChatMessage>[];
    for (final ChatMessage m in list.reversed) {
      if (m.role == "assistant" && m.text.trim().isNotEmpty) {
        unawaited(LocalNotificationService.show(
            title: "有新消息", body: m.text.trim()));
        break;
      }
    }
  }

  /// 跨端回填合并（turn 级锚定去重）：
  /// - 锚 = 用户消息。服务端轮与本机重复的判定：clientMessageId 命中本地 id、
  ///   用户原文精确命中、纯图占位（服务端「（用户发送了…」↔ 本地「（见图）」）。
  /// - 助手消息随锚走：锚轮已存在 → 整轮跳过（分泡/塌缩形态差异不再制造双份）；
  ///   无锚的孤儿助手消息按正文包含关系去重后插入。
  /// - [bubbleBackfillIds]：服务端分泡对账数组重建的消息 id（2026-11-13）。
  ///   这些消息跳过「批量内精确文本去重」，且包含去重只对回填前已存在的本地
  ///   消息做——同轮两个分泡恰好同文（如「好。」「好。」连发）或互为片段
  ///   是刻意形态，必须逐泡都落屏。
  /// - 插入位置按时间戳落位，回填后逐条写进本地 store（下次启动直接命中）。
  /// 返回实际回填（新增落盘）的消息条数——重连对账据此判断有无漏收。
  int _mergeServerTurnsFor(
    String key,
    List<ChatMessage> incoming, {
    Set<String> bubbleBackfillIds = const <String>{},
  }) {
    final List<ChatMessage> target = _sessionMessages.putIfAbsent(
      key,
      () => <ChatMessage>[],
    );
    // 按 user 锚切轮（开头没有锚的孤儿助手消息自成一轮）
    final List<List<ChatMessage>> turns = <List<ChatMessage>>[];
    for (final ChatMessage m in incoming) {
      if (m.role == "user" || turns.isEmpty) {
        turns.add(<ChatMessage>[m]);
      } else {
        turns.last.add(m);
      }
    }

    final Set<String> localUserIds = <String>{};
    final Set<String> localUserTexts = <String>{};
    final List<ChatMessage> localAssistants = <ChatMessage>[];
    for (final ChatMessage m in target) {
      if (m.role == "user") {
        localUserIds.add(m.messageId);
        localUserTexts.add(m.text.trim());
      } else if (m.role == "assistant" && m.text.trim().isNotEmpty) {
        localAssistants.add(m);
      }
    }
    final Set<String> backfilledAssistantTexts = <String>{};
    // 回填批次开始前已存在的本地助手消息条数：分泡回填消息的包含去重只
    // 对这个前缀范围做（批次内新插入的分泡不算——同文/互为片段是刻意形态）。
    final int preexistingAssistantCount = localAssistants.length;

    bool turnExistsLocally(List<ChatMessage> turn) {
      final ChatMessage anchor = turn.first;
      if (anchor.role != "user") return false;
      final String anchorText = anchor.text.trim();
      if (localUserIds.contains(anchor.messageId)) return true;
      if (localUserTexts.contains(anchorText)) return true;
      // 纯图轮：本地气泡文案与服务端视觉占位文案不同，视为同一轮
      if (anchorText == "（见图）" && localUserTexts.any((t) => t == "（见图）")) {
        return true;
      }
      return false;
    }

    bool assistantKnown(ChatMessage m) {
      final String text = m.text.trim();
      final bool fromBubbles = bubbleBackfillIds.contains(m.messageId);
      // 分泡回填消息跳过批量内精确文本去重：同文分泡是刻意形态，逐泡都要落。
      if (!fromBubbles && backfilledAssistantTexts.contains(text)) return true;
      if (localUserTexts.contains(text)) return true;
      final Iterable<ChatMessage> dedupeScope = fromBubbles
          ? localAssistants.take(preexistingAssistantCount)
          : localAssistants;
      for (final ChatMessage local in dedupeScope) {
        final String lt = local.text.trim();
        // 包含关系去重：服务端合并正文 ↔ 本地分泡互为片段时视为同一条回复
        if (lt.length >= 8 && text.contains(lt)) return true;
        if (text.length >= 8 && lt.contains(text)) return true;
      }
      return false;
    }

    void insertByTimestamp(ChatMessage m) {
      int idx =
          target.indexWhere((local) => local.timestamp.isAfter(m.timestamp));
      if (idx < 0) idx = target.length;
      target.insert(idx, m);
      _persist(m);
    }

    bool mutated = false;
    int insertedCount = 0;
    for (final List<ChatMessage> turn in turns) {
      if (turnExistsLocally(turn)) continue;
      for (final ChatMessage m in turn) {
        if (m.role == "assistant" && assistantKnown(m)) continue;
        if (m.role == "assistant") backfilledAssistantTexts.add(m.text.trim());
        insertByTimestamp(m);
        mutated = true;
        insertedCount++;
        if (m.role == "user") {
          localUserIds.add(m.messageId);
          localUserTexts.add(m.text.trim());
        } else {
          localAssistants.add(m);
        }
      }
    }
    if (mutated && _activeSessionKey == key) notifyListeners();
    return insertedCount;
  }


  /// 发送一条用户消息(空文本+无图忽略)。携带 [visionFrames] 时与桌面端
  /// 同协议走 `chat.user_message.visionFrames`(base64,服务端视觉管线)。
  /// 返回落库的用户消息 id(未发送返回 null),供调用方挂气泡缩略图。
  ///
  /// 离线可发（2026-10-12）：断网时消息照常落气泡并持久化，同时把完整
  /// `chat.user_message` 载荷存进本地待发队列；联网后由
  /// [_flushPendingUserMessages] 按序补发。服务端按 messageId 幂等去重，
  /// 补发重复无害。
  Future<String?> send(String raw,
      {List<VisionWireFrame>? visionFrames}) async {
    final String text = raw.trim();
    final bool hasFrames = visionFrames != null && visionFrames.isNotEmpty;
    if (text.isEmpty && !hasFrames) return null;
    // 新消息一发出就撤掉旧轮次的接续建议（过期会诱导误点）。
    _clearStaleFollowUps();
    // 旅游规划（2026-11-14 手机端根修）：命中规划意图或已在规划会话中，
    // 直接在当前聊天流里推进 plan-session 问答流，不跳转规划页、不发 WS。
    if (!hasFrames && !isSideChatActive) {
      final TravelPlanFlowController? flow = _planFlow;
      if (flow != null && !flow.completed) {
        if (flow.busy) return null;
        _appendPlanUserMessage(text);
        unawaited(flow.sendContinuation(text));
        return "plan-${DateTime.now().microsecondsSinceEpoch}";
      }
      if (_service.isConnected && looksLikeTravelPlanningIntent(text)) {
        // 已出过方案的旧流先收掉，再按新原话开一条新会话。
        if (_planFlow != null) closePlanFlow();
        _appendPlanUserMessage(text);
        _startPlanFlow(text);
        return "plan-${DateTime.now().microsecondsSinceEpoch}";
      }
    }
    final bool offline = !_service.isConnected;
    final ChatMessage userMsg = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _activeSessionKey,
      role: "user",
      // 纯图无文字时气泡显示「（见图）」,与桌面端一致
      text: text.isEmpty && hasFrames ? "（见图）" : text,
      timestamp: DateTime.now(),
      attachmentImageCount: hasFrames ? visionFrames.length : 0,
      pendingDelivery: offline,
    );
    final Map<String, dynamic> payload = <String, dynamic>{
      // 主会话用连接级 sessionId；旁聊透传 `side:<actor>:<id>`（服务端按归属校验）
      "sessionId": _activeServerSessionId,
      "messageId": userMsg.messageId,
      // 纯图轮 text 置空(服务端按 visionFrames 走视觉分档),与桌面端一致
      "text": text,
      // 绝对时刻（带 Z）：裸本地时间在服务端会被按服务器时区解析，跨时区错数小时
      "timestamp": DateTime.now().toUtc().toIso8601String(),
      // 每条消息随行上报设备时区：跨时区飞行落地后立刻生效，不靠常驻侦测
      "clientClock": await ClientClockService.snapshot(),
      "agentAccessMode": "full",
      // 与 session.init 同源：登录邮箱优先，保证消息落在本账号车道
      "userId": ApiConfig.effectiveActorId,
    };
    if (hasFrames) {
      payload["visionFrames"] =
          visionFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    messages.add(userMsg);
    _settleNameCards();
    _persist(userMsg);
    notifyListeners();

    if (offline) {
      // 离线：入队（fire-and-forget，存储失败只丢补发不丢气泡）+ 触发重连
      unawaited(
        _store.enqueuePendingUserMessage(payload).catchError((Object e) {
          debugPrint("[MobileChatController] 离线消息入队失败: $e");
        }),
      );
      _service.retryConnect();
      errorMessage = "当前离线,消息已存入待发队列,联网后自动发送";
      notifyListeners();
      return userMsg.messageId;
    }
    // 处理中标志按当前线程标记（2026-11-12 P1）：主会话与旁聊可各自在途。
    final String threadKey = _activeSessionKey;
    _turnOf(threadKey).processing = true;
    errorMessage = null;
    notifyListeners();
    final bool accepted = _service.sendEvent("chat.user_message", payload);
    if (!accepted) {
      // 连接层未受理（当前不在连接上）：消息已进它的待发队列，连上后自动补发。
      // 必须显式告诉用户，否则界面停在「我看看」上无限等待——用户无法区分
      // 「正在想」和「根本没发出去」（2026-11-11 真机）。
      errorMessage = "正在连接服务器，消息会在连上后自动发出";
      notifyListeners();
    }
    // 无论受理与否都上表：12s 内连 acks 都没有，就把「我看看」换成可解释的状态。
    _armDeliveryStallWatch(threadKey);
    return userMsg.messageId;
  }

  /// 卡片动作（选择型卡按钮 / chips 效果卡点击）：与桌面端 main.dart
  /// `_handleCardAction` 同协议——经 `chat.user_action` 发出，后端转写为
  /// 等价 chat.user_message（携带 cardAction 元数据供审计/路由）走原聊天
  /// 流程，Agent 据此衔接回复（如支付确认卡的「我已完成支付，帮我确认」、
  /// chips 标签追问）。断线时提示并触发重连（与桌面端同样不发送）。
  bool sendCardAction(
    AgentResultAction action, {
    required AgentResultData cardData,
    String? messageId,
  }) {
    final String label = action.label.trim();
    if (label.isEmpty) return false;
    if (!_service.isConnected) {
      _service.retryConnect();
      errorMessage = "正在连接服务器，请稍后再试";
      notifyListeners();
      return false;
    }
    // 卡内动作分流（2026-11-06 定稿）：payload.cardAction 存在 = 走「只换这张卡」
    // 的通道，不产生任何消息；否则维持老路（chat.user_action → 一轮问答）。
    // 判据放在数据里而不是客户端硬编码按钮名，服务端换动作只需改卡面。
    final String cardAction =
        (action.payload["cardAction"] ?? "").toString().trim();
    if (cardAction.isNotEmpty) {
      final String boundId = (messageId ?? "").trim();
      if (boundId.isEmpty) {
        // 没有消息锚点就无法回写这张卡：宁可什么都不做，也不要错改别的卡
        errorMessage = "这张卡已经不在对话里了";
        notifyListeners();
        return false;
      }
      final Map<String, dynamic> data = <String, dynamic>{
        for (final MapEntry<String, dynamic> e in action.payload.entries)
          if (e.key != "cardAction") e.key: e.value,
      };
      return _service.sendCardActionEvent(
        sessionId: _activeServerSessionId,
        messageId: boundId,
        actionId: cardAction,
        cardId: cardData.cardId,
        stage: (cardData.extra?["shopping"] is Map)
            ? ((cardData.extra!["shopping"] as Map)["stage"] ?? "").toString()
            : "",
        payload: data,
      );
    }
    final bool sent = _service.sendCardAction(
      sessionId: _activeServerSessionId,
      messageId: "action-${DateTime.now().microsecondsSinceEpoch}",
      actionId: action.id,
      label: label,
      cardId: cardData.cardId,
      variant: action.variant,
      actionPayload: action.payload,
      cardTitle: cardData.title,
      cardItems: cardData.items
          .map((AgentResultItem it) => it.text)
          .toList(growable: false),
      userId: ApiConfig.effectiveActorId,
    );
    if (sent) {
      _turn.processing = true;
      errorMessage = null;
      notifyListeners();
    }
    return sent;
  }

  /// 联网补发离线待发消息（`ws_connected` 后触发；此时 `session.init` 已由
  /// onConnected 同步先行发出，载荷落在已绑定的账号车道上）。
  ///
  /// 按队列顺序逐条补发；发送成功才出队并翻转气泡「离线待发送」状态。
  /// 中途断线/发送失败立即停手，剩余留队等下次 ws_connected。
  Future<void> _flushPendingUserMessages() async {
    if (_flushingPending) return;
    _flushingPending = true;
    try {
      final List<Map<String, dynamic>> pending =
          await _store.listPendingUserMessages();
      if (pending.isEmpty) return;
      for (final Map<String, dynamic> payload in pending) {
        if (!_service.isConnected) return;
        final String messageId = payload["messageId"]?.toString() ?? "";
        if (messageId.isEmpty) continue;
        if (!_send("chat.user_message", payload)) return;
        await _store.dequeuePendingUserMessage(messageId);
        final int idx = messages.indexWhere((m) => m.messageId == messageId);
        if (idx >= 0 && messages[idx].pendingDelivery) {
          final ChatMessage settled =
              messages[idx].copyWith(pendingDelivery: false);
          messages[idx] = settled;
          _persist(settled);
        }
        notifyListeners();
      }
      errorMessage = null;
    } catch (e) {
      debugPrint("[MobileChatController] 离线消息补发失败(留队重试): $e");
    } finally {
      _flushingPending = false;
      notifyListeners();
    }
  }

  /// 测试入口：直接驱动 WS 事件（生产路径走 [_subscription] → 本方法）。
  @visibleForTesting
  void debugHandleWsEvent(Map<String, dynamic> event) => _onWsEvent(event);

  /// 测试入口：跳过揭示间隔，把缓冲/队列里的分泡立即整泡落屏（同步断言用）。
  @visibleForTesting
  void debugFlushBubbleReveals() => _flushHiddenBubblesNow();

  /// 测试注入点：定位解析器（生产为 null → 走 ClientLocationService 实时定位）。
  @visibleForTesting
  static Future<ClientLocationPayload?> Function()? debugLocationResolver;

  /// 测试开关：置 true 时 [_send] 把发出的事件记录进 [debugSentEvents]。
  @visibleForTesting
  bool debugCaptureSentEvents = false;

  /// 测试观测点：经 [_send] 发出的事件（type, payload）按序记录。
  @visibleForTesting
  final List<MapEntry<String, Map<String, dynamic>>> debugSentEvents =
      <MapEntry<String, Map<String, dynamic>>>[];

  /// 出站统一入口：生产直发；测试开启 [debugCaptureSentEvents] 时留观测记录。
  bool _send(String type, Map<String, dynamic> payload) {
    if (debugCaptureSentEvents) {
      debugSentEvents
          .add(MapEntry<String, Map<String, dynamic>>(type, payload));
    }
    return _service.sendEvent(type, payload);
  }

  /// 服务端按需定位应答（与桌面端 main.dart 同协议）：Agent 需要位置时
  /// （天气/时钟等工具）下发 `agent.location_request`，本端拉纯坐标秒回
  /// `client.location_report`（服务端拿到坐标后自行逆地理）。
  ///
  /// 手机端此前没有这条应答链——服务端 locationCoordinator 绑定的是该 actor
  /// 最后一条完成 session.init 的连接，手机聊天 WS 与桌面根 WS 同 actor 竞绑
  /// （聊天 WS 后建常胜出），请求落在无人应答的聊天 WS 上就恒超时，agent
  /// 便「不知道用户的地址」。本端补齐后无论绑定落在哪条连接都能闭环。
  Future<void> _handleLocationRequest(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString() ?? "";
    ClientLocationPayload? loc;
    try {
      loc = await _resolveLocation();
    } catch (_) {
      loc = null;
    }
    debugPrint(
      "[MobileChatController] 按需定位回包 jobId=$jobId lat=${loc?.latitude ?? "无"}",
    );
    // 拿不到坐标也回 jobId 空包：让服务端立即结算（resolve null），不白等超时。
    _send("client.location_report", <String, dynamic>{
      if (jobId.isNotEmpty) "jobId": jobId,
      ...?loc?.toJson(),
    });
  }

  /// 连接就绪即静默上报一次定位（无 jobId 纯上报，与桌面端启动上报同语义）：
  /// 填充服务端 actor 位置缓存，首条消息的 prompt 注入才有位置背景可用。
  /// 登录后 actor 身份才落定，桌面根 WS 的启动上报可能落在匿名 actor 上，
  /// 本连接（登录后创建）的上报正好补上登录身份的缓存。
  Future<void> _reportStartupLocation() async {
    try {
      final ClientLocationPayload? loc = await _resolveLocation();
      if (loc == null) return;
      debugPrint(
        "[MobileChatController] 启动定位上报 lat=${loc.latitude} city=${loc.city ?? "-"}",
      );
      _send("client.location_report", loc.toJson());
    } catch (_) {
      // 定位失败静默：Agent 运行中需要位置时会走 agent.location_request 按需再拉
    }
  }

  /// 时区变化时主动补报（常驻连接期间跨时区：飞行/高铁落地系统切时区）。
  ///
  /// 只比对内存里的 IANA 时区与 UTC 偏移，**不定位、不联网、不申请权限**——
  /// 即使定位权限被拒或室内无 fix，时间感知也照常工作。
  Future<void> _reportClockIfChanged() async {
    try {
      if (!await ClientClockService.hasTimezoneChanged()) return;
      final Map<String, dynamic> clock =
          await ClientClockService.snapshot(source: "event");
      _send("client.clock_report", clock);
      debugPrint("[MobileChatController] 时区变化已补报: ${clock["timezone"]}");
    } catch (e) {
      debugPrint("[MobileChatController] 时钟补报失败(忽略): $e");
    }
  }

  /// 系统围栏触发（App 存活时的实时通道）：立刻上报一次位置。
  ///
  /// 服务端拿到真实坐标后，软围栏状态机自然收敛（此前 outside → 现在 inside
  /// 就产生 enter 事件），不需要端上执行任何业务动作。
  void _handleGeofenceEvent(Map<String, dynamic> event) {
    unawaited(_reportGeofencePosition(event));
  }

  /// 注册系统围栏并上报回执（client.geofence_report）。
  ///
  /// 此前注册结果被整体丢弃：权限被拒、系统定位关闭、ROM 拦截都只留一条
  /// debugPrint，服务端完全不知道端上有没有围栏。现在把原生回执原样上报，
  /// 服务端落库（geofence.list 的 clientSync）并写日志。
  Future<void> _syncClientGeofences(List<Map<String, dynamic>> fences) async {
    final Map<String, dynamic>? report =
        await ClientGeofenceService.sync(fences);
    final Map<String, dynamic> payload = <String, dynamic>{
      "ok": false,
      "requested": fences.length,
      "registered": 0,
      ...?report,
      "platform": report?["platform"] ?? "android",
      "at": report?["at"] ?? DateTime.now().toUtc().toIso8601String(),
    };
    final bool sent = _send("client.geofence_report", payload);
    if (!sent) {
      // 回执丢失不阻塞主链路：下次连接服务端会重新下发 sync，届时再回执
      debugPrint("[MobileChatController] 围栏回执未送达（连接不可用）");
    }
  }

  /// 补报 App 未运行期间积压的围栏事件（原生队列 → 取走 → 逐条上报）。
  Future<void> _flushPendingGeofenceEvents() async {
    try {
      final List<Map<String, dynamic>> pending =
          await ClientGeofenceService.drainPending();
      for (final Map<String, dynamic> event in pending) {
        await _reportGeofencePosition(event);
      }
      if (pending.isNotEmpty) {
        debugPrint("[MobileChatController] 补报积压围栏事件 ${pending.length} 条");
      }
    } catch (e) {
      debugPrint("[MobileChatController] 围栏事件补报失败(忽略): $e");
    }
  }

  Future<void> _reportGeofencePosition(Map<String, dynamic> event) async {
    try {
      // 2026-11-13：**优先采信原生围栏事件自带的触发点坐标**。
      // 系统在触发围栏时会一并给出当时的经纬度与精度（GeofenceReceiver 已解出），
      // 那是「真正跨过边界那一刻」的位置。此前这里无条件重新拉一次实时 GPS ——
      // App 被杀数小时后补报时，人早已离开，拉到的是当前位置而非触发点，
      // 服务端据此判围栏就会误判。
      // 只有原生事件没带坐标（老版本事件体）时，才回落到实时 GPS 兜底。
      final num? evLat = event["latitude"];
      final num? evLng = event["longitude"];
      final bool hasEventCoords =
          evLat != null && evLng != null &&
          evLat.isFinite && evLng.isFinite &&
          evLat >= -90 && evLat <= 90 && evLng >= -180 && evLng <= 180;

      if (hasEventCoords) {
        _send("client.location_report", <String, dynamic>{
          "latitude": evLat,
          "longitude": evLng,
          if (event["accuracyMeters"] != null)
            "accuracyMeters": event["accuracyMeters"],
          if (event["altitudeMeters"] != null)
            "altitudeMeters": event["altitudeMeters"],
          if (event["speedMps"] != null) "speedMps": event["speedMps"],
          if (event["headingDegrees"] != null)
            "headingDegrees": event["headingDegrees"],
          if (event["capturedAt"] != null) "capturedAt": event["capturedAt"],
          "source": "report",
          "trigger": "geofence",
          if (event["fenceId"] != null) "fenceId": event["fenceId"],
          if (event["at"] != null) "triggeredAt": event["at"],
        });
        return;
      }

      final ClientLocationPayload? loc =
          await ClientLocationService.getCurrentLocationForAgentReply();
      if (loc == null) return;
      _send("client.location_report", <String, dynamic>{
        ...loc.toJson(),
        "source": "report",
        "trigger": "geofence",
        if (event["fenceId"] != null) "fenceId": event["fenceId"],
        if (event["at"] != null) "triggeredAt": event["at"],
      });
    } catch (e) {
      debugPrint("[MobileChatController] 围栏位置上报失败(忽略): $e");
    }
  }

  Future<ClientLocationPayload?> _resolveLocation() {
    final resolver = debugLocationResolver;
    if (resolver != null) return resolver();
    return ClientLocationService.getCurrentLocationForAgentReply();
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload = event["payload"] is Map
        ? event["payload"] as Map<String, dynamic>
        : const {};
    // 任何入站都说明链路有回应：撤掉「无响应」提示（下一次发送会重新上表）。
    _clearDeliveryStallWatch();
    // 身份重同步只是过渡态：重投成功后收到任何聊天事件即视为已恢复。
    if (errorMessage == _identityResyncHint &&
        type.startsWith("chat.") &&
        type != "chat.error") {
      errorMessage = null;
    }
    switch (type) {
      case "ws_connected":
        isConnected = true;
        connection.value = true;
        notifyListeners();
        // 连接就绪即静默上报一次定位（无 jobId）：填充服务端位置缓存，
        // 首条消息的 prompt 注入才有位置背景。与桌面端启动上报同语义。
        unawaited(_reportStartupLocation());
        // 时钟补报：连接时才区可能已与上次不同（重连前跨了时区）
        unawaited(_reportClockIfChanged());
        // 围栏事件流 + 积压补报（App 被杀期间系统围栏触发的事件在这里补交）
        ClientGeofenceService.listen(_handleGeofenceEvent);
        unawaited(_flushPendingGeofenceEvents());
        _clockWatchTimer ??= Timer.periodic(
          const Duration(minutes: 15),
          (_) => unawaited(_reportClockIfChanged()),
        );
        // 离线待发消息补发（session.init 已由 onConnected 同步先行发出）
        unawaited(_flushPendingUserMessages());
        // 重连对账（2026-11-10）：后台被冻结期间服务端的回复/主动消息已落
        // 服务端 WAL，但本机 WS 收不到——重连后清一次历史拉取闸并补拉主
        // 线程，漏掉的轮次按 turn 级锚定去重回填对话流；旁聊线程在下次
        // 打开时经同一闸补拉。后台时按最后一条漏收消息补横幅触达。
        final bool isReconnect = _everConnected;
        _everConnected = true;
        if (isReconnect && !_ownsConnection) {
          _serverHistoryPulled.clear();
          unawaited(_reconcileAfterReconnect());
        }
      case "agent.location_request":
        unawaited(_handleLocationRequest(payload));
      case "agent.geofence_sync":
        // 服务端下发围栏 → 注册为系统围栏（App 被杀也能触发到达/离开），
        // 并把原生注册结果作为回执上报（服务端可观测，见 client.geofence_report）
        final List<Map<String, dynamic>> fences = payload["fences"] is List
            ? (payload["fences"] as List)
                .whereType<Map>()
                .map((Map e) => e.cast<String, dynamic>())
                .toList(growable: false)
            : const <Map<String, dynamic>>[];
        unawaited(_syncClientGeofences(fences));
      case "reminder_popup":
        // 提醒升级链 popup 级（2026-10-14 与桌面端对齐）：决策卡落对话流。
        // 后台时应用内卡片看不见，补一条系统通知触达（点开回前台后卡在流里）。
        _handleReminderPopupEvent(payload);
      case "agent.proactive_message":
        // 主动性消息（2026-11-07）：引导开场白等告知类文本落文字气泡，
        // 服务端按分泡节奏连推两条即两泡。
        _handleProactiveMessageEvent(payload);
      case "agent.proactive_voice":
        // Agent 语音联系：手机端唯一 owner——TTS 播放与后台系统通知都在
        // 这里完成（桌面端由根分发器处理，见归属表）。
        _playEventTts(payload);
        if (_appBackgrounded) {
          final String vt = payload["text"]?.toString() ?? "";
          if (vt.trim().isNotEmpty) {
            unawaited(LocalNotificationService.show(
                title: payload["title"]?.toString() ?? "Agent 语音联系",
                body: vt));
          }
        }
      case "agent.voice.alarm":
        // 语音提醒：同上（唯一 owner）。
        _playEventTts(payload);
        if (_appBackgrounded) {
          final String vt = payload["text"]?.toString() ?? "";
          if (vt.trim().isNotEmpty) {
            final String vTitle = payload["title"]?.toString() ?? "语音提醒";
            unawaited(LocalNotificationService.show(
                title: payload["priority"]?.toString() == "urgent"
                    ? "[紧急] $vTitle"
                    : vTitle,
                body: vt));
          }
        }
      case "agent.voice.speak":
        // 底层 voice.speak 工具触发的即时播报：轻量事件，只出声不建卡。
        _playEventTts(payload);
      case "agent.voice.message":
        // 底层 voice.send_message 工具触发的语音条（微信式可重播气泡）。
        // 手机端唯一 owner：落主线程消息列表 + 本地历史，实时出现在对话流。
        _handleVoiceMessageEvent(payload);
      case "identity_renamed":
        // 对话中用户给 agent 取名：服务端统一改名管道（账号 + agent.name KV
        // + prefs 三处同写）成功后广播，顶栏胶囊当场更新，无需重进应用。
        AgentNameStore.instance.set(payload["displayName"]?.toString());
      case "evening.digest":
        // 睡前提醒（2026-10-16 接线）：narrationText 是唯一文案源，落文字气泡。
        // 后台不发系统通知（离线兜底已由服务端 proactivePipeline 承担）。
        _handleEveningDigestEvent(payload);
      case "agent.transfer_reminder":
        // 接驳提醒（行程段临近到达）：落对话流确认卡，一键回复帮我叫车。
        _handleTransferReminderEvent(payload);
      case "ws_disconnected":
      case "connection_error":
        isConnected = false;
        connection.value = false;
        // 断连兜底：缓冲/队列里的泡立即整泡落屏，正文不因断连凭空消失
        _flushHiddenBubblesNow();
        notifyListeners();
      case "card.update":
        // 卡片就地更新（2026-11-06）：服务端把这条消息里的卡换掉，客户端只重建
        // 这张卡、不追加消息。判据是 messageId 命中——找不到（消息被删/被滚出
        // 窗口）就静默丢弃，绝不新建气泡。
        _applyCardUpdate(payload);
      case "onboarding.name_choices":
        // 首启引导·取名卡（2026-11-08）：挂在指定回复气泡下方（先 done 后卡）。
        _applyNameChoices(payload);
        notifyListeners();
      case "chat.turn_started":
      case "chat.assistant_interim":
        _handleTurnBegin(payload);
        notifyListeners();
      case "chat.intent_detected":
        // v2 阶段 1（默认关闭）：只取「拆解 / 派活」两个事实来换文案，
        // 结构化面板手机端不做，避免为灰度协议背一套 UI。
        _handleIntentDetected(payload);
        notifyListeners();
      case "chat.agent_status":
        _handleAgentStatus(payload);
        notifyListeners();
      case "chat.assistant_chunk":
        _handleChunkEvent(payload);
      case "chat.stream_reset":
        _handleStreamReset(payload, _threadKeyOf(payload));
      case "chat.media_ready":
        _handleMediaReady(payload, _threadKeyOf(payload));
      case "tool.call":
        _handleToolCall(payload);
        notifyListeners();
      case "tool.result":
        _handleToolResult(payload);
        notifyListeners();
      case "agent.browser.preview":
        // Agent 浏览器工作预览帧：悬浮窗画面源（2026-11-12）。
        _handleBrowserPreview(payload);
      case "chat.assistant_done":
        _handleDoneEvent(payload);
      case "chat.error":
        _handleTurnError(payload, payload["message"]?.toString() ?? "出错了,请重试");
      case "error.event":
        // 服务端统一错误帧。桌面端由根分发器管窗口/toast，手机端必须在这里
        // 收口：`FORBIDDEN`/`SESSION_REQUIRED` 的成因只有一个——连接绑定的
        // actor 与本机当前身份不一致（启动期账号读盘晚于建连、登录/切换账号
        // 后没重新 init）。服务端会**直接丢弃且不落审计**，客户端只看得到
        // 「永远等不到回复」，这就是 2026-11-11「思考组件卡在我看看」的真身。
        // 连接层已在 _handleServerRejection 里补发 session.init 并按原
        // messageId 重投，所以这里只提示、不复位轮次——重投成功会照常由
        // turn_started/chunk/done 接手。
        final String errCode = payload["code"]?.toString() ?? "";
        if (errCode == "FORBIDDEN" || errCode == "SESSION_REQUIRED") {
          errorMessage = _identityResyncHint;
          notifyListeners();
        } else {
          _handleTurnError(
            payload,
            payload["message"]?.toString() ?? "出错了,请重试",
          );
        }
      case "chat_delivery_failed":
        // 重投次数用尽（链路反复判死 / 服务端持续拒收）：如实告诉用户，
        // 绝不留在「处理中」骗人。
        _handleTurnError(
          payload,
          payload["message"]?.toString() ?? "消息没能送达服务器，请检查网络后重试",
        );
    }
  }

  /// turn 级事件（turn_started / interim）入口：按 threadId 开占位泡 + 状态复位。
  void _handleTurnBegin(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    _openStreamingMessage(payload, threadKey);
    _beginTurnActivity(threadKey);
  }

  /// chat.assistant_chunk 入口：按 threadId 分流到分泡缓冲 / 单泡追加。
  void _handleChunkEvent(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    _appendChunk(payload, threadKey);
    final _ThreadTurnState t = _turnOf(threadKey);
    if (!t.sawChunk) {
      t.sawChunk = true;
      if (threadKey == _activeSessionKey) notifyListeners();
    }
  }

  /// chat.assistant_done 入口：按 threadId 收口对应线程。
  void _handleDoneEvent(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    _finalizeReply(payload, threadKey);
    _maybeAutoOpenTravelCard(payload);
  }

  /// 已知服务端错误码 → 用户可读文案：原始报错（错误码 + 字节数）不该
  /// 直接怼给用户；客户端压缩后这些码只会在异常兜底时出现。
  static String _friendlyErrorText(String raw) {
    final String msg = raw.trim();
    if (msg.contains("VISION_IMAGE_TOO_LARGE")) {
      return "这张图太大了，没能发出去，换一张试试？";
    }
    if (msg.contains("VISION_TOO_MANY_FRAMES")) {
      return "一次最多发 4 张图，先挑几张发吧";
    }
    return msg;
  }

  /// 错误条自动消失：6 秒后清空。身份重同步提示（_identityResyncHint）
  /// 不走这里——它是「重发中」的状态提示，由后续事件自然覆盖。
  void _armErrorHintAutoClear() {
    _errorHintClearTimer?.cancel();
    _errorHintClearTimer = Timer(const Duration(seconds: 6), () {
      if (_disposed) return;
      if (errorMessage != null) {
        errorMessage = null;
        notifyListeners();
      }
    });
  }

  /// 错误帧统一收口：按 traceId 归位到出错线程（多轮并发时只复位那一轮）。
  ///
  /// 归位优先级：载荷 traceId → threadId → 唯一在处理中的线程 → 激活线程。
  /// 找不到归属时不盲目复位全部线程——另一线程可能还在正常出泡。
  void _handleTurnError(Map<String, dynamic> payload, String message) {
    errorMessage = _friendlyErrorText(message);
    _armErrorHintAutoClear();
    String threadKey = _threadKeyOf(payload);
    final String traceId = payload["traceId"]?.toString() ?? "";
    if (traceId.isNotEmpty && _traceThread.containsKey(traceId)) {
      threadKey = _traceThread[traceId] ?? threadKey;
    } else if (!_turnOf(threadKey).processing) {
      final List<String> processingKeys = _turnStates.entries
          .where((MapEntry<String, _ThreadTurnState> e) => e.value.processing)
          .map((MapEntry<String, _ThreadTurnState> e) => e.key)
          .toList(growable: false);
      if (processingKeys.length == 1) threadKey = processingKeys.first;
    }
    // 出错兜底：已流出的泡正文立即整泡落屏，不因报错凭空丢失
    _flushHiddenBubblesNow();
    _resetActivityState(threadKey);
    notifyListeners();
  }

  /// 新一轮开始：清掉上一轮残留的工具名 / 进度句，只保留「处理中」（按线程）。
  void _beginTurnActivity(String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    t.currentToolName = null;
    t.agentStatusLine = null;
    t.agentStatusPercent = null;
    t.planPhase = false;
    t.delegatePhase = false;
    t.sawChunk = false;
    t.processing = true;
  }

  /// `chat.agent_status`：服务端口语化进度（含长工具心跳百分比）。
  ///
  /// 迟到的状态事件必须丢掉：收尾后再点亮状态条，会出现「状态条说在干活、
  /// 正文已经答完」的同框矛盾（桌面端同判据，只是那边按 traceId 过滤）。
  void _handleAgentStatus(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    final _ThreadTurnState t = _turnOf(threadKey);
    if (!t.processing) return;
    final String line = payload["line"]?.toString().trim() ?? "";
    final String phase = payload["phase"]?.toString() ?? "";
    if (line.isNotEmpty) t.agentStatusLine = line;
    final Object? rawPercent = payload["percent"];
    if (rawPercent is num) {
      t.agentStatusPercent = rawPercent.toInt().clamp(0, 100);
    }
    if (phase == "delegate_start") {
      t.delegatePhase = true;
    } else if (phase == "delegate_done") {
      t.delegatePhase = false;
    }
  }

  /// `chat.intent_detected`：只提取阶段事实，不建结构化面板。
  void _handleIntentDetected(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    final _ThreadTurnState t = _turnOf(threadKey);
    if (!t.processing) return;
    final Object? plan = payload["plan"];
    final Object? subAgents = payload["subAgents"];
    t.planPhase = plan is List && plan.isNotEmpty;
    t.delegatePhase = subAgents is List && subAgents.isNotEmpty;
  }

  /// tool.call：按线程置位工具名（并发轮次互不覆盖）。
  void _handleToolCall(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    final _ThreadTurnState t = _turnOf(threadKey);
    t.currentToolName = payload["toolName"]?.toString().trim() ?? "";
    // 上一把工具的口语化进度不能挂到新工具头上：先清空，等服务端为
    // 新工具下发参数化文案（没有就退回工具族映射表）。
    t.agentStatusLine = null;
    t.agentStatusPercent = null;
    // 有具体工具在跑，「拆解/派活」的阶段话术让位给工具族文案。
    t.planPhase = false;
    t.processing = true;
    // 浏览器族工具（agent_browser / shopping.* / browser.*）：点亮右上角悬浮窗
    // （首帧未到先显示「正在打开浏览器」，修复「手机端跑浏览器任务全程无反馈」——
    // 2026-11-12；2026-11-14 扩到购物比价/下单）。
    final Object? input = payload["input"];
    if (_toolUsesCloudBrowser(t.currentToolName ?? "", input)) {
      _browserTaskActive = true;
      _browserPreviewDismissed = false;
      browserPreviewImage = null;
      browserPreviewUrl = null;
      final Object? action = input is Map ? input["action"] : null;
      final String actionText = action is String ? action.trim() : "";
      browserPreviewAction = actionText.isNotEmpty
          ? actionText
          : _toolDefaultPreviewAction[t.currentToolName ?? ""];
    }
  }

  /// tool.result：当前这把工具结束，让位给下一把
  /// （若链式调用，紧随的 tool.call 会重新置位）。
  void _handleToolResult(Map<String, dynamic> payload) {
    final String threadKey = _threadKeyOf(payload);
    _turnOf(threadKey).currentToolName = null;
  }

  // ===== 主动性消息触达（决策卡已删除，2026-11-04 定调：一律落文本气泡）=====

  /// 是否处于后台（MobileHomePage 装配进 AmbientFeedsController 端口）。
  bool get _appBackgrounded =>
      AmbientFeedsController.instance.isAppBackgrounded?.call() ?? false;

  /// 提醒升级链 popup 级（reminder_popup）→ 对话流文本气泡（真实消息持久化）。
  /// 后台时补系统通知触达；落流即已触达，自动回传 attention ack 让服务端
  /// 升级链收敛——升级链此后只在投递失败（离线/杀进程）时逐级升级。
  void _handleReminderPopupEvent(Map<String, dynamic> payload) {
    final String title = payload["title"]?.toString() ?? "提醒";
    final String message = payload["message"]?.toString() ?? "";
    final String priority = payload["priority"]?.toString() ?? "normal";
    final String attentionId = payload["attentionId"]?.toString() ?? "";
    if (_appBackgrounded) {
      unawaited(LocalNotificationService.show(
        title: priority == "urgent" ? "[紧急] $title" : title,
        body: message,
      ));
    }
    if (attentionId.isNotEmpty) {
      unawaited(() async {
        try {
          await AttentionApi().ack(attentionId, via: "chat_stream");
        } catch (e) {
          debugPrint("[mobile reminder-popup] attention ack failed: $e");
        }
      }());
    }
    final String body =
        message.trim().isNotEmpty ? message.trim() : title.trim();
    if (body.isEmpty) return;
    // 服务端主动触达只回主界面（2026-11-12 用户定调）：旁聊是用户主动开的
    // 旁支上下文，提醒/升级链弹窗与旁聊内容无关，落旁聊线程会「回错会话」。
    final ChatMessage reminder = ChatMessage(
      messageId: "assistant-reminder-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _mainSessionKey,
      role: "assistant",
      text: body,
      timestamp: DateTime.now(),
    );
    _mainThreadMessages.add(reminder);
    _persist(reminder);
    notifyListeners();
  }

  /// 睡前提醒（evening.digest）→ 对话流专属卡片。
  /// 2026-10-22 定调升级：结构化块（明日行程/天气/超支/今日回顾）由
  /// EveningDigestCard 渲染，narrationText 保留为卡顶部 agent 文案段；
  /// 旧服务端无 digest 结构时回退纯文本气泡。同为「真实消息」落本地
  /// 历史（重启后仍以卡片形态渲染，结构化载荷随消息加密持久化）。
  void _handleEveningDigestEvent(Map<String, dynamic> payload) {
    final Object? rawDigest = payload["digest"];
    final Map<String, dynamic>? digestMap =
        rawDigest is Map ? rawDigest.cast<String, dynamic>() : null;
    String text = payload["narrationText"]?.toString() ?? "";
    if (text.trim().isEmpty) {
      text = digestMap?["narrationText"]?.toString() ?? "";
    }
    if (text.trim().isEmpty) return;
    // 睡前提醒同为「真实消息」（2026-10-21）：落本地历史，重启后仍在。
    // 只落主会话线程（2026-11-12）：睡前提醒与旁聊无关。
    final ChatMessage digest = ChatMessage(
      messageId:
          "assistant-evening-digest-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _mainSessionKey,
      role: "assistant",
      text: text.trim(),
      timestamp: DateTime.now(),
      contentType: (digestMap != null && digestMap.isNotEmpty)
          ? "evening_digest"
          : "text",
      eveningDigest:
          (digestMap != null && digestMap.isNotEmpty) ? digestMap : null,
    );
    _mainThreadMessages.add(digest);
    _persist(digest);
    notifyListeners();
  }

  /// 主动性消息（agent.proactive_message）→ 一律落对话流文本气泡。
  /// 决策卡已删除（2026-11-04 定调）。2026-11-10 根修（用户定调）：分级
  /// 触达把控全部删除——后台一律系统通知，不再按 normal/high/critical
  /// 分路（normal 级被静默正是「消息发不出来」的客户端侧根源）。
  /// 播放事件内联 TTS（proactive_voice / voice.alarm / voice.speak 共用）。
  /// 未配置 TTS 时静默返回——文本已由对话流或系统通知承载。
  void _playEventTts(Map<String, dynamic> payload) {
    final String? base64 =
        PhoneCallController.extractTtsBase64(payload["tts"]);
    if (base64 != null) {
      unawaited(TtsPlayer.instance.playFromBase64(base64));
    }
  }

  void _handleProactiveMessageEvent(Map<String, dynamic> payload) {
    final String title = payload["title"]?.toString() ?? "Agent 主动联系";
    final String text = payload["text"]?.toString() ?? "";
    final String deliveryId = payload["deliveryId"]?.toString() ?? "";
    if (deliveryId.isNotEmpty) {
      AmbientFeedsController.instance
          .sendProactiveOutcome(deliveryId, "viewed");
    }
    // 「通知即界面」（2026-11-13）：服务端随消息下发 actionIntent —— 同一批动作
    // 同时挂到**通知栏**与**对话气泡**。两个渲染面，同一个 actionId + 同一枚
    // token：在哪儿拍板都一样，服务端只认一次（幂等）。
    final Map<String, dynamic>? intent = payload["actionIntent"] is Map<String, dynamic>
        ? payload["actionIntent"] as Map<String, dynamic>
        : null;
    final List<NotifyAction> actions = NotifyAction.listFromIntent(intent);
    final String intentId = intent?["intentId"]?.toString() ?? "";
    if (_appBackgrounded && text.trim().isNotEmpty) {
      // 手机后台（类微信常在线）：系统通知触达，点开回前台看气泡
      unawaited(LocalNotificationService.show(
        title: title,
        body: text,
        deliveryId: deliveryId.isEmpty ? null : deliveryId,
        intentId: intentId.isEmpty ? null : intentId,
        actions: actions,
      ));
    }
    if (text.trim().isEmpty) return;
    // 应用内顶部弹窗已删除（2026-11-04 定调）：告知类只落对话流气泡，
    // 不再叠加应用内横幅/系统通知；后台触达靠落流 + 重连补投。
    // 手机端定调（2026-10-21）：主动消息是「真实消息」——与正常对话回复
    // 同等地位落本地历史（重启后仍在），而非一次性浮层。
    // 2026-10-26 定调：气泡只放正文（与正常对话格式一致），title 留给
    // 横幅/系统通知；离开时长等缘由由服务端写进正文。
    // 服务端带 messageId 时沿用（首启引导取名卡要挂到该泡下，两端必须同 id）；
    // 其余主动性消息仍由客户端本地生成 id。
    final String serverMessageId = payload["messageId"]?.toString() ?? "";
    // 主动性消息只落主会话线程（2026-11-12 用户定调）：提醒/主动触达与旁聊
    // 无关，此刻即使停在旁聊里也不允许把气泡带进旁聊线程。
    // 离线补推的到点提醒带 firedAt（原定触发时刻，epoch ms）：气泡按原时间
    // 落屏——补推不冒充"刚刚发的"；无 firedAt 的常规主动消息用到达时刻。
    final dynamic rawFiredAt = payload["firedAt"];
    final int? firedAtMs =
        rawFiredAt == null ? null : int.tryParse(rawFiredAt.toString());
    final ChatMessage proactive = ChatMessage(
      messageId: serverMessageId.isNotEmpty
          ? serverMessageId
          : "assistant-proactive-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _mainSessionKey,
      role: "assistant",
      text: text,
      timestamp: firedAtMs != null && firedAtMs > 0
          ? DateTime.fromMillisecondsSinceEpoch(firedAtMs)
          : DateTime.now(),
      // 「通知即界面」（2026-11-13）：同一批动作同时挂到气泡与通知栏——
      // 两个渲染面，同一个 actionId + 同一枚 token。
      notifyActions: actions.isEmpty ? null : actions,
    );
    // 首启引导两泡（kind=first_meeting_intro）：不走「收到即落屏」，进排队通道
    // 按节奏逐条揭示——服务端两条相隔不到一秒，直接 append 会两泡一起刷在
    // 界面里，看不出「一条条发过来」（2026-11-09 反馈）。
    if ((payload["kind"]?.toString() ?? "") == "first_meeting_intro") {
      _enqueueIntroBubble(proactive);
      return;
    }
    _mainThreadMessages.add(proactive);
    _persist(proactive);
    notifyListeners();
  }

  /// 语音条落地（agent.voice.message，与桌面 main.dart:2244 同构）。
  ///
  /// 服务端推来的 payload：messageId / text / transcript / mediaUrl / durationMs /
  /// skippedReason。有 mediaUrl 落 contentType=audio + audio 附件（渲染可重播气泡）；
  /// 无 mediaUrl（TTS 失败降级）落纯文本消息，让用户至少看见内容。
  void _handleVoiceMessageEvent(Map<String, dynamic> payload) {
    final String messageId = payload["messageId"]?.toString() ??
        "voice-${DateTime.now().microsecondsSinceEpoch}";
    final String text = payload["text"]?.toString() ?? "";
    final String transcript = payload["transcript"]?.toString() ?? text;
    final String? mediaUrl = payload["mediaUrl"]?.toString();
    final int durationMs = (payload["durationMs"] as num?)?.toInt() ?? 0;
    final String? skippedReason = payload["skippedReason"]?.toString();

    // 去重：同 messageId 已在任意线程则不重复入列（重连/补投安全）。
    if (_sessionMessages.values.any(
        (list) => list.any((m) => m.messageId == messageId))) {
      return;
    }

    final List<MessageAttachment> attachments = <MessageAttachment>[];
    if (mediaUrl != null && mediaUrl.isNotEmpty) {
      attachments.add(MessageAttachment(
        type: MessageAttachmentType.audio,
        url: mediaUrl,
        durationMs: durationMs,
        transcript: transcript.isEmpty ? null : transcript,
        mimeType: "audio/mpeg",
      ));
    }
    final bool hasAudio = attachments.isNotEmpty;
    final ChatMessage voiceMsg = ChatMessage(
      messageId: messageId,
      sessionId: _mainSessionKey,
      role: "assistant",
      text: hasAudio
          ? ""
          : (transcript.isNotEmpty
              ? transcript
              : (skippedReason?.isNotEmpty == true
                  ? "语音消息生成失败：$skippedReason"
                  : "语音消息生成失败")),
      timestamp: DateTime.now(),
      contentType: hasAudio ? "audio" : "text",
      durationMs: hasAudio && durationMs > 0 ? durationMs : null,
      attachments: attachments,
    );
    _mainThreadMessages.add(voiceMsg);
    _persist(voiceMsg);
    notifyListeners();
  }

  /// 执行一个「拍板」动作（2026-11-13「通知即界面」）。
  ///
  /// 对话内按钮与通知栏按钮共用同一个 actionId + 同一枚 token——两个渲染面，
  /// 一套语义：不管在哪儿点，服务端都只执行一次（幂等）。
  ///
  /// 执行后：气泡上的按钮撤掉（同一条决策拍完就不再留可点的按钮），并落一条
  /// 回执气泡，让用户看见「到底发生了什么」——不回执的话按钮点了像没点。
  Future<void> runNotifyAction(NotifyAction action) async {
    final ActionReceipt receipt = await executeNotifyAction(action);
    final List<ChatMessage> messages = _mainThreadMessages;
    for (int i = 0; i < messages.length; i++) {
      final List<NotifyAction>? acts = messages[i].notifyActions;
      if (acts == null) continue;
      if (!acts.any((NotifyAction a) => a.actionId == action.actionId)) continue;
      messages[i] = messages[i].copyWith(notifyActions: const <NotifyAction>[]);
      break;
    }
    final ChatMessage ack = ChatMessage(
      messageId: "assistant-notify-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _mainSessionKey,
      role: "assistant",
      text: receipt.message,
      timestamp: DateTime.now(),
    );
    messages.add(ack);
    _persist(ack);
    notifyListeners();
  }

  // ===== 首启引导两泡：依次到达（2026-11-09）=====

  /// 两泡之间的最小间隔：像真人连发两条，前一条读得完再来下一条。
  static const Duration _introRevealGap = Duration(milliseconds: 1400);

  /// 已收到但还没落屏的开场白气泡（FIFO）。
  final List<ChatMessage> _introQueue = <ChatMessage>[];
  bool _introPumping = false;
  DateTime? _lastIntroRevealAt;

  /// 早到没处挂的取名卡：messageId → 卡片载荷。
  final Map<String, Map<String, dynamic>> _pendingNameCards =
      <String, Map<String, dynamic>>{};

  bool _disposed = false;

  /// 开场白正在「输入中」（排队中还有气泡没落屏）：页面据此显示打字气泡。
  bool get isIntroTyping => _introQueue.isNotEmpty;

  void _enqueueIntroBubble(ChatMessage m) {
    _introQueue.add(m);
    notifyListeners();
    unawaited(_pumpIntroQueue());
  }

  /// 逐条揭示：第一条立即落屏，之后每条至少间隔 [_introRevealGap]。
  Future<void> _pumpIntroQueue() async {
    if (_introPumping) return;
    _introPumping = true;
    try {
      while (_introQueue.isNotEmpty) {
        final DateTime? last = _lastIntroRevealAt;
        if (last != null) {
          final Duration wait = _introRevealGap - DateTime.now().difference(last);
          if (wait > Duration.zero) {
            await Future<void>.delayed(wait);
          }
        }
        if (_disposed || _introQueue.isEmpty) break;
        final ChatMessage m = _introQueue.removeAt(0);
        // 开场白是首启引导（只发生在主会话）：揭示时若已不在主线程也落主线程。
        _mainThreadMessages.add(m);
        _persist(m);
        _lastIntroRevealAt = DateTime.now();
        // 卡可能比泡先到：泡落屏这一刻补挂。
        _attachPendingNameCard(m.messageId);
        notifyListeners();
      }
    } finally {
      _introPumping = false;
      if (!_disposed) notifyListeners();
    }
  }

  // ===== 接驳确认卡（agent.transfer_reminder，2026-10-18）=====

  /// 接驳提醒落卡：行程段临近到达（如高铁快到站）时服务端推送，往对话流
  /// 追加一张「接驳确认卡」（contentType="transfer_reminder"）。用户在其他
  /// tab 时控制器照常收事件落卡（MobileHomePage IndexedStack 保活），重进
  /// 会话看到同一张卡不重复弹；后台时补一条系统通知触达（同 reminder_popup
  /// 分流）。卡内存态不持久化：重启后消失，时刻窗已过的确认卡无意义。
  void _handleTransferReminderEvent(Map<String, dynamic> payload) {
    final Map<String, dynamic> segment =
        payload["segment"] is Map<String, dynamic>
            ? payload["segment"] as Map<String, dynamic>
            : const <String, dynamic>{};
    final String message = payload["message"]?.toString() ?? "";
    final String from = segment["from"]?.toString() ?? "";
    final String to = segment["to"]?.toString() ?? "";
    if (message.trim().isEmpty && from.isEmpty && to.isEmpty) return;
    if (_appBackgrounded) {
      unawaited(LocalNotificationService.show(
        title: "接驳提醒",
        body: message,
      ));
    }
    _mainThreadMessages.add(ChatMessage(
      messageId: "transfer-reminder-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: _mainSessionKey,
      role: "assistant",
      text: message,
      timestamp: DateTime.now(),
      contentType: "transfer_reminder",
      transferReminder: <String, dynamic>{
        "message": message,
        "segment": Map<String, dynamic>.of(segment),
        if (payload["minutesUntilArrival"] is int)
          "minutesUntilArrival": payload["minutesUntilArrival"] as int,
        "planId": payload["planId"]?.toString() ?? "",
        // 相位（2026-10-18）：pre_arrival 到达提醒 / pre_departure 返程出发提醒
        //（卡面带「导航去车站」）/ missing_time 求补充时刻
        "phase": payload["phase"]?.toString() ?? "",
        "state": "pending",
      },
    ));
    notifyListeners();
  }

  /// 接驳确认卡按钮回调（MobileChatPage 调用）：以用户身份经现有 [send]
  /// 链路发出固定文本（接站/接机由行程段类型决定，后端 Agent 走
  /// ride_hailing 工具真实下单；不用了则回绝并收起卡片），并原地翻转终态。
  /// 已定稿的卡幂等不重复回复。
  void respondTransferReminder(String messageId, bool accept) {
    final int idx = messages.indexWhere((m) => m.messageId == messageId);
    if (idx < 0) return;
    final Map<String, dynamic>? card = messages[idx].transferReminder;
    if (card == null || card["state"]?.toString() != "pending") return;
    final Map<String, dynamic> segment = card["segment"] is Map<String, dynamic>
        ? card["segment"] as Map<String, dynamic>
        : const <String, dynamic>{};
    final String from = segment["from"]?.toString() ?? "";
    final String to = segment["to"]?.toString() ?? "";
    final bool isFlight = segment["type"]?.toString() == "flight";
    final String text =
        accept ? "帮我预约从$from到$to的${isFlight ? "接机" : "接站"}车" : "不用了,我自己安排";
    messages[idx] = messages[idx].copyWith(
      transferReminder: Map<String, dynamic>.of(card)
        ..["state"] = accept ? "accepted" : "declined",
    );
    notifyListeners();
    unawaited(send(text));
  }

  /// 「导航去车站」（接驳出发卡 pre_departure，2026-10-18）：服务端把车站名
  /// 解析成高德 Web 导航 URI（/travel-map/nav/transfer-link，优先坐标、降级
  /// 纯名称），系统浏览器打开即开始导航。不翻转卡片状态——导航与叫车互斥
  /// 但都不代表确认完成；解析/打开失败静默提示，不打断对话。
  Future<void> openTransferNav(String messageId) async {
    final int idx = messages.indexWhere((m) => m.messageId == messageId);
    if (idx < 0) return;
    final Map<String, dynamic>? card = messages[idx].transferReminder;
    if (card == null) return;
    final Map<String, dynamic> segment = card["segment"] is Map<String, dynamic>
        ? card["segment"] as Map<String, dynamic>
        : const <String, dynamic>{};
    final String station = segment["from"]?.toString() ?? "";
    if (station.trim().isEmpty) return;
    try {
      final Uri req =
          Uri.parse("${ApiConfig.httpBase}/travel-map/nav/transfer-link")
              .replace(
                  queryParameters: <String, String>{"name": station.trim()});
      final http.Response res =
          await NbHttp.get(req).timeout(const Duration(seconds: 8));
      final dynamic url = jsonDecode(utf8.decode(res.bodyBytes))["url"];
      if (res.statusCode == 200 &&
          url is String &&
          url.startsWith("https://")) {
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        return;
      }
    } catch (_) {/* 落到底部提示 */}
    // 服务端不可达：退回「发消息让 Agent 引导」的既有链路
    unawaited(send("帮我导航去$station"));
  }

  /// 思考态或流式开始时,确保有一条等待中的助手消息（落在 [threadKey] 线程桶）。
  void _openStreamingMessage(Map<String, dynamic> payload, String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    if (t.streamingMessageId != null) return;
    final String? traceId = payload["traceId"]?.toString();
    final String id = payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty
            ? "assistant-$traceId"
            : "assistant-streaming");
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    list.add(ChatMessage(
      messageId: id,
      sessionId: threadKey,
      role: "assistant",
      text: "",
      timestamp: DateTime.now(),
      streaming: true,
    ));
    t.streamingMessageId = id;
    if (threadKey == _activeSessionKey) notifyListeners();
  }

  void _appendChunk(Map<String, dynamic> payload, String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    // 2026-10-08：手机端此前是「服务端给什么就画什么」，连桌面端已有的
    // [ts:] / DSML 清洗都没接（[上一轮回复中断…[不可信内容围栏…] 事故气泡
    // 因此直透）。这里统一过一次协议帧清洗；服务端出口已净化，此层为兜底。
    final String chunk =
        stripAssistantProtocolFrames(payload["chunk"]?.toString() ?? "");
    final String? traceId = payload["traceId"]?.toString();
    _rememberTraceThread(traceId, threadKey);
    final String id = payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty
            ? "assistant-$traceId"
            : "assistant-streaming");
    // 真·分绿泡：chunk 自带独立泡 id（assistant-<trace>-bN）→ 走分泡追加
    if (_isBubbleId(id)) {
      _appendBubbleChunk(id, traceId, chunk, threadKey);
      return;
    }
    _openStreamingMessage(payload, threadKey);
    if (chunk.isEmpty) return;
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    final int idx = list.indexWhere(
      (m) => m.messageId == t.streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = list[idx];
    list[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text + chunk,
      timestamp: prev.timestamp,
      streaming: true,
      // 保留已挂上的「边说边出图」临时照片，避免后续 chunk 覆盖丢失。
      pendingMediaCards: prev.pendingMediaCards,
    );
    t.processing = true;
    if (threadKey == _activeSessionKey) notifyListeners();
  }

  /// 真·分绿泡：分泡 chunk 追加（2026-11-10 改版：泡完成才整泡落屏）。
  ///
  /// chunk 只进缓冲不进 messages：泡文本在后台攒齐，泡完成（下一泡开 /
  /// done 收口）才入揭示队列按固定间隔逐条弹出。turn_started 建的空占位
  /// （assistant-$traceId，非泡 id）全程保留为本轮流式锚点——继续展示
  /// 「正在输入」，`chat.media_ready` 的照片也挂它，done 收口时才撤。
  /// 泡归属线程在首次 chunk 时登记（[threadKey]，2026-11-12 P1 并发）。
  void _appendBubbleChunk(
    String id,
    String? traceId,
    String rawChunk,
    String threadKey,
  ) {
    final _ThreadTurnState t = _turnOf(threadKey);
    final String chunk = stripAssistantProtocolFrames(rawChunk);
    if (chunk.isEmpty) return;
    // 新泡开=旧泡完：旧泡正文攒齐，入揭示队列等间隔弹出
    if (t.activeBubbleId != null && t.activeBubbleId != id) {
      _enqueueBubbleReveal(t.activeBubbleId!);
    }
    t.activeBubbleId = id;
    t.activeBubbleTrace = (traceId != null && traceId.isNotEmpty)
        ? traceId
        : _bubbleTraceOf(id);
    _bubbleSessionOf.putIfAbsent(id, () => threadKey);
    _bubbleBuffers[id] = (_bubbleBuffers[id] ?? "") + chunk;
    // 占位消息缺失（无 turn_started 直接来 chunk）：补一个空占位当锚点
    if (t.streamingMessageId == null) {
      _openStreamingMessage(<String, dynamic>{
        if (traceId != null && traceId.isNotEmpty) "traceId": traceId,
      }, threadKey);
    }
    t.processing = true;
    if (threadKey == _activeSessionKey) notifyListeners();
  }

  // ===== 分泡揭示泵：泡完成 → 入队 → 按 [_bubbleRevealGap] 间隔逐条落屏 =====

  /// 泡完成入队（旧泡完成 / done 对账 / 异常兜底共用）。
  void _enqueueBubbleReveal(String bubbleId, {String? sessionId}) {
    if (!_revealQueue.any((e) => e.bubbleId == bubbleId)) {
      _revealQueue.add(_PendingBubbleReveal(
        bubbleId: bubbleId,
        traceId:
            _bubbleTraceOf(bubbleId) ?? _activeTraceFor(bubbleId) ?? "",
        sessionId: sessionId ??
            _bubbleSessionOf[bubbleId] ??
            _activeSessionKey,
      ));
    }
    _scheduleNextBubbleReveal();
  }

  /// 找出正在缓冲 [bubbleId] 的线程记录的 trace（多线程并发时逐线程查）。
  String? _activeTraceFor(String bubbleId) {
    for (final _ThreadTurnState t in _turnStates.values) {
      if (t.activeBubbleId == bubbleId) return t.activeBubbleTrace;
    }
    return null;
  }

  /// 排定下一次揭示：队列非空且没有在途定时器时，距上一泡不足
  /// [_bubbleRevealGap] 就补足等待，否则立即弹。
  void _scheduleNextBubbleReveal() {
    if (_revealQueue.isEmpty) return;
    final Timer? pending = _revealTimer;
    if (pending != null && pending.isActive) return;
    final Duration since = DateTime.now().difference(_lastBubbleRevealAt);
    final Duration wait = since >= _bubbleRevealGap
        ? Duration.zero
        : _bubbleRevealGap - since;
    _revealTimer = Timer(wait, () {
      _revealTimer = null;
      if (_revealQueue.isEmpty) return;
      _revealOneBubble(_revealQueue.removeAt(0));
      _lastBubbleRevealAt = DateTime.now();
      _scheduleNextBubbleReveal();
    });
  }

  /// 整泡落屏一条：优先用 done 对账文本，其次用缓冲正文；只剩内部帧的
  /// 泡（清洗后为空）不落屏。
  void _revealOneBubble(_PendingBubbleReveal entry) {
    final String text =
        (_revealFinalText.remove(entry.bubbleId) ??
                _bubbleBuffers.remove(entry.bubbleId) ??
                "")
            .trim();
    final Map<String, dynamic>? attachments =
        _revealAttachments.remove(entry.bubbleId);
    _bubbleSessionOf.remove(entry.bubbleId);
    // 正文为空但带附件（纯卡轮）也必须落屏：此前无条件 return 会让
    // 揭示队列里的卡片一起消失。
    final bool hasAttachments = attachments != null &&
        (attachments["mediaCards"] != null ||
            attachments["summaryCard"] != null ||
            attachments["renderBlocks"] != null ||
            attachments["replyBlocks"] != null ||
            attachments["envelopeBlocks"] != null ||
            attachments["followUps"] != null);
    if (text.isEmpty && !hasAttachments) return;
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      entry.sessionId,
      () => <ChatMessage>[],
    );
    // 防御：已被其他路径（done 直落）挂上的泡不重复落屏
    if (list.any((m) => m.messageId == entry.bubbleId)) return;
    final Map<String, dynamic> att = attachments ?? const <String, dynamic>{};
    list.add(ChatMessage(
      messageId: entry.bubbleId,
      sessionId: entry.sessionId,
      role: "assistant",
      text: text,
      timestamp: DateTime.now(),
      mediaCards: att["mediaCards"] as List<Map<String, dynamic>>?,
      summaryCard: att["summaryCard"] as Map<String, dynamic>?,
      renderBlocks: att["renderBlocks"] as List<Map<String, dynamic>>?,
      replyBlocks: att["replyBlocks"] as List<Map<String, dynamic>>?,
      envelopeBlocks: att["envelopeBlocks"] as List<Map<String, dynamic>>?,
      followUpPrompts: att["followUps"] as List<String>?,
    ));
    _persist(list.last);
    // 不动 isProcessing：done 收口后揭示队列仍在排水（末泡延迟落屏），
    // 此时不能再点亮「处理中」状态条。isProcessing 由轮次事件自己管理。
    if (entry.sessionId == _activeSessionKey) {
      notifyListeners();
    }
  }

  /// 异常收尾兜底（出错 / 断连）：把缓冲与队列里的泡立即整泡落屏（零间隔），
  /// 避免已流出的正文因异常收尾凭空丢失。只提前揭示，不改任何文本。
  /// 所有线程的在途活跃泡一并收口（2026-11-12 P1 多线程并发）。
  void _flushHiddenBubblesNow() {
    for (final _ThreadTurnState t in _turnStates.values) {
      final String? active = t.activeBubbleId;
      if (active != null) {
        _enqueueBubbleReveal(active);
        t.activeBubbleId = null;
      }
    }
    while (_revealQueue.isNotEmpty) {
      _revealOneBubble(_revealQueue.removeAt(0));
    }
    notifyListeners();
  }

  /// 丢弃指定 trace 的未落屏泡（卡片轮转静默）：缓冲 / 队列 / 附件一并清，
  /// 防止出卡片的轮次后来又弹出文字泡。
  void _dropHiddenBubblesForTrace(String traceId) {
    _bubbleBuffers.removeWhere((id, _) => _bubbleTraceOf(id) == traceId);
    _revealFinalText.removeWhere((id, _) => _bubbleTraceOf(id) == traceId);
    _revealAttachments.removeWhere((id, _) => _bubbleTraceOf(id) == traceId);
    _bubbleSessionOf.removeWhere((id, _) => _bubbleTraceOf(id) == traceId);
    _revealQueue.removeWhere((e) => e.traceId == traceId);
    for (final _ThreadTurnState t in _turnStates.values) {
      final String? active = t.activeBubbleId;
      if (active != null && _bubbleTraceOf(active) == traceId) {
        t.activeBubbleId = null;
      }
    }
  }

  /// 会出卡片的轮次不流式（2026-10-08）：服务端确认本轮将携带结构化卡片
  /// （工具附卡/识图照片/模型自产标记）后，先撤回该 trace 已流出的正文并转
  /// 静默，最终内容由 `chat.assistant_done` 一次性结构化下发。这里清空本轮
  /// 所有流式泡的正文（保留占位泡与已挂照片），回到「生成中」观感，杜绝
  /// 「文字打一半 → done 整条重排成卡片」的跳变。
  void _handleStreamReset(Map<String, dynamic> payload, String threadKey) {
    final String? traceId = payload["traceId"]?.toString();
    final String mainId = (traceId != null && traceId.isNotEmpty)
        ? "assistant-$traceId"
        : (_turnOf(threadKey).streamingMessageId ?? "");
    if (mainId.isEmpty) return;
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    // 卡片轮转静默：还在揭示缓冲/队列里的同 trace 泡一并丢弃，
    // 防止出卡片的轮次后来又弹出文字泡
    if (traceId != null && traceId.isNotEmpty) {
      _dropHiddenBubblesForTrace(traceId);
    }
    bool changed = false;
    for (int i = 0; i < list.length; i++) {
      final ChatMessage m = list[i];
      if (!m.streaming || m.text.isEmpty) continue;
      final bool sameTrace = (m.messageId == mainId) ||
          (traceId != null &&
              traceId.isNotEmpty &&
              _bubbleTraceOf(m.messageId) == traceId);
      if (!sameTrace) continue;
      list[i] = ChatMessage(
        messageId: m.messageId,
        sessionId: m.sessionId,
        role: m.role,
        text: "",
        timestamp: m.timestamp,
        streaming: true,
        mediaCards: m.mediaCards,
        renderBlocks: m.renderBlocks,
        replyBlocks: m.replyBlocks,
        pendingMediaCards: m.pendingMediaCards,
      );
      changed = true;
    }
    if (changed && threadKey == _activeSessionKey) notifyListeners();
  }

  /// 边说边出图：`chat.media_ready` 到达时把已搜到的照片先挂到当前流式消息上，
  /// 前端插到正在打字的正文下方实时展示；`chat.assistant_done` 后以
  /// renderBlocks 的最终顺序渲染（pendingMediaCards 被清空由最终消息接管）。
  void _handleMediaReady(Map<String, dynamic> payload, String threadKey) {
    final List<dynamic>? rawCards = payload["cards"] as List<dynamic>?;
    if (rawCards == null || rawCards.isEmpty) return;
    final List<Map<String, dynamic>> cards =
        rawCards.whereType<Map<String, dynamic>>().toList(growable: false);
    if (cards.isEmpty) return;
    final _ThreadTurnState t = _turnOf(threadKey);
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    // 真·分绿泡：分泡轮次媒体照片挂到当前流式泡上（media_ready 的 messageId
    // 恒为 assistant-$traceId 基础 id，不能据此开占位消息，防幻影空泡）
    if (t.streamingMessageId != null && _isBubbleId(t.streamingMessageId!)) {
      final int bIdx = list.indexWhere(
        (m) => m.messageId == t.streamingMessageId,
      );
      if (bIdx >= 0) {
        final ChatMessage prev = list[bIdx];
        list[bIdx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: prev.text,
          timestamp: prev.timestamp,
          streaming: prev.streaming,
          pendingMediaCards: cards,
        );
        if (threadKey == _activeSessionKey) notifyListeners();
        return;
      }
    }
    _openStreamingMessage(payload, threadKey);
    final int idx = list.indexWhere(
      (m) => m.messageId == t.streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = list[idx];
    list[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text,
      timestamp: prev.timestamp,
      streaming: true,
      pendingMediaCards: cards,
    );
    if (threadKey == _activeSessionKey) notifyListeners();
  }

  /// 从 `chat.assistant_done` 载荷解析结构化媒体卡片/交错渲染块。
  /// 与桌面端一致：无字段时返回 null（前端回退纯文本渲染）。
  List<Map<String, dynamic>>? _parseStructuredList(
    Map<String, dynamic> payload,
    String key,
  ) {
    final List<dynamic>? raw = payload[key] as List<dynamic>?;
    if (raw == null || raw.isEmpty) return null;
    final List<Map<String, dynamic>> out =
        raw.whereType<Map<String, dynamic>>().toList(growable: false);
    return out.isEmpty ? null : out;
  }

  /// 「接下来你可以」接续建议（done 载荷 followups，瞬态不持久化）。
  List<String>? _parseFollowUps(Map<String, dynamic> payload) {
    final Object? raw = payload["followups"];
    if (raw is! List) return null;
    final List<String> list = raw
        .map((Object? e) => e?.toString().trim() ?? "")
        .where((String e) => e.isNotEmpty)
        .toList();
    return list.isEmpty ? null : list;
  }

  /// 接续建议只对最新一轮有效：新消息发出即撤掉旧建议——它们以助手小泡
  /// 形态挂在旧消息下面，留着会诱导重复点击过期建议。
  void _clearStaleFollowUps() {
    final List<ChatMessage> list = messages;
    for (int i = 0; i < list.length; i++) {
      if (list[i].followUpPrompts == null) continue;
      list[i] = list[i].copyWith(clearFollowUps: true);
    }
  }

  void _finalizeReply(Map<String, dynamic> payload, String threadKey) {
    final _ThreadTurnState t = _turnOf(threadKey);
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    _rememberTraceThread(payload["traceId"]?.toString(), threadKey);
    // 后台触达（2026-11-10）：用户发完消息切走，回复到达时应用内气泡不可见
    // ——系统通知弹横幅（类微信会话新消息）。卡片轮正文为空不通知；
    // 主动消息/提醒有各自通知通道，这里只管「对话轮的回复」。
    if (_appBackgrounded) {
      String notifyText =
          stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "")
              .trim();
      if (notifyText.isEmpty) {
        final List<Map<String, dynamic>> bgBubbles =
            _parseStructuredList(payload, "bubbles") ??
                const <Map<String, dynamic>>[];
        notifyText = bgBubbles
            .map((b) => b["text"]?.toString() ?? "")
            .where((t2) => t2.trim().isNotEmpty)
            .join("\n")
            .trim();
      }
      if (notifyText.isNotEmpty) {
        final String trimmed = notifyText.length > 120
            ? "${notifyText.substring(0, 120)}…"
            : notifyText;
        unawaited(LocalNotificationService.show(title: "Agent", body: trimmed));
      }
    }
    // 真·分绿泡：带 bubbles 对账数组的轮次按泡收口（不走单泡 finalText 替换）
    final List<Map<String, dynamic>>? bubbles =
        _parseStructuredList(payload, "bubbles");
    if (bubbles != null && bubbles.isNotEmpty) {
      _finalizeBubbles(payload, bubbles, threadKey);
      return;
    }
    // 分泡轮的 done 应走 _finalizeBubbles；万一服务端不带 bubbles 对账
    // 数组（旧版兼容），把揭示缓冲里的泡立即整泡落屏，不留黑洞。
    _flushHiddenBubblesNow();
    final String? traceId = payload["traceId"]?.toString();
    final String? messageId = payload["messageId"]?.toString();
    // 优先用已经打开的流式消息;否则尝试按 trace 对齐
    int idx;
    if (t.streamingMessageId != null) {
      idx = list.indexWhere((m) => m.messageId == t.streamingMessageId);
    } else {
      final String traceKey = traceId != null && traceId.isNotEmpty
          ? "assistant-$traceId"
          : "assistant-final";
      idx = list.indexWhere(
        (m) =>
            m.messageId == traceKey ||
            (messageId != null && m.messageId == messageId),
      );
    }
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    // 结构化媒体卡片 / 交错渲染块 / 回复信封块：与桌面端一致，前端据此渲染
    // 卡片与图文交错，不再把 `[AGENT_RESULT_CARD_START]` 等标记当纯文本展示。
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    // 结构化摘要卡（CONTENT_SUMMARY 通道迁移）：随 done 下发的折叠卡载荷。
    final Map<String, dynamic>? summaryCard =
        payload["summaryCard"] is Map<String, dynamic>
            ? payload["summaryCard"] as Map<String, dynamic>
            : null;
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    // v2 统一信封块（P4）：唯一权威序列，渲染层信封优先；非 v2 帧为 null，
    // 渲染回退旧字段链（零回归）。
    final List<Map<String, dynamic>>? envelopeBlocks =
        extractEnvelopeBlocks(payload);
    final List<String>? followUps = _parseFollowUps(payload);
    if (idx < 0) {
      // 没有流式占位:直接落一条最终消息（整轮只剩内部帧 → 不落空白泡）
      if (finalText.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null &&
          envelopeBlocks == null) {
        t.streamingMessageId = null;
        _resetActivityState(threadKey);
        notifyListeners();
        return;
      }
      list.add(ChatMessage(
        messageId: messageId ?? "assistant-final",
        sessionId: threadKey,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        summaryCard: summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
        envelopeBlocks: envelopeBlocks,
        followUpPrompts: followUps,
      ));
      _persist(list.last);
    } else {
      final ChatMessage prev = list[idx];
      // 整轮只剩系统内部帧（服务端已判为不可见 / 本地清洗后为空）且无任何
      // 结构化产出 → 撤掉空占位泡，不留一条空白助手气泡（2026-10-08）。
      final bool nothingToShow = finalText.trim().isEmpty &&
          prev.text.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null &&
          envelopeBlocks == null;
      if (nothingToShow) {
        list.removeAt(idx);
        t.streamingMessageId = null;
        _resetActivityState(threadKey);
        notifyListeners();
        return;
      }
      list[idx] = ChatMessage(
        messageId: messageId ?? prev.messageId,
        sessionId: prev.sessionId,
        role: prev.role,
        // 摘要卡轮：卡内已是全文，done 的 finalText 为空——流式长文不再留在气泡
        text: summaryCard != null && finalText.trim().isEmpty
            ? ""
            : (finalText.isNotEmpty ? finalText : prev.text),
        timestamp: prev.timestamp,
        streaming: false,
        mediaCards: mediaCards ?? prev.mediaCards,
        summaryCard: summaryCard ?? prev.summaryCard,
        renderBlocks: renderBlocks ?? prev.renderBlocks,
        replyBlocks: replyBlocks ?? prev.replyBlocks,
        envelopeBlocks: envelopeBlocks ?? prev.envelopeBlocks,
        followUpPrompts: followUps,
      );
      _persist(list[idx]);
    }
    t.streamingMessageId = null;
    _resetActivityState(threadKey);
    notifyListeners();
  }

  /// 真·分绿泡 done 收口：逐泡以服务端对账数组定稿；
  /// finalTextReplacesStream=true 时整轮塌缩成单泡（删除全部分泡）。
  /// 全程操作 [threadKey] 线程桶（2026-11-12 P1 并发：不碰其他线程）。
  void _finalizeBubbles(
    Map<String, dynamic> payload,
    List<Map<String, dynamic>> bubbles,
    String threadKey,
  ) {
    final _ThreadTurnState turn = _turnOf(threadKey);
    final List<ChatMessage> list = _sessionMessages.putIfAbsent(
      threadKey,
      () => <ChatMessage>[],
    );
    final String? traceId = payload["traceId"]?.toString();
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    final String traceKey = traceId != null && traceId.isNotEmpty
        ? "assistant-$traceId"
        : "assistant-final";
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    final Map<String, dynamic>? summaryCard =
        payload["summaryCard"] is Map<String, dynamic>
            ? payload["summaryCard"] as Map<String, dynamic>
            : null;
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    // v2 统一信封块（P4）：唯一权威序列。塌缩轮挂完整序列（正文=finalText，
    // 渲染层按块直读不重复）；正常分泡轮只挂非 text 块（正文已在各气泡里）。
    final List<Map<String, dynamic>>? envelopeBlocksAll =
        extractEnvelopeBlocks(payload);
    final List<String>? followUps = _parseFollowUps(payload);
    if (payload["finalTextReplacesStream"] == true) {
      // 塌缩：删除本轮所有分泡（含 id 对账与同 trace 兜底），落单泡 finalText
      list.removeWhere((m) {
        final bool hit =
            bubbles.any((b) => b["id"]?.toString() == m.messageId) ||
                (traceId != null &&
                    traceId.isNotEmpty &&
                    _bubbleTraceOf(m.messageId) == traceId);
        return hit;
      });
      // 还在揭示缓冲/队列里的同 trace 泡一并丢弃（塌缩后不留旧泡）
      if (traceId != null && traceId.isNotEmpty) {
        _dropHiddenBubblesForTrace(traceId);
      }
      // 空占位让位：塌缩单泡 id = assistant-$traceId，与占位同 id，必须先撤
      list.removeWhere(
        (m) => m.streaming && m.text.trim().isEmpty && !_isBubbleId(m.messageId),
      );
      if (finalText.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null &&
          envelopeBlocksAll == null) {
        // 整轮只剩系统内部帧 → 塌缩后也不留空白泡
        turn.streamingMessageId = null;
        _resetActivityState(threadKey);
        notifyListeners();
        return;
      }
      list.add(ChatMessage(
        messageId: traceKey,
        sessionId: threadKey,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        summaryCard: summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
        envelopeBlocks: envelopeBlocksAll,
        followUpPrompts: followUps,
      ));
      _persist(list.last);
      turn.streamingMessageId = null;
      _resetActivityState(threadKey);
      notifyListeners();
      return;
    }
    // 正常收口：空占位让位，逐泡定稿（服务端文本为准），卡片挂末泡。
    // 多泡时块序列只留非 text 块（text 块按全文切分，挂末泡会整段复读）。
    list.removeWhere((m) =>
        m.streaming && m.text.trim().isEmpty && !_isBubbleId(m.messageId));
    List<Map<String, dynamic>>? replyBlocksForLast = replyBlocks;
    List<Map<String, dynamic>>? renderBlocksForLast = renderBlocks;
    // v2 信封块（P4）：多泡时正文已在各气泡里，只留非 text 块挂末泡；
    // media_segments 里夹的文字段同理剥掉（只保 media 段）。单泡轮保留完整
    // 序列（text 块与泡文本同源，渲染层按块直读不重复）。
    List<Map<String, dynamic>>? envelopeBlocksForLast = envelopeBlocksAll;
    if (bubbles.length > 1) {
      if (replyBlocks != null) {
        final List<Map<String, dynamic>> cardOnly = replyBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        replyBlocksForLast = cardOnly.isEmpty ? null : cardOnly;
      }
      if (renderBlocks != null) {
        final List<Map<String, dynamic>> mediaOnly = renderBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        renderBlocksForLast = mediaOnly.isEmpty ? null : mediaOnly;
      }
      if (envelopeBlocksAll != null) {
        final List<Map<String, dynamic>> noText = <Map<String, dynamic>>[];
        for (final Map<String, dynamic> b in envelopeBlocksAll) {
          final String type = b["type"]?.toString() ?? "text";
          if (type == "text" || type == "followups") continue;
          if (type == "media_segments") {
            final Object? segs = b["segments"];
            if (segs is! List) continue;
            final List<Map<String, dynamic>> mediaOnlySegs = segs
                .whereType<Map>()
                .map((Map m) => Map<String, dynamic>.from(m))
                .where((Map<String, dynamic> s) =>
                    s["type"]?.toString() == "media")
                .toList(growable: false);
            if (mediaOnlySegs.isEmpty) continue;
            noText.add(<String, dynamic>{
              "type": "media_segments",
              "segments": mediaOnlySegs,
            });
            continue;
          }
          noText.add(b);
        }
        envelopeBlocksForLast = noText.isEmpty ? null : noText;
      }
    }
    for (int i = 0; i < bubbles.length; i++) {
      final Map<String, dynamic> b = bubbles[i];
      final String id = b["id"]?.toString() ?? "";
      if (id.isEmpty) continue;
      final bool isLast = i == bubbles.length - 1;
      final String text =
          stripAssistantProtocolFrames(b["text"]?.toString() ?? "");
      final int idx = list.indexWhere((m) => m.messageId == id);
      if (idx < 0) {
        // 泡尚未落屏（还在揭示缓冲/队列里，或漏收该泡 chunk）：不直接落屏，
        // 记下对账文本与末泡附件，进揭示队列按间隔弹出（整泡只剩内部帧时
        // 不入队，不弹空泡）
        //
        // 正文为空 ≠ 本轮没内容：纯卡轮（工具只产卡、模型没写正文）的正文
        // 天然是空的，此时卡片全挂在末泡附件上。此前无条件 continue 会把
        // 整组 envelopeBlocks/mediaCards 一起丢掉，用户看到的就是「卡被吞」。
        // 口径对齐桌面 main.dart：有卡就建泡。
        final bool hasAttachments = isLast &&
            (mediaCards != null ||
                summaryCard != null ||
                renderBlocksForLast != null ||
                replyBlocksForLast != null ||
                envelopeBlocksForLast != null ||
                followUps != null);
        if (text.trim().isEmpty && !hasAttachments) continue;
        if (isLast) {
          _revealAttachments[id] = <String, dynamic>{
            if (mediaCards != null) "mediaCards": mediaCards,
            if (summaryCard != null) "summaryCard": summaryCard,
            if (renderBlocksForLast != null) "renderBlocks": renderBlocksForLast,
            if (replyBlocksForLast != null) "replyBlocks": replyBlocksForLast,
            if (envelopeBlocksForLast != null)
              "envelopeBlocks": envelopeBlocksForLast,
            if (followUps != null) "followUps": followUps,
          };
        }
        _revealFinalText[id] = text;
        _enqueueBubbleReveal(id);
      } else {
        final ChatMessage prev = list[idx];
        // 该泡只剩内部帧（清洗后为空）且此前也没流到正文 → 撤泡，不留空白。
        // 但若末泡带着卡/媒体，撤泡会把附件一起删掉，此时必须保留。
        if (text.trim().isEmpty && prev.text.trim().isEmpty) {
          final bool keepForAttachments = isLast &&
              (mediaCards != null ||
                  summaryCard != null ||
                  renderBlocksForLast != null ||
                  replyBlocksForLast != null ||
                  envelopeBlocksForLast != null ||
                  followUps != null);
          if (!keepForAttachments) {
            list.removeAt(idx);
            continue;
          }
        }
        list[idx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          // 末泡挂摘要卡且服务端正文为空：卡内已是全文，不再留流式长文
          text: isLast && summaryCard != null && text.trim().isEmpty
              ? ""
              : (text.isNotEmpty ? text : prev.text),
          timestamp: prev.timestamp,
          mediaCards:
              isLast ? (mediaCards ?? prev.mediaCards) : prev.mediaCards,
          summaryCard:
              isLast ? (summaryCard ?? prev.summaryCard) : prev.summaryCard,
          renderBlocks: isLast
              ? (renderBlocksForLast ?? prev.renderBlocks)
              : prev.renderBlocks,
          replyBlocks: isLast
              ? (replyBlocksForLast ?? prev.replyBlocks)
              : prev.replyBlocks,
          envelopeBlocks: isLast
              ? (envelopeBlocksForLast ?? prev.envelopeBlocks)
              : prev.envelopeBlocks,
          followUpPrompts: isLast ? followUps : null,
          pendingMediaCards: isLast ? null : prev.pendingMediaCards,
          // streaming 不带 → false：定稿
        );
        _persist(list[idx]);
      }
    }
    // 本轮收口：活跃缓冲泡清位；同 trace 的空文本缓冲残留一并清掉
    turn.activeBubbleId = null;
    turn.activeBubbleTrace = null;
    if (traceId != null && traceId.isNotEmpty) {
      _bubbleBuffers.removeWhere((id, _) =>
          _bubbleTraceOf(id) == traceId &&
          !_revealQueue.any((e) => e.bubbleId == id));
      _bubbleSessionOf.removeWhere((id, _) =>
          _bubbleTraceOf(id) == traceId &&
          !_revealQueue.any((e) => e.bubbleId == id));
    }
    turn.streamingMessageId = null;
    _resetActivityState(threadKey);
    notifyListeners();
  }

  /// 行程卡 autoOpen 自动展开（2026-10-12 与桌面端对齐，桌面见 main.dart
  /// done 收口的同名逻辑）：本轮产出带 autoOpen 的 travel_itinerary 卡时，
  /// 经 TravelPlanLauncher 直接打开行程规划页（handler 由 MobileHomePage
  /// 注册）。非 autoOpen 卡只展示卡面，用户点「打开行程规划」再进。
  void _maybeAutoOpenTravelCard(Map<String, dynamic> payload) {
    if (ApiConfig.isOssEdition) return;
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    final AgentResultData? card = AgentResultParser.parse(finalText).data;
    if (card != null && card.cardType == "travel_itinerary" && card.autoOpen) {
      TravelPlanLauncher.open(card);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _introQueue.clear();
    _clockWatchTimer?.cancel();
    _errorHintClearTimer?.cancel();
    _revealTimer?.cancel();
    _browserPreviewIdleTimer?.cancel();
    for (final _ThreadTurnState t in _turnStates.values) {
      t.deliveryStallTimer?.cancel();
      t.deliveryStallTimer = null;
    }
    unawaited(_subscription?.cancel());
    _planFlow?.removeListener(_onPlanFlowChanged);
    _planFlow?.dispose();
    _planFlow = null;
    // 共享连接归进程所有：聊天页销毁不得把整条链路关掉，根状态还要靠它
    // 收闹钟/提醒。自建连接（测试）才自己关闭。
    if (_ownsConnection) _service.close();
    connection.dispose();
    super.dispose();
  }
}

/// 窄口径旅游规划意图（手机端内联规划会话的触发闸）。
///
/// 「规划/安排类动词」与「出行语境」同时命中才算；纯信息问询（几点、
/// 门票、天气、怎么去）不接管，照旧走聊天流由 Agent 回答。口径与历史
/// 交接入口一致，避免「帮我安排去医院」「记一下我的行程」误伤。
bool looksLikeTravelPlanningIntent(String raw) {
  final String s = raw.trim();
  if (s.isEmpty || s.length > 120) return false;
  if (RegExp(r"几点|门票|天气|怎么去|怎么走|在哪|多少钱|票价").hasMatch(s)) {
    return false;
  }
  final bool plannerVerb = RegExp(
    r"规划|计划|攻略|行程|路线|安排|排一?下|排个|制定|定制",
  ).hasMatch(s);
  if (!plannerVerb) return false;
  return RegExp(
    r"旅游|旅行|出游|出行|出去玩|自驾|景点|景区|"
    r"去[\u4e00-\u9fa5]{1,10}(玩|旅游|旅行)|"
    r"[\u4e00-\u9fa5]{1,10}玩[一二三四五六七两八九十字\d]+天|"
    r"[\u4e00-\u9fa5]{1,10}[一二三四五六七两八九十字\d]+天",
  ).hasMatch(s);
}
