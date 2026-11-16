import "dart:convert";

/// 通知 id 统一口径（2026-11-13）——与服务端 server/src/proactivity/notification-id.ts
/// **逐字对齐**（FNV-1a 32bit → % 2e9）。
///
/// 为什么不用 Dart 的 String.hashCode：它不保证跨运行/跨版本稳定，而通知 id 必须
/// 在「App 自建通知」「厂商推送」「Webhook」三处完全一致——不一致就会让同一条决策
/// 跨层投递变成两条通知（其中一条的按钮是死的）。
int notificationIdFor(String key) {
  int h = 0x811c9dc5;
  for (final int b in utf8.encode(key)) {
    h = (h ^ b) & 0xFFFFFFFF;
    h = (h * 0x01000193) & 0xFFFFFFFF;
  }
  return h % 2000000000;
}
