// 手机端动态页回归：邮件收束、类型级槽位互斥、玻璃聚合卡与长按拖拽。
// 数据注入 mock client，不发真实网络。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:nextbot/mobile_ui/mobile_dynamics_page.dart";

/// 假 http client：/api/dynamics 返回指定响应。
class _MockDynamicsHttp extends http.BaseClient {
  _MockDynamicsHttp([this.response]);

  final Map<String, dynamic>? response;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final Map<String, dynamic> body = response ??
        <String, dynamic>{
          "ok": true,
          "bills": <String, dynamic>{
            "count": 0,
            "totalAmount": 0,
            "recent": <dynamic>[],
          },
          "parcels": <String, dynamic>{
            "awaitingPickup": 0,
            "recent": <dynamic>[],
          },
          "alerts": <String, dynamic>{
            "pending": <dynamic>[],
            "activity": <dynamic>[],
          },
          "mail": <String, dynamic>{
            "recent": <Map<String, dynamic>>[
              <String, dynamic>{"title": "邮件A 旧", "text": "摘要A", "at": 1000},
              <String, dynamic>{"title": "邮件C 最新", "text": "摘要C", "at": 3000},
              <String, dynamic>{"title": "邮件B 中", "text": "摘要B", "at": 2000},
            ],
          },
        };
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(jsonEncode(body))),
      200,
      headers: const <String, String>{
        "content-type": "application/json; charset=utf-8",
      },
      request: request,
    );
  }
}

Widget _wrap([Map<String, dynamic>? response]) => MaterialApp(
      home: MobileDynamicsPage(client: _MockDynamicsHttp(response)),
    );

Map<String, dynamic> _richBody() {
  final int now = DateTime.now().millisecondsSinceEpoch;
  return <String, dynamic>{
    "ok": true,
    "bills": <String, dynamic>{
      "count": 2,
      "totalAmount": 127,
      "recent": <Map<String, dynamic>>[
        <String, dynamic>{
          "id": "bill-1",
          "title": "美团 · 餐饮",
          "billType": "餐饮",
          "amount": 68,
          "source": "email",
          "occurredAt": now - 1000,
        },
        <String, dynamic>{
          "id": "bill-2",
          "title": "中国移动 · 话费",
          "billType": "话费",
          "amount": 59,
          "source": "sms",
          "occurredAt": now - 2000,
        },
      ],
    },
    "monthly": <String, dynamic>{
      "month": "2026-11",
      "monthLabel": "11月",
      "complete": false,
      "totals": <String, dynamic>{
        "totalAmount": 127,
        "count": 2,
        "amountCount": 2,
        "missingAmount": 0,
      },
      "previous": <String, dynamic>{"month": "2026-10"},
      "mom": <String, dynamic>{
        "direction": "up",
        "deltaAmount": 27,
        "ratio": 0.27,
      },
      "topCategories": <Map<String, dynamic>>[
        <String, dynamic>{"type": "餐饮", "amount": 68, "ratio": 0.54},
        <String, dynamic>{"type": "话费", "amount": 59, "ratio": 0.46},
      ],
      "largest": <String, dynamic>{"title": "美团 · 餐饮", "amount": 68},
      "subscriptions": <String, dynamic>{},
      "coverageHint": "",
    },
    "parcels": <String, dynamic>{
      "awaitingPickup": 1,
      "recent": <Map<String, dynamic>>[
        <String, dynamic>{
          "id": "parcel-1",
          "title": "顺丰速运 · 已到驿站",
          "carrier": "顺丰速运",
          "pickupCode": "SF001",
          "trackingNo": "SF123",
          "occurredAt": now - 3000,
        },
        <String, dynamic>{
          "id": "parcel-2",
          "title": "包裹历史",
          "carrier": "京东物流",
          "trackingNo": "JD123",
          "occurredAt": now - 86400000,
        },
      ],
    },
    "alerts": <String, dynamic>{
      "pending": <Map<String, dynamic>>[
        <String, dynamic>{"title": "不应出现的提醒"},
      ],
      "activity": <Map<String, dynamic>>[
        <String, dynamic>{"title": "不应出现的 Agent 足迹"},
      ],
    },
    "mail": <String, dynamic>{
      "recent": <Map<String, dynamic>>[
        <String, dynamic>{
          "title": "航司里程到账提醒",
          "text": "里程已到账",
          "at": now - 4000,
          "salience": "high",
        },
      ],
    },
  };
}

Future<void> _pumpDynamics(
  WidgetTester tester, [
  Map<String, dynamic>? response,
]) async {
  tester.view.physicalSize = const Size(430, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(_wrap(response));
  // MobilePageCache 读盘在 FakeAsync 下有 1s 兜底超时，推进足够时间让 mock 回包上屏。
  await tester.pump(const Duration(seconds: 3));
}

Future<void> _longPressDrag(
  WidgetTester tester,
  Offset start,
  Offset target,
) async {
  final TestGesture gesture = await tester.startGesture(start);
  await tester.pump(const Duration(milliseconds: 700));
  await gesture.moveBy(const Offset(0, -20));
  await tester.pump(const Duration(milliseconds: 80));
  await gesture.moveTo(target);
  await tester.pump(const Duration(milliseconds: 320));
  await gesture.up();
  await tester.pumpAndSettle();
  // 拖拽会触发布局落盘，_DynamicsLayoutStore.save 里有 1s 的读盘兜底 Timer
  // （FakeAsync 下 path_provider 永远不回包），推进 1s 让它触发，否则测试
  // 收尾时该 Timer 仍挂起会判失败。轮播因拖拽暂停+节奏重置，此 1s 不会翻页。
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets("邮件收束成一张聚合卡，槽位卡面只展示最新一封", (WidgetTester tester) async {
    await _pumpDynamics(tester);

    // 只有邮件一类数据 → 唯一的卡自动补位到槽 0，信息流不重复出现。
    final Finder slot0 = find.byKey(const ValueKey<String>("dynamics-slot-0"));
    expect(
      find.descendant(of: slot0, matching: find.text("邮件C 最新")),
      findsOneWidget,
    );
    expect(find.text("邮件A 旧"), findsNothing);
    expect(find.text("邮件B 中"), findsNothing);
    // 旧的统计文案已删除。
    expect(find.text("共 3 封"), findsNothing);
    expect(find.text("共 3 封 · 查看全部"), findsNothing);
  });

  testWidgets("点槽位邮件卡进全屏详情页，按新→旧展示全部邮件", (WidgetTester tester) async {
    await _pumpDynamics(tester);

    await tester.tap(find.text("邮件C 最新"));
    await tester.pumpAndSettle();

    // 详情页三封都在。
    expect(find.text("邮件A 旧"), findsOneWidget);
    expect(find.text("邮件B 中"), findsOneWidget);
    expect(find.text("邮件C 最新"), findsOneWidget);
    // 顺序为最新在前：C 的位置早于 B 早于 A。
    final double yC = tester.getTopLeft(find.text("邮件C 最新")).dy;
    final double yB = tester.getTopLeft(find.text("邮件B 中")).dy;
    final double yA = tester.getTopLeft(find.text("邮件A 旧")).dy;
    expect(yC, lessThan(yB));
    expect(yB, lessThan(yA));
  });

  testWidgets("顶部两槽按待处理优先级动态填充，且不渲染提醒和 Agent 足迹", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    final Finder slot0 = find.byKey(const ValueKey<String>("dynamics-slot-0"));
    final Finder slot1 = find.byKey(const ValueKey<String>("dynamics-slot-1"));
    expect(
      find.descendant(of: slot0, matching: find.text("快递")),
      findsOneWidget,
    );
    // 置顶进槽位后取件码照样展示。
    expect(
      find.descendant(of: slot0, matching: find.text("SF001")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: slot1, matching: find.text("邮件")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: slot1, matching: find.text("航司里程到账提醒")),
      findsOneWidget,
    );
    expect(find.text("不应出现的提醒"), findsNothing);
    expect(find.text("不应出现的 Agent 足迹"), findsNothing);
  });

  testWidgets("顶部不再提供排序、刷新和月报菜单", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    expect(find.text("排序"), findsNothing);
    expect(find.text("完成"), findsNothing);
    expect(find.byTooltip("刷新"), findsNothing);
    expect(find.byTooltip("账单月报"), findsNothing);
    expect(find.byIcon(Icons.receipt_long_outlined), findsNothing);
  });

  testWidgets("账单月报收进详情页：动态页无小结，点账单卡可打开明细", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    // 月份小结已从动态页移除，只在详情页里。
    expect(find.text("11月小结"), findsNothing);

    await tester.tap(find.text("账单 · 11月"));
    await tester.pumpAndSettle();
    expect(find.text("11月小结"), findsOneWidget);
    expect(find.text("账单明细（点一条改类目）"), findsOneWidget);
  });

  testWidgets("浏览态长按账单卡拖入顶部槽位，原快递卡回落信息流", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    final Finder slot0 = find.byKey(const ValueKey<String>("dynamics-slot-0"));
    await _longPressDrag(
      tester,
      tester.getCenter(find.text("账单 · 11月")),
      tester.getCenter(slot0),
    );

    // 槽 0 变成账单聚合卡，卡面轮播第一页是本月合计。
    expect(
      find.descendant(of: slot0, matching: find.text("账单")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: slot0, matching: find.text("¥127")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: slot0, matching: find.text("SF001")),
      findsNothing,
    );
    // 被挤出的快递卡回到信息流（卡面轮播第一页是待取件）。
    expect(find.text("顺丰速运 · 已到驿站"), findsOneWidget);
  });

  testWidgets("信息流卡片拖到另一张信息流卡上可调整顺序", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    // 第一步：把槽位里的邮件卡拖到信息流账单卡上 → 邮件移出置顶回到信息流，
    // 空出的槽位按优先级自动补位（账单顶上）。
    await _longPressDrag(
      tester,
      tester.getCenter(find.text("航司里程到账提醒")),
      tester.getCenter(find.text("账单 · 11月")),
    );
    // 第二步：把槽位里的账单卡拖到邮件卡上 → 账单也回到信息流、排在邮件前。
    await _longPressDrag(
      tester,
      tester.getCenter(find.text("¥127")),
      tester.getCenter(find.text("航司里程到账提醒")),
    );
    // 第三步：两张信息流卡之间拖动换序（邮件拖到账单卡上）。
    await _longPressDrag(
      tester,
      tester.getCenter(find.text("航司里程到账提醒")),
      tester.getCenter(find.text("账单 · 11月")),
    );

    final double yMail = tester.getTopLeft(find.text("航司里程到账提醒")).dy;
    final double yBill = tester.getTopLeft(find.text("账单 · 11月")).dy;
    expect(yMail, lessThan(yBill));
  });

  testWidgets("顶部两张卡可直接长按拖动换位", (WidgetTester tester) async {
    await _pumpDynamics(tester, _richBody());

    final Finder slot0 = find.byKey(const ValueKey<String>("dynamics-slot-0"));
    final Finder slot1 = find.byKey(const ValueKey<String>("dynamics-slot-1"));
    final Finder mail = find.descendant(
      of: slot1,
      matching: find.text("航司里程到账提醒"),
    );
    await _longPressDrag(
      tester,
      tester.getCenter(mail),
      tester.getCenter(slot0),
    );

    expect(
      find.descendant(of: slot0, matching: find.text("航司里程到账提醒")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: slot1, matching: find.text("SF001")),
      findsOneWidget,
    );
  });
}
