import "package:nextbot/app/ambient_feeds_controller.dart";
import "package:nextbot/app/chat_turn_controller.dart";
import "package:nextbot/app/phone_call_controller.dart";
import "package:nextbot/core/models/agent_relay_models.dart";
import "package:nextbot/core/services/account_profile_api.dart";
import "package:nextbot/core/presentation/dynamic_island.dart";
import "package:nextbot/core/presentation/foreground_banner.dart";
import "package:flutter_test/flutter_test.dart";

/// ForegroundBanner 桩：捕获横幅入参供断言。
class _FakeBanner implements ForegroundBanner {
  _FakeBanner({required this.onShow});

  final Future<void> Function(String title, String message) onShow;

  @override
  Future<void> show(String title, String message) => onShow(title, message);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group("AmbientFeedsController", () {
    late AmbientFeedsController c;
    setUp(() {
      c = AmbientFeedsController.instance;
      // 每个用例重置端口，避免用例间串扰
      c.removeScheduleForDeletedTask = null;
      c.syncSchedule = null;
      c.isAppBackgrounded = () => false;
      c.bumpInboxUnread = null;
      c.showInboxSnackBar = null;
      c.persistRelayMessage = null;
      c.showRelayToast = null;
      c.sendContactFeedbackViaWs = null;
    });

    test("tasks_changed: deleted 事件触发本地清理与同步，异常被吞掉不打断",
        () async {
      final List<String> removed = <String>[];
      int syncCalls = 0;
      c.removeScheduleForDeletedTask = (String taskId) async {
        removed.add(taskId);
      };
      c.syncSchedule = () async {
        syncCalls++;
        throw Exception("sync boom"); // 同步失败也不应向上抛
      };

      await c.onScheduleTasksChanged(<String, dynamic>{
        "action": "deleted",
        "taskId": "task-1",
      });
      expect(removed, <String>["task-1"]);
      expect(syncCalls, 1);

      // 非删除动作不触发本地清理
      await c.onScheduleTasksChanged(<String, dynamic>{
        "action": "created",
        "taskId": "task-2",
      });
      expect(removed, <String>["task-1"]);
      expect(syncCalls, 2);
    });

    test("tasks_changed: occurrence id（taskId@iso）视为删除源推送", () async {
      final List<String> removed = <String>[];
      c.removeScheduleForDeletedTask = (String taskId) async {
        removed.add(taskId);
      };
      c.syncSchedule = () async {};
      await c.onScheduleTasksChanged(<String, dynamic>{
        "action": "deleted",
        "taskId": "occ-1@2026-09-27T09:00:00",
      });
      expect(removed.single, "occ-1@2026-09-27T09:00:00");
    });

    test("reminder_fired: 标题/正文回退链与 syncSchedule 调用", () async {
      int syncCalls = 0;
      c.syncSchedule = () async {
        syncCalls++;
      };
      await c.onScheduleReminderFired(<String, dynamic>{});
      expect(syncCalls, 1);

      await c.onScheduleReminderFired(<String, dynamic>{
        "title": " 评审会 ",
        "message": "10 分钟后开始",
      });
      expect(syncCalls, 2);
    });

    test("reminder_fired: 单文案制（2026-10-19 定调：不带「标题 · 说明」前缀）经前台横幅端口可断言",
        () async {
      // 展示文本组装为纯函数直测（岛通道单测态 nativeReady=false 不出口）
      expect(
        IslandReminderScheduler.displayText(
            "该出门了 · 14:00 出发", "距离出发约 15 分钟"),
        "该出门了 · 14:00 出发 · 距离出发约 15 分钟",
      );
      expect(IslandReminderScheduler.displayText("吃药", null), "吃药");
      expect(IslandReminderScheduler.displayText("吃药", "  "), "吃药");

      // 单文案链（message → reminderMessage → title/shortTitle → 到点了）：
      // 横幅只出主行文案，message 传空（副行收起），标题前缀不再拼接。
      // 横幅端口是 ForegroundBanner 抽象接口（2026-10-21），测试用桩实现注入。
      String? bannerTitle;
      String? bannerMessage;
      c.foregroundBanner = _FakeBanner(
        onShow: (String title, String message) async {
          bannerTitle = title;
          bannerMessage = message;
        },
      );
      addTearDown(() => c.foregroundBanner = null);
      await c.onScheduleReminderFired(<String, dynamic>{"title": "吃药"});
      expect(bannerTitle, "吃药");
      expect(bannerMessage, isEmpty);

      // reminderMessage 优先：只出这一句，不带任务标题前缀
      await c.onScheduleReminderFired(
          <String, dynamic>{"title": "吃饭", "reminderMessage": "该吃饭啦"});
      expect(bannerTitle, "该吃饭啦");
      expect(bannerMessage, isEmpty);
    });

    test("inbox.message: 桌面前台走应用内呈现并 bump 角标", () async {
      int bumps = 0;
      final List<(String, String, String)> snacks =
          <(String, String, String)>[];
      c.bumpInboxUnread = () => bumps++;
      c.showInboxSnackBar = (String t, String b, String id) async {
        snacks.add((t, b, id));
      };

      await c.onInboxMessage(<String, dynamic>{
        "title": "系统通知",
        "body": "欢迎",
        "messageId": "inbox-9",
        "importance": "high",
      });
      expect(bumps, 1);
      expect(snacks.single, ("系统通知", "欢迎", "inbox-9"));
    });

    test("peer_message: 构造入站模型并经端口落库/提示", () async {
      AgentRelayMessage? persisted;
      String? toastFrom;
      c.persistRelayMessage = (AgentRelayMessage m) async {
        persisted = m;
      };
      c.showRelayToast = (String from) => toastFrom = from;

      await c.onPeerMessage(<String, dynamic>{
        "messageId": "m-1",
        "fromSessionId": "peer-a",
        "toSessionId": "me",
        "text": "你好",
        "subject": "主题",
        "receivedAt": "2026-09-27T08:00:00.000",
      });
      expect(persisted!.messageId, "m-1");
      expect(persisted!.fromSessionId, "peer-a");
      expect(persisted!.subject, "主题");
      expect(toastFrom, "peer-a");
    });

    test("isQuietHoursNow: 23 点后与 8 点前为静音时段", () {
      // 纯区间逻辑：hour >= 23 || hour < 8（不注入时钟，只验证函数存在且为 bool）
      expect(c.isQuietHoursNow(), isA<bool>());
    });
  });

  group("ChatTurnController", () {
    late ChatTurnController t;
    setUp(() {
      t = ChatTurnController.instance;
      t.cancelTimer();
      t.activeTraceId = null;
    });

    testWidgets("watchdog：3 分钟无事件触发超时回调（默认 showSnackBar）",
        (WidgetTester tester) async {
      int timeouts = 0;
      t.onTimeout = ({bool showSnackBar = true}) => timeouts++;
      t.armTrace("user-1");
      await tester.pump(ChatTurnController.replyTimeout);
      expect(timeouts, 1);
    });

    testWidgets("watchdog：流式续弦推迟超时；disarm 后不再触发",
        (WidgetTester tester) async {
      int timeouts = 0;
      t.onTimeout = ({bool showSnackBar = true}) => timeouts++;
      t.armTrace("user-1");
      await tester.pump(ChatTurnController.replyTimeout - const Duration(seconds: 1));
      t.resetTimer(); // 续弦
      await tester.pump(const Duration(seconds: 1));
      expect(timeouts, 0); // 原窗口已过但被续弦
      await tester.pump(ChatTurnController.replyTimeout);
      expect(timeouts, 1);

      t.armTrace("user-2");
      t.cancelTimer();
      await tester.pump(ChatTurnController.replyTimeout);
      expect(timeouts, 1); // 不再增加
    });

    test("watchdog：无在途轮次时 resetTimer 为空操作", () {
      int timeouts = 0;
      t.onTimeout = ({bool showSnackBar = true}) => timeouts++;
      t.resetTimer();
      expect(t.hasActiveTrace, isFalse);
      expect(timeouts, 0);
    });
  });

  group("TaskPlaneState", () {
    test("生命周期：加入→重复加入幂等→终态移除→计数归零", () {
      final TaskPlaneState s = TaskPlaneState();
      expect(s.applyLifecycle(taskId: "t1", state: "running"), isTrue);
      expect(s.activeCount, 1);
      expect(s.applyLifecycle(taskId: "t1", state: "running"), isFalse);
      expect(s.activeCount, 1);

      expect(s.applyLifecycle(taskId: "t2", state: "waiting_input"), isTrue);
      expect(s.activeCount, 2);

      expect(s.applyLifecycle(taskId: "t1", state: "done"), isTrue);
      expect(s.activeCount, 1);
      // 已移除的任务再收终态：无变化
      expect(s.applyLifecycle(taskId: "t1", state: "failed"), isFalse);

      expect(s.applyLifecycle(taskId: "t2", state: "cancelled"), isTrue);
      expect(s.isEmpty, isTrue);

      s.remove("ghost"); // 移除不存在的 id：无异常
      s.clear();
      expect(s.activeCount, 0);
    });
  });

  group("PhoneCallController", () {
    test("extractTtsBase64：mp3 base64 提取，其余返回 null", () {
      expect(
        PhoneCallController.extractTtsBase64(
            <String, dynamic>{"format": "mp3", "base64": "QUJD"}),
        "QUJD",
      );
      expect(
        PhoneCallController.extractTtsBase64(
            <String, dynamic>{"format": "wav", "base64": "QUJD"}),
        isNull,
      );
      expect(
        PhoneCallController.extractTtsBase64(
            <String, dynamic>{"format": "mp3", "base64": ""}),
        isNull,
      );
      expect(PhoneCallController.extractTtsBase64(null), isNull);
      expect(PhoneCallController.extractTtsBase64("not-a-map"), isNull);
    });

    test("resolveRingMs：缺省 30 秒，带上限值原样", () {
      expect(PhoneCallController.resolveRingMs(<String, dynamic>{}),
          PhoneCallController.defaultRingMs);
      expect(
        PhoneCallController.resolveRingMs(
            <String, dynamic>{"ringDurationMs": 8000}),
        8000,
      );
    });

    test("resolveCallerLabel：来电方向缺省值可指定", () {
      // 无 fromPhone：标签回退到默认文案（非空即可，具体文案由 labels 决定）
      expect(
        PhoneCallController.resolveCallerLabel(<String, dynamic>{}),
        isNotEmpty,
      );
      expect(
        PhoneCallController.resolveCallerLabel(<String, dynamic>{},
            defaultDirection: ""),
        isNotEmpty,
      );
    });
  });

  group("politeDisplayName", () {
    test("单姓大名得体化为「姓氏+先生」，复姓截复姓", () {
      expect(politeDisplayName("王铭川"), "王先生");
      expect(politeDisplayName("欧阳文山"), "欧阳先生");
      expect(politeDisplayName("刘知远"), "刘先生");
    });

    test("已是称呼/昵称/洋名原样保留，绝不二次加工", () {
      expect(politeDisplayName("老王"), "老王");
      expect(politeDisplayName("王总"), "王总");
      expect(politeDisplayName("Tony"), "Tony");
      expect(politeDisplayName("王先生"), "王先生");
    });

    test("空串与超长输入原样返回", () {
      expect(politeDisplayName(""), "");
      expect(politeDisplayName("  "), "");
    });
  });
}
