// RRULE Dart 镜像实现的独立验证脚本（dart run scripts/alarm_rrule_smoke.dart）
//与服务端 test/alarm-clock.test.ts 的用例一一对应，验证双算互验两侧结果一致。
import "package:nextbot/features/alarm/alarm_models.dart";

int failures = 0;

void check(String name, bool cond) {
  print("${cond ? "PASS" : "FAIL"}  $name");
  if (!cond) failures++;
}

void main() {
  final anchor = DateTime(2026, 10, 8, 7, 30);
  final after = DateTime(2026, 10, 8, 8, 0);

  // 1. DAILY：下一跳 = 次日同时刻
  final daily = nextRruleOccurrence("RRULE:FREQ=DAILY", anchor, after);
  check("DAILY → 10-09 07:30", daily != null && daily.day == 9 && daily.hour == 7 && daily.minute == 30);

  // 2. WEEKLY BYDAY=MO,WE,FR：锚点周四 → 下一跳周五
  final weekly = nextRruleOccurrence("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", anchor, after);
  check("WEEKLY BYDAY=MO,WE,FR → 周五 10-09", weekly != null && weekly.weekday == 5 && weekly.day == 9);

  // 3. COUNT=3 耗尽 → null（10/8、10/9、10/10 三次后）
  final countEnd = nextRruleOccurrence("RRULE:FREQ=DAILY;COUNT=3", anchor, DateTime(2026, 10, 12, 8, 0));
  check("COUNT=3 在 10-12 后耗尽 → null", countEnd == null);

  // 4. UNTIL=2026-10-15 截断
  final untilEnd = nextRruleOccurrence("RRULE:FREQ=DAILY;UNTIL=20261015T073000", anchor, DateTime(2026, 10, 20, 8, 0));
  check("UNTIL=10-15 在 10-20 后截断 → null", untilEnd == null);

  // 5. 贪睡后 nextFireAt 顺延（Alarm.nextFireLocal 路径）
  final alarm = Alarm(
    id: "a1",
    actorId: "u",
    label: "起床",
    kind: AlarmKind.alarm,
    fireAt: anchor.toIso8601String(),
    repeatRule: "RRULE:FREQ=DAILY",
    snooze: const AlarmSnooze(),
    dndBypass: true,
    status: AlarmStatus.active,
    nextFireAt: DateTime(2026, 10, 9, 7, 30).toIso8601String(),
    createdAt: anchor.toIso8601String(),
  );
  final localNext = alarm.nextFireLocal(DateTime(2026, 10, 8, 9, 0));
  check("nextFireLocal → 10-09 07:30", localNext != null && localNext.day == 9 && localNext.hour == 7);

  // 6. 单次闹钟过期 → null
  final onceExpired = Alarm(
    id: "a2",
    actorId: "u",
    label: "一次性",
    kind: AlarmKind.alarm,
    fireAt: anchor.toIso8601String(),
    repeatRule: null,
    snooze: const AlarmSnooze(),
    dndBypass: true,
    status: AlarmStatus.active,
    createdAt: anchor.toIso8601String(),
  );
  check("单次闹钟已过期 → null", onceExpired.nextFireLocal(DateTime(2026, 10, 9, 9, 0)) == null);

  // 7. JSON 编解码往返
  final decoded = Alarm.decode(alarm.encode());
  check("JSON 往返字段一致", decoded.id == alarm.id && decoded.repeatRule == alarm.repeatRule && decoded.snooze.maxCount == 3);

  print(failures == 0 ? "\n全部通过 (7/7)" : "\n失败 $failures 项");
}
