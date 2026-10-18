/**
 * DidiMcpRideProvider 单测（travel-upgrade-plan P2 接驳下单链）。
 *
 * 覆盖：
 *   1. availability 降级矩阵：未注册 → 拒绝；注册但 ${DIDI_MCP_KEY} 未展开 → 拒绝
 *      （回落模拟 provider）；key 就位 → 可用（resolveProvider 自动接管首选）
 *   2. search 沙箱文本解析：maps_textsearch 坐标 → taxi_estimate 自由文本中的
 *      车型/product_category/预估流程ID/预估价 → optionId 编码（didi:{trace}:{cat}）
 *   3. 诚实边界：估价文本解析不出车型/流程ID 时不造假 option（ok:false）
 *   4. book：optionId 解码 → taxi_create_order 参数回传（字符串契约）→ 订单号提取；
 *      optionId 形态不符时明确报错引导重新报价
 *
 * 测试封闭：注入假 McpClientService（结构化 mock，无网络、无 LLM）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DidiMcpRideProvider } from "../src/services/booking/providers/didi-mcp-ride-provider.js";
import type { BookingDraft, BookingSearchQuery } from "../src/services/booking/booking-provider.js";
import type { McpClientService } from "../src/services/mcp-client-service.js";

/** 假 MCP：按工具名返回预置结果，并记录调用参数供断言 */
class FakeMcp {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  constructor(
    public servers: Array<{ alias: string; url?: string }>,
    private readonly responses: Record<string, { ok: boolean; result: Record<string, unknown> }>,
  ) {}

  listServers() {
    return this.servers as never[];
  }

  async callTool(_alias: string, toolName: string, args: Record<string, unknown>) {
    this.calls.push({ tool: toolName, args });
    return this.responses[toolName] ?? { ok: false, result: { error: "未预置" } };
  }
}

function asMcp(fake: FakeMcp): McpClientService {
  return fake as unknown as McpClientService;
}

/** 沙箱形态的 maps_textsearch / taxi_estimate / taxi_create_order 预置响应 */
function sandboxResponses() {
  return {
    maps_textsearch: {
      ok: true,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ name: "成都东站", location: { lng: "104.151", lat: "30.631" } }),
          },
        ],
      },
    },
    taxi_estimate: {
      ok: true,
      result: {
        content: [
          {
            type: "text",
            text: [
              "为您查询到 3 个车型：",
              "经济型（product_category: 3），预估流程ID：traceECO123，预估价 ¥58，3 分钟内接驾",
              "舒适型（product_category: 5），预估流程ID：traceECO123，预估价 ¥76",
              "商务型（product_category: 7），预估流程ID：traceECO123，预估价 ¥105",
            ].join("\n"),
          },
        ],
      },
    },
    taxi_create_order: {
      ok: true,
      result: {
        content: [{ type: "text", text: "下单成功，订单号：DID20261018001，状态码：1（已接单）" }],
      },
    },
  };
}

const SEARCH_QUERY: BookingSearchQuery = {
  domain: "ride",
  city: "成都",
  location: null,
  scheduleAt: null,
  params: { pickup: "成都东站", dropoff: "太古里亚朵S酒店" },
};

const PROVIDER_CTX = { actorId: "actor-test", location: null, toolContext: {} as never };

test("didi-mcp - availability 降级矩阵：未注册 / key 未配置 / key 就绪", () => {
  const responses = sandboxResponses();

  // ① 配置里没有 didi server → 不可用（明确原因）
  const noServer = new DidiMcpRideProvider(asMcp(new FakeMcp([{ alias: "rollinggo" }], responses)));
  const r1 = noServer.availability();
  assert.equal(r1.ok, false);
  assert.match(r1.reason ?? "", /未注册/);

  // ② didi 已注册但 ${DIDI_MCP_KEY} 未展开（env 缺失）→ 不可用，回落模拟 provider
  const keyless = new DidiMcpRideProvider(
    asMcp(new FakeMcp([{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=${DIDI_MCP_KEY}" }], responses)),
  );
  const prev = process.env.DIDI_MCP_KEY;
  delete process.env.DIDI_MCP_KEY;
  try {
    const r2 = keyless.availability();
    assert.equal(r2.ok, false);
    assert.match(r2.reason ?? "", /DIDI_MCP_KEY/);

    // ③ key 就位 → 可用（resolveProvider 无显式 provider 时自动接管首选）
    process.env.DIDI_MCP_KEY = "test-key";
    const r3 = keyless.availability();
    assert.equal(r3.ok, true);
  } finally {
    if (prev === undefined) delete process.env.DIDI_MCP_KEY;
    else process.env.DIDI_MCP_KEY = prev;
  }

  // ④ 配置里写死真实 key（不用 env 展开）→ 不受 env 影响，可用
  const literal = new DidiMcpRideProvider(
    asMcp(new FakeMcp([{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=abc123" }], responses)),
  );
  const prev2 = process.env.DIDI_MCP_KEY;
  delete process.env.DIDI_MCP_KEY;
  try {
    assert.equal(literal.availability().ok, true);
  } finally {
    if (prev2 !== undefined) process.env.DIDI_MCP_KEY = prev2;
  }
});

test("didi-mcp - search：沙箱文本解析出车型选项，optionId 编码报价上下文", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    sandboxResponses(),
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));

  const result = await provider.search(SEARCH_QUERY, PROVIDER_CTX);
  assert.equal(result.ok, true);
  const { options, note } = result as { ok: true; options: Array<Record<string, unknown>>; note?: string };

  // 三档车型，optionId = didi:{预估流程ID}:{product_category}
  assert.equal(options.length, 3);
  assert.equal(options[0].id, "didi:traceECO123:3");
  assert.equal(options[1].id, "didi:traceECO123:5");
  assert.equal(options[2].id, "didi:traceECO123:7");
  // 预估价/接驾 eta 尽力解析（第一档命中「预估价 ¥58」+「3 分钟内接驾」）
  assert.equal(options[0].amountCny, 58);
  assert.equal(options[0].etaMinutes, 3);
  assert.equal((options[0].extra as Record<string, unknown>).estimateTraceId, "traceECO123");
  assert.equal((options[0].extra as Record<string, unknown>).productCategory, "3");
  assert.match(note ?? "", /滴滴官方 MCP/);

  // 坐标必须来自 maps_textsearch（滴滴契约），数字/坐标参数一律字符串
  const textsearchCalls = fake.calls.filter((c) => c.tool === "maps_textsearch");
  assert.equal(textsearchCalls.length, 2); // 起点 + 终点
  const estimateCall = fake.calls.find((c) => c.tool === "taxi_estimate");
  assert.ok(estimateCall);
  for (const v of Object.values(estimateCall.args)) assert.equal(typeof v, "string");
});

test("didi-mcp - search 诚实边界：估价文本解析不出车型/流程ID 时不造假", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    {
      maps_textsearch: sandboxResponses().maps_textsearch,
      taxi_estimate: {
        ok: true,
        result: { content: [{ type: "text", text: "当前排队繁忙，请稍后重试" }] },
      },
    },
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));
  const result = await provider.search(SEARCH_QUERY, PROVIDER_CTX);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /无法解析/);
});

test("didi-mcp - book：optionId 解码 → taxi_create_order 参数回传 → 订单号提取", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    sandboxResponses(),
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));

  const draft: BookingDraft = {
    domain: "ride",
    provider: "didi",
    optionId: "didi:traceECO123:3",
    title: "经济型",
    amountCny: 58,
    scheduleAt: null,
    durationMinutes: 61,
    summary: "预订经济型",
    params: { dropoff: "太古里亚朵S酒店" },
  };
  const result = await provider.book(draft, PROVIDER_CTX);
  assert.equal(result.ok, true);
  const booked = result as { ok: true; providerOrderId: string; status: string; message: string };
  assert.equal(booked.providerOrderId, "DID20261018001");
  assert.equal(booked.status, "confirmed");
  assert.match(booked.message, /DID20261018001/);

  const createCall = fake.calls.find((c) => c.tool === "taxi_create_order");
  assert.ok(createCall);
  // 滴滴 MCP 契约：车型/流程ID 原样回传（字符串）
  assert.equal(createCall.args.product_category, "3");
  assert.equal(createCall.args.estimate_trace_id, "traceECO123");
});

test("didi-mcp - book：optionId 非滴滴形态时明确报错引导重新报价，不调 MCP", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    sandboxResponses(),
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));
  const result = await provider.book(
    { ...({} as BookingDraft), optionId: "eco", provider: "didi", domain: "ride" },
    PROVIDER_CTX,
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /非滴滴报价形态/);
  assert.equal(fake.calls.filter((c) => c.tool === "taxi_create_order").length, 0);
});
