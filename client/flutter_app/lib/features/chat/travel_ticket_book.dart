part of "travel_plan_archive.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程 · 票根册（方案 A）
//
// 往期是纸：年份 + 月份的时间脊椎，最新一段是大票，其余两列紧凑票；
// 票身是真缺口（ClipPath 挖出来，不画假圆点）、撕线、印章、胶带、条形码。
// 即将出发是光：最近一段给完整数字登机牌，其余退成 64 高日期行。
//
// 尺寸刻意压小：大票 150 高、次票 112 高，照片窗 80~128 宽，列表不会
// 因为票根而过长。照片按显示宽度的 4 倍解码 + high 过滤，无图走等高线兜底。
// ═══════════════════════════════════════════════════════════════════

const double _kLedgerMaxWidth = 960;
const double _kUpcomingMaxWidth = 880;
const double _kTicketFeaturedH = 150;
const double _kTicketCompactH = 112;
const double _kTicketDigitalH = 150;
const double _kUpcomingRowH = 64;

/// 当前 tab 的行程列表：即将出发走主票 + 日期行，往期走票根册。
class _RailList extends StatelessWidget {
  const _RailList({
    required this.colors,
    required this.plans,
    required this.seg,
    required this.hasLive,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
  });

  final _StageColors colors;
  final List<_PlanSummary> plans;

  /// 0 即将出发 / 1 往期。
  final int seg;

  /// 是否有在途行程（决定「即将出发」空态文案）。
  final bool hasLive;
  final ValueChanged<_PlanSummary> onOpen;
  final ValueChanged<_PlanSummary> onShare;
  final ValueChanged<_PlanSummary> onDelete;

  String get _emptyHint {
    if (seg == 1) return "还没有往期行程\n走完的旅行会自动归档到这里";
    if (hasLive) return "这段走完，下一段从哪儿开始？\n在「规划」里说一句，就能生成下一段行程";
    return "还没有即将出发的行程\n在「规划」里说一句，行程会提前出现在这里";
  }

  @override
  Widget build(BuildContext context) {
    final bool paper = seg == 1;
    final int bucket = paper ? 2 : 1;
    final List<_PlanSummary> items = <_PlanSummary>[
      for (final _PlanSummary s in plans)
        if (s.bucket == bucket) s,
    ];
    if (items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Text(
            _emptyHint,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, height: 1.8, color: colors.muted),
          ),
        ),
      );
    }
    if (paper) {
      items.sort((_PlanSummary a, _PlanSummary b) =>
          _summaryDate(b).compareTo(_summaryDate(a)));
    } else {
      items.sort((_PlanSummary a, _PlanSummary b) =>
          _upcomingSortKey(a).compareTo(_upcomingSortKey(b)));
    }

    final bool warm = AppThemeController.instance.value == AppThemeVariant.warm;
    final _TicketSkin skin =
        paper ? _TicketSkin.paper(warm) : _TicketSkin.digital(warm);

    return MediaQuery.withClampedTextScaling(
      minScaleFactor: 1.0,
      maxScaleFactor: 1.06,
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(paper ? 18 : 16, 4, paper ? 18 : 16, 28),
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
                maxWidth: paper ? _kLedgerMaxWidth : _kUpcomingMaxWidth),
            child: paper
                ? _buildLedger(items, skin)
                : _buildUpcoming(items, skin),
          ),
        ),
      ),
    );
  }

  /// 最近一段给完整票面，其余退成 64 高日期行（一屏只给一张主票）。
  Widget _buildUpcoming(List<_PlanSummary> items, _TicketSkin skin) {
    final _PlanSummary hero = items.first;
    final List<_PlanSummary> rest = items.sublist(1);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: 14),
        _TicketCard(
          colors: colors,
          skin: skin,
          summary: hero,
          featured: true,
          digital: true,
          tilt: 0,
          onOpen: () => onOpen(hero),
          onShare: () => onShare(hero),
          onDelete: () => onDelete(hero),
        ),
        if (rest.isNotEmpty) ...<Widget>[
          const SizedBox(height: 14),
          DecoratedBox(
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: colors.borderSoft)),
            ),
            child: Column(
              children: <Widget>[
                for (final _PlanSummary s in rest)
                  _UpcomingRow(
                    colors: colors,
                    summary: s,
                    onTap: () => onOpen(s),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildLedger(List<_PlanSummary> items, _TicketSkin skin) {
    final Map<int, Map<int, List<_PlanSummary>>> grouped =
        <int, Map<int, List<_PlanSummary>>>{};
    for (final _PlanSummary s in items) {
      final DateTime d = _summaryDate(s);
      grouped
          .putIfAbsent(d.year, () => <int, List<_PlanSummary>>{})
          .putIfAbsent(d.month, () => <_PlanSummary>[])
          .add(s);
    }
    final List<int> years = grouped.keys.toList()..sort((int a, int b) => b.compareTo(a));
    final List<Widget> rows = <Widget>[];
    bool featuredUsed = false;
    for (int yi = 0; yi < years.length; yi++) {
      final int year = years[yi];
      final List<int> months = grouped[year]!.keys.toList()
        ..sort((int a, int b) => b.compareTo(a));
      final List<_PlanSummary> yearItems = <_PlanSummary>[
        for (final int m in months) ...grouped[year]![m]!,
      ];
      rows.add(yi == 0
          ? _LedgerHead(colors: colors, year: year, items: yearItems)
          : _YearDivider(colors: colors, year: year, items: yearItems));
      for (int mi = 0; mi < months.length; mi++) {
        final int month = months[mi];
        final List<_PlanSummary> monthItems = grouped[year]![month]!;
        final bool featuredFirst = !featuredUsed;
        if (featuredFirst) featuredUsed = true;
        rows.add(_MonthRow(
          colors: colors,
          skin: skin,
          month: month,
          items: monthItems,
          featuredFirst: featuredFirst,
          last: yi == years.length - 1 && mi == months.length - 1,
          onOpen: onOpen,
          onShare: onShare,
          onDelete: onDelete,
        ));
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: rows,
    );
  }
}

// ── 即将出发 · 64 高日期行 ─────────────────────────────────────────

int _upcomingSortKey(_PlanSummary s) {
  final DateTime? start = DateTime.tryParse(s.startDate.trim());
  return start?.millisecondsSinceEpoch ?? s.createdAt;
}

/// 非主票的即将出发条目：日期 + 城市链 + 倒计时，一行 64 高。
class _UpcomingRow extends StatelessWidget {
  const _UpcomingRow({
    required this.colors,
    required this.summary,
    required this.onTap,
  });

  final _StageColors colors;
  final _PlanSummary summary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final String iso =
        summary.startDate.isNotEmpty ? summary.startDate : summary.endDate;
    final String date = _mmddOf(iso);
    final String weekday = _weekdayOf(iso);
    final String route = summary.listTitle;
    final List<String> chain = _chainOf(summary);
    final int? days = summary.daysUntilStart;
    final String num = days == null
        ? "—"
        : days <= 0
            ? "今天"
            : days == 1
                ? "明天"
                : "$days";
    final String unit = days == null
        ? "待定"
        : days <= 1
            ? "出发"
            : "天后";

    return _HoverTicket(
      tilt: 0,
      onTap: onTap,
      child: Container(
        height: _kUpcomingRowH,
        padding: const EdgeInsets.symmetric(horizontal: 4),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: colors.borderSoft)),
        ),
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 72,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    date,
                    style: TextStyle(
                      fontFamily: _kFontFamily,
                      fontFamilyFallback: _kFontFallback,
                      fontSize: 13,
                      height: 1.1,
                      fontWeight: FontWeight.w600,
                      color: colors.text,
                      fontFeatures: const <FontFeature>[
                        FontFeature.tabularFigures()
                      ],
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(weekday,
                      style: _monoStyle(7.5, colors.muted, spacing: 1)),
                ],
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _routeText(route, chain),
                  const SizedBox(height: 3),
                  _metaText(chain.length),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  num,
                  style: TextStyle(
                    fontFamily: _kFontFamily,
                    fontFamilyFallback: _kFontFallback,
                    fontSize: 14,
                    height: 1,
                    fontWeight: FontWeight.w600,
                    color: colors.orange,
                    fontFeatures: const <FontFeature>[
                      FontFeature.tabularFigures()
                    ],
                  ),
                ),
                const SizedBox(height: 3),
                Text(unit,
                    style: _monoStyle(7, colors.muted, spacing: 1.2)),
              ],
            ),
            const SizedBox(width: 12),
            Icon(Icons.chevron_right_rounded, size: 15, color: colors.muted),
          ],
        ),
      ),
    );
  }

  /// 多城行程整条路线写全（「上海 → 西安 → 洛阳」），箭头压灰。
  Widget _routeText(String route, List<String> chain) {
    final TextStyle base = TextStyle(
      fontFamily: _kFontFamily,
      fontFamilyFallback: _kFontFallback,
      fontSize: 12,
      height: 1.2,
      fontWeight: FontWeight.w600,
      color: colors.text,
    );
    if (chain.length <= 1) {
      return Text(
        route.isEmpty ? "行程安排" : route,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: base,
      );
    }
    return Text.rich(
      TextSpan(
        style: base,
        children: <InlineSpan>[
          for (int i = 0; i < chain.length; i++) ...<InlineSpan>[
            if (i > 0)
              TextSpan(
                text: " → ",
                style: base.copyWith(
                    color: colors.muted, fontWeight: FontWeight.w400),
              ),
            TextSpan(text: chain[i]),
          ],
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }

  Widget _metaText(int cities) {
    final String stay = _stayLabel(summary);
    final List<String> parts = <String>[
      if (cities > 1) "$cities 城",
      if (stay.isNotEmpty) stay,
      if (summary.stopCount > 0) "${summary.stopCount} 站",
    ];
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          for (int i = 0; i < parts.length; i++) ...<InlineSpan>[
            if (i > 0)
              TextSpan(text: " · ", style: TextStyle(color: colors.muted)),
            TextSpan(
              text: parts[i],
              style: TextStyle(
                color: i == 0 && cities > 1 ? colors.text2 : colors.muted,
                fontWeight:
                    i == 0 && cities > 1 ? FontWeight.w500 : FontWeight.w400,
              ),
            ),
          ],
        ],
        style: TextStyle(
          fontFamily: _kFontFamily,
          fontFamilyFallback: _kFontFallback,
          fontSize: 9,
          height: 1.2,
        ),
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }
}

// ── 年份抬头 / 年份分隔 ─────────────────────────────────────────────

class _LedgerHead extends StatelessWidget {
  const _LedgerHead({
    required this.colors,
    required this.year,
    required this.items,
  });

  final _StageColors colors;
  final int year;
  final List<_PlanSummary> items;

  @override
  Widget build(BuildContext context) {
    final int days =
        items.fold<int>(0, (int a, _PlanSummary s) => a + s.dayCount);
    final int stops =
        items.fold<int>(0, (int a, _PlanSummary s) => a + s.stopCount);
    final Widget stats = Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _LedgerStat(colors: colors, value: "${items.length}", label: "段旅程"),
        _LedgerStat(colors: colors, value: "$days", label: "天"),
        _LedgerStat(colors: colors, value: "$stops", label: "个地点"),
      ],
    );
    final Widget title = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text("TRAVEL LEDGER · 旅行档案",
            style: _monoStyle(7.5, colors.muted, spacing: 2.0)),
        const SizedBox(height: 3),
        Text(
          "$year",
          style: TextStyle(
            fontFamily: _kFontFamily,
            fontFamilyFallback: _kFontFallback,
            fontSize: 30,
            height: 1.05,
            fontWeight: FontWeight.w700,
            letterSpacing: .6,
            color: colors.text,
            fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 12, 2, 12),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints cons) {
          if (cons.maxWidth < 520) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[title, const SizedBox(height: 10), stats],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[title, const Spacer(), stats],
          );
        },
      ),
    );
  }
}

class _LedgerStat extends StatelessWidget {
  const _LedgerStat({
    required this.colors,
    required this.value,
    required this.label,
  });

  final _StageColors colors;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.only(left: 14),
      margin: const EdgeInsets.only(left: 14),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: colors.borderSoft)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            value,
            style: TextStyle(
              fontFamily: _kFontFamily,
              fontFamilyFallback: _kFontFallback,
              fontSize: 16,
              height: 1.1,
              fontWeight: FontWeight.w600,
              color: colors.text,
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 3),
          Text(label, style: _monoStyle(7.5, colors.muted, spacing: 1.2)),
        ],
      ),
    );
  }
}

class _YearDivider extends StatelessWidget {
  const _YearDivider({
    required this.colors,
    required this.year,
    required this.items,
  });

  final _StageColors colors;
  final int year;
  final List<_PlanSummary> items;

  @override
  Widget build(BuildContext context) {
    final int days =
        items.fold<int>(0, (int a, _PlanSummary s) => a + s.dayCount);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 22, 2, 12),
      child: Row(
        children: <Widget>[
          Text(
            "$year",
            style: TextStyle(
              fontFamily: _kFontFamily,
              fontFamilyFallback: _kFontFallback,
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: colors.text2,
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(child: Container(height: 1, color: colors.borderSoft)),
          const SizedBox(width: 12),
          Text(
            "${items.length} 段 · $days 天",
            style: _monoStyle(7.5, colors.muted, spacing: 1.2),
          ),
        ],
      ),
    );
  }
}

// ── 月份行：左侧时间脊椎 ───────────────────────────────────────────

class _MonthRow extends StatelessWidget {
  const _MonthRow({
    required this.colors,
    required this.skin,
    required this.month,
    required this.items,
    required this.featuredFirst,
    required this.last,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
  });

  final _StageColors colors;
  final _TicketSkin skin;
  final int month;
  final List<_PlanSummary> items;
  final bool featuredFirst;
  final bool last;
  final ValueChanged<_PlanSummary> onOpen;
  final ValueChanged<_PlanSummary> onShare;
  final ValueChanged<_PlanSummary> onDelete;

  @override
  Widget build(BuildContext context) {
    final List<_PlanSummary> rest =
        featuredFirst ? items.sublist(1) : items;
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 20),
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          // 虚线时间轴（穿过月份孔，续到下一行）
          Positioned(
            left: 65,
            top: 26,
            bottom: last ? 0 : -36,
            width: 1,
            child: CustomPaint(
              painter: _DashedLinePainter(
                color: colors.borderSoft,
                dash: 3,
                gap: 4,
              ),
            ),
          ),
          // 月份孔：用页面底色挖出 + 4px 同色环
          Positioned(
            left: 60.5,
            top: 15,
            child: Container(
              width: 9,
              height: 9,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: colors.side,
                border: Border.all(color: colors.border, width: 1.5),
                boxShadow: <BoxShadow>[
                  BoxShadow(color: colors.side, spreadRadius: 3.5),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            top: 10,
            width: 54,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  "$month月",
                  style: TextStyle(
                    fontFamily: _kFontFamily,
                    fontFamilyFallback: _kFontFallback,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: colors.text2,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _monthEn(month),
                  style: _monoStyle(7, colors.muted, spacing: 1.4),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 74),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (featuredFirst)
                  _TicketCard(
                    colors: colors,
                    skin: skin,
                    summary: items.first,
                    featured: true,
                    digital: false,
                    tilt: -0.006,
                    onOpen: () => onOpen(items.first),
                    onShare: () => onShare(items.first),
                    onDelete: () => onDelete(items.first),
                  ),
                if (rest.isNotEmpty && featuredFirst) const SizedBox(height: 12),
                if (rest.isNotEmpty)
                  LayoutBuilder(
                    builder: (BuildContext context, BoxConstraints cons) {
                      final int cols = cons.maxWidth >= 660 ? 2 : 1;
                      final double w =
                          (cons.maxWidth - (cols - 1) * 14) / cols;
                      return Wrap(
                        spacing: 14,
                        runSpacing: 14,
                        children: <Widget>[
                          for (int i = 0; i < rest.length; i++)
                            SizedBox(
                              width: w,
                              child: _TicketCard(
                                colors: colors,
                                skin: skin,
                                summary: rest[i],
                                featured: false,
                                digital: false,
                                tilt: (i.isEven ? -1 : 1) * 0.0073,
                                onOpen: () => onOpen(rest[i]),
                                onShare: () => onShare(rest[i]),
                                onDelete: () => onDelete(rest[i]),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── 票根本体 ──────────────────────────────────────────────────────

class _TicketCard extends StatelessWidget {
  const _TicketCard({
    required this.colors,
    required this.skin,
    required this.summary,
    required this.featured,
    required this.digital,
    required this.tilt,
    required this.onOpen,
    required this.onShare,
    required this.onDelete,
  });

  final _StageColors colors;
  final _TicketSkin skin;
  final _PlanSummary summary;
  final bool featured;
  final bool digital;
  final double tilt;
  final VoidCallback onOpen;
  final VoidCallback onShare;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final String name = summary.destination.isNotEmpty
        ? summary.destination
        : summary.displayTitle;
    final String ticketNo = _ticketNoOf(summary.planId);
    return Semantics(
      button: true,
      label: "打开行程 $name",
      child: _HoverTicket(
        tilt: tilt,
        onTap: onOpen,
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints cons) {
            // 窄窗下大票降级为紧凑票，避免照片窗把正文挤没
            final bool wide = featured && cons.maxWidth >= 470;
            final double height = digital
                ? _kTicketDigitalH
                : wide
                    ? _kTicketFeaturedH
                    : _kTicketCompactH;
            final double photoW = digital
                ? 128
                : wide
                    ? 128
                    : 80;
            final double stubW = digital
                ? 88
                : wide
                    ? 82
                    : 64;
            final double notch = wide || digital ? 8 : 7;
            final double stampSize = wide ? 56 : 46;
            return Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                _TicketShell(
                  stubWidth: stubW,
                  notch: notch,
                  radius: 12,
                  skin: skin,
                  child: SizedBox(
                    height: height,
                    width: double.infinity,
                    child: ColoredBox(
                      color: skin.paper,
                      child: Stack(
                        children: <Widget>[
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: <Widget>[
                              SizedBox(
                                width: photoW,
                                child: _TicketPhoto(
                                  url: summary.coverImage.isEmpty
                                      ? ""
                                      : resolveTravelMediaUrl(
                                          summary.coverImage),
                                  skin: skin,
                                  digital: digital,
                                  photoWidth: photoW,
                                  destination: name,
                                  cap: digital && summary.bucket == 0
                                      ? "$name · LIVE"
                                      : _coverCaption(summary),
                                ),
                              ),
                              Expanded(
                                child: digital
                                    ? _digitalBody(name, ticketNo)
                                    : _paperBody(name, ticketNo, wide),
                              ),
                              SizedBox(
                                width: stubW,
                                child: digital
                                    ? _digitalStub(ticketNo)
                                    : _paperStub(ticketNo, wide),
                              ),
                            ],
                          ),
                          if (digital)
                            Positioned(
                              left: 0,
                              right: 0,
                              top: 0,
                              height: 3,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  gradient: LinearGradient(colors: <Color>[
                                    colors.accent,
                                    colors.green,
                                  ]),
                                ),
                              ),
                            ),
                          if (!digital)
                            Positioned(
                              right: stubW - stampSize / 2,
                              top: 0,
                              bottom: 0,
                              child: Center(
                                child: _TicketStamp(
                                  skin: skin,
                                  size: stampSize,
                                  date: _stampDate(summary),
                                ),
                              ),
                            ),
                          if (digital)
                            Positioned(
                              right: stubW - 25,
                              top: 0,
                              bottom: 0,
                              child: Center(
                                child: _TicketStamp(
                                  skin: skin,
                                  size: 50,
                                  date: _mmddOf(summary.startDate).isEmpty
                                      ? _stampDate(summary)
                                      : _mmddOf(summary.startDate),
                                  label: "待出发",
                                  color: colors.orange,
                                ),
                              ),
                            ),
                          Positioned.fill(
                            child: IgnorePointer(
                              child: CustomPaint(
                                painter: _GrainPainter(color: skin.grain),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (!digital && wide)
                  Positioned(
                    top: -9,
                    left: 0,
                    right: 0,
                    child: Align(
                      alignment: const Alignment(-0.14, 0),
                      child: _TicketTape(skin: skin),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _paperBody(String name, String ticketNo, bool wide) {
    final String start = _mmddOf(summary.startDate);
    final String end = _mmddOf(summary.endDate);
    final String dateText = start.isEmpty && end.isEmpty
        ? "—"
        : (end.isEmpty || start == end)
            ? start
            : "$start – $end";
    final String sub = _stayLabel(summary);
    final String archived = summary.endDate.isNotEmpty
        ? _ymdOf(summary.endDate)
        : _ymdOf(summary.startDate);
    return Padding(
      padding: EdgeInsets.fromLTRB(wide ? 14 : 11, wide ? 10 : 8,
          wide ? 12 : 10, wide ? 9 : 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            height: 20,
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    "BOARDING PASS",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _monoStyle(7.2, skin.muted, spacing: 1.5),
                  ),
                ),
                Text(ticketNo,
                    style: _monoStyle(7.2, skin.ink2,
                        spacing: 1.2, weight: FontWeight.w600)),
                const SizedBox(width: 1),
                _CardMenu(
                  colors: colors,
                  onShare: onShare,
                  onDelete: onDelete,
                  foreground: skin.muted,
                  iconSize: 13,
                  boxSize: 20,
                ),
              ],
            ),
          ),
          SizedBox(height: wide ? 7 : 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Flexible(
                flex: 3,
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: _kFontFamily,
                    fontFamilyFallback: _kFontFallback,
                    fontSize: wide ? 24 : 19,
                    height: 1,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .3,
                    color: skin.ink,
                  ),
                ),
              ),
              if (sub.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Flexible(
                  flex: 2,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Text(
                      sub,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: _kFontFamily,
                        fontFamilyFallback: _kFontFallback,
                        fontSize: wide ? 9.5 : 8.5,
                        height: 1.1,
                        color: skin.muted,
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
          SizedBox(height: wide ? 8 : 7),
          Row(
            children: <Widget>[
              _TicketField(
                  skin: skin,
                  label: "DATE",
                  value: dateText,
                  size: wide ? 11 : 10),
              SizedBox(width: wide ? 20 : 12),
              _TicketField(
                  skin: skin,
                  label: "BUDGET",
                  value: summary.costLabel ?? "—",
                  size: wide ? 11 : 10),
              if (wide && summary.stopCount > 0) ...<Widget>[
                const SizedBox(width: 20),
                _TicketField(
                    skin: skin,
                    label: "STOPS",
                    value: "${summary.stopCount} 站",
                    size: 11),
              ],
              const Spacer(),
            ],
          ),
          const Spacer(),
          if (wide) ...<Widget>[
            _RouteRail(skin: skin, summary: summary),
            const SizedBox(height: 7),
          ],
          _ArchiveFoot(
            skin: skin,
            compact: !wide,
            archived: archived,
          ),
        ],
      ),
    );
  }

  /// 主票票面：BOARDING 章 + 城市链 + 出发/返程 + 站点轨道。
  Widget _digitalBody(String name, String ticketNo) {
    final List<String> chain = _chainOf(summary);
    final bool multi = chain.length > 1;
    final String sub = <String>[
      if (_stayLabel(summary).isNotEmpty) _stayLabel(summary),
      if (summary.stopCount > 0) "${summary.stopCount} 站",
    ].join(" · ");
    final String start = _dateFieldOf(summary.startDate);
    final String end = _dateFieldOf(summary.endDate);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            height: 20,
            child: Row(
              children: <Widget>[
                _TripChip(
                  color: colors.orange,
                  label:
                      "BOARDING · ${summary.countdownLabel.isEmpty ? "即将出发" : summary.countdownLabel}",
                ),
                const Spacer(),
                Text(ticketNo,
                    style: _monoStyle(7, skin.ink2,
                        spacing: 1.2, weight: FontWeight.w600)),
                const SizedBox(width: 1),
                _CardMenu(
                  colors: colors,
                  onShare: onShare,
                  onDelete: onDelete,
                  foreground: skin.muted,
                  iconSize: 13,
                  boxSize: 20,
                ),
              ],
            ),
          ),
          const SizedBox(height: 9),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Flexible(
                flex: 3,
                child: Text.rich(
                  TextSpan(
                    children: <InlineSpan>[
                      for (int i = 0; i < (multi ? chain.length : 1); i++)
                        if (i == 0)
                          TextSpan(text: multi ? chain[i] : name)
                        else ...<InlineSpan>[
                          TextSpan(
                            text: " → ",
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w400,
                              color: skin.muted,
                            ),
                          ),
                          TextSpan(text: chain[i]),
                        ],
                    ],
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: _kFontFamily,
                    fontFamilyFallback: _kFontFallback,
                    fontSize: multi ? 19 : 24,
                    height: 1.15,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .3,
                    color: skin.ink,
                  ),
                ),
              ),
              if (sub.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Flexible(
                  flex: 2,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Text(
                      sub,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: _kFontFamily,
                        fontFamilyFallback: _kFontFallback,
                        fontSize: 9.5,
                        height: 1.1,
                        color: skin.muted,
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
          const Spacer(),
          Row(
            children: <Widget>[
              _TicketField(
                skin: skin,
                label: "DEPART",
                value: start.isEmpty ? "—" : start,
                size: 11,
              ),
              const SizedBox(width: 24),
              _TicketField(
                skin: skin,
                label: "RETURN",
                value: end.isEmpty ? "—" : end,
                size: 11,
              ),
            ],
          ),
          const SizedBox(height: 10),
          _routeTrack(),
        ],
      ),
    );
  }

  /// 站点轨道：虚线上按站点数等距排点，最后一站实心。
  Widget _routeTrack() {
    final int dots = summary.stopCount.clamp(2, 6).toInt();
    return SizedBox(
      height: 8,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          Positioned.fill(
            child: CustomPaint(painter: _DashTrackPainter(color: skin.line)),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              for (int i = 0; i < dots; i++)
                Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: i == dots - 1 ? skin.ink2 : skin.paper,
                    border: Border.all(
                      color: i == dots - 1
                          ? skin.ink2
                          : skin.ink2.withValues(alpha: .55),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _paperStub(String ticketNo, bool wide) {
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[skin.paper, skin.paperEdge],
        ),
      ),
      child: Stack(
        children: <Widget>[
          if (wide)
            Positioned(
              right: 2,
              top: 0,
              bottom: 0,
              child: Center(
                child: RotatedBox(
                  quarterTurns: 1,
                  child: Text(
                    "NEXTBOT · ARCHIVE",
                    style: _monoStyle(5, skin.muted.withValues(alpha: .7),
                        spacing: 2.2),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 0,
            top: 9,
            bottom: 9,
            width: 1.2,
            child: CustomPaint(
              painter: _DashedLinePainter(
                  color: skin.line, dash: 3, gap: 3),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 8, 6, 7),
            child: Column(
              children: <Widget>[
                Text("ADMIT ONE",
                    style: _monoStyle(5.8, skin.muted, spacing: 1.4)),
                const Spacer(),
                SizedBox(
                  width: wide ? 40 : 32,
                  height: wide ? 16 : 13,
                  child: CustomPaint(
                    painter: _BarcodePainter(
                        color: skin.ink2.withValues(alpha: .68)),
                  ),
                ),
                const Spacer(),
                Text(ticketNo,
                    style: _monoStyle(5.6, skin.muted, spacing: 1.1)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 倒计时副券：离出发还剩几天（DAYS TO GO）。
  Widget _digitalStub(String ticketNo) {
    final int? days = summary.daysUntilStart;
    final String big = days == null ? "—" : _two(days.clamp(0, 99));
    final String note = days == null
        ? "日期待定"
        : days <= 0
            ? "今天出发"
            : "待出发";
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[Color(0x05FFFFFF), Color(0x0DFFFFFF)],
        ),
      ),
      child: Stack(
        children: <Widget>[
          Positioned(
            left: 0,
            top: 10,
            bottom: 10,
            width: 1.2,
            child: CustomPaint(
              painter: _DashedLinePainter(
                  color: skin.line, dash: 3, gap: 3),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 10, 6, 9),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                Text("DAYS TO GO",
                    style: _monoStyle(5.8, skin.muted, spacing: 1.5)),
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      big,
                      style: TextStyle(
                        fontFamily: "Consolas",
                        fontFamilyFallback: const <String>["Courier New"],
                        fontSize: 30,
                        height: 1,
                        fontWeight: FontWeight.w300,
                        letterSpacing: -.5,
                        color: skin.ink,
                        fontFeatures: const <FontFeature>[
                          FontFeature.tabularFigures()
                        ],
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(_shortDate(summary.startDate),
                        style: _monoStyle(5.4, skin.muted, spacing: 1.6)),
                    const SizedBox(height: 3),
                    Text(
                      note,
                      style: TextStyle(
                        fontFamily: _kFontFamily,
                        fontFamilyFallback: _kFontFallback,
                        fontSize: 6.3,
                        color: skin.muted,
                      ),
                    ),
                  ],
                ),
                Text(ticketNo,
                    style: _monoStyle(5.6, skin.muted, spacing: 1.1)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── 票面零件 ──────────────────────────────────────────────────────

class _TicketPhoto extends StatelessWidget {
  const _TicketPhoto({
    required this.url,
    required this.skin,
    required this.digital,
    required this.photoWidth,
    required this.destination,
    required this.cap,
  });

  final String url;
  final _TicketSkin skin;
  final bool digital;
  final double photoWidth;
  final String destination;
  final String cap;

  @override
  Widget build(BuildContext context) {
    final Widget fallback = _CoverFallback(
      skin: skin,
      digital: digital,
      initial: _initialOf(destination),
    );
    final Widget photo = CachedMediaImage(
      url: url,
      fit: BoxFit.cover,
      alignment: const Alignment(0, -0.08),
      filterQuality: FilterQuality.high,
      // 4 倍显示宽度解码：高 DPI 下不糊，也不把原图整张塞内存
      cacheWidth: (photoWidth * 4).round().clamp(480, 1024).toInt(),
      gaplessPlayback: true,
      loadingBuilder: (BuildContext _) => fallback,
      errorBuilder: (BuildContext _, Object __, StackTrace? ___) => fallback,
    );
    final Widget visual = url.isEmpty
        ? fallback
        : digital
            ? photo
            : ColorFiltered(
                colorFilter: ColorFilter.matrix(_kPaperMatrix), child: photo);
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        visual,
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: digital
                ? LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: <Color>[
                      Colors.white.withValues(alpha: .10),
                      Colors.black.withValues(alpha: .84),
                    ],
                  )
                : LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    stops: const <double>[.3, 1],
                    colors: <Color>[
                      const Color(0xFF181208).withValues(alpha: 0),
                      const Color(0xFF181208).withValues(alpha: .55),
                    ],
                  ),
          ),
        ),
        Positioned.fill(
          child: IgnorePointer(
            child: CustomPaint(
              painter: _GrainPainter(
                color: digital
                    ? Colors.white.withValues(alpha: .06)
                    : Colors.black.withValues(alpha: .10),
              ),
            ),
          ),
        ),
        Positioned(
          left: 8,
          right: 4,
          bottom: 7,
          child: Text(
            cap,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _monoStyle(
              6.2,
              Colors.white.withValues(alpha: .87),
              spacing: 1.5,
            ).copyWith(shadows: <Shadow>[
              Shadow(
                color: Colors.black.withValues(alpha: .55),
                blurRadius: 5,
              ),
            ]),
          ),
        ),
      ],
    );
  }
}

class _CoverFallback extends StatelessWidget {
  const _CoverFallback({
    required this.skin,
    required this.digital,
    required this.initial,
  });

  final _TicketSkin skin;
  final bool digital;
  final String initial;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(-.55, -.6),
              radius: 1.25,
              colors: <Color>[skin.fallbackTop, skin.fallbackBottom],
            ),
          ),
        ),
        Positioned.fill(
          child: CustomPaint(
            painter: _ContourPainter(
              color: skin.ink.withValues(alpha: digital ? .10 : .12),
            ),
          ),
        ),
        Center(
          child: Text(
            initial,
            style: TextStyle(
              fontFamily: _kFontFamily,
              fontFamilyFallback: _kFontFallback,
              fontSize: 46,
              fontWeight: FontWeight.w800,
              height: 1,
              color: skin.ink.withValues(alpha: digital ? .14 : .10),
            ),
          ),
        ),
      ],
    );
  }
}

class _TicketField extends StatelessWidget {
  const _TicketField({
    required this.skin,
    required this.label,
    required this.value,
    required this.size,
  });

  final _TicketSkin skin;
  final String label;
  final String value;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(label, style: _monoStyle(6.6, skin.muted, spacing: 1.5)),
        const SizedBox(height: 3),
        Text(
          value,
          maxLines: 1,
          style: TextStyle(
            fontFamily: _kFontFamily,
            fontFamilyFallback: _kFontFallback,
            fontSize: size,
            height: 1,
            fontWeight: FontWeight.w600,
            color: skin.ink2,
            fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }
}

class _ArchiveFoot extends StatelessWidget {
  const _ArchiveFoot({
    required this.skin,
    required this.compact,
    required this.archived,
  });

  final _TicketSkin skin;
  final bool compact;
  final String archived;

  @override
  Widget build(BuildContext context) {
    final TextStyle style =
        _monoStyle(compact ? 6 : 6.4, skin.muted, spacing: 1.2);
    return Container(
      width: double.infinity,
      padding: EdgeInsets.only(top: compact ? 5 : 6),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: skin.line)),
      ),
      child: Row(
        children: <Widget>[
          Text(compact ? "ARCHIVED" : "ITINERARY ARCHIVED", style: style),
          const SizedBox(width: 5),
          if (!compact) ...<Widget>[
            Text("·", style: style),
            const SizedBox(width: 5),
          ],
          Text(archived, style: style),
        ],
      ),
    );
  }
}

class _RouteRail extends StatelessWidget {
  const _RouteRail({
    required this.skin,
    required this.summary,
  });

  final _TicketSkin skin;
  final _PlanSummary summary;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: SizedBox(
            height: 8,
            child: CustomPaint(
              painter: _RoutePainter(line: skin.line, dot: skin.ink2),
            ),
          ),
        ),
        const SizedBox(width: 5),
        Icon(Icons.flight,
            size: 9, color: skin.ink2.withValues(alpha: .65)),
        const SizedBox(width: 6),
        Text(
          "${summary.dayCount}D · ${summary.stopCount} STOPS",
          style: _monoStyle(6.2, skin.muted, spacing: 1.2),
        ),
      ],
    );
  }
}

class _TripChip extends StatelessWidget {
  const _TripChip({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: .32)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 4,
            height: 4,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color,
              boxShadow: <BoxShadow>[
                BoxShadow(color: color.withValues(alpha: .7), blurRadius: 5),
              ],
            ),
          ),
          const SizedBox(width: 4),
          Text(
            label,
            style: _monoStyle(6.4, color, spacing: 1.2),
          ),
        ],
      ),
    );
  }
}

// ── 票根壳：真缺口 + 阴影 + 纸纹 ──────────────────────────────────

class _TicketShell extends StatelessWidget {
  const _TicketShell({
    required this.stubWidth,
    required this.notch,
    required this.radius,
    required this.skin,
    required this.child,
  });

  final double stubWidth;
  final double notch;
  final double radius;
  final _TicketSkin skin;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _TicketShadowPainter(
        stubWidth: stubWidth,
        notch: notch,
        radius: radius,
        shadow: skin.shadow,
        edge: skin.edge,
      ),
      child: ClipPath(
        clipper: _TicketClipper(
          stubWidth: stubWidth,
          notch: notch,
          radius: radius,
        ),
        child: child,
      ),
    );
  }
}

Path _ticketPath(Size size, double stubWidth, double notch, double radius) {
  final Path body = Path()
    ..addRRect(RRect.fromRectAndRadius(
      Offset.zero & size,
      Radius.circular(radius),
    ));
  final double x = size.width - stubWidth;
  final Path holes = Path()
    ..addOval(Rect.fromCircle(center: Offset(x, 0), radius: notch))
    ..addOval(Rect.fromCircle(center: Offset(x, size.height), radius: notch));
  return Path.combine(PathOperation.difference, body, holes);
}

class _TicketClipper extends CustomClipper<Path> {
  const _TicketClipper({
    required this.stubWidth,
    required this.notch,
    required this.radius,
  });

  final double stubWidth;
  final double notch;
  final double radius;

  @override
  Path getClip(Size size) => _ticketPath(size, stubWidth, notch, radius);

  @override
  bool shouldReclip(covariant _TicketClipper oldClipper) =>
      oldClipper.stubWidth != stubWidth ||
      oldClipper.notch != notch ||
      oldClipper.radius != radius;
}

class _TicketShadowPainter extends CustomPainter {
  const _TicketShadowPainter({
    required this.stubWidth,
    required this.notch,
    required this.radius,
    required this.shadow,
    required this.edge,
  });

  final double stubWidth;
  final double notch;
  final double radius;
  final Color shadow;
  final Color edge;

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = _ticketPath(size, stubWidth, notch, radius);
    canvas.drawShadow(path, shadow, 9, false);
    if (edge.a > 0) {
      canvas.drawPath(
        path,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1
          ..color = edge,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _TicketShadowPainter old) =>
      old.stubWidth != stubWidth ||
      old.notch != notch ||
      old.radius != radius ||
      old.shadow != shadow ||
      old.edge != edge;
}

class _TicketStamp extends StatelessWidget {
  const _TicketStamp({
    required this.skin,
    required this.size,
    required this.date,
    this.label = "已出票",
    this.color,
  });

  final _TicketSkin skin;
  final double size;
  final String date;

  /// 章面主文案（往期「已出票」/ 待出发「待出发」）。
  final String label;

  /// 章色（缺省用皮肤自带的归档绿）。
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final Color ink = (color ?? skin.stamp).withValues(alpha: .82);
    return Transform.rotate(
      angle: -12 * math.pi / 180,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: ink, width: 2),
        ),
        child: Center(
          child: Container(
            margin: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                  color: (color ?? skin.stamp).withValues(alpha: .62),
                  width: 1),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text(
                  label,
                  style: TextStyle(
                    fontFamily: _kFontFamily,
                    fontFamilyFallback: _kFontFallback,
                    fontSize: size >= 52 ? 9.5 : 8.5,
                    height: 1.1,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .8,
                    color: ink,
                  ),
                ),
                const SizedBox(height: 1),
                Text("NEXTBOT", style: _monoStyle(5.2, ink, spacing: 1)),
                Text(date, style: _monoStyle(5.2, ink, spacing: .6)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TicketTape extends StatelessWidget {
  const _TicketTape({required this.skin});

  final _TicketSkin skin;

  @override
  Widget build(BuildContext context) {
    return Transform.rotate(
      angle: -2.2 * math.pi / 180,
      child: Container(
        width: 92,
        height: 21,
        decoration: BoxDecoration(
          color: skin.tape,
          borderRadius: BorderRadius.circular(1),
          border: Border.all(
            color: skin.digital
                ? skin.tapeBorder
                : Colors.white.withValues(alpha: .5),
          ),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: Colors.black.withValues(alpha: .14),
              blurRadius: 7,
              offset: const Offset(0, 2),
            ),
          ],
        ),
      ),
    );
  }
}

class _HoverTicket extends StatefulWidget {
  const _HoverTicket({
    required this.tilt,
    required this.onTap,
    required this.child,
  });

  final double tilt;
  final VoidCallback onTap;
  final Widget child;

  @override
  State<_HoverTicket> createState() => _HoverTicketState();
}

class _HoverTicketState extends State<_HoverTicket> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final Matrix4 transform = Matrix4.identity();
    if (_hover) {
      transform.setTranslationRaw(0, -3, 0);
    } else if (widget.tilt != 0) {
      transform.rotateZ(widget.tilt);
    }
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 320),
          curve: Curves.easeOutCubic,
          transform: transform,
          transformAlignment: Alignment.center,
          child: widget.child,
        ),
      ),
    );
  }
}

// ── 画笔 ──────────────────────────────────────────────────────────

class _GrainPainter extends CustomPainter {
  const _GrainPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final math.Random rnd = math.Random(11);
    final Paint paint = Paint()..color = color;
    final int count =
        (size.width * size.height / 260).round().clamp(80, 900).toInt();
    for (int i = 0; i < count; i++) {
      canvas.drawRect(
        Rect.fromLTWH(
          rnd.nextDouble() * size.width,
          rnd.nextDouble() * size.height,
          1.1,
          1.1,
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _GrainPainter old) => old.color != color;
}

class _DashedLinePainter extends CustomPainter {
  const _DashedLinePainter({
    required this.color,
    required this.dash,
    required this.gap,
  });

  final Color color;
  final double dash;
  final double gap;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..strokeWidth = size.width
      ..strokeCap = StrokeCap.butt;
    final double x = size.width / 2;
    for (double y = 0; y < size.height; y += dash + gap) {
      final double end = math.min(y + dash, size.height);
      canvas.drawLine(Offset(x, y), Offset(x, end), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _DashedLinePainter old) =>
      old.color != color || old.dash != dash || old.gap != gap;
}

class _DashTrackPainter extends CustomPainter {
  const _DashTrackPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    final double y = size.height / 2;
    for (double x = 0; x < size.width; x += 7) {
      canvas.drawLine(
        Offset(x, y),
        Offset(math.min(x + 4, size.width), y),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _DashTrackPainter old) => old.color != color;
}

class _BarcodePainter extends CustomPainter {
  const _BarcodePainter({required this.color});

  final Color color;

  static const List<double> _bars = <double>[
    2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 2, 1, 3, 1, 2, 1, 1, 3, 1, 2,
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..color = color;
    final double unit = size.width / 44;
    double x = 0;
    int i = 0;
    while (x < size.width) {
      final double w = _bars[i % _bars.length] * unit;
      if (i.isEven) {
        canvas.drawRect(
          Rect.fromLTWH(x, 0, math.min(w, size.width - x), size.height),
          paint,
        );
      }
      x += (w + unit * .8).clamp(unit, size.width).toDouble();
      i++;
    }
  }

  @override
  bool shouldRepaint(covariant _BarcodePainter old) => old.color != color;
}

class _RoutePainter extends CustomPainter {
  const _RoutePainter({required this.line, required this.dot});

  final Color line;
  final Color dot;

  @override
  void paint(Canvas canvas, Size size) {
    final double y = size.height / 2;
    final Paint dash = Paint()
      ..color = line
      ..strokeWidth = 1;
    for (double x = 0; x < size.width; x += 5) {
      canvas.drawLine(
        Offset(x, y),
        Offset(math.min(x + 2.5, size.width), y),
        dash,
      );
    }
    final Paint dotPaint = Paint()..color = dot.withValues(alpha: .55);
    for (int i = 0; i < 5; i++) {
      final double x = size.width * i / 4;
      canvas.drawCircle(
        Offset(x.clamp(1.5, size.width - 1.5).toDouble(), y),
        1.5,
        i == 4 ? (Paint()..color = dot) : dotPaint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RoutePainter old) =>
      old.line != line || old.dot != dot;
}

class _ContourPainter extends CustomPainter {
  const _ContourPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = color;
    final Offset center = Offset(size.width * .18, size.height * 1.12);
    for (int i = 1; i <= 7; i++) {
      final double r = i * size.width * .2;
      canvas.drawOval(
        Rect.fromCenter(center: center, width: r * 2, height: r * 1.35),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ContourPainter old) => old.color != color;
}

// ── 数据与样式小工具 ──────────────────────────────────────────────

class _TicketSkin {
  const _TicketSkin({
    required this.paper,
    required this.paperEdge,
    required this.ink,
    required this.ink2,
    required this.muted,
    required this.line,
    required this.stamp,
    required this.shadow,
    required this.tape,
    required this.grain,
    required this.edge,
    required this.digital,
    required this.fallbackTop,
    required this.fallbackBottom,
    required this.tapeBorder,
  });

  factory _TicketSkin.paper(bool warm) {
    if (warm) {
      return const _TicketSkin(
        paper: Color(0xFFFFFDF7),
        paperEdge: Color(0xFFF4EDDF),
        ink: Color(0xFF232833),
        ink2: Color(0xFF5B6472),
        muted: Color(0xFF98A2B3),
        line: Color(0x29232833),
        stamp: Color(0xFF0E7F5C),
        shadow: Color(0x3D232833),
        tape: Color(0xE6FFFCF2),
        grain: Color(0x0D232833),
        edge: Color(0xFFE9E1D0),
        digital: false,
        fallbackTop: Color(0xFFF3EAD7),
        fallbackBottom: Color(0xFFDFD3B8),
        tapeBorder: Color(0x80FFFFFF),
      );
    }
    return const _TicketSkin(
      paper: Color(0xFFF2EBDC),
      paperEdge: Color(0xFFE7DDC9),
      ink: Color(0xFF272219),
      ink2: Color(0xFF5D5444),
      muted: Color(0xFF7C7059),
      line: Color(0x3D272219),
      stamp: Color(0xFF1F7A5A),
      shadow: Color(0xB8000000),
      tape: Color(0x57FFFAEC),
      grain: Color(0x0D272219),
      edge: Color(0x00000000),
      digital: false,
      fallbackTop: Color(0xFFF3EAD7),
      fallbackBottom: Color(0xFFDFD3B8),
      tapeBorder: Color(0x80FFFFFF),
    );
  }

  /// 数字登机牌皮肤。
  ///
  /// 深色主题保持「夜航黑卡」原样；浅色（warm）主题切换为白底数字票，
  /// 让「即将出发」的主票跟随主题，不再恒为黑色。
  factory _TicketSkin.digital(bool warm) {
    if (warm) {
      return const _TicketSkin(
        paper: Color(0xFFFFFFFF),
        paperEdge: Color(0xFFEDF1F7),
        ink: Color(0xFF232833),
        ink2: Color(0xFF5B6472),
        muted: Color(0xFF98A2B3),
        line: Color(0x24232833),
        stamp: Color(0xFF0E7F5C),
        shadow: Color(0x3D232833),
        tape: Color(0x00000000),
        grain: Color(0x0A232833),
        edge: Color(0xFFDCE3EC),
        digital: true,
        fallbackTop: Color(0xFFEDF1F7),
        fallbackBottom: Color(0xFFDCE4EF),
        tapeBorder: Color(0x1F232833),
      );
    }
    return const _TicketSkin(
        paper: Color(0xFF151617),
        paperEdge: Color(0xFF101112),
        ink: Color(0xFFF2F4F6),
        ink2: Color(0xFFCFD4DA),
        muted: Color(0xFF8B9199),
        line: Color(0x24FFFFFF),
        stamp: Color(0xFF1ED7A6),
        shadow: Color(0xE0000000),
        tape: Color(0x00000000),
        grain: Color(0x0AFFFFFF),
        edge: Color(0x17FFFFFF),
        digital: true,
        fallbackTop: Color(0xFF242526),
        fallbackBottom: Color(0xFF0C0D0E),
        tapeBorder: Color(0x24FFFFFF),
      );
  }

  final Color paper;
  final Color paperEdge;
  final Color ink;
  final Color ink2;
  final Color muted;
  final Color line;
  final Color stamp;
  final Color shadow;
  final Color tape;
  final Color grain;
  final Color edge;
  final bool digital;

  /// 无图封面兜底渐变（深→浅，左上到右下）。
  final Color fallbackTop;
  final Color fallbackBottom;

  /// 胶带描边：数字票在深浅主题下各有一档。
  final Color tapeBorder;
}

const List<double> _kPaperMatrix = <double>[
  0.88409, 0.13256, 0.01335, 0, -3.84,
  0.03949, 0.97716, 0.01335, 0, -3.84,
  0.03949, 0.13256, 0.85795, 0, -3.84,
  0, 0, 0, 1, 0,
];

TextStyle _monoStyle(
  double size,
  Color color, {
  double spacing = 1.2,
  FontWeight weight = FontWeight.w500,
}) {
  return TextStyle(
    fontFamily: "Consolas",
    fontFamilyFallback: const <String>["Menlo", "Courier New"],
    fontSize: size,
    height: 1,
    letterSpacing: spacing,
    color: color,
    fontWeight: weight,
    fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
  );
}

String _two(int v) => v.toString().padLeft(2, "0");

DateTime _summaryDate(_PlanSummary s) {
  final DateTime? end = DateTime.tryParse(s.endDate.trim());
  if (end != null) return end;
  final DateTime? start = DateTime.tryParse(s.startDate.trim());
  if (start != null) return start;
  if (s.createdAt > 0) {
    return DateTime.fromMillisecondsSinceEpoch(s.createdAt);
  }
  return DateTime(1970);
}

String _mmddOf(String iso) {
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "";
  return "${_two(d.month)}.${_two(d.day)}";
}

String _weekdayOf(String iso) {
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "";
  const List<String> names = <String>["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return names[(d.weekday - 1).clamp(0, 6)];
}

/// 照片角标月份：即将出发取出发月，往期取归档月。
String _coverCaption(_PlanSummary s) {
  final String iso = s.bucket == 1 && s.startDate.isNotEmpty
      ? s.startDate
      : (s.endDate.isNotEmpty ? s.endDate : s.startDate);
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "";
  return "${_monthEn(d.month)} · ${d.year}";
}

/// 城市链：标题里写了「A → B → C」就按站拆开，否则只有一站。
List<String> _chainOf(_PlanSummary s) => s.listTitle
    .split("→")
    .map((String e) => e.trim())
    .where((String e) => e.isNotEmpty)
    .toList(growable: false);

/// 票面日期字段（「10.28 周三」）。
String _dateFieldOf(String iso) {
  final String mmdd = _mmddOf(iso);
  if (mmdd.isEmpty) return "";
  final String weekday = _weekdayOf(iso);
  return weekday.isEmpty ? mmdd : "$mmdd $weekday";
}

String _ymdOf(String iso) {
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "";
  return "${d.year}.${_two(d.month)}.${_two(d.day)}";
}

String _shortDate(String iso) {
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "";
  return "${_monthEn(d.month)} ${_two(d.day)}";
}

String _stampDate(_PlanSummary s) {
  final String iso = s.endDate.isNotEmpty ? s.endDate : s.startDate;
  final DateTime? d = DateTime.tryParse(iso.trim());
  if (d == null) return "ARCHIVED";
  return "${_two(d.month)}.${_two(d.day)}";
}

String _ticketNoOf(String planId) {
  final String digits = planId.replaceAll(RegExp(r"[^0-9]"), "");
  return "NB-${digits.length >= 4 ? digits.substring(digits.length - 4) : digits.padLeft(4, "0")}";
}

String _stayLabel(_PlanSummary s) {
  if (s.dayCount > 1) return "${s.dayCount} 天 ${s.dayCount - 1} 晚";
  if (s.dayCount == 1) return "1 天";
  if (s.stopCount > 0) return "${s.stopCount} 个地点";
  return "";
}

String _initialOf(String name) {
  final String t = name.trim();
  return t.isEmpty ? "旅" : t.substring(0, 1);
}

const List<String> _kMonthEn = <String>[
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

String _monthEn(int month) =>
    month >= 1 && month <= 12 ? _kMonthEn[month - 1] : "—";
