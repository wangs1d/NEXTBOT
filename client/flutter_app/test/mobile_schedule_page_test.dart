// 手机端行程表 widget 测试：方案 C 周网格日期条 + 一天一页、周标签回今天、
// ‹›翻周、「下一件」徽标、完成/取消口径、空日。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:nextbot/core/services/schedule_api_client.dart";
import "package:nextbot/mobile_ui/mobile_schedule_page.dart";

/// 假 http client：/schedule/tasks 返回样例任务。
class _MockScheduleHttp extends http.BaseClient {
  _MockScheduleHttp(this.tasks);

  final List<Map<String, dynamic>> tasks;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path.endsWith("/schedule/tasks")) {
      return http.StreamedResponse(
        Stream<List<int>>.value(utf8.encode(jsonEncode(<String, dynamic>{
          "ok": true,
          "tasks": tasks,
        }))),
        200,
        headers: const <String, String>{
          "content-type": "application/json; charset=utf-8",
        },
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

String _isoAt(DateTime local) => local.toUtc().toIso8601String();

Map<String, dynamic> _task(
  String id,
  String title,
  DateTime at, {
  String status = "active",
}) {
  return <String, dynamic>{
    "taskId": id,
    "shortTitle": title,
    "runAt": _isoAt(at),
    "nextRunAt": _isoAt(at),
    "lastRunAt": _isoAt(at),
    "status": status,
  };
}

Widget _wrap(
  List<Map<String, dynamic>> tasks, {
  VoidCallback? onGoToChat,
  GlobalKey<MobileSchedulePageState>? key,
}) {
  return MaterialApp(
    home: MobileSchedulePage(
      key: key,
      scheduleApi: ScheduleApiClient(
        baseUrl: "http://localhost:3000",
        client: _MockScheduleHttp(tasks),
      ),
      sessionId: "test-actor",
      onGoToChat: onGoToChat,
    ),
  );
}

const List<String> _wdNames = <String>[
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

void main() {
  testWidgets("默认落在今天:周网格+大日期日头,今日条目可见、明天不可见", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 14, 30);
    final DateTime tomorrowAt = todayAt.add(const Duration(days: 1));
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "项目评审会", todayAt),
      _task("t2", "晨会", tomorrowAt),
    ]));
    await tester.pumpAndSettle();

    expect(find.text("项目评审会"), findsOneWidget);
    expect(find.text("14:30"), findsOneWidget);
    expect(find.text("晨会"), findsNothing);
    // v2:旧版大标题与「查看之后的安排」按钮已删除；「今天/明天」名称行也已删除
    expect(find.text("行程"), findsNothing);
    expect(find.text("查看之后的安排"), findsNothing);
    expect(find.text("今天"), findsNothing);
    // 方案 C:今天的格子(日期数字)、「今」格子字 + 日头徽标、周标签、大日期日头
    expect(find.text(now.day.toString()), findsOneWidget);
    expect(find.text("今"), findsNWidgets(2));
    expect(find.textContaining("${now.month}月${now.day}日 - "), findsOneWidget);
    expect(find.text("${now.month}月${now.day}日"), findsOneWidget);
    expect(find.text(_wdNames[now.weekday - 1]), findsOneWidget);
    expect(find.text("1 件安排"), findsOneWidget);
  });

  testWidgets("点日期格子跳转,点周标签回今天", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 10, 0);
    final DateTime tomorrow =
        DateTime(now.year, now.month, now.day).add(const Duration(days: 1));
    final DateTime tomorrowAt = tomorrow.add(const Duration(hours: 9));
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "项目评审会", todayAt),
      _task("t2", "晨会", tomorrowAt),
    ]));
    await tester.pumpAndSettle();

    await tester.tap(find.text(tomorrow.day.toString()));
    await tester.pumpAndSettle();
    expect(find.text("晨会"), findsOneWidget);
    expect(find.text("项目评审会"), findsNothing);

    // 点周标签一键回今天
    await tester.tap(find.textContaining("${now.month}月${now.day}日 - "));
    await tester.pumpAndSettle();
    expect(find.text("项目评审会"), findsOneWidget);
    expect(find.text("晨会"), findsNothing);
  });

  testWidgets("空日:大日期日头 + 空卡对话引导", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 10, 0);
    final DateTime d3 =
        DateTime(now.year, now.month, now.day).add(const Duration(days: 3));
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "项目评审会", todayAt),
    ], onGoToChat: () {}));
    await tester.pumpAndSettle();

    await tester.tap(find.text(d3.day.toString()));
    await tester.pumpAndSettle();
    expect(find.text("${d3.month}月${d3.day}日"), findsOneWidget);
    // 件数胶囊 + 空卡标题各一处
    expect(find.text("没有安排"), findsNWidgets(2));
    expect(find.text("在对话里说一声，我帮你记下时间 →"), findsOneWidget);
  });

  testWidgets("‹›翻周:周标签同步,选中日页面不动", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 10, 0);
    final DateTime d7 =
        DateTime(now.year, now.month, now.day).add(const Duration(days: 7));
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "项目评审会", todayAt),
    ]));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.chevron_right));
    await tester.pumpAndSettle();
    expect(find.textContaining("${d7.month}月${d7.day}日 - "), findsOneWidget);
    // 周翻页不影响正在看的今天页面
    expect(find.text("项目评审会"), findsOneWidget);

    await tester.tap(find.byIcon(Icons.chevron_left));
    await tester.pumpAndSettle();
    expect(find.textContaining("${now.month}月${now.day}日 - "), findsOneWidget);
  });

  testWidgets("「下一件」徽标:只标今天最近一条未完成,带倒计时", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime t1 = now.add(const Duration(hours: 2));
    final DateTime t2 = now.add(const Duration(hours: 4));
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "项目评审会", t1),
      _task("t2", "健身", t2),
    ]));
    await tester.pumpAndSettle();

    expect(find.text("下一件"), findsOneWidget);
    expect(find.textContaining("小时"), findsWidgets);
    expect(find.text("2 件安排"), findsOneWidget);
  }, skip: DateTime.now().hour >= 22);

  testWidgets("已完成条目灰化带对勾,取消的整条滤掉", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 8, 0);
    await tester.pumpWidget(_wrap(<Map<String, dynamic>>[
      _task("t1", "已完成的事", todayAt, status: "completed"),
      _task("t2", "被取消的事", todayAt, status: "cancelled"),
    ]));
    await tester.pumpAndSettle();

    expect(find.text("已完成的事"), findsOneWidget);
    expect(find.byIcon(Icons.check), findsOneWidget);
    expect(find.text("被取消的事"), findsNothing);
    expect(find.text("08:00"), findsOneWidget);
    expect(find.text("1 件安排"), findsOneWidget);
  });

  testWidgets("refresh() 重拉:保活页在数据源变化后经外部触发拿到新条目", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 10, 0);
    // 可变列表：mock 每次请求都读同一引用——refresh 后服务端"多了一条"即可模拟
    final List<Map<String, dynamic>> tasks = <Map<String, dynamic>>[
      _task("t1", "项目评审会", todayAt),
    ];
    final GlobalKey<MobileSchedulePageState> key = GlobalKey<MobileSchedulePageState>();
    await tester.pumpWidget(_wrap(tasks, key: key));
    await tester.pumpAndSettle();
    expect(find.text("项目评审会"), findsOneWidget);
    expect(find.text("牙医复诊"), findsNothing);

    // 模拟对话里新建了提醒 → 服务端数据变了
    tasks.add(_task("t2", "牙医复诊", todayAt.add(const Duration(hours: 3))));
    // 主壳切 tab 时走的就是这条路径：保活页不重建，直接重拉
    key.currentState!.refresh();
    await tester.pumpAndSettle();
    expect(find.text("牙医复诊"), findsOneWidget);
    expect(find.text("2 件安排"), findsOneWidget);
  });
}
