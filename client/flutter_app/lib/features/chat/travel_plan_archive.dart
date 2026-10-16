import "dart:async" show unawaited;
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show Clipboard, ClipboardData;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "media_disk_cache.dart";
import "travel_ask_launcher.dart";
import "travel_plan_mobile_page.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";
import "travel_theme.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程归档页（应用内「常用工具 → 行程」入口）· 2026-10-16 双栏工作台重设计
//
// 「时间漏斗」三层组织：进行中（迷你英雄卡置顶）→ 即将出发（倒计时卡）
// → 往期回顾（紧凑行收纳）。宽窗（≥900px）左栏列表 + 右栏原地预览
// （封面横幅 / 元信息 / Day×Day 站点摘要 / 操作条），点开才进完整行程；
// 窄窗（手机 / 分屏窄态）退化为单列列表，点击按平台打开详情。
//
// 数据：服务端 GET /travel/plans 摘要（travelPlanStore 落盘
// data/travel-plans/*.json，含 progress / stopCount，最多 20 份）。
// 预览站点摘要点选时单拉 GET /travel/plans/:planId（进程内缓存）。
// 管理动作：分享码（POST share → 剪贴板）、删除（DELETE，二次确认）、
// 「让 Agent 调整」（TravelAskLauncher 回聊天预填）。
// 配色全部走 ColorScheme + TravelPalette（随主题深/暖变体热切换）。
// ═══════════════════════════════════════════════════════════════════

/// 双栏布局断点：可用宽度达到该值才展开右栏预览。
const double _kDualPaneBreakpoint = 900;

/// 左栏固定宽度。
const double _kLeftPaneWidth = 340;

/// 筛选维度（chips 过滤 + 分组渲染共用）。
enum _PlanBucket { all, ongoing, upcoming, past }

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

  /// 创建时间（本地时区 MM-dd 展示；跨年带年份）。
  String get createdLabel {
    if (createdAt <= 0) return "";
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(createdAt);
    String two(int v) => v.toString().padLeft(2, "0");
    final String md = "${two(t.month)}-${two(t.day)}";
    return t.year == DateTime.now().year ? md : "${t.year}-$md";
  }

  /// 日期区间标签（同一天只显示一天）。
  String get dateRangeLabel {
    final String s = startDate.trim();
    final String e = endDate.trim();
    if (s.isEmpty && e.isEmpty) return "";
    if (s == e || e.isEmpty) return s;
    if (s.isEmpty) return e;
    return "$s ~ $e";
  }

  /// 行程状态：未开始 / 进行中 / 已结束（按今天日期与区间比较）
  ({String label, bool active}) status() {
    String two(int v) => v.toString().padLeft(2, "0");
    final DateTime now = DateTime.now();
    final String today =
        "${now.year}-${two(now.month)}-${two(now.day)}";
    if (startDate.isNotEmpty && today.compareTo(startDate) < 0) {
      return (label: "未开始", active: false);
    }
    if (endDate.isNotEmpty && today.compareTo(endDate) > 0) {
      return (label: "已结束", active: false);
    }
    return (label: "进行中", active: true);
  }

  /// 归属分组：进行中 / 即将出发 / 往期回顾。
  _PlanBucket get bucket {
    final ({String label, bool active}) s = status();
    if (s.active) return _PlanBucket.ongoing;
    return s.label == "未开始" ? _PlanBucket.upcoming : _PlanBucket.past;
  }

  /// 距出发天数（未开始且日期可解析时 ≥1，否则 null）。
  int? get daysUntilStart {
    if (bucket != _PlanBucket.upcoming) return null;
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
    return "还有 $d 天";
  }

  /// 「Day x / y」进度徽章文案（有进度记录时）。
  String get progressLabel {
    final ({int day, int stop})? p = progress;
    if (p == null || dayCount <= 0) return "";
    final int dayNo = (p.day + 1).clamp(1, dayCount);
    return "Day $dayNo / $dayCount";
  }
}

class TravelPlanArchivePage extends StatefulWidget {
  const TravelPlanArchivePage({super.key});

  /// 全屏路由打开行程归档页（与图库工作台同款打开方式）。
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

  /// 左栏搜索词（标题 / 目的地本地包含匹配）。
  String _search = "";

  /// 当前筛选 chips 维度。
  _PlanBucket _filter = _PlanBucket.all;

  /// 右栏预览选中的行程（null = 无预览，窄窗始终为 null 语义）。
  String? _selectedId;

  /// 完整行程缓存（预览 / 打开详情共用，避免重复拉取）。
  final Map<String, TravelPlanData> _planCache = <String, TravelPlanData>{};

  /// 预览详情加载态（按 planId 记录，横幅可先用摘要数据渲染）。
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
    // 封面落盘预热：列表一返回就把各封面推进磁盘缓存，
    // 卡片渲染走 CachedMediaImage，二次进入列表封面秒解不闪占位。
    MediaDiskCache.instance.warm(<String>[
      for (final _PlanSummary s in summaries)
        if (s.coverImage.isNotEmpty) resolveTravelMediaUrl(s.coverImage),
    ]);
    // 首次列表到达：宽窗下默认选中第一份（进行中优先，否则列表首条）。
    if (_selectedId == null && summaries.isNotEmpty) {
      final _PlanSummary ongoing = summaries.firstWhere(
        (_PlanSummary s) => s.bucket == _PlanBucket.ongoing,
        orElse: () => summaries.first,
      );
      _selectedId = ongoing.planId;
      unawaited(_ensureFullPlan(_selectedId!));
    }
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
          .timeout(_timeout);
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Object? decoded = jsonDecode(resp.body);
      final Object? rawPlan = decoded is Map ? decoded["plan"] : null;
      if (rawPlan is! Map<String, dynamic>) {
        throw Exception("行程数据缺失");
      }
      final TravelPlanData plan = TravelPlanData.fromPlanJson(rawPlan);
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

  /// 按平台打开完整行程详情（手机原生页 / 桌面 WebView 面板）。
  Future<void> _openDetail(TravelPlanData plan) async {
    if (_opening) return;
    _opening = true;
    try {
      if (!mounted) return;
      if (Platform.isAndroid || Platform.isIOS) {
        unawaited(TravelPlanMobilePage.show(context, plan: plan));
      } else {
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

  /// 删除行程（二次确认 → DELETE → 本地移除并自动选中下一条）。
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
    if (!mounted) return;
    setState(() {
      _planCache.remove(summary.planId);
      if (_selectedId == summary.planId) _selectedId = null;
      _future = _fetchSummaries();
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text("已删除「${summary.displayTitle}」",
            style: const TextStyle(fontSize: 12)),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  // ── 派生数据 ──────────────────────────────────────────────────────

  /// 更新搜索词（_LeftPane 是独立 widget，经此方法改 state 而非直呼 setState）。
  void _setSearch(String value) => setState(() => _search = value);

  /// 更新筛选维度。
  void _setFilter(_PlanBucket bucket) => setState(() => _filter = bucket);

  /// 选中行程（宽窗右栏预览）：切选并异步拉取完整数据。
  void _select(_PlanSummary summary) {
    if (_selectedId == summary.planId) return;
    setState(() => _selectedId = summary.planId);
    unawaited(_ensureFullPlan(summary.planId).then((_) {
      if (mounted) setState(() {});
    }));
  }

  /// 窄窗点击：拉完整行程后按平台打开详情。
  Future<void> _openFromSummary(_PlanSummary summary) async {
    final TravelPlanData? plan = await _ensureFullPlan(summary.planId);
    if (plan == null || !mounted) return;
    await _openDetail(plan);
  }

  /// 搜索 + chips 过滤后的列表。
  List<_PlanSummary> _filtered(List<_PlanSummary> plans) {
    final String q = _search.trim().toLowerCase();
    return <_PlanSummary>[
      for (final _PlanSummary s in plans)
        if (_filter == _PlanBucket.all || s.bucket == _filter)
          if (q.isEmpty ||
              s.title.toLowerCase().contains(q) ||
              s.destination.toLowerCase().contains(q))
            s,
    ];
  }

  /// 分组视图：ongoing → upcoming → past。
  (_PlanSummary?, List<_PlanSummary>, List<_PlanSummary>) _grouped(
      List<_PlanSummary> plans) {
    _PlanSummary? ongoing;
    for (final _PlanSummary s in plans) {
      if (s.bucket == _PlanBucket.ongoing) {
        ongoing = s;
        break;
      }
    }
    final List<_PlanSummary> upcoming = plans
        .where((_PlanSummary s) => s.bucket == _PlanBucket.upcoming)
        .toList(growable: false);
    final List<_PlanSummary> past = plans
        .where((_PlanSummary s) => s.bucket == _PlanBucket.past)
        .toList(growable: false);
    return (ongoing, upcoming, past);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      body: FutureBuilder<List<_PlanSummary>>(
        future: _future,
        builder: (
          BuildContext context,
          AsyncSnapshot<List<_PlanSummary>> snapshot,
        ) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(
              child: SizedBox(
                width: 26,
                height: 26,
                child: CircularProgressIndicator(strokeWidth: 2.4),
              ),
            );
          }
          if (snapshot.hasError) {
            return _ErrorView(
              message: "行程列表加载失败",
              detail: "${snapshot.error}",
              onRetry: () => setState(() => _future = _fetchSummaries()),
            );
          }
          final List<_PlanSummary> plans = _filtered(snapshot.data ?? const <_PlanSummary>[]);
          if (plans.isEmpty) {
            // 搜索/筛选无命中 vs 全空，两种空态。
            if ((snapshot.data ?? const <_PlanSummary>[]).isNotEmpty) {
              return _NoMatchView(
                cs: cs,
                onReset: () => setState(() {
                  _search = "";
                  _filter = _PlanBucket.all;
                }),
              );
            }
            return _EmptyView(cs: cs);
          }
          return LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              final bool dual = constraints.maxWidth >= _kDualPaneBreakpoint;
              if (dual) {
                return _DualPaneBody(
                  state: this,
                  plans: plans,
                  onRefresh: () => setState(() => _future = _fetchSummaries()),
                );
              }
              return _NarrowListBody(
                state: this,
                plans: plans,
                onRefresh: () async {
                  final List<_PlanSummary> fresh = await _fetchSummaries();
                  if (mounted) {
                    setState(() => _future = Future<List<_PlanSummary>>.value(fresh));
                  }
                },
              );
            },
          );
        },
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 宽窗双栏：左列表 + 右预览
// ═══════════════════════════════════════════════════════════════════

class _DualPaneBody extends StatelessWidget {
  const _DualPaneBody({
    required this.state,
    required this.plans,
    required this.onRefresh,
  });

  final _TravelPlanArchivePageState state;
  final List<_PlanSummary> plans;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SizedBox(
          width: _kLeftPaneWidth,
          child: _LeftPane(state: state, plans: plans, onRefresh: onRefresh),
        ),
        VerticalDivider(width: 1, thickness: 1, color: cs.outlineVariant),
        Expanded(
          child: _PreviewPane(state: state, plans: plans),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 左栏（宽窄共用）：头部 + 搜索 + chips + 时间漏斗分组列表
// ═══════════════════════════════════════════════════════════════════

class _LeftPane extends StatelessWidget {
  const _LeftPane({
    required this.state,
    required this.plans,
    required this.onRefresh,
    this.embedded = false,
  });

  final _TravelPlanArchivePageState state;
  final List<_PlanSummary> plans;
  final VoidCallback onRefresh;

  /// 窄窗模式：点击条目直接打开详情（宽窗为选中 → 右栏预览）。
  final bool embedded;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TravelPalette tp = TravelPalette.of(context);
    final (_PlanSummary? ongoing, List<_PlanSummary> upcoming, List<_PlanSummary> past) =
        state._grouped(plans);
    final int destCount =
        plans.map((_PlanSummary s) => s.destination).where((String d) => d.isNotEmpty).toSet().length;

    VoidCallback tapOf(_PlanSummary s) =>
        embedded ? () => state._openFromSummary(s) : () => state._select(s);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // ── 头部：返回 + 标题/统计 + 刷新 ──
        Padding(
          padding: EdgeInsets.fromLTRB(8, embedded ? 6 : 10, 10, 0),
          child: Row(
            children: <Widget>[
              IconButton(
                tooltip: "返回",
                icon: Icon(Icons.arrow_back, size: 20, color: cs.onSurface),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: <InlineSpan>[
                      TextSpan(
                        text: "行程",
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w800,
                          color: cs.onSurface,
                        ),
                      ),
                      if (!embedded) ...<InlineSpan>[
                        const WidgetSpan(child: SizedBox(width: 8)),
                        TextSpan(
                          text: "${plans.length} 次旅行 · $destCount 个目的地",
                          style: TextStyle(
                            fontSize: 11,
                            color: cs.onSurfaceVariant,
                            fontWeight: FontWeight.w400,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              IconButton(
                tooltip: "刷新",
                icon: Icon(Icons.refresh, size: 20, color: cs.onSurfaceVariant),
                onPressed: onRefresh,
              ),
            ],
          ),
        ),
        // ── 搜索 ──
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: TextField(
            onChanged: state._setSearch,
            style: TextStyle(fontSize: 13, color: cs.onSurface),
            decoration: InputDecoration(
              isDense: true,
              hintText: "搜索标题或目的地",
              hintStyle: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
              prefixIcon: Icon(Icons.search, size: 18, color: cs.onSurfaceVariant),
              prefixIconConstraints: const BoxConstraints(minWidth: 36),
              filled: true,
              fillColor: cs.surfaceContainerHigh,
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        // ── 筛选 chips ──
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Wrap(
            spacing: 7,
            runSpacing: 7,
            children: <Widget>[
              _FilterChip(
                cs: cs,
                label: "全部",
                count: plans.length,
                selected: state._filter == _PlanBucket.all,
                onTap: () => state._setFilter(_PlanBucket.all),
              ),
              _FilterChip(
                cs: cs,
                label: "进行中",
                count: plans.where((_PlanSummary s) => s.bucket == _PlanBucket.ongoing).length,
                selected: state._filter == _PlanBucket.ongoing,
                onTap: () => state._setFilter(_PlanBucket.ongoing),
              ),
              _FilterChip(
                cs: cs,
                label: "即将出发",
                count: plans.where((_PlanSummary s) => s.bucket == _PlanBucket.upcoming).length,
                selected: state._filter == _PlanBucket.upcoming,
                onTap: () => state._setFilter(_PlanBucket.upcoming),
              ),
              _FilterChip(
                cs: cs,
                label: "往期回顾",
                count: plans.where((_PlanSummary s) => s.bucket == _PlanBucket.past).length,
                selected: state._filter == _PlanBucket.past,
                onTap: () => state._setFilter(_PlanBucket.past),
              ),
            ],
          ),
        ),
        // ── 分组列表（下拉刷新） ──
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => onRefresh(),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 20),
              children: <Widget>[
                if (ongoing != null) ...<Widget>[
                  _SectionHeader(label: "进行中", accent: tp.accent, trailing: ongoing.progressLabel),
                  const SizedBox(height: 6),
                  _HeroCard(
                    cs: cs,
                    tp: tp,
                    summary: ongoing,
                    selected: !embedded && state._selectedId == ongoing.planId,
                    onTap: () => tapOf(ongoing),
                    onOpen: () => state._openFromSummary(ongoing),
                  ),
                  const SizedBox(height: 4),
                ],
                if (upcoming.isNotEmpty) ...<Widget>[
                  _SectionHeader(label: "即将出发", accent: tp.accent, trailing: "按出发时间"),
                  const SizedBox(height: 6),
                  for (final _PlanSummary s in upcoming) ...<Widget>[
                    _UpcomingCard(
                      cs: cs,
                      tp: tp,
                      summary: s,
                      selected: !embedded && state._selectedId == s.planId,
                      onTap: () => tapOf(s),
                    ),
                    const SizedBox(height: 8),
                  ],
                ],
                if (past.isNotEmpty) ...<Widget>[
                  _SectionHeader(
                    label: "往期回顾",
                    accent: cs.onSurfaceVariant.withValues(alpha: 0.45),
                    trailing: "${past.length} 次",
                  ),
                  const SizedBox(height: 4),
                  _PastGroup(
                    cs: cs,
                    plans: past,
                    selectedId: !embedded ? state._selectedId : null,
                    onTap: (_PlanSummary s) => tapOf(s),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 右栏预览：封面横幅 + 元信息 + Day 站点摘要 + 操作条
// ═══════════════════════════════════════════════════════════════════

class _PreviewPane extends StatelessWidget {
  const _PreviewPane({required this.state, required this.plans});

  final _TravelPlanArchivePageState state;
  final List<_PlanSummary> plans;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    _PlanSummary? found;
    for (final _PlanSummary s in plans) {
      if (s.planId == state._selectedId) {
        found = s;
        break;
      }
    }
    if (found == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.travel_explore, size: 40, color: cs.onSurfaceVariant),
            const SizedBox(height: 10),
            Text(
              "从左侧选择一份行程查看概览",
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
          ],
        ),
      );
    }
    // 提升为非空局部量：下方按钮闭包捕获时保持空安全。
    final _PlanSummary selected = found;

    final TravelPlanData? full = state._planCache[selected.planId];
    final TravelPalette tp = TravelPalette.of(context);
    final ({String label, bool active}) status = selected.status();
    final bool loading = state._loadingPlans.contains(selected.planId);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // ── 封面横幅 ──
        _PreviewBanner(cs: cs, summary: selected, status: status),
        // ── 元信息 chips ──
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 0),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              _MetaChip(
                label: status.label,
                foreground: status.active ? tp.onAccentBg : cs.onSurfaceVariant,
                background: status.active ? tp.accent : cs.surfaceContainerHighest,
              ),
              _MetaChip(label: "${selected.dayCount} 天"),
              _MetaChip(label: "${selected.stopCount} 个站点"),
              if (selected.totalCost != null && selected.totalCost! > 0)
                _MetaChip(label: "预算 ¥${selected.totalCost!.toStringAsFixed(0)}"),
              if (selected.progress != null)
                _MetaChip(
                  label: "已走 ${selected.progressLabel}",
                  foreground: tp.accent,
                  background: tp.accent.withValues(alpha: 0.12),
                ),
              if (selected.createdLabel.isNotEmpty)
                _MetaChip(label: "规划于 ${selected.createdLabel}"),
            ],
          ),
        ),
        // ── 每日安排 ──
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 8),
          child: Text(
            "每日安排",
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w800,
              color: cs.onSurface,
            ),
          ),
        ),
        Expanded(
          child: loading && full == null
              ? Center(
                  child: SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.2,
                      color: tp.accent,
                    ),
                  ),
                )
              : full == null
                  ? Center(
                      child: Text(
                        "站点明细暂不可用",
                        style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
                      ),
                    )
                  : _DaysSummary(
                      cs: cs,
                      tp: tp,
                      plan: full,
                      progress: selected.progress,
                    ),
        ),
        // ── 操作条 ──
        Container(
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow,
            border: Border(top: BorderSide(color: cs.outlineVariant)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          child: Row(
            children: <Widget>[
              FilledButton.icon(
                onPressed: full == null
                    ? null
                    : () => state._openDetail(full),
                style: FilledButton.styleFrom(
                  backgroundColor: tp.accentBg,
                  foregroundColor: tp.onAccentBg,
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                ),
                icon: const Icon(Icons.map_outlined, size: 16),
                label: const Text("打开完整行程",
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: 10),
              _GhostButton(
                cs: cs,
                icon: Icons.link_outlined,
                label: "分享码",
                onTap: () => state._copyShareCode(selected),
              ),
              const SizedBox(width: 8),
              _GhostButton(
                cs: cs,
                icon: Icons.auto_awesome_outlined,
                label: "让 Agent 调整",
                onTap: () => TravelAskLauncher.ask(
                    "帮我调整「${selected.displayTitle}」的行程安排："),
              ),
              const Spacer(),
              TextButton.icon(
                onPressed: () => state._deletePlan(selected),
                style: TextButton.styleFrom(
                  foregroundColor: cs.error,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                ),
                icon: const Icon(Icons.delete_outline, size: 16),
                label: const Text("删除", style: TextStyle(fontSize: 12.5)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 预览封面横幅（摘要数据即可渲染，详情加载不阻塞）。
class _PreviewBanner extends StatelessWidget {
  const _PreviewBanner({
    required this.cs,
    required this.summary,
    required this.status,
  });

  final ColorScheme cs;
  final _PlanSummary summary;
  final ({String label, bool active}) status;

  @override
  Widget build(BuildContext context) {
    final TravelPalette tp = TravelPalette.of(context);
    final String cover = resolveTravelMediaUrl(summary.coverImage);
    final String progressLabel = summary.progressLabel;
    return SizedBox(
      height: 210,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          if (cover.isNotEmpty)
            CachedMediaImage(
              url: cover,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => _BannerFallback(cs: cs, label: summary.destination),
            )
          else
            _BannerFallback(cs: cs, label: summary.destination),
          // 底部压字渐变（恒深色，保证可读性）
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                stops: <double>[0.35, 1.0],
                colors: <Color>[Colors.transparent, Color(0xB3141416)],
              ),
            ),
          ),
          Positioned(
            left: 20,
            top: 14,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5.5),
              decoration: BoxDecoration(
                color: status.active
                    ? Colors.white.withValues(alpha: 0.94)
                    : cs.surfaceContainerHighest.withValues(alpha: 0.94),
                borderRadius: BorderRadius.circular(18),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (status.active) ...<Widget>[
                    _LiveDot(color: tp.accent),
                    const SizedBox(width: 6),
                  ],
                  Text(
                    progressLabel.isEmpty ? status.label : "${status.label} · $progressLabel",
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: status.active ? const Color(0xFF0B4A40) : cs.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            left: 22,
            right: 22,
            bottom: 16,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  summary.displayTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  <String>[
                    if (summary.destination.isNotEmpty) summary.destination,
                    if (summary.dateRangeLabel.isNotEmpty) summary.dateRangeLabel,
                  ].join(" · "),
                  style: TextStyle(
                    fontSize: 12.5,
                    color: Colors.white.withValues(alpha: 0.92),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Day×Day 站点摘要（横向滚动卡片，当天高亮 + 当前站标记）。
class _DaysSummary extends StatelessWidget {
  const _DaysSummary({
    required this.cs,
    required this.tp,
    required this.plan,
    required this.progress,
  });

  final ColorScheme cs;
  final TravelPalette tp;
  final TravelPlanData plan;
  final ({int day, int stop})? progress;

  @override
  Widget build(BuildContext context) {
    String two(int v) => v.toString().padLeft(2, "0");
    final DateTime now = DateTime.now();
    final String today =
        "${now.year}-${two(now.month)}-${two(now.day)}";

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
      children: <Widget>[
        for (int di = 0; di < plan.days.length; di++) ...<Widget>[
          if (di > 0) const SizedBox(height: 10),
          _DayCard(
            cs: cs,
            tp: tp,
            day: plan.days[di],
            dayIndex: di,
            isToday: plan.days[di].date == today,
            isPastDay: progress != null && di < progress!.day,
            progress: progress != null && progress!.day == di ? progress!.stop : null,
          ),
        ],
      ],
    );
  }
}

/// 单日卡片：天头（Day N · 日期 · 状态）+ 站点行（时刻 + 名称）。
class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.cs,
    required this.tp,
    required this.day,
    required this.dayIndex,
    required this.isToday,
    required this.isPastDay,
    required this.progress,
  });

  final ColorScheme cs;
  final TravelPalette tp;
  final TravelPlanDay day;
  final int dayIndex;
  final bool isToday;
  final bool isPastDay;
  final int? progress;

  @override
  Widget build(BuildContext context) {
    final Color border = isToday ? tp.accent : cs.outlineVariant.withValues(alpha: 0.6);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 11, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(
          color: border,
          width: isToday ? 1.6 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                "Day ${dayIndex + 1}",
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w800,
                  color: isToday ? tp.accent : cs.onSurface,
                ),
              ),
              if (day.date.isNotEmpty) ...<Widget>[
                const SizedBox(width: 7),
                Text(
                  day.date,
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                ),
              ],
              const Spacer(),
              Text(
                isToday ? "今天" : (isPastDay ? "已走完" : "待出发"),
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w600,
                  color: isToday ? tp.accent : cs.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: 7),
          if (day.entries.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                "当天暂无安排",
                style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
              ),
            )
          else
            for (int i = 0; i < day.entries.length; i++)
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Row(
                  children: <Widget>[
                    SizedBox(
                      width: 40,
                      child: Text(
                        day.entries[i].time,
                        style: TextStyle(
                          fontSize: 11,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        day.entries[i].title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight:
                              progress == i ? FontWeight.w700 : FontWeight.w500,
                          color: progress == i ? tp.accent : cs.onSurface,
                        ),
                      ),
                    ),
                    if (progress == i)
                      Padding(
                        padding: const EdgeInsets.only(left: 6),
                        child: _LiveDot(color: tp.accent),
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 窄窗单列：沿用分组列表，点击直接打开详情
// ═══════════════════════════════════════════════════════════════════

class _NarrowListBody extends StatelessWidget {
  const _NarrowListBody({
    required this.state,
    required this.plans,
    required this.onRefresh,
  });

  final _TravelPlanArchivePageState state;
  final List<_PlanSummary> plans;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    // 下拉刷新由 _LeftPane 内层 RefreshIndicator 承担。
    return _LeftPane(
      state: state,
      plans: plans,
      onRefresh: () => unawaited(onRefresh()),
      embedded: true,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 列表条目卡（进行中英雄卡 / 即将出发卡 / 往期紧凑行）
// ═══════════════════════════════════════════════════════════════════

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.label,
    required this.accent,
    this.trailing,
  });

  final String label;
  final Color accent;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: Row(
        children: <Widget>[
          Container(
            width: 3.5,
            height: 12,
            decoration: BoxDecoration(
              color: accent,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w800,
              color: cs.onSurface,
            ),
          ),
          const Spacer(),
          if (trailing != null && trailing!.isNotEmpty)
            Text(
              trailing!,
              style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
            ),
        ],
      ),
    );
  }
}

/// 进行中：迷你英雄卡（封面底图 + 呼吸光点徽章 + 压字）。
class _HeroCard extends StatelessWidget {
  const _HeroCard({
    required this.cs,
    required this.tp,
    required this.summary,
    required this.selected,
    required this.onTap,
    this.onOpen,
  });

  final ColorScheme cs;
  final TravelPalette tp;
  final _PlanSummary summary;
  final bool selected;
  final VoidCallback onTap;

  /// 窄窗模式下的「打开」回调（宽窗下 null，右栏有操作条）。
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final String cover = resolveTravelMediaUrl(summary.coverImage);
    final String progressLabel = summary.progressLabel;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 128,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: selected ? tp.accent : Colors.transparent,
              width: 2,
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: tp.accent.withValues(alpha: selected ? 0.22 : 0.12),
                blurRadius: 16,
                offset: const Offset(0, 5),
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14.5),
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                if (cover.isNotEmpty)
                  CachedMediaImage(
                    url: cover,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) =>
                        _CoverFallback(cs: cs, label: summary.destination),
                  )
                else
                  _CoverFallback(cs: cs, label: summary.destination),
                const DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      stops: <double>[0.3, 1.0],
                      colors: <Color>[Colors.transparent, Color(0xB3141416)],
                    ),
                  ),
                ),
                Positioned(
                  left: 10,
                  top: 9,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3.5),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.94),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        _LiveDot(color: tp.accent),
                        const SizedBox(width: 5),
                        Text(
                          progressLabel.isEmpty ? "进行中" : "进行中 · $progressLabel",
                          style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w700,
                            color: const Color(0xFF0B4A40),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                Positioned(
                  left: 12,
                  right: 12,
                  bottom: 10,
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              summary.displayTitle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.w800,
                                color: Colors.white,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              <String>[
                                if (summary.destination.isNotEmpty) summary.destination,
                                if (summary.dateRangeLabel.isNotEmpty) summary.dateRangeLabel,
                              ].join(" · "),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 11,
                                color: Colors.white.withValues(alpha: 0.9),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (onOpen != null) ...<Widget>[
                        const SizedBox(width: 8),
                        Material(
                          color: tp.accentBg,
                          borderRadius: BorderRadius.circular(16),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(16),
                            onTap: onOpen,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 11, vertical: 6),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  Text(
                                    "继续行程",
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w700,
                                      color: tp.onAccentBg,
                                    ),
                                  ),
                                  Icon(Icons.chevron_right,
                                      size: 14, color: tp.onAccentBg),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
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

/// 即将出发：横卡（左封面 + 标题/地点日期 + 倒计时/天数/预算 chips）。
class _UpcomingCard extends StatelessWidget {
  const _UpcomingCard({
    required this.cs,
    required this.tp,
    required this.summary,
    required this.selected,
    required this.onTap,
  });

  final ColorScheme cs;
  final TravelPalette tp;
  final _PlanSummary summary;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final String cover = resolveTravelMediaUrl(summary.coverImage);
    return Material(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(15),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(15),
        child: Container(
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(15),
            border: Border.all(
              color: selected ? tp.accent : cs.outlineVariant.withValues(alpha: 0.5),
              width: selected ? 1.8 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              ClipRRect(
                borderRadius: BorderRadius.circular(11),
                child: SizedBox(
                  width: 68,
                  height: 68,
                  child: cover.isEmpty
                      ? _CoverFallback(cs: cs, label: summary.destination)
                      : CachedMediaImage(
                          url: cover,
                          width: 68,
                          height: 68,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) =>
                              _CoverFallback(cs: cs, label: summary.destination),
                        ),
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      summary.displayTitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Row(
                      children: <Widget>[
                        Icon(Icons.place_outlined, size: 12, color: cs.onSurfaceVariant),
                        const SizedBox(width: 3),
                        Flexible(
                          child: Text(
                            <String>[
                              if (summary.destination.isNotEmpty) summary.destination,
                              if (summary.dateRangeLabel.isNotEmpty) summary.dateRangeLabel,
                            ].join(" · "),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 5,
                      runSpacing: 4,
                      children: <Widget>[
                        if (summary.countdownLabel.isNotEmpty)
                          _TagChip(
                            label: summary.countdownLabel,
                            foreground: tp.accent,
                            background: tp.accent.withValues(alpha: 0.12),
                          ),
                        _TagChip(
                          label: "${summary.dayCount} 天",
                          foreground: cs.onSurfaceVariant,
                          background: cs.surfaceContainerHighest,
                        ),
                        if (summary.totalCost != null && summary.totalCost! > 0)
                          _TagChip(
                            label: "¥${summary.totalCost!.toStringAsFixed(0)}",
                            foreground: cs.onSurfaceVariant,
                            background: cs.surfaceContainerHighest,
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, size: 17, color: cs.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

/// 往期回顾：紧凑行分组容器（行内分隔线，档案视角弱化）。
class _PastGroup extends StatelessWidget {
  const _PastGroup({
    required this.cs,
    required this.plans,
    required this.selectedId,
    required this.onTap,
  });

  final ColorScheme cs;
  final List<_PlanSummary> plans;
  final String? selectedId;
  final void Function(_PlanSummary) onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.45)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: <Widget>[
          for (int i = 0; i < plans.length; i++) ...<Widget>[
            if (i > 0)
              Divider(height: 1, thickness: 0.6, color: cs.outlineVariant.withValues(alpha: 0.5)),
            _PastRow(
              cs: cs,
              summary: plans[i],
              selected: selectedId == plans[i].planId,
              onTap: () => onTap(plans[i]),
            ),
          ],
        ],
      ),
    );
  }
}

class _PastRow extends StatelessWidget {
  const _PastRow({
    required this.cs,
    required this.summary,
    required this.selected,
    required this.onTap,
  });

  final ColorScheme cs;
  final _PlanSummary summary;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final TravelPalette tp = TravelPalette.of(context);
    final String cover = resolveTravelMediaUrl(summary.coverImage);
    final String when = summary.createdLabel.length >= 5
        ? "${summary.createdLabel.substring(0, 5)} 归档"
        : summary.createdLabel;
    return Material(
      color: selected ? tp.accent.withValues(alpha: 0.08) : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
          child: Row(
            children: <Widget>[
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: SizedBox(
                  width: 44,
                  height: 44,
                  child: cover.isEmpty
                      ? _CoverFallback(cs: cs, label: summary.destination, compact: true)
                      : CachedMediaImage(
                          url: cover,
                          width: 44,
                          height: 44,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) =>
                              _CoverFallback(cs: cs, label: summary.destination, compact: true),
                        ),
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      summary.displayTitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(height: 2.5),
                    Text(
                      <String>[
                        if (summary.destination.isNotEmpty) summary.destination,
                        "${summary.dayCount} 天",
                        if (summary.totalCost != null && summary.totalCost! > 0)
                          "¥${summary.totalCost!.toStringAsFixed(0)}",
                      ].join(" · "),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              Text(
                when,
                style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
              ),
              if (summary.bucket == _PlanBucket.past) ...<Widget>[
                const SizedBox(width: 8),
                _TagChip(
                  label: "已完成",
                  foreground: cs.onSurfaceVariant,
                  background: cs.surfaceContainerHighest,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 通用小组件
// ═══════════════════════════════════════════════════════════════════

/// 呼吸光点（进行中徽章前缀）。
class _LiveDot extends StatelessWidget {
  const _LiveDot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: <BoxShadow>[
          BoxShadow(color: color.withValues(alpha: 0.35), blurRadius: 5, spreadRadius: 2),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.cs,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final ColorScheme cs;
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final TravelPalette tp = TravelPalette.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5.5),
        decoration: BoxDecoration(
          color: selected ? tp.accentBg : cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? tp.accent : Colors.transparent,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                color: selected ? tp.onAccentBg : cs.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 3),
            Text(
              "$count",
              style: TextStyle(
                fontSize: 11,
                color: selected ? tp.onAccentBg.withValues(alpha: 0.75) : cs.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({
    required this.label,
    this.foreground,
    this.background,
  });

  final String label;

  /// 缺省时走 surfaceContainerHighest / onSurfaceVariant（中性 chip）。
  final Color? foreground;
  final Color? background;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: background ?? cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: foreground ?? cs.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _TagChip extends StatelessWidget {
  const _TagChip({
    required this.label,
    required this.foreground,
    required this.background,
  });

  final String label;
  final Color foreground;
  final Color background;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(11),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          color: foreground,
        ),
      ),
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({
    required this.cs,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final ColorScheme cs;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        foregroundColor: cs.onSurface,
        side: BorderSide(color: cs.outlineVariant),
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      ),
      icon: Icon(icon, size: 15),
      label: Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
    );
  }
}

/// 封面渐变兜底（目的地首字）。
class _CoverFallback extends StatelessWidget {
  const _CoverFallback({
    required this.cs,
    required this.label,
    this.compact = false,
  });

  final ColorScheme cs;
  final String label;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[cs.primaryContainer, cs.secondaryContainer],
        ),
      ),
      child: Text(
        label.isEmpty ? "行" : label.characters.first,
        style: TextStyle(
          fontSize: compact ? 16 : 22,
          fontWeight: FontWeight.w600,
          color: cs.onPrimaryContainer,
        ),
      ),
    );
  }
}

/// 横幅封面兜底（目的地首字 + 渐变）。
class _BannerFallback extends StatelessWidget {
  const _BannerFallback({required this.cs, required this.label});

  final ColorScheme cs;
  final String label;

  @override
  Widget build(BuildContext context) {
    return _CoverFallback(cs: cs, label: label);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 空态 / 错误态
// ═══════════════════════════════════════════════════════════════════

/// 搜索 / 筛选无命中。
class _NoMatchView extends StatelessWidget {
  const _NoMatchView({required this.cs, required this.onReset});

  final ColorScheme cs;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.search_off, size: 40, color: cs.onSurfaceVariant),
          const SizedBox(height: 10),
          Text(
            "没有匹配的行程",
            style: TextStyle(fontSize: 13.5, color: cs.onSurface),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: onReset,
            icon: const Icon(Icons.filter_alt_off_outlined, size: 16),
            label: const Text("清除搜索与筛选"),
          ),
        ],
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView({required this.cs});

  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final TravelPalette tp = TravelPalette.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.luggage_outlined, size: 44, color: cs.onSurfaceVariant),
          const SizedBox(height: 12),
          Text(
            "还没有行程",
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: cs.onSurface),
          ),
          const SizedBox(height: 6),
          Text(
            "创建过的行程都会保存在这里，\n随时回看每一站。",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant, height: 1.6),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () => TravelAskLauncher.ask("帮我规划一次旅行"),
            style: FilledButton.styleFrom(
              backgroundColor: tp.accentBg,
              foregroundColor: tp.onAccentBg,
            ),
            icon: const Icon(Icons.auto_awesome, size: 15),
            label: const Text("让 Agent 帮我规划一次旅行"),
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({
    required this.message,
    required this.detail,
    required this.onRetry,
  });

  final String message;
  final String detail;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.cloud_off_outlined, size: 40, color: cs.onSurfaceVariant),
          const SizedBox(height: 10),
          Text(message, style: TextStyle(fontSize: 13.5, color: cs.onSurface)),
          const SizedBox(height: 4),
          Text(
            detail,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
          const SizedBox(height: 14),
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh, size: 16),
            label: const Text("重试"),
          ),
        ],
      ),
    );
  }
}
