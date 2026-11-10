/**
 * 「图片搜索是否只能落必应图片页」判据（2026-11-09）。
 *
 * 用途：纯人名的查询词约束只针对必应这一层（用户口径），接入真正的图片搜索
 * API 后查询词原样透传。本判据必须与 searchImagesViaSearchApi 的早退条件逐条
 * 对齐，否则会出现「明明有 API 却被净化」或「只能爬必应却没净化」两种错配。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { isBingImagePageFallbackOnly } from "../src/services/search-api-provider.js";

const KEYS = ["SEARCH_API_PROVIDER", "SEARCH_API_KEY", "JINA_API_KEY"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(pairs: Record<string, string | undefined>): void {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(pairs)) if (v !== undefined) process.env[k] = v;
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

test("未配置搜索 API → 只能爬必应图片页", () => {
  setEnv({});
  assert.equal(isBingImagePageFallbackOnly(), true);
});

test("提供方无图片能力（Jina）→ 仍只能爬必应", () => {
  setEnv({ SEARCH_API_PROVIDER: "jina" });
  assert.equal(isBingImagePageFallbackOnly(), true);
});

test("配了提供方但缺 key → 仍只能爬必应", () => {
  setEnv({ SEARCH_API_PROVIDER: "tavily" });
  assert.equal(isBingImagePageFallbackOnly(), true);
});

test("配了有图片能力且 key 齐的 API → 不再走必应（查询词原样透传）", () => {
  setEnv({ SEARCH_API_PROVIDER: "tavily", SEARCH_API_KEY: "tvly-test" });
  assert.equal(isBingImagePageFallbackOnly(), false);
  setEnv({ SEARCH_API_PROVIDER: "serper", SEARCH_API_KEY: "serper-test" });
  assert.equal(isBingImagePageFallbackOnly(), false);
});
