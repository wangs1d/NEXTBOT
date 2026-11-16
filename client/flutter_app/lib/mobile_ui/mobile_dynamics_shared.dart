/// 动态页（首页 / 列表 / 详情）共用的字段读取与格式化。
///
/// 服务端 /api/dynamics 返回的形状见 server/src/routes/http/dynamics.ts：
/// 账单与快递条目均带 title / source / occurredAt / excerpt，
/// 快递额外带 pickupCode / carrier / trackingNo，并带动作状态
/// pickedUpAt / billStatus / snoozeUntil / pinned / archivedAt。
/// 订阅扫描结果在 subscriptions 区块，入口拦截计数在 blockedThisWeek。
library;

import "package:flutter/material.dart";

num dynamicsNum(Map<String, dynamic> m, String key) {
  final Object? v = m[key];
  if (v is num) return v;
  if (v is String) return num.tryParse(v) ?? 0;
  return 0;
}

String? dynamicsText(Map<String, dynamic> m, String key) {
  final String? v = m[key]?.toString().trim();
  if (v == null || v.isEmpty) return null;
  return v;
}

bool dynamicsBool(Map<String, dynamic> m, String key, {bool fallback = false}) {
  final Object? v = m[key];
  if (v is bool) return v;
  if (v is num) return v != 0;
  return fallback;
}

/// 金额：固定两位小数 + 千分位（设计稿 ¥3,482.50 / ¥128.00）。
String dynamicsFmtAmount(num v) {
  final double d = v.toDouble();
  final String s = d.abs().toStringAsFixed(2);
  final int dot = s.indexOf(".");
  final String intPart = s.substring(0, dot);
  final String decimals = s.substring(dot);
  final StringBuffer buf = StringBuffer();
  for (int i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 == 0) buf.write(",");
    buf.write(intPart[i]);
  }
  return "${d < 0 ? "-" : ""}$buf$decimals";
}

/// 带符号的支出金额（列表用 -¥1,280.00）。
String dynamicsFmtExpense(num v) => "-¥${dynamicsFmtAmount(v.abs())}";

/// 时间：今天 → "今天 HH:mm"；昨天 → "昨天 HH:mm"；更早 → "M月d日 HH:mm"。
String dynamicsFmtTime(num ms) {
  if (ms <= 0) return "";
  final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  final String hm =
      "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
  final DateTime now = DateTime.now();
  if (_sameDay(t, now)) return "今天 $hm";
  if (_sameDay(t, now.subtract(const Duration(days: 1)))) return "昨天 $hm";
  return "${t.month}月${t.day}日 $hm";
}

/// 日期：今天 / 昨天 / M月d日（不含时分，分组标题用）。
String dynamicsFmtDay(num ms) {
  if (ms <= 0) return "";
  final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  final DateTime now = DateTime.now();
  if (_sameDay(t, now)) return "今天";
  if (_sameDay(t, now.subtract(const Duration(days: 1)))) return "昨天";
  return "${t.month}月${t.day}日";
}

/// 日期+时间短格式：11月20日 / 今天 10:24。
String dynamicsFmtDate(num ms) {
  if (ms <= 0) return "";
  final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  return "${t.month}月${t.day}日";
}

/// 时长口语化（"2 分钟前" / "8 分钟前" / "3 小时前" / "11月16日"）。
String dynamicsFmtAgo(Object? raw) {
  if (raw == null) return "暂无记录";
  DateTime? t;
  if (raw is num && raw > 0) {
    t = DateTime.fromMillisecondsSinceEpoch(raw.toInt());
  } else if (raw is String && raw.isNotEmpty) {
    t = DateTime.tryParse(raw);
  }
  if (t == null) return "暂无记录";
  final Duration d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return "刚刚";
  if (d.inMinutes < 60) return "${d.inMinutes} 分钟前";
  if (d.inHours < 24) return "${d.inHours} 小时前";
  return "${t.month}月${t.day}日";
}

bool _sameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

/// 识别来源：短信 / 邮件 / 系统通知。
String dynamicsSourceLabel(Object? raw) {
  return switch (raw?.toString()) {
    "sms" => "短信",
    "email" => "邮件",
    "notification" => "系统通知",
    _ => "其他",
  };
}

/// 来源筛选 id（与设计稿「全部 / 短信 / 邮件 / 通知」一致）。
String dynamicsSourceShort(Object? raw) {
  return switch (raw?.toString()) {
    "sms" => "短信",
    "email" => "邮件",
    "notification" => "通知",
    _ => "其他",
  };
}

/// 快递是否已取件。
bool dynamicsPickedUp(Map<String, dynamic> item) =>
    item["pickedUpAt"] != null;

/// 账单复核状态：reimbursed / wrong / null。
String? dynamicsBillStatus(Map<String, dynamic> item) {
  final String? v = item["billStatus"]?.toString();
  return (v == "reimbursed" || v == "wrong") ? v : null;
}

/// 一周内低价值拦截明细（只用于展示分类计数）。
Map<String, num> dynamicsBlockedByReason(Map<String, dynamic> blocked) {
  final Map<String, dynamic> raw =
      (blocked["byReason"] as Map<String, dynamic>?) ?? <String, dynamic>{};
  return <String, num>{
    "marketing": dynamicsNum(raw, "marketing"),
    "otp": dynamicsNum(raw, "otp"),
    "duplicateParcel": dynamicsNum(raw, "duplicateParcel"),
    "sourceRule": dynamicsNum(raw, "sourceRule"),
    "groupChat": dynamicsNum(raw, "groupChat"),
  };
}

/// 底栏动态 tab 徽标（需处理件数；进入页面加载后同步）。
abstract final class DynamicsBadge {
  static final ValueNotifier<int> count = ValueNotifier<int>(0);
}

/// 颜色 token（与设计稿一致；深色下提高亮度保证对比度）。
abstract final class DynamicsTone {
  static bool _dark(BuildContext c) =>
      Theme.of(c).brightness == Brightness.dark;

  static Color greenFg(BuildContext c) =>
      _dark(c) ? const Color(0xFF6BD39A) : const Color(0xFF1F9D55);
  static Color greenBg(BuildContext c) => _dark(c)
      ? const Color(0xFF2C8C3C).withValues(alpha: 0.22)
      : const Color(0xFFEAF7EF);

  static Color amberFg(BuildContext c) =>
      _dark(c) ? const Color(0xFFE8A94A) : const Color(0xFFB26A00);
  static Color amberBg(BuildContext c) => _dark(c)
      ? const Color(0xFFE8A94A).withValues(alpha: 0.16)
      : const Color(0xFFFFF5E5);

  static Color redFg(BuildContext c) =>
      _dark(c) ? const Color(0xFFFF7B7F) : const Color(0xFFD93036);
  static Color redBg(BuildContext c) => _dark(c)
      ? const Color(0xFFE5484D).withValues(alpha: 0.18)
      : const Color(0xFFFDECEC);

  static Color blueBg(BuildContext c) => _dark(c)
      ? const Color(0xFF3B82F6).withValues(alpha: 0.18)
      : const Color(0xFFEAF2FE);
}

/// 「今天 / 昨天 / 更早」分组（账单列表用）。
List<MapEntry<String, List<Map<String, dynamic>>>> dynamicsGroupByDay(
  List<Map<String, dynamic>> items,
) {
  final DateTime now = DateTime.now();
  final Map<String, List<Map<String, dynamic>>> buckets =
      <String, List<Map<String, dynamic>>>{
    "今天": <Map<String, dynamic>>[],
    "昨天": <Map<String, dynamic>>[],
    "更早": <Map<String, dynamic>>[],
  };
  for (final Map<String, dynamic> item in items) {
    final DateTime t =
        DateTime.fromMillisecondsSinceEpoch(dynamicsNum(item, "occurredAt").toInt());
    if (_sameDay(t, now)) {
      buckets["今天"]!.add(item);
    } else if (_sameDay(t, now.subtract(const Duration(days: 1)))) {
      buckets["昨天"]!.add(item);
    } else {
      buckets["更早"]!.add(item);
    }
  }
  return <MapEntry<String, List<Map<String, dynamic>>>>[
    for (final MapEntry<String, List<Map<String, dynamic>>> e in buckets.entries)
      if (e.value.isNotEmpty) e,
  ];
}

