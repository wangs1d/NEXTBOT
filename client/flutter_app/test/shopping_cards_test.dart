import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";
import "package:nextbot/features/chat/shopping/shopping_candidates_card.dart";
import "package:nextbot/features/chat/shopping/shopping_checkout_cards.dart";
import "package:nextbot/features/chat/shopping/shopping_shipment_card.dart";

/// 手机端购物卡（2026-11-06 设计稿）行为测试。
///
/// 覆盖四条设计约束，而不是像素截图：
///   1. 候选卡横向滑动、逐卡吸附、页码点跟随；
///   2. 确认卡按服务端绝对到期时刻倒计时，过期后主按钮不可点；
///   3. 规格卡无货选项划线且点击不发动作；
///   4. 物流卡按回执节点渲染，当前节点高亮、未来节点灰化。

Widget _host(Widget child) {
  return MaterialApp(
    home: Scaffold(
      backgroundColor: const Color(0xFFF7F7F8),
      body: Center(
        child: SizedBox(width: 390, child: SingleChildScrollView(child: child)),
      ),
    ),
  );
}

Map<String, dynamic> _candidatesPayload() => <String, dynamic>{
      "stage": "candidates",
      "title": "米家空气净化器 · 三选一",
      "sortLabel": "按到手价",
      "bestIndex": 1,
      "bestLabel": "最合适",
      "items": <Map<String, dynamic>>[
        <String, dynamic>{
          "title": "米家空气净化器 4 Lite",
          "price": 699,
          "platformLabel": "京东",
          "shop": "京东",
        },
        <String, dynamic>{
          "title": "米家空气净化器 5",
          "price": 1099,
          "platformLabel": "京东",
          "shop": "京东自营",
          "rating": 4.9,
        },
        <String, dynamic>{
          "title": "米家空气净化器 5 Pro",
          "price": 1449,
          "platformLabel": "天猫",
          "shop": "天猫",
        },
      ],
      "chips": <String>["看中间这款", "换一批"],
      "footer": "都支持 7 天无理由；中间那款滤芯年成本约 199。",
    };

void main() {
  testWidgets("候选卡：三张候选 + 页码点，横滑后翻到第二张", (WidgetTester tester) async {
    await tester.pumpWidget(
      _host(
        ShoppingCandidatesCard(
          cs: ThemeData.light().colorScheme,
          payload: _candidatesPayload(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 屏内能看到主推款与徽章。
    expect(find.text("米家空气净化器 5"), findsWidgets);
    expect(find.text("最合适"), findsOneWidget);
    // 页码点：3 个（当前页拉长成 14px 短条，其余 5px）。
    List<double> dotWidths() => tester
        .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
        .map((AnimatedContainer c) => (c.constraints?.maxWidth ?? 0).toDouble())
        .toList();
    final List<double> before = dotWidths();
    expect(before.length, greaterThanOrEqualTo(3));
    expect(before.first, 14, reason: "初始当前页是第 1 张");

    // 横滑一页 → 第三张候选进入视口、页码点跟随。
    await tester.drag(find.byType(PageView), const Offset(-180, 0));
    await tester.pumpAndSettle();
    expect(find.text("米家空气净化器 5 Pro"), findsOneWidget);
    final List<double> after = dotWidths();
    expect(after.first, 5, reason: "翻页后第 1 个点收缩");
    expect(after.any((double w) => w == 14), isTrue);
  });

  testWidgets("确认卡：未来到期显示倒计时且按钮可点", (WidgetTester tester) async {
    final DateTime expiresAt =
        DateTime.now().toUtc().add(const Duration(minutes: 4, seconds: 30));
    await tester.pumpWidget(
      _host(
        ShoppingConfirmCard(
          cs: ThemeData.light().colorScheme,
          payload: <String, dynamic>{
            "stage": "confirm",
            "title": "待你确认",
            "expiresAt": expiresAt.toIso8601String(),
            "rows": <Map<String, dynamic>>[
              <String, dynamic>{"k": "商品", "v": "米家空气净化器 5"},
              <String, dynamic>{"k": "收货", "v": "杭州市西湖区文一西路 969 号"},
            ],
            "total": "¥1099",
            "totalLabel": "合计",
            "buttons": <Map<String, dynamic>>[
              <String, dynamic>{"label": "先不下", "variant": "secondary"},
              <String, dynamic>{"label": "确认下单", "variant": "primary"},
            ],
          },
        ),
      ),
    );
    await tester.pump();

    expect(find.text("待你确认"), findsOneWidget);
    expect(find.textContaining("04:"), findsOneWidget);
    expect(find.text("确认下单"), findsOneWidget);

    // 计时器每秒一跳：让它走完并确认没有泄漏/异常。
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets("确认卡：令牌过期 → 顶部改「确认已过期」且主按钮不可点",
      (WidgetTester tester) async {
    AgentResultAction? fired;
    final DateTime expired =
        DateTime.now().toUtc().subtract(const Duration(minutes: 1));
    await tester.pumpWidget(
      _host(
        ShoppingConfirmCard(
          cs: ThemeData.light().colorScheme,
          payload: <String, dynamic>{
            "stage": "confirm",
            "expiresAt": expired.toIso8601String(),
            "rows": <Map<String, dynamic>>[
              <String, dynamic>{"k": "商品", "v": "米家空气净化器 5"},
            ],
            "buttons": <Map<String, dynamic>>[
              <String, dynamic>{"label": "确认下单", "variant": "primary"},
            ],
          },
          cardData: const AgentResultData(cardType: "shopping_confirm"),
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            fired = a;
          },
        ),
      ),
    );
    await tester.pump();

    expect(find.text("确认已过期"), findsOneWidget);
    await tester.tap(find.text("确认下单"));
    await tester.pump();
    expect(fired, isNull, reason: "过期后点按钮不应再发动作");
  });

  testWidgets("规格卡：无货选项划线且点击不触发动作", (WidgetTester tester) async {
    final List<AgentResultAction> fired = <AgentResultAction>[];
    await tester.pumpWidget(
      _host(
        ShoppingSpecCard(
          cs: ThemeData.light().colorScheme,
          payload: <String, dynamic>{
            "stage": "spec",
            "title": "米家空气净化器 5",
            "subtitle": "适用 30–48㎡ · 除甲醛 CADR 200m³/h",
            "price": 1099,
            "strikePrice": 1299,
            "specs": <Map<String, dynamic>>[
              <String, dynamic>{
                "key": "滤芯",
                "options": <Map<String, dynamic>>[
                  <String, dynamic>{"label": "标准版", "selected": true},
                  <String, dynamic>{"label": "除醛加强", "disabled": true},
                ],
              },
              <String, dynamic>{
                "key": "颜色",
                "options": <Map<String, dynamic>>[
                  <String, dynamic>{"label": "白", "selected": true},
                  <String, dynamic>{"label": "灰"},
                ],
              },
            ],
            "note": "除醛加强版京东无货；天猫官旗 ¥1249。",
            "primaryLabel": "按标准版下单",
            "secondaryLabel": "换天猫",
          },
          cardData: const AgentResultData(cardType: "shopping_spec"),
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            fired.add(a);
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    final Text disabled = tester.widget<Text>(find.text("除醛加强"));
    expect(disabled.style?.decoration, TextDecoration.lineThrough);

    await tester.tap(find.text("除醛加强"));
    await tester.pump();
    expect(fired, isEmpty, reason: "无货规格不可点");

    // 卡内选项只改卡内状态：点了不发消息、不触发任何动作（历史事故：
    // 「选标准版」被当成一条新提问发给 agent，上下文直接跑偏）。
    await tester.tap(find.text("灰"));
    await tester.pumpAndSettle();
    expect(fired, isEmpty, reason: "选规格不产生动作");

    await tester.tap(find.text("按标准版下单"));
    await tester.pump();
    expect(fired.single.label, "按标准版下单");
    expect(
      (fired.single.payload["specs"] as Map)["颜色"],
      "灰",
      reason: "卡内选择必须随动作一起带回服务端，不能靠文案猜",
    );
  });

  testWidgets("物流卡：四节点按回执渲染，当前节点高亮", (WidgetTester tester) async {
    await tester.pumpWidget(
      _host(
        ShoppingShipmentCard(
          cs: ThemeData.light().colorScheme,
          payload: <String, dynamic>{
            "stage": "shipment",
            "title": "米家空气净化器 5",
            "statusLabel": "运输中",
            "nodes": <Map<String, dynamic>>[
              <String, dynamic>{
                "label": "已发货",
                "state": "now",
                "detail": "2026-11-06 18:12",
              },
              <String, dynamic>{"label": "已支付", "state": "done"},
              <String, dynamic>{"label": "已下单", "state": "done"},
            ],
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("运输中"), findsOneWidget);
    expect(find.text("已发货"), findsOneWidget);
    expect(find.text("已支付"), findsOneWidget);
    expect(find.text("已下单"), findsOneWidget);
    // 未提供承运商时不出现任何编造的运单文案。
    expect(find.textContaining("顺丰"), findsNothing);
  });

  testWidgets("路由：price_compare + extra.shopping 走候选轮播卡",
      (WidgetTester tester) async {
    final AgentResultData data = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "price_compare",
      "title": "比价结果：空气净化器",
      "items": <Map<String, dynamic>>[
        <String, dynamic>{"type": "num", "text": "¥1099 米家 5"},
      ],
      "extra": <String, dynamic>{"shopping": _candidatesPayload()},
    });

    await tester.pumpWidget(
      _host(AgentResultCard(data: data)),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ShoppingCandidatesCard), findsOneWidget);
  });

  testWidgets("路由：载荷缺失时 price_compare 回退旧卡，不抛异常",
      (WidgetTester tester) async {
    final AgentResultData data = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "price_compare",
      "title": "比价结果：空气净化器",
      "items": <Map<String, dynamic>>[
        <String, dynamic>{"type": "num", "text": "¥1099 米家 5"},
      ],
    });

    await tester.pumpWidget(_host(AgentResultCard(data: data)));
    await tester.pumpAndSettle();

    expect(find.byType(ShoppingCandidatesCard), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets("支付卡：服务端 actions 当按钮用，点击回传原 action（带 payload）",
      (WidgetTester tester) async {
    AgentResultAction? fired;
    await tester.pumpWidget(
      _host(
        ShoppingPayCard(
          cs: ThemeData.light().colorScheme,
          payload: <String, dynamic>{
            "stage": "pay",
            "title": "订单已提交 · 待支付",
            "amount": "699",
            "amountLabel": "应付金额",
            "orderNo": "JD20261106001",
            "platformLabel": "jd",
            "note": "我不保存你的支付信息，也不代你扣款",
          },
          cardData: const AgentResultData(
            cardType: "shopping_pay",
            actions: <AgentResultAction>[
              AgentResultAction(
                id: "shopping_pay_done",
                label: "我已完成支付，帮我确认",
                variant: "primary",
                payload: <String, dynamic>{"localOrderId": "so_1"},
              ),
              AgentResultAction(
                id: "shopping_pay_later",
                label: "稍后再说",
                variant: "secondary",
              ),
            ],
          ),
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            fired = a;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 金额与订单号必须留在卡面上（旧逻辑会被通用按钮卡整张替换掉）。
    expect(find.text("¥699"), findsOneWidget);
    expect(find.textContaining("JD20261106001"), findsOneWidget);

    // 主按钮用服务端给的文案，次按钮单列。
    expect(find.text("我已完成支付，帮我确认"), findsOneWidget);
    expect(find.text("稍后再说"), findsOneWidget);

    await tester.tap(find.text("我已完成支付，帮我确认"));
    await tester.pump();
    expect(fired?.id, "shopping_pay_done");
    expect(fired!.payload["localOrderId"], "so_1", reason: "动作上下文不能丢");
  });

  testWidgets("满版卡不被「通用按钮卡」劫持：带 actions 的支付卡仍走购物卡",
      (WidgetTester tester) async {
    final Map<String, dynamic> card = <String, dynamic>{
      "cardType": "shopping_pay",
      "title": "💳 支付确认",
      "items": <Map<String, dynamic>>[
        <String, dynamic>{"type": "check", "text": "订单：米家空气净化器 4 Lite"},
      ],
      "actions": <Map<String, dynamic>>[
        <String, dynamic>{
          "id": "shopping_pay_done",
          "label": "我已完成支付，帮我确认",
          "variant": "primary",
        },
      ],
      "extra": <String, dynamic>{
        "shopping": <String, dynamic>{
          "stage": "pay",
          "title": "订单已提交 · 待支付",
          "amount": "699",
          "orderNo": "JD20261106001",
        },
      },
    };
    final ChatMessage msg = ChatMessage(
      messageId: "m1",
      sessionId: "s1",
      role: "assistant",
      text:
          "[AGENT_RESULT_CARD_START]\n${jsonEncode(card)}\n[AGENT_RESULT_CARD_END]",
      timestamp: DateTime.now(),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext ctx) => SingleChildScrollView(
              child: buildMessageBody(
                ctx,
                Theme.of(ctx).colorScheme,
                msg,
                isUser: false,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ShoppingPayCard), findsOneWidget);
    expect(find.text("¥699"), findsOneWidget);
  });
}
