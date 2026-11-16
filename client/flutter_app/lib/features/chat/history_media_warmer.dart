import "../../core/models/chat_models.dart";
import "../../core/utils/link_utils.dart";
import "media_disk_cache.dart";

/// 聊天历史媒体预热（手机端 / 桌面端共用唯一实现）。
///
/// 背景：历史消息里的照片/封面全部走 [CachedMediaImage]（磁盘缓存层）。
/// 磁盘未命中时每张图都要现下载，"重开应用后照片一张张慢慢浮出来"就是这么来的。
/// 这里在**历史数据刚恢复到内存、还没渲染**时就把地址批量丢给
/// [MediaDiskCache.warm]，由后台通道（2 路并发、永不挤占前台）提前落盘。
///
/// 采集口径与渲染口径必须一致：mediaCards / pendingMediaCards / renderBlocks
/// 里的媒体块三处都会渲染缩略图，任何一处漏采都会留下"这张图还是慢"的尾巴。
void warmChatHistoryMedia(Iterable<ChatMessage> messages, {int cap = 300}) {
  final List<String> urls = <String>[];
  final Set<String> seen = <String>{};

  void collectCard(Map<String, dynamic> card) {
    if (urls.length >= cap) return;
    final Object? thumb = card["thumbnailUrl"] ?? card["mediaUrl"];
    final String raw = thumb?.toString().trim() ?? "";
    if (raw.isEmpty) return;
    final String url = LinkUtils.resolveMediaUrlForHeaders(raw);
    if (url.isEmpty || !seen.add(url)) return;
    urls.add(url);
  }

  for (final ChatMessage m in messages) {
    if (urls.length >= cap) break;
    m.mediaCards?.forEach(collectCard);
    m.pendingMediaCards?.forEach(collectCard);
    final List<Map<String, dynamic>>? blocks = m.renderBlocks;
    if (blocks == null) continue;
    for (final Map<String, dynamic> block in blocks) {
      if (urls.length >= cap) break;
      if ((block["type"]?.toString() ?? "") != "media") continue;
      final List<dynamic>? cards = block["cards"] as List<dynamic>?;
      cards?.whereType<Map<String, dynamic>>().forEach(collectCard);
    }
  }

  if (urls.isEmpty) return;
  MediaDiskCache.instance.warm(urls);
}
