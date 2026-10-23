import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/assistant_brief_message.dart";
import "package:nextbot/features/chat/data_brief_message.dart";
import "package:nextbot/features/chat/display_effects/chips_effect_card.dart";
import "package:nextbot/features/chat/display_effects/comparison_table_effect_card.dart";
import "package:nextbot/features/chat/display_effects/fold_list_effect_card.dart";
import "package:nextbot/features/chat/display_effects/metric_effect_card.dart";
import "package:nextbot/features/chat/display_effects/steps_effect_card.dart";
import "package:nextbot/features/chat/image_result_message.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";
import "package:nextbot/features/chat/structured_assistant_message_body.dart";

/// 展示形态客户端覆盖回归（与服务端 test/render-forms-coverage.test.ts 配对）。
///
/// 每种形态用一条独立用例验证：带标记的 finalText 经 buildMessageBody
/// 生产路径渲染后，能落到正确的展示组件。哪个用例绿了，对应形态在客户端就是可达的。

ChatMessage assistantMessage(String text) => ChatMessage(
      messageId: "m-test",
      sessionId: "s1",
      role: "assistant",
      text: text,
      timestamp: DateTime.now(),
    );

Future<void> pumpBody(WidgetTester tester, String text) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: SingleChildScrollView(
            child: buildMessageBody(
              context,
              Theme.of(context).colorScheme,
              assistantMessage(text),
              isUser: false,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  // ─────────────────────────────────────────────────────────────────
  // RENDER_AS 整体形态（服务端 L2 hint / 专项注入）
  // ─────────────────────────────────────────────────────────────────

  testWidgets("形态 brief：[RENDER_AS:brief] → 每日简报组件", (tester) async {
    await pumpBody(
      tester,
      "[RENDER_AS:brief]\n"
          "【今日简报】\n"
          "☀️ 天气：晴 26°C\n"
          "�📌 日程：10:00 例会\n"
          "�📰 资讯：新能源汽车补贴新政发布\n"
          "⚠️ 提醒：下午 3 点取快递",
    );
    expect(find.byType(AssistantBriefMessage), findsOneWidget);
  });

  testWidgets("形态 structured：[RENDER_AS:structured] → 结构化正文 + 打字机光标",
      (tester) async {
    await pumpBody(
      tester,
      "[RENDER_AS:structured]\n"
          "## 租房注意事项\n\n签约前核对房产证。\n\n- 水电费结清方式\n- 维修责任划分",
    );
    expect(find.byType(StructuredAssistantMessageBody), findsOneWidget);
    expect(find.text("租房注意事项"), findsOneWidget);
  });

  testWidgets("形态 image_result：照片卡 + 每张各自的一句话描述（真实设计）",
      (tester) async {
    const String payload =
        '{"items":[{"url":"/agent/images/a/1.jpg","caption":"书桌上的一只橘猫，室内书房"},{"url":"/agent/images/a/2.jpg","caption":"外滩夜景，人流如织"}]}';
    await pumpBody(
      tester,
      "[RENDER_AS:image_result]\n"
          "[IMAGE_RESULT_START]$payload[IMAGE_RESULT_END]\n"
          "照片里是一只橘猫，趴在键盘上睡觉。",
    );
    expect(find.byType(ImageResultMessage), findsOneWidget);
    // 每张照片下方只有对当前照片的简单介绍（内容 + 场景/地点）
    expect(find.text("书桌上的一只橘猫，室内书房"), findsOneWidget);
    expect(find.text("外滩夜景，人流如织"), findsOneWidget);
    // 照片卡模式下不再渲染「结论 + 要点」散文
    expect(find.textContaining("趴在键盘上睡觉"), findsNothing);
  });

  testWidgets("形态 data_brief：KPI 快报组件（结论 + 瓦片 + 详情）", (tester) async {
    const String payload =
        '{"conclusion":"今日A股收涨","kpis":[{"label":"上证指数","value":"3245.6 点","change":"+1.2%"},{"label":"两市成交额","value":"9800 亿元"}],"restText":"盘面上半导体板块领涨。"}';
    await pumpBody(
      tester,
      "[RENDER_AS:data_brief]\n[DATA_BRIEF_START]$payload[DATA_BRIEF_END]",
    );
    expect(find.byType(DataBriefMessage), findsOneWidget);
    expect(find.text("今日A股收涨"), findsOneWidget);
    expect(find.text("上证指数"), findsOneWidget);
    expect(find.text("3245.6 点"), findsOneWidget);
  });

  // ─────────────────────────────────────────────────────────────────
  // 特效卡（display_effects 七种）经正文标记路径
  // ─────────────────────────────────────────────────────────────────

  testWidgets("特效卡 steps：模型声明卡 → 步骤链组件", (tester) async {
    await pumpBody(
      tester,
      "好的，步骤如下：\n"
          "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"steps","title":"软件安装步骤","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"下载安装包"},{"type":"num","text":"运行安装程序"},{"type":"num","text":"完成初始化"}],'
          '"footer":"全程约5分钟","actions":[],"speak":"high","cardId":"card_t1"}\n'
          "[AGENT_RESULT_CARD_END]\n"
          "哪一步有问题随时问我。",
    );
    expect(find.byType(StepsEffectCard), findsOneWidget);
    expect(find.text("软件安装步骤"), findsOneWidget);
    expect(find.text("下载安装包"), findsOneWidget);
  });

  testWidgets("特效卡 metric：标签数值 → 数据面板", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"metric","title":"屏幕参数","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"尺寸：6.7英寸"},{"type":"num","text":"重量：199g"},{"type":"num","text":"亮度：2000nit"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t2"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.byType(MetricEffectCard), findsOneWidget);
    expect(find.text("重量"), findsOneWidget);
    expect(find.text("199g"), findsOneWidget);
  });

  testWidgets("特效卡 comparison_table：A/B 对比双栏卡", (tester) async {
    await pumpBody(
      tester,
      "两个方案对比好了：\n"
          "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"comparison_table","title":"方案怎么选","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"价格便宜","side":"A","sideLabel":"地铁房"},'
          '{"type":"num","text":"通勤10分钟","side":"A","sideLabel":"地铁房"},'
          '{"type":"num","text":"价格贵800","side":"B","sideLabel":"公司旁"},'
          '{"type":"num","text":"通勤5分钟","side":"B","sideLabel":"公司旁"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t3"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.byType(ComparisonTableEffectCard), findsOneWidget);
    // 表头：payload 未带 sideA/sideB 时用缺省 A/B；单元格为剥掉标签后的正文
    expect(find.text("A"), findsOneWidget);
    expect(find.text("B"), findsOneWidget);
    expect(find.text("价格便宜"), findsOneWidget);
    expect(find.text("价格贵800"), findsOneWidget);
  });

  testWidgets("特效卡 chips：标签胶囊墙", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"chips","title":"相关话题","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"健身"},{"type":"num","text":"摄影"},{"type":"num","text":"烘焙"},{"type":"num","text":"旅行"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t4"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.byType(ChipsEffectCard), findsOneWidget);
    expect(find.text("健身"), findsOneWidget);
    expect(find.text("旅行"), findsOneWidget);
  });

  testWidgets("特效卡 fold_list：长清单折叠展开", (tester) async {
    final StringBuffer items = StringBuffer();
    for (int i = 1; i <= 9; i++) {
      items.write('{"type":"num","text":"条目$i"},');
    }
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"fold_list","title":"采购清单","avatar":"NB","avatarStyle":"default",'
          '"items":[${items.toString().substring(0, items.length - 1)}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t5"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.byType(FoldListEffectCard), findsOneWidget);
    expect(find.text("条目1"), findsOneWidget);
    expect(find.text("展开全部 9 条"), findsOneWidget);
  });

  // ─────────────────────────────────────────────────────────────────
  // 通用/专用结果卡（AgentResultCard 私有形态，按文本断言）
  // ─────────────────────────────────────────────────────────────────

  testWidgets("结果卡 timeline：时间轴节点", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"timeline","title":"明日安排","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"09:30 部门例会"},{"type":"num","text":"14:00 客户拜访"},{"type":"num","text":"18:30 健身"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t6"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.text("明日安排"), findsOneWidget);
    expect(find.textContaining("部门例会"), findsOneWidget);
    expect(find.textContaining("客户拜访"), findsOneWidget);
  });

  testWidgets("结果卡 progress：进度条形态", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"progress","title":"装修进度","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"水电改造 90%"},{"type":"num","text":"瓦工贴砖 60%"},{"type":"num","text":"木工进场 30%"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t7"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.text("装修进度"), findsOneWidget);
    expect(find.textContaining("水电改造"), findsOneWidget);
  });

  testWidgets("结果卡 quote：引用/金句卡", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"quote","title":"种一棵树最好的时间是十年前，其次是现在。","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"《禅与摩托车维修艺术》"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t8"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.textContaining("种一棵树"), findsOneWidget);
  });

  testWidgets("结果卡 search_result：可点击搜索结果列表", (tester) async {
    await pumpBody(
      tester,
      "帮你查到了：\n"
          "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"search_result","title":"搜索结果","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"鼓浪屿两日游攻略: 经典路线","url":"https://example.com/a"},'
          '{"type":"num","text":"厦门美食地图: 八市全收录","url":"https://example.com/b"}],'
          '"footer":"共 2 条结果","actions":[],"speak":"high","cardId":"card_t9"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.text("搜索结果"), findsOneWidget);
    expect(find.textContaining("鼓浪屿两日游攻略"), findsOneWidget);
    expect(find.textContaining("共 2 条结果"), findsOneWidget);
  });

  testWidgets("专用卡 weather：天气实况卡", (tester) async {
    await pumpBody(
      tester,
      "出门记得带伞。\n"
          "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"weather","title":"上海 天气实况","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"中雨 26°C"},{"type":"num","text":"湿度 88%"}],'
          '"footer":"湿度大，穿速干衣物","actions":[],"speak":"high","cardId":"card_t10"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.text("上海 天气实况"), findsOneWidget);
    expect(find.text("中雨 26°C"), findsOneWidget);
  });

  testWidgets("专用卡 wallet / schedule：钱包与日程", (tester) async {
    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"wallet","title":"钱包余额","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"12345.67 CNY"}],"footer":"","actions":[],"speak":"high","cardId":"card_t11"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    expect(find.text("钱包余额"), findsOneWidget);

    await pumpBody(
      tester,
      "[AGENT_RESULT_CARD_START]\n"
          '{"cardType":"schedule","title":"日程安排","avatar":"NB","avatarStyle":"default",'
          '"items":[{"type":"num","text":"09-16 09:30 部门例会"},{"type":"num","text":"09-16 14:00 牙医复诊"}],'
          '"footer":"","actions":[],"speak":"high","cardId":"card_t12"}\n'
          "[AGENT_RESULT_CARD_END]",
    );
    // 上一棵树已被替换，当前只渲染日程卡
    expect(find.text("日程安排"), findsOneWidget);
    expect(find.textContaining("部门例会"), findsOneWidget);
  });

  // ─────────────────────────────────────────────────────────────────
  // Markdown 基础形态（structured 正文自研渲染器）
  // ─────────────────────────────────────────────────────────────────

  testWidgets("markdown：标题/引用块/表格/代码块渲染", (tester) async {
    await pumpBody(
      tester,
      "[RENDER_AS:structured]\n"
          "## 通勤方案\n\n> 优先推荐地铁，风雨无阻。\n\n"
          "| 方案 | 价格 | 耗时 |\n| --- | --- | --- |\n| 地铁 | 5元 | 40分钟 |\n| 打车 | 45元 | 25分钟 |\n\n"
          "```python\nprint('hello')\n```\n",
    );
    // 标题经 RichText 渲染（find.text 不命中），用 findRichText 匹配
    expect(find.textContaining("通勤方案", findRichText: true), findsOneWidget);
    expect(find.textContaining("优先推荐地铁", findRichText: true), findsOneWidget);
    expect(find.textContaining("45元", findRichText: true), findsOneWidget);
    expect(find.textContaining("print", findRichText: true), findsOneWidget);
  });

  // ─────────────────────────────────────────────────────────────────
  // 纯文本守卫
  // ─────────────────────────────────────────────────────────────────

  testWidgets("纯文本：无标记回复不产生任何卡片组件", (tester) async {
    await pumpBody(tester, "好呀，那就周六见！到时候我带点水果过去。");
    expect(find.byType(StepsEffectCard), findsNothing);
    expect(find.byType(MetricEffectCard), findsNothing);
    expect(find.byType(ChipsEffectCard), findsNothing);
    expect(find.textContaining("周六见"), findsOneWidget);
  });
}
