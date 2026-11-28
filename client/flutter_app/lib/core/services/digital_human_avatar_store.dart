import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart" show ValueListenable, ValueNotifier;
import "package:path_provider/path_provider.dart";

/// 桌面端数字人形象的用户自定义头像（本地文件）。
///
/// 默认展示内置的 Muse 模型形象；用户点「换头像」后把图片落到 app support 目录，
/// 并通过 [path] 通知头像框与右侧面板即时重建。这样不依赖浏览器/WebView，
/// 也不依赖 8765 服务在线——用户选哪张就立刻显示哪张。
class DigitalHumanAvatarStore {
  DigitalHumanAvatarStore._() {
    unawaited(_loadExisting());
  }

  static final DigitalHumanAvatarStore instance = DigitalHumanAvatarStore._();

  static const String _fileName = "digital-human-avatar.png";

  final ValueNotifier<String?> _path = ValueNotifier<String?>(null);

  ValueListenable<String?> get path => _path;

  String? get currentPath => _path.value;

  Future<File> get _file async {
    final Directory dir = await getApplicationSupportDirectory();
    return File("${dir.path}${Platform.pathSeparator}$_fileName");
  }

  Future<void> _loadExisting() async {
    try {
      final File file = await _file;
      if (await file.exists()) _path.value = file.path;
    } catch (_) {
      // 测试环境/无目录权限：保持内置形象即可。
    }
  }

  /// 保存用户选择的图片并广播更新。
  Future<void> setBytes(List<int> bytes) async {
    final File file = await _file;
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes, flush: true);
    _path.value = file.path;
  }

  /// 恢复内置 Muse 形象。
  Future<void> reset() async {
    try {
      final File file = await _file;
      if (await file.exists()) await file.delete();
    } catch (_) {
      // 删除失败不影响内存态回退。
    }
    _path.value = null;
  }
}
