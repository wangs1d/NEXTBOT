import type { ExternalChatProvider } from "./types.js";
import { MoonshotKimiProvider } from "./providers/moonshot-kimi-provider.js";
import { OpenAiOfficialProvider } from "./providers/openai-official-provider.js";
import { MiniMaxProvider } from "./providers/minimax-provider.js";
import { FailoverChatProvider } from "./failover-chat-provider.js";
import { instantiateKnownProvider } from "./instantiate-provider.js";
import { resolveProviderProfile } from "./provider-profiles.js";
import { resolveRegion } from "../config/load-server-env.js";

/** 与 `EXTERNAL_MODEL_PROVIDER` 对齐 */
export type ExternalModelMode = "auto" | "none" | "moonshot-kimi" | "openai" | "minimax" | "failover";

/** 主服务当前生效的外部模型（供 OpenClaw 等下游同步） */
export type PrimaryExternalModelBinding = {
  providerId: "moonshot-kimi" | "openai" | "minimax";
  model: string;
  apiKey: string;
  baseUrl: string;
};

function parseMode(env: NodeJS.ProcessEnv = process.env): ExternalModelMode {
  const raw = (env.EXTERNAL_MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "none" || raw === "off" || raw === "disabled") return "none";
  if (raw === "moonshot-kimi" || raw === "moonshot" || raw === "kimi") return "moonshot-kimi";
  if (raw === "openai") return "openai";
  if (raw === "minimax") return "minimax";
  if (raw === "failover") return "failover";
  console.warn(
    `[external-model] Unknown EXTERNAL_MODEL_PROVIDER="${raw}", falling back to auto.`,
  );
  return "auto";
}

function defaultFailoverChain(env: NodeJS.ProcessEnv = process.env): string {
  return (env.EXTERNAL_MODEL_FAILOVER_CHAIN ?? "moonshot-kimi,openai").trim();
}

function moonshotBinding(env: NodeJS.ProcessEnv): PrimaryExternalModelBinding | null {
  const apiKey = env.MOONSHOT_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    providerId: "moonshot-kimi",
    model: (env.MOONSHOT_MODEL ?? "kimi-k2.5").trim(),
    apiKey,
    baseUrl: (env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1").trim(),
  };
}

function openaiBinding(env: NodeJS.ProcessEnv): PrimaryExternalModelBinding | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    providerId: "openai",
    model: (env.OPENAI_MODEL ?? "gpt-4o-mini").trim(),
    apiKey,
    baseUrl: (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim(),
  };
}

function minimaxBinding(env: NodeJS.ProcessEnv): PrimaryExternalModelBinding | null {
  const apiKey = env.MINIMAX_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    providerId: "minimax",
    model: (env.MINIMAX_MODEL ?? "MiniMax-M3").trim(),
    apiKey,
    baseUrl: (env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim(),
  };
}

function firstEnabledBinding(
  env: NodeJS.ProcessEnv,
  tokens: string[],
): PrimaryExternalModelBinding | null {
  for (const token of tokens) {
    const p = instantiateKnownProvider(token);
    if (!p?.isEnabled()) continue;
    if (p.id === "moonshot-kimi") {
      const b = moonshotBinding(env);
      if (b) return b;
    }
    if (p.id === "openai") {
      const b = openaiBinding(env);
      if (b) return b;
    }
    if (p.id === "minimax") {
      const b = minimaxBinding(env);
      if (b) return b;
    }
  }
  return null;
}

/**
 * 解析主服务当前使用的外部模型（与 {@link createExternalChatProviderFromEnv} 对齐）。
 * failover 取链上第一个已配置密钥的 provider。
 */
export function resolvePrimaryExternalModelBinding(
  env: NodeJS.ProcessEnv = process.env,
): PrimaryExternalModelBinding | null {
  const mode = parseMode(env);
  if (mode === "none") return null;
  if (mode === "moonshot-kimi") return moonshotBinding(env);
  if (mode === "openai") return openaiBinding(env);
  if (mode === "minimax") return minimaxBinding(env);
  if (mode === "failover") {
    const tokens = defaultFailoverChain(env)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return firstEnabledBinding(env, tokens);
  }
  // auto：按 REGION 决定优先级。
  // - domestic（默认）：优先 Kimi，其次 MiniMax、OpenAI（保持向后兼容）
  // - intl：优先 OpenAI，其次 MiniMax、Kimi
  // 显式设置 EXTERNAL_MODEL_PROVIDER 始终优先于本推断。
  const region = resolveRegion(env);
  if (region === "intl") {
    return openaiBinding(env) ?? minimaxBinding(env) ?? moonshotBinding(env);
  }
  return moonshotBinding(env) ?? minimaxBinding(env) ?? openaiBinding(env);
}

/** 供旁路 LLM（滚动摘要 / 记忆联想 / 记忆决策 / 记忆评分等）使用的客户端配置，跟随当前 provider。 */
export type PrimaryLlmClientConfig = {
  apiKey: string;
  baseURL: string;
  /** 当前主模型名；旁路调用方仍可先用自己的环境变量覆盖。 */
  model: string;
};

/**
 * 解析当前生效 provider 的 LLM 客户端配置（与主对话链路同一 provider/模型）。
 * 无任何已配置密钥时返回 null；兼容仅设 `OPENAI_*` 的旧配置。
 */
export function resolvePrimaryLlmClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): PrimaryLlmClientConfig | null {
  const binding = resolvePrimaryExternalModelBinding(env);
  const apiKey = binding?.apiKey?.trim() || env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseURL:
      binding?.baseUrl?.trim() ||
      env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1",
    model: binding?.model?.trim() || env.OPENAI_MODEL?.trim() || "",
  };
}

function defaultFailoverChainLegacy(): string {
  return defaultFailoverChain(process.env);
}

/**
 * 旁路直答 LLM（滚动摘要 / 记忆决策 / 画像聚合等走裸 OpenAI SDK 的调用）的请求附加参数。
 *
 * 2026-10-07 起委托 {@link resolveProviderProfile} 能力档案表统一判定（根修：
 * 模型思考特性声明收敛到一张表，换模型只改档案，所有旁路调用点自适应）：
 * - MiniMax M 系默认强制思考，且思考计入 max_tokens 预算：旁路调用多为小 max_tokens
 *   的结构化输出，不关思考会导致 `<think>` 混入 content 或正文被思考饿死。M3 支持
 *   `thinking: {"type": "disabled"}`（实测 reasoning_tokens=0）；M2.x 会 accept 但仍思考；
 *   M3.1 系（M3.1-Flash）硬拒 disabled（400/2013），改发 `reasoning: {effort:"minimal"}`
 *   （判定统一在 provider-profiles.minimaxThinkingExtras，provider 路径同源）。
 * - openai 槽位托管 DeepSeek deepseek-flash 时默认带思考链（实测简单任务多
 *   200+ reasoning_tokens），必须显式关闭，否则记忆精排等 800ms 级超时热路径全部拖爆。
 * - moonshot-kimi k2.5+ 默认开思考——与 MoonshotKimiProvider 对每次调用的默认
 *   （thinking:disabled）对齐，旁路直连不再漏声明。
 * 其余 provider 返回空对象，保持零侵入。
 */
export function bypassChatRequestExtras(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const binding = resolvePrimaryExternalModelBinding(env);
  const model = (binding?.model ?? env.OPENAI_MODEL ?? "").toLowerCase();
  // 无 binding（未配任何密钥）时按 openai 槽位解释 OPENAI_MODEL，保留旧判定语义。
  const profile = resolveProviderProfile(binding?.providerId ?? "openai");
  return profile.bypassRequestExtras(model);
}

/**
 * 按 `EXTERNAL_MODEL_PROVIDER` 与各厂商密钥解析唯一的外部聊天实现。
 *
 * - `auto`（默认）：优先 `MOONSHOT_API_KEY`（Kimi），其次 `MINIMAX_API_KEY`，否则 `OPENAI_API_KEY`。
 * - `none`：不启用外部模型。
 * - `moonshot-kimi`：仅 Kimi；缺密钥则 null 并警告。
 * - `openai`：仅 OpenAI；缺密钥则 null 并警告。
 * - `minimax`：仅 MiniMax；缺密钥则 null 并警告。
 * - `failover`：按 `EXTERNAL_MODEL_FAILOVER_CHAIN`（默认 `moonshot-kimi,openai`）顺序尝试，链上至少一个已配置密钥才启用。
 */
export function createExternalChatProviderFromEnv(): ExternalChatProvider | null {
  const mode = parseMode();
  if (mode === "none") return null;

  const moonshot = new MoonshotKimiProvider();
  const openai = new OpenAiOfficialProvider();
  const minimax = new MiniMaxProvider();

  if (mode === "moonshot-kimi") {
    if (moonshot.isEnabled()) return moonshot;
    console.warn(
      "[external-model] EXTERNAL_MODEL_PROVIDER=moonshot-kimi but MOONSHOT_API_KEY is not set.",
    );
    return null;
  }

  if (mode === "openai") {
    if (openai.isEnabled()) return openai;
    console.warn(
      "[external-model] EXTERNAL_MODEL_PROVIDER=openai but OPENAI_API_KEY is not set.",
    );
    return null;
  }

  if (mode === "minimax") {
    if (minimax.isEnabled()) return minimax;
    console.warn(
      "[external-model] EXTERNAL_MODEL_PROVIDER=minimax but MINIMAX_API_KEY is not set.",
    );
    return null;
  }

  if (mode === "failover") {
    const chainStr = defaultFailoverChainLegacy();
    const tokens = chainStr.split(",").map((s) => s.trim()).filter(Boolean);
    const chain: ExternalChatProvider[] = [];
    for (const token of tokens) {
      const p = instantiateKnownProvider(token);
      if (!p) {
        console.warn(`[external-model] Unknown provider in failover chain: "${token}", skipped.`);
        continue;
      }
      chain.push(p);
    }
    if (chain.length === 0) {
      console.warn("[external-model] failover chain is empty after parsing.");
      return null;
    }
    const fb = new FailoverChatProvider(chain);
    if (!fb.isEnabled()) {
      console.warn(
        "[external-model] EXTERNAL_MODEL_PROVIDER=failover but no provider in chain has credentials.",
      );
      return null;
    }
    return fb;
  }

  // auto：按 REGION 决定优先级。
  // - domestic（默认）：优先 Kimi，其次 MiniMax、OpenAI（保持向后兼容）
  // - intl：优先 OpenAI，其次 MiniMax、Kimi
  const region = resolveRegion();
  if (region === "intl") {
    if (openai.isEnabled()) return openai;
    if (minimax.isEnabled()) return minimax;
    if (moonshot.isEnabled()) return moonshot;
  } else {
    if (moonshot.isEnabled()) return moonshot;
    if (minimax.isEnabled()) return minimax;
    if (openai.isEnabled()) return openai;
  }
  return null;
}
