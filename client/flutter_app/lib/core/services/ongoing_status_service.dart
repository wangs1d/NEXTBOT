import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "../models/notify_action.dart";
import "agent_name_store.dart";
import "local_notification_actions.dart";
import "nb_http.dart";
import "ws_event_router.dart"
    show WsEventCatalog, WsEventRouter, WsSubscribeScope;

/// 常驻状态栏通知（2026-11-23 主动触达 §5.2）。
///
/// 这条通知本来就有——保活前台服务必须挂一条。本服务做的事是让它说有用的话：
/// 内容来自服务端 today-board（排序、脱敏都在服务端算好），到达有两条路：
///   - `agent.today_board` 推送：投递单元变化、通知按钮执行后；
///   - `GET /api/widget/today`：冷启动与重连后的第一帧（推送只发给变化时刻在线的人）。
///
/// 原生侧只贴字与画按钮，模式（完整/极简/关闭）也存在原生：
/// 状态栏那行字要在 App 被杀之后仍然正确，把它存在 Dart 内存里就等于没有。
class OngoingStatusService {
  OngoingStatusService._();

  static final OngoingStatusService instance = OngoingStatusService._();

  static const MethodChannel _channel = MethodChannel("nextbot/ongoing_status");

  bool _started = false;
  bool _busy = false;

  /// 最近一帧看板：改了管家名要用它就地重画，否则极简模式那行字要等到下一次推送才换。
  Map<String, dynamic>? _lastBoard;

  /// 幂等：bootstrap 拉起保活服务后调用。仅 Android。
  Future<void> start() async {
    if (_started || kIsWeb || !Platform.isAndroid) return;
    _started = true;

    _channel.setMethodCallHandler(_onNativeCall);
    AgentNameStore.instance.name.addListener(_redraw);

    WsEventRouter.instance.subscribe(
      module: "ongoing-status",
      types: <String>{...WsEventCatalog.todayBoard, ...WsEventCatalog.connectionState},
      scope: WsSubscribeScope.root,
      onEvent: (Map<String, dynamic> event) {
        final String type = event["type"]?.toString() ?? "";
        if (type == "agent.today_board") {
          _apply(event["payload"]);
          return;
        }
        // 重连后主动拉一帧：断线期间的事项变化不会有推送补投
        if (type == "ws_connected") unawaited(refresh());
      },
    );

    await refresh();
    _scheduleHourly();
  }

  /// 整点重拉（§5.2 更新时机）：倒计时是服务端算好的一句话，不刷新就挂着过期的「还有 40 分钟」。
  /// 先对齐到下一个整点再起周期，否则刷新点随启动时刻漂移。计时器与常驻通知同生命周期——
  /// 这条通知要显示到 App 进程结束为止，没有需要停下它的时刻。
  void _scheduleHourly() {
    final DateTime now = DateTime.now();
    final Duration toNextHour =
        DateTime(now.year, now.month, now.day, now.hour + 1).difference(now);
    Timer(toNextHour, () {
      unawaited(refresh());
      Timer.periodic(const Duration(hours: 1), (_) => unawaited(refresh()));
    });
  }

  /// 拉一次看板（冷启动 / 重连 / 登出换身份 / 按钮执行后）。失败静默：状态栏留着上一帧就是对的。
  Future<void> refresh() async {
    if (_busy || kIsWeb || !Platform.isAndroid) return;
    _busy = true;
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/widget/today").replace(
        queryParameters: <String, String>{"userId": ApiConfig.effectiveActorId},
      );
      final http.Response res = await NbClient()
          .get(uri, headers: NbHttp.headersFor(uri))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return;
      _apply(jsonDecode(utf8.decode(res.bodyBytes)));
    } catch (e) {
      debugPrint("[ongoing-status] 拉取看板失败: $e");
    } finally {
      _busy = false;
    }
  }

  /// 模式：full（看板两行 + 按钮）/ minimal（只显示管家名）/ off（回到纯保活文案）。
  Future<void> setMode(String mode) async {
    try {
      await _channel.invokeMethod<void>("setMode", <String, dynamic>{"mode": mode});
    } on MissingPluginException {
      /* 非 Android */
    } catch (e) {
      debugPrint("[ongoing-status] setMode($mode) failed: $e");
    }
  }

  Future<String> mode() async {
    try {
      return await _channel.invokeMethod<String>("getMode") ?? "full";
    } on Exception {
      return "full";
    }
  }

  /// 用已缓存的那一帧原地重画（改了管家名之后不需要再打一次服务端）。
  void _redraw() {
    final Map<String, dynamic>? last = _lastBoard;
    if (last != null) _apply(last);
  }

  void _apply(Object? raw) {
    if (raw is! Map) return;
    final Map<String, dynamic> board = Map<String, dynamic>.from(raw);
    if (board["ok"] != true) return;
    _lastBoard = board;
    final Map<String, dynamic>? action = board["completeAction"] is Map
        ? Map<String, dynamic>.from(board["completeAction"] as Map)
        : null;
    final Map<String, dynamic>? next = board["nextEvent"] is Map
        ? Map<String, dynamic>.from(board["nextEvent"] as Map)
        : null;
    try {
      unawaited(_channel.invokeMethod<void>("update", <String, dynamic>{
        "title": board["title"]?.toString() ?? "",
        "text": board["text"]?.toString() ?? "",
        // 桌面小组件（§5.3）拿整块看板 JSON，4×2 直接按行渲染而不是拆 "·" 字符串
        "widgetState": jsonEncode(board),
        "httpBase": ApiConfig.httpBase,
        // 极简模式那一行显示管家名。没取名就不传，原生保留上一次的值得继续用
        // （App 被杀后 AgentNameStore 是空的，传空串会把已经显示的名字抹掉）。
        if ((AgentNameStore.instance.name.value ?? "").isNotEmpty)
          "minimalTitle": AgentNameStore.instance.name.value,
        // 按钮与「下一件事」同生同灭：服务端没签 token 就是没有可完成的事
        if (action != null && next != null) ...<String, dynamic>{
          "actionId": action["actionId"]?.toString() ?? "",
          "label": action["label"]?.toString() ?? "完成",
          "token": action["token"]?.toString() ?? "",
          "taskId": next["taskId"]?.toString() ?? "",
        },
      }));
    } on MissingPluginException {
      /* 非 Android */
    } catch (e) {
      debugPrint("[ongoing-status] 更新常驻通知失败: $e");
    }
  }

  /// 通知上的「完成」按钮：与聊天卡按钮、主动消息通知按钮走同一条执行链路。
  Future<Object?> _onNativeCall(MethodCall call) async {
    if (call.method != "ongoingTap") return null;
    final Map<dynamic, dynamic> args =
        call.arguments is Map ? call.arguments as Map : const <dynamic, dynamic>{};
    final String token = args["token"]?.toString() ?? "";
    if (token.isEmpty) return null;
    final ActionReceipt receipt = await executeNotifyAction(
      NotifyAction(
        actionId: args["actionId"]?.toString() ?? "schedule.complete",
        label: args["label"]?.toString() ?? "完成",
        token: token,
      ),
    );
    // 成功后服务端会随任务变更推一帧新看板；这里再主动拉一次，
    // 覆盖「WS 恰好没连上」的情形——按钮按下去必须看得见结果。
    if (receipt.ok) unawaited(refresh());
    return <String, dynamic>{"ok": receipt.ok, "message": receipt.message};
  }
}
