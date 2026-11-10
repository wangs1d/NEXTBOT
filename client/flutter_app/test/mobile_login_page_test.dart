import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/mobile_ui/mobile_login_page.dart";

/// 登录 / 注册界面拆分回归测试（2026-11）：
/// 落地页必须同时有「登录」和「创建账号」两个入口；登录卡片只要邮箱+验证码
/// （注册过的用户不再被迫填名称），注册卡片才要求「你的名称」。
///
/// 注意：登录页有一条无限循环的呼吸动画，不能用 pumpAndSettle（永不静止），
/// 统一用定长 pump 推进路由/弹窗过渡。
Future<void> _boot(WidgetTester tester) async {
  await tester.pumpWidget(MaterialApp(
    home: MobileLoginPage(onLoggedIn: (_) {}),
  ));
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets("落地页：登录与注册是两个入口", (WidgetTester tester) async {
    await _boot(tester);
    expect(find.widgetWithText(FilledButton, "登录"), findsOneWidget);
    expect(find.text("没有账号？创建账号"), findsOneWidget);
  });

  testWidgets("点「登录」：卡片只要邮箱+验证码，不要名称", (WidgetTester tester) async {
    await _boot(tester);
    await tester.tap(find.widgetWithText(FilledButton, "登录"));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text("用注册过的邮箱登录"), findsOneWidget);
    expect(find.text("邮箱"), findsOneWidget);
    expect(find.text("验证码"), findsOneWidget);
    expect(find.text("你的名称"), findsNothing, reason: "登录不应再要求填名称");
    expect(find.text("还没有账号？创建账号"), findsOneWidget);
  });

  testWidgets("点「没有账号？创建账号」：卡片含名称字段", (WidgetTester tester) async {
    await _boot(tester);
    await tester.tap(find.text("没有账号？创建账号"));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text("新账号，一分钟搞定"), findsOneWidget);
    expect(find.text("你的名称"), findsOneWidget);
    expect(find.text("邮箱"), findsOneWidget);
    expect(find.text("验证码"), findsOneWidget);
    expect(find.text("已有账号？去登录"), findsOneWidget);
  });

  testWidgets("卡片内可登录⇄注册来回切，名称字段跟着出现/消失",
      (WidgetTester tester) async {
    await _boot(tester);
    await tester.tap(find.widgetWithText(FilledButton, "登录"));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text("你的名称"), findsNothing);

    // 登录 → 注册
    await tester.tap(find.text("还没有账号？创建账号"));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text("你的名称"), findsOneWidget);

    // 注册 → 登录
    await tester.tap(find.text("已有账号？去登录"));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text("你的名称"), findsNothing);
  });
}
