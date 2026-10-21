/**
 * Provider 能力档案表（provider-profiles）行为测试。
 *
 * 契约（2026-10-07 换模型通用适配）：
 * - 快模型（openai / moonshot-kimi）路由参数维持现行验证值 192/3000；
 * - 思考型（minimax）放大到 1024/5000——M2.x 思考计入 max_tokens，192 会把正文饿死；
 * - 未登记 id（failover / 测试替身）回落安全默认：预算超时放大、旁路零侵入；
 * - LLM_ROUTE_TIMEOUT_MS 显式覆盖所有档案超时；
 * - bypassChatRequestExtras 委托档案表：minimax / openai+deepseek-flash / kimi
 *   附带 thinking:disabled，其余零侵入。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  PROVIDER_MODEL_PROFILES,
  FALLBACK_PROVIDER_PROFILE,
  resolveProviderProfile,
  resolveRouteCallParams,
} = await import("../src/external-model/provider-profiles.js");
const { bypassChatRequestExtras } = await import("../src/external-model/resolve-provider.js");

function envWith(pairs: Record<string, string>): NodeJS.ProcessEnv {
  return pairs as unknown as NodeJS.ProcessEnv;
}

/* ---------------- 档案内容 ---------------- */

test("minimax 档案：路由预算/超时放大（M2.x 思考计入 max_tokens 的教训）", () => {
  const p = resolveProviderProfile("minimax");
  assert.equal(p, PROVIDER_MODEL_PROFILES.minimax);
  assert.ok(p.routeMaxOutputTokens >= 1024, `预算应 ≥1024，实际 ${p.routeMaxOutputTokens}`);
  assert.ok(p.routeTimeoutMs >= 5000, `超时应 ≥5000ms，实际 ${p.routeTimeoutMs}`);
  assert.deepEqual(p.bypassRequestExtras("MiniMax-M3"), {
    reasoning_split: true,
    thinking: { type: "disabled" },
  });
});

test("快模型档案（openai/kimi）：维持现行验证值 192/3000 不回归", () => {
  for (const id of ["openai", "moonshot-kimi"]) {
    const p = resolveProviderProfile(id);
    assert.equal(p.routeMaxOutputTokens, 192, `${id} 预算应保持 192`);
    assert.equal(p.routeTimeoutMs, 3000, `${id} 超时应保持 3000ms`);
  }
});

test("openai 槽位旁路参数按模型区分：deepseek-flash 关思考，gpt 零侵入", () => {
  const p = resolveProviderProfile("openai");
  assert.deepEqual(p.bypassRequestExtras("deepseek-flash"), { thinking: { type: "disabled" } });
  assert.deepEqual(p.bypassRequestExtras("gpt-4o-mini"), {});
});

test("未登记 provider（failover/测试替身）：安全默认放大预算，旁路零侵入", () => {
  const failover = resolveProviderProfile("failover");
  assert.equal(failover, FALLBACK_PROVIDER_PROFILE);
  assert.ok(failover.routeMaxOutputTokens >= 1024);
  assert.ok(failover.routeTimeoutMs >= 5000);
  assert.deepEqual(resolveProviderProfile(undefined).bypassRequestExtras("anything"), {});
});

/* ---------------- 路由调用参数 ---------------- */

test("resolveRouteCallParams：按路由 provider 档案自适应（含 jsonMode 能力）", () => {
  // 显式空 env：避免宿主机 .env.local 的 LLM_ROUTE_MODEL 等覆盖干扰档案断言
  assert.deepEqual(resolveRouteCallParams({ id: "openai" }, envWith({})), {
    maxOutputTokens: 192,
    timeoutMs: 3000,
    jsonMode: true,
  });
  assert.deepEqual(resolveRouteCallParams({ id: "moonshot-kimi" }, envWith({})), {
    maxOutputTokens: 192,
    timeoutMs: 3000,
    jsonMode: true,
  });
  assert.deepEqual(resolveRouteCallParams({ id: "minimax" }, envWith({})), {
    maxOutputTokens: 1024,
    timeoutMs: 5000,
    jsonMode: true,
  });
});

test("resolveRouteCallParams：LLM_ROUTE_MODEL 作为路由模型覆盖透传", () => {
  assert.equal(
    resolveRouteCallParams({ id: "minimax" }, envWith({ LLM_ROUTE_MODEL: "MiniMax-M3" }))
      .modelOverride,
    "MiniMax-M3",
  );
  // 未配置时不产生 modelOverride（沿用 provider 主模型）
  assert.equal(
    resolveRouteCallParams({ id: "minimax" }, envWith({})).modelOverride,
    undefined,
  );
});

test("supportsJsonMode：已知端点 true，未登记端点默认 false（不冒险传参）", () => {
  for (const id of ["openai", "moonshot-kimi", "minimax"]) {
    assert.equal(resolveProviderProfile(id).supportsJsonMode, true, `${id} 应支持 json mode`);
  }
  assert.equal(FALLBACK_PROVIDER_PROFILE.supportsJsonMode, false);
  assert.equal(resolveRouteCallParams(null).jsonMode, false);
});

test("resolveRouteCallParams：无 id（测试替身/null）回落安全默认档案", () => {
  const params = resolveRouteCallParams(null);
  assert.equal(params.maxOutputTokens, FALLBACK_PROVIDER_PROFILE.routeMaxOutputTokens);
  assert.equal(params.timeoutMs, FALLBACK_PROVIDER_PROFILE.routeTimeoutMs);
  const noId = resolveRouteCallParams({ isEnabled: () => true } as { id?: string });
  assert.equal(noId.maxOutputTokens, FALLBACK_PROVIDER_PROFILE.routeMaxOutputTokens);
});

test("resolveRouteCallParams：LLM_ROUTE_TIMEOUT_MS 显式覆盖档案超时", () => {
  const overridden = resolveRouteCallParams(
    { id: "minimax" },
    envWith({ LLM_ROUTE_TIMEOUT_MS: "2500" }),
  );
  assert.equal(overridden.timeoutMs, 2500);
  assert.equal(overridden.maxOutputTokens, 1024);
  // 非法值（0 / 非数字）忽略覆盖，回落档案值
  assert.equal(
    resolveRouteCallParams({ id: "minimax" }, envWith({ LLM_ROUTE_TIMEOUT_MS: "0" })).timeoutMs,
    5000,
  );
  assert.equal(
    resolveRouteCallParams({ id: "minimax" }, envWith({ LLM_ROUTE_TIMEOUT_MS: "abc" })).timeoutMs,
    5000,
  );
});

/* ---------------- bypassChatRequestExtras 委托档案表 ---------------- */

test("bypassChatRequestExtras：minimax 主模型附带 thinking:disabled", () => {
  const extras = bypassChatRequestExtras(
    envWith({ EXTERNAL_MODEL_PROVIDER: "minimax", MINIMAX_API_KEY: "k" }),
  );
  assert.deepEqual(extras, {
    reasoning_split: true,
    thinking: { type: "disabled" },
  });
});

test("bypassChatRequestExtras：openai 槽位 deepseek-flash 关思考 / gpt 零侵入", () => {
  assert.deepEqual(
    bypassChatRequestExtras(
      envWith({
        EXTERNAL_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "deepseek-flash",
      }),
    ),
    { thinking: { type: "disabled" } },
  );
  assert.deepEqual(
    bypassChatRequestExtras(
      envWith({
        EXTERNAL_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "gpt-4o-mini",
      }),
    ),
    {},
  );
});

test("bypassChatRequestExtras：kimi 主模型对齐 provider 层默认（thinking:disabled）", () => {
  const extras = bypassChatRequestExtras(
    envWith({ EXTERNAL_MODEL_PROVIDER: "moonshot-kimi", MOONSHOT_API_KEY: "k" }),
  );
  assert.deepEqual(extras, { thinking: { type: "disabled" } });
});
