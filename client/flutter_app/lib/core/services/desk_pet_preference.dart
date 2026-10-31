import "dart:convert" show JsonEncoder, jsonDecode;
import "dart:io" show Directory, File, Platform;

import "package:flutter/foundation.dart" show debugPrint, kIsWeb;
import "package:path_provider/path_provider.dart";

/// 桌宠「上次会话是否开启」持久化：applicationSupport 目录下的 JSON 文件
/// （与 WindowBoundsPreference 同目录、同读写模式，进程内带缓存）。
///
/// 默认关闭：应用启动不拉桌宠；用户召唤过且本次会话结束时桌宠仍开着，
/// 下次启动自动恢复。
class DeskPetPreference {
  DeskPetPreference._();

  static const String _fileName = "desk_pet.json";
  static bool? _cached;

  static bool get isSupported => !kIsWeb && Platform.isWindows;

  static Future<bool> loadSummoned() async {
    if (!isSupported) return false;
    if (_cached != null) return _cached!;
    try {
      final File prefFile = await _getPrefFile();
      if (!await prefFile.exists()) return _cached = false;
      final Object? decoded = jsonDecode(await prefFile.readAsString());
      return _cached =
          decoded is Map<String, dynamic> && decoded["summoned"] == true;
    } catch (e) {
      debugPrint("[DeskPet] read preference failed: $e");
      return _cached = false;
    }
  }

  static Future<void> saveSummoned(bool value) async {
    if (!isSupported || _cached == value) return;
    _cached = value;
    try {
      final File prefFile = await _getPrefFile();
      await prefFile.parent.create(recursive: true);
      await prefFile.writeAsString(
        const JsonEncoder.withIndent("  ").convert(<String, dynamic>{
          "summoned": value,
          "updatedAt": DateTime.now().toIso8601String(),
        }),
        flush: true,
      );
    } catch (e) {
      debugPrint("[DeskPet] save preference failed: $e");
    }
  }

  static Future<File> _getPrefFile() async {
    final Directory appDir = await getApplicationSupportDirectory();
    return File("${appDir.path}${Platform.pathSeparator}$_fileName");
  }
}
