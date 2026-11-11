import "dart:convert";
import "dart:io" show Directory, File;

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";

/// 远程配置下发·地基（2026-11-10）：运行期地址解析。
///
/// 编译期只烤一个引导锚点（控制面域名 [ApiConfig.controlPlaneBase]），
/// 主服务/控制面/更新清单地址在运行期从控制面 `GET /api/client/config`
/// 拿——换机房 / 迁域名 / 故障切换 = 服务端改一条配置，客户端下次启动
/// 生效，不再依赖重烤包 + 发版。
///
/// 三级兜底链（每一级失败都 fail-open，绝不因配置服务不可达锁门）：
/// 1. 上次成功拉取的**落盘缓存**（启动同步应用——与 InstallIdentity
///    `applyBootChannel` 同语义：「上次取到的，本次生效」）；
/// 2. 缓存缺失/损坏 → 保持烤入值；
/// 3. 后台静默刷新：成功则更新内存缓存文件，**只落盘不立即应用**（当前
///    会话的 WS/请求连接已按启动地址建立，中途换地址会把进行中的会话撕开；
///    新地址下次启动接管，语义与 channel 一致）。
///
/// 字段为空 = 不覆盖烤入值（服务端地基阶段默认全空，零行为变化）。
class RemoteConfig {
  RemoteConfig._();

  static final RemoteConfig instance = RemoteConfig._();

  static const String _fileName = "remote_config_cache.json";
  static const Duration _fetchTimeout = Duration(seconds: 5);

  /// 上次成功拉取的原始快照（落盘内容）；null = 从未成功拉取过。
  Map<String, String>? _lastFetched;

  /// 上次成功拉取的原始字段（诊断/埋点用）；null = 从未成功拉取过。
  Map<String, String>? get lastFetched => _lastFetched;

  /// 启动期同步应用：读缓存文件并覆盖 [ApiConfig]。
  /// 缓存缺失/损坏时静默跳过（保持烤入值），绝不抛错。
  Future<void> applyCached() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (!await file.exists()) return;
      final Map<String, dynamic> json =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final String httpBase = json["httpBase"]?.toString() ?? "";
      final String controlPlane = json["controlPlaneUrl"]?.toString() ?? "";
      final String updateManifest = json["updateManifestUrl"]?.toString() ?? "";
      if (httpBase.isEmpty && controlPlane.isEmpty && updateManifest.isEmpty) return;
      ApiConfig.applyRemoteOverrides(
        httpBase: httpBase,
        controlPlaneUrl: controlPlane,
        updateManifestUrl: updateManifest,
      );
    } catch (e) {
      // 缓存损坏是可自愈状态（下次成功拉取会重写），fail-open 保持烤入值。
      debugPrint("[RemoteConfig] applyCached failed (ignored): $e");
    }
  }

  /// 后台静默刷新：拉控制面配置 → 校验 → 落盘缓存。**只落盘不立即应用**
  /// （新地址下次启动接管，见类注释第 3 级兜底语义）。
  /// 任何失败（网络/超时/解析/HTTP 非 200）静默返回 false，当前行为不变。
  Future<bool> refreshAndPersist() async {
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.controlPlaneBase}/api/client/config"))
          .timeout(_fetchTimeout);
      if (resp.statusCode != 200) return false;
      final Map<String, dynamic> json =
          jsonDecode(resp.body) as Map<String, dynamic>;
      if (json["ok"] != true) return false;
      final String httpBase = json["httpBase"]?.toString() ?? "";
      final String controlPlane = json["controlPlaneUrl"]?.toString() ?? "";
      final String updateManifest = json["updateManifestUrl"]?.toString() ?? "";
      if (httpBase.isEmpty && controlPlane.isEmpty && updateManifest.isEmpty) {
        // 服务端全空 = 明确「无覆盖」，清掉历史缓存，回烤入值语义。
        _lastFetched = null;
        await _clearCacheFile();
        return true;
      }
      _lastFetched = <String, String>{
        if (httpBase.isNotEmpty) "httpBase": httpBase,
        if (controlPlane.isNotEmpty) "controlPlaneUrl": controlPlane,
        if (updateManifest.isNotEmpty) "updateManifestUrl": updateManifest,
      };
      await _writeCacheFile(_lastFetched!);
      return true;
    } catch (e) {
      debugPrint("[RemoteConfig] refresh failed (kept previous): $e");
      return false;
    }
  }

  Future<void> _writeCacheFile(Map<String, String> value) async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      await file.writeAsString(jsonEncode(value), flush: true);
    } catch (e) {
      debugPrint("[RemoteConfig] persist failed (ignored): $e");
    }
  }

  Future<void> _clearCacheFile() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (await file.exists()) await file.delete();
    } catch (_) {
      // 删除失败无害：缓存内容仍与烤入值语义兼容（下次拉取覆盖）。
    }
  }
}
