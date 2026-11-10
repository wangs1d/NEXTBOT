/**
 * 统一渲染出口协议（P1，2026-11-07）。
 *
 * 主从关系在此反转：过去 finalText 是事实源、blocks 是它的派生视图；
 * 现在 blocks 是唯一权威，finalText = projectToText(blocks) 的确定性投影。
 *
 * 无损可逆是硬约束：每一块都携带 `raw`（该块在文本通道里的确切编码），
 * 解码器只在能完整还原时才拆块，拆不了就整段作为 text 块原样保留。
 * 因此 `projectToText(decodeLegacyText(t)) === t` 对任意输入恒成立，
 * 历史载荷逐字节不变，落库文本与旧客户端不会因协议升级而分叉。
 *
 * 本文件是纯函数：不读文件、不打日志、不调 LLM、不依赖运行时单例。
 */

import type { MediaCardItem } from "../services/tool-result-processor.js";
import type { ReplyBlock } from "../services/reply-envelope.js";

/** 文本块：一段普通正文（raw 恒等于 text，保留原始空白与换行） */
export interface EnvelopeTextBlock {
  type: "text";
  text: string;
  raw: string;
}

/** 卡片块：card 即客户端直接建卡的载荷 */
export interface EnvelopeCardBlock {
  type: "card";
  card: Record<string, unknown>;
  cardType: string;
  raw: string;
}

/** 形态块：吸收 [RENDER_AS:*] 等路由声明，形态名进 meta 供契约校验 */
export interface EnvelopeFormBlock {
  type: "form";
  form: string;
  raw: string;
}

/** 摘要/媒体/数据等结构化块（JSON 已解析；坏 JSON 整段降级为 text） */
export interface EnvelopeStructuredBlock {
  type: "structured";
  kind: "content_summary" | "data_brief" | "video_media" | "chat_media" | "image_result";
  card: Record<string, unknown>;
  raw: string;
}

/** 不占文本通道的独立通道块：raw 恒为空，投影时不产生字符 */
export interface EnvelopeSideBlock {
  type: "media" | "summary" | "followups" | "media_segments";
  cards?: MediaCardItem[];
  groupTitle?: string;
  sideA?: string;
  sideB?: string;
  card?: Record<string, unknown>;
  items?: string[];
  segments?: ReadonlyArray<unknown>;
  raw: "";
}

export type EnvelopeBlock =
  | EnvelopeTextBlock
  | EnvelopeCardBlock
  | EnvelopeFormBlock
  | EnvelopeStructuredBlock
  | EnvelopeSideBlock;

/** 一轮回复的统一信封。done 帧所有旧字段都是它的投影或同源视图。 */
export interface RenderEnvelope {
  version: 2;
  /** 唯一权威：顺序即版式 */
  blocks: EnvelopeBlock[];
  /** = projectToText(blocks)，落库文本 + 旧客户端入口 */
  finalText: string;
  /** 剥掉结构化块与标记后的可播文本 */
  speechText: string;
  /** 旧字段的同源投影：字段名/语义逐字节不变，只是改由信封展开 */
  legacy: {
    blocks: ReplyBlock[] | null;
    cards: Array<Record<string, unknown>>;
    mediaCards: MediaCardItem[];
    renderBlocks: ReadonlyArray<unknown>;
    summaryCard?: Record<string, unknown>;
    followups: string[];
  };
  meta: {
    sceneId: string;
    failures: string[];
    cardTypes: string[];
    forms: string[];
    blockTypes: string[];
    /** 生成前已命中的场景 id（P3：出口与 prompt 复用同一批场景） */
    preSceneIds: string[];
    /** 是否可安全下发给 v1 blocks 消费者（含 v1 不认识的形态时降级） */
    v1Compatible: boolean;
  };
}

export interface RenderEnvelopeInput {
  finalText: string;
  mediaCards?: MediaCardItem[];
  /** 服务端按锚定切好的交错块（text/media），原样作为同源视图保留 */
  renderBlocks?: ReadonlyArray<unknown>;
  summaryCard?: Record<string, unknown>;
  followups?: string[];
  /** v1 回复块：由 reply-envelope.buildReplyBlocks 计算，保持既有降级口径 */
  legacyBlocks?: ReplyBlock[] | null;
  sceneId?: string;
  failures?: string[];
  /** 生成前预决策命中的场景（由调用方注入，出口不重复猜） */
  preSceneIds?: string[];
}

const CARD_START = "[AGENT_RESULT_CARD_START]";
const CARD_END = "[AGENT_RESULT_CARD_END]";

const STRUCTURED_MARKERS: ReadonlyArray<{
  kind: EnvelopeStructuredBlock["kind"];
  start: string;
  end: string;
}> = [
  { kind: "content_summary", start: "[CONTENT_SUMMARY_V2_START]", end: "[CONTENT_SUMMARY_V2_END]" },
  { kind: "data_brief", start: "[DATA_BRIEF_START]", end: "[DATA_BRIEF_END]" },
  { kind: "video_media", start: "[VIDEO_MEDIA_START]", end: "[VIDEO_MEDIA_END]" },
  { kind: "chat_media", start: "[CHAT_MEDIA_START]", end: "[CHAT_MEDIA_END]" },
  { kind: "image_result", start: "[IMAGE_RESULT_START]", end: "[IMAGE_RESULT_END]" },
];

/** 独占一行的路由声明（模型写歪的 RENDER_HINT 不在此解析，出口另有清洗） */
const FORM_LINE_RE = /^\[RENDER_AS:([A-Za-z0-9_-]+)\][ \t]*\r?\n?/;

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textBlock(raw: string): EnvelopeTextBlock {
  return { type: "text", text: raw, raw };
}

/**
 * 把历史/现网文本无损解码成块序列。
 *
 * 只拆「能完整还原」的结构：配对完整且 JSON 可解析的块、独占行的 RENDER_AS
 * 声明。残缺标记、坏 JSON、行内误写的形态声明一律留在 text 块里，
 * 由既有出口清洗与客户端正则处理——绝不半拆造成标记泄漏。
 */
export function decodeLegacyText(text: string): EnvelopeBlock[] {
  const source = text ?? "";
  const blocks: EnvelopeBlock[] = [];
  let pending = "";
  let cursor = 0;

  const flush = (): void => {
    if (pending) {
      blocks.push(textBlock(pending));
      pending = "";
    }
  };

  while (cursor < source.length) {
    const rest = source.slice(cursor);

    // 1) 独占行的形态声明（只在行首出现才拆，避免吃掉正文里的字面标记）
    const atLineStart = cursor === 0 || source[cursor - 1] === "\n";
    const formMatch = atLineStart ? FORM_LINE_RE.exec(rest) : null;
    if (formMatch) {
      flush();
      blocks.push({ type: "form", form: formMatch[1], raw: formMatch[0] });
      cursor += formMatch[0].length;
      continue;
    }

    // 2) 配对完整的结构化块（卡片优先）
    let matched = false;
    if (rest.startsWith(CARD_START)) {
      const end = rest.indexOf(CARD_END, CARD_START.length);
      if (end !== -1) {
        const raw = rest.slice(0, end + CARD_END.length);
        const card = parseObject(rest.slice(CARD_START.length, end));
        if (card) {
          flush();
          blocks.push({
            type: "card",
            card,
            cardType: typeof card.cardType === "string" ? card.cardType : "",
            raw,
          });
          cursor += raw.length;
          matched = true;
        }
      }
    }
    if (matched) continue;

    for (const marker of STRUCTURED_MARKERS) {
      if (!rest.startsWith(marker.start)) continue;
      const end = rest.indexOf(marker.end, marker.start.length);
      if (end === -1) break;
      const raw = rest.slice(0, end + marker.end.length);
      const card = parseObject(rest.slice(marker.start.length, end));
      if (!card) break;
      flush();
      blocks.push({ type: "structured", kind: marker.kind, card, raw });
      cursor += raw.length;
      matched = true;
      break;
    }
    if (matched) continue;

    pending += source[cursor];
    cursor += 1;
  }
  flush();

  // 恒返回门：哪怕空文本也给一个 text 块，下游永不面对零块信封
  if (blocks.length === 0) return [textBlock("")];
  return blocks;
}

/** 块的文本通道编码。side 块 raw 恒空，不影响 finalText。 */
export function projectBlock(block: EnvelopeBlock): string {
  return block.raw;
}

/** finalText 的唯一生成方式：按块顺序拼接文本通道编码。 */
export function projectToText(blocks: ReadonlyArray<EnvelopeBlock>): string {
  let out = "";
  for (const block of blocks) out += projectBlock(block);
  return out;
}

/** 可播文本：只取正文与形态块的正文，结构化 JSON / 侧通道一律不播。 */
export function projectToSpeech(blocks: ReadonlyArray<EnvelopeBlock>): string {
  return blocks
    .filter((b): b is EnvelopeTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/\[[A-Z_0-9]+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 由结构化数据确定性构造卡片块（新场景直接产块时用，不经过文本反解析）。 */
export function encodeCardBlock(card: Record<string, unknown>): EnvelopeCardBlock {
  const raw = `${CARD_START}\n${JSON.stringify(card)}\n${CARD_END}`;
  return {
    type: "card",
    card,
    cardType: typeof card.cardType === "string" ? card.cardType : "",
    raw,
  };
}

/** 由形态名确定性构造 form 块。 */
export function encodeFormBlock(form: string, body: string): Array<EnvelopeBlock> {
  return [
    { type: "form", form, raw: `[RENDER_AS:${form}]\n` },
    textBlock(body),
  ];
}

/** v1 blocks 消费者不认识的形态：出现即整体降级，语义与 buildReplyBlocks 一致 */
const V1_UNSUPPORTED_FORMS = new Set(["video", "data_brief", "image_result"]);

/** 组装本轮统一信封。所有旧字段由它展开，调用方不再各自派生。 */
export function buildRenderEnvelope(input: RenderEnvelopeInput): RenderEnvelope {
  const blocks: EnvelopeBlock[] = decodeLegacyText(input.finalText ?? "");
  // 恒返回门：正文可能被形态块/结构化块完全占满（如只有 [RENDER_AS:video]
  // 的卡片轮），也必须有 text 块作为正文与语音的落点。
  // raw 为空 → 不改变 finalText 投影。
  if (!blocks.some((b) => b.type === "text")) {
    blocks.push({ type: "text", text: "", raw: "" });
  }

  const mediaCards = input.mediaCards ?? [];
  const renderBlocks = input.renderBlocks ?? [];
  const followups = input.followups ?? [];
  // 媒体唯一出口（2026-11-08 收口，实测取证后定稿）：
  // - renderBlocks 由服务端从 mediaCards 派生，内部已含同一批照片的 media 块；
  //   此前把 mediaCards 再编成独立 media 块 + renderBlocks 整体编成
  //   media_segments，同一组照片在信封里出现两遍 → v2 客户端画两遍。
  // - renderBlocks 里的文字段与顶层 text 块是同一份正文的两种编码，一起下发
  //   正文也会渲染两遍（手机端控制器此前剥文字段补救，属出口缝补）。
  // 收口后：媒体只从 media_segments（仅 media 段）或兜底独立 media 块走一条路；
  // 正文只由顶层 text 块承载。一个入口（mediaCards），一个出口（信封媒体块）。
  const mediaOnlySegments = renderBlocks.filter(
    (b) => (b as { type?: string }).type === "media",
  );
  if (mediaOnlySegments.length > 0) {
    blocks.push({ type: "media_segments", segments: mediaOnlySegments, raw: "" });
  } else if (mediaCards.length > 0) {
    blocks.push({ type: "media", cards: mediaCards, raw: "" });
  }
  if (input.summaryCard) {
    blocks.push({ type: "summary", card: input.summaryCard, raw: "" });
  }
  if (followups.length > 0) {
    blocks.push({ type: "followups", items: followups, raw: "" });
  }

  const finalText = projectToText(blocks);
  const cards = blocks
    .filter((b): b is EnvelopeCardBlock => b.type === "card")
    .map((b) => b.card);
  const forms = blocks
    .filter((b): b is EnvelopeFormBlock => b.type === "form")
    .map((b) => b.form);
  const structuredKinds = blocks
    .filter((b): b is EnvelopeStructuredBlock => b.type === "structured")
    .map((b) => b.kind);

  const v1Compatible =
    forms.every((f) => !V1_UNSUPPORTED_FORMS.has(f)) &&
    structuredKinds.length === 0;

  return {
    version: 2,
    blocks,
    finalText,
    speechText: projectToSpeech(blocks),
    legacy: {
      // 保留既有降级口径：调用方传入的 legacyBlocks 由 buildReplyBlocks 算出；
      // 含 v1 不认识形态时强制不下发，避免新客户端优先 blocks 丢内容。
      blocks: v1Compatible ? (input.legacyBlocks ?? null) : null,
      cards,
      mediaCards,
      renderBlocks,
      ...(input.summaryCard ? { summaryCard: input.summaryCard } : {}),
      followups,
    },
    meta: {
      sceneId: input.sceneId ?? "none",
      failures: input.failures ?? [],
      cardTypes: cards
        .map((c) => (typeof c.cardType === "string" ? c.cardType : ""))
        .filter(Boolean),
      forms,
      blockTypes: blocks.map((b) => b.type),
      preSceneIds: input.preSceneIds ?? [],
      v1Compatible,
    },
  };
}

/** 精简线格式：raw 只服务服务端可逆投影，不下发客户端（避免正文重复传输）。 */
export function compactEnvelopeForWire(envelope: RenderEnvelope): Record<string, unknown> {
  return {
    version: 2,
    blocks: envelope.blocks.map((block) => {
      const copy: Record<string, unknown> = { ...block };
      delete copy.raw;
      return copy;
    }),
    meta: envelope.meta,
  };
}

/** 信封 → done 帧字段展开（字段名与旧协议完全一致，客户端可零改动）。 */
export function expandEnvelopeToDoneFields(envelope: RenderEnvelope): Record<string, unknown> {
  const { legacy } = envelope;
  return {
    finalText: envelope.finalText,
    ...(legacy.mediaCards.length > 0 ? { mediaCards: legacy.mediaCards } : {}),
    ...(legacy.summaryCard ? { summaryCard: legacy.summaryCard } : {}),
    ...(legacy.renderBlocks.length > 0 ? { renderBlocks: legacy.renderBlocks } : {}),
    ...(legacy.cards.length > 0 ? { cards: legacy.cards } : {}),
    ...(legacy.blocks && legacy.blocks.length > 0 ? { blocks: legacy.blocks } : {}),
    ...(legacy.followups.length > 0 ? { followups: legacy.followups } : {}),
  };
}
