import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// Agent 世界 HTTP API（与 [ApiConfig.httpBase] 搭配使用）。
class WorldApiClient {
  WorldApiClient({required this.baseUrl});

  final String baseUrl;

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Future<Map<String, dynamic>> getState(String sessionId) async {
    final http.Response r = await http.get(_uri("/world/state", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getShop(String sessionId) async {
    final http.Response r = await http.get(_uri("/world/shop", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 观战端：拉取商店目录（不改变 Agent 当前场景；对应 `GET /world/shop/catalog`）。
  Future<Map<String, dynamic>> getShopCatalog(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/world/shop/catalog", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 自由市场总览（切换场景为 `free_market`，含技能与 A2A 分支元数据）。
  Future<Map<String, dynamic>> getFreeMarket(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/world/market", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 自由市场 — 技能分支目录（不改变场景）。
  Future<Map<String, dynamic>> getFreeMarketSkillsCatalog(String sessionId) async {
    final http.Response r = await http
        .get(_uri("/world/market/skills/catalog", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// A2A 外包单列表；[filter]：`open`（挂单大厅）或 `mine`（与我相关）。
  Future<Map<String, dynamic>> getFreeMarketContracts(
    String sessionId, {
    String filter = "open",
  }) async {
    final http.Response r = await http.get(
      _uri("/world/market/contracts", <String, String>{
        "sessionId": sessionId,
        "filter": filter,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> purchase(String sessionId, String skillId) async {
    final http.Response r = await http.post(
      _uri("/world/shop/purchase"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId, "skillId": skillId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> leisure(String sessionId, {String actionId = "stroll"}) async {
    final http.Response r = await http.post(
      _uri("/world/leisure"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId, "actionId": actionId}),
    );
    return _decode(r);
  }

  /// Agent 互动动态时间线（`GET /world/social/feed`）；带 sessionId 时自家 Agent 帖子优先排序。
  Future<Map<String, dynamic>> socialFeed(String sessionId, {int? limit}) async {
    final Map<String, String> q = <String, String>{"sessionId": sessionId};
    if (limit != null) q["limit"] = limit.toString();
    final http.Response r = await http.get(_uri("/world/social/feed", q));
    return _decode(r);
  }

  /// 上传媒体（Base64 JSON），返回 `mediaUrl`（`/world/social/media/...`）。
  Future<Map<String, dynamic>> socialUploadMedia({
    required String sessionId,
    required String mimeType,
    required String dataBase64,
  }) async {
    final http.Response r = await http.post(
      _uri("/world/social/media"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{
        "sessionId": sessionId,
        "mimeType": mimeType,
        "dataBase64": dataBase64,
      }),
    );
    return _decode(r);
  }

  /// `multipart/form-data`：字段 `sessionId` + 文件字段 `file`（优先于 Base64，体积更省）。
  Future<Map<String, dynamic>> socialUploadMediaForm({
    required String sessionId,
    required List<int> fileBytes,
    required String fileName,
  }) async {
    final Uri uri = _uri("/world/social/media/form");
    final http.MultipartRequest req = http.MultipartRequest("POST", uri);
    req.fields["sessionId"] = sessionId;
    req.files.add(http.MultipartFile.fromBytes("file", fileBytes, filename: fileName));
    final http.StreamedResponse streamed = await req.send();
    final http.Response r = await http.Response.fromStream(streamed);
    return _decode(r);
  }

  /// 上传语音消息录音文件（mp3 字节）到服务端 `POST /agent/voice/messages/upload`。
  ///
  /// 与 `socialUploadMediaForm` 区别：
  ///   - socialUploadMediaForm 走 `/world/social/media/form`，存到社交动态目录。
  ///   - uploadVoiceMessage 走 `/agent/voice/messages/upload`，存到独立语音消息目录。
  ///
  /// 返回 `{ ok, mediaUrl, msgId, durationMs }`。
  Future<Map<String, dynamic>> uploadVoiceMessage({
    required String sessionId,
    required List<int> fileBytes,
    required String fileName,
    int? durationMs,
  }) async {
    final Uri uri = _uri("/agent/voice/messages/upload");
    final http.MultipartRequest req = http.MultipartRequest("POST", uri);
    req.fields["sessionId"] = sessionId;
    if (durationMs != null) {
      req.fields["durationMs"] = durationMs.toString();
    }
    req.files.add(http.MultipartFile.fromBytes("file", fileBytes, filename: fileName));
    final http.StreamedResponse streamed = await req.send();
    final http.Response r = await http.Response.fromStream(streamed);
    return _decode(r);
  }

  /// ASR 专用端点：上传音频后立即拿到转写文本（不走 chat pipeline）。
  /// 字段：
  ///   - sessionId / fileBytes / fileName（必填）
  ///   - language（可选，默认 "zh"）
  /// 返回 `{ ok, text, language, audioBytes }` 或 `{ ok: false, error }`。
  Future<Map<String, dynamic>> transcribeVoiceMessage({
    required String sessionId,
    required List<int> fileBytes,
    required String fileName,
    String language = "zh",
  }) async {
    final Uri uri = _uri("/agent/voice/transcribe");
    final http.MultipartRequest req = http.MultipartRequest("POST", uri);
    req.fields["sessionId"] = sessionId;
    req.fields["language"] = language;
    req.files.add(http.MultipartFile.fromBytes("file", fileBytes, filename: fileName));
    final http.StreamedResponse streamed = await req.send();
    final http.Response r = await http.Response.fromStream(streamed);
    return _decode(r);
  }

  Future<Map<String, dynamic>> socialDeletePost(String sessionId, String postId) async {
    final http.Response r = await http.delete(
      _uri("/world/social/post/$postId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> socialReport(String sessionId, String postId, {String? reason}) async {
    final Map<String, dynamic> body = <String, dynamic>{"sessionId": sessionId, "postId": postId};
    if (reason != null && reason.trim().isNotEmpty) {
      body["reason"] = reason.trim();
    }
    final http.Response r = await http.post(
      _uri("/world/social/report"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// Agent 中继入站列表（与 WebSocket 推送同源，便于离线补拉）。
  Future<Map<String, dynamic>> getAgentInbox(String sessionId, {int? limit}) async {
    final Map<String, String> q = <String, String>{"sessionId": sessionId};
    if (limit != null) q["limit"] = limit.toString();
    final http.Response r = await http.get(_uri("/agent/inbox", q));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getAgentRelayConfig() async {
    final http.Response r = await http.get(_uri("/agent/relay/config"));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getAgentPairStatus(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/agent/pair/status", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  Future<Map<String, dynamic>> agentPair(String sessionId, String code) async {
    final http.Response r = await http.post(
      _uri("/agent/pair"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId, "code": code}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> agentUnpair(String sessionId) async {
    final http.Response r = await http.post(
      _uri("/agent/unpair"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 未注册时服务端返回 404，此处转为 `registered: false` 而不抛错。
  /// 使用 [ApiConfig.accountAuthQuery]（`USER_ID` 优先于 `SESSION_ID`）。
  Future<Map<String, dynamic>> getAccountMe() async {
    final http.Response r = await http.get(
      _uri("/accounts/me", ApiConfig.accountAuthQuery),
    );
    if (r.statusCode == 404) {
      return <String, dynamic>{"ok": false, "registered": false};
    }
    return _decode(r);
  }

  Future<Map<String, dynamic>> registerAccount(String displayName) async {
    final http.Response r = await http.post(
      _uri("/accounts/register"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountRegisterBody(displayName)),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 1：分配占位邮箱（请求体与 [registerAccount] 相同字段）。
  Future<Map<String, dynamic>> startEmailRegistration(String displayName) async {
    final http.Response r = await http.post(
      _uri("/accounts/register/email/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountRegisterBody(displayName)),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 2：拉取待验证信息（含服务端验证码与网关解析的 inboundCodes）。
  Future<Map<String, dynamic>> getEmailRegistrationPending() async {
    final http.Response r = await http.get(
      _uri("/accounts/register/email/pending", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 3：提交 6 位验证码并创建账号。
  Future<Map<String, dynamic>> verifyEmailRegistration(String code) async {
    final http.Response r = await http.post(
      _uri("/accounts/register/email/verify"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountEmailVerifyBody(code)),
    );
    return _decode(r);
  }

  /// 当前 Actor 可见的 Skill 清单（含已禁用）；查询参数与 [ApiConfig.accountAuthQuery] 一致。
  Future<Map<String, dynamic>> getChatSkillsLibrary() async {
    final http.Response r = await http.get(
      _uri("/chat/skills", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 启用或禁用某 Skill（内置与已拥有的社区技能）；请求体附带 Actor 字段。
  Future<Map<String, dynamic>> patchChatSkillEnabled(String skillName, bool enabled) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "skillName": skillName,
      "enabled": enabled,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.patch(
      _uri("/chat/skills/enabled"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  // ==================== 好友系统 API ====================

  /// 发送好友请求
  Future<Map<String, dynamic>> sendFriendRequest(String toActorId, {String? message}) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "toActorId": toActorId,
      if (message != null && message.isNotEmpty) "message": message,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 响应好友请求（接受/拒绝）
  Future<Map<String, dynamic>> respondToFriendRequest(String requestId, bool accept) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "requestId": requestId,
      "accept": accept,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request/respond"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 取消好友请求
  Future<Map<String, dynamic>> cancelFriendRequest(String requestId) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "requestId": requestId,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request/cancel"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 获取 incoming 好友请求（别人发给我的）
  Future<Map<String, dynamic>> getIncomingFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/incoming", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取 outgoing 好友请求（我发给别人的）
  Future<Map<String, dynamic>> getOutgoingFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/outgoing", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取所有好友请求历史
  Future<Map<String, dynamic>> getAllFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/all", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取好友列表
  Future<Map<String, dynamic>> getFriendsList() async {
    final http.Response r = await http.get(
      _uri("/friends/list", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 好友消息历史（双向，时间正序；hub platform=friend 会话）
  /// [sinceSeq] 增量游标：传上次收到的最大 seq 只拉新增部分（断线补拉用）
  Future<Map<String, dynamic>> getFriendMessages(String targetActorId, {int? limit, int? sinceSeq}) async {
    final Map<String, String> query = Map<String, String>.from(ApiConfig.accountAuthQuery);
    query["targetActorId"] = targetActorId;
    if (limit != null) query["limit"] = limit.toString();
    if (sinceSeq != null) query["sinceSeq"] = sinceSeq.toString();
    final http.Response r = await http.get(_uri("/friends/messages", query));
    return _decode(r);
  }

  /// 好友消息直连发送（好友聊天面板；与 world.link.send_message 同一投递内核）
  Future<Map<String, dynamic>> sendFriendMessage(String toActorId, String text) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "toActorId": toActorId,
      "text": text,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/messages"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 好友会话标读（清 hub 未读，重连补投随之停止）
  Future<Map<String, dynamic>> markFriendMessagesRead(String targetActorId) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "targetActorId": targetActorId,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/messages/read"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> getMessageConversations({
    String? platform,
    int? limit,
  }) async {
    final Map<String, String> query = Map<String, String>.from(ApiConfig.accountAuthQuery);
    if (platform != null && platform.trim().isNotEmpty) {
      query["platform"] = platform.trim();
    }
    if (limit != null) {
      query["limit"] = limit.toString();
    }
    final http.Response r = await http.get(
      _uri("/messages/conversations", query),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> getConversationDetail(
    String conversationId, {
    int? limit,
  }) async {
    final Map<String, String> query = Map<String, String>.from(ApiConfig.accountAuthQuery);
    if (limit != null) {
      query["limit"] = limit.toString();
    }
    final http.Response r = await http.get(
      _uri("/messages/conversations/$conversationId", query),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> markConversationRead(String conversationId) async {
    final Map<String, dynamic> body = <String, dynamic>{};
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/messages/conversations/$conversationId/read"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> sendConversationMessage(
    String conversationId,
    String text, {
    String? replyToMessageId,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{"text": text};
    if (replyToMessageId != null && replyToMessageId.trim().isNotEmpty) {
      body["replyToMessageId"] = replyToMessageId.trim();
    }
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/messages/conversations/$conversationId/send"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> suggestConversationReply(
    String conversationId, {
    String? style,
    int? limit,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{};
    if (style != null && style.trim().isNotEmpty) {
      body["style"] = style.trim();
    }
    if (limit != null) {
      body["limit"] = limit;
    }
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/messages/conversations/$conversationId/suggest-reply"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 检查好友关系
  Future<Map<String, dynamic>> checkFriendship(String targetActorId) async {
    final Map<String, String> query = Map<String, String>.from(ApiConfig.accountAuthQuery);
    query["targetActorId"] = targetActorId;
    final http.Response r = await http.get(
      _uri("/friends/check", query),
    );
    return _decode(r);
  }

  // ==================== 音乐房间 API ====================

  /// 创建音乐房间（`POST /world/music/rooms`）。
  Future<Map<String, dynamic>> createMusicRoom(String sessionId) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 加入指定音乐房间（`POST /world/music/rooms/:roomId/join`）。
  Future<Map<String, dynamic>> joinMusicRoom(String roomId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/join"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 离开音乐房间（`POST /world/music/rooms/:roomId/leave`）。
  Future<Map<String, dynamic>> leaveMusicRoom(String roomId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/leave"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 播放（可选指定 [trackId]）（`POST /world/music/rooms/:roomId/play`）。
  Future<Map<String, dynamic>> musicPlay(String roomId, String sessionId, [String? trackId]) async {
    final Map<String, dynamic> body = <String, dynamic>{"sessionId": sessionId};
    if (trackId != null && trackId.isNotEmpty) body["trackId"] = trackId;
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/play"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 暂停（`POST /world/music/rooms/:roomId/pause`）。
  Future<Map<String, dynamic>> musicPause(String roomId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/pause"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 下一首（`POST /world/music/rooms/:roomId/next`）。
  Future<Map<String, dynamic>> musicNext(String roomId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/next"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 跳转进度（`POST /world/music/rooms/:roomId/seek`）。
  Future<Map<String, dynamic>> musicSeek(String roomId, String sessionId, double positionSec) async {
    final http.Response r = await http.post(
      _uri("/world/music/rooms/$roomId/seek"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "sessionId": sessionId,
        "positionSec": positionSec,
      }),
    );
    return _decode(r);
  }

  /// 获取房间当前状态（`GET /world/music/rooms/:roomId`）。
  Future<Map<String, dynamic>> getMusicState(String roomId, String sessionId) async {
    final http.Response r = await http.get(
      _uri("/world/music/rooms/$roomId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Map<String, dynamic> _decode(http.Response r) {
    final Object? data = jsonDecode(utf8.decode(r.bodyBytes));
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return data.cast<String, dynamic>();
    throw FormatException("Invalid JSON: ${r.body}");
  }
}
