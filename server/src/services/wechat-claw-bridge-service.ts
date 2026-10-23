import { getDataDir } from "../config/data-dir.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";

import { resolveActorId } from "../agent/actor-id.js";
import { parseAgentAccessMode } from "../agent/agent-access-mode.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { createExternalChatProviderFromEnv } from "../external-model/resolve-provider.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import { runChatTurnForActor, type ChatTurnInput } from "./chat-turn-runner.js";
import { isWechatClawFeatureEnabled } from "./openclaw-gateway-client.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import { sanitizeWechatInboundText } from "./wechat-inbound-text.js";
import type { MessageHubService } from "./message-hub-service.js";
import type { TtsService } from "./tts-service.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isWechatClawBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WECHAT_CLAW_BRIDGE_ENABLED);
}

export function readWechatClawBridgeConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  token: string | null;
  defaultActorId: string;
  serverPort: number;
} {
  const port = Number(env.PORT ?? "3000");
  return {
    enabled: isWechatClawBridgeEnabled(env),
    token: env.WECHAT_CLAW_BRIDGE_TOKEN?.trim() || null,
    defaultActorId:
      env.WECHAT_CLAW_BRIDGE_ACTOR_ID?.trim() ||
      env.DESKTOP_BRIDGE_USER_ID?.trim() ||
      "session-mvp-001",
    serverPort: Number.isFinite(port) ? port : 3000,
  };
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const n = ip.replace(/^::ffff:/, "");
  return n === "127.0.0.1" || n === "::1" || n === "localhost";
}

export function assertWechatClawBridgeAuthorized(
  request: FastifyRequest,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { token } = readWechatClawBridgeConfig(env);
  if (token) {
    const header =
      (typeof request.headers.authorization === "string"
        ? request.headers.authorization.replace(/^Bearer\s+/i, "").trim()
        : "") ||
      (typeof request.headers["x-wechat-claw-bridge-token"] === "string"
        ? request.headers["x-wechat-claw-bridge-token"].trim()
        : "");
    if (header !== token) {
      throw new Error("微信消息桥鉴权失败");
    }
    return;
  }
  const ip = request.ip;
  if (!isLoopbackIp(ip)) {
    throw new Error("未配置 WECHAT_CLAW_BRIDGE_TOKEN 时仅允许本机访问消息桥");
  }
}

export type WechatClawBridgeChatBody = {
  text: string;
  userId?: string;
  sessionId?: string;
  weixinSenderId?: string;
  channel?: string;
  accountId?: string;
  messageId?: string;
};

export class WechatClawBridgeService {
  constructor(
    private readonly runtime: RuntimeFacade,
    private readonly deps: {
      weatherPrefsService?: WeatherPrefsService;
      ttsService?: TtsService;
      messageHubService?: MessageHubService;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  isEnabled(): boolean {
    return isWechatClawBridgeEnabled(this.env) && isWechatClawFeatureEnabled(this.env);
  }

  resolveActorId(body: WechatClawBridgeChatBody): string {
    const explicit = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId ?? "",
    });
    if (body.userId?.trim() || body.sessionId?.trim()) {
      return explicit;
    }
    return readWechatClawBridgeConfig(this.env).defaultActorId;
  }

  /** App 绑定文件中的 actorId，与 Flutter USER_ID 对齐。 */
  private async resolveBoundActorId(): Promise<string | null> {
    const path =
      this.env.WECHAT_CLAW_BINDING_FILE?.trim() ||
      join(getDataDir(), "wechat-claw-bindings.json");
    try {
      const raw = await readFile(path, "utf8");
      const data = JSON.parse(raw) as {
        bindings?: Record<string, { actorId?: string }>;
      };
      const bindings = data.bindings ?? {};
      const keys = Object.keys(bindings);
      if (keys.length === 0) return null;
      const first = bindings[keys[0]!];
      const actor = first?.actorId?.trim() || keys[0]!.trim();
      return actor || null;
    } catch {
      return null;
    }
  }

  private async resolveActorIdForTurn(body: WechatClawBridgeChatBody): Promise<string> {
    if (body.userId?.trim() || body.sessionId?.trim()) {
      return this.resolveActorId(body);
    }
    const bound = await this.resolveBoundActorId();
    if (bound) return bound;
    return readWechatClawBridgeConfig(this.env).defaultActorId;
  }

  async handleChat(body: WechatClawBridgeChatBody): Promise<
    | {
        ok: true;
        replyText: string;
        actorId: string;
        messageId: string;
        /** TTS 音频数据（微信语音推送用） */
        ttsAudio?: { format: string; base64: string } | null;
        /** 提醒类型标记（供 OpenClaw 插件决定渲染方式） */
        reminderType?: "popup" | "tts_alarm" | "phone_call" | null;
      }
    | { ok: false; message: string }
  > {
    if (!this.isEnabled()) {
      return { ok: false, message: "微信消息桥未启用（WECHAT_CLAW_BRIDGE_ENABLED=1）" };
    }

    const text = sanitizeWechatInboundText(body.text);
    if (!text) {
      return { ok: false, message: "消息内容为空" };
    }

    const actorId = await this.resolveActorIdForTurn(body);
    await this.deps.messageHubService?.ingestInbound({
      actorId,
      platform: "wechat",
      channelId: body.weixinSenderId?.trim() || body.accountId?.trim() || "wechat-default",
      text,
      participantId: body.weixinSenderId?.trim() || body.accountId?.trim(),
      participantName: body.channel?.trim() || "微信",
      title: body.channel?.trim() ? `微信 · ${body.channel!.trim()}` : "微信",
      senderId: body.weixinSenderId?.trim(),
      senderName: body.channel?.trim() || "微信联系人",
      externalMessageId: body.messageId,
      meta: {
        channel: body.channel,
        accountId: body.accountId,
      },
    });

    if (/^\/new\b/i.test(text) || /^\/reset\b/i.test(text)) {
      await this.resetChatSession(actorId);
      return {
        ok: true,
        actorId,
        messageId: body.messageId ?? `wechat-bridge-${randomUUID()}`,
        replyText: "已开启新对话，与 App 共用同一套记忆与工具。请继续发送你的问题。",
      };
    }

    const accessMode = parseAgentAccessMode(
      this.env.WECHAT_CLAW_BRIDGE_AGENT_ACCESS_MODE?.trim() || "full",
    );
    const turnInput: ChatTurnInput = {
      text,
      messageId: body.messageId,
      userId: body.userId ?? actorId,
      agentAccessMode: accessMode,
      preferFullPipeline: true,
      clientLocation: this.clientLocationForActor(actorId),
    };

    console.log(
      `[wechat-claw-bridge] turn actor=${actorId} textLen=${text.length} access=${accessMode} location=${turnInput.clientLocation?.label ?? "none"}`,
    );

    const result = await runChatTurnForActor(this.runtime, actorId, turnInput);
    if (!result.ok) {
      return { ok: false, message: result.message };
    }

    // ---- 检测是否为提醒类回复，并生成 TTS 音频（用于微信语音推送） ----
    const reminderType = this.detectReminderType(result.finalText);
    let ttsAudio: { format: string; base64: string } | null | undefined;

    if (reminderType && this.deps.ttsService) {
      try {
        const ttsResult = await this.deps.ttsService.synthesizeMp3Base64(result.finalText);
        if (ttsResult.ok) {
          ttsAudio = { format: ttsResult.format, base64: ttsResult.base64 };
        }
      } catch (ttsErr) {
        console.warn("[wechat-claw-bridge] TTS 合成失败，将降级为纯文本:", ttsErr);
        ttsAudio = null;
      }
    }

    return {
      ok: true,
      actorId,
      messageId: result.messageId,
      replyText: result.finalText,
      ttsAudio,
      reminderType,
    };
  }

  /**
   * 检测回复文本是否包含提醒标记，返回对应的提醒类型。
   *
   * 支持两种检测方式：
   * 1. ChatTurnResult 自带 reminderType 字段（Agent 工具调用时主动设置）
   * 2. 文本内容启发式检测（关键词匹配）
   */
  private detectReminderType(text: string): "popup" | "tts_alarm" | "phone_call" | null {
    // 优先使用 runChatTurn 返回的标记（如果有的话）
    // 这里做文本启发式检测作为兜底

    const lower = text.toLowerCase();

    // 电话来电标记
    if (lower.includes("[phone_call]") || lower.includes("📞") || lower.includes("电话提醒")) {
      return "phone_call";
    }

    // TTS 语音闹铃标记
    if (lower.includes("[tts_alarm]") || lower.includes("🔔") || lower.includes("语音提醒") || lower.includes("语音闹钟")) {
      return "tts_alarm";
    }

    // 弹窗提醒标记
    if (lower.includes("[popup_reminder]") || lower.includes("⚠️") || lower.includes("重要提醒")) {
      return "popup";
    }

    return null;
  }

  private clientLocationForActor(actorId: string): ClientLocationWire | undefined {
    const prefs = this.deps.weatherPrefsService?.get(actorId);
    if (!prefs) return undefined;
    return {
      latitude: prefs.latitude,
      longitude: prefs.longitude,
      label: prefs.label,
      timezone: prefs.timezone,
    };
  }

  async resetChatSession(actorId: string): Promise<void> {
    const provider = createExternalChatProviderFromEnv();
    if (!provider?.clearSession) return;
    const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
    const chatSessionId = resolvePrimaryChatSessionId(actorId, masterOn);
    provider.clearSession(chatSessionId);
  }

  /** 供 OpenClaw 插件安装时写入 bridgeToken（与 server .env 对齐）。 */
  bridgeTokenFingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 12);
  }
}
