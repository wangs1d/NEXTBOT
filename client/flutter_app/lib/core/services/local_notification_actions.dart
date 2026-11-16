import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "../models/notify_action.dart";
import "notification_id.dart";

/// 通知栏动作的后台回调（2026-11-13「通知即界面」）。
///
/// **必须是顶层函数 + `@pragma('vm:entry-point')`**——它在后台 isolate 里跑，
/// 插件靠这个注解保证函数不被 tree-shaking 掉。
///
/// 为什么在后台 isolate 里直连 HTTP（而不是走 WS）：
///   用户点按钮的时候 App 可能已经被杀，WS 不存在。而 token 本身就是凭据
///   （服务端 HMAC 签名 + 过期 + 幂等），所以一次 HTTP POST 就够了——
///   不需要 App 活着、不需要登录态、不需要 WS 通道。
@pragma("vm:entry-point")
void localNotificationActionBackground(NotificationResponse response) {
  unawaited(executeNotificationAction(response));
}

/// 执行通知栏上被点中的动作（主 isolate 与后台 isolate 共用同一条链路）。
///
/// 幂等由服务端保证：同一点击重复到达只会执行一次。
Future<void> executeNotificationAction(NotificationResponse response) async {
  final String? raw = response.payload;
  if (raw == null || raw.isEmpty) return;
  Map<String, dynamic> data;
  try {
    data = jsonDecode(raw) as Map<String, dynamic>;
  } catch (e) {
    debugPrint("[notify-action] payload parse failed: $e");
    return;
  }
  final String actionId = response.actionId ?? "";
  if (actionId.isEmpty) return;

  // 与 NotifyAction.listFromIntent 同一个解析器——通知载荷里的 actions 就是
  // 服务端 actionIntent.actions 的原样内嵌，不再手写第二遍解析。
  NotifyAction? parsed;
  for (final NotifyAction a in NotifyAction.listFromIntent(data)) {
    if (a.actionId == actionId) {
      parsed = a;
      break;
    }
  }
  if (parsed == null) {
    debugPrint("[notify-action] 找不到动作 $actionId（通知载荷已过期？）");
    return;
  }

  final String intentId = data["intentId"]?.toString() ?? "";
  final String deliveryId = data["deliveryId"]?.toString() ?? "";
  final int notifyId = notificationIdFor(
    intentId.isNotEmpty ? intentId : deliveryId,
  );

  final ActionReceipt receipt = await executeNotifyAction(
    parsed,
    input: response.input ?? "",
  );
  // 回执**原地替换**原通知（不新推一条）：通知栏里那条就地变成结果
  await _showReceipt(notifyId, receipt.ok ? "已处理" : "没处理成", receipt.message);
}

/// 动作执行结果（回执文案 + 成功与否）
class ActionReceipt {
  const ActionReceipt({required this.ok, required this.message});
  final bool ok;
  final String message;
}

/// 执行一个动作（通知栏按钮 / 对话内拍板按钮走的是同一条链路）。
///
/// 凭据是服务端签好的一次性 token——它本身就是授权，所以这里不需要登录态、
/// 不需要 WS、也不需要 App 进程活着（后台 isolate 直连即可）。
Future<ActionReceipt> executeNotifyAction(
  NotifyAction action, {
  String input = "",
}) async {
  String base;
  try {
    base = ApiConfig.httpBase;
  } catch (e) {
    debugPrint("[notify-action] 拿不到服务端地址: $e");
    return const ActionReceipt(
      ok: false,
      message: "这台设备没烤进服务器地址，点开后回 App 处理。",
    );
  }
  try {
    final http.Response res = await http
        .post(
          Uri.parse("$base/api/action-intents/execute"),
          headers: <String, String>{"Content-Type": "application/json"},
          body: jsonEncode(<String, dynamic>{
            "token": action.token,
            if (input.isNotEmpty) "input": input,
          }),
        )
        .timeout(const Duration(seconds: 12));
    Map<String, dynamic> body = <String, dynamic>{};
    try {
      if (res.body.isNotEmpty) {
        body = jsonDecode(res.body) as Map<String, dynamic>;
      }
    } catch (_) {
      /* 非 JSON 响应按状态码给一句话 */
    }
    final bool ok = res.statusCode == 200 && body["ok"] == true;
    final String message = body["message"]?.toString() ??
        body["error"]?.toString() ??
        (ok ? "已处理" : "没处理成");
    return ActionReceipt(ok: ok, message: message);
  } catch (e) {
    debugPrint("[notify-action] 执行失败: $e");
    return const ActionReceipt(
      ok: false,
      message: "连不上服务器，等你回 App 再处理。",
    );
  }
}

/// 回执**原地替换**原通知（不新推一条）：用户点完按钮，通知栏里那条就地变成结果。
/// 这正是「通知即界面」的关键——不刷屏，不留半截待办。
Future<void> _showReceipt(int notifyId, String title, String body) async {
  if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return;
  try {
    final FlutterLocalNotificationsPlugin plugin = FlutterLocalNotificationsPlugin();
    await plugin.show(
      id: notifyId,
      title: title,
      body: body,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          "proactive",
          "主动提醒",
          importance: Importance.high,
          priority: Priority.high,
          category: AndroidNotificationCategory.status,
          autoCancel: true,
        ),
        iOS: DarwinNotificationDetails(
          presentAlert: true,
          presentSound: true,
        ),
      ),
    );
  } catch (e) {
    debugPrint("[notify-action] 回执通知展示失败: $e");
  }
}
