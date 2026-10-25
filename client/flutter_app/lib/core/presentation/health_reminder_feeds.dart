import "dart:async";
import "dart:io" show Platform;

import "package:flutter/foundation.dart" show kIsWeb;

import "dynamic_island.dart";
import "../platform/input_activity_probe.dart";
import "../services/health_rhythm_api.dart";

/// 健康提醒（久坐）——直接复用既有灵动岛，不自建 UI。
///
/// 定调（2026-10-23 第二版）：
/// - **护眼、喝水均已删除**——旧版 20 分钟护眼 / 45 分钟喝水太吵，且定时弹窗
///   对「该不该喝水」这种因人而异的事打扰价值低；
/// - 健康提醒只保留**久坐**：连续在座太久起身一次，普适且低频；
/// - 节奏不再硬编码：启动时向服务端拉取 `GET /api/health/rhythm`，
///   服务端按用户事实库的身份/职业线索选档位（学生/驾驶/体力/办公/通用），
///   认不出身份给**保守默认**（久坐 60 分钟，宁缺勿滥）；
/// - 岛上不出现任何按钮（没有「稍后」「知道了」），靠自动收回；
/// - 这里只产出**功能文案 + 真实数值**（"坐了 52 分钟"），不是人格台词库；
///   要带性格的话由上层注入 [lineBuilder]，此处不硬编码任何"俏皮话"。
///
/// 活动重置/判定：Windows 下由 [InputActivityProbe]（GetLastInputInfo）自动感知
/// 系统级键鼠空闲，无需全局钩子、不读按键内容；离座自动清零久坐计时。
/// 探针不可用的桌面平台退回 [noteActivity] 手动标记。
///
/// 仅电脑端（用户 2026-10-23 拍板）：手机端没有「连续在座」语义——拿着手机
/// 走动时挂钟口径照样在数久坐，纯误报。[start] 在 Android/iOS/Web 直接 no-op。
class HealthReminderFeeds {
  HealthReminderFeeds._();

  /// 仅电脑端启用：Android/iOS/Web 一律 false。
  static bool get isDesktopPlatform =>
      !kIsWeb &&
      (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  static final DynamicIslandController _c = DynamicIslandController.instance;
  static final DynamicIslandLauncher _l = DynamicIslandLauncher.instance;

  // ── 保守默认（服务端档位拉取失败时的兜底，比旧版 50 分钟保守）──
  static Duration? sedentaryAfter = const Duration(minutes: 60);

  /// 当前生效的档位（诊断/设置页展示用；拉取失败为 null = 默认兜底）
  static HealthRhythm? activeRhythm;

  /// 提醒在岛上的停留时长（与岛原生默认档一致，自动收回，无按钮）
  static const Duration onIslandFor = Duration(seconds: 8);

  /// 默认工作时段（档位未下发时的兜底；档位有自己的 startHour/endHour）
  static int workStartHour = 9;
  static int workEndHour = 21;

  /// 可选：把功能文案换成 LLM 生成的短句（由上层注入，失败时回落默认文案）
  static String Function(String kind, int minutes)? lineBuilder;

  static Timer? _timer;
  static bool _enabled = true;

  /// ── 真实感知 ──
  /// 「坐了 52 分钟」必须是**连续在座 52 分钟**，不是"应用开了 52 分钟"。
  /// 判据来自 [InputActivityProbe]（Windows GetLastInputInfo）：
  ///   · 3 分钟内有键鼠输入 → 视为在座，计时推进；
  ///   · 连续 5 分钟无输入   → 视为离座，久坐清零；
  ///   · 3~5 分钟的中间地带  → 保持原状（看视频/开会不动鼠标很常见，不误判）。
  /// 探针不可用（非 Windows/受限环境）时退回挂钟 + [noteActivity] 兜底。
  static const Duration activeWithin = Duration(minutes: 3);
  static const Duration awayAfter = Duration(minutes: 5);

  /// 连续在座（离座清零）——久坐用
  static final Stopwatch _deskWatch = Stopwatch();

  /// 当前是否判定为在座（探针不可用时恒 true，走旧口径）
  static bool _present = false;

  static DateTime _lastActivityAt = DateTime.now();

  static final Map<String, Timer> _dismissTimers = <String, Timer>{};

  static bool get enabled => _enabled;

  /// 幂等启动（应用初始化调用一次即可）；节奏档位异步拉取，不阻塞启动。
  /// 仅电脑端生效：手机端/Web 直接 no-op。
  static void start() {
    if (!isDesktopPlatform) return;
    if (_timer != null) return;
    _tickPresence();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _check());
    unawaited(_loadRhythm());
  }

  /// 拉服务端档位（按用户身份对症下药）；失败静默保留保守默认
  static Future<void> _loadRhythm() async {
    final HealthRhythm? r = await HealthRhythmApi().fetch();
    if (r != null) applyRhythm(r);
  }

  /// 套用档位（也供设置页/调试显式覆盖）。
  /// 只改"未触发中"的节奏语义：计时器本身不动，下轮判定即用新阈值。
  static void applyRhythm(HealthRhythm r) {
    activeRhythm = r;
    sedentaryAfter = r.sedentaryAfterMinutes == null
        ? null
        : Duration(minutes: r.sedentaryAfterMinutes!);
    workStartHour = r.startHour;
    workEndHour = r.endHour;
    // 档位把久坐关掉时，立即撤掉可能在岛上的久坐条目
    if (sedentaryAfter == null) _c.dismiss("health.sedentary");
  }

  static void stop() {
    _timer?.cancel();
    _timer = null;
    _deskWatch.stop();
    for (final Timer t in _dismissTimers.values) {
      t.cancel();
    }
    _dismissTimers.clear();
  }

  static void setEnabled(bool value) {
    _enabled = value;
    if (!value) {
      _c.dismiss("health.sedentary");
    }
  }

  /// 手动标记"用户有活动"。探针可用时它只是补充（例如岛交互也算用过电脑），
  /// 探针不可用时它是唯一的活动来源。
  static void noteActivity() {
    _lastActivityAt = DateTime.now();
    if (InputActivityProbe.available) return;
    _present = true;
    if (!_deskWatch.isRunning) _deskWatch.start();
  }

  static bool _inWorkHours(DateTime now) =>
      now.hour >= workStartHour && now.hour < workEndHour;

  /// 采一次系统输入空闲 → 维护在座状态与久坐计时。
  /// 每个 30s tick 都调用（含非工作时段），保证下班回来时状态是新的。
  static void _tickPresence() {
    if (!InputActivityProbe.available) {
      // 探针不可用：旧口径——只要不显式标记离开就一直算在座
      _present = true;
      if (!_deskWatch.isRunning) _deskWatch.start();
      return;
    }

    final int idleMs = InputActivityProbe.sample();
    if (idleMs < 0) {
      _present = true;
      return;
    }
    if (idleMs >= awayAfter.inMilliseconds) {
      // 离座：连续久坐清零（回来重新算）
      _present = false;
      if (_deskWatch.isRunning) {
        _deskWatch.stop();
        _deskWatch.reset();
      }
      return;
    }
    if (idleMs <= activeWithin.inMilliseconds) {
      _present = true;
      if (!_deskWatch.isRunning) _deskWatch.start();
    }
    // 中间地带（3~5 分钟无输入）：保持现状，不推进也不重置
  }

  /// 久坐分钟数：探针可用 → 连续在座时长；否则退回挂钟
  static int _sedentaryMinutes(DateTime now) => InputActivityProbe.available
      ? _deskWatch.elapsed.inMinutes
      : now.difference(_lastActivityAt).inMinutes;

  static void _check() {
    if (!_enabled) return;
    final DateTime now = DateTime.now();
    _tickPresence();
    // 不在电脑前就不打扰——离座时不该数久坐
    if (!_present) return;
    if (!_inWorkHours(now)) return;

    final int? sedentaryThresholdMin = sedentaryAfter?.inMinutes;
    if (sedentaryThresholdMin != null) {
      final int sedentaryMin = _sedentaryMinutes(now);
      if (sedentaryMin >= sedentaryThresholdMin) {
        _emit(
          id: "health.sedentary",
          kind: "sedentary",
          minutes: sedentaryMin,
          fallbackTitle: "坐了 $sedentaryMin 分钟",
          trailing: "起身 30 秒",
        );
        // 提醒后重新起算连续久坐，避免每分钟重复弹
        _deskWatch.reset();
        _lastActivityAt = now;
      }
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
    if (kind != "sedentary") return;
    final DateTime now = DateTime.now();
    final int threshold = sedentaryAfter?.inMinutes ?? 60;
    _deskWatch.reset();
    _lastActivityAt = now;
    _emit(
      id: "health.sedentary",
      kind: "sedentary",
      minutes: threshold,
      fallbackTitle: "坐了 $threshold 分钟",
      trailing: "起身 30 秒",
    );
  }
}
