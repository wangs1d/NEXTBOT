/// 跨端历史回填的载荷解析（2026-11-13）：`/api/chat-data/history` 的
/// messages 数组 → 客户端 ChatMessage 列表。纯函数，无 IO / 无状态，
/// 手机端 mobile_chat_controller 与桌面端 main.dart 共用同一份实现，
/// 保证两端回填形态一致（此前两端各写一份解析循环，已出现分叉风险）。
///
/// 真·分绿泡回填：assistant item 携带服务端透传的分泡对账数组（bubbles）
/// 时逐泡建消息，重装/换设备后历史形态与当轮实时一致；旧行/塌缩/单泡轮
/// 缺省 → 单泡路径（升级前行为）。fromBubbles 与 messages 等长平行，
/// 供调用方做「同文分泡是刻意形态、不互相吞并」的去重口径调整。
library;

import "../models/chat_models.dart";
import "assistant_text_sanitizer.dart";

class ParsedServerHistory {
  const ParsedServerHistory({required this.messages, required this.fromBubbles});

  final List<ChatMessage> messages;

  /// 与 [messages] 等长：第 i 条是否来自分泡对账数组（逐泡重建）。
  final List<bool> fromBubbles;
}

/// 单条 assistant item 的 bubbles 字段解析：只收 text 非空串的泡；缺省 /
/// 脏结构返回 null（调用方降级单泡）。与手机端旧内联解析同一口径。
List<Map<String, dynamic>>? parseHistoryBubbles(Object? rawBubbles) {
  if (rawBubbles is! List<dynamic>) return null;
  final List<Map<String, dynamic>> cleaned = rawBubbles
      .whereType<Map<dynamic, dynamic>>()
      .map((Map<dynamic, dynamic> b) => Map<String, dynamic>.from(b))
      .where((Map<String, dynamic> b) =>
          (b["text"]?.toString() ?? "").trim().isNotEmpty)
      .toList();
  return cleaned.isEmpty ? null : cleaned;
}

ParsedServerHistory parseServerHistoryMessages({
  required List<dynamic> raw,
  required String sessionKey,
}) {
  final List<ChatMessage> messages = <ChatMessage>[];
  final List<bool> fromBubbles = <bool>[];
  int fallbackSeq = 0;
  for (final dynamic item in raw) {
    if (item is! Map<String, dynamic>) continue;
    final String role = item["role"]?.toString() ?? "";
    final String text = stripAssistantProtocolFrames(
      item["text"]?.toString() ?? "",
    ).trim();
    if ((role != "user" && role != "assistant") || text.isEmpty) continue;
    final int? tsMs = item["ts"] is int ? item["ts"] as int : null;
    final DateTime ts = tsMs != null
        ? DateTime.fromMillisecondsSinceEpoch(tsMs)
        : DateTime.now();
    final String? clientMessageId = item["clientMessageId"]?.toString();
    final String messageId =
        role == "user" && (clientMessageId?.isNotEmpty ?? false)
            ? clientMessageId!
            : "hist-$role-${ts.millisecondsSinceEpoch}-${fallbackSeq++}";
    // 媒体卡回填（2026-11-09）：服务端 WAL 透传本轮 mediaCards，重装/
    // 换设备后历史里的照片气泡才能重建（URL 指向服务端转存资产，可直接加载）。
    final List<Map<String, dynamic>>? mediaCards = (item["mediaCards"]
            as List<dynamic>?)
        ?.whereType<Map<dynamic, dynamic>>()
        .map((Map<dynamic, dynamic> c) => Map<String, dynamic>.from(c))
        .toList();
    // 用户照片回填（2026-11-18）：服务端 WAL 透传本轮 userImageUrls，
    // 重装/换设备后按真实缩略图重建用户泡，替换旧的「配图 ×N」文案。
    final List<String> userImageUrls = role == "user"
        ? (item["userImageUrls"] as List<dynamic>?)
                ?.whereType<String>()
                .where((String u) => u.startsWith("/agent/images/"))
                .toList() ??
            const <String>[]
        : const <String>[];
    final int attachmentCount = userImageUrls.isNotEmpty
        ? userImageUrls.length
        : ((item["attachmentImageCount"] as num?)?.toInt() ?? 0);
    // 真·分绿泡对账数组（2026-11-13）：真实分泡轮逐泡建消息；旧行/塌缩/
    // 单泡轮缺省（或仅一泡，形态等价）→ 单泡路径，行为与升级前一致。
    final List<Map<String, dynamic>>? histBubbles = role == "assistant"
        ? parseHistoryBubbles(item["bubbles"])
        : null;
    if (histBubbles != null && histBubbles.length > 1) {
      for (int j = 0; j < histBubbles.length; j++) {
        final String bubbleText = stripAssistantProtocolFrames(
          histBubbles[j]["text"]?.toString() ?? "",
        ).trim();
        if (bubbleText.isEmpty) continue;
        messages.add(ChatMessage(
          messageId: "hist-bubble-${ts.millisecondsSinceEpoch}-${fallbackSeq++}",
          sessionId: sessionKey,
          role: "assistant",
          text: bubbleText,
          // 逐泡 +j ms 错开：同轮多泡同毫秒会在时间戳排序下不稳定翻序
          timestamp: ts.add(Duration(milliseconds: j)),
          // 媒体卡挂末泡（与实时路径媒体挂在当前流式末泡同构）
          mediaCards: j == histBubbles.length - 1 ? mediaCards : null,
        ));
        fromBubbles.add(true);
      }
      continue;
    }
    messages.add(ChatMessage(
      messageId: messageId,
      sessionId: sessionKey,
      role: role,
      text: text,
      timestamp: ts,
      attachmentImageCount: role == "user" ? attachmentCount : 0,
      userImageUrls: userImageUrls,
      mediaCards:
          (mediaCards != null && mediaCards.isNotEmpty) ? mediaCards : null,
    ));
    fromBubbles.add(false);
  }
  return ParsedServerHistory(messages: messages, fromBubbles: fromBubbles);
}
