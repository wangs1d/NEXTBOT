import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/content_summary_parser.dart";
import "package:nextbot/features/chat/content_summary_detail_formatter.dart";

/// markdown 结构化内容展示标杆回归。
///
/// 标杆样例（用户认可的富文本范式）：emoji 分级标题（#/##/###）+ 开头 > 引用块
/// 关键事实 + markdown 表格 + -/**加粗导语**列表（含嵌套）+ --- 大板块分隔线。
/// 渲染器必须把这些语法落到对应组件，而不是当纯文本漏成字面量。
const String benchmarkMarkdown = """
# 🏝️ 马尔代夫7天6晚顶奢包岛度假规划

> **预算：无上限 | 核心需求：整岛包租 + 私人泳池**

---

## 🌟 首选岛屿：Four Seasons Voavah

| 物业 | 数量 | 亮点 |
|------|------|------|
| 三卧室沙滩别墅 | 1栋 | 主别墅，带超大私人泳池 |
| 双卧室水上别墅 | 1栋 | 玻璃地板、直接入海滑梯 |

### Day 1 抵达日 — 私人飞机上岛

- **上午**：私人飞机抵达马累，CIP快速通关
- **下午**：登岛仪式，入住别墅
  - 选项A：全身Spa + 面部护理
  - 选项B：海上瑜伽 + 冥想音疗

1. **最佳季节**：12月-4月（旱季）
2. **预订周期**：至少提前6-12个月
""";

Future<void> pumpDetailLines(WidgetTester tester, String content) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData(useMaterial3: true),
      home: Builder(
        builder: (BuildContext context) {
          final ThemeData theme = Theme.of(context);
          return Scaffold(
            body: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: formatContentSummaryDetailLines(
                  content,
                  theme.colorScheme,
                  theme.textTheme,
                ),
              ),
            ),
          );
        },
      ),
    ),
  );
  await tester.pump();
}

double _leftPaddingOf(WidgetTester tester, Finder textFinder) {
  final Padding padding = tester.widget<Padding>(
    find.ancestor(of: textFinder, matching: find.byType(Padding)).last,
  );
  final EdgeInsetsGeometry insets = padding.padding;
  return insets is EdgeInsets ? insets.left : 0;
}

void main() {
  Future<void> pumpTableInWidth(WidgetTester tester, String table) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(useMaterial3: true),
        home: Builder(
          builder: (BuildContext context) {
            final ThemeData theme = Theme.of(context);
            return Scaffold(
              body: Center(
                child: SizedBox(
                  width: 600,
                  child: SingleChildScrollView(
                    child: Column(
                      children: formatContentSummaryDetailLines(
                        table,
                        theme.colorScheme,
                        theme.textTheme,
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
    await tester.pump();
  }

  double tableRowWidth(WidgetTester tester) {
    return tester.getSize(
      find
          .descendant(
            of: find.byType(MarkdownTableWidget),
            matching: find.byType(Row),
          )
          .first,
    ).width;
  }

  testWidgets("表格宽度：窄表撑满可用宽度，不再固定 140px/列右侧留白", (
    WidgetTester tester,
  ) async {
    await pumpTableInWidth(
      tester,
      "| 店 | 招牌 |\n|---|---|\n| 陈麻婆豆腐 | 麻婆豆腐发源地 |\n",
    );

    expect(tableRowWidth(tester), 600.0);
  });

  testWidgets("表格宽度：列数多时行宽超出容器，保留横向滚动", (
    WidgetTester tester,
  ) async {
    await pumpTableInWidth(
      tester,
      "| c1 | c2 | c3 | c4 | c5 | c6 |\n"
          "|---|---|---|---|---|---|\n"
          "| 1 | 2 | 3 | 4 | 5 | 6 |\n",
    );

    // 6 列 × 140 = 840 > 600，超宽走横向滚动而非挤压。
    expect(tableRowWidth(tester), 840.0);
  });


  testWidgets("标杆渲染：--- 分隔线渲染为 Divider，不再漏成字面量文本", (
    WidgetTester tester,
  ) async {
    await pumpDetailLines(tester, benchmarkMarkdown);

    expect(find.byType(Divider), findsAtLeastNWidgets(1));
    expect(find.textContaining("---"), findsNothing);
  });

  testWidgets("标杆渲染：表格落到 MarkdownTableWidget，加粗/引用正常行内渲染", (
    WidgetTester tester,
  ) async {
    await pumpDetailLines(tester, benchmarkMarkdown);

    expect(find.byType(MarkdownTableWidget), findsOneWidget);
    expect(find.textContaining("三卧室沙滩别墅"), findsOneWidget);
    // 引用块：开头关键前提（> **预算：无上限...）不再带 ">" 字面前缀
    expect(find.textContaining("> **预算"), findsNothing);
    expect(find.textContaining("预算：无上限"), findsOneWidget);
  });

  testWidgets("标杆渲染：嵌套列表比顶层列表缩进更深，有序列表保留编号", (
    WidgetTester tester,
  ) async {
    await pumpDetailLines(tester, benchmarkMarkdown);

    final double topLevel = _leftPaddingOf(
      tester,
      find.textContaining("私人飞机抵达马累"),
    );
    final double nested = _leftPaddingOf(
      tester,
      find.textContaining("选项A"),
    );
    expect(nested, greaterThan(topLevel));

    expect(find.text("1."), findsOneWidget);
    expect(find.text("2."), findsOneWidget);
  });

  test("详情消毒：YAML front matter（AIGC 标识等元数据）整体剥离，正文分隔线保留", () {
    const String withFrontMatter =
        "---\nAIGC:\n    Label: \"1\"\n    ProduceID: x123\n---\n# 标题\n\n## 板块一\n\n---\n\n正文段落";
    final String cleaned = ContentSummaryParser.sanitizeDetailContent(
      withFrontMatter,
      "标题",
    );

    expect(cleaned.contains("AIGC"), isFalse);
    expect(cleaned.contains("ProduceID"), isFalse);
    expect(cleaned.contains("## 板块一"), isTrue);
    // 正文里的 --- 是板块分隔线，不能被误删
    expect(cleaned.contains("---"), isTrue);
  });

  test("详情消毒：只剥 RENDER 声明标记行，与标题同文的首行导语保留（卡内是全文）", () {
    const String dirty =
        "王哥，我扒了一圈今天的公开报道，给你按块捋一下——\n\n[RENDER_HINT:structured]\n\n## 板块一\n\n正文";
    final String cleaned = ContentSummaryParser.sanitizeDetailContent(
      dirty,
      "王哥，我扒了一圈今天的公开报道，给你按块捋一下——",
    );

    expect(cleaned.contains("RENDER_HINT"), isFalse);
    expect(cleaned.contains("王哥，我扒了一圈"), isTrue);
    expect(cleaned.contains("## 板块一"), isTrue);
  });
}
