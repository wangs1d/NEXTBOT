import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/shopping/shopping_candidates_card.dart";

Widget _host(Widget child, {double width = 430}) {
  return MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      backgroundColor: const Color(0xFF141414),
      body: SizedBox(width: width, child: SingleChildScrollView(child: child)),
    ),
  );
}

Map<String, dynamic> _item(
  String p,
  String label,
  double price,
  String shop,
  String title,
) =>
    <String, dynamic>{
      "title": title,
      "price": price,
      "platform": p,
      "platformLabel": label,
      "shop": shop,
      "orderable": true,
      "fetchedAt": DateTime(2026, 11, 13, 20, 31).millisecondsSinceEpoch,
    };

void main() {
  testWidgets("shot", (WidgetTester tester) async {
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "candidates",
      "title": "小米14 Ultra 256GB · 3选一",
      "sortLabel": "按到手价",
      "bestIndex": 0,
      "bestLabel": "最合适",
      "items": <Map<String, dynamic>>[
        _item("jd", "京东", 2899, "京东自营旗舰店", "小米14 Ultra 256GB 黑色"),
        _item("taobao", "淘宝", 2999, "小米官方旗舰店", "小米14 Ultra 256GB 黑色"),
        _item("pdd", "拼多多", 2799, "小米京东自营店", "小米14 Ultra 256GB 黑色"),
      ],
      "missingPlatforms": <Map<String, dynamic>>[
        <String, dynamic>{
          "platform": "tmall",
          "platformLabel": "天猫",
          "reason": "login",
        },
        <String, dynamic>{
          "platform": "suning",
          "platformLabel": "苏宁",
          "reason": "no_data",
        },
      ],
      "footer": "信息为实时抓取，以下单结算页为准",
    };

    await tester.pumpWidget(_host(ShoppingCandidatesCard(
      cs: ThemeData.dark().colorScheme,
      payload: payload,
    )));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(ShoppingCandidatesCard),
      matchesGoldenFile("goldens/shopping_candidates_platform.png"),
    );
  });
}
