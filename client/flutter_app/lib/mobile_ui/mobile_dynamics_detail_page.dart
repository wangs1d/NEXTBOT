import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

/// 快递详情（设计稿 03）：取件码是第一信息，整页只有一个主操作「复制取件码」。
///
/// 数据直接复用列表项（/api/dynamics 的 parcels.recent[]），不额外请求。
class ParcelDetailPage extends StatelessWidget {
  const ParcelDetailPage({super.key, required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String? code = dynamicsText(item, "pickupCode");
    final String title = dynamicsText(item, "title") ?? "包裹动态";
    final String? carrier = dynamicsText(item, "carrier");
    final String? trackingNo = dynamicsText(item, "trackingNo");
    final String? excerpt = dynamicsText(item, "excerpt");
    final num occurredAt = dynamicsNum(item, "occurredAt");
    final String time = dynamicsFmtTime(occurredAt);

    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("快递详情")),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: p.divider),
            ),
            child: Column(
              children: [
                Text(
                  "取件码",
                  style: TextStyle(
                    color: p.textMuted,
                    fontSize: 10.5,
                    letterSpacing: 3,
                  ),
                ),
                const SizedBox(height: 7),
                Text(
                  code ?? "—",
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 34,
                    height: 1.18,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 2,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  title,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                ),
                if (code != null) ...[
                  const SizedBox(height: 9),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    decoration: BoxDecoration(
                      color: Theme.of(context).brightness == Brightness.dark
                          ? const Color(0x242C8C3C)
                          : const Color(0xFFFFF5E5),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      "请尽快取件",
                      style: TextStyle(
                        fontSize: 10.5,
                        color: Theme.of(context).brightness == Brightness.dark
                            ? const Color(0xFFE8A94A)
                            : const Color(0xFFB26A00),
                      ),
                    ),
                  ),
                  const SizedBox(height: 13),
                  SizedBox(
                    height: 34,
                    width: double.infinity,
                    child: Material(
                      color: p.accent,
                      borderRadius: BorderRadius.circular(10),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: () {
                          unawaited(Clipboard.setData(
                              ClipboardData(text: code)));
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text("取件码已复制"),
                              duration: Duration(seconds: 2),
                            ),
                          );
                        },
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.copy_rounded,
                                size: 13, color: p.onAccent),
                            const SizedBox(width: 6),
                            Text(
                              "复制取件码",
                              style: TextStyle(
                                color: p.onAccent,
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          _InfoCard(
            p: p,
            rows: [
              _InfoRow(p: p, label: "承运商", value: carrier ?? "未知"),
              _InfoRow(
                p: p,
                label: "运单号",
                value: trackingNo ?? "—",
                mono: true,
                onCopy: trackingNo == null
                    ? null
                    : () {
                        unawaited(
                            Clipboard.setData(ClipboardData(text: trackingNo)));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text("运单号已复制"),
                            duration: Duration(seconds: 2),
                          ),
                        );
                      },
              ),
              _InfoRow(
                  p: p, label: "到达时间", value: time.isEmpty ? "—" : time),
              _InfoRow(
                p: p,
                label: "识别来源",
                value: dynamicsSourceLabel(item["source"]),
              ),
            ],
          ),
          const SizedBox(height: 14),
          _SectionLabel(p: p, text: "物流进度"),
          Container(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 5),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider),
            ),
            child: Column(
              children: [
                _TimelineNode(
                  p: p,
                  active: true,
                  title: code != null ? "已到站 · 待取件" : "物流更新",
                  desc: <String>[
                    if (time.isNotEmpty) time,
                    if (carrier != null) carrier,
                  ].join(" · "),
                ),
                _TimelineNode(
                  p: p,
                  active: false,
                  title: "派送中",
                  desc: "等待承运商轨迹同步",
                ),
                _TimelineNode(
                  p: p,
                  active: false,
                  title: "已揽收",
                  desc: "等待承运商轨迹同步",
                ),
              ],
            ),
          ),
          if (excerpt != null) ...[
            const SizedBox(height: 14),
            _SectionLabel(p: p, text: "原始通知"),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.divider),
              ),
              child: Text(
                excerpt,
                style: TextStyle(
                  color: p.textSecondary,
                  fontSize: 11.5,
                  height: 19 / 11.5,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 账单详情（设计稿 04）：金额 + 识别原文 + 同期同类。
class BillDetailPage extends StatefulWidget {
  const BillDetailPage({
    super.key,
    required this.item,
    this.byType = const <Map<String, dynamic>>[],
  });

  final Map<String, dynamic> item;

  /// bills.byType：同期同类分布（type / count / amount）。
  final List<Map<String, dynamic>> byType;

  @override
  State<BillDetailPage> createState() => _BillDetailPageState();
}

class _BillDetailPageState extends State<BillDetailPage> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final Map<String, dynamic> item = widget.item;
    final String title = dynamicsText(item, "title") ?? "账单";
    final String? billType = dynamicsText(item, "billType");
    final num amount = dynamicsNum(item, "amount");
    final String occurred = dynamicsFmtTime(dynamicsNum(item, "occurredAt"));
    final String? excerpt = dynamicsText(item, "excerpt");

    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("账单详情")),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: p.divider),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    _Pill(p: p, text: "支出", solid: true),
                    if (billType != null) ...[
                      const SizedBox(width: 7),
                      _Pill(p: p, text: billType),
                    ],
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Text.rich(
                        TextSpan(
                          text: "¥",
                          style: TextStyle(
                            color: p.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                          ),
                          children: [
                            TextSpan(
                              text: dynamicsFmtAmount(amount),
                              style: const TextStyle(
                                fontSize: 32,
                                height: 1.12,
                                fontWeight: FontWeight.w600,
                                letterSpacing: -0.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 9, vertical: 3),
                        decoration: BoxDecoration(
                          color: Theme.of(context).brightness ==
                                  Brightness.dark
                              ? const Color(0x2432965A)
                              : const Color(0xFFEAF7EF),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          "已自动入账",
                          style: TextStyle(
                            fontSize: 10,
                            color: Theme.of(context).brightness ==
                                    Brightness.dark
                                ? const Color(0xFF6BD39A)
                                : const Color(0xFF1F9D55),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  title,
                  style: TextStyle(color: p.textSecondary, fontSize: 12.5),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          _InfoCard(
            p: p,
            rows: [
              _InfoRow(
                  p: p, label: "发生时间", value: occurred.isEmpty ? "—" : occurred),
              _InfoRow(
                p: p,
                label: "识别来源",
                value: dynamicsSourceLabel(item["source"]),
              ),
              _InfoRow(p: p, label: "账单类型", value: billType ?? "未分类"),
              _InfoRow(p: p, label: "入账状态", value: "已计入近 30 天汇总"),
            ],
          ),
          if (excerpt != null) ...[
            const SizedBox(height: 14),
            _SectionLabel(p: p, text: "原始凭证"),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.divider),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    excerpt,
                    maxLines: _expanded ? null : 4,
                    overflow: _expanded ? null : TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11.5,
                      height: 19 / 11.5,
                    ),
                  ),
                  const SizedBox(height: 6),
                  GestureDetector(
                    onTap: () => setState(() => _expanded = !_expanded),
                    child: Text(
                      _expanded ? "收起原文" : "查看完整原文",
                      style: TextStyle(color: p.link, fontSize: 10.5),
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (widget.byType.isNotEmpty) ...[
            const SizedBox(height: 14),
            _SectionLabel(p: p, text: "同期同类"),
            _TypeBreakdown(p: p, byType: widget.byType),
          ],
        ],
      ),
    );
  }
}

/// 同期同类：名称 + 比例条 + 笔数 + 金额（按金额降序，最大额拉满）。
class _TypeBreakdown extends StatelessWidget {
  const _TypeBreakdown({required this.p, required this.byType});

  final MobilePalette p;
  final List<Map<String, dynamic>> byType;

  @override
  Widget build(BuildContext context) {
    final num maxAmount = byType.fold<num>(
        0, (num m, Map<String, dynamic> e) => amountOf(e) > m ? amountOf(e) : m);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: [
          for (final Map<String, dynamic> e in byType)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 7),
              child: Row(
                children: [
                  SizedBox(
                    width: 64,
                    child: Text(
                      dynamicsText(e, "type") ?? "未分类",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: p.textPrimary, fontSize: 12),
                    ),
                  ),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: Container(
                        height: 3,
                        color: p.innerFieldBackground,
                        alignment: Alignment.centerLeft,
                        child: FractionallySizedBox(
                          widthFactor: maxAmount <= 0
                              ? 0.0
                              : (amountOf(e) / maxAmount)
                                  .clamp(0.06, 1.0)
                                  .toDouble(),
                          child: Container(color: p.textPrimary),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 40,
                    child: Text(
                      "${dynamicsNum(e, "count").toInt()} 笔",
                      textAlign: TextAlign.right,
                      style: TextStyle(color: p.textMuted, fontSize: 10.5),
                    ),
                  ),
                  SizedBox(
                    width: 66,
                    child: Text(
                      "¥${dynamicsFmtAmount(amountOf(e))}",
                      textAlign: TextAlign.right,
                      style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  static num amountOf(Map<String, dynamic> e) => dynamicsNum(e, "amount");
}

class _TimelineNode extends StatelessWidget {
  const _TimelineNode({
    required this.p,
    required this.active,
    required this.title,
    required this.desc,
  });

  final MobilePalette p;
  final bool active;
  final String title;
  final String desc;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 3),
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              color: active ? p.textPrimary : null,
              shape: BoxShape.circle,
              border: active ? null : Border.all(color: p.textMuted),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: active ? p.textPrimary : p.textSecondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  desc,
                  style: TextStyle(color: p.textMuted, fontSize: 10.5),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.p, required this.rows});

  final MobilePalette p;
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: [
          for (int i = 0; i < rows.length; i++)
            Container(
              decoration: BoxDecoration(
                border: i == rows.length - 1
                    ? null
                    : Border(bottom: BorderSide(color: p.divider)),
              ),
              child: rows[i],
            ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.p,
    required this.label,
    required this.value,
    this.mono = false,
    this.onCopy,
  });

  final MobilePalette p;
  final String label;
  final String value;
  final bool mono;
  final VoidCallback? onCopy;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(color: p.textSecondary, fontSize: 11.5),
          ),
          const Spacer(),
          Flexible(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    value,
                    textAlign: TextAlign.right,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 12,
                      fontFeatures: mono
                          ? const <FontFeature>[
                              FontFeature.tabularFigures()
                            ]
                          : null,
                    ),
                  ),
                ),
                if (onCopy != null) ...[
                  const SizedBox(width: 5),
                  GestureDetector(
                    onTap: onCopy,
                    child: Icon(Icons.copy_rounded,
                        size: 12, color: p.textMuted),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.p, required this.text});

  final MobilePalette p;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 7),
      child: Text(
        text,
        style: TextStyle(
          color: p.textSecondary,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.p, required this.text, this.solid = false});

  final MobilePalette p;
  final String text;
  final bool solid;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: solid ? p.accent : p.innerFieldBackground,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: solid ? p.onAccent : p.textSecondary,
          fontSize: 10,
        ),
      ),
    );
  }
}
