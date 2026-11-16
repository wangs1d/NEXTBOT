import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";
import "../core/services/nb_http.dart";

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
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
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
    final bills = _listOf("bills", "recent");
    final parcels = _listOf("parcels", "recent");
    final pending = _listOf("alerts", "pending");
    final activity = _listOf("alerts", "activity");
    final mail = _listOf("mail", "recent");
    final num billTotal = _numOf("bills", "totalAmount");
    final num billCount = _numOf("bills", "count");
    final num awaiting = _numOf("parcels", "awaitingPickup");
    final bool allEmpty = bills.isEmpty &&
        parcels.isEmpty &&
        pending.isEmpty &&
        activity.isEmpty &&
        mail.isEmpty;

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        // —— 汇总卡：账单合计 / 待取快递 ——
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Row(
            children: [
              Expanded(
                child: _SummaryCard(
                  p: p,
                  label: "本月账单",
                  value: billCount == 0
                      ? "—"
                      : "¥${_fmtAmount(billTotal)}",
                  hint: billCount == 0 ? "暂无识别到的账单" : "$billCount 笔",
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _SummaryCard(
                  p: p,
                  label: "待取快递",
                  value: awaiting == 0 ? "—" : "$awaiting",
                  hint: awaiting == 0 ? "暂无待取件" : "件，取件码见下方",
                ),
              ),
            ],
          ),
        ),
        if (allEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 48),
            child: Column(
              children: [
                Icon(Icons.graphic_eq, size: 44, color: p.textMuted),
                const SizedBox(height: 12),
                Text(
                  "还没有动静\nAgent 识别到账单、快递或日程变动时会出现在这里",
                  textAlign: TextAlign.center,
                  style: TextStyle(color: p.textSecondary, fontSize: 14),
                ),
              ],
            ),
          )
        else ...[
          if (pending.isNotEmpty)
            _Section(
              p: p,
              title: "提醒",
              child: Column(
                children: [
                  for (final item in pending)
                    _AlertCard(p: p, item: item),
                ],
              ),
            ),
          if (parcels.isNotEmpty)
            _Section(
              p: p,
              title: "快递",
              child: Column(
                children: [
                  for (final item in parcels)
                    _ParcelCard(p: p, item: item),
                ],
              ),
            ),
          if (bills.isNotEmpty)
            _Section(
              p: p,
              title: "账单",
              child: Column(
                children: [
                  for (final item in bills) _BillCard(p: p, item: item),
                ],
              ),
            ),
          if (activity.isNotEmpty)
            _Section(
              p: p,
              title: "Agent 足迹",
              child: Column(
                children: [
                  for (final item in activity.take(6))
                    _ActivityCard(p: p, item: item),
                ],
              ),
            ),
          if (mail.isNotEmpty)
            _Section(
              p: p,
              title: "邮件要事",
              child: Column(
                children: [
                  for (final item in mail) _MailCard(p: p, item: item),
                ],
              ),
            ),
        ],
      ],
    );
  }

  static String _fmtAmount(num v) {
    final double d = v.toDouble();
    if (d == d.roundToDouble()) return d.toStringAsFixed(0);
    return d.toStringAsFixed(2);
  }

  /// 相对时间：今天 → "HH:mm"；昨天 → "昨天 HH:mm"；更早 → "M月d日"。
  static String _fmtTime(num ms) {
    if (ms <= 0) return "";
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    final DateTime now = DateTime.now();
    final bool sameDay =
        t.year == now.year && t.month == now.month && t.day == now.day;
    final String hm =
        "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
    if (sameDay) return hm;
    final DateTime yesterday = now.subtract(const Duration(days: 1));
    final bool isYesterday = t.year == yesterday.year &&
        t.month == yesterday.month &&
        t.day == yesterday.day;
    if (isYesterday) return "昨天 $hm";
    return "${t.month}月${t.day}日 $hm";
  }
}

// —— 通用小组件 ——

/// 区块标题 + 卡片组
class _Section extends StatelessWidget {
  const _Section({required this.p, required this.title, required this.child});

  final MobilePalette p;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              title,
              style: TextStyle(
                color: p.textSecondary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          child,
        ],
      ),
    );
  }
}

/// 顶部汇总数字卡
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.p,
    required this.label,
    required this.value,
    required this.hint,
  });

  final MobilePalette p;
  final String label;
  final String value;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(color: p.textSecondary, fontSize: 12)),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 24,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 2),
          Text(hint,
              style: TextStyle(color: p.textMuted, fontSize: 11)),
        ],
      ),
    );
  }
}

/// 提醒卡（attention pending：Agent 的未决提醒）
class _AlertCard extends StatelessWidget {
  const _AlertCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "提醒";
    final String summary = item["summary"]?.toString() ?? "";
    final String urgency = item["urgency"]?.toString() ?? "normal";
    final bool urgent = urgency == "interrupt" || urgency == "alert";
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: urgent
              ? const Color(0xFFE5484D).withValues(alpha: 0.45)
              : p.divider.withValues(alpha: 0.6),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (urgent)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: const BoxDecoration(
                      color: Color(0xFFE5484D),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          if (summary.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              summary,
              style: TextStyle(color: p.textSecondary, fontSize: 13),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ],
      ),
    );
  }
}

/// 快递卡：待取件取件码大字；其余显示运单号/承运商
class _ParcelCard extends StatelessWidget {
  const _ParcelCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "包裹动态";
    final String? pickupCode = item["pickupCode"]?.toString();
    final String? trackingNo = item["trackingNo"]?.toString();
    final String? carrier = item["carrier"]?.toString();
    final num occurredAt = (item["occurredAt"] as num?) ?? 0;
    final bool awaiting = (pickupCode ?? "").isNotEmpty;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: awaiting
              ? p.textPrimary.withValues(alpha: 0.55)
              : p.divider.withValues(alpha: 0.6),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  <String>[
                    if (carrier != null && carrier.isNotEmpty) carrier,
                    if (trackingNo != null && trackingNo.isNotEmpty)
                      "单号 $trackingNo",
                    MobileDynamicsPageState._fmtTime(occurredAt),
                  ].join(" · "),
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (awaiting)
            Container(
              margin: const EdgeInsets.only(left: 10),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: p.textPrimary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  Text("取件码",
                      style: TextStyle(
                          color: p.surface, fontSize: 9, letterSpacing: 1)),
                  Text(
                    pickupCode!,
                    style: TextStyle(
                      color: p.surface,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
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

/// 账单卡：类型/金额/来源/时间
class _BillCard extends StatelessWidget {
  const _BillCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "账单";
    final String? billType = item["billType"]?.toString();
    final num? amount = item["amount"] as num?;
    final String source = item["source"]?.toString() ?? "";
    final num occurredAt = (item["occurredAt"] as num?) ?? 0;
    final String sourceLabel = switch (source) {
      "email" => "邮件",
      "sms" => "短信",
      _ => "手机通知",
    };
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  <String>[
                    if (billType != null && billType.isNotEmpty) billType,
                    sourceLabel,
                    MobileDynamicsPageState._fmtTime(occurredAt),
                  ].join(" · "),
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (amount != null)
            Text(
              "¥${MobileDynamicsPageState._fmtAmount(amount)}",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
        ],
      ),
    );
  }
}

/// Agent 足迹卡（主动动作台账）
class _ActivityCard extends StatelessWidget {
  const _ActivityCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "";
    final String summary = item["summary"]?.toString() ?? "";
    final String statusLabel = item["statusLabel"]?.toString() ?? "";
    final num occurredAt = (item["createdAt"] as num?) ?? 0;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (statusLabel.isNotEmpty)
                Text(statusLabel,
                    style: TextStyle(color: p.textMuted, fontSize: 11)),
            ],
          ),
          if (summary.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              summary,
              style: TextStyle(color: p.textSecondary, fontSize: 13),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const SizedBox(height: 2),
          Text(
            MobileDynamicsPageState._fmtTime(occurredAt),
            style: TextStyle(color: p.textMuted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

/// 邮件要事卡（邮件流高价值件；验证码不进动态页）
class _MailCard extends StatelessWidget {
  const _MailCard({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "邮件";
    final String text = item["text"]?.toString() ?? "";
    final num at = (item["at"] as num?) ?? 0;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          if (text.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              text,
              style: TextStyle(color: p.textSecondary, fontSize: 13),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const SizedBox(height: 2),
          Text(
            MobileDynamicsPageState._fmtTime(at),
            style: TextStyle(color: p.textMuted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}
