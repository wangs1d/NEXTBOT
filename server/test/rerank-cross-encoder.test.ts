/**
 * Cross-encoder 精排（2026-10-19 P1，默认关闭）。
 *
 * 只锁纯逻辑与降级契约：分数解析、稳定重排、失败原样返回。
 * 网络调用在测试里用 fake client 代替，不触网。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRerankScores,
  buildRerankPrompt,
  getRerankMode,
  isCrossEncoderRerankEnabled,
  parseRerankScores,
  rerankCandidates,
  shouldRerankAdaptive,
  type RerankLlmClient,
} from "../src/agentic-memory/rerank-cross-encoder.js";

const items = [
  { id: "a", text: "用户喜欢喝咖啡" },
  { id: "b", text: "用户住在兴义" },
  { id: "c", text: "用户养了一只猫" },
];

test("prompt 构造：带 query 与编号候选", () => {
  const msgs = buildRerankPrompt("我住哪", items);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[1]!.role, "user");
  const payload = JSON.parse(msgs[1]!.content);
  assert.equal(payload.query, "我住哪");
  assert.equal(payload.candidates.length, 3);
  assert.equal(payload.candidates[1].n, 1);
});

test("分数解析：容忍围栏与脏项，越界/非数字丢弃", () => {
  const ok = parseRerankScores(
    '```json\n{"scores":[{"n":0,"score":3},{"n":1,"score":9},{"n":5,"score":10},{"n":2,"score":"x"}]}\n```',
    3,
  );
  assert.equal(ok.get(0), 3);
  assert.equal(ok.get(1), 9);
  assert.equal(ok.has(5), false, "越界丢弃");
  assert.equal(ok.has(2), false, "非数字丢弃");
  assert.equal(parseRerankScores("完全不是 JSON", 3).size, 0);
});

test("重排：已评分按分降序，未评分保持原序排后（不丢条目）", () => {
  const scores = new Map<number, number>([
    [0, 2],
    [1, 8],
  ]);
  const out = applyRerankScores(items, scores);
  assert.deepEqual(
    out.map((i) => i.id),
    ["b", "a", "c"],
  );
  assert.deepEqual(applyRerankScores(items, new Map()).map((i) => i.id), ["a", "b", "c"]);
});

test("rerankCandidates：正常打分后重排；失败原样返回", async () => {
  const good: RerankLlmClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scores: [
                    { n: 0, score: 1 },
                    { n: 1, score: 9 },
                    { n: 2, score: 4 },
                  ],
                }),
              },
            },
          ],
        }),
      },
    },
  };
  const reordered = await rerankCandidates("我住哪", items, {
    client: good,
    model: "fake",
  });
  assert.deepEqual(
    reordered.map((i) => i.id),
    ["b", "c", "a"],
  );

  const broken: RerankLlmClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error("network down");
        },
      },
    },
  };
  const fallback = await rerankCandidates("我住哪", items, { client: broken, model: "fake" });
  assert.deepEqual(
    fallback.map((i) => i.id),
    ["a", "b", "c"],
    "失败时必须原序返回，不影响主链路",
  );
});

test("开关默认关闭（热路径多一次 LLM 调用必须显式开启）", () => {
  const saved = process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
  delete process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
  try {
    assert.equal(isCrossEncoderRerankEnabled(), false);
    process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK = "1";
    assert.equal(isCrossEncoderRerankEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
    else process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK = saved;
  }
});

// ── 自适应门控：快慢结合的关键（只在模糊时精排）──

test("模式解析：off/always/adaptive + 旧开关兼容", () => {
  const prevMode = process.env.AGENT_MEMORY_RERANK_MODE;
  const prevLegacy = process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
  try {
    delete process.env.AGENT_MEMORY_RERANK_MODE;
    delete process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
    assert.equal(getRerankMode(), "off", "默认关闭");

    process.env.AGENT_MEMORY_RERANK_MODE = "adaptive";
    assert.equal(getRerankMode(), "adaptive");

    process.env.AGENT_MEMORY_RERANK_MODE = "always";
    assert.equal(getRerankMode(), "always");

    delete process.env.AGENT_MEMORY_RERANK_MODE;
    process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK = "1";
    assert.equal(getRerankMode(), "always", "旧开关等价 always");
  } finally {
    if (prevMode === undefined) delete process.env.AGENT_MEMORY_RERANK_MODE;
    else process.env.AGENT_MEMORY_RERANK_MODE = prevMode;
    if (prevLegacy === undefined) delete process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK;
    else process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK = prevLegacy;
  }
});

test("自适应门控：头部咬得紧才精排，领先明显就跳过", () => {
  // 明显领先（0.9 vs 0.4）→ 不浪费一次调用
  assert.equal(shouldRerankAdaptive([0.9, 0.4, 0.3]), false);
  // 咬得很紧（0.62 vs 0.6，差 3%）→ 排序不可靠，精排
  assert.equal(shouldRerankAdaptive([0.62, 0.6, 0.55]), true);
  // 整体分很低（召回虚弱）→ 精排救一下
  assert.equal(shouldRerankAdaptive([0.25, 0.05]), true);
  // 候选不足（没有排序问题）→ 不排
  assert.equal(shouldRerankAdaptive([0.8]), false);
  assert.equal(shouldRerankAdaptive([]), false);
  // 非法分不算数
  assert.equal(shouldRerankAdaptive([Number.NaN, 0]), false);
});
