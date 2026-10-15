import "dart:typed_data";

import "package:flutter/material.dart";

import "../core/models/chat_models.dart";
import "../core/theme/app_typography.dart";
import "../core/utils/agent_result_parser.dart";
import "../core/vision/pick_gallery_vision.dart";
import "../core/vision/vision_wire_frame.dart";
import "../features/chat/agent_result_card.dart";
import "../features/chat/message_body_renderer.dart";
import "../features/chat/typewriter_reveal.dart";
import "mobile_chat_controller.dart";
import "mobile_theme.dart";

/// 手机端对话主界面(白黑极简,跟随主题)。
///
/// - 顶栏：居中标题 + 在线状态点
/// - 消息区：用户黑底白字右对齐、助手浅灰底黑字左对齐
/// - 底部输入栏：圆角输入框(右侧「+」选照片) + 纯黑发送按钮
///
/// [controller] 可选：由外部(根组件)注入以共享连接；不传时自建。
class MobileChatPage extends StatefulWidget {
  const MobileChatPage({super.key, this.controller});

  final MobileChatController? controller;

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
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: _buildTitle(context, p),
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
          _buildInputBar(context, p),
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
    final bool needScroll =
        count != _lastMessageCount ||
        (_lastMessageCount > 0 &&
            _controller.isProcessing);
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
  }

  Widget _buildTitle(BuildContext context, MobilePalette p) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          "智能助手",
          style: TextStyle(
            color: p.textPrimary,
            fontSize: 17,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.2,
          ),
        ),
        const SizedBox(width: 6),
        // 在线状态点：跟随后端连接状态
        ListenableBuilder(
          listenable: _controller,
          builder: (context, _) {
            return Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _controller.isConnected
                    ? p.online
                    : p.textMuted,
              ),
            );
          },
        ),
      ],
    );
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
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        itemCount: _controller.messages.length,
        itemBuilder: (context, index) {
          final ChatMessage m =
              _controller.messages[_controller.messages.length - 1 - index];
          final bool isUser = m.role == "user";
          if (m.streaming && m.text.isEmpty) {
            return _buildThinking(p);
          }
          if (m.contentType == "decision_card") {
            // 决策卡（2026-10-14 与桌面端对齐）：决策类通知直接落对话流，
            // 确认/忽略在卡上完成并回传 ack/outcome。
            return _buildDecisionCard(context, m, p);
          }
          if (!isUser) {
            // 行程卡独立第二条消息形态（2026-10-12 与桌面端对齐）：气泡只装
            // 文字，travel_itinerary 大卡不框进气泡外壳，作为独立消息元素
            // 跟在下方（卡自带完整外观与 460 限宽）。桌面端同款做法见
            // chat_page._buildMessageColumn。
            final AgentResultData? travelCard = _travelItineraryCardOf(m);
            if (travelCard != null) {
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _buildBubble(context, m, isUser, p),
                  Padding(
                    padding: const EdgeInsets.only(top: AppTypography.space2),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: AgentResultCard(data: travelCard),
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

  /// 对话流决策卡（2026-10-14 与桌面端同构）：低对比底 + 优先级强调条
  /// （urgent 红 / high 琥珀 / normal 灰），pending 给「我知道了/忽略」，
  /// 点击后经控制器回传 ack/outcome 并原地翻转为「已确认」终态。
  Widget _buildDecisionCard(BuildContext context, ChatMessage m, MobilePalette p) {
    final Map<String, dynamic> card = m.decisionCard ?? const <String, dynamic>{};
    final String title = card["title"]?.toString() ?? m.text;
    final String body = card["message"]?.toString() ?? "";
    final String priority = card["priority"]?.toString() ?? "normal";
    final bool confirmed = card["state"]?.toString() == "confirmed";
    final Color accent = switch (priority) {
      "urgent" => const Color(0xFFFF5C5C),
      "high" => const Color(0xFFFFB020),
      _ => p.divider,
    };
    final String priorityLabel = switch (priority) {
      "urgent" => "紧急",
      "high" => "重要",
      _ => "提醒",
    };

    return Align(
      alignment: Alignment.centerLeft,
      child: Opacity(
        opacity: confirmed ? 0.6 : 1.0,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          constraints: const BoxConstraints(maxWidth: 300),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: p.divider),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(13),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Container(height: 3, color: accent),
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Icon(
                            confirmed
                                ? Icons.check_circle_outline
                                : Icons.notifications_active_outlined,
                            size: 15,
                            color: confirmed ? p.online : accent,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            confirmed
                                ? "$priorityLabel · 已确认"
                                : "$priorityLabel · 需要你确认",
                            style: TextStyle(
                              color: p.textSecondary,
                              fontSize: 11,
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
                          style: TextStyle(
                            color: p.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            height: 1.3,
                          ),
                        ),
                      ],
                      if (body.isNotEmpty && body != title) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(
                          body,
                          style: TextStyle(
                            color: p.textSecondary,
                            fontSize: 13,
                            height: 1.4,
                          ),
                        ),
                      ],
                      if (!confirmed) ...<Widget>[
                        const SizedBox(height: 10),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            FilledButton(
                              style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                backgroundColor: p.textPrimary,
                                foregroundColor: p.background,
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 16),
                              ),
                              onPressed: () => _controller
                                  .confirmDecisionCard(m.messageId, true),
                              child: const Text("我知道了"),
                            ),
                            const SizedBox(width: 8),
                            TextButton(
                              style: TextButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                foregroundColor: p.textSecondary,
                              ),
                              onPressed: () => _controller
                                  .confirmDecisionCard(m.messageId, false),
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
      ),
    );
  }

  Widget _buildEmpty(MobilePalette p) {    return Center(
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

  Widget _buildThinking(MobilePalette p) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: p.assistantBubble,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(6),
            topRight: Radius.circular(MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: const _ThinkingDots(),
      ),
    );
  }

  Widget _buildBubble(BuildContext context, ChatMessage m, bool isUser, MobilePalette p) {
    final Color bubble = isUser ? p.userBubble : p.assistantBubble;
    final Color text = isUser ? p.userBubbleText : p.assistantBubbleText;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        margin: const EdgeInsets.symmetric(vertical: 6),
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
                    final List<Uint8List>? images = _sentImageBytes[m.messageId];
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
                // 卡片动作：支付确认卡按钮 / chips 追问等经控制器走
                // chat.user_action（与桌面端 _handleCardAction 同协议）。
                onUserAction: _controller.sendCardAction,
              ),
      ),
    );
  }

  Widget _buildInputBar(BuildContext context, MobilePalette p) {
    return Container(
      color: p.surface,
      padding: EdgeInsets.fromLTRB(12, 10, 12, MediaQuery.of(context).padding.bottom + 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (_pendingFrames.isNotEmpty) _buildPendingStrip(p),
          Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 0, 4, 0),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: p.innerFieldBackground,
                borderRadius: BorderRadius.circular(MobileTheme.inputRadius),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      textInputAction: TextInputAction.send,
                      minLines: 1,
                      maxLines: 5,
                      onSubmitted: (_) => _send(),
                      style: TextStyle(
                        color: p.textPrimary,
                        fontSize: AppTypography.bodyLarge,
                        height: AppTypography.uiLineHeight,
                      ),
                      decoration: InputDecoration(
                        hintText: "输入消息…",
                        hintStyle: TextStyle(color: p.textMuted, fontSize: 16),
                        border: InputBorder.none,
                        isCollapsed: true,
                        contentPadding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                    ),
                  ),
                  _buildAttachButton(p),
                ],
              ),
            ),
          ),
          const SizedBox(width: 8),
          _buildSendButton(p),
        ],
      ),
      ],
    ),
    );
  }

  /// 输入框右侧「+」按钮：选相册照片随消息发出(与桌面端同 visionFrames 协议)。
  Widget _buildAttachButton(MobilePalette p) {
    return IconButton(
      tooltip: "发送照片",
      onPressed: _pickImages,
      icon: Icon(Icons.add, size: 26, color: p.textSecondary),
      constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
      padding: EdgeInsets.zero,
      splashRadius: 20,
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
    return GestureDetector(
      onTap: enabled ? _send : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: enabled ? p.accent : p.divider,
        ),
        child: Icon(
          Icons.arrow_upward_rounded,
          color: enabled ? p.onAccent : p.textSecondary,
          size: 22,
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

/// 助手消息正文(手机端):与桌面端共用 [buildMessageBody] 渲染器与
/// [TypewriterReveal] 打字机控制器,保证两端结构与流式节奏一致。
class _TypewriterAssistantBody extends StatefulWidget {
  const _TypewriterAssistantBody({
    required this.message,
    required this.cs,
    this.onUserAction,
  });

  final ChatMessage message;
  final ColorScheme cs;

  /// 卡片动作回调（与桌面端 chat_page 同链路）：选择型卡按钮 / chips
  /// 效果卡点击经它回传控制器，走 `chat.user_action` 协议。
  final void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction;

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
          // 打字机:流式消息用「已 reveal」前缀渲染,光标随打字闪烁。
          typewriterRawText: _typewriter.isPartial ? _typewriter.revealed : null,
          typewriterCursor: _typewriter.isRevealing,
          // 行程卡由消息行在气泡外独立渲染（与桌面端同款第二条消息形态）,
          // body 内不再重复,避免双份。
          excludeTravelCard: true,
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

/// 三颗跳动省略号,表示 Agent 正在思考。
class _ThinkingDots extends StatefulWidget {
  const _ThinkingDots();

  @override
  State<_ThinkingDots> createState() => _ThinkingDotsState();
}

class _ThinkingDotsState extends State<_ThinkingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
    _fade = Tween<double>(begin: 0.3, end: 1).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final double t = _controller.value;
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (int i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Opacity(
                  opacity: _fade.value.clamp(0, 1) * _dotPhase(t, i),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: p.assistantBubbleText,
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

  double _dotPhase(double t, int i) {
    final double p = (t - i * 0.2) % 1;
    return p < 0 ? 0 : (0.3 + 0.7 * p);
  }
}
