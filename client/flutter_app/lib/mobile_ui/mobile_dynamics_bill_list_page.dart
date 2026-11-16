// 账单列表（设计稿 SCREEN 03）。
//
// 承担「查」：搜索 + 来源/类型筛选 + 近 30 天统计 + 今天/昨天/更早分组。
// 状态口径：已报销绿标；记错了红标且金额删除线（已从合计扣除）；疑似重复琥珀标。
// 滑动：右滑标记已报销、左滑归档，均带撤销。
import "dart:async";

import "package:flutter/material.dart";

import "mobile_dynamics_api.dart";
import "mobile_dynamics_detail_page.dart";
import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

class DynamicsBillListPage extends StatefulWidget {
  const DynamicsBillListPage({
    super.key,
    required this.items,
    this.byType = const <Map<String, dynamic>>[],
    this.stats = const <String, dynamic>{},
    this.duplicateIds = const <String>{},
    this.client,
    this.onAskAgent,
    this.onChanged,
  });

  final List<Map<String, dynamic>> items;
  final List<Map<String, dynamic>> byType;
  final Map<String, dynamic> stats;
  final Set<String> duplicateIds;
  final dynamic client;
  final void Function(String prompt)? onAskAgent;
  final VoidCallback? onChanged;

  @override
  State<DynamicsBillListPage> createState() => _DynamicsBillListPageState();
}

class _DynamicsBillListPageState extends State<DynamicsBillListPage> {
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  late final List<Map<String, dynamic>> _items =
      widget.items.map((Map<String, dynamic> e) => Map<String, dynamic>.from(e)).toList();
  final TextEditingController _search = TextEditingController();
  String _source = "全部";
  String _type = "全部类型";

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<String> get _types {
    final List<String> out = <String>["全部类型"];
    for (final Map<String, dynamic> row in widget.byType) {
      final String? t = dynamicsText(row, "type");
      if (t != null && !out.contains(t)) out.add(t);
    }
    return out;
  }

  List<Map<String, dynamic>> get _filtered {
    final String q = _search.text.trim().toLowerCase();
    return _items.where((Map<String, dynamic> e) {
      if (_source != "全部" && dynamicsSourceShort(e["source"]) != _source) {
        return false;
      }
      if (_type != "全部类型" && (dynamicsText(e, "billType") ?? "其他") != _type) {
        return false;
      }
      if (q.isEmpty) return true;
      final String hay =
          "${dynamicsText(e, "title") ?? ""} ${dynamicsText(e, "excerpt") ?? ""} ${e["amount"] ?? ""}"
              .toLowerCase();
      return hay.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final List<Map<String, dynamic>> filtered = _filtered;
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("账单"),
        actions: <Widget>[
          IconButton(
            tooltip: "筛选",
            icon: const Icon(Icons.filter_list_rounded, size: 21),
            onPressed: () => _showFilterSheet(p),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 28),
        children: <Widget>[
          _searchBar(p),
          const SizedBox(height: 8),
          _chips(
            p,
            <String>["全部", "短信", "邮件", "通知"],
            _source,
            (String v) => setState(() => _source = v),
          ),
          const SizedBox(height: 5),
          _chips(p, _types.take(6).toList(), _type,
              (String v) => setState(() => _type = v)),
          const SizedBox(height: 9),
          _statsCard(p),
          ..._buildGroups(p, filtered),
          if (filtered.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 40),
              child: Center(
                child: Text("没有符合条件的账单",
                    style: TextStyle(color: p.textMuted, fontSize: 12.5)),
              ),
            ),
        ],
      ),
    );
  }

  List<Widget> _buildGroups(
      MobilePalette p, List<Map<String, dynamic>> filtered) {
    final List<Widget> out = <Widget>[];
    for (final MapEntry<String, List<Map<String, dynamic>>> group
        in dynamicsGroupByDay(filtered)) {
      out.add(Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 7),
        child: Text(group.key,
            style: TextStyle(
                color: p.textSecondary,
                fontSize: 11.5,
                fontWeight: FontWeight.w600)),
      ));
      out.add(Container(
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: p.divider),
        ),
        child: Column(
          children: <Widget>[
            for (final Map<String, dynamic> item in group.value)
              _row(p, item, group.value.last == item),
          ],
        ),
      ));
    }
    return out;
  }

  Widget _row(MobilePalette p, Map<String, dynamic> item, bool last) {
    final String? status = dynamicsBillStatus(item);
    final bool wrong = status == "wrong";
    final bool duplicate = widget.duplicateIds.contains(item["id"]);
    final num amount = dynamicsNum(item, "amount");
    final String meta = <String>[
      dynamicsSourceLabel(item["source"]),
      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
      if (duplicate) "与同额账单时间接近",
      if (wrong) "已标记记错了",
    ].where((String s) => s.isNotEmpty).join(" · ");

    final Widget row = Container(
      padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 12),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  dynamicsText(item, "title") ?? "账单",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: wrong ? p.textSecondary : p.textPrimary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w500),
                ),
                const SizedBox(height: 2),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: p.textMuted, fontSize: 10.5),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            "¥${dynamicsFmtAmount(amount.abs())}",
            style: TextStyle(
              color: wrong ? p.textMuted : p.textPrimary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              decoration: wrong ? TextDecoration.lineThrough : null,
            ),
          ),
          if (status != null) ...<Widget>[
            const SizedBox(width: 5),
            _statusChip(context, wrong ? "记错了" : "已报销", wrong: wrong),
          ] else if (duplicate) ...<Widget>[
            const SizedBox(width: 5),
            _statusChip(context, "疑似重复", amber: true),
          ],
        ],
      ),
    );

    final Widget dismissible = Dismissible(
      key: ValueKey<String>("bill:${item["id"]}"),
      direction: DismissDirection.horizontal,
      background: _swipeBg(p, true),
      secondaryBackground: _swipeBg(p, false),
      confirmDismiss: (DismissDirection dir) =>
          _onSwipe(item, dir == DismissDirection.startToEnd),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () => _openDetail(item),
          child: row,
        ),
      ),
    );
    return dismissible;
  }

  Widget _swipeBg(MobilePalette p, bool complete) {
    return Container(
      color: complete ? DynamicsTone.greenBg(context) : p.surface2,
      alignment: complete ? Alignment.centerLeft : Alignment.centerRight,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Text(
        complete ? "标记已报销" : "归档",
        style: TextStyle(
            color: complete ? DynamicsTone.greenFg(context) : p.textSecondary,
            fontSize: 11,
            fontWeight: FontWeight.w500),
      ),
    );
  }

  Widget _statusChip(BuildContext context, String label,
      {bool wrong = false, bool amber = false}) {
    final Color fg = wrong
        ? DynamicsTone.redFg(context)
        : amber
            ? DynamicsTone.amberFg(context)
            : DynamicsTone.greenFg(context);
    final Color bg = wrong
        ? DynamicsTone.redBg(context)
        : amber
            ? DynamicsTone.amberBg(context)
            : DynamicsTone.greenBg(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration:
          BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(label,
          style:
              TextStyle(color: fg, fontSize: 9, fontWeight: FontWeight.w500)),
    );
  }

  Widget _searchBar(MobilePalette p) {
    return Container(
      height: 38,
      padding: const EdgeInsets.symmetric(horizontal: 11),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: p.divider),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.search_rounded, size: 17, color: p.textMuted),
          const SizedBox(width: 7),
          Expanded(
            child: TextField(
              controller: _search,
              onChanged: (_) => setState(() {}),
              style: TextStyle(color: p.textPrimary, fontSize: 12.5),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: "搜索商家、标题、金额",
                hintStyle: TextStyle(color: p.textMuted, fontSize: 12.5),
              ),
            ),
          ),
          if (_search.text.isNotEmpty)
            GestureDetector(
              onTap: () {
                _search.clear();
                setState(() {});
              },
              child: Icon(Icons.close_rounded, size: 15, color: p.textMuted),
            ),
        ],
      ),
    );
  }

  Widget _chips(MobilePalette p, List<String> values, String selected,
      ValueChanged<String> onTap) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: <Widget>[
          for (final String v in values)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: GestureDetector(
                onTap: () => onTap(v),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: v == selected ? p.textPrimary : p.surface,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(
                        color: v == selected ? p.textPrimary : p.divider),
                  ),
                  child: Text(
                    v,
                    style: TextStyle(
                      color: v == selected ? p.background : p.textSecondary,
                      fontSize: 10.5,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _statsCard(MobilePalette p) {
    final num total = dynamicsNum(widget.stats, "totalAmount");
    final num count = dynamicsNum(widget.stats, "count");
    final num reimbursed = dynamicsNum(widget.stats, "reimbursedCount");
    final num wrong = dynamicsNum(widget.stats, "wrongCount");
    final List<Map<String, dynamic>> rows = widget.byType.take(3).toList();
    final num max = rows.isEmpty
        ? 1
        : rows
            .map((Map<String, dynamic> e) => dynamicsNum(e, "amount"))
            .fold<num>(0, (num a, num b) => a > b ? a : b);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text("¥${dynamicsFmtAmount(total)}",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 21,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.3)),
              const SizedBox(width: 8),
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Text("近 30 天 · ${count.toInt()} 笔",
                    style: TextStyle(color: p.textMuted, fontSize: 10.5)),
              ),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            "已报销 ${reimbursed.toInt()} 笔 · 记错了 ${wrong.toInt()} 笔（已从合计扣除）",
            style: TextStyle(color: p.textMuted, fontSize: 10),
          ),
          if (rows.isNotEmpty) ...<Widget>[
            const SizedBox(height: 9),
            for (final Map<String, dynamic> row in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: <Widget>[
                    SizedBox(
                      width: 60,
                      child: Text(
                        dynamicsText(row, "type") ?? "其他",
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            TextStyle(color: p.textSecondary, fontSize: 10.5),
                      ),
                    ),
                    Expanded(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(2),
                        child: LinearProgressIndicator(
                          value: max <= 0
                              ? 0
                              : dynamicsNum(row, "amount") / max,
                          minHeight: 4,
                          backgroundColor: p.surface2,
                          valueColor:
                              AlwaysStoppedAnimation<Color>(p.textPrimary),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      "¥${dynamicsFmtAmount(dynamicsNum(row, "amount"))}",
                      style:
                          TextStyle(color: p.textSecondary, fontSize: 10.5),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  Future<void> _openDetail(Map<String, dynamic> item) async {
    final Map<String, dynamic>? updated = await Navigator.of(context)
        .push<Map<String, dynamic>>(MaterialPageRoute<Map<String, dynamic>>(
      builder: (_) => BillDetailPage(
        item: item,
        byType: widget.byType,
        client: widget.client,
        onAskAgent: widget.onAskAgent,
      ),
    ));
    if (!mounted || updated == null) return;
    final int idx = _items.indexWhere((Map<String, dynamic> e) => e["id"] == item["id"]);
    if (idx >= 0) setState(() => _items[idx] = updated);
    widget.onChanged?.call();
  }

  Future<bool> _onSwipe(Map<String, dynamic> item, bool complete) async {
    final int idx = _items.indexOf(item);
    if (idx < 0) return false;
    setState(() => _items.removeAt(idx));
    final String id = dynamicsText(item, "id") ?? "";
    try {
      if (complete) {
        await _api.reviewBill(id, "reimbursed");
      } else {
        await _api.archive(id);
      }
      widget.onChanged?.call();
      if (!mounted) return true;
      final SnackBar bar = SnackBar(
        content: Text(complete ? "已标记为已报销" : "已归档"),
        duration: const Duration(seconds: 3),
        action: SnackBarAction(
          label: "撤销",
          onPressed: () async {
            final int restoreAt = idx < 0
                ? 0
                : (idx > _items.length ? _items.length : idx);
            setState(() => _items.insert(restoreAt, item));
            if (complete) {
              await _api.reviewBill(id, null);
            } else {
              await _api.archive(id, archived: false);
            }
            widget.onChanged?.call();
          },
        ),
      );
      ScaffoldMessenger.of(context).showSnackBar(bar);
      return true;
    } catch (e) {
      if (mounted) {
        final int restoreAt = idx < 0
            ? 0
            : (idx > _items.length ? _items.length : idx);
        setState(() => _items.insert(restoreAt, item));
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("操作失败：$e")));
      }
      return false;
    }
  }

  void _showFilterSheet(MobilePalette p) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (BuildContext ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text("筛选",
                    style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 15,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 10),
                Text("当前：$_source · $_type",
                    style: TextStyle(color: p.textSecondary, fontSize: 12)),
                const SizedBox(height: 14),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () {
                          setState(() {
                            _source = "全部";
                            _type = "全部类型";
                            _search.clear();
                          });
                          Navigator.pop(ctx);
                        },
                        child: const Text("重置"),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text("完成"),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
