import { resolveActorId } from "../agent/actor-id.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/** 单条语音气泡的目标时长（按中文语速约 12~20 秒）与硬上限。 */
const VOICE_SEGMENT_TARGET_CHARS = 60;
const VOICE_SEGMENT_MAX_CHARS = 110;
/** 长文最多拆成多少条语音气泡，避免一次刷出十几条。 */
const VOICE_SEGMENT_MAX_COUNT = 12;

/**
 * 语音条分泡口径（2026-11-23 用户裁决）：
 * 一条语音不允许吞下整段回复，长内容要按「正常分泡」拆成多条可重播语音。
 *
 * 切法：先按换行/句末标点（。！？；…）切句，再把相邻短句合并到 ~60 字；
 * 单句超过 110 字时优先在逗号/顿号等自然停顿处硬切；超过 12 段时按顺序
 * 分组并回，保证气泡数量可控且顺序不变。
 */
export function splitVoiceMessageText(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  for (const paragraph of normalized.split(/\n+/)) {
    const line = paragraph.trim();
    if (!line) continue;
    const parts = line.match(
      /[^。！？!?；;…]+[。！？!?；;…]+[”"’'」』）)]*|[^。！？!?；;…]+$/gu,
    );
    if (parts) sentences.push(...parts.map((part) => part.trim()).filter(Boolean));
  }

  const segments: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      segments.push(current);
      current = "";
    }
  };
  for (const sentence of sentences) {
    for (const piece of hardSplitSentence(sentence, VOICE_SEGMENT_MAX_CHARS)) {
      if (!current) {
        current = piece;
      } else if (current.length + piece.length <= VOICE_SEGMENT_TARGET_CHARS) {
        current += piece;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();

  if (segments.length <= VOICE_SEGMENT_MAX_COUNT) return segments;
  const groupSize = Math.ceil(segments.length / VOICE_SEGMENT_MAX_COUNT);
  const capped: string[] = [];
  for (let i = 0; i < segments.length; i += groupSize) {
    capped.push(segments.slice(i, i + groupSize).join(""));
  }
  return capped;
}

function hardSplitSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (const mark of ["，", "、", "：", ",", "；", " "]) {
      const index = window.lastIndexOf(mark);
      if (index > cut) cut = index;
    }
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

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

    // 语音条也走「分泡」：长内容拆成多条短语音，每条独立合成、可单独重播。
    // 串行合成保证气泡落屏顺序与原文一致（并行会按完成先后乱序推送）。
    const segments = splitVoiceMessageText(text);
    const sent: Array<{
      messageId: string;
      mediaUrl: string;
      durationMs: number;
      pushed: boolean;
      provider?: string;
    }> = [];
    let firstError: string | undefined;
    for (const segment of segments) {
      const result = await voiceCapability.sendMessage({
        toUserId: actorId,
        text: segment,
        traceId: context.chatUserMessageId ?? context.sessionId,
      });
      if (result.ok) {
        sent.push({
          messageId: result.messageId,
          mediaUrl: result.mediaUrl,
          durationMs: result.durationMs,
          pushed: result.pushed,
          provider: result.provider,
        });
      } else {
        firstError ??= result.error;
      }
    }

    if (sent.length === 0) {
      return {
        ok: false,
        error: firstError ?? "语音消息发送失败",
        retryable: true,
      };
    }

    const durationMs = sent.reduce((sum, item) => sum + item.durationMs, 0);
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    const provider = sent.find((item) => item.provider)?.provider;
    const providerHint = provider ? `（TTS：${provider}）` : "";
    const pushed = sent.every((item) => item.pushed);
    const splitHint =
      sent.length > 1 ? `长内容已按正常分泡拆成 ${sent.length} 条短语音` : "";

    // 回执只给模型看，不给用户看。明确禁止在正文复述语音内容或秒数：
    // 此前 summary 带「已发送语音消息（N"）...」，模型把它复述成
    // 「语音发过去了大哥，五十四秒」——而 N 来自错的码率估算，用户看到编的数字。
    return {
      ok: true,
      messageId: sent[0].messageId,
      messageIds: sent.map((item) => item.messageId),
      segmentCount: sent.length,
      mediaUrl: sent[0].mediaUrl,
      durationMs,
      durationSeconds: seconds,
      pushed,
      summary: pushed
        ? `语音消息已作为可重播语音气泡落入对话流${providerHint}${splitHint ? `，${splitHint}` : ""}。禁止在正文复述这条语音的内容或时长，也不要用「发过去了/已送达」之类措辞——用户能直接看到气泡，任何复述都是编造。调用完只需自然接下一句。`
        : `语音消息已生成，但当前连接不可达${providerHint}。不要声称送达；如确需说明，只说「稍后重连可收听」，不要编造时长。`,
    };
  });
}
