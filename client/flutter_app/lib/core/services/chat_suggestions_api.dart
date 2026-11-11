import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 单条聊天推荐项（GET /api/chat/suggestions）。
///
/// 服务端已按能力就绪状态过滤：出现在列表里的条目即可用。
/// [capabilityId] 供客户端做「能力上新」检测（对比本地已知集合）。
class ChatSuggestion {
  const ChatSuggestion({
    required this.id,
    required this.capabilityId,
    required this.tag,
    required this.prompt,
    this.experimental = false,
    this.personalized = false,
  });

  final String id;

  /// 指向能力就绪注册表条目；null = 内置工具，永远就绪。
  final String? capabilityId;

  /// 能力标签（胶囊上的小字标，如「日程」「打车」）。
  final String tag;

  /// 示例任务文案（点击即作为用户消息发出）。
  final String prompt;

  /// 实验能力徽标（从就绪注册表透传）。
  final bool experimental;

  /// true = 该条按当前用户的使用习惯出了「回访版」文案（服务端判定）。
  final bool personalized;

  /// 「上新」判定与本地已知集合共用的稳定键：优先能力 id，
  /// 无能力 id 的内置条目退化为推荐项自身 id。
  String get capabilityKey => capabilityId ?? "suggestion:$id";

  static ChatSuggestion fromJson(Map<String, dynamic> json) => ChatSuggestion(
        id: json["id"]?.toString() ?? "",
        capabilityId: json["capabilityId"]?.toString(),
        tag: json["tag"]?.toString() ?? "",
        prompt: json["prompt"]?.toString() ?? "",
        experimental: json["experimental"] as bool? ?? false,
        personalized: json["personalized"] as bool? ?? false,
      );
}

/// 聊天推荐项 API（「为你推荐」空态列表与对话中横滑条共用）。
class ChatSuggestionsApi {
  ChatSuggestionsApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;
  static const Duration _timeout = Duration(seconds: 10);
  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  Future<List<ChatSuggestion>> fetch() async {
    // 按用户个性化：带当前登录身份（与服务端 actorId 同口径）；
    // 鉴权开启时服务端会以 token 归属钉死，这里的 userId 只是兜底通道。
    final String actorId =
        AccessCredentialStore.instance.userId?.isNotEmpty == true
            ? AccessCredentialStore.instance.userId!
            : ApiConfig.effectiveActorId;
    final Uri uri = Uri.parse("$_baseUrl/api/chat/suggestions").replace(
      queryParameters: <String, String>{"userId": actorId},
    );
    final http.Response res = await _client
        .get(uri, headers: _headers)
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取聊天推荐项失败: ${res.statusCode}");
    }
    final Map<String, dynamic> body =
        jsonDecode(res.body) as Map<String, dynamic>;
    final List<dynamic> items = body["suggestions"] as List<dynamic>? ?? const [];
    return items
        .whereType<Map<String, dynamic>>()
        .map(ChatSuggestion.fromJson)
        .toList(growable: false);
  }
}
