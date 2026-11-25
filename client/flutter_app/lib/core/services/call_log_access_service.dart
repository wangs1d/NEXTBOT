import "dart:io" show Platform;

import "package:permission_handler/permission_handler.dart";

/// 通话记录读取权限服务。
///
/// `AndroidManifest.xml` 已声明 `READ_CALL_LOG`，原生 `PhoneDataReader.callLog()`
/// 的查询实现完整，但 Dart 层此前从未申请过运行时权限——system 默认不授予
/// `dangerous` 级别权限，原生恒返回 `permission_denied:READ_CALL_LOG`，
/// Agent 的「看我的通话记录」工具恒定失败。这里补上运行时申请，三态与
/// [SmsAccessService] 保持一致。
///
/// 注意：permission_handler 没有独立的 READ_CALL_LOG 枚举，它归在
/// [Permission.phone] 组里，请求时会连同组内已声明的权限（如 CALL_PHONE）
/// 一起弹窗。用户全部允许后状态才为 granted。
///
/// 仅 Android 生效：iOS 不允许第三方 App 读取系统通话记录。
class CallLogAccessService {
  CallLogAccessService._();

  static final CallLogAccessService instance = CallLogAccessService._();

  /// 当前是否已授权（不触发弹窗）。
  Future<bool> isGranted() async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus status = await Permission.phone.status;
    return status.isGranted || status.isLimited;
  }

  /// 是否已被永久拒绝（需引导去系统设置）。
  Future<bool> isPermanentlyDenied() async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus status = await Permission.phone.status;
    return status.isPermanentlyDenied;
  }

  /// 确保已授权：必要时弹系统授权窗。返回是否最终可用。
  Future<bool> ensureGranted({bool request = true}) async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus current = await Permission.phone.status;
    if (current.isGranted || current.isLimited) return true;
    if (!request) return false;
    // 已永久拒绝：再 request 也不会弹窗（Android 直接 false）
    if (current.isPermanentlyDenied) return false;
    final PermissionStatus next = await Permission.phone.request();
    return next.isGranted || next.isLimited;
  }

  /// 打开系统应用设置页（永久拒绝时的唯一出路）。
  Future<bool> openSettings() async {
    if (!Platform.isAndroid) return false;
    return openAppSettings();
  }
}
