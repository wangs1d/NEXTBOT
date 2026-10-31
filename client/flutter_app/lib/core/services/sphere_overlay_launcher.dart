import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";

/// Windows 桌宠启动器 — 默认 **PySide6 (sphere-overlay-py)** 或 **Flutter 内嵌 WebView**。
/// Runner 内不再链接第二套 WebView2（会与 webview_windows 冲突导致进程崩溃）。
class SphereOverlayLauncher {
  SphereOverlayLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/sphere_overlay");

  /// sphere-overlay-py 画出首帧后往 stdout 打的一行，召唤路径以此判定"真的出现了"。
  static const String _readyMarker = "SPHERE_OVERLAY_READY";

  /// 桌宠单实例：已有另一份在跑时，新进程唤起它然后退场。
  static const String _alreadyRunningMarker = "SPHERE_OVERLAY_ALREADY_RUNNING";

  /// 上一次召唤失败的具体原因（成功或未尝试时为 null）。
  static String? lastLaunchError;

  static const bool _useInProcessOverlay = bool.fromEnvironment(
    "IN_PROCESS_SPHERE_OVERLAY",
    defaultValue: false,
  );

  static bool _created = false;
  static bool _visible = false;
  static Process? _overlayProcess;

  /// PySide6 桌宠是否已启动（UI 可据此隐藏内嵌 WebView 框）。
  static final ValueNotifier<bool> overlayActive = ValueNotifier<bool>(false);

  /// 独立桌宠不可用时的降级标记（显示内嵌透明 WebView）。
  static final ValueNotifier<bool> useEmbeddedFallback =
      ValueNotifier<bool>(false);

  static bool get isRunning => _created && _visible;
  static bool get isCreated => _created;
  static bool get usesOverlayProcess =>
      _overlayProcess != null || overlayActive.value;

  /// 进程内 Win32 WebView2 桌宠（非 PySide6、非内嵌 WebView）。
  static bool get isInProcessOverlayActive =>
      _created && _overlayProcess == null && !useEmbeddedFallback.value;

  /// PySide6 或进程内 overlay 任一就绪时，应隐藏 Flutter 内嵌 WebView。
  static bool get isDeskPetActive =>
      overlayActive.value || isInProcessOverlayActive;

  /// 是否已安装 sphere-overlay-py 且 overlay 资源完整。
  static bool get isOverlayAvailable => overlayUnavailableReason == null;

  /// 桌宠不可用时的人类可读原因（用于 SnackBar）。
  static String? get overlayUnavailableReason {
    if (kIsWeb || !Platform.isWindows) {
      return "当前平台不支持桌宠。";
    }

    final Directory? overlayDir = _findPyOverlayDir();
    if (overlayDir == null) {
      return "未找到 sphere-overlay-py 目录。\n"
          "请从仓库根目录启动客户端，或设置环境变量 PAI_REPO_ROOT 指向项目根目录。";
    }

    if (!File("${overlayDir.path}${Platform.pathSeparator}main.py").existsSync() &&
        _frozenOverlayExe(overlayDir) == null) {
      return "缺少 main.py 或 sphere-overlay.exe，请确认 sphere-overlay-py 目录完整。";
    }

    final String? overlayHtml = _findAvatarOverlayHtml(overlayDir.parent.path);
    if (overlayHtml == null) {
      return "缺少 overlay.html。\n请执行：cd agent-sphere-avatar && npm run build";
    }

    if (!_bundleReportsReady(overlayHtml)) {
      return "overlay.html 是旧版本构建产物，不会上报桌宠就绪。\n"
          "请执行：cd agent-sphere-avatar && npm run build";
    }

    return null;
  }

  /// 构建产物是否带就绪上报（window.sphereOverlay.notifyReady）。
  /// 不带的话召唤只能干等到超时，所以在判定层直接拦下。
  /// notifyReady 落在共享 chunk 里，入口脚本要顺着 import 才能找到。
  static bool _bundleReportsReady(String overlayHtmlPath) {
    if (Platform.environment["PAI_OVERLAY_DEV_URL"]?.trim().isNotEmpty ?? false) {
      return true; // 开发模式跑 dev server，与 dist 产物无关
    }
    try {
      final File html = File(overlayHtmlPath);
      final String markup = html.readAsStringSync();
      final String assetPrefix = "${html.parent.path}${Platform.pathSeparator}";
      final List<File> pending = RegExp(r'''src="\.?/?([^"]+\.js)"''')
          .allMatches(markup)
          .map((Match m) => File(
              "$assetPrefix${m.group(1)!.replaceAll("/", Platform.pathSeparator)}"))
          .toList();
      final Set<String> visited = <String>{};
      while (pending.isNotEmpty) {
        final File script = pending.removeLast();
        if (!script.existsSync() || !visited.add(script.path)) continue;
        final String code = script.readAsStringSync();
        if (code.contains("notifyReady")) return true;
        for (final Match m in RegExp(
                r'''(?:from|import)\s*\(?\s*["'](\.\/[^"']+\.js)["']''')
            .allMatches(code)) {
          pending.add(File(
              "${script.parent.path}${Platform.pathSeparator}${m.group(1)!.substring(2)}"));
        }
      }
    } catch (e) {
      debugPrint("[SphereOverlay] 校验 overlay 产物失败: $e");
      return true;
    }
    return false;
  }

  static String? _findAvatarOverlayHtml(String repoRoot) {
    final File fromRepo = File(
      "$repoRoot${Platform.pathSeparator}agent-sphere-avatar${Platform.pathSeparator}dist${Platform.pathSeparator}overlay.html",
    );
    if (fromRepo.existsSync()) return fromRepo.path;

    // 仅作兜底检测；build:chat 产物含 /chat 绝对路径。
    final File fromServerAssets = File(
      "$repoRoot${Platform.pathSeparator}server${Platform.pathSeparator}web${Platform.pathSeparator}chat${Platform.pathSeparator}assets${Platform.pathSeparator}avatar${Platform.pathSeparator}overlay.html",
    );
    if (fromServerAssets.existsSync()) return fromServerAssets.path;
    return null;
  }

  static Future<bool> isWebViewReady() async {
    if (!_created) return false;
    if (overlayActive.value || useEmbeddedFallback.value) return true;
    if (_overlayProcess != null) return true;
    try {
      return await _channel.invokeMethod<bool>("isWebViewReady") ?? false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] isWebViewReady failed: ${e.message}");
      return false;
    } on MissingPluginException catch (e) {
      debugPrint("[SphereOverlay] isWebViewReady failed: $e");
      return false;
    }
  }

  static Future<bool> waitForWebViewReady({
    Duration timeout = const Duration(seconds: 15),
  }) async {
    if (_overlayProcess != null) return true;
    final Stopwatch sw = Stopwatch()..start();
    while (sw.elapsed < timeout) {
      if (await isWebViewReady()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    return false;
  }

  static Future<bool> create({String? overlayUrl, bool electron = false}) async {
    if (kIsWeb || !Platform.isWindows) return false;

    await _resyncNativeOverlayState();
    if (_created && !electron && useEmbeddedFallback.value) return true;
    if (_created && electron && overlayActive.value) return true;

    if (electron) {
      return _launchPyOverlay();
    }

    if (_useInProcessOverlay) {
      final bool native = await _createInProcess(overlayUrl: overlayUrl);
      if (native) return true;
    }

    return _enableEmbeddedFallback();
  }

  /// 在应用内嵌 WebView 槽位显示桌宠（无独立 HWND）。
  static bool _enableEmbeddedFallback() {
    debugPrint(
      "[SphereOverlay] Using embedded Flutter WebView fallback in chat slot.",
    );
    _created = true;
    _visible = true;
    overlayActive.value = false;
    useEmbeddedFallback.value = true;
    return true;
  }

  /// 热重启后 Dart 静态变量会清零，但原生 overlay 可能仍在；先对齐状态。
  static Future<void> _resyncNativeOverlayState() async {
    if (_overlayProcess != null) return;
    try {
      final bool nativeUp =
          await _channel.invokeMethod<bool>("isCreated") ?? false;
      if (nativeUp) {
        _created = true;
        _visible = true;
        useEmbeddedFallback.value = false;
      }
    } catch (e) {
      debugPrint("[SphereOverlay] resync failed: $e");
    }
  }

  /// AppBar 手动启动独立桌宠（PySide6，会先关闭 Win32 原生窗）。
  static Future<bool> launchOverlay() async {
    if (kIsWeb || !Platform.isWindows) return false;

    // 桌宠已在跑（本进程持有，或别处启动后经单实例管道接管）：唤到前台即可，
    // 重开一遍要多付一次 Chromium 冷启动
    if (_overlayProcess != null || overlayActive.value) {
      if (await _raiseExistingOverlay()) {
        _created = true;
        _visible = true;
        overlayActive.value = true;
        useEmbeddedFallback.value = false;
        return true;
      }
      // 标记还在但进程已经没了，清掉状态重新拉起
      _overlayProcess = null;
      overlayActive.value = false;
      _created = false;
    }

    if (_created) {
      await destroy();
      _created = false;
    }
    return _launchPyOverlay();
  }

  /// 收起常驻桌宠：只隐藏窗口并开始空闲计时，下次召唤立即出现。
  static Future<bool> hideOverlay() async {
    if (kIsWeb || !Platform.isWindows) return false;
    if (_overlayProcess == null && !overlayActive.value) return true;
    final bool hidden = await _sendInstanceCommand("--hide");
    if (!hidden) {
      // 进程不认这条指令或已经退出：按老路径收掉，不能留个看得见的窗口
      await destroy();
      return false;
    }
    overlayActive.value = false;
    _visible = false;
    return true;
  }

  static Future<bool> _raiseExistingOverlay() => _sendInstanceCommand("--show");

  /// 向已在跑的桌宠发一条单实例指令；返回 false 表示没有实例接住。
  static Future<bool> _sendInstanceCommand(String flag) async {
    final Directory? overlayDir = _findPyOverlayDir();
    if (overlayDir == null) return false;
    final ({String exe, List<String> args})? spec =
        _overlayLaunchSpec(overlayDir);
    if (spec == null) return false;
    try {
      final ProcessResult result = await Process.run(
        spec.exe,
        <String>[...spec.args, flag],
        workingDirectory: overlayDir.path,
      ).timeout(const Duration(seconds: 3));
      return result.exitCode == 0;
    } catch (e) {
      debugPrint("[SphereOverlay] 单实例指令 $flag 失败: $e");
      return false;
    }
  }

  static Future<bool> _createInProcess({String? overlayUrl}) async {
    try {
      final String url = overlayUrl ?? _buildOverlayUrl();
      debugPrint("[SphereOverlay] creating native overlay: $url");
      final bool ok = await _channel.invokeMethod<bool>("create", <String, dynamic>{
        "url": url,
      }) ??
          false;
      if (ok) {
        _created = true;
        useEmbeddedFallback.value = false;
        overlayActive.value = false;
      } else {
        debugPrint("[SphereOverlay] native create returned false");
      }
      return ok;
    } catch (e) {
      debugPrint("[SphereOverlay] in-process create failed: $e");
      return false;
    }
  }

  static Future<bool> _launchPyOverlay() async {
    lastLaunchError = null;
    final Directory? overlayDir = _findPyOverlayDir();
    if (overlayDir == null) {
      debugPrint("[SphereOverlay] sphere-overlay-py not found.");
      return false;
    }

    final ({String exe, List<String> args})? spec =
        _overlayLaunchSpec(overlayDir);
    if (spec == null) {
      debugPrint(
        "[SphereOverlay] missing main.py / sphere-overlay.exe — run: "
        "cd sphere-overlay-py && python -m pip install -r requirements.txt",
      );
      return false;
    }

    if (_findAvatarOverlayHtml(overlayDir.parent.path) == null) {
      debugPrint(
        "[SphereOverlay] missing overlay.html — run: "
        "cd agent-sphere-avatar && npm run build",
      );
      return false;
    }

    try {
      final Map<String, String> env =
          Map<String, String>.from(Platform.environment);
      env["PAI_WS_URL"] = ApiConfig.wsUrl;
      env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
      env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
      env["PAI_ACTOR_ID"] = ApiConfig.effectiveActorId;
      env["PAI_USER_ID"] = ApiConfig.localPin;
      env["PAI_AVATAR_DIST"] =
          "${overlayDir.parent.path}${Platform.pathSeparator}agent-sphere-avatar${Platform.pathSeparator}dist";
      env["PAI_REPO_ROOT"] = overlayDir.parent.path;

      debugPrint(
          "[SphereOverlay] launching PySide6 overlay from ${overlayDir.path} (exe=${spec.exe})");

      final Process proc = await Process.start(
        spec.exe,
        spec.args,
        workingDirectory: overlayDir.path,
        environment: env,
      );
      _overlayProcess = proc;

      // 不读就会把管道写满，反过来卡住桌宠进程
      proc.stderr
          .transform(const Utf8Decoder(allowMalformed: true))
          .listen((String chunk) => debugPrint("[SphereOverlay] $chunk"));

      final Completer<bool> ready = Completer<bool>();
      bool alreadyRunning = false;
      final StreamSubscription<String> outSub = proc.stdout
          .transform(const Utf8Decoder(allowMalformed: true))
          .transform(const LineSplitter())
          .listen((String line) {
        final String mark = line.trim();
        if (mark == _readyMarker) {
          if (!ready.isCompleted) ready.complete(true);
        } else if (mark == _alreadyRunningMarker) {
          // 单实例管道已经把已有桌宠唤到前台，这次召唤同样算成功
          alreadyRunning = true;
          if (!ready.isCompleted) ready.complete(true);
        } else if (mark.isNotEmpty) {
          debugPrint("[SphereOverlay] $mark");
        }
      });
      // 进程退出可能早于管道读完：不等 stdout 收尾就会把刚发出的就绪标记抢掉
      final Future<void> stdoutDrained =
          outSub.asFuture<void>().whenComplete(outSub.cancel);

      // 保留进程句柄以便 destroy() 关闭；退出时清理状态。
      unawaited(proc.exitCode.then((int code) async {
        debugPrint("[SphereOverlay] PySide6 overlay exited: $code");
        if (identical(_overlayProcess, proc)) {
          _overlayProcess = null;
          _created = false;
          _visible = false;
          overlayActive.value = false;
        }
        await stdoutDrained;
        if (!ready.isCompleted) ready.complete(false);
      }));

      // 拿到 PID 不等于桌宠出现了：等页面画出首帧再对外报成功。
      final bool surfaced = await ready.future.timeout(
        const Duration(seconds: 8),
        onTimeout: () {
          debugPrint("[SphereOverlay] 等待首帧就绪超时，桌宠进程仍在，按已启动处理");
          return _overlayProcess != null;
        },
      );
      if (!surfaced) {
        lastLaunchError = null;
        return false;
      }

      if (alreadyRunning && identical(_overlayProcess, proc)) {
        // 这个 pid 只是唤起方，随即自己退场；桌宠本体不归我们持有，
        // 后续关停走单实例管道
        _overlayProcess = null;
      }

      lastLaunchError = null;
      _created = true;
      _visible = true;
      overlayActive.value = true;
      useEmbeddedFallback.value = false;
      return true;
    } catch (e) {
      debugPrint("[SphereOverlay] PySide6 overlay launch failed: $e");
      _overlayProcess = null;
      lastLaunchError = null;
      return false;
    }
  }

  static Directory? _findPyOverlayDir() {
    final String? repoRoot = Platform.environment["PAI_REPO_ROOT"]?.trim();
    if (repoRoot != null && repoRoot.isNotEmpty) {
      final Directory fromEnv = Directory("$repoRoot/sphere-overlay-py");
      if (fromEnv.existsSync()) return fromEnv;
    }
    final List<String> seeds = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];

    for (final String seed in seeds) {
      Directory dir = Directory(seed);
      for (int i = 0; i < 15; i++) {
        final Directory candidate = Directory("${dir.path}/sphere-overlay-py");
        if (candidate.existsSync()) {
          return candidate;
        }
        final Directory sibling =
            Directory("${dir.path}${Platform.pathSeparator}sphere-overlay-py");
        if (sibling.existsSync()) {
          return sibling;
        }
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }

  /// 解析启动桌宠的解释器：优先 `.venv/Scripts/python.exe`（Windows），
  /// 无 venv 时回退 PATH 的 `python`。
  static String _resolvePyOverlayPython(Directory overlayDir) {
    final String sep = Platform.pathSeparator;
    final String venvPy =
        "${overlayDir.path}$sep.venv${sep}Scripts${sep}python.exe";
    if (Platform.isWindows && File(venvPy).existsSync()) return venvPy;
    return "python";
  }

  /// 安装包里的桌宠是 PyInstaller 单目录产物，直接跑 exe，不需要本机 Python。
  static File? _frozenOverlayExe(Directory overlayDir) {
    if (!Platform.isWindows) return null;
    final File exe = File(
        "${overlayDir.path}${Platform.pathSeparator}sphere-overlay.exe");
    return exe.existsSync() ? exe : null;
  }

  /// 启动命令：有打包产物走 exe，否则走源码 + .venv。
  static ({String exe, List<String> args})? _overlayLaunchSpec(
      Directory overlayDir) {
    final File? frozen = _frozenOverlayExe(overlayDir);
    if (frozen != null) return (exe: frozen.path, args: const <String>[]);
    final String mainPy = "${overlayDir.path}${Platform.pathSeparator}main.py";
    if (!File(mainPy).existsSync()) return null;
    return (
      exe: _resolvePyOverlayPython(overlayDir),
      args: const <String>["main.py"],
    );
  }

  static String _buildOverlayUrl() {
    final String wsUrl = ApiConfig.wsUrl;
    final String sessionId = ApiConfig.effectiveActorId;

    final Uri base = Uri.parse(ApiConfig.httpBase);
    final String path =
        "${base.path}/chat/assets/avatar/overlay.html".replaceAll("//", "/");

    return Uri(
      scheme: base.scheme,
      host: base.host,
      port: base.port,
      path: path,
      queryParameters: <String, String>{
        "ws": wsUrl,
        if (sessionId.isNotEmpty) "sessionId": sessionId,
      },
    ).toString();
  }

  static Future<void> show() async {
    if (!_created) return;
    if (_overlayProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("show");
      _visible = true;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] show failed: ${e.message}");
    }
  }

  static Future<void> hide() async {
    if (!_created) return;
    if (_overlayProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("hide");
      _visible = false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] hide failed: ${e.message}");
    }
  }

  static Future<void> destroy() async {
    if (_overlayProcess != null || overlayActive.value) {
      final Process? proc = _overlayProcess;
      _overlayProcess = null;
      _created = false;
      _visible = false;
      overlayActive.value = false;
      useEmbeddedFallback.value = false;
      await _shutdownPyOverlay(proc);
      return;
    }
    if (!_created) return;
    try {
      await _channel.invokeMethod<bool>("destroy");
    } catch (e) {
      debugPrint("[SphereOverlay] destroy failed: $e");
    }
    _created = false;
    _visible = false;
    useEmbeddedFallback.value = false;
  }

  /// 关停已在跑的桌宠。先让它自己收尾（Qt 关窗、收 WS 线程），Chromium 子进程
  /// 才不会作为孤儿留在系统里；只有旧版桌宠不认这条指令时才硬杀。
  static Future<void> _shutdownPyOverlay(Process? proc) async {
    final bool accepted = await _sendInstanceCommand("--quit");
    if (!accepted && proc != null) {
      debugPrint("[SphereOverlay] 桌宠未接受退出指令，改为强制结束");
    }
    if (proc == null) return;
    try {
      await proc.exitCode.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      debugPrint("[SphereOverlay] 桌宠未在 2s 内退出，强制结束");
      try {
        proc.kill();
      } catch (_) {}
    }
  }

  static Future<void> moveTo(int x, int y, {int durationMs = 0}) async {
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("moveTo", <String, dynamic>{
        "x": x,
        "y": y,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveTo failed: ${e.message}");
    }
  }

  static Future<void> setBounds(
    int x,
    int y,
    int width,
    int height, {
    int durationMs = 0,
  }) async {
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("setBounds", <String, dynamic>{
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setBounds failed: ${e.message}");
    }
  }

  static Future<Map<String, int>?> getAppBounds() async {
    if (kIsWeb || !Platform.isWindows) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getAppBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getAppBounds failed: ${e.message}");
      return null;
    }
  }

  static Future<Map<String, int>?> getBounds() async {
    if (!_created || _overlayProcess != null) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getBounds failed: ${e.message}");
      return null;
    }
  }

  static Future<void> moveBy(int dx, int dy) async {
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("moveBy", <String, dynamic>{
        "dx": dx,
        "dy": dy,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveBy failed: ${e.message}");
    }
  }

  static Future<void> roam() async {
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("roam");
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] roam failed: ${e.message}");
    }
  }

  static Future<void> setIgnoreMouseEvents(bool ignore,
      {bool forward = true}) async {
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("setIgnoreMouseEvents",
          <String, dynamic>{"ignore": ignore, "forward": forward});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setIgnoreMouseEvents failed: ${e.message}");
    }
  }

  static Future<void> patchMood(AgentSpherePatch patch) async {
    if (kIsWeb || !Platform.isWindows || !_created) {
      return;
    }
    // PySide6 桌宠无 mood 文件轮询机制，patch 统一经 server WS 下发；
    // 独立进程 overlay 的本地情绪由前端直接连接 WS 获取。
    if (overlayActive.value || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("patchMood",
          <String, dynamic>{"patch": jsonEncode(patch.toJson())});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] patchMood failed: ${e.message}");
    }
  }

  static Future<Map<String, int>?> getWorkArea() async {
    if (!_created || _overlayProcess != null) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getWorkArea");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getWorkArea failed: ${e.message}");
      return null;
    }
  }

  static Future<bool> launch({String? repoRoot, bool electron = false}) async {
    if (kIsWeb || !Platform.isWindows) return false;
    await _resyncNativeOverlayState();

    if (_created && electron && overlayActive.value) return true;
    if (_created && !electron && useEmbeddedFallback.value) return true;

    // 旧版原生窗可能残留但 WebView2 已禁用，清掉后走内嵌降级。
    if (_created && !electron && !useEmbeddedFallback.value && !overlayActive.value) {
      await destroy();
    }

    if (electron) {
      return _launchPyOverlay();
    }

    if (_useInProcessOverlay) {
      final bool native = await _createInProcess(overlayUrl: repoRoot);
      if (native) {
        await show();
        if (await waitForWebViewReady(
          timeout: const Duration(seconds: 15),
        )) {
          return true;
        }
        await destroy();
      }
    }

    return _enableEmbeddedFallback();
  }

  static Future<void> stop() => destroy();
}
