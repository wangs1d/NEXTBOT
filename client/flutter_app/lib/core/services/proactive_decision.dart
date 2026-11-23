import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";

import "local_notification_actions.dart";
import "../models/notify_action.dart";

/// §4.4 行 2「App 被杀、厂商通道可用」的客户端侧全部**纯逻辑**（2026-11-30）。
///
/// 一条厂商通知（华为 Push Kit 的系统模板通知）**渲染不出按钮**，所以点开它
/// 之后必须有一个界面把「这条决策的两个按钮」端出来——那就是决策半屏页
/// （[MobileDecisionSheet]）。这个文件管两件与 Flutter 无关的事：
///
///  1. **从载荷里认出这条决策**（[DecisionRequest.parse] /
///     [DecisionRequest.fromProactiveEvent]）：intentId、deliveryId、标题、正文、
///     两枚动作。厂商通知的点击本身到不了 Dart（要原生 IntentFilter，本期不动
///     android/**），所以 intentId 的实际来源是**同一条 WS 连接重连后的补投**：
///     服务端在推送成功时把这条消息记进 ProactiveReplayStore，并打
///     `pushed:true`；点开通知 → 拉起 App → 主连接 session.init → 补投到达 →
///     半屏页。通知栏里直接点开的本地通知（行 1 那条面）走 `_onTap` 的载荷，
///     两条路在这里汇成同一个 [DecisionRequest]。
///  2. **半屏页的状态机**（[DecisionSheetModel]）：一步完成 → 显示服务端回执 →
///     自动关闭；失败则留在页上、把原因说清楚、保留「打开对话」出口。
///
/// 弹不弹的判定全部集中在这两个 parse 函数里（纯函数、可单测）：控件层只负责画。

/// 一次「要点开处理的决策」。
class DecisionRequest {
  const DecisionRequest({
    required this.intentId,
    required this.title,
    required this.body,
    required this.actions,
    this.deliveryId = "",
    this.openChat,
    this.expiresAtMs,
    this.atMs,
    this.source = decisionSourceVendorPush,
  });

  /// 服务端动作意图 id（通知 id 也由它算出，两端同源，见 notification_id.dart）
  final String intentId;
  final String deliveryId;
  final String title;
  final String body;

  /// 并排的决策按钮（服务端已经收口在 ≤2；这里只是不再放大）
  final List<NotifyAction> actions;

  /// 「打开对话」那枚导航动作（厂商推送路径由服务端随视图一起下发；
  /// 本地通知的载荷里没有它时走 [LocalNotificationService] 的导航分支）
  final NotifyAction? openChat;

  /// 这条决策的有效期（服务端签的，过期就不该再弹页）
  final int? expiresAtMs;

  /// 触发/推送时刻（epoch ms），用于「刚才是不是点开的那条」判定
  final int? atMs;

  /// 来源：厂商推送补投 / 本机通知点开（只影响埋点口径，不影响行为）
  final String source;

  bool get hasActions => actions.isNotEmpty;

  /// 通知载荷（[LocalNotificationService.show] 里 jsonEncode 的那一份）→ 决策。
  ///
  /// 认不出 intentId 或没有可拍的动作 → 返回 null（就是一普通通知，正常打开 App）。
  static DecisionRequest? parse(
    Object? rawPayload, {
    required int nowMs,
  }) {
    final Map<String, dynamic>? data = _asMap(rawPayload);
    if (data == null) return null;
    final String intentId = _str(data["intentId"]);
    if (intentId.isEmpty) return null;
    final List<NotifyAction> actions = NotifyAction.listFromIntent(data);
    if (actions.isEmpty) return null;
    return DecisionRequest(
      intentId: intentId,
      deliveryId: _str(data["deliveryId"]),
      title: _str(data["title"]),
      body: _str(data["body"]),
      actions: actions,
      openChat: _openChatOf(data),
      atMs: nowMs,
      source: decisionSourceNotificationTap,
    );
  }

  /// `agent.proactive_message` 的 payload → 决策（厂商推送补投路径）。
  ///
  /// 只在**同时**满足时成立，否则老老实实只落气泡：
  ///  · `pushed == true`：这条是厂商推送弹出去的（通知上没有按钮）；
  ///  · `replay == true`：它是重连补投——点开通知拉起 App 后到达的就是这一条；
  ///  · 服务端还给了动作（没按钮就没有「决策」可做）；
  ///  · 决策没过期，且推送时刻在 [_replayFreshMs] 之内（补投区留 24h，
  ///    昨天没点开的陈年决策不该在今天弹窗）。
  static DecisionRequest? fromProactiveEvent(
    Map<String, dynamic> payload, {
    required int nowMs,
    int maxAgeMs = defaultMaxAgeMs,
  }) {
    if (payload["pushed"] != true) return null;
    if (payload["replay"] != true) return null;
    final Map<String, dynamic>? intent = _asMap(payload["actionIntent"]);
    if (intent == null) return null;
    final String intentId = _str(intent["intentId"]);
    if (intentId.isEmpty) return null;
    final List<NotifyAction> actions = NotifyAction.listFromIntent(intent);
    if (actions.isEmpty) return null;
    final int? expiresAt = _int(intent["expiresAt"]);
    if (expiresAt != null && expiresAt <= nowMs) return null;
    // 推送时刻：落流补投登记的就是原定触发时刻（无则不卡年龄，见末行注释）
    final int? at = _int(payload["firedAt"]);
    if (at != null && nowMs - at > maxAgeMs) return null;
    final String title = _str(payload["title"]);
    final String text = _str(payload["text"]);
    return DecisionRequest(
      intentId: intentId,
      deliveryId: _str(payload["deliveryId"]),
      title: title.isEmpty ? _str(intent["title"]) : title,
      body: text.isEmpty ? _str(intent["body"]) : text,
      actions: actions,
      openChat: _openChatOf(intent),
      expiresAtMs: expiresAt,
      // 没有 firedAt 的旧服务端载荷：按「现在」算，不因此拒绝弹页（宁可多弹一次，
      // 也不让一条真决策静默沉进气泡里）。
      atMs: at ?? nowMs,
      source: decisionSourceVendorPush,
    );
  }

  /// 从补投到达到现在最多愿意为用户弹页的时间窗（比服务端 24h 补投区紧得多）。
  static const int defaultMaxAgeMs = 2 * 60 * 60 * 1000;

  /// 「打开对话」那枚动作：优先取服务端单独下发的 `openChat`（§4.4 半屏页专用，
  /// 不占通知栏的 2 个按钮位）；旧载荷里它可能混在 actions 里，那就从那里取。
  static NotifyAction? _openChatOf(Map<String, dynamic>? data) {
    if (data == null) return null;
    final Object? raw = data["openChat"];
    if (raw is Map) {
      final NotifyAction a = NotifyAction.fromJson(
        raw is Map<String, dynamic> ? raw : raw.cast<String, dynamic>(),
      );
      if (a.actionId.isNotEmpty && a.token.isNotEmpty) return a;
    }
    for (final NotifyAction a in NotifyAction.listFromIntent(data)) {
      if (a.actionId == kOpenChatActionId) return a;
    }
    return null;
  }
}

const String decisionSourceVendorPush = "vendor_push";
const String decisionSourceNotificationTap = "notification_tap";

/// 半屏页的相位。
enum DecisionPhase {
  /// 等着用户拍板（标题 + 正文 + 两个按钮）
  idle,

  /// 已经 POST 出去，等回执（按钮锁住，防连点重复执行）
  sending,

  /// 拍完了：[DecisionSheetModel.message] 是服务端那句回执 → 稍后自动关闭
  receipt,

  /// 没拍成：回执是失败原因，页**不关**（§4.2 规则「不吞失败」），可重试
  failed,
}

/// 决策半屏页的状态机（纯逻辑，`test/proactive_decision_test.dart` 直接跑它）。
///
/// 不变量：
///  · **一步完成**：一次成功的动作 → 显示回执 → 自动关闭（[requestClose]），
///    页面不再要求第二次点击，也不会把用户丢回首页让他自己找那条消息；
///  · **失败留在页上**：没网/过期/已处理，都把服务端（或本地）那句话显示出来，
///    按钮恢复可点，「打开对话」一直在；
///  · **只拍一次板**：sending 期间再点一律忽略——服务端本来也幂等，
///    但页面上不该出现两个回执。
class DecisionSheetModel extends ChangeNotifier {
  DecisionSheetModel({
    required this.request,
    required Future<ActionReceipt> Function(NotifyAction action, String input)
        execute,
    this.autoCloseDelay = const Duration(milliseconds: 1600),
    this.requestClose = _noop,
  }) : _execute = execute;

  final DecisionRequest request;
  final Future<ActionReceipt> Function(NotifyAction action, String input) _execute;

  /// 回执在页上停留多久后自动关闭（0 = 立刻关，测试用）
  final Duration autoCloseDelay;

  /// 关闭页面（由 [MobileDecisionSheet] 注入 `Navigator.pop`；测试注入探针）
  final void Function() requestClose;

  DecisionPhase _phase = DecisionPhase.idle;
  String _message = "";
  bool _ok = false;
  bool _autoClosed = false;
  bool _wantsChat = false;
  Timer? _closeTimer;

  DecisionPhase get phase => _phase;
  String get message => _message;
  bool get ok => _ok;

  /// 用户选的是「打开对话」——页面关闭后主壳要把他带回会话（§4.4 行 2 的兜底出口）
  bool get requestsConversation => _wantsChat;

  /// 是否已经拍过板（决定 UI 还显不显示按钮）
  bool get settled => _phase == DecisionPhase.receipt;

  /// 是否正在等回执
  bool get busy => _phase == DecisionPhase.sending;

  /// 测试/排查用：自动关闭是否已经触发过
  @visibleForTesting
  bool get autoClosed => _autoClosed;

  /// 按钮列表：服务端已经收口在 ≤2，这里再兜一次（半屏页不放第三个执行按钮）
  List<NotifyAction> get actions => request.actions.take(2).toList(growable: false);

  /// 这枚按钮要不要用户先写一句（通知栏的 RemoteInput 在半屏页里就是输入框）
  bool needsInput(NotifyAction action) => action.needsInput;

  /// 拍一个按钮。返回 false = 没发出去（正在处理中 / 该说一句没说）。
  Future<bool> submit(NotifyAction action, {String input = ""}) async {
    if (busy || settled) return false;
    if (action.needsInput && input.trim().isEmpty) {
      _fail("先写一句，再按「${action.label}」。");
      return false;
    }
    _phase = DecisionPhase.sending;
    _message = "";
    notifyListeners();
    final ActionReceipt receipt = await _execute(action, input.trim());
    // execute 期间页面可能已经被划掉（dispose）——那时再 notifyListeners 无意义，
    // 但状态照常更新，close 不再触发（requestClose 由页面自己判 mounted）。
    _ok = receipt.ok;
    _message = receipt.message;
    if (receipt.ok) {
      _phase = DecisionPhase.receipt;
      notifyListeners();
      _scheduleClose();
    } else {
      _fail(receipt.message);
    }
    return true;
  }

  /// 「打开对话」：把决策带进会话（§4.4 行 2 的兜底出口）。
  ///
  /// 有导航动作的 token 就先把它 POST 出去——走的是**既有 action-intent 链路**，
  /// 服务端据此把这条意图置为已处理（并向其它设备广播 action_intent.resolved），
  /// 于是这条决策在所有面上一起收口，半屏页不会第二天又弹一遍。
  /// 没带 token（旧载荷）时退化成纯导航，不谎称已经记上了。
  void openChat() {
    if (request.openChat == null || busy || settled) {
      // 没有可回写的导航动作（旧载荷）／已经拍过板：那就只是把用户带回会话。
      _wantsChat = true;
      close();
      return;
    }
    // 先回写再走：这一步不 await——executeNotifyAction 自带 12s 超时，
    // 让半屏页卡在「正在处理」上等网络，比用户已经走进会话更糟。
    // 服务端幂等，回写失败也只是这条意图留在待处理区（下次补投再收口）。
    unawaited(_execute(request.openChat!, "").then((ActionReceipt r) {
      if (!r.ok && r.message.isNotEmpty) {
        debugPrint("[decision] 打开对话回写未成功（不阻塞导航）: ${r.message}");
      }
    }).catchError((Object e) {
      debugPrint("[decision] 打开对话回写异常（不阻塞导航）: $e");
    }));
    _wantsChat = true;
    close();
  }

  void _fail(String message) {
    _phase = DecisionPhase.failed;
    _ok = false;
    _message = message;
    notifyListeners();
  }

  void _scheduleClose() {
    if (autoCloseDelay <= Duration.zero) {
      close();
      return;
    }
    _closeTimer = Timer(autoCloseDelay, close);
  }

  /// 收起半屏页（自动关闭 / 用户划走都会走这里，只生效一次）
  void close() {
    if (_autoClosed) return;
    _autoClosed = true;
    _closeTimer?.cancel();
    _closeTimer = null;
    requestClose();
  }

  @override
  void dispose() {
    _closeTimer?.cancel();
    _closeTimer = null;
    super.dispose();
  }
}

void _noop() {}

Map<String, dynamic>? _asMap(Object? raw) {
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return raw.cast<String, dynamic>();
  if (raw is String && raw.trim().isNotEmpty) {
    try {
      final Object? decoded = jsonDecode(raw);
      return _asMap(decoded);
    } catch (_) {
      return null;
    }
  }
  return null;
}

String _str(Object? v) => v?.toString() ?? "";

int? _int(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v);
  return null;
}
