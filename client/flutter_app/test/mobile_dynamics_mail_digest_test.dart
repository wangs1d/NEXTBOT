// 手机端动态页「邮件要事」收束卡回归：多封叠成一张薄卡、卡面=最新一封、
// 点进去进全屏详情页按新→旧看全部。数据注入 mock client，不发真实网络。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:nextbot/mobile_ui/mobile_dynamics_page.dart";

/// 假 http client：/api/dynamics 返回 3 封乱序邮件。
class _MockDynamicsHttp extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final Map<String, dynamic> body = <String, dynamic>{
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

Widget _wrap() => MaterialApp(
      home: MobileDynamicsPage(client: _MockDynamicsHttp()),
    );

void main() {
  testWidgets("邮件区块收束成一张卡，卡面展示最新一封并标注封数",
      (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    // MobilePageCache 读盘在 FakeAsync 下有 1s 兜底超时，推进足够时间让 mock 回包上屏。
    await tester.pump(const Duration(seconds: 3));

    expect(find.text("邮件要事"), findsOneWidget);
    // 三封邮件只叠成一张薄卡：只有一个「查看全部」提示。
    expect(find.text("共 3 封 · 查看全部"), findsOneWidget);
    // 卡面标题/摘要取 at 最大的最新一封，不是接口返回顺序的第一封。
    expect(find.text("邮件C 最新"), findsOneWidget);
    expect(find.text("邮件A 旧"), findsNothing);
    expect(find.text("邮件B 中"), findsNothing);
  });

  testWidgets("点收束卡进全屏详情页，按新→旧展示全部邮件",
      (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await tester.pump(const Duration(seconds: 3));

    await tester.tap(find.text("共 3 封 · 查看全部"));
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
}
