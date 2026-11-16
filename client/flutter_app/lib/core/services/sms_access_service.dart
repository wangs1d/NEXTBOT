import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:permission_handler/permission_handler.dart";

/// 短信读取权限服务（2026-11-13）。
///
/// **病根**：`AndroidManifest.xml` 一直声明着 `READ_SMS`，原生 `PhoneDataReader.smsList()`
/// 的查询实现也完整，但 **Dart 层从来没有申请过这个运行时权限**——系统默认不授予
/// `dangerous` 级别权限，于是原生每次都直接返回 `permission_denied:READ_SMS`，
/// Agent 的「看我的短信」工具恒定失败，且失败原因看起来像功能缺失而不是授权缺失。
///
/// 这里补上运行时申请，并给出明确的三态：
///   - 已授权 → 正常读
///   - 首次未授权 → 弹系统授权窗（用户点允许即生效）
///   - 永久拒绝（勾了「不再询问」）→ 引导去系统设置，不做无效的重复弹窗
///
/// 仅 Android 生效：iOS 的短信权限语义与本项目用途不匹配，直接按不支持处理。
class SmsAccessService {
  SmsAccessService._();

  static final SmsAccessService instance = SmsAccessService._();

  /// 当前是否已授权（不触发弹窗）。
  Future<bool> isGranted() async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus status = await Permission.sms.status;
    return status.isGranted || status.isLimited;
  }

  /// 是否已被永久拒绝（需引导去系统设置）。
  Future<bool> isPermanentlyDenied() async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus status = await Permission.sms.status;
    return status.isPermanentlyDenied;
  }

  /// 确保已授权：必要时弹系统授权窗。返回是否最终可用。
  ///
  /// [request] 传 false 时只查状态（用于后台场景——后台弹窗用户看不见，
  /// 静默失败还不如如实报错）。
  Future<bool> ensureGranted({bool request = true}) async {
    if (!Platform.isAndroid) return false;
    final PermissionStatus current = await Permission.sms.status;
    if (current.isGranted || current.isLimited) return true;
    if (!request) return false;
    // 已永久拒绝：再 request 也不会弹窗（Android 直接 false），不必浪费一次调用
    if (current.isPermanentlyDenied) return false;
    final PermissionStatus next = await Permission.sms.request();
    return next.isGranted || next.isLimited;
  }

  /// 打开系统应用设置页（永久拒绝时的唯一出路）。
  Future<bool> openSettings() async {
    if (!Platform.isAndroid) return false;
    return openAppSettings();
  }

  /// 供 UI 监听的授权状态（ValueNotifier，设置页用它回显）。
  final ValueNotifier<bool> granted = ValueNotifier<bool>(false);

  /// 刷新一次授权状态（回到前台或设置页打开时调用）。
  Future<void> refresh() async {
    granted.value = await isGranted();
  }
}
