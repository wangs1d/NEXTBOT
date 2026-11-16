// 快递列表（设计稿 SCREEN 04）。
//
// 待取 / 已取 / 全部分段；待取件取件码优先（黑底码块 + 强调描边）。
// 长按或点「选择」进入多选，底部黑色操作条：批量标记已取件 / 稍后提醒 / 归档。
// 已取件置灰、隐藏取件码，可撤销。
import "dart:async";

import "package:flutter/material.dart";

import "mobile_dynamics_api.dart";
import "mobile_dynamics_detail_page.dart";
import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

class DynamicsParcelListPage extends StatefulWidget {
  const DynamicsParcelListPage({
    super.key,
    required this.items,
    this.client,
    this.onChanged,
  });

  final List<Map<String, dynamic>> items;
  final dynamic client;
  final VoidCallback? onChanged;

  @override
  State<DynamicsParcelListPage> createState() => _DynamicsParcelListPageState();
}

class _DynamicsParcelListPageState extends State<DynamicsParcelListPage> {
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  late final List<Map<String, dynamic>> _items =
      widget.items.map((Map<String, dynamic> e) => Map<String, dynamic>.from(e)).toList();
  String _seg = "待取";
  bool _selecting = false;
  final Set<String> _selected = <String>{};
  bool _busy = false;

  List<Map<String, dynamic>> get _pending => _items
      .where((Map<String, dynamic> e) =>
          e["pickupCode"] != null && !dynamicsPickedUp(e))
      .toList();

  List<Map<String, dynamic>> get _picked =>
      _items.where(dynamicsPickedUp).toList();

  List<Map<String, dynamic>> get _visible => switch (_seg) {
        "待取" => _pending,
        "已取" => _picked,
        _ => _items,
      };

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("快递"),
        actions: <Widget>[
          TextButton(
            onPressed: () => setState(() {
              _selecting = !_selecting;
              if (!_selecting) _selected.clear();
            }),
            child: Text(_selecting ? "完成" : "选择",
                style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 12,
                    fontWeight: FontWeight.w500)),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(
                  14, 4, 14, _selecting ? 88 : 28),
              children: <Widget>[
                _segControl(p),
                if (_visible.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 48),
                    child: Center(
                      child: Text(_seg == "待取" ? "暂无待取件" : "暂无记录",
                          style:
                              TextStyle(color: p.textMuted, fontSize: 12.5)),
                    ),
                  )
                else if (_seg == "全部") ...<Widget>[
                  if (_pending.isNotEmpty) ...<Widget>[
                    _label(p, "待取件", "${_pending.length} 件 · 取件码优先"),
                    _card(p, _pending),
                  ],
                  if (_picked.isNotEmpty) ...<Widget>[
                    _label(p, "已取件", "${_picked.length} 件"),
                    _card(p, _picked),
                  ],
                ] else ...<Widget>[
                  _label(
                    p,
                    _seg == "待取" ? "待取件" : "已取件",
                    _seg == "待取"
                        ? "${_pending.length} 件 · 取件码优先"
                        : "${_picked.length} 件",
                  ),
                  _card(p, _visible),
                ],
                if (!_selecting) ...<Widget>[
                  _label(p, "长按任意一条进入多选"),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                          color: p.divider,
                          width: 1,
                          style: BorderStyle.solid),
                    ),
                    child: Text(
                      "多选后可批量「标记已取件 / 稍后提醒 / 归档」。\n已取件的包裹自动移入「已取件」，不再计入待取数量与底栏徽标。",
                      style: TextStyle(
                          color: p.textSecondary,
                          fontSize: 11,
                          height: 1.75),
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (_selecting) _actionBar(p),
        ],
      ),
    );
  }

  Widget _segControl(MobilePalette p) {
    final List<MapEntry<String, int>> segs = <MapEntry<String, int>>[
      MapEntry<String, int>("待取", _pending.length),
      MapEntry<String, int>("已取", _picked.length),
      MapEntry<String, int>("全部", _items.length),
    ];
    return Container(
      height: 32,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: p.surface2,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        children: <Widget>[
          for (final MapEntry<String, int> e in segs)
            Expanded(
              child: GestureDetector(
                onTap: () => setState(() {
                  _seg = e.key;
                  if (_selecting) _selected.clear();
                }),
                child: Container(
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: _seg == e.key ? p.surface : Colors.transparent,
                    borderRadius: BorderRadius.circular(7),
                    boxShadow: _seg == e.key
                        ? <BoxShadow>[
                            BoxShadow(
                                color: Colors.black.withValues(alpha: 0.06),
                                blurRadius: 3,
                                offset: const Offset(0, 1))
                          ]
                        : null,
                  ),
                  child: Text(
                    "${e.key} ${e.value}",
                    style: TextStyle(
                      color: _seg == e.key ? p.textPrimary : p.textSecondary,
                      fontSize: 11.5,
                      fontWeight: _seg == e.key
                          ? FontWeight.w600
                          : FontWeight.w400,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _label(MobilePalette p, String title, [String? count]) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 13, 4, 7),
      child: Row(
        children: <Widget>[
          Text(title,
              style: TextStyle(
                  color: p.textSecondary,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600)),
          if (count != null) ...<Widget>[
            const SizedBox(width: 6),
            Text(count,
                style: TextStyle(color: p.textMuted, fontSize: 10.5)),
          ],
        ],
      ),
    );
  }

  Widget _card(MobilePalette p, List<Map<String, dynamic>> rows) {
    final bool hasPending = rows.any(
        (Map<String, dynamic> e) => e["pickupCode"] != null && !dynamicsPickedUp(e));
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: hasPending ? p.textPrimary.withValues(alpha: 0.55) : p.divider,
        ),
      ),
      child: Column(
        children: <Widget>[
          for (final Map<String, dynamic> item in rows)
            _row(p, item, rows.last == item),
        ],
      ),
    );
  }

  Widget _row(MobilePalette p, Map<String, dynamic> item, bool last) {
    final bool picked = dynamicsPickedUp(item);
    final String? code = dynamicsText(item, "pickupCode");
    final String? id = dynamicsText(item, "id");
    final bool selected = id != null && _selected.contains(id);
    final String meta = <String>[
      if (dynamicsText(item, "trackingNo") != null)
        "单号 ${dynamicsText(item, "trackingNo")}",
      picked
          ? "${dynamicsFmtDay(dynamicsNum(item, "pickedUpAt"))} 已取件"
          : dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
    ].join(" · ");

    return Container(
      decoration: BoxDecoration(
        color: selected ? p.surface2 : Colors.transparent,
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            if (_selecting) {
              _toggle(id);
            } else {
              _openDetail(item);
            }
          },
          onLongPress: () {
            if (!_selecting) setState(() => _selecting = true);
            _toggle(id);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (_selecting) ...<Widget>[
                  Padding(
                    padding: const EdgeInsets.only(top: 2, right: 8),
                    child: Icon(
                      selected
                          ? Icons.check_circle_rounded
                          : Icons.radio_button_unchecked_rounded,
                      size: 18,
                      color: selected ? p.textPrimary : p.textMuted,
                    ),
                  ),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        dynamicsText(item, "title") ?? "快递",
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: picked ? p.textSecondary : p.textPrimary,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style:
                              TextStyle(color: p.textMuted, fontSize: 10.5)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (!picked && code != null)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: p.textPrimary,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      children: <Widget>[
                        Text("取件码",
                            style: TextStyle(
                                color: p.background.withValues(alpha: 0.62),
                                fontSize: 8,
                                letterSpacing: 1)),
                        Text(code,
                            style: TextStyle(
                                color: p.background,
                                fontSize: 13,
                                fontWeight: FontWeight.w600)),
                      ],
                    ),
                  )
                else if (picked)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: p.surface2,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text("已取件",
                        style: TextStyle(
                            color: p.textMuted,
                            fontSize: 9,
                            fontWeight: FontWeight.w500)),
                  )
                else
                  Text("无需取件码",
                      style: TextStyle(color: p.textMuted, fontSize: 9.5)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _actionBar(MobilePalette p) {
    return Container(
      color: p.textPrimary,
      padding: EdgeInsets.fromLTRB(
          16, 10, 12, 10 + MediaQuery.of(context).padding.bottom),
      child: Row(
        children: <Widget>[
          Text("已选 ${_selected.length} 项",
              style: TextStyle(
                  color: p.background.withValues(alpha: 0.75), fontSize: 11)),
          const Spacer(),
          _barAction(p, "标记已取件", _busy ? null : _batchPickup),
          _barAction(p, "稍后提醒", _busy ? null : _batchSnooze),
          _barAction(p, "归档", _busy ? null : _batchArchive, last: true),
        ],
      ),
    );
  }

  Widget _barAction(MobilePalette p, String label, VoidCallback? onTap,
      {bool last = false}) {
    return Padding(
      padding: EdgeInsets.only(left: last ? 0 : 12),
      child: GestureDetector(
        onTap: onTap,
        child: Text(
          label,
          style: TextStyle(
            color: onTap == null
                ? p.background.withValues(alpha: 0.4)
                : p.background,
            fontSize: 11,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
    );
  }

  void _toggle(String? id) {
    if (id == null) return;
    setState(() {
      if (_selected.contains(id)) {
        _selected.remove(id);
      } else {
        _selected.add(id);
      }
    });
  }

  Future<void> _openDetail(Map<String, dynamic> item) async {
    final Map<String, dynamic>? updated = await Navigator.of(context)
        .push<Map<String, dynamic>>(MaterialPageRoute<Map<String, dynamic>>(
      builder: (_) => ParcelDetailPage(item: item, client: widget.client),
    ));
    if (!mounted || updated == null) return;
    final int idx =
        _items.indexWhere((Map<String, dynamic> e) => e["id"] == item["id"]);
    if (idx >= 0) setState(() => _items[idx] = updated);
    widget.onChanged?.call();
  }

  Future<void> _batchPickup() async {
    if (_selected.isEmpty) return;
    setState(() => _busy = true);
    try {
      for (final String id in _selected.toList()) {
        final int idx =
            _items.indexWhere((Map<String, dynamic> e) => e["id"] == id);
        if (idx < 0) continue;
        if (dynamicsPickedUp(_items[idx])) continue;
        final Map<String, dynamic> res = await _api.setPickedUp(id, true);
        final Map<String, dynamic>? updated =
            res["item"] as Map<String, dynamic>?;
        if (updated != null) _items[idx] = updated;
      }
      if (!mounted) return;
      setState(() {
        _selected.clear();
        _selecting = false;
        _busy = false;
      });
      widget.onChanged?.call();
      _snack("已批量标记取件");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("操作失败：$e");
    }
  }

  Future<void> _batchSnooze() async {
    if (_selected.isEmpty) return;
    final DateTime now = DateTime.now();
    final DateTime until = DateTime(now.year, now.month, now.day + 1, 9);
    setState(() => _busy = true);
    try {
      for (final String id in _selected) {
        await _api.snooze(id, until);
      }
      if (!mounted) return;
      setState(() {
        _selected.clear();
        _selecting = false;
        _busy = false;
      });
      widget.onChanged?.call();
      _snack("已设为明天 9:00 提醒");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("操作失败：$e");
    }
  }

  Future<void> _batchArchive() async {
    if (_selected.isEmpty) return;
    setState(() => _busy = true);
    try {
      for (final String id in _selected) {
        await _api.archive(id);
      }
      if (!mounted) return;
      setState(() {
        _items.removeWhere(
            (Map<String, dynamic> e) => _selected.contains(e["id"]));
        _selected.clear();
        _selecting = false;
        _busy = false;
      });
      widget.onChanged?.call();
      _snack("已归档");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("操作失败：$e");
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
          content: Text(text), duration: const Duration(seconds: 2)));
  }
}
