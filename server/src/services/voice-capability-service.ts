import { randomUUID } from "crypto";
import { ServerEventType } from "../protocol.js";
import type { TtsService } from "./tts-service.js";
import type { VoiceMessageService } from "./voice-message-service.js";
import type { VoiceDialogueService } from "./voice-dialogue/voice-dialogue-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";

/**
 * Agent 底层语音能力中枢（TTS + WS 推送 + 能力自描述）。
 *
 * 设计目标：
 *   1. **底层能力**：TTS 是 Agent 的基础能力，与具体业务（电话触达、提醒闹钟、
 *      主动消息、对话式交互等）解耦。业务方只需向本服务请求"合成+推送"。
 *   2. **Agent 自调度**：通过 `voice.speak` 工具暴露给 LLM，Agent 可在不走电话触达
 *      （phone.call_user）的前提下，直接对用户进行语音播报。
 *   3. **单一传输抽象**：所有"对用户说话"的 WS 推送走本服务统一的事件类型，
 *      客户端只需订阅 `agent.voice.*` 事件族即可覆盖所有语音场景。
 *
 * 与既有模块的关系：
 *   - `TtsService`：保留，纯合成（mp3 base64），不感知 WS。
 *   - `VoiceDialogueService`：保留，Provider 注册表（多 TTS/LLM 提供商切换）。
 *   - `VirtualPhoneService`：保留，电话触达专用（带前摇振铃 + 来电 UI）；其 TTS 合成
 *     仍直接调 `TtsService`，但 `agent.proactive_voice` / `tts_alarm_play` 等非电话
 *     场景统一改走本服务。
 */

/** 语音播报模式。 */
export type VoiceSpeakMode =
  /** 即时播报：立即推送音频，客户端后台播放，无 UI 强制（默认）。 */
  | "instant"
  /** 提醒式播报：推送带标题/优先级的事件，客户端可显示通知卡片 + 播放音频。 */
  | "reminder";

/** voice.speak / synthesizeAndPush 的参数。 */
export interface VoiceSpeakParams {
  /** 目标用户 ID（一般等于 actorId）。 */
  toUserId: string;
  /** 要朗读的文字内容。 */
  text: string;
  /** 播报模式，默认 "instant"。 */
  mode?: VoiceSpeakMode;
  /** reminder 模式下的标题（仅 mode="reminder" 生效）。 */
  title?: string;
  /** reminder 模式下的优先级。 */
  priority?: "low" | "medium" | "high" | "urgent";
  /** 关联的会话 ID / traceId，便于客户端做去重与上下文关联。 */
  traceId?: string;
  /** TTS 语音配置（透传给底层 provider，可选）。 */
  voiceId?: string;
  speed?: number;
}

/** 语音播报结果。 */
export interface VoiceSpeakResult {
  ok: boolean;
  /** 本次播报的唯一 ID（用于 stop / 审计）。 */
  voiceId?: string;
  /** 是否成功推送到用户 WS。 */
  pushed?: boolean;
  /** TTS 提供商（minimax / openai / none）。 */
  provider?: string;
  /** 失败原因。 */
  error?: string;
  /** TTS 未启用时的兜底提示。 */
  skippedReason?: string;
}

/** Agent 语音能力自描述（供能力清单 / 工具元数据使用）。 */
export interface VoiceCapabilityInfo {
  /** TTS 是否可用（至少一个 provider 已配置）。 */
  ttsEnabled: boolean;
  /** 当前 TTS 提供商。 */
  ttsProvider: "minimax" | "openai" | "none";
  /** 已注册的语音对话 provider 列表。 */
  availableProviders: string[];
}

export interface VoiceCapabilityDeps {
  ttsService: TtsService;
  voiceDialogueService: VoiceDialogueService;
  wsRegistry: ClientPushPort;
  /** 语音消息落盘服务（可选；未注入时 voice.send_message 工具不可用）。 */
  voiceMessageService?: VoiceMessageService;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export class VoiceCapabilityService {
  constructor(private readonly deps: VoiceCapabilityDeps) {}

  /**
   * 纯 TTS 合成（不推送 WS）。
   * 业务方需要音频字节但不需立即对用户播报时使用（如微信桥、电话来电预生成）。
   */
  async synthesize(text: string): Promise<
    | { ok: true; format: "mp3"; base64: string; provider?: string }
    | { ok: false; reason: string }
  > {
    return this.deps.ttsService.synthesizeMp3Base64(text);
  }

  /**
   * 合成 + 推送：Agent "对用户说话" 的统一入口。
   *
   * 推送事件：
   *   - mode="instant"  → `agent.voice.speak`（轻量，客户端后台播放）
   *   - mode="reminder" → `agent.voice.alarm`（带标题/优先级，客户端可显示卡片）
   *
   * TTS 未启用时仍推送事件，但 tts 字段为 null，客户端可用本地 TTS 兜底。
   */
  async speak(params: VoiceSpeakParams): Promise<VoiceSpeakResult> {
    const toUserId = params.toUserId?.trim();
    if (!toUserId) return { ok: false, error: "toUserId 不能为空" };
    const text = params.text?.trim();
    if (!text) return { ok: false, error: "text 不能为空" };

    const mode: VoiceSpeakMode = params.mode === "reminder" ? "reminder" : "instant";
    const voiceId = randomUUID();

    // 合成（失败也继续推送，让客户端用文本兜底）
    const ttsResult = await this.deps.ttsService.synthesizeMp3Base64(text);
    const ttsPayload = ttsResult.ok
      ? { format: ttsResult.format, base64: ttsResult.base64, provider: ttsResult.provider }
      : { format: null, skippedReason: ttsResult.reason };

    const eventPayload: Record<string, unknown> = {
      voiceId,
      toUserId,
      text,
      mode,
      traceId: params.traceId ?? null,
      tts: ttsPayload,
      timestamp: new Date().toISOString(),
    };

    if (mode === "reminder") {
      eventPayload.title = params.title ?? "语音提醒";
      eventPayload.priority = params.priority ?? "medium";
    }

    const eventType =
      mode === "reminder" ? ServerEventType.AgentVoiceAlarm : ServerEventType.AgentVoiceSpeak;

    const pushed = this.deps.wsRegistry.trySend(
      toUserId,
      JSON.stringify({ type: eventType, payload: eventPayload }),
    );

    if (!pushed) {
      this.deps.logger?.warn?.(
        `[VoiceCapability] WS 推送失败（用户离线）：toUserId=${toUserId} mode=${mode}`,
      );
    }

    return {
      ok: true,
      voiceId,
      pushed,
      provider: ttsResult.ok ? ttsResult.provider : undefined,
      skippedReason: ttsResult.ok ? undefined : ttsResult.reason,
    };
  }

  /**
   * 发送微信式可重播语音消息：合成 + 落盘 + 推 WS `agent.voice.message` 事件。
   *
   * 与 `speak()` 的区别：
   *   - `speak()`：即时播报，无 UI，客户端后台播放一次性。
   *   - `sendMessage()`：落地为可重播语音消息，客户端渲染为微信式语音气泡，
   *     可多次点击重播，带 mediaUrl / durationMs / transcript。
   *
   * TTS 失败时仍推送事件（tts 字段为 null），客户端可降级为纯文本消息。
   */
  async sendMessage(params: VoiceSpeakParams): Promise<
    | {
        ok: true;
        messageId: string;
        mediaUrl: string;
        durationMs: number;
        transcript: string;
        pushed: boolean;
        provider?: string;
      }
    | { ok: false; error: string }
  > {
    const toUserId = params.toUserId?.trim();
    if (!toUserId) return { ok: false, error: "toUserId 不能为空" };
    const text = params.text?.trim();
    if (!text) return { ok: false, error: "text 不能为空" };

    const voiceMessageService = this.deps.voiceMessageService;
    if (!voiceMessageService) {
      return { ok: false, error: "VoiceMessageService 未注入，voice.send_message 不可用" };
    }

    // 合成 + 落盘
    const stored = await voiceMessageService.composeAndStore(text, toUserId);
    const messageId = randomUUID();
    const traceId = params.traceId ?? null;

    if (!stored.ok) {
      // TTS 失败：仍推一条带 transcript 的事件，让客户端降级为纯文本消息
      const eventPayload = {
        messageId,
        toUserId,
        text,
        transcript: text,
        mediaUrl: null,
        durationMs: 0,
        traceId,
        timestamp: new Date().toISOString(),
        skippedReason: stored.reason,
      };
      this.deps.wsRegistry.trySend(
        toUserId,
        JSON.stringify({ type: ServerEventType.AgentVoiceMessage, payload: eventPayload }),
      );
      return {
        ok: false,
        error: stored.reason,
      };
    }

    const eventPayload = {
      messageId,
      toUserId,
      text,
      transcript: text,
      mediaUrl: stored.mediaUrl,
      durationMs: stored.durationMs,
      traceId,
      timestamp: new Date().toISOString(),
      provider: stored.provider,
    };

    const pushed = this.deps.wsRegistry.trySend(
      toUserId,
      JSON.stringify({ type: ServerEventType.AgentVoiceMessage, payload: eventPayload }),
    );

    if (!pushed) {
      this.deps.logger?.warn?.(
        `[VoiceCapability] sendMessage WS 推送失败（用户离线）：toUserId=${toUserId}`,
      );
    }

    return {
      ok: true,
      messageId,
      mediaUrl: stored.mediaUrl,
      durationMs: stored.durationMs,
      transcript: text,
      pushed,
      provider: stored.provider,
    };
  }

  /**
   * 主动语音通知（旧 `agent.proactive_voice` 通道的统一封装）。
   * 供 ProactiveOutboundMessageService 等"非 Agent 直调"场景使用。
   */
  async pushProactiveVoice(
    toUserId: string,
    title: string,
    text: string,
    traceId?: string,
  ): Promise<boolean> {
    const ttsResult = await this.deps.ttsService.synthesizeMp3Base64(`${title}。${text}`);
    return this.deps.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: "agent.proactive_voice",
        payload: {
          title,
          text,
          traceId: traceId ?? null,
          tts: ttsResult.ok
            ? { format: ttsResult.format, base64: ttsResult.base64, provider: ttsResult.provider }
            : null,
        },
      }),
    );
  }

  /** 能力自描述：供 Agent 能力清单 / HTTP /phone/me 等接口暴露。 */
  getCapabilityInfo(): VoiceCapabilityInfo {
    return {
      ttsEnabled: this.deps.ttsService.isEnabled(),
      ttsProvider: this.deps.ttsService.getProvider() as VoiceCapabilityInfo["ttsProvider"],
      availableProviders: this.deps.voiceDialogueService.getAvailableProviders(),
    };
  }
}
