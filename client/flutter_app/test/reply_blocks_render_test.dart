import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/agent_result_card.dart" show MediaInlineRow;
import "package:nextbot/features/chat/message_body_renderer.dart";

/// 回复信封块（reply blocks）渲染测试：
/// blocks 分支优先于正文标记解析；card 块直读 AgentResultPayload JSON 建卡；
/// 无 blocks 时回退既有正文解析（历史消息兼容），两端渲染等价。

ChatMessage messageWithBlocks(List<Map<String, dynamic>>? blocks) => ChatMessage(
      messageId: "m1",
      sessionId: "s1",
      role: "assistant",
      text: "（正文文本，仅在无 blocks 时作为解析来源）",
      timestamp: DateTime.now(),
      replyBlocks: blocks,
    );

Future<void> pumpBody(WidgetTester tester, ChatMessage message) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: buildMessageBody(
            context,
            Theme.of(context).colorScheme,
            message,
            isUser: false,
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("reply blocks: text+card+text 序列按块渲染", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {"type": "text", "text": "好的，耳机已下单，预计周六送达。"},
        {
          "type": "card",
          "card": {
            "title": "本周末行程已为你规划：",
            "items": [
              {"type": "num", "text": "周六上午：探店"},
              {"type": "num", "text": "周六下午：健身"},
            ],
            "footer": "需要调整吗？",
            "cardType": "",
          },
        },
        {"type": "text", "text": "需要调整吗？"},
      ]),
    );

    expect(find.text("好的，耳机已下单，预计周六送达。"), findsOneWidget);
    expect(find.text("本周末行程已为你规划："), findsOneWidget);
    expect(find.text("周六上午：探店"), findsOneWidget);
    // 出现两次：一次是追问文本块，一次是卡片 footer（RichText，需 findRichText）
    expect(find.textContaining("需要调整吗？", findRichText: true), findsNWidgets(2));
    // 正文文本不渲染（blocks 优先，text 仅为事实源备份）
    expect(find.text("（正文文本，仅在无 blocks 时作为解析来源）"), findsNothing);
  });

  testWidgets("reply blocks: 带 actions 的卡渲染为选择型卡片", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {
          "type": "card",
          "card": {
            "title": "要继续吗？",
            "items": [
              {"type": "num", "text": "条目"},
            ],
            "actions": [
              // 显式 <String, dynamic>：字面量 {} 在 dynamic 上下文会推断为
              // Map<dynamic,dynamic>；生产路径经 json.decode 天然是 String 键
              {"id": "keep", "label": "就这样", "variant": "primary", "payload": <String, dynamic>{}},
            ],
          },
        },
      ]),
    );

    expect(find.text("要继续吗？"), findsOneWidget);
    expect(find.text("就这样"), findsOneWidget);
  });

  testWidgets("无 blocks → 回退正文标记解析（历史消息兼容）", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m2",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n[AGENT_RESULT_CARD_START]\n"
            '{"title":"已有卡片","items":[{"type":"check","text":"条目一"},'
            '{"type":"check","text":"条目二"},{"type":"check","text":"条目三"}],"footer":""}\n'
            "[AGENT_RESULT_CARD_END]",
        timestamp: DateTime.now(),
        replyBlocks: null,
      ),
    );

    expect(find.text("已有卡片"), findsOneWidget);
    expect(find.textContaining("前导说明"), findsOneWidget);
    expect(find.textContaining("AGENT_RESULT_CARD_START"), findsNothing);
  });

  testWidgets("无 blocks 回退路径：多卡按位置渲染——总览卡置首、正文居中、行程卡收尾", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m3",
        sessionId: "s1",
        role: "assistant",
        text: "[RENDER_AS:structured]\n"
            "[AGENT_RESULT_CARD_START]\n"
            '{"title":"印尼7天怎么排","cardType":"fold_list","items":'
            '[{"type":"num","text":"Day 1 落地巴厘岛"},{"type":"num","text":"Day 2 乌布一天"}],'
            '"footer":"7 天就这个骨架。"}\n'
            "[AGENT_RESULT_CARD_END]\n"
            "## 🏨 住哪儿\n预算充足的话先乌布后海景，节奏刚好。\n"
            "[AGENT_RESULT_CARD_START]\n"
            '{"title":"巴厘岛5日游·海景/泳池/休闲","cardType":"travel_itinerary","autoOpen":false,'
            '"items":[{"type":"num","text":"Day 1 · 2026-09-16：AYANA Resort 等"}],"footer":""}\n'
            "[AGENT_RESULT_CARD_END]",
        timestamp: DateTime.now(),
        replyBlocks: null,
      ),
    );

    // 三段都在：总览卡、正文、行程卡
    expect(find.text("印尼7天怎么排"), findsOneWidget);
    expect(find.textContaining("住哪儿"), findsOneWidget);
    expect(find.text("巴厘岛5日游·海景/泳池/休闲"), findsOneWidget);
    // 模型自带的 RENDER_AS 声明行剥掉，不漏进正文
    expect(find.textContaining("RENDER_AS"), findsNothing);
    // 位置：总览卡在正文之上、行程卡在正文之下（置首 + 收尾）
    final double overviewTop = tester.getTopLeft(find.text("印尼7天怎么排")).dy;
    final double proseTop = tester.getTopLeft(find.textContaining("住哪儿")).dy;
    final double travelTop = tester.getTopLeft(find.text("巴厘岛5日游·海景/泳池/休闲")).dy;
    expect(overviewTop, lessThan(proseTop));
    expect(proseTop, lessThan(travelTop));
  });

  testWidgets("无 blocks 回退路径：JSON 损坏的卡片块静默跳过，不漏脏 JSON", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m4",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n[AGENT_RESULT_CARD_START]\n{broken json\n[AGENT_RESULT_CARD_END]\n"
            "收尾说明。",
        timestamp: DateTime.now(),
        replyBlocks: null,
      ),
    );

    expect(find.textContaining("前导说明"), findsOneWidget);
    expect(find.textContaining("收尾说明"), findsOneWidget);
    expect(find.textContaining("broken json"), findsNothing);
    expect(find.textContaining("AGENT_RESULT_CARD_START"), findsNothing);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v2 统一渲染：卡片与照片同屏（blocks 含 media 块 / 历史回放 / v1 blocks 回退）
  // ───────────────────────────────────────────────────────────────────────────

  const String cardMarkerBlock = "[AGENT_RESULT_CARD_START]\n"
      '{"title":"泳池别墅怎么选","items":[{"type":"check","text":"乌布雨林"}],'
      '"footer":""}\n'
      "[AGENT_RESULT_CARD_END]";

  final List<Map<String, dynamic>> mediaCards = <Map<String, dynamic>>[
    {"type": "image", "title": "乌布泳池别墅", "thumbnailUrl": "https://example.com/1.jpg"},
  ];

  testWidgets("v2 blocks：text+card+media 序列——卡片与照片同屏渲染", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m-v2",
        sessionId: "s1",
        role: "assistant",
        text: "（正文文本，v2 blocks 下不参与渲染）",
        timestamp: DateTime.now(),
        replyBlocks: <Map<String, dynamic>>[
          {"type": "text", "text": "先看这家。"},
          {"type": "card", "card": <String, dynamic>{
            "title": "泳池别墅怎么选",
            "items": <dynamic>[
              {"type": "check", "text": "乌布雨林"},
            ],
            "footer": "",
            "cardType": "",
          }},
          {"type": "media", "cards": mediaCards},
          {"type": "text", "text": "预算充足就住乌布。"},
        ],
      ),
    );

    expect(find.text("先看这家。"), findsOneWidget);
    expect(find.text("泳池别墅怎么选"), findsOneWidget);
    expect(find.text("预算充足就住乌布。"), findsOneWidget);
    expect(find.byType(MediaInlineRow), findsOneWidget);
  });

  testWidgets("历史回放：正文卡片标记 + renderBlocks 媒体 → 卡片与照片都渲染（不互相挤掉）", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m-history",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n$cardMarkerBlock\n\n预算充足就住乌布。",
        timestamp: DateTime.now(),
        replyBlocks: null,
        renderBlocks: <Map<String, dynamic>>[
          {"type": "text", "text": "前导说明。\n$cardMarkerBlock"},
          {"type": "media", "cards": mediaCards},
          {"type": "text", "text": "预算充足就住乌布。"},
        ],
      ),
    );

    expect(find.text("泳池别墅怎么选"), findsOneWidget);
    expect(find.textContaining("前导说明"), findsOneWidget);
    expect(find.text("预算充足就住乌布。"), findsOneWidget);
    expect(find.byType(MediaInlineRow), findsOneWidget);
  });

  testWidgets("v1 blocks（无媒体块）+ 消息带照片 → 回退统一路径，照片不丢", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m-v1",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n$cardMarkerBlock",
        timestamp: DateTime.now(),
        replyBlocks: <Map<String, dynamic>>[
          {"type": "text", "text": "前导说明。"},
          {"type": "card", "card": <String, dynamic>{
            "title": "泳池别墅怎么选",
            "items": <dynamic>[
              {"type": "check", "text": "乌布雨林"},
            ],
            "footer": "",
            "cardType": "",
          }},
        ],
        renderBlocks: <Map<String, dynamic>>[
          {"type": "text", "text": "前导说明。\n$cardMarkerBlock"},
          {"type": "media", "cards": mediaCards},
        ],
      ),
    );

    expect(find.text("泳池别墅怎么选"), findsOneWidget);
    expect(find.byType(MediaInlineRow), findsOneWidget);
  });

  testWidgets("mediaCards-only（无 renderBlocks）→ 编组补尾渲染（老服务端/离线重放兼容）", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m-legacy",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n$cardMarkerBlock",
        timestamp: DateTime.now(),
        replyBlocks: null,
        mediaCards: mediaCards,
      ),
    );

    expect(find.text("泳池别墅怎么选"), findsOneWidget);
    expect(find.byType(MediaInlineRow), findsOneWidget);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 结构化 markdown 文本段（2026-10-08）：blocks 文本段走结构化渲染器，
  // 标题/表格/引用块级渲染有区分度，不再以 ### / |---| / > 源码符号裸露。
  // ───────────────────────────────────────────────────────────────────────────

  testWidgets("reply blocks: 结构化 markdown 文本段按块级渲染（表格/标题不裸露）", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {
          "type": "text",
          "text": "### 方案 A · 自然光线（推荐）\n\n"
              "| 时间 | 安排 |\n"
              "|---|---|\n"
              "| 08:30 | 兴义市区出发 |\n"
              "| 09:00 | 万峰林景区 |\n\n"
              "> 门票以景区当天公告为准",
        },
      ]),
    );

    // markdown 源码符号不裸露（此前 ### / |---| / > 全部直排为纯文本）
    expect(find.textContaining("###"), findsNothing);
    expect(find.textContaining("|---|"), findsNothing);
    expect(find.textContaining("| 时间 |"), findsNothing);
    // 内容仍在：标题、表格单元格、引用文字
    expect(find.textContaining("方案 A", findRichText: true), findsWidgets);
    expect(find.textContaining("08:30", findRichText: true), findsWidgets);
    expect(find.textContaining("万峰林景区", findRichText: true), findsWidgets);
    expect(find.textContaining("门票以景区当天公告为准", findRichText: true), findsWidgets);
  });

  testWidgets("reply blocks: 纯叙述文本段自动回退内联排版（无结构化包装）", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {"type": "text", "text": "好的，耳机已下单，预计周六送达。"},
      ]),
    );

    expect(find.textContaining("耳机已下单", findRichText: true), findsWidgets);
    // 纯叙述无块级元素：不出现标题/表格渲染痕迹
    expect(find.textContaining("###"), findsNothing);
    expect(find.textContaining("|"), findsNothing);
  });
}
