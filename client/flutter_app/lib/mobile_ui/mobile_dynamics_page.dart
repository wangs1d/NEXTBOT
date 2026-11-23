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

  /// 「{月份}小结」原始数据（服务端 monthly 字段；null = 台账未启用，整卡不渲染）
  Map<String, dynamic>? get _monthly {
    final Object? raw = _data["monthly"];
    return raw is Map<String, dynamic> && raw.isNotEmpty ? raw : null;
  }

  /// 月报卡明细页要用的账单条目（与下方账单区块同一份，不再发第二次请求）
  List<String> get _billTypes {
    final List<dynamic> raw =
        (_data["billTypes"] as List<dynamic>?) ?? const <dynamic>[];
    return raw.whereType<String>().toList(growable: false);
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
    final Map<String, dynamic>? monthly = _monthly;
    final bool allEmpty = bills.isEmpty &&
        parcels.isEmpty &&
        pending.isEmpty &&
        activity.isEmpty &&
        mail.isEmpty &&
        monthly == null;

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
          if (bills.isNotEmpty || monthly != null)
            _Section(
              p: p,
              title: "账单",
              child: Column(
                children: [
                  // §9 钱的月报：区块顶部的「{月份}小结」卡，点开看明细 + 改类目
                  if (monthly != null)
                    _MonthlySummaryCard(
                      p: p,
                      monthly: monthly,
                      onTap: () => _openMonthlyDetail(context, monthly, bills),
                    ),
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
              // 收束卡：多封邮件叠成一张薄卡，卡面只展示最新一封；
              // 点进去进详情页看全部（点击见 _openMailDetail）。
              child: _MailDigestCard(
                p: p,
                items: mail,
                onTap: () => _openMailDetail(context, mail),
              ),
            ),
        ],
      ],
    );
  }

  /// 邮件列表统一排序（新→旧），卡面与详情页共用同一口径。
  static List<Map<String, dynamic>> sortMailByNewest(
      List<Map<String, dynamic>> items) {
    final List<Map<String, dynamic>> sorted =
        List<Map<String, dynamic>>.from(items)
          ..sort((a, b) =>
              ((b["at"] as num?) ?? 0).compareTo((a["at"] as num?) ?? 0));
    return sorted;
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

  /// 点邮件收束卡 → 全屏详情页看全部。
  /// 数据直接复用本页已拉取的 mail 列表，不再发第二次请求。
  /// 按 at 降序（新→旧）传入，卡面与详情首条一致都是最新一封。
  void _openMailDetail(BuildContext context, List<Map<String, dynamic>> items) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MobileMailDetailPage(
            items: MobileDynamicsPageState.sortMailByNewest(items),
          ),
        ),
      ),
    );
  }

  /// 点「{月份}小结」卡 → 月报明细页（§9 交互：点开看明细，类目可改）。
  /// 账单条目复用本页已拉取的 bills.recent，改类目后由详情页自己回写本地状态。
  void _openMonthlyDetail(
    BuildContext context,
    Map<String, dynamic> monthly,
    List<Map<String, dynamic>> bills,
  ) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MobileMonthlyDetailPage(
            monthly: monthly,
            bills: bills,
            billTypes: _billTypes,
          ),
        ),
      ),
    );
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

/// 邮件要事收束卡（卡面展示最新一封；多封叠成一张薄卡，点进去看全部）。
///
/// 表面三要素：图标 + 最新一封标题/摘要 + 「N 封 · 查看全部」提示；
/// 数据来自 /api/dynamics 的 mail.recent（title/text/at），验证码已被服务端拦下。
class _MailDigestCard extends StatelessWidget {
  const _MailDigestCard({
    required this.p,
    required this.items,
    required this.onTap,
  });

  final MobilePalette p;
  final List<Map<String, dynamic>> items;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // 自行按 at 取最新，不依赖上游顺序（缓存/规则调整都不影响「卡面=最新一封」）。
    final Map<String, dynamic> item =
        MobileDynamicsPageState.sortMailByNewest(items).first;
    final String title = item["title"]?.toString() ?? "邮件";
    final String text = item["text"]?.toString() ?? "";
    final num at = (item["at"] as num?) ?? 0;
    final int count = items.length;

    return Semantics(
      button: true,
      label: "邮件要事，共 $count 封，最新一封：$title，点击查看全部",
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider.withValues(alpha: 0.6)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: p.textPrimary.withValues(alpha: 0.06),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(Icons.mail_outline, size: 19, color: p.textPrimary),
                ),
                const SizedBox(width: 12),
                Expanded(
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
                          const SizedBox(width: 8),
                          Text(
                            MobileDynamicsPageState._fmtTime(at),
                            style: TextStyle(color: p.textMuted, fontSize: 11),
                          ),
                        ],
                      ),
                      if (text.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          text,
                          style: TextStyle(color: p.textSecondary, fontSize: 12),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      const SizedBox(height: 4),
                      Text(
                        "共 $count 封 · 查看全部",
                        style: TextStyle(
                          color: p.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Icon(Icons.chevron_right, size: 18, color: p.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 邮件要事详情页：全屏列表展示全部高价值邮件（最新在前）。
/// 列表项复用 [_MailDetailRow]，数据由动态页带过来，不发第二次请求。
class MobileMailDetailPage extends StatelessWidget {
  const MobileMailDetailPage({super.key, required this.items});

  final List<Map<String, dynamic>> items;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("邮件要事")),
      body: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        itemCount: items.length,
        itemBuilder: (BuildContext context, int index) =>
            _MailDetailRow(p: p, item: items[index]),
      ),
    );
  }
}

/// 详情页单封邮件：标题 + 摘要（完整展示，不截断）+ 时间。
class _MailDetailRow extends StatelessWidget {
  const _MailDetailRow({required this.p, required this.item});

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
      padding: const EdgeInsets.all(14),
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
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (text.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              text,
              style: TextStyle(color: p.textSecondary, fontSize: 13, height: 1.5),
            ),
          ],
          const SizedBox(height: 8),
          Text(
            MobileDynamicsPageState._fmtTime(at),
            style: TextStyle(color: p.textMuted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------- //
// §9 钱的月报（PRD 需求七）：「{月份}小结」卡 + 明细页
// ---------------------------------------------------------------------- //

/// `/api/dynamics` 的 `monthly` 字段的类型化读法。
///
/// 原始 Map 只在这里解析一次：卡片与明细页共用同一份口径，UI 里不到处 cast。
/// 缺字段一律按零值渲染——服务端每个区块都可选，客户端不能因为少一段就崩。
class _MonthlyView {
  _MonthlyView(this.raw);

  final Map<String, dynamic> raw;

  Map<String, dynamic> _sub(String key) {
    final Object? v = raw[key];
    return v is Map<String, dynamic> ? v : const <String, dynamic>{};
  }

  List<Map<String, dynamic>> _list(String key) {
    final List<dynamic>? v = raw[key] as List<dynamic>?;
    return v?.whereType<Map<String, dynamic>>().toList(growable: false) ??
        const <Map<String, dynamic>>[];
  }

  static num _n(Map<String, dynamic> m, String key) => (m[key] as num?) ?? 0;

  Map<String, dynamic> get totals => _sub("totals");
  Map<String, dynamic> get previous => _sub("previous");
  Map<String, dynamic> get mom => _sub("mom");
  Map<String, dynamic> get subscriptions => _sub("subscriptions");
  Map<String, dynamic>? get largest {
    final Map<String, dynamic> v = _sub("largest");
    return v.isEmpty ? null : v;
  }

  List<Map<String, dynamic>> get topCategories => _list("topCategories");

  /// 本月已扣 / 下月预计扣款（都在 subscriptions 段里）
  List<Map<String, dynamic>> get charged {
    final Object? v = subscriptions["charged"];
    return v is List<dynamic>
        ? v.whereType<Map<String, dynamic>>().toList(growable: false)
        : const <Map<String, dynamic>>[];
  }

  List<Map<String, dynamic>> get forecast {
    final Object? v = subscriptions["forecast"];
    return v is List<dynamic>
        ? v.whereType<Map<String, dynamic>>().toList(growable: false)
        : const <Map<String, dynamic>>[];
  }

  String get month => raw["month"]?.toString() ?? "";
  String get monthLabel => raw["monthLabel"]?.toString() ?? "本月";
  bool get complete => raw["complete"] == true;
  String get coverageHint => raw["coverageHint"]?.toString() ?? "";

  num get totalAmount => _n(totals, "totalAmount");
  num get count => _n(totals, "count");
  num get amountCount => _n(totals, "amountCount");
  num get missingAmount => _n(totals, "missingAmount");

  /// 标题：「11月小结」（1 日推出的是上月完整版，卡片自己标出来）
  String get title => "$monthLabel小结";
  String get phaseLabel => complete ? "上月完整版" : "本月进行中";

  /// 环比一句话。上月为 0 时服务端不给 ratio，此时只说绝对差额。
  String get momLine {
    final String delta = "¥${MobileDynamicsPageState._fmtAmount(_n(mom, "deltaAmount"))}";
    switch (mom["direction"]?.toString()) {
      case "up":
        return "比${_shortMonth()}多花 $delta${_momPct()}";
      case "down":
        return "比${_shortMonth()}少花 $delta${_momPct()}";
      default:
        return "与${_shortMonth()}持平";
    }
  }

  String _shortMonth() {
    // previous.month = "2026-10" → "10月"
    final List<String> parts = previous["month"]?.toString().split("-") ?? const [];
    if (parts.length == 2) {
      final int? n = int.tryParse(parts[1]);
      if (n != null) return "$n月";
    }
    return "上月";
  }

  String _momPct() {
    final Object? r = mom["ratio"];
    if (r is! num) return "";
    final int pct = (r.abs() * 100).round();
    return "（$pct%）";
  }

  /// 订阅/续费一句话：本月已扣 + 下月预计扣款
  String get subscriptionLine {
    final num charged = _n(subscriptions, "chargedCount");
    final num forecast = _n(subscriptions, "forecastCount");
    if (charged == 0 && forecast == 0) return "";
    final String a = charged == 0
        ? "本月订阅未扣款"
        : "本月已扣 $charged 笔 ¥${MobileDynamicsPageState._fmtAmount(_n(subscriptions, "chargedAmount"))}";
    final String b = forecast == 0
        ? "下月无预计扣款"
        : "下月预计 $forecast 笔 ¥${MobileDynamicsPageState._fmtAmount(_n(subscriptions, "forecastAmount"))}";
    return "$a · $b";
  }
}

/// 「{月份}小结」卡：合计 + 环比 + Top3 类目 + 最大单笔 + 续费 + 覆盖率提示。
/// 整卡可点，点开进明细页（类目在那里改）。
class _MonthlySummaryCard extends StatelessWidget {
  const _MonthlySummaryCard({
    required this.p,
    required this.monthly,
    required this.onTap,
  });

  final MobilePalette p;
  final Map<String, dynamic> monthly;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final _MonthlyView m = _MonthlyView(monthly);
    final Map<String, dynamic>? largest = m.largest;
    final String subLine = m.subscriptionLine;
    final bool noData = m.count == 0;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(14),
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
                Text(
                  m.title,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 6),
                _PhaseChip(p: p, label: m.phaseLabel),
                const Spacer(),
                Icon(Icons.chevron_right, size: 18, color: p.textMuted),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  noData ? "—" : "¥${MobileDynamicsPageState._fmtAmount(m.totalAmount)}",
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 24,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  noData ? "这个月还没有识别到账单" : "${m.count} 笔 · ${m.momLine}",
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                ),
              ],
            ),
            if (m.topCategories.isNotEmpty) ...[
              const SizedBox(height: 10),
              for (final Map<String, dynamic> c in m.topCategories)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 96,
                        child: Text(
                          c["type"]?.toString() ?? "其他",
                          style: TextStyle(color: p.textSecondary, fontSize: 13),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Text(
                        "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(c, "amount"))}",
                        style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        "${(_MonthlyView._n(c, "ratio") * 100).round()}%",
                        style: TextStyle(color: p.textMuted, fontSize: 11),
                      ),
                    ],
                  ),
                ),
            ],
            if (largest != null) ...[
              const SizedBox(height: 2),
              Text(
                "最大单笔：${largest["title"]?.toString() ?? ""} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(largest, "amount"))}",
                style: TextStyle(color: p.textMuted, fontSize: 12),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
            if (subLine.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                subLine,
                style: TextStyle(color: p.textSecondary, fontSize: 12),
              ),
            ],
            if (m.missingAmount > 0) ...[
              const SizedBox(height: 6),
              Text(
                m.coverageHint,
                // 覆盖率提示是"要补一下"的信号，用暖色但不用报错红——
                //  MobilePalette 没有 warning 档，这里与紧急快递的红点区分开。
                style: const TextStyle(color: Color(0xFFB45309), fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 卡片角标：区分「本月进行中」与「上月完整版」（1 日切换的可见证据）
class _PhaseChip extends StatelessWidget {
  const _PhaseChip({required this.p, required this.label});

  final MobilePalette p;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: p.innerFieldBackground,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(color: p.textMuted, fontSize: 10),
      ),
    );
  }
}

/// 月报明细页：小结全量数字 + 本月账单明细，类目在这里改。
///
/// 改类目 → POST /api/dynamics/bills/category → 服务端回写台账并打纠正标记，
/// 下一次识别把这条当训练样本用（分类器反馈闭环）。改完只更新本地这一行，
/// 不回灌整页重拉：合计要变的是下一次打开动态页，用户当场看的是这条改对了。
class MobileMonthlyDetailPage extends StatefulWidget {
  const MobileMonthlyDetailPage({
    super.key,
    required this.monthly,
    required this.bills,
    required this.billTypes,
  });

  final Map<String, dynamic> monthly;
  final List<Map<String, dynamic>> bills;
  final List<String> billTypes;

  @override
  State<MobileMonthlyDetailPage> createState() => _MobileMonthlyDetailPageState();
}

class _MobileMonthlyDetailPageState extends State<MobileMonthlyDetailPage> {
  late List<Map<String, dynamic>> _bills = List<Map<String, dynamic>>.of(
    widget.bills,
  );
  bool _saving = false;

  Future<void> _correctCategory(
    Map<String, dynamic> item,
    String current,
  ) async {
    final String? id = item["id"]?.toString();
    if (id == null) return;
    final List<String> options = <String>[
      ...widget.billTypes.where((String t) => t != current),
      if (current.isNotEmpty) current,
    ];
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: MobileTheme.of(context).surface,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Text(
                "这条账单归到哪一类？",
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: MobileTheme.of(ctx).textPrimary,
                ),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final String t in options)
                    ListTile(
                      dense: true,
                      title: Text(t),
                      onTap: () => Navigator.of(ctx).pop(t),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (picked == null || picked == current) return;
    setState(() => _saving = true);
    String? err;
    try {
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/dynamics/bills/category",
      );
      final http.Response res = await NbHttp.post(
        uri,
        headers: const <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(<String, dynamic>{
          "userId": ApiConfig.effectiveActorId,
          "id": id,
          "billType": picked,
        }),
      ).timeout(const Duration(seconds: 15));
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || body["ok"] != true) {
        err = body["error"]?.toString() ?? "HTTP ${res.statusCode}";
      } else {
        _bills = _bills
            .map(
              (Map<String, dynamic> e) =>
                  e["id"]?.toString() == id
                      ? <String, dynamic>{...e, "billType": picked}
                      : e,
            )
            .toList(growable: false);
      }
    } catch (e) {
      err = "$e";
    }
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 2),
        content: Text(err == null ? "已改成「$picked」，我会记住这个分类" : "改类目失败：$err"),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final _MonthlyView m = _MonthlyView(widget.monthly);
    final Map<String, dynamic>? largest = m.largest;
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: Text(m.title)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          _SummaryCard(
            p: p,
            label: "${m.monthLabel}合计",
            value: m.count == 0 ? "—" : "¥${MobileDynamicsPageState._fmtAmount(m.totalAmount)}",
            hint: m.count == 0 ? "暂无识别到的账单" : "${m.count} 笔 · ${m.momLine}",
          ),
          const SizedBox(height: 10),
          _DetailBlock(
            p: p,
            title: "分类",
            lines: m.topCategories
                .map(
                  (Map<String, dynamic> c) =>
                      "${c["type"] ?? "其他"} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(c, "amount"))}（${c["count"] ?? 0} 笔 · ${(_MonthlyView._n(c, "ratio") * 100).round()}%）",
                )
                .toList(growable: false),
            empty: "还没有带金额的账单",
          ),
          _DetailBlock(
            p: p,
            title: "最大单笔",
            lines: largest == null
                ? const <String>[]
                : <String>[
                    "${largest["title"] ?? ""} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(largest, "amount"))}",
                    MobileDynamicsPageState._fmtTime(
                      _MonthlyView._n(largest, "occurredAt"),
                    ),
                  ],
            empty: "暂无带金额的账单",
          ),
          _DetailBlock(
            p: p,
            title: "订阅 / 自动续费",
            lines: <String>[
              if (m.subscriptionLine.isNotEmpty) m.subscriptionLine,
              for (final Map<String, dynamic> s in m.charged)
                "已扣：${s["merchant"]} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(s, "amount"))}（${MobileDynamicsPageState._fmtTime(_MonthlyView._n(s, "chargedAt"))}）",
              for (final Map<String, dynamic> f in m.forecast)
                "预计：${f["merchant"]} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(f, "amount"))}（${MobileDynamicsPageState._fmtTime(_MonthlyView._n(f, "expectedAt"))}）",
            ],
            empty: "没有识别到订阅或自动续费",
          ),
          _DetailBlock(
            p: p,
            title: "识别覆盖率",
            lines: <String>[
              "${m.amountCount}/${m.count} 笔带金额",
              if (m.coverageHint.isNotEmpty) m.coverageHint,
            ],
            empty: "",
          ),
          const SizedBox(height: 16),
          Text(
            "账单明细（点一条改类目）",
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          if (_bills.isEmpty)
            Text("本月暂无明细", style: TextStyle(color: p.textMuted, fontSize: 13))
          else
            for (final Map<String, dynamic> item in _bills)
              _MonthlyBillRow(
                p: p,
                item: item,
                busy: _saving,
                onCorrect: () => _correctCategory(
                  item,
                  item["billType"]?.toString() ?? "",
                ),
              ),
        ],
      ),
    );
  }
}

/// 明细页的一组说明（标题 + 若干行；空则不渲染整块）
class _DetailBlock extends StatelessWidget {
  const _DetailBlock({
    required this.p,
    required this.title,
    required this.lines,
    required this.empty,
  });

  final MobilePalette p;
  final String title;
  final List<String> lines;
  final String empty;

  @override
  Widget build(BuildContext context) {
    final List<String> content =
        lines.where((String l) => l.isNotEmpty).toList(growable: false);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        width: double.infinity,
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
                color: p.textSecondary,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            if (content.isEmpty)
              Text(empty, style: TextStyle(color: p.textMuted, fontSize: 12))
            else
              for (final String line in content)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Text(
                    line,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

/// 明细页一条账单：摘要 + 金额 + 当前类目，点整行改类目。
class _MonthlyBillRow extends StatelessWidget {
  const _MonthlyBillRow({
    required this.p,
    required this.item,
    required this.busy,
    required this.onCorrect,
  });

  final MobilePalette p;
  final Map<String, dynamic> item;
  final bool busy;
  final VoidCallback onCorrect;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "账单";
    final String? billType = item["billType"]?.toString();
    final num? amount = item["amount"] as num?;
    final num at = (item["occurredAt"] as num?) ?? 0;
    return InkWell(
      onTap: busy ? null : onCorrect,
      borderRadius: BorderRadius.circular(12),
      child: Container(
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
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    <String>[
                      billType?.isNotEmpty == true ? "类目 $billType" : "未分类",
                      MobileDynamicsPageState._fmtTime(at),
                    ].join(" · "),
                    style: TextStyle(color: p.textMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
            if (amount != null)
              Text(
                "¥${MobileDynamicsPageState._fmtAmount(amount)}",
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            const SizedBox(width: 4),
            Icon(Icons.edit_outlined, size: 15, color: p.textMuted),
          ],
        ),
      ),
    );
  }
}
