/**
 * BubbleTracker —— 气泡块 id 分配与记账（2026-11-25 车道架构）。
 *
 * 唯一写入路径是流式：`appendStreamBlock` 按分段器块边界开新块/续写当前块，
 * 块 id（`assistant-$traceId-bN`，N 从 1 递增；避开历史垫词气泡的 `interim-`
 * 保留前缀，见 main.dart 去重逻辑）随 `chat.assistant_chunk` 实时下发。
 * 流式块就是最终呈现——done 的 bubbles 对账数组只是本账本照实快照
 * （id+文本），客户端按 id 原地定稿，不存在 done 重建/重排的另一套分配。
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

  /** 已流出的全部块文本（兜底补漏的「已说过」口径；段间以换行相连）。 */
  get streamedText(): string {
    return this.bubbles.map((b) => b.text).join("\n");
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

  /**
   * 流式撤回后清账：chat.stream_reset 已让客户端删掉全部已落屏块，本轮回到
   * 单条车道语义（done 按普通单条收口，不带 bubbles）。seq 一并归零，避免
   * 同 trace 复用轮的 id 继续递增造成跨轮错位。
   */
  reset(): void {
    this.seq = 0;
    this.bubbles.length = 0;
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
