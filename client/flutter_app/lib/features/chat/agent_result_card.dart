import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/services/image_preview_launcher.dart";
import "../../core/services/phone_capture_service.dart";
import "../../core/services/video_preview_launcher.dart";
import "media_disk_cache.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/link_utils.dart";
import "travel_plan_launcher.dart";
import "product_pick_card.dart";
import "price_compare_card.dart";
import "travel_plan_models.dart";
import "travel_image_warmer.dart";
import "travel_theme.dart";
import "content_summary_detail_formatter.dart";
import "display_effects/compare_slider.dart";
import "display_effects/display_effects.dart";
import "display_effects/soft_icon_chip.dart";
import "media_gallery.dart";
import "morning_briefing_card.dart";
import "travel_guide_select_card.dart";
import "media_thumbnail.dart";

/// 智能体结果卡片 —— 用于呈现「任务执行总结」「工具调用结果」
/// 这类**短而固定结构**的轻量数据(3~7 条 ✓/• 项 + 可选追问)。
///
/// 与 `ContentSummaryMessageBody` 的边界(后者用于"长内容/可折叠/可查看详情"):
///   - 数据量小: ≤ 7 条短条目,且不需要完整正文
///   - 结构固定: 标题 + 列表(+ 可选一行 footer)
///   - **不可折叠**: 数据已在卡片内完整展示,无需"查看详情"入口
///   - 不需要头像(图标随标题层级即可)
///   - 通常用于:任务完成/失败汇报、工具调用结果、行程/清单类小结构
///
/// 直接使用:
/// ```dart
/// AgentResultCard(
///   data: AgentResultData(
///     title: '周末行程已为你规划:',
///     items: [
///       AgentResultItem(type: 'check', text: '周六上午:你说过的那家新店探店'),
///       AgentResultItem(type: 'check', text: '周六下午:健身 + 采购下周食材'),
///       AgentResultItem(type: 'check', text: '周日:在家看你收藏的那部电影'),
///     ],
///     footer: '需要调整吗?',
///   ),
/// )
/// ```
class AgentResultCard extends StatelessWidget {
  const AgentResultCard({
    super.key,
    required this.data,
    this.compact = true,
    this.onUserAction,
  });

  final AgentResultData data;

  /// 紧凑模式:行高/字号/内边距整体更小,适合聊天消息流。默认 `true`。
  final bool compact;

  /// 用户动作回调（与 AgentActionChoiceCard 同一链路）：透传给
  /// display_effects 中可交互的效果卡（如 chips 标签点击追问）。
  final void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction;

  @override
  Widget build(BuildContext context) {
    // 入场动画（感知升级）：新结果卡滑入+淡入一次性过渡——消息流里
    // 「砰地出现」变成「滑进对话」。TweenAnimationBuilder 首帧自动播放。
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
      builder: (BuildContext context, double t, Widget? child) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, 8 * (1 - t)), child: child),
      ),
      child: buildCard(context),
    );
  }

  /// 卡片本体（原 build）：按 cardType 分发到效果组件/专用卡/通用卡。
  Widget buildCard(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    // 展示效果独立模块（display_effects/）：服务端 display-effect-router
    // 纯程序路由出 cardType，这里按 cardType 分发到对应效果组件
    //（steps/metric/carousel/chips/fold_list/compare 滑杆等），无 LLM 参与。
    // 返回 null 的类型走下方既有专用卡，行为与历史版本一致。
    if (data.cardType.isNotEmpty) {
      final Widget? effect =
          displayEffectsCard(data: data, cs: cs, onUserAction: onUserAction);
      if (effect != null) return effect;
      switch (data.cardType) {
        case "search_result":
          return _SearchResultCard(data: data, cs: cs);
        case "timeline":
          return _TimelineCard(data: data, cs: cs);
        case "progress":
          return _ProgressCard(data: data, cs: cs);
        case "quote":
          return _QuoteCard(data: data, cs: cs);
        case "media":
          return _MediaCard(data: data, cs: cs);
        case "travel_itinerary":
          // 版本闸（开源版剔除旅游家族）：oss 服务端不产此卡，此处纵深防御
          if (ApiConfig.isOssEdition) return const SizedBox.shrink();
          return _TravelItineraryCard(data: data, cs: cs);
        case "travel_guide_select":
          // 规划前种草选择卡（travel.destination-guide 工具结果）：
          // 四分类多图勾选 → 确认把分组选择回传成用户消息。
          // 同旅游家族做 oss 纵深防御闸。
          if (ApiConfig.isOssEdition) return const SizedBox.shrink();
          return TravelGuideSelectCard(
            data: data,
            cs: cs,
            onUserAction: onUserAction,
          );
        case "product_compare":
          // 注意：这是 shopping.suggest（开源保留）的二分化对比卡， oss 不闸
          return _ProductCompareCard(data: data, cs: cs);
        case "product_pick":
          // 立场化推荐卡（开源保留，同 product_compare 策略不闸）：
          // 主推大图 +「为什么是它」+ 渠道实时价 CTA + 备选横滑。
          return ProductPickCard(data: data, cs: cs);
        case "price_compare":
          // 跨平台实时比价卡（shopping.compare.prices）：分组报价大图行 +
          // 大号价格 + 平台 chip + 决策页 CTA；旧形态回执无结构化载荷时
          // 回退通用专用卡渲染（服务端 items 仍随卡下发）。
          if (data.priceCompare == null) {
            return _SpecializedCard(data: data, cs: cs);
          }
          return PriceCompareCard(data: data, cs: cs);
        case "permission_request":
          return _PermissionRequestCard(data: data, cs: cs);
        case "morning_briefing":
          // 简报卡（岛上条目退役后简报的聊天流落点）：extra 携带原始简报
          // 载荷，渲染复用 MorningBriefingCard（与兜底 Dialog 同一组件）。
          final Map<String, dynamic>? extra = data.extra;
          final Map<String, dynamic> briefingPayload =
              (extra?["briefing"] as Map<String, dynamic>?) ??
                  const <String, dynamic>{};
          return _MorningBriefingChatCard(
            briefing: briefingPayload,
            modeLabel: extra?["modeLabel"]?.toString(),
            cs: cs,
          );
        default:
          return _SpecializedCard(data: data, cs: cs);
      }
    }

    // 紧凑尺寸(贴近聊天消息流的实际密度)
    final EdgeInsets padding = const EdgeInsets.fromLTRB(14, 12, 14, 12);
    final double titleGap = 8;
    final double listItemGap = 3;
    final double footerGap = 8;
    final double titleSize = 14;
    final double itemSize = 13;
    final double footerSize = 12.5;
    final Color titleColor = cs.onSurface;
    final Color itemColor = cs.onSurface.withValues(alpha: 0.82);
    final Color footerColor = cs.onSurfaceVariant;

    return SizedBox(
      width: double.infinity,
      child: Container(
        // 卡片宽度自然跟随内容(由外层 bubble 约束),最大 390,
        // 避免宽屏下拉成"横幅",实现"刚好包住每行最后那个字"的紧凑效果。
        constraints: const BoxConstraints(maxWidth: 390),
        padding: padding,
        decoration: BoxDecoration(
          color: cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (data.title.isNotEmpty)
              Padding(
                padding: EdgeInsets.only(bottom: titleGap),
                child: Text(
                  data.title,
                  style: TextStyle(
                    fontSize: titleSize,
                    fontWeight: FontWeight.w600,
                    color: titleColor,
                    height: 1.45,
                  ),
                  softWrap: true,
                ),
              ),
            if (data.items.isNotEmpty)
              ...data.items.map((AgentResultItem it) {
                // 行级可点：url 非空整行可点（相对路径补服务端基址），
                // 比价卡报价行跳平台商品页、决策页入口行跳决策页。
                final String? itemUrl = (it.url != null && it.url!.isNotEmpty)
                    ? LinkUtils.resolveMediaUrl(it.url!)
                    : null;
                // 行首缩略图（比价卡商品主图等）；无图回退 ✓/•/! 标记。
                final String? thumb = (it.thumbnailUrl != null && it.thumbnailUrl!.isNotEmpty)
                    ? LinkUtils.resolveMediaUrl(it.thumbnailUrl!)
                    : null;
                final Widget row = Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (thumb != null)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: SizedBox(
                            width: 40,
                            height: 40,
                            child: CachedMediaImage(
                              url: thumb,
                              fit: BoxFit.cover,
                              filterQuality: FilterQuality.low,
                              errorBuilder: (_, __, ___) => Container(
                                color: cs.surfaceContainerHighest,
                                alignment: Alignment.center,
                                child: Icon(
                                  Icons.shopping_bag_outlined,
                                  size: 16,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                              loadingBuilder: (BuildContext context) => Container(
                                color: cs.surfaceContainerHighest,
                              ),
                            ),
                          ),
                        ),
                      )
                    else
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: _ItemMark(type: it.type, colorScheme: cs),
                      ),
                    Expanded(
                      child: _InlineMarkdownBody(
                        it.text,
                        style: TextStyle(
                          fontSize: itemSize,
                          color: itemColor,
                          height: 1.55,
                        ),
                        colorScheme: cs,
                      ),
                    ),
                    if (itemUrl != null)
                      Padding(
                        padding: const EdgeInsets.only(left: 2),
                        child: Icon(
                          Icons.chevron_right_rounded,
                          size: 15,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                  ],
                );
                return Padding(
                  padding: EdgeInsets.symmetric(vertical: listItemGap),
                  child: itemUrl == null
                      ? row
                      : InkWell(
                          onTap: () => LinkUtils.launchExternal(itemUrl),
                          borderRadius: BorderRadius.circular(6),
                          child: row,
                        ),
                );
              }),
            if (data.footer.isNotEmpty) ...<Widget>[
              SizedBox(height: footerGap),
              Container(
                padding: EdgeInsets.only(top: footerGap),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      color: cs.outline.withValues(alpha: 0.28),
                      width: 1,
                    ),
                  ),
                ),
                child: _InlineFooterText(
                  text: data.footer,
                  color: footerColor,
                  fontSize: footerSize,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _InlineMarkdownBody extends StatelessWidget {
  const _InlineMarkdownBody(
    this.text, {
    required this.style,
    required this.colorScheme,
  });

  final String text;
  final TextStyle style;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    return buildInlineMarkdownText(text, style, cs: colorScheme);
  }
}

/// 列表项标记：与卡片标题图标块同一套「浅底圆角芯片 + 实色图标」语言，
/// 只是走 item 小档（16px 芯片），✓/•/! 从文本符号改为 Material 图标，
/// 让列表行与专用卡图标块视觉同源。
class _ItemMark extends StatelessWidget {
  const _ItemMark({required this.type, required this.colorScheme});

  final String type;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color) = switch (type) {
      "warn" => (Icons.priority_high_rounded, const Color(0xFFFBBF24)),
      "num" || "bullet" => (
          Icons.fiber_manual_record_rounded,
          colorScheme.primary
        ),
      _ => (Icons.check_rounded, const Color(0xFF34D399)),
    };
    return SoftIconChip(
      icon: icon,
      color: color,
      chipSize: 16,
      iconSize: 11,
      radius: 5,
    );
  }
}

/// 支持 `[tag] 文本` 这种简单 inline 标签语法的轻量渲染：
///   - `[main]` 渲染为带强调色背景的小标签
///   - 其余文本按原色输出
/// 仅用于 footer 提示行，避免引入 markdown 依赖。
class _InlineFooterText extends StatelessWidget {
  const _InlineFooterText({
    required this.text,
    required this.color,
    required this.fontSize,
  });

  final String text;
  final Color color;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<TextSpan> spans = <TextSpan>[];
    final RegExp tagRe = RegExp(r'\[([^\[\]\n]+)\]');
    int cursor = 0;
    for (final RegExpMatch m in tagRe.allMatches(text)) {
      if (m.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, m.start)));
      }
      spans.add(
        TextSpan(
          text: " ${m.group(1)} ",
          style: TextStyle(
            color: cs.primary,
            backgroundColor: cs.primary.withValues(alpha: 0.12),
            fontWeight: FontWeight.w600,
            fontSize: fontSize - 1,
          ),
        ),
      );
      cursor = m.end;
    }
    if (cursor < text.length) {
      spans.add(TextSpan(text: text.substring(cursor)));
    }

    return RichText(
      text: TextSpan(
        style: TextStyle(color: color, fontSize: fontSize, height: 1.5),
        children: spans,
      ),
    );
  }
}

/// 工具专用卡片：按 cardType 切换图标/主色/装饰。
/// 数据仍是工具返回的 items 文本，专用化主要体现在视觉类型上
/// （天气/日程/钱包/订单/文件），让不同工具的结果一眼可辨。
class _SpecializedCard extends StatelessWidget {
  const _SpecializedCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  (IconData, Color) get _style {
    switch (data.cardType) {
      case "weather":
        // 天气卡不引入工具色：图标/描边跟随主题中性强调（黑白灰），
        // 晴雨雪等所有天气状况共用此路径，无按天气分支的配色。
        return (Icons.wb_sunny_outlined, cs.primary);
      case "schedule":
        return (Icons.event_note_outlined, cs.primary);
      case "wallet":
        return (Icons.account_balance_wallet_outlined, const Color(0xFF10B981));
      case "order":
        return (Icons.receipt_long_outlined, const Color(0xFF3B82F6));
      case "file":
        return (Icons.insert_drive_file_outlined, const Color(0xFF8B5CF6));
      default:
        return (Icons.check_circle_outline, cs.primary);
    }
  }

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color) = _style;
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SoftIconChip(icon: icon, color: color),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: cs.onSurface,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          ...data.items.map((AgentResultItem it) {
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _ItemMark(type: it.type, colorScheme: cs),
                  const SizedBox(width: 8),
                  Flexible(
                    child: buildInlineMarkdownText(
                      it.text,
                      TextStyle(
                        fontSize: 13,
                        color: cs.onSurface.withValues(alpha: 0.82),
                        height: 1.55,
                      ),
                      cs: cs,
                    ),
                  ),
                ],
              ),
            );
          }),
          if (data.footer.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.only(top: 8),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 文字进度条/图表卡：把数值型结论可视化为进度条，比纯列表更直观。
///
/// 约定（服务端 `AgentResultFormatter` 输出）：
///   - item 文本形如 `任务 A 45%` / `完成度 75%` / `效率 90/100`，
///     正则提取末尾的百分比或 `x/总分`，渲染为横向进度条；
///   - 提不出数值的 item 回退为普通列表行。
/// 适合：任务完成度、预算使用、评分对比、达成率等「带数字」的结论。
class _ProgressCard extends StatelessWidget {
  const _ProgressCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                SoftIconChip(icon: Icons.donut_small, color: cs.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: cs.onSurface,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
          ],
          ...data.items.map((AgentResultItem it) {
            return _ProgressRow(text: it.text, cs: cs);
          }),
          if (data.footer.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.only(top: 8),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 进度卡单行：`标签 xx%`（或 `x/总分`）→ 标签 + 进度条 + 百分比。
class _ProgressRow extends StatelessWidget {
  const _ProgressRow({required this.text, required this.cs});

  final String text;
  final ColorScheme cs;

  /// 提取形如 `75%`、`45 %`、`90/100`、`0.85` 的数值。percent>1 时按 x/max 归一。
  (String label, double? value, String? tail)? _parse() {
    final RegExpMatch? m =
        RegExp(r"^(.*?)\s*(?:[（(]?(\d+(?:\.\d+)?)\s*%[)）]?|(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?))\s*$")
            .firstMatch(text);
    if (m == null) return null;
    final String label = m.group(1)!.trim();
    double? v;
    String? tail;
    if (m.group(2) != null) {
      v = double.tryParse(m.group(2)!);
      tail = "${m.group(2)!}%";
    } else if (m.group(3) != null && m.group(4) != null) {
      final double? cur = double.tryParse(m.group(3)!);
      final double? max = double.tryParse(m.group(4)!);
      if (cur != null && max != null && max > 0) {
        v = cur / max;
        tail = "${m.group(3)!}/${m.group(4)!}";
      }
    }
    if (v == null) return (label, null, tail);
    return (label, v.clamp(0.0, 1.0), tail);
  }

  @override
  Widget build(BuildContext context) {
    final (String label, double? value, String? tail)? parsed = _parse();
    if (parsed == null || parsed.$2 == null) {
      // 非数值行 → 回退普通列表行
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _ItemMark(type: "bullet", colorScheme: cs),
            const SizedBox(width: 8),
            Expanded(
              child: buildInlineMarkdownText(
                text,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurface.withValues(alpha: 0.82),
                  height: 1.55,
                ),
                cs: cs,
              ),
            ),
          ],
        ),
      );
    }
    final double pct = parsed.$2!;
    // 两态配色：100% 完成绿，其余主色。颜色只表达「完成/未完成」，
    // 不做三色过载的信号编码，视觉更克制、直接了当。
    final Color barColor = pct >= 1 ? const Color(0xFF10B981) : cs.primary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  parsed.$1,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: cs.onSurface.withValues(alpha: 0.85),
                    height: 1.3,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                parsed.$3 ?? "${(pct * 100).round()}%",
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: barColor,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct,
              minHeight: 6,
              backgroundColor: cs.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation<Color>(barColor),
            ),
          ),
        ],
      ),
    );
  }
}

/// 权限引导卡（cardType=permission_request）：手机权限/系统设置引导。
///
/// 按钮动作是**固定本机映射**（open_notification_listener_settings → 系统
/// 「通知使用权」设置页），不透传任意 intent/路由——LLM 只能选择是否出卡，
/// 无法引导到别的页面。actions 缺失或 id 不匹配时退化为纯展示卡（不出按钮）。
class _PermissionRequestCard extends StatelessWidget {
  const _PermissionRequestCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  static const String _allowedActionId = "open_notification_listener_settings";

  @override
  Widget build(BuildContext context) {
    AgentResultAction? action;
    for (final AgentResultAction a in data.actions) {
      if (a.id == _allowedActionId) {
        action = a;
        break;
      }
    }
    final String buttonLabel =
        (action?.label.isNotEmpty ?? false) ? action!.label : "去系统设置授权";
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.primary.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SoftIconChip(
                icon: Icons.notifications_active_outlined,
                color: cs.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  data.title,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                    height: 1.45,
                  ),
                  softWrap: true,
                ),
              ),
            ],
          ),
          if (data.items.isNotEmpty)
            ...data.items.map((AgentResultItem it) {
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _ItemMark(type: it.type, colorScheme: cs),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _InlineMarkdownBody(
                        it.text,
                        style: TextStyle(
                          fontSize: 13,
                          color: cs.onSurface.withValues(alpha: 0.82),
                          height: 1.55,
                        ),
                        colorScheme: cs,
                      ),
                    ),
                  ],
                ),
              );
            }),
          if (action != null) ...<Widget>[
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () {
                  unawaited(
                    PhoneCaptureService.instance.openListenerSettings(),
                  );
                },
                icon: const Icon(Icons.settings_outlined, size: 16),
                label: Text(buttonLabel),
                style: FilledButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  backgroundColor: cs.primary,
                  foregroundColor: cs.onPrimary,
                ),
              ),
            ),
          ],
          if (data.footer.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              data.footer,
              style: TextStyle(
                fontSize: 12.5,
                color: cs.onSurfaceVariant,
                height: 1.45,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 引用卡：把 agent 的一句话结论做成醒目的引用强调，视觉上区别于普通正文。
///
/// 约定：`data.title` 为引述正文，`data.footer` 可选作为来源/出处。
/// 适合：核心结论、金句、警告提示、强调重点。
class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final String body = data.title.isNotEmpty ? data.title : data.footer;
    final String source =
        data.title.isNotEmpty ? data.footer : (data.items.isNotEmpty ? data.items.first.text : "");
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border(
          left: BorderSide(color: cs.primary, width: 3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SoftIconChip(icon: Icons.format_quote, color: cs.primary),
              const SizedBox(width: 8),
              Expanded(
                child: buildInlineMarkdownText(
                  body,
                  TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                    height: 1.55,
                  ),
                  cs: cs,
                ),
              ),
            ],
          ),
          if (source.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.only(left: 36),
              child: buildInlineMarkdownText(
                "— $source",
                TextStyle(
                  fontSize: 12,
                  color: cs.onSurfaceVariant,
                  height: 1.4,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 在「标题：描述」/「标题 —— 描述」/「标题 — 描述」/「标题 - 描述」中找分隔位置。
int _findTitleSep(String raw) {
  final RegExp sepRe = RegExp(r"[:：]|——|—|\s-\s|｜|\|");
  final RegExpMatch? m = sepRe.firstMatch(raw);
  if (m == null) return -1;
  final int sep = m.start;
  return sep > 0 ? sep : -1;
}

/// 时间轴卡：把每个 item 渲染为时间轴上的一个节点（点 + 时间 + 描述）。
///
/// 约定：item 文本形如 `09:00 起床` 或 `周六 09:00 起床`（时间/日期在开头），
/// 前端按第一个空格切出时间戳与正文。适合行程/计划/日程场景。
class _TimelineCard extends StatelessWidget {
  const _TimelineCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    const EdgeInsets padding = EdgeInsets.fromLTRB(14, 12, 14, 12);
    final Color titleColor = cs.onSurface;
    final Color borderColor = cs.outline.withValues(alpha: 0.22);

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                SoftIconChip(icon: Icons.timeline_outlined, color: cs.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: titleColor,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
          ],
          // 时间轴主体：竖线 + 节点
          ...data.items.asMap().entries.map((MapEntry<int, AgentResultItem> e) {
            final bool isLast = e.key == data.items.length - 1;
            final (String time, String body) = _splitTimeline(e.value.text);
            return IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  // 节点列：圆点 + 竖线
                  SizedBox(
                    width: 20,
                    child: Column(
                      children: <Widget>[
                        Container(
                          width: 9,
                          height: 9,
                          margin: const EdgeInsets.only(top: 4),
                          decoration: BoxDecoration(
                            color: cs.primary,
                            shape: BoxShape.circle,
                          ),
                        ),
                        if (!isLast)
                          Expanded(
                            child: Container(
                              width: 2,
                              margin: const EdgeInsets.only(top: 2),
                              color: cs.outline.withValues(alpha: 0.3),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  // 内容列
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          if (time.isNotEmpty)
                            Text(
                              time,
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: cs.primary,
                                height: 1.3,
                              ),
                            ),
                          if (body.isNotEmpty)
                            buildInlineMarkdownText(
                              body,
                              TextStyle(
                                fontSize: 13,
                                color: cs.onSurface.withValues(alpha: 0.82),
                                height: 1.5,
                              ),
                              cs: cs,
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
        ],
      ),
    );
  }

  /// 把「时间 + 正文」从 item 文本中切出。
  /// 时间戳匹配：`HH:mm`、`HH:mm-HH:mm`、`周六/周日/明天`、`MM-dd` 等开头。
  (String, String) _splitTimeline(String raw) {
    final RegExpMatch? m = RegExp(
      r"^((?:\d{1,2}[:：]\d{2}(?:[-~]\d{1,2}[:：]\d{2})?)|(?:周[一二三四五六日天])|(?:明天|今天|后天)|(?:\d{1,2}[-/]\d{1,2}))[:： ]\s*",
    ).firstMatch(raw);
    if (m == null) {
      return ("", raw.trim());
    }
    return (
      m.group(1)!.trim(),
      raw.substring(m.end).trim(),
    );
  }
}

/// 图片/媒体结果卡：纯图廊。
///
/// 竖向大图流版式：每张照片全宽展示（优先自然宽高比，竖幅人像不再被
/// 裁成横条），下方带一句说明；顶部标注总数。点击任意照片在右侧双栏
/// 打开大图，同一绿泡内可前后切换（见 [ImagePreviewPanel]）。
/// 视频条目仍展示缩略图 + 来源 + 播放角标。
class _MediaCard extends StatelessWidget {
  const _MediaCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final List<AgentResultItem> items = data.items;
    final String groupTitle = (data.groupTitle ?? "").trim();
    final bool isGrouped = groupTitle.isNotEmpty;

    // 收集照片（解析 thumbnail/media/pageUrl 任一可用地址并统一 resolve）
    // + 自然宽高比 + 对比侧 + 图片描述（服务端视觉模型生成）
    final List<({String url, double? aspect, String side, String? caption})> photos =
        <({String url, double? aspect, String side, String? caption})>[];
    final List<String> allPhotoUrls = <String>[];
    // 收集视频（缩略图可空：后端已保证不把播放页/搜索页 URL 当图下发；
    // 无缩略图时前端显示视频占位图标，点击仍可打开播放页）
    final List<
        ({
          String title,
          String? source,
          String? thumbnailUrl,
          String? openUrl,
          String? playableUrl,
        })> videos = <({String title, String? source, String? thumbnailUrl, String? openUrl, String? playableUrl})>[];
    for (final AgentResultItem it in items) {
      final String text = it.text.trim();
      final String? textUrl = LinkUtils.extractFirst(text);
      final String? previewUrl = _firstNonEmpty(<String?>[
        it.thumbnailUrl,
        it.mediaType == "video" ? null : it.mediaUrl,
        it.url,
        textUrl,
      ]);
      final String? openUrl = _firstNonEmpty(<String?>[
        it.pageUrl,
        it.url,
        it.mediaUrl,
        textUrl,
      ]);
      final bool isVideo = (it.mediaType ?? "").toLowerCase() == "video" ||
          (openUrl != null &&
              RegExp(r"(youtube\.com|youtu\.be|bilibili\.com|/video/)",
                      caseSensitive: false)
                  .hasMatch(openUrl));
      if (previewUrl == null && openUrl == null) continue;
      if (isVideo) {
        videos.add((
          title: text.isNotEmpty && text != "图片" ? text : (it.source ?? "相关视频"),
          source: it.source,
          thumbnailUrl: previewUrl,
          openUrl: openUrl,
          playableUrl: it.playableUrl,
        ));
      } else {
        final String resolved = LinkUtils.resolveMediaUrl(previewUrl!);
        // 同一张图不重复展示：地址已在集内则跳过（服务端已去重，此处双保险）
        if (allPhotoUrls.contains(resolved)) continue;
        photos.add((
          url: resolved,
          aspect: it.naturalAspect,
          side: (it.side ?? "").trim(),
          caption: (it.caption ?? "").trim().isEmpty ? null : it.caption!.trim(),
        ));
        allPhotoUrls.add(resolved);
      }
    }

    if (photos.isEmpty && videos.isEmpty) return const SizedBox.shrink();

    // 分组/对比模式：左侧(A) + 右侧(B) 分栏；无侧的归入常规网格
    final List<({String url, double? aspect, String side, String? caption})> leftPhotos =
        photos.where((p) => p.side == "A").toList();
    final List<({String url, double? aspect, String side, String? caption})> rightPhotos =
        photos.where((p) => p.side == "B").toList();
    final List<({String url, double? aspect, String side, String? caption})> plainPhotos =
        photos.where((p) => p.side != "A" && p.side != "B").toList();
    final bool hasColumns =
        isGrouped && (leftPhotos.isNotEmpty || rightPhotos.isNotEmpty);
    // A/B 任一列有独立标签时，渲染对比列头；否则省略表头。
    final bool hasColumnHeaders =
        (data.sideA?.trim().isNotEmpty ?? false) ||
            (data.sideB?.trim().isNotEmpty ?? false);

    // A/B 对比逐行配对：A[i] 与 B[i] 同一行并排，便于肉眼逐张对比。
    // 顶部先渲染 A/B 列头，后续每行图片填满各自列宽（方形自适应），
    // 保证两列等宽整齐；某侧缺图时该格显示「—」占位。
    List<Widget> buildCompareRows(
      List<({String url, double? aspect, String side, String? caption})> aList,
      List<({String url, double? aspect, String side, String? caption})> bList,
    ) {
      final bool showHeader = hasColumnHeaders;
      final int count = aList.length > bList.length ? aList.length : bList.length;
      final List<Widget> rows = <Widget>[
        if (showHeader) ...<Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(child: _compareColumnHeader(data.sideA)),
              const SizedBox(width: 8),
              Expanded(child: _compareColumnHeader(data.sideB)),
            ],
          ),
          const SizedBox(height: 8),
        ],
        for (int i = 0; i < count; i++) ...<Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: _compareCell(
                  i < aList.length ? aList[i] : null,
                  allPhotoUrls,
                  context,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _compareCell(
                  i < bList.length ? bList[i] : null,
                  allPhotoUrls,
                  context,
                ),
              ),
            ],
          ),
          if (i < count - 1) const SizedBox(height: 8),
        ],
      ];
      return rows;
    }

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 分组维度标题（如「颜色持久度」）
          if (isGrouped && groupTitle.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 2, right: 2, bottom: 8),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 4,
                    height: 14,
                    decoration: BoxDecoration(
                      color: cs.primary,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      groupTitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // A/B 对比：恰好两侧各一张图 → 拖动对比滑杆（逐像素对比原图，
          // 如持妆前后对比）；多张 → 逐行配对并排（A[i] ↔ B[i]）。
          if (hasColumns && leftPhotos.length == 1 && rightPhotos.length == 1)
            CompareSlider(
              urlA: leftPhotos.first.url,
              urlB: rightPhotos.first.url,
              labelA: (data.sideA ?? "").trim(),
              labelB: (data.sideB ?? "").trim(),
              gallery: allPhotoUrls,
              cs: cs,
            )
          else if (hasColumns)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: buildCompareRows(leftPhotos, rightPhotos),
            ),
          if (hasColumns && plainPhotos.isNotEmpty) const SizedBox(height: 8),
          // 无侧/常规照片网格
          if (plainPhotos.isNotEmpty || !hasColumns)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (photos.length > 1 && !hasColumns)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8, left: 2),
                    child: Text(
                      "共 ${photos.length} 张图片",
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                if (plainPhotos.length == 1 && photos.length == 1)
                  // 单张：半宽贴左展示（带图片描述），点击预览
                  MediaGallery(
                    urls: <String>[plainPhotos.first.url],
                    aspects: <double?>[plainPhotos.first.aspect],
                    captions: <String?>[plainPhotos.first.caption],
                    previewGallery: allPhotoUrls,
                    cs: cs,
                  )
                else
                  // 多张：竖向逐张半宽贴左（自然宽高比），每张下方带各自的
                  // 图片描述（Coze 式一图一句），每张可点击，同一回复框内
                  // 可前后切换（预览图池用全部照片）。
                  MediaGallery(
                    urls: plainPhotos.map((p) => p.url).toList(),
                    aspects: plainPhotos.map((p) => p.aspect).toList(),
                    captions: plainPhotos.map((p) => p.caption).toList(),
                    previewGallery: allPhotoUrls,
                    cs: cs,
                  ),
              ],
            ),
          if (videos.isNotEmpty) ...<Widget>[
            if (photos.isNotEmpty) const SizedBox(height: 6),
            _VideoPanel(videos: videos, cs: cs),
          ],
        ],
      ),
    );
  }

  String? _firstNonEmpty(List<String?> values) {
    for (final String? value in values) {
      final String trimmed = value?.trim() ?? "";
      if (trimmed.isNotEmpty) return trimmed;
    }
    return null;
  }

  /// 对比列表头胶囊：左侧 A、右侧 B，突出对比维度，空标签显示「—」保持两列对齐。
  Widget _compareColumnHeader(String? label) {
    final String t = (label ?? "").trim();
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 5),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        t.isEmpty ? "—" : t,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          color: cs.primary,
        ),
      ),
    );
  }

  /// A/B 对比单格：图片按列宽等比占满（方形自适应），不携带说明文字，点击可预览；
  /// 该侧缺图时显示统一浅色「—」占位，与有图一侧等高对齐。
  Widget _compareCell(
    ({String url, double? aspect, String side, String? caption})? entry,
    List<String> gallery,
    BuildContext context,
  ) {
    if (entry == null) {
      return AspectRatio(
        aspectRatio: 1,
        child: Container(
          decoration: BoxDecoration(
            color: cs.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
          ),
          alignment: Alignment.center,
          child: Text(
            "—",
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w400,
              color: cs.onSurfaceVariant.withValues(alpha: 0.5),
            ),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        GestureDetector(
          onTap: () {
            ImagePreviewLauncher.open(
              url: entry.url,
              title: "图片预览",
              gallery: gallery,
              index: gallery.indexOf(entry.url),
              anchorContext: context,
            );
          },
          child: AspectRatio(
            aspectRatio: 1,
            child: MediaThumbnail(
              url: entry.url,
              cs: cs,
              width: double.infinity,
              borderRadius: 8,
            ),
          ),
        ),
      ],
    );
  }
}

/// 旅游行程海报卡：目的地风景背景 + 目的地简介 + 「打开行程规划」入口。
///
/// 与媒体卡同样采用静态回调桥接（[TravelPlanLauncher.open]）：点击入口后
/// 以独立界面（全屏路由 TravelPlanFullscreenPage）打开行程规划。
///
/// 设计（2026-10-15 用户反馈）：
///   - 卡面极简：海报 + 主入口按钮 + 脚注，不罗列 Day 摘要，也不放随身
///     物品叮嘱（「记得带」已撤下，打包建议留在行程规划面板里看）；
///   - 背景优先活取目的地当前封面（GET /travel/media/destination-cover，
///     服务端重选封面后历史卡片不改存量数据即自动换新图），未到达/无封面
///     退回卡片数据里烤死的封面与景点实拍，压深色渐变保证白字可读；
///     无图/加载失败退回深青渐变，不闪占位框；
///   - 无结构化 travelPlan 的历史消息优雅降级：简介行整体隐藏，
///     海报走渐变兜底，布局不破损。
class _TravelItineraryCard extends StatefulWidget {
  const _TravelItineraryCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  /// 海报兜底渐变（无图/图加载中/加载失败时露出）：深海军蓝 → 深青，
  /// 与强调色同族且不随主题切换 —— 海报文字恒为白字，深浅主题都成立。
  static const List<Color> _posterFallback = <Color>[
    Color(0xFF123243),
    Color(0xFF071A24),
  ];

  /// 海报背景：兜底渐变常驻底层，图片加载中/失败时自然露出，不闪占位框。
  /// （候选图逐张回退的有 State 版本见 [_PosterBackdrop]。）
  static const DecoratedBox posterFallback = DecoratedBox(
    decoration: BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: _posterFallback,
      ),
    ),
  );

  @override
  State<_TravelItineraryCard> createState() => _TravelItineraryCardState();
}

class _TravelItineraryCardState extends State<_TravelItineraryCard> {
  /// 目的地当前封面（活取）：服务端封面库的最新 URL；null=未到达/无封面。
  String? _liveCoverUrl;

  @override
  void initState() {
    super.initState();
    final String destination =
        TravelPlanData.from(widget.data).destination.trim();
    if (destination.isEmpty) return;
    TravelLiveCover.fetch(destination).then((String? url) {
      if (!mounted || url == null || url.isEmpty) return;
      setState(() => _liveCoverUrl = url);
      // 新封面与本地缓存链路对齐：落盘 + 内存解码预热，重开卡片秒开
      MediaDiskCache.instance.warm(<String>[url]);
      TravelImageWarmer.warm(<String>[url]);
    });
  }

  @override
  Widget build(BuildContext context) {
    final TravelPlanData plan = TravelPlanData.from(widget.data);
    final List<String> gallery = _collectImages(plan);
    final String? bakedPosterUrl = _pickPosterImage(plan);
    // 活取封面优先：服务端重选封面后，历史卡片自动换新图
    final String? posterUrl =
        (_liveCoverUrl != null && _liveCoverUrl!.isNotEmpty)
            ? _liveCoverUrl
            : bakedPosterUrl;
    if (posterUrl != null && !gallery.contains(posterUrl)) {
      gallery.insert(0, posterUrl);
    }
    // 海报候选链：当前封面优先，条目实拍跟随（封面加载失败自动落到下一张）
    final List<String> posterCandidates = <String>[
      if (posterUrl != null) posterUrl,
      for (final String img in gallery)
        if (img != posterUrl) img,
    ];
    // 图片预热（2026-10-13 根修）：此前只 warm 进程内存缓存（重启即空，
    // 且卡片上屏才触发 → 与首帧渲染赛跑），表现为「每次重开仍要等图」。
    // 现在双轨：MediaDiskCache 落盘预热（跨进程持久，重开卡片秒开）+
    // TravelImageWarmer 内存解码预热（同会话内滚动/重进零等待）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (context.mounted) {
        MediaDiskCache.instance.warm(posterCandidates);
        TravelImageWarmer.warm(posterCandidates);
      }
    });
    // 卡体强调色随 App 主题对齐（海报区压在照片上，保留恒定霓虹青）
    final TravelPalette palette = TravelPalette.of(context);

    // 天数口径由数据来源决定（plan.isStructured 记录 from() 实际走的分支）：
    // 结构化 travelPlan 的 days 即真实天（空天也是行程中的一天）；
    // 文本兜底时只数真正有条目的天（fromCard 可能补「全程」空骨架天）。
    final int dayCount = plan.isStructured
        ? plan.days.length
        : plan.days.where((TravelPlanDay d) => d.entries.isNotEmpty).length;
    final bool hasPlan = plan.days.any((TravelPlanDay d) => d.entries.isNotEmpty);

    return Container(
      constraints: const BoxConstraints(maxWidth: 460),
      decoration: BoxDecoration(
        color: widget.cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
        border:
            Border.all(color: widget.cs.outline.withValues(alpha: 0.22)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _buildPoster(context, plan, gallery, posterUrl, posterCandidates, dayCount),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // ── 卡面极简（2026-10-15 修订）：海报 + 主入口按钮 + 脚注；
                  // 逐日明细与打包建议都走「打开行程规划」面板（全量数据）。──
                  // ── 主入口按钮（实底强调色，压住卡底）──
                  if (hasPlan)
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: () => TravelPlanLauncher.open(widget.data),
                        style: FilledButton.styleFrom(
                          backgroundColor: palette.accentBg,
                          foregroundColor: palette.onAccentBg,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 9),
                          minimumSize: const Size(0, 40),
                        ),
                        icon: const Icon(Icons.travel_explore, size: 16),
                        label: const Text(
                          "打开行程规划",
                          style: TextStyle(
                              fontSize: 13.5, fontWeight: FontWeight.w700),
                        ),
                      ),
                    ),
                  if (widget.data.footer.trim().isNotEmpty) ...<Widget>[
                    const SizedBox(height: 8),
                    Text(
                      widget.data.footer.trim(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        height: 1.45,
                        color: widget.cs.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── 海报区：实拍背景 + 渐变遮罩 + 目的地徽章/天数/日期 + 标题/简介 ──

  Widget _buildPoster(
    BuildContext context,
    TravelPlanData plan,
    List<String> gallery,
    String? posterUrl,
    List<String> posterCandidates,
    int dayCount,
  ) {
    final String dateRange = _dateRangeLabel(plan);
    return GestureDetector(
      onTap: posterUrl == null
          ? null
          : () => ImagePreviewLauncher.open(
                url: posterUrl,
                title: plan.destination.isEmpty ? "行程海报" : plan.destination,
                gallery: gallery,
                index: gallery.indexOf(posterUrl),
                anchorContext: context,
              ),
      child: SizedBox(
        height: 200,
        width: double.infinity,
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            _PosterBackdrop(candidates: posterCandidates),
            // 压暗渐变：顶部轻压（徽章行可读）→ 中段几乎不压 → 底部重压（标题/简介可读）
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[
                    Color(0x66000000),
                    Color(0x14000000),
                    Color(0xE6000000),
                  ],
                  stops: <double>[0.0, 0.42, 1.0],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      _buildDestinationBadge(plan.destination),
                      if (dayCount > 0) ...<Widget>[
                        const SizedBox(width: 8),
                        Text(
                          "$dayCount 天行程",
                          style: TextStyle(
                            fontSize: 11.5,
                            color: Colors.white.withValues(alpha: 0.85),
                          ),
                        ),
                      ],
                      const Spacer(),
                      if (dateRange.isNotEmpty)
                        Text(
                          dateRange,
                          style: TextStyle(
                            fontSize: 11,
                            color: Colors.white.withValues(alpha: 0.72),
                          ),
                        ),
                    ],
                  ),
                  const Spacer(),
                  if (plan.title.isNotEmpty)
                    Text(
                      plan.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 16.5,
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                        height: 1.35,
                      ),
                    ),
                  if (plan.intro.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 5),
                    Text(
                      plan.intro,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        height: 1.5,
                        color: Colors.white.withValues(alpha: 0.82),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 目的地徽章（玻璃态：半透明黑底 + 白描边，压在海报上深浅图都可读）。
  Widget _buildDestinationBadge(String destination) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.32),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.map_outlined,
              size: 13, color: Colors.white.withValues(alpha: 0.92)),
          const SizedBox(width: 4),
          Text(
            destination,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: Colors.white,
            ),
          ),
        ],
      ),
    );
  }

  /// 收集行程实拍图（去重）：海报选取 + 点击预览画廊共用。
  /// 目的地代表性封面（plan.coverImage）排在最前——海报默认展示它，
  /// 画廊从封面起播才能与海报点击的图对齐。
  static List<String> _collectImages(TravelPlanData plan) {
    final List<String> urls = <String>[];
    final String cover = plan.coverImage.trim();
    if (cover.isNotEmpty) urls.add(cover);
    for (final TravelPlanDay day in plan.days) {
      for (final TravelDayEntry e in day.entries) {
        for (final String img in e.images) {
          if (!urls.contains(img)) urls.add(img);
        }
      }
    }
    return urls;
  }

  /// 海报图：优先目的地代表性封面（目的地本身的形象照，最具代表性且真实）；
  /// 未携带封面时退回第一个有实拍图的景点（attraction），其次任意有图条目；
  /// 全无图返回 null（走渐变兜底）。
  static String? _pickPosterImage(TravelPlanData plan) {
    final String cover = plan.coverImage.trim();
    if (cover.isNotEmpty) return cover;
    String? firstAny;
    for (final TravelPlanDay day in plan.days) {
      for (final TravelDayEntry e in day.entries) {
        if (e.images.isEmpty) continue;
        if (e.type == "attraction") return e.images.first;
        firstAny ??= e.images.first;
      }
    }
    return firstAny;
  }

  /// 日期区间短标签「09-05 ~ 09-09」：优先 startDate/endDate，兜底首尾天日期。
  static String _dateRangeLabel(TravelPlanData plan) {
    final List<String> dayDates = <String>[
      for (final TravelPlanDay d in plan.days)
        if (d.date.isNotEmpty) d.date,
    ];
    final String start = plan.startDate.isNotEmpty
        ? plan.startDate
        : (dayDates.isNotEmpty ? dayDates.first : "");
    final String end = plan.endDate.isNotEmpty
        ? plan.endDate
        : (dayDates.length > 1 ? dayDates.last : "");
    final String s = _shortDate(start);
    final String e = _shortDate(end);
    if (s.isEmpty) return "";
    if (e.isEmpty || e == s) return s;
    return "$s ~ $e";
  }

  /// YYYY-MM-DD → MM-DD；非该格式原样返回。
  static String _shortDate(String raw) {
    final String t = raw.trim();
    final RegExpMatch? m = RegExp(r'^\d{4}-(\d{2}-\d{2})').firstMatch(t);
    if (m != null) return m.group(1)!;
    return t;
  }
}

/// 海报背景（候选链版）：兜底渐变常驻底层；候选图从封面起逐张尝试，
/// 某张加载失败自动落到下一张条目实拍，全失败才露纯渐变——不再「封面一张
/// 挂掉就永远渐变」。加载中露渐变，不闪占位框。
class _PosterBackdrop extends StatefulWidget {
  const _PosterBackdrop({required this.candidates});

  /// 候选图 URL（已归一，封面在前）。
  final List<String> candidates;

  @override
  State<_PosterBackdrop> createState() => _PosterBackdropState();
}

class _PosterBackdropState extends State<_PosterBackdrop> {
  /// 已加载失败的候选 URL：按 URL 记（同一张失败的图在后续重建中重复回调
  /// errorBuilder 不会二次推进，避免跳过未尝试的候选）。
  final Set<String> _failed = <String>{};

  @override
  Widget build(BuildContext context) {
    final String? url = widget.candidates
        .where((String c) => !_failed.contains(c))
        .firstOrNull;
    if (url == null) return _TravelItineraryCard.posterFallback;
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        _TravelItineraryCard.posterFallback,
        CachedMediaImage(
          url: url,
          fit: BoxFit.cover,
          alignment: Alignment.center,
          errorBuilder: (_, Object __, StackTrace? ___) {
            _failed.add(url);
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) setState(() {});
            });
            return const SizedBox.shrink();
          },
          loadingBuilder: (BuildContext context) =>
              _TravelItineraryCard.posterFallback,
        ),
      ],
    );
  }
}

/// 轻量内联媒体行（无外层 card 边框）——给「renderBlocks 小簇」用。
///
/// 设计：服务端 `buildInterleavedRenderBlocks` 会把一次 `search_images` 的 N 张
/// 图自动按正文段落切分成 2-3 张的小簇（普通图墙不再一次性铺底）。
/// 这种小簇适合**紧贴文字**展示，不要再外面套一个完整 `AgentResultCard` 卡框，
/// 否则会出现「段落文字 → 大边框卡 → 段落文字」的割裂感，违反用户
/// 「一段介绍文字然后挨着放一两张图」的产品诉求。
///
/// 交给自适应画廊 [MediaGallery]：竖向逐张半宽贴左铺排（自然宽高比），
/// 每张照片下方带服务端视觉模型生成的真实图片描述（Coze 式一图一句），
/// 跟正文共用一个气泡，视觉上才是「文字+图」的自然交错。
class MediaInlineRow extends StatelessWidget {
  const MediaInlineRow({
    super.key,
    required this.items,
    required this.cs,
  });

  final List<AgentResultItem> items;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    // 解析每张图的可用地址 + 自然宽高比 + 侧标签 + 图片描述；视频单独收集走视频面板
    final List<({String url, double? aspect, String side, String? caption})> photos =
        <({String url, double? aspect, String side, String? caption})>[];
    final List<String> allUrls = <String>[];
    final List<
        ({
          String title,
          String? source,
          String? thumbnailUrl,
          String? openUrl,
          String? playableUrl,
        })> videos = <({String title, String? source, String? thumbnailUrl, String? openUrl, String? playableUrl})>[];
    for (final AgentResultItem it in items) {
      final String text = it.text.trim();
      final String? textUrl = LinkUtils.extractFirst(text);
      final String? previewUrl = _firstNonEmpty(<String?>[
        it.thumbnailUrl,
        it.mediaType == "video" ? null : it.mediaUrl,
        it.url,
        textUrl,
      ]);
      final String? openUrl = _firstNonEmpty(<String?>[
        it.pageUrl,
        it.url,
        it.mediaUrl,
        textUrl,
      ]);
      final bool isVideo = (it.mediaType ?? "").toLowerCase() == "video" ||
          (openUrl != null &&
              RegExp(r"(youtube\.com|youtu\.be|bilibili\.com|/video/)",
                      caseSensitive: false)
                  .hasMatch(openUrl));
      if (previewUrl == null && openUrl == null) continue;
      if (isVideo) {
        videos.add((
          title: text.isNotEmpty && text != "图片" ? text : (it.source ?? "相关视频"),
          source: it.source,
          thumbnailUrl: previewUrl,
          openUrl: openUrl,
          playableUrl: it.playableUrl,
        ));
      } else {
        final String resolved = LinkUtils.resolveMediaUrl(previewUrl!);
        if (allUrls.contains(resolved)) continue;
        photos.add((
          url: resolved,
          aspect: it.naturalAspect,
          side: (it.side ?? "").trim(),
          caption: (it.caption ?? "").trim().isEmpty ? null : it.caption!.trim(),
        ));
        allUrls.add(resolved);
      }
    }
    if (photos.isEmpty && videos.isEmpty) return const SizedBox.shrink();
    // 照片走自适应画廊：竖向逐张半宽贴左展示，每张下方带各自的图片描述
    // （服务端视觉模型看图生成；未生成时不显示文字）。
    // 视频走与照片同风格的面板：单条→16:9 大图带播放角标；多条→2 列网格。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (photos.isNotEmpty)
          MediaGallery(
            urls: allUrls,
            aspects: photos.map((p) => p.aspect).toList(),
            captions: photos.map((p) => p.caption).toList(),
            previewGallery: allUrls,
            cs: cs,
          ),
        if (videos.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(top: photos.isNotEmpty ? 6 : 0),
            child: _VideoPanel(videos: videos, cs: cs),
          ),
      ],
    );
  }

  String? _firstNonEmpty(List<String?> values) {
    for (final String? v in values) {
      final String t = (v ?? "").trim();
      if (t.isNotEmpty) return t;
    }
    return null;
  }
}

/// 视频面板：与照片画廊同风格的网格/大图展示（替代旧的「左图右文字」列表行）。
///
/// 设计：视频结果也走「同照片一样面板展示」的产品诉求——
///   - 单条：全宽 16:9 hero 大图，带播放角标；
///   - 多条：2 列方图网格（与照片网格一致），每格带播放角标 + 标题。
/// 缩略图为空时显示视频占位图标（后端已保证不下发播放页/搜索页 URL 当图），
/// 点击整卡打开播放页。
class _VideoPanel extends StatelessWidget {
  const _VideoPanel({required this.videos, required this.cs});

  final List<
      ({
        String title,
        String? source,
        String? thumbnailUrl,
        String? openUrl,
        String? playableUrl,
      })> videos;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    if (videos.isEmpty) return const SizedBox.shrink();
    if (videos.length == 1) {
      return _VideoTile(video: videos.first, cs: cs, hero: true);
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        const double spacing = 6;
        const int cols = 2;
        final double cell =
            (constraints.maxWidth - spacing * (cols - 1)) / cols;
        return Wrap(
          spacing: spacing,
          runSpacing: 8,
          children: <Widget>[
            for (final v in videos)
              SizedBox(
                width: cell,
                child: _VideoTile(video: v, cs: cs),
              ),
          ],
        );
      },
    );
  }
}

class _VideoTile extends StatelessWidget {
  const _VideoTile({required this.video, required this.cs, this.hero = false});

  final ({
    String title,
    String? source,
    String? thumbnailUrl,
    String? openUrl,
    String? playableUrl,
  }) video;
  final ColorScheme cs;
  final bool hero;

  @override
  Widget build(BuildContext context) {
    // 有可播流 → 右侧双栏面板内联播放；无流只能打开播放页（角标同步区分，
    // 避免用户点了才发现被带到浏览器）。
    final String? playable = (video.playableUrl ?? "").trim().isNotEmpty
        ? LinkUtils.resolveMediaUrl(video.playableUrl!.trim())
        : null;
    final Widget thumb = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: AspectRatio(
        aspectRatio: hero ? 16 / 9 : 1,
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            if (video.thumbnailUrl != null &&
                video.thumbnailUrl!.trim().isNotEmpty)
              MediaThumbnail(
                url: LinkUtils.resolveMediaUrl(video.thumbnailUrl!),
                cs: cs,
                errorIcon: Icons.video_file_outlined,
                borderRadius: 0,
              )
            else
              Container(
                color: cs.surfaceContainerHighest,
                alignment: Alignment.center,
                child: Icon(
                  Icons.video_file_outlined,
                  color: cs.onSurfaceVariant,
                  size: 30,
                ),
              ),
            Center(
              child: Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.45),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  playable != null
                      ? Icons.play_arrow_rounded
                      : Icons.open_in_new_rounded,
                  color: Colors.white,
                  size: playable != null ? 26 : 18,
                ),
              ),
            ),
          ],
        ),
      ),
    );

    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        thumb,
        if (video.title.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              video.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
                height: 1.3,
              ),
            ),
          ),
      ],
    );

    // 有可播流 → 右侧双栏面板内联播放（不跳浏览器）；无流才降级打开播放页。
    final String? openUrl = video.openUrl;
    if (playable == null && openUrl == null) return body;
    return InkWell(
      onTap: () {
        if (playable != null) {
          VideoPreviewLauncher.open(url: playable, pageUrl: openUrl);
          return;
        }
        _launchUrl(openUrl!);
      },
      borderRadius: BorderRadius.circular(8),
      child: body,
    );
  }
}

/// 顶层转发：卡片内多处 fire-and-forget 打开链接（媒体地址先拼绝对 URL）。
Future<void> _launchUrl(String url) =>
    LinkUtils.launchExternal(LinkUtils.resolveMediaUrl(url));

/// 搜索结果卡片 —— 把搜索工具返回的列表项渲染为垂直排列的新闻条目。
///
/// 每个 item 解析为「标题 —— 描述」格式，渲染为：
///   - 标题（粗体，可点击跳转）
///   - 摘要（灰色小字）
///   - 来源/时间（更小文字）
///
/// 适合搜索/资讯聚合场景，3~10 条垂直排列，清晰可读。
class _SearchResultCard extends StatelessWidget {
  const _SearchResultCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 标题头
          if (data.title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: <Widget>[
                  SoftIconChip(
                    icon: Icons.travel_explore_outlined,
                    color: cs.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      data.title,
                      style: textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // 条目列表
          ...data.items.map((AgentResultItem it) {
            final (String t, String d) = _splitSearchItem(it.text);
            final bool hasUrl = it.url != null && it.url!.isNotEmpty;
            final String? detectedUrl = hasUrl ? it.url : LinkUtils.extractFirst(d);
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: InkWell(
                onTap: detectedUrl == null
                    ? null
                    : () => _launchUrl(detectedUrl),
                borderRadius: BorderRadius.circular(6),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      // 标题行
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Container(
                            margin: const EdgeInsets.only(top: 5),
                            width: 5,
                            height: 5,
                            decoration: BoxDecoration(
                              color: cs.primary.withValues(alpha: 0.55),
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text.rich(
                              TextSpan(
                                style: textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                  height: 1.35,
                                ),
                                children: parseInlineMarkdownSpans(
                                  t,
                                  textTheme.bodyMedium!.copyWith(
                                    fontWeight: FontWeight.w700,
                                    height: 1.35,
                                  ),
                                  cs,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                      // 摘要/描述
                      if (d.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(left: 13, top: 3),
                          child: Text.rich(
                            TextSpan(
                              style: textTheme.bodySmall?.copyWith(
                                color: cs.onSurfaceVariant,
                                height: 1.45,
                                fontSize: 13,
                              ),
                              children: parseInlineMarkdownSpans(
                                d,
                                textTheme.bodySmall!.copyWith(
                                  color: cs.onSurfaceVariant,
                                  height: 1.45,
                                  fontSize: 13,
                                ),
                                cs,
                              ),
                            ),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            );
          }),
          if (data.footer.isNotEmpty)
            Container(
              padding: const EdgeInsets.only(top: 6),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                data.footer,
                textTheme.bodySmall!.copyWith(
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
        ],
      ),
    );
  }

  /// 把 item 文本拆成「标题 —— 描述」。
  (String, String) _splitSearchItem(String raw) {
    final int sep = _findTitleSep(raw);
    if (sep <= 0) return (raw, "");
    return (raw.substring(0, sep).trim(), raw.substring(sep).trim());
  }

  Future<void> _launchUrl(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }
}

/// 购物建议「二分化对比卡」（shopping.suggest → cardType=product_compare）。
///
/// 版式：分侧大图头部（商品图/试色图左右并排，底部渐变浮层放品名+参考价）
/// → 每侧依据(check)/注意点(warn) → 转置参数对比表（维度为行）→ 试色/评测视频
/// 入口 → footer。全部数据来自商品库工具回执，由服务端 tool-card-registry
/// 确定性构建，LLM 口头回复只作前导正文。
class _ProductCompareCard extends StatelessWidget {
  const _ProductCompareCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  static const Color _accent = Color(0xFF7FD4A0);
  static const Color _warn = Color(0xFFE5B567);

  @override
  Widget build(BuildContext context) {
    final List<AgentResultCardSide> sides = data.sides.isEmpty
        ? const <AgentResultCardSide>[]
        : data.sides;

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 11, 13, 10),
            child: Row(
              children: <Widget>[
                const Icon(Icons.compare_rounded,
                    size: 15, color: _accent),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                Text(
                  "数据来自商品库",
                  style: TextStyle(
                      fontSize: 10, color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
          if (sides.isNotEmpty)
            sides.length == 2
                ? IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        Expanded(child: _sidePane(sides.first)),
                        Container(width: 1, color: cs.outline.withValues(alpha: 0.16)),
                        Expanded(child: _sidePane(sides.last)),
                      ],
                    ),
                  )
                : SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: <Widget>[
                        for (final AgentResultCardSide s in sides)
                          SizedBox(width: 150, child: _sidePane(s)),
                      ],
                    ),
                  ),
          if (data.compare != null) _compareSection(),
          if (data.videos.isNotEmpty) _videoSection(),
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 8, 13, 10),
              child: Text(
                data.footer,
                style: TextStyle(
                    fontSize: 10.5, color: cs.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }

  /// 分侧面板：大图（上色效果/产品图）+ 浮层品名价格 + 该侧依据/注意点
  Widget _sidePane(AgentResultCardSide side) {
    final List<AgentResultItem> sideItems = data.items
        .where((AgentResultItem it) => it.side == side.side)
        .toList(growable: false);

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (side.image != null)
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Stack(
                children: <Widget>[
                  AspectRatio(
                    aspectRatio: 0.74,
                    child: CachedMediaImage(
                      url: LinkUtils.resolveMediaUrl(side.image!),
                      fit: BoxFit.cover,
                      filterQuality: FilterQuality.low,
                      errorBuilder: (_, __, ___) => _imageFallback(),
                      loadingBuilder: (BuildContext context) => Container(
                        color: cs.surfaceContainerHighest,
                        alignment: Alignment.center,
                        child: const CircularProgressIndicator(
                            strokeWidth: 1.6),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: Container(
                      padding: const EdgeInsets.fromLTRB(8, 16, 8, 7),
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Colors.transparent, Color(0xE6000000)],
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            side.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: Colors.white),
                          ),
                          if (side.priceLabel != null &&
                              side.priceLabel!.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                side.priceLabel!,
                                style: const TextStyle(
                                    fontSize: 10.5, color: _accent),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            )
          else
            _SideHeader(label: side.label),
          const SizedBox(height: 7),
          for (final AgentResultItem it in sideItems)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(
                    it.type == "warn"
                        ? Icons.priority_high_rounded
                        : Icons.check_rounded,
                    size: 11,
                    color: it.type == "warn" ? _warn : _accent,
                  ),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      it.text,
                      style: TextStyle(
                          fontSize: 11.5,
                          height: 1.5,
                          color: cs.onSurface.withValues(alpha: 0.82)),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _imageFallback() => Container(
        color: cs.surfaceContainerHighest,
        alignment: Alignment.center,
        child: Icon(Icons.image_outlined,
            size: 20, color: cs.onSurfaceVariant),
      );

  Widget _compareSection() {
    final AgentResultCompareTable cmp = data.compare!;
    if (cmp.rows.isEmpty) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: cs.outline.withValues(alpha: 0.16)),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              "参 数 对 比",
              style: TextStyle(
                  fontSize: 9.5,
                  letterSpacing: 2.2,
                  color: cs.onSurfaceVariant),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              border: Border.all(color: cs.outline.withValues(alpha: 0.2)),
              borderRadius: BorderRadius.circular(9),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    _cell("维度", header: true, fixed: 62),
                    for (final AgentResultCardSide s in data.sides)
                      Expanded(
                        child: _cell(shortName(s.label), header: true),
                      ),
                  ],
                ),
                for (final MapEntry<String, List<String>> row in cmp.rows)
                  Container(
                    decoration: BoxDecoration(
                      border: Border(
                        top: BorderSide(
                            color: cs.outline.withValues(alpha: 0.14)),
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        _cell(row.key, header: true, fixed: 62),
                        for (final String v in row.value)
                          Expanded(child: _cell(v, maxLines: 4)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String shortName(String label) {
    // 长名截短：截去「（…）」注释部分
    final int paren = label.indexOf("（");
    return paren > 0 ? label.substring(0, paren) : label;
  }

  Widget _cell(String text,
      {bool header = false, int maxLines = 1, double? fixed}) {
    final Widget content = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
      child: Text(
        text,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 10.5,
          height: 1.4,
          color: header
              ? cs.onSurfaceVariant
              : cs.onSurface.withValues(alpha: 0.88),
        ),
      ),
    );
    final Widget cell = header
        ? Container(color: cs.surfaceContainerHighest, child: content)
        : content;
    return fixed != null
        ? SizedBox(width: fixed, child: cell)
        : Expanded(child: cell);
  }

  Widget _videoSection() {
    return Container(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: cs.outline.withValues(alpha: 0.16)),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              "视 频 介 绍（真 实 体 验）",
              style: TextStyle(
                  fontSize: 9.5,
                  letterSpacing: 2.2,
                  color: cs.onSurfaceVariant),
            ),
          ),
          for (final AgentResultCardVideo v in data.videos)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Material(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(9),
                child: InkWell(
                  borderRadius: BorderRadius.circular(9),
                  onTap: v.url == null
                      ? null
                      : () => launchUrl(
                            Uri.parse(LinkUtils.resolveMediaUrl(v.url!)),
                            mode: LaunchMode.externalApplication,
                          ),
                  child: Padding(
                    padding: const EdgeInsets.all(7),
                    child: Row(
                      children: <Widget>[
                        Container(
                          width: 26,
                          height: 26,
                          decoration: BoxDecoration(
                            color: const Color(0xFF131D17),
                            shape: BoxShape.circle,
                            border: Border.all(color: const Color(0xFF2C3A31)),
                          ),
                          child: const Icon(Icons.play_arrow_rounded,
                              size: 16, color: _accent),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            v.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 11.5,
                                height: 1.4,
                                color: cs.onSurface.withValues(alpha: 0.88)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 无图分侧的兜底表头（图片缺载时仍保留品名行）
class _SideHeader extends StatelessWidget {
  const _SideHeader({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// 简报卡在聊天流里的容器（morning_briefing cardType）。
///
/// 内容复用 [MorningBriefingCard]（与兜底 Dialog 同一组件，视觉一致）；
/// 外层限宽到聊天气泡密度，避免宽屏拉成横幅。
class _MorningBriefingChatCard extends StatelessWidget {
  const _MorningBriefingChatCard({
    required this.briefing,
    required this.cs,
    this.modeLabel,
  });

  final Map<String, dynamic> briefing;
  final ColorScheme cs;
  final String? modeLabel;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 430),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: MorningBriefingCard(
          briefing: briefing,
          modeLabel: modeLabel,
        ),
      ),
    );
  }
}
