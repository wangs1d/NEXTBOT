// 决策半屏页的纯逻辑测试（PRD §4.4 行 2「进程被杀、厂商通道可用」+ §4.7 验收
// 「App 被杀后点厂商通知 → 半屏页一步完成」）。
//
// 这里守的是两条只能靠代码保证的不变量：
//  1. **认出这条决策**：intentId / 标题 / 正文 / 两枚按钮从哪儿来、什么情况下
//     不该弹页（普通通知、没有按钮、已过期、陈年补投）；
//  2. **一步完成**：拍一次板 → 显示服务端那句回执 → 页面自己收起；失败则留在
//     页上把原因说清楚（§4.2「不吞失败」），且永远保留「打开对话」这条出口。
//
// 真机上的厂商推送点不开（本环境无设备、无华为凭据），所以这两件事必须在纯逻辑
// 层钉住：真机只能验证「通知点开 → App 起来」这半程，后半程的正确性全靠这里。
library;

import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/models/notify_action.dart";
import "package:nextbot/core/services/local_notification_actions.dart";
import "package:nextbot/core/services/proactive_decision.dart";

const String kIntent = "ai_mt9x0k1a_0";
const String kDelivery = "dlv_7";

NotifyAction act(String id, String label, {String kind = "execute"}) =>
    NotifyAction(actionId: id, label: label, token: "ai1.$id.sig", kind: kind);

/// 服务端 `renderForClient(intent, {withOpenChat: true})` 的原样形状
Map<String, dynamic> intentView({
  Object? expiresAt,
  bool withOpenChat = true,
  List<dynamic>? actions,
  String intentId = kIntent,
}) =>
    <String, dynamic>{
      "intentId": intentId,
      "title": "要现在出门吗",
      "body": "雨 20 分钟后停，晚 5 分钟出发正好不淋",
      "expiresAt": expiresAt ?? DateTime.now().millisecondsSinceEpoch + 3600000,
      "actions": actions ??
          <dynamic>[
            act("proactivity.accept", "这就走").toJson(),
            act("proactivity.decline", "再等等").toJson(),
          ],
      if (withOpenChat)
        "openChat": act(kOpenChatActionId, "打开对话").toJson(),
    };

Map<String, dynamic> replayEvent({
  Object? pushed,
  Object? replay,
  Map<String, dynamic>? actionIntent,
  Object? firedAt,
  String text = "雨 20 分钟后停，晚 5 分钟出发正好不淋",
}) =>
    <String, dynamic>{
      "title": "要现在出门吗",
      "text": text,
      "deliveryId": kDelivery,
      if (pushed != null) "pushed": pushed,
      if (replay != null) "replay": replay,
      if (firedAt != null) "firedAt": firedAt,
      if (actionIntent != null) "actionIntent": actionIntent,
    };

DecisionSheetModel sheetWith(
  DecisionRequest request,
  Future<ActionReceipt> Function(NotifyAction a, String input) execute, {
  List<String>? closes,
  Duration autoCloseDelay = Duration.zero,
}) =>
    DecisionSheetModel(
      request: request,
      execute: execute,
      autoCloseDelay: autoCloseDelay,
      requestClose: () => (closes ??= <String>[]).add("close"),
    );

DecisionRequest sampleRequest({
  List<NotifyAction>? actions,
  bool withOpenChat = true,
}) =>
    DecisionRequest(
      intentId: kIntent,
      deliveryId: kDelivery,
      title: "要现在出门吗",
      body: "雨 20 分钟后停",
      actions: actions ??
          <NotifyAction>[
            act("proactivity.accept", "这就走"),
            act("proactivity.decline", "再等等"),
          ],
      openChat: withOpenChat ? act(kOpenChatActionId, "打开对话") : null,
    );

void main() {
  group("载荷 → 决策（intentId 认得出吗）", () {
    test("通知正文点开的载荷：intentId/deliveryId/标题/正文/动作全部取出", () {
      // 与 LocalNotificationService.show() 的 payloadMap 同一套键名（jsonEncode 过）
      final String payload = jsonEncode(<String, dynamic>{
        "deliveryId": kDelivery,
        "intentId": kIntent,
        "title": "要现在出门吗",
        "body": "雨 20 分钟后停",
        "actions": <dynamic>[
          act("proactivity.accept", "这就走").toJson(),
          act("proactivity.decline", "再等等").toJson(),
        ],
      });
      final DecisionRequest? d = DecisionRequest.parse(
        payload,
        nowMs: DateTime.now().millisecondsSinceEpoch,
      );
      expect(d, isNotNull);
      expect(d!.intentId, kIntent);
      expect(d.deliveryId, kDelivery);
      expect(d.title, "要现在出门吗");
      expect(d.body, "雨 20 分钟后停");
      expect(d.actions.map((NotifyAction a) => a.label), <String>["这就走", "再等等"]);
      expect(d.source, decisionSourceNotificationTap);
      expect(d.hasActions, isTrue);
    });

    test("普通通知（没有 intentId / 没有动作）认不出决策 → 不弹页", () {
      final int now = DateTime.now().millisecondsSinceEpoch;
      expect(
        DecisionRequest.parse(<String, dynamic>{"title": "打卡", "body": "该打卡了"}, nowMs: now),
        isNull,
      );
      expect(
        DecisionRequest.parse(
          <String, dynamic>{"intentId": kIntent, "actions": <dynamic>[]},
          nowMs: now,
        ),
        isNull,
      );
      // token 缺失的动作等于没有动作（服务端签不出的东西点了也只会失败）
      expect(
        DecisionRequest.parse(
          <String, dynamic>{
            "intentId": kIntent,
            "actions": <dynamic>[
              <String, dynamic>{"actionId": "a", "label": "好", "token": ""}
            ],
          },
          nowMs: now,
        ),
        isNull,
      );
      expect(DecisionRequest.parse(null, nowMs: now), isNull);
      expect(DecisionRequest.parse("{坏掉的 json", nowMs: now), isNull);
    });

    test("厂商推送补投事件：pushed + replay + 有动作才成立", () {
      final int now = DateTime.now().millisecondsSinceEpoch;
      final DecisionRequest? d = DecisionRequest.fromProactiveEvent(
        replayEvent(
          pushed: true,
          replay: true,
          firedAt: now - 3000,
          actionIntent: intentView(),
        ),
        nowMs: now,
      );
      expect(d, isNotNull);
      expect(d!.intentId, kIntent);
      expect(d.deliveryId, kDelivery);
      expect(d.title, "要现在出门吗");
      expect(d.body, "雨 20 分钟后停，晚 5 分钟出发正好不淋");
      expect(d.actions.length, 2);
      expect(d.openChat?.actionId, kOpenChatActionId);
      expect(d.source, decisionSourceVendorPush);
    });

    test("补投事件该挡的都挡掉：非推送、非补投、无动作、已过期、太陈旧", () {
      final int now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> ev = replayEvent(
          pushed: false, replay: true, firedAt: now, actionIntent: intentView());
      expect(DecisionRequest.fromProactiveEvent(ev, nowMs: now), isNull,
          reason: "这条没走厂商推送，通知栏本来就带按钮，不必再端一页");
      ev = replayEvent(
          pushed: true, replay: false, firedAt: now, actionIntent: intentView());
      expect(DecisionRequest.fromProactiveEvent(ev, nowMs: now), isNull,
          reason: "实时到达的消息照常落气泡/弹通知，不该插一页");
      ev = replayEvent(
          pushed: true,
          replay: true,
          firedAt: now,
          actionIntent: intentView(actions: <dynamic>[]));
      expect(DecisionRequest.fromProactiveEvent(ev, nowMs: now), isNull);
      ev = replayEvent(
          pushed: true,
          replay: true,
          firedAt: now,
          actionIntent: intentView(expiresAt: now - 1));
      expect(DecisionRequest.fromProactiveEvent(ev, nowMs: now), isNull,
          reason: "服务端已判过期的意图，弹出来只会收获一次失败回执");
      ev = replayEvent(
          pushed: true,
          replay: true,
          firedAt: now - DecisionRequest.defaultMaxAgeMs - 1000,
          actionIntent: intentView());
      expect(DecisionRequest.fromProactiveEvent(ev, nowMs: now), isNull,
          reason: "补投区留 24h，昨天的陈年决策不该在今天弹窗");
    });

    test("「打开对话」优先取服务端单发的 openChat，旧载荷则从 actions 里找", () {
      final int now = DateTime.now().millisecondsSinceEpoch;
      // 新载荷：openChat 不占两枚按钮的位置
      DecisionRequest? d = DecisionRequest.fromProactiveEvent(
        replayEvent(
            pushed: true,
            replay: true,
            firedAt: now,
            actionIntent: intentView()),
        nowMs: now,
      );
      expect(d!.openChat?.token, "ai1.${kOpenChatActionId}.sig");
      expect(d.actions.map((NotifyAction a) => a.actionId),
          isNot(contains(kOpenChatActionId)));
      // 旧载荷：chat.open 混在 actions 里，也要能当导航动作取出来
      d = DecisionRequest.fromProactiveEvent(
        replayEvent(
          pushed: true,
          replay: true,
          firedAt: now,
          actionIntent: intentView(
            withOpenChat: false,
            actions: <dynamic>[
              act("proactivity.accept", "这就走").toJson(),
              act(kOpenChatActionId, "打开对话").toJson(),
            ],
          ),
        ),
        nowMs: now,
      );
      expect(d!.openChat?.actionId, kOpenChatActionId);
    });
  });

  group("半屏页状态机（一步完成）", () {
    test("拍一次板 → 服务端回执原样显示 → 页面自己收起", () async {
      final List<String> closes = <String>[];
      final List<String> sent = <String>[];
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async {
          sent.add(a.actionId);
          return const ActionReceipt(ok: true, message: "好，按「这就走」记下了，雨具已加进日程");
        },
        closes: closes,
        autoCloseDelay: const Duration(milliseconds: 20),
      );
      int notified = 0;
      m.addListener(() => notified++);
      expect(m.actions.length, 2, reason: "半屏页就端服务端那两枚按钮");
      expect(await m.submit(m.actions.first), isTrue);
      expect(m.phase, DecisionPhase.receipt);
      expect(m.ok, isTrue);
      expect(m.settled, isTrue);
      expect(m.message, "好，按「这就走」记下了，雨具已加进日程");
      expect(closes, isEmpty, reason: "回执要先让人看见，不能抢跑关掉");
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(closes, <String>["close"], reason: "§4.7：一步完成，页面自己收");
      expect(notified, greaterThan(0));
      m.dispose();
    });

    test("sending 期间连点只发一次（服务端本来幂等，页面上更不该出两个回执）", () async {
      int calls = 0;
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async {
          calls++;
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return const ActionReceipt(ok: true, message: "好了");
        },
        closes: null,
        autoCloseDelay: Duration.zero,
      );
      final Future<bool> first = m.submit(m.actions.first);
      expect(await m.submit(m.actions.last), isFalse, reason: "处理中不再接受第二次拍板");
      expect(await first, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(calls, 1);
      expect(m.autoClosed, isTrue);
      m.dispose();
    });

    test("没网：留在页上把原因说出来，按钮还能重试", () async {
      final List<String> closes = <String>[];
      int attempts = 0;
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async {
          attempts++;
          return attempts == 1
              ? const ActionReceipt(ok: false, message: "连不上服务器，等你回 App 再处理。")
              : const ActionReceipt(ok: true, message: "这次记上了");
        },
        closes: closes,
        autoCloseDelay: Duration.zero,
      );
      await m.submit(m.actions.first);
      expect(m.phase, DecisionPhase.failed);
      expect(m.settled, isFalse, reason: "没拍成就不算拍过，按钮必须还在");
      expect(m.message, "连不上服务器，等你回 App 再处理。");
      expect(closes, isEmpty, reason: "§4.2 不吞失败：不许悄悄关掉假装处理完了");
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(closes, isEmpty);
      await m.submit(m.actions.first);
      expect(m.phase, DecisionPhase.receipt);
      expect(m.message, "这次记上了");
      m.dispose();
    });

    test("已处理 / 已过期：服务端那句话照原样念出来，不自己编", () async {
      for (final String serverLine in <String>[
        "这件事你已经拍过板了",
        "这条提醒已经过期了",
      ]) {
        final List<String> closes = <String>[];
        final DecisionSheetModel m = sheetWith(
          sampleRequest(),
          (NotifyAction a, String input) async =>
              ActionReceipt(ok: true, message: serverLine),
          closes: closes,
          autoCloseDelay: Duration.zero,
        );
        await m.submit(m.actions.first);
        expect(m.message, serverLine);
        expect(closes, <String>["close"]);
        m.dispose();
      }
      final DecisionSheetModel expired = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async =>
            const ActionReceipt(ok: false, message: "这条已经过期了，不用管它"),
        autoCloseDelay: Duration.zero,
      );
      await expired.submit(expired.actions.first);
      expect(expired.ok, isFalse);
      expect(expired.message, "这条已经过期了，不用管它");
      expired.dispose();
    });

    test("要写字的按钮没写字：不发请求，直接说缺什么", () async {
      final List<String> closes = <String>[];
      int calls = 0;
      final DecisionSheetModel m = sheetWith(
        sampleRequest(actions: <NotifyAction>[
          act(kChatReplyActionId, "回一句", kind: "input"),
        ]),
        (NotifyAction a, String input) async {
          calls++;
          return const ActionReceipt(ok: true, message: "好了");
        },
        closes: closes,
        autoCloseDelay: Duration.zero,
      );
      expect(await m.submit(m.actions.first, input: "   "), isFalse);
      expect(calls, 0, reason: "空话不该 POST 出去占掉一次幂等窗口");
      expect(m.phase, DecisionPhase.failed);
      expect(m.message, contains("回一句"));
      expect(closes, isEmpty, reason: "留着页让人补一句，比关掉重来强");
      expect(await m.submit(m.actions.first, input: "那就十分钟后叫我"), isTrue);
      expect(calls, 1);
      m.dispose();
    });

    test("「打开对话」：先把意图在服务端收口，再收页并带回会话（不另建状态）", () async {
      final List<String> closes = <String>[];
      final List<String> sent = <String>[];
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async {
          sent.add(a.actionId);
          return const ActionReceipt(ok: true, message: "好，回对话里说");
        },
        closes: closes,
      );
      m.openChat();
      expect(m.requestsConversation, isTrue);
      expect(closes, <String>["close"]);
      expect(sent, <String>[kOpenChatActionId],
          reason: "走既有 action-intent 链路收口，服务端才知道这件事结束了");
      expect(m.busy, isFalse, reason: "回写不 await：网络慢也不该把人卡在门上");
      m.dispose();
    });

    test("旧载荷没有 openChat token：只是导航，不谎称已经记上", () async {
      final List<String> sent = <String>[];
      final List<String> closes = <String>[];
      final DecisionSheetModel m = sheetWith(
        sampleRequest(withOpenChat: false),
        (NotifyAction a, String input) async {
          sent.add(a.actionId);
          return const ActionReceipt(ok: true, message: "好了");
        },
        closes: closes,
      );
      m.openChat();
      expect(sent, isEmpty);
      expect(closes, <String>["close"]);
      expect(m.requestsConversation, isTrue);
      m.dispose();
    });

    test("关闭只生效一次（自动收台与用户划走撞在一起也不弹两次 pop）", () {
      final List<String> closes = <String>[];
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async => const ActionReceipt(ok: true, message: "好了"),
        closes: closes,
        autoCloseDelay: Duration.zero,
      );
      m.close();
      m.close();
      expect(closes, <String>["close"]);
      m.dispose();
    });

    test("页面不收就不会漏：拍完板后过期时间到了也不影响（服务端已收口）", () async {
      // 半屏页不自己判过期后偷偷关窗——过期只影响「要不要弹」（见 fromProactiveEvent）
      final DecisionSheetModel m = sheetWith(
        sampleRequest(),
        (NotifyAction a, String input) async => const ActionReceipt(ok: true, message: "好了"),
        autoCloseDelay: Duration.zero,
      );
      await m.submit(m.actions.first);
      expect(m.request.intentId, kIntent);
      expect(m.settled, isTrue);
      expect(m.autoClosed, isTrue);
      m.dispose();
    });
  });
}
