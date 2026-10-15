import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/models/agent_relay_models.dart";
import "../core/services/local_notification_service.dart";
import "../core/presentation/dynamic_island.dart";

/// 环境信息流控制器 —— 主窗口「被动信息」事件域的编排层
/// （schedule.tasks_changed / reminder_fired、inbox.message、
/// agent.peer_message 与主动性反馈回传），原 `_PrivateAiAppState`
/// 内联事件块的收口。
///
/// 职责边界：这里只做**编排**——payload 解析、触达分流、服务调用、
/// 岛条目喂点、反馈回传；任何需要 BuildContext 的呈现（SnackBar、
/// 面板刷新）经 UI 端口回调交回 main.dart，控制器不持 widget 依赖，
/// 可纯 Dart 单测。
class AmbientFeedsController {
  AmbientFeedsController._();

  static final AmbientFeedsController instance = AmbientFeedsController._();

  // ── UI 端口（main.dart 装配时注入） ──

  /// 删除的本地日程清理（State 绑定本地 store 后注入）。
  Future<void> Function(String taskId)? removeScheduleForDeletedTask;

  /// 日程同步（联动右侧面板刷新 + 岛日程卡 + 提醒计划重建）。
  Future<void> Function()? syncSchedule;

  /// 是否处于手机后台（类微信常在线分流：后台走系统通知）。
  bool Function()? isAppBackgrounded;

  /// 手机端前台提醒呈现端口（应用内横幅）。桌面端不注入走灵动岛；
  /// 手机端灵动岛未装配，不注入此端口时到点提醒在前台会静默丢失（2026-10-12 修复）。
  Future<void> Function(String title, String message)? showForegroundReminder;

  /// 站内信未读角标 +1 并喂岛（State 持 _inboxUnread 镜像供侧栏 widget）。
  void Function()? bumpInboxUnread;

  /// 站内信应用内呈现（SnackBar + 知道了按钮，含 markRead 刷新链）。
  Future<void> Function(String title, String body, String messageId)?
      showInboxSnackBar;

  /// 中继消息落本地库 + 入列表（State 做 setState 持久化）。
  Future<void> Function(AgentRelayMessage message)? persistRelayMessage;

  /// 中继消息是否已在本端落库（按 messageId 去重；重连补投/重启后不重复打扰）。
  bool Function(String messageId)? isRelayMessageKnown;

  /// 中继消息应用内提示。
  void Function(String fromSessionId)? showRelayToast;

  /// 联系反馈 WS 桥（控制器不依赖 WS 客户端单例）。
  void Function({
    required String channel,
    required bool responded,
    String? feedback,
    int? responseTimeMs,
    bool? quietHours,
  })? sendContactFeedbackViaWs;

  bool get _backgrounded => isAppBackgrounded?.call() ?? false;

  bool get isMobile => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  // ── 事件编排 ──

  /// 服务端推送的日程变更事件（created/updated/deleted）。
  /// tool.result 路径由 upsertLocalScheduleFromToolResult 处理；
  /// occurrence 变更以 `taskId@<iso>` 格式的 id 推送，此处仅处理删除。
  Future<void> onScheduleTasksChanged(Map<String, dynamic> payload) async {
    try {
      final String action = payload["action"]?.toString() ?? "created";
      final String? taskId = payload["taskId"]?.toString();
      if (action == "deleted" && taskId != null && taskId.isNotEmpty) {
        await removeScheduleForDeletedTask?.call(taskId);
      }
      await syncSchedule?.call();
    } catch (e, st) {
      debugPrint("[schedule] schedule.tasks_changed failed: $e\n$st");
    }
  }

  /// 日程提醒触达分流（2026-10-05 定调：提醒统一归灵动岛；原到点档的
  /// 桌面原生弹窗双通道已于 2026-10-14 删除）：
  ///   - 提前量预告（preReminder == true，睡前备忘/起床闹钟/该出门了…）：
  ///     走灵动岛 attention 默认档（约 6s 收回）——「灵动岛 = 预告」；
  ///   - 到点提醒（preReminder != true）：灵动岛长驻留档（约 30s，点击胶囊
  ///     提前收口并打开日程页），提示音由 attention 档自带；
  ///   - 移动端后台一律走系统通知（前台仍回落灵动岛）。
  Future<void> onScheduleReminderFired(Map<String, dynamic> payload) async {
    try {
      final String title = _reminderTitle(payload);
      final String message =
          payload["message"]?.toString().trim().isNotEmpty == true
              ? payload["message"]!.toString().trim()
              : (payload["reminderMessage"]?.toString().trim() ?? "到点了");
      final bool isPreReminder = payload["preReminder"] == true;

      if (isMobile && _backgrounded) {
        unawaited(LocalNotificationService.show(title: title, body: message));
      } else if (showForegroundReminder != null) {
        // 应用内横幅（端口注入即生效）：手机端前台主路；Windows 桌面调试
        // 手机 UI（main_mobile.dart -d windows）同样注入，横幅可见可验。
        // 桌面端主壳不注入此端口，走下方灵动岛原路。
        unawaited(showForegroundReminder!(title, message));
      } else {
        // 岛上标题+说明全展示（2026-10-07 修订，覆盖 2026-10-05「只显示
        // 事情本身」）：预告/到点文案完整上岛，胶囊宽度原生端自适应伸缩。
        // 全屏打断白名单（2026-10-14 定调，取代 10-13「仅到点破屏」）：
        // 允许越级显示的只有日程两档——预告 + 到点，均 urgent 破屏；
        // 普通消息等非日程档不 urgent，全屏/忙碌时原生端整体跳过。
        IslandReminderScheduler.instance.fireNow(
          title: title,
          message: message,
          // 到点档加长驻留（原生保持段 26s + 入出场 ≈ 30s）；
          // 提前量预告用默认短档。
          holdSeconds: isPreReminder ? 0 : 26,
          urgent: true,
        );
      }

      await syncSchedule?.call();
    } catch (e, st) {
      debugPrint("[schedule] schedule.reminder_fired failed: $e\n$st");
    }
  }

  /// 提醒标题回退链：title → shortTitle → reminderMessage → 「提醒」。
  /// shortTitle 是任务创建时给的短名（如「吃药」），比泛化的「提醒」可读。
  String _reminderTitle(Map<String, dynamic> payload) {
    for (final String key in const <String>[
      "title",
      "shortTitle",
      "reminderMessage",
    ]) {
      final String v = payload[key]?.toString().trim() ?? "";
      if (v.isNotEmpty) return v;
    }
    return "提醒";
  }

  /// 站内信：平台/运营侧推送（服务端已落盘必达，此处只做即时提醒）。
  Future<void> onInboxMessage(Map<String, dynamic> payload) async {
    final String inboxTitle = payload["title"]?.toString() ?? "新消息";
    final String inboxBody = payload["body"]?.toString() ?? "";
    final String inboxId = payload["messageId"]?.toString() ?? "";
    final String inboxImportance = payload["importance"]?.toString() ?? "normal";
    final bool inboxImportant =
        inboxImportance == "high" || inboxImportance == "critical";
    // 角标即时 +1（轮询会在下个周期校准）
    bumpInboxUnread?.call();
    // 手机后台（类微信常在线）：系统通知触达，点开回前台后到邮箱-消息 Tab 查看
    if (isMobile && _backgrounded && inboxImportant) {
      unawaited(LocalNotificationService.show(
        title: inboxTitle, body: inboxBody,
      ));
    } else {
      await showInboxSnackBar?.call(inboxTitle, inboxBody, inboxId);
    }
  }

  /// 中继消息（好友站内信 peer 互发）：构造入站模型 → 落库/入列表 → 触达分流。
  /// 2026-10-15 闭环：服务端 hub 持久落库 + 重连补投（replayed 标记）；
  /// 本端按 messageId 去重——已落库的只更新不重复提示；手机后台走系统通知
  /// （与站内信 onInboxMessage 同分流），前台 SnackBar 提示。
  Future<void> onPeerMessage(Map<String, dynamic> payload) async {
    final String messageId =
        payload["messageId"]?.toString() ?? "relay-unknown";
    final String fromSessionId = payload["fromSessionId"]?.toString() ?? "";
    final String body = payload["text"]?.toString() ?? "";
    final String? subject = payload["subject"]?.toString();
    final String fromName =
        payload["fromName"]?.toString().trim().isNotEmpty == true
            ? payload["fromName"].toString()
            : fromSessionId;
    final String receivedRaw =
        payload["receivedAt"]?.toString() ?? DateTime.now().toIso8601String();
    DateTime receivedAt = DateTime.now();
    try {
      receivedAt = DateTime.parse(receivedRaw);
    } catch (_) {}
    final bool known = isRelayMessageKnown?.call(messageId) ?? false;
    final AgentRelayMessage inbound = AgentRelayMessage(
      messageId: messageId,
      fromSessionId: fromSessionId,
      toSessionId: payload["toSessionId"]?.toString() ?? "",
      text: body,
      subject: (subject == null || subject.isEmpty) ? null : subject,
      receivedAt: receivedAt,
    );
    await persistRelayMessage?.call(inbound);
    if (known) return; // 补投/重放：只更新落库，不重复打扰
    if (isMobile && _backgrounded) {
      unawaited(LocalNotificationService.show(
        title: "来自 $fromName 的消息",
        body: body,
      ));
    } else {
      showRelayToast?.call(fromName);
    }
  }

  // ── 主动性反馈回传（原 State 内联 HTTP 收口，纯 API 无 UI 依赖） ──

  /// outcome 反馈回传（viewed/accepted/dismissed/ignored）。
  void sendProactiveOutcome(String deliveryId, String outcome) {
    unawaited(
      http
          .post(
            Uri.parse(
                "${ApiConfig.httpBase}/api/proactivity/outcome"),
            headers: const {"Content-Type": "application/json"},
            body: jsonEncode(
                <String, String>{"deliveryId": deliveryId, "outcome": outcome}),
          )
          .then(
            (_) {},
            onError: (Object e) =>
                debugPrint("[proactive] outcome post failed: $e"),
          ),
    );
  }

  /// 用户语义化反馈（"太多了"）：服务端回灌频控自适应冷却，
  /// kind 可选附加以便服务端定位投递类别。
  void sendProactiveFeedback(String deliveryId, String action,
      {String? kind}) {
    unawaited(
      http
          .post(
            Uri.parse(
                "${ApiConfig.httpBase}/api/proactivity/feedback"),
            headers: const {"Content-Type": "application/json"},
            body: jsonEncode(<String, String?>{
              "deliveryId": deliveryId,
              "action": action,
              if (kind != null && kind.isNotEmpty) "kind": kind,
            }),
          )
          .then(
            (_) {},
            onError: (Object e) =>
                debugPrint("[proactive] feedback post failed: $e"),
          ),
    );
  }

  void sendContactFeedback({
    required String channel,
    required bool responded,
    String? feedback,
    int? responseTimeMs,
    bool? quietHours,
  }) {
    sendContactFeedbackViaWs?.call(
      channel: channel,
      responded: responded,
      feedback: feedback,
      responseTimeMs: responseTimeMs,
      quietHours: quietHours,
    );
  }

  /// 静音时段：23 点后 / 8 点前（反馈回传带上下文供服务端学习）。
  bool isQuietHoursNow() {
    final int hour = DateTime.now().hour;
    return hour >= 23 || hour < 8;
  }
}
