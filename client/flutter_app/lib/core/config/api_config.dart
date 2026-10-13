import "dart:io" show Platform;

import "package:flutter/foundation.dart" show kIsWeb;

/// 与 WebSocket 网关同机时使用；Android 模拟器可 `--dart-define=HTTP_BASE=http://10.0.2.2:3000`。
/// 双实例联调时可 `--dart-define=SESSION_ID=session-b`；WebSocket 地址可 `--dart-define=WS_URL=ws://10.0.2.2:3000/ws`。
/// 与后端 UAP/世界/记忆对齐的稳定用户 id：`--dart-define=USER_ID=your-login-id`（可选；未设置时 [effectiveActorId] 与 [sessionId] 相同）。
class ApiConfig {
  ApiConfig._();

  static const String _httpBaseFromEnv = String.fromEnvironment("HTTP_BASE");

  /// 主服务 HTTP 根地址。
  ///
  /// P0 防线（2026-10-12，裸 `flutter build apk --release` 复发「网络错误」）：
  /// Android 上 127.0.0.1 指手机自己，烤入失败时绝不能静默回落——那只会把
  /// 构建期配置错误拖到运行期，变成登录页一句笼统的「网络错误」。直接
  /// fail-fast，错误信息指明正确打包路径（build_apk.ps1）。
  static String get httpBase {
    if (_httpBaseFromEnv.isNotEmpty) {
      return _httpBaseFromEnv;
    }
    if (!kIsWeb && Platform.isAndroid) {
      throw StateError(
        "APK 未烤入 HTTP_BASE（127.0.0.1 回落已禁用）。"
        "请用 client/flutter_app/build_apk.ps1 打包，"
        "或显式传 --dart-define=HTTP_BASE=http://<后端地址>:3000。",
      );
    }
    return "http://127.0.0.1:3000";
  }

  /// 连接级会话 id（设备/实例）；`session.init` 会原样上报，与 [userId] 并存时后端以 [userId] 为 actor。
  static const String sessionId = String.fromEnvironment(
    "SESSION_ID",
    defaultValue: "session-mvp-001",
  );

  static const String _updateManifestUrlFromEnv =
      String.fromEnvironment("UPDATE_MANIFEST_URL");

  /// 版本清单（更新检查）地址。byok 捆绑形态下 [httpBase] 指向本地 runtime
  /// （127.0.0.1），而版本控制面在云端 ECS——发版构建必须烤入：
  /// `--dart-define=UPDATE_MANIFEST_URL=http://login.nextbot.top`（走域名，
  /// 勿烤裸 IP：控制面页面会直接进用户浏览器地址栏）。
  /// 未配置时回落 [httpBase]（单机部署/开发联调形态，两者同源）。
  static String get updateManifestUrl {
    if (_updateManifestUrlFromEnv.isNotEmpty) return _updateManifestUrlFromEnv;
    return httpBase;
  }

  static const String _controlPlaneFromEnv = String.fromEnvironment(
    "CONTROL_PLANE_URL",
  );

  /// 控制面（管理后台所在服务器）：反馈、站内信、网页登录页（/accounts/web）
  /// 等走这里。捆绑形态下若仍指向本地 runtime，用户反馈只会落进本机数据库，
  /// 管理后台永远看不到——发版构建必须烤入：
  /// `--dart-define=CONTROL_PLANE_URL=http://login.nextbot.top`（登录页 URL
  /// 用户可见，必须用域名而非裸 IP）。
  /// 未配置时回落 [httpBase]（单机部署/开发联调形态，两者同源，行为不变）。
  static String get controlPlaneBase {
    final String c = _controlPlaneFromEnv.trim();
    return c.isNotEmpty ? c : httpBase;
  }

  /// 稳定用户 id（登录账号等）；非空时后端 `boundActorId`、世界/记忆/配额均优先用此值。
  static const String userId = String.fromEnvironment(
    "USER_ID",
    defaultValue: "",
  );

  /// 运行时身份覆盖：登录成功后写入登录邮箱（已归一化），退出登录置回 null。
  ///
  /// 编译期 [userId] 是烤死在安装包里的，所有装同一包的用户会撞成同一个
  /// 身份；邮箱登录才是真正的按账号隔离——覆盖值优先于 [userId]，未登录
  /// 时为 null，回落原行为（USER_ID → sessionId）。
  static String? _runtimeUserIdOverride;

  /// 当前登录身份覆盖（已归一化）；null = 未登录。
  static String? get runtimeUserId => _runtimeUserIdOverride;

  static set runtimeUserId(String? value) {
    final String t = normalizeIdentity(value);
    _runtimeUserIdOverride = t.isEmpty ? null : t;
  }

  /// 身份归一化：trim；邮箱形态统一小写——同一邮箱大小写不同不得裂成两个
  /// 账号（服务端 /accounts 路由对邮箱形态 actorId 同规则归一）。
  static String normalizeIdentity(String? raw) {
    final String t = raw?.trim() ?? "";
    if (t.isEmpty) return "";
    return t.contains("@") ? t.toLowerCase() : t;
  }

  /// 生效登录主体：登录邮箱覆盖 → 编译期 USER_ID → [sessionId]。
  /// 与后端 `boundActorId` 一致。HTTP `?sessionId=`、本地存储桶、钱包等应使用本值。
  static String get effectiveActorId {
    final String o = _runtimeUserIdOverride ?? "";
    if (o.isNotEmpty) return o;
    final String u = userId.trim();
    return u.isNotEmpty ? u : sessionId;
  }

  /// `GET /accounts/me` 等查询参数：有登录身份（覆盖或 USER_ID）时只传
  /// `userId`，否则传 `sessionId`。
  static Map<String, String> get accountAuthQuery {
    final String u = _runtimeUserIdOverride ?? userId.trim();
    if (u.isNotEmpty) {
      return <String, String>{"userId": u};
    }
    return <String, String>{"sessionId": sessionId};
  }

  /// `POST /accounts/register` 请求体（与 [accountAuthQuery] 规则一致）。
  static Map<String, String> accountRegisterBody(String displayName) {
    final String name = displayName.trim();
    final String u = _runtimeUserIdOverride ?? userId.trim();
    final Map<String, String> m = <String, String>{"displayName": name};
    if (u.isNotEmpty) {
      m["userId"] = u;
    } else {
      m["sessionId"] = sessionId;
    }
    return m;
  }

  /// `POST /accounts/register/email/verify` 请求体（6 位数字码 + 与 [accountAuthQuery] 一致的登录主体）。
  static Map<String, String> accountEmailVerifyBody(String code) {
    final String u = _runtimeUserIdOverride ?? userId.trim();
    final Map<String, String> m = <String, String>{"code": code.trim()};
    if (u.isNotEmpty) {
      m["userId"] = u;
    } else {
      m["sessionId"] = sessionId;
    }
    return m;
  }

  static const String _wsUrlFromEnv = String.fromEnvironment("WS_URL");

  /// WebSocket 地址；未配置时由 [httpBase] 推导。
  static String get wsUrl {
    if (_wsUrlFromEnv.isNotEmpty) {
      return _wsUrlFromEnv;
    }
    final Uri api = Uri.parse(httpBase);
    final String wsScheme = api.scheme == "https" ? "wss" : "ws";
    final int port = api.hasPort ? api.port : 3000;
    return "$wsScheme://${api.host}:$port/ws";
  }

  /// 首次安装时的默认本地加密 PIN（可用 `--dart-define=LOCAL_PIN=` 覆盖）。
  static const String localPin = String.fromEnvironment(
    "LOCAL_PIN",
    defaultValue: "123456",
  );

  /// 发行版本（与服务端 NEXTBOT_EDITION 同名值，打包脚本 -Edition 对齐）：
  /// internal —— 内测版（默认）：能力全量（旅游/虚拟电话/好友/比价/手机桥接等）；
  /// oss      —— 开源版（GitHub 发行）：内测独占能力整族剔除，服务端闸
  ///             capability-modules/internalOnly + 家族注册块 + HTTP 路由，
  ///             客户端守卫 = travel_itinerary/product_compare 卡、电话 WS 事件、
  ///             好友面板、设置页手机桥接。
  /// 打包：`--dart-define=PAI_EDITION=oss`；开发/内测构建不传即 internal。
  static const String edition = String.fromEnvironment(
    "PAI_EDITION",
    defaultValue: "internal",
  );

  /// 是否开源版（内测独占能力应隐藏）。
  static const bool isOssEdition = edition == "oss";

  static const String _defaultSocialFeedUrl = "http://127.0.0.1:3001";

  /// @deprecated 社交推文站（social-platform）已移除，此配置保留仅为兼容旧 dart-define，不再使用。
  static const String socialFeedUrl = String.fromEnvironment(
    "SOCIAL_FEED_URL",
    defaultValue: _defaultSocialFeedUrl,
  );

  /// @deprecated 使用 [socialFeedUrl]；保留别名兼容旧 dart-define。
  static const String agentLinkUrl = String.fromEnvironment(
    "AGENT_LINK_URL",
    defaultValue: _defaultSocialFeedUrl,
  );
}
