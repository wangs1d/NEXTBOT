/**
 * 经历沉淀（episodic → semantic）单测。
 *
 * 契约：只有「用户明确说过的话」能沉淀成长期事实——
 *   自称/显式偏好：单次即可；行为重复：跨 ≥2 个不同日期；
 *   一次性提醒、动作指令、口头禅：一律不落库。
 * 写入走长尾事实（applyFact），同义改写被覆盖判定/写入口去重吸收。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  classifySedimentEpisodes,
  extractEpisodeRequest,
  sedimentEpisodesToFacts,
  type SedimentEpisodeRow,
} from "../src/services/nightly-memory-task-service.js";

const ACTOR = "sediment-test@example.com";
const WRITER = "NightlyMemoryTaskService";

function ep(id: string, observation: string, createdAt: string): SedimentEpisodeRow {
  return { id, observation, sourceKind: "experience", createdAt };
}

function day(offset: number): string {
  return new Date(Date.now() - offset * 86_400_000).toISOString();
}

async function withStore(fn: (store: StructuredFactStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sediment-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("片段请求提取：工具轨迹取 userRequest，事件行剥路由后缀", () => {
  assert.equal(
    extractEpisodeRequest('Tool interaction succeeded. userRequest="我老婆是刘浩存" tools="search_web"'),
    "我老婆是刘浩存",
  );
  assert.equal(extractEpisodeRequest("用户问：来几张性感一点的（路由：direct）"), "来几张性感一点的");
  assert.equal(extractEpisodeRequest("Tool interaction failed. tools=\"x\""), "");
});

test("闸门：自称/偏好收，一次性提醒与口头禅不收", () => {
  const decisions = classifySedimentEpisodes([
    ep("e1", 'Tool interaction succeeded. userRequest="我老婆是刘浩存" tools="search_web"', day(2)),
    ep("e2", "用户问：一分钟后提醒我洗漱（路由：direct）", day(2)),
    ep("e3", "用户问：小弟（路由：direct）", day(3)),
    ep("e4", "用户问：帮我比价这个商品：红牛（路由：direct）", day(3)),
    ep("e5", "用户问：好像去旅游啊（路由：direct）", day(4)),
  ]);
  const byCore = new Map(decisions.map((d) => [d.core, d]));

  assert.equal(byCore.get("我老婆是刘浩存")?.reason, "declaration");
  assert.equal(byCore.get("一分钟后提醒我洗漱")?.reason, "one_shot");
  assert.equal(byCore.get("小弟")?.reason, "noise");
  assert.equal(byCore.get("帮我比价这个商品：红牛")?.reason, "instruction");
  assert.equal(byCore.get("好像去旅游啊")?.reason, "insufficient_evidence");

  const accepted = decisions.filter((d) => d.accepted);
  assert.equal(accepted.length, 1);
});

test("跨日重复才沉淀；同日重复不算", () => {
  const sameDay = classifySedimentEpisodes([
    ep("a1", "用户问：周末想去三亚玩（路由：direct）", day(1)),
    ep("a2", "用户问：周末想去三亚玩（路由：direct）", day(1)),
  ]);
  assert.equal(sameDay.find((d) => d.core.includes("三亚"))?.reason, "insufficient_evidence");

  const crossDay = classifySedimentEpisodes([
    ep("b1", "用户问：周末想去三亚玩（路由：direct）", day(3)),
    ep("b2", "用户问：周末想去三亚玩（路由：direct）", day(1)),
  ]);
  const recurrent = crossDay.find((d) => d.core.includes("三亚"));
  assert.equal(recurrent?.reason, "recurrence");
  assert.deepEqual(recurrent?.days.length, 2);
});

test("落库幂等：写入一次，再次沉淀只做覆盖判定", async () => {
  await withStore(async (store) => {
    const episodes: SedimentEpisodeRow[] = [
      ep("c1", 'Tool interaction succeeded. userRequest="我老婆是刘浩存" tools="search_web"', day(2)),
      ep("c2", "用户问：周末想去三亚玩（路由：direct）", day(3)),
      ep("c3", "用户问：周末想去三亚玩（路由：direct）", day(1)),
      ep("c4", "用户问：一分钟后提醒我洗漱（路由：direct）", day(2)),
    ];

    const first = sedimentEpisodesToFacts(store, ACTOR, episodes, WRITER);
    assert.equal(first.applied, 2);
    assert.equal(first.rejected, 1);

    const values = store.getTailFacts(ACTOR).map((f) => f.value);
    assert.ok(values.some((v) => v.includes("我老婆是刘浩存")));
    assert.ok(
      values.includes("周末想去三亚玩"),
      "沉淀值 = 用户原话本身，与夜间抽取同形态（两种写法各存一份才是重复的来源）",
    );
    assert.ok(!values.some((v) => v.startsWith("用户说过")), "不再包一层前缀");
    assert.ok(!values.some((v) => v.includes("提醒我洗漱")));

    const second = sedimentEpisodesToFacts(store, ACTOR, episodes, WRITER);
    assert.equal(second.applied, 0);
    assert.equal(second.covered, 2);
  });
});

test("沉淀事实可被长尾召回命中", async () => {
  await withStore(async (store) => {
    sedimentEpisodesToFacts(
      store,
      ACTOR,
      [
        ep("d1", 'Tool interaction succeeded. userRequest="我老婆是刘浩存" tools="search_web"', day(2)),
        ep("d2", "用户问：周末想去三亚玩（路由：direct）", day(3)),
        ep("d3", "用户问：周末想去三亚玩（路由：direct）", day(1)),
      ],
      WRITER,
    );

    const block = store.renderTailRecallBlock(ACTOR, "我老婆是谁来着");
    assert.ok(block?.includes("刘浩存"));

    const travel = store.renderTailRecallBlock(ACTOR, "周末去三亚玩的事");
    assert.ok(travel?.includes("三亚"));
  });
});
