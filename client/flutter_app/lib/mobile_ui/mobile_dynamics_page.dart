import "dart:async";

import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "mobile_dynamics_api.dart";
import "mobile_dynamics_bill_list_page.dart";
import "mobile_dynamics_detail_page.dart";
import "mobile_dynamics_list_page.dart";
import "mobile_dynamics_parcel_list_page.dart";
import "mobile_dynamics_settings_page.dart";
import "mobile_dynamics_shared.dart";
import "mobile_dynamics_subscriptions_page.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";

/// 手机端「动态」页（Agent 主动性聚合，2026-11-16 改版）。
///
/// 设计口径：先处理、再浏览——
///   · 未读横幅：本地记录上次查看时间，按条目时间差算「新增 N 条」，进入即清零；
///   · 需要你处理：快递待取 / 疑似重复账单 / 可取消订阅 / 未决提醒，最多 3 行，行内直接动作；
///   · 今日摘要：一句话结论 + 3 个关键数字；
///   · 订阅与续费：独立省钱卡，预计每月可省；
///   · 最近动态：快递 / 账单两个聚合卡，各 2 行 + 查看全部。
///
/// 数据源：GET /api/dynamics（服务端一次聚合，见 server/src/routes/http/dynamics.ts）。
/// 低价值消息（营销/验证码/重复物流/群聊）不折叠、不进入，只在设置页保留拦截计数。
class MobileDynamicsPage extends StatefulWidget {
  const MobileDynamicsPage({super.key, this.client, this.onAskAgent});

  /// 注入 http client（测试 / 预览用）。
  final dynamic client;

  /// 问 Agent：带上当前上下文跳到对话页（由主壳注入）。
  final void Function(String prompt)? onAskAgent;

  @override
  State<MobileDynamicsPage> createState() => MobileDynamicsPageState();
}

class MobileDynamicsPageState extends State<MobileDynamicsPage> {
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _data = const <String, dynamic>{};
  int _unread = 0;
  int _lastViewAt = 0;
  bool _bannerDismissed = false;

  /// 未读只在本次进入页面时算一次：缓存先算过，随后网络刷新不能再改口径
  /// （否则横幅会闪一下就消失）。
  bool _unreadComputed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_bootstrap());
  }

  /// 首帧先把「上次查看时间」读进内存（磁盘读取有 1s 兜底超时，不阻塞）。
  Future<void> _bootstrap() async {
    await MobilePageCache.instance.read(_lastViewKey);
    await _load();
  }

  /// 主壳切到本 tab 时触发重拉（IndexedStack 保活下 initState 只走一次）。
  void refresh() {
    if (!_loading) unawaited(_load(silent: _data.isNotEmpty));
  }

  static String get _cacheKey => "dynamics_${ApiConfig.effectiveActorId}";
  static String get _lastViewKey =>
      "dynamics_last_view_${ApiConfig.effectiveActorId}";

  Future<void> _load({bool silent = false}) async {
    if (!silent && _data.isEmpty) {
      if (_error == null) {
        final Map<String, dynamic>? cached =
            await MobilePageCache.instance.read(_cacheKey);
        if (!mounted) return;
        if (cached != null) {
          // 缓存先上屏时也立刻把未读/徽标算出来（否则要等网络返回才出现，
          // 弱网下后台一进 tab 会看不到「新增 N 条」与底栏数字）。
          _computeUnread(cached);
          setState(() {
            _data = cached;
            _loading = false;
          });
          _syncBadge();
          unawaited(_fetch(silent: true));
          return;
        }
      }
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    await _fetch(silent: silent);
  }

  Future<void> _fetch({required bool silent}) async {
    try {
      final Map<String, dynamic> body = await _api.fetch();
      MobilePageCache.instance.write(_cacheKey, body);
      if (!mounted) return;
      _computeUnread(body);
      setState(() {
        _data = body;
        _loading = false;
        _error = null;
      });
      _syncBadge();
    } catch (e) {
      if (!mounted) return;
      if (silent && _data.isNotEmpty) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  /// 未读 = 上次查看后新增的条目数（去重）；进入页面后把上次查看时间推到当前。
  void _computeUnread(Map<String, dynamic> body) {
    if (_unreadComputed) return;
    _unreadComputed = true;
    final Map<String, dynamic>? pref =
        MobilePageCache.instance.peek(_lastViewKey);
    final int previous = _lastInt(pref?["at"]);
    _lastViewAt = previous;
    final int now = DateTime.now().millisecondsSinceEpoch;
    final Set<String> seen = <String>{};
    int unread = 0;
    for (final Map<String, dynamic> item in <Map<String, dynamic>>[
      ..._listOf(body, "bills", "recent"),
      ..._listOf(body, "parcels", "recent"),
    ]) {
      final String id = item["id"]?.toString() ?? "";
      if (id.isEmpty || !seen.add(id)) continue;
      if (previous > 0 && dynamicsNum(item, "occurredAt") > previous) unread++;
    }
    _unread = unread;
    _bannerDismissed = false;
    MobilePageCache.instance
        .write(_lastViewKey, <String, dynamic>{"at": now});
  }

  int _lastInt(Object? v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v) ?? 0;
    return 0;
  }

  void _syncBadge() {
    final int pending = _listOf(_data, "alerts", "pending").length;
    final int duplicates = _duplicateIds.length;
    final int parcels = _numOf(_data, "parcels", "awaitingPickup").toInt();
    final int cancellable =
        _subscriptions().where((Map<String, dynamic> e) => e["suggestion"] == "cancel").length;
    DynamicsBadge.count.value = pending + duplicates + parcels + cancellable;
  }

  // —— 解析 helpers（网络与缓存共用同一 _data 形状） ——

  List<Map<String, dynamic>> _listOf(
      Map<String, dynamic> body, String section, String key) {
    final Map<String, dynamic> sec =
        (body[section] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final List<dynamic> raw = (sec[key] as List<dynamic>?) ?? const <dynamic>[];
    return raw.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  num _numOf(Map<String, dynamic> body, String section, String key) {
    final Map<String, dynamic> sec =
        (body[section] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    return (sec[key] as num?) ?? 0;
  }

  List<Map<String, dynamic>> get _bills => _listOf(_data, "bills", "recent");
  List<Map<String, dynamic>> get _parcels => _listOf(_data, "parcels", "recent");
  List<Map<String, dynamic>> get _pendingAlerts =>
      _listOf(_data, "alerts", "pending");

  Set<String> get _duplicateIds {
    final Map<String, dynamic> sec =
        (_data["bills"] as Map<String, dynamic>?) ?? <String, dynamic>{};
    final List<dynamic> raw =
        (sec["duplicateIds"] as List<dynamic>?) ?? const <dynamic>[];
    return raw.map((dynamic e) => e.toString()).toSet();
  }

  Map<String, dynamic> get _subscriptionsBlock =>
      (_data["subscriptions"] as Map<String, dynamic>?) ??
      const <String, dynamic>{};
  List<Map<String, dynamic>> _subscriptions() => _listOf(
      <String, dynamic>{"subscriptions": _subscriptionsBlock},
      "subscriptions",
      "items");

  List<Map<String, dynamic>> get _duplicateBills => _bills
      .where((Map<String, dynamic> e) => _duplicateIds.contains(e["id"]))
      .toList();

  List<Map<String, dynamic>> get _awaitingParcels => _parcels
      .where((Map<String, dynamic> e) =>
          e["pickupCode"] != null && !dynamicsPickedUp(e))
      .toList();

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("动态"),
        actions: <Widget>[
          IconButton(
            tooltip: "消息设置",
            icon: const Icon(Icons.tune_rounded, size: 21),
            onPressed: _openSettings,
          ),
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh_rounded, size: 22),
            onPressed: _loading
                ? null
                : () => unawaited(_load(silent: _data.isNotEmpty)),
          ),
        ],
      ),
      body: _loading
          ? _Skeleton(p: p)
          : _error != null
              ? _buildError(p)
              : RefreshIndicator(
                  onRefresh: () => _load(silent: true),
                  child: _buildBody(p),
                ),
    );
  }

  Widget _buildError(MobilePalette p) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
            const SizedBox(height: 12),
            Text(
              "动态获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
              textAlign: TextAlign.center,
              style: TextStyle(color: p.textSecondary, fontSize: 14),
            ),
            const SizedBox(height: 16),
            OutlinedButton(
                onPressed: () => unawaited(_load()), child: const Text("重试")),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(MobilePalette p) {
    final List<Map<String, dynamic>> bills = _bills;
    final List<Map<String, dynamic>> parcels = _parcels;
    final List<Map<String, dynamic>> subs = _subscriptions();
    final num billTotal = _numOf(_data, "bills", "totalAmount");
    final num billCount = _numOf(_data, "bills", "count");
    final num awaiting = _numOf(_data, "parcels", "awaitingPickup");
    final num parcelCount = _numOf(_data, "parcels", "count");
    final List<_QueueItem> queue = _buildQueue();
    final bool allEmpty = bills.isEmpty &&
        parcels.isEmpty &&
        subs.isEmpty &&
        queue.isEmpty;

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 28),
      children: <Widget>[
        if (_unread > 0 && !_bannerDismissed) _unreadBanner(p),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 10, 4, 7),
          child: Row(
            children: <Widget>[
              Text("需要你处理",
                  style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600)),
              const SizedBox(width: 6),
              Text("${queue.length} 件",
                  style: TextStyle(color: p.textMuted, fontSize: 10.5)),
            ],
          ),
        ),
        if (queue.isEmpty)
          _emptyQueueCard(p)
        else
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider),
            ),
            child: Column(
              children: <Widget>[
                for (final _QueueItem item in queue)
                  _queueRow(p, item, queue.last == item),
              ],
            ),
          ),
        const SizedBox(height: 9),
        _digestCard(p, bills, awaiting, billTotal, billCount),
        const SizedBox(height: 9),
        _saveCard(p, subs),
        if (allEmpty)
          _emptyState(p)
        else ...<Widget>[
          _label(p, "最近动态"),
          if (parcels.isNotEmpty)
            _parcelCard(p, parcels, awaiting, parcelCount),
          if (bills.isNotEmpty) _billCard(p, bills, billTotal, billCount),
        ],
      ],
    );
  }

  Widget _unreadBanner(MobilePalette p) {
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(_lastViewAt);
    final String hm =
        "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: p.divider),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 5,
            height: 5,
            decoration: const BoxDecoration(
                color: Color(0xFF3B82F6), shape: BoxShape.circle),
          ),
          const SizedBox(width: 7),
          Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(
                  text: "新增 $_unread 条",
                  style: TextStyle(
                      color: p.textPrimary, fontWeight: FontWeight.w600),
                ),
                TextSpan(text: " · 上次查看 $hm"),
              ],
            ),
            style: TextStyle(color: p.textSecondary, fontSize: 11),
          ),
          const Spacer(),
          GestureDetector(
            onTap: () => setState(() => _bannerDismissed = true),
            child: Icon(Icons.close_rounded, size: 13, color: p.textMuted),
          ),
        ],
      ),
    );
  }

  List<_QueueItem> _buildQueue() {
    final List<_QueueItem> out = <_QueueItem>[];
    for (final Map<String, dynamic> parcel in _awaitingParcels) {
      if (out.length >= 3) break;
      final String code = dynamicsText(parcel, "pickupCode") ?? "";
      out.add(_QueueItem(
        icon: Icons.local_shipping_outlined,
        title: "${dynamicsText(parcel, "carrier") ?? "快递"} · 取件码 $code",
        meta: "已到件 · ${dynamicsFmtTime(dynamicsNum(parcel, "occurredAt"))}",
        actionLabel: "标记已取件",
        onAction: () => _markPickedUp(parcel),
        onTap: () => _openBillOrParcel(parcel, parcel: true),
      ));
    }
    for (final Map<String, dynamic> bill in _duplicateBills) {
      if (out.length >= 3) break;
      out.add(_QueueItem(
        icon: Icons.credit_card_outlined,
        title:
            "${dynamicsText(bill, "title") ?? "账单"} · ¥${dynamicsFmtAmount(dynamicsNum(bill, "amount").abs())}",
        meta: "同额账单 48 小时内出现两次 · 请复核",
        actionLabel: "去复核",
        ghost: true,
        onAction: () => _openBillOrParcel(bill),
        onTap: () => _openBillOrParcel(bill),
      ));
    }
    for (final Map<String, dynamic> sub in _subscriptions()
        .where((Map<String, dynamic> e) => e["suggestion"] == "cancel")) {
      if (out.length >= 3) break;
      out.add(_QueueItem(
        icon: Icons.check_circle_outline_rounded,
        title: "${dynamicsText(sub, "name") ?? "订阅"} · 自动续费",
        meta:
            "建议取消 · 每年可省 ¥${dynamicsFmtAmount(dynamicsNum(sub, "amount") * 12)}",
        actionLabel: "去取消",
        onAction: _openSubscriptions,
        onTap: _openSubscriptions,
      ));
    }
    for (final Map<String, dynamic> alert in _pendingAlerts) {
      if (out.length >= 3) break;
      out.add(_QueueItem(
        icon: Icons.notifications_none_rounded,
        title: dynamicsText(alert, "title") ??
            dynamicsText(alert, "summary") ??
            "待处理提醒",
        meta: dynamicsText(alert, "reason") ?? "Agent 已准备好，等待你确认",
        actionLabel: "去处理",
        ghost: true,
        onAction: _openAlerts,
        onTap: _openAlerts,
      ));
    }
    return out;
  }

  Widget _queueRow(MobilePalette p, _QueueItem item, bool last) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
                color: p.surface2, borderRadius: BorderRadius.circular(9)),
            child: Icon(item.icon, size: 15, color: p.textPrimary),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: GestureDetector(
              onTap: item.onTap,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(item.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(item.meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          TextStyle(color: p.textMuted, fontSize: 10.5)),
                ],
              ),
            ),
          ),
          const SizedBox(width: 8),
          _tinyButton(p, item.actionLabel,
              ghost: item.ghost, onTap: item.onAction),
        ],
      ),
    );
  }

  Widget _tinyButton(MobilePalette p, String label,
      {bool ghost = false, VoidCallback? onTap}) {
    return Material(
      color: ghost ? Colors.transparent : p.textPrimary,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border:
                Border.all(color: ghost ? p.divider : Colors.transparent),
          ),
          child: Text(
            label,
            style: TextStyle(
                color: ghost ? p.textPrimary : p.background,
                fontSize: 10,
                fontWeight: FontWeight.w500),
          ),
        ),
      ),
    );
  }

  Widget _digestCard(
    MobilePalette p,
    List<Map<String, dynamic>> bills,
    num awaiting,
    num billTotal,
    num billCount,
  ) {
    final int duplicates = _duplicateBills.length;
    final int queueCount = _buildQueue().length;
    final List<String> parts = <String>[];
    if (awaiting > 0) parts.add("今天 $awaiting 件快递待取");
    if (billCount > 0) {
      parts.add("近 30 天账单合计 ¥${dynamicsFmtAmount(billTotal)}");
    }
    if (duplicates > 0) parts.add("有 $duplicates 笔账单疑似重复");
    if (parts.isEmpty) parts.add("今天暂时没有需要处理的事");
    return Container(
      padding: const EdgeInsets.fromLTRB(13, 11, 13, 11),
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
              Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                    color: p.textPrimary,
                    borderRadius: BorderRadius.circular(6)),
                child: Icon(Icons.auto_awesome,
                    size: 10, color: p.background),
              ),
              const SizedBox(width: 6),
              Text("今日摘要",
                  style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11,
                      fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            "${parts.join("；")}。",
            style: TextStyle(
                color: p.textPrimary,
                fontSize: 13,
                height: 1.6,
                fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 9),
          Wrap(
            spacing: 6,
            runSpacing: 5,
            children: <Widget>[
              _dchip(p, "待取", awaiting.toInt().toString()),
              _dchip(p, "近 30 天", "¥${dynamicsFmtAmount(billTotal)}"),
              _dchip(p, "待处理", queueCount.toString()),
            ],
          ),
        ],
      ),
    );
  }

  Widget _dchip(MobilePalette p, String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
          color: p.surface2, borderRadius: BorderRadius.circular(999)),
      child: Text.rich(
        TextSpan(
          children: <InlineSpan>[
            TextSpan(text: "$label "),
            TextSpan(
                text: value,
                style: TextStyle(
                    color: p.textPrimary, fontWeight: FontWeight.w600)),
          ],
        ),
        style: TextStyle(color: p.textSecondary, fontSize: 10),
      ),
    );
  }

  Widget _saveCard(MobilePalette p, List<Map<String, dynamic>> subs) {
    final num monthly = dynamicsNum(_subscriptionsBlock, "monthlyTotal");
    final num savings = dynamicsNum(_subscriptionsBlock, "savingsPerMonth");
    Map<String, dynamic>? firstCancel;
    for (final Map<String, dynamic> e in subs) {
      if (e["suggestion"] == "cancel") {
        firstCancel = e;
        break;
      }
    }
    final String hint = firstCancel != null
        ? "${dynamicsText(firstCancel, "name") ?? "订阅"}：${dynamicsText(firstCancel, "reason") ?? "建议合并"}；取消后每月省 ¥${dynamicsFmtAmount(dynamicsNum(firstCancel, "amount"))}。"
        : subs.isEmpty
            ? "账单里出现「连续包月 / 自动续费」后，这里会帮你算清每月固定支出与可省金额。"
            : "已识别 ${subs.length} 个续费项，暂未发现可取消项；可设置续费前提醒。";

    return Material(
      color: p.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: _openSubscriptions,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: p.textPrimary.withValues(alpha: 0.55)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 26,
                    height: 26,
                    decoration: BoxDecoration(
                        color: p.surface2,
                        borderRadius: BorderRadius.circular(8)),
                    child: Icon(Icons.autorenew_rounded,
                        size: 15, color: p.textPrimary),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Row(
                      children: <Widget>[
                        Flexible(
                          child: Text("订阅与续费",
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  color: p.textPrimary,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600)),
                        ),
                        const SizedBox(width: 7),
                        if (subs.isNotEmpty)
                          Flexible(
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 6, vertical: 1),
                              decoration: BoxDecoration(
                                  color: p.surface2,
                                  borderRadius: BorderRadius.circular(999)),
                              child: Text(
                                  "${subs.length} 个 · ¥${dynamicsFmtAmount(monthly)}/月",
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      color: p.textSecondary, fontSize: 9.5)),
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (savings > 0) ...<Widget>[
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(
                          color: DynamicsTone.greenBg(context),
                          borderRadius: BorderRadius.circular(6)),
                      child: Text("预计省 ¥${dynamicsFmtAmount(savings)}/月",
                          style: TextStyle(
                              color: DynamicsTone.greenFg(context),
                              fontSize: 9,
                              fontWeight: FontWeight.w500)),
                    ),
                  ],
                  const SizedBox(width: 4),
                  Icon(Icons.chevron_right_rounded,
                      size: 14, color: p.textMuted),
                ],
              ),
              const SizedBox(height: 7),
              Text(hint,
                  style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11,
                      height: 1.6)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _parcelCard(MobilePalette p, List<Map<String, dynamic>> parcels,
      num awaiting, num parcelCount) {
    final List<Map<String, dynamic>> rows = <Map<String, dynamic>>[
      ...parcels.where((Map<String, dynamic> e) => !dynamicsPickedUp(e)),
      ...parcels.where(dynamicsPickedUp),
    ];
    return _groupCard(
      p,
      icon: Icons.local_shipping_outlined,
      title: "快递",
      pill: awaiting > 0 ? "${awaiting.toInt()} 件待取" : "${parcelCount.toInt()} 件",
      pillSolid: awaiting > 0,
      hot: awaiting > 0,
      onTap: _openParcels,
      footer: "查看全部快递",
      footerCount: "${parcelCount.toInt()} 件",
      rows: <Widget>[
        for (int i = 0; i < rows.length && i < 2; i++)
          _parcelRow(p, rows[i], i == (rows.length > 2 ? 1 : rows.length - 1)),
      ],
    );
  }

  Widget _parcelRow(MobilePalette p, Map<String, dynamic> item, bool last) {
    final bool picked = dynamicsPickedUp(item);
    final String? code = dynamicsText(item, "pickupCode");
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: InkWell(
        onTap: () => _openBillOrParcel(item, parcel: true),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    "${dynamicsText(item, "carrier") ?? "快递"} · ${picked ? "已取件" : (code != null ? "待取件" : "运输中")}",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: picked ? p.textSecondary : p.textPrimary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    <String>[
                      if (dynamicsText(item, "trackingNo") != null)
                        "单号 ${dynamicsText(item, "trackingNo")}",
                      picked
                          ? "${dynamicsFmtDay(dynamicsNum(item, "pickedUpAt"))} 已取件"
                          : dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
                    ].join(" · "),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textMuted, fontSize: 10.5),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (!picked && code != null)
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                    color: p.textPrimary,
                    borderRadius: BorderRadius.circular(8)),
                child: Column(
                  children: <Widget>[
                    Text("取件码",
                        style: TextStyle(
                            color: p.background.withValues(alpha: 0.62),
                            fontSize: 8,
                            letterSpacing: 1)),
                    Text(code,
                        style: TextStyle(
                            color: p.background,
                            fontSize: 13,
                            fontWeight: FontWeight.w600)),
                  ],
                ),
              )
            else
              Text(picked ? "已取件" : "无需取件码",
                  style: TextStyle(color: p.textMuted, fontSize: 9.5)),
          ],
        ),
      ),
    );
  }

  Widget _billCard(MobilePalette p, List<Map<String, dynamic>> bills,
      num billTotal, num billCount) {
    return _groupCard(
      p,
      icon: Icons.credit_card_outlined,
      title: "账单",
      pill: "${billCount.toInt()} 笔 · ¥${dynamicsFmtAmount(billTotal)}",
      onTap: _openBills,
      footer: "查看全部账单",
      rows: <Widget>[
        for (int i = 0; i < bills.length && i < 2; i++)
          _billRow(p, bills[i], i == (bills.length > 2 ? 1 : bills.length - 1)),
      ],
    );
  }

  Widget _billRow(MobilePalette p, Map<String, dynamic> item, bool last) {
    final String? status = dynamicsBillStatus(item);
    final bool wrong = status == "wrong";
    final bool duplicate = _duplicateIds.contains(item["id"]);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: InkWell(
        onTap: () => _openBillOrParcel(item),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    dynamicsText(item, "title") ?? "账单",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        color: wrong ? p.textSecondary : p.textPrimary,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    <String>[
                      dynamicsSourceLabel(item["source"]),
                      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
                      if (duplicate) "疑似重复",
                    ].join(" · "),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textMuted, fontSize: 10.5),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              dynamicsFmtExpense(dynamicsNum(item, "amount")),
              style: TextStyle(
                color: wrong ? p.textMuted : p.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
                decoration: wrong ? TextDecoration.lineThrough : null,
              ),
            ),
            if (status != null) ...<Widget>[
              const SizedBox(width: 5),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: wrong
                      ? DynamicsTone.redBg(context)
                      : DynamicsTone.greenBg(context),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(wrong ? "记错了" : "已报销",
                    style: TextStyle(
                        color: wrong
                            ? DynamicsTone.redFg(context)
                            : DynamicsTone.greenFg(context),
                        fontSize: 9,
                        fontWeight: FontWeight.w500)),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _groupCard(
    MobilePalette p, {
    required IconData icon,
    required String title,
    required String pill,
    required VoidCallback onTap,
    required String footer,
    required List<Widget> rows,
    String? footerCount,
    bool pillSolid = false,
    bool hot = false,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.fromLTRB(12, 11, 12, 4),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
            color: hot ? p.textPrimary.withValues(alpha: 0.55) : p.divider),
      ),
      child: Column(
        children: <Widget>[
          InkWell(
            onTap: onTap,
            child: Row(
              children: <Widget>[
                Container(
                  width: 26,
                  height: 26,
                  decoration: BoxDecoration(
                      color: p.surface2,
                      borderRadius: BorderRadius.circular(8)),
                  child: Icon(icon, size: 15, color: p.textPrimary),
                ),
                const SizedBox(width: 8),
                Text(title,
                    style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 13,
                        fontWeight: FontWeight.w600)),
                const SizedBox(width: 7),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: pillSolid ? p.textPrimary : p.surface2,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(pill,
                      style: TextStyle(
                          color: pillSolid ? p.background : p.textSecondary,
                          fontSize: 9.5)),
                ),
                const Spacer(),
                Icon(Icons.chevron_right_rounded,
                    size: 14, color: p.textMuted),
              ],
            ),
          ),
          const SizedBox(height: 2),
          ...rows,
          InkWell(
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 8),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: p.divider, width: 0.6)),
              ),
              child: Row(
                children: <Widget>[
                  Text(footer,
                      style: TextStyle(
                          color: p.textSecondary,
                          fontSize: 11,
                          fontWeight: FontWeight.w500)),
                  if (footerCount != null) ...<Widget>[
                    const SizedBox(width: 5),
                    Text(footerCount,
                        style:
                            TextStyle(color: p.textMuted, fontSize: 10.5)),
                  ],
                  const Spacer(),
                  Icon(Icons.chevron_right_rounded,
                      size: 14, color: p.textMuted),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _emptyQueueCard(MobilePalette p) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Text("没有需要你处理的事，Agent 会继续盯着。",
          style: TextStyle(color: p.textSecondary, fontSize: 11.5)),
    );
  }

  Widget _emptyState(MobilePalette p) {
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        children: <Widget>[
          Icon(Icons.inbox_outlined, size: 34, color: p.textMuted),
          const SizedBox(height: 8),
          Text("还没有新动态\n收到账单短信、快递通知或邮件后会自动出现",
              textAlign: TextAlign.center,
              style: TextStyle(
                  color: p.textMuted, fontSize: 11.5, height: 1.7)),
        ],
      ),
    );
  }

  Widget _label(MobilePalette p, String text) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 7),
      child: Text(text,
          style: TextStyle(
              color: p.textSecondary,
              fontSize: 11.5,
              fontWeight: FontWeight.w600)),
    );
  }

  // —— 导航 ——

  void _openBills() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => DynamicsBillListPage(
        items: _bills,
        byType: _listOf(_data, "bills", "byType"),
        stats: (_data["bills"] as Map<String, dynamic>?) ?? <String, dynamic>{},
        duplicateIds: _duplicateIds,
        client: widget.client,
        onAskAgent: widget.onAskAgent,
        onChanged: () => unawaited(_load(silent: true)),
      ),
    ));
  }

  void _openParcels() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => DynamicsParcelListPage(
        items: _parcels,
        client: widget.client,
        onChanged: () => unawaited(_load(silent: true)),
      ),
    ));
  }

  void _openSubscriptions() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => DynamicsSubscriptionsPage(
        data: _subscriptionsBlock,
        client: widget.client,
        onChanged: () => unawaited(_load(silent: true)),
        onOpenBills: () {
          Navigator.of(context).pop();
          _openBills();
        },
      ),
    ));
  }

  void _openSettings() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => DynamicsSettingsPage(
        initial: <String, dynamic>{
          "mail": (_data["sources"] as Map<String, dynamic>?)?["mail"],
          "blockedThisWeek": _data["blockedThisWeek"],
        },
        client: widget.client,
      ),
    )).then((_) {
      if (!mounted) return;
      unawaited(_load(silent: true));
    });
  }

  void _openAlerts() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => DynamicsListPage(
        title: "提醒",
        kind: DynamicsListKind.alert,
        items: _pendingAlerts,
      ),
    ));
  }

  void _openBillOrParcel(Map<String, dynamic> item, {bool parcel = false}) {
    Navigator.of(context)
        .push<Map<String, dynamic>>(MaterialPageRoute<Map<String, dynamic>>(
      builder: (_) => parcel
          ? ParcelDetailPage(item: item, client: widget.client)
          : BillDetailPage(
              item: item,
              byType: _listOf(_data, "bills", "byType"),
              client: widget.client,
              onAskAgent: widget.onAskAgent,
            ),
    ))
        .then((Map<String, dynamic>? updated) {
      if (updated != null && mounted) {
        unawaited(_load(silent: true));
      }
    });
  }

  Future<void> _markPickedUp(Map<String, dynamic> parcel) async {
    try {
      await _api.setPickedUp(dynamicsText(parcel, "id") ?? "", true);
      if (!mounted) return;
      _snack("已标记取件");
      unawaited(_load(silent: true));
    } catch (e) {
      if (!mounted) return;
      _snack("操作失败：$e");
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
          content: Text(text), duration: const Duration(seconds: 2)));
  }
}

class _QueueItem {
  const _QueueItem({
    required this.icon,
    required this.title,
    required this.meta,
    required this.actionLabel,
    required this.onAction,
    required this.onTap,
    this.ghost = false,
  });

  final IconData icon;
  final String title;
  final String meta;
  final String actionLabel;
  final VoidCallback onAction;
  final VoidCallback onTap;
  final bool ghost;
}

/// 加载骨架（无缓存首屏；不闪错误页）。
class _Skeleton extends StatelessWidget {
  const _Skeleton({required this.p});

  final MobilePalette p;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
      children: <Widget>[
        for (final double h in <double>[36, 150, 110, 90, 160])
          Container(
            height: h,
            margin: const EdgeInsets.only(bottom: 10),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider),
            ),
            alignment: Alignment.center,
            child: SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                  strokeWidth: 1.6, color: p.textMuted),
            ),
          ),
      ],
    );
  }
}
