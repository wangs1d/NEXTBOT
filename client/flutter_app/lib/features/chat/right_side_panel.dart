import "dart:async" show Timer, unawaited;
import "dart:math" show min;

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/models/schedule_models.dart";
import "../../core/services/right_panel_tool_preference.dart";
import "../../core/services/schedule_preference.dart";


/// 右侧快捷功能面板的固定宽度。
/// 优化后收窄到 220px，减少视觉压迫感，让聊天区更开阔。
const double kRightSidePanelWidth = 220.0;

/// 时间轴单行高度（标题固定单行省略，行高恒定才能让竖向点线精确对齐圆点圆心）。
const double _kTimelineRowHeight = 24.0;

/// 时间轴最多展示的行数，超出的折叠进底部「查看全部」。
const int _kMaxVisibleEvents = 5;

/// 「常用工具」上方内容区（今日安排）的固定高度。
/// 高度恒定 → 工具区起点 Y 恒定，日程事项增减只在这块区域内部消化
/// （超出内部滚动），不会再把工具区推上推下。
/// 取值略大于日程卡满载总高（≈330：头部+日程带+焦点卡+5 行时间轴+尾行），
/// 绝大多数情况无需内部滚动；原足迹卡删除后由 560 收窄至此。
/// 工具区起点 Y 钉死在本值 + 工具区顶距（132）= 512，不随窗口高度变化；
/// 窗口矮到放不下时整列滚动兜底。调工具栏位置改本值或工具区顶距均可。
const double _kUpperAreaFixedHeight = 380.0;

/// 今日安排标题简洁化：剥离「该X啦」提醒式包装、指令前缀、元描述前缀、
/// 以及和左侧时间列重复的时间词，再清理冗余代词词头，只保留核心文案
/// （与日程页完整标题区分，也与桌面悬浮窗的 web 端逻辑保持一致）。
String simplifyScheduleTitle(String raw) {
  String s = raw.trim();
  if (s.isEmpty) return s;

  // 提醒式包装：“该去游泳啦，带上泳衣和浴巾！” -> “去游泳”
  final RegExp reminderWrapper = RegExp(r'^该([^啦了，。！!?？\s]{1,10})(啦|了)');
  final Match? wrapper = reminderWrapper.firstMatch(s);
  if (wrapper != null) s = wrapper.group(1)!;

  final RegExp instruction = RegExp(
    r'^\s*(请)?(记得|别忘了|不要忘记|不要忘了|提醒用户|提醒我|提醒一下|提醒|帮我|记着|叫我|喊我|给我|让我)'
    r'\s*(提醒|一下)?',
  );
  final RegExp metaPrefix = RegExp(
    r'^\s*(定时|设置|安排|添加|创建|新增)(一个|一下|个|条)?(提醒|日程|事项)?',
  );
  final RegExp timeExpr = RegExp(
    r'(今天|明天|后天|今晚|明晚|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜)?'
    r'(\d{1,2}(点|[:：])[:：]?\d{0,2}(分|分钟)?(半|整|左右)?'
    r'|[一二三四五六七八九十两]+点(半|整|左右)?'
    r'|\d{1,2}[:：]\d{2})',
  );
  final RegExp pronoun = RegExp(r'^(我(?!们)|帮我|给我)(的)?');

  // 交替剥离指令前缀 / 元描述前缀 / 时间词 / 冗余代词，直到不再变化：
  // “记得提醒我下午3点帮我买咖啡” -> “我下午3点帮我买咖啡” -> “我帮我买咖啡” -> “买咖啡”
  String prev;
  do {
    prev = s;
    s = s
        .replaceAll(instruction, '')
        .replaceAll(metaPrefix, '')
        .replaceAll(timeExpr, '')
        .replaceAll(pronoun, '');
  } while (s != prev);

  // 清理“的提醒：X”这类残留结构，以及开头的日期词（今日安排均为当天事项）
  s = s.replaceFirst(RegExp(r'^[^：:]*的?(提醒|闹钟|日程)[：:]'), '');
  s = s.replaceFirst(RegExp(r'^(今天|明天|后天|明早|明晚|大后天)'), '');

  s = s.replaceAll(RegExp(r'^[\s，,、.。!！?？\-~—－–]+'), '').trim();
  return s.isEmpty ? "待办事项" : s;
}

/// 页面右侧快捷功能面板。
///
/// 设计理念：简洁、轻盈、不抢视线
/// - 去掉厚重卡片阴影，改用细腻的分隔线区分区块
/// - 工具图标更紧凑，一屏展示全部，无需展开/收起
/// - 「常用工具」原位固定（今日安排下方）：上方内容区恒高、内部滚动，
///   工具区起点 Y 不随动态/日程内容增减而位移
/// - 「今日安排」采用焦点时间轴卡片（设计稿
///   docs/design/today-schedule-redesign）：24h 日程带 + 下一事项焦点卡 +
///   时间轴列表，now 游标与倒计时每 30s 刷新
class RightSidePanel extends StatefulWidget {
  const RightSidePanel({
    super.key,
    this.scheduleFuture,
    this.onAgentLink,
    this.onSchedule,
    this.onMessages,
    this.onGallery,
    this.onBrowser,
    this.messagesUnread = 0,
  });

  final Future<List<ScheduleEvent>>? scheduleFuture;
  final VoidCallback? onAgentLink;
  final VoidCallback? onSchedule;
  final VoidCallback? onMessages;

  /// 「图库」工具入口（照片浏览/上传/删除）。
  final VoidCallback? onGallery;

  /// 「浏览器」工具入口（用户与 Agent 共用的内嵌浏览器）。
  final VoidCallback? onBrowser;

  /// 站内信未读总数（供「消息」工具渲染角标；0 不显示）。
  final int messagesUnread;

  @override
  State<RightSidePanel> createState() => _RightSidePanelState();
}

class _RightSidePanelState extends State<RightSidePanel> {
  /// 焦点卡 hover 态：描边增亮。
  bool _focusHover = false;
  /// 周期刷新：让 now 游标、「接下来 · X分钟后」倒计时随时间前进。
  Timer? _scheduleTicker;

  // 工具区：布局偏好 / 编辑模式
  bool _editingTools = false;
  RightPanelToolLayout _toolLayout = const RightPanelToolLayout();

  // 「日程」工具副标签用的已解析日程数据（与上方 FutureBuilder 消费同一 Future）
  List<ScheduleEvent>? _resolvedScheduleEvents;

  @override
  void initState() {
    super.initState();
    _scheduleTicker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
    // 主题切换时同步悬浮窗配色（窗口未创建时为 no-op）
    unawaited(_loadToolLayout());
    _resolveScheduleFuture();
    _loadSchedulePreference();
  }

  @override
  void didUpdateWidget(covariant RightSidePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scheduleFuture != widget.scheduleFuture) {
      _resolveScheduleFuture();
    }
  }

  void _resolveScheduleFuture() {
    final Future<List<ScheduleEvent>>? future = widget.scheduleFuture;
    if (future == null) {
      _resolvedScheduleEvents = null;
      return;
    }
    future
        .then((List<ScheduleEvent> events) {
      if (!mounted) return;
      setState(() => _resolvedScheduleEvents = events);
    })
        .catchError((Object _) {});
  }

  @override
  void dispose() {
    _scheduleTicker?.cancel();
    super.dispose();
  }

  Future<void> _loadToolLayout() async {
    final RightPanelToolLayout layout = await RightPanelToolPreference.load();
    if (mounted) setState(() => _toolLayout = layout);
  }

  Future<void> _loadSchedulePreference() async {
    final ScheduleDisplayMode mode = await SchedulePreference.getDisplayMode();
    debugPrint("[RightSidePanel] displayMode=$mode");
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: cs.surfaceContainer,
        border: Border(
          left: BorderSide(
            color: cs.outline.withValues(alpha: 0.25),
          ),
        ),
      ),
      child: SafeArea(
        right: false,
        top: false,
        child: SingleChildScrollView(
          // 「常用工具」起点 Y = 上方固定区高度 + 工具区顶距，是恒定值
          // （当前 380 + 132 = 512），不随窗口高度、日程内容增减变化；
          // 窗口矮到一屏放不下时靠本层整列滚动兜底，位置依然钉死。
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 上方内容区：恒定高度 + 内部滚动。内容增减在这块区域内消化，
              // 从而下方工具区的起点 Y 恒定（原位固定）。
              SizedBox(
                height: _kUpperAreaFixedHeight,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  physics: const AlwaysScrollableScrollPhysics(),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _buildScheduleSection(),
                    ],
                  ),
                ),
              ),
              // 「常用工具」：固定在上方恒高区域正下方，位置不随内容变化
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 132, 14, 0),
                child: _buildToolsSection(cs),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 日程区块：「焦点时间轴」卡片
  // 头部完成计数 + 24h 日程带（now 游标）+ 下一事项焦点卡 + 时间轴列表
  // ═══════════════════════════════════════════════════════════
  Widget _buildScheduleSection() {
    final _SchedSkin skin = _SchedSkin.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
      decoration: BoxDecoration(
        color: skin.cardFill,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: skin.cardBorder),
        boxShadow: skin.cardShadow,
      ),
      child: FutureBuilder<List<ScheduleEvent>>(
        future: widget.scheduleFuture,
        builder: (
          BuildContext context,
          AsyncSnapshot<List<ScheduleEvent>> snapshot,
        ) {
          final bool waiting = snapshot.connectionState ==
                  ConnectionState.waiting &&
              snapshot.data == null;
          final List<ScheduleEvent> items = (snapshot.data ??
                  <ScheduleEvent>[])
              ..sort((a, b) => a.startAt.compareTo(b.startAt));
          final DateTime now = DateTime.now();
          final int doneCount =
              items.where((e) => !e.startAt.isAfter(now)).length;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _buildScheduleHeader(skin, doneCount, items.length,
                  showCount: !waiting),
              const SizedBox(height: 10),
              _buildDayStrip(skin, items, now),
              if (waiting)
                const SizedBox(
                  height: 44,
                  child: Center(
                    child: SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              else if (items.isEmpty)
                _buildEmptySchedule(skin)
              else ...<Widget>[
                _buildFocusArea(skin, items, now),
                _buildTimeline(skin, items, now),
                _buildScheduleFooter(skin, items, now),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _buildScheduleHeader(
    _SchedSkin skin,
    int done,
    int total, {
    required bool showCount,
  }) {
    return Row(
      children: <Widget>[
        Container(
          width: 20,
          height: 20,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(6),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: skin.chipGradient,
            ),
          ),
          child: Icon(Icons.calendar_today_outlined,
              size: 11, color: skin.accent),
        ),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            "今日安排",
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: skin.titleText,
              letterSpacing: 0.2,
            ),
          ),
        ),
        if (showCount && total > 0) ...<Widget>[
          Text.rich(
            TextSpan(children: <TextSpan>[
              TextSpan(
                text: "$done",
                style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: skin.accentSoft),
              ),
              TextSpan(
                text: "/$total",
                style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: skin.mutedText),
              ),
            ]),
          ),
          const SizedBox(width: 8),
        ],
      ],
    );
  }

  /// 24h 日程带：事项按真实时间落成彩色刻度，游标指示「现在」。
  Widget _buildDayStrip(
    _SchedSkin skin,
    List<ScheduleEvent> events,
    DateTime now,
  ) {
    final ScheduleEvent? next = _nextEvent(events, now);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        LayoutBuilder(
          builder: (BuildContext context, BoxConstraints c) {
            final double w = c.maxWidth;
            double frac(DateTime t) =>
                ((t.hour * 60 + t.minute) / 1440.0).clamp(0.0, 1.0);
            final double nowX = frac(now) * w;
            return SizedBox(
              height: 14,
              width: w,
              child: Stack(
                clipBehavior: Clip.none,
                children: <Widget>[
                  Positioned(
                    left: 0,
                    right: 0,
                    top: 5,
                    child: Container(
                      height: 4,
                      decoration: BoxDecoration(
                        color: skin.track,
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                  // 已流逝时段：底色渐入强调色
                  if (nowX > 2)
                    Positioned(
                      left: 0,
                      top: 5,
                      child: Container(
                        height: 4,
                        width: nowX,
                        decoration: BoxDecoration(
                          borderRadius: const BorderRadius.horizontal(
                            left: Radius.circular(4),
                            right: Radius.circular(2),
                          ),
                          gradient: LinearGradient(colors: <Color>[
                            skin.elapsedStart,
                            skin.elapsedEnd,
                          ]),
                        ),
                      ),
                    ),
                  for (final ScheduleEvent e in events)
                    _buildStripTick(skin, e, frac(e.startAt) * w, w, next, now),
                  // now 游标
                  Positioned(
                    left: (nowX - 1).clamp(0.0, w - 2),
                    top: 1,
                    child: Container(
                      width: 2,
                      height: 12,
                      decoration: BoxDecoration(
                        color: skin.needle,
                        borderRadius: BorderRadius.circular(2),
                        boxShadow: <BoxShadow>[
                          BoxShadow(
                              color: skin.needleGlow, blurRadius: 6),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
        const SizedBox(height: 3),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: List<Text>.generate(
            5,
            (int i) => Text(
              "${i * 6}点",
              style: TextStyle(
                  fontSize: 9,
                  color: skin.tickLabel,
                  fontWeight: FontWeight.w500),
            ),
          ),
        ),
      ],
    );
  }

  Positioned _buildStripTick(
    _SchedSkin skin,
    ScheduleEvent e,
    double pos,
    double stripWidth,
    ScheduleEvent? next,
    DateTime now,
  ) {
    final bool passed = !e.startAt.isAfter(now);
    final bool isNext = identical(e, next);
    final double size = isNext ? 5.0 : 4.0;
    return Positioned(
      left: (pos - size / 2).clamp(0.0, stripWidth - size),
      top: isNext ? 4.5 : 5,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: passed
              ? skin.doneDotFill
              : (isNext ? skin.accent : _categoryDot(skin, e.startAt.hour)),
          borderRadius: BorderRadius.circular(isNext ? 2 : 4),
          boxShadow: isNext
              ? <BoxShadow>[BoxShadow(color: skin.needleGlow, blurRadius: 5)]
              : null,
        ),
      ),
    );
  }

  /// 焦点区：下一个事项强调卡（倒计时 + 备注），全部完成时显示完成横幅。
  Widget _buildFocusArea(
    _SchedSkin skin,
    List<ScheduleEvent> items,
    DateTime now,
  ) {
    final ScheduleEvent? next = _nextEvent(items, now);
    if (next == null) {
      return Container(
        margin: const EdgeInsets.only(top: 10),
        padding:
            const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
        decoration: BoxDecoration(
          color: skin.dotGreen.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(10),
          border:
              Border.all(color: skin.dotGreen.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.check_circle_outline,
                size: 12, color: skin.dotGreen),
            const SizedBox(width: 6),
            Text(
              "今日安排已全部完成",
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: skin.dotGreen,
              ),
            ),
          ],
        ),
      );
    }

    final String? notes = next.notes?.trim();
    return MouseRegion(
      onEnter: (_) {
        if (!_focusHover) setState(() => _focusHover = true);
      },
      onExit: (_) {
        if (_focusHover) setState(() => _focusHover = false);
      },
      child: Container(
        margin: const EdgeInsets.only(top: 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: skin.focusGradient,
          ),
          border: Border.all(
            color: _focusHover ? skin.focusBorderHover : skin.focusBorder,
          ),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: widget.onSchedule,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    "接下来 · ${_countdownLabel(next.startAt, now)}",
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1,
                      color: skin.accentSoft,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: <Widget>[
                      Text(
                        _formatTime(next.startAt),
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          color: skin.focusTime,
                          fontFeatures: const <FontFeature>[
                            FontFeature.tabularFigures(),
                          ],
                        ),
                      ),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          _displayTitle(next),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: skin.bodyText,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (notes != null && notes.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 4),
                    Row(
                      children: <Widget>[
                        Icon(Icons.location_on_outlined,
                            size: 10, color: skin.focusNote),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            notes,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 10, color: skin.focusNote),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 时间轴列表：点线结构，圆点压在竖线上，行高恒定保证对齐。
  Widget _buildTimeline(
    _SchedSkin skin,
    List<ScheduleEvent> items,
    DateTime now,
  ) {
    final ScheduleEvent? next = _nextEvent(items, now);
    final List<ScheduleEvent> visible =
        items.take(_kMaxVisibleEvents).toList();
    final int n = visible.length;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: SizedBox(
        height: n * _kTimelineRowHeight,
        child: Stack(
          children: <Widget>[
            // 竖向点线：从首行圆心连到末行圆心（46.25 = 38 时间列 + 18 节点列一半 - 线宽一半）
            if (n > 1)
              Positioned(
                left: 46.25,
                top: _kTimelineRowHeight / 2,
                width: 1.5,
                height: (n - 1) * _kTimelineRowHeight,
                child: ColoredBox(color: skin.line),
              ),
            Column(
              children: List<Widget>.generate(n, (int i) {
                final ScheduleEvent e = visible[i];
                return _buildTimelineRow(
                  skin,
                  e,
                  passed: !e.startAt.isAfter(now),
                  isNext: identical(e, next),
                );
              }),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTimelineRow(
    _SchedSkin skin,
    ScheduleEvent e, {
    required bool passed,
    required bool isNext,
  }) {
    return SizedBox(
      height: _kTimelineRowHeight,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          hoverColor: skin.rowHover,
          onTap: widget.onSchedule,
          child: Row(
            children: <Widget>[
              SizedBox(
                width: 38,
                child: Text(
                  _formatTime(e.startAt),
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: passed
                        ? skin.dimTime
                        : (isNext ? skin.accent : skin.mutedText),
                    fontFeatures: const <FontFeature>[
                      FontFeature.tabularFigures(),
                    ],
                  ),
                ),
              ),
              SizedBox(
                width: 18,
                child: Center(
                  child: passed
                      ? _buildDoneDot(skin)
                      : _buildEventDot(
                          skin,
                          color: isNext
                              ? skin.accent
                              : _categoryDot(skin, e.startAt.hour),
                          glow: isNext,
                        ),
                ),
              ),
              Expanded(
                child: Text(
                  _displayTitle(e),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight:
                        isNext ? FontWeight.w600 : FontWeight.w400,
                    color: passed
                        ? skin.dimTitle
                        : (isNext ? skin.titleText : skin.bodyText),
                    decoration: passed
                        ? TextDecoration.lineThrough
                        : null,
                    decorationColor: skin.dimStrike,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDoneDot(_SchedSkin skin) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        color: skin.doneDotFill,
        shape: BoxShape.circle,
        border: Border.all(color: skin.doneDotRing, width: 1.5),
      ),
    );
  }

  Widget _buildEventDot(_SchedSkin skin,
      {required Color color, required bool glow}) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: color.withValues(alpha: glow ? 0.35 : 0.18),
            spreadRadius: glow ? 3 : 2.5,
          ),
        ],
      ),
    );
  }

  Widget _buildScheduleFooter(
    _SchedSkin skin,
    List<ScheduleEvent> items,
    DateTime now,
  ) {
    final int hidden = items.length - _kMaxVisibleEvents;
    if (hidden <= 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: widget.onSchedule,
          child: Padding(
            padding:
                const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text.rich(
                  TextSpan(children: <TextSpan>[
                    TextSpan(
                      text: "还有 ",
                      style: TextStyle(
                          fontSize: 10,
                          color: skin.mutedText,
                          fontWeight: FontWeight.w500),
                    ),
                    TextSpan(
                      text: "$hidden",
                      style: TextStyle(
                          fontSize: 10,
                          color: skin.accentSoft,
                          fontWeight: FontWeight.w700),
                    ),
                    TextSpan(
                      text: " 项安排 · 查看全部 ›",
                      style: TextStyle(
                          fontSize: 10,
                          color: skin.mutedText,
                          fontWeight: FontWeight.w500),
                    ),
                  ]),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 空状态：插画式空态 + 一句话引导 + 新建入口。
  Widget _buildEmptySchedule(_SchedSkin skin) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 6),
      child: Column(
        children: <Widget>[
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: skin.chipGradient,
              ),
              border: Border.all(
                  color: skin.accent.withValues(alpha: 0.22)),
            ),
            child: Stack(
              children: <Widget>[
                Positioned(
                  top: 9,
                  left: 10,
                  right: 10,
                  child: Container(
                    height: 6,
                    decoration: BoxDecoration(
                      color: skin.accent.withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                for (final (double dx, double dy) in const <(double, double)>[
                  (10, 20),
                  (27, 20),
                  (10, 29),
                  (27, 29),
                ])
                  Positioned(
                    top: dy,
                    left: dx,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: skin.emptyCell,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            "今天还没有安排",
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: skin.titleText,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            "对我说「明天 9 点提醒我开会」\n我来帮你记录并到点提醒",
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 10,
              height: 1.5,
              color: skin.mutedText,
            ),
          ),
        ],
      ),
    );
  }

  Color _categoryDot(_SchedSkin skin, int hour) {
    if (hour < 10) return skin.dotBlue;
    if (hour < 14) return skin.dotAmber;
    if (hour < 18) return skin.dotGreen;
    return skin.dotGray;
  }

  ScheduleEvent? _nextEvent(List<ScheduleEvent> items, DateTime now) {
    for (final ScheduleEvent e in items) {
      if (e.startAt.isAfter(now)) return e;
    }
    return null;
  }

  String _formatTime(DateTime t) =>
      "${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}";

  String _countdownLabel(DateTime target, DateTime now) {
    final Duration d = target.difference(now);
    if (d.inMinutes < 1) return "马上开始";
    if (d.inHours < 1) return "${d.inMinutes}分钟后";
    final int h = d.inHours;
    final int m = d.inMinutes - h * 60;
    return m == 0 ? "$h小时后" : "$h小时$m分后";
  }

  /// 展示标题：优先 LLM 生成的简洁标题，旧数据回退剥离简化。
  String _displayTitle(ScheduleEvent e) {
    final String? short = e.shortTitle?.trim();
    if (short != null && short.isNotEmpty) return short;
    return simplifyScheduleTitle(e.title);
  }

  // ═══════════════════════════════════════════════════════════
  // 工具区块：单行自适应布局（≤4 个一行，更多时分行），
  // 每个工具带可感知状态（角标 / 副标签），长按或点右上角图标进入编辑模式
  // ═══════════════════════════════════════════════════════════
  List<_ToolSpec> _allToolSpecs() {
    return <_ToolSpec>[
      // 版本闸（开源版剔除内测独占能力）：好友入口不出现
      if (!ApiConfig.isOssEdition) ...[
        _ToolSpec(
            id: "friends",
            icon: Icons.people_outline,
            label: "好友",
            onTap: widget.onAgentLink),
      ],
      // 「手机」工具已删除（2026-10-11）：手机桥接属内测能力，不对外暴露，
      // 入口连同其状态轮询一并移除（落地页 features/phone_devices 保留在仓库里）。
      _ToolSpec(
          id: "messages",
          icon: Icons.message_outlined,
          label: "消息",
          onTap: widget.onMessages,
          badgeCount: widget.messagesUnread),
      _ToolSpec(
          id: "schedule",
          icon: Icons.calendar_today_outlined,
          label: "日程",
          onTap: widget.onSchedule,
          subLabelBuilder: () => _scheduleSubLabel),
      // 图库入口暂时隐藏（功能暂不接入）
      // _ToolSpec(
      //     id: "gallery",
      //     icon: Icons.photo_library_outlined,
      //     label: "图库",
      //     onTap: widget.onGallery),
      _ToolSpec(
          id: "browser",
          icon: Icons.public_outlined,
          label: "浏览器",
          onTap: widget.onBrowser),
    ];
  }

  /// 「日程」副标签：下一条未开始事项的时间；没有则显示空闲
  String? get _scheduleSubLabel {
    final List<ScheduleEvent> events =
        _resolvedScheduleEvents ?? const <ScheduleEvent>[];
    final DateTime now = DateTime.now();
    for (final ScheduleEvent e in events) {
      if (e.startAt.isAfter(now)) {
        return "${e.startAt.hour.toString().padLeft(2, '0')}:"
            "${e.startAt.minute.toString().padLeft(2, '0')}";
      }
    }
    return events.isEmpty ? null : "今日空闲";
  }

  Widget _buildToolsSection(ColorScheme cs) {
    final List<_ToolSpec> allSpecs = _allToolSpecs();
    final List<String> sortedIds = _toolLayout.sortIds(
      allSpecs.map((_ToolSpec s) => s.id).toList(),
    );
    final Map<String, _ToolSpec> specById = <String, _ToolSpec>{
      for (final _ToolSpec s in allSpecs) s.id: s,
    };
    final List<_ToolSpec> visibleSpecs = sortedIds
        .where((String id) => !_toolLayout.isHidden(id))
        .map((String id) => specById[id]!)
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  _editingTools ? "编辑工具" : "常用工具",
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                    letterSpacing: 0.2,
                  ),
                ),
              ),
              _ToolsEditButton(
                editing: _editingTools,
                onTap: () => setState(() => _editingTools = !_editingTools),
                cs: cs,
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        if (_editingTools)
          _ToolsEditorPanel(
            specs: allSpecs,
            layout: _toolLayout,
            onChanged: (RightPanelToolLayout layout) {
              setState(() => _toolLayout = layout);
              unawaited(RightPanelToolPreference.save(layout));
            },
            onDone: () => setState(() => _editingTools = false),
          )
        else if (visibleSpecs.isEmpty)
          // 全部隐藏时的占位：保留编辑入口
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPress: () => setState(() => _editingTools = true),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Text(
                "工具已全部隐藏，点击右上角编辑恢复",
                style: TextStyle(
                  fontSize: 11,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          )
        else
          // 长按工具区任意位置进入编辑模式
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPress: () => setState(() => _editingTools = true),
            child: _buildToolRows(cs, visibleSpecs),
          ),
      ],
    );
  }

  /// 单行自适应：≤4 个一行铺满；超过 4 个时按每行 4 个折行。
  /// 不足 4 个的尾行用空占位补齐，保证每个工具槽位等宽（如第 5 个工具
  /// 单独一行时不应被 Expanded 拉满整行）。
  Widget _buildToolRows(ColorScheme cs, List<_ToolSpec> specs) {
    const int kPerRow = 4;
    final List<List<_ToolSpec>> rows = <List<_ToolSpec>>[
      for (int i = 0; i < specs.length; i += kPerRow)
        specs.sublist(i, min(i + kPerRow, specs.length)),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final List<_ToolSpec> row in rows)
          Row(
            children: <Widget>[
              for (final _ToolSpec spec in row)
                Expanded(child: _ToolButton(spec: spec)),
              for (int i = row.length; i < kPerRow; i += 1)
                const Expanded(child: SizedBox.shrink()),
            ],
          ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════
}

/// 「今日安排」卡片的配色皮肤：深色 / 暖色两套，
/// 与 docs/design/today-schedule-redesign 设计稿一一对应。
class _SchedSkin {
  const _SchedSkin({
    required this.accent,
    required this.accentSoft,
    required this.titleText,
    required this.bodyText,
    required this.mutedText,
    required this.cardFill,
    required this.cardBorder,
    required this.cardShadow,
    required this.track,
    required this.elapsedStart,
    required this.elapsedEnd,
    required this.doneDotFill,
    required this.doneDotRing,
    required this.line,
    required this.dotBlue,
    required this.dotAmber,
    required this.dotGreen,
    required this.dotGray,
    required this.focusGradient,
    required this.focusBorder,
    required this.focusBorderHover,
    required this.focusNote,
    required this.focusTime,
    required this.chipGradient,
    required this.needle,
    required this.needleGlow,
    required this.tickLabel,
    required this.dimTitle,
    required this.dimStrike,
    required this.dimTime,
    required this.rowHover,
    required this.emptyCell,
  });

  final Color accent;
  /// 在浅色底上可读的强调色（暖色主题下比 accent 更深一档；
  /// 深色主题下与 titleText 同为浅白，避免纯黑文字在深底上不可见）。
  final Color accentSoft;
  final Color titleText;
  final Color bodyText;
  final Color mutedText;
  final Color cardFill;
  final Color cardBorder;
  final List<BoxShadow>? cardShadow;
  final Color track;
  final Color elapsedStart;
  final Color elapsedEnd;
  final Color doneDotFill;
  final Color doneDotRing;
  final Color line;
  final Color dotBlue;
  final Color dotAmber;
  final Color dotGreen;
  final Color dotGray;
  final List<Color> focusGradient;
  final Color focusBorder;
  final Color focusBorderHover;
  final Color focusNote;
  final Color focusTime;
  final List<Color> chipGradient;
  final Color needle;
  final Color needleGlow;
  final Color tickLabel;
  final Color dimTitle;
  final Color dimStrike;
  final Color dimTime;
  final Color rowHover;
  final Color emptyCell;

  static _SchedSkin of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? _dark : _warm;

  static final _SchedSkin _dark = _SchedSkin(
    // 深色皮肤强调色对齐 titleText 浅白（原纯黑在深底上不可见）
    accent: const Color(0xFFE8E8E8),
    accentSoft: const Color(0xFFE8E8E8),
    titleText: const Color(0xFFE8E8E8),
    bodyText: const Color(0xFFDEDEDE),
    mutedText: const Color(0xFF989898),
    // 卡底：surfaceContainer #1C1C1C 上叠白 10% → 渲染 #333333 浅灰
    cardFill: const Color(0x1AFFFFFF),
    cardBorder: const Color(0x12FFFFFF),
    cardShadow: null,
    track: const Color(0x12FFFFFF),
    elapsedStart: const Color(0x1AFFFFFF),
    elapsedEnd: const Color(0x59A3A3A3),
    doneDotFill: const Color(0xFF3A3D42),
    doneDotRing: const Color(0xFF6B7076),
    line: const Color(0x17FFFFFF),
    dotBlue: const Color(0xFF5B8DEF),
    dotAmber: const Color(0xFFF2B94B),
    dotGreen: const Color(0xFF2FAE84),
    dotGray: const Color(0xFF8A8F96),
    // 焦点卡：新卡底 #333333 上叠白 8%→4% → 渲染 #434343→#3B3B3B（略亮于卡底）
    focusGradient: const <Color>[Color(0x14FFFFFF), Color(0x0AFFFFFF)],
    focusBorder: const Color(0x33FFFFFF),
    focusBorderHover: const Color(0x59FFFFFF),
    focusNote: const Color(0xFF8FA6AD),
    focusTime: const Color(0xFFEAFDFF),
    chipGradient: const <Color>[Color(0x38A3A3A3), Color(0x2EA3A3A3)],
    needle: const Color(0xFFF2F5F9),
    needleGlow: const Color(0xE6000000),
    tickLabel: const Color(0xFF55595F),
    dimTitle: const Color(0xFF5C6066),
    dimStrike: const Color(0x38FFFFFF),
    dimTime: const Color(0xFF4E5157),
    rowHover: const Color(0x0BFFFFFF),
    emptyCell: const Color(0x2EFFFFFF),
  );

  static final _SchedSkin _warm = _SchedSkin(
    accent: const Color(0xFFB98B43),
    accentSoft: const Color(0xFFA8792F),
    titleText: const Color(0xFF232833),
    bodyText: const Color(0xFF232833),
    mutedText: const Color(0xFF98A2B3),
    cardFill: const Color(0xFFFFFFFF),
    cardBorder: const Color(0xFFDCE3EC),
    cardShadow: const <BoxShadow>[
      BoxShadow(
          color: Color(0x0D101828),
          offset: Offset(0, 1),
          blurRadius: 3),
    ],
    track: const Color(0xFFE8EDF4),
    elapsedStart: const Color(0xFFE1E7F0),
    elapsedEnd: const Color(0x4DB98B43),
    doneDotFill: const Color(0xFFDDE3EC),
    doneDotRing: const Color(0xFFAEB8C6),
    line: const Color(0x14232833),
    dotBlue: const Color(0xFF5B8DEF),
    dotAmber: const Color(0xFFC08A2D),
    dotGreen: const Color(0xFF2FAE84),
    dotGray: const Color(0xFF98A2B3),
    focusGradient: const <Color>[Color(0x1AB98B43), Color(0x0D5B8DEF)],
    focusBorder: const Color(0x59B98B43),
    focusBorderHover: const Color(0x8CB98B43),
    focusNote: const Color(0xFF8A94A6),
    focusTime: const Color(0xFF232833),
    chipGradient: const <Color>[Color(0x29B98B43), Color(0x1A5B8DEF)],
    needle: const Color(0xFF232833),
    needleGlow: const Color(0xCCB98B43),
    tickLabel: const Color(0xFF98A2B3),
    dimTitle: const Color(0xFF98A2B3),
    dimStrike: const Color(0x40232833),
    dimTime: const Color(0xFFB3BCC9),
    rowHover: const Color(0xFFF0F4F9),
    emptyCell: const Color(0x38232833),
  );
}

class _ToolSpec {
  _ToolSpec({
    required this.id,
    required this.icon,
    required this.label,
    this.onTap,
    this.badgeCount,
    String? Function()? subLabelBuilder,
  }) : _subLabelBuilder = subLabelBuilder;

  final String id;
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  /// 未读等数字角标（null/0 不显示）
  final int? badgeCount;
  final String? Function()? _subLabelBuilder;

  /// 副标签（如「14:30」「2/1 在线」），null 不显示
  String? get subLabel => _subLabelBuilder?.call();
}

/// 「常用工具」标题右侧的编辑入口（铅笔 / 完成）
class _ToolsEditButton extends StatelessWidget {
  const _ToolsEditButton({
    required this.editing,
    required this.onTap,
    required this.cs,
  });

  final bool editing;
  final VoidCallback onTap;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: editing ? "完成" : "编辑工具",
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(4),
            child: Icon(
              editing ? Icons.check_rounded : Icons.tune,
              size: 14,
              color: editing ? cs.primary : cs.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}

/// 编辑模式面板：拖拽排序 + 显隐切换，变更即时持久化。
class _ToolsEditorPanel extends StatelessWidget {
  const _ToolsEditorPanel({
    required this.specs,
    required this.layout,
    required this.onChanged,
    required this.onDone,
  });

  /// 全量工具（含已隐藏的），编辑始终操作全集
  final List<_ToolSpec> specs;
  final RightPanelToolLayout layout;
  final ValueChanged<RightPanelToolLayout> onChanged;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<String> sortedIds = layout.sortIds(
      specs.map((_ToolSpec s) => s.id).toList(),
    );
    final Map<String, _ToolSpec> specById = <String, _ToolSpec>{
      for (final _ToolSpec s in specs) s.id: s,
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        ReorderableListView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          buildDefaultDragHandles: false,
          itemCount: sortedIds.length,
          onReorderItem: (int oldIndex, int newIndex) {
            final List<String> next = List<String>.from(sortedIds);
            final String moved = next.removeAt(oldIndex);
            next.insert(newIndex, moved);
            onChanged(layout.copyWith(order: next));
          },
          proxyDecorator: (Widget child, int index, Animation<double> anim) {
            return AnimatedBuilder(
              animation: anim,
              builder: (BuildContext context, Widget? w) => Material(
                color: cs.surfaceContainerHigh.withValues(
                  alpha: 0.6 + 0.4 * anim.value,
                ),
                borderRadius: BorderRadius.circular(8),
                elevation: 0,
                child: w,
              ),
              child: child,
            );
          },
          itemBuilder: (BuildContext context, int index) {
            final String id = sortedIds[index];
            final _ToolSpec spec = specById[id]!;
            final bool hidden = layout.isHidden(id);
            return ReorderableDragStartListener(
              key: ValueKey<String>(id),
              index: index,
              child: Row(
                children: <Widget>[
                  Icon(Icons.drag_indicator,
                      size: 16, color: cs.onSurfaceVariant),
                  const SizedBox(width: 4),
                  Icon(spec.icon,
                      size: 15,
                      color: hidden
                          ? cs.onSurfaceVariant.withValues(alpha: 0.4)
                          : cs.onSurfaceVariant),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      spec.label,
                      style: TextStyle(
                        fontSize: 12,
                        color: hidden
                            ? cs.onSurface.withValues(alpha: 0.4)
                            : cs.onSurface,
                      ),
                    ),
                  ),
                  // 显隐切换
                  Material(
                    color: Colors.transparent,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(999),
                      onTap: () {
                        final List<String> nextHidden =
                            List<String>.from(layout.hidden);
                        if (hidden) {
                          nextHidden.remove(id);
                        } else {
                          nextHidden.add(id);
                        }
                        onChanged(layout.copyWith(hidden: nextHidden));
                      },
                      child: Padding(
                        padding: const EdgeInsets.all(5),
                        child: Icon(
                          hidden
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined,
                          size: 15,
                          color: hidden
                              ? cs.onSurfaceVariant.withValues(alpha: 0.5)
                              : cs.primary,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(999),
              onTap: onDone,
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                child: Text(
                  "完成",
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: cs.primary,
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _ToolButton extends StatefulWidget {
  const _ToolButton({required this.spec});

  final _ToolSpec spec;

  @override
  State<_ToolButton> createState() => _ToolButtonState();
}

class _ToolButtonState extends State<_ToolButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final _ToolSpec spec = widget.spec;
    final String? subLabel = spec.subLabel;
    final bool active = _hovering;
    final Color fg =
        active ? cs.onSurface : cs.onSurfaceVariant;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      cursor: SystemMouseCursors.click,
      child: Tooltip(
        message: subLabel == null ? spec.label : "${spec.label} · $subLabel",
        waitDuration: const Duration(milliseconds: 500),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => spec.onTap?.call(),
            child: AnimatedScale(
              duration: const Duration(milliseconds: 160),
              curve: Curves.easeOut,
              scale: _hovering ? 1.06 : 1.0,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: <Widget>[
                    // 图标 + 数字角标
                    Stack(
                      clipBehavior: Clip.none,
                      children: <Widget>[
                        Icon(spec.icon, size: 18, color: fg),
                        if (spec.badgeCount != null && spec.badgeCount! > 0)
                          Positioned(
                            top: -5,
                            right: -9,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 3.5, vertical: 1),
                              constraints:
                                  const BoxConstraints(minWidth: 13),
                              decoration: BoxDecoration(
                                color: cs.error,
                                borderRadius: BorderRadius.circular(999),
                              ),
                              alignment: Alignment.center,
                              child: Text(
                                spec.badgeCount! > 99
                                    ? "99+"
                                    : "${spec.badgeCount}",
                                style: const TextStyle(
                                  fontSize: 8,
                                  height: 1.2,
                                  fontWeight: FontWeight.w700,
                                  color: Colors.white,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      spec.label,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w500,
                        color: fg,
                      ),
                    ),
                    // 副标签：可感知状态（下一条日程时间 / 在线设备数）
                    if (subLabel != null) ...<Widget>[
                      const SizedBox(height: 1),
                      Text(
                        subLabel,
                        style: TextStyle(
                          fontSize: 9,
                          height: 1.2,
                          fontWeight: FontWeight.w500,
                          color: cs.onSurfaceVariant.withValues(alpha: 0.75),
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
