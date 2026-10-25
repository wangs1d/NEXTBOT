import "dart:async" show Timer, unawaited;
import "dart:convert";
import "dart:math" as math;
import "dart:ui" show PathMetric;

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "media_disk_cache.dart";
import "travel_ask_launcher.dart";
import "travel_plan_models.dart";

// ═══════════════════════════════════════════════════════════════════
// 手机原生行程页（Android / iOS，2026-10-12 起替代应用内浏览器路径）。
//
// 1:1 落地 docs/design/mobile-travel-agent 设计稿（「行迹」手机版）：
// - 一屏一站：竖屏一次只给当下这一站，弹性旅程带（宽窄=时间占比）+
//   Now 主卡（实拍大图 + 时间档 + 安排理由 + 建议停留进度 + 下一站条）+
//   站点圆点 + 底部主按钮直达下一站；
// - 按需全屏地图：已走实线（流动光效）+ 未走虚线 + 站点标记（有真实
//   坐标用坐标归一化布点，无坐标回落环形布点，与设计稿 SVG 回落同款）；
// - 全程抽屉：78% 上滑，Day 切换 + 时间轴列表；
// - 站点详情：大图头图 + 时间档 + 事实 chip + 安排理由 + 介绍/贴士/
//   实用信息 + 到达·下一站动线 + 本日站点 chips。
//
// 视觉令牌（设计稿 :root）：底 #0B0C0E / 卡 #17191F / 卡2 #1F222A，
// 正文 #F5F3EE / 次 #9A9FA9 / 弱 #626873，唯一强调色琥珀 #F5A552，
// 卡圆角 22px。数字时间原稿用 Sora，Flutter 侧暂用系统字体。
//
// 数据源 = [TravelPlanData]（行程卡 from / 归档 fromPlanJson），
// 载荷适配与 mobile.html 的 adaptPayload 同口径：start 由 entry.time
// 解析（HH:mm / HH:mm-HH:mm），缺失按上一站终点递推（首站默认 09:00）；
// 时长缺失按下一站显式起点回推，兜底 60 分；leg 缺失按两站坐标估算
// （<1.2km 步行 / <4km 骑行 / 其余打车）。时间锚点字段 Agent 侧尚未
// 回填，本页不臆造；实拍图只用行程自带真实图，无图走渐变兜底不放假图。
// ═══════════════════════════════════════════════════════════════════

/// 设计稿视觉令牌
abstract final class _T {
  static const Color screen = Color(0xFF0B0C0E);
  static const Color card = Color(0xFF17191F);
  static const Color card2 = Color(0xFF1F222A);
  static const Color line = Color(0x14FFFFFF);
  static const Color line2 = Color(0x29FFFFFF);
  static const Color txt = Color(0xFFF5F3EE);
  static const Color t2 = Color(0xFF9A9FA9);
  static const Color t3 = Color(0xFF626873);
  static const Color amber = Color(0xFFF5A552);
  static const Color amberSoft = Color(0x24F5A552);
  static const Color amberLine = Color(0x66F5A552);
  static const double r = 22;
}

// ═══════════════════════════════════════════════════════════════════
// 视图模型（载荷适配，与 mobile.html adaptPayload 同口径）
// ═══════════════════════════════════════════════════════════════════

class _Leg {
  const _Leg({required this.mode, required this.minutes, required this.dist});
  final String mode; // walk | bike | taxi | boat
  final int minutes;
  final String dist;

  String get label => const <String, String>{
        "walk": "步行",
        "bike": "骑行",
        "taxi": "打车",
        "boat": "游船",
        "hike": "徒步",
      }[mode]!;
}

class _Stop {
  const _Stop({
    required this.name,
    required this.kind,
    required this.tag,
    required this.start,
    required this.duration,
    required this.note,
    required this.desc,
    required this.tips,
    required this.addr,
    required this.price,
    required this.images,
    required this.leg,
    required this.anchor,
    this.latitude,
    this.longitude,
  });

  final String name;
  final String kind; // sight | food | ride | indoor | stay
  final String tag;
  final int start; // 当日绝对分钟
  final int duration; // 建议停留分钟
  final String note; // Agent 的安排理由
  final String desc;
  final List<String> tips;
  final String addr;
  final String price;
  final List<String> images;
  final _Leg? leg; // 从上一站到本站的交通
  final bool anchor; // 时间锚点：用户/预订钉住的时刻，重排不动
  final double? latitude;
  final double? longitude;

  int get end => start + duration;
  String get timeText => "${_t2s(start)} — ${_t2s(end)}";
}

class _DayPlan {
  const _DayPlan({required this.name, required this.stops});
  final String name;
  final List<_Stop> stops;
}

String _t2s(int m) {
  m = m.round();
  // 跨午夜回绕：行程挤爆时递推链会给出 >24 点，显示 25:54 这类时刻只会困惑
  final String h = ((m ~/ 60) % 24).toString().padLeft(2, "0");
  final String mm = (m % 60).toString().padLeft(2, "0");
  return "$h:$mm";
}

/// 「09:00」→ 起点；「09:00-11:30」→ 起点+时长；解析失败返回 null
({int start, int? duration})? _parseClock(String raw) {
  final RegExp re = RegExp(r'(\d{1,2})\s*[:：]\s*(\d{2})');
  final List<RegExpMatch> hits = re.allMatches(raw).toList();
  if (hits.isEmpty) return null;
  int? toMin(RegExpMatch m) {
    final int h = int.parse(m.group(1)!);
    final int min = int.parse(m.group(2)!);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  final int? a = toMin(hits[0]);
  if (a == null) return null;
  if (hits.length >= 2) {
    final int? b = toMin(hits[1]);
    if (b != null && b > a) return (start: a, duration: b - a);
  }
  return (start: a, duration: null);
}

double _haversineKm(double lat1, double lng1, double lat2, double lng2) {
  const double k = 6371;
  final double dLat = (lat2 - lat1) * math.pi / 180;
  final double dLng = (lng2 - lng1) * math.pi / 180;
  final double s = 0.5 * math.pow(math.sin(dLat / 2), 2) +
      math.cos(lat1 * math.pi / 180) *
          math.cos(lat2 * math.pi / 180) *
          math.pow(math.sin(dLng / 2), 2);
  return 2 * k * math.asin(math.sqrt(s));
}

/// 站间交通估算（与 adaptPayload 同口径：<1.2km 步行 / <4km 骑行 / 其余打车）
_Leg _estimateLeg(double? fromLat, double? fromLng, double? lat, double? lng) {
  if (fromLat == null || fromLng == null || lat == null || lng == null) {
    return const _Leg(mode: "walk", minutes: 12, dist: "—");
  }
  final double km = _haversineKm(fromLat, fromLng, lat, lng);
  if (km < 1.2) {
    return _Leg(
        mode: "walk",
        minutes: math.max(3, (km / 4.5 * 60).ceil()),
        dist: "${(km * 1000).round()}m");
  }
  if (km < 4) {
    return _Leg(
        mode: "bike",
        minutes: math.max(5, (km / 12 * 60).ceil()),
        dist: "${km.toStringAsFixed(1)}km");
  }
  return _Leg(
      mode: "taxi",
      minutes: math.max(8, (km / 25 * 60).ceil() + 5),
      dist: "${km.toStringAsFixed(1)}km");
}

/// TravelPlanData → 设计稿视图模型（days[].stops[]）
List<_DayPlan> _adaptDays(TravelPlanData plan) {
  final List<_DayPlan> result = <_DayPlan>[];
  for (final TravelPlanDay day in plan.days) {
    final int n = day.entries.length;
    // 第一遍：解析显式时间（HH:mm / HH:mm-HH:mm）
    final List<int?> starts = List<int?>.filled(n, null);
    final List<int?> durations = List<int?>.filled(n, null);
    for (int i = 0; i < n; i++) {
      final parsed = _parseClock(day.entries[i].time);
      if (parsed != null) {
        starts[i] = parsed.start;
        durations[i] = parsed.duration;
      }
    }
    // 第二遍：缺起点按上一站终点递推（首站默认 09:00）；缺时长按下一站
    // 显式起点回推（clamp 30~180），否则兜底 60 分钟
    int lastEnd = 9 * 60;
    for (int i = 0; i < n; i++) {
      final int start = starts[i] ?? lastEnd;
      int? duration = durations[i];
      if (duration == null) {
        int? nextStart;
        for (int j = i + 1; j < n; j++) {
          if (starts[j] != null) {
            nextStart = starts[j];
            break;
          }
        }
        if (nextStart != null) {
          duration = (nextStart - start - 12).clamp(30, 180);
        }
      }
      duration ??= 60;
      starts[i] = start;
      durations[i] = duration;
      lastEnd = start + duration;
    }
    // 第三遍：构建 stops
    final List<_Stop> stops = <_Stop>[];
    for (int i = 0; i < n; i++) {
      final TravelDayEntry e = day.entries[i];
      final _Leg leg = i == 0
          ? const _Leg(mode: "walk", minutes: 0, dist: "—")
          : _estimateLeg(
              stops.lastOrNull?.latitude,
              stops.lastOrNull?.longitude,
              e.latitude,
              e.longitude,
            );
      final String kind = switch (e.kind) {
        TravelEntryKind.attraction => "sight",
        TravelEntryKind.restaurant => "food",
        TravelEntryKind.hotel => "stay",
        TravelEntryKind.transport => "ride",
        TravelEntryKind.other => "indoor",
      };
      final String tag = switch (e.kind) {
        TravelEntryKind.attraction => "景点",
        TravelEntryKind.restaurant => "美食",
        TravelEntryKind.hotel => "住宿",
        TravelEntryKind.transport => "交通",
        TravelEntryKind.other => "停留",
      };
      stops.add(_Stop(
        name: e.title,
        kind: kind,
        tag: tag,
        start: starts[i]!,
        duration: durations[i]!,
        note: e.description.trim(),
        desc: e.description.trim(),
        tips: e.tips,
        addr: e.address.trim(),
        price: e.priceInfo.trim(),
        images: e.images,
        leg: leg,
        anchor: e.anchor,
        latitude: e.latitude,
        longitude: e.longitude,
      ));
    }
    result.add(_DayPlan(
      name: day.subtitle.isEmpty ? day.label : "${day.label} · ${day.subtitle}",
      stops: stops,
    ));
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 主页面（一屏一站）
// ═══════════════════════════════════════════════════════════════════

class TravelPlanMobilePage extends StatefulWidget {
  const TravelPlanMobilePage({super.key, required this.plan});

  final TravelPlanData plan;

  /// 全屏路由打开原生行程页。
  static Future<void> show(BuildContext context, {required TravelPlanData plan}) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanMobilePage(plan: plan),
      ),
    );
  }

  @override
  State<TravelPlanMobilePage> createState() => _TravelPlanMobilePageState();
}

class _TravelPlanMobilePageState extends State<TravelPlanMobilePage> {
  /// 可热更新的行程数据：编辑/加回备选/重排后整体替换并重适配视图模型
  late TravelPlanData _plan = widget.plan;
  late List<_DayPlan> _days = _adaptDays(_plan);
  int _day = 0;
  int _cur = 0;
  bool _mapOpen = false;

  // 实时信号（Agent 侧感知，页面只被动呈现；设计稿 PA_TRAVEL_SIGNAL 薄版）
  String? _signalEvent; // rain | behind | null
  String? _signalMood;
  String? _signalNote;
  bool _signalInFlight = false;
  Timer? _signalTimer;
  Timer? _progressDebounce;

  static const Duration _httpTimeout = Duration(seconds: 6);

  bool get _hasPlanId => _plan.planId.isNotEmpty;

  @override
  void initState() {
    super.initState();
    // 落盘预热（2026-10-13 根修）：此前本页用裸 Image.network + 无任何预热，
    // 进页即从零下载（进程内存缓存重启即空）→「每次进入都要等图」。
    // 现在 initState 即把全部实拍/封面推进磁盘缓存（有界并发落盘），
    // 渲染端统一走 CachedMediaImage：首次进入边下边看，再次进入秒开。
    _warmPlanImages(_plan);
    if (_hasPlanId) {
      // 进度恢复（跨端共享「已走/当前站」）
      unawaited(_restoreProgress());
      // 卡片载荷可能缺 anchor/pois 等新字段 → 从仓库补拉一次
      unawaited(_refreshFromStore());
      // 实时信号：打开即查 + 每 5 分钟轮询（服务端确定性判定，页面只呈现）
      unawaited(_fetchSignal());
      _signalTimer = Timer.periodic(const Duration(minutes: 5), (_) {
        unawaited(_fetchSignal());
      });
    }
  }

  /// 行程图片磁盘预热：封面 + 全部天全部站点实拍（有界并发，静默容错）。
  void _warmPlanImages(TravelPlanData plan) {
    MediaDiskCache.instance.warm(<String>[
      if (plan.coverImage.isNotEmpty) plan.coverImage,
      for (final TravelPlanDay day in plan.days)
        for (final TravelDayEntry e in day.entries) ...e.images,
    ]);
  }

  @override
  void dispose() {
    _signalTimer?.cancel();
    _progressDebounce?.cancel();
    super.dispose();
  }

  _DayPlan get _curDay =>
      _days.isEmpty ? const _DayPlan(name: "", stops: <_Stop>[]) : _days[_day];

  int get _safeCur =>
      _curDay.stops.isEmpty ? 0 : _cur.clamp(0, _curDay.stops.length - 1);

  _Stop? get _curStop => _curDay.stops.isEmpty ? null : _curDay.stops[_safeCur];

  String get _moodText => _signalMood ?? "刚刚好";

  String get _hintText => switch (_signalEvent) {
        "rain" => "Agent 感知到下雨 · 已切雨天室内",
        "behind" => "Agent 感知到进度落后 · 正在追赶",
        _ => "Agent 主动感知中 · 随时重排，时间锚点不动",
      };

  /// 已排入日程的站名（归一化）——候选池里不在其中 = Agent 收起的备选
  Set<String> get _scheduledNames => <String>{
        for (final _DayPlan d in _days)
          for (final _Stop s in d.stops) s.name.trim().toLowerCase(),
      };

  List<TravelPoi> get _alts => <TravelPoi>[
        for (final TravelPoi p in _plan.travelPois)
          if (p.name.trim().isNotEmpty &&
              !_scheduledNames.contains(p.name.trim().toLowerCase()))
            p,
      ];

  void _setStop(int day, int stop) {
    setState(() {
      if (day != _day) {
        _day = day.clamp(0, math.max(0, _days.length - 1));
        _cur = stop;
      } else {
        _cur = stop;
      }
    });
    _scheduleProgressUpload();
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontSize: 12.5)),
        backgroundColor: const Color(0xFF23262E),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  // ── 进度（跨端共享） ─────────────────────────────────────────────

  void _scheduleProgressUpload() {
    if (!_hasPlanId) return;
    _progressDebounce?.cancel();
    _progressDebounce = Timer(const Duration(milliseconds: 800), () async {
      try {
        await http
            .patch(
          Uri.parse("${ApiConfig.httpBase}/travel/plans/${_plan.planId}/progress"),
          headers: const <String, String>{"content-type": "application/json"},
          body: jsonEncode(<String, int>{"day": _day, "stop": _safeCur}),
        )
            .timeout(_httpTimeout);
      } catch (_) {
        // 进度上报失败静默（下次切站会再报）
      }
    });
  }

  Future<void> _restoreProgress() async {
    try {
      final http.Response resp = await http
          .get(Uri.parse(
              "${ApiConfig.httpBase}/travel/plans/${_plan.planId}/progress"))
          .timeout(_httpTimeout);
      if (resp.statusCode != 200 || !mounted) return;
      final Object? decoded = jsonDecode(resp.body);
      final Object? raw = decoded is Map ? decoded["progress"] : null;
      if (raw is Map<String, dynamic>) {
        final int day = (raw["day"] as num?)?.toInt() ?? 0;
        final int stop = (raw["stop"] as num?)?.toInt() ?? 0;
        if (day < _days.length && stop < _days[day].stops.length) {
          setState(() {
            _day = day;
            _cur = stop;
          });
        }
      }
    } catch (_) {
      // 恢复失败从 Day 1 开始
    }
  }

  // ── 行程数据热更新（编辑/加回备选后整体重适配） ─────────────────

  void _applyUpdatedPlan(TravelPlanData updated) {
    if (!mounted) return;
    setState(() {
      _plan = updated;
      _days = _adaptDays(updated);
      if (_day >= _days.length) _day = 0;
      final List<_Stop> stops =
          _days.isEmpty ? const <_Stop>[] : _days[_day].stops;
      if (_cur >= stops.length) _cur = 0;
    });
    _warmPlanImages(updated);
  }

  Future<void> _refreshFromStore() async {
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.httpBase}/travel/plans/${_plan.planId}"))
          .timeout(_httpTimeout);
      if (resp.statusCode != 200 || !mounted) return;
      final Object? decoded = jsonDecode(resp.body);
      final Object? raw = decoded is Map ? decoded["plan"] : null;
      if (raw is Map<String, dynamic>) {
        _applyUpdatedPlan(TravelPlanData.fromPlanJson(raw));
      }
    } catch (_) {
      // 补拉失败不影响现有渲染
    }
  }

  // ── 实时信号 ─────────────────────────────────────────────────────

  Future<void> _fetchSignal() async {
    if (!mounted || _signalInFlight) return;
    _signalInFlight = true;
    try {
      final http.Response resp = await http
          .get(Uri.parse(
              "${ApiConfig.httpBase}/travel/plans/${_plan.planId}/signal"))
          .timeout(_httpTimeout);
      if (resp.statusCode != 200 || !mounted) return;
      final Object? decoded = jsonDecode(resp.body);
      if (decoded is Map<String, dynamic>) {
        final String event = decoded["event"]?.toString() ?? "";
        setState(() {
          _signalEvent = event.isEmpty ? null : event;
          _signalMood = decoded["mood"]?.toString();
          _signalNote = decoded["note"]?.toString();
        });
      }
    } catch (_) {
      // 信号取不到就保持中性呈现
    } finally {
      _signalInFlight = false;
    }
  }

  // ── 对话闭环：提意见换一个 / 问 Agent / 加回备选 ─────────────────

  /// 「现在就去」：把 Agent 收起的备选站排进当天（复用新增条目 + 局部重排）
  Future<void> _addAltToDay(TravelPoi alt) async {
    if (!_hasPlanId) {
      _toast("文本兜底行程暂不支持加回");
      return;
    }
    try {
      final http.Response resp = await http
          .post(
        Uri.parse(
            "${ApiConfig.httpBase}/travel/plans/${_plan.planId}/days/$_day/items"),
        headers: <String, String>{
          "content-type": "application/json",
          "if-match": "${_plan.version ?? 0}",
        },
        body: jsonEncode(<String, String>{"type": alt.type, "name": alt.name}),
      )
          .timeout(const Duration(seconds: 20));
      if (!mounted) return;
      if (resp.statusCode == 200) {
        final Object? raw = jsonDecode(resp.body);
        if (raw is Map<String, dynamic>) {
          _applyUpdatedPlan(TravelPlanData.fromPlanJson(raw));
        }
        _toast("已把「${alt.name}」排进 Day ${_day + 1} · 时间轴已重排");
      } else if (resp.statusCode == 409) {
        _toast("行程刚被更新过，已刷新，请再试一次");
        unawaited(_refreshFromStore());
      } else {
        _toast("加回失败（HTTP ${resp.statusCode}）");
      }
    } catch (_) {
      _toast("加回失败 · 网络异常");
    }
  }

  /// 「跟 Agent 提意见」：预设 + 自由输入 → 换一换（原类型同类 POI + 局部重排）
  Future<void> _commentStop() async {
    final _Stop? stop = _curStop;
    if (stop == null) return;
    if (!_hasPlanId) {
      _toast("文本兜底行程暂不支持换一换");
      return;
    }
    final String? comment = await _showCommentDialog(stop.name);
    if (comment == null || comment.trim().isEmpty || !mounted) return;
    try {
      final http.Response resp = await http
          .post(
        Uri.parse(
            "${ApiConfig.httpBase}/travel/plans/${_plan.planId}/days/$_day/items/$_safeCur/comment"),
        headers: <String, String>{
          "content-type": "application/json",
          "if-match": "${_plan.version ?? 0}",
        },
        body: jsonEncode(<String, String>{"comment": comment.trim()}),
      )
          .timeout(const Duration(seconds: 25));
      if (!mounted) return;
      if (resp.statusCode == 200) {
        final Object? raw = jsonDecode(resp.body);
        if (raw is Map<String, dynamic>) {
          _applyUpdatedPlan(TravelPlanData.fromPlanJson(raw));
        }
        _toast("已按你的意见换好 · 时间锚点不动");
      } else if (resp.statusCode == 404) {
        _toast("附近没找到可替换的同类地点，换个说法试试");
      } else if (resp.statusCode == 409) {
        _toast("行程刚被更新过，已刷新，请再试一次");
        unawaited(_refreshFromStore());
      } else {
        _toast("换一换失败（HTTP ${resp.statusCode}）");
      }
    } catch (_) {
      _toast("换一换失败 · 网络异常");
    }
  }

  Future<String?> _showCommentDialog(String stopName) {
    final TextEditingController ctrl = TextEditingController();
    const List<String> presets = <String>[
      "太贵了，换个实惠的",
      "想换个人少安静的",
      "换成更有本地特色的",
    ];
    return showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        backgroundColor: _T.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text("跟 Agent 说 · $stopName",
            style: const TextStyle(fontSize: 15, color: _T.txt)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final String p in presets)
                  ActionChip(
                    backgroundColor: _T.card2,
                    side: const BorderSide(color: _T.line),
                    label: Text(p,
                        style: const TextStyle(fontSize: 11, color: _T.t2)),
                    onPressed: () => Navigator.of(ctx).pop(p),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              maxLength: 200,
              maxLines: 2,
              style: const TextStyle(color: _T.txt, fontSize: 13),
              decoration: InputDecoration(
                hintText: "或者自己说，例如「想吃本地菜」",
                hintStyle: const TextStyle(color: _T.t3, fontSize: 12),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _T.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _T.amberLine),
                ),
              ),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text("取消", style: TextStyle(color: _T.t2)),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: _T.amber,
              foregroundColor: const Color(0xFF201407),
            ),
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text("让 Agent 换"),
          ),
        ],
      ),
    );
  }

  void _openSheet() {
    if (_days.isEmpty || _curDay.stops.isEmpty) return;
    final List<TravelPoi> alts = _alts;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black54,
      builder: (BuildContext ctx) => _AllDaySheet(
        days: _days,
        day: _day,
        cur: _safeCur,
        alts: alts,
        onPick: (int d, int s) {
          Navigator.of(ctx).pop();
          _setStop(d, s);
        },
        onAddAlt: (TravelPoi alt) {
          Navigator.of(ctx).pop();
          unawaited(_addAltToDay(alt));
        },
      ),
    );
  }

  void _openDetail() {
    final _Stop? stop = _curStop;
    if (stop == null) return;
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => _StopDetailPage(
          destination: widget.plan.destination,
          day: _curDay,
          dayIndex: _day,
          stopIndex: _safeCur,
          onPickStop: (int d, int s) {
            Navigator.of(context).pop(); // 回主页
            _setStop(d, s);
          },
          onAskAgent: () {
            Navigator.of(context).pop();
            TravelAskLauncher.ask(
                "关于行程「${_plan.title}」${_curDay.name}的「${stop.name}」（${stop.timeText}）：");
          },
          onComment: () {
            Navigator.of(context).pop();
            unawaited(_commentStop());
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool empty = _curDay.stops.isEmpty;
    final _Stop? cur = _curStop;
    final _Stop? next = (cur != null && _safeCur + 1 < _curDay.stops.length)
        ? _curDay.stops[_safeCur + 1]
        : null;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: _T.screen,
        body: Stack(
          children: <Widget>[
            // ══ 主视图（一屏一站） ══
            SafeArea(
              bottom: false,
              child: empty
                  ? const _EmptyView()
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        _TopBar(
                          city: widget.plan.destination,
                          dayIndex: _day,
                          dayName: widget.plan.title.isEmpty
                              ? _curDay.name
                              : widget.plan.title,
                        ),
                        _JourneyBand(
                          stops: _curDay.stops,
                          cur: _safeCur,
                          mood: _moodText,
                          altCount: _alts.length,
                          onPick: (int i) => _setStop(_day, i),
                        ),
                        Expanded(
                          child: ListView(
                            padding: const EdgeInsets.fromLTRB(24, 18, 24, 8),
                            children: <Widget>[
                              _NowCard(
                                stop: cur!,
                                next: next,
                                onTap: _openDetail,
                              ),
                              const SizedBox(height: 14),
                              _StopDots(
                                count: _curDay.stops.length,
                                cur: _safeCur,
                                onPick: (int i) => _setStop(_day, i),
                              ),
                              // Agent 信号气泡（设计稿 agent-bubble）：有感知结果才出现
                              if (_signalNote != null) ...<Widget>[
                                const SizedBox(height: 14),
                                _AgentNoteBubble(
                                  text: _signalNote!,
                                  onDismiss: () =>
                                      setState(() => _signalNote = null),
                                ),
                              ],
                            ],
                          ),
                        ),
                        _SignalHint(text: _hintText),
                        _ThumbBar(
                          next: next,
                          onGo: () {
                            if (_safeCur < _curDay.stops.length - 1) {
                              _setStop(_day, _safeCur + 1);
                            } else {
                              _toast("今日行程结束 · 回酒店休整");
                            }
                          },
                          onMap: () => setState(() => _mapOpen = true),
                          onSheet: _openSheet,
                        ),
                      ],
                    ),
            ),
            // ══ 全屏地图（按需呼出，右滑入；空行程不挂载避免越界） ══
            if (!empty)
              AnimatedSlide(
              offset: _mapOpen ? Offset.zero : const Offset(1, 0),
              duration: const Duration(milliseconds: 380),
              curve: Curves.easeOutCubic,
              child: AnimatedOpacity(
                opacity: _mapOpen ? 1 : 0,
                duration: const Duration(milliseconds: 300),
                child: IgnorePointer(
                  ignoring: !_mapOpen,
                  child: TickerMode(
                    enabled: _mapOpen,
                    child: _RouteMapOverlay(
                      dayName: widget.plan.title.isEmpty
                          ? _curDay.name
                          : widget.plan.title,
                      stops: _curDay.stops,
                      cur: _safeCur,
                      onClose: () => setState(() => _mapOpen = false),
                      onPick: (int i) => _setStop(_day, i),
                      onSheet: _openSheet,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 顶栏：eyebrow（城市 · DAY N）+ 日线名 + Agent 跟随胶囊
// ═══════════════════════════════════════════════════════════════════

class _TopBar extends StatelessWidget {
  const _TopBar({required this.city, required this.dayIndex, required this.dayName});

  final String city;
  final int dayIndex;
  final String dayName;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 6, 24, 0),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  "${city.toUpperCase()} · DAY ${dayIndex + 1}",
                  style: const TextStyle(
                    fontSize: 11,
                    letterSpacing: 2.4,
                    color: _T.t3,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  dayName.isEmpty ? "行程" : dayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 21,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.5,
                    color: _T.txt,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              color: _T.card,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: _T.line),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                _LiveDot(),
                SizedBox(width: 8),
                Text("Agent 跟随中", style: TextStyle(fontSize: 11, color: _T.t2)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _LiveDot extends StatelessWidget {
  const _LiveDot();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 7,
      height: 7,
      decoration: const BoxDecoration(color: _T.amber, shape: BoxShape.circle),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 弹性旅程带：每段宽窄 = 停留 + 交通时长；done / now / todo 三态
// ═══════════════════════════════════════════════════════════════════

class _JourneyBand extends StatelessWidget {
  const _JourneyBand({
    required this.stops,
    required this.cur,
    required this.mood,
    required this.altCount,
    required this.onPick,
  });

  final List<_Stop> stops;
  final int cur;
  final String mood;

  /// Agent 收起的备选站数量（旅程带尾部虚线段）
  final int altCount;
  final ValueChanged<int> onPick;

  @override
  Widget build(BuildContext context) {
    final _Stop first = stops.first;
    final _Stop last = stops.last;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 0),
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              const Text("今日节奏 · ", style: TextStyle(fontSize: 12.5, color: _T.t2)),
              Text(mood,
                  style: const TextStyle(
                      fontSize: 12.5, color: _T.amber, fontWeight: FontWeight.w600)),
              const Spacer(),
              Text("预计 ${_t2s(last.end)} 结束",
                  style: const TextStyle(fontSize: 11, color: _T.t3)),
            ],
          ),
          const SizedBox(height: 9),
          SizedBox(
            height: 7,
            child: Row(
              children: <Widget>[
                for (int i = 0; i < stops.length; i++)
                  Expanded(
                    flex: math.max(1, stops[i].duration + (stops[i].leg?.minutes ?? 0)),
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => onPick(i),
                      child: Container(
                        margin: const EdgeInsets.symmetric(horizontal: 1.5),
                        decoration: BoxDecoration(
                          color: i < cur
                              ? const Color(0x38FFFFFF)
                              : (i == cur ? _T.amber : const Color(0x1AFFFFFF)),
                          borderRadius: BorderRadius.circular(99),
                          boxShadow: i == cur
                              ? <BoxShadow>[
                                  BoxShadow(
                                    color: _T.amber.withValues(alpha: 0.6),
                                    blurRadius: 10,
                                  ),
                                ]
                              : null,
                        ),
                      ),
                    ),
                  ),
                // Agent 收起的备选站：虚线感淡段（可请求加回，入口在「看全程」）
                for (int a = 0; a < altCount; a++)
                  Container(
                    width: 9,
                    height: 6,
                    margin: const EdgeInsets.symmetric(horizontal: 1.5),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      border: Border.all(color: const Color(0x38FFFFFF), width: 1),
                      borderRadius: BorderRadius.circular(99),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 7),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Text(_t2s(first.start), style: const TextStyle(fontSize: 10, color: _T.t3)),
              Text(_t2s(last.end), style: const TextStyle(fontSize: 10, color: _T.t3)),
            ],
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// Now 主卡：实拍大图 + 类型 tag + 时间档 + 名称 + 安排理由 +
// 建议停留进度 + 下一站条；点卡片进站点详情
// ═══════════════════════════════════════════════════════════════════

class _NowCard extends StatelessWidget {
  const _NowCard({required this.stop, required this.next, required this.onTap});

  final _Stop stop;
  final _Stop? next;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: _T.card,
      borderRadius: BorderRadius.circular(_T.r),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // ── 照片区 238px ──
            SizedBox(
              height: 238,
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  if (stop.images.isNotEmpty)
                    CachedMediaImage(
                      url: stop.images.first,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const _NoImageFallback(),
                    )
                  else
                    const _NoImageFallback(),
                  // 底部压暗渐变（38% → 88%）
                  const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        stops: <double>[0.38, 1.0],
                        colors: <Color>[Colors.transparent, Color(0xE00B0C0E)],
                      ),
                    ),
                  ),
                  // 类型 tag（左上）
                  Positioned(
                    top: 14,
                    left: 14,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
                      decoration: BoxDecoration(
                        color: const Color(0x8C0B0C0E),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: const Color(0x24FFFFFF)),
                      ),
                      child: Text(
                        stop.tag,
                        style: const TextStyle(
                            fontSize: 10.5, letterSpacing: 1, color: _T.txt),
                      ),
                    ),
                  ),
                  // 时间档 + 名称（左下）
                  Positioned(
                    left: 18,
                    right: 18,
                    bottom: 14,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          "${stop.timeText}${stop.anchor ? " · 时间锚点" : ""}",
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 1,
                            color: _T.amber,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          stop.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 25,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.5,
                            height: 1.25,
                            color: _T.txt,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            // ── 卡身 ──
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (stop.note.isNotEmpty)
                    Text(
                      stop.note,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, height: 1.6, color: _T.t2),
                    ),
                  const SizedBox(height: 12),
                  // 建议停留进度
                  Row(
                    children: <Widget>[
                      const Icon(Icons.access_time_rounded, size: 15, color: _T.amber),
                      const SizedBox(width: 8),
                      Text("建议停留 ${stop.duration} 分钟",
                          style: const TextStyle(fontSize: 12, color: _T.t2)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            value: (stop.duration / 120).clamp(0.08, 1.0),
                            minHeight: 4,
                            backgroundColor: const Color(0x14FFFFFF),
                            valueColor: const AlwaysStoppedAnimation<Color>(_T.amber),
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (next != null) ...<Widget>[
                    const SizedBox(height: 13),
                    _NextRow(next: next!),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 无实拍时的渐变兜底（amber/jade 双色调，宁缺毋滥不放假图）
class _NoImageFallback extends StatelessWidget {
  const _NoImageFallback();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF232830), Color(0xFF151A22), Color(0xFF2A2018)],
          stops: <double>[0.0, 0.55, 1.0],
        ),
      ),
    );
  }
}

class _NextRow extends StatelessWidget {
  const _NextRow({required this.next});

  final _Stop next;

  IconData get _modeIcon => switch (next.leg?.mode) {
        "bike" => Icons.directions_bike_rounded,
        "taxi" => Icons.local_taxi_rounded,
        "boat" => Icons.directions_boat_rounded,
        _ => Icons.directions_walk_rounded,
      };

  @override
  Widget build(BuildContext context) {
    final _Leg? leg = next.leg;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
      decoration: BoxDecoration(
        color: _T.card2,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _T.line),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: _T.amberSoft,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(_modeIcon, size: 20, color: _T.amber),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text("下一站", style: TextStyle(fontSize: 11, color: _T.t3)),
                const SizedBox(height: 1),
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        next.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 14, fontWeight: FontWeight.w600, color: _T.txt),
                      ),
                    ),
                    if (leg != null && leg.minutes > 0) ...<Widget>[
                      const SizedBox(width: 7),
                      Text(
                        "${leg.label} ${leg.minutes} 分钟 · ${leg.dist}",
                        style: const TextStyle(
                            fontSize: 12, color: _T.amber, fontWeight: FontWeight.w500),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right_rounded, size: 18, color: _T.t3),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 站点圆点 / 信号提示行 / 底部拇指区
// ═══════════════════════════════════════════════════════════════════

class _StopDots extends StatelessWidget {
  const _StopDots({required this.count, required this.cur, required this.onPick});

  final int count;
  final int cur;
  final ValueChanged<int> onPick;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => onPick(i),
            child: Container(
              width: i == cur ? 20 : 7,
              height: 7,
              margin: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                color: i == cur ? _T.amber : const Color(0x29FFFFFF),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ),
      ],
    );
  }
}

class _SignalHint extends StatelessWidget {
  const _SignalHint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const CircleAvatar(radius: 2.5, backgroundColor: _T.amber),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontSize: 10.5, letterSpacing: 0.6, color: _T.t3),
            ),
          ),
        ],
      ),
    );
  }
}

/// Agent 信号气泡（设计稿 agent-bubble）：感知到 rain/behind 时的说明条
class _AgentNoteBubble extends StatelessWidget {
  const _AgentNoteBubble({required this.text, required this.onDismiss});

  final String text;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: <Color>[Color(0x1FF5A552), Color(0x08F5A552)],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0x38F5A552)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: _T.amberSoft,
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Icon(Icons.auto_awesome, size: 15, color: _T.amber),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 12.3, height: 1.62, color: _T.t2),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: onDismiss,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: _T.amberLine),
              ),
              child: const Text("知道了",
                  style: TextStyle(fontSize: 11.5, color: _T.amber)),
            ),
          ),
        ],
      ),
    );
  }
}

class _ThumbBar extends StatelessWidget {
  const _ThumbBar({
    required this.next,
    required this.onGo,
    required this.onMap,
    required this.onSheet,
  });

  final _Stop? next;
  final VoidCallback onGo;
  final VoidCallback onMap;
  final VoidCallback onSheet;

  @override
  Widget build(BuildContext context) {
    final _Leg? leg = next?.leg;
    final String goLabel = next == null
        ? "结束今日 · 回酒店"
        : "前往 ${next!.name}${leg != null && leg.minutes > 0 ? " · ${leg.label} ${leg.minutes} 分钟" : ""}";
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 10, 24, 20 + MediaQuery.paddingOf(context).bottom),
      child: Column(
        children: <Widget>[
          SizedBox(
            width: double.infinity,
            height: 54,
            child: FilledButton(
              onPressed: onGo,
              style: FilledButton.styleFrom(
                backgroundColor: _T.amber,
                foregroundColor: const Color(0xFF201407),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                textStyle: const TextStyle(
                    fontSize: 15.5, fontWeight: FontWeight.w700, letterSpacing: 0.5),
              ),
              child: Text(
                goLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              _GhostButton(icon: Icons.map_outlined, label: "路线地图", onTap: onMap),
              const SizedBox(width: 10),
              _GhostButton(icon: Icons.view_timeline_outlined, label: "看全程", onTap: onSheet),
            ],
          ),
        ],
      ),
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      shape: const StadiumBorder(side: BorderSide(color: _T.line)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 14, color: _T.t2),
              const SizedBox(width: 6),
              Text(label, style: const TextStyle(fontSize: 12.5, color: _T.t2)),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 空态
// ═══════════════════════════════════════════════════════════════════

class _EmptyView extends StatelessWidget {
  const _EmptyView();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: _T.amberSoft,
              borderRadius: BorderRadius.circular(18),
            ),
            child: const Icon(Icons.explore_outlined, size: 27, color: _T.amber),
          ),
          const SizedBox(height: 16),
          const Text("暂无行程安排",
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: _T.txt)),
          const SizedBox(height: 8),
          const Text(
            "在对话里让我帮你规划一次旅行，\n生成后的行程会在这里一屏一站地陪你走。",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, height: 2, color: _T.t3),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 全程抽屉（78% 上滑）：Day 切换 + 时间轴列表
// ═══════════════════════════════════════════════════════════════════

class _AllDaySheet extends StatelessWidget {
  const _AllDaySheet({
    required this.days,
    required this.day,
    required this.cur,
    required this.alts,
    required this.onPick,
    required this.onAddAlt,
  });

  final List<_DayPlan> days;
  final int day;
  final int cur;
  final List<TravelPoi> alts;
  final void Function(int day, int stop) onPick;
  final ValueChanged<TravelPoi> onAddAlt;

  @override
  Widget build(BuildContext context) {
    final _DayPlan curDay = days[day];
    return Container(
      height: MediaQuery.sizeOf(context).height * 0.78,
      decoration: const BoxDecoration(
        color: Color(0xFF14161B),
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        border: Border(top: BorderSide(color: _T.line2)),
      ),
      child: Column(
        children: <Widget>[
          Container(
            width: 40,
            height: 4,
            margin: const EdgeInsets.only(top: 10, bottom: 4),
            decoration: BoxDecoration(
              color: const Color(0x2EFFFFFF),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                const Text("全程安排",
                    style: TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w600, color: _T.txt)),
                if (days.length > 1)
                  Container(
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      color: _T.card,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: _T.line),
                    ),
                    child: Row(
                      children: <Widget>[
                        for (int i = 0; i < days.length; i++)
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 2),
                            child: GestureDetector(
                              onTap: () => onPick(i, 0),
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 15, vertical: 6),
                                decoration: BoxDecoration(
                                  color: i == day ? _T.txt : Colors.transparent,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Text(
                                  "Day ${i + 1}",
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    fontWeight:
                                        i == day ? FontWeight.w600 : FontWeight.w400,
                                    color: i == day
                                        ? const Color(0xFF15161A)
                                        : _T.t2,
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 30),
              children: <Widget>[
                for (int i = 0; i < curDay.stops.length; i++)
                  _SheetRow(
                    stop: curDay.stops[i],
                    state: i == cur ? "now" : (i < cur ? "done" : "todo"),
                    onTap: () => onPick(day, i),
                  ),
                // Agent 收起的备选站（设计稿 alt-block）：可请求加回
                if (alts.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(13),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: _T.line2),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        const Text("AGENT 暂时收起 · 可请求加回",
                            style: TextStyle(
                                fontSize: 11.5,
                                letterSpacing: 1,
                                color: _T.t3)),
                        for (final TravelPoi alt in alts.take(4))
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(alt.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 13, color: _T.t2)),
                                ),
                                GestureDetector(
                                  onTap: () => onAddAlt(alt),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 12, vertical: 5),
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(999),
                                      border:
                                          Border.all(color: _T.amberLine),
                                    ),
                                    child: const Text("现在就去",
                                        style: TextStyle(
                                            fontSize: 11.5,
                                            color: _T.amber)),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(
                24, 0, 24, 16 + MediaQuery.paddingOf(context).bottom),
            child: SizedBox(
              width: double.infinity,
              height: 46,
              child: OutlinedButton(
                onPressed: () => Navigator.of(context).pop(),
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: _T.line),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  foregroundColor: _T.t2,
                  textStyle: const TextStyle(fontSize: 13.5),
                ),
                child: const Text("收起"),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.stop, required this.state, required this.onTap});

  final _Stop stop;
  final String state; // now | done | todo
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bool now = state == "now";
    final bool done = state == "done";
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 13),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: _T.line)),
        ),
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 46,
              child: Text(
                _t2s(stop.start),
                textAlign: TextAlign.right,
                style: const TextStyle(fontSize: 12, color: _T.t3),
              ),
            ),
            const SizedBox(width: 14),
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: now ? _T.amber : (done ? const Color(0x33FFFFFF) : _T.amberLine),
                shape: BoxShape.circle,
                boxShadow: now
                    ? <BoxShadow>[
                        BoxShadow(
                            color: _T.amber.withValues(alpha: 0.14),
                            blurRadius: 0,
                            spreadRadius: 4),
                      ]
                    : null,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    stop.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: done ? _T.t3 : _T.txt,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    "停留 ${stop.duration} 分${stop.leg != null && stop.leg!.minutes > 0 ? " · ${stop.leg!.label} ${stop.leg!.minutes} 分" : ""}",
                    style: const TextStyle(fontSize: 11, color: _T.t3),
                  ),
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: _T.line),
              ),
              child: Text(stop.tag, style: const TextStyle(fontSize: 10, color: _T.t3)),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 全屏地图（按需呼出）：坐标归一化布点（无坐标回落环形布点）+
// 已走实线（流动光效）+ 未走虚线 + 站点标记 + 底部当前站条
// ═══════════════════════════════════════════════════════════════════

class _RouteMapOverlay extends StatefulWidget {
  const _RouteMapOverlay({
    required this.dayName,
    required this.stops,
    required this.cur,
    required this.onClose,
    required this.onPick,
    required this.onSheet,
  });

  final String dayName;
  final List<_Stop> stops;
  final int cur;
  final VoidCallback onClose;
  final ValueChanged<int> onPick;
  final VoidCallback onSheet;

  @override
  State<_RouteMapOverlay> createState() => _RouteMapOverlayState();
}

class _RouteMapOverlayState extends State<_RouteMapOverlay>
    with TickerProviderStateMixin {
  late final AnimationController _flow =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
        ..repeat();
  late final AnimationController _ping =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))
        ..repeat();

  @override
  void dispose() {
    _flow.dispose();
    _ping.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _T.screen,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: <Widget>[
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      const Text("TODAY ROUTE",
                          style: TextStyle(
                              fontSize: 11, letterSpacing: 2.4, color: _T.t3)),
                      Text(widget.dayName,
                          style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: _T.txt)),
                    ],
                  ),
                  GestureDetector(
                    onTap: widget.onClose,
                    child: Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: _T.card,
                        shape: BoxShape.circle,
                        border: Border.all(color: _T.line),
                      ),
                      child: const Icon(Icons.close_rounded, size: 18, color: _T.txt),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: _RouteCanvas(
                  stops: widget.stops,
                  cur: widget.cur,
                  flow: _flow,
                  ping: _ping,
                  onPick: widget.onPick,
                ),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(
                  22, 8, 22, 22 + MediaQuery.paddingOf(context).bottom),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
                decoration: BoxDecoration(
                  color: _T.card,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: _T.line),
                ),
                child: Row(
                  children: <Widget>[
                    Container(
                      width: 11,
                      height: 11,
                      decoration: const BoxDecoration(
                        color: _T.amber,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 13),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          const Text("当前", style: TextStyle(fontSize: 10.5, color: _T.t3)),
                          Text(
                            "${widget.stops[widget.cur].name} · ${_t2s(widget.stops[widget.cur].start)}",
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: _T.txt),
                          ),
                        ],
                      ),
                    ),
                    GestureDetector(
                      onTap: widget.onSheet,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: _T.amberLine),
                        ),
                        child: const Text("看全程",
                            style: TextStyle(fontSize: 12.5, color: _T.amber)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 站点画布：布局计算与命中检测共用 [routePoints]
class _RouteCanvas extends StatelessWidget {
  const _RouteCanvas({
    required this.stops,
    required this.cur,
    required this.flow,
    required this.ping,
    required this.onPick,
  });

  final List<_Stop> stops;
  final int cur;
  final Animation<double> flow;
  final Animation<double> ping;
  final ValueChanged<int> onPick;

  /// 布点：≥2 个真实坐标 → 经纬度归一化；否则环形布点（设计稿 autoXY）
  static List<Offset> routePoints(Size size, List<_Stop> stops) {
    final List<Offset> pts = <Offset>[];
    final List<_Stop> withCoord = <_Stop>[
      for (final _Stop s in stops)
        if (s.latitude != null && s.longitude != null) s,
    ];
    if (withCoord.length >= 2) {
      double minLat = withCoord.map((_Stop s) => s.latitude!).reduce(math.min);
      double maxLat = withCoord.map((_Stop s) => s.latitude!).reduce(math.max);
      double minLng = withCoord.map((_Stop s) => s.longitude!).reduce(math.min);
      double maxLng = withCoord.map((_Stop s) => s.longitude!).reduce(math.max);
      if (maxLat - minLat < 1e-6) maxLat = minLat + 1e-3;
      if (maxLng - minLng < 1e-6) maxLng = minLng + 1e-3;
      const double padH = 70, padT = 60, padB = 60;
      for (final _Stop s in stops) {
        if (s.latitude != null && s.longitude != null) {
          pts.add(Offset(
            padH +
                (s.longitude! - minLng) / (maxLng - minLng) *
                    (size.width - padH * 2),
            padT +
                (1 - (s.latitude! - minLat) / (maxLat - minLat)) *
                    (size.height - padT - padB),
          ));
        } else {
          pts.add(const Offset(-100, -100)); // 无坐标站不参与连线
        }
      }
    } else {
      final double cx = size.width / 2;
      final double cy = size.height * 0.46;
      final double rx = math.min(140, size.width * 0.3);
      final double ry = math.min(230, size.height * 0.36);
      for (int i = 0; i < stops.length; i++) {
        final double a = math.pi * 2 * i / math.max(stops.length, 1) - math.pi / 2;
        pts.add(Offset(cx + rx * math.cos(a), cy + ry * math.sin(a)));
      }
    }
    return pts;
  }

  /// Catmull-Rom → 三次贝塞尔（与设计稿 smooth() 同口径）
  static Path smoothPath(List<Offset> pts) {
    final Path path = Path();
    if (pts.length < 2) return path;
    path.moveTo(pts[0].dx, pts[0].dy);
    for (int i = 0; i < pts.length - 1; i++) {
      final Offset p0 = i > 0 ? pts[i - 1] : pts[i];
      final Offset p1 = pts[i];
      final Offset p2 = pts[i + 1];
      final Offset p3 = i + 2 < pts.length ? pts[i + 2] : pts[i + 1];
      path.cubicTo(
        p1.dx + (p2.dx - p0.dx) / 6, p1.dy + (p2.dy - p0.dy) / 6,
        p2.dx - (p3.dx - p1.dx) / 6, p2.dy - (p3.dy - p1.dy) / 6,
        p2.dx, p2.dy,
      );
    }
    return path;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints c) {
        final Size size = Size(c.maxWidth, c.maxHeight);
        final List<Offset> pts = routePoints(size, stops);
        // 参与连线的点 = 有坐标（或环形兜底全体）
        final List<Offset> linked =
            pts.where((Offset p) => p.dx >= 0).toList();

        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: (TapUpDetails d) {
            for (int i = 0; i < pts.length; i++) {
              if ((pts[i] - d.localPosition).distance <= 24) {
                onPick(i);
                return;
              }
            }
          },
          child: AnimatedBuilder(
            animation: Listenable.merge(<Listenable>[flow, ping]),
            builder: (BuildContext context, _) => CustomPaint(
              size: size,
              painter: _RoutePainter(
                pts: linked,
                cur: cur,
                flowPhase: flow.value,
                pingPhase: ping.value,
              ),
              foregroundPainter: _MarkerPainter(pts: pts, stops: stops, cur: cur),
            ),
          ),
        );
      },
    );
  }
}

class _RoutePainter extends CustomPainter {
  _RoutePainter({
    required this.pts,
    required this.cur,
    required this.flowPhase,
    required this.pingPhase,
  });

  final List<Offset> pts;
  final int cur;
  final double flowPhase;
  final double pingPhase;

  static Path _dash(Path src, double dash, double gap, double phase) {
    final Path out = Path();
    for (final PathMetric m in src.computeMetrics()) {
      double d = -phase * (dash + gap);
      while (d < m.length) {
        final double s = math.max(0, d);
        final double e = math.min(m.length, d + dash);
        if (e > s) out.addPath(m.extractPath(s, e), Offset.zero);
        d += dash + gap;
      }
    }
    return out;
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (pts.length < 2) return;
    // 背景网格（rgba(255,255,255,.035)）
    final Paint grid = Paint()
      ..color = const Color(0x09FFFFFF)
      ..strokeWidth = 1;
    for (double x = 40; x < size.width; x += 48) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), grid);
    }
    for (double y = 40; y < size.height; y += 48) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    final int doneCount = math.min(cur + 1, pts.length);
    if (doneCount >= 2) {
      final Path donePath = _RouteCanvas.smoothPath(pts.sublist(0, doneCount));
      // 已走：实线 + 流动光效
      canvas.drawPath(
        donePath,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.8
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round
          ..color = _T.amber,
      );
      canvas.drawPath(
        _dash(donePath, 1, 14, flowPhase),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.8
          ..strokeCap = StrokeCap.round
          ..color = const Color(0xE6FFEED4),
      );
    }
    if (cur < pts.length - 1) {
      final Path todoPath = _RouteCanvas.smoothPath(pts.sublist(cur));
      // 未走：虚线（amber 32%）
      canvas.drawPath(
        _dash(todoPath, 2, 7, 0),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.4
          ..strokeCap = StrokeCap.round
          ..color = const Color(0x52F5A552),
      );
    }
    // 当前站 here 光标（外圈 ping + 内点）
    final Offset here = pts[math.min(cur, pts.length - 1)];
    final double pr = 6 + 10 * pingPhase;
    canvas.drawCircle(
      here,
      pr,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = _T.amber.withValues(alpha: (1 - pingPhase).clamp(0.0, 1.0)),
    );
    canvas.drawCircle(here, 3.4, Paint()..color = _T.amber);
  }

  @override
  bool shouldRepaint(_RoutePainter old) =>
      old.cur != cur || old.flowPhase != flowPhase || old.pingPhase != pingPhase;
}

class _MarkerPainter extends CustomPainter {
  _MarkerPainter({required this.pts, required this.stops, required this.cur});

  final List<Offset> pts;
  final List<_Stop> stops;
  final int cur;

  @override
  void paint(Canvas canvas, Size size) {
    int num = 0;
    final TextPainter tp = TextPainter(textDirection: TextDirection.ltr);
    for (int i = 0; i < pts.length; i++) {
      if (stops[i].kind == "stay") continue;
      num++;
      final bool now = i == cur;
      final bool done = i < cur;
      final Offset p = pts[i];
      canvas.drawCircle(
        p,
        11,
        Paint()
          ..color = now
              ? _T.amber
              : (done ? const Color(0xFF2A2D35) : _T.card2),
      );
      canvas.drawCircle(
        p,
        11,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6
          ..color = now
              ? _T.amber
              : (done ? const Color(0x2EFFFFFF) : _T.amberLine),
      );
      tp.text = TextSpan(
        text: num.toString(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: now
              ? const Color(0xFF201407)
              : (done ? _T.t3 : _T.t2),
        ),
      );
      tp.layout();
      tp.paint(canvas, p - Offset(tp.width / 2, tp.height / 2));
      // 站名标签（右侧 / 越界换左侧）
      final String label = stops[i].name.split(" · ").first;
      final bool right = p.dx < size.width - 120;
      tp.text = TextSpan(
        text: label,
        style: const TextStyle(fontSize: 11, color: _T.t2),
      );
      tp.layout(maxWidth: 110);
      final double lx = right ? p.dx + 14 : p.dx - 14 - tp.width;
      final double ly = p.dy - 13;
      tp.paint(canvas, Offset(lx.clamp(4, math.max(4, size.width - tp.width - 4)), ly));
    }
  }

  @override
  bool shouldRepaint(_MarkerPainter old) => old.cur != cur;
}

// ═══════════════════════════════════════════════════════════════════
// 站点详情页：大图头图 + 时间档 + 事实 chip + 安排理由 + 介绍/贴士/
// 实用信息 + 到达·下一站动线 + 本日站点 chips
// ═══════════════════════════════════════════════════════════════════

class _StopDetailPage extends StatelessWidget {
  const _StopDetailPage({
    required this.destination,
    required this.day,
    required this.dayIndex,
    required this.stopIndex,
    required this.onPickStop,
    required this.onAskAgent,
    required this.onComment,
  });

  final String destination;
  final _DayPlan day;
  final int dayIndex;
  final int stopIndex;
  final void Function(int day, int stop) onPickStop;

  /// 「问 Agent」：回聊天并预填带本站上下文的问题
  final VoidCallback onAskAgent;

  /// 「跟 Agent 提意见」：换一换（同类 POI + 局部重排）
  final VoidCallback onComment;

  @override
  Widget build(BuildContext context) {
    final _Stop stop = day.stops[stopIndex];
    final _Stop? next =
        stopIndex + 1 < day.stops.length ? day.stops[stopIndex + 1] : null;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: _T.screen,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // ── 大图头图 ──
            SizedBox(
              height: 300,
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  if (stop.images.isNotEmpty)
                    CachedMediaImage(
                      url: stop.images.first,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const _NoImageFallback(),
                    )
                  else
                    const _NoImageFallback(),
                  const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        stops: <double>[0.30, 1.0],
                        colors: <Color>[Colors.transparent, Color(0xF00B0C0E)],
                      ),
                    ),
                  ),
                  SafeArea(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Padding(
                          padding: const EdgeInsets.only(left: 14, top: 6),
                          child: GestureDetector(
                            onTap: () => Navigator.of(context).pop(),
                            child: Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                color: const Color(0x8C0B0C0E),
                                shape: BoxShape.circle,
                                border: Border.all(color: _T.line2),
                              ),
                              child: const Icon(Icons.arrow_back_ios_new_rounded,
                                  size: 17, color: _T.txt),
                            ),
                          ),
                        ),
                        const Spacer(),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              _TagPill(stop.tag),
                              const SizedBox(height: 8),
                              Text(
                                "${stop.timeText}${stop.anchor ? " · 时间锚点" : ""}",
                                style: const TextStyle(
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w600,
                                    letterSpacing: 1,
                                    color: _T.amber)),
                              const SizedBox(height: 3),
                              Text(
                                stop.name,
                                style: const TextStyle(
                                    fontSize: 26,
                                    fontWeight: FontWeight.w700,
                                    height: 1.25,
                                    color: _T.txt),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            // ── 滚动内容 ──
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 16, 24, 28),
                children: <Widget>[
                  // 事实 chips
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: <Widget>[
                      _FactChip("建议停留 ${stop.duration} 分"),
                      if (stop.price.isNotEmpty) _FactChip(stop.price),
                      if (stop.addr.isNotEmpty)
                        _FactChip(stop.addr, icon: Icons.place_outlined),
                    ],
                  ),
                  if (stop.note.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 16),
                    _AgentBubble(text: stop.note),
                  ],
                  if (stop.desc.isNotEmpty && stop.desc != stop.note) ...<Widget>[
                    const SizedBox(height: 22),
                    const _SecHeader("介绍"),
                    const SizedBox(height: 9),
                    Text(stop.desc,
                        style: const TextStyle(
                            fontSize: 13.5, height: 1.7, color: _T.t2)),
                  ],
                  if (stop.tips.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 22),
                    const _SecHeader("贴士"),
                    const SizedBox(height: 9),
                    for (final String tip in stop.tips)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 7),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Container(
                              width: 5,
                              height: 5,
                              margin: const EdgeInsets.only(top: 7),
                              decoration: const BoxDecoration(
                                  color: _T.amber, shape: BoxShape.circle),
                            ),
                            const SizedBox(width: 9),
                            Expanded(
                              child: Text(tip,
                                  style: const TextStyle(
                                      fontSize: 12.5, height: 1.6, color: _T.t2)),
                            ),
                          ],
                        ),
                      ),
                  ],
                  if (stop.addr.isNotEmpty || stop.price.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 22),
                    const _SecHeader("实用信息"),
                    const SizedBox(height: 10),
                    _InfoCard(stop: stop),
                  ],
                  const SizedBox(height: 22),
                  const _SecHeader("到达 · 下一站"),
                  const SizedBox(height: 10),
                  _ArriveFlow(stop: stop, next: next),
                  // 对话闭环入口：让 Agent 换掉这一站 / 就这一站继续问
                  const SizedBox(height: 14),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: _DetailGhostButton(
                          icon: Icons.sync_alt_rounded,
                          label: "跟 Agent 提意见",
                          onTap: onComment,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _DetailGhostButton(
                          icon: Icons.forum_outlined,
                          label: "问 Agent",
                          onTap: onAskAgent,
                        ),
                      ),
                    ],
                  ),
                  if (day.stops.length > 1) ...<Widget>[
                    const SizedBox(height: 22),
                    const _SecHeader("本日站点"),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: <Widget>[
                        for (int i = 0; i < day.stops.length; i++)
                          GestureDetector(
                            onTap: () => onPickStop(dayIndex, i),
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 13, vertical: 8),
                              decoration: BoxDecoration(
                                color: i == stopIndex ? _T.amber : _T.card,
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                    color: i == stopIndex ? _T.amber : _T.line),
                              ),
                              child: Text(
                                "${_t2s(day.stops[i].start)} ${day.stops[i].name}",
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: i == stopIndex
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                  color: i == stopIndex
                                      ? const Color(0xFF201407)
                                      : _T.t2,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            // ── 底部主按钮 ──
            Padding(
              padding: EdgeInsets.fromLTRB(
                  24, 10, 24, 20 + MediaQuery.paddingOf(context).bottom),
              child: SizedBox(
                width: double.infinity,
                height: 54,
                child: FilledButton(
                  onPressed:
                      next == null ? null : () => onPickStop(dayIndex, stopIndex + 1),
                  style: FilledButton.styleFrom(
                    backgroundColor: _T.amber,
                    disabledBackgroundColor: _T.card2,
                    foregroundColor: const Color(0xFF201407),
                    disabledForegroundColor: _T.t3,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                    textStyle:
                        const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
                  ),
                  child: Text(
                    next == null
                        ? "今日到此结束 · 回酒店休整"
                        : "前往 ${next.name}${next.leg != null && next.leg!.minutes > 0 ? " · ${next.leg!.label} ${next.leg!.minutes} 分钟" : ""}",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TagPill extends StatelessWidget {
  const _TagPill(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0x8C0B0C0E),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0x24FFFFFF)),
      ),
      child: Text(text,
          style: const TextStyle(
              fontSize: 10.5, letterSpacing: 1, color: _T.txt)),
    );
  }
}

class _FactChip extends StatelessWidget {
  const _FactChip(this.text, {this.icon});

  final String text;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(
        color: _T.card,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: _T.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 12, color: _T.amber),
            const SizedBox(width: 5),
          ],
          Flexible(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11.5, color: _T.t2)),
          ),
        ],
      ),
    );
  }
}

class _AgentBubble extends StatelessWidget {
  const _AgentBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: <Color>[Color(0x1FF5A552), Color(0x08F5A552)],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0x38F5A552)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: _T.amberSoft,
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Icon(Icons.auto_awesome, size: 15, color: _T.amber),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(text,
                style:
                    const TextStyle(fontSize: 12.3, height: 1.62, color: _T.t2)),
          ),
        ],
      ),
    );
  }
}

class _SecHeader extends StatelessWidget {
  const _SecHeader(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          letterSpacing: 1.5,
          color: _T.t3),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.stop});

  final _Stop stop;

  @override
  Widget build(BuildContext context) {
    final List<(IconData, String, String)> rows = <(IconData, String, String)>[
      if (stop.addr.isNotEmpty) (Icons.place_outlined, "地址", stop.addr),
      if (stop.price.isNotEmpty) (Icons.confirmation_number_outlined, "费用", stop.price),
      (Icons.schedule_rounded, "时段", "${stop.timeText} · 建议 ${stop.duration} 分钟"),
    ];
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: _T.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _T.line),
      ),
      child: Column(
        children: <Widget>[
          for (int i = 0; i < rows.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(rows[i].$1, size: 15, color: _T.amber),
                const SizedBox(width: 10),
                SizedBox(
                  width: 34,
                  child: Text(rows[i].$2,
                      style: const TextStyle(fontSize: 12, color: _T.t3)),
                ),
                Expanded(
                  child: Text(rows[i].$3,
                      style: const TextStyle(
                          fontSize: 12.5, height: 1.55, color: _T.txt)),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 详情页幽灵按钮（提意见 / 问 Agent）
class _DetailGhostButton extends StatelessWidget {
  const _DetailGhostButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: _T.card,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          height: 46,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _T.line),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 15, color: _T.t2),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12.5, color: _T.t2),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ArriveFlow extends StatelessWidget {
  const _ArriveFlow({required this.stop, required this.next});

  final _Stop stop;
  final _Stop? next;

  IconData _modeIcon(String? mode) => switch (mode) {
        "bike" => Icons.directions_bike_rounded,
        "taxi" => Icons.local_taxi_rounded,
        "boat" => Icons.directions_boat_rounded,
        _ => Icons.directions_walk_rounded,
      };

  @override
  Widget build(BuildContext context) {
    final _Leg? leg = next?.leg;
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: _T.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _T.line),
      ),
      child: Row(
        children: <Widget>[
          if (leg != null && leg.minutes > 0) ...<Widget>[
            Icon(_modeIcon(leg.mode), size: 18, color: _T.amber),
            const SizedBox(width: 9),
            Text("${leg.label} ${leg.minutes} 分钟 · ${leg.dist}",
                style: const TextStyle(fontSize: 12.5, color: _T.t2)),
            const SizedBox(width: 9),
            const Icon(Icons.arrow_forward_rounded, size: 14, color: _T.t3),
            const SizedBox(width: 9),
          ],
          Expanded(
            child: Text(
              next == null ? "今日到此结束 · 回酒店休整" : next!.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontSize: 13.5, fontWeight: FontWeight.w600, color: _T.txt),
            ),
          ),
        ],
      ),
    );
  }
}
