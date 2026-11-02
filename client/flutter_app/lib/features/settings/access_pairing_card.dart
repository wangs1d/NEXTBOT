import "dart:async";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/access_auth_api.dart";

/// 「设备配对」卡：本机访问凭据（设备 token）的获取、代签与吊销。
///
/// 服务端开周界鉴权（ACCESS_AUTH_REQUIRED=1）后，每台设备必须先配对才取得到
/// 自己的数据；凭据只落本机文件，服务端只存 sha256 哈希、永不回吐明文。
class AccessPairingCard extends StatefulWidget {
  const AccessPairingCard({super.key, this.margin, this.api});

  /// 卡片外边距：桌面设置页贴内容区（零边距），手机端按列表留 16。
  final EdgeInsetsGeometry? margin;

  /// 注入点（效果图/测试用假客户端），默认走真实 [AccessAuthApi]。
  final AccessAuthApi? api;

  @override
  State<AccessPairingCard> createState() => _AccessPairingCardState();
}

class _AccessPairingCardState extends State<AccessPairingCard> {
  late final AccessAuthApi _api = widget.api ?? AccessAuthApi();
  final TextEditingController _pairingCodeCtrl = TextEditingController();
  final TextEditingController _emailCodeCtrl = TextEditingController();

  AccessAuthStatus? _status;
  List<AccessDevice> _devices = const <AccessDevice>[];

  /// 本机代签出来的配对码（给另一台设备输入用）。
  String? _issuedCode;

  /// 邮箱所有权验证码已发出（才显示验证码输入框）。
  bool _otpSent = false;
  bool _busy = false;
  String? _message;
  bool _messageIsError = false;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _pairingCodeCtrl.dispose();
    _emailCodeCtrl.dispose();
    super.dispose();
  }

  /// 登录邮箱（编译期 USER_ID / sessionId 形态不是邮箱，走不了自证通道）。
  String get _email => ApiConfig.runtimeUserId ?? "";
  bool get _isBound => AccessCredentialStore.instance.hasCredentials;

  Future<void> _refresh() async {
    final AccessAuthResult<AccessAuthStatus> st = await _api.status();
    if (!mounted) return;
    setState(() => _status = st.ok ? st.value : null);
    if (!_isBound) {
      setState(() => _devices = const <AccessDevice>[]);
      return;
    }
    final AccessAuthResult<List<AccessDevice>> dev = await _api.listDevices();
    if (!mounted) return;
    setState(() => _devices = dev.ok ? (dev.value ?? const <AccessDevice>[]) : const <AccessDevice>[]);
  }

  void _say(String text, {bool isError = false}) {
    if (!mounted) return;
    setState(() {
      _message = text;
      _messageIsError = isError;
    });
  }

  Future<T> _guard<T>(Future<T> Function() run) async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      return await run();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 配对码 → 本机 token（另一台设备生成的码输入这里）。
  Future<void> _bindWithPairingCode() async {
    final String code = _pairingCodeCtrl.text.trim();
    if (code.isEmpty) {
      _say("请先输入配对码", isError: true);
      return;
    }
    await _guard(() async {
      final AccessAuthResult<AccessDeviceBinding> res = await _api.bind(code: code);
      if (!res.ok) {
        _say(res.error ?? "配对失败", isError: true);
        return;
      }
      await AccessCredentialStore.instance.save(res.value!);
      _pairingCodeCtrl.clear();
      _say("配对成功：HTTP 已带上凭据，长连接重连后生效");
      await _refresh();
    });
  }

  /// 服务端尚无绑定设备（或还没开鉴权）→ 不需要任何证明，本机直接领凭据。
  Future<void> _bindDirectly() async {
    await _guard(() async {
      final AccessAuthResult<String> issued = await _api.issuePairingCode();
      if (!issued.ok) {
        _say(issued.error ?? "无法获取配对码", isError: true);
        return;
      }
      final AccessAuthResult<AccessDeviceBinding> res =
          await _api.bind(code: issued.value!);
      if (!res.ok) {
        _say(res.error ?? "配对失败", isError: true);
        return;
      }
      await AccessCredentialStore.instance.save(res.value!);
      _say("配对成功：HTTP 已带上凭据，长连接重连后生效");
      await _refresh();
    });
  }

  Future<void> _sendEmailOtp() async {
    await _guard(() async {
      final AccessAuthResult<void> res = await _api.startEmailOtp(email: _email);
      if (!res.ok) {
        _say(res.error ?? "验证码发送失败", isError: true);
        return;
      }
      setState(() => _otpSent = true);
      _say("验证码已发到 $_email（10 分钟内有效）");
    });
  }

  /// 新设备自证：邮箱验证码换配对码，再用配对码绑本机。
  Future<void> _bindWithEmailCode() async {
    final String code = _emailCodeCtrl.text.trim();
    if (code.isEmpty) {
      _say("请输入邮箱里的 6 位验证码", isError: true);
      return;
    }
    await _guard(() async {
      final AccessAuthResult<String> issued = await _api.issuePairingCode(
        emailCode: code,
        userId: _email,
      );
      if (!issued.ok) {
        _say(issued.error ?? "邮箱验证未通过", isError: true);
        return;
      }
      final AccessAuthResult<AccessDeviceBinding> res =
          await _api.bind(code: issued.value!);
      if (!res.ok) {
        _say(res.error ?? "配对失败", isError: true);
        return;
      }
      await AccessCredentialStore.instance.save(res.value!);
      _emailCodeCtrl.clear();
      setState(() {
        _otpSent = false;
        _issuedCode = null;
      });
      _say("配对成功：HTTP 已带上凭据，长连接重连后生效");
      await _refresh();
    });
  }

  Future<void> _issueForOtherDevice() async {
    await _guard(() async {
      final AccessAuthResult<String> res = await _api.issuePairingCode();
      if (!res.ok) {
        _say(res.error ?? "生成配对码失败", isError: true);
        return;
      }
      setState(() => _issuedCode = res.value);
      _say("在另一台设备的「设备配对」里输入上面这码");
    });
  }

  Future<void> _revoke(AccessDevice device) async {
    final bool isLocal =
        device.tokenId == AccessCredentialStore.instance.tokenId;
    await _guard(() async {
      final AccessAuthResult<void> res = await _api.revoke(device.tokenId);
      if (!res.ok) {
        _say(res.error ?? "吊销失败", isError: true);
        return;
      }
      if (isLocal) {
        await AccessCredentialStore.instance.clear();
        setState(() {
          _devices = const <AccessDevice>[];
          _issuedCode = null;
        });
        _say("本机已解绑，重启后不再带凭据");
      } else {
        _say("已吊销：${device.deviceLabel}");
      }
      await _refresh();
    });
  }

  Future<void> _unbindLocal() async {
    final String? tokenId = AccessCredentialStore.instance.tokenId;
    if (tokenId == null) {
      await AccessCredentialStore.instance.clear();
      _say("本机凭据已清除（服务端未登记编号，无法远程吊销）");
      return;
    }
    await _revoke(
      AccessDevice(
        tokenId: tokenId,
        deviceId: AccessCredentialStore.instance.deviceId,
        deviceLabel: "本机",
        lastSeenAt: 0,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Card(
      margin: widget.margin ?? EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.key_outlined, size: 18),
                const SizedBox(width: 8),
                Text("设备配对", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text(
                  _isBound ? "已配对" : "未配对",
                  style: TextStyle(
                    fontSize: 12,
                    color: _isBound ? cs.primary : cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(_serverLine, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 14),
            if (_isBound) ...<Widget>[
              _buildBoundBody(cs),
            ] else ...<Widget>[
              _buildUnboundBody(cs),
            ],
            if (_message != null) ...<Widget>[
              const SizedBox(height: 10),
              Text(
                _message!,
                style: TextStyle(
                  fontSize: 12,
                  color: _messageIsError ? cs.error : cs.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 服务端那一头的真实状态（开闸与否 / 是否已有设备），不猜、不粉饰。
  String get _serverLine {
    final AccessAuthStatus? st = _status;
    if (st == null) return "正在读取云端鉴权状态…";
    if (!st.authRequired) {
      return "云端暂未开启访问鉴权。现在配对，开闸后这台设备不会掉线。";
    }
    if (!st.bound) {
      return "云端已开启访问鉴权，且还没有任何设备绑定 —— 这台就是首台。";
    }
    return "云端已开启访问鉴权，凭据随每个请求自动附带。";
  }

  Widget _buildBoundBody(ColorScheme cs) {
    final String userId = AccessCredentialStore.instance.userId ?? "";
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text("已配对账号：$userId", style: const TextStyle(fontSize: 12.5)),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            FilledButton(
              onPressed: _busy ? null : _issueForOtherDevice,
              child: const Text(
                "为其他设备生成配对码",
                style: TextStyle(fontSize: 13),
              ),
            ),
            const SizedBox(width: 10),
            OutlinedButton(
              onPressed: _busy ? null : _unbindLocal,
              child: Text(
                "解绑本机",
                style: TextStyle(fontSize: 13, color: cs.error),
              ),
            ),
          ],
        ),
        if (_issuedCode != null) ...<Widget>[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: <Widget>[
                SelectableText(
                  _issuedCode!,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 6,
                    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                  ),
                ),
                const SizedBox(width: 12),
                const Expanded(
                  child: Text(
                    "10 分钟内有效，只用一次",
                    style: TextStyle(fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        ],
        if (_devices.isNotEmpty) ...<Widget>[
          const SizedBox(height: 14),
          const Text(
            "已配对设备",
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          for (final AccessDevice d in _devices) _deviceRow(cs, d),
        ],
      ],
    );
  }

  Widget _deviceRow(ColorScheme cs, AccessDevice d) {
    final bool isLocal = d.tokenId == AccessCredentialStore.instance.tokenId;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: <Widget>[
          Icon(
            isLocal ? Icons.laptop_mac : Icons.devices_other,
            size: 15,
            color: cs.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              "${d.deviceLabel} · 最近使用 ${_formatSeen(d.lastSeenAt)}",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5),
            ),
          ),
          if (isLocal)
            Text(
              "本机",
              style: TextStyle(fontSize: 12, color: cs.primary),
            )
          else
            TextButton(
              onPressed: _busy ? null : () => _revoke(d),
              child: const Text("吊销", style: TextStyle(fontSize: 12)),
            ),
        ],
      ),
    );
  }

  Widget _buildUnboundBody(ColorScheme cs) {
    // 首台设备（或还没开闸）不需要任何证明；已有别的设备时必须自证或输入配对码。
    final AccessAuthStatus? st = _status;
    final bool canBindDirectly = st != null && (!st.authRequired || !st.bound);
    final bool hasEmail = _email.contains("@");
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (canBindDirectly) ...<Widget>[
          FilledButton(
            onPressed: _busy ? null : _bindDirectly,
            child: const Text("配对本机", style: TextStyle(fontSize: 13)),
          ),
          const SizedBox(height: 14),
        ],
        Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _pairingCodeCtrl,
                textCapitalization: TextCapitalization.characters,
                maxLength: 6,
                style: const TextStyle(
                  fontSize: 14,
                  letterSpacing: 3,
                  fontWeight: FontWeight.w600,
                ),
                decoration: const InputDecoration(
                  labelText: "配对码",
                  hintText: "另一台设备生成的 6 位码",
                  counterText: "",
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: 10),
            FilledButton(
              onPressed: _busy ? null : _bindWithPairingCode,
              child: const Text("配对", style: TextStyle(fontSize: 13)),
            ),
          ],
        ),
        if (hasEmail) ...<Widget>[
          const SizedBox(height: 10),
          if (!_otpSent)
            TextButton.icon(
              onPressed: _busy ? null : _sendEmailOtp,
              icon: const Icon(Icons.mark_email_unread_outlined, size: 16),
              label: Text("没有配对码？验证码发到我邮箱（$_email）",
                  style: const TextStyle(fontSize: 12.5)),
            )
          else
            Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: _emailCodeCtrl,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    style: const TextStyle(fontSize: 14, letterSpacing: 2),
                    decoration: const InputDecoration(
                      labelText: "邮箱验证码",
                      counterText: "",
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: _busy ? null : _bindWithEmailCode,
                  child: const Text("配对本机", style: TextStyle(fontSize: 13)),
                ),
              ],
            ),
        ] else
          Text(
            "当前登录身份不是邮箱，只能输入另一台设备生成的配对码。",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
      ],
    );
  }

  static String _formatSeen(double epochMs) {
    if (epochMs <= 0) return "—";
    final DateTime t =
        DateTime.fromMillisecondsSinceEpoch(epochMs.round()).toLocal();
    String two(int v) => v.toString().padLeft(2, "0");
    return "${t.month}-${t.day} ${two(t.hour)}:${two(t.minute)}";
  }
}
