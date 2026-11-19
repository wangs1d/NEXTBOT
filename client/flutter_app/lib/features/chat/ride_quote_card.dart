import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";
import "shopping/shopping_shared.dart";

/// 叫车报价卡（cardType = "ride_quote"）。
///
/// 服务端把车型（含每档价格）与「选择这个车型」的卡内动作一起下发
/// （extra.ride.options[].action）。本卡只负责展示与回传：
/// 点选后经 card.action（ride.book.prepare）把这张卡换成统一确认卡，
/// 不发消息、不进模型上下文——和购物卡的下单链路同构。
class RideQuoteCard extends StatefulWidget {
  const RideQuoteCard({
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

  @override
  State<RideQuoteCard> createState() => _RideQuoteCardState();
}

class _RideQuoteCardState extends State<RideQuoteCard> {
  /// 已点选、正等服务端出确认卡：锁住整卡避免重复点单。
  String _pickedOptionId = "";

  ColorScheme get cs => widget.cs;

  void _emit(Map<String, dynamic> option) {
    if (_pickedOptionId.isNotEmpty) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    final Map<String, dynamic> action = _asMap(option["action"]);
    final String cardAction = shopStr(action["cardAction"]);
    if (cardAction.isEmpty) return;
    final String optionId = shopStr(option["optionId"]);
    setState(() => _pickedOptionId = optionId);
    cb(
      AgentResultAction(
        id: shopStr(action["id"]).isEmpty
            ? "ride_pick_${DateTime.now().millisecondsSinceEpoch}"
            : shopStr(action["id"]),
        label: shopStr(action["label"]).isEmpty
            ? "就选${shopStr(option["name"])}"
            : shopStr(action["label"]),
        variant: "primary",
        // 卡内动作凭据与起终点上下文由服务端预埋，客户端原样回传。
        payload: <String, dynamic>{
          ..._asMap(action["payload"]),
          "cardAction": cardAction,
        },
      ),
      cardData: data,
    );
  }

  Map<String, dynamic> _asMap(Object? raw) {
    if (raw is Map) {
      return <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries)
          e.key.toString(): e.value,
      };
    }
    return const <String, dynamic>{};
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final List<Map<String, dynamic>> options = shopMaps(p["options"]);
    if (options.isEmpty) {
      return ShopCardShell(
        cs: cs,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
          child: Text(
            "这次没拿到可用车型，换个说法再报一次",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ),
      );
    }
    final String pickup = shopStr(p["pickup"]);
    final String dropoff = shopStr(p["dropoff"]);
    final String providerLabel = shopStr(p["providerLabel"]);
    final String note = shopStr(p["note"]);

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ShopCardHeader(
            cs: cs,
            icon: Icons.local_taxi_outlined,
            iconColor: cs.onSurface,
            title: "可选车型",
            subtitle: pickup.isNotEmpty || dropoff.isNotEmpty
                ? "${pickup.isEmpty ? "当前位置" : pickup} → ${dropoff.isEmpty ? "目的地" : dropoff}"
                : null,
            trailing: providerLabel.isEmpty
                ? null
                : Text(
                    providerLabel,
                    style: TextStyle(
                      fontSize: 9.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
          ),
          ShopDivider(cs: cs),
          for (final Map<String, dynamic> option in options)
            _optionRow(option),
          if (note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
              child: Text(
                note,
                style: TextStyle(
                  fontSize: 9.5,
                  height: 1.5,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 8, 13, 13),
            child: Text(
              "价格为预估，实际以平台结算为准",
              style: TextStyle(
                fontSize: 9.5,
                height: 1.5,
                color: cs.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _optionRow(Map<String, dynamic> option) {
    final String optionId = shopStr(option["optionId"]);
    final String name = shopStr(option["name"]);
    final String price = shopStr(option["price"]);
    final String desc = shopStr(option["description"]);
    final bool simulated = shopBool(option["simulated"]);
    final bool picked = _pickedOptionId == optionId && optionId.isNotEmpty;
    final num? eta = shopNum(option["etaMinutes"]);

    return Container(
      margin: const EdgeInsets.fromLTRB(13, 9, 13, 0),
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Flexible(
                          child: Text(
                            name.isEmpty ? "车型" : name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: cs.onSurface,
                            ),
                          ),
                        ),
                        if (simulated) ...<Widget>[
                          const SizedBox(width: 6),
                          ShopBadge(
                            cs: cs,
                            label: "模拟报价",
                            tone: ShopBadgeTone.warn,
                          ),
                        ],
                      ],
                    ),
                    if (desc.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          desc,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 10.5,
                            height: 1.45,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                    if (eta != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          "约 ${eta.toInt()} 分钟接驾",
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                price.isEmpty ? "—" : price,
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.4,
                  color: cs.onSurface,
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          ShopButton(
            cs: cs,
            label: picked ? "已选，正在准备确认…" : "就选这个",
            onTap: _pickedOptionId.isNotEmpty ? null : () => _emit(option),
            height: 36,
          ),
        ],
      ),
    );
  }
}
