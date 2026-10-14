import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:permission_handler/permission_handler.dart";

/// 移动端系统通知（类微信常在线提醒的最后一环）：
/// App 在后台/锁屏时收到 WS 主动消息与日程提醒，用系统通知触达——通知即弹窗，
/// 点开回前台并按 deliveryId 回传 outcome。App 在前台时仍走应用内弹窗，不重复打扰。
/// 仅 Android/iOS 生效（Windows 桌面通知卡见 GlassNotify 应用内玻璃卡）。
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
    try {
      final Map<String, dynamic> data =
          jsonDecode(payload) as Map<String, dynamic>;
      final String? deliveryId = data["deliveryId"]?.toString();
      if (deliveryId != null && deliveryId.isNotEmpty) {
        onOutcome?.call(deliveryId, "accepted");
      }
    } catch (e) {
      debugPrint("[local-notification] payload parse failed: $e");
    }
  }

  static Future<void> show({
    required String title,
    required String body,
    String? deliveryId,
  }) async {
    if (!_initialized) return;
    const AndroidNotificationDetails androidDetails =
        AndroidNotificationDetails(
      "proactive",
      "主动提醒",
      channelDescription: "Agent 主动消息与日程提醒",
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
    );
    const DarwinNotificationDetails iosDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentSound: true,
      interruptionLevel: InterruptionLevel.timeSensitive,
    );
    const NotificationDetails details = NotificationDetails(
      android: androidDetails,
      iOS: iosDetails,
    );
    await _plugin.show(
      id: (deliveryId?.hashCode ?? DateTime.now().millisecondsSinceEpoch) & 0x7fffffff,
      title: title,
      body: body,
      notificationDetails: details,
      payload: deliveryId == null ? null : jsonEncode({"deliveryId": deliveryId}),
    );
  }
}
