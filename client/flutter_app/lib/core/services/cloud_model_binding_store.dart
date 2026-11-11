import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

import "device_key_backup.dart";

/// 云端连接版「用户自有模型」配置（BYOK over cloud）的本地持久化。
///
/// 用户在服务接入页填自有 OpenAI 兼容端点三元组（baseUrl / apiKey / model）后：
///  ① 本机 App 支持目录存一份 JSON（快速读取、UI 角标、session.init 上送）；
///  ② 同步写一份 **AES-256-GCM 加密** 备份到 Android 公共 Downloads/NEXTBOT/
///     （不属于 App 私有数据，卸载不会被删，见 DeviceKeyBackupPlugin.kt）；
///  ③ 随 `session.init` 上送，服务端按 actor 加密落盘 `model-keys/<actor>.enc`。
///
/// 三份里任何一份活着，卸载重装后 key 都还能用：
///  - 本机公共备份：启动时 load() 自动读回并回写私有文件；
///  - 服务端绑定：安装标识改成稳定设备 id 后，重装仍以同一 actor 命中，
///    即使本机两份都没了，chatProviderFor 照样取到用户的 key 接着聊。
///
/// 「停用自有模型」会把私有文件删掉、公共备份写成 revoked 记录，
/// 并通过 session.init 上送空 modelProvider 撤销服务端绑定——三处一致，
/// 不会出现重装后幽灵复活。
///
/// 桌面端没有公共备份通道，保持「私有目录单份」的原有语义。
class CloudModelBindingStore {
  CloudModelBindingStore._();

  static final CloudModelBindingStore instance = CloudModelBindingStore._();

  static const String _fileName = "cloud_model_binding.json";

  /// 目录解析可替换：单测钉到临时目录，生产用 path_provider。
  static Future<Directory> Function() directoryResolver =
      getApplicationSupportDirectory;

  String? _baseUrl;
  String? _apiKey;
  String? _model;
  bool _loaded = false;

  String? get baseUrl => _baseUrl;
  String? get apiKey => _apiKey;
  String? get model => _model;

  /// 三元组齐全才算已配置（缺任何一项都无法构成有效 provider）。
  bool get isConfigured =>
      (_baseUrl?.trim().isNotEmpty ?? false) &&
      (_apiKey?.trim().isNotEmpty ?? false) &&
      (_model?.trim().isNotEmpty ?? false);

  /// baseUrl 是否为 https（服务端 SSRF 门同样校验，这里前置提示用户）。
  bool get baseUrlIsHttps => (_baseUrl?.trim().startsWith("https://") ?? false);

  /// 仅单测：清空内存态，让下一轮 load() 真的走一遍恢复链。
  @visibleForTesting
  void resetForTest() {
    _loaded = false;
    _baseUrl = null;
    _apiKey = null;
    _model = null;
  }

  /// 启动时加载一次：私有文件 → 跨卸载加密备份（缺失时）→ 回写私有文件自愈。
  /// 文件缺失/损坏视为未配置，任何异常都不抛出，不让启动被一份配置卡住。
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    await _readPrivate();
    if (!isConfigured) {
      await _restoreFromBackup();
    }
  }

  /// 保存三元组（trim 后落盘）；任一字段为空视为清除配置。
  Future<void> save({
    required String baseUrl,
    required String apiKey,
    required String model,
  }) async {
    final String b = baseUrl.trim();
    final String k = apiKey.trim();
    final String m = model.trim();
    if (b.isEmpty || k.isEmpty || m.isEmpty) {
      _baseUrl = null;
      _apiKey = null;
      _model = null;
    } else {
      _baseUrl = b;
      _apiKey = k;
      _model = m;
    }
    await _write();
  }

  /// 清除配置（UI「停用自有模型」入口）。
  Future<void> clear() async {
    _baseUrl = null;
    _apiKey = null;
    _model = null;
    await _write();
  }

  Future<void> _readPrivate() async {
    try {
      final Directory dir = await directoryResolver();
      final File file = File("${dir.path}/$_fileName");
      if (!await file.exists()) return;
      final Map<String, dynamic> json =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      _baseUrl = json["baseUrl"] as String?;
      _apiKey = json["apiKey"] as String?;
      _model = json["model"] as String?;
    } catch (e) {
      debugPrint("[CloudModelBinding] 读取本机配置失败（视为未配置）: $e");
      _baseUrl = null;
      _apiKey = null;
      _model = null;
    }
  }

  /// 私有文件没了（典型场景：卸载重装）→ 读公共目录加密备份并回写私有文件。
  /// revoked 记录没有三元组，会被判空忽略，不会把已停用的配置复活。
  Future<void> _restoreFromBackup() async {
    final String? raw = await DeviceKeyBackup.instance.readBackup();
    if (raw == null || raw.trim().isEmpty) return;
    try {
      final Map<String, dynamic> json = jsonDecode(raw) as Map<String, dynamic>;
      final String b = (json["baseUrl"] as String? ?? "").trim();
      final String k = (json["apiKey"] as String? ?? "").trim();
      final String m = (json["model"] as String? ?? "").trim();
      if (b.isEmpty || k.isEmpty || m.isEmpty) return;
      _baseUrl = b;
      _apiKey = k;
      _model = m;
      await _writePrivate();
      debugPrint("[CloudModelBinding] 已从跨卸载本机备份恢复配置");
    } catch (e) {
      debugPrint("[CloudModelBinding] 解析跨卸载备份失败（视为未配置）: $e");
    }
  }

  Future<void> _write() async {
    await _writePrivate();
    await _syncBackup();
  }

  Future<void> _writePrivate() async {
    try {
      final Directory dir = await directoryResolver();
      final File file = File("${dir.path}/$_fileName");
      if (!isConfigured) {
        if (await file.exists()) {
          await file.delete();
        }
        return;
      }
      await file.writeAsString(
        jsonEncode(<String, String>{
          "baseUrl": _baseUrl!,
          "apiKey": _apiKey!,
          "model": _model!,
        }),
        flush: true,
      );
    } catch (e) {
      debugPrint("[CloudModelBinding] 写入本机配置失败: $e");
    }
  }

  /// 公共备份与私有文件同写。清空时写 revoked 覆盖记录，而不是只删文件：
  /// Android 11+ 删不掉「非本应用创建」的公共文件，靠覆盖才能保证停用持久。
  Future<void> _syncBackup() async {
    final String payload = isConfigured
        ? jsonEncode(<String, String>{
            "baseUrl": _baseUrl!,
            "apiKey": _apiKey!,
            "model": _model!,
          })
        : '{"revoked":true}';
    final bool ok = await DeviceKeyBackup.instance.writeBackup(payload);
    if (!ok) {
      debugPrint(
        "[CloudModelBinding] 跨卸载备份未写入（桌面端/存储受限）；服务端绑定与私有文件仍可用",
      );
    }
  }
}
