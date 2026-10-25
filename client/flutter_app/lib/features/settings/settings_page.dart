import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/services/agent_sphere_voice_controller.dart";
import "../../core/services/app_auto_start.dart";
import "../../core/services/local_runtime_config.dart";
import "../../core/services/local_runtime_manager.dart";
import "../../core/services/cloud_model_binding_store.dart";
import "../../core/services/model_api_tester.dart";
import "../../core/services/phone_bridge_service.dart";
import "../../core/services/phone_capture_service.dart";
import "../../core/theme/app_theme.dart";
import "../chat/voiceprint_registration_page.dart";
import "../model_config/model_provider_card.dart";
import "../model_config/model_provider_catalog.dart";
import "../../widgets/app_window_titlebar.dart";

/// 设置分区（左侧侧栏一项对应右侧一块内容）。
enum _SettingsSection { general, model, serviceAccess, phoneBridge }

/// 「设置」页 —— 全屏独立页（类似扣子的设置布局）：
/// 左侧分区侧栏 + 右侧内容区，顶部铺自绘标题栏保证窗口可拖拽/可关闭。
///
/// 分区：
///  - 通用（仅 Windows）：开机自动启动（本地注册表，不依赖服务器）
///  - 模型与声纹（仅 Windows）：主对话模型接入 + 声纹注册
///  - 服务接入（仅 Windows）：需用户自行接入的外部服务，一样一个胶囊组件
///  - 手机桥接（仅 Android）：Agent 远程访问本机 / 消息捕捉 / 定位回传
/// （「它眼里的你」2026-09-30 迁往 Agent 主页。）
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage>
    with WidgetsBindingObserver {
  /// 当前选中的分区（Android 默认「手机桥接」，其余平台「通用」）。
  _SettingsSection _section = _SettingsSection.general;

  // —— Windows 本机设置（注册表，与服务器无关） ——
  /// 开机自动启动（「通用」分区）。
  bool _autoStart = false;
  bool get _isWindows =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  // —— 消息捕捉（通知使用权 / 落盘队列 / 定位回传） ——
  bool _listenerEnabled = false;
  int _captureQueueSize = 0;
  bool _captureLoading = true;
  bool _captureAll = false; // 未识别包全量捕捉兜底（默认关）
  List<CapturePackageRule> _captureRules = const []; // 自定义包名规则（回显用）

  // —— 模型与声纹分区 ——
  // 模型接入 UI/收集/测试全部在 ModelProviderCard（与首启向导共用），这里只存
  // 预填值与落盘回调。
  String _modelInitialKey = "";
  String? _modelInitialBase;
  String? _modelInitialModel;

  // —— 云端连接版「用户自有模型」（BYOK over cloud，!isBundled 时替代 byok 卡） ——
  // 收集 UI 全在一键更换弹窗内的 ModelProviderCard（与首启向导共用），这里只存
  // 状态与落盘回调。
  String? _cloudMsg;
  bool _cloudConfigured = false;
  Map<String, dynamic>? _vpStatus;
  bool _vpClearing = false;

  // —— 邮箱接入（邮箱盯梢授权码） ——
  final TextEditingController _mailPassCtrl = TextEditingController();
  Map<String, dynamic>? _mailStatus;
  bool _mailSaving = false;
  String? _mailSaveMsg;
  bool _obscureMailPass = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      _section = _SettingsSection.phoneBridge;
    }
    _loadLocalDeviceSettings();
    _refreshCaptureState();
    _loadModelConfig();
    _loadCloudModelConfig();
    _refreshVoiceprintStatus();
    _refreshMailStatus();
    _loadMailPassPrefill();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// 从系统「通知使用权」设置页授权回来时自动回检刷新状态
  /// （替代固定延时轮询：用户在系统设置里操作时长不可预估）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    unawaited(_refreshCaptureState());
  }

  /// 加载 Windows 本机设置：开机自启（注册表）。
  Future<void> _loadLocalDeviceSettings() async {
    if (!_isWindows) return;
    try {
      final bool autoStart = await AppAutoStart.isEnabled();
      if (!mounted) return;
      setState(() => _autoStart = autoStart);
    } catch (_) {
      // 本地设置加载失败不阻塞设置页
    }
  }

  Future<void> _toggleAutoStart(bool v) async {
    final bool ok = await AppAutoStart.setEnabled(v);
    if (!mounted) return;
    setState(() => _autoStart = ok ? v : _autoStart);
    _snack(ok
        ? (v ? "已开启开机自动启动" : "已关闭开机自动启动")
        : "设置失败，请重试");
  }

  void _snack(String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(text), duration: const Duration(seconds: 2)),
    );
  }

  // ------------------------------------------------------------------ //
  // 全屏布局：标题栏 + 左侧分区侧栏 + 右侧内容区
  // ------------------------------------------------------------------ //

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surface,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const AppWindowTitleBar(),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _buildSidebar(),
                VerticalDivider(
                  width: 1,
                  thickness: 1,
                  color: AppPalette.resolveSidebarSeparator(
                    AppThemeController.instance.value,
                  ),
                ),
                Expanded(child: MainPanel(child: _buildSectionContent())),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 左侧分区侧栏：背景与主界面左侧边栏同色（resolveSidebarPanel）。
  Widget _buildSidebar() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bg = AppPalette.resolveSidebarPanel(
      AppThemeController.instance.value,
    );
    // 版本闸：手机桥接为内测独占能力，开源版（PAI_EDITION=oss）不出现该分区
    final bool showPhoneBridge = !kIsWeb &&
        defaultTargetPlatform == TargetPlatform.android &&
        !ApiConfig.isOssEdition;
    final List<(_SettingsSection, IconData, String)> sections = <(
      _SettingsSection,
      IconData,
      String
    )>[
      if (_isWindows)
        (_SettingsSection.general, Icons.tune_outlined, "通用"),
      if (_isWindows)
        (_SettingsSection.model, Icons.graphic_eq_outlined, "模型与声纹"),
      if (_isWindows)
        (_SettingsSection.serviceAccess, Icons.hub_outlined, "服务接入"),
      if (showPhoneBridge)
        (_SettingsSection.phoneBridge, Icons.smartphone_outlined, "手机桥接"),
    ];
    return ColoredBox(
      color: bg,
      child: SizedBox(
        width: 232,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 16, 16, 8),
              child: Row(
                children: <Widget>[
                  IconButton(
                    icon: const Icon(Icons.arrow_back, size: 20),
                    tooltip: "返回对话",
                    visualDensity: VisualDensity.compact,
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    "设置",
                    style: Theme.of(context)
                        .textTheme
                        .titleMedium
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Column(
                children: <Widget>[
                  for (final (
                      _SettingsSection section,
                      IconData icon,
                      String label
                    ) in sections)
                    _navItem(cs, section, icon, label),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 侧栏导航项：选中时填充胶囊底 + 加重文字，未选中弱化。
  Widget _navItem(
    ColorScheme cs,
    _SettingsSection section,
    IconData icon,
    String label,
  ) {
    final bool selected = _section == section;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color:
            selected ? cs.onSurface.withValues(alpha: 0.08) : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() => _section = section),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: <Widget>[
                Icon(
                  icon,
                  size: 18,
                  color: selected ? cs.onSurface : cs.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: selected ? cs.onSurface : cs.onSurfaceVariant,
                          fontWeight:
                              selected ? FontWeight.w600 : FontWeight.w400,
                        ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 右侧内容区：分区大标题 + 对应表单卡片（限宽，避免超宽屏拉太长）。
  Widget _buildSectionContent() {
    final String title = switch (_section) {
      _SettingsSection.general => "通用",
      _SettingsSection.model => "模型与声纹",
      _SettingsSection.serviceAccess => "服务接入",
      _SettingsSection.phoneBridge => "手机桥接",
    };
    final Widget card = switch (_section) {
      _SettingsSection.general => _buildGeneralCard(),
      _SettingsSection.model => _buildModelSection(),
      _SettingsSection.serviceAccess => _buildServiceAccessSection(),
      _SettingsSection.phoneBridge => _buildPhoneBridgeCard(),
    };
    return SingleChildScrollView(
      // key 随分区变化：切换分区时滚动位置复位到顶部。
      key: ValueKey<_SettingsSection>(_section),
      padding: const EdgeInsets.fromLTRB(32, 28, 32, 40),
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                title,
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 16),
              card,
            ],
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ //
  // 模型与声纹
  // ------------------------------------------------------------------ //

  Future<void> _loadModelConfig() async {
    final Map<String, String> cfg = LocalRuntimeConfig.readSync();
    _modelInitialKey = cfg["OPENAI_API_KEY"] ?? "";
    _modelInitialBase = cfg["OPENAI_BASE_URL"];
    _modelInitialModel = cfg["OPENAI_MODEL"];
  }

  // ------------------------------------------------------------------ //
  // 云端连接版「用户自有模型」（BYOK over cloud）
  // ------------------------------------------------------------------ //

  /// 云端连接版形态：非捆绑（无本地 runtime）的 Windows 发行包。
  bool get _isCloudEdition =>
      !kIsWeb && _isWindows && !LocalRuntimeManager.isBundled;

  Future<void> _loadCloudModelConfig() async {
    await CloudModelBindingStore.instance.load();
    if (!mounted) return;
    setState(() => _cloudConfigured = CloudModelBindingStore.instance.isConfigured);
  }

  /// 一键更换模型弹窗：复用与首启向导共用的 [ModelProviderCard]（目录式选型，
  /// 接口地址由服务端目录自动匹配下发，不再让用户手填）。保存即写本机
  /// CloudModelBindingStore，下一次 WS 连接建立（session.init 上送）生效。
  Future<void> _showCloudModelDialog() async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        final NavigatorState nav = Navigator.of(dialogContext);
        return AlertDialog(
          title: const Text(
            "更换模型",
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
          contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: SingleChildScrollView(
              child: ModelProviderCard(
                initialBaseUrl: CloudModelBindingStore.instance.baseUrl,
                initialModel: CloudModelBindingStore.instance.model,
                initialApiKey: CloudModelBindingStore.instance.apiKey,
                autofocusKey: !_cloudConfigured,
                saveLabel: _cloudConfigured ? "保存并更换" : "保存并接入",
                onSave: _saveCloudBinding,
                onSaved: () {
                  nav.pop();
                  if (mounted) {
                    setState(() {
                      _cloudConfigured = true;
                      _cloudMsg = "已更换模型，重连服务器后生效（重启应用立即生效）";
                    });
                  }
                },
              ),
            ),
          ),
          actions: <Widget>[
            TextButton(onPressed: nav.pop, child: const Text("取消")),
          ],
        );
      },
    );
  }

  /// 落盘本机 BYOK 三元组（baseUrl 由目录自动匹配而来）；https 门禁与原表单一致。
  /// 抛异常由 ModelProviderCard 捕获并展示「保存失败」。
  Future<void> _saveCloudBinding(ModelConfigDraft draft) async {
    final String base = draft.baseUrl.trim();
    if (!base.startsWith("https://")) {
      throw Exception("接口地址必须以 https:// 开头（服务器拒绝明文来源的 Key）");
    }
    await CloudModelBindingStore.instance.save(
      baseUrl: base,
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
    );
  }

  Future<void> _clearCloudModelConfig() async {
    await CloudModelBindingStore.instance.clear();
    if (!mounted) return;
    setState(() {
      _cloudConfigured = false;
      _cloudMsg = "已停用自有模型，恢复使用平台默认模型";
    });
  }

  Future<void> _refreshVoiceprintStatus() async {
    final Map<String, dynamic> status = await VoiceprintApi.status();
    if (!mounted) return;
    setState(() => _vpStatus = status);
  }

  Future<void> _refreshMailStatus() async {
    final Map<String, dynamic> res = await MailWatchApi.status();
    if (!mounted) return;
    setState(
      () => _mailStatus =
          res["status"] is Map ? res["status"] as Map<String, dynamic> : null,
    );
  }

  /// 已接入时把服务端存着的授权码回填进输入框（默认打码，眼睛钮显隐）。
  Future<void> _loadMailPassPrefill() async {
    final Map<String, dynamic> cfg = await MailWatchApi.serviceConfig();
    if (!mounted) return;
    final Map<String, dynamic> mail = cfg["mail"] is Map
        ? cfg["mail"] as Map<String, dynamic>
        : const <String, dynamic>{};
    final String key = mail["keyValue"]?.toString() ?? "";
    if (key.isNotEmpty) setState(() => _mailPassCtrl.text = key);
  }

  /// 授权码保存：PUT /api/service-config（mail 块）——服务端落盘 data/service-config.json
  /// 并即刻启动 IMAP 轮询（无需重启 runtime；重启后由服务端重放配置继续生效）。
  Future<void> _saveMailPass() async {
    if (_mailSaving) return;
    final String pass = _mailPassCtrl.text.trim();
    if (pass.isEmpty) {
      setState(() => _mailSaveMsg = "授权码不能为空");
      return;
    }
    setState(() {
      _mailSaving = true;
      _mailSaveMsg = null;
    });
    try {
      final Map<String, dynamic> saved = await MailWatchApi.savePass(pass);
      if (saved["ok"] != true) {
        if (!mounted) return;
        setState(() => _mailSaveMsg = saved["error"]?.toString() ?? "保存失败");
        return;
      }
      // 即刻生效后的真实状态（running/reason）以服务端快照为准
      final Map<String, dynamic> res = await MailWatchApi.status();
      final Map<String, dynamic> st =
          res["status"] is Map ? res["status"] as Map<String, dynamic> : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _mailStatus = st;
        _mailSaveMsg = st["running"] == true
            ? "已接通，正在盯邮箱"
            : "已保存，但未启动：${st["reason"] ?? "未知原因"}";
      });
      // 回填服务端实际生效的授权码（输入框与已存值保持一致，默认打码）
      await _loadMailPassPrefill();
    } catch (e) {
      if (!mounted) return;
      setState(() => _mailSaveMsg = "保存失败：$e");
    } finally {
      if (mounted) setState(() => _mailSaving = false);
    }
  }

  /// 落盘由 ModelProviderCard 校验后回调；这里写 config.env 并重启本地引擎生效。
  Future<void> _saveModelConfig(ModelConfigDraft draft) async {
    await LocalRuntimeConfig.writeModelConfig(
      apiKey: draft.apiKey,
      baseUrl: draft.baseUrl,
      model: draft.model,
    );
    if (!kIsWeb && LocalRuntimeManager.isBundled) {
      await LocalRuntimeManager.restart().timeout(const Duration(seconds: 30));
    }
  }

  /// 直达声纹注册页（无需经语音模式触发）。注册完成同步语音球状态并刷新本卡。
  Future<void> _openVoiceprintRegistration() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext ctx) => VoiceprintRegistrationPage(
          userId: ApiConfig.effectiveActorId,
          onRegistrationComplete: () {
            Navigator.of(ctx).pop();
            AgentSphereVoiceController.instance.markVoiceprintRegistered();
          },
        ),
      ),
    );
    if (mounted) await _refreshVoiceprintStatus();
  }

  Future<void> _clearVoiceprint() async {
    if (_vpClearing) return;
    setState(() => _vpClearing = true);
    final bool ok = await VoiceprintApi.unregister();
    if (!mounted) return;
    setState(() => _vpClearing = false);
    await _refreshVoiceprintStatus();
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(ok ? "声纹已清除" : "清除失败（本地 runtime 不可达？）"), duration: const Duration(seconds: 2)),
    );
  }

  Widget _buildModelSection() {
    return Column(
      children: <Widget>[
        _buildModelCard(),
        const SizedBox(height: 16),
        _buildVoiceprintCard(),
      ],
    );
  }

  /// 「服务接入」分区：每个需要用户自行接入的外部服务一块胶囊组件
  /// （邮箱盯梢 → 填 IMAP 授权码；后续新增接入方在此追加胶囊）。
  Widget _buildServiceAccessSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          "这些服务需要你自己接入一次，接好后 Agent 才能用上对应能力。",
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 14),
        _buildMailCapsule(),
      ],
    );
  }

  Widget _buildMailCapsule() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool running = _mailStatus?["running"] == true;
    final String user = String.fromCharCodes(
      ((_mailStatus?["user"] ?? "") as String).codeUnits,
    );
    final String reason = (_mailStatus?["reason"] ?? "") as String;
    final String? guideUrl = mailGuideUrl(user);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.mark_email_unread_outlined, size: 18),
                const SizedBox(width: 8),
                Text("邮箱盯梢", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text(
                  running ? "盯梢中" : "未接通",
                  style: TextStyle(
                    fontSize: 12,
                    color: running ? cs.primary : cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              "登录用的邮箱已自动接入。只需填一次 IMAP 授权码（邮箱网页版设置里生成，"
              "不是登录密码），agent 即可帮你盯重要邮件、自动把车票/酒店行程记进日程。",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (user.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              Text("已接入邮箱：$user", style: const TextStyle(fontSize: 12.5)),
            ],
            if (!running && reason.isNotEmpty) ...<Widget>[
              const SizedBox(height: 4),
              Text(reason, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
            ],
            const SizedBox(height: 10),
            // 授权码获取引导：按邮箱域给官方入口直达 + 三步说明
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text(
                    "如何获取授权码？",
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    mailGuideSteps(user),
                    style: const TextStyle(fontSize: 12, height: 1.5),
                  ),
                  if (guideUrl != null) ...<Widget>[
                    const SizedBox(height: 6),
                    InkWell(
                      onTap: () => launchUrl(
                        Uri.parse(guideUrl),
                        mode: LaunchMode.externalApplication,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Icon(Icons.open_in_new, size: 13, color: cs.primary),
                          const SizedBox(width: 4),
                          Text(
                            "打开邮箱设置页",
                            style: TextStyle(
                              fontSize: 12,
                              color: cs.primary,
                              decoration: TextDecoration.underline,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _mailPassCtrl,
              obscureText: _obscureMailPass,
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                labelText: "IMAP 授权码",
                hintText: "邮箱设置里生成的授权码",
                isDense: true,
                suffixIcon: IconButton(
                  icon: Icon(_obscureMailPass ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 18),
                  onPressed: () => setState(() => _obscureMailPass = !_obscureMailPass),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: <Widget>[
                FilledButton(
                  onPressed: _mailSaving ? null : _saveMailPass,
                  child: _mailSaving
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text("保存并接通", style: TextStyle(fontSize: 13)),
                ),
                if (_mailSaveMsg != null) ...<Widget>[
                  const SizedBox(width: 12),
                  Expanded(child: Text(_mailSaveMsg!, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis)),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildModelCard() {
    // 云端连接版：模型跑在云端服务器，byok 卡（写本地 config.env + 重启本地
    // 引擎）不适用——展示用户自有模型三元组表单，随 session.init 上送。
    if (_isCloudEdition) return _buildCloudModelCard();
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.memory_outlined, size: 18),
                const SizedBox(width: 8),
                Text("模型服务", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text(
                  LocalRuntimeConfig.hasApiKey ? "已配置" : "未配置",
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              "选模型服务商，按引导获取 API Key 后填入。仅保存在本机，保存后自动重启本地引擎生效。",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 14),
            ModelProviderCard(
              initialApiKey: _modelInitialKey,
              initialBaseUrl: _modelInitialBase,
              initialModel: _modelInitialModel,
              onSave: _saveModelConfig,
              onSaved: () {
                if (mounted) setState(() {}); // 刷新头部「已配置」状态
              },
            ),
          ],
        ),
      ),
    );
  }

  /// 云端连接版模型卡：一键更换模型（弹窗内目录式选型）。
  /// 接口地址由服务端 /api/model-providers 目录自动匹配下发，不再让用户手填；
  /// Key 只落本机 JSON（与应用凭据同目录），仅 wss 连接时随 session.init 上送。
  Widget _buildCloudModelCard() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String? currentModel = CloudModelBindingStore.instance.model;
    final String? currentBase = CloudModelBindingStore.instance.baseUrl;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.memory_outlined, size: 18),
                const SizedBox(width: 8),
                Text("模型服务", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text(
                  _cloudConfigured
                      ? "已配置 · ${currentModel ?? ""}"
                      : "未配置（用平台默认模型）",
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              "选服务商、填 API Key 即可一键更换模型，接口地址由服务端目录自动匹配，无需手填。"
              "API Key 只保存在本机，仅在加密（wss）连接时上送服务器使用。",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (_cloudConfigured) ...<Widget>[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: cs.outlineVariant),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      "当前模型：${currentModel ?? "-"}",
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      "接口地址 ${currentBase ?? "-"}（自动匹配）",
                      style: TextStyle(
                          fontSize: 12, color: cs.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
            Row(
              children: <Widget>[
                FilledButton.icon(
                  onPressed: _showCloudModelDialog,
                  icon: const Icon(Icons.swap_horiz_rounded, size: 16),
                  label: Text(
                    _cloudConfigured ? "一键更换模型" : "一键接入模型",
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                if (_cloudConfigured) ...<Widget>[
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _clearCloudModelConfig,
                    child: const Text("停用", style: TextStyle(fontSize: 13)),
                  ),
                ],
              ],
            ),
            if (_cloudMsg != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(_cloudMsg!, style: const TextStyle(fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildVoiceprintCard() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool registered = _vpStatus?["registered"] == true;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.graphic_eq_outlined, size: 18),
                const SizedBox(width: 8),
                Text("声纹", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text(
                  registered ? "已录入" : "未录入",
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              registered
                  ? "语音对话与语音控制只响应你录入的声音。清除后需重新录入。"
                  : "录入声纹后，语音对话与控制只响应你的声音。",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            Row(
              children: <Widget>[
                FilledButton(
                  onPressed: _openVoiceprintRegistration,
                  child: Text(registered ? "重新录入" : "录入声纹", style: const TextStyle(fontSize: 13)),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: _vpClearing ? null : (registered ? _clearVoiceprint : _refreshVoiceprintStatus),
                  child: _vpClearing
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(registered ? "清除声纹" : "刷新状态", style: const TextStyle(fontSize: 13)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ //
  // 手机桥接
  // ------------------------------------------------------------------ //

  /// 手机桥接卡：仅 Android 显示。开启后本机作为该用户的「手机执行器」
  /// 接收 Agent 的远程指令（当前支持拨号，拨号前必弹确认窗）。
  Widget _buildPhoneBridgeCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.smartphone_outlined, size: 18),
                const SizedBox(width: 8),
                Text("手机桥接", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                ValueListenableBuilder<PhoneBridgeStatus>(
                  valueListenable: PhoneBridgeService.instance.status,
                  builder: (BuildContext context, PhoneBridgeStatus st, _) {
                    final (String text, Color color) = switch (st) {
                      PhoneBridgeStatus.online => ("已连接", const Color(0xFF22C55E)),
                      PhoneBridgeStatus.connecting => ("连接中", const Color(0xFFF59E0B)),
                      PhoneBridgeStatus.offline => ("未连接", const Color(0xFF9E9E9E)),
                      PhoneBridgeStatus.disabled => ("已关闭", const Color(0xFF9E9E9E)),
                    };
                    return Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: color,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(text, style: Theme.of(context).textTheme.bodySmall),
                      ],
                    );
                  },
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text("允许 Agent 远程访问本机"),
              subtitle: const Text(
                "开启后 Agent 可查询本机信息；远程拨打电话前会先弹出确认窗，由你最终决定是否拨打。",
              ),
              value: PhoneBridgeService.instance.isEnabled,
              onChanged: (bool v) {
                setState(() {});
                unawaited(
                  v
                      ? PhoneBridgeService.instance.enable()
                      : PhoneBridgeService.instance.disable(),
                );
              },
            ),
            _buildCaptureTiles(),
          ],
        ),
      ),
    );
  }

  /// 消息捕捉与定位回传设置（仅桥接开启时展示）。
  Widget _buildCaptureTiles() {
    if (!PhoneBridgeService.instance.isEnabled) {
      return const SizedBox.shrink();
    }
    final String captureSubtitle;
    if (_captureLoading) {
      captureSubtitle = "正在检查通知使用权…";
    } else if (_listenerEnabled) {
      captureSubtitle = _captureQueueSize > 0
          ? "微信/QQ/飞书/短信/邮箱/电商物流等通知将汇总给 Agent（待补报 $_captureQueueSize 条）"
          : "微信/QQ/飞书/短信/邮箱/电商物流等通知将汇总给 Agent，Agent 仅在你询问或重要事项时查看";
    } else {
      captureSubtitle = "需要授予系统「通知使用权」后才能捕捉消息";
    }
    return Column(
      children: <Widget>[
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text("消息捕捉"),
          subtitle: Text(captureSubtitle),
          value: _listenerEnabled,
          onChanged: _listenerEnabled
              ? null // 已授权：捕捉随桥接开关生效，无需单独切换
              : (bool _) async {
                  await PhoneCaptureService.instance.openListenerSettings();
                },
        ),
        if (!_listenerEnabled && !_captureLoading)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () async {
                await PhoneCaptureService.instance.openListenerSettings();
                // 授权结果回来后由 didChangeAppLifecycleState(resumed) 自动回检
              },
              child: const Text("去系统设置授权"),
            ),
          ),
        if (_listenerEnabled)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text("扩展捕捉全部应用"),
            subtitle: const Text(
              "白名单外（如银行 App）的通知也捕捉给 Agent，按「其他应用」归类；默认关闭，避免营销通知噪音。",
            ),
            value: _captureAll,
            onChanged: (bool v) {
              setState(() => _captureAll = v);
              unawaited(
                PhoneCaptureService.instance
                    .setCaptureConfig(extraRules: _captureRules, captureAll: v)
                    .then((ok) {
                  if (!ok && mounted) setState(() => _captureAll = !v);
                }),
              );
            },
          ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text("定位低频回传"),
          subtitle: const Text("约 15 分钟一次向服务端回传当前位置，供 Agent 主动感知你的位置；关闭后仅按需定位。"),
          value: PhoneBridgeService.instance.isLocationReportEnabled,
          onChanged: (bool v) {
            setState(() {});
            unawaited(PhoneBridgeService.instance.setLocationReportEnabled(v));
          },
        ),
      ],
    );
  }

  Future<void> _refreshCaptureState() async {
    try {
      final bool enabled = await PhoneCaptureService.instance.isListenerEnabled();
      final int queueSize = await PhoneCaptureService.instance.queueSize();
      final config = enabled ? await PhoneCaptureService.instance.getCaptureConfig() : null;
      if (!mounted) return;
      setState(() {
        _listenerEnabled = enabled;
        _captureQueueSize = queueSize;
        _captureAll = config?.captureAll ?? false;
        _captureRules = config?.extraRules ?? const [];
        _captureLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _captureLoading = false;
        _listenerEnabled = false;
      });
    }
  }

  // ------------------------------------------------------------------ //
  // 通用（Windows 本机行为）
  // ------------------------------------------------------------------ //

  /// 通用卡：开机自动启动。注册表直读直写，不依赖任何服务器加载状态，
  /// 进页即可切；失败回滚开关并 toast。
  Widget _buildGeneralCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.tune_outlined, size: 18),
                const SizedBox(width: 8),
                Text("本机行为", style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text("开机自动启动"),
              subtitle: const Text(
                "登录 Windows 时自动启动应用",
              ),
              value: _autoStart,
              onChanged: _toggleAutoStart,
            ),
          ],
        ),
      ),
    );
  }
}
