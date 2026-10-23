import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/db/isar_local_history_store.dart";
import "package:nextbot/features/schedule/schedule_page.dart";

Widget _host(int Function() chatCallCounter) {
  return MaterialApp(
    home: Scaffold(
      body: SchedulePage(
        store: IsarLocalHistoryStore(userPin: "test-pin"),
        onCreateViaChat: chatCallCounter,
      ),
    ),
  );
}

void main() {
  testWidgets("创建日程：点击按钮触发跳转聊天回调，不弹创建表单", (WidgetTester tester) async {
    int chatCalls = 0;
    await tester.pumpWidget(_host(() => chatCalls++));
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, "创建日程"));
    await tester.pump();

    expect(chatCalls, 1);
    // 不再弹时间选择器或「新建日程」表单对话框
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(TimePickerDialog), findsNothing);
  });

  testWidgets("创建日程：事项管理页签下点击按钮同样跳转聊天", (WidgetTester tester) async {
    int chatCalls = 0;
    await tester.pumpWidget(_host(() => chatCalls++));
    await tester.pump();

    await tester.tap(find.text("事项管理"));
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, "创建日程"));
    await tester.pump();

    expect(chatCalls, 1);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(TimePickerDialog), findsNothing);
  });
}
