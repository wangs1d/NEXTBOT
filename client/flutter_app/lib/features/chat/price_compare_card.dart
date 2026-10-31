import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/link_utils.dart";
import "media_thumbnail.dart";

/// price_compare 卡（跨平台实时比价，shopping.compare.prices → 服务端
/// tool-card-registry 确定性直出）：标题行 + 分组报价列表（大图 + 大号价格 +
/// 平台 chip + 店铺/同款标注）。卡片只展示结果，不承载网页跳转。
/// 数据字段见 [AgentResultPriceCompare] / [AgentResultPriceGroup]。
///
/// 视觉语言与 ProductPickCard 同族（圆角 12 / surfaceContainerHigh /
/// outline 细边 / 同一强调色），保持聊天流内商品卡的一致性。
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
            padding: const EdgeInsets.fromLTRB(13, 11, 13, 10),
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
          // 分组报价列表（服务端按价格升序）；仅当 bestIndex 指向该组才打
          // 「最低价」章（各组规格不一致时 bestIndex 为 null，不冒充同规格比价）
          for (int i = 0; i < compare.groups.length; i++)
            _PriceGroupRow(
              group: compare.groups[i],
              isBest: compare.bestIndex == i,
              cs: cs,
            ),
          // 免责说明 footer
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 8, 13, 11),
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
}

/// 单个平台分组的报价行：52px 缩略图 + 价格/平台/同款标注 + 品名 + 店铺。
class _PriceGroupRow extends StatelessWidget {
  const _PriceGroupRow({
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
    final String? image =
        (group.image ?? "").isNotEmpty ? LinkUtils.resolveMediaUrl(group.image!) : null;
    final String priceText =
        group.priceCny != null ? "¥${_fmtPrice(group.priceCny!)}" : "价格待查";

    final Widget row = Padding(
      padding: const EdgeInsets.fromLTRB(13, 6, 13, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          if (image != null) ...<Widget>[
            MediaThumbnail(url: image, cs: cs, width: 52, height: 52),
            const SizedBox(width: 10),
          ] else ...<Widget>[
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              alignment: Alignment.center,
              child: Icon(Icons.shopping_bag_outlined,
                  size: 20, color: cs.onSurfaceVariant),
            ),
            const SizedBox(width: 10),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                // 价格 + 平台 chip + 标注
                Row(
                  children: <Widget>[
                    Text(
                      priceText,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                      ),
                    ),
                    if (isBest) ...<Widget>[
                      const SizedBox(width: 6),
                      _chip("最低价", _accent, foreground: Colors.black87),
                    ],
                    const SizedBox(width: 6),
                    _chip(group.platform, cs.outline.withValues(alpha: 0.18)),
                    if (group.similar) ...<Widget>[
                      const SizedBox(width: 5),
                      _chip("疑似同款", _warn.withValues(alpha: 0.22),
                          foreground: Colors.black87),
                    ],
                  ],
                ),
                if (group.title.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 3),
                  Text(
                    group.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      color: cs.onSurface.withValues(alpha: 0.82),
                      height: 1.35,
                    ),
                  ),
                ],
                if ((group.shop ?? "").isNotEmpty || group.offerCount > 1) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    <String>[
                      if ((group.shop ?? "").isNotEmpty) group.shop!,
                      if (group.offerCount > 1) "等${group.offerCount}家",
                    ].join(" · "),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
    return row;
  }

  /// 价格千分位（整数部分），¥1884 → ¥1,884 不做（比价卡保持与报价一致的裸数字）。
  static String _fmtPrice(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);

  Widget _chip(String label, Color background, {Color? foreground}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          color: foreground ?? cs.onSurfaceVariant,
        ),
      ),
    );
  }
}
