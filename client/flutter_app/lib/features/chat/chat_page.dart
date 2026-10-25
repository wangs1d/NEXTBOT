import "package:flutter/foundation.dart"
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/gestures.dart" show Drag;
import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show ScrollCacheExtent;
import "package:flutter/services.dart";
import "dart:async";

import "../../core/models/chat_models.dart";
import "../../core/models/turn_state.dart";
import "../../core/db/local_history_store.dart";
import "../../core/presentation/agent_avatar_catalog.dart";
import "../../core/presentation/voice_call_ui_labels.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/content_summary_parser.dart";
import "../../core/services/speech_service.dart";
import "../../core/services/image_preview_launcher.dart";
import "../../core/theme/app_typography.dart";
import "../../core/theme/app_theme.dart";
import "agent_home_page.dart";
import "agent_profile_page.dart" show AgentProfileData;
import "media_disk_cache.dart";
import "voice_message_bubble.dart";
import "message_body_renderer.dart";
import "agent_result_card.dart";
import "evening_digest_card.dart";
import "plan_steps_card.dart";
import "typewriter_reveal.dart";
import "mood_driven_emotion_ball.dart";
import "chat_suggestions.dart";
import "utterance_grouping.dart";
import "../../core/services/profile_manage_api.dart";
import "../../core/services/account_profile_api.dart";
import "../../core/presentation/emotion_ball_ids.dart";
import "../../core/utils/chat_time_label.dart";

/// 输入框内图标按钮的视觉强度
/// - muted：默认（onSurfaceVariant 色），用于次要功能
/// - primary：主色 + 弱容器背景，用于需要被一眼找到的入口
enum InputIconTone { muted, primary }

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.messages,
    required this.controller,
    required this.onSend,
    this.agentName,
    this.agentAvatarUrl,
    this.userAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.agentProfile,
    this.onOpenAgentProfile,
    this.galleryPendingImages = const <Uint8List>[],
    this.onPickGalleryImage,
    this.onRemoveGalleryImage,
    this.resolveUserGalleryImages,
    this.failedUserMessageIds = const <String>{},
    this.isAgentProcessing = false,
    this.agentStatusLine,
    this.agentStatusPercent,

    /// 当前正在调用的工具名（`tool.call` 置位、`tool.result`/收尾清空）。
    /// 非空时在输入框左上角渲染「球形图标 + 正在调用:xxx」徽标。
    this.currentToolName,

    /// 「分阶段异步对话交互」阶段一文本：在多步/工具型请求开始时显示的
    /// 即时确认应答（如「好的，让我查一下…」），real chunk 抵达后由父组件清空。
    this.interimAckText,

    /// 「分阶段异步对话交互 v2」结构化状态：null 时退回 v1 思考气泡。
    this.turnState,

    /// 跨轮常驻的任务步骤（plan.* 的可见面）：与 turnState 的差别是不随轮次
    /// 销毁——「等用户操作」通常发生在一轮结束之后。
    this.planSteps = const <TurnPlanStep>[],
    this.onOpenPhoneDialer,
    this.inputFocusNode,
    this.isActive = true,

    /// 删除单条消息的回调（传入 messageId）
    this.onDeleteMessage,

    /// 删除从某条消息起之后所有消息的回调（传入 messageId）
    this.onDeleteFromMessage,

    /// 停止当前 agent 处理（由输入框的发送按钮在处理中态触发）
    this.onStopAgent,

    /// 「选择型卡片」按钮点击回调(可选;null 时仅在 UI 上锁定按钮)
    this.onUserAction,

    /// 光球头像单击 → 打开 Agent 主页（桌面宽屏走右侧双栏面板；
    /// null 时退化为全屏路由页，供移动端/未接线调用方兜底）
    this.onOpenAgentHome,

    /// 后台进行中的任务数（任务面回执聚合，状态带展示「N 个任务后台进行中」）
    this.backgroundTaskCount = 0,

    /// 取消后台任务回调（回执 hover 取消按钮；null 时仅展示无取消入口）
    this.onCancelBackgroundTask,

    /// 对话流决策卡「确认/忽略」回调（传入 messageId；main.dart 据卡内
    /// kind 回传 attention ack / proactive outcome 并原地翻转卡片状态）
    this.onConfirmDecisionCard,

    /// 当前仍在排队、等待 Agent 依次处理的用户消息 id 集合。
    /// 命中的用户气泡在时间行显示「排队中」徽标，服务端开始处理该条
    /// （chat.turn_started 晋级）后由父组件移出集合，徽标随之消失。
    this.queuedMessageIds = const <String>{},

    /// 父级聚合的 Agent 空闲态：非处理中、无工具调用、无后台任务。
    /// 「为你推荐」横滑条仅在空闲时出现，忙碌时隐藏（位置让给状态条）。
    this.agentIdle = true,

    /// 本地历史存储：「为你推荐」出现时机治理（频控/已知能力集合）的
    /// 持久化通道；null 时横滑条退化为纯内存治理。
    this.localStore,
  });

  final List<ChatMessage> messages;
  final TextEditingController controller;
  final FocusNode? inputFocusNode;
  final VoidCallback onSend;

  /// 父级聚合的 Agent 空闲态：非处理中、无工具调用、无后台任务。
  /// 「为你推荐」横滑条仅在空闲时出现，忙碌时隐藏（位置让给状态条）。
  final bool agentIdle;

  /// 本地历史存储：「为你推荐」出现时机治理（频控/已知能力集合）的
  /// 持久化通道；null 时横滑条退化为纯内存治理。
  final LocalHistoryStore? localStore;

  /// 用户在「选择型卡片」底部按钮上点击某个 action 的回调。
  /// 父级负责把 action 转成 user message 并发送到后端。
  /// 传 null 时,卡片按钮点击仅在 UI 上锁定,不会触发任何副作用(调试用)。
  /// 回调会携带触发该按钮的卡片 [cardData](含 cardId/title/items),
  /// 供后端做精准审计/埋点,并让 Agent 理解上下文主动衔接。
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 用户给agent起的名字
  final String? agentName;
  final String? agentAvatarUrl;

  /// 当前用户头像的绝对 URL（main.dart 注入；null=未设置走缺省灰球）。
  final String? userAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final AgentProfileData? agentProfile;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;

  /// 光球头像单击 → 打开 Agent 主页（桌面宽屏走右侧双栏面板；
  /// null 时退化为全屏路由页，供移动端/未接线调用方兜底）。
  final VoidCallback? onOpenAgentHome;

  /// 已选相册图（待发）的字节：输入框上方渲染缩略图，让用户确认到底选了哪些图。
  final List<Uint8List> galleryPendingImages;
  final VoidCallback? onPickGalleryImage;

  /// 移除某一张待发相册图（缩略图右上角 ×）。
  final void Function(int index)? onRemoveGalleryImage;

  /// 按 messageId 取本会话内已发送用户消息的配图字节（内存态）。
  /// 返回 null/空时气泡回退为「配图 ×N」文案（历史加载的消息没有字节）。
  final List<Uint8List>? Function(String messageId)? resolveUserGalleryImages;

  /// 发送失败（WS 未就绪被拒）的用户消息 id 集合，气泡头部显示「未发出」徽标。
  final Set<String> failedUserMessageIds;

  /// Agent是否正在处理中（流式输出）
  final bool isAgentProcessing;

  /// `chat.agent_status` 推送的口语化进度，优先于固定「思考中」
  final String? agentStatusLine;

  /// `chat.agent_status` 携带的进度百分比（0-90，长工具心跳）。
  /// 非 null 时处理中气泡下方渲染进度条。
  final int? agentStatusPercent;

  /// 当前正在调用的工具名；非空时输入框左上角渲染当前工具徽标。
  final String? currentToolName;

  /// `chat.assistant_interim` 推送的即时确认应答（生命周期更短：real chunk 一到就清空）
  final String? interimAckText;

  /// 「分阶段异步对话交互 v2」结构化状态机；null 表示 v1 链路
  final TurnState? turnState;

  /// 跨轮常驻的任务步骤（plan.* 写入的会话级计划）
  final List<TurnPlanStep> planSteps;

  /// 呼叫 Agent（App 内无需另输 6 位联络号）
  final VoidCallback? onOpenPhoneDialer;

  /// 当前 Tab 是否激活（用于检测从其他 Tab 切回对话页）
  final bool isActive;

  /// 删除单条消息
  final void Function(String messageId)? onDeleteMessage;

  /// 删除从某条消息起之后所有消息
  final void Function(String messageId)? onDeleteFromMessage;

  /// 停止当前 agent 处理（由输入框的发送按钮在处理中态触发）
  final VoidCallback? onStopAgent;

  /// 后台进行中的任务数（任务面回执聚合）
  final int backgroundTaskCount;

  /// 取消后台任务回调（回执 hover 取消按钮）
  final void Function(String taskId)? onCancelBackgroundTask;

  /// 对话流决策卡「确认/忽略」回调（传入 messageId）
  final void Function(String messageId, bool confirmed)? onConfirmDecisionCard;

  /// 当前仍在排队、等待 Agent 依次处理的用户消息 id 集合（父组件维护）
  final Set<String> queuedMessageIds;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage>
    with SingleTickerProviderStateMixin {
  final SpeechService _speechService = SpeechService();
  final bool _isListening = false;
  final String _recognizedText = "";
  final ScrollController _scrollController = ScrollController();

  /// 全局删除选择模式状态
  bool _deleteSelectionMode = false;

  /// 触发删除的消息 ID（用户提问或 Agent 回复均可；确认栏渲染在它下方）
  String? _deleteTriggerMessageId;

  /// 待删除态下被预选的消息 ID 集合 = 被点气泡所属的整轮问答对
  final Set<String> _selectedMessageIds = <String>{};

  /// 进入删除待确认态：把被点气泡所属的整轮问答对预选并高亮，
  /// 确认栏渲染在被点的那条消息下方。
  void _enterDeleteMode(String messageId) {
    setState(() {
      _deleteSelectionMode = true;
      _deleteTriggerMessageId = messageId;
      _selectedMessageIds.clear();
      _selectedMessageIds.addAll(_getRelatedMessageIds(messageId));
    });
  }

  /// 确认删除：按「轮」提交，同一轮只触发一次删除。
  ///
  /// 删除单位是整轮问答对，而选中集合里可能同时含这一轮的多条气泡（用户提问 +
  /// 若干 Agent 回复）。逐条提交会把同一轮重复删 N 遍（N 次网络请求 + N 次
  /// 本地 store 删除）。这里先把每条选中气泡归约到它所属轮次的锚点（user 消息
  /// id）去重，再按锚点提交一次。
  void _confirmDeleteSelection() {
    if (_selectedMessageIds.isEmpty || widget.onDeleteMessage == null) return;

    final List<String> turnAnchors = <String>[];
    for (final String mid in _selectedMessageIds) {
      final List<String> related = _getRelatedMessageIds(mid);
      // 关联列表首元素即本轮的 user 消息（轮次锚点）；取不到时退化为自身
      final String anchor = related.isEmpty ? mid : related.first;
      if (!turnAnchors.contains(anchor)) {
        turnAnchors.add(anchor);
      }
    }

    for (final String anchor in turnAnchors) {
      widget.onDeleteMessage!(anchor);
    }

    setState(() {
      _deleteSelectionMode = false;
      _deleteTriggerMessageId = null;
      _selectedMessageIds.clear();
    });
  }

  /// 取消删除选择模式
  void _cancelDeleteMode() {
    setState(() {
      _deleteSelectionMode = false;
      _deleteTriggerMessageId = null;
      _selectedMessageIds.clear();
    });
  }

  /// 滚动状态使用 ValueNotifier，避免 setState 触发整树重建导致掉帧
  final ValueNotifier<bool> _isUserScrollingNotifier =
      ValueNotifier<bool>(false);
  bool _hasNewAgentMessage = false;
  AnimationController? _breathingController;
  Animation<double>? _breathingAnimation;

  bool _hasHadMessages = false; // 是否已经加载过消息（用于区分初始加载和后续新消息）

  /// ====== 滚动位置保持相关 ======
  bool _isTabActive = false; // 当前是否在对话 Tab 上（用于屏蔽非活跃时的自动滚动）
  // 在 initState 中从 widget.isActive 同步初始值
  double? _savedScrollPosition; // 离开时保存的滚动像素位置
  double? _savedMaxScrollExtent; // 离开时的最大可滚动距离
  bool _hasSavedPosition = false; // 是否有已保存的有效位置可供恢复
  // （应用重启后自然重置为 false → 滚到底部）
  bool _isRestoringPosition = false; // 恢复锁：正在恢复位置时阻止所有自动滚动
  bool _isAutoScrolling = false; // 自动滚动动画进行中标记：防止流式更新打断滚动导致底部抖动

  /// 图片预览锚点（内容锚点）：点击图片打开右侧面板前，记录「被点照片」
  /// 的渲染盒及其相对视口顶边的距离；面板打开会改变聊天分栏宽度，消息
  /// 条目重新排版后「绝对像素偏移」不再对应照片位置（长会话下漂移可达
  /// 数千像素，表现为列表直接跳到底部），这里改为逐帧把照片拉回原视口位置。
  RenderBox? _previewAnchorBox;
  double? _previewAnchorTopInViewport;

  /// 点击时的像素偏移：照片渲染盒被回收（条目滚出 cacheExtent）时的兜底。
  double? _previewAnchorPixels;
  int _previewAnchorStableFrames = 0;
  int _previewAnchorFrames = 0;

  /// 校正会话的帧数上限（约 2.5s），防止布局持续变化时永久循环。
  static const int _previewAnchorMaxFrames = 150;

  /// 锚点校正会话是否进行中（期间屏蔽自动滚动与「用户滚动」误判）。
  bool get _isPreviewAnchorActive =>
      _previewAnchorPixels != null || _previewAnchorBox != null;

  /// 贴底容差（px）：像素小于此值视为「停在最新消息处」，自动跟底仍生效。
  static const double _stickToBottomEpsilon = 24;

  /// 指针按住拖动进行中（`ScrollStartNotification.dragDetails != null`）。
  bool _isUserDragging = false;

  /// 用户已接管视口：滚轮 / 右侧滚动条滑块 / 拖动把视图带离底部后置真，
  /// 期间所有自动跳底逻辑让路，直到用户滚回贴底区或点「滚到底部」按钮。
  /// 之所以单独记这个标记而不是只看 `isScrollingNotifier`：滚动条滑块拖拽走
  /// `position.jumpTo`，既不置 `isScrollingNotifier` 也不发 `UserScrollNotification`，
  /// 只有「非程序性像素变化」能认出它。
  bool _userTookOverViewport = false;

  /// 右侧滑块拖拽热区宽度（px）。滚动条本体 8px 左右，这里放宽到 14px 便于按住。
  static const double _scrollbarGrabWidth = 14;

  /// 滑块拖拽换算比例（内容像素 / 指针像素），按下瞬间固化。
  double _thumbDragScale = 1;

  /// 滑块拖拽会话（由 `ScrollPosition.drag` 创建，走标准滚动通知链路）。
  Drag? _thumbDrag;

  // 预定义常量 - 减少重复创建对象
  /// 聊天内容列（消息流 + 输入区）的最大宽度：宽屏下共同居中收敛，
  /// 避免长文本横向铺满整个窗口。
  static const double _contentMaxWidth = 860;

  /// 空态居中问候语（豆包式，无对话/工作分栏）：称呼 + 俏皮尾句；
  /// 称呼取不到（新用户/跳过向导/接口失败）时退化为不带称呼。
  static const String _emptyGreetingTail = "今天想搞点什么？";
  static Future<String>? _appellationFuture;

  String _appellation = "";
  Timer? _appellationRetry;

  /// 首启向导存的称呼（画像事实 field=称呼）。
  /// 用户自己填的名字不做得体化（「老王」就是老王，不是王先生）。
  Future<void> _loadAppellation() async {
    final String name = await (_appellationFuture ??= _fetchAppellation());
    if (!mounted || _appellation.isNotEmpty) return;
    if (name.isEmpty) {
      // 拉空不缓存负结果：冷启动早期登录身份可能尚未武装/服务瞬时失败，
      // 5s 后重试（仅空态期间有意义，发了消息就不再刷）。
      _appellationRetry?.cancel();
      _appellationRetry = Timer(const Duration(seconds: 5), () {
        if (!mounted || _appellation.isNotEmpty || widget.messages.isNotEmpty) {
          return;
        }
        _appellationFuture = null;
        _loadAppellation();
      });
      return;
    }
    setState(() => _appellation = name);
  }

  static Future<String> _fetchAppellation() async {
    try {
      final ProfileManageData? data = await ProfileManageApi().fetch();
      if (data == null) return "";
      for (final ProfileFactItem f in data.facts) {
        if (f.field == "称呼" && f.value.trim().isNotEmpty) {
          // 与简报卡同源同一硬规则（问候绝不直呼大名）：「王铭川」→「王先生」；
          // 已是称呼（王哥/老王/Tony…）原样返回。
          return politeDisplayName(f.value.trim());
        }
      }
    } catch (_) {
      // 拉不到就不带称呼，问候照常
    }
    return "";
  }

  static const EdgeInsets _listPadding =
      EdgeInsets.symmetric(horizontal: 12, vertical: 4);
  static const EdgeInsets _cardPadding = EdgeInsets.all(7);
  static const EdgeInsets _inputHorizontalPadding =
      EdgeInsets.symmetric(horizontal: 12, vertical: 6);

  @override
  void initState() {
    super.initState();
    // Windows SAPI 在启动阶段预初始化会触发原生崩溃 (0xC0000409)，改为用户点麦克风时按需初始化
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.windows) {
      _speechService.initialize();
    }
    // 空态问候语的称呼：取首启向导存的画像事实（field=称呼），进程内只查一次
    _loadAppellation();
    // 初始化呼吸动画：agent 工作中输入框的白色光晕靠这个 0~1 的脉动驱动，
    // 周期压到 1.6s 让呼吸感更明显。
    _breathingController = AnimationController(
      duration: const Duration(milliseconds: 1600),
      vsync: this,
    )..repeat(reverse: true);
    _breathingAnimation = Tween<double>(
      begin: 0.0,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: _breathingController!,
      curve: Curves.easeInOut,
    ));
    // 监听滚动：检测用户是否在手动滚动
    _scrollController.addListener(_onScroll);
    // 图片预览打开前记录滚动锚点，避免打开右侧面板后列表跳到最底部
    ImagePreviewLauncher.beforeOpen = _savePreviewAnchor;
    // 同步初始 Tab 激活状态（关键：必须与 widget.isActive 一致，否则首次切走时保存会被跳过）
    _isTabActive = widget.isActive;
    // 注意：ListView 使用 reverse=true，天然从底部开始渲染，无需 jumpTo
  }

  /// 滚动到底部的通用方法（reverse 模式下 bottom = pixels 0）
  void _scrollToBottom({bool instant = false}) {
    if (!_scrollController.hasClients) return;
    // 已有自动滚动动画进行中时直接忽略，避免流式回答期间反复调用
    // 打断上一次动画、从当前位置重新启动，造成底部气泡上下抖动的现象。
    if (_isAutoScrolling) return;
    // 图片预览锚点校正中不抢滚动，否则会把视图从照片位置拽回底部
    if (_isPreviewAnchorActive) return;
    // 用户已接管视口（滚轮上滑、拖右侧滚动条滑块）或正按住拖动时绝不抢滚动：
    // 流式输出期间每条 SSE 都会排一次 postFrame 跟底，与指针输入互相拉扯，
    // 表现为「拖动不跟手、忽上忽下」。
    if (_userTookOverViewport || _isUserDragging) return;
    if (_scrollController.position.isScrollingNotifier.value) return;
    // reverse 模式下，pixels=0 就是列表底部（最新消息处）
    // instant 时直接 jumpTo(0)，非 instant 用短动画过渡
    if (instant) {
      _scrollController.jumpTo(0);
      return;
    }
    if (_scrollController.position.pixels <= 1) return; // 已贴近底部，无需滚动
    _isAutoScrolling = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 排帧与实际执行之间，用户可能已按住滑块或滚动，执行前再确认一次
      if (!_scrollController.hasClients ||
          _scrollController.position.pixels <= 1 ||
          _userTookOverViewport ||
          _isUserDragging) {
        _isAutoScrolling = false;
        return;
      }
      _scrollController
          .animateTo(
            0,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          )
          .whenComplete(() => _isAutoScrolling = false);
    });
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    // 锚点校正期间的程序性 jumpTo 不算用户滚动（否则会误亮「滚到底部」
    // 悬浮按钮，并压制后续正常的新消息自动滚动判断）
    if (_isPreviewAnchorActive) return;
    // reverse 模式下：pixels=0 是底部（最新消息），pixels 越大越靠近顶部（最旧消息）
    final double currentScroll = _scrollController.position.pixels;

    // 使用 ValueNotifier 更新，避免触发 setState 导致整树重建和掉帧
    // pixels > 100 表示用户从底部向上滑动了超过 100px
    final bool shouldMarkScrolling = (currentScroll > 100);
    if (_isUserScrollingNotifier.value != shouldMarkScrolling) {
      _isUserScrollingNotifier.value = shouldMarkScrolling;
      if (!shouldMarkScrolling) {
        // 滚回底部时清除新消息标记（仅更新局部状态）
        _hasNewAgentMessage = false;
      }
    }
  }

  /// 滚动通知 → 维护「用户是否已接管视口」。
  ///
  /// 判定依据：只要不是本页自己发起的滚动（跟底动画 / Tab 恢复 / 预览锚点
  /// 校正）引起的像素变化，就是用户输入（滚轮、触摸板、右侧滚动条滑块）。
  /// 滑块拖拽必须这样认，因为它内部用 `position.jumpTo`，既不点亮
  /// `isScrollingNotifier` 也不发 `UserScrollNotification`。
  /// 返回 false：只旁听，不消费通知。
  bool _handleScrollNotification(ScrollNotification notification) {
    // 只认本列表自己的滚动：气泡内的横向图片轮播等嵌套滚动视图的通知
    // depth 会 >= 1（穿过一层视口），不能算成用户在拖主列表。
    if (notification.depth != 0) return false;
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      _isUserDragging = true;
    } else if (notification is ScrollEndNotification) {
      _isUserDragging = false;
    }
    if (_isAutoScrolling || _isRestoringPosition || _isPreviewAnchorActive) {
      return false;
    }
    _userTookOverViewport = notification.metrics.pixels > _stickToBottomEpsilon;
    return false;
  }

  /// 滑块长度占轨迹的比例 = 可见比例；由此反推「拖动 1px 指针 = 移动多少内容像素」。
  ///
  /// SDK 自带的滑块拖拽（`RawScrollbarState._getPrimaryDelta`）是绝对映射：
  /// `getTrackToScroll(按下时的滑块位置 + 指针位移)`，其中
  /// `getTrackToScroll(x) = 总高 × x ÷ (轨迹长 − 滑块长)`——**分母每帧按最新
  /// metrics 重算**。可是拖动期间视口高度和懒加载估算的总高都在变（实测视口
  /// 512→400、总高抖 ±45px），同一个指针位置于是对应到完全不同的偏移，超出
  /// `maxScrollExtent` 的部分被 clamp——表现为拖到中间突然窜到列表最顶、
  /// 拖动过程中来回漂。这里改为按下时算一次比例、拖动期间不再重算。
  double _computeThumbDragScale(ScrollPosition position) {
    final double range = position.maxScrollExtent - position.minScrollExtent;
    final double track = position.viewportDimension;
    if (range <= 0 || track <= 0) return 1;
    final double movable = track * range / (range + track);
    if (movable <= 0) return 1;
    return range / movable;
  }

  void _onThumbDragStart(DragStartDetails details) {
    if (!_scrollController.hasClients) return;
    final ScrollPosition position = _scrollController.position;
    if (position.maxScrollExtent <= position.minScrollExtent) return;
    _thumbDragScale = _computeThumbDragScale(position);
    // 立刻认领：`position.drag` 会打断进行中的跟底动画，首帧起就压住自动滚动
    _isUserDragging = true;
    _userTookOverViewport = position.pixels > _stickToBottomEpsilon;
    _thumbDrag = position.drag(details, () => _thumbDrag = null);
  }

  void _onThumbDragUpdate(DragUpdateDetails details) {
    final Drag? drag = _thumbDrag;
    if (drag == null) return;
    // `ScrollDragController` 的 primaryDelta 是「内容像素增量」，反向列表
    // （axisDirection.up）里内容像素增量 = −指针纵向位移 × 比例。
    final double scaled = -details.delta.dy * _thumbDragScale;
    drag.update(DragUpdateDetails(
      globalPosition: details.globalPosition,
      localPosition: details.localPosition,
      delta: Offset(0, scaled),
      primaryDelta: scaled,
    ));
  }

  void _onThumbDragEnd(DragEndDetails details) {
    // 桌面滑块拖拽松手即停，不接力惯性（也避开反向列表速度符号的换算）
    _thumbDrag?.end(DragEndDetails(primaryVelocity: 0));
    _thumbDrag = null;
    _isUserDragging = false;
  }

  void _onThumbDragCancel() {
    _thumbDrag?.cancel();
    _thumbDrag = null;
    _isUserDragging = false;
  }

  /// ====== 图片预览滚动锚点（内容锚点版） ======
  ///
  /// 打开右侧图片预览面板时聊天分栏宽度变化，消息条目重新排版，「打开前
  /// 的像素偏移」不再对应照片位置。这里改为锚定被点照片本身：
  /// 1. 打开前：从点击处 context 校验照片确实在本聊天列表内，记录照片
  ///    渲染盒、照片顶边相对视口顶边的距离、当前像素偏移；
  /// 2. 打开后：逐帧读取照片当前视口位置，按差值 jumpTo(pixels - delta)
  ///    （reverse 列表：照片视觉下移 delta 时像素应减 delta），直到连续
  ///    3 帧稳定或超出帧数上限；照片渲染盒被回收时退回像素级兜底。
  void _savePreviewAnchor(
      ImagePreviewSnapshot item, BuildContext? anchorContext) {
    if (!_scrollController.hasClients) return;
    _previewAnchorPixels = _scrollController.position.pixels;
    _previewAnchorBox = null;
    _previewAnchorTopInViewport = null;

    if (anchorContext == null) {
      _schedulePreviewAnchorRestore();
      return;
    }

    // 校验被点照片位于本聊天列表的 Scrollable 内（弹层/独立面板里的
    // 图片不在消息流中，内容锚点无意义，走像素兜底）。向上遍历祖先时
    // 跳过气泡内部的横向轮播等子滚动视图（controller 不匹配）。
    ScrollableState? listScrollable;
    anchorContext.visitAncestorElements((Element ancestor) {
      if (ancestor is StatefulElement && ancestor.state is ScrollableState) {
        final ScrollableState state = ancestor.state as ScrollableState;
        if (state.widget.controller == _scrollController) {
          listScrollable = state;
          return false;
        }
      }
      return true;
    });
    final RenderObject? viewportRo = listScrollable?.context.findRenderObject();
    final RenderObject? tapRo = anchorContext.findRenderObject();
    if (viewportRo is RenderBox &&
        viewportRo.attached &&
        tapRo is RenderBox &&
        tapRo.attached &&
        tapRo.hasSize) {
      final double tapTop = tapRo.localToGlobal(Offset.zero).dy;
      final double vpTop = viewportRo.localToGlobal(Offset.zero).dy;
      _previewAnchorBox = tapRo;
      _previewAnchorTopInViewport = tapTop - vpTop;
    }
    _schedulePreviewAnchorRestore();
  }

  void _schedulePreviewAnchorRestore() {
    _previewAnchorStableFrames = 0;
    _previewAnchorFrames = 0;
    // 面板 setState 触发的重新布局发生在下一帧，之后逐帧校正
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _restorePreviewAnchor());
  }

  void _restorePreviewAnchor() {
    if (!mounted || !_isPreviewAnchorActive) {
      _endPreviewAnchorSession();
      return;
    }
    // 用户按住列表拖动时放弃锚点校正：逐帧 jumpTo 会和指针互相抢滚动
    if (_isUserDragging) {
      _endPreviewAnchorSession();
      return;
    }
    if (++_previewAnchorFrames > _previewAnchorMaxFrames) {
      _endPreviewAnchorSession();
      return;
    }
    if (!_scrollController.hasClients) {
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _restorePreviewAnchor());
      return;
    }

    final RenderBox? box = _previewAnchorBox;
    final double? anchorTop = _previewAnchorTopInViewport;
    if (box == null || !box.attached || anchorTop == null) {
      // 内容锚点失效（弹层图片 / 渲染盒已随条目被回收）：像素级兜底恢复
      final double? fallback = _previewAnchorPixels;
      if (fallback != null) {
        final double p =
            fallback.clamp(0.0, _scrollController.position.maxScrollExtent);
        if ((_scrollController.position.pixels - p).abs() > 2) {
          _scrollController.jumpTo(p);
        }
      }
      _endPreviewAnchorSession();
      return;
    }

    final RenderObject? viewportRo =
        _scrollController.position.context.storageContext.findRenderObject();
    if (viewportRo is! RenderBox || !viewportRo.attached) {
      _endPreviewAnchorSession();
      return;
    }

    final double currentTop = box.localToGlobal(Offset.zero).dy -
        viewportRo.localToGlobal(Offset.zero).dy;
    final double delta = currentTop - anchorTop;
    if (delta.abs() < 0.5) {
      // 连续 3 帧无漂移 → 布局已收敛，结束校正
      if (++_previewAnchorStableFrames >= 3) {
        _endPreviewAnchorSession();
        return;
      }
    } else {
      _previewAnchorStableFrames = 0;
      final double target = (_scrollController.position.pixels - delta)
          .clamp(0.0, _scrollController.position.maxScrollExtent);
      _scrollController.jumpTo(target);
    }
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _restorePreviewAnchor());
  }

  /// 结束锚点校正会话；结束时按当前位置同步「用户滚动」标记，
  /// 避免校正期间的程序性滚动让流式自动滚动误判而把视图拽回底部。
  void _endPreviewAnchorSession() {
    _previewAnchorBox = null;
    _previewAnchorTopInViewport = null;
    _previewAnchorPixels = null;
    _previewAnchorStableFrames = 0;
    _previewAnchorFrames = 0;
    if (_scrollController.hasClients) {
      _isUserScrollingNotifier.value = _scrollController.position.pixels > 100;
    }
  }

  @override
  void didUpdateWidget(covariant ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);

    // ====== 优先处理 Tab 切换（离开 / 进入） ======
    final bool wasActive = _isTabActive;
    final bool nowActive = widget.isActive;

    // 离开对话 Tab → 保存位置
    if (wasActive && !nowActive) {
      debugPrint(
          '[ChatScroll] 👋 离开对话Tab: wasActive=$wasActive → nowActive=$nowActive');
      _isTabActive = false;
      _saveScrollPosition();
      return; // 离开后不再处理消息相关滚动
    }

    // 进入（或切回）对话 Tab → 恢复位置或滚到底部
    if (!wasActive && nowActive) {
      debugPrint(
          '[ChatScroll] 🏠 进入对话Tab: wasActive=$wasActive → nowActive=$nowActive, hasSaved=$_hasSavedPosition, savedPixels=$_savedScrollPosition');
      _isTabActive = true;
      _restoreOrScrollToBottom();
      return; // 刚进入时跳过后续消息增量滚动逻辑
    }

    // ====== 以下逻辑仅在活跃状态下执行（防止非活跃时被新消息覆盖位置） ======
    if (!_isTabActive) return;

    // 恢复锁：正在恢复位置时，跳过所有自动滚动逻辑，防止被后续 didUpdateWidget 调用覆盖
    if (_isRestoringPosition) {
      debugPrint(
          '[ChatScroll] ⛔ 恢复锁生效：跳过自动滚动 (messages=${widget.messages.length}, old=${oldWidget.messages.length})');
      return;
    }

    // 消息数量未变化时，检查是否需要因流式更新而滚动
    final bool messagesUnchanged =
        widget.messages.length == oldWidget.messages.length;
    if (messagesUnchanged) {
      // Agent 正在流式输出（消息文本在增长），且用户没有主动上滑 → 跟踪到底部
      if (widget.isAgentProcessing &&
          !_isUserScrollingNotifier.value &&
          !_userTookOverViewport &&
          !_isUserDragging) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
      return;
    }

    // 检测是否有新的用户消息
    final bool hasNewUserMessage =
        widget.messages.length > oldWidget.messages.length &&
            widget.messages.isNotEmpty &&
            widget.messages.last.role == "user";

    // 用户发送消息时，无论是否在滑动，都自动滚动到底部
    if (hasNewUserMessage) {
      _userTookOverViewport = false;
      _isUserScrollingNotifier.value = false;
      _hasNewAgentMessage = false;
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      return;
    }

    // 检测是否有新的 agent 消息
    final bool hasNewAgentMessage =
        widget.messages.length > oldWidget.messages.length &&
            widget.messages.isNotEmpty &&
            widget.messages.last.role != "user";

    // 用户在滑动时不自动滚动，标记有新消息
    if (hasNewAgentMessage &&
        (_isUserScrollingNotifier.value || _userTookOverViewport)) {
      _hasNewAgentMessage = true;
      return;
    }

    // 用户没有主动滑动时，自动滚动到底部
    if (widget.messages.length != oldWidget.messages.length) {
      // 用户已接管视口（拖滑块/滚轮看历史）→ 不跳底，只提示有新消息
      if (_userTookOverViewport || _isUserDragging) {
        _hasNewAgentMessage =
            widget.messages.length > oldWidget.messages.length;
        return;
      }
      _isUserScrollingNotifier.value = false;
      _hasNewAgentMessage = false;

      final bool isFirstLoad = !_hasHadMessages && widget.messages.isNotEmpty;
      if (isFirstLoad) _hasHadMessages = true;

      WidgetsBinding.instance
          .addPostFrameCallback((_) => _scrollToBottom(instant: isFirstLoad));
    }
  }

  @override
  void dispose() {
    // 解除图片预览锚点钩子，避免跨页面残留
    if (ImagePreviewLauncher.beforeOpen == _savePreviewAnchor) {
      ImagePreviewLauncher.beforeOpen = null;
    }
    _breathingController?.dispose();
    _speechService.cancel();
    _appellationRetry?.cancel();
    _endPreviewAnchorSession();
    _scrollController.dispose();
    _isUserScrollingNotifier.dispose();
    super.dispose();
  }

  /// ====== 滚动位置保持：保存当前滚动位置 ======
  void _saveScrollPosition() {
    if (!_scrollController.hasClients) {
      debugPrint('[ChatScroll] 💾 保存失败: scrollController 无 client');
      return;
    }
    final double pixels = _scrollController.position.pixels;
    final double maxExtent = _scrollController.position.maxScrollExtent;
    _savedScrollPosition = pixels;
    _savedMaxScrollExtent = maxExtent;
    _hasSavedPosition = true;

    // 埋点：记录滚动位置保存事件（包含位置比例便于分析用户浏览深度）
    final double ratio = maxExtent > 0 ? pixels / maxExtent : 0.0;
    debugPrint(
        '[ChatScroll] 💾 保存位置: pixels=$pixels, maxExtent=$maxExtent, ratio=${ratio.toStringAsFixed(2)}');
    _logScrollEvent(
      action: 'save',
      pixels: pixels,
      maxExtent: maxExtent,
      scrollRatio: ratio,
      messageCount: widget.messages.length,
    );
  }

  /// ====== 滚动位置保持：恢复之前保存的滚动位置（reverse 模式） ======
  void _restoreOrScrollToBottom() {
    // 重置滚动状态
    _userTookOverViewport = false;
    _isUserScrollingNotifier.value = false;
    _hasNewAgentMessage = false;

    // 有已保存的位置 → 恢复到离开时的位置（reverse 模式下 pixels 即为距底部距离）
    if (_hasSavedPosition && _savedScrollPosition != null) {
      final double targetPixels = _savedScrollPosition!;
      debugPrint(
          '[ChatScroll] 🔄 开始恢复位置: targetPixels=$targetPixels, savedMaxExtent=$_savedMaxScrollExtent');

      // 加锁：防止后续 didUpdateWidget 调用中的自动滚动覆盖恢复位置
      _isRestoringPosition = true;
      // 恢复到历史位置＝用户正在看历史，流式跟底不得再把他拽回底部
      _userTookOverViewport = targetPixels > _stickToBottomEpsilon;

      // IndexedStack 切换后需要等待布局完成，用双重 postFrameCallback 保证可靠
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scrollController.hasClients) {
          debugPrint('[ChatScroll] ⚠️ 恢复第1帧: scrollController 无 client');
          return;
        }
        debugPrint(
            '[ChatScroll] 📐 恢复第1帧: maxExtent=${_scrollController.position.maxScrollExtent}, pixels=${_scrollController.position.pixels}');

        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_scrollController.hasClients) {
            debugPrint('[ChatScroll] ⚠️ 恢复第2帧: scrollController 无 client');
            _isRestoringPosition = false; // 解锁
            return;
          }
          final double currentMaxExtent =
              _scrollController.position.maxScrollExtent;
          double restorePixels = targetPixels;

          // clamp 到有效范围
          if (restorePixels > currentMaxExtent) {
            restorePixels = currentMaxExtent;
          }
          if (restorePixels < 0) {
            restorePixels = 0;
          }

          debugPrint(
              '[ChatScroll] ✅ 执行 jumpTo: $restorePixels (目标$targetPixels, 当前max=$currentMaxExtent)');
          _scrollController.jumpTo(restorePixels);

          // 埋点：记录恢复事件
          _logScrollEvent(
            action: 'restore',
            pixels: restorePixels,
            savedPixels: targetPixels,
            maxExtent: currentMaxExtent,
            savedMaxExtent: _savedMaxScrollExtent,
            messageCount: widget.messages.length,
          );

          // 解锁：恢复完成，允许后续自动滚动
          _isRestoringPosition = false;
          debugPrint('[ChatScroll] 🔓 恢复锁已解除');
        });
      });
      return;
    }

    // 无保存位置（首次进入 / 应用重启后）
    debugPrint('[ChatScroll] 🏁 无保存位置，reverse=true 天然在底部');
    // reverse=true 的 ListView 天然从底部开始渲染，无需任何滚动操作
  }

  /// ====== 埋点：记录滚动位置的保存与恢复事件 ======
  void _logScrollEvent({
    required String action,
    double? pixels,
    double? savedPixels,
    double? maxExtent,
    double? savedMaxExtent,
    double? scrollRatio,
    int? messageCount,
  }) {
    // 输出结构化日志供埋点系统采集
    final StringBuffer buf = StringBuffer('[ChatScroll] action=$action');
    if (pixels != null) buf.write(' | pixels=${pixels.toStringAsFixed(1)}');
    if (savedPixels != null) {
      buf.write(' | savedPixels=${savedPixels.toStringAsFixed(1)}');
    }
    if (maxExtent != null) {
      buf.write(' | maxExtent=${maxExtent.toStringAsFixed(1)}');
    }
    if (savedMaxExtent != null) {
      buf.write(' | savedMaxExtent=${savedMaxExtent.toStringAsFixed(1)}');
    }
    if (scrollRatio != null) {
      buf.write(' | scrollRatio=${scrollRatio.toStringAsFixed(3)}');
    }
    if (messageCount != null) buf.write(' | messageCount=$messageCount');
    buf.write(' | timestamp=${DateTime.now().toIso8601String()}');
    debugPrint(buf.toString());
  }

  /// 按时间倒序生成所有消息的渲染项列表（最新在 reverse ListView 的 index 0）。
  /// `assistant_progress`（处理中占位消息）不再进入消息流——处理状态统一由
  /// 输入框上方的状态条呈现（见 [_buildAgentStatusStrip]）。
  /// 相同时间戳用原始下标做 tie-break（倒序）：Dart 的 List.sort 不稳定，
  /// 同毫秒的问答对（如跨端回填轮次）会被随机翻序，出现「回复冒到提问上面」。
  List<Map<String, dynamic>> _getRenderItems() {
    final List<ChatMessage> source = List<ChatMessage>.from(widget.messages)
      ..removeWhere((ChatMessage m) => m.role == "assistant_progress");
    final List<Map<String, Object>> indexed = <Map<String, Object>>[
      for (int i = 0; i < source.length; i++)
        <String, Object>{"m": source[i], "i": i},
    ];
    indexed.sort((Map<String, Object> a, Map<String, Object> b) {
      final int c = (b["m"]! as ChatMessage)
          .timestamp
          .compareTo((a["m"]! as ChatMessage).timestamp);
      if (c != 0) return c;
      return (b["i"]! as int).compareTo(a["i"]! as int);
    });
    return indexed
        .map((Map<String, Object> e) => _messageToGroup(e["m"]! as ChatMessage))
        .toList();
  }

  /// 处理中气泡文案：`agent_status` > 即时确认应答（interim ack）> 历史流程提示 > 默认
  String _processingStatusText([ChatMessage? progressMessage]) {
    final String? live = widget.agentStatusLine?.trim();
    if (live != null && live.isNotEmpty) {
      // 兜底：如果「实时进度」文本和消息列表里最新一条 assistant 回复撞车
      // （模型违反 prompt 把进度句复读进了最终回复），不要把同一行字再渲一份，
      // 直接退化成「正在收尾…」——避免用户看到两份一样的内容同框。
      if (_isLiveStatusDuplicateOfLatestAssistant(live)) {
        return "Agent 正在收尾…";
      }
      return live;
    }
    // 「分阶段异步对话交互」阶段一：实时 agent_status 还没到时，
    // 先用服务端推送的即时确认应答顶上（如「好的，让我查一下…」）。
    final String? interim = widget.interimAckText?.trim();
    if (interim != null && interim.isNotEmpty) {
      return interim;
    }
    final String? progress = progressMessage?.text.trim();
    if (progress != null && progress.isNotEmpty) return progress;
    return "Agent 思考中...";
  }

  /// 实时进度是否和最新一条 assistant 回复文本撞车。
  /// 判定：去掉标点/emoji/空白后做子串包含，任一方向包含即视为重复。
  bool _isLiveStatusDuplicateOfLatestAssistant(String live) {
    String normalize(String s) {
      return s.toLowerCase().replaceAll(
          RegExp(
              r"[\s\.,!?;:\-\u3002\uff0c\uff01\uff1f\u2026\ud83c-\udbff\udc00-\udfff]+"),
          "");
    }

    final String liveKey = normalize(live);
    if (liveKey.isEmpty) return false;
    for (int i = widget.messages.length - 1; i >= 0; i--) {
      final ChatMessage m = widget.messages[i];
      if (m.role == "user") return false; // 越过所有 assistant 都没撞上
      if (m.role != "assistant") continue;
      final String msgKey = normalize(m.text);
      if (msgKey.isEmpty) continue;
      if (msgKey.contains(liveKey) || liveKey.contains(msgKey)) {
        return true;
      }
      return false; // 最新一条 assistant 不撞，剩下的也无需看
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // 发送按钮（常显，有内容时高亮可点击）
  // ═══════════════════════════════════════════════════════════
  Widget _buildSendButton(ColorScheme cs) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: widget.controller,
      builder: (_, TextEditingValue value, __) {
        final bool canSend = value.text.trim().isNotEmpty;
        return Container(
          key: const ValueKey('input-send-btn'),
          decoration: BoxDecoration(
            color: canSend
                ? cs.primary
                : cs.surfaceContainerHighest.withValues(alpha: 0.8),
            shape: BoxShape.circle,
          ),
          child: IconButton(
            icon: Icon(
              Icons.send_rounded,
              size: 18,
              color: canSend ? cs.onPrimary : cs.onSurfaceVariant,
            ),
            tooltip: widget.isAgentProcessing ? "发送（打断当前回复）" : "发送",
            onPressed: canSend
                ? () {
                    if (widget.controller.text.trim().isNotEmpty) {
                      widget.onSend();
                    }
                  }
                : null,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints.tightFor(
              width: 34,
              height: 34,
            ),
            splashRadius: 16,
          ),
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 停止按钮（agent 处理中显示）
  // ═══════════════════════════════════════════════════════════
  Widget _buildStopButton(ColorScheme cs) {
    return Container(
      key: const ValueKey('input-stop-btn'),
      decoration: BoxDecoration(
        color: cs.errorContainer.withValues(alpha: 0.4),
        shape: BoxShape.circle,
        border: Border.all(
          color: cs.error.withValues(alpha: 0.5),
        ),
      ),
      child: IconButton(
        icon: Icon(
          Icons.stop_rounded,
          size: 16,
          color: cs.error,
        ),
        tooltip: "停止",
        onPressed: widget.onStopAgent,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints.tightFor(
          width: 34,
          height: 34,
        ),
        splashRadius: 16,
      ),
    );
  }

  /// 待发相册图缩略图条：挂在输入框内部最左侧（豆包样式）。
  /// 最多占输入框 45% 宽（由调用方按行宽算好传入），超出的横向滚动；
  /// 每张右上角 × 可单独移除。
  Widget _buildPendingGalleryStrip(ColorScheme cs, double maxWidth) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < widget.galleryPendingImages.length; i++)
              _buildPendingGalleryThumb(
                cs,
                i,
                widget.galleryPendingImages[i],
              ),
          ],
        ),
      ),
    );
  }

  /// 待发相册图的缩略图：56px 圆角图 + 右上角悬浮 ×（移除单张）。
  /// cacheWidth 限了解码尺寸，多张大图也不至于把内存吃满。
  Widget _buildPendingGalleryThumb(ColorScheme cs, int index, Uint8List bytes) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.memory(
              bytes,
              width: 56,
              height: 56,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              cacheWidth: 160,
              errorBuilder: (_, __, ___) => Container(
                width: 56,
                height: 56,
                color: cs.surfaceContainerHighest,
                child: Icon(Icons.broken_image_outlined,
                    size: 18, color: cs.onSurfaceVariant),
              ),
            ),
          ),
          Positioned(
            top: -5,
            right: -5,
            child: GestureDetector(
              onTap: () => widget.onRemoveGalleryImage?.call(index),
              child: Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                  color: cs.surface,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: cs.outline.withValues(alpha: 0.5),
                  ),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.15),
                      blurRadius: 4,
                    ),
                  ],
                ),
                child: Icon(Icons.close_rounded,
                    size: 12, color: cs.onSurfaceVariant),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 输入框内统一的图标按钮样式
  // ═══════════════════════════════════════════════════════════
  Widget _buildInputIconButton({
    required IconData icon,
    required String tooltip,
    required VoidCallback? onTap,
    required ColorScheme cs,
    double size = 20,
    InputIconTone tone = InputIconTone.muted,
  }) {
    final Color iconColor = switch (tone) {
      InputIconTone.muted => cs.onSurfaceVariant,
      InputIconTone.primary => cs.primary,
    };
    return Tooltip(
      message: tooltip,
      child: Material(
        color: tone == InputIconTone.primary
            ? cs.primaryContainer.withValues(alpha: 0.55)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: SizedBox(
            width: 32,
            height: 32,
            child: Icon(
              icon,
              size: size,
              color: iconColor,
            ),
          ),
        ),
      ),
    );
  }

  /// 输入框上方的统一 Agent 状态条。
  ///
  /// 处理状态收拢到这一处（取代旧的「消息流内进度气泡 + 工具徽标」两处展示）：
  /// - 工具调用中：优先显示「正在调用：xxx」
  /// - 其余处理中：显示口语化进度（`agent_status` > interim ack > 默认，
  ///   复用 [_processingStatusText] 的优先级）
  /// - 长工具心跳带 percent 时附进度百分比 + 细进度条
  Widget _buildAgentStatusStrip(ColorScheme cs) {
    final String tool = widget.currentToolName?.trim() ?? "";
    // 前台轮次（流式回复/工具调用）与后台任务面（回执聚合）都会点亮状态条；
    // 前台空闲时条上只显示「N 个任务后台进行中」——前后台分工后,
    // 「没在流式回复」不再等于「没在干活」。
    final bool foregroundActive = widget.isAgentProcessing || tool.isNotEmpty;
    final int bgCount = widget.backgroundTaskCount;
    final bool active = foregroundActive || bgCount > 0;
    if (!active) {
      return const SizedBox.shrink();
    }

    final String text = tool.isNotEmpty
        ? "正在调用：$tool"
        : foregroundActive
            ? _processingStatusText()
            : "$bgCount 个任务后台进行中";
    final int? percent = widget.agentStatusPercent;

    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: cs.onSurface.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: cs.outline.withValues(alpha: 0.4),
            width: 1,
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // 思考动画首位:emotion-ball 小球,情绪跟随全局 MoodBridge
                // (listening/thinking/speaking/happy/alert 自动换表情);
                // 工具调用中优先显示「检索资料」,挂载初期按思考/检索兜底;
                // 仅后台任务活跃时按检索态(干活力反馈)。
                MoodDrivenEmotionBall(
                  fallback: tool.isNotEmpty
                      ? EmotionBallIds.retrieving
                      : foregroundActive
                          ? EmotionBallIds.thinking
                          : EmotionBallIds.retrieving,
                  toolOverride:
                      tool.isNotEmpty ? EmotionBallIds.retrieving : null,
                  size: 22,
                  bodyColor: cs.primary,
                  eyeScale: 1.35,
                ),
                const SizedBox(width: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.75),
                          fontWeight: FontWeight.w500,
                        ),
                  ),
                ),
                if (percent != null) ...<Widget>[
                  const SizedBox(width: 8),
                  Text(
                    "$percent%",
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: cs.primary,
                          fontWeight: FontWeight.w700,
                        ),
                  ),
                ],
                // 前台处理中且后台还有任务时，附一个轻量计数提示
                if (bgCount > 0 && foregroundActive) ...<Widget>[
                  const SizedBox(width: 10),
                  Text(
                    "另有 $bgCount 个后台任务",
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: cs.primary.withValues(alpha: 0.85),
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ],
              ],
            ),
            // 进度条：长工具心跳带 percent 时渲染
            if (percent != null) ...<Widget>[
              const SizedBox(height: 6),
              SizedBox(
                width: 220,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: percent / 100,
                    minHeight: 4,
                    backgroundColor: cs.outline.withValues(alpha: 0.15),
                    valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  void _showAgentProfilePopover(GlobalKey avatarKey) {
    // 头像单击 → 进入 Agent 主页。
    // 桌面宽屏由父级路由到右侧 Dock 双栏面板（聊天在左、主页在右），
    // 回调未接线（移动端等）时退化为原来的全屏路由页。
    // 原 Windows 原生 320×160 小弹窗退役：其信息（名字/签名/状态）只是主页
    // header 的子集，点「人」进「家」动线更自然，也不再维护独立 HWND+GDI 窗口。
    final VoidCallback? open = widget.onOpenAgentHome;
    if (open != null) {
      open();
      return;
    }
    unawaited(AgentHomePage.show(context));
  }

  /// 鼠标悬停消息气泡时自动浮现操作按钮栏
  Widget _buildHoverableMessage({
    required ColorScheme cs,
    required ChatMessage mainMessage,
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
    bool isUtteranceContinuation = false,
  }) {
    // 选择模式下，只有当前选中范围内的消息参与（触发用户消息 + 其agent回复）
    final bool inSelectableRange = _deleteSelectionMode &&
        _selectedMessageIds.contains(mainMessage.messageId);
    // 当前消息是否为触发了删除模式的那一轮入口消息（删除按钮挂在该气泡上，
    // 可能是用户提问也可能是 Agent 回复；确认栏只在它下方渲染）
    final bool isTrigger = mainMessage.messageId == _deleteTriggerMessageId;

    return _HoverableMessageWidget(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      isQueued: widget.queuedMessageIds.contains(mainMessage.messageId),
      isFailed: widget.failedUserMessageIds.contains(mainMessage.messageId),
      userGalleryImages: isUser
          ? widget.resolveUserGalleryImages?.call(mainMessage.messageId)
          : null,
      contentSummary: contentSummary,
      agentName: widget.agentName,
      agentAvatarUrl: widget.agentAvatarUrl,
      userAvatarUrl: widget.userAvatarUrl,
      agentMoodStyle: widget.agentMoodStyle,
      agentAvatarPreset: widget.agentAvatarPreset,
      onOpenAgentProfile: _showAgentProfilePopover,
      onDeleteMessage: widget.onDeleteMessage,
      onDeleteFromMessage: widget.onDeleteFromMessage,
      onGetRelatedMessageIds: _getRelatedMessageIds,
      cardPadding: _cardPadding,
      // 全局删除选择状态（从 ChatPage 层级传入）
      deleteSelectionMode: _deleteSelectionMode,
      isSelected: _selectedMessageIds.contains(mainMessage.messageId),
      selectedCount: _selectedMessageIds.length,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      isUtteranceContinuation: isUtteranceContinuation,
      onEnterDeleteMode: _enterDeleteMode,
      onDeleteConfirm: _confirmDeleteSelection,
      onDeleteCancel: _cancelDeleteMode,
      onUserAction: widget.onUserAction,
      onFollowupTap: _sendSuggestion,
      onCancelBackgroundTask: widget.onCancelBackgroundTask,
      onConfirmDecisionCard: widget.onConfirmDecisionCard,
    );
  }

  /// 获取与当前消息同属「一轮问答对」的全部消息 ID。
  ///
  /// 一轮 = 一条 user 消息 + 其后所有非 user 气泡（正文、工具/思考过程、分泡、
  /// 卡片回执、后台任务回执……），直到（不含）下一条 user 消息。
  ///
  /// 旧实现只取「紧随其后的第一条 agent 回复」就 break，Agent 一轮里推了多条
  /// 气泡（分泡 `assistant-<traceId>-bN`、任务回执等）时，删完只剩孤零零的
  /// 另一半。这里改为取整轮，删除按钮才是「删掉这一问一答」。
  List<String> _getRelatedMessageIds(String messageId) {
    final int idx =
        widget.messages.indexWhere((ChatMessage m) => m.messageId == messageId);
    if (idx < 0) return <String>[messageId];

    // 轮次锚点：agent 气泡先回溯到它所属的 user 消息
    int start = idx;
    if (widget.messages[idx].role != "user") {
      start = -1;
      for (int i = idx - 1; i >= 0; i--) {
        if (widget.messages[i].role == "user") {
          start = i;
          break;
        }
      }
      // 没有归属的 user 消息（异常历史数据）→ 退化为只删这一条
      if (start < 0) return <String>[messageId];
    }

    // 轮次右边界：下一条 user 消息（不含）
    int end = start + 1;
    while (
        end < widget.messages.length && widget.messages[end].role != "user") {
      end++;
    }

    return widget.messages
        .sublist(start, end)
        .map((ChatMessage m) => m.messageId)
        .toList();
  }

  /// 「为你推荐」悬停「填入输入框」小按钮路径：只把示例文案追加进输入框
  /// （不发送），光标移到末尾并聚焦，由用户自己编辑后手动发送。输入框
  /// 已有草稿时追加在草稿后面（以空格衔接），不覆盖用户正在写的内容。
  void _insertSuggestion(String prompt) {
    final String draft = widget.controller.text;
    if (draft.trim().isEmpty) {
      widget.controller.text = prompt;
    } else {
      final bool endsWithGap = draft.endsWith(" ") || draft.endsWith("\n");
      widget.controller.text = endsWithGap ? "$draft$prompt" : "$draft $prompt";
    }
    widget.controller.selection = TextSelection.collapsed(
      offset: widget.controller.text.length,
    );
    widget.inputFocusNode?.requestFocus();
  }

  /// 「为你推荐」点击胶囊主体的一键路径：把示例文案灌入输入框后走与
  /// 手打一致的发送链路（onSend 无参调用，同步段内读取并清空输入框）。
  /// 若输入框里有未发送的草稿，发送后恢复，避免推荐文案覆盖用户正在写的
  /// 内容。
  void _sendSuggestion(String prompt) {
    final String draft = widget.controller.text;
    widget.controller.text = prompt;
    widget.onSend();
    if (draft.trim().isNotEmpty) {
      widget.controller.text = draft;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 渲染项列表：按 reverse ListView 顺序（index 0 = 视觉底部 = 最新消息），
    // 直接渲染所有消息，不做任何折叠/分桶。
    final List<Map<String, dynamic>> renderItems = _getRenderItems();
    final int itemCount = renderItems.length;

    return ColoredBox(
      color: cs.surface,
      child: Column(
        children: <Widget>[
          Expanded(
            child: Stack(
              children: <Widget>[
                if (widget.messages.isEmpty) ...<Widget>[
                  // 豆包式空态主视觉：居中问候语（推荐接口挂了也常驻），
                  // 底部抬高避开下方推荐块；首条消息出现后随空态整体让位。
                  Center(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 140),
                      child: Text(
                        _appellation.isEmpty
                            ? _emptyGreetingTail
                            : "$_appellation，$_emptyGreetingTail",
                        style: (Theme.of(context).textTheme.titleLarge ??
                                const TextStyle())
                            .copyWith(
                          fontSize: 26,
                          height: AppTypography.headingLineHeight,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                  ),
                  // 「为你推荐」能力引导列表（拉取失败时不挡聊天）。
                  // 贴对话区左下角：左缘与消息列表左 padding 对齐（不随宽屏
                  // 内容列居中收缩）；首条消息出现后让位给消息流。
                  Align(
                    alignment: Alignment.bottomLeft,
                    child: Padding(
                      padding: const EdgeInsets.only(left: 12, bottom: 4),
                      child: EmptyStateSuggestions(
                        onSuggestionTap: _sendSuggestion,
                        onSuggestionInsert: _insertSuggestion,
                        localStore: widget.localStore,
                      ),
                    ),
                  ),
                ] else
                  // 使整块消息文字支持鼠标框选复制。
                  // 居中内容列：宽屏下消息流和输入框共同收敛到同一最大宽度，
                  // 避免长文本横向铺满整个窗口。
                  SelectionArea(
                    child: Center(
                      child: ConstrainedBox(
                        constraints:
                            const BoxConstraints(maxWidth: _contentMaxWidth),
                        child: NotificationListener<ScrollNotification>(
                          onNotification: _handleScrollNotification,
                          child: ListView.builder(
                            controller: _scrollController,
                            reverse: true,
                            padding: _listPadding,
                            scrollCacheExtent:
                                const ScrollCacheExtent.pixels(500),
                            itemCount: itemCount,
                            itemBuilder: (BuildContext context, int index) {
                              // reverse 模式下 index 0 = 视觉底部（最新消息）
                              final Map<String, dynamic> messageGroup =
                                  renderItems[index];
                              final bool isUser =
                                  messageGroup['isUser'] as bool;
                              final ChatMessage mainMessage =
                                  messageGroup['main'] as ChatMessage;
                              final ContentSummaryParseResult? contentSummary =
                                  isUser
                                      ? null
                                      : ContentSummaryParser.parse(
                                          mainMessage.text);

                              // 发言归组（2026-10-09 重复回复根源修复）：reverse 列表
                              // 里 index+1 = 视觉上的上一条（更早）。同一条发言的后续
                              // 分段渲染为「续泡」（不重复头像/名字/时间头），避免把
                              // 「一条发言的两段」读成两条独立回复。
                              final ChatMessage? aboveMessage =
                                  index + 1 < itemCount
                                      ? renderItems[index + 1]['main']
                                          as ChatMessage
                                      : null;
                              final bool isUtteranceContinuation = !isUser &&
                                  aboveMessage != null &&
                                  UtteranceGrouping.isContinuationOf(
                                    aboveMessage.messageId,
                                    mainMessage.messageId,
                                  );

                              // 稳定 Key：以 messageId 定位，保证 reverse ListView 中新增消息
                              // 使其他条目 index 下移时，Flutter 仍按 messageId 复用 Element，
                              // 打字机的 _revealedRaw 逐字进度不会因重建而重置（否则会反复重打）。
                              return KeyedSubtree(
                                key: ValueKey<String>(
                                    'msg-${mainMessage.messageId}'),
                                child: _buildHoverableMessage(
                                  cs: cs,
                                  mainMessage: mainMessage,
                                  isUser: isUser,
                                  contentSummary: contentSummary,
                                  isUtteranceContinuation:
                                      isUtteranceContinuation,
                                ),
                              );
                            },
                          ),
                        ),
                      ),
                    ),
                  ),
                // 右侧滑块拖拽层：宽度与消息列右缘对齐（滚动条画在同一个右缘）。
                // 用它替换 SDK 自带的滑块拖拽，换算比例在按下时固化；原因见
                // `_computeThumbDragScale`。
                Positioned.fill(
                  child: Center(
                    child: ConstrainedBox(
                      constraints:
                          const BoxConstraints(maxWidth: _contentMaxWidth),
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: SizedBox(
                          width: _scrollbarGrabWidth,
                          height: double.infinity,
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onVerticalDragStart: _onThumbDragStart,
                            onVerticalDragUpdate: _onThumbDragUpdate,
                            onVerticalDragEnd: _onThumbDragEnd,
                            onVerticalDragCancel: _onThumbDragCancel,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                // 「滚到底部」悬浮层：它原本待在下方输入区 Column 里，出现/消失
                // 会把消息列表的视口高度压掉 ~54px，实测 pixels 越过阈值那一帧
                // viewport 512→458、maxScrollExtent 2391→2478。滚动条滑块的位置是
                // 按「指针 / 轨道高度 × maxScrollExtent」算的，这两个数一变就互相
                // 映射错位——表现为拖到中间突然窜到顶、来回漂移。改为浮层后列表
                // 视口高度恒定。
                Align(
                  alignment: Alignment.bottomCenter,
                  child: ValueListenableBuilder<bool>(
                    valueListenable: _isUserScrollingNotifier,
                    builder: (BuildContext context, bool isUserScrolling,
                        Widget? child) {
                      if (!isUserScrolling) return const SizedBox.shrink();
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            if (_hasNewAgentMessage)
                              Padding(
                                padding: const EdgeInsets.only(right: 12),
                                child: Text(
                                  "Agent 有新消息",
                                  style: TextStyle(
                                    color: cs.primary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ),
                            FloatingActionButton.small(
                              heroTag: 'scroll_to_bottom',
                              onPressed: () {
                                if (_scrollController.hasClients) {
                                  _userTookOverViewport = false;
                                  _isUserScrollingNotifier.value = false;
                                  _hasNewAgentMessage = false;
                                  _scrollToBottom();
                                }
                              },
                              backgroundColor: cs.primaryContainer,
                              child: Icon(Icons.arrow_downward,
                                  color: cs.onPrimaryContainer),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
          ColoredBox(
            color: cs.surface,
            child: SafeArea(
              top: false,
              // 输入区与消息流共用同一居中内容列宽度
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: _contentMaxWidth),
                  child: Padding(
                    padding: _inputHorizontalPadding,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        // 语音识别状态提示
                        if (_isListening)
                          Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            padding: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 8),
                            decoration: BoxDecoration(
                              color: cs.errorContainer.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: cs.error.withValues(alpha: 0.5),
                                width: 1,
                              ),
                            ),
                            child: Row(
                              children: <Widget>[
                                SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor:
                                        AlwaysStoppedAnimation<Color>(cs.error),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    _recognizedText.isNotEmpty
                                        ? "正在识别: $_recognizedText"
                                        : "正在聆听...",
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelMedium
                                        ?.copyWith(
                                          color: cs.error,
                                        ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        // 「为你推荐」横滑条：Agent 空闲时偶现的能力引导
                        // （忙碌时整体隐藏，位置让给状态条；出现时机由组件内治理）
                        if (widget.messages.isNotEmpty)
                          ChatSuggestionBar(
                            agentIdle: widget.agentIdle,
                            messageCount: widget.messages.length,
                            onSuggestionTap: _sendSuggestion,
                            onSuggestionInsert: _insertSuggestion,
                            localStore: widget.localStore,
                          ),
                        // 任务步骤条（2026-10-19 handoff）：有未完成计划时常驻在输入框
                        // 上方显示步骤与进度；等待步摊开 handoff 说明并给「我已完成」按钮
                        // （点击＝发一句话，服务端据此收回执行权并继续）。
                        if ((widget.planSteps.isNotEmpty ||
                            (widget.turnState?.plan.isNotEmpty ?? false)))
                          PlanStepsCard(
                            steps: widget.planSteps.isNotEmpty
                                ? widget.planSteps
                                : widget.turnState!.plan,
                            onConfirm: () => _sendSuggestion("我已完成，继续下一步"),
                          ),
                        // Agent 状态条：处理状态统一收拢在这一条（工具名 / 口语化进度 /
                        // 百分比 + 进度条），固定在输入框上方，淡入淡出避免闪现/抖动
                        Align(
                          alignment: Alignment.centerLeft,
                          child: AnimatedSwitcher(
                            duration: const Duration(milliseconds: 250),
                            reverseDuration: const Duration(milliseconds: 200),
                            transitionBuilder:
                                (Widget child, Animation<double> animation) {
                              return FadeTransition(
                                opacity: animation,
                                child: SlideTransition(
                                  position: Tween<Offset>(
                                    begin: const Offset(0, -0.15),
                                    end: Offset.zero,
                                  ).animate(animation),
                                  child: child,
                                ),
                              );
                            },
                            child: KeyedSubtree(
                              key: ValueKey<String>(
                                (widget.isAgentProcessing ||
                                        (widget.currentToolName
                                                ?.trim()
                                                .isNotEmpty ??
                                            false))
                                    ? "status-${widget.currentToolName?.trim() ?? ""}"
                                    : widget.backgroundTaskCount > 0
                                        ? "status-bg"
                                        : "__idle__",
                              ),
                              child: _buildAgentStatusStrip(cs),
                            ),
                          ),
                        ),
                        const SizedBox(height: 8),
                        // 主输入框容器
                        // - agent 工作中：边框附上白色呼吸灯光晕（boxShadow + 边框色同步脉动）
                        // - 空闲时：维持原本的浅灰描边 + 柔和投影
                        // 工具徽标（真 3D 球形机器人）通过 Stack 浮在输入框外左上角，
                        // 不计入内部布局，不挤压输入框高度。
                        Stack(
                          clipBehavior: Clip.none,
                          alignment: Alignment.topLeft,
                          children: <Widget>[
                            AnimatedBuilder(
                              animation: _breathingAnimation!,
                              builder: (context, child) {
                                final double breath =
                                    _breathingAnimation!.value;
                                final bool busy = widget.isAgentProcessing;
                                // 0~1 的呼吸强度，busy 时拉到 0.6~1.0，空闲时 0~0.25
                                final double pulse = busy
                                    ? (0.6 + 0.4 * breath)
                                    : (0.05 + 0.2 * breath);
                                // 描边/光晕主题色化：深色主题沿用白光呼吸，
                                // 暖色主题下白色在近白背景上不可见，
                                // 改用中性灰描边 + 暖棕光晕（与主题种子色一致）。
                                final bool isDark =
                                    Theme.of(context).brightness ==
                                        Brightness.dark;
                                final Color rimColor = isDark
                                    ? Colors.white
                                    : const Color(0xFF9AA3B2);
                                final Color glowColor = isDark
                                    ? Colors.white
                                    : const Color(0xFFB98B43);
                                final double rimAlpha = isDark
                                    ? 0.15 + 0.45 * pulse
                                    : 0.35 + 0.3 * pulse;
                                return Container(
                                  decoration: BoxDecoration(
                                    color: cs.surface,
                                    borderRadius: BorderRadius.circular(20),
                                    // 外层描边：busy 强光，idle 弱光，随呼吸脉动
                                    border: Border.all(
                                      color:
                                          rimColor.withValues(alpha: rimAlpha),
                                      width: 0.8 + 0.6 * pulse,
                                    ),
                                    boxShadow: <BoxShadow>[
                                      if (busy) ...<BoxShadow>[
                                        // 外圈光晕（主呼吸）
                                        BoxShadow(
                                          color: glowColor.withValues(
                                              alpha: 0.18 * pulse),
                                          blurRadius: 14 + 10 * breath,
                                          spreadRadius: 0.5 + 1.5 * breath,
                                        ),
                                        // 内圈近场光雾
                                        BoxShadow(
                                          color: glowColor.withValues(
                                              alpha: 0.28 * breath),
                                          blurRadius: 4,
                                        ),
                                      ] else ...<BoxShadow>[
                                        // 柔和投影，更轻盈
                                        BoxShadow(
                                          color: Colors.black
                                              .withValues(alpha: 0.08),
                                          blurRadius: 20,
                                          spreadRadius: 0,
                                          offset: const Offset(0, 4),
                                        ),
                                      ],
                                    ],
                                  ),
                                  child: child,
                                );
                              },
                              child: Padding(
                                padding: const EdgeInsets.fromLTRB(8, 8, 6, 8),
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: <Widget>[
                                    // 第一行：[待发缩略图（最左侧，豆包样式）] + 输入框 + 发送/停止按钮
                                    // 有待发图时行高被缩略图撑起，文字/按钮改为垂直居中更自然
                                    // LayoutBuilder 在 Row 内会拿到无界宽度，须包在 Row 外
                                    // 算出可用宽度，供缩略图条按比例限宽。
                                    LayoutBuilder(
                                      builder: (BuildContext context,
                                          BoxConstraints b) {
                                        return Row(
                                          crossAxisAlignment: widget
                                                  .galleryPendingImages
                                                  .isNotEmpty
                                              ? CrossAxisAlignment.center
                                              : CrossAxisAlignment.end,
                                          children: <Widget>[
                                            // 最左侧：待发相册图缩略图（挂在输入框内部，与文字同行）
                                            if (widget.galleryPendingImages
                                                .isNotEmpty)
                                              _buildPendingGalleryStrip(
                                                cs,
                                                b.maxWidth * 0.45,
                                              ),
                                            // 中间：输入框
                                            Expanded(
                                              child: Padding(
                                                padding:
                                                    const EdgeInsets.symmetric(
                                                        horizontal: 4,
                                                        vertical: 2),
                                                child: Focus(
                                                  // Enter 键发送消息；Shift+Enter 换行
                                                  onKeyEvent: (FocusNode node,
                                                      KeyEvent event) {
                                                    if (event
                                                        is! KeyDownEvent) {
                                                      return KeyEventResult
                                                          .ignored;
                                                    }
                                                    final bool isEnter = event
                                                                .logicalKey ==
                                                            LogicalKeyboardKey
                                                                .enter ||
                                                        event.logicalKey ==
                                                            LogicalKeyboardKey
                                                                .numpadEnter;
                                                    if (!isEnter) {
                                                      return KeyEventResult
                                                          .ignored;
                                                    }
                                                    if (HardwareKeyboard
                                                        .instance
                                                        .isShiftPressed) {
                                                      return KeyEventResult
                                                          .ignored;
                                                    }
                                                    // agent 回复中也允许发送：会打断当前回复并开新轮次
                                                    if (widget.controller.text
                                                        .trim()
                                                        .isNotEmpty) {
                                                      widget.onSend();
                                                      return KeyEventResult
                                                          .handled;
                                                    }
                                                    return KeyEventResult
                                                        .ignored;
                                                  },
                                                  child: TextField(
                                                    controller:
                                                        widget.controller,
                                                    focusNode:
                                                        widget.inputFocusNode,
                                                    style: TextStyle(
                                                        color: cs.onSurface,
                                                        fontSize: 15),
                                                    cursorColor: cs.primary,
                                                    maxLines: 6,
                                                    minLines: 1,
                                                    textInputAction:
                                                        TextInputAction.newline,
                                                    keyboardType:
                                                        TextInputType.multiline,
                                                    decoration: InputDecoration(
                                                      hintText: "",
                                                      // 彻底移除 TextField 内部各状态下的内边框（下划线/矩形）
                                                      border: InputBorder.none,
                                                      enabledBorder:
                                                          InputBorder.none,
                                                      focusedBorder:
                                                          InputBorder.none,
                                                      disabledBorder:
                                                          InputBorder.none,
                                                      errorBorder:
                                                          InputBorder.none,
                                                      focusedErrorBorder:
                                                          InputBorder.none,
                                                      hintStyle: TextStyle(
                                                        color: cs
                                                            .onSurfaceVariant
                                                            .withValues(
                                                                alpha: 0.5),
                                                        fontSize: 15,
                                                      ),
                                                      contentPadding:
                                                          EdgeInsets.zero,
                                                      isDense: true,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                            const SizedBox(width: 4),
                                            // 右侧：发送/停止按钮（常显，根据状态切换）
                                            // agent 回复中：输入框有文本时显示「发送」（会打断当前回复并开新轮次），
                                            // 输入框为空时显示「停止」（仅停止当前回复）。空闲时始终显示「发送」。
                                            ValueListenableBuilder<
                                                TextEditingValue>(
                                              valueListenable:
                                                  widget.controller,
                                              builder: (_,
                                                  TextEditingValue value, __) {
                                                final bool hasText = value.text
                                                    .trim()
                                                    .isNotEmpty;
                                                return AnimatedSwitcher(
                                                  duration: const Duration(
                                                      milliseconds: 180),
                                                  switchInCurve:
                                                      Curves.easeOutCubic,
                                                  switchOutCurve:
                                                      Curves.easeInCubic,
                                                  transitionBuilder: (Widget
                                                          child,
                                                      Animation<double> anim) {
                                                    return FadeTransition(
                                                      opacity: anim,
                                                      child: ScaleTransition(
                                                        scale: Tween<double>(
                                                                begin: 0.85,
                                                                end: 1)
                                                            .animate(anim),
                                                        child: child,
                                                      ),
                                                    );
                                                  },
                                                  child:
                                                      widget.isAgentProcessing &&
                                                              !hasText
                                                          ? _buildStopButton(cs)
                                                          : _buildSendButton(
                                                              cs),
                                                );
                                              },
                                            ),
                                          ],
                                        );
                                      },
                                    ),
                                    // 第二行：辅助功能按钮（左下：上传图片；右下：通话）
                                    Padding(
                                      padding: const EdgeInsets.only(top: 2),
                                      child: Row(
                                        children: <Widget>[
                                          // 左下：上传图片
                                          if (widget.onPickGalleryImage != null)
                                            _buildInputIconButton(
                                              icon: Icons.add_rounded,
                                              tooltip: "上传图片",
                                              onTap: widget.onPickGalleryImage,
                                              cs: cs,
                                              size: 18,
                                            ),
                                          const Spacer(),
                                          // 右下：电话按钮
                                          if (widget.onOpenPhoneDialer != null)
                                            _buildInputIconButton(
                                              icon: Icons.phone_in_talk,
                                              tooltip:
                                                  VoiceCallUiLabels.chatTooltip,
                                              onTap: widget.onOpenPhoneDialer,
                                              cs: cs,
                                              size: 18,
                                            ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GomokuPlayUrlCard extends StatelessWidget {
  const _GomokuPlayUrlCard({
    required this.playUrl,
  });

  final String playUrl;

  void _open(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("无法打开对局：未配置内嵌入口")),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.primaryContainer.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.primary.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.grid_on, size: 18, color: cs.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  "对局",
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: cs.primary,
                        fontWeight: FontWeight.w600,
                      ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            "Agent 已开好棋局，你执白棋（后手）。",
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => _open(context),
            icon: const Icon(Icons.sports_esports, size: 18),
            label: const Text("在 App 内进入对局"),
          ),
        ],
      ),
    );
  }
}

/// 独立的 StatefulWidget：管理每条消息的 hover 悬停状态，删除选择状态由父级 ChatPage 统一管理
class _HoverableMessageWidget extends StatelessWidget {
  const _HoverableMessageWidget({
    required this.cs,
    required this.mainMessage,
    required this.isUser,
    required this.isQueued,
    required this.isFailed,
    required this.userGalleryImages,
    required this.cardPadding,
    this.contentSummary,
    this.agentName,
    this.agentAvatarUrl,
    this.userAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.onOpenAgentProfile,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    this.onGetRelatedMessageIds,
    // 全局删除选择状态（由 ChatPage 传入）
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,

    /// 是否在选择模式的可选范围内（触发用户消息 + 其agent回复）
    required this.inSelectableRange,

    /// 是否为触发了删除模式的用户消息（锁定不可取消）
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,

    /// 「选择型卡片」按钮点击回调(可选,透传至内容渲染)
    this.onUserAction,

    /// 「接下来你可以」接续建议点击回调（透传至内容渲染；null 不渲染建议行）
    this.onFollowupTap,

    /// 取消后台任务回调（任务回执 hover 取消按钮）
    this.onCancelBackgroundTask,

    /// 对话流决策卡「确认/忽略」回调（透传至条目渲染）
    this.onConfirmDecisionCard,

    /// 是否为同一条发言（utterance）的后续分段（续泡）：不重复头像/名字/时间头
    this.isUtteranceContinuation = false,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;

  /// 是否为同一条发言（utterance）的后续分段（续泡）：
  /// 续泡不带头像、名字与时间头 —— 同一发言继续说下一句，不是新的一条回复。
  /// 判据见 lib/features/chat/utterance_grouping.dart。
  final bool isUtteranceContinuation;

  /// 该用户消息是否仍在排队（等待 Agent 依次处理），控制「排队中」徽标
  final bool isQueued;

  /// 该用户消息是否发送失败（WS 未就绪被拒），控制「未发出」徽标
  final bool isFailed;

  /// 该用户消息随发的相册图字节（内存态，历史加载为 null）
  final List<Uint8List>? userGalleryImages;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final String? agentName;
  final String? agentAvatarUrl;

  /// 当前用户头像的绝对 URL（ChatPage 透传；null=未设置走缺省灰球）。
  final String? userAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final List<String> Function(String messageId)? onGetRelatedMessageIds;

  /// 取消后台任务回调（任务回执 hover 取消按钮）
  final void Function(String taskId)? onCancelBackgroundTask;

  /// 对话流决策卡「确认/忽略」回调（传入 messageId；区分确认与忽略）
  final void Function(String messageId, bool confirmed)? onConfirmDecisionCard;

  /// 全局删除选择模式是否激活
  final bool deleteSelectionMode;

  /// 当前消息是否被选中
  final bool isSelected;

  /// 当前已选中的消息总数（用于确认栏显示）
  final int selectedCount;

  /// 是否在可选择范围内
  final bool inSelectableRange;

  /// 是否为触发的用户消息（锁定）
  final bool isTrigger;

  /// 回调：进入删除选择模式
  final void Function(String messageId) onEnterDeleteMode;

  /// 回调：确认删除
  final VoidCallback onDeleteConfirm;

  /// 回调：取消删除模式
  final VoidCallback onDeleteCancel;

  /// 「选择型卡片」按钮点击回调(透传至消息正文渲染)
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 「接下来你可以」接续建议点击回调(透传至消息正文渲染)
  final void Function(String prompt)? onFollowupTap;

  @override
  Widget build(BuildContext context) {
    return _HoverableMessageContent(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      isQueued: isQueued,
      isFailed: isFailed,
      userGalleryImages: userGalleryImages,
      cardPadding: cardPadding,
      contentSummary: contentSummary,
      agentName: agentName,
      agentAvatarUrl: agentAvatarUrl,
      userAvatarUrl: userAvatarUrl,
      agentMoodStyle: agentMoodStyle,
      agentAvatarPreset: agentAvatarPreset,
      onOpenAgentProfile: onOpenAgentProfile,
      onDeleteMessage: onDeleteMessage,
      onDeleteFromMessage: onDeleteFromMessage,
      deleteSelectionMode: deleteSelectionMode,
      isSelected: isSelected,
      selectedCount: selectedCount,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      onEnterDeleteMode: onEnterDeleteMode,
      onDeleteConfirm: onDeleteConfirm,
      onDeleteCancel: onDeleteCancel,
      onUserAction: onUserAction,
      onFollowupTap: onFollowupTap,
      onCancelBackgroundTask: onCancelBackgroundTask,
      onConfirmDecisionCard: onConfirmDecisionCard,
      isUtteranceContinuation: isUtteranceContinuation,
    );
  }
}

/// 实际的 StatefulWidget，仅管理本地 hover 状态
class _HoverableMessageContent extends StatefulWidget {
  const _HoverableMessageContent({
    required this.cs,
    required this.mainMessage,
    required this.isUser,
    required this.isQueued,
    required this.isFailed,
    required this.userGalleryImages,
    required this.cardPadding,
    this.contentSummary,
    this.agentName,
    this.agentAvatarUrl,
    this.userAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.onOpenAgentProfile,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,
    required this.inSelectableRange,
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,
    this.onUserAction,
    this.onFollowupTap,
    this.onCancelBackgroundTask,
    this.onConfirmDecisionCard,
    this.isUtteranceContinuation = false,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;

  /// 该用户消息是否仍在排队（等待 Agent 依次处理），控制「排队中」徽标
  final bool isQueued;

  /// 该用户消息是否发送失败（WS 未就绪被拒），控制「未发出」徽标
  final bool isFailed;

  /// 该用户消息随发的相册图字节（内存态，历史加载为 null）
  final List<Uint8List>? userGalleryImages;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final String? agentName;
  final String? agentAvatarUrl;

  /// 当前用户头像的绝对 URL（ChatPage 透传；null=未设置走缺省灰球）。
  final String? userAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final bool deleteSelectionMode;
  final bool isSelected;
  final int selectedCount;
  final bool inSelectableRange;
  final bool isTrigger;
  final void Function(String messageId) onEnterDeleteMode;
  final VoidCallback onDeleteConfirm;
  final VoidCallback onDeleteCancel;

  /// 「选择型卡片」按钮点击回调(透传至消息正文渲染)
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 「接下来你可以」接续建议点击回调(透传至消息正文渲染)
  final void Function(String prompt)? onFollowupTap;

  /// 取消后台任务回调（任务回执 hover 取消按钮）
  final void Function(String taskId)? onCancelBackgroundTask;

  /// 对话流决策卡「确认/忽略」回调（传入 messageId）
  final void Function(String messageId, bool confirmed)? onConfirmDecisionCard;

  /// 是否为同一条发言（utterance）的后续分段（续泡）：
  /// 续泡不带头像、名字与时间头 —— 同一条消息继续说下一句，不是新的一条回复。
  final bool isUtteranceContinuation;

  @override
  State<_HoverableMessageContent> createState() =>
      _HoverableMessageContentState();
}

class _HoverableMessageContentState extends State<_HoverableMessageContent> {
  final GlobalKey _avatarKey = GlobalKey();

  /// 鼠标是否悬停在本条消息上：删除入口只在悬停时浮现（沿用「任务回执 hover
  /// 才浮现取消入口」的既有语言，平时零视觉噪音）。
  bool _hovering = false;

  /// 「删除这一轮」入口在气泡外侧占的槽宽（按钮 22px + 与气泡之间 2px 间隙）
  static const double _deleteEntrySlotWidth = 24;

  /// 删除确认栏在气泡下方占用的「预留带」高度（栏高 ≈32 + 与气泡间隙 ≈18）。
  ///
  /// 必须让 Stack 自身带上这段高度，确认栏才落在本条目自己的 RenderBox 内。
  /// 原因与删除入口同源：Flutter 的命中测试不会越过父级 RenderBox 的 `size`
  /// 边界（`Stack` 只在自己 size 内参与命中测试，`clipBehavior: Clip.none`
  /// 只管绘制、不管点击）。此前确认栏用 `Positioned(bottom: -56)` 画在气泡
  /// 下方 —— 看得见、点不到，「删除」按钮因此完全无响应。
  static const double _deleteConfirmBarBand = 50;

  // ===== 打字机式流式显示 =====
  // 逐字 reveal 的节奏控制(自适应语速 + 句末停顿)已抽到共享控制器
  // [TypewriterReveal],桌面端与手机端共用同一实现。
  late final TypewriterReveal _typewriter = TypewriterReveal(
    widget.mainMessage.text,
    animate: widget.mainMessage.streaming && widget.mainMessage.text.isNotEmpty,
  );

  String get _rawTarget => widget.mainMessage.text;

  // 消息内嵌的 Agent 结果卡（按文本记忆化：流式期间逐帧 build，
  // 避免每帧对全文重复跑正则 + JSON 解析）。
  AgentResultData? _cachedAgentResult;
  String? _cachedAgentResultSource;

  AgentResultData? get _agentResult {
    final String text = widget.mainMessage.text;
    if (_cachedAgentResultSource != text) {
      _cachedAgentResult = AgentResultParser.parse(text).data;
      _cachedAgentResultSource = text;
    }
    return _cachedAgentResult;
  }

  /// 是否处于打字机展示中(打字中或光标闪烁中)
  bool get _typewriterActive => _typewriter.active;

  @override
  void initState() {
    super.initState();
    _typewriter.addListener(_onTypewriterChanged);
  }

  void _onTypewriterChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant _HoverableMessageContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.mainMessage.text != oldWidget.mainMessage.text) {
      _syncTypewriter();
    }
  }

  @override
  void dispose() {
    _typewriter.dispose();
    super.dispose();
  }

  void _syncTypewriter() {
    if (widget.isUser) {
      // 用户消息:直接显示全文
      _typewriter.showAll();
      return;
    }
    _typewriter.updateTarget(_rawTarget);
  }

  @override
  Widget build(BuildContext context) {
    // 删除确认栏只在「触发删除的那轮入口气泡」下方出现（用户提问或 Agent 回复均可）
    final bool showDeleteConfirmBar =
        widget.deleteSelectionMode && widget.isTrigger;
    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) {
        if (!_hovering) setState(() => _hovering = true);
      },
      onExit: (_) {
        if (_hovering) setState(() => _hovering = false);
      },
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          // 原始消息卡片 + 确认栏预留带：预留带只在这条消息是删除触发点时占位，
          // 让 Stack 的 size 覆盖到确认栏，确认栏才可点击（见 _deleteConfirmBarBand）。
          Padding(
            padding: EdgeInsets.only(
              bottom: showDeleteConfirmBar ? _deleteConfirmBarBand : 0,
            ),
            child: RepaintBoundary(
              child: Align(
                alignment: widget.isUser
                    ? Alignment.centerRight
                    : Alignment.centerLeft,
                // Agent 消息整行（含头像）从左缘右移 36px，与窗口边缘留出呼吸感。
                child: Padding(
                  padding: widget.isUser
                      ? EdgeInsets.zero
                      : const EdgeInsets.only(left: 36),
                  child: _buildMessageRow(context),
                ),
              ),
            ),
          ),
          // 删除确认/取消按钮栏：贴预留带底边，落在本条目自己的 RenderBox 内
          if (showDeleteConfirmBar)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Align(
                alignment: widget.isUser
                    ? Alignment.bottomRight
                    : Alignment.bottomLeft,
                child: Padding(
                  padding: EdgeInsets.only(right: widget.isUser ? 60 : 0),
                  child: _DeleteConfirmBar(
                    selectedCount: widget.selectedCount,
                    onConfirm: widget.onDeleteConfirm,
                    onCancel: widget.onDeleteCancel,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 构建包含头像、时间、气泡的完整消息行
  Widget _buildMessageRow(BuildContext context) {
    // 给气泡加个最大宽度限制（屏宽 72%），避免长文本横向铺满整行。
    // 用 LayoutBuilder 拿父级可用宽度，比硬编码 MediaQuery 更稳。
    final bool isTaskReceipt = widget.mainMessage.contentType == "task_receipt";
    final bool isDecisionCard =
        widget.mainMessage.contentType == "decision_card";
    final bool isEveningDigest =
        widget.mainMessage.contentType == "evening_digest" &&
            widget.mainMessage.eveningDigest != null;
    final bool isVoiceMessage = widget.mainMessage.contentType == "audio" &&
        widget.mainMessage.attachments.any(
            (MessageAttachment a) => a.type == MessageAttachmentType.audio);
    final Widget bubble;
    if (isTaskReceipt) {
      // 后台任务回执：轻量状态行（非 IM 气泡），hover 才浮现取消入口，
      // 不打断对话流的阅读连续性（无缝形态的视觉兜底）。
      bubble = _TaskReceiptBubble(
        message: widget.mainMessage,
        onCancel: widget.onCancelBackgroundTask,
      );
    } else if (isDecisionCard) {
      // 决策卡（2026-10-14 定稿）：决策类通知不再飘弹窗/玻璃卡，
      // 直接落对话流一张卡，确认/忽略在卡上完成并回传 ack/outcome。
      bubble = _DecisionCardBubble(
        message: widget.mainMessage,
        onAction: widget.onConfirmDecisionCard,
      );
    } else if (isEveningDigest) {
      // 睡前备忘卡（2026-10-22 定调）：结构化块专属渲染，不框进气泡外壳
      //（同 travel_itinerary 的独立消息元素形态），人话段在卡顶部。
      bubble = ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: EveningDigestCard(digest: widget.mainMessage.eveningDigest!),
      );
    } else if (isVoiceMessage) {
      final MessageAttachment audio = widget.mainMessage.attachments.firstWhere(
        (MessageAttachment a) => a.type == MessageAttachmentType.audio,
      );
      bubble = LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxBubbleWidth = constraints.maxWidth * 0.72;
          return ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: VoiceMessageBubble(
              mediaUrl: audio.url,
              isMe: widget.isUser,
              durationMs:
                  audio.durationMs ?? widget.mainMessage.durationMs ?? 0,
              waveform: audio.waveform ?? widget.mainMessage.waveform,
              transcript: (audio.transcript?.isNotEmpty == true
                      ? audio.transcript
                      : null) ??
                  (widget.mainMessage.text.isNotEmpty
                      ? widget.mainMessage.text
                      : null),
              isRead: true,
            ),
          );
        },
      );
    } else if (widget.isUser) {
      // 用户消息保留 IM 气泡形态（屏宽 72% 上限）。
      // 用 LayoutBuilder 拿父级可用宽度，比硬编码 MediaQuery 更稳。
      bubble = LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxBubbleWidth = constraints.maxWidth * 0.72;
          return ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: _buildMessageCard(context, highlight: widget.isSelected),
          );
        },
      );
    } else {
      // Agent 回复描边框：宽度收敛为可用宽度的 75%（2026-09-03 用户反馈，
      // 相比全宽减少 1/4），文字与照片都框在内；短回复仍按内容自适应收窄。
      // 2026-09-25 用户定稿：travel_itinerary 卡不再框进本气泡——正文气泡
      // 只装文字/照片介绍，卡片在气泡下方作为第二条独立消息形态渲染
      // （见 _buildMessageColumn），因此宽度恒 0.75。
      const double widthFactor = 0.75;
      // 用 LayoutBuilder 拿父级可用宽度，比硬编码 MediaQuery 更稳。
      bubble = LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxBubbleWidth = constraints.maxWidth * widthFactor;
          return ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: _buildMessageCard(context, highlight: widget.isSelected),
          );
        },
      );
    }

    if (widget.inSelectableRange) {
      // 待删除态：整轮高亮（删除单位固定是整轮问答对，不再逐条勾选，
      // 避免出现「取消勾选某条气泡」的误导交互）。
      return Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (!widget.isUser && !widget.isUtteranceContinuation)
            _buildAvatar(context, isUser: false),
          Flexible(child: _buildMessageColumn(bubble)),
          if (widget.isUser) _buildAvatar(context, isUser: true),
        ],
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (!widget.isUser) _buildAvatar(context, isUser: false),
        // 删除入口（2026-10-04 用户定稿：放每条气泡自己的右下角）
        Flexible(
          child: _buildMessageColumn(
            _wrapBubbleWithDeleteEntry(context, bubble),
          ),
        ),
        if (widget.isUser) _buildAvatar(context, isUser: true),
      ],
    );
  }

  /// 「删除这一轮」入口：挂在**气泡外侧**的右下角（2026-10-04 用户定稿）。
  ///
  /// 为什么是「右侧留一条常驻空槽」而不是把按钮负偏移飘出去：
  /// Flutter 的命中测试不会越过父级 RenderBox 的 size 边界（`clipBehavior:
  /// Clip.none` 只管绘制不管点击），`Positioned(right: -22)` 会变成「看得见
  /// 点不到」。所以按钮必须落在这条 24px 空槽里，槽位常驻、只有透明度随
  /// hover 变化，避免出现时把气泡挤得抖动。
  Widget _wrapBubbleWithDeleteEntry(BuildContext context, Widget bubble) {
    return Stack(
      children: <Widget>[
        // 气泡 + 右侧 24px 空槽，空槽常驻以免 hover 时气泡被挤得抖动
        Padding(
          padding: const EdgeInsets.only(right: _deleteEntrySlotWidth),
          child: bubble,
        ),
        // 按钮落在空槽里、贴着气泡右下角（槽位在气泡外侧，不是压在气泡上）
        Positioned(
          right: 0,
          bottom: 0,
          child: _buildDeleteEntryButton(context),
        ),
      ],
    );
  }

  /// 删除入口按钮本体：小圆底 + 垃圾桶图标，点击进入该轮问答对的删除确认
  /// （整轮预选、确认栏渲染都由 ChatPage 统一管理，这里只负责触发）。
  Widget _buildDeleteEntryButton(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 删除能力未接线 / 已处于选择模式时不出现入口
    final bool visible = _hovering &&
        !widget.deleteSelectionMode &&
        widget.onDeleteMessage != null;
    return AnimatedOpacity(
      opacity: visible ? 1.0 : 0.0,
      duration: const Duration(milliseconds: 120),
      child: IgnorePointer(
        ignoring: !visible,
        child: Tooltip(
          message: "删除这一轮",
          child: Material(
            // 小圆底衬：按钮落在气泡外侧，底衬保证在任意页面底色上都可辨认
            color: cs.surfaceContainerHighest,
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () =>
                  widget.onEnterDeleteMode(widget.mainMessage.messageId),
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Icon(
                  Icons.delete_outline,
                  size: 14,
                  color: cs.error,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildMessageColumn(Widget bubble) {
    final AgentResultData? travelCard =
        (!widget.isUser && _agentResult?.cardType == "travel_itinerary")
            ? _agentResult
            : null;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment:
          widget.isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: <Widget>[
        _buildMessageHeader(),
        bubble,
        // 行程卡独立第二条消息形态（2026-09-25 用户定稿）：上一条气泡用文字/
        // 照片介绍规划，卡片不框进任何气泡外壳，作为消息流中的独立大卡
        // 跟在下方（卡自带完整外观与 460 限宽：海报/叮嘱/CTA/脚注）。正文
        // 气泡内的卡渲染由 buildMessageBody(excludeTravelCard) 关闭，避免双份。
        if (travelCard != null)
          Padding(
            padding: const EdgeInsets.only(top: AppTypography.space2),
            child: AgentResultCard(data: travelCard),
          ),
      ],
    );
  }

  Widget _buildMessageHeader() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String timeStr = _formatTime(widget.mainMessage.timestamp);
    // 时间戳:最小可读档(11),显式行高避免行盒过高/过矮
    final TextStyle timeStyle = TextStyle(
      fontSize: AppTypography.micro,
      height: AppTypography.headingLineHeight,
      color: cs.onSurfaceVariant,
    );

    if (widget.isUser) {
      // 「未发出」徽标：WS 未就绪 sendEvent 被拒时标记，红色提示用户这条
      // （含配图）没有真的到服务器，需检查连接后重发。
      if (widget.isFailed) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 2, right: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.error_outline, size: 11, color: cs.error),
              const SizedBox(width: 3),
              Text(
                "未发出",
                style: timeStyle.copyWith(color: cs.error),
              ),
              const SizedBox(width: 6),
              Text(timeStr, style: timeStyle),
            ],
          ),
        );
      }
      // 排队中徽标：处理中收到的新消息按发送顺序排队，逐条处理；
      // 服务端开始处理该条（chat.turn_started 晋级）后父组件会移出集合。
      if (widget.isQueued) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 2, right: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.schedule, size: 11, color: cs.onSurfaceVariant),
              const SizedBox(width: 3),
              Text("排队中", style: timeStyle),
              const SizedBox(width: 6),
              Text(timeStr, style: timeStyle),
            ],
          ),
        );
      }
      return Padding(
        padding: const EdgeInsets.only(bottom: 2, right: 4),
        child: Text(timeStr, style: timeStyle),
      );
    }

    // 续泡（同一条发言的后续分段）：不重复名字与时间头 —— 视觉上读作
    // 「同一条消息继续说下一句」，而不是新的一条回复（重复回复事故的观感根源）。
    if (widget.isUtteranceContinuation) {
      return const SizedBox(height: 2);
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 2, left: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            widget.agentName ?? "AI 助手",
            style: TextStyle(
              fontSize: AppTypography.caption,
              height: AppTypography.headingLineHeight,
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
            ),
          ),
          const SizedBox(width: 6),
          Text(timeStr, style: timeStyle),
        ],
      ),
    );
  }

  /// 气泡头部时间：今天只显示时刻，跨天带日期（2026-10-23）。
  /// 跨天仍只显示 HH:mm 时，「昨天 21:10」和「今天 09:10」视觉上无法区分。
  static String _formatTime(DateTime time) => chatTimeLabel(time);

  Widget _buildAvatar(BuildContext context, {required bool isUser}) {
    // 头像顶部与「名称/时间行」的字形顶部对齐:
    // 偏移由排版 token 推导(行盒半行距),字号/行高调整后自动跟随。
    final double avatarTop = AppTypography.avatarHeaderOffset;
    if (isUser) {
      final bool isDark = Theme.of(context).brightness == Brightness.dark;
      const Widget fallbackIcon = Icon(
        Icons.person_outline,
        size: 18,
        color: Colors.white,
      );
      final String? avatarUrl = widget.userAvatarUrl;
      return Container(
        width: 36,
        height: 36,
        margin: EdgeInsets.only(left: 10, top: avatarTop),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[
              Color(0xFF8E8E93),
              Color(0xFF6E6E73),
            ],
          ),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.1),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
          border: Border.all(
            // 深色下用白色发丝边，暖色下白边不可见，换成浅灰描边
            color: isDark
                ? Colors.white.withValues(alpha: 0.5)
                : Theme.of(context).colorScheme.surfaceContainerHighest,
            width: 1,
          ),
        ),
        alignment: Alignment.center,
        // 有头像：图片填满圆内（发丝边外圈保留）；加载失败/未设置回退人形图标
        child: avatarUrl == null || avatarUrl.isEmpty
            ? fallbackIcon
            : ClipOval(
                child: CachedMediaImage(
                  url: avatarUrl,
                  width: 34,
                  height: 34,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  errorBuilder: (BuildContext context, Object error,
                          StackTrace? stackTrace) =>
                      fallbackIcon,
                ),
              ),
      );
    }

    final Widget avatar = _buildDefaultAgentAvatar();

    if (widget.onOpenAgentProfile == null) {
      return avatar;
    }
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        key: _avatarKey,
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onOpenAgentProfile!.call(_avatarKey),
        child: SizedBox(
          width: 46,
          height: 40,
          child: Align(
            alignment: Alignment.topLeft,
            child: avatar,
          ),
        ),
      ),
    );
  }

  Widget _buildDefaultAgentAvatar() {
    // 「轨道光球」矢量头像：与桌面悬浮球形 Agent 的意象一致，
    // 配色跟随 Agent 自选的 avatarPreset（dawn/ember/tide/...）。
    return Padding(
      padding:
          EdgeInsets.only(right: 10, top: AppTypography.avatarHeaderOffset),
      child: AgentOrbAvatar(
        size: 36,
        palette: AgentAvatarPalette.fromPreset(widget.agentAvatarPreset),
      ),
    );
  }

  /// 已发送用户消息的配图缩略图（本会话内存字节）。
  /// 用 Wrap 自动换行；cacheWidth 限解码尺寸避免多张原图撑爆内存。
  Widget _buildSentGalleryThumbnails(List<Uint8List> images, ColorScheme cs) {
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: <Widget>[
        for (final Uint8List bytes in images)
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(
              bytes,
              width: 72,
              height: 72,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              cacheWidth: 200,
              errorBuilder: (_, __, ___) => Container(
                width: 72,
                height: 72,
                color: cs.surfaceContainerHighest,
                child: Icon(Icons.broken_image_outlined,
                    size: 18, color: cs.onSurfaceVariant),
              ),
            ),
          ),
      ],
    );
  }

  /// 构建消息卡片（支持高亮态）。
  ///
  /// 视觉分层：用户消息保留主题色气泡；Agent 消息用扣子（Coze）式描边容器——
  /// 整个回复（正文、结果卡片、照片）包进同一个圆角描边框，与用户气泡形成
  /// 对称的视觉分组；左侧内边距收紧，照片得以贴近左边框。
  Widget _buildMessageCard(BuildContext context, {bool highlight = false}) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final BorderRadius borderRadius = widget.isUser
        ? const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(6),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          )
        : BorderRadius.circular(14);

    final Decoration decoration;
    if (widget.isUser) {
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        color: cs.primaryContainer,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: cs.primary.withValues(alpha: 0.15),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      );
    } else {
      // Agent 回复：扣子式描边框（浅底 + 清晰描边），不再是「无底色无边框平铺」。
      // 暖色模式走白底卡片：框内表头/行内代码/描边都是冷蓝调，画布也是蓝白，
      // 若沿用侧栏中性灰(#F0F1F3)会色相相斥、观感突兀（2026-09-18 用户反馈）；
      // 描边加深到与暖色 CardTheme 一致的 0.55，否则白底在蓝白画布上分不出边界。
      // 深色模式维持原浅底。
      final AppThemeVariant themeVariant = AppThemeController.instance.value;
      final bool isWarm = themeVariant == AppThemeVariant.warm;
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        color: isWarm
            ? AppPalette.cardBackgroundWarm
            : cs.surfaceContainerLow.withValues(alpha: 0.4),
        border: Border.all(
          color: cs.outline.withValues(alpha: isWarm ? 0.55 : 0.32),
        ),
      );
    }

    return Container(
      decoration: highlight
          ? BoxDecoration(
              borderRadius:
                  widget.isUser ? borderRadius : BorderRadius.circular(14),
              color: Colors.red.withValues(alpha: 0.08),
              border: Border.all(
                color: Colors.red.withValues(alpha: 0.4),
              ),
            )
          : decoration,
      child: ClipRRect(
        borderRadius: widget.isUser ? borderRadius : BorderRadius.circular(14),
        child: Padding(
          padding: widget.isUser
              ? widget.cardPadding
              // 左 10：照片与描边框只留一点距离；右/上/下给文字留呼吸感。
              : const EdgeInsets.fromLTRB(10, 8, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (widget.isUser &&
                  widget.userGalleryImages != null &&
                  widget.userGalleryImages!.isNotEmpty)
                // 本会话发出的用户消息：直接渲染配图缩略图，用户能确认
                // 「图确实发出去了、发的是这几张」。字节仅在内存，
                // 重启/历史加载后走下方「配图 ×N」文案回退。
                Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: _buildSentGalleryThumbnails(
                      widget.userGalleryImages!, cs),
                )
              else if (widget.mainMessage.attachmentImageCount > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(
                        Icons.photo_camera_outlined,
                        size: 14,
                        color: widget.isUser
                            ? Theme.of(context).colorScheme.onPrimaryContainer
                            : Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        "配图 ×${widget.mainMessage.attachmentImageCount}",
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: widget.isUser
                                  ? Theme.of(context)
                                      .colorScheme
                                      .onPrimaryContainer
                                  : Theme.of(context).colorScheme.primary,
                            ),
                      ),
                    ],
                  ),
                ),
              // 消息正文
              _buildMessageTextInner(
                context,
                widget.cs,
                widget.mainMessage,
                isUser: widget.isUser,
                contentSummary: widget.contentSummary,
                onUserAction: widget.onUserAction,
                onFollowupTap: widget.onFollowupTap,
                // 打字机：assistant 流式消息用「已 reveal」前缀渲染，
                // 光标随打字闪烁；非打字场景传 null 走原文。
                typewriterRawText: (!widget.isUser && _typewriter.isPartial)
                    ? _typewriter.revealed
                    : null,
                typewriterCursor:
                    _typewriter.isRevealing && _typewriter.cursorOn,
              ),
              // 边说边出图：流式阶段 `chat.media_ready` 推送的临时照片，
              // 插在正在打字的正文下方实时展示；`chat.assistant_done` 到达后
              // pendingMediaCards 被清空，由 renderBlocks 的最终顺序接管。
              if (!widget.isUser &&
                  widget.mainMessage.pendingMediaCards != null &&
                  widget.mainMessage.pendingMediaCards!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: buildPendingMediaCards(
                    widget.mainMessage.pendingMediaCards!,
                    cs,
                  ),
                ),
              if (!widget.isUser &&
                  widget.mainMessage.playUrl != null &&
                  widget.mainMessage.playUrl!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: _GomokuPlayUrlCard(
                    playUrl: widget.mainMessage.playUrl!,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 从父级 _ChatPageState 复用的消息文本构建（静态方法避免依赖实例）。
  /// 具体渲染逻辑已提取到共享渲染器 [buildMessageBody]，桌面端与手机端共用
  /// 同一实现，保证两端结构化渲染效果完全一致。
  static Widget _buildMessageTextInner(
    BuildContext context,
    ColorScheme cs,
    ChatMessage message, {
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
    void Function(AgentResultAction action,
            {required AgentResultData cardData})?
        onUserAction,

    /// 「接下来你可以」接续建议点击回调（null 不渲染建议行）
    void Function(String prompt)? onFollowupTap,

    /// 打字机「已 reveal」的原文前缀；null 时显示完整原文。
    /// 仅作用于下方纯文本分支（卡片/摘要仍用完整原文解析）。
    String? typewriterRawText,

    /// 是否在文本末尾显示闪烁光标（打字机进行中）
    bool typewriterCursor = false,
  }) {
    return buildMessageBody(
      context,
      cs,
      message,
      isUser: isUser,
      contentSummary: contentSummary,
      onUserAction: onUserAction,
      onFollowupTap: onFollowupTap,
      typewriterRawText: typewriterRawText,
      typewriterCursor: typewriterCursor,
      // 行程卡由消息行在气泡外独立渲染（第二条消息形态），body 内不再重复。
      excludeTravelCard: true,
    );
  }

  // 已下线：原「底部来源链接」组件（把正文裸 URL 抽成可点击域名 chip）。
  // 产品规则：任何卡片/消息下方都不再附来源链接，需要跳转时由卡片自身承载。
}

/// 删除确认栏：整轮问答对的高亮确认条。
///
/// 删除单位固定是「一轮问答对」，所以这里不再提供逐条勾选——勾选会暗示
/// 「可以只删其中一条气泡」，而提交时仍按整轮归约，属误导。改为明示将
/// 删除的条数 + 取消/确认两个动作。
class _DeleteConfirmBar extends StatelessWidget {
  const _DeleteConfirmBar({
    required this.selectedCount,
    required this.onConfirm,
    required this.onCancel,
  });

  final int selectedCount;
  final VoidCallback onConfirm;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Text(
            "删除这一轮（$selectedCount 条）",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: 8),
        // 取消按钮
        _ActionButton(
          icon: Icons.close,
          tooltip: "取消",
          onPressed: onCancel,
        ),
        const SizedBox(width: 2),
        // 确认删除按钮（整轮删除，始终可点）
        GestureDetector(
          onTap: onConfirm,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: Colors.red,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.delete_outline, size: 15, color: Colors.white),
                const SizedBox(width: 4),
                Text(
                  "删除",
                  style: TextStyle(fontSize: 12, color: Colors.white),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 操作栏中的单个图标按钮（透明背景）
class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final Color defaultColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return IconButton(
      tooltip: tooltip,
      icon: Icon(icon, size: 17, color: defaultColor),
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.all<Color>(Colors.transparent),
        overlayColor: WidgetStateProperty.all<Color>(
            Colors.black.withValues(alpha: 0.05)),
      ),
      onPressed: onPressed,
    );
  }
}

/// 工具函数：将一条消息转换为渲染用的 group 结构
Map<String, dynamic> _messageToGroup(ChatMessage msg) {
  if (msg.role == "assistant_progress") {
    return <String, dynamic>{
      "isUser": false,
      "main": msg,
      "progress": null,
      "isProgress": true,
    };
  }
  if (msg.role == "user") {
    return <String, dynamic>{
      "isUser": true,
      "main": msg,
      "progress": null,
      "isProgress": false,
    };
  }
  return <String, dynamic>{
    "isUser": false,
    "main": msg,
    "progress": null,
    "isProgress": false,
  };
}

/// 后台任务回执（contentType="task_receipt"，2026-09-08 前后台分工对话改造）。
///
/// 对话流内的轻量"状态屏"：非 IM 气泡——低对比底、细描边、一行目标 +
/// 可选进度小字；hover 才浮现取消入口（平时零视觉噪音，不打断对话阅读）。
/// 状态/进度由 `chat.task_update` 原地更新（main.dart 对同一 taskId 复用
/// 同一 messageId，只替换消息对象）；结果真正落位后整条回执被移除。
class _TaskReceiptBubble extends StatefulWidget {
  const _TaskReceiptBubble({required this.message, this.onCancel});

  final ChatMessage message;

  /// 取消回调（null 时 hover 不出现取消入口，仅展示状态）
  final void Function(String taskId)? onCancel;

  @override
  State<_TaskReceiptBubble> createState() => _TaskReceiptBubbleState();
}

class _TaskReceiptBubbleState extends State<_TaskReceiptBubble> {
  bool _hovering = false;

  static String _stateLabel(String? state) {
    switch (state) {
      case "running":
        return "进行中";
      case "awaiting_input":
        return "等待输入";
      case "done":
        return "已完成";
      case "failed":
        return "失败";
      case "cancelled":
        return "已取消";
      default:
        return "任务";
    }
  }

  /// 活跃任务的已运行时长（无 live 刷新：随每次 task_update 事件顺带更新）
  String? _elapsedLabel(ChatMessage msg) {
    if (msg.isTaskTerminal) return null;
    final int? startedAt = msg.taskStartedAt;
    if (startedAt == null || startedAt <= 0) return null;
    final int mins =
        (DateTime.now().millisecondsSinceEpoch - startedAt) ~/ 60000;
    if (mins < 1) return "刚刚开始";
    if (mins < 60) return "已 $mins 分钟";
    return "已 ${mins ~/ 60} 小时 ${mins % 60} 分";
  }

  Widget _statusIcon(ColorScheme cs, String? state) {
    switch (state) {
      case "done":
        return Icon(Icons.check_circle_outline, size: 16, color: cs.primary);
      case "failed":
        return Icon(Icons.error_outline, size: 16, color: cs.error);
      case "cancelled":
        return Icon(Icons.cancel_outlined,
            size: 16, color: cs.onSurfaceVariant);
      case "awaiting_input":
        return Icon(Icons.help_outline, size: 16, color: cs.tertiary);
      default:
        // running / 未知态：细旋转指示（进行中的"呼吸感"）
        return SizedBox(
          width: 14,
          height: 14,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
          ),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final ChatMessage msg = widget.message;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool active = !msg.isTaskTerminal;
    final String goal =
        (msg.taskGoal?.isNotEmpty == true) ? msg.taskGoal! : msg.text;
    final String? progress = active && (msg.taskProgress?.isNotEmpty == true)
        ? msg.taskProgress
        : null;
    final String? elapsed = _elapsedLabel(msg);
    final String trailing = elapsed ?? _stateLabel(msg.taskState);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: Opacity(
        opacity: active ? 1.0 : 0.75,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 2),
          padding: const EdgeInsets.fromLTRB(10, 7, 8, 7),
          decoration: BoxDecoration(
            color: cs.onSurface.withValues(alpha: 0.035),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              _statusIcon(cs, msg.taskState),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      goal,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: cs.onSurface.withValues(alpha: 0.85),
                            fontWeight: FontWeight.w500,
                            height: 1.25,
                          ),
                    ),
                    if (progress != null) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(
                        progress,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context)
                            .textTheme
                            .labelSmall
                            ?.copyWith(color: cs.onSurfaceVariant),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                trailing,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: cs.onSurfaceVariant.withValues(alpha: 0.9),
                    ),
              ),
              // hover 才出现的取消入口：与「发送新消息打断前台回复」分离——
              // 这里只取消任务面的这一条任务
              if (active && widget.onCancel != null && _hovering) ...<Widget>[
                const SizedBox(width: 4),
                SizedBox(
                  width: 26,
                  height: 26,
                  child: IconButton(
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    iconSize: 15,
                    tooltip: "取消此任务",
                    icon: Icon(Icons.close_rounded, color: cs.onSurfaceVariant),
                    onPressed: () {
                      final String? taskId = msg.taskId;
                      if (taskId != null && taskId.isNotEmpty) {
                        widget.onCancel!(taskId);
                      }
                    },
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 对话流决策卡（contentType="decision_card"，2026-10-14 定稿）。
///
/// 决策类通知（提醒升级链 popup 级 / 高重要度主动性消息）的统一承载面：
/// 不再飘独立弹窗或玻璃卡，直接落进对话流一张卡，与对话阅读流同源——
/// 上下文不丢（弹窗顶掉弹窗的问题不复存在），确认动作留在卡片本体上。
///
/// 视觉（黑白极简，与 task_receipt 同族但更醒目）：低对比深底 + 细描边 +
/// 优先级强调条（urgent 红 / high 琥珀 / normal 灰），标题加粗、正文常规；
/// pending 态给「确认」主按钮 +「忽略」次入口，操作后原地翻转为
/// 「已确认 / 已忽略」终态（透明度降低，作为对话记录保留）。
///
/// 回传由 main.dart 的 onConfirmDecisionCard 处理：attention → AttentionApi
/// ack（确认与忽略都算已知晓，升级链收敛）；proactive → outcome
/// accepted / dismissed。
class _DecisionCardBubble extends StatelessWidget {
  const _DecisionCardBubble({required this.message, this.onAction});

  final ChatMessage message;

  /// 确认/忽略回调（confirmed 区分两颗按钮；null 时按钮仅展示锁定态）
  final void Function(String messageId, bool confirmed)? onAction;

  Color _accent(ColorScheme cs) {
    final String priority =
        message.decisionCard?["priority"]?.toString() ?? "normal";
    return switch (priority) {
      "urgent" => cs.error,
      "high" => const Color(0xFFFFB020), // 琥珀（原右下角弹窗 high 档色）
      _ => cs.outline,
    };
  }

  String _priorityLabel() {
    final String priority =
        message.decisionCard?["priority"]?.toString() ?? "normal";
    return switch (priority) {
      "urgent" => "紧急",
      "high" => "重要",
      _ => "提醒",
    };
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Map<String, dynamic> card =
        message.decisionCard ?? const <String, dynamic>{};
    final String title = card["title"]?.toString() ?? message.text;
    final String body = card["message"]?.toString() ?? "";
    final bool confirmed = card["state"]?.toString() == "confirmed";
    final Color accent = _accent(cs);

    return Opacity(
      opacity: confirmed ? 0.6 : 1.0,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 380),
        decoration: BoxDecoration(
          color: cs.onSurface.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(13),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 优先级强调条
              Container(height: 3, color: accent),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    // 头行：图标 + 「紧急/重要/提醒 · 需要你确认」
                    Row(
                      children: <Widget>[
                        Icon(
                          confirmed
                              ? Icons.check_circle_outline
                              : Icons.notifications_active_outlined,
                          size: 15,
                          color: confirmed ? cs.primary : accent,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          confirmed
                              ? "${_priorityLabel()} · 已确认"
                              : "${_priorityLabel()} · 需要你确认",
                          style:
                              Theme.of(context).textTheme.labelSmall?.copyWith(
                                    color: cs.onSurfaceVariant,
                                    fontWeight: FontWeight.w600,
                                    letterSpacing: 0.3,
                                  ),
                        ),
                      ],
                    ),
                    if (title.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 8),
                      Text(
                        title,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.92),
                              fontWeight: FontWeight.w600,
                              height: 1.3,
                            ),
                      ),
                    ],
                    if (body.isNotEmpty && body != title) ...<Widget>[
                      const SizedBox(height: 4),
                      Text(
                        body,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.72),
                              height: 1.4,
                            ),
                      ),
                    ],
                    // 动作区：pending 态给确认主按钮 + 忽略次入口；
                    // 确认/忽略都算已知晓（升级链 / outcome 语义均收敛）
                    if (!confirmed) ...<Widget>[
                      const SizedBox(height: 10),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          FilledButton(
                            style: FilledButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                              backgroundColor:
                                  cs.onSurface.withValues(alpha: 0.9),
                              foregroundColor: cs.surface,
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 16),
                            ),
                            onPressed: onAction == null
                                ? null
                                : () => onAction!(message.messageId, true),
                            child: const Text("我知道了"),
                          ),
                          const SizedBox(width: 8),
                          TextButton(
                            style: TextButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                              foregroundColor: cs.onSurfaceVariant,
                            ),
                            onPressed: onAction == null
                                ? null
                                : () => onAction!(message.messageId, false),
                            child: const Text("忽略"),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
