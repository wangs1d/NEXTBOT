import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../core/services/recharge_api.dart";
import "mobile_theme.dart";

/// 手机端「额度充值」页。
///
/// 与官网充值页的区别：这里直接用 App 已登录的 access token 调
/// `/api/recharge/app/*`，不再跳浏览器重新做邮箱验证码登录；金额选择、
/// 余额展示、支付结果轮询都在 App 内完成，只有最后一步支付宝付款交给
/// 系统浏览器/支付宝 App（复用同一套 webpay 下单与记账服务）。
class MobileRechargePage extends StatefulWidget {
  const MobileRechargePage({super.key, this.api});

  /// 测试注入；默认走真实服务端。
  final RechargeApi? api;

  @override
  State<MobileRechargePage> createState() => _MobileRechargePageState();
}

class _MobileRechargePageState extends State<MobileRechargePage>
    with WidgetsBindingObserver {
  late final RechargeApi _api = widget.api ?? RechargeApi();
  final TextEditingController _customController = TextEditingController();

  static const List<int> _presets = <int>[10, 20, 50, 100, 300, 500];

  RechargeAccount? _account;
  bool _loading = true;
  String? _loadError;

  int? _selectedPreset = 100;
  bool _customSelected = false;

  bool _submitting = false;
  bool _waiting = false;
  bool _paid = false;
  String? _orderNo;
  String? _payMessage;
  Timer? _pollTimer;
  int _pollTries = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadAccount());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stopPolling();
    _customController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从支付宝/浏览器返回 App：立刻查一次，不必等下一个轮询周期。
    if (state == AppLifecycleState.resumed && _waiting) {
      unawaited(_pollOnce());
    }
  }

  Future<void> _loadAccount({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _loadError = null;
      });
    }
    final RechargeResult<RechargeAccount> r = await _api.fetchAccount();
    if (!mounted) return;
    setState(() {
      if (r.ok && r.data != null) {
        _account = r.data;
        _loadError = null;
      } else if (!silent) {
        _loadError = r.message ?? "额度余额加载失败";
      }
      if (!silent) _loading = false;
    });
  }

  /// 当前充值金额（输入框原样字符串，交给服务端做定点校验）。
  String get _amount =>
      _customSelected ? _customController.text.trim() : "${_selectedPreset ?? 100}";

  bool get _amountValid {
    if (!RegExp(r"^\d+(\.\d{1,2})?$").hasMatch(_amount)) return false;
    final double? value = double.tryParse(_amount);
    return value != null && value >= 1 && value <= 100000;
  }

  String get _amountLabel {
    final double? value = double.tryParse(_amount);
    return value == null ? "0.00" : value.toStringAsFixed(2);
  }

  bool get _canPay =>
      !_loading &&
      _loadError == null &&
      !_submitting &&
      !_waiting &&
      _amountValid;

  void _selectPreset(int value) {
    setState(() {
      _customSelected = false;
      _selectedPreset = value;
      _payMessage = null;
    });
  }

  void _selectCustom() {
    setState(() {
      _customSelected = true;
      _payMessage = null;
    });
  }

  Future<void> _pay() async {
    if (!_canPay) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _submitting = true;
      _paid = false;
      _payMessage = null;
    });

    final RechargeResult<RechargeOrder> r = await _api.createOrder(_amount);
    if (!mounted) return;
    if (!r.ok || r.data == null) {
      setState(() {
        _submitting = false;
        _payMessage = r.message ?? "下单失败，请稍后重试";
      });
      return;
    }

    final RechargeOrder order = r.data!;
    final String? url = order.paymentUrl;
    if (url == null || url.isEmpty) {
      setState(() {
        _submitting = false;
        _payMessage = "支付通道暂不可用，请稍后重试";
      });
      return;
    }

    bool opened = false;
    try {
      final Uri? uri = Uri.tryParse(url);
      if (uri != null) {
        opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      opened = false;
    }
    if (!mounted) return;
    if (!opened) {
      setState(() {
        _submitting = false;
        _payMessage = "无法打开支付宝，请稍后重试";
      });
      return;
    }

    setState(() {
      _submitting = false;
      _waiting = true;
      _orderNo = order.outTradeNo;
      _payMessage = "已打开支付宝，支付完成后额度自动到账";
    });
    _startPolling();
  }

  void _startPolling() {
    _stopPolling();
    _pollTries = 0;
    _pollTimer = Timer.periodic(
      const Duration(seconds: 4),
      (_) => unawaited(_pollOnce()),
    );
    unawaited(_pollOnce());
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _pollOnce() async {
    final String? outTradeNo = _orderNo;
    if (outTradeNo == null || !_waiting) return;
    final RechargeResult<RechargeOrderStatus> r =
        await _api.fetchOrder(outTradeNo);
    if (!mounted || !_waiting) return;

    if (!r.ok || r.data == null) {
      if ((r.message ?? "").contains("登录已失效")) {
        _stopPolling();
        setState(() {
          _waiting = false;
          _payMessage = r.message;
        });
      }
      return;
    }

    final RechargeOrderStatus status = r.data!;
    if (status.status == "paid") {
      _stopPolling();
      setState(() {
        _waiting = false;
        _paid = true;
        _payMessage = "支付成功，额度已到账";
      });
      unawaited(_loadAccount(silent: true));
      return;
    }
    if (status.status == "closed") {
      _stopPolling();
      setState(() {
        _waiting = false;
        _payMessage = "订单已关闭，请重新发起充值";
      });
      return;
    }

    _pollTries += 1;
    if (_pollTries >= 60) {
      _stopPolling();
      setState(() {
        _waiting = false;
        _payMessage = "支付结果确认中，可稍后重新进入本页查看余额";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return ListView(
      padding: EdgeInsets.fromLTRB(
        16,
        12,
        16,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      children: <Widget>[
        _balanceCard(p),
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 48),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_loadError != null)
          _errorBlock(p)
        else ...<Widget>[
          const SizedBox(height: 20),
          _SectionLabel(text: "选择金额"),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: <Widget>[
              for (final int value in _presets)
                _AmountChip(
                  label: "¥$value",
                  selected: !_customSelected && _selectedPreset == value,
                  onTap: () => _selectPreset(value),
                ),
              _AmountChip(
                label: "自定义",
                selected: _customSelected,
                onTap: _selectCustom,
              ),
            ],
          ),
          if (_customSelected)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: TextField(
                controller: _customController,
                autofocus: true,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  prefixText: "¥ ",
                  hintText: "输入金额，1 ~ 100000",
                  filled: true,
                  fillColor: p.surface,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide(color: p.divider),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide(color: p.divider),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 20),
          _SectionLabel(text: "支付方式"),
          _methodCard(p),
          const SizedBox(height: 22),
          SizedBox(
            height: 52,
            child: FilledButton(
              onPressed: _canPay ? _pay : null,
              style: FilledButton.styleFrom(
                backgroundColor: p.accent,
                foregroundColor: p.onAccent,
                disabledBackgroundColor: p.divider,
                disabledForegroundColor: p.textMuted,
                shape: const StadiumBorder(),
                textStyle: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
              child: _submitting
                  ? SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: p.onAccent,
                      ),
                    )
                  : Text("立即支付 ¥$_amountLabel"),
            ),
          ),
          if (_waiting) _waitingCard(p),
          if (_payMessage != null) _message(p),
          const SizedBox(height: 14),
          Text(
            "支付在支付宝完成，成功后额度自动到账。未安装支付宝时，可在收银台选择浏览器付款。",
            textAlign: TextAlign.center,
            style: TextStyle(color: p.textMuted, fontSize: 12, height: 1.6),
          ),
        ],
      ],
    );
  }

  Widget _balanceCard(MobilePalette p) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                "当前额度",
                style: TextStyle(color: p.textSecondary, fontSize: 13),
              ),
              const Spacer(),
              Text(
                _account?.masked ?? "",
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            "¥${_account?.balance ?? "0.00"}",
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 28,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            "按量扣费 · 余额不过期 · 无需订阅",
            style: TextStyle(color: p.textMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _methodCard(MobilePalette p) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xFF1677FF),
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Text(
              "支",
              style: TextStyle(
                color: Colors.white,
                fontSize: 17,
                fontWeight: FontWeight.w700,
                height: 1,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  "支付宝",
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  "ALIPAY",
                  style: TextStyle(
                    color: p.textMuted,
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.6,
                  ),
                ),
              ],
            ),
          ),
          const Icon(Icons.check_circle, size: 20, color: Color(0xFF34C759)),
        ],
      ),
    );
  }

  Widget _waitingCard(MobilePalette p) {
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: <Widget>[
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              "等待支付结果…",
              style: TextStyle(color: p.textSecondary, fontSize: 13),
            ),
          ),
          TextButton(
            onPressed: () => unawaited(_pollOnce()),
            child: const Text("我已完成支付"),
          ),
        ],
      ),
    );
  }

  Widget _message(MobilePalette p) {
    final bool success = _paid;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Text(
        _payMessage ?? "",
        textAlign: TextAlign.center,
        style: TextStyle(
          color: success ? const Color(0xFF34C759) : p.textSecondary,
          fontSize: 13,
          height: 1.5,
        ),
      ),
    );
  }

  Widget _errorBlock(MobilePalette p) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40),
      child: Column(
        children: <Widget>[
          Text(
            _loadError ?? "加载失败",
            textAlign: TextAlign.center,
            style: TextStyle(color: p.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 14),
          OutlinedButton(
            onPressed: () => unawaited(_loadAccount()),
            child: const Text("重试"),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 0, 2, 10),
      child: Text(
        text,
        style: TextStyle(
          color: p.textSecondary,
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _AmountChip extends StatelessWidget {
  const _AmountChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? p.accent : p.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: selected ? p.accent : p.divider),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? p.onAccent : p.textPrimary,
            fontSize: 14,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }
}
