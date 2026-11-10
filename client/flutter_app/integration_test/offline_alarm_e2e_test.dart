import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:nextbot/features/alarm/alarm_platform.dart";

/// 脱离 server 到点实测：外部先停掉 3000 dev server，再用端侧入口预约一个
/// 65 秒后的精确闹钟，音源是 APK 内置的 diana（不联网、不实时合成）。
/// 测试进程保持在前台等到点，避免 flutter 工具收尾把 app 置为 stopped 状态，
/// 以此验证「到点响铃」这条链路完全不依赖 server。
///
/// 注意：这里直接调 AlarmPlatform.scheduleNext，不写 Dart 本地库，
/// 因此 30s 看门狗不会看到这个闹钟，响铃只能来自原生 AlarmManager。
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  test("server 停机状态下预约并等到点响铃", () async {
    final at = DateTime.now().add(const Duration(seconds: 65));
    final ok = await AlarmPlatform.scheduleNext(
      alarmId: "offline_probe_diana",
      at: at,
      label: "server 停机到点实测",
      builtinVoice: "diana",
    );
    // ignore: avoid_print
    print("OFFLINE_ALARM_SCHEDULED ok=$ok at=${at.toIso8601String()}");
    expect(ok, true, reason: "精确闹钟必须预约成功");
    // 保持 app 在前台等到点之后，给 MediaPlayer 留出完整播放时间
    await Future<void>.delayed(const Duration(seconds: 80));
    // ignore: avoid_print
    print("OFFLINE_ALARM_WAIT_DONE");
    await AlarmPlatform.stopRing();
  }, timeout: const Timeout(Duration(minutes: 3)));
}
