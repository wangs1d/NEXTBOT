import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/shopping/shopping_login_card.dart";

/// 购物登录卡（2026-11-13 P1）行为测试。
///
/// P1 要在卡里闭环三件事，都不回到对话里：
///   1. 「跳过这家」——放弃某个待登录平台，其余照常比；
///   2. 「补齐待登录平台」——待登录清单常驻卡上，剩余平台逐家可见；
///   3. 「重新出码」——二维码过期时原地换新码。
///
/// 点码登录（2026-11-14）补两条：
///   4. 服务端给了 qrLink（解码二维码转的 App 深链）→ 卡上出现「点码登录」，
///      点了经 url_launcher 拉起对应 App；
///   5. 旧载荷没有 qrLink → 不渲染按钮，行为与从前完全一致。
Widget _host(Widget child) {
  return MaterialApp(
    theme: ThemeData.light(),
    home: Scaffold(
      backgroundColor: const Color(0xFFF7F7F8),
      body: SizedBox(
        width: 390,
        child: SingleChildScrollView(child: child),
      ),
    ),
  );
}

Map<String, dynamic> _multiLoginPayload() => <String, dynamic>{
      "stage": "login",
      "title": "请扫码登录（淘宝、京东）",
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
        <String, dynamic>{"platform": "taobao", "platformLabel": "淘宝"},
        <String, dynamic>{"platform": "jd", "platformLabel": "京东"},
      ],
      "note": "扫下面任意一个码即可，登录完我会自动继续比价",
      "primaryLabel": "我扫好了",
      "secondaryLabel": "先不比了",
      "primaryAction": "shopping.login.check",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{"platforms": <String>["taobao", "jd"]},
    };

void main() {
  testWidgets("多平台登录卡：每个平台分区都有「跳过这家」，点它回传平台",
      (WidgetTester tester) async {
    final List<AgentResultAction> captured = <AgentResultAction>[];
    final Map<String, dynamic> payload = _multiLoginPayload();
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            captured.add(a);
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 两家平台都在卡上（来源必须显眼）
    expect(find.text("淘宝"), findsWidgets);
    expect(find.text("京东"), findsWidgets);
    // 每家一个「跳过这家」
    expect(find.text("跳过这家"), findsNWidgets(2));

    // 点其中一个 → 回传 shopping.login.skip + 平台 id
    final Finder skipButtons = find.text("跳过这家");
    await tester.tap(skipButtons.first);
    await tester.pumpAndSettle();

    expect(captured.length, 1, reason: "应回传一个跳过动作");
    final Map<String, dynamic> sent = captured.first.payload;
    expect(sent["cardAction"], "shopping.login.skip");
    expect(sent["platform"], "taobao");
    // 卡内动作的公共上下文（平台名单）也要带上
    expect(sent["platforms"], <String>["taobao", "jd"]);
  });

  testWidgets("登录卡：卡上有「重新出码」入口（二维码失效可原地换新）",
      (WidgetTester tester) async {
    final List<AgentResultAction> captured = <AgentResultAction>[];
    final Map<String, dynamic> payload = _multiLoginPayload();
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            captured.add(a);
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("重新出码"), findsOneWidget);
    await tester.tap(find.text("重新出码"));
    await tester.pumpAndSettle();

    expect(captured.isNotEmpty, isTrue, reason: "应回传重新出码动作");
    expect(captured.first.payload["cardAction"], "shopping.login.refresh");
  });

  testWidgets("部分登录后：卡上列出还差哪几家，并可逐家跳过/重新出码",
      (WidgetTester tester) async {
    final List<AgentResultAction> captured = <AgentResultAction>[];
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login-consent",
      "title": "淘宝登录成功",
      "multiLogin": true,
      "readyPlatforms": <String>["taobao"],
      "readyPlatformLabels": <String>["淘宝"],
      "pendingPlatforms": <Map<String, dynamic>>[
        <String, dynamic>{"platform": "jd", "platformLabel": "京东"},
      ],
      "note": "还差：京东（可重新出码，或跳过这家只比其余平台）",
      "primaryLabel": "继续比价（补齐剩余平台）",
      "secondaryLabel": "先比已登录的",
      "primaryAction": "shopping.compare.resume",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{"platforms": <String>["jd"]},
    };
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            captured.add(a);
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 已登录的先说清楚（中文名，不是平台 id）
    expect(find.text("已登录：淘宝"), findsOneWidget);
    // 还差的那家在清单里，标着平台名
    expect(find.text("京东"), findsWidgets);
    expect(find.text("需要登录"), findsOneWidget);
    // 两个行内动作都在
    expect(find.text("重新出码"), findsOneWidget);
    expect(find.text("跳过这家"), findsOneWidget);

    await tester.tap(find.text("跳过这家"));
    await tester.pumpAndSettle();
    expect(captured.length, 1);
    expect(captured.first.payload["cardAction"], "shopping.login.skip");
    expect(captured.first.payload["platform"], "jd");
  });

  testWidgets("点码登录：qrItems 带 qrLink 时每家渲染「点码登录」，点了拉起 App",
      (WidgetTester tester) async {
    final List<String> launched = <String>[];
    const MethodChannel launcherChannel =
        MethodChannel("plugins.flutter.io/url_launcher");
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      launcherChannel,
      (MethodCall call) async {
        if (call.method == "launch") {
          launched.add(call.arguments["url"] as String);
          return true;
        }
        return null;
      },
    );
    addTearDown(() =>
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          launcherChannel,
          null,
        ));

    final Map<String, dynamic> payload = _multiLoginPayload();
    // 服务端解码二维码转出的深链（淘宝 tbopen 包装）
    (payload["qrItems"] as List<Map<String, dynamic>>).first["qrLink"] =
        "tbopen://m.taobao.com/tbopen/index.html?h5Url=https%3A%2F%2Fh5.m.taobao.com%2Fqr%2Flogin";
    (payload["qrItems"] as List<Map<String, dynamic>>).first["qrLinkFallback"] =
        "https://h5.m.taobao.com/qr/login";
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 京东没给 qrLink → 只有淘宝一格有按钮
    expect(find.text("点码登录"), findsOneWidget);

    await tester.tap(find.text("点码登录"));
    await tester.pumpAndSettle();

    expect(launched, hasLength(1));
    expect(launched.first, startsWith("tbopen://m.taobao.com/tbopen/index.html"));
  });

  testWidgets("点码登录：旧载荷没有 qrLink 时不渲染按钮（纯扫码兜底不变）",
      (WidgetTester tester) async {
    final Map<String, dynamic> payload = _multiLoginPayload();
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("点码登录"), findsNothing);
    // 原有按钮一个不少
    expect(find.text("跳过这家"), findsNWidgets(2));
    expect(find.text("重新出码"), findsOneWidget);
  });

  testWidgets("点码登录：下单单家卡（字段在顶层）也渲染按钮并拉起 App",
      (WidgetTester tester) async {
    final List<String> launched = <String>[];
    const MethodChannel launcherChannel =
        MethodChannel("plugins.flutter.io/url_launcher");
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      launcherChannel,
      (MethodCall call) async {
        if (call.method == "launch") {
          launched.add(call.arguments["url"] as String);
          return true;
        }
        return null;
      },
    );
    addTearDown(() =>
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          launcherChannel,
          null,
        ));

    // 下单链路的单家卡：没有 qrItems，qrImage/qrLink 铺在 payload 顶层
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login",
      "title": "登录京东",
      "platform": "jd",
      "platformLabel": "京东",
      "qrImage": "",
      "qrLink":
          "openapp.jdmobile://virtual?params=%7B%22category%22%3A%22jump%22%2C%22des%22%3A%22url%22%7D",
      "qrLinkFallback": "https://plogin.m.jd.com/qr/login",
      "note": "点「点码登录」拉起 App 确认，或用 App 扫这个码，完成后点下面的按钮",
      "primaryLabel": "我扫好了",
      "secondaryLabel": "先不买",
      "primaryAction": "shopping.login.check",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{"platform": "jd"},
    };
    final AgentResultData cardData = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload},
    });

    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          cs: ThemeData.light().colorScheme,
          payload: payload,
          cardData: cardData,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("点码登录"), findsOneWidget);
    await tester.tap(find.text("点码登录"));
    await tester.pumpAndSettle();

    expect(launched, hasLength(1));
    expect(launched.first, startsWith("openapp.jdmobile://"));
  });
}
