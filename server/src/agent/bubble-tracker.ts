/**
 * BubbleTracker —— 气泡块 id 分配与记账（方案 C：同 block 身份原地升级）。
 *
 * 两条写入路径共用同一套 id 分配（`assistant-$traceId-bN`，N 从 1 递增；
 * 避开历史垫词气泡的 `interim-` 保留前缀，见 main.dart 去重逻辑）：
 * - 流式：`appendStreamBlock` 按分段器块边界开新块/续写当前块，块 id 随
 *   `chat.assistant_chunk` 实时下发；
 * - 定稿：`setFinalBubbles` 按最终文本重排，前 N 个 id 与流式块**按位置一一
 *   对应**（同 base + 同序号），客户端据此原地 patch/追加，不重建、不闪回。
 *
 * done 载荷携带 bubbles 对账数组（id+定稿文本），客户端逐泡定稿。
 */
export class BubbleTracker {
  private seq = 0;
  private readonly bubbles: Array<{ id: string; text: string }> = [];

  constructor(private readonly baseMessageId: string) {}

  /** 是否已推出过气泡（决定 done 是否携带 bubbles 字段）。 */
  get hasBubbles(): boolean {
    return this.bubbles.length > 0;
  }

  /**
   * 流式块写入：openNew=true 开新块（块 id 递增），否则把增量并回当前末块。
   * 返回当前块 id —— 与 done 的 bubbles id 同源，客户端按 id 续写。
   */
  appendStreamBlock(text: string, openNew: boolean): string {
    if (openNew || this.bubbles.length === 0) {
      this.seq += 1;
      this.bubbles.push({ id: `${this.baseMessageId}-b${this.seq}`, text });
    } else {
      this.bubbles[this.bubbles.length - 1].text += text;
    }
    return this.bubbles[this.bubbles.length - 1].id;
  }

  /** 出口一次性建泡：整段裁决通过后，按最终文本拆出的气泡写入对账数组。 */
  setFinalBubbles(texts: string[]): void {
    this.bubbles.length = 0;
    this.seq = 0;
    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      this.seq += 1;
      this.bubbles.push({ id: `${this.baseMessageId}-b${this.seq}`, text: trimmed });
    }
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
}
