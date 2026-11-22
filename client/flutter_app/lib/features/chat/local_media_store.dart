import "dart:io";

import "package:crypto/crypto.dart" as crypto;
import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// 本地持久图库（2026-11-22 隐私方案）。
///
/// 用户随消息发出的图片字节落在本机应用支持目录 `sent_media/`，文件名取
/// 字节内容的 sha256（同一张图只存一份）。聊天记录本身只留手机、不上传云端，
/// 所以这些原图也必须留在手机：服务端 7 天后 GC 删原图，本机仍可回看。
///
/// 与 [MediaDiskCache] 的区别：
///   - MediaDiskCache 是「服务端媒体 URL → 字节」的 300MB LRU 派生缓存；
///   - 本模块是「用户自己发的原图」的持久存储，不参与 LRU 淘汰，卸载才清。
class LocalMediaStore {
  LocalMediaStore._();
  static final LocalMediaStore instance = LocalMediaStore._();

  Directory? _dir;
  Future<Directory?>? _dirFuture;

  Future<Directory?> _ensureDir() {
    return _dirFuture ??= () async {
      try {
        final Directory base = await getApplicationSupportDirectory();
        final Directory dir = Directory(
          "${base.path}${Platform.pathSeparator}sent_media",
        );
        if (!dir.existsSync()) dir.createSync(recursive: true);
        return _dir = dir;
      } catch (e) {
        debugPrint("[LocalMediaStore] 目录不可用(降级内存展示): $e");
        return null;
      }
    }();
  }

  /// 字节内容 → 稳定文件名（sha256，去重）。
  static String keyForBytes(List<int> bytes) =>
      crypto.sha256.convert(bytes).toString();

  /// 把一张原图写入本地图库，返回相对文件名（可直接传给 [fileFor]）。
  /// 已存在则跳过写盘（幂等）。失败返回 null，调用方回退内存展示。
  Future<String?> save(List<int> bytes) async {
    final Directory? dir = await _ensureDir();
    if (dir == null) return null;
    final String name = keyForBytes(bytes);
    final File target = File("${dir.path}${Platform.pathSeparator}$name");
    try {
      if (!target.existsSync() || target.lengthSync() == 0) {
        final File tmp = File("${target.path}.part");
        await tmp.writeAsBytes(bytes, flush: true);
        await tmp.rename(target.path);
      }
      return name;
    } catch (e) {
      debugPrint("[LocalMediaStore] 落盘失败(忽略): $e");
      return null;
    }
  }

  /// 批量落盘，返回成功的文件名列表（顺序与入参一致，失败项跳过）。
  Future<List<String>> saveAll(Iterable<List<int>> frames) async {
    final List<String> out = <String>[];
    for (final List<int> bytes in frames) {
      final String? name = await save(bytes);
      if (name != null) out.add(name);
    }
    return out;
  }

  /// 按相对文件名取本地文件；不存在或为空返回 null。
  Future<File?> fileFor(String? name) async {
    if (name == null || name.isEmpty) return null;
    final Directory? dir = await _ensureDir();
    if (dir == null) return null;
    final File f = File("${dir.path}${Platform.pathSeparator}$name");
    try {
      if (f.existsSync() && f.lengthSync() > 0) return f;
    } catch (_) {}
    return null;
  }

  /// 同步取本地文件（供气泡首帧同步解析，避免闪占位）。
  File? peek(String? name) {
    if (name == null || name.isEmpty) return null;
    final Directory? dir = _dir;
    if (dir == null) return null;
    final File f = File("${dir.path}${Platform.pathSeparator}$name");
    try {
      if (f.existsSync() && f.lengthSync() > 0) return f;
    } catch (_) {}
    return null;
  }
}
