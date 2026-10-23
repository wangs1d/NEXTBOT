// 开机自启真机链路测试（真实进程 → MethodChannel → C++ → HKCU 注册表）。
//
// 运行（需 Windows 桌面）：
//   flutter test integration_test/app_auto_start_e2e_test.dart -d windows
//
// 等价于「不重启的虚拟开机自启测试」：
//  1. setEnabled(true)  → Run 键出现 Nextbot 值，REG_SZ，内容为带引号的
//                          当前 exe 完整路径，且该路径真实存在；
//  2. isEnabled()       → true（原生查询链路）；
//  3. setEnabled(false) × 2 → 值被删且幂等（第二次删不存在的值仍成功）；
//  4. 结束后把注册表恢复到测试前状态（有值还原原值，无值保持无值）。
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:nextbot/core/services/app_auto_start.dart";

const String _regPath =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const String _valueName = "Nextbot";

Future<ProcessResult> _regQuery() => Process.run("reg", <String>[
      "query",
      _regPath,
      "/v",
      _valueName,
    ]);

Future<String?> _readRawValue() async {
  final ProcessResult r = await _regQuery();
  if (r.exitCode != 0) return null;
  // reg 输出多行且带换行结尾：必须 multiLine，否则 $ 匹配不到任何行。
  final RegExpMatch? m = RegExp(r"REG_SZ\s+(.+)$", multiLine: true)
      .firstMatch((r.stdout as String).trim());
  return m?.group(1)?.trim();
}

void main() {
  final IntegrationTestWidgetsFlutterBinding binding =
      IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.defaultTestTimeout = const Timeout(Duration(minutes: 5));

  testWidgets("开机自启：注册表写入/查询/删除全链路", (WidgetTester tester) async {
    final String original = await _readRawValue() ?? "";
    final bool hadOriginal = (await _readRawValue()) != null;
    addTearDown(() async {
      if (hadOriginal) {
        await Process.run("reg", <String>[
          "add", _regPath, "/v", _valueName, "/t", "REG_SZ", "/d", original, "/f",
        ]);
      } else {
        await Process.run("reg", <String>[
          "delete", _regPath, "/v", _valueName, "/f",
        ]);
      }
    });

    // 1. 开启 → 注册表真出现值，且指向真实存在的 exe。
    expect(await AppAutoStart.setEnabled(true), isTrue,
        reason: "setEnabled(true) 应写注册表成功");
    final String? raw = await _readRawValue();
    expect(raw, isNotNull, reason: "Run 键应出现 $_valueName 值");
    expect(raw!.startsWith('"') && raw.endsWith('"'), isTrue,
        reason: "路径应带引号包裹（兼容空格），实际：$raw");
    final String exePath = raw.substring(1, raw.length - 1);
    expect(File(exePath).existsSync(), isTrue,
        reason: "注册的 exe 应真实存在：$exePath");

    // 2. 原生查询链路应读到 true。
    expect(await AppAutoStart.isEnabled(), isTrue);

    // 3. 关闭 → 值删除；重复关闭幂等。
    expect(await AppAutoStart.setEnabled(false), isTrue);
    expect(await AppAutoStart.setEnabled(false), isTrue,
        reason: "删除不存在的值应幂等成功");
    expect(await _readRawValue(), isNull, reason: "关闭后 Run 键应无此值");

    // 4. 查询链路应读到 false。
    expect(await AppAutoStart.isEnabled(), isFalse);
  });
}
