// 真实渲染取证（默认跳过，PAI_REAL_RENDER_EVIDENCE=1 时跑）：
// 用 data/travel-plans 里用户真实行程（存量 wikimedia 远程 URL）渲染行程卡，
// 走真实网络（本机 server /travel/media/remote 代理链），出整卡 PNG 供人工查验。
// 运行：PAI_REAL_RENDER_EVIDENCE=1 flutter test test/travel_card_real_render_evidence_test.dart
import "dart:async" show Completer;
import "dart:convert";
import "dart:io";
import "dart:typed_data" show ByteData;
import "dart:ui" show ImageByteFormat;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart";
import "package:flutter/painting.dart" show debugNetworkImageHttpClientProvider;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/travel_plan_models.dart";

/// 真实 HttpClient：必须在 main() 里、flutter_test 安装全局 400 mock
/// （HttpOverrides.global = _MockHttpOverrides）之前创建——之后 new 的
/// HttpClient() 一律被劫持成恒 400，这就是 provider「看起来没生效」的原因。
final HttpClient _realHttpClient = HttpClient()..autoUncompress = false;

void main() {
  // 顶层变量是懒初始化：必须在这里先摸一次，确保真实 client 在测试绑定
  // 安装 HttpOverrides（恒 400 mock）之前完成构造
  _realHttpClient.autoUncompress = false;
  testWidgets("行程卡真实渲染取证：存量远程封面经本机代理真实出图", (WidgetTester tester) async {
    if (Platform.environment["PAI_REAL_RENDER_EVIDENCE"] != "1") {
      markTestSkipped("真实渲染取证：仅在 PAI_REAL_RENDER_EVIDENCE=1 时运行（依赖本机 server 与真实网络）");
      return;
    }
    final File planFile =
        File("E:/ws-project/NextBot/server/data/travel-plans/plan-1790266331245.json");
    if (!planFile.existsSync()) {
      markTestSkipped("找不到真实行程数据 plan-1790266331245.json");
      return;
    }
    final Map<String, dynamic> plan =
        jsonDecode(planFile.readAsStringSync()) as Map<String, dynamic>;

    // 组装与聊天消息同构的行程卡数据（days 条目转 Day 摘要 bullets）
    final List<dynamic> days = (plan["days"] as List<dynamic>? ?? <dynamic>[]);
    final List<AgentResultItem> items = <AgentResultItem>[
      for (int i = 0; i < days.length; i++)
        AgentResultItem(
          type: "num",
          text: "Day ${i + 1} · ${days[i]["date"]}: ${(days[i]["items"] as List<dynamic>).isNotEmpty ? ((days[i]["items"] as List<dynamic>).first["name"] ?? "") : ""} 等",
        ),
    ];
    final AgentResultData data = AgentResultData(
      cardType: "travel_itinerary",
      title: plan["title"]?.toString() ?? "",
      items: items,
      footer: "共 ${days.length} 天 · 28 项安排",
      travelPlan: plan,
    );

    // 真实 HttpClient：NetworkImage 走真实网络（本机代理链）
    debugNetworkImageHttpClientProvider = () => _realHttpClient;
    addTearDown(() => debugNetworkImageHttpClientProvider = null);

    final GlobalKey boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(
          key: boundaryKey,
          child: Scaffold(
            backgroundColor: const Color(0xFF101418),
            body: Center(
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: AgentResultCard(data: data),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    // 真实网络等待：封面（存量远程 URL → 本机代理）+ 条目图全部落定
    final TravelPlanData tpData = TravelPlanData.from(data);
    // ignore: avoid_print
    print("poster candidate: ${tpData.coverImage}");
    try {
      await tester.runAsync(() async {
        final ImageStream stream = NetworkImage(tpData.coverImage)
            .resolve(ImageConfiguration.empty);
        final Completer<String> done = Completer<String>();
        late final ImageStreamListener l;
        l = ImageStreamListener((_, __) => done.complete("OK"),
            onError: (Object e, StackTrace? _) => done.complete("ERR $e"));
        stream.addListener(l);
        final String r = await done.future.timeout(const Duration(seconds: 15),
            onTimeout: () => "TIMEOUT");
        stream.removeListener(l);
        // ignore: avoid_print
        print("direct precache result: $r");
      });
    } catch (e) {
      // ignore: avoid_print
      print("precache probe threw: $e");
    }
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 8)));
    await tester.pump();
    // painting 调试变量必须在测试体结束前复位（不变量检查先于 tearDown 跑）
    debugNetworkImageHttpClientProvider = null;

    final RenderRepaintBoundary boundary =
        boundaryKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final dynamic rawImage =
        await tester.runAsync(() => boundary.toImage(pixelRatio: 2.0));
    final ByteData? bytes = await tester
        .runAsync<ByteData?>(() => rawImage.toByteData(format: ImageByteFormat.png));
    final File out =
        File("E:/ws-project/NextBot/tmp-card-render-evidence.png");
    out.writeAsBytesSync(bytes!.buffer.asUint8List());
    // ignore: avoid_print
    print("evidence saved: ${out.path} (${bytes.lengthInBytes}B)");
  });
}
