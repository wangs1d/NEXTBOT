import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";
import "desktop_screen_capture.dart";

/// Flutter Windows desktop bridge executor.
class DesktopBridgeService {
  DesktopBridgeService._();

  static final DesktopBridgeService instance = DesktopBridgeService._();

  static const String _bridgeSessionSuffix = "-flutter-bridge";
  static const String _bridgeTokenFromEnv = String.fromEnvironment(
    "DESKTOP_BRIDGE_TOKEN",
  );
  static const Duration _reconnectDelay = Duration(seconds: 4);
  static const Duration _heartbeatInterval = Duration(seconds: 20);
  static const Duration _heartbeatTimeout = Duration(seconds: 45);
  static const Duration _runTaskTimeout = Duration(minutes: 10);

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  bool _connecting = false;
  bool _connected = false;
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);

  final ValueNotifier<bool> bridgeConnected = ValueNotifier<bool>(false);

  bool get isActive => _connected;

  void start() {
    if (!DesktopScreenCapture.isSupported) return;
    if (_connecting || _connected) return;
    _connect();
  }

  void stop() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _channel?.sink.close(1000);
    } catch (_) {}
    _channel = null;
    _connecting = false;
    _connected = false;
    bridgeConnected.value = false;
  }

  void _connect() {
    _connecting = true;
    try {
      final WebSocketChannel ch =
          WebSocketChannel.connect(Uri.parse(ApiConfig.wsUrl));
      _channel = ch;
      _subscription = ch.stream.listen(
        (dynamic data) {
          if (!identical(_channel, ch)) return;
          _lastInboundAt = DateTime.now();
          _onMessage(data);
        },
        onError: (_) => _handleDisconnect(ch),
        onDone: () => _handleDisconnect(ch),
        cancelOnError: false,
      );
      unawaited(
        ch.ready.then((_) {
          if (!identical(_channel, ch)) return;
          _connected = true;
          _connecting = false;
          _lastInboundAt = DateTime.now();
          bridgeConnected.value = true;
          _startHeartbeat(ch);
          _sendSessionInit();
          // 口令模式（服务端配置 DESKTOP_BRIDGE_TOKEN≥8）下，session.init 不会自动
          // 绑定执行器，必须显式发 register 携带 token；无口令模式下这条消息幂等
          // （服务端直接回 ack）。缺这一步服务端 hasExecutor 恒为 false，desktop.*
          // 工具会被当成「桥离线」从规划目录/可见集剔除，"打开XX应用"类任务失能。
          _send("desktop.bridge.register", <String, dynamic>{
            if (_bridgeTokenFromEnv.isNotEmpty) "token": _bridgeTokenFromEnv,
          });
        }).catchError((_) {
          if (!identical(_channel, ch)) return;
          _handleDisconnect(ch);
        }),
      );
    } catch (_) {
      _handleDisconnect(_channel);
    }
  }

  void _handleDisconnect(WebSocketChannel? channel) {
    if (channel != null && !identical(_channel, channel)) return;
    final bool shouldReconnect = _channel != null || _connected || _connecting;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _channel?.sink.close(1000);
    } catch (_) {}
    _channel = null;
    _connecting = false;
    _connected = false;
    bridgeConnected.value = false;
    if (!shouldReconnect) return;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (!DesktopScreenCapture.isSupported) return;
    if (_reconnectTimer != null) return;
    _reconnectTimer = Timer(_reconnectDelay, () {
      _reconnectTimer = null;
      if (!_connected && !_connecting) {
        start();
      }
    });
  }

  void _startHeartbeat(WebSocketChannel channel) {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!identical(_channel, channel)) {
        _stopHeartbeat();
        return;
      }
      if (!_connected) return;
      final Duration idle = DateTime.now().difference(_lastInboundAt);
      if (idle > _heartbeatTimeout) {
        _handleDisconnect(channel);
        return;
      }
      _send("ws.keepalive", <String, dynamic>{
        "clientTime": DateTime.now().toIso8601String(),
      });
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _sendSessionInit() {
    final String actor = ApiConfig.effectiveActorId;
    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": "$actor$_bridgeSessionSuffix",
      "deviceId": "flutter-desktop-bridge",
      "userAlias": "flutter_bridge",
      "desktopBridge": true,
      "userId": actor,
    };
    _send("session.init", payload);
  }

  void _onMessage(dynamic data) {
    final Map<String, dynamic> event =
        jsonDecode(data.toString()) as Map<String, dynamic>;
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        (event["payload"] as Map?)?.cast<String, dynamic>() ??
            <String, dynamic>{};

    if (type == "desktop.bridge.invoke") {
      unawaited(_handleInvoke(payload));
      return;
    }
    if (type == "error.event") {
      debugPrint("[DesktopBridge] error: ${payload["message"]}");
    }
  }

  Future<void> _handleInvoke(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString() ?? "";
    if (jobId.isEmpty) return;

    final String action = payload["action"]?.toString() ?? "run_task";
    Map<String, dynamic> result;

    if (action == "screenshot") {
      result = await _runScreenshot(payload);
    } else if (action == "run_task") {
      result = await _runDesktopVisualTask(payload);
    } else if (action == "run_shell") {
      result = await _runShell(payload);
    } else if (action == "uia_query" ||
        action == "run_input" ||
        action == "run_automation" ||
        action == "open" ||
        action == "show_message" ||
        action == "window" ||
        action == "clipboard") {
      // window / clipboard / run_automation 是手机端「我的电脑」页要用的原子动作
      // （换窗口、剪贴板互传、按控件直调），Python stdio_worker 早已实现，
      // 此前只是 Flutter 执行端未放行，故一并归入通用转发分支。
      result = await _runWorkerAction(payload);
    } else {
      result = <String, dynamic>{
        "ok": false,
        "error": "Flutter desktop bridge does not support action=$action",
      };
    }

    _send(
        "desktop.bridge.result", <String, dynamic>{"jobId": jobId, ...result});
  }

  Future<Map<String, dynamic>> _runScreenshot(
      Map<String, dynamic> payload) async {
    final List<int>? region = _parseRegion(payload["region"]);
    final Map<String, dynamic> cap =
        await DesktopScreenCapture.capture(region: region);
    if (cap["ok"] != true) {
      return <String, dynamic>{
        "ok": false,
        "error": cap["error"]?.toString() ?? "Screenshot failed",
      };
    }

    return <String, dynamic>{
      "ok": true,
      "imageBase64": cap["imageBase64"],
      "mimeType": cap["mimeType"] ?? "image/png",
      "width": cap["width"],
      "height": cap["height"],
      "capturedAt": DateTime.now().toUtc().toIso8601String(),
    };
  }

  Future<Map<String, dynamic>> _runDesktopVisualTask(
    Map<String, dynamic> payload,
  ) async {
    if (!Platform.isWindows) {
      return <String, dynamic>{
        "ok": false,
        "error": "run_task is only supported on Windows desktop",
      };
    }

    final String task = payload["task"]?.toString().trim() ?? "";
    if (task.isEmpty) {
      return <String, dynamic>{
        "ok": false,
        "error": "missing task",
      };
    }

    final _DesktopVisualRuntime? runtime = _resolveDesktopVisualRuntime();
    if (runtime == null) {
      return <String, dynamic>{
        "ok": false,
        "error":
            "desktop-visual runtime not found; please ensure desktop-visual and its .venv are available",
      };
    }

    final Map<String, dynamic> workerPayload = <String, dynamic>{
      "action": "run_task",
      "task": task,
      "maxSteps": _parseMaxSteps(payload["maxSteps"]),
      "region": _parseRegion(payload["region"]),
      "stub": payload["stub"] == true,
    };
    final dynamic vlm = payload["vlm"];
    if (vlm is Map) {
      workerPayload["vlm"] = vlm.cast<String, dynamic>();
    }

    try {
      final Process proc = await Process.start(
        runtime.pythonExe,
        <String>["-u", "-m", "desktop_visual.stdio_worker"],
        workingDirectory: runtime.packageRoot,
        environment: runtime.environment,
        runInShell: false,
        includeParentEnvironment: true,
      );
      final String stdinPayload = "${jsonEncode(workerPayload)}\n";
      final Future<String> stdoutFuture =
          proc.stdout.transform(utf8.decoder).join();
      final Future<String> stderrFuture =
          proc.stderr.transform(utf8.decoder).join();
      proc.stdin.write(stdinPayload);
      await proc.stdin.flush();
      await proc.stdin.close();

      final int exitCode = await proc.exitCode.timeout(
        _runTaskTimeout,
        onTimeout: () {
          proc.kill(ProcessSignal.sigterm);
          throw TimeoutException("desktop_visual worker timed out");
        },
      );
      final String stdoutText = (await stdoutFuture).trim();
      final String stderrText = (await stderrFuture).trim();

      if (exitCode != 0) {
        return <String, dynamic>{
          "ok": false,
          "error": stderrText.isNotEmpty
              ? stderrText
              : "desktop_visual worker exited with code $exitCode",
        };
      }
      if (stdoutText.isEmpty) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned empty stdout",
        };
      }

      final String jsonLine = stdoutText.split(RegExp(r"\r?\n")).last.trim();
      final dynamic decoded = jsonDecode(jsonLine);
      if (decoded is! Map) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned invalid JSON",
        };
      }
      return decoded.cast<String, dynamic>();
    } on TimeoutException {
      return <String, dynamic>{
        "ok": false,
        "error":
            "desktop_visual worker timed out after ${_runTaskTimeout.inMinutes} minutes",
      };
    } on ProcessException catch (e) {
      return <String, dynamic>{
        "ok": false,
        "error": e.message,
      };
    } catch (e) {
      return <String, dynamic>{
        "ok": false,
        "error": e.toString(),
      };
    }
  }

  // -- desktop.run_shell：把请求透传给本地 Python stdio_worker（不动 run_shell 策略，
  //    策略由 Python 端的 shell_policy.py 统一执行；这里只做参数解析 + 子进程调度）
  Future<Map<String, dynamic>> _runShell(Map<String, dynamic> payload) async {
    final String command = payload["command"]?.toString().trim() ?? "";
    if (command.isEmpty) {
      return <String, dynamic>{"ok": false, "error": "missing command"};
    }
    if (!Platform.isWindows) {
      return <String, dynamic>{
        "ok": false,
        "error": "run_shell is only supported on Windows desktop",
      };
    }

    final _DesktopVisualRuntime? runtime = _resolveDesktopVisualRuntime();
    if (runtime == null) {
      return <String, dynamic>{
        "ok": false,
        "error":
            "desktop-visual runtime not found; please ensure desktop-visual and its .venv are available",
      };
    }

    final int timeoutMs = _parseShellTimeout(payload["timeoutMs"]);
    final Map<String, dynamic> workerPayload = <String, dynamic>{
      "action": "run_shell",
      "command": command,
      "shell": payload["shell"],
      "cwd": payload["cwd"],
      "timeoutMs": timeoutMs,
      "allowDestructive": payload["allowDestructive"] == true,
    };

    try {
      final Process proc = await Process.start(
        runtime.pythonExe,
        <String>["-u", "-m", "desktop_visual.stdio_worker"],
        workingDirectory: runtime.packageRoot,
        environment: runtime.environment,
        runInShell: false,
        includeParentEnvironment: true,
      );
      proc.stdin.write("${jsonEncode(workerPayload)}\n");
      await proc.stdin.flush();
      await proc.stdin.close();

      final Future<String> stdoutFuture =
          proc.stdout.transform(utf8.decoder).join();
      final Future<String> stderrFuture =
          proc.stderr.transform(utf8.decoder).join();
      final int exitCode = await proc.exitCode.timeout(
        Duration(milliseconds: timeoutMs + 5000),
        onTimeout: () {
          proc.kill(ProcessSignal.sigterm);
          throw TimeoutException("desktop_visual run_shell timed out");
        },
      );
      final String stdoutText = (await stdoutFuture).trim();
      final String stderrText = (await stderrFuture).trim();

      if (exitCode != 0 && stdoutText.isEmpty) {
        return <String, dynamic>{
          "ok": false,
          "error": stderrText.isNotEmpty
              ? stderrText
              : "desktop_visual worker exited with code $exitCode",
        };
      }
      if (stdoutText.isEmpty) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned empty stdout",
        };
      }
      final String jsonLine = stdoutText.split(RegExp(r"\r?\n")).last.trim();
      final dynamic decoded = jsonDecode(jsonLine);
      if (decoded is! Map) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned invalid JSON",
        };
      }
      return decoded.cast<String, dynamic>();
    } on TimeoutException {
      return <String, dynamic>{
        "ok": false,
        "error":
            "desktop_visual run_shell timed out after ${(timeoutMs / 1000).toStringAsFixed(0)}s",
      };
    } on ProcessException catch (e) {
      return <String, dynamic>{"ok": false, "error": e.message};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": e.toString()};
    }
  }

  // -- 通用 worker action 转发：uia_query / run_input / open / show_message
  //    Python stdio_worker 已支持这些 action,Flutter 端只需透传 payload 即可。
  Future<Map<String, dynamic>> _runWorkerAction(
      Map<String, dynamic> payload) async {
    if (!Platform.isWindows) {
      return <String, dynamic>{
        "ok": false,
        "error": "${payload["action"]} is only supported on Windows desktop",
      };
    }

    final _DesktopVisualRuntime? runtime = _resolveDesktopVisualRuntime();
    if (runtime == null) {
      return <String, dynamic>{
        "ok": false,
        "error":
            "desktop-visual runtime not found; please ensure desktop-visual and its .venv are available",
      };
    }

    // 透传 payload(去掉 jobId),Python worker 根据 action 字段自行分发
    final Map<String, dynamic> workerPayload = Map<String, dynamic>.from(payload);
    workerPayload.remove("jobId");

    try {
      final Process proc = await Process.start(
        runtime.pythonExe,
        <String>["-u", "-m", "desktop_visual.stdio_worker"],
        workingDirectory: runtime.packageRoot,
        environment: runtime.environment,
        runInShell: false,
        includeParentEnvironment: true,
      );
      proc.stdin.write("${jsonEncode(workerPayload)}\n");
      await proc.stdin.flush();
      await proc.stdin.close();

      final Future<String> stdoutFuture =
          proc.stdout.transform(utf8.decoder).join();
      final Future<String> stderrFuture =
          proc.stderr.transform(utf8.decoder).join();
      final int exitCode = await proc.exitCode.timeout(
        const Duration(seconds: 40),
        onTimeout: () {
          proc.kill(ProcessSignal.sigterm);
          throw TimeoutException("desktop_visual worker timed out");
        },
      );
      final String stdoutText = (await stdoutFuture).trim();
      final String stderrText = (await stderrFuture).trim();

      if (exitCode != 0 && stdoutText.isEmpty) {
        return <String, dynamic>{
          "ok": false,
          "error": stderrText.isNotEmpty
              ? stderrText
              : "desktop_visual worker exited with code $exitCode",
        };
      }
      if (stdoutText.isEmpty) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned empty stdout",
        };
      }
      final String jsonLine =
          stdoutText.split(RegExp(r"\r?\n")).last.trim();
      final dynamic decoded = jsonDecode(jsonLine);
      if (decoded is! Map) {
        return <String, dynamic>{
          "ok": false,
          "error": "desktop_visual worker returned invalid JSON",
        };
      }
      return decoded.cast<String, dynamic>();
    } on TimeoutException {
      return <String, dynamic>{
        "ok": false,
        "error": "desktop_visual worker timed out after 40s",
      };
    } on ProcessException catch (e) {
      return <String, dynamic>{"ok": false, "error": e.message};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": e.toString()};
    }
  }

  int _parseShellTimeout(dynamic raw) {
    if (raw is num) {
      return raw.round().clamp(1000, 300000);
    }
    return 30000;
  }

  int _parseMaxSteps(dynamic raw) {
    if (raw is num) {
      return raw.round().clamp(1, 120);
    }
    return 40;
  }

  List<int>? _parseRegion(dynamic rawRegion) {
    if (rawRegion is List && rawRegion.length == 4) {
      return rawRegion
          .map((dynamic e) => e is num ? e.round() : 0)
          .toList(growable: false);
    }
    return null;
  }

  _DesktopVisualRuntime? _resolveDesktopVisualRuntime() {
    final String? envPython =
        Platform.environment["DESKTOP_VISUAL_PYTHON"]?.trim();
    final List<String> seeds = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];

    for (final String seed in seeds) {
      Directory dir = Directory(seed);
      for (int i = 0; i < 10; i++) {
        final Directory candidate =
            Directory("${dir.path}${Platform.pathSeparator}desktop-visual");
        if (candidate.existsSync()) {
          final String packageRoot = candidate.path;
          final String bundledPython =
              "$packageRoot\\.venv\\Scripts\\python.exe";
          final String pythonExe = File(bundledPython).existsSync()
              ? bundledPython
              : ((envPython != null && envPython.isNotEmpty)
                  ? envPython
                  : "python");
          return _DesktopVisualRuntime(
            packageRoot: packageRoot,
            pythonExe: pythonExe,
            environment: <String, String>{
              ...Platform.environment,
              "PYTHONUNBUFFERED": "1",
            },
          );
        }
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }

  void _send(String type, Map<String, dynamic> payload) {
    final WebSocketChannel? ch = _channel;
    if (ch == null) return;
    try {
      ch.sink
          .add(jsonEncode(<String, dynamic>{"type": type, "payload": payload}));
    } catch (e) {
      debugPrint("[DesktopBridge] send failed: $e");
    }
  }
}

class _DesktopVisualRuntime {
  const _DesktopVisualRuntime({
    required this.packageRoot,
    required this.pythonExe,
    required this.environment,
  });

  final String packageRoot;
  final String pythonExe;
  final Map<String, String> environment;
}
