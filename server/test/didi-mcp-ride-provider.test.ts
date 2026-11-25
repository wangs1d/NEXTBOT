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
import { wgs84ToGcj02 } from "../src/skills/travel-planning/coord-transform.js";
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
  const { options, note, route } = result as {
    ok: true;
    options: Array<Record<string, unknown>>;
    note?: string;
    route?: { from?: { lat: number; lng: number }; to?: { lat: number; lng: number } };
  };

  // 三档车型，optionId = didi:{预估流程ID}:{product_category}
  assert.equal(options.length, 3);
  assert.equal(options[0].id, "didi:traceECO123:3");
  assert.equal(options[1].id, "didi:traceECO123:5");
  assert.equal(options[2].id, "didi:traceECO123:7");
  // 预估价/接驾 eta 按行解析：三档必须各是各的价（曾把所有车型套成同一个价）
  assert.equal(options[0].amountCny, 58);
  assert.equal(options[1].amountCny, 76);
  assert.equal(options[2].amountCny, 105);
  assert.equal(options[0].etaMinutes, 3);
  assert.equal(options[1].etaMinutes, null);
  assert.equal(options[2].etaMinutes, null);
  assert.equal((options[0].extra as Record<string, unknown>).estimateTraceId, "traceECO123");
  assert.equal((options[0].extra as Record<string, unknown>).productCategory, "3");
  // 卡面文案不再暴露实现细节（「官方 MCP」「两阶段确认」已删）
  assert.equal(note, undefined);
  // 算路失败也要带回起终点：选完上车点后地图要能标出两端
  assert.ok(route?.from && route?.to);

  // 坐标必须来自 maps_textsearch（滴滴契约），数字/坐标参数一律字符串
  const textsearchCalls = fake.calls.filter((c) => c.tool === "maps_textsearch");
  assert.equal(textsearchCalls.length, 2); // 起点 + 终点
  const estimateCall = fake.calls.find((c) => c.tool === "taxi_estimate");
  assert.ok(estimateCall);
  for (const v of Object.values(estimateCall.args)) assert.equal(typeof v, "string");
});

test("didi-mcp - search：接驾分钟数不能当价格（每行价格独立解析）", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    {
      maps_textsearch: sandboxResponses().maps_textsearch,
      taxi_estimate: {
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: [
                "为您查询到 3 个车型：",
                "快车（product_category: 1），预估流程ID：traceA，约 1 分钟内接驾，预估价格 45 元",
                "专车（product_category: 2），预估流程ID：traceA，约 3 分钟内接驾，预估价格 78 元",
              ].join("\n"),
            },
          ],
        },
      },
    },
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));
  const result = await provider.search(SEARCH_QUERY, PROVIDER_CTX);
  assert.equal(result.ok, true);
  const { options } = result as { ok: true; options: Array<Record<string, unknown>> };
  assert.equal(options.length, 2);
  assert.equal(options[0].amountCny, 45);
  assert.equal(options[0].etaMinutes, 1);
  assert.equal(options[1].amountCny, 78);
  assert.equal(options[1].etaMinutes, 3);
});

test("didi-mcp - search：GPS 坐标直传起点，不再倒腾文本地理编码", async () => {
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    sandboxResponses(),
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));

  // 真机形态：pickup 是区县级粗标签（没有细地址），坐标由 handler 直传
  const query: BookingSearchQuery = {
    ...SEARCH_QUERY,
    params: {
      pickup: "成都市武侯区",
      dropoff: "太古里亚朵S酒店",
      pickupCoords: { lat: 30.6423, lng: 104.0432 },
    },
  };
  const result = await provider.search(query, PROVIDER_CTX);
  assert.equal(result.ok, true);
  // maps_textsearch 只应搜过目的地一次（起点坐标直传，不走地理编码）
  const searchCalls = fake.calls.filter((c) => c.tool === "maps_textsearch");
  assert.equal(searchCalls.length, 1);
  assert.match(searchCalls[0].args.keywords as string, /太古里/);
  // 估价拿到的是直传坐标（WGS-84 → GCJ-02，6 位小数字符串契约）
  const est = fake.calls.find((c) => c.tool === "taxi_estimate");
  const expectFrom = wgs84ToGcj02(30.6423, 104.0432);
  assert.equal(est?.args.from_lat, expectFrom.latitude.toFixed(6));
  assert.equal(est?.args.from_lng, expectFrom.longitude.toFixed(6));
});

/** 第一次 textsearch 返回未命中（模拟区县粗标签搜不到），其余正常 */
class FirstSearchMissMcp extends FakeMcp {
  private textsearchCalls = 0;
  async callTool(alias: string, toolName: string, args: Record<string, unknown>) {
    if (toolName === "maps_textsearch") {
      this.textsearchCalls += 1;
      if (this.textsearchCalls === 1) {
        return { ok: true, result: { content: [{ type: "text", text: "未找到相关地点" }] } };
      }
    }
    return super.callTool(alias, toolName, args);
  }
}

test("didi-mcp - search：粗标签检索失败时回退客户端 GPS 坐标，不直接报无法定位", async () => {
  const fake = new FirstSearchMissMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers-sandbox?key=k" }],
    sandboxResponses(),
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));
  const ctx = { ...PROVIDER_CTX, location: { latitude: 30.65, longitude: 104.06, label: "成都市武侯区" } as never };
  const query: BookingSearchQuery = {
    ...SEARCH_QUERY,
    params: { pickup: "成都市武侯区", dropoff: "太古里亚朵S酒店" },
  };
  const result = await provider.search(query, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const est = fake.calls.find((c) => c.tool === "taxi_estimate");
  const expectFrom = wgs84ToGcj02(30.65, 104.06);
  assert.equal(est?.args.from_lat, expectFrom.latitude.toFixed(6));
  assert.equal(est?.args.from_lng, expectFrom.longitude.toFixed(6));
});

test("didi-mcp - search：生产端点格式（品类代码 + 无价列表行去重 + city 缺失回退）", async () => {
  const estimateText = [
    "可用车型及对应product_category：",
    "1. 惊喜特价 (product_category: 191)",
    "2. 特惠快车 (product_category: 201)",
    "3. 快车 (product_category: 1)",
    "执行规则：必须询问用户选择哪种车型，不能自动选择",
    "【用户显示内容】",
    "网约车价格预估结果：",
    "1. 惊喜特价: 约 14 元 (品类代码: 191)",
    "2. 特惠快车: 约 25 元, 券后约16元 (品类代码: 201)",
    "3. 快车: 约 27 元 (品类代码: 1)",
    "5. 专车: 约 49 元 (品类代码: 8)",
    "",
    "预估流程ID: 0a8d08aa6afec753a29f813aec255402",
  ].join("\n");
  const fake = new FakeMcp(
    [{ alias: "didi", url: "https://mcp.didichuxing.com/mcp-servers?key=k" }],
    {
      maps_textsearch: {
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  display_name: "菁华园(九里堤北路)-西南2门",
                  address: "金牛区九里堤街道九里堤北路6号",
                  city: "成都市",
                  location: { lng: 104.054, lat: 30.705709 },
                },
              ]),
            },
          ],
        },
      },
      taxi_estimate: { ok: true, result: { content: [{ type: "text", text: estimateText }] } },
    },
  );
  const provider = new DidiMcpRideProvider(asMcp(fake));
  // 模型没传 city → provider 应回退 ctx.location.city 补上（生产端点无 city 直接 400）
  const ctx = { ...PROVIDER_CTX, location: { latitude: 30.7, longitude: 104.05, city: "成都市" } as never };
  const result = await provider.search(
    { ...SEARCH_QUERY, city: null },
    ctx,
  );
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  const searchCalls = fake.calls.filter((c) => c.tool === "maps_textsearch");
  for (const c of searchCalls) assert.equal(c.args.city, "成都市");
  // 起点名取生产端点的 display_name
  const est = fake.calls.find((c) => c.tool === "taxi_estimate");
  assert.match(String(est?.args.from_name), /菁华园/);

  // 同车型去重 + 价格取「约 N 元」明细行（不是无价列表行）
  const { options } = result as { ok: true; options: Array<Record<string, unknown>> };
  const categories = options.map((o) => (o.extra as Record<string, unknown>).productCategory);
  assert.equal(new Set(categories).size, categories.length, "同车型只保留一条");
  const special = options.find((o) => o.title.includes("惊喜特价"));
  assert.ok(special, "应有惊喜特价");
  assert.equal(special.amountCny, 14);
  const coupon = options.find((o) => o.title.includes("特惠快车"));
  assert.equal(coupon?.amountCny, 25);
  const limo = options.find((o) => o.title.includes("专车"));
  assert.equal(limo?.amountCny, 49);
  assert.equal((limo!.extra as Record<string, unknown>).estimateTraceId, "0a8d08aa6afec753a29f813aec255402");
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
