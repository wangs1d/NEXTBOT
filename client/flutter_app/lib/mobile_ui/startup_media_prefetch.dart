import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/services/nb_http.dart";
import "../features/chat/media_disk_cache.dart";
import "mobile_page_cache.dart";

/// 启动期预取（2026-11-13 v2）：根治「打开应用 → 进资料库，照片一张张
/// 慢慢浮出来」。
///
/// v1（2026-11-12）只读上次落盘的资料库元数据来预热——有三个覆盖不到的洞：
/// 首次安装 / 缓存被清（无元数据可读，一张都不预取）、会话中新增的照片
/// （不在旧清单里）、以及元数据本身也是进资料库页时才读（首次进页仍要等
/// 一次磁盘 IO + JSON 解析）。v2 改为启动后台**直接拉一次最新清单**
/// （/api/library/items，轻量 JSON）：
///   1. 回写 MobilePageCache → 资料库页首次进入时内存命中，秒出卡片；
///   2. 把最新照片 / 封面清单交给 [MediaDiskCache.warm]（后台 4 路）落盘，
///      用户点开资料库时图已在本地；
///   3. 拉清单失败回退 v1 口径（读上次落盘的元数据），弱网/离线不白跑。
class StartupMediaPrefetch {
  StartupMediaPrefetch._();

  /// 预取上限：预热的是 400px webp 缩略图（单张几十 KB），120 张约几 MB，
  /// 弱网冷启动也扛得住。
  static const int _cap = 120;

  static bool _started = false;

  /// 幂等：本轮进程只跑一次。widget 测试环境（FLUTTER_TEST，FakeAsync）
  /// 直接跳过：真实网络请求与超时 Timer 只会挂起并留下 pending timer。
  static void scheduleWarm() {
    if (_started) return;
    _started = true;
    if (Platform.environment.containsKey("FLUTTER_TEST")) return;
    unawaited(_warm());
  }

  static Future<void> _warm() async {
    final String cacheKey = "library_items_${ApiConfig.effectiveActorId}";
    // 1) 先拉最新清单：首次安装也有预热源，新照片进入预热清单。
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/library/items?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
      final http.Response res =
          await NbClient().get(uri).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        final Map<String, dynamic> body =
            jsonDecode(res.body) as Map<String, dynamic>;
        if (body["ok"] == true) {
          // 元数据顺手热进页面缓存：资料库页首次进入 read() 内存命中。
          MobilePageCache.instance.write(cacheKey, body);
          final List<String> urls = _collectPhotoUrls(body);
          if (urls.isNotEmpty) MediaDiskCache.instance.warm(urls);
          return;
        }
      }
    } catch (e) {
      debugPrint("[StartupMediaPrefetch] 拉最新清单失败(回退旧缓存): $e");
    }
    // 2) 回退：读上次落盘的元数据（离线 / 服务端不可达时不白跑）。
    try {
      final Map<String, dynamic>? cached =
          await MobilePageCache.instance.read(cacheKey);
      if (cached == null) return;
      final List<String> urls = _collectPhotoUrls(cached);
      if (urls.isNotEmpty) MediaDiskCache.instance.warm(urls);
    } catch (e) {
      debugPrint("[StartupMediaPrefetch] 预取失败(忽略): $e");
    }
  }

  /// 从 /api/library/items 的响应体里抽照片与行程封面（口径与资料库页一致）。
  static List<String> _collectPhotoUrls(Map<String, dynamic> body) {
    final List<String> urls = <String>[];
    final Set<String> seen = <String>{};

    void add(String raw) {
      if (urls.length >= _cap) return;
      final String path = raw.trim();
      if (path.isEmpty) return;
      final String url = path.startsWith("http")
          ? path
          : "${ApiConfig.httpBase}$path";
      if (seen.add(url)) urls.add(url);
    }

    for (final dynamic group in (body["groups"] as List<dynamic>? ?? const <dynamic>[])) {
      if (urls.length >= _cap) break;
      if (group is! Map<String, dynamic>) continue;
      final Map<String, dynamic> items =
          (group["items"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      for (final dynamic img in (items["images"] as List<dynamic>? ?? const <dynamic>[])) {
        if (urls.length >= _cap) break;
        // 与资料库网格同口径取 400px 宽 webp 缩略图（单张几十 KB），
        // 预热 120 张也只有几 MB，不会变成一次冷启动几十 MB 的流量。
        if (img is Map<String, dynamic>) {
          final String raw = img["url"]?.toString() ?? "";
          if (raw.trim().isNotEmpty) {
            add("${raw.trim()}${raw.contains("?") ? "&" : "?"}w=400");
          }
        }
      }
      for (final dynamic plan
          in (items["travelPlans"] as List<dynamic>? ?? const <dynamic>[])) {
        if (urls.length >= _cap) break;
        if (plan is Map<String, dynamic>) {
          add(plan["coverImage"]?.toString() ?? "");
        }
      }
    }
    return urls;
  }
}
