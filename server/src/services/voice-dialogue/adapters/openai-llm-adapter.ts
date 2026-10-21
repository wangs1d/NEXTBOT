import OpenAI from "openai";
import type { LLMProvider, LLMMessage } from "../types.js";
import { auditChatCompletion } from "../../llm-token-audit.js";

export class OpenAILLMAdapter implements LLMProvider {
  name = "openai-llm";

  private client: OpenAI | null;

  private readonly apiKey?: string;

  private readonly baseURL: string;

  constructor(apiKey?: string, baseURL?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY?.trim();
    this.baseURL = baseURL ?? process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1";

    // 构造期不校验 key（2026-10-21 修）：本适配器在 bootstrap 的同步装配路径上
    // new 出来（create-app-services 注册 voiceDialogue provider）。byok 捆绑形态
    // 下用户首次启动还没配过 key，此时 throw 会变成 uncaughtException，整个服务
    // 进程 abort（退出码 134），3000 端口从未监听 —— 客户端表现为「界面能开但
    // 本地后端永远拉不起来」，而配过 key 的开发机一切正常，极难复现。
    // 改为调用期校验：缺 key 时服务照常起、照常监听，用户在设置里配完 key
    // 重启 runtime 即恢复；真正发起语音对话时才报错，错误语义不变。
    this.client = this.apiKey
      ? new OpenAI({
          apiKey: this.apiKey,
          baseURL: this.baseURL,
        })
      : null;
  }

  /** 是否已完成配置（未配置时调用会抛错）。 */
  isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new Error("OpenAI API key is required");
    }
    return this.client;
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    },
  ): Promise<string> {
    const finalMessages: LLMMessage[] = [];

    if (options?.systemPrompt) {
      finalMessages.push({
        role: "system",
        content: options.systemPrompt,
      });
    }

    finalMessages.push(...messages);

    const client = this.requireClient();

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
      messages: finalMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
    });
    auditChatCompletion({
      stage: "voice_llm",
      messages: finalMessages,
      completion: response,
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
    });

    return response.choices[0]?.message?.content ?? "";
  }

  /** 流式补全（全双工语音用：边生成边吐 token，驱动分句 TTS）。 */
  async chatStream(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      onToken?: (token: string) => void;
    },
  ): Promise<string> {
    const finalMessages: LLMMessage[] = [];
    if (options?.systemPrompt) {
      finalMessages.push({ role: "system", content: options.systemPrompt });
    }
    finalMessages.push(...messages);

    const client = this.requireClient();

    const stream = await client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
      messages: finalMessages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
      stream: true,
    });

    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) continue;
      full += delta;
      options?.onToken?.(delta);
    }
    auditChatCompletion({
      stage: "voice_llm",
      messages: finalMessages,
      completion: full,
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
    });
    return full;
  }
}
