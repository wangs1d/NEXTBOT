import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { registerV1GatewayRoutes, resetV1GatewayRateLimitsForTests } from "../src/routes/http/v1-gateway.js";
import { getWebpayStore } from "../src/services/webpay/webpay-store.js";
import { getApiTokenStore } from "../src/services/recharge/api-token-store.js";

/**
 * /v1 对话网关：鉴权、余额闸、按 usage 扣费、单价未配置 fail-closed。
 * 上游用本机假服务器，不触网、不消耗真实额度。
 */

const EMAIL = "gateway-test@example.com";
const ZERO_EMAIL = "no-balance@example.com";

let workDir: string;
let app: FastifyInstance;
let upstream: Server;
let baseUrl: string;
let upstreamUrl: string;
let token: string;
let callCount = 0;
let lastUpstreamBody: Record<string, unknown> | null = null;

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "v1-gateway-"));
  process.env.WEBPAY_LEDGER_DB = join(workDir, "orders.db");
  process.env.RECHARGE_API_TOKEN_DB = join(workDir, "tokens.db");
  process.env.EXTERNAL_MODEL_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  process.env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK = "1000000";
  process.env.RECHARGE_API_PRICE_OUTPUT_CENTS_PER_MTOK = "1000000";
  process.env.RECHARGE_API_RATE_PER_MIN = "100";

  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      callCount += 1;
      lastUpstreamBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const body = lastUpstreamBody ?? {};
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chunk-1",
            object: "chat.completion.chunk",
            created: 0,
            model: "test-model",
            choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chunk-2",
            object: "chat.completion.chunk",
            created: 0,
            model: "test-model",
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      json(res, 200, {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  upstreamUrl = `http://127.0.0.1:${port}`;
  process.env.OPENAI_BASE_URL = `${upstreamUrl}/v1`;

  const store = getWebpayStore();
  store.createOrder({
    outTradeNo: "TESTORDER1",
    subject: "test",
    totalAmount: "10.00",
    status: "pending",
    tradeNo: null,
    appId: "test",
    env: "sandbox",
    accountId: EMAIL,
    buyerLogonId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paidAt: null,
    refundedAmount: "0.00",
    lastQueryAt: null,
    lastQueryStatus: null,
  });
  store.markPaidIdempotently("TESTORDER1", "T1", null, new Date().toISOString());
  const issued = getApiTokenStore().ensure(EMAIL);
  token = issued.token ?? "";

  app = Fastify();
  registerV1GatewayRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

after(async () => {
  await app?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  getWebpayStore().close();
  getApiTokenStore().close();
  rmSync(workDir, { recursive: true, force: true });
});

function chatRequest(init: { token?: string; body?: Record<string, unknown> }) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify(init.body ?? { model: "test-model", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("v1 chat completions gateway", () => {
  it("rejects missing / invalid credential with 401", async () => {
    const anonymous = await chatRequest({});
    assert.equal(anonymous.status, 401);
    const bad = await chatRequest({ token: "nbk_wrong" });
    assert.equal(bad.status, 401);
  });

  it("rejects unknown model with 404", async () => {
    const res = await chatRequest({ token, body: { model: "other", messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.status, 404);
  });

  it("calls upstream and deducts from balance by usage", async () => {
    const before = getWebpayStore().getBalanceState(EMAIL).balanceCents;
    assert.equal(before, 1000);
    const res = await chatRequest({ token });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(payload.choices[0].message.content, "hello");
    // 10 输入 + 5 输出 token，各 1e6 分/百万 → 15 分
    assert.equal(getWebpayStore().getBalanceState(EMAIL).balanceCents, 985);
    const usage = getWebpayStore().listUsage(EMAIL, 5);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].promptTokens, 10);
    assert.equal(usage[0].completionTokens, 5);
    assert.equal(usage[0].chargedCents, 15);
  });

  it("is idempotent per request id", async () => {
    const result = getWebpayStore().chargeUsage({
      requestId: "fixed-request-id",
      accountId: EMAIL,
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      costMicrocents: 15_000_000,
    });
    const again = getWebpayStore().chargeUsage({
      requestId: "fixed-request-id",
      accountId: EMAIL,
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      costMicrocents: 15_000_000,
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.chargedCents, result.chargedCents);
    assert.equal(getWebpayStore().getBalanceState(EMAIL).balanceCents, 970);
  });

  it("streams SSE and bills once with upstream usage", async () => {
    const before = getWebpayStore().getBalanceState(EMAIL).balanceCents;
    const res = await chatRequest({ token, body: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"hel"/);
    assert.match(text, /\[DONE\]/);
    assert.equal(getWebpayStore().getBalanceState(EMAIL).balanceCents, before - 15);
    assert.equal(lastUpstreamBody?.max_tokens !== undefined, true);
    assert.equal((lastUpstreamBody?.stream_options as { include_usage?: boolean })?.include_usage, true);
  });

  it("fails closed when unit prices are not configured (no upstream call, no charge)", async () => {
    const saved = process.env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK;
    process.env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK = "";
    const calls = callCount;
    const balance = getWebpayStore().getBalanceState(EMAIL).balanceCents;
    const res = await chatRequest({ token });
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: { code: string } }).error.code, "billing_not_configured");
    assert.equal(callCount, calls);
    assert.equal(getWebpayStore().getBalanceState(EMAIL).balanceCents, balance);
    process.env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK = saved;
  });

  it("rejects with 402 when balance is zero", async () => {
    const zeroToken = getApiTokenStore().ensure(ZERO_EMAIL).token ?? "";
    resetV1GatewayRateLimitsForTests();
    const res = await chatRequest({ token: zeroToken });
    assert.equal(res.status, 402);
    assert.equal((await res.json() as { error: { code: string } }).error.code, "insufficient_balance");
  });

  it("lists the configured model", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(payload.data.map((m) => m.id), ["test-model"]);
  });

  it("books sub-cent usage as remainder instead of rounding up", async () => {
    process.env.RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK = "200";
    process.env.RECHARGE_API_PRICE_OUTPUT_CENTS_PER_MTOK = "200";
    const before = getWebpayStore().getBalanceState(EMAIL);
    const res = await chatRequest({ token });
    assert.equal(res.status, 200);
    const afterState = getWebpayStore().getBalanceState(EMAIL);
    // 15 token × 200 分/百万 = 3000 微 + 原有零头；本次不足 1 分，余额不变
    assert.equal(afterState.balanceCents, before.balanceCents);
    assert.equal(afterState.remainderMicro, (before.remainderMicro + 3000) % 1_000_000);
  });
});
