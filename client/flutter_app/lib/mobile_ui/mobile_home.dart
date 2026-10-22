import "dart:async";

import "package:flutter/material.dart";

import "../app/ambient_feeds_controller.dart";
import "../core/config/api_config.dart";
import "../core/presentation/foreground_banner.dart";
import "../core/services/schedule_api_client.dart";
import "../core/utils/agent_result_parser.dart";
import "../features/chat/travel_plan_launcher.dart";
import "../features/chat/travel_plan_mobile_page.dart";
import "../features/chat/travel_plan_models.dart";
import "mobile_chat_controller.dart";
import "mobile_chat_page.dart";
import "mobile_profile_page.dart";
import "mobile_schedule_page.dart";
import "mobile_theme.dart";

/// 手机端主壳：底部导航 3 tab —— 对话 / 日程 / 我的。
///
/// - 日程为手机专属「行程表」[MobileSchedulePage]：一天一页 + 顶部日期条跳转，只读展示未来 30 天
/// - 「我的」为二级菜单聚合页(简报/邮箱/设备/审批/模型服务等)
/// - 各 tab 惰性构建 + IndexedStack 保活:未访问过的 tab 不发任何网络请求
class MobileHomePage extends StatefulWidget {
  const MobileHomePage({
    super.key,
    this.chatController,
    this.initialTabIndex = 0,
    this.themeMode,
    this.onThemeModeChanged,
    this.onLogout,
  });

  /// 外部注入的对话控制器(测试用);不传时自建。
  final MobileChatController? chatController;

  /// 初始 tab(截图取证用)。
  final int initialTabIndex;

  /// 当前主题模式(由根组件管理;null 时「我的」页隐藏主题设置行)。
  final ThemeMode? themeMode;

  /// 切换主题模式。
  final ValueChanged<ThemeMode>? onThemeModeChanged;

  /// 退出登录(根组件清会话并回到登录页;null 时「我的」页隐藏退出项)。
  final VoidCallback? onLogout;

  @override
  State<MobileHomePage> createState() => MobileHomePageState();
}

class MobileHomePageState extends State<MobileHomePage>
    with WidgetsBindingObserver implements ForegroundBanner {
  late final MobileChatController _chatController;
  late final ScheduleApiClient _scheduleApi;

  int _tabIndex = 0;

  /// 日程页句柄（2026-10-08）：IndexedStack 保活下日程页 initState 只拉一次，
  /// 对话里刚建的提醒不切不刷新——每次切到日程 tab 时经此触发重拉。
  final GlobalKey<MobileSchedulePageState> _scheduleKey =
      GlobalKey<MobileSchedulePageState>();

  /// 惰性构建缓存:首次切到某 tab 才构建其页面,之后保活。
  final List<Widget?> _tabCache = <Widget?>[null, null, null];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tabIndex = widget.initialTabIndex.clamp(0, 2);
    _chatController = widget.chatController ?? MobileChatController();
    _scheduleApi = ScheduleApiClient(baseUrl: ApiConfig.httpBase);
    _wireAmbientFeeds();
    // 行程规划入口接线（2026-10-12 与桌面端对齐）：行程卡「打开行程规划」
    // 按钮经 TravelPlanLauncher 静态回调打开原生行程页。此前手机端从未注册
    // handler（桌面 main.dart 独有），点击恒为 no-op。
    TravelPlanLauncher.setHandler(_openTravelPlanPanel);
  }

  /// 打开原生行程规划页（TravelPlanMobilePage 全屏路由）。
  void _openTravelPlanPanel(AgentResultData data) {
    if (ApiConfig.isOssEdition) return;
    if (!mounted) return;
    unawaited(
      TravelPlanMobilePage.show(context, plan: TravelPlanData.from(data)),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // 单例端口随主壳销毁清空，防悬挂闭包引用已 dispose 的 context
    final AmbientFeedsController c = AmbientFeedsController.instance;
    c.isAppBackgrounded = null;
    c.syncSchedule = null;
    c.foregroundBanner = null;
    _chatController.dispose();
    super.dispose();
  }

  // ===== 提醒触达装配（2026-10-12 接通）=====

  /// 是否处于手机后台（类微信常在线分流：后台走系统通知，前台走应用内横幅）。
  bool _appBackgrounded = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // resumed 才算前台；hidden/paused/detached 均按后台处理
    _appBackgrounded = state != AppLifecycleState.resumed;
    if (state == AppLifecycleState.resumed) {
      // 回前台确保 WS 在线（2026-10-20）：WsChatService 重连 10 次耗尽后
      // 永久放弃，服务端主动消息只能挂起等这次补连。
      _chatController.service.ensureConnected();
    }
  }

  /// 装配环境信息流编排层端口（与桌面端 main.dart 同构）：
  /// 前后台判定、日程页刷新、前台提醒横幅（ForegroundBanner 接口，
  /// State 自身即实现，dispose 随端口清空）。后台系统通知由
  /// LocalNotificationService 承接（main_mobile.dart 启动时 init）。
  void _wireAmbientFeeds() {
    final AmbientFeedsController c = AmbientFeedsController.instance;
    c.isAppBackgrounded = () => _appBackgrounded;
    c.syncSchedule = () async {
      _scheduleKey.currentState?.refresh();
    };
    c.foregroundBanner = this;
  }

  /// ForegroundBanner 接口实现：主动触达统一入口，具体呈现委托横幅。
  @override
  Future<void> show(String title, String message) async {
    _showReminderBanner(title, message);
  }

  /// 到点提醒前台横幅：浮层 SnackBar 6s 自动收，点击跳日程页。
  void _showReminderBanner(String title, String message) {
    if (!mounted) return;
    final MobilePalette p = MobileTheme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 6),
        backgroundColor: p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: p.divider),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600)),
            if (message.isNotEmpty && message != title)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(message,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textSecondary, fontSize: 13)),
              ),
          ],
        ),
        action: SnackBarAction(
          label: "日程",
          textColor: p.textPrimary,
          onPressed: () => goToTab(1),
        ),
      ),
    );
  }

  /// 切到指定 tab(0=对话 1=日程 2=我的;供行程表空态跳回对话页等跨页联动)。
  void goToTab(int index) {
    if (index < 0 || index > 2) return;
    _switchTab(index);
  }

  void _switchTab(int index) {
    // 首次进入走页面 initState 的 _load（避免双拉）；已构建过的页面才补一次重拉。
    final bool scheduleAlreadyBuilt = _tabCache[1] != null;
    setState(() => _tabIndex = index);
    if (index == 1 && scheduleAlreadyBuilt) {
      _scheduleKey.currentState?.refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      body: IndexedStack(index: _tabIndex, children: _buildTabs()),
      bottomNavigationBar: _buildBottomBar(context),
    );
  }

  List<Widget> _buildTabs() {
    return <Widget>[
      for (int i = 0; i < 3; i++)
        _tabCache[i] ??= _buildTab(i),
    ];
  }

  Widget _buildTab(int index) {
    switch (index) {
      case 0:
        return MobileChatPage(controller: _chatController);
      case 1:
        return MobileSchedulePage(
          key: _scheduleKey,
          scheduleApi: _scheduleApi,
          sessionId: ApiConfig.effectiveActorId,
          onGoToChat: () => goToTab(0),
        );
      case 2:
        return MobileProfilePage(
          chatController: _chatController,
          themeMode: widget.themeMode,
          onThemeModeChanged: widget.onThemeModeChanged,
          onLogout: widget.onLogout,
        );
    }
    return const SizedBox.shrink();
  }

  Widget _buildBottomBar(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return NavigationBar(
      selectedIndex: _tabIndex,
      onDestinationSelected: _switchTab,
      backgroundColor: cs.surface,
      indicatorColor: Colors.transparent,
      height: 64,
      destinations: <Widget>[
        NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline_rounded,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.chat_bubble_rounded, color: cs.primary),
          label: "对话",
        ),
        NavigationDestination(
          icon: Icon(Icons.event_outlined,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.event_rounded, color: cs.primary),
          label: "日程",
        ),
        NavigationDestination(
          icon: Icon(Icons.person_outline_rounded,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.person_rounded, color: cs.primary),
          label: "我的",
        ),
      ],
    );
  }
}
