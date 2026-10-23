// 反馈弹窗 widget 测试：真实装配 FeedbackDialog，走真实提交流程。
// FeedbackApi 用子类打桩（不触网），验证正文派生标题、tab 切换与关闭行为。
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/feedback_api.dart";
import "package:nextbot/features/help/feedback_dialog.dart";

class _FakeApi extends FeedbackApi {
  _FakeApi() : super(baseUrl: "http://127.0.0.1:1");

  int submitCalls = 0;
  String? submittedTitle;
  String? submittedContent;
  List<FeedbackRecord> records = const <FeedbackRecord>[];

  @override
  Future<FeedbackResult<FeedbackRecord>> submit({
    required String type,
    required String title,
    required String description,
    String? contact,
    Map<String, Object> diagnostics = const <String, Object>{},
  }) async {
    submitCalls += 1;
    submittedTitle = title;
    submittedContent = description;
    return FeedbackResult.success(FeedbackRecord(
      id: "f1",
      type: type,
      title: title,
      description: description,
      status: "open",
    ));
  }

  @override
  Future<FeedbackResult<List<FeedbackRecord>>> listMine({int limit = 50}) async {
    return FeedbackResult.success(records);
  }
}

Future<void> _openDialog(WidgetTester tester, _FakeApi api) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (BuildContext ctx) => Center(
            child: FilledButton(
              onPressed: () => FeedbackDialog.show(ctx, api: api),
              child: const Text("open"),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text("open"));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets("提交：正文首行自动作为标题，成功后弹窗关闭", (WidgetTester tester) async {
    final _FakeApi api = _FakeApi();
    await _openDialog(tester, api);

    expect(find.text("反馈"), findsOneWidget);
    // 默认选中「吐槽」类型 chip
    expect(find.text("吐槽"), findsOneWidget);
    expect(find.text("功能建议"), findsOneWidget);

    await tester.enterText(
      find.byType(TextField).first,
      "设置页保存按钮没反应\n点了很多次都不行",
    );
    await tester.tap(find.text("提交"));
    await tester.pumpAndSettle();

    expect(api.submitCalls, 1);
    expect(api.submittedTitle, "设置页保存按钮没反应");
    expect(api.submittedContent, "设置页保存按钮没反应\n点了很多次都不行");
    // 提交成功后弹窗关闭
    expect(find.text("联系方式（选填）"), findsNothing);
  });

  testWidgets("空正文拦截：不发起提交，弹窗保持打开", (WidgetTester tester) async {
    final _FakeApi api = _FakeApi();
    await _openDialog(tester, api);

    await tester.tap(find.text("提交"));
    await tester.pump();
    expect(api.submitCalls, 0);
    expect(find.text("联系方式（选填）"), findsOneWidget);
  });

  testWidgets("我的反馈：切 tab 可见记录、状态与管理员回复", (WidgetTester tester) async {
    final _FakeApi api = _FakeApi()
      ..records = const <FeedbackRecord>[
        FeedbackRecord(
          id: "r1",
          type: "bug",
          title: "启动白屏",
          description: "双击图标后白屏十秒",
          status: "resolved",
          replyNote: "0.2.2 已修复",
        ),
      ];
    await _openDialog(tester, api);

    await tester.tap(find.text("我的反馈"));
    await tester.pumpAndSettle();

    expect(find.text("启动白屏"), findsOneWidget);
    expect(find.text("已解决"), findsOneWidget);
    // 展开记录看正文与回复
    await tester.tap(find.text("启动白屏"));
    await tester.pumpAndSettle();
    expect(find.text("双击图标后白屏十秒"), findsOneWidget);
    expect(find.text("管理员回复：0.2.2 已修复"), findsOneWidget);
  });
}
