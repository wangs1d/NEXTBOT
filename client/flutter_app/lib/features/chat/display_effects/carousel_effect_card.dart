import "package:flutter/material.dart";

import "../../../core/services/image_preview_launcher.dart";
import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";
import "effect_media_utils.dart";
import "../media_disk_cache.dart";

/// 轮播横滑卡（cardType = "carousel"）。
///
/// 服务端路由条件（display-effect-router.ts 规则 4）：多数条目内嵌图片 URL。
/// 前端渲染为卡片式轮播（PageView，viewportFraction 0.74）：
///   - 每页 = 图片（自适应剩余高度）+ 底部说明文字；
///   - 点击图片进入右侧双栏预览，同一轮播内可前后切换；
///   - 底部圆点页码指示器，当前页拉长为主色。
/// 适合商品横排、多图推荐这类「一页一物」的场景。
class CarouselEffectCard extends StatefulWidget {
  const CarouselEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  State<CarouselEffectCard> createState() => _CarouselEffectCardState();
}

class _CarouselEffectCardState extends State<CarouselEffectCard> {
  final PageController _controller = PageController(viewportFraction: 0.74);
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 解析条目 → (图片地址, 说明文字)；说明 = 文本剥掉 URL 后的剩余部分。
    final List<({String url, String caption})> photos =
        <({String url, String caption})>[];
    for (final AgentResultItem it in widget.data.items) {
      final String? url = resolveItemPreviewUrl(it);
      if (url == null) continue;
      final String caption = it.text
          .replaceAll(RegExp(r'https?://\S+'), "")
          .trim();
      photos.add((url: url, caption: caption));
    }
    if (photos.isEmpty) {
      // 条目里解析不出图片 → 退化为通用 shell（仅标题/footer）。
      return EffectCardShell(
        cs: widget.cs,
        title: widget.data.title,
        footer: widget.data.footer,
        body: const SizedBox.shrink(),
      );
    }

    final List<String> gallery = photos.map((p) => p.url).toList();

    return EffectCardShell(
      cs: widget.cs,
      icon: Icons.view_carousel_outlined,
      title: widget.data.title,
      footer: widget.data.footer,
      padding: const EdgeInsets.fromLTRB(6, 12, 6, 10),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          AspectRatio(
            aspectRatio: 0.92,
            child: PageView.builder(
              controller: _controller,
              itemCount: photos.length,
              onPageChanged: (int i) => setState(() => _page = i),
              itemBuilder: (BuildContext context, int i) {
                final ({String url, String caption}) p = photos[i];
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: GestureDetector(
                    onTap: () => ImagePreviewLauncher.open(
                      url: p.url,
                      title: "图片预览",
                      gallery: gallery,
                      index: i,
                      anchorContext: context,
                    ),
                    child: Container(
                      decoration: BoxDecoration(
                        color: widget.cs.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: widget.cs.outline.withValues(alpha: 0.22),
                        ),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Expanded(
                            child: CachedMediaImage(
                              url: p.url,
                              fit: BoxFit.cover,
                              errorBuilder: (
                                BuildContext context,
                                Object error,
                                StackTrace? stackTrace,
                              ) {
                                return Icon(
                                  Icons.broken_image_outlined,
                                  size: 30,
                                  color: widget.cs.onSurfaceVariant,
                                );
                              },
                            ),
                          ),
                          if (p.caption.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(10, 7, 10, 8),
                              child: Text(
                                p.caption,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: widget.cs.onSurface
                                      .withValues(alpha: 0.85),
                                  height: 1.35,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          if (photos.length > 1) ...<Widget>[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                for (int i = 0; i < photos.length; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    margin: const EdgeInsets.symmetric(horizontal: 2.5),
                    width: i == _page ? 16 : 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: i == _page
                          ? widget.cs.primary
                          : widget.cs.outline.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
