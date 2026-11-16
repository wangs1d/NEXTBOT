import "package:flutter/material.dart";

import "mobile_dynamics_detail_page.dart";
import "mobile_dynamics_shared.dart";
import "mobile_theme.dart";

/// 动态聚合卡的「查看全部」列表页。
///
/// 设计稿只画了首页与详情；列表沿用同一套卡片语言（白底、12 圆角、细分隔线），
/// 账单/快递行仍可点进详情。提醒与邮件当前没有独立详情页，列表即完整信息。
enum DynamicsListKind { bill, parcel, alert, mail }

class DynamicsListPage extends StatelessWidget {
  const DynamicsListPage({
    super.key,
    required this.title,
    required this.kind,
    required this.items,
    this.byType = const <Map<String, dynamic>>[],
  });

  final String title;
  final DynamicsListKind kind;
  final List<Map<String, dynamic>> items;

  /// 账单详情「同期同类」用（bills.byType）。
  final List<Map<String, dynamic>> byType;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: Text(title)),
      body: items.isEmpty
          ? Center(
              child: Text(
                "暂无记录",
                style: TextStyle(color: p.textMuted, fontSize: 13),
              ),
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 9),
              itemBuilder: (BuildContext context, int index) {
                return _ListCard(
                  p: p,
                  kind: kind,
                  item: items[index],
                  onTap: kind == DynamicsListKind.bill
                      ? () => _openBill(context, items[index])
                      : kind == DynamicsListKind.parcel
                          ? () => _openParcel(context, items[index])
                          : null,
                );
              },
            ),
    );
  }

  void _openBill(BuildContext context, Map<String, dynamic> item) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BillDetailPage(item: item, byType: byType),
      ),
    );
  }

  void _openParcel(BuildContext context, Map<String, dynamic> item) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => ParcelDetailPage(item: item)),
    );
  }
}

class _ListCard extends StatelessWidget {
  const _ListCard({
    required this.p,
    required this.kind,
    required this.item,
    this.onTap,
  });

  final MobilePalette p;
  final DynamicsListKind kind;
  final Map<String, dynamic> item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: kind == DynamicsListKind.parcel &&
                  dynamicsText(item, "pickupCode") != null
              ? p.textPrimary.withValues(alpha: 0.55)
              : p.divider,
        ),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: switch (kind) {
              DynamicsListKind.bill => _billRow(p, item),
              DynamicsListKind.parcel => _parcelRow(p, item),
              DynamicsListKind.alert => _alertRow(p, item),
              DynamicsListKind.mail => _mailRow(p, item),
            },
          ),
        ),
      ),
    );
  }

  Widget _billRow(MobilePalette p, Map<String, dynamic> item) {
    final String meta = <String>[
      dynamicsSourceLabel(item["source"]),
      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
    ].where((String s) => s.isNotEmpty).join(" · ");
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                dynamicsText(item, "title") ?? "账单",
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (meta.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: p.textMuted, fontSize: 11),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(width: 10),
        Text(
          "-¥${dynamicsFmtAmount(dynamicsNum(item, "amount"))}",
          style: TextStyle(
            color: p.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(width: 2),
        Icon(Icons.chevron_right_rounded, size: 15, color: p.textMuted),
      ],
    );
  }

  Widget _parcelRow(MobilePalette p, Map<String, dynamic> item) {
    final String? code = dynamicsText(item, "pickupCode");
    final String? trackingNo = dynamicsText(item, "trackingNo");
    final String meta = <String>[
      if (trackingNo != null) "单号 $trackingNo",
      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
    ].where((String s) => s.isNotEmpty).join(" · ");
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                dynamicsText(item, "title") ?? "包裹动态",
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (meta.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: p.textMuted, fontSize: 11),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(width: 10),
        if (code != null)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
            decoration: BoxDecoration(
              color: p.accent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              children: [
                Text(
                  "取件码",
                  style: TextStyle(
                    color: p.onAccent.withValues(alpha: 0.62),
                    fontSize: 8,
                    letterSpacing: 1,
                  ),
                ),
                Text(
                  code,
                  style: TextStyle(
                    color: p.onAccent,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          )
        else
          Icon(Icons.chevron_right_rounded, size: 15, color: p.textMuted),
      ],
    );
  }

  Widget _alertRow(MobilePalette p, Map<String, dynamic> item) {
    final String summary = dynamicsText(item, "summary") ??
        dynamicsFmtTime(dynamicsNum(item, "createdAt"));
    final String urgency = item["urgency"]?.toString() ?? "normal";
    final bool urgent = urgency == "interrupt" || urgency == "alert";
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          margin: const EdgeInsets.only(top: 5),
          width: 5,
          height: 5,
          decoration: BoxDecoration(
            color: urgent ? const Color(0xFFE5484D) : p.textMuted,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                dynamicsText(item, "title") ?? "提醒",
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
              if (summary.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  summary,
                  style: TextStyle(color: p.textMuted, fontSize: 11),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _mailRow(MobilePalette p, Map<String, dynamic> item) {
    final String? text = dynamicsText(item, "text");
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(color: p.link, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
            Text(
              <String>[
                "邮件",
                dynamicsFmtTime(dynamicsNum(item, "at")),
              ].where((String s) => s.isNotEmpty).join(" · "),
              style: TextStyle(color: p.textMuted, fontSize: 10.5),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Text(
          dynamicsText(item, "title") ?? "邮件",
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: p.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.w500,
          ),
        ),
        if (text != null) ...[
          const SizedBox(height: 4),
          Text(
            text,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: p.textSecondary, fontSize: 11.5),
          ),
        ],
      ],
    );
  }
}
