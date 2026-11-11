import "dart:convert";
import "dart:typed_data";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "../config/media_url.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 用户头像 API 客户端（服务端实现：server/src/routes/http/user-avatar.ts）。
///
///   - GET  /api/user/avatar?userId=   查询当前头像相对路径（无头像 → null）
///   - POST /api/user/avatar?userId=   multipart 上传，服务端归一 512 方图 webp
///
/// 返回的 avatarPath 是相对路径（如 /agent/avatars/<actor>/<uuid>.webp），
/// 展示时用 [resolveUrl] 拼本端 httpBase 成绝对地址 —— 多端各按自己的
/// 服务器基址解析，路径本身跨端可复用。
class UserAvatarApi {
  UserAvatarApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 15);

  /// 相对路径 → 本端绝对 URL（带设备凭证）；外部绝对地址原样返回。
  static String? resolveUrl(String? avatarPath) {
    final String p = avatarPath?.trim() ?? "";
    if (p.isEmpty) return null;
    return MediaUrl.resolve(p);
  }

  Map<String, String> get _authHeaders => AccessCredentialStore.instance.authHeaders;

  /// 查询当前头像相对路径；无头像 / 失败返回 null（启动拉取属非关键链路，静默降级）。
  Future<String?> fetchAvatarPath() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/user/avatar").replace(
        queryParameters: <String, String>{"userId": ApiConfig.effectiveActorId},
      );
      final http.Response res =
          await _client.get(uri, headers: _authHeaders).timeout(_timeout);
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> json =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (json["ok"] != true) return null;
      final Object? path = json["avatarPath"];
      return path is String && path.isNotEmpty ? path : null;
    } catch (e) {
      debugPrint("[UserAvatarApi] fetchAvatarPath failed: $e");
      return null;
    }
  }

  /// 上传头像（multipart）。成功返回新的 avatarPath；失败返回 null（调用方给提示）。
  Future<String?> uploadAvatar(Uint8List bytes, String fileName) async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/user/avatar").replace(
        queryParameters: <String, String>{"userId": ApiConfig.effectiveActorId},
      );
      final http.MultipartRequest request = http.MultipartRequest("POST", uri)
        ..headers.addAll(_authHeaders)
        ..files.add(
          http.MultipartFile.fromBytes("file", bytes, filename: fileName),
        );
      final http.StreamedResponse res =
          await request.send().timeout(_timeout);
      final Map<String, dynamic> json =
          jsonDecode(utf8.decode(await res.stream.toBytes()))
              as Map<String, dynamic>;
      if (res.statusCode != 200 || json["ok"] != true) {
        debugPrint(
          "[UserAvatarApi] upload failed: ${res.statusCode} ${json["error"]}",
        );
        return null;
      }
      final Object? path = json["avatarPath"];
      return path is String && path.isNotEmpty ? path : null;
    } catch (e) {
      debugPrint("[UserAvatarApi] uploadAvatar failed: $e");
      return null;
    }
  }
}
