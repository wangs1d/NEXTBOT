import "dart:convert" show jsonDecode, JsonEncoder;
import "dart:io" show Directory, File, Platform;

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";

/// 右侧面板「常用工具」的布局偏好：排序 + 可见性。
///
/// 持久化到 applicationSupport 目录下的 JSON 文件（与
/// [SchedulePreference] 同目录、同读写模式），进程内带缓存。
class RightPanelToolPreference {
  RightPanelToolPreference._();

  static const String _fileName = "right_panel_tool_preference.json";
  static RightPanelToolLayout? _cached;

  /// 读取布局偏好；文件不存在或损坏时返回默认布局。
  static Future<RightPanelToolLayout> load() async {
    if (_cached != null) return _cached!;
    try {
      final File prefFile = await _getPrefFile();
      if (!await prefFile.exists()) {
        return _cached = const RightPanelToolLayout();
      }
      final String raw = await prefFile.readAsString();
      final Map<String, dynamic> json =
          jsonDecode(raw) as Map<String, dynamic>;
      final List<dynamic> order = json["order"] as List<dynamic>? ?? const [];
      final List<dynamic> hidden = json["hidden"] as List<dynamic>? ?? const [];
      return _cached = RightPanelToolLayout(
        order: order.whereType<String>().toList(),
        hidden: hidden.whereType<String>().toList(),
      );
    } catch (e) {
      debugPrint("[RightPanelToolPref] read failed: $e");
      return _cached = const RightPanelToolLayout();
    }
  }

  /// 保存布局偏好（排序在前、被隐藏的工具 id 列表在后）。
  static Future<void> save(RightPanelToolLayout layout) async {
    _cached = layout;
    try {
      final File prefFile = await _getPrefFile();
      await prefFile.parent.create(recursive: true);
      await prefFile.writeAsString(
        const JsonEncoder.withIndent("  ").convert(<String, dynamic>{
          "order": layout.order,
          "hidden": layout.hidden,
          "updatedAt": DateTime.now().toIso8601String(),
        }),
        flush: true,
      );
    } catch (e) {
      debugPrint("[RightPanelToolPref] save failed: $e");
    }
  }

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
}

/// 工具布局：[order] 为工具 id 的期望顺序（新工具 id 不在其中时
/// 追加到末尾），[hidden] 为被隐藏的工具 id。
class RightPanelToolLayout {
  const RightPanelToolLayout({
    this.order = const <String>[],
    this.hidden = const <String>[],
  });

  final List<String> order;
  final List<String> hidden;

  bool isHidden(String id) => hidden.contains(id);

  /// 对全量工具 id 排序：order 里的按其位置，未登记的按原顺序追加。
  List<String> sortIds(List<String> allIds) {
    final List<String> known =
        order.where((String id) => allIds.contains(id)).toList();
    final List<String> rest =
        allIds.where((String id) => !known.contains(id)).toList();
    return <String>[...known, ...rest];
  }

  RightPanelToolLayout copyWith({List<String>? order, List<String>? hidden}) {
    return RightPanelToolLayout(
      order: order ?? this.order,
      hidden: hidden ?? this.hidden,
    );
  }
}
