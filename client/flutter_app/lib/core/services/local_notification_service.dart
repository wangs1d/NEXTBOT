import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:permission_handler/permission_handler.dart";

import "client_telemetry.dart";
import "local_notification_actions.dart";
import "notification_id.dart";
import "proactive_decision.dart";
import "ws_event_router.dart"
    show WsEventCatalog, WsEventRouter, WsSubscribeScope, wsEventPayload;
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

  /// 「点开一条带决策的通知」（2026-11-30 §4.4 行 2）：main.dart 注入，
  /// 负责把 [DecisionRequest] 端成决策半屏页。
  ///
  /// 为什么要有这个回调而不是在通知服务里直接弹卡：本服务是**无界面层**的
  /// （还要被后台 isolate 复用），拿不到 BuildContext；半屏页必须挂在手机主壳
  /// 那个 MaterialApp 的导航器上（与 QuickNoteSheet 同一个坑位）。
  static void Function(DecisionRequest decision)? onDecisionTap;

  /// [requestNotificationPermission] 默认 true，保持既有调用语义。
  /// 手机端冷启动传 false：通知权限改到「注册/登录成功进入主壳」时再申请
  /// （main.dart 的 _ensureMobileNotificationPermission），避免在登录门禁页
  /// 就弹系统权限框。插件初始化与通知渠道照常建好，不影响离线推送。
  static Future<void> init({bool requestNotificationPermission = true}) async {
    if (_initialized || kIsWeb || !(Platform.isAndroid || Platform.isIOS)) {
      return;
    }
    const AndroidInitializationSettings androidInit =
        AndroidInitializationSettings("@mipmap/ic_launcher");
    final DarwinInitializationSettings iosInit = DarwinInitializationSettings(
      requestAlertPermission: requestNotificationPermission,
      requestBadgePermission: requestNotificationPermission,
      requestSoundPermission: requestNotificationPermission,
    );
    await _plugin.initialize(
      settings: InitializationSettings(android: androidInit, iOS: iosInit),
      onDidReceiveNotificationResponse: _onTap,
      // 后台 isolate 回调：App 被杀时点通知栏按钮仍能执行（2026-11-13）
      onDidReceiveBackgroundNotificationResponse: localNotificationActionBackground,
    );
    if (Platform.isAndroid) {
      // Android 13+ 运行时通知权限（只在调用方要求时申请；手机端延后到进主壳）
      if (requestNotificationPermission) {
        final PermissionStatus status = await Permission.notification.request();
        debugPrint("[local-notification] permission=$status");
      }
      // 显式创建 HIGH 重要性渠道（2026-10-13 建 / 2026-11-23 修条件嵌套）：
      // 厂商推送（HMS 等）的服务端 payload 指定 channel_id="proactive"，渠道必须
      // 在首条推送到达前就存在，否则华为直接丢弃这条通知（实测：网关返回
      // 80000000 Success，手机上什么都没有）。**建渠道与申请权限是两件事**，
      // 旧写法 `Platform.isAndroid && requestNotificationPermission` 把两者绑在
      // 一个 if 里，而手机端 init 传的正是 requestNotificationPermission=false
      // （权限延后到进主壳才申请）→ 渠道从未创建 → 离线推送 100% 弹不出来。
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
      // 渠道被用户关掉的埋点（2026-11-23 M1，护栏指标）：每次启动查一次。
      unawaited(_reportDisabledChannels());
    }
    // 跨端消除（2026-11-23 M1）：别的设备/对话里已经处理掉的通知，本机收起。
    _ensureResolveSubscription();
    _initialized = true;
  }

  static bool _resolveWired = false;

  static void _ensureResolveSubscription() {
    if (_resolveWired) return;
    _resolveWired = true;
    WsEventRouter.instance.subscribe(
      module: "notification-resolve-sync",
      types: WsEventCatalog.notificationResolve,
      scope: WsSubscribeScope.auto,
      onEvent: (Map<String, dynamic> event) {
        final Map<String, dynamic> p = wsEventPayload(event);
        final String intentId = p["intentId"]?.toString() ?? "";
        final String deliveryId = p["deliveryId"]?.toString() ?? "";
        return dismissIfPending(intentId.isNotEmpty ? intentId : deliveryId);
      },
    );
  }

  /// 收起一条**还带按钮**的通知（已经变成回执的不动——那是本机刚点完的结果，
  /// 要留给用户看一眼）。找不到这条通知（早被划掉/从没弹过）就什么都不做。
  static Future<void> dismissIfPending(String idKey) async {
    if (idKey.isEmpty || kIsWeb || !Platform.isAndroid) return;
    final int id = notificationIdFor(idKey);
    try {
      final AndroidFlutterLocalNotificationsPlugin? android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      final List<ActiveNotification> active =
          await android?.getActiveNotifications() ?? const <ActiveNotification>[];
      for (final ActiveNotification n in active) {
        if (n.id != id) continue;
        if (kReceiptTitles.contains(n.title)) return;
        await _plugin.cancel(id: id);
        return;
      }
    } catch (e) {
      debugPrint("[local-notification] dismiss failed: $e");
    }
  }

  static Future<void> _reportDisabledChannels() async {
    try {
      final AndroidFlutterLocalNotificationsPlugin? android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android == null) return;
      if (await android.areNotificationsEnabled() == false) {
        ClientEventTelemetry.track("notif_channel_disabled",
            props: const <String, Object>{"channelId": "_app"});
        return;
      }
      final List<AndroidNotificationChannel>? channels =
          await android.getNotificationChannels();
      for (final AndroidNotificationChannel c in channels ?? const <AndroidNotificationChannel>[]) {
        if (c.importance == Importance.none) {
          ClientEventTelemetry.track("notif_channel_disabled",
              props: <String, Object>{"channelId": c.id});
        }
      }
    } catch (e) {
      debugPrint("[local-notification] channel probe failed: $e");
    }
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
    // 「打开对话」例外：它是导航按钮（见 show() 里的 showsUserInterface），
    // 按下去等同于点开通知——记一次「看到了」的正反馈，不 POST 也不回执。
    final String tappedAction = response.actionId ?? "";
    if (tappedAction.isNotEmpty && tappedAction != kOpenChatActionId) {
      unawaited(executeNotificationAction(response));
      return;
    }
    final String? deliveryId = data["deliveryId"]?.toString();
    if (deliveryId != null && deliveryId.isNotEmpty) {
      onOutcome?.call(deliveryId, "accepted");
    }
    ClientEventTelemetry.track("proactive_opened",
        deliveryId: deliveryId,
        props: const <String, Object>{"surface": "notification"});
    // §4.4 行 2：点开通知 = 要处理这条决策。载荷里带得出 intentId + 动作
    // （见 show() 的 payloadMap，服务端厂商推送的 data 用的是同一套键名），
    // 就把它交给主壳端出的决策半屏页；认不出决策（普通通知）就什么都不做。
    final DecisionRequest? decision =
        DecisionRequest.parse(data, nowMs: DateTime.now().millisecondsSinceEpoch);
    if (decision != null) onDecisionTap?.call(decision);
  }

  static Future<void> show({
    required String title,
    required String body,
    String? deliveryId,
    String? intentId,
    List<NotifyAction> actions = const <NotifyAction>[],
    // 「为什么是现在」一句话（§3.10，服务端 explainTiming 产出）：进通知的
    // 副题行（subText），同一条 proactive 渠道、不新建渠道；缺省不带不动通知形态。
    String? why,
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
    //
    // 「打开对话」（§4.3 轮次用完后的留存按钮）要的是**导航**而不是回执行：
    // showsUserInterface=true 让插件把 PendingIntent 建成 getActivity，按下去
    // 直接把 App 拉到前台（其余按钮是 false → 后台 isolate 广播，App 被杀也能执行）。
    final List<AndroidNotificationAction> androidActions =
        actions.take(3).map((NotifyAction a) {
      return AndroidNotificationAction(
        a.actionId,
        a.label,
        showsUserInterface: a.actionId == kOpenChatActionId,
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

    // 「为什么是现在」一句话（§3.10，服务端 explainTiming 产出）：走 Android
    // subText 副题行（标题下方一行小字），同一条 proactive 渠道、不新建渠道，
    // 正文 body 一字不动；iOS 无副题槽位，忽略即可（点开回 App 长按气泡同样能看）。
    final String? whyLine = (why ?? "").trim().isEmpty ? null : why!.trim();
    final AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
      "proactive",
      "主动提醒",
      channelDescription: "Agent 主动消息与日程提醒",
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      actions: androidActions,
      subText: whyLine,
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
      // 标题/正文一起进载荷（2026-11-30 §4.4）：NotificationResponse 只回传 payload，
      // 拿不到通知本身的 title/body，而决策半屏页要照原样把这条决策念给用户。
      "title": title,
      "body": body,
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
    ClientEventTelemetry.track(
      "proactive_displayed",
      deliveryId: deliveryId,
      props: <String, Object>{
        "surface": "notification",
        "actions": actions.length,
      },
    );
  }
}
