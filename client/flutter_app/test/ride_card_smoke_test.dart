import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/features/chat/ride_hailing_card.dart";

void main() {
  testWidgets("叫车卡：选点阶段确认后在同一张卡上换成车型", (WidgetTester tester) async {
    // 真机宽度（360dp）：车型行里「车图 + 名称 + 价格」必须排得下，溢出会直接失败
    tester.view.physicalSize = const Size(360, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final Map<String, dynamic> pickup = <String, dynamic>{
      "stage": "pickup",
      "map3d": false,
      "dropoff": "万峰林",
      "candidates": <Map<String, dynamic>>[
        <String, dynamic>{"name": "九华苑停车场", "address": "永康路21号", "lat": 25.0881, "lng": 104.9017, "distM": 112},
      ],
    };
    final Map<String, dynamic> quote = <String, dynamic>{
      "stage": "quote",
      "map3d": false,
      "pickup": "九华苑停车场",
      "dropoff": "万峰林",
      "options": <Map<String, dynamic>>[
        <String, dynamic>{
          "optionId": "didi:trace:191",
          "name": "惊喜特价",
          "price": "¥5",
          "etaMinutes": 3,
          "action": <String, dynamic>{"cardAction": "ride.book.prepare", "id": "a", "payload": <String, dynamic>{}},
        },
        <String, dynamic>{
          "optionId": "didi:trace:1",
          "name": "快车",
          "price": "¥6",
          "etaMinutes": 4,
          "action": <String, dynamic>{"cardAction": "ride.book.prepare", "id": "b", "payload": <String, dynamic>{}},
        },
      ],
      "route": <String, dynamic>{
        "distanceText": "5.2 公里",
        "durationText": "12 分钟",
        "points": <List<double>>[
          <double>[25.0881, 104.9017],
          <double>[25.0400, 104.8600],
        ],
      },
    };

    Map<String, dynamic> current = pickup;
    late StateSetter swap;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (BuildContext context, StateSetter setState) {
              swap = setState;
              return SingleChildScrollView(
                child: RideHailingCard(
                  cs: Theme.of(context).colorScheme,
                  payload: current,
                ),
              );
            },
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text("选上车点"), findsOneWidget);
    expect(find.text("从这里上车"), findsOneWidget);
    expect(find.text("九华苑停车场"), findsWidgets);

    // 服务端 card.update 换成车型载荷：同一张卡，不追加第二张
    swap(() => current = quote);
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text("选车型"), findsOneWidget);
    expect(find.text("选上车点"), findsNothing);
    expect(find.text("惊喜特价"), findsOneWidget);
    expect(find.text("快车"), findsOneWidget);
    expect(find.text("¥5"), findsOneWidget);
    expect(find.text("5.2 公里 · 12 分钟"), findsOneWidget);
  });
}
