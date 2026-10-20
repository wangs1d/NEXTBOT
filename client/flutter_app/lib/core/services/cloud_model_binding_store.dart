import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// 云端连接版「用户自有模型」配置（BYOK over cloud）的本地持久化。
///
/// 云端连接版（exe 旁无捆绑 runtime）里模型调用跑在云端服务器，用户在设置页
/// 填写自有 OpenAI 兼容端点三元组（baseUrl / apiKey / model）后存本机 JSON；
/// 每次 WebSocket 连接建立时随 `session.init` 上送（仅 wss 连接才上送，明文
/// ws 不送 key）。服务端把 key 绑定到该账号后纯内存驻留（TTL 24h），
/// 客户端重连重传自愈——本文件只是本机「填过什么」的记录。
///
/// 与 AccessCredentialStore 同思路：应用支持目录下单个 JSON 文件，key 明文
/// 落盘（桌面个人设备场景下泄露面等同本机用户账户，可接受）。
class CloudModelBindingStore {
  CloudModelBindingStore._();

  static final CloudModelBindingStore instance = CloudModelBindingStore._();

  static const String _fileName = "cloud_model_binding.json";

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

  /// 启动时加载一次；文件缺失/损坏视为未配置。
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final Directory dir = await getApplicationSupportDirectory();
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

  Future<void> _write() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
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
}
