import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/services/nb_http.dart";
import "mobile_dynamics_detail_page.dart";
import "mobile_dynamics_list_page.dart";
import "mobile_dynamics_shared.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";

/// 手机端「动态」页（Agent 主动性聚合，2026-11-13 替换原「目标」tab）。
///
/// 本质：Agent 替你盯着的一切动静的翻看入口——
///   · 主动记账：短信/邮件里的账单自动识别入账（账单合计 + 明细）
///   · 快递聚合：待取件排前，取件码/运单号/承运商直接可读
///   · 提醒：Agent 的未决提醒（attention pending）+ 主动动作足迹
///   · 邮件要事：邮件流里的高价值件（验证码等低价值件不进这里）
///
/// 数据源：GET /api/dynamics（服务端一次聚合，见 server/src/routes/http/dynamics.ts）。
/// 各区块独立空态——某个数据源没产出不影响其他区块展示。
class MobileDynamicsPage extends StatefulWidget {
  const MobileDynamicsPage({super.key, this.client});

  /// 注入 http client(测试用)。
  final http.Client? client;

  @override
  State<MobileDynamicsPage> createState() => MobileDynamicsPageState();
}

class MobileDynamicsPageState extends State<MobileDynamicsPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _data = const <String, dynamic>{};

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 主壳切到本 tab 时触发重拉（IndexedStack 保活下 initState 只走一次）。
  /// 已有数据时静默后台刷新（秒进不转圈），无数据才走完整加载。
  void refresh() {
    if (!_loading) unawaited(_load(silent: _data.isNotEmpty));
  }

  /// 磁盘缓存 key：上次成功响应体原样落盘（stale-while-revalidate 用）。
  static String get _cacheKey => "dynamics_${ApiConfig.effectiveActorId}";

  /// [silent]=true 时已有数据保持展示，成功换数据、失败不闪错误页。
  Future<void> _load({bool silent = false}) async {
    if (!silent && _data.isEmpty) {
      if (_error == null) {
        final Map<String, dynamic>? cached =
            await MobilePageCache.instance.read(_cacheKey);
        if (!mounted) return;
        if (cached != null) {
          setState(() {
            _data = cached;
            _loading = false;
          });
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
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/dynamics?userId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
      final http.Response res = await (widget.client ?? NbClient())
          .get(uri)
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw Exception("服务端返回 ${res.statusCode}");
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        throw Exception(body["error"]?.toString() ?? "未知错误");
      }
      MobilePageCache.instance.write(_cacheKey, body);
      if (!mounted) return;
      setState(() {
        _data = body;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      // 静默刷新失败：已有数据保持展示（不闪错误页）；无数据才落到错误态。
      if (silent && _data.isNotEmpty) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  // —— 解析 helpers（网络与缓存共用同一 _data 形状） ——

  List<Map<String, dynamic>> _listOf(String section, String key) {
    final Map<String, dynamic> sec =
        (_data[section] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final List<dynamic> raw = (sec[key] as List<dynamic>?) ?? const <dynamic>[];
    return raw.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  num _numOf(String section, String key) {
    final Map<String, dynamic> sec =
        (_data[section] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final num? v = sec[key] as num?;
    return v ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("动态"),
        actions: [
          IconButton(
            tooltip: "刷新",
            icon: const Icon(Icons.refresh, size: 22),
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
          children: [
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
    final List<Map<String, dynamic>> bills = _listOf("bills", "recent");
    final List<Map<String, dynamic>> parcels = _listOf("parcels", "recent");
    final List<Map<String, dynamic>> pending = _listOf("alerts", "pending");
    final List<Map<String, dynamic>> activity = _listOf("alerts", "activity");
    final List<Map<String, dynamic>> mail = _listOf("mail", "recent");
    final num billTotal = _numOf("bills", "totalAmount");
    final num billCount = _numOf("bills", "count");
    final num awaiting = _numOf("parcels", "awaitingPickup");
    final num parcelCount = _numOf("parcels", "count");
    final String? latestCode = _latestPickupCode();
    final bool allEmpty = bills.isEmpty &&
        parcels.isEmpty &&
        pending.isEmpty &&
        activity.isEmpty &&
        mail.isEmpty;

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
      children: [
        Row(
          children: [
            Expanded(
              child: _SummaryCard(
                p: p,
                label: "本月账单",
                value:
                    billCount == 0 ? "—" : "¥${dynamicsFmtAmount(billTotal)}",
                hint: billCount == 0
                    ? "暂无识别到的账单"
                    : "${billCount.toInt()} 笔 · 点击看明细",
                showTapDot: billCount > 0,
                onTap: () => _openList(DynamicsListKind.bill),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: _SummaryCard(
                p: p,
                label: "待取快递",
                value: awaiting == 0 ? "—" : "${awaiting.toInt()}",
                unit: awaiting == 0 ? null : "件",
                hint: awaiting == 0
                    ? "暂无待取件"
                    : (latestCode == null
                        ? "点击查看全部"
                        : "最新 $latestCode"),
                showTapDot: awaiting > 0,
                onTap: () => _openList(DynamicsListKind.parcel),
              ),
            ),
          ],
        ),
        if (allEmpty)
          _EmptyState(p: p, lastSyncedAt: _generatedAt)
        else ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 7),
            child: Text(
              "今天",
              style: TextStyle(
                color: p.textSecondary,
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (parcels.isNotEmpty)
            _GroupCard(
              p: p,
              icon: Icons.local_shipping_outlined,
              title: "快递",
              pill: awaiting > 0
                  ? "${awaiting.toInt()} 件待取"
                  : "${parcelCount.toInt()} 件",
              pillSolid: awaiting > 0,
              hot: awaiting > 0,
              onTap: () => _openList(DynamicsListKind.parcel),
              footerLabel: "查看全部快递",
              footerCount: "${parcelCount.toInt()} 件",
              rows: <Widget>[
                for (int i = 0; i < parcels.length && i < 2; i++)
                  _ParcelRow(
                    p: p,
                    item: parcels[i],
                    onTap: () => _openParcel(parcels[i]),
                  ),
              ],
            ),
          if (bills.isNotEmpty)
            _GroupCard(
              p: p,
              icon: Icons.receipt_long_outlined,
              title: "账单",
              pill:
                  "${billCount.toInt()} 笔 · ¥${dynamicsFmtAmount(billTotal)}",
              onTap: () => _openList(DynamicsListKind.bill),
              footerLabel: "查看全部账单",
              rows: <Widget>[
                for (int i = 0; i < bills.length && i < 2; i++)
                  _BillRow(
                    p: p,
                    item: bills[i],
                    last: i == (bills.length > 2 ? 1 : bills.length - 1),
                    onTap: () => _openBill(bills[i]),
                  ),
              ],
            ),
          if (pending.isNotEmpty)
            _GroupCard(
              p: p,
              icon: Icons.notifications_none_rounded,
              title: "提醒",
              pill: "${pending.length} 条",
              onTap: () => _openList(DynamicsListKind.alert),
              footerLabel: "查看全部提醒",
              rows: <Widget>[
                for (int i = 0; i < pending.length && i < 2; i++)
                  _AlertRow(p: p, item: pending[i]),
              ],
            ),
          if (mail.isNotEmpty)
            _GroupCard(
              p: p,
              icon: Icons.mail_outline_rounded,
              title: "邮件要事",
              pill: "${mail.length} 封",
              onTap: () => _openList(DynamicsListKind.mail),
              footerLabel: "查看全部邮件",
              rows: <Widget>[
                for (int i = 0; i < mail.length && i < 2; i++)
                  _MailRow(p: p, item: mail[i]),
              ],
            ),
          if (activity.isNotEmpty)
            _GroupCard(
              p: p,
              icon: Icons.bolt_outlined,
              title: "更多动态",
              pill: "${activity.length} 条",
              rows: <Widget>[
                for (final Map<String, dynamic> item in activity.take(3))
                  _ActivityRow(p: p, item: item),
              ],
            ),
        ],
      ],
    );
  }

  num get _generatedAt => (_data["generatedAt"] as num?) ?? 0;

  String? _latestPickupCode() {
    final Map<String, dynamic>? sec =
        _data["parcels"] as Map<String, dynamic>?;
    final Object? latest = sec?["latestPickup"];
    if (latest is Map && latest["pickupCode"] != null) {
      return latest["pickupCode"].toString();
    }
    return null;
  }

  void _openList(DynamicsListKind kind) {
    String title = "账单";
    List<Map<String, dynamic>> items = const <Map<String, dynamic>>[];
    switch (kind) {
      case DynamicsListKind.bill:
        title = "账单";
        items = _listOf("bills", "recent");
      case DynamicsListKind.parcel:
        title = "快递";
        items = _listOf("parcels", "recent");
      case DynamicsListKind.alert:
        title = "提醒";
        items = _listOf("alerts", "pending");
      case DynamicsListKind.mail:
        title = "邮件要事";
        items = _listOf("mail", "recent");
    }
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => DynamicsListPage(
            title: title,
            kind: kind,
            items: items,
            byType: _listOf("bills", "byType"),
          ),
        ),
      ),
    );
  }

  void _openBill(Map<String, dynamic> item) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => BillDetailPage(
            item: item,
            byType: _listOf("bills", "byType"),
          ),
        ),
      ),
    );
  }

  void _openParcel(Map<String, dynamic> item) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ParcelDetailPage(item: item),
        ),
      ),
    );
  }

}

// —— 通用小组件 ——

/// 汇总卡：数字 + 最新一条提示，整卡可点。
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.p,
    required this.label,
    required this.value,
    required this.hint,
    required this.onTap,
    this.unit,
    this.showTapDot = false,
  });

  final MobilePalette p;
  final String label;
  final String value;
  final String hint;
  final String? unit;
  final bool showTapDot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Stack(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 11),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            label,
                            style: TextStyle(
                              color: p.textSecondary,
                              fontSize: 11,
                            ),
                          ),
                        ),
                        Icon(Icons.chevron_right_rounded,
                            size: 12, color: p.textMuted),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text.rich(
                      TextSpan(
                        text: value,
                        style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 23,
                          height: 1.17,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.3,
                        ),
                        children: [
                          if (unit != null)
                            TextSpan(
                              text: unit,
                              style: TextStyle(
                                color: p.textSecondary,
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                                letterSpacing: 0,
                              ),
                            ),
                        ],
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      hint,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: p.textMuted,
                        fontSize: 10,
                        height: 1.4,
                      ),
                    ),
                  ],
                ),
              ),
              if (showTapDot)
                Positioned(
                  right: 10,
                  bottom: 10,
                  child: Container(
                    width: 4,
                    height: 4,
                    decoration: BoxDecoration(
                      color: p.textMuted.withValues(alpha: 0.35),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 聚合卡外壳：类型图标 + 标题 + 计数徽标 + 最近两条 + 查看全部。
class _GroupCard extends StatelessWidget {
  const _GroupCard({
    required this.p,
    required this.icon,
    required this.title,
    required this.pill,
    required this.rows,
    this.pillSolid = false,
    this.hot = false,
    this.onTap,
    this.footerLabel,
    this.footerCount,
  });

  final MobilePalette p;
  final IconData icon;
  final String title;
  final String pill;
  final List<Widget> rows;
  final bool pillSolid;
  final bool hot;
  final VoidCallback? onTap;
  final String? footerLabel;
  final String? footerCount;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: hot ? p.textPrimary.withValues(alpha: 0.55) : p.divider,
        ),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 11, 12, 0),
                child: Row(
                  children: [
                    Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(
                        color: p.innerFieldBackground,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(icon, size: 15, color: p.textPrimary),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      title,
                      style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 6),
                    _Pill(p: p, text: pill, solid: pillSolid),
                    const Spacer(),
                    if (onTap != null)
                      Icon(Icons.chevron_right_rounded,
                          size: 14, color: p.textMuted),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
                child: Column(children: rows),
              ),
              if (footerLabel != null) ...[
                Container(
                  margin: const EdgeInsets.only(top: 7),
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                  decoration: BoxDecoration(
                    border: Border(top: BorderSide(color: p.divider)),
                  ),
                  child: Row(
                    children: [
                      Text(
                        footerLabel!,
                        style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 11,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (footerCount != null) ...[
                        const SizedBox(width: 5),
                        Text(
                          footerCount!,
                          style: TextStyle(
                            color: p.textSecondary,
                            fontSize: 11,
                          ),
                        ),
                      ],
                      const Spacer(),
                      Icon(Icons.chevron_right_rounded,
                          size: 12, color: p.textMuted),
                    ],
                  ),
                ),
              ],
            ],
          ),
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
          height: 1.4,
        ),
      ),
    );
  }
}

/// 快递行：标题 + 单号/时间，右侧取件码黑底 chip（深色下自动反色）。
class _ParcelRow extends StatelessWidget {
  const _ParcelRow({required this.p, required this.item, required this.onTap});

  final MobilePalette p;
  final Map<String, dynamic> item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final String? code = dynamicsText(item, "pickupCode");
    final String? trackingNo = dynamicsText(item, "trackingNo");
    final String meta = <String>[
      if (trackingNo != null) "单号 $trackingNo",
      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
    ].where((String s) => s.isNotEmpty).join(" · ");
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.only(top: 7, bottom: 2),
        child: Row(
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
                      fontSize: 12.5,
                      height: 18 / 12.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (meta.isNotEmpty) ...[
                    const SizedBox(height: 1),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: p.textMuted,
                        fontSize: 10.5,
                        height: 15 / 10.5,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (code != null) ...[
              const SizedBox(width: 10),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
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
                    const SizedBox(height: 1),
                    Text(
                      code,
                      style: TextStyle(
                        color: p.onAccent,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.2,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 账单行：标题 + 来源/时间，右侧金额。
class _BillRow extends StatelessWidget {
  const _BillRow({
    required this.p,
    required this.item,
    required this.last,
    required this.onTap,
  });

  final MobilePalette p;
  final Map<String, dynamic> item;
  final bool last;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final String meta = <String>[
      dynamicsSourceLabel(item["source"]),
      dynamicsFmtTime(dynamicsNum(item, "occurredAt")),
    ].where((String s) => s.isNotEmpty).join(" · ");
    return Container(
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(
                bottom: BorderSide(
                  color: p.divider.withValues(alpha: 0.6),
                ),
              ),
      ),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(
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
                        fontSize: 12.5,
                        height: 18 / 12.5,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    if (meta.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Text(
                        meta,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: p.textMuted,
                          fontSize: 10.5,
                          height: 15 / 10.5,
                        ),
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
            ],
          ),
        ),
      ),
    );
  }
}

/// 提醒行：红点=紧急，灰点=普通。
class _AlertRow extends StatelessWidget {
  const _AlertRow({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String urgency = item["urgency"]?.toString() ?? "normal";
    final bool urgent = urgency == "interrupt" || urgency == "alert";
    final String summary = dynamicsText(item, "summary") ??
        dynamicsFmtTime(dynamicsNum(item, "createdAt"));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 6),
            width: 5,
            height: 5,
            decoration: BoxDecoration(
              color: urgent ? const Color(0xFFE5484D) : p.textMuted,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  dynamicsText(item, "title") ?? "提醒",
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 12.5,
                    height: 18 / 12.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                if (summary.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(
                    summary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: p.textMuted,
                      fontSize: 10.5,
                      height: 15 / 10.5,
                    ),
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

/// 邮件要事行：蓝色来源点 + 时间，正文标题。
class _MailRow extends StatelessWidget {
  const _MailRow({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String meta = <String>[
      "邮件",
      dynamicsFmtTime(dynamicsNum(item, "at")),
    ].where((String s) => s.isNotEmpty).join(" · ");
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 4,
                height: 4,
                decoration: BoxDecoration(
                  color: p.link,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 5),
              Text(
                meta,
                style: TextStyle(
                  color: p.textMuted,
                  fontSize: 10.5,
                  height: 15 / 10.5,
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            dynamicsText(item, "title") ??
                dynamicsText(item, "text") ??
                "邮件",
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 12.5,
              height: 18 / 12.5,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

/// 主动动作足迹行（折叠在「更多动态」卡里）。
class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String? summary = dynamicsText(item, "summary");
    final String? statusLabel = dynamicsText(item, "statusLabel");
    final String time = dynamicsFmtTime(dynamicsNum(item, "createdAt"));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  dynamicsText(item, "title") ?? "动作记录",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 12.5,
                    height: 18 / 12.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              if (statusLabel != null)
                Text(
                  statusLabel,
                  style: TextStyle(color: p.textMuted, fontSize: 10),
                ),
            ],
          ),
          if (summary != null) ...[
            const SizedBox(height: 1),
            Text(
              summary,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: p.textSecondary,
                fontSize: 10.5,
                height: 15 / 10.5,
              ),
            ),
          ],
          if (time.isNotEmpty) ...[
            const SizedBox(height: 1),
            Text(
              time,
              style: TextStyle(color: p.textMuted, fontSize: 10),
            ),
          ],
        ],
      ),
    );
  }
}

/// 空态（设计稿 05）：说清为什么空 + 数据源状态与去开启入口。
class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.p, required this.lastSyncedAt});

  final MobilePalette p;
  final num lastSyncedAt;

  @override
  Widget build(BuildContext context) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color ringColor =
        dark ? const Color(0xFF3A3A41) : const Color(0xFFD9D9DE);
    final Color ringIconColor =
        dark ? const Color(0xFF4A4A52) : const Color(0xFFC7C7CD);
    final Color amber = dark ? const Color(0xFFE8A94A) : const Color(0xFFB26A00);
    final Color green = dark ? const Color(0xFF6BD39A) : const Color(0xFF1F9D55);
    final String synced = lastSyncedAt > 0
        ? _syncAgo(lastSyncedAt)
        : "刚刚";

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 26, bottom: 8),
          child: Column(
            children: [
              CustomPaint(
                painter: _DashedCirclePainter(color: ringColor),
                child: SizedBox(
                  width: 66,
                  height: 66,
                  child: Center(
                    child: Icon(Icons.graphic_eq,
                        size: 26, color: ringIconColor),
                  ),
                ),
              ),
              const SizedBox(height: 13),
              Text(
                "还没有可展示的动态",
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 5),
              SizedBox(
                width: 230,
                child: Text(
                  "Agent 需要先拿到短信、通知或邮件，才能识别账单与快递。",
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: p.textMuted,
                    fontSize: 11,
                    height: 17 / 11,
                  ),
                ),
              ),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.only(top: 14),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: p.divider),
          ),
          child: Column(
            children: [
              _StatusRow(
                p: p,
                icon: Icons.notifications_none_rounded,
                title: "通知捕捉",
                subtitle: "未开启，短信/物流通知进不来",
                action: "去开启",
                actionColor: amber,
                onTap: () => _hint(
                  context,
                  "请在系统设置 → 通知使用权中允许本应用读取通知",
                ),
              ),
              _StatusRow(
                p: p,
                icon: Icons.mail_outline_rounded,
                title: "邮件监听",
                subtitle: "未配置 IMAP，账单邮件不会入账",
                action: "去配置",
                actionColor: p.link,
                onTap: () => _hint(
                  context,
                  "邮件监听需在服务端配置 IMAP 账号（MAIL_WATCH）后生效",
                ),
              ),
              _StatusRow(
                p: p,
                icon: Icons.smartphone_outlined,
                title: "短信权限",
                subtitle: "由通知使用权统一管理",
                action: "跟随系统",
                actionColor: p.textMuted,
              ),
              _StatusRow(
                p: p,
                icon: Icons.schedule_rounded,
                title: "最近同步",
                subtitle: "$synced · 服务端正常",
                action: "正常",
                actionColor: green,
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }

  static String _syncAgo(num ms) {
    final int diff =
        DateTime.now().millisecondsSinceEpoch - ms.toInt();
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return "${diff ~/ 60000} 分钟前";
    if (diff < 86400000) return "${diff ~/ 3600000} 小时前";
    return "${diff ~/ 86400000} 天前";
  }

  static void _hint(BuildContext context, String text) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(text, style: const TextStyle(fontSize: 12)),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 3),
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.p,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.action,
    required this.actionColor,
    this.onTap,
    this.last = false,
  });

  final MobilePalette p;
  final IconData icon;
  final String title;
  final String subtitle;
  final String action;
  final Color actionColor;
  final VoidCallback? onTap;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider)),
      ),
      child: Row(
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: BoxDecoration(
              color: p.innerFieldBackground,
              borderRadius: BorderRadius.circular(7),
            ),
            child: Icon(icon, size: 13, color: p.textSecondary),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: p.textMuted, fontSize: 10),
                ),
              ],
            ),
          ),
          if (onTap != null)
            GestureDetector(
              onTap: onTap,
              child: Text(
                action,
                style: TextStyle(
                  color: actionColor,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w500,
                ),
              ),
            )
          else
            Text(
              action,
              style: TextStyle(color: actionColor, fontSize: 10.5),
            ),
        ],
      ),
    );
  }
}

/// 首屏无缓存时的骨架（设计稿规格：3 张灰块，不用整页 spinner）。
class _Skeleton extends StatelessWidget {
  const _Skeleton({required this.p});

  final MobilePalette p;

  @override
  Widget build(BuildContext context) {
    Widget block(double height) => Container(
          height: height,
          margin: const EdgeInsets.only(bottom: 9),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: p.divider),
          ),
        );
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
      children: [
        Row(
          children: [
            Expanded(child: block(94)),
            const SizedBox(width: 9),
            Expanded(child: block(94)),
          ],
        ),
        const SizedBox(height: 9),
        block(126),
        block(126),
        block(126),
      ],
    );
  }
}

class _DashedCirclePainter extends CustomPainter {
  const _DashedCirclePainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final Path path = Path()
      ..addOval(Rect.fromLTWH(0.5, 0.5, size.width - 1, size.height - 1));
    const double dash = 4;
    const double gap = 3;
    for (final metric in path.computeMetrics()) {
      double d = 0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, d + dash), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedCirclePainter oldDelegate) =>
      oldDelegate.color != color;
}
