import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "../core/models/chat_models.dart";
import "../core/services/side_chat_api.dart";
import "../core/theme/app_typography.dart";
import "../core/utils/agent_result_parser.dart";
import "../core/vision/pick_gallery_vision.dart";
import "../core/vision/vision_wire_frame.dart";
import "../features/chat/agent_result_card.dart";
import "../features/chat/evening_digest_card.dart";
import "../features/chat/message_body_renderer.dart";
import "../features/chat/typewriter_reveal.dart";
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
/// - 顶栏：居中标题 + 在线状态点
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

  /// 用户给 agent 取的名称（服务端 agentProfile.displayName）；
  /// 空/null 时顶栏不显示文字标题，只留在线状态点。
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
    final String title = runes.length > 16
        ? String.fromCharCodes(runes.take(16))
        : compact;
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
      leadingWidth: side ? 100 : 60,
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

  /// 旁聊顶栏「← 主会话」。
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
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.arrow_back_ios_new_rounded,
              size: 16, color: p.textPrimary),
          const SizedBox(width: 2),
          Text(
            "主会话",
            style: TextStyle(
              fontFamily: _kTopBarFontFamily,
              fontSize: 13,
              color: p.textPrimary,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  /// 旁聊顶栏标题：标题 + 「旁聊」标签 + 独立上下文副行。
  Widget _buildSideChatTitle(MobilePalette p) {
    final String title = (_controller.activeSideTitle ?? "").trim();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 160),
              child: Text(
                title.isEmpty ? "旁聊" : title,
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
            ),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: Theme.of(context).brightness == Brightness.dark
                    ? Colors.white.withValues(alpha: 0.05)
                    : p.surface.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                  color: Theme.of(context).brightness == Brightness.dark
                      ? Colors.white.withValues(alpha: 0.12)
                      : p.divider.withValues(alpha: 0.8),
                ),
              ),
              child: Text(
                "旁聊",
                style: TextStyle(
                  fontFamily: _kTopBarFontFamily,
                  fontSize: 10.5,
                  letterSpacing: 0.5,
                  color: Theme.of(context).brightness == Brightness.dark
                      ? const Color(0xFFA9ADBA)
                      : p.textSecondary,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          "独立上下文 · 不影响主会话",
          style: TextStyle(
            fontFamily: _kTopBarFontFamily,
            fontSize: 11.5,
            letterSpacing: 0.2,
            color: Theme.of(context).brightness == Brightness.dark
                ? const Color(0xFF8A8E99)
                : p.textMuted,
          ),
        ),
      ],
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

  Widget _buildTitle(BuildContext context, MobilePalette p) {
    // 2026-11-07 反馈：顶栏不再展示 agent 名字（小蛇），只保留在线状态点。
    final Widget statusDot = ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        return Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: _controller.isConnected ? p.online : p.textMuted,
          ),
        );
      },
    );
    return statusDot;
  }

  Widget _buildMessageList(BuildContext context, MobilePalette p) {
    if (_controller.messages.isEmpty) {
      return _buildEmpty(p);
    }
    // 长按/拖拽选中消息文字复制（与桌面端 SelectionArea 行为对齐）
    // reverse:true 底部锚定（2026-10-13）：index 0 = 最新消息（列表底部）,
    // 旧消息向视觉顶部延伸;offset 0 恒锚最新,重进不再需要滚位计算。
    return SelectionArea(
      child: ListView.builder(
        controller: _scroll,
        reverse: true,
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
        itemCount: _controller.messages.length,
        itemBuilder: (context, index) {
          final ChatMessage m =
              _controller.messages[_controller.messages.length - 1 - index];
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
            // 气泡外独立卡（2026-11-07 拍板扩展）：travel_itinerary 大卡与
            // reminder_confirm 提醒确认卡都不框进气泡外壳——气泡只装文字，
            // 卡自带完整外观跟在下方作为独立消息元素（与桌面端同款做法见
            // chat_page._buildMessageColumn）。卡从信封块/正文标记原位读出，
            // card.update 原地换卡后这里同样实时生效。
            final AgentResultData? travelCard = _travelItineraryCardOf(m);
            final AgentResultData? reminderCard =
                travelCard == null ? _reminderConfirmCardOf(m) : null;
            final AgentResultData? standaloneCard = travelCard ?? reminderCard;
            if (standaloneCard != null) {
              final bool hasBubbleText = _assistantBubbleHasVisibleText(m);
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (hasBubbleText) _buildBubble(context, m, isUser, p),
                  Padding(
                    padding: EdgeInsets.only(
                        top: hasBubbleText ? AppTypography.space2 : 0),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: AgentResultCard(data: standaloneCard),
                    ),
                  ),
                ],
              );
            }
          }
          return _buildBubble(context, m, isUser, p);
        },
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
      BuildContext context, ChatMessage m, bool isUser, MobilePalette p) {
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
                          for (final Uint8List bytes in images)
                            ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: Image.memory(
                                bytes,
                                width: 76,
                                height: 76,
                                fit: BoxFit.cover,
                                gaplessPlayback: true,
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
            // 并接入与桌面端共用的打字机逐字 reveal。
            : _TypewriterAssistantBody(
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

/// 提取助手消息携带的 travel_itinerary 行程卡（无则 null）。
///
/// 与桌面端 chat_page._agentResult 同口径：优先从消息文本解析卡片标记
/// （行程卡的权威通道——服务端确定性附卡写在 finalText 里）；blocks 信封
/// 里的 card 块作兜底（text 通道被剥卡的历史消息仍能取到）。
AgentResultData? _travelItineraryCardOf(ChatMessage m) {
  if (m.role == "user") return null;
  final AgentResultData? parsed = AgentResultParser.parse(m.text).data;
  if (parsed != null && parsed.cardType == "travel_itinerary") return parsed;
  final List<Map<String, dynamic>>? blocks = m.replyBlocks;
  if (blocks == null) return null;
  for (final Map<String, dynamic> b in blocks) {
    if ((b["type"]?.toString() ?? "") != "card") continue;
    final Object? cardJson = b["card"];
    if (cardJson is! Map<String, dynamic>) continue;
    final AgentResultData data = AgentResultData.fromJson(cardJson);
    if (data.cardType == "travel_itinerary") return data;
  }
  return null;
}

/// 提取助手消息携带的 reminder_confirm 提醒确认卡（无则 null）。
///
/// 与 [_travelItineraryCardOf] 同口径，但多一条信封块通道：分泡活轮的卡片
/// 标记不会写进气泡文本（finalText 才有标记，气泡只装各自的分段正文），
/// 卡只挂在末泡的 envelopeBlocks 里——信封通道是分泡轮的唯一活水，
/// 正文标记解析兜底历史消息与塌缩轮。
AgentResultData? _reminderConfirmCardOf(ChatMessage m) {
  if (m.role == "user") return null;
  final AgentResultData? parsed = AgentResultParser.parse(m.text).data;
  if (parsed != null && parsed.cardType == "reminder_confirm") return parsed;
  for (final List<Map<String, dynamic>>? blocks
      in <List<Map<String, dynamic>>?>[
    m.envelopeBlocks,
    m.replyBlocks,
  ]) {
    if (blocks == null) continue;
    for (final Map<String, dynamic> b in blocks) {
      if ((b["type"]?.toString() ?? "") != "card") continue;
      final Object? cardJson = b["card"];
      if (cardJson is! Map<String, dynamic>) continue;
      final AgentResultData data = AgentResultData.fromJson(cardJson);
      if (data.cardType == "reminder_confirm") return data;
    }
  }
  return null;
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

/// 助手消息正文(手机端):与桌面端共用 [buildMessageBody] 渲染器与
/// [TypewriterReveal] 打字机控制器,保证两端结构与流式节奏一致。
class _TypewriterAssistantBody extends StatefulWidget {
  const _TypewriterAssistantBody({
    required this.message,
    required this.cs,
    this.onUserAction,
    this.onFollowupTap,
  });

  final ChatMessage message;
  final ColorScheme cs;

  /// 卡片动作回调（与桌面端 chat_page 同链路）：选择型卡按钮 / chips
  /// 效果卡点击经它回传控制器，走 `chat.user_action` 协议。
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 「接下来你可以」接续建议点击回调（null 不渲染建议行）。
  final void Function(String prompt)? onFollowupTap;

  @override
  State<_TypewriterAssistantBody> createState() =>
      _TypewriterAssistantBodyState();
}

class _TypewriterAssistantBodyState extends State<_TypewriterAssistantBody> {
  late final TypewriterReveal _typewriter = TypewriterReveal(
    widget.message.text,
    animate: widget.message.streaming && widget.message.text.isNotEmpty,
  );

  @override
  void initState() {
    super.initState();
    _typewriter.addListener(_onTypewriterChanged);
  }

  void _onTypewriterChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant _TypewriterAssistantBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.message.text != oldWidget.message.text) {
      _typewriter.updateTarget(widget.message.text);
    }
  }

  @override
  void dispose() {
    _typewriter.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ChatMessage m = widget.message;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        buildMessageBody(
          context,
          widget.cs,
          m,
          isUser: false,
          // 卡片动作（选择型卡/chips）：与桌面端同协议回传 chat.user_action。
          onUserAction: widget.onUserAction,
          // 「接下来你可以」接续建议胶囊：与桌面端同渲染、同点击发送链路。
          onFollowupTap: widget.onFollowupTap,
          // 打字机:流式消息用「已 reveal」前缀渲染,光标随打字闪烁。
          typewriterRawText:
              _typewriter.isPartial ? _typewriter.revealed : null,
          typewriterCursor: _typewriter.isRevealing,
          // 行程卡由消息行在气泡外独立渲染（与桌面端同款第二条消息形态）,
          // body 内不再重复,避免双份。
          excludeTravelCard: true,
          // reminder_confirm 提醒确认卡同款外移（2026-11-07 拍板）：卡由
          // 消息行在气泡外独立渲染，body 内跳过。
          excludeCardTypes: const <String>["reminder_confirm"],
        ),
        // 边说边出图：流式阶段 `chat.media_ready` 推送的临时照片，
        // 插在正在打字的正文下方实时展示；`chat.assistant_done` 后
        // 由 renderBlocks 的最终顺序接管（与桌面端一致）。
        if (m.pendingMediaCards != null && m.pendingMediaCards!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: buildPendingMediaCards(m.pendingMediaCards!, widget.cs),
          ),
      ],
    );
  }
}
