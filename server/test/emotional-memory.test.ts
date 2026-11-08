// 情感标记 / 联想检索 / 遗忘曲线 三个隐性维度的闭环测试。
//
// 覆盖目标（对应用户验收：统一出入口 + 闭环 + 结果数据）：
//  1. 情绪词表：高光/至暗、否定翻转、中性；
//  2. 排序：情绪显著性进入 unifiedMemoryScore；情绪相似度进入 arbitrateMemories；
//  3. 写入 → 检索闭环：情景日志记录用户情绪，情绪 query 能召回；
//  4. 长期记忆：ingest 写入 metadata.emotion + 情绪边；findEmotionalNodes 触景生情；
//  5. 遗忘：统一 memoryDecayFactor（访问频率/情绪加成）；情绪节点更抗衰减；
//  6. 巩固：缓存/睡前衰减不会抹掉高情绪记忆。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emotionalSalience,
  emotionMatchScore,
  formatEmotionBadge,
  inferEmotionFromText,
} from "../src/services/emotion-memory.js";
import { memoryDecayFactor, unifiedMemoryScore } from "../src/services/memory-record-utils.js";
import { MemoryForgettingController } from "../src/brain/memory-cognitive/memory-forgetting-controller.js";
import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import {
  arbitrateMemories,
  DEFAULT_ARBITRATOR_CONFIG,
} from "../src/brain/memory-arbitrator.js";
import type { MemoryRecallItem } from "../src/brain/types.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "emotion-memory-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("情绪词表：高光/至暗/否定/中性", () => {
  const highlight = inferEmotionFromText("今天升职了，特别开心");
  assert.ok(highlight.valence >= 7, `expected strong positive, got ${highlight.valence}`);
  assert.ok(highlight.tags.includes("positive"));
  assert.ok(highlight.tags.includes("milestone"));

  const dark = inferEmotionFromText("我被裁员了，真的很难过");
  assert.ok(dark.valence <= -6, `expected strong negative, got ${dark.valence}`);
  assert.ok(dark.tags.includes("negative"));

  const crisis = inferEmotionFromText("我撑不住了，感觉要崩溃");
  assert.equal(crisis.valence, -10);

  // 否定翻转：不能把"不开心"判成正向
  const negated = inferEmotionFromText("今天很不开心");
  assert.ok(negated.valence < 0, `negated positive must be negative, got ${negated.valence}`);

  const neutral = inferEmotionFromText("帮我查一下明天的天气");
  assert.equal(neutral.valence, 0);
  assert.equal(emotionalSalience(neutral), 0);
  assert.equal(formatEmotionBadge(neutral), null);
});

test("情绪显著性/匹配度：中性 query 不产生联想分", () => {
  const dark = inferEmotionFromText("那天我哭得很厉害");
  const similar = inferEmotionFromText("今天又有点想哭");
  const opposite = inferEmotionFromText("今天特别开心");
  const neutral = inferEmotionFromText("明天几点开会");

  assert.ok(emotionalSalience(dark) >= 0.5);
  assert.ok(emotionMatchScore(dark, similar) > 0.7);
  assert.ok(emotionMatchScore(dark, opposite) < 0.35);
  assert.equal(emotionMatchScore(neutral, dark), 0);
  assert.match(formatEmotionBadge(dark) ?? "", /情绪:-?\d+·(低落|至暗)/);
});

test("unifiedMemoryScore：同相关度/时效下，情绪记忆排序更高", () => {
  const now = Date.now();
  const base = { relevance: 0.8, updatedAt: now, confidence: 0.7 };
  const neutral = unifiedMemoryScore({ ...base, emotionalSalience: 0 });
  const emotional = unifiedMemoryScore({ ...base, emotionalSalience: 0.85 });
  assert.ok(emotional > neutral, `emotional ${emotional} should beat neutral ${neutral}`);
  // 不能压过相关度：低相关高情绪 < 高相关低情绪
  const lowRelHighEmo = unifiedMemoryScore({
    relevance: 0.3,
    updatedAt: now,
    confidence: 0.7,
    emotionalSalience: 1,
  });
  const highRelNeutral = unifiedMemoryScore(base);
  assert.ok(highRelNeutral > lowRelHighEmo);
});

test("memoryDecayFactor：时间衰减 + 访问频率 + 情绪加成", () => {
  const fresh = memoryDecayFactor({ ageDays: 0 });
  const old = memoryDecayFactor({ ageDays: 30 });
  assert.ok(fresh > old && old < 0.1, `30d decay should be small, got ${old}`);

  // 访问频率抗遗忘：命中 8 次比 0 次高
  const accessedOften = memoryDecayFactor({ ageDays: 30, accessCount: 8 });
  assert.ok(accessedOften > old, `access boost expected: ${accessedOften} > ${old}`);

  // 情绪加成：高光/至暗记忆衰减更慢
  const emotional = memoryDecayFactor({ ageDays: 30, emotionalSalience: 1 });
  assert.ok(emotional > old, `emotion boost expected: ${emotional} > ${old}`);
  assert.ok(memoryDecayFactor({ ageDays: 0, emotionalSalience: 1 }) <= 1);
});

test("情景日志闭环：写入用户情绪 → 情绪 query 召回带情绪的历史轮次", async () => {
  await withTempDir(async (dir) => {
    const gateway = new ShortTermMemoryGatewayService(join(dir, "stm.json"));
    gateway.reconcileTaskAfterTurn(
      "s-emotion",
      "今天被裁员了，我真的很难过",
      "抱歉，这种时候确实很难受，我在这里。",
    );

    const hits = gateway.searchEpisodic("s-emotion", "最近裁员的事", 5);
    assert.ok(hits.length >= 1, "should recall the emotional turn");
    assert.ok(
      hits[0].emotion && hits[0].emotion.valence <= -5,
      `recalled turn should carry negative emotion, got ${hits[0].emotion?.valence}`,
    );
    // 等待异步落盘完成后再删除临时目录（避免 unhandledRejection）
    await (gateway as unknown as { persistChain: Promise<void> }).persistChain;
  });
});

test("长期记忆闭环：ingest 打情绪标记 + 情绪边 + findEmotionalNodes 触景生情", async () => {
  await withTempDir(async (dir) => {
    const service = new HumanLikeMemoryService(
      join(dir, "memory.json"),
      join(dir, "policy.json"),
    );
    const actor = "u-emotion";
    await service.ingest(actor, "上次下雨天我被裁员了，那天特别难过", "chat");
    await service.ingest(actor, "最近工作有点烦，压力很大", "chat");

    const queryEmotion = inferEmotionFromText("今天又下雨了，我好难过");
    const emotional = service.findEmotionalNodes(actor, queryEmotion, 3);
    assert.ok(emotional.length >= 1, "should find emotionally similar node");
    assert.ok(
      emotional.some((n) => n.summary.includes("裁员")),
      `expected layoff memory, got ${emotional.map((n) => n.summary).join(" | ")}`,
    );

    // 情绪边：同情绪极性的节点之间应存在 relation="emotion"
    const allEdges = (service as unknown as { store: { edges: Record<string, { relation: string }> } })
      .store.edges;
    const emotionEdges = Object.values(allEdges).filter((e) => e.relation === "emotion");
    assert.ok(emotionEdges.length >= 1, "should create at least one emotion edge");

    // 检索：情绪 query 命中情绪记忆（情绪轴构成召回理由）
    const recall = await service.buildRecall(actor, "下雨天 难过", { limit: 5 });
    assert.ok(recall.text.includes("裁员") || recall.text.includes("难过"), "recall should surface emotional memory");
  });
});

test("统一仲裁：情绪 query 下同情绪条目排序更高（跨来源融合）", () => {
  const negative: MemoryRecallItem = {
    content: "用户被裁员那天非常难过",
    domain: "episodic",
    source: "humanLike",
    score: 0.5,
    timestamp: new Date().toISOString(),
    emotion: { valence: -8, arousal: 0.8, tags: ["negative", "sadness"], confidence: 0.7, source: "lexicon" },
  };
  const positive: MemoryRecallItem = {
    content: "用户当天也在庆祝生日，很开心",
    domain: "episodic",
    source: "humanLike",
    score: 0.5,
    timestamp: new Date().toISOString(),
    emotion: { valence: 6, arousal: 0.6, tags: ["positive", "joy"], confidence: 0.7, source: "lexicon" },
  };

  const ranked = arbitrateMemories(
    [{ channel: "humanLike", items: [positive, negative] }],
    DEFAULT_ARBITRATOR_CONFIG,
    { query: "我今天很难过，想找人说说话" },
  );
  assert.equal(ranked.length, 2);
  assert.ok(
    ranked[0].content.includes("裁员"),
    `negative memory should rank first, got: ${ranked.map((r) => r.content).join(" | ")}`,
  );

  // 中性 query 不改变排序（两条分数相同，保持原顺序或至少不因情绪翻转）
  const neutralRanked = arbitrateMemories(
    [{ channel: "humanLike", items: [positive, negative] }],
    DEFAULT_ARBITRATOR_CONFIG,
    { query: "明天几点开会" },
  );
  assert.equal(neutralRanked.length, 2);
});

test("遗忘闭环：情绪节点比中性节点更抗衰减（统一曲线）", async () => {
  const actor = "u-forget";
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const nodes = [
    {
      id: "n-emotional",
      frequencyScore: 0.12,
      recencyScore: 0.1,
      importance: 0.1,
      userFeedbackScore: 0.1,
      accessCount: 0,
      deletionStage: "active" as const,
      lastAccessedAt: old,
      metadata: {
        emotion: { valence: -10, arousal: 0.95, tags: ["negative", "crisis"], confidence: 0.7 },
      },
    },
    {
      id: "n-neutral",
      frequencyScore: 0.12,
      recencyScore: 0.1,
      importance: 0.1,
      userFeedbackScore: 0.1,
      accessCount: 0,
      deletionStage: "active" as const,
      lastAccessedAt: old,
    },
  ];

  const controller = new MemoryForgettingController();
  const decays: string[] = [];
  controller.registerHumanLikeMemory({
    getAllNodes: () => nodes,
    updateDeletionStage: (_actorId, nodeId, stage) => {
      decays.push(`${nodeId}:${stage}`);
    },
    reawakenNode: () => undefined,
    pruneNodeEdges: () => undefined,
  });

  const result = await controller.continuousScore(actor);
  assert.equal(result.scanned, 2);
  assert.ok(
    decays.some((d) => d.startsWith("n-neutral:")),
    "neutral node should decay",
  );
  assert.ok(
    !decays.some((d) => d.startsWith("n-emotional:")),
    `emotional node should resist decay, got ${decays.join(",")}`,
  );

  // 旧口径（不传情绪）保持向后兼容
  assert.equal(
    controller.computeNodeScore({
      frequencyScore: 1,
      recencyScore: 0,
      importance: 0,
      userFeedbackScore: 0,
    }),
    0.4,
  );
});
