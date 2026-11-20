import { resolvePrimaryExternalModelBinding } from "../external-model/resolve-provider.js";

/** 下发给电脑端 desktop_visual 子进程的 VLM 配置（与主对话外部模型对齐）。 */
export type DesktopVisualVlmWireConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function envStr(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

/**
 * 解析桌面纯视觉循环使用的 VLM（优先 MOONSHOT / 主服务 binding，兼容 OPENAI_*）。
 * 供 bridge.invoke 随任务下发，避免 Flutter 子进程未继承 server/.env.local 密钥。
 */
export function resolveDesktopVisualVlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): DesktopVisualVlmWireConfig | null {
  const binding = resolvePrimaryExternalModelBinding(env);
  if (binding?.apiKey) {
    const visionModel =
      envStr(env, "DESKTOP_VISUAL_VLM_MODEL") ||
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
        envStr(env, "DESKTOP_VISUAL_VLM_MODEL") ||
        envStr(env, "OPENAI_VISION_MODEL") ||
        envStr(env, "OPENAI_MODEL", "gpt-4o-mini"),
    };
  }

  return null;
}
