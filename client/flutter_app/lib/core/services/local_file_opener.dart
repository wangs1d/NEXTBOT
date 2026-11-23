import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 用系统应用打开本机缓存文件（2026-11-23 资料库全量预取配套）。
///
/// 为什么不用 `url_launcher` 的 `file://`：Android 7+ 对 app 私有目录的
/// file:// URI 抛 FileUriExposedException，必须走 FileProvider 的 content://
/// URI 并临时授权。原生侧（FileOpenPlugin）用 androidx.core FileProvider 完成，
/// Dart 只传绝对路径 + 文件名（用于推断 MIME）。
///
/// 任何失败（插件未注册 / 无应用能打开 / 平台不支持）都返回 false，调用方
/// 回退在线浏览器打开——预取失败也绝不阻塞用户拿到文件。
class LocalFileOpener {
  LocalFileOpener._();

  static const MethodChannel _channel = MethodChannel("com.nextbot.app/file_open");

  /// 尝试用系统应用打开 [path]；[fileName] 用于按扩展名推断 MIME。
  /// 成功返回 true，任何异常/拒绝返回 false。
  static Future<bool> open(String path, String fileName) async {
    if (!Platform.isAndroid) return false;
    try {
      final bool? ok = await _channel.invokeMethod<bool>("open", <String, dynamic>{
        "path": path,
        "mime": mimeOf(fileName),
      });
      return ok ?? false;
    } on MissingPluginException {
      debugPrint("[LocalFileOpener] 原生插件未注册，回退在线打开");
      return false;
    } catch (e) {
      debugPrint("[LocalFileOpener] 打开失败，回退在线: $e");
      return false;
    }
  }

  /// 扩展名 → MIME。按资料库实际产物类型覆盖；未知类型交系统用 */* 试探。
  static String mimeOf(String fileName) {
    final int dot = fileName.lastIndexOf(".");
    if (dot < 0 || dot == fileName.length - 1) return "*/*";
    final String ext = fileName.substring(dot + 1).toLowerCase();
    const Map<String, String> types = <String, String>{
      "pdf": "application/pdf",
      "doc": "application/msword",
      "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "xls": "application/vnd.ms-excel",
      "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "csv": "text/csv",
      "tsv": "text/tab-separated-values",
      "txt": "text/plain",
      "md": "text/markdown",
      "json": "application/json",
      "html": "text/html",
      "htm": "text/html",
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "webp": "image/webp",
      "gif": "image/gif",
      "mp3": "audio/mpeg",
      "mp4": "video/mp4",
      "zip": "application/zip",
    };
    return types[ext] ?? "*/*";
  }
}
