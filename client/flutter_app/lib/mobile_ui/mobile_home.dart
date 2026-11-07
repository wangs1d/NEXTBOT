import "dart:async";

import "package:flutter/material.dart";

import "../app/ambient_feeds_controller.dart";
import "../core/config/api_config.dart";
import "../core/services/image_preview_launcher.dart";
import "../core/services/schedule_api_client.dart";
import "../core/utils/agent_result_parser.dart";
import "../features/chat/image_preview_panel.dart";
import "../features/chat/travel_plan_launcher.dart";
import "../features/chat/travel_plan_mobile_page.dart";
import "../features/chat/travel_plan_models.dart";
import "mobile_chat_controller.dart";
import "mobile_chat_page.dart";
import "mobile_goals_page.dart";
import "mobile_library_page.dart";
import "mobile_profile_page.dart";
import "mobile_schedule_page.dart";
import "mobile_theme.dart";

/// 手机端主壳：底部导航 5 tab —— 对话 / 日程 / 目标 / 资料库 / 设置。
///
/// - 日程为手机专属「行程表」[MobileSchedulePage]：一天一页 + 顶部日期条跳转，只读展示未来 30 天
/// - 目标为「在办事项」统一视图 [MobileGoalsPage]（服务端 goals/view 单源只读）
/// - 资料库为产出物归档 [MobileLibraryPage]（文件/笔记/行程规划，服务端聚合）
/// - 「设置」沿用原「我的」聚合页 [MobileProfilePage](简报/邮箱/设备/审批/模型服务等)
/// - 底栏为自绘 tab 卡（白卡 + 5 圆形图标热区，选中浅灰圆底），不再是 NavigationBar
/// - 各 tab 惰性构建 + IndexedStack 保活:未访问过的 tab 不发任何网络请求
class MobileHomePage extends StatefulWidget {
  const MobileHomePage({
    super.key,
    this.chatController,
    this.initialTabIndex = 0,
    this.themeMode,
    this.onThemeModeChanged,
    this.onLogout,
    this.agentName,
  });

  /// 外部注入的对话控制器(测试用);不传时自建。
  final MobileChatController? chatController;

  /// 用户给 agent 取的名称（根组件从服务端拉取后注入；
  /// 空/null 时对话页顶栏回退「智能助手」）。
  final String? agentName;

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
    with WidgetsBindingObserver {
  late final MobileChatController _chatController;
  late final ScheduleApiClient _scheduleApi;

  int _tabIndex = 0;

  /// 日程页句柄（2026-10-08）：IndexedStack 保活下日程页 initState 只拉一次，
  /// 对话里刚建的提醒不切不刷新——每次切到日程 tab 时经此触发重拉。
  final GlobalKey<MobileSchedulePageState> _scheduleKey =
      GlobalKey<MobileSchedulePageState>();

  /// 目标页 / 资料库页句柄：同日程页口径，切 tab 时触发重拉。
  final GlobalKey<MobileGoalsPageState> _goalsKey =
      GlobalKey<MobileGoalsPageState>();
  final GlobalKey<MobileLibraryPageState> _libraryKey =
      GlobalKey<MobileLibraryPageState>();

  /// 惰性构建缓存:首次切到某 tab 才构建其页面,之后保活。
  final List<Widget?> _tabCache =
      List<Widget?>.filled(5, null, growable: false);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tabIndex = widget.initialTabIndex.clamp(0, 4);
    _chatController = widget.chatController ?? MobileChatController();
    _scheduleApi = ScheduleApiClient(baseUrl: ApiConfig.httpBase);
    _wireAmbientFeeds();
    // 行程规划入口接线（2026-10-12 与桌面端对齐）：行程卡「打开行程规划」
    // 按钮经 TravelPlanLauncher 静态回调打开原生行程页。此前手机端从未注册
    // handler（桌面 main.dart 独有），点击恒为 no-op。
    TravelPlanLauncher.setHandler(_openTravelPlanPanel);
    // 图片预览入口接线（2026-11-04）：搜索/识图照片点击 → 全屏查看页。
    // 此前手机端从未注册 handler（桌面 main.dart 独有），点击恒为 no-op；
    // 且外层壳的 context 不在手机嵌套导航器内，必须在主壳这里注册、
    // 用主壳自己的 context 才能推全屏路由。
    ImagePreviewLauncher.setHandler(_openImagePreview);
  }

  /// agent 名称变化时失效对话 tab 缓存：IndexedStack 保活的 MobileChatPage
  /// 持有旧 widget.agentName，必须重建才能刷新顶栏标题。
  @override
  void didUpdateWidget(MobileHomePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.agentName != oldWidget.agentName) {
      _tabCache[0] = null;
    }
  }

  /// 打开全屏图片查看页（ImagePreviewPanel 复用：缩放/多图切换）。
  void _openImagePreview(ImagePreviewSnapshot item) {
    if (!mounted) return;
    final List<String> urls =
        (item.gallery != null && item.gallery!.isNotEmpty)
            ? item.gallery!
            : <String>[item.url];
    unawaited(showImagePreviewFullScreen(
      context,
      urls: urls,
      index: item.index < urls.length ? item.index : 0,
      source: item.source,
    ));
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
    c.isChatTabActive = null;
    c.syncSchedule = null;
    _chatController.dispose();
    super.dispose();
  }

  // ===== 提醒触达装配（2026-10-12 接通）=====

  /// 是否处于手机后台（类微信常在线分流：后台走系统通知）。
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
  /// 前后台判定、对话页停留判定、日程页刷新。系统通知由
  /// LocalNotificationService 承接（main_mobile.dart 启动时 init）。
  void _wireAmbientFeeds() {
    final AmbientFeedsController c = AmbientFeedsController.instance;
    c.isAppBackgrounded = () => _appBackgrounded;
    // 对话页停留判定（2026-11-04 微信同款）：正在对话 tab 就不发系统通知。
    c.isChatTabActive = () => _tabIndex == 0;
    c.syncSchedule = () async {
      _scheduleKey.currentState?.refresh();
    };
  }

  /// 切到指定 tab(0=对话 1=日程 2=目标 3=资料库 4=设置;供行程表空态跳回对话页等跨页联动)。
  void goToTab(int index) {
    if (index < 0 || index > 4) return;
    _switchTab(index);
  }

  void _switchTab(int index) {
    // 首次进入走页面 initState 的 _load（避免双拉）；已构建过的页面才补一次重拉。
    final bool scheduleAlreadyBuilt = _tabCache[1] != null;
    final bool goalsAlreadyBuilt = _tabCache[2] != null;
    final bool libraryAlreadyBuilt = _tabCache[3] != null;
    setState(() => _tabIndex = index);
    if (index == 1 && scheduleAlreadyBuilt) {
      _scheduleKey.currentState?.refresh();
    } else if (index == 2 && goalsAlreadyBuilt) {
      _goalsKey.currentState?.refresh();
    } else if (index == 3 && libraryAlreadyBuilt) {
      _libraryKey.currentState?.refresh();
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
      for (int i = 0; i < 5; i++)
        _tabCache[i] ??= _buildTab(i),
    ];
  }

  Widget _buildTab(int index) {
    switch (index) {
      case 0:
        return MobileChatPage(
          controller: _chatController,
          agentName: widget.agentName,
        );
      case 1:
        return MobileSchedulePage(
          key: _scheduleKey,
          scheduleApi: _scheduleApi,
          sessionId: ApiConfig.effectiveActorId,
          onGoToChat: () => goToTab(0),
        );
      case 2:
        return MobileGoalsPage(
          key: _goalsKey,
          onCreateGoal: () => goToTab(0),
        );
      case 3:
        return MobileLibraryPage(key: _libraryKey);
      case 4:
        return MobileProfilePage(
          chatController: _chatController,
          themeMode: widget.themeMode,
          onThemeModeChanged: widget.onThemeModeChanged,
          onLogout: widget.onLogout,
        );
    }
    return const SizedBox.shrink();
  }

  /// 自绘 tab 卡（2026-11-07 定稿）：与输入框分离的独立白卡，
  /// 5 个 44px 圆形图标热区均分；选中态 = 浅灰圆底 + 深色图标，无文字标签。
  Widget _buildBottomBar(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return SafeArea(
      top: false,
      child: Container(
        margin: const EdgeInsets.fromLTRB(4, 4, 4, 6),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(28),
          border: Border.all(color: p.divider.withValues(alpha: 0.6), width: 0.8),
        ),
        child: Row(
          children: <Widget>[
            for (int i = 0; i < 5; i++)
              Expanded(
                child: _TabItem(
                  icon: _tabIcons[i][0],
                  selectedIcon: _tabIcons[i][1],
                  selected: _tabIndex == i,
                  p: p,
                  onTap: () => _switchTab(i),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 5 个 tab 的图标对：[线性未选中, 填充选中]。
  static const List<List<IconData>> _tabIcons = <List<IconData>>[
    <IconData>[Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded],
    <IconData>[Icons.event_outlined, Icons.event_rounded],
    <IconData>[Icons.flag_outlined, Icons.flag_rounded],
    <IconData>[Icons.folder_outlined, Icons.folder_rounded],
    <IconData>[Icons.settings_outlined, Icons.settings_rounded],
  ];
}

/// 单个 tab 热区：44px 圆形容器，选中态浅灰圆底 + 深色图标。
class _TabItem extends StatelessWidget {
  const _TabItem({
    required this.icon,
    required this.selectedIcon,
    required this.selected,
    required this.p,
    required this.onTap,
  });

  final IconData icon;
  final IconData selectedIcon;
  final bool selected;
  final MobilePalette p;
  final VoidCallback onTap;

  /// 单个 tab 热区：54px 高命中区 + 44px 圆形容器，选中态浅灰圆底 + 深色图标。
  /// 注意：外层必须是定高 SizedBox——Center 在松约束下会撑满父级可用高度，
  /// 会把整个 bottomNavigationBar 撑到全屏、正文区高度归零（0 高 bug 教训）。
  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: SizedBox(
          height: 54,
          child: Center(
            child: Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: selected
                    ? p.innerFieldBackground
                    : Colors.transparent,
              ),
              child: Icon(
                selected ? selectedIcon : icon,
                size: 22,
                color: selected ? p.textPrimary : p.textMuted,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
