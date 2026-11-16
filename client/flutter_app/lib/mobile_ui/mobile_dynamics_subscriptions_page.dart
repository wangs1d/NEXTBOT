// 订阅与续费（设计稿 SCREEN 02）。
//
// 数据来自 /api/dynamics → subscriptions（只读台账的续费识别结果）。
// 安全边界：不登录第三方账号；「去取消」只展示官方取消路径，不代操作。
// 「保留」会真正忽略该条建议（POST dismiss），首页可省金额随之刷新。
import "dart:async";

import "package:flutter/material.dart";

import "mobile_dynamics_api.dart";
import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

class DynamicsSubscriptionsPage extends StatefulWidget {
  const DynamicsSubscriptionsPage({
    super.key,
    required this.data,
    this.client,
    this.onChanged,
    this.onOpenBills,
  });

  final Map<String, dynamic> data;
  final dynamic client;
  final VoidCallback? onChanged;
  final VoidCallback? onOpenBills;

  @override
  State<DynamicsSubscriptionsPage> createState() =>
      _DynamicsSubscriptionsPageState();
}

class _DynamicsSubscriptionsPageState extends State<DynamicsSubscriptionsPage> {
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  late final List<Map<String, dynamic>> _items = _list("items");
  late final List<Map<String, dynamic>> _alerts = _list("alerts");
  late num _monthlyTotal = dynamicsNum(widget.data, "monthlyTotal");
  late num _savings = dynamicsNum(widget.data, "savingsPerMonth");
  bool _busy = false;

  List<Map<String, dynamic>> _list(String key) {
    final List<dynamic> raw =
        (widget.data[key] as List<dynamic>?) ?? const <dynamic>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map((Map<String, dynamic> e) => Map<String, dynamic>.from(e))
        .toList();
  }

  List<Map<String, dynamic>> get _cancellable => _items
      .where((Map<String, dynamic> e) => e["suggestion"] == "cancel")
      .toList();

  void _recalc() {
    _monthlyTotal = _items.fold<num>(
        0, (num sum, Map<String, dynamic> e) => sum + dynamicsNum(e, "amount"));
    _savings = _cancellable.fold<num>(
        0, (num sum, Map<String, dynamic> e) => sum + dynamicsNum(e, "amount"));
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final num nextCharge = dynamicsNum(widget.data, "nextChargeAt");
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("订阅与续费"),
        actions: <Widget>[
          TextButton(
            onPressed: () => _showExplainer(p),
            child: Text("说明",
                style: TextStyle(color: p.textSecondary, fontSize: 12)),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 28),
        children: <Widget>[
          _hero(p, nextCharge),
          if (_cancellable.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            _savingHint(p),
          ],
          _label(p, "自动续费中", "${_items.length} 项"),
          if (_items.isEmpty)
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.divider),
              ),
              child: Text(
                "还没有识别到自动续费。账单/短信里出现「连续包月 / 自动续费」且近 90 天至少扣款 2 次时，这里会自动出现。",
                style: TextStyle(
                    color: p.textSecondary, fontSize: 11.5, height: 1.7),
              ),
            )
          else
            Container(
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.divider),
              ),
              child: Column(
                children: <Widget>[
                  for (final Map<String, dynamic> item in _items)
                    _itemRow(p, item, _items.last == item),
                ],
              ),
            ),
          if (_alerts.isNotEmpty) ...<Widget>[
            _label(p, "可能重复 / 已涨价"),
            Container(
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.divider),
              ),
              child: Column(
                children: <Widget>[
                  for (final Map<String, dynamic> a in _alerts)
                    _alertRow(p, a, _alerts.last == a),
                ],
              ),
            ),
          ],
          const SizedBox(height: 11),
          _sourceHint(p),
        ],
      ),
    );
  }

  Widget _hero(MobilePalette p, num nextCharge) {
    final int cancelCount = _cancellable.length;
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                    color: p.textPrimary,
                    borderRadius: BorderRadius.circular(999)),
                child: Text("省钱助手",
                    style: TextStyle(
                        color: p.background,
                        fontSize: 9.5,
                        fontWeight: FontWeight.w500)),
              ),
              const SizedBox(width: 7),
              if (_savings > 0)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                      color: DynamicsTone.greenBg(context),
                      borderRadius: BorderRadius.circular(999)),
                  child: Text("本月可省 ¥${dynamicsFmtAmount(_savings)}",
                      style: TextStyle(
                          color: DynamicsTone.greenFg(context),
                          fontSize: 9.5,
                          fontWeight: FontWeight.w500)),
                ),
            ],
          ),
          const SizedBox(height: 11),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text("¥${dynamicsFmtAmount(_monthlyTotal)}",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 28,
                      height: 1,
                      letterSpacing: -0.6,
                      fontWeight: FontWeight.w600)),
              const SizedBox(width: 7),
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Text("每月自动续费",
                    style: TextStyle(color: p.textMuted, fontSize: 10.5)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            "${_items.length} 个订阅"
            "${nextCharge > 0 ? " · 下次扣款 ${dynamicsFmtDate(nextCharge)}" : ""}"
            "${cancelCount > 0 ? " · 建议取消 $cancelCount 个" : ""}",
            style: TextStyle(color: p.textSecondary, fontSize: 10.5),
          ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy || _items.isEmpty
                      ? null
                      : () => _remindAll(),
                  style: OutlinedButton.styleFrom(
                    side: BorderSide(color: p.divider),
                    padding: EdgeInsets.zero,
                    minimumSize: const Size.fromHeight(30),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8)),
                  ),
                  child: Text("提醒我续费前 3 天",
                      style: TextStyle(color: p.textPrimary, fontSize: 10.5)),
                ),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: FilledButton(
                  onPressed: widget.onOpenBills,
                  style: FilledButton.styleFrom(
                    backgroundColor: p.textPrimary,
                    foregroundColor: p.background,
                    padding: EdgeInsets.zero,
                    minimumSize: const Size.fromHeight(30),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8)),
                  ),
                  child: const Text("查看全部扣款",
                      style: TextStyle(fontSize: 10.5)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _savingHint(MobilePalette p) {
    final Map<String, dynamic> first = _cancellable.first;
    final num amount = dynamicsNum(first, "amount");
    final String name = dynamicsText(first, "name") ?? "订阅";
    final String reason = dynamicsText(first, "reason") ??
        "近 90 天扣款 ${dynamicsNum(first, "chargedCount").toInt()} 次";
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: DynamicsTone.greenBg(context),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: DynamicsTone.greenFg(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.auto_awesome, size: 12,
                  color: DynamicsTone.greenFg(context)),
              const SizedBox(width: 5),
              Text("发现 ${_cancellable.length} 个可以省掉的订阅",
                  style: TextStyle(
                      color: DynamicsTone.greenFg(context),
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(text: "$name：$reason；按 ¥${dynamicsFmtAmount(amount)}/月 计算，取消后每年可省 "),
                TextSpan(
                  text: "¥${dynamicsFmtAmount(amount * 12)}",
                  style: TextStyle(
                      color: DynamicsTone.greenFg(context),
                      fontWeight: FontWeight.w600),
                ),
                const TextSpan(text: "。"),
              ],
            ),
            style: TextStyle(
                color: p.textSecondary, fontSize: 11.5, height: 1.7),
          ),
        ],
      ),
    );
  }

  Widget _itemRow(MobilePalette p, Map<String, dynamic> item, bool last) {
    final bool cancel = item["suggestion"] == "cancel";
    final bool remindSet = item["remindAt"] != null;
    final num amount = dynamicsNum(item, "amount");
    final num next = dynamicsNum(item, "nextChargeAt");
    final int charged = dynamicsNum(item, "chargedCount").toInt();
    final String meta = "连续包月 ¥${dynamicsFmtAmount(amount)}/月 · "
        "${next > 0 ? "下次 ${dynamicsFmtDate(next)}" : ""} · 已扣 $charged 次"
        "${remindSet ? " · 已设提醒" : ""}";
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 26,
            height: 26,
            margin: const EdgeInsets.only(top: 1),
            decoration: BoxDecoration(
                color: p.surface2, borderRadius: BorderRadius.circular(8)),
            child: Icon(Icons.autorenew_rounded,
                size: 14, color: p.textPrimary),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(dynamicsText(item, "name") ?? "订阅",
                    style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500)),
                const SizedBox(height: 2),
                Text(meta,
                    style:
                        TextStyle(color: p.textMuted, fontSize: 10.5)),
                if (cancel && dynamicsText(item, "reason") != null) ...<Widget>[
                  const SizedBox(height: 3),
                  Text(dynamicsText(item, "reason")!,
                      style: TextStyle(
                          color: DynamicsTone.amberFg(context),
                          fontSize: 10)),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          if (cancel)
            _smallButton(p, "去取消", solid: true,
                onTap: _busy ? null : () => _showCancel(item))
          else
            _smallButton(p, "保留", onTap: _busy ? null : () => _dismiss(item)),
        ],
      ),
    );
  }

  Widget _alertRow(MobilePalette p, Map<String, dynamic> a, bool last) {
    final bool overlap = a["kind"] == "overlap";
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
                color: p.surface2, borderRadius: BorderRadius.circular(8)),
            child: Icon(overlap ? Icons.autorenew_rounded : Icons.credit_card,
                size: 14, color: p.textPrimary),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(dynamicsText(a, "title") ?? "订阅提醒",
                    style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500)),
                const SizedBox(height: 2),
                Text(dynamicsText(a, "detail") ?? "",
                    style: TextStyle(color: p.textMuted, fontSize: 10.5)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
                color: DynamicsTone.amberBg(context),
                borderRadius: BorderRadius.circular(999)),
            child: Text(overlap ? "建议合并" : "已涨价",
                style: TextStyle(
                    color: DynamicsTone.amberFg(context),
                    fontSize: 9,
                    fontWeight: FontWeight.w500)),
          ),
        ],
      ),
    );
  }

  Widget _smallButton(MobilePalette p, String label,
      {VoidCallback? onTap, bool solid = false}) {
    return Material(
      color: solid ? p.textPrimary : Colors.transparent,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: solid ? Colors.transparent : p.divider),
          ),
          child: Text(label,
              style: TextStyle(
                  color: solid ? p.background : p.textPrimary,
                  fontSize: 10)),
        ),
      ),
    );
  }

  Widget _sourceHint(MobilePalette p) {
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
            children: <Widget>[
              Icon(Icons.shield_outlined, size: 12, color: p.textSecondary),
              const SizedBox(width: 5),
              Text("这些结论怎么来的",
                  style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11,
                      fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            "只读取已入账的账单与短信里的「连续包月 / 自动续费 / 扣款」关键词，不登录任何第三方账号；「去取消」只给出官方路径，不代操作。",
            style: TextStyle(
                color: p.textSecondary, fontSize: 11, height: 1.7),
          ),
        ],
      ),
    );
  }

  Widget _label(MobilePalette p, String title, [String? count]) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 7),
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

  Future<void> _remindAll() async {
    setState(() => _busy = true);
    try {
      for (final Map<String, dynamic> item in _items) {
        final String? id = dynamicsText(item, "id");
        if (id == null) continue;
        await _api.remindSubscription(id);
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        for (final Map<String, dynamic> item in _items) {
          item["remindAt"] = DateTime.now().millisecondsSinceEpoch;
        }
      });
      _snack("已设置：每项续费前 3 天提醒");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("设置失败：$e");
    }
  }

  Future<void> _dismiss(Map<String, dynamic> item) async {
    final String? id = dynamicsText(item, "id");
    if (id == null) return;
    final int idx = _items.indexOf(item);
    setState(() {
      _items.removeAt(idx);
      _recalc();
      _alerts.removeWhere((Map<String, dynamic> a) =>
          (a["id"]?.toString() ?? "").endsWith(id.split(":").last));
    });
    try {
      await _api.dismissSubscription(id);
      widget.onChanged?.call();
      _snack("已忽略这条建议");
    } catch (e) {
      if (!mounted) return;
      final int restoreAt =
          idx < 0 ? 0 : (idx > _items.length ? _items.length : idx);
      setState(() {
        _items.insert(restoreAt, item);
        _recalc();
      });
      _snack("操作失败：$e");
    }
  }

  void _showCancel(Map<String, dynamic> item) {
    final MobilePalette p = MobileTheme.of(context);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("去取消「${dynamicsText(item, "name") ?? "订阅"}」",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Text("我们不会登录你的账号，也不代操作。请在官方入口关闭自动续费：",
                  style: TextStyle(
                      color: p.textSecondary, fontSize: 11.5, height: 1.7)),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(11),
                decoration: BoxDecoration(
                    color: p.surface2,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(
                  dynamicsText(item, "cancelPath") ?? "在对应 App 的会员中心关闭自动续费",
                  style: TextStyle(
                      color: p.textPrimary, fontSize: 11.5, height: 1.7),
                ),
              ),
              const SizedBox(height: 14),
              Row(
                children: <Widget>[
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(ctx),
                      child: const Text("先保留"),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: () {
                        Navigator.pop(ctx);
                        _dismiss(item);
                      },
                      child: const Text("我已取消"),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showExplainer(MobilePalette p) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
          child: Text(
            "识别口径：账单/短信命中「连续包月 / 自动续费 / 包月 / 会员」等关键词，且近 90 天同商户同金额至少扣款 2 次，才会被认定为自动续费。同类订阅 ≥2 个时提示合并；金额上涨时提示涨价。所有判断都来自已入账记录，不访问第三方账号。",
            style: TextStyle(
                color: p.textSecondary, fontSize: 12, height: 1.8),
          ),
        ),
      ),
    );
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
          content: Text(text), duration: const Duration(seconds: 2)));
  }
}
