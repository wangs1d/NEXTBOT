import "package:flutter/material.dart";

/// 明日速览卡（contentType="evening_digest"，2026-10-22 定调；原名「睡前备忘」，
/// 2026-10-24 因内容实为明日信息而改名，载荷与事件名未变）。
///
/// 晚间 digest（evening.digest 事件）不再渲染纯文本气泡：本卡是每晚对
/// 「明天大概什么天儿 + 顺带聊一句」的简短汇报——narrationText（agent 口吻
/// 睡前文案）为卡顶部的「agent 说的话」段落，下面接次日天气块与素材条。
/// 整卡恒展开，无折叠展开（2026-10-22 用户定稿：不做今日回顾、不做折叠）。
///
/// 2026-11-23 §3.4 分工（PRD「早安 / 明日预览分工」）：**日程、截止事项（DDL）、
/// 重要日子从这张卡上撤下，只在早安出现**；这张卡从此只讲天气，外加一两句闲聊
/// （可接今天聊过的事、作息关怀），周日多一条作息周报。
/// 卡上不列行程不是丢数据：用户问「明天有什么安排」时走
/// TomorrowPreviewFacts 问答面（服务端同一份取数），照旧答全。
///
/// 载荷与服务端 [EveningDigest] 同构（ws EveningDigest payload.digest）：
///   - narrationText: agent 口吻睡前文案（正文就是天气——2026-11-23 起
///     旧口径「天气不上文案」作废：卡面只剩天气，文案再说一遍是分工后的正解；
///     客户端在 narration 为空时会整卡不渲染，正文总得有点东西）
///   - date: 今日本地日期键（YYYY-MM-DD），明日标签由此推导
///   - tomorrowWeather: { text, minC, maxC, rainWindowLabel?, alerts[] } | null
///   - chatLines?: string[]（一两句闲聊素材，服务端已截断）
///   - rhythmReport?: string[]（作息周报，仅周日那一格有）
///
/// 兼容：老载荷里若还带 tomorrowSchedule / deadlineReminders / importantDays
/// （升级前落库的历史消息），本卡一律不读、不显示——分工之后睡前的卡上没有这些。
class EveningDigestCard extends StatelessWidget {
  const EveningDigestCard({super.key, required this.digest});

  /// 暖黄点缀色（夜里那张卡的唯一暖色）：明暗主题下都不依赖主题色
  /// （否则夜里会变成冷紫）
  static const Color _moonColor = Color(0xFFF6C445);

  final Map<String, dynamic> digest;

  /// 字符串数组读数：缺键 / 非数组 / 非字符串元素一律忽略（载荷收窄后
  /// 这两块本来就是可选的，没给就当没有）
  List<String> _readStringList(String key) {
    final Object? raw = digest[key];
    if (raw is! List) return const <String>[];
    return <String>[
      for (final Object? x in raw)
        if (x != null && x.toString().trim().isNotEmpty) x.toString().trim(),
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

    final String narration =
        (digest["narrationText"]?.toString() ?? "").trim();
    final Object? rawWeather = digest["tomorrowWeather"];
    final Map<String, dynamic> weather = rawWeather is Map
        ? rawWeather.cast<String, dynamic>()
        : const <String, dynamic>{};
    final List<String> chatLines = _readStringList("chatLines");
    final List<String> rhythmReport = _readStringList("rhythmReport");
    final String? tomorrowLabel = _tomorrowLabel();
    // 现象文本已被预警徽章覆盖时（如「雷暴」既是 text 又是 alert）不再单写一行，
    // 与服务端口播的去重口径一致
    final String conditionText = weather["text"]?.toString() ?? "";
    final List<Object?> alerts =
        (weather["alerts"] as List?) ?? const <Object?>[];
    final bool alertCoversText =
        alerts.any((Object? a) => a?.toString().contains(conditionText) == true);
    final String rainWindow = weather["rainWindowLabel"]?.toString() ?? "";

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
            // ── 头部：「明日速览」+ 明日日期 ──
            Row(
              children: <Widget>[
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
            // ── 明日天气（§3.4 之后这张卡的正文；温度 + 现象 + 雨时段 + 预警）──
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
                  if (conditionText.isNotEmpty && !alertCoversText) ...<Widget>[
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        conditionText,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              // 带伞这件事的落点：雨时段小字（旧口径里它跟着行程块，现在天气
              // 就是主角，值得单独一行；服务端只在雨集中时给 label）
              if (rainWindow.isNotEmpty) ...<Widget>[
                const SizedBox(height: 6),
                Text(
                  "$rainWindow 前后有雨，出门记得带伞",
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
              if (alerts.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: <Widget>[
                    for (final Object? a in alerts)
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
            ],
            // ── 顺带一句（今天聊过的事 / 作息关怀）：不加分节标题，
            //     标题一上就变成「汇报」，闲聊要的就是这股随手一提的劲儿 ──
            if (chatLines.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              for (final String line in chatLines)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    line,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      height: 1.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
            // ── 这周作息（周日那一格才有，PRD §10 需求八搭在明日预览里）──
            if (rhythmReport.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              _SectionHeader(
                icon: Icons.bedtime_outlined,
                text: "这周作息",
                theme: theme,
                iconColor: _moonColor,
              ),
              const SizedBox(height: 6),
              for (final String line in rhythmReport)
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      const SizedBox(width: 2),
                      Container(
                        width: 4,
                        height: 4,
                        margin: const EdgeInsets.only(top: 8, right: 8),
                        decoration: BoxDecoration(
                          color: _moonColor.withValues(alpha: 0.8),
                          shape: BoxShape.circle,
                        ),
                      ),
                      Expanded(
                        child: Text(
                          line,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            height: 1.45,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  /// 温度区间标签：「12~22°」（缺数降级 "--"）
  String _tempLabel(Map<String, dynamic> w) {
    final Object? min = w["minC"];
    final Object? max = w["maxC"];
    final String minStr = min is num ? min.toStringAsFixed(0) : "--";
    final String maxStr = max is num ? max.toStringAsFixed(0) : "--";
    return "$minStr~$maxStr°";
  }
}

/// 分节标题（小图标 + 小标题，晨报卡同款形态）
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.text,
    required this.theme,
    this.iconColor,
  });

  final IconData icon;
  final String text;
  final ThemeData theme;
  /// 图标着色：不传就用次级文字色（暖黄只在作息那一格用一次）
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Icon(
          icon,
          size: 16,
          color: iconColor ?? theme.colorScheme.onSurfaceVariant,
        ),
        const SizedBox(width: 6),
        Text(text, style: theme.textTheme.titleSmall),
      ],
    );
  }
}
