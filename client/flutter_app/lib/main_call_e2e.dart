// 通话窗口（Win32 三窗）E2E 截图引导入口。
//
// 不走生产入口 main.dart：仅当构建时把 windows/flutter/ephemeral/
// generated_config.cmake 的 FLUTTER_TARGET 临时改为本文件才启用，
// 日常构建不受影响（下次 flutter 工具运行会重新生成该文件）。
//
// 与 integration_test/phone_call_ui_e2e_test.dart +
// phone_call_e2e_capture.ps1 的哨兵握手协议一致：
//   dart 侧 show 窗口 → PS 侧按窗口类名整窗截图（CopyFromScreen）
//   → 写 .done 哨兵 → dart 侧切下一态。状态进度写 _status.log 便于排障。
//
// 四态截完后恢复「通话中 · talking」态留在屏幕上供人工查看，不自动退出。
import "dart:async";
import "dart:io";

import "package:flutter/material.dart";

import "core/services/connected_call_launcher.dart";
import "core/services/incoming_call_launcher.dart";
import "core/services/outgoing_call_launcher.dart";

/// 哨兵与截图目录（与捕获 PS 脚本一致；刻意不用 Directory.systemTemp，
/// 避免 Git Bash 启动 app 时 TEMP 被污染解析到别处）。
const String _dir = r"D:\ws-project\NextBot\.tmp_shot\pai_call_e2e";

void _log(String msg) {
  final String line = "[${DateTime.now().toIso8601String()}] $msg";
  try {
    File("$_dir\\_status.log")
        .writeAsStringSync("$line\n", mode: FileMode.append);
  } catch (_) {}
  print(line);
}

Future<bool> _waitSentinel(
  String name, {
  Duration budget = const Duration(seconds: 90),
}) async {
  final Stopwatch sw = Stopwatch()..start();
  final File f = File("$_dir\\$name");
  while (sw.elapsed < budget) {
    if (f.existsSync()) return true;
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }
  _log("SENTINEL TIMEOUT: $name");
  return false;
}

Future<void> _sequence() async {
  await Future<void>.delayed(const Duration(seconds: 6)); // 引擎/原生通道就绪

  final Directory dir = Directory(_dir);
  if (!dir.existsSync()) dir.createSync(recursive: true);
  for (final String n in <String>[
    "pai_call_e2e_incoming.done",
    "pai_call_e2e_outgoing.done",
    "pai_call_e2e_connected.done",
    "pai_call_e2e_connected_muted.done",
  ]) {
    final File f = File("$_dir\\$n");
    if (f.existsSync()) f.deleteSync();
  }
  _log("bootstrap start");

  // 1. 来电窗（振铃 + 呼吸头像 + 接听/拒接）
  final bool inOk = await IncomingCallLauncher.show(
    callerName: "林知远",
    subtitle: "Nextbot 私人管家 · 首席顾问",
    ringTimeoutMs: 120000,
  );
  _log("incoming show=$inOk");
  if (!await _waitSentinel("pai_call_e2e_incoming.done")) return;
  await IncomingCallLauncher.hide();
  await Future<void>.delayed(const Duration(milliseconds: 700));

  // 2. 呼出窗（正在呼叫 ···）
  final bool outOk = await OutgoingCallLauncher.show(
    callerName: "林知远",
    subtitle: "正在呼叫",
  );
  _log("outgoing show=$outOk");
  if (!await _waitSentinel("pai_call_e2e_outgoing.done")) return;
  await OutgoingCallLauncher.hide();
  await Future<void>.delayed(const Duration(milliseconds: 700));

  // 3. 通话中窗（talking：光环呼吸 + 波形跳动）
  final bool connOk = await ConnectedCallLauncher.show(callerName: "林知远");
  _log("connected show=$connOk");
  await ConnectedCallLauncher.resetDuration();
  await ConnectedCallLauncher.setSpeaker(true);
  await ConnectedCallLauncher.setTalking(true);
  if (!await _waitSentinel("pai_call_e2e_connected.done")) return;

  // 4. 静音激活态（静音钮白球 + 斜线 + 「已静音 · 计时」）
  await ConnectedCallLauncher.setMute(true);
  if (!await _waitSentinel("pai_call_e2e_connected_muted.done")) return;

  // 截图全部完成：恢复非静音 talking 态，窗口留在屏幕上供人工查看。
  await ConnectedCallLauncher.setMute(false);
  await ConnectedCallLauncher.setTalking(true);
  _log("ALL_CAPTURED");
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const _E2EPlaceholderApp());
  unawaited(_sequence());
}

class _E2EPlaceholderApp extends StatelessWidget {
  const _E2EPlaceholderApp();

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(body: Center(child: Text("PAI call E2E harness"))),
    );
  }
}
