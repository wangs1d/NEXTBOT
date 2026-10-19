import "dart:async" show unawaited;
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show Clipboard, ClipboardData;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "media_disk_cache.dart";
import "travel_plan_mobile_page.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";
import "travel_plan_window.dart";
import "travel_theme.dart";

// ═══════════════════════════════════════════════════════════════════
// 旅游界面 v3（应用内「常用工具 → 行程」入口）· Agent 驱动规划 + 左栏行程
//
// 主区 = 规划入口：初始只有垂直居中的罗盘图标 + 输入框（无任何引导文案），
// 一句话发起后输入框落到底部继续对话；缺的信息由 Agent 在规划过程中按需
// 吐卡片（天气面板 / 出行方式 / 住房 / 吃的）让用户点选，信息齐了自动
// 真实生成草案（服务端复用 PlanningService 主链路 + travelPlanStore 落盘），
// 点「生成完整行程」直达完整行程界面（详情由旅游规划界面承载）。
//
// 左栏 = 行程收纳：分段式状态切换（进行中 | 即将出发 | 往期，往期默认不
// 出现），卡片左缘状态色条（青=进行中 / 橙=即将出发 / 灰=往期），往期封面
// 置灰；卡片只做收纳与状态，点开直达完整行程界面。
//
// 协议：POST /travel/plan-session（发起）→ :id/turn（消息/点选）→
// :id/generate（真实生成，10~120s）。配色全部走 AppPalette + TravelPalette
// （随主题深/暖变体热切换，窗口内无切换按钮）。
// ═══════════════════════════════════════════════════════════════════

/// 双栏布局断点：可用宽度达到该值才展开左栏 + 主区双栏。
const double _kDualPaneBreakpoint = 900;

/// 左栏固定宽度。
const double _kLeftPaneWidth = 300;

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

class TravelPlanArchivePage extends StatefulWidget {
  const TravelPlanArchivePage({super.key});

  /// 全屏路由打开（与图库工作台同款打开方式）。
  static Future<void> show(BuildContext context) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => const TravelPlanArchivePage(),
      ),
    );
  }

  @override
  State<TravelPlanArchivePage> createState() => _TravelPlanArchivePageState();
}

class _TravelPlanArchivePageState extends State<TravelPlanArchivePage> {
  late Future<List<_PlanSummary>> _future = _fetchSummaries();
  bool _opening = false;

  /// 左栏当前分段：0 进行中 / 1 即将出发 / 2 往期（往期默认不出现）。
  int _seg = 0;

  /// 窄窗顶部切换：0 规划 / 1 行程。
  int _narrowTab = 0;

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
    try {
      final http.Response resp = await http
          .delete(Uri.parse("${ApiConfig.httpBase}/travel/plans/${summary.planId}"))
          .timeout(_timeout);
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
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
        content: Text("已删除「${summary.displayTitle}」",
            style: const TextStyle(fontSize: 12)),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  /// 刷新左栏列表（规划生成新行程后由规划流回调）。
  void _refresh() {
    if (!mounted) return;
    setState(() => _future = _fetchSummaries());
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    return Scaffold(
      backgroundColor: c.bg,
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final bool dual = constraints.maxWidth >= _kDualPaneBreakpoint;
          if (dual) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _LeftRail(
                  state: this,
                  future: _future,
                  seg: _seg,
                  onSegChanged: (int v) => setState(() => _seg = v),
                  onOpen: _openFromSummary,
                  onShare: _copyShareCode,
                  onDelete: _deletePlan,
                  onRetry: _refresh,
                ),
                VerticalDivider(width: 1, thickness: 1, color: c.sideSep),
                Expanded(child: _PlanningStage(
                  onPlanGenerated: _refresh,
                  onOpenPlan: (String planId) async {
                    final TravelPlanData? plan = await _ensureFullPlan(planId);
                    if (plan != null) await _openDetail(plan);
                  },
                )),
              ],
            );
          }
          // 窄窗（手机 / 分屏）：顶部双页签切换 规划 / 行程。
          return Column(
            children: <Widget>[
              Container(
                height: 46,
                decoration: BoxDecoration(
                  color: c.side,
                  border: Border(bottom: BorderSide(color: c.sideSep)),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                child: Row(
                  children: <Widget>[
                    _BackButton(colors: c),
                    const SizedBox(width: 12),
                    _NarrowToggle(
                      colors: c,
                      index: _narrowTab,
                      onChanged: (int v) => setState(() => _narrowTab = v),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: _narrowTab == 0
                    ? _PlanningStage(
                        onPlanGenerated: _refresh,
                        onOpenPlan: (String planId) async {
                          final TravelPlanData? plan = await _ensureFullPlan(planId);
                          if (plan != null) await _openDetail(plan);
                        },
                      )
                    : _LeftRail(
                        state: this,
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
          );
        },
      ),
    );
  }
}

/// 窄窗顶部页签（规划 / 行程）。
class _NarrowToggle extends StatelessWidget {
  const _NarrowToggle({
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
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.card2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.borderSoft),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final (int i, String label) in const <(int, String)>[(0, "规划"), (1, "行程")])
            GestureDetector(
              onTap: () => onChanged(i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 5),
                decoration: BoxDecoration(
                  color: index == i ? colors.card : Colors.transparent,
                  borderRadius: BorderRadius.circular(9),
                  boxShadow: index == i
                      ? <BoxShadow>[BoxShadow(color: colors.shadow, blurRadius: 8, offset: const Offset(0, 2))]
                      : null,
                ),
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: index == i ? colors.text : colors.muted,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 左栏：行程收纳（分段式状态切换 + 状态色条卡片）
// ═══════════════════════════════════════════════════════════════════

/// 返回按钮（退出行程页回到上一界面；双栏=规划区顶栏，窄窗=顶部页签栏）。
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

class _LeftRail extends StatelessWidget {
  const _LeftRail({
    required this.state,
    required this.future,
    required this.seg,
    required this.onSegChanged,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
    required this.onRetry,
  });

  final _TravelPlanArchivePageState state;
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
      width: _kLeftPaneWidth,
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
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 20, 18, 0),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: <Widget>[
                    Text("行程",
                        style: TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w800,
                            color: c.text)),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              _RailSegs(
                colors: c,
                seg: seg,
                counts: <int>[ongoingCount, upcomingCount, pastCount],
                onChanged: onSegChanged,
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

/// 当前分段的行程卡列表。
class _RailList extends StatelessWidget {
  const _RailList({
    required this.colors,
    required this.plans,
    required this.seg,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
  });

  final _StageColors colors;
  final List<_PlanSummary> plans;
  final int seg;
  final ValueChanged<_PlanSummary> onOpen;
  final ValueChanged<_PlanSummary> onShare;
  final ValueChanged<_PlanSummary> onDelete;

  static const List<String> _emptyHints = <String>[
    "暂无进行中的行程\n规划一个，出发后它会出现在这里",
    "暂无即将出发的行程\n确定日期后行程会提前出现在这里",
    "还没有往期行程\n走完的旅行会自动归档到这里",
  ];

  @override
  Widget build(BuildContext context) {
    final List<_PlanSummary> items = <_PlanSummary>[
      for (final _PlanSummary s in plans)
        if (s.bucket == seg) s,
    ];
    if (items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Text(
            _emptyHints[seg],
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, height: 1.8, color: colors.muted),
          ),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
      itemCount: items.length,
      itemBuilder: (BuildContext context, int index) => _TripCard(
        colors: colors,
        summary: items[index],
        onOpen: () => onOpen(items[index]),
        onShare: () => onShare(items[index]),
        onDelete: () => onDelete(items[index]),
      ),
    );
  }
}

/// 行程卡：左缘状态色条 + 封面（往期置灰）+ 状态徽章。
class _TripCard extends StatelessWidget {
  const _TripCard({
    required this.colors,
    required this.summary,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
  });

  final _StageColors colors;
  final _PlanSummary summary;
  final VoidCallback onOpen;
  final VoidCallback onShare;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final bool past = summary.bucket == 2;
    final Color barColor = summary.bucket == 0
        ? colors.accent
        : summary.bucket == 1
            ? colors.orange
            : colors.muted;
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Material(
        color: colors.card,
        borderRadius: BorderRadius.circular(13),
        child: InkWell(
          onTap: onOpen,
          borderRadius: BorderRadius.circular(13),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(13),
              border: Border.all(color: colors.borderSoft),
            ),
            padding: const EdgeInsets.fromLTRB(14, 9, 9, 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                // 左缘状态色条
                Container(
                  width: 3,
                  height: 56,
                  margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(
                    color: barColor.withValues(alpha: past ? 0.35 : 1),
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
                // 封面（正常色彩；往期状态由左缘色条区分）
                ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: SizedBox(
                    width: 60,
                    height: 60,
                    child: summary.coverImage.isNotEmpty
                        ? CachedMediaImage(
                            url: resolveTravelMediaUrl(summary.coverImage),
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) =>
                                _CoverFallback(colors: colors, label: summary.destination),
                          )
                        : _CoverFallback(colors: colors, label: summary.destination),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              summary.displayTitle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w700,
                                  color: colors.text),
                            ),
                          ),
                          _CardMenu(
                            colors: colors,
                            onShare: onShare,
                            onDelete: onDelete,
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        <String>[
                          if (summary.destination.isNotEmpty) summary.destination,
                          if (summary.bucket == 2 && summary.endDate.isNotEmpty)
                            "${summary.endDate.substring(5)} 结束"
                          else if (summary.dateRangeLabel.isNotEmpty)
                            summary.dateRangeLabel,
                        ].join(" · "),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 10.5, color: colors.muted),
                      ),
                      const SizedBox(height: 5),
                      Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        children: <Widget>[
                          if (summary.bucket == 0 && summary.progressLabel.isNotEmpty)
                            _MetaTag(colors: colors, text: summary.progressLabel, accent: true)
                          else if (summary.bucket == 1 && summary.countdownLabel.isNotEmpty)
                            _MetaTag(colors: colors, text: summary.countdownLabel, orange: true),
                          if (summary.dayCount > 0)
                            _MetaTag(colors: colors, text: "${summary.dayCount} 天"),
                          if (summary.costLabel != null)
                            _MetaTag(colors: colors, text: summary.costLabel!),
                          if (past) _MetaTag(colors: colors, text: "已归档", green: true),
                        ],
                      ),
                      if (summary.bucket == 0 && summary.progressFraction != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 7),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(2),
                            child: SizedBox(
                              height: 3,
                              child: LinearProgressIndicator(
                                value: summary.progressFraction,
                                minHeight: 3,
                                backgroundColor: colors.borderSoft,
                                valueColor:
                                    AlwaysStoppedAnimation<Color>(colors.accent),
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
        ),
      ),
    );
  }
}

/// 卡片右上角更多菜单（分享码 / 删除）。
class _CardMenu extends StatelessWidget {
  const _CardMenu({required this.colors, required this.onShare, required this.onDelete});

  final _StageColors colors;
  final VoidCallback onShare;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 24,
      height: 24,
      child: PopupMenuButton<String>(
        tooltip: "更多操作",
        padding: EdgeInsets.zero,
        iconSize: 15,
        color: colors.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: colors.borderSoft),
        ),
        icon: Icon(Icons.more_horiz, size: 15, color: colors.muted),
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

class _MetaTag extends StatelessWidget {
  const _MetaTag({
    required this.colors,
    required this.text,
    this.accent = false,
    this.orange = false,
    this.green = false,
  });

  final _StageColors colors;
  final String text;
  final bool accent;
  final bool orange;
  final bool green;

  @override
  Widget build(BuildContext context) {
    final Color bg = accent
        ? colors.accentSoft
        : orange
            ? colors.orangeSoft
            : green
                ? colors.greenSoft
                : colors.card2;
    final Color fg = accent
        ? colors.accent
        : orange
            ? colors.orange
            : green
                ? colors.green
                : colors.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 9, fontWeight: FontWeight.w600, color: fg),
      ),
    );
  }
}

class _CoverFallback extends StatelessWidget {
  const _CoverFallback({required this.colors, required this.label});

  final _StageColors colors;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: colors.card2,
      alignment: Alignment.center,
      child: Text(
        label.isNotEmpty ? label.characters.first : "旅",
        style: TextStyle(
            fontSize: 18, fontWeight: FontWeight.w700, color: colors.muted),
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

/// 服务端卡片载荷：选择卡。
class _ChoiceCardData {
  _ChoiceCardData({
    required this.id,
    required this.title,
    required this.multi,
    required this.options,
    this.prefill = const <String>[],
    this.placeholder,
  });

  factory _ChoiceCardData.fromJson(Map<String, dynamic> json) {
    return _ChoiceCardData(
      id: json["id"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
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
    );
  }

  final String id;
  final String title;
  final bool multi;
  final List<String> options;
  final List<String> prefill;
  final String? placeholder;
}

/// 服务端草案载荷（真实规划结果）。
class _DraftData {
  _DraftData({
    required this.planId,
    required this.title,
    required this.destination,
    required this.days,
    this.totalCost,
  });

  factory _DraftData.fromJson(Map<String, dynamic> json) {
    return _DraftData(
      planId: json["planId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "行程草案",
      destination: json["destination"]?.toString() ?? "",
      totalCost: (json["totalCost"] as num?)?.toDouble(),
      days: <({String label, String stops})>[
        for (final dynamic d in (json["days"] as List<dynamic>? ?? const <dynamic>[]))
          if (d is Map<String, dynamic>)
            (
              label: d["label"]?.toString() ?? "",
              stops: d["stops"]?.toString() ?? "",
            ),
      ],
    );
  }

  final String planId;
  final String title;
  final String destination;
  final double? totalCost;
  final List<({String label, String stops})> days;
}

/// 对话流条目。
enum _FlowKind { user, say, weather, choice, typing, draft, error }

class _FlowItem {
  _FlowItem._(this.kind, {this.text = "", this.weather, this.choice, this.draft});

  factory _FlowItem.user(String text) => _FlowItem._(_FlowKind.user, text: text);
  factory _FlowItem.say(String text) => _FlowItem._(_FlowKind.say, text: text);
  factory _FlowItem.weather(_WeatherCardData data) =>
      _FlowItem._(_FlowKind.weather, weather: data);
  factory _FlowItem.choice(_ChoiceCardData data) =>
      _FlowItem._(_FlowKind.choice, choice: data);
  factory _FlowItem.typing() => _FlowItem._(_FlowKind.typing);
  factory _FlowItem.draft(_DraftData data) =>
      _FlowItem._(_FlowKind.draft, draft: data);
  factory _FlowItem.error(String text) => _FlowItem._(_FlowKind.error, text: text);

  final _FlowKind kind;
  final String text;
  final _WeatherCardData? weather;
  final _ChoiceCardData? choice;
  final _DraftData? draft;

  /// 选择卡是否已作答（作答后锁定不再可点）。
  bool answered = false;
}

/// 服务端一轮回执。
class _TurnResult {
  const _TurnResult({
    required this.state,
    required this.say,
    required this.cards,
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
              _ChoiceCardData.fromJson(c),
      ],
      draft: json["draft"] is Map<String, dynamic>
          ? _DraftData.fromJson(json["draft"] as Map<String, dynamic>)
          : null,
    );
  }

  final String state;
  final String say;
  final List<Object> cards;
  final _DraftData? draft;
}

/// 规划主区（宽窗右栏 / 窄窗默认页）。
class _PlanningStage extends StatefulWidget {
  const _PlanningStage({
    required this.onPlanGenerated,
    required this.onOpenPlan,
  });

  /// 真实生成成功后回调（宿主刷新左栏列表）。
  final VoidCallback onPlanGenerated;

  /// 「生成完整行程」：按 planId 打开完整行程界面。
  final Future<void> Function(String planId) onOpenPlan;

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
      }
    }
    if (r.draft != null) {
      _append(_FlowItem.draft(r.draft!));
      unawaited(Future<void>.delayed(Duration.zero).then((_) => widget.onPlanGenerated()));
    }
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
    setState(() => item.answered = true);
    setState(() => _busy = true);
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
    return Column(
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
        // 对话流（idle 时隐藏）：flow 独占剩余空间
        if (_flowStarted)
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              itemCount: _flow.length,
              itemBuilder: (BuildContext context, int index) =>
                  _buildFlowItem(context, _flow[index], c),
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
        constraints: const BoxConstraints(maxWidth: 620),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 居中罗盘图标（仅 idle，无引导文案）
            if (!_flowStarted) ...<Widget>[
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: c.accentSoft,
                  borderRadius: BorderRadius.circular(15),
                ),
                child: Icon(Icons.explore_outlined, size: 24, color: c.accent),
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
        return _AgentBlock(colors: c, child: _TypingDots(colors: c));
      case _FlowKind.weather:
        return _AgentBlock(
          colors: c,
          child: _WeatherPanel(card: item.weather!, colors: c),
        );
      case _FlowKind.choice:
        return _AgentBlock(
          colors: c,
          child: _ChoiceCard(
            item: item,
            card: item.choice!,
            colors: c,
            enabled: !item.answered && !_busy,
            onConfirm: (List<String> values, String? note) =>
                _sendChoice(item, item.choice!, values, note),
          ),
        );
      case _FlowKind.draft:
        return _AgentBlock(
          colors: c,
          child: _DraftCard(
            draft: item.draft!,
            colors: c,
            enabled: !_busy,
            onGenerate: () => _openDraft(item.draft!),
            onAdjust: () {
              _inputFocus.requestFocus();
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text("在输入框告诉 Agent 改哪里，比如：第二天想去都江堰",
                      style: TextStyle(fontSize: 12)),
                  behavior: SnackBarBehavior.floating,
                  duration: Duration(seconds: 2),
                ),
              );
            },
          ),
        );
    }
  }
}

/// Agent 说话块（名字点 + 内容）。
class _AgentBlock extends StatelessWidget {
  const _AgentBlock({required this.colors, required this.child});

  final _StageColors colors;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 6,
                height: 6,
                decoration:
                    BoxDecoration(shape: BoxShape.circle, color: colors.accent),
              ),
              const SizedBox(width: 6),
              Text("Agent",
                  style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w700,
                      color: colors.muted)),
            ],
          ),
          const SizedBox(height: 7),
          DefaultTextStyle(
            style: const TextStyle(),
            child: child,
          ),
        ],
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
        Row(
          children: <Widget>[
            Text(card.title,
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: colors.text)),
            const Spacer(),
            if (card.sub.isNotEmpty)
              Text(card.sub,
                  style: TextStyle(fontSize: 10.5, color: colors.muted)),
          ],
        ),
        const SizedBox(height: 11),
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

/// 选择卡（出行方式 / 住房 / 吃的）：点选即答。
class _ChoiceCard extends StatefulWidget {
  const _ChoiceCard({
    required this.item,
    required this.card,
    required this.colors,
    required this.enabled,
    required this.onConfirm,
  });

  final _FlowItem item;
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

  bool get _locked => widget.item.answered;

  void _tapChip(String option) {
    if (_locked || !widget.enabled) return;
    if (widget.card.multi) {
      setState(() {
        if (!_selected.remove(option)) _selected.add(option);
      });
      return;
    }
    // 单选：立即回传
    setState(() => _selected
      ..clear()
      ..add(option));
    widget.onConfirm(<String>[option], _note.text);
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
    final bool showConfirm =
        card.multi && !_locked && (_selected.isNotEmpty || _note.text.trim().isNotEmpty);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(card.title,
            style: TextStyle(
                fontSize: 13, fontWeight: FontWeight.w700, color: c.text)),
        if (card.prefill.isNotEmpty && !_locked)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text("记得你偏好过：${card.prefill.join("、")}",
                style: TextStyle(fontSize: 11, color: c.muted)),
          ),
        const SizedBox(height: 11),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: <Widget>[
            for (final String option in card.options)
              GestureDetector(
                onTap: () => _tapChip(option),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: _selected.contains(option) ? c.accentSoft : c.card2,
                    borderRadius: BorderRadius.circular(15),
                    border: _selected.contains(option)
                        ? Border.all(color: c.accentBorder)
                        : Border.all(color: Colors.transparent),
                  ),
                  child: Text(
                    option,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: _locked && !_selected.contains(option)
                          ? c.muted
                          : _selected.contains(option)
                              ? c.accent
                              : c.text2,
                    ),
                  ),
                ),
              ),
          ],
        ),
        if (card.placeholder != null && !_locked) ...<Widget>[
          const SizedBox(height: 9),
          SizedBox(
            width: 220,
            height: 32,
            child: TextField(
              controller: _note,
              style: TextStyle(fontSize: 11.5, color: c.text),
              decoration: InputDecoration(
                isDense: true,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                filled: true,
                fillColor: c.card2,
                hintText: card.placeholder,
                hintStyle: TextStyle(fontSize: 11.5, color: c.muted),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: c.borderSoft),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: c.accent),
                ),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ],
        if (showConfirm) ...<Widget>[
          const SizedBox(height: 11),
          Row(
            children: <Widget>[
              GestureDetector(
                onTap: () =>
                    widget.onConfirm(_selected.toList(growable: false), _note.text),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                  decoration: BoxDecoration(
                    color: c.accentBg,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text("就这些",
                      style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700,
                          color: c.onAccent)),
                ),
              ),
              const SizedBox(width: 8),
              GestureDetector(
                onTap: () {
                  setState(_selected.clear);
                  widget.onConfirm(<String>[], null);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                  decoration: BoxDecoration(
                    border: Border.all(color: c.border),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text("先不选",
                      style: TextStyle(fontSize: 11.5, color: c.text2)),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

/// 草案卡（真实规划结果，Day 行 + 操作按钮）。
class _DraftCard extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text("${draft.title} · 草案",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: colors.text)),
            ),
            Text("按你的偏好生成",
                style: TextStyle(fontSize: 10.5, color: colors.muted)),
          ],
        ),
        const SizedBox(height: 10),
        for (final ({String label, String stops}) day in draft.days)
          Padding(
            padding: const EdgeInsets.only(bottom: 7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 46,
                  child: Text(day.label,
                      style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700,
                          color: colors.accent)),
                ),
                Expanded(
                  child: Text(day.stops,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style:
                          TextStyle(fontSize: 12, height: 1.5, color: colors.text2)),
                ),
              ],
            ),
          ),
        const SizedBox(height: 8),
        Row(
          children: <Widget>[
            Expanded(
              child: GestureDetector(
                onTap: enabled ? onGenerate : null,
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 11),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: enabled ? colors.accentBg : colors.card2,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text("生成完整行程",
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          color: enabled ? colors.onAccent : colors.muted)),
                ),
              ),
            ),
            const SizedBox(width: 9),
            GestureDetector(
              onTap: onAdjust,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
                decoration: BoxDecoration(
                  border: Border.all(color: colors.border),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text("再调整",
                    style: TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600, color: colors.text2)),
              ),
            ),
          ],
        ),
      ],
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
