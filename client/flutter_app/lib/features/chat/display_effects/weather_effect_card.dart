import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";

/// 天气效果卡（cardType = "weather"，2026-10-12）。
///
/// 服务端 tool-card-registry 从 weather.get_local 回执确定性构卡：
/// items 依次为 天气文本 / 气温 X / 湿度 N% / 风速 N km/h / 峰值降水概率 N%，
/// footer = 着装建议。此前本卡落在通用列表卡（逐行小字），LLM 正文又常写
/// markdown 表格复述数据（手机端渲染成横向滚动表格，要左右滑动才能看全）。
///
/// 本组件按参考稿改为平铺卡：两列大字网格（标签小字 + 数值大字）+ 着装整行
/// ——一屏展示全部内容，无任何滑动交互。
/// 骨架与 [MetricEffectCard] 共用一条视觉基线（EffectCardShell）。
class WeatherEffectCard extends StatelessWidget {
  const WeatherEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  // ── 服务端条目文本解析（tool-card-registry "weather.get_local" 的稳定格式）──

  static final RegExp _rainRe =
      RegExp(r"^(?:峰值|最大)?(?:降水|降雨)概率\s*\d+(?:\.\d+)?\s*%$");
  static final RegExp _humidityRe = RegExp(r"^湿度\s*\d+(?:\.\d+)?\s*%$");
  static final RegExp _tempRe = RegExp(r"^(?:气温|温度)\s*(.+)$");
  static final RegExp _windRe = RegExp(r"^(?:风速|风力)\s*(.+)$");

  @override
  Widget build(BuildContext context) {
    String? condition;
    String? temp;
    String? rain;
    String? humidity;
    String? wind;
    final List<String> extras = <String>[];

    for (final AgentResultItem item in data.items) {
      final String text = item.text.trim();
      if (text.isEmpty) continue;
      if (_rainRe.hasMatch(text)) {
        rain = text;
        continue;
      }
      if (_humidityRe.hasMatch(text)) {
        humidity = text;
        continue;
      }
      RegExpMatch? m = _tempRe.firstMatch(text);
      if (m != null) {
        temp = m.group(1)?.trim() ?? text;
        continue;
      }
      m = _windRe.firstMatch(text);
      if (m != null) {
        wind = m.group(1)?.trim() ?? text;
        continue;
      }
      // 无标签前缀的首个短文本 = 天气现象（「多云转晴」「小雨」）
      if (condition == null && !text.contains(RegExp(r"[：:]"))) {
        condition = text;
        continue;
      }
      extras.add(text);
    }

    final List<Widget> tiles = <Widget>[
      if (condition != null)
        _WeatherTile(label: "天气", value: condition, cs: cs),
      if (temp != null) _WeatherTile(label: "气温", value: temp, cs: cs),
      if (rain != null) _WeatherTile(label: "降水概率", value: rain, cs: cs),
      if (humidity != null)
        _WeatherTile(label: "湿度", value: humidity, cs: cs),
      if (wind != null) _WeatherTile(label: "风速", value: wind, cs: cs),
    ];
    // 无法归类的余项与着装建议整行铺满（着装恒在最后，与参考稿一致）。
    final List<(Widget, bool)> cells = <(Widget, bool)>[
      for (final Widget tile in tiles) (tile, false),
      for (final String extra in extras) (_WeatherTile(label: "", value: extra, cs: cs), true),
      if (data.footer.trim().isNotEmpty)
        (
          _WeatherTile(label: "着装", value: data.footer.trim(), cs: cs),
          true
        ),
    ];

    return EffectCardShell(
      cs: cs,
      // 铺满气泡内宽（用户定稿 2026-10-21）：天气卡是平铺网格，随气泡拉宽
      // 网格同步变宽，信息密度更高；其余效果卡维持 kMaxWidth 390 不动。
      maxWidth: double.infinity,
      icon: _conditionIcon(condition),
      title: data.title,
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          const double gap = 6;
          final double half = (constraints.maxWidth - gap) / 2;
          final List<Widget> laidOut = <Widget>[];
          for (final (Widget, bool) cell in cells) {
            laidOut.add(
              SizedBox(
                width: cell.$2 ? constraints.maxWidth : half,
                child: cell.$1,
              ),
            );
          }
          return Wrap(spacing: gap, runSpacing: gap, children: laidOut);
        },
      ),
    );
  }

  static IconData _conditionIcon(String? condition) {
    final String c = condition ?? "";
    if (c.contains("雨")) return Icons.umbrella_outlined;
    if (c.contains("雪")) return Icons.ac_unit_outlined;
    if (c.contains("云") || c.contains("阴")) return Icons.cloud_outlined;
    if (c.contains("雾") || c.contains("霾")) return Icons.blur_on;
    if (c.contains("雷")) return Icons.thunderstorm_outlined;
    if (c.contains("晴")) return Icons.wb_sunny_outlined;
    return Icons.wb_twilight_outlined;
  }
}

/// 天气指标格：标签小字（onSurfaceVariant）+ 数值大字（onSurface 加粗）。
class _WeatherTile extends StatelessWidget {
  const _WeatherTile({
    required this.label,
    required this.value,
    required this.cs,
  });

  final String label;
  final String value;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (label.isNotEmpty)
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: cs.onSurfaceVariant,
                height: 1.3,
              ),
            ),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(
              fontSize: label.isNotEmpty ? 18 : 14,
              fontWeight: FontWeight.w700,
              color: cs.onSurface,
              height: 1.35,
              // 数字用 HarmonyOS Sans：字形开口更大，深色底小字号比
              // MiSans 更清晰；等宽数字避免 15-20 / 10.7 里的数字挤在一起。
              fontFamily: "HarmonyOS Sans SC",
              fontFamilyFallback: const <String>["MiSans"],
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}
