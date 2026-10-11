import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../../core/services/phone_remote_api.dart";

/// 我的手机 —— 常用工具「手机」入口的落地页。
///
/// 对接的是**用户自己那台已配对的手机**（手机 App 运行 PhoneBridgeService 桥接），
/// 页面上的每个动作都经服务端 `phone.bridge.invoke` 下发到手机执行：
/// 拨号 / 发短信 / 响铃找手机 / 定位 / 电量 / 短信记录 / 通话记录。
///
/// 与聊天页底部那个「📞」（Agent 持有的**虚拟电话**）是两回事。
class PhoneDevicesPage extends StatefulWidget {
  const PhoneDevicesPage({super.key, this.api});

  /// 可注入的 API 客户端（测试用）；缺省走真实 [PhoneRemoteApi]。
  final PhoneRemoteApi? api;

  @override
  State<PhoneDevicesPage> createState() => _PhoneDevicesPageState();
}

class _PhoneDevicesPageState extends State<PhoneDevicesPage> {
  late final PhoneRemoteApi _api;

  final TextEditingController _numberController = TextEditingController();
  final TextEditingController _smsController = TextEditingController();

  PhoneRemoteStatus _status = const PhoneRemoteStatus(online: false);
  bool _loadingStatus = true;

  /// 正在执行的动作用户可见标识（同时只允许一个动作在途）。
  String? _busyAction;

  /// 最近一次操作反馈（成功/失败 + 文案）。
  _Feedback? _feedback;

  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? PhoneRemoteApi();
    _refreshStatus();
    // 轻量轮询在线状态：手机 App 前后台切换时连接条能自愈。
    _pollTimer = Timer.periodic(
      const Duration(seconds: 20),
      (_) => _refreshStatus(silent: true),
    );
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _numberController.dispose();
    _smsController.dispose();
    super.dispose();
  }

  bool get _online => _status.online;
  bool get _busy => _busyAction != null;

  Future<void> _refreshStatus({bool silent = false}) async {
    if (!silent && mounted) setState(() => _loadingStatus = true);
    final PhoneRemoteStatus s = await _api.status();
    if (!mounted) return;
    setState(() {
      _status = s;
      _loadingStatus = false;
    });
  }

  /// 统一下发一条远控指令，收敛 busy / 反馈 / 掉线重查。
  ///
  /// [quietSuccess]：成功时不写反馈条（读取类动作的数据由弹层自己呈现），
  /// 但失败仍会写一条错误反馈。
  Future<PhoneRemoteResult?> _run(
    String action,
    Map<String, dynamic> params,
    String busyLabel, {
    bool quietSuccess = false,
  }) async {
    if (_busy) return null;
    setState(() {
      _busyAction = busyLabel;
      _feedback = null;
    });
    final PhoneRemoteResult result = await _api.invoke(action, params);
    if (!mounted) return result;
    setState(() {
      _busyAction = null;
      _feedback = (result.ok && quietSuccess) ? null : _describe(action, result);
    });
    if (!result.ok && (result.error?.contains("offline") ?? false)) {
      _refreshStatus(silent: true);
    }
    return result;
  }

  /// 把手机端回执翻译成一句用户看得懂的话。
  _Feedback _describe(String action, PhoneRemoteResult r) {
    if (r.ok && action == "dial") {
      switch (r.state) {
        case "dialing":
          return const _Feedback(true, "已在手机上确认并拨出，正在呼叫…");
        case "dialer_opened":
          return const _Feedback(true, "已打开手机拨号盘并填好号码，按下拨号键即可拨出。");
        default:
          return const _Feedback(true, "拨号请求已送达手机。");
      }
    }
    if (action == "send_sms") {
      if (r.ok) return const _Feedback(true, "已在手机上确认，短信已发出。");
      if (r.state == "cancelled") return const _Feedback(false, "手机上取消了发送（或超时未确认）。");
    }
    if (action == "ring") {
      if (r.ok) return const _Feedback(true, "已让手机响铃，看看它在哪。");
    }
    if (action == "locate") {
      if (r.ok) {
        final dynamic lat = r.data["latitude"];
        final dynamic lng = r.data["longitude"];
        final dynamic acc = r.data["accuracy"];
        if (lat != null && lng != null) {
          final String a = acc is num ? "（精度约 ${acc.round()} 米）" : "";
          return _Feedback(true, "手机位置：$lat, $lng$a");
        }
      }
    }
    if (action == "battery") {
      if (r.ok) {
        final dynamic level = r.data["level"];
        final bool charging = r.data["charging"] == true;
        return _Feedback(true, "手机电量 $level%${charging ? "（充电中）" : ""}");
      }
    }
    if (r.ok) return const _Feedback(true, "已发送到手机执行。");
    return _Feedback(false, _errorText(r));
  }

  String _errorText(PhoneRemoteResult r) {
    final String raw = r.error ?? "操作失败";
    if (raw.contains("offline")) return "手机端未连接：请打开手机 App 并保持「手机桥接」开启。";
    if (raw.contains("timeout")) return "手机没有响应（可能不在身边或已断开），稍后再试。";
    if (raw.contains("cancelled")) return "手机上取消了这次操作。";
    if (raw.contains("permission")) return "手机缺少相应权限，请到手机 App 里授权。";
    return raw;
  }

  // ─── 具体动作 ───

  Future<void> _dial() async {
    final String number = _numberController.text.trim();
    if (number.isEmpty) {
      setState(() => _feedback = const _Feedback(false, "请输入要拨打的号码。"));
      return;
    }
    await _run("dial", <String, dynamic>{"number": number}, "拨号");
  }

  Future<void> _sendSms() async {
    final String number = _numberController.text.trim();
    final String text = _smsController.text.trim();
    if (number.isEmpty) {
      setState(() => _feedback = const _Feedback(false, "请先填写收件人号码。"));
      return;
    }
    if (text.isEmpty) {
      setState(() => _feedback = const _Feedback(false, "请输入短信内容。"));
      return;
    }
    await _run(
      "send_sms",
      <String, dynamic>{"number": number, "text": text},
      "发送短信",
    );
  }

  Future<void> _ring() => _run("ring", <String, dynamic>{"durationSec": 20}, "响铃");
  Future<void> _locate() => _run("locate", const <String, dynamic>{}, "定位");
  Future<void> _battery() => _run("battery", const <String, dynamic>{}, "电量");

  Future<void> _showSmsList() async {
    final PhoneRemoteResult? r = await _run(
      "sms_list",
      <String, dynamic>{"limit": 30},
      "读取短信",
      quietSuccess: true,
    );
    if (r == null || !mounted) return;
    if (!r.ok) return;
    final List<Map<String, dynamic>> items = r.listOf("messages");
    await _showSheet(
      title: "手机短信（近 ${items.length} 条）",
      emptyHint: "没有读到短信（可能未授权短信权限）。",
      children: items.map(_smsTile).toList(),
    );
  }

  Future<void> _showCallLog() async {
    final PhoneRemoteResult? r = await _run(
      "call_log",
      <String, dynamic>{"limit": 30},
      "读取通话记录",
      quietSuccess: true,
    );
    if (r == null || !mounted) return;
    if (!r.ok) return;
    final List<Map<String, dynamic>> items = r.listOf("calls");
    await _showSheet(
      title: "通话记录（近 ${items.length} 条）",
      emptyHint: "没有读到通话记录（可能未授权电话权限）。",
      children: items.map(_callTile).toList(),
    );
  }

  // ─── 渲染 ───

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        title: const Text("📱 我的手机"),
        actions: <Widget>[
          IconButton(
            tooltip: "刷新连接状态",
            icon: const Icon(Icons.refresh),
            onPressed: _loadingStatus ? null : () => _refreshStatus(),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _buildStatusBanner(cs, text),
          const SizedBox(height: 12),
          _buildHint(cs, text),
          const SizedBox(height: 16),
          _buildDialCard(cs, text),
          const SizedBox(height: 16),
          _buildSmsCard(cs, text),
          const SizedBox(height: 16),
          _buildQuickActions(cs, text),
          if (_feedback != null) ...<Widget>[
            const SizedBox(height: 16),
            _buildFeedback(cs, text, _feedback!),
          ],
        ],
      ),
    );
  }

  Widget _buildStatusBanner(ColorScheme cs, TextTheme text) {
    final Color tone = _online ? Colors.green : cs.onSurfaceVariant;
    final Map<String, dynamic>? info = _status.deviceInfo;

    final List<String> bits = <String>[];
    if (info != null) {
      final String brand = (info["brand"] ?? info["manufacturer"] ?? "").toString();
      final String model = (info["model"] ?? "").toString();
      final String sys = (info["systemVersion"] ??
              info["androidVersion"] ??
              info["system"] ??
              "")
          .toString();
      final String name = <String>[brand, model].where((s) => s.isNotEmpty).join(" ");
      if (name.isNotEmpty) bits.add(name);
      if (sys.isNotEmpty) bits.add(sys);
      final dynamic level = info["batteryLevel"];
      if (level is num) bits.add("电量 ${level.round()}%");
    }

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: <Widget>[
          if (_loadingStatus)
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: tone),
            )
          else
            Icon(_online ? Icons.smartphone : Icons.phonelink_erase, color: tone, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  _online ? "手机已连接" : "手机未连接",
                  style: text.titleSmall?.copyWith(
                    color: _online ? Colors.green.shade700 : cs.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (bits.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    bits.join(" · "),
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                ] else if (!_online) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    "打开手机 App 并保持「手机桥接」开启即可连接",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHint(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.info_outline, color: cs.primary, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              "这里的动作都下发到你自己那台手机执行（拨号、短信会在手机上弹确认窗）。"
              "聊天页底部那个「📞」才是联系 Agent 的虚拟电话。",
              style: text.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDialCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.phone_in_talk, "拨号"),
          const SizedBox(height: 12),
          TextField(
            controller: _numberController,
            keyboardType: TextInputType.phone,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: "手机号 / 联系人号码",
              hintText: "例如 13800138000",
              prefixIcon: Icon(Icons.phone_iphone),
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: <Widget>[
              FilledButton.icon(
                onPressed: (!_online || _busy) ? null : _dial,
                icon: _busyIcon("拨号"),
                label: const Text("用手机拨打"),
              ),
              OutlinedButton.icon(
                onPressed: _numberController.text.trim().isEmpty
                    ? null
                    : () => _copy(_numberController.text.trim(), "号码"),
                icon: const Icon(Icons.copy, size: 18),
                label: const Text("复制号码"),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSmsCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.sms_outlined, "短信"),
          const SizedBox(height: 12),
          TextField(
            controller: _smsController,
            maxLines: 4,
            minLines: 2,
            decoration: const InputDecoration(
              labelText: "短信内容",
              hintText: "想说的话…（收件人用上方号码）",
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.tonalIcon(
            onPressed: (!_online || _busy) ? null : _sendSms,
            icon: _busyIcon("发送短信"),
            label: const Text("用手机发送"),
          ),
        ],
      ),
    );
  }

  Widget _buildQuickActions(ColorScheme cs, TextTheme text) {
    final bool enabled = _online && !_busy;
    final List<_QuickAction> actions = <_QuickAction>[
      _QuickAction(
        icon: Icons.notifications_active_outlined,
        label: "响铃",
        hint: "找手机",
        onTap: enabled ? _ring : null,
      ),
      _QuickAction(
        icon: Icons.location_on_outlined,
        label: "定位",
        hint: "看在哪",
        onTap: enabled ? _locate : null,
      ),
      _QuickAction(
        icon: Icons.battery_charging_full_outlined,
        label: "电量",
        hint: "剩多少",
        onTap: enabled ? _battery : null,
      ),
      _QuickAction(
        icon: Icons.mark_email_read_outlined,
        label: "短信",
        hint: "记录",
        onTap: enabled ? _showSmsList : null,
      ),
      _QuickAction(
        icon: Icons.history,
        label: "通话",
        hint: "记录",
        onTap: enabled ? _showCallLog : null,
      ),
    ];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.apps, "远程功能"),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: actions.map((a) => _QuickActionTile(spec: a)).toList(),
          ),
        ],
      ),
    );
  }

  Widget _buildFeedback(ColorScheme cs, TextTheme text, _Feedback f) {
    final Color tone = f.ok ? Colors.green : cs.error;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(
            f.ok ? Icons.check_circle_outline : Icons.error_outline,
            color: tone,
            size: 20,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: SelectableText(
              f.text,
              style: text.bodyMedium?.copyWith(color: cs.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  // ─── 底部弹层（短信/通话记录） ───

  Future<void> _showSheet({
    required String title,
    required String emptyHint,
    required List<Widget> children,
  }) async {
    final ColorScheme cs = Theme.of(context).colorScheme;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: cs.surface,
      builder: (BuildContext ctx) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.6,
          minChildSize: 0.3,
          maxChildSize: 0.9,
          builder: (BuildContext _, ScrollController controller) {
            return Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      title,
                      style: Theme.of(ctx)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
                const Divider(height: 1),
                Expanded(
                  child: children.isEmpty
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              emptyHint,
                              textAlign: TextAlign.center,
                              style: TextStyle(color: cs.onSurfaceVariant),
                            ),
                          ),
                        )
                      : ListView.separated(
                          controller: controller,
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          itemCount: children.length,
                          separatorBuilder: (_, __) => const Divider(
                            height: 1,
                            indent: 16,
                            endIndent: 16,
                          ),
                          itemBuilder: (_, int i) => children[i],
                        ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Widget _smsTile(Map<String, dynamic> m) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String address = (m["address"] ?? "未知号码").toString();
    final String body = (m["body"] ?? "").toString();
    final bool outbound = m["direction"] == "outbound";
    return ListTile(
      dense: true,
      leading: Icon(
        outbound ? Icons.call_made : Icons.call_received,
        size: 18,
        color: cs.onSurfaceVariant,
      ),
      title: Text(address, style: const TextStyle(fontSize: 14)),
      subtitle: Text(
        body,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 12.5),
      ),
      trailing: Text(
        _formatTs(m["dateMs"]),
        style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
      ),
    );
  }

  Widget _callTile(Map<String, dynamic> c) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String name = (c["name"] ?? "").toString().trim();
    final String number = (c["number"] ?? "").toString();
    final String type = (c["type"] ?? "other").toString();
    final int durSec = (c["durationSec"] is num)
        ? (c["durationSec"] as num).toInt()
        : 0;

    IconData icon;
    Color tone;
    String label;
    switch (type) {
      case "missed":
        icon = Icons.phone_missed;
        tone = cs.error;
        label = "未接";
        break;
      case "outgoing":
        icon = Icons.call_made;
        tone = Colors.green;
        label = "呼出";
        break;
      case "incoming":
        icon = Icons.call_received;
        tone = Colors.blue;
        label = "呼入";
        break;
      default:
        icon = Icons.phone;
        tone = cs.onSurfaceVariant;
        label = "通话";
    }

    final String title = name.isNotEmpty ? name : (number.isEmpty ? "未知" : number);
    final String sub = <String>[
      if (name.isNotEmpty && number.isNotEmpty) number,
      label,
      if (durSec > 0) "$durSec 秒",
    ].join(" · ");

    return ListTile(
      dense: true,
      leading: Icon(icon, size: 18, color: tone),
      title: Text(title, style: const TextStyle(fontSize: 14)),
      subtitle: Text(sub, style: const TextStyle(fontSize: 12.5)),
      trailing: Text(
        _formatTs(c["dateMs"]),
        style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
      ),
    );
  }

  // ─── 小工具 ───

  Widget _busyIcon(String label) {
    if (_busyAction != label) {
      return const Icon(Icons.send_to_mobile, size: 18);
    }
    return const SizedBox(
      width: 18,
      height: 18,
      child: CircularProgressIndicator(strokeWidth: 2),
    );
  }

  Future<void> _copy(String value, String label) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("$label 已复制")),
    );
  }

  String _formatTs(dynamic dateMs) {
    if (dateMs is! num) return "";
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(dateMs.toInt());
    String two(int n) => n.toString().padLeft(2, "0");
    return "${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}";
  }

  BoxDecoration _cardDecoration(ColorScheme cs) {
    return BoxDecoration(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
    );
  }

  Widget _sectionTitle(
    ColorScheme cs,
    TextTheme text,
    IconData icon,
    String label,
  ) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 18, color: cs.primary),
        const SizedBox(width: 8),
        Text(
          label,
          style: text.titleSmall?.copyWith(
            color: cs.onSurface,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

/// 单次操作的反馈（成功/失败 + 面向用户的文案）。
class _Feedback {
  const _Feedback(this.ok, this.text);
  final bool ok;
  final String text;
}

class _QuickAction {
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.hint,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String hint;
  final VoidCallback? onTap;
}

class _QuickActionTile extends StatelessWidget {
  const _QuickActionTile({required this.spec});

  final _QuickAction spec;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool enabled = spec.onTap != null;
    final Color tone = enabled ? cs.onSurface : cs.onSurfaceVariant;

    return SizedBox(
      width: 104,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: spec.onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
            decoration: BoxDecoration(
              border: Border.all(
                color: cs.outline.withValues(alpha: enabled ? 0.35 : 0.15),
              ),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(spec.icon, color: tone, size: 22),
                const SizedBox(height: 6),
                Text(
                  spec.label,
                  style: TextStyle(fontSize: 12.5, color: tone),
                ),
                Text(
                  spec.hint,
                  style: TextStyle(
                    fontSize: 10.5,
                    color: cs.onSurfaceVariant.withValues(alpha: 0.8),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
