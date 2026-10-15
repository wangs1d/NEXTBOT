// 手机端主壳 widget 测试：3 tab 导航、我的页菜单、简报页渲染。
// 网络依赖通过注入 http.Client mock 解决；本地存储走临时目录。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";
import "package:private_ai_agent/mobile_ui/mobile_briefing_page.dart";
import "package:private_ai_agent/mobile_ui/mobile_home.dart";

import "helpers/temp_path_provider.dart";

/// 假 http client：/api/morning-briefing 返回样例简报,其余返回 404。
class _MockHttpClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final String url = request.url.toString();
    if (url.contains("/api/morning-briefing")) {
      final String body = jsonEncode(<String, dynamic>{
        "ok": true,
        "briefing": <String, dynamic>{
          "date": "2026-10-07 周三",
          "appellation": "王哥",
          "agentGreeting": "早上好",
          "weather": <String, dynamic>{
            "temperature": 18,
            "condition": "多云",
            "description": "适宜出行",
          },
          "outfitTip": <String, dynamic>{
            "suggestion": "加一件薄外套",
            "reason": "早晚温差大",
          },
          "todaySchedule": <Map<String, dynamic>>[
            <String, dynamic>{"id": "s1", "title": "写周报", "time": "10:00"},
          ],
          "pendingNotes": <Map<String, dynamic>>[
            <String, dynamic>{"id": "n1", "title": "采购清单"},
          ],
          "todoFollowups": <String, dynamic>{
            "pending": <String>["查一下机票"],
            "doneTodayCount": 2,
          },
        },
      });
      return http.StreamedResponse(
        Stream<List<int>>.value(utf8.encode(body)),
        200,
        headers: const <String, String>{"content-type": "application/json; charset=utf-8"},
        request: request,
      );
    }
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode("not found")),
      404,
      request: request,
    );
  }
}

void main() {
  setUp(() {
    PathProviderPlatform.instance = TempPathProviderPlatform();
  });

  testWidgets("主壳渲染 3 个底部导航,默认落在对话页", (WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: MobileHomePage()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(MobileHomePage), findsOneWidget);
    expect(find.text("对话"), findsOneWidget);
    expect(find.text("日程"), findsOneWidget);
    expect(find.text("我的"), findsOneWidget);
    // 图库 tab 已收掉,不应再出现
    expect(find.text("图库"), findsNothing);
  });

  testWidgets("「我的」页展示功能菜单与连接状态", (WidgetTester tester) async {
    // 手机竖屏尺寸(加高到能看全菜单,避免 ListView 懒加载截断)
    tester.view.physicalSize = const Size(412, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      // onLogout 必传：null 时「我的」页隐藏退出登录项（登录门禁在根组件）
      MaterialApp(home: MobileHomePage(initialTabIndex: 2, onLogout: () {})),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    // 已裁撤项不再出现（每日简报/设备/审批为内测裁撤，模型服务更名模型目录）
    expect(find.text("每日简报"), findsNothing);
    // 邮箱/消息中心入口已删除（2026-10-14）：消息统一后台扫描按价值主动推送
    expect(find.text("邮箱"), findsNothing);
    expect(find.text("消息中心"), findsNothing);
    expect(find.text("设备"), findsNothing);
    expect(find.text("审批"), findsNothing);
    expect(find.text("模型服务"), findsNothing);
    expect(find.text("服务接入"), findsOneWidget);
    expect(find.text("模型目录"), findsOneWidget);
    expect(find.text("帮助与反馈"), findsOneWidget);
    expect(find.text("退出登录"), findsOneWidget);
    // 连接状态行(测试环境 WS 连不上 → 未连接)
    expect(find.text("未连接"), findsOneWidget);
  });

  testWidgets("简报页渲染服务端样例数据", (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MobileBriefingPage(client: _MockHttpClient()),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text("2026-10-07 周三"), findsOneWidget);
    expect(find.text("王哥，早上好"), findsOneWidget);
    expect(find.text("多云 18°C"), findsOneWidget);
    expect(find.text("今日日程"), findsOneWidget);
    expect(find.text("写周报"), findsOneWidget);
    expect(find.text("没看过的笔记"), findsOneWidget);
    expect(find.text("采购清单"), findsOneWidget);
    expect(find.text("之前交代的事"), findsOneWidget);
    expect(find.text("穿衣建议"), findsOneWidget);
  });
}
