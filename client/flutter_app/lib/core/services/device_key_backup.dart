import "dart:io" show Platform;

import "package:flutter/foundation.dart" show debugPrint, kIsWeb, visibleForTesting;
import "package:flutter/services.dart" show MethodChannel;

/// Android 侧「跨卸载」保活通道（原生实现见 DeviceKeyBackupPlugin.kt）。
///
/// 提供两件事：
///  - [stableInstallId]：由 ANDROID_ID 派生的稳定 `inst_…`，同签名卸载重装不变，
///    让服务端 `model-keys/<actor>.enc` 里的加密绑定在重装后仍被同一个 actor 命中；
///  - 公共目录加密备份：三元组经 AES-256-GCM 加密写到 Downloads/NEXTBOT/，
///    卸载不会清理这个位置，重装启动可自动读回。明文永不写公共目录。
///
/// 非 Android（桌面 / Web / iOS）一律返回 null / false，调用方回落原有私有文件逻辑；
/// 通道异常也不抛，保活失败不能阻断正常聊天或配置保存。
class DeviceKeyBackup {
  DeviceKeyBackup._();

  static final DeviceKeyBackup instance = DeviceKeyBackup._();

  static const String channelName = "com.nextbot.app/device_key_backup";
  static const MethodChannel _channel = MethodChannel(channelName);

  /// 单测跑在宿主机器上，`Platform.isAndroid` 恒为 false；仅测试里置 true。
  @visibleForTesting
  static bool debugForceAvailable = false;

  static bool get _available => debugForceAvailable || (!kIsWeb && Platform.isAndroid);

  Future<String?> stableInstallId() async {
    if (!_available) return null;
    try {
      return await _channel.invokeMethod<String>("stableInstallId");
    } catch (e) {
      debugPrint("[DeviceKeyBackup] 稳定设备标识不可用（回落随机安装 id）: $e");
      return null;
    }
  }

  /// 读回最近一份可用备份的明文 JSON；无备份/解不开/被 revoked 时由调用方判空。
  Future<String?> readBackup() async {
    if (!_available) return null;
    try {
      return await _channel.invokeMethod<String>("readBackup");
    } catch (e) {
      debugPrint("[DeviceKeyBackup] 读取跨卸载备份失败: $e");
      return null;
    }
  }

  /// 写一份备份。清空配置时也走这里，但内容是 `{"revoked":true}`：
  /// Android 11+ 不允许静默删除「非本应用创建」的公共文件，用覆盖记录表达撤销。
  Future<bool> writeBackup(String json) async {
    if (!_available) return false;
    try {
      return await _channel.invokeMethod<bool>(
            "writeBackup",
            <String, dynamic>{"json": json},
          ) ==
          true;
    } catch (e) {
      debugPrint("[DeviceKeyBackup] 写跨卸载备份失败: $e");
      return false;
    }
  }

  /// 尽力删除公共备份（可能因系统权限失败；清空语义以 revoked 记录为准）。
  Future<bool> deleteBackup() async {
    if (!_available) return false;
    try {
      return await _channel.invokeMethod<bool>("deleteBackup") == true;
    } catch (e) {
      debugPrint("[DeviceKeyBackup] 删除跨卸载备份失败: $e");
      return false;
    }
  }
}
