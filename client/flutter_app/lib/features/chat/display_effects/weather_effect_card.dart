import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";

/// 天气内联卡（2026-11-06 参考稿版式定稿，手机与桌面同一组件）：
///
/// ```
/// ☁ 明天天气
/// 16~20° 中毛毛雨
/// ```
///
/// 首行 = 现象图标 + 卡标题（小字弱化）；次行 = 气温区间大字加粗 +
/// 现象词常规字重，同一基线对齐——一眼读完，无卡片底、无网格。
///
/// 演进史：10-12 平铺网格卡 → 11-05 瘦身纯文字行 → 11-06 参考稿内联卡。
/// 网格卡组件与瓷砖版式已删除；数据解析仍从服务端 items 确定性进行，
/// 不走 LLM。降雨时段/湿度/风速一概不出现（2026-11-06 用户定稿：
/// 现象词本身已说明有没有雨），着装/建议由 LLM 正文自然带出。
class WeatherInlineText extends StatelessWidget {
  const WeatherInlineText({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  // ── 服务端条目文本解析（tool-card-registry "weather.get_local" 的稳定格式）──

  /// 降雨时段行：「今天 下午 14–18 点有雨」「明天的雨已下过」——
  /// 新版卡不再展示降雨行，识别出来只为不让它误入 condition/extras。
  static final RegExp _rainRe = RegExp(r"^(今天|明天)\s*(.*(?:有雨|雨已下过))$");
  static final RegExp _humidityRe =
      RegExp(r"^湿度\s*(\d+(?:\.\d+)?\s*%)$");
  static final RegExp _tempRe = RegExp(r"^(?:气温|温度)\s*(.+)$");
  static final RegExp _windRe = RegExp(r"^(?:风速|风力)\s*(.+)$");

  /// 条目解析结果：condition=天气现象词，temp=气温原文（「16°–20°」或单值），
  /// extras=无法归类的服务端余项（弱化小字透出防丢信息）。
  static ({String? condition, String? temp, List<String> extras}) parseItems(
      List<AgentResultItem> items) {
    String? condition;
    String? temp;
    final List<String> extras = <String>[];

    for (final AgentResultItem item in items) {
      final String text = item.text.trim();
      if (text.isEmpty) continue;
      if (_rainRe.hasMatch(text)) continue;
      if (_humidityRe.hasMatch(text)) continue;
      if (_windRe.hasMatch(text)) continue;
      final RegExpMatch? m = _tempRe.firstMatch(text);
      if (m != null) {
        temp = m.group(1)?.trim() ?? text;
        continue;
      }
      // 无标签前缀的首个短文本 = 天气现象（「多云转晴」「中毛毛雨」）
      if (condition == null && !text.contains(RegExp(r"[：:]"))) {
        condition = text;
        continue;
      }
      extras.add(text);
    }
    return (condition: condition, temp: temp, extras: extras);
  }

  /// 「16°–20°」→「16~20°」（参考稿格式：~ 连接、° 只落在末位）；
  /// 单值实况（如「23°」）原样保留。
  static String formatTemp(String raw) =>
      raw.replaceAll(RegExp(r"°\s*[–—~～-]\s*"), "~");

  /// 按天气现象词选标题图标。
  static IconData conditionIcon(String? condition) {
    final String c = condition ?? "";
    if (c.contains("雨")) return Icons.umbrella_outlined;
    if (c.contains("雪")) return Icons.ac_unit_outlined;
    if (c.contains("云") || c.contains("阴")) return Icons.cloud_outlined;
    if (c.contains("雾") || c.contains("霾")) return Icons.blur_on;
    if (c.contains("雷")) return Icons.thunderstorm_outlined;
    if (c.contains("晴")) return Icons.wb_sunny_outlined;
    return Icons.wb_twilight_outlined;
  }

  @override
  Widget build(BuildContext context) {
    final parsed = parseItems(data.items);
    final String? condition = parsed.condition;
    final String? temp = parsed.temp;

    final String tempText = temp == null ? "" : formatTemp(temp);
    final List<String> extras = parsed.extras;
    if (tempText.isEmpty && condition == null && extras.isEmpty) {
      return const SizedBox.shrink();
    }

    final String title = data.title.trim();
    final TextStyle titleStyle = TextStyle(
      fontSize: 13.5,
      height: 1.35,
      fontWeight: FontWeight.w500,
      color: cs.onSurfaceVariant,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (title.isNotEmpty)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                conditionIcon(condition),
                size: 16,
                color: cs.onSurfaceVariant,
              ),
              const SizedBox(width: 5),
              Flexible(
                child: Text(title,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: titleStyle),
              ),
            ],
          ),
        if (title.isNotEmpty) const SizedBox(height: 3),
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (tempText.isNotEmpty)
              Text(
                tempText,
                style: TextStyle(
                  fontSize: 26,
                  height: 1.2,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                  // 数字用 HarmonyOS Sans + 等宽字形，区间不挤
                  fontFamily: "HarmonyOS Sans SC",
                  fontFamilyFallback: const <String>["MiSans"],
                  fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
                ),
              ),
            if (tempText.isNotEmpty && condition != null) const SizedBox(width: 8),
            if (condition != null)
              Flexible(
                child: Text(
                  condition,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 15,
                    height: 1.4,
                    color: cs.onSurface,
                    fontFamily: "HarmonyOS Sans SC",
                    fontFamilyFallback: const <String>["MiSans"],
                  ),
                ),
              ),
          ],
        ),
        // 无法归类的服务端余项极少见，保留透出防丢信息（弱化小字）。
        if (extras.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              extras.join("，"),
              style:
                  TextStyle(fontSize: 13, height: 1.4, color: cs.onSurfaceVariant),
            ),
          ),
      ],
    );
  }
}
