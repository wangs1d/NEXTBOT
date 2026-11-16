// 手机端主壳 widget 测试：4 tab 自绘导航卡、设置页菜单、简报页渲染。
// 网络依赖通过注入 http.Client mock 解决；本地存储走临时目录。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";
import "package:nextbot/mobile_ui/mobile_briefing_page.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_home.dart";
import "package:nextbot/mobile_ui/mobile_line_icons.dart";
import "package:nextbot/mobile_ui/mobile_profile_page.dart";

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
          "todaySchedule": <Map<String, dynamic>>[
            <String, dynamic>{"id": "s1", "title": "写周报", "time": "10:00"},
            <String, dynamic>{
              "id": "d1",
              "title": "数据结构作业",
              "time": "17:00",
              "kind": "deadline",
            },
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

  testWidgets("主壳渲染 4 个 tab 图标热区,默认落在对话页", (WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: MobileHomePage()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(MobileHomePage), findsOneWidget);
    // 底栏图标是自绘的 [MobileLineIcon]（CustomPaint，按参考图 1:1 画），
    // 不是 Material Icons —— 4 个 tab 恰好 4 个绘制件，选中态只换颜色不换图标。
    expect(find.byType(MobileLineIcon), findsNWidgets(4));
    // 设置不占底栏（收进左侧抽屉左下角齿轮），底栏只有 4 格；
    // 图库也已退出一级 tab（收进桌面端常用工具），底栏不该再出现。
    expect(find.byIcon(Icons.settings_outlined), findsNothing);
    expect(find.text("图库"), findsNothing);
  });

  testWidgets("「我的」页展示功能菜单与连接状态", (WidgetTester tester) async {
    // 手机竖屏尺寸(加高到能看全菜单,避免 ListView 懒加载截断)
    tester.view.physicalSize = const Size(412, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    // 「我的」已不占 tab（抽屉左下角齿轮进入），直接挂页面断言菜单；
    // onLogout 必传：null 时隐藏退出登录项（登录门禁在根组件）。
    final MobileChatController controller = MobileChatController();
    await tester.pumpWidget(
      MaterialApp(
        home: MobileProfilePage(chatController: controller, onLogout: () {}),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    // 已裁撤项不再出现（每日简报/设备/审批为内测裁撤）
    expect(find.text("每日简报"), findsNothing);
    // 邮箱/消息中心入口已删除（2026-10-14）：消息统一后台扫描按价值主动推送
    expect(find.text("邮箱"), findsNothing);
    expect(find.text("消息中心"), findsNothing);
    expect(find.text("设备"), findsNothing);
    expect(find.text("审批"), findsNothing);
    expect(find.text("模型服务"), findsNothing);
    // 模型目录入口已删除（2026-11-04）：模型配置统一走服务接入页
    expect(find.text("模型目录"), findsNothing);
    expect(find.text("服务接入"), findsOneWidget);
    expect(find.text("帮助与反馈"), findsOneWidget);
    expect(find.text("退出登录"), findsOneWidget);
    // 连接状态行(测试环境 WS 连不上 → 未连接)
    expect(find.text("未连接"), findsOneWidget);
    // 收尾：先卸载页面再销毁控制器——WS 的重连计时器必须在此之前收掉，
    // 否则会留到测试框架的 pending-timer 校验之后（不是产品 bug，是收尾顺序）。
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await tester.pump();
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
    expect(find.text("今日日程"), findsOneWidget);
    expect(find.text("写周报"), findsOneWidget);
    // 2026-11-04 收敛：笔记/热搜/纪念日不再进晨报；DDL 并入日程并带「截止：」前缀
    expect(find.text("没看过的笔记"), findsNothing);
    expect(find.text("近期重要日子"), findsNothing);
    expect(find.text("截止：数据结构作业"), findsOneWidget);
    expect(find.text("之前交代的事"), findsOneWidget);
    // 2026-10-16 天气/穿衣迁出简报（搬往睡前提醒），页面不再渲染这两块
    expect(find.text("多云 18°C"), findsNothing);
    expect(find.text("穿衣建议"), findsNothing);
  });
}
