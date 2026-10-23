// ModelProviderCard 组件测试：目录式选模型的核心交互闭环。
// 网络被 flutter_test 禁用 → ModelProviderCatalog.load() 自动回落 baked 目录（保命路径即测试路径）。
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/features/model_config/model_provider_card.dart";
import "package:nextbot/features/model_config/model_provider_catalog.dart";

Widget _host({
  String? initialBaseUrl,
  String? initialModel,
  String? initialApiKey,
  required Future<void> Function(ModelConfigDraft draft) onSave,
}) {
  return MaterialApp(
    theme: ThemeData(brightness: Brightness.light, useMaterial3: true),
    home: Scaffold(
      body: SingleChildScrollView(
        child: ModelProviderCard(
          initialBaseUrl: initialBaseUrl,
          initialModel: initialModel,
          initialApiKey: initialApiKey,
          onSave: onSave,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("目录商回显：按 base 选中 DeepSeek，提示自动配置的接口地址与默认模型", (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      initialBaseUrl: "https://api.deepseek.com",
      onSave: (_) async {},
    ));
    await tester.pump();

    expect(find.text("接口地址已自动配置：https://api.deepseek.com"), findsOneWidget);
    // 默认模型显示在下拉里
    expect(find.text("deepseek-flash · V4.1-Flash（推荐）"), findsOneWidget);
  });

  testWidgets("填写 key 后保存：draft 带目录商 id/baseUrl/模型", (WidgetTester tester) async {
    ModelConfigDraft? captured;
    await tester.pumpWidget(_host(
      initialBaseUrl: "https://api.deepseek.com",
      onSave: (ModelConfigDraft d) async => captured = d,
    ));
    await tester.pump();

    await tester.enterText(find.byType(TextField).first, "sk-test-1234567890abcdef");
    await tester.pump();
    await tester.tap(find.text("保存并生效"));
    await tester.pumpAndSettle();

    expect(captured, isNotNull);
    expect(captured!.providerId, "deepseek");
    expect(captured!.baseUrl, "https://api.deepseek.com");
    expect(captured!.model, "deepseek-flash");
    expect(captured!.apiKey, "sk-test-1234567890abcdef");
  });

  testWidgets("切换服务商：接口地址与模型下拉跟随目录", (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      initialBaseUrl: "https://api.deepseek.com",
      onSave: (_) async {},
    ));
    await tester.pump();

    await tester.tap(find.text("智谱 GLM"));
    await tester.pumpAndSettle();

    expect(find.text("接口地址已自动配置：https://open.bigmodel.cn/api/paas/v4"), findsOneWidget);
    expect(find.text("glm-5.3 · 旗舰（推荐）"), findsOneWidget);
  });

  testWidgets("自定义接入：未匹配目录的 base 落自定义并回显 base/model", (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      initialBaseUrl: "https://my.gateway.example/v1",
      initialModel: "my-model",
      onSave: (_) async {},
    ));
    await tester.pump();

    expect(find.widgetWithText(TextField, "API Base URL"), findsOneWidget);
    expect(find.text("my-model"), findsOneWidget); // 模型名输入框回显
  });

  testWidgets("全新用户（无任何配置）：默认选第一个目录商而非自定义", (WidgetTester tester) async {
    await tester.pumpWidget(_host(onSave: (_) async {}));
    await tester.pump();

    expect(find.text("接口地址已自动配置：https://api.deepseek.com"), findsOneWidget);
    expect(find.text("deepseek-flash · V4.1-Flash（推荐）"), findsOneWidget);
    expect(find.widgetWithText(TextField, "API Base URL"), findsNothing); // 不落自定义
  });

  testWidgets("无 key 点保存：不触发保存并提示", (WidgetTester tester) async {
    bool saved = false;
    await tester.pumpWidget(_host(
      initialBaseUrl: "https://api.deepseek.com",
      onSave: (ModelConfigDraft d) async => saved = true,
    ));
    await tester.pump();

    await tester.tap(find.text("保存并生效"));
    await tester.pumpAndSettle();

    expect(saved, isFalse);
    expect(find.text("请先填写 API Key"), findsOneWidget);
  });
}
