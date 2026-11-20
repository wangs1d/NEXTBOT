import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../../core/services/access_auth_api.dart";

/// 「设备配对」卡：已配对状态的展示与本机凭据（设备 token）的解绑。
///
/// 服务端开周界鉴权（ACCESS_AUTH_REQUIRED=1）后，每台设备必须先配对才取得到
/// 自己的数据；凭据只落本机文件，服务端只存 sha256 哈希、永不回吐明文。
///
/// 产品形态上配对不在手机端发起：本卡只呈现「已配对」面板——绑定账号、
/// 为其他设备代签一次性配对码、已配对设备列表（可吊销）、解绑本机；
/// 未配对时只给一行状态说明，不提供任何配对流程入口。
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

  AccessAuthStatus? _status;
  List<AccessDevice> _devices = const <AccessDevice>[];

  /// 本机代签出来的配对码（给另一台设备输入用）。
  String? _issuedCode;

  bool _busy = false;
  String? _message;
  bool _messageIsError = false;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

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

  Future<void> _issueForOtherDevice() async {
    await _guard(() async {
      final AccessAuthResult<String> res = await _api.issuePairingCode();
      if (!res.ok) {
        _say(res.error ?? "生成配对码失败", isError: true);
        return;
      }
      setState(() => _issuedCode = res.value);
      _say("配对码已生成，在另一台设备输入即可");
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

  // ─────────────────────────────────────────────
  // 构建
  // ─────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool bound = _isBound;
    return Card(
      margin: widget.margin ?? EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _buildHeader(cs, bound),
            const SizedBox(height: 12),
            _buildStatusLine(cs),
            const SizedBox(height: 18),
            if (bound) _buildBoundBody(cs) else _buildUnboundHint(cs),
            if (_message != null) ...<Widget>[
              const SizedBox(height: 14),
              _messageBanner(cs),
            ],
          ],
        ),
      ),
    );
  }

  /// 头部：图标 + 标题 + 状态角标（形状 + 文字双通道，不只靠颜色表意）。
  Widget _buildHeader(ColorScheme cs, bool bound) {
    return Row(
      children: <Widget>[
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: cs.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Icon(
            bound ? Icons.link_rounded : Icons.link_off_rounded,
            size: 18,
            color: cs.onSurfaceVariant,
          ),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("设备配对",
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface)),
              const SizedBox(height: 2),
              Text(bound ? "这台设备已接入" : "让这台设备访问你的 NEXTBOT",
                  style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant)),
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            color: bound ? cs.primary : cs.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: bound ? cs.onPrimary : cs.onSurfaceVariant,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 5),
              Text(bound ? "已配对" : "未配对",
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: bound ? cs.onPrimary : cs.onSurfaceVariant)),
            ],
          ),
        ),
      ],
    );
  }

  /// 一行说清服务端状态：开没开鉴权 / 是不是首台。不粉饰、不堆术语。
  Widget _buildStatusLine(ColorScheme cs) {
    final AccessAuthStatus? st = _status;
    late final IconData icon;
    late final String text;
    if (st == null) {
      icon = Icons.sync_rounded;
      text = "正在读取云端鉴权状态…";
    } else if (!st.authRequired) {
      icon = Icons.info_outline;
      text = "云端暂未开启访问鉴权 · 现在配对，开闸后不会掉线";
    } else if (!st.bound) {
      icon = Icons.rocket_launch_outlined;
      text = "云端已开启鉴权 · 这台设备将成为首台";
    } else if (!_isBound) {
      icon = Icons.lock_outline;
      text = "云端已开启鉴权且已有设备 · 配对后这台才能访问";
    } else {
      icon = Icons.verified_outlined;
      text = "凭据随每个请求自动附带，无需手动操作";
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 14, color: cs.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text,
                style: TextStyle(
                    fontSize: 11.5, color: cs.onSurfaceVariant, height: 1.4)),
          ),
        ],
      ),
    );
  }

  /// 未配对：不提供任何配对流程入口，只给一行状态说明。
  Widget _buildUnboundHint(ColorScheme cs) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        "这台设备尚未配对 · 在已配对的设备上完成配对后，这里会显示接入状态",
        style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant, height: 1.5),
      ),
    );
  }

  /// 已配对：主操作是「发配对码给新设备」，设备列表可管理，解绑沉到底部。
  Widget _buildBoundBody(ColorScheme cs) {
    final String userId = AccessCredentialStore.instance.userId ?? "";
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(Icons.account_circle_outlined,
                size: 15, color: cs.onSurfaceVariant),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                  userId.isEmpty ? "本机凭据已就绪" : "已绑定账号 $userId",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
            ),
          ],
        ),
        const SizedBox(height: 18),
        _stepHeader(
            cs, "", "配对新设备", "生成一次性配对码，在另一台设备输入"),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          height: 44,
          child: FilledButton.icon(
            onPressed: _busy ? null : _issueForOtherDevice,
            icon: const Icon(Icons.qr_code_2_outlined, size: 16),
            label: const Text("生成配对码",
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          ),
        ),
        if (_issuedCode != null) ...<Widget>[
          const SizedBox(height: 12),
          _issuedCodePanel(cs),
        ],
        if (_devices.isNotEmpty) ...<Widget>[
          const SizedBox(height: 20),
          _stepHeader(cs, "", "已配对设备（${_devices.length}）",
              "不再使用的设备可以从这里吊销"),
          const SizedBox(height: 6),
          for (final AccessDevice d in _devices) _deviceRow(cs, d),
        ],
        const SizedBox(height: 18),
        Divider(height: 1, color: cs.outlineVariant),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _busy ? null : _unbindLocal,
            icon: Icon(Icons.link_off_rounded, size: 15, color: cs.error),
            label: Text("解绑本机",
                style: TextStyle(fontSize: 12, color: cs.error)),
          ),
        ),
      ],
    );
  }

  /// 配对码：大号等宽 + 一键复制，10 分钟一次性。
  Widget _issuedCodePanel(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text("配对码",
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
              const Spacer(),
              IconButton(
                onPressed: () {
                  unawaited(Clipboard.setData(ClipboardData(text: _issuedCode!)));
                  _say("配对码已复制");
                },
                icon: const Icon(Icons.copy_all_outlined, size: 16),
                tooltip: "复制配对码",
                constraints:
                    const BoxConstraints(minWidth: 36, minHeight: 36),
                padding: EdgeInsets.zero,
                color: cs.onSurfaceVariant,
              ),
            ],
          ),
          SelectableText(
            _issuedCode!,
            style: TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w700,
              letterSpacing: 7,
              color: cs.onSurface,
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              Icon(Icons.schedule, size: 12, color: cs.onSurfaceVariant),
              const SizedBox(width: 5),
              Text("10 分钟内有效 · 仅可使用一次",
                  style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _deviceRow(ColorScheme cs, AccessDevice d) {
    final bool isLocal = d.tokenId == AccessCredentialStore.instance.tokenId;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.6)),
        ),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(Icons.devices_rounded,
                size: 16, color: cs.onSurfaceVariant),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(d.deviceLabel.isEmpty ? "未命名设备" : d.deviceLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500,
                        color: cs.onSurface)),
                const SizedBox(height: 2),
                Text("最近使用 ${_formatSeen(d.lastSeenAt)}",
                    style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
              ],
            ),
          ),
          if (isLocal)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text("本机",
                  style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant)),
            )
          else
            TextButton(
              onPressed: _busy ? null : () => _revoke(d),
              child: Text("吊销", style: TextStyle(fontSize: 12, color: cs.error)),
            ),
        ],
      ),
    );
  }

  /// 步骤小标题：序号圆点 + 标题 + 说明。
  Widget _stepHeader(ColorScheme cs, String step, String title, String subtitle) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (step.isNotEmpty) ...<Widget>[
          Container(
            width: 19,
            height: 19,
            decoration: BoxDecoration(color: cs.primary, shape: BoxShape.circle),
            alignment: Alignment.center,
            child: Text(step,
                style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: cs.onPrimary)),
          ),
          const SizedBox(width: 9),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(title,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface)),
              const SizedBox(height: 2),
              Text(subtitle,
                  style: TextStyle(
                      fontSize: 11.5, color: cs.onSurfaceVariant, height: 1.4)),
            ],
          ),
        ),
      ],
    );
  }

  /// 结果提示：带图标的提示条，错误/成功双态。
  Widget _messageBanner(ColorScheme cs) {
    final bool err = _messageIsError;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: err ? cs.errorContainer : cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(
            err ? Icons.error_outline : Icons.check_circle_outline,
            size: 14,
            color: err ? cs.error : cs.primary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(_message!,
                style: TextStyle(
                    fontSize: 11.5,
                    height: 1.5,
                    color: err ? cs.error : cs.onSurfaceVariant)),
          ),
        ],
      ),
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
