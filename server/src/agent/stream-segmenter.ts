import { stripSentencesAlreadySaid } from "../utils/text.js";

/** 分段推送的附加元数据：bubble="new" 表示开启一个新气泡（客户端新建一条消息），
 *  "continue" 表示追加到当前末气泡（残差/迟到段不开新泡）。 */
export type StreamSegmentEmitMeta = { bubble?: "new" | "continue" };

/**
 * StreamSegmenter —— 主回复统一分段器（信息块分段 + 节奏停顿 + 增量去重）
 *
 * 设计动机（GPT live 式真人节奏，2026-08-20 合并为单一模块，080-24 去垫词旁路）：
 * - 不再有独立的垫词(interim)气泡：主回复首分句被"按住"，先作为正文第一段发出，
 *   停顿一个间隔后再接其余信息块，保留"先应一句、稍作停顿、再详细说"的真人节奏；
 *   全部相别统一为 stream，前端同一气泡里分段递进。
 * - 按"信息块"（同话题连贯短句）分段，而非机械逐句分段：能在一个气泡里放完的
 *   内容不强拆，避免内容冗余；只有话题转换 / 段落换行 / 列表编号 / 达到目标长度
 *   时才切新块。
 * - 段落间增量去重：每个块在推送前剔除与已推送句级重复的内容，保证层层递进不重复；
 *   首个信息块还会针对已发出的首句再做一次去重（修复"首句与正文开头复读"）。
 * - 重量上限：正文块数封顶，超限内容并入一个尾部块，防止分段过多造成"刷屏"。
 * - 首段做结论锚：开头的第一个信息块承载直接回应/结论，不因细碎切分被打散；
 *   后续块才展开细节——先结论后论据，天然递进。
 *
 * 关键正确性约束（杜绝"首句 + 正文 + done 全文"反复）：
 * 1. 首个分句先被按住，确认主回复还有后续才带间隔发出；否则并入正文单块。
 * 2. 每次发射前用累积的已推送文本做句级去重，残留重复句直接剔除。
 */
export type StreamSegmenterOptions = {
  /** 块间停顿（毫秒），用于模拟真人说话节奏。默认 100ms。 */
  pauseMs?: number;
  /** 最小句子长度（字符），低于该长度的纯标点碎片不单独成块。默认 6。 */
  minSegmentChars?: number;
  /** 首句正文段与其后信息块之间的间隔（毫秒），
   *  模拟真人先应一句、稍作停顿再开口细说的节奏。默认 800ms。 */
  interimReplyGapMs?: number;
  /**
   * 是否启用信息块分段。默认 true。
   * - true：按信息块切分（同话题短句合并），逐块推送（带块间停顿），模拟真人聊天节奏。
   * - false：不透传分段，全部内容累积后在 flushFinal 一次性推为 stream 段。
   */
  segmentationEnabled?: boolean;
  /** 信息块目标字符数：同话题短句一直累积到接近该长度才切新块。默认 56。 */
  blockCharTarget?: number;
  /** 正文信息块数量上限（重量上限）：超出后剩余内容并入尾部块。默认 4。 */
  maxStreamSegments?: number;
  /**
   * 是否按住首个分句做"先应一句"裁决。默认 true（文字聊天节奏）。
   * 语音模式必须关闭：按住首句会让第一段文本延迟到第二块才发出，
   * 直接拖慢 TTS 首句开播；关闭后首句随到随发。
   */
  holdFirstSentence?: boolean;
  /**
   * 气泡拆分模式（真·分绿泡，2026-09-28）：信息块直接升级为独立气泡——
   * 每个信息块推成一条独立消息（emit 带 bubble:"new"），而不是同一气泡里的
   * 分段递进。切泡只认句末边界/换行（句中逗号永不截断，字数仅做短句并泡的
   * 下限），模拟真人连发几条短消息的节奏。语音轮次禁止开启（done 会被泡间
   * 停顿拖慢，且 TTS 链路不消费气泡边界）。
   */
  bubbleMode?: boolean;
  /** 气泡拆分模式：相邻两泡之间的最小/最大停顿（毫秒）。默认 500~800。 */
  bubbleGapMinMs?: number;
  bubbleGapMaxMs?: number;
  /** 气泡拆分模式：单轮气泡数上限，超出后剩余内容并入末气泡（防刷屏）。默认 4。 */
  maxBubbles?: number;
};

/** 句子 / 段落边界：中文/英文句末标点与换行。 */
const SEGMENT_BOUNDARY_RE = /[。！？!?；;\n]/u;

/** 话题转换连词：句首命中则视为开启新的信息块。 */
const TOPIC_SHIFT_RE =
  /^(而|但|另|不过|然而|且|同时|另外|此外|还有|至于|再|继而|接着|然后|随后|最后|首先|其次|总之|综上|因此|所以|于是|结果|关于|对于|说到|回到|总而言之|换句话说)/u;

/** 列表 / 编号起始：句首命中则视为独立信息块。 */
const LIST_ITEM_BREAK_RE =
  /^\s*(?:[（(]?\d+[\.、)）]|[一二三四五六七八九十]+[\.、)）]|[-*•])\s*/u;

/** 气泡拆分模式：强边界（句末标点/换行，命中且可见字达标即切新泡）。
 *  切泡只认句末——逗号/顿号等句中位置永不切（见 flushCompleteBubbles）。 */
const BUBBLE_STRONG_BREAK_RE = /[。！？!?；;\n]/u;

/** 气泡拆分模式：首泡强边界切泡所需的最少可见字数（单字句如"嗯。"不单独成泡）。
 *  首泡保持细粒度：TTFT 优先（"哎，在呢。"随到随出），短应答场景也能两泡连发。 */
const BUBBLE_MIN_STRONG_CHARS = 2;
/** 气泡拆分模式：后续泡的最少可见字数（2026-09-28 用户反馈"分得太多"）：
 *  首泡之后的边界必须攒够该字数才切——泡更饱满、数量自然收敛（短句不再
 *  逐条碎裂），也避免末泡硬扛大段剩余内容。 */
const BUBBLE_MIN_CHARS = 12;

/** 可见字符（字母/数字/汉字），用于气泡长度裁决——标点与空白不计。 */
const BUBBLE_VISIBLE_CHAR_RE = /[\p{L}\p{N}]/u;

/** 泡尾/泡首需要剥掉的悬挂标点与空白（真人消息不以逗号开头/结尾）。 */
const BUBBLE_EDGE_STRIP_RE = /^[\s，,、]+|[\s，,、]+$/gu;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StreamSegmenter {
  private buffer = "";
  /** 当前正在累积的信息块（同话题连贯内容，尚未到切块时机）。 */
  private blockBuffer = "";
  /** 超出重量上限后并入的尾部块（最后一次性输出）。 */
  private tailBuffer = "";
  private minSegmentChars: number;
  private pauseMs: number;
  /** 垫词与真实回复正文之间的间隔 */
  private interimReplyGapMs: number;
  /** 是否启用信息块分段 */
  private segmentationEnabled: boolean;
  /** 是否按住首句（holdFirstSentence=false 时为 false，首句随到随发） */
  private holdFirstSentence: boolean;
  /** 信息块目标字符数 */
  private blockCharTarget: number;
  /** 正文信息块数量上限 */
  private maxStreamSegments: number;
  /** 气泡拆分模式：信息块升级为独立气泡（真·分绿泡）。 */
  private bubbleMode: boolean;
  /** 气泡拆分模式：相邻两泡之间的停顿区间（毫秒）。 */
  private bubbleGapMinMs: number;
  private bubbleGapMaxMs: number;
  /** 气泡拆分模式：单轮气泡数上限，超出并入末泡。 */
  private maxBubbles: number;
  /** 已推送的气泡数（气泡拆分模式重量上限）。 */
  private bubbleCount = 0;
  /** 串行队列：保证 feed 的异步停顿不交错、乱序 */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 首个分句：先按住，等判定主回复是否还有其他内容再决定如何分发（垫词候选）。 */
  private heldFirst: string | null = null;
  /** 垫词是否已裁决并消耗。保证整条回复只产生一个垫词：
   *  首句按为空后，后续信息块的句首不再被重复当成垫词候选。 */
  private interimDone = false;
  /** 已推送正文块的数量（用于重量上限）。 */
  private streamBlockCount = 0;
  /** 累积的已推送文本，用于句级增量去重。 */
  private emittedText = "";

  constructor(
    private readonly emit: (
      segment: string,
      phase: "interim" | "stream",
      meta?: StreamSegmentEmitMeta,
    ) => void,
    opts: StreamSegmenterOptions = {},
  ) {
    this.pauseMs = opts.pauseMs ?? 100;
    this.minSegmentChars = opts.minSegmentChars ?? 6;
    this.interimReplyGapMs = opts.interimReplyGapMs ?? 800;
    this.segmentationEnabled = opts.segmentationEnabled ?? true;
    this.blockCharTarget = opts.blockCharTarget ?? 56;
    this.maxStreamSegments = opts.maxStreamSegments ?? 4;
    this.holdFirstSentence = opts.holdFirstSentence ?? true;
    this.bubbleMode = opts.bubbleMode ?? false;
    this.bubbleGapMinMs = opts.bubbleGapMinMs ?? 500;
    this.bubbleGapMaxMs = opts.bubbleGapMaxMs ?? 800;
    this.maxBubbles = opts.maxBubbles ?? 4;
    // holdFirstSentence=false → 首句随到随发：interimDone 置位使首句按住逻辑
    // 全程短路（flushCompleteBlocks 不按住、dispatchSegment/flushFinal 走普通分支）
    this.interimDone = !this.holdFirstSentence;
    // 气泡拆分模式天然随到随发，首句按住逻辑强制短路
    if (this.bubbleMode) {
      this.holdFirstSentence = false;
      this.interimDone = true;
    }
  }

  /**
   * 运行时开启气泡拆分模式（真·分绿泡）。供 WS 层在路由决策就绪后调用——
   * 门禁依赖 decision.segmentable（对话面）与语音态，二者在首个主回复 delta
   * 之前必然就绪（agent-core 主 LLM 依赖同一决策），故不存在拆分态竞态。
   * 必须在任何 feed 之前调用。
   */
  enableBubbleMode(): void {
    if (this.disposed) return;
    this.bubbleMode = true;
    this.holdFirstSentence = false;
    this.interimDone = true;
  }

  /**
   * 喂入新的流式 delta，累积并按信息块切分，逐块推送给 emit。
   * 未闭合的半截文本留在缓冲/当前块中，等待后续 delta 或 flushFinal。
   * 异步串行：块间停顿走 setTimeout，不阻塞事件循环。
   */
  feed(delta: string): void {
    if (!delta || this.disposed) return;
    this.buffer += delta;
    this.chain = this.chain
      .then(() => this.flushComplete())
      .catch((err) => {
        console.error("[StreamSegmenter] feed 异常:", err);
      });
  }

  /**
   * 主回复流结束时调用：把缓冲中剩余的文本（含当前块与尾部块）作为最后内容推送。
   * - 启用分段时：裁决首句垫词 + 推送剩余正文
   * - 禁用分段时：整个缓冲作为 single stream 段直接推送
   * 这里是"垫词 + done 全文"重复的最后防线，统一做句级去重。
   */
  async flushFinal(): Promise<void> {
    await this.chain;
    if (this.disposed) return;
    const rest = (this.buffer + this.blockBuffer).trim();
    this.buffer = "";
    this.blockBuffer = "";

    const combined = (rest + this.tailBuffer).trim();
    this.tailBuffer = "";

    if (!this.segmentationEnabled) {
      // 不分段模式：整个缓冲作为一段 stream 发出，无首句裁决
      if (combined) this.emit(combined, "stream");
      return;
    }

    // 气泡拆分模式：残差裁决——完整句残差且泡数未封顶 → 开新泡（真人连发的
    // 最后一条完整消息，带泡间停顿）；碎片残差（无句末边界）或已封顶 →
    // 追加到当前末气泡（不开新泡）；全程未推出过泡（整段回复无切泡点）时
    // 作为唯一的"new"泡发出。
    if (this.bubbleMode) {
      if (!combined) return;
      const deduped = stripSentencesAlreadySaid(this.emittedText, combined).trim();
      if (!deduped) return;
      const canOpenNew =
        this.bubbleCount > 0 &&
        this.bubbleCount < this.maxBubbles &&
        BUBBLE_STRONG_BREAK_RE.test(deduped);
      if (this.bubbleCount === 0 || canOpenNew) {
        if (this.bubbleCount > 0 && this.bubbleGapMaxMs > 0) {
          const span = Math.max(1, this.bubbleGapMaxMs - this.bubbleGapMinMs + 1);
          await sleep(this.bubbleGapMinMs + Math.floor(Math.random() * span));
          if (this.disposed) return;
        }
        this.trackEmitted(deduped);
        this.bubbleCount += 1;
        this.emit(deduped, "stream", { bubble: "new" });
        return;
      }
      this.trackEmitted(deduped);
      this.emit(deduped, "stream", { bubble: "continue" });
      return;
    }

    // 分段模式：裁决首句 + 推送剩余正文
    if (this.heldFirst !== null) {
      const first = this.heldFirst;
      this.heldFirst = null;
      this.interimDone = true;
      if (first === combined) {
        // 整段回复只有这一句：作为单个正文气泡发出，避免首句重复
        this.trackEmitted(first);
        this.emit(first, "stream");
      } else {
        // 有首个分句 + 剩余内容 → 首个先作正文段发出，间隔后剩余作正文（再做句级去重）
        const body = stripSentencesAlreadySaid(first, combined).trim();
        this.trackEmitted(first);
        this.emit(first, "stream");
        if (this.interimReplyGapMs > 0) {
          await sleep(this.interimReplyGapMs);
          if (this.disposed) return;
        }
        if (body) {
          this.trackEmitted(body);
          this.emit(body, "stream");
        }
      }
      return;
    }

    if (combined) {
      const deduped = stripSentencesAlreadySaid(this.emittedText, combined).trim();
      if (deduped) {
        this.trackEmitted(deduped);
        this.emit(deduped, "stream");
      }
    }
  }

  /**
   * 等待"当前已喂入内容"分发完毕（不断流、不丢弃缓冲，可继续 feed）。
   *
   * 用途：工具边界处的确定性屏障。分段器分发是**异步串行**的（feed 只入链，
   * 真正的 emit 在 chain 上跑，还含块间停顿），若在工具开始执行时直接打
   * "过程话阶段结束"的标记，仍在链上的过程话会在标记之后才 emit ——
   * 发言模型就会把过程话误判成结论，塌缩裁决随之失效。
   * 加这道屏障后，边界标记严格晚于已喂入文本的出站，过程话/结论划分确定。
   */
  async awaitPending(): Promise<void> {
    await this.chain;
  }

  /** 丢弃缓冲并停止后续推送（例如 turn 过期）。 */
  discard(): void {
    this.disposed = true;
    this.buffer = "";
    this.blockBuffer = "";
    this.tailBuffer = "";
    this.heldFirst = null;
    this.interimDone = !this.holdFirstSentence;
  }

  /** feed 链的分发入口：气泡拆分模式走切泡循环，否则走信息块循环。 */
  private flushComplete(): Promise<void> {
    if (!this.segmentationEnabled) return Promise.resolve();
    if (this.bubbleMode) return this.flushCompleteBubbles();
    return this.flushCompleteBlocks();
  }

  /** 气泡拆分模式：按切泡粒度逐泡分发，串行、泡间随机停顿。
   *
   * 切泡规则（2026-09-29 定稿，替代 09-28「首泡逗号可切」粒度）：
   * - 只在句末边界（。！？!?；;\n）切泡，逗号/顿号等句中位置永不切——
   *   一段话必须正确讲完才发，不靠字数在句中随便截断（09-29 用户反馈，
   *   事故样例："国庆哪都人多，这是定律，/ 躲不掉的。"被逗号阈值拦腰
   *   切成两条，第二条以依附半句"躲不掉的。"开头）。
   * - 句末边界的字数只是"短句并泡"的下限：首泡 ≥2 可见字（短应答
   *   "好的。"随到随出、TTFT 优先），后续泡 ≥12 可见字（短句合并成
   *   饱满的泡，数量自然收敛，不再逐句碎裂）。
   * - 换行无条件切（段落/分行是模型刻意的结构分组，永远该换泡）。
   * - 泡尾/泡首剥悬挂逗号与空白（真人消息不以逗号开头/结尾）。
   * - 首泡之前零停顿（TTFT 不受影响），第 2 泡起泡间随机停顿
   *   bubbleGapMinMs~bubbleGapMaxMs，末泡之后无停顿。
   * - 超过 maxBubbles 后不再切泡，剩余内容留在缓冲，由 flushFinal 以
   *   "continue" 并入末泡（防刷屏重量上限）。
   */
  private async flushCompleteBubbles(): Promise<void> {
    while (!this.disposed) {
      if (this.bubbleCount >= this.maxBubbles) break;
      const firstBubble = this.bubbleCount === 0;
      const brk = this.findBubbleBreak(
        this.buffer,
        firstBubble ? BUBBLE_MIN_STRONG_CHARS : BUBBLE_MIN_CHARS,
      );
      if (!brk) break; // 暂无达标的切泡点
      const raw = this.buffer.slice(0, brk.index + 1);
      // 消费边界字符，并剥掉余文的leading逗号/顿号/空白
      this.buffer = this.buffer
        .slice(brk.index + 1)
        .replace(/^[\s，,、]+/u, "");
      const text = raw.replace(BUBBLE_EDGE_STRIP_RE, "");
      if (!text || !BUBBLE_VISIBLE_CHAR_RE.test(text)) continue;
      const deduped = stripSentencesAlreadySaid(this.emittedText, text).trim();
      if (!deduped) continue; // 句级去重后为空（整句已说过）→ 不成泡
      if (this.bubbleCount > 0 && this.bubbleGapMaxMs > 0) {
        const span = Math.max(1, this.bubbleGapMaxMs - this.bubbleGapMinMs + 1);
        await sleep(this.bubbleGapMinMs + Math.floor(Math.random() * span));
        if (this.disposed) return;
      }
      this.trackEmitted(deduped);
      this.bubbleCount += 1;
      this.emit(deduped, "stream", { bubble: "new" });
    }
  }

  /** 从缓冲中找第一个达标的切泡点（不含则 null）。
   *  只在强边界切：换行无条件切（段落/分行是模型刻意的结构分组，永远该换泡）；
   *  句末标点须边界前可见字达标（首泡/后续泡两档下限）。字数只决定"句末边界
   *  到了切不切"（太短的句子并进下一泡），绝不是切点本身——逗号等句中位置
   *  永不切泡（2026-09-29 用户反馈：一段话必须正确讲完，不靠字数随便截断）。 */
  private findBubbleBreak(
    buf: string,
    minStrongChars: number,
  ): { index: number } | null {
    let visible = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === "\n") return { index: i };
      if (BUBBLE_STRONG_BREAK_RE.test(ch)) {
        if (visible >= minStrongChars) return { index: i };
      } else if (BUBBLE_VISIBLE_CHAR_RE.test(ch)) {
        visible += 1;
      }
    }
    return null;
  }

  /** 按信息块逐块分发：每个完整语义块单独作为一段，串行、带块间停顿。
   *  禁用分段时直接返回，不切块。 */
  private async flushCompleteBlocks(): Promise<void> {
    if (!this.segmentationEnabled) return;
    while (!this.disposed) {
      const brk = this.findBoundary(this.buffer);
      if (brk < 0) break; // 暂无完整句子
      const sentence = this.buffer.slice(0, brk + 1);
      this.buffer = this.buffer.slice(brk + 1);
      const raw = sentence.trim();
      if (!raw) continue;
      // 纯标点/无实际内容的碎片（如单个"。"或"！"）不单独成块，直接跳过；
      // 含汉字/字母/数字的短句（如"好的。"）是真实短句，照常参与信息块。
      if (
        raw.length < this.minSegmentChars &&
        !/[A-Za-z0-9\u4e00-\u9fa5]/.test(raw)
      ) {
        continue;
      }
      // 首个分句先按住为首句正文段（仅整条回复一次），等后续内容确认后再带间隔发出
      if (this.heldFirst === null && !this.interimDone) {
        this.heldFirst = raw;
        continue;
      }
      // 判定是否切新块（话题转换 / 段落换行 / 列表编号 / 块已达到目标长度）
      const shouldBreak = this.shouldBreakBlock(this.blockBuffer, raw);
      if (shouldBreak) {
        await this.emitCurrentBlock();
        if (this.disposed) return;
        this.blockBuffer = raw;
      } else {
        this.blockBuffer += raw;
      }
      // 首句直出（2026-09-28）：尚未推送任何内容时，首个完整句不等
      // blockCharTarget 累积立即成块发出——TTFT 从「第二块边界/flushFinal」
      // 提前到「首个完整句边界」；后续块仍按目标长度/话题边界切分。
      const firstOutPending =
        this.streamBlockCount === 0 && this.emittedText === "";
      // 块达到目标长度 → 提前终结当前块（同话题内容也控制单块体量）
      if (firstOutPending || this.blockBuffer.length >= this.blockCharTarget) {
        await this.emitCurrentBlock();
        if (this.disposed) return;
      }
    }
  }

  /** 判断是否应开启新的信息块。 */
  private shouldBreakBlock(acc: string, next: string): boolean {
    if (!acc) return false;
    // 段落换行
    if (/^\s*\n/.test(next)) return true;
    // 列表项 / 编号起始
    if (LIST_ITEM_BREAK_RE.test(next)) return true;
    // 话题转换连词起始
    if (TOPIC_SHIFT_RE.test(next)) return true;
    return false;
  }

  /** 把当前累积的信息块发射出去（去重 + 重量上限裁决 + 停顿）。 */
  private async emitCurrentBlock(): Promise<void> {
    const raw = this.blockBuffer.trim();
    this.blockBuffer = "";
    if (!raw) return;
    const deduped = stripSentencesAlreadySaid(this.emittedText, raw).trim();
    if (!deduped) return;
    if (this.pauseMs > 0) {
      await sleep(this.pauseMs);
      if (this.disposed) return;
    }
    await this.dispatchSegment(deduped);
  }

  /**
   * 分发一个信息块：
   * - 首个分句（heldFirst）先作为正文第一段发出，间隔后再接当前正文块，
   *   保留"先应一句、停顿、再详细说"的节奏；全部统一为 stream 相别，不另开垫词气泡。
   * - 其余信息块按顺序发为正文(stream)；
   * - 首正文块会针对已发出的首句再做一次句级去重，消除"首句与正文开头重复"。
   * - 超过重量上限的正文并入尾部块，最后一次性输出（防刷屏）。
   */
  private async dispatchSegment(segment: string): Promise<void> {
    // 有被按住的首句 → 先发首句正文段，停顿后再发当前正文块
    if (this.heldFirst !== null) {
      const first = this.heldFirst;
      this.heldFirst = null;
      this.interimDone = true;
      this.trackEmitted(first);
      this.emit(first, "stream");
      if (this.interimReplyGapMs > 0) {
        await sleep(this.interimReplyGapMs);
        if (this.disposed) return;
      }
      // 关键去重：segment 在 emitCurrentBlock 里的去重是基于首句被 track 之前的
      // emittedText（当时为空），未覆盖首句本身。这里针对 first 二次去重，
      // 避免"好的。"等首句在下一段落开头原样复现。
      const body = stripSentencesAlreadySaid(first, segment).trim();
      if (!body) {
        // 正文与首句完全重复（整段复述）→ 不再另行发一段
        this.streamBlockCount++;
        return;
      }
      this.trackEmitted(body);
      this.emit(body, "stream");
      this.streamBlockCount++;
      return;
    }
    // 重量上限：正文块数已达上限 → 并入尾部块，不再单开气泡
    if (this.streamBlockCount >= this.maxStreamSegments) {
      this.tailBuffer += segment;
      return;
    }
    this.trackEmitted(segment);
    this.emit(segment, "stream");
    this.streamBlockCount++;
  }

  /** 从缓冲中找第一个完整句子的边界下标（不含则 -1）。
   *
   * 硬边界：句号/感叹号/问号/分号/换行（。！？!?；;\n）—— 命中即切。
   * 软边界：当缓冲长度 > COMMA_SOFT_LEN、且前缀里已有 >= COMMA_SOFT_COUNT 个逗号时，
   * 逗号（，,）也算边界。真人说话会在长句中间换气，逗号软边界能把超长并列、
   * 列表说明（"1.xxx，2.yyy，3.zzz"）等更自然地拆开，而不是一口气吞下几十字。
   */

  /** 把新文本并入已推送文本，用于句级增量去重。 */
  private trackEmitted(text: string): void {
    if (!text) return;
    this.emittedText = this.emittedText ? `${this.emittedText} ${text}` : text;
  }

  private findBoundary(buf: string): number {
    const COMMA_SOFT_LEN = 40;
    const COMMA_SOFT_COUNT = 2;
    let commaCount = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (SEGMENT_BOUNDARY_RE.test(ch)) return i;
      if (ch === "，" || ch === ",") {
        commaCount += 1;
        if (i + 1 >= COMMA_SOFT_LEN && commaCount >= COMMA_SOFT_COUNT) return i;
      }
    }
    return -1;
  }
}