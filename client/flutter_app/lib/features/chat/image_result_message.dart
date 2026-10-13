import "dart:convert";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/image_preview_launcher.dart";
import "content_summary_detail_formatter.dart";
import "media_disk_cache.dart";
import "media_thumbnail.dart";

/// 识图结果外壳（[RENDER_AS:image_result] 的专属渲染）。
///
/// 真实设计（2026-09-15 用户确认，Coze 式「一图一句」）：
/// **每张照片下面只有对当前照片的简单介绍**——画面内容 + 可推断的拍摄场景/地点。
///
/// 服务端在识图轮次确定性附着的结构化块（照片与描述绑定，不依赖 LLM 正文）：
///   [IMAGE_RESULT_START]
///   {"items":[{"url":"/agent/images/a/x.jpg","caption":"书桌上的一只橘猫，正趴着睡觉"}]}
///   [IMAGE_RESULT_END]
///
/// 含该块时渲染为：🔍徽标 + 纵向照片卡片（每张照片下方一行自己的描述）；
/// 无块时回退旧形态（缩略图横廊 + 结论 + 要点正文），历史消息不受影响。
class ImageResultMessage extends StatelessWidget {
  const ImageResultMessage({
    super.key,
    required this.text,
    required this.cs,
    required this.textTheme,
    this.showCursor = false,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool showCursor;

  static final RegExp _payloadBlock = RegExp(
    r"\[IMAGE_RESULT_START\]([\s\S]*?)\[IMAGE_RESULT_END\]",
  );
  static final RegExp _imgMarkdown = RegExp(r'!\[[^\]]*\]\(([^)\s]+)\)');
  static final RegExp _imgPath = RegExp(r'(/agent/images/[A-Za-z0-9_\-.%/]+)');
  static final RegExp _imgHttp = RegExp(
    r'(https?://[A-Za-z0-9_\-./:%?&=@#~+]+\.(?:png|jpe?g|gif|webp|avif)(?:[?&][A-Za-z0-9_\-./:%?&=@#~+]+)?)',
    caseSensitive: false,
  );

  /// 解析结构化照片卡块；不存在/解析失败返回 null（调用方回退旧渲染）。
  static List<({String url, String caption})>? parsePhotoItems(String text) {
    final Match? m = _payloadBlock.firstMatch(text);
    if (m == null) return null;
    try {
      final dynamic decoded = jsonDecode(m.group(1)?.trim() ?? "");
      if (decoded is! Map<String, dynamic>) return null;
      final List<dynamic> rawItems = decoded["items"] as List<dynamic>? ?? <dynamic>[];
      final List<({String url, String caption})> out = <({String url, String caption})>[];
      for (final dynamic it in rawItems) {
        if (it is! Map<String, dynamic>) continue;
        final String url = (it["url"] ?? "").toString().trim();
        if (url.isEmpty) continue;
        out.add((url: url, caption: (it["caption"] ?? "").toString().trim()));
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  /// 抽取正文中的图片链接（markdown 图 / 代理路径 / http 图片），去重、最多 6 张。
  static List<String> _extractImageUrls(String text) {
    if (text.isEmpty) return const <String>[];
    final List<String> out = <String>[];
    void add(String? url) {
      final String u = (url ?? "").trim();
      if (u.isEmpty || out.contains(u)) return;
      out.add(u);
    }

    for (final Match m in _imgMarkdown.allMatches(text)) {
      add(m.group(1));
    }
    for (final Match m in _imgPath.allMatches(text)) {
      add(m.group(1));
    }
    for (final Match m in _imgHttp.allMatches(text)) {
      add(m.group(1));
    }
    return out.take(6).toList(growable: false);
  }

  /// 剥离正文中的图片链接 token（保留行内其它文字，避免图廊与正文重复）。
  static String _stripImageTokens(String text) {
    if (text.isEmpty) return text;
    String result = text;
    void drop(List<String> tokens) {
      for (final String token in tokens) {
        if (token.isEmpty) continue;
        result = result.replaceAll(token, "");
      }
    }

    drop(_imgMarkdown.allMatches(text)
        .map((Match m) => m.group(0) ?? "")
        .toSet()
        .toList());
    drop(_imgPath.allMatches(text)
        .map((Match m) => m.group(1) ?? "")
        .toSet()
        .toList());
    drop(_imgHttp.allMatches(text)
        .map((Match m) => m.group(1) ?? "")
        .toSet()
        .toList());
    return result
        .replaceAll(RegExp(r'\n{3,}'), '\n\n')
        .replaceAll(RegExp(r'[ \t]{2,}'), " ")
        .trim();
  }

  /// 解析「结论 + 要点」：首行短句（≤32 字）作为结论，其余为要点正文。
  static String? _extractLead(String body) {
    final List<String> lines = body
        .split("\n")
        .map((String line) => line.trim())
        .where((String line) => line.isNotEmpty)
        .toList();
    if (lines.isEmpty) return null;
    final String first = lines.first;
    if (first.length > 32) return null;
    // 引导行/结论句：以 ：结尾 或 是一句完整短句（不含列表符号）
    final bool isIntrolike = first.endsWith("：") || first.endsWith(":");
    final bool isListLike = RegExp(r'^[-•*→▸‣◦·\d.、]\s*').hasMatch(first);
    if (isListLike) return null;
    if (!isIntrolike && lines.length < 2 && body.length <= 40) {
      return first;
    }
    return isIntrolike ? first : null;
  }

  static String _resolveMediaUrl(String url) {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    final String base = ApiConfig.httpBase;
    if (url.startsWith("/")) return "$base$url";
    return "$base/$url";
  }

  @override
  Widget build(BuildContext context) {
    final String normalized = text.replaceAll("\r\n", "\n").trim();
    final List<({String url, String caption})>? photoItems = parsePhotoItems(normalized);
    final String textWithoutPayload = photoItems == null
        ? normalized
        : normalized.replaceAll(_payloadBlock, "").trim();

    final List<String> rawUrls = _extractImageUrls(textWithoutPayload);
    final List<String> urls = rawUrls.map(_resolveMediaUrl).toList();
    final String textOnly = _stripImageTokens(textWithoutPayload);

    // 真实设计：结构化照片卡在场 → 只渲染「照片 + 各自描述」，不再输出结论/要点
    final bool photoCardMode = photoItems != null && photoItems.isNotEmpty;
    final String? lead = photoCardMode ? null : _extractLead(textOnly);

    final String body = lead == null
        ? textOnly
        : textOnly
            .split("\n")
            .map((String line) => line.trim())
            .where((String line) => line.isNotEmpty)
            .skip(1)
            .join("\n")
            .trim();

    // 照片卡模式下正文整段收敛（用户要求：照片下只有各自的介绍）
    final String bodyAfterPhotos =
        photoCardMode || lead != null ? "" : body;

    final bool hasContent =
        photoCardMode || urls.isNotEmpty || textOnly.isNotEmpty;
    if (!hasContent && !showCursor) {
      return const SizedBox.shrink();
    }

    final TextStyle bodyStyle = textTheme.bodyMedium!.copyWith(
      color: cs.onSurface,
      height: 1.56,
    );

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.12)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 头部徽标
          Row(
            children: <Widget>[
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(
                      Icons.image_search_rounded,
                      size: 13,
                      color: cs.primary,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      "识图结果 · ${(photoItems?.length ?? urls.length)} 图",
                      style: textTheme.labelSmall?.copyWith(
                            color: cs.primary,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.1,
                          ) ??
                          TextStyle(
                            fontSize: 11,
                            color: cs.primary,
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          // 真实设计：纵向照片卡片，每张下方一行自己的描述
          if (photoCardMode) ...<Widget>[
            const SizedBox(height: 10),
            for (int i = 0; i < photoItems.length; i++) ...<Widget>[
              if (i > 0) const SizedBox(height: 10),
              _PhotoCaptionCard(
                url: _resolveMediaUrl(photoItems[i].url),
                caption: photoItems[i].caption,
                cs: cs,
                captionStyle: textTheme.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                      height: 1.4,
                    ) ??
                    TextStyle(
                      fontSize: 12,
                      color: cs.onSurfaceVariant,
                      height: 1.4,
                    ),
                gallery: photoItems.map((p) => _resolveMediaUrl(p.url)).toList(),
                index: i,
              ),
            ],
          ]
          // 旧形态回退：缩略图横廊（历史消息 / 无结构化块）
          else if (urls.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            SizedBox(
              height: 96,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                physics: const BouncingScrollPhysics(),
                itemCount: urls.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (BuildContext context, int index) {
                  final String url = urls[index];
                  return GestureDetector(
                    onTap: () => ImagePreviewLauncher.open(
                      url: url,
                      title: "识图预览",
                      gallery: urls,
                      index: index,
                      anchorContext: context,
                    ),
                    child: MediaThumbnail(
                      url: url,
                      cs: cs,
                      width: 96,
                      height: 96,
                      borderRadius: 10,
                    ),
                  );
                },
              ),
            ),
          ],
          // 一句话结论（仅旧形态）
          if (lead != null && lead.isNotEmpty) ...<Widget>[
            if (urls.isNotEmpty) const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
              decoration: BoxDecoration(
                color: cs.primaryContainer.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(9),
                border: Border(
                  left: BorderSide(
                    color: cs.outline.withValues(alpha: 0.38),
                    width: 2.5,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                lead,
                bodyStyle.copyWith(
                  fontWeight: FontWeight.w600,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
          // 要点细节（照片卡模式下整段收敛：照片下只有各自的介绍）
          if (bodyAfterPhotos.isNotEmpty) ...<Widget>[
            if (lead != null && lead.isNotEmpty || urls.isNotEmpty)
              const SizedBox(height: 8),
            ...formatContentSummaryDetailLines(bodyAfterPhotos, cs, textTheme),
          ],
          if (showCursor)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                "▍",
                style: bodyStyle.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 单张照片卡：照片（自然宽高比，点击开大图）+ 下方一行该照片自己的描述。
class _PhotoCaptionCard extends StatelessWidget {
  const _PhotoCaptionCard({
    required this.url,
    required this.caption,
    required this.cs,
    required this.captionStyle,
    required this.gallery,
    required this.index,
  });

  final String url;
  final String caption;
  final ColorScheme cs;
  final TextStyle captionStyle;
  final List<String> gallery;
  final int index;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        GestureDetector(
          onTap: () => ImagePreviewLauncher.open(
            url: url,
            title: "识图预览",
            gallery: gallery,
            index: index,
            anchorContext: context,
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 320),
              child: CachedMediaImage(
                url: url,
                width: double.infinity,
                fit: BoxFit.cover,
                alignment: Alignment.topCenter,
                errorBuilder: (_, __, ___) => Container(
                  height: 120,
                  color: cs.surfaceContainerHighest.withValues(alpha: 0.4),
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.image_outlined,
                    size: 28,
                    color: cs.onSurfaceVariant.withValues(alpha: 0.5),
                  ),
                ),
                loadingBuilder: (BuildContext context) => Container(
                  height: 160,
                  color: cs.surfaceContainerHighest.withValues(alpha: 0.3),
                  alignment: Alignment.center,
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: cs.primary.withValues(alpha: 0.6),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (caption.isNotEmpty) ...<Widget>[
          const SizedBox(height: 6),
          Text(caption, style: captionStyle),
        ],
      ],
    );
  }
}
