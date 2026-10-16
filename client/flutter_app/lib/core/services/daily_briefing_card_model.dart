/// 今日简报悬浮窗卡片内容模型（纯逻辑，可单测）。
///
/// 服务端 `GET /api/morning-briefing?format=narration` 返回
/// `{ narrationText, briefing }`；本文件把结构化 briefing 组装成
/// WebView 悬浮窗（features/briefing/daily_briefing_window.dart）所需的内容。
class DailyBriefingStat {
  const DailyBriefingStat({required this.count, required this.label});

  final int count;
  final String label;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "count": count,
        "label": label,
      };
}

class DailyBriefingCardContent {
  const DailyBriefingCardContent({
    required this.greeting,
    required this.meta,
    required this.script,
    required this.stats,
  });

  /// 问候语，如「早上好」。
  final String greeting;

  /// 元信息行，如「9月10日 周四」。
  final String meta;

  /// 口播稿正文（TTS 与卡片共用同一份文本）。
  final String script;

  /// 统计行（最多 3 项，0 值项省略）。
  final List<DailyBriefingStat> stats;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "greeting": greeting,
        "meta": meta,
        "script": script,
        "stats": stats.map((DailyBriefingStat s) => s.toMap()).toList(),
      };
}

const List<String> _kWeekdayLabels = <String>[
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

/// 按小时返回问候语（与悬浮窗顶行「早上好」对齐）。
/// 简报只在早上固定时段播报，问候固定为「早上好」。
String dailyBriefingGreeting([DateTime? now]) {
  return "早上好";
}

/// 「9月10日 周四」日期段。
String dailyBriefingDateLabel(DateTime now) {
  return "${now.month}月${now.day}日 ${_kWeekdayLabels[now.weekday - 1]}";
}

/// 从服务端 briefing JSON 组装悬浮窗卡片内容。
///
/// [narrationText] 为口播稿；缺失时退化为 meta 行本身（保证卡片仍有内容）。
/// 2026-10-16 天气/穿衣迁出简报（搬往睡前提醒 evening.digest），meta 收敛为纯日期。
DailyBriefingCardContent buildDailyBriefingCard({
  required Map<String, dynamic> briefing,
  String? narrationText,
  String appellation = "",
  DateTime? now,
}) {
  final DateTime time = now ?? DateTime.now();
  final String dateLabel = dailyBriefingDateLabel(time);
  final String meta = dateLabel;

  int listLen(String key) {
    final Object? raw = briefing[key];
    return raw is List ? raw.length : 0;
  }

  int todoPendingCount() {
    final Object? rawTodo = briefing["todoFollowups"];
    if (rawTodo is! Map) return 0;
    final Object? rawPending = rawTodo["pending"];
    return rawPending is List ? rawPending.length : 0;
  }

  final List<DailyBriefingStat> stats = <DailyBriefingStat>[
    DailyBriefingStat(count: listLen("todaySchedule"), label: "日程"),
    DailyBriefingStat(count: todoPendingCount(), label: "待办"),
    DailyBriefingStat(count: listLen("pendingNotes"), label: "笔记"),
    if (listLen("interestHits") > 0)
      DailyBriefingStat(count: listLen("interestHits"), label: "热搜"),
    if (listLen("upcomingImportantDays") > 0)
      DailyBriefingStat(count: listLen("upcomingImportantDays"), label: "纪念日"),
  ].where((DailyBriefingStat s) => s.count > 0).toList();

  final String script = (narrationText ?? "").trim();
  // 称呼（注册 displayName，如「王先生」）：非空时问候带称呼
  final String trimmedAppellation = appellation.trim();
  final String baseGreeting = dailyBriefingGreeting(time);

  return DailyBriefingCardContent(
    greeting: trimmedAppellation.isEmpty
        ? baseGreeting
        : "$baseGreeting，$trimmedAppellation",
    meta: meta,
    script: script,
    stats: stats,
  );
}
