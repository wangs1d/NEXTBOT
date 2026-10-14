/// 消息附件类型。
enum MessageAttachmentType {
  audio,
  image,
  video,
}

/// 消息附件（语音 / 图片 / 视频）。
class MessageAttachment {
  MessageAttachment({
    required this.type,
    required this.url,
    this.durationMs,
    this.waveform,
    this.transcript,
    this.mimeType,
  });

  /// 附件类型。
  final MessageAttachmentType type;

  /// 可访问的 URL，如 `/agent/voice/messages/{actorId}/{msgId}.mp3`。
  final String url;

  /// 音频时长（毫秒），仅 type=audio 有效。
  final int? durationMs;

  /// 波形数据（0.0-1.0），仅 type=audio 有效；为 null 时用静默 placeholder 渲染。
  final List<double>? waveform;

  /// 文本备份（语音消息的转录文本），无障碍 / 不可播放时降级展示。
  final String? transcript;

  /// MIME 类型（如 `audio/mpeg`）。
  final String? mimeType;

  /// 从原始 JSON 构造（兼容服务端字段）。
  factory MessageAttachment.fromJson(Map<String, dynamic> json) {
    final typeStr = (json["type"] ?? "").toString().toLowerCase();
    MessageAttachmentType type;
    switch (typeStr) {
      case "audio":
        type = MessageAttachmentType.audio;
        break;
      case "image":
        type = MessageAttachmentType.image;
        break;
      case "video":
        type = MessageAttachmentType.video;
        break;
      default:
        // 默认按音频处理（语音消息主用场景）
        type = MessageAttachmentType.audio;
    }
    return MessageAttachment(
      type: type,
      url: (json["url"] ?? json["mediaUrl"] ?? "").toString(),
      durationMs: json["durationMs"] is int
          ? json["durationMs"] as int
          : (json["durationMs"] is num
              ? (json["durationMs"] as num).toInt()
              : null),
      waveform: json["waveform"] is List
          ? (json["waveform"] as List)
              .map((e) => (e as num).toDouble())
              .toList()
          : null,
      transcript: json["transcript"]?.toString(),
      mimeType: json["mimeType"]?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
        "type": type.name,
        "url": url,
        if (durationMs != null) "durationMs": durationMs,
        if (waveform != null) "waveform": waveform,
        if (transcript != null) "transcript": transcript,
        if (mimeType != null) "mimeType": mimeType,
      };
}

class ChatSession {
  ChatSession({
    required this.sessionId,
    required this.title,
    required this.createdAt,
  });

  final String sessionId;
  final String title;
  final DateTime createdAt;
}

class ChatMessage {
  ChatMessage({
    required this.messageId,
    required this.sessionId,
    required this.role,
    required this.text,
    required this.timestamp,
    this.attachmentImageCount = 0,
    this.playUrl,
    this.attachments = const [],
    this.contentType = "text",
    this.durationMs,
    this.waveform,
    this.streaming = false,
    this.pendingDelivery = false,
    this.mediaCards,
    this.summaryCard,
    this.renderBlocks,
    this.replyBlocks,
    this.pendingMediaCards,
    this.followUpPrompts,
    this.decisionCard,
    this.taskId,
    this.taskState,
    this.taskGoal,
    this.taskProgress,
    this.taskStartedAt,
  });

  final String messageId;
  final String sessionId;
  final String role;
  final String text;
  final DateTime timestamp;
  /// 随本条用户消息发往服务端的配图张数（仅本地展示，不参与 WS 回包）。
  final int attachmentImageCount;
  /// 对局入口（来自 tool.result 或回复文本解析）。
  final String? playUrl;

  /// 是否为「正在流式接收中」的 assistant 消息。
  /// 仅内存态标志：渲染层据此对整条消息做打字机逐字展示；
  /// 持久化/历史加载均为 false（存储层重建消息时不带此字段）。
  final bool streaming;

  /// 是否为「离线待发送」的用户消息。
  ///
  /// 断网时发送的消息照常落气泡，但先入本地待发队列（随消息一起持久化）；
  /// 联网后由控制器补发，发送成功才翻转此标志。重启后仍显示「离线待发送」。
  final bool pendingDelivery;

  /// 消息附件列表（语音 / 图片 / 视频）。
  /// agent 发的语音消息、用户上传的语音消息都会落到这里。
  final List<MessageAttachment> attachments;

  /// 消息内容类型：`text` / `audio`。
  /// 用于区分纯文本消息和语音消息（用户端录音上传时使用）。
  final String contentType;

  /// 当 contentType=audio 时的音频时长（毫秒）。
  final int? durationMs;

  /// 当 contentType=audio 时的波形数据（0.0-1.0）。
  final List<double>? waveform;

  /// 结构化媒体卡片（Coze 式架构）。
  ///
  /// 来自服务端 `chat.assistant_done` 的 `mediaCards` 字段，独立于 LLM 文本。
  /// 前端遍历此列表直接渲染缩略图，不再依赖从 LLM 文本中解析
  /// `[AGENT_RESULT_CARD_START]` 标记。
  ///
  /// 每条包含：
  ///   - type: "image" | "video"
  ///   - title: 标题
  ///   - thumbnailUrl: 缩略图（优先本地 PNG）
  ///   - mediaUrl: 媒体地址
  ///   - pageUrl: 来源页
  ///   - source: 来源名称
  final List<Map<String, dynamic>>? mediaCards;

  /// 结构化摘要卡（CONTENT_SUMMARY 通道迁移，2026-10-10）。
  ///
  /// 来自服务端 `chat.assistant_done` 的 `summaryCard` 字段：服务端已把正文中
  /// 的 `[CONTENT_SUMMARY_V2_*]` 块确定性摘出，文本通道不再携带 JSON。
  /// 前端优先按本字段渲染折叠卡；历史消息（迁移前落库）仍走正文标记解析
  /// 兼容路径，两者渲染等价。
  final Map<String, dynamic>? summaryCard;

  /// 交错渲染块（renderBlocks）。
  ///
  /// 来自服务端 `chat.assistant_done` 的 `renderBlocks` 字段，与 `mediaCards`
  /// 配套下发：服务端已按「分组关键词在正文中的出现位置」把正文切成有序的
  /// 文字段与媒体组，前端按块顺序渲染即可实现
  /// 「一段文字介绍 → 一组照片 → 再一段文字 → 再一组照片」的自然阅读流，
  /// 替代旧行为「全部照片一次性铺在最前面」。
  ///
  /// 每条块：
  ///   - { type: "text", text: "..." }
  ///   - { type: "media", groupTitle: "...", sideA: "...", sideB: "...",
  ///       cards: [ 与 mediaCards 条目同构 ] }
  ///
  /// 为空/缺失时前端回退到旧逻辑（mediaCards 图廊 + 正文）。
  final List<Map<String, dynamic>>? renderBlocks;

  /// 回复信封块（reply blocks）。
  ///
  /// 来自服务端 `chat.assistant_done` 的 `blocks` 字段：服务端把 finalText 里的
  /// `[AGENT_RESULT_CARD_START/END]` 标记确定性拆成的结构化序列——
  ///   - { type: "text", text: "..." }
  ///   - { type: "card", card: { 与文本标记内 JSON 同构 } }
  ///
  /// text 仍是唯一事实源（blocks 是派生视图）：本字段仅随 done 实时下发、
  /// 不持久化——历史消息由正文标记解析路径重建，两端渲染等价。
  /// 为空/缺失时回退到正文标记解析（旧服务端/旧消息兼容）。
  final List<Map<String, dynamic>>? replyBlocks;

  /// 边说边出图的临时媒体卡片（瞬态，不持久化）。
  ///
  /// 流式阶段收到 `chat.media_ready` 时，把已搜到的照片先挂到当前回复消息上，
  /// 前端把图插到正在打字的正文下方实时展示；`chat.assistant_done` 到达后
  /// 以 `renderBlocks` 的最终顺序渲染，此字段被清空。
  final List<Map<String, dynamic>>? pendingMediaCards;

  /// 「接下来你可以」接续建议（NEXT_UP 协议，瞬态不持久化）。
  ///
  /// 来自服务端 `chat.assistant_done` 的 `followups` 字段：模型在回复末尾按需
  /// 生成的下一步任务句（1-3 条，用户口吻），服务端已从正文剥离标记。前端在
  /// 消息气泡下方渲染成可点击胶囊，点击即当作新消息发出。时机性内容——仅随
  /// done 实时下发，历史消息不带（对话推进后旧建议即失效）。
  final List<String>? followUpPrompts;

  /// 对话流内决策卡（contentType="decision_card"，2026-10-14 定稿）。
  ///
  /// 决策类通知（reminder_popup / 高重要度主动性消息）不再飘独立弹窗或
  /// 玻璃卡，直接落进对话流一张卡：用户点「确认/忽略」后由 main.dart
  /// 原地翻转 state 并回传 attention ack / proactive outcome。
  /// 内存态不持久化（同 task_receipt：重启后消失，服务端升级链自行收敛）。
  ///
  /// 载荷：
  ///   - kind: "attention" | "proactive"
  ///   - title / message / priority
  ///   - state: "pending" | "confirmed"
  ///   - attentionId: reminder_popup 的 ack 目标（kind=attention）
  ///   - deliveryId: 主动性消息的 outcome 目标（kind=proactive）
  final Map<String, dynamic>? decisionCard;

  // ===== 后台任务回执（contentType="task_receipt" 专用，2026-09-08）=====
  //
  // 前后台分工：task.dispatch 派发后台任务后，服务端以 chat.task_update 推送
  // 生命周期变更，客户端在对话流内落一张轻量回执（原地更新，不持久化——
  // 任务结果本身以 assistant 消息落位并持久化，回执只是进行中的“状态屏”）。

  /// 后台任务 id（TaskHub taskId）。
  final String? taskId;

  /// 任务生命周期态：running / awaiting_input / done / failed / cancelled。
  final String? taskState;

  /// 任务目标（一句话自包含）。
  final String? taskGoal;

  /// 最近一条进度行（工具调用/排队提示）。
  final String? taskProgress;

  /// 任务提交时间 epoch ms（算“已运行 X 分钟”用）。
  final int? taskStartedAt;

  /// 字段级拷贝（不可变模型的标准出口）：仅覆盖显式传入的字段。
  /// 离线补发翻转 [pendingDelivery]、状态带原地更新等场景用。
  ChatMessage copyWith({
    String? messageId,
    String? sessionId,
    String? role,
    String? text,
    DateTime? timestamp,
    int? attachmentImageCount,
    String? playUrl,
    bool? streaming,
    bool? pendingDelivery,
    List<MessageAttachment>? attachments,
    String? contentType,
    int? durationMs,
    List<double>? waveform,
    List<Map<String, dynamic>>? mediaCards,
    Map<String, dynamic>? summaryCard,
    List<Map<String, dynamic>>? renderBlocks,
    List<Map<String, dynamic>>? replyBlocks,
    List<Map<String, dynamic>>? pendingMediaCards,
    List<String>? followUpPrompts,
    Map<String, dynamic>? decisionCard,
    String? taskId,
    String? taskState,
    String? taskGoal,
    String? taskProgress,
    int? taskStartedAt,
  }) {
    return ChatMessage(
      messageId: messageId ?? this.messageId,
      sessionId: sessionId ?? this.sessionId,
      role: role ?? this.role,
      text: text ?? this.text,
      timestamp: timestamp ?? this.timestamp,
      attachmentImageCount: attachmentImageCount ?? this.attachmentImageCount,
      playUrl: playUrl ?? this.playUrl,
      streaming: streaming ?? this.streaming,
      pendingDelivery: pendingDelivery ?? this.pendingDelivery,
      attachments: attachments ?? this.attachments,
      contentType: contentType ?? this.contentType,
      durationMs: durationMs ?? this.durationMs,
      waveform: waveform ?? this.waveform,
      mediaCards: mediaCards ?? this.mediaCards,
      summaryCard: summaryCard ?? this.summaryCard,
      renderBlocks: renderBlocks ?? this.renderBlocks,
      replyBlocks: replyBlocks ?? this.replyBlocks,
      pendingMediaCards: pendingMediaCards ?? this.pendingMediaCards,
      followUpPrompts: followUpPrompts ?? this.followUpPrompts,
      decisionCard: decisionCard ?? this.decisionCard,
      taskId: taskId ?? this.taskId,
      taskState: taskState ?? this.taskState,
      taskGoal: taskGoal ?? this.taskGoal,
      taskProgress: taskProgress ?? this.taskProgress,
      taskStartedAt: taskStartedAt ?? this.taskStartedAt,
    );
  }

  /// 是否终态（回执上不再显示取消入口）。
  bool get isTaskTerminal {
    final String? s = taskState;
    return s == "done" || s == "failed" || s == "cancelled";
  }
}
