import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";

/// 应用支持目录 org 迁移（com.example → top.nextbot，2026-10-21）。
///
/// CompanyName 原先是 Flutter 脚手架默认的 com.example，应用支持目录随之
/// 落在 `%APPDATA%\com.example\private_ai_agent`。改名后新装版本落在
/// `%APPDATA%\top.nextbot\private_ai_agent`——本模块负责一次性搬迁老目录，
/// 保证老用户升级后登录态/聊天历史/窗口位置无缝续用，感知不到目录搬家。
///
/// 设计约束：
/// - 幂等：任意次调用、新旧目录任意组合状态都安全；
/// - 新数据优先：新目录已有的文件一律不覆盖（避免新登录态被旧文件回滚）；
/// - 静默失败：迁移异常只记日志不阻塞启动（失败后果 = 老用户重登一次，
///   远好于因迁移异常导致应用无法启动）；
/// - 非 Windows 直接跳过（org 目录布局只存在于桌面 RoamingAppData）。
class AppSupportMigration {
  AppSupportMigration._();

  /// 旧 CompanyName（Flutter 脚手架默认）。
  static const String _legacyOrg = "com.example";

  static bool _done = false;

  /// 在任何 getApplicationSupportDirectory 消费者（AccountSessionStore /
  /// AccessCredentialStore / WindowBoundsSaver / Isar 历史库……）之前调用。
  static Future<void> migrateIfNeeded() async {
    if (_done) return;
    _done = true;
    if (!Platform.isWindows) return;
    try {
      final Directory newDir = await getApplicationSupportDirectory();
      // 老目录 = Roaming\<旧org>\<同一叶子名>；从新目录反推，不硬编码绝对路径。
      final String leaf = newDir.path.split(Platform.pathSeparator).last;
      final Directory legacyDir = Directory(
        "${newDir.parent.path}\\$_legacyOrg\\$leaf",
      );
      // 防御：旧 exe 未重编译时（版本资源仍是 com.example），新旧目录同路径。
      if (legacyDir.path == newDir.path || !legacyDir.existsSync()) return;

      if (!newDir.existsSync()) {
        // 新目录不存在：整体 rename，O(1) 且原子。
        try {
          await legacyDir.rename(newDir.path);
          debugPrint("[AppSupportMigration] renamed ${legacyDir.path} -> ${newDir.path}");
        } catch (e) {
          debugPrint("[AppSupportMigration] rename failed, falling back to copy: $e");
          await _copyMissing(legacyDir, newDir);
        }
      } else {
        // 新目录已存在（新版本跑过）：只补缺，不覆盖。
        await _copyMissing(legacyDir, newDir);
      }
      _pruneLegacyShell(legacyDir);
    } catch (e) {
      debugPrint("[AppSupportMigration] 迁移失败（忽略，不影响启动）: $e");
    }
  }

  /// 递归把 legacy 里有而 target 里没有的文件/子目录搬过去；两边都有 → 保留 target。
  static Future<void> _copyMissing(Directory legacy, Directory target) async {
    await for (final FileSystemEntity entity in legacy.list()) {
      // basename 统一从 entity.path 提取：Directory 的 uri 带尾斜杠，
      // uri.pathSegments.last 会拿到空串。
      final String name = entity.path.split(Platform.pathSeparator).last;
      final String destPath = "${target.path}\\$name";
      if (entity is File) {
        final File dest = File(destPath);
        if (!dest.existsSync()) {
          try {
            await entity.rename(destPath);
          } catch (_) {
            // rename 失败（极少见）降级复制
            try {
              await entity.copy(destPath);
            } catch (_) {}
          }
        }
      } else if (entity is Directory) {
        final Directory dest = Directory(destPath);
        if (!dest.existsSync()) {
          try {
            await entity.rename(destPath);
            continue;
          } catch (_) {}
        }
        await dest.create(recursive: true);
        await _copyMissing(entity, dest);
      }
    }
  }

  /// 迁移完清掉旧 org 空壳目录（com.example 整个删掉；删不掉留原样，无害）。
  static void _pruneLegacyShell(Directory legacyDir) {
    try {
      final Directory legacyOrg = legacyDir.parent;
      if (legacyOrg.existsSync() &&
          legacyOrg.listSync().isEmpty &&
          legacyOrg.parent.path.endsWith("Roaming")) {
        legacyOrg.deleteSync();
      }
    } catch (_) {}
  }
}
