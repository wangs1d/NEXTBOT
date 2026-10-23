import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/image_preview_launcher.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/display_effects/carousel_effect_card.dart";
import "package:nextbot/features/chat/display_effects/chips_effect_card.dart";
import "package:nextbot/features/chat/display_effects/compare_slider.dart";
import "package:nextbot/features/chat/display_effects/display_effects.dart";
import "package:nextbot/features/chat/display_effects/fold_list_effect_card.dart";
import "package:nextbot/features/chat/display_effects/metric_effect_card.dart";
import "package:nextbot/features/chat/display_effects/steps_effect_card.dart";

Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

AgentResultItem item(String text, {String type = "num"}) =>
    AgentResultItem(type: type, text: text);

void main() {
  setUp(() {
    ImagePreviewLauncher.reset();
  });

  // ───────────────────────────────────────────────────────────────────
  // 分发入口：cardType → 效果组件（动态路由，无 LLM 参与）
  // ───────────────────────────────────────────────────────────────────

  test("displayEffectsCard routes cardType to effect widgets", () {
    final ColorScheme cs = ColorScheme.fromSeed(seedColor: Colors.blue);
    Widget? route(String cardType, {List<AgentResultItem> items = const []}) =>
        displayEffectsCard(
          data: AgentResultData(cardType: cardType, items: items),
          cs: cs,
        );

    expect(route("steps").runtimeType, StepsEffectCard);
    expect(route("metric").runtimeType, MetricEffectCard);
    expect(route("carousel").runtimeType, CarouselEffectCard);
    expect(route("chips").runtimeType, ChipsEffectCard);
    expect(route("fold_list").runtimeType, FoldListEffectCard);
    // 未知/既有类型 → null（回退 AgentResultCard 默认渲染）
    expect(route(""), isNull);
    expect(route("weather"), isNull);
    expect(route("timeline"), isNull);
    expect(route("progress"), isNull);
    expect(route("quote"), isNull);
    expect(route("media"), isNull);
    expect(route("search_result"), isNull);
  });

  test("displayEffectsCard compare: needs two resolvable photos", () {
    final ColorScheme cs = ColorScheme.fromSeed(seedColor: Colors.blue);
    // 纯文本对比（无图）→ 回退
    expect(
      displayEffectsCard(
        data: AgentResultData(
          cardType: "compare",
          items: <AgentResultItem>[item("A 更便宜"), item("B 更持久")],
        ),
        cs: cs,
      ),
      isNull,
    );
    // 恰好两条带图 → 双图滑杆
    final Widget? slider = displayEffectsCard(
      data: AgentResultData(
        cardType: "compare",
        items: <AgentResultItem>[
          item("左 https://img.example.com/a.jpg"),
          item("右 https://img.example.com/b.jpg"),
        ],
      ),
      cs: cs,
    );
    expect(slider.runtimeType, CompareEffectCard);
  });

  // ───────────────────────────────────────────────────────────────────
  // steps 数字步骤卡
  // ───────────────────────────────────────────────────────────────────

  testWidgets("steps card renders badges and strips step prefixes",
      (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "steps",
        title: "安装步骤",
        items: <AgentResultItem>[
          item("第1步 下载安装包"),
          item("第2步 双击运行"),
          item("第3步 完成配置"),
        ],
        footer: "有问题随时问我",
      ),
    )));
    await tester.pump();

    expect(find.byType(StepsEffectCard), findsOneWidget);
    expect(find.text("安装步骤"), findsOneWidget);
    // 「第X步」前缀被剥掉（序号由徽章表达）
    expect(find.text("下载安装包"), findsOneWidget);
    expect(find.text("双击运行"), findsOneWidget);
    expect(find.text("完成配置"), findsOneWidget);
    expect(find.text("1"), findsOneWidget);
    expect(find.text("2"), findsOneWidget);
    expect(find.text("3"), findsOneWidget);
    expect(find.text("有问题随时问我"), findsOneWidget);
    expect(find.text("第1步 下载安装包"), findsNothing);
  });

  // ───────────────────────────────────────────────────────────────────
  // metric 数据面板卡
  // ───────────────────────────────────────────────────────────────────

  testWidgets("metric card renders label-value tiles", (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "metric",
        title: "屏幕参数",
        items: <AgentResultItem>[
          item("尺寸：6.7英寸"),
          item("重量：199g"),
          item("亮度：2000nit"),
        ],
      ),
    )));
    await tester.pump();

    expect(find.byType(MetricEffectCard), findsOneWidget);
    expect(find.text("屏幕参数"), findsOneWidget);
    expect(find.text("尺寸"), findsOneWidget);
    expect(find.text("6.7英寸"), findsOneWidget);
    expect(find.text("重量"), findsOneWidget);
    expect(find.text("199g"), findsOneWidget);
    expect(find.text("亮度"), findsOneWidget);
    expect(find.text("2000nit"), findsOneWidget);
  });

  // ───────────────────────────────────────────────────────────────────
  // chips 标签胶囊墙
  // ───────────────────────────────────────────────────────────────────

  testWidgets("chips card renders pill wall", (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "chips",
        title: "你的兴趣标签",
        items: <AgentResultItem>[
          item("健身"),
          item("摄影"),
          item("烘焙"),
          item("旅行"),
          item("桌游"),
        ],
      ),
    )));
    await tester.pump();

    expect(find.byType(ChipsEffectCard), findsOneWidget);
    for (final String chip in <String>["健身", "摄影", "烘焙", "旅行", "桌游"]) {
      expect(find.text(chip), findsOneWidget);
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // fold_list 折叠列表卡
  // ───────────────────────────────────────────────────────────────────

  testWidgets("fold_list collapses long list and expands on tap",
      (WidgetTester tester) async {
    final List<AgentResultItem> items = List<AgentResultItem>.generate(
      9,
      (int i) => item("条目${i + 1}"),
    );
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(cardType: "fold_list", title: "采购清单", items: items),
    )));
    await tester.pump();

    expect(find.byType(FoldListEffectCard), findsOneWidget);
    // 折叠态：前 5 条可见，后 4 条未构建
    expect(find.text("条目1"), findsOneWidget);
    expect(find.text("条目5"), findsOneWidget);
    expect(find.text("条目6"), findsNothing);
    expect(find.text("条目9"), findsNothing);
    expect(find.text("展开全部 9 条"), findsOneWidget);

    // 点击展开
    await tester.tap(find.text("展开全部 9 条"));
    await tester.pump();
    expect(find.text("条目9"), findsOneWidget);
    expect(find.text("收起"), findsOneWidget);

    // 再点收起
    await tester.tap(find.text("收起"));
    await tester.pump();
    expect(find.text("条目9"), findsNothing);
    expect(find.text("展开全部 9 条"), findsOneWidget);
  });

  // ───────────────────────────────────────────────────────────────────
  // carousel 轮播横滑卡
  // ───────────────────────────────────────────────────────────────────

  testWidgets("carousel card renders pager with captions",
      (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "carousel",
        title: "推荐商品",
        items: <AgentResultItem>[
          item("产品A ¥299 https://img.example.com/a.jpg"),
          item("产品B ¥399 https://img.example.com/b.png"),
          item("产品C ¥499 https://img.example.com/c.webp"),
        ],
      ),
    )));
    await tester.pump();
    await tester.pump();

    expect(find.byType(CarouselEffectCard), findsOneWidget);
    expect(find.byType(PageView), findsOneWidget);
    expect(find.text("推荐商品"), findsOneWidget);
    // 首页 caption = 文本剥掉 URL
    expect(find.text("产品A ¥299"), findsOneWidget);
  });

  // ───────────────────────────────────────────────────────────────────
  // compare 双图滑杆
  // ───────────────────────────────────────────────────────────────────

  testWidgets("compare card renders slider with A/B badges",
      (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "compare",
        title: "两款口红对比",
        items: <AgentResultItem>[
          item("哑光质地 https://img.example.com/a.jpg"),
          item("水润质地 https://img.example.com/b.jpg"),
        ],
      ),
    )));
    await tester.pump();

    expect(find.byType(CompareEffectCard), findsOneWidget);
    expect(find.byType(CompareSlider), findsOneWidget);
    expect(find.text("两款口红对比"), findsOneWidget);
    // sideA/sideB 缺省时用 A/B 占位角标
    expect(find.text("A"), findsOneWidget);
    expect(find.text("B"), findsOneWidget);
  });

  testWidgets("compare slider tap opens preview for tapped side",
      (WidgetTester tester) async {
    const String urlA = "https://img.example.com/a.jpg";
    const String urlB = "https://img.example.com/b.jpg";
    await tester.pumpWidget(wrap(CompareSlider(
      urlA: urlA,
      urlB: urlB,
      labelA: "持妆前",
      labelB: "持妆后",
      cs: ColorScheme.fromSeed(seedColor: Colors.blue),
    )));
    await tester.pump();

    expect(find.text("持妆前"), findsOneWidget);
    expect(find.text("持妆后"), findsOneWidget);

    // 点击左半区（分割线初始居中）→ 预览 A 侧
    final Offset center = tester.getCenter(find.byType(CompareSlider));
    await tester.tapAt(Offset(center.dx - 60, center.dy));
    await tester.pump();
    expect(ImagePreviewLauncher.last?.url, urlA);

    // 拖动分割线后再点击右半区 → 预览 B 侧
    await tester.drag(find.byType(CompareSlider), const Offset(-40, 0));
    await tester.pump();
    await tester.tapAt(Offset(center.dx + 60, center.dy));
    await tester.pump();
    expect(ImagePreviewLauncher.last?.url, urlB);
  });

  // ───────────────────────────────────────────────────────────────────
  // media 卡 A/B 单图 → 滑杆；多图 → 保持逐行配对
  // ───────────────────────────────────────────────────────────────────

  testWidgets("media card uses slider for 1v1 A/B photos",
      (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "media",
        items: <AgentResultItem>[
          AgentResultItem(
            type: "image",
            text: "持妆8小时",
            thumbnailUrl: "https://img.example.com/a.jpg",
            side: "A",
          ),
          AgentResultItem(
            type: "image",
            text: "持妆8小时",
            thumbnailUrl: "https://img.example.com/b.jpg",
            side: "B",
          ),
        ],
        groupTitle: "颜色持久度",
        sideA: "A 口红",
        sideB: "B 口红",
      ),
    )));
    await tester.pump();

    expect(find.byType(CompareSlider), findsOneWidget);
    expect(find.text("颜色持久度"), findsOneWidget);
    expect(find.text("A 口红"), findsOneWidget);
    expect(find.text("B 口红"), findsOneWidget);
  });

  testWidgets("media card keeps row layout for multi-photo A/B",
      (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        cardType: "media",
        items: <AgentResultItem>[
          AgentResultItem(
            type: "image",
            text: "A1",
            thumbnailUrl: "https://img.example.com/a1.jpg",
            side: "A",
          ),
          AgentResultItem(
            type: "image",
            text: "A2",
            thumbnailUrl: "https://img.example.com/a2.jpg",
            side: "A",
          ),
          AgentResultItem(
            type: "image",
            text: "B1",
            thumbnailUrl: "https://img.example.com/b1.jpg",
            side: "B",
          ),
        ],
        groupTitle: "颜色持久度",
        sideA: "A 口红",
        sideB: "B 口红",
      ),
    )));
    await tester.pump();

    // 多图 A/B 不用滑杆，保持逐行配对 + 列头
    expect(find.byType(CompareSlider), findsNothing);
    expect(find.text("A 口红"), findsOneWidget);
    expect(find.text("B 口红"), findsOneWidget);
  });

  // ───────────────────────────────────────────────────────────────────
  // 兜底：无 cardType 时不受影响
  // ───────────────────────────────────────────────────────────────────

  testWidgets("generic card unchanged without cardType", (WidgetTester tester) async {
    await tester.pumpWidget(wrap(AgentResultCard(
      data: AgentResultData(
        title: "已完成的任务",
        items: <AgentResultItem>[
          item("买菜", type: "check"),
          item("取快递", type: "check"),
          item("交水电费", type: "check"),
        ],
      ),
    )));
    await tester.pump();

    expect(find.text("已完成的任务"), findsOneWidget);
    expect(find.text("买菜"), findsOneWidget);
    expect(find.byType(StepsEffectCard), findsNothing);
    expect(find.byType(CompareSlider), findsNothing);
  });
}
