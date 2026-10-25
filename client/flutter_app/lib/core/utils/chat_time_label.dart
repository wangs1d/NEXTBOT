/// 聊天消息时间标签（2026-10-23）。
///
/// 背景：气泡头部此前恒显示 `HH:mm`（[chat_page._formatTime]），跨天后
/// 「昨天 21:10」和「今天 09:10」长得完全一样——用户翻聊天记录时分不清哪天，
/// 体感和 agent 侧「把昨天当今天」是同一个问题。
///
/// 规则（与后端【对话时间轴】的分日标签对齐）：
/// - 今天 → `14:03`
/// - 昨天 → `昨天 21:10`
/// - 前天 → `前天 09:30`
/// - 今年更早 → `10月18日 20:15`
/// - 跨年 → `2025-12-31 23:50`
///
/// 纯函数、无副作用；[now] 可注入以便测试。
String chatTimeLabel(DateTime at, {DateTime? now}) {
  final DateTime n = now ?? DateTime.now();
  final DateTime local = at.toLocal();
  final DateTime today = DateTime(n.year, n.month, n.day);
  final DateTime thatDay = DateTime(local.year, local.month, local.day);
  final int diffDays = today.difference(thatDay).inDays;
  final String hm =
      '${_two(local.hour)}:${_two(local.minute)}';

  if (diffDays <= 0) return hm;
  if (diffDays == 1) return '昨天 $hm';
  if (diffDays == 2) return '前天 $hm';
  if (local.year == n.year) return '${local.month}月${local.day}日 $hm';
  return '${local.year}-${_two(local.month)}-${_two(local.day)} $hm';
}

String _two(int v) => v.toString().padLeft(2, '0');
