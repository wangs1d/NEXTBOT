import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart"
    show ChangeNotifier, debugPrint, visibleForTesting;
import "package:http/http.dart" as http;

/// ZCode 式一键更新的应用内下载与静默安装编排。
///
/// 流程：点「立即升级」→ 流式下载安装包到 %LOCALAPPDATA%\Nextbot\update
/// （.part 落盘、完成后原子改名；目录里已有同尺寸成品直接复用不重下）→
/// 用户点「重启完成更新」→ 写 apply_update.cmd（等当前进程退出 → 安装器
/// /VERYSILENT 覆盖安装 → 拉起新版）→ spawn 分离进程执行 → 本应用 exit(0)。
///
/// 安装器侧职责（installer/nextbot.iss 已预埋，勿在客户端重复做）：
/// `PrepareToInstall` 按路径限定 kill 残留 runtime/node 进程（本地 runtime
/// 常驻复用、应用退出不杀，其文件锁由安装器清）；`[Run] skipifsilent`
/// 保证静默安装不会自动拉起造成双开，重启由 cmd 脚本负责。
enum ClientUpdatePhase { idle, downloading, downloaded, launching, failed }

class ClientUpdateFlowController extends ChangeNotifier {
  ClientUpdateFlowController({
    required String downloadUrl,
    required String version,
    http.Client? httpClient,
    Directory? storageDir,
  }) : _downloadUrl = downloadUrl,
       _version = version,
       _httpClient = httpClient ?? http.Client(),
       _storageDirOverride = storageDir;

  final String _downloadUrl;
  final String _version;
  final http.Client _httpClient;
  final Directory? _storageDirOverride;

  ClientUpdatePhase _phase = ClientUpdatePhase.idle;
  int _received = 0;
  int? _total;
  String? _error;
  String? _installerPath;
  StreamSubscription<List<int>>? _bodySub;
  Completer<void>? _bodyDone;
  IOSink? _sink;
  bool _cancelRequested = false;
  DateTime _lastNotify = DateTime.fromMillisecondsSinceEpoch(0);

  ClientUpdatePhase get phase => _phase;
  int get received => _received;
  int? get total => _total;
  String? get error => _error;

  /// 0.0~1.0；total 未知（chunked）时为 null
  double? get progress =>
      _total == null || _total == 0 ? null : _received / _total!;

  /// 更新包暂存目录（测试可注入临时目录）
  Directory get _updateDir => _storageDirOverride ?? resolveUpdateDirectory();

  /// 开始/重试下载。downloading/launching 中忽略重复触发。
  Future<void> begin() async {
    if (_phase == ClientUpdatePhase.downloading ||
        _phase == ClientUpdatePhase.launching) {
      return;
    }
    if (!Platform.isWindows) {
      _fail("仅在 Windows 上支持应用内更新");
      return;
    }
    _cancelRequested = false;
    _error = null;
    _received = 0;
    _total = null;
    _phase = ClientUpdatePhase.downloading;
    _notifyNow();
    try {
      _installerPath = await _download();
      _phase = ClientUpdatePhase.downloaded;
      _notifyNow();
    } catch (e) {
      if (_cancelRequested) {
        _phase = ClientUpdatePhase.idle;
        _notifyNow();
      } else {
        debugPrint("[update-flow] download failed: $e");
        _fail("下载失败：网络异常或服务不可用");
      }
    }
  }

  /// 用户取消（下载中→回到待升级；已下载→放弃成品回 idle）。
  Future<void> cancel() async {
    if (_phase != ClientUpdatePhase.downloading &&
        _phase != ClientUpdatePhase.downloaded) {
      return;
    }
    _cancelRequested = true;
    await _bodySub?.cancel();
    // 唤醒还挂在流结束上的 begin()，否则取消后永远停在 downloading
    final Completer<void>? done = _bodyDone;
    if (done != null && !done.isCompleted) {
      done.completeError(const _CancelledUpdateException());
    }
    _bodyDone = null;
    await _closeSink();
    final File? part = _partFile();
    if (part != null && part.existsSync()) {
      try {
        part.deleteSync();
      } catch (_) {}
    }
    _phase = ClientUpdatePhase.idle;
    _received = 0;
    _total = null;
    _notifyNow();
  }

  /// 「重启完成更新」：写 cmd → 分离执行 → 本应用退出。脚本职责：
  /// 等当前 PID 退出 → 安装器静默覆盖安装 → 拉起新版 exe。
  Future<void> restartToUpdate() async {
    final String? installer = _installerPath;
    if (installer == null ||
        _phase != ClientUpdatePhase.downloaded ||
        !Platform.isWindows) {
      return;
    }
    _phase = ClientUpdatePhase.launching;
    _notifyNow();
    try {
      final Directory dir = _updateDir;
      final File script = File(
        "${dir.path}${Platform.pathSeparator}apply_update.cmd",
      );
      script.writeAsStringSync(kApplyUpdateScript, flush: true);
      final String appExe = Platform.resolvedExecutable;
      // detach：本进程 exit(0) 不得带走脚本；脚本再负责拉起新版
      await Process.start("cmd.exe", <String>[
        "/c",
        script.path,
        pid.toString(),
        installer,
        appExe,
      ], mode: ProcessStartMode.detached);
      // 给 spawn 留出落盘/调度时间再退
      await Future<void>.delayed(const Duration(milliseconds: 400));
      exit(0);
    } catch (e) {
      debugPrint("[update-flow] restart-to-update failed: $e");
      _fail("启动安装失败，请重试");
    }
  }

  @override
  void dispose() {
    _cancelRequested = true;
    _bodySub?.cancel();
    _closeSink();
    super.dispose();
  }

  void _fail(String message) {
    _phase = ClientUpdatePhase.failed;
    _error = message;
    _notifyNow();
  }

  File? _partFile() {
    final String? name = _targetFileName();
    if (name == null) return null;
    final Directory dir = _updateDir;
    final File part = File(
      "${dir.path}${Platform.pathSeparator}$name.part",
    );
    return part;
  }

  String? _targetFileName() {
    final Uri? uri = Uri.tryParse(_downloadUrl);
    final String? last = uri?.pathSegments.isNotEmpty == true
        ? uri!.pathSegments.last
        : null;
    if (last != null && last.toLowerCase().endsWith(".exe")) {
      return Uri.decodeComponent(last);
    }
    return "Nextbot-Setup-$_version.exe";
  }

  Future<String> _download() async {
    final Directory dir = _updateDir..createSync(recursive: true);
    final String name = _targetFileName()!;
    final File finalFile = File("${dir.path}${Platform.pathSeparator}$name");
    final File partFile = File("${finalFile.path}.part");
    final Uri uri = Uri.parse(_downloadUrl);

    // 成品复用：HEAD 拿 Content-Length，与已有成品等长即不重下（升级失败
    // 重开应用再点的场景不重复消耗流量）。
    int? contentLength;
    try {
      final http.Response head = await _httpClient
          .head(uri)
          .timeout(const Duration(seconds: 10));
      contentLength = int.tryParse(head.headers["content-length"] ?? "");
    } catch (_) {
      // HEAD 失败不阻塞下载
    }
    if (contentLength != null &&
        finalFile.existsSync() &&
        finalFile.lengthSync() == contentLength) {
      return finalFile.path;
    }
    if (partFile.existsSync()) {
      try {
        partFile.deleteSync();
      } catch (_) {}
    }

    final http.StreamedResponse res = await _httpClient
        .send(http.Request("GET", uri))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw HttpException("HTTP ${res.statusCode}");
    }
    contentLength ??= res.contentLength;
    _total = contentLength;

    final IOSink sink = partFile.openWrite();
    _sink = sink;
    final Completer<void> done = Completer<void>();
    _bodyDone = done;
    _bodySub = res.stream.listen(
      (List<int> chunk) {
        sink.add(chunk);
        _received += chunk.length;
        _notifyThrottled();
      },
      onDone: () {
        if (!done.isCompleted) done.complete();
      },
      onError: (Object e) {
        if (!done.isCompleted) done.completeError(e);
      },
      cancelOnError: true,
    );
    try {
      await done.future;
      _bodyDone = null;
      await _closeSink();
    } catch (e) {
      _bodyDone = null;
      await _closeSink();
      // 取消路径的 .part 清理由 cancel() 负责，这里不重复动
      if (!_cancelRequested) {
        try {
          if (partFile.existsSync()) partFile.deleteSync();
        } catch (_) {}
      }
      rethrow;
    }
    partFile.renameSync(finalFile.path);
    _purgeOtherInstallers(dir, keepName: name);
    return finalFile.path;
  }

  Future<void> _closeSink() async {
    final IOSink? sink = _sink;
    _sink = null;
    try {
      await sink?.close();
    } catch (_) {}
  }

  /// 清掉旧版本安装包，只留本次目标（防止 update 目录无限膨胀）
  void _purgeOtherInstallers(Directory dir, {required String keepName}) {
    try {
      for (final FileSystemEntity e in dir.listSync()) {
        final String base = e.path.split(Platform.pathSeparator).last;
        if (base == keepName || base == "apply_update.cmd") continue;
        if (base.toLowerCase().endsWith(".exe") ||
            base.toLowerCase().endsWith(".part")) {
          e.deleteSync();
        }
      }
    } catch (_) {}
  }

  /// 进度回调高频，节流到 ~100ms 一次；起止两态强制即时刷
  void _notifyThrottled() {
    final DateTime now = DateTime.now();
    if (now.difference(_lastNotify).inMilliseconds < 100) return;
    _notifyAt(now);
  }

  void _notifyNow() => _notifyAt(DateTime.now());

  void _notifyAt(DateTime now) {
    _lastNotify = now;
    notifyListeners();
  }

  /// apply_update.cmd 内容：参数经 %1~%3 传入（当前 PID / 安装包 / 应用 exe），
  /// 避免把带空格路径拼进脚本体的转义坑。等退出的轮询用 ping 而非 timeout
  /// ——detached 无控制台时 timeout 会因读不到输入立即失败、循环空转。
  @visibleForTesting
  static final String kApplyUpdateScript = <String>[
    "@echo off",
    "rem Nextbot 静默更新：等应用退出 → 覆盖安装 → 拉起新版",
    ":waitloop",
    "tasklist /FI \"PID eq %1\" 2>NUL | find \"%1\" >NUL",
    "if not errorlevel 1 (",
    "  ping -n 2 127.0.0.1 >NUL",
    "  goto waitloop",
    ")",
    "\"%2\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS",
    "start \"\" \"%3\"",
    "",
  ].join("\r\n");
}

/// cancel() 唤醒挂起的 begin() 用；begin 捕获后按 _cancelRequested 分流
class _CancelledUpdateException implements Exception {
  const _CancelledUpdateException();
}

/// 更新包暂存目录：%LOCALAPPDATA%\Nextbot\update（按用户装、免 UAC 可写）
Directory resolveUpdateDirectory() {
  final String? localAppData = Platform.environment["LOCALAPPDATA"];
  final String root = (localAppData != null && localAppData.isNotEmpty)
      ? localAppData
      : Directory.systemTemp.path;
  return Directory("$root${Platform.pathSeparator}Nextbot"
      "${Platform.pathSeparator}update");
}
