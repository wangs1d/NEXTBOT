// 灵动岛「三级渐进展开」E2E 数据注入引导。
//
// 仅当以 --dart-define=PAI_ISLAND_E2E=true 构建时由 main.dart 调用，
// 生产构建该常量为 false，整段零开销（tree-shake 后不进包）。
//
// 职责（与 integration_test/dynamic_island_stage_capture.ps1 握手）：
//   1. 延迟待启动稳定后，通过生产喂点（IslandRealFeeds / 控制器）注入
//      今日日程、未读数、后台任务、agent 工具步骤流——数据链路与线上
//      完全同一条（WS 事件 → 喂点 → MethodChannel → C++ 壳层）；
//   2. 写 data_ready.flag 通知 PS 脚本开始真实鼠标交互（三级展开 /
//      hover 滚轮切页 / 形变保护连点 / 分级收回）并逐帧截图；
//   3. 收到 driver_done.flag 后撤下注入条目并退出进程。
import 'dart:async';
import 'dart:io';

import 'dynamic_island.dart';

final Directory _stageDir = Directory(
    "${Directory.systemTemp.path}${Platform.pathSeparator}pai_island_stage");

Future<void> runIslandStageE2EBootstrap() async {
  _stageDir.createSync(recursive: true);
  final File readyFlag =
      File("${_stageDir.path}${Platform.pathSeparator}data_ready.flag");
  final File doneFlag =
      File("${_stageDir.path}${Platform.pathSeparator}driver_done.flag");
  if (readyFlag.existsSync()) readyFlag.deleteSync();
  if (doneFlag.existsSync()) doneFlag.deleteSync();

  // main.dart 的 initDynamicIsland 与此幂等；attach 若已在途（_controller
  // 已置位但 create 尚未应答），轮询等待通道就绪，避免读早期 _nativeReady。
  // 冷启动首启（构建后首跑）通道就绪可远超 10s，预算给足 60s（2026-10-05
  // 实测：10s 预算下 bootstrap 静默退出，data_ready 永不写、三路 PS 全空等）。
  await initDynamicIsland();
  for (int i = 0;
      i < 120 && !DynamicIslandLauncher.instance.isNativeReady;
      i++) {
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }
  if (!DynamicIslandLauncher.instance.isNativeReady) {
    return; // 非桌面平台/通道不可用：静默退出。
  }
  await Future<void>.delayed(const Duration(seconds: 6));

  // 喂点 1：今日日程（展开卡「接下来」+ hover「下一节」）。
  IslandRealFeeds.setSchedule(
    agenda: <Map<String, Object?>>[
      <String, Object?>{
        "time": "12:00",
        "title": "午餐 · 与产品对齐",
        "hint": "已完成",
        "completed": true,
      },
      <String, Object?>{
        "time": "14:00",
        "title": "设计评审",
        "hint": "",
        "completed": false,
      },
      <String, Object?>{
        "time": "17:00",
        "title": "周报同步",
        "hint": "",
        "completed": false,
      },
    ],
    next: <String, Object?>{
      "time": "14:00",
      "title": "设计评审",
      "trailing": "25 分钟后",
    },
  );

  // 喂点 2：站内信未读（hover 环境行「N 未读」+ 展开卡「未读消息」节）。
  IslandRealFeeds.setInboxUnread(
    3,
    unreadTitles: <String>[
      "快递已到驿站，请及时领取",
      "订阅的「AI 周报」已更新",
      "好友申请：产品经理小王",
    ],
  );

  // 喂点 3：后台任务计数/状态行（hover「任务」页激活；胶囊无任务条目）。
  IslandRealFeeds.setTaskActivity(activeCount: 1, statusLine: "正在搜索资料");

  // 喂点 4：agent 工具步骤流（展开卡「任务动态」节：成功/失败/进行中三态）。
  DynamicIslandController.instance
    ..setForegroundAgent(active: true)
    ..beginAgentStep("web_search", "搜索目的地攻略")
    ..beginAgentStep("calendar_add_task", "创建日程 · 14:00 设计评审")
    ..beginAgentStep("shopping_compare", "正在比价 · 3 个平台")
    ..finishAgentStep("web_search", ok: true)
    ..finishAgentStep("calendar_add_task", ok: false);

  readyFlag.writeAsStringSync(DateTime.now().toIso8601String());

  // 最多等 3 分钟：PS 脚本完成全部交互与截图。
  final DateTime deadline = DateTime.now().add(const Duration(minutes: 3));
  while (DateTime.now().isBefore(deadline) && !doneFlag.existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }

  // ── 纯语音模式状态走查（语音唤醒已删除，点击说话）：供第二路 PS 连拍 ──
  // 交互走查结束时岛可能停在展开态（鼠标未离开不触发分级收回），
  // 先收合回胶囊；语音唤醒删除后待机=原态（无条目），点击=说话。
  // 帧序：原态 → 聆听 → 思考 → 播报 → 回原态。
  File("${_stageDir.path}${Platform.pathSeparator}voice_ready.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());
  DynamicIslandController.instance.collapse();
  // 任务计数清零（hover「任务」页回空闲文案；胶囊本就无任务条目）。
  // 前台轮次收尾：步骤流保留在展开卡供回看（新一轮开始才清空）。
  DynamicIslandController.instance.setForegroundAgent(active: false);
  IslandRealFeeds.setTaskActivity(activeCount: 0);
  Future<void> hold(int ms) async =>
      await Future<void>.delayed(Duration(milliseconds: ms));
  await hold(3500); // 原态帧（无任何语音条目）
  IslandRealFeeds.setVoiceEntry(title: "正在聆听", spinning: true);
  await hold(2800);
  IslandRealFeeds.setVoiceEntry(title: "思考中", spinning: true);
  await hold(2800);
  IslandRealFeeds.setVoiceEntry(title: "播报中", trailing: "回复已落聊天流");
  await hold(2800);
  IslandRealFeeds.dismissVoice(); // 会话收束 → 回原态
  await hold(2600);

  // 撤下注入的环境数据（hover 行回真实数据源）。
  IslandRealFeeds.setTaskActivity(activeCount: 0);
  await Future<void>.delayed(const Duration(seconds: 1));

  // ── 提醒 attention 小形态走查（2026-10-05 提醒改小胶囊档）：供第三路 PS 连拍 ──
  // 走生产喂点 IslandReminderScheduler.fireNow（WS reminder_fired 同一条链）。
  // 帧序：待机原态 → 提醒小胶囊（脉冲环+文字）→ 缩回待机。
  File("${_stageDir.path}${Platform.pathSeparator}attention_ready.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());
  await hold(2000); // 待机原态帧
  IslandReminderScheduler.instance.fireNow(
    title: "14:00 高铁 G1234 出发",
    holdSeconds: 6,
    // E2E 帧序断言必须上屏：显式带全屏打断白名单。
    urgent: true,
  );
  await hold(9000); // 入场 + 保持 + 缩回全程
  File("${_stageDir.path}${Platform.pathSeparator}attention_done.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());
  await hold(800);
  exit(0);
}
