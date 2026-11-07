import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "mobile_theme.dart";

/// 手机端「目标」页（在办事项统一视图，按 2026-11-07 设计稿一比一还原）。
///
/// 布局：顶部筛选 chips（全部 / 进行中 / 等拍板 / 已完成）+ 右上「+ 新建目标」
/// （跳回对话 tab 交代）；目标卡片带进度条（解析 `2/5 步` 前缀）+ 当前步骤 +
/// 达成判据 + 待拍板徽标。
/// 数据源：GET /api/proactivity/goals/view?actorId=…&includeDone=1
/// （服务端 UnifiedGoalView 单源只读；includeCompleted 为手机端新增可选口径，
/// 桌面端面板不带此参不受影响）。
class MobileGoalsPage extends StatefulWidget {
  const MobileGoalsPage({super.key, this.client, this.onCreateGoal});

  /// 注入 http client(测试用)。
  final http.Client? client;

  /// 「+ 新建目标」入口：跳回对话 tab（由主壳注入 goToTab(0)）。
  final VoidCallback? onCreateGoal;

  @override
  State<MobileGoalsPage> createState() => MobileGoalsPageState();
}

enum _GoalFilter { all, active, needsUser, done }

class MobileGoalsPageState extends State<MobileGoalsPage> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = const <Map<String, dynamic>>[];
  _GoalFilter _filter = _GoalFilter.all;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 主壳切到本 tab 时触发重拉（IndexedStack 保活下 initState 只走一次）。
  void refresh() {
    if (!_loading) unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/proactivity/goals/view?actorId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&includeDone=1");
      final http.Response res = await (widget.client ?? http.Client())
          .get(uri)
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw Exception("服务端返回 ${res.statusCode}");
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        throw Exception(body["error"]?.toString() ?? "未知错误");
      }
      final Map<String, dynamic> view =
          (body["view"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      final List<dynamic> rawItems =
          (view["items"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _items = rawItems
            .whereType<Map<String, dynamic>>()
            .toList(growable: false);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  static bool _isActive(Map<String, dynamic> item) {
    final String s = item["status"]?.toString() ?? "";
    return s == "watching" || s == "preparing" || s == "ready";
  }

  List<Map<String, dynamic>> get _filtered {
    switch (_filter) {
      case _GoalFilter.all:
        return _items;
      case _GoalFilter.active:
        return _items.where((i) => _isActive(i) && i["needsUser"] != true).toList();
      case _GoalFilter.needsUser:
        return _items.where((i) => i["needsUser"] == true).toList();
      case _GoalFilter.done:
        return _items.where((i) => !_isActive(i)).toList();
    }
  }

  int _countOf(_GoalFilter f) {
    switch (f) {
      case _GoalFilter.all:
        return _items.length;
      case _GoalFilter.active:
        return _items.where((i) => _isActive(i) && i["needsUser"] != true).length;
      case _GoalFilter.needsUser:
        return _items.where((i) => i["needsUser"] == true).length;
      case _GoalFilter.done:
        return _items.where((i) => !_isActive(i)).length;
    }
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("目标"),
        actions: [
          IconButton(
            tooltip: "新建目标",
            icon: const Icon(Icons.add, size: 26),
            onPressed: widget.onCreateGoal,
          ),
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh, size: 22),
            onPressed: _loading ? null : () => unawaited(_load()),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : _error != null
              ? _buildError(p)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _buildList(p),
                ),
    );
  }

  Widget _buildError(MobilePalette p) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
            const SizedBox(height: 12),
            Text(
              "目标视图获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
              textAlign: TextAlign.center,
              style: TextStyle(color: p.textSecondary, fontSize: 14),
            ),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: () => unawaited(_load()), child: const Text("重试")),
          ],
        ),
      ),
    );
  }

  static const Map<_GoalFilter, String> _filterLabels = <_GoalFilter, String>{
    _GoalFilter.all: "全部",
    _GoalFilter.active: "进行中",
    _GoalFilter.needsUser: "等拍板",
    _GoalFilter.done: "已完成",
  };

  Widget _buildList(MobilePalette p) {
    final List<Map<String, dynamic>> shown = _filtered;
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        // 筛选 chips（设计稿：全部/进行中/等拍板/已完成）
        SizedBox(
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            children: [
              for (final _GoalFilter f in _GoalFilter.values)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: _FilterChip(
                    p: p,
                    label: _filterLabels[f]!,
                    count: _countOf(f),
                    selected: _filter == f,
                    onTap: () => setState(() => _filter = f),
                  ),
                ),
            ],
          ),
        ),
        if (shown.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 48),
            child: Column(
              children: [
                Icon(Icons.flag_outlined, size: 44, color: p.textMuted),
                const SizedBox(height: 12),
                Text(
                  _filter == _GoalFilter.all
                      ? "还没有在办目标\n在对话里交代的事，会自动出现在这里"
                      : "这个筛选下没有目标",
                  textAlign: TextAlign.center,
                  style: TextStyle(color: p.textMuted, fontSize: 14, height: 1.5),
                ),
              ],
            ),
          )
        else
          for (final Map<String, dynamic> item in shown)
            _GoalCard(p: p, item: item),
      ],
    );
  }
}

/// 筛选 chip：选中 = 深色底反白，未选中 = 浅底灰字。
class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.p,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final MobilePalette p;
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? p.textPrimary : p.surface,
          borderRadius: BorderRadius.circular(999),
          border: selected ? null : Border.all(color: p.divider.withValues(alpha: 0.7)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: TextStyle(
                color: selected ? p.background : p.textSecondary,
                fontSize: 13,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
            // 计数恒展示（含 0）：四个 chip 宽度节奏一致，否则有无计数参差
            const SizedBox(width: 5),
            Text(
              "$count",
              style: TextStyle(
                color: selected
                    ? p.background.withValues(alpha: 0.7)
                    : p.textMuted,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GoalCard extends StatelessWidget {
  const _GoalCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  static const Map<String, String> _kindLabels = <String, String>{
    "track": "跟踪",
    "preexec": "预执行",
    "plan": "计划推进",
  };

  static const Map<String, String> _statusLabels = <String, String>{
    "watching": "观察中",
    "preparing": "准备中",
    "ready": "就绪",
    "done": "已完成",
    "expired": "已过期",
  };

  static bool _isActiveStatus(String status) =>
      status == "watching" || status == "preparing" || status == "ready";

  /// 解析进度串前缀「2/5」→ 进度条占比；解析不出返回 null（只展示文字）。
  static (int, int)? _parseFraction(String? progress) {
    if (progress == null) return null;
    final RegExpMatch? m = RegExp(r"(\d+)\s*/\s*(\d+)").firstMatch(progress);
    if (m == null) return null;
    final int cur = int.parse(m.group(1)!);
    final int total = int.parse(m.group(2)!);
    if (total <= 0) return null;
    return (cur.clamp(0, total), total);
  }

  /// 「2/5 步，当前「比价酒店」」→ 当前步骤「比价酒店」；没有则 null。
  static String? _currentStep(String? progress) {
    if (progress == null) return null;
    final int idx = progress.indexOf("当前");
    if (idx < 0) return null;
    return progress
        .substring(idx + 2)
        .replaceAll("「", "")
        .replaceAll("」", "")
        .trim();
  }

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "";
    final String kind = item["kind"]?.toString() ?? "";
    final String status = item["status"]?.toString() ?? "";
    final String? progress = item["progress"]?.toString();
    final bool needsUser = item["needsUser"] == true;
    final bool done = !_isActiveStatus(status);
    final String? criteria = item["successCriteria"]?.toString();
    final int pendingFindings =
        (item["pendingFindings"] as num?)?.toInt() ?? 0;
    final (int, int)? fraction = _parseFraction(progress);
    final String? step = _currentStep(progress);

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 10, 16, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(16),
        border: needsUser
            ? Border.all(color: p.accent.withValues(alpha: 0.35))
            : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (_kindLabels[kind] != null)
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: p.innerFieldBackground,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    _kindLabels[kind]!,
                    style: TextStyle(color: p.textSecondary, fontSize: 11),
                  ),
                ),
              if (_statusLabels[status] != null)
                Padding(
                  // 与左侧 kind 徽标同高对齐：徽标有 2px 垂直内边距，
                  // 裸文本基线会偏高（截图确认），这里补同尺寸内边距兜平。
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Text(
                    _statusLabels[status]!,
                    style: TextStyle(
                      color: done ? p.textMuted : p.textSecondary,
                      fontSize: 11,
                    ),
                  ),
                ),
              const Spacer(),
              if (needsUser)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: p.accent.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    done ? "验收未过" : "待你拍板",
                    style: TextStyle(
                      color: p.accent,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            title,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w600,
              height: 1.35,
              decoration: done ? TextDecoration.lineThrough : null,
              decorationColor: p.textMuted,
            ),
          ),
          // 进度条（设计稿核心元素）：解析「2/5」前缀。Row+stretch+flex 确定性
          // 绘制——上一版 Align+FractionallySizedBox 里无子节点的 DecoratedBox
          // 在松约束下高度塌 0，填充层整个消失（真机截图像素级验证过）。
          if (fraction != null) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: SizedBox(
                height: 6,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    if (fraction.$1 > 0)
                      Expanded(flex: fraction.$1, child: ColoredBox(color: p.accent)),
                    Expanded(flex: fraction.$2 - fraction.$1, child: ColoredBox(color: p.innerFieldBackground)),
                  ],
                ),
              ),
            ),
          ],
          if (progress != null && progress.isNotEmpty) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(
                    progress,
                    style: TextStyle(color: p.textSecondary, fontSize: 13),
                  ),
                ),
                // progressLine 自带「当前「…」」时不再重复展示步骤
                if (step != null && step.isNotEmpty && !progress.contains("当前"))
                  Text(
                    "当前：$step",
                    style: TextStyle(color: p.textMuted, fontSize: 12),
                  ),
              ],
            ),
          ],
          if (criteria != null && criteria.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              "达成判据：$criteria",
              style: TextStyle(color: p.textMuted, fontSize: 12, height: 1.4),
            ),
          ],
          if (pendingFindings > 0) ...[
            const SizedBox(height: 8),
            Text(
              "$pendingFindings 条相关发现待说给你",
              style: TextStyle(color: p.textMuted, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}
