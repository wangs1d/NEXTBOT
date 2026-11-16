import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:permission_handler/permission_handler.dart";

import "local_notification_actions.dart";
import "notification_id.dart";
import "../models/notify_action.dart";

export "../models/notify_action.dart";

/// 通知 id 统一口径（2026-11-13）——见 notification_id.dart（与服务端逐字对齐）。
///
/// 移动端系统通知（类微信常在线提醒的最后一环）：
/// App 在后台/锁屏时收到 WS 主动消息与日程提醒，用系统通知触达——通知即弹窗，
/// 点开回前台并按 deliveryId 回传 outcome。App 在前台时仍走应用内弹窗，不重复打扰。
/// 仅 Android/iOS 生效（Windows 桌面通知卡见 GlassNotify 应用内玻璃卡）。
///
/// 2026-11-13「通知即界面」：通知可以**带按钮**——按钮背后是一个签了名的一次性
/// token，点下去由后台 isolate 直连服务端执行（App 被杀也能执行）。
class LocalNotificationService {
  LocalNotificationService._();

  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// 通知点按回调（main.dart 注入：回传 outcome 反馈）
  static void Function(String deliveryId, String outcome)? onOutcome;

  static Future<void> init() async {
    if (_initialized || kIsWeb || !(Platform.isAndroid || Platform.isIOS)) {
      return;
    }
    const AndroidInitializationSettings androidInit =
        AndroidInitializationSettings("@mipmap/ic_launcher");
    const DarwinInitializationSettings iosInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    await _plugin.initialize(
      settings: const InitializationSettings(android: androidInit, iOS: iosInit),
      onDidReceiveNotificationResponse: _onTap,
      // 后台 isolate 回调：App 被杀时点通知栏按钮仍能执行（2026-11-13）
      onDidReceiveBackgroundNotificationResponse: localNotificationActionBackground,
    );
    if (Platform.isAndroid) {
      // Android 13+ 运行时通知权限
      final PermissionStatus status = await Permission.notification.request();
      debugPrint("[local-notification] permission=$status");
      // 显式创建 HIGH 重要性渠道（2026-10-13）：厂商推送（JPush 离线必达）的服务端
      // payload 指定 channel_id="proactive"——渠道必须在首条推送到达前就存在，
      // 否则落默认渠道（静默进通知栏，无顶部横幅弹窗）。init 时建好，双路径
      // （WS 在线 / 厂商推送离线）共用同一渠道，横幅+声音+振动。
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(
            const AndroidNotificationChannel(
              "proactive",
              "主动提醒",
              description: "Agent 主动消息与日程提醒（横幅弹窗）",
              importance: Importance.high,
              playSound: true,
              enableVibration: true,
              showBadge: true,
            ),
          );
    }
    _initialized = true;
  }

  static void _onTap(NotificationResponse response) {
    final String? payload = response.payload;
    if (payload == null || payload.isEmpty) return;
    Map<String, dynamic> data;
    try {
      data = jsonDecode(payload) as Map<String, dynamic>;
    } catch (e) {
      debugPrint("[local-notification] payload parse failed: $e");
      return;
    }
    // 点了按钮（App 在前台时插件也可能走这条回调）：执行动作。
    // 与后台 isolate 走的是同一条服务端链路，服务端幂等——两条都到也只执行一次。
    if ((response.actionId ?? "").isNotEmpty) {
      unawaited(executeNotificationAction(response));
      return;
    }
    final String? deliveryId = data["deliveryId"]?.toString();
    if (deliveryId != null && deliveryId.isNotEmpty) {
      onOutcome?.call(deliveryId, "accepted");
    }
  }

  static Future<void> show({
    required String title,
    required String body,
    String? deliveryId,
    String? intentId,
    List<NotifyAction> actions = const <NotifyAction>[],
  }) async {
    if (!_initialized) return;
    // Android 13+ 通知权限未授权时，插件的 show 是静默 no-op——用户侧表现
    // 即「后台触达全盲但毫无日志」。这里显式探测一次并打日志，便于诊断。
    if (Platform.isAndroid) {
      try {
        final PermissionStatus status = await Permission.notification.status;
        if (!status.isGranted) {
          debugPrint(
              "[local-notification] permission=$status 通知不会展示"
              "（系统设置里需开启 App 通知权限）");
          return;
        }
      } catch (e) {
        debugPrint("[local-notification] permission probe failed: $e");
      }
    }
    // 动作 → Android Notification Action（按钮）；input 类动作带 RemoteInput，
    // 用户可以直接在通知栏里回一句话（不必点开 App）。
    final List<AndroidNotificationAction> androidActions =
        actions.take(3).map((NotifyAction a) {
      return AndroidNotificationAction(
        a.actionId,
        a.label,
        showsUserInterface: false,
        cancelNotification: true,
        inputs: a.needsInput
            ? <AndroidNotificationActionInput>[
                AndroidNotificationActionInput(
                  label: a.inputLabel,
                  allowFreeFormInput: a.allowFreeFormInput ?? true,
                  choices: a.inputChoices ?? const <String>[],
                ),
              ]
            : const <AndroidNotificationActionInput>[],
      );
    }).toList();

    final AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
      "proactive",
      "主动提醒",
      channelDescription: "Agent 主动消息与日程提醒",
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      actions: androidActions,
    );
    const DarwinNotificationDetails iosDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentSound: true,
      interruptionLevel: InterruptionLevel.timeSensitive,
    );
    final NotificationDetails details = NotificationDetails(
      android: androidDetails,
      iOS: iosDetails,
    );

    // 通知 id 统一口径：有 intent 用 intent，没有就用 delivery（与服务端同源）
    final String idKey = (intentId != null && intentId.isNotEmpty)
        ? intentId
        : (deliveryId ?? "nb-${DateTime.now().millisecondsSinceEpoch}");

    final Map<String, dynamic> payloadMap = <String, dynamic>{
      if (deliveryId != null && deliveryId.isNotEmpty) "deliveryId": deliveryId,
      if (intentId != null && intentId.isNotEmpty) "intentId": intentId,
      if (actions.isNotEmpty)
        "actions": actions.take(3).map((NotifyAction a) => a.toJson()).toList(),
    };

    await _plugin.show(
      id: notificationIdFor(idKey),
      title: title,
      body: body,
      notificationDetails: details,
      payload: jsonEncode(payloadMap),
    );
  }
}
