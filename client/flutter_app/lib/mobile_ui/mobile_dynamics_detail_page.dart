// 账单 / 快递详情（设计稿 SCREEN 05）。
//
// 详情页承担「确认与纠错」：
//   · 账单：已报销 / 记错了（均可撤销）、问 Agent、自动续费提示、原始凭证、同期同类；
//   · 快递：取件码、标记已取件 / 撤销、稍后提醒、原始凭证。
// 动作全部调服务端，成功后本地更新并通过 Navigator.pop 把最新条目带回列表。
import "dart:async";

import "package:flutter/material.dart";

import "mobile_dynamics_api.dart";
import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

class BillDetailPage extends StatefulWidget {
  const BillDetailPage({
    super.key,
    required this.item,
    this.byType = const <Map<String, dynamic>>[],
    this.client,
    this.onAskAgent,
  });

  final Map<String, dynamic> item;
  final List<Map<String, dynamic>> byType;
  final dynamic client;
  final void Function(String prompt)? onAskAgent;

  @override
  State<BillDetailPage> createState() => _BillDetailPageState();
}

class _BillDetailPageState extends State<BillDetailPage> {
  late Map<String, dynamic> _item = Map<String, dynamic>.from(widget.item);
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  bool _busy = false;
  bool _expanded = false;

  num get _amount => dynamicsNum(_item, "amount");
  String? get _status => dynamicsBillStatus(_item);

  bool get _looksSubscription {
    final String text = "${_item["title"] ?? ""}\n${_item["excerpt"] ?? ""}";
    return RegExp(r"(连续包月|自动续费|包月|订阅|会员|VIP|iCloud|网盘)").hasMatch(text);
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final bool wrong = _status == "wrong";
    final String type = dynamicsText(_item, "billType") ?? "其他";
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("账单详情")),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 28),
        children: <Widget>[
          _hero(p, wrong, type),
          const SizedBox(height: 12),
          _actions(p),
          const SizedBox(height: 14),
          _infoCard(p),
          if (_looksSubscription) ...<Widget>[
            const SizedBox(height: 11),
            _subscriptionHint(p),
          ],
          _label(p, "原始凭证"),
          _receiptCard(p),
          if (widget.byType.isNotEmpty) ...<Widget>[
            _label(p, "同期同类", trailing: "近 30 天"),
            _typeBreakdown(p),
          ],
        ],
      ),
    );
  }

  Widget _hero(MobilePalette p, bool wrong, String type) {
    return Container(
      padding: const EdgeInsets.fromLTRB(15, 14, 15, 14),
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
              _pill("支出", solid: true),
              const SizedBox(width: 6),
              _pill(type),
              if (_looksSubscription) ...<Widget>[
                const SizedBox(width: 6),
                _pill("连续包月",
                    fg: const Color(0xFF3B82F6),
                    bg: DynamicsTone.blueBg(context)),
              ],
            ],
          ),
          const SizedBox(height: 11),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text("¥",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
              const SizedBox(width: 3),
              Text(
                dynamicsFmtAmount(_amount.abs()),
                style: TextStyle(
                  color: wrong ? p.textMuted : p.textPrimary,
                  fontSize: 30,
                  height: 1,
                  letterSpacing: -0.6,
                  fontWeight: FontWeight.w600,
                  decoration: wrong ? TextDecoration.lineThrough : null,
                ),
              ),
              const Spacer(),
              if (_status != null) _statusChip(context, _status!),
            ],
          ),
          const SizedBox(height: 9),
          Text(
            dynamicsText(_item, "title") ?? "账单",
            style: TextStyle(color: p.textPrimary, fontSize: 13.5),
          ),
        ],
      ),
    );
  }

  Widget _actions(MobilePalette p) {
    return Row(
      children: <Widget>[
        Expanded(
          child: _actionButton(
            p,
            icon: Icons.check_rounded,
            label: _status == "reimbursed" ? "取消已报销" : "已报销",
            active: _status == "reimbursed",
            onTap: _busy ? null : () => _setStatus("reimbursed"),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _actionButton(
            p,
            icon: Icons.close_rounded,
            label: "记错了",
            danger: true,
            active: _status == "wrong",
            onTap: _busy ? null : () => _setStatus("wrong"),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _actionButton(
            p,
            icon: Icons.auto_awesome_outlined,
            label: "问 Agent",
            solid: true,
            onTap: () => _askAgent(),
          ),
        ),
      ],
    );
  }

  Widget _actionButton(
    MobilePalette p, {
    required IconData icon,
    required String label,
    required VoidCallback? onTap,
    bool solid = false,
    bool danger = false,
    bool active = false,
  }) {
    final Color bg = solid
        ? p.textPrimary
        : active
            ? (danger ? DynamicsTone.redBg(context) : DynamicsTone.greenBg(context))
            : Colors.transparent;
    final Color fg = solid
        ? p.background
        : danger
            ? DynamicsTone.redFg(context)
            : active
                ? DynamicsTone.greenFg(context)
                : p.textPrimary;
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        borderRadius: BorderRadius.circular(9),
        onTap: onTap,
        child: Container(
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(
                color: solid
                    ? Colors.transparent
                    : active
                        ? (danger
                            ? DynamicsTone.redFg(context)
                            : DynamicsTone.greenFg(context))
                        : p.divider),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 14, color: fg),
              const SizedBox(width: 4),
              Text(label,
                  style: TextStyle(
                      color: fg, fontSize: 11, fontWeight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _infoCard(MobilePalette p) {
    final bool counted = _status != "wrong";
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: <Widget>[
          _infoRow(p, "发生时间", dynamicsFmtTime(dynamicsNum(_item, "occurredAt"))),
          _infoRow(p, "识别来源", dynamicsSourceLabel(_item["source"])),
          _infoRow(p, "账单类型", dynamicsText(_item, "billType") ?? "其他"),
          _infoRow(
            p,
            "入账状态",
            counted ? "已计入近 30 天汇总" : "已从近 30 天合计中扣除",
            last: true,
          ),
        ],
      ),
    );
  }

  Widget _infoRow(MobilePalette p, String k, String v, {bool last = false}) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Text(k, style: TextStyle(color: p.textSecondary, fontSize: 12)),
          const Spacer(),
          Flexible(
            child: Text(
              v,
              textAlign: TextAlign.right,
              style: TextStyle(color: p.textPrimary, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _subscriptionHint(MobilePalette p) {
    final int occurredAt = dynamicsNum(_item, "occurredAt").toInt();
    final DateTime next =
        DateTime.fromMillisecondsSinceEpoch(occurredAt).add(const Duration(days: 30));
    final DateTime remindAt = next.subtract(const Duration(days: 3));
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
      decoration: BoxDecoration(
        color: DynamicsTone.blueBg(context),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF3B82F6).withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.autorenew_rounded, size: 14, color: Color(0xFF3B82F6)),
              const SizedBox(width: 5),
              Text("识别为自动续费",
                  style: TextStyle(
                      color: const Color(0xFF3B82F6),
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(text: "本笔可能为连续包月，下次扣款约 "),
                TextSpan(
                  text: "${dynamicsFmtDate(next.millisecondsSinceEpoch)} ¥${dynamicsFmtAmount(_amount.abs())}",
                  style: TextStyle(
                      color: p.textPrimary, fontWeight: FontWeight.w600),
                ),
                TextSpan(text: "。可提前 3 天提醒我。"),
              ],
            ),
            style: TextStyle(color: p.textSecondary, fontSize: 11.5, height: 1.7),
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              _smallGhost(
                "续费前提醒",
                onTap: _busy
                    ? null
                    : () async {
                        await _snooze(remindAt);
                      },
              ),
              const SizedBox(width: 7),
              _smallGhost(
                "查看订阅",
                onTap: () {
                  Navigator.of(context).pop();
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _smallGhost(String label, {VoidCallback? onTap}) {
    const Color blue = Color(0xFF3B82F6);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: blue.withValues(alpha: 0.6)),
          ),
          child: Text(label, style: const TextStyle(color: blue, fontSize: 10)),
        ),
      ),
    );
  }

  Widget _receiptCard(MobilePalette p) {
    final String excerpt = dynamicsText(_item, "excerpt") ?? "暂无原文";
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            excerpt,
            maxLines: _expanded ? null : 3,
            overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
            style: TextStyle(color: p.textSecondary, fontSize: 11.5, height: 1.75),
          ),
          if (excerpt.length > 40)
            GestureDetector(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.only(top: 7),
                child: Text(
                  _expanded ? "收起原文" : "查看完整原文",
                  style: const TextStyle(color: Color(0xFF3B82F6), fontSize: 10.5),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _typeBreakdown(MobilePalette p) {
    final List<Map<String, dynamic>> rows = widget.byType.take(4).toList();
    final num max = rows.isEmpty
        ? 1
        : rows
            .map((Map<String, dynamic> e) => dynamicsNum(e, "amount"))
            .fold<num>(0, (num a, num b) => a > b ? a : b);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: <Widget>[
          for (final Map<String, dynamic> row in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: <Widget>[
                  SizedBox(
                    width: 62,
                    child: Text(
                      dynamicsText(row, "type") ?? "其他",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: p.textSecondary, fontSize: 11),
                    ),
                  ),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        value: max <= 0
                            ? 0
                            : dynamicsNum(row, "amount") / max,
                        minHeight: 5,
                        backgroundColor: p.surface2,
                        valueColor:
                            AlwaysStoppedAnimation<Color>(p.textPrimary),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    "¥${dynamicsFmtAmount(dynamicsNum(row, "amount"))}",
                    style: TextStyle(color: p.textPrimary, fontSize: 11),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _label(MobilePalette p, String text, {String? trailing}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 16, 4, 7),
      child: Row(
        children: <Widget>[
          Text(text,
              style: TextStyle(
                  color: p.textSecondary,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600)),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: 6),
            Text(trailing,
                style: TextStyle(color: p.textMuted, fontSize: 10.5)),
          ],
        ],
      ),
    );
  }

  Widget _pill(String text,
      {bool solid = false, Color? fg, Color? bg}) {
    final MobilePalette p = MobileTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: solid ? p.textPrimary : (bg ?? p.surface2),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: solid ? p.background : (fg ?? p.textSecondary),
          fontSize: 9.5,
          height: 1.4,
        ),
      ),
    );
  }

  Widget _statusChip(BuildContext context, String status) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: status == "reimbursed"
            ? DynamicsTone.greenBg(context)
            : DynamicsTone.redBg(context),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        status == "reimbursed" ? "已报销" : "记错了",
        style: TextStyle(
          color: status == "reimbursed"
              ? DynamicsTone.greenFg(context)
              : DynamicsTone.redFg(context),
          fontSize: 9.5,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  Future<void> _setStatus(String status) async {
    final String? current = _status;
    final String? next = current == status ? null : status;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> res = await _api.reviewBill(
        dynamicsText(_item, "id") ?? "",
        next,
      );
      final Map<String, dynamic>? updated =
          res["item"] as Map<String, dynamic>?;
      if (!mounted) return;
      setState(() {
        if (updated != null) _item = updated;
        _busy = false;
      });
      _snack(next == "reimbursed"
          ? "已标记为已报销"
          : next == "wrong"
              ? "已标记记错了，已从合计扣除"
              : "已撤销复核标记");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("操作失败：$e");
    }
  }

  Future<void> _snooze(DateTime until) async {
    setState(() => _busy = true);
    try {
      await _api.snooze(dynamicsText(_item, "id") ?? "", until);
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("已设置提醒：${dynamicsFmtDay(until.millisecondsSinceEpoch)}");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("设置失败：$e");
    }
  }

  void _askAgent() {
    final String prompt =
        "这笔 ¥${dynamicsFmtAmount(_amount.abs())} 的「${dynamicsText(_item, "title") ?? "账单"}」花在哪？来源 ${dynamicsSourceLabel(_item["source"])}，时间 ${dynamicsFmtTime(dynamicsNum(_item, "occurredAt"))}。";
    if (widget.onAskAgent != null) {
      widget.onAskAgent!(prompt);
      Navigator.of(context).pop();
      return;
    }
    _snack("已生成问题，可回到对话页询问 Agent");
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 2)));
  }
}

// ================================================================ //
// 快递详情
// ================================================================ //

class ParcelDetailPage extends StatefulWidget {
  const ParcelDetailPage({super.key, required this.item, this.client});

  final Map<String, dynamic> item;
  final dynamic client;

  @override
  State<ParcelDetailPage> createState() => _ParcelDetailPageState();
}

class _ParcelDetailPageState extends State<ParcelDetailPage> {
  late Map<String, dynamic> _item = Map<String, dynamic>.from(widget.item);
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  bool _busy = false;

  bool get _pickedUp => dynamicsPickedUp(_item);

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String? code = dynamicsText(_item, "pickupCode");
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("快递详情")),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 28),
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(15),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: !_pickedUp && code != null
                    ? p.textPrimary.withValues(alpha: 0.55)
                    : p.divider,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    _pill(dynamicsText(_item, "carrier") ?? "快递"),
                    const SizedBox(width: 6),
                    _pill(_pickedUp ? "已取件" : (code != null ? "待取件" : "运输中"),
                        solid: !_pickedUp && code != null),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  dynamicsText(_item, "title") ?? "快递",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600),
                ),
                if (!_pickedUp && code != null) ...<Widget>[
                  const SizedBox(height: 14),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    decoration: BoxDecoration(
                      color: p.textPrimary,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      children: <Widget>[
                        Text("取件码",
                            style: TextStyle(
                                color: p.background.withValues(alpha: 0.65),
                                fontSize: 9,
                                letterSpacing: 1.2)),
                        const SizedBox(height: 2),
                        Text(code,
                            style: TextStyle(
                                color: p.background,
                                fontSize: 22,
                                fontWeight: FontWeight.w600,
                                letterSpacing: 0.4)),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              Expanded(
                child: _actionButton(
                  p,
                  _pickedUp ? "撤销已取件" : "标记已取件",
                  _pickedUp ? Icons.undo_rounded : Icons.check_rounded,
                  onTap: _busy ? null : _togglePickedUp,
                  solid: !_pickedUp,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _actionButton(
                  p,
                  "稍后提醒",
                  Icons.schedule_rounded,
                  onTap: _busy ? null : _snoozeTomorrow,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider),
            ),
            child: Column(
              children: <Widget>[
                _infoRow(p, "承运商", dynamicsText(_item, "carrier") ?? "未知"),
                _infoRow(p, "运单号", dynamicsText(_item, "trackingNo") ?? "—"),
                _infoRow(p, "到件时间", dynamicsFmtTime(dynamicsNum(_item, "occurredAt"))),
                _infoRow(
                  p,
                  "取件状态",
                  _pickedUp
                      ? "已取件 ${dynamicsFmtTime(dynamicsNum(_item, "pickedUpAt"))}"
                      : (code != null ? "待取件" : "无需取件码"),
                  last: true,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 16, 4, 7),
            child: Text("原始通知",
                style: TextStyle(
                    color: p.textSecondary,
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600)),
          ),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider),
            ),
            child: Text(
              dynamicsText(_item, "excerpt") ?? "暂无原文",
              style: TextStyle(
                  color: p.textSecondary, fontSize: 11.5, height: 1.75),
            ),
          ),
        ],
      ),
    );
  }

  Widget _actionButton(
    MobilePalette p,
    String label,
    IconData icon, {
    VoidCallback? onTap,
    bool solid = false,
  }) {
    return Material(
      color: solid ? p.textPrimary : p.surface,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        borderRadius: BorderRadius.circular(9),
        onTap: onTap,
        child: Container(
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: solid ? Colors.transparent : p.divider),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 14, color: solid ? p.background : p.textPrimary),
              const SizedBox(width: 4),
              Text(label,
                  style: TextStyle(
                      color: solid ? p.background : p.textPrimary,
                      fontSize: 11,
                      fontWeight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _infoRow(MobilePalette p, String k, String v, {bool last = false}) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Text(k, style: TextStyle(color: p.textSecondary, fontSize: 12)),
          const Spacer(),
          Flexible(
            child: Text(v,
                textAlign: TextAlign.right,
                style: TextStyle(color: p.textPrimary, fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _pill(String text, {bool solid = false}) {
    final MobilePalette p = MobileTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: solid ? p.textPrimary : p.surface2,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text,
          style: TextStyle(
              color: solid ? p.background : p.textSecondary,
              fontSize: 9.5,
              height: 1.4)),
    );
  }

  Future<void> _togglePickedUp() async {
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> res = await _api.setPickedUp(
        dynamicsText(_item, "id") ?? "",
        !_pickedUp,
      );
      final Map<String, dynamic>? updated =
          res["item"] as Map<String, dynamic>?;
      if (!mounted) return;
      setState(() {
        if (updated != null) _item = updated;
        _busy = false;
      });
      _snack(_pickedUp ? "已标记取件" : "已撤销取件");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("操作失败：$e");
    }
  }

  Future<void> _snoozeTomorrow() async {
    final DateTime now = DateTime.now();
    final DateTime until = DateTime(now.year, now.month, now.day + 1, 9);
    setState(() => _busy = true);
    try {
      await _api.snooze(dynamicsText(_item, "id") ?? "", until);
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("已设为明天 9:00 提醒");
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack("设置失败：$e");
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 2)));
  }
}
