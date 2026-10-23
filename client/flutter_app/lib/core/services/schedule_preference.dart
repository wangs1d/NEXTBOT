import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// 日程显示模式偏好
///
/// 历史：曾有 desktopFloating（独立悬浮窗）模式，2026-09-25 随悬浮窗
/// 移除而删除，其职责由桌面顶部灵动岛承担。旧偏好文件里的
/// "desktopFloating" 值读取时按 embedded 处理。
enum ScheduleDisplayMode {
  /// 应用内嵌（默认）— 日程显示在应用侧边栏/浮动面板中
  embedded,
}

/// 用户日程显示偏好持久化
///
/// 使用 JSON 文件存储在应用数据目录，无需修改 Isar schema。
class SchedulePreference {
  SchedulePreference._();

  static const String _fileName = "schedule_preference.json";
  static ScheduleDisplayMode? _cachedMode;

  /// 获取用户选择的日程显示模式（带缓存）
  static Future<ScheduleDisplayMode> getDisplayMode() async {
    if (_cachedMode != null) return _cachedMode!;

    try {
      final File prefFile = await _getPrefFile();
      if (!await prefFile.exists()) {
        return ScheduleDisplayMode.embedded; // 默认值
      }

      // 旧值 "desktopFloating" 随悬浮窗移除，回落到 embedded。
      _cachedMode = ScheduleDisplayMode.embedded;
    } catch (e) {
      debugPrint("[SchedulePref] read failed: $e");
      _cachedMode = ScheduleDisplayMode.embedded;
    }

    return _cachedMode!;
  }

  /// 保存用户选择的日程显示模式
  static Future<void> setDisplayMode(ScheduleDisplayMode mode) async {
    _cachedMode = mode;

    try {
      final File prefFile = await _getPrefFile();
      final Directory parentDir = prefFile.parent;
      if (!await parentDir.exists()) {
        await parentDir.create(recursive: true);
      }

      final Map<String, String> json = <String, String>{
        "displayMode": "embedded",
        "updatedAt": DateTime.now().toIso8601String(),
      };

      await prefFile.writeAsString(
        const JsonEncoder.withIndent("  ").convert(json),
        flush: true,
      );
    } catch (e) {
      debugPrint("[SchedulePref] save failed: $e");
    }
  }

  /// 重置为默认（应用内嵌）
  static Future<void> reset() async {
    await setDisplayMode(ScheduleDisplayMode.embedded);
  }

  /// 获取偏好文件路径
  static Future<File> _getPrefFile() async {
    final Directory appDir = await getApplicationSupportDirectory();
    final String dirPath =
        "${appDir.path}${Platform.pathSeparator}nextbot";
    final File prefFile = File("$dirPath${Platform.pathSeparator}$_fileName");
    // 旧叶子目录一次性迁移（2026-10-23 前：...\private_ai_agent）：新文件缺失
    // 且旧文件存在 → 复制过来，老用户偏好无缝续用。
    try {
      final File legacy = File(
        "${appDir.path}${Platform.pathSeparator}private_ai_agent"
        "${Platform.pathSeparator}$_fileName",
      );
      if (!await prefFile.exists() && await legacy.exists()) {
        await Directory(dirPath).create(recursive: true);
        await legacy.copy(prefFile.path);
      }
    } catch (_) {}
    return prefFile;
  }

  /// 清除缓存（用于测试或热重启后）
  static void clearCache() {
    _cachedMode = null;
  }
}
