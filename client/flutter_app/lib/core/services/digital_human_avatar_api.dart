import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

class DigitalHumanAvatarJob {
  const DigitalHumanAvatarJob({
    required this.state,
    required this.progress,
    required this.message,
  });

  final String state;
  final int progress;
  final String message;

  bool get isReady => state == "ready";
  bool get isError => state == "error";
}

class DigitalHumanAvatarApi {
  DigitalHumanAvatarApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.digitalHumanBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  Future<String> upload(List<int> bytes, String fileName) async {
    final Uri uri = Uri.parse("$_baseUrl/api/avatar");
    final http.MultipartRequest request = http.MultipartRequest("POST", uri)
      ..files.add(http.MultipartFile.fromBytes(
        "file",
        bytes,
        filename: fileName,
      ));
    final http.StreamedResponse response =
        await _client.send(request).timeout(const Duration(seconds: 60));
    final Map<String, dynamic> data =
        jsonDecode(utf8.decode(await response.stream.toBytes()))
            as Map<String, dynamic>;
    if (response.statusCode != 200 || data["ok"] != true) {
      throw StateError(_message(data) ?? "头像上传失败");
    }
    final Object? job = data["job"];
    if (job is! String || job.isEmpty) {
      throw StateError("头像服务未返回任务号");
    }
    return job;
  }

  Future<DigitalHumanAvatarJob> status(String jobId) async {
    final Uri uri = Uri.parse("$_baseUrl/api/avatar/status/$jobId");
    final http.Response response =
        await _client.get(uri).timeout(const Duration(seconds: 15));
    final Map<String, dynamic> data =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (response.statusCode != 200) {
      throw StateError(_message(data) ?? "头像任务查询失败");
    }
    return DigitalHumanAvatarJob(
      state: (data["state"] ?? "").toString(),
      progress: (data["progress"] as num?)?.round() ?? 0,
      message: _message(data) ?? "处理中…",
    );
  }

  void close() => _client.close();

  static String? _message(Map<String, dynamic> data) {
    final Object? message = data["message"];
    if (message is String && message.isNotEmpty) return message;
    final Object? detail = data["detail"];
    return detail?.toString();
  }
}
