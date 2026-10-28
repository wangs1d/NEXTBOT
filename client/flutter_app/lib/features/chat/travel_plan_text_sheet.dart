part of "travel_plan_archive.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程 · 文字版（图文长图）
//
// 明细卡底部的「文字版」入口 → 预览对话框：拉完整行程（GET /travel/plans/:id）
// → 预加载封面与每站首图 → 渲染一张固定宽度的纸面长图：
//   封面海报 → 概览胶囊 → 目的地简介 → 每日安排（每站图 + 时间/价格/
//   地址/描述/贴士/预约/避坑/出片）→ 出发前核实 → 行前清单 → 页脚。
// 内容不止逐日行程：简介/概览/核实/清单这些「介绍板块」一并在图里。
//
// 分享走主流做法：渲染成 PNG 就是分享——「保存 PNG」选目录落盘后自动
// 打开所在文件夹并选中文件，直接拖进微信/聊天窗口发出去。
// 纸面配色固定浅色（不随 app 深/暖主题变），发出去的图在哪儿都可读。
// ═══════════════════════════════════════════════════════════════════

/// 长图纸面固定调色板（对齐 warm 主题的强调色，恒浅色底）。
abstract final class _SheetColors {
  static const Color bg = Color(0xFFFFFFFF);
  static const Color card = Color(0xFFF7F5F0);
  static const Color ink = Color(0xFF26241F);
  static const Color ink2 = Color(0xFF55524B);
  static const Color muted = Color(0xFF8F8B82);
  static const Color line = Color(0xFFE7E3DA);
  static const Color accent = Color(0xFF0055B8);
  static const Color accentSoft = Color(0xFFEAF3FF);
  static const Color green = Color(0xFF0E9F6E);
  static const Color orange = Color(0xFFB45309);
  static const Color orangeSoft = Color(0xFFFBF1E2);
}

/// 打开「文字版行程」预览对话框（拉数据 → 预览 → 保存 PNG）。
Future<void> _showTravelPlanTextSheet(
  BuildContext context, {
  required _DraftData draft,
}) {
  return showDialog<void>(
    context: context,
    builder: (BuildContext context) => _TextSheetDialog(draft: draft),
  );
}

/// 文字版预览对话框：加载态 / 错误重试 / 长图预览 + 保存。
class _TextSheetDialog extends StatefulWidget {
  const _TextSheetDialog({required this.draft});

  final _DraftData draft;

  @override
  State<_TextSheetDialog> createState() => _TextSheetDialogState();
}

class _TextSheetDialogState extends State<_TextSheetDialog> {
  final GlobalKey _captureKey = GlobalKey();

  TravelPlanData? _plan;

  /// 预加载成功的图片地址（只渲染这些，失败的不进图，避免空框）。
  final Set<String> _loadedImages = <String>{};

  bool _loading = true;
  bool _saving = false;
  String _error = "";
  String _savedPath = "";

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = "";
    });
    try {
      if (widget.draft.planId.isEmpty) {
        throw Exception("行程尚未落盘，稍后再试");
      }
      final http.Response resp = await http
          .get(Uri.parse(
              "${ApiConfig.httpBase}/travel/plans/${widget.draft.planId}"))
          .timeout(const Duration(seconds: 20));
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Object? decoded = jsonDecode(resp.body);
      final Object? raw = decoded is Map ? decoded["plan"] : null;
      if (raw is! Map<String, dynamic>) {
        throw Exception("行程数据缺失");
      }
      final TravelPlanData plan = TravelPlanData.fromPlanJson(raw);
      await _precacheImages(plan);
      if (!mounted) return;
      setState(() {
        _plan = plan;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = "$e";
      });
    }
  }

  /// 封面 + 每站首图预解码：预览与截图都要求图片已在内存缓存里，
  /// 截图是同步抓 layer，字节没到位就会缺图。失败的不进图，避免空框。
  Future<void> _precacheImages(TravelPlanData plan) async {
    final List<String> urls = <String>[
      if (plan.coverImage.isNotEmpty) plan.coverImage,
      for (final TravelPlanDay day in plan.days)
        for (final TravelDayEntry e in day.entries)
          if (e.type != "hotel" && e.images.isNotEmpty) e.images.first,
    ];
    Future<void> preload(String url) async {
      try {
        await precacheImage(Image.network(url).image, context);
        _loadedImages.add(url);
      } catch (_) {
        // 单图失败只缺这一张，不挡整版。
      }
    }

    await Future.wait(<Future<void>>[
      for (final String url in urls.toSet().take(40)) preload(url),
    ]);
  }

  Future<void> _save() async {
    if (_saving) return;
    // 先抓截图边界再弹目录选择：RenderObject 不跨异步缺口。
    final BuildContext? bctx = _captureKey.currentContext;
    final RenderRepaintBoundary? boundary =
        bctx?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null || !boundary.attached) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text("画面未就绪，稍后再试",
              style: TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }
    final String? dir = await FilePicker.platform
        .getDirectoryPath(dialogTitle: "选择保存位置");
    if (dir == null || !mounted) return;
    setState(() => _saving = true);
    try {
      final ui.Image image = await boundary.toImage(pixelRatio: 2.0);
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) {
        throw Exception("图片编码失败");
      }
      final String path =
          "$dir${Platform.pathSeparator}${_fileName()}";
      File(path).writeAsBytesSync(data.buffer.asUint8List(), flush: true);
      _savedPath = path;
      // 主流分享路径：存完直接打开所在文件夹并选中文件，拖给朋友即可。
      unawaited(() async {
        try {
          await Process.run("explorer.exe", <String>["/select,", path]);
        } catch (_) {
          // 打不开资源管理器不碍事，文件已经落盘。
        }
      }());
      setState(() {});
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("保存失败：$e", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _fileName() {
    final String raw = (_plan?.title ?? widget.draft.title).trim().isNotEmpty
        ? (_plan?.title ?? widget.draft.title)
        : widget.draft.destination;
    final String safe = raw
        .replaceAll(RegExp(r'[\\/:*?"<>|]'), "-")
        .replaceAll(RegExp(r"\s+"), " ")
        .trim();
    final String base =
        safe.isEmpty ? "行程" : (safe.length > 40 ? safe.substring(0, 40) : safe);
    return "$base-文字版.png";
  }

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    final Size screen = MediaQuery.of(context).size;
    final double w = math.min(820.0, screen.width - 48);
    final double h = math.min(840.0, screen.height - 48);
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_kCardRadius + 4),
        side: BorderSide(color: c.borderSoft),
      ),
      child: SizedBox(
        width: w,
        height: h,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(c),
            Divider(height: 1, color: c.borderSoft),
            Expanded(child: _buildBody(c)),
            Divider(height: 1, color: c.borderSoft),
            _buildFooter(c),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader(_StageColors c) {
    final String dest = _plan?.destination ?? widget.draft.destination;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      child: Row(
        children: <Widget>[
          Icon(Icons.notes_outlined, size: 16, color: c.accent),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              dest.isEmpty ? "文字版行程" : "「$dest」文字版行程",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 13.5, fontWeight: FontWeight.w700, color: c.text),
            ),
          ),
          IconButton(
            onPressed: () => Navigator.of(context).pop(),
            icon: Icon(Icons.close, size: 17, color: c.muted),
            tooltip: "关闭",
          ),
        ],
      ),
    );
  }

  Widget _buildBody(_StageColors c) {
    if (_loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
            const SizedBox(height: 12),
            Text("正在生成文字版…",
                style: TextStyle(fontSize: 12, color: c.muted)),
          ],
        ),
      );
    }
    if (_error.isNotEmpty || _plan == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.error_outline, size: 22, color: c.orange),
            const SizedBox(height: 10),
            Text("生成失败：$_error",
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: c.text2)),
            const SizedBox(height: 10),
            TextButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh, size: 15),
              label: const Text("重试", style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      );
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints cons) {
        final Widget sheet = RepaintBoundary(
          key: _captureKey,
          child: _TextPlanSheet(
            plan: _plan!,
            draft: widget.draft,
            loadedImages: _loadedImages,
          ),
        );
        if (cons.maxWidth >= _TextPlanSheet.width) {
          return SingleChildScrollView(child: Center(child: sheet));
        }
        // 窄窗：横竖都可滚，长图保持完整宽度不缩放（截图分辨率才稳定）。
        return SingleChildScrollView(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: cons.maxWidth),
              child: Center(child: sheet),
            ),
          ),
        );
      },
    );
  }

  Widget _buildFooter(_StageColors c) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              _saving
                  ? "正在生成图片…"
                  : _savedPath.isNotEmpty
                      ? "已保存，文件夹已打开：$_savedPath"
                      : "保存为 PNG 长图后，直接把图片发给朋友",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                color: _savedPath.isNotEmpty ? c.green : c.muted,
              ),
            ),
          ),
          const SizedBox(width: 12),
          FilledButton.icon(
            onPressed: (_saving || _plan == null) ? null : _save,
            style: FilledButton.styleFrom(
              backgroundColor: c.accentBg,
              foregroundColor: c.onAccent,
              padding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              minimumSize: const Size(0, 36),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(_kBtnRadius),
              ),
            ),
            icon: _saving
                ? const SizedBox(
                    width: 13,
                    height: 13,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_alt, size: 15),
            label: Text(_saving ? "生成中" : "保存 PNG",
                style:
                    const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

/// 长图本体：固定 720 宽的纸面内容，所有信息一图流。
class _TextPlanSheet extends StatelessWidget {
  const _TextPlanSheet({
    required this.plan,
    required this.draft,
    required this.loadedImages,
  });

  final TravelPlanData plan;
  final _DraftData draft;
  final Set<String> loadedImages;

  static const double width = 720;

  static const List<String> _weekdays = <String>[
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ];

  String _fmtDate(String iso) {
    if (iso.length < 10) return "";
    final DateTime? d = DateTime.tryParse(iso);
    if (d == null) return iso.substring(5).replaceAll("-", ".");
    final String mm = d.month.toString().padLeft(2, "0");
    final String dd = d.day.toString().padLeft(2, "0");
    return "$mm.$dd ${_weekdays[(d.weekday - 1).clamp(0, 6)]}";
  }

  int get _stopCount => <int>[
        for (final TravelPlanDay day in plan.days)
          for (final TravelDayEntry e in day.entries)
            if (e.type != "hotel" && e.type != "transport") 1,
      ].fold(0, (int a, int b) => a + b);

  /// 与 draft.days 同序（同一服务端 payload 拆出的），按索引取主题/天气。
  _DraftDayData? _draftDay(int index) =>
      index < draft.days.length ? draft.days[index] : null;

  @override
  Widget build(BuildContext context) {
    return DefaultTextStyle(
      style: const TextStyle(
          fontFamily: _kFontFamily, color: _SheetColors.ink, height: 1.5),
      child: Container(
        width: width,
        color: _SheetColors.bg,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(),
            Padding(
              padding: const EdgeInsets.fromLTRB(40, 24, 40, 36),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _buildOverview(),
                  if (plan.intro.trim().isNotEmpty) ...<Widget>[
                    const SizedBox(height: 26),
                    _sectionHeader("关于目的地"),
                    const SizedBox(height: 10),
                    Text(plan.intro.trim(),
                        style: const TextStyle(
                            fontSize: 12.5,
                            height: 1.75,
                            color: _SheetColors.ink2)),
                  ],
                  const SizedBox(height: 26),
                  _sectionHeader("每日安排"),
                  const SizedBox(height: 12),
                  for (int i = 0; i < plan.days.length; i++)
                    _buildDay(plan.days[i], i),
                  _buildVerification(),
                  if (plan.packing.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 26),
                    _sectionHeader("行前清单"),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: <Widget>[
                        for (final String item in plan.packing) _pill(item),
                      ],
                    ),
                  ],
                  const SizedBox(height: 30),
                  _buildFooter(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── 头部：封面海报 ─────────────────────────────────────────────

  Widget _buildHeader() {
    final String cover = _headerCover();
    final String dateRange = <String>[
      if (plan.startDate.length >= 10) _fmtDate(plan.startDate),
      if (plan.endDate.length >= 10 &&
          plan.endDate != plan.startDate) _fmtDate(plan.endDate),
    ].join(" - ");
    final int nights = plan.days.length > 1 ? plan.days.length - 1 : 0;
    final String meta = <String>[
      if (dateRange.isNotEmpty) dateRange,
      if (plan.days.isNotEmpty)
        "${plan.days.length} 天${nights > 0 ? " $nights 晚" : ""}",
      if (draft.totalCost != null && draft.totalCost! > 0)
        "约 ¥${draft.totalCost!.round()}",
    ].join(" · ");
    return SizedBox(
      height: 232,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          const ColoredBox(color: Color(0xFF2C2C2C)),
          if (cover.isNotEmpty && loadedImages.contains(cover))
            Image.network(cover, fit: BoxFit.cover),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Color(0x59000000),
                  Color(0x14000000),
                  Color(0xD9000000),
                ],
                stops: <double>[0.0, 0.42, 1.0],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    if (plan.destination.trim().isNotEmpty) ...<Widget>[
                      _DestinationBadge(destination: plan.destination.trim()),
                      const SizedBox(width: 8),
                    ],
                    if (plan.days.isNotEmpty)
                      Text("${plan.days.length} 天行程",
                          style: TextStyle(
                              fontSize: 11.5,
                              color: Colors.white.withValues(alpha: 0.85))),
                  ],
                ),
                const Spacer(),
                Text(
                  plan.title.trim().isEmpty
                      ? plan.destination
                      : plan.title.trim(),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 23,
                      fontWeight: FontWeight.w800,
                      color: Colors.white,
                      height: 1.3),
                ),
                if (meta.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 8),
                  Text(meta,
                      style: TextStyle(
                          fontSize: 12,
                          color: Colors.white.withValues(alpha: 0.78))),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _headerCover() {
    if (plan.coverImage.isNotEmpty) return plan.coverImage;
    for (final TravelPlanDay day in plan.days) {
      for (final TravelDayEntry e in day.entries) {
        if (e.type != "hotel" && e.images.isNotEmpty) return e.images.first;
      }
    }
    return "";
  }

  // ── 概览胶囊行 ────────────────────────────────────────────────

  Widget _buildOverview() {
    final int nights = plan.days.length > 1 ? plan.days.length - 1 : 0;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        if (draft.totalCost != null && draft.totalCost! > 0)
          _chip(Icons.payments_outlined, "预算约 ¥${draft.totalCost!.round()}"),
        if (plan.days.isNotEmpty)
          _chip(Icons.calendar_month_outlined,
              "${plan.days.length} 天${nights > 0 ? " $nights 晚" : ""}"),
        if (_stopCount > 0) _chip(Icons.route_outlined, "共 $_stopCount 站"),
        if (plan.weather.trim().isNotEmpty)
          _chip(Icons.cloud_outlined, plan.weather.trim(), maxWidth: 210),
      ],
    );
  }

  Widget _chip(IconData icon, String text, {double maxWidth = 260}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: _SheetColors.card,
        borderRadius: BorderRadius.circular(8),
      ),
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 12.5, color: _SheetColors.muted),
          const SizedBox(width: 5),
          Flexible(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: _SheetColors.ink2)),
          ),
        ],
      ),
    );
  }

  Widget _pill(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
      decoration: BoxDecoration(
        color: _SheetColors.card,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text,
          style: const TextStyle(
              fontSize: 11.5, color: _SheetColors.ink2)),
    );
  }

  Widget _sectionHeader(String title) {
    return Row(
      children: <Widget>[
        Container(
          width: 3.5,
          height: 13,
          decoration: BoxDecoration(
            color: _SheetColors.accent,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 8),
        Text(title,
            style: const TextStyle(
                fontSize: 14.5,
                fontWeight: FontWeight.w800,
                color: _SheetColors.ink)),
      ],
    );
  }

  // ── 每日安排 ──────────────────────────────────────────────────

  Widget _buildDay(TravelPlanDay day, int index) {
    final _DraftDayData? dd = _draftDay(index);
    final List<TravelDayEntry> stays = <TravelDayEntry>[
      for (final TravelDayEntry e in day.entries) if (e.type == "hotel") e,
    ];
    final String hotel = stays.isEmpty ? "" : stays.first.title;
    final String date = _fmtDate(day.date);
    final String meta = <String>[
      if (dd != null && dd.theme.isNotEmpty) dd.theme,
      if (dd != null && dd.weather.isNotEmpty) dd.weather,
    ].join(" · ");
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _SheetColors.card,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Container(
                width: 4,
                height: 14,
                decoration: BoxDecoration(
                  color: _SheetColors.accent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 8),
              Text("Day ${index + 1}",
                  style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w800,
                      color: _SheetColors.ink)),
              if (date.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Padding(
                  padding: const EdgeInsets.only(bottom: 1),
                  child: Text(date,
                      style: const TextStyle(
                          fontSize: 11, color: _SheetColors.muted)),
                ),
              ],
              const Spacer(),
              if (meta.isNotEmpty)
                Flexible(
                  child: Text(meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 10.5, color: _SheetColors.muted)),
                ),
            ],
          ),
          const SizedBox(height: 14),
          if (day.entries.isEmpty)
            const Text("当天以休整 / 自由活动为主",
                style: TextStyle(fontSize: 11.5, color: _SheetColors.muted))
          else ...<Widget>[
            for (final TravelDayEntry e in day.entries)
              if (e.type == "hotel")
                _buildHotelLine(e)
              else if (e.type == "transport")
                _buildTransportLine(e)
              else
                _buildStop(e),
          ],
          if (hotel.isNotEmpty && stays.isEmpty)
            _buildHotelLine(null, fallbackName: hotel),
        ],
      ),
    );
  }

  Widget _buildHotelLine(TravelDayEntry? e, {String fallbackName = ""}) {
    final String name = e?.title ?? fallbackName;
    if (name.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: <Widget>[
          const Icon(Icons.hotel_outlined,
              size: 12.5, color: _SheetColors.green),
          const SizedBox(width: 5),
          Expanded(
            child: Text("今晚住 $name",
                style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: _SheetColors.green)),
          ),
        ],
      ),
    );
  }

  Widget _buildTransportLine(TravelDayEntry e) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: <Widget>[
          const Icon(Icons.route_outlined,
              size: 12, color: _SheetColors.muted),
          const SizedBox(width: 5),
          Expanded(
            child: Text(
              <String>[
                if (e.time.isNotEmpty) e.time,
                e.title,
                if (e.description.isNotEmpty) e.description,
              ].join(" · "),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontSize: 11, color: _SheetColors.muted),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStop(TravelDayEntry e) {
    final String image =
        e.images.isNotEmpty && loadedImages.contains(e.images.first)
            ? e.images.first
            : "";
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (image.isNotEmpty) ...<Widget>[
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: SizedBox(
                width: double.infinity,
                height: 176,
                child: Image.network(image, fit: BoxFit.cover),
              ),
            ),
            const SizedBox(height: 11),
          ],
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (e.time.isNotEmpty) ...<Widget>[
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: _SheetColors.accentSoft,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(e.time,
                      style: const TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w800,
                          color: _SheetColors.accent)),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Text(e.title,
                    style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: _SheetColors.ink,
                        height: 1.35)),
              ),
              if (e.priceInfo.trim().isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Text(e.priceInfo.trim(),
                    style: const TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w700,
                        color: _SheetColors.orange)),
              ],
            ],
          ),
          if (e.address.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: <Widget>[
                  const Icon(Icons.place_outlined,
                      size: 11.5, color: _SheetColors.muted),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(e.address.trim(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 10.5, color: _SheetColors.muted)),
                  ),
                ],
              ),
            ),
          if (e.description.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: Text(e.description.trim(),
                  style: const TextStyle(
                      fontSize: 12,
                      height: 1.7,
                      color: _SheetColors.ink2)),
            ),
          for (final String tip in e.tips)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Padding(
                    padding: EdgeInsets.only(top: 6.5),
                    child: Text("·",
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: _SheetColors.accent,
                            height: 1)),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(tip,
                        style: const TextStyle(
                            fontSize: 11.5,
                            height: 1.6,
                            color: _SheetColors.ink2)),
                  ),
                ],
              ),
            ),
          if (e.bookingNote.trim().isNotEmpty)
            _noteLine(Icons.event_available_outlined, _SheetColors.accent,
                "预约", e.bookingNote.trim()),
          if (e.pitfall.trim().isNotEmpty)
            _noteLine(Icons.warning_amber_rounded, _SheetColors.orange, "避坑",
                e.pitfall.trim()),
          if (e.photoTip.trim().isNotEmpty)
            _noteLine(Icons.photo_camera_outlined, _SheetColors.ink2, "出片",
                e.photoTip.trim()),
          if (e.openingHours.trim().isNotEmpty)
            _noteLine(Icons.schedule_outlined, _SheetColors.muted, "开放",
                e.openingHours.trim()),
        ],
      ),
    );
  }

  Widget _noteLine(IconData icon, Color color, String label, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1.5),
            child: Icon(icon, size: 12, color: color),
          ),
          const SizedBox(width: 5),
          Expanded(
            child: Text("$label · $text",
                style: TextStyle(fontSize: 11, height: 1.55, color: color)),
          ),
        ],
      ),
    );
  }

  // ── 出发前核实 ────────────────────────────────────────────────

  Widget _buildVerification() {
    final _VerificationData? v = draft.verification;
    final List<String> lines = <String>[
      if (v != null)
        for (final _VerificationIssueData issue in v.issues.take(6))
          "Day ${issue.day + 1} · "
              "${issue.name.isEmpty ? "" : "${issue.name}："}"
              "${issue.message}"
              "${issue.suggestion.isEmpty ? "" : " → ${issue.suggestion}"}",
      if (draft.wishlistMissed.isNotEmpty)
        "没排进去：${draft.wishlistMissed.join("、")}",
    ];
    if (lines.isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _SheetColors.orangeSoft,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Row(
            children: <Widget>[
              Icon(Icons.rule_outlined, size: 14, color: _SheetColors.orange),
              SizedBox(width: 6),
              Text("出发前核实",
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: _SheetColors.orange)),
            ],
          ),
          const SizedBox(height: 9),
          for (final String line in lines)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Padding(
                    padding: EdgeInsets.only(top: 6),
                    child: Text("·",
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: _SheetColors.orange,
                            height: 1)),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(line,
                        style: const TextStyle(
                            fontSize: 11,
                            height: 1.6,
                            color: _SheetColors.orange)),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text("开放时间 / 预约规则以官方为准，出发前再确认一次。",
                style: TextStyle(
                    fontSize: 10,
                    color: _SheetColors.orange.withValues(alpha: 0.75))),
          ),
        ],
      ),
    );
  }

  // ── 页脚 ─────────────────────────────────────────────────────

  Widget _buildFooter() {
    final DateTime now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, "0");
    final String stamp =
        "${now.year}.${two(now.month)}.${two(now.day)} 生成";
    final String qualityNote = switch (plan.dataQuality) {
      "synthetic" => "演示数据：价格与开放信息为占位，请以实际为准。",
      "knowledge" => "本行程基于内置知识库生成，价格与开放信息请自行核实。",
      _ => "行程信息来自实时搜索，出发前请以官方信息为准。",
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(height: 1, color: _SheetColors.line),
        const SizedBox(height: 14),
        Row(
          children: <Widget>[
            const Text("NextBot · 行程规划",
                style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: _SheetColors.muted)),
            const Spacer(),
            Text(stamp,
                style: const TextStyle(
                    fontSize: 10.5, color: _SheetColors.muted)),
          ],
        ),
        const SizedBox(height: 5),
        Text(qualityNote,
            style: const TextStyle(
                fontSize: 10, color: _SheetColors.muted)),
      ],
    );
  }
}
