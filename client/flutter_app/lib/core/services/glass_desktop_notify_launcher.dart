import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 桌面右上角玻璃通知栈（Windows 原生 ULW 窗口，多条层叠景深、倒计时进度、
/// 确认/关闭/超时事件）。决策类弹窗已改走应用内 GlassNotify 玻璃卡；
/// 本通道当前无调用方，保留待定去留。
/// 非 Windows（MissingPluginException）返回 false，由调用方降级应用内玻璃卡。
class GlassDesktopNotifyLauncher {
  GlassDesktopNotifyLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/glass_notify");

  static void Function(String id, String event)? onEvent;

  static void bindHandlers({void Function(String id, String event)? onEvent}) {
    GlassDesktopNotifyLauncher.onEvent = onEvent;
    _channel.setMethodCallHandler(_onNativeMessage);
  }

  static void unbind() {
    onEvent = null;
    _channel.setMethodCallHandler(null);
  }

  static Future<bool> show({
    required String id,
    required String title,
    required String message,
    String priority = "normal",
    String confirmText = "",
    int durationMs = 0,
  }) async {
    debugPrint("[GlassDesktopNotify] show begin id=$id");
    try {
      final bool ok = await _channel.invokeMethod<bool>("show", <String, dynamic>{
            "id": id,
            "title": title,
            "message": message,
            "priority": priority,
            "confirmText": confirmText,
            "durationMs": durationMs,
          }) ??
          false;
      debugPrint("[GlassDesktopNotify] show done id=$id ok=$ok");
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[GlassDesktopNotify] show failed: ${e.message}");
      return false;
    } on MissingPluginException {
      debugPrint("[GlassDesktopNotify] show missing plugin (non-windows)");
      return false;
    }
  }

  static Future<void> hide(String id) async {
    try {
      await _channel.invokeMethod<bool>("hide", <String, dynamic>{"id": id});
    } on PlatformException catch (e) {
      debugPrint("[GlassDesktopNotify] hide failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  static Future<void> hideAll() async {
    try {
      await _channel.invokeMethod<bool>("hideAll");
    } on PlatformException catch (e) {
      debugPrint("[GlassDesktopNotify] hideAll failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onEvent") return null;
    final Object? raw = call.arguments;
    if (raw is! Map) return null;
    final String id = raw["id"]?.toString() ?? "";
    final String event = raw["event"]?.toString() ?? "";
    if (id.isEmpty || event.isEmpty) return null;
    onEvent?.call(id, event);
    return null;
  }
}
