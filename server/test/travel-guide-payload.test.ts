/**
 * 种草卡（挑一挑）数据闸门单测：卡面上只允许出现「真数」，且一律由服务端算好下发。
 *
 * 对应两条硬规矩：
 *   1. 价格一定要真：同名没查到的酒店，同城同档中位数不得冒充本店报价 → 该行只有「待核价」。
 *   2. 数据一定动态：没取到评分就不出评分胶囊；排序说明只准描述实际参与排序的信号。
 * 外加零预选：服务端不得替用户勾任何一条。
 *
 * 测试封闭：只打私有装配函数与纯卡构造器，不发外网请求。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TRAVEL_ROUTE_API_BASE = "http://127.0.0.1:9";

import { PlanningService, type GuideCandidate } from "../src/skills/travel-planning/travel-planning-service.js";
import { buildToolCard } from "../src/services/tool-card-registry.js";
import { extractHotelFocus } from "../src/skills/travel-planning/intent-parser.js";

const svc = new PlanningService();
type Private = {
  _assembleGuideMetrics(
    out: Record<"view" | "stay" | "food", GuideCandidate[]>,
    anchor: { id: string; label: string; why: string; latitude: number; longitude: number } | null,
  ): void;
  _guideDistanceMeters(
    cand: GuideCandidate,
    anchor: { latitude: number; longitude: number },
  ): number | null;
  _guideDistanceText(meters: number): string;
  _guideSortNote(list: GuideCandidate[], anchor: unknown, distanceLed: boolean): string;
};
const priv = svc as unknown as Private;

function cand(over: Partial<GuideCandidate> & { name: string }): GuideCandidate {
  return {
    address: "",
    tags: [],
    photos: [],
    metrics: [],
    ...over,
  } as GuideCandidate;
}

const emptyOut = (): Record<"view" | "stay" | "food", GuideCandidate[]> => ({
  view: [],
  stay: [],
  food: [],
});

describe("种草卡指标装配：没取到的数就不出这条", () => {
  it("酒店只拿到同城同档中位数时，行上没有价格数字，只有待核价", () => {
    const out = emptyOut();
    const h = cand({
      name: "某民宿",
      price: null,
      pricePending: true,
      priceNote: "未取到本店报价（同城同档 12 家中位数只作预算参考，不当作它家价）",
    });
    out.stay.push(h);
    priv._assembleGuideMetrics(out, null);
    const price = h.metrics.find((m) => m.kind === "price");
    assert.equal(price?.label, "待核价");
    assert.ok(!/¥|\d+\s*\/\s*晚/.test(price!.label), "中位数不得写成房价");
    assert.match(price!.source, /中位数/);
  });

  it("拿到本店实时报价才出价格胶囊", () => {
    const out = emptyOut();
    const h = cand({ name: "某酒店", price: 486, pricePending: false, priceNote: "飞猪实时房价，以下单页为准" });
    out.stay.push(h);
    priv._assembleGuideMetrics(out, null);
    const price = h.metrics.find((m) => m.kind === "price");
    assert.equal(price?.label, "¥486/晚");
    assert.equal(price?.source, "飞猪实时房价，以下单页为准");
  });

  it("高德没给评分 → 不出评分胶囊，且不写假 4.0", () => {
    const out = emptyOut();
    const v = cand({ name: "无名景点" });
    out.view.push(v);
    priv._assembleGuideMetrics(out, null);
    assert.equal(v.metrics.some((m) => m.kind === "rating"), false);
    assert.ok(!JSON.stringify(v.metrics).includes("4.0"));
  });

  it("住宿行挂锚点距离，其它段不挂", () => {
    const anchor = { id: "user", label: "洱海", why: "你说要离洱海近", latitude: 25.79, longitude: 100.18 };
    const out = emptyOut();
    const h = cand({ name: "海边客栈", latitude: 25.795, longitude: 100.185 });
    const v = cand({ name: "景点甲", latitude: 25.795, longitude: 100.185 });
    out.stay.push(h);
    out.view.push(v);
    priv._assembleGuideMetrics(out, anchor);
    assert.ok(h.metrics.some((m) => m.kind === "distance" && /离洱海/.test(m.label)));
    assert.equal(v.metrics.some((m) => m.kind === "distance"), false);
  });

  it("指标顺序：距离 → 评分 → 价格", () => {
    const anchor = { id: "user", label: "大理古城", why: "", latitude: 25.69, longitude: 100.16 };
    const out = emptyOut();
    const h = cand({ name: "客栈", rating: 4.7, price: 320, pricePending: false, latitude: 25.692, longitude: 100.162 });
    out.stay.push(h);
    priv._assembleGuideMetrics(out, anchor);
    assert.deepEqual(
      h.metrics.map((m) => m.kind),
      ["distance", "rating", "price"],
    );
  });
});

describe("距离文案：只报真数，3km 外不吹步行时间", () => {
  it("缺坐标返回 null（不出这条指标）", () => {
    assert.equal(priv._guideDistanceMeters(cand({ name: "无坐标" }), { latitude: 0, longitude: 0 }), null);
  });

  it("600m 给步行分钟，12km 只给公里数", () => {
    assert.match(priv._guideDistanceText(600), /^600m · 走约 \d+ 分$/);
    const far = priv._guideDistanceText(12000);
    assert.equal(far, "12.0km");
    assert.ok(!/走约/.test(far), "12km 的「步行约 2.8 小时」是噪声");
  });
});

describe("排序说明：只描述实际参与排序的信号", () => {
  it("一条评分都没取到 → 不出现「按评分排」", () => {
    const note = priv._guideSortNote([cand({ name: "A" }), cand({ name: "B" })], null, false);
    assert.ok(!/按评分排/.test(note));
    assert.match(note, /没取到评分/);
  });

  it("部分有评分 → 如实报 X/N 条", () => {
    const note = priv._guideSortNote(
      [cand({ name: "A", rating: 4.8 }), cand({ name: "B", rating: 4.6 }), cand({ name: "C" })],
      null,
      false,
    );
    assert.match(note, /2\/3 条有真实评分，按评分排/);
  });

  it("没按距离重排时，不声称「按离 X 近」", () => {
    const anchor = { id: "top-view", label: "洱海", why: "", latitude: 1, longitude: 1 };
    const note = priv._guideSortNote([cand({ name: "A", rating: 4.9 })], anchor, false);
    assert.ok(!/再按离洱海近/.test(note));
    assert.ok(priv._guideSortNote([cand({ name: "A", rating: 4.9 })], anchor, true).includes("再按离洱海近"));
  });
});

describe("落位诉求：从用户原话里抽，不写死", () => {
  it("点名参照点走 attraction + ref", () => {
    assert.deepEqual(extractHotelFocus("住得离洱海近点"), { focus: "attraction", ref: "洱海" });
    assert.equal(extractHotelFocus("赶早班机，住机场附近").focus, "airport");
    assert.equal(extractHotelFocus("想住靠海边的").focus, "seaside");
    assert.equal(extractHotelFocus("随便玩玩"), undefined);
  });
});

describe("通用工具卡：零预选 + 不编推荐度", () => {
  const fakeResult = {
    ok: true,
    destination: "测试市",
    view: [
      {
        name: "景点甲",
        intro: "适合慢逛拍照",
        photos: ["/media/a1.jpg", "/media/a2.jpg", "/media/a3.jpg"],
        address: "某区某路",
        metrics: [{ kind: "rating", label: "评分 4.8", source: "高德用户评分" }],
      },
      { name: "景点乙", intro: "", photos: [], address: "", metrics: [] },
    ],
    stay: [
      {
        name: "客栈甲",
        intro: "离海近",
        photos: [],
        address: "",
        metrics: [{ kind: "price", label: "待核价", source: "未取到本店报价，待核价" }],
      },
    ],
    food: [],
    stayAnchor: { id: "user", label: "洱海", why: "你说要离洱海近", latitude: 1, longitude: 2 },
    sortNotes: { view: "2/2 条有真实评分，按评分排", stay: "这一屏没取到评分，按搜索原序", food: "" },
    fromCache: true,
  };

  it("extra.guide 每条 picked=false，住宿段带锚点与真实排序说明", () => {
    const card = buildToolCard("travel.destination-guide", fakeResult);
    assert.ok(card, "卡构造器不应抛错");
    const guide = (card!.extra as { guide: { cats: Array<Record<string, unknown>> } }).guide;
    const items = guide.cats.flatMap((c) => c.items as Array<Record<string, unknown>>);
    assert.equal(items.length, 3);
    assert.equal(items.every((i) => i.picked === false), true, "服务端不得替用户预选");
    const stay = guide.cats.find((c) => c.key === "stay")!;
    assert.equal((stay.anchor as { label: string }).label, "洱海");
    assert.equal(stay.sortNote, "这一屏没取到评分，按搜索原序");
  });

  it("平铺兜底文案不含「推荐 N%」，footer 不再宣称已预选", () => {
    const card = buildToolCard("travel.destination-guide", fakeResult);
    const text = JSON.stringify(card);
    assert.ok(!/推荐 \d+%/.test(text), "假推荐度不得出现在卡里");
    assert.ok(!/已预选/.test(text));
    assert.ok(card!.items!.some((i) => i.text === "必玩 · 景点甲（评分 4.8）"));
  });

  it("指标原样透传，客户端不需要再换算", () => {
    const card = buildToolCard("travel.destination-guide", fakeResult);
    const view = (card!.extra as { guide: { cats: Array<Record<string, unknown>> } }).guide.cats[0];
    const first = (view.items as Array<Record<string, unknown>>)[0];
    assert.deepEqual(first.metrics, [{ kind: "rating", label: "评分 4.8", source: "高德用户评分" }]);
  });
});
