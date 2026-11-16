import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:http/http.dart" as http;
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/media_disk_cache.dart";
import "package:nextbot/features/chat/travel_plan_models.dart";

import "helpers/temp_path_provider.dart";

/// 1x1 透明 PNG（候选链回退测试的「真实可解码图」）
const String _kPng1x1Base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  setUp(() async {
    // 磁盘缓存真实落盘需要 path_provider：测试环境用临时目录实现，
    // 否则 MediaDiskCache 直接降级"无缓存"，debugFetch 根本不会被调用。
    PathProviderPlatform.instance = TempPathProviderPlatform();
    // 磁盘缓存跨用例共享目录：先清掉，否则上一条用例成功落盘的图会让
    // 「封面 404 → 回退」用例直接命中缓存、永远走不到失败分支。
    await MediaDiskCache.instance.clearForTest();
    // 封面活取默认关断：卡片测试只验证卡内数据的确定性渲染；
    // 活取行为由专门的桩注入测试覆盖（见「活取封面到达后换上新图」）。
    TravelLiveCover.resetForTesting();
    TravelLiveCover.enabled = false;
    // 契约：海报封面走 [CachedMediaImage]（磁盘缓存层），字节由 MediaDiskCache
    // 统一取（NbHttp 带凭证头）。测试里注入确定性字节源，否则会真等一次网络
    // 超时——`debugNetworkImageHttpClientProvider` 只影响 NetworkImage，管不到
    // 这条链路。默认全部 200（1x1 PNG），需要失败时按 URL 覆写。
    MediaDiskCache.debugFetch = (Uri uri, Map<String, String>? headers) async =>
        http.Response.bytes(base64Decode(_kPng1x1Base64), 200);
  });

  tearDown(() {
    MediaDiskCache.debugFetch = null;
  });

  /// 卡片里所有走磁盘缓存的图片地址（海报/图集同源，按树序）。
  List<String> mediaUrls(WidgetTester tester) => tester
      .widgetList<CachedMediaImage>(find.byType(CachedMediaImage))
      .map((CachedMediaImage w) => w.url)
      .toList(growable: false);

  /// 抽一帧让磁盘缓存落盘 + CachedMediaImage 重建（异步一跳）。
  Future<void> settleMedia(WidgetTester tester) async {
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

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

    // 契约：海报首候选 = 封面；绝不是任何条目实拍
    await settleMedia(tester);
    final List<String> urls = mediaUrls(tester);
    expect(urls, isNotEmpty);
    expect(urls.first, contains("destination-cover.jpg"));
    expect(urls.first, isNot(contains("/poster.jpg")));
  });

  testWidgets("活取封面到达后海报换上新图（历史卡片不改存量数据自动换新）", (WidgetTester tester) async {
    TravelLiveCover.enabled = true;
    TravelLiveCover.fetcher = (String destination) async =>
        destination == "马尔代夫" ? "/agent/images/live-cover.jpg" : null;
    await pumpCard(tester, _coverPlanData());

    // 活取是异步网络调用：走帧等 setState 落地，海报第一候选应为活取封面
    bool switchedToLive = false;
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      final List<String> urls = mediaUrls(tester);
      if (urls.isNotEmpty && urls.first.contains("live-cover.jpg")) {
        switchedToLive = true;
        break;
      }
    }
    expect(switchedToLive, isTrue, reason: "服务端封面库的新封面应自动上卡");
  });

  testWidgets("无封面时退回首个有图景点实拍（兼容旧数据）", (WidgetTester tester) async {
    await pumpCard(tester, _structuredPlanData());

    await settleMedia(tester);
    final List<String> urls = mediaUrls(tester);
    expect(urls, isNotEmpty);
    expect(urls.first, contains("/poster.jpg"));
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

    await settleMedia(tester);
    final List<String> urls = mediaUrls(tester);
    expect(urls, isNotEmpty);
    // 测试环境默认 httpBase = http://127.0.0.1:3000
    expect(urls.first, startsWith("http://127.0.0.1:3000/travel/media/remote?u="));
    expect(urls.first, contains("upload.wikimedia.org"), reason: "远程图必须改走本机代理");
  });

  // 契约测试：候选推进规则（不再是「假 HTTP + 数帧」的时序测试）。
  // 原来那条 widget 级用例在 fake-async 下推不动磁盘缓存链路，实际测的是时序；
  // 真正的规则是 nextPosterCandidate 的三个不变量，直接打它更稳也更准。
  group("海报候选链推进规则", () {
    test("首张未失败 → 用首张（封面优先）", () {
      expect(
        nextPosterCandidate(<String>["cover.jpg", "/poster.jpg"], <String>{}),
        "cover.jpg",
      );
    });

    test("封面失败 → 推进到下一张条目实拍", () {
      expect(
        nextPosterCandidate(
          <String>["cover.jpg", "/poster.jpg"],
          <String>{"cover.jpg"},
        ),
        "/poster.jpg",
      );
    });

    test("同一张失败只记一次：重复回调不会跳过未尝试的候选", () {
      final Set<String> failed = <String>{"cover.jpg"};
      expect(nextPosterCandidate(<String>["cover.jpg", "/poster.jpg"], failed),
          "/poster.jpg");
      // 同一个 errorBuilder 再回调一次（重建时的重复上报）不应产生副作用
      failed.add("cover.jpg");
      expect(nextPosterCandidate(<String>["cover.jpg", "/poster.jpg"], failed),
          "/poster.jpg");
    });

    test("全部失败 → null（渲染渐变骨架，不再无休止重试）", () {
      expect(
        nextPosterCandidate(
          <String>["cover.jpg", "/poster.jpg"],
          <String>{"cover.jpg", "/poster.jpg"},
        ),
        isNull,
      );
    });
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
