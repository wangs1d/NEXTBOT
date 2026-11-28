import "dart:io" show Platform;

import "../../features/alarm/alarm_platform.dart";

/// 手机本地闹钟权限接入服务（2026-11-26）。
///
/// 与 [SmsAccessService] / [CallLogAccessService] 并列的能力连接器，区别在于
/// 闹钟是「写」权限而非「读」权限：Agent 要帮用户设真会响的闹钟，必须拿到
/// Android 12+ 的精确闹钟调度权（SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM）。
///
/// 精确闹钟权限不是运行时 `dangerous` 权限，permission_handler 管不到——它是
/// 系统「特殊应用访问」，只能由用户去系统设置页开启。这里复用已有的
/// [AlarmPlatform] 原生桥（canScheduleExact / openExactAlarmSettings）做三态：
///   - 已授权 → Agent 建的闹钟走 setAlarmClock，杀进程也响；
///   - 未授权 → 点「连接」跳系统「闹钟和提醒」授权页，回前台由生命周期回调重查；
///   - Android 14+ 全屏意图 / 电池优化白名单是可靠性开关（锁屏响铃、后台准点），
///     不阻塞主权限，作为卡片内的次级入口。
///
/// 关键衔接：权限从「未授予」变「已授予」后，必须让 [AlarmEngine] 全量重排，
/// 否则此前降级成 ±10min 窗口预约的存量闹钟不会自动升级成精确闹钟。
/// 这一步由能力连接页在回前台重查到状态翻转时调用（本类不直接依赖引擎）。
///
/// 仅 Android 生效：iOS 无第三方持续响铃能力，端上由本地通知承载（30s 提示音
/// 上限，见 docs/mobile-agent-reminder-alarm-design.md §6），桌面端桥未注册。
class AlarmAccessService {
  AlarmAccessService._();

  static final AlarmAccessService instance = AlarmAccessService._();

  /// 当前平台是否支持「精确闹钟」这一系统授权项。
  bool get isSupported => Platform.isAndroid;

  /// 精确闹钟权限是否已授予（不触发任何跳转）。
  Future<bool> isGranted() async {
    if (!isSupported) return false;
    return AlarmPlatform.canScheduleExact();
  }

  /// 跳系统「闹钟和提醒」授权页（Android 12+）。
  Future<void> openSettings() async {
    if (!isSupported) return;
    await AlarmPlatform.openExactAlarmSettings();
  }

  /// 电池优化白名单是否已忽略（Android 6+；低版本按已忽略处理）。
  /// 与精确闹钟权限相互独立：不忽略也能设闹钟，只是后台可能被冻结、响铃延迟。
  Future<bool> isBatteryOptimizationIgnored() async {
    if (!isSupported) return true;
    return AlarmPlatform.isBatteryOptimizationIgnored();
  }

  /// 跳 Android 14+ 全屏意图 / 电池优化白名单设置页（可靠性增强，非必需）。
  Future<void> openReliabilitySettings() async {
    if (!isSupported) return;
    await AlarmPlatform.openAlarmReliabilitySettings();
  }
}
