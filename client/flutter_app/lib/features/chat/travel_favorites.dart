import "dart:convert";
import "dart:io";

import "package:http/http.dart" as http;
import "../../core/services/nb_http.dart";
import "package:path_provider/path_provider.dart";

import "../../core/config/api_config.dart";

/// 收藏持久化（对应 3D-Travel 的 toggleFavorite）：本地 JSON 文件，
/// key 为「type:name」，value 为收藏时间戳。
///
/// 服务端同步（C5）：变更后 fire-and-forget 全量同步到 /travel/favorites，
/// 供下次 travel.plan-itinerary 排序加权（收藏过的地点优先排入）。同步失败
/// 静默——本地收藏始终是权威源，网络不可用不影响收藏体验。
class TravelFavorites {
  TravelFavorites._();
  static final TravelFavorites instance = TravelFavorites._();

  final Set<String> _keys = <String>{};
  bool _loaded = false;

  static String keyOf(String type, String name) => "$type:$name";

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File f = File("${dir.path}/travel_favorites.json");
      if (await f.exists()) {
        final dynamic data = jsonDecode(await f.readAsString());
        if (data is List) {
          _keys.addAll(<String>[for (final dynamic k in data) if (k != null) k.toString()]);
        }
      }
    } catch (_) {
      // 读失败按空收藏处理
    }
  }

  Future<void> _persist() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File f = File("${dir.path}/travel_favorites.json");
      await f.writeAsString(jsonEncode(_keys.toList()), flush: true);
    } catch (_) {
      // 写失败静默（收藏非关键数据）
    }
  }

  bool isFavoriteSync(String key) => _keys.contains(key);

  Future<bool> isFavorite(String key) async {
    await _ensureLoaded();
    return _keys.contains(key);
  }

  /// 切换收藏状态，返回切换后的状态。
  Future<bool> toggle(String key) async {
    await _ensureLoaded();
    if (!_keys.remove(key)) _keys.add(key);
    await _persist();
    _syncToServer();
    return _keys.contains(key);
  }

  /// 全量同步到服务端（fire-and-forget，失败静默）。
  void _syncToServer() {
    final List<String> snapshot = _keys.toList();
    NbHttp.post(
          Uri.parse("${ApiConfig.httpBase}/travel/favorites"),
          headers: const <String, String>{"content-type": "application/json"},
          body: jsonEncode(<String, dynamic>{"favorites": snapshot}),
        )
        .timeout(const Duration(seconds: 5))
        .catchError((_) => http.Response("", 0));
  }
}
