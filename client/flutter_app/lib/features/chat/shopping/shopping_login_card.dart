import "dart:async";

import "package:flutter/material.dart";

import "../../../core/config/media_url.dart";
import "../../../core/utils/agent_result_parser.dart";
import "shopping_shared.dart";

/// 购物登录卡（2026-11-06 用户定稿）：**二维码就在这张卡里，而且要大**。
///
/// 为什么不做成「推一张图 + 让用户说一句我扫了」：
///   · 那是两条消息、两个回合，用户还得滚回去找码；
///   · 手机端没有本地浏览器，扫码是唯一的登录手段，这一步必须短、必须大、
///     必须原地继续。
///
/// 交互：扫码 → 点「我扫好了」→ 本卡发出 shopping.login.check →
/// 服务端校验登录态并落 Cookie → 同一张卡接着走原来的动作（选规格/去结算）。
class ShoppingLoginCard extends StatefulWidget {
  const ShoppingLoginCard({
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
  State<ShoppingLoginCard> createState() => _ShoppingLoginCardState();
}

class _ShoppingLoginCardState extends State<ShoppingLoginCard> {
  /// 已点「我扫好了」、正等服务端校验（1–2 秒）。
  bool _checking = false;

  /// 兜底计时器：服务端校验失败（如还没扫码）不会回新卡，本 State 不会销毁，
  /// _checking 若不复位按钮就永远灰着。8 秒无下文就放开重试；若卡被
  /// card.update 替换，State 随之销毁，计时器自然取消。
  Timer? _checkGuard;

  @override
  void dispose() {
    _checkGuard?.cancel();
    super.dispose();
  }

  /// 点过「先不买」，本卡收尾。
  bool _dismissed = false;

  ColorScheme get cs => widget.cs;

  Map<String, dynamic> get p => widget.payload;

  Map<String, dynamic> _cardActions() {
    final Object? raw = p["actions"];
    if (raw is Map) {
      return <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries)
          e.key.toString(): e.value,
      };
    }
    return const <String, dynamic>{};
  }

  void _act(String actionId, {Map<String, dynamic>? payloadOverride}) {
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null || actionId.isEmpty) return;
    cb(
      AgentResultAction(
        id: actionId,
        label: shopStr(p["primaryLabel"]),
        variant: "primary",
        payload: <String, dynamic>{
          ..._cardActions(),
          ...?payloadOverride,
          "cardAction": actionId,
        },
      ),
      cardData: data,
    );
  }

  @override
  Widget build(BuildContext context) {
    final String qr = shopStr(p["qrImage"]);
    final String title = shopStr(p["title"]);
    final String label = shopStr(p["platformLabel"]);
    final String note = shopStr(p["note"]);
    final String primary = shopStr(p["primaryLabel"]);
    final String secondary = shopStr(p["secondaryLabel"]);

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 0),
            child: Row(
              children: <Widget>[
                Icon(Icons.qr_code_2_rounded, size: 17, color: cs.onSurface),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    title.isEmpty ? "扫码登录" : title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                if (label.isNotEmpty)
                  Text(
                    label,
                    style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                  ),
              ],
            ),
          ),
          // 二维码：手机端要能直接对着扫，所以给足尺寸（卡片内 ~220 方），
          // 白底衬托保证在深色卡面上也认得出来；扫不动的话一切都是空谈。
          // 同意卡（login-consent）没有码：不渲染这块，标题下直接是说明和按钮。
          if (qr.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
              child: Center(
                child: Container(
                  width: 220,
                  height: 220,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: cs.outline.withValues(alpha: 0.25),
                    ),
                  ),
                  child: Image.network(
                    MediaUrl.resolve(qr),
                    fit: BoxFit.contain,
                    // 二维码是黑白的，放大时别被插值糊掉边
                    filterQuality: FilterQuality.high,
                    errorBuilder: (_, __, ___) => Center(
                      child: Text(
                        "二维码加载失败",
                        style: TextStyle(
                          fontSize: 11.5,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
              child: Text(
                note,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  height: 1.5,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          if (_dismissed)
            const Padding(
              padding: EdgeInsets.fromLTRB(14, 10, 14, 0),
              child: Text(
                "已放下，需要买的时候再说一句",
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11, height: 1.4, color: ShopTokens.warn),
              ),
            ),
          if (!_dismissed && (primary.isNotEmpty || secondary.isNotEmpty))
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 13),
              child: Row(
                children: <Widget>[
                  if (secondary.isNotEmpty) ...<Widget>[
                    Flexible(
                      flex: 2,
                      child: ShopButton(
                        cs: cs,
                        label: secondary,
                        primary: false,
                        // 次按钮两种语义：local.dismiss = 纯本地收尾；其它 =
                        // 也是卡内动作（如同意卡的「不保存」带 save:false）。
                        onTap: _checking
                            ? null
                            : () {
                                final String sa = shopStr(p["secondaryAction"]);
                                if (sa.isEmpty || sa == "local.dismiss") {
                                  setState(() => _dismissed = true);
                                  return;
                                }
                                setState(() => _checking = true);
                                _checkGuard?.cancel();
                                _checkGuard = Timer(const Duration(seconds: 8), () {
                                  if (mounted) setState(() => _checking = false);
                                });
                                _act(
                                  sa,
                                  // 同意卡的「不保存」：显式 save=false 覆盖 actions 里的默认
                                  payloadOverride: <String, dynamic>{"save": false},
                                );
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
                        label: _checking ? "正在确认登录…" : primary,
                        onTap: _checking
                            ? null
                            : () {
                                setState(() => _checking = true);
                                _checkGuard?.cancel();
                                _checkGuard = Timer(
                                  const Duration(seconds: 8),
                                  () {
                                    if (mounted) {
                                      setState(() => _checking = false);
                                    }
                                  },
                                );
                                _act(shopStr(p["primaryAction"]));
                              },
                      ),
                    ),
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
