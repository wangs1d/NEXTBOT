import { resolvePrimaryExternalModelBinding } from "../external-model/resolve-provider.js";

/** 服务端主动读图使用的视觉模型配置（与主对话外部模型对齐）。 */
export type VisionModelWireConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function envStr(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

/** 解析服务端读图使用的视觉模型（优先主服务 binding，兼容 OPENAI_*）。 */
export function resolveVisionModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): VisionModelWireConfig | null {
  const binding = resolvePrimaryExternalModelBinding(env);
  if (binding?.apiKey) {
    const visionModel =
      envStr(env, "VISION_MODEL") ||
      envStr(env, "OPENAI_VISION_MODEL") ||
      (binding.providerId === "moonshot-kimi" ? "moonshot-v1-8k-vision-preview" : binding.model);
    return {
      apiKey: binding.apiKey,
      baseUrl: binding.baseUrl.replace(/\/v1\/?$/, ""),
      model: visionModel,
    };
  }

  const openaiKey = envStr(env, "OPENAI_API_KEY");
  if (openaiKey) {
    const base = envStr(env, "OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/v1\/?$/, "");
    return {
      apiKey: openaiKey,
      baseUrl: base,
      model:
        envStr(env, "VISION_MODEL") ||
        envStr(env, "OPENAI_VISION_MODEL") ||
        envStr(env, "OPENAI_MODEL", "gpt-4o-mini"),
    };
  }

  return null;
}
