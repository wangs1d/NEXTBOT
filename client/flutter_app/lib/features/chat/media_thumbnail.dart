import "package:flutter/material.dart";

import "media_disk_cache.dart";

/// 统一媒体缩略图：网络图 + 统一加载动画 + 统一错误占位 + 圆角裁剪。
///
/// 供图片网格（[agent_result_card.dart] 的 _GalleryImageTile / _SinglePhotoTile）
/// 与内联 markdown 图（content_summary_detail_formatter.dart 的 _InlineImage）共用，
/// 消除多份重复的 loading/error 占位实现，让图片在各处视觉风格完全一致。
///
/// 本组件只负责「图片渲染 + 占位 + 圆角」，不负责点击交互；各调用方按自己的
/// 预览/跳转逻辑用 GestureDetector / InkWell 包裹。
class MediaThumbnail extends StatelessWidget {
  const MediaThumbnail({
    super.key,
    required this.url,
    required this.cs,
    this.width,
    this.height,
    this.borderRadius = 8,
    this.fit = BoxFit.cover,
    this.errorIcon = Icons.broken_image_outlined,
    this.loadingStrokeWidth = 2,
  });

  /// 已 resolve 的网络图片地址（调用方在传入前做好代理地址解析）。
  final String url;
  final ColorScheme cs;
  final double? width;
  final double? height;
  final double borderRadius;
  final BoxFit fit;
  final IconData errorIcon;
  final double loadingStrokeWidth;

  @override
  Widget build(BuildContext context) {
    final Widget loadingBox = Container(
      color: cs.surfaceContainerHighest,
      alignment: Alignment.center,
      child: SizedBox(
        width: 18,
        height: 18,
        child: CircularProgressIndicator(strokeWidth: loadingStrokeWidth),
      ),
    );
    final Widget errorBox = Container(
      color: cs.surfaceContainerHighest,
      alignment: Alignment.center,
      child: Icon(errorIcon, color: cs.onSurfaceVariant),
    );

    return ClipRRect(
      borderRadius: BorderRadius.circular(borderRadius),
      child: SizedBox(
        width: width,
        height: height,
        // 磁盘缓存版（2026-10-12）：历史消息照片重启后直接命中本地落盘
        // 秒出，不再逐张重新下载（Image.network 只有进程内内存缓存）。
        child: CachedMediaImage(
          url: url,
          fit: fit,
          width: width,
          height: height,
          loadingBuilder: (BuildContext context) => loadingBox,
          errorBuilder:
              (BuildContext context, Object error, StackTrace? stackTrace) {
            return errorBox;
          },
        ),
      ),
    );
  }
}