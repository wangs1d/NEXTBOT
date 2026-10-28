import "dart:async" show Timer, unawaited;
import "dart:convert";
import "dart:io" show File, Platform, Process;
import "dart:math" as math;
import "dart:typed_data" show ByteData;
import "dart:ui" as ui show Image, ImageByteFormat;
import "dart:ui" show FontFeature, ImageFilter;

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show RenderRepaintBoundary;
import "package:flutter/services.dart"
    show
        Clipboard,
        ClipboardData,
        KeyDownEvent,
        KeyRepeatEvent,
        LogicalKeyboardKey;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/link_utils.dart";
import "../../widgets/app_window_titlebar.dart";
import "media_disk_cache.dart";
import "travel_image_warmer.dart";
import "travel_plan_mobile_page.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";
import "travel_plan_window.dart";
import "travel_theme.dart";

part "travel_ticket_book.dart";
part "travel_plan_text_sheet.dart";

// ═══════════════════════════════════════════════════════════════════
// 旅游界面 v3（应用内「常用工具 → 行程」入口）· 左侧 tab 双空间
//
// 左侧窄 tab = 空间切换：「规划」与「行程」各自占满内容区，互不挤压。
// 规划空间：初始只有垂直居中的罗盘图标 + 输入框，一句话发起后按
// 天数/日期 → 预算档位 → 交通 → 住宿 → 饮食 串行追问（目的地不出卡，
// 只在文字里问），一次只出一张卡，答完即消失；已提供的信息不再出卡；
// 信息齐后真实生成（服务端复用
// PlanningService + travelPlanStore 落盘），先出预算明细卡，用户确认后
// 才展示最终规划文字与行程卡。
// 行程空间：两段导航（即将出发 | 往期）。待出发金章 → 在路上只读条 →
// 已归档绿章，同一段行程原地升级；在途任务与消息留在手机端。
// 往期票根册保持不变，只是搬进第二个 tab。
//
// 协议：POST /travel/plan-session（发起）→ :id/turn（消息/点选）→
// :id/generate（真实生成，10~120s）→ :id/approve（确认预算后出方案）。
// 会话留存（2026-10-26）：每轮落盘 data/travel-plan-sessions/{id}.json；
// GET /travel/plan-sessions 列历史、GET /:id 带 history/dossier/resumeCard
// 供恢复。会话入口收在规划顶栏右侧（历史下拉：新会话 + 历史对话列表），
// 左侧竖栏保持只放「规划/行程」两个 tab（用户拍板）。
// 配色全部走 AppPalette + TravelPalette（随主题深/暖变体热切换）。
// ═══════════════════════════════════════════════════════════════════

/// 左侧竖向 tab 的宽度。
const double _kTabRailWidth = 64;

/// 对话内容最大宽度（规划页单栏阅读宽度，比主对话更聚焦）。
const double _kContentMaxWidth = 720;

/// 阶段卡宽度：铺满 720 内容列并留出呼吸边（窄窗时随列收缩）。
const double _kCardWidth = 660;

/// 行程页内容轴：两段 tab、在途状态条、即将出发列表共用同一条左缘。
const double _kArchiveMaxWidth = 880;

/// 档案栏宽度；中栏 + 档案栏放不下这个组合时（可用宽度低于门槛），
/// 档案降级成顶部「已定」胶囊条。
const double _kDossierWidth = 300;
const double _kDossierBreakpoint = 1020;

/// 卡片规范：16 圆角 / 16 内边距 / 主按钮 10 圆角。
const double _kCardRadius = 16;
const double _kCardPad = 16;
const double _kBtnRadius = 10;

/// 规划页字体：内嵌 HarmonyOS Sans SC（开口大、小字更清透），回退 MiSans/系统。
const String _kFontFamily = "HarmonyOS Sans SC";
const List<String> _kFontFallback = <String>[
  "MiSans",
  "Noto Sans SC",
  "Microsoft YaHei",
];

/// 行程摘要（GET /travel/plans 的单条记录）。
class _PlanSummary {
  const _PlanSummary({
    required this.planId,
    required this.title,
    required this.destination,
    required this.startDate,
    required this.endDate,
    required this.dayCount,
    required this.stopCount,
    required this.createdAt,
    this.progress,
    this.totalCost,
    this.coverImage = "",
  });

  factory _PlanSummary.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? rawProgress =
        json["progress"] is Map<String, dynamic>
            ? json["progress"] as Map<String, dynamic>
            : null;
    return _PlanSummary(
      planId: json["planId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      destination: json["destination"]?.toString() ?? "",
      startDate: json["startDate"]?.toString() ?? "",
      endDate: json["endDate"]?.toString() ?? "",
      dayCount: (json["dayCount"] as num?)?.toInt() ?? 0,
      stopCount: (json["stopCount"] as num?)?.toInt() ?? 0,
      createdAt: (json["createdAt"] as num?)?.toInt() ?? 0,
      progress: rawProgress == null
          ? null
          : (
              day: (rawProgress["day"] as num?)?.toInt() ?? 0,
              stop: (rawProgress["stop"] as num?)?.toInt() ?? 0,
            ),
      totalCost: (json["totalCost"] as num?)?.toDouble(),
      coverImage: json["coverImage"]?.toString() ?? "",
    );
  }

  final String planId;
  final String title;
  final String destination;
  final String startDate;
  final String endDate;
  final int dayCount;
  final int stopCount;
  final int createdAt;

  /// 行程进度摘要（day/stop 0 基索引；无记录为 null）。
  final ({int day, int stop})? progress;

  final double? totalCost;
  final String coverImage;

  String get displayTitle => title.isEmpty ? destination : title;

  /// 日期区间标签（同一天只显示一天）。
  String get dateRangeLabel {
    final String s = startDate.trim();
    final String e = endDate.trim();
    if (s.isEmpty && e.isEmpty) return "";
    if (s == e || e.isEmpty) return s;
    if (s.isEmpty) return e;
    return "$s ~ $e";
  }

  /// 行程状态：未开始 / 进行中 / 已结束（按今天日期与区间比较）。
  ({String label, bool active}) status() {
    String two(int v) => v.toString().padLeft(2, "0");
    final DateTime now = DateTime.now();
    final String today = "${now.year}-${two(now.month)}-${two(now.day)}";
    if (startDate.isNotEmpty && today.compareTo(startDate) < 0) {
      return (label: "未开始", active: false);
    }
    if (endDate.isNotEmpty && today.compareTo(endDate) > 0) {
      return (label: "已结束", active: false);
    }
    return (label: "进行中", active: true);
  }

  /// 归属分组：0 进行中 / 1 即将出发 / 2 往期。
  int get bucket {
    final ({String label, bool active}) s = status();
    if (s.active) return 0;
    return s.label == "未开始" ? 1 : 2;
  }

  /// 距出发天数（未开始且日期可解析时 ≥1，否则 null）。
  int? get daysUntilStart {
    if (bucket != 1) return null;
    final DateTime? start = DateTime.tryParse(startDate);
    if (start == null) return null;
    final DateTime today = DateTime.now();
    final DateTime startDay = DateTime(start.year, start.month, start.day);
    final DateTime todayDay = DateTime(today.year, today.month, today.day);
    return startDay.difference(todayDay).inDays;
  }

  /// 倒计时标签（还有 N 天 / 明天出发 / 今天出发）。
  String get countdownLabel {
    final int? d = daysUntilStart;
    if (d == null) return "";
    if (d <= 0) return "今天出发";
    if (d == 1) return "明天出发";
    return "还剩 $d 天";
  }

  /// 花费徽章（无记录不显示）。
  String? get costLabel {
    final double? c = totalCost;
    if (c == null || c <= 0) return null;
    if (c >= 10000) return "¥${(c / 10000).toStringAsFixed(1)}w";
    return "¥${c.round()}";
  }

  /// 在途当天序号（0 基）：优先进度记录，缺失时按今天与出发日推算。
  int liveDayIndex() {
    final int maxIndex = dayCount > 0 ? dayCount - 1 : 0;
    final ({int day, int stop})? p = progress;
    if (p != null) {
      if (p.day < 0) return 0;
      return p.day > maxIndex ? maxIndex : p.day;
    }
    final DateTime? start = DateTime.tryParse(startDate);
    if (start == null) return 0;
    final DateTime now = DateTime.now();
    final int offset = DateTime(now.year, now.month, now.day)
        .difference(DateTime(start.year, start.month, start.day))
        .inDays;
    if (offset < 0) return 0;
    return offset > maxIndex ? maxIndex : offset;
  }

  /// 列表标题：多城行程直接给完整路线，否则只写目的地城市。
  String get listTitle {
    final String t = displayTitle;
    if (t.contains("→")) return t;
    return destination.isNotEmpty ? destination : t;
  }

  /// 住宿晚数（N 天 N-1 晚；单日行程为 0）。
  int get nightCount => dayCount > 1 ? dayCount - 1 : 0;
}

/// 历史规划会话摘要（GET /travel/plan-sessions 的单条记录）。
/// 服务端把规划会话落盘到 data/travel-plan-sessions/{id}.json，
/// 客户端凭 id 调 GET /travel/plan-session/:id 恢复对话流。
class _PlanSessionSummary {
  const _PlanSessionSummary({
    required this.id,
    required this.createdAt,
    required this.updatedAt,
    required this.destination,
    required this.days,
    required this.startDate,
    required this.endDate,
    required this.originalMessage,
    required this.state,
    required this.turnCount,
    required this.lastUserMessage,
  });

  factory _PlanSessionSummary.fromJson(Map<String, dynamic> json) {
    return _PlanSessionSummary(
      id: json["id"]?.toString() ?? "",
      createdAt: (json["createdAt"] as num?)?.toInt() ?? 0,
      updatedAt: (json["updatedAt"] as num?)?.toInt() ?? 0,
      destination: json["destination"]?.toString() ?? "",
      days: (json["days"] as num?)?.toInt(),
      startDate: json["startDate"]?.toString() ?? "",
      endDate: json["endDate"]?.toString() ?? "",
      originalMessage: json["originalMessage"]?.toString() ?? "",
      state: json["state"]?.toString() ?? "gathering",
      turnCount: (json["turnCount"] as num?)?.toInt() ?? 0,
      lastUserMessage: json["lastUserMessage"]?.toString() ?? "",
    );
  }

  final String id;
  final int createdAt;
  final int updatedAt;
  final String destination;
  final int? days;
  final String startDate;
  final String endDate;
  final String originalMessage;
  final String state;
  final int turnCount;
  final String lastUserMessage;

  /// 列表标题：目的地优先，没问到目的地就显示原话截断。
  String get displayTitle {
    final String d = destination.trim();
    if (d.isNotEmpty) return d;
    final String m = originalMessage.trim();
    if (m.isEmpty) return "未命名规划";
    return m.length > 18 ? "${m.substring(0, 18)}…" : m;
  }

  /// 状态标签（与服务端 sessionStateLabel 的取值一一对应）。
  String get stateLabel => switch (state) {
        "generated" => "已完成",
        "budget_ready" => "待确认预算",
        "wishlist_ready" => "待补心愿",
        "guide_ready" => "待挑想去",
        "ready" => "待出方案",
        _ => "进行中",
      };

  bool get finished => state == "generated";

  /// 相对时间标签：今天显示 时:分，今年显示 月-日，更早显示 年-月-日。
  String get timeLabel {
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(updatedAt);
    final DateTime now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, "0");
    if (t.year == now.year && t.month == now.month && t.day == now.day) {
      return "${two(t.hour)}:${two(t.minute)}";
    }
    if (t.year == now.year) return "${t.month}-${two(t.day)}";
    return "${t.year}-${two(t.month)}-${two(t.day)}";
  }
}

// ═══════════════════════════════════════════════════════════════════
// 页面骨架：宽窗双栏（左栏行程 + 主区规划流） / 窄窗顶部切换
// ═══════════════════════════════════════════════════════════════════

/// 主对话 → 旅游入口的交接判定（2026-10-24）：旅游规划主战场在旅游界面的
/// 规划对话，主对话只保留单点查询（天气/票价等）。命中即把用户原话带过去。
bool looksLikeTravelPlanningRequest(String text) {
  final String t = text.trim();
  if (t.isEmpty || t.length > 200) return false;
  final bool planWord = RegExp(r"行程|攻略|规划|度假|旅游|旅行|自由行|自驾游|多日游")
      .hasMatch(t);
  final bool dayWord = RegExp(r"(\d+|[一二三四五六七八九十两])\s*[天日]").hasMatch(t);
  final bool tripPhrase =
      RegExp(r"(去|到)[^\s，。！？]{2,10}(玩|旅游|度假|逛|游)").hasMatch(t);
  if (!(planWord || tripPhrase)) return false;
  // 单点查询不交接：「三亚明天天气」「门票多少钱」不是规划行程
  if (!dayWord &&
      RegExp(r"天气|气温|下雨|门票|票价|机票|高铁票|酒店价格|多少钱").hasMatch(t)) {
    return false;
  }
  return true;
}

class TravelPlanArchivePage extends StatefulWidget {
  const TravelPlanArchivePage({super.key, this.seedMessage, this.agentName});

  /// 主对话交接过来的原始诉求：进入即自动发起一轮规划会话。
  final String? seedMessage;

  /// 用户给 Agent 取的名字（空=未设定，界面不显示名字）。
  final String? agentName;

  /// 全屏路由打开（与图库工作台同款打开方式）。
  static Future<void> show(
    BuildContext context, {
    String? seedMessage,
    String? agentName,
  }) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanArchivePage(
          seedMessage: seedMessage,
          agentName: agentName,
        ),
      ),
    );
  }

  @override
  State<TravelPlanArchivePage> createState() => _TravelPlanArchivePageState();
}

class _TravelPlanArchivePageState extends State<TravelPlanArchivePage> {
  late Future<List<_PlanSummary>> _future = _fetchSummaries();
  bool _opening = false;

  /// 左侧 tab：0 规划 / 1 行程。
  int _tab = 0;

  /// 历史规划会话（侧边栏列表；服务端落盘 30 天）。
  List<_PlanSessionSummary> _planSessions = const <_PlanSessionSummary>[];

  /// 当前打开的规划会话（null=新会话，尚未发过消息）。
  String? _activePlanSessionId;

  /// 规划主区句柄：侧边栏「新会话/点历史」直接指挥对话区切换。
  final GlobalKey<_PlanningStageState> _planningKey = GlobalKey<_PlanningStageState>();

  /// 会话列表防抖重拉（每轮对话后状态会变，但不能每秒打一次接口）。
  Timer? _sessionsReloadTimer;

  /// 行程空间当前分段：0 即将出发（默认） / 1 往期。
  int _seg = 0;

  /// 完整行程缓存（打开详情共用，避免重复拉取）。
  final Map<String, TravelPlanData> _planCache = <String, TravelPlanData>{};

  /// 服务端原始行程 JSON 缓存（独立窗口透传用，不经 Dart 模型往返）。
  final Map<String, Map<String, dynamic>> _rawPlanCache =
      <String, Map<String, dynamic>>{};

  /// 详情加载中的请求（同一 planId 并发只发一次，状态条预取与点开共用）。
  final Map<String, Future<TravelPlanData?>> _planFutures =
      <String, Future<TravelPlanData?>>{};

  static const Duration _timeout = Duration(seconds: 6);

  @override
  void initState() {
    super.initState();
    unawaited(_loadPlanSessions());
  }

  @override
  void dispose() {
    _sessionsReloadTimer?.cancel();
    super.dispose();
  }

  /// 拉历史规划会话（侧边栏列表；失败静默，不打断规划主流程）。
  Future<void> _loadPlanSessions() async {
    List<_PlanSessionSummary> list;
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.httpBase}/travel/plan-sessions?limit=30"))
          .timeout(_timeout);
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Object? decoded = jsonDecode(resp.body);
      list = decoded is Map
          ? _parseSessionList(decoded["sessions"] as List<dynamic>?)
          : const <_PlanSessionSummary>[];
    } catch (_) {
      return; // 服务端不支持/网络失败 → 侧边栏维持现状
    }
    if (!mounted) return;
    setState(() => _planSessions = list);
  }

  static List<_PlanSessionSummary> _parseSessionList(List<dynamic>? raw) =>
      <_PlanSessionSummary>[
        for (final dynamic s in raw ?? const <dynamic>[])
          if (s is Map<String, dynamic>) _PlanSessionSummary.fromJson(s),
      ];

  /// 规划区上报「当前会话变了」（新会话出 id / 每轮成功 / 切回新会话）。
  /// 高亮即时更新；列表状态延后防抖重拉，避免每轮打一次接口。
  void _onPlanSessionActive(String? id) {
    if (!mounted) return;
    setState(() => _activePlanSessionId = (id ?? "").isEmpty ? null : id);
    _sessionsReloadTimer?.cancel();
    _sessionsReloadTimer = Timer(const Duration(milliseconds: 800), () {
      if (mounted) unawaited(_loadPlanSessions());
    });
  }

  Future<List<_PlanSummary>> _fetchSummaries() async {
    final http.Response resp = await http
        .get(Uri.parse("${ApiConfig.httpBase}/travel/plans"))
        .timeout(_timeout);
    if (resp.statusCode != 200) {
      throw Exception("HTTP ${resp.statusCode}");
    }
    final Object? decoded = jsonDecode(resp.body);
    final List<dynamic>? raw =
        decoded is Map ? decoded["plans"] as List<dynamic>? : null;
    final List<_PlanSummary> summaries = <_PlanSummary>[
      for (final dynamic item in raw ?? const <dynamic>[])
        if (item is Map<String, dynamic> &&
            (item["planId"]?.toString() ?? "").isNotEmpty)
          _PlanSummary.fromJson(item),
    ];
    // 封面落盘预热：列表一返回就把各封面推进磁盘缓存，卡片渲染走
    // CachedMediaImage，二次进入封面秒解不闪占位。
    MediaDiskCache.instance.warm(<String>[
      for (final _PlanSummary s in summaries)
        if (s.coverImage.isNotEmpty) resolveTravelMediaUrl(s.coverImage),
    ]);
    return summaries;
  }

  /// 拉取完整行程（带进程内缓存），失败返回 null 并提示。
  /// [silent] 用于在途状态条的后台预取：失败不弹提示，状态条自己降级。
  Future<TravelPlanData?> _ensureFullPlan(
    String planId, {
    bool silent = false,
  }) {
    final TravelPlanData? cached = _planCache[planId];
    if (cached != null) return Future<TravelPlanData?>.value(cached);
    final Future<TravelPlanData?> pending = _planFutures.putIfAbsent(
      planId,
      () => _fetchFullPlan(planId, silent: silent),
    );
    return pending.whenComplete(() => _planFutures.remove(planId));
  }

  Future<TravelPlanData?> _fetchFullPlan(
    String planId, {
    required bool silent,
  }) async {
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.httpBase}/travel/plans/$planId"))
          .timeout(const Duration(seconds: 20));
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Object? decoded = jsonDecode(resp.body);
      final Object? rawPlan = decoded is Map ? decoded["plan"] : null;
      if (rawPlan is! Map<String, dynamic>) {
        throw Exception("行程数据缺失");
      }
      final TravelPlanData plan = TravelPlanData.fromPlanJson(rawPlan);
      _rawPlanCache[planId] = rawPlan;
      _planCache[planId] = plan;
      return plan;
    } catch (e) {
      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text("行程详情加载失败：$e", style: const TextStyle(fontSize: 12)),
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 2),
          ),
        );
      }
      return null;
    }
  }

  /// 按平台打开完整行程详情（手机原生页 / 桌面应用内全屏页）。
  Future<void> _openDetail(TravelPlanData plan) async {
    if (_opening) return;
    _opening = true;
    try {
      if (!mounted) return;
      if (Platform.isAndroid || Platform.isIOS) {
        unawaited(TravelPlanMobilePage.show(context, plan: plan));
      } else {
        // 桌面端优先独立系统窗口（与聊天卡片同一条链路）；原始 JSON 缓存
        // 命中时透传服务端行程，spawn 失败再回落应用内全屏路由。
        final Map<String, dynamic>? raw = _rawPlanCache[plan.planId];
        if (raw != null && raw.isNotEmpty) {
          final bool opened = await TravelPlanWindowLauncher.openPlanJson(raw);
          if (opened) return;
        }
        if (!mounted) return;
        unawaited(Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (BuildContext context) =>
                TravelPlanFullscreenPage.fromPlan(plan: plan),
          ),
        ));
      }
    } finally {
      _opening = false;
    }
  }

  /// 左栏卡片点开：拉完整行程后按平台打开详情。
  Future<void> _openFromSummary(_PlanSummary summary) async {
    final TravelPlanData? plan = await _ensureFullPlan(summary.planId);
    if (plan == null || !mounted) return;
    await _openDetail(plan);
  }

  /// 生成 / 复用分享码并复制到剪贴板。
  Future<void> _copyShareCode(_PlanSummary summary) async {
    try {
      final http.Response resp = await http
          .post(Uri.parse("${ApiConfig.httpBase}/travel/plans/${summary.planId}/share"))
          .timeout(_timeout);
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Object? decoded = jsonDecode(resp.body);
      final String code =
          decoded is Map ? decoded["shareCode"]?.toString() ?? "" : "";
      if (code.isEmpty) throw Exception("分享码为空");
      await Clipboard.setData(ClipboardData(text: code));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("分享码 $code 已复制", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("分享码获取失败：$e", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
    }
  }

  /// 删除行程（二次确认 → DELETE → 刷新列表）。
  Future<void> _deletePlan(_PlanSummary summary) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("删除行程", style: TextStyle(fontSize: 16)),
        content: Text(
          "确定删除「${summary.displayTitle}」吗？\n落盘记录与分享码将一并移除，不可恢复。",
          style: const TextStyle(fontSize: 13, height: 1.6),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("取消"),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
              foregroundColor: Theme.of(ctx).colorScheme.onError,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    bool verifiedGone = false;
    try {
      final http.Response resp = await http
          .delete(Uri.parse("${ApiConfig.httpBase}/travel/plans/${summary.planId}"))
          .timeout(_timeout);
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      // 假成功兜底：200 只代表在某个数据根上删掉了；历史上双数据根 split-brain
      // 出过「删 A 根、刷 B 根」的假成功。按 planId 复查列表，仍在即如实报错。
      final List<_PlanSummary> after = await _fetchSummaries();
      verifiedGone =
          !after.any((_PlanSummary s) => s.planId == summary.planId);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("删除失败：$e", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }
    _planCache.remove(summary.planId);
    _refresh();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          verifiedGone
              ? "已删除「${summary.displayTitle}」"
              : "删除未生效：服务端列表仍包含该行程（数据根不一致？）",
          style: const TextStyle(fontSize: 12),
        ),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  /// 刷新左栏列表（规划生成新行程后由规划流回调）。
  void _refresh() {
    if (!mounted) return;
    setState(() {
      _future = _fetchSummaries();
    });
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    // 本页统一用 HarmonyOS Sans SC（全局主题是 MiSans），文字与输入框一起换。
    final ThemeData base = Theme.of(context);
    final TextTheme typography = base.textTheme.apply(
      fontFamily: _kFontFamily,
      fontFamilyFallback: _kFontFallback,
    );
    return Theme(
      data: base.copyWith(
        textTheme: typography,
        primaryTextTheme: typography,
      ),
      child: Scaffold(
        backgroundColor: c.bg,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 原生标题栏是 hidden 的，AppWindowTitleBar 是全窗口唯一的拖拽区与
            // 窗口按钮；本页走整屏路由会把它盖掉，故须自己补回一条。
            const AppWindowTitleBar(),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  _TravelTabRail(
                    colors: c,
                    index: _tab,
                    onChanged: (int v) => setState(() => _tab = v),
                  ),
                  VerticalDivider(width: 1, thickness: 1, color: c.sideSep),
                  Expanded(
                    child: _tab == 0
                        ? _PlanningStage(
                            key: _planningKey,
                            seedMessage: widget.seedMessage,
                            agentName: widget.agentName,
                            sessions: _planSessions,
                            activeSessionId: _activePlanSessionId,
                            onActiveSessionChanged: _onPlanSessionActive,
                            onPlanGenerated: () {
                              _refresh();
                              unawaited(_loadPlanSessions());
                            },
                            onOpenPlan: (String planId) async {
                              final TravelPlanData? plan =
                                  await _ensureFullPlan(planId);
                              if (plan != null) await _openDetail(plan);
                            },
                          )
                        : _ArchivePane(
                            future: _future,
                            seg: _seg,
                            onSegChanged: (int v) => setState(() => _seg = v),
                            loadPlan: (String planId) =>
                                _ensureFullPlan(planId, silent: true),
                            onOpen: _openFromSummary,
                            onShare: _copyShareCode,
                            onDelete: _deletePlan,
                            onRetry: _refresh,
                          ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 左侧竖向 tab：规划 / 行程。
class _TravelTabRail extends StatelessWidget {
  const _TravelTabRail({
    required this.colors,
    required this.index,
    required this.onChanged,
  });

  final _StageColors colors;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: _kTabRailWidth,
      color: colors.side,
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Column(
        children: <Widget>[
          _TabButton(
            colors: colors,
            icon: Icons.explore_outlined,
            label: "规划",
            active: index == 0,
            onTap: () => onChanged(0),
          ),
          const SizedBox(height: 8),
          _TabButton(
            colors: colors,
            icon: Icons.luggage_outlined,
            label: "行程",
            active: index == 1,
            onTap: () => onChanged(1),
          ),
        ],
      ),
    );
  }
}

class _TabButton extends StatefulWidget {
  const _TabButton({
    required this.colors,
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final _StageColors colors;
  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  State<_TabButton> createState() => _TabButtonState();
}

class _TabButtonState extends State<_TabButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final _StageColors c = widget.colors;
    final bool active = widget.active;

    // 选中/悬停一律取主题中性色（与主侧栏 SidebarNavItem 同款），
    // 不再用旅游强调色铺底，跟随深/暖主题切换。
    final Color fg = active
        ? c.text
        : (_hovering ? c.text2 : c.muted);
    final Color bg = active
        ? cs.surfaceContainerHighest
        : (_hovering
            ? cs.surfaceContainer.withValues(alpha: 0.6)
            : Colors.transparent);
    final Color border = cs.outline.withValues(alpha: active ? 0.6 : 0.35);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 50,
          padding: const EdgeInsets.symmetric(vertical: 9),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: border),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(widget.icon, size: 19, color: fg),
              const SizedBox(height: 4),
              Text(
                widget.label,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                  color: fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 行程空间：两个文字 tab（即将出发 | 往期）
//
// 「即将出发」= 在途只读状态条（若有）+ 主票 + 日期行；
// 「往期」= 原票根册，原样搬过来。进行中不再单独成段，随日期原地升级。
// ═══════════════════════════════════════════════════════════════════

/// 返回按钮（退出行程页回到上一界面）。
class _BackButton extends StatelessWidget {
  const _BackButton({required this.colors});

  final _StageColors colors;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => Navigator.of(context).maybePop(),
      child: Container(
        width: 30,
        height: 30,
        decoration: BoxDecoration(
          color: colors.card2,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(Icons.arrow_back_rounded, size: 16, color: colors.text2),
      ),
    );
  }
}

class _ArchivePane extends StatelessWidget {
  const _ArchivePane({
    required this.future,
    required this.seg,
    required this.onSegChanged,
    required this.loadPlan,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
    required this.onRetry,
  });

  final Future<List<_PlanSummary>> future;
  final int seg;
  final ValueChanged<int> onSegChanged;
  final Future<TravelPlanData?> Function(String planId) loadPlan;
  final ValueChanged<_PlanSummary> onOpen;
  final ValueChanged<_PlanSummary> onShare;
  final ValueChanged<_PlanSummary> onDelete;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    return Container(
      color: c.side,
      child: FutureBuilder<List<_PlanSummary>>(
        future: future,
        builder: (
          BuildContext context,
          AsyncSnapshot<List<_PlanSummary>> snapshot,
        ) {
          final List<_PlanSummary> plans =
              snapshot.data ?? const <_PlanSummary>[];
          final List<_PlanSummary> live = <_PlanSummary>[
            for (final _PlanSummary s in plans)
              if (s.bucket == 0) s,
          ]..sort((_PlanSummary a, _PlanSummary b) =>
              _liveSortKey(b).compareTo(_liveSortKey(a)));
          final int upcomingCount =
              plans.where((_PlanSummary s) => s.bucket == 1).length;
          final int pastCount =
              plans.where((_PlanSummary s) => s.bucket == 2).length;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Container(
                height: 46,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration:
                    BoxDecoration(border: Border(bottom: BorderSide(color: c.borderSoft))),
                child: Row(
                  children: <Widget>[
                    _BackButton(colors: c),
                    const SizedBox(width: 10),
                    Text("行程",
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: c.text2)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: _kArchiveMaxWidth),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: _ArchiveTabs(
                      colors: c,
                      seg: seg,
                      counts: <int?>[
                        snapshot.hasData ? upcomingCount : null,
                        snapshot.hasData ? pastCount : null,
                      ],
                      onChanged: onSegChanged,
                    ),
                  ),
                ),
              ),
              if (seg == 0 && live.isNotEmpty) ...<Widget>[
                const SizedBox(height: 12),
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: _kArchiveMaxWidth),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: _LiveStrip(
                        colors: c,
                        plans: live,
                        loadPlan: loadPlan,
                        onOpen: onOpen,
                      ),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 4),
              Expanded(
                child: snapshot.hasError
                    ? _RailError(colors: c, detail: "${snapshot.error}", onRetry: onRetry)
                    : !snapshot.hasData
                        ? Center(
                            child: SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2.4, color: c.accent),
                            ),
                          )
                        : _RailList(
                            colors: c,
                            plans: plans,
                            seg: seg,
                            hasLive: live.isNotEmpty,
                            onOpen: onOpen,
                            onShare: onShare,
                            onDelete: onDelete,
                          ),
              ),
            ],
          );
        },
      ),
    );
  }
}

int _liveSortKey(_PlanSummary s) {
  final DateTime? start = DateTime.tryParse(s.startDate.trim());
  return start?.millisecondsSinceEpoch ?? s.createdAt;
}

class _ArchiveTabSpec {
  const _ArchiveTabSpec(this.label, this.hint);
  final String label;
  final String hint;
}

const List<_ArchiveTabSpec> _kArchiveTabs = <_ArchiveTabSpec>[
  _ArchiveTabSpec("即将出发", "按出发时间 · 最近在前"),
  _ArchiveTabSpec("往期", "按结束时间 · 月份归档"),
];

/// 两段导航：左对齐的文字 tab + 计数 + 2px 下划线。
class _ArchiveTabs extends StatelessWidget {
  const _ArchiveTabs({
    required this.colors,
    required this.seg,
    required this.counts,
    required this.onChanged,
  });

  final _StageColors colors;
  final int seg;
  final List<int?> counts;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext ctx, BoxConstraints cons) {
        final bool showHint = cons.maxWidth >= 440;
        return Container(
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: colors.borderSoft)),
          ),
          child: Row(
            children: <Widget>[
              for (int i = 0; i < _kArchiveTabs.length; i++)
                _tab(context, i),
              if (showHint)
                Expanded(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        _kArchiveTabs[seg].hint,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: _monoStyle(8, colors.muted, spacing: 1.1),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _tab(BuildContext context, int index) {
    final bool active = seg == index;
    final int? count = index < counts.length ? counts[index] : null;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(index),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        margin: const EdgeInsets.only(right: 26),
        padding: const EdgeInsets.only(top: 8, bottom: 7),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: active ? colors.text : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: <Widget>[
            Text(
              _kArchiveTabs[index].label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: active ? colors.text : colors.muted,
              ),
            ),
            if (count != null) ...<Widget>[
              const SizedBox(width: 6),
              Text(
                "$count",
                style: _monoStyle(
                  8,
                  active ? colors.text2 : colors.muted,
                  spacing: .8,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 在途只读条：桌面只看，不做（打卡 / 改时间 / 加站在手机端）
// ═══════════════════════════════════════════════════════════════════

class _LiveToday {
  const _LiveToday({
    this.total = 0,
    this.done = 0,
    this.next,
    this.hasPlan = false,
  });

  /// 当天站点总数（0 = 还没拿到完整行程）。
  final int total;

  /// 已走站数（0 基当前站之前的站）。
  final int done;
  final TravelDayEntry? next;

  /// 完整行程是否已加载成功。
  final bool hasPlan;

}

class _LiveStrip extends StatefulWidget {
  const _LiveStrip({
    required this.colors,
    required this.plans,
    required this.loadPlan,
    required this.onOpen,
  });

  final _StageColors colors;
  final List<_PlanSummary> plans;
  final Future<TravelPlanData?> Function(String planId) loadPlan;
  final ValueChanged<_PlanSummary> onOpen;

  @override
  State<_LiveStrip> createState() => _LiveStripState();
}

class _LiveStripState extends State<_LiveStrip> {
  int _index = 0;
  TravelPlanData? _plan;
  String _loadedId = "";
  bool _loading = true;

  _PlanSummary get _summary => widget.plans[_index];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _LiveStrip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.plans.isEmpty) return;
    final bool changed = oldWidget.plans.isEmpty ||
        oldWidget.plans.length != widget.plans.length ||
        oldWidget.plans.first.planId != widget.plans.first.planId;
    if (changed || _index >= widget.plans.length) {
      _index = 0;
      _plan = null;
      _loadedId = "";
      _loading = true;
      _load();
    }
  }

  Future<void> _load() async {
    if (widget.plans.isEmpty) return;
    final String id = _summary.planId;
    if (id.isEmpty || id == _loadedId) return;
    final TravelPlanData? plan = await widget.loadPlan(id);
    if (!mounted || widget.plans.isEmpty || id != _summary.planId) return;
    setState(() {
      _loadedId = id;
      _plan = plan;
      _loading = false;
    });
  }

  void _cycleLive() {
    if (widget.plans.length <= 1) return;
    setState(() {
      _index = (_index + 1) % widget.plans.length;
      _plan = null;
      _loadedId = "";
      _loading = true;
    });
    _load();
  }

  _LiveToday _resolveToday() {
    final _PlanSummary s = _summary;
    final TravelPlanData? plan = _plan;
    if (plan == null) return const _LiveToday();
    TravelPlanDay? day;
    final String today = _todayIso();
    for (final TravelPlanDay d in plan.days) {
      if (d.date == today) {
        day = d;
        break;
      }
    }
    int dayIndex = s.liveDayIndex();
    if (day == null && dayIndex < plan.days.length) {
      day = plan.days[dayIndex];
    }
    if (day == null) return const _LiveToday(hasPlan: true);
    dayIndex = plan.days.indexOf(day);
    final int total = day.entries.length;
    final ({int day, int stop})? p = s.progress;
    int done = 0;
    if (p != null && p.day == dayIndex) {
      final int stop = p.stop;
      done = stop < 0 ? 0 : (stop > total ? total : stop);
    }
    return _LiveToday(
      total: total,
      done: done,
      next: done < total ? day.entries[done] : null,
      hasPlan: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _PlanSummary s = _summary;
    final bool hasMore = widget.plans.length > 1;
    final _LiveToday today = _resolveToday();
    return LayoutBuilder(
      builder: (BuildContext ctx, BoxConstraints cons) {
        final bool compact = cons.maxWidth < 720;
        final Widget head = _head(c, s, hasMore);
        final Widget stats = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(child: _todayCell(c, today)),
            const SizedBox(width: 18),
            Expanded(flex: 2, child: _nextCell(c, s, today)),
          ],
        );
        final Widget body = compact
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[head, const SizedBox(height: 12), stats],
              )
            : Row(
                children: <Widget>[
                  Expanded(flex: 5, child: head),
                  const SizedBox(width: 20),
                  SizedBox(width: 84, child: _todayCell(c, today)),
                  const SizedBox(width: 20),
                  SizedBox(width: 176, child: _nextCell(c, s, today)),
                  const SizedBox(width: 20),
                  _ticks(c, s),
                ],
              );
        return Tooltip(
          message: "查看这段行程",
          waitDuration: const Duration(milliseconds: 500),
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => widget.onOpen(s),
              child: Container(
                constraints: const BoxConstraints(minHeight: 84),
                padding: EdgeInsets.fromLTRB(18, compact ? 14 : 16, 18, compact ? 14 : 16),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: c.accent.withValues(alpha: .20)),
                  gradient: LinearGradient(
                    begin: Alignment.centerLeft,
                    end: Alignment.centerRight,
                    colors: <Color>[
                      Color.alphaBlend(c.accent.withValues(alpha: .06), c.card2),
                      c.card,
                    ],
                  ),
                ),
                child: body,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _head(_StageColors c, _PlanSummary s, bool hasMore) {
    return Row(
      children: <Widget>[
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: c.accent,
            boxShadow: <BoxShadow>[
              BoxShadow(color: c.accent.withValues(alpha: .45), blurRadius: 8),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text("LIVE · 在路上",
                  style: _monoStyle(8, c.muted, spacing: 1.6)),
              const SizedBox(height: 4),
              Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: <Widget>[
                  Flexible(
                    child: Text(
                      s.listTitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w700,
                        color: c.text,
                      ),
                    ),
                  ),
                  if (s.dayCount > 0) ...<Widget>[
                    const SizedBox(width: 8),
                    Text(
                      "DAY ${s.liveDayIndex() + 1} / ${s.dayCount}",
                      style: _monoStyle(9, c.accent, spacing: .8),
                    ),
                  ],
                  if (hasMore) ...<Widget>[
                    const SizedBox(width: 8),
                    GestureDetector(
                      onTap: _cycleLive,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: c.borderSoft),
                          color: c.card2,
                        ),
                        child: Text(
                          "+${widget.plans.length - 1} 段",
                          style: _monoStyle(8, c.muted, spacing: .4),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _todayCell(_StageColors c, _LiveToday today) {
    final String? subtitle;
    if (!today.hasPlan) {
      subtitle = null;
    } else if (today.total <= 0) {
      subtitle = "今日无站";
    } else if (today.done > 0) {
      subtitle = "已走 ${today.done}";
    } else {
      subtitle = null;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text("今日", style: _monoStyle(8, c.muted, spacing: 1.2)),
        const SizedBox(height: 5),
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: <Widget>[
            Text(
              today.hasPlan ? "${today.total} 站" : "— 站",
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: today.hasPlan ? c.text : c.muted,
              ),
            ),
            if (subtitle != null) ...<Widget>[
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  "· $subtitle",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10, color: c.muted),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _nextCell(_StageColors c, _PlanSummary s, _LiveToday today) {
    final Widget value;
    if (!today.hasPlan) {
      final ({int day, int stop})? p = s.progress;
      value = Text(
        _loading ? "读取中…" : (p != null ? "第 ${p.stop + 1} 站" : "在${s.destination}"),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 11, color: c.muted),
      );
    } else if (today.next == null) {
      value = Text(
        today.total > 0 ? "今日已走完" : "今天没有排站",
        style: TextStyle(fontSize: 11, color: c.text2),
      );
    } else {
      final TravelDayEntry next = today.next!;
      value = Row(
        children: <Widget>[
          Text(
            _hhmm(next.time),
            style: _monoStyle(10, c.accent, spacing: .4, weight: FontWeight.w600),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              next.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: c.text2),
            ),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text("下一站", style: _monoStyle(8, c.muted, spacing: 1.2)),
        const SizedBox(height: 5),
        value,
      ],
    );
  }

  Widget _ticks(_StageColors c, _PlanSummary s) {
    final int total = s.dayCount;
    if (total <= 0) return const SizedBox.shrink();
    if (total > 10) {
      return SizedBox(
        width: 96,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: LinearProgressIndicator(
            value: (s.liveDayIndex() + 1) / total,
            minHeight: 3,
            backgroundColor: c.borderSoft,
            valueColor: AlwaysStoppedAnimation<Color>(c.accent),
          ),
        ),
      );
    }
    final int current = s.liveDayIndex();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (int i = 0; i < total; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            width: i == current ? 16 : 10,
            height: 3,
            margin: EdgeInsets.only(right: i == total - 1 ? 0 : 3),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(2),
              color: i <= current ? c.accent : c.borderSoft,
            ),
          ),
      ],
    );
  }

}

String _todayIso() {
  final DateTime now = DateTime.now();
  String two(int v) => v.toString().padLeft(2, "0");
  return "${now.year}-${two(now.month)}-${two(now.day)}";
}

String _hhmm(String raw) {
  final RegExpMatch? m = RegExp(r"(\d{1,2}:\d{2})").firstMatch(raw);
  return m?.group(1) ?? raw.trim();
}

/// 卡片右上角更多菜单（分享码 / 删除）。
class _CardMenu extends StatelessWidget {
  const _CardMenu({
    required this.colors,
    required this.onShare,
    required this.onDelete,
    this.foreground,
    this.iconSize = 15,
    this.boxSize = 24,
  });

  final _StageColors colors;
  final VoidCallback onShare;
  final VoidCallback onDelete;
  final Color? foreground;
  final double iconSize;
  final double boxSize;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: boxSize,
      height: boxSize,
      child: PopupMenuButton<String>(
        tooltip: "更多操作",
        padding: EdgeInsets.zero,
        iconSize: iconSize,
        color: colors.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: colors.borderSoft),
        ),
        icon: Icon(Icons.more_horiz,
            size: iconSize, color: foreground ?? colors.muted),
        onSelected: (String action) {
          if (action == "share") onShare();
          if (action == "delete") onDelete();
        },
        itemBuilder: (BuildContext ctx) => <PopupMenuEntry<String>>[
          PopupMenuItem<String>(
            value: "share",
            height: 38,
            child: Text("分享码", style: TextStyle(fontSize: 12.5, color: colors.text)),
          ),
          PopupMenuItem<String>(
            value: "delete",
            height: 38,
            child: Text("删除", style: TextStyle(fontSize: 12.5, color: colors.text)),
          ),
        ],
      ),
    );
  }
}

class _RailError extends StatelessWidget {
  const _RailError({
    required this.colors,
    required this.detail,
    required this.onRetry,
  });

  final _StageColors colors;
  final String detail;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text("行程列表加载失败",
              style: TextStyle(fontSize: 12.5, color: colors.text2)),
          const SizedBox(height: 4),
          Text(detail,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10.5, color: colors.muted)),
          const SizedBox(height: 10),
          TextButton(onPressed: onRetry, child: const Text("重试")),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 主区：Agent 驱动规划流
// ═══════════════════════════════════════════════════════════════════

/// 服务端卡片载荷：天气面板。
class _WeatherCardData {
  _WeatherCardData({
    required this.title,
    required this.sub,
    required this.tip,
    required this.days,
  });

  factory _WeatherCardData.fromJson(Map<String, dynamic> json) {
    return _WeatherCardData(
      title: json["title"]?.toString() ?? "目的地天气",
      sub: json["sub"]?.toString() ?? "",
      tip: json["tip"]?.toString() ?? "",
      days: <_WeatherDay>[
        for (final dynamic d in (json["days"] as List<dynamic>? ?? const <dynamic>[]))
          if (d is Map<String, dynamic>)
            _WeatherDay(
              dateLabel: d["dateLabel"]?.toString() ?? "",
              text: d["text"]?.toString() ?? "",
              hi: (d["hi"] as num?)?.round() ?? 0,
              lo: (d["lo"] as num?)?.round() ?? 0,
            ),
      ],
    );
  }

  final String title;
  final String sub;
  final String tip;
  final List<_WeatherDay> days;
}

class _WeatherDay {
  const _WeatherDay({
    required this.dateLabel,
    required this.text,
    required this.hi,
    required this.lo,
  });

  final String dateLabel;
  final String text;
  final int hi;
  final int lo;

  IconData get icon {
    if (text.contains("雷")) return Icons.thunderstorm_outlined;
    if (text.contains("雨")) return Icons.umbrella_outlined;
    if (text.contains("雪")) return Icons.ac_unit;
    if (text.contains("雾") || text.contains("阴")) return Icons.cloud_outlined;
    if (text.contains("云")) return Icons.cloud_outlined;
    return Icons.wb_sunny_outlined;
  }

  Color iconColor(_StageColors c) {
    if (text.contains("雨") || text.contains("雷")) return c.rainBlue;
    if (text.contains("雪")) return c.rainBlue;
    if (text.contains("晴")) return c.orange;
    return c.muted;
  }
}

/// 卡片顶部的进度摘要（已答/总数 + 已确认要点）。
class _CardProgress {
  const _CardProgress({
    required this.done,
    required this.total,
    required this.summary,
  });

  factory _CardProgress.fromJson(Map<String, dynamic> json) {
    return _CardProgress(
      done: (json["done"] as num?)?.toInt() ?? 0,
      total: (json["total"] as num?)?.toInt() ?? 0,
      summary: json["summary"]?.toString() ?? "",
    );
  }

  final int done;
  final int total;
  final String summary;
}

/// 选项 → 推断结论（同行人卡：选了同行人，节奏作为结论直接给出来）。
class _ChoiceInferData {
  const _ChoiceInferData({
    required this.pace,
    required this.detail,
    required this.options,
  });

  factory _ChoiceInferData.fromJson(Map<String, dynamic> json) {
    return _ChoiceInferData(
      pace: json["pace"]?.toString() ?? "",
      detail: json["detail"]?.toString() ?? "",
      options: <String>[
        for (final dynamic o in (json["options"] as List<dynamic>? ?? const <dynamic>[]))
          if (o != null) o.toString(),
      ],
    );
  }

  final String pace;
  final String detail;
  final List<String> options;
}

/// 服务端卡片载荷：选择卡。
class _ChoiceCardData {
  _ChoiceCardData({
    required this.id,
    required this.title,
    required this.multi,
    required this.options,
    this.stage = "",
    this.prefill = const <String>[],
    this.placeholder,
    this.allowNote = false,
    this.progress,
    this.infer = const <String, _ChoiceInferData>{},
  });

  factory _ChoiceCardData.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> rawInfer = json["infer"] is Map<String, dynamic>
        ? json["infer"] as Map<String, dynamic>
        : const <String, dynamic>{};
    return _ChoiceCardData(
      id: json["id"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      stage: json["stage"]?.toString() ?? "",
      multi: json["multi"] == true,
      options: <String>[
        for (final dynamic o in (json["options"] as List<dynamic>? ?? const <dynamic>[]))
          if (o != null) o.toString(),
      ],
      prefill: <String>[
        for (final dynamic o in (json["prefill"] as List<dynamic>? ?? const <dynamic>[]))
          if (o != null) o.toString(),
      ],
      placeholder: json["placeholder"]?.toString(),
      allowNote: json["allowNote"] == true,
      progress: json["progress"] is Map<String, dynamic>
          ? _CardProgress.fromJson(json["progress"] as Map<String, dynamic>)
          : null,
      infer: <String, _ChoiceInferData>{
        for (final MapEntry<String, dynamic> e in rawInfer.entries)
          if (e.value is Map<String, dynamic>)
            e.key: _ChoiceInferData.fromJson(e.value as Map<String, dynamic>),
      },
    );
  }

  final String id;
  final String title;
  /// 阶段名（卡片头部，如「大交通」「住宿」）
  final String stage;
  final bool multi;
  final List<String> options;
  final List<String> prefill;
  final bool allowNote;
  final _CardProgress? progress;
  final String? placeholder;

  /// 选项 → 推断结论（空 = 普通问题卡）。
  final Map<String, _ChoiceInferData> infer;
}

/// 卡面指标胶囊：label 是服务端算好的成品文案，source 是这条数的出处。
/// 客户端原样渲染，不做任何换算或补数。
class _GuideMetricData {
  _GuideMetricData({
    required this.kind,
    required this.label,
    required this.source,
  });

  factory _GuideMetricData.fromJson(Map<String, dynamic> json) {
    return _GuideMetricData(
      kind: json["kind"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      source: json["source"]?.toString() ?? "",
    );
  }

  final String kind;
  final String label;
  final String source;
}

/// 筛选卡条目：名称挂真实指标 + 文字介绍 + 实拍图。没取到的指标服务端就不下发。
class _GuideItemData {
  _GuideItemData({
    required this.name,
    required this.intro,
    required this.photos,
    required this.metrics,
    required this.address,
    required this.picked,
  });

  factory _GuideItemData.fromJson(Map<String, dynamic> json) {
    return _GuideItemData(
      name: json["name"]?.toString() ?? "",
      intro: json["intro"]?.toString() ?? "",
      photos: <String>[
        for (final dynamic p in (json["photos"] as List<dynamic>? ?? const <dynamic>[]))
          if (p != null && p.toString().isNotEmpty) p.toString(),
      ],
      metrics: <_GuideMetricData>[
        for (final dynamic m in (json["metrics"] as List<dynamic>? ?? const <dynamic>[]))
          if (m is Map<String, dynamic>) _GuideMetricData.fromJson(m),
      ],
      address: json["address"]?.toString() ?? "",
      picked: json["picked"] == true,
    );
  }

  final String name;
  final String intro;
  final List<String> photos;
  final List<_GuideMetricData> metrics;
  final String address;

  /// 勾选状态（服务端恒 false，选谁全部由用户在这里定）。
  bool picked;
}

/// 住宿段的落位参照点（离哪儿近）。
class _GuideAnchorData {
  _GuideAnchorData({required this.id, required this.label, required this.why});

  factory _GuideAnchorData.fromJson(Map<String, dynamic> json) {
    return _GuideAnchorData(
      id: json["id"]?.toString() ?? "anchor",
      label: json["label"]?.toString() ?? "",
      why: json["why"]?.toString() ?? "",
    );
  }

  final String id;
  final String label;
  final String why;
}

class _GuideCatData {
  _GuideCatData({
    required this.key,
    required this.label,
    required this.items,
    required this.sortNote,
    this.anchor,
  });

  factory _GuideCatData.fromJson(Map<String, dynamic> json) {
    return _GuideCatData(
      key: json["key"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      items: <_GuideItemData>[
        for (final dynamic i in (json["items"] as List<dynamic>? ?? const <dynamic>[]))
          if (i is Map<String, dynamic>) _GuideItemData.fromJson(i),
      ],
      sortNote: json["sortNote"]?.toString() ?? "",
      anchor: json["anchor"] is Map<String, dynamic>
          ? _GuideAnchorData.fromJson(json["anchor"] as Map<String, dynamic>)
          : null,
    );
  }

  final String key;
  final String label;
  final List<_GuideItemData> items;

  /// 这一段「是按什么排出来的」，由实际参与排序的信号拼出。
  final String sortNote;
  final _GuideAnchorData? anchor;
}

/// 信息齐后、「出方案」前的筛选卡（必玩景点/住宿推荐/美食推荐）。
class _GuideCardData {
  _GuideCardData({
    required this.stage,
    required this.title,
    required this.destination,
    required this.cats,
  });

  factory _GuideCardData.fromJson(Map<String, dynamic> json) {
    return _GuideCardData(
      stage: json["stage"]?.toString() ?? "挑一挑",
      title: json["title"]?.toString() ?? "",
      destination: json["destination"]?.toString() ?? "",
      cats: <_GuideCatData>[
        for (final dynamic c in (json["cats"] as List<dynamic>? ?? const <dynamic>[]))
          if (c is Map<String, dynamic>) _GuideCatData.fromJson(c),
      ],
    );
  }

  final String stage;
  final String title;
  final String destination;
  final List<_GuideCatData> cats;
}

/// 筛选后的自选补充卡（景点/酒店/餐厅自由输入，可跳过）。
class _WishlistCardData {
  _WishlistCardData({
    required this.stage,
    required this.title,
    required this.sub,
    required this.view,
    required this.stay,
    required this.food,
    required this.placeholders,
  });

  factory _WishlistCardData.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> sel =
        json["selected"] is Map<String, dynamic>
            ? json["selected"] as Map<String, dynamic>
            : const <String, dynamic>{};
    final Map<String, dynamic> ph =
        json["placeholders"] is Map<String, dynamic>
            ? json["placeholders"] as Map<String, dynamic>
            : const <String, dynamic>{};
    List<String> listOf(Object? v) => <String>[
          for (final dynamic n in (v as List<dynamic>? ?? const <dynamic>[]))
            if (n != null && n.toString().isNotEmpty) n.toString(),
        ];
    return _WishlistCardData(
      stage: json["stage"]?.toString() ?? "再补一句",
      title: json["title"]?.toString() ?? "还有非去不可的地方吗？",
      sub: json["sub"]?.toString() ?? "",
      view: listOf(sel["view"]),
      stay: listOf(sel["stay"]),
      food: listOf(sel["food"]),
      placeholders: <String, String>{
        for (final String key in const <String>["view", "stay", "food"])
          key: ph[key]?.toString() ?? "",
      },
    );
  }

  final String stage;
  final String title;
  final String sub;
  final List<String> view;
  final List<String> stay;
  final List<String> food;
  final Map<String, String> placeholders;

  bool get hasSelection => view.isNotEmpty || stay.isNotEmpty || food.isNotEmpty;
}

/// 预订卡的大交通腿（去程/返程；飞猪实时班次）。
class _BookingLegData {
  _BookingLegData({
    required this.from,
    required this.to,
    required this.date,
    required this.dep,
    required this.arr,
    required this.fromStation,
    required this.toStation,
    required this.durationMin,
  });

  factory _BookingLegData.fromJson(Map<String, dynamic> json) {
    return _BookingLegData(
      from: json["from"]?.toString() ?? "",
      to: json["to"]?.toString() ?? "",
      date: json["date"]?.toString() ?? "",
      dep: json["dep"]?.toString() ?? "",
      arr: json["arr"]?.toString() ?? "",
      fromStation: json["fromStation"]?.toString() ?? "",
      toStation: json["toStation"]?.toString() ?? "",
      durationMin: (json["durationMin"] as num?)?.toInt(),
    );
  }

  final String from;
  final String to;
  final String date;
  final String dep;
  final String arr;
  final String fromStation;
  final String toStation;
  final int? durationMin;

  /// 「17:40 萧山机场 → 20:15 天府机场」；缺时刻的段如实只报城市。
  String get summary {
    final String fromP = fromStation.isNotEmpty ? fromStation : from;
    final String toP = toStation.isNotEmpty ? toStation : to;
    final String depP = dep.isNotEmpty ? "$dep " : "";
    final String arrP = arr.isNotEmpty ? " $arr" : "";
    return "$depP$fromP →$arrP $toP";
  }
}

/// 预订卡的大交通选项（票价取不到时 amount=null → 卡面标「待核价」）。
class _BookingTransportData {
  _BookingTransportData({
    required this.key,
    required this.mode,
    required this.no,
    required this.carrier,
    required this.outbound,
    required this.inbound,
    required this.amount,
    required this.durationMin,
    required this.viaHub,
    required this.recommended,
  });

  factory _BookingTransportData.fromJson(Map<String, dynamic> json) {
    return _BookingTransportData(
      key: json["key"]?.toString() ?? "",
      mode: json["mode"]?.toString() == "train" ? "train" : "flight",
      no: json["no"]?.toString() ?? "",
      carrier: json["carrier"]?.toString() ?? "",
      outbound: json["outbound"] is Map<String, dynamic>
          ? _BookingLegData.fromJson(json["outbound"] as Map<String, dynamic>)
          : null,
      inbound: json["inbound"] is Map<String, dynamic>
          ? _BookingLegData.fromJson(json["inbound"] as Map<String, dynamic>)
          : null,
      amount: (json["amount"] as num?)?.toDouble(),
      durationMin: (json["durationMin"] as num?)?.toInt(),
      viaHub: json["viaHub"]?.toString() ?? "",
      recommended: json["recommended"] == true,
    );
  }

  final String key;
  final String mode;
  final String no;
  final String carrier;
  final _BookingLegData? outbound;
  final _BookingLegData? inbound;
  final double? amount;
  final int? durationMin;
  final String viaHub;
  final bool recommended;

  bool get isTrain => mode == "train";

  /// 「2小时35分」；null=平台未给耗时。
  String? get durationLabel {
    final int? m = durationMin;
    if (m == null || m <= 0) return null;
    return "${m ~/ 60}小时${m % 60 == 0 ? "" : "${m % 60}分"}";
  }
}

/// 预订卡的酒店选项（飞猪在售，每晚价）。
class _BookingHotelData {
  _BookingHotelData({
    required this.key,
    required this.name,
    required this.amount,
    required this.rating,
    required this.star,
    required this.near,
    required this.image,
    required this.fromPicks,
    required this.recommended,
  });

  factory _BookingHotelData.fromJson(Map<String, dynamic> json) {
    return _BookingHotelData(
      key: json["key"]?.toString() ?? "",
      name: json["name"]?.toString() ?? "",
      amount: (json["amount"] as num?)?.toDouble(),
      rating: (json["rating"] as num?)?.toDouble(),
      star: json["star"]?.toString() ?? "",
      near: json["near"]?.toString() ?? "",
      image: json["image"]?.toString() ?? "",
      fromPicks: json["fromPicks"] == true,
      recommended: json["recommended"] == true,
    );
  }

  final String key;
  final String name;
  final double? amount;
  final double? rating;
  final String star;
  final String near;
  final String image;
  final bool fromPicks;
  final bool recommended;
}

/// 预订选择卡：大交通 + 住宿两段单选，可全不选（先不订按参考价走）。
class _BookingCardData {
  _BookingCardData({
    required this.stage,
    required this.title,
    required this.sub,
    required this.origin,
    required this.destination,
    required this.checkIn,
    required this.checkOut,
    required this.nights,
    required this.transports,
    required this.hotels,
    required this.transportKey,
    required this.hotelKey,
    required this.trial,
  });

  factory _BookingCardData.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> sel = json["selection"] is Map<String, dynamic>
        ? json["selection"] as Map<String, dynamic>
        : const <String, dynamic>{};
    return _BookingCardData(
      stage: json["stage"]?.toString() ?? "预订安排",
      title: json["title"]?.toString() ?? "",
      sub: json["sub"]?.toString() ?? "",
      origin: json["origin"]?.toString() ?? "",
      destination: json["destination"]?.toString() ?? "",
      checkIn: json["checkIn"]?.toString() ?? "",
      checkOut: json["checkOut"]?.toString() ?? "",
      nights: (json["nights"] as num?)?.toInt() ?? 0,
      transports: <_BookingTransportData>[
        for (final dynamic t in (json["transports"] as List<dynamic>? ?? const <dynamic>[]))
          if (t is Map<String, dynamic>) _BookingTransportData.fromJson(t),
      ],
      hotels: <_BookingHotelData>[
        for (final dynamic h in (json["hotels"] as List<dynamic>? ?? const <dynamic>[]))
          if (h is Map<String, dynamic>) _BookingHotelData.fromJson(h),
      ],
      transportKey: sel["transportKey"]?.toString() ?? "",
      hotelKey: sel["hotelKey"]?.toString() ?? "",
      trial: json["trial"] == true,
    );
  }

  final String stage;
  final String title;
  final String sub;
  final String origin;
  final String destination;
  final String checkIn;
  final String checkOut;
  final int nights;
  final List<_BookingTransportData> transports;
  final List<_BookingHotelData> hotels;
  /// 已确认的回显选择（恢复会话时原样带回，卡面勾上）。
  final String transportKey;
  final String hotelKey;
  final bool trial;
}

/// 相邻两站的真实交通腿（OSRM 路网优先，失败降级估算）。
class _DraftLegData {
  _DraftLegData({
    required this.mode,
    required this.durationMin,
    this.distanceKm,
    this.note = "",
  });

  factory _DraftLegData.fromJson(Map<String, dynamic> json) {
    return _DraftLegData(
      mode: json["mode"]?.toString() ?? "",
      durationMin: (json["durationMin"] as num?)?.toInt() ?? 0,
      distanceKm: (json["distanceKm"] as num?)?.toDouble(),
      note: json["note"]?.toString() ?? "",
    );
  }

  final String mode;
  final int durationMin;
  final double? distanceKm;
  final String note;
}

/// 方案里的单站：时刻、交通、开放预约与核实问题。
class _DraftStopData {
  _DraftStopData({
    required this.time,
    required this.name,
    required this.type,
    this.endTime = "",
    this.leg,
    this.visitDuration,
    this.openingHours = "",
    this.booking = "",
    this.price = "",
    this.issues = const <String>[],
  });

  factory _DraftStopData.fromJson(Map<String, dynamic> json) {
    return _DraftStopData(
      time: json["time"]?.toString() ?? "",
      endTime: json["endTime"]?.toString() ?? "",
      name: json["name"]?.toString() ?? "",
      type: json["type"]?.toString() ?? "attraction",
      leg: json["leg"] is Map<String, dynamic>
          ? _DraftLegData.fromJson(json["leg"] as Map<String, dynamic>)
          : null,
      visitDuration: (json["visitDuration"] as num?)?.toInt(),
      openingHours: json["openingHours"]?.toString() ?? "",
      booking: json["booking"]?.toString() ?? "",
      price: json["price"]?.toString() ?? "",
      issues: <String>[
        for (final dynamic x in (json["issues"] as List<dynamic>? ?? const <dynamic>[]))
          if (x != null && x.toString().isNotEmpty) x.toString(),
      ],
    );
  }

  final String time;
  final String endTime;
  final String name;
  final String type;
  final _DraftLegData? leg;
  final int? visitDuration;
  final String openingHours;
  final String booking;
  final String price;
  final List<String> issues;
}

class _DraftDayData {
  _DraftDayData({
    required this.label,
    required this.stops,
    required this.items,
    this.date = "",
    this.theme = "",
    this.weather = "",
    this.travelMin = 0,
  });

  factory _DraftDayData.fromJson(Map<String, dynamic> json) {
    return _DraftDayData(
      label: json["label"]?.toString() ?? "",
      stops: json["stops"]?.toString() ?? "",
      date: json["date"]?.toString() ?? "",
      theme: json["theme"]?.toString() ?? "",
      weather: json["weather"]?.toString() ?? "",
      travelMin: (json["travelMin"] as num?)?.toInt() ?? 0,
      items: <_DraftStopData>[
        for (final dynamic i in (json["items"] as List<dynamic>? ?? const <dynamic>[]))
          if (i is Map<String, dynamic>) _DraftStopData.fromJson(i),
      ],
    );
  }

  final String label;
  final String stops;
  final String date;
  final String theme;
  final String weather;
  final int travelMin;
  final List<_DraftStopData> items;
}

/// 核实问题（闭馆日/开放时段/停止入场/预约/密度）。
class _VerificationIssueData {
  _VerificationIssueData({
    required this.level,
    required this.name,
    required this.message,
    required this.day,
    this.suggestion = "",
  });

  factory _VerificationIssueData.fromJson(Map<String, dynamic> json) {
    return _VerificationIssueData(
      level: json["level"]?.toString() ?? "info",
      name: json["name"]?.toString() ?? "",
      message: json["message"]?.toString() ?? "",
      day: (json["day"] as num?)?.toInt() ?? 0,
      suggestion: json["suggestion"]?.toString() ?? "",
    );
  }

  final String level;
  final String name;
  final String message;
  final int day;
  final String suggestion;
}

class _VerificationData {
  _VerificationData({required this.summary, required this.issues});

  factory _VerificationData.fromJson(Map<String, dynamic> json) {
    return _VerificationData(
      summary: json["summary"]?.toString() ?? "",
      issues: <_VerificationIssueData>[
        for (final dynamic i in (json["issues"] as List<dynamic>? ?? const <dynamic>[]))
          if (i is Map<String, dynamic>) _VerificationIssueData.fromJson(i),
      ],
    );
  }

  final String summary;
  final List<_VerificationIssueData> issues;
}

/// 服务端草案载荷（真实规划结果）。
class _DraftData {
  _DraftData({
    required this.planId,
    required this.title,
    required this.destination,
    required this.days,
    this.startDate = "",
    this.endDate = "",
    this.totalCost,
    this.verification,
    this.wishlistMissed = const <String>[],
  });

  factory _DraftData.fromJson(Map<String, dynamic> json) {
    return _DraftData(
      planId: json["planId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "行程草案",
      destination: json["destination"]?.toString() ?? "",
      startDate: json["startDate"]?.toString() ?? "",
      endDate: json["endDate"]?.toString() ?? "",
      totalCost: (json["totalCost"] as num?)?.toDouble(),
      verification: json["verification"] is Map<String, dynamic>
          ? _VerificationData.fromJson(
              json["verification"] as Map<String, dynamic>)
          : null,
      wishlistMissed: <String>[
        for (final dynamic n in (json["wishlistMissed"] as List<dynamic>? ?? const <dynamic>[]))
          if (n != null && n.toString().isNotEmpty) n.toString(),
      ],
      days: <_DraftDayData>[
        for (final dynamic d in (json["days"] as List<dynamic>? ?? const <dynamic>[]))
          if (d is Map<String, dynamic>) _DraftDayData.fromJson(d),
      ],
    );
  }

  final String planId;
  final String title;
  final String destination;
  final String startDate;
  final String endDate;
  final double? totalCost;
  final _VerificationData? verification;
  final List<String> wishlistMissed;
  final List<_DraftDayData> days;
}

/// 服务端预算明细（真实报价；amount=null 表示该类目未接入计价）。
class _BudgetItemData {
  const _BudgetItemData({
    required this.key,
    required this.label,
    required this.amount,
    this.note = "",
  });

  factory _BudgetItemData.fromJson(Map<String, dynamic> json) {
    return _BudgetItemData(
      key: json["key"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      amount: (json["amount"] as num?)?.toDouble(),
      note: json["note"]?.toString() ?? "",
    );
  }

  final String key;
  final String label;
  final double? amount;
  final String note;
}

class _BudgetData {
  _BudgetData({
    required this.currency,
    required this.total,
    required this.original,
    required this.discount,
    required this.items,
    required this.pricingMode,
    required this.warnings,
    this.pendingItems = 0,
  });

  factory _BudgetData.fromJson(Map<String, dynamic> json) {
    return _BudgetData(
      currency: json["currency"]?.toString() ?? "CNY",
      total: (json["total"] as num?)?.toDouble() ?? 0,
      original: (json["original"] as num?)?.toDouble() ?? 0,
      discount: (json["discount"] as num?)?.toDouble() ?? 0,
      items: <_BudgetItemData>[
        for (final dynamic i in (json["items"] as List<dynamic>? ?? const <dynamic>[]))
          if (i is Map<String, dynamic>) _BudgetItemData.fromJson(i),
      ],
      pricingMode: json["pricingMode"]?.toString() ?? "",
      warnings: <String>[
        for (final dynamic w in (json["warnings"] as List<dynamic>? ?? const <dynamic>[]))
          if (w != null) w.toString(),
      ],
      pendingItems: (json["pendingItems"] as num?)?.toInt() ?? 0,
    );
  }

  final String currency;
  final double total;
  final double original;
  final double discount;
  final List<_BudgetItemData> items;
  final String pricingMode;
  final List<String> warnings;
  final int pendingItems;

  /// 用户已确认这版预算（确认后按钮收起，避免重复出方案）。
  bool approved = false;
}

/// 档案栏「已定条」：服务端从会话状态确定性投影出来的一条结论。
class _DossierFactData {
  const _DossierFactData({
    required this.id,
    required this.label,
    required this.value,
    required this.set,
  });

  factory _DossierFactData.fromJson(Map<String, dynamic> json) {
    final String value = json["value"]?.toString() ?? "";
    return _DossierFactData(
      id: json["id"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      value: value,
      set: json["state"]?.toString() != "todo" && value.isNotEmpty,
    );
  }

  final String id;
  final String label;
  final String value;
  final bool set;
}

/// 档案栏五步进度轨（问答 / 挑想去 / 补心愿 / 核预算 / 出方案）。
class _DossierStepData {
  const _DossierStepData({
    required this.label,
    required this.state,
  });

  factory _DossierStepData.fromJson(Map<String, dynamic> json) => _DossierStepData(
        label: json["label"]?.toString() ?? "",
        state: json["state"]?.toString() ?? "todo",
      );

  final String label;

  /// done / active / todo
  final String state;

  bool get isDone => state == "done";
  bool get isActive => state == "active";
}

/// 右侧行程档案栏快照（每轮回执整份替换，客户端不缓存局部状态）。
class _DossierData {
  _DossierData({
    required this.head,
    required this.steps,
    required this.facts,
  });

  factory _DossierData.fromJson(Map<String, dynamic> json) {
    return _DossierData(
      head: json["head"]?.toString() ?? "",
      steps: <_DossierStepData>[
        for (final dynamic s in (json["steps"] as List<dynamic>? ?? const <dynamic>[]))
          if (s is Map<String, dynamic>) _DossierStepData.fromJson(s),
      ],
      facts: <_DossierFactData>[
        for (final dynamic f in (json["facts"] as List<dynamic>? ?? const <dynamic>[]))
          if (f is Map<String, dynamic>) _DossierFactData.fromJson(f),
      ],
    );
  }

  final String head;
  final List<_DossierStepData> steps;
  final List<_DossierFactData> facts;

  /// 当前所处步骤名（档案头下面那句「第 N 步 · 挑想去」）。
  String get activeLabel => steps.firstWhere(
        (_DossierStepData s) => s.isActive,
        orElse: () => steps.isNotEmpty ? steps.first : const _DossierStepData(label: "", state: "todo"),
      ).label;

  int get doneCount => steps.where((_DossierStepData s) => s.isDone).length;
}

/// 对话流条目。
enum _FlowKind {
  user,
  say,
  weather,
  choice,
  guide,
  wishlist,
  booking,
  typing,
  budget,
  draft,
  error,
}

class _FlowItem {
  _FlowItem._(
    this.kind, {
    this.text = "",
    this.weather,
    this.choice,
    this.guide,
    this.wishlist,
    this.booking,
    this.budget,
    this.draft,
  });

  factory _FlowItem.user(String text) => _FlowItem._(_FlowKind.user, text: text);
  factory _FlowItem.say(String text) => _FlowItem._(_FlowKind.say, text: text);
  factory _FlowItem.weather(_WeatherCardData data) =>
      _FlowItem._(_FlowKind.weather, weather: data);
  factory _FlowItem.choice(_ChoiceCardData data) =>
      _FlowItem._(_FlowKind.choice, choice: data);
  factory _FlowItem.guide(_GuideCardData data) =>
      _FlowItem._(_FlowKind.guide, guide: data);
  factory _FlowItem.wishlist(_WishlistCardData data) =>
      _FlowItem._(_FlowKind.wishlist, wishlist: data);
  factory _FlowItem.booking(_BookingCardData data) =>
      _FlowItem._(_FlowKind.booking, booking: data);
  factory _FlowItem.typing() => _FlowItem._(_FlowKind.typing);
  factory _FlowItem.budget(_BudgetData data) =>
      _FlowItem._(_FlowKind.budget, budget: data);
  factory _FlowItem.draft(_DraftData data) =>
      _FlowItem._(_FlowKind.draft, draft: data);
  factory _FlowItem.error(String text) => _FlowItem._(_FlowKind.error, text: text);

  final _FlowKind kind;
  final String text;
  final _WeatherCardData? weather;
  final _ChoiceCardData? choice;
  final _GuideCardData? guide;
  final _WishlistCardData? wishlist;
  final _BookingCardData? booking;
  final _BudgetData? budget;
  final _DraftData? draft;
}

/// 服务端一轮回执。
/// 顶栏的历史会话入口：下拉 =「新会话 + 历史对话列表」。
/// 左侧竖栏只放「规划/行程」两个 tab，会话管理全部收在这里。
class _PlanSessionMenu extends StatelessWidget {
  const _PlanSessionMenu({
    required this.colors,
    required this.sessions,
    required this.activeId,
    required this.busy,
    required this.onNew,
    required this.onOpen,
  });

  final _StageColors colors;
  final List<_PlanSessionSummary> sessions;
  final String? activeId;
  final bool busy;
  final VoidCallback onNew;
  final ValueChanged<_PlanSessionSummary> onOpen;

  static const String _kNew = "-new";

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    return PopupMenuButton<String>(
      key: const Key("planning-session-menu"),
      tooltip: "历史规划会话",
      icon: Icon(Icons.history_rounded, size: 19, color: c.text2),
      position: PopupMenuPosition.under,
      color: c.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: c.borderSoft),
      ),
      onSelected: (String v) {
        if (v == _kNew) {
          onNew();
          return;
        }
        for (final _PlanSessionSummary s in sessions) {
          if (s.id == v) {
            onOpen(s);
            return;
          }
        }
      },
      itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
        PopupMenuItem<String>(
          enabled: !busy,
          value: _kNew,
          child: Row(
            children: <Widget>[
              Icon(Icons.add, size: 16, color: c.accent),
              const SizedBox(width: 8),
              Text("新会话",
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: c.accent)),
            ],
          ),
        ),
        PopupMenuDivider(),
        if (sessions.isEmpty)
          PopupMenuItem<String>(
            enabled: false,
            child: Text("还没有历史规划",
                style: TextStyle(fontSize: 12, color: c.muted)),
          )
        else ...<PopupMenuEntry<String>>[
          for (final _PlanSessionSummary s in sessions)
            PopupMenuItem<String>(
              value: s.id,
              height: 52,
              child: Row(
                children: <Widget>[
                  Icon(
                    s.finished ? Icons.verified_outlined : Icons.autorenew,
                    size: 14,
                    color: s.finished ? c.muted : c.accent,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text(
                          s.displayTitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: s.id == activeId
                                ? FontWeight.w700
                                : FontWeight.w500,
                            color: c.text,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          "${s.stateLabel} · ${s.timeLabel}",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 10.5,
                            color: c.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (s.id == activeId) ...<Widget>[
                    const SizedBox(width: 6),
                    Icon(Icons.check, size: 14, color: c.accent),
                  ],
                ],
              ),
            ),
        ],
      ],
    );
  }
}

class _TurnResult {
  const _TurnResult({
    required this.state,
    required this.say,
    required this.cards,
    required this.budget,
    required this.draft,
    this.dossier,
  });

  factory _TurnResult.fromJson(Map<String, dynamic> json) {
    return _TurnResult(
      state: json["state"]?.toString() ?? "gathering",
      say: json["say"]?.toString() ?? "",
      cards: <Object>[
        for (final dynamic c in (json["cards"] as List<dynamic>? ?? const <dynamic>[]))
          if (c is Map<String, dynamic>)
            if (c["type"] == "weather")
              _WeatherCardData.fromJson(c)
            else if (c["type"] == "choice")
              _ChoiceCardData.fromJson(c)
            else if (c["type"] == "guide")
              _GuideCardData.fromJson(c)
            else if (c["type"] == "wishlist")
              _WishlistCardData.fromJson(c)
            else if (c["type"] == "booking")
              _BookingCardData.fromJson(c),
      ],
      budget: json["budget"] is Map<String, dynamic>
          ? _BudgetData.fromJson(json["budget"] as Map<String, dynamic>)
          : null,
      draft: json["draft"] is Map<String, dynamic>
          ? _DraftData.fromJson(json["draft"] as Map<String, dynamic>)
          : null,
      dossier: json["dossier"] is Map<String, dynamic>
          ? _DossierData.fromJson(json["dossier"] as Map<String, dynamic>)
          : null,
    );
  }

  final String state;
  final String say;
  final List<Object> cards;
  final _BudgetData? budget;
  final _DraftData? draft;

  /// 右侧档案栏快照（旧服务端不下发时为 null，档案栏整栏隐藏）。
  final _DossierData? dossier;
}

/// 规划主区（宽窗右栏 / 窄窗默认页）。
class _PlanningStage extends StatefulWidget {
  const _PlanningStage({
    super.key,
    required this.onPlanGenerated,
    required this.onOpenPlan,
    required this.sessions,
    required this.activeSessionId,
    required this.onActiveSessionChanged,
    this.seedMessage,
    this.agentName,
  });

  /// 真实生成成功后回调（宿主刷新左栏列表）。
  final VoidCallback onPlanGenerated;

  /// 「生成完整行程」：按 planId 打开完整行程界面。
  final Future<void> Function(String planId) onOpenPlan;

  /// 侧边栏历史会话列表（宿主持有，规划区只读）。
  final List<_PlanSessionSummary> sessions;

  /// 当前活动会话 id（null=新会话未发消息）。
  final String? activeSessionId;

  /// 会话变化上报：出 sessionId / 每轮成功 / 点「新会话」时通知宿主刷新侧边栏。
  final ValueChanged<String?> onActiveSessionChanged;

  /// 主对话交接过来的原始诉求（进入即自动发起一轮规划会话）。
  final String? seedMessage;

  /// 用户给 Agent 取的名字（空=未设定，说话块不显示名字）。
  final String? agentName;

  @override
  State<_PlanningStage> createState() => _PlanningStageState();
}

class _PlanningStageState extends State<_PlanningStage> {
  final TextEditingController _input = TextEditingController();
  final FocusNode _inputFocus = FocusNode();
  final ScrollController _scroll = ScrollController();

  /// 是否已发起规划（idle → flow）。
  bool _flowStarted = false;

  /// 等待服务端回执（输入框 / 卡片按钮禁用）。
  bool _busy = false;

  String? _sessionId;

  final List<_FlowItem> _flow = <_FlowItem>[];

  /// 右侧档案栏快照（服务端每轮回执整份替换；null=旧服务端，不显示档案栏）。
  _DossierData? _dossier;

  /// 从档案栏点「改」带过来的输入提示（null=常规提示语）。
  String? _adjustHintText;

  /// 出票时刻（预算确认 → 播打印出票动画；null=未播放）。
  _TicketPrintMoment? _ticketMoment;

  /// 挑一挑的双面板看图（点实拍图打开；null=未打开）。
  _GuidePreviewData? _guidePreview;

  @override
  void initState() {
    super.initState();
    // 主对话交接：进来就把原话当作第一条用户消息，直接起会话。
    final String seed = (widget.seedMessage ?? "").trim();
    if (seed.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _flowStarted) return;
      _append(_FlowItem.user(seed));
      unawaited(_start(seed));
    });
  }

  @override
  void dispose() {
    _input.dispose();
    _inputFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ── 流操作 ─────────────────────────────────────────────────────

  void _append(_FlowItem item) {
    setState(() => _flow.add(item));
    _scrollToBottom();
  }

  /// 档案栏整份替换：结论口径只在服务端，客户端不存增量。
  void _setDossier(_DossierData? data) {
    if (!mounted) return;
    setState(() => _dossier = data);
  }

  /// 档案栏的「钱的水位」：直接读流里最新那张预算卡，与卡面永远一致。
  _BudgetData? get _latestBudget {
    for (final _FlowItem f in _flow.reversed) {
      if (f.kind == _FlowKind.budget) return f.budget;
    }
    return null;
  }

  /// 档案栏的「核实风险」：读最新草案的核实闸结果。
  _DraftData? get _latestDraft {
    for (final _FlowItem f in _flow.reversed) {
      if (f.kind == _FlowKind.draft) return f.draft;
    }
    return null;
  }

  /// 移除 typing 占位（有则移除）。
  void _removeTyping() {
    final int i = _flow.lastIndexWhere((_FlowItem f) => f.kind == _FlowKind.typing);
    if (i < 0) return;
    setState(() => _flow.removeAt(i));
  }

  void _scrollToBottom() {
    unawaited(Future<void>.delayed(const Duration(milliseconds: 60)).then((_) {
      if (!_scroll.hasClients) return;
      unawaited(_scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 260),
        curve: Curves.easeOut,
      ));
    }));
  }

  void _insertSayAndCards(_TurnResult r) {
    _notifyActive();
    _removeTyping();
    if (r.dossier != null) _setDossier(r.dossier);
    if (r.say.isNotEmpty) _append(_FlowItem.say(r.say));
    for (final Object card in r.cards) {
      if (card is _WeatherCardData) {
        _append(_FlowItem.weather(card));
      } else if (card is _ChoiceCardData) {
        _append(_FlowItem.choice(card));
      } else if (card is _GuideCardData) {
        _append(_FlowItem.guide(card));
      } else if (card is _WishlistCardData) {
        _append(_FlowItem.wishlist(card));
      } else if (card is _BookingCardData) {
        _append(_FlowItem.booking(card));
      }
    }
    if (r.budget != null) _append(_FlowItem.budget(r.budget!));
    if (r.draft != null) {
      _append(_FlowItem.draft(r.draft!));
      unawaited(Future<void>.delayed(Duration.zero).then((_) => widget.onPlanGenerated()));
    }
  }

  /// 用户重新补充信息：未答的问题卡与上一版预算/最终方案都不再代表当前需求，先移出流。
  void _dropStaleOutput() {
    // 档案栏里「改」的输入提示属于一次性引导，任何一次作答/发话后都收回。
    _adjustHintText = null;
    _flow.removeWhere(
      (_FlowItem f) =>
          f.kind == _FlowKind.choice ||
          f.kind == _FlowKind.guide ||
          f.kind == _FlowKind.wishlist ||
          f.kind == _FlowKind.booking ||
          f.kind == _FlowKind.budget ||
          f.kind == _FlowKind.draft,
    );
  }

  // ── 服务端调用 ─────────────────────────────────────────────────

  static const Duration _turnTimeout = Duration(seconds: 40);
  static const Duration _generateTimeout = Duration(seconds: 150);

  Future<Map<String, dynamic>?> _post(
    String path,
    Map<String, dynamic> body,
    Duration timeout,
  ) async {
    final http.Response resp = await http
        .post(
          Uri.parse("${ApiConfig.httpBase}$path"),
          headers: const <String, String>{"Content-Type": "application/json"},
          body: jsonEncode(body),
        )
        .timeout(timeout);
    final Object? decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception("HTTP ${resp.statusCode}");
    }
    if (resp.statusCode != 200 || decoded["ok"] != true) {
      final String error = decoded["error"]?.toString() ?? "HTTP ${resp.statusCode}";
      final String hint = decoded["hint"]?.toString() ?? "";
      throw Exception(hint.isEmpty ? error : "$error（$hint）");
    }
    return decoded;
  }

  Future<Map<String, dynamic>?> _get(String path, Duration timeout) async {
    final http.Response resp =
        await http.get(Uri.parse("${ApiConfig.httpBase}$path")).timeout(timeout);
    final Object? decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception("HTTP ${resp.statusCode}");
    }
    if (resp.statusCode != 200 || decoded["ok"] != true) {
      final String error = decoded["error"]?.toString() ?? "HTTP ${resp.statusCode}";
      throw Exception(error);
    }
    return decoded;
  }

  /// 发送输入框内容（idle 时发起会话，flow 中续说）。
  Future<void> _send() async {
    final String text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    _input.clear();
    _inputFocus.unfocus();
    setState(_dropStaleOutput);
    _append(_FlowItem.user(text));
    if (!_flowStarted) {
      await _start(text);
    } else {
      await _turnMessage(text);
    }
  }

  Future<void> _start(String message) async {
    setState(() {
      _busy = true;
      _flowStarted = true;
      _sessionId = null;
      _dossier = null;
    });
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded =
          await _post("/travel/plan-session", <String, dynamic>{"message": message}, _turnTimeout);
      _sessionId = decoded?["sessionId"]?.toString();
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    // 信息齐 → 真实生成（_busy 已清零，_generate 内部自管忙态）
    if (ready) await _generate();
  }

  Future<void> _turnMessage(String message) async {
    final String? id = _sessionId;
    if (id == null) {
      await _start(message);
      return;
    }
    setState(() => _busy = true);
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/turn",
        <String, dynamic>{"message": message},
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ready) await _generate();
  }

  /// 点选回传（单选立即 / 多选确认）。
  Future<void> _sendChoice(
    _FlowItem item,
    _ChoiceCardData card,
    List<String> values,
    String? note,
  ) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    // 串行节奏：答完这张卡立即从流里消失，下一张由服务端回执带来。
    setState(() {
      _flow.remove(item);
      _dropStaleOutput();
      _busy = true;
    });
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/turn",
        <String, dynamic>{
          "cardId": card.id,
          "values": values,
          if (note != null && note.trim().isNotEmpty) "note": note.trim(),
        },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ready) await _generate();
  }

  /// 筛选卡确认：勾选结果作为心愿清单提交，随后进入真实生成（核价）。
  Future<void> _submitGuide(
    _FlowItem item,
    _GuideCardData card, {
    bool delegate = false,
  }) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    final Map<String, List<String>> selected = <String, List<String>>{
      "view": <String>[],
      "stay": <String>[],
      "food": <String>[],
    };
    for (final _GuideCatData cat in card.cats) {
      for (final _GuideItemData entry in cat.items) {
        if (entry.picked) selected[cat.key]?.add(entry.name);
      }
    }
    if (!delegate &&
        selected.values.every((List<String> l) => l.isEmpty)) {
      return;
    }
    setState(() {
      _flow.remove(item);
      _dropStaleOutput();
      _busy = true;
    });
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/guide",
        delegate
            ? <String, dynamic>{"delegate": true}
            : <String, dynamic>{
                "view": selected["view"],
                "stay": selected["stay"],
                "food": selected["food"],
              },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ready) await _generate();
  }

  /// 自选补充：带上用户自己写的景点/酒店/餐厅（可为空=跳过），随后进入核价。
  Future<void> _submitExtras(
    _FlowItem item,
    Map<String, List<String>> extras,
    String note,
  ) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    final List<String> added = <String>[
      ...?extras["view"],
      ...?extras["stay"],
      ...?extras["food"],
    ];
    setState(() {
      _flow.remove(item);
      _dropStaleOutput();
      _busy = true;
    });
    _append(_FlowItem.user(
      added.isEmpty ? "没有补充了，直接算预算" : "还想加：${added.join("、")}",
    ));
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/extras",
        <String, dynamic>{
          "view": extras["view"] ?? const <String>[],
          "stay": extras["stay"] ?? const <String>[],
          "food": extras["food"] ?? const <String>[],
          if (note.trim().isNotEmpty) "note": note.trim(),
        },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ready) await _generate();
  }

  /// 预订选择卡：提交所选班次/酒店（可全不选=先不订，按参考价走），
  /// 服务端回 ready 后自动进入真实生成——所选班次进预算与行程交通段。
  Future<void> _submitBooking(
    _FlowItem item,
    _BookingCardData card,
    String? transportKey,
    String? hotelKey,
  ) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    String labelOf(String? key, List<String> Function() pick) {
      if (key == null || key.isEmpty) return "";
      final List<String> names = pick();
      return names.isEmpty ? "" : names.first;
    }

    final String tLabel = labelOf(transportKey, () => <String>[
          for (final _BookingTransportData t in card.transports)
            if (t.key == transportKey)
              "${t.isTrain ? "车次" : "航班"} ${t.no}${t.carrier.isEmpty ? "" : " ${t.carrier}"}",
        ]);
    final String hLabel = labelOf(hotelKey, () => <String>[
          for (final _BookingHotelData h in card.hotels)
            if (h.key == hotelKey) h.name,
        ]);
    final String picked = <String>[
      if (tLabel.isNotEmpty) "大交通：$tLabel",
      if (hLabel.isNotEmpty) "住宿：$hLabel",
    ].join("；");
    setState(() {
      _flow.remove(item);
      _dropStaleOutput();
      _busy = true;
    });
    _append(_FlowItem.user(picked.isEmpty ? "先不订，按参考价算" : picked));
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/booking",
        <String, dynamic>{
          if (transportKey != null && transportKey.isNotEmpty)
            "transportKey": transportKey,
          if (hotelKey != null && hotelKey.isNotEmpty) "hotelKey": hotelKey,
        },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (ready) await _generate();
  }

  Future<void> _generate() async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    setState(() => _busy = true);
    _append(_FlowItem.typing());
    try {
      final Map<String, dynamic>? decoded =
          await _post("/travel/plan-session/$id/generate", <String, dynamic>{}, _generateTimeout);
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      if (r.dossier != null) _setDossier(r.dossier);
      _removeTyping();
      _notifyActive();
      if (r.say.isNotEmpty) _append(_FlowItem.say(r.say));
      // flow A：生成完先只给预算明细，用户确认后才出最终方案。
      if (r.budget != null) _append(_FlowItem.budget(r.budget!));
      if (r.draft != null) {
        _append(_FlowItem.draft(r.draft!));
        unawaited(Future<void>.delayed(Duration.zero).then((_) => widget.onPlanGenerated()));
      }
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 预算确认 → 服务端下发最终草案。
  Future<void> _approve() async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    if (_flow.any((_FlowItem f) => f.budget?.approved == true)) return;
    setState(() => _busy = true);
    _append(_FlowItem.typing());
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/approve",
        <String, dynamic>{},
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      setState(() {
        for (final _FlowItem f in _flow) {
          if (f.kind == _FlowKind.budget) f.budget!.approved = true;
        }
      });
      _insertSayAndCards(r);
      // 出票时刻：预算确认且服务端下发最终草案 → 播打印出票动画。
      if (r.draft != null && mounted) {
        String pricingMode = "";
        for (final _FlowItem f in _flow) {
          if (f.kind == _FlowKind.budget) pricingMode = f.budget?.pricingMode ?? "";
        }
        setState(() => _ticketMoment = _TicketPrintMoment(
              draft: r.draft!,
              pricingMode: pricingMode,
            ));
      }
    } catch (e) {
      _recoverFromError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 失败恢复：typing 移除 + 错误条目；会话失效时清空 sessionId，
  /// 下一条消息重新发起。
  void _recoverFromError(Object e) {
    _removeTyping();
    final String msg = "$e".replaceFirst("Exception: ", "");
    final bool expired = msg.contains("会话不存在") || msg.contains("已过期");
    if (expired) _sessionId = null;
    _append(_FlowItem.error(expired ? "会话已过期，在下方重新说一句发起吧" : "出错了：$msg"));
  }

  // ── 历史规划会话（侧边栏驱动）────────────────────────────────

  /// 会话变化上报宿主（出 sessionId / 每轮成功 / 点「新会话」）。
  void _notifyActive() {
    widget.onActiveSessionChanged(_sessionId);
  }

  /// history 载荷 → 对话流条目（恢复时用户气泡 / Agent 说话块原样重建）。
  static List<_FlowItem> _flowFromHistory(List<dynamic>? history) => <_FlowItem>[
        for (final dynamic h in history ?? const <dynamic>[])
          if (h is Map<String, dynamic>)
            if ((h["role"]?.toString() ?? "") == "user" &&
                (h["content"]?.toString() ?? "").isNotEmpty)
              _FlowItem.user(h["content"].toString())
            else if ((h["role"]?.toString() ?? "") == "assistant" &&
                (h["content"]?.toString() ?? "").isNotEmpty)
              _FlowItem.say(h["content"].toString()),
      ];

  /// 服务端恢复卡（guide/wishlist 等确定性重建的挂起卡）→ 流条目。
  static _FlowItem? _flowItemFromCard(Object? card) {
    if (card is! Map<String, dynamic>) return null;
    return switch (card["type"]?.toString()) {
      "weather" => _FlowItem.weather(_WeatherCardData.fromJson(card)),
      "choice" => _FlowItem.choice(_ChoiceCardData.fromJson(card)),
      "guide" => _FlowItem.guide(_GuideCardData.fromJson(card)),
      "wishlist" => _FlowItem.wishlist(_WishlistCardData.fromJson(card)),
      "booking" => _FlowItem.booking(_BookingCardData.fromJson(card)),
      _ => null,
    };
  }

  /// 侧边栏点历史会话 → 拉全量状态恢复对话流。可从 idle 进入，也可在
  /// 对话中直接切换（切换前旧会话已落盘，丢不了）。
  Future<void> _resumeSession(_PlanSessionSummary s) async {
    if (_busy) return;
    if (_flowStarted && _sessionId == s.id) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic>? decoded =
          await _get("/travel/plan-session/${s.id}", _turnTimeout);
      if (decoded == null) throw Exception("空回执");
      final String state = decoded["state"]?.toString() ?? "gathering";
      final _DossierData? dossier = decoded["dossier"] is Map<String, dynamic>
          ? _DossierData.fromJson(decoded["dossier"] as Map<String, dynamic>)
          : null;
      final _BudgetData? budget = decoded["budget"] is Map<String, dynamic>
          ? _BudgetData.fromJson(decoded["budget"] as Map<String, dynamic>)
          : null;
      final _DraftData? draft = decoded["draft"] is Map<String, dynamic>
          ? _DraftData.fromJson(decoded["draft"] as Map<String, dynamic>)
          : null;
      final List<_FlowItem> restored =
          _flowFromHistory(decoded["history"] as List<dynamic>?);
      final _FlowItem? resumeCard = _flowItemFromCard(decoded["resumeCard"]);
      if (!mounted) return;
      setState(() {
        _flowStarted = true;
        _sessionId = s.id;
        _dossier = dossier;
        _adjustHintText = null;
        _ticketMoment = null;
        _guidePreview = null;
        _flow
          ..clear()
          ..addAll(restored);
        if (state == "generated" && draft != null) {
          // 已出方案：预算卡标已确认 + 草案卡补回，档案栏口径与中断前一致
          if (budget != null) {
            budget.approved = true;
            _flow.add(_FlowItem.budget(budget));
          }
          _flow.add(_FlowItem.draft(draft));
        } else if (state == "budget_ready" && budget != null) {
          _flow.add(_FlowItem.budget(budget));
        }
        if (resumeCard != null) _flow.add(resumeCard);
        if (state == "gathering" && resumeCard == null) {
          // choice 问题卡的选项不落盘，恢复不了原卡：引导直接接着说
          _flow.add(_FlowItem.say("接着上次的继续——想补或想改什么，直接说就行。"));
        }
      });
      _notifyActive();
      _scrollToBottom();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
          "恢复规划会话失败：$e".replaceFirst("Exception: ", ""),
          style: const TextStyle(fontSize: 12),
        ),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 侧边栏「新会话」：清空当前流回 idle 开新的一条；刚才的会话已落盘，
  /// 侧边栏里随时点回来。
  void _startNewPlan() {
    if (_busy) return;
    if (!_flowStarted && _sessionId == null) return;
    setState(() {
      _flowStarted = false;
      _sessionId = null;
      _dossier = null;
      _adjustHintText = null;
      _ticketMoment = null;
      _guidePreview = null;
      _flow.clear();
    });
    _input.clear();
    _notifyActive();
  }

  /// 草案 → 打开完整行程界面。
  Future<void> _openDraft(_DraftData draft) async {
    if (draft.planId.isEmpty) return;
    await widget.onOpenPlan(draft.planId);
  }

  /// 档案栏「改」：改口径走自由消息（服务端 answerUpdates 覆盖旧答案），
  /// 这里只负责聚焦输入框并给一句「该说什么」的提示。
  void _beginAdjust(_DossierFactData fact) {
    if (_busy) return;
    setState(() => _adjustHintText =
        '想改「${fact.label} · ${fact.value}」？直接说，例如：${_adjustExample(fact.id)}');
    _inputFocus.requestFocus();
  }

  static String _adjustExample(String id) => switch (id) {
        "destination" => "改成去重庆",
        "days" => "改成玩 4 天",
        "origin" => "从上海出发",
        "party" => "改成和朋友",
        "budget" => "住宿标准再省一点",
        "transport" => "去程改坐高铁",
        "picks" => "把都江堰换成乐山大佛",
        "stay" => "住宿换春熙路附近",
        "food" => "加一家陈麻婆豆腐",
        _ => "第二天想去都江堰",
      };

  // ── UI ────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    final _DossierData? dossier = _flowStarted ? _dossier : null;
    return Stack(
      children: <Widget>[
        LayoutBuilder(
          builder: (BuildContext context, BoxConstraints cons) {
            // 第三栏放不下时（窄窗），档案降级成顶部一条横向「已定」胶囊。
            final bool sideDossier =
                dossier != null && cons.maxWidth >= _kDossierBreakpoint;
            return Column(
              children: <Widget>[
                _buildTopBar(c),
                if (dossier != null && !sideDossier)
                  KeyedSubtree(
                    key: const Key("planning-dossier-strip"),
                    child: _DossierStrip(
                        dossier: dossier, colors: c, onEdit: _beginAdjust),
                  ),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Expanded(child: _buildFlowColumn(c)),
                      if (sideDossier)
                        Container(
                          key: const Key("planning-dossier"),
                          width: _kDossierWidth,
                          decoration: BoxDecoration(
                            color: c.card,
                            border: Border(left: BorderSide(color: c.borderSoft)),
                          ),
                          child: _TripDossier(
                            dossier: dossier,
                            colors: c,
                            budget: _latestBudget,
                            draft: _latestDraft,
                            enabled: !_busy,
                            onEdit: _beginAdjust,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
        // 出票时刻覆盖层（预算确认后）
        if (_ticketMoment != null)
          Positioned.fill(
            child: _TicketPrintOverlay(
              moment: _ticketMoment!,
              colors: c,
              onClose: () => setState(() => _ticketMoment = null),
              onOpenPlan: () {
                final _DraftData d = _ticketMoment!.draft;
                setState(() => _ticketMoment = null);
                unawaited(_openDraft(d));
              },
            ),
          ),
        // 挑一挑的双面板看图（点实拍图）
        if (_guidePreview != null)
          Positioned.fill(
            child: _GuideViewerOverlay(
              preview: _guidePreview!,
              colors: c,
              onClose: () => setState(() => _guidePreview = null),
              onToggle: () => setState(
                  () => _guidePreview!.item.picked = !_guidePreview!.item.picked),
            ),
          ),
      ],
    );
  }

  Widget _buildTopBar(_StageColors c) {
    // 标题随当前会话变：在聊哪条规划一眼可见；新会话回退「行程规划」
    String title = "行程规划";
    final String? activeId = widget.activeSessionId;
    if (activeId != null) {
      for (final _PlanSessionSummary s in widget.sessions) {
        if (s.id == activeId) {
          title = s.displayTitle;
          break;
        }
      }
    }
    return Container(
      height: 46,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: c.borderSoft)),
      ),
      child: Row(
        children: <Widget>[
          _BackButton(colors: c),
          const SizedBox(width: 10),
          Expanded(
            child: Text(title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700, color: c.text2)),
          ),
          _PlanSessionMenu(
            colors: c,
            sessions: widget.sessions,
            activeId: activeId,
            busy: _busy,
            onNew: _startNewPlan,
            onOpen: (_PlanSessionSummary s) => unawaited(_resumeSession(s)),
          ),
        ],
      ),
    );
  }

  /// 中栏：对话流 + 输入框（idle 时输入框垂直居中）。
  /// Key 供实机取证定位「流内动作」与「档案栏动作」，避免两处同名文字互相误点。
  Widget _buildFlowColumn(_StageColors c) {
    return Column(
      key: const Key("planning-flow"),
      children: <Widget>[
        // 对话流（idle 时隐藏）：flow 独占剩余空间；内容居中，与主对话同宽
        if (_flowStarted)
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              itemCount: _flow.length,
              itemBuilder: (BuildContext context, int index) => Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: _kContentMaxWidth),
                  child: _buildFlowItem(context, _flow[index], c),
                ),
              ),
            ),
          ),
        // 输入区：idle 垂直居中，flow 落底部
        if (_flowStarted)
          _buildComposer(c)
        else
          Expanded(child: Center(child: _buildComposer(c))),
      ],
    );
  }

  Widget _buildComposer(_StageColors c) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 8, 24, _flowStarted ? 18 : 0),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _kContentMaxWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 居中罗盘图标（仅 idle，无引导文案）
            if (!_flowStarted) ...<Widget>[
              GestureDetector(
                // 临时调试：点罗盘直接预览出票动画（验证后移除）。
                onTap: _previewTicketMoment,
                child: Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(
                    color: c.accentSoft,
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(Icons.explore_outlined, size: 24, color: c.accent),
                ),
              ),
              const SizedBox(height: 18),
            ],
            _InputRow(
              controller: _input,
              focusNode: _inputFocus,
              colors: c,
              enabled: !_busy,
              placeholder: _adjustHintText ??
                  (_flowStarted
                      ? "随时补充或调整，比如：第二天想去都江堰"
                      : "想去哪儿玩？比如：成都吃三天"),
              onSend: _send,
            ),
            if (!_flowStarted) const SizedBox(height: 48),
          ],
        ),
      ),
    );
  }

  /// 你的 Agent 名字；未设定时为空（说话块不显示名字）。
  String get _agentLabel => (widget.agentName ?? "").trim();

  /// 分段筛选卡的说明文案：单段卡按段写，兼容多段合卡的旧口径。
  String _guideStageDesc(_GuideCardData card) {
    final String key = card.cats.length == 1 ? card.cats.first.key : "";
    return switch (key) {
      "view" => "勾掉不想要的景点；想去的没在列表里，后面可以自己补。",
      "stay" => "勾掉不想住的；没合适的后面可以自己补。",
      "food" => "勾掉不想吃的；想吃的馆子没在列表里，后面可以自己补。",
      _ => "勾掉不想要的；想去的没在列表里，下一步可以自己补。",
    };
  }

  /// 临时调试：点罗盘直接预览出票动画（验证后移除）。
  void _previewTicketMoment() {
    setState(() => _ticketMoment = _TicketPrintMoment(
          draft: _DraftData(
            planId: "plan-preview-1024",
            title: "成都吃三天",
            destination: "成都",
            startDate: "2026-10-26",
            endDate: "2026-10-28",
            totalCost: 1180,
            days: <_DraftDayData>[
              _DraftDayData(
                  label: "Day 1",
                  stops: "宽窄巷子 · 人民公园 · 火锅",
                  items: <_DraftStopData>[]),
              _DraftDayData(
                  label: "Day 2",
                  stops: "都江堰 · 犀浦夜市",
                  items: <_DraftStopData>[]),
              _DraftDayData(
                  label: "Day 3",
                  stops: "大熊猫基地 · 春熙路",
                  items: <_DraftStopData>[]),
            ],
          ),
          pricingMode: "real-api",
        ));
  }

  /// 「再调整」提示：有名字就用名字，没设定就退回无人称说法。
  String _adjustHint(String example) => _agentLabel.isEmpty
      ? "在输入框说想改哪里，比如：$example"
      : "告诉 $_agentLabel 想改哪里，比如：$example";

  Widget _buildFlowItem(BuildContext context, _FlowItem item, _StageColors c) {
    switch (item.kind) {
      case _FlowKind.user:
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(bottom: 16),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            constraints: const BoxConstraints(maxWidth: 420),
            decoration: BoxDecoration(
              color: c.accentSoft,
              border: Border.all(color: c.borderSoft),
              borderRadius: BorderRadius.circular(15),
            ),
            child: Text(item.text,
                style: TextStyle(fontSize: 13.5, height: 1.6, color: c.text)),
          ),
        );
      case _FlowKind.say:
      case _FlowKind.error:
        final bool isError = item.kind == _FlowKind.error;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: c.card,
              border: Border.all(
                  color: isError ? c.orange.withValues(alpha: 0.45) : c.borderSoft),
              borderRadius: BorderRadius.circular(15),
            ),
            child: Text(
              item.text,
              style: TextStyle(
                fontSize: 13.5,
                height: 1.65,
                color: isError ? c.orange : c.text,
              ),
            ),
          ),
        );
      case _FlowKind.typing:
        return _AgentBlock(name: _agentLabel, colors: c, child: _TypingDots(colors: c));
      case _FlowKind.weather:
        final _WeatherCardData card = item.weather!;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: Icons.wb_sunny_outlined,
            stage: card.title.isEmpty ? "目的地天气" : card.title,
            trailing: card.sub.isEmpty
                ? null
                : Text(card.sub, style: TextStyle(fontSize: 10.5, color: c.muted)),
            child: _WeatherPanel(card: card, colors: c),
          ),
        );
      case _FlowKind.choice:
        final _ChoiceCardData card = item.choice!;
        final _CardProgress? progress = card.progress;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: _stageIcon(card.id),
            stage: card.stage.isNotEmpty ? card.stage : "行程偏好",
            trailing: progress != null && progress.total > 0
                ? _StageTrailing(
                    text: "已确认 ${progress.done}/${progress.total}",
                    colors: c,
                  )
                : null,
            lead: card.title.isEmpty ? null : card.title,
            desc: card.infer.isNotEmpty
                ? "选了同行人，节奏我替你定；不合适点「改」。"
                : card.multi
                    ? "可以多选，选完按「就这些」。"
                    : card.allowNote
                        ? "点一个就好，也可以直接写。"
                        : null,
            child: _ChoiceCard(
              card: card,
              colors: c,
              enabled: !_busy,
              onConfirm: (List<String> values, String? note) =>
                  _sendChoice(item, card, values, note),
            ),
          ),
        );
      case _FlowKind.guide:
        final _GuideCardData card = item.guide!;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: Icons.explore_outlined,
            stage: card.stage.isEmpty ? "挑一挑" : card.stage,
            lead: card.title.isEmpty ? "这三天想给${card.destination}留哪些地方？" : card.title,
            desc: _guideStageDesc(card),
            child: _GuideSelectCard(
              card: card,
              colors: c,
              enabled: !_busy,
              onConfirm: () => _submitGuide(item, card),
              onDelegate: () => _submitGuide(item, card, delegate: true),
              onPreview: (_GuideItemData entry, String catLabel, int index) =>
                  setState(() => _guidePreview = _GuidePreviewData(
                      catLabel: catLabel, item: entry, index: index)),
            ),
          ),
        );
      case _FlowKind.wishlist:
        final _WishlistCardData card = item.wishlist!;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: Icons.playlist_add_outlined,
            stage: card.stage.isEmpty ? "再补一句" : card.stage,
            trailing: _StageTrailing(text: "可跳过", colors: c),
            lead: card.title,
            desc: card.sub.isEmpty ? "写名字就行，几个用顿号隔开；没有就跳过。" : card.sub,
            child: _WishlistAddCard(
              card: card,
              colors: c,
              enabled: !_busy,
              onSubmit: (Map<String, List<String>> extras, String note) =>
                  _submitExtras(item, extras, note),
            ),
          ),
        );
      case _FlowKind.booking:
        final _BookingCardData card = item.booking!;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: Icons.book_online_outlined,
            stage: card.stage.isEmpty ? "预订安排" : card.stage,
            trailing: _StageTrailing(text: "可先不订", colors: c),
            lead: card.title.isEmpty ? "先把大交通和住宿定一下" : card.title,
            desc: card.sub.isEmpty
                ? "实时班次与房价，选中的会算进预算和行程；不合适就先不订。"
                : card.sub,
            child: _BookingCard(
              card: card,
              colors: c,
              enabled: !_busy,
              onConfirm: (String? transportKey, String? hotelKey) =>
                  _submitBooking(item, card, transportKey, hotelKey),
            ),
          ),
        );
      case _FlowKind.budget:
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: _StageCardShell(
            colors: c,
            icon: Icons.receipt_long_outlined,
            stage: "预算确认",
            lead: "确认这版预算，我就按它出方案",
            child: _BudgetCard(
              budget: item.budget!,
              colors: c,
              enabled: !_busy,
              onApprove: _approve,
              onAdjust: () {
                _inputFocus.requestFocus();
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                        _adjustHint("住宿换民宿、预算再省一点"),
                        style: const TextStyle(fontSize: 12)),
                    behavior: SnackBarBehavior.floating,
                    duration: const Duration(seconds: 2),
                  ),
                );
              },
            ),
          ),
        );
      case _FlowKind.draft:
        final _DraftData draft = item.draft!;
        return _AgentBlock(
          name: _agentLabel,
          colors: c,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Align(
                alignment: Alignment.centerLeft,
                child: _DraftCard(
                  draft: draft,
                  colors: c,
                  enabled: !_busy,
                  onGenerate: () => _openDraft(draft),
                  onAdjust: () {
                    _inputFocus.requestFocus();
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                            _adjustHint("第二天想去都江堰"),
                            style: const TextStyle(fontSize: 12)),
                        behavior: SnackBarBehavior.floating,
                        duration: const Duration(seconds: 2),
                      ),
                    );
                  },
                ),
              ),
              if (draft.days.isNotEmpty) ...<Widget>[
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: _DraftDetailCard(draft: draft, colors: c),
                ),
              ],
            ],
          ),
        );
    }
  }
}

/// 说话块（用户给 Agent 取的名字 + 内容；未命名时不显示名字行）。
class _AgentBlock extends StatelessWidget {
  const _AgentBlock({
    required this.name,
    required this.colors,
    required this.child,
  });

  final String name;
  final _StageColors colors;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (name.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 6,
                  height: 6,
                  decoration:
                      BoxDecoration(shape: BoxShape.circle, color: colors.accent),
                ),
                const SizedBox(width: 6),
                Text(name,
                    style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        color: colors.muted)),
              ],
            ),
            const SizedBox(height: 7),
          ],
          child,
        ],
      ),
    );
  }
}

/// 阶段独立卡外壳（对齐「明日速览」卡：圆角 16 + 细描边 + 头部图标/阶段名）。
/// 头部之后先给一句结论（lead），再放内容；用户不必读完整张卡才知道要做什么。
class _StageCardShell extends StatelessWidget {
  const _StageCardShell({
    required this.colors,
    required this.icon,
    required this.stage,
    required this.child,
    this.trailing,
    this.lead,
    this.desc,
  });

  final _StageColors colors;
  final IconData icon;
  final String stage;
  final Widget? trailing;

  /// 一句话结论（15px 粗体），内容之前先给。
  final String? lead;

  /// 结论下的补充说明（元信息口径）。
  final String? desc;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        width: double.infinity,
        constraints: const BoxConstraints(maxWidth: _kCardWidth),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(_kCardRadius),
          border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
        ),
        padding: const EdgeInsets.all(_kCardPad),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: colors.accent.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Icon(icon, size: 16, color: colors.accent),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(stage,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: colors.text)),
                ),
                if (trailing != null) ...<Widget>[
                  const SizedBox(width: 8),
                  trailing!,
                ],
              ],
            ),
            if (lead != null && lead!.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              Text(lead!,
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      height: 1.45,
                      color: colors.text)),
            ],
            if (desc != null && desc!.isNotEmpty) ...<Widget>[
              const SizedBox(height: 5),
              Text(desc!,
                  style: TextStyle(
                      fontSize: 11.5, height: 1.6, color: colors.muted)),
            ],
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

/// 卡片主操作：实底 + 10 圆角，一张卡只允许一个。
class _KitPrimaryButton extends StatelessWidget {
  const _KitPrimaryButton({
    required this.label,
    required this.colors,
    required this.onTap,
    this.enabled = true,
  });

  final String label;
  final _StageColors colors;
  final VoidCallback? onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final bool on = enabled && onTap != null;
    return GestureDetector(
      onTap: on ? onTap : null,
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? colors.accentBg : colors.card2,
          borderRadius: BorderRadius.circular(_kBtnRadius),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: on ? colors.onAccent : colors.muted,
          ),
        ),
      ),
    );
  }
}

/// 卡片次操作：纯文字（不描边、不抢主按钮）。
class _KitTextAction extends StatelessWidget {
  const _KitTextAction({
    required this.label,
    required this.colors,
    required this.onTap,
    this.enabled = true,
  });

  final String label;
  final _StageColors colors;
  final VoidCallback? onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final bool on = enabled && onTap != null;
    return GestureDetector(
      onTap: on ? onTap : null,
      behavior: HitTestBehavior.opaque,
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          color: on ? colors.text2 : colors.muted,
          decoration: TextDecoration.underline,
          decorationColor: colors.border,
          decorationStyle: TextDecorationStyle.solid,
        ),
      ),
    );
  }
}

/// 卡片头部右侧的小徽标（进度提示）。
class _StageTrailing extends StatelessWidget {
  const _StageTrailing({
    required this.text,
    required this.colors,
  });

  final String text;
  final _StageColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: colors.accentSoft,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Text(text,
          style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: colors.accent)),
    );
  }
}

IconData _stageIcon(String id) => switch (id) {
      "days" => Icons.calendar_today_outlined,
      "budget" => Icons.savings_outlined,
      "transport" => Icons.flight_takeoff_rounded,
      "hotel" => Icons.hotel_outlined,
      "food" => Icons.restaurant_outlined,
      "party" => Icons.groups_outlined,
      "pace" => Icons.speed_rounded,
      _ => Icons.tune_rounded,
    };

// ═══════════════════════════════════════════════════════════════════
// 行程档案栏（骨架 A「行程工作台」的右栏）
//
// 会话状态确定性投影，每轮回执整份替换：行程头 / 五步进度轨 / 已定条 /
// 钱的水位 / 核实风险。钱与风险读的是流里最新的预算卡与草案核实结果，
// 与卡面永远一致；已定条点「改」= 聚焦输入框并提示该怎么说（改口径走
// 自由消息，服务端 answerUpdates 覆盖旧答案）。
// ═══════════════════════════════════════════════════════════════════

/// 预算类目色：与预算卡同 key，颜色全部走主题 token（暖色变体也能跟上）。
Color _budgetTint(String key, _StageColors c) => switch (key) {
      "hotel" => c.green,
      "ticket" => c.orange,
      "food" => c.rainBlue,
      _ => c.accent,
    };

/// 右侧常驻档案栏。
class _TripDossier extends StatelessWidget {
  const _TripDossier({
    required this.dossier,
    required this.colors,
    required this.enabled,
    required this.onEdit,
    this.budget,
    this.draft,
  });

  final _DossierData dossier;
  final _StageColors colors;
  final bool enabled;
  final ValueChanged<_DossierFactData> onEdit;
  final _BudgetData? budget;
  final _DraftData? draft;

  String get _stepText {
    if (dossier.steps.every((_DossierStepData s) => s.isDone)) {
      return "五步走完，方案已出";
    }
    final String label = dossier.activeLabel;
    return "第 ${dossier.doneCount + 1} 步 · $label";
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    final List<_VerificationIssueData> risks =
        (draft?.verification?.issues ?? const <_VerificationIssueData>[])
            .take(3)
            .toList();
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text("行程档案",
              style: TextStyle(
                  fontSize: 10, letterSpacing: 1.4, color: c.muted)),
          const SizedBox(height: 5),
          Text(dossier.head.isEmpty ? "还没定目的地" : dossier.head,
              style: TextStyle(
                  fontSize: 14.5, fontWeight: FontWeight.w700, color: c.text)),
          const SizedBox(height: 3),
          Text(_stepText, style: TextStyle(fontSize: 10.5, color: c.muted)),
          const SizedBox(height: 12),
          _DossierStepRail(steps: dossier.steps, colors: c),
          const SizedBox(height: 14),
          _section(c, "已定"),
          const SizedBox(height: 4),
          for (final _DossierFactData f in dossier.facts) _factRow(f, c),
          if (budget != null) ...<Widget>[
            const SizedBox(height: 14),
            _section(c, "钱的水位"),
            const SizedBox(height: 6),
            _money(c),
          ],
          if (risks.isNotEmpty || (draft?.wishlistMissed.isNotEmpty ?? false)) ...<Widget>[
            const SizedBox(height: 14),
            _section(c, "核实"),
            const SizedBox(height: 4),
            for (final _VerificationIssueData issue in risks)
              _riskRow(issue.message, c,
                  hard: issue.level == "block"),
            if (draft != null && draft!.wishlistMissed.isNotEmpty)
              _riskRow(
                  "没排进：${draft!.wishlistMissed.take(3).join("、")}", c,
                  hard: false),
          ],
        ],
      ),
    );
  }

  Widget _section(_StageColors c, String title) => Text(title,
      style: TextStyle(
          fontSize: 10, letterSpacing: 1.2, color: c.muted));

  Widget _factRow(_DossierFactData f, _StageColors c) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 46,
            child: Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Text(f.label,
                  style: TextStyle(fontSize: 10.5, color: c.muted)),
            ),
          ),
          Expanded(
            child: Text(
              f.set ? f.value : "还没定",
              style: TextStyle(
                fontSize: 11.5,
                height: 1.45,
                fontWeight: f.set ? FontWeight.w600 : FontWeight.w400,
                color: f.set ? c.text2 : c.muted,
              ),
            ),
          ),
          if (f.set)
            Padding(
              padding: const EdgeInsets.only(left: 6, top: 1),
              child: _KitTextAction(
                label: "改",
                colors: c,
                enabled: enabled,
                onTap: () => onEdit(f),
              ),
            ),
        ],
      ),
    );
  }

  Widget _money(_StageColors c) {
    final _BudgetData b = budget!;
    final List<_BudgetItemData> parts =
        b.items.where((_BudgetItemData i) => (i.amount ?? 0) > 0).toList();
    final double sum = parts.fold<double>(
        0, (double acc, _BudgetItemData i) => acc + (i.amount ?? 0));
    final double base = sum <= 0 ? 1 : sum;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          b.total > 0 ? "¥${b.total.toStringAsFixed(0)}" : "待核价",
          style: TextStyle(
              fontSize: 17, fontWeight: FontWeight.w700, color: c.text),
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: SizedBox(
            height: 6,
            child: parts.isEmpty
                ? Container(color: c.card2)
                : Row(
                    children: <Widget>[
                      for (final _BudgetItemData i in parts)
                        Expanded(
                          flex: ((i.amount ?? 0) / base * 100).round().clamp(1, 100),
                          child: Container(color: _budgetTint(i.key, c)),
                        ),
                    ],
                  ),
          ),
        ),
        const SizedBox(height: 8),
        for (final _BudgetItemData i in parts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: <Widget>[
                Container(
                  width: 6,
                  height: 6,
                  margin: const EdgeInsets.only(right: 6),
                  decoration: BoxDecoration(
                    color: _budgetTint(i.key, c),
                    shape: BoxShape.circle,
                  ),
                ),
                Expanded(
                  child: Text(i.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 10.5, color: c.muted)),
                ),
                Text("¥${(i.amount ?? 0).toStringAsFixed(0)}",
                    style: TextStyle(fontSize: 10.5, color: c.text2)),
              ],
            ),
          ),
        if (b.pendingItems > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text("${b.pendingItems} 项待核价未计入",
                style: TextStyle(fontSize: 10, color: c.orange)),
          ),
      ],
    );
  }

  Widget _riskRow(String message, _StageColors c, {required bool hard}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2.5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 4, right: 6),
            child: Container(
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                  color: hard ? c.orange : c.muted, shape: BoxShape.circle),
            ),
          ),
          Expanded(
            child: Text(message,
                style:
                    TextStyle(fontSize: 10.5, height: 1.45, color: c.text2)),
          ),
        ],
      ),
    );
  }
}

/// 五步进度轨（横向）：走完绿勾、当前亮青、未到灰圈。
class _DossierStepRail extends StatelessWidget {
  const _DossierStepRail({required this.steps, required this.colors});

  final List<_DossierStepData> steps;
  final _StageColors colors;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    if (steps.isEmpty) return const SizedBox.shrink();
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < steps.length; i++)
          Expanded(
            child: Column(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Container(
                        height: 1.5,
                        color: i == 0
                            ? Colors.transparent
                            : (steps[i - 1].isDone ? c.green : c.borderSoft),
                      ),
                    ),
                    _node(steps[i], c),
                    Expanded(
                      child: Container(
                        height: 1.5,
                        color: i == steps.length - 1
                            ? Colors.transparent
                            : (steps[i].isDone ? c.green : c.borderSoft),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  steps[i].label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 10,
                    color: steps[i].isActive
                        ? c.accent
                        : steps[i].isDone
                            ? c.text2
                            : c.muted,
                    fontWeight: steps[i].isActive
                        ? FontWeight.w700
                        : FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _node(_DossierStepData s, _StageColors c) {
    final Color fg = s.isActive ? c.accent : (s.isDone ? c.green : c.muted);
    return Container(
      width: 14,
      height: 14,
      decoration: BoxDecoration(
        color: s.isDone || s.isActive ? fg.withValues(alpha: 0.16) : c.card2,
        shape: BoxShape.circle,
        border: Border.all(color: fg, width: 1.2),
      ),
      child: s.isDone
          ? Icon(Icons.check, size: 9, color: fg)
          : null,
    );
  }
}

/// 窄窗降级：档案栏收成顶部一条横向「已定」胶囊。
class _DossierStrip extends StatelessWidget {
  const _DossierStrip({
    required this.dossier,
    required this.colors,
    required this.onEdit,
  });

  final _DossierData dossier;
  final _StageColors colors;
  final ValueChanged<_DossierFactData> onEdit;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    return Container(
      height: 40,
      // 横向滚动视图没有固有宽度，不撑满就会被外层 Column 居中成一小条。
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: c.card,
        border: Border(bottom: BorderSide(color: c.borderSoft)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: <Widget>[
            Text(dossier.head,
                style: TextStyle(
                    fontSize: 11.5, fontWeight: FontWeight.w700, color: c.text)),
            const SizedBox(width: 10),
            for (final _DossierFactData f in dossier.facts)
              if (f.set)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: GestureDetector(
                    onTap: () => onEdit(f),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 9, vertical: 4),
                      decoration: BoxDecoration(
                        color: c.card2,
                        border: Border.all(color: c.borderSoft),
                        borderRadius: BorderRadius.circular(9),
                      ),
                      child: Text(
                        "${f.label} ${f.value}",
                        style: TextStyle(fontSize: 10.5, color: c.text2),
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

/// 打字中三点动画。
class _TypingDots extends StatefulWidget {
  const _TypingDots({required this.colors});

  final _StageColors colors;

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < 3; i++)
            FadeTransition(
              opacity: CurveTween(
                curve: Interval(i * 0.18, 0.5 + i * 0.18, curve: Curves.easeInOut),
              ).animate(_ctrl),
              child: Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.only(right: 4),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.colors.muted,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 天气面板卡（只在规划流中出现）。
class _WeatherPanel extends StatelessWidget {
  const _WeatherPanel({required this.card, required this.colors});

  final _WeatherCardData card;
  final _StageColors colors;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            for (final _WeatherDay d in card.days)
              Container(
                width: 168,
                padding: const EdgeInsets.fromLTRB(11, 9, 11, 8),
                decoration: BoxDecoration(
                  color: colors.card2,
                  border: Border.all(color: colors.borderSoft),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Row(
                  children: <Widget>[
                    Icon(d.icon, size: 22, color: d.iconColor(colors)),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text("${d.dateLabel} · ${d.text}",
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: 10, color: colors.muted)),
                          const SizedBox(height: 1),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.baseline,
                            textBaseline: TextBaseline.alphabetic,
                            children: <Widget>[
                              Text("${d.hi}°",
                                  style: TextStyle(
                                      fontSize: 12.5,
                                      fontWeight: FontWeight.w700,
                                      color: colors.text)),
                              Text(" / ${d.lo}°",
                                  style: TextStyle(
                                      fontSize: 9.5, color: colors.muted)),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
        if (card.tip.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 3,
                  height: 12,
                  margin: const EdgeInsets.only(top: 3),
                  decoration: BoxDecoration(
                    color: colors.orange,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(card.tip,
                      style:
                          TextStyle(fontSize: 11.5, height: 1.5, color: colors.text2)),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// 串行问题卡（目的地/天数/预算/交通/住房/吃的）：单选点选即答，答完即消失。
/// 同行人卡例外：选人先亮出推断的节奏，确认（或改）后才回传。
class _ChoiceCard extends StatefulWidget {
  const _ChoiceCard({
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onConfirm,
  });

  final _ChoiceCardData card;
  final _StageColors colors;
  final bool enabled;
  final void Function(List<String> values, String? note) onConfirm;

  @override
  State<_ChoiceCard> createState() => _ChoiceCardState();
}

class _ChoiceCardState extends State<_ChoiceCard> {
  final Set<String> _selected = <String>{};
  late final TextEditingController _note =
      TextEditingController(text: widget.card.prefill.join(" "));

  /// 用户手动改过的节奏（null = 用同行人推断出来的那档）。
  String? _paceOverride;
  bool _showPace = false;

  /// 当前选中的同行人选项对应的推断结论（单选且命中才非空）。
  _ChoiceInferData? get _inferForSelected {
    if (widget.card.multi || _selected.length != 1) return null;
    return widget.card.infer[_selected.first];
  }

  void _tapChip(String option) {
    if (!widget.enabled) return;
    if (widget.card.multi) {
      setState(() {
        if (!_selected.remove(option)) _selected.add(option);
      });
      return;
    }
    // 同行人卡：选人只定结论，节奏先亮出来（可直接改），按「就按这个来」才回传。
    if (widget.card.infer.containsKey(option)) {
      setState(() {
        _selected
          ..clear()
          ..add(option);
        _paceOverride = null;
        _showPace = false;
      });
      return;
    }
    // 普通单选：立即回传（服务端回执会带回下一张卡）；已输入的备注一并带上，
    // 例如「5天」+「10月1日出发」两者都保留。
    final String note = _note.text.trim();
    widget.onConfirm(
      <String>[option],
      note.isEmpty ? null : note,
    );
  }

  void _confirmInfer() {
    final _ChoiceInferData? infer = _inferForSelected;
    if (!widget.enabled || infer == null) return;
    final String note = _note.text.trim();
    widget.onConfirm(
      <String>[
        _selected.first,
        if (_paceOverride != null && _paceOverride != infer.pace) _paceOverride!,
      ],
      note.isEmpty ? null : note,
    );
  }

  void _submitNoteOnly() {
    final String text = _note.text.trim();
    if (!widget.enabled || text.isEmpty) return;
    widget.onConfirm(const <String>[], text);
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _ChoiceCardData card = widget.card;
    final _CardProgress? progress = card.progress;
    final _ChoiceInferData? infer = _inferForSelected;
    final bool hasNote = _note.text.trim().isNotEmpty;
    final bool showInferConfirm = infer != null && widget.enabled;
    final bool showConfirm =
        card.multi && widget.enabled && (_selected.isNotEmpty || hasNote);
    final bool showNoteOnly =
        !card.multi && infer == null && card.allowNote && widget.enabled && hasNote;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (progress != null && progress.summary.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              progress.summary,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10.5, color: c.muted),
            ),
          ),
        if (card.prefill.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text("记得你偏好过：${card.prefill.join("、")}",
                style: TextStyle(fontSize: 11, color: c.muted)),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            for (final String option in card.options)
              GestureDetector(
                onTap: () => _tapChip(option),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 120),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  decoration: BoxDecoration(
                    color: _selected.contains(option) ? c.accentSoft : c.card2,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: _selected.contains(option)
                          ? c.accentBorder
                          : c.borderSoft,
                    ),
                  ),
                  child: Text(
                    option,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: _selected.contains(option)
                          ? FontWeight.w700
                          : FontWeight.w600,
                      color: _selected.contains(option) ? c.accent : c.text2,
                    ),
                  ),
                ),
              ),
          ],
        ),
        if (infer != null) ...<Widget>[
          const SizedBox(height: 12),
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: c.card2,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: c.borderSoft),
            ),
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Container(width: 2.5, color: c.accent),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Row(
                            children: <Widget>[
                              Expanded(
                                child: Text.rich(
                                  TextSpan(
                                    style:
                                        TextStyle(fontSize: 12.5, color: c.text2),
                                    children: <InlineSpan>[
                                      const TextSpan(text: "节奏 "),
                                      TextSpan(
                                        text: _paceOverride ?? infer.pace,
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w700,
                                          color: c.accent,
                                        ),
                                      ),
                                      TextSpan(
                                        text: "　按「${_selected.first}」推断",
                                        style: TextStyle(
                                            fontSize: 10.5, color: c.muted),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              _KitTextAction(
                                label: _showPace ? "收起" : "改",
                                colors: c,
                                enabled: widget.enabled,
                                onTap: () =>
                                    setState(() => _showPace = !_showPace),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(
                            infer.detail,
                            style: TextStyle(
                                fontSize: 10.5, height: 1.5, color: c.muted),
                          ),
                          if (_showPace) ...<Widget>[
                            const SizedBox(height: 9),
                            Wrap(
                              spacing: 7,
                              runSpacing: 7,
                              children: <Widget>[
                                for (final String pace in infer.options)
                                  GestureDetector(
                                    onTap: widget.enabled
                                        ? () => setState(() {
                                              _paceOverride =
                                                  pace == infer.pace ? null : pace;
                                            })
                                        : null,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 6),
                                      decoration: BoxDecoration(
                                        color:
                                            (_paceOverride ?? infer.pace) == pace
                                                ? c.accentSoft
                                                : c.card,
                                        borderRadius: BorderRadius.circular(9),
                                        border: Border.all(
                                          color:
                                              (_paceOverride ?? infer.pace) ==
                                                      pace
                                                  ? c.accentBorder
                                                  : c.borderSoft,
                                        ),
                                      ),
                                      child: Text(
                                        pace,
                                        style: TextStyle(
                                          fontSize: 11.5,
                                          fontWeight: FontWeight.w600,
                                          color:
                                              (_paceOverride ?? infer.pace) ==
                                                      pace
                                                  ? c.accent
                                                  : c.text2,
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
                  ),
                ],
              ),
            ),
          ),
        ],
        if (card.placeholder != null) ...<Widget>[
          const SizedBox(height: 10),
          SizedBox(
            width: 280,
            height: 34,
            child: TextField(
              controller: _note,
              style: TextStyle(fontSize: 12, color: c.text),
              decoration: InputDecoration(
                isDense: true,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                filled: true,
                fillColor: c.card2,
                hintText: card.placeholder,
                hintStyle: TextStyle(fontSize: 12, color: c.muted),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.accent),
                ),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ],
        if (showInferConfirm || showConfirm || showNoteOnly) ...<Widget>[
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              _KitPrimaryButton(
                label: showInferConfirm
                    ? "就按这个来"
                    : showConfirm
                        ? "就这些"
                        : "就用这个",
                colors: c,
                enabled: widget.enabled,
                onTap: showInferConfirm
                    ? _confirmInfer
                    : showConfirm
                        ? () => widget.onConfirm(
                              _selected.toList(growable: false),
                              _note.text,
                            )
                        : _submitNoteOnly,
              ),
              if (card.multi) ...<Widget>[
                const SizedBox(width: 14),
                _KitTextAction(
                  label: "先不选",
                  colors: c,
                  enabled: widget.enabled,
                  onTap: () {
                    setState(_selected.clear);
                    widget.onConfirm(const <String>[], null);
                  },
                ),
              ],
            ],
          ),
        ],
      ],
    );
  }
}

/// 规划前筛选卡：服务端按段下发（先景点、再住宿、最后美食），一张卡一段。
/// 每行「名称挂真数指标 / 全宽介绍 / 全宽错落三图」。
/// 卡面上的数字全部由服务端算好下发：没取到的指标就不出现，价格取不到就是「待核价」。
class _GuideSelectCard extends StatefulWidget {
  const _GuideSelectCard({
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onConfirm,
    required this.onDelegate,
    required this.onPreview,
  });

  final _GuideCardData card;
  final _StageColors colors;
  final bool enabled;
  final VoidCallback onConfirm;
  final VoidCallback onDelegate;

  /// 点图看大图：双面板覆盖层挂在页面根 Stack（本页是全屏路由，
  /// 通用 ImagePreviewLauncher 打的主壳右分栏在这里看不见）。
  final void Function(_GuideItemData item, String catLabel, int index) onPreview;

  @override
  State<_GuideSelectCard> createState() => _GuideSelectCardState();
}

class _GuideSelectCardState extends State<_GuideSelectCard> {
  int get _pickedCount => widget.card.cats
      .expand((_GuideCatData c) => c.items)
      .where((_GuideItemData i) => i.picked)
      .length;

  @override
  void initState() {
    super.initState();
    // 出卡即预热本屏实拍图：滚到哪都能直接见画面，不闪一层占位。
    TravelImageWarmer.warm(<String>[
      for (final _GuideCatData cat in widget.card.cats)
        for (final _GuideItemData i in cat.items)
          for (final String u in i.photos) LinkUtils.resolveMediaUrl(u),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final List<_GuideCatData> cats = widget.card.cats;
    final String singleKey =
        cats.length == 1 ? cats.first.key : "";
    final String measure = singleKey == "stay" || singleKey == "food" ? "家" : "处";
    final String confirmLabel = switch (singleKey) {
      "view" => "就这些景点，挑住的",
      "stay" => "就住这，挑吃的",
      _ => "就按这些排行程",
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 560),
          child: CustomScrollView(
            slivers: <Widget>[
              for (final _GuideCatData cat in cats) ..._sectionSlivers(c, cat),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.only(top: 12),
          decoration:
              BoxDecoration(border: Border(top: BorderSide(color: c.borderSoft))),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  _pickedCount > 0
                      ? "已选 $_pickedCount $measure"
                      : "还没勾——想去的打勾",
                  style: TextStyle(fontSize: 11.5, color: c.text2),
                ),
              ),
              _KitTextAction(
                label: "全部交给你",
                colors: c,
                enabled: widget.enabled,
                onTap: widget.onDelegate,
              ),
              const SizedBox(width: 12),
              _KitPrimaryButton(
                label: confirmLabel,
                colors: c,
                enabled: widget.enabled && _pickedCount > 0,
                onTap: widget.onConfirm,
              ),
            ],
          ),
        ),
      ],
    );
  }

  List<Widget> _sectionSlivers(_StageColors c, _GuideCatData cat) {
    final List<_GuideItemData> items = cat.items;
    return <Widget>[
      SliverPersistentHeader(
        pinned: true,
        delegate: _GuideSectionHeaderDelegate(
          colors: c,
          label: cat.label,
          count: items.length,
          sortNote: cat.sortNote,
        ),
      ),
      if (cat.anchor != null)
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
            child: Text(
              "${cat.anchor!.why} · 想换个参照点，直接在下面说一句",
              style: TextStyle(fontSize: 10.5, height: 1.5, color: c.muted),
            ),
          ),
        ),
      SliverList(
        delegate: SliverChildBuilderDelegate(
          (BuildContext _, int i) => _GuideRow(
            entry: items[i],
            catLabel: cat.label,
            colors: c,
            enabled: widget.enabled,
            topSep: i > 0,
            onToggle: () => setState(() => items[i].picked = !items[i].picked),
            onPreview: (int photoIndex) =>
                widget.onPreview(items[i], cat.label, photoIndex),
          ),
          childCount: items.length,
        ),
      ),
    ];
  }
}

/// 段标题（吸顶）：段名 + 条数 + 这一段的真实排序依据。
class _GuideSectionHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _GuideSectionHeaderDelegate({
    required this.colors,
    required this.label,
    required this.count,
    required this.sortNote,
  });

  final _StageColors colors;
  final String label;
  final int count;
  final String sortNote;

  @override
  double get minExtent => 40;

  @override
  double get maxExtent => 40;

  @override
  Widget build(
      BuildContext context, double shrinkOffset, bool overlapsContent) {
    final _StageColors c = colors;
    return Container(
      color: c.card,
      padding: const EdgeInsets.fromLTRB(2, 12, 2, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: <Widget>[
          Text(label,
              style: TextStyle(
                  fontSize: 13.5, fontWeight: FontWeight.w700, color: c.text)),
          const SizedBox(width: 6),
          Text("$count", style: TextStyle(fontSize: 10.5, color: c.muted)),
          if (sortNote.isNotEmpty) ...<Widget>[
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                sortNote,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: 10.5, color: c.muted),
              ),
            ),
          ],
        ],
      ),
    );
  }

  @override
  bool shouldRebuild(_GuideSectionHeaderDelegate oldDelegate) =>
      oldDelegate.label != label ||
      oldDelegate.sortNote != sortNote ||
      oldDelegate.count != count ||
      oldDelegate.colors != colors;
}

/// 一行一个地方：名称 + 指标胶囊 + 勾选 / 介绍 / 错落三图。
/// hover 态只活在本 widget 里，不上提给父卡 setState。
class _GuideRow extends StatefulWidget {
  const _GuideRow({
    required this.entry,
    required this.catLabel,
    required this.colors,
    required this.enabled,
    required this.topSep,
    required this.onToggle,
    required this.onPreview,
  });

  final _GuideItemData entry;
  final String catLabel;
  final _StageColors colors;
  final bool enabled;
  final bool topSep;
  final VoidCallback onToggle;
  final void Function(int photoIndex) onPreview;

  @override
  State<_GuideRow> createState() => _GuideRowState();
}

class _GuideRowState extends State<_GuideRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _GuideItemData e = widget.entry;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        curve: Curves.easeOut,
        padding: const EdgeInsets.fromLTRB(10, 12, 10, 14),
        decoration: BoxDecoration(
          color: _hover ? c.card2 : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: widget.topSep && !_hover
              ? Border(top: BorderSide(color: c.borderSoft))
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                      color: _hover ? c.accent : c.muted, shape: BoxShape.circle),
                ),
                const SizedBox(width: 9),
                Flexible(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: e.photos.isEmpty ? null : () => widget.onPreview(0),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Flexible(
                          child: Text(
                            e.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14.5,
                              fontWeight: FontWeight.w700,
                              color: c.text,
                            ),
                          ),
                        ),
                        if (e.photos.isNotEmpty) ...<Widget>[
                          const SizedBox(width: 4),
                          Icon(Icons.search_rounded, size: 13, color: c.muted),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 9),
                Flexible(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    alignment: WrapAlignment.end,
                    children: <Widget>[
                      for (final _GuideMetricData m in e.metrics)
                        _MetricPill(metric: m, colors: c, hot: _hover),
                    ],
                  ),
                ),
                const SizedBox(width: 9),
                _CheckDot(
                  key: Key("guide-check-${e.name}"),
                  picked: e.picked,
                  colors: c,
                  hover: _hover,
                  onTap: widget.enabled ? widget.onToggle : null,
                ),
              ],
            ),
            if (e.intro.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 7, bottom: 2),
                child: Text(
                  e.intro,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style:
                      TextStyle(fontSize: 12.5, height: 1.7, color: c.text2),
                ),
              ),
            _StaggerPhotoRow(
              entry: e,
              colors: c,
              hover: _hover,
              onTapPhoto: widget.onPreview,
            ),
          ],
        ),
      ),
    );
  }
}

/// 指标胶囊：hover 时提亮 + 上浮 1px，Tooltip 给这条数的出处。
class _MetricPill extends StatelessWidget {
  const _MetricPill({
    required this.metric,
    required this.colors,
    required this.hot,
  });

  final _GuideMetricData metric;
  final _StageColors colors;
  final bool hot;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    // 「待核价」是本店报价没取到的那格：保持灰、不抢注意力（真价格才给暖色）。
    final bool pending = metric.kind == "price" && !metric.label.contains("¥");
    final Color tint = metric.kind == "heat" || (metric.kind == "price" && !pending)
        ? c.orange
        : metric.kind == "distance"
            ? c.rainBlue
            : pending
                ? c.muted
                : c.text;
    final Color fg = hot ? tint : (metric.kind == "rating" ? c.text2 : tint);
    return Tooltip(
      message: metric.source.isEmpty ? metric.label : metric.source,
      waitDuration: const Duration(milliseconds: 500),
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      textStyle: TextStyle(fontSize: 10.5, height: 1.5, color: c.text),
      decoration: BoxDecoration(
        color: c.card,
        border: Border.all(color: c.borderSoft),
        borderRadius: BorderRadius.circular(8),
      ),
      child: MouseRegion(
        cursor: SystemMouseCursors.help,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          margin: EdgeInsets.only(top: hot ? -1 : 0),
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
          decoration: BoxDecoration(
            color: hot ? c.accentSoft : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: hot ? c.accentBorder : c.borderSoft),
          ),
          child: Text(
            metric.label,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: hot ? FontWeight.w600 : FontWeight.w400,
              color: fg,
            ),
          ),
        ),
      ),
    );
  }
}

/// 勾选圆：hover 放大 1.12，选中态填充反色。
class _CheckDot extends StatelessWidget {
  const _CheckDot({
    super.key,
    required this.picked,
    required this.colors,
    required this.hover,
    required this.onTap,
  });

  final bool picked;
  final _StageColors colors;
  final bool hover;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: AnimatedScale(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          scale: hover && !picked ? 1.12 : 1.0,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            width: 20,
            height: 20,
            decoration: BoxDecoration(
              color: picked ? c.accent : Colors.transparent,
              shape: BoxShape.circle,
              border: Border.all(
                color: picked
                    ? c.accent
                    : (hover ? c.accentBorder : c.borderSoft),
                width: 1.5,
              ),
            ),
            child: picked
                ? Icon(Icons.check_rounded, size: 13, color: c.onAccent)
                : null,
          ),
        ),
      ),
    );
  }
}

/// 全宽错落三图：单位宽按三列算，第一格下沉 6、第二格贴顶、第三格下沉 14；
/// 实拍图有几张就摆几张，不拿假图补格（一张都没有时留一格地名首字块）。
class _StaggerPhotoRow extends StatelessWidget {
  const _StaggerPhotoRow({
    required this.entry,
    required this.colors,
    required this.hover,
    required this.onTapPhoto,
  });

  final _GuideItemData entry;
  final _StageColors colors;
  final bool hover;
  final void Function(int index) onTapPhoto;

  static const List<double> _tops = <double>[6, 0, 14];
  static const double _gap = 10;

  @override
  Widget build(BuildContext context) {
    final List<String> photos = entry.photos.take(3).toList();
    final List<String> slots = photos.isEmpty ? <String>[""] : photos;
    return LayoutBuilder(
      builder: (BuildContext _, BoxConstraints cons) {
        final double unit = (cons.maxWidth - _gap * 2) / 3;
        final double h = unit * 0.86;
        return Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (int i = 0; i < slots.length; i++) ...<Widget>[
                if (i > 0) const SizedBox(width: _gap),
                Padding(
                  padding: EdgeInsets.only(top: _tops[i]),
                  child: _PhotoTile(
                    key: Key("guide-photo-$i"),
                    url: slots[i],
                    name: entry.name,
                    width: unit,
                    height: h,
                    colors: colors,
                    hover: hover,
                    onTap: slots[i].isEmpty ? null : () => onTapPhoto(i),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({
    super.key,
    required this.url,
    required this.name,
    required this.width,
    required this.height,
    required this.colors,
    required this.hover,
    this.onTap,
  });

  final String url;
  final String name;
  final double width;
  final double height;
  final _StageColors colors;
  final bool hover;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    return GestureDetector(
      onTap: onTap,
      child: MouseRegion(
        cursor: onTap == null ? SystemMouseCursors.basic : SystemMouseCursors.zoomIn,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          width: width,
          height: height,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: hover ? c.accentBorder : c.borderSoft),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: c.shadow.withValues(alpha: 0.22),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: url.isEmpty
              ? _GuidePhotoFallback(colors: c, name: name)
              : Stack(
                  fit: StackFit.expand,
                  children: <Widget>[
                    CachedMediaImage(
                      url: LinkUtils.resolveMediaUrl(url),
                      fit: BoxFit.cover,
                      errorBuilder:
                          (BuildContext _, Object __, StackTrace? ___) =>
                              _GuidePhotoFallback(colors: c, name: name),
                    ),
                    if (hover)
                      Positioned(
                        right: 7,
                        bottom: 6,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.45),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text(
                            "看大图",
                            style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.w500,
                                color: Color(0xD9FFFFFF)),
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// 没有实拍图（或图挂了）时的格子：地名首字实色块，不塌成一行文字。
class _GuidePhotoFallback extends StatelessWidget {
  const _GuidePhotoFallback({required this.colors, required this.name});

  final _StageColors colors;
  final String name;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    final String ch = name.isEmpty ? "?" : name.substring(0, 1);
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[
            c.accent.withValues(alpha: 0.22),
            c.accent.withValues(alpha: 0.05),
          ],
        ),
      ),
      child: Center(
        child: Text(
          ch,
          style: TextStyle(
            fontSize: 26,
            fontWeight: FontWeight.w700,
            color: c.accent.withValues(alpha: 0.55),
          ),
        ),
      ),
    );
  }
}

/// 双面板看图的入参。
class _GuidePreviewData {
  _GuidePreviewData({
    required this.catLabel,
    required this.item,
    required this.index,
  });

  final String catLabel;
  final _GuideItemData item;
  final int index;
}

/// 双面板看图：左边大图（‹ › 翻页、滚轮缩放、Esc 关），
/// 右边完整介绍 + 每条指标的出处 + 地址 + 勾选（与行内圆点同源）。
class _GuideViewerOverlay extends StatefulWidget {
  const _GuideViewerOverlay({
    required this.preview,
    required this.colors,
    required this.onClose,
    required this.onToggle,
  });

  final _GuidePreviewData preview;
  final _StageColors colors;
  final VoidCallback onClose;
  final VoidCallback onToggle;

  @override
  State<_GuideViewerOverlay> createState() => _GuideViewerOverlayState();
}

class _GuideViewerOverlayState extends State<_GuideViewerOverlay> {
  final TransformationController _zoom = TransformationController();
  late int _index = _clamped(widget.preview.index);

  int _clamped(int i) {
    final int total = widget.preview.item.photos.length;
    if (total == 0) return 0;
    return i.clamp(0, total - 1);
  }

  @override
  void dispose() {
    _zoom.dispose();
    super.dispose();
  }

  void _step(int delta) {
    final int total = widget.preview.item.photos.length;
    if (total == 0) return;
    setState(() {
      _index = (_index + delta + total) % total;
      _zoom.value = Matrix4.identity();
    });
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _GuideItemData e = widget.preview.item;
    final List<String> photos = e.photos;
    return Focus(
      key: const Key("planning-guide-viewer"),
      autofocus: true,
      onKeyEvent: (FocusNode _, KeyEvent event) {
        if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
          return KeyEventResult.ignored;
        }
        if (event.logicalKey == LogicalKeyboardKey.escape) {
          widget.onClose();
          return KeyEventResult.handled;
        }
        if (event.logicalKey == LogicalKeyboardKey.arrowLeft) {
          _step(-1);
          return KeyEventResult.handled;
        }
        if (event.logicalKey == LogicalKeyboardKey.arrowRight) {
          _step(1);
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
            child: ColoredBox(color: c.bg.withValues(alpha: 0.88)),
          ),
          Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints:
                    const BoxConstraints(maxWidth: 900, maxHeight: 620),
                child: Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: c.card,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: c.border),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            Expanded(
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(14),
                                child: Container(
                                  color: c.card2,
                                  child: Stack(
                                    fit: StackFit.expand,
                                    children: <Widget>[
                                      if (photos.isEmpty)
                                        _GuidePhotoFallback(
                                            colors: c, name: e.name)
                                      else
                                        InteractiveViewer(
                                          transformationController: _zoom,
                                          minScale: 0.6,
                                          maxScale: 6,
                                          child: CachedMediaImage(
                                            url: LinkUtils.resolveMediaUrl(
                                                photos[_index]),
                                            fit: BoxFit.contain,
                                            errorBuilder: (BuildContext _,
                                                    Object __,
                                                    StackTrace? ___) =>
                                                _GuidePhotoFallback(
                                                    colors: c, name: e.name),
                                          ),
                                        ),
                                      if (photos.length > 1) ...<Widget>[
                                        Positioned(
                                          left: 8,
                                          top: 0,
                                          bottom: 0,
                                          child: _ViewerArrow(
                                            colors: c,
                                            icon: Icons.chevron_left_rounded,
                                            onTap: () => _step(-1),
                                          ),
                                        ),
                                        Positioned(
                                          right: 8,
                                          top: 0,
                                          bottom: 0,
                                          child: _ViewerArrow(
                                            colors: c,
                                            icon: Icons.chevron_right_rounded,
                                            onTap: () => _step(1),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                              ),
                            ),
                            if (photos.length > 1)
                              Padding(
                                padding: const EdgeInsets.only(top: 10),
                                child: SizedBox(
                                  height: 46,
                                  child: ListView(
                                    scrollDirection: Axis.horizontal,
                                    children: <Widget>[
                                      for (int i = 0; i < photos.length; i++)
                                        Padding(
                                          padding:
                                              const EdgeInsets.only(right: 8),
                                          child: GestureDetector(
                                            onTap: () => setState(
                                                () => _index = i),
                                            child: AnimatedContainer(
                                              duration: const Duration(
                                                  milliseconds: 120),
                                              width: 62,
                                              clipBehavior: Clip.antiAlias,
                                              decoration: BoxDecoration(
                                                borderRadius:
                                                    BorderRadius.circular(9),
                                                border: Border.all(
                                                  color: i == _index
                                                      ? c.accent
                                                      : c.borderSoft,
                                                ),
                                              ),
                                              child: CachedMediaImage(
                                                url: LinkUtils.resolveMediaUrl(
                                                    photos[i]),
                                                fit: BoxFit.cover,
                                                errorBuilder: (BuildContext _,
                                                        Object __,
                                                        StackTrace? ___) =>
                                                    _GuidePhotoFallback(
                                                        colors: c, name: e.name),
                                              ),
                                            ),
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 14),
                      SizedBox(
                        width: 268,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    e.name,
                                    style: TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w700,
                                      color: c.text,
                                    ),
                                  ),
                                ),
                                IconButton(
                                  key: const Key("guide-viewer-close"),
                                  onPressed: widget.onClose,
                                  icon: Icon(Icons.close_rounded,
                                      size: 18, color: c.muted),
                                  visualDensity: VisualDensity.compact,
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(),
                                ),
                              ],
                            ),
                            Text(widget.preview.catLabel,
                                style:
                                    TextStyle(fontSize: 10.5, color: c.muted)),
                            const SizedBox(height: 9),
                            Expanded(
                              child: SingleChildScrollView(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    if (e.intro.isNotEmpty)
                                      Text(
                                        e.intro,
                                        style: TextStyle(
                                            fontSize: 12.5,
                                            height: 1.7,
                                            color: c.text2),
                                      ),
                                    if (e.metrics.isNotEmpty) ...<Widget>[
                                      const SizedBox(height: 12),
                                      for (final _GuideMetricData m
                                          in e.metrics)
                                        Padding(
                                          padding:
                                              const EdgeInsets.only(bottom: 7),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: <Widget>[
                                              Text(
                                                m.label,
                                                style: TextStyle(
                                                    fontSize: 11,
                                                    fontWeight:
                                                        FontWeight.w600,
                                                    color: c.text),
                                              ),
                                              if (m.source.isNotEmpty)
                                                Padding(
                                                  padding: const EdgeInsets
                                                          .only(top: 2),
                                                  child: Text(
                                                    m.source,
                                                    style: TextStyle(
                                                        fontSize: 10,
                                                        height: 1.5,
                                                        color: c.muted),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                    ],
                                    if (e.address.isNotEmpty) ...<Widget>[
                                      const SizedBox(height: 10),
                                      Text(
                                        e.address,
                                        style: TextStyle(
                                            fontSize: 10.5,
                                            height: 1.6,
                                            color: c.muted),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ),
                            const SizedBox(height: 10),
                            Row(
                              children: <Widget>[
                                _CheckDot(
                                  picked: e.picked,
                                  colors: c,
                                  hover: true,
                                  onTap: widget.onToggle,
                                ),
                                const SizedBox(width: 9),
                                Expanded(
                                  child: Text(
                                    e.picked ? "已选，点这里去掉" : "想去就勾上",
                                    style: TextStyle(
                                        fontSize: 11.5, color: c.text2),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ViewerArrow extends StatelessWidget {
  const _ViewerArrow({
    required this.colors,
    required this.icon,
    required this.onTap,
  });

  final _StageColors colors;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.42),
            shape: BoxShape.circle,
            border: Border.all(color: colors.borderSoft),
          ),
          child: Icon(icon, size: 16, color: colors.text2),
        ),
      ),
    );
  }
}

/// 预订选择卡：大交通（机票/高铁）与住宿两段单选，均可不选。
/// 票价取不到时如实标「待核价」；选中的项由服务端算进预算与行程。
class _BookingCard extends StatefulWidget {
  const _BookingCard({
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onConfirm,
  });

  final _BookingCardData card;
  final _StageColors colors;
  final bool enabled;
  final void Function(String? transportKey, String? hotelKey) onConfirm;

  @override
  State<_BookingCard> createState() => _BookingCardState();
}

class _BookingCardState extends State<_BookingCard> {
  /// 选中项（null=先不订）；恢复会话时用服务端回显的选择初始化。
  String? _transportKey;
  String? _hotelKey;
  bool _inited = false;

  void _ensureInit() {
    if (_inited) return;
    _inited = true;
    _transportKey = widget.card.transportKey.isEmpty ? null : widget.card.transportKey;
    _hotelKey = widget.card.hotelKey.isEmpty ? null : widget.card.hotelKey;
  }

  void _tapTransport(String key) {
    if (!widget.enabled) return;
    setState(() => _transportKey = _transportKey == key ? null : key);
  }

  void _tapHotel(String key) {
    if (!widget.enabled) return;
    setState(() => _hotelKey = _hotelKey == key ? null : key);
  }

  void _confirm() {
    if (!widget.enabled) return;
    _ensureInit();
    widget.onConfirm(_transportKey, _hotelKey);
  }

  String _priceLabel(double? amount, {bool perNight = false}) {
    if (amount == null) return "待核价";
    final String n = amount == amount.roundToDouble()
        ? amount.round().toString()
        : amount.toStringAsFixed(2);
    return "¥$n${perNight ? "/晚" : ""}";
  }

  @override
  Widget build(BuildContext context) {
    _ensureInit();
    final _StageColors c = widget.colors;
    final _BookingCardData card = widget.card;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (card.trial)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              "体验模式：部分价格被平台脱敏，标「待核价」的以下单页实价为准。",
              style: TextStyle(fontSize: 10.5, height: 1.5, color: c.orange),
            ),
          ),
        if (card.transports.isNotEmpty) ...<Widget>[
          Text("大交通 · 往返", style: TextStyle(fontSize: 10.5, color: c.muted)),
          const SizedBox(height: 6),
          for (final _BookingTransportData t in card.transports)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _BookingTransportRow(
                data: t,
                colors: c,
                selected: _transportKey == t.key,
                enabled: widget.enabled,
                priceLabel: _priceLabel(t.amount),
                onTap: () => _tapTransport(t.key),
              ),
            ),
        ],
        if (card.hotels.isNotEmpty) ...<Widget>[
          const SizedBox(height: 8),
          Text(
            card.nights > 0 ? "住宿 · ${card.nights} 晚" : "住宿",
            style: TextStyle(fontSize: 10.5, color: c.muted),
          ),
          const SizedBox(height: 6),
          for (final _BookingHotelData h in card.hotels)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _BookingHotelRow(
                data: h,
                colors: c,
                selected: _hotelKey == h.key,
                enabled: widget.enabled,
                priceLabel: _priceLabel(h.amount, perNight: true),
                onTap: () => _tapHotel(h.key),
              ),
            ),
        ],
        if (card.transports.isEmpty && card.hotels.isEmpty)
          Text("这趟暂时没查到可选的班次和酒店，先按参考价排。",
              style: TextStyle(fontSize: 11.5, color: c.muted)),
        const SizedBox(height: 10),
        Row(
          children: <Widget>[
            _KitPrimaryButton(
              label: (_transportKey != null || _hotelKey != null)
                  ? "就按这个安排，去挑景点"
                  : "先不订，直接去挑景点",
              colors: c,
              enabled: widget.enabled,
              onTap: _confirm,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                _transportKey == null && _hotelKey == null
                    ? "两段都不选也行，选中的会算进预算和行程。"
                    : "再点一下已选项可取消。",
                maxLines: 2,
                style: TextStyle(fontSize: 10.5, height: 1.4, color: c.muted),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// 大交通选项行：班次号 + 去返程时刻 + 实价/待核价，选中亮 accent。
class _BookingTransportRow extends StatelessWidget {
  const _BookingTransportRow({
    required this.data,
    required this.colors,
    required this.selected,
    required this.enabled,
    required this.priceLabel,
    required this.onTap,
  });

  final _BookingTransportData data;
  final _StageColors colors;
  final bool selected;
  final bool enabled;
  final String priceLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    final _BookingTransportData t = data;
    final String head = t.no.isEmpty
        ? (t.isTrain ? "火车" : "航班")
        : "${t.no}${t.carrier.isEmpty ? "" : " · ${t.carrier}"}";
    final List<String> lines = <String>[
      if (t.outbound != null) "去程 ${t.outbound!.summary}",
      if (t.inbound != null) "返程 ${t.inbound!.summary}",
      if (t.viaHub.isNotEmpty) "经${t.viaHub}转机",
    ];
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? c.accentSoft : c.card2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: selected ? c.accentBorder : c.borderSoft),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(
              t.isTrain ? Icons.train_rounded : Icons.flight_takeoff_rounded,
              size: 15,
              color: selected ? c.accent : c.text2,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          head,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: selected ? c.accent : c.text,
                          ),
                        ),
                      ),
                      if (t.recommended) ...<Widget>[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: c.accent.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text("推荐",
                              style: TextStyle(
                                  fontSize: 9.5, color: c.accent)),
                        ),
                      ],
                    ],
                  ),
                  if (lines.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      lines.join("\n"),
                      style: TextStyle(
                          fontSize: 10.5, height: 1.45, color: c.text2),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              priceLabel,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: priceLabel == "待核价" ? c.muted : (selected ? c.accent : c.text),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 酒店选项行：名称 + 评分/档次/位置 + 每晚价，选中亮 accent。
class _BookingHotelRow extends StatelessWidget {
  const _BookingHotelRow({
    required this.data,
    required this.colors,
    required this.selected,
    required this.enabled,
    required this.priceLabel,
    required this.onTap,
  });

  final _BookingHotelData data;
  final _StageColors colors;
  final bool selected;
  final bool enabled;
  final String priceLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    final _BookingHotelData h = data;
    final List<String> meta = <String>[
      if (h.rating != null) "${h.rating}分",
      if (h.star.isNotEmpty) h.star,
      if (h.near.isNotEmpty) h.near,
    ];
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? c.accentSoft : c.card2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: selected ? c.accentBorder : c.borderSoft),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(Icons.hotel_outlined, size: 15, color: selected ? c.accent : c.text2),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          h.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: selected ? c.accent : c.text,
                          ),
                        ),
                      ),
                      if (h.fromPicks) ...<Widget>[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: c.accent.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text("你选过",
                              style: TextStyle(
                                  fontSize: 9.5, color: c.accent)),
                        ),
                      ] else if (h.recommended) ...<Widget>[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: c.accent.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text("推荐",
                              style: TextStyle(
                                  fontSize: 9.5, color: c.accent)),
                        ),
                      ],
                    ],
                  ),
                  if (meta.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      meta.join(" · "),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 10.5, height: 1.45, color: c.text2),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              priceLabel,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: priceLabel == "待核价" ? c.muted : (selected ? c.accent : c.text),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 筛选后的自选补充卡：景点/酒店/餐厅各一行自由输入，也可直接跳过。
class _WishlistAddCard extends StatefulWidget {
  const _WishlistAddCard({
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onSubmit,
  });

  final _WishlistCardData card;
  final _StageColors colors;
  final bool enabled;
  final void Function(Map<String, List<String>> extras, String note) onSubmit;

  @override
  State<_WishlistAddCard> createState() => _WishlistAddCardState();
}

class _WishlistAddCardState extends State<_WishlistAddCard> {
  final Map<String, TextEditingController> _fields =
      <String, TextEditingController>{
    "view": TextEditingController(),
    "stay": TextEditingController(),
    "food": TextEditingController(),
  };

  static const List<String> _keys = <String>["view", "stay", "food"];

  @override
  void dispose() {
    for (final TextEditingController c in _fields.values) {
      c.dispose();
    }
    super.dispose();
  }

  List<String> _parse(String raw) {
    final List<String> out = <String>[];
    for (final String part in raw.split(RegExp(r"[、,，;；/\s]+"))) {
      final String v = part.trim();
      if (v.length < 2) continue;
      if (!out.contains(v)) out.add(v);
    }
    return out;
  }

  Map<String, List<String>> get _extras => <String, List<String>>{
        for (final String key in _keys) key: _parse(_fields[key]!.text),
      };

  String get _note {
    final List<String> parts = <String>[];
    for (final String key in _keys) {
      final String text = _fields[key]!.text.trim();
      if (text.isEmpty) continue;
      parts.add("${_labelOf(key)}：$text");
    }
    return parts.join("；");
  }

  String _labelOf(String key) => switch (key) {
        "view" => "必去景点",
        "stay" => "想住",
        "food" => "想吃",
        _ => key,
      };

  IconData _iconOf(String key) => switch (key) {
        "stay" => Icons.hotel_outlined,
        "food" => Icons.restaurant_outlined,
        _ => Icons.place_outlined,
      };

  bool get _hasInput =>
      _fields.values.any((TextEditingController x) => x.text.trim().isNotEmpty);

  void _submit() {
    if (!widget.enabled) return;
    widget.onSubmit(_extras, _note);
  }

  void _skip() {
    if (!widget.enabled) return;
    widget.onSubmit(const <String, List<String>>{}, "");
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final List<String> picked = <String>[
      ...widget.card.view,
      ...widget.card.stay,
      ...widget.card.food,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (picked.isNotEmpty) ...<Widget>[
          Text("已选", style: TextStyle(fontSize: 10.5, color: c.muted)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: <Widget>[
              for (final String n in picked)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: c.accentSoft,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(n,
                      style: TextStyle(fontSize: 10.5, color: c.accent)),
                ),
            ],
          ),
          const SizedBox(height: 12),
        ],
        for (final String key in _keys)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: TextField(
              controller: _fields[key],
              enabled: widget.enabled,
              onChanged: (_) => setState(() {}),
              style: TextStyle(fontSize: 12.5, color: c.text),
              decoration: InputDecoration(
                isDense: true,
                filled: true,
                fillColor: c.card2,
                hintText: widget.card.placeholders[key] ?? "",
                hintStyle: TextStyle(fontSize: 11.5, color: c.muted),
                prefixIcon: Icon(_iconOf(key), size: 15, color: c.muted),
                prefixIconConstraints:
                    const BoxConstraints(minWidth: 32, minHeight: 36),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: c.accentBorder),
                ),
              ),
            ),
          ),
        const SizedBox(height: 2),
        Row(
          children: <Widget>[
            _KitTextAction(
              label: "没有补充，直接算",
              colors: c,
              enabled: widget.enabled,
              onTap: _skip,
            ),
            const Spacer(),
            _KitPrimaryButton(
              label: "加上这些，算预算",
              colors: c,
              enabled: widget.enabled && _hasInput,
              onTap: _submit,
            ),
          ],
        ),
      ],
    );
  }
}

/// 预算确认卡：明细来自真实报价，用户确认后才出最终方案。
class _BudgetCard extends StatelessWidget {
  const _BudgetCard({
    required this.budget,
    required this.colors,
    required this.enabled,
    required this.onApprove,
    required this.onAdjust,
  });

  final _BudgetData budget;
  final _StageColors colors;
  final bool enabled;
  final VoidCallback onApprove;
  final VoidCallback onAdjust;

  String get _symbol => switch (budget.currency) {
        "USD" => r"$",
        "EUR" => "€",
        "JPY" => "¥",
        "THB" => "฿",
        "IDR" => "Rp",
        "HKD" => r"HK$",
        _ => "¥",
      };

  String _money(double value) {
    final String digits = value.round().toString();
    return digits.replaceAllMapped(
      RegExp(r"\B(?=(\d{3})+(?!\d))"),
      (Match _) => ",",
    );
  }

  Color _keyColor(BuildContext context, String key) => switch (key) {
        "transport" => colors.accent,
        "hotel" => colors.green,
        "ticket" => TravelPalette.of(context).purple,
        _ => colors.orange,
      };

  @override
  Widget build(BuildContext context) {
    final _StageColors c = colors;
    final List<_BudgetItemData> items = budget.items;
    final double barTotal = items.fold<double>(
        0, (double s, _BudgetItemData i) => s + (i.amount ?? 0));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: <Widget>[
            Text(budget.total > 0 ? "$_symbol${_money(budget.total)}" : "待核价",
                style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.5,
                    color: c.text)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                  items.any((_BudgetItemData i) =>
                          i.key == "transport" && i.amount != null)
                      ? "含往返大交通（单人）· 实时价"
                      : "住宿 / 门票 / 餐饮合计",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: c.muted)),
            ),
          ],
        ),
        if (budget.discount > 0)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text("已省 $_symbol${_money(budget.discount)}",
                style: TextStyle(fontSize: 10.5, color: c.green)),
          ),
        const SizedBox(height: 12),
        if (barTotal > 0) ...<Widget>[
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: Row(
              children: <Widget>[
                for (final _BudgetItemData item in items)
                  if ((item.amount ?? 0) > 0)
                    Expanded(
                      flex: ((item.amount! / barTotal) * 1000)
                          .round()
                          .clamp(1, 1000)
                          .toInt(),
                      child: Container(
                        height: 6,
                        margin: const EdgeInsets.only(right: 2),
                        color: _keyColor(context, item.key),
                      ),
                    ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        for (final _BudgetItemData item in items)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: <Widget>[
                Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: _keyColor(context, item.key)),
                ),
                const SizedBox(width: 7),
                Text(item.label,
                    style: TextStyle(fontSize: 12, color: c.text2)),
                if (item.note.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 7),
                  Flexible(
                    child: Text(item.note,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 10, color: c.muted)),
                  ),
                ],
                const SizedBox(width: 10),
                Text(
                  item.amount == null
                      ? "未含"
                      : "$_symbol${_money(item.amount!)}",
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: item.amount == null ? c.muted : c.text,
                  ),
                ),
              ],
            ),
          ),
        if (budget.pendingItems > 0)
          Container(
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: c.orange.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: c.orange.withValues(alpha: 0.25)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(Icons.info_outline, size: 12, color: c.orange),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    "${budget.pendingItems} 项未取到实时价，标「待核价」且不计入合计",
                    style: TextStyle(
                        fontSize: 10.5, height: 1.45, color: c.orange),
                  ),
                ),
              ],
            ),
          ),
        if (budget.warnings.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 5),
            child: Text(budget.warnings.first,
                style: TextStyle(fontSize: 10, height: 1.45, color: c.muted)),
          ),
        const SizedBox(height: 14),
        if (budget.approved)
          Row(
            children: <Widget>[
              Icon(Icons.check_circle_rounded, size: 15, color: c.green),
              const SizedBox(width: 5),
              Text("已确认 · 最终方案在下方",
                  style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: c.green)),
            ],
          )
        else
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: <Widget>[
              _KitTextAction(label: "再调整", colors: c, onTap: onAdjust),
              const SizedBox(width: 12),
              _KitPrimaryButton(
                label: "同意，出方案",
                colors: c,
                enabled: enabled,
                onTap: onApprove,
              ),
            ],
          ),
      ],
    );
  }
}

/// 最终方案明细卡：待核实提醒 + 逐日逐站的时刻、交通与开放/预约。
/// 与行程主卡（海报 + 价格 + 入口按钮）拆开，独立成块。
class _DraftDetailCard extends StatelessWidget {
  const _DraftDetailCard({required this.draft, required this.colors});

  final _DraftData draft;
  final _StageColors colors;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(maxWidth: _kCardWidth),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(_kCardRadius),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      padding: const EdgeInsets.all(_kCardPad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _DraftPlanSection(draft: draft, colors: colors),
          const SizedBox(height: 12),
          Divider(height: 1, color: cs.outline.withValues(alpha: 0.14)),
          const SizedBox(height: 6),
          TextButton.icon(
            onPressed: () =>
                unawaited(_showTravelPlanTextSheet(context, draft: draft)),
            style: TextButton.styleFrom(
              foregroundColor: colors.text2,
              padding:
                  const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            icon: const Icon(Icons.ios_share, size: 13.5),
            label: const Text("文字版 · 存图分享",
                style:
                    TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}

/// 最终规划卡：沿用主对话行程卡的设计（封面海报 + 标题 + 主入口按钮）。
/// 最终方案明细：逐日逐站的时刻、两站间交通、开放/预约、闭馆与排程核实。
/// 这是「照着能走」的那一版方案，不只是跳去完整行程的入口。
class _DraftPlanSection extends StatefulWidget {
  const _DraftPlanSection({required this.draft, required this.colors});

  final _DraftData draft;
  final _StageColors colors;

  @override
  State<_DraftPlanSection> createState() => _DraftPlanSectionState();
}

class _DraftPlanSectionState extends State<_DraftPlanSection> {
  /// 折叠的天（默认全展开：用户要的就是一眼看完的整体安排）。
  final Set<int> _collapsed = <int>{};

  static const List<String> _weekdays = <String>[
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ];

  String _dateLabel(String iso) {
    if (iso.length < 10) return "";
    final DateTime? d = DateTime.tryParse(iso);
    if (d == null) return iso.substring(5).replaceAll("-", ".");
    final String mm = d.month.toString().padLeft(2, "0");
    final String dd = d.day.toString().padLeft(2, "0");
    return "$mm.$dd ${_weekdays[(d.weekday - 1).clamp(0, 6)]}";
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _VerificationData? v = widget.draft.verification;
    final List<_DraftDayData> days = widget.draft.days;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (v != null && (v.summary.isNotEmpty || v.issues.isNotEmpty))
          _buildVerification(c, v),
        if (v != null && (v.summary.isNotEmpty || v.issues.isNotEmpty))
          const SizedBox(height: 8),
        for (int i = 0; i < days.length; i++) _buildDay(c, days[i], i),
        if (widget.draft.wishlistMissed.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              "没排进去：${widget.draft.wishlistMissed.join("、")}（候选池里没找到，可换个名字告诉我）",
              style: TextStyle(fontSize: 10.5, height: 1.4, color: c.orange),
            ),
          ),
      ],
    );
  }

  Widget _buildVerification(_StageColors c, _VerificationData v) {
    final List<_VerificationIssueData> issues = <_VerificationIssueData>[
      ...v.issues,
    ]..sort((_VerificationIssueData a, _VerificationIssueData b) {
        int rank(String level) => level == "block" ? 0 : level == "warn" ? 1 : 2;
        return rank(a.level).compareTo(rank(b.level));
      });
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: c.orange.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: c.orange.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.rule_outlined, size: 14, color: c.orange),
              const SizedBox(width: 5),
              Expanded(
                child: Text(
                  v.summary.isEmpty ? "出发前核实提醒" : v.summary,
                  style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: c.orange),
                ),
              ),
            ],
          ),
          for (final _VerificationIssueData issue in issues.take(6))
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(
                    issue.level == "block"
                        ? Icons.block
                        : issue.level == "warn"
                            ? Icons.warning_amber_rounded
                            : Icons.info_outline,
                    size: 12,
                    color: issue.level == "info" ? c.text2 : c.orange,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      "Day ${issue.day + 1} · "
                      "${issue.name.isEmpty ? "" : "${issue.name}："}"
                      "${issue.message}"
                      "${issue.suggestion.isEmpty ? "" : " → ${issue.suggestion}"}",
                      style: TextStyle(
                        fontSize: 10.5,
                        height: 1.4,
                        color: issue.level == "info" ? c.text2 : c.orange,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (issues.length > 6)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                "另有 ${issues.length - 6} 条核实提醒，可在完整行程里查看",
                style: TextStyle(fontSize: 10, color: c.muted),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              "开放时间/预约规则以官方为准，出发前再确认一次。",
              style: TextStyle(fontSize: 9.5, color: c.muted),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDay(_StageColors c, _DraftDayData day, int index) {
    final bool collapsed = _collapsed.contains(index);
    final List<_DraftStopData> stops = day.items
        .where((_DraftStopData s) => s.type != "hotel")
        .toList(growable: false);
    String hotel = "";
    for (final _DraftStopData s in day.items) {
      if (s.type == "hotel") {
        hotel = s.name;
        break;
      }
    }
    final String date = _dateLabel(day.date);
    final String meta = <String>[
      if (day.theme.isNotEmpty) day.theme,
      if (day.weather.isNotEmpty) day.weather,
    ].join(" · ");
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: c.card2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: c.borderSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() {
              if (collapsed) {
                _collapsed.remove(index);
              } else {
                _collapsed.add(index);
              }
            }),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
              child: Row(
                children: <Widget>[
                  Text(
                    day.label,
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: c.text),
                  ),
                  if (date.isNotEmpty) ...<Widget>[
                    const SizedBox(width: 7),
                    Text(date,
                        style: TextStyle(fontSize: 10.5, color: c.muted)),
                  ],
                  const Spacer(),
                  Text(
                    "${stops.length} 站 · 路上 ${day.travelMin} 分",
                    style: TextStyle(fontSize: 10.5, color: c.muted),
                  ),
                  const SizedBox(width: 2),
                  Icon(
                    collapsed ? Icons.expand_more : Icons.expand_less,
                    size: 16,
                    color: c.muted,
                  ),
                ],
              ),
            ),
          ),
          if (!collapsed)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (meta.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 7),
                      child: Text(meta,
                          style:
                              TextStyle(fontSize: 10.5, color: c.text2)),
                    ),
                  if (hotel.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        children: <Widget>[
                          Icon(Icons.hotel_outlined, size: 12, color: c.muted),
                          const SizedBox(width: 4),
                          Expanded(
                            child: Text(
                              "住 $hotel",
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style:
                                  TextStyle(fontSize: 10.5, color: c.text2),
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (stops.isEmpty)
                    Text("当天以休整/自由活动为主",
                        style: TextStyle(fontSize: 10.5, color: c.muted))
                  else
                    for (int i = 0; i < stops.length; i++)
                      _buildStop(c, stops[i], last: i == stops.length - 1),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildStop(_StageColors c, _DraftStopData stop, {required bool last}) {
    final _DraftLegData? leg = stop.leg;
    final String legText = leg == null
        ? ""
        : "${leg.mode.isEmpty ? "前往" : leg.mode} ${leg.durationMin} 分"
            "${leg.distanceKm == null ? "" : " · ${leg.distanceKm! >= 10 ? leg.distanceKm!.toStringAsFixed(0) : leg.distanceKm!.toStringAsFixed(1)} km"}";
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          width: 40,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text(stop.time,
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: c.text)),
              if (stop.endTime.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Text(stop.endTime,
                      style: TextStyle(fontSize: 9.5, color: c.muted)),
                ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SizedBox(
                  width: 8,
                  child: Column(
                    children: <Widget>[
                      Container(
                        width: 7,
                        height: 7,
                        margin: const EdgeInsets.only(top: 5),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: c.accent,
                        ),
                      ),
                      if (!last)
                        Expanded(
                          child: Container(width: 1, color: c.borderSoft),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(bottom: last ? 0 : 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Expanded(
                              child: Text(
                                stop.name,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: c.text),
                              ),
                            ),
                            if (stop.price.isNotEmpty) ...<Widget>[
                              const SizedBox(width: 6),
                              Text(
                                stop.price,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style:
                                    TextStyle(fontSize: 10.5, color: c.text2),
                              ),
                            ],
                          ],
                        ),
                        if (legText.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Row(
                              children: <Widget>[
                                Icon(Icons.route_outlined,
                                    size: 11, color: c.muted),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: Text(legText,
                                      style: TextStyle(
                                          fontSize: 10, color: c.muted)),
                                ),
                              ],
                            ),
                          ),
                        if (stop.openingHours.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 3),
                            child: Text(
                              "开放 ${stop.openingHours}",
                              style: TextStyle(fontSize: 10, color: c.muted),
                            ),
                          ),
                        if (stop.booking.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 5),
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 7, vertical: 3),
                              decoration: BoxDecoration(
                                color: c.orange.withValues(alpha: 0.08),
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(
                                    color: c.orange.withValues(alpha: 0.25)),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Icon(Icons.event_available_outlined,
                                      size: 11, color: c.orange),
                                  const SizedBox(width: 4),
                                  Flexible(
                                    child: Text(stop.booking,
                                        style: TextStyle(
                                            fontSize: 10,
                                            height: 1.4,
                                            color: c.orange)),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        for (final String issue in stop.issues)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Icon(Icons.error_outline,
                                    size: 11, color: c.orange),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: Text(issue,
                                      style: TextStyle(
                                          fontSize: 10,
                                          height: 1.4,
                                          color: c.orange)),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _DraftCard extends StatefulWidget {
  const _DraftCard({
    required this.draft,
    required this.colors,
    required this.enabled,
    required this.onGenerate,
    required this.onAdjust,
  });

  final _DraftData draft;
  final _StageColors colors;
  final bool enabled;
  final VoidCallback onGenerate;
  final VoidCallback onAdjust;

  @override
  State<_DraftCard> createState() => _DraftCardState();
}

class _DraftCardState extends State<_DraftCard> {
  /// 目的地当前封面（活取，和主对话行程卡同一来源）；null=无图走渐变兜底。
  String? _cover;

  /// 海报兜底渐变（与主对话行程卡一致）。
  static const List<Color> _posterFallback = <Color>[
    Color(0xFF123243),
    Color(0xFF071A24),
  ];

  @override
  void initState() {
    super.initState();
    final String destination = widget.draft.destination.trim();
    if (destination.isEmpty) return;
    TravelLiveCover.fetch(destination).then((String? url) {
      if (!mounted || url == null || url.isEmpty) return;
      setState(() => _cover = url);
      MediaDiskCache.instance.warm(<String>[url]);
    });
  }

  String get _dateRange {
    final String start = widget.draft.startDate;
    final String end = widget.draft.endDate;
    String fmt(String v) => v.length >= 10 ? v.substring(5).replaceAll("-", ".") : v;
    if (start.isEmpty && end.isEmpty) return "";
    if (start.isEmpty) return fmt(end);
    if (end.isEmpty || end == start) return fmt(start);
    return "${fmt(start)} - ${fmt(end)}";
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final _DraftData draft = widget.draft;
    final int dayCount = draft.days.length;
    final String cover = (_cover ?? "").trim();
    return Container(
      constraints: const BoxConstraints(maxWidth: _kCardWidth),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(_kCardRadius),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          _buildPoster(c, cover, dayCount),
          Padding(
            padding: const EdgeInsets.fromLTRB(_kCardPad, 12, _kCardPad, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (draft.totalCost != null && draft.totalCost! > 0) ...[
                  Row(
                    children: <Widget>[
                      _MetaChip(
                        colors: c,
                        icon: Icons.payments_outlined,
                        text: "¥${draft.totalCost!.round()}",
                      ),
                    ],
                  ),
                  const SizedBox(height: 9),
                ],
                Row(
                  children: <Widget>[
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: widget.enabled ? widget.onGenerate : null,
                        style: FilledButton.styleFrom(
                          backgroundColor: c.accentBg,
                          foregroundColor: c.onAccent,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 9),
                          minimumSize: const Size(0, 40),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        icon: const Icon(Icons.travel_explore, size: 16),
                        label: const Text("打开完整行程",
                            style: TextStyle(
                                fontSize: 13.5, fontWeight: FontWeight.w700)),
                      ),
                    ),
                    const SizedBox(width: 8),
                    GestureDetector(
                      onTap: widget.onAdjust,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 11),
                        decoration: BoxDecoration(
                          border: Border.all(color: c.border),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text("再调整",
                            style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: c.text2)),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPoster(_StageColors c, String cover, int dayCount) {
    return SizedBox(
      height: 180,
      width: double.infinity,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          DecoratedBox(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: _posterFallback,
              ),
            ),
          ),
          if (cover.isNotEmpty)
            CachedMediaImage(
              url: cover,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Color(0x66000000),
                  Color(0x14000000),
                  Color(0xE6000000),
                ],
                stops: <double>[0.0, 0.42, 1.0],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    if (widget.draft.destination.isNotEmpty) ...<Widget>[
                      _DestinationBadge(destination: widget.draft.destination),
                      const SizedBox(width: 8),
                    ],
                    if (dayCount > 0)
                      Text("$dayCount 天行程",
                          style: TextStyle(
                              fontSize: 11.5,
                              color: Colors.white.withValues(alpha: 0.85))),
                    const Spacer(),
                    if (_dateRange.isNotEmpty)
                      Text(_dateRange,
                          style: TextStyle(
                              fontSize: 11,
                              color: Colors.white.withValues(alpha: 0.72))),
                  ],
                ),
                const Spacer(),
                Text(widget.draft.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 16.5,
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                        height: 1.35)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 海报上的目的地徽章（玻璃态，与主对话行程卡一致）。
class _DestinationBadge extends StatelessWidget {
  const _DestinationBadge({required this.destination});

  final String destination;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.32),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.map_outlined,
              size: 13, color: Colors.white.withValues(alpha: 0.92)),
          const SizedBox(width: 4),
          Text(destination,
              style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: Colors.white)),
        ],
      ),
    );
  }
}

/// 行程卡信息区的小标签（天数 / 预算 / 数据来源）。
class _MetaChip extends StatelessWidget {
  const _MetaChip({
    required this.colors,
    required this.icon,
    required this.text,
  });

  final _StageColors colors;
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: colors.card2,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 12, color: colors.muted),
          const SizedBox(width: 4),
          Text(text,
              style: TextStyle(
                  fontSize: 10, fontWeight: FontWeight.w600, color: colors.text2)),
        ],
      ),
    );
  }
}

/// 输入行。
class _InputRow extends StatelessWidget {
  const _InputRow({
    required this.controller,
    required this.focusNode,
    required this.colors,
    required this.enabled,
    required this.placeholder,
    required this.onSend,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final _StageColors colors;
  final bool enabled;
  final String placeholder;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 6, 6, 6),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(16),
        boxShadow: <BoxShadow>[
          BoxShadow(color: colors.shadow, blurRadius: 24, offset: const Offset(0, 6)),
        ],
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              enabled: enabled,
              style: TextStyle(fontSize: 14, color: colors.text),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                hintText: placeholder,
                hintStyle: TextStyle(fontSize: 14, color: colors.muted),
              ),
              onSubmitted: (_) => onSend(),
            ),
          ),
          const SizedBox(width: 10),
          GestureDetector(
            onTap: enabled ? onSend : null,
            child: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: enabled ? colors.accentBg : colors.card2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.arrow_forward,
                  size: 17, color: enabled ? colors.onAccent : colors.muted),
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 主题色绑定（AppPalette + TravelPalette，随深/暖变体热切换）
// ═══════════════════════════════════════════════════════════════════

class _StageColors {
  const _StageColors({
    required this.bg,
    required this.side,
    required this.sideSep,
    required this.card,
    required this.card2,
    required this.border,
    required this.borderSoft,
    required this.text,
    required this.text2,
    required this.muted,
    required this.accent,
    required this.accentSoft,
    required this.accentBorder,
    required this.accentBg,
    required this.onAccent,
    required this.green,
    required this.orange,
    required this.rainBlue,
    required this.shadow,
  });

  final Color bg;
  final Color side;
  final Color sideSep;
  final Color card;
  final Color card2;
  final Color border;
  final Color borderSoft;
  final Color text;
  final Color text2;
  final Color muted;
  final Color accent;
  final Color accentSoft;
  final Color accentBorder;
  final Color accentBg;
  final Color onAccent;
  final Color green;
  final Color orange;
  final Color rainBlue;
  final Color shadow;

  factory _StageColors.of(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final bool warm = variant == AppThemeVariant.warm;
    final TravelPalette t = TravelPalette.of(context);
    return _StageColors(
      bg: AppPalette.resolveMainPanel(variant),
      side: AppPalette.resolveSidebarPanel(variant),
      sideSep: AppPalette.resolveSidebarSeparator(variant),
      card: AppPalette.resolveCardBackground(variant),
      card2: warm
          ? AppPalette.warmSurfaceContainer
          : const Color(0xFF171717),
      border: warm ? AppPalette.warmOutline : AppPalette.locationDialogBorder,
      borderSoft: warm
          ? AppPalette.warmSidebarDivider
          : AppPalette.sidebarDivider,
      text: warm ? AppPalette.warmOnSurface : AppPalette.appBarForeground,
      text2: warm
          ? AppPalette.warmLocationDialogBody
          : AppPalette.locationDialogBody,
      muted: warm
          ? AppPalette.warmLocationDialogMuted
          : AppPalette.locationDialogMuted,
      accent: t.accent,
      accentSoft: warm
          ? AppPalette.warmLocationDialogButtonBg
          : const Color(0xFF232323),
      accentBorder: warm ? const Color(0xFF9DC3E8) : const Color(0xFF3F3F46),
      accentBg: t.accentBg,
      onAccent: t.onAccentBg,
      green: t.green,
      orange: t.orange,
      rainBlue: warm ? const Color(0xFF4C7FA8) : const Color(0xFF7FB8D8),
      shadow: warm
          ? const Color(0x1A232833)
          : const Color(0x73000000),
    );
  }

  Color get greenSoft =>
      green.withValues(alpha: 0.12);

  Color get orangeSoft => orange.withValues(alpha: 0.14);
}

// ═══════════════════════════════════════════════════════════════════
// 出票时刻：预算确认后，行程票从出票缝打印出来的仪式动画。
// 吐票（顿挫节奏）→ 字段逐行打印 → 绿章「已出票」盖章 + 票身轻震
// → 指示灯琥珀转绿 → 标题「叮——」→ 操作按钮浮现。
// ═══════════════════════════════════════════════════════════════════

/// 出票时刻数据（最终草案 + 预算卡的定价模式）。
class _TicketPrintMoment {
  const _TicketPrintMoment({required this.draft, this.pricingMode = ""});

  final _DraftData draft;
  final String pricingMode;
}

/// 票面视窗高度（吐票位移幅度基准；票实际高度小于它，底部自然留白）。
const double _kTicketExtent = 288;

/// 条码竖线宽度序列（打印质感的手写条码）。
const List<double> _kBarcodeBars = <double>[
  2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 2, 1, 3, 1, 2, 1, 1, 3, 1, 2,
];

class _TicketPrintOverlay extends StatefulWidget {
  const _TicketPrintOverlay({
    required this.moment,
    required this.colors,
    required this.onClose,
    required this.onOpenPlan,
  });

  final _TicketPrintMoment moment;
  final _StageColors colors;
  final VoidCallback onClose;
  final VoidCallback onOpenPlan;

  @override
  State<_TicketPrintOverlay> createState() => _TicketPrintOverlayState();
}

class _TicketPrintOverlayState extends State<_TicketPrintOverlay>
    with TickerProviderStateMixin {
  late final AnimationController _master = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 3200),
  )..forward();

  /// 打印中指示灯的琥珀闪烁。
  late final AnimationController _blink = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 480),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _master.dispose();
    _blink.dispose();
    super.dispose();
  }

  /// 吐票轨迹：出半截 → 停顿 → 出完（打印机顿挫节奏），值为票位移比例。
  static final Animatable<double> _passTrack =
      TweenSequence<double>(<TweenSequenceItem<double>>[
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: -1.04, end: -0.46)
          .chain(CurveTween(curve: Curves.easeInOutCubic)),
      weight: 42,
    ),
    TweenSequenceItem<double>(tween: ConstantTween<double>(-0.46), weight: 16),
    TweenSequenceItem<double>(
      tween: Tween<double>(begin: -0.46, end: 0)
          .chain(CurveTween(curve: Curves.easeOutCubic)),
      weight: 42,
    ),
  ]);

  double _seg(double v, double begin, double len) {
    final double t = (v - begin) / len;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t;
  }

  /// 字段逐行打印：opacity + 6px 上浮。
  Widget _stag(double v, double begin, Widget child) {
    final double t = Curves.easeOut.transform(_seg(v, begin, 0.08));
    return Opacity(
      opacity: t,
      child: Transform.translate(offset: Offset(0, (1 - t) * 6), child: child),
    );
  }

  String _shortDate(String s) {
    final String t = s.trim();
    if (t.length >= 10) return t.substring(5, 10).replaceAll('-', '.');
    return t;
  }

  String _money(double value) => value.round().toString().replaceAllMapped(
        RegExp(r"\B(?=(\d{3})+(?!\d))"),
        (Match _) => ",",
      );

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final _DraftData d = widget.moment.draft;
    final bool warm = AppThemeController.instance.value == AppThemeVariant.warm;

    final String destination =
        d.destination.isNotEmpty ? d.destination : d.title;
    final String d1 = _shortDate(d.startDate);
    final String d2 = _shortDate(d.endDate);
    final String dateLabel = d1.isEmpty && d2.isEmpty
        ? "待定"
        : d1 == d2 || d2.isEmpty
            ? (d1.isEmpty ? d2 : d1)
            : "$d1 – $d2";
    final int dayCount = d.days.length;
    final String dayLabel = dayCount <= 0
        ? "—"
        : "$dayCount 天${dayCount > 1 ? " ${dayCount - 1} 晚" : ""}";
    final String costLabel =
        d.totalCost != null && d.totalCost! > 0 ? "¥${_money(d.totalCost!)}" : "待核价";
    final String quoteLabel = switch (widget.moment.pricingMode) {
      "real-api" => "REAL QUOTE · 实时报价已确认",
      "real-database" => "REAL QUOTE · 市场价已确认",
      _ => "REAL QUOTE · 预算已确认",
    };
    final String digits =
        d.planId.replaceAll(RegExp(r"[^0-9]"), "");
    final String ticketNo =
        "NB-${digits.length >= 4 ? digits.substring(digits.length - 4) : digits.padLeft(4, "0")}";
    final String stampDate =
        "${DateTime.now().month.toString().padLeft(2, "0")}.${DateTime.now().day.toString().padLeft(2, "0")}";

    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[_master, _blink]),
      builder: (BuildContext context, _) {
        final double v = _master.value;
        final bool printing = v < 0.72;
        // 宽窗自适应放大：票基准 600 宽按 1050 基准窗口设计，宽屏上
        // 固定 600 会显得小而空（实测 1344 宽窗口仅占 45%）。
        final double scale =
            (MediaQuery.sizeOf(context).width / 1050).clamp(1.0, 1.45);

        return BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 6, sigmaY: 6),
          child: GestureDetector(
            // 点遮罩随时收起（数据已入对话流，不打断结果）。
            onTap: widget.onClose,
            child: Container(
              color: c.bg.withValues(alpha: warm ? 0.52 : 0.62),
              alignment: Alignment.center,
              child: Transform.scale(
                scale: scale,
                child: GestureDetector(
                  onTap: () {},
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 600),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                      _buildCopy(v, c),
                      const SizedBox(height: 22),
                      _buildPrinter(v, c, warm, printing),
                      _buildSlot(
                        v, c, destination, dateLabel, dayLabel, costLabel,
                        quoteLabel, ticketNo, stampDate,
                      ),
                      const SizedBox(height: 26),
                      _buildActions(v, c),
                    ],
                  ),
                ),
              ),
                ),
            ),
          ),
        );
      },
    );
  }

  /// 文案区：「正在出票 · · ·」→「叮——你的行程票打好了」交叉切换。
  Widget _buildCopy(double v, _StageColors c) {
    final double aIn = Curves.easeOut.transform(_seg(v, 0.02, 0.09));
    final double aOut = _seg(v, 0.78, 0.05);
    final double bIn = Curves.easeOut.transform(_seg(v, 0.83, 0.1));
    return Column(
      children: <Widget>[
        Opacity(
          opacity: Curves.easeOut.transform(_seg(v, 0.0, 0.1)),
          child: Text(
            "预算已确认 · 规划完成",
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 4,
              color: c.accent,
            ),
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 30,
          width: double.infinity,
          child: Stack(
            children: <Widget>[
              Opacity(
                opacity: aIn * (1 - aOut),
                child: Center(
                  child: Text(
                    "正在出票 · · ·",
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: c.text2,
                    ),
                  ),
                ),
              ),
              Opacity(
                opacity: bIn,
                child: Center(
                  child: Text(
                    "叮——你的行程票打好了",
                    style: TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                      color: c.text,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 出票缝：机身 + 黑缝 + 指示灯（琥珀闪 → 绿常亮）。
  Widget _buildPrinter(double v, _StageColors c, bool warm, bool printing) {
    final Color metal1 =
        warm ? const Color(0xFFE8E1D2) : const Color(0xFF1A1E24);
    final Color metal2 =
        warm ? const Color(0xFFDCD4C2) : const Color(0xFF0E1116);
    final Color mouthDark =
        warm ? const Color(0xFF8F8471) : const Color(0xFF05060A);
    // 琥珀灯随主题：深色底用柔和金琥珀（TravelPalette.orange），
    // 暖色米白底换亮琥珀——#B45309 在浅底上闪烁会发脏。
    final Color lampAmber =
        warm ? const Color(0xFFD97706) : c.orange;
    // 浅底上低 alpha 直接隐没，闪烁下限抬高。
    final double lampAlpha = warm
        ? 0.45 + 0.55 * _blink.value
        : 0.25 + 0.75 * _blink.value;
    final double glow =
        printing ? 0.22 + 0.3 * _blink.value : 0.12;
    return Column(
      children: <Widget>[
        Container(
          height: 52,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[metal1, metal2],
            ),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
            border: Border.all(color: c.border),
          ),
          child: Stack(
            children: <Widget>[
              Center(
                child: Text(
                  "NEXTBOT · TICKET PRINTER",
                  style: TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 3,
                    color: c.muted,
                  ),
                ),
              ),
              Positioned(
                right: 26,
                top: 22,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: printing
                        ? lampAmber.withValues(alpha: lampAlpha)
                        : c.green,
                    boxShadow: <BoxShadow>[
                      if (!printing)
                        BoxShadow(
                          color: c.green.withValues(alpha: 0.7),
                          blurRadius: 8,
                        )
                      else if (_blink.value > 0.5)
                        BoxShadow(
                          color: lampAmber.withValues(alpha: warm ? 0.45 : 0.6),
                          blurRadius: 6,
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        Container(
          height: 12,
          decoration: BoxDecoration(
            color: mouthDark,
            borderRadius: const BorderRadius.vertical(bottom: Radius.circular(8)),
            border: Border.all(color: c.border),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: c.accent.withValues(alpha: glow),
                blurRadius: 14,
                spreadRadius: -4,
                offset: const Offset(0, 5),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 票视窗：票从缝后吐出（ClipRect 裁切）。
  // ignore: long-parameter-list
  Widget _buildSlot(
    double v,
    _StageColors c,
    String destination,
    String dateLabel,
    String dayLabel,
    String costLabel,
    String quoteLabel,
    String ticketNo,
    String stampDate,
  ) {
    final double passT = _seg(v, 0.12, 0.5);
    final double dy = _passTrack.transform(passT) * _kTicketExtent;
    final double sway = math.sin(passT * math.pi) * 0.004;
    final double joltT = _seg(v, 0.7, 0.06);
    final double jolt = math.sin(joltT * 2 * math.pi) * 2 * (1 - joltT);
    return SizedBox(
      height: _kTicketExtent + 8,
      width: double.infinity,
      child: ClipRect(
        child: Stack(
          children: <Widget>[
            Positioned(
              top: 4,
              left: 0,
              right: 0,
              child: Transform.translate(
                offset: Offset(0, dy + jolt),
                child: Transform.rotate(
                  angle: sway,
                  child: _buildTicket(
                    v, c, destination, dateLabel, dayLabel, costLabel,
                    quoteLabel, ticketNo, stampDate,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ignore: long-parameter-list
  Widget _buildTicket(
    double v,
    _StageColors c,
    String destination,
    String dateLabel,
    String dayLabel,
    String costLabel,
    String quoteLabel,
    String ticketNo,
    String stampDate,
  ) {
    final double stampT = _seg(v, 0.68, 0.12);
    final double stampScale =
        2.3 + (1 - 2.3) * Curves.easeOutCubic.transform(stampT);
    final double stampOpacity = _seg(v, 0.68, 0.04);
    final double sheenT = _seg(v, 0.64, 0.2);

    return Container(
      constraints: const BoxConstraints(minHeight: 252),
      decoration: BoxDecoration(
        color: c.card,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: c.border),
        boxShadow: <BoxShadow>[
          BoxShadow(color: c.shadow, blurRadius: 34, offset: const Offset(0, 12)),
        ],
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          ClipRRect(
            borderRadius: BorderRadius.circular(18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // 顶部渐变条 + 出票完成的高光扫过
                SizedBox(
                  height: 5,
                  child: Stack(
                    children: <Widget>[
                      Container(
                        width: double.infinity,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: <Color>[c.accent, c.green],
                          ),
                        ),
                      ),
                      if (sheenT > 0 && sheenT < 1)
                        Align(
                          alignment:
                              Alignment(-1.8 + sheenT * 4.4, 0),
                          child: FractionallySizedBox(
                            widthFactor: 0.34,
                            child: Container(
                              decoration: BoxDecoration(
                                gradient: LinearGradient(
                                  colors: <Color>[
                                    Colors.white.withValues(alpha: 0),
                                    Colors.white.withValues(alpha: 0.55),
                                    Colors.white.withValues(alpha: 0),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                // IntrinsicHeight 提供有界高度：stretch 在无界约束下会
                // 给子元素强加 h=∞,布局损坏(票画不出来)。
                IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Expanded(
                        child: Padding(
                        padding: const EdgeInsets.fromLTRB(28, 22, 20, 22),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            _stag(
                              v,
                              0.34,
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: <Widget>[
                                  Text(
                                    "NEXTBOT TRAVEL · ITINERARY PASS",
                                    style: TextStyle(
                                      fontSize: 9.5,
                                      fontWeight: FontWeight.w600,
                                      letterSpacing: 2,
                                      color: c.muted,
                                    ),
                                  ),
                                  Text(
                                    ticketNo,
                                    style: TextStyle(
                                      fontSize: 9.5,
                                      fontWeight: FontWeight.w600,
                                      letterSpacing: 2,
                                      color: c.muted,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                            _stag(
                              v,
                              0.4,
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: <Widget>[
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text("出发 FROM",
                                          style: TextStyle(
                                              fontSize: 9.5,
                                              letterSpacing: 2,
                                              color: c.muted)),
                                      const SizedBox(height: 5),
                                      Text("此地",
                                          style: TextStyle(
                                              fontSize: 21,
                                              fontWeight: FontWeight.w700,
                                              color: c.text)),
                                    ],
                                  ),
                                  Padding(
                                    padding: const EdgeInsets.only(
                                        left: 14, right: 14, bottom: 5),
                                    child: Row(
                                      children: <Widget>[
                                        Container(
                                            width: 26,
                                            height: 1,
                                            color: c.accent.withValues(alpha: 0.5)),
                                        const SizedBox(width: 6),
                                        Icon(Icons.flight,
                                            size: 15, color: c.accent),
                                        const SizedBox(width: 6),
                                        Container(
                                            width: 26,
                                            height: 1,
                                            color: c.accent.withValues(alpha: 0.5)),
                                      ],
                                    ),
                                  ),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: <Widget>[
                                        Text("目的地 TO",
                                            style: TextStyle(
                                                fontSize: 9.5,
                                                letterSpacing: 2,
                                                color: c.muted)),
                                        const SizedBox(height: 5),
                                        Text(
                                          destination,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                              fontSize: 21,
                                              fontWeight: FontWeight.w700,
                                              color: c.text),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 20),
                            _stag(
                              v,
                              0.46,
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: <Widget>[
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text("日期 DATE",
                                          style: TextStyle(
                                              fontSize: 9.5,
                                              letterSpacing: 2,
                                              color: c.muted)),
                                      const SizedBox(height: 5),
                                      Text(dateLabel,
                                          style: TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w600,
                                              color: c.text2)),
                                    ],
                                  ),
                                  const SizedBox(width: 26),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text("行程 PLAN",
                                          style: TextStyle(
                                              fontSize: 9.5,
                                              letterSpacing: 2,
                                              color: c.muted)),
                                      const SizedBox(height: 5),
                                      Text(dayLabel,
                                          style: TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w600,
                                              color: c.text2)),
                                    ],
                                  ),
                                  const SizedBox(width: 26),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text("预算 BUDGET",
                                          style: TextStyle(
                                              fontSize: 9.5,
                                              letterSpacing: 2,
                                              color: c.muted)),
                                      const SizedBox(height: 5),
                                      Text(costLabel,
                                          style: TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w600,
                                              color: c.text2)),
                                    ],
                                  ),
                                  const Spacer(),
                                ],
                              ),
                            ),
                            const SizedBox(height: 18),
                            _stag(
                              v,
                              0.52,
                              Row(
                                children: <Widget>[
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 10, vertical: 4),
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(999),
                                      border: Border.all(
                                          color: c.green.withValues(alpha: 0.4)),
                                      color: c.greenSoft,
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: <Widget>[
                                        Icon(Icons.verified_outlined,
                                            size: 11, color: c.green),
                                        const SizedBox(width: 5),
                                        Text(quoteLabel,
                                            style: TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.w600,
                                                color: c.green)),
                                      ],
                                    ),
                                  ),
                                  const Spacer(),
                                  // 手写条码
                                  Row(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: <Widget>[
                                      for (int i = 0; i < _kBarcodeBars.length; i++) ...<Widget>[
                                        if (i > 0) const SizedBox(width: 1.6),
                                        Container(
                                          width: _kBarcodeBars[i],
                                          height: 22,
                                          color: c.text2.withValues(alpha: 0.5),
                                        ),
                                      ],
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // 存根联
                    _stag(
                      v,
                      0.58,
                      Container(
                        width: 104,
                        decoration: BoxDecoration(
                          border: Border(
                            left: BorderSide(color: c.border, width: 1.5),
                          ),
                        ),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: <Widget>[
                            Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: c.greenSoft,
                                border: Border.all(
                                    color: c.green,
                                    width: 1.5),
                              ),
                              child: Icon(Icons.check_rounded,
                                  size: 20, color: c.green),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              "TICKETED\n已出票",
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 9.5,
                                letterSpacing: 2,
                                height: 1.7,
                                color: c.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                    ),
                  ),
                ],
              ),
            ),
          // 绿章：出票完成时砸下
            if (stampT > 0)
              Positioned(
                right: 132,
                top: 42,
                child: IgnorePointer(
                  child: Opacity(
                    opacity: stampOpacity,
                    child: Transform.scale(
                      scale: stampScale,
                      child: Transform.rotate(
                        angle: -0.21,
                        child: Container(
                          width: 92,
                          height: 92,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(
                                color: c.green.withValues(alpha: 0.9), width: 2),
                          ),
                          child: Container(
                            margin: const EdgeInsets.all(5),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                  color: c.green.withValues(alpha: 0.55)),
                            ),
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: <Widget>[
                                Text("已出票",
                                    style: TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w800,
                                        letterSpacing: 3,
                                        color: c.green)),
                                const SizedBox(height: 3),
                                Text("NEXTBOT TRAVEL",
                                    style: TextStyle(
                                        fontSize: 7.5,
                                        letterSpacing: 1.5,
                                        color: c.green.withValues(alpha: 0.85))),
                                Text(stampDate,
                                    style: TextStyle(
                                        fontSize: 8.5,
                                        letterSpacing: 1.5,
                                        color: c.green.withValues(alpha: 0.85))),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
    );
  }

  Widget _buildActions(double v, _StageColors c) {
    final double t = Curves.easeOut.transform(_seg(v, 0.86, 0.1));
    return IgnorePointer(
      ignoring: t < 0.5,
      child: Opacity(
        opacity: t,
        child: Transform.translate(
        offset: Offset(0, (1 - t) * 10),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            GestureDetector(
              onTap: widget.onOpenPlan,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 13, vertical: 6.5),
                decoration: BoxDecoration(
                  color: c.accentBg,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  children: <Widget>[
                    Icon(Icons.map_outlined, size: 11.5, color: c.onAccent),
                    const SizedBox(width: 5),
                    Text("查看完整行程",
                        style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: c.onAccent)),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: widget.onClose,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 13, vertical: 6.5),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(color: c.border),
                ),
                child: Text("稍后再看",
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: c.text2)),
              ),
            ),
          ],
          ),
        ),
      ),
    );
  }
}
