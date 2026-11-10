import { Buffer } from "node:buffer";
import OpenAI from "openai";
import { MiniMaxTTSAdapter } from "./voice-dialogue/adapters/minimax-tts-adapter.js";
import { inspectMp3, type VoiceQualityVerdict } from "./alarm-clock/voice-quality.js";

/**
 * 文本转语音服务：
 * - 优先使用 MiniMax TTS（speech-2.5，中文拟真度最佳，按字符计费）
 * - 其次硅基流动 CosyVoice2（OpenAI 兼容 /audio/speech，中文，按 .env 注释
 *   「优先于 OpenAI TTS」；SILICONFLOW_API_KEY 早就配好了但旧实现没接线，
 *   表现为「闹钟响铃却没有 agent 说话」）
 * - 最后回退 OpenAI TTS
 * - 均未配置时仅返回文本供前端本地播报
 */
export interface TtsQualityReport {
  score: number;
  degraded: boolean;
  warnings: string[];
  metrics: Record<string, number>;
}

function qualityReport(v: VoiceQualityVerdict): TtsQualityReport {
  return { score: v.score, degraded: v.degraded, warnings: v.warnings, metrics: v.metrics };
}

export class TtsService {
  private openai: OpenAI | null = null;
  private minimax: MiniMaxTTSAdapter | null = null;
  private siliconflow: {
    apiKey: string;
    baseUrl: string;
    model: string;
    voice: string;
    sampleRate: 32000 | 44100;
    gain?: number;
  } | null = null;
  private openaiFingerprint = "";
  private minimaxFingerprint = "";
  private siliconflowFingerprint = "";

  /**
   * 按 env 指纹惰性解析客户端：密钥/网关变化时重建（服务接入页保存密钥后
   * PUT /api/service-config 写 env 即热生效，无需重启——与 mutable-chat-provider
   * 的主对话热替换同一时序语义）。
   */
  private resolveClients(): void {
    // OpenAI TTS：可单独指向支持 /audio/speech 的网关。
    // 主对话常把 OPENAI_BASE_URL 配成 DeepSeek/其它 LLM 网关，那些端点没有
    // audio/speech（实测 404），若直接复用会让「MiniMax 失败 → OpenAI 回退」
    // 这条兜底形同虚设。OPENAI_TTS_BASE_URL / OPENAI_TTS_API_KEY 未配置时
    // 保持旧口径，行为不变。
    const apiKey =
      process.env.OPENAI_TTS_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    const baseURL = (
      process.env.OPENAI_TTS_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
    );
    const openaiFp = `${apiKey}@${baseURL}`;
    if (openaiFp !== this.openaiFingerprint) {
      this.openaiFingerprint = openaiFp;
      this.openai = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
    }
    // MiniMax TTS（speech-2.5）
    const minimaxKey = process.env.MINIMAX_API_KEY?.trim() ?? "";
    if (minimaxKey !== this.minimaxFingerprint) {
      this.minimaxFingerprint = minimaxKey;
      this.minimax = new MiniMaxTTSAdapter();
    }
    // 硅基流动 TTS：.env 里 SILICONFLOW_API_KEY / SILICONFLOW_TTS_MODEL 已配置，
    // 但旧实现只读 MiniMax + OpenAI，整条中文语音通道被跳过。voice 需用
    // "<model>:<speaker>" 形式；只给短名时按当前模型补齐前缀。
    //
    // 音色/音质（2026-11-09 用户反馈「声音有点沙哑」后逐音色实测）：
    // anna 峰值仅 0.18（其它音色 0.47~0.96）、静音段底噪最高、频谱质心最低，
    // 为听清而推大音量就把声码器颗粒感全暴露 → 主观发闷发沙。diana 电平健康、
    // 底噪最低、质心最高。再把 mp3 采样率从默认 24kHz 提到 44.1kHz——mp3 端点
    // 只接受 32000/44100（实测 48000 报 20015），24kHz 本身就偏闷。
    const sfKey = process.env.SILICONFLOW_API_KEY?.trim() ?? "";
    const sfBaseUrl = (
      process.env.SILICONFLOW_TTS_BASE_URL?.trim() || "https://api.siliconflow.cn/v1"
    ).replace(/\/+$/, "");
    const sfModel =
      process.env.SILICONFLOW_TTS_MODEL?.trim() || "FunAudioLLM/CosyVoice2-0.5B";
    const sfVoiceRaw = process.env.SILICONFLOW_TTS_VOICE?.trim() || "diana";
    const sfVoice = sfVoiceRaw.includes(":") ? sfVoiceRaw : `${sfModel}:${sfVoiceRaw}`;
    const sfSampleRate: 32000 | 44100 =
      process.env.SILICONFLOW_TTS_SAMPLE_RATE?.trim() === "32000" ? 32000 : 44100;
    const sfGainRaw = process.env.SILICONFLOW_TTS_GAIN?.trim() ?? "";
    const sfGainNum = Number(sfGainRaw);
    const sfGain =
      sfGainRaw && Number.isFinite(sfGainNum)
        ? Math.max(-10, Math.min(10, sfGainNum))
        : undefined;
    const sfFp = `${sfKey}@${sfBaseUrl}@${sfModel}@${sfVoice}@${sfSampleRate}@${sfGain ?? ""}`;
    if (sfFp !== this.siliconflowFingerprint) {
      this.siliconflowFingerprint = sfFp;
      this.siliconflow = sfKey
        ? {
            apiKey: sfKey,
            baseUrl: sfBaseUrl,
            model: sfModel,
            voice: sfVoice,
            sampleRate: sfSampleRate,
            gain: sfGain,
          }
        : null;
    }
  }

  isEnabled(): boolean {
    this.resolveClients();
    return this.minimax?.isEnabled() || this.siliconflow !== null || this.openai !== null;
  }

  /**
   * 获取当前使用的 TTS 提供商名称
   */
  getProvider(): string {
    this.resolveClients();
    if (this.minimax?.isEnabled()) return "minimax";
    if (this.siliconflow) return "siliconflow";
    if (this.openai) return "openai";
    return "none";
  }

  /**
   * 硅基流动 OpenAI 兼容语音端点。走 fetch 而非 OpenAI SDK：SDK 的 voice 被
   * 窄化成固定枚举，而 CosyVoice2 的 voice 是 "<model>:<speaker>" 自定义串。
   * 返回非音频（余额不足/模型下架时会回 JSON）必须显式判错，否则会把错误
   * 文本当 mp3 缓存进 voiceClips，到点播出来是一片静音。
   */
  /**
   * 统一音质门禁：坏音频（错误 JSON / 截断流 / 全零占位 / 时长异常）绝不能
   * 作为「合成成功」落盘，否则叫醒到点只有静音。采样率偏低只告警不拒绝——
   * 网关固定 24kHz 时「音质略差」仍好过「完全没有声音」。
   */
  private guardMp3(buf: Buffer, textLength: number, provider: string): VoiceQualityVerdict {
    const v = inspectMp3(buf, textLength);
    if (!v.ok) throw new Error(`音质门禁拒绝 (${provider}): ${v.reasons.join("; ")}`);
    if (v.degraded) {
      console.warn(`[TtsService] ${provider} 音质告警: ${v.warnings.join("; ")}`);
    }
    return v;
  }

  private async synthesizeWithSiliconFlow(text: string): Promise<Buffer> {
    const cfg = this.siliconflow!;
    const res = await fetch(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        input: text,
        voice: cfg.voice,
        response_format: "mp3",
        sample_rate: cfg.sampleRate,
        ...(cfg.gain !== undefined ? { gain: cfg.gain } : {}),
        stream: false,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`SiliconFlow TTS HTTP ${res.status}: ${detail}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("audio") && !contentType.includes("octet-stream")) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`SiliconFlow TTS 返回非音频 (${contentType}): ${detail}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 128) throw new Error(`SiliconFlow TTS 音频过短 (${buf.length} bytes)`);
    return buf;
  }

  /**
   * 生成为 mp3 的 base64；未配置密钥或失败时 ok=false，语音通话仍可以仅靠 transcript。
   * 优先 MiniMax TTS，失败后回退 OpenAI TTS
   */
  async synthesizeMp3Base64(text: string): Promise<
    | { ok: true; format: "mp3"; base64: string; provider?: string; quality?: TtsQualityReport }
    | { ok: false; reason: string }
  > {
    const result = await this.synthesizeMp3Buffer(text);
    if (!result.ok) return result;
    return {
      ok: true,
      format: "mp3",
      base64: result.buffer.toString("base64"),
      provider: result.provider,
      quality: result.quality,
    };
  }

  /**
   * 生成为 mp3 的 Buffer（用于落地为可重播语音消息文件）。
   * 与 `synthesizeMp3Base64` 同源，但不做 base64 编码，便于直接写盘。
   */
  async synthesizeMp3Buffer(text: string): Promise<
    | { ok: true; format: "mp3"; buffer: Buffer; provider?: string; quality?: TtsQualityReport }
    | { ok: false, reason: string }
  > {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty text" };
    const clipped = trimmed.length > 450 ? `${trimmed.slice(0, 447)}…` : trimmed;
    this.resolveClients();

    // 1. 尝试 MiniMax TTS（speech-2.5，中文拟真度最佳）
    if (this.minimax?.isEnabled()) {
      try {
        const result = await this.minimax.synthesize(clipped);
        const buffer = Buffer.from(result.data);
        const quality = this.guardMp3(buffer, clipped.length, "minimax");
        console.log(`[TtsService] 使用 MiniMax TTS 合成成功 (${buffer.length} bytes)`);
        return { ok: true, format: "mp3", buffer, provider: "minimax", quality: qualityReport(quality) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[TtsService] MiniMax TTS 失败，回退到硅基流动: ${msg}`);
      }
    }

    // 2. 硅基流动 CosyVoice2（中文）——优先于 OpenAI TTS：主对话网关常配成
    // DeepSeek 等 LLM 网关，没有 /audio/speech，OpenAI 回退实测 404；这条是
    // OpenAI 兼容的语音端点，用已配置的 SILICONFLOW_API_KEY 即可出真实中文语音。
    if (this.siliconflow) {
      try {
        const buffer = await this.synthesizeWithSiliconFlow(clipped);
        const quality = this.guardMp3(buffer, clipped.length, "siliconflow");
        console.log(`[TtsService] 使用 SiliconFlow TTS 合成成功 (${buffer.length} bytes, quality=${quality.score})`);
        return { ok: true, format: "mp3", buffer, provider: "siliconflow", quality: qualityReport(quality) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[TtsService] SiliconFlow TTS 失败，回退到 OpenAI: ${msg}`);
      }
    }

    // 3. 最后回退 OpenAI TTS
    if (this.openai) {
      try {
        const res = await this.openai.audio.speech.create({
          model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
          voice: (process.env.OPENAI_TTS_VOICE?.trim() || "alloy") as "alloy",
          input: clipped,
          response_format: "mp3",
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const quality = this.guardMp3(buf, clipped.length, "openai");
        return { ok: true, format: "mp3", buffer: buf, provider: "openai", quality: qualityReport(quality) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `OpenAI TTS 错误: ${msg}` };
      }
    }

    return {
      ok: false,
      reason: "未配置任何可用 TTS 服务（MINIMAX_API_KEY / SILICONFLOW_API_KEY / OPENAI_API_KEY）",
    };
  }
}
