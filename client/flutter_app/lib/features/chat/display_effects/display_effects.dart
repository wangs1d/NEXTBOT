/// 文本展示效果独立模块（前端）。
///
/// 与服务端 `display-effect-router.ts` 一一对应：服务端按「工具信号 +
/// 内容信号」纯程序路由出 cardType，本模块按 cardType 分发到对应效果组件，
/// 不需要 LLM 参与，也不依赖服务端下发渲染指令。
///
/// 分发入口：[displayEffectsCard]。
/// 各效果组件：
///   - steps      数字步骤链（steps_effect_card.dart）
///   - metric     数据面板网格（metric_effect_card.dart）
///   - carousel   图片轮播横滑（carousel_effect_card.dart）
///   - chips      标签胶囊墙（chips_effect_card.dart）
///   - fold_list  长清单折叠（fold_list_effect_card.dart）
///   - compare    A/B 双图拖动对比滑杆（compare_slider.dart）
///   - comparison_table 文本 A/B 对比双栏卡（comparison_table_effect_card.dart）
/// 其余 cardType（weather/schedule/.../timeline/progress/quote/media/
/// search_result）仍由 agent_result_card.dart 内的既有组件渲染；
/// [displayEffectsCard] 返回 null 即表示「无专用效果，走原有默认」。
library;

import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "carousel_effect_card.dart";
import "chips_effect_card.dart";
import "comparison_table_effect_card.dart";
import "compare_slider.dart";
import "effect_media_utils.dart";
import "fold_list_effect_card.dart";
import "metric_effect_card.dart";
import "steps_effect_card.dart";
import "weather_effect_card.dart";

/// 按 [AgentResultData.cardType] 分发展示效果组件。
///
/// 返回 null 表示该 cardType 不在本模块管辖范围（调用方回退到
/// AgentResultCard 既有的专用卡/通用列表卡），保证新增类型前的
/// 历史行为完全不变。
///
/// [onUserAction] 为可选的用户动作回调（与 AgentActionChoiceCard 同一
/// 链路）：可交互的效果（如 chips 点击追问）经它把动作发回聊天页。
Widget? displayEffectsCard({
  required AgentResultData data,
  required ColorScheme cs,
  DisplayCardAction? onUserAction,
}) {
  switch (data.cardType) {
    case "steps":
      return StepsEffectCard(data: data, cs: cs);
    case "metric":
      return MetricEffectCard(data: data, cs: cs);
    case "weather":
      // 天气平铺卡（2026-10-12）：两列大字网格 + 百分比进度条 + 着装整行，
      // 一屏展示全部内容；返回 null 会回退通用列表卡并伴随正文 markdown
      // 表格（横向滑动），不再走那条路。
      return WeatherEffectCard(data: data, cs: cs);
    case "carousel":
      return CarouselEffectCard(data: data, cs: cs);
    case "chips":
      return ChipsEffectCard(
        data: data,
        cs: cs,
        onChipTap: onUserAction == null
            ? null
            : (String tag) => onUserAction(
                  AgentResultAction(id: "chip_ask", label: tag),
                  cardData: data,
                ),
      );
    case "fold_list":
      return FoldListEffectCard(data: data, cs: cs);
    case "compare":
      return _buildCompare(data, cs);
    case "comparison_table":
      return ComparisonTableEffectCard(data: data, cs: cs);
    default:
      return null;
  }
}

/// 效果卡用户动作回调签名（与 message_body_renderer 的 onUserAction 一致）。
typedef DisplayCardAction = void Function(
  AgentResultAction action, {
  required AgentResultData cardData,
});

/// compare：side=A / side=B 各一张可解析图片时启用双图滑杆；
/// 无 side 标注但恰好两条带图条目时按顺序视为 A/B；
/// 其余（纯文本对比、多图对比）返回 null 回退通用卡。
Widget? _buildCompare(AgentResultData data, ColorScheme cs) {
  String? urlA;
  String? urlB;
  for (final AgentResultItem it in data.items) {
    final String side = (it.side ?? "").trim().toUpperCase();
    if (side == "A" && urlA == null) {
      urlA = resolveItemPreviewUrl(it);
    } else if (side == "B" && urlB == null) {
      urlB = resolveItemPreviewUrl(it);
    }
  }
  if (urlA == null && urlB == null) {
    final List<String> urls = data.items
        .map(resolveItemPreviewUrl)
        .whereType<String>()
        .toList();
    if (urls.length == 2) {
      urlA = urls[0];
      urlB = urls[1];
    }
  }
  if (urlA == null || urlB == null) return null;
  return CompareEffectCard(data: data, cs: cs, urlA: urlA, urlB: urlB);
}
