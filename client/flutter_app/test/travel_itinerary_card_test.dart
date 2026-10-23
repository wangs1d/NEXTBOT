import "dart:async" show StreamSubscription;
import "dart:convert";
import "dart:io" show HttpClient, HttpClientRequest, HttpClientResponse, HttpHeaders;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/travel_plan_models.dart";

/// 1x1 透明 PNG（候选链回退测试的「真实可解码图」）
const String _kPng1x1Base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// 极简假 HTTP 客户端：按 URL 决定状态码，200 时回 1x1 PNG 字节。
/// 只实现 NetworkImage 走到的路径，其余成员 noSuchMethod 兜底。
class _FakeHttpClient implements HttpClient {
  _FakeHttpClient(this._statusFor);

  final int Function(Uri url) _statusFor;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async => _FakeRequest(_statusFor(url));

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnsupportedError("unexpected: ${invocation.memberName}");
}

class _FakeRequest implements HttpClientRequest {
  _FakeRequest(this.statusCode);

  final int statusCode;

  @override
  Future<HttpClientResponse> close() async => _FakeResponse(statusCode);

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnsupportedError("unexpected: ${invocation.memberName}");
}

class _FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  _FakeResponse(this._statusCode);

  final int _statusCode;

  late final Stream<List<int>> _delegate = Stream<List<int>>.value(
    _statusCode < 400 ? base64Decode(_kPng1x1Base64) : <int>[],
  );

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> element)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) =>
      _delegate.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  int get statusCode => _statusCode;

  @override
  HttpHeaders get headers => _FakeHeaders();

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnsupportedError("unexpected: ${invocation.memberName}");
}

class _FakeHeaders implements HttpHeaders {
  @override
  String? value(String name) => name == HttpHeaders.contentTypeHeader ? "image/png" : null;

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnsupportedError("unexpected: ${invocation.memberName}");
}

AgentResultData _structuredPlanData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06"),
      const AgentResultItem(type: "bullet", text: "Day 3 · 2026-09-07"),
    ],
    footer: "共 5 天 · 1 项安排",
    travelPlan: <String, dynamic>{
      "title": "马尔代夫5日游·海岛/休闲",
      "destination": "马尔代夫",
      "planId": "plan-1788076649218",
      "startDate": "2026-09-05",
      "endDate": "2026-09-09",
      "intro": "印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名",
      "packing": <String>["防晒霜 SPF50+", "泳装与浮潜装备", "英标转换插头"],
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

/// 在结构化行程上注入目的地代表性封面（服务端维基百科条目主图优先下发）。
AgentResultData _coverPlanData() {
  final Map<String, dynamic> tp = Map<String, dynamic>.from(
    _structuredPlanData().travelPlan!,
  )..["coverImage"] = "/agent/images/destination-cover.jpg";
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: _structuredPlanData().items,
    footer: "共 5 天 · 1 项安排",
    travelPlan: tp,
  );
}

AgentResultData _textFallbackData() {  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06: 水上屋体验"),
    ],
    footer: "共 5 天 · 1 项安排",
  );
}

/// 结构化数据异常：days 非空但全为空天（条目丢失），应回退文本解析口径。
AgentResultData _degradedStructuredData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: const <AgentResultItem>[],
    footer: "共 5 天 · 1 项安排",
    travelPlan: <String, dynamic>{
      "title": "马尔代夫5日游·海岛/休闲",
      "destination": "马尔代夫",
      "days": <dynamic>[
        <String, dynamic>{"date": "2026-09-05", "items": <dynamic>[]},
        <String, dynamic>{"date": "2026-09-06", "items": <dynamic>[]},
      ],
    },
  );
}

void main() {
  setUp(() {
    // 封面活取默认关断：卡片测试只验证卡内数据的确定性渲染；
    // 活取行为由专门的桩注入测试覆盖（见「活取封面到达后换上新图」）。
    TravelLiveCover.resetForTesting();
    TravelLiveCover.enabled = false;
  });

  Future<void> pumpCard(WidgetTester tester, AgentResultData data) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: AgentResultCard(data: data),
          ),
        ),
      ),
    );
    // 图片加载/错误回调走一帧，避免 pending timer 干扰
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets("海报卡：徽章/天数/日期区间/简介/按钮渲染（记得带已撤下）", (WidgetTester tester) async {
    await pumpCard(tester, _structuredPlanData());

    expect(find.text("马尔代夫"), findsOneWidget);
    expect(find.textContaining("天行程"), findsOneWidget);
    expect(find.text("09-05 ~ 09-09"), findsOneWidget);
    expect(find.text("印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名"), findsOneWidget);
    // 2026-10-15 用户定稿：「记得带」叮嘱行撤下，打包建议只在行程规划面板里看
    expect(find.text("记得带"), findsNothing);
    expect(find.text("防晒霜 SPF50+"), findsNothing);
    expect(find.text("打开行程规划"), findsOneWidget);
    expect(find.text("共 5 天 · 1 项安排"), findsOneWidget);

    // 2026-09-25 用户定稿「卡面极简」：逐日地标串不再上卡面（旧断言要求 Day
    // 摘要在卡面，与定稿相反），卡面只保留 海报 + 主入口 + 脚注
    expect(find.textContaining("Day 1"), findsNothing);
  });

  testWidgets("海报背景优先目的地代表性封面（目的地形象照），而非首个有图景点", (WidgetTester tester) async {
    await pumpCard(tester, _coverPlanData());

    // 海报 Image 是卡内第一个 Image；其 URL 必须是封面，绝不是任何条目实拍
    final Iterable<Image> images = tester.widgetList<Image>(find.byType(Image));
    expect(images, isNotEmpty);
    final NetworkImage poster = images.first.image as NetworkImage;
    expect(poster.url, contains("destination-cover.jpg"));
    expect(poster.url, isNot(contains("/poster.jpg")));
  });

  testWidgets("活取封面到达后海报换上新图（历史卡片不改存量数据自动换新）", (WidgetTester tester) async {
    TravelLiveCover.enabled = true;
    TravelLiveCover.fetcher = (String destination) async =>
        destination == "马尔代夫" ? "/agent/images/live-cover.jpg" : null;
    await pumpCard(tester, _coverPlanData());

    // 活取异步返回：走帧等 setState 落地，海报第一候选应为活取封面
    bool switchedToLive = false;
    for (int i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      final Iterable<Image> images = tester.widgetList<Image>(find.byType(Image));
      if (images.isNotEmpty &&
          (images.first.image as NetworkImage).url.contains("live-cover.jpg")) {
        switchedToLive = true;
        break;
      }
    }
    expect(switchedToLive, isTrue, reason: "服务端封面库的新封面应自动上卡");
  });

  testWidgets("无封面时退回首个有图景点实拍（兼容旧数据）", (WidgetTester tester) async {
    await pumpCard(tester, _structuredPlanData());

    final Image poster = tester.widget<Image>(find.byType(Image).first);
    expect((poster.image as NetworkImage).url, contains("/poster.jpg"));
  });

  testWidgets("无结构化 travelPlan 的历史消息优雅降级：简介/叮嘱隐藏，按钮与海报骨架仍在", (WidgetTester tester) async {
    await pumpCard(tester, _textFallbackData());

    expect(find.text("打开行程规划"), findsOneWidget);
    expect(find.text("马尔代夫"), findsOneWidget);
    expect(find.text("记得带"), findsNothing);
    expect(find.text("印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名"), findsNothing);
  });

  testWidgets("Wikimedia 远程封面重写到本机代理路由（客户端网络不可直连）", (WidgetTester tester) async {
    final Map<String, dynamic> tp = Map<String, dynamic>.from(
      _structuredPlanData().travelPlan!,
    )..["coverImage"] = "https://upload.wikimedia.org/wikipedia/commons/thumb/x.jpg";
    await pumpCard(
      tester,
      AgentResultData(
        cardType: "travel_itinerary",
        title: "大理5日游·海景",
        items: _structuredPlanData().items,
        travelPlan: tp,
      ),
    );

    final Iterable<Image> images = tester.widgetList<Image>(find.byType(Image));
    expect(images, isNotEmpty);
    final NetworkImage poster = images.first.image as NetworkImage;
    // 测试环境默认 httpBase = http://127.0.0.1:3000
    expect(poster.url, startsWith("http://127.0.0.1:3000/travel/media/remote?u="));
    expect(poster.url, contains("upload.wikimedia.org"));
  });

  testWidgets("封面加载失败自动回退到下一张条目实拍，不再永远渐变", (WidgetTester tester) async {
    // 假 HTTP：封面 404、条目实拍 200（1x1 PNG）——验证候选链推进到下一张上屏
    debugNetworkImageHttpClientProvider =
        () => _FakeHttpClient((Uri url) => url.toString().contains("/poster.jpg") ? 200 : 404);
    await pumpCard(tester, _coverPlanData());

    // 候选链：封面失败 → 推进 → 条目实拍上屏（给足推进帧）
    bool advancedToEntry = false;
    for (int i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      final Iterable<Image> images = tester.widgetList<Image>(find.byType(Image));
      if (images.isNotEmpty) {
        final String url = (images.first.image as NetworkImage).url;
        if (url.contains("/poster.jpg")) {
          advancedToEntry = true;
          break;
        }
      }
    }
    expect(advancedToEntry, isTrue, reason: "封面失败后应由条目实拍补位海报");
    // painting 调试变量必须在测试体结束前复位（不变量检查先于 tearDown 跑）
    debugNetworkImageHttpClientProvider = null;
  });

  testWidgets("结构化 days 全空回退文本解析：「全程」空骨架天不计入天数徽章", (WidgetTester tester) async {
    await pumpCard(tester, _degradedStructuredData());

    // days 全空 → 文本也无行程行 → 无可打开的行程，且不显示「1 天行程」
    //（修复前：raw days 非空即按结构化口径取 days.length，把 fromCard
    // 补的「全程」空骨架天计入，徽章误报 1 天）。
    expect(find.textContaining("天行程"), findsNothing);
    expect(find.text("打开行程规划"), findsNothing);
    // 目的地徽章与海报兜底骨架仍在，布局不破损
    expect(find.text("马尔代夫"), findsOneWidget);
  });
}
