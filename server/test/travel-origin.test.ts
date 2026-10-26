import test from "node:test";
import assert from "node:assert/strict";

/**
 * 出发地按定位兜底（travel-origin）+ 无直飞自动转机查价（travel-live-pricing）。
 *
 * 产品口径（2026-10-26）：用户没说出发地时不再反问「从哪个城市出发」——按定位
 * 城市作默认出发地（兴义市→兴义）；出发地无直飞时按枢纽候选（省会优先）查
 * 「出发地→枢纽」「枢纽→目的地」两段真实票价拼转机方案，查不到绝不编价。
 *
 * 运行：npx tsx --test test/travel-origin.test.ts
 */

const { deriveOriginCityName, transferHubCandidates } = await import(
  "../src/skills/travel-planning/travel-origin.js"
);
const { lookupTransportPrice } = await import(
  "../src/skills/travel-planning/travel-live-pricing.js"
);
type FlyAiRunResult = import("../src/services/booking/quote/flyai-quote-source.js").FlyAiRunResult;

// ======================== 城市名归一 ========================

test("deriveOriginCityName：自治州下辖县级市取区县（兴义市→兴义）", () => {
  assert.equal(
    deriveOriginCityName({
      city: "黔西南布依族苗族自治州",
      district: "兴义市",
      region: "贵州省",
    }),
    "兴义",
  );
});

test("deriveOriginCityName：直辖市取 region（浦东新区/北京市都归到上海/北京）", () => {
  assert.equal(deriveOriginCityName({ city: "", district: "北京市", region: "北京市" }), "北京");
  assert.equal(
    deriveOriginCityName({ city: "浦东新区", district: "浦东新区", region: "上海市" }),
    "上海",
  );
  assert.equal(
    deriveOriginCityName({ city: "滨海新区", district: "滨海新区", region: "天津市" }),
    "天津",
  );
});

test("deriveOriginCityName：普通地级市去「市」后缀，区不冒充城市", () => {
  assert.equal(deriveOriginCityName({ city: "杭州市", district: "西湖区", region: "浙江省" }), "杭州");
  assert.equal(deriveOriginCityName({ city: "延边朝鲜族自治州", district: "延吉市", region: "吉林省" }), "延吉");
});

test("deriveOriginCityName：自治区/特区与空值兜底", () => {
  assert.equal(deriveOriginCityName({ city: "南宁市", district: "青秀区", region: "广西壮族自治区" }), "南宁");
  assert.equal(deriveOriginCityName({ city: "香港岛", district: "中西区", region: "香港特别行政区" }), "香港");
  assert.equal(deriveOriginCityName({ city: "", district: "", region: "黑龙江省" }), "黑龙江");
  assert.equal(deriveOriginCityName({ city: "", district: "", region: "" }), "");
});

// ======================== 转机枢纽候选 ========================

test("transferHubCandidates：省会优先，补通用枢纽，去掉出发地自身", () => {
  assert.deepEqual(transferHubCandidates("兴义", "贵州省"), ["贵阳", "广州", "上海"]);
  assert.deepEqual(transferHubCandidates("丽江", "云南省"), ["昆明", "广州", "上海"]);
  assert.deepEqual(transferHubCandidates("上海"), ["广州", "昆明", "成都"]);
  assert.deepEqual(transferHubCandidates("广州", "广东省"), ["上海", "昆明", "成都"]);
});

// ======================== 无直飞转机真实查价 ========================

type FakeLeg = { price: number; no: string; durationMin: number };

/** 构造 flyai CLI 桩：按「origin->destination」路由报价，缺失的航线返回空 itemList=查不到 */
function makeFakeRunner(legs: Record<string, FakeLeg | null>, calls: string[]) {
  const ok = (items: unknown[]): FlyAiRunResult => ({
    ok: true,
    stdout: JSON.stringify({ status: 0, data: { itemList: items } }),
    stderr: "",
  });
  const flightItem = (leg: FakeLeg) => ({
    ticketPrice: leg.price,
    journeys: [
      {
        totalDuration: String(leg.durationMin),
        segments: [{ marketingTransportNo: leg.no, marketingTransportName: "测试航空" }],
      },
    ],
  });
  return async (args: string[]): Promise<FlyAiRunResult> => {
    const get = (flag: string): string => {
      const i = args.indexOf(flag);
      return i >= 0 ? (args[i + 1] as string) : "";
    };
    const cmd = args[0] ?? "";
    const from = get("--origin");
    const to = get("--destination");
    calls.push(`${cmd} ${from}->${to}`);
    if (cmd !== "search-flight") return ok([]); // 本套用例火车一律查不到
    const leg = legs[`${from}->${to}`];
    return leg ? ok([flightItem(leg)]) : ok([]);
  };
}

test("无直飞：按枢纽两段实价出转机方案，省会枢纽便宜者胜出", async () => {
  const calls: string[] = [];
  const runner = makeFakeRunner(
    {
      "兴义甲->巴厘甲": null, // 直飞查不到
      "兴义甲->贵阳": { price: 400, no: "A1", durationMin: 60 },
      "贵阳->巴厘甲": { price: 1500, no: "B1", durationMin: 330 },
      "兴义甲->广州": { price: 700, no: "A2", durationMin: 90 },
      "广州->巴厘甲": { price: 1500, no: "B2", durationMin: 300 },
    },
    calls,
  );
  const result = await lookupTransportPrice({
    origin: "兴义甲",
    originRegion: "贵州省",
    destination: "巴厘甲",
    runner,
  });
  assert.ok(result, "两段都有实价时必须给出转机方案");
  assert.equal(result.mode, "flight");
  assert.equal(result.viaHub, "贵阳");
  assert.equal(result.label, "转机往返机票（经贵阳）");
  assert.equal(result.amount, 400 + 1500); // 两段合计，取更便宜的贵阳枢纽
  assert.ok(result.note.includes("无直飞"), "note 必须如实说明无直飞");
  assert.ok(result.note.includes("经贵阳转机计价"));
  assert.ok(result.note.includes("候机时间未含"));
  assert.ok(result.note.includes("经广州"), "另一枢纽进「另一方案」");
  // 直飞为空才触发枢纽查询：两段×2个枢纽=4次 flight 查询 + 1次直飞 + 1次火车
  assert.ok(calls.some((c) => c === "search-flight 兴义甲->贵阳"));
  assert.ok(calls.some((c) => c === "search-flight 贵阳->巴厘甲"));
});

test("直飞存在：不触发枢纽查询，维持直飞选项", async () => {
  const calls: string[] = [];
  const runner = makeFakeRunner(
    {
      "直飞乙->上海乙": { price: 800, no: "C1", durationMin: 140 },
    },
    calls,
  );
  const result = await lookupTransportPrice({
    origin: "直飞乙",
    destination: "上海乙",
    runner,
  });
  assert.ok(result);
  assert.equal(result.viaHub, undefined);
  assert.equal(result.amount, 800);
  assert.ok(!result.label.includes("转机"));
  assert.ok(
    calls.every((c) => !c.includes("->广州") && !c.includes("->昆明") && !c.includes("->成都")),
    "直飞查到价时绝不发起枢纽两段查询",
  );
});

test("枢纽两段缺一：宁可 null 不编价", async () => {
  const calls: string[] = [];
  const runner = makeFakeRunner(
    {
      "兴义丙->巴厘丙": null, // 直飞查不到
      "兴义丙->贵阳": { price: 400, no: "A1", durationMin: 60 },
      "贵阳->巴厘丙": null, // 第二段查不到
    },
    calls,
  );
  const result = await lookupTransportPrice({
    origin: "兴义丙",
    originRegion: "贵州省",
    destination: "巴厘丙",
    runner,
  });
  assert.equal(result, null, "两段拼不齐就不报价，绝不虚构转机价");
});

test("转机总耗时超12小时不冒充合理选项（无更优时仍如实给出）", async () => {
  const calls: string[] = [];
  const runner = makeFakeRunner(
    {
      "兴义丁->巴厘丁": null,
      "兴义丁->贵阳": { price: 400, no: "A1", durationMin: 300 },
      "贵阳->巴厘丁": { price: 1500, no: "B1", durationMin: 600 },
    },
    calls,
  );
  const result = await lookupTransportPrice({
    origin: "兴义丁",
    originRegion: "贵州省",
    destination: "巴厘丁",
    runner,
  });
  assert.ok(result, "极端行程也如实给出而不是静默丢失（与火车38h同一口径）");
  assert.equal(result.amount, 400 + 1500);
});
