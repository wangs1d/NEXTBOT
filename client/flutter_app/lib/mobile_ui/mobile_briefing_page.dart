import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "mobile_theme.dart";

/// 手机端「每日简报」页。
///
/// 与桌面端简报同源:GET /api/morning-briefing?sessionId=<账号 id>,
/// 服务端实时生成(天气/今日日程/待看笔记/待办跟进/近期重要日子/穿搭建议)。
class MobileBriefingPage extends StatefulWidget {
  const MobileBriefingPage({super.key, this.client});

  /// 注入 http client(测试用)。
  final http.Client? client;

  @override
  State<MobileBriefingPage> createState() => _MobileBriefingPageState();
}

class _MobileBriefingPageState extends State<MobileBriefingPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _briefing;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
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
      if (!mounted) return;
      setState(() {
        _briefing = body["briefing"] as Map<String, dynamic>?;
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

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("每日简报"),
        actions: [
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh, size: 22),
            onPressed: _loading ? null : () => unawaited(_load()),
          ),
        ],
      ),
      body: _buildBody(context, p),
    );
  }

  Widget _buildBody(BuildContext context, MobilePalette p) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
              const SizedBox(height: 12),
              Text(
                "简报获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
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
    final Map<String, dynamic> b = _briefing ?? const <String, dynamic>{};
    final String appellation = b["appellation"]?.toString() ?? "";
    final String greeting = b["agentGreeting"]?.toString() ?? "";
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                b["date"]?.toString() ?? "",
                style: TextStyle(color: p.textMuted, fontSize: 13),
              ),
              const SizedBox(height: 6),
              Text(
                greeting.isEmpty ? "早上好" : (appellation.isEmpty ? greeting : "$appellation，$greeting"),
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  height: 1.3,
                ),
              ),
            ],
          ),
        ),
        _Section(
          p: p,
          icon: Icons.event_outlined,
          title: "今日日程",
          child: _buildScheduleItems(b, p),
        ),
        _Section(
          p: p,
          icon: Icons.sticky_note_2_outlined,
          title: "没看过的笔记",
          child: _buildNoteItems(b, p),
        ),
        _buildTodoSection(b, p),
        _buildImportantDaysSection(b, p),
        _buildTravelSection(b, p),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _buildScheduleItems(Map<String, dynamic> b, MobilePalette p) {
    final List<dynamic> items = (b["todaySchedule"] as List<dynamic>?) ?? const <dynamic>[];
    if (items.isEmpty) {
      return _EmptyHint(p: p, text: "今天没有安排,好好休息");
    }
    return Column(
      children: [
        for (final dynamic item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 52,
                  child: Text(
                    (item as Map<String, dynamic>)["time"]?.toString() ?? "全天",
                    style: TextStyle(color: p.textMuted, fontSize: 13),
                  ),
                ),
                Expanded(
                  child: Text(
                    item["title"]?.toString() ?? "",
                    style: TextStyle(color: p.textPrimary, fontSize: 15),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildNoteItems(Map<String, dynamic> b, MobilePalette p) {
    final List<dynamic> items = (b["pendingNotes"] as List<dynamic>?) ?? const <dynamic>[];
    if (items.isEmpty) {
      return _EmptyHint(p: p, text: "笔记都看过了");
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final dynamic item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                const SizedBox(width: 4),
                Container(width: 4, height: 4, decoration: BoxDecoration(color: p.textMuted, shape: BoxShape.circle)),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    (item as Map<String, dynamic>)["title"]?.toString() ?? "",
                    style: TextStyle(color: p.textPrimary, fontSize: 15),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildTodoSection(Map<String, dynamic> b, MobilePalette p) {
    final Map<String, dynamic>? todo = b["todoFollowups"] as Map<String, dynamic>?;
    if (todo == null) return const SizedBox.shrink();
    final List<dynamic> pending = (todo["pending"] as List<dynamic>?) ?? const <dynamic>[];
    final Object? done = todo["doneTodayCount"];
    if (pending.isEmpty && (done == null || (done is int && done == 0))) {
      return const SizedBox.shrink();
    }
    return _Section(
      p: p,
      icon: Icons.checklist_outlined,
      title: "之前交代的事",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (done is int && done > 0)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text("今天已办结 $done 件", style: TextStyle(color: p.textSecondary, fontSize: 14)),
            ),
          for (final dynamic s in pending)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  const SizedBox(width: 4),
                  Container(width: 4, height: 4, decoration: BoxDecoration(color: p.textMuted, shape: BoxShape.circle)),
                  const SizedBox(width: 10),
                  Expanded(child: Text(s.toString(), style: TextStyle(color: p.textPrimary, fontSize: 15))),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 行程段：今天落在行程区间内 → 目的地 + 第一站 + 随身叮嘱（第六源）
  Widget _buildTravelSection(Map<String, dynamic> b, MobilePalette p) {
    final Map<String, dynamic>? travel = b["travel"] as Map<String, dynamic>?;
    if (travel == null) return const SizedBox.shrink();
    final Map<String, dynamic>? firstStop =
        travel["firstStop"] as Map<String, dynamic>?;
    final List<dynamic> packing =
        (travel["packing"] as List<dynamic>?) ?? const <dynamic>[];
    final String destination = travel["destination"]?.toString() ?? "";
    final String title = travel["title"]?.toString() ?? "";
    return _Section(
      p: p,
      icon: Icons.luggage_outlined,
      title: "今日行程",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            firstStop != null
                ? "$destination · 「$title」\n第一站 ${firstStop["startTime"] ?? ""} ${firstStop["name"] ?? ""}"
                : "$destination · 「$title」",
            style: TextStyle(color: p.textPrimary, fontSize: 15, height: 1.5),
          ),
          if (packing.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                "记得带：${packing.join("、")}",
                style: TextStyle(color: p.textSecondary, fontSize: 13.5),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildImportantDaysSection(Map<String, dynamic> b, MobilePalette p) {
    final List<dynamic> days = (b["upcomingImportantDays"] as List<dynamic>?) ?? const <dynamic>[];
    if (days.isEmpty) return const SizedBox.shrink();
    return _Section(
      p: p,
      icon: Icons.celebration_outlined,
      title: "近期重要日子",
      child: Column(
        children: [
          for (final dynamic d in days)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 76,
                    child: Text(
                      (d as Map<String, dynamic>)["date"]?.toString() ?? "",
                      style: TextStyle(color: p.textMuted, fontSize: 13),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      d["title"]?.toString() ?? "",
                      style: TextStyle(color: p.textPrimary, fontSize: 15),
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

class _Section extends StatelessWidget {
  const _Section({required this.p, required this.icon, required this.title, required this.child});

  final MobilePalette p;
  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: p.textSecondary),
              const SizedBox(width: 8),
              Text(
                title,
                style: TextStyle(
                  color: p.textSecondary,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.p, required this.text});

  final MobilePalette p;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: TextStyle(color: p.textMuted, fontSize: 14));
  }
}
