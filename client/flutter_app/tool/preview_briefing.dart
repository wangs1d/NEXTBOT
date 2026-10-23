// 今日简报浮窗「实际效果」预览生成器。
//
// 卡面 HTML / 高度估算全部来自 lib/core/services/daily_briefing_card_render.dart
// （与窗口宿主 daily_briefing_window.dart 同一份实现，不再复制代码）；这里只负责
// 读载荷 JSON 并落 HTML，供浏览器查看实际卡面。
// 用法：dart run tool/preview_briefing.dart <payload.json> <out.html>
import "dart:convert";
import "dart:io";

import "package:nextbot/core/services/daily_briefing_card_render.dart";

/// 简报窗口载荷（与 daily_briefing_window.dart 的 DailyBriefingWindowPayload 同结构）。
class _Payload {
  const _Payload({
    required this.narrationText,
    required this.briefing,
    this.appellation = "",
  });

  final String narrationText;
  final Map<String, dynamic> briefing;
  final String appellation;

  /// 解码失败（文件损坏/版本不符）时返回 null。
  static _Payload? tryDecode(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? rawBriefing = decoded["briefing"];
      if (rawBriefing is! Map) return null;
      return _Payload(
        narrationText: decoded["narrationText"]?.toString() ?? "",
        briefing: rawBriefing.cast<String, dynamic>(),
        appellation: decoded["appellation"]?.toString() ?? "",
      );
    } catch (_) {
      return null;
    }
  }
}

Future<void> main(List<String> args) async {
  final String raw = await File(args[0]).readAsString();
  final _Payload? payload = _Payload.tryDecode(raw);
  final String html = buildBriefingHtml(
    briefing: payload?.briefing,
    narrationText: payload?.narrationText ?? "",
    appellation: payload?.appellation ?? "",
  );
  await File(args[1]).writeAsString(html, flush: true);
  stdout.writeln("written: ${args[1]}");
  stdout.writeln(
    "window height = ${briefingWindowHeight(
      briefing: payload?.briefing,
      narrationText: payload?.narrationText ?? "",
    )}",
  );
}
