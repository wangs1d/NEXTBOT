// 真实数据渲染取证（默认跳过，PAI_PLANNING_EVIDENCE=1 时跑）：
// 用 2026-10-25 真实跑通的规划会话快照（test/fixtures/travel_planning_session_turns.json，
// 含 LLM 编排 + 实时报价），按用户在界面上的真实路径点完
// 「同行人卡 → 预算卡 → 筛选卡 → 自选补充 → 预算确认」，逐阶段出 PNG 到
// build/planning_evidence，验证同行人节奏推断、筛选后的补充卡与最终方案明细
//（时刻/距离/开放/预约/核实）真能渲染，右侧行程档案栏（骨架 A）在每一阶段
// 都跟着会话状态更新；窄窗另起一条用例验证档案降级成顶部「已定」条。
//
// 运行：
//   node tool/replay_travel_planning_session.mjs                # 3101 回放服务
//   PAI_PLANNING_EVIDENCE=1 flutter test --dart-define=HTTP_BASE=http://127.0.0.1:3101 \
//     test/travel_planning_flow_evidence_test.dart
import "dart:io";
import "dart:typed_data";
import "dart:ui" show ImageByteFormat;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart";
import "package:flutter/services.dart"
    show FontLoader, MethodCall, MethodChannel;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/chat/travel_plan_archive.dart";

const String _outDir = "build/planning_evidence";

Future<void> _loadFont(String family, List<String> paths) async {
  final FontLoader loader = FontLoader(family);
  for (final String p in paths) {
    final File f = File(p);
    if (!f.existsSync()) continue;
    final Uint8List bytes = f.readAsBytesSync();
    loader.addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
  }
  await loader.load();
}

/// 真实网络等待：replay 服务即时返回，但 Future 完成需要真实事件循环。
Future<void> _waitFor(WidgetTester tester, Finder target,
    {required String label,
    Duration timeout = const Duration(seconds: 30)}) async {
  final DateTime deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 150)));
    await tester.pump(const Duration(milliseconds: 60));
    if (target.evaluate().isNotEmpty) return;
  }
  throw TestFailure("等待超时：$label");
}

Future<void> _shot(WidgetTester tester, GlobalKey key, String name) async {
  await tester.pump(const Duration(milliseconds: 120));
  final RenderRepaintBoundary boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final dynamic rawImage =
      await tester.runAsync(() => boundary.toImage(pixelRatio: 1.5));
  final ByteData? bytes = await tester
      .runAsync<ByteData?>(() => rawImage.toByteData(format: ImageByteFormat.png));
  final Directory dir = Directory(_outDir)..createSync(recursive: true);
  final File out = File("${dir.path}/$name.png");
  out.writeAsBytesSync(bytes!.buffer.asUint8List());
  // ignore: avoid_print
  print("evidence: ${out.path} (${bytes.lengthInBytes}B)");
}

/// 等实拍图真的下载并解码完再出图。测试环境没有 path_provider，每张图都要
/// 先等磁盘缓存层失败、再走网络直连，落定比真机慢得多；只看树里有没有 Image
/// 不算（Image 早就挂上了，字节还在路上），以 imageCache 的在途计数为准。
Future<void> _settleImages(WidgetTester tester) async {
  for (int i = 0; i < 15; i++) {
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 800)));
    await tester.pump();
    final ImageCache cache = PaintingBinding.instance.imageCache;
    if (cache.liveImageCount > 0 && cache.pendingImageCount == 0) return;
  }
}

void main() {
  setUpAll(() async {
    // flutter_test 默认把所有 HTTP 打成 400；这里放开真实网络（回放服务在本机）。
    HttpOverrides.global = null;
    // 顶栏的窗口按钮会调 window_manager，测试环境没有原生实现，
    // 不拦掉就是 MissingPluginException（与本页渲染无关）。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel("window_manager"),
            (MethodCall call) async {
      if (call.method == "isMaximized") return false;
      return null;
    });
    await _loadFont("HarmonyOS Sans SC", <String>[
      "assets/fonts/harmonyos/HarmonyOS_Sans_SC_Medium.ttf",
      "assets/fonts/harmonyos/HarmonyOS_Sans_SC_Bold.ttf",
    ]);
    await _loadFont("MiSans", <String>[
      "assets/fonts/MiSans-Regular.otf",
      "assets/fonts/MiSans-Medium.otf",
      "assets/fonts/MiSans-Semibold.otf",
      "assets/fonts/MiSans-Bold.otf",
    ]);
    // 图标字体：flutter_test 不认识 MaterialIcons，不加载的话截图里全是方框。
    final String? flutterRoot = Platform.environment["FLUTTER_ROOT"];
    if (flutterRoot != null) {
      await _loadFont("MaterialIcons", <String>[
        "$flutterRoot/bin/cache/artifacts/material_fonts/materialicons-regular.otf",
      ]);
    }
  });

  testWidgets("规划全流程真实数据渲染：补充卡 → 预算 → 方案明细", (WidgetTester tester) async {
    if (Platform.environment["PAI_PLANNING_EVIDENCE"] != "1") {
      markTestSkipped("渲染取证：仅在 PAI_PLANNING_EVIDENCE=1 时运行（依赖 3101 回放服务）");
      return;
    }
    tester.view.physicalSize = const Size(1440, 2000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final GlobalKey boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        // 与 App 默认深色主题一致：卡片底色与文字色都按 dark 变体取。
        theme: AppTheme.of(AppThemeVariant.dark),
        darkTheme: AppTheme.of(AppThemeVariant.dark),
        themeMode: ThemeMode.dark,
        home: RepaintBoundary(
          key: boundaryKey,
          child: const TravelPlanArchivePage(
            seedMessage: "下周末从北京出发去成都玩三天",
          ),
        ),
      ),
    );
    await tester.pump();

    // 1) 同行人卡：选人即亮出推断的节奏，确认后才回传
    await _waitFor(tester, find.text("和伴侣"), label: "同行人问题卡");
    expect(find.textContaining("这次和谁一起去"), findsOneWidget);
    // 档案栏从第一轮就常驻右侧：行程头 + 五步轨 + 已定条（同行人还缺）
    final Finder dossier = find.byKey(const Key("planning-dossier"));
    expect(dossier, findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("行程档案")), findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("成都 · 3 天 · 北京出发")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("第 1 步 · 问答")),
        findsOneWidget);
    expect(
        find.descendant(of: dossier, matching: find.text("还没定")), findsOneWidget);
    await tester.tap(find.descendant(of: find.byKey(const Key("planning-flow")),
        matching: find.text("和伴侣")));
    await tester.pump();
    expect(find.textContaining("按「和伴侣」推断"), findsOneWidget);
    expect(find.text("就按这个来"), findsOneWidget);
    await _shot(tester, boundaryKey, "00-party");
    // 「改」展开三档节奏，确认覆盖项也能显示（只点卡片里那个，档案栏另有同名「改」）
    await tester.tap(find.descendant(
        of: find.byKey(const Key("planning-flow")), matching: find.text("改")));
    await tester.pump();
    expect(find.text("紧凑"), findsOneWidget);
    await _shot(tester, boundaryKey, "00b-party-pace");
    await tester.tap(find.text("就按这个来"));
    await tester.pump();

    // 2) 预算档位问题卡
    await _waitFor(tester, find.text("经济 · 能省则省"), label: "预算问题卡");
    // 同行人一答完，档案栏立刻收到「和伴侣 · 松弛」
    expect(
        find.descendant(of: dossier, matching: find.text("和伴侣 · 松弛")),
        findsOneWidget);
    await tester.tap(find.text("经济 · 能省则省"));
    await tester.pump();

    // 3) 筛选卡（必玩/住宿/美食真实候选）
    await _waitFor(tester, find.text("全部交给你"), label: "筛选卡");
    expect(find.textContaining("先挑想去的地方"), findsOneWidget);
    // 进度轨推进到第二步，预算档已沉进「已定」
    expect(find.descendant(of: dossier, matching: find.text("第 2 步 · 挑想去")),
        findsOneWidget);
    expect(
        find.descendant(of: dossier, matching: find.text("经济 · 能省则省")),
        findsOneWidget);
    // 零预选：一条都不替用户勾，按钮在未勾时不可点
    expect(find.text("还没勾——想去的打勾"), findsOneWidget);
    // 点实拍图 → 双面板看图（左大图 + 右完整介绍与每条数的出处）
    await _settleImages(tester);
    await tester.tap(find.byKey(const Key("guide-photo-1")).first);
    await tester.pump();
    expect(find.byKey(const Key("planning-guide-viewer")), findsOneWidget);
    expect(find.text("高德用户评分"), findsWidgets);
    await _settleImages(tester);
    await _shot(tester, boundaryKey, "01b-guide-viewer");
    await tester.tap(find.byKey(const Key("guide-viewer-close")));
    await tester.pump();
    expect(find.byKey(const Key("planning-guide-viewer")), findsNothing);
    await _settleImages(tester);
    await _shot(tester, boundaryKey, "01-guide");
    // 勾两处后主按钮才亮，且 footer 计数跟着走
    for (final String name in <String>["都江堰景区", "宽窄巷子景区"]) {
      final Finder dot = find.byKey(Key("guide-check-$name"));
      await tester.ensureVisible(dot);
      await tester.pump();
      await tester.tap(dot);
      await tester.pump();
    }
    expect(find.text("已选 2 处"), findsOneWidget);
    await tester.tap(find.text("全部交给你"));
    await tester.pump();

    // 4) 自选补充卡（勾选后、预算前）
    await _waitFor(tester, find.text("还有非去不可的地方吗？"), label: "自选补充卡");
    // 勾选项进档案栏「想去/住/吃」，与补充卡上的已选清单一一对应
    expect(
        find.descendant(of: dossier, matching: find.text("都江堰景区、宽窄巷子景区、川西竹海景区")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.textContaining("NOX酒店")),
        findsOneWidget);
    final Finder fields = find.byType(TextField);
    expect(fields.evaluate().length, greaterThanOrEqualTo(4),
        reason: "三个补充输入 + 底部输入框");
    await tester.enterText(fields.at(0), "都江堰、成都大熊猫繁育研究基地");
    await tester.enterText(fields.at(1), "太古里附近的酒店");
    await tester.enterText(fields.at(2), "陈麻婆豆腐");
    await tester.pump();
    await _shot(tester, boundaryKey, "02-wishlist");
    final Finder addBtn = find.text("加上这些，算预算");
    await tester.ensureVisible(addBtn);
    await tester.pump();
    await tester.tap(addBtn);
    await tester.pump();

    // 5) 预算卡（真实报价 + 待核价）
    await _waitFor(tester, find.text("同意，出方案"), label: "预算卡");
    await tester.ensureVisible(find.text("同意，出方案"));
    await tester.pump();
    expect(find.textContaining("待核价"), findsWidgets);
    // 钱的水位：总额 + 待核价口径与预算卡一致
    expect(find.descendant(of: dossier, matching: find.text("钱的水位")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("¥1755")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("9 项待核价未计入")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("第 4 步 · 核预算")),
        findsOneWidget);
    await _shot(tester, boundaryKey, "03-budget");
    await tester.tap(find.text("同意，出方案"));
    await tester.pump();

    // 6) 出票动画 → 关掉 → 最终方案明细
    await _waitFor(tester, find.text("稍后再看"), label: "出票动画");
    await _shot(tester, boundaryKey, "04-ticket");
    await tester.tap(find.text("稍后再看"), warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 300));

    await _waitFor(tester, find.textContaining("下面是照着能走的整体安排"),
        label: "方案明细尾注");
    final Finder planList = find.byType(ListView).first;
    await tester.drag(planList, const Offset(0, -4000));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.drag(planList, const Offset(0, -4000));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining("站 · 路上"), findsWidgets);
    expect(find.textContaining("处待核实"), findsWidgets);
    // 档案栏收尾：五步走完 + 核实风险沉到「核实」段
    expect(find.descendant(of: dossier, matching: find.text("五步走完，方案已出")),
        findsOneWidget);
    expect(find.descendant(of: dossier, matching: find.text("核实")),
        findsOneWidget);
    await _shot(tester, boundaryKey, "05-plan");
    // 放开真实网络后 HttpClient 会留 15s keep-alive 空闲计时器；
    // 不收掉就是 teardown 报 pending timers（与本页渲染无关）。
    await tester.pump(const Duration(seconds: 16));
  });

  // 窄窗降级：第三栏放不下时，档案收成顶部一条横向「已定」胶囊。
  testWidgets("窄窗（<1020）档案栏降级为顶部已定条", (WidgetTester tester) async {
    if (Platform.environment["PAI_PLANNING_EVIDENCE"] != "1") {
      markTestSkipped("渲染取证：仅在 PAI_PLANNING_EVIDENCE=1 时运行（依赖 3101 回放服务）");
      return;
    }
    tester.view.physicalSize = const Size(980, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final GlobalKey boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.of(AppThemeVariant.dark),
        darkTheme: AppTheme.of(AppThemeVariant.dark),
        themeMode: ThemeMode.dark,
        home: RepaintBoundary(
          key: boundaryKey,
          child: const TravelPlanArchivePage(
            seedMessage: "下周末从北京出发去成都玩三天，和女朋友一起",
          ),
        ),
      ),
    );
    await _waitFor(tester, find.textContaining("这次和谁一起去"),
        label: "同行人问题卡");
    expect(find.byKey(const Key("planning-dossier")), findsNothing);
    final Finder strip = find.byKey(const Key("planning-dossier-strip"));
    expect(strip, findsOneWidget);
    expect(
        find.descendant(of: strip, matching: find.text("成都 · 3 天 · 北京出发")),
        findsOneWidget);
    expect(find.descendant(of: strip, matching: find.text("去哪儿 成都")),
        findsOneWidget);
    // 原话里说了「和女朋友一起」→ 同行人不用问就已经是已定项
    expect(
        find.descendant(of: strip, matching: find.text("和谁去 和伴侣 · 松弛")),
        findsOneWidget);
    await _shot(tester, boundaryKey, "06-narrow");
  });
}
