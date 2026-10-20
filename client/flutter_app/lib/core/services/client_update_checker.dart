import "dart:async";
import "dart:convert";
import "dart:io" show Directory, File, FileMode;

import "package:flutter/foundation.dart" show debugPrint, kDebugMode;
import "package:http/http.dart" as http;
import "package:package_info_plus/package_info_plus.dart";

import "../config/api_config.dart";

/// 服务端 `GET /api/client/manifest` 下发的客户端版本清单。
///
/// [channel] 是后期收回 runtime 的总开关：`byok` = 内测期 runtime 随安装包装到
/// 用户机器本地跑（自带 key）；服务器改 `platform` 后客户端下次启动读到即切
/// 统一 API 服务，必要时配合 minVersion 抬升强制淘汰旧版。
class ClientManifest {
  const ClientManifest({
    required this.latest,
    required this.minVersion,
    required this.url,
    required this.notes,
    required this.channel,
  });

  final String latest;
  final String minVersion;
  final String url;
  final String notes;
  final String channel;

  factory ClientManifest.fromJson(Map<String, dynamic> json) => ClientManifest(
        latest: json["latest"]?.toString() ?? "",
        minVersion: json["minVersion"]?.toString() ?? "",
        url: json["url"]?.toString() ?? "",
        notes: json["notes"]?.toString() ?? "",
        channel: json["channel"]?.toString() ?? "byok",
      );
}

enum ClientUpdateStatus { upToDate, optionalUpdate, forcedUpdate }

class ClientUpdateCheckResult {
  const ClientUpdateCheckResult({
    required this.status,
    required this.manifest,
    required this.localVersion,
  });

  final ClientUpdateStatus status;
  final ClientManifest manifest;
  final String localVersion;
}

/// 启动版本检查：拉 manifest 并与本地版本（exe 版本资源，源自 pubspec）比对。
///
/// 任何失败（网络/超时/解析/读版本）都返回 null —— fail-open，绝不因服务器
/// 不可达把用户锁在门外；强锁只在「明确拿到清单 && 低于 minVersion && 下载地址
/// 可用」时触发（url 为空时没有升级出口，一律按可继续使用处理）。
/// 复用持久连接：首次 `http.get` 顶层用法每次新建客户端，Windows debug 下
/// 首调含 ~180ms 初始化开销；保活后手动检查稳定在 ~10ms。
final http.Client _updateHttpClient = http.Client();

/// 会话内结果缓存：检查成功过的结果 5 分钟内直接复用，手动「检查更新」
/// 不再等一次网络往返——没有新版本时通知必须立马弹出。缓存随进程存活
/// （重启即空，启动检查会重新填上）；失败不缓存，「重试」永远真查。
ClientUpdateCheckResult? _sessionCache;
DateTime? _sessionCacheAt;
const Duration _sessionCacheTtl = Duration(minutes: 5);

/// 「检查更新」全链路毫秒级 trace：手动检查慢（卡片几秒后才出）时用来定位
/// 卡在哪一环——点击 / 缓存命中 / HTTP 往返 / 读本地版本 / 卡片渲染各自打点。
/// 落盘到 %TEMP%\pai_update_check_trace.log（stderr 被独占重定向、stdout 随
/// 直接启动丢失，控制台类日志在线上形态拿不到）。开销：每次检查 2~5 行
/// 追加写，可忽略；发布构建默认关闭（[traceEnabled]）。
const bool _updateTraceEnabled =
    bool.fromEnvironment("PAI_UPDATE_TRACE", defaultValue: false) || kDebugMode;

void updateCheckTrace(String event) {
  if (!_updateTraceEnabled) return;
  try {
    final DateTime now = DateTime.now();
    final String ts =
        "${now.hour.toString().padLeft(2, "0")}:${now.minute.toString().padLeft(2, "0")}:${now.second.toString().padLeft(2, "0")}.${now.millisecond.toString().padLeft(3, "0")}";
    final File f = File(
        "${Directory.systemTemp.path}\\pai_update_check_trace.log");
    f.writeAsStringSync(
      "$ts $event\n",
      mode: FileMode.append,
      flush: false,
    );
  } catch (_) {
    // trace 永不影响主流程
  }
}

/// [forceRefresh] = 跳过缓存强查一次（失败卡上的「重试」走这条）。
Future<ClientUpdateCheckResult?> checkClientUpdate({bool forceRefresh = false}) async {
  if (!forceRefresh && _sessionCache != null) {
    final Duration age = DateTime.now().difference(_sessionCacheAt!);
    if (age < _sessionCacheTtl) {
      updateCheckTrace("cache-hit age=${age.inMilliseconds}ms");
      if (kDebugMode) {
        debugPrint("[update-check] session cache hit (age=${age.inMilliseconds}ms)");
      }
      return _sessionCache;
    }
    _sessionCache = null; // 过期作废，走下面的真查
  }
  updateCheckTrace(
      "fresh-check begin${forceRefresh ? " (forced)" : ""}${_sessionCache != null ? " (cache-expired)" : " (no-cache)"}");
  final Stopwatch sw = Stopwatch()..start();
  final ClientUpdateCheckResult? result = await _checkClientUpdateUncached();
  if (kDebugMode) {
    debugPrint(
        "[update-check] fresh check took ${sw.elapsedMilliseconds}ms"
        "${forceRefresh ? " (forced)" : ""}");
  }
  updateCheckTrace("fresh-check done status=${result?.status.name ?? "null"} in ${sw.elapsedMilliseconds}ms");
  if (result != null) {
    _sessionCache = result;
    _sessionCacheAt = DateTime.now();
  }
  return result;
}

Future<ClientUpdateCheckResult?> _checkClientUpdateUncached() async {
  // 本机开发构建（Debug flavor）不走发版版本门禁（用户约定 2026-09-28）：
  // 本机跑的永远视为最新，不被公网 manifest 的 latest/minVersion 提醒或强锁。
  // 发给用户的安装包（Release flavor）不受影响，照常比对。
  if (kDebugMode) {
    try {
      final Stopwatch piSw = Stopwatch()..start();
      final PackageInfo info = await PackageInfo.fromPlatform();
      updateCheckTrace("debug-branch packageInfo=${piSw.elapsedMilliseconds}ms v${info.version}");
      return ClientUpdateCheckResult(
        status: ClientUpdateStatus.upToDate,
        manifest: const ClientManifest(
          latest: "",
          minVersion: "",
          url: "",
          notes: "",
          channel: "byok",
        ),
        localVersion: info.version,
      );
    } catch (e) {
      debugPrint("[update-check] debug build read local version failed: $e");
      return null;
    }
  }
  try {
    final Stopwatch httpSw = Stopwatch()..start();
    final http.Response res = await _updateHttpClient
        // 发行版双清单：服务端按 ?edition= 读 client-manifest.<edition>.json（缺失回落主文件）
        .get(Uri.parse(
            "${ApiConfig.updateManifestUrl}/api/client/manifest?edition=${ApiConfig.edition}"))
        .timeout(const Duration(seconds: 3));
    updateCheckTrace("http done code=${res.statusCode} in ${httpSw.elapsedMilliseconds}ms url=${Uri.parse("${ApiConfig.updateManifestUrl}/api/client/manifest").host}");
    if (res.statusCode != 200) return null;
    final dynamic body = jsonDecode(utf8.decode(res.bodyBytes));
    if (body is! Map<String, dynamic>) return null;
    final ClientManifest manifest = ClientManifest.fromJson(body);
    if (manifest.latest.isEmpty || manifest.minVersion.isEmpty) return null;

    final Stopwatch piSw = Stopwatch()..start();
    final PackageInfo info = await PackageInfo.fromPlatform();
    updateCheckTrace("release-branch packageInfo=${piSw.elapsedMilliseconds}ms v${info.version}");
    final String local = info.version;

    return ClientUpdateCheckResult(
      status: classifyUpdate(local, manifest),
      manifest: manifest,
      localVersion: local,
    );
  } catch (e) {
    debugPrint("[update-check] failed (fail-open): $e");
    return null;
  }
}

/// 版本比对（纯函数，HTTP 轮询与 wss 推送共用）：
/// 低于 minVersion → 强更（url 空时没有升级出口，按可继续使用处理）；
/// 低于 latest → 可选升级；其余 → 已最新。
ClientUpdateStatus classifyUpdate(String local, ClientManifest manifest) {
  if (manifest.latest.isEmpty || manifest.minVersion.isEmpty) {
    return ClientUpdateStatus.upToDate;
  }
  if (compareVersions(local, manifest.minVersion) < 0) {
    return manifest.url.isEmpty
        ? ClientUpdateStatus.upToDate
        : ClientUpdateStatus.forcedUpdate;
  }
  if (compareVersions(local, manifest.latest) < 0) {
    return manifest.url.isEmpty
        ? ClientUpdateStatus.upToDate
        : ClientUpdateStatus.optionalUpdate;
  }
  return ClientUpdateStatus.upToDate;
}

List<int> _parseVersionSegments(String v) => v
    .trim()
    .split("+")
    .first
    .split(".")
    .map((String s) => int.tryParse(s.trim()) ?? 0)
    .toList();

/// 点分数字版本比较（负数/0/正数），忽略 `+build` 尾缀。
/// 例：`0.1.15` > `0.1.9`（字符串直接比较会得到相反结果）。
int compareVersions(String a, String b) {
  final List<int> pa = _parseVersionSegments(a);
  final List<int> pb = _parseVersionSegments(b);
  final int len = pa.length > pb.length ? pa.length : pb.length;
  for (int i = 0; i < len; i++) {
    final int x = i < pa.length ? pa[i] : 0;
    final int y = i < pb.length ? pb[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}
