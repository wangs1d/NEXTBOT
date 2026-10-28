import type {
  VoiceDialogueProvider,
  AudioBuffer,
  LLMMessage,
} from "./types.js";

export class VoiceDialogueService {
  private providers: Map<string, VoiceDialogueProvider> = new Map();
  private defaultProviderName: string | null = null;

  registerProvider(name: string, provider: VoiceDialogueProvider): void {
    this.providers.set(name, provider);
    if (!this.defaultProviderName) {
      this.defaultProviderName = name;
    }
  }

  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not registered`);
    }
    this.defaultProviderName = name;
  }

  getProvider(name?: string): VoiceDialogueProvider {
    const providerName = name ?? this.defaultProviderName;
    if (!providerName) {
      throw new Error("No voice dialogue provider available");
    }
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    return provider;
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async synthesizeSpeech(
    text: string,
    options?: {
      voiceId?: string;
      speed?: number;
      pitch?: number;
      volume?: number;
      providerName?: string;
    },
  ): Promise<AudioBuffer> {
    const provider = this.getProvider(options?.providerName);
    return provider.tts.synthesize(text, options);
  }

  async chatCompletion(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      providerName?: string;
    },
  ): Promise<string> {
    const provider = this.getProvider(options?.providerName);
    return provider.llm.chat(messages, options);
  }

  async generateAndSpeak(
    text: string,
    options?: {
      voiceId?: string;
      speed?: number;
      volume?: number;
      providerName?: string;
    },
  ): Promise<AudioBuffer> {
    return this.synthesizeSpeech(text, options);
  }
}
