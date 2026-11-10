import { resolvePrimaryLlmClientConfig } from "../../external-model/resolve-provider.js";

/**
 * /v1 对话网关的计费口径。
 *
 * 单价按「分 / 百万 token」配置（整数，环境变量给真数），请求成本用
 * 微分为单位累加：price_cents_per_M × tokens == 微分数，
 * 不足 1 分的零头留在账户的 billing_remainder_micro 里滚存，
 * 既不四舍五入多收，也不会因单次调用太小而永远收不到。
 *
 * 未配置单价时网关 fail-closed（503 billing_not_configured），绝不按默认价扣费。
 */

export type ApiPriceConfig = {
  /** 输入 token 单价：分 / 百万 token */
  inputCentsPerMTok: number;
  /** 输出 token 单价：分 / 百万 token */
  outputCentsPerMTok: number;
};

export type ApiGatewayConfig = {
  /** 上游（运营方）模型通道；与主对话同一 provider/model */
  apiKey: string;
  baseURL: string;
  model: string;
  prices: ApiPriceConfig | null;
  defaultMaxTokens: number;
  maxTokensCap: number;
  ratePerMin: number;
  upstreamTimeoutMs: number;
};

const MICRO_PER_CENT = 1_000_000;

function readInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 单价未配置/非法时返回 null —— 调用方据此拒绝扣费调用。 */
export function readApiPrices(env: NodeJS.ProcessEnv = process.env): ApiPriceConfig | null {
  const rawIn = (env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK ?? "").trim();
  const rawOut = (env.RECHARGE_API_PRICE_OUTPUT_CENTS_PER_MTOK ?? "").trim();
  if (!rawIn || !rawOut) return null;
  const inputCentsPerMTok = Number.parseInt(rawIn, 10);
  const outputCentsPerMTok = Number.parseInt(rawOut, 10);
  if (!Number.isFinite(inputCentsPerMTok) || !Number.isFinite(outputCentsPerMTok)) return null;
  if (inputCentsPerMTok < 0 || outputCentsPerMTok < 0) return null;
  return { inputCentsPerMTok, outputCentsPerMTok };
}

export function resolveApiGatewayConfig(env: NodeJS.ProcessEnv = process.env): ApiGatewayConfig {
  const client = resolvePrimaryLlmClientConfig(env);
  return {
    apiKey: client?.apiKey ?? "",
    baseURL: client?.baseURL ?? "",
    model: client?.model ?? "",
    prices: readApiPrices(env),
    defaultMaxTokens: Math.max(1, readInt(env.RECHARGE_API_DEFAULT_MAX_TOKENS, 1024)),
    maxTokensCap: Math.max(1, readInt(env.RECHARGE_API_MAX_TOKENS, 4096)),
    ratePerMin: Math.max(1, readInt(env.RECHARGE_API_RATE_PER_MIN, 60)),
    upstreamTimeoutMs: Math.max(1000, readInt(env.RECHARGE_API_UPSTREAM_TIMEOUT_MS, 120_000)),
  };
}

/** 单次调用成本（微分为单位，等于 单价(分/M) × tokens）。 */
export function costMicrocents(prices: ApiPriceConfig, promptTokens: number, completionTokens: number): number {
  const p = Math.max(0, Math.trunc(promptTokens));
  const c = Math.max(0, Math.trunc(completionTokens));
  return prices.inputCentsPerMTok * p + prices.outputCentsPerMTok * c;
}

/**
 * 输入 token 预估（只用于调用前的额度上限，不用于最终扣费）。
 * 中文按 1 字符 ≈ 1 token 的高估口径，宁可少放行 completion 额度。
 */
export function estimatePromptTokens(messages: unknown): number {
  let chars = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const msg = m as { content?: unknown; role?: unknown };
    chars += String(msg.role ?? "").length;
    const content = msg.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === "string") chars += text.length;
      }
    }
  }
  return Math.ceil(chars / 1.5) + list.length * 8;
}

/**
 * 余额能撑住的 completion 上限（tokens）；余额连预估输入都不够时返回 0。
 * 上游不知情时按请求的 max_tokens 与硬上限取小。
 */
export function affordableCompletionTokens(opts: {
  prices: ApiPriceConfig;
  availableMicrocents: number;
  promptTokens: number;
  requestedMaxTokens: number;
  maxTokensCap: number;
}): number {
  const { prices, availableMicrocents, promptTokens, requestedMaxTokens, maxTokensCap } = opts;
  const inputCost = prices.inputCentsPerMTok * Math.max(0, promptTokens);
  const remaining = availableMicrocents - inputCost;
  if (remaining <= 0) return 0;
  const byBalance =
    prices.outputCentsPerMTok > 0
      ? Math.floor(remaining / prices.outputCentsPerMTok)
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(requestedMaxTokens, maxTokensCap, byBalance));
}

export function microcentsToCents(microcents: number): number {
  return Math.floor(microcents / MICRO_PER_CENT);
}
