import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../../core/config/media_url.dart";
import "../../../core/utils/agent_result_parser.dart";
import "../media_disk_cache.dart";
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
///
/// 2026-11-13 P1 增补（用户要的三件事都在这张卡里闭环，不再回对话）：
///   · 「跳过这家」——某家平台用户不打算登录了，跳过即可，其余照常比；
///   · 「补齐待登录平台」——待登录清单常驻卡上，剩余平台逐家可见；
///   · 「重新出码」——二维码过期（平台侧一般 2–5 分钟失效）时原地换新码。
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

  /// 卡内动作的公共上下文（服务端要的额外参数）。
  ///
  /// 例：登录成功后的次按钮「先比已登录的」要带 skipPending=true——
  /// 服务端据此把还没登录的平台记成「已跳过」而不是「没价」。
  Map<String, dynamic> _secondaryPayload() {
    final Object? raw = p["secondaryPayload"];
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

  /// 行内次级动作（跳过这家 / 重新出码，2026-11-13 P1）。
  ///
  /// 不走 loading 态：这些动作的反馈是「服务端把这张卡原地换掉」，
  /// 等回执期间按钮保持可点，避免用户以为没点上而连点。
  void _quickAct(String actionId, Map<String, dynamic> payload) {
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null || actionId.isEmpty) return;
    cb(
      AgentResultAction(
        id: actionId,
        label: actionId,
        variant: "secondary",
        payload: <String, dynamic>{
          ..._cardActions(),
          ...payload,
          "cardAction": actionId,
        },
      ),
      cardData: data,
    );
  }

  /// 跳过某一家平台：这家不再等登录，其余照常。
  void _skipPlatform(String platform) {
    _quickAct("shopping.login.skip", <String, dynamic>{"platform": platform});
  }

  /// 二维码失效：给某家（或全部）换一张新码。
  void _refreshQr(String platform) {
    _quickAct("shopping.login.refresh", <String, dynamic>{"platform": platform});
  }

  /// 点码登录（2026-11-14）：服务端把二维码解码出内嵌 URL 并包装成 App 深链，
  /// 点一下直接拉起对应 App 走平台自己的登录确认页——省掉
  /// 「存图 → 开 App → 相册扫码」三步。深链打不开（没装 App / scheme 失效）
  /// 就退回原 URL（universal link 可能拉起，不行就系统浏览器），再不行提示扫码。
  Future<void> _openAppLink(String? link, String? fallback, String platformLabel) async {
    final String target = (link ?? "").trim();
    if (target.isEmpty) return;
    Future<bool> tryLaunch(String raw) async {
      final Uri? uri = Uri.tryParse(raw);
      if (uri == null) return false;
      try {
        return await launchUrl(uri, mode: LaunchMode.externalApplication);
      } catch (_) {
        // 没有能处理该 scheme 的 App 时 url_launcher 会抛 PlatformException
        return false;
      }
    }

    if (await tryLaunch(target)) return;
    final String fb = (fallback ?? "").trim();
    if (fb.isNotEmpty && await tryLaunch(fb)) return;
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          "没能打开${platformLabel.isEmpty ? "对应" : platformLabel}App，请用 App 扫码登录",
        ),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  /// 待登录平台清单。
  ///
  /// 兼容两种载荷：新的 `[{platform, platformLabel}]`（P1 服务端下发）与旧的
  /// `["jd", "taobao"]`（历史消息回放）——旧载荷没有中文名，退回平台 id。
  List<Map<String, dynamic>> _pendingRows() {
    final Object? raw = p["pendingPlatforms"];
    if (raw is! List) return const <Map<String, dynamic>>[];
    final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
    for (final Object? e in raw) {
      if (e is Map) {
        out.add(<String, dynamic>{
          for (final MapEntry<Object?, Object?> kv in e.entries)
            kv.key.toString(): kv.value,
        });
      } else {
        final String id = shopStr(e);
        if (id.isEmpty) continue;
        out.add(<String, dynamic>{"platform": id, "platformLabel": id});
      }
    }
    return out;
  }

  /// 已登录平台清单（login-consent 阶段用）。
  ///
  /// 服务端同时下发 `readyPlatformLabels`（中文名，给用户看）与
  /// `readyPlatforms`（平台 id，给动作回传用）；旧载荷只有 id 时退回 id。
  List<String> _readyPlatforms() {
    final Object? labels = p["readyPlatformLabels"];
    if (labels is List && labels.isNotEmpty) {
      return labels
          .map((Object? e) => shopStr(e))
          .where((String e) => e.isNotEmpty)
          .toList(growable: false);
    }
    final Object? raw = p["readyPlatforms"];
    if (raw is! List) return const <String>[];
    return raw
        .map((Object? e) => shopStr(e))
        .where((String e) => e.isNotEmpty)
        .toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final String qr = shopStr(p["qrImage"]);
    // 多平台登录（2026-11-13 P0-2）：一次把要登录的几家二维码全推出来，
    // 卡内每家一个分区（平台名 + 各自的码），用户扫任意一个即可全部放行。
    // 用户投诉「说让我补京东的登录之后再补」——一次一张要扫三轮。
    final List<Map<String, dynamic>> qrItems = shopMaps(p["qrItems"]);
    final bool multiLogin = qrItems.length > 1;
    // 只有一家时，服务端也走 qrItems（统一形态）；旧的单码载荷仍兼容 qrImage。
    // 比价单家卡字段在 qrItems.first；下单单家卡字段直接铺在 payload 顶层
    // （qrImage/qrLink/qrLinkFallback）——这里合并成一张"单家视图"，两种都对。
    final bool hasSingleQrItem = qrItems.length == 1;
    final Map<String, dynamic> singleItem = hasSingleQrItem
        ? qrItems.first
        : <String, dynamic>{
            "platform": shopStr(p["platform"]),
            "platformLabel": shopStr(p["platformLabel"]),
            "qrImage": qr,
            "qrLink": shopStr(p["qrLink"]),
            "qrLinkFallback": shopStr(p["qrLinkFallback"]),
          };
    final String singleQr = hasSingleQrItem
        ? shopStr(qrItems.first["qrImage"])
        : qr;
    final List<Map<String, dynamic>> pendingRows = _pendingRows();
    final List<String> ready = _readyPlatforms();
    final String title = shopStr(p["title"]);
    final String label = shopStr(p["platformLabel"]);
    final String note = shopStr(p["note"]);
    final String primary = shopStr(p["primaryLabel"]);
    final String secondary = shopStr(p["secondaryLabel"]);

    // 卡上已经画了码的平台（这些平台不再重复出现在「待登录清单」里，
    // 否则「跳过这家」会出现在两个地方，用户不知道点哪个）。
    final Set<String> drawnPlatforms = qrItems
        .map((Map<String, dynamic> it) => shopStr(it["platform"]))
        .where((String s) => s.isNotEmpty)
        .toSet();
    final List<Map<String, dynamic>> listOnlyRows = pendingRows
        .where((Map<String, dynamic> it) =>
            !drawnPlatforms.contains(shopStr(it["platform"])))
        .toList();

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
          // 多平台登录：每家一个分区，平台名 + 各自的二维码 + 「跳过这家」。
          // 横向排布（每家 ~46% 宽），手机上一次看全，不用上下翻。
          if (multiLogin)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  for (int i = 0; i < qrItems.length; i++) ...<Widget>[
                    if (i > 0) const SizedBox(width: 10),
                    Expanded(
                      child: _MultiQrCell(
                        cs: cs,
                        platform: shopStr(qrItems[i]["platform"]),
                        label: shopStr(qrItems[i]["platformLabel"]),
                        qrImage: shopStr(qrItems[i]["qrImage"]),
                        qrLink: shopStr(qrItems[i]["qrLink"]),
                        qrLinkFallback: shopStr(qrItems[i]["qrLinkFallback"]),
                        onSkip: _skipPlatform,
                        onOpenApp: _openAppLink,
                      ),
                    ),
                  ],
                ],
              ),
            )
          // 二维码：手机端要能直接对着扫，所以给足尺寸（卡片内 ~220 方），
          // 白底衬托保证在深色卡面上也认得出来；扫不动的话一切都是空谈。
          // 同意卡（login-consent）没有码：不渲染这块，标题下直接是说明和按钮。
          // 没截到码但知道是哪家：仍要渲染（码区显示占位），按钮照常可点——
          // 「重新出码 / 点码登录 / 跳过这家」不因截图失败而一起消失。
          // 仅限登录阶段：同意卡（login-consent）本来就没有码，别给它画占位。
          else if (singleQr.isNotEmpty ||
              (shopStr(singleItem["platform"]).isNotEmpty &&
                  shopStr(p["stage"]) == "login"))
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // 单家也要点名来源（用户要知道在给哪家登录）
                  if (shopStr(singleItem["platformLabel"]).isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(
                        shopStr(singleItem["platformLabel"]),
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                  Center(
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
                      child: singleQr.isEmpty
                          ? Center(
                              child: Text(
                                "没截到码",
                                style: TextStyle(
                                  fontSize: 11,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            )
                          : CachedMediaImage(
                              url: MediaUrl.resolve(singleQr),
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
                  // 单家也要有「点码登录 / 跳过这家 / 重新出码」：否则用户只能
                  // 回到对话里问一句，整条「登录完再统一交付」的链就断了。
                  if (shopStr(singleItem["platform"]).isNotEmpty) ...<Widget>[
                    const SizedBox(height: 8),
                    // 点码登录（2026-11-14）：服务端给了深链才渲染；点了拉起
                    // 对应 App 直接确认，不用相机扫码。
                    if (shopStr(singleItem["qrLink"]).isNotEmpty)
                      ShopMiniButton(
                        cs: cs,
                        label: "点码登录",
                        onTap: () => _openAppLink(
                          shopStr(singleItem["qrLink"]),
                          shopStr(singleItem["qrLinkFallback"]),
                          shopStr(singleItem["platformLabel"]),
                        ),
                      ),
                    if (shopStr(singleItem["qrLink"]).isNotEmpty)
                      const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        ShopMiniButton(
                          cs: cs,
                          label: "重新出码",
                          onTap: () => _refreshQr(shopStr(singleItem["platform"])),
                        ),
                        const SizedBox(width: 8),
                        ShopMiniButton(
                          cs: cs,
                          label: "跳过这家",
                          tone: ShopMiniTone.danger,
                          onTap: () => _skipPlatform(shopStr(singleItem["platform"])),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          // 已登录平台（部分登录成功时）：先告诉用户哪几家成了。
          if (ready.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
              child: Row(
                children: <Widget>[
                  Icon(Icons.check_circle_outline_rounded,
                      size: 13, color: ShopTokens.ok),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      "已登录：${ready.join("、")}",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // 待登录平台清单（P1-2）：每家一行，可「重新出码」/「跳过这家」。
          // 这是「补齐待登录平台」的入口——用户一眼看到还差哪几家，
          // 不用回到对话里问「还差什么」。
          if (listOnlyRows.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
              child: _PendingPlatformList(
                cs: cs,
                items: listOnlyRows,
                onRefresh: _refreshQr,
                onSkip: _skipPlatform,
              ),
            ),
          // 卡上已经画了码的多平台：给一个「全部重新出码」的入口
          // （码过期时不必一家一家点）。
          if (multiLogin)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      "码过期了？换一张新的",
                      style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                    ),
                  ),
                  ShopMiniButton(
                    cs: cs,
                    label: "重新出码",
                    onTap: () {
                      for (final Map<String, dynamic> it in qrItems) {
                        final String pid = shopStr(it["platform"]);
                        if (pid.isNotEmpty) _refreshQr(pid);
                      }
                    },
                  ),
                ],
              ),
            ),
          if (note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
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
                                  // 同意卡的「不保存」：显式 save=false 覆盖 actions 里的默认；
                                  // 其它次按钮可带服务端预置的额外参数（如 skipPending）
                                  payloadOverride: <String, dynamic>{
                                    ..._secondaryPayload(),
                                    "save": false,
                                  },
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

/// 多平台登录码单元（2026-11-13 P0-2）：一个平台分区 = 平台名 + 它的二维码。
///
/// 为什么要多码同卡：用户投诉「说让我补京东的登录之后再补」——旧实现一次
/// 只推一张码，用户要来回扫三四轮才能比完。现在一次把要登录的几家全推出来，
/// **扫任意一个即可全部放行**（服务端登录态探针会逐家确认）。
///
/// P1 增补：每格下面挂一个「跳过这家」——用户不打算登录某家时，
/// 跳过即可，其余平台照常比价，不必整轮重来。
///
/// 点码登录（2026-11-14）：服务端把码解码转成 App 深链（qrLink）时，
/// 格里再挂一个「点码登录」——点了直接拉起 App 确认，不用相机扫码。
class _MultiQrCell extends StatelessWidget {
  const _MultiQrCell({
    required this.cs,
    required this.platform,
    required this.label,
    required this.qrImage,
    this.qrLink = "",
    this.qrLinkFallback = "",
    this.onSkip,
    this.onOpenApp,
  });

  final ColorScheme cs;
  final String platform;
  final String label;
  final String qrImage;
  /// 服务端解码二维码得到的 App 深链（空 = 不渲染「点码登录」按钮）。
  final String qrLink;
  /// 深链打不开时退回的原 URL（通常为 https，浏览器/universal link 兜底）。
  final String qrLinkFallback;
  final void Function(String platform)? onSkip;
  final Future<void> Function(String? link, String? fallback, String platformLabel)? onOpenApp;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        // 平台名（来源必须显眼）
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: cs.onSurface,
          ),
        ),
        const SizedBox(height: 6),
        // 二维码：白底衬托，深色卡面上也认得出来
        Container(
          width: 128,
          height: 128,
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
          ),
          child: qrImage.isEmpty
              ? Center(
                  child: Text(
                    "没截到码",
                    style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                  ),
                )
              : CachedMediaImage(
                  url: MediaUrl.resolve(qrImage),
                  fit: BoxFit.contain,
                  // 二维码是黑白的，放大时别被插值糊掉边
                  filterQuality: FilterQuality.high,
                  errorBuilder: (_, __, ___) => Center(
                    child: Text(
                      "二维码加载失败",
                      style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                    ),
                  ),
                ),
        ),
        // 点码登录：点了直接拉起对应 App 确认登录（深链打不开时
        // 回调内部会退回 fallback 并提示扫码）。
        if (qrLink.isNotEmpty && onOpenApp != null) ...<Widget>[
          const SizedBox(height: 6),
          ShopMiniButton(
            cs: cs,
            label: "点码登录",
            onTap: () => onOpenApp!(qrLink, qrLinkFallback, label),
          ),
        ],
        if (onSkip != null) ...<Widget>[
          const SizedBox(height: 6),
          ShopMiniButton(
            cs: cs,
            label: "跳过这家",
            tone: ShopMiniTone.danger,
            onTap: platform.isEmpty ? null : () => onSkip!(platform),
          ),
        ],
      ],
    );
  }
}

/// 待登录平台清单（2026-11-13 P1-2）：每家一行 + 两个行内动作。
///
/// 「重新出码」和「跳过这家」是两个方向的用户意图：
///   · 重新出码 = 我还想在这家买，只是码过期了；
///   · 跳过这家 = 这家我不比了，别再等我。
class _PendingPlatformList extends StatelessWidget {
  const _PendingPlatformList({
    required this.cs,
    required this.items,
    this.onRefresh,
    this.onSkip,
  });

  final ColorScheme cs;
  final List<Map<String, dynamic>> items;
  final void Function(String platform)? onRefresh;
  final void Function(String platform)? onSkip;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final Map<String, dynamic> it in items)
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Row(
              children: <Widget>[
                ShopPlatformTag(
                  cs: cs,
                  platform: shopStr(it["platform"]),
                  label: shopStr(it["platformLabel"]).isEmpty
                      ? shopStr(it["platform"])
                      : shopStr(it["platformLabel"]),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    "需要登录",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                  ),
                ),
                if (onRefresh != null)
                  ShopMiniButton(
                    cs: cs,
                    label: "重新出码",
                    onTap: () {
                      final String pid = shopStr(it["platform"]);
                      if (pid.isNotEmpty) onRefresh!(pid);
                    },
                  ),
                if (onSkip != null) ...<Widget>[
                  const SizedBox(width: 6),
                  ShopMiniButton(
                    cs: cs,
                    label: "跳过这家",
                    tone: ShopMiniTone.danger,
                    onTap: () {
                      final String pid = shopStr(it["platform"]);
                      if (pid.isNotEmpty) onSkip!(pid);
                    },
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}
