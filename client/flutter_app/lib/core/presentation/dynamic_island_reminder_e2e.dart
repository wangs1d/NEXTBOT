// 灵动岛「提醒全屏豁免」E2E 数据注入引导。
//
// 仅当 --dart-define=PAI_ISLAND_REMINDER_E2E=true 构建时由 main.dart 调用，
// 生产构建该常量为 false，整段零开销（tree-shake 后不进包）。
//
// 验证链路与生产完全同一条：
//   IslandReminderScheduler.fireNow → attention 通道 → C++ StartAttention
//   → 全屏抑制豁免（attention_active）唤回；播完复位 → 回抑制。
//
// 与 integration_test/dynamic_island_reminder_capture.ps1 握手
// （%TEMP%\pai_island_reminder）：
//   写 app_ready.flag（待机帧可截）→ 等 fire_reminder.flag →
//   fireNow(8s 保持) → 写 reminder_fired.flag → 等 restore_done.flag → exit。
import 'dart:async';
import 'dart:io';

import 'dynamic_island.dart';

Future<void> runIslandReminderE2EBootstrap() async {
  final Directory stageDir = Directory(
      "${Directory.systemTemp.path}${Platform.pathSeparator}pai_island_reminder");
  stageDir.createSync(recursive: true);
  final File fireFlag =
      File("${stageDir.path}${Platform.pathSeparator}fire_reminder.flag");
  final File doneFlag =
      File("${stageDir.path}${Platform.pathSeparator}restore_done.flag");
  if (fireFlag.existsSync()) fireFlag.deleteSync();
  if (doneFlag.existsSync()) doneFlag.deleteSync();

  // main.dart 启动序列已调 initDynamicIsland()（其 VM 扩展注册非幂等，
  // 这里二次调用会 UNCAUGHT 炸掉本引导）——只轮询就绪标志。
  for (int i = 0;
      i < 60 && !DynamicIslandLauncher.instance.isNativeReady;
      i++) {
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  if (!DynamicIslandLauncher.instance.isNativeReady) {
    return; // 非桌面平台/通道不可用：静默退出。
  }
  // 多等几秒让岛回待机胶囊（应用启动期的初始化条目退场）。
  await Future<void>.delayed(const Duration(seconds: 6));

  // 待机帧就绪：PS 此时截非全屏对照帧，随后起全屏覆盖窗。
  File("${stageDir.path}${Platform.pathSeparator}app_ready.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());

  final DateTime deadline = DateTime.now().add(const Duration(minutes: 5));
  while (DateTime.now().isBefore(deadline) && !fireFlag.existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  if (!fireFlag.existsSync()) exit(0);

  // 到点提醒语义（holdSeconds>0 = 长驻留档）：C++ StartAttention 直推
  // 抑制豁免唤回，播完（0.45 入 + 8 持 + 0.35 出 ≈ 8.8s）自动复位回抑制。
  // message 随标题全展示（2026-10-07 宽度自适应定调）：r2 截图应见完整
  // 「标题 · 说明」且胶囊宽随文本伸缩。
  IslandReminderScheduler.instance.fireNow(
    title: "设计评审 · 14:00",
    message: "10 分钟后开始，请提前准备",
    holdSeconds: 8,
    // E2E 验证的就是破屏唤回链路（到点档语义）：显式带 urgent 白名单。
    urgent: true,
  );
  File("${stageDir.path}${Platform.pathSeparator}reminder_fired.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());

  while (DateTime.now().isBefore(deadline) && !doneFlag.existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  exit(0);
}
