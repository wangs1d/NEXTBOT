/// 旅游行程海报卡的视觉快照生成器。
///
/// 运行 `flutter test --update-goldens test/travel_itinerary_card_golden.dart`
/// 生成/更新 goldens 目录下的 PNG，用于确认 2026-10 卡片重设计
/// （目的地风景海报背景 + 目的地简介 + 加大版面）的视觉效果。
///
/// 海报背景图走 `debugNetworkImageHttpClientProvider` 测试钩子注入本地
/// fixtures/maldives_poster.jpg 的字节，模拟服务端媒体库实拍图加载成功。
library;

import "dart:io"
    show
        File,
        Platform,
        HttpClient,
        HttpClientRequest,
        HttpClientResponse,
        HttpClientResponseCompressionState;
import "dart:typed_data" show Uint8List, ByteData;
import "dart:async" show Future, StreamSubscription;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/travel_plan_models.dart";

/// 加载 MiSans 正文与 MaterialIcons 图标字体（测试环境默认不加载，
/// 否则图标渲染为豆腐块）。
Future<void> _loadFonts() async {
  const List<String> files = <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
    "assets/fonts/MiSans-Bold.otf",
  ];
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in files) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();

  // MaterialIcons 在 Flutter SDK 缓存里;flutter_tester 可执行文件位于
  // <flutter>/bin/cache/artifacts/engine/<host>/flutter_tester.exe,
  // 向上回退三级即 <flutter>/bin/cache。
  try {
    final String cacheDir = File(Platform.resolvedExecutable)
        .parent
        .parent
        .parent
        .parent
        .path;
    final File iconFont = File(
        "$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf");
    await (FontLoader("MaterialIcons")
          ..addFont(iconFont
              .readAsBytes()
              .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {
    // 找不到字体时金丝雀图标会退化为豆腐块,不影响其余断言。
  }
}

// ── 网络图注入：任何 URL 都返回本地马尔代夫海报图字节 ──

class _FakeHttpClient implements HttpClient {
  _FakeHttpClient(this.bytes);

  final Uint8List bytes;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async => _FakeRequest(bytes);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError("${invocation.memberName}");
}

class _FakeRequest implements HttpClientRequest {
  _FakeRequest(this.bytes);

  final Uint8List bytes;

  @override
  Future<HttpClientResponse> close() async => _FakeResponse(bytes);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError("${invocation.memberName}");
}

class _FakeResponse implements HttpClientResponse {
  _FakeResponse(this.bytes);

  final Uint8List bytes;

  @override
  int get contentLength => bytes.length;

  @override
  int get statusCode => 200;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.decompressed;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.value(bytes)
        .listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError("${invocation.memberName}");
}

// ── 卡片数据（与服务端 travel_itinerary 卡真实结构一致）──

AgentResultData _structuredPlanData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06"),
    ],
    footer: "共 5 天 · 1 项安排",
    travelPlan: <String, dynamic>{
      "title": "马尔代夫5日游·海岛/休闲",
      "destination": "马尔代夫",
      "planId": "plan-1788076649218",
      "startDate": "2026-09-05",
      "endDate": "2026-09-09",
      "intro": "印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名",
      "days": <dynamic>[
        <String, dynamic>{
          "date": "2026-09-05",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "attraction",
              "name": "Embudu Village",
              "images": <String>["/agent/images/poster.jpg"],
            },
          ],
        },
        <String, dynamic>{
          "date": "2026-09-06",
          "items": <dynamic>[
            <String, dynamic>{"type": "hotel", "name": "Embudu Village"},
          ],
        },
      ],
    },
  );
}

AgentResultData _textFallbackData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06: 水上屋体验"),
    ],
    footer: "共 5 天 · 1 项安排",
  );
}

Widget _harness(AppThemeVariant variant, AgentResultData data) {
  // 模拟聊天流：消息气泡底色（surfaceContainerLow 系）上放卡片
  final ColorScheme cs = AppTheme.of(variant).colorScheme;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.of(variant),
    home: Scaffold(
      backgroundColor: cs.surface,
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Container(
            padding: const EdgeInsets.fromLTRB(10, 8, 12, 10),
            decoration: BoxDecoration(
              color: cs.surfaceContainerLow.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: cs.outline.withValues(alpha: 0.32)),
            ),
            child: AgentResultCard(data: data),
          ),
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // 封面活取关断：金丝雀快照只渲染卡内数据，不发真实网络请求
  TravelLiveCover.enabled = false;

  setUpAll(_loadFonts);

  Future<void> pumpAndCapture(
    WidgetTester tester,
    AppThemeVariant variant,
    AgentResultData data,
    String golden,
  ) async {
    final Uint8List posterBytes =
        File("test/fixtures/maldives_poster.jpg").readAsBytesSync();
    debugNetworkImageHttpClientProvider = () => _FakeHttpClient(posterBytes);
    tester.view.physicalSize = const Size(1100, 1400);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_harness(variant, data));
    // 海报图的真实解码要靠 runAsync 推进（flutter_test 的 fake clock
    // 不推进引擎侧的图片解码任务），完成后再 pump 两帧让图层落地
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // 图片已解码进 ImageCache，就地复位 provider 以通过
    // flutter_test 每个用例结束时的 painting debug 变量 invariant 校验
    //（校验发生在 tearDown 之前，只能在用例体内复位）。
    debugNetworkImageHttpClientProvider = null;
    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(AgentResultCard),
        matchesGoldenFile("goldens/$golden"),
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets("行程海报卡 深色主题（结构化数据：海报图+简介）", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.dark, _structuredPlanData(), "travel_card_dark.png");
  });

  testWidgets("行程海报卡 暖色主题（结构化数据）", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.warm, _structuredPlanData(), "travel_card_warm.png");
  });

  testWidgets("行程海报卡 历史消息兜底（无 travelPlan：渐变底，无简介）", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, AppThemeVariant.dark, _textFallbackData(), "travel_card_fallback.png");
  });
}
