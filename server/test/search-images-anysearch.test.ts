/**
 * search_images 提供方契约测试（2026-09-17）。
 *
 * 背景：AnySearch 无独立图片端点，图片搜索是 /v1/search + tag={domain}.{sub_domain}
 * 垂直路由；tag 由 GET /v1/sub-domains?domain=image 能力自发现（服务端灰度开放），
 * 或 ANYSEARCH_IMAGE_TAG 显式指定。未开放时返回 []（不回落必应爬页兜底）。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  searchImagesViaSearchApi,
  resetAnySearchImageProbeForTests,
} from "../src/services/search-api-provider.js";

const originalFetch = globalThis.fetch;

function setProvider(): void {
  process.env.SEARCH_API_PROVIDER = "anysearch";
  process.env.SEARCH_API_KEY = "as_sk_test";
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ANYSEARCH_IMAGE_TAG;
  resetAnySearchImageProbeForTests();
});

test("ANYSEARCH_IMAGE_TAG 显式指定时直搜图片垂直并容错解析字段", async () => {
  setProvider();
  process.env.ANYSEARCH_IMAGE_TAG = "image.search";
  let probed = 0;
  let postedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/sub-domains")) {
      probed += 1;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/v1/search")) {
      postedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            results: [
              {
                title: "科莫多 帕达尔岛 实拍",
                image_url: "https://img.example.com/a.jpg",
                page_url: "https://travel.example.com/a",
              },
              { title: "无图条目应被跳过", url: "" },
              { title: "重复应去重", image_url: "https://img.example.com/a.jpg" },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const items = await searchImagesViaSearchApi("科莫多 帕达尔岛", 4);
  assert.equal(probed, 0, "显式 tag 时不应探测能力拓扑");
  assert.equal(postedBody?.tag, "image.search");
  assert.equal(postedBody?.max_results, 4);
  assert.equal(items.length, 1, "空 url 跳过 + 重复去重后只留 1 条");
  assert.equal(items[0]?.mediaUrl, "https://img.example.com/a.jpg");
  assert.equal(items[0]?.pageUrl, "https://travel.example.com/a");
  assert.equal(items[0]?.source, "AnySearch");
});

test("能力自发现：sub-domains 探测到 image 域时用发现的 tag 搜图", async () => {
  setProvider();
  let postedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/sub-domains")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            domains: [{ domain: "image", sub_domains: [{ sub_domain: "photo" }] }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/search")) {
      postedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { results: [{ title: "komodo", image_url: "https://img.example.com/k.jpg" }] },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const items = await searchImagesViaSearchApi("科莫多", 2);
  assert.equal(postedBody?.tag, "image.photo", "tag 应来自能力拓扑发现");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.mediaUrl, "https://img.example.com/k.jpg");
});

test("能力未开放：探测被拒后返回空数组（调用方不再回落必应）", async () => {
  setProvider();
  let searchCalled = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/sub-domains")) {
      return new Response(
        JSON.stringify({ code: -1, message: "Capabilities temporarily unavailable." }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/search")) searchCalled += 1;
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const items = await searchImagesViaSearchApi("科莫多", 2);
  assert.equal(items.length, 0);
  assert.equal(searchCalled, 0, "能力未开放时不应发起图片搜索请求");
});

test("ANYSEARCH_IMAGE_TAG=off 关闭探测，不发任何请求直接返回空", async () => {
  setProvider();
  process.env.ANYSEARCH_IMAGE_TAG = "off";
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const items = await searchImagesViaSearchApi("科莫多", 2);
  assert.equal(items.length, 0);
  assert.equal(called, 0);
});
