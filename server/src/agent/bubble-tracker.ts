import type { StreamSegmentEmitMeta } from "./stream-segmenter.js";

/**
 * BubbleTracker —— 真·分绿泡的 chunk→气泡记账器（2026-09-28）。
 *
 * WS 层在 bubbleSplitActive 时用把每个 chunk 分配到对应气泡：
 * - meta.bubble === "new"（或尚无泡）→ 开新泡，messageId = `assistant-$traceId-bN`
 *   （N 从 1 递增；避开历史垫词气泡的 `interim-` 保留前缀，见 main.dart 去重逻辑）。
 * - 其余（"continue" / 直推段）→ 追加到当前末泡。
 * - 全程记账各泡定稿文本，done 载荷据此携带 bubbles 对账数组。
 * 未激活时所有 chunk 走原协议（messageId 恒 assistant-$traceId，无 bubbleIndex）。
 */
export class BubbleTracker {
  private seq = 0;
  private currentId = "";
  private readonly bubbles: Array<{ id: string; text: string }> = [];

  /** 本轮是否命中确认轮工具（calendar.create，与 agent-core
   *  CALENDAR_CONFIRM_TOOLS 同源）。确认轮保留出口收口塌缩（用户 2026-09-24
   *  拍板的确认轮废话收口），其余分泡轮"说话算话"不改口。 */
  confirmationAnchored = false;

  constructor(
    /** 是否激活（WS 门禁：文字轮 + 非语音 + env 开关）。 */
    public active = false,
    private readonly baseMessageId: string,
  ) {}

  /** 分配一个已清洗 chunk 的出站 messageId 并记账泡文本。
   *
   *  开泡条件（2026-11-06 深夜定稿）：emit 带 bubble:"new"，或本轮还没有
   *  任何泡——两条都开新泡。其余（"continue"/直推段）追加当前末泡。
   *  **tracker 自身没有「冻结」态**：信息类工具轮的「并回单泡」由 WS 层
   *  通过分段器 disableBubbleMode（仅 search/weather/market/clock 埐）
   *  定向关泡实现，无 meta 段落到这里自然并回当前泡/兜底开首泡。曾经的
   *  tracker 冻结位会让冻结后首个 chunk 在无泡时对空数组取 [-1] 直接
   *  TypeError、静默炸掉整条分泡出站——这正是 2026-11-06 截图事故根因，
   *  勿以任何形式把冻结位加回 tracker。 */
  assign(
    cleanedChunk: string,
    meta?: StreamSegmentEmitMeta,
  ): { messageId: string; bubbleIndex?: number } {
    if (!this.active) return { messageId: this.baseMessageId };
    if (meta?.bubble === "new" || !this.currentId) {
      this.seq += 1;
      this.currentId = `${this.baseMessageId}-b${this.seq}`;
      this.bubbles.push({ id: this.currentId, text: "" });
    }
    this.bubbles[this.bubbles.length - 1].text += cleanedChunk;
    return { messageId: this.currentId, bubbleIndex: this.seq };
  }

  /** 是否已推出过气泡（决定 done 是否携带 bubbles 字段）。 */
  get hasBubbles(): boolean {
    return this.active && this.bubbles.length > 0;
  }

  /** 末泡 id（done 的 messageId 指向它）；无泡时回退基础 id。 */
  get outboundDoneMessageId(): string {
    return this.hasBubbles
      ? this.bubbles[this.bubbles.length - 1].id
      : this.baseMessageId;
  }

  /** bubbles 对账数组快照（done 载荷用，防外部误改内部态）。 */
  get snapshot(): Array<{ id: string; text: string }> {
    return this.bubbles.map((b) => ({ id: b.id, text: b.text }));
  }

  /**
   * 分泡轮对「出口最终文本 vs 已流文本」分歧的裁决（2026-09-28 说话算话根修）。
   *
   * 出口收口链（风格闸隔离重写 / 自检重跑 / emergencyRegenerate）可能在流式
   * 之后产出换版本文本。残差小（确定性收口差异）→ "feed" 照旧补推（追加到
   * 末泡）；残差 ≥40%（整段换说法）→：
   * - 普通分泡轮 "discard"：已流式分泡即最终回复——真人不会把说出去的话吞回
   *   来重说。重写版本对展示侧废弃（done.finalText 仍携带，记忆/语音链路用），
   *   不再打 finalTextReplacesStream，客户端永不塌缩。
   * - 确认轮 "replace"：保留既有收口语义（客户端塌缩成重写后的短确认）。
   */
  resolveDivergence(residualLen: number, finalFeedLen: number): "feed" | "discard" | "replace" {
    if (residualLen <= 0) return "feed";
    if (residualLen >= finalFeedLen * 0.4) {
      return this.confirmationAnchored ? "replace" : "discard";
    }
    return "feed";
  }
}
