import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "shopping_candidates_card.dart";
import "shopping_checkout_cards.dart";
import "shopping_login_card.dart";
import "shopping_shared.dart";

/// 物流追踪卡（设计稿 05 屏）。
///
/// 节点只渲染服务端确实给到的信息：平台不提供承运商/运单号时，
/// 细行直接不显示——宁可少一行，也不编一个「顺丰 SF7382」出来。
/// 状态圆点三态：已完成（实心）、当前（实心+光环）、未到（浅灰）。
class ShoppingShipmentCard extends StatelessWidget {
  const ShoppingShipmentCard({
    super.key,
    required this.cs,
    required this.payload,
    this.onUserAction,
    this.cardData,
  });

  final ColorScheme cs;
  final Map<String, dynamic> payload;
  final void Function(AgentResultAction,
      {required AgentResultData cardData})? onUserAction;
  final AgentResultData? cardData;

  void _emit(String label) {
    final AgentResultData? data = cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        onUserAction;
    if (data == null || cb == null || label.isEmpty) return;
    cb(
      AgentResultAction(
        id: "ship_${label.hashCode.abs()}",
        label: label,
        variant: "secondary",
      ),
      cardData: data,
    );
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = payload;
    final List<Map<String, dynamic>> nodes = shopMaps(p["nodes"]);
    final String statusLabel = shopStr(p["statusLabel"]);
    final List<dynamic> chips =
        p["chips"] is List ? p["chips"] as List : const <dynamic>[];

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 9),
            child: Row(
              children: <Widget>[
                if (statusLabel.isNotEmpty) ...<Widget>[
                  ShopBadge(cs: cs, label: statusLabel),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    shopStr(p["title"]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                ),
              ],
            ),
          ),
          ShopDivider(cs: cs),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 10, 13, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                for (int i = 0; i < nodes.length; i++)
                  _NodeRow(
                    cs: cs,
                    node: nodes[i],
                    isFirst: i == 0,
                    isLast: i == nodes.length - 1,
                  ),
              ],
            ),
          ),
          if (chips.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 0, 13, 12),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: <Widget>[
                  for (final dynamic c in chips)
                    ShopTap(
                      onTap: () => _emit(shopStr(c)),
                      radius: 999,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: cs.outline.withValues(alpha: 0.3),
                          ),
                        ),
                        child: Text(
                          shopStr(c),
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant,
                          ),
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
}

class _NodeRow extends StatelessWidget {
  const _NodeRow({
    required this.cs,
    required this.node,
    required this.isFirst,
    required this.isLast,
  });

  final ColorScheme cs;
  final Map<String, dynamic> node;
  final bool isFirst;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final String state = shopStr(node["state"]);
    final bool done = state == "done";
    final bool now = state == "now";
    final bool active = done || now;
    final Color dotColor =
        active ? cs.onSurface : cs.outline.withValues(alpha: 0.55);
    final String detail = shopStr(node["detail"]);

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          SizedBox(
            width: 12,
            child: Column(
              children: <Widget>[
                Container(
                  margin: const EdgeInsets.only(top: 3),
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: dotColor,
                    shape: BoxShape.circle,
                    boxShadow: now
                        ? <BoxShadow>[
                            BoxShadow(
                              color: cs.onSurface.withValues(alpha: 0.10),
                              spreadRadius: 3,
                            ),
                          ]
                        : null,
                  ),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 1.5,
                      margin: const EdgeInsets.only(top: 2),
                      color: cs.outline.withValues(alpha: active ? 0.35 : 0.18),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : 15),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    shopStr(node["label"]),
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                      color: active
                          ? cs.onSurface
                          : cs.onSurfaceVariant.withValues(alpha: 0.75),
                    ),
                  ),
                  if (detail.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        detail,
                        style: TextStyle(
                          fontSize: 9.5,
                          height: 1.45,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 购物卡总入口：按 `extra.shopping.stage` 分发到对应形态。
///
/// 载荷缺失/形态未知时返回 null，由 `AgentResultCard` 回退到既有专用卡，
/// 保证历史消息与旧服务端回执都不炸。
Widget? buildShoppingCard({
  required AgentResultData data,
  required ColorScheme cs,
  void Function(AgentResultAction,
          {required AgentResultData cardData})? onUserAction,
}) {
  final Object? raw = data.extra?["shopping"];
  if (raw is! Map) return null;
  final Map<String, dynamic> payload = <String, dynamic>{
    for (final MapEntry<Object?, Object?> e in raw.entries)
      e.key.toString(): e.value,
  };
  final String stage = shopStr(payload["stage"]);
  return switch (stage) {
    "candidates" => ShoppingCandidatesCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    "spec" => ShoppingSpecCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    "confirm" => ShoppingConfirmCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    "pay" => ShoppingPayCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    "login" || "login-consent" => ShoppingLoginCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    "shipment" => ShoppingShipmentCard(
        cs: cs,
        payload: payload,
        onUserAction: onUserAction,
        cardData: data,
      ),
    _ => null,
  };
}
