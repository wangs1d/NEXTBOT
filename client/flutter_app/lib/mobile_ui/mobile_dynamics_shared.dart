/// 动态页（首页 / 列表 / 详情）共用的字段读取与格式化。
///
/// 服务端 /api/dynamics 返回的形状见 server/src/routes/http/dynamics.ts：
/// 账单与快递条目均带 title / source / occurredAt / excerpt，
/// 快递额外带 pickupCode / carrier / trackingNo。
library;

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

/// 时间：今天 → "今天 HH:mm"；昨天 → "昨天 HH:mm"；更早 → "M月d日 HH:mm"。
String dynamicsFmtTime(num ms) {
  if (ms <= 0) return "";
  final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  final DateTime now = DateTime.now();
  final String hm =
      "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
  if (t.year == now.year && t.month == now.month && t.day == now.day) {
    return "今天 $hm";
  }
  final DateTime yesterday = now.subtract(const Duration(days: 1));
  if (t.year == yesterday.year &&
      t.month == yesterday.month &&
      t.day == yesterday.day) {
    return "昨天 $hm";
  }
  return "${t.month}月${t.day}日 $hm";
}

/// 识别来源：短信 / 邮件 / 系统通知。
String dynamicsSourceLabel(Object? raw) {
  return switch (raw?.toString()) {
    "sms" => "短信",
    "email" => "邮件",
    "notification" => "系统通知",
    _ => "其他",
  };
}
