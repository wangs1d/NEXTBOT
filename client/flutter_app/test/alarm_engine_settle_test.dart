// 闹钟引擎「过期跳只补发一次」闭环测试。
// 覆盖 settleExpiredJumps 的三条判定：宽限窗补响一次、重复调用不再响、
// 陈旧跳静默推进状态。用 MethodChannel mock 计数 ringNow。
library;

import "dart:io";

import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "../lib/features/alarm/alarm_engine.dart";
import "../lib/features/alarm/alarm_local_store.dart";
import "../lib/features/alarm/alarm_models.dart";
import "helpers/temp_path_provider.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel("nextbot/alarm_clock");
  final ringCalls = <String>[];
  late AlarmEngine engine;
  late AlarmLocalStore store;
  DateTime now = DateTime.utc(2026, 11, 23, 5, 0);

  setUp(() async {
    PathProviderPlatform.instance = TempPathProviderPlatform();
    ringCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == "ringNow") {
        ringCalls.add(call.arguments["alarmId"] as String);
      }
      return null;
    });
    store = AlarmLocalStore.instance;
    await store.load();
    engine = AlarmEngine.forTest(
      store: store,
      actorId: () => "actor-1",
      httpBase: "", // 空 → _reportTrigger 直接跳过，不触网
      now: () => now,
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Alarm activeAlarm(String id, DateTime fireAt) => Alarm(
        id: id,
        actorId: "actor-1",
        label: "起床",
        kind: AlarmKind.alarm,
        fireAt: fireAt.toIso8601String(),
        repeatRule: null,
        snooze: const AlarmSnooze(),
        dndBypass: true,
        status: AlarmStatus.active,
        nextFireAt: fireAt.toIso8601String(),
        createdAt: fireAt.toIso8601String(),
      );

  group("过期跳一次性收敛", () {
    test("宽限窗内过期跳：首次补响一次，再次收敛不再响", () async {
      final fire = now.subtract(const Duration(minutes: 2)); // 过期 2 分钟，在 5 分钟窗内
      await store.upsertFromServer(activeAlarm("w1", fire));

      await engine.settleExpiredJumps(now: now);
      expect(ringCalls, ["w1"], reason: "首次应补响一次");

      ringCalls.clear();
      await engine.settleExpiredJumps(now: now);
      expect(ringCalls, isEmpty, reason: "台账已消费，重复收敛绝不能再响");

      // 状态已推进到 done，不再 active
      expect(store.get("w1")!.status, AlarmStatus.done);
    });

    test("陈旧跳（超宽限窗）：不响铃，但状态推进到 done", () async {
      final fire = now.subtract(const Duration(hours: 2)); // 12:58 那类陈年老钟
      await store.upsertFromServer(activeAlarm("w2", fire));

      await engine.settleExpiredJumps(now: now);
      expect(ringCalls, isEmpty, reason: "陈旧跳不应再补响，避免一进界面响一通");
      expect(store.get("w2")!.status, AlarmStatus.done, reason: "状态必须推进，否则每次冷启动都重试");
    });

    test("未到点的跳：收敛不动它，交给正常调度", () async {
      final fire = now.add(const Duration(minutes: 30));
      await store.upsertFromServer(activeAlarm("w3", fire));

      await engine.settleExpiredJumps(now: now);
      expect(ringCalls, isEmpty);
      expect(store.get("w3")!.status, AlarmStatus.active, reason: "未来跳不能被收敛");
    });
  });
}
