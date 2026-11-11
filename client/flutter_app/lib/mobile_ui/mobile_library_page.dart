import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/utils/link_utils.dart";
import "../features/chat/image_preview_panel.dart";
import "../features/chat/media_disk_cache.dart";
import "../features/chat/travel_plan_mobile_page.dart";
import "../features/chat/travel_plan_models.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";
import "../core/services/nb_http.dart";

/// 手机端「资料库」页。
///
/// 2026-11-09 改版：产物按「每次对话」折叠成一张卡——
/// 一次对话产出的照片 / 文件 / 笔记 / 行程装在同一张卡里，卡面显示
/// 最多 3 张缩略图 + 「N 张图片 · M 个文件」统计；点卡进会话详情页，
/// 照片以网格呈现，点任意照片进全屏查看页（与聊天共用左右滑动/缩放），
/// 不再跳系统浏览器。无来源信息的历史产物统一归入「历史记录」卡。
///
/// 数据源：GET /api/library/items（groups 字段由服务端按 sessionId 折叠）。
class MobileLibraryPage extends StatefulWidget {
  const MobileLibraryPage({super.key, this.client});

  /// 注入 http client(测试用)。
  final http.Client? client;

  @override
  State<MobileLibraryPage> createState() => MobileLibraryPageState();
}

/// 资料条目类型（卡面角标 / 详情页分区用）。
enum _LibType { doc, table, image, note, travel }

/// 筛选维度（chip）：文件把「文档 + 表格」合为一类，避免按后缀切碎筛选轴。
enum _LibFilter { file, image, note, travel }

class MobileLibraryPageState extends State<MobileLibraryPage> {
  bool _loading = true;
  String? _error;
  List<_LibGroup> _groups = const <_LibGroup>[];
  _LibFilter? _filter;
  final TextEditingController _search = TextEditingController();
  /// 行程详情拉取中：防止连点重复推路由。
  bool _openingPlan = false;

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
    unawaited(_load());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// 主壳切到本 tab 时触发重拉。
  /// 已有数据时静默后台刷新（秒进不转圈），无数据才走完整加载。
  void refresh() {
    if (!_loading) unawaited(_load(silent: _groups.isNotEmpty));
  }

  /// 磁盘缓存 key：上次成功响应体原样落盘（stale-while-revalidate 用）。
  static String get _cacheKey =>
      "library_items_${ApiConfig.effectiveActorId}";

  /// [silent]=true 时已有数据保持展示，成功换数据、失败不闪错误页。
  Future<void> _load({bool silent = false}) async {
    // 无数据时的完整加载（首次进入 / 错误重试）：
    // 初次进入先读磁盘缓存，命中立即上屏（秒进），网络后台静默刷新。
    if (!silent && _groups.isEmpty) {
      if (_error == null) {
        final Map<String, dynamic>? cached =
            await MobilePageCache.instance.read(_cacheKey);
        if (!mounted) return;
        if (cached != null) {
          final List<_LibGroup> cachedGroups = <_LibGroup>[
            for (final Map<String, dynamic> g in _asList(cached["groups"]))
              _LibGroup.fromJson(g),
          ];
          setState(() {
            _groups = cachedGroups;
            _loading = false;
          });
          _warmMedia(cachedGroups);
          unawaited(_fetch(silent: true));
          return;
        }
      }
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    await _fetch(silent: silent);
  }

  Future<void> _fetch({required bool silent}) async {
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/library/items?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
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
      final List<_LibGroup> groups = <_LibGroup>[
        for (final Map<String, dynamic> g in _asList(body["groups"]))
          _LibGroup.fromJson(g),
      ];
      MobilePageCache.instance.write(_cacheKey, body);
      if (!mounted) return;
      setState(() {
        _groups = groups;
        _loading = false;
        _error = null;
      });
      _warmMedia(groups);
    } catch (e) {
      if (!mounted) return;
      // 静默刷新失败：已有数据保持展示（不闪错误页）；无数据才落到错误态。
      if (silent && _groups.isNotEmpty) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  static List<Map<String, dynamic>> _asList(Object? raw) {
    return ((raw as List<dynamic>?) ?? const <dynamic>[])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  /// 预加载上限：资料全部在本机服务端，量级可控；封顶防极端大库挤爆弱网。
  static const int _warmImageCap = 120;

  /// 图片预加载（2026-11-12）：数据一到就把照片（新→旧）+ 行程封面
  /// 预热进磁盘缓存，卡片/详情渲染即秒解，不再「进页后图慢慢浮出来」。
  /// warm 内部有界并发（4 路）+ 静默容错，失败不影响展示。
  void _warmMedia(List<_LibGroup> groups) {
    final List<String> urls = <String>[];
    for (final _LibGroup g in groups) {
      for (final _LibItem i in g.photos) {
        urls.add(i.fileUrl);
      }
      for (final _LibItem i in g.items) {
        final String cover = i.coverUrl.trim();
        if (cover.isEmpty) continue;
        urls.add(cover.startsWith("http") ? cover : "${ApiConfig.httpBase}$cover");
      }
      if (urls.length >= _warmImageCap) break;
    }
    if (urls.isEmpty) return;
    MediaDiskCache.instance.warm(urls.take(_warmImageCap));
  }

  /// 打开已完成行程：先拉完整行程（GET /travel/plans/:id），再推原生行程页。
  Future<void> _openTravelPlan(_LibItem item) async {
    if (item.planId.isEmpty || _openingPlan) return;
    if (ApiConfig.isOssEdition) return;
    _openingPlan = true;
    try {
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/travel/plans/${Uri.encodeComponent(item.planId)}"
        "?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}",
      );
      final http.Response res = await (widget.client ?? NbClient())
          .get(uri)
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw Exception("服务端返回 ${res.statusCode}");
      }
      final Object? decoded = jsonDecode(res.body);
      final Object? rawPlan = decoded is Map ? decoded["plan"] : null;
      if (rawPlan is! Map<String, dynamic>) {
        throw Exception("行程数据缺失");
      }
      if (!mounted) return;
      await TravelPlanMobilePage.show(
        context,
        plan: TravelPlanData.fromPlanJson(rawPlan),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("行程加载失败：$e", style: const TextStyle(fontSize: 12)),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ),
      );
    } finally {
      _openingPlan = false;
    }
  }

  List<_LibGroup> get _shown {
    final String q = _search.text.trim().toLowerCase();
    return _groups.where((g) {
      if (_filter != null && !g.hasType(_filter!)) return false;
      if (q.isEmpty) return true;
      return g.matchesQuery(q);
    }).toList(growable: false);
  }

  /// 筛选 chip 的计数：按条目数（与改版前一致，用户点前就知道筛完有多少条）。
  int _countOf(_LibFilter filter) {
    int n = 0;
    for (final _LibGroup g in _groups) {
      n += g.items.where((i) => _matchFilter(i.type, filter)).length;
    }
    return n;
  }

  int get _totalItems =>
      _groups.fold<int>(0, (sum, g) => sum + g.items.length);

  /// 「文件」= 文档 + 表格；其余三类与条目类型一一对应。
  static bool _matchFilter(_LibType type, _LibFilter filter) {
    switch (filter) {
      case _LibFilter.file:
        return type == _LibType.doc || type == _LibType.table;
      case _LibFilter.image:
        return type == _LibType.image;
      case _LibFilter.note:
        return type == _LibType.note;
      case _LibFilter.travel:
        return type == _LibType.travel;
    }
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("资料库"),
        actions: [
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh, size: 22),
            onPressed: _loading
                ? null
                : () => unawaited(_load(silent: _groups.isNotEmpty)),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : _error != null
              ? _buildError(p)
              : RefreshIndicator(
                  onRefresh: () => _load(silent: true),
                  child: _buildBody(p),
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
              "资料库获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
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

  Widget _buildBody(MobilePalette p) {
    final List<_LibGroup> shown = _shown;
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        // 搜索框（设计稿）
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: TextField(
            controller: _search,
            decoration: InputDecoration(
              prefixIcon: Icon(Icons.search, size: 20, color: p.textMuted),
              isDense: true,
              filled: true,
              fillColor: p.surface,
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(color: p.divider.withValues(alpha: 0.7)),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(color: p.divider.withValues(alpha: 0.7)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(color: p.accent.withValues(alpha: 0.5)),
              ),
              hintText: "搜索资料",
              hintStyle: TextStyle(color: p.textMuted, fontSize: 14),
            ),
          ),
        ),
        // 类型筛选 chips：单一筛选轴（全部/文件/图片/笔记/行程）。
        SizedBox(
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            children: [
              _chip(p, "全部", null, _totalItems),
              for (final _LibFilter f in _LibFilter.values)
                if (_countOf(f) > 0 || _filter == f)
                  _chip(p, _filterLabel(f), f, _countOf(f)),
            ],
          ),
        ),
        if (shown.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 48),
            child: Column(
              children: [
                Icon(Icons.folder_outlined, size: 44, color: p.textMuted),
                const SizedBox(height: 12),
                Text(
                  _groups.isEmpty
                      ? "还没有产出物\n对话里生成的文件、照片、笔记、行程\n都会按对话归档到这里"
                      : "没有匹配的资料",
                  textAlign: TextAlign.center,
                  style:
                      TextStyle(color: p.textMuted, fontSize: 14, height: 1.5),
                ),
              ],
            ),
          )
        else
          // 每次对话一张卡：缩略图 + 对话标题 + 产出统计
          for (final _LibGroup g in shown)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: _GroupCard(
                p: p,
                group: g,
                onTap: () => unawaited(_openGroup(g)),
              ),
            ),
      ],
    );
  }

  /// 进入会话详情：照片网格 → 全屏滑动查看；文件 → 仍在详情页点开。
  Future<void> _openGroup(_LibGroup group) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => _GroupDetailPage(
          group: group,
          onOpenTravel: _openTravelPlan,
        ),
      ),
    );
  }

  static String _filterLabel(_LibFilter f) {
    switch (f) {
      case _LibFilter.file:
        return "文件";
      case _LibFilter.image:
        return "图片";
      case _LibFilter.note:
        return "笔记";
      case _LibFilter.travel:
        return "行程";
    }
  }

  Widget _chip(MobilePalette p, String label, _LibFilter? filter, int count) {
    final bool selected = _filter == filter;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: GestureDetector(
        onTap: () => setState(() => _filter = filter),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(
            color: selected ? p.textPrimary : p.surface,
            borderRadius: BorderRadius.circular(999),
            border: selected
                ? null
                : Border.all(color: p.divider.withValues(alpha: 0.7)),
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
      ),
    );
  }
}

/// 一次对话的产出集合（服务端 groups[] 的一项）。
class _LibGroup {
  _LibGroup({
    required this.sessionId,
    required this.title,
    required this.updatedAt,
    required this.items,
  });

  final String sessionId;
  final String title;
  final DateTime updatedAt;
  final List<_LibItem> items;

  bool get isHistory => sessionId.isEmpty;

  /// 卡面标题：旁聊用注册表标题；主对话/历史按时间兜底。
  String get displayTitle {
    if (title.trim().isNotEmpty) return title.trim();
    if (isHistory) return "历史记录";
    return "对话 · ${_LibItem._fmt(updatedAt)}";
  }

  List<_LibItem> get photos =>
      items.where((i) => i.type == _LibType.image && i.fileName.isNotEmpty).toList();

  /// 非图片条目（详情页分区展示；图片统一走照片网格）。
  List<_LibItem> get others =>
      items.where((i) => i.type != _LibType.image).toList();

  bool hasType(_LibFilter filter) {
    return items.any((i) => MobileLibraryPageState._matchFilter(i.type, filter));
  }

  bool matchesQuery(String q) {
    if (displayTitle.toLowerCase().contains(q)) return true;
    return items.any((i) => i.title.toLowerCase().contains(q));
  }

  /// 卡面统计：「3 张图片 · 1 个文件 · 1 条笔记」。
  String get summary {
    final int images = photos.length;
    final int files =
        items.where((i) => i.type == _LibType.doc || i.type == _LibType.table).length;
    final int notes = items.where((i) => i.type == _LibType.note).length;
    final int travels = items.where((i) => i.type == _LibType.travel).length;
    final List<String> parts = <String>[
      if (images > 0) "$images 张图片",
      if (files > 0) "$files 个文件",
      if (notes > 0) "$notes 条笔记",
      if (travels > 0) "$travels 个行程",
    ];
    return parts.isEmpty ? "暂无产出" : parts.join(" · ");
  }

  static _LibGroup fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> items =
        (json["items"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final DateTime t =
        DateTime.tryParse(json["updatedAt"]?.toString() ?? "") ?? DateTime.now();
    return _LibGroup(
      sessionId: json["sessionId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      updatedAt: t,
      items: <_LibItem>[
        for (final Map<String, dynamic> f in MobileLibraryPageState._asList(items["files"]))
          _LibItem.fromFile(f),
        for (final Map<String, dynamic> img in MobileLibraryPageState._asList(items["images"]))
          _LibItem.fromImage(img),
        for (final Map<String, dynamic> n in MobileLibraryPageState._asList(items["notes"]))
          _LibItem.fromNote(n),
        for (final Map<String, dynamic> p in MobileLibraryPageState._asList(items["travelPlans"]))
          _LibItem.fromTravel(p),
      ],
    );
  }
}

class _LibItem {
  const _LibItem({
    required this.type,
    required this.title,
    required this.time,
    required this.source,
    this.fileName = "",
    this.size = 0,
    this.urlOverride = "",
    this.planId = "",
    this.coverUrl = "",
  });

  factory _LibItem.fromFile(Map<String, dynamic> f) {
    final String name = f["name"]?.toString() ?? "";
    final DateTime t =
        DateTime.tryParse(f["updatedAt"]?.toString() ?? "") ?? DateTime.now();
    return _LibItem(
      type: _typeOfFileName(name),
      title: name,
      time: t,
      source: "对话产出",
      fileName: name,
      size: (f["size"] as num?)?.toInt() ?? 0,
    );
  }

  /// 生成图 / 图搜转存图（`data/images/<actor>/`，服务端已给出可拉流 URL）。
  factory _LibItem.fromImage(Map<String, dynamic> img) {
    final String name = img["name"]?.toString() ?? "";
    final DateTime t =
        DateTime.tryParse(img["updatedAt"]?.toString() ?? "") ?? DateTime.now();
    return _LibItem(
      type: _LibType.image,
      title: "图片 ${_fmt(t)}",
      time: t,
      source: "生成 / 搜图",
      fileName: name,
      size: (img["size"] as num?)?.toInt() ?? 0,
      urlOverride: img["url"]?.toString() ?? "",
    );
  }

  factory _LibItem.fromNote(Map<String, dynamic> n) {
    final DateTime t =
        DateTime.tryParse(n["updatedAt"]?.toString() ?? "") ?? DateTime.now();
    return _LibItem(
      type: _LibType.note,
      title: n["title"]?.toString() ?? "",
      time: t,
      source: n["category"]?.toString() ?? "笔记",
    );
  }

  /// 已完成行程（服务端来自 travelPlanStore，与桌面端「行程」归档同一数据源）。
  factory _LibItem.fromTravel(Map<String, dynamic> t) {
    final int ms = (t["createdAt"] as num?)?.toInt() ?? 0;
    final String title = (t["title"]?.toString() ?? "").trim();
    final String dest = (t["destination"]?.toString() ?? "").trim();
    final int days = (t["dayCount"] as num?)?.toInt() ?? 0;
    final int stops = (t["stopCount"] as num?)?.toInt() ?? 0;
    final String start = t["startDate"]?.toString() ?? "";
    final String end = t["endDate"]?.toString() ?? "";
    final List<String> bits = <String>[
      if (days > 0) "$days 天",
      if (stops > 0) "$stops 站",
      if (start.isNotEmpty && end.isNotEmpty) "$start ~ $end",
    ];
    return _LibItem(
      type: _LibType.travel,
      title: title.isNotEmpty ? title : (dest.isNotEmpty ? dest : "未命名行程"),
      time: ms > 0 ? DateTime.fromMillisecondsSinceEpoch(ms) : DateTime.now(),
      source: bits.isEmpty ? "行程规划" : bits.join(" · "),
      planId: t["planId"]?.toString() ?? "",
      coverUrl: t["coverImage"]?.toString() ?? "",
    );
  }

  final _LibType type;
  final String title;
  final DateTime time;
  final String source;
  final String fileName;
  final int size;

  /// 服务端已给的可拉流地址（图片类使用）；空则按产出文件路由拼。
  final String urlOverride;

  /// 已完成行程 id（非空表示点按可打开原生行程页）。
  final String planId;

  /// 行程封面（可为 `/agent/travel-media/...` 相对地址）。
  final String coverUrl;

  static String _fmt(DateTime t) {
    final String mm = t.month.toString().padLeft(2, "0");
    final String dd = t.day.toString().padLeft(2, "0");
    final String hh = t.hour.toString().padLeft(2, "0");
    final String mi = t.minute.toString().padLeft(2, "0");
    return "$mm-$dd $hh:$mi";
  }

  static _LibType _typeOfFileName(String name) {
    final String ext = name.contains(".")
        ? name.substring(name.lastIndexOf(".") + 1).toLowerCase()
        : "";
    const tables = {"xlsx", "xls", "csv", "tsv"};
    const images = {"png", "jpg", "jpeg", "webp", "gif"};
    if (tables.contains(ext)) return _LibType.table;
    if (images.contains(ext)) return _LibType.image;
    return _LibType.doc;
  }

  String get typeLabel {
    switch (type) {
      case _LibType.doc:
        return "文档";
      case _LibType.table:
        return "表格";
      case _LibType.image:
        return "图片";
      case _LibType.note:
        return "笔记";
      case _LibType.travel:
        return "行程";
    }
  }

  String get timeLabel => _fmt(time);

  String get sizeLabel {
    if (size <= 0) return "";
    if (size < 1024) return "$size B";
    if (size < 1024 * 1024) return "${(size / 1024).toStringAsFixed(1)} KB";
    return "${(size / 1024 / 1024).toStringAsFixed(1)} MB";
  }

  String get fileUrl => urlOverride.isNotEmpty
      ? "${ApiConfig.httpBase}$urlOverride"
      : "${ApiConfig.httpBase}/agent/files/${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}/${Uri.encodeQueryComponent(fileName)}";
}

/// 对话卡片：最多 3 张照片缩略图 + 标题 + 产出统计，点卡进详情。
class _GroupCard extends StatelessWidget {
  const _GroupCard({required this.p, required this.group, required this.onTap});

  final MobilePalette p;
  final _LibGroup group;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final List<_LibItem> photos = group.photos.take(3).toList(growable: false);
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: p.divider.withValues(alpha: 0.5)),
        ),
        child: Row(
          children: [
            // 缩略图区：1~3 张并排；纯文件/笔记对话用类型色块兜底
            SizedBox(
              width: 116,
              height: 76,
              child: photos.isEmpty
                  ? _iconTile()
                  : Row(
                      children: [
                        for (int i = 0; i < photos.length; i++)
                          Expanded(
                            child: Padding(
                              padding: EdgeInsets.only(left: i == 0 ? 0 : 3),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: CachedMediaImage(
                                  url: photos[i].fileUrl,
                                  fit: BoxFit.cover,
                                  errorBuilder: (_, __, ___) => _iconTile(),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    group.displayTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    group.summary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textSecondary, fontSize: 12),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    group.isHistory
                        ? "来源信息缺失的早期产出"
                        : _LibItem._fmt(group.updatedAt),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 20, color: p.textMuted),
          ],
        ),
      ),
    );
  }

  Widget _iconTile() {
    final _LibItem? first = group.items.isEmpty ? null : group.items.first;
    final Color color = first == null ? const Color(0xFF9B7BDE) : _typeColor(first.type);
    return Container(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
      ),
      alignment: Alignment.center,
      child: Icon(
        first == null ? Icons.folder_outlined : _typeIcon(first.type),
        size: 30,
        color: color.withValues(alpha: 0.8),
      ),
    );
  }
}

/// 会话详情页：照片网格（点开全屏可左右滑）+ 文件 / 笔记 / 行程分区。
class _GroupDetailPage extends StatelessWidget {
  const _GroupDetailPage({required this.group, required this.onOpenTravel});

  final _LibGroup group;
  final Future<void> Function(_LibItem) onOpenTravel;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final List<_LibItem> photos = group.photos;
    final List<_LibItem> others = group.others;
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: Text(
          group.displayTitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: ListView(
        // edge-to-edge 后补底部手势条 inset，末尾条目不被手势区压住
        padding: EdgeInsets.fromLTRB(
          16,
          12,
          16,
          28 + MediaQuery.paddingOf(context).bottom,
        ),
        children: [
          Text(
            group.summary,
            style: TextStyle(color: p.textMuted, fontSize: 12),
          ),
          if (photos.isNotEmpty) ...[
            _sectionTitle(p, "照片 · ${photos.length}"),
            _photoGrid(context, photos),
          ],
          if (others.isNotEmpty) ...[
            _sectionTitle(p, "文件与记录 · ${others.length}"),
            for (final _LibItem item in others) _otherTile(context, p, item),
          ],
        ],
      ),
    );
  }

  Widget _sectionTitle(MobilePalette p, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 18, bottom: 8),
      child: Text(
        text,
        style: TextStyle(
          color: p.textPrimary,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  /// 照片网格：点任意一张 → 全屏查看（图池 = 本对话全部照片，左右滑动换图）。
  Widget _photoGrid(BuildContext context, List<_LibItem> photos) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 6,
        crossAxisSpacing: 6,
      ),
      itemCount: photos.length,
      itemBuilder: (BuildContext context, int index) {
        final _LibItem photo = photos[index];
        return GestureDetector(
          onTap: () => unawaited(showImagePreviewFullScreen(
            context,
            urls: photos.map((i) => i.fileUrl).toList(growable: false),
            index: index,
            source: group.displayTitle,
          )),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: CachedMediaImage(
              url: photo.fileUrl,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Container(
                color: _typeColor(_LibType.image).withValues(alpha: 0.10),
                alignment: Alignment.center,
                child: Icon(Icons.broken_image_outlined,
                    size: 22, color: _typeColor(_LibType.image)),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _otherTile(BuildContext context, MobilePalette p, _LibItem item) {
    final Color color = _typeColor(item.type);
    final VoidCallback? onTap = item.planId.isNotEmpty
        ? () => unawaited(onOpenTravel(item))
        : (item.type == _LibType.note
            ? null
            : () => unawaited(LinkUtils.launchExternal(item.fileUrl)));
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: p.divider.withValues(alpha: 0.5)),
          ),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(9),
                ),
                alignment: Alignment.center,
                child: Icon(_typeIcon(item.type), size: 18, color: color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: p.textPrimary, fontSize: 13),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      <String>[
                        item.typeLabel,
                        item.source,
                        if (item.sizeLabel.isNotEmpty) item.sizeLabel,
                      ].join(" · "),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: p.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              if (onTap != null)
                Icon(
                  item.planId.isNotEmpty ? Icons.chevron_right : Icons.open_in_new,
                  size: 16,
                  color: p.textMuted,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

IconData _typeIcon(_LibType type) {
  switch (type) {
    case _LibType.doc:
      return Icons.description_outlined;
    case _LibType.table:
      return Icons.table_chart_outlined;
    case _LibType.image:
      return Icons.image_outlined;
    case _LibType.note:
      return Icons.sticky_note_2_outlined;
    case _LibType.travel:
      return Icons.luggage_outlined;
  }
}

Color _typeColor(_LibType type) {
  switch (type) {
    case _LibType.doc:
      return const Color(0xFF5B8DEF);
    case _LibType.table:
      return const Color(0xFF34A853);
    case _LibType.image:
      return const Color(0xFFEA8C3C);
    case _LibType.note:
      return const Color(0xFF9B7BDE);
    case _LibType.travel:
      return const Color(0xFF2BB3A3);
  }
}
