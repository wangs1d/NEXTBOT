import "package:flutter/material.dart";

/// 明日速览卡（contentType="evening_digest"，2026-10-22 定调；原名「睡前备忘」，
/// 2026-10-24 因内容实为明日信息而改名，载荷与事件名未变）。
///
/// 晚间 digest（evening.digest 事件）不再渲染纯文本气泡：本卡是每晚对
/// 「明天要做的事」的简短汇报——narrationText（agent 口吻睡前文案）为
/// 卡顶部的「agent 说的话」段落，下面接结构化的明日信息块（行程 / 天气
/// 与穿衣 / 截止事项）。整卡恒展开，无折叠展开（2026-10-22 用户定稿：
/// 不做今日回顾，不做折叠）。
///
/// 载荷与服务端 [EveningDigest] 同构（ws EveningDigest payload.digest）：
///   - narrationText: agent 口吻睡前文案
///   - date: 今日本地日期键（YYYY-MM-DD），明日标签由此推导
///   - tomorrowSchedule: [{ id, title, time?, advanceNotes?: string[] }]
///   - tomorrowWeather: { text, minC, maxC, rainPct, alerts[] } | null
///   - outfitTip: string | null
class EveningDigestCard extends StatelessWidget {
  const EveningDigestCard({super.key, required this.digest});

  /// 月黄：实心月亮与其底盘同色系，明暗主题下都不依赖主题色（否则夜里会变成冷紫）
  static const Color _moonColor = Color(0xFFF6C445);

  final Map<String, dynamic> digest;

  List<Map<String, dynamic>> _readMapList(String key) {
    final Object? raw = digest[key];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return <Map<String, dynamic>>[
      for (final Object? x in raw)
        if (x is Map) x.cast<String, dynamic>(),
    ];
  }

  /// 明日日期标签（从 digest.date = 今日本地键 +1 天推导）：「10月23日 周五」
  String? _tomorrowLabel() {
    final String dateKey = digest["date"]?.toString() ?? "";
    final List<String> parts = dateKey.split("-");
    if (parts.length != 3) return null;
    final int? y = int.tryParse(parts[0]);
    final int? mo = int.tryParse(parts[1]);
    final int? da = int.tryParse(parts[2]);
    if (y == null || mo == null || da == null) return null;
    final DateTime tomorrow = DateTime(y, mo, da + 1);
    const List<String> week = <String>["一", "二", "三", "四", "五", "六", "日"];
    return "${tomorrow.month}月${tomorrow.day}日 周${week[tomorrow.weekday - 1]}";
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final bool isLight = theme.brightness == Brightness.light;

    final String narration =
        (digest["narrationText"]?.toString() ?? "").trim();
    final List<Map<String, dynamic>> schedule = _readMapList("tomorrowSchedule");
    // DDL（服务端 DdlRadarService 产出）：tier=tomorrow 或 today+overdue
    final List<Map<String, dynamic>> deadlines =
        _readMapList("deadlineReminders");
    final Object? rawWeather = digest["tomorrowWeather"];
    final Map<String, dynamic> weather =
        rawWeather is Map ? rawWeather.cast<String, dynamic>() : const <String, dynamic>{};
    final String outfitTip = (digest["outfitTip"]?.toString() ?? "").trim();
    final String? tomorrowLabel = _tomorrowLabel();

    return Card(
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.5)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // ── 头部：月亮图标 + 「明日速览」+ 明日日期 ──
            Row(
              children: <Widget>[
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: _moonColor.withValues(alpha: 0.16),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.bedtime,
                    size: 17,
                    color: _moonColor,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    "明日速览",
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (tomorrowLabel != null)
                  Text(
                    "明天 $tomorrowLabel",
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: cs.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            // ── agent 睡前文案（人话段，最抢眼的位置留给它）──
            if (narration.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                narration,
                style: theme.textTheme.bodyMedium?.copyWith(height: 1.55),
              ),
            ],
            // ── DDL：明天要交的 / 今天已过点的（三级梯度 L2 档）──
            // 比行程更硬，放在行程前面；琥珀与超支条同色系（不取 tertiaryContainer）。
            if (deadlines.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              _SectionHeader(
                icon: Icons.assignment_late_outlined,
                text: "要交的",
                theme: theme,
              ),
              const SizedBox(height: 6),
              for (final Map<String, dynamic> d in deadlines)
                Padding(
                  padding: const EdgeInsets.only(top: 7),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: <Widget>[
                      Icon(
                        d["overdue"] == true
                            ? Icons.error_outline
                            : Icons.schedule_outlined,
                        size: 15,
                        color: d["overdue"] == true
                            ? (isLight
                                ? const Color(0xFFB3261E)
                                : const Color(0xFFF2B8B5))
                            : (isLight
                                ? const Color(0xFF8A5A00)
                                : const Color(0xFFE8C476)),
                      ),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          d["title"]?.toString() ?? "",
                          style: theme.textTheme.bodyMedium?.copyWith(
                            height: 1.35,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _deadlineWhen(d),
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: d["overdue"] == true
                              ? (isLight
                                  ? const Color(0xFFB3261E)
                                  : const Color(0xFFF2B8B5))
                              : cs.onSurfaceVariant,
                          fontFeatures: const <FontFeature>[
                            FontFeature.tabularFigures(),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
            // ── 明日行程（汇报主体）──
            if (schedule.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              _SectionHeader(
                icon: Icons.event_note_outlined,
                text: "明天的行程",
                theme: theme,
              ),
              const SizedBox(height: 6),
              for (final Map<String, dynamic> s in schedule)
                Padding(
                  padding: const EdgeInsets.only(top: 7),
                  child: _ScheduleItem(item: s, theme: theme),
                ),
            ],
            // ── 明日天气 + 穿衣 ──
            if (weather.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              _SectionHeader(
                icon: Icons.cloud_outlined,
                text: "明天天气",
                theme: theme,
              ),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: <Widget>[
                  Text(
                    _tempLabel(weather),
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _weatherLine(weather),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
              if ((weather["alerts"] as List?)?.isNotEmpty == true) ...<Widget>[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: <Widget>[
                    for (final Object? a in weather["alerts"]! as List)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: cs.errorContainer,
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          "${a ?? ""}预警",
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: cs.onErrorContainer,
                          ),
                        ),
                      ),
                  ],
                ),
              ],
              if (outfitTip.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(Icons.checkroom_outlined,
                        size: 15, color: cs.onSurfaceVariant),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        outfitTip,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurfaceVariant,
                          height: 1.45,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  /// DDL 时间标签：过期 → 「已过点」；明天 → 「明天 HH:mm」；今天 → 「今天 HH:mm」
  String _deadlineWhen(Map<String, dynamic> d) {
    final DateTime? due = DateTime.tryParse(d["dueAt"]?.toString() ?? "")?.toLocal();
    if (due == null) return "";
    final String hm =
        "${due.hour.toString().padLeft(2, "0")}:${due.minute.toString().padLeft(2, "0")}";
    if (d["overdue"] == true) return "已过点";
    final int dayDiff = d["dayDiff"] is num ? (d["dayDiff"] as num).toInt() : 0;
    return dayDiff == 1 ? "明天 $hm" : "今天 $hm";
  }

  /// 温度区间标签：「12~22°」（缺数降级 "--"）
  String _tempLabel(Map<String, dynamic> w) {
    final Object? min = w["minC"];
    final Object? max = w["maxC"];
    final String minStr = min is num ? min.toStringAsFixed(0) : "--";
    final String maxStr = max is num ? max.toStringAsFixed(0) : "--";
    return "$minStr~$maxStr°";
  }

  /// 天气副行：现象 + 降水概率（预警由独立 chip 呈现，不在此重复）
  String _weatherLine(Map<String, dynamic> w) {
    final String text = w["text"]?.toString() ?? "";
    final Object? rain = w["rainPct"];
    final String rainPart =
        rain is num && rain >= 20 ? "，降水 ${rain.toStringAsFixed(0)}%" : "";
    return "$text$rainPart";
  }
}

/// 明日行程条目：时刻（primary 强调）+ 简短文字描述。
/// 2026-10-26 用户定稿：只放「12:00 看牙医」式一行，服务端 shortTitle 口径；
/// 不渲染提醒原文与预告段小字（「到点了该干嘛」「10:00起床闹钟」不上卡，
/// 顶部的 narration 已承担活人描述）。
class _ScheduleItem extends StatelessWidget {
  const _ScheduleItem({required this.item, required this.theme});

  final Map<String, dynamic> item;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          width: 44,
          child: Text(
            item["time"]?.toString() ?? "待定",
            style: theme.textTheme.labelMedium?.copyWith(
              color: cs.primary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const SizedBox(width: 4),
        Expanded(
          child: Text(
            item["title"]?.toString() ?? "日程安排",
            style: theme.textTheme.bodyMedium,
          ),
        ),
      ],
    );
  }
}

/// 分节标题（小图标 + 小标题，晨报卡同款形态）
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.text,
    required this.theme,
  });

  final IconData icon;
  final String text;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: 6),
        Text(text, style: theme.textTheme.titleSmall),
      ],
    );
  }
}
