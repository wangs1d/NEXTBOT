// 电话弹窗（Win32 三窗口）真机 UI E2E：真实 Windows 进程 + 真实 MethodChannel
// → 真实原生悬浮窗。窗口不在 Flutter 树内，截图由外部 PowerShell 脚本按窗口
// 类名整窗截屏（CopyFromScreen，见 phone_call_e2e_capture.ps1），以哨兵文件
// 握手切态。
//
// 运行（两个终端，或先后台起截图脚本再跑测试）：
//   powershell -File integration_test/phone_call_e2e_capture.ps1   # 先起
//   flutter test integration_test/phone_call_ui_e2e_test.dart -d windows
//
// 顺序：
//   1. 来电窗   IncomingCallLauncher.show(林知远 · 首席顾问) → 截图 → hide
//   2. 呼出窗   OutgoingCallLauncher.show(正在呼叫)           → 截图 → hide
//   3. 通话中窗 ConnectedCallLauncher.show + setTalking(true) → 截图
//   4. setMute(true) 静音激活态                               → 截图 → hide
import "dart:io" show File;

import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:nextbot/core/services/connected_call_launcher.dart";
import "package:nextbot/core/services/incoming_call_launcher.dart";
import "package:nextbot/core/services/outgoing_call_launcher.dart";

const String _tmp = r"C:\Users\Administrator\AppData\Local\Temp";

Future<void> _waitForSentinel(String name) async {
  final Stopwatch sw = Stopwatch()..start();
  // 首跑伴随完整 flutter build（约 1 分钟+），等待预算要足够大
  while (sw.elapsed < const Duration(seconds: 180)) {
    if (File("$_tmp\\$name").existsSync()) return;
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }
  fail("sentinel timeout: $name");
}

void _clear(String name) {
  final File f = File("$_tmp\\$name");
  if (f.existsSync()) f.deleteSync();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets("电话弹窗三态真机取证", (WidgetTester tester) async {
    const List<String> sentinels = <String>[
      "pai_call_e2e_incoming.done",
      "pai_call_e2e_outgoing.done",
      "pai_call_e2e_connected.done",
      "pai_call_e2e_connected_muted.done",
    ];
    for (final String n in sentinels) {
      _clear(n);
    }

    // 1. 来电窗（振铃 + 呼吸头像 + 接听/拒接）
    final bool incomingOk = await IncomingCallLauncher.show(
      callerName: "林知远",
      subtitle: "Nextbot 私人管家 · 首席顾问",
      ringTimeoutMs: 120000,
    );
    expect(incomingOk, isTrue, reason: "来电窗未弹出（原生 show 失败）");
    await _waitForSentinel(sentinels[0]);
    await IncomingCallLauncher.hide();
    await Future<void>.delayed(const Duration(milliseconds: 700));

    // 2. 呼出窗（正在呼叫 ···）
    final bool outgoingOk = await OutgoingCallLauncher.show(
      callerName: "林知远",
      subtitle: "正在呼叫",
    );
    expect(outgoingOk, isTrue, reason: "呼出窗未弹出（原生 show 失败）");
    await _waitForSentinel(sentinels[1]);
    await OutgoingCallLauncher.hide();
    await Future<void>.delayed(const Duration(milliseconds: 700));

    // 3. 通话中窗（talking：光环呼吸 + 波形跳动）
    final bool connectedOk = await ConnectedCallLauncher.show(
      callerName: "林知远",
    );
    expect(connectedOk, isTrue, reason: "通话中窗未弹出（原生 show 失败）");
    await ConnectedCallLauncher.resetDuration();
    await ConnectedCallLauncher.setSpeaker(true);
    await ConnectedCallLauncher.setTalking(true);
    await _waitForSentinel(sentinels[2]);

    // 4. 静音激活态（静音钮白球 + 斜线 + 「已静音 · 计时」）
    await ConnectedCallLauncher.setMute(true);
    await _waitForSentinel(sentinels[3]);

    await ConnectedCallLauncher.setMute(false);
    await ConnectedCallLauncher.setTalking(false);
    await ConnectedCallLauncher.hide();
    await IncomingCallLauncher.hide();
    await OutgoingCallLauncher.hide();
  });
}
