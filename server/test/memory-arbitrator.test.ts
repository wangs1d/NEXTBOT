import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitrateMemories,
  shouldShortCircuitAgentic,
  DEFAULT_ARBITRATOR_CONFIG,
  type ChannelRecallResult,
  type MemoryArbitratorConfig,
} from "../src/brain/memory-arbitrator.js";
import type { MemoryRecallItem } from "../src/brain/types.js";

function makeItem(content: string, score?: number, source?: string): MemoryRecallItem {
  const item: MemoryRecallItem = { content, domain: "semantic" };
  if (score !== undefined) item.score = score;
  if (source) item.source = source;
  return item;
}

// ── 单通道归一化 ─────────────────────────────────────────────

test("arbitrateMemories: 单通道多条目按 score 降序排列", () => {
  const channels: ChannelRecallResult[] = [
    {
      channel: "agentic",
      items: [
        makeItem("记忆A", 0.9),
        makeItem("记忆B", 0.3),
        makeItem("记忆C", 0.6),
      ],
    },
  ];
  const result = arbitrateMemories(channels);
  assert.equal(result.length, 3);
  assert.ok(result[0]!.score! > result[1]!.score!, "第一名分数应高于第二名");
  assert.ok(result[1]!.score! > result[2]!.score!, "第二名分数应高于第三名");
  assert.equal(result[0]!.content, "记忆A", "最高分记忆A应排第一");
});

// ── 跨通道去重 ─────────────────────────────────────────────

test("arbitrateMemories: 跨通道同指纹去重，保留 score 更高者并合并 source", () => {
  const channels: ChannelRecallResult[] = [
    { channel: "agentic", items: [makeItem("用户喜欢素食", 0.5)] },
    { channel: "narrative", items: [makeItem("用户喜欢素食", 0.8)] },
  ];
  const result = arbitrateMemories(channels);
  assert.equal(result.length, 1, "同指纹应去重为一条");
  assert.ok(result[0]!.source!.includes("agentic"), "source 应含 agentic");
  assert.ok(result[0]!.source!.includes("narrative"), "source 应含 narrative");
});

// ── 多通道命中加成 ─────────────────────────────────────────────

test("arbitrateMemories: 多通道命中同一记忆应获得加成分数", () => {
  const single: ChannelRecallResult[] = [
    { channel: "agentic", items: [makeItem("用户住在北京", 0.7)] },
  ];
  const multi: ChannelRecallResult[] = [
    { channel: "agentic", items: [makeItem("用户住在北京", 0.7)] },
    { channel: "narrative", items: [makeItem("用户住在北京", 0.7)] },
  ];
  const singleResult = arbitrateMemories(single);
  const multiResult = arbitrateMemories(multi);
  assert.ok(
    multiResult[0]!.score! > singleResult[0]!.score!,
    "多通道命中应比单通道分数更高（多通道加成）",
  );
});

// ── 通道权重影响排序 ─────────────────────────────────────────────

test("arbitrateMemories: 通道权重影响最终排序（agentic > kvSummary）", () => {
  const channels: ChannelRecallResult[] = [
    { channel: "kvSummary", items: [makeItem("低权重通道记忆", 0.8)] },
    { channel: "agentic", items: [makeItem("高权重通道记忆", 0.8)] },
  ];
  const result = arbitrateMemories(channels);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.content, "高权重通道记忆", "agentic 权重更高应排第一");
});

test("arbitrateMemories: latest_wins 冲突策略优先保留最新表述", () => {
  const oldItem = { ...makeItem("用户住在北京", 0.9), timestamp: "2025-01-01T00:00:00.000Z" };
  const newItem = { ...makeItem("用户住在上海", 0.2), timestamp: "2026-01-01T00:00:00.000Z" };
  const channels: ChannelRecallResult[] = [{ channel: "agentic", items: [oldItem, newItem] }];
  const result = arbitrateMemories(channels, DEFAULT_ARBITRATOR_CONFIG, {
    conflictPolicy: "latest_wins",
  });
  assert.equal(result[0]!.content, "用户住在上海");
});

// ── 关闭仲裁时简单拼接 ─────────────────────────────────────────────

test("arbitrateMemories: enabled=false 时简单拼接，不去重不排序", () => {
  const config: MemoryArbitratorConfig = {
    ...DEFAULT_ARBITRATOR_CONFIG,
    enabled: false,
    topN: 10,
  };
  const channels: ChannelRecallResult[] = [
    { channel: "agentic", items: [makeItem("记忆A", 0.9), makeItem("记忆B", 0.3)] },
    { channel: "narrative", items: [makeItem("记忆A", 0.8)] },
  ];
  const result = arbitrateMemories(channels, config);
  assert.equal(result.length, 3, "关闭仲裁不去重，应保留全部 3 条");
});

// ── minScoreThreshold 过滤 ─────────────────────────────────────────────

test("arbitrateMemories: 低于 minScoreThreshold 的条目被丢弃", () => {
  const config: MemoryArbitratorConfig = {
    ...DEFAULT_ARBITRATOR_CONFIG,
    minScoreThreshold: 0.5,
  };
  const channels: ChannelRecallResult[] = [
    {
      channel: "agentic",
      items: [
        makeItem("高分记忆", 0.9),
        makeItem("低分记忆", 0.1),
      ],
    },
  ];
  const result = arbitrateMemories(channels, config);
  // 单通道归一化：0.9→1.0, 0.1→0.2；加权后 0.2 < 0.5 被丢弃
  assert.equal(result.length, 1, "低分记忆应被过滤");
  assert.equal(result[0]!.content, "高分记忆");
});

// ── topN 截断 ─────────────────────────────────────────────

test("arbitrateMemories: 结果按 topN 截断", () => {
  const config: MemoryArbitratorConfig = {
    ...DEFAULT_ARBITRATOR_CONFIG,
    topN: 2,
  };
  const channels: ChannelRecallResult[] = [
    {
      channel: "agentic",
      items: [
        makeItem("记忆1", 0.9),
        makeItem("记忆2", 0.7),
        makeItem("记忆3", 0.5),
        makeItem("记忆4", 0.3),
      ],
    },
  ];
  const result = arbitrateMemories(channels, config);
  assert.equal(result.length, 2, "应截断为 topN=2");
});

// ── 短路判断 ─────────────────────────────────────────────

test("shouldShortCircuitAgentic: 充足且高分时短路", () => {
  const items = [
    makeItem("记忆1", 0.8),
    makeItem("记忆2", 0.7),
    makeItem("记忆3", 0.6),
  ];
  assert.equal(shouldShortCircuitAgentic(items, { minCount: 3, minTopScore: 0.6 }), true);
});

test("shouldShortCircuitAgentic: 条目不足时不短路", () => {
  const items = [makeItem("记忆1", 0.9)];
  assert.equal(shouldShortCircuitAgentic(items, { minCount: 3, minTopScore: 0.6 }), false);
});

test("shouldShortCircuitAgentic: top1 分数不足时不短路", () => {
  const items = [
    makeItem("记忆1", 0.4),
    makeItem("记忆2", 0.3),
    makeItem("记忆3", 0.2),
  ];
  assert.equal(shouldShortCircuitAgentic(items, { minCount: 3, minTopScore: 0.6 }), false);
});

// ── 空输入降级 ─────────────────────────────────────────────

test("arbitrateMemories: 空通道返回空数组", () => {
  assert.equal(arbitrateMemories([]).length, 0);
});

test("arbitrateMemories: 通道内空 items 返回空数组", () => {
  const channels: ChannelRecallResult[] = [
    { channel: "agentic", items: [] },
    { channel: "narrative", items: [] },
  ];
  assert.equal(arbitrateMemories(channels).length, 0);
});

// ── score 缺失时赋默认值 ─────────────────────────────────────────────

test("arbitrateMemories: score 缺失的条目用默认分兜底，不被归一化为 0", () => {
  const channels: ChannelRecallResult[] = [
    {
      channel: "kvSummary",
      items: [makeItem("无分数的KV摘要")], // 无 score
    },
  ];
  const result = arbitrateMemories(channels);
  assert.equal(result.length, 1);
  assert.ok(result[0]!.score! > 0, "无 score 条目应有正分兜底，不应归一化为 0");
});
