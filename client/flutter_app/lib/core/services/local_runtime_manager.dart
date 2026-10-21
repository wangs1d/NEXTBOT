import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;

import "local_runtime_config.dart";

/// byok 捆绑形态的本地 runtime 生命周期管理：
/// 探测 health → 用捆绑的 runtime\node.exe 拉起 dist/index.js（注入用户
/// config.env）→ 轮询就绪。runtime 常驻复用（应用退出不杀，二次启动免等待；
/// 升级时由安装器统一停进程）。
///
/// 开发/非捆绑形态（exe 旁无 runtime\node.exe）直接跳过，沿用手工起服务的联调流程。
class LocalRuntimeManager {
  LocalRuntimeManager._();

  static Process? _process;

  /// exe 同级的 runtime 目录（安装布局：PrivateAgent.exe + runtime\node.exe）。
  static String? get _exeDir {
    final String exe = Platform.resolvedExecutable;
    final int idx = exe.lastIndexOf(Platform.pathSeparator);
    if (idx <= 0) return null;
    return exe.substring(0, idx);
  }

  static bool get isBundled {
    if (!Platform.isWindows) return false;
    final String? dir = _exeDir;
    if (dir == null) return false;
    final String node = "$dir${Platform.pathSeparator}runtime"
        "${Platform.pathSeparator}node.exe";
    final String server = "$dir${Platform.pathSeparator}runtime"
        "${Platform.pathSeparator}dist${Platform.pathSeparator}index.js";
    return File(node).existsSync() && File(server).existsSync();
  }

  static bool get isHealthyNow => _process != null || _lastHealthOk;

  static bool _lastHealthOk = false;

  /// runtime 输出落盘（与 config.env 同目录）。release 下 debugPrint 不可见，
  /// 用户机器上排查"后端没起来"全靠这个文件；超 1MB 整体截断防无限增长。
  static File get _logFile {
    final String appData =
        Platform.environment["APPDATA"] ?? Directory.systemTemp.path;
    return File("$appData${Platform.pathSeparator}PrivateAgent"
        "${Platform.pathSeparator}runtime.log");
  }

  static void _log(String line) {
    try {
      final File f = _logFile;
      if (f.existsSync() && f.lengthSync() > 1 << 20) {
        f.writeAsStringSync("");
      }
      final String ts = DateTime.now().toIso8601String();
      f.writeAsStringSync("[$ts] $line\n", mode: FileMode.append);
    } catch (_) {
      // 日志失败不影响主流程
    }
  }

  static Future<bool> probeHealth({Duration timeout = const Duration(milliseconds: 900)}) async {
    try {
      final http.Response res = await http
          .get(Uri.parse("http://127.0.0.1:3000/api/client/manifest"))
          .timeout(timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 确保 runtime 在跑：已在 → 直接返回 true；否则拉起并轮询 health 就绪。
  /// 超时返回 false（应用照常启动，WS 层会重试，不影响界面）。
  static Future<bool> ensureRunning({
    // 实测：本机 SSD 冷启动 ~6s，零配置首启（无 config.env）~16.2s；
    // 低端机 + 冷磁盘 + onnxruntime/bge 装载很容易再翻倍。原 25s 太贴脸，
    // 超时后应用照常起来但后端还没监听，用户只看到「连不上」且无任何提示。
    Duration readyTimeout = const Duration(seconds: 45),
  }) async {
    if (!isBundled) return true;
    if (await probeHealth()) {
      _lastHealthOk = true;
      return true;
    }
    final String dir = _exeDir!;
    final String runtimeDir =
        "$dir${Platform.pathSeparator}runtime";
    final String node = "$runtimeDir${Platform.pathSeparator}node.exe";
    final String server =
        "$runtimeDir${Platform.pathSeparator}dist${Platform.pathSeparator}index.js";
    try {
      // 用户 config.env 注入子进程环境；server 侧 dotenv 不覆盖已有变量，
      // 因此这里的值始终生效（server 零改动）。
      final Map<String, String> env = <String, String>{
        ...Platform.environment,
        ...LocalRuntimeConfig.readSync(),
        "FUNASR_AUTO_START": "0",
      };
      _process = await Process.start(
        node,
        <String>[server],
        workingDirectory: runtimeDir,
        environment: env,
        mode: ProcessStartMode.detachedWithStdio,
      );
      _log("spawn: $node $server");
      _process!.stdout
          .cast<List<int>>()
          .transform(systemEncoding.decoder)
          .listen((String line) {
        debugPrint("[runtime] $line");
        _log(line);
      });
      _process!.stderr
          .cast<List<int>>()
          .transform(systemEncoding.decoder)
          .listen((String line) {
        debugPrint("[runtime][err] $line");
        _log("[err] $line");
      });
    } catch (e) {
      debugPrint("[runtime] spawn failed: $e");
      _log("spawn failed: $e");
      return false;
    }
    final Deadline deadline = Deadline(readyTimeout);
    while (!deadline.isPassed) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      if (await probeHealth()) {
        _lastHealthOk = true;
        return true;
      }
    }
    debugPrint("[runtime] health not ready within $readyTimeout");
    _log("health not ready within $readyTimeout");
    return false;
  }

  /// 用户改了 config.env（如首启填 key）后重启 runtime 使其生效。
  static Future<bool> restart() async {
    if (!isBundled) return true;
    try {
      _process?.kill();
    } catch (_) {}
    _process = null;
    // 等端口释放
    for (int i = 0; i < 10; i++) {
      if (!await probeHealth(timeout: const Duration(milliseconds: 400))) break;
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
    return ensureRunning();
  }
}

class Deadline {
  Deadline(this.timeout) : _end = DateTime.now().add(timeout);
  final Duration timeout;
  final DateTime _end;
  bool get isPassed => DateTime.now().isAfter(_end);
}
