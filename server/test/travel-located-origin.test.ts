import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 出发地按定位默认（2026-10-26）三处契约：
 *   1. plan-session：编排器没填出发地时确定性回填定位城市（LLM 降级路径同样生效），
 *      say 未提及时补一句说明；filterQuestion 据此不再出「从哪个城市出发」卡；
 *   2. LocationCoordinator.getLatest：无 actorId 的 HTTP 会话被动读最近定位（多端取最新）；
 *   3. 简报溯源：located 标注如实呈现「（按定位，可改）」，不冒充用户原话。
 *
 * 运行：npx tsx --test test/travel-located-origin.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-located-origin-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { backfillOriginFromLocation, filterQuestion } = await import(
  "../src/skills/travel-planning/travel-plan-session.js"
);
type PlanSession = import("../src/skills/travel-planning/travel-plan-session.js").PlanSession;
const { buildBrief, briefAssumptions, briefOpenQuestions, briefFromStoredPlan } = await import(
  "../src/skills/travel-planning/travel-brief.js"
);

function session(over: Partial<PlanSession> = {}): PlanSession {
  return {
    id: "ps-located",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalMessage: "巴厘岛一周，海边带泳池的酒店",
    destination: "巴厘岛",
    answers: [],
    history: [],
    ready: false,
    questionTurns: 0,
    draft: null,
    budgetApproved: false,
    weatherSent: false,
    guideSent: false,
    ...over,
  };
}

const originQuestion = {
  id: "origin",
  stage: "出发地",
  title: "从哪儿出发？",
  multi: false,
  options: ["北京", "上海", "广州"],
};

// ======================== plan-session 回填 ========================

test("编排器没填出发地：回填定位城市并在 say 补一句说明", () => {
  const s = session({
    locatedOrigin: { city: "兴义", region: "贵州省", locatedAt: Date.now() - 60_000 },
  });
  const say = backfillOriginFromLocation(s, "巴厘岛一周记下了~");
  assert.equal(s.origin, "兴义");
  assert.equal(s.originSource, "located");
  assert.ok(say.includes("兴义"), "say 必须向用户说明出发地按定位取的");
  assert.ok(say.includes("按你的定位"));
});

test("编排器 say 已提到定位城市：不重复补句", () => {
  const s = session({
    locatedOrigin: { city: "兴义", region: "贵州省", locatedAt: Date.now() - 60_000 },
  });
  const say = backfillOriginFromLocation(s, "按你的定位从兴义出发，巴厘岛一周记下了~");
  assert.equal(s.origin, "兴义");
  assert.equal(say, "按你的定位从兴义出发，巴厘岛一周记下了~");
});

test("用户已说出发地：绝不覆盖、say 原样", () => {
  const s = session({
    origin: "上海",
    locatedOrigin: { city: "兴义", region: "贵州省", locatedAt: Date.now() - 60_000 },
  });
  const say = backfillOriginFromLocation(s, "上海出发记下了~");
  assert.equal(s.origin, "上海");
  assert.equal(s.originSource, undefined);
  assert.equal(say, "上海出发记下了~");
});

test("无定位会话：回填是不动操作", () => {
  const s = session();
  const say = backfillOriginFromLocation(s, "巴厘岛一周记下了~");
  assert.equal(s.origin, undefined);
  assert.equal(say, "巴厘岛一周记下了~");
});

test("回填后不再出「从哪个城市出发」问题卡", () => {
  const located = session({
    locatedOrigin: { city: "兴义", region: "贵州省", locatedAt: Date.now() - 60_000 },
  });
  backfillOriginFromLocation(located, "记下了~");
  assert.equal(filterQuestion(located, originQuestion), null);
  // 对照：没有出发地时 origin 卡照常放行
  assert.ok(filterQuestion(session(), originQuestion));
});

// ======================== LocationCoordinator.getLatest ========================

test("getLatest：多端上报取最新，超龄条目忽略", async () => {
  const { LocationCoordinator: Coord } = await import(
    "../src/services/location-coordinator.js"
  );
  const coord = new Coord();
  const socket = { send: () => {} };
  coord.completeFromSocket(socket, "desktop", { latitude: 31.23, longitude: 121.47 });
  // 手工把第一条时间戳拨老（绕过真实时钟等待）
  const cache = (coord as unknown as { cache: Map<string, { payload: unknown; at: number }> }).cache;
  const desktopHit = cache.get("desktop")!;
  cache.set("desktop", { ...desktopHit, at: Date.now() - 72 * 60 * 60 * 1000 }); // 72h 前，超 48h 门
  coord.completeFromSocket(socket, "phone", { latitude: 25.09, longitude: 104.9, city: "兴义市" });

  const latest = coord.getLatest();
  assert.ok(latest);
  assert.equal(latest.actorId, "phone");
  assert.equal(latest.payload.city, "兴义市");
  // phone 也拨老后整库超龄：视为无定位
  const phoneHit = cache.get("phone")!;
  cache.set("phone", { ...phoneHit, at: Date.now() - 2 * 60 * 60 * 1000 });
  assert.equal(coord.getLatest(60_000), null, "超过 maxAgeMs 一律视为无定位");
});

// ======================== 简报 located 溯源 ========================

test("buildBrief：located 溯源如实显示「按定位，可改」且不再追问出发地", () => {
  const brief = buildBrief({
    destination: "巴厘岛",
    prefs: { origin: "兴义", sources: { origin: "located" } },
  });
  assert.equal(brief.origin, "兴义");
  assert.equal(brief.provenance.origin, "located");
  const rows = briefAssumptions(brief);
  const originRow = rows.find((r) => r.key === "origin");
  assert.ok(originRow);
  assert.equal(originRow.value, "兴义（按定位，可改）");
  assert.ok(!briefOpenQuestions(brief).some((q) => q.id === "origin"));
});

test("buildBrief：user 溯源维持「stated」不展示（老口径不回归）", () => {
  const brief = buildBrief({
    destination: "巴厘岛",
    prefs: { origin: "上海", sources: { origin: "user" } },
  });
  assert.equal(brief.provenance.origin, "stated");
  assert.ok(!briefAssumptions(brief).some((r) => r.key === "origin"));
});

test("briefFromStoredPlan：冷层 slots.sources.origin=located 回读不丢", () => {
  const brief = briefFromStoredPlan({
    destination: "巴厘岛",
    startDate: "2026-11-01",
    slots: { origin: "兴义", startDate: "2026-11-01", sources: { origin: "located" } },
    days: [{ date: "2026-11-01" }, { date: "2026-11-02" }],
  });
  assert.equal(brief.origin, "兴义");
  assert.equal(brief.provenance.origin, "located");
});
