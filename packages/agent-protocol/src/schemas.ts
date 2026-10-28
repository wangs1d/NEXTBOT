import { z } from "zod";

import { clientLocationWireSchema } from "./client-location.js";

const visionSourceKindSchema = z.enum(["device_camera", "external_stream", "agent_attachment"]);

/** WebSocket `chat.user_message` 可选附带视觉帧（与服务端 sanitize 逻辑对齐）。 */
export const visionFrameWireSchema = z.object({
  sourceKind: visionSourceKindSchema,
  sourceId: z.string().max(160).optional(),
  mimeType: z.string().min(3).max(120),
  dataBase64: z.string().min(1),
  capturedAt: z.string().max(64).optional(),
});

/** WebSocket `chat.agent_processing_ui`：与客户端「处理中」气泡/状态同步 */
export const agentProcessingUiSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  active: z.boolean(),
});

/** WebSocket `chat.user_message`：一次用户回合的完整入参（外壳 → runtime 的稳定契约）。 */
export const userMessageSchema = z
  .object({
    /** 兼容旧客户端；与 `userId` 同时存在时以 `userId` 为稳定用户标识 */
    sessionId: z.string().min(1),
    /** 稳定用户 id（推荐）；缺省时行为同仅发 `sessionId` */
    userId: z.string().min(1).optional(),
    messageId: z.string().min(1),
    /** 可与 `visionFrames` 二选一：仅有图时允许空串，由服务端补默认提示 */
    text: z.string(),
    timestamp: z.string().min(1),
    visionFrames: z.array(visionFrameWireSchema).max(16).optional(),
    /** 被打断的回复上下文，用于整合到下一次回复中 */
    interruptedContext: z.string().optional(),
    /** 客户端 IP（前端未上报定位时的兜底） */
    clientIp: z.string().optional(),
    /** 前端 GPS / 浏览器定位（优先于 IP） */
    clientLocation: clientLocationWireSchema.optional(),
    /** 已废弃：沙箱模式已移除，Agent 始终以 full 运行；字段保留仅为协议兼容 */
    agentAccessMode: z.enum(["sandbox", "full"]).optional(),
    /** 消息内容类型；默认 "text"。当为 "audio" 时，text 可为空，
     *  携带 mediaUrl 对应的音频（服务端不再自动转写，客户端自行消费音频）。 */
    contentType: z.enum(["text", "audio"]).optional(),
    /** audio 类型时的可访问 URL，如 `/agent/voice/messages/{actorId}/{msgId}.mp3` */
    mediaUrl: z.string().max(500).optional(),
    /** 音频时长（毫秒），用于 UI 展示与服务端审计 */
    durationMs: z.number().int().positive().max(120000).optional(),
    /** 客户端采集的波形数据（16-32 段归一化音量 0.0-1.0），用于气泡渲染 */
    waveform: z.array(z.number().min(0).max(1)).max(64).optional(),
  })
  .superRefine((data, ctx) => {
    const hasText = data.text.trim().length > 0;
    const hasVision = (data.visionFrames?.length ?? 0) > 0;
    const isAudio = data.contentType === "audio" && (data.mediaUrl?.trim().length ?? 0) > 0;
    if (!hasText && !hasVision && !isAudio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需要非空 text、至少一帧 visionFrames，或 audio 类型带 mediaUrl",
        path: ["text"],
      });
    }
  });

/** WebSocket：AIP 投递 */
export const aipDispatchWsSchema = z.object({
  toSessionId: z.string().min(1),
  envelope: z.record(z.string(), z.unknown()),
  /** 可选：与当前主会话用户消息关联（同 `chat.user_message.messageId`） */
  chatUserMessageId: z.string().min(1).optional(),
});
