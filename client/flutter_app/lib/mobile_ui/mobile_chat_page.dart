import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "../core/models/chat_models.dart";
import "../core/services/agent_name_store.dart";
import "../core/services/side_chat_api.dart";
import "../core/theme/app_typography.dart";
import "../core/utils/agent_result_parser.dart";
import "../core/vision/pick_gallery_vision.dart";
import "../core/vision/vision_wire_frame.dart";
import "../features/chat/agent_result_card.dart";
import "../features/chat/evening_digest_card.dart";
import "../features/chat/image_preview_panel.dart";
import "../features/chat/message_body_renderer.dart";
import "mobile_agent_status_orb.dart";
import "mobile_chat_controller.dart";
import "mobile_theme.dart";

/// 状态球左缘距屏幕左缘的缩进：与消息气泡左缘（列表 padding 16）左对齐，
/// 同一条竖线。
const double kAgentStatusOrbInset = 16;

/// 顶栏文字字体：与侧边栏统一使用 HarmonyOS Sans SC。
const String _kTopBarFontFamily = "HarmonyOS Sans SC";

/// 手机端对话主界面(白黑极简,跟随主题)。
///
/// - 顶栏：居中 agent 名牌胶囊（名称来自 [AgentNameStore]，未取名时留空）
/// - 消息区：用户黑底白字右对齐、助手浅灰底黑字左对齐
/// - 底部输入栏：圆角输入框(右侧「+」选照片) + 纯黑发送按钮
///
/// [controller] 可选：由外部(根组件)注入以共享连接；不传时自建。
class MobileChatPage extends StatefulWidget {
  const MobileChatPage({
    super.key,
    this.controller,
    this.agentName,
    this.onOpenSidebar,
  });

  final MobileChatController? controller;

  /// 用户给 agent 取的名称（服务端 agentProfile.displayName）。
  ///
  /// 只作 [AgentNameStore] 尚未灌值时的兜底：真名以 store 为准，
  /// 这样对话中取名（服务端 `identity_renamed`）顶栏胶囊当场浮现。
  final String? agentName;

  /// 左上角玻璃按钮：打开左侧边栏（旁聊列表）。
  final VoidCallback? onOpenSidebar;

  @override
  State<MobileChatPage> createState() => _MobileChatPageState();
}

class _MobileChatPageState extends State<MobileChatPage> {
  late final MobileChatController _controller;
  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();
  bool _canSend = false;
  int _lastMessageCount = 0;

  /// 待发送的相册图帧（「+」选入，随下一条消息一起发出）。
  final List<VisionWireFrame> _pendingFrames = <VisionWireFrame>[];

  /// 已发消息的气泡缩略图字节（messageId → 原图字节，仅内存态供展示）。
  final Map<String, List<Uint8List>> _sentImageBytes =
      <String, List<Uint8List>>{};

  @override
  void initState() {
    super.initState();
    _controller = widget.controller ?? MobileChatController();
    // 兜底灌值：外部已拿到名字（登录时读档案）就直接进唯一活水源，
    // 之后对话中改名由 identity_renamed 覆盖，不必等外部重建。
    _seedAgentName();
    _input.addListener(() {
      final bool now = _canSendNow();
      if (now != _canSend) {
        setState(() => _canSend = now);
      }
    });
  }

  bool _canSendNow() =>
      _input.text.trim().isNotEmpty || _pendingFrames.isNotEmpty;

  @override
  void didUpdateWidget(MobileChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 根组件重建时若注入新的控制器(一般不会),做切换。
    if (widget.controller != null && widget.controller != _controller) {
      _controller.dispose();
      _controller = widget.controller!;
      _lastMessageCount = 0;
    }
    // 外部档案晚到（登录后才拉到名字）：补灌进 store，顶栏胶囊随之出现。
    if (widget.agentName != oldWidget.agentName) _seedAgentName();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    // 仅当控制器是自建时才负责释放;外部注入的由根组件管理。
    if (widget.controller == null) {
      _controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    // 深色下背景由 main 壳的渐变辉光统一承接（设计稿 01 屏背景），
    // 本页只做透明承载；浅色主题仍用纯色，避免辉光透出。
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      backgroundColor: dark ? Colors.transparent : p.background,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(52),
        child: ListenableBuilder(
          listenable: _controller,
          builder: (context, _) => _buildTopBar(context, p),
        ),
      ),
      body: Column(
        children: [
          // 断线横幅（2026-11-10）：WS 掉线/重连期间必须可见——「假在线」曾让
          // 用户以为消息已发出，实际全沉在离线队列（服务端 WAL 半天无一条）。
          ListenableBuilder(
            listenable: _controller,
            builder: (context, _) => _buildConnectionBanner(context, p),
          ),
          Expanded(
            child: ListenableBuilder(
              listenable: _controller,
              builder: (context, _) {
                _maybeScrollToBottom();
                return _buildMessageList(context, p);
              },
            ),
          ),
          // 独立组件：思考链状态带长在消息区与输入栏之间，不进输入栏容器。
          _buildAgentStatusOrb(p),
          ListenableBuilder(
            listenable: _controller,
            builder: (context, _) => _buildInputBar(context, p),
          ),
        ],
      ),
    );
  }

  /// 断线横幅：WS 未连接时在消息区上方显示「连接断开 / 正在重连」。
  /// isConnected 由 ws_connected / ws_disconnected 事件驱动（controller），
  /// 首帧未连上时也会短暂显示「正在连接」——这是真实状态，不遮掩。
  Widget _buildConnectionBanner(BuildContext context, MobilePalette p) {
    if (_controller.isConnected) return const SizedBox.shrink();
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color bg = dark ? const Color(0xFF3A2A12) : const Color(0xFFFDF3E1);
    final Color fg = dark ? const Color(0xFFF5C169) : const Color(0xFF8A5A16);
    return Material(
      color: bg,
      child: SizedBox(
        width: double.infinity,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation<Color>(fg),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  "连接断开，正在自动重连…（期间发出的消息会在恢复后送达）",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: fg),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 仅在消息数量变化或新内容到达时滚到底,避免每次键盘输入都触发滚动。
  ///
  /// 列表 reverse:true（2026-10-13 重进定位根治）：offset 0 恒为最新消息
  /// 底部锚点。历史回填（本地恢复/服务端 _mergeServerTurns）把旧消息插在
  /// 列表远端（视觉顶部），只增长 maxScrollExtent、不扰动锚点，重进会话
  /// 天然定位在聊天最低部——不再依赖「postFrame 取 maxScrollExtent 再滚」
  /// 与惰性布局赛跑的竞态逻辑（正向列表下该估计值追不上回填,落点半山腰）。
  void _maybeScrollToBottom() {
    final int count = _controller.messages.length;
    final bool needScroll = count != _lastMessageCount ||
        (_lastMessageCount > 0 && _controller.isProcessing);
    _lastMessageCount = count;
    if (!needScroll) return;
    // 开场介绍阶段列表是按顶部对齐的正向列表（见 _buildMessageList），
    // offset 0 是顶部而非底部，不能套用「滚到底」语义。
    if (!_hasUserMessage) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      // 已锚在底部（offset 0）：reverse 列表下新消息自动入画,免动画。
      if (_scroll.offset <= 0) return;
      _scroll.animateTo(
        0,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  /// 「+」选照片：多选(上限与桌面端一致 4 张)进待发送区。
  Future<void> _pickImages() async {
    final List<VisionWireFrame> frames = await pickGalleryVisionWireFrames();
    if (frames.isEmpty) return;
    setState(() {
      _pendingFrames.addAll(frames);
      _canSend = _canSendNow();
    });
  }

  void _removePendingFrame(int index) {
    setState(() {
      _pendingFrames.removeAt(index);
      _canSend = _canSendNow();
    });
  }

  Future<void> _send() async {
    final String text = _input.text;
    final List<VisionWireFrame>? frames = _pendingFrames.isEmpty
        ? null
        : List<VisionWireFrame>.of(_pendingFrames);
    if (text.trim().isEmpty && frames == null) return;
    final String? messageId =
        await _controller.send(text, visionFrames: frames);
    _input.clear();
    if (messageId == null) {
      // 未发出(未连接)：文字输入保留清空行为与旧版一致，图帧留在待发送区
      if (frames != null && mounted) {
        setState(() => _canSend = _canSendNow());
      }
      return;
    }
    if (frames != null && mounted) {
      setState(() {
        _sentImageBytes[messageId] = <Uint8List>[
          for (final VisionWireFrame f in frames) Uint8List.fromList(f.bytes),
        ];
        _pendingFrames.clear();
        _canSend = _canSendNow();
      });
    }
    _maybeScrollToBottom();
    if (_controller.isSideChatActive) {
      unawaited(_autoTitleSideChat());
    }
  }

  /// 旁聊标题按内容再定：用户开口后，用首条用户消息生成标题，
  /// 不再固定显示「新旁聊」（用户已手动重命名过的不动）。
  Future<void> _autoTitleSideChat() async {
    final String current = (_controller.activeSideTitle ?? "").trim();
    if (current.isNotEmpty && current != "新旁聊") return;
    final String? fullId = _controller.activeSideSessionId;
    if (fullId == null) return;
    String seed = "";
    for (final ChatMessage m in _controller.messages) {
      if (m.role != "user") continue;
      final String text = m.text.trim();
      // 纯图消息落库文案是「（见图）」，不能当标题；等有文字再说。
      if (text.isNotEmpty && text != "（见图）") {
        seed = text;
        break;
      }
    }
    if (seed.isEmpty) return;
    final String compact = seed.replaceAll(RegExp(r"\s+"), " ").trim();
    final List<int> runes = compact.runes.toList();
    final String title =
        runes.length > 16 ? String.fromCharCodes(runes.take(16)) : compact;
    _controller.setActiveSideTitle(title);
    final String shortId = fullId.contains(":")
        ? fullId.substring(fullId.lastIndexOf(":") + 1)
        : fullId;
    final SideChatSummary? updated =
        await SideChatApi(baseUrl: ApiConfig.httpBase).rename(shortId, title);
    if (updated == null || !mounted) return;
    if (_controller.activeSideSessionId != fullId) return;
    _controller.setActiveSideTitle(updated.title);
  }

  Widget _buildTopBar(BuildContext context, MobilePalette p) {
    final bool side = _controller.isSideChatActive;
    return AppBar(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      toolbarHeight: 52,
      centerTitle: true,
      titleSpacing: 0,
      leadingWidth: 60,
      leading: Padding(
        padding: EdgeInsets.only(left: side ? 6 : 14, top: 7, bottom: 7),
        child: side
            ? _buildBackToMain(p)
            : _buildGlassButton(
                icon: Icons.menu_rounded,
                tooltip: "打开侧边栏",
                onTap: widget.onOpenSidebar,
                p: p,
              ),
      ),
      title: side ? _buildSideChatTitle(p) : _buildTitle(context, p),
      actions: side
          ? <Widget>[
              Padding(
                padding: const EdgeInsets.only(right: 14),
                child: _buildGlassButton(
                  icon: Icons.more_horiz_rounded,
                  tooltip: "旁聊菜单",
                  onTap: _showSideChatMenu,
                  p: p,
                  size: 34,
                ),
              ),
            ]
          : null,
    );
  }

  /// 左上角 38px 玻璃圆按钮（设计稿 01 屏汉堡键）。
  Widget _buildGlassButton({
    required IconData icon,
    required String tooltip,
    required MobilePalette p,
    VoidCallback? onTap,
    double size = 38,
  }) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: dark
                ? Colors.white.withValues(alpha: 0.07)
                : p.surface.withValues(alpha: 0.55),
            border: Border.all(
              color: dark
                  ? Colors.white.withValues(alpha: 0.10)
                  : p.divider.withValues(alpha: 0.8),
            ),
          ),
          child: Icon(
            icon,
            size: 18,
            color: dark ? const Color(0xFFE9EAEF) : p.textPrimary,
          ),
        ),
      ),
    );
  }

  /// 旁聊顶栏返回：只留返回箭头，不再带「主会话」文案。
  Widget _buildBackToMain(MobilePalette p) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () {
        if (!_controller.canSwitchSession) {
          _toast("正在回复，稍后再返回主会话");
          return;
        }
        unawaited(_controller.returnToMain());
      },
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Icon(
          Icons.arrow_back_ios_new_rounded,
          size: 18,
          color: p.textPrimary,
        ),
      ),
    );
  }

  /// 旁聊顶栏标题：只有首轮对话生成标题后才展示；未命名时不显示任何
  /// 占位文案（「新旁聊」/「旁聊」标签/「独立上下文 · 不影响主会话」副行已删除）。
  Widget _buildSideChatTitle(MobilePalette p) {
    final String title = (_controller.activeSideTitle ?? "").trim();
    if (title.isEmpty || title == "新旁聊") return const SizedBox.shrink();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 220),
      child: Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontFamily: _kTopBarFontFamily,
          color: p.textPrimary,
          fontSize: 17,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.2,
        ),
      ),
    );
  }

  /// 旁聊右上角菜单：长按列表同款的「重命名 / 删除」入口（真实后端接口）。
  Future<void> _showSideChatMenu() async {
    final String? fullId = _controller.activeSideSessionId;
    if (fullId == null) return;
    final String shortId = fullId.contains(":")
        ? fullId.substring(fullId.lastIndexOf(":") + 1)
        : fullId;
    final SideChatApi api = SideChatApi(baseUrl: ApiConfig.httpBase);
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: MobileTheme.of(context).surface,
      showDragHandle: true,
      builder: (BuildContext sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                leading: const Icon(Icons.edit_outlined),
                title: const Text("重命名旁聊"),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(_renameActiveSideChat(api, shortId));
                },
              ),
              ListTile(
                leading: const Icon(Icons.delete_outline_rounded),
                title: const Text("删除旁聊"),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(_deleteActiveSideChat(api, shortId));
                },
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _renameActiveSideChat(SideChatApi api, String shortId) async {
    final TextEditingController name =
        TextEditingController(text: _controller.activeSideTitle ?? "");
    final String? next = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("重命名旁聊"),
        content: TextField(
          controller: name,
          autofocus: true,
          maxLength: 40,
          decoration: const InputDecoration(hintText: "给这个旁聊起个名字"),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text("取消"),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(name.text.trim()),
            child: const Text("保存"),
          ),
        ],
      ),
    );
    name.dispose();
    if (next == null || next.isEmpty) return;
    final SideChatSummary? updated = await api.rename(shortId, next);
    if (!mounted) return;
    if (updated == null) {
      _toast("重命名失败，请稍后再试");
      return;
    }
    _controller.setActiveSideTitle(updated.title);
  }

  Future<void> _deleteActiveSideChat(SideChatApi api, String shortId) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("删除旁聊"),
        content: const Text("删除后该旁聊的独立历史会被清空，主会话不受影响。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final bool ok = await api.delete(shortId);
    if (!mounted) return;
    if (!ok) {
      _toast("删除失败，请稍后再试");
      return;
    }
    await _controller.returnToMain();
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// 把外部传入的名字灌进唯一活水源（store 已有值时不覆盖）。
  void _seedAgentName() {
    final String staged = (widget.agentName ?? "").trim();
    if (staged.isEmpty) return;
    // 延后到帧末写入：store 的监听者（含本页顶栏）会 setState，
    // initState / didUpdateWidget 阶段同步通知会撞 build。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final String current = (AgentNameStore.instance.name.value ?? "").trim();
      if (current.isNotEmpty) return;
      AgentNameStore.instance.set(staged);
    });
  }

  /// 顶栏名牌（2026-11-09 反馈定稿）：
  /// - 名字套一枚椭圆胶囊，居中显示，长名单行省略；
  /// - 不再有绿色在线状态点；
  /// - 未取名时整块留空（不显示空胶囊）。
  ///
  /// 名字读 [AgentNameStore]：对话中取名 → 服务端广播 `identity_renamed`
  /// → 控制器写 store → 这里即时重建，无需重进应用。
  Widget _buildTitle(BuildContext context, MobilePalette p) {
    return ValueListenableBuilder<String?>(
      valueListenable: AgentNameStore.instance.name,
      builder: (BuildContext context, String? storeName, _) {
        final String title = (storeName ?? widget.agentName ?? "").trim();
        if (title.isEmpty) return const SizedBox.shrink();
        final bool dark = Theme.of(context).brightness == Brightness.dark;
        return Container(
          constraints: const BoxConstraints(maxWidth: 200),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(
            // 与左上角玻璃按钮同一种玻璃底，顶栏两块元素读起来是一套。
            color: dark
                ? Colors.white.withValues(alpha: 0.07)
                : p.surface.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: dark
                  ? Colors.white.withValues(alpha: 0.10)
                  : p.divider.withValues(alpha: 0.8),
            ),
          ),
          child: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: _kTopBarFontFamily,
              color: dark ? const Color(0xFFE9EAEF) : p.textPrimary,
              fontSize: 14,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
              height: 1.2,
            ),
          ),
        );
      },
    );
  }

  /// 会话里是否已经有用户开口（false = 只有 agent 的开场介绍）。
  bool get _hasUserMessage =>
      _controller.messages.any((ChatMessage m) => m.role == "user");

  Widget _buildMessageList(BuildContext context, MobilePalette p) {
    if (_controller.messages.isEmpty) {
      return _buildEmpty(p);
    }
    // 开场介绍（首启引导的两泡问候）还没有用户回复时，列表按顶部对齐：
    // 底锚会让两泡问候孤零零贴在输入框上方、落在屏幕下半屏（2026-11-08
    // 反馈要求放到界面上方）。用户开口后恢复常规底部锚定。
    final bool openingOnly = !_hasUserMessage;
    // 开场白两泡依次到达（2026-11-09）：后一泡还在排队时，末尾挂一个
    // 「正在输入」气泡，让停顿看起来是对方在打字，而不是界面上凭空多一条。
    final bool typing = openingOnly && _controller.isIntroTyping;
    // 长按/拖拽选中消息文字复制（与桌面端 SelectionArea 行为对齐）
    // reverse:true 底部锚定（2026-10-13）：index 0 = 最新消息（列表底部）,
    // 旧消息向视觉顶部延伸;offset 0 恒锚最新,重进不再需要滚位计算。
    return SelectionArea(
      child: ListView.builder(
        controller: _scroll,
        reverse: !openingOnly,
        padding: EdgeInsets.fromLTRB(14, openingOnly ? 24 : 6, 14, 8),
        itemCount: _controller.messages.length + (typing ? 1 : 0),
        // 按消息 id 复用 Element（2026-11-11 闪卡根治）：reverse 列表下每追加
        // 一条消息（用户气泡 / turn_started 空占位），所有已有消息的 index 都
        // 后移一格；无 key 时 Sliver 按位置匹配，相邻消息 widget 结构不同就整
        // 棵子树重建——AgentResultCard 的入场动画重播，表现为「提问时卡片闪
        // 一下」。key + findChildIndexCallback 让漂移后仍按 id 找回旧 Element。
        findChildIndexCallback: (Key key) {
          if (key is! ValueKey<String>) return null;
          final int msgIndex = _controller.messages
              .indexWhere((ChatMessage m) => m.messageId == key.value);
          if (msgIndex < 0) return null;
          final int viewIndex = openingOnly
              ? msgIndex
              : _controller.messages.length - 1 - msgIndex;
          if (typing && viewIndex >= _controller.messages.length) return null;
          return viewIndex;
        },
        itemBuilder: (context, index) {
          if (typing && index == _controller.messages.length) {
            return _buildTypingBubble(p);
          }
          // 正向列表（开场介绍）index 即消息顺序；reverse 列表 index 0 是最新。
          final ChatMessage m = _controller.messages[
              openingOnly ? index : _controller.messages.length - 1 - index];
          return KeyedSubtree(
            key: ValueKey<String>(m.messageId),
            child: _buildMessageItem(context, m, p),
          );
        },
      ),
    );
  }

  /// 单条消息 → widget 的分发（不含 key 外壳，见 _buildMessageList）。
  Widget _buildMessageItem(
      BuildContext context, ChatMessage m, MobilePalette p) {
    final bool isUser = m.role == "user";
    if (m.streaming && m.text.isEmpty) {
      // 处理状态由输入框上方的状态条承载（对齐桌面端：占位不进消息流），
      // 这里只留空位，避免多出一个空气泡。
      return const SizedBox.shrink();
    }
    if (m.contentType == "transfer_reminder") {
      // 接驳确认卡（agent.transfer_reminder）：行程段临近到达时
      // 服务端推送，「帮我叫车/不用了」一键回复。
      return _buildTransferReminderCard(context, m, p);
    }
    if (m.contentType == "evening_digest" && m.eveningDigest != null) {
      // 睡前备忘卡（2026-10-22 与桌面端对齐）：结构化块专属渲染，
      // 不框进气泡外壳（独立消息元素形态，卡自带完整外观）。
      return Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: EveningDigestCard(digest: m.eveningDigest!),
          ),
        ),
      );
    }
    if (!isUser) {
      // 首启引导·取名卡（2026-11-09 改版）：开场白第二泡自带候选名，
      // 问题正文与候选名列表合在同一个助手气泡块里（主动推送，无需
      // 用户先说话），点选即把答复以用户身份发出。
      final List<String> nameChoices = m.nameChoices ?? const <String>[];
      if (nameChoices.isNotEmpty) {
        return _buildNameChoicesCard(context, m, nameChoices, p);
      }
      // 气泡外独立卡·全量外移（2026-11-10 泛化）：气泡只装文字，
      // 所有结果卡一律全宽渲染在气泡下方。此前只有 travel_itinerary
      // 与 reminder_confirm 外移，其余卡（种草选择卡/需求确认卡等）
      // 挤在 73.8% 宽的气泡壳里，横向内容根本没法用。
      // 卡从信封块/正文标记原位读出，card.update 原地换卡同样实时生效。
      final List<AgentResultData> standaloneCards = _standaloneCardsOf(m);
      if (standaloneCards.isNotEmpty) {
        final bool hasBubbleText = _assistantBubbleHasVisibleText(m);
        final List<String> cardTypes = <String>[
          for (final AgentResultData c in standaloneCards) c.cardType,
        ];
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (hasBubbleText)
              _buildBubble(context, m, isUser, p, excludeCardTypes: cardTypes),
            for (int i = 0; i < standaloneCards.length; i++)
              Padding(
                padding: EdgeInsets.only(
                    top: (hasBubbleText || i > 0) ? AppTypography.space2 : 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: AgentResultCard(data: standaloneCards[i]),
                ),
              ),
          ],
        );
      }
    }
    return _buildBubble(context, m, isUser, p);
  }

  /// 首启引导·取名卡（2026-11-09 改版，对照参考稿）：问题正文 + 候选名
  /// 整行铺满列表合在同一个助手气泡块里；配色全部走 [MobilePalette]
  /// （与主题一致，浅深色自适应）。点选即把答复以用户身份发出（走原发
  /// 消息链路，服务端据此走统一改名管道）。
  Widget _buildNameChoicesCard(
    BuildContext context,
    ChatMessage m,
    List<String> choices,
    MobilePalette p,
  ) {
    final String title = m.text.trim().isNotEmpty
        ? m.text.trim()
        : (m.nameCardTitle ?? "").trim();
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.738,
        ),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.fromLTRB(15, 11, 15, 5),
        decoration: BoxDecoration(
          color: p.assistantBubble,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(6),
            topRight: Radius.circular(MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (title.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10, left: 2, right: 2),
                child: Text(
                  title,
                  style: TextStyle(
                    color: p.assistantBubbleText,
                    fontSize: 13.5,
                    height: 1.45,
                  ),
                ),
              ),
            for (final String name in choices) _buildNameChoiceRow(name, p),
            // 末尾：自己起名（2026-11-09 反馈）——候选名之外留一个输入框，
            // 填完回车或点右侧圆钮即以用户身份发出，与点选候选名同一条链路。
            _CustomNameInput(
              palette: p,
              onSubmit: (String name) =>
                  unawaited(_controller.send("就叫你「$name」吧")),
            ),
          ],
        ),
      ),
    );
  }

  /// 「正在输入」气泡（首启引导两泡之间的停顿）：与助手气泡同形同色，
  /// 三点依次呼吸；下一泡落屏时它随之消失。
  Widget _buildTypingBubble(MobilePalette p) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: BoxDecoration(
          color: p.assistantBubble,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(6),
            topRight: Radius.circular(MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: _TypingDots(color: p.assistantBubbleText),
      ),
    );
  }

  /// 候选名一行（参考稿样式）：整行铺满的圆角块（页面底色 + divider 描边），
  /// 点整行即选中。
  Widget _buildNameChoiceRow(String name, MobilePalette p) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: p.background,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: p.divider),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => unawaited(_controller.send("就叫你「$name」吧")),
          child: SizedBox(
            width: double.infinity,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 接驳确认卡（agent.transfer_reminder，2026-10-18）：行程段临近到达时
  /// 服务端推送。卡面 = 提醒文案 + 出发地→目的地 + 到达时刻 + 车次/航班号，
  /// pending 给「帮我叫车/不用了」两个一键回复；点击经控制器走现有发消息
  /// 链路以用户身份发出固定文本，卡原地收起（隐藏按钮并翻转终态）。
  /// 卡片外壳（surface 底 + 14 圆角 + divider 描边）。
  Widget _buildTransferReminderCard(
      BuildContext context, ChatMessage m, MobilePalette p) {
    final Map<String, dynamic> card =
        m.transferReminder ?? const <String, dynamic>{};
    final Map<String, dynamic> segment = card["segment"] is Map<String, dynamic>
        ? card["segment"] as Map<String, dynamic>
        : const <String, dynamic>{};
    final String message = (card["message"]?.toString() ?? m.text).trim();
    final String from = segment["from"]?.toString() ?? "";
    final String to = segment["to"]?.toString() ?? "";
    final bool isFlight = segment["type"]?.toString() == "flight";
    final String no = segment["no"]?.toString() ?? "";
    final String state = card["state"]?.toString() ?? "pending";
    final bool settled = state != "pending";

    // 到达时刻 HH:mm（arrTime 为 ISO8601 含时区，解析失败则不展示该段）
    String arrivalHm = "";
    final Object? rawArr = segment["arrTime"];
    if (rawArr != null) {
      try {
        final DateTime arr = DateTime.parse(rawArr.toString());
        arrivalHm =
            "${arr.hour.toString().padLeft(2, "0")}:${arr.minute.toString().padLeft(2, "0")}";
      } catch (_) {
        arrivalHm = "";
      }
    }
    final Object? rawMinutes = card["minutesUntilArrival"];
    final int? minutes = rawMinutes is int ? rawMinutes : null;

    // 信息行：15:30 到达 · 车次 G123 · 约 30 分钟后到达
    final List<String> infoParts = <String>[
      if (arrivalHm.isNotEmpty) "$arrivalHm 到达",
      if (no.isNotEmpty) "${isFlight ? "航班" : "车次"} $no",
      if (minutes != null) "约 $minutes 分钟后到达",
    ];

    final String stateLabel = switch (state) {
      "accepted" => "已帮你叫车",
      "declined" => "已取消",
      _ => "需要你确认",
    };

    return Align(
      alignment: Alignment.centerLeft,
      child: Opacity(
        opacity: settled ? 0.6 : 1.0,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          constraints: const BoxConstraints(maxWidth: 300),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: p.divider),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Icon(
                    settled
                        ? Icons.check_circle_outline
                        : Icons.local_taxi_outlined,
                    size: 15,
                    color: state == "accepted" ? p.online : p.textSecondary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      "接驳提醒 · $stateLabel",
                      style: TextStyle(
                        color: p.textSecondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                      ),
                    ),
                  ),
                ],
              ),
              if (message.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  message,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                  ),
                ),
              ],
              if (from.isNotEmpty || to.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        from,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: p.textSecondary, fontSize: 13),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      child: Icon(Icons.arrow_forward_rounded,
                          size: 13, color: p.textMuted),
                    ),
                    Flexible(
                      child: Text(
                        to,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: p.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
              if (infoParts.isNotEmpty) ...<Widget>[
                const SizedBox(height: 4),
                Text(
                  infoParts.join(" · "),
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                ),
              ],
              if (!settled) ...<Widget>[
                const SizedBox(height: 10),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    FilledButton(
                      style: FilledButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        backgroundColor: p.textPrimary,
                        foregroundColor: p.background,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                      ),
                      onPressed: () => _controller.respondTransferReminder(
                          m.messageId, true),
                      child: const Text("帮我叫车"),
                    ),
                    const SizedBox(width: 8),
                    // 出发相位（返程去车站）额外给「导航去车站」：不叫车也能
                    // 一键开导航（服务端拼高德 Web 导航 URI，系统浏览器打开）
                    if ((card["phase"]?.toString() ?? "") == "pre_departure")
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: TextButton(
                          style: TextButton.styleFrom(
                            visualDensity: VisualDensity.compact,
                            foregroundColor: p.textPrimary,
                          ),
                          onPressed: () =>
                              _controller.openTransferNav(m.messageId),
                          child: const Text("导航去车站"),
                        ),
                      ),
                    TextButton(
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        foregroundColor: p.textSecondary,
                      ),
                      onPressed: () => _controller.respondTransferReminder(
                          m.messageId, false),
                      child: const Text("不用了"),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEmpty(MobilePalette p) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: p.surface,
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.auto_awesome_outlined,
              size: 30,
              color: p.textPrimary,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            "有什么可以帮你?",
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 17,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            "随时随地,随聊随答\n同一账号与桌面端数据同步",
            textAlign: TextAlign.center,
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 13,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }

  /// Agent 状态组件（思考链浮标）：**独立组件**，长在消息区与输入栏之间，
  /// 不嵌进输入栏容器、不与输入框连体。
  ///
  /// 文案裁决在控制器（`activityLabel`），这里只管「什么时候出现 / 淡入淡出」：
  /// 空闲时高度收回到 0（不留空白），干活时撑开一条状态带、淡入；文案变化原地
  /// 更新，不重建整块（避免闪）。
  ///
  /// 水平位置：球左缘 = [kAgentStatusOrbInset]，与消息气泡左缘左对齐。
  Widget _buildAgentStatusOrb(MobilePalette p) {
    return ListenableBuilder(
      listenable: _controller,
      builder: (BuildContext context, Widget? _) {
        final String? label = _controller.activityLabel;
        final bool live = label != null;
        return AnimatedSize(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          // 底对齐 + 不裁剪：收起/展开时球底部始终贴住输入框上边、整块向上
          // 长出来或沉回去，中途不会被剪掉半个球。
          alignment: Alignment.bottomLeft,
          clipBehavior: Clip.none,
          // 底部间距也随状态归零：空闲时这条带子的高度必须是 0，
          // 否则输入框上会常驻一道空隙。
          child: Padding(
            padding: EdgeInsets.only(
              left: kAgentStatusOrbInset,
              bottom: live ? 10 : 0,
            ),
            // 靠左钉住：Column 交叉轴默认居中，不套 Align 会把球推到屏幕中间。
            child: Align(
              alignment: Alignment.centerLeft,
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 200),
                switchInCurve: Curves.easeOut,
                switchOutCurve: Curves.easeIn,
                transitionBuilder:
                    (Widget child, Animation<double> animation) =>
                        FadeTransition(opacity: animation, child: child),
                child: live
                    ? MobileAgentStatusOrb(
                        key: const ValueKey<String>("orb-live"),
                        label: label,
                        percent: _controller.agentStatusPercent,
                        toolName: _controller.currentToolName,
                      )
                    : const SizedBox.shrink(key: ValueKey<String>("orb-idle")),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildBubble(
      BuildContext context, ChatMessage m, bool isUser, MobilePalette p,
      {List<String> excludeCardTypes = const <String>[]}) {
    final Color bubble = isUser ? p.userBubble : p.assistantBubble;
    final Color text = isUser ? p.userBubbleText : p.assistantBubbleText;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          // 设计稿气泡最大宽 236 / 320 ≈ 73.8%，按屏宽等比。
          maxWidth: MediaQuery.sizeOf(context).width * 0.738,
        ),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11),
        decoration: BoxDecoration(
          color: bubble,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(isUser ? MobileTheme.bubbleRadius : 6),
            topRight: Radius.circular(isUser ? 6 : MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: isUser
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // 随消息发出的照片缩略图（发送时记下的内存字节）
                  Builder(builder: (BuildContext ctx) {
                    final List<Uint8List>? images =
                        _sentImageBytes[m.messageId];
                    if (images == null || images.isEmpty) {
                      return const SizedBox.shrink();
                    }
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        alignment: WrapAlignment.end,
                        children: <Widget>[
                          // 点击缩略图 → 全屏大图查看（缩放/多图滑动/页码）。
                          // 用户图只有内存字节，走字节版查看页（无 URL）。
                          for (int i = 0; i < images.length; i++)
                            GestureDetector(
                              onTap: () => showImagePreviewFullScreenFromBytes(
                                ctx,
                                images: images,
                                index: i,
                                source: "发出的照片",
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: Image.memory(
                                  images[i],
                                  width: 76,
                                  height: 76,
                                  fit: BoxFit.cover,
                                  gaplessPlayback: true,
                                ),
                              ),
                            ),
                        ],
                      ),
                    );
                  }),
                  Text(
                    m.text,
                    style: const TextStyle(
                      fontSize: AppTypography.bodyLarge,
                      height: AppTypography.bodyLineHeight,
                    ).copyWith(color: text),
                  ),
                  // 离线待发送角标：断网时发出的消息入队等联网补发
                  if (m.pendingDelivery)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.schedule, size: 12, color: p.textMuted),
                          const SizedBox(width: 3),
                          Text(
                            "离线待发送",
                            style: TextStyle(
                              color: p.textMuted,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              )
            // 助手消息：复用桌面端同一共享渲染器，保证卡片 / 图文交错 /
            // [RENDER_AS] 标记等结构化内容与桌面端渲染效果完全一致；
            // 正文整泡落屏，不做打字机逐字 reveal（2026-11-10 下线）。
            : _AssistantBody(
                message: m,
                cs: Theme.of(context).colorScheme,
                // 卡片动作：带 messageId 交给控制器——有 cardAction 的按钮走
                // card.action（只换这张卡，不产生消息），其余仍走
                // chat.user_action（与桌面端 _handleCardAction 同协议）。
                onUserAction: (AgentResultAction action,
                        {required AgentResultData cardData}) =>
                    _controller.sendCardAction(
                  action,
                  cardData: cardData,
                  messageId: m.messageId,
                ),
                // 「接下来你可以」接续建议：点击即作为新消息发送（与桌面端同链路）。
                onFollowupTap: (String prompt) =>
                    unawaited(_controller.send(prompt)),
                excludeCardTypes: excludeCardTypes,
              ),
      ),
    );
  }

  /// 输入卡（2026-11-07 定稿·放大版）：通栏 52px 玻璃胶囊，左右各 10px 边距，
  /// 停在玻璃底栏上方；左「+」选图，右侧发送。
  Widget _buildInputBar(BuildContext context, MobilePalette p) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      color: Colors.transparent,
      padding: EdgeInsets.fromLTRB(
        10,
        8,
        10,
        // home Scaffold（extendBody）已把底栏高度并入 body 的 padding.bottom，
        // 这里只需再让胶囊停在玻璃 tab 栏上方（与设计稿间距一致）。
        MediaQuery.of(context).padding.bottom + 13,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 动作失败要当场可见（2026-11-06）：卡内按钮的报错（例如「这个平台
          // 需要登录才能下单」）原来只写进 controller，手机端从没渲染过，
          // 用户看到的就是「点了没反应」。这里补一条贴输入框的提示。
          if ((_controller.errorMessage ?? "").isNotEmpty)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.fromLTRB(6, 0, 6, 8),
              padding: const EdgeInsets.fromLTRB(11, 8, 11, 8),
              decoration: BoxDecoration(
                color: p.innerFieldBackground,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text(
                _controller.errorMessage!,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  height: 1.45,
                  color: p.textSecondary,
                ),
              ),
            ),
          if (_pendingFrames.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 0),
              child: _buildPendingStrip(p),
            ),
          Container(
            constraints: const BoxConstraints(minHeight: 52),
            padding: const EdgeInsets.only(left: 6, right: 6),
            decoration: BoxDecoration(
              // 输入胶囊：与主题背景同一灰色系（比页面略亮的中性灰），
              // 不再是贴黑的容器。
              color: dark ? const Color(0xFF232323) : p.surface,
              borderRadius: BorderRadius.circular(26),
              border: Border.all(
                color: dark
                    ? Colors.white.withValues(alpha: 0.07)
                    : p.divider.withValues(alpha: 0.7),
                width: 0.9,
              ),
              boxShadow: dark
                  ? <BoxShadow>[
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.24),
                        offset: const Offset(0, 8),
                        blurRadius: 20,
                      ),
                    ]
                  : null,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                _buildAttachButton(p),
                Expanded(
                  child: TextField(
                    controller: _input,
                    textInputAction: TextInputAction.send,
                    minLines: 1,
                    maxLines: 4,
                    onSubmitted: (_) => _send(),
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 14,
                      height: AppTypography.uiLineHeight,
                    ),
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      isCollapsed: true,
                      hintText:
                          _controller.isSideChatActive ? "在这个旁聊里继续说…" : "发消息…",
                      hintStyle: TextStyle(
                        color: Theme.of(context).brightness == Brightness.dark
                            ? const Color(0xFF8C8C8C)
                            : p.textMuted,
                        fontSize: 13.5,
                      ),
                      // 文案整体右移一点，和左侧「+」按钮留出呼吸距离。
                      contentPadding: const EdgeInsets.fromLTRB(10, 13, 4, 13),
                    ),
                  ),
                ),
                _buildSendButton(p),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 输入卡左侧「+」按钮：选相册照片随消息发出(与桌面端同 visionFrames 协议)。
  Widget _buildAttachButton(MobilePalette p) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _pickImages,
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Theme.of(context).brightness == Brightness.dark
              ? Colors.white.withValues(alpha: 0.07)
              : p.surface.withValues(alpha: 0.55),
          border: Border.all(
            color: Theme.of(context).brightness == Brightness.dark
                ? Colors.white.withValues(alpha: 0.07)
                : p.divider.withValues(alpha: 0.6),
          ),
        ),
        child: Icon(
          Icons.add_rounded,
          size: 19,
          color: Theme.of(context).brightness == Brightness.dark
              ? const Color(0xFFB9BCC5)
              : p.textSecondary,
        ),
      ),
    );
  }

  /// 待发送照片条：输入框上方横滑缩略图，右上角 × 移除。
  Widget _buildPendingStrip(MobilePalette p) {
    return SizedBox(
      height: 68,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: _pendingFrames.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (BuildContext context, int index) {
          return Stack(
            clipBehavior: Clip.none,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.memory(
                  Uint8List.fromList(_pendingFrames[index].bytes),
                  width: 60,
                  height: 60,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                ),
              ),
              Positioned(
                top: -6,
                right: -6,
                child: GestureDetector(
                  onTap: () => _removePendingFrame(index),
                  child: Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      color: p.textPrimary,
                      shape: BoxShape.circle,
                      border: Border.all(color: p.surface, width: 2),
                    ),
                    child: Icon(Icons.close, size: 12, color: p.background),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildSendButton(MobilePalette p) {
    final bool enabled = _canSend;
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    // 参考图 02：深色下发送键恒定「白底黑箭头」（空输入时也保持白钮，
    // 仅点击不生效），不再退成灰色块，保证输入胶囊的视觉重心一致。
    final Color bg = dark ? Colors.white : (enabled ? p.accent : p.divider);
    final Color fg =
        dark ? Colors.black : (enabled ? p.onAccent : p.textSecondary);
    return GestureDetector(
      onTap: enabled ? _send : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 40,
        height: 40,
        decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
        child: Icon(
          Icons.arrow_upward_rounded,
          color: fg,
          size: 19,
        ),
      ),
    );
  }
}

/// 提取助手消息携带的全部结果卡（气泡外全量外移渲染用）。
///
/// 三条通道合并去重，顺序即渲染顺序：
/// 1. `envelopeBlocks` —— 分泡活轮的唯一活水：卡片标记只写 finalText，
///    各气泡的 text 只有自己那段正文，卡全挂在末泡信封块上；
/// 2. `replyBlocks` —— 旧帧链兜底（text 通道被剥卡的历史消息仍能取到）；
/// 3. 正文标记解析 —— 塌缩轮/历史消息的卡写在 finalText 里。
///
/// 此前只有 travel_itinerary / reminder_confirm 走外移（各自一个专属
/// 取卡函数），其余卡挤在 73.8% 宽的气泡壳里。现在全量外移：任何结果卡
/// 都在全宽区渲染，`search_result`（已退役卡型）继续吞掉不渲染。
List<AgentResultData> _standaloneCardsOf(ChatMessage m) {
  if (m.role == "user") return const <AgentResultData>[];
  final List<AgentResultData> out = <AgentResultData>[];
  final Set<String> seen = <String>{};
  void add(AgentResultData? d) {
    if (d == null) return;
    if (d.cardType == "search_result") return;
    final String key = "${d.cardType}|${d.cardId}|${d.title}";
    if (!seen.add(key)) return;
    out.add(d);
  }

  for (final List<Map<String, dynamic>>? blocks
      in <List<Map<String, dynamic>>?>[m.envelopeBlocks, m.replyBlocks]) {
    if (blocks == null) continue;
    for (final Map<String, dynamic> b in blocks) {
      if ((b["type"]?.toString() ?? "") != "card") continue;
      final Object? cardJson = b["card"];
      if (cardJson is! Map) continue;
      add(AgentResultData.fromJson(Map<String, dynamic>.from(cardJson)));
    }
  }
  add(AgentResultParser.parse(m.text).data);
  return out;
}

/// 气泡里还有没有可见正文：卡外置后，若消息只剩卡（正文全被剥掉的历史形态），
/// 不再渲染空气泡壳。判定 = 正文剥卡标记后非空，或信封/回复块序列里有
/// 非 text 空的 text 块。
bool _assistantBubbleHasVisibleText(ChatMessage m) {
  final String stripped = m.text.replaceAll(
    RegExp(r"\[AGENT_RESULT_CARD_START\][\s\S]*?\[AGENT_RESULT_CARD_END]"),
    "",
  );
  if (stripped.trim().isNotEmpty) return true;
  for (final List<Map<String, dynamic>>? blocks
      in <List<Map<String, dynamic>>?>[
    m.envelopeBlocks,
    m.replyBlocks,
  ]) {
    if (blocks == null) continue;
    for (final Map<String, dynamic> b in blocks) {
      if ((b["type"]?.toString() ?? "text") != "text") continue;
      if ((b["text"]?.toString() ?? "").trim().isNotEmpty) return true;
    }
  }
  return false;
}

/// 取名卡末尾的「自己起个名字」输入框（2026-11-09 反馈）。
///
/// 候选名之外的另一条路：输入 1–12 字 → 回车或点右侧圆钮 → 以用户身份把
/// 「就叫你「X」吧」发出去（与点选候选名走同一条发消息链路，改名仍由服务端
/// 确定性管道落库，不额外开后门）。
class _CustomNameInput extends StatefulWidget {
  const _CustomNameInput({required this.palette, required this.onSubmit});

  final MobilePalette palette;
  final ValueChanged<String> onSubmit;

  @override
  State<_CustomNameInput> createState() => _CustomNameInputState();
}

class _CustomNameInputState extends State<_CustomNameInput> {
  final TextEditingController _ctrl = TextEditingController();
  bool _canSend = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _submit() {
    final String name = _ctrl.text.trim();
    if (name.isEmpty) return;
    _ctrl.clear();
    setState(() => _canSend = false);
    widget.onSubmit(name);
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = widget.palette;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.only(left: 12, right: 5, top: 3, bottom: 3),
        decoration: BoxDecoration(
          color: p.background,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: p.divider),
        ),
        child: Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _ctrl,
                maxLength: 12,
                textInputAction: TextInputAction.done,
                cursorColor: p.textPrimary,
                style: TextStyle(color: p.textPrimary, fontSize: 14),
                decoration: InputDecoration(
                  isDense: true,
                  counterText: "",
                  border: InputBorder.none,
                  hintText: "自己取一个…",
                  hintStyle: TextStyle(color: p.textMuted, fontSize: 13.5),
                  contentPadding: const EdgeInsets.symmetric(vertical: 11),
                ),
                onChanged: (String v) {
                  final bool now = v.trim().isNotEmpty;
                  if (now != _canSend) setState(() => _canSend = now);
                },
                onSubmitted: (_) => _submit(),
              ),
            ),
            const SizedBox(width: 6),
            SizedBox(
              width: 30,
              height: 30,
              child: Material(
                color: _canSend ? p.accent : p.divider,
                shape: const CircleBorder(),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: _canSend ? _submit : null,
                  child: Icon(
                    Icons.arrow_upward_rounded,
                    size: 17,
                    color: _canSend ? p.onAccent : p.textMuted,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 三点「正在输入」：依次呼吸，只在开场白两泡之间短暂出现。
class _TypingDots extends StatefulWidget {
  const _TypingDots({required this.color});

  final Color color;

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1080),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// 三角波（不引 dart:math）：相位错开 1/3 圈，透明度 0.3~0.9 呼吸。
  double _opacityOf(int i) {
    final double phase = (_c.value + i / 3) % 1.0;
    final double wave = phase < 0.5 ? phase * 2 : (1.0 - phase) * 2;
    return 0.3 + 0.6 * wave;
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (BuildContext context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < 3; i++)
              Padding(
                padding: EdgeInsets.only(right: i == 2 ? 0 : 5),
                child: Opacity(
                  opacity: _opacityOf(i),
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: widget.color,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// 助手消息正文(手机端):与桌面端共用 [buildMessageBody] 渲染器，保证
/// 卡片 / 图文交错 / [RENDER_AS] 标记等结构化内容渲染一致。
/// 2026-11-10：打字机逐字 reveal 在手机端下线——分泡轮正文整泡落屏
/// （由控制器按固定间隔逐泡揭示，观感是真人一条条发消息），
/// 不再逐字放大、不再渲染打字光标。
class _AssistantBody extends StatelessWidget {
  const _AssistantBody({
    required this.message,
    required this.cs,
    this.onUserAction,
    this.onFollowupTap,
    this.excludeCardTypes = const <String>[],
  });

  final ChatMessage message;
  final ColorScheme cs;

  /// 由消息行注入的外移卡型列表：这些卡在气泡外的全宽区渲染（见
  /// [_ChatMessagesState 的外移机制]），body 内跳过避免双份。
  final List<String> excludeCardTypes;

  /// 卡片动作回调（与桌面端 chat_page 同链路）：选择型卡按钮 / chips
  /// 效果卡点击经它回传控制器，走 `chat.user_action` 协议。
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 「接下来你可以」接续建议点击回调（null 不渲染建议行）。
  final void Function(String prompt)? onFollowupTap;

  @override
  Widget build(BuildContext context) {
    final ChatMessage m = message;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        buildMessageBody(
          context,
          cs,
          m,
          isUser: false,
          // 卡片动作（选择型卡/chips）：与桌面端同协议回传 chat.user_action。
          onUserAction: onUserAction,
          // 「接下来你可以」接续建议胶囊：与桌面端同渲染、同点击发送链路。
          onFollowupTap: onFollowupTap,
          // 行程卡等外移卡由消息行在气泡外全宽渲染，body 内不再重复。
          excludeTravelCard: true,
          // 外移卡型动态注入：reminder_confirm + 本轮所有外移卡（全量外移机制）。
          excludeCardTypes: excludeCardTypes,
        ),
        // 边说边出图：流式阶段 `chat.media_ready` 推送的临时照片，
        // 插在正文下方实时展示；`chat.assistant_done` 后
        // 由 renderBlocks 的最终顺序接管（与桌面端一致）。
        if (m.pendingMediaCards != null && m.pendingMediaCards!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: buildPendingMediaCards(m.pendingMediaCards!, cs),
          ),
      ],
    );
  }
}
