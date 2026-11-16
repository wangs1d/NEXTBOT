/**
 * 通知 id 统一口径（2026-11-13「通知即界面」）——App 自建通知 / 华为推送 / Webhook
 * 三处必须同源，否则同一条决策跨层投递会变成两条通知：用户看到重复，且其中一条
 * 的按钮已经失效（另一条才是活的那份）。
 *
 * 算法：FNV-1a 32bit → % 2e9（华为 notify_id 上限 2^31-1，取模留余量）。
 * 客户端 Dart 侧有同名实现（client/flutter_app/lib/core/services/local_notification_service.dart），
 * 两侧必须逐字对齐——改任何一边都必须同步改另一边，否则跨层 id 对不上。
 *
 *   h = 0x811c9dc5
 *   for (b in utf8(key)) { h ^= b; h = (h * 0x01000193) & 0xFFFFFFFF }
 *   id = h % 2000000000
 *
 * 注意：JS 侧必须用 Math.imul（乘积超出 2^53 会丢精度，Dart 的 64 位 int 不会）。
 */
export function notificationIdFor(key: string): number {
  const bytes = Buffer.from(String(key ?? ""), "utf8");
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2_000_000_000;
}
