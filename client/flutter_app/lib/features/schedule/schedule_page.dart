import "dart:async";
import "dart:math" show max, min;
import "dart:ui" as ui;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../../core/db/isar_local_history_store.dart";
import "../../core/models/schedule_models.dart";
import "../../core/services/schedule_api_client.dart";
import "../../core/services/schedule_offline_delete_queue.dart";
import "../../core/services/schedule_recurrence_expand.dart";
import "../../core/services/schedule_reminder_sync.dart";

/// 日程：本地持久化事项（日历周视图 + 事项管理）。
class SchedulePage extends StatefulWidget {
  const SchedulePage({
    super.key,
    required this.store,
    this.scheduleApi,
    this.sessionId,
    this.reloadListenable,
    required this.onCreateViaChat,
  });

  final IsarLocalHistoryStore store;
  final ScheduleApiClient? scheduleApi;
  final String? sessionId;
  final ValueListenable<int>? reloadListenable;

  /// 「创建日程」点击后跳转对话界面并聚焦输入框，
  /// 由用户自然语言说出需求、Agent 在对话中完成创建（不走表单）。
  final VoidCallback onCreateViaChat;

  @override
  State<SchedulePage> createState() => _SchedulePageState();
}

class _SchedulePageState extends State<SchedulePage> {
  static const List<String> _weekdayCn = <String>[
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ];
  static const List<String> _weekdayEn = <String>[
    "MON",
    "TUE",
    "WED",
    "THU",
    "FRI",
    "SAT",
    "SUN",
  ];

  /// 0：日历；1：事项管理（全部本地事项）。
  int _subTab = 0;

  DateTime _weekStart = _mondayOf(DateTime.now());
  DateTime _focusedDay = _stripTime(DateTime.now());

  /// 视图模式：'day' 为日视图，'week' 为周视图。
  String _viewMode = 'day';

  List<ScheduleEvent> _allEvents = <ScheduleEvent>[];
  List<ScheduleEvent> _weekEvents = <ScheduleEvent>[];
  String? _selectedEventId;

  static DateTime _stripTime(DateTime d) => DateTime(d.year, d.month, d.day);

  static DateTime _mondayOf(DateTime d) {
    final DateTime day = _stripTime(d);
    return day.subtract(Duration(days: day.weekday - DateTime.monday));
  }

  @override
  void initState() {
    super.initState();
    _focusedDay = _focusDayForWeek(_weekStart);
    widget.reloadListenable?.addListener(_onExternalReload);
    unawaited(_reloadAll());
  }

  @override
  void dispose() {
    widget.reloadListenable?.removeListener(_onExternalReload);
    super.dispose();
  }

  void _onExternalReload() {
    unawaited(_reloadAll());
  }

  DateTime _focusDayForWeek(DateTime monday) {
    final DateTime today = _stripTime(DateTime.now());
    final DateTime sunday = monday.add(const Duration(days: 6));
    if (!today.isBefore(monday) && !today.isAfter(sunday)) {
      return today;
    }
    return monday;
  }

  String? _scheduleServiceWarning;

  Future<void> _reloadAll() async {
    final ScheduleApiClient? api = widget.scheduleApi;
    final String? sessionId = widget.sessionId?.trim();
    final DateTime wEnd = _weekStart.add(const Duration(days: 7));
    String? serviceWarning;
    if (api != null && sessionId != null && sessionId.isNotEmpty) {
      final bool reachable = await api.isReachable();
      if (!reachable) {
        final int pendingDeletes =
            (await widget.store.getPendingScheduleDeleteTaskIds()).length;
        serviceWarning =
            "主服务未连接（${api.baseUrl}），日程仅显示本地缓存；删除/同步需先启动后端";
        if (pendingDeletes > 0) {
          serviceWarning =
              "$serviceWarning（$pendingDeletes 条删除待服务端同步，连接后自动补删）";
        }
      } else {
        try {
          await flushScheduleOfflineDeleteQueue(widget.store, api);
          await syncServerRemindersToLocal(
            widget.store,
            api,
            sessionId,
            rangeStart: _weekStart.subtract(const Duration(days: 1)),
            rangeEnd: wEnd.add(const Duration(days: 1)),
          );
        } catch (_) {
          serviceWarning = "日程同步失败，当前为本地缓存";
        }
      }
    }
    final List<ScheduleEvent> weekList =
        await widget.store.listScheduleEventsInRange(_weekStart, wEnd);
    final List<ScheduleEvent> allList =
        await widget.store.listAllScheduleEvents();
    if (!mounted) {
      return;
    }
    setState(() {
      _weekEvents = weekList;
      _allEvents = allList;
      _scheduleServiceWarning = serviceWarning;
    });
  }

  static String _formatClock(DateTime d) {
    final String hh = d.hour.toString().padLeft(2, "0");
    final String mm = d.minute.toString().padLeft(2, "0");
    return "$hh:$mm";
  }

  static String _formatRangeLabel(DateTime monday) {
    final DateTime sunday = monday.add(const Duration(days: 6));
    if (monday.year == sunday.year && monday.month == sunday.month) {
      return "${monday.year}年${monday.month}月${monday.day}日 - ${sunday.day}日";
    }
    if (monday.year == sunday.year) {
      return "${monday.year}年${monday.month}月${monday.day}日 - "
          "${sunday.month}月${sunday.day}日";
    }
    return "${monday.year}年${monday.month}月${monday.day}日 - "
        "${sunday.year}年${sunday.month}月${sunday.day}日";
  }

  static String _formatDayLabel(DateTime day) {
    return "${day.year}年${day.month}月${day.day}日";
  }

  Map<DateTime, List<ScheduleEvent>> _eventsByDay() {
    final Map<DateTime, List<ScheduleEvent>> map =
        <DateTime, List<ScheduleEvent>>{};
    for (final ScheduleEvent e in _weekEvents) {
      final DateTime k = _stripTime(e.startAt);
      map.putIfAbsent(k, () => <ScheduleEvent>[]).add(e);
    }
    for (final List<ScheduleEvent> list in map.values) {
      list.sort(
        (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
      );
    }
    return map;
  }

  bool _isEventCompleted(ScheduleEvent e) {
    return !e.startAt.isAfter(DateTime.now());
  }

  void _shiftWeek(int delta) {
    setState(() {
      _weekStart = _weekStart.add(Duration(days: delta * 7));
      _focusedDay = _focusDayForWeek(_weekStart);
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _shiftDay(int delta) {
    setState(() {
      _focusedDay = _focusedDay.add(Duration(days: delta));
      // 如果焦点日期不在当前周范围内，更新周起始日期
      final DateTime weekEnd = _weekStart.add(const Duration(days: 6));
      if (_focusedDay.isBefore(_weekStart) || _focusedDay.isAfter(weekEnd)) {
        _weekStart = _mondayOf(_focusedDay);
      }
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _goToCurrentWeek() {
    setState(() {
      _weekStart = _mondayOf(DateTime.now());
      _focusedDay = _stripTime(DateTime.now());
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _goToToday() {
    setState(() {
      _focusedDay = _stripTime(DateTime.now());
      _weekStart = _mondayOf(_focusedDay);
      _selectedEventId = null;
    });
    _reloadAll();
  }

  Future<void> _confirmDelete(ScheduleEvent e) async {
    final bool? del = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("删除日程"),
          content: Text("确定删除「${e.title}」？"),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("删除"),
            ),
          ],
        );
      },
    );
    if (del != true || !mounted) return;

    final String? serverTaskId = scheduleServerTaskIdFromEventId(e.id);
    final ScheduleApiClient? api = widget.scheduleApi;

    // 1. 立即从本机移除（含隐藏列表，防止同步拉回）
    if (serverTaskId != null) {
      await widget.store.hideScheduleTask(serverTaskId);
      await widget.store.deleteScheduleEventsForTask(serverTaskId);
      await enqueueScheduleOfflineDelete(widget.store, serverTaskId);
    } else {
      await widget.store.deleteScheduleEvent(e.id);
    }
    _selectedEventId = null;
    if (mounted) {
      setState(() {
        _allEvents = _filterOutDeletedEvent(_allEvents, e, serverTaskId);
        _weekEvents = _filterOutDeletedEvent(_weekEvents, e, serverTaskId);
      });
    }

    // 2. 后台同步服务端（失败则保留在离线删除队列，主服务恢复后自动补删）
    if (serverTaskId != null && api != null) {
      final ScheduleApiResult<void> result =
          await api.deleteScheduleTask(serverTaskId);
      if (result.ok) {
        await dequeueScheduleOfflineDelete(widget.store, serverTaskId);
      } else if (mounted) {
        final String hint = result.networkError
            ? "已在本地删除，待主服务恢复后自动同步删除。（${result.error ?? ""}）"
            : "已在本地删除；服务端：（${result.error ?? "删除失败"}），将稍后重试";
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(hint.trim()),
            duration: const Duration(seconds: 5),
          ),
        );
      }
    }

    await _reloadAll();
  }

  List<ScheduleEvent> _filterOutDeletedEvent(
    List<ScheduleEvent> events,
    ScheduleEvent target,
    String? serverTaskId,
  ) {
    return events.where((ScheduleEvent ev) {
      if (ev.id == target.id) return false;
      if (serverTaskId != null) {
        final String? tid = scheduleServerTaskIdFromEventId(ev.id);
        if (tid == serverTaskId) return false;
      }
      return true;
    }).toList();
  }

  Widget _buildSubTabBar(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Row(
        children: <Widget>[
          Flexible(
            child: Row(
              children: <Widget>[
                _subTabPill(theme, 0, "日历"),
                const SizedBox(width: 20),
                _subTabPill(theme, 1, "事项管理"),
              ],
            ),
          ),
          // 在日历视图中添加日/周切换按钮
          if (_subTab == 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ToggleButtons(
                isSelected: [_viewMode == 'day', _viewMode == 'week'],
                onPressed: (int index) {
                  setState(() {
                    _viewMode = index == 0 ? 'day' : 'week';
                  });
                },
                borderRadius: BorderRadius.circular(8),
                selectedColor: cs.onSurface,
                fillColor: Colors.transparent,
                color: cs.onSurfaceVariant,
                borderColor: cs.outline,
                selectedBorderColor: cs.onSurface,
                constraints: const BoxConstraints(minWidth: 48, minHeight: 32),
                children: const <Widget>[
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text('日', style: TextStyle(fontSize: 13)),
                  ),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text('周', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: cs.primary,
              foregroundColor: cs.onPrimary,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
            onPressed: widget.onCreateViaChat,
            child: const Text("创建日程"),
          ),
        ],
      ),
    );
  }

  Widget _subTabPill(ThemeData theme, int index, String label) {
    final bool on = _subTab == index;
    // 暗色主题下选中标签用纯白，保证在黑色背景上清晰
    final Color activeColor =
        theme.colorScheme.brightness == Brightness.dark
            ? Colors.white
            : theme.colorScheme.onSurface;
    return InkWell(
      onTap: () {
        setState(() => _subTab = index);
        if (index == 1) {
          // 切换到事项管理时不显示加载状态，直接展示内容
          _reloadAll();
        }
      },
      borderRadius: BorderRadius.circular(4),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              label,
              style: theme.textTheme.titleSmall?.copyWith(
                color: on
                    ? activeColor
                    : theme.colorScheme.onSurfaceVariant,
                fontWeight: on ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
            const SizedBox(height: 6),
            Container(
              height: 2,
              width: 40,
              decoration: BoxDecoration(
                color: on ? activeColor : Colors.transparent,
                borderRadius: BorderRadius.circular(1),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _weekRangeControls(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    final DateTime today = _stripTime(DateTime.now());

    // 根据视图模式判断是否显示"回到今天/本周"按钮
    final bool isCurrentView;
    if (_viewMode == 'day') {
      isCurrentView = _focusedDay == today;
    } else {
      isCurrentView = !_weekStart.isAfter(today) && !today.isAfter(_weekStart.add(const Duration(days: 6)));
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Material(
            color: Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
              side: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
            ),
            child: IntrinsicWidth(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  IconButton(
                    constraints: const BoxConstraints.tightFor(width: 32, height: 32),
                    tooltip: _viewMode == 'day' ? "上一天" : "上一周",
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    onPressed: () => _viewMode == 'day' ? _shiftDay(-1) : _shiftWeek(-1),
                    icon: Icon(Icons.chevron_left, color: cs.onSurface),
                    iconSize: 18,
                  ),
                  Flexible(
                    child: SizedBox(
                      height: 24,
                      child: Text(
                        _viewMode == 'day'
                            ? _formatDayLabel(_focusedDay)
                            : _formatRangeLabel(_weekStart),
                        textAlign: TextAlign.center,
                        style: theme.textTheme.titleSmall?.copyWith(
                          color: cs.onSurface,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    constraints: const BoxConstraints.tightFor(width: 32, height: 32),
                    tooltip: _viewMode == 'day' ? "下一天" : "下一周",
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    onPressed: () => _viewMode == 'day' ? _shiftDay(1) : _shiftWeek(1),
                    icon: Icon(Icons.chevron_right, color: cs.onSurface),
                    iconSize: 18,
                  ),
                  // 按需显示"回到今天/本周"按钮
                  if (!isCurrentView)
                    Container(
                      height: 28,
                      margin: const EdgeInsets.only(left: 4),
                      child: OutlinedButton.icon(
                        onPressed: _viewMode == 'day' ? _goToToday : _goToCurrentWeek,
                        icon: Icon(_viewMode == 'day' ? Icons.today : Icons.calendar_today, size: 14),
                        label: Text(_viewMode == 'day' ? "今天" : "本周", style: const TextStyle(fontSize: 11)),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                          visualDensity: VisualDensity.compact,
                          foregroundColor: cs.onSurfaceVariant,
                          side: BorderSide(color: cs.outline.withValues(alpha: 0.5)),
                          minimumSize: const Size(0, 0),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _dayGrid(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    final Map<DateTime, List<ScheduleEvent>> byDay = _eventsByDay();
    final DateTime today = _stripTime(DateTime.now());
    final DateTime focusedDay = _stripTime(_focusedDay);

    // 获取当前聚焦日期的事项
    final List<ScheduleEvent> events = byDay[focusedDay] ?? <ScheduleEvent>[];

    final bool isTodayHeader = focusedDay == today;

    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // 日期标题
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: cs.outline.withValues(
                    alpha: isTodayHeader ? 0.55 : 0.35,
                  ),
                ),
              ),
            ),
            child: Column(
              children: <Widget>[
                Text(
                  "${_weekdayCn[focusedDay.weekday - 1]} / ${_weekdayEn[focusedDay.weekday - 1]}",
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  "${focusedDay.year}年${focusedDay.month}月${focusedDay.day}日",
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.onSurface,
                  ),
                ),
              ],
            ),
          ),
          // 事项列表
          Expanded(
            child: ColoredBox(
              color: cs.surface,
              child: events.isEmpty
                  ? Center(
                      child: Text(
                        '当天暂无事项',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      children: events
                          .map(
                            (ScheduleEvent e) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _scheduleCard(theme, e),
                            ),
                          )
                          .toList(),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _weekGrid(ThemeData theme) {
    final Map<DateTime, List<ScheduleEvent>> byDay = _eventsByDay();
    final DateTime today = _stripTime(DateTime.now());
    final double screenW = MediaQuery.sizeOf(context).width;
    final bool useScroll = screenW < 560;
    const double colMin = 104.0;

    Widget dayColumn(int i) {
      final DateTime day = _weekStart.add(Duration(days: i));
      final bool isToday = _stripTime(day) == today;
      final List<ScheduleEvent> events = byDay[_stripTime(day)] ?? <ScheduleEvent>[];

      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() {
          _focusedDay = _stripTime(day);
          _selectedEventId = null;
        }),
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(
              right: BorderSide(
                color: theme.colorScheme.outline.withValues(alpha: 0.28),
              ),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                      color: theme.colorScheme.outline.withValues(
                        alpha: isToday ? 0.55 : 0.35,
                      ),
                    ),
                  ),
                ),
                child: Column(
                  children: <Widget>[
                    Text(
                      "${_weekdayCn[i]} / ${_weekdayEn[i]}",
                      textAlign: TextAlign.center,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      day.day.toString().padLeft(2, "0"),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ColoredBox(
                  color: theme.colorScheme.surface,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(6, 0, 6, 12),
                    children: events
                        .map(
                          (ScheduleEvent e) => Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: _scheduleCard(theme, e),
                          ),
                        )
                        .toList(),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final List<Widget> cols =
        List<Widget>.generate(7, dayColumn);

    return Expanded(
      child: useScroll
          ? SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: colMin * 7,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: cols
                      .map(
                        (Widget w) => SizedBox(width: colMin, child: w),
                      )
                      .toList(),
                ),
              ),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: cols
                  .map((Widget w) => Expanded(child: w))
                  .toList(),
            ),
    );
  }

  /// 琐事标签：标识生活琐事提醒（照常到点推送，不进「今日安排」）。
  Widget _triviaTag(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    return Tooltip(
      message: "生活琐事提醒：照常到点提醒，不进「今日安排」列表",
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          color: cs.onSurfaceVariant.withValues(alpha: 0.10),
        ),
        child: Text(
          "琐事",
          style: theme.textTheme.labelSmall?.copyWith(
            fontSize: 10,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }

  Widget _scheduleCard(ThemeData theme, ScheduleEvent e) {
    final ColorScheme cs = theme.colorScheme;
    final bool done = _isEventCompleted(e);
    final bool selected = _selectedEventId == e.id;
    final Color statusColor = done
        ? cs.onSurfaceVariant.withValues(alpha: 0.88)
        : const Color(0xFFD4A574);
    final String statusText = done ? "已完成" : "待执行";
    const double radius = 10;

    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Text(
                e.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onSurface,
                  fontWeight: FontWeight.w600,
                  height: 1.25,
                ),
              ),
            ),
            if (e.isTrivia) ...<Widget>[
              const SizedBox(width: 6),
              _triviaTag(theme),
            ],
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: <Widget>[
            Icon(
              done ? Icons.check_circle_outline : Icons.hourglass_top_rounded,
              size: 15,
              color: statusColor,
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                statusText,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: statusColor,
                  fontSize: 12,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: <Widget>[
            Icon(
              Icons.schedule_rounded,
              size: 15,
              color: cs.onSurfaceVariant.withValues(alpha: 0.9),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                _formatClock(e.startAt),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: cs.onSurfaceVariant,
                  fontSize: 12,
                ),
              ),
            ),
          ],
        ),
      ],
    );

    return Material(
      color: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => setState(() => _selectedEventId = e.id),
        onLongPress: () => _confirmDelete(e),
        borderRadius: BorderRadius.circular(radius),
        child: Stack(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
              child: body,
            ),
            if (selected)
              Positioned.fill(
                child: IgnorePointer(
                  child: _DashedGoldBorder(radius: radius),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _formatEventDayLabel(DateTime d) {
    final DateTime day = _stripTime(d);
    final DateTime today = _stripTime(DateTime.now());
    final String ymd =
        "${day.year}-${day.month.toString().padLeft(2, "0")}-${day.day.toString().padLeft(2, "0")}";
    if (day == today) return "今天 · $ymd";
    if (day == today.add(const Duration(days: 1))) {
      return "明天 · $ymd";
    }
    return ymd;
  }

  Widget _managementView(ThemeData theme) {
    // 事项管理只展示「待执行」事项：开始时间晚于当前时间的日程。
    final DateTime now = DateTime.now();
    final List<ScheduleEvent> pendingEvents = _allEvents
        .where((ScheduleEvent e) => e.startAt.isAfter(now))
        .toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: <Widget>[
        if (_scheduleServiceWarning != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Material(
              color: theme.colorScheme.errorContainer.withValues(alpha: 0.35),
              borderRadius: BorderRadius.circular(8),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Text(
                  _scheduleServiceWarning!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onErrorContainer,
                  ),
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(
            "待执行事项 · 共 ${pendingEvents.length} 条",
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (pendingEvents.isEmpty)
          Text(
            "暂无待执行事项，可点击右上角「创建日程」添加。",
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else
          ..._managementEventTiles(theme, pendingEvents),
      ],
    );
  }

  List<Widget> _managementEventTiles(ThemeData theme, List<ScheduleEvent> events) {
    final List<Widget> tiles = <Widget>[];

    // 按 taskId 分组事件
    final Map<String?, List<ScheduleEvent>> groupedEvents = <String?, List<ScheduleEvent>>{};
    for (final ScheduleEvent e in events) {
      final String? taskId = scheduleServerTaskIdFromEventId(e.id);
      groupedEvents.putIfAbsent(taskId, () => <ScheduleEvent>[]).add(e);
    }

    // 按每个组的最早时间排序
    final List<MapEntry<String?, List<ScheduleEvent>>> sortedGroups =
        groupedEvents.entries.toList()
          ..sort((MapEntry<String?, List<ScheduleEvent>> a, MapEntry<String?, List<ScheduleEvent>> b) {
            final DateTime aStart = a.value.map((ScheduleEvent e) => e.startAt).reduce(
              (DateTime x, DateTime y) => x.isBefore(y) ? x : y,
            );
            final DateTime bStart = b.value.map((ScheduleEvent e) => e.startAt).reduce(
              (DateTime x, DateTime y) => x.isBefore(y) ? x : y,
            );
            return aStart.compareTo(bStart);
          });

    DateTime? lastDay;
    for (final MapEntry<String?, List<ScheduleEvent>> entry in sortedGroups) {
      final List<ScheduleEvent> events = entry.value;

      // 找到该组的最早日期（用于分组标题）
      final DateTime firstDay = _stripTime(
        events.map((ScheduleEvent e) => e.startAt).reduce(
          (DateTime x, DateTime y) => x.isBefore(y) ? x : y,
        ),
      );

      // 添加日期分组标题（如果与上一个不同）
      if (lastDay == null || firstDay != lastDay) {
        lastDay = firstDay;
        tiles.add(
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 8),
            child: Text(
              _formatEventDayLabel(firstDay),
              style: theme.textTheme.labelLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        );
      }

      // 获取第一个事件的信息作为代表
      final ScheduleEvent representative = events.first;
      final int dayCount = events.length;
      final bool isMultiDay = dayCount > 1;

      tiles.add(
        Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(
                  Icons.event_note_outlined,
                  size: 22,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              representative.title,
                              style: theme.textTheme.bodyLarge?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          if (representative.isTrivia) ...<Widget>[
                            const SizedBox(width: 6),
                            _triviaTag(theme),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _buildMultiDayEventInfo(representative, events, isMultiDay, dayCount),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () => _confirmDelete(representative),
                  child: const Text("删除"),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return tiles;
  }

  /// 构建多天事件的显示信息。
  String _buildMultiDayEventInfo(
    ScheduleEvent representative,
    List<ScheduleEvent> events,
    bool isMultiDay,
    int dayCount,
  ) {
    final StringBuffer info = StringBuffer();
    info.write(_formatClock(representative.startAt));

    // 多天任务显示天数和日期范围
    if (isMultiDay) {
      final DateTime firstDay = _stripTime(
        events.map((ScheduleEvent e) => e.startAt).reduce(
          (DateTime x, DateTime y) => x.isBefore(y) ? x : y,
        ),
      );
      final DateTime lastDay = _stripTime(
        events.map((ScheduleEvent e) => e.startAt).reduce(
          (DateTime x, DateTime y) => x.isAfter(y) ? x : y,
        ),
      );

      info.write(" · 共$dayCount天任务");

      // 如果不是同一天，显示日期范围
      if (firstDay != lastDay) {
        info.write(" (${firstDay.month}/${firstDay.day} - ${lastDay.month}/${lastDay.day})");
      }
    }

    // 2026-10-26 用户定稿：提醒卡文案组件只留标题，notes（「单次提醒 · 到点了…」）
    // 不再拼进展示信息（新旧数据一致忽略）。

    return info.toString();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ColoredBox(
      color: theme.colorScheme.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildSubTabBar(theme),
          if (_subTab == 0) ...<Widget>[
            _weekRangeControls(theme),
            // 根据视图模式显示不同的网格
            if (_viewMode == 'day')
              _dayGrid(theme)
            else
              _weekGrid(theme),
          ] else
            Expanded(child: _managementView(theme)),
        ],
      ),
    );
  }
}

/// 与参考图一致的金色圆角虚线选中框。
class _DashedGoldBorder extends StatelessWidget {
  const _DashedGoldBorder({required this.radius});

  final double radius;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _DashedGoldPainter(radius: radius),
    );
  }
}

class _DashedGoldPainter extends CustomPainter {
  _DashedGoldPainter({required this.radius});

  final double radius;
  static const Color _gold = Color(0xFFE8C547);

  @override
  void paint(Canvas canvas, Size size) {
    final double inset = 1.25;
    final RRect rrect = RRect.fromRectAndRadius(
      Rect.fromLTWH(
        inset,
        inset,
        size.width - inset * 2,
        size.height - inset * 2,
      ),
      Radius.circular(max(0, radius - inset)),
    );
    final Path outline = Path()..addRRect(rrect);
    final Paint paint = Paint()
      ..color = _gold
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    const double dash = 5;
    const double gap = 3.5;
    for (final ui.PathMetric metric in outline.computeMetrics()) {
      double distance = 0;
      while (distance < metric.length) {
        final double len = min(dash, metric.length - distance);
        canvas.drawPath(
          metric.extractPath(distance, distance + len),
          paint,
        );
        distance += len + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedGoldPainter oldDelegate) =>
      oldDelegate.radius != radius;
}
