import "dart:io" show Platform;

import "package:flutter/foundation.dart" show kIsWeb, kReleaseMode;

import "../services/local_runtime_manager.dart";

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
  ///
  /// P0 防线（2026-10-16，桌面发行包复发「行程列表加载失败/拒绝连接」）：
  /// Windows Release 且 exe 旁无捆绑 runtime（非 byok 形态）时，127.0.0.1
  /// 回落是同一种构建期配置错误——用户机器上没人监听 3000，错到运行期才爆。
  /// 与 Android 同规则 fail-fast。Debug 开发联调（手工起服务）与 byok
  /// 捆绑形态（本地 runtime 监听 127.0.0.1:3000）不受影响。
  static bool? _windowsReleaseFallbackBlocked;

  // ── 远程配置下发·运行期覆盖（2026-11-10 地基）────────────────────────
  // 编译期烤入的地址是"上次发版时的快照"；服务端 /api/client/config 可下发
  // 运行期覆盖（换机房/迁域名不重烤包）。由 RemoteConfig.applyCached() 在
  // main() 早期调用（上次启动拉到的，本次生效，语义与 applyRuntimeChannel
  // 一致）；空串 = 不覆盖，保持烤入值。覆盖值优先于一切烤入值——它是运维
  // 最新决定，服务端控制的就是它自己的接入地址。

  static String? _remoteHttpBase;
  static String? _remoteControlPlaneUrl;
  static String? _remoteUpdateManifestUrl;

  /// 应用远程配置覆盖（非空字段生效；全空调用是无害 no-op）。
  /// 幂等：重复调用以最后一次为准。
  static void applyRemoteOverrides({
    String? httpBase,
    String? controlPlaneUrl,
    String? updateManifestUrl,
  }) {
    _remoteHttpBase = _normalizeBase(httpBase);
    _remoteControlPlaneUrl = _normalizeBase(controlPlaneUrl);
    _remoteUpdateManifestUrl = _normalizeBase(updateManifestUrl);
  }

  /// 地址归一：去尾部斜杠，避免拼接出 `//path`。协议必须 http/https，非法值
  /// 丢弃（防御服务端配置手误把整条请求链打挂——覆盖错了比不覆盖更糟）。
  static String? _normalizeBase(String? raw) {
    final String t = (raw ?? "").trim().replaceAll(RegExp(r"/+$"), "");
    final Uri? uri = Uri.tryParse(t);
    if (uri == null ||
        (uri.scheme != "http" && uri.scheme != "https") ||
        uri.host.isEmpty) {
      return null;
    }
    return t;
  }

  /// 运行通道（runtime 收回开关）："byok" = 本机 runtime（默认）；
  /// "platform" = 统一 API 服务。由 main() 在 runApp 前从本地安装身份文件
  /// 同步读入（`applyRuntimeChannel`），值是上一次启动从服务端清单拿到的 channel。
  static String _runtimeChannel = "byok";

  /// 当前生效的运行通道（埋点上报用）。
  static String get runtimeChannel => _runtimeChannel;

  static bool get usesPlatformChannel =>
      _runtimeChannel == "platform" && _controlPlaneFromEnv.isNotEmpty;

  /// 应用启动期读到的 channel；未烤入 CONTROL_PLANE_URL 时忽略 platform
  /// （没有可切去的服务器，保持本机 runtime 是唯一正确行为）。
  static void applyRuntimeChannel(String? channel) {
    final String c = (channel ?? "").trim();
    if (c == "byok") {
      _runtimeChannel = "byok";
      return;
    }
    if (c == "platform" && _controlPlaneFromEnv.isNotEmpty) {
      _runtimeChannel = "platform";
    }
  }

  static String get httpBase {
    // 远程配置覆盖（运维最新决定）优先于一切烤入值；null = 从未下发/下发为空。
    final String? remote = _remoteHttpBase;
    if (remote != null) return remote;
    // runtime 收回（channel=platform）：本机后端不再拉起，请求一律走烤入的控制面。
    if (_runtimeChannel == "platform" && _controlPlaneFromEnv.isNotEmpty) {
      return _controlPlaneFromEnv;
    }
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
    if (!kIsWeb && Platform.isWindows && kReleaseMode) {
      // isBundled 做两次文件存在性探测，memo 一次即可（exe 目录运行期不变）。
      _windowsReleaseFallbackBlocked ??= !LocalRuntimeManager.isBundled;
      if (_windowsReleaseFallbackBlocked!) {
        throw StateError(
          "Windows 发行包未烤入 HTTP_BASE（127.0.0.1 回落已禁用）。"
          "请用 client/flutter_app/build_windows.ps1 -HttpBase http://<后端地址>:3000 打包，"
          "或显式传 --dart-define=HTTP_BASE=...。",
        );
      }
    }
    return "http://127.0.0.1:3000";
  }

  /// 连接/通道标签（设备实例名）。**不是身份**：身份一律取 [effectiveActorId]。
  ///
  /// 历史包袱：它曾同时充当「未登录时的 actor」，于是所有设备撞在同一个
  /// `session-mvp-001` 上；现在只剩两个用途——本地联调区分双实例
  /// （`--dart-define=SESSION_ID=session-b`）与桥接通道命名。任何 WS/HTTP
  /// 载荷里的身份字段都禁止引用本值。
  static const String sessionId = String.fromEnvironment(
    "SESSION_ID",
    defaultValue: "session-mvp-001",
  );

  static const String _updateManifestUrlFromEnv =
      String.fromEnvironment("UPDATE_MANIFEST_URL");

  /// 版本清单（更新检查）地址。byok 捆绑形态下 [httpBase] 指向本地 runtime
  /// （127.0.0.1），而版本控制面在云端 ECS——发版构建必须烤入：
  /// `--dart-define=UPDATE_MANIFEST_URL=https://login.nextbot.top`（走域名 +
  /// https：80 已 301 到 https，烤 http 每次检查多付一次重定向 + 二次 TLS，
  /// 弱网下「已是最新版本」弹卡延迟数秒；勿烤裸 IP：控制面页面会直接进用户
  /// 浏览器地址栏）。
  /// 未配置时回落 [httpBase]（单机部署/开发联调形态，两者同源）。
  static String get updateManifestUrl {
    if (_remoteUpdateManifestUrl != null) return _remoteUpdateManifestUrl!;
    if (_updateManifestUrlFromEnv.isNotEmpty) return _updateManifestUrlFromEnv;
    return httpBase;
  }

  static const String _controlPlaneFromEnv = String.fromEnvironment(
    "CONTROL_PLANE_URL",
  );

  /// 控制面（管理后台所在服务器）：反馈、站内信、网页登录页（/accounts/web）
  /// 等走这里。捆绑形态下若仍指向本地 runtime，用户反馈只会落进本机数据库，
  /// 管理后台永远看不到——发版构建必须烤入：
  /// `--dart-define=CONTROL_PLANE_URL=https://login.nextbot.top`（登录页 URL
  /// 用户可见，必须用域名而非裸 IP；必须 https，80 已 301 跨协议重定向不可靠）。
  /// 未配置时回落 [httpBase]（单机部署/开发联调形态，两者同源，行为不变）。
  static String get controlPlaneBase {
    if (_remoteControlPlaneUrl != null) return _remoteControlPlaneUrl!;
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

  /// 未登录时的设备匿名身份提供者（boot 早期由 InstallIdentity 注入，两端都装）。
  ///
  /// 主流做法里「未登录」是一种真实的身份状态，不是「用某个默认账号顶着」。
  /// 注入后 [effectiveActorId] 会回落到本机安装标识（`inst_…`）：
  ///  - 多台未登录设备不会挤在同一个 `session-mvp-001` 上串记忆/世界/配额；
  ///  - 服务端审计里能直接看出「这台设备还没登录」，而不是一个假账号。
  static String? Function()? installIdentityProvider;

  /// 安装标识连读盘都失败时的最后身份：明确标成 guest。
  ///
  /// 保留它只是为了「永远返回一个非空值」——**不再**回落到编译期 [sessionId]
  /// （`session-mvp-001`）：那是所有设备共享的假账号，正是身份对不上的源头。
  static const String guestFallbackActorId = "guest_local";

  /// 生效身份（**全链路唯一权威值**）。
  ///
  /// 顺序：登录身份覆盖（含 token 归属）→ 编译期 `USER_ID` → 本机安装标识 →
  /// [guestFallbackActorId]。`session.init`、每条业务事件的 `userId/sessionId`、
  /// HTTP `?userId=`、本地存储桶、钱包**都必须**取本值。
  ///
  /// 反例（2026-11-11 真机故障）：`session.init` 用一份算法、消息用另一份算法，
  /// 两边算出来不一致 → 服务端判 `FORBIDDEN` → 界面永远停在「我看看」。
  static String get effectiveActorId {
    final String o = _runtimeUserIdOverride ?? "";
    if (o.isNotEmpty) return o;
    final String u = userId.trim();
    if (u.isNotEmpty) return u;
    final String anon = installIdentityProvider?.call()?.trim() ?? "";
    if (anon.isNotEmpty) return anon;
    return guestFallbackActorId;
  }

  /// `GET /accounts/me` 等查询参数：有登录身份（覆盖或 USER_ID）时只传
  /// `userId`，未登录传本机匿名身份（与 [effectiveActorId] 同值）。
  static Map<String, String> get accountAuthQuery {
    return <String, String>{"userId": effectiveActorId};
  }

  /// `POST /accounts/register` 请求体（与 [accountAuthQuery] 规则一致）。
  ///
  /// 未登录时的机器身份必须是本机安装标识（`effectiveActorId` = `inst_…`），
  /// **不能**再用连接标签 `sessionId`——那是全设备共享的占位值，会把所有
  /// 未登录设备注册成同一个 `session-mvp-001` 账号（2026-11-11 审计：
  /// 同一文件里 query 已用 `inst_…`、body 还发占位值，两套算法互相打架）。
  static Map<String, String> accountRegisterBody(String displayName) {
    final String name = displayName.trim();
    final String u = _runtimeUserIdOverride ?? userId.trim();
    final Map<String, String> m = <String, String>{"displayName": name};
    m["userId"] = u.isNotEmpty ? u : effectiveActorId;
    return m;
  }

  /// `POST /accounts/register/email/verify` 请求体（6 位数字码 + 与 [accountAuthQuery] 一致的登录主体）。
  static Map<String, String> accountEmailVerifyBody(String code) {
    final String u = _runtimeUserIdOverride ?? userId.trim();
    final Map<String, String> m = <String, String>{"code": code.trim()};
    m["userId"] = u.isNotEmpty ? u : effectiveActorId;
    return m;
  }

  static const String _wsUrlFromEnv = String.fromEnvironment("WS_URL");

  /// WebSocket 地址；未配置时由 [httpBase] 推导。
  /// https 源默认 443（wss 走 nginx 反代），http 源维持 3000（云端裸端口直连
  /// 与本地 runtime 同语义）；带显式端口的 httpBase 原样保留。
  static String get wsUrl {
    if (_wsUrlFromEnv.isNotEmpty) {
      return _wsUrlFromEnv;
    }
    final Uri api = Uri.parse(httpBase);
    final String wsScheme = api.scheme == "https" ? "wss" : "ws";
    final bool hasExplicitPort = api.hasPort;
    final int port = hasExplicitPort ? api.port : (api.scheme == "https" ? 443 : 3000);
    // https 无显式端口 → 省略（443 隐含）；http 无显式端口保持旧行为显式 :3000。
    final String portPart = !hasExplicitPort && api.scheme == "https" ? "" : ":$port";
    return "$wsScheme://${api.host}$portPart/ws";
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
