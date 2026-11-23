import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "mobile_theme.dart";
import "../core/services/nb_http.dart";

/// 手机端「每日简报」页。
///
/// 与桌面端简报同源:GET /api/morning-briefing?sessionId=<账号 id>,
/// 服务端实时生成(今日日程 + 待办跟进)。
/// 2026-11-04 收敛：待复习笔记/兴趣热搜撤出晨报；DDL 与在途行程并进
/// 「今日日程」同一栏（服务端已按 kind 标记，条目标题带「截止／行程」前缀）。
/// 2026-11-23 §3.4 分工：日程与截止只在早安说，夜里的明日预览只讲天气——
/// 重要日子（当天命中的生日/纪念日）随之搬回早安这一栏（briefing.importantDays，
/// 服务端只放 daysUntil==0 的，没命中时整个 key 不存在）。
/// 在途行程只给手机端：带 includeInProgressTravel=1 才取，桌面端不传。
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
      // 在途行程段只投手机端：手机端显式开启（电脑端不传，晨报里没有行程段）
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&includeInProgressTravel=1");
      final http.Response res = await (widget.client ?? NbClient())
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
              OutlinedButton(
                  onPressed: () => unawaited(_load()), child: const Text("重试")),
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
                greeting.isEmpty
                    ? "早上好"
                    : (appellation.isEmpty
                        ? greeting
                        : "$appellation，$greeting"),
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
        _buildImportantDaysSection(b, p),
        _buildTodoSection(b, p),
        const SizedBox(height: 24),
      ],
    );
  }

  /// 今天的重要日子（生日/纪念日）：§3.4 分工后由夜里的明日预览搬回这一栏。
  /// 服务端只放当天命中的（daysUntil==0），没命中时连 key 都没有 → 整栏不出，
  /// 不留空标题；近期预告（还有几天那种）不上早安，也不上睡前的卡，
  /// 用户问「最近有什么日子」时由问答面 TomorrowPreviewFacts 答。
  Widget _buildImportantDaysSection(Map<String, dynamic> b, MobilePalette p) {
    final List<dynamic> days =
        (b["importantDays"] as List<dynamic>?) ?? const <dynamic>[];
    if (days.isEmpty) return const SizedBox.shrink();
    return _Section(
      p: p,
      icon: Icons.celebration_outlined,
      title: "今天的重要日子",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final dynamic d in days)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.cake_outlined,
                      size: 16, color: Color(0xFFF6C445)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _importantDayTitle(d),
                          style: TextStyle(
                            color: p.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        // 备注（喜好/上次聊到什么）只在服务端给了才占一行
                        if (_importantDayNote(d).isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              _importantDayNote(d),
                              style: TextStyle(
                                color: p.textMuted,
                                fontSize: 13,
                              ),
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
    );
  }

  /// 「妈妈的生日」/「结婚纪念日的纪念日」：类型中文标签在服务端已定，
  /// 这里只按 type 兜个显示名（缺 type 就当生日）
  String _importantDayTitle(dynamic d) {
    final Map<String, dynamic> m = (d as Map).cast<String, dynamic>();
    final String name = m["name"]?.toString() ?? "";
    final String type = m["type"]?.toString() ?? "birthday";
    final String label = type == "anniversary"
        ? "纪念日"
        : type == "custom"
            ? "特殊日子"
            : "生日";
    return "$name的$label";
  }

  /// 次要一行：关系标签 + 备注（都没给就空着，不硬凑）
  String _importantDayNote(dynamic d) {
    final Map<String, dynamic> m = (d as Map).cast<String, dynamic>();
    return <String>[
      for (final String k in <String>["relationship", "notes"])
        if ((m[k]?.toString() ?? "").trim().isNotEmpty) m[k].toString().trim(),
    ].join(" · ");
  }

  /// 日程条目标题：三源合并后按 kind 加前缀（截止 / 行程），普通日程原样
  String _scheduleTitle(dynamic item) {
    final String title =
        (item as Map<String, dynamic>)["title"]?.toString() ?? "";
    final String kind = item["kind"]?.toString() ?? "schedule";
    final String note = item["note"]?.toString() ?? "";
    final String prefix = kind == "deadline"
        ? "截止："
        : kind == "travel"
            ? "行程："
            : "";
    return note.isEmpty ? "$prefix$title" : "$prefix$title（$note）";
  }

  Widget _buildScheduleItems(Map<String, dynamic> b, MobilePalette p) {
    final List<dynamic> items =
        (b["todaySchedule"] as List<dynamic>?) ?? const <dynamic>[];
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
                    _scheduleTitle(item),
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
    final Map<String, dynamic>? todo =
        b["todoFollowups"] as Map<String, dynamic>?;
    if (todo == null) return const SizedBox.shrink();
    final List<dynamic> pending =
        (todo["pending"] as List<dynamic>?) ?? const <dynamic>[];
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
              child: Text("今天已办结 $done 件",
                  style: TextStyle(color: p.textSecondary, fontSize: 14)),
            ),
          for (final dynamic s in pending)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  const SizedBox(width: 4),
                  Container(
                      width: 4,
                      height: 4,
                      decoration: BoxDecoration(
                          color: p.textMuted, shape: BoxShape.circle)),
                  const SizedBox(width: 10),
                  Expanded(
                      child: Text(s.toString(),
                          style:
                              TextStyle(color: p.textPrimary, fontSize: 15))),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(
      {required this.p,
      required this.icon,
      required this.title,
      required this.child});

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
