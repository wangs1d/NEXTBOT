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
Map<String, dynamic> buildWsSessionInit() {
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
  if (!kIsWeb &&
      !LocalRuntimeManager.isBundled &&
      ApiConfig.wsUrl.startsWith("wss://")) {
    final CloudModelBindingStore binding = CloudModelBindingStore.instance;
    if (binding.isConfigured) {
      init["modelProvider"] = <String, dynamic>{
        "baseUrl": binding.baseUrl,
        "apiKey": binding.apiKey,
        "model": binding.model,
      };
    }
  }
  return init;
}
