import "dart:async";
import "dart:convert";
import "dart:developer" as developer;
import "dart:io";

import "package:file_picker/file_picker.dart";
import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:permission_handler/permission_handler.dart";
import "package:window_manager/window_manager.dart";

import "app/ambient_feeds_controller.dart";
import "app/chat_turn_controller.dart";
import "app/phone_call_controller.dart";
import "core/config/api_config.dart";
import "core/theme/app_theme.dart";
import "core/presentation/location_permission_dialog.dart";
import "core/presentation/client_update_dialog.dart";
import "core/presentation/dynamic_island.dart";
import "core/presentation/dynamic_island_stage_e2e.dart";
import "core/presentation/dynamic_island_reminder_e2e.dart";
import "core/presentation/glass_notify.dart";
import "core/presentation/update_result_card.dart";
import "core/presentation/voice_call_ui_labels.dart";
import "core/presentation/boot_animation.dart";
import "core/db/isar_local_history_store.dart";
import "core/models/agent_relay_models.dart";
import "core/models/chat_models.dart";
import "core/models/schedule_models.dart";
import "core/models/wallet_models.dart";
import "core/models/turn_state.dart";
import "core/utils/agent_result_parser.dart";
import "core/utils/assistant_text_sanitizer.dart";
import "core/utils/content_summary_parser.dart";
import "core/services/app_auto_start.dart";
import "core/services/app_tray_service.dart";
import "core/services/client_update_checker.dart";
import "core/services/local_runtime_config.dart";
import "core/services/local_runtime_manager.dart";
import "core/presentation/api_key_setup_dialog.dart";
import "core/services/schedule_api_client.dart";
import "core/services/schedule_offline_delete_queue.dart";
import "core/services/schedule_reminder_sync.dart";
import "core/services/world_api_client.dart";
import "core/services/client_location_service.dart";
import "core/services/agent_sphere_mood_bridge.dart";
import "core/services/agent_sphere_embodiment_mapper.dart";
import "core/services/sphere_embodiment_motion_bridge.dart";
import "core/services/agent_sphere_interact_bridge.dart";
import "core/services/desktop_bridge_service.dart";
import "core/services/phone_bridge_service.dart";
import "core/services/sphere_entity_controller.dart";
import "core/services/user_avatar_api.dart";
import "core/services/user_preferences_api.dart";
import "core/services/image_preview_launcher.dart";
import "core/services/video_preview_launcher.dart";
import "core/services/content_summary_launcher.dart";
import "core/services/windows_webview_bootstrap.dart";
import "core/services/window_bounds_preference.dart";
import "core/services/shared_browser_host.dart";
import "core/services/ws_chat_service.dart";
import "core/services/inbox_api.dart";
import "core/services/control_plane_account.dart";
import "core/services/account_session_store.dart";
import "mobile_ui/mobile_login_page.dart";
import "mobile_ui/mobile_home.dart";
import "mobile_ui/mobile_theme.dart";
import "core/utils/play_url_utils.dart";
import "features/catalog/catalog_page.dart";
import "features/help/feedback_dialog.dart";
import "features/browser/browser_page.dart";
import "features/gallery/gallery_workbench_page.dart";
import "features/gallery/gallery_wall_host.dart";
import "features/mailbox/mailbox_page.dart";
import "features/mailbox/message_hub_page.dart";
import "features/onboarding/onboarding_flow.dart";
import "features/chat/agent_profile_page.dart";
import "features/chat/agent_home_page.dart";
import "features/chat/chat_page.dart";
import "features/chat/chat_layout.dart";
import "features/chat/content_summary_detail_modal.dart";
import "features/chat/content_summary_detail_view.dart";
import "features/chat/travel_plan_launcher.dart";
import "features/chat/travel_ask_launcher.dart";
import "features/chat/travel_plan_window.dart";
import "features/chat/travel_plan_archive.dart";
import "features/chat/travel_plan_mobile_page.dart";
import "features/chat/travel_plan_models.dart";
import "features/chat/travel_plan_panel.dart";
import "features/chat/travel_web_panel_host.dart";
import "features/chat/right_side_panel.dart";
import "core/services/split_ratio_preference.dart";
import "features/chat/sidebar_user_menu.dart";
import "features/chat/floating_agent_sphere.dart";
import "features/chat/morning_briefing_card.dart";
import "features/chat/voiceprint_registration_page.dart";
import "core/services/agent_sphere_voice_controller.dart";
import "core/services/connected_call_launcher.dart";
import "core/services/briefing_delivery_api.dart";
import "features/briefing/daily_briefing_window.dart";
import "core/services/incoming_call_launcher.dart";
import "core/services/phone_call_session.dart";
import "core/services/pure_voice_mode.dart";
import "core/presentation/phone_call_page.dart";
import "core/services/local_notification_service.dart";
import "core/services/media_playback_service.dart";
import "core/services/mobile_briefing_launcher.dart";
import "core/services/presence_gate_service.dart";
import "core/services/mobile_push_service.dart";
import "core/services/outgoing_call_launcher.dart";
import "core/services/tts_player.dart";
import "core/services/windows_titlebar_theme.dart";
import "features/devices/devices_page.dart";
import "features/settings/settings_page.dart";
import "features/approvals/approvals_panel.dart";
import "core/services/access_auth_api.dart";
import "core/services/attention_api.dart";
import "core/vision/pick_gallery_vision.dart";
import "core/vision/vision_wire_frame.dart";
import "features/schedule/schedule_page.dart";
// 闹钟/即时提醒引擎（docs/mobile-agent-reminder-alarm-design.md）：
// 触发主路 = 客户端本地精确闹钟；alarm.sync/trigger/deliver 服务端事件在此收口
import "features/alarm/alarm_engine.dart";
import "features/alarm/alarm_platform.dart";
import "features/chat/image_preview_panel.dart";
import "features/chat/video_preview_panel.dart";
import "features/auth/register_page.dart";
import "app/app_helpers.dart";
import "widgets/app_sidebar.dart";
import "widgets/app_window_titlebar.dart";

void main() async {
  _installGlobalErrorHooks();
  runZonedGuarded(() async {
    WidgetsFlutterBinding.ensureInitialized();
    // 行程规划独立窗口模式：主应用 spawn 本 exe 并经环境变量传递信箱目录，
    // 命中即只运行行程窗口，不 bootstrap 完整应用（见 travel_plan_window.dart）。
    // 窗口进程常驻：再次打开行程时主应用只写信箱指针，不再重复 spawn。
    final String? travelWindowMailbox =
        Platform.environment[kTravelPlanWindowEnv];
    _writeCrashLog("[START]", "app booting", StackTrace.current);
    if (travelWindowMailbox != null && travelWindowMailbox.isNotEmpty) {
      await runTravelPlanWindow(travelWindowMailbox);
      return;
    }
    // 今日简报独立窗口模式：主应用 spawn 本 exe 并经环境变量传递载荷文件，
    // 命中即只运行简报悬浮窗，不 bootstrap 完整应用（见
    // features/briefing/daily_briefing_window.dart）。
    final String? briefingWindowPayload =
        Platform.environment[kDailyBriefingWindowEnv];
    if (briefingWindowPayload != null && briefingWindowPayload.isNotEmpty) {
      await runDailyBriefingWindow(briefingWindowPayload);
      return;
    }
    // 注册界面独立预览模式：只渲染注册页，不 bootstrap 主应用任何服务
    // （设计还原/真机验收用，见 features/auth/register_page.dart）。
    final String? registerPreview = Platform.environment[kRegisterPreviewEnv];
    if (registerPreview == "1") {
      await runRegisterPreviewWindow();
      return;
    }
    // 预加载本机访问凭据（token），确保首次 session.init 就能带上
    _writeCrashLog("[BOOT]", "stage 1: before AccessCredentialStore.load", StackTrace.current);
    await AccessCredentialStore.instance.load();
    _writeCrashLog("[BOOT]", "stage 2: after cred load, before webview bootstrap", StackTrace.current);
    // WebView2 环境进程内只初始化一次：若用户开启了共用浏览器 CDP 调试端口
    // （SharedBrowserHost.remoteDebugPort），必须在这里一并传入，晚于首次
    // 环境初始化则不再生效。默认 null（CDP 桥关闭）。
    final int? sbDebugPort = SharedBrowserHost.instance.remoteDebugPort;
    unawaited(bootstrapWindowsWebView(
      additionalArguments:
          sbDebugPort == null ? null : "--remote-debugging-port=$sbDebugPort",
    ));
    if (Platform.isWindows || Platform.isMacOS || Platform.isLinux) {
      _writeCrashLog("[BOOT]", "stage 3: before windowManager.ensureInitialized", StackTrace.current);
      await windowManager.ensureInitialized();
      _writeCrashLog("[BOOT]", "stage 4: before loadRestorableWindowBounds", StackTrace.current);
      // 「固定打开时的大小 + 每次打开都在桌面正中间」：首次启动（无历史）
      // 在默认 1280x800 基础上向外扩展 0.1 倍（→1408x880，屏幕放不下则
      // 钳到工作区内）；之后沿用上次关闭前的窗口大小与最大化状态，但
      // 位置一律重新放到主显示器工作区正中间，上次的位置不再还原。
      // WindowOptions 没有 position 字段，位置在 readyToShow 回调里设置。
      final WindowBounds? savedBounds = await loadRestorableWindowBounds();
      final Size initialSize = savedBounds == null
          ? await firstLaunchWindowSize()
          : Size(savedBounds.width, savedBounds.height);
      final Offset? centeredPosition =
          await desktopCenteredPosition(initialSize);
      _writeCrashLog("[BOOT]", "stage 5: before waitUntilReadyToShow", StackTrace.current);
      final WindowOptions options = WindowOptions(
        size: initialSize,
        backgroundColor: Colors.transparent,
        skipTaskbar: false,
        // 隐藏原生标题栏，由自绘的 AppWindowTitleBar 接管
        // （拖拽区 + 最小化/最大化/关闭按钮）。
        titleBarStyle: TitleBarStyle.hidden,
      );
      await windowManager.waitUntilReadyToShow(options, () async {
        if (centeredPosition != null) {
          await windowManager.setPosition(centeredPosition);
        } else {
          // 主显示器信息拿不到时的兜底居中。
          await windowManager.center();
        }
        if (savedBounds?.maximized ?? false) {
          // SW_MAXIMIZE 会顺带显示窗口，随后的 show() 是无害的幂等调用。
          // 先摆好居中的还原态矩形再最大化，取消最大化后回到正中间。
          await windowManager.maximize();
        }
        await windowManager.show();
        await windowManager.focus();
        windowManager.addListener(WindowBoundsSaver.instance);
        // 点 X 后台驻留 + 系统托盘（隐藏时经托盘恢复/退出）。
        await AppTrayService.instance.init();
      });
      _writeCrashLog("[BOOT]", "stage 6: after waitUntilReadyToShow, before runApp", StackTrace.current);
    }
    _writeCrashLog("[BOOT]", "stage 7: calling runApp", StackTrace.current);
    runApp(const PrivateAiApp());
  }, (error, stack) {
    // 兜底所有未捕获的异步异常，防止 Flutter engine 断连崩溃
    _writeCrashLog("[UNCAUGHT-ZONE]", error, stack);
    debugPrint('[UNCAUGHT] $error\n$stack');
  });
}

/// 全局错误兜底：把 Dart/Flutter 侧所有致命错误写入本地日志文件。
/// Windows 下 main.cpp 已把 stderr 重定向到 NUL，崩溃信息默认无处可查；
/// 落盘后可定位「应用退出」的确切前端位置与堆栈。
void _installGlobalErrorHooks() {
  // 构建/布局/绘制阶段异常（默认只弹红色错误屏，不落盘）
  FlutterError.onError = (FlutterErrorDetails details) {
    _writeCrashLog(
      "[FlutterError]",
      details.exception,
      details.stack ?? StackTrace.current,
    );
    FlutterError.presentError(details);
  };
  // 平台调度器层的未捕获致命错误（无法被 runZonedGuarded 捕获）
  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    _writeCrashLog("[PlatformDispatcher]", error, stack);
    return true; // 阻止默认的致命退出路径，让应用尽量继续运行
  };
}

File? _crashLogFile;

/// 崩溃日志目标文件：%TEMP%/pai_app_crash.log
File _crashLogTarget() {
  final File? cached = _crashLogFile;
  if (cached != null) return cached;
  final String dir = Platform.environment["TEMP"] ??
      (Platform.environment["TMP"] ?? Directory.systemTemp.path);
  final File file = File("$dir${Platform.pathSeparator}pai_app_crash.log");
  _crashLogFile = file;
  return file;
}

void _writeCrashLog(String tag, Object error, [StackTrace? stack]) {
  try {
    final String line = "${DateTime.now().toIso8601String()} $tag $error\n"
        "${stack == null ? "" : "$stack\n"}"
        "----------------------------------------\n";
    _crashLogTarget()
        .writeAsStringSync(line, mode: FileMode.append, flush: true);
  } catch (_) {
    // 写日志失败不影响应用运行
  }
}

/// side 模式下 NextbotChatLayout 内嵌的 [VerticalDragDivider] 宽度。
/// 与 [NextbotChatLayout] 内部 `_dividerWidth` 保持一致。
const double _kSidePanelDividerWidth = 8.0;

// ===== 真·分绿泡（2026-09-28）：气泡拆分消息 id 工具 =====
//
// 服务端 BubbleTracker 给每个气泡分配独立 messageId：`assistant-<traceId>-b<N>`。
// 刻意避开历史垫词气泡的 `interim-` 保留前缀（bootstrap 去重按该前缀剔除旧垫词条）。

final RegExp _bubbleMessageIdPattern = RegExp(r"^assistant-(.+)-b(\d+)$");

/// 是否为分泡消息 id（assistant-<traceId>-bN）。
bool _isBubbleMessageId(String messageId) =>
    _bubbleMessageIdPattern.hasMatch(messageId);

/// 从分泡消息 id 提取轮次 traceId；非分泡 id 返回 null。
String? _bubbleTraceOf(String messageId) {
  final Match? m = _bubbleMessageIdPattern.firstMatch(messageId);
  return m?.group(1);
}

class PrivateAiApp extends StatefulWidget {
  const PrivateAiApp({super.key});

  @override
  State<PrivateAiApp> createState() => _PrivateAiAppState();
}

class _PrivateAiAppState extends State<PrivateAiApp>
    with WidgetsBindingObserver {
  final GlobalKey<NavigatorState> _rootNavigatorKey =
      GlobalKey<NavigatorState>();
  // 注册门禁专用：见 _buildRegisterGate 内注释（禁止与主应用共享）
  final GlobalKey<NavigatorState> _gateNavigatorKey =
      GlobalKey<NavigatorState>();
  // 手机主壳专用：登录门禁 → 主壳互斥切换同属跨 MaterialApp 换挂，
  // 共享 GlobalKey 会触发 Navigator 收养重挂（见 _buildRegisterGate 注释）
  final GlobalKey<NavigatorState> _mobileMainNavigatorKey =
      GlobalKey<NavigatorState>();
  final IsarLocalHistoryStore _store =
      IsarLocalHistoryStore(userPin: ApiConfig.localPin);
  final WsChatService _ws = WsChatService(url: ApiConfig.wsUrl);
  final WorldApiClient _worldApi = WorldApiClient(baseUrl: ApiConfig.httpBase);
  // 站内信：拉取/已读（快捷查看 UI 在用户菜单「站内信」消息框，列表 UI
  // 也在邮箱页；这里负责收到 inbox.message 的提醒与已读回执）
  final InboxApi _inboxApi = InboxApi();
  final ScheduleApiClient _scheduleApi =
      ScheduleApiClient(baseUrl: ApiConfig.httpBase);
  final CatalogApiClient _catalogApi =
      CatalogApiClient(baseUrl: ApiConfig.httpBase);
  final UserPreferencesApi _preferencesApi =
      UserPreferencesApi(baseUrl: ApiConfig.httpBase);
  final BriefingDeliveryApi _briefingDeliveryApi =
      BriefingDeliveryApi(baseUrl: ApiConfig.httpBase);
  final ValueNotifier<int> _scheduleReloadSignal = ValueNotifier<int>(0);

  /// 缓存日程 Future，避免每次 build 重建导致 FutureBuilder 反复重置为 waiting（卡片闪烁/震动）
  Future<List<ScheduleEvent>>? _cachedScheduleFuture;
  final TextEditingController _inputController = TextEditingController();
  final FocusNode _inputFocusNode = FocusNode();

  /// `null` 尚未询问；`true` 随消息静默抓拍；`false` 仅文字模式
  // ignore: unused_field
  bool? _visionCameraConsent;

  /// 用户从相册/文件选取、待发的图（可多张，优先于摄像头帧）)
  final List<VisionWireFrame> _pendingGalleryFrames = <VisionWireFrame>[];

  /// 本会话已发送用户消息的配图字节（按 messageId），供气泡渲染缩略图，
  /// 让用户确认「图发出去了、发的是这几张」。仅内存态不持久化，
  /// 超出上限丢最旧；历史加载的消息在气泡上回退为「配图 ×N」文案。
  final Map<String, List<Uint8List>> _sentGalleryImageBytes =
      <String, List<Uint8List>>{};

  /// 发送失败（WS 未就绪 sendEvent 被拒）的用户消息 id，气泡头部显示「未发出」。
  final Set<String> _failedUserMessageIds = <String>{};

  final List<ChatMessage> _messages = <ChatMessage>[];
  final Map<String, int> _assistantMessageIndexById = <String, int>{};
  final Map<String, String> _pendingPlayUrlByTraceId = <String, String>{};
  final List<WalletLedgerItem> _ledger = <WalletLedgerItem>[];
  final List<AgentRelayMessage> _relayInbound = <AgentRelayMessage>[];
  double _balance = 1000;
  double _frozen = 0;
  int _tabIndex = 0;

  /// 用户给agent起的名字
  String? _agentName;
  AgentProfileData _agentProfile = const AgentProfileData(
    displayName: "AI助手",
    handle: "ai_agent",
    signature: "今天也在认真发光。",
    avatarUrl: null,
    moodStyle: UserPreferencesApi.moodGentle,
    statusText: "刚把今天的对话别在衣领上，准备继续陪你往下走。",
    avatarPreset: "dawn",
    lastProfileEvent: "这是 Agent 当前默认的主页状态。",
    updatedAt: null,
  );

  /// 当前用户在「主题」菜单里选中的模式
  /// (light → warm, dark → dark, system → 跟随 MediaQuery.platformBrightness)
  ///
  /// 初始值从 [AppThemeController] 反推:
  /// warm → light, dark → dark。系统跟随模式不会被反推出来,
  /// 因为 AppThemeController 只记实际渲染的两个 variant。
  ThemeChoice _themeChoice =
      AppThemeController.instance.value == AppThemeVariant.warm
          ? ThemeChoice.light
          : ThemeChoice.dark;

  /// 当前右侧面板要展示的内容
  /// - null: 未打开
  /// - RightPanelKind.friends:     好友（MailboxPage）
  /// - RightPanelKind.messages:   消息聚合（MessageHubPage）——入口已撤
  ///   （2026-10-14，消息统一后台扫描按价值主动推送），枚举分支保留，
  ///   无 UI 触发点。
  RightPanelKind? _rightPanel;

  /// 图片预览面板当前要展示的图片快照（来自媒体卡点击）。
  ImagePreviewSnapshot? _imagePreview;

  /// 视频播放面板当前要播放的视频快照（来自视频卡点击）。
  VideoPreviewSnapshot? _videoPreview;

  /// 内容详情面板当前要展示的摘要数据（来自详情卡点击）。
  ContentSummaryDataV2? _contentSummary;

  /// 左聊天区 / 右分栏面板 的宽度比例（0.1~0.9），持久化到本地。
  double _splitRatio = SplitRatioPreference.defaultRatio;

  /// 保存打开面板前的 splitRatio，用于关闭时恢复
  double _previousSplitRatio = SplitRatioPreference.defaultRatio;

  /// 保存打开面板前的 side 模式右面板总占位（含 8px 拖拽条），
  /// 关闭时恢复——避免工具面板打开期间被 split 模式改写后回不去。
  double _previousRightPanelWidth =
      kRightSidePanelWidth + _kSidePanelDividerWidth;

  /// split 模式下右面板的实际宽度，由 [NextbotChatLayout] 通过
  /// [NextbotChatLayout.onRightPanelWidthChanged] 同步过来，
  /// 用于给 AppBar / Sidebar 等加右边距，避免右面板覆盖顶部栏。
  ///
  /// 语义为"总右占位"：side 模式下包含 8px 拖拽条 + [kRightSidePanelWidth] 的
  /// 面板内容(220+8=228)，split 模式即 chat_layout 报告的 rightWidth。
  double _rightPanelWidth = kRightSidePanelWidth + _kSidePanelDividerWidth;

  /// 站内信未读轮询定时器（MessageHub 前端陈列撤除后仅服务站内信角标）。
  Timer? _messagePollTimer;

  /// 站内信（平台→用户收件箱）未读数：随消息轮询刷新 + WS 推送即时 +1，
  /// 进侧栏「站内信」红点角标。
  int _inboxUnread = 0;

  /// 关闭右侧面板
  void _closeRightPanel() {
    if (_rightPanel == null) return;
    setState(() {
      _rightPanel = null;
      // 恢复打开面板前的 splitRatio
      _splitRatio = _previousSplitRatio;
      // 恢复打开面板前的 side 模式右面板总占位（含 8px 拖拽条），
      // 避免工具面板打开期间被 split 模式把宽度改写后回不去。
      _rightPanelWidth = _previousRightPanelWidth;
    });
  }

  /// 「创建日程」等面板内的创建入口收敛到对话：
  /// 关闭面板回到聊天页，并聚焦输入框让用户直接自然语言输入。
  void _focusChatInput() {
    _closeRightPanel();
    if (_tabIndex != 0) {
      setState(() => _tabIndex = 0);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _inputFocusNode.requestFocus();
    });
  }

  /// 加载持久化的分栏比例。
  void _loadSplitRatio() {
    SplitRatioPreference.load().then((double r) {
      if (mounted && (r - _splitRatio).abs() > 0.001) {
        setState(() => _splitRatio = r);
      }
    });
  }

  /// 拖动分割条时更新比例（节流写盘）。
  void _setSplitRatio(double r) {
    final double clamped = r.clamp(0.1, 0.9);
    if ((clamped - _splitRatio).abs() < 0.001) return;
    setState(() => _splitRatio = clamped);
    SplitRatioPreference.save(clamped);
  }

  /// 同步右面板实际宽度（来自 [NextbotChatLayout] 的 onRightPanelWidthChanged）。
  void _setRightPanelWidth(double width) {
    if ((width - _rightPanelWidth).abs() < 0.5) return;
    setState(() => _rightPanelWidth = width);
  }

  /// 日历面板重新加载信号
  final ValueNotifier<int> _calendarReloadSignal = ValueNotifier<int>(0);

  /// 与 userId 对齐的电脑桥接在线状态（由服务端 `desktop.bridge.sync` 推送）
  // ignore: unused_field
  bool? _desktopBridgeOnline;
  String? _desktopBridgeLastSummary;

  /// 是否已初始化完成
  bool _isInitialized = false;

  /// 本机账号会话：null = 未注册/已退出登录 → 启动与退出后停在注册页。
  /// 重量级初始化不依赖它，读盘独立先行，注册页能赶在 init 完成前亮出。
  String? _accountEmail;
  bool _sessionLoaded = false;

  /// 用户头像相对路径（服务端 /agent/avatars/...；null = 未设置/拉取失败）。
  /// 启动登录态就绪后拉一次，设置/更换成功后本地即时更新。
  String? _userAvatarPath;

  /// N 开场动画武装位：只在大门放行后播放——已登录冷启动（读盘有会话）
  /// 或注册/登录完成首次切入主界面时置位。未登录停在注册页期间绝不播放。
  bool _playBootAnimation = false;
  bool _bootAnimDone = false;   // 开场动画是否已播完（每次武装前重置）

  /// 首启配置向导：仅当本次登录真正新建了账号（网页回连 fresh=1）时顶在
  /// 主界面之前（进度条开机动画 + 称呼/agent 名同屏 + 模型两步；声纹已删，
  /// 保留 just-in-time 入口）。已注册邮箱在任意机器登录都直达主界面
  /// （2026-10-16），不走本向导。
  bool _needsOnboarding = false;
  bool _onboardingDone = false;
  // 向导专用（与注册门禁同款隔离理由：禁止与主应用共享 GlobalKey）
  final GlobalKey<NavigatorState> _onboardingNavigatorKey =
      GlobalKey<NavigatorState>();

  /// 手机端主壳主题模式（亮/暗/跟随系统）。与桌面端 AppThemeVariant 体系
  /// 解耦——手机主壳（MobileHomePage）用 MobileTheme，主题档互不串扰。
  final ValueNotifier<ThemeMode> _mobileThemeMode =
      ValueNotifier<ThemeMode>(ThemeMode.system);

  /// Agent是否正在处理中（用于显示响应状态指示器)
  bool _isAgentProcessing = false;

  /// 已上报服务端的「处理中 UI」状态，避免重复 WS 事件
  bool? _reportedAgentProcessingUiActive;

  /// 服务端`chat.agent_status` 推送的口语化进度（替换固定「思考中」）
  String? _agentStatusLine;

  /// 当前正在调用的工具名（`tool.call` 置位、`tool.result`/收尾清空）。
  /// 输入框左上角据此展示「球形图标 + 正在调用:xxx」。
  String? _currentToolName;

  /// `chat.agent_status` 携带的可选进度百分比（0-90，长工具心跳推进）。
  /// null = 无进度条（仅文本状态）；非 null = 渲染进度条。
  int? _agentStatusPercent;

  /// 服务端`chat.assistant_interim` 推送的即时确认应答（仅在首条 chunk 之前展示）。
  /// 与 `_agentStatusLine` 并存但生命周期更短：real chunk 一到立即让位。
  String? _interimAckText;

  /// 「分阶段异步对话交互 v2」结构化状态机。
  /// 取代 v1 的 `_interimAckText` 自由短句 + `_agentStatusLine` 自由文本。
  /// 当前为骨架：先在内存里把事件跑通，UI 改造下一轮再做（_ChatPage 接 TurnState）。
  TurnState? _turnState;

  /// 用户消息已发出、服务端 turn_started 抵达前的"本地占位"句柄。
  /// 用于在用户点发送的同一帧立即显示「正在思考…」（不等服务端）。
  TurnState? _pendingLocalTurn;

  /// 跨轮常驻的任务步骤（2026-10-19 handoff）：TurnState 在 done 时被清空，但
  /// 「等用户操作」往往发生在一轮结束之后，所以步骤条独立持有、不随轮次销毁。
  /// 全部完成后由卡片自己隐藏；这里只在收到 plan_step 时合并。
  final List<TurnPlanStep> _planSteps = <TurnPlanStep>[];

  /// 与 Agent 同步委派进行中：屏蔽内部工具对进度条的覆盖
  bool _subAgentDelegationActive = false;

  /// 任务面回执（chat.task_update，2026-09-08 前后台分工对话改造）：
  /// taskId → 对话流内回执消息 id 的注册表；回执消息本身存在 _messages 里
  /// （contentType="task_receipt"，内存态不持久化）。状态迁移原地替换同一
  /// messageId 的消息对象，不在对话流里追加新条目。
  final Map<String, String> _taskReceiptMessageIdByTaskId =
      <String, String>{};

  /// 当前非终态（进行中/等待输入）的任务面任务 id，供状态带聚合展示。
  final TaskPlaneState _taskPlaneState = TaskPlaneState();

  Timer? _assistantChunkFlushTimer;
  String? _pendingAssistantChunkMessageId;

  /// 排队中的用户消息 id（FIFO，豆包式列队发送）。
  /// Agent 处理中收到的新输入不再打断当前轮，而是入队原样发给服务端
  /// （服务端 MessageBatchProcessor 同样按序排队），每条都会得到独立回复；
  /// 服务端开始处理某条时以 chat.turn_started(traceId=消息id) 通知，
  /// 客户端据此把该条从队列晋级为活动轮次（见 _handleTurnStartedV2）。
  final Set<String> _queuedUserMessageIds = <String>{};

  final StringBuffer _pendingAssistantChunkText = StringBuffer();
  final AssistantTextSanitizer _assistantTextSanitizer =
      AssistantTextSanitizer();

  // Phase 2：429 回压指数退避重试状态
  String? _pendingRetryText;
  int _pendingRetryCount = 0;

  /// 网络电话悬浮按钮状态 null=无通话, ringing=正在呼叫, connected=已接通 ended=通话结束
  // ignore: unused_field
  String? _phoneCallStatus;
  String? _phoneCallToActorId;
  /// 当前活跃通话的 callId（phone.call_hangup 等需携带；对话走 realtime 语音通路）
  String? _activeCallId;

  /// 已弹窗处理的「其与 Agent 来电」callId，避免重复弹)
  String? _peerIncomingDialogCallId;

  /// TTS 闹钟（tts_alarm_play）上一次真实起播时刻：服务端渐强循环会在约 10s 内
  /// 连推约 20 个音量步事件，去抖避免音频重叠轰炸；与重复间隔（默认 15s）对齐
  DateTime? _ttsAlarmLastPlayedAt;
  static const int _ttsAlarmMinGapMs = 8000;

  /// 通话中是否静音（与 ConnectedCallWindow 同步）
  // ignore: unused_field
  bool _phoneMuted = false;

  /// 通话中是否免提（与 ConnectedCallWindow 同步）
  // ignore: unused_field
  bool _phoneSpeakerOn = true;
  DateTime? _lastDesktopBriefingAt;
  StreamSubscription<String>? _mobileBriefingTapSub;
  bool _notificationPermissionChecked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // 账号门禁读盘（毫秒级文件读）：未注册先亮注册页，重量级初始化照常并行
    unawaited(_loadAccountSession());
    // debug 构建注册 VM service 扩展：远程直调决策弹窗链路做真机验收
    // （WS 事件无法从脚本侧注入，须走 VM service websocket call extension）
    if (kDebugMode) {
      GlassNotify.debugSelfCapture = true;
      developer.registerExtension("ext.pai.debug.triggerProactiveGlass", (
        String method,
        Map<String, String> parameters,
      ) async {
        final String title = parameters["title"] ?? "玻璃通知验收";
        final String message = parameters["message"] ?? "主动性消息玻璃卡 E2E";
        // 不等待卡片关闭（卡片落对话流即返回），立即返回便于脚本连续触发
        _showProactivePopup(
          title,
          message,
          "debug-${DateTime.now().microsecondsSinceEpoch}",
        );
        return developer.ServiceExtensionResponse.result(jsonEncode(<String, dynamic>{
          "ok": true,
        }));
      });
      debugPrint("[glass-notify] debug extension registered");
    }
    // debug 构建的 VM service 直调通道：注册页表单有 ext.pai.debug.registerFill
    // （register_page.dart）；退出登录同理——全屏遮挡时注入点击不可靠，
    // 「确认框」UI 用截图验收，这里直调跳过确认的退出本体。
    if (kDebugMode) {
      developer.registerExtension("ext.pai.debug.logout", (
        String method,
        Map<String, String> parameters,
      ) async {
        unawaited(Future<void>.sync(() => _performLogout()));
        return developer.ServiceExtensionResponse.result(jsonEncode(<String, dynamic>{
          "ok": true,
        }));
      });
      // 检查更新直调：force=1 跳过会话缓存强查一次。响应带 status 与
      // elapsedMs——缓存命中路径应稳定在个位毫秒（零网络往返）。
      developer.registerExtension("ext.pai.debug.checkUpdate", (
        String method,
        Map<String, String> parameters,
      ) async {
        final Stopwatch sw = Stopwatch()..start();
        final ClientUpdateCheckResult? result =
            await checkClientUpdate(forceRefresh: parameters["force"] == "1");
        sw.stop();
        return developer.ServiceExtensionResponse.result(jsonEncode(<String, dynamic>{
          "status": result?.status.name,
          "localVersion": result?.localVersion,
          "elapsedMs": sw.elapsedMilliseconds,
        }));
      });
      // 分绿泡真机取证直调：走真实 _sendMessage 链路（真实 WS → 服务端分段 →
      // 真实气泡渲染），脚本侧再 PrintWindow 截图取证。
      developer.registerExtension("ext.pai.debug.sendChat", (
        String method,
        Map<String, String> parameters,
      ) async {
        final String text = parameters["text"] ?? "在吗";
        unawaited(_sendMessage(text: text));
        return developer.ServiceExtensionResponse.result(jsonEncode(<String, dynamic>{
          "ok": true,
          "sent": text,
        }));
      });
    }
    // 共用浏览器桥：浏览器宿主经本 ws 回传 browser.bridge.result（jobId 配对）
    SharedBrowserHost.instance.bindSend(_ws.sendEvent);
    // 桌面端独立来电悬浮窗事件绑定
    // 所有来电（无论来源）统一走同一套回调
    // accept  : 用户点了接听 → 拉起主窗 + 等待 call_connecting
    // decline : 用户点了挂断 → 停 TTS + 关窗 + 清状态
    // timeout : 振铃超时（默认 30s）
    // 版本闸（开源版剔除虚拟电话）：以下通话窗口绑定与通话会话钩子全部跳过
    if (!ApiConfig.isOssEdition) {
      IncomingCallLauncher.bindHandlers(
        onAccept: _handleNativeCallAccept,
        onDecline: _handleNativeCallDecline,
        onTimeout: _handleNativeCallTimeout,
      );
      // 手机端全屏通话页：会话动作钩子（语义与桌面原生悬浮窗回调一致）
      PhoneCallSession.instance
        ..transport = _ws.sendEvent
        ..onAccept = _handleNativeCallAccept
        ..onDecline = _handleNativeCallDecline
        ..onHangup = _handlePhonePageHangup
        ..onTimeout = _handleNativeCallTimeout;
    }
    // 加载持久化的分栏比例
    _loadSplitRatio();
    // 桌面端独立"通话中"窗口事件绑定
    // hangup       : 用户点了挂断
    // muteToggle   : 用户点了静音，参数 newMuted
    // speakerToggle: 用户点了免提，参数 newOn
    if (!ApiConfig.isOssEdition) {
      ConnectedCallLauncher.bindHandlers(
        onHangUp: _handleConnectedHangup,
        onMuteToggle: _handleMuteToggle,
        onSpeakerToggle: _handleSpeakerToggle,
      );
    }
    MobileBriefingLauncher.bind();
    // 移动端推送通道：上报 push token（原生侧未接入厂商推送时静默跳过）
    unawaited(MobilePushRegistrar.registerIfNeeded());
    // 注册自愈定时器（2026-10-14）：HMS token 就绪后 60s 内自动完成上报，
    // 无需用户保持前台——就绪事件另有 PushTokenService.onNewToken 系统回调兜底；
    // 已注册时空转（一次字符串比较），成本可忽略。
    if (!kIsWeb && (Platform.isAndroid || Platform.isIOS)) {
      Timer.periodic(const Duration(seconds: 60), (_) {
        unawaited(MobilePushRegistrar.registerIfNeeded());
      });
    }
    _mobileBriefingTapSub =
        MobileBriefingLauncher.payloads.listen((String payload) {
      unawaited(_openBriefingFromPayload(payload));
    });
    if (!ApiConfig.isOssEdition) {
      OutgoingCallLauncher.bindHandlers(onHangUp: _handleOutgoingCallHangup);
    }
    // 右侧双栏「图片预览」面板：媒体卡点击 → 打开右栏大图
    ImagePreviewLauncher.setHandler(_openImagePreview);
    // 右侧双栏「视频播放」面板：视频卡点击 → WebView2 内联播放
    VideoPreviewLauncher.setHandler(_openVideoPreview);
    // 预览面板「在照片墙中查看」：全屏打开图库 + 3D 墙飞到该照片
    ImagePreviewLauncher.onOpenInWall = (String photoId) {
      _openGalleryPanel();
      unawaited(GalleryWallHost.instance.flyToPhoto(photoId));
    };
    // 右侧双栏「内容详情」面板：详情卡（长内容折叠卡）点击 → 右栏继续展示
    ContentSummaryLauncher.setHandler(_openContentSummaryPanel);
    // 「行程规划」：行程卡点击 / autoOpen → 桌面走独立窗口（行迹桌面页
    // 1:1），手机走原生行程页（2026-10-12 起不再用应用内浏览器）；
    // 常用工具「行程」入口 → 应用内行程归档页（_openTravelArchive）。
    // 版本闸：开源版剔除旅游家族，入口不注册
    if (!ApiConfig.isOssEdition) {
      TravelPlanLauncher.setHandler(_openTravelPlanPanel);
    }
    // 「问 Agent」：行程页/归档页 → 回到聊天并预填问题（预填不自动发送，
    // 用户可补充修改）。版本闸随旅游家族一起。
    if (!ApiConfig.isOssEdition) {
      TravelAskLauncher.setHandler((String message) {
        final BuildContext? navCtx = _rootNavigatorKey.currentContext;
        if (navCtx != null && navCtx.mounted) {
          Navigator.of(navCtx).popUntil((Route<dynamic> r) => r.isFirst);
        }
        if (!mounted) return;
        setState(() => _tabIndex = 0);
        _inputController.text = message;
        _inputFocusNode.requestFocus();
      });
    }
    // 行程面板共享 WebView 进程级预加载（2026-10-15 恢复）：WebView2 冷启动
    // （初始化 + 页面加载 + 就绪轮询）是旅游面板首开慢的最大头，提前到启动时
    // 后台跑完，打开卡片/面板零等待。曾因幽灵窗问题禁用——WebView2 内部顶层
    // 窗口滞留会透明拦截其他应用点击；现 runner 常驻 WebViewGhostGuard 看门狗
    // （windows/runner/webview_ghost_window_guardian.cpp，main.cpp Start()）
    // 会自动给任何滞留窗口打点击穿透样式，预加载恢复安全。
    TravelWebPanelHost.preload();
    // 今日安排面板数据刷新：设置（创建/删除）提醒日程后，通过信号刷新右侧面板
    _scheduleReloadSignal.addListener(_onScheduleReloadSignal);
    _configureAmbientFeeds();
    _bootstrap();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // 在场跟踪：手机后台时主动消息走系统通知（类微信），前台走应用内弹窗
    _lifecycleState = state;
    // 记录生命周期切换：若随后进程退出，可据此区分「用户关了窗口/系统杀进程」与「崩溃」。
    // 只写单行状态、不带堆栈——生命周期事件高频触发，带堆栈曾把日志刷到 189MB。
    _writeCrashLog("[LIFECYCLE]", "state=$state");
    // 推送 token 注册自愈（2026-10-14）：回到前台时补一次注册——首装后 HMS
    // token 就绪可能晚于启动重试窗口，用户打开 App 的每个时机都补一次
    // （内部按 actorId 去重，已注册则空转）。
    if (state == AppLifecycleState.resumed &&
        !kIsWeb &&
        (defaultTargetPlatform == TargetPlatform.android ||
            defaultTargetPlatform == TargetPlatform.iOS)) {
      unawaited(MobilePushRegistrar.registerIfNeeded());
    }
    if (state == AppLifecycleState.detached) {
      _writeCrashLog("[EXIT]", "app detached (window closed)");
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    DesktopBridgeService.instance.stop();
    unawaited(AgentSphereVoiceController.instance.dispose());
    unawaited(TtsPlayer.instance.dispose());
    unawaited(_mobileBriefingTapSub?.cancel());
    IncomingCallLauncher.unbind();
    ConnectedCallLauncher.unbind();
    unawaited(MobileBriefingLauncher.unbind());
    OutgoingCallLauncher.unbind();
    _inputFocusNode.dispose();
    _inputController.dispose();
    _scheduleReloadSignal.removeListener(_onScheduleReloadSignal);
    _scheduleReloadSignal.dispose();
    _calendarReloadSignal.dispose();
    _stopMessagePolling();
    _surfaceAutoHideTimer?.cancel();
    _islandScheduleTicker?.cancel();
    _stopContinuousLocationTracking();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    // 移动端系统通知初始化（后台收 WS 消息时用系统通知提醒，类微信）
    await LocalNotificationService.init();
    LocalNotificationService.onOutcome = (String deliveryId, String outcome) {
      AmbientFeedsController.instance.sendProactiveOutcome(deliveryId, outcome);
    };
    try {
      await _store.init();
    } catch (e) {
      debugPrint("[Bootstrap] _store.init() failed: $e");
      // 尝试继续运行，使用空存储
      try {
        await _store.init(); // 重试一次
      } catch (e2) {
        debugPrint("[Bootstrap] _store.init() retry also failed: $e2");
        // 不再抛出，让应用继续运行
      }
    }

    // 一次性清理历史上「裸 taskId」格式的孤儿日程事项（详见 store 注释）。
    // 修复 WS 块后此函数是幂等的：没有孤儿时返回 0。
    try {
      final int removed = await _store.cleanOrphanScheduleEvents();
      if (removed > 0) {
        debugPrint(
            "[schedule] cleaned $removed orphan schedule event(s) on boot");
      }
    } catch (e) {
      debugPrint("[schedule] cleanOrphanScheduleEvents failed: $e");
    }

    // 手机桥接（phone.dial 等）：存储就绪后恢复开关并按需连接桥接 WS。
    // 仅 Android 真机有意义；默认开启，可在设置页关闭。开源版剔除该能力。
    if (!ApiConfig.isOssEdition &&
        !kIsWeb &&
        defaultTargetPlatform == TargetPlatform.android) {
      PhoneBridgeService.instance.bindPreferences(
        read: _store.getPreference,
        write: _store.savePreference,
      );
      unawaited(PhoneBridgeService.instance.restoreAndStart());
    }

    try {
      final int migrated = await _store.migrateAssistantTimestampFrames();
      if (migrated > 0) {
        debugPrint(
            "[chat] sanitized $migrated assistant message(s) with legacy timestamp frames");
      }
    } catch (e) {
      debugPrint("[chat] migrateAssistantTimestampFrames failed: $e");
    }

    try {
      await _store.saveSession(
        ChatSession(
          sessionId: ApiConfig.effectiveActorId,
          title: "默认会话",
          createdAt: DateTime.now(),
        ),
      );
    } catch (e) {
      debugPrint("[Bootstrap] saveSession failed: $e");
      // 继续运行
    }

    final List<ChatMessage> cachedMessages =
        (await _store.listMessages(ApiConfig.effectiveActorId))
            .map(_sanitizeLoadedChatMessage)
            .toList();

    // 修复历史遗留的重复消息：旧版本 saveMessage 按 messageId 直接 append，
    // 同一 messageId 可能在本地 store 里被存成多条（流式入列表 + done 兜底 +
    // 缓存恢复后事件重放等路径叠加），导致「同一条回复渲染两次」。
    // 这里按 messageId 去重保序：同 id 保留内容更完整的一条（文本更长优先，
    // 相同长度则保留时间更晚的一条），并收集被剔除的重复 id 供 store 清理。
    final List<ChatMessage> dedupedMessages = <ChatMessage>[];
    final Map<String, int> messageIndexById = <String, int>{};
    final Set<String> duplicateMessageIds = <String>{};
    for (final ChatMessage m in cachedMessages) {
      final int? existingIdx = messageIndexById[m.messageId];
      if (existingIdx == null) {
        messageIndexById[m.messageId] = dedupedMessages.length;
        dedupedMessages.add(m);
        continue;
      }
      final ChatMessage existing = dedupedMessages[existingIdx];
      // 带媒体卡片（mediaCards/renderBlocks）的一条优先：文本长短不代表完整性，
      // 避免用「文本更长但丢图」的版本覆盖「带图」的版本。
      final bool mHasMedia = _hasRenderableMedia(m);
      final bool existingHasMedia = _hasRenderableMedia(existing);
      if (mHasMedia != existingHasMedia) {
        if (mHasMedia) {
          dedupedMessages[existingIdx] = m;
        }
      } else if (m.text.length > existing.text.length ||
          (m.text.length == existing.text.length &&
              m.timestamp.isAfter(existing.timestamp))) {
        dedupedMessages[existingIdx] = m;
      }
      duplicateMessageIds.add(m.messageId);
    }

    // 内容级去重：修复「同一段正文被渲染成两条消息」的历史遗留。
    // 旧版本服务端把主回复正文既按段推成 interim 消息（interim-$trace-$seq），
    // 又推成 stream 主回复（assistant-$trace），前端会得到内容完全相同的相邻
    // 两条 assistant 消息。仅对相邻 assistant 消息做比较：trim 后文本一致即视为
    // 同一回复的重复渲染，保留先出现的一条（stream 主回复通常更完整），删除
    // 靠后的那条。非相邻消息不做比较，避免误删正常对话中恰好相同的回复。
    final List<ChatMessage> contentDedupedMessages = <ChatMessage>[];
    final Set<String> contentDuplicateMessageIds = <String>{};
    for (final ChatMessage m in dedupedMessages) {
      final ChatMessage? last = contentDedupedMessages.isNotEmpty
          ? contentDedupedMessages.last
          : null;
      final bool isAssistant = m.role == "assistant";
      final String mText = m.text.trim();

      // 历史遗留：旧版本把主回复首个短句作为独立"垫词"气泡(interim-$trace-$seq)
      // 推送，随后又推完整正文(assistant-$trace)。两者相邻且正文以垫词开头 →
      // 内容前缀重叠。此时保留更完整的正文，剔除垫词气泡，避免"垫词 + 全文"双份。
      final bool isInterimPrefixDup = isAssistant &&
          last != null &&
          last.role == "assistant" &&
          last.messageId.startsWith("interim-") &&
          mText.length > last.text.trim().length &&
          mText.startsWith(last.text.trim());
      if (isInterimPrefixDup) {
        contentDuplicateMessageIds.add(last.messageId);
        contentDedupedMessages.removeLast();
        contentDedupedMessages.add(m);
        continue;
      }

      final bool isContentDup = last != null &&
          last.role == "assistant" &&
          isAssistant &&
          // 真·分绿泡：同轮两个分泡恰好同文（如「好。」「好。」连发）是刻意
          // 形态，不视为历史重复渲染，跳过去重（重载后双泡必须都保留）。
          !(_bubbleTraceOf(last.messageId) != null &&
              _bubbleTraceOf(last.messageId) == _bubbleTraceOf(m.messageId)) &&
          last.text.trim() == mText;
      if (isContentDup) {
        contentDuplicateMessageIds.add(m.messageId);
        continue;
      }
      contentDedupedMessages.add(m);
    }
    // 同步清理 store 中内容重复的消息（避免刷新后再次加载出来）
    for (final String messageId in contentDuplicateMessageIds) {
      try {
        await _store.deleteMessage(messageId);
        debugPrint(
            "[chat] dedupe: cleaned content-duplicate messageId=$messageId");
      } catch (e) {
        debugPrint("[chat] content dedupe cleanup failed for $messageId: $e");
      }
    }

    // 真·分绿泡塌缩残留自愈（2026-09-28）：塌缩轮（finalTextReplacesStream）
    // 在流式阶段已把分泡逐条落盘，旧版本塌缩只删内存不删盘 → 重载后
    // "已流分泡 + 塌缩单泡"同框（真机取证：「问了两遍/怕我跑了？」+「对，
    // 就是这周末10月3、4号。」并存）。气泡轮的 chunk 全部带 -bN 后缀，
    // assistant-$traceId 只会由塌缩/兜底路径创建——故"同 trace 既有分泡
    // 又有 assistant-$traceId"即塌缩残留 → 删分泡、保塌缩泡。
    final Map<String, List<ChatMessage>> bubblesByTrace =
        <String, List<ChatMessage>>{};
    for (final ChatMessage m in contentDedupedMessages) {
      final String? t = _bubbleTraceOf(m.messageId);
      if (t != null) {
        (bubblesByTrace[t] ??= <ChatMessage>[]).add(m);
      }
    }
    final Set<String> staleBubbleIds = <String>{};
    if (bubblesByTrace.isNotEmpty) {
      for (final ChatMessage m in contentDedupedMessages) {
        if (m.role != "assistant") continue;
        if (!m.messageId.startsWith("assistant-")) continue;
        if (_isBubbleMessageId(m.messageId)) continue;
        final List<ChatMessage>? stale =
            bubblesByTrace[m.messageId.substring("assistant-".length)];
        if (stale != null) {
          for (final ChatMessage b in stale) {
            staleBubbleIds.add(b.messageId);
          }
        }
      }
    }
    final List<ChatMessage> healedMessages = staleBubbleIds.isEmpty
        ? contentDedupedMessages
        : contentDedupedMessages
            .where((m) => !staleBubbleIds.contains(m.messageId))
            .toList();
    for (final String messageId in staleBubbleIds) {
      try {
        await _store.deleteMessage(messageId);
        debugPrint(
            "[chat] bubble heal: cleaned stale streamed bubble $messageId");
      } catch (e) {
        debugPrint("[chat] bubble heal cleanup failed for $messageId: $e");
      }
    }

    // 简报落聊天流退役自愈（2026-10-02 用户定稿）：对话流不再出现简报消息
    // （早上由桌面悬浮窗卡片直接展示），assistant-briefing-* 历史残留启动即清。
    final Set<String> retiredBriefingIds = <String>{
      for (final ChatMessage m in healedMessages)
        if (m.messageId.startsWith("assistant-briefing-")) m.messageId,
    };
    final List<ChatMessage> displayMessages = retiredBriefingIds.isEmpty
        ? healedMessages
        : healedMessages
            .where((m) => !retiredBriefingIds.contains(m.messageId))
            .toList();
    for (final String messageId in retiredBriefingIds) {
      try {
        await _store.deleteMessage(messageId);
        debugPrint("[briefing] retired chat landing cleaned: $messageId");
      } catch (e) {
        debugPrint(
            "[briefing] retired briefing cleanup failed for $messageId: $e");
      }
    }

    final List<AgentRelayMessage> cachedRelay =
        await _store.listRelayInbound(ApiConfig.effectiveActorId);

    final bool? visionConsent = await _store.getVisionCameraConsent();

    setState(() {
      _messages.addAll(displayMessages);
      // 关键：从缓存恢复后必须重建 assistant 消息索引，
      // 否则后续 chat.assistant_chunk / chat.assistant_done 事件按 messageId
      // 去重时找不到记录，会把同一条 agent 消息重复入列表，造成「同一条回复渲染两次」。
      _rebuildAssistantIndex();
      _relayInbound
        ..clear()
        ..addAll(cachedRelay);
      _visionCameraConsent = visionConsent;
      // 设置agent名字占位符
      _agentName = "AI助手";
      _isInitialized = true;
    });

    // 异步清理本地 store 里已剔除的重复消息（不阻塞首帧渲染）
    if (duplicateMessageIds.isNotEmpty) {
      unawaited(_cleanupDuplicateMessages(
          dedupedMessages, messageIndexById, duplicateMessageIds));
    }

    // 跨端历史回填（2026-10-16）：同一账号在别的设备聊过的轮次，登录后从
    // 服务端 turn WAL 拉回合并（与手机端同一套锚定去重），换机不再丢聊天记录。
    // 不阻塞首帧：本地缓存先上屏，服务端增量随后补插。
    unawaited(_pullServerHistoryIntoStream());

    // 桌面顶部灵动岛：原生窗口 + 控制器绑定（数据全部来自真实事件源）。
    setDynamicIslandActionHandler((String label) {
      if (label == '打开日程') {
        // 到点提醒点击胶囊提前收口的确认出口：唤起主窗口 + 打开日程双栏面板。
        unawaited(windowManager.show());
        unawaited(windowManager.focus());
        if (mounted) _openSchedulePanel();
        return;
      }
      unawaited(windowManager.show());
      unawaited(windowManager.focus());
    });
    unawaited(initDynamicIsland());
    // E2E 专用（--dart-define=PAI_ISLAND_E2E=true 才生效）：三级渐进展开
    // 真机截图回归的数据注入引导，见 dynamic_island_stage_e2e.dart。
    if (const bool.fromEnvironment('PAI_ISLAND_E2E')) {
      unawaited(runIslandStageE2EBootstrap());
    }
    // E2E 专用（--dart-define=PAI_ISLAND_REMINDER_E2E=true）：提醒全屏豁免
    // 真机截图回归的数据注入引导，见 dynamic_island_reminder_e2e.dart。
    if (const bool.fromEnvironment('PAI_ISLAND_REMINDER_E2E')) {
      unawaited(runIslandReminderE2EBootstrap());
    }
    // 日程倒计时每 30s 刷新一次（「25 分钟后」随时间推进），并立即初同步。
    unawaited(_syncIslandSchedule());
    _islandScheduleTicker = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_syncIslandSchedule()),
    );

    unawaited(_loadAgentProfile());
    _onScheduleReloadSignal();
    unawaited(_flushScheduleOfflineDeletes());

    _ws.onConnected = () {
      SphereEmbodimentMotionBridge.instance.setMainAgentLinked(true);
      _sendSessionInit();
      unawaited(_flushScheduleOfflineDeletes());
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.windows) {
        DesktopBridgeService.instance.start();
        unawaited(_tryShowDesktopLaunchBriefing());
      }
      // 闹钟服务端对账（2026-10-13）：每次 WS 连上（含断线重连）都拉一次服务端
      // 活跃闹钟补挂本地——建钟那一刻不在线的闹钟由此收敛进本地库。
      if (!kIsWeb && (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS)) {
        unawaited(AlarmEngine.instance.syncFromServer());
        // 推送 token 重注册：登录后 effectiveActorId 才是真实身份，连接成功
        // 时补一次（内部按 actorId 去重，同身份不重复上报）。
        unawaited(MobilePushRegistrar.registerIfNeeded());
      }
    };
    ClientLocationService.bindPreferences(
      read: _store.getPreference,
      write: _store.savePreference,
    );
    // byok 捆绑形态：先确保本地 runtime 就绪再连 WS（非捆绑/开发形态此调用
    // 立即返回）。WS 自带退避重连，runtime 稍慢也无碍。
    if (!kIsWeb && Platform.isWindows) {
      await LocalRuntimeManager.ensureRunning();
    }
    // 闹钟引擎引导：装载本地闹钟库并全量重排本地精确闹钟（杀进程/重启恢复主路）
    if (!kIsWeb && (Platform.isAndroid || Platform.isIOS)) {
      unawaited(() async {
        await AlarmPlatform.configure(httpBase: ApiConfig.httpBase);
        await AlarmEngine.instance.init(
          actorId: () => ApiConfig.effectiveActorId,
          httpBase: ApiConfig.httpBase,
        );
      }());
    }
    _ws.connect();
    _startMessagePolling();
    // 控制面账号自注册：把当前登录身份（登录邮箱优先）补进管理后台的
    // 收件人列表，否则后台「全体用户」群发站内信时不会包含本机
    // （fire-and-forget；未登录时内部跳过，登录后由 _completeWebAuth 补注册）。
    unawaited(ControlPlaneAccount.ensureRegistered());
    unawaited(_consumePendingMobileBriefingLaunch());
    unawaited(_ensureAndroidNotificationPermission());
    unawaited(_tryShowMobileLaunchBriefing());

    AgentSphereInteractBridge.instance.bind((String action, {String? text}) {
      if (!_ws.isConnected) return;
      _ws.sendEvent("agent.embodiment.interact", <String, dynamic>{
        "sessionId": ApiConfig.effectiveActorId,
        "userId": ApiConfig.effectiveActorId,
        "action": action,
        if (text != null && text.trim().isNotEmpty) "text": text.trim(),
      });
      if (action == "wake" || action == "chat") {
        AgentSphereMoodBridge.instance.listening();
      }
    });

    AgentSphereMoodBridge.instance.addFocusListener(() {
      if (_tabIndex != 0) {
        setState(() => _tabIndex = 0);
      }
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _inputFocusNode.requestFocus();
      });
    });

    final AgentSphereVoiceController voiceCtrl =
        AgentSphereVoiceController.instance;
    voiceCtrl.onRecognizedText = (String text) {
      final String t = text.trim();
      if (t.isEmpty) return;
      _inputController.text = t;
      unawaited(_sendMessage());
    };
    // 纯语音模式（岛=唯一视觉，voice-orb 胶囊已退役）：注入 WS 发送器，
    // mode.changed 上报服务端切投递节奏。识别文本经 voiceCtrl.onRecognizedText
    // 既有回调提交（仅声纹验证通过才会回调）。
    PureVoiceModeController.instance.sendEvent =
        (String type, Map<String, dynamic> payload) {
      _ws.sendEvent(type, payload);
    };
    voiceCtrl.onRequestVoiceprintRegistration = () {
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (BuildContext ctx) => VoiceprintRegistrationPage(
            userId: ApiConfig.effectiveActorId,
            onRegistrationComplete: () {
              Navigator.of(ctx).pop();
              voiceCtrl.markVoiceprintRegistered();
            },
          ),
        ),
      );
    };

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      // 版本检查先于定位询问：强制升级锁（minVersion 之下的旧客户端）必须
      // 先于一切启动弹窗生效，锁死时后续询问不再执行。
      await _checkClientUpdateAtStartup();
      // byok 首启：config.env 无模型 key 时引导填写（不可跳过），保存后重启
      // runtime 使 key 生效。
      if (!kIsWeb && Platform.isWindows && LocalRuntimeManager.isBundled) {
        if (!LocalRuntimeConfig.hasApiKey) {
          final BuildContext? keyCtx = _rootNavigatorKey.currentContext;
          if (keyCtx != null && keyCtx.mounted) {
            final bool? saved = await showApiKeySetupDialog(context: keyCtx);
            if (saved == true) {
              await LocalRuntimeManager.restart();
            }
          }
        }
      }
      await _promptLocationConsentIfNeeded();
      // 启动时静默拉一次定位并上报（无 jobId 纯上报，填充服务端位置缓存供 Agent 复用）。
      // 原由右侧面板天气 Header 触发，组件移除后改由应用启动兜底；
      // Agent 运行中仍可走 agent.location_request 按需再拉。
      unawaited(_reportStartupLocation());
      // 自启重认领：已启用则把 Run 键重写为当前 exe 路径（详见 AppAutoStart.reassert）。
      unawaited(AppAutoStart.reassert());
    });
    _ws.events.listen((Map<String, dynamic> event) async {
      final String type = event["type"] as String? ?? "";
      final Map<String, dynamic> payload =
          (event["payload"] as Map?)?.cast<String, dynamic>() ??
              <String, dynamic>{};
      try {
        _syncAgentSphereFromWs(type, payload);
        // 共用浏览器桥：Agent 的 shared_browser.* 动作转发到内嵌浏览器执行，
        // 结果经 browser.bridge.result 回传（jobId 配对；未命中类型内部直接返回）
        unawaited(SharedBrowserHost.instance.handleServerEvent(type, payload));
        // 媒体音乐播放闭环：agent.media.play/pause/resume/stop 真正出声
        // （session.init 已声明 mediaPlayback 能力；未命中类型内部直接忽略）
        unawaited(MediaPlaybackService.instance.handleMediaEvent(type, payload));
        // 服务端按需请求实时位置：Agent 需要位置时（如天气工具）才拉一次 GPS。
        // 纯坐标秒回（不做客户端逆地理）：服务端拿到坐标后自行反查城市，
        // 避免客户端逆地理 HTTP 把回包拖超时（服务端 requestLocation 只等 12s）。
        if (type == "agent.location_request") {
          final String jobId = payload["jobId"]?.toString() ?? "";
          final ClientLocationPayload? loc =
              await ClientLocationService.getCurrentLocationForAgentReply();
          if (loc != null) {
            _ws.sendEvent("client.location_report", <String, dynamic>{
              if (jobId.isNotEmpty) "jobId": jobId,
              ...loc.toJson(),
            });
          }
        }
        // 持续定位配置（服务端 LOCATION_TRACKING_MODE=continuous 时随 session 绑定下发）：
        // 客户端按 intervalSec 定时上报位置（source:"continuous"），供位置历史/
        // 地理围栏/常去地点挖掘使用。隐私：服务端默认 ondemand 不下发本事件；
        // 即使下发，用户未同意定位时定时器会自行停止。
        if (type == "agent.location_tracking_config") {
          _configureContinuousLocationTracking(payload);
        }
        if (type == "connection_error") {
          SphereEmbodimentMotionBridge.instance.setMainAgentLinked(false);
          final bool hadPendingTurn =
              _isAgentProcessing && ChatTurnController.instance.activeTraceId != null;
          _disarmAgentReplyWatchdog();
          // 连接异常时排队消息可能已随服务端队列丢失：清空排队集合，
          // 重连后若服务端仍在处理，chat.turn_started 会走采纳规则自我修正。
          if (_queuedUserMessageIds.isNotEmpty) {
            _queuedUserMessageIds.clear();
            if (mounted) setState(() {});
          }
          if (hadPendingTurn) {
            _handleAgentReplyTimeout(showSnackBar: false);
          } else {
            ChatTurnController.instance.activeTraceId = null;
            if (_isAgentProcessing || _agentStatusLine != null) {
              _clearAgentProcessingState();
            }
          }
          final String message = payload["message"]?.toString() ?? "无法连接到服务器";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(message),
                action: SnackBarAction(
                  label: "重试",
                  onPressed: _ws.retryConnect,
                ),
              ),
            );
          }
        }
        if (type == "ws_disconnected") {
          SphereEmbodimentMotionBridge.instance.setMainAgentLinked(false);
          // 断线时停掉持续定位定时器，避免离线期间的上报在重连后排队补发；
          // 重连后服务端会随 session.init 重新下发 tracking_config 再启动。
          _stopContinuousLocationTracking();
          if (_isAgentProcessing && ChatTurnController.instance.activeTraceId != null) {
            _disarmAgentReplyWatchdog();
            _handleAgentReplyTimeout(showSnackBar: false);
          }
          if (_queuedUserMessageIds.isNotEmpty) {
            _queuedUserMessageIds.clear();
            if (mounted) setState(() {});
          }
          final String message = payload["message"]?.toString() ?? "与服务器的连接已断开";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(message),
                action: SnackBarAction(
                  label: "重试",
                  onPressed: _ws.retryConnect,
                ),
              ),
            );
          }
        }
        if (type == "ws_connected") {
          // 重连成功：WS 服务层刚把断线期间积压的出站事件（含标记过
          // 「未发出」的消息）补发出去，红标随之撤销，不再误导用户。
          if (_failedUserMessageIds.isNotEmpty) {
            setState(_failedUserMessageIds.clear);
          }
        }
        if (type == "error.event") {
          // 与当前chat 轮次无关的错误需立即解除「思考中」；CHAT_HANDLER_ERROR 仍会→ assistant_done←
          final String? traceId = payload["traceId"]?.toString();
          final bool chatTurnError = traceId != null &&
              traceId.isNotEmpty &&
              traceId == ChatTurnController.instance.activeTraceId;
          if (_isAgentProcessing && !chatTurnError) {
            _disarmAgentReplyWatchdog();
            ChatTurnController.instance.activeTraceId = null;
            _clearAgentProcessingState();
          }
          final String message = payload["message"]?.toString() ?? "服务器处理失败";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(content: Text(message)),
            );
          }
        }
        if (type == "tool.call") {
          if (_isAgentProcessing) {
            final String toolName = payload["toolName"]?.toString() ?? "";
            // 输入框左上角「当前工具」徽标：记录正在调用的工具名
            if (toolName.isNotEmpty && _currentToolName != toolName) {
              setState(() => _currentToolName = toolName);
            } else if (toolName.isNotEmpty) {
              _currentToolName = toolName;
            }
            if (_subAgentDelegationActive &&
                !isMasterInvokeSubAgentTool(toolName)) {
              return;
            }
            final String? userStatusLine =
                payload["userStatusLine"]?.toString().trim();
            final String? preamble =
                payload["assistantPreamble"]?.toString().trim();
            // 行动宣告由 chat.assistant_interim 确定性下发（服务端路由后立即发），
            // 这里 preamble 仅作 userStatusLine 的备选来源走输入框状态行。
            final String line =
                (userStatusLine != null && userStatusLine.isNotEmpty)
                    ? userStatusLine
                    : (preamble != null && preamble.isNotEmpty)
                        ? preamble
                        : "";
            if (isMasterInvokeSubAgentTool(toolName)) {
              _subAgentDelegationActive = true;
            }
            if (line.isNotEmpty) {
              _updateAgentStatusLine(line);
            }
            // hover「任务」页：agent 状态行上岛（步骤流不上岛）。
            final String islandLabel = line.isNotEmpty
                ? line
                : (toolName.isNotEmpty ? toolName : "正在处理");
            DynamicIslandController.instance
              ..setForegroundAgent(active: true)
              ..updateAgentStatusLine(islandLabel);
          }
        }
        if (type == "tool.result") {
          // 当前工具结束，让位给下一把（若链式调用，紧随的 tool.call 会重新置位）
          if (_currentToolName != null) {
            setState(() => _currentToolName = null);
          }
          final Map<String, dynamic>? result =
              (payload["result"] as Map?)?.cast<String, dynamic>();
          final String? playUrl = PlayUrlUtils.fromToolResult(result);
          if (playUrl != null) {
            final String? traceId = payload["traceId"]?.toString();
            if (traceId != null && traceId.isNotEmpty) {
              _pendingPlayUrlByTraceId[traceId] = playUrl;
              _attachPlayUrlToAssistantMessage("assistant-$traceId", playUrl);
            }
          }
          final String toolName = payload["toolName"]?.toString() ?? "";
          final bool toolOk = payload["ok"] == true;
          if (isMasterInvokeSubAgentTool(toolName) && result != null) {
            final bool delegateOk = result["ok"] != false;
            if (!toolOk || !delegateOk) {
              _subAgentDelegationActive = false;
              final String err =
                  result["error"]?.toString().trim() ?? "与 Agent 委派失败，请稍后重试";
              if (err.isNotEmpty) {
                _updateAgentStatusLine(err);
              }
            } else {
              final String? uiDoneLine =
                  result["uiDoneLine"]?.toString().trim();
              if (uiDoneLine != null && uiDoneLine.isNotEmpty) {
                _subAgentDelegationActive = false;
                _updateAgentStatusLine(uiDoneLine);
              } else if (result["background"] == true) {
                _subAgentDelegationActive = false;
                final String bgLine =
                    result["message"]?.toString().trim() ?? "助手已在后台处理，稍后会汇总结果";
                _updateAgentStatusLine(bgLine);
              }
            }
          }
          if (toolOk && result != null) {
            try {
              final String normalizedTool = toolName.replaceAll("_", ".");
              if (normalizedTool == "calendar.delete_task") {
                final String? deletedId = result["taskId"]?.toString();
                if (deletedId != null && deletedId.isNotEmpty) {
                  await removeLocalScheduleForDeletedTask(_store, deletedId);
                  _notifyScheduleViewsChanged();
                }
              } else {
                final bool synced = await upsertLocalScheduleFromToolResult(
                  _store,
                  toolName,
                  result,
                );
                if (synced) {
                  _notifyScheduleViewsChanged();
                }
              }
            } catch (e, st) {
              debugPrint("[schedule] tool.result sync failed: $e\n$st");
            }
          }
        }
        if (type == "chat.audio_transcript") {
          // 服务端 ASR 完成后回推转写结果（与 chat.user_message.contentType=audio 对应）。
          // 把 transcript 写回对应 user 消息的 attachment，让语音气泡直接显示识别文本，
          // 方便用户验证 ASR 准确率 + 留有可读副本。
          final String? msgId = payload["messageId"]?.toString();
          if (msgId == null || msgId.isEmpty) return;
          final String transcript = payload["transcript"]?.toString() ?? "";
          final bool ok = payload["ok"] == true;
          if (!ok && transcript.isEmpty) {
            // ASR 失败：用 snackbar 提示，不静默
            if (mounted) {
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                SnackBar(
                  content: Text(
                    "ASR 识别失败：${payload["error"]?.toString() ?? "未知原因"}",
                  ),
                ),
              );
            }
            return;
          }
          final int idx = _messages.indexWhere(
            (ChatMessage m) => m.messageId == msgId,
          );
          if (idx < 0) return;
          final ChatMessage prev = _messages[idx];
          // 只更新 audio 类型的 attachment；text 字段不动（audio 消息 text 始终为空）
          final List<MessageAttachment> newAttachments = <MessageAttachment>[];
          for (final MessageAttachment a in prev.attachments) {
            if (a.type == MessageAttachmentType.audio) {
              newAttachments.add(MessageAttachment(
                type: a.type,
                url: a.url,
                durationMs: a.durationMs,
                waveform: a.waveform,
                transcript: transcript,
                mimeType: a.mimeType,
              ));
            } else {
              newAttachments.add(a);
            }
          }
          final ChatMessage updated = ChatMessage(
            messageId: prev.messageId,
            sessionId: prev.sessionId,
            role: prev.role,
            text: prev.text,
            timestamp: prev.timestamp,
            attachmentImageCount: prev.attachmentImageCount,
            playUrl: prev.playUrl,
            attachments: newAttachments,
            contentType: prev.contentType,
            durationMs: prev.durationMs,
            waveform: prev.waveform,
            mediaCards: prev.mediaCards,
            renderBlocks: prev.renderBlocks,
            pendingMediaCards: prev.pendingMediaCards,
          );
          setState(() {
            _messages[idx] = updated;
          });
          // 异步持久化（失败也不阻塞 UI；saveMessage 内部按 messageId 覆盖）
          unawaited(_store.saveMessage(updated).catchError((Object e) {
            debugPrint("[chat.audio_transcript] saveMessage failed: $e");
          }));
        }
        if (type == "schedule.tasks_changed") {
          await AmbientFeedsController.instance
              .onScheduleTasksChanged(payload);
        }
        if (type == "schedule.reminder_fired") {
          await AmbientFeedsController.instance
              .onScheduleReminderFired(payload);
        }
        // ====== 闹钟/即时提醒（手机端本地调度主路的服务端事件） ======
        if (type == "alarm.sync" || type == "alarm.trigger" || type == "reminder.deliver") {
          unawaited(
            AlarmEngine.instance.handleServerEvent(type, payload),
          );
        }
        // hub.message_arrived 即时上岛已撤（2026-10-14）：消息类内容统一由
        // agent 后台扫描、判定有价值后走主动提案链路推送，不再每条直展。
        if (type == "surface.show") {
          // Surface-on-Demand：服务端 surface.show 工具召唤桌面悬浮卡。
          // 语音模式下主窗口已隐藏，悬浮窗由本进程独立 HWND 承载，不受影响。
          unawaited(_handleSurfaceShow(payload));
        }
        if (type == "chat.agent_status") {
          final String line = payload["line"]?.toString().trim() ?? "";
          if (line.isEmpty) return;
          final String phase = payload["phase"]?.toString() ?? "";
          // 丢弃「已结束轮次」的迟到状态事件：避免在 chat.assistant_done 之后
          // 子 Agent 收尾或网络排队把 _isAgentProcessing 重新点亮，导致底部
          // 「思考中」气泡和真实回复同框出现。
          final String? statusTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = ChatTurnController.instance.activeTraceId;
          if (statusTraceId == null ||
              statusTraceId.isEmpty ||
              activeTraceId == null ||
              statusTraceId != activeTraceId) {
            return;
          }
          if (phase == "delegate_start") {
            _subAgentDelegationActive = true;
          } else if (phase == "delegate_done") {
            _subAgentDelegationActive = false;
          }
          // 进度百分比（可选）：长工具心跳推进进度条
          final dynamic rawPercent = payload["percent"];
          final int? percent = rawPercent is num ? rawPercent.toInt() : null;
          _updateAgentStatusLine(line,
              ensureProcessing: true, percent: percent);
        }
        if (type == "chat.assistant_interim") {
          // 已废弃：被动聊天路径已改为通过 chat.assistant_chunk + phase="interim"
          // 推送首段文本，与主回复共用同一 messageId，不再作为独立消息入列表。
          // 此分支仅保留兼容旧服务端（主动通知路径仍可能发此事件），直接忽略。
        }
        // ===== 「分阶段异步对话交互 v2」三件套 =====
        if (type == "chat.turn_started") {
          // 阶段 0：服务端确认收到，路由开始。客户端用服务端 t0 替换本地占位，
          // 让首字延迟测量更准。
          _handleTurnStartedV2(payload);
        }
        if (type == "chat.intent_detected") {
          // 阶段 1：意图已识别。结构化 mode / plan / subAgents 落到 TurnState。
          _handleIntentDetectedV2(payload);
        }
        if (type == "chat.execution_event") {
          // 阶段 2：执行事件（工具 / 子 Agent / thought / log）。
          _handleExecutionEventV2(payload);
        }
        // ===== 任务面回执（chat.task_update，前后台分工对话改造）=====
        // 派发 → 对话流内落轻量回执；进度/终态 → 原地更新同一回执。
        // 开关关闭（服务端不发事件）时本分支天然不触发，行为同旧版。
        if (type == "chat.task_update") {
          _handleTaskPlaneUpdate(payload);
        }
        // ===== /v2 =====
        // 会出卡片的轮次不流式：服务端确认本轮将携带结构化卡片（工具附卡/
        // 识图照片/模型自产标记）后，先撤回该 trace 已流出的正文并转静默，
        // 最终内容由 chat.assistant_done 一次性结构化下发（done 载荷强制
        // finalTextReplacesStream=true，整段替换不保留空文本）。
        if (type == "chat.stream_reset") {
          final String? resetTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = ChatTurnController.instance.activeTraceId;
          if (resetTraceId == null ||
              resetTraceId.isEmpty ||
              (activeTraceId != null && resetTraceId != activeTraceId)) {
            return;
          }
          final List<int> resetIdx = <int>[];
          for (int i = 0; i < _messages.length; i++) {
            final ChatMessage m = _messages[i];
            if (!m.streaming || m.text.isEmpty) continue;
            if (m.messageId != "assistant-$resetTraceId" &&
                _bubbleTraceOf(m.messageId) != resetTraceId) {
              continue;
            }
            resetIdx.add(i);
          }
          if (resetIdx.isEmpty) return;
          setState(() {
            for (final int i in resetIdx) {
              final ChatMessage previous = _messages[i];
              _messages[i] = ChatMessage(
                messageId: previous.messageId,
                sessionId: previous.sessionId,
                role: previous.role,
                text: "",
                timestamp: previous.timestamp,
                attachmentImageCount: previous.attachmentImageCount,
                playUrl: previous.playUrl,
                attachments: previous.attachments,
                contentType: previous.contentType,
                durationMs: previous.durationMs,
                waveform: previous.waveform,
                streaming: true,
                mediaCards: previous.mediaCards,
                renderBlocks: previous.renderBlocks,
                replyBlocks: previous.replyBlocks,
                pendingMediaCards: previous.pendingMediaCards,
              );
            }
          });
          return;
        }
        if (type == "chat.assistant_chunk") {
          _resetAgentReplyWatchdog();
          // 丢弃「已结束轮次」的迟到 chunk：避免在 chat.assistant_done 之后
          // 网络重排 / 子 Agent 回调把 _isAgentProcessing 重新点亮。
          final String? chunkAssistantMessageId =
              payload["messageId"]?.toString();
          final String? chunkTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = ChatTurnController.instance.activeTraceId;
          if (activeTraceId == null ||
              ((chunkTraceId == null || chunkTraceId.isEmpty) &&
                  (chunkAssistantMessageId == null ||
                      !chunkAssistantMessageId.endsWith(activeTraceId))) ||
              (chunkTraceId != null &&
                  chunkTraceId.isNotEmpty &&
                  chunkTraceId != activeTraceId)) {
            return;
          }
          // 统一流式渲染：分段器产出的所有块相别都是 stream（垫词旁路已拆除），
          // 同一 messageId 续写，形成「先应一句 → 停顿 → 逐段递进」的节奏。
          _clearInterimAck();
          if (!_isAgentProcessing) {
            setState(() => _isAgentProcessing = true);
            _notifyAgentProcessingUi(true);
          }
          final String messageId = chunkAssistantMessageId ??
              (activeTraceId.isNotEmpty
                  ? "assistant-$activeTraceId"
                  : "assistant-streaming");
          final String chunk = payload["chunk"]?.toString() ?? "";
          // 关键：chunk 文字直接入列表（新建或续写），让用户实时看到回复内容。
          // 同时进缓冲，供 done 时做兜底比对。
          final String visibleChunk = _enqueueAssistantChunk(messageId, chunk);
          if (visibleChunk.isEmpty) return;
          _appendChunkToMessageList(messageId, visibleChunk);
          // v2：把 chunk 同步累加进 TurnState.streamBuffer（UI 改造后用作流式正文源）
          _turnState?.appendChunk(visibleChunk);
        }
        // 边说边出图：媒体工具执行完即推送 `chat.media_ready`，把该批照片
        // 先挂到当前流式回复的 pendingMediaCards 上，前端实时展示；
        // done 到达后由 renderBlocks 的最终顺序接管，此字段随之清空。
        if (type == "chat.media_ready") {
          final String? mediaMessageId = payload["messageId"]?.toString();
          final String? mediaTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = ChatTurnController.instance.activeTraceId;
          // 非当前轮次的迟到照片直接丢弃
          if (mediaTraceId != null &&
              mediaTraceId.isNotEmpty &&
              activeTraceId != null &&
              mediaTraceId != activeTraceId) {
            return;
          }
          final List<Map<String, dynamic>>? newCards = payload["cards"] is List
              ? (payload["cards"] as List)
                  .whereType<Map<String, dynamic>>()
                  .toList()
              : null;
          if (newCards == null || newCards.isEmpty) return;
          final int? existingIdx = _messageIndexById(mediaMessageId ?? "");
          if (existingIdx == null || existingIdx >= _messages.length) return;
          setState(() {
            final ChatMessage previous = _messages[existingIdx];
            final List<Map<String, dynamic>> updatedPending =
                (previous.pendingMediaCards ?? <Map<String, dynamic>>[]) +
                    newCards;
            _messages[existingIdx] = ChatMessage(
              messageId: previous.messageId,
              sessionId: previous.sessionId,
              role: previous.role,
              text: previous.text,
              timestamp: previous.timestamp,
              attachmentImageCount: previous.attachmentImageCount,
              playUrl: previous.playUrl,
              attachments: previous.attachments,
              contentType: previous.contentType,
              durationMs: previous.durationMs,
              waveform: previous.waveform,
              streaming: previous.streaming,
              mediaCards: previous.mediaCards,
              renderBlocks: previous.renderBlocks,
              replyBlocks: previous.replyBlocks,
              pendingMediaCards: updatedPending,
            );
          });
          return;
        }
        if (type == "chat.assistant_done") {
          // 任务面结果（source=task_plane，2026-09-08）：与前台轮次完成语义分离。
          // 前后台分工下任务完成时前台可能正在流式回复——绝不能走下方前台收尾
          // （清 _pendingAgentUserMessageId/处理中状态/打字机缓冲会腰斩前台轮次）。
          // 只把结果消息独立落进对话流，并移除对应过程回执。
          if (payload["source"]?.toString() == "task_plane") {
            // 2026-09-08 任务面异步收尾：服务端派发后台任务后本轮以空正文立即结束，
            // done 带 traceId 指向当前轮——先结清前台处理状态（发送按钮恢复普通态、
            // 停 watchdog），再走任务面落位（空文本只做回执清理，不落正文气泡）。
            // 后台任务结果的 done 不带 traceId，不进此分支，前台状态不受影响。
            final String? dispatchedTraceId = payload["traceId"]?.toString();
            if (dispatchedTraceId != null &&
                dispatchedTraceId.isNotEmpty &&
                dispatchedTraceId == ChatTurnController.instance.activeTraceId) {
              _takePendingAssistantChunkText();
              ChatTurnController.instance.activeTraceId = null;
              _disarmAgentReplyWatchdog();
              _flushAssistantChunks();
              _clearAgentProcessingState(done: true);
            }
            await _handleTaskPlaneResultDone(payload);
            return;
          }
          final String? doneTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = ChatTurnController.instance.activeTraceId;
          if (doneTraceId != null &&
              doneTraceId.isNotEmpty &&
              activeTraceId != null &&
              doneTraceId != activeTraceId) {
            // 非活动轮次的 done：若属于排队消息（并发槽位超时 BUSY 兜底等
            // 未走 turn_started 的终态），结清排队徽标后丢弃
            if (_queuedUserMessageIds.remove(doneTraceId)) {
              if (mounted) setState(() {});
            }
            return;
          }
          if (doneTraceId != null &&
              doneTraceId.isNotEmpty &&
              activeTraceId == null) {
            // 无活动轮次时收到排队消息的 done（服务端未发 turn_started 的
            // 兜底终态）：结清排队徽标，正文照常落列
            if (_queuedUserMessageIds.remove(doneTraceId)) {
              if (mounted) setState(() {});
            }
          }
          final String bufferedText = _takePendingAssistantChunkText();
          // 关键：先在 traceId 上打「本轮已结束」标记，再做后续副作用。
          // 否则清状态与清 traceId 之间存在竞态：迟到的 chunk/agent_status
          // 会看到 _pendingAgentUserMessageId 还有值，重新点亮思考气泡。
          ChatTurnController.instance.activeTraceId = null;
          _disarmAgentReplyWatchdog();
          _flushAssistantChunks();
          // v2：done=true 让 _clearAgentProcessingState 内部调 markDone（而非 markCanceled）
          _clearAgentProcessingState(done: true);

          // Phase 2：检测 429 回压（"服务繁忙"），自动指数退避重试
          final String finalTextRaw = payload["finalText"]?.toString() ?? "";
          if (finalTextRaw.contains("服务繁忙") &&
              _pendingRetryText != null &&
              _pendingRetryCount < 3) {
            _pendingRetryCount++;
            final int delaySec = 1 << (_pendingRetryCount - 1); // 1s, 2s, 4s
            debugPrint(
                "[429-retry] 检测到回压，${delaySec}s 后重试 (第 $_pendingRetryCount 次)");
            // 不显示"服务繁忙"消息，保持思考状态
            _isAgentProcessing = true;
            _notifyAgentProcessingUi(true);
            Future.delayed(Duration(seconds: delaySec), () {
              if (mounted && _pendingRetryText != null) {
                final String retryText = _pendingRetryText!;
                _pendingRetryText = null;
                _sendMessage(text: retryText, isRetry: true);
              }
            });
            return;
          }
          // 正常完成或重试次数用尽，清空重试状态
          _pendingRetryText = null;
          _pendingRetryCount = 0;
          final String messageId = payload["messageId"]?.toString() ??
              ((doneTraceId != null && doneTraceId.isNotEmpty)
                  ? "assistant-$doneTraceId"
                  : "assistant-final");
          final String finalText = _sanitizeAssistantVisibleText(
              payload["finalText"]?.toString() ?? "");
          final String fallbackText = "抱歉，我暂时无法生成回复，请稍后重试";
          // 2026-09-11 根修兜底：bufferedText 是逐 chunk 净化后的流式累积，但
          // 逐 chunk 正则天然抓不住跨 chunk 切开的标记（如 DSML 协议块）。
          // 回退渲染前对整段缓冲再净化一次，防止服务端已把正文剥成空串、客户端
          // 却把流式缓冲里的协议原文当正文定稿（2026-09-11 01:34 实测事故）。
          final String sanitizedBuffered = _sanitizeAssistantVisibleText(bufferedText);
          final String resolvedText = finalText.trim().isNotEmpty
              ? finalText
              : (sanitizedBuffered.trim().isNotEmpty ? sanitizedBuffered : fallbackText);
          final String traceKey = (doneTraceId?.isNotEmpty == true)
              ? doneTraceId!
              : (messageId.startsWith("assistant-")
                  ? messageId.substring("assistant-".length)
                  : "");
          // 垫词旁路已拆除：不再有独立 interim 气泡，done 文本直接就作为正文兜底。
          final String? playUrl = (traceKey.isNotEmpty
                  ? _pendingPlayUrlByTraceId.remove(traceKey)
                  : null) ??
              _playUrlForAssistantMessageId(messageId) ??
              PlayUrlUtils.fromAssistantText(resolvedText);
          // 从 WS 载荷解析结构化媒体卡片与交错渲染块（两分支共用，提取一次）
          final List<Map<String, dynamic>>? mediaCardsFromPayload =
              payload["mediaCards"] is List
                  ? (payload["mediaCards"] as List)
                      .whereType<Map<String, dynamic>>()
                      .toList()
                  : null;
          // 结构化摘要卡（CONTENT_SUMMARY 通道迁移）：随 done 下发的折叠卡载荷，
          // 文本通道已不携带 JSON；历史消息回退正文标记解析。
          final Map<String, dynamic>? summaryCardFromPayload =
              payload["summaryCard"] is Map<String, dynamic>
                  ? payload["summaryCard"] as Map<String, dynamic>
                  : null;
          final List<Map<String, dynamic>>? renderBlocksFromPayload =
              payload["renderBlocks"] is List
                  ? (payload["renderBlocks"] as List)
                      .whereType<Map<String, dynamic>>()
                      .toList()
                  : null;
          // 回复信封块（A 阶段）：服务端把卡片标记确定性拆成的 text/card 序列。
          // 仅实时渲染用（不持久化，历史消息走正文标记解析，两者渲染等价）。
          final List<Map<String, dynamic>>? replyBlocksFromPayload =
              payload["blocks"] is List
                  ? (payload["blocks"] as List)
                      .whereType<Map<String, dynamic>>()
                      .toList()
                  : null;
          // 「接下来你可以」接续建议（NEXT_UP 协议）：模型生成的下一步任务句，
          // 服务端已从正文剥离标记块。时机性内容不持久化，仅实时渲染。
          final List<String>? followUpsFromPayload = payload["followups"] is List
              ? (payload["followups"] as List)
                  .map((e) => e.toString().trim())
                  .where((e) => e.isNotEmpty)
                  .toList()
              : null;
          // 真·分绿泡对账数组（2026-09-28）：服务端各气泡的 id+定稿文本。
          // 带该字段的轮次按泡收口（不走单泡 finalText 替换逻辑）。
          final List<Map<String, dynamic>>? bubblesFromPayload =
              payload["bubbles"] is List
                  ? (payload["bubbles"] as List)
                      .whereType<Map<String, dynamic>>()
                      .toList()
                  : null;
          final bool collapseToSingle =
              payload["finalTextReplacesStream"] == true;

          // 真·分绿泡收口：出口重写/自检重跑让最终文本与已流文本分叉时
          // （finalTextReplacesStream），整轮塌缩——删本轮所有分泡，落一条
          // assistant-$traceId 单泡承载 finalText，避免新旧两版拼接。
          if (collapseToSingle &&
              bubblesFromPayload != null &&
              bubblesFromPayload.isNotEmpty) {
            await _collapseBubblesToFinal(
              bubbleIds: bubblesFromPayload
                  .map((b) => b["id"]?.toString() ?? "")
                  .where((id) => id.isNotEmpty)
                  .toList(),
              traceId: doneTraceId ?? "",
              finalText: resolvedText,
              playUrl: playUrl,
              mediaCards: mediaCardsFromPayload,
              summaryCard: summaryCardFromPayload,
              renderBlocks: renderBlocksFromPayload,
              replyBlocks: replyBlocksFromPayload,
              followUps: followUpsFromPayload,
            );
          } else if (bubblesFromPayload != null &&
              bubblesFromPayload.isNotEmpty) {
            // 正常分泡收口：逐泡以服务端定稿文本为准定稿（含漏收 chunk 的补建），
            // 卡片/建议/playUrl 挂末泡（服务端收口链的附着目标）。
            await _reconcileBubblesOnDone(
              bubbles: bubblesFromPayload,
              mediaCards: mediaCardsFromPayload,
              renderBlocks: renderBlocksFromPayload,
              replyBlocks: replyBlocksFromPayload,
              followUps: followUpsFromPayload,
              playUrl: playUrl,
              summaryCard: summaryCardFromPayload,
            );
          } else {
          final int? idx = _messageIndexById(messageId);
          if (idx != null) {
            // 默认保留流式阶段已经显示出来的正文，避免 done 到来时整段闪烁替换；
            // 但如果 finalText 明显更“最终态”（例如带结构化卡片标记，或当前文本是原始 JSON），
            // 则应覆盖中间态文本，否则会把工具原始返回错误地留在聊天气泡里。
            setState(() {
              final ChatMessage previous = _messages[idx];
              final String currentText = previous.text;
              // 服务端分歧裁决信号（2026-09-28 放流配套）：出口重写/自检重跑/
              // 确定性收口让最终文本与已流文本分叉时，finalText 整段替换流式
              // 气泡，避免新旧两版拼接（服务端已跳过残差补推）。
              final bool serverSaysReplace =
                  payload["finalTextReplacesStream"] == true;
              final String nextText = (serverSaysReplace ||
                      _shouldReplaceAssistantTextOnDone(currentText, resolvedText))
                  ? resolvedText
                  : currentText;
              final String? existingPlayUrl = previous.playUrl;
              final List<Map<String, dynamic>>? existingMediaCards =
                  previous.mediaCards;
              // 优先使用 WS 下发的 mediaCards，若没有则保留已有（流式阶段已注入的）
              final List<Map<String, dynamic>>? resolvedMediaCards =
                  mediaCardsFromPayload ?? existingMediaCards;
              _messages[idx] = ChatMessage(
                messageId: previous.messageId,
                sessionId: previous.sessionId,
                role: previous.role,
                text: nextText,
                timestamp: previous.timestamp,
                attachmentImageCount: previous.attachmentImageCount,
                playUrl: playUrl ?? existingPlayUrl,
                attachments: previous.attachments,
                contentType: previous.contentType,
                durationMs: previous.durationMs,
                waveform: previous.waveform,
                mediaCards: resolvedMediaCards,
                summaryCard: summaryCardFromPayload ?? previous.summaryCard,
                renderBlocks: renderBlocksFromPayload,
                replyBlocks: replyBlocksFromPayload,
                followUpPrompts: followUpsFromPayload,
              );
            });
            await _store.saveMessage(_messages[idx]);
          } else {
            // 极端边界：完全没收到任何 chunk（只收到 done），用 finalText 兜底
            final ChatMessage finalMessage = ChatMessage(
              messageId: messageId,
              sessionId: ApiConfig.effectiveActorId,
              role: "assistant",
              text: resolvedText,
              timestamp: DateTime.now(),
              playUrl: playUrl,
              mediaCards: mediaCardsFromPayload,
              summaryCard: summaryCardFromPayload,
              renderBlocks: renderBlocksFromPayload,
              replyBlocks: replyBlocksFromPayload,
              followUpPrompts: followUpsFromPayload,
            );
            setState(() {
              _messages.add(finalMessage);
              _assistantMessageIndexById[messageId] = _messages.length - 1;
            });
            await _store.saveMessage(finalMessage);
          }
          } // 真·分绿泡：单泡兜底 else 分支收口
          // 行程卡预热/自动展开（2026-09-25）：本轮产出 travel_itinerary 卡即把
          // 载荷预注入规划窗口（常驻进程换载或隐藏拉起），用户点「打开行程规划」
          // 时窗口与地图已就绪零等待；带 autoOpen 的卡照旧直接弹出独立界面。
          // 版本闸：开源版剔除旅游家族
          if (!ApiConfig.isOssEdition) {
            final AgentResultParseResult doneParsed =
                AgentResultParser.parse(resolvedText);
            final AgentResultData? doneCard = doneParsed.data;
            if (doneCard != null && doneCard.cardType == "travel_itinerary") {
              if (doneCard.autoOpen) {
                _openTravelPlanPanel(doneCard);
              } else {
                unawaited(TravelPlanWindowLauncher.warm(doneCard));
              }
            }
          }
          unawaited(_loadAgentProfile());
          // 纯语音模式（岛=唯一视觉）：回复已落聊天流 → 简洁弹窗 + TTS 播报
          // + 追问窗口。弹窗/播报失败静默降级，岛条目始终反映当前阶段。
          if (PureVoiceModeController.instance.isActive.value) {
            unawaited(PureVoiceModeController.instance.notifyReply(resolvedText));
          }
        }
        if (type == "agent.peer_message") {
          await AmbientFeedsController.instance.onPeerMessage(payload);
        }
        // ====== Agent 语音消息（voice.send_message 工具触发）======
        // 服务端推送 `agent.voice.message` 事件，客户端落为一条 assistant
        // 语音消息（contentType=audio + attachments=[audio]），渲染为微信式
        // 可重播语音气泡。mediaUrl 为 null（TTS 失败降级）时退化为纯文本。
        if (type == "agent.voice.message") {
          final String messageId = payload["messageId"]?.toString() ??
              "voice-${DateTime.now().microsecondsSinceEpoch}";
          final String text = payload["text"]?.toString() ?? "";
          final String transcript = payload["transcript"]?.toString() ?? text;
          final String? mediaUrl = payload["mediaUrl"]?.toString();
          final int durationMs = (payload["durationMs"] as num?)?.toInt() ?? 0;
          final String? skippedReason = payload["skippedReason"]?.toString();
          // 去重：同 messageId 已存在则不重复入列表
          final bool exists = _messages.any((m) => m.messageId == messageId);
          if (!exists) {
            final List<MessageAttachment> attachments = <MessageAttachment>[];
            if (mediaUrl != null && mediaUrl.isNotEmpty) {
              attachments.add(MessageAttachment(
                type: MessageAttachmentType.audio,
                url: mediaUrl,
                durationMs: durationMs,
                transcript: transcript.isEmpty ? null : transcript,
                mimeType: "audio/mpeg",
              ));
            }
            final ChatMessage voiceMsg = ChatMessage(
              messageId: messageId,
              sessionId: ApiConfig.effectiveActorId,
              role: "assistant",
              // 有 mediaUrl 时正文留空（避免文字气泡重复展示 transcript）；
              // 无 mediaUrl 时正文回退为 transcript 或失败原因，让用户能看见文字内容
              text: (mediaUrl == null || mediaUrl.isEmpty)
                  ? (transcript.isNotEmpty
                      ? transcript
                      : (skippedReason?.isNotEmpty == true
                          ? "语音消息生成失败：$skippedReason"
                          : "语音消息生成失败"))
                  : "",
              timestamp: DateTime.now(),
              contentType: "audio",
              durationMs: durationMs > 0 ? durationMs : null,
              attachments: attachments,
            );
            setState(() {
              _messages.add(voiceMsg);
              _assistantMessageIndexById[messageId] = _messages.length - 1;
            });
            unawaited(_store.saveMessage(voiceMsg).catchError((Object e) {
              debugPrint("[chat] voice message saveMessage failed: $e");
            }));
          }
        }
        // ====== 振铃前摇阶段（ringing_start） ======
        // Agent 呼叫用户时，先推振铃事件，客户端进入"来电中"动画+倒计时
        if (type == "agent.proactive_message") {
          final String title = payload["title"]?.toString() ?? "Agent 主动联系";
          final String text = payload["text"]?.toString() ?? "";
          // 统一主动性管道：高重要度主动消息走应用内玻璃卡触达，
          // 确认/关闭/超时按卡片回调回传 outcome 反馈
          final String importance = payload["importance"]?.toString() ?? "";
          final String deliveryId = payload["deliveryId"]?.toString() ?? "";
          final bool important = importance == "high" || importance == "critical";
          // 手机后台（类微信常在线）：系统通知触达，点开回前台并回传 outcome
          if (_isMobile && _appBackgrounded && important && deliveryId.isNotEmpty) {
            unawaited(LocalNotificationService.show(
              title: title, body: text, deliveryId: deliveryId,
            ));
          } else if (mounted && important && deliveryId.isNotEmpty) {
            // 决策卡落对话流（确认/忽略在卡上完成并回传 outcome）
            _showProactivePopup(title, text, deliveryId);
          } else if (mounted) {
            // 应用内展示即 impression：上报 viewed（服务端记为"已展示"，不算忽略，
            // 也不进接受率分母——此前应用内阅读与忽略无法区分，学习信号有偏）
            if (deliveryId.isNotEmpty) {
              AmbientFeedsController.instance.sendProactiveOutcome(deliveryId, "viewed");
            }
            final controller = ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("$title\n$text"),
                duration: const Duration(seconds: 8),
                // 有 deliveryId 时把唯一动作位让给"太多了"——一键负反馈直通
                // 频控自适应（该类消息冷却×1.5），比"知道了"更有调教价值
                action: deliveryId.isEmpty
                    ? SnackBarAction(
                        label: "知道了",
                        onPressed: () {
                          AmbientFeedsController.instance.sendContactFeedback(
                            channel: "websocket",
                            responded: true,
                            feedback: "positive",
                            quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
                          );
                        },
                      )
                    : SnackBarAction(
                        label: "太多了",
                        onPressed: () {
                          AmbientFeedsController.instance.sendProactiveFeedback(
                            deliveryId,
                            "too_many",
                            kind: payload["kind"]?.toString(),
                          );
                          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                            const SnackBar(
                              content: Text("好的，这类消息会少推一些（设置里可恢复）"),
                              duration: Duration(seconds: 3),
                            ),
                          );
                        },
                      ),
              ),
            );
            controller?.closed.then((dynamic reason) {
              if (reason != SnackBarClosedReason.action) {
                AmbientFeedsController.instance.sendContactFeedback(
                  channel: "websocket",
                  responded: false,
                  feedback: "neutral",
                  quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
                );
              }
            });
          }
        }
        // ====== 站内信：平台/运营侧推送（服务端已落盘必达，此处只做即时提醒） ======
        if (type == "inbox.message") {
          await AmbientFeedsController.instance.onInboxMessage(payload);
        }
        if (type == "agent.proactive_voice") {
          final String title = payload["title"]?.toString() ?? "Agent 语音联系";
          final String text = payload["text"]?.toString() ?? "";
          // 取 TTS 音频并播放（修复：原实现仅显示 SnackBar 未播放音频）
          final String? ttsBase64 =
              PhoneCallController.extractTtsBase64(payload["tts"]);
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          }
          if (mounted) {
            final controller = ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("$title\n$text"),
                duration: const Duration(seconds: 10),
                action: SnackBarAction(
                  label: "收到了",
                  onPressed: () {
                    AmbientFeedsController.instance.sendContactFeedback(
                      channel: "voice",
                      responded: true,
                      feedback: "positive",
                      quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
                    );
                  },
                ),
              ),
            );
            controller?.closed.then((dynamic reason) {
              if (reason != SnackBarClosedReason.action) {
                AmbientFeedsController.instance.sendContactFeedback(
                  channel: "voice",
                  responded: false,
                  feedback: "neutral",
                  quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
                );
              }
            });
          }
        }
        // ====== Agent 底层语音能力：voice.speak 工具触发的即时播报 ======
        // 轻量事件：客户端后台播放 TTS 音频，无强制 UI（可选显示简短提示）。
        if (type == "agent.voice.speak") {
          final String text = payload["text"]?.toString() ?? "";
          final String? ttsBase64 =
              PhoneCallController.extractTtsBase64(payload["tts"]);
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          } else if (text.isNotEmpty && mounted) {
            // TTS 未启用兜底：用 SnackBar 显示文本
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(text),
                duration: const Duration(seconds: 6),
              ),
            );
          }
        }
        // ====== Agent 底层语音能力：voice.speak 工具触发的提醒式播报 ======
        // 带标题/优先级，客户端显示卡片 + 播放音频。
        if (type == "agent.voice.alarm") {
          final String title = payload["title"]?.toString() ?? "语音提醒";
          final String text = payload["text"]?.toString() ?? "";
          final String priority = payload["priority"]?.toString() ?? "medium";
          final String? ttsBase64 =
              PhoneCallController.extractTtsBase64(payload["tts"]);
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          }
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("[$priority] $title\n$text"),
                duration: const Duration(seconds: 8),
              ),
            );
          }
        }
        if (!ApiConfig.isOssEdition && type == "agent.phone.ringing_start") {
          if (!mounted) return;
          final String ringStyle =
              payload["ringStyle"]?.toString() ?? "reminder";
          final String callerLabel =
              PhoneCallController.resolveCallerLabel(payload);
          final int ringMs = PhoneCallController.resolveRingMs(payload);

          setState(() {
            _phoneCallStatus = "ringing";
            _phoneCallToActorId = callerLabel;
            _activeCallId = payload["callId"]?.toString();
          });

          unawaited(OutgoingCallLauncher.hide());
          unawaited(ConnectedCallLauncher.hide());
          if (_isMobile) {
            // 手机端：应用内全屏来电页（无 Win32 原生悬浮窗）
            PhoneCallSession.instance.showIncoming(
              callId: _activeCallId ?? "",
              callerLabel: callerLabel,
              subtitle: ringStyle == "reminder" ? "语音提醒" : "来电中",
              initial:
                  callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
              ringTimeoutMs: ringMs,
            );
            final BuildContext? pageCtx = _rootNavigatorKey.currentContext;
            if (pageCtx != null && pageCtx.mounted) {
              unawaited(showPhoneCallPage(pageCtx));
            }
          } else {
            // 唤起独立悬浮来电窗（脱离主窗口存在，主窗最小化也能看到 + 听到铃声）。
            // Windows 桌面端走原生 Win32 窗；其他平台由 IncomingCallLauncher
            // 内部 MissingPluginException 兜底，silently return false。
            unawaited(
              IncomingCallLauncher.show(
                callerName: callerLabel,
                subtitle: (_agentName?.trim().isNotEmpty ?? false)
                    ? _agentName!.trim()
                    : "Agent",
                callerInitial:
                    callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
                ringTimeoutMs: ringMs,
              ),
            );
          }
        }

        // ====== 电话接通事件（call_connecting）—— 前摇结束后推送 ======
        // 包含 TTS 音频（base64 mp3）。
        // 设计：接通后不弹任何嵌入式 UI，改用独立的 Win32 "通话中"窗口
        // （仿电脑微信电话：头像 + 名称 + 计时 + 静音/免提/挂断）。
        // TTS 音频在后台播；头像呼吸光晕随 TTS 播放节奏。
        if (!ApiConfig.isOssEdition && type == "agent.phone.call_connecting") {
          final String callerLabel =
              PhoneCallController.resolveCallerLabel(payload);
          final String connectingCallId =
              payload["callId"]?.toString() ?? "";

          if (!mounted) return;
          setState(() {
            _phoneCallStatus = "connected";
            _phoneCallToActorId = callerLabel;
            _activeCallId = connectingCallId;
            _phoneMuted = false;
            _phoneSpeakerOn = true;
          });

          if (_isMobile) {
            // 手机端：应用内全屏通话页随会话切到"通话中"（不弹窗清栈，
            // 否则会把已打开的来电页一起弹掉）
            PhoneCallSession.instance.markInCall(
              callId: connectingCallId,
              transcriptText: payload["transcript"]?.toString() ?? "",
            );
            if (PhoneCallSession.instance.consumeOpenedFromIdle()) {
              final BuildContext? pageCtx = _rootNavigatorKey.currentContext;
              if (pageCtx != null && pageCtx.mounted) {
                unawaited(showPhoneCallPage(pageCtx));
              }
            }
          } else {
            // 桌面端：关掉来电/拨号时可能残留的过渡弹窗
            final BuildContext? navCtx = _rootNavigatorKey.currentContext;
            if (navCtx != null && navCtx.mounted) {
              final nav = Navigator.of(navCtx, rootNavigator: true);
              int maxPops = 10;
              while (nav.canPop() && maxPops-- > 0 && navCtx.mounted) {
                nav.pop();
              }
            }

            // 弹独立"通话中"窗口
            unawaited(IncomingCallLauncher.hide());
            unawaited(OutgoingCallLauncher.hide());
            unawaited(
              ConnectedCallLauncher.show(
                callerName: callerLabel,
                callerInitial:
                    callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
              ),
            );
          }

          // 取 TTS 音频（mp3 base64），后台播放；同时开启头像呼吸光
          final String? ttsBase64 =
              PhoneCallController.extractTtsBase64(payload["tts"]);

          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
            unawaited(ConnectedCallLauncher.setTalking(true));
            PhoneCallSession.instance.setTalking(true);
            // TTS 播完自动关掉呼吸光（TtsPlayer 完成后回调）
            TtsPlayer.instance.addOnCompleted(_onTtsCompleted);
          }
        }

        // ====== 提醒弹窗事件（reminder_popup）—— 服务端 popup 级别提醒 ======
        if (type == "reminder_popup") {
          final String title = payload["title"]?.toString() ?? "提醒";
          final String message = payload["message"]?.toString() ?? "";
          final String priority = payload["priority"]?.toString() ?? "normal";
          final String attentionId =
              payload["attentionId"]?.toString() ?? "";

          // 手机端且 App 在后台：应用内弹窗看不见，升级链第 1 级就成了"推给空气"。
          // 走系统通知触达（通知即弹窗，点开回前台），服务端升级链随之收敛。
          if (_isMobile && _appBackgrounded) {
            unawaited(LocalNotificationService.show(
              title: priority == "urgent" ? "[紧急] $title" : title,
              body: message,
            ));
          }

          // 决策卡落对话流：确认/忽略都在卡上完成，ack 由按钮回调回传
          // （升级链随之收敛），不再飘弹窗。
          _showAttentionPopup(title, message, priority, attentionId);
        }

        // ====== TTS 闹钟升级链事件（tts_alarm_start / tts_alarm_play）======
        // 此前服务端推了音频但客户端无 handler——升级链第 2 级"有声无息"。
        // start：使用场景只在手机端，手机后台走系统通知触达（桌面端不接线，
        // 声音本身即提醒）；play：播 base64 mp3，带时间去抖——服务端渐强会在
        // 10s 内连推约 20 个音量步，全部起播会重叠轰炸；两次真实起播至少
        // 间隔 [._ttsAlarmMinGap]。
        if (type == "tts_alarm_start") {
          final String title = payload["title"]?.toString() ?? "语音提醒";
          final String text = payload["message"]?.toString() ?? "";
          final String priority = payload["priority"]?.toString() ?? "medium";
          final bool important = priority == "urgent" || priority == "high";
          if (_isMobile && _appBackgrounded) {
            unawaited(LocalNotificationService.show(
              title: important ? "[紧急语音] $title" : "[语音提醒] $title",
              body: text,
            ));
          }
        }
        if (type == "tts_alarm_play") {
          final String? ttsBase64 =
              PhoneCallController.extractTtsBase64(payload["tts"]);
          if (ttsBase64 != null) {
            final DateTime now = DateTime.now();
            final DateTime? last = _ttsAlarmLastPlayedAt;
            if (last == null ||
                now.difference(last).inMilliseconds >= _ttsAlarmMinGapMs) {
              _ttsAlarmLastPlayedAt = now;
              unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
            }
          }
        }

        // ====== Legacy 来电事件（agent.phone.incoming）—— 无前摇直接来电 ======
        // 与 ringing_start 统一走原生悬浮窗，不再使用嵌入式 Flutter dialog
        if (!ApiConfig.isOssEdition && type == "agent.phone.incoming") {
          final String direction = payload["direction"]?.toString() ?? "";
          final String ringStyle = payload["ringStyle"]?.toString() ?? "peer";
          final bool userActionRequired = payload["userActionRequired"] == true;
          final bool isPeerIncoming = userActionRequired ||
              (direction == "agent_to_agent" && ringStyle == "peer");
          if (isPeerIncoming && direction != "agent_to_user") {
            _presentPeerAgentIncoming(payload);
            return;
          }
          final String callerLabel = PhoneCallController.resolveCallerLabel(
            payload,
            defaultDirection: "",
          );
          final int ringMs = PhoneCallController.resolveRingMs(payload);

          if (!mounted) return;
          setState(() {
            _phoneCallStatus = "ringing";
            _phoneCallToActorId = callerLabel;
            _activeCallId = payload["callId"]?.toString();
          });

          if (_isMobile) {
            // 手机端：应用内全屏来电页
            PhoneCallSession.instance.showIncoming(
              callId: _activeCallId ?? "",
              callerLabel: callerLabel,
              subtitle: ringStyle == "reminder" ? "语音提醒" : "来电中",
              initial:
                  callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
              ringTimeoutMs: ringMs,
            );
            final BuildContext? pageCtx = _rootNavigatorKey.currentContext;
            if (pageCtx != null && pageCtx.mounted) {
              unawaited(showPhoneCallPage(pageCtx));
            }
          } else {
            // 统一走原生独立悬浮窗
            unawaited(
              IncomingCallLauncher.show(
                callerName: callerLabel,
                subtitle: (_agentName?.trim().isNotEmpty ?? false)
                    ? _agentName!.trim()
                    : "Agent",
                callerInitial:
                    callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
                ringTimeoutMs: ringMs,
              ),
            );
          }
        }

        // ====== 通话中 Agent 语音回应（voice_reply）—— 双向交互的多轮播报 ======
        if (!ApiConfig.isOssEdition && type == "agent.phone.voice_reply") {
          final String vrTranscript = payload["transcript"]?.toString() ?? "";
          if (!mounted) return;
          PhoneCallSession.instance.appendAgentVoice(transcriptText: vrTranscript);
          final Object? vrTts = payload["tts"];
          String? vrBase64;
          if (vrTts is Map) {
            final Object? fmt = vrTts["format"];
            final Object? b64 = vrTts["base64"];
            if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
              vrBase64 = b64;
            }
          }
          if (vrBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(vrBase64));
            unawaited(ConnectedCallLauncher.setTalking(true));
            TtsPlayer.instance.addOnCompleted(_onTtsCompleted);
          } else {
            // 无音频（TTS 未配置）：直接结束"播报中"状态
            PhoneCallSession.instance.setTalking(false);
          }
        }
        if (type == "morning.briefing") {
          await _handleMorningBriefingEvent(payload);
        }
        if (type == "evening.digest") {
          await _handleEveningDigestEvent(payload);
        }
        if (!ApiConfig.isOssEdition && type == "agent.phone.call_status") {
          final String status = payload["status"]?.toString() ?? "unknown";
          final String toActorId = payload["toActorId"]?.toString() ?? "";
          final String? fromPhone = payload["fromPhone"]?.toString();
          final String statusCallId = payload["callId"]?.toString() ?? "";
          if (!mounted) return;
          final bool shouldClearPhoneState =
              status == "ended" || status == "agent_handled";
          setState(() {
            if (fromPhone != null && fromPhone.isNotEmpty) {
              _phoneCallToActorId = VoiceCallUiLabels.incomingCallerLabel(
                direction: payload["direction"]?.toString() ?? "agent_to_agent",
                fromPhone: fromPhone,
              );
            } else {
              _phoneCallToActorId =
                  toActorId.isNotEmpty ? toActorId : _phoneCallToActorId;
            }
            if (statusCallId.isNotEmpty) {
              _activeCallId = statusCallId;
            }
            if (shouldClearPhoneState) {
              // 通话结束：立刻清状态
              _phoneCallStatus = null;
              _phoneCallToActorId = null;
              _activeCallId = null;
              _peerIncomingDialogCallId = null;
              _phoneMuted = false;
              _phoneSpeakerOn = true;
            } else if (status == "answered_by_user") {
              _phoneCallStatus = "connected";
            } else {
              _phoneCallStatus = status;
            }
          });
          if (status == "connected" &&
              payload["direction"]?.toString() == "user_to_agent") {
            // 用户呼出 Agent 的接通事件：connected 携带 Agent 回应（transcript + TTS），
            // 手机端切应用内通话页，两端统一播报接通语音
            PhoneCallSession.instance.markInCall(
              callId: statusCallId,
              transcriptText: payload["transcript"]?.toString() ?? "",
            );
            if (_isMobile) {
              if (PhoneCallSession.instance.consumeOpenedFromIdle()) {
                final BuildContext? pageCtx = _rootNavigatorKey.currentContext;
                if (pageCtx != null && pageCtx.mounted) {
                  unawaited(showPhoneCallPage(pageCtx));
                }
              }
            } else {
              // 桌面端：关掉「正在呼叫/正在接通」外呼过渡窗，弹独立「通话中」窗
              // （与 agent→user 的 call_connecting 分支对称；此前缺失导致外呼窗
              // 永远停在「正在接通」，用户既看不到接通也无法挂断）
              unawaited(OutgoingCallLauncher.hide());
              unawaited(IncomingCallLauncher.hide());
              unawaited(
                ConnectedCallLauncher.show(
                  callerName: (_agentName?.trim().isNotEmpty ?? false)
                      ? _agentName!.trim()
                      : "Agent",
                  callerInitial: (_agentName?.trim().isNotEmpty ?? false)
                      ? _agentName!.trim().characters.first
                      : "A",
                ),
              );
            }
            final Object? csTts = payload["tts"];
            if (csTts is Map) {
              final Object? fmt = csTts["format"];
              final Object? b64 = csTts["base64"];
              if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
                unawaited(TtsPlayer.instance.playFromBase64(b64));
                unawaited(ConnectedCallLauncher.setTalking(true));
                PhoneCallSession.instance.setTalking(true);
                TtsPlayer.instance.addOnCompleted(_onTtsCompleted);
              }
            }
          }
          if (status == "answered_by_user") {
            AmbientFeedsController.instance.sendContactFeedback(
              channel: "phone_call",
              responded: true,
              feedback: "positive",
              quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
            );
          }
          if (shouldClearPhoneState) {
            // 通话结束/转交：摘掉 TTS 完成回调 + 停 TTS + 关独立"通话中"窗口
            // （手机端通话页随 session.end() 自动关闭）
            PhoneCallSession.instance.end();
            TtsPlayer.instance.removeOnCompleted(_onTtsCompleted);
            unawaited(TtsPlayer.instance.stop());
            unawaited(IncomingCallLauncher.hide());
            unawaited(OutgoingCallLauncher.hide());
            unawaited(ConnectedCallLauncher.hide());
          }
        }
        // 呼叫失败必须可见：服务端对呼出拒绝统一回 error.event（号码申领失败/
        // 忙线等），客户端职责=关掉外呼窗清状态 + toast 提示原因；语音电话的
        // 内容不以文字气泡进聊天流。
        // 注意须同时看外呼窗可见性：点呼叫后 _phoneCallStatus 要等服务端
        // ringing 事件才置位，即时拒绝发生时它还是 null。
        if (type == "error.event" &&
            (_phoneCallStatus != null || OutgoingCallLauncher.isVisible.value)) {
          final String callErrCode = payload["code"]?.toString() ?? "";
          if (callErrCode == "PHONE_CALL_FAILED") {
            if (!mounted) return;
            setState(() {
              _phoneCallStatus = null;
              _phoneCallToActorId = null;
              _activeCallId = null;
            });
            PhoneCallSession.instance.end();
            unawaited(OutgoingCallLauncher.hide());
            unawaited(IncomingCallLauncher.hide());
            _showToast(
              payload["message"]?.toString() ?? "呼叫失败，请稍后重试",
            );
          }
        }
        if (type == "desktop.bridge.sync") {
          final bool? on = payload["bridgeOnline"] as bool?;
          final Map<String, dynamic>? lt =
              (payload["lastTask"] as Map?)?.cast<String, dynamic>();
          final String? nextSummary = lt == null
              ? null
              : (lt["summary"]?.toString() ?? lt["error"]?.toString());
          final String? previousSummary = _desktopBridgeLastSummary;
          setState(() {
            _desktopBridgeOnline = on;
            _desktopBridgeLastSummary = nextSummary;
          });
          if (nextSummary != null &&
              nextSummary.trim().isNotEmpty &&
              nextSummary != previousSummary) {
            _showToast(
              on == false ? "桌面同步: $nextSummary" : "桌面同步: $nextSummary",
            );
          }
        }

        if (type == "wallet.simulate.result") {
          final double nextBalance =
              (payload["ledger"]?["balance"] as num?)?.toDouble() ?? _balance;
          final double nextFrozen =
              (payload["ledger"]?["frozen"] as num?)?.toDouble() ?? _frozen;
          setState(() {
            _balance = nextBalance;
            _frozen = nextFrozen;
            _ledger.insert(
              0,
              WalletLedgerItem(
                id: payload["auditId"]?.toString() ?? DateTime.now().toString(),
                action: payload["action"]?.toString() ?? "wallet_action",
                amount: (payload["amount"] as num?)?.toDouble() ?? 0,
                success: payload["ok"] as bool? ?? false,
                createdAt: DateTime.now(),
                reason: payload["reason"]?.toString(),
              ),
            );
          });
        }
      } catch (e, st) {
        debugPrint("[ws] event handler failed for $type: $e\n$st");
      }
    });
  }

  /// 主服务恢复后补删离线队列中的服务端日程删除/同步
  Future<void> _flushScheduleOfflineDeletes() async {
    final ScheduleOfflineDeleteFlushResult result =
        await flushScheduleOfflineDeleteQueue(_store, _scheduleApi);
    if (result.flushed > 0) {
      _notifyScheduleViewsChanged();
    }
  }

  void _notifyScheduleViewsChanged() {
    _scheduleReloadSignal.value += 1;
    _calendarReloadSignal.value += 1;
  }

  /// 今日安排面板数据刷新：把「已设置的安排」（本地日程中的今日事项）
  /// 接进右侧面板的 FutureBuilder，数据变化时重新构建 future 并 setState。
  void _onScheduleReloadSignal() {
    if (!mounted) return;
    setState(() {
      _cachedScheduleFuture = _loadTodayScheduleFuture();
    });
  }

  Future<List<ScheduleEvent>> _loadTodayScheduleFuture() {
    final DateTime now = DateTime.now();
    return _store
        .listScheduleEventsForDay(DateTime(now.year, now.month, now.day))
        .then(
          (List<ScheduleEvent> events) => events
              // 琐事提醒（喝水/睡觉等 trivia 分类）只做后台到点推送，不进「今日安排」（日程页仍展示）
              .where((ScheduleEvent e) => !e.isTrivia)
              .toList(growable: false),
        );
  }

  Future<void> _syncScheduleFromServer() async {
    final String sessionId = ApiConfig.effectiveActorId.trim();
    if (sessionId.isEmpty) {
      _notifyScheduleViewsChanged();
      return;
    }
    try {
      await syncServerRemindersToLocal(_store, _scheduleApi, sessionId);
    } catch (e, st) {
      debugPrint("[schedule] syncServerRemindersToLocal failed: $e\n$st");
    } finally {
      _notifyScheduleViewsChanged();
      unawaited(_syncIslandSchedule());
    }
  }

  /// 把今日日程喂给灵动岛：展开卡内容 + 下一事项倒计时条目 + 提醒计划。
  /// 由日程同步 / 30s 倒计时刷新 / surface.show 共用。
  Future<void> _syncIslandSchedule() async {
    try {
      final List<ScheduleEvent> events = await _loadTodayScheduleFuture();
      final DateTime now = DateTime.now();
      final List<ScheduleEvent> sorted =
          List<ScheduleEvent>.from(events)
            ..sort((a, b) => a.startAt.compareTo(b.startAt));
      ScheduleEvent? next;
      final List<Map<String, Object?>> agenda = <Map<String, Object?>>[];
      for (final ScheduleEvent e in sorted) {
        final bool done = !e.startAt.isAfter(now);
        if (next == null && !done) next = e;
        agenda.add(<String, Object?>{
          "time":
              "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}",
          "title": e.shortTitle ?? simplifyScheduleTitle(e.title),
          "hint": done ? "已完成" : "",
          "completed": done,
        });
      }
      Map<String, Object?>? nextMap;
      final ScheduleEvent? focus = next;
      if (focus != null) {
        final int minutesAhead =
            focus.startAt.difference(now).inMinutes.clamp(0, 24 * 60);
        nextMap = <String, Object?>{
          "title": focus.shortTitle ?? simplifyScheduleTitle(focus.title),
          "minutesAhead": minutesAhead,
          "trailing": IslandReminderPolicy.trailingFor(
              minutesAhead, 0, 1),
          // 预告窗口提前量（服务端任务计划推导，null=不预告）：
          // 胶囊倒计时只在窗口内出场，2026-10-13 定调见 previewLeadMinutesFromTask。
          "previewLeadMinutes": focus.previewLeadMinutes,
        };
      }
      IslandRealFeeds.setSchedule(agenda: agenda, next: nextMap);
    } catch (e, st) {
      debugPrint("[island] sync schedule failed: $e\n$st");
    }
  }

  String? _playUrlForAssistantMessageId(String messageId) {
    final String? traceKey = messageId.startsWith("assistant-")
        ? messageId.substring("assistant-".length)
        : null;
    if (traceKey != null) {
      final String? pending = _pendingPlayUrlByTraceId[traceKey];
      if (pending != null) return pending;
    }
    final int? idx = _messageIndexById(messageId);
    if (idx == null) return null;
    return _messages[idx].playUrl;
  }

  String _enqueueAssistantChunk(String messageId, String chunk) {
    if (chunk.isEmpty) return "";
    if (_pendingAssistantChunkMessageId != null &&
        _pendingAssistantChunkMessageId != messageId) {
      _flushAssistantChunks();
      _pendingAssistantChunkText.clear();
      _assistantTextSanitizer.reset();
    }
    _pendingAssistantChunkMessageId = messageId;
    final String visibleChunk = _assistantTextSanitizer.ingest(chunk);
    if (visibleChunk.isEmpty) return "";
    _pendingAssistantChunkText.write(visibleChunk);
    _assistantChunkFlushTimer ??= Timer(const Duration(milliseconds: 32), () {
      _assistantChunkFlushTimer = null;
      _flushAssistantChunks();
    });
    return visibleChunk;
  }

  /// 把 chunk 文字直接追加到消息列表（新建或续写），实现"边说边看"效果。
  /// 与 _enqueueAssistantChunk 配合：前者管缓冲（供 done 兜底），后者管显示。
  /// [streaming] 控制该消息是否进入打字机逐字展示；垫词气泡传 false 即时显示。
  void _appendChunkToMessageList(
    String messageId,
    String chunk, {
    bool streaming = true,
  }) {
    if (chunk.isEmpty) return;
    // 用带兜底的索引查询：即使索引失真也能命中已存在的消息，避免重复插入
    final int? existingIdx = _messageIndexById(messageId);
    if (existingIdx != null && existingIdx < _messages.length) {
      // 续写已存在的消息
      setState(() {
        final ChatMessage previous = _messages[existingIdx];
        _messages[existingIdx] = ChatMessage(
          messageId: previous.messageId,
          sessionId: previous.sessionId,
          role: previous.role,
          text: previous.text + chunk,
          timestamp: previous.timestamp,
          attachmentImageCount: previous.attachmentImageCount,
          playUrl: previous.playUrl,
          // 流式追加中，保持 streaming 标志，渲染层打字机持续逐字展示
          streaming: previous.streaming,
          // 边说边出图：保留已挂载的临时媒体卡片（不随 chunk 重置）
          pendingMediaCards: previous.pendingMediaCards,
          mediaCards: previous.mediaCards,
          renderBlocks: previous.renderBlocks,
        );
      });
    } else {
      // 真·分绿泡：新泡开=旧泡完。同一轮的上一个分泡此刻定稿（打字机收尾、
      // 光标消失），新泡从头逐字展示——模拟真人连发几条消息的观感。
      // 普通单泡消息无 bN 后缀，不触发此逻辑。
      final String? bubbleTrace = _bubbleTraceOf(messageId);
      if (bubbleTrace != null) {
        _finalizeStreamingBubblesOfTrace(bubbleTrace, exceptId: messageId);
      }
      // 新建一条 assistant 消息入列表（streaming=true：渲染层从头做打字机效果，
      // 等 chat.assistant_done 重建消息时该标志自动回落为 false）
      final ChatMessage newMsg = ChatMessage(
        messageId: messageId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: chunk,
        timestamp: DateTime.now(),
        streaming: streaming,
      );
      setState(() {
        _messages.add(newMsg);
        _assistantMessageIndexById[messageId] = _messages.length - 1;
      });
      unawaited(_store.saveMessage(newMsg).catchError((Object e) {
        debugPrint("[chat] chunk saveMessage failed: $e");
      }));
    }
  }

  /// 把同一轮（同 traceId）的所有流式中的分泡消息定稿（streaming=false）。
  /// 用于：新泡开启时收尾上一泡；done/超时收口时收尾全部泡。
  /// 保留除 streaming 外的全部字段，不动文本内容。
  void _finalizeStreamingBubblesOfTrace(String trace, {String? exceptId}) {
    final List<ChatMessage> finalizedToSave = <ChatMessage>[];
    setState(() {
      for (int i = 0; i < _messages.length; i++) {
        final ChatMessage m = _messages[i];
        if (!m.streaming) continue;
        if (exceptId != null && m.messageId == exceptId) continue;
        if (_bubbleTraceOf(m.messageId) != trace) continue;
        final ChatMessage settled = ChatMessage(
          messageId: m.messageId,
          sessionId: m.sessionId,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          attachmentImageCount: m.attachmentImageCount,
          playUrl: m.playUrl,
          attachments: m.attachments,
          contentType: m.contentType,
          durationMs: m.durationMs,
          waveform: m.waveform,
          mediaCards: m.mediaCards,
          renderBlocks: m.renderBlocks,
          replyBlocks: m.replyBlocks,
          followUpPrompts: m.followUpPrompts,
          // streaming 不带 → false：打字机定稿、光标消失
        );
        _messages[i] = settled;
        finalizedToSave.add(settled);
      }
    });
    for (final ChatMessage m in finalizedToSave) {
      unawaited(_store.saveMessage(m).catchError((Object e) {
        debugPrint("[chat] bubble finalize saveMessage failed: $e");
      }));
    }
  }

  /// 真·分绿泡 done 收口：逐泡以服务端对账数组（id+定稿文本）为准定稿。
  ///
  /// - 每泡 streaming=false 定稿；服务端文本非空时以其为准（与 chunk 流同源，
  ///   兜住客户端漏收/少收的增量）。
  /// - 客户端没收到某泡的 chunk（WS 抖动）时按对账补建。
  /// - 卡片类附着全部挂末泡（服务端确定性收口链的附着目标）：
  ///   mediaCards/replyBlocks/followups/playUrl → 末泡；多泡时 renderBlocks /
  ///   replyBlocks 只保留非 text 块（text 块按全文切分，挂末泡会整段复读）。
  Future<void> _reconcileBubblesOnDone({
    required List<Map<String, dynamic>> bubbles,
    required List<Map<String, dynamic>>? mediaCards,
    required Map<String, dynamic>? summaryCard,
    required List<Map<String, dynamic>>? renderBlocks,
    required List<Map<String, dynamic>>? replyBlocks,
    required List<String>? followUps,
    required String? playUrl,
  }) async {
    final bool multiBubble = bubbles.length > 1;
    // 多泡时块序列只留卡片/媒体块；单泡（整轮一泡）块即全文视图，原样挂。
    List<Map<String, dynamic>>? lastReplyBlocks = replyBlocks;
    if (multiBubble && replyBlocks != null) {
      final List<Map<String, dynamic>> cardOnly = replyBlocks
          .where((b) => b["type"]?.toString() != "text")
          .toList();
      lastReplyBlocks = cardOnly.isEmpty ? null : cardOnly;
    }
    List<Map<String, dynamic>>? lastRenderBlocks = renderBlocks;
    if (multiBubble && renderBlocks != null) {
      final List<Map<String, dynamic>> mediaOnly = renderBlocks
          .where((b) => b["type"]?.toString() != "text")
          .toList();
      lastRenderBlocks = mediaOnly.isEmpty ? null : mediaOnly;
    }
    final List<ChatMessage> toSave = <ChatMessage>[];
    for (int i = 0; i < bubbles.length; i++) {
      final Map<String, dynamic> b = bubbles[i];
      final String id = b["id"]?.toString() ?? "";
      if (id.isEmpty) continue;
      final bool isLast = i == bubbles.length - 1;
      final String serverText =
          _sanitizeAssistantVisibleText(b["text"]?.toString() ?? "");
      final int? idx = _messageIndexById(id);
      if (idx != null && idx < _messages.length) {
        setState(() {
          final ChatMessage previous = _messages[idx];
          _messages[idx] = ChatMessage(
            messageId: previous.messageId,
            sessionId: previous.sessionId,
            role: previous.role,
            text: serverText.isNotEmpty ? serverText : previous.text,
            timestamp: previous.timestamp,
            attachmentImageCount: previous.attachmentImageCount,
            playUrl: isLast ? (playUrl ?? previous.playUrl) : previous.playUrl,
            attachments: previous.attachments,
            contentType: previous.contentType,
            durationMs: previous.durationMs,
            waveform: previous.waveform,
            mediaCards: isLast
                ? (mediaCards ?? previous.mediaCards)
                : previous.mediaCards,
            summaryCard: isLast
                ? (summaryCard ?? previous.summaryCard)
                : previous.summaryCard,
            renderBlocks: isLast ? lastRenderBlocks : previous.renderBlocks,
            replyBlocks: isLast ? lastReplyBlocks : previous.replyBlocks,
            followUpPrompts: isLast ? followUps : previous.followUpPrompts,
            // streaming 不带 → false：定稿
          );
        });
        toSave.add(_messages[idx]);
      } else {
        // 客户端漏收该泡 chunk：按服务端对账补建（含卡片附着）
        final ChatMessage rebuilt = ChatMessage(
          messageId: id,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: serverText,
          timestamp: DateTime.now(),
          playUrl: isLast ? playUrl : null,
          mediaCards: isLast ? mediaCards : null,
          summaryCard: isLast ? summaryCard : null,
          renderBlocks: isLast ? lastRenderBlocks : null,
          replyBlocks: isLast ? lastReplyBlocks : null,
          followUpPrompts: isLast ? followUps : null,
        );
        setState(() {
          _messages.add(rebuilt);
          _assistantMessageIndexById[id] = _messages.length - 1;
        });
        toSave.add(rebuilt);
      }
    }
    for (final ChatMessage m in toSave) {
      await _store.saveMessage(m);
    }
  }

  /// 真·分绿泡塌缩收口（finalTextReplacesStream）：出口重写/自检重跑让最终
  /// 文本与已流文本分叉时，删除本轮所有分泡，落一条 assistant-<traceId> 单泡
  /// 承载 finalText——避免"已流旧版分泡 + 重写新版"两版拼接。
  Future<void> _collapseBubblesToFinal({
    required List<String> bubbleIds,
    required String traceId,
    required String finalText,
    required String? playUrl,
    required List<Map<String, dynamic>>? mediaCards,
    required Map<String, dynamic>? summaryCard,
    required List<Map<String, dynamic>>? renderBlocks,
    required List<Map<String, dynamic>>? replyBlocks,
    required List<String>? followUps,
  }) async {
    final List<String> removedIds = <String>[];
    setState(() {
      _messages.removeWhere((m) {
        final bool hit = bubbleIds.contains(m.messageId) ||
            (traceId.isNotEmpty && _bubbleTraceOf(m.messageId) == traceId);
        if (hit) {
          _assistantMessageIndexById.remove(m.messageId);
          removedIds.add(m.messageId);
        }
        return hit;
      });
    });
    // 关键：流式阶段每泡已即时落盘（Isar 按 messageId upsert），塌缩必须同步
    // 删盘，否则重载后已塌缩的泡会诈尸回来（内存删了盘上还在）。
    for (final String id in removedIds) {
      try {
        await _store.deleteMessage(id);
      } catch (e) {
        debugPrint("[chat] bubble collapse deleteMessage failed: $e");
      }
    }
    final String collapsedId = traceId.isNotEmpty
        ? "assistant-$traceId"
        : "assistant-final-${DateTime.now().microsecondsSinceEpoch}";
    final int? existingIdx = _messageIndexById(collapsedId);
    final ChatMessage collapsed;
    if (existingIdx != null && existingIdx < _messages.length) {
      final ChatMessage previous = _messages[existingIdx];
      collapsed = ChatMessage(
        messageId: previous.messageId,
        sessionId: previous.sessionId,
        role: previous.role,
        text: finalText,
        timestamp: previous.timestamp,
        attachmentImageCount: previous.attachmentImageCount,
        playUrl: playUrl ?? previous.playUrl,
        attachments: previous.attachments,
        contentType: previous.contentType,
        durationMs: previous.durationMs,
        waveform: previous.waveform,
        mediaCards: mediaCards ?? previous.mediaCards,
        summaryCard: summaryCard ?? previous.summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
        followUpPrompts: followUps,
      );
      setState(() {
        _messages[existingIdx] = collapsed;
      });
    } else {
      collapsed = ChatMessage(
        messageId: collapsedId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        playUrl: playUrl,
        mediaCards: mediaCards,
        summaryCard: summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
        followUpPrompts: followUps,
      );
      setState(() {
        _messages.add(collapsed);
        _assistantMessageIndexById[collapsedId] = _messages.length - 1;
      });
    }
    await _store.saveMessage(collapsed);
  }

  void _flushAssistantChunks() {
    // 关键设计变更：流式阶段（agent 还在干活、思考气泡还在）期间，
    // **不要把 chunk 拼到消息列表**——避免用户看到「思考中」和「回复正文」同框。
    // 只清空缓冲，文本留到 chat.assistant_done 拿到 finalText 后再一次性入列表。
    // 缓冲本身仍保留（被 _handleAgentReplyTimeout 用作超时兜底文本）。
    _assistantChunkFlushTimer?.cancel();
    _assistantChunkFlushTimer = null;
    _pendingAssistantChunkMessageId = null;
  }

  String _takePendingAssistantChunkText() {
    final String buffered = _pendingAssistantChunkText.toString().trim();
    final String pending = _assistantTextSanitizer.drainPending().trim();
    _pendingAssistantChunkText.clear();
    _assistantTextSanitizer.reset();
    if (buffered.isEmpty) return pending;
    if (pending.isEmpty) return buffered;
    return buffered + pending;
  }

  String _sanitizeAssistantVisibleText(String text) {
    return stripAssistantProtocolFrames(text);
  }

  bool _shouldReplaceAssistantTextOnDone(
    String streamedText,
    String finalText,
  ) {
    final String current = streamedText.trim();
    final String resolved = finalText.trim();
    if (resolved.isEmpty) return false;
    if (current.isEmpty) return true;
    if (current == resolved) return false;
    if (current.startsWith(resolved)) {
      // 服务端权威剥除兜底：流式文本比 finalText 多出尾部内容，说明服务端在
      // done 前剥掉了流式阶段漏出的内容（NEXT_UP 建议块、残留标记等）——以
      // finalText 为准，不让泄漏文本留在气泡里（2026-09-22 睡前提醒泄漏）。
      return true;
    }
    if (_containsStructuredAssistantMarkers(resolved)) return true;
    if (_looksLikeRawToolJson(current) && !_looksLikeRawToolJson(resolved)) {
      return true;
    }
    return false;
  }

  bool _containsStructuredAssistantMarkers(String text) {
    return text.contains("[CONTENT_SUMMARY_V2_START]") ||
        text.contains("[AGENT_RESULT_CARD_START]") ||
        text.contains("[VIDEO_MEDIA_START]");
  }

  bool _looksLikeRawToolJson(String text) {
    final String trimmed = text.trimLeft();
    if (!trimmed.startsWith("{")) return false;
    return trimmed.contains('"items"') &&
        (trimmed.contains('"snippet"') ||
            trimmed.contains('"publishedAt"') ||
            trimmed.contains('"searchDateLocal"'));
  }

  ChatMessage _sanitizeLoadedChatMessage(ChatMessage message) {
    if (message.role != "assistant") return message;
    final String sanitizedText = _sanitizeAssistantVisibleText(message.text);
    if (sanitizedText == message.text) return message;
    // 重建时必须带上媒体字段：mediaCards/renderBlocks 是图片卡片的唯一来源，
    // 漏掉会导致「正文含协议标记的消息重启后图片全部消失」。
    return ChatMessage(
      messageId: message.messageId,
      sessionId: message.sessionId,
      role: message.role,
      text: sanitizedText,
      timestamp: message.timestamp,
      attachmentImageCount: message.attachmentImageCount,
      playUrl: message.playUrl,
      attachments: message.attachments,
      contentType: message.contentType,
      durationMs: message.durationMs,
      waveform: message.waveform,
      mediaCards: message.mediaCards,
      renderBlocks: message.renderBlocks,
      pendingMediaCards: message.pendingMediaCards,
    );
  }

  /// 消息是否带有可渲染的媒体内容（图片/视频卡片或交错渲染块）。
  bool _hasRenderableMedia(ChatMessage message) {
    final List<Map<String, dynamic>>? cards = message.mediaCards;
    final List<Map<String, dynamic>>? blocks = message.renderBlocks;
    return (cards != null && cards.isNotEmpty) ||
        (blocks != null && blocks.isNotEmpty);
  }

  void _clearAgentProcessingState({bool done = false}) {
    if (!_isAgentProcessing &&
        _agentStatusLine == null &&
        _agentStatusPercent == null &&
        _currentToolName == null &&
        _interimAckText == null &&
        !_subAgentDelegationActive &&
        _turnState == null &&
        _pendingLocalTurn == null) {
      return;
    }
    setState(() {
      _isAgentProcessing = false;
      _agentStatusLine = null;
      _agentStatusPercent = null;
      _currentToolName = null;
      _interimAckText = null;
      _subAgentDelegationActive = false;
      // v2：按调用方语义收尾 TurnState。
      // - done=true（chat.assistant_done）：markDone，UI 顶栏切「已收尾」后消失
      // - done=false（timeout/error/中断）：markCanceled，UI 顶栏切「已停止」后消失
      if (done) {
        _turnState?.markDone();
      } else {
        _turnState?.markCanceled();
      }
      _turnState = null;
      _pendingLocalTurn = null;
    });
    _notifyAgentProcessingUi(false);
    // 前台轮次收尾：hover「任务」页回落到空闲文案（后台任务面计数另算）。
    DynamicIslandController.instance.setForegroundAgent(active: false);
  }

  /// v2：用户点 TurnPanel 顶栏「停止」按钮时的软取消。
  /// 不发 WS 事件——只本地清状态，让后续 chunk/agent_status 因 traceId 不匹配被过滤。
  /// 服务端 LLM 调用仍在后台跑（无法硬中断），但客户端不再接收/渲染。
  /// 排队语义：只停止「当前活动轮次」；排队中的消息仍会按序被服务端处理，
  /// 其 chat.turn_started 到达时经排队晋级分支重新点亮处理状态。
  void _cancelCurrentTurn() {
    if (!_isAgentProcessing) return;
    _disarmAgentReplyWatchdog();
    ChatTurnController.instance.activeTraceId = null;
    _flushAssistantChunks();
    _takePendingAssistantChunkText();
    _clearAgentProcessingState(done: false);
  }

  /// interim 已改为作为独立 assistant 消息入列表（见 chat.assistant_interim
  /// handler），_interimAckText 字段不再被设置；_clearInterimAck 保留为 no-op
  /// 兼容旧调用点（chunk handler）。
  void _clearInterimAck() {
    if (_interimAckText == null) return;
    setState(() {
      _interimAckText = null;
    });
  }

  // ============================================================
  // 「分阶段异步对话交互 v2」事件 handlers
  // 骨架：仅在内存里把事件流跑通并维护 _turnState。
  // UI 改造（chat_page 接 TurnState 渲染顶栏 / 折叠面板 / 流式正文）下一轮再做。
  // ============================================================

  /// 阶段 0：服务端确认收到，路由开始。
  /// 用服务端 t0 替换本地占位（让首字延迟测量更准）；
  /// 若 traceId 与本轮不匹配或已无活动轮次，丢弃。
  ///
  /// 排队语义（2026-09-14）：服务端队列开始处理某条排队消息时，本事件是
  /// 客户端唯一的「该轮已激活」信号，承担三种分支：
  ///   - traceId == 活动轮次：常规路径；
  ///   - traceId ∈ 排队集合：晋级——服务端开始处理这条排队消息了；
  ///   - 无活动轮次且不在排队集合：采纳（429 退避重发乱序/重连等场景下
  ///     服务端真实轮序与客户端推断不一致时，以服务端为准自我修正）。
  void _handleTurnStartedV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    if (traceId == null || traceId.isEmpty) {
      return;
    }
    final String? activeTraceId = ChatTurnController.instance.activeTraceId;
    if (traceId != activeTraceId) {
      if (_queuedUserMessageIds.contains(traceId)) {
        // 晋级：排队消息成为活动轮次（重置看门狗与轮内状态徽标）
        _queuedUserMessageIds.remove(traceId);
        _armAgentReplyWatchdog(traceId);
        setState(() {
          _isAgentProcessing = true;
          _agentStatusLine = null;
          _agentStatusPercent = null;
          _currentToolName = null;
        });
        _notifyAgentProcessingUi(true);
      } else if (activeTraceId != null) {
        // 既有活动轮次且非本条：迟到事件，丢弃
        return;
      } else {
        // 无活动轮次：采纳服务端开启的轮次（自我修正）
        _armAgentReplyWatchdog(traceId);
        setState(() => _isAgentProcessing = true);
        _notifyAgentProcessingUi(true);
      }
    }
    final dynamic t0Raw = payload["t0"];
    final DateTime t0 = t0Raw is num
        ? DateTime.fromMillisecondsSinceEpoch(t0Raw.toInt())
        : DateTime.now();
    // 替换本地占位为服务端权威 t0
    _turnState = TurnState(
      traceId: traceId,
      sessionId: payload["sessionId"]?.toString() ?? "",
      t0: t0,
      phase: TurnPhase.routing,
    );
    _pendingLocalTurn = null;
    if (mounted) setState(() {});
  }

  /// 阶段 1：意图已识别。mode / plan / subAgents 落到 TurnState。
  void _handleIntentDetectedV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? activeTraceId = ChatTurnController.instance.activeTraceId;
    if (traceId == null ||
        traceId.isEmpty ||
        activeTraceId == null ||
        traceId != activeTraceId) {
      return;
    }
    final TurnState? ts = _turnState;
    if (ts == null || ts.traceId != traceId) return;

    final List<dynamic> reasonsRaw =
        (payload["reasons"] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> planRaw =
        (payload["plan"] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> subAgentsRaw =
        (payload["subAgents"] as List<dynamic>?) ?? const <dynamic>[];

    setState(() {
      ts.applyIntentDetected(
        mode: TurnIntentMode.fromWire(payload["mode"]?.toString()),
        reasons: reasonsRaw.map((e) => e.toString()).toList(),
        plan: planRaw
            .whereType<Map<String, dynamic>>()
            .map(TurnPlanStep.fromWire)
            .toList(),
        subAgents: subAgentsRaw
            .whereType<Map<String, dynamic>>()
            .map(TurnSubAgent.fromWire)
            .toList(),
      );
    });
  }

  /// 阶段 2：执行事件（工具调用 / 子 Agent / thought / log 兜底）。
  void _handleExecutionEventV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? activeTraceId = ChatTurnController.instance.activeTraceId;
    if (traceId == null ||
        traceId.isEmpty ||
        activeTraceId == null ||
        traceId != activeTraceId) {
      return;
    }
    final TurnState? ts = _turnState;
    if (ts == null || ts.traceId != traceId) return;

    final String kind = payload["kind"]?.toString() ?? "log";
    final String? eventId = payload["eventId"]?.toString();
    if (eventId == null) return;

    setState(() {
      ts.applyExecutionEvent(
        eventId: eventId,
        kind: kind,
        toolCall: payload["toolCall"] is Map<String, dynamic>
            ? payload["toolCall"] as Map<String, dynamic>
            : null,
        toolResult: payload["toolResult"] is Map<String, dynamic>
            ? payload["toolResult"] as Map<String, dynamic>
            : null,
        agentStart: payload["agentStart"] is Map<String, dynamic>
            ? payload["agentStart"] as Map<String, dynamic>
            : null,
        agentDone: payload["agentDone"] is Map<String, dynamic>
            ? payload["agentDone"] as Map<String, dynamic>
            : null,
        planStep: payload["planStep"] is Map<String, dynamic>
            ? payload["planStep"] as Map<String, dynamic>
            : null,
        thought: payload["thought"]?.toString(),
        log: payload["log"]?.toString(),
      );
      // 跨轮步骤条（2026-10-19 handoff）：同一份合并语义再喂给常驻列表——
      // TurnState 本轮的 plan 会随 done 一起消失，步骤条不能跟着消失。
      if (kind == "plan_step" && payload["planStep"] is Map<String, dynamic>) {
        applyPlanStepWire(
          _planSteps,
          payload["planStep"] as Map<String, dynamic>,
        );
      }
    });
  }

  /// 与聊天页「处理中」气泡同步；active=false 时服务端锁定本轮不再合并消息）
  void _notifyAgentProcessingUi(bool active) {
    if (_reportedAgentProcessingUiActive == active) return;
    _reportedAgentProcessingUiActive = active;
    if (!_ws.isConnected) return;
    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "active": active,
      "userId": ApiConfig.effectiveActorId,
    };
    _ws.sendEvent("chat.agent_processing_ui", payload);
  }

  void _armAgentReplyWatchdog(String userMessageId) {
    ChatTurnController.instance.armTrace(userMessageId);
  }

  void _resetAgentReplyWatchdog() {
    ChatTurnController.instance.resetTimer();
  }

  void _disarmAgentReplyWatchdog() {
    ChatTurnController.instance.cancelTimer();
  }

  void _handleAgentReplyTimeout({bool showSnackBar = true}) {
    if (!mounted) return;
    final bool wasProcessing = _isAgentProcessing;
    final String buffered = _pendingAssistantChunkText.toString().trim();
    // 关键：和 chat.assistant_done 一样，traceId 一定要先于 _clearAgentProcessingState
    // 清掉，否则迟到的 chunk 会看到 _isAgentProcessing=false 但 traceId 还在，
    // 重新把思考气泡点亮。
    final String? userMessageId = ChatTurnController.instance.activeTraceId;
    // 真·分绿泡：本轮已推出过分泡时，超时不另开"assistant-$traceId"单泡
    // （分泡正文已实时入列），只把挂着的 streaming 泡定稿，防打字机光标常亮。
    String? lastBubbleOfTrace;
    if (userMessageId != null) {
      for (final ChatMessage m in _messages.reversed) {
        if (_bubbleTraceOf(m.messageId) == userMessageId) {
          lastBubbleOfTrace = m.messageId;
          break;
        }
      }
      if (lastBubbleOfTrace != null) {
        _finalizeStreamingBubblesOfTrace(userMessageId);
      }
    }
    ChatTurnController.instance.activeTraceId = null;
    _flushAssistantChunks();
    final String assistantMessageId = userMessageId != null
        ? "assistant-$userMessageId"
        : "assistant-timeout-${DateTime.now().microsecondsSinceEpoch}";
    const String fallbackText = "抱歉，等待回复超时，请稍后重试";
    final int? idx = lastBubbleOfTrace != null
        ? _messageIndexById(lastBubbleOfTrace)
        : _messageIndexById(assistantMessageId);
    if (idx != null) {
      setState(() {
        final ChatMessage previous = _messages[idx];
        if (previous.text.trim().isEmpty) {
          _messages[idx] = ChatMessage(
            messageId: previous.messageId,
            sessionId: previous.sessionId,
            role: previous.role,
            text: fallbackText,
            timestamp: previous.timestamp,
            attachmentImageCount: previous.attachmentImageCount,
            playUrl: previous.playUrl,
            mediaCards: previous.mediaCards,
            renderBlocks: previous.renderBlocks,
            pendingMediaCards: previous.pendingMediaCards,
            streaming: false,
          );
        }
      });
    } else if ((wasProcessing || userMessageId != null) &&
        lastBubbleOfTrace == null) {
      // 新语义：流式期间 chunk 没进列表，超时分支是 agent 文本能进列表的唯一入口。
      // 优先用 _pendingAssistantChunkText 里已经缓冲到的部分流式片段作为兜底文
      // 本；如果缓冲是空的（连一个 chunk 都没收到），才用纯兜底文案。
      final String timeoutText =
          buffered.isNotEmpty ? "$buffered\n\n⚠️ 后续内容超时未到，已截断。" : fallbackText;
      final ChatMessage timeoutMessage = ChatMessage(
        messageId: assistantMessageId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: timeoutText,
        timestamp: DateTime.now(),
      );
      setState(() {
        _messages.add(timeoutMessage);
        _assistantMessageIndexById[assistantMessageId] = _messages.length - 1;
      });
      unawaited(_store.saveMessage(timeoutMessage));
    }
    _takePendingAssistantChunkText();
    _clearAgentProcessingState();
    _disarmAgentReplyWatchdog();
    if (showSnackBar && wasProcessing) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("Agent 回复超时，请检查网络或稍后重试")),
      );
    }
  }

  void _updateAgentStatusLine(
    String line, {
    bool ensureProcessing = false,
    int? percent,
  }) {
    final String trimmed = line.trim();
    if (trimmed.isEmpty) return;
    _resetAgentReplyWatchdog();
    setState(() {
      if (ensureProcessing) {
        _isAgentProcessing = true;
      }
      _agentStatusLine = trimmed;
      // 进度百分比：null 表示该事件不带进度（保持上次值或清为 null）
      _agentStatusPercent = percent;
    });
    if (ensureProcessing) {
      _notifyAgentProcessingUi(true);
    }
  }

  void _attachPlayUrlToAssistantMessage(String messageId, String playUrl) {
    final int? idx = _messageIndexById(messageId);
    if (idx == null) return;
    final ChatMessage previous = _messages[idx];
    if (previous.playUrl == playUrl) return;
    setState(() {
      _messages[idx] = ChatMessage(
        messageId: previous.messageId,
        sessionId: previous.sessionId,
        role: previous.role,
        text: previous.text,
        timestamp: previous.timestamp,
        attachmentImageCount: previous.attachmentImageCount,
        playUrl: playUrl,
        mediaCards: previous.mediaCards,
        renderBlocks: previous.renderBlocks,
        pendingMediaCards: previous.pendingMediaCards,
      );
    });
  }

  /// 首次在「无相册附件」的发送路径上询问一次；结果写入本地，之后不再弹窗询问
  Future<void> _pickGalleryImage() async {
    final List<VisionWireFrame> frames = await pickGalleryVisionWireFrames();
    if (!mounted || frames.isEmpty) {
      return;
    }
    setState(() {
      _pendingGalleryFrames
        ..clear()
        ..addAll(frames);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("已选择 ${frames.length} 张图片，发送时将一并传与 Agent")),
    );
  }

  /// 移除一张待发相册图（输入框缩略图右上角 ×）。
  void _removePendingGalleryImage(int index) {
    if (index < 0 || index >= _pendingGalleryFrames.length) {
      return;
    }
    setState(() {
      _pendingGalleryFrames.removeAt(index);
    });
  }

  static Uint8List _asUint8List(List<int> bytes) =>
      bytes is Uint8List ? bytes : Uint8List.fromList(bytes);

  void _rememberSentGalleryImages(String messageId, List<Uint8List> images) {
    if (images.isEmpty) {
      return;
    }
    // 长会话内存护栏：只保留最近 40 条带图消息的缩略字节。
    while (_sentGalleryImageBytes.length >= 40) {
      _sentGalleryImageBytes.remove(_sentGalleryImageBytes.keys.first);
    }
    _sentGalleryImageBytes[messageId] = images;
  }

  Future<void> _reportEmbodimentState() async {
    if (!_ws.isConnected || !mounted) return;
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    final double dpr = ctx != null ? MediaQuery.devicePixelRatioOf(ctx) : 1.0;
    final Map<String, dynamic>? report =
        await SphereEntityController.instance.collectStateReport(dpr);
    if (report == null) return;
    _ws.sendEvent("agent.embodiment.state", report);
  }

  void _syncAgentSphereFromWs(String type, Map<String, dynamic> payload) {
    if (type == "agent.embodiment.command") {
      final String? action = payload["action"]?.toString();
      if (action == "query_state") {
        unawaited(_reportEmbodimentState());
        return;
      }
      AgentSphereMoodBridge.instance.forwardMessage(<String, dynamic>{
        "type": "agent-sphere:command",
        "action": payload["action"],
        if (payload["x"] != null) "x": payload["x"],
        if (payload["y"] != null) "y": payload["y"],
        if (payload["z"] != null) "z": payload["z"],
        if (payload["strength"] != null) "strength": payload["strength"],
        if (payload["screenX"] != null) "screenX": payload["screenX"],
        if (payload["screenY"] != null) "screenY": payload["screenY"],
      });
      return;
    }
    final AgentSpherePatch? patch =
        AgentSphereEmbodimentMapper.mapWsEvent(type, payload);
    if (patch != null) {
      AgentSphereMoodBridge.instance.applyEmbodimentPatch(patch);
    }
  }

  void _sendSessionInit() {
    final Map<String, dynamic> sessionInit = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "deviceId": "local-device",
      "userAlias": "owner",
      // 共用浏览器桥：本连接即浏览器执行器（Agent 与用户共用 WebView2）
      "browserBridge": true,
      // 设备类别自报：服务端升级链据此区分电脑端/移动端触达（弹窗→TTS→推送/电话）
      "platform": _devicePlatform,
      // 媒体播放能力声明：服务端凭此放行 media.play（未声明时 media.play 如实失败）。
      // 分发区已接线 MediaPlaybackService，声明即真实可消费，不再是"信令没人消费"的假成功。
      "capabilities": <String, dynamic>{"mediaPlayback": kMediaPlaybackCapability},
      // 访问鉴权（ACCESS_AUTH_REQUIRED）开启时服务端校验此 token；
      // 未绑定/未开启时为 null，服务端行为不变。
      if (AccessCredentialStore.instance.token != null)
        "token": AccessCredentialStore.instance.token,
    };
    // 身份绑定：登录邮箱覆盖（未登录回落 USER_ID/sessionId）。
    // 无条件携带 userId——服务端 resolveActorId 以 userId 为准，
    // 这是按账号隔离记忆/世界/配额的第一闸。
    sessionInit["userId"] = ApiConfig.effectiveActorId;
    _ws.sendEvent("session.init", sessionInit);
  }

  /// 当前设备类别标识：手机系 → "mobile"，桌面/网页 → "desktop"。
  /// 服务端 normalizeDeviceClass 归一后随 WS 连接登记，供 critical 升级链
  /// 做"电脑端弹窗 / 移动端系统通知+来电"的分级触达与全离线判断。
  String get _devicePlatform {
    if (kIsWeb) return "desktop";
    if (Platform.isAndroid || Platform.isIOS) return "mobile";
    return "desktop";
  }

  Future<void> _sendMessage({String? text, bool isRetry = false}) async {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再发消息")),
        );
      }
      return;
    }
    final String effectiveText = text ?? _inputController.text.trim();

    List<VisionWireFrame>? attachmentFrames;
    if (_pendingGalleryFrames.isNotEmpty) {
      attachmentFrames = List<VisionWireFrame>.from(_pendingGalleryFrames);
      setState(_pendingGalleryFrames.clear);
    }

    if (effectiveText.isEmpty && attachmentFrames == null) {
      return;
    }

    // 豆包式列队发送（2026-09-14）：Agent 处理中收到的新输入不再打断当前轮，
    // 而是排队等待依次处理（服务端 MessageBatchProcessor 同语义，每条独立回复）。
    // 429 退避重发同样走排队：服务端按到达顺序排在已排队消息之后，两端顺序一致。
    final bool isQueued = isRetry || _isAgentProcessing;

    final int attachCount = attachmentFrames?.length ?? 0;
    final ChatMessage userMessage = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      text: effectiveText.isEmpty ? "（见图）" : effectiveText,
      timestamp: DateTime.now(),
      attachmentImageCount: attachCount,
    );

    // 气泡缩略图字节：发送前先记下，气泡一出现就能看到发了哪几张图；
    // sendEvent 失败时配合 _failedUserMessageIds 显示「未发出」。
    if (attachmentFrames != null && attachmentFrames.isNotEmpty) {
      _rememberSentGalleryImages(
        userMessage.messageId,
        <Uint8List>[
          for (final VisionWireFrame f in attachmentFrames)
            _asUint8List(f.bytes),
        ],
      );
    }

    // Phase 2：保存重试文本，供 429 回压时指数退避重发
    _pendingRetryText = effectiveText;
    if (isRetry) {
      // 重试时不重复添加用户消息（首次已添加）
    } else if (isQueued) {
      // 排队入列：活动轮次仍在进行并持有状态行，不重置
      setState(() {
        _messages.add(userMessage);
        _inputController.clear();
        _isAgentProcessing = true;
      });
    } else {
      setState(() {
        _messages.add(userMessage);
        _inputController.clear();
        _isAgentProcessing = true;
        _agentStatusLine = null;
      });
    }
    _notifyAgentProcessingUi(true);
    AgentSphereMoodBridge.instance.listening();
    if (!isRetry) {
      await _store.saveMessage(userMessage);
    }
    final Map<String, dynamic> userMsg = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMessage.messageId,
      "text": effectiveText.isEmpty && attachmentFrames != null
          ? ""
          : effectiveText,
      "timestamp": DateTime.now().toIso8601String(),
    };
    if (attachmentFrames != null && attachmentFrames.isNotEmpty) {
      userMsg["visionFrames"] =
          attachmentFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    // 与 session.init 同源：登录邮箱优先，消息落在本账号车道
    userMsg["userId"] = ApiConfig.effectiveActorId;

    // 位置不再随每条消息实时拉取（避免每次发消息都走 GPS + 逆地理）。
    // 改为按需：Agent 需要位置（如 weather.get_local 工具）时服务端下发
    // agent.location_request，客户端响应后实时回传；天气面板也会主动上报缓存。
    userMsg["agentAccessMode"] = "full";

    if (isQueued) {
      // 入队等待：不抢当前活动轮次的 traceId/看门狗/流式缓冲；
      // 服务端开始处理本条时 chat.turn_started 会把它晋级为活动轮次。
      _queuedUserMessageIds.add(userMessage.messageId);
    } else {
      _armAgentReplyWatchdog(userMessage.messageId);

      // v2 阶段 0：本地立即建占位 TurnState，让用户感知到「已发送 / 正在思考」，
      // 不等服务端 chat.turn_started 回来（豆包式即时反馈的关键）。
      _pendingLocalTurn = TurnState(
        traceId: userMessage.messageId,
        sessionId: ApiConfig.effectiveActorId,
        t0: DateTime.now(),
      );
      if (mounted) setState(() {});
    }

    final bool sent = _ws.sendEvent("chat.user_message", userMsg);
    if (!sent) {
      _queuedUserMessageIds.remove(userMessage.messageId);
      _disarmAgentReplyWatchdog();
      ChatTurnController.instance.activeTraceId = null;
      _clearAgentProcessingState();
      if (mounted) {
        setState(() {
          _failedUserMessageIds.add(userMessage.messageId);
        });
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("消息未发出：与服务器的连接尚未就绪")),
        );
      }
    }
  }

  /// 「选择型卡片」底部按钮点击处理:
  /// 用户点击选择型卡片上的按钮后的处理流程。
  ///
  /// 设计意图:点击是一个**静默决策**,不应该把按钮 label 当作用户发言
  /// 插到聊天流里(那样会让对话历史显得啰嗦、割裂)。正确的体验是:
  ///   1. 用户点按钮 → 按钮进入「已选」态(视觉反馈由卡片自身完成)
  ///   2. **不在聊天流里追加用户消息气泡**
  ///   3. 直接通过 WS 发送 `chat.user_action` 事件,携带卡片标题/条目摘要
  ///   4. 后端把摘要注入到 user_message 的 text 中,让 Agent 理解
  ///      「用户在 X 卡片上选择了 Y」并**主动产生一条衔接回复**
  ///   5. Agent 的回复作为 assistant 消息正常显示在聊天流
  ///
  /// 与 [_sendMessage] 的区别:
  ///   - 不在 _messages 里追加用户消息
  ///   - 不走输入框(controller)
  ///   - 不发 chat.user_message,改发 chat.user_action(携带 actionId/cardId/variant/payload)
  ///   - 复用「打断当前回复」「置 processing」等通用逻辑,保证按钮与键盘输入在 Agent 端一致
  ///   - [cardData] 由 chat_page 在渲染时绑定,包含 cardId/title/items,
  ///     用于后端审计/埋点精准定位到具体卡片,并让 Agent 理解上下文主动衔接
  Future<void> _handleCardAction(
    AgentResultAction action, {
    required AgentResultData cardData,
  }) async {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再试")),
        );
      }
      return;
    }
    final String label = action.label.trim();
    if (label.isEmpty) return;

    // 与 _sendMessage 同语义：处理中点击卡片按钮 → 排队，不打断当前轮
    final bool isQueued = _isAgentProcessing;

    // 用一个内部 traceId 关联本轮 Agent 回复(不添加用户消息气泡到 _messages)
    final String actionMessageId =
        "action-${DateTime.now().microsecondsSinceEpoch}";

    if (isQueued) {
      _queuedUserMessageIds.add(actionMessageId);
    } else {
      setState(() {
        _isAgentProcessing = true;
        _agentStatusLine = null;
      });
      _notifyAgentProcessingUi(true);
      AgentSphereMoodBridge.instance.listening();

      _armAgentReplyWatchdog(actionMessageId);

      // 本地占位 TurnState:让用户立即看到「Agent 正在思考衔接回复」反馈
      _pendingLocalTurn = TurnState(
        traceId: actionMessageId,
        sessionId: ApiConfig.effectiveActorId,
        t0: DateTime.now(),
      );
      if (mounted) setState(() {});
    }

    final bool sent = _ws.sendCardAction(
      sessionId: ApiConfig.sessionId,
      messageId: actionMessageId,
      actionId: action.id,
      label: label,
      cardId: cardData.cardId,
      variant: action.variant,
      actionPayload: action.payload,
      cardTitle: cardData.title,
      cardItems: cardData.items
          .map((AgentResultItem it) => it.text)
          .toList(growable: false),
      userId: ApiConfig.effectiveActorId,
    );
    if (!sent) {
      _queuedUserMessageIds.remove(actionMessageId);
      _disarmAgentReplyWatchdog();
      ChatTurnController.instance.activeTraceId = null;
      _clearAgentProcessingState();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("按钮点击未发出：与服务器的连接尚未就绪")),
        );
      }
    }
  }

  void _selectTab(int index) {
    setState(() => _tabIndex = index);
  }

  /// 好友入口：不再切整页 tab，而是从右侧滑出好友面板（2026-10-15 恢复）
  void _openAgentLinkTab() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.friends;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.friends.defaultSplitRatio;
    });
  }

  /// 消息面板入口已删除（2026-10-14）：消息类内容统一后台扫描，agent
  /// 判定有价值后才主动推送，不再提供前端陈列入口。RightPanelKind.messages
  /// 面板分支保留（代码路径仍可达性由服务端事件决定），仅撤 UI 触发点。

  /// 站内信未读轮询（15s）：站内信角标数据源。MessageHub 聚合未读轮询已随
  /// 「消息」工具撤除（2026-10-14），仅保留 InboxService 记账的未读数。
  Future<void> _pollUnreadMessages() async {
    final inboxResult = await _inboxApi.unreadCount();
    if (inboxResult.ok && mounted) {
      setState(() => _inboxUnread = inboxResult.value ?? 0);
      IslandRealFeeds.setInboxUnread(_inboxUnread);
    }
  }

  void _startMessagePolling() {
    _stopMessagePolling();
    _pollUnreadMessages();
    _messagePollTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      _pollUnreadMessages();
    });
  }

  void _stopMessagePolling() {
    _messagePollTimer?.cancel();
    _messagePollTimer = null;
  }

  /// 日程入口：不再弹出居中弹窗，而是与好友/消息/设备一致，从右侧滑出 split 双栏面板
  void _openSchedulePanel() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.schedule;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.schedule.defaultSplitRatio;
    });
  }

  /// 图片预览入口：媒体卡点击 → 在右侧双栏中打开大图预览。
  void _openImagePreview(ImagePreviewSnapshot item) {
    setState(() {
      _tabIndex = 0;
      _imagePreview = item;
      _rightPanel = RightPanelKind.imagePreview;
      _previousSplitRatio = _splitRatio;
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.imagePreview.defaultSplitRatio;
    });
  }

  /// 视频播放入口：视频卡点击 → 右侧双栏 WebView2 内联播放。
  void _openVideoPreview(VideoPreviewSnapshot item) {
    setState(() {
      _tabIndex = 0;
      _videoPreview = item;
      _rightPanel = RightPanelKind.videoPreview;
      _previousSplitRatio = _splitRatio;
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.videoPreview.defaultSplitRatio;
    });
  }

  /// 内容详情入口：详情卡（科技新闻等长内容折叠卡）点击 →
  /// 复用右侧双面板继续展示完整内容（书签导航 + markdown 正文）。
  /// 窗口过窄无法分栏时回退为居中弹窗，保证功能可达。
  void _openContentSummaryPanel(ContentSummaryDataV2 summary) {
    if (MediaQuery.sizeOf(context).width < kWideLayoutBreakpoint) {
      unawaited(ContentSummaryDetailModal.show(context, summary));
      return;
    }
    setState(() {
      _tabIndex = 0;
      _contentSummary = summary;
      _rightPanel = RightPanelKind.contentSummary;
      _previousSplitRatio = _splitRatio;
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.contentSummary.defaultSplitRatio;
    });
  }

  /// 行程规划入口：行程卡(travel_itinerary)点击 / autoOpen → 打开行程规划。
  ///
  /// 打开方式按平台分流（2026-10-12 收敛）：
  ///   - Android / iOS：**原生行程页**（TravelPlanMobilePage，纯 Flutter
  ///     实现）。应用内浏览器路径已退役——行程界面直接做在 App 里。
  ///   - Windows 桌面：**只走独立系统窗口**（spawn 子进程，页面 = 服务端
  ///     /travel-map/desktop 的「行迹」桌面版，与设计稿 1:1）。此前桌面首选
  ///     「本机 server 页面 + 系统浏览器」，于是同一张卡会先弹独立窗口、
  ///     又开一个浏览器标签页——两条路并存是用户报的「两种打开方式」。
  ///     常用工具「行程」入口则打开**应用内**行程归档页（见 _openTravelArchive），
  ///     独立窗口链路保持不变。
  void _openTravelPlanPanel(AgentResultData data) {
    unawaited(_openTravelPlanWindow(data));
  }

  Future<void> _openTravelPlanWindow(AgentResultData data) async {
    if (!kIsWeb && (Platform.isAndroid || Platform.isIOS)) {
      // 手机端：原生行程页（2026-10-12 起替代应用内浏览器）
      final BuildContext? navCtx = _rootNavigatorKey.currentContext;
      if (navCtx != null && navCtx.mounted) {
        await TravelPlanMobilePage.show(
          navCtx,
          plan: TravelPlanData.from(data),
        );
        return;
      }
      // navCtx 不可用（极罕见）：落回桌面分支——Windows 窗口启动在
      // 移动端会失败，最终退到下方应用内全屏页兜底。
    }
    // 桌面（以及手机端浏览器不可用）：独立子进程窗口
    final bool opened = await TravelPlanWindowLauncher.open(data);
    if (opened) {
      if (!mounted) return;
      setState(() => _tabIndex = 0); // 主窗口聚焦时，行程卡就在聊天页眼前
      return;
    }
    // 独立窗口不可用（非 Windows / spawn 失败）：退回窗口内全屏页
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    Navigator.of(navCtx).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanFullscreenPage(data: data),
      ),
    );
  }

  /// 常用工具「图库」入口：全屏路由打开图库工作台（3D 照片墙 + 2D 管理视图）。
  /// 2026-09-29 起图库退出一级 tab（侧栏只留「对话」）：右面板窄栏放不下
  /// 照片墙，改走全屏路由，页内返回按钮退出。
  void _openGalleryPanel() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    unawaited(GalleryWorkbenchPage.show(navCtx));
  }

  /// 常用工具「行程」入口：全屏路由打开应用内行程归档页。
  /// 对话中创建过的行程（服务端 data/travel-plans 落盘）都在这里沉淀，
  /// 点条目回看详情：桌面 = 应用内 WebView 面板，手机 = 原生行程页。
  void _openTravelArchive() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    unawaited(TravelPlanArchivePage.show(navCtx));
  }

  /// 常用工具「浏览器」入口：打开用户与 Agent 共用的内嵌浏览器面板。
  void _openBrowserPanel() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.browser;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.browser.defaultSplitRatio;
    });
  }

  /// Agent 主页入口：光球头像单击 / 右侧面板动态区 → 与日程/消息一致，
  /// 从右侧滑出主页 split 双栏面板（聊天在左、主页在右，可拖拽调宽）。
  /// 窄窗口（< kWideLayoutBreakpoint）无双栏布局，退化为全屏路由页保证可达。
  void _openAgentHomePanel() {
    if (MediaQuery.sizeOf(context).width < kWideLayoutBreakpoint) {
      final BuildContext? navCtx = _rootNavigatorKey.currentContext;
      if (navCtx != null && navCtx.mounted) {
        unawaited(AgentHomePage.show(navCtx));
      }
      return;
    }
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.agentHome;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.agentHome.defaultSplitRatio;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 任务面回执（chat.task_update / chat.task_cancel）
  // ═══════════════════════════════════════════════════════════

  /// 处理任务面生命周期广播（2026-09-09 仿扣子形态改造）。
  ///
  /// 回执气泡已整体移除：任务过程反馈收进输入框上方状态条
  /// （`TaskPlaneState` 计数驱动「N 个任务后台进行中」），任务结果由
  /// chat.assistant_done(source=task_plane) 以普通 assistant 消息直接落进对话流，
  /// 落位即终态——对话流里不再出现「已在后台办理/已完成」等过程回执。
  void _handleTaskPlaneUpdate(Map<String, dynamic> payload) {
    final String taskId = payload["taskId"]?.toString() ?? "";
    final String state = payload["state"]?.toString() ?? "";
    if (taskId.isEmpty || state.isEmpty) return;

    final bool changed = _taskPlaneState.applyLifecycle(
      taskId: taskId,
      state: state,
    );
    if (changed && mounted) {
      setState(() {});
    }
    if (changed) {
      IslandRealFeeds.setTaskActivity(activeCount: _taskPlaneState.activeCount);
    }
  }

  /// 取消后台任务（回执 hover 取消入口）：与「发送新消息打断前台回复」
  /// 语义分离——本事件只作用于任务面的这条任务，不影响当前对话轮次。
  void _cancelBackgroundTask(String taskId) {
    if (taskId.isEmpty) return;
    _ws.sendEvent("chat.task_cancel", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "taskId": taskId,
    });
  }

  /// 任务面结果落位（chat.assistant_done + source=task_plane，含离线 outbox 重放）。
  ///
  /// 结果以独立 assistant 消息入列（只含结果本体，归属由任务回执与
  /// thread 任务记录承接），
  /// 不触碰前台轮次的任何状态；落位后移除该任务的过程回执——回执只为
  /// 「进行中」提供状态屏，真正的结果消息接管后回执即完成使命。
  Future<void> _handleTaskPlaneResultDone(Map<String, dynamic> payload) async {
    final String messageId = payload["messageId"]?.toString() ??
        "assistant-task-${DateTime.now().microsecondsSinceEpoch}";
    final String finalText = _sanitizeAssistantVisibleText(
        payload["finalText"]?.toString() ?? "");
    _dismissTaskReceiptForMessage(messageId);
    // 媒体卡片（2026-09-09）：照片/视频任务的后台执行结果随 done 携带结构化卡片，
    // 与前台轮次的 mediaCards 同构——没有它照片任务只剩文字描述。
    final List<Map<String, dynamic>>? mediaCardsFromPayload =
        payload["mediaCards"] is List
            ? (payload["mediaCards"] as List)
                .whereType<Map<String, dynamic>>()
                .toList()
            : null;
    // 结构化摘要卡（CONTENT_SUMMARY 通道迁移）：任务面 done 与前台轮次同构。
    final Map<String, dynamic>? summaryCardFromPayload =
        payload["summaryCard"] is Map<String, dynamic>
            ? payload["summaryCard"] as Map<String, dynamic>
            : null;
    // 回复信封块：任务面 done 与前台轮次同构，服务端已把卡片标记确定性拆成
    // text/card 序列（行程卡收尾独立成块）——优先按 blocks 渲染，
    // 消除文本解析漂移导致的漏卡。
    final List<Map<String, dynamic>>? replyBlocksFromPayload =
        payload["blocks"] is List
            ? (payload["blocks"] as List)
                .whereType<Map<String, dynamic>>()
                .toList()
            : null;
    if (finalText.trim().isEmpty &&
        (mediaCardsFromPayload == null || mediaCardsFromPayload.isEmpty) &&
        summaryCardFromPayload == null) {
      return;
    }
    final int? idx = _messageIndexById(messageId);
    final ChatMessage message = ChatMessage(
      messageId: messageId,
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: finalText,
      timestamp: (idx != null && idx < _messages.length)
          ? _messages[idx].timestamp
          : DateTime.now(),
      mediaCards: mediaCardsFromPayload,
      summaryCard: summaryCardFromPayload,
      replyBlocks: replyBlocksFromPayload,
    );
    void apply() {
      if (idx != null && idx < _messages.length) {
        _messages[idx] = message;
        _assistantMessageIndexById[messageId] = idx;
      } else {
        _messages.add(message);
        _assistantMessageIndexById[messageId] = _messages.length - 1;
      }
    }

    if (mounted) {
      setState(apply);
    } else {
      apply();
    }
    await _store.saveMessage(message).catchError((Object e) {
      debugPrint("[chat] task plane result saveMessage failed: $e");
    });
    // 行程卡预热（2026-09-25）：任务面是旅游规划的主车道——结果落位后把
    // 行程载荷预注入规划窗口（常驻换载或隐藏拉起），点「打开行程规划」零等待。
    // 与前台轮次 done 分支的预热同款；只认 blocks 里的行程卡（text 已被
    // 服务端收口，标记仍在，双路解析等价，这里走 blocks 与渲染同源）。
    final Map<String, dynamic>? travelCardJson = (replyBlocksFromPayload ?? const <Map<String, dynamic>>[])
        .where((b) => b["type"]?.toString() == "card")
        .map((b) => b["card"] as Map<String, dynamic>?)
        .firstWhere(
          (c) => c?["cardType"]?.toString() == "travel_itinerary",
          orElse: () => null,
        );
    if (travelCardJson != null) {
      unawaited(
          TravelPlanWindowLauncher.warm(AgentResultData.fromJson(travelCardJson)));
    }
  }

  /// 按结果 messageId（`assistant-task-<taskId>`）定位并移除对话流内的过程回执。
  void _dismissTaskReceiptForMessage(String resultMessageId) {
    if (!resultMessageId.startsWith("assistant-task-")) return;
    final String taskId = resultMessageId.substring("assistant-task-".length);
    final String? receiptId = _taskReceiptMessageIdByTaskId.remove(taskId);
    _taskPlaneState.remove(taskId);
    IslandRealFeeds.setTaskActivity(
        activeCount: _taskPlaneState.activeCount);
    if (receiptId == null || !mounted) return;
    final int? idx = _messageIndexById(receiptId);
    if (idx == null || idx >= _messages.length) return;
    setState(() {
      _messages.removeAt(idx);
      _rebuildAssistantIndex();
    });
  }

  /// 删除「一整轮对话」：用户提问 + 该轮 Agent 的全部回复气泡（正文、工具/思考
  /// 过程、分泡、卡片回执、后台任务回执……）。
  ///
  /// 替换原 `_deleteSingleMessage`，两处关键修正：
  /// 1. 粒度：旧实现只删被点的那一条气泡，留下孤零零的另一半；现在按轮次摘除
  ///    （user 消息 + 其后所有非 user 气泡，直到下一条 user 消息）。
  /// 2. 服务端：旧实现发 `chat.clear_history`，服务端落到 `clearAllMemoryForActor`
  ///    ——删一条消息等于把整个会话线程 + 全部 Agent 记忆清空。现在改调
  ///    `/api/chat-data/delete-turn` 精准摘除这一轮，其余历史与记忆原样保留。
  Future<void> _deleteTurn(String messageId) async {
    final int anchor =
        _messages.indexWhere((ChatMessage m) => m.messageId == messageId);
    if (anchor < 0) return;

    // 点在 Agent 气泡上 → 回溯到本轮的 user 消息（轮次锚点）；回溯不到时
    // （呼叫失败通知等孤儿 assistant 气泡，前面没有 user 消息）以该气泡自身
    // 为轮次起点，只删它到下一条 user 消息之间的内容。
    int start = anchor;
    bool anchoredToUser = _messages[anchor].role == "user";
    if (!anchoredToUser) {
      start = -1;
      for (int i = anchor - 1; i >= 0; i--) {
        if (_messages[i].role == "user") {
          start = i;
          anchoredToUser = true;
          break;
        }
      }
      if (start < 0) start = anchor;
    }

    // 轮次右边界：下一条 user 消息（不含）
    int end = start + 1;
    while (end < _messages.length && _messages[end].role != "user") {
      end++;
    }

    final List<String> turnIds = _messages
        .sublist(start, end)
        .map((ChatMessage m) => m.messageId)
        .toList();

    // 删的是正在进行的这一轮 → 先掐断，否则迟到的 chunk / done 会把刚删掉的
    // 气泡重新插回列表（按 messageId 找不到就当新消息重建）。
    final String? activeTraceId = ChatTurnController.instance.activeTraceId;
    if (activeTraceId != null && turnIds.contains(activeTraceId)) {
      _cancelCurrentTurn();
    }

    for (final String id in turnIds) {
      await _store.deleteMessage(id);
    }

    // 服务端精准删除这一轮（不清空整个会话上下文 / Agent 记忆）。
    // 孤儿 assistant 气泡没有 user 锚点，服务端线程里本来就没有这一轮，
    // 只删本地即可。
    if (anchoredToUser) {
      unawaited(_notifyServerDeleteTurn(
        _messages[start].messageId,
        _messages[start].text,
      ));
    }

    if (!mounted) return;
    setState(() {
      _messages.removeRange(start, end);
      // 本轮可能挂着后台任务回执 / 排队中的追问，一并清索引，避免删完后
      // 回执按 messageId 找不到宿主消息、排队集合里残留已消失的 id。
      _taskReceiptMessageIdByTaskId
          .removeWhere((String _, String mid) => turnIds.contains(mid));
      _queuedUserMessageIds.removeAll(turnIds);
      _failedUserMessageIds.removeAll(turnIds);
      // 重建索引：被删除位置之后的索引全部前移
      _rebuildAssistantIndex();
    });
  }

  /// 通知服务端摘除这一轮对话（失败不打断本地删除：本地已删，服务侧未命中不影响 UI）。
  ///
  /// 带上 [userText] 是为了服务端能兜底定位「本功能上线前落盘的旧轮次」——那些消息当年
  /// 没有把 messageId 落盘，服务端重启后按 id 找不到，只能按原文唯一命中来定位。
  ///
  /// 服务端未命中会打日志：`message_not_found` 意味着服务端线程里已经没有这一轮
  /// （已被上下文窗口裁掉，或该轮早于落盘窗口）——语义上仍是「已删掉」；
  /// 而 `session_not_found` 才是异常，说明这次删除没落到服务端，需要查路由/会话 id。
  Future<void> _notifyServerDeleteTurn(
    String userMessageId,
    String? userText,
  ) async {
    try {
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/chat-data/delete-turn"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "sessionId": ApiConfig.effectiveActorId,
              "messageId": userMessageId,
              if (userText != null && userText.trim().isNotEmpty)
                "text": userText.trim(),
            }),
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) {
        debugPrint(
            "[chat] delete-turn HTTP ${res.statusCode}: ${res.body}");
        return;
      }
      final Object? decoded = jsonDecode(res.body);
      if (decoded is Map && decoded["ok"] != true) {
        debugPrint(
            "[chat] delete-turn 服务端未命中: reason=${decoded["reason"]}");
      }
    } catch (e) {
      // 服务端不可达：本地删除已生效，忽略（下次对话由线程自然重建）
      debugPrint("[chat] delete-turn 请求失败: $e");
    }
  }

  /// 删除从某条消息起之后的所有消息（含该条）—— 本地 + 服务端同步
  Future<void> _deleteMessagesFrom(String fromMessageId) async {
    final int fromIdx =
        _messages.indexWhere((ChatMessage m) => m.messageId == fromMessageId);
    if (fromIdx < 0) return;

    // 批量删除 store 中对应的消息
    for (int i = fromIdx; i < _messages.length; i++) {
      await _store.deleteMessage(_messages[i].messageId);
    }
    // 通知服务端同步清除 ChatThreadStore
    _ws.sendEvent("chat.clear_history", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
    });
    setState(() {
      _messages.removeRange(fromIdx, _messages.length);
      _rebuildAssistantIndex();
    });
  }

  /// 跨端历史回填：GET /api/chat-data/history?full=1 从服务端 turn WAL
  /// （聊天记录权威源）反解完整转史，按轮合并进当前聊天流并逐条落本地
  /// Isar（下次启动直接命中）。与手机端 mobile_chat_controller 的
  /// _pullServerHistory/_mergeServerTurns 同一套锚定去重语义：
  /// - 锚 = 用户消息：clientMessageId 命中 / 用户原文精确命中 / 纯图占位
  ///   （服务端「（用户发送了…」↔ 本地「（见图）」）→ 整轮跳过，
  ///   分泡/塌缩形态差异不再制造双份；
  /// - 无锚孤儿助手消息按正文包含关系去重后按时间戳落位插入。
  Future<void> _pullServerHistoryIntoStream() async {
    final String actorId = ApiConfig.effectiveActorId;
    if (actorId.isEmpty) return;
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/chat-data/history")
          .replace(queryParameters: <String, String>{
        "userId": actorId,
        "limit": "200",
        "full": "1",
      });
      final http.Response res = await http
          .get(uri, headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      final List<dynamic> raw = body["messages"] as List<dynamic>? ?? const [];
      if (raw.isEmpty) return;

      final List<ChatMessage> incoming = <ChatMessage>[];
      int fallbackSeq = 0;
      for (final dynamic item in raw) {
        if (item is! Map<String, dynamic>) continue;
        final String role = item["role"]?.toString() ?? "";
        final String text =
            stripAssistantProtocolFrames(item["text"]?.toString() ?? "").trim();
        if ((role != "user" && role != "assistant") || text.isEmpty) continue;
        final int? tsMs = item["ts"] is int ? item["ts"] as int : null;
        final DateTime ts = tsMs != null
            ? DateTime.fromMillisecondsSinceEpoch(tsMs)
            : DateTime.now();
        final String? clientMessageId = item["clientMessageId"]?.toString();
        final String messageId =
            role == "user" && (clientMessageId?.isNotEmpty ?? false)
                ? clientMessageId!
                : "hist-$role-${ts.millisecondsSinceEpoch}-${fallbackSeq++}";
        incoming.add(ChatMessage(
          messageId: messageId,
          sessionId: actorId,
          role: role,
          text: text,
          timestamp: ts,
        ));
      }

      // 按 user 锚切轮（开头没有锚的孤儿助手消息自成一轮）
      final List<List<ChatMessage>> turns = <List<ChatMessage>>[];
      for (final ChatMessage m in incoming) {
        if (m.role == "user" || turns.isEmpty) {
          turns.add(<ChatMessage>[m]);
        } else {
          turns.last.add(m);
        }
      }

      final List<ChatMessage> merged = List<ChatMessage>.from(_messages);
      final Set<String> localUserIds = <String>{};
      final Set<String> localUserTexts = <String>{};
      final List<ChatMessage> localAssistants = <ChatMessage>[];
      for (final ChatMessage m in merged) {
        if (m.role == "user") {
          localUserIds.add(m.messageId);
          localUserTexts.add(m.text.trim());
        } else if (m.text.trim().isNotEmpty) {
          localAssistants.add(m);
        }
      }
      final Set<String> backfilledAssistantTexts = <String>{};

      bool turnExistsLocally(List<ChatMessage> turn) {
        final ChatMessage anchor = turn.first;
        if (anchor.role != "user") return false;
        final String anchorText = anchor.text.trim();
        if (localUserIds.contains(anchor.messageId)) return true;
        if (localUserTexts.contains(anchorText)) return true;
        // 纯图轮：本地气泡文案与服务端视觉占位文案不同，视为同一轮
        if (anchorText == "（见图）" && localUserTexts.contains("（见图）")) {
          return true;
        }
        return false;
      }

      bool assistantKnown(ChatMessage m) {
        final String text = m.text.trim();
        if (backfilledAssistantTexts.contains(text)) return true;
        for (final ChatMessage local in localAssistants) {
          final String lt = local.text.trim();
          // 包含关系去重：服务端合并正文 ↔ 本地分泡互为片段时视为同一条回复
          if (lt.length >= 8 && text.contains(lt)) return true;
          if (text.length >= 8 && lt.contains(text)) return true;
        }
        return false;
      }

      bool mutated = false;
      for (final List<ChatMessage> turn in turns) {
        if (turnExistsLocally(turn)) continue;
        for (final ChatMessage m in turn) {
          if (m.role == "assistant" && assistantKnown(m)) continue;
          if (m.role == "assistant") backfilledAssistantTexts.add(m.text.trim());
          int idx = merged
              .indexWhere((local) => local.timestamp.isAfter(m.timestamp));
          if (idx < 0) idx = merged.length;
          merged.insert(idx, m);
          if (m.role == "user") {
            localUserIds.add(m.messageId);
            localUserTexts.add(m.text.trim());
          } else {
            localAssistants.add(m);
          }
          try {
            await _store.saveMessage(m);
          } catch (e) {
            debugPrint("[chat] server-history persist failed: $e");
          }
          mutated = true;
        }
      }
      if (!mutated || !mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(merged);
        // 插入改变了下标，assistant 消息索引必须重建（chunk 去重依赖它）
        _rebuildAssistantIndex();
      });
    } catch (e) {
      debugPrint("[chat] 服务端历史拉取失败(跳过跨端回填): $e");
    }
  }

  /// 重建 assistant 消息索引（删除后索引失效需重建）
  void _rebuildAssistantIndex() {
    _assistantMessageIndexById.clear();
    for (int i = 0; i < _messages.length; i++) {
      if (_messages[i].role != "user") {
        _assistantMessageIndexById[_messages[i].messageId] = i;
      }
    }
  }

  /// 按 messageId 定位消息在 [_messages] 中的下标（根源防线）。
  ///
  /// 优先查 [_assistantMessageIndexById] 索引；索引未命中或指向错误时
  /// 回退全列表扫描并回写索引。所有「add 前先判断是否已存在」的入口
  /// 都必须走这里，保证索引与列表永远一致——任何索引失真（历史脏数据、
  /// 删除/重建遗漏、缓存恢复后未重建等）都不会再导致同一条消息被重复插入。
  int? _messageIndexById(String messageId) {
    final int? fromIndex = _assistantMessageIndexById[messageId];
    if (fromIndex != null &&
        fromIndex >= 0 &&
        fromIndex < _messages.length &&
        _messages[fromIndex].messageId == messageId) {
      return fromIndex;
    }
    // 索引缺失或指向了别的消息 → 回退全列表扫描，并顺手修复索引
    _assistantMessageIndexById.remove(messageId);
    for (int i = 0; i < _messages.length; i++) {
      if (_messages[i].messageId == messageId) {
        if (_messages[i].role != "user") {
          _assistantMessageIndexById[messageId] = i;
        }
        return i;
      }
    }
    return null;
  }

  /// 清理本地 store 中同 messageId 的重复记录：
  /// deleteMessage 按 messageId 全删（无法只删一条），所以先删光，
  /// 再把去重后保留的那条重新落盘。
  Future<void> _cleanupDuplicateMessages(
    List<ChatMessage> dedupedMessages,
    Map<String, int> messageIndexById,
    Set<String> duplicateMessageIds,
  ) async {
    for (final String messageId in duplicateMessageIds) {
      try {
        final int? keptIdx = messageIndexById[messageId];
        if (keptIdx == null || keptIdx >= dedupedMessages.length) continue;
        await _store.deleteMessage(messageId);
        await _store.saveMessage(dedupedMessages[keptIdx]);
        debugPrint("[chat] dedupe: cleaned duplicate messageId=$messageId");
      } catch (e) {
        debugPrint("[chat] dedupe cleanup failed for $messageId: $e");
      }
    }
  }

  void _sendPeerIncomingResponse(String callId, String action) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      return;
    }
    _ws.sendEvent("voice.incoming_response", <String, dynamic>{
      "callId": callId,
      "action": action,
    });
  }

  /// 联系反馈 WS 桥：AmbientFeedsController 经此端口回传，不直依赖 WS 单例。
  void sendContactFeedbackViaWsBridge({
    required String channel,
    required bool responded,
    String? feedback,
    int? responseTimeMs,
    bool? quietHours,
  }) {
    _ws.sendContactFeedback(
      sessionId: ApiConfig.effectiveActorId,
      channel: channel,
      responded: responded,
      feedback: feedback,
      responseTimeMs: responseTimeMs,
      quietHours: quietHours,
    );
  }

  /// AmbientFeedsController 端口装配：编排层在控制器，呈现层留这里。
  void _configureAmbientFeeds() {
    final AmbientFeedsController c = AmbientFeedsController.instance;
    c.removeScheduleForDeletedTask = (String taskId) =>
        removeLocalScheduleForDeletedTask(_store, taskId);
    c.syncSchedule = _syncScheduleFromServer;
    c.isAppBackgrounded = () => _appBackgrounded;
    c.bumpInboxUnread = () {
      if (!mounted) return;
      setState(() => _inboxUnread += 1);
      IslandRealFeeds.setInboxUnread(_inboxUnread);
    };
    c.showInboxSnackBar = (String title, String body, String messageId) async {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text("$title\n$body"),
          duration: const Duration(seconds: 6),
          action: messageId.isEmpty
              ? null
              : SnackBarAction(
                  label: "知道了",
                  onPressed: () {
                    unawaited(
                      _inboxApi
                          .markRead(ids: [messageId])
                          .then((_) => _pollUnreadMessages()),
                    );
                  },
                ),
        ),
      );
    };
    c.persistRelayMessage = (AgentRelayMessage inbound) async {
      setState(() {
        final int dup = _relayInbound
            .indexWhere((AgentRelayMessage x) => x.messageId == inbound.messageId);
        if (dup >= 0) {
          _relayInbound[dup] = inbound;
        } else {
          _relayInbound.insert(0, inbound);
        }
      });
      await _store.upsertRelayMessage(ApiConfig.effectiveActorId, inbound);
    };
    // 补投/重放去重：服务端重连补投按 messageId 重推，本端已落库的不再重复提示
    c.isRelayMessageKnown = (String messageId) => _relayInbound
        .any((AgentRelayMessage x) => x.messageId == messageId);
    c.showRelayToast = (String fromSessionId) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text("收到来自 $fromSessionId 的中继消息")),
      );
    };
    c.sendContactFeedbackViaWs = sendContactFeedbackViaWsBridge;
    // 前台轮次 watchdog：时序在 ChatTurnController，超时收尾动作留在本 State。
    ChatTurnController.instance.onTimeout =
        ({bool showSnackBar = true}) => _handleAgentReplyTimeout(
              showSnackBar: showSnackBar,
            );
  }

  /// App 生命周期（手机后台时主动消息走系统通知，类微信常在线提醒）
  AppLifecycleState _lifecycleState = AppLifecycleState.resumed;
  bool get _isMobile => !kIsWeb && (Platform.isAndroid || Platform.isIOS);
  // ⚠️ 铁律（用户 2026-10-13 明令）：_isMobile 必须永远只按平台判定
  // （Android/iOS）。桌面 exe（Windows/macOS/Linux）绝不允许为了调试手机 UI
  // 而伪造这个值（加调试开关、环境变量、写死 true 等一律禁止）。
  // 调试手机端 UI 用独立入口 main_mobile.dart，不要动桌面路由。
  bool get _appBackgrounded => _lifecycleState != AppLifecycleState.resumed;

  // ====== 统一主动性管道：决策卡 + outcome 反馈回传（2026-10-14 定稿）======

  /// 高重要度主动消息 → 对话流决策卡（不飘弹窗/玻璃卡）。
  /// 用户在卡上点「我知道了」→ outcome accepted；「忽略」→ dismissed。
  void _showProactivePopup(String title, String text, String deliveryId) {
    _appendDecisionCard(<String, dynamic>{
      "kind": "proactive",
      "title": title,
      "message": text,
      "priority": "high",
      "state": "pending",
      "deliveryId": deliveryId,
    });
  }

  /// 提醒升级链 popup 级（reminder_popup）→ 对话流决策卡。
  /// 确认与忽略都算已知晓：点击即 AttentionApi ack（via=chat_card），
  /// 服务端升级链随之收敛。
  void _showAttentionPopup(
    String title,
    String message,
    String priority,
    String attentionId,
  ) {
    _appendDecisionCard(<String, dynamic>{
      "kind": "attention",
      "title": title,
      "message": message,
      "priority": priority,
      "state": "pending",
      "attentionId": attentionId,
    });
  }

  /// 往对话流追加一条 assistant 纯文字气泡（内存态，同决策卡模式构造）。
  void _appendAssistantText(String messageIdPrefix, String text) {
    final ChatMessage message = ChatMessage(
      messageId: "$messageIdPrefix-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: text,
      timestamp: DateTime.now(),
    );
    void apply() {
      _messages.add(message);
      _assistantMessageIndexById[message.messageId] = _messages.length - 1;
    }

    if (mounted) {
      setState(apply);
    } else {
      apply();
    }
  }

  /// 睡前提醒（evening.digest，2026-10-16 接线）：以消息形式落对话聊天流，
  /// 不走应用内玻璃胶囊弹窗（2026-10-19 用户定调）。narrationText 是唯一
  /// 文案源（2026-10-13 服务端定调），不渲染结构化块；后台不另发系统通知
  /// （离线兜底由 proactivePipeline 承担）。
  Future<void> _handleEveningDigestEvent(Map<String, dynamic> payload) async {
    String text = payload["narrationText"]?.toString() ?? "";
    if (text.trim().isEmpty) {
      final Object? digest = payload["digest"];
      if (digest is Map) text = digest["narrationText"]?.toString() ?? "";
    }
    text = text.trim();
    if (text.isEmpty) return;
    _appendAssistantText("assistant-evening-digest", text);
  }

  /// 往对话流追加一张决策卡（contentType="decision_card"，内存态不持久化，
  /// 同 task_receipt）。追加即展示：chat_page 的消息列表监听自动滚底。
  void _appendDecisionCard(Map<String, dynamic> card) {
    final String title = card["title"]?.toString() ?? "";
    final String body = card["message"]?.toString() ?? "";
    final ChatMessage message = ChatMessage(
      messageId: "decision-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: body.isNotEmpty ? body : title,
      timestamp: DateTime.now(),
      contentType: "decision_card",
      decisionCard: card,
    );
    void apply() {
      _messages.add(message);
      _assistantMessageIndexById[message.messageId] = _messages.length - 1;
    }

    if (mounted) {
      setState(apply);
    } else {
      apply();
    }
  }

  /// 决策卡按钮回调：回传 ack/outcome + 原地翻转卡片为终态。
  /// attention：确认/忽略都 ack（via=chat_card，升级链收敛）；
  /// proactive：确认 accepted / 忽略 dismissed。
  void _handleDecisionCardAction(String messageId, bool confirmed) {
    final int? idx = _messageIndexById(messageId);
    if (idx == null || idx >= _messages.length) return;
    final ChatMessage msg = _messages[idx];
    final Map<String, dynamic>? card = msg.decisionCard;
    if (card == null || card["state"]?.toString() == "confirmed") return;

    final String kind = card["kind"]?.toString() ?? "";
    final String attentionId = card["attentionId"]?.toString() ?? "";
    final String deliveryId = card["deliveryId"]?.toString() ?? "";
    if (kind == "attention" && attentionId.isNotEmpty) {
      unawaited(() async {
        try {
          await AttentionApi().ack(attentionId, via: "chat_card");
        } catch (e) {
          // ack 失败不影响本地卡片（升级链会随截止时间自然收敛）
          debugPrint("[decision-card] attention ack failed: $e");
        }
      }());
    } else if (kind == "proactive" && deliveryId.isNotEmpty) {
      AmbientFeedsController.instance.sendProactiveOutcome(
          deliveryId, confirmed ? "accepted" : "dismissed");
    }

    final Map<String, dynamic> updated =
        Map<String, dynamic>.of(card)..["state"] = "confirmed";
    void apply() {
      _messages[idx] = msg.copyWith(decisionCard: updated);
    }

    if (mounted) {
      setState(apply);
    } else {
      apply();
    }
  }

  // ====== 桌面端独立来电悬浮窗回调 ======

  /// 原生悬浮窗点接听：
  /// - agent_to_agent：发 voice.incoming_response("accept") 通知服务器
  /// - agent_to_user：服务器自动推进 ringing→connecting，客户端只需切换 UI
  void _handleNativeCallAccept() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "accept");
    }
    if (!mounted) return;
    setState(() {
      _phoneCallStatus = "connecting";
      _peerIncomingDialogCallId = null;
    });
    unawaited(IncomingCallLauncher.bringMainWindowToFront());
    unawaited(ConnectedCallLauncher.resetDuration());
  }

  /// 原生悬浮窗点挂断：
  /// - agent_to_agent：发 voice.incoming_response("decline")
  /// - agent_to_user：本地停止 TTS + 关窗 + contact feedback
  void _handleNativeCallDecline() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "decline");
    } else {
      // 拒接 agent 来电：同超时路径，须通知服务端收尾会话（防忙线残留）
      if (_activeCallId?.isNotEmpty ?? false) {
        _ws.sendEvent("phone.call_hangup", <String, dynamic>{
          "callId": _activeCallId,
        });
      }
      AmbientFeedsController.instance.sendContactFeedback(
        channel: "phone_call",
        responded: false,
        feedback: "negative",
        quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
      );
    }
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _activeCallId = null;
        _peerIncomingDialogCallId = null;
      });
    }
  }

  /// 原生悬浮窗振铃超时：
  /// - agent_to_agent：发 voice.incoming_response("decline")（服务器也有自己的超时兜底）
  /// - agent_to_user：contact feedback negative
  void _handleNativeCallTimeout() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "decline");
    } else {
      // 振铃超时无人接：与服务端会话对齐（agent_to_user 会话靠本事件收尾，
      // 漏发会让残留会话把用户后续呼叫挡成忙线），peer 通话走上面的回执
      if (_activeCallId?.isNotEmpty ?? false) {
        _ws.sendEvent("phone.call_hangup", <String, dynamic>{
          "callId": _activeCallId,
        });
      }
      AmbientFeedsController.instance.sendContactFeedback(
        channel: "phone_call",
        responded: false,
        feedback: "negative",
        quietHours: AmbientFeedsController.instance.isQuietHoursNow(),
      );
    }
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _activeCallId = null;
        _peerIncomingDialogCallId = null;
      });
    }
  }

  /// 用户在聊天页底部"📞 通话中"按钮上点挂断的入口
  // ignore: unused_element
  void _hangupFromPhoneButton() {
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _peerIncomingDialogCallId = null;
        _phoneMuted = false;
        _phoneSpeakerOn = true;
      });
    }
  }

  /// "通话中"窗口里点了挂断：关窗 + 停 TTS + 清状态
  void _handleConnectedHangup() {
    // 服务端会话清理依赖此事件：漏发会把 user_to_agent 会话残留成忙线，
    // 挡死用户后续一切呼叫（2026-10-04 实证）。_activeCallId 在下方清空前发送。
    if (_activeCallId?.isNotEmpty ?? false) {
      _ws.sendEvent("phone.call_hangup", <String, dynamic>{
        "callId": _activeCallId,
      });
    }
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _activeCallId = null;
        _peerIncomingDialogCallId = null;
        _phoneMuted = false;
        _phoneSpeakerOn = true;
      });
    }
    PhoneCallSession.instance.end();
  }

  /// 手机端全屏通话页点挂断：WS 事件已由 PhoneCallSession.hangup() 先行发出
  /// （phone.call_hangup，服务端清理会话并回推 ended），这里做本地收尾。
  void _handlePhonePageHangup() {
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _activeCallId = null;
        _peerIncomingDialogCallId = null;
        _phoneMuted = false;
        _phoneSpeakerOn = true;
      });
    }
    PhoneCallSession.instance.end();
  }

  /// TTS 播完回调：关头像呼吸光
  void _onTtsCompleted() {
    unawaited(ConnectedCallLauncher.setTalking(false));
    // 手机端通话页同步结束"正在播报"呼吸动画
    PhoneCallSession.instance.setTalking(false);
  }

  /// "通话中"窗口里点了静音：本地状态同步 + 通知 server
  void _handleMuteToggle(bool newMuted) {
    if (!mounted) return;
    setState(() => _phoneMuted = newMuted);
    _ws.sendEvent("phone.mute", {"muted": newMuted});
  }

  /// "通话中"窗口里点了免提：本地状态同步 + 通知 server
  void _handleSpeakerToggle(bool newOn) {
    if (!mounted) return;
    setState(() => _phoneSpeakerOn = newOn);
    _ws.sendEvent("phone.speaker", {"on": newOn});
  }

  void _handleOutgoingCallHangup() {
    // 修复：此前发的是 phone.hang_up（服务端无此事件，挂断从未生效）；
    // 正确事件为 phone.call_hangup，并携带当前通话 callId
    _ws.sendEvent("phone.call_hangup", <String, dynamic>{
      if (_activeCallId?.isNotEmpty ?? false) "callId": _activeCallId,
    });
    unawaited(OutgoingCallLauncher.hide());
    if (!mounted) return;
    setState(() {
      _phoneCallStatus = null;
      _phoneCallToActorId = null;
      _activeCallId = null;
    });
  }

  void _presentPeerAgentIncoming(Map<String, dynamic> payload) {
    final String callId = payload["callId"]?.toString() ?? "";
    if (callId.isEmpty) return;
    if (_peerIncomingDialogCallId == callId) return;

    final String fromPhone = payload["fromPhone"]?.toString() ?? "";
    final String callerLabel = VoiceCallUiLabels.incomingCallerLabel(
      direction: "agent_to_agent",
      fromPhone: fromPhone,
    );
    if (!mounted) return;
    setState(() {
      _peerIncomingDialogCallId = callId;
      _phoneCallStatus = "ringing";
      _phoneCallToActorId = callerLabel;
    });

    // 统一走原生独立悬浮窗（不再使用嵌入式 Flutter dialog）
    unawaited(
      IncomingCallLauncher.show(
        callerName: callerLabel,
        subtitle: "其他 Agent 来电",
        callerInitial:
            callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
        ringTimeoutMs: 30000,
      ),
    );
  }

  void _callMyAgentViaPhone(String? message) {
    // 不再用 isConnected 做前置拦截：WsChatService.sendEvent 已内置离线排队
    // （断线时入 _pendingOutbound，自动触发重连，连上后 flush 补发）。此前在这里
    // 直接 return，等于把排队机制旁路掉——重连窗口内点击呼叫请求被静默丢弃，
    // 用户看到的就是「点了没反应」，而服务端通话记录里连一条记录都没有。
    if (!_ws.isConnected && _ws.hasPendingEvent("phone.call_my_agent")) {
      // 已在等待补发的队列里：别再排队了，重连后连拨好几通，除第一通外全撞忙线
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("呼叫已在排队，连接恢复后自动拨出")),
        );
      }
      return;
    }

    final Map<String, dynamic> callPayload = <String, dynamic>{};
    if (message != null && message.isNotEmpty) {
      callPayload["userMessage"] = message;
    }
    final bool sent = _ws.sendEvent("phone.call_my_agent", callPayload);
    if (!sent && mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("正在重连服务器，恢复后自动呼叫")),
      );
    }
    unawaited(
      OutgoingCallLauncher.show(
        callerName: _phoneCallToActorId ?? "Agent",
        subtitle: sent
            ? (message?.trim().isNotEmpty == true ? message!.trim() : "正在接通")
            : "等待重连…",
        callerInitial: (_phoneCallToActorId?.isNotEmpty ?? false)
            ? _phoneCallToActorId!.characters.first
            : "A",
      ),
    );
    return;
  }

  /// 启动版本检查（Windows 桌面安装形态）：拉服务端 client manifest 与本地版本
  /// 比对。强制锁/软提醒均只在明确拿到清单时触发，接口失败静默放行（fail-open，
  /// 服务器不可达不能把用户锁在门外）。顺带把 channel 持久化到本地偏好，为后期
  /// 收回 runtime（byok → platform 统一 API 服务）留好状态位。
  Future<void> _checkClientUpdateAtStartup() async {
    if (kIsWeb || !Platform.isWindows) return;
    final ClientUpdateCheckResult? result = await checkClientUpdate();
    if (result == null || !mounted) return;
    unawaited(
      _store.savePreference("client.channel", result.manifest.channel),
    );
    if (result.status == ClientUpdateStatus.upToDate) return;
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) return;
    await showClientUpdateDialog(
      context: ctx,
      manifest: result.manifest,
      localVersion: result.localVersion,
      forced: result.status == ClientUpdateStatus.forcedUpdate,
    );
  }

  /// 侧栏「检查更新」按钮：见 UpdateResultCard.runManualUpdateCheck
  /// 的结果分流说明（已是最新→右上角玻璃卡；其余→按钮上方浮卡；强锁→居中弹窗）。
  Future<void> _checkForUpdateManually() async {
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) return;
    await UpdateResultCard.runManualUpdateCheck(ctx);
  }

  /// 弹窗询问 GPS 定位权限：仅询问一次，未显式拒绝则默认同意并立即拉一次 GPS。
  Future<void> _promptLocationConsentIfNeeded() async {
    final bool? existing = await ClientLocationService.getLocationConsent();
    if (existing != null) {
      if (existing) {
        unawaited(ClientLocationService.warmUpGpsIfConsented());
      }
      return;
    }

    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) {
      return;
    }

    final bool? allow = await showLocationPermissionDialog(context: ctx);
    // 默认同意：用户没显式点「暂不允许」就视为允许，让 Agent 默认能拿到实时位置。
    final bool decided = allow ?? true;
    await ClientLocationService.setLocationConsent(decided);
    if (decided) {
      await ClientLocationService.requestGpsAfterConsent();
    }
  }

  /// 启动时静默拉一次定位并上报（无 jobId 纯上报，填充服务端位置缓存供 Agent
  /// 按需复用）。原由右侧面板天气 Header 触发，组件移除后改由应用启动兜底；
  /// WS 未连接时 [WsChatService.sendEvent] 自动排队，连接后补发。
  Future<void> _reportStartupLocation() async {
    try {
      final ClientLocationPayload? loc =
          await ClientLocationService.getCurrentLocation();
      if (loc == null) return;
      _ws.sendEvent("client.location_report", loc.toJson());
    } catch (_) {
      // 定位失败静默：Agent 运行中需要位置时会走 agent.location_request 按需再拉
    }
  }

  /// 持续定位定时器（agent.location_tracking_config 驱动）。
  Timer? _continuousLocationTimer;

  /// 服务端持续定位配置：continuous 时启动定时上报，其余情况确保停止。
  void _configureContinuousLocationTracking(Map<String, dynamic> payload) {
    final String mode = payload["mode"]?.toString() ?? "";
    if (mode != "continuous") {
      _stopContinuousLocationTracking();
      return;
    }
    int intervalSec = (payload["intervalSec"] as num?)?.toInt() ?? 300;
    if (intervalSec < 30) intervalSec = 30;
    if (intervalSec > 3600) intervalSec = 3600;
    _startContinuousLocationTracking(intervalSec);
  }

  void _startContinuousLocationTracking(int intervalSec) {
    _continuousLocationTimer?.cancel();
    _continuousLocationTimer = Timer.periodic(
      Duration(seconds: intervalSec),
      (Timer t) => unawaited(_reportContinuousLocation()),
    );
  }

  void _stopContinuousLocationTracking() {
    _continuousLocationTimer?.cancel();
    _continuousLocationTimer = null;
  }

  /// 持续模式单次上报：拉新 GPS（绕过展示缓存），静默失败，下个周期自然重试。
  Future<void> _reportContinuousLocation() async {
    try {
      final bool? consent = await ClientLocationService.getLocationConsent();
      if (consent != true) {
        // 用户撤回定位同意：立刻停表，直到重新授权前不再产生任何位置上报
        _stopContinuousLocationTracking();
        return;
      }
      final ClientLocationPayload? loc =
          await ClientLocationService.getCurrentLocationForChat();
      if (loc == null) return;
      _ws.sendEvent("client.location_report", <String, dynamic>{
        "source": "continuous",
        ...loc.toJson(),
      });
    } catch (_) {
      // 单次失败静默
    }
  }

  void _showToast(String message) {
    if (!mounted) return;
    final ScaffoldMessengerState? messenger =
        ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          duration: const Duration(seconds: 3),
        ),
      );
  }

  Widget? _buildAppBarTitle() {
    if (_tabIndex == 0) {
      return null;
    }
    final String title = kTabTitles[_tabIndex];
    if (title.isEmpty) {
      return null;
    }
    return Text(title);
  }

  /// 今日安排悬浮卡自动淡出计时器（surface.show 召唤时启动）
  Timer? _surfaceAutoHideTimer;

  /// 灵动岛日程倒计时刷新（「25 分钟后」随时间推进）。
  Timer? _islandScheduleTicker;

  /// 处理服务端 surface.show：按 surface 名召唤对应悬浮卡（Surface-on-Demand）。
  /// today_schedule 现召唤「桌面顶部灵动岛」：显示下一事项倒计时条目 +
  /// 自动展开日程卡，ttl 秒后收回。未知 surface 静默忽略。
  /// 数据由客户端自取（_loadTodayScheduleFuture），服务端只下发指令不搬日程数据。
  Future<void> _handleSurfaceShow(Map<String, dynamic> payload) async {
    if (kIsWeb || !Platform.isWindows) return;
    final String surface = payload["surface"]?.toString().trim() ?? "";
    if (surface != "today_schedule") return;
    final int ttlSeconds =
        int.tryParse(payload["ttlSeconds"]?.toString() ?? "") ?? 30;
    try {
      final List<ScheduleEvent> events = await _loadTodayScheduleFuture();
      final DateTime now = DateTime.now();
      final List<ScheduleEvent> sorted = List<ScheduleEvent>.from(events)
        ..sort((a, b) => a.startAt.compareTo(b.startAt));
      final List<Map<String, Object?>> agenda = <Map<String, Object?>>[];
      ScheduleEvent? next;
      for (final ScheduleEvent e in sorted) {
        final bool done = !e.startAt.isAfter(now);
        if (next == null && !done) next = e;
        agenda.add(<String, Object?>{
          "time":
              "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}",
          "title": e.shortTitle ?? simplifyScheduleTitle(e.title),
          "hint": done ? "已完成" : "",
          "completed": done,
        });
      }
      final DynamicIslandLauncher launcher = DynamicIslandLauncher.instance;
      await launcher.setAgenda(agenda);
      final DynamicIslandController controller = DynamicIslandController.instance;
      final ScheduleEvent? focus = next;
      if (focus != null) {
        final int minutesAhead =
            focus.startAt.difference(now).inMinutes.clamp(0, 24 * 60);
        final String trailing = minutesAhead >= 60
            ? "${minutesAhead ~/ 60} 小时后"
            : (minutesAhead > 0 ? "$minutesAhead 分钟后" : "即将开始");
        controller.present(IslandEntry(
          id: "schedule.next",
          title: focus.shortTitle ?? simplifyScheduleTitle(focus.title),
          kind: IslandKind.schedule,
          trailing: trailing,
          priority: 2,
        ));
      }
      if (!controller.expanded) controller.toggleExpanded();
      _surfaceAutoHideTimer?.cancel();
      _surfaceAutoHideTimer = Timer(Duration(seconds: ttlSeconds), () {
        DynamicIslandController.instance.collapse();
      });
    } catch (e, st) {
      debugPrint("[surface.show] $surface failed: $e | $st");
    }
  }

  @override
  Widget build(BuildContext context) {
    final Widget app = _buildApp();
    // N 动画只在武装后覆盖：播完且 init 完成才收层；未武装（未登录）整段不出现，
    // 注册页从第一帧起直接可见。
    final bool hideBoot =
        !_playBootAnimation || (_bootAnimDone && _isInitialized);
    // 根部 Stack（boot 动画覆盖层）位于 MaterialApp 之上，须自带 Directionality，
    // 否则启动即抛 "No Directionality widget found"（alignment 依赖文本方向）。
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        children: <Widget>[
          Positioned.fill(child: app),
          if (!hideBoot)
            Positioned.fill(
              child: IgnorePointer(
                child: BootAnimation(
                  onAnimationComplete: () {
                    if (mounted) setState(() => _bootAnimDone = true);
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 手机端登录门禁：黑白极简落地页 + 弹出小卡片两步邮箱验证
  /// （新邮箱即注册、已注册即登录，与 /accounts/web 同协议）。
  /// 登录成功复用 [_completeWebAuth]：落盘会话 → 运行时身份覆盖 →
  /// 按需进首启向导 → 主界面。门禁用独立 navigatorKey（理由同注册门禁）。
  Widget _buildMobileLoginGate() {
    return MaterialApp(
      navigatorKey: _gateNavigatorKey,
      title: "",
      theme: AppTheme.of(AppThemeVariant.dark).copyWith(
        scaffoldBackgroundColor: Colors.black,
      ),
      home: MobileLoginPage(
        onLoggedIn: (String email) => unawaited(_completeWebAuth(email)),
      ),
    );
  }

  /// 手机端主壳：对话/日程/我的（与独立调试入口 main_mobile.dart 同构，
  /// 用 MobileTheme，主题档与桌面端 AppThemeVariant 互不串扰）。
  /// 登录后直接切入，不等桌面端的向导与 N 光扫；退出登录复用
  /// [_performLogout]（清会话 + 清身份覆盖 → 回手机登录门禁）。
  Widget _buildMobileMainGate() {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: _mobileThemeMode,
      builder: (BuildContext context, ThemeMode mode, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          navigatorKey: _mobileMainNavigatorKey,
          title: "NEXTBOT",
          theme: MobileTheme.light,
          darkTheme: MobileTheme.dark,
          themeMode: mode,
          home: MobileHomePage(
            themeMode: mode,
            onThemeModeChanged: (ThemeMode m) => _mobileThemeMode.value = m,
            onLogout: _performLogout,
          ),
        );
      },
    );
  }

  /// 注册门禁页：与独立预览窗口同款深色整页（页面自带自绘标题栏与
  /// 窗口按钮，深色独占不随应用主题切换）。
  Widget _buildRegisterGate() {
    return MaterialApp(
      // 门禁用独立 navigatorKey：与加载页/主应用互斥切换时，共享 GlobalKey
      // 会触发 Navigator 收养重挂，旧页面子树被搬进新 MaterialApp，
      // home: RegisterPage 永不生效（表现为永远停在旧分支页面）。
      navigatorKey: _gateNavigatorKey,
      title: "",
      theme: AppTheme.of(AppThemeVariant.dark).copyWith(
        scaffoldBackgroundColor: Colors.black,
      ),
      home: RegisterPage(onAuthenticated: _completeWebAuth),
    );
  }

  /// 首启向导门禁：独立 MaterialApp（同注册门禁的隔离理由）。
  Widget _buildOnboardingGate() {
    return MaterialApp(
      navigatorKey: _onboardingNavigatorKey,
      title: "",
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(AppThemeVariant.dark).copyWith(
        scaffoldBackgroundColor: Colors.black,
      ),
      home: OnboardingFlow(
        onComplete: _completeOnboarding,
      ),
    );
  }

  Widget _buildLoadingApp() {
    return ValueListenableBuilder<AppThemeVariant>(
      valueListenable: AppThemeController.instance,
      builder: (BuildContext _, AppThemeVariant variant, __) {
        final bool isLightTheme = variant == AppThemeVariant.warm;
        final Color loadingColor =
            isLightTheme ? AppPalette.warmOnSurface : Colors.white;
        return MaterialApp(
          title: "",
          theme: AppTheme.of(variant),
          home: Scaffold(
            backgroundColor: AppPalette.resolveMainPanel(variant),
            // 初始化页也铺自绘标题栏，保证窗口可拖拽/可关闭。
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const AppWindowTitleBar(),
                Expanded(
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        CircularProgressIndicator(
                          color: loadingColor,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          '正在初始化...',
                          style: TextStyle(
                            color: loadingColor.withValues(alpha: 0.7),
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// 账号门禁：读盘结果未出前沿用加载页；未注册/已退出登录时整页注册页
  /// 顶在最前——重量级初始化照常在后台跑，注册成功落盘即切入主界面。
  Widget _buildApp() {
    if (!_sessionLoaded) {
      return _buildLoadingApp();
    }
    // 手机端全链走手机 UI：登录门禁 → 手机主壳（对话/日程/我的）。
    // 桌面端的注册门禁/首启向导/N 光扫/主界面均不参与；根组件的重量级
    // 初始化照常后台跑——主动通知、简报、通话等根能力与主壳解耦。
    //
    // ⚠️ 铁律（用户 2026-10-13 明令）：这个分支只在真手机平台生效。
    // 桌面 exe 必须永远落到下方桌面链路（注册门禁 → 首启向导 → 桌面主壳
    // AppSidebar），任何调试/排查都不许让桌面 exe 路由进手机壳
    // （MobileLoginPage / MobileHomePage）。调手机 UI 走 main_mobile.dart。
    if (_isMobile) {
      if (_accountEmail == null) {
        return _buildMobileLoginGate();
      }
      return _buildMobileMainGate();
    }
    if (_accountEmail == null) {
      return _buildRegisterGate();
    }
    // 首启向导：仅本次真正新建账号（网页回连 fresh=1）才进入——进度条动画
    // +称呼/名字同屏+模型两步顶在主界面之前；已注册邮箱换机登录直达主界面。
    // 重量级初始化照常后台跑，向导动画本身就是 init 等待屏（完成即 _isInitialized，无闪屏）。
    if (_needsOnboarding && !_onboardingDone) {
      return _buildOnboardingGate();
    }
    // 如果还未初始化，显示加载界面
    if (!_isInitialized) {
      return _buildLoadingApp();
    }

    // 监听主题控制器，切换配色时重建整个 MaterialApp。
    return ValueListenableBuilder<AppThemeVariant>(
      valueListenable: AppThemeController.instance,
      builder: (BuildContext _, AppThemeVariant variant, __) {
        // 同步 Windows 标题栏颜色跟随主题（N 动画覆盖期间恒为深色）
        unawaited(WindowsTitleBarTheme.setDarkMode(
          (_playBootAnimation && !_bootAnimDone) ||
              variant == AppThemeVariant.dark,
        ));
        return MaterialApp(
          navigatorKey: _rootNavigatorKey,
          title: "",
          theme: AppTheme.of(variant),
          // 玻璃态通知卡挂在 navigator 之上：任意路由上方均可弹出，
          // 关闭后及时移除 BackdropFilter 层避免常驻模糊开销。
          // 「检查更新」结果浮卡同层锚定在侧栏更新按钮正上方。
          // （灵动岛已移至桌面顶部原生窗口，不再挂在 builder 层。）
          builder: (BuildContext context, Widget? child) =>
              GlassNotifyHost(child: UpdateResultCardHost(child: child)),
          home: Builder(
            builder: (BuildContext context) {
              return Scaffold(
                body: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    // 自绘标题栏：与左侧边栏同色，最右侧窗口按钮。
                    const AppWindowTitleBar(),
                    Expanded(
                      child: Stack(
                        clipBehavior: Clip.none,
                        children: <Widget>[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        AppSidebar(
                          tabIndex: _tabIndex,
                          onTabSelected: _selectTab,
                          currentTheme: _themeChoice,
                          onSetLightTheme: _setLightTheme,
                          onSetDarkTheme: _setDarkTheme,
                          onSetSystemTheme: _setSystemTheme,
                          inboxUnread: _inboxUnread,
                          onInboxUnreadChanged: (int unread) {
                            if (mounted) {
                              setState(() => _inboxUnread = unread);
                            }
                          },
                          onOpenSettings: _openSettings,
                          onCheckUpdate: _checkForUpdateManually,
                          onOpenUserMenuFeedback: _openUserMenuFeedback,
                          onOpenDevices: _openDevicesPage,
                          userName: _accountEmail?.split("@").first ?? "king",
                          userAvatarUrl: UserAvatarApi.resolveUrl(_userAvatarPath),
                          onSetAvatar: _setUserAvatar,
                          onLogout: _logout,
                        ),
                        VerticalDivider(
                          width: 1,
                          thickness: 1,
                          color: AppPalette.resolveSidebarSeparator(variant),
                        ),
                        Expanded(
                          child: RepaintBoundary(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: <Widget>[
                                // 当右侧面板显示时（side 或 split 模式），
                                // 给 AppBar 右侧加相应边距，把被右面板覆盖的部分
                                // 从 AppBar 中裁掉。split 模式使用 [NextbotChatLayout]
                                // 同步过来的实际动态宽度。
                                Padding(
                                  padding: EdgeInsets.only(
                                    right: _appBarRightInset(),
                                  ),
                                  child: AppBar(
                                    automaticallyImplyLeading: false,
                                  // 与自绘标题栏(40px)和右侧面板顶栏(40px)对齐
                                  toolbarHeight: kWindowTitleBarHeight,
                                  // 顶栏与左侧边栏同色(深色主题下为 #131313 的深灰),
                                  // 与聊天主背景的纯黑 (#0F0F0F) 形成可识别但克制的对比
                                  backgroundColor:
                                      AppPalette.resolveSidebar(variant),
                                  foregroundColor:
                                      AppPalette.resolveAppBarForeground(
                                          variant),
                                  surfaceTintColor: Colors.transparent,
                                  elevation: 0,
                                  scrolledUnderElevation: 0,
                                  title: _buildAppBarTitle(),
                                  ),
                                ),
                                Expanded(
                                  child: MainPanel(
                                    child: _buildMainContent(),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                    const FloatingAgentSphere(),
                    // 右侧面板：顶到自绘标题栏下沿（Stack 顶端），
                    // 在面板宽度范围内覆盖 AppBar / 主内容。
                    // side 模式 288px，split 模式动态宽度。
                    // 仅在 chat tab + 宽屏时显示。
                    _buildRightPanelOverlay(),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        );
      },
    );
  }

  /// 「主题」→「亮色」
  void _setLightTheme() {
    setState(() => _themeChoice = ThemeChoice.light);
    AppThemeController.instance.setVariant(AppThemeVariant.warm);
  }

  /// 「主题」→「暗色」
  void _setDarkTheme() {
    setState(() => _themeChoice = ThemeChoice.dark);
    AppThemeController.instance.setVariant(AppThemeVariant.dark);
  }

  /// 「主题」→「跟随系统」
  /// 读取当前平台亮度,立即套用;平台亮度后续变化不会自动重算
  /// (用户需要重新点一次才会重新同步)。
  void _setSystemTheme() {
    final Brightness platformBrightness = MediaQuery.platformBrightnessOf(
      context,
    );
    setState(() => _themeChoice = ThemeChoice.system);
    AppThemeController.instance.setVariant(
      platformBrightness == Brightness.dark
          ? AppThemeVariant.dark
          : AppThemeVariant.warm,
    );
  }

  /// 侧栏底部「设置」按钮:全屏打开设置页（左侧分区侧栏 + 右侧内容区）
  void _openSettings() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    Navigator.of(navCtx).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext ctx) => const SettingsPage(),
      ),
    );
  }

  /// 用户菜单「反馈」:弹出反馈弹窗(吐槽/报障/建议 + 我的反馈记录)
  ///
  /// 本 State 的 context 在 MaterialApp(即 Navigator)之上,直接传给 showDialog
  /// 会抛 "does not include a Navigator" 且 release 下静默——表现为点了反馈
  /// 什么都不弹。必须经 [_rootNavigatorKey] 取 Navigator 内部的 context。
  void _openUserMenuFeedback() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    FeedbackDialog.show(navCtx);
  }

  /// 读本机账号会话：已注册（冷启动）武装 N 开场动画后进主界面；
  /// 未注册直接亮注册页，不播开场动画。
  /// 冷启动一律直达主界面——首启向导只在「本次回连真正新建账号」那一刻
  /// 由 [_completeWebAuth] 触发，已注册邮箱换机重登不再重跑向导（2026-10-16）。
  /// 登录邮箱同步写进 [ApiConfig.runtimeUserId]——WS/HTTP/本地存储的
  /// 身份全链以邮箱为准，不同账号数据互不串台。
  Future<void> _loadAccountSession() async {
    await AccountSessionStore.instance.load();
    ApiConfig.runtimeUserId = AccountSessionStore.instance.email;
    if (!mounted) return;
    setState(() {
      _accountEmail = AccountSessionStore.instance.email;
      _sessionLoaded = true;
      _playBootAnimation = _accountEmail != null;
    });
    if (_accountEmail != null) {
      unawaited(_loadUserAvatar());
    }
  }

  /// 拉取当前账号头像（非关键链路：失败静默，各展示位回退缺省球）。
  Future<void> _loadUserAvatar() async {
    final String? path = await UserAvatarApi().fetchAvatarPath();
    if (!mounted || path == _userAvatarPath) return;
    setState(() => _userAvatarPath = path);
  }

  /// 用户菜单「设置头像」：选图 → 上传 → 三处展示位即时刷新。
  Future<void> _setUserAvatar() async {
    final FilePickerResult? picked = await FilePicker.platform.pickFiles(
      type: FileType.image,
      withData: true,
    );
    final PlatformFile? file = picked?.files.single;
    if (file == null) return;
    if (file.bytes == null || file.bytes!.isEmpty) {
      _showUserMenuToast("读取图片失败，请换一张试试");
      return;
    }
    final String? path =
        await UserAvatarApi().uploadAvatar(file.bytes!, file.name);
    if (!mounted) return;
    if (path == null) {
      _showUserMenuToast("头像上传失败，请稍后再试");
      return;
    }
    setState(() => _userAvatarPath = path);
    _showUserMenuToast("头像已更新");
  }

  /// 用户菜单动作的全局提示（State 的 context 在 Navigator 之上，
  /// 与 [_openUserMenuFeedback] 同理走 [_rootNavigatorKey]）。
  void _showUserMenuToast(String message) {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    ScaffoldMessenger.maybeOf(navCtx)?.showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  /// 网页登录回连：落盘会话 → 切入主界面。
  /// 注册/登录本身已在 /accounts/web 网页端对控制面完成（幂等），
  /// 这里只负责本机登录态；落盘成功前门禁不放行，抛错由注册页捕获展示。
  /// 登录身份先写进 [ApiConfig.runtimeUserId] 再切界面，保证切入主界面
  /// 后所有请求立刻带上本账号身份。另外向控制面补一次账号自注册（幂等）：
  /// 防网页注册落在别处/失败时后台用户列表缺行。首次切入主界面武装一次
  /// N 开场动画（重登录时重置播完标记）。
  ///
  /// 首启向导仅在 [freshCreated]（本次回连真正新建了账号）时触发：
  /// 已注册邮箱在任意机器登录都直达主界面（2026-10-16），称呼/名字等
  /// 账号级配置随账号走，模型接入可事后在设置页补配。
  Future<void> _completeWebAuth(String email, {bool freshCreated = false}) async {
    final String mail = email.trim();
    await AccountSessionStore.instance.save(mail);
    ApiConfig.runtimeUserId = AccountSessionStore.instance.email;
    unawaited(ControlPlaneAccount.ensureRegistered());
    if (!mounted) return;
    setState(() {
      _accountEmail = mail;
      _needsOnboarding = freshCreated;
      // 新建账号走向导自己的进度条开机动画；已注册登录照常 N 光扫
      _playBootAnimation = !freshCreated;
      _bootAnimDone = false;
    });
    unawaited(_loadUserAvatar());
  }

  /// 向导完成：切入主界面（N 光扫不再补播，向导的进度条动画就是本次开场）。
  Future<void> _completeOnboarding() async {
    if (!mounted) return;
    setState(() {
      _onboardingDone = true;
      _needsOnboarding = false;
      _playBootAnimation = false;
      _bootAnimDone = true;
    });
  }

  /// 用户菜单「我的设备」:与对话框构成双面板分栏
  void _openDevicesPage() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.devices;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.devices.defaultSplitRatio;
    });
  }

  /// 用户菜单「退出登录」:先弹确认,确认后清本地会话回到注册页
  ///
  /// 同 [_openUserMenuFeedback]:确认框必须用 Navigator 内部的 context。
  /// 控制面账号行保留（同邮箱重新注册幂等），本机登录态即刻失效。
  Future<void> _logout() async {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    final bool? confirmed = await showDialog<bool>(
      context: navCtx,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("退出登录"),
          content: const Text("确定要退出当前账号吗?"),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text("退出"),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    await _performLogout();
  }

  /// 退出登录本体：清本地会话回到注册页（确认框之后/调试直调共用）。
  /// 登录身份覆盖同步撤销：后续请求回落默认身份，不残留上一账号。
  /// 控制面账号行保留（同邮箱重新注册幂等），本机登录态即刻失效。
  Future<void> _performLogout() async {
    await AccountSessionStore.instance.clear();
    ApiConfig.runtimeUserId = null;
    if (!mounted) return;
    setState(() {
      _accountEmail = null;
      _userAvatarPath = null;
    });
  }

  Future<void> _handleMorningBriefingEvent(
    Map<String, dynamic> payload, {
    bool markDesktopShown = false,
    bool forceDialog = false,
  }) async {
    final String mode =
        payload["mode"]?.toString() ?? UserPreferencesApi.modeCard;
    final String narrationText = payload["narrationText"]?.toString() ?? "";
    final Object? rawBriefing = payload["briefing"];
    final Map<String, dynamic> briefing =
        rawBriefing is Map ? rawBriefing.cast<String, dynamic>() : payload;
    final String modeLabel = switch (mode) {
      UserPreferencesApi.modeVoice => "语音",
      UserPreferencesApi.modeWindow => "独立窗口",
      _ => "卡片",
    };

    // 简报不落聊天流（2026-10-02 用户定稿）：对话里不再出现简报消息，
    // 早上由桌面悬浮窗卡片直接展示；历史残留见加载自愈清理。
    if (markDesktopShown) {
      _lastDesktopBriefingAt = DateTime.now();
    }

    // Windows 桌面：简报统一走「独立 WebView 悬浮窗 + 语音播报」（私人管家
    // 形态，一比一还原 design/daily-briefing-floating.html）。窗口打开成功
    // 即视为 desktop 渠道已投放；失败退回下方通知 / 对话框既有路径。
    if (!kIsWeb &&
        defaultTargetPlatform == TargetPlatform.windows &&
        !forceDialog) {
      // 每天仅一次：今日桌面渠道已展示过则不再弹（重启应用也不重复）
      if (await _isBriefingDeliveredOnDesktopToday()) return;
      final bool opened = await DailyBriefingWindowLauncher.open(
        narrationText: narrationText,
        briefing: briefing,
        appellation: briefing["appellation"]?.toString(),
      );
      if (opened) {
        await _markBriefingDelivered("desktop");
        return;
      }
    }
    if (!mounted) return;

    if (mode == UserPreferencesApi.modeVoice && narrationText.isNotEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("已开始播报今日简报")),
      );
      if (!forceDialog) {
        return;
      }
    }

    // 右下角原生弹窗兜底已随 2026-10-14 删除；悬浮窗打开失败时落到
    // 下方 Android 通知 / 对话框既有路径。

    if (!kIsWeb &&
        defaultTargetPlatform == TargetPlatform.android &&
        !forceDialog) {
      final bool alreadyDelivered =
          await _isBriefingDeliveredElsewhere(preferredChannel: "mobile");
      if (alreadyDelivered) return;
      final String payloadText = jsonEncode(<String, dynamic>{
        "mode": mode,
        "narrationText": narrationText,
        "briefing": briefing,
      });
      await MobileBriefingLauncher.showBriefingNotification(
        title: "每日简报",
        message: buildMobileBriefingSummary(briefing),
        payload: payloadText,
      );
      await _markBriefingDelivered("mobile");
      return;
    }

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        return Dialog(
          insetPadding:
              const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    MorningBriefingCard(
                      briefing: briefing,
                      narrationText: narrationText,
                      modeLabel: modeLabel,
                      onSpeak: (String text) {
                        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                          SnackBar(content: Text(text)),
                        );
                      },
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: <Widget>[
                          TextButton(
                            onPressed: () => Navigator.of(dialogContext).pop(),
                            child: const Text("知道了"),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
    if (defaultTargetPlatform == TargetPlatform.windows) {
      await _markBriefingDelivered("desktop");
    } else if (defaultTargetPlatform == TargetPlatform.android) {
      await _markBriefingDelivered("mobile");
    }
  }

  Future<void> _tryShowDesktopLaunchBriefing() async {
    try {
      // 每日简报只在早上固定时段（05:00–12:00）主动播报，其余时间启动不弹
      final DateTime gateNow = DateTime.now();
      if (gateNow.hour < 5 || gateNow.hour >= 12) return;
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      if (mb["enabled"] == false || mb["showOnDesktopLaunch"] == false) {
        return;
      }
      final DateTime now = DateTime.now();
      if (_lastDesktopBriefingAt != null &&
          now.difference(_lastDesktopBriefingAt!).inMinutes < 10) {
        return;
      }
      if (await _isBriefingDeliveredElsewhere(preferredChannel: "desktop")) {
        return;
      }
      // 开机在座门禁：开启摄像头检测时，等用户坐到电脑前再播（简报不播给空房间）。
      // 无摄像头/未授权/服务不可用 → 直接放行（等价「没有摄像头开机即播」）；
      // 等满 10 分钟仍无人 → 兜底放行（不漏报），但播报前重查时段与投递状态。
      final bool? camConsent = await _store.getVisionCameraConsent();
      if (camConsent != false) {
        final bool present = await PresenceGateService.waitUntilPresent(
          sessionId: ApiConfig.effectiveActorId,
          maxWait: const Duration(minutes: 10),
          shouldAbort: () async =>
              await _isBriefingDeliveredElsewhere(preferredChannel: "desktop"),
        );
        if (!present) {
          final DateTime afterWait = DateTime.now();
          if (afterWait.hour < 5 || afterWait.hour >= 12) return;
          if (await _isBriefingDeliveredElsewhere(preferredChannel: "desktop")) {
            return;
          }
        }
      }
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&format=narration",
      );
      final http.Response res =
          await http.get(uri).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final Object? briefingRaw = data["briefing"];
      if (briefingRaw is! Map) return;
      await _handleMorningBriefingEvent(
        <String, dynamic>{
          "mode": mb["mode"]?.toString() ?? UserPreferencesApi.modeWindow,
          "narrationText": data["narrationText"]?.toString() ?? "",
          "briefing": briefingRaw.cast<String, dynamic>(),
        },
        markDesktopShown: true,
      );
    } catch (_) {
      // ignore desktop launch briefing failures
    }
  }

  Future<void> _tryShowMobileLaunchBriefing() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      // 每日简报只在早上固定时段（05:00–12:00）主动播报，其余时间启动不弹
      final DateTime gateNow = DateTime.now();
      if (gateNow.hour < 5 || gateNow.hour >= 12) return;
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      if (mb["enabled"] == false) return;
      if (await _isBriefingDeliveredElsewhere(preferredChannel: "mobile")) {
        return;
      }
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&format=narration",
      );
      final http.Response res =
          await http.get(uri).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final Object? briefingRaw = data["briefing"];
      if (briefingRaw is! Map) return;
      await _handleMorningBriefingEvent(
        <String, dynamic>{
          "mode": mb["mode"]?.toString() ?? UserPreferencesApi.modeCard,
          "narrationText": data["narrationText"]?.toString() ?? "",
          "briefing": briefingRaw.cast<String, dynamic>(),
        },
      );
    } catch (_) {
      // ignore mobile launch briefing failures
    }
  }

  Future<void> _consumePendingMobileBriefingLaunch() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    final String? payload = await MobileBriefingLauncher.consumeLaunchPayload();
    if (payload == null || payload.isEmpty) return;
    await _openBriefingFromPayload(payload);
  }

  Future<void> _openBriefingFromPayload(String payload) async {
    try {
      final Map<String, dynamic> data =
          jsonDecode(payload) as Map<String, dynamic>;
      await _markBriefingDelivered("mobile");
      await _handleMorningBriefingEvent(data, forceDialog: true);
    } catch (_) {
      // ignore invalid mobile briefing payload
    }
  }

  Future<void> _ensureAndroidNotificationPermission() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    if (_notificationPermissionChecked) return;
    _notificationPermissionChecked = true;
    try {
      final PermissionStatus status = await Permission.notification.status;
      if (status.isDenied) {
        await Permission.notification.request();
      }
    } catch (_) {
      // ignore notification permission failures
    }
  }

  /// 今日桌面渠道已展示过简报（deliveredAt 为今天且渠道为 desktop）。
  /// 用于简报悬浮窗「每天仅一次」判定：重启应用 / 同日多次事件不重复弹。
  Future<bool> _isBriefingDeliveredOnDesktopToday() async {
    try {
      final Map<String, dynamic> status =
          await _briefingDeliveryApi.getStatus(ApiConfig.effectiveActorId);
      final String? deliveredAt = status["deliveredAt"]?.toString();
      final String? deliveredChannel = status["deliveredChannel"]?.toString();
      // 服务端按 UTC 日重置投放状态（resetMorningBriefingDeliveryIfNeeded），
      // 这里必须用 UTC 日期对齐，否则 UTC+8 的凌晨会误判为"昨天已投放"
      final String todayUtc =
          DateTime.now().toUtc().toIso8601String().substring(0, 10);
      return deliveredAt != null &&
          deliveredAt.startsWith(todayUtc) &&
          deliveredChannel == "desktop";
    } catch (_) {
      return false;
    }
  }

  Future<bool> _isBriefingDeliveredElsewhere({
    required String preferredChannel,
  }) async {    try {
      final Map<String, dynamic> status =
          await _briefingDeliveryApi.getStatus(ApiConfig.effectiveActorId);
      final String? deliveredAt = status["deliveredAt"]?.toString();
      final String? deliveredChannel = status["deliveredChannel"]?.toString();
      if (deliveredAt == null || deliveredAt.isEmpty) return false;
      if (deliveredChannel == null || deliveredChannel.isEmpty) return false;
      return deliveredChannel != preferredChannel;
    } catch (_) {
      return false;
    }
  }

  Future<void> _markBriefingDelivered(String channel) async {
    try {
      await _briefingDeliveryApi.markDelivered(
        ApiConfig.effectiveActorId,
        channel: channel,
      );
    } catch (_) {
      // ignore delivery mark failures
    }
  }

  Future<void> _loadAgentProfile() async {
    try {
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final AgentProfileData profile = AgentProfileData.fromPreferences(prefs);
      if (!mounted) return;
      setState(() {
        _agentProfile = profile;
        _agentName = profile.displayName;
      });
    } catch (_) {
      // keep defaults when profile loading fails
    }
  }

  /// 是否在主区显示右侧快捷功能面板（同时也是裁剪 AppBar / 占位宽度的依据）。
  /// 条件：chat tab + 宽屏 (>= 820) + 无右抽屉打开。
  bool _shouldShowRightSidePanel() {
    if (_tabIndex != 0) return false;
    if (_rightPanel != null) return false;
    return MediaQuery.sizeOf(context).width >= kWideLayoutBreakpoint;
  }

  /// AppBar 右侧需要让出的宽度。
  /// - side 模式：右面板实际渲染宽度 [_rightPanelWidth] - 8px 拖拽条，让
  ///   AppBar 顶栏与右侧天气面板贴平，避免两者之间露出缺口。
  /// - split 模式：[NextbotChatLayout] 同步过来的动态宽度 [_rightPanelWidth]
  /// - 其他：0
  double _appBarRightInset() {
    if (_shouldShowRightSidePanel()) {
      return _rightPanelWidth - _kSidePanelDividerWidth;
    }
    if (_rightPanel != null && _tabIndex == 0) return _rightPanelWidth;
    return 0;
  }

  /// 在外层 Stack 顶层用 [Positioned] 渲染右侧面板（side 或 split 模式），
  /// 使面板从 Stack 顶端（自绘标题栏下沿）贯通到底部，覆盖宽度范围内的 AppBar。
  ///
  /// - side 模式：宽度 = [_rightPanelWidth]（由 NextbotChatLayout 拖动条控制），
  ///   渲染 [RightSidePanel]（今日安排 / 常用工具 / 桌宠）。
  /// - split 模式：宽度 = [NextbotChatLayout] 同步过来的动态宽度，
  ///   渲染 [_buildSplitPanel]（顶栏 + 自定义内容）。
  Widget _buildRightPanelOverlay() {
    if (_tabIndex != 0) {
      return const SizedBox.shrink();
    }
    final double screenWidth = MediaQuery.sizeOf(context).width;
    if (screenWidth < kWideLayoutBreakpoint) {
      return const SizedBox.shrink();
    }
    if (_rightPanel != null) {
      // split 模式：动态宽度 + 顶栏面板。
      // 从右往左"推出"：面板先整体位于屏幕右侧外(右移自己宽度)，再沿 X 轴
      // 滑向 0，配合 easeOutCubic 看到明显的"从右往左展出"过程(约 420ms)。
      return TweenAnimationBuilder<double>(
        key: ValueKey<RightPanelKind>(_rightPanel!),
        tween: Tween<double>(begin: _rightPanelWidth, end: 0),
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeOutCubic,
        builder: (BuildContext context, double offset, Widget? child) {
          return Positioned(
            // Stack 顶端即自绘标题栏下沿，top:0 让面板上顶到标题栏。
            top: 0,
            right: 0,
            bottom: 0,
            width: _rightPanelWidth,
            child: Transform.translate(
              offset: Offset(offset, 0),
              child: child,
            ),
          );
        },
        child: _buildSplitPanel(),
      );
    }
    // side 模式：动态宽度(可拖拽) + RightSidePanel
    //
    // [NextbotChatLayout] 内部的 Row = Expanded(chat) | VerticalDragDivider(8)
    // | SizedBox(占位), 报告的总右占位 = [kDividerWidth] + 占位 = 220 等。
    // 这里 Positioned 只覆盖占位(不含 divider 8px), 拖拽条才能在 chat 与
    // 面板之间露出来, 用户才能拖动。
    return Positioned(
      // Stack 顶端即自绘标题栏下沿，top:0 让面板上顶到标题栏。
      top: 0,
      right: 0,
      bottom: 0,
      width: _rightPanelWidth - _kSidePanelDividerWidth,
      child: RightSidePanel(
        scheduleFuture: _cachedScheduleFuture,
        onAgentLink: _openAgentLinkTab,
        onSchedule: _openSchedulePanel,
        onGallery: _openGalleryPanel,
        onBrowser: _openBrowserPanel,
        onTravel: _openTravelArchive,
      ),
    );
  }

  /// Dock 功能面板：顶栏（标题 + 关闭按钮）+ 自定义内容。
  /// 背景使用 cs.surface 跟随主题（黑/白）。
  Widget _buildSplitPanel() {
    // State.context 位于 MaterialApp 之上，Theme.of 只能拿到 fallback 浅色主题；
    // 必须用子树内的 context 解析，颜色才跟随亮/暗主题。
    return Builder(
      builder: (BuildContext context) {
        final ColorScheme cs = Theme.of(context).colorScheme;
        return Material(
          color: cs.surface,
          surfaceTintColor: Colors.transparent,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _buildSplitPanelHeader(cs),
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: cs.surface,
                    border: Border(
                      top: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
                    ),
                  ),
                  child: _buildRightPanelContent(),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  /// Dock 功能面板顶栏：拖拽指示 + 标题 + 关闭按钮。
  Widget _buildSplitPanelHeader(ColorScheme cs) {
    // 同 _buildSplitPanel：用子树内 context 判别亮暗，State.context 拿不到应用主题。
    return Builder(
      builder: (BuildContext context) {
        // 背景与自绘标题栏同色(resolveSidebar)，
        // 文字/图标在暗色下用纯白保证可读性，暖色下用主题前景色。
        final bool isDark = Theme.of(context).brightness == Brightness.dark;
        final Color fg = isDark ? Colors.white : cs.onSurface;
        final Color fgMuted = isDark ? Colors.white : cs.onSurfaceVariant;
        return Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            // 与自绘标题栏/左侧 AppBar 同色(resolveSidebar #131313)，
            // 保证顶部整条横带无缝衔接；面板主体用 cs.surface 区分层次。
            color: AppPalette.resolveSidebar(AppThemeController.instance.value),
            border: Border(
              left: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
              bottom: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
            ),
          ),
          child: Row(
            children: <Widget>[
              // 图片预览面板：隐藏左侧拖拽图标与标题，仅保留关闭按钮
              // （面板组件内部自带完整顶栏：图片大图区）
              if (_rightPanel != RightPanelKind.imagePreview) ...<Widget>[
                Icon(Icons.drag_indicator, size: 16, color: fgMuted),
                const SizedBox(width: 8),
                Text(
                  _rightPanel == null ? "" : _rightPanelTitleText(),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: fg,
                  ),
                ),
              ],
              const Spacer(),
              IconButton(
                icon: Icon(Icons.close, size: 18, color: fgMuted),
                tooltip: "关闭面板",
                visualDensity: VisualDensity.compact,
                onPressed: _closeRightPanel,
              ),
            ],
          ),
        );
      },
    );
  }

  /// 面板顶栏标题文案。内容详情面板不展示 LLM 导语式的卡片标题
  /// （如「王哥，我扒了一圈……」），只展示任务主体标签（如「科技新闻」）。
  String _rightPanelTitleText() {
    final RightPanelKind kind = _rightPanel!;
    if (kind == RightPanelKind.contentSummary) {
      final ContentSummaryDataV2? summary = _contentSummary;
      return summary != null
          ? ContentSummaryParser.taskSubject(summary)
          : "内容详情";
    }
    return rightPanelTitle(kind);
  }

  /// 右侧面板要渲染的具体内容
  Widget _buildRightPanelContent() {
    switch (_rightPanel) {
      case RightPanelKind.friends:
        return MailboxPage(api: _worldApi, ws: _ws);
      case RightPanelKind.messages:
        return MessageHubPage(api: _worldApi);
      case RightPanelKind.devices:
        return const DevicesPage();
      case RightPanelKind.schedule:
        return SchedulePage(
          store: _store,
          scheduleApi: _scheduleApi,
          sessionId: ApiConfig.effectiveActorId,
          reloadListenable: _calendarReloadSignal,
          onCreateViaChat: _focusChatInput,
        );
      case RightPanelKind.imagePreview:
        final ImagePreviewSnapshot? item = _imagePreview;
        if (item == null) return const SizedBox.shrink();
        // 同一绿泡内的全部照片做「上/下一张」切换；仅单张时退化为单张预览
        final List<String> urls =
            (item.gallery != null && item.gallery!.isNotEmpty)
                ? item.gallery!
                : <String>[item.url];
        return ImagePreviewPanel(
          urls: urls,
          index: item.index < urls.length ? item.index : 0,
          source: item.source,
        );
      case RightPanelKind.videoPreview:
        // 视频播放面板：WebView2 承载 HTML5 <video>（Windows 无 video_player 原生实现）
        final VideoPreviewSnapshot? video = _videoPreview;
        if (video == null) return const SizedBox.shrink();
        return VideoPreviewPanel(
          key: ValueKey<String>(video.url),
          url: video.url,
          pageUrl: video.pageUrl,
        );
      case RightPanelKind.browser:
        // 用户与 Agent 共用的内嵌浏览器（WebView2 进程级单例，页面常驻）；
        // 主页「试试让 Agent」chips 把任务文本直接发进对话
        return BrowserPage(
          embedded: true,
          onAgentTask: (String task) => _sendMessage(text: task),
        );
      case RightPanelKind.catalog:
        // 能力面板：CatalogPage 自带 AppBar（页面自治，不依赖面板顶栏标题）
        return CatalogPage(apiClient: _catalogApi);
      case RightPanelKind.approvals:
        return const ApprovalsPanel();
      case RightPanelKind.agentHome:
        // Agent 主页：嵌入模式，面板顶栏已有"主页"标题，
        // 主页页体不再渲染自带 AppBar（与 GalleryPage.embedded 同约定）
        return AgentHomePage(embedded: true);
      case RightPanelKind.contentSummary:
        // 内容详情面板：标题栏显示主体标签（见 _rightPanelTitleText），
        // 正文区与弹窗共用视图；按摘要 id 建 Key，切换详情时重置滚动/书签状态
        final ContentSummaryDataV2? summary = _contentSummary;
        if (summary == null) return const SizedBox.shrink();
        return ContentSummaryDetailView(
          key: ValueKey<String>(summary.id),
          summary: summary,
        );
      case null:
        return const SizedBox.shrink();
    }
  }

  Widget _buildMainContent() {
    final double screenWidth = MediaQuery.sizeOf(context).width;

    if (_tabIndex != 0 || screenWidth < kWideLayoutBreakpoint) {
      return _buildTabStack();
    }
    return NextbotChatLayout(
      useSplit: _rightPanel != null,
      splitRatio: _splitRatio,
      onSplitRatioChanged: _setSplitRatio,
      onRightPanelWidthChanged: _setRightPanelWidth,
      // side 模式下也启用拖拽：把当前宽度(含 8px 拖拽条)传下去,
      // NextbotChatLayout 内部会保留此值作为初始/外部同步值。
      // split 模式下该参数会被忽略,这里统一传当前宽度即可,
      // 避免打开工具面板时传 null 把内部的 _sidePanelWidth 重置成默认值。
      sidePanelWidth: _rightPanelWidth,
      child: _buildChatPage(context),
    );
  }

  /// 构建聊天页（宽屏布局与 Tab 栈共用）
  Widget _buildChatPage(BuildContext context) {
    return ChatPage(
      messages: _messages,
      controller: _inputController,
      inputFocusNode: _inputFocusNode,
      onSend: _sendMessage,
      agentName: _agentName,
      agentAvatarUrl: _agentProfile.avatarUrl,
      userAvatarUrl: UserAvatarApi.resolveUrl(_userAvatarPath),
      agentMoodStyle: _agentProfile.moodStyle,
      agentAvatarPreset: _agentProfile.avatarPreset,
      agentProfile: _agentProfile,
      galleryPendingImages: <Uint8List>[
        for (final VisionWireFrame f in _pendingGalleryFrames)
          _asUint8List(f.bytes),
      ],
      onPickGalleryImage: _pickGalleryImage,
      onRemoveGalleryImage: _removePendingGalleryImage,
      resolveUserGalleryImages: (String messageId) =>
          _sentGalleryImageBytes[messageId],
      failedUserMessageIds: _failedUserMessageIds,
      isAgentProcessing: _isAgentProcessing,
      agentStatusLine: _agentStatusLine,
      agentStatusPercent: _agentStatusPercent,
      currentToolName: _currentToolName,
      interimAckText: _interimAckText,
      // v2：把结构化状态机注入到 ChatPage；v1 链路下传 null 不影响
      turnState: _turnState ?? _pendingLocalTurn,
      // 跨轮常驻任务步骤（plan.* 的可见面；等用户操作的一步会在这里给按钮）
      planSteps: _planSteps,
      isActive: _tabIndex == 0,
      onOpenPhoneDialer: () {
        _callMyAgentViaPhone(null);
      },
      onDeleteMessage: _deleteTurn,
      onDeleteFromMessage: _deleteMessagesFrom,
      onStopAgent: _cancelCurrentTurn,
      onUserAction: _handleCardAction,
      // 光球头像单击 → 右侧双栏面板打开 Agent 主页（窄窗口退化为全屏路由页）
      onOpenAgentHome: _openAgentHomePanel,
      // 任务面回执聚合（状态带「N 个任务后台进行中」）+ 逐任务取消入口
      backgroundTaskCount: _taskPlaneState.activeCount,
      onCancelBackgroundTask: _cancelBackgroundTask,
      onConfirmDecisionCard: _handleDecisionCardAction,
      // 豆包式列队发送：排队中的用户消息气泡显示「排队中」徽标
      queuedMessageIds: _queuedUserMessageIds,
      // 「为你推荐」：父级聚合空闲态 + 本地存储（出现时机治理持久化）
      agentIdle: !_isAgentProcessing &&
          (_currentToolName?.trim().isEmpty ?? true) &&
          _taskPlaneState.isEmpty,
      localStore: _store,
    );
  }

  /// 根级 Tab 栈：0=对话，1=钱包 dialog 占位（栈里不挂载）。
  ///
  /// 注：图库已于 2026-09-29 退出一级 tab，改为常用工具入口的全屏路由
  /// （见 GalleryWorkbenchPage.show），不再挂在本栈里。
  Widget _buildTabStack() {
    return Builder(
      builder: (BuildContext context) {
        return IndexedStack(
          index: _tabIndex,
          children: <Widget>[
            _buildChatPage(context),
            const SizedBox.shrink(),
          ],
        );
      },
    );
  }
}

