import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint, visibleForTesting;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";
import "account_session_store.dart";
import "device_key_backup.dart";

/// 控制面身份与启动状态：反馈、站内信、运行埋点等运营数据以此 actor 身份
/// 落库到管理后台；`channel` 落盘供下次启动决定是否拉起本机 runtime。
///
/// 优先级：登录邮箱（账号会话，已归一化，按账号隔离）>
/// `USER_ID`（部署配置，显式指定）> 持久化安装 ID。
///
/// 安装 ID 在 Android 上由 `ANDROID_ID` 派生（见 DeviceKeyBackupPlugin）：
/// Android 8+ 按「设备 + 用户 + 应用签名」分区，**同签名卸载重装保持不变**。
/// 这一点是用户自有模型 key 跨卸载生效的关键——服务端把加密绑定存在
/// `model-keys/<actor>.enc`，随机 id 重装后一换就永远认不出来。
/// 桌面端/取不到设备标识时回落随机 `inst_…`，语义与旧版一致。
class InstallIdentity {
  InstallIdentity._();

  static final InstallIdentity instance = InstallIdentity._();

  static const String _fileName = "install_identity.json";

  /// 目录解析可替换：单测钉到临时目录，生产用 path_provider。
  static Future<Directory> Function() directoryResolver =
      getApplicationSupportDirectory;

  /// 仅单测：清空内存态，让下一轮 _ensureLoaded() 真的走一遍稳定 id 决议。
  @visibleForTesting
  void resetForTest() {
    _loaded = false;
    _installId = null;
    _channel = null;
    _legacyInstallId = null;
  }

  String? _installId;
  String? _channel;
  String? _legacyInstallId;
  bool _loaded = false;

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _loaded = true;
    // 先取稳定设备标识：即使私有文件被卸载清掉，重装后仍落到同一个 actor。
    final String? stableId = await DeviceKeyBackup.instance.stableInstallId();
    String? fileId;
    bool fileExists = false;
    try {
      final Directory dir = await directoryResolver();
      final File file = File("${dir.path}/$_fileName");
      fileExists = await file.exists();
      if (fileExists) {
        final Map<String, dynamic> json =
            jsonDecode(await file.readAsString()) as Map<String, dynamic>;
        final String id = json["installId"]?.toString() ?? "";
        if (id.isNotEmpty) fileId = id;
        final String channel = json["channel"]?.toString() ?? "";
        if (channel.isNotEmpty) _channel = channel;
        final String legacy = json["legacyInstallId"]?.toString() ?? "";
        if (legacy.isNotEmpty) _legacyInstallId = legacy;
      }
    } catch (e) {
      debugPrint("[InstallIdentity] 读安装身份文件失败: $e");
    }

    if (stableId != null && stableId.isNotEmpty) {
      final String? legacy =
          (fileId != null && fileId != stableId) ? fileId : _legacyInstallId;
      _installId = stableId;
      if (legacy != null && legacy.isNotEmpty) _legacyInstallId = legacy;
      // 已是稳定 id 且文件完好就不重写，避免每次启动都做一次磁盘 I/O。
      if (fileId != stableId || !fileExists) {
        await _persist();
      }
      return;
    }

    if (fileId != null && fileId.isNotEmpty) {
      _installId = fileId;
      return;
    }

    // 非 Android / 取不到 ANDROID_ID：沿用旧的随机安装 id。
    final String id =
        "inst_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_${(DateTime.now().microsecondsSinceEpoch % 1679616).toRadixString(36)}";
    _installId = id;
    await _persist();
  }

  Future<void> _persist() async {
    try {
      final Directory dir = await directoryResolver();
      await File("${dir.path}/$_fileName").writeAsString(
        jsonEncode(<String, String>{
          if (_installId != null) "installId": _installId!,
          if (_channel != null) "channel": _channel!,
          if (_legacyInstallId != null && _legacyInstallId!.isNotEmpty)
            "legacyInstallId": _legacyInstallId!,
        }),
        flush: true,
      );
    } catch (e) {
      debugPrint("[InstallIdentity] 落盘安装身份失败（内存态仍可用）: $e");
    }
  }

  /// 控制面 actor 身份：登录邮箱优先（同一台机器换账号登录，运营数据
  /// 跟着账号走而不是跟着机器走），其次部署配置，最后安装身份。
  Future<String> actorId() async {
    // 自带 load（幂等）：不依赖调用方先初始化账号会话，避免启动竞态
    await AccountSessionStore.instance.load();
    final String? email = AccountSessionStore.instance.email;
    if (email != null && email.isNotEmpty) return email;
    final String u = ApiConfig.userId.trim();
    if (u.isNotEmpty) return u;
    await _ensureLoaded();
    return _installId ?? "local-device";
  }

  /// 已加载的安装身份；`applyBootChannel()` 在 runApp 前跑过一次即可同步读，
  /// 未加载时为 null（调用方自行兜底）。
  String? get cachedInstallId => _installId;

  /// 本机安装身份（`inst_…`）：运行埋点的主键，与 actorId 的未登录兜底同源。
  Future<String> installId() async {
    await _ensureLoaded();
    return _installId ?? "local-device";
  }

  /// 启动早期（runApp 之前）调用：把上次落盘的 channel 灌进 ApiConfig，
  /// 让首个网络请求就落在正确的运行通道上。
  Future<void> applyBootChannel() async {
    await _ensureLoaded();
    ApiConfig.applyRuntimeChannel(_channel);
  }

  /// 落盘服务端清单的 channel，下次启动生效（会话中途不切通道）。
  Future<void> saveChannel(String channel) async {
    final String c = channel.trim();
    if (c != "byok" && c != "platform") return;
    await _ensureLoaded();
    if (_channel == c) return;
    _channel = c;
    await _persist();
  }
}
