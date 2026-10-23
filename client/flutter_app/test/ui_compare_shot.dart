/// 文本排版改造「前 / 后」对比截图生成器。
///
/// 运行（输出目录用环境变量切换，同一份样例内容保证前后可比）：
///   UI_SHOT_DIR=ui_compare_shots/before flutter test --update-goldens test/ui_compare_shot.dart
///   UI_SHOT_DIR=ui_compare_shots/after  flutter test --update-goldens test/ui_compare_shot.dart
///
/// 拼合前后对比图（把两个目录的 PNG 左右拼成一张，输出到 UI_COMPARE_DIR）：
///   UI_COMPARE=1 UI_COMPARE_DIR=ui_compare_shots/compare flutter test --update-goldens test/ui_compare_shot.dart
///
/// 样例内容覆盖本次改造的全部排版元素：导语面板、一/二级标题、引用块、
/// 分隔线、表格、代码块、有序/无序/嵌套列表（两位数编号）、段落节奏、
/// 行内 markdown（加粗/链接/行内 code/删除线）、块级图片、内容摘要卡、
/// 检索条目面板与打字机光标。
library;

import "dart:convert" show jsonEncode;
import "dart:io" show Directory, File, Platform;
import "dart:typed_data" show ByteData, Uint8List;
import "dart:ui" as ui;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/core/utils/content_summary_parser.dart";
import "package:nextbot/features/chat/content_summary_card.dart";
import "package:nextbot/features/chat/structured_assistant_message_body.dart";

Future<void> _loadFonts() async {
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
    "assets/fonts/MiSans-Bold.otf",
  ]) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();

  try {
    final String cacheDir = File(
      Platform.resolvedExecutable,
    ).parent.parent.parent.parent.path;
    final File iconFont = File(
      "$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf",
    );
    await (FontLoader(
      "MaterialIcons",
    )..addFont(iconFont
                .readAsBytes()
                .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {}

  try {
    final File emoji = File(r"C:\Windows\Fonts\seguiemj.ttf");
    await (FontLoader(
      "SegoeEmoji",
    )..addFont(emoji
                .readAsBytes()
                .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {}

  // 等宽字体：行内 code / 代码块用（AppTypography.monoFontFamily = "monospace"）
  try {
    final File mono = File(r"C:\Windows\Fonts\consola.ttf");
    await (FontLoader(
      "monospace",
    )..addFont(mono
                .readAsBytes()
                .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {}
}

ThemeData _withEmojiFallback(ThemeData theme) {
  TextTheme fallback(TextTheme? t) => (t ?? const TextTheme()).apply(
        fontFamilyFallback: <String>["SegoeEmoji"],
      );
  return theme.copyWith(
    textTheme: fallback(theme.textTheme),
    primaryTextTheme: fallback(theme.primaryTextTheme),
  );
}

/// 样例一：结构化 markdown 长文（覆盖导语 / 标题 / 引用 / 表格 / 代码 /
/// 列表 / 行内语法 / 块级图片 / 段落节奏）。
const String _markdownSample = """
王哥，马尔代夫的顶奢包岛方案帮你捋好了，预算内优先 **Four Seasons Voavah**，备选白马庄园。

# 🏝️ 马尔代夫 7 天 6 晚包岛规划

> **预算**：无上限｜**核心需求**：整岛包租 + 私人泳池

---

## 🌟 首选岛屿：Four Seasons Voavah

| 物业 | 数量 | 亮点 |
|------|------|------|
| 三卧室沙滩别墅 | 1 栋 | 主别墅，带 25 米私人泳池 |
| 双卧室水上别墅 | 1 栋 | 玻璃地板、直达海面滑梯 |

### Day 1 抵达日 — 私人飞机上岛
- **上午**：私人飞机抵达马累，CIP 快速通关
- **下午**：登岛仪式，入住主别墅
  - 选项 A：全身 Spa + 面部护理
  - 选项 B：海上瑜伽 + 冥想音疗
1. **最佳季节**：12 月至次年 4 月（旱季）
2. **建议预订周期**：至少提前 6-12 个月
3. **岛上交通**：水上飞机约 45 分钟
4. **儿童俱乐部**：1 对 1 管家陪护
5. **浮潜**：屋礁直接下水
6. **餐饮**：主厨定制，含香槟早餐
7. **水疗**：日落时分珊瑚吧
8. **出海**：无人沙洲野餐
9. **摄影**：随行跟拍半天
10. **送别**：私人沙滩晚宴
单换行分段的第一段，观察与下一段之间的间距节奏是否均匀。
单换行分段的第二段，行内混排 `npm run deploy` 与 [官方文档](https://example.com/docs)，以及 ~~已过期方案~~ 的展示。
![水上屋示意图](https://example.com/overwater-villa.png)

结尾段落，观察与上方图片的间距与对齐。""";

/// 样例二：内容摘要卡（简洁要点 + 检索条目面板 + 折叠详情卡）。
String _buildSummaryOutput() {
  final Map<String, dynamic> payload = <String, dynamic>{
    "type": "content_summary_v2",
    "id": "sum-ui-compare",
    "category": "news",
    "title": "今天值得看的科技动态，按板块给你捋好了",
    "cardIcon": "☰",
    "cardLabel": "科技新闻",
    "subjectLabel": "科技新闻",
    "briefCount": 4,
    "briefPoints": <dynamic>[
      <String, String>{
        "icon": "🔥",
        "text": "五角大楼首次证实已部署太空武器，中国随即警告「勿搞军事竞赛」。",
      },
      <String, String>{
        "icon": "💡",
        "text": "内存明年还要涨 **30%** 起跳，传苹果已点头接受供货价。",
      },
      <String, String>{
        "icon": "⚡",
        "text": "AI 监管成焦点：美众议院放话「不能暂停 AI 发展」。",
      },
      <String, String>{
        "icon": "📌",
        "text": "这些报道大多没标发布时间，按来源判断是这两天的。",
      },
    ],
    "items": <dynamic>[
      <String, dynamic>{
        "title": "Pentagon confirms space weapons deployment",
        "snippet": "美国国防部首次公开确认在轨武器系统的存在，盟友通报流程同步启动。",
        "source": "BBC 中文",
        "publishedAt": "09-16",
        "url": "https://example.com/space",
      },
      <String, dynamic>{
        "title": "内存合约价明年一季度再涨三成",
        "snippet": "供应链消息：三大原厂减产延续，服务器 DDR5 现货价率先反弹。",
        "source": "华尔街日报中文网",
        "publishedAt": "09-16",
        "url": "https://example.com/dram",
      },
      <String, dynamic>{
        "title": "美众议院就 AI 监管举行听证",
        "snippet": "两党议员就「暂停 vs 加速」交锋，立法要求企业证明安全措施。",
        "source": "路透社",
        "publishedAt": "09-15",
        "url": "https://example.com/ai",
      },
    ],
    "detailContent": """
## 国际 · 最抢眼的
- **美国首个认部署太空武器**：五角大楼首次证实，中国随即警告。
- **AI 监管成焦点**：参议院正酝酿立法，要求 AI 公司证明已采取安全措施。

## 财经向的小道消息
内存明年还要涨 **30%** 起跳、传苹果"点头"。""",
    "sections": <dynamic>[
      <String, dynamic>{"title": "国际 · 最抢眼的", "pointCount": 2},
      <String, dynamic>{"title": "财经向的小道消息", "pointCount": 1},
    ],
    "metadata": <String, dynamic>{
      "subjectLabel": "科技新闻",
      "wordCount": 412,
      "itemCount": 3,
      "sectionCount": 2,
      "hasTable": false,
      "hasList": true,
    },
  };
  // 检索条目面板：真实链路里 search_web 的 raw JSON 回显在
  // [CONTENT_SUMMARY_V2_END] 与 <details_card> 之间，由 parser 提取。
  final String itemsEcho = jsonEncode(<String, dynamic>{
    "items": <dynamic>[
      <String, dynamic>{
        "title": "Pentagon confirms space weapons deployment",
        "snippet": "美国国防部首次公开确认在轨武器系统的存在，盟友通报流程同步启动。",
        "source": "BBC 中文",
        "publishedAt": "09-16",
        "url": "https://example.com/space",
      },
      <String, dynamic>{
        "title": "内存合约价明年一季度再涨三成",
        "snippet": "供应链消息：三大原厂减产延续，服务器 DDR5 现货价率先反弹。",
        "source": "华尔街日报中文网",
        "publishedAt": "09-16",
        "url": "https://example.com/dram",
      },
      <String, dynamic>{
        "title": "美众议院就 AI 监管举行听证",
        "snippet": "两党议员就「暂停 vs 加速」交锋，立法要求企业证明安全措施。",
        "source": "路透社",
        "publishedAt": "09-15",
        "url": "https://example.com/ai",
      },
    ],
  });
  return "[CONTENT_SUMMARY_V2_START]\n${jsonEncode(payload)}\n[CONTENT_SUMMARY_V2_END]\n\n$itemsEcho\n\n<details_card ref=\"sum-ui-compare\" />";
}

/// 面板外壳：深色主题 + 固定画布 + 滚动（避免溢出异常），捕获目标用 Key 定位。
Widget _panel({required String panelKey, required Widget child, double height = 1500}) {
  final ThemeData theme = AppTheme.of(AppThemeVariant.dark);
  final ColorScheme cs = theme.colorScheme;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: _withEmojiFallback(theme),
    home: Scaffold(
      backgroundColor: cs.surface,
      body: Center(
        child: Container(
          key: Key(panelKey),
          width: 720,
          height: height,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: cs.outline.withValues(alpha: 0.32)),
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[child],
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> _pumpAndCapture(
  WidgetTester tester,
  Widget Function() harness,
  Size size,
  String golden,
  Finder captureTarget,
) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 2.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(harness());
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  if (autoUpdateGoldenFiles) {
    await expectLater(captureTarget, matchesGoldenFile("$golden.png"));
  }
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _capturePanel(
  WidgetTester tester, {
  required String name,
  required Widget Function() harness,
  required String panelKey,
  required double width,
  required double height,
}) async {
  final String dir = Platform.environment["UI_SHOT_DIR"] ?? "goldens/ui_compare";
  // 真实文件 I/O 必须走 runAsync：widget 测试的 FakeAsync zone 里
  // 普通异步 I/O 永远不会完成（表现为测试挂起）。
  await tester.runAsync(() async {
    await Directory(dir).create(recursive: true);
  });
  // matchesGoldenFile 相对 test/ 目录解析；目录/文件 I/O 相对 CWD（flutter_app 根）。
  final String goldenRel = dir.startsWith("test/") ? dir.substring(5) : dir;
  await _pumpAndCapture(
    tester,
    harness,
    Size(width * 2, height * 2),
    "$goldenRel/$name",
    find.byKey(Key(panelKey)),
  );
}

/// 把 before/after 两个目录的同名 PNG 左右拼成一张对比图。
Future<void> _composeComparisons(WidgetTester tester) async {
  final String beforeDir = Platform.environment["UI_BEFORE"] ?? "ui_compare_shots/before";
  final String afterDir = Platform.environment["UI_AFTER"] ?? "ui_compare_shots/after";
  final String outDir = Platform.environment["UI_COMPARE_DIR"] ?? "ui_compare_shots/compare";
  await tester.runAsync(() async {
    await Directory(outDir).create(recursive: true);
  });

  final List<File> files = (await tester.runAsync<List<File>>(() async =>
          Directory(beforeDir)
              .listSync()
              .whereType<File>()
              .where((File f) => f.path.endsWith(".png"))
              .toList()
        ..sort((File a, File b) => a.path.compareTo(b.path))))!;

  for (final File f in files) {
    final String name = f.uri.pathSegments.last;
    final List<int> afterBytes = (await tester.runAsync<List<int>>(() async {
      final File afterFile = File("$afterDir/$name");
      if (!afterFile.existsSync()) return const <int>[];
      return afterFile.readAsBytesSync();
    }))!;
    if (afterBytes.isEmpty) continue;

    final ui.Image beforeImg =
        (await tester.runAsync(() => _decode(f.readAsBytesSync())))!;
    final ui.Image afterImg =
        (await tester.runAsync(() => _decode(afterBytes)))!;

    const double gutter = 24;
    final double panelW = beforeImg.width.toDouble();
    final double panelH =
        beforeImg.height.toDouble() > afterImg.height.toDouble()
            ? beforeImg.height.toDouble()
            : afterImg.height.toDouble();
    final double canvasW = panelW * 2 + gutter * 3;
    final double canvasH = panelH + 88 + gutter * 2;

    tester.view.physicalSize = Size(canvasW, canvasH);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final ThemeData theme = AppTheme.of(AppThemeVariant.dark);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme,
        home: Scaffold(
          backgroundColor: const Color(0xFF17171A),
          body: Padding(
            padding: const EdgeInsets.all(gutter),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    SizedBox(width: panelW, child: _label("改造前（before）", name)),
                    SizedBox(width: gutter, child: const SizedBox.shrink()),
                    SizedBox(width: panelW, child: _label("改造后（after）", name)),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    RawImage(image: beforeImg, width: panelW),
                    SizedBox(width: gutter + (panelH - afterImg.height) / 2),
                    RawImage(image: afterImg, width: panelW),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final String outRel =
        outDir.startsWith("test/") ? outDir.substring(5) : outDir;
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile("$outRel/$name"),
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Widget _label(String text, String name) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Text(
        text,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 22,
          fontWeight: FontWeight.w700,
        ),
      ),
      Text(name, style: const TextStyle(color: Colors.white54, fontSize: 13)),
    ],
  );
}

Future<ui.Image> _decode(List<int> bytes) async {
  final ui.ImmutableBuffer buffer =
      await ui.ImmutableBuffer.fromUint8List(Uint8List.fromList(bytes));
  final ui.ImageDescriptor descriptor = await ui.ImageDescriptor.encoded(buffer);
  final ui.Codec codec = await descriptor.instantiateCodec();
  final ui.FrameInfo frame = await codec.getNextFrame();
  return frame.image;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);

  final ContentSummaryParseResult summaryParsed = ContentSummaryParser.parse(
    _buildSummaryOutput(),
  );

  testWidgets("面板 A：结构化 markdown 长文", (WidgetTester tester) async {
    if (Platform.environment["UI_COMPARE"] == "1") {
      await _composeComparisons(tester);
      return;
    }
    await _capturePanel(
      tester,
      name: "01-markdown-body",
      panelKey: "panel-a",
      width: 720,
      height: 1500,
      harness: () => _panel(
        panelKey: "panel-a",
        child: StructuredAssistantMessageBody(
          text: _markdownSample,
          cs: AppTheme.of(AppThemeVariant.dark).colorScheme,
          textTheme: _withEmojiFallback(AppTheme.of(AppThemeVariant.dark)).textTheme,
        ),
      ),
    );
  });

  testWidgets("面板 B：内容摘要卡", (WidgetTester tester) async {
    if (Platform.environment["UI_COMPARE"] == "1") {
      return;
    }
    await _capturePanel(
      tester,
      name: "02-summary-card",
      panelKey: "panel-b",
      width: 720,
      height: 860,
      harness: () => _panel(
        panelKey: "panel-b",
        height: 860,
        child: ContentSummaryMessageBody(
          summary: summaryParsed.summary!,
          briefText: summaryParsed.briefText,
          structuredItems: summaryParsed.structuredItems,
          extraText: summaryParsed.cleanedText,
          onCardTap: () {},
        ),
      ),
    );
  });

  testWidgets("面板 C：打字机光标", (WidgetTester tester) async {
    if (Platform.environment["UI_COMPARE"] == "1") {
      return;
    }
    await _capturePanel(
      tester,
      name: "03-typewriter-cursor",
      panelKey: "panel-c",
      width: 720,
      height: 190,
      harness: () => _panel(
        panelKey: "panel-c",
        height: 190,
        child: StructuredAssistantMessageBody(
          text: "正在为你确认最后两晚的房态，稍等，马上把报价单整理出来。",
          cs: AppTheme.of(AppThemeVariant.dark).colorScheme,
          textTheme: _withEmojiFallback(AppTheme.of(AppThemeVariant.dark)).textTheme,
          showCursor: true,
        ),
      ),
    );
  });
}
