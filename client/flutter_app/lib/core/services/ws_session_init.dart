import "dart:io" show Platform;

import "package:flutter/foundation.dart";

import "../config/api_config.dart";
import "access_auth_api.dart";
import "client_clock_service.dart";
import "cloud_model_binding_store.dart";
import "install_identity.dart";
import "local_runtime_manager.dart";
import "media_playback_service.dart";

/// 设备类别自报：手机系 → mobile，桌面/网页 → desktop。
/// 与服务端 `normalizeDeviceClass` 同一套规则（缺省按 desktop 归一）。
String wsDevicePlatform() {
  if (kIsWeb) return "desktop";
  if (Platform.isAndroid || Platform.isIOS) return "mobile";
  return "desktop";
}

/// 连接握手后的唯一 `session.init` 载荷。
///
/// 由连接层在每次（重）连成功后统一发一次，字段取两端（根状态 / 手机聊天
/// 控制器）并集，语义不丢。载荷归属单文件，避免连接语义散落两处。
///
/// **身份字段只有一个**：`userId = ApiConfig.effectiveActorId`——与每条业务
/// 事件里的 `userId/sessionId`、HTTP `?userId=` 完全同源。曾经这里报
/// `sessionId: session-mvp-001`、消息报登录邮箱，两套算法算出的身份不一致，
/// 服务端只能判 `FORBIDDEN`，界面就永远停在「我看看」（2026-11-11 事故）。
Map<String, dynamic> buildWsSessionInit({bool announceModelUnbind = false}) {
  final String deviceId =
      InstallIdentity.instance.cachedInstallId ?? "local-device";
  final String? token = AccessCredentialStore.instance.token;
  // 全链路唯一权威值：已登录=账号邮箱（token 归属）、未登录=本机安装标识
  // （`inst_…`）、连安装标识都没有=guest 占位。三者都不是账号冒充。
  final String actorId = ApiConfig.effectiveActorId;
  final Map<String, dynamic> init = <String, dynamic>{
    // 身份：与业务事件同源（见上方注释），服务端有 token 时仍以 token 为准。
    "userId": actorId,
    "deviceId": deviceId,
    "userAlias": "owner",
    // 共用浏览器桥只存在于桌面端：手机端若仍自报 true，服务端会按"有浏览器
    // 执行器"的链路处理比价/下单，实际没有执行器可用。
    "browserBridge": !kIsWeb && !Platform.isAndroid && !Platform.isIOS,
    "platform": wsDevicePlatform(),
    // 媒体播放能力声明：分发区已接线 MediaPlaybackService，声明即真实可消费。
    "capabilities": <String, dynamic>{"mediaPlayback": kMediaPlaybackCapability},
    // 设备时钟快照（时区与定位解耦）：连接即落库，首条消息前服务端就有正确时区。
    "clientClock": ClientClockService.snapshotSync(),
  };

  if (token != null) init["token"] = token;

  // 云端连接版 BYOK：绑定形态的模型 key 只进本地 runtime，绝不随连接上送；
  // 明文 ws 同样不送（服务端也拒绝非 TLS 上送）。
  //
  // 服务端语义（connection.ts）：字段缺失 = 保留已有绑定；存在但字段不全
  // （含空对象）= 撤绑。因此「停用自有模型」必须显式发一个空对象——只删
  // 本机文件再补发一帧普通 init，服务端会把云端绑定保留下来，重装后幽灵
  // 复活（2026-11-12 修复）。
  final CloudModelBindingStore binding = CloudModelBindingStore.instance;
  final Map<String, dynamic>? modelProvider = buildModelProviderPayload(
    overTls: !kIsWeb && ApiConfig.wsUrl.startsWith("wss://"),
    bundledRuntime: LocalRuntimeManager.isBundled,
    configured: binding.isConfigured,
    baseUrl: binding.baseUrl,
    apiKey: binding.apiKey,
    model: binding.model,
    announceUnbind: announceModelUnbind,
  );
  if (modelProvider != null) init["modelProvider"] = modelProvider;
  return init;
}

/// session.init 的 `modelProvider` 字段口径（纯函数，单测直接打这个）：
///
/// | 场景 | 返回 |
/// |---|---|
/// | 明文 ws / 捆绑 runtime | null（不下发：服务端拒绝非 TLS 上送，捆绑形态 key 不出本机） |
/// | 已配置绑定 | 完整三元组 |
/// | 停用绑定（announceUnbind） | 空对象 → 服务端撤绑 |
/// | 未配置且未声明撤绑 | null（缺字段 = 保留服务端已有绑定） |
///
/// 拆成纯函数的理由：真实 `init` 只在 wss 下才带这个字段，测试环境跑明文 ws
/// 永远看不到它，语义就只能靠读代码保证（原来那条单测正是因此长期红着）。
@visibleForTesting
Map<String, dynamic>? buildModelProviderPayload({
  required bool overTls,
  required bool bundledRuntime,
  required bool configured,
  String? baseUrl,
  String? apiKey,
  String? model,
  required bool announceUnbind,
}) {
  if (!overTls || bundledRuntime) return null;
  if (configured) {
    return <String, dynamic>{
      "baseUrl": baseUrl ?? "",
      "apiKey": apiKey ?? "",
      "model": model ?? "",
    };
  }
  return announceUnbind ? <String, dynamic>{} : null;
}
