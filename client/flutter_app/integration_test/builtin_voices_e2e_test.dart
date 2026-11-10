import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:nextbot/features/alarm/alarm_platform.dart";

/// 端侧实测：APK 内置的三个保留音色（#1 diana / #6 anna / #2 alex）。
/// 逐个调用生产入口 testBuiltinVoice，走完整响铃链路：
///   Dart MethodChannel → AlarmClockPlugin.resolveBuiltinVoice(assets → 私有文件 + 音质门禁)
///   → AlarmRingService.start(前台服务) → MediaPlayer 播放 → 接铃。
/// 不联网、不实时合成，每次都是同一份字节；配合 logcat 核对音源与播放状态。
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  test("三个内置音色逐个走完整响铃链路", () async {
    final catalog = await AlarmPlatform.listBuiltinVoices();
    // ignore: avoid_print
    print("BUILTIN_VOICE_CATALOG=$catalog");
    expect(catalog.length, 3, reason: "APK 内置音色清单应有 3 条");
    final ids = catalog.map((e) => e["id"].toString()).toList();
    expect(ids, containsAll(<String>["diana", "anna", "alex"]));
    for (final v in catalog) {
      expect(v["bytes"] as int, greaterThan(0), reason: "${v["id"]} assets 必须可读");
    }

    for (final id in <String>["diana", "anna", "alex"]) {
      await AlarmPlatform.testBuiltinVoice(id);
      // ignore: avoid_print
      print("BUILTIN_VOICE_FIRED=$id");
      // 真实等待：最长一段 anna 约 4.9s，留足时间让整段音频送到 AudioTrack
      await Future<void>.delayed(const Duration(seconds: 6));
      await AlarmPlatform.stopRing();
      await Future<void>.delayed(const Duration(milliseconds: 400));
      // ignore: avoid_print
      print("BUILTIN_VOICE_DONE=$id");
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
