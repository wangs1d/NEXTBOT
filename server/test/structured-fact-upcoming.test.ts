/**
 * 未来态（upcoming）与证据门（2026-10-19 用户定调）。
 *
 * 核心主张：**计划到期不等于事情发生**。用户说"下个月搬去成都"，到期没去、
 * 也没提，系统无权替他改写成"已经搬了"——那是错误记忆。所以：
 *   ① 计划只登记为 upcoming，不覆盖现状；
 *   ② 到期扫描只降级为 lapsed「未确认」，绝不写 past/current；
 *   ③ 唯一的转正通道是证据：用户明确陈述，或定位真的到了目标地；
 *   ④ 没有证据引用（evidenceRef 为空）时 confirmPlan 直接拒绝。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

async function withStore(fn: (store: StructuredFactStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-upcoming-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("计划不改现状：说'下个月搬去成都'后，居住地仍是兴义", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });

    const plan = store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
      eventTime: "下个月",
      confidence: 0.9,
    });

    assert.equal(plan?.ignored, "upcoming");
    assert.equal(plan?.fact.planState, "pending");
    assert.equal(store.getFact("u1", "居住地")?.value, "兴义");

    const block = store.renderForPrompt("u1");
    assert.ok(block);
    assert.ok(block!.includes("〔计划〕成都"));
    assert.ok(block!.includes("尚未发生"));
    // 现状行不能被计划顶替
    assert.ok(block!.includes("- 居住地：兴义"));
  });
});

test("到期无证据：只降级 lapsed'未确认'，绝不写成已发生", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
      confidence: 0.9,
    });

    // 过了计划日（次日）
    const lapsed = store.sweepUpcomingPlans("u1", "2026-11-06T09:00:00.000Z");
    assert.equal(lapsed, 1);

    const plans = store.getPlannedFacts("u1");
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.planState, "lapsed");
    assert.equal(plans[0]!.temporal, "upcoming"); // 没有被改写成 past
    assert.equal(store.getFact("u1", "居住地")?.value, "兴义"); // 现状没动
    assert.equal(store.getPastFacts("u1", "居住地").length, 0); // 没有伪造历史

    const block = store.renderForPrompt("u1");
    assert.ok(block!.includes("〔原计划〕成都"));
    assert.ok(block!.includes("未确认是否发生"));
  });
});

test("生效当天不降级（留一天执行窗口）", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });
    assert.equal(store.sweepUpcomingPlans("u1", "2026-11-05T23:00:00.000Z"), 0);
    assert.equal(store.sweepUpcomingPlans("u1", "2026-11-06T00:30:00.000Z"), 1);
  });
});

test("证据门：用户明确说'我搬过来了'才转现状", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });

    const confirmed = store.confirmPlan("u1", "居住地", {
      became: "current",
      evidenceRef: "user:我已经搬过来了",
      at: "2026-11-07T10:00:00.000Z",
    });

    assert.equal(confirmed?.changed, true);
    assert.equal(store.getFact("u1", "居住地")?.value, "成都");
    // 原计划行留作溯源，状态转为 confirmed_plan
    const plan = store.getPlannedFacts("u1");
    assert.equal(plan.length, 0, "confirmed 计划不再出现在待确认列表");
  });
});

test("证据门：空证据直接拒绝（没有证据不许确认）", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });
    assert.equal(store.confirmPlan("u1", "居住地", { became: "current", evidenceRef: "  " }), null);
    assert.equal(store.getFact("u1", "居住地"), null);
  });
});

test("位置证据：定位到成都才确认，定位仍在兴义则不动", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });

    // 还在兴义 → 不确认
    assert.deepEqual(store.confirmPlansByLocation("u1", "贵州省黔西南州兴义市"), []);
    assert.equal(store.getFact("u1", "居住地")?.value, "兴义");

    // 定位落到成都 → 确认
    const ok = store.confirmPlansByLocation("u1", "四川省成都市武侯区", "2026-11-06T12:00:00.000Z");
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.value, "成都");
    assert.equal(store.getFact("u1", "居住地")?.value, "成都");
  });
});

test("位置证据只对居住地生效（位置证明不了换工作）", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "职业", value: "后端开发", confidence: 0.9 });
    store.applyFact({
      actorId: "u1",
      field: "职业",
      value: "产品经理",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });
    // 即便定位文本里出现"产品经理"这种荒诞输入，也不能确认
    assert.deepEqual(store.confirmPlansByLocation("u1", "产品经理"), []);
    assert.equal(store.getFact("u1", "职业")?.value, "后端开发");
  });
});

test("新计划取代旧计划：同字段只留最新一条待确认", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "成都",
      temporal: "upcoming",
      validFrom: "2026-11-05",
    });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "重庆",
      temporal: "upcoming",
      validFrom: "2026-12-01",
    });

    const plans = store.getPlannedFacts("u1");
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.value, "重庆");
  });
});
