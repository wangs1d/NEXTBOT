import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/shopping/shopping_login_card.dart";

/// 登录卡视觉快照（2026-11-13 P1）：多码分区 + 跳过 + 待登录清单。
Widget _host(Widget child, {double width = 430}) {
  return MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      backgroundColor: const Color(0xFF141414),
      body: SizedBox(width: width, child: SingleChildScrollView(child: child)),
    ),
  );
}

void main() {
  testWidgets("shot", (WidgetTester tester) async {
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login",
      "title": "请扫码登录（淘宝、京东、拼多多）",
      "multiLogin": true,
      "qrItems": <Map<String, dynamic>>[
        <String, dynamic>{
          "platform": "taobao",
          "platformLabel": "淘宝",
          "qrImage": "",
        },
        <String, dynamic>{
          "platform": "jd",
          "platformLabel": "京东",
          "qrImage": "",
        },
      ],
      "pendingPlatforms": <Map<String, dynamic>>[
        <String, dynamic>{"platform": "pdd", "platformLabel": "拼多多"},
      ],
      "note": "扫下面任意一个码即可，登录完我会自动继续比价",
      "primaryLabel": "我扫好了",
      "secondaryLabel": "先不比了",
      "primaryAction": "shopping.login.check",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{
        "platforms": <String>["taobao", "jd", "pdd"],
      },
    };

    await tester.pumpWidget(_host(ShoppingLoginCard(
      cs: ThemeData.dark().colorScheme,
      payload: payload,
    )));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(ShoppingLoginCard),
      matchesGoldenFile("goldens/shopping_login_card_p1.png"),
    );
  });
}
