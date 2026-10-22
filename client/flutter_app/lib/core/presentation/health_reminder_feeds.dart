import 'dart:async';

import 'dynamic_island.dart';
import '../platform/input_activity_probe.dart';

/// 健康提醒（久坐 / 喝水 / 护眼）——直接复用既有灵动岛，不自建 UI。
///
/// 定调（2026-10-22）：
/// - 久坐、喝水、护眼**全部交给灵动岛**，桌宠不再为这三件事弹自己的卡；
/// - 岛上不出现任何按钮（没有「稍后」「知道了」），靠自动收回；
/// - 这里只产出**功能文案 + 真实数值**（"坐了 52 分钟"），不是人格台词库；
///   要带性格的话由上层注入 [lineBuilder]，此处不硬编码任何"俏皮话"。
///
/// 活动重置/判定：Windows 下由 [InputActivityProbe]（GetLastInputInfo）自动感知
/// 系统级键鼠空闲，无需全局钩子、不读按键内容；离座自动清零久坐计时。
/// 探针不可用的平台退回 [noteActivity] 手动标记。
class HealthReminderFeeds {
  HealthReminderFeeds._();

  static final DynamicIslandController _c = DynamicIslandController.instance;
  static final DynamicIslandLauncher _l = DynamicIslandLauncher.instance;

  static const Duration sedentaryAfter = Duration(minutes: 50);
  static const Duration waterEvery = Duration(minutes: 45);
  static const Duration eyeEvery = Duration(minutes: 20);

  /// 提醒在岛上的停留时长（与岛原生默认档一致，自动收回，无按钮）
  static const Duration onIslandFor = Duration(seconds: 8);

  /// 工作时段内才提醒（避免半夜弹"该喝水了"）
  static const int workStartHour = 8;
  static const int workEndHour = 22;

  /// 可选：把功能文案换成 LLM 生成的短句（由上层注入，失败时回落默认文案）
  static String Function(String kind, int minutes)? lineBuilder;

  static Timer? _timer;
  static bool _enabled = true;

  /// ── 真实感知（2026-10-22）──
  /// 「坐了 52 分钟」必须是**连续在座 52 分钟**，不是"应用开了 52 分钟"。
  /// 判据来自 [InputActivityProbe]（Windows GetLastInputInfo）：
  ///   · 3 分钟内有键鼠输入 → 视为在座，计时推进；
  ///   · 连续 5 分钟无输入   → 视为离座，久坐清零、喝水/护眼暂停；
  ///   · 3~5 分钟的中间地带  → 保持原状（看视频/开会不动鼠标很常见，不误判）。
  /// 探针不可用（非 Windows/受限环境）时退回挂钟 + [noteActivity] 兜底。
  static const Duration activeWithin = Duration(minutes: 3);
  static const Duration awayAfter = Duration(minutes: 5);

  /// 连续在座（离座清零）——久坐用
  static final Stopwatch _deskWatch = Stopwatch();
  /// 在座累计（离座暂停、不清零）——喝水/护眼用
  static final Stopwatch _waterWatch = Stopwatch();
  static final Stopwatch _eyeWatch = Stopwatch();

  /// 当前是否判定为在座（探针不可用时恒 true，走旧口径）
  static bool _present = false;

  static DateTime _lastActivityAt = DateTime.now();
  static DateTime _lastWaterAt = DateTime.now();
  static DateTime _lastEyeAt = DateTime.now();

  static final Map<String, Timer> _dismissTimers = <String, Timer>{};

  static bool get enabled => _enabled;

  /// 幂等启动（应用初始化调用一次即可）
  static void start() {
    if (_timer != null) return;
    _tickPresence();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _check());
  }

  static void stop() {
    _timer?.cancel();
    _timer = null;
    _deskWatch.stop();
    _waterWatch.stop();
    _eyeWatch.stop();
    for (final Timer t in _dismissTimers.values) {
      t.cancel();
    }
    _dismissTimers.clear();
  }

  static void setEnabled(bool value) {
    _enabled = value;
    if (!value) {
      for (final String id in <String>['health.sedentary', 'health.water', 'health.eye']) {
        _c.dismiss(id);
      }
    }
  }

  /// 手动标记"用户有活动"。探针可用时它只是补充（例如岛交互也算用过电脑），
  /// 探针不可用时它是唯一的活动来源。
  static void noteActivity() {
    _lastActivityAt = DateTime.now();
    if (InputActivityProbe.available) return;
    _present = true;
    if (!_deskWatch.isRunning) _deskWatch.start();
    if (!_waterWatch.isRunning) _waterWatch.start();
    if (!_eyeWatch.isRunning) _eyeWatch.start();
  }

  static bool _inWorkHours(DateTime now) =>
      now.hour >= workStartHour && now.hour < workEndHour;

  /// 采一次系统输入空闲 → 维护在座状态与三个计时器。
  /// 每个 30s tick 都调用（含非工作时段），保证下班回来时状态是新的。
  static void _tickPresence() {
    if (!InputActivityProbe.available) {
      // 探针不可用：旧口径——只要不显式标记离开就一直算在座
      _present = true;
      if (!_deskWatch.isRunning) _deskWatch.start();
      if (!_waterWatch.isRunning) _waterWatch.start();
      if (!_eyeWatch.isRunning) _eyeWatch.start();
      return;
    }

    final int idleMs = InputActivityProbe.sample();
    if (idleMs < 0) {
      _present = true;
      return;
    }
    if (idleMs >= awayAfter.inMilliseconds) {
      // 离座：连续久坐清零（回来重新算），喝水/护眼只暂停
      _present = false;
      if (_deskWatch.isRunning) {
        _deskWatch.stop();
        _deskWatch.reset();
      }
      _waterWatch.stop();
      _eyeWatch.stop();
      return;
    }
    if (idleMs <= activeWithin.inMilliseconds) {
      _present = true;
      if (!_deskWatch.isRunning) _deskWatch.start();
      if (!_waterWatch.isRunning) _waterWatch.start();
      if (!_eyeWatch.isRunning) _eyeWatch.start();
    }
    // 中间地带（3~5 分钟无输入）：保持现状，不推进也不重置
  }

  /// 久坐分钟数：探针可用 → 连续在座时长；否则退回挂钟
  static int _sedentaryMinutes(DateTime now) => InputActivityProbe.available
      ? _deskWatch.elapsed.inMinutes
      : now.difference(_lastActivityAt).inMinutes;

  static int _waterMinutes(DateTime now) => InputActivityProbe.available
      ? _waterWatch.elapsed.inMinutes
      : now.difference(_lastWaterAt).inMinutes;

  static int _eyeMinutes(DateTime now) => InputActivityProbe.available
      ? _eyeWatch.elapsed.inMinutes
      : now.difference(_lastEyeAt).inMinutes;

  static void _check() {
    if (!_enabled) return;
    final DateTime now = DateTime.now();
    _tickPresence();
    // 不在电脑前就不打扰——离座时既不该说"该喝水了"，也不该数久坐
    if (!_present) return;
    if (!_inWorkHours(now)) return;

    final int sedentaryMin = _sedentaryMinutes(now);
    if (sedentaryMin >= sedentaryAfter.inMinutes) {
      _emit(
        id: 'health.sedentary',
        kind: 'sedentary',
        minutes: sedentaryMin,
        fallbackTitle: '坐了 $sedentaryMin 分钟',
        trailing: '起身 30 秒',
      );
      // 提醒后重新起算连续久坐，避免每分钟重复弹
      _deskWatch.reset();
      _lastActivityAt = now;
    }

    final int waterMin = _waterMinutes(now);
    if (waterMin >= waterEvery.inMinutes) {
      _waterWatch.reset();
      _lastWaterAt = now;
      _emit(
        id: 'health.water',
        kind: 'water',
        minutes: waterMin,
        fallbackTitle: '该喝水了',
        trailing: '已过 $waterMin 分钟',
      );
    }

    final int eyeMin = _eyeMinutes(now);
    if (eyeMin >= eyeEvery.inMinutes) {
      _eyeWatch.reset();
      _lastEyeAt = now;
      _emit(
        id: 'health.eye',
        kind: 'eye',
        minutes: eyeMin,
        fallbackTitle: '看远处 20 秒',
        trailing: '已连续用眼 $eyeMin 分钟',
      );
    }
  }

  static void _emit({
    required String id,
    required String kind,
    required int minutes,
    required String fallbackTitle,
    required String trailing,
  }) {
    final String title = lineBuilder?.call(kind, minutes) ?? fallbackTitle;
    _c.present(IslandEntry(
      id: id,
      title: title,
      kind: IslandKind.update,
      trailing: trailing,
      // 3 = 与站内信同级，不抢任务/日程
      priority: 3,
    ));
    // 无按钮：只做一次注意力脉冲，随后自动收回
    unawaited(_l.attention(title: title, trailing: trailing, holdSeconds: 6));
    _dismissTimers[id]?.cancel();
    _dismissTimers[id] = Timer(onIslandFor, () {
      // 同 id 被新提醒刷新时，旧定时器不撤新条目
      if (_c.entry?.id == id) _c.dismiss(id);
      _dismissTimers.remove(id);
    });
  }

  /// 立即触发一次（调试 / 手动演示用；不参与节流）
  static void fireNow(String kind) {
    final DateTime now = DateTime.now();
    switch (kind) {
      case 'sedentary':
        _deskWatch.reset();
        _lastActivityAt = now;
        _emit(
          id: 'health.sedentary',
          kind: 'sedentary',
          minutes: sedentaryAfter.inMinutes,
          fallbackTitle: '坐了 ${sedentaryAfter.inMinutes} 分钟',
          trailing: '起身 30 秒',
        );
        break;
      case 'water':
        _lastWaterAt = now;
        _emit(
          id: 'health.water',
          kind: 'water',
          minutes: waterEvery.inMinutes,
          fallbackTitle: '该喝水了',
          trailing: '已过 ${waterEvery.inMinutes} 分钟',
        );
        break;
      case 'eye':
        _lastEyeAt = now;
        _emit(
          id: 'health.eye',
          kind: 'eye',
          minutes: eyeEvery.inMinutes,
          fallbackTitle: '看远处 20 秒',
          trailing: '已连续用眼 ${eyeEvery.inMinutes} 分钟',
        );
        break;
    }
  }
}
