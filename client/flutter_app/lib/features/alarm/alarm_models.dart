/// 闹钟领域模型 ——与服务端 `server/src/services/alarm-clock/alarm-types.ts` 对齐，
/// RRULE 展开语义与 `alarm-rrule.ts` 一致（本地时钟、单跳推进）。
///
/// 纯 Dart 数据 + 纯函数，无平台依赖，可单测。
library;

import "dart:convert";

enum AlarmKind { alarm, reminder }

enum AlarmStatus { active, paused, done, canceled }

AlarmKind _kindFrom(String? s) => s == "reminder" ? AlarmKind.reminder : AlarmKind.alarm;

AlarmStatus _statusFrom(String? s) => switch (s) {
      "paused" => AlarmStatus.paused,
      "done" => AlarmStatus.done,
      "canceled" => AlarmStatus.canceled,
      _ => AlarmStatus.active,
    };

class AlarmSnooze {
  final bool enabled;
  final List<int> presetsMinutes;
  final int maxCount;

  const AlarmSnooze({
    this.enabled = true,
    this.presetsMinutes = const [5, 10, 15],
    this.maxCount = 3,
  });

  factory AlarmSnooze.fromJson(Map<String, dynamic> j) => AlarmSnooze(
        enabled: j["enabled"] as bool? ?? true,
        presetsMinutes: (j["presetsMinutes"] as List?)?.map((e) => (e as num).toInt()).toList() ?? const [5, 10, 15],
        maxCount: (j["maxCount"] as num?)?.toInt() ?? 3,
      );

  Map<String, dynamic> toJson() => {"enabled": enabled, "presetsMinutes": presetsMinutes, "maxCount": maxCount};
}

class AlarmWakeMode {
  /// gentle_normal 普通闹铃 | voice_talk 语音叫醒 | music 播放音乐
  final String level;
  final String? voiceScript;
  final String? musicPlaylist;
  final bool volumeRamp;

  const AlarmWakeMode({this.level = "gentle_normal", this.voiceScript, this.musicPlaylist, this.volumeRamp = false});

  factory AlarmWakeMode.fromJson(Map<String, dynamic>? j) => AlarmWakeMode(
        level: j?["level"]?.toString() ?? "gentle_normal",
        voiceScript: j?["voiceScript"]?.toString(),
        musicPlaylist: j?["musicPlaylist"]?.toString(),
        volumeRamp: j?["volumeRamp"] as bool? ?? false,
      );

  Map<String, dynamic> toJson() => {
        "level": level,
        if (voiceScript != null) "voiceScript": voiceScript,
        if (musicPlaylist != null) "musicPlaylist": musicPlaylist,
        "volumeRamp": volumeRamp,
      };
}

class Alarm {
  final String id;
  final String actorId;
  final String label;
  final AlarmKind kind;
  final String fireAt; // ISO8601
  final String? repeatRule; // "RRULE:FREQ=DAILY;BYDAY=..." | null
  final AlarmSnooze snooze;
  final AlarmWakeMode? wakeMode;
  final bool dndBypass;
  AlarmStatus status;
  String? nextFireAt;
  int snoozeCount;
  final String createdAt;

  /// 服务端在建钟时生成并预合成的叫醒话术（Agent 文案 + mp3 base64）。
  /// 下行展开字段，非领域必填：没有时原生层退化为系统闹铃。
  String? voiceText;
  String? ttsBase64;

  Alarm({
    required this.id,
    required this.actorId,
    required this.label,
    required this.kind,
    required this.fireAt,
    required this.repeatRule,
    required this.snooze,
    this.wakeMode,
    required this.dndBypass,
    this.status = AlarmStatus.active,
    this.nextFireAt,
    this.snoozeCount = 0,
    required this.createdAt,
    this.voiceText,
    this.ttsBase64,
  });

  factory Alarm.fromJson(Map<String, dynamic> j) => Alarm(
        id: j["id"].toString(),
        actorId: j["actorId"]?.toString() ?? "",
        label: j["label"]?.toString() ?? "",
        kind: _kindFrom(j["kind"]?.toString()),
        fireAt: j["fireAt"]?.toString() ?? "",
        repeatRule: j["repeat"] is Map ? j["repeat"]["rule"]?.toString() : null,
        snooze: AlarmSnooze.fromJson((j["snooze"] as Map?)?.cast<String, dynamic>() ?? const {}),
        wakeMode: j["wakeMode"] is Map ? AlarmWakeMode.fromJson((j["wakeMode"] as Map).cast<String, dynamic>()) : null,
        dndBypass: j["dnd"] is Map ? (j["dnd"]["bypass"] as bool? ?? false) : false,
        status: _statusFrom(j["status"]?.toString()),
        nextFireAt: j["nextFireAt"]?.toString(),
        snoozeCount: (j["snoozeCount"] as num?)?.toInt() ?? 0,
        createdAt: j["createdAt"]?.toString() ?? "",
        voiceText: j["voiceText"]?.toString(),
        ttsBase64: j["ttsBase64"]?.toString(),
      );

  Map<String, dynamic> toJson() => {
        "id": id,
        "actorId": actorId,
        "label": label,
        "kind": kind.name,
        "fireAt": fireAt,
        "repeat": {"rule": repeatRule},
        "snooze": snooze.toJson(),
        if (wakeMode != null) "wakeMode": wakeMode!.toJson(),
        "dnd": {"bypass": dndBypass},
        "status": status.name,
        "nextFireAt": nextFireAt,
        "snoozeCount": snoozeCount,
        "createdAt": createdAt,
        if (voiceText != null) "voiceText": voiceText,
        if (ttsBase64 != null) "ttsBase64": ttsBase64,
      };

  String encode() => jsonEncode(toJson());

  static Alarm decode(String raw) => Alarm.fromJson((jsonDecode(raw) as Map).cast<String, dynamic>());

  /// 本地下一跳：优先用服务端给的 nextFireAt；缺失时按 RRULE 自算（双算互验的客户端侧）。
  DateTime? nextFireLocal(DateTime now) {
    if (status != AlarmStatus.active) return null;
    if (nextFireAt != null && nextFireAt!.isNotEmpty) {
      final t = DateTime.tryParse(nextFireAt!);
      if (t != null) return t;
    }
    final anchor = DateTime.tryParse(fireAt);
    if (anchor == null) return null;
    if (repeatRule == null || repeatRule!.isEmpty) return anchor.isAfter(now) ? anchor : null;
    return nextRruleOccurrence(repeatRule!, anchor, now);
  }
}

// ─── 最小 RRULE 展开（与 server/src/services/alarm-clock/alarm-rrule.ts 同语义） ───

class _RruleParts {
  final String freq; // DAILY | WEEKLY | MONTHLY
  final int interval;
  final Set<int> byday; // 0=SU..6=SA
  final DateTime? until;
  final int? count;
  _RruleParts(this.freq, this.interval, this.byday, this.until, this.count);
}

_RruleParts? _parseRrule(String rule) {
  final body = rule.trim().replaceFirst(RegExp(r'^RRULE:', caseSensitive: false), "");
  if (body.isEmpty) return null;
  final parts = <String, String>{};
  for (final kv in body.split(";")) {
    final eq = kv.indexOf("=");
    if (eq <= 0) continue;
    parts[kv.substring(0, eq).trim().toUpperCase()] = kv.substring(eq + 1).trim();
  }
  final freq = (parts["FREQ"] ?? "").toUpperCase();
  if (freq != "DAILY" && freq != "WEEKLY" && freq != "MONTHLY") return null;
  const wdMap = {"SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6};
  final byday = (parts["BYDAY"] ?? "")
      .split(",")
      .map((s) => wdMap[s.trim().toUpperCase()])
      .whereType<int>()
      .toSet();
  DateTime? until;
  final m = RegExp(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$").firstMatch(parts["UNTIL"] ?? "");
  if (m != null) {
    until = DateTime(
      int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!),
      int.parse(m.group(4) ?? "23"), int.parse(m.group(5) ?? "59"), int.parse(m.group(6) ?? "59"),
    );
  }
  final countRaw = parts["COUNT"] != null ? int.tryParse(parts["COUNT"]!) : null;
  return _RruleParts(freq, int.tryParse(parts["INTERVAL"] ?? "1") ?? 1, byday, until,
      countRaw != null && countRaw > 0 ? countRaw : null);
}

/// 返回严格晚于 [after] 的下一次发生；无则 null。
DateTime? nextRruleOccurrence(String rule, DateTime anchor, DateTime after) {
  final p = _parseRrule(rule);
  if (p == null) return null;
  if (p.freq == "WEEKLY" && p.byday.isEmpty) return null;

  final hardLimit = (after.isAfter(anchor) ? after : anchor).add(const Duration(days: 730));
  var occurred = 0;
  var dayIndex = 0;
  var guard = 0;
  final anchorDay = DateTime(anchor.year, anchor.month, anchor.day);

  while (guard++ < 1500) {
    final cand = anchorDay.add(Duration(days: dayIndex));
    final t = DateTime(cand.year, cand.month, cand.day, anchor.hour, anchor.minute, anchor.second);
    if (t.isAfter(hardLimit)) return null;

    // 推进 dayIndex（先记录当前候选再步进）
    final curDayIndex = dayIndex;
    switch (p.freq) {
      case "DAILY":
        dayIndex += p.interval;
      case "WEEKLY":
        dayIndex += 1;
      case "MONTHLY":
        final nextMonth = DateTime(cand.year, cand.month + p.interval, cand.day.clamp(1, 28));
        dayIndex = nextMonth.difference(anchorDay).inDays;
        if (dayIndex <= curDayIndex) return null;
    }

    if (p.freq == "WEEKLY") {
      final weekIndex = DateTime(cand.year, cand.month, cand.day).difference(anchorDay).inDays ~/ 7;
      if (weekIndex % p.interval != 0 || !p.byday.contains(cand.weekday % 7)) continue;
    }
    if (t.isBefore(anchor)) continue;
    if (!t.isAfter(after)) {
      occurred += 1;
      if (p.count != null && occurred >= p.count!) return null;
      if (p.until != null && t.isAfter(p.until!)) return null;
      continue;
    }
    if (p.until != null && t.isAfter(p.until!)) return null;
    if (p.count != null && occurred + 1 > p.count!) return null;
    return t;
  }
  return null;
}
