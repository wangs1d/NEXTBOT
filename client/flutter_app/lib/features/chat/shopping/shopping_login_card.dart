import "dart:async";

import "package:flutter/foundation.dart" show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:photo_manager/photo_manager.dart";
import "package:url_launcher/url_launcher.dart";

import "../../../core/config/media_url.dart";
import "../../../core/utils/agent_result_parser.dart";
import "../media_disk_cache.dart";
import "platform_login_webview_page.dart";
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

  /// 二维码有效期倒计时时钟（2026-11-20）。
  ///
  /// 平台登录码一般只有 2~5 分钟寿命；用户过一会儿再点「点码登录」，App 里
  /// 只会说「二维码已失效」或干脆没反应——看起来像 App 坏了。这里按出码时刻
  /// 秒级倒计时，临近失效（<25s）/已过期时点击改成「先换新码再跳」。
  Timer? _qrClock;
  int _nowMs = DateTime.now().millisecondsSinceEpoch;
  static const int _qrTtlMs = 150000;
  static const int _qrRefreshAheadMs = 25000;

  @override
  void initState() {
    super.initState();
    _qrClock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _nowMs = DateTime.now().millisecondsSinceEpoch);
    });
  }

  @override
  void dispose() {
    _checkGuard?.cancel();
    _qrClock?.cancel();
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
    // 本地动作（2026-11-21）：重新粘贴 Cookie——纯 UI，不占网络往返。
    // 主按钮路径会先把 _checking 置 true，这里要复位，别让按钮灰 8 秒。
    if (actionId == "local.importDialog") {
      if (_checking) setState(() => _checking = false);
      _openImportChooser();
      return;
    }
    // 本地动作（2026-11-22）：登录失败卡上的「重新登录」——直接再拉起
    // App 内登录页，不用回对话重来一遍。
    if (actionId == "local.webLogin") {
      if (_checking) setState(() => _checking = false);
      final String pid = shopStr(p["platform"]);
      final String plabel = shopStr(p["platformLabel"]);
      if (pid.isNotEmpty) {
        _openWebLogin(pid, plabel.isEmpty ? pid : plabel);
      } else {
        _openWebLoginChooser();
      }
      return;
    }
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
  ///
  /// 换码要重新打开平台登录页，期间必须有反馈——否则用户点了「换新码」
  /// 半天没动静，会以为按钮坏了。
  void _refreshQr(String platform) {
    _quickAct("shopping.login.refresh", <String, dynamic>{"platform": platform});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("正在重新出码…"),
        duration: Duration(seconds: 3),
      ),
    );
  }

  // ── 手动导入 Cookie（2026-11-21）──────────────────────────────────────
  //
  // 扫码授权被平台风控拦死（拼多多不向无头浏览器兑现登录态，手机怎么确认
  // 云端都拿不到 Cookie），登录入口补一条手动路：用户在自己浏览器里登录、
  // 导出 Cookie 粘贴进来，服务端校验后问「是否保存」，保存即永久免扫码。

  /// 卡上可导入的平台：优先卡上画了码的几家，其次单家卡，最后退待登录清单。
  List<Map<String, String>> get _importTargets {
    final List<Map<String, String>> out = <Map<String, String>>[];
    void push(String platform, String label) {
      final String pid = platform.trim();
      if (pid.isEmpty || out.any((Map<String, String> e) => e["platform"] == pid)) return;
      out.add(<String, String>{
        "platform": pid,
        "platformLabel": label.trim().isEmpty ? pid : label.trim(),
      });
    }

    for (final Map<String, dynamic> it in shopMaps(p["qrItems"])) {
      push(shopStr(it["platform"]), shopStr(it["platformLabel"]));
    }
    push(shopStr(p["platform"]), shopStr(p["platformLabel"]));
    for (final Map<String, dynamic> it in _pendingRows()) {
      push(shopStr(it["platform"]), shopStr(it["platformLabel"]));
    }
    return out;
  }

  /// 打开导入入口：只有一家直接弹粘贴框；多家先选一家。
  Future<void> _openImportChooser() async {
    final List<Map<String, String>> targets = _importTargets;
    if (targets.isEmpty) return;
    if (targets.length == 1) {
      await _showImportDialog(targets.first["platform"]!, targets.first["platformLabel"]!);
      return;
    }
    final Map<String, String>? picked = await showDialog<Map<String, String>>(
      context: context,
      builder: (BuildContext ctx) => SimpleDialog(
        title: const Text("给哪家导入 Cookie？"),
        children: <Widget>[
          for (final Map<String, String> t in targets)
            SimpleDialogOption(
              onPressed: () => Navigator.of(ctx).pop(t),
              child: Text(t["platformLabel"] ?? t["platform"] ?? ""),
            ),
        ],
      ),
    );
    if (picked == null || !mounted) return;
    await _showImportDialog(picked["platform"]!, picked["platformLabel"]!);
  }

  /// 粘贴对话框：带「怎么导出」的教学文案（手机端没法直接拿 Cookie，
  /// 主路径是电脑浏览器 F12 复制请求标头里的 Cookie 整串）。  /// controller 归对话框组件所有（见 [_CookiePasteDialog]）——pop 出场动画
  /// 期间 TextField 还在用它，不能在这里同步 dispose。
  Future<void> _showImportDialog(String platform, String platformLabel) async {
    final String? text = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => _CookiePasteDialog(platformLabel: platformLabel),
    );
    if (text == null || text.isEmpty || !mounted) return;
    _quickAct("shopping.login.import", <String, dynamic>{
      "platform": platform,
      "cookieText": text,
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("正在校验 Cookie…"),
        duration: Duration(seconds: 3),
      ),
    );
  }

  // ── App 内 WebView 登录（2026-11-22）────────────────────────────────
  //
  // 手机端没有桌面那种「用户自己的 WebView2」：比价跑在云端无头 Chromium 里，
  // 拼多多这类平台不向无头浏览器兑现登录态——扫码确认再多次，云端 context
  // 里也没有 PDDUserID。所以补一条「在 App 里真登录一次，把 Cookie 交回云端
  // 落库」的路：这一页是手机端唯一能拿到完整登录态（含 HttpOnly）的地方。

  bool get _canWebLogin =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// 有内置登录页的平台（映射表里没有的不给入口，免得打开一个登不进去的页）。
  List<Map<String, String>> get _webLoginTargets => _importTargets
      .where((Map<String, String> t) =>
          kPlatformWebLoginUrls.containsKey(t["platform"] ?? ""))
      .toList();

  Future<void> _openWebLoginChooser() async {
    final List<Map<String, String>> targets = _webLoginTargets;
    if (targets.isEmpty) return;
    if (targets.length == 1) {
      await _openWebLogin(targets.first["platform"]!, targets.first["platformLabel"]!);
      return;
    }
    final Map<String, String>? picked = await showDialog<Map<String, String>>(
      context: context,
      builder: (BuildContext ctx) => SimpleDialog(
        title: const Text("登录哪一家？"),
        children: <Widget>[
          for (final Map<String, String> t in targets)
            SimpleDialogOption(
              onPressed: () => Navigator.of(ctx).pop(t),
              child: Text(t["platformLabel"] ?? t["platform"] ?? ""),
            ),
        ],
      ),
    );
    if (picked == null || !mounted) return;
    await _openWebLogin(picked["platform"]!, picked["platformLabel"]!);
  }

  /// 打开登录页 → 拿到 Cookie → 回传服务端（落库 + 灌 context + 续跑比价）。
  Future<void> _openWebLogin(String platform, String platformLabel) async {
    final List<Map<String, String>>? cookies =
        await Navigator.of(context).push<List<Map<String, String>>>(
      MaterialPageRoute<List<Map<String, String>>>(
        builder: (BuildContext _) => PlatformLoginWebViewPage(
          platform: platform,
          platformLabel: platformLabel,
        ),
      ),
    );
    if (cookies == null || cookies.isEmpty || !mounted) return;
    _quickAct("shopping.login.cookies", <String, dynamic>{
      "platform": platform,
      "cookies": cookies,
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text("拿到 ${cookies.length} 条 Cookie，正在保存…"),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  /// 点码登录（2026-11-14）：服务端把二维码解码出内嵌 URL 并包装成 App 深链，
  /// 点一下直接拉起对应 App 走平台自己的登录确认页——省掉
  /// 「存图 → 开 App → 相册扫码」三步。深链打不开（没装 App / scheme 失效）
  /// 就退回原 URL（universal link 可能拉起，不行就系统浏览器），再不行提示扫码。
  Future<void> _openAppLink(
    String? link,
    String? fallback,
    String platformLabel, {
    String? imageUrl,
  }) async {
    final String target = (link ?? "").trim();
    Future<bool> tryLaunch(String raw) async {
      if (raw.isEmpty) return false;
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
    if (await tryLaunch(fb)) return;

    // 没有可用深链（2026-11-21：拼多多的 down_scan 落地页跳 App 到不了确认
    // 界面，服务端已不再给它深链）：把码存进相册，明确告诉用户走
    // 「打开 App → 扫一扫 → 从相册选这张码 → 确认」。这是拼多多登录确认的
    // 唯一通路（平台安全设计，任何 agent 绕不过），不是「没找到 App」。
    // 服务端同时后台自动检测登录态，扫完不用回来点任何按钮。
    final bool saved = await _saveQrToGallery(imageUrl);
    if (!mounted) return;
    final String who = platformLabel.isEmpty ? "对应" : platformLabel;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          saved
              ? "二维码已存相册：打开$who → 扫一扫 → 从相册选这张码确认登录。扫完不用回来点，我会自动接着比价"
              : "请用$who的扫一扫扫这张码确认登录；扫完我会自动接着比价",
        ),
        duration: const Duration(seconds: 5),
      ),
    );
  }

  /// 把二维码写进系统相册（无 App 时的兜底路径）。
  ///
  /// 走带鉴权的请求取原图字节（`/agent/images/` 需要 Authorization，裸 URL
  /// 下载会 401），再用 photo_manager 直接入库——不经过"先存文件再让用户去
  /// 相册找"的两步。桌面端没有相册概念，直接返回 false 走扫码提示。
  Future<bool> _saveQrToGallery(String? url) async {
    final String raw = (url ?? "").trim();
    if (raw.isEmpty) return false;
    final bool mobile =
        defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
    if (kIsWeb || !mobile) return false;
    try {
      final http.Response resp = await http.get(
        Uri.parse(MediaUrl.resolve(raw)),
        headers: MediaUrl.headersFor(raw),
      );
      if (resp.statusCode < 200 || resp.statusCode >= 300 || resp.bodyBytes.isEmpty) {
        return false;
      }
      await PhotoManager.editor.saveImage(
        resp.bodyBytes,
        filename: "nextbot-qr-${DateTime.now().millisecondsSinceEpoch}.png",
      );
      return true;
    } catch (_) {
      return false;
    }
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
    // 单家码的有效期（与多平台同一套 TTL 口径）
    final int? singleIssuedAt = (singleItem["issuedAt"] as num?)?.toInt();
    final bool singleHasAge = singleIssuedAt != null && _nowMs > 0;
    final int singleLeftMs =
        singleHasAge ? (singleIssuedAt + _qrTtlMs - _nowMs) : _qrTtlMs;
    final bool singleExpired = singleHasAge && singleLeftMs <= 0;
    final bool singleStale = singleHasAge && singleLeftMs <= _qrRefreshAheadMs;
    final String singleAgeLabel = !singleHasAge
        ? ""
        : singleExpired
            ? "二维码已过期"
            : "码还剩 ${(singleLeftMs / 1000).round() ~/ 60}:${((singleLeftMs / 1000).round() % 60).toString().padLeft(2, "0")}，过期就点一下换新码";
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
                        issuedAt: (qrItems[i]["issuedAt"] as num?)?.toInt(),
                        nowMs: _nowMs,
                        ttlMs: _qrTtlMs,
                        refreshAheadMs: _qrRefreshAheadMs,
                        onRefresh: _refreshQr,
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
                    child: GestureDetector(
                      // 过期/快过期先换码（旧码进 App 只会「已失效」）；
                      // 否则直接唤起 App，没深链则存相册。
                      onTap: singleQr.isEmpty
                          ? null
                          : () {
                              if (singleStale) {
                                _refreshQr(shopStr(singleItem["platform"]));
                                return;
                              }
                              _openAppLink(
                                shopStr(singleItem["qrLink"]),
                                shopStr(singleItem["qrLinkFallback"]),
                                shopStr(singleItem["platformLabel"]),
                                imageUrl: singleQr,
                              );
                            },
                      child: Stack(
                      children: <Widget>[
                      Container(
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
                              // 二维码是黑白硬边图：最近邻缩放保住模块边界，
                              // 插值会把细小模块糊成灰边（相册/截屏扫码识别不出来）
                              filterQuality: FilterQuality.none,
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
                      if (singleExpired && singleQr.isNotEmpty)
                        Positioned.fill(
                          child: Container(
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.82),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            alignment: Alignment.center,
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(Icons.refresh_rounded,
                                    size: 22, color: cs.onSurfaceVariant),
                                const SizedBox(height: 5),
                                Text(
                                  "已过期\n点一下换新码",
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                    fontSize: 11,
                                    height: 1.35,
                                    color: cs.onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                      ),
                    ),
                  ),
                  if (singleHasAge && (singleExpired || singleLeftMs <= 60000))
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Text(
                        singleAgeLabel,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 9.5,
                          color: singleExpired
                              ? ShopTokens.warn
                              : cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                  // 单家也要有「点码登录 / 保存二维码」入口：有深链就拉起 App，
                  // 没有深链的平台（无 scheme 表）明确给「保存二维码」，
                  // 不能只靠用户猜到去点码本身。
                  if (shopStr(singleItem["platform"]).isNotEmpty) ...<Widget>[
                    const SizedBox(height: 8),
                    ShopMiniButton(
                      cs: cs,
                      label: singleStale
                          ? "换一张新码"
                          : shopStr(singleItem["qrLink"]).isNotEmpty
                              ? "点码登录"
                              : "保存二维码",
                      onTap: singleStale
                          ? () => _refreshQr(shopStr(singleItem["platform"]))
                          : () => _openAppLink(
                                shopStr(singleItem["qrLink"]),
                                shopStr(singleItem["qrLinkFallback"]),
                                shopStr(singleItem["platformLabel"]),
                                imageUrl: singleQr,
                              ),
                    ),
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
                  const Spacer(),
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
          // 手动导入 Cookie 入口（2026-11-21）：扫码被平台风控拦死时的
          // 替代登录路。只在「还在等登录」的卡上常驻（主动作是登录校验/
          // 继续比价/重新粘贴），「是否保存」「已保存」这些后置卡不出现，
          // 避免误导再导一次。不能拿 qrItems/pendingPlatforms 判——下单
          // 单家卡的字段铺在顶层，同样在等登录。
          if (_importTargets.isNotEmpty &&
              <String>[
                "shopping.login.check",
                "shopping.compare.resume",
                "local.importDialog",
              ].contains(shopStr(p["primaryAction"])))
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
              // 窄屏上两个按钮并排会顶出边界，用 Wrap 让它们自己换行
              child: Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 6,
                children: <Widget>[
                  // App 内登录（2026-11-22）：手机端唯一能拿到完整登录态的路。
                  // 放在「手动导入」前面——它更短、更可能成功，用户第一眼先看到。
                  if (_canWebLogin && _webLoginTargets.isNotEmpty)
                    ShopMiniButton(
                      cs: cs,
                      label: "在 App 内登录",
                      onTap: () => _openWebLoginChooser(),
                    ),
                  ShopMiniButton(
                    cs: cs,
                    label: "手动导入 Cookie",
                    onTap: () => _openImportChooser(),
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
    this.issuedAt,
    this.nowMs = 0,
    this.ttlMs = 150000,
    this.refreshAheadMs = 25000,
    this.onRefresh,
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
  /// 出码时刻（服务端 epoch ms）。null = 老卡/历史消息，不做倒计时。
  final int? issuedAt;
  /// 当前时刻（父级每秒 tick 传下来）。
  final int nowMs;
  final int ttlMs;
  final int refreshAheadMs;
  final void Function(String platform)? onRefresh;
  final void Function(String platform)? onSkip;
  final Future<void> Function(
    String? link,
    String? fallback,
    String platformLabel, {
    String? imageUrl,
  })? onOpenApp;

  bool get _hasAge => issuedAt != null && nowMs > 0;
  int get _leftMs => _hasAge ? (issuedAt! + ttlMs - nowMs) : ttlMs;
  bool get _expired => _hasAge && _leftMs <= 0;
  bool get _stale => _hasAge && _leftMs <= refreshAheadMs;

  /// 剩余时间文案（只在快过期/已过期时给，平时不打扰）。
  String get _ageLabel {
    if (!_hasAge) return "";
    if (_expired) return "二维码已过期";
    final int totalSec = (_leftMs / 1000).round();
    final String mm = (totalSec ~/ 60).toString();
    final String ss = (totalSec % 60).toString().padLeft(2, "0");
    return "码还剩 $mm:$ss，过期就点一下换新码";
  }

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
        // 二维码：白底衬托，深色卡面上也认得出来。
        //
        // 点码登录（2026-11-19 用户要求）：**整块码本身可点**。用户看到码的
        // 第一反应是去戳它，而不是去找下面那颗小按钮。点一下直接拉起对应
        // App 确认登录，省掉「存图 → 开 App → 相册扫码 → 确认」四步；
        // 扫码路径原样保留（没装 App / 深链失效时照样能扫）。
        GestureDetector(
          // 有深链 → 唤起 App；没深链（拼多多/解码失败）→ 也让它可点，
          // 点击直接把码存进相册（2026-11-19「没有 App 的允许保存」）。
          //
          // 过期/快过期（2026-11-20）：先换新码，**不跳**。旧码进了 App 只会
          // 提示「已失效」或毫无反应——用户会以为 App 坏了。
          onTap: qrImage.isEmpty || onOpenApp == null
              ? null
              : () {
                  if (_stale) {
                    onRefresh?.call(platform);
                    return;
                  }
                  onOpenApp!(qrLink, qrLinkFallback, label, imageUrl: qrImage);
                },
          child: Container(
            width: 128,
            height: 128,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
            ),
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                qrImage.isEmpty
                    ? Center(
                        child: Text(
                          "没截到码",
                          style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                        ),
                      )
                    : CachedMediaImage(
                        url: MediaUrl.resolve(qrImage),
                        fit: BoxFit.contain,
                        // 同上：硬边码图用最近邻，别让缩放插值糊掉模块
                        filterQuality: FilterQuality.none,
                        errorBuilder: (_, __, ___) => Center(
                          child: Text(
                            "二维码加载失败",
                            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                          ),
                        ),
                      ),
                // 过期：盖一层并把码压暗（还能扫到旧码的人极少，但别直接销毁）
                if (_expired && qrImage.isNotEmpty)
                  Container(
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.82),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    alignment: Alignment.center,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.refresh_rounded, size: 20, color: cs.onSurfaceVariant),
                        const SizedBox(height: 4),
                        Text(
                          "已过期\n点一下换新码",
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 10.5,
                            height: 1.35,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
        // 只在快过期/已过期时提示（平时保持干净）
        if (_hasAge && (_expired || _leftMs <= 60000))
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              _ageLabel,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 9.5,
                color: _expired ? ShopTokens.warn : cs.onSurfaceVariant,
              ),
            ),
          ),
        // 点码登录：点了直接拉起对应 App 确认登录（深链打不开时
        // 回调内部会退回 fallback 并提示扫码）。
        if (onOpenApp != null) ...<Widget>[
          const SizedBox(height: 6),
          ShopMiniButton(
            cs: cs,
            label: qrLink.isNotEmpty ? "点码登录" : "保存二维码",
            onTap: () => onOpenApp!(qrLink, qrLinkFallback, label, imageUrl: qrImage),
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

/// 手动导入 Cookie 的粘贴对话框（2026-11-21）。
///
/// controller 由本组件持有并在 dispose 里释放——弹窗 pop 有出场动画，
/// 期间 TextField 仍在读写 controller，外层同步 dispose 会炸
/// 「A TextEditingController was used after being disposed」。
class _CookiePasteDialog extends StatefulWidget {
  const _CookiePasteDialog({required this.platformLabel});

  final String platformLabel;

  @override
  State<_CookiePasteDialog> createState() => _CookiePasteDialogState();
}

class _CookiePasteDialogState extends State<_CookiePasteDialog> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text("导入${widget.platformLabel} Cookie"),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              "在电脑浏览器登录${widget.platformLabel}网页版 → 按 F12 → 「网络/Network」→ 点任意一个请求 → "
              "在请求标头（Request Headers）里复制 Cookie: 后面的整串，粘贴到下面。"
              "也支持 Cookie 导出插件（EditThisCookie 等）的 JSON 数组。",
              style: TextStyle(
                fontSize: 12,
                height: 1.5,
                color: cs.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _controller,
              minLines: 3,
              maxLines: 6,
              style: const TextStyle(fontSize: 12),
              decoration: const InputDecoration(
                hintText: "粘贴 Cookie…",
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text("取消"),
        ),
        FilledButton(
          onPressed: () {
            final String t = _controller.text.trim();
            Navigator.of(context).pop(t.isEmpty ? null : t);
          },
          child: const Text("提交"),
        ),
      ],
    );
  }
}
