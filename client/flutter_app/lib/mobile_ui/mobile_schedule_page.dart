import "dart:math" as math;

import "package:flutter/material.dart";

import "../core/services/schedule_api_client.dart";
import "mobile_theme.dart";

/// 手机端行程表 v2：一天一页 + 顶部日期条跳转，只读。
///
/// 设计稿 [docs/design/mobile-schedule-redesign/mockup.html]：
/// - 顶部日期条（定稿）：固定周网格，7 格不滚动 + ‹›翻周，
///   点周标签一键回今天（无「今」快捷按钮）；今天格子带蓝「今」+
///   描边圈常驻，日期数字 17px 大圆醒目；
/// - 一天占一页（PageView 按天分页）：日头(大日期+今天徽标+周几+件数) +
///   当天卡片列表；左右滑动换天，点日期一键直达；
/// - 「下一件」= 今天最近一条未完成：描边 + 倒计时徽标，只出现在今天页；
///   已完成灰化 + 对勾；
/// - 空日不空白：日头「N 没有安排」+ 虚线空卡 + 对话引导；
/// - 与桌面端 [../features/schedule/schedule_page.dart] 完全独立，
///   无日历、无创建/删除/编辑等任何管理入口——管理归桌面端与对话。
class MobileSchedulePage extends StatefulWidget {
  const MobileSchedulePage({
    super.key,
    required this.scheduleApi,
    required this.sessionId,
    this.onGoToChat,
  });

  final ScheduleApiClient scheduleApi;
  final String sessionId;

  /// 空日引导点击时跳回对话 tab。
  final VoidCallback? onGoToChat;

  @override
  State<MobileSchedulePage> createState() => MobileSchedulePageState();
}

class MobileSchedulePageState extends State<MobileSchedulePage> {
  /// 展示范围：从今天零点起往后 30 天。
  static const int _lookaheadDays = 30;

  /// 每页天数（一周）。
  static const int _weekSize = 7;

  bool _loading = true;
  String? _error;

  /// 解析后的全部条目（今天零点起 30 天内，已滤掉 cancelled 与无法解析时刻的）。
  List<_ScheduleEntry> _entries = <_ScheduleEntry>[];

  /// 按日索引：y-M-d → 当天条目（已按时刻排序）。
  Map<String, List<_ScheduleEntry>> _byDay = <String, List<_ScheduleEntry>>{};

  /// 分页的 30 天（今天零点起）。
  late final List<DateTime> _days;

  late final PageController _pageController;

  /// 当前页下标（0 = 今天）。
  int _selected = 0;

  /// 当前周页（0 = 今天所在周，每页 [_weekSize] 天，‹›翻页）。
  int _weekPage = 0;

  @override
  void initState() {
    super.initState();
    final DateTime today = _dateOf(DateTime.now());
    _days = List<DateTime>.generate(
      _lookaheadDays,
      (int i) => today.add(Duration(days: i)),
      growable: false,
    );
    _pageController = PageController(initialPage: 0);
    _load();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// 外部触发的重新拉取（2026-10-08）：页面在 IndexedStack 里保活，initState
  /// 只拉一次——对话里刚建的提醒不切不刷新。主壳在每次切到本 tab 时调用。
  void refresh() => _load();

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final DateTime now = DateTime.now();
    final DateTime from = DateTime(now.year, now.month, now.day);
    final DateTime to = from.add(const Duration(days: _lookaheadDays));
    final ScheduleApiResult<List<Map<String, dynamic>>> result =
        await widget.scheduleApi.listScheduleTasksResult(
      widget.sessionId,
      from: from,
      to: to,
    );
    if (!mounted) return;
    if (!result.ok) {
      setState(() {
        _loading = false;
        _error = result.error ?? "拉取日程失败";
      });
      return;
    }
    setState(() {
      _entries = _parse(result.value ?? const <Map<String, dynamic>>[], from);
      _byDay = <String, List<_ScheduleEntry>>{};
      for (final _ScheduleEntry e in _entries) {
        (_byDay[_keyOf(e.at)] ??= <_ScheduleEntry>[]).add(e);
      }
      _loading = false;
    });
  }

  /// 服务端任务记录 → 展示条目。时刻口径与后台一致：
  /// 已完成看 lastRunAt（实际执行时刻），未完成看 nextRunAt（下一次触发）。
  List<_ScheduleEntry> _parse(
    List<Map<String, dynamic>> tasks,
    DateTime rangeFrom,
  ) {
    final List<_ScheduleEntry> out = <_ScheduleEntry>[];
    for (final Map<String, dynamic> t in tasks) {
      final String status = t["status"]?.toString() ?? "active";
      if (status == "cancelled") continue;
      final bool completed = status == "completed";
      final String? iso = completed
          ? ((t["lastRunAt"] ?? t["runAt"]) as String?)
          : ((t["nextRunAt"] ?? t["runAt"]) as String?);
      if (iso == null || iso.isEmpty) continue;
      final DateTime? at = DateTime.tryParse(iso)?.toLocal();
      if (at == null) continue;
      if (at.isBefore(rangeFrom)) continue;
      final String title = (t["shortTitle"] ??
              t["reminderMessage"] ??
              t["title"] ??
              t["description"] ??
              "")
          .toString()
          .trim();
      if (title.isEmpty) continue;
      out.add(_ScheduleEntry(
        id: t["taskId"]?.toString() ?? "",
        at: at,
        title: title,
        location: t["location"]?.toString(),
        completed: completed,
      ));
    }
    out.sort((_ScheduleEntry a, _ScheduleEntry b) => a.at.compareTo(b.at));
    return out;
  }

  static DateTime _dateOf(DateTime dt) => DateTime(dt.year, dt.month, dt.day);

  String _keyOf(DateTime d) => "${d.year}-${d.month}-${d.day}";

  List<_ScheduleEntry> _itemsOf(DateTime day) =>
      _byDay[_keyOf(day)] ?? const <_ScheduleEntry>[];

  static const List<String> _weekdays = <String>[
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ];

  String _meridiem(DateTime dt) =>
      dt.hour < 12 ? "上午" : (dt.hour < 18 ? "下午" : "晚上");

  String _formatTime(DateTime dt) =>
      "${dt.hour.toString().padLeft(2, "0")}:${dt.minute.toString().padLeft(2, "0")}";

  /// 「下一件」倒计时文案：N 分钟后 / X 小时 Y 分后 / N 天后。
  String _countdown(DateTime at, DateTime now) {
    final Duration d = at.difference(now);
    if (d.inDays >= 1) return "${d.inDays} 天后";
    final int h = d.inHours;
    final int m = d.inMinutes % 60;
    if (h >= 1) return m > 0 ? "$h 小时 $m 分后" : "$h 小时后";
    return "${d.inMinutes} 分钟后";
  }

  /// 今天最近一条「还没到点且未完成」的条目；无则 null。
  _ScheduleEntry? _nextEntry(DateTime now) {
    for (final _ScheduleEntry e in _entries) {
      if (e.completed) continue;
      if (e.at.isAfter(now)) return e;
    }
    return null;
  }

  /// 点格子/周标签跳到第 i 天。
  void _jumpToDay(int i) {
    _pageController.animateToPage(
      i,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  void _onPageChanged(int i) {
    setState(() {
      _selected = i;
      _weekPage = i ~/ _weekSize;
    });
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            _buildWeekStrip(p),
            Expanded(child: _buildBody(p)),
          ],
        ),
      ),
    );
  }

  // ═══════════ 日期条 · 固定周网格 ═══════════

  /// 固定周网格：7 格不滚动（目标稳定），头部 ‹ 周标签 › 翻周，
  /// 点周标签一键回今天；今天格子带蓝「今」+ 描边圈。
  Widget _buildWeekStrip(MobilePalette p) {
    final int start = _weekPage * _weekSize;
    final int end = math.min(start + _weekSize, _days.length);
    final bool canPrev = _weekPage > 0;
    final bool canNext = end < _days.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 2, 10, 4),
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              _weekArrow(p, Icons.chevron_left, canPrev,
                  () => setState(() => _weekPage--)),
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => _jumpToDay(0),
                  child: Text(
                    _weekLabel(_days[start], _days[end - 1]),
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              _weekArrow(p, Icons.chevron_right, canNext,
                  () => setState(() => _weekPage++)),
            ],
          ),
          const SizedBox(height: 2),
          Row(
            children: <Widget>[
              for (int i = start; i < end; i++)
                Expanded(child: _weekCell(p, i, _days[i])),
            ],
          ),
        ],
      ),
    );
  }

  /// 周标签：「10月8日 - 10月14日」；跨月「9月29日 - 10月5日」。
  String _weekLabel(DateTime a, DateTime b) {
    if (a.month == b.month) return "${a.month}月${a.day}日 - ${b.day}日";
    return "${a.month}月${a.day}日 - ${b.month}月${b.day}日";
  }

  Widget _weekArrow(
    MobilePalette p,
    IconData icon,
    bool enabled,
    VoidCallback? onTap,
  ) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: enabled ? onTap : null,
      child: Padding(
        padding: const EdgeInsets.all(5),
        child: Icon(
          icon,
          size: 20,
          color: enabled ? p.textPrimary : p.textMuted,
        ),
      ),
    );
  }

  Widget _weekCell(MobilePalette p, int i, DateTime day) {
    final bool on = i == _selected;
    final bool isToday = i == 0;
    final bool hasItems = _itemsOf(day).isNotEmpty;
    final String wd = isToday ? "今" : _weekdays[day.weekday - 1].substring(1);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _jumpToDay(i),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              wd,
              style: TextStyle(
                color: on
                    ? p.onAccent.withValues(alpha: 0.7)
                    : (isToday ? p.link : p.textMuted),
                fontSize: 11,
                fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
                letterSpacing: 0.5,
              ),
            ),
            const SizedBox(height: 3),
            Container(
              width: 32,
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: on ? p.accent : Colors.transparent,
                shape: BoxShape.circle,
                border: !on && isToday
                    ? Border.all(color: p.textPrimary, width: 1.5)
                    : null,
              ),
              child: Text(
                "${day.day}",
                style: TextStyle(
                  color: on ? p.onAccent : p.textPrimary,
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(height: 3),
            // 有安排的日子带 4px 圆点；空日透明占位
            Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: hasItems
                    ? (on ? p.onAccent : p.textPrimary)
                    : Colors.transparent,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ═══════════ 页面主体 ═══════════

  Widget _buildBody(MobilePalette p) {
    if (_loading && _entries.isEmpty) {
      return _statusView(Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: p.textMuted),
        ),
      ));
    }
    if (_error != null) {
      return _statusView(Center(
        child:
            Text(_error!, style: TextStyle(color: p.textMuted, fontSize: 14)),
      ));
    }
    return PageView.builder(
      controller: _pageController,
      itemCount: _days.length,
      onPageChanged: _onPageChanged,
      itemBuilder: (BuildContext context, int i) => _dayPage(p, i),
    );
  }

  /// 加载/错误态：保留下拉刷新（无旧版大标题）。
  Widget _statusView(Widget child) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: 200),
          child,
        ],
      ),
    );
  }

  /// 一天一页：日头 + 当天卡片列表(或空日卡) + 底部提示。
  Widget _dayPage(MobilePalette p, int i) {
    final DateTime now = DateTime.now();
    final DateTime day = _days[i];
    final List<_ScheduleEntry> items = _itemsOf(day);
    final bool isToday = i == 0;
    final bool isLast = i == _days.length - 1;
    final _ScheduleEntry? next = isToday ? _nextEntry(now) : null;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
        children: <Widget>[
          _dayHead(p, i, items.length),
          if (items.isEmpty)
            _emptyCard(p)
          else
            for (final _ScheduleEntry e in items)
              _scheduleCard(
                p,
                e,
                isLight: Theme.of(context).brightness == Brightness.light,
                isNext: identical(e, next),
                countdown: identical(e, next) ? _countdown(e.at, now) : null,
              ),
          const SizedBox(height: 14),
          Text(
            isLast ? "已是最后一天，没有更晚的安排" : "左右滑动或点上方日期查看其他天 · 下拉刷新",
            textAlign: TextAlign.center,
            style:
                TextStyle(color: p.textMuted, fontSize: 11, letterSpacing: 0.3),
          ),
        ],
      ),
    );
  }

  /// 日头：大日期做主标题 + 今天徽标 + 周几副行 + 件数胶囊。
  Widget _dayHead(MobilePalette p, int i, int count) {
    final DateTime day = _days[i];
    final bool isToday = i == 0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      "${day.month}月${day.day}日",
                      style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.3,
                        height: 1.15,
                      ),
                    ),
                    if (isToday) ...<Widget>[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: p.link,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          "今",
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  _weekdays[day.weekday - 1],
                  style: TextStyle(color: p.textSecondary, fontSize: 12.5),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: p.innerFieldBackground,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              count > 0 ? "$count 件安排" : "没有安排",
              style: TextStyle(color: p.textSecondary, fontSize: 11.5),
            ),
          ),
        ],
      ),
    );
  }

  // ═══════════ 行程卡片 ═══════════

  Widget _scheduleCard(
    MobilePalette p,
    _ScheduleEntry e, {
    required bool isLight,
    required bool isNext,
    String? countdown,
  }) {
    final Color titleColor = e.completed ? p.textMuted : p.textPrimary;
    final String? location =
        (e.location == null || e.location!.isEmpty) ? null : e.location;
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        Container(
          margin: EdgeInsets.only(top: isNext ? 18 : 0, bottom: 10),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: isNext ? p.textPrimary : p.divider,
              width: isNext ? 1.5 : 1,
            ),
            boxShadow: isLight
                ? <BoxShadow>[
                    const BoxShadow(
                      color: Color(0x0D111112),
                      blurRadius: 3,
                      offset: Offset(0, 1),
                    ),
                    if (isNext)
                      const BoxShadow(
                        color: Color(0x1A111112),
                        blurRadius: 14,
                        offset: Offset(0, 4),
                      ),
                  ]
                : null,
          ),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SizedBox(
                  width: 56,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      // 时间固定单行展示：宽度不够时等比缩小，绝不折成两行。
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          _formatTime(e.at),
                          maxLines: 1,
                          softWrap: false,
                          style: TextStyle(
                            color: titleColor,
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.3,
                          ),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _meridiem(e.at),
                        style: TextStyle(
                          color: p.textMuted,
                          fontSize: 10,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  width: 1,
                  margin: const EdgeInsets.only(top: 2, bottom: 2, right: 13),
                  color: p.divider,
                ),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        e.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: titleColor,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          height: 1.35,
                        ),
                      ),
                      if (location != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(Icons.place_outlined,
                                  size: 12, color: p.textMuted),
                              const SizedBox(width: 2),
                              Flexible(
                                child: Text(
                                  location,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      color: p.textMuted, fontSize: 12),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                if (e.completed) ...<Widget>[
                  const SizedBox(width: 8),
                  Center(
                    child: Container(
                      width: 20,
                      height: 20,
                      decoration: BoxDecoration(
                        color: p.innerFieldBackground,
                        shape: BoxShape.circle,
                      ),
                      child:
                          Icon(Icons.check, size: 12, color: p.textSecondary),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        if (isNext && countdown != null)
          Positioned(
            top: -10,
            left: 14,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(
                color: p.accent,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    "下一件",
                    style: TextStyle(
                      color: p.onAccent,
                      fontSize: 10.5,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.3,
                    ),
                  ),
                  const SizedBox(width: 5),
                  Text(
                    countdown,
                    style: TextStyle(
                      color: p.onAccent.withValues(alpha: 0.55),
                      fontSize: 10.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  /// 空日：虚线空卡 + 对话引导，页面不整页留白。
  Widget _emptyCard(MobilePalette p) {
    return CustomPaint(
      painter: _DashedRRectPainter(color: p.divider, radius: 16),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 26),
        child: Column(
          children: <Widget>[
            Text(
              "没有安排",
              style: TextStyle(
                color: p.textSecondary,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (widget.onGoToChat != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: widget.onGoToChat,
                  child: Text(
                    "在对话里说一声，我帮你记下时间 →",
                    style: TextStyle(color: p.link, fontSize: 12.5),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 虚线圆角边框（空日卡用；Flutter 无内置虚线边框）。
class _DashedRRectPainter extends CustomPainter {
  _DashedRRectPainter({required this.color, this.radius = 16});

  final Color color;
  final double radius;

  static const double _dash = 4;
  static const double _gap = 3;

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = Path()
      ..addRRect(RRect.fromRectAndRadius(
        Offset.zero & size,
        Radius.circular(radius),
      ));
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = color;
    for (final metric in path.computeMetrics()) {
      double start = 0;
      while (start < metric.length) {
        final double end = math.min(start + _dash, metric.length);
        canvas.drawPath(metric.extractPath(start, end), paint);
        start = end + _gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedRRectPainter oldDelegate) =>
      oldDelegate.color != color;
}

class _ScheduleEntry {
  const _ScheduleEntry({
    required this.id,
    required this.at,
    required this.title,
    this.location,
    this.completed = false,
  });

  final String id;
  final DateTime at;
  final String title;
  final String? location;
  final bool completed;
}
