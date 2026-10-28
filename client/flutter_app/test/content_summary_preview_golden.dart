/// 内容摘要折叠卡的视觉预览生成器（真实效果模拟）。
///
/// 运行 `flutter test --update-goldens test/content_summary_preview_golden.dart`
/// 生成 goldens 目录下的 PNG：
///   - content_summary_bubble_dark.png  聊天气泡：简洁要点正文 + 下方折叠卡
///   - content_summary_panel_dark.png   右侧双面板：chrome 标题栏(科技新闻)
///                                      + 书签导航 + markdown 详细正文
///
/// 数据走真实链路：payload 与服务端 formatContentSummaryForChat 的产物同构
///（jsonEncode 等价于服务端 JSON.stringify），经 ContentSummaryParser.parse
/// 解析后渲染，见到的即真实效果。
library;

import "dart:convert" show jsonEncode;
import "dart:io" show File, Platform;
import "dart:typed_data" show ByteData, Uint8List;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/core/utils/content_summary_parser.dart";
import "package:nextbot/features/chat/content_summary_card.dart";
import "package:nextbot/features/chat/content_summary_detail_view.dart";

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

  // MaterialIcons：SDK 缓存里（找不到时图标退化为豆腐块，不影响预览）
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

  // emoji：Windows 系统的 Segoe UI Emoji（📌 等 brief 图标正常显示）
  try {
    final File emoji = File(r"C:\Windows\Fonts\seguiemj.ttf");
    await (FontLoader(
      "SegoeEmoji",
    )..addFont(emoji
                .readAsBytes()
                .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {}
}

/// 与服务端产物同构的摘要 payload + 标记文本（科技新闻场景）
String _buildServerOutput() {
  final Map<String, dynamic> payload = <String, dynamic>{
    "type": "content_summary_v2",
    "id": "sum-preview-news",
    "category": "news",
    "title": "科技新闻",
    "cardIcon": "☰",
    "cardLabel": "科技新闻",
    "subjectLabel": "科技新闻",
    "briefCount": 6,
    "briefPoints": <dynamic>[
      // 新版要点：各板块轮询提取的真实内容（非「涵盖哪些板块」式转述）
      <String, String>{
        "icon": "🔥",
        "text":
            "美国首个认部署太空武器：五角大楼首次证实已部署太空武器，中国随即警告\"勿搞军事竞赛\"（BBC中文 / 华尔街日报中文网）。",
      },
      <String, String>{
        "icon": "💡",
        "text":
            "河北一位老妇被放入冰箱后停眠\"复活\"，移出冷藏两天后去世——这条在世界新闻网上了即时榜。",
      },
      <String, String>{
        "icon": "⚡",
        "text": "内存明年还要涨 **30%** 起跳、传苹果\"点头\"；伊朗战争已耗美国 **380** 亿美元。",
      },
      <String, String>{
        "icon": "🚀",
        "text": "这些搜索结果大多没标具体发布时间，按来源和内容判断是这两天的。",
      },
      <String, String>{
        "icon": "✨",
        "text":
            "AI 监管成焦点：美众议院放话\"不能暂停 AI 发展\"；参议院正酝酿立法，要求 AI 公司证明已采取安全措施。",
      },
      <String, String>{
        "icon": "📌",
        "text": "蒋万安妻子因说 \"Chinese Taipei\" 被出征，劳动部长回应\"名称就是如此\"。",
      },
    ],
    // 当前服务端生成时已剥离标题回显首行与渲染标记，正文直接以板块开头
    "detailContent": """
## 国际 · 最抢眼的
- **美国首个认部署太空武器**：五角大楼首次证实已部署太空武器，中国随即警告"勿搞军事竞赛"（BBC中文 / 华尔街日报中文网）。
- **AI 监管成焦点**：美众议院放话"不能暂停 AI 发展，否则会让中国取得竞争优势"；参议院正酝酿立法，要求 AI 公司证明已采取安全措施。
- **美国方向**：美国施压墨西哥，要求封锁中国 AI 硬件出口。

## 国内/华语 · 值得留意的
- **河北一位老妇被放入冰箱后停眠"复活"**，移出冷藏两天后去世——这条在世界新闻网上了即时榜。
- **蒋万安妻子因说 "Chinese Taipei" 被出征**，劳动部长回应"名称就是如此"。

## 财经向的小道消息
内存明年还要涨 **30%** 起跳、传苹果"点头"；伊朗战争已耗美国 **380** 亿美元。

---

## 实用提示
- 这些搜索结果大多没标具体发布时间，按来源和内容判断是这两天的。
- 想深挖哪一条，可以再去把那篇原文扒出来。""",
    "sections": <dynamic>[
      <String, dynamic>{"title": "国际 · 最抢眼的", "pointCount": 3},
      <String, dynamic>{"title": "国内/华语 · 值得留意的", "pointCount": 2},
      <String, dynamic>{"title": "财经向的小道消息", "pointCount": 1},
      <String, dynamic>{"title": "实用提示", "pointCount": 2},
    ],
    "metadata": <String, dynamic>{
      "subjectLabel": "科技新闻",
      "wordCount": 614,
      "itemCount": 3,
      "sectionCount": 4,
      "hasTable": false,
      "hasList": true,
    },
  };

  return "[CONTENT_SUMMARY_V2_START]\n${jsonEncode(payload)}\n[CONTENT_SUMMARY_V2_END]\n\n<details_card ref=\"sum-preview-news\" />";
}

/// 主题文本样式补上 emoji 回退字体（📌 等符号用 SegoeEmoji 渲染）
ThemeData _withEmojiFallback(ThemeData theme) {
  TextTheme fallback(TextTheme? t) => (t ?? const TextTheme()).apply(
        fontFamilyFallback: <String>["SegoeEmoji"],
      );
  return theme.copyWith(
    textTheme: fallback(theme.textTheme),
    primaryTextTheme: fallback(theme.primaryTextTheme),
  );
}

/// 模拟聊天气泡容器（surfaceContainerLow 泡底 + 圆角描边，同聊天流）
Widget _bubbleHarness(ContentSummaryParseResult parsed) {
  final ThemeData theme = AppTheme.of(AppThemeVariant.dark);
  final ColorScheme cs = theme.colorScheme;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: _withEmojiFallback(theme),
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
            child: ContentSummaryMessageBody(
              summary: parsed.summary!,
              briefText: parsed.briefText,
              structuredItems: parsed.structuredItems,
              onCardTap: () {},
            ),
          ),
        ),
      ),
    ),
  );
}

/// 模拟右侧双面板：chrome 标题栏（拖拽柄 + 主体标签 + 关闭）+ 详情视图
Widget _panelHarness(ContentSummaryParseResult parsed) {
  final ThemeData theme = AppTheme.of(AppThemeVariant.dark);
  final ColorScheme cs = theme.colorScheme;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: _withEmojiFallback(theme),
    home: Scaffold(
      backgroundColor: cs.surface,
      body: Center(
        child: Container(
          width: 640,
          height: 900,
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: cs.outline.withValues(alpha: 0.32)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Container(
                padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                      color: cs.outline.withValues(alpha: 0.25),
                    ),
                  ),
                ),
                child: Row(
                  children: <Widget>[
                    Icon(
                      Icons.drag_indicator,
                      size: 16,
                      color: cs.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      ContentSummaryParser.taskSubject(parsed.summary!),
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    const Spacer(),
                    Icon(Icons.close, size: 18, color: cs.onSurfaceVariant),
                  ],
                ),
              ),
              Expanded(
                child: ContentSummaryDetailView(
                  key: ValueKey<String>(parsed.summary!.id),
                  summary: parsed.summary!,
                ),
              ),
            ],
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
    await expectLater(captureTarget, matchesGoldenFile("goldens/$golden"));
  }
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadFonts);

  final ContentSummaryParseResult parsed = ContentSummaryParser.parse(
    _buildServerOutput(),
  );

  testWidgets("预览：聊天气泡（简洁要点 + 折叠卡）深色主题", (WidgetTester tester) async {
    await _pumpAndCapture(
      tester,
      () => _bubbleHarness(parsed),
      // physicalSize = 逻辑尺寸 × 2（devicePixelRatio 2.0，导出 2x 清晰图）
      const Size(760 * 2, 560 * 2),
      "content_summary_bubble_dark.png",
      find.byType(ContentSummaryMessageBody),
    );
  });

  testWidgets("预览：右侧双面板（主体标签标题栏 + 书签 + 详细正文）深色主题", (
    WidgetTester tester,
  ) async {
    await _pumpAndCapture(
      tester,
      () => _panelHarness(parsed),
      const Size(760 * 2, 980 * 2),
      "content_summary_panel_dark.png",
      find.byType(ContentSummaryDetailView),
    );
  });
}
