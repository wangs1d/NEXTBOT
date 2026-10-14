/// 本地持久化的日程事项（写入 `private_ai_agent_store.json` 的 `scheduleEvents`）。
class ScheduleEvent {
  const ScheduleEvent({
    required this.id,
    required this.startAt,
    required this.title,
    this.shortTitle,
    this.notes,
    this.isTrivia = false,
    this.previewLeadMinutes,
  });

  final String id;
  final DateTime startAt;
  /// 完整标题（日程页展示）。
  final String title;
  /// 简洁展示标题（「今日安排」紧凑列表用，创建时由 LLM 生成；旧数据为空时回退 title 简化）。
  final String? shortTitle;
  final String? notes;
  /// 琐事提醒（喝水/睡觉等，trivia 分类）：照常到点推送，但不进「今日安排」（日程页仍展示）。
  final bool isTrivia;
  /// 预告窗口提前量（分钟，灵动岛胶囊倒计时的出场时点）。
  /// 来源 = 服务端分级提醒策略的任务计划（schedule-reminder-policy.ts 的
  /// preReminders 分段，唤醒/出发段按重要度×路程动态生成；睡前备忘段不驱动
  /// 胶囊），null = 该事项无预告计划（周期/琐事/承诺物化等）→ 不上胶囊倒计时，
  /// 只走到点提醒。2026-10-13 定调：预告与到点提醒是两种形式，预告只给
  /// 「值得提前知道」的事，提前量因事而异（牙医类 ~1-2 小时），不再客户端硬编码。
  final int? previewLeadMinutes;
}
