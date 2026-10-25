import "dart:async" show unawaited;
import "dart:convert";
import "dart:io" show Platform;
import "dart:math" as math;
import "dart:ui" show FontFeature, ImageFilter;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show Clipboard, ClipboardData;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/link_utils.dart";
import "media_disk_cache.dart";
import "travel_plan_mobile_page.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";
import "travel_plan_window.dart";
import "travel_theme.dart";

part "travel_ticket_book.dart";

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
// 行程空间：分段式状态切换（进行中 | 即将出发 | 往期），卡片左缘状态
// 色条（青=进行中 / 橙=即将出发 / 灰=往期），点开直达完整行程界面。
//
// 协议：POST /travel/plan-session（发起）→ :id/turn（消息/点选）→
// :id/generate（真实生成，10~120s）→ :id/approve（确认预算后出方案）。
// 配色全部走 AppPalette + TravelPalette（随主题深/暖变体热切换）。
// ═══════════════════════════════════════════════════════════════════

/// 左侧竖向 tab 的宽度。
const double _kTabRailWidth = 64;

/// 对话内容最大宽度（规划页单栏阅读宽度，比主对话更聚焦）。
const double _kContentMaxWidth = 720;

/// 阶段卡宽度：铺满 720 内容列并留出呼吸边（窄窗时随列收缩）。
const double _kCardWidth = 660;

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

  /// 「Day x / y」进度徽章文案（有进度记录时）。
  String get progressLabel {
    final ({int day, int stop})? p = progress;
    if (p == null || dayCount <= 0) return "";
    final int dayNo = (p.day + 1).clamp(1, dayCount);
    return "Day $dayNo/$dayCount";
  }

  /// 花费徽章（无记录不显示）。
  String? get costLabel {
    final double? c = totalCost;
    if (c == null || c <= 0) return null;
    if (c >= 10000) return "¥${(c / 10000).toStringAsFixed(1)}w";
    return "¥${c.round()}";
  }

  /// 进行中进度条比例（0~1；无进度为 null）。
  double? get progressFraction {
    final ({int day, int stop})? p = progress;
    if (p == null || dayCount <= 0) return null;
    return ((p.day + 1) / dayCount).clamp(0.0, 1.0);
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

  /// 行程空间当前分段：0 进行中 / 1 即将出发 / 2 往期（往期默认不出现）。
  int _seg = 0;

  /// 完整行程缓存（打开详情共用，避免重复拉取）。
  final Map<String, TravelPlanData> _planCache = <String, TravelPlanData>{};

  /// 服务端原始行程 JSON 缓存（独立窗口透传用，不经 Dart 模型往返）。
  final Map<String, Map<String, dynamic>> _rawPlanCache =
      <String, Map<String, dynamic>>{};

  /// 详情加载态（按 planId 记录）。
  final Set<String> _loadingPlans = <String>{};

  static const Duration _timeout = Duration(seconds: 6);

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
  Future<TravelPlanData?> _ensureFullPlan(String planId) async {
    final TravelPlanData? cached = _planCache[planId];
    if (cached != null) return cached;
    if (_loadingPlans.contains(planId)) return null;
    if (mounted) setState(() => _loadingPlans.add(planId));
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
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text("行程详情加载失败：$e", style: const TextStyle(fontSize: 12)),
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 2),
          ),
        );
      }
      return null;
    } finally {
      if (mounted) setState(() => _loadingPlans.remove(planId));
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
        body: Row(
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
                      seedMessage: widget.seedMessage,
                      agentName: widget.agentName,
                      onPlanGenerated: _refresh,
                      onOpenPlan: (String planId) async {
                        final TravelPlanData? plan = await _ensureFullPlan(planId);
                        if (plan != null) await _openDetail(plan);
                      },
                    )
                  : _ArchivePane(
                      future: _future,
                      seg: _seg,
                      onSegChanged: (int v) => setState(() => _seg = v),
                      onOpen: _openFromSummary,
                      onShare: _copyShareCode,
                      onDelete: _deletePlan,
                      onRetry: _refresh,
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

class _TabButton extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final Color fg = active ? colors.accent : colors.muted;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 50,
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: BoxDecoration(
          color: active ? colors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(13),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 19, color: fg),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 10,
                fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                color: fg,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 行程空间：分段式状态切换 + 状态色条卡片
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
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
    required this.onRetry,
  });

  final Future<List<_PlanSummary>> future;
  final int seg;
  final ValueChanged<int> onSegChanged;
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
          final int ongoingCount =
              plans.where((_PlanSummary s) => s.bucket == 0).length;
          final int upcomingCount =
              plans.where((_PlanSummary s) => s.bucket == 1).length;
          final int pastCount =
              plans.where((_PlanSummary s) => s.bucket == 2).length;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
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
                    const Spacer(),
                    if (_lastTripLabel(plans).isNotEmpty)
                      Text(
                        _lastTripLabel(plans),
                        style: _monoStyle(7.5, c.muted, spacing: 1.5),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: _RailSegs(
                    colors: c,
                    seg: seg,
                    counts: <int>[ongoingCount, upcomingCount, pastCount],
                    onChanged: onSegChanged,
                  ),
                ),
              ),
              const SizedBox(height: 6),
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

/// 分段式状态切换（进行中 | 即将出发 | 往期）。
class _RailSegs extends StatelessWidget {
  const _RailSegs({
    required this.colors,
    required this.seg,
    required this.counts,
    required this.onChanged,
  });

  final _StageColors colors;
  final int seg;
  final List<int> counts;
  final ValueChanged<int> onChanged;

  static const List<String> _labels = <String>["进行中", "即将出发", "往期"];

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 14),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.card2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.borderSoft),
      ),
      child: Row(
        children: <Widget>[
          for (int i = 0; i < 3; i++)
            Expanded(
              child: GestureDetector(
                onTap: () => onChanged(i),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  decoration: BoxDecoration(
                    color: seg == i ? colors.card : Colors.transparent,
                    borderRadius: BorderRadius.circular(9),
                    boxShadow: seg == i
                        ? <BoxShadow>[BoxShadow(color: colors.shadow, blurRadius: 8, offset: const Offset(0, 2))]
                        : null,
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      Container(
                        width: 5,
                        height: 5,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: i == 0
                              ? colors.accent
                              : i == 1
                                  ? colors.orange
                                  : colors.muted,
                        ),
                      ),
                      const SizedBox(width: 5),
                      Text(
                        _labels[i],
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: seg == i ? colors.text : colors.muted,
                        ),
                      ),
                      const SizedBox(width: 3),
                      Text(
                        "${counts[i]}",
                        style: TextStyle(
                          fontSize: 9.5,
                          color: seg == i ? colors.text2 : colors.muted,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
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

/// 筛选卡条目（必玩/住宿/美食候选）：文字介绍 + 实拍图 + 实时价。
class _GuideItemData {
  _GuideItemData({
    required this.name,
    required this.rec,
    required this.rating,
    required this.intro,
    required this.photos,
    required this.price,
    required this.priceNote,
    required this.pricePending,
    required this.address,
    required this.picked,
  });

  factory _GuideItemData.fromJson(Map<String, dynamic> json) {
    return _GuideItemData(
      name: json["name"]?.toString() ?? "",
      rec: (json["rec"] as num?)?.toInt() ?? 0,
      rating: (json["rating"] as num?)?.toDouble() ?? 0,
      intro: json["intro"]?.toString() ?? "",
      photos: <String>[
        for (final dynamic p in (json["photos"] as List<dynamic>? ?? const <dynamic>[]))
          if (p != null && p.toString().isNotEmpty) p.toString(),
      ],
      price: (json["price"] as num?)?.toDouble(),
      priceNote: json["priceNote"]?.toString() ?? "",
      pricePending: json["pricePending"] == true,
      address: json["address"]?.toString() ?? "",
      picked: json["picked"] == true,
    );
  }

  final String name;
  final int rec;
  final double rating;
  final String intro;
  final List<String> photos;
  final double? price;
  final String priceNote;
  final bool pricePending;
  final String address;

  /// 勾选状态（服务端默认预选必玩 Top3）。
  bool picked;
}

class _GuideCatData {
  _GuideCatData({required this.key, required this.label, required this.items});

  factory _GuideCatData.fromJson(Map<String, dynamic> json) {
    return _GuideCatData(
      key: json["key"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      items: <_GuideItemData>[
        for (final dynamic i in (json["items"] as List<dynamic>? ?? const <dynamic>[]))
          if (i is Map<String, dynamic>) _GuideItemData.fromJson(i),
      ],
    );
  }

  final String key;
  final String label;
  final List<_GuideItemData> items;
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

/// 对话流条目。
enum _FlowKind {
  user,
  say,
  weather,
  choice,
  guide,
  wishlist,
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
  final _BudgetData? budget;
  final _DraftData? draft;
}

/// 服务端一轮回执。
class _TurnResult {
  const _TurnResult({
    required this.state,
    required this.say,
    required this.cards,
    required this.budget,
    required this.draft,
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
              _WishlistCardData.fromJson(c),
      ],
      budget: json["budget"] is Map<String, dynamic>
          ? _BudgetData.fromJson(json["budget"] as Map<String, dynamic>)
          : null,
      draft: json["draft"] is Map<String, dynamic>
          ? _DraftData.fromJson(json["draft"] as Map<String, dynamic>)
          : null,
    );
  }

  final String state;
  final String say;
  final List<Object> cards;
  final _BudgetData? budget;
  final _DraftData? draft;
}

/// 规划主区（宽窗右栏 / 窄窗默认页）。
class _PlanningStage extends StatefulWidget {
  const _PlanningStage({
    required this.onPlanGenerated,
    required this.onOpenPlan,
    this.seedMessage,
    this.agentName,
  });

  /// 真实生成成功后回调（宿主刷新左栏列表）。
  final VoidCallback onPlanGenerated;

  /// 「生成完整行程」：按 planId 打开完整行程界面。
  final Future<void> Function(String planId) onOpenPlan;

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

  /// 出票时刻（预算确认 → 播打印出票动画；null=未播放）。
  _TicketPrintMoment? _ticketMoment;

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
    _removeTyping();
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
    _flow.removeWhere(
      (_FlowItem f) =>
          f.kind == _FlowKind.choice ||
          f.kind == _FlowKind.guide ||
          f.kind == _FlowKind.wishlist ||
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

  Future<void> _generate() async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    setState(() => _busy = true);
    _append(_FlowItem.typing());
    try {
      final Map<String, dynamic>? decoded =
          await _post("/travel/plan-session/$id/generate", <String, dynamic>{}, _generateTimeout);
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _removeTyping();
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

  /// 草案 → 打开完整行程界面。
  Future<void> _openDraft(_DraftData draft) async {
    if (draft.planId.isEmpty) return;
    await widget.onOpenPlan(draft.planId);
  }

  // ── UI ────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    return Stack(
      children: <Widget>[
        Column(
          children: <Widget>[
        // 顶栏（返回 + 标题；无主题切换按钮：颜色跟随应用主题）
        Container(
          height: 46,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: c.borderSoft)),
          ),
          child: Row(
            children: <Widget>[
              _BackButton(colors: c),
              const SizedBox(width: 10),
              Text("行程规划",
                  style: TextStyle(
                      fontSize: 12.5, fontWeight: FontWeight.w700, color: c.text2)),
            ],
          ),
        ),
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
              placeholder: _flowStarted
                  ? "随时补充或调整，比如：第二天想去都江堰"
                  : "想去哪儿玩？比如：成都吃三天",
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
          child: Text(
            item.text,
            style: TextStyle(
              fontSize: 13.5,
              height: 1.65,
              color: isError ? c.orange : c.text2,
            ),
          ),
        );
      case _FlowKind.typing:
        return _AgentBlock(name: _agentLabel, colors: c, child: _TypingDots(colors: c));
      case _FlowKind.weather:
        final _WeatherCardData card = item.weather!;
        return _StageCardShell(
          colors: c,
          icon: Icons.wb_sunny_outlined,
          stage: card.title.isEmpty ? "目的地天气" : card.title,
          trailing: card.sub.isEmpty
              ? null
              : Text(card.sub, style: TextStyle(fontSize: 10.5, color: c.muted)),
          child: _WeatherPanel(card: card, colors: c),
        );
      case _FlowKind.choice:
        final _ChoiceCardData card = item.choice!;
        final _CardProgress? progress = card.progress;
        return _StageCardShell(
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
        );
      case _FlowKind.guide:
        final _GuideCardData card = item.guide!;
        return _StageCardShell(
          colors: c,
          icon: Icons.explore_outlined,
          stage: card.stage.isEmpty ? "挑一挑" : card.stage,
          trailing: _StageTrailing(text: "图文 · 实时价", colors: c),
          lead: card.title.isEmpty ? "这三天想给${card.destination}留哪些地方？" : card.title,
          desc: "勾掉不想要的；想去的没在列表里，下一步可以自己补。",
          child: _GuideSelectCard(
            card: card,
            colors: c,
            enabled: !_busy,
            onConfirm: () => _submitGuide(item, card),
            onDelegate: () => _submitGuide(item, card, delegate: true),
          ),
        );
      case _FlowKind.wishlist:
        final _WishlistCardData card = item.wishlist!;
        return _StageCardShell(
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
        );
      case _FlowKind.budget:
        return _StageCardShell(
          colors: c,
          icon: Icons.receipt_long_outlined,
          stage: "预算确认",
          trailing: _StageTrailing(
            text: switch (item.budget!.pricingMode) {
              "real-api" => "实时报价",
              "real-database" => "市场数据库",
              _ => "参考价",
            },
            colors: c,
            tone: _StageTone.green,
          ),
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
        );
      case _FlowKind.draft:
        return Align(
          alignment: Alignment.centerLeft,
          child: _DraftCard(
            draft: item.draft!,
            colors: c,
            enabled: !_busy,
            onGenerate: () => _openDraft(item.draft!),
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
        margin: const EdgeInsets.only(bottom: 16),
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

enum _StageTone { accent, green }

/// 卡片头部右侧的小徽标（进度 / 报价口径）。
class _StageTrailing extends StatelessWidget {
  const _StageTrailing({
    required this.text,
    required this.colors,
    this.tone = _StageTone.accent,
  });

  final String text;
  final _StageColors colors;
  final _StageTone tone;

  @override
  Widget build(BuildContext context) {
    final Color fg = tone == _StageTone.green ? colors.green : colors.accent;
    final Color bg =
        tone == _StageTone.green ? colors.greenSoft : colors.accentSoft;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Text(text,
          style: TextStyle(
              fontSize: 10.5, fontWeight: FontWeight.w600, color: fg)),
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

/// 规划前筛选卡：必玩/住宿/美食三分类，图文 + 实时价 + 勾选。
/// 数据来自服务端真实 POI 与实时报价；价格缺失显示「待核价」。
class _GuideSelectCard extends StatefulWidget {
  const _GuideSelectCard({
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onConfirm,
    required this.onDelegate,
  });

  final _GuideCardData card;
  final _StageColors colors;
  final bool enabled;
  final VoidCallback onConfirm;
  final VoidCallback onDelegate;

  @override
  State<_GuideSelectCard> createState() => _GuideSelectCardState();
}

class _GuideSelectCardState extends State<_GuideSelectCard> {
  late String _filter;

  @override
  void initState() {
    super.initState();
    _filter = widget.card.cats.isNotEmpty ? widget.card.cats.first.key : "view";
  }

  List<_GuideItemData> get _visible {
    for (final _GuideCatData c in widget.card.cats) {
      if (c.key == _filter) return c.items;
    }
    return const <_GuideItemData>[];
  }

  int get _pickedCount {
    int n = 0;
    for (final _GuideCatData c in widget.card.cats) {
      for (final _GuideItemData i in c.items) {
        if (i.picked) n++;
      }
    }
    return n;
  }

  /// 已勾选里还没取到实时价的条目数（只在底栏提示，不吓人）。
  int get _pendingSelected {
    int n = 0;
    for (final _GuideCatData c in widget.card.cats) {
      for (final _GuideItemData i in c.items) {
        if (i.picked && (i.pricePending || i.price == null)) n++;
      }
    }
    return n;
  }

  String _money(double value) => value
      .round()
      .toString()
      .replaceAllMapped(RegExp(r"\B(?=(\d{3})+(?!\d))"), (Match _) => ",");

  String _priceText(_GuideItemData item, String catKey) {
    if (item.pricePending || item.price == null) return "待核价";
    if (item.price == 0) return "免费";
    final String base = "¥${_money(item.price!)}";
    if (catKey == "food") return "$base/人";
    if (catKey == "stay") return "$base/晚";
    return base;
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = widget.colors;
    final List<_GuideCatData> cats = widget.card.cats;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (cats.isNotEmpty) ...<Widget>[
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: <Widget>[
                for (final _GuideCatData cat in cats)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: GestureDetector(
                      onTap: widget.enabled
                          ? () => setState(() => _filter = cat.key)
                          : null,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 5),
                        decoration: BoxDecoration(
                          color: _filter == cat.key
                              ? c.accentSoft
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: _filter == cat.key
                                ? c.accentBorder
                                : c.borderSoft,
                          ),
                        ),
                        child: Text(
                          "${cat.label} ${cat.items.length}",
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: _filter == cat.key
                                ? FontWeight.w700
                                : FontWeight.w400,
                            color: _filter == cat.key ? c.accent : c.text2,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        for (int i = 0; i < _visible.length; i += 2)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(child: _tile(c, _visible[i], _filter)),
                const SizedBox(width: 10),
                Expanded(
                  child: i + 1 < _visible.length
                      ? _tile(c, _visible[i + 1], _filter)
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                _pendingSelected > 0
                    ? "已选 $_pickedCount 处 · $_pendingSelected 项待核价"
                    : "已选 $_pickedCount 处",
                style: TextStyle(fontSize: 11, color: c.muted),
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
              label: "就按这些排行程",
              colors: c,
              enabled: widget.enabled && _pickedCount > 0,
              onTap: widget.onConfirm,
            ),
          ],
        ),
      ],
    );
  }

  Widget _tile(_StageColors c, _GuideItemData entry, String catKey) {
    final bool picked = entry.picked;
    return GestureDetector(
      onTap: widget.enabled
          ? () => setState(() => entry.picked = !entry.picked)
          : null,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: picked ? c.accent.withValues(alpha: 0.05) : c.card2,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: picked ? c.accentBorder : c.borderSoft,
            width: picked ? 1.4 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            SizedBox(
              height: 76,
              width: double.infinity,
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  if (entry.photos.isEmpty)
                    _photoFallback(c, entry.name)
                  else
                    CachedMediaImage(
                      url: LinkUtils.resolveMediaUrl(entry.photos.first),
                      fit: BoxFit.cover,
                      errorBuilder:
                          (BuildContext _, Object __, StackTrace? ___) =>
                              _photoFallback(c, entry.name),
                    ),
                  Positioned(
                    right: 7,
                    top: 7,
                    child: Container(
                      width: 18,
                      height: 18,
                      decoration: BoxDecoration(
                        color: picked
                            ? c.accent
                            : Colors.black.withValues(alpha: 0.38),
                        shape: BoxShape.circle,
                        border: picked
                            ? null
                            : Border.all(
                                color: Colors.white.withValues(alpha: 0.45)),
                      ),
                      child: picked
                          ? Icon(Icons.check_rounded,
                              size: 12, color: c.onAccent)
                          : null,
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(9, 8, 9, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          entry.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: c.text,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        _priceText(entry, catKey),
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: entry.pricePending || entry.price == null
                              ? c.muted
                              : (entry.price == 0 ? c.green : c.orange),
                        ),
                      ),
                    ],
                  ),
                  if (entry.intro.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        entry.intro,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 10.5, height: 1.45, color: c.text2),
                      ),
                    ),
                  if (entry.rec > 0 ||
                      (entry.priceNote.isNotEmpty && !entry.pricePending))
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Row(
                        children: <Widget>[
                          if (entry.rec > 0)
                            Text("推荐 ${entry.rec}%",
                                style: TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w600,
                                    color: c.green)),
                          if (entry.rec > 0 &&
                              entry.priceNote.isNotEmpty &&
                              !entry.pricePending)
                            const SizedBox(width: 8),
                          if (entry.priceNote.isNotEmpty && !entry.pricePending)
                            Flexible(
                              child: Text(
                                entry.priceNote,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style:
                                    TextStyle(fontSize: 9.5, color: c.muted),
                              ),
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
    );
  }

  /// 无实拍图时的兜底：地名首字色块（不能塌成一行纯文字）。
  Widget _photoFallback(_StageColors c, String name) {
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
      margin: const EdgeInsets.only(bottom: 16),
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
                Row(
                  children: <Widget>[
                    if (draft.totalCost != null && draft.totalCost! > 0)
                      _MetaChip(
                        colors: c,
                        icon: Icons.payments_outlined,
                        text: "¥${draft.totalCost!.round()}",
                      ),
                    if (draft.totalCost != null && draft.totalCost! > 0)
                      const SizedBox(width: 6),
                    _MetaChip(
                      colors: c,
                      icon: Icons.auto_awesome_outlined,
                      text: "真实数据生成",
                    ),
                  ],
                ),
                const SizedBox(height: 9),
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
                const SizedBox(height: 8),
                Text(
                    draft.days.isEmpty
                        ? "逐日安排、门票和报价都在完整行程里"
                        : "下面是照着能走的整体安排；点开完整行程可编辑、看地图",
                    style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                if (draft.days.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 10),
                  _DraftPlanSection(draft: draft, colors: c),
                ],
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
          const Icon(Icons.map_outlined, size: 13, color: Color(0xFF18D6F3)),
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
          : const Color(0x1F18D6F3),
      accentBorder: warm ? const Color(0xFF9DC3E8) : const Color(0x7318D6F3),
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
const double _kTicketExtent = 258;

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
      constraints: const BoxConstraints(minHeight: 220),
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
                        padding: const EdgeInsets.fromLTRB(24, 16, 18, 16),
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
                            const SizedBox(height: 16),
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
                            const SizedBox(height: 14),
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
                    const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                decoration: BoxDecoration(
                  color: c.accentBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: <Widget>[
                    Icon(Icons.map_outlined, size: 14, color: c.onAccent),
                    const SizedBox(width: 7),
                    Text("查看完整行程",
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: c.onAccent)),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 10),
            GestureDetector(
              onTap: widget.onClose,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: c.border),
                ),
                child: Text("稍后再看",
                    style: TextStyle(
                        fontSize: 12.5,
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
