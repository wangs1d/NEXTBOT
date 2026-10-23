import "dart:async";
import "dart:convert";
import "dart:developer" as developer;
import "dart:math" as math;
import "dart:ui" show lerpDouble;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/presentation/boot_animation.dart";
import "../../core/services/local_runtime_config.dart";
import "../../core/services/local_runtime_manager.dart";
import "../../core/services/model_api_tester.dart";
import "../../core/theme/app_theme.dart";
import "../model_config/model_provider_card.dart";
import "../model_config/model_provider_catalog.dart";
import "../../widgets/app_window_titlebar.dart";

/// 首启序列：进度条开机动画 + 两步配置向导（称呼+agent 名字同屏 →
/// 模型接入），黑白极简，完成后经 [onComplete] 切入主界面。
///
/// （2026-10-15：声纹注册步骤已删除——不再卡首启必经路径，声纹保留
/// just-in-time 入口（语音触发 / 设置页直达）；称呼与 agent 名字合并为
/// 同屏双字段。）
///
/// 动画期间做真实准备工作（runtime 探活 / 能力面板 / agent 名读取），
/// 进度条反映实际就绪度；向导步骤落点：
///   称呼   → POST /api/profile/manage/fact（结构化事实，prompt 现成通道）
///   名字   → POST /api/agent-identity/rename（账号+记忆KV+prefs 统一管道）
///   模型   → %APPDATA%\Nextbot\config.env + runtime 重启 + 直连测试
class OnboardingFlow extends StatefulWidget {
  const OnboardingFlow({
    super.key,
    required this.onComplete,
  });

  /// 全部完成（或 debug 跳过）后回调；持久化 onboarding 完成标记由宿主负责。
  final VoidCallback onComplete;

  @override
  State<OnboardingFlow> createState() => _OnboardingFlowState();
}

enum _Phase { boot, profile, model, done }

class _OnboardingFlowState extends State<OnboardingFlow> {
  // ── 配色（与注册门禁同套深色独占语言）──
  static const Color pageBg = Color(0xFF000000);
  static const Color cardBg = Color(0xFF141414);
  static const Color cardBorder = Color(0xFF232323);
  static const Color textPrimary = Color(0xFFF2F2F2);
  static const Color textSecondary = Color(0xFF9B9B9B);
  static const Color textMuted = Color(0xFF6B6B6B);
  static const Color errorRed = Color(0xFFF2604E);

  _Phase _phase = _Phase.boot;

  // ── 动画准备态 ──
  final ValueNotifier<double> _bootProgress = ValueNotifier<double>(0);
  String _bootStatus = "正在唤醒…";
  bool _prepDone = false;
  String? _currentAgentName;

  // ── 步骤 1：称呼 ──
  final TextEditingController _appellationCtrl = TextEditingController();

  // ── 步骤 1：agent 名字（与称呼同屏）──
  final TextEditingController _agentNameCtrl = TextEditingController();

  // ── 步骤 2：模型（目录式选择，UI 与数据全部在 ModelProviderCard）──
  final GlobalKey<ModelProviderCardState> _modelCardKey = GlobalKey<ModelProviderCardState>();
  ModelApiTestResult? _lastTestResult;
  // 预填：已配置过 key 的重进用户（例如向导中断后重跑）
  String _initialApiKey = "";
  String? _initialBase;
  String? _initialModel;
  // debug 通道缓存（卡片未挂载前先存，挂载后转交）
  String? _debugApiKey;
  String? _debugBaseUrl;
  String? _debugModel;

  // ── 完成页 ──
  String? _savedAppellation;
  String? _savedAgentName;
  ModelApiTestResult? _finalModelResult;

  @override
  void initState() {
    super.initState();
    _registerDebugExtensions();
    unawaited(_runBootPrep());
  }

  @override
  void dispose() {
    _appellationCtrl.dispose();
    _agentNameCtrl.dispose();
    _bootProgress.dispose();
    super.dispose();
  }

  // ============================================================
  // 动画阶段：真实准备工作驱动进度条
  // ============================================================

  static const Duration _minBootDuration = Duration(milliseconds: 3000);

  Future<void> _runBootPrep() async {
    final Stopwatch sw = Stopwatch()..start();
    void tick(double p, String status) {
      _bootProgress.value = p.clamp(0.0, 1.0);
      _bootStatus = status;
    }

    tick(0.08, "正在唤醒…");
    final List<Future<void>> tasks = <Future<void>>[
      (() async {
        // runtime 探活/拉起（非捆绑形态跳过）
        if (!kIsWeb && LocalRuntimeManager.isBundled) {
          tick(0.2, "正在启动本地引擎…");
          try {
            await LocalRuntimeManager.ensureRunning().timeout(const Duration(seconds: 25));
          } catch (_) {/* 超时放行，向导步骤里还有兜底 */}
        }
        tick(0.45, "本地引擎就绪");
      }()),
      (() async {
        tick(0.3, "正在读取能力清单…");
        try {
          final http.Response res = await http
              .get(Uri.parse("${ApiConfig.httpBase}/api/capabilities"))
              .timeout(const Duration(seconds: 4));
          if (res.statusCode == 200) {
            final dynamic parsed = jsonDecode(res.body);
            if (parsed is Map && parsed["ok"] == true) tick(0.55, "能力清单就绪");
          }
        } catch (_) {/* best-effort */}
      }()),
      (() async {
        // 现有 agent 名（重进向导时回显）
        try {
          final http.Response res = await http
              .get(Uri.parse(
                  "${ApiConfig.httpBase}/api/user-preferences?userId=${Uri.encodeComponent(ApiConfig.effectiveActorId)}"))
              .timeout(const Duration(seconds: 4));
          if (res.statusCode == 200) {
            final dynamic parsed = jsonDecode(res.body);
            final dynamic profile = parsed is Map ? parsed["agentProfile"] : null;
            final String? name = profile is Map ? profile["displayName"]?.toString() : null;
            if (name != null && name.isNotEmpty && mounted) {
              _currentAgentName = name;
              _agentNameCtrl.text = name;
            }
          }
        } catch (_) {/* best-effort */}
      }()),
    ];
    await Future.wait(tasks);
    tick(0.85, "正在准备你的专属配置…");

    // 电影感下限：准备再快也让动画走满最低时长
    final int remainMs = _minBootDuration.inMilliseconds - sw.elapsedMilliseconds;
    if (remainMs > 0) {
      await Future<void>.delayed(Duration(milliseconds: remainMs));
    }
    if (!mounted) return;
    tick(1.0, "就绪");
    await Future<void>.delayed(const Duration(milliseconds: 420));
    if (!mounted) return;
    setState(() => _prepDone = true);
    // 预填：已配置过 key 的重进用户（例如向导中断后重跑）；卡片会按 base 解析回目录商
    final Map<String, String> cfg = LocalRuntimeConfig.readSync();
    _initialApiKey = cfg["OPENAI_API_KEY"] ?? "";
    _initialBase = cfg["OPENAI_BASE_URL"];
    _initialModel = cfg["OPENAI_MODEL"];
    _go(_Phase.profile);
  }

  void _go(_Phase next) {
    setState(() => _phase = next);
  }

  // ============================================================
  // 步骤 1：称呼
  // ============================================================

  Future<bool> _saveAppellation(String value) async {
    try {
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/profile/manage/fact"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "actorId": ApiConfig.effectiveActorId,
              "field": "称呼",
              "value": value,
            }),
          )
          .timeout(const Duration(seconds: 6));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 步骤 2：agent 名字
  // ============================================================

  Future<bool> _saveAgentName(String name) async {
    try {
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/agent-identity/rename"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              "displayName": name,
            }),
          )
          .timeout(const Duration(seconds: 6));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 步骤 1：称呼 + agent 名字（同屏双字段）
  // ============================================================

  /// 两项校验通过后一起落盘；单边失败不阻塞（后续对话里还能纠正）。
  Future<void> _confirmProfile() async {
    final String appellation = _appellationCtrl.text.trim();
    final String agentName = _agentNameCtrl.text.trim();
    if (appellation.isEmpty || appellation.length > 12) return;
    if (agentName.isEmpty || agentName.length > 12) return;
    _savedAppellation = appellation;
    _savedAgentName = agentName;
    unawaited(_saveAppellation(appellation));
    unawaited(_saveAgentName(agentName));
    _go(_Phase.model);
  }

  // ============================================================
  // 步骤 2：模型接入（UI/收集/测试在 ModelProviderCard，这里只落盘）
  // ============================================================

  Future<void> _saveModelConfig(ModelConfigDraft draft) async {
    await LocalRuntimeConfig.writeModelConfig(
      apiKey: draft.apiKey,
      baseUrl: draft.baseUrl,
      model: draft.model,
    );
    // 捆绑形态重启 runtime 使配置即刻生效（kill+端口释放+拉起，最久 ~25s）
    if (!kIsWeb && LocalRuntimeManager.isBundled) {
      await LocalRuntimeManager.restart().timeout(const Duration(seconds: 30));
    }
    _finalModelResult = _lastTestResult;
  }

  // ============================================================
  // debug VM 扩展（E2E 驱动，照 registerFill 模式）
  // ============================================================

  static bool _debugRegistered = false;

  void _registerDebugExtensions() {
    if (!kDebugMode || _debugRegistered) return;
    _debugRegistered = true;
    developer.registerExtension("ext.pai.debug.onboardingFill", (String method, Map<String, String> params) async {
      final String? appellation = params["appellation"];
      final String? agentName = params["agentName"];
      final String? apiKey = params["apiKey"];
      final String? baseUrl = params["baseUrl"];
      final String? model = params["model"];
      final String? providerId = params["providerId"];
      final bool submit = params["submit"] == "1";
      if (appellation != null) _appellationCtrl.text = appellation;
      if (agentName != null) _agentNameCtrl.text = agentName;
      // 模型字段：卡片已挂载则直接填充；未挂载先缓存（_buildModelStep 时转交）
      if (_modelCardKey.currentState != null) {
        _modelCardKey.currentState!.debugFill(
          apiKey: apiKey, baseUrl: baseUrl, model: model, providerId: providerId,
        );
      } else {
        _debugApiKey = apiKey;
        _debugBaseUrl = baseUrl;
        _debugModel = model;
      }
      if (submit) {
        _savedAppellation = _appellationCtrl.text.trim().isNotEmpty ? _appellationCtrl.text.trim() : "(未填)";
        _savedAgentName = _agentNameCtrl.text.trim().isNotEmpty ? _agentNameCtrl.text.trim() : "(未填)";
        unawaited(_saveAppellation(_appellationCtrl.text.trim()));
        unawaited(_saveAgentName(_agentNameCtrl.text.trim()));
        final ModelConfigDraft? draft = _modelCardKey.currentState?.buildDraft()
            ?? ((apiKey != null && apiKey.trim().isNotEmpty)
                ? ModelConfigDraft(
                    providerId: providerId ?? ModelProviderCatalog.customId,
                    baseUrl: baseUrl?.trim() ?? "",
                    model: model?.trim() ?? "",
                    apiKey: apiKey.trim(),
                  )
                : null);
        if (draft != null) {
          unawaited(LocalRuntimeConfig.writeModelConfig(
            apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model,
          ));
        }
        _finalModelResult = _lastTestResult;
        if (mounted) _go(_Phase.done);
      }
      return developer.ServiceExtensionResponse.result('{"ok":true}');
    });
    developer.registerExtension("ext.pai.debug.onboardingSkip", (String method, Map<String, String> params) async {
      if (mounted) _go(_Phase.done);
      return developer.ServiceExtensionResponse.result('{"ok":true}');
    });
  }

  // ============================================================
  // build
  // ============================================================

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // 向导用独立 navigatorKey 由宿主传入；此处不设 key（宿主包裹时给出），
      // 页面自绘标题栏，深色独占。
      title: "",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        fontFamily: AppTheme.appFontFamily,
        scaffoldBackgroundColor: pageBg,
        brightness: Brightness.dark,
      ),
      home: Scaffold(
        backgroundColor: pageBg,
        body: Column(
          children: <Widget>[
            const AppWindowTitleBar(),
            Expanded(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 360),
                switchInCurve: Curves.easeOut,
                switchOutCurve: Curves.easeIn,
                child: KeyedSubtree(
                  key: ValueKey<_Phase>(_phase),
                  child: _buildPhase(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPhase() {
    switch (_phase) {
      case _Phase.boot:
        return _BootPane(progress: _bootProgress, status: _bootStatus, done: _prepDone);
      case _Phase.profile:
        return _buildProfileStep();
      case _Phase.model:
        return _buildModelStep();
      case _Phase.done:
        return _buildDonePane();
    }
  }

  // ── 步骤页公共骨架 ──

  Widget _stepFrame({
    required int step,
    required String title,
    required String subtitle,
    required Widget child,
    Widget? footer,
  }) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _StepIndicator(current: step, total: 2),
              const SizedBox(height: 28),
              Text(title, style: const TextStyle(color: textPrimary, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: 0.5)),
              const SizedBox(height: 8),
              Text(subtitle, style: const TextStyle(color: textSecondary, fontSize: 13.5, height: 1.6)),
              const SizedBox(height: 32),
              child,
              if (footer != null) ...<Widget>[const SizedBox(height: 20), footer],
            ],
          ),
        ),
      ),
    );
  }

  Widget _primaryButton(String label, VoidCallback onTap, {bool enabled = true, bool loading = false}) {
    final bool active = enabled && !loading;
    return SizedBox(
      height: 48,
      child: Opacity(
        opacity: active ? 1 : 0.35,
        child: FilledButton(
          style: FilledButtonTheme.of(context).style?.copyWith(
                backgroundColor: const WidgetStatePropertyAll<Color>(Colors.white),
                foregroundColor: const WidgetStatePropertyAll<Color>(Colors.black),
                shape: WidgetStatePropertyAll<RoundedRectangleBorder>(
                  RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                ),
              ),
          onPressed: active ? onTap : null,
          child: loading
              ? const SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                )
              : Text(label, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }

  // ── 步骤 1：称呼 + agent 名字（同屏）──

  Widget _buildProfileStep() {
    final String appellation = _appellationCtrl.text.trim();
    final String agentName = _agentNameCtrl.text.trim();
    final bool canNext = appellation.isNotEmpty && appellation.length <= 12 &&
        agentName.isNotEmpty && agentName.length <= 12;
    return _stepFrame(
      step: 1,
      title: "怎么称呼你？",
      subtitle: "我会记住这个称呼。之后对话里，它就是我对你的名字。也给它取个名字，你想叫它什么都行。",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _fieldLabel("称呼你"),
          _darkField(
            controller: _appellationCtrl,
            hint: "1-12 个字",
            autofocus: true,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 24),
          _fieldLabel(_currentAgentName == null
              ? "给它取个名字"
              : "给它取个名字（现在叫「$_currentAgentName」，可保留）"),
          _darkField(
            controller: _agentNameCtrl,
            hint: _currentAgentName ?? "你想叫它什么都行（1-12 字）",
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 28),
          _primaryButton("下一步", _confirmProfile, enabled: canNext),
        ],
      ),
    );
  }

  // ── 步骤 2：模型接入 ──

  Widget _buildModelStep() {
    return _stepFrame(
      step: 2,
      title: "接入你的模型",
      subtitle: "选一个模型服务商，按引导拿到 API Key 填进来，我才有大脑。数据只存在这台电脑上。",
      child: ModelProviderCard(
        key: _modelCardKey,
        saveLabel: "保存并完成",
        initialApiKey: _debugApiKey ?? _initialApiKey,
        initialBaseUrl: _debugBaseUrl ?? _initialBase,
        initialModel: _debugModel ?? _initialModel,
        colors: const ModelProviderCardColors(
          fieldBg: cardBg,
          fieldBorder: cardBorder,
          focusedBorder: Color(0x80FFFFFF),
          textPrimary: textPrimary,
          textSecondary: textSecondary,
          textMuted: textMuted,
          error: errorRed,
        ),
        onTestResult: (ModelApiTestResult r) => _lastTestResult = r,
        onSave: _saveModelConfig,
        onSaved: () {
          if (mounted) _go(_Phase.done);
        },
      ),
    );
  }

  // ── 完成页 ──

  Widget _buildDonePane() {
    final String modelLine = _finalModelResult?.ok == true
        ? _finalModelResult!.summary
        : "已保存（未测试连通）";
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: 8),
              const _DoneMark(),
              const SizedBox(height: 26),
              const Text("一切就绪", textAlign: TextAlign.center,
                  style: TextStyle(color: textPrimary, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: 1)),
              const SizedBox(height: 30),
              _doneRow("称呼", _savedAppellation ?? "（未设置）"),
              _doneRow("名字", _savedAgentName ?? "（未设置）"),
              _doneRow("模型", modelLine),
              const SizedBox(height: 36),
              _primaryButton("开始使用", widget.onComplete),
            ],
          ),
        ),
      ),
    );
  }

  Widget _doneRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: <Widget>[
          SizedBox(width: 52, child: Text(label, style: const TextStyle(color: textMuted, fontSize: 12.5))),
          Expanded(child: Text(value, style: const TextStyle(color: textSecondary, fontSize: 13.5))),
        ],
      ),
    );
  }

  // ── 通用小件 ──

  Widget _fieldLabel(String text) {
    return Padding(
      padding: const EdgeInsets.only(left: 2, bottom: 8),
      child: Text(text, style: const TextStyle(color: textMuted, fontSize: 12.5)),
    );
  }

  Widget _darkField({
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    bool autofocus = false,
    Widget? suffix,
    ValueChanged<String>? onChanged,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      autofocus: autofocus,
      style: const TextStyle(color: textPrimary, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: textMuted, fontSize: 13),
        filled: true,
        fillColor: cardBg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        suffixIcon: suffix,
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: cardBorder)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.5))),
      ),
      onChanged: onChanged,
    );
  }
}

// ============================================================
// 动画面板：N 标识 + 居中白色进度条
// ============================================================

class _BootPane extends StatelessWidget {
  const _BootPane({required this.progress, required this.status, required this.done});

  final ValueNotifier<double> progress;
  final String status;
  final bool done;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<double>(
      valueListenable: progress,
      builder: (BuildContext context, double value, _) {
        return AnimatedOpacity(
          opacity: done ? 0 : 1,
          duration: const Duration(milliseconds: 300),
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              final double markSize = math.min(constraints.biggest.height * 0.18, 120);
              return Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  // N 标识：进度条上方一点
                  CustomPaint(
                    size: Size(markSize, markSize / 2),
                    painter: _OnboardingMarkPainter(t: value),
                  ),
                  const SizedBox(height: 34),
                  // 居中白色进度条
                  SizedBox(
                    width: math.min(constraints.biggest.width * 0.42, 380),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(1.5),
                      child: Container(
                        height: 3,
                        color: const Color(0xFF232323),
                        child: FractionallySizedBox(
                          alignment: Alignment.centerLeft,
                          widthFactor: Curves.easeOutCubic.transform(value.clamp(0.0, 1.0)),
                          child: Container(color: Colors.white),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(status, style: const TextStyle(color: Color(0xFF6B6B6B), fontSize: 12, letterSpacing: 0.4)),
                ],
              );
            },
          ),
        );
      },
    );
  }
}

/// N 字标：随进度由暗到亮（描边 → 填充微光 → 完成时亮白），呼吸微动效。
class _OnboardingMarkPainter extends CustomPainter {
  _OnboardingMarkPainter({required this.t});

  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = buildNMarkOutlinePath();
    final double u = size.width / 32;
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(u);
    canvas.translate(-16, -8); // 盒子中心 (16,16)（含 y 0-32）对准绘制中心

    // 呼吸：随时间的轻微信号（用 t 的整数哈希近似相位即可，无需动画器）
    final double breathe = 0.045 * math.sin(t * math.pi);
    final double fillAlpha = 0.10 + 0.80 * Curves.easeOutCubic.transform(t.clamp(0.0, 1.0)) + breathe;

    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.fill
        ..color = Colors.white.withValues(alpha: fillAlpha.clamp(0.0, 1.0)),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.28
        ..color = Colors.white.withValues(alpha: lerpDouble(0.45, 0.95, t.clamp(0.0, 1.0))!),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _OnboardingMarkPainter oldDelegate) => oldDelegate.t != t;
}

class _StepIndicator extends StatelessWidget {
  const _StepIndicator({required this.current, required this.total});

  final int current;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        for (int i = 1; i <= total; i++)
          Expanded(
            child: Container(
              height: 2,
              margin: EdgeInsets.only(right: i == total ? 0 : 6),
              color: i <= current ? Colors.white : const Color(0xFF232323),
            ),
          ),
      ],
    );
  }
}

class _DoneMark extends StatelessWidget {
  const _DoneMark();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: CustomPaint(
        size: const Size(96, 48),
        painter: _OnboardingMarkPainter(t: 1),
      ),
    );
  }
}

