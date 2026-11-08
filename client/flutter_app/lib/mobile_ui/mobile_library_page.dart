import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/utils/link_utils.dart";
import "../features/chat/media_disk_cache.dart";
import "mobile_theme.dart";

/// 手机端「资料库」页（按 2026-11-07 设计稿一比一还原）。
///
/// 布局：顶部搜索框 + 类型筛选 chips（全部/文档/表格/图片/笔记/行程）+
/// 双列网格卡片（图片类带真缩略图，其余带类型色块），卡面含名称、类型、
/// 时间、来源。文件点按经系统浏览器打开 `/agent/files/<actor>/<name>`，
/// 图片点按打开 `/agent/images/<actor>/<name>`。
/// 数据源：GET /api/library/items?sessionId=<账号 id>（服务端一次聚合，
/// sections.files / sections.images / sections.notes / sections.travelPlans）。
class MobileLibraryPage extends StatefulWidget {
  const MobileLibraryPage({super.key, this.client});

  /// 注入 http client(测试用)。
  final http.Client? client;

  @override
  State<MobileLibraryPage> createState() => MobileLibraryPageState();
}

/// 资料条目类型（筛选 chips 与卡片角标共用）。
enum _LibType { doc, table, image, note, travel }

class MobileLibraryPageState extends State<MobileLibraryPage> {
  bool _loading = true;
  String? _error;
  List<_LibItem> _items = const <_LibItem>[];
  _LibType? _filter;
  final TextEditingController _search = TextEditingController();

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
          "${ApiConfig.httpBase}/api/library/items?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
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
      final Map<String, dynamic> sections =
          (body["sections"] as Map<String, dynamic>?) ??
              const <String, dynamic>{};
      final List<_LibItem> items = <_LibItem>[
        for (final Map<String, dynamic> f in _asList(sections["files"]))
          _LibItem.fromFile(f),
        for (final Map<String, dynamic> img in _asList(sections["images"]))
          _LibItem.fromImage(img),
        for (final Map<String, dynamic> n in _asList(sections["notes"]))
          _LibItem.fromNote(n),
        for (final Map<String, dynamic> t in _asList(sections["travelPlans"]))
          _LibItem.fromTravel(t),
      ]..sort((a, b) => b.time.compareTo(a.time));
      if (!mounted) return;
      setState(() {
        _items = items;
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

  static List<Map<String, dynamic>> _asList(Object? raw) {
    return ((raw as List<dynamic>?) ?? const <dynamic>[])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  List<_LibItem> get _filtered {
    final String q = _search.text.trim().toLowerCase();
    return _items.where((i) {
      if (_filter != null && i.type != _filter) return false;
      if (q.isEmpty) return true;
      return i.title.toLowerCase().contains(q);
    }).toList();
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
    final List<_LibItem> shown = _filtered;
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
        // 类型筛选 chips（设计稿：文档/表格/图片/笔记/行程）
        SizedBox(
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            children: [
              _chip(p, "全部", null, _items.length),
              for (final _LibType t in _LibType.values)
                _chip(p, _typeLabel(t), t,
                    _items.where((i) => i.type == t).length),
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
                  _items.isEmpty
                      ? "还没有产出物\n对话里生成的文件、笔记、行程规划\n都会自动归档到这里"
                      : "没有匹配的资料",
                  textAlign: TextAlign.center,
                  style:
                      TextStyle(color: p.textMuted, fontSize: 14, height: 1.5),
                ),
              ],
            ),
          )
        else
          // 双列网格卡片（设计稿：缩略图 + 类型 + 时间 + 来源）
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 0.92,
            ),
            itemCount: shown.length,
            itemBuilder: (BuildContext context, int index) =>
                _LibCard(p: p, item: shown[index]),
          ),
      ],
    );
  }

  static String _typeLabel(_LibType t) {
    switch (t) {
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

  Widget _chip(MobilePalette p, String label, _LibType? type, int count) {
    final bool selected = _filter == type;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: GestureDetector(
        onTap: () => setState(() => _filter = type),
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
              // 计数恒展示（含 0）：chips 宽度节奏一致
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

class _LibItem {
  const _LibItem({
    required this.type,
    required this.title,
    required this.time,
    required this.source,
    this.fileName = "",
    this.size = 0,
    this.urlOverride = "",
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
      title: _imageTitle(t),
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

  factory _LibItem.fromTravel(Map<String, dynamic> t) {
    final int ms = (t["updatedAt"] as num?)?.toInt() ?? 0;
    return _LibItem(
      type: _LibType.travel,
      title: (t["destination"]?.toString() ?? "").isNotEmpty
          ? t["destination"].toString()
          : (t["originalMessage"]?.toString() ?? "未命名行程"),
      time: ms > 0 ? DateTime.fromMillisecondsSinceEpoch(ms) : DateTime.now(),
      source: t["state"]?.toString() ?? "行程规划",
    );
  }

  final _LibType type;
  final String title;
  final DateTime time;

  /// 来源（设计稿卡面要素）：文件=对话产出，图片=生成/搜图，笔记=分类，行程=状态。
  final String source;
  final String fileName;
  final int size;

  /// 服务端已给的可拉流地址（图片类使用）；空则按产出文件路由拼。
  final String urlOverride;

  /// 图片没有可读文件名（服务端落盘名是「时间戳-uuid8.png」），用时间作卡面标题。
  static String _imageTitle(DateTime t) {
    final String mm = t.month.toString().padLeft(2, "0");
    final String dd = t.day.toString().padLeft(2, "0");
    final String hh = t.hour.toString().padLeft(2, "0");
    final String mi = t.minute.toString().padLeft(2, "0");
    return "图片 $mm-$dd $hh:$mi";
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

  String get timeLabel {
    final String mm = time.month.toString().padLeft(2, "0");
    final String dd = time.day.toString().padLeft(2, "0");
    final String hh = time.hour.toString().padLeft(2, "0");
    final String mi = time.minute.toString().padLeft(2, "0");
    return "$mm-$dd $hh:$mi";
  }

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

/// 网格卡片：图片类真缩略图，其余类型色块 + 图标。
class _LibCard extends StatelessWidget {
  const _LibCard({required this.p, required this.item});

  final MobilePalette p;
  final _LibItem item;

  IconData get _icon {
    switch (item.type) {
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

  Color get _tileColor {
    switch (item.type) {
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

  @override
  Widget build(BuildContext context) {
    final bool isImage =
        item.type == _LibType.image && item.fileName.isNotEmpty;
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: item.fileName.isEmpty
          ? null
          : () => unawaited(LinkUtils.launchExternal(item.fileUrl)),
      child: Container(
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: p.divider.withValues(alpha: 0.5)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 缩略图区：图片 = 真图；其余 = 类型色块
            Expanded(
              child: ClipRRect(
                borderRadius:
                    const BorderRadius.vertical(top: Radius.circular(13)),
                child: SizedBox(
                  width: double.infinity,
                  child: isImage
                      ? CachedMediaImage(
                          url: item.fileUrl,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => _iconTile(),
                        )
                      : _iconTile(),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                          color: _tileColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          item.typeLabel,
                          style: TextStyle(color: _tileColor, fontSize: 10),
                        ),
                      ),
                      const Spacer(),
                      Text(
                        item.timeLabel,
                        style: TextStyle(color: p.textMuted, fontSize: 10),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.source,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: p.textMuted, fontSize: 10),
                        ),
                      ),
                      if (item.sizeLabel.isNotEmpty)
                        Text(
                          item.sizeLabel,
                          style: TextStyle(color: p.textMuted, fontSize: 10),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _iconTile() {
    return Container(
      color: _tileColor.withValues(alpha: 0.08),
      alignment: Alignment.center,
      child: Icon(_icon, size: 34, color: _tileColor.withValues(alpha: 0.75)),
    );
  }
}
