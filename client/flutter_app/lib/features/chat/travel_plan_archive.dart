import "dart:async" show unawaited;
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "media_disk_cache.dart";
import "travel_ask_launcher.dart";
import "travel_plan_mobile_page.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程归档页（应用内「常用工具 → 行程」入口）。
//
// 列出用户在对话中创建过的全部行程：服务端 GET /travel/plans 返回摘要
// （travelPlanStore 落盘 data/travel-plans/*.json，跨重启可查，最多 50 份）。
// 点击条目拉取完整行程（GET /travel/plans/:planId）后按平台打开详情：
// - Windows 桌面：应用内 WebView 面板（TravelPlanFullscreenPage.fromPlan，
//   与行程独立窗口同一「行迹」桌面页 1:1）；
// - Android / iOS：原生行程页（TravelPlanMobilePage）。
// 行程卡点击的独立窗口链路保持不变——本页只承担「行程沉淀 + 随时回看」。
// ═══════════════════════════════════════════════════════════════════

/// 行程摘要（GET /travel/plans 的单条记录）。
class _PlanSummary {
  const _PlanSummary({
    required this.planId,
    required this.title,
    required this.destination,
    required this.startDate,
    required this.endDate,
    required this.dayCount,
    required this.createdAt,
    this.totalCost,
    this.coverImage = "",
  });

  factory _PlanSummary.fromJson(Map<String, dynamic> json) {
    return _PlanSummary(
      planId: json["planId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      destination: json["destination"]?.toString() ?? "",
      startDate: json["startDate"]?.toString() ?? "",
      endDate: json["endDate"]?.toString() ?? "",
      dayCount: (json["dayCount"] as num?)?.toInt() ?? 0,
      createdAt: (json["createdAt"] as num?)?.toInt() ?? 0,
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
  final int createdAt;
  final double? totalCost;
  final String coverImage;

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
    return summaries;
  }

  /// 拉取完整行程并按平台打开详情。
  Future<void> _openDetail(_PlanSummary summary) async {
    if (_opening) return;
    _opening = true;
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.httpBase}/travel/plans/${summary.planId}"))
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
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("行程打开失败：$e", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
    } finally {
      _opening = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        title: const Text("行程"),
        actions: <Widget>[
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh),
            onPressed: () => setState(() => _future = _fetchSummaries()),
          ),
        ],
      ),
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
          final List<_PlanSummary> plans = snapshot.data ?? const <_PlanSummary>[];
          if (plans.isEmpty) {
            return _EmptyView(cs: cs);
          }
          return RefreshIndicator(
            onRefresh: () async {
              final List<_PlanSummary> fresh = await _fetchSummaries();
              if (mounted) setState(() => _future = Future<List<_PlanSummary>>.value(fresh));
            },
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              itemCount: plans.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (BuildContext context, int index) =>
                  _PlanCard(summary: plans[index], onTap: () => _openDetail(plans[index])),
            ),
          );
        },
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 列表条目卡
// ═══════════════════════════════════════════════════════════════════

class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.summary, required this.onTap});

  final _PlanSummary summary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String cover = resolveTravelMediaUrl(summary.coverImage);
    final String dateRange = summary.dateRangeLabel;
    return Material(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              // 封面：无图时用目的地首字 + 渐变兜底
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
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
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      summary.title.isEmpty ? summary.destination : summary.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: <Widget>[
                        Icon(Icons.place_outlined, size: 13, color: cs.onSurfaceVariant),
                        const SizedBox(width: 2),
                        Flexible(
                          child: Text(
                            summary.destination.isEmpty ? "未知目的地" : summary.destination,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ),
                        if (dateRange.isNotEmpty) ...<Widget>[
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              dateRange,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: <Widget>[
                        // 行程状态：进行中高亮（行后回顾视角的第一眼信息）
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
                          decoration: BoxDecoration(
                            color: summary.status().active
                                ? cs.primary.withValues(alpha: 0.15)
                                : cs.surfaceContainerHighest.withValues(alpha: 0.6),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            summary.status().label,
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w600,
                              color: summary.status().active
                                  ? cs.primary
                                  : cs.onSurfaceVariant,
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        _MetaChip(
                          cs: cs,
                          icon: Icons.event_outlined,
                          label: "${summary.dayCount}天",
                        ),
                        if (summary.totalCost != null && summary.totalCost! > 0) ...<Widget>[
                          const SizedBox(width: 6),
                          _MetaChip(
                            cs: cs,
                            icon: Icons.payments_outlined,
                            label: "¥${summary.totalCost!.toStringAsFixed(0)}",
                          ),
                        ],
                        const Spacer(),
                        if (summary.createdLabel.isNotEmpty)
                          Text(
                            summary.createdLabel,
                            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, size: 18, color: cs.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({required this.cs, required this.icon, required this.label});

  final ColorScheme cs;
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 12, color: cs.onSurfaceVariant),
          const SizedBox(width: 3),
          Text(
            label,
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _CoverFallback extends StatelessWidget {
  const _CoverFallback({required this.cs, required this.label});

  final ColorScheme cs;
  final String label;

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
          fontSize: 22,
          fontWeight: FontWeight.w600,
          color: cs.onPrimaryContainer,
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 空态 / 错误态
// ═══════════════════════════════════════════════════════════════════

class _EmptyView extends StatelessWidget {
  const _EmptyView({required this.cs});

  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
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
              backgroundColor: cs.primary,
              foregroundColor: cs.onPrimary,
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
