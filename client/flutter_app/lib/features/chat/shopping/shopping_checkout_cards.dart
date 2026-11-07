import "dart:async";
import "dart:convert";
import "dart:typed_data";

import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "shopping_shared.dart";

/// 规格选择卡（设计稿 02 屏）。
///
/// 有货选项排前、无货置灰划线，缺货时在卡内直接给替代渠道与价差——
/// 「搜不到」比「看到但不能买」更让人困惑，所以留灰不留空。
class ShoppingSpecCard extends StatefulWidget {
  const ShoppingSpecCard({
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
  State<ShoppingSpecCard> createState() => _ShoppingSpecCardState();
}

class _ShoppingSpecCardState extends State<ShoppingSpecCard> {
  /// 卡内选择态：规格行名 → 选中项文案。
  /// 点选项**只改这张卡**，不发消息——发消息等于把 UI 状态泄漏成一轮新意图，
  /// 模型会把「选标准版」当成新的提问（历史真实事故）。只有底部按钮才发起动作。
  final Map<String, String> _picked = <String, String>{};

  /// 点过「先不买」：本卡收尾，只剩一行说明（纯本地，不发请求）。
  bool _dismissed = false;

  /// 已把「去结算」发出去、正等结算页回数据（10–30 秒空窗的进度提示）。
  bool _submitting = false;

  ColorScheme get cs => widget.cs;

  String _keyOf(Map<String, dynamic> spec) => shopStr(spec["key"]);

  void _initSelection() {
    for (final Map<String, dynamic> spec in shopMaps(widget.payload["specs"])) {
      final String key = _keyOf(spec);
      if (key.isEmpty) continue;
      final List<Map<String, dynamic>> options = shopMaps(spec["options"]);
      for (final Map<String, dynamic> o in options) {
        if (shopBool(o["selected"]) && !shopBool(o["disabled"])) {
          _picked[key] = shopStr(o["label"]);
          break;
        }
      }
      // 服务端没标默认项：落到第一个有货选项，避免「看着能选其实没选中」。
      if (!_picked.containsKey(key)) {
        for (final Map<String, dynamic> o in options) {
          if (!shopBool(o["disabled"])) {
            _picked[key] = shopStr(o["label"]);
            break;
          }
        }
      }
    }
  }

  @override
  void initState() {
    super.initState();
    _initSelection();
  }

  @override
  void didUpdateWidget(covariant ShoppingSpecCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 同一张卡换了载荷（例如服务端补了新规格）才重新对齐默认选中。
    if (oldWidget.payload != widget.payload) {
      _picked.clear();
      _initSelection();
    }
  }

  void _emit(String label, String variant, String actionId, {String cardAction = ""}) {
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    final Map<String, dynamic> picked =
        _picked.isEmpty ? const <String, dynamic>{} : <String, dynamic>{"specs": Map<String, String>.from(_picked)};
    cb(
      AgentResultAction(
        id: cardAction.isEmpty ? actionId : cardAction,
        label: label,
        variant: variant,
        // 把用户在这张卡里点出的规格原样带回服务端：不靠模型从文案里猜。
        // 有 cardAction 时附加卡内动作标记，控制器据此走 card.action 通道
        // （只换这张卡、不产生消息）。
        payload: cardAction.isEmpty
            ? picked
            : <String, dynamic>{
                ...picked,
                ..._cardActions(),
                "cardAction": cardAction,
              },
      ),
      cardData: data,
    );
  }

  /// 服务端预埋的卡内动作数据（平台 + 商品链接），原样回传，客户端不解释。
  Map<String, dynamic> _cardActions() {
    final Object? raw = widget.payload["actions"];
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
    final String image = shopStr(p["image"]);
    final num? price = shopNum(p["price"]);
    final num? strike = shopNum(p["strikePrice"]);
    final List<Map<String, dynamic>> specs = shopMaps(p["specs"]);
    final String note = shopStr(p["note"]);
    final String primary = shopStr(p["primaryLabel"]);
    final String secondary = shopStr(p["secondaryLabel"]);

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          SizedBox(height: 138, child: _CoverThumb(cs: cs, url: image)),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  shopStr(p["title"]),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.4,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
                if (shopStr(p["subtitle"]).isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      shopStr(p["subtitle"]),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10.5,
                        height: 1.45,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                if (price != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 9),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: <Widget>[
                        Text(
                          "¥",
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: cs.onSurface,
                          ),
                        ),
                        Text(
                          shopMoney(price),
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.6,
                            color: cs.onSurface,
                          ),
                        ),
                        if (strike != null && strike > price) ...<Widget>[
                          const SizedBox(width: 7),
                          Text(
                            "¥${shopMoney(strike)}",
                            style: TextStyle(
                              fontSize: 10.5,
                              decoration: TextDecoration.lineThrough,
                              color: cs.onSurfaceVariant.withValues(alpha: 0.8),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                for (final Map<String, dynamic> spec in specs)
                  _SpecRow(
                    cs: cs,
                    label: _keyOf(spec),
                    options: shopMaps(spec["options"]),
                    selected: _picked[_keyOf(spec)],
                    onPick: (String label, bool disabled) {
                      if (disabled) return;
                      setState(() => _picked[_keyOf(spec)] = label);
                    },
                  ),
                if (note.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      note,
                      style: const TextStyle(
                        fontSize: 10,
                        height: 1.5,
                        color: ShopTokens.warn,
                      ),
                    ),
                  ),
                if (_dismissed)
                  const Padding(
                    padding: EdgeInsets.only(top: 10),
                    child: Text(
                      "已放下，需要再买就说一句",
                      style: TextStyle(fontSize: 11, height: 1.4, color: ShopTokens.warn),
                    ),
                  ),
                if (!_dismissed && (primary.isNotEmpty || secondary.isNotEmpty))
                  Padding(
                    padding: const EdgeInsets.only(top: 11),
                    child: Row(
                      children: <Widget>[
                        if (secondary.isNotEmpty) ...<Widget>[
                          Flexible(
                            flex: 2,
                            child: ShopButton(
                              cs: cs,
                              label: secondary,
                              primary: false,
                              onTap: () {
                                final String ca = shopStr(p["secondaryAction"]);
                                if (ca == "local.dismiss") {
                                  setState(() => _dismissed = true);
                                  return;
                                }
                                _emit(secondary, "secondary", "spec_secondary",
                                    cardAction: ca);
                              },
                            ),
                          ),
                          const SizedBox(width: 8),
                        ],
                        if (primary.isNotEmpty)
                          Flexible(
                            flex: 3,
                            child: ShopButton(
                              cs: cs,
                              label: _submitting ? "正在去结算…" : primary,
                              onTap: _submitting
                                  ? null
                                  : () {
                                      setState(() => _submitting = true);
                                      _emit(
                                        primary,
                                        "primary",
                                        "spec_confirm",
                                        cardAction: shopStr(p["primaryAction"]),
                                      );
                                    },
                            ),
                          ),
                      ],
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

class _SpecRow extends StatelessWidget {
  const _SpecRow({
    required this.cs,
    required this.label,
    required this.options,
    required this.onPick,
    this.selected,
  });

  final ColorScheme cs;
  final String label;
  final List<Map<String, dynamic>> options;
  final void Function(String label, bool disabled) onPick;

  /// 当前卡内选中项（null = 尚未选，回落到服务端标了 selected 的那项）。
  final String? selected;

  @override
  Widget build(BuildContext context) {
    if (options.isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: cs.outline.withValues(alpha: 0.12)),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 52,
            child: Text(
              label,
              style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              alignment: WrapAlignment.end,
              children: <Widget>[
                for (final Map<String, dynamic> o in options)
                  _SpecOption(
                    cs: cs,
                    label: shopStr(o["label"]),
                    selected: selected == null
                        ? shopBool(o["selected"])
                        : selected == shopStr(o["label"]),
                    disabled: shopBool(o["disabled"]),
                    onTap: () =>
                        onPick(shopStr(o["label"]), shopBool(o["disabled"])),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SpecOption extends StatelessWidget {
  const _SpecOption({
    required this.cs,
    required this.label,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final ColorScheme cs;
  final String label;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // 置灰选项不能沿用「选中 = 纯黑填充」：选中且无货时黑底 + 灰字对比度极低，
    // 真机上像一块污渍而不是「看得见但不能买」。改成浅灰底 + 中灰划线字。
    final Color fg = disabled
        ? cs.onSurfaceVariant.withValues(alpha: 0.55)
        : (selected ? cs.surface : cs.onSurface);
    return ShopTap(
      onTap: disabled ? null : onTap,
      radius: 7,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: selected && !disabled
              ? cs.onSurface
              : (disabled ? cs.onSurface.withValues(alpha: 0.06) : Colors.transparent),
          borderRadius: BorderRadius.circular(7),
          border: Border.all(
            color: disabled
                ? cs.outline.withValues(alpha: 0.35)
                : (selected
                    ? cs.onSurface
                    : cs.outline.withValues(alpha: 0.3)),
            style: disabled ? BorderStyle.none : BorderStyle.solid,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10.5,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
            color: fg,
            decoration: disabled ? TextDecoration.lineThrough : null,
            decorationColor: fg,
          ),
        ),
      ),
    );
  }
}

/// 确认下单卡（设计稿 03 屏）——整个购物链路的关键闸门。
///
/// 摘要 + 倒计时 + 明确「确认后只提交订单、不自动扣款」；令牌过期自动置灰
/// 主按钮并提示重新生成，避免用户对着死按钮反复点。
class ShoppingConfirmCard extends StatefulWidget {
  const ShoppingConfirmCard({
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
  State<ShoppingConfirmCard> createState() => _ShoppingConfirmCardState();
}

class _ShoppingConfirmCardState extends State<ShoppingConfirmCard> {
  Timer? _ticker;
  Duration _left = Duration.zero;

  @override
  void initState() {
    super.initState();
    _reset();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_left.inSeconds <= 0) {
        _ticker?.cancel();
        return;
      }
      setState(() => _left -= const Duration(seconds: 1));
    });
  }

  /// 点过「先不下」：本卡收尾，只剩一行说明。纯本地状态，不发请求。
  bool _dismissed = false;

  /// 已点「确认下单」、正等服务端提交（进度提示，防「点了没反应」）。
  bool _submitting = false;

  void _reset() {
    final DateTime? at = DateTime.tryParse(shopStr(widget.payload["expiresAt"]));
    if (at != null) {
      _left = at.difference(DateTime.now().toUtc());
    } else {
      final num? ms = shopNum(widget.payload["expiresInMs"]);
      _left = Duration(milliseconds: ms?.toInt() ?? 0);
    }
    if (_left.isNegative) _left = Duration.zero;
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  String get _clock {
    final int s = _left.inSeconds;
    final String mm = (s ~/ 60).toString().padLeft(2, "0");
    final String ss = (s % 60).toString().padLeft(2, "0");
    return "$mm:$ss";
  }

  void _emit(String label, String variant, {String cardAction = ""}) {
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    cb(
      AgentResultAction(
        id: cardAction.isEmpty ? "confirm_${label.hashCode.abs()}" : cardAction,
        label: label,
        variant: variant,
        // 有 cardAction 的按钮走卡内动作通道：服务端只换这张卡，不回一条消息。
        payload: cardAction.isEmpty
            ? const <String, dynamic>{}
            : <String, dynamic>{..._cardActions(), "cardAction": cardAction},
      ),
      cardData: data,
    );
  }

  /// 服务端预埋的卡内动作数据（平台 + 确认令牌）：原样回传，客户端不解释。
  Map<String, dynamic> _cardActions() {
    final Object? raw = widget.payload["actions"];
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
    final ColorScheme cs = widget.cs;
    final Map<String, dynamic> p = widget.payload;
    final List<Map<String, dynamic>> rows = shopMaps(p["rows"]);
    final String totalLabel = shopStr(p["totalLabel"]).isEmpty
        ? "合计"
        : shopStr(p["totalLabel"]);
    final String total = shopStr(p["total"]);
    final String note = shopStr(p["note"]);
    final List<Map<String, dynamic>> buttons = shopMaps(p["buttons"]);
    final bool expired = _left.inSeconds <= 0;

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 10),
            decoration: BoxDecoration(
              color: expired ? cs.surfaceContainerHighest : ShopTokens.warnSoft,
              border: Border(
                bottom: BorderSide(
                  color: expired
                      ? cs.outline.withValues(alpha: 0.2)
                      : ShopTokens.warnLine,
                ),
              ),
            ),
            child: Row(
              children: <Widget>[
                Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: expired ? cs.onSurfaceVariant : ShopTokens.warn,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    expired
                        ? "确认已过期"
                        : (shopStr(p["title"]).isEmpty
                            ? "待你确认"
                            : shopStr(p["title"])),
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: expired ? cs.onSurfaceVariant : cs.onSurface,
                    ),
                  ),
                ),
                Text(
                  expired ? "重新生成" : _clock,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    fontFeatures: const <FontFeature>[
                      FontFeature.tabularFigures(),
                    ],
                    color: expired
                        ? cs.onSurfaceVariant
                        : ShopTokens.warn,
                  ),
                ),
              ],
            ),
          ),
          for (final Map<String, dynamic> r in rows)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 7, 13, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  SizedBox(
                    width: 42,
                    child: Text(
                      shopStr(r["k"]),
                      style: TextStyle(
                        fontSize: 11.5,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      shopStr(r["v"]),
                      textAlign: TextAlign.right,
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.45,
                        color: cs.onSurface,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (total.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(13, 10, 13, 0),
              padding: const EdgeInsets.only(top: 9),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.18),
                  ),
                ),
              ),
              child: Row(
                children: <Widget>[
                  Text(
                    totalLabel,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                  const Spacer(),
                  Text(
                    total,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.3,
                      color: cs.onSurface,
                    ),
                  ),
                ],
              ),
            ),
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
          if (_dismissed)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 10, 13, 0),
              child: Text(
                "已取消这一单，需要再买就说一句",
                style: TextStyle(
                  fontSize: 11,
                  height: 1.4,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          if (buttons.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 11, 13, 13),
              child: Row(
                children: <Widget>[
                  for (int i = 0; i < buttons.length; i++) ...<Widget>[
                    if (i > 0) const SizedBox(width: 8),
                    Flexible(
                      flex: buttons.length == 1
                          ? 1
                          : (shopStr(buttons[i]["variant"]) == "secondary"
                              ? 2
                              : 3),
                      child: ShopButton(
                        cs: cs,
                        label: _submitting && shopStr(buttons[i]["variant"]) != "secondary"
                            ? "正在提交…"
                            : shopStr(buttons[i]["label"]),
                        primary: shopStr(buttons[i]["variant"]) != "secondary",
                        onTap: expired || _dismissed || _submitting
                            ? null
                            : () {
                                final String ca =
                                    shopStr(buttons[i]["cardAction"]);
                                // 本地动作：不再往后走，本卡收尾，不发任何请求
                                if (ca == "local.dismiss") {
                                  setState(() => _dismissed = true);
                                  return;
                                }
                                // 提交订单本身要 10–30 秒，先置进度态再发，
                                // 否则用户看到的是「点了没反应」。
                                setState(() => _submitting = true);
                                _emit(
                                  shopStr(buttons[i]["label"]),
                                  shopStr(buttons[i]["variant"]).isEmpty
                                      ? "primary"
                                      : shopStr(buttons[i]["variant"]),
                                  cardAction: ca,
                                );
                              },
                      ),
                    ),
                  ],
                ],
              ),
            )
          else
            const SizedBox(height: 13),
        ],
      ),
    );
  }
}

/// 支付卡（设计稿 04 屏）：金额 + 收银台入口，Agent 不持支付凭据。
class ShoppingPayCard extends StatelessWidget {
  const ShoppingPayCard({
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
        id: "pay_${label.hashCode.abs()}",
        label: label,
        variant: "primary",
      ),
      cardData: data,
    );
  }

  /// 服务端给的 actions（「我已完成支付」/「稍后再说」）优先按原样回传：
  /// 这些动作带 payload（localOrderId/platform），自行拼 id 会丢上下文。
  void _emitAction(AgentResultAction action) {
    final AgentResultData? data = cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        onUserAction;
    if (data == null || cb == null) return;
    cb(action, cardData: data);
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = payload;
    final String amount = shopStr(p["amount"]);
    final String orderNo = shopStr(p["orderNo"]);
    final String platformLabel = shopStr(p["platformLabel"]);
    final String payLabel =
        shopStr(p["payLabel"]).isEmpty ? "去支付" : shopStr(p["payLabel"]);
    final String note = shopStr(p["note"]);
    final Uint8List? qr = _decodeQr(shopStr(p["qrImage"]));

    // 按钮文案：服务端 actions（「我已完成支付」）优先，缺省回退「去支付」。
    final List<AgentResultAction> actions =
        cardData?.actions ?? const <AgentResultAction>[];
    AgentResultAction? primaryAction;
    final List<AgentResultAction> otherActions = <AgentResultAction>[];
    for (final AgentResultAction a in actions) {
      if (primaryAction == null && a.variant == "primary") {
        primaryAction = a;
      }
    }
    for (final AgentResultAction a in actions) {
      if (a == primaryAction) continue;
      if (primaryAction == null) {
        primaryAction = a;
        continue;
      }
      otherActions.add(a);
    }
    final String primaryLabel = (primaryAction?.label ?? "").isEmpty
        ? payLabel
        : primaryAction!.label;

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ShopCardHeader(
            cs: cs,
            icon: Icons.check_circle_outline_rounded,
            iconColor: ShopTokens.ok,
            title: shopStr(p["title"]).isEmpty ? "订单已提交 · 待支付" : shopStr(p["title"]),
            trailing: platformLabel.isEmpty
                ? null
                : Text(
                    platformLabel,
                    style: TextStyle(
                      fontSize: 9.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
          ),
          ShopDivider(cs: cs),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 13, 13, 12),
            child: Column(
              children: <Widget>[
                Text(
                  shopStr(p["amountLabel"]).isEmpty
                      ? "应付金额"
                      : shopStr(p["amountLabel"]),
                  style: TextStyle(
                    fontSize: 10.5,
                    color: cs.onSurfaceVariant,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(
                    amount.isEmpty ? "—" : "¥$amount",
                    style: TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.8,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                if (qr != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Container(
                      width: 118,
                      height: 118,
                      padding: const EdgeInsets.all(6),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: cs.outline.withValues(alpha: 0.2),
                        ),
                      ),
                      child: Image.memory(qr, fit: BoxFit.contain),
                    ),
                  ),
                if (orderNo.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 9),
                    child: Text(
                      "订单号 $orderNo",
                      style: TextStyle(
                        fontSize: 9.5,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                const SizedBox(height: 12),
                ShopButton(
                  cs: cs,
                  label: primaryLabel,
                  onTap: () => primaryAction == null
                      ? _emit(payLabel)
                      : _emitAction(primaryAction),
                ),
                for (final AgentResultAction other in otherActions)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: ShopButton(
                      cs: cs,
                      primary: false,
                      label: other.label,
                      onTap: () => _emitAction(other),
                    ),
                  ),
                if (note.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      note,
                      style: TextStyle(
                        fontSize: 9.5,
                        height: 1.55,
                        color: cs.onSurfaceVariant,
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

  /// 收银台二维码：服务端只在拿到平台码图时下发 data URI。
  Uint8List? _decodeQr(String raw) {
    if (raw.isEmpty) return null;
    final int comma = raw.indexOf(",");
    final String body = raw.startsWith("data:") && comma > 0
        ? raw.substring(comma + 1)
        : raw;
    try {
      return base64Decode(body);
    } catch (_) {
      return null;
    }
  }
}

/// 商品主图（详情/确认共用）：网络图失败回退柔和底。
class _CoverThumb extends StatelessWidget {
  const _CoverThumb({required this.cs, required this.url});

  final ColorScheme cs;
  final String url;

  @override
  Widget build(BuildContext context) {
    final Widget fallback = DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[Color(0xFFF6F8FA), Color(0xFFDCE1E8)],
        ),
      ),
      child: Center(
        child: Icon(
          Icons.inventory_2_outlined,
          size: 34,
          color: Colors.black.withValues(alpha: 0.14),
        ),
      ),
    );
    if (url.isEmpty) return fallback;
    return Image.network(
      url,
      fit: BoxFit.cover,
      errorBuilder: (BuildContext c, Object e, StackTrace? s) => fallback,
      loadingBuilder: (BuildContext c, Widget child, ImageChunkEvent? p) =>
          p == null ? child : fallback,
    );
  }
}
