/// 发言归组（2026-10-09 重复回复根源修复，客户端侧）。
///
/// 服务端的发言模型（server/src/agent/utterance-assembler.ts）规定：
/// **一个 turn = 一条发言（utterance）**，气泡只是这条发言的视图分段。
/// 服务端给每个分段分配独立 messageId：`assistant-<utteranceId>-b<N>`；
/// 不分泡时是 `assistant-<utteranceId>`。两者共享同一个 utteranceId（= 本轮 traceId）。
///
/// 客户端此前按 messageId 建条目 → 同一发言的两个分段渲染成两条独立消息
/// （各自带头像与名字），于是在「过程话 + 结论」两段式轮次里，用户看到的是
/// 两条语义重复的回复（事故形态：「好的王爷，记下了。」+「好的王爷，已经记上啦。」）。
///
/// 本模块提供纯函数：判断两条消息是否属于同一条发言，供消息列表把
/// 后继分段渲染为「同一条消息的续泡」（不重复头像/名字/时间头）。
///
/// 纯 Dart，无 Flutter 依赖 —— 可直接用 `dart run` 验证（见
/// tool/verify_utterance_grouping.dart）。
library;

class UtteranceGrouping {
  UtteranceGrouping._();

  /// 分泡消息 id：assistant-<utteranceId>-b<N>
  static final RegExp _segmentIdPattern = RegExp(r'^assistant-(.+)-b\d+$');

  static const String _assistantPrefix = 'assistant-';

  /// 是否为分泡（分段）消息 id。
  static bool isSegmentMessageId(String messageId) =>
      _segmentIdPattern.hasMatch(messageId);

  /// 提取消息所属的发言 id；非助手消息返回 null。
  ///
  /// - `assistant-<id>-b2` → `<id>`
  /// - `assistant-<id>`    → `<id>`
  /// - 其他前缀（用户消息 / 简报 / 垫词历史）→ null
  static String? utteranceIdOf(String messageId) {
    if (!messageId.startsWith(_assistantPrefix)) return null;
    final Match? m = _segmentIdPattern.firstMatch(messageId);
    if (m != null) return m.group(1);
    final String rest = messageId.substring(_assistantPrefix.length);
    // `assistant-` 之后为空 → 非法 id，不参与归组
    return rest.isEmpty ? null : rest;
  }

  /// 两条消息是否属于同一条发言（含 id 相同的情形）。
  ///
  /// 判据：两者都是助手消息，且提取出的发言 id 相等。任一为 null → false。
  static bool isSameUtterance(String a, String b) {
    final String? ua = utteranceIdOf(a);
    if (ua == null) return false;
    final String? ub = utteranceIdOf(b);
    if (ub == null) return false;
    return ua == ub;
  }

  /// 视觉上的「续泡」判定：当前消息是同一发言的**后续**分段。
  ///
  /// 与 [isSameUtterance] 的区别：同一条消息（id 相同）不算续泡。
  static bool isContinuationOf(String previousMessageId, String currentMessageId) {
    if (previousMessageId == currentMessageId) return false;
    return isSameUtterance(previousMessageId, currentMessageId);
  }
}
