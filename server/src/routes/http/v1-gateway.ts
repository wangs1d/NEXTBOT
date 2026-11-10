import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import OpenAI from "openai";

import {
  affordableCompletionTokens,
  costMicrocents,
  estimatePromptTokens,
  resolveApiGatewayConfig,
} from "../../services/recharge/api-billing.js";
import { getApiTokenStore } from "../../services/recharge/api-token-store.js";
import {
  getSiteSessionStore,
  hashSiteSessionToken,
  readSiteSessionToken,
} from "../../services/recharge/site-session-store.js";
import { getWebpayStore } from "../../services/webpay/webpay-store.js";

/**
 * /v1 对话网关（OpenAI 兼容）：账户余额按 token 扣减后才调用上游。
 *
 * - GET  /v1/models            已配置的模型清单
 * - POST /v1/chat/completions  非流式 / 流式（SSE）
 *
 * 鉴权：Authorization: Bearer <调用凭据>（登录时自动签发，可在充值页换发）；
 * 同站页面也可直接带 nb_site_session Cookie。两种凭证最终都落到同一个邮箱账号。
 *
 * 计费：调用前按余额封顶 max_tokens（余额不足直接 402，不透支），
 * 调用后按上游回报的 usage 扣费；未配置单价时 503 且不扣费、不调用。
 * 单价、模型通道全部来自运营方配置，用户侧没有可调参数。
 */

const RATE_WINDOW_MS = 60_000;
const rateWindows = new Map<string, number[]>();

/** 仅供测试：清空限流窗口。 */
export function resetV1GatewayRateLimitsForTests(): void {
  rateWindows.clear();
}

function consumeRate(accountId: string, ratePerMin: number): boolean {
  const now = Date.now();
  const window = (rateWindows.get(accountId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (window.length >= ratePerMin) {
    rateWindows.set(accountId, window);
    return false;
  }
  window.push(now);
  rateWindows.set(accountId, window);
  if (rateWindows.size > 10_000) rateWindows.clear();
  return true;
}

function bearerToken(req: FastifyRequest): string {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  return match ? match[1].trim() : "";
}

/** 凭据或同站 Cookie 解析出账号邮箱；都不合法返回 null。 */
export function resolveGatewayAccount(req: FastifyRequest): string | null {
  const token = bearerToken(req);
  if (token) {
    const byApiToken = getApiTokenStore().resolve(token);
    if (byApiToken) return byApiToken;
    const bySession = getSiteSessionStore().resolve(hashSiteSessionToken(token));
    if (bySession) return bySession;
  }
  const cookieToken = readSiteSessionToken(req.headers.cookie);
  if (cookieToken) return getSiteSessionStore().resolve(hashSiteSessionToken(cookieToken));
  return null;
}

function openAiError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
): FastifyReply {
  return reply.code(status).type("application/json; charset=utf-8").send({ error: { message, type, code } });
}

type ChatBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  n?: unknown;
  [key: string]: unknown;
};

/** 透传给上游的采样参数白名单（其余字段一律丢弃，防止客户端改计费相关语义）。 */
const PASSTHROUGH_KEYS = [
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
] as const;

function pickPassthrough(body: ChatBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

function textOfCompletion(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: unknown })?.text)
      .filter((t): t is string => typeof t === "string")
      .join("");
  }
  return "";
}

export function registerV1GatewayRoutes(app: FastifyInstance): void {
  app.get("/v1/models", async (req, reply) => {
    const account = resolveGatewayAccount(req);
    if (!account) return openAiError(reply, 401, "Missing or invalid credential", "invalid_api_key");
    const cfg = resolveApiGatewayConfig();
    if (!cfg.model) return openAiError(reply, 503, "Model channel is not configured", "model_not_configured", "api_error");
    return {
      object: "list",
      data: [{ id: cfg.model, object: "model", created: 0, owned_by: "nextbot" }],
    };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const account = resolveGatewayAccount(req);
    if (!account) return openAiError(reply, 401, "Missing or invalid credential", "invalid_api_key");

    const cfg = resolveApiGatewayConfig();
    if (!cfg.apiKey || !cfg.model) {
      return openAiError(reply, 503, "Model channel is not configured", "model_not_configured", "api_error");
    }
    if (!cfg.prices) {
      return openAiError(reply, 503, "Billing is not configured", "billing_not_configured", "api_error");
    }

    const body = (req.body ?? {}) as ChatBody;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openAiError(reply, 400, "messages must be a non-empty array", "invalid_messages");
    }
    if (body.model !== undefined && String(body.model) !== cfg.model) {
      return openAiError(reply, 404, `Model ${String(body.model)} not found`, "model_not_found");
    }
    if (body.n !== undefined && Number(body.n) !== 1) {
      return openAiError(reply, 400, "n is limited to 1", "invalid_n");
    }

    if (!consumeRate(account, cfg.ratePerMin)) {
      return openAiError(reply, 429, "Rate limit exceeded, retry later", "rate_limited", "rate_limit_error");
    }

    const store = getWebpayStore();
    const balance = store.getBalanceState(account);
    const available = balance.balanceCents * 1_000_000 + balance.remainderMicro;
    if (balance.balanceCents <= 0) {
      return openAiError(reply, 402, "Insufficient balance, please recharge", "insufficient_balance", "insufficient_quota");
    }

    const promptEstimate = estimatePromptTokens(body.messages);
    const requestedMaxTokens = Math.max(
      1,
      Math.trunc(Number(body.max_tokens ?? body.max_completion_tokens ?? cfg.defaultMaxTokens)) || cfg.defaultMaxTokens,
    );
    const maxTokens = affordableCompletionTokens({
      prices: cfg.prices,
      availableMicrocents: available,
      promptTokens: promptEstimate,
      requestedMaxTokens,
      maxTokensCap: cfg.maxTokensCap,
    });
    if (maxTokens <= 0) {
      return openAiError(reply, 402, "Insufficient balance for this request", "insufficient_balance", "insufficient_quota");
    }

    const requestId = randomUUID();
    const stream = body.stream === true;
    const upstreamRequest = {
      model: cfg.model,
      messages: body.messages as never,
      max_tokens: maxTokens,
      ...pickPassthrough(body),
    } as Record<string, unknown>;

    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      maxRetries: 0,
      timeout: stream ? Math.max(cfg.upstreamTimeoutMs, 60_000) * 2 : cfg.upstreamTimeoutMs,
    });

    const bill = (promptTokens: number, completionTokens: number, estimated: boolean) => {
      const cost = costMicrocents(cfg.prices!, promptTokens, completionTokens);
      const result = store.chargeUsage({
        requestId,
        accountId: account,
        model: cfg.model,
        promptTokens,
        completionTokens,
        costMicrocents: cost,
      });
      console.log(
        `[v1] billed account=${account} req=${requestId} tokens=${promptTokens}+${completionTokens}` +
          `${estimated ? "(estimated)" : ""} cost_micro=${cost} charged_cents=${result.chargedCents} balance_cents=${result.balanceCents}`,
      );
    };

    if (!stream) {
      try {
        const completion = await client.chat.completions.create(upstreamRequest as never);
        const usage = completion.usage;
        if (usage) {
          bill(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, false);
        } else {
          const text = textOfCompletion(completion.choices?.[0]?.message?.content);
          bill(promptEstimate, Math.ceil(text.length / 1.5), true);
        }
        return completion;
      } catch (err) {
        return upstreamError(reply, err);
      }
    }

    // ── 流式：先发 SSE 头，再逐块透传；usage 取自上游末块 ──
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let disconnected = false;
    raw.on("close", () => {
      disconnected = true;
    });

    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let relayed = "";
    try {
      const streamIter = await client.chat.completions.create({
        ...(upstreamRequest as Record<string, unknown>),
        stream: true,
        stream_options: { include_usage: true },
      } as never);
      for await (const chunk of streamIter as unknown as AsyncIterable<Record<string, unknown>>) {
        if (chunk.usage) usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number };
        const choices = chunk.choices as Array<{ delta?: { content?: unknown } }> | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (typeof delta === "string") relayed += delta;
        if (!disconnected) raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (disconnected) break;
      }
      if (!disconnected) raw.write("data: [DONE]\n\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[v1] stream failed req=${requestId}: ${message}`);
      if (!disconnected) {
        raw.write(`data: ${JSON.stringify({ error: { message: "Upstream stream failed", type: "api_error", code: "upstream_error" } })}\n\n`);
      }
    } finally {
      try {
        if (usage) {
          bill(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, false);
        } else {
          bill(promptEstimate, Math.ceil(relayed.length / 1.5), true);
        }
      } catch (err) {
        console.error(`[v1] billing failed req=${requestId}:`, err instanceof Error ? err.message : err);
      }
      if (!disconnected) raw.end();
    }
  });
}

function upstreamError(reply: FastifyReply, err: unknown): FastifyReply {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[v1] upstream error status=${String(status)} ${message}`);
  if (status === 429) return openAiError(reply, 429, "Upstream rate limited, retry later", "rate_limited", "rate_limit_error");
  if (status === 400) return openAiError(reply, 400, "Upstream rejected the request", "upstream_bad_request");
  if (status === 401 || status === 403) {
    return openAiError(reply, 502, "Upstream credentials are invalid", "upstream_auth_error", "api_error");
  }
  if (typeof status === "number" && status >= 500) {
    return openAiError(reply, 502, "Upstream unavailable", "upstream_error", "api_error");
  }
  return openAiError(reply, 502, "Upstream request failed", "upstream_error", "api_error");
}
