import "package:url_launcher/url_launcher.dart";

import "../config/media_url.dart";

/// 聊天正文/卡片里的 URL 处理工具。
///
/// 原 agent_result_card.dart 与 chat_page.dart 各自持有一份 URL 提取/
/// 拼接/标签逻辑，正则相同、去尾标点集合略有出入，这里收口为一处
/// （统一剥中文顿号——URL 后粘标点本就该剥掉才能正确打开）。
class LinkUtils {
  LinkUtils._();

  static final RegExp _urlInText = RegExp(r'https?://\S+');

  /// 去掉 URL 尾部粘带的标点（中英文句读）。
  static String _trimTrailingPunctuation(String url) =>
      url.replaceAll(RegExp(r'[),.;，。！？、]+$'), '');

  /// 从任意文本中提取第一个 http(s) URL，去掉尾部标点。
  static String? extractFirst(String text) {
    final RegExpMatch? m = _urlInText.firstMatch(text);
    if (m == null) return null;
    return _trimTrailingPunctuation(m.group(0)!);
  }

  /// 提取文本中全部 http(s) URL（去尾标点、按首次出现去重）。
  static List<String> extractAll(String text) {
    final Set<String> seen = <String>{};
    final List<String> urls = <String>[];
    for (final RegExpMatch m in _urlInText.allMatches(text)) {
      final String url = _trimTrailingPunctuation(m.group(0)!);
      if (seen.add(url)) urls.add(url);
    }
    return urls;
  }

  /// 相对路径 → 服务端绝对 URL（带本机设备凭证）；外部绝对地址原样返回。
  /// （原 agent_result_card 顶层 `_resolveMediaUrl` 语义：不带斜杠的相对
  /// 路径补一根斜杠，否则拼出来的地址无法加载。）
  static String resolveMediaUrl(String url) => MediaUrl.resolve(url);

  /// URL → 简短可读标签：取域名并去掉 www，不展示路径与协议。
  static String shortLabel(String url) {
    final Uri? uri = Uri.tryParse(url);
    final String host = (uri == null || uri.host.isEmpty) ? url : uri.host;
    final String clean = host.replaceFirst(RegExp(r'^www\.'), '');
    return clean.isEmpty ? url : clean;
  }

  /// 用外部浏览器打开；失败静默（链接点击属 fire-and-forget 场景）。
  static Future<void> launchExternal(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }
}
