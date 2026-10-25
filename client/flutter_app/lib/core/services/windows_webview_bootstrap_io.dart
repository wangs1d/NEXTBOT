import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart" show PlatformException;
import "package:webview_windows/webview_windows.dart";

/// 进程级 WebView2 环境参数附加项（环境只初始化一次，首次调用生效）。
/// 由驱动适配器在 start 前设置（如 `--remote-debugging-port=<port>`）。
String? webviewAdditionalArguments;

Future<void> bootstrapWindowsWebView({
  String? additionalArguments,
  String? userDataPath,
}) async {
  if (!Platform.isWindows) return;
  try {
    final String base = additionalArguments ?? webviewAdditionalArguments ?? "";
    await WebviewController.initializeEnvironment(
      userDataPath: userDataPath,
      additionalArguments: _mergeArgs(
        "--enable-gpu-rasterization --ignore-gpu-blocklist",
        base,
      ),
    );
  } on PlatformException catch (e) {
    // environment_already_initialized 是幂等重入（同进程二次预热），不算失败；
    // 其余（尤其 environment_creation_failed）曾在这里被静默吞掉，窗口只会
    // 停在"加载中"兜底文案且无任何日志（2026-10-25 早报悬浮窗整窗失败即此因）。
    if (e.code != "environment_already_initialized") {
      debugPrint("[WebViewBootstrap] initializeEnvironment failed: "
          "${e.code} ${e.message}");
    }
  } catch (e) {
    debugPrint("[WebViewBootstrap] initializeEnvironment failed: $e");
  }
}

/// 子进程窗口专用的 WebView2 用户数据目录（[suffix] 区分用途，如
/// "_briefing" / "_travel"）；LOCALAPPDATA 取不到时返回 null（回退插件默认）。
///
/// 仅作为 [ensureChildWebViewEnvironment] 加入失败时的独立实例兜底——
/// 正常路径子窗口与主应用共用同一目录同一参数，直接加入同一个浏览器进程。
String? childWebViewDataPath(String suffix) {
  final String? localAppData = Platform.environment["LOCALAPPDATA"];
  if (localAppData == null || localAppData.isEmpty) return null;
  final String exeName =
      Platform.resolvedExecutable.split(Platform.pathSeparator).last;
  final int dot = exeName.lastIndexOf(".");
  final String stem = dot > 0 ? exeName.substring(0, dot) : exeName;
  return "$localAppData\\flutter_webview_windows\\$stem$suffix";
}

/// 共享 WebView2 环境的 CDP 调试端口（主应用与子进程窗口共用一份参数）。
/// 改端口只改这里：参数逐字一致是子窗口能加入主应用浏览器进程的前提。
const int kSharedWebViewDebugPort = 9333;

/// 子进程窗口（早报悬浮窗/行程规划窗口）的 WebView2 环境初始化。
///
/// 背景：主应用自 2026-10-25 起启动即以 `--remote-debugging-port` 初始化
/// 共享环境，而 WebView2 的一个用户数据目录只挂一个浏览器进程，参数不一致
/// 的第二家环境创建直接失败——子窗口沿用默认目录必然整窗打不开。
///
/// 内存策略（2026-10-25）：先尝试**同目录同参数**初始化，WebView2 会把子窗口
/// 直接加入主应用已启动的浏览器进程——全应用只跑一个浏览器实例（早报+行程+
/// 内置浏览器各自独立实例约多占 200MB）；仅当加入失败（主应用参数不同/未初始
/// 化等）才退回 [fallbackSuffix] 专属目录自建独立实例（不带调试端口）。
Future<void> ensureChildWebViewEnvironment(String fallbackSuffix) async {
  if (!Platform.isWindows) return;
  const String gpuArgs = "--enable-gpu-rasterization --ignore-gpu-blocklist";
  try {
    await WebviewController.initializeEnvironment(
      additionalArguments:
          "$gpuArgs --remote-debugging-port=$kSharedWebViewDebugPort",
    );
    return;
  } on PlatformException catch (e) {
    // 同进程二次预热（幂等）：环境已就绪，无需兜底
    if (e.code == "environment_already_initialized") return;
    debugPrint(
      "[WebViewBootstrap] 加入主应用 WebView 环境失败（改用独立目录兜底）: ${e.code}",
    );
  } catch (e) {
    debugPrint(
      "[WebViewBootstrap] 加入主应用 WebView 环境失败（改用独立目录兜底）: $e",
    );
  }
  try {
    await WebviewController.initializeEnvironment(
      userDataPath: childWebViewDataPath(fallbackSuffix),
      additionalArguments: gpuArgs,
    );
  } on PlatformException catch (e) {
    if (e.code != "environment_already_initialized") {
      debugPrint("[WebViewBootstrap] initializeEnvironment failed: "
          "${e.code} ${e.message}");
    }
  } catch (e) {
    debugPrint("[WebViewBootstrap] initializeEnvironment failed: $e");
  }
}

String _mergeArgs(String a, String? b) {
  final String extra = (b ?? "").trim();
  if (extra.isEmpty) return a;
  return "$a $extra";
}
