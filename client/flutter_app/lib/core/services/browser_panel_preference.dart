import "dart:async";
import "dart:convert";
import "dart:io";

import "package:path_provider/path_provider.dart";

/// 内置浏览器面板的本地偏好：页面缩放档 + 用户自己浏览的最后页面。
///
/// 缩放跨面板开关与 App 重启保留；lastUserUrl 只记用户主动导航（omnibox /
/// 主页搜索）的页面，用于「关掉面板再开 / 重启 App」时恢复，Agent 留痕页
/// 不写入。失败时静默退回默认，不抛异常。
class BrowserPanelPreference {
  BrowserPanelPreference._();

  /// 页面内容默认缩放（100 档值）。0.9 = 一屏多看约 20% 内容。
  static const double defaultZoom = 0.90;

  /// 缩放档位（照 Chrome 阶梯，%）。
  static const List<int> zoomSteps = <int>[
    50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 300, 400,
  ];

  static const String _fileName = "browser_panel_preference.json";
  static const String _keyZoom = "zoom";
  static const String _keyLastUserUrl = "lastUserUrl";

  static File? _file;
  Map<String, Object?>? _cached;

  static final BrowserPanelPreference instance = BrowserPanelPreference._();

  Future<Map<String, Object?>> _load() async {
    if (_cached != null) return _cached!;
    try {
      _file ??= await _resolveFile();
      final File? f = _file;
      if (f != null && f.existsSync()) {
        final Object? raw = jsonDecode(f.readAsStringSync());
        if (raw is Map) _cached = raw.cast<String, Object?>();
      }
    } catch (_) {
      // 读失败按无偏好处理
    }
    return _cached ??= <String, Object?>{};
  }

  Future<double> loadZoom() async {
    final Object? v = (await _load())[_keyZoom];
    if (v is num) return v.toDouble().clamp(0.25, 5.0);
    return defaultZoom;
  }

  Future<String> loadLastUserUrl() async {
    final Object? v = (await _load())[_keyLastUserUrl];
    return v is String ? v : "";
  }

  Future<void> save({double? zoom, String? lastUserUrl}) async {
    final Map<String, Object?> data = await _load();
    if (zoom != null) data[_keyZoom] = zoom;
    if (lastUserUrl != null) data[_keyLastUserUrl] = lastUserUrl;
    try {
      _file ??= await _resolveFile();
      await _file?.writeAsString(jsonEncode(data));
    } catch (_) {
      // 写失败忽略，下次再写
    }
  }

  Future<File?> _resolveFile() async {
    try {
      final Directory dir = await getApplicationDocumentsDirectory();
      return File("${dir.path}/$_fileName");
    } catch (_) {
      return null;
    }
  }
}
