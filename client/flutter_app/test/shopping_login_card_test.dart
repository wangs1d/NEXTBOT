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

  testWidgets("点码登录：没有深链的平台（无 scheme 表）显示「保存二维码」",
      (WidgetTester tester) async {
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login",
      "title": "登录大麦",
      "platform": "damai",
      "platformLabel": "大麦",
      "qrImage": "",
      "note": "扫码登录，完成后点下面的按钮",
      "primaryLabel": "我扫好了",
      "secondaryLabel": "先不比了",
      "primaryAction": "shopping.login.check",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{"platform": "damai"},
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

    expect(find.text("保存二维码"), findsOneWidget);
    expect(find.text("点码登录"), findsNothing);
  });

  testWidgets("手动导入 Cookie：单家登录卡有入口，点击弹粘贴框，提交回传 cookieText",
      (WidgetTester tester) async {
    final List<AgentResultAction> captured = <AgentResultAction>[];
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login",
      "title": "登录拼多多",
      "platform": "pdd",
      "platformLabel": "拼多多",
      "qrImage": "",
      "note": "扫完不用回来点，我会自动接着比价",
      "primaryLabel": "我扫好了（不点也行）",
      "secondaryLabel": "先不比了",
      "primaryAction": "shopping.login.check",
      "secondaryAction": "local.dismiss",
      "actions": <String, dynamic>{"platform": "pdd"},
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

    // 入口常驻在等登录卡上
    expect(find.text("手动导入 Cookie"), findsOneWidget);
    await tester.tap(find.text("手动导入 Cookie"));
    await tester.pumpAndSettle();

    // 粘贴框出现：带教学文案与输入框
    expect(find.text("导入拼多多 Cookie"), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    await tester.enterText(
      find.byType(TextField),
      "Cookie: api_uid=x; PDDUserID=U123",
    );
    await tester.tap(find.text("提交"));
    await tester.pumpAndSettle();

    expect(captured, hasLength(1));
    expect(captured.first.payload["cardAction"], "shopping.login.import");
    expect(captured.first.payload["platform"], "pdd");
    expect(captured.first.payload["cookieText"], contains("PDDUserID=U123"));
  });

  testWidgets("手动导入 Cookie：多平台卡先选哪家，选择后才弹粘贴框",
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

    await tester.tap(find.text("手动导入 Cookie"));
    await tester.pumpAndSettle();
    // 先是平台选择器，不是粘贴框
    expect(find.text("给哪家导入 Cookie？"), findsOneWidget);
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.widgetWithText(SimpleDialogOption, "淘宝"));
    await tester.pumpAndSettle();
    expect(find.text("导入淘宝 Cookie"), findsOneWidget);
    await tester.enterText(find.byType(TextField), "cookie2=abc; unb=1");
    await tester.tap(find.text("提交"));
    await tester.pumpAndSettle();

    expect(captured, hasLength(1));
    expect(captured.first.payload["platform"], "taobao");
  });

  testWidgets("「是否保存」确认卡不出现导入入口（已导完，避免误导再导一次）",
      (WidgetTester tester) async {
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login",
      "title": "检测到拼多多登录 Cookie",
      "platform": "pdd",
      "platformLabel": "拼多多",
      "note": "要保存吗？保存后以后比价拼多多不用再扫码",
      "primaryLabel": "保存并永久使用",
      "secondaryLabel": "仅本次使用",
      "primaryAction": "shopping.login.import.confirm",
      "secondaryAction": "shopping.login.import.confirm",
      "actions": <String, dynamic>{"platform": "pdd", "save": true},
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

    expect(find.text("保存并永久使用"), findsOneWidget);
    expect(find.text("手动导入 Cookie"), findsNothing);
  });

  testWidgets("统一保存闸卡（2026-11-21）：同意/仅本次都回 consent 动作，"
      "次按钮 allow=false 覆盖主 payload，且不出现导入入口",
      (WidgetTester tester) async {
    final List<AgentResultAction> captured = <AgentResultAction>[];
    final Map<String, dynamic> payload = <String, dynamic>{
      "stage": "login-consent",
      "title": "允许保存登录 Cookie 吗？",
      "platform": "pdd",
      "platformLabel": "拼多多",
      "note": "统一开关：同意一次，之后所有平台的登录态都默认保存",
      "primaryLabel": "同意，以后都自动保存",
      "secondaryLabel": "仅本次使用",
      "primaryAction": "shopping.login.import.consent",
      "secondaryAction": "shopping.login.import.consent",
      "actions": <String, dynamic>{"platform": "pdd", "allow": true},
      "secondaryPayload": <String, dynamic>{"allow": false},
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

    // 统一闸卡上不该再出现「手动导入 Cookie」（刚导完，避免误导再导一次）
    expect(find.text("同意，以后都自动保存"), findsOneWidget);
    expect(find.text("仅本次使用"), findsOneWidget);
    expect(find.text("手动导入 Cookie"), findsNothing);

    // 主按钮：回 consent 动作，allow 继承 actions 里的 true
    await tester.tap(find.text("同意，以后都自动保存"));
    await tester.pumpAndSettle();
    expect(captured, hasLength(1));
    expect(captured.first.id, "shopping.login.import.consent");
    expect(captured.first.payload["cardAction"], "shopping.login.import.consent");
    expect(captured.first.payload["allow"], true);

    // 次按钮：同一动作，但 secondaryPayload 的 allow=false 覆盖默认
    final Map<String, dynamic> payload2 =
        Map<String, dynamic>.from(payload);
    final AgentResultData cardData2 = AgentResultData.fromJson(<String, dynamic>{
      "cardType": "shopping_login",
      "extra": <String, dynamic>{"shopping": payload2},
    });
    await tester.pumpWidget(
      _host(
        ShoppingLoginCard(
          key: const ValueKey<String>("gate-2"),
          cs: ThemeData.light().colorScheme,
          payload: payload2,
          cardData: cardData2,
          onUserAction: (AgentResultAction a,
              {required AgentResultData cardData}) {
            captured.add(a);
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text("仅本次使用"));
    await tester.pumpAndSettle();
    expect(captured, hasLength(2));
    expect(captured.last.id, "shopping.login.import.consent");
    expect(captured.last.payload["allow"], false,
        reason: "「仅本次」必须显式 allow=false，服务端据此不落统一授权");
  });
}
