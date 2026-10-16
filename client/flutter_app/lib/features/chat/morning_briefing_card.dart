import "package:flutter/material.dart";

class MorningBriefingCard extends StatelessWidget {
  const MorningBriefingCard({
    super.key,
    required this.briefing,
    this.narrationText,
    this.modeLabel,
    this.onSpeak,
  });

  final Map<String, dynamic> briefing;
  final String? narrationText;
  final String? modeLabel;
  final void Function(String text)? onSpeak;

  String? _readString(String key1, String key2) {
    final Object? a = briefing[key1];
    if (a is String && a.isNotEmpty) return a;
    final Object? b = briefing[key2];
    if (b is String && b.isNotEmpty) return b;
    return null;
  }

  List<dynamic>? _readList(String key1, String key2) {
    final Object? a = briefing[key1];
    if (a is List) return a;
    final Object? b = briefing[key2];
    if (b is List) return b;
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    final String greeting = _readString("greeting", "agentGreeting") ?? "";
    final List<Map<String, dynamic>> schedule = <Map<String, dynamic>>[
      for (final Object? x
          in _readList("schedule", "todaySchedule") ?? <dynamic>[])
        if (x is Map) x.cast<String, dynamic>(),
    ];

    final bool canSpeak =
        onSpeak != null && narrationText != null && narrationText!.isNotEmpty;

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(Icons.wb_sunny_outlined, color: cs.primary, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    greeting.isNotEmpty ? greeting : "每日简报",
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (modeLabel != null && modeLabel!.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 8),
                  _ModeChip(label: modeLabel!),
                ],
                if (canSpeak) ...<Widget>[
                  const SizedBox(width: 4),
                  IconButton(
                    icon: const Icon(Icons.volume_up_outlined),
                    onPressed: () => onSpeak!(narrationText!),
                    tooltip: "语音播报",
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    constraints:
                        const BoxConstraints(minWidth: 32, minHeight: 32),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 16),
            _SectionHeader(
              icon: Icons.event_note_outlined,
              text: "计划安排",
              theme: theme,
            ),
            const SizedBox(height: 6),
            if (schedule.isEmpty)
              Text(
                "今天还没有安排事项",
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              )
            else
              for (final Map<String, dynamic> s in schedule)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      SizedBox(
                        width: 60,
                        child: Text(
                          s["time"]?.toString() ?? "--:--",
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: cs.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(s["title"]?.toString() ?? ""),
                      ),
                    ],
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

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

class _ModeChip extends StatelessWidget {
  const _ModeChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: cs.secondaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: cs.onSecondaryContainer,
        ),
      ),
    );
  }
}
