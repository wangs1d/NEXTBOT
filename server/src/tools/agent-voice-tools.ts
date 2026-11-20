import { resolveActorId } from "../agent/actor-id.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ReachDecisionService } from "../proactivity/reach-decision-service.js";

/**
 * 用户是否显式要求语音条（显式请求绕过触达决策闸门）。
 * 与 composite-chat-tools 的 voice.message keywords 保持同一口径。
 */
const EXPLICIT_VOICE_RE =
  /语音消息|发语音|语音回复|用语音|语音条|发条语音|发段语音|语音说|念给我听|读给我听/;

function isExplicitVoiceRequest(userText: string | undefined): boolean {
  return typeof userText === "string" && EXPLICIT_VOICE_RE.test(userText);
}

/** 播报特有的显式表达（"播报一下""说给我听"等），同样绕过闸门。 */
const EXPLICIT_SPEAK_RE = /播报|念出来|说给我听|讲给我听|语音告诉我|读出声|说出来/;

function isExplicitSpeakRequest(userText: string | undefined): boolean {
  return (
    isExplicitVoiceRequest(userText) ||
    (typeof userText === "string" && EXPLICIT_SPEAK_RE.test(userText))
  );
}

/** LLM 自报的 priority 映射为价值 stakes；刻意不映射到 importance=critical，
 *  否则模型只要填 urgent 就能拿到 must 旁路，频率闸门会被架空。 */
const SPEAK_STAKES: Record<"low" | "medium" | "high" | "urgent", number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.7,
  urgent: 0.85,
};

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
 * 沙箱可用：本工具不涉及高权限操作（仅合成 + WS 推送），无需「完全访问」。
 */
export function registerAgentVoiceTools(
  registry: ToolRegistry,
  voiceCapability: VoiceCapabilityService,
  reachDecision?: ReachDecisionService,
): void {
  registry.register("voice.speak", async (input, context) => {
    const actorId = resolveActorId(context);
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

    // ── 主动触达决策闸门（voice.speak）──
    // 语音播报是最重的常用通道之一（直接响、无 UI 跳过），比语音条更容易打扰。
    // 用户显式要求播报 → 绕过；agent 自主播报 → 问期望效用决策层。
    // 未注入决策服务时保持旧行为（向后兼容）。
    if (reachDecision && !isExplicitSpeakRequest(context.userText)) {
      const decision = reachDecision.decide({
        actorId,
        kind: "agent_voice_speak",
        // importance 固定 medium：priority 只影响 stakes，不给模型自报 must 旁路的机会
        importance: "medium",
        requestedChannel: "voice.speak",
        // LLM 已选定语音通道：跳过 admission 门槛，静默/突发/负反馈等守卫照旧生效
        respectRequestedChannel: true,
        value: {
          stakes: SPEAK_STAKES[priority],
          // 提醒类有明确时效诉求；即时播报按基线
          urgency: mode === "reminder" ? 0.6 : 0.4,
          beneficiary: 0.9,
        },
      });
      // 决策选中 voice.speak（或更重的 phone，说明语音播报必然负担得起）才播；
      // 选了 chat / voice.message = "更轻的通道就够"，改用文本回复。
      const voiceAllowed =
        decision.action === "send_now" &&
        (decision.channel === "voice.speak" || decision.channel === "phone");
      if (!voiceAllowed) {
        return {
          ok: false,
          suppressedByReachDecision: true,
          action: decision.action,
          channel: decision.channel,
          reason: decision.reason,
          utility: decision.utility,
          acceptance: decision.p,
          summary: `主动语音播报被触达决策抑制（${decision.action}${decision.channel ? `/${decision.channel}` : ""}: ${decision.reason}）。请改用普通文本回复，不要复述本提示。`,
        };
      }
    }

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
    // 计入语音突发窗口：后续 decide 的 BURST_BREAKER 才能拦住连发。
    // 记账是旁路：失败绝不影响已成功的播报。
    try {
      reachDecision?.recordVoiceDelivery(actorId);
    } catch {
      /* burst accounting is best-effort */
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
   *
   * 禁用场景：
   *   - 用户在开会 / 不方便听语音时（除非明确要求）
   *   - 短指令回复（"好的" / "知道了"），用文本更高效
   */
  registry.register("voice.send_message", async (input, context) => {
    const actorId = resolveActorId(context);
    const text = String(input.text ?? input.message ?? "").trim();

    if (!text) {
      return { ok: false, error: "缺少 text（语音消息要朗读的内容）" };
    }

    // ── 主动触达决策闸门 ──
    // 用户显式说"发语音"→ 绕过（对齐 must/explicit bypass）。
    // 否则（agent 自主决定用语音条）→ 问期望效用决策层：drop/defer 时不发，
    // 返回结构化原因让 LLM 改用文本，而不是硬失败。
    // 未注入决策服务时保持旧行为（向后兼容）。
    if (reachDecision && !isExplicitVoiceRequest(context.userText)) {
      const decision = reachDecision.decide({
        actorId,
        kind: "agent_voice_message",
        importance: "medium",
        requestedChannel: "voice.message",
        // LLM 已选定语音条通道：跳过 admission 门槛，静默/突发/负反馈守卫照旧生效
        respectRequestedChannel: true,
        value: { stakes: 0.5, urgency: 0.4, beneficiary: 0.9 },
      });
      // send_now 但决策选了 chat = "文本就够了，不必发语音"；drop/defer 同理不发。
      // 只有决策认可语音通道（voice.message / voice.speak）才真正合成发送。
      const voiceAllowed =
        decision.action === "send_now" &&
        (decision.channel === "voice.message" || decision.channel === "voice.speak");
      if (!voiceAllowed) {
        return {
          ok: false,
          suppressedByReachDecision: true,
          action: decision.action,
          channel: decision.channel,
          reason: decision.reason,
          utility: decision.utility,
          acceptance: decision.p,
          summary: `主动语音条被触达决策抑制（${decision.action}${decision.channel ? `/${decision.channel}` : ""}: ${decision.reason}）。请改用普通文本回复，不要复述本提示。`,
        };
      }
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
    // 计入突发窗口：连发语音条会被 BURST_BREAKER 拦下。记账是旁路，失败不影响发送。
    try {
      reachDecision?.recordVoiceDelivery(actorId);
    } catch {
      /* burst accounting is best-effort */
    }

    const seconds = Math.max(1, Math.round(result.durationMs / 1000));
    const providerHint = result.provider ? `（TTS：${result.provider}）` : "";

    return {
      ok: true,
      messageId: result.messageId,
      mediaUrl: result.mediaUrl,
      durationMs: result.durationMs,
      durationSeconds: seconds,
      pushed: result.pushed,
      summary: result.pushed
        ? `已发送语音消息（${seconds}"）${providerHint}。用户客户端会渲染为可重播的语音气泡。`
        : `语音消息已生成但用户当前离线，上线后可收到。${providerHint}`,
    };
  });
}
