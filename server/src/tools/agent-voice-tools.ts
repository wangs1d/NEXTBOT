import { resolveActorId } from "../agent/actor-id.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent 底层语音能力工具族（表达）：
 *   - voice.speak         → 轻量播报（无 UI，客户端后台一次性播放）
 *   - voice.send_message  → 微信式可重播语音消息（落地为语音气泡，可多次点击重播）
 *
 * 设计意图：
 *   - 语音（说）是 Agent 最底层元能力之一。voice.speak / voice.send_message 让
 *     Agent 在任何「需要对用户说话」的场景下直接调用，无需走电话流程。
 *   - 听（ASR）已从产品中移除：入站语音的理解由 realtime 语音引擎在通话中完成。
 *   - 与 phone.call_user 的区别：
 *       · voice.speak         → 即时播报，无来电 UI，无振铃，客户端后台播放
 *       · voice.send_message  → 落地语音消息，客户端渲染为微信式气泡
 *       · phone.call_user     → 来电体验，振铃 + 接通 + 通话 UI
 *
 * 2026-11-21：移除「触达决策闸门」。此前 voice.* 在合成前会问 ReachDecisionService，
 * 被判定"文本就够/上下文成本高"时 drop 退化成文字，表现为"不给调用语音"。
 * 现在语音工具被调用即无条件合成发送，不再有任何抑制闸门。
 *
 * 沙箱可用：本工具不涉及高权限操作（仅合成 + WS 推送），无需「完全访问」。
 */
export function registerAgentVoiceTools(
  registry: ToolRegistry,
  voiceCapability: VoiceCapabilityService,
): void {
  registry.register("voice.speak", async (input, context) => {
    const actorId = context.actorId?.trim() || resolveActorId(context);
    const text = String(input.text ?? input.message ?? "").trim();
    const modeRaw = String(input.mode ?? "instant").trim().toLowerCase();
    const mode = modeRaw === "reminder" ? "reminder" : "instant";

    if (!text) {
      return { ok: false, error: "缺少 text（要朗读的内容）" };
    }

    const title = String(input.title ?? "").trim() || undefined;
    const priorityRaw = String(input.priority ?? "medium").trim().toLowerCase();
    const priority: "low" | "medium" | "high" | "urgent" =
      priorityRaw === "low" || priorityRaw === "high" || priorityRaw === "urgent"
        ? priorityRaw
        : "medium";

    const result = await voiceCapability.speak({
      toUserId: actorId,
      text,
      mode,
      title,
      priority,
      traceId: context.chatUserMessageId ?? context.sessionId,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "语音播报失败",
        retryable: true,
      };
    }

    const providerHint = result.provider
      ? `（TTS 提供商：${result.provider}）`
      : result.skippedReason
        ? `（TTS 未启用：${result.skippedReason}，客户端将用本地语音兜底）`
        : "";

    return {
      ok: true,
      voiceId: result.voiceId,
      pushed: result.pushed,
      mode,
      summary: result.pushed
        ? `已向用户推送语音播报${providerHint}。用户客户端会自动播放。`
        : `语音播报已生成但用户当前离线（未连接 WebSocket），上线后可收到。${providerHint}`,
    };
  });

  /**
   * voice.send_message：发送微信式可重播语音消息。
   *
   * 与 voice.speak 的区别：
   *   - speak 是即时播报（一次性、后台播放、无 UI）
   *   - send_message 是落地为可重播语音消息（带 mediaUrl / durationMs / transcript），
   *     客户端渲染为微信式语音气泡，用户可多次点击重播。
   *
   * 适用场景：
   *   - 用户明确要求「发语音」「发条语音消息」「用语音回复」
   *   - 长文本回复，用语音更自然
   *   - 朋友式聊天场景，语音更有温度
   */
  registry.register("voice.send_message", async (input, context) => {
    // 推送目标必须用连接注册键（actorId），不能用可能与之不一致的 userId/sessionId：
    // trySend 按 WS 注册键查连接，键不一致会静默失败 → 工具返回 ok 但没有语音气泡。
    const actorId = context.actorId?.trim() || resolveActorId(context);
    const text = String(input.text ?? input.message ?? "").trim();

    if (!text) {
      return { ok: false, error: "缺少 text（语音消息要朗读的内容）" };
    }

    const result = await voiceCapability.sendMessage({
      toUserId: actorId,
      text,
      traceId: context.chatUserMessageId ?? context.sessionId,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "语音消息发送失败",
        retryable: true,
      };
    }

    const seconds = Math.max(1, Math.round(result.durationMs / 1000));
    const providerHint = result.provider ? `（TTS：${result.provider}）` : "";

    // 回执只给模型看，不给用户看。明确禁止在正文复述语音内容或秒数：
    // 此前 summary 带「已发送语音消息（N"）...」，模型把它复述成
    // 「语音发过去了大哥，五十四秒」——而 N 来自错的码率估算，用户看到编的数字。
    return {
      ok: true,
      messageId: result.messageId,
      mediaUrl: result.mediaUrl,
      durationMs: result.durationMs,
      durationSeconds: seconds,
      pushed: result.pushed,
      summary: result.pushed
        ? `语音消息已作为可重播语音气泡落入对话流${providerHint}。禁止在正文复述这条语音的内容或时长，也不要用「发过去了/已送达」之类措辞——用户能直接看到气泡，任何复述都是编造。调用完只需自然接下一句。`
        : `语音消息已生成，但当前连接不可达${providerHint}。不要声称送达；如确需说明，只说「稍后重连可收听」，不要编造时长。`,
    };
  });
}
