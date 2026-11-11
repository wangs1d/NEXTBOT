/// 闹钟引擎（客户端主路）—— 职责：
///  1. 订阅服务端事件：alarm.sync（跨设备同步）/ alarm.trigger（服务端兜底）/ reminder.deliver（即时提醒）；
///  2. 本地调度：每次闹钟变化后重排 Android 精确闹钟（iOS 走本地通知降级）；
///  3. 触发回执：本地触发 / 服务端兜底触发均回报 trigger-callback（驱动服务端取消推送兜底）；
///  4. 降级链：精确闹钟权限缺失 → 粗略预约照旧（系统允许范围内）→ flutter_local_notifications
///     本地通知 → 应用内横幅；语音模型不可用（/api/voice/health available=false）→ 普通闹铃。
///
/// 「用完即删除」（2026-11-09）：音频只在「服务端下发 → 原生落盘」这一段短暂存在于
/// Dart 内存/JSON；落盘成功即清掉本地库里的 base64，关闭 / 取消时再让原生层删 mp3。
/// 端侧不留长期音频副本，云端收到消费回执后同样立即删。
///
/// 纯逻辑与 IO 收口在本类，可注入 fake 单测。
library;

import "../../core/services/nb_http.dart";
import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../../core/services/ws_event_router.dart"
    show WsEventRouter, WsSubscribeScope, WsEventCatalog, wsEventPayload;
import "alarm_local_store.dart";
import "alarm_models.dart";
import "alarm_platform.dart";

typedef ActorIdGetter = String Function();
typedef NowGetter = DateTime Function();

class AlarmEngine {
  static AlarmEngine? _instance;
  static AlarmEngine get instance => _instance ??= AlarmEngine._();

  AlarmEngine._();

  static bool _busWired = false;

  /// 事件总线自订阅（main.dart 装配时调用一次；幂等）。
  ///
  /// alarm.sync / alarm.trigger / reminder.deliver 归本引擎 owned：服务端
  /// 闹钟事件由引擎自己消费，main 根监听器不再逐 type 接线。
  static void ensureBusSubscription() {
    if (_busWired) return;
    _busWired = true;
    WsEventRouter.instance.subscribe(
      module: "alarm-engine",
      types: WsEventCatalog.alarmEngine,
      scope: WsSubscribeScope.root,
      // alarm.sync 是幂等「全量状态同步」：断线重连瞬间连发多次时，只跑最后
      // 一次与逐次对账等价，积压时合并可避免一串过期的建钟/撤钟操作。
      coalesceTypes: const <String>{"alarm.sync"},
      onEvent: (Map<String, dynamic> event) => instance.handleServerEvent(
        event["type"] as String? ?? "",
        wsEventPayload(event),
      ),
    );
  }

  factory AlarmEngine.forTest({
    required AlarmLocalStore store,
    required ActorIdGetter actorId,
    required String httpBase,
    NowGetter? now,
    http.Client? client,
  }) {
    final e = AlarmEngine._();
    e._store = store;
    e._actorId = actorId;
    e._httpBase = httpBase;
    e._now = now ?? DateTime.now;
    e._client = client ?? NbClient();
    return e;
  }

  AlarmLocalStore _store = AlarmLocalStore.instance;
  ActorIdGetter _actorId = () => "";
  String _httpBase = "";
  NowGetter _now = DateTime.now;
  http.Client? _client;
  Timer? _watchdog;

  /// 引导：装载本地库 + 全量重排本地调度（冷启动 / 杀进程恢复的唯一入口）。
  Future<void> init({required String Function() actorId, required String httpBase}) async {
    _actorId = actorId;
    _httpBase = httpBase;
    await _store.load();
    await rescheduleAll();
    // 原生通知动作（贪睡/关闭）→ 引擎动作（业务推进收口在这里：本地库 + REST 同步）
    AlarmPlatform.onNativeAction = (action, alarmId) {
      unawaited(
        action == "snooze" ? snooze(alarmId, minutes: 10) : dismiss(alarmId),
      );
    };
    AlarmPlatform.attachActionHandler();
    // 看门狗：每 30s 兜底扫一次到点闹钟（方法桥失灵/精确闹钟被系统吞掉时的应用内兜底）
    _watchdog?.cancel();
    _watchdog = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(_watchdogTick()));
    // 服务端对账（2026-10-13 根修）：alarm.sync 只在创建瞬间 WS fan-out，
    // 建钟那一刻本机不在线 = 闹钟永远不进本地库（到点退别的端又被
    // localAlreadyHandled 只回 ack 不响 → 全端丢失）。启动即拉一次服务端补齐。
    unawaited(syncFromServer());
  }

  /// 服务端对账：拉取服务端活跃闹钟逐条 upsert 进本地库并重排本地调度。
  /// 启动 / WS 重连时调用；幂等（同 id 覆盖），离线失败静默（下次连接再收敛）。
  Future<void> syncFromServer() async {
    if (_httpBase.isEmpty) return;
    final String actorId = _actorId();
    if (actorId.isEmpty) return;
    try {
      final resp = await (_client ?? NbClient())
          .get(Uri.parse(
              "$_httpBase/api/alarms?actorId=${Uri.encodeComponent(actorId)}&status=active"))
          .timeout(const Duration(seconds: 5));
      if (resp.statusCode != 200) return;
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      final list = body["alarms"];
      if (list is! List) return;
      for (final raw in list) {
        if (raw is! Map) continue;
        await _onAlarmSync(<String, dynamic>{
          "op": "upsert",
          "alarm": Map<String, dynamic>.from(raw),
        });
      }
    } on Exception {
      // 对账失败不致命：WS 重连 / 下次启动再收敛
    }
  }

  void dispose() {
    _watchdog?.cancel();
    _watchdog = null;
  }

  // ─── 服务端事件入口（事件总线订阅 ensureBusSubscription 调用） ───

  Future<void> handleServerEvent(String type, Map<String, dynamic> payload) async {
    switch (type) {
      case "alarm.sync":
        await _onAlarmSync(payload);
      case "alarm.trigger":
        await _onAlarmTrigger(payload);
      case "reminder.deliver":
        await _onReminderDeliver(payload);
    }
  }

  /// 跨设备同步：另一端创建/修改/取消 → 本端落库并重排
  Future<void> _onAlarmSync(Map<String, dynamic> payload) async {
    final op = payload["op"]?.toString() ?? "upsert";
    final alarmRaw = payload["alarm"];
    if (op == "delete" && alarmRaw is Map) {
      final id = alarmRaw["id"]?.toString();
      if (id != null) {
        await _store.cancel(id);
        await AlarmPlatform.cancel(id);
      }
      return;
    }
    if (alarmRaw is! Map) return;
    final alarm = Alarm.fromJson(alarmRaw.cast<String, dynamic>());
    if (alarm.actorId.isNotEmpty && _actorId().isNotEmpty && alarm.actorId != _actorId()) return;
    await _store.upsertFromServer(alarm);
    if (alarm.status == AlarmStatus.active) {
      await _scheduleAlarmLocal(alarm);
    } else {
      await AlarmPlatform.cancel(alarm.id);
    }
  }

  /// 服务端兜底触发：本地闹钟库已把该跳标 done（本地先响）→ 幂等忽略只补回执；
  /// 否则（本端失联/离线错拍）→ 立即本地拉起响铃。
  Future<void> _onAlarmTrigger(Map<String, dynamic> payload) async {
    final alarmId = payload["alarmId"]?.toString() ?? "";
    if (alarmId.isEmpty) return;
    final firedAtMs = (payload["firedAtMs"] as num?)?.toInt() ?? _now().millisecondsSinceEpoch;
    final label = payload["label"]?.toString() ?? "";
    // 服务端 trigger 自带音频/话术（在线兜底路）；没有时回读本地库里预约阶段缓存的那份
    final cached = _store.get(alarmId);
    final ttsBase64 = _extractTtsBase64(payload["tts"]) ?? cached?.ttsBase64;
    final serverScript = payload["voiceText"]?.toString();
    final voiceText = (serverScript != null && serverScript.isNotEmpty)
        ? serverScript
        : cached?.voiceText;
    final alarm = cached;

    final localNext = alarm?.nextFireLocal(_now());
    final serverFired = DateTime.fromMillisecondsSinceEpoch(firedAtMs);
    final localAlreadyHandled = alarm == null ||
        alarm.status != AlarmStatus.active ||
        (localNext != null && localNext.isAfter(serverFired.add(const Duration(minutes: 1))));
    if (localAlreadyHandled) {
      // 本地已响过这一跳（或该闹钟已取消）：仅补回执，服务端据此取消推送兜底
      unawaited(_reportTrigger(alarmId, firedAtMs, via: "local", outcome: "acked"));
      return;
    }
    // 本端没响（离线/调度失败）→ 立即拉起响铃并回报
    await AlarmPlatform.ringNow(
      alarmId: alarmId,
      label: label,
      ttsBase64: ttsBase64,
      voiceText: voiceText,
    );
    await _store.markFired(alarmId, now: _now());
    unawaited(_reportTrigger(alarmId, firedAtMs, via: "server", outcome: "ringing"));
  }

  /// 即时提醒投递：一阶段直接出系统通知（urgent 通道，bypassDnd 由闹钟 dnd 决定）；
  /// 升级链（popup→voice_call）由服务端 intelligent-reminder 体系接管，端上不再重复升级。
  Future<void> _onReminderDeliver(Map<String, dynamic> payload) async {
    final reminderId = payload["reminderId"]?.toString() ?? "";
    final text = payload["text"]?.toString() ?? "";
    if (text.isEmpty) return;
    await AlarmPlatform.ringNow(
      alarmId: reminderId.isNotEmpty ? reminderId : "reminder_local",
      label: text,
      ttsBase64: reminderId.isEmpty ? null : _store.get(reminderId)?.ttsBase64,
    );
    if (reminderId.isNotEmpty) {
      unawaited(_reportTrigger(reminderId, _now().millisecondsSinceEpoch, via: "server", outcome: "ringing"));
    }
  }

  // ─── 本地调度 ───

  /// 全量重排：清理平台侧全部预约后逐个重挂（启动恢复 / 批量变更后调用）
  Future<void> rescheduleAll() async {
    for (final alarm in _store.listActive()) {
      await _scheduleAlarmLocal(alarm);
    }
  }

  Future<bool> _scheduleAlarmLocal(Alarm alarm) async {
    final next = alarm.nextFireLocal(_now());
    if (next == null) return false;
    final ok = await AlarmPlatform.scheduleNext(
      alarmId: alarm.id,
      at: next,
      label: alarm.label,
      // 预置音频随预约落到原生私有文件，本地 AlarmManager 到点无需联网即可播；
      // 话术文本随 extra 同步落到原生层，无 mp3 时交系统 TTS 念出来
      ttsBase64: alarm.ttsBase64,
      voiceText: alarm.voiceText,
    );
    if (ok) {
      // 原生层已落盘并回报云端删除；Dart 的 alarm-clock.json 不再保留大 base64。
      // 桥不可用时保守保留，供 ringNow / watchdog 兜底。
      await _store.clearVoice(alarm.id);
    }
    return ok;
  }

  /// 看门狗：扫描到点闹钟 → 本地响铃（方法桥失败的最后防线）
  Future<void> _watchdogTick() async {
    final now = _now();
    for (final alarm in _store.listActive()) {
      final next = alarm.nextFireLocal(now);
      if (next == null) continue;
      if (next.isBefore(now)) {
        await AlarmPlatform.ringNow(
          alarmId: alarm.id,
          label: alarm.label,
          ttsBase64: alarm.ttsBase64,
          voiceText: alarm.voiceText,
        );
        await _store.markFired(alarm.id, now: now);
        unawaited(_reportTrigger(alarm.id, next.millisecondsSinceEpoch, via: "local", outcome: "ringing"));
      }
    }
  }

  // ─── 用户动作（响铃 UI / 通知按钮回调） ───

  /// 停止响铃并确认（单次 → done；重复 → 推进下一跳）
  Future<void> dismiss(String alarmId) async {
    await AlarmPlatform.stopRing();
    await _store.markFired(alarmId, now: _now());
    // 用完即删：删原生私有 mp3 + 清本地库字节。重复闹钟下一跳由服务端按新时刻
    // 重新实时生成并再次下发，绝不复用上一跳的音频。
    await AlarmPlatform.releaseVoice(alarmId);
    await _store.clearVoice(alarmId);
    await _post("/api/alarms/$alarmId/dismiss", <String, dynamic>{});
    await _scheduleAlarmLocalIfActive(alarmId);
  }

  /// 贪睡：本地先顺延（离线可用），再同步服务端（2026-10-13 定调：贪睡档 10 分钟）。
  /// 贪睡后还要再响一次，音频保留，不调 releaseVoice。
  Future<void> snooze(String alarmId, {int minutes = 10}) async {
    await AlarmPlatform.stopRing();
    await _store.applySnooze(alarmId, minutes);
    final resp = await _post("/api/alarms/$alarmId/snooze", {"minutes": minutes});
    if (resp == null || resp["ok"] != true) {
      // 服务端不可达：本地 nextFireAt 已顺延，恢复联网后经 watchdog/sync 收敛
    }
    await _scheduleAlarmLocalIfActive(alarmId);
  }

  Future<void> _scheduleAlarmLocalIfActive(String alarmId) async {
    final alarm = _store.get(alarmId);
    if (alarm != null && alarm.status == AlarmStatus.active) {
      await _scheduleAlarmLocal(alarm);
    } else {
      await AlarmPlatform.cancel(alarmId);
    }
  }

  // ─── 触发回执与降级探测 ───

  Future<void> _reportTrigger(
    String alarmId,
    int firedAtMs, {
    required String via,
    required String outcome,
  }) async {
    await _post("/api/alarms/$alarmId/trigger-callback", {
      "firedAtMs": firedAtMs,
      "via": via,
      "outcome": outcome,
      "snoozeCount": _store.get(alarmId)?.snoozeCount ?? 0,
    });
  }

  /// 二阶段降级判定：语音模型健康探测（服务端 2xx 且 available=true 才走 voice_talk）
  Future<bool> isVoiceModelAvailable() async {
    if (_httpBase.isEmpty) return false;
    try {
      final resp = await (_client ?? NbClient())
          .get(Uri.parse("$_httpBase/api/voice/health"))
          .timeout(const Duration(milliseconds: 1500));
      if (resp.statusCode != 200) return false;
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      return body["available"] as bool? ?? false;
    } on Exception {
      return false;
    }
  }

  Future<Map<String, dynamic>?> _post(String path, Map<String, dynamic> body) async {
    if (_httpBase.isEmpty) return null;
    try {
      final resp = await (_client ?? NbClient())
          .post(
            Uri.parse("$_httpBase$path"),
            headers: {"Content-Type": "application/json"},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 5));
      if (resp.body.isEmpty) return null;
      return (jsonDecode(resp.body) as Map).cast<String, dynamic>();
    } on Exception {
      return null;
    }
  }

  static String? _extractTtsBase64(Object? ttsRaw) {
    if (ttsRaw is Map) {
      final fmt = ttsRaw["format"]?.toString();
      final b64 = ttsRaw["base64"]?.toString();
      if (fmt == "mp3" && b64 != null && b64.isNotEmpty) return b64;
    }
    return null;
  }
}
