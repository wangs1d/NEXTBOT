import "dart:async";

import "package:flutter/material.dart";

import "../../../core/config/media_url.dart";
import "../../../core/utils/agent_result_parser.dart";
import "../media_disk_cache.dart";
import "shopping_shared.dart";

/// 候选比价卡（设计稿 01 屏）：横向滑动、一屏露出约 2.5 张、逐卡吸附。
///
/// 与服务端 `extra.shopping.stage == "candidates"` 对齐（shopping.compare.prices
/// / shopping.order.search 下发）。卡内只展示候选与到手价，不做平台跳转；
/// 选哪张由用户点卡或用底部快捷短语回传给 agent。
class ShoppingCandidatesCard extends StatefulWidget {
  const ShoppingCandidatesCard({
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
  State<ShoppingCandidatesCard> createState() => _ShoppingCandidatesCardState();
}

class _ShoppingCandidatesCardState extends State<ShoppingCandidatesCard> {
  static const double _viewportFraction = 0.44;

  late final PageController _controller =
      PageController(viewportFraction: _viewportFraction);
  int _page = 0;

  /// 用户点选的那一张（-1 = 还没选）。纯本地状态：不发消息、不等服务端，
  /// 点下去立刻出描边——这是「一次回复内连续选择」的基本盘。
  int _picked = -1;

  /// 已把「下单」事件发给服务端、正等结算页回数据。
  ///
  /// 这段空窗是 10–30 秒（服务端要真开浏览器进结算页），不置位的话用户看到
  /// 的就是「点了没反应」。这里只做本地置位，不做全局状态穿透——卡片一旦被
  /// card.update 替换，本 State 随之销毁，天然收尾；超时兜底防永久转圈。
  bool _submitting = false;
  Timer? _submitGuard;

  @override
  void initState() {
    super.initState();
    // 只有一家报价时直接选中它：让用户「先点一下才能操作」是没必要的仪式感，
    // 而且单张候选时连「换一家」都没有，不自动选就等于整张卡没有入口。
    final List<Map<String, dynamic>> items = shopMaps(widget.payload["items"]);
    if (items.length == 1) _picked = 0;
  }

  @override
  void dispose() {
    _submitGuard?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _emit(String label, {String prefix = "chip"}) {
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    cb(
      AgentResultAction(
        id: "${prefix}_${label.hashCode.abs()}",
        label: label,
        variant: "secondary",
      ),
      cardData: data,
    );
  }

  /// 卡内动作：把服务端的 `cardAction` 塞进 payload，控制器据此走 card.action
  /// 通道（只换这张卡），而不是 chat.user_action（会多一轮回复）。
  void _act(String label, String cardAction, Map<String, dynamic> data,
      {String variant = "primary"}) {
    final AgentResultData? cardData = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (cardData == null || cb == null) return;
    cb(
      AgentResultAction(
        id: "${cardAction}_${label.hashCode.abs()}",
        label: label,
        variant: variant,
        payload: <String, dynamic>{...data, "cardAction": cardAction},
      ),
      cardData: cardData,
    );
  }

  String _labelOf(Map<String, dynamic> it) {
    final String label = shopStr(it["platformLabel"]);
    return label.isEmpty ? shopStr(it["platform"]) : label;
  }

  void _nextPage(int count) {
    if (count <= 1) return;
    final int next = (_page + 1) % count;
    _controller.animateToPage(
      next,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  /// 「就这家」：把用户选中的那一条交给服务端结算（card.action），回来的是
  /// 同一张卡的确认态——不是一条新消息。
  void _placePicked(List<Map<String, dynamic>> items) {
    if (_picked < 0 || _picked >= items.length) return;
    final Map<String, dynamic> it = items[_picked];
    final String title = shopStr(it["title"]);
    final String url = shopStr(it["url"]);
    setState(() => _submitting = true);
    // 兜底：服务端 60s 没回（断线/超时），恢复可点，不让卡片永久卡在进度态
    _submitGuard?.cancel();
    _submitGuard = Timer(const Duration(seconds: 60), () {
      if (!mounted) return;
      setState(() => _submitting = false);
    });
    _act(
      "在 ${_labelOf(it)} 下单",
      "shopping.spec.load",
      <String, dynamic>{
        "platform": shopStr(it["platform"]),
        // 有直达链接就用链接；没有就退回标题让服务端搜同款（服务端两条路都认）
        "item": url.isNotEmpty ? url : title,
        "title": title,
        "quantity": 1,
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final Map<String, dynamic> p = widget.payload;
    final List<Map<String, dynamic>> items = shopMaps(p["items"]);
    if (items.isEmpty) return const SizedBox.shrink();

    final int bestIndex = (shopNum(p["bestIndex"]) ?? -1).toInt();
    final String sortLabel = shopStr(p["sortLabel"]);
    final String footer = shopStr(p["footer"]);
    final List<dynamic> chips = p["chips"] is List ? p["chips"] as List : const <dynamic>[];
    // 未取到报价的平台（2026-11-13 P0-4）：必须在卡里**显式成行**。
    //
    // 用户投诉「说让我补京东的登录之后再补」「淘宝没搜索到报价，那价格哪来的」
    // ——缺口如果只存在于服务端内部，模型就会自由发挥出一个「淘宝价」。
    // 缺口写进卡里 = 用户看得见，模型也没处编。
    final List<Map<String, dynamic>> missing = shopMaps(p["missingPlatforms"]);

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ShopCardHeader(
            cs: cs,
            icon: Icons.grid_view_rounded,
            iconColor: cs.onSurfaceVariant,
            title: shopStr(p["title"]).isEmpty ? "候选商品" : shopStr(p["title"]),
            subtitle: sortLabel.isEmpty ? null : sortLabel,
            trailing: items.length > 1
                ? _PageDots(
                    count: items.length,
                    active: _page,
                    cs: cs,
                  )
                : null,
          ),
          SizedBox(
            height: 208,
            child: PageView.builder(
              controller: _controller,
              padEnds: false,
              physics: const PageScrollPhysics(),
              onPageChanged: (int i) => setState(() => _page = i),
              itemCount: items.length,
              itemBuilder: (BuildContext context, int i) {
                final Map<String, dynamic> it = items[i];
                return Padding(
                  padding: EdgeInsets.only(
                    left: i == 0 ? 12 : 4.5,
                    right: 4.5,
                  ),
                  child: _CandidateTile(
                    cs: cs,
                    item: it,
                    highlight: i == bestIndex,
                    selected: _picked == i,
                    badge: i == bestIndex
                        ? (shopStr(p["bestLabel"]).isEmpty
                            ? "最合适"
                            : shopStr(p["bestLabel"]))
                        : shopStr(it["badge"]),
                    // 点选 = 本地状态，不发消息（2026-11-06 定稿）：一次购物
                    // 若每步都发一条 user_message，必然换来一条助手回复，六步
                    // 就是十二条气泡。这里只选中，用户接着点底部按钮才走动作。
                    onTap: () => setState(() => _picked = i),
                  ),
                );
              },
            ),
          ),
          // 卡内动作条（2026-11-06）：没选中就只留「换一家」——一个没东西可点的
          // 主按钮占着位子教用户做事，是废话 UI（用户原话）。选中后主按钮才淡入。
          //
          // 2026-11-13 改版：主按钮**始终在**，指向**当前这一页**的卡，
          // 文案带平台名（「去京东下单」）——用户点之前就知道会跳去哪家买，
          // 而不是点完才知道「原来这是淘宝的价」。比价场景里平台归属是核心
          // 信息，不能藏在卡片角落；也不能让用户先点卡、再找按钮，两步走。
          //
          // 不可下单的源（什么值得买）不给这个按钮：给一个点不动的按钮只会
          // 教用户做事。
          if (_picked < 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: Row(
                children: <Widget>[
                  if (shopBool(items[_page]["orderable"])) ...<Widget>[
                    Expanded(
                      flex: 3,
                      child: ShopButton(
                        cs: cs,
                        label: "去${_labelOf(items[_page])}下单",
                        primary: true,
                        onTap: () {
                          setState(() => _picked = _page);
                          _placePicked(items);
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  if (items.length > 1)
                    Expanded(
                      flex: shopBool(items[_page]["orderable"]) ? 2 : 3,
                      child: ShopButton(
                        cs: cs,
                        label: "换一家看看",
                        primary: false,
                        onTap: () => _nextPage(items.length),
                      ),
                    )
                  else
                    const Spacer(),
                ],
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: Row(
                children: <Widget>[
                  // 只报价的源（什么值得买）：不给按钮——一个永远点不动的
                  // 灰按钮占着主位只会教用户做事（用户 2026-11-06 拍板删除）。
                  // 选中它时只留「换一家」，引导换到能买的平台。
                  if (shopBool(items[_picked]["orderable"])) ...<Widget>[
                    Expanded(
                      flex: 3,
                      child: ShopButton(
                        cs: cs,
                        label: _submitting
                            ? "正在打开${_labelOf(items[_picked])}…"
                            : "去${_labelOf(items[_picked])}下单",
                        primary: true,
                        onTap: _submitting ? null : () => _placePicked(items),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    flex: shopBool(items[_picked]["orderable"]) ? 2 : 3,
                    child: ShopButton(
                      cs: cs,
                      label: "换一家",
                      primary: false,
                      onTap: _submitting || items.length <= 1
                          ? null
                          : () => _nextPage(items.length),
                    ),
                  ),
                ],
              ),
            ),
          if (missing.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: _MissingPlatformsNote(cs: cs, items: missing),
            ),
          if (chips.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: <Widget>[
                  for (final dynamic c in chips)
                    _QuickChip(
                      cs: cs,
                      label: shopStr(c),
                      solid: shopStr(c) == shopStr(chips.first),
                      onTap: () => _emit(shopStr(c)),
                    ),
                ],
              ),
            ),
          if (footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 12, 11),
              child: Text(
                footer,
                style: TextStyle(
                  fontSize: 10,
                  height: 1.5,
                  color: cs.onSurfaceVariant,
                ),
              ),
            )
          else
            const SizedBox(height: 11),
        ],
      ),
    );
  }
}

class _PageDots extends StatelessWidget {
  const _PageDots({
    required this.count,
    required this.active,
    required this.cs,
  });

  final int count;
  final int active;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
            // 真机（420dpi）实测两次：4px + outline 色几乎看不见，整排只剩当前
            // 页那一根黑条，等于没有页码；outline 在本主题里本身就是浅灰
            // （#E8E9ED），提亮 alpha 也没用——未选中点必须从 onSurface 派生。
            margin: EdgeInsets.only(left: i == 0 ? 0 : 4),
            width: i == active ? 14 : 5,
            height: 4,
            decoration: BoxDecoration(
              color: i == active
                  ? cs.onSurface
                  : cs.onSurface.withValues(alpha: 0.22),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
      ],
    );
  }
}

class _CandidateTile extends StatelessWidget {
  const _CandidateTile({
    required this.cs,
    required this.item,
    required this.highlight,
    required this.selected,
    required this.badge,
    required this.onTap,
  });

  final ColorScheme cs;
  final Map<String, dynamic> item;
  final bool highlight;
  /// 用户是否**选中**了这一张（点按产生）。与 [highlight]（服务端标的「最合适」）
  /// 是两回事：一个是推荐，一个是用户的决定，描边配色也要能同时看清。
  final bool selected;
  final String badge;
  final VoidCallback onTap;

  /// 卡内元信息尾巴：抓取时刻 + 评分。
  ///
  /// 抓取时刻是**来源凭据**的一部分（用户会问「这价格哪来的、什么时候抓的」），
  /// 服务端已在 shopItems[] 下发 [fetchedAt]，这里只做展示格式化。
  String _metaTail(num? rating) {
    final String clock = shopClock(item["fetchedAt"]);
    final String score = rating != null ? shopMoney(rating) : "";
    return <String>[clock, score].where((String s) => s.isNotEmpty).join(" · ");
  }

  @override
  Widget build(BuildContext context) {
    final String image = shopStr(item["image"]);
    final num? price = shopNum(item["price"]);
    final String title = shopStr(item["title"]);
    final String platform = shopStr(item["platformLabel"]).isEmpty
        ? shopStr(item["platform"])
        : shopStr(item["platformLabel"]);
    final String shop = shopStr(item["shop"]);
    final num? rating = shopNum(item["rating"]);

    return ShopTap(
      onTap: onTap,
      radius: 10,
      child: Container(
        decoration: BoxDecoration(
          color: cs.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: selected
                ? cs.primary
                : (highlight
                    ? cs.onSurface
                    : cs.outline.withValues(alpha: 0.2)),
            width: selected ? 2 : (highlight ? 1.5 : 1),
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            SizedBox(
              height: 96,
              width: double.infinity,
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  _Thumb(cs: cs, url: image),
                  // 平台来源浮标（2026-11-13）：贴在图上，永不被店铺名挤掉。
                  Positioned(
                    top: 5,
                    left: 5,
                    child: ShopPlatformTag(
                      cs: cs,
                      platform: shopStr(item["platform"]),
                      label: platform,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 7, 8, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (badge.isNotEmpty) ...<Widget>[
                      ShopBadge(cs: cs, label: badge),
                      const SizedBox(height: 3),
                    ],
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 10.5,
                          height: 1.35,
                          fontWeight: FontWeight.w500,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: <Widget>[
                        Text(
                          "¥",
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w600,
                            color: cs.onSurface,
                          ),
                        ),
                        Text(
                          shopMoney(price),
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.2,
                            color: cs.onSurface,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    // 来源行（2026-11-13）：平台名**始终在**，店铺名跟随其后。
                    //
                    // 旧实现是 `shop.isEmpty ? platform : shop`——只要有店铺名
                    // 就把平台名顶掉，用户看到的只有「京东自营旗舰店」这种
                    // 无法指认来源的字样。现在平台名与店铺名同时在场。
                    ShopSourceLine(
                      cs: cs,
                      platform: shopStr(item["platform"]),
                      label: platform,
                      shop: shop,
                      trailing: _metaTail(rating),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 商品图：网络图优先，失败/无图回退柔和渐变底 + 家电轮廓。
class _Thumb extends StatelessWidget {
  const _Thumb({required this.cs, required this.url});

  final ColorScheme cs;
  final String url;

  @override
  Widget build(BuildContext context) {
    final Widget fallback = DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFFF4F6F8), Color(0xFFDDE2E9)],
        ),
      ),
      child: Center(
        child: Icon(
          Icons.inventory_2_outlined,
          size: 26,
          color: Colors.black.withValues(alpha: 0.16),
        ),
      ),
    );
    if (url.isEmpty) return fallback;
    // 云端取回的商品图是服务端本地路径（/agent/images/...），必须补成完整地址，
    // 否则没有 scheme 会立刻失败，用户看到的就是一张灰色占位（"有价格没照片"）。
    // 展示统一走磁盘缓存版网络图，重启后命中落盘文件就不会再空窗。
    return CachedMediaImage(
      url: MediaUrl.resolve(url),
      fit: BoxFit.cover,
      loadingBuilder: (BuildContext c) => fallback,
      errorBuilder: (BuildContext c, Object e, StackTrace? s) => fallback,
    );
  }
}

class _QuickChip extends StatelessWidget {
  const _QuickChip({
    required this.cs,
    required this.label,
    required this.solid,
    required this.onTap,
  });

  final ColorScheme cs;
  final String label;
  final bool solid;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ShopTap(
      onTap: onTap,
      radius: 999,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: solid ? cs.onSurface : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: solid
                ? cs.onSurface
                : cs.outline.withValues(alpha: 0.3),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: solid ? FontWeight.w600 : FontWeight.w500,
            color: solid ? cs.surface : cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// 未取到报价的平台提示条（2026-11-13 P0-4）。
///
/// 收齐闸门的**可见面**：哪几家没比到、为什么（要登录 / 验证码 / 无同款），
/// 一行说清。缺口显式化之后，「淘宝的价格从哪来」这个问题才有答案——
/// 因为卡里根本没写淘宝有价。
class _MissingPlatformsNote extends StatelessWidget {
  const _MissingPlatformsNote({required this.cs, required this.items});

  final ColorScheme cs;
  final List<Map<String, dynamic>> items;

  static const Map<String, String> _reasonText = <String, String>{
    "login": "需要登录",
    "captcha": "需要验证",
    "no_data": "无同款",
    // 用户主动「跳过这家」：是选择，不是平台没价（2026-11-13 P1）
    "skipped": "已跳过",
  };

  @override
  Widget build(BuildContext context) {
    final List<String> names = <String>[];
    final List<String> reasons = <String>[];
    for (final Map<String, dynamic> it in items) {
      final String label = shopStr(it["platformLabel"]).isEmpty
          ? shopStr(it["platform"])
          : shopStr(it["platformLabel"]);
      if (label.isEmpty) continue;
      names.add(label);
      final String reason =
          _reasonText[shopStr(it["reason"])] ?? shopStr(it["reason"]);
      if (reason.isNotEmpty && !reasons.contains(reason)) {
        reasons.add(reason);
      }
    }
    if (names.isEmpty) return const SizedBox.shrink();

    final String reasonText =
        reasons.isEmpty ? "" : "（${reasons.join("、")}，未参与比价）";
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: ShopTokens.warn.withValues(alpha: 0.42)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.info_outline_rounded, size: 12, color: ShopTokens.warn),
          const SizedBox(width: 5),
          Expanded(
            child: Text(
              "未取到报价：${names.join("、")}$reasonText",
              style: TextStyle(
                fontSize: 9.5,
                height: 1.45,
                color: ShopTokens.warn,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
