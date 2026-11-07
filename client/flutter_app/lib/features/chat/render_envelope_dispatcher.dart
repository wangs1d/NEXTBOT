/// 统一 done 载荷分发（P4，2026-11-07）。
///
/// 服务端渲染出口已归一为一份 RenderEnvelope：v2 帧的
/// `payload["renderEnvelope"]["blocks"]` 是唯一权威，一条序列按序承载
/// 正文 / 卡片 / 形态 / 媒体 / 摘要 / 接续建议。
///
/// 本文件把过去散在 message_body_renderer 里的 7 层字段优先级收敛成
/// **一个 dispatcher**：`dispatchDonePayload()` 输出统一的块序列，
/// 调用方只认这一种结构，不再各自挑字段。
///
/// 兼容：旧帧（无 renderEnvelope）按既有优先级折叠成同一份序列，
/// 因此历史消息、任务面离线重放、老服务端都不需要迁移。
/// 本模块是纯 Dart、零 Flutter 依赖，可被单测直接驱动。

library;

/// 信封块类型（与 server/src/render/contract.ts 的 ENVELOPE_BLOCK_TYPES 同源）
const List<String> kEnvelopeBlockTypes = <String>[
  'text',
  'card',
  'form',
  'structured',
  'media',
  'summary',
  'followups',
  'media_segments',
];

/// 统一块：所有通道（v2 信封 / 旧字段）都折叠成这一种结构。
class RenderEnvelopeBlock {
  final String type;
  final String text;
  final String? form;
  final Map<String, dynamic>? card;
  final List<dynamic>? cards;
  final String? groupTitle;
  final List<String>? items;

  const RenderEnvelopeBlock({
    required this.type,
    this.text = '',
    this.form,
    this.card,
    this.cards,
    this.groupTitle,
    this.items,
  });

  bool get isText => type == 'text';
  bool get isCard => type == 'card' || type == 'structured';
  bool get isMedia => type == 'media' || type == 'media_segments';

  Map<String, dynamic> toJson() => <String, dynamic>{
        'type': type,
        if (text.isNotEmpty) 'text': text,
        if (form != null) 'form': form,
        if (card != null) 'card': card,
        if (cards != null) 'cards': cards,
        if (groupTitle != null) 'groupTitle': groupTitle,
        if (items != null) 'items': items,
      };
}

/// 是否是可信的 v2 信封（version 必须是 2，blocks 必须是非空数组）。
bool hasV2RenderEnvelope(Map<String, dynamic> payload) {
  final Object? env = payload['renderEnvelope'];
  if (env is! Map) return false;
  if (env['version'] != 2) return false;
  final Object? blocks = env['blocks'];
  return blocks is List && blocks.isNotEmpty;
}

/// 生产接线入口（P4，2026-11-07）：从 done 载荷抽取信封块原序列。
///
/// 返回的块与 `dispatchDonePayload` 消费的是同一份 wire 格式（raw 已由服务端
/// 剥除）。控制器把它存到 ChatMessage.envelopeBlocks，渲染层信封优先直读；
/// 非 v2 帧返回 null，调用方照旧走旧字段链。分泡轮由调用方自行过滤 text 块
/// （正文已在各气泡里），本函数不做语义裁剪。
List<Map<String, dynamic>>? extractEnvelopeBlocks(Map<String, dynamic> payload) {
  if (!hasV2RenderEnvelope(payload)) return null;
  final List<dynamic> raw =
      (payload['renderEnvelope'] as Map)['blocks'] as List<dynamic>;
  final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
  for (final Object? item in raw) {
    if (item is Map) out.add(Map<String, dynamic>.from(item));
  }
  return out.isEmpty ? null : out;
}

/// 唯一分发入口：v2 信封优先，旧帧折叠，恒返回非空块序列。
List<RenderEnvelopeBlock> dispatchDonePayload(Map<String, dynamic> payload) {
  final List<RenderEnvelopeBlock> blocks = hasV2RenderEnvelope(payload)
      ? _fromEnvelopeBlocks((payload['renderEnvelope'] as Map)['blocks'] as List)
      : _fromLegacyFields(payload);
  if (blocks.isEmpty) {
    return <RenderEnvelopeBlock>[const RenderEnvelopeBlock(type: 'text')];
  }
  return blocks;
}

List<RenderEnvelopeBlock> _fromEnvelopeBlocks(List<dynamic> raw) {
  final List<RenderEnvelopeBlock> out = <RenderEnvelopeBlock>[];
  for (final Object? item in raw) {
    if (item is! Map) continue;
    final String type = item['type'] is String ? item['type'] as String : 'text';
    if (!kEnvelopeBlockTypes.contains(type)) continue;
    out.add(RenderEnvelopeBlock(
      type: type,
      text: item['text'] is String ? item['text'] as String : '',
      form: item['form'] is String ? item['form'] as String : null,
      card: item['card'] is Map
          ? Map<String, dynamic>.from(item['card'] as Map)
          : null,
      cards: item['cards'] is List ? List<dynamic>.from(item['cards'] as List) : null,
      groupTitle: item['groupTitle'] is String ? item['groupTitle'] as String : null,
      items: item['items'] is List
          ? (item['items'] as List).map((Object? e) => e.toString()).toList()
          : null,
    ));
  }
  return out;
}

/// 旧帧折叠：renderBlocks → blocks → finalText + cards/mediaCards，
/// 顺序与既有客户端优先级一致，只是输出统一成一份序列。
List<RenderEnvelopeBlock> _fromLegacyFields(Map<String, dynamic> payload) {
  final List<RenderEnvelopeBlock> out = <RenderEnvelopeBlock>[];
  final Object? renderBlocks = payload['renderBlocks'];
  final Object? replyBlocks = payload['blocks'];

  if (renderBlocks is List && renderBlocks.isNotEmpty) {
    for (final Object? seg in renderBlocks) {
      if (seg is! Map) continue;
      final String type = seg['type'] is String ? seg['type'] as String : 'text';
      out.add(RenderEnvelopeBlock(
        type: type == 'media' ? 'media' : 'text',
        text: seg['text'] is String ? seg['text'] as String : '',
        cards: seg['cards'] is List ? List<dynamic>.from(seg['cards'] as List) : null,
        groupTitle: seg['groupTitle'] is String ? seg['groupTitle'] as String : null,
      ));
    }
  } else if (replyBlocks is List && replyBlocks.isNotEmpty) {
    for (final Object? seg in replyBlocks) {
      if (seg is! Map) continue;
      final String type = seg['type'] is String ? seg['type'] as String : 'text';
      out.add(RenderEnvelopeBlock(
        type: type,
        text: seg['text'] is String ? seg['text'] as String : '',
        card: seg['card'] is Map
            ? Map<String, dynamic>.from(seg['card'] as Map)
            : null,
        cards: seg['cards'] is List ? List<dynamic>.from(seg['cards'] as List) : null,
        groupTitle: seg['groupTitle'] is String ? seg['groupTitle'] as String : null,
      ));
    }
  } else {
    final String finalText =
        payload['finalText'] is String ? payload['finalText'] as String : '';
    if (finalText.isNotEmpty) {
      out.add(RenderEnvelopeBlock(type: 'text', text: finalText));
    }
    final Object? cards = payload['cards'];
    if (cards is List) {
      for (final Object? card in cards) {
        if (card is Map) {
          out.add(RenderEnvelopeBlock(
            type: 'card',
            card: Map<String, dynamic>.from(card),
          ));
        }
      }
    }
    final Object? media = payload['mediaCards'];
    if (media is List && media.isNotEmpty) {
      out.add(RenderEnvelopeBlock(
        type: 'media',
        cards: List<dynamic>.from(media),
      ));
    }
  }

  final Object? summary = payload['summaryCard'];
  if (summary is Map) {
    out.add(RenderEnvelopeBlock(
      type: 'summary',
      card: Map<String, dynamic>.from(summary),
    ));
  }
  final Object? followups = payload['followups'];
  if (followups is List && followups.isNotEmpty) {
    out.add(RenderEnvelopeBlock(
      type: 'followups',
      items: (followups).map((Object? e) => e.toString()).toList(),
    ));
  }
  return out;
}

/// 语音/纯文本投影：只取正文，结构化块与侧通道一律不播。
String projectEnvelopeToSpeech(List<RenderEnvelopeBlock> blocks) => blocks
    .where((RenderEnvelopeBlock b) => b.isText)
    .map((RenderEnvelopeBlock b) => b.text)
    .join('')
    .replaceAll(RegExp(r'\[[A-Z_0-9]+\]'), '')
    .trim();
