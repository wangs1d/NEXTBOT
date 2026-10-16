import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/services/daily_briefing_card_model.dart";

void main() {
  final DateTime morning = DateTime(2026, 9, 10, 8, 47); // 周四

  final Map<String, dynamic> fullBriefing = <String, dynamic>{
    "date": "2026-09-10",
    "todaySchedule": <dynamic>[
      <String, dynamic>{"id": "s1", "title": "产品评审会", "time": "09:30"},
      <String, dynamic>{"id": "s2", "title": "1:1", "time": "14:00"},
      <String, dynamic>{"id": "s3", "title": "周迭代演示", "time": "16:30"},
    ],
    "pendingNotes": <dynamic>[
      <String, dynamic>{"id": "n1", "title": "评审材料终稿"},
    ],
    "interestHits": <dynamic>[
      <String, dynamic>{"interest": "AI", "title": "xxx", "platform": "weibo"},
    ],
    "agentGreeting": "早上好！",
  };

  test("问候语固定为早安（简报只在早上播报）", () {
    expect(dailyBriefingGreeting(DateTime(2026, 9, 10, 8)), "早上好");
    expect(dailyBriefingGreeting(DateTime(2026, 9, 10, 14)), "早上好");
    expect(dailyBriefingGreeting(DateTime(2026, 9, 10, 20)), "早上好");
    expect(dailyBriefingGreeting(DateTime(2026, 9, 10, 2)), "早上好");
  });

  test("日期标签：月日 + 周几", () {
    expect(dailyBriefingDateLabel(morning), "9月10日 周四");
  });

  test("组装：问候/元信息/口播稿/统计，0 值统计省略，超过 3 项截断在窗口侧", () {
    final DailyBriefingCardContent card = buildDailyBriefingCard(
      briefing: fullBriefing,
      narrationText: "今天有三个会。",
      now: morning,
    );

    // 2026-10-16 天气/穿衣迁出简报：meta 收敛为纯日期
    expect(card.meta, "9月10日 周四");
    expect(card.script, "今天有三个会。");

    expect(card.stats.length, 3);
    expect(card.stats[0].label, "日程");
    expect(card.stats[0].count, 3);
    expect(card.stats[1].label, "笔记");
    expect(card.stats[1].count, 1);
    expect(card.stats[2].label, "热搜");
    expect(card.stats[2].count, 1);
  });

  test("称呼：非空时问候带称呼，空白串退化为无称呼", () {
    final DailyBriefingCardContent withName = buildDailyBriefingCard(
      briefing: fullBriefing,
      narrationText: "测试",
      appellation: "王先生",
      now: morning,
    );
    expect(withName.greeting, "早上好，王先生");

    final DailyBriefingCardContent blankName = buildDailyBriefingCard(
      briefing: fullBriefing,
      narrationText: "测试",
      appellation: "   ",
      now: morning,
    );
    expect(blankName.greeting, "早上好");
  });

  test("无数据：meta 退化为纯日期，统计行为空，口播稿可为空", () {
    final DailyBriefingCardContent card = buildDailyBriefingCard(
      briefing: <String, dynamic>{},
      narrationText: null,
      now: morning,
    );
    expect(card.meta, "9月10日 周四");
    expect(card.stats, isEmpty);
    expect(card.script, isEmpty);
  });

  test("toMap 覆盖悬浮窗通道所需全部字段", () {
    final DailyBriefingCardContent card = buildDailyBriefingCard(
      briefing: fullBriefing,
      narrationText: "测试",
      now: morning,
    );
    final Map<String, dynamic> map = card.toMap();
    expect(map.keys, containsAll(<String>["greeting", "meta", "script", "stats"]));
    expect((map["stats"] as List<dynamic>).first, isA<Map<String, dynamic>>());
  });
}
