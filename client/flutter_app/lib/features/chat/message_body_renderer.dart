import "package:flutter/material.dart";

import "../../core/theme/app_typography.dart";

import "../../core/models/chat_models.dart";
import "../../core/services/content_summary_launcher.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/content_summary_parser.dart";
import "agent_action_choice_card.dart";
import "agent_result_card.dart";
import "assistant_brief_message.dart";
import "content_summary_card.dart";
import "content_summary_detail_formatter.dart";
import "content_summary_detail_modal.dart";
import "data_brief_message.dart";
import "image_result_message.dart";
import "inline_video_player.dart";
import "structured_assistant_message_body.dart";

/// 桌面端与手机端共用的「消息正文渲染器」。
///
/// 桌面端 [chat_page.dart] 与手机端 [mobile_chat_page.dart] 都调用同一实现，
/// 保证两端的结构化渲染效果完全一致：
/// - 智能体结果卡片 `[AGENT_RESULT_CARD_START]` 标记解析
/// - `renderBlocks` 交错渲染块（一段文字 → 一组照片 → 再一段文字）
/// - `mediaCards` 结构化媒体卡片
/// - `[RENDER_AS:xxx]` 显式展示形式路由（brief / structured / image_result /
///   data_brief / video）
/// - 内容摘要卡与 markdown 内联文本
/// - `followUpPrompts`「接下来你可以」接续建议胶囊（仅回调接线方展示）
Widget buildMessageBody(
  BuildContext context,
  ColorScheme cs,
  ChatMessage message, {
  required bool isUser,
  ContentSummaryParseResult? contentSummary,
  void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction,

  /// 打字机「已 reveal」的原文前缀；null 时显示完整原文。
  /// 仅作用于纯文本分支（卡片/摘要仍用完整原文解析）。
  String? typewriterRawText,

  /// 是否处于打字机打字中：光标常驻，闪烁节奏由渲染层的
  /// [_BlinkingCursor] 自带（480ms），布局不随闪烁跳动。
  bool typewriterCursor = false,

  /// 「接下来你可以」接续建议点击回调（传入即作为新消息发送）。
  /// null 时不渲染建议行（未接线方/纯展示场景）。
  void Function(String prompt)? onFollowupTap,

  /// travel_itinerary 卡不进 body（2026-09-25 用户定稿：卡片作为气泡外的
  /// 独立第二条消息形态渲染，见 chat_page 消息行拆分）；调用方自行在气泡外
  /// 渲染卡片。缺省 false=卡片照旧在 body 内（手机端/其他调用方行为不变）。
  bool excludeTravelCard = false,
}) {
  final Widget body = _buildAssistantBodyInner(
    context,
    cs,
    message,
    isUser: isUser,
    contentSummary: contentSummary,
    onUserAction: onUserAction,
    typewriterRawText: typewriterRawText,
    typewriterCursor: typewriterCursor,
    excludeTravelCard: excludeTravelCard,
  );
  if (isUser || onFollowupTap == null) return body;
  final List<String> followUps = message.followUpPrompts ?? const <String>[];
  if (followUps.isEmpty) return body;
  // 时机门：打字机逐字 reveal 未完成时先不出建议行。done 载荷（携带
  // followups）先于 reveal 结束到达，若立即渲染会「正文还在打字、建议已
  // 挂出来」；reveal 结束后本组件随 TypewriterReveal 通知重建，此处放行。
  if (typewriterRawText != null) return body;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      body,
      const SizedBox(height: AppTypography.space3),
      _buildFollowUpRow(context, cs, followUps, onFollowupTap),
    ],
  );
}

/// 「接下来你可以」接续建议行：灰色小标题 + 换行平铺胶囊，黑白极简。
/// 时机性内容（不持久化），仅当轮回复下发的 followups 非空时出现。
Widget _buildFollowUpRow(
  BuildContext context,
  ColorScheme cs,
  List<String> prompts,
  void Function(String prompt) onFollowupTap,
) {
  final TextStyle labelStyle =
      (Theme.of(context).textTheme.labelMedium ?? const TextStyle()).copyWith(
    fontSize: AppTypography.secondary,
    height: AppTypography.uiLineHeight,
    color: cs.onSurfaceVariant,
  );
  final TextStyle promptStyle =
      (Theme.of(context).textTheme.bodyMedium ?? const TextStyle()).copyWith(
    fontSize: AppTypography.body,
    height: AppTypography.uiLineHeight,
    color: cs.onSurface.withValues(alpha: 0.85),
  );

  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      Text("接下来你可以", style: labelStyle),
      const SizedBox(height: AppTypography.space2),
      Wrap(
        spacing: AppTypography.space2,
        runSpacing: AppTypography.space2,
        children: <Widget>[
          for (final String prompt in prompts)
            _FollowUpPill(
              prompt: prompt,
              style: promptStyle,
              borderColor: cs.outlineVariant,
              onTap: () => onFollowupTap(prompt),
            ),
        ],
      ),
    ],
  );
}

class _FollowUpPill extends StatelessWidget {
  const _FollowUpPill({
    required this.prompt,
    required this.style,
    required this.borderColor,
    required this.onTap,
  });

  final String prompt;
  final TextStyle style;
  final Color borderColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: borderColor),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
              horizontal: AppTypography.space4, vertical: AppTypography.space2),
          child: Text(prompt, style: style),
        ),
      ),
    );
  }
}

Widget _buildAssistantBodyInner(
  BuildContext context,
  ColorScheme cs,
  ChatMessage message, {
  required bool isUser,
  ContentSummaryParseResult? contentSummary,
  void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction,
  String? typewriterRawText,
  bool typewriterCursor = false,
  bool excludeTravelCard = false,
}) {
  if (isUser) {
    return Text(
      message.text,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onPrimaryContainer,
          ),
    );
  }

  // 回复信封块（reply blocks）：服务端已把卡片标记确定性拆成结构化块序列，
  // 这里按块直读渲染。v2 序列含 media 块——照片与卡片/正文同一条版式语义
  // （服务端 2026-09-18 统一编入，根治「带卡回复照片消失」）。
  // text 仍是事实源：历史消息无此字段（不持久化），走下方统一路径。
  final List<Map<String, dynamic>>? replyBlocks = message.replyBlocks;
  final bool hasMediaFields = (message.mediaCards?.isNotEmpty ?? false) ||
      (message.renderBlocks?.isNotEmpty ?? false) ||
      (message.pendingMediaCards?.isNotEmpty ?? false);
  if (replyBlocks != null && replyBlocks.isNotEmpty) {
    final bool blocksHaveMedia = replyBlocks
        .any((Map<String, dynamic> b) => b["type"]?.toString() == "media");
    // v1 blocks（纯 text/card）+ 消息带照片 → 不能在此渲染：照片不在 blocks 里，
    // 渲染即丢（升级前的缺陷形态）。落到下方统一路径合并渲染；
    // v2 blocks 或确无媒体的消息照常直读。
    if (blocksHaveMedia || !hasMediaFields) {
      final Widget? body = _buildReplyBlocksBody(
        context,
        cs,
        replyBlocks,
        onUserAction: onUserAction,
        excludeTravelCard: excludeTravelCard,
      );
      if (body != null) return body;
    }
  }

  // 统一路径（卡片 × 照片）：正文卡片标记、交错媒体块、mediaCards 三个来源
  // 合并成一条块序列渲染——历史消息（blocks 不落盘）与老服务端 v1 blocks 都
  // 走这里。此前「正文含卡片标记 → 渲染卡片即 return」会让排在其后的照片
  // 分支永远执行不到（带卡回复「卡片在、照片没了」的根因）；现在照片与
  // 卡片在同一序列合流，谁也不再挤掉谁。
  final List<Map<String, dynamic>>? renderBlocks = message.renderBlocks;
  final bool hasCardMarker = message.text.contains(AgentResultParser.startMarker);
  if (hasCardMarker || (renderBlocks != null && renderBlocks.isNotEmpty)) {
    final Widget? body = _buildUnifiedMediaCardBody(
      context,
      cs,
      message,
      onUserAction: onUserAction,
      excludeTravelCard: excludeTravelCard,
    );
    if (body != null) return body;
  }

  // （renderBlocks 已并入上方统一路径：卡片标记与照片在同一序列渲染，
  // 不再作为独立分支彼此抢占。）

  // 结构化摘要卡通道（2026-10-10 CONTENT_SUMMARY 迁移）：卡片随 done 的
  // summaryCard 字段下发，正文已不携带 JSON——这是权威路由，优先于一切
  // 文本解析分支。历史消息（迁移前落库）回退到下方正文标记解析路径。
  if (!isUser && message.summaryCard != null) {
    try {
      final ContentSummaryDataV2 structuredSummary =
          ContentSummaryDataV2.fromJson(message.summaryCard!);
      return ContentSummaryMessageBody(
        summary: structuredSummary,
        briefText: "",
        extraText: ContentSummaryParser.stripSummaryBlocks(
          typewriterRawText ?? message.text,
        ),
        onCardTap: () {
          if (!ContentSummaryLauncher.open(structuredSummary)) {
            ContentSummaryDetailModal.show(context, structuredSummary);
          }
        },
      );
    } catch (_) {
      // 载荷损坏：回退正文渲染（服务端保证损坏载荷整块剥离，正文是干净的）
    }
  }

  // 结构化媒体卡片（Coze 式架构）：独立于 LLM 文本渲染。
  //
  // 来自服务端 `chat.assistant_done` 的 `mediaCards` 字段，与 LLM 的文本回复
  // 完全解耦。前端直接构造 `AgentResultData` 卡片，不再依赖文本中
  // `[AGENT_RESULT_CARD_START]` 标记。
  //
  // 与 `AgentResultParser.parse` 不同：这里读取的是 `ChatMessage.mediaCards`
  // 字段（结构化数据），而非从消息文本中解析标记。
  final List<Map<String, dynamic>>? mediaCards = message.mediaCards;
  // 旧数据恢复：mediaCards 持久化之前的历史消息，照片是以「文本内嵌图片链接」存进
  // text 的（markdown 图 / /agent/images/ 代理路径 / http 图片扩展名）。重启后这些
  // 消息 mediaCards 为空，这里从正文把图片链接重新恢复成纯图廊，避免旧照片消失。
  // 带显式 [RENDER_AS:] 声明的消息不参与旧数据恢复——形态声明是权威路由
  // （否则识图照片卡 payload 里的 /agent/images URL 会被误判成旧消息内嵌图）。
  final bool hasExplicitRenderForm =
      _extractRenderAsMarker(message.text) != null;
  final List<String> recoveredImageUrls =
      (mediaCards == null || mediaCards.isEmpty) && !hasExplicitRenderForm
          ? _extractLegacyImageUrls(message.text)
          : const <String>[];
  if ((mediaCards != null && mediaCards.isNotEmpty) ||
      recoveredImageUrls.isNotEmpty) {
    final List<AgentResultItem> items = recoveredImageUrls.isNotEmpty
        ? recoveredImageUrls
            .map(
              (String url) => AgentResultItem(
                type: "image",
                text: "图片",
                mediaType: "image",
                thumbnailUrl: url,
                mediaUrl: url,
              ),
            )
            .toList()
        : mediaCards!.map(_cardToItem).toList();
    final AgentResultData mediaData = AgentResultData(
      cardType: "media",
      title: "",
      items: items,
      footer: "",
    );
    // 旧数据正文里可能残留图片链接行，展示前剥掉，避免与图廊重复。
    // 渲染层兜底（2026-10-10 搜图轮 CONTENT_SUMMARY 裸 JSON 泄漏）：mediaCards
    // 分支在本方法提前 return，走不到 contentSummary 折叠卡路由，因此展示文本
    // 必须先剥掉摘要块——照片是主形态时，块没有消费者，只剩裸 JSON 泄漏一途。
    // 形态声明必须在媒体卡片分支一并剥除：该分支在 RENDER_AS 路由之前提前
    // return，此前只剥摘要块，导致 [RENDER_AS:structured] 混在图片轮正文里露出。
    final String displayText = _stripRenderAsMarker(
      recoveredImageUrls.isNotEmpty
          ? _stripLegacyImageLines(message.text)
          : ContentSummaryParser.stripSummaryBlocks(message.text),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        AgentResultCard(data: mediaData),
        if (displayText.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: AppTypography.space2),
            // mediaCards 直挂轮的正文同样可能是结构化 markdown，走结构化渲染器
            // （纯叙述自动回退内联排版）。
            child: StructuredAssistantMessageBody(
              text: displayText,
              cs: cs,
              textTheme: Theme.of(context).textTheme,
            ),
          ),
      ],
    );
  }

  // [RENDER_AS:xxx] 标记路由：后端注入的显式展示形式声明
  {
    final String raw = typewriterRawText ?? message.text;
    final String? renderAs = _extractRenderAsMarker(raw);
    if (renderAs != null) {
      final String cleanText = _stripRenderAsMarker(raw);
      switch (renderAs) {
        case "brief":
          return AssistantBriefMessage(
            text: cleanText,
            colorScheme: cs,
          );
        case "structured":
          return StructuredAssistantMessageBody(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        case "image_result":
          return ImageResultMessage(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        case "data_brief": {
          final DataBriefPayload? payload = DataBriefMessage.tryParse(cleanText);
          if (payload == null) {
            // payload 缺失/损坏：回退结构化正文（保留 DATA_BRIEF 块原文）
            return StructuredAssistantMessageBody(
              text: cleanText,
              cs: cs,
              textTheme: Theme.of(context).textTheme,
              showCursor: typewriterCursor,
            );
          }
          return DataBriefMessage(
            payload: payload,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        }
        case "video": {
          // 视频抓取：解析 [VIDEO_MEDIA_START] 媒体块，内联渲染可播放视频
          final ({VideoMediaData? media, String cleaned}) parsed =
              parseVideoMediaBlock(cleanText);
          if (parsed.media != null) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                AgentInlineVideoPlayer(data: parsed.media!),
                if (parsed.cleaned.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: AppTypography.space2),
                    child: buildInlineMarkdownText(
                      parsed.cleaned,
                      AppTypography.assistantBody(Theme.of(context).textTheme, cs),
                      cs: cs,
                    ),
                  ),
              ],
            );
          }
          // 无媒体块：回退为普通正文（播放页链接仍可点击）
          return StructuredAssistantMessageBody(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        }
        default:
          break;
      }
    }
  }

  final ContentSummaryDataV2? summary = contentSummary?.summary;
  if (summary != null) {
    return ContentSummaryMessageBody(
      summary: summary,
      briefText: contentSummary!.briefText,
      extraText: contentSummary.cleanedText,
      structuredItems: contentSummary.structuredItems,
      onCardTap: () {
        // 宽屏：详情复用右侧双面板继续展示；无面板宿主（如手机端）回退弹窗
        if (!ContentSummaryLauncher.open(summary)) {
          ContentSummaryDetailModal.show(context, summary);
        }
      },
    );
  }

  // 最终兜底分支：剥展示形态声明行（[RENDER_HINT:xxx]/[RENDER_AS:xxx]）再渲染。
  // 权威的 [RENDER_AS:xxx] 路由在上方分支已消费；走到这里的是无路由标记的
  // 正文——历史消息（任务面旧结果等）残留的声明行按字面漏出的根因，渲染前
  // 兜底剥离，已落库的历史消息也能显示干净。
  return StructuredAssistantMessageBody(
    text: _stripRenderDeclarationLines(typewriterRawText ?? message.text),
    cs: cs,
    textTheme: Theme.of(context).textTheme,
    showCursor: typewriterCursor,
  );
}

/// 媒体卡 Map（renderBlocks / mediaCards / pendingMediaCards 三者同构）→ AgentResultItem。
/// 三处构建逻辑相同，提取共用，避免重复。
AgentResultItem _cardToItem(Map<String, dynamic> m) {
  return AgentResultItem(
    type: m["type"]?.toString() ?? "image",
    text: m["title"]?.toString() ?? "",
    mediaType: m["mediaType"]?.toString() ?? m["type"]?.toString() ?? "image",
    thumbnailUrl: m["thumbnailUrl"]?.toString(),
    mediaUrl: m["mediaUrl"]?.toString(),
    // 服务端解析出的可播流：非空时视频卡点击走右侧面板，不再跳外部链接。
    playableUrl: m["playableUrl"]?.toString(),
    pageUrl: m["pageUrl"]?.toString(),
    source: m["source"]?.toString(),
    caption: m["caption"]?.toString(),
    side: m["side"]?.toString(),
    sideLabel: m["sideLabel"]?.toString(),
    width: (m["width"] as num?)?.toInt(),
    height: (m["height"] as num?)?.toInt(),
  );
}

/// 卡片点击回调签名（与 buildMessageBody 的 onUserAction 参数同型）。
typedef _UserActionHandler = void Function(
  AgentResultAction action, {
  required AgentResultData cardData,
});

/// blocks 序列（v2：text/card/media）→ 正文 Widget。
/// 媒体块与卡片/正文同一条序列渲染；无任何可渲染块返回 null（调用方回退
/// 统一路径），保持「空 blocks 不拦截后续分支」的旧行为。
Widget? _buildReplyBlocksBody(
  BuildContext context,
  ColorScheme cs,
  List<Map<String, dynamic>> replyBlocks, {
  _UserActionHandler? onUserAction,
  bool excludeTravelCard = false,
}) {
  final List<Widget> blockWidgets = <Widget>[];
  for (final Map<String, dynamic> block in replyBlocks) {
    final String type = block["type"]?.toString() ?? "text";
    if (type == "card") {
      final Map<String, dynamic> cardJson =
          block["card"] as Map<String, dynamic>? ?? const <String, dynamic>{};
      final AgentResultData data = AgentResultData.fromJson(cardJson);
      _appendCardWidget(blockWidgets, cs, data, onUserAction,
          excludeTravelCard: excludeTravelCard);
    } else if (type == "media") {
      final Widget? media = _mediaBlockWidget(context, cs, block);
      if (media != null) blockWidgets.add(media);
    } else {
      final String text = block["text"]?.toString() ?? "";
      if (text.trim().isEmpty) continue;
      // 信封文本段可能是完整结构化 markdown（模型按 structured 范式写的
      // 标题/表格/引用/列表），走结构化正文渲染器：块级元素有区分度地渲染，
      // 纯叙述时其内部自动回退内联排版（此前直排内联导致 ### / |---| / >
      // 以源码符号裸露）。
      blockWidgets.add(
        StructuredAssistantMessageBody(
          text: text,
          cs: cs,
          textTheme: Theme.of(context).textTheme,
        ),
      );
    }
  }
  if (blockWidgets.isEmpty) return null;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: blockWidgets,
  );
}

/// 统一路径：卡片标记解析 × 交错媒体块，合成一条块序列渲染。
///
/// 基底取 renderBlocks（服务端按锚定切好的「文字段+媒体组」，text 段里嵌着
/// 卡片标记），缺省时以整段正文为单一文字块。文字段再析出卡片与散文；
/// mediaCards 仅在无 renderBlocks 时编组补尾（老服务端/任务面离线重放的
/// 载荷没有 renderBlocks，照片只在 mediaCards 里）。
Widget? _buildUnifiedMediaCardBody(
  BuildContext context,
  ColorScheme cs,
  ChatMessage message, {
  _UserActionHandler? onUserAction,
  bool excludeTravelCard = false,
}) {
  final List<Map<String, dynamic>>? renderBlocks = message.renderBlocks;
  final bool hasRenderBlocks = renderBlocks != null && renderBlocks.isNotEmpty;
  final bool hasCardMarker = message.text.contains(AgentResultParser.startMarker);
  final List<Map<String, dynamic>> base = hasRenderBlocks
      ? renderBlocks
      : <Map<String, dynamic>>[
          <String, dynamic>{"type": "text", "text": message.text},
        ];

  final List<Widget> blockWidgets = <Widget>[];

  for (final Map<String, dynamic> block in base) {
    final String type = block["type"]?.toString() ?? "text";
    if (type == "media") {
      final Widget? media = _mediaBlockWidget(context, cs, block);
      if (media != null) blockWidgets.add(media);
      continue;
    }
    final String text = block["text"]?.toString() ?? "";
    if (hasCardMarker) {
      // 文字段析出卡片标记：卡片建卡，散文走结构化渲染器。损坏的卡片块在
      // parseBlocks 里被静默跳过（防脏 JSON 漏进正文），纯正文段照常渲染。
      for (final AgentResultBlock seg in AgentResultParser.parseBlocks(text)) {
        if (seg.isCard) {
          _appendCardWidget(blockWidgets, cs, seg.data!, onUserAction,
              excludeTravelCard: excludeTravelCard);
          continue;
        }
        // 剥模型自带的展示形态声明行（[RENDER_AS:xxx]/[RENDER_HINT:xxx]）：
        // 声明是渲染路由信号，不属于正文。
        final String prose = _stripRenderDeclarationLines(seg.text ?? "");
        if (prose.isEmpty) continue;
        if (blockWidgets.isNotEmpty) {
          blockWidgets.add(const SizedBox(height: AppTypography.space2));
        }
        // 卡旁正文可能是完整结构化 markdown（模型按 structured 范式写的
        // 标题/表格/列表），用结构化正文渲染器；纯叙述时其内部自动回退
        // 内联排版，与旧行为等价。
        blockWidgets.add(
          StructuredAssistantMessageBody(
            text: prose,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
          ),
        );
      }
    } else {
      if (text.trim().isEmpty) continue;
      // 无卡片标记的文本段同样可能是结构化 markdown（交错媒体块的正文段），
      // 与信封路径同口径走结构化渲染器，纯叙述自动回退内联。
      blockWidgets.add(
        StructuredAssistantMessageBody(
          text: text,
          cs: cs,
          textTheme: Theme.of(context).textTheme,
        ),
      );
    }
  }

  if (!hasRenderBlocks) {
    final List<Map<String, dynamic>>? mediaCards = message.mediaCards;
    if (mediaCards != null && mediaCards.isNotEmpty) {
      blockWidgets.addAll(_groupedMediaWidgets(context, cs, mediaCards));
    }
  }

  if (blockWidgets.isEmpty) return null;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: blockWidgets,
  );
}

/// 卡片块 → Widget（actions 非空渲染为带按钮的选择型卡片）；首位卡不加顶距。
void _appendCardWidget(
  List<Widget> blockWidgets,
  ColorScheme cs,
  AgentResultData data,
  _UserActionHandler? onUserAction, {
  bool excludeTravelCard = false,
}) {
  // 行程卡外移（2026-09-25 用户定稿）：调用方声明 excludeTravelCard 时，卡由
  // 消息行在气泡外独立渲染（第二条消息形态），body 不再重复渲染。
  if (excludeTravelCard && data.cardType == "travel_itinerary") return;
  final int idx = blockWidgets.length;
  // 行程卡单独分段（2026-09-25 用户定稿）：travel_itinerary 是独立规划卡，
  // 与介绍文字之间用「大间距 + 细分隔线」显式切开成新的一段（其余小卡维持
  // 紧凑贴排）。
  final Widget card = data.actions.isNotEmpty
      ? AgentActionChoiceCard(
          data: data,
          onAction: onUserAction == null
              ? null
              : (AgentResultAction a) => onUserAction(a, cardData: data),
        )
      : AgentResultCard(data: data, onUserAction: onUserAction);
  if (data.cardType == "travel_itinerary" && idx > 0) {
    blockWidgets.add(
      Padding(
        padding: const EdgeInsets.only(top: AppTypography.space5),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Divider(height: 1, thickness: 0.6, color: cs.outlineVariant),
            const SizedBox(height: AppTypography.space4),
            card,
          ],
        ),
      ),
    );
    return;
  }
  blockWidgets.add(
    Padding(
      padding: EdgeInsets.only(top: idx == 0 ? 0 : AppTypography.space3),
      child: card,
    ),
  );
}

/// media 块 → Widget：小簇（无维度标题/无 A/B 对比）走轻量内联行（紧贴文字，
/// 不套大卡框），分组走媒体大卡。与统一路径/blocks 序列共用。
Widget? _mediaBlockWidget(
  BuildContext context,
  ColorScheme cs,
  Map<String, dynamic> block,
) {
  final List<Map<String, dynamic>> cards =
      (block["cards"] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .toList();
  if (cards.isEmpty) return null;
  final List<AgentResultItem> items = cards.map(_cardToItem).toList();
  final String groupTitle = (block["groupTitle"] ?? "").toString().trim();
  final String sideA = (block["sideA"] ?? "").toString().trim();
  final String sideB = (block["sideB"] ?? "").toString().trim();
  final bool isSmallCluster =
      groupTitle.isEmpty && sideA.isEmpty && sideB.isEmpty;
  if (isSmallCluster) {
    return Padding(
      padding: const EdgeInsets.only(top: AppTypography.space2),
      child: MediaInlineRow(items: items, cs: cs),
    );
  }
  return Padding(
    padding: const EdgeInsets.only(top: AppTypography.space3),
    child: AgentResultCard(
      data: AgentResultData(
        cardType: "media",
        title: "",
        items: items,
        footer: "",
        groupTitle: groupTitle.isEmpty ? null : groupTitle,
        sideA: sideA.isEmpty ? null : sideA,
        sideB: sideB.isEmpty ? null : sideB,
      ),
    ),
  );
}

/// mediaCards 按 groupTitle 编组（保持首次出现顺序）逐组出媒体块，与
/// 服务端 buildInterleavedRenderBlocks 的编组口径一致；sideA/sideB 取该组内
/// 首个对应侧的 sideLabel。
List<Widget> _groupedMediaWidgets(
  BuildContext context,
  ColorScheme cs,
  List<Map<String, dynamic>> cards,
) {
  final List<Widget> widgets = <Widget>[];
  final Map<String, List<Map<String, dynamic>>> groups =
      <String, List<Map<String, dynamic>>>{};
  for (final Map<String, dynamic> c in cards) {
    final String title = (c["groupTitle"] ?? "").toString().trim();
    groups.putIfAbsent(title, () => <Map<String, dynamic>>[]).add(c);
  }
  groups.forEach((String title, List<Map<String, dynamic>> groupCards) {
    String sideA = "";
    String sideB = "";
    for (final Map<String, dynamic> c in groupCards) {
      final String side = (c["side"] ?? "").toString().trim().toUpperCase();
      final String label = (c["sideLabel"] ?? "").toString().trim();
      if (side == "A" && sideA.isEmpty) sideA = label;
      if (side == "B" && sideB.isEmpty) sideB = label;
    }
    final Widget? widget = _mediaBlockWidget(
      context,
      cs,
      <String, dynamic>{
        "type": "media",
        if (title.isNotEmpty) "groupTitle": title,
        if (sideA.isNotEmpty) "sideA": sideA,
        if (sideB.isNotEmpty) "sideB": sideB,
        "cards": groupCards,
      },
    );
    if (widget != null) widgets.add(widget);
  });
  return widgets;
}

/// 边说边出图：把流式阶段 `chat.media_ready` 收到的临时照片渲染成媒体卡。
/// 仅流式阶段使用（pendingMediaCards 为瞬态）；`chat.assistant_done` 后
/// 该字段被清空，改由 renderBlocks 的最终顺序接管。
///
/// 用轻量 `MediaInlineRow` 渲染：边说边出图是「文字正在打、图已经查到」阶段，
/// 这里就该是「几行文字 + 几张图紧贴文字」的自然形态，不应套大 card 框。
Widget buildPendingMediaCards(
  List<Map<String, dynamic>> cards,
  ColorScheme cs,
) {
  return MediaInlineRow(
    items: cards.map(_cardToItem).toList(),
    cs: cs,
  );
}

/// 提取文本开头的 `[RENDER_AS:xxx]` 标记名，无标记返回 null。
String? _extractRenderAsMarker(String text) {
  final RegExpMatch? m = RegExp(r'^\[RENDER_AS:(\w+)\]\s*').firstMatch(text);
  return m?.group(1);
}

/// 剥离展示形态声明行（[RENDER_AS:xxx] / [RENDER_HINT:xxx]，整行独占时删行，
/// 与服务端 stripRenderDeclarationLines 同口径），其余文本原样返回。
String _stripRenderDeclarationLines(String text) {
  if (!text.contains("[RENDER_")) return text;
  final RegExp declarationLine = RegExp(r'^\s*\[RENDER_(?:HINT|AS):\w+\]\s*$');
  return text
      .split('\n')
      .where((String line) => !declarationLine.hasMatch(line))
      .join('\n')
      .trim();
}

/// 剥离文本开头的 `[RENDER_AS:xxx]` 标记，并清理正文中残留的形态声明标记
/// （模型照抄历史消息格式把声明复述在中段/结尾时，服务端旧版未剥、随历史
/// 消息落库；服务端 2026-09 起生成即消毒，这里兜底历史消息）。
String _stripRenderAsMarker(String text) {
  final String withoutLeading =
      text.replaceFirst(RegExp(r'^\[RENDER_AS:\w+\]\s*'), '');
  if (!withoutLeading.contains('[RENDER_')) return withoutLeading;
  final RegExp token = RegExp(r'\[RENDER_(?:HINT|AS):\w+\]');
  final List<String> cleanedLines = <String>[];
  for (final String line in withoutLeading.split('\n')) {
    final String stripped = line.replaceAll(token, '');
    // 声明独占一行 → 整行丢弃；行内嵌声明 → 就地剥离，保留其余文本
    if (stripped.trim().isEmpty && line.trim().isNotEmpty) continue;
    cleanedLines.add(stripped);
  }
  return cleanedLines.join('\n').trim();
}

// 旧数据恢复用：识别正文里内嵌的图片链接（markdown 图 / /agent/images/ 路径 / http 图片）。
// 用显式允许字符集，避免特殊引号/闭合符在字符类里的转义问题。
final RegExp _legacyImgMarkdown = RegExp(r'!\[[^\]]*\]\(([^)\s]+)\)');
final RegExp _legacyImgPath = RegExp(r'(/agent/images/[A-Za-z0-9_\-.%/]+)');
final RegExp _legacyImgHttp = RegExp(
  r'(https?://[A-Za-z0-9_\-./:%?&=@#~+]+\.(?:png|jpe?g|gif|webp|avif)(?:[?&][A-Za-z0-9_\-./:%?&=@#~+]+)?)',
  caseSensitive: false,
);

/// 从消息正文提取旧数据内嵌的图片链接（去重，最多 6 张）。
List<String> _extractLegacyImageUrls(String text) {
  if (text.isEmpty) return const <String>[];
  final List<String> out = <String>[];
  void add(String? url) {
    final String u = (url ?? '').trim();
    if (u.isEmpty || out.contains(u)) return;
    out.add(u);
  }

  for (final Match m in _legacyImgMarkdown.allMatches(text)) {
    add(m.group(1));
  }
  for (final Match m in _legacyImgPath.allMatches(text)) {
    add(m.group(1));
  }
  for (final Match m in _legacyImgHttp.allMatches(text)) {
    add(m.group(1));
  }
  return out.take(6).toList(growable: false);
}

/// 剥掉正文里含图片链接的行（避免与恢复出的图廊重复展示）。
String _stripLegacyImageLines(String text) {
  if (text.isEmpty) return text;
  return text
      .split('\n')
      .map((String line) => line.trim())
      .where((String line) {
        if (line.isEmpty) return false;
        if (_legacyImgMarkdown.hasMatch(line)) return false;
        if (_legacyImgPath.hasMatch(line)) return false;
        if (_legacyImgHttp.hasMatch(line)) return false;
        return true;
      })
      .join('\n')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
}
