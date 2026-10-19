/**
 * 时序记忆基准（2026-10-19，P2 工程债补齐）。
 *
 * 之前的 golden set 只有 8 条语义召回 query，没有时间维度——本轮「时间认知」
 * 改造无法量化。这里补一套**确定性**时序评测：不依赖 LLM、不依赖向量库，
 * 直接打结构化事实库的读写语义，覆盖 6 类真实失败模式：
 *
 *   current    : 问现状，必须给当前值
 *   past       : 问过去，必须给当时的值（不能被现状污染）
 *   as-of      : 定点历史，必须给那个时间点有效的值
 *   plan       : 计划不能被当成现状
 *   lapse      : 到期无证据只能"未确认"，不能断言发生
 *   evidence   : 有证据（陈述/位置）才能转正
 *   conflict   : 置信度闸 / 新计划取代旧计划
 *
 * 指标：用例通过率（exact match）。基准本身就是回归网——任何一条挂了都说明
 * 时态语义被改坏。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

type Case = {
  /** 失败模式分类 */
  kind: "current" | "past" | "as-of" | "plan" | "lapse" | "evidence" | "conflict";
  name: string;
  setup: (store: StructuredFactStore) => void;
  /** 返回被测系统对某个问题的答案（null = 无法回答） */
  answer: (store: StructuredFactStore) => string | null;
  expect: string | null;
};

const A = "bench-user";

const cases: Case[] = [
  {
    kind: "current",
    name: "只说过现状 → 问现状给现状",
    setup: (s) => s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 }),
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "past",
    name: "说过过去也说过现状 → 问过去给过去（不被现状污染）",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "杭州", temporal: "past", eventTime: "2019-2023" });
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
    },
    answer: (s) => s.getPastFacts(A, "居住地")[0]?.value ?? null,
    expect: "杭州",
  },
  {
    kind: "past",
    name: "过去时态不改现状（说'我以前住浙江'后现状仍是兴义）",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "浙江", temporal: "past" });
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "as-of",
    name: "点位查询 2021-06：杭州",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "杭州", temporal: "past", eventTime: "2019-2023" });
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", validFrom: "2024-01-01", confidence: 0.9 });
    },
    answer: (s) => s.getFactsAsOf(A, "2021-06-15")[0]?.value ?? null,
    expect: "杭州",
  },
  {
    kind: "as-of",
    name: "点位查询 2026-10：兴义",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "杭州", temporal: "past", eventTime: "2019-2023" });
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", validFrom: "2024-01-01", confidence: 0.9 });
    },
    answer: (s) => s.getFactsAsOf(A, "2026-10-19")[0]?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "as-of",
    name: "点位查询早于任何记录：不猜",
    setup: (s) => s.applyFact({ actorId: A, field: "居住地", value: "兴义", validFrom: "2024-01-01" }),
    answer: (s) => s.getFactsAsOf(A, "2010-01-01")[0]?.value ?? null,
    expect: null,
  },
  {
    kind: "plan",
    name: "计划不能当成现状",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "lapse",
    name: "计划到期无证据：不改写成已发生",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.sweepUpcomingPlans(A, "2026-12-01T00:00:00.000Z");
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "lapse",
    name: "计划到期无证据：不伪造历史（过去住哪不含成都）",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.sweepUpcomingPlans(A, "2026-12-01T00:00:00.000Z");
    },
    answer: (s) => s.getPastFacts(A, "居住地")[0]?.value ?? null,
    expect: null,
  },
  {
    kind: "lapse",
    name: "计划到期：状态标记为未确认",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.sweepUpcomingPlans(A, "2026-12-01T00:00:00.000Z");
    },
    answer: (s) => s.getPlannedFacts(A)[0]?.planState ?? null,
    expect: "lapsed",
  },
  {
    kind: "evidence",
    name: "用户明确陈述 → 计划转现状",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.confirmPlan(A, "居住地", { became: "current", evidenceRef: "user:我搬过来了", at: "2026-11-07T00:00:00.000Z" });
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "成都",
  },
  {
    kind: "evidence",
    name: "定位到目标城市 → 计划转现状",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.confirmPlansByLocation(A, "四川省成都市武侯区", "2026-11-06T00:00:00.000Z");
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "成都",
  },
  {
    kind: "evidence",
    name: "定位仍在原城市 → 计划不动",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.confirmPlansByLocation(A, "贵州省黔西南州兴义市", "2026-11-06T00:00:00.000Z");
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: "兴义",
  },
  {
    kind: "evidence",
    name: "无证据不许确认（空 evidenceRef）",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.confirmPlan(A, "居住地", { became: "current", evidenceRef: "" });
    },
    answer: (s) => s.getFact(A, "居住地")?.value ?? null,
    expect: null,
  },
  {
    kind: "conflict",
    name: "低置信新值不推翻已确认现状",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "职业", value: "全栈开发", confidence: 0.95 });
      s.applyFact({ actorId: A, field: "职业", value: "产品经理", confidence: 0.4 });
    },
    answer: (s) => s.getFact(A, "职业")?.value ?? null,
    expect: "全栈开发",
  },
  {
    kind: "conflict",
    name: "同量级更正仍然生效（闸不挡正常改口）",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "职业", value: "全栈开发", confidence: 0.95 });
      s.applyFact({ actorId: A, field: "职业", value: "产品经理", confidence: 0.85 });
    },
    answer: (s) => s.getFact(A, "职业")?.value ?? null,
    expect: "产品经理",
  },
  {
    kind: "conflict",
    name: "新计划取代旧计划",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "居住地", value: "成都", temporal: "upcoming", validFrom: "2026-11-05" });
      s.applyFact({ actorId: A, field: "居住地", value: "重庆", temporal: "upcoming", validFrom: "2026-12-01" });
    },
    answer: (s) => s.getPlannedFacts(A)[0]?.value ?? null,
    expect: "重庆",
  },
  {
    kind: "current",
    name: "同值重复确认不产生新行",
    setup: (s) => {
      s.applyFact({ actorId: A, field: "称呼", value: "王哥", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "称呼", value: "王哥", confidence: 0.9 });
      s.applyFact({ actorId: A, field: "称呼", value: "王哥", confidence: 0.9 });
    },
    answer: (s) => String(s.getActiveFacts(A).length),
    expect: "1",
  },
  {
    kind: "as-of",
    name: "knowledge-as-of：事后才知道的旧事，当时'不知道'",
    setup: (s) => {
      s.applyFact({
        actorId: A,
        field: "居住地",
        value: "杭州",
        temporal: "past",
        eventTime: "2019-2023",
        observedAt: "2024-03-01T00:00:00.000Z",
      });
    },
    answer: (s) => s.getKnownFactsAsOf(A, "2021-06-01")[0]?.value ?? null,
    expect: null,
  },
  {
    kind: "as-of",
    name: "valid time 与 knowledge time 的分叉：同一时点两个答案",
    setup: (s) => {
      s.applyFact({
        actorId: A,
        field: "居住地",
        value: "杭州",
        temporal: "past",
        eventTime: "2019-2023",
        observedAt: "2024-03-01T00:00:00.000Z",
      });
      s.applyFact({ actorId: A, field: "居住地", value: "兴义", validFrom: "2024-01-01", observedAt: "2024-03-01T00:00:00.000Z" });
    },
    answer: (s) => s.getFactsAsOf(A, "2021-06-01")[0]?.value ?? null,
    expect: "杭州",
  },
];

test(`时序记忆基准：${cases.length} 例，6 类失败模式全覆盖`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-temporal-bench-"));
  const failures: string[] = [];
  const byKind = new Map<string, { pass: number; total: number }>();

  try {
    for (const c of cases) {
      const dbPath = join(dir, `${c.kind}-${Math.random().toString(36).slice(2, 8)}.db`);
      const store = new StructuredFactStore(openAgenticSqlite(dbPath));
      let actual: string | null = null;
      try {
        c.setup(store);
        actual = c.answer(store);
      } finally {
        store.close();
      }
      const ok = actual === c.expect;
      const bucket = byKind.get(c.kind) ?? { pass: 0, total: 0 };
      bucket.total += 1;
      if (ok) bucket.pass += 1;
      byKind.set(c.kind, bucket);
      if (!ok) failures.push(`[${c.kind}] ${c.name}：期望 ${String(c.expect)}，实际 ${String(actual)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  const total = cases.length;
  const passed = total - failures.length;
  const lines = [...byKind.entries()]
    .map(([k, v]) => `${k}=${v.pass}/${v.total}`)
    .join("  ");
  console.info(`\n[时序基准] 通过 ${passed}/${total}（${((passed / total) * 100).toFixed(1)}%）  ${lines}\n`);

  assert.deepEqual(failures, [], `时序基准未全绿：\n${failures.join("\n")}`);
});
