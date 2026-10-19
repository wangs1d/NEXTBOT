/**
 * 事实变更 → 向量层即时退役（2026-10-19）。
 *
 * 契约：
 *   ① metadata.factFields 命中同字段 → 归档（写入时打的精确标签）；
 *   ② 无标签的存量短句，靠字段线索词/自称+已知旧值识别 → 归档；
 *   ③ 长段落、含新值的混写条目 → 不归档（交给 LLM 审查，宁保留不误删）；
 *   ④ 没有归档能力时不删任何东西（跳过）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { retireMemoriesForFactChange } from "../src/agentic-memory/fact-supersede.js";

interface FakeHit {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
}

function fakeMemory(hits: FakeHit[]): { search: () => Promise<{ results: FakeHit[] }> } {
  return { search: async () => ({ results: hits }) };
}

function fakeReinforcement(): {
  archiveIds: (ids: string[], actorId: string) => number;
  archived: string[];
} {
  const archived: string[] = [];
  return {
    archived,
    archiveIds: (ids: string[]) => {
      archived.push(...ids);
      return ids.length;
    },
  };
}

const base = {
  actorId: "u1",
  field: "居住地",
  newValue: "兴义",
  previousValues: ["杭州"],
};

test("按 factFields 标签精确归档旧居住地记忆", async () => {
  const memory = fakeMemory([
    { id: "m1", memory: "用户在杭州做后端开发", metadata: { factFields: "居住地" } },
    { id: "m2", memory: "用户喜欢喝咖啡", metadata: { factFields: "" } },
  ]);
  const enforcement = fakeReinforcement();

  const result = await retireMemoriesForFactChange({
    ...base,
    memory,
    reinforcement: enforcement,
  });

  assert.deepEqual(result.archived, ["m1"]);
  assert.deepEqual(enforcement.archived, ["m1"]);
});

test("无标签存量短句：字段线索词命中才归档", async () => {
  const memory = fakeMemory([
    { id: "m1", memory: "我住在杭州" },
    { id: "m2", memory: "去年去杭州出差了三天" }, // 无居住线索，不该动
  ]);
  const enforcement = fakeReinforcement();

  const result = await retireMemoriesForFactChange({
    ...base,
    memory,
    reinforcement: enforcement,
  });

  assert.deepEqual(result.archived, ["m1"]);
});

test("含新值的混写条目不归档（交给 LLM 审查）", async () => {
  const memory = fakeMemory([
    { id: "m1", memory: "用户以前住在杭州，现在搬来兴义了", metadata: { factFields: "居住地" } },
  ]);
  const enforcement = fakeReinforcement();

  const result = await retireMemoriesForFactChange({
    ...base,
    memory,
    reinforcement: enforcement,
  });

  assert.deepEqual(result.archived, []);
  assert.equal(enforcement.archived.length, 0);
});

test("长段落/别的字段标签都不动", async () => {
  const memory = fakeMemory([
    // 长句：即便提到"住在杭州"也不当副本（可能承载其它信息）
    {
      id: "long",
      memory:
        "用户在杭州的时候住在西湖区，每天早上会沿湖跑步，那段时间他刚开始做后端开发，经常加班到很晚，后来因为家庭原因搬走了。",
    },
    { id: "other", memory: "用户的全栈开发工作很忙", metadata: { factFields: "职业" } },
  ]);
  const enforcement = fakeReinforcement();

  const result = await retireMemoriesForFactChange({
    ...base,
    memory,
    reinforcement: enforcement,
  });

  assert.deepEqual(result.archived, []);
});

test("没有归档能力时不删任何东西（跳过而非物理删除）", async () => {
  const memory = fakeMemory([{ id: "m1", memory: "我住在杭州", metadata: { factFields: "居住地" } }]);

  const result = await retireMemoriesForFactChange({
    ...base,
    memory,
    reinforcement: null,
  });

  assert.equal(result.skipped, "no_reinforcement");
  assert.deepEqual(result.archived, []);
});

test("没有旧值可判（newValue 与 previous 相同）时直接跳过，不误扫", async () => {
  const memory = fakeMemory([{ id: "m1", memory: "我住在兴义", metadata: { factFields: "居住地" } }]);
  const enforcement = fakeReinforcement();

  const result = await retireMemoriesForFactChange({
    ...base,
    previousValues: ["兴义"],
    memory,
    reinforcement: enforcement,
  });

  assert.equal(result.skipped, "no_previous");
  assert.deepEqual(enforcement.archived, []);
});
