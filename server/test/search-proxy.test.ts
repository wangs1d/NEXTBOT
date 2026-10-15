/**
 * 云端搜索代理契约测试（2026-10-15）。
 *
 * 覆盖：env 闸控（未启用不挂载）、上游转发（Bearer key + 自定义端点）、
 * query 缓存（同 body 只打一次上游）、按 IP 滑动窗口限流、sub-domains 透传。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  registerSearchProxyRoutes,
  resetSearchProxyStateForTests,
} from "../src/routes/http/search-proxy.js";

const originalFetch = globalThis.fetch;

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const PROXY_ENV_KEYS = [
  "ANYSEARCH_PROXY_ENABLED",
  "ANYSEARCH_PROXY_UPSTREAM_KEY",
  "ANYSEARCH_PROXY_UPSTREAM_ENDPOINT",
  "ANYSEARCH_PROXY_ACCESS_TOKEN",
  "ANYSEARCH_PROXY_RATE_PER_MIN",
  "ANYSEARCH_PROXY_CACHE_TTL_MS",
] as const;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of PROXY_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of PROXY_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function enableProxy(extra: Record<string, string> = {}): void {
  process.env.ANYSEARCH_PROXY_ENABLED = "1";
  process.env.ANYSEARCH_PROXY_UPSTREAM_KEY = "as_sk_proxy_test";
  process.env.ANYSEARCH_PROXY_UPSTREAM_ENDPOINT = "https://upstream.example.com";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerSearchProxyRoutes(app);
  return app;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSearchProxyStateForTests();
});

test("未启用时（缺开关或缺 key）不挂载任何路由", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  delete process.env.ANYSEARCH_PROXY_ENABLED;
  delete process.env.ANYSEARCH_PROXY_UPSTREAM_KEY;
  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
  assert.equal(res.statusCode, 404, "缺开关时不挂载");
});

test("启用但缺上游 key 时不挂载", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.ANYSEARCH_PROXY_ENABLED = "1";
  delete process.env.ANYSEARCH_PROXY_UPSTREAM_KEY;
  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
  assert.equal(res.statusCode, 404, "缺 key 时不挂载");
});

test("启用后转发上游：Bearer key + 自定义端点 + body 原样透传", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  let calledUrl = "";
  let calledAuth = "";
  let calledBody = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(input);
    calledAuth = String(init?.headers && (init.headers as Record<string, string>).authorization);
    calledBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ code: 0, data: { results: [{ title: "t", url: "https://a.example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "测试搜索", max_results: 3 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { code: 0, data: { results: [{ title: "t", url: "https://a.example" }] } });
  assert.equal(calledUrl, "https://upstream.example.com/v1/search");
  assert.equal(calledAuth, "Bearer as_sk_proxy_test");
  assert.equal(calledBody, JSON.stringify({ query: "测试搜索", max_results: 3 }));
});

test("query 缓存：相同 body 第二次命中缓存不再打上游", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy();
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ code: 0, data: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const payload = { query: "同一查询", max_results: 5 };
  const r1 = await app.inject({ method: "POST", url: "/v1/search", payload });
  const r2 = await app.inject({ method: "POST", url: "/v1/search", payload });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(upstreamCalls, 1, "第二次应命中缓存");
});

test("按 IP 滑动窗口限流：超限 429 且不打上游", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_RATE_PER_MIN: "2", ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ code: 0, data: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const headers = { "x-forwarded-for": "1.2.3.4" };
  const r1 = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "a" }, headers });
  const r2 = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "b" }, headers });
  const r3 = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "c" }, headers });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429);
  assert.equal(r3.json().code, -1);
  assert.equal(upstreamCalls, 2, "超限请求不应打上游");
});

test("sub-domains 透传：GET 查询串原样带 Bearer key 转发", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  let calledUrl = "";
  let calledAuth = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(input);
    calledAuth = String(init?.headers && (init.headers as Record<string, string>).authorization);
    return new Response(JSON.stringify({ code: -1, message: "Capabilities temporarily unavailable." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/v1/sub-domains?domain=image" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().code, -1);
  assert.equal(calledUrl, "https://upstream.example.com/v1/sub-domains?domain=image");
  assert.equal(calledAuth, "Bearer as_sk_proxy_test");
});

test("上游不可达时 502，客户端按契约降级", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;

  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, -1);
});

// ── 反爬取/反探测（2026-10-15）──────────────────────────────────────────────

test("访问令牌：无令牌/错令牌 403 且不打上游，正确令牌放行", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_ACCESS_TOKEN: "nbsrch_secret", ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const noToken = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
  assert.equal(noToken.statusCode, 403, "无令牌 403");
  const badToken = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" }, headers: { authorization: "Bearer wrong" } });
  assert.equal(badToken.statusCode, 403, "错令牌 403");
  const goodToken = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" }, headers: { authorization: "Bearer nbsrch_secret" } });
  assert.equal(goodToken.statusCode, 200, "正确令牌放行");
  assert.equal(upstreamCalls, 1, "403 不应打上游");
  // sub-domains 同样受令牌保护
  const sub = await app.inject({ method: "GET", url: "/v1/sub-domains?domain=image" });
  assert.equal(sub.statusCode, 403, "sub-domains 无令牌 403");
});

test("令牌/形态不过关不消耗限流窗口：403 数次后合法请求仍放行", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_ACCESS_TOKEN: "nbsrch_secret", ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  const app = buildApp();
  const headers = { "x-forwarded-for": "5.6.7.8" };
  for (let i = 0; i < 5; i++) {
    await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" }, headers });
  }
  const legal = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" }, headers: { ...headers, authorization: "Bearer nbsrch_secret" } });
  assert.equal(legal.statusCode, 200, "403 不应挤占限流窗口");
});

test("形态校验：缺 query / 空 query 400 快拒", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy({ ANYSEARCH_PROXY_CACHE_TTL_MS: "0" });
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const app = buildApp();
  const missing = await app.inject({ method: "POST", url: "/v1/search", payload: { max_results: 5 } });
  assert.equal(missing.statusCode, 400);
  const empty = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "   " } });
  assert.equal(empty.statusCode, 400);
  assert.equal(upstreamCalls, 0, "400 不应打上游");
});

test("反探测：GET /v1/search 恒 404（不暴露 405）", async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  enableProxy();
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/v1/search" });
  assert.equal(res.statusCode, 404, "GET 探测应与随机路径不可区分");
});
