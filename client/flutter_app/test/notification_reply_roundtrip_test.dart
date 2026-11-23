/// §4.3「通知内回复」在**对话面**的最后一格（2026-11-24）。
///
/// 一条主动消息（`agent_pulse` / `task_followup`）在服务端挂了 `NOTIFY_ACTION.chatReply`
/// （`chat.reply`，`kind:"input"`，inputLabel「回一句」）。通知栏用 RemoteInput 收字、
/// 决策半屏页用输入框收字，唯独对话气泡上那枚按钮此前被当成 execute 直接提交
/// （空手提交 = 服务端只能拒），用户只能「打开对话」再自己打字。
///
/// 这里锁死四件事：
///  1. 输入型按钮按下去**就地进入收字态**：复用页面输入框（聚焦 + 提示语换成
///     「回一句给管家…」），不新增弹层；
///  2. 那句字走既有 action-intent 链路提交**一次**、携 input；端侧不替服务端插
///     用户气泡（回推的 `payload.userText` 是唯一写入端）；
///  3. 提交成功后这条卡上的按钮撤掉（一条决策只拍一次板，同半屏页 `settled`
///     语义）；空句与失败都留在收字态、把原因说出来、可以重发；
///  4. 非输入型动作**一个字节都没变**：仍走控制器 `runNotifyAction` 的老执行路，
///     既不进收字态，也不碰新的提交口。
library;

import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/models/notify_action.dart";
import "package:nextbot/core/services/local_notification_actions.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_chat_page.dart";

import "helpers/temp_path_provider.dart";
import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

const String kReplyToken = "ai_reply_1.sig";
const String kAcceptToken = "ai_accept_1.sig";

/// 服务端挂在一条主动消息上的两枚按钮：回复（要收字）+ 确认（直接执行）。
/// 与通知栏 / 决策半屏页拿到的是同一批 actionId + 同一枚一次性 token。
const NotifyAction kReply = NotifyAction(
  actionId: kChatReplyActionId,
  label: "回一句",
  token: kReplyToken,
  kind: "input",
  inputLabel: "回一句",
);

const NotifyAction kAccept = NotifyAction(
  actionId: "proactivity.accept",
  label: "这就走",
  token: kAcceptToken,
);

/// 本地假 WS 服务端：控制器构造即连接，连不上会挂一个 12s 建连超时 + 重连链，
/// 把 pending timer 灌进测试区（`mobile_chat_location_report_test` 同款做法）。
HttpServer? wsServer;

void main() {
  setUp(() {
    PathProviderPlatform.instance = TempPathProviderPlatform();
  });

  setUpAll(() async {
    wsServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    wsServer!.listen((HttpRequest req) async {
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        final WebSocket ws = await WebSocketTransformer.upgrade(req);
        ws.listen((_) {});
      } else {
        await req.response.close();
      }
    });
  });

  tearDownAll(() async {
    await wsServer?.close(force: true);
    wsServer = null;
  });

  group("提示语（纯函数）", () {
    test("收字态说「回一句给管家」，文案跟着服务端 inputLabel 走", () {
      expect(
        mobileComposerHint(
          replyAction: kReply,
          planFlowActive: false,
          sideChatActive: false,
        ),
        "回一句给管家…",
      );
      expect(
        mobileComposerHint(
          replyAction: const NotifyAction(
            actionId: kChatReplyActionId,
            label: "问一句",
            token: "t2",
            kind: "input",
            inputLabel: "问一句",
          ),
          planFlowActive: false,
          sideChatActive: false,
        ),
        "问一句给管家…",
      );
      // 没进收字态时，三档原文案与优先级一字不动。
      expect(
        mobileComposerHint(
          replyAction: null,
          planFlowActive: true,
          sideChatActive: true,
        ),
        "继续说，可补充或调整规划…",
      );
      expect(
        mobileComposerHint(
          replyAction: null,
          planFlowActive: false,
          sideChatActive: true,
        ),
        "在这个旁聊里继续说…",
      );
      expect(
        mobileComposerHint(
          replyAction: null,
          planFlowActive: false,
          sideChatActive: false,
        ),
        "发消息…",
      );
    });
  });

  group("对话卡上的「回一句」（输入型动作就地收字）", () {
    testWidgets("按下去进入收字态：输入框聚焦 + 提示语换成「回一句给管家」", (
      WidgetTester tester,
    ) async {
      final _Harness h = _Harness(<NotifyAction>[kReply, kAccept]);
      await h.pump(tester);
      // 动作条照旧把两枚按钮端出来（共享渲染器一行没改）。
      expect(find.text("需要你拍板"), findsOneWidget);
      expect(find.text("回一句"), findsOneWidget);
      // 没按之前：输入框还是普通发消息，也没有模式条。
      expect(find.text("发消息…"), findsOneWidget);
      expect(find.textContaining("这句直接发给管家"), findsNothing);

      await tester.tap(find.text("回一句"));
      await tester.pump();

      expect(find.text("回一句给管家…"), findsOneWidget);
      expect(find.text("发消息…"), findsNothing);
      // 模式条说清这句是回给谁的，并留一条退出。
      expect(find.text("回「回一句」· 这句直接发给管家"), findsOneWidget);
      expect(find.text("取消"), findsOneWidget);
      // 焦点已经在输入框里：按完按钮直接打字，不用再点一次输入框。
      expect(
        tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
        isTrue,
      );

      // 「取消」退回收字态，什么都不发。
      await tester.tap(find.text("取消"));
      await tester.pump();
      expect(find.text("回一句给管家…"), findsNothing);
      expect(find.text("发消息…"), findsOneWidget);
      expect(h.calls, isEmpty);
      expect(find.text("回一句"), findsOneWidget);

      await h.teardown(tester);
    });

    testWidgets("发送走 action-intent 链路：携那句字提交一次，端侧不自插气泡", (
      WidgetTester tester,
    ) async {
      final _Harness h = _Harness(<NotifyAction>[kReply, kAccept]);
      await h.pump(tester);
      await tester.tap(find.text("回一句"));
      await tester.pump();
      await tester.enterText(find.byType(TextField), "10 分钟后走");
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      await tester.pump();

      expect(h.calls, hasLength(1));
      expect(h.calls.single.action.actionId, kChatReplyActionId);
      expect(h.calls.single.action.token, kReplyToken);
      expect(h.calls.single.text, "10 分钟后走");
      // 那句字不是一条新聊天消息：用户气泡由服务端回推（payload.userText），
      // 端侧再插一条就是「回一句冒出好几条」的老事故（controller 已接管渲染）。
      expect(
        h.controller.messages.where((ChatMessage m) => m.role == "user"),
        isEmpty,
      );
      // 交出去之后：输入框清空、退出收字态。
      expect(find.text("回一句给管家…"), findsNothing);
      expect(find.text("发消息…"), findsOneWidget);

      await h.teardown(tester);
    });

    testWidgets("提交成功后按钮不再可点（同半屏页 settled 语义）", (
      WidgetTester tester,
    ) async {
      final _Harness h = _Harness(<NotifyAction>[kReply, kAccept]);
      await h.pump(tester);
      await tester.tap(find.text("回一句"));
      await tester.pump();
      await tester.enterText(find.byType(TextField), "知道了");
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      await tester.pump();

      // 这条卡上的拍板按钮整行撤掉（一条决策只拍一次板），只留一句服务端回执。
      expect(find.text("回一句"), findsNothing);
      expect(find.text("这就走"), findsNothing);
      expect(find.text("需要你拍板"), findsNothing);
      expect(find.text("已回复"), findsOneWidget);

      // 再敲一句也不会第二次打到那枚动作上。
      await tester.enterText(find.byType(TextField), "再说一句");
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      await tester.pump();
      expect(h.calls, hasLength(1));

      await h.teardown(tester);
    });

    testWidgets("空句不提交：说一句为什么，且不发任何请求", (
      WidgetTester tester,
    ) async {
      final _Harness h = _Harness(<NotifyAction>[kReply]);
      await h.pump(tester);
      await tester.tap(find.text("回一句"));
      await tester.pump();
      // 键盘回车那条路（发送键在空输入时本就点不动）。
      await tester.showKeyboard(find.byType(TextField));
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();

      expect(h.calls, isEmpty);
      expect(find.text("先写一句，再按「回一句」。"), findsOneWidget);
      // 还在收字态：接着打字就能发出去。
      expect(find.text("回一句给管家…"), findsOneWidget);

      await h.teardown(tester);
    });

    testWidgets("失败不吞：留在收字态、说出原因、改一句可重发", (
      WidgetTester tester,
    ) async {
      final _Harness h = _Harness(
        <NotifyAction>[kReply],
        receipt: const ActionReceipt(ok: false, message: "这条提醒已经过期了"),
      );
      await h.pump(tester);
      await tester.tap(find.text("回一句"));
      await tester.pump();
      await tester.enterText(find.byType(TextField), "现在走");
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      await tester.pump();

      expect(find.text("这条提醒已经过期了"), findsOneWidget);
      // 没拍成就不撤按钮、不清输入、不退模式 → 改一句就能重试。
      expect(find.text("回一句"), findsOneWidget);
      expect(find.textContaining("这句直接发给管家"), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        "现在走",
      );

      h.succeed();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      await tester.pump();
      expect(h.calls, hasLength(2));
      expect(find.text("已回复"), findsOneWidget);
      expect(find.text("回一句"), findsNothing);

      await h.teardown(tester);
    });
  });

  testWidgets("非输入型动作仍走老执行链路：不进收字态、不碰新提交口", (
    WidgetTester tester,
  ) async {
    final _Harness h = _Harness(<NotifyAction>[kReply, kAccept]);
    await h.pump(tester);
    await tester.tap(find.text("这就走"));
    await tester.pump();

    // 输入框没有被带进回复模式（那枚按钮的语义一个字都没动）。
    expect(find.text("回一句给管家…"), findsNothing);
    expect(find.text("发消息…"), findsOneWidget);
    expect(find.textContaining("这句直接发给管家"), findsNothing);
    // 新的收字提交口一次没被用到——这一下是控制器的 runNotifyAction 接走的：
    // 测试环境里那发 HTTP 拿不到成功回执，于是老行为原样浮现——按钮留着 +
    // 错误提示条（2026-11-23 周界 401 事故定下的「失败不撤按钮」）。
    expect(h.calls, isEmpty);
    expect(h.controller.errorMessage, isNotNull);
    expect(find.text("这就走"), findsOneWidget);
    // 只有输入型那条分支会清 notifyActions；执行失败不该动它。
    expect(
      h.controller.messages
          .firstWhere((ChatMessage m) => m.messageId == "assistant-pulse-1")
          .notifyActions,
      hasLength(2),
    );

    await h.teardown(tester);
  });
}

/// 一棵只装着 [MobileChatPage] 的测试树 + 记录型提交口。
///
/// 提交口注入点是本用例唯一的新接口（`MobileChatPage.onReplyExecute`）：默认值
/// 就是既有链路 [executeNotifyAction]（`POST /api/action-intents/execute` 携
/// `input`），与通知栏 RemoteInput、决策半屏页同一枚 token；这里换成桩只为观测
/// 「提交了什么、提交了几次」，不测网络。
class _Harness {
  _Harness(List<NotifyAction> actions, {ActionReceipt? receipt}) {
    final MobileChatController c = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${wsServer!.port}",
      historyStore: EmptyHistoryStoreForTest(),
    );
    controller = c;
    _receipt = receipt ?? const ActionReceipt(ok: true, message: "已回复");
    c.messages.add(
      ChatMessage(
        messageId: "assistant-pulse-1",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: "雨 20 分钟后停，晚 5 分钟出发正好不淋",
        timestamp: DateTime(2026, 11, 24, 9),
        notifyActions: actions,
      ),
    );
  }

  late final MobileChatController controller;
  late ActionReceipt _receipt;
  bool _down = false;
  final List<({NotifyAction action, String text})> calls =
      <({NotifyAction action, String text})>[];

  /// 让后续提交成功（失败重试用例中途翻牌）。
  void succeed() {
    _receipt = const ActionReceipt(ok: true, message: "已回复");
  }

  Future<ActionReceipt> _execute(NotifyAction action, String text) async {
    calls.add((action: action, text: text));
    return _receipt;
  }

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      home: MobileChatPage(
        controller: controller,
        onReplyExecute: _execute,
      ),
    ));
    await tester.pump();
  }

  /// 收尾：**先卸树再释放控制器**（顺序反了会在卸载时对已 dispose 的
  /// ChangeNotifier removeListener）。控制器挂着的 12s 建连超时只有 close() 会
  /// 取消，而框架的 pending-timer 检查在 addTearDown 之前——所以必须在测试体内
  /// 走完这一步（`browser_preview_overlay_golden_test` 用大步 pump 绕的同一件事）。
  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    shutdown();
  }

  void shutdown() {
    if (_down) return;
    _down = true;
    controller.dispose();
  }
}
