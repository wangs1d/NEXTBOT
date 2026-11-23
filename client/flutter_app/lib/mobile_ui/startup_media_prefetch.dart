import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/services/nb_http.dart";
import "../features/chat/media_disk_cache.dart";
import "mobile_page_cache.dart";

/// 启动期资料库全量预取（2026-11-23 v3）：把一次 `/api/library/items` 清单
/// 里能预载的内容**全部**提前落到本机，用户进资料库 / 点开详情时秒开。
///
/// 演进史：
/// - v1（2026-11-12）：只读上次落盘的元数据预热，首装/新照片覆盖不到；
/// - v2（2026-11-13）：启动直接拉最新清单，预热 400px 缩略图 + 封面；
/// - v3（本版）：补上 v2 缺失的内容——
///   1. **原图**（全屏查看走 MediaDiskCache.fileFor，预热后零等待）；
///   2. **产出文件字节**（PDF/ Word / Excel，点开从本地缓存交系统应用打开）；
///   3. **笔记正文**（GET /notes/:id → MobilePageCache）；
///   4. **行程详情**（GET /travel/plans/:id → MobilePageCache）。
///
/// 设计约束：
/// - 所有下载走 MediaDiskCache 后台通道（4 路）+ 静默容错，绝不抢占屏上
///   正在渲染的图；正文 JSON 另开 4 路小并发闸门，避免一次打几十个请求；
/// - 清单拉取失败回退上次落盘的元数据（弱网/离线不白跑）；
/// - widget 测试环境（FLUTTER_TEST / FakeAsync）整段跳过：真实网络请求和
///   超时 Timer 只会挂起并留下 pending timer。
class StartupMediaPrefetch {
  StartupMediaPrefetch._();

  /// 缩略图（400px webp，单张几十 KB）预热上限。
  static const int thumbCap = 120;

  /// 原图上限：单张 1~3 MB，封顶防极端大库冷启动占满流量/磁盘。
  static const int originalCap = 60;

  /// 产出文件字节上限（PDF / Word / Excel 等，单份可能数 MB）。
  static const int fileCap = 60;

  /// 正文（笔记 / 行程）并发闸门：JSON 很小，但一次性几十个请求仍要压住。
  static const int textConcurrency = 4;
  static const Duration textTimeout = Duration(seconds: 15);

  static bool _started = false;

  /// 幂等：本轮进程只跑一次。
  static void scheduleWarm() {
    if (_started) return;
    _started = true;
    if (Platform.environment.containsKey("FLUTTER_TEST")) return;
    unawaited(_warm());
  }

  static Future<void> _warm() async {
    final String cacheKey = "library_items_${ApiConfig.effectiveActorId}";
    // 1) 先拉最新清单：首次安装也有预热源，新产物进入预热清单。
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/library/items?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
      final http.Response res =
          await NbClient().get(uri).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        final Map<String, dynamic> body =
            jsonDecode(res.body) as Map<String, dynamic>;
        if (body["ok"] == true) {
          // 元数据顺手热进页面缓存：资料库页首次进入时内存命中，秒出卡片。
          MobilePageCache.instance.write(cacheKey, body);
          warmContent(body);
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
      warmContent(cached);
    } catch (e) {
      debugPrint("[StartupMediaPrefetch] 预取失败(忽略): $e");
    }
  }

  /// 资料库全量预热入口（fire-and-forget）。
  ///
  /// 既由启动期调用，也由资料库页拉到新清单后调用——同一份逻辑，避免预取端
  /// 与消费端的 URL 拼接漂移。所有下载都是后台通道 + 静默容错，返回即视为
  /// "已排队"，不阻塞调用方。
  static void warmContent(Map<String, dynamic> body) {
    final WarmTargets t = collectTargets(body);
    // 小图先入队：卡片/网格是用户第一眼看到的，优先保证秒出。
    if (t.thumbs.isNotEmpty) MediaDiskCache.instance.warm(t.thumbs);
    // 原图 + 文件字节：体积大，排在缩略图之后；超容量时由 MediaDiskCache
    // 的 300MB LRU 兜底淘汰（预热对象按新→旧入队，旧产物先被淘汰）。
    if (t.originals.isNotEmpty) MediaDiskCache.instance.warm(t.originals);
    if (t.files.isNotEmpty) MediaDiskCache.instance.warm(t.files);
    if (t.noteIds.isNotEmpty || t.planIds.isNotEmpty) {
      unawaited(_warmTexts(t.noteIds, t.planIds));
    }
  }

  /// 从 `/api/library/items` 响应体抽取全部预热目标。
  ///
  /// 公开供单测断言；生产侧只走 [warmContent]。
  static WarmTargets collectTargets(Map<String, dynamic> body) {
    final WarmTargets t = WarmTargets();
    final Set<String> seenThumb = <String>{};
    final Set<String> seenOriginal = <String>{};
    final Set<String> seenFile = <String>{};
    final Set<String> seenNote = <String>{};
    final Set<String> seenPlan = <String>{};

    for (final dynamic group
        in (body["groups"] as List<dynamic>? ?? const <dynamic>[])) {
      if (group is! Map<String, dynamic>) continue;
      final Map<String, dynamic> items =
          (group["items"] as Map<String, dynamic>?) ?? const <String, dynamic>{};

      // 图片：原图（全屏查看用）+ 400px 缩略图（卡面/网格用）。
      for (final dynamic img
          in (items["images"] as List<dynamic>? ?? const <dynamic>[])) {
        if (img is! Map<String, dynamic>) continue;
        final String raw = img["url"]?.toString().trim() ?? "";
        if (raw.isEmpty) continue;
        final String original = _abs(raw);
        if (t.originals.length < originalCap && seenOriginal.add(original)) {
          t.originals.add(original);
        }
        if (t.thumbs.length < thumbCap) {
          final String thumb =
              "$original${original.contains("?") ? "&" : "?"}w=400";
          if (seenThumb.add(thumb)) t.thumbs.add(thumb);
        }
      }

      // 产出文件：点开走本地缓存（本地文件打开插件），预热字节才有意义。
      for (final dynamic f
          in (items["files"] as List<dynamic>? ?? const <dynamic>[])) {
        if (f is! Map<String, dynamic>) continue;
        final String name = f["name"]?.toString().trim() ?? "";
        if (name.isEmpty) continue;
        final String url = fileUrlFor(name);
        if (t.files.length < fileCap && seenFile.add(url)) t.files.add(url);
      }

      // 笔记正文：id → /notes/:id。
      for (final dynamic n
          in (items["notes"] as List<dynamic>? ?? const <dynamic>[])) {
        if (n is! Map<String, dynamic>) continue;
        final String id = n["id"]?.toString().trim() ?? "";
        if (id.isNotEmpty && seenNote.add(id)) t.noteIds.add(id);
      }

      // 行程：详情 JSON + 封面图。
      for (final dynamic p
          in (items["travelPlans"] as List<dynamic>? ?? const <dynamic>[])) {
        if (p is! Map<String, dynamic>) continue;
        final String id = p["planId"]?.toString().trim() ?? "";
        if (id.isNotEmpty && seenPlan.add(id)) t.planIds.add(id);
        final String cover = p["coverImage"]?.toString().trim() ?? "";
        if (cover.isNotEmpty && t.thumbs.length < thumbCap) {
          final String url = _abs(cover);
          if (seenThumb.add(url)) t.thumbs.add(url);
        }
      }
    }
    return t;
  }

  /// 正文 JSON 预热：笔记 + 行程详情，4 路并发闸门，失败静默。
  static Future<void> _warmTexts(
      List<String> noteIds, List<String> planIds) async {
    final List<Future<void> Function()> tasks = <Future<void> Function()>[];
    for (final String id in noteIds) {
      tasks.add(() => _warmText(
            noteUrlFor(id),
            noteCacheKey(id),
            "笔记",
            id,
          ));
    }
    for (final String id in planIds) {
      tasks.add(() => _warmText(
            planUrlFor(id),
            planCacheKey(id),
            "行程",
            id,
          ));
    }
    for (int i = 0; i < tasks.length; i += textConcurrency) {
      await Future.wait(
        tasks.skip(i).take(textConcurrency).map((f) => f()),
      );
    }
  }

  static Future<void> _warmText(
      String url, String cacheKey, String kind, String id) async {
    try {
      final http.Response res =
          await NbHttp.get(Uri.parse(url)).timeout(textTimeout);
      if (res.statusCode != 200) return;
      final Object? decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic> && decoded["ok"] == true) {
        MobilePageCache.instance.write(cacheKey, decoded);
      }
    } catch (e) {
      debugPrint("[StartupMediaPrefetch] 预热$kind失败($id): $e");
    }
  }

  static String _abs(String path) =>
      path.startsWith("http") ? path : "${ApiConfig.httpBase}$path";

  static String fileUrlFor(String name) =>
      "${ApiConfig.httpBase}/agent/files/"
      "${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}/"
      "${Uri.encodeQueryComponent(name)}";

  static String noteUrlFor(String id) =>
      "${ApiConfig.httpBase}/notes/${Uri.encodeQueryComponent(id)}"
      "?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}";

  static String planUrlFor(String id) =>
      "${ApiConfig.httpBase}/travel/plans/${Uri.encodeQueryComponent(id)}"
      "?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}";

  static String noteCacheKey(String id) =>
      "library_note_${ApiConfig.effectiveActorId}_$id";

  static String planCacheKey(String id) =>
      "library_plan_${ApiConfig.effectiveActorId}_$id";
}

/// 一次预热收集的产物目标（供单测断言）。
class WarmTargets {
  final List<String> thumbs = <String>[];
  final List<String> originals = <String>[];
  final List<String> files = <String>[];
  final List<String> noteIds = <String>[];
  final List<String> planIds = <String>[];
}
