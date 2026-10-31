import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";
import "media_thumbnail.dart";

/// product_pick 卡（立场化推荐，shopping.suggest → 服务端 tool-card-registry
/// 确定性直出）：主推大图区（为什么是它 + 渠道实时价）+ 备选横滑区
/// （什么时候选它）。卡片只展示结果，不承载网页跳转。
/// 数据字段见 [AgentResultPick]/[AgentResultPickAlt]。
///
/// 视觉语言与 _ProductCompareCard 同族（圆角 12 / surfaceContainerHigh /
/// outline 细边 / 同一强调色），保持聊天流内商品卡的一致性。
class ProductPickCard extends StatelessWidget {
  const ProductPickCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  static const Color _accent = Color(0xFF7FD4A0);
  static const Color _warn = Color(0xFFE5B567);

  @override
  Widget build(BuildContext context) {
    final AgentResultPick? pick = data.pick;
    if (pick == null) return const SizedBox.shrink();

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
                const Icon(Icons.workspace_premium_rounded,
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
                  data.pick!.headline == null ? "商品库推荐" : "按你推荐",
                  style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
          _PickHero(pick: pick, cs: cs),
          if (data.ugc != null) ...<Widget>[
            Container(height: 1, color: cs.outline.withValues(alpha: 0.16)),
            _UgcSection(ugc: data.ugc!, cs: cs),
          ],
          if (data.alternatives.isNotEmpty) ...<Widget>[
            Container(height: 1, color: cs.outline.withValues(alpha: 0.16)),
            _AlternativesStrip(alts: data.alternatives, cs: cs),
          ],
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

/// 主推区：大图 + 为什么是它 + 依据/注意点 + 渠道实时价。
class _PickHero extends StatelessWidget {
  const _PickHero({required this.pick, required this.cs});

  final AgentResultPick pick;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 0, 13, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if ((pick.image ?? "").isNotEmpty)
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: SizedBox(
                width: double.infinity,
                height: 150,
                child: MediaThumbnail(url: pick.image!, cs: cs),
              ),
            ),
          if ((pick.headline ?? "").isNotEmpty) ...<Widget>[
            const SizedBox(height: 9),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  margin: const EdgeInsets.only(top: 2),
                  padding: const EdgeInsets.symmetric(
                      horizontal: 6, vertical: 1.5),
                  decoration: BoxDecoration(
                    color: ProductPickCard._accent.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text(
                    "为什么是它",
                    style: TextStyle(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w600,
                      color: ProductPickCard._accent,
                    ),
                  ),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    pick.headline!,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                      height: 1.35,
                    ),
                  ),
                ),
              ],
            ),
          ],
          for (final String r in pick.reasons)
            _ReasonRow(
              icon: Icons.check_circle_outline_rounded,
              color: ProductPickCard._accent,
              text: r,
              cs: cs,
            ),
          for (final String c in pick.cautions)
            _ReasonRow(
              icon: Icons.error_outline_rounded,
              color: ProductPickCard._warn,
              text: c,
              cs: cs,
            ),
          if (pick.channels.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: <Widget>[
                for (final AgentResultPickChannel ch in pick.channels)
                  _ChannelChip(channel: ch, cs: cs),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 依据/注意点行。
class _ReasonRow extends StatelessWidget {
  const _ReasonRow({
    required this.icon,
    required this.color,
    required this.text,
    required this.cs,
  });

  final IconData icon;
  final Color color;
  final String text;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, size: 13, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontSize: 11.5,
                color: cs.onSurface.withValues(alpha: 0.85),
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 渠道实时价 chip（只展示渠道与价格，不做跳转）。
class _ChannelChip extends StatelessWidget {
  const _ChannelChip({required this.channel, required this.cs});

  final AgentResultPickChannel channel;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final Widget label = Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(
            text: channel.name,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: cs.onSurfaceVariant,
            ),
          ),
          const TextSpan(text: "  "),
          TextSpan(
            text: "¥${channel.priceCny % 1 == 0 ? channel.priceCny.toStringAsFixed(0) : channel.priceCny.toStringAsFixed(2)}",
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: cs.onSurface,
            ),
          ),
        ],
      ),
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      child: label,
    );
  }
}

/// 真实口碑区：小红书 UGC 摘要（服务端聚合，好评/避雷 + 来源帖标题）。
/// 数据来自真实帖子标题（服务端规则抽取，LLM 不生成内容）；卡内只展示，
/// 不承载来源链接。
class _UgcSection extends StatelessWidget {
  const _UgcSection({required this.ugc, required this.cs});

  final AgentResultUgc ugc;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 10, 13, 11),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.forum_rounded, size: 13, color: Color(0xFFE57A9B)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  "真实口碑 · ${ugc.platformLabel ?? "UGC"}",
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
              if (ugc.mentions > 0)
                Text(
                  "${ugc.mentions} 篇提及",
                  style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                ),
            ],
          ),
          const SizedBox(height: 7),
          for (final String p in ugc.pros)
            _UgcLine(
              tag: "好评",
              tagColor: ProductPickCard._accent,
              text: p,
              cs: cs,
            ),
          for (final String c in ugc.cons)
            _UgcLine(
              tag: "避雷",
              tagColor: ProductPickCard._warn,
              text: c,
              cs: cs,
            ),
          if (ugc.posts.isNotEmpty) ...<Widget>[
            const SizedBox(height: 5),
            Wrap(
              spacing: 6,
              runSpacing: 5,
              children: <Widget>[
                for (final AgentResultUgcPost post in ugc.posts)
                  _UgcSourceChip(post: post, cs: cs),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 单条口碑行：好评/避雷标签 + 帖子标题摘要。
class _UgcLine extends StatelessWidget {
  const _UgcLine({
    required this.tag,
    required this.tagColor,
    required this.text,
    required this.cs,
  });

  final String tag;
  final Color tagColor;
  final String text;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            margin: const EdgeInsets.only(top: 1),
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
              color: tagColor.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              tag,
              style: TextStyle(
                fontSize: 9,
                fontWeight: FontWeight.w700,
                color: tagColor,
              ),
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                color: cs.onSurface.withValues(alpha: 0.82),
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 口碑来源帖 chip（只展示帖子标题，不做跳转）。
class _UgcSourceChip extends StatelessWidget {
  const _UgcSourceChip({required this.post, required this.cs});

  final AgentResultUgcPost post;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      child: SizedBox(
        width: 128,
        child: Text(
          post.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 10,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// 备选横滑区：「什么时候选它」差异化定位。
class _AlternativesStrip extends StatelessWidget {
  const _AlternativesStrip({required this.alts, required this.cs});

  final List<AgentResultPickAlt> alts;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 10, 13, 11),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            "备选 · 什么时候选它",
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 132,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: alts.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (BuildContext context, int i) => _AltTile(
                alt: alts[i],
                cs: cs,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AltTile extends StatelessWidget {
  const _AltTile({required this.alt, required this.cs});

  final AgentResultPickAlt alt;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 168,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: cs.outline.withValues(alpha: 0.16)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: (alt.image ?? "").isNotEmpty
                ? ClipRRect(
                    borderRadius: BorderRadius.circular(7),
                    child: SizedBox(
                      width: double.infinity,
                      child: MediaThumbnail(url: alt.image!, cs: cs),
                    ),
                  )
                : Container(
                    decoration: BoxDecoration(
                      color: cs.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    alignment: Alignment.center,
                    child: Icon(Icons.shopping_bag_outlined,
                        size: 20, color: cs.onSurfaceVariant),
                  ),
          ),
          const SizedBox(height: 6),
          Text(
            "${alt.label}${alt.priceLabel == null ? "" : "  ${alt.priceLabel}"}",
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            alt.whenChoose ?? "",
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 10.5,
              color: cs.onSurfaceVariant,
              height: 1.3,
            ),
          ),
        ],
      ),
    );
  }
}
