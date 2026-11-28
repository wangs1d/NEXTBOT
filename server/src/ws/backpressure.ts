/**
 * WebSocket 出口背压工具。
 *
 * 背景：服务端此前只有浏览器预览帧做了 bufferedAmount 判定（见
 * chat-user-message.ts 的 pushBrowserPreview）。文字块（chat.assistant_chunk）
 * 与面板/U I 帧都是直接 send——弱网下内核发送缓冲越堆越多，RTT 被拖长后
 * 心跳 pong 超时，连接被掐（1006）。
 *
 * 语义分层：
 *   - droppable：可丢弃的中间帧（流式文字块、进度/面板帧）。缓冲超阈值直接跳过，
 *     正确性由回合收口的 `chat.assistant_done`（含全文/bubbles）兜底。
 *   - critical：不可丢（done、语音数据帧、卡片、媒体就绪），照常发送。
 */

/** 缓冲超过该值就丢弃可丢帧（约 256KB，弱网再堆已无意义）。 */
export const DROPPABLE_SOFT_LIMIT_BYTES = 256 * 1024;

export type SendSocketLike = {
  send: (data: string) => void;
  /** ws 的 bufferedAmount（未发送字节数）；测试桩可以缺省。 */
  bufferedAmount?: number;
};

export function bufferedBytes(socket: SendSocketLike): number {
  const n = (socket as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export type DroppableSendResult = "sent" | "dropped" | "failed";

/**
 * 发送可丢弃帧：缓冲超阈值时跳过（返回 dropped），异常返回 failed。
 * 调用方无需区分 sent/failed 之外的语义，丢弃是预期行为。
 */
export function sendDroppable(
  socket: SendSocketLike,
  frame: string,
  softLimit = DROPPABLE_SOFT_LIMIT_BYTES,
): DroppableSendResult {
  if (bufferedBytes(socket) > softLimit) return "dropped";
  try {
    socket.send(frame);
    return "sent";
  } catch {
    return "failed";
  }
}

/** 发送关键帧：不丢，失败返回 false（连接已失效）。 */
export function sendCritical(socket: SendSocketLike, frame: string): boolean {
  try {
    socket.send(frame);
    return true;
  } catch {
    return false;
  }
}
