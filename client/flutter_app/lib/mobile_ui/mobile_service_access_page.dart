import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:url_launcher/url_launcher.dart";

import "../core/config/api_config.dart";
import "../core/services/access_auth_api.dart";
import "../core/services/cloud_model_binding_store.dart";
import "../core/services/model_api_tester.dart";
import "../features/settings/access_pairing_card.dart";
import "mobile_theme.dart";

/// 手机端「服务接入」页（内测 byok）。
///
/// 服务端不代充模型/语音额度：用户在此自行填 API Key。单机形态经
/// PUT /api/service-config 持久化到服务端（非密钥字段进 data/service-config.json，
/// 密钥进加密仓）并即时热生效（主对话 provider 热替换、TTS 客户端按密钥重建，无需重启）；
/// 云端多租户形态（GET 回 mode=session-byok）由本机保存三元组、随 WebSocket
/// session.init 上送，服务端按用户加密落盘一份（离线期间的主动轮次要用用户自己的 key）。
/// 服务端从不下发完整密钥：GET 只回脱敏尾号，输入框不回填旧值——留空即沿用已存密钥，
/// 要换就重新填一次（状态角标带尾号，如 ****ab12）。
///
/// - 模型服务：从 /api/model-providers 目录选服务商（自动带出网关/默认模型），
///   或选「自定义」手填 OpenAI 兼容网关地址 + 模型名 + API Key
/// - 语音合成（TTS）：MiniMax（独立 Key）或 OpenAI（复用模型服务 Key），
///   保存后可点「试听测试」真实合成一小段语音验证连通性
/// - 邮箱盯梢：登录邮箱已自动接入，只需填一次 IMAP 授权码即可开始盯邮件
class MobileServiceAccessPage extends StatefulWidget {
  const MobileServiceAccessPage({super.key});

  @override
  State<MobileServiceAccessPage> createState() =>
      _MobileServiceAccessPageState();
}

class _MobileServiceAccessPageState extends State<MobileServiceAccessPage> {
  final TextEditingController _baseUrl = TextEditingController();
  final TextEditingController _model = TextEditingController();
  final TextEditingController _apiKey = TextEditingController();
  final TextEditingController _ttsApiKey = TextEditingController();
  final TextEditingController _mailPass = TextEditingController();

  bool _loading = true;
  String? _error;

  /// 服务商目录（GET /api/model-providers；加载失败时仍可手填自定义）。
  List<Map<String, dynamic>> _providers = const <Map<String, dynamic>>[];

  /// 当前选中的服务商 id（目录 id 或 "custom"）。
  String _providerId = "custom";

  /// TTS 提供商（minimax=独立 Key / openai=复用模型服务 Key）。
  String _ttsProvider = "minimax";

  /// 已配置状态（GET /api/service-config 回显；密钥只含尾号，授权码连尾号都不回）。
  bool _modelConfigured = false;
  String? _modelKeyTail;
  String? _ttsKeyTail;
  bool _ttsConfigured = false;
  bool _mailConfigured = false;

  /// 云端多租户模式（mode=session-byok）：模型 Key 只存本机、随连接上送，
  /// 服务端不接受全站写入（PUT 返回 409），表单以本机 CloudModelBindingStore 为准。
  bool _sessionByok = false;

  bool _savingModel = false;
  bool _savingTts = false;
  bool _testingTts = false;
  bool _savingMail = false;
  String? _modelMessage;
  bool _modelMessageError = false;
  String? _ttsMessage;
  bool _ttsMessageError = false;
  String? _mailMessage;
  bool _mailMessageError = false;

  /// 邮箱盯梢状态（GET /api/mail-watch/status：登录邮箱自动接入的账号 + 轮询态）。
  bool _mailRunning = false;
  String _mailUser = "";
  String _mailReason = "";
  bool _obscureMailPass = true;
  bool _obscureModelKey = true;
  bool _obscureTtsKey = true;

  /// 信息源树枝（GET /api/proactivity/branches；树状可插拔架构 Phase 3 配置面）。
  List<Map<String, dynamic>> _branches = const <Map<String, dynamic>>[];
  bool _branchesLoading = false;
  String? _branchMessage;
  bool _branchMessageError = false;

  /// 盯梢任务（GET /api/proactivity/watch-tasks；Muse 对齐件的任务面板）。
  List<Map<String, dynamic>> _watchTasks = const <Map<String, dynamic>>[];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadBranches());
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _model.dispose();
    _apiKey.dispose();
    _ttsApiKey.dispose();
    _mailPass.dispose();
    super.dispose();
  }

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 带登录主体的服务配置地址：邮箱/密钥状态按 actor 隔离，未开周界鉴权（单机装机）
  /// 时这个 query 就是服务端唯一的身份来源。
  Uri _authed(String path) => Uri.parse("${ApiConfig.httpBase}$path")
      .replace(queryParameters: ApiConfig.accountAuthQuery);

  /// 脱敏尾号（与状态角标口径一致：**** + 末 4 位）。
  static String _tailOf(String key) =>
      "****${key.length > 4 ? key.substring(key.length - 4) : key}";

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await CloudModelBindingStore.instance.load();
      final http.Client client = http.Client();
      final List<http.Response> responses =
          await Future.wait(<Future<http.Response>>[
        client
            .get(_authed("/api/service-config"),
                headers: AccessCredentialStore.instance.authHeaders)
            .timeout(const Duration(seconds: 15)),
        client
            .get(Uri.parse("${ApiConfig.httpBase}/api/model-providers"),
                headers: AccessCredentialStore.instance.authHeaders)
            .timeout(const Duration(seconds: 15)),
        client
            .get(_authed("/api/mail-watch/status"),
                headers: AccessCredentialStore.instance.authHeaders)
            .timeout(const Duration(seconds: 15)),
      ]);
      client.close();

      final Map<String, dynamic> cfg =
          jsonDecode(responses[0].body) as Map<String, dynamic>;
      if (cfg["ok"] != true) {
        throw Exception(cfg["error"]?.toString() ?? "读取服务配置失败");
      }
      final Map<String, dynamic> modelBlock =
          (cfg["model"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      final Map<String, dynamic> ttsBlock =
          (cfg["tts"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      final Map<String, dynamic> mailBlock =
          (cfg["mail"] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      Map<String, dynamic> mailStatus = const <String, dynamic>{};
      if (responses[2].statusCode == 200) {
        final Map<String, dynamic> parsed =
            jsonDecode(responses[2].body) as Map<String, dynamic>;
        mailStatus = (parsed["status"] as Map<String, dynamic>?) ??
            const <String, dynamic>{};
      }

      List<Map<String, dynamic>> providers = const <Map<String, dynamic>>[];
      if (responses[1].statusCode == 200) {
        final Map<String, dynamic> catalog =
            jsonDecode(responses[1].body) as Map<String, dynamic>;
        providers =
            ((catalog["providers"] as List<dynamic>?) ?? const <dynamic>[])
                .whereType<Map<String, dynamic>>()
                .toList();
      }

      if (!mounted) return;
      final bool sessionByok = cfg["mode"] == "session-byok";
      final CloudModelBindingStore binding = CloudModelBindingStore.instance;
      setState(() {
        _providers = providers;
        _sessionByok = sessionByok;
        _modelConfigured = modelBlock["configured"] == true;
        _modelKeyTail = modelBlock["keyTail"]?.toString();
        _ttsConfigured = ttsBlock["configured"] == true;
        _ttsKeyTail = ttsBlock["keyTail"]?.toString();
        _mailConfigured = mailBlock["configured"] == true;
        _mailRunning = mailStatus["running"] == true;
        _mailUser = mailStatus["user"]?.toString() ?? "";
        _mailReason = mailStatus["reason"]?.toString() ?? "";
        // 预填：服务端已配置 → 带出网关/模型；否则带目录首项（DeepSeek 兜底）
        if ((modelBlock["baseUrl"]?.toString() ?? "").isNotEmpty) {
          _baseUrl.text = modelBlock["baseUrl"].toString();
          _model.text = modelBlock["model"]?.toString() ?? "";
          _providerId = modelBlock["providerId"]?.toString() ?? "custom";
        } else {
          _applyProvider(providers.isNotEmpty
              ? providers.first["id"].toString()
              : "custom");
        }
        if ((ttsBlock["provider"]?.toString() ?? "").isNotEmpty) {
          _ttsProvider = ttsBlock["provider"].toString();
        }
        // 密钥不回传：输入框保持空，占位文案讲清「留空=沿用已存 ****尾号，填了才更换」
        // 云端多租户：模型三元组的唯一副本在本机，表单与角标都以本机为准
        if (sessionByok) {
          _modelConfigured = binding.isConfigured;
          _modelKeyTail =
              binding.isConfigured ? _tailOf(binding.apiKey!) : null;
          if (binding.isConfigured) {
            _baseUrl.text = binding.baseUrl ?? "";
            _model.text = binding.model ?? "";
            _apiKey.text = binding.apiKey ?? "";
          }
        }
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  /// 选中目录服务商：带出网关地址与默认模型（custom 不动用户手填内容）。
  void _applyProvider(String id) {
    _providerId = id;
    if (id == "custom") return;
    final Map<String, dynamic>? p = _providers
        .where((Map<String, dynamic> e) => e["id"]?.toString() == id)
        .firstOrNull;
    if (p == null) return;
    _baseUrl.text = p["baseUrl"]?.toString() ?? "";
    _model.text = p["defaultModel"]?.toString() ?? "";
  }

  Map<String, dynamic>? get _selectedProvider => _providers
      .where((Map<String, dynamic> e) => e["id"]?.toString() == _providerId)
      .firstOrNull;

  /// 保存模型服务：单机形态 PUT /api/service-config（服务端持久化并热生效）；
  /// 云端多租户形态只写本机，随 session.init 上送（apiKey 留空 = 沿用已存密钥）。
  Future<void> _saveModel() async {
    final String baseUrl = _baseUrl.text.trim();
    final String model = _model.text.trim();
    if (!baseUrl.startsWith("http")) {
      _setModelMessage("网关地址必须是 http(s) 地址", error: true);
      return;
    }
    if (_sessionByok && !baseUrl.startsWith("https://")) {
      _setModelMessage("云端接入地址必须 https（服务器拒收明文来源的 Key）", error: true);
      return;
    }
    if (model.isEmpty) {
      _setModelMessage("请填写模型名（如 deepseek-flash）", error: true);
      return;
    }
    if (_apiKey.text.trim().isEmpty && !_modelConfigured) {
      _setModelMessage("首次接入请填写 API Key（服务商控制台可申请）", error: true);
      return;
    }
    setState(() {
      _savingModel = true;
      _modelMessage = null;
    });
    if (_sessionByok) {
      final CloudModelBindingStore binding = CloudModelBindingStore.instance;
      final String key = _apiKey.text.trim().isNotEmpty
          ? _apiKey.text.trim()
          : (binding.apiKey ?? "");
      String? err;
      try {
        await binding.save(baseUrl: baseUrl, apiKey: key, model: model);
      } catch (e) {
        err = "保存本机配置失败：$e";
      }
      if (!mounted) return;
      setState(() {
        _savingModel = false;
        _modelConfigured = binding.isConfigured;
        _modelKeyTail = binding.isConfigured ? _tailOf(key) : null;
        _modelMessage = err ?? "已存本机，重连后生效（服务端按你的账号加密保存，离线提醒也用这把 key）";
        _modelMessageError = err != null;
      });
      return;
    }
    final String? err = await _putServiceConfig(<String, dynamic>{
      "model": <String, dynamic>{
        "providerId": _providerId,
        "baseUrl": baseUrl,
        "model": model,
        "apiKey": _apiKey.text.trim(),
      },
    });
    if (!mounted) return;
    final String typedKey = _apiKey.text.trim();
    setState(() {
      _savingModel = false;
      if (err == null) {
        _modelConfigured = true;
        // 填了新 key 就更新角标；留空沿用已存那份，尾号维持服务端报的
        if (typedKey.isNotEmpty) _modelKeyTail = _tailOf(typedKey);
        _modelMessage = "已保存并即时生效，直接开聊即可";
        _modelMessageError = false;
      } else {
        _modelMessage = err;
        _modelMessageError = true;
      }
    });
  }

  /// 保存 TTS：PUT /api/service-config（minimax 留空 = 沿用已存密钥）。
  Future<void> _saveTts() async {
    if (_ttsProvider == "minimax" &&
        _ttsApiKey.text.trim().isEmpty &&
        !_ttsConfigured) {
      _setTtsMessage("首次接入请填写 MiniMax API Key", error: true);
      return;
    }
    setState(() {
      _savingTts = true;
      _ttsMessage = null;
    });
    final String? err = await _putServiceConfig(<String, dynamic>{
      "tts": <String, dynamic>{
        "provider": _ttsProvider,
        "apiKey": _ttsApiKey.text.trim(),
      },
    });
    if (!mounted) return;
    final String typedTtsKey = _ttsApiKey.text.trim();
    setState(() {
      _savingTts = false;
      if (err == null) {
        _ttsConfigured = true;
        if (_ttsProvider == "minimax" && typedTtsKey.isNotEmpty) {
          _ttsKeyTail = _tailOf(typedTtsKey);
        }
        _ttsMessage = "已保存，语音回复即刻生效";
        _ttsMessageError = false;
      } else {
        _ttsMessage = err;
        _ttsMessageError = true;
      }
    });
  }

  /// 保存邮箱授权码：POST /api/mail-watch/pass（绑请求者自己那个账号）→ 服务端按人
  /// 加密落盘 + 即刻启动这一个邮箱的轮询（host/user 由登录邮箱域自动接入，无需手填
  /// 服务器）。授权码不再进 service-config.json，也不再写机器级 env：一份码只管一只邮箱。
  Future<void> _saveMail() async {
    final String pass = _mailPass.text.trim();
    if (pass.isEmpty) {
      _setMailMessage(
          _mailConfigured
              ? "已接入，没有改动；要换授权码请填新的"
              : "请填写 IMAP 授权码（邮箱网页版设置里生成，不是登录密码）",
          error: !_mailConfigured);
      return;
    }
    setState(() {
      _savingMail = true;
      _mailMessage = null;
    });
    final Map<String, dynamic> saved = await MailWatchApi.savePass(pass);
    if (!mounted) return;
    if (saved["ok"] != true) {
      setState(() {
        _savingMail = false;
        _mailMessage = saved["error"]?.toString() ?? "保存失败";
        _mailMessageError = true;
      });
      return;
    }
    _mailConfigured = true;
    await _refreshMailStatus();
    if (!mounted) return;
    final bool persisted = saved["persisted"] == true;
    setState(() {
      _savingMail = false;
      _mailMessage = _mailRunning
          ? (persisted
              ? "已接通，Agent 开始盯你的邮箱"
              : "已接通，但未持久化：服务端没配主密钥，授权码只在这次运行内有效，重启后需重填")
          : "已保存，但未启动：${_mailReason.isEmpty ? "未知原因" : _mailReason}";
      _mailMessageError = false;
    });
  }

  /// 邮箱盯梢运行态刷新（GET /api/mail-watch/status；保存后回转真实结果）。
  Future<void> _refreshMailStatus() async {
    final Map<String, dynamic> res = await MailWatchApi.status();
    if (!mounted) return;
    final Map<String, dynamic> st = res["status"] is Map
        ? res["status"] as Map<String, dynamic>
        : const <String, dynamic>{};
    setState(() {
      _mailRunning = st["running"] == true;
      _mailReason = st["reason"]?.toString() ?? "";
      final String user = st["user"]?.toString() ?? "";
      if (user.isNotEmpty) _mailUser = user;
    });
  }

  void _setMailMessage(String text, {required bool error}) {
    setState(() {
      _mailMessage = text;
      _mailMessageError = error;
    });
  }

  /// TTS 连通性测试：真实合成一小段语音（不落盘，仅验证密钥可用）。
  Future<void> _testTts() async {
    setState(() {
      _testingTts = true;
      _ttsMessage = null;
    });
    String? err;
    String okMsg = "测试通过：服务端已能合成语音";
    try {
      final http.Client client = http.Client();
      final http.Response res = await client
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/service-config/tts-test"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{"text": "NEXTBOT 语音服务连接测试"}),
          )
          .timeout(const Duration(seconds: 30));
      client.close();
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && body["ok"] == true) {
        okMsg = "测试通过（${body["provider"]}，${body["bytes"]} 字节音频）";
      } else {
        err = body["error"]?.toString() ?? "测试失败（HTTP ${res.statusCode}）";
      }
    } catch (e) {
      err = "测试请求失败：$e";
    }
    if (!mounted) return;
    setState(() {
      _testingTts = false;
      _ttsMessage = err ?? okMsg;
      _ttsMessageError = err != null;
    });
  }

  /// PUT /api/service-config；返回 null=成功，否则为错误信息。
  Future<String?> _putServiceConfig(Map<String, dynamic> payload) async {
    try {
      final http.Client client = http.Client();
      final http.Response res = await client
          .put(
            Uri.parse("${ApiConfig.httpBase}/api/service-config"),
            headers: _headers,
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 15));
      client.close();
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && body["ok"] == true) return null;
      return body["error"]?.toString() ?? "保存失败（HTTP ${res.statusCode}）";
    } catch (e) {
      return "保存请求失败：$e";
    }
  }

  void _setModelMessage(String text, {required bool error}) {
    setState(() {
      _modelMessage = text;
      _modelMessageError = error;
    });
  }

  void _setTtsMessage(String text, {required bool error}) {
    setState(() {
      _ttsMessage = text;
      _ttsMessageError = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("服务接入")),
      body: _buildBody(context, p),
    );
  }

  Widget _buildBody(BuildContext context, MobilePalette p) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
              const SizedBox(height: 12),
              Text(
                "服务状态获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
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
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
          child: Text(
            "内测期服务端不代充额度：模型、语音与邮箱都需要你自己接入一次。"
            "密钥只保存在服务器本机并按尾号回显，保存后即刻生效，无需重启。",
            style: TextStyle(color: p.textSecondary, fontSize: 13, height: 1.5),
          ),
        ),
        _buildModelCard(p),
        const SizedBox(height: 16),
        _buildTtsCard(p),
        const SizedBox(height: 16),
        _buildMailCard(p),
        const SizedBox(height: 16),
        const AccessPairingCard(
          margin: EdgeInsets.symmetric(horizontal: 16),
        ),
        const SizedBox(height: 16),
        _buildBranchesCard(p),
        const SizedBox(height: 24),
      ],
    );
  }

  // ═══════════════════════════════════════════════
  // 模型服务卡
  // ═══════════════════════════════════════════════

  Widget _buildModelCard(MobilePalette p) {
    final Map<String, dynamic>? provider = _selectedProvider;
    final String? consoleUrl = provider?["consoleUrl"]?.toString();
    return _card(
      p,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(Icons.memory_outlined, color: p.textSecondary, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: Text("模型服务",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
            ),
            _statusChip(p, _modelConfigured, _modelKeyTail),
          ],
        ),
        const SizedBox(height: 14),
        // 服务商快选（目录 + 自定义）
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            for (final Map<String, dynamic> item in _providers)
              _providerChip(p, item["id"].toString(), item["name"].toString()),
            _providerChip(p, "custom", "自定义"),
          ],
        ),
        if (provider != null &&
            (provider["tagline"]?.toString() ?? "").isNotEmpty) ...<Widget>[
          const SizedBox(height: 10),
          Text(provider["tagline"].toString(),
              style: TextStyle(color: p.textMuted, fontSize: 12)),
        ],
        const SizedBox(height: 14),
        _fieldLabel(p, "网关地址（OpenAI 兼容）"),
        _buildField(p, controller: _baseUrl, hint: "https://api.deepseek.com"),
        const SizedBox(height: 12),
        _fieldLabel(p, "模型名"),
        _buildField(p, controller: _model, hint: "deepseek-flash"),
        // 目录模型的快捷选择
        if (provider != null &&
            (provider["models"] as List<dynamic>? ?? const <dynamic>[])
                .isNotEmpty) ...<Widget>[
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final dynamic m in provider["models"] as List<dynamic>)
                _modelSuggestionChip(
                    p, (m as Map<String, dynamic>)["id"].toString()),
            ],
          ),
        ],
        const SizedBox(height: 12),
        _fieldLabel(p, "API Key${_modelConfigured ? "（已保存，可改）" : ""}"),
        _buildField(
          p,
          controller: _apiKey,
          hint: _modelConfigured ? "已配置 ${_modelKeyTail ?? ""}，留空不改" : "sk-...",
          obscure: _obscureModelKey,
          suffixIcon: IconButton(
            icon: Icon(
              _obscureModelKey
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
              size: 18,
              color: p.textMuted,
            ),
            onPressed: () =>
                setState(() => _obscureModelKey = !_obscureModelKey),
          ),
        ),
        if (consoleUrl != null && consoleUrl.isNotEmpty) ...<Widget>[
          const SizedBox(height: 8),
          GestureDetector(
            onTap: () => unawaited(launchUrl(Uri.parse(consoleUrl),
                mode: LaunchMode.externalApplication)),
            child: Text(
              "没有 Key？前往 ${provider?["name"] ?? "服务商"} 控制台申请 ↗",
              style: TextStyle(
                  color: Theme.of(context).colorScheme.primary, fontSize: 13),
            ),
          ),
        ],
        const SizedBox(height: 16),
        _actionButton(
          p,
          label: "保存模型接入",
          busy: _savingModel,
          onPressed: _saveModel,
        ),
        if (_modelMessage != null) ...<Widget>[
          const SizedBox(height: 10),
          Text(
            _modelMessage!,
            style: TextStyle(
              color: _modelMessageError
                  ? Theme.of(context).colorScheme.error
                  : p.textSecondary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ],
      ],
    );
  }

  // ═══════════════════════════════════════════════
  // 语音合成（TTS）卡
  // ═══════════════════════════════════════════════

  Widget _buildTtsCard(MobilePalette p) {
    return _card(
      p,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(Icons.graphic_eq_outlined, color: p.textSecondary, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: Text("语音合成（TTS）",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
            ),
            _statusChip(p, _ttsConfigured, _ttsKeyTail),
          ],
        ),
        const SizedBox(height: 14),
        Wrap(
          spacing: 8,
          children: <Widget>[
            _ttsProviderChip(p, "minimax", "MiniMax"),
            _ttsProviderChip(p, "openai", "OpenAI（复用模型 Key）"),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          _ttsProvider == "minimax"
              ? "中文拟真度最佳（speech-2.5，按字符计费），需要独立的 MiniMax API Key。"
              : "复用模型服务的 API Key 与网关（OpenAI 兼容），无需单独密钥。",
          style: TextStyle(color: p.textMuted, fontSize: 12, height: 1.5),
        ),
        if (_ttsProvider == "minimax") ...<Widget>[
          const SizedBox(height: 12),
          _fieldLabel(p, "MiniMax API Key${_ttsConfigured ? "（已保存，可改）" : ""}"),
          _buildField(
            p,
            controller: _ttsApiKey,
            hint: _ttsConfigured ? "已配置 ${_ttsKeyTail ?? ""}，留空不改" : "eyJ...",
            obscure: _obscureTtsKey,
            suffixIcon: IconButton(
              icon: Icon(
                _obscureTtsKey
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined,
                size: 18,
                color: p.textMuted,
              ),
              onPressed: () => setState(() => _obscureTtsKey = !_obscureTtsKey),
            ),
          ),
        ],
        const SizedBox(height: 16),
        Row(
          children: <Widget>[
            Expanded(
              child: _actionButton(
                p,
                label: "保存",
                busy: _savingTts,
                onPressed: _saveTts,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _actionButton(
                p,
                label: "试听测试",
                busy: _testingTts,
                onPressed: _ttsConfigured ? _testTts : null,
                secondary: true,
              ),
            ),
          ],
        ),
        if (_ttsMessage != null) ...<Widget>[
          const SizedBox(height: 10),
          Text(
            _ttsMessage!,
            style: TextStyle(
              color: _ttsMessageError
                  ? Theme.of(context).colorScheme.error
                  : p.textSecondary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ],
      ],
    );
  }

  // ═══════════════════════════════════════════════
  // 邮箱盯梢卡
  // ═══════════════════════════════════════════════

  Widget _buildMailCard(MobilePalette p) {
    final String? guideUrl = mailGuideUrl(_mailUser);
    return _card(
      p,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(Icons.mark_email_unread_outlined,
                color: p.textSecondary, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: Text("邮箱盯梢",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: _mailRunning ? const Color(0xFF34C759) : p.textMuted,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(_mailRunning ? "盯梢中" : "未接通",
                    style: TextStyle(color: p.textSecondary, fontSize: 12)),
              ],
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          "登录用的邮箱已自动接入。只需填一次 IMAP 授权码（邮箱网页版设置里生成，"
          "不是登录密码），Agent 就会帮你盯重要邮件、自动把车票/酒店行程记进日程。",
          style: TextStyle(color: p.textSecondary, fontSize: 13, height: 1.5),
        ),
        if (_mailUser.isNotEmpty) ...<Widget>[
          const SizedBox(height: 8),
          Text("已接入邮箱：$_mailUser",
              style: TextStyle(color: p.textPrimary, fontSize: 13)),
        ],
        if (!_mailRunning && _mailReason.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(_mailReason,
              style: TextStyle(color: p.textMuted, fontSize: 12, height: 1.4)),
        ],
        const SizedBox(height: 12),
        // 授权码获取引导（按邮箱域给分步说明 + 官方入口直达）
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: p.background,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: p.divider),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("如何获取授权码？",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Text(mailGuideSteps(_mailUser),
                  style: TextStyle(
                      color: p.textSecondary, fontSize: 12.5, height: 1.6)),
              if (guideUrl != null) ...<Widget>[
                const SizedBox(height: 8),
                InkWell(
                  onTap: () => launchUrl(Uri.parse(guideUrl),
                      mode: LaunchMode.externalApplication),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(Icons.open_in_new, size: 14, color: p.accent),
                      const SizedBox(width: 4),
                      Text("打开邮箱设置页",
                          style: TextStyle(
                            color: p.accent,
                            fontSize: 12.5,
                            decoration: TextDecoration.underline,
                            decorationColor: p.accent,
                          )),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        _fieldLabel(p, "IMAP 授权码${_mailConfigured ? "（已保存，可改）" : ""}"),
        TextField(
          controller: _mailPass,
          obscureText: _obscureMailPass,
          autocorrect: false,
          enableSuggestions: false,
          style: TextStyle(color: p.textPrimary, fontSize: 14),
          decoration: InputDecoration(
            hintText: _mailConfigured ? "已接入，留空不改；要换请填新授权码" : "邮箱设置里生成的授权码",
            hintStyle: TextStyle(color: p.textMuted, fontSize: 14),
            filled: true,
            fillColor: p.background,
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            suffixIcon: IconButton(
              icon: Icon(
                _obscureMailPass
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined,
                size: 18,
                color: p.textMuted,
              ),
              onPressed: () =>
                  setState(() => _obscureMailPass = !_obscureMailPass),
            ),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: p.divider),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: p.divider),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: p.textSecondary),
            ),
          ),
        ),
        const SizedBox(height: 14),
        _actionButton(
          p,
          label: "保存并接通",
          busy: _savingMail,
          onPressed: _saveMail,
        ),
        if (_mailMessage != null) ...<Widget>[
          const SizedBox(height: 10),
          Text(
            _mailMessage!,
            style: TextStyle(
              color: _mailMessageError
                  ? Theme.of(context).colorScheme.error
                  : p.textSecondary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
        ],
      ],
    );
  }

  // ═══════════════════════════════════════════════
  // 通用小组件
  // ═══════════════════════════════════════════════

  // ═══════════════════════════════════════════════
  // 信息源树枝卡（树状可插拔架构 Phase 3 配置面）
  // ═══════════════════════════════════════════════

  Future<void> _loadBranches() async {
    setState(() => _branchesLoading = true);
    try {
      final http.Response resp = await http
          .get(Uri.parse("${ApiConfig.httpBase}/api/proactivity/branches"),
              headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      final Map<String, dynamic> parsed =
          jsonDecode(resp.body) as Map<String, dynamic>;
      if (parsed["ok"] != true) {
        throw Exception(parsed["error"]?.toString() ?? "读取树枝配置失败");
      }
      List<Map<String, dynamic>> watchTasks = const <Map<String, dynamic>>[];
      try {
        final http.Response wt = await http
            .get(Uri.parse("${ApiConfig.httpBase}/api/proactivity/watch-tasks"),
                headers: AccessCredentialStore.instance.authHeaders)
            .timeout(const Duration(seconds: 15));
        if (wt.statusCode == 200) {
          final Map<String, dynamic> wp =
              jsonDecode(wt.body) as Map<String, dynamic>;
          if (wp["ok"] == true) {
            watchTasks = ((wp["tasks"] as List<dynamic>?) ?? const <dynamic>[])
                .map((e) => (e as Map<String, dynamic>))
                .toList();
          }
        }
      } catch (_) {
        // 盯梢任务面缺失不挡树枝卡（旧服务端兼容）
      }
      if (!mounted) return;
      setState(() {
        _branches =
            ((parsed["branches"] as List<dynamic>?) ?? const <dynamic>[])
                .map((e) => (e as Map<String, dynamic>))
                .toList();
        _watchTasks = watchTasks;
        _branchMessage = null;
        _branchMessageError = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _branchMessage = "树枝配置读取失败：$e";
        _branchMessageError = true;
      });
    } finally {
      if (mounted) setState(() => _branchesLoading = false);
    }
  }

  Future<void> _patchBranch(
    String id, {
    bool? enabled,
    bool? condense,
  }) async {
    try {
      final http.Response resp = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/proactivity/branches/config"),
            headers: AccessCredentialStore.instance.authHeaders,
            body: jsonEncode(<String, dynamic>{
              "id": id,
              if (enabled != null) "enabled": enabled,
              if (condense != null) "condense": condense,
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      await _loadBranches();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _branchMessage = "保存树枝配置失败：$e";
        _branchMessageError = true;
      });
      await _loadBranches();
    }
  }

  Future<void> _patchWatchTask(String actorId, String id, String action) async {
    try {
      final http.Response resp = await http
          .post(
            Uri.parse(
                "${ApiConfig.httpBase}/api/proactivity/watch-tasks/config"),
            headers: AccessCredentialStore.instance.authHeaders,
            body: jsonEncode(<String, dynamic>{
              "id": id,
              "actorId": actorId,
              "action": action,
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) {
        throw Exception("HTTP ${resp.statusCode}");
      }
      await _loadBranches();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _branchMessage = "盯梢任务操作失败：$e";
        _branchMessageError = true;
      });
    }
  }

  Widget _buildBranchesCard(MobilePalette p) {
    return _card(
      p,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(Icons.account_tree_outlined, color: p.textSecondary, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: Text("信息源树枝",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
            ),
            if (_branchesLoading)
              const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ),
        const SizedBox(height: 6),
        Text(
            "每根树枝是一个信息源：停用后该来源不再进主动提醒管道；"
            "「AI 精简」打开后由模型对过闸内容做摘要上报（每日有预算，失败自动回退原文摘要）。",
            style: TextStyle(
                color: p.textSecondary, fontSize: 12.5, height: 1.45)),
        const SizedBox(height: 12),
        for (final Map<String, dynamic> b in _branches) ...<Widget>[
          _branchRow(p, b),
          if (b != _branches.last) const SizedBox(height: 4),
        ],
        if (_watchTasks.isNotEmpty) ...<Widget>[
          const SizedBox(height: 14),
          Divider(height: 1, color: p.textMuted.withValues(alpha: 0.2)),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Icon(Icons.visibility_outlined, color: p.textSecondary, size: 16),
              const SizedBox(width: 6),
              Text("盯梢任务",
                  style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w600)),
              const SizedBox(width: 6),
              Text("对话里说「帮我盯着…」创建",
                  style: TextStyle(color: p.textMuted, fontSize: 11.5)),
            ],
          ),
          const SizedBox(height: 8),
          for (final Map<String, dynamic> t in _watchTasks) _watchTaskRow(p, t),
        ],
        if (_branches.isEmpty && !_branchesLoading) ...<Widget>[
          const SizedBox(height: 8),
          Text("暂无树枝清单（服务端未装配或版本过旧）",
              style: TextStyle(color: p.textMuted, fontSize: 12.5)),
        ],
        if (_branchMessage != null) ...<Widget>[
          const SizedBox(height: 10),
          Text(_branchMessage!,
              style: TextStyle(
                  color: _branchMessageError
                      ? const Color(0xFFE5484D)
                      : const Color(0xFF34C759),
                  fontSize: 12.5)),
        ],
      ],
    );
  }

  Widget _branchRow(MobilePalette p, Map<String, dynamic> b) {
    final String id = b["id"]?.toString() ?? "";
    final String label = b["label"]?.toString() ?? id;
    final String mode = b["mode"]?.toString() ?? "streaming";
    final bool enabled = b["enabled"] == true;
    final bool condense = b["condense"] == true;
    return Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(label,
                  style: TextStyle(
                      color: enabled ? p.textPrimary : p.textMuted,
                      fontSize: 14.5,
                      fontWeight: FontWeight.w500)),
              const SizedBox(height: 2),
              Text(
                mode == "upload" ? "上传类 · 版本链" : "连接类 · 游标增量",
                style: TextStyle(color: p.textMuted, fontSize: 11.5),
              ),
            ],
          ),
        ),
        Text("AI 精简", style: TextStyle(color: p.textSecondary, fontSize: 12)),
        SizedBox(
          width: 40,
          height: 28,
          child: FittedBox(
            child: Switch(
              value: condense,
              activeThumbColor: Theme.of(context).colorScheme.primary,
              onChanged: (bool v) => unawaited(_patchBranch(id, condense: v)),
            ),
          ),
        ),
        const SizedBox(width: 4),
        SizedBox(
          width: 40,
          height: 28,
          child: FittedBox(
            child: Switch(
              value: enabled,
              activeThumbColor: Theme.of(context).colorScheme.primary,
              onChanged: (bool v) => unawaited(_patchBranch(id, enabled: v)),
            ),
          ),
        ),
      ],
    );
  }

  Widget _watchTaskRow(MobilePalette p, Map<String, dynamic> t) {
    final String id = t["id"]?.toString() ?? "";
    final String actorId = t["actorId"]?.toString() ?? "";
    final String label = t["label"]?.toString() ?? id;
    final bool active = t["active"] == true;
    final String keywords =
        ((t["keywords"] as List<dynamic>?) ?? const <dynamic>[]).join("、");
    return Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(label,
                  style: TextStyle(
                      color: active ? p.textPrimary : p.textMuted,
                      fontSize: 13.5)),
              if (keywords.isNotEmpty) ...<Widget>[
                const SizedBox(height: 1),
                Text("关键词：$keywords",
                    style: TextStyle(
                        color: p.textMuted,
                        fontSize: 11,
                        overflow: TextOverflow.ellipsis)),
              ],
            ],
          ),
        ),
        GestureDetector(
          onTap: () => unawaited(
              _patchWatchTask(actorId, id, active ? "pause" : "resume")),
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: Text(active ? "暂停" : "恢复",
                style: TextStyle(
                    color: Theme.of(context).colorScheme.primary,
                    fontSize: 12.5)),
          ),
        ),
        GestureDetector(
          onTap: () => unawaited(_patchWatchTask(actorId, id, "remove")),
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: Text("删除",
                style:
                    TextStyle(color: const Color(0xFFE5484D), fontSize: 12.5)),
          ),
        ),
      ],
    );
  }

  Widget _card(MobilePalette p, {required List<Widget> children}) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }

  /// 已配置状态角标：绿点 + 密钥尾号；未配置为灰「未配置」。
  Widget _statusChip(MobilePalette p, bool configured, String? keyTail) {
    final Color dot = configured ? const Color(0xFF34C759) : p.textMuted;
    final String label = configured ? "已配置 ${keyTail ?? ""}" : "未配置";
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(color: p.textSecondary, fontSize: 12)),
      ],
    );
  }

  Widget _providerChip(MobilePalette p, String id, String label) {
    final bool selected = _providerId == id;
    return GestureDetector(
      onTap: () => setState(() => _applyProvider(id)),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? p.accent : p.background,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: selected ? p.accent : p.divider),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? p.onAccent : p.textSecondary,
            fontSize: 13,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }

  Widget _ttsProviderChip(MobilePalette p, String id, String label) {
    final bool selected = _ttsProvider == id;
    return GestureDetector(
      onTap: () => setState(() => _ttsProvider = id),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? p.accent : p.background,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: selected ? p.accent : p.divider),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? p.onAccent : p.textSecondary,
            fontSize: 13,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }

  Widget _modelSuggestionChip(MobilePalette p, String modelId) {
    final bool selected = _model.text.trim() == modelId;
    return GestureDetector(
      onTap: () => setState(() => _model.text = modelId),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? p.accent : p.background,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? p.accent : p.divider),
        ),
        child: Text(
          modelId,
          style: TextStyle(
            color: selected ? p.onAccent : p.textSecondary,
            fontSize: 12,
          ),
        ),
      ),
    );
  }

  Widget _fieldLabel(MobilePalette p, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text,
          style: TextStyle(
              color: p.textPrimary, fontSize: 13, fontWeight: FontWeight.w600)),
    );
  }

  Widget _buildField(
    MobilePalette p, {
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    Widget? suffixIcon,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      autocorrect: false,
      enableSuggestions: false,
      style: TextStyle(color: p.textPrimary, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: p.textMuted, fontSize: 14),
        filled: true,
        fillColor: p.background,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        suffixIcon: suffixIcon,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.divider),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.divider),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.textSecondary),
        ),
      ),
    );
  }

  Widget _actionButton(
    MobilePalette p, {
    required String label,
    required bool busy,
    required VoidCallback? onPressed,
    bool secondary = false,
  }) {
    return SizedBox(
      width: double.infinity,
      height: 44,
      child: secondary
          ? OutlinedButton(
              onPressed: busy ? null : onPressed,
              style: OutlinedButton.styleFrom(
                foregroundColor: p.textPrimary,
                side: BorderSide(color: p.divider),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(22)),
              ),
              child: _buttonChild(label, busy, p.textSecondary),
            )
          : FilledButton(
              onPressed: busy ? null : onPressed,
              style: FilledButton.styleFrom(
                backgroundColor: p.accent,
                foregroundColor: p.onAccent,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(22)),
              ),
              child: _buttonChild(label, busy, p.onAccent),
            ),
    );
  }

  Widget _buttonChild(String label, bool busy, Color spinnerColor) {
    return busy
        ? SizedBox(
            width: 18,
            height: 18,
            child:
                CircularProgressIndicator(strokeWidth: 2, color: spinnerColor),
          )
        : Text(label,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600));
  }
}
