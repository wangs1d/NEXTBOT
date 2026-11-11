import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 能力就绪状态。
///
/// state：ready = 可用；needs_config = 缺配置（内测期去服务端 .env 配置）。
/// experimental = 实验能力，稳定性预期较低，卡片带"实验"徽标。
class CapabilityStatus {
  const CapabilityStatus({
    required this.id,
    required this.label,
    required this.description,
    required this.state,
    this.experimental = false,
    this.hints = const <String>[],
    this.note,
  });

  final String id;
  final String label;
  final String description;
  final String state;
  final bool experimental;
  final List<String> hints;
  final String? note;

  bool get ready => state == "ready";

  static CapabilityStatus fromJson(Map<String, dynamic> json) => CapabilityStatus(
        id: json["id"]?.toString() ?? "",
        label: json["label"]?.toString() ?? "",
        description: json["description"]?.toString() ?? "",
        state: json["state"]?.toString() ?? "ready",
        experimental: json["experimental"] as bool? ?? false,
        hints: (json["hints"] as List<dynamic>? ?? <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        note: json["note"]?.toString(),
      );
}

/// 能力总览（GET /api/capabilities 响应）。
///
/// configSource：byok = 内测期用户自备 key；platform = 平台统一供 key（统一服务付费）。
/// 客户端据此切换文案：byok 显示"去配置"引导，platform 显示"已包含"。
class CapabilityOverview {
  const CapabilityOverview({
    required this.configSource,
    required this.capabilities,
  });

  final String configSource;
  final List<CapabilityStatus> capabilities;

  bool get platformProvided => configSource == "platform";
  int get readyCount => capabilities.where((c) => c.ready).length;

  static CapabilityOverview fromJson(Map<String, dynamic> json) => CapabilityOverview(
        configSource: json["configSource"]?.toString() ?? "byok",
        capabilities: (json["capabilities"] as List<dynamic>? ?? <dynamic>[])
            .map((e) => CapabilityStatus.fromJson(e as Map<String, dynamic>))
            .toList(growable: false),
      );
}

/// 能力就绪状态 API（渐进式解锁卡片的客户端数据源）。
class CapabilityApi {
  CapabilityApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;
  static const Duration _timeout = Duration(seconds: 10);
  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  Future<CapabilityOverview> fetch() async {
    final http.Response res =
        await _client.get(Uri.parse("$_baseUrl/api/capabilities"), headers: _headers).timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取能力状态失败: ${res.statusCode}");
    }
    return CapabilityOverview.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }
}
