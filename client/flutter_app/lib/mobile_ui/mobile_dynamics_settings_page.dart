// 消息设置（设计稿 SCREEN 06）。
//
// 三块内容都必须反映真实状态，不许写死：
//   · 数据源状态：通知使用权（本机 MethodChannel 真实查询）、邮件监听（服务端
//     /api/dynamics/sources 的 MailWatchStatus）、最近同步（服务端时间）；
//   · 来源规则：开关直接 PUT 到服务端，入口层立即生效（营销/群聊默认不进入）；
//   · 已拦截：本周计数按原因拆分，只回计数不展示正文。
// 「稍后提醒」默认项落在本地偏好（MobilePageCache），列表长按使用该默认值。
import "dart:async";

import "package:flutter/material.dart";

import "../core/services/phone_capture_service.dart";
import "mobile_dynamics_api.dart";
import "mobile_dynamics_shared.dart";
import "mobile_page_cache.dart";
import "mobile_service_access_page.dart";
import "mobile_theme.dart";

class DynamicsSettingsPage extends StatefulWidget {
  const DynamicsSettingsPage({
    super.key,
    this.initial,
    this.client,
  });

  /// 首页已拿到的 sources / blockedThisWeek（先上屏，再后台刷新）。
  final Map<String, dynamic>? initial;
  final dynamic client;

  @override
  State<DynamicsSettingsPage> createState() => _DynamicsSettingsPageState();
}

class _DynamicsSettingsPageState extends State<DynamicsSettingsPage> {
  late final DynamicsApi _api = DynamicsApi(client: widget.client as dynamic);
  late Map<String, dynamic> _data =
      Map<String, dynamic>.from(widget.initial ?? const <String, dynamic>{});
  Map<String, dynamic> _mail = <String, dynamic>{};
  List<Map<String, dynamic>> _rules = <Map<String, dynamic>>[];
  bool _notificationEnabled = false;
  bool _loading = true;
  bool _busy = false;
  String _defaultSnooze = "hour";

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic> initialMail =
        (_data["mail"] as Map<String, dynamic>?) ?? <String, dynamic>{};
    _mail = initialMail;
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final Future<Map<String, dynamic>?> cached =
          MobilePageCache.instance.read("dynamics_snooze_default");
      final List<Object?> results = await Future.wait<Object?>(<Future<Object?>>[
        _api.fetchSources(),
        PhoneCaptureService.instance.isListenerEnabled(),
        cached,
      ]);
      if (!mounted) return;
      final Map<String, dynamic> body =
          results[0] as Map<String, dynamic>? ?? <String, dynamic>{};
      final List<dynamic> rawRules =
          (body["rules"] as List<dynamic>?) ?? const <dynamic>[];
      setState(() {
        _data = body;
        _mail = (body["mail"] as Map<String, dynamic>?) ?? <String, dynamic>{};
        _rules = rawRules
            .whereType<Map<String, dynamic>>()
            .map((Map<String, dynamic> e) => Map<String, dynamic>.from(e))
            .toList();
        _notificationEnabled = results[1] == true;
        final Map<String, dynamic>? pref = results[2] as Map<String, dynamic>?;
        _defaultSnooze = pref?["key"]?.toString() ?? "hour";
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _snack("状态获取失败：$e");
    }
  }

  Map<String, dynamic> get _blocked =>
      (_data["blockedThisWeek"] as Map<String, dynamic>?) ??
      <String, dynamic>{};

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("消息设置")),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 4, 14, 28),
          children: <Widget>[
            _label(p, "数据源状态"),
            _sourceStatusCard(p),
            _label(p, "来源规则"),
            _rulesCard(p),
            _label(p, "已拦截", "本周"),
            _blockedCard(p),
            _label(p, "稍后提醒"),
            _snoozeCard(p),
            const SizedBox(height: 11),
            _hintCard(p),
            if (_loading)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Center(
                  child: SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 1.6),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _sourceStatusCard(MobilePalette p) {
    final bool mailConfigured = _mail["configured"] == true;
    final bool mailRunning = _mail["running"] == true;
    final bool mailOk = mailConfigured && _mail["lastError"] == null;
    final String mailDesc = !mailConfigured
        ? "未配置 · 需要 IMAP 授权码"
        : mailRunning
            ? "监听中 · 最近同步 ${dynamicsFmtAgo(_mail["lastSuccessAt"])}"
            : "已配置但未运行 · ${_mail["reason"] ?? "等待启动"}";
    final Object? lastSync = _mail["lastSuccessAt"] ?? _data["serverTime"];
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: <Widget>[
          _statusRow(
            p,
            icon: Icons.notifications_none_rounded,
            title: "通知捕捉",
            desc: _notificationEnabled ? "已开启通知使用权" : "未开启 · 无法读取系统通知",
            status: _notificationEnabled ? "正常" : "去开启",
            ok: _notificationEnabled,
            onTap: () async {
              if (_notificationEnabled) return;
              await PhoneCaptureService.instance.openListenerSettings();
              unawaited(_load());
            },
          ),
          _statusRow(
            p,
            icon: Icons.mail_outline_rounded,
            title: "邮件监听",
            desc: mailDesc,
            status: mailOk ? "正常" : "去配置",
            ok: mailOk,
            onTap: () {
              Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => const MobileServiceAccessPage()));
            },
          ),
          _statusRow(
            p,
            icon: Icons.schedule_rounded,
            title: "最近同步",
            desc: "服务端 ${dynamicsFmtAgo(lastSync)}",
            status: "刚刚",
            ok: true,
            last: true,
          ),
        ],
      ),
    );
  }

  Widget _statusRow(
    MobilePalette p, {
    required IconData icon,
    required String title,
    required String desc,
    required String status,
    required bool ok,
    VoidCallback? onTap,
    bool last = false,
  }) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(
          border: last
              ? null
              : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
        ),
        child: Row(
          children: <Widget>[
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                  color: p.surface2, borderRadius: BorderRadius.circular(9)),
              child: Icon(icon, size: 15, color: p.textPrimary),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title,
                      style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(desc,
                      style:
                          TextStyle(color: p.textMuted, fontSize: 10.5)),
                ],
              ),
            ),
            Text(status,
                style: TextStyle(
                    color: ok ? DynamicsTone.greenFg(context) : p.textMuted,
                    fontSize: 9.5,
                    fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  Widget _rulesCard(MobilePalette p) {
    final List<Map<String, dynamic>> rules = _rules;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        children: <Widget>[
          if (rules.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Text("来源规则暂不可用",
                  style: TextStyle(color: p.textMuted, fontSize: 11.5)),
            ),
          for (int i = 0; i < rules.length; i++)
            _ruleRow(p, rules[i], i == rules.length - 1),
        ],
      ),
    );
  }

  Widget _ruleRow(MobilePalette p, Map<String, dynamic> rule, bool last) {
    final bool enter = rule["action"] == "enter";
    final String id = rule["id"]?.toString() ?? "";
    final String desc = switch (id) {
      "bankSms" => "高优先 · 直接进待处理队列",
      "ecommerceMarketing" => "不进入动态页 · 入口层直接丢弃",
      "parcelNotice" => "正常 · 取件码优先展示",
      "groupChat" => "免打扰 · 不生成动态",
      _ => enter ? "进入动态页" : "不进入动态页",
    };
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: p.divider, width: 0.6)),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(rule["title"]?.toString() ?? id,
                    style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500)),
                const SizedBox(height: 2),
                Text(desc,
                    style: TextStyle(color: p.textMuted, fontSize: 10.5)),
              ],
            ),
          ),
          Switch.adaptive(
            value: enter,
            activeTrackColor: p.textPrimary,
            onChanged: _busy
                ? null
                : (bool v) async {
                    setState(() => _busy = true);
                    try {
                      final Map<String, dynamic> res =
                          await _api.setSourceRule(id, v);
                      final List<dynamic> raw = (res["rules"] as List<dynamic>?) ??
                          const <dynamic>[];
                      if (!mounted) return;
                      setState(() {
                        _rules = raw
                            .whereType<Map<String, dynamic>>()
                            .map((Map<String, dynamic> e) =>
                                Map<String, dynamic>.from(e))
                            .toList();
                        _busy = false;
                      });
                    } catch (e) {
                      if (!mounted) return;
                      setState(() => _busy = false);
                      _snack("保存失败：$e");
                    }
                  },
          ),
        ],
      ),
    );
  }

  Widget _blockedCard(MobilePalette p) {
    final Map<String, num> byReason = dynamicsBlockedByReason(_blocked);
    final num total = dynamicsNum(_blocked, "total");
    final String desc =
        "营销推广 ${byReason["marketing"]?.toInt() ?? 0} · 验证码 ${byReason["otp"]?.toInt() ?? 0} · 重复物流 ${byReason["duplicateParcel"]?.toInt() ?? 0}"
        "${(byReason["groupChat"] ?? 0) > 0 ? " · 群聊 ${byReason["groupChat"]?.toInt()}" : ""}";
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: InkWell(
        onTap: () => _showBlockedDetail(p, byReason, total),
        child: Row(
          children: <Widget>[
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                  color: p.surface2, borderRadius: BorderRadius.circular(9)),
              child: Icon(Icons.shield_outlined,
                  size: 15, color: p.textPrimary),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("${total.toInt()} 条未进入动态页",
                      style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(desc,
                      style:
                          TextStyle(color: p.textMuted, fontSize: 10.5)),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 16, color: p.textMuted),
          ],
        ),
      ),
    );
  }

  Widget _snoozeCard(MobilePalette p) {
    const Map<String, String> labels = <String, String>{
      "hour": "1 小时后",
      "tomorrow": "明天 9:00",
      "weekend": "本周末",
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: InkWell(
        onTap: () => _showSnoozeSheet(p),
        child: Row(
          children: <Widget>[
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                  color: p.surface2, borderRadius: BorderRadius.circular(9)),
              child:
                  Icon(Icons.schedule_rounded, size: 15, color: p.textPrimary),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("默认稍后提醒",
                      style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text("当前：${labels[_defaultSnooze] ?? "1 小时后"} · 到点重新回到「需要你处理」",
                      style:
                          TextStyle(color: p.textMuted, fontSize: 10.5)),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 16, color: p.textMuted),
          ],
        ),
      ),
    );
  }

  Widget _hintCard(MobilePalette p) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.inventory_2_outlined,
                  size: 13, color: p.textSecondary),
              const SizedBox(width: 5),
              Text("管理动作",
                  style: TextStyle(
                      color: p.textSecondary,
                      fontSize: 11,
                      fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            "列表页支持左滑归档、右滑完成；长按可稍后提醒（1 小时 / 明天 9:00 / 本周末）。低价值消息不折叠，直接在入口拦截，只保留计数。",
            style: TextStyle(
                color: p.textSecondary, fontSize: 11, height: 1.7),
          ),
        ],
      ),
    );
  }

  Widget _label(MobilePalette p, String title, [String? trailing]) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 7),
      child: Row(
        children: <Widget>[
          Text(title,
              style: TextStyle(
                  color: p.textSecondary,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600)),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: 6),
            Text(trailing,
                style: TextStyle(color: p.textMuted, fontSize: 10.5)),
          ],
        ],
      ),
    );
  }

  void _showSnoozeSheet(MobilePalette p) {
    final DateTime now = DateTime.now();
    final DateTime tomorrow = DateTime(now.year, now.month, now.day + 1, 9);
    final DateTime weekend = now.add(Duration(days: 7 - now.weekday));
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Center(
                child: Container(
                  width: 34,
                  height: 4,
                  decoration: BoxDecoration(
                      color: p.divider,
                      borderRadius: BorderRadius.circular(2)),
                ),
              ),
              const SizedBox(height: 14),
              Text("稍后提醒",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text("到点后重新回到「需要你处理」",
                  style: TextStyle(color: p.textMuted, fontSize: 11)),
              const SizedBox(height: 10),
              _snoozeOption(
                  p, ctx, "1 小时后", "hour",
                  "${now.add(const Duration(hours: 1)).hour}:${now.add(const Duration(hours: 1)).minute.toString().padLeft(2, "0")}"),
              _snoozeOption(p, ctx, "明天 9:00", "tomorrow",
                  "${tomorrow.month}月${tomorrow.day}日"),
              _snoozeOption(p, ctx, "本周末", "weekend",
                  "${weekend.month}月${weekend.day}日"),
              const SizedBox(height: 6),
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: Text("取消",
                      style: TextStyle(color: p.textSecondary, fontSize: 12)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _snoozeOption(
      MobilePalette p, BuildContext ctx, String label, String key, String hint) {
    return InkWell(
      onTap: () {
        setState(() => _defaultSnooze = key);
        MobilePageCache.instance
            .write("dynamics_snooze_default", <String, dynamic>{"key": key});
        Navigator.pop(ctx);
        _snack("默认稍后提醒：$label");
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: <Widget>[
            Icon(Icons.schedule_rounded, size: 16, color: p.textPrimary),
            const SizedBox(width: 9),
            Text(label,
                style: TextStyle(color: p.textPrimary, fontSize: 12.5)),
            const Spacer(),
            Text(hint,
                style: TextStyle(color: p.textMuted, fontSize: 10.5)),
          ],
        ),
      ),
    );
  }

  void _showBlockedDetail(
      MobilePalette p, Map<String, num> byReason, num total) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("本周拦截 ${total.toInt()} 条",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 5),
              Text("只记录原因与来源，不保存正文——可审计但不泄露内容。",
                  style: TextStyle(
                      color: p.textSecondary, fontSize: 11.5, height: 1.7)),
              const SizedBox(height: 12),
              _blockedLine(p, "营销推广", byReason["marketing"] ?? 0),
              _blockedLine(p, "验证码", byReason["otp"] ?? 0),
              _blockedLine(p, "重复物流", byReason["duplicateParcel"] ?? 0),
              if ((byReason["sourceRule"] ?? 0) > 0)
                _blockedLine(p, "来源规则", byReason["sourceRule"] ?? 0),
              if ((byReason["groupChat"] ?? 0) > 0)
                _blockedLine(p, "群聊通知", byReason["groupChat"] ?? 0),
            ],
          ),
        ),
      ),
    );
  }

  Widget _blockedLine(MobilePalette p, String label, num count) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: <Widget>[
          Text(label,
              style: TextStyle(color: p.textSecondary, fontSize: 12)),
          const Spacer(),
          Text("${count.toInt()} 条",
              style: TextStyle(color: p.textPrimary, fontSize: 12)),
        ],
      ),
    );
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
          content: Text(text), duration: const Duration(seconds: 2)));
  }
}
