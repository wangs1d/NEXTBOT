import type { ExternalChatProvider } from "./types.js";
import { MoonshotKimiProvider } from "./providers/moonshot-kimi-provider.js";
import { OpenAiOfficialProvider } from "./providers/openai-official-provider.js";
import { MiniMaxProvider } from "./providers/minimax-provider.js";
import { DeepSeekProvider } from "./providers/deepseek-provider.js";

/** 在 failover 链等场景使用的已知 id（与各类的 `id` 字段一致，并含别名）。 */
export function instantiateKnownProvider(token: string): ExternalChatProvider | null {
  const n = token.trim().toLowerCase();
  if (n === "moonshot-kimi" || n === "moonshot" || n === "kimi") {
    return new MoonshotKimiProvider();
  }
  if (n === "openai") {
    return new OpenAiOfficialProvider();
  }
  if (n === "minimax") {
    return new MiniMaxProvider();
  }
  if (n === "deepseek" || n === "ds") {
    return new DeepSeekProvider();
  }
  return null;
}
