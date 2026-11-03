import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";

/// price_compare 卡（跨平台实时比价，shopping.compare.prices → 服务端
/// tool-card-registry 确定性直出）：标题行 + **表格版式**报价
/// （表头 平台/商品/价格 + 逐行报价 + 最低价行高亮）+ 底部结论横幅
/// （同规格可比时明确给出「哪个平台最便宜、省多少」；规格不可比时如实说明，
/// 不冒充结论）。卡片只展示结果，不承载网页跳转。
///
/// 2026-11-02 改版：弃用大图列表（视觉噪音大、横向扫价格困难），改为表格——
/// 价格列右对齐纵向对齐，比价一眼可比；并新增结论行回应用户
/// 「比价就要有结论」的诉求。
///
/// 数据字段见 [AgentResultPriceCompare] / [AgentResultPriceGroup]。
class PriceCompareCard extends StatelessWidget {
  const PriceCompareCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  static const Color _accent = Color(0xFF7FD4A0);

  @override
  Widget build(BuildContext context) {
    final AgentResultPriceCompare? compare = data.priceCompare;
    if (compare == null || compare.groups.isEmpty) {
      return const SizedBox.shrink();
    }

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
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 标题行：图标 + 比价对象 + 报价组数
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 11, 13, 8),
            child: Row(
              children: <Widget>[
                const Icon(Icons.price_change_rounded,
                    size: 15, color: _accent),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    data.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                Text(
                  "${compare.groups.length} 组报价",
                  style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
          // 表头（平台 / 商品 / 价格）
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 0, 13, 4),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: 52,
                  child: Text("平台",
                      style: TextStyle(
                          fontSize: 10, color: cs.onSurfaceVariant)),
                ),
                Expanded(
                  child: Text("商品（同款分组最低价）",
                      style: TextStyle(
                          fontSize: 10, color: cs.onSurfaceVariant)),
                ),
                Text("价格",
                    style:
                        TextStyle(fontSize: 10, color: cs.onSurfaceVariant)),
              ],
            ),
          ),
          // 报价表格行（服务端按价格升序）；仅 bestIndex 指向的行打「最低」
          //（各组规格不一致时 bestIndex 为 null，不冒充同规格比价）
          for (int i = 0; i < compare.groups.length; i++)
            _PriceTableRow(
              group: compare.groups[i],
              isBest: compare.bestIndex == i,
              cs: cs,
            ),
          // 结论横幅：比价必须给结论——同规格可比时点名最低价平台与价差
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
            child: _ConclusionBanner(
              groups: compare.groups,
              bestIndex: compare.bestIndex,
              accent: _accent,
              cs: cs,
            ),
          ),
          // 免责说明 footer
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 6, 13, 11),
              child: Text(
                data.footer,
                style: TextStyle(
                    fontSize: 10.5, color: cs.onSurfaceVariant),
              ),
            ),
          if (data.footer.isEmpty) const SizedBox(height: 11),
        ],
      ),
    );
  }
}

/// 表格一行：平台徽标（固定列宽）| 品名 + 店铺/规格副行 | 价格（右对齐）。
/// 最低价行整行淡绿底 + 「最低」章，纵向扫价格列即可横向比价。
class _PriceTableRow extends StatelessWidget {
  const _PriceTableRow({
    required this.group,
    required this.isBest,
    required this.cs,
  });

  final AgentResultPriceGroup group;
  final bool isBest;
  final ColorScheme cs;

  static const Color _accent = Color(0xFF7FD4A0);
  static const Color _warn = Color(0xFFE5B567);

  @override
  Widget build(BuildContext context) {
    final String priceText =
        group.priceCny != null ? "¥${_fmtPrice(group.priceCny!)}" : "待查";

    return Container(
      color: isBest ? _accent.withValues(alpha: 0.10) : null,
      padding: const EdgeInsets.fromLTRB(13, 6, 13, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          // 平台列（固定宽度，徽标 + 中文来源名）
          SizedBox(
            width: 52,
            child: _PlatformBadge(
                platform: group.platform, label: group.sourceLabel),
          ),
          // 商品列：品名一行 + 店铺/规格/标注副行
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (group.title.isNotEmpty)
                  Text(
                    group.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      color: cs.onSurface.withValues(alpha: 0.85),
                      height: 1.3,
                    ),
                  ),
                Wrap(
                  spacing: 5,
                  runSpacing: 2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    if ((group.shop ?? "").isNotEmpty)
                      Text(
                        group.shop!,
                        style: TextStyle(
                            fontSize: 10.5, color: cs.onSurfaceVariant),
                      ),
                    if (group.offerCount > 1)
                      Text(
                        "等${group.offerCount}家",
                        style: TextStyle(
                            fontSize: 10.5, color: cs.onSurfaceVariant),
                      ),
                    for (final String spec in group.specTokens.take(1))
                      _chip(spec.toUpperCase(),
                          cs.outline.withValues(alpha: 0.18)),
                    if (group.similar)
                      _chip("疑似同款", _warn.withValues(alpha: 0.22),
                          foreground: Colors.black87),
                  ],
                ),
              ],
            ),
          ),
          // 价格列（右对齐 + 最低价章）
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                priceText,
                style: TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w700,
                  color: isBest ? _accent : cs.onSurface,
                ),
              ),
              if (isBest) ...<Widget>[
                const SizedBox(width: 4),
                _chip("最低", _accent, foreground: Colors.black87),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// 价格千分位（整数部分），¥1884 → ¥1,884 不做（比价卡保持与报价一致的裸数字）。
  static String _fmtPrice(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);

  Widget _chip(String label, Color background, {Color? foreground}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 9.5,
          color: foreground ?? cs.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// 结论横幅：同规格可比 → 「{平台}最低 ¥X，比次低省 ¥Y」；
/// 各组规格不一致 → 如实说明只列报价不作最低价结论（不冒充比价）。
class _ConclusionBanner extends StatelessWidget {
  const _ConclusionBanner({
    required this.groups,
    required this.bestIndex,
    required this.accent,
    required this.cs,
  });

  final List<AgentResultPriceGroup> groups;
  final int? bestIndex;
  final Color accent;
  final ColorScheme cs;

  String get _text {
    if (bestIndex == null || bestIndex! >= groups.length) {
      return groups.length > 1
          ? "各组规格不一致（如容量/型号不同），仅列报价不作最低价结论"
          : "仅一组报价，无从比较";
    }
    final best = groups[bestIndex!];
    final String bestLabel = best.sourceLabel;
    final double? bestPrice = best.priceCny;
    if (bestPrice == null) return "最低报价暂缺价格，建议登录后重试补价";
    // 次低价：除最佳组外，取各组最低价中的最小值
    double? runnerUp;
    for (int i = 0; i < groups.length; i++) {
      if (i == bestIndex) continue;
      final p = groups[i].priceCny;
      if (p != null && (runnerUp == null || p < runnerUp)) runnerUp = p;
    }
    final String diff =
        runnerUp != null && runnerUp > bestPrice ? "，比次低省 ¥${_fmt(runnerUp - bestPrice)}" : "";
    return "结论：$bestLabel 最低 ¥${_fmt(bestPrice)}$diff";
  }

  static String _fmt(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);

  @override
  Widget build(BuildContext context) {
    final bool hasConclusion = bestIndex != null && bestIndex! < groups.length;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
      decoration: BoxDecoration(
        color: hasConclusion ? accent.withValues(alpha: 0.12) : cs.outline.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        children: <Widget>[
          Icon(
            hasConclusion ? Icons.emoji_events_rounded : Icons.info_outline_rounded,
            size: 13,
            color: hasConclusion ? accent : cs.onSurfaceVariant,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              _text,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: hasConclusion ? FontWeight.w600 : FontWeight.w400,
                color: hasConclusion ? cs.onSurface : cs.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 平台来源徽标：品牌色圆形字标（图标）+ 中文来源名（注明来源）。
///
/// 无品牌映射的平台回退来源名首字 + 主题中性色，保证任何平台都有可辨识图标。
class _PlatformBadge extends StatelessWidget {
  const _PlatformBadge({required this.platform, required this.label});

  final String platform;
  final String label;

  /// 品牌字标（单字）+ 品牌色。颜色取各平台品牌主色。
  static const Map<String, Map<String, String>> _brand = <String, Map<String, String>>{
    "jd": <String, String>{"char": "京", "color": "E1251B"},
    "taobao": <String, String>{"char": "淘", "color": "FF5E00"},
    "tmall": <String, String>{"char": "猫", "color": "FF0036"},
    "pdd": <String, String>{"char": "拼", "color": "E02E24"},
    "meituan": <String, String>{"char": "美", "color": "FFC300"},
    "dianping": <String, String>{"char": "评", "color": "FF6633"},
    "douyin": <String, String>{"char": "抖", "color": "161823"},
  };

  static Color _fromHex(String hex) => Color(int.parse("FF$hex", radix: 16));

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Map<String, String>? brand = _brand[platform];
    final Color bg = brand != null
        ? _fromHex(brand["color"]!)
        : cs.onSurfaceVariant.withValues(alpha: 0.85);
    final String char =
        brand?["char"] ?? (label.isNotEmpty ? label.characters.first : "?");
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 14,
          height: 14,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
          alignment: Alignment.center,
          child: Text(
            char,
            style: const TextStyle(
              fontSize: 9,
              height: 1,
              fontWeight: FontWeight.w700,
              color: Colors.white,
            ),
          ),
        ),
        const SizedBox(width: 3),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}
