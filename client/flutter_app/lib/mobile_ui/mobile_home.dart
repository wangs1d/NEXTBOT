import "dart:async";
import "dart:ui" show ImageFilter;

import "package:flutter/material.dart";

import "../app/ambient_feeds_controller.dart";
import "../core/config/api_config.dart";
import "../core/services/image_preview_launcher.dart";
import "../core/services/schedule_api_client.dart";
import "../core/services/side_chat_api.dart";
import "../core/utils/agent_result_parser.dart";
import "../features/chat/image_preview_panel.dart";
import "../features/chat/travel_plan_launcher.dart";
import "../features/chat/travel_plan_mobile_page.dart";
import "../features/chat/travel_plan_models.dart";
import "mobile_chat_controller.dart";
import "mobile_chat_page.dart";
import "mobile_goals_page.dart";
import "mobile_library_page.dart";
import "mobile_line_icons.dart";
import "mobile_profile_page.dart";
import "mobile_schedule_page.dart";
import "mobile_sidebar.dart";
import "mobile_theme.dart";

/// 手机端主壳：底部 4 tab —— 对话 / 日程 / 目标 / 资料库；
/// 设置迁到左侧抽屉左下角（点击进入原「我的」页）。
///
/// - 日程为手机专属「行程表」[MobileSchedulePage]：一天一页 + 顶部日期条跳转，只读展示未来 30 天
/// - 目标为「在办事项」统一视图 [MobileGoalsPage]（服务端 goals/view 单源只读）
/// - 资料库为产出物归档 [MobileLibraryPage]（文件/笔记/行程规划，服务端聚合）
/// - 「设置」不再占 tab；抽屉左下角齿轮 → [MobileProfilePage]（简报/邮箱/设备/审批/模型服务等）
/// - 底栏为 4 tab 玻璃胶囊（54px 高、左右 8px、圆角 27，选中 34px 圆环）
/// - 左上角汉堡键打开 288px 抽屉：主界面整体右移、右侧留 32px 缝隙（等价于主界面右移只剩左条）
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
    with WidgetsBindingObserver, TickerProviderStateMixin {
  late final MobileChatController _chatController;
  late final ScheduleApiClient _scheduleApi;

  int _tabIndex = 0;

  /// 抽屉目标宽度：屏宽 - 32（右侧恒定留 32px 主界面窄缝，设计稿 02 屏）。
  double _drawerWidthFor(BuildContext context) {
    final double screenWidth = MediaQuery.sizeOf(context).width;
    return screenWidth - 32;
  }

  /// 抽屉开合动画（0 = 关，1 = 开）。
  late final AnimationController _drawerAnim;
  bool _drawerOpen = false;

  /// 进入旁聊时新界面的入场动画（0 = 在左侧屏幕外，1 = 归位）。
  /// 2026-11-07 反馈：点「新建旁聊 / 打开旁聊」后，新界面要像从侧边栏里
  /// 滑出来一样整体滑入，而不是主界面原地换内容。
  late final AnimationController _sideEnterAnim;

  /// 底栏外圈灰光的呼吸动画（0 → 1 → 0 循环），只在暗色主题使用。
  late final AnimationController _glowAnim;

  /// 最近进入过的旁聊：退回主会话后，抽屉里仍高亮这一条，
  /// 让「选中旁聊」的卡片态始终可见（与参考图 03 的高亮一致）。
  String? _lastSideChatId;

  /// 本次横向拖动开始时抽屉是否处于关闭态（用于松手后补一次列表重拉）。
  bool _drawerWasClosedOnDragStart = true;

  /// 抽屉句柄：每次打开触发旁聊列表重拉。
  final GlobalKey<MobileSidebarState> _sidebarKey =
      GlobalKey<MobileSidebarState>();

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
      List<Widget?>.filled(4, null, growable: false);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tabIndex = widget.initialTabIndex.clamp(0, 3);
    _drawerAnim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 240),
    );
    // 入场动画空闲态 = 1（无位移），只有进入旁聊时从 0 播到 1。
    _sideEnterAnim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 300),
      value: 1,
    );
    // 呼吸灯：4.2s 一轮缓入缓出，明暗幅度很小，只做边缘微光。
    _glowAnim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 4200),
    )..repeat(reverse: true);
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
    final List<String> urls = (item.gallery != null && item.gallery!.isNotEmpty)
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
    _drawerAnim.dispose();
    _sideEnterAnim.dispose();
    _glowAnim.dispose();
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

  /// 切到指定 tab(0=对话 1=日程 2=目标 3=资料库;供行程表空态跳回对话页等跨页联动)。
  void goToTab(int index) {
    if (index < 0 || index > 3) return;
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
    final double drawerWidth = _drawerWidthFor(context);
    final double screenWidth = MediaQuery.sizeOf(context).width;
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    // 主界面深色背景：整屏统一的中性灰（R=G=B），不再自上而下压黑。
    // 2026-11-07 反馈：底部原本渐变到 #0E0E0E，导致输入框/底栏所在的
    // 下半屏看起来是黑色、和灰色主题背景不一致；这里改成单一灰底。
    final Widget mainShell = Container(
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF171717) : p.background,
      ),
      child: Stack(
        children: <Widget>[
          Scaffold(
            backgroundColor: Colors.transparent,
            // 玻璃底栏压在页面内容之上（backdrop 才能糊到消息/列表）
            extendBody: true,
            body: IndexedStack(index: _tabIndex, children: _buildTabs()),
            bottomNavigationBar: _buildBottomBar(context),
          ),
        ],
      ),
    );
    // 整屏横向拖动：右拖打开抽屉、左拖收起（2026-11-07 反馈）。
    // 用 translucent 命中层，纵向滚动/点击仍由下层内容接管；
    // 日程页的 PageView 会抢水平手势，所以另在左边缘叠了 20px 拖动条。
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onHorizontalDragStart: _handleDrawerDragStart,
      onHorizontalDragUpdate: _handleDrawerDragUpdate,
      onHorizontalDragEnd: _handleDrawerDragEnd,
      onHorizontalDragCancel: _handleDrawerDragCancel,
      child: Stack(
        children: <Widget>[
          // 底色层：进入旁聊时主界面整体从左侧滑入，滑入过程中露出的
          // 区域必须是与主界面一致的底色（不能透出 MaterialApp 默认底色）。
          Positioned.fill(
            child: Container(
              color: dark ? const Color(0xFF171717) : p.background,
            ),
          ),
          // 主界面：抽屉打开时整体右移 288px，右侧只留 32px 窄缝（设计稿 02 屏）。
          AnimatedBuilder(
            animation: Listenable.merge(
              <Listenable>[_drawerAnim, _sideEnterAnim],
            ),
            builder: (BuildContext context, Widget? child) {
              final double t = Curves.easeOutCubic.transform(_drawerAnim.value);
              // 进入旁聊：新界面从屏幕左侧（侧边栏所在方向）滑入到位。
              final double enter =
                  Curves.easeOutCubic.transform(_sideEnterAnim.value);
              return Transform.translate(
                offset: Offset(
                  drawerWidth * t - screenWidth * (1 - enter),
                  0,
                ),
                // 右侧窄缝直接展示真实主界面（只叠一层黑色遮罩），
                // 不再做 ImageFiltered 模糊：Impeller 下离屏模糊容易出色块，
                // 而且模糊后也看不出「主界面视角」。
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(22 * t),
                  child: child,
                ),
              );
            },
            child: mainShell,
          ),
          // 遮罩：压在右移后的主界面上、抽屉之下；点击关闭。
          AnimatedBuilder(
            animation: _drawerAnim,
            builder: (BuildContext context, _) {
              final double t = Curves.easeOutCubic.transform(_drawerAnim.value);
              if (t <= 0.001) return const SizedBox.shrink();
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _closeSidebar,
                child: Container(
                  color: Colors.black.withValues(alpha: 0.30 * t),
                ),
              );
            },
          ),
          // 抽屉本体：从左侧滑入（宽 288）。
          AnimatedBuilder(
            animation: _drawerAnim,
            builder: (BuildContext context, Widget? child) {
              final double t = Curves.easeOutCubic.transform(_drawerAnim.value);
              // 关闭态必须 Offstage：抽屉虽滑到屏幕外，但它的黑色大阴影仍会
              // 从 x≈0 渗进主界面左边缘（左侧发暗的元凶）。Offstage 只停绘制，
              // 不销毁 MobileSidebar 状态。
              return Offstage(
                offstage: t <= 0.001,
                child: Transform.translate(
                  offset: Offset(-drawerWidth * (1 - t), 0),
                  child: IgnorePointer(ignoring: t <= 0.001, child: child),
                ),
              );
            },
            child: SizedBox(
              width: drawerWidth,
              // 抽屉在 Scaffold 之外，必须自带 Material（否则 Text 落到
              // WidgetsApp 的黄色下划线 error 样式）。
              child: Material(
                type: MaterialType.transparency,
                child: MobileSidebar(
                  key: _sidebarKey,
                  activeSessionId:
                      _chatController.activeSideSessionId ?? _lastSideChatId,
                  onClose: _closeSidebar,
                  onOpenChat: (SideChatSummary chat) =>
                      unawaited(_openSideChat(chat)),
                  onOpenSettings: _openSettings,
                  onDeleted: (String sessionId) {
                    if (sessionId == _lastSideChatId) {
                      _lastSideChatId = null;
                    }
                    unawaited(_chatController.forgetSideChat(sessionId));
                  },
                ),
              ),
            ),
          ),
          // 左边缘 20px 拖动条：日程页 PageView 会抢水平手势，
          // 这里靠 translucent 命中先入场，只截水平拖动，纵向滚动与点击不丢。
          // 常驻不随开合增删——拖动中移除手势识别器会把当前拖动直接取消。
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            width: 20,
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onHorizontalDragStart: _handleDrawerDragStart,
              onHorizontalDragUpdate: _handleDrawerDragUpdate,
              onHorizontalDragEnd: _handleDrawerDragEnd,
              onHorizontalDragCancel: _handleDrawerDragCancel,
            ),
          ),
        ],
      ),
    );
  }

  void _openSidebar() {
    if (_drawerOpen) return;
    setState(() => _drawerOpen = true);
    _drawerAnim.forward();
    unawaited(_sidebarKey.currentState?.reload());
  }

  void _closeSidebar() {
    if (!_drawerOpen) return;
    _drawerAnim.reverse().whenComplete(() {
      if (mounted) setState(() => _drawerOpen = false);
    });
  }

  // ===== 左右滑动切换抽屉（2026-11-07 反馈）=====

  void _handleDrawerDragStart(DragStartDetails details) {
    _drawerAnim.stop();
    _drawerWasClosedOnDragStart = !_drawerOpen;
  }

  void _handleDrawerDragUpdate(DragUpdateDetails details) {
    final double width = _drawerWidthFor(context);
    if (width <= 0) return;
    final double next =
        (_drawerAnim.value + (details.primaryDelta ?? 0) / width)
            .clamp(0.0, 1.0);
    final bool open = next > 0.001;
    if (open != _drawerOpen) {
      setState(() => _drawerOpen = open);
    }
    _drawerAnim.value = next;
  }

  void _handleDrawerDragEnd(DragEndDetails details) {
    _settleDrawer(details.primaryVelocity ?? 0);
  }

  void _handleDrawerDragCancel() {
    _settleDrawer(0);
  }

  /// 松手后按速度或位移过半决定开/关。
  void _settleDrawer(double velocity) {
    final bool open =
        velocity.abs() >= 400 ? velocity > 0 : _drawerAnim.value >= 0.5;
    if (open) {
      if (!_drawerOpen) setState(() => _drawerOpen = true);
      if (_drawerWasClosedOnDragStart) {
        _drawerWasClosedOnDragStart = false;
        unawaited(_sidebarKey.currentState?.reload());
      }
      _drawerAnim.forward();
      return;
    }
    if (_drawerAnim.value <= 0.001) {
      if (_drawerOpen) setState(() => _drawerOpen = false);
      return;
    }
    _drawerAnim.reverse().whenComplete(() {
      if (mounted) setState(() => _drawerOpen = false);
    });
  }

  /// 点某条旁聊：关抽屉 → 切到独立线程（正在生成时拒绝，避免流式事件串线程）。
  Future<void> _openSideChat(SideChatSummary chat) async {
    _lastSideChatId = chat.sessionId;
    // 抽屉直接收起（不播反向滑动）：新界面要从侧边栏所在方向整体滑入，
    // 抽屉同时滑出会与入场动画互相打架（2026-11-07 反馈）。
    _stowDrawerForSideEnter();
    if (!_chatController.canSwitchSession) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("正在回复，稍后再切换旁聊")),
      );
      return;
    }
    // enterSideChat 的同步段已完成切线程，紧接着播放入场动画。
    final Future<bool> entering =
        _chatController.enterSideChat(sessionId: chat.sessionId);
    _playSideEnterAnimation();
    final bool ok = await entering;
    if (!mounted || !ok) return;
    _chatController.setActiveSideTitle(chat.title);
  }

  /// 收起抽屉但不播动画（进入旁聊专用）。
  void _stowDrawerForSideEnter() {
    _drawerAnim.stop();
    _drawerAnim.value = 0;
    if (_drawerOpen) setState(() => _drawerOpen = false);
  }

  /// 旁聊新界面从屏幕左侧（侧边栏方向）滑入到位。
  void _playSideEnterAnimation() {
    _sideEnterAnim.stop();
    _sideEnterAnim.value = 0;
    _sideEnterAnim.forward();
  }

  /// 左下角齿轮：设置不再占底栏一格，改为全屏「我的」页路由。
  void _openSettings() {
    _closeSidebar();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MobileProfilePage(
            chatController: _chatController,
            themeMode: widget.themeMode,
            onThemeModeChanged: widget.onThemeModeChanged,
            onLogout: widget.onLogout,
          ),
        ),
      ),
    );
  }

  List<Widget> _buildTabs() {
    return <Widget>[
      for (int i = 0; i < 4; i++)
        _tabCache[i] ??= (i == 0
            ? _buildTab(i)
            : Padding(
                // 玻璃底栏 overlay 高 69 + 7 缝隙，非对话页留出底部安全区。
                padding: const EdgeInsets.only(bottom: 76),
                child: _buildTab(i),
              )),
    ];
  }

  Widget _buildTab(int index) {
    switch (index) {
      case 0:
        return MobileChatPage(
          controller: _chatController,
          agentName: widget.agentName,
          onOpenSidebar: _openSidebar,
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
    }
    return const SizedBox.shrink();
  }

  /// 玻璃 tab 栏（2026-11-07 参考图定稿）：60px 高、左右 10px、底部 9px、
  /// 圆角 30；4 个等宽热区，选中仅图标变亮（无圆底）。
  Widget _buildBottomBar(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: 9),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(30),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
            child: Container(
              height: 60,
              padding: const EdgeInsets.symmetric(horizontal: 2),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(30),
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: dark
                      ? <Color>[
                          // 与参考图同色：近黑中性灰玻璃（页面底 #171717
                          // 叠加后约 #141414），不是纯黑。
                          const Color(0xFF161616).withValues(alpha: 0.86),
                          const Color(0xFF101010).withValues(alpha: 0.92),
                        ]
                      : <Color>[
                          Colors.white.withValues(alpha: 0.62),
                          Colors.white.withValues(alpha: 0.40),
                        ],
                ),
                border: dark
                    ? null
                    : Border.all(
                        color: p.divider.withValues(alpha: 0.9),
                        width: 1,
                      ),
              ),
              // 暗色不叠整条顶部高光：只留内侧边缘的呼吸灰光，
              // 否则顶部会多出一条偏亮的横向光带（看起来脏、不干净）。
              foregroundDecoration: dark
                  ? null
                  : BoxDecoration(
                      borderRadius: BorderRadius.circular(30),
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: <Color>[
                          Colors.white.withValues(alpha: 0.55),
                          Colors.white.withValues(alpha: 0.00),
                          Colors.black.withValues(alpha: 0.04),
                        ],
                        stops: const <double>[0, 0.55, 1],
                      ),
                    ),
              child: AnimatedBuilder(
                animation: _glowAnim,
                builder: (BuildContext context, Widget? child) {
                  final double t =
                      Curves.easeInOutSine.transform(_glowAnim.value);
                  // 呼吸灯向内：灰光贴着胶囊内侧边缘，缓慢明暗并向内淡出。
                  return CustomPaint(
                    painter: dark
                        ? _InnerRimGlowPainter(alpha: 0.07 + 0.05 * t)
                        : null,
                    child: child,
                  );
                },
                child: Row(
                  children: <Widget>[
                    for (int i = 0; i < 4; i++)
                      Expanded(
                        child: _TabItem(
                          kind: MobileLineIconKind.values[i],
                          selected: _tabIndex == i,
                          showLiveBadge:
                              i == 0 && _chatController.isSideChatActive,
                          p: p,
                          onTap: () => _switchTab(i),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 胶囊内侧灰色柔光（向内呼吸灯）：从边缘向内多圈描边逐圈减淡。
///
/// 用多层细描边而不是 maskFilter 模糊——Impeller 下离屏模糊容易出色块。
class _InnerRimGlowPainter extends CustomPainter {
  _InnerRimGlowPainter({required this.alpha});

  /// 贴边处的最大不透明度（呼吸动画驱动 0.07 → 0.12）。
  final double alpha;

  @override
  void paint(Canvas canvas, Size size) {
    final RRect outer = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(30),
    );
    const int steps = 12;
    final Paint paint = Paint()..style = PaintingStyle.stroke;
    for (int i = 0; i < steps; i++) {
      // 越靠边越亮、越往里越淡，8px 内衰减到 0。
      final double k = 1.0 - i / steps;
      paint
        ..strokeWidth = 0.9
        ..color = Colors.white.withValues(alpha: alpha * k * k);
      canvas.drawRRect(outer.deflate(0.45 + i * 0.65), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _InnerRimGlowPainter oldDelegate) =>
      oldDelegate.alpha != alpha;
}

/// 单个 tab 热区：42px 定宽命中区 + 22px 自绘图标（与参考图比例对齐）。
///
/// 注意：外层必须是定高 SizedBox——Center 在松约束下会撑满父级可用高度，
/// 会把整个 bottomNavigationBar 撑到全屏、正文区高度归零（0 高 bug 教训）。
class _TabItem extends StatelessWidget {
  const _TabItem({
    required this.kind,
    required this.selected,
    required this.p,
    required this.onTap,
    this.showLiveBadge = false,
  });

  final MobileLineIconKind kind;
  final bool selected;
  final bool showLiveBadge;
  final MobilePalette p;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color color = selected
        ? (dark ? const Color(0xFFE8E9EE) : p.textPrimary)
        : (dark
            ? const Color(0xFF737782)
            : p.textMuted.withValues(alpha: 0.78));
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        // 点击不再出现水波纹/高光：玻璃胶囊上叠白色 ripple 会像一团发光特效。
        splashFactory: NoSplash.splashFactory,
        highlightColor: Colors.transparent,
        hoverColor: Colors.transparent,
        focusColor: Colors.transparent,
        child: SizedBox(
          height: 60,
          child: Center(
            // 选中态只换图标颜色，不再叠圆底/描边/投影：
            // 玻璃胶囊上半透明圆盘 + 黑投影会糊成一团脏色块。
            child: SizedBox(
              width: 42,
              height: 42,
              child: Stack(
                alignment: Alignment.center,
                children: <Widget>[
                  MobileLineIcon(
                    kind: kind,
                    size: 22,
                    color: color,
                  ),
                  if (showLiveBadge)
                    Positioned(
                      top: 1,
                      right: 1,
                      child: Container(
                        width: 5,
                        height: 5,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: p.online,
                          boxShadow: <BoxShadow>[
                            BoxShadow(
                              color: p.online.withValues(alpha: 0.6),
                              blurRadius: 5,
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
