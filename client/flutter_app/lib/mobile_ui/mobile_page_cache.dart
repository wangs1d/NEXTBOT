import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// 手机端页面数据轻量磁盘缓存（2026-11-10）。
///
/// 背景：「目标」「资料库」等页面每次切 tab 都整页转圈等网络——即使上一秒
/// 刚看过。本模块给这类页面提供 **stale-while-revalidate** 的持久层：
///   - 上次成功响应体按 key 落盘（应用支持目录 `page_cache/`）；
///   - 进入页面时先读缓存立即上屏（秒进），网络请求后台静默刷新；
///   - 刷新成功后回写缓存；任何读写失败都静默降级，绝不阻塞 UI。
///
/// 缓存的是服务端原始 JSON 响应体（Map），解析仍由各页面自己完成——
/// 页面结构变了旧缓存解析不出就地兜空，无需版本迁移。
class MobilePageCache {
  MobilePageCache._();
  static final MobilePageCache instance = MobilePageCache._();

  /// 内存热缓存：会话内同 key 二次读取零 IO。
  final Map<String, Map<String, dynamic>> _mem = <String, Map<String, dynamic>>{};

  Future<Directory?>? _dirFuture;

  Future<Directory?> _ensureDir() {
    return _dirFuture ??= () async {
      try {
        final Directory dir = Directory(
          "${(await getApplicationSupportDirectory()).path}"
          "${Platform.pathSeparator}page_cache",
        );
        if (!dir.existsSync()) dir.createSync(recursive: true);
        return dir;
      } catch (e) {
        debugPrint("[MobilePageCache] 缓存目录不可用(降级直连): $e");
        return null;
      }
    }();
  }

  /// actorId 等业务字段可能带任意字符，收窄成安全文件名成分。
  static String _safeKey(String key) =>
      key.replaceAll(RegExp(r"[^A-Za-z0-9_.-]"), "_");

  /// 读缓存：先内存后磁盘。任何失败返回 null（调用方回退网络加载）。
  Future<Map<String, dynamic>?> read(String key) async {
    final String k = _safeKey(key);
    final Map<String, dynamic>? hot = _mem[k];
    if (hot != null) return hot;
    try {
      final Directory? dir = await _ensureDir();
      if (dir == null) return null;
      final File file = File("${dir.path}${Platform.pathSeparator}$k.json");
      if (!file.existsSync()) return null;
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is Map<String, dynamic>) {
        return _mem[k] = decoded;
      }
    } catch (e) {
      debugPrint("[MobilePageCache] 读缓存失败($k): $e");
    }
    return null;
  }

  /// 写缓存：先更新内存再异步落盘（临时文件 + rename 原子替换），失败静默。
  void write(String key, Map<String, dynamic> body) {
    final String k = _safeKey(key);
    _mem[k] = body;
    unawaited(() async {
      try {
        final Directory? dir = await _ensureDir();
        if (dir == null) return;
        final File file = File("${dir.path}${Platform.pathSeparator}$k.json");
        final File tmp = File("${file.path}.tmp");
        await tmp.writeAsString(jsonEncode(body), flush: true);
        await tmp.rename(file.path);
      } catch (e) {
        debugPrint("[MobilePageCache] 写缓存失败($k): $e");
      }
    }());
  }
}
