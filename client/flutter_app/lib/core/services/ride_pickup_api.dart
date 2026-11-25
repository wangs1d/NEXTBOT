import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 上车点候选（`POST /api/ride/pickup-candidates`，坐标一律 WGS-84）。
class RidePickupCandidate {
  const RidePickupCandidate({
    required this.name,
    required this.address,
    required this.lat,
    required this.lng,
    this.distM,
  });

  final String name;
  final String address;
  final double lat;
  final double lng;
  final int? distM;

  /// 还原成卡片内部使用的候选 map（与 card payload 同构）。
  Map<String, dynamic> toPayload() => <String, dynamic>{
        "name": name,
        "address": address,
        "lat": lat,
        "lng": lng,
        if (distM != null) "distM": distM,
      };

  static RidePickupCandidate? fromJson(Map<String, dynamic> json) {
    final double? lat = (json["lat"] as num?)?.toDouble();
    final double? lng = (json["lng"] as num?)?.toDouble();
    if (lat == null || lng == null) return null;
    return RidePickupCandidate(
      name: json["name"]?.toString() ?? "",
      address: json["address"]?.toString() ?? "",
      lat: lat,
      lng: lng,
      distM: (json["distM"] as num?)?.toInt(),
    );
  }
}

/// 一次重推的结果：候选 + 该位置的 POI 名（用于「自定义上车点」的命名）。
class RidePickupSuggestion {
  const RidePickupSuggestion({required this.label, required this.candidates});

  final String label;
  final List<RidePickupCandidate> candidates;
}

/// 选点卡「拖图后重新推荐」（滴滴上车点算法的「更改逻辑」）。
///
/// 拖动是高频交互：调用方必须自己去抖（卡片里 600ms 去抖 + 200m 位移阈值），
/// 本类只负责一次请求，失败返回 null（卡片保留原候选，不报错打扰用户）。
class RidePickupApi {
  RidePickupApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;
  static const Duration _timeout = Duration(seconds: 8);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// [withCandidates] = false 时只做逆地理（地图拖动时先把地名贴到图钉上，
  /// 候选随后再拉）——少一路 maps_place_around，标签刷新明显更快。
  Future<RidePickupSuggestion?> around({
    required double lng,
    required double lat,
    bool withCandidates = true,
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/ride/pickup-candidates"),
            headers: _headers,
            body: jsonEncode(<String, Object>{
              "lng": lng,
              "lat": lat,
              "candidates": withCandidates,
            }),
          )
          .timeout(withCandidates ? _timeout : const Duration(seconds: 4));
      if (res.statusCode != 200) return null;
      final Object? decoded = jsonDecode(res.body);
      if (decoded is! Map) return null;
      final Map<String, dynamic> body = decoded.cast<String, dynamic>();
      final List<dynamic> raw =
          body["candidates"] is List ? body["candidates"] as List<dynamic> : const <dynamic>[];
      final List<RidePickupCandidate> candidates = <RidePickupCandidate>[];
      for (final dynamic item in raw) {
        if (item is! Map) continue;
        final RidePickupCandidate? c =
            RidePickupCandidate.fromJson(item.cast<String, dynamic>());
        if (c != null) candidates.add(c);
      }
      return RidePickupSuggestion(
        label: body["label"]?.toString() ?? "",
        candidates: candidates,
      );
    } catch (_) {
      return null;
    }
  }
}
