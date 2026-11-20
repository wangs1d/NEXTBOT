import test from "node:test";
import assert from "node:assert/strict";

import { MemoryCortex } from "../src/brain/memory-cortex.js";
import { BrainCenter } from "../src/brain/brain-center.js";
import { MemoryExperienceLearningLoop } from "../src/brain/memory-cognitive/memory-experience-learning-loop.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import type { MemoryItem } from "../src/brain/types.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    actorId: "test-user",
    kind: "experience",
    content: "用户反馈登录流程失败，需要改进重试策略",
    importance: "high",
    source: "chat",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTool(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
    },
  };
}

test("experience loop can form a belief and update it with feedback", () => {
  const loop = new MemoryExperienceLearningLoop();
  const episode = loop.observeMemoryItem("test-user", makeItem());

  assert.ok(episode);
  const snapshot = loop.getSnapshot("test-user");
  assert.equal(snapshot.episodes.length, 1);
  assert.equal(snapshot.beliefs.length, 1);
  assert.equal(snapshot.beliefs[0].status, "active");

  const updated = loop.recordFeedback({
    actorId: "test-user",
    beliefId: snapshot.beliefs[0].id,
    outcome: "success",
    note: "重试后流程恢复正常",
  });

  assert.ok(updated);
  assert.equal(updated?.successCount, 1);
  assert.ok(updated && updated.confidence > snapshot.beliefs[0].confidence);
});

test("MemoryCortex writes learning traces even when long-term memory backends are absent", async () => {
  const brain = new MemoryCortex();
  const loop = new MemoryExperienceLearningLoop();
  brain.registerExperienceLearningLoop(loop);

  await brain.remember(
    "test-user",
    makeItem({
      content: "工具调用失败，应该把这个失败经验记下来",
      metadata: { outcome: "failure" },
    }),
  );

  const snapshot = loop.getSnapshot("test-user");
  assert.equal(snapshot.episodes.length, 1);
  assert.equal(snapshot.beliefs.length, 1);

  const recall = loop.recallLearningContext("test-user", "失败经验", 3);
  assert.ok(recall.length > 0);
  assert.match(recall[0].content, /belief:/);
});

test("BrainCenter routes tool interaction feedback into experience learning", async () => {
  const brainCenter = new BrainCenter();
  const memory = new MemoryCortex();
  const loop = new MemoryExperienceLearningLoop();
  memory.registerExperienceLearningLoop(loop);
  brainCenter.registerMemory(memory);

  brainCenter.recordToolInteraction({
    actorId: "test-user",
    sessionId: "session-1",
    userRequest: "打开桌面应用",
    attemptedTools: ["desktop.open"],
    success: false,
    errorMessage: "window did not appear",
  });

  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = loop.getSnapshot("test-user");
  assert.equal(snapshot.episodes.length, 1);
  assert.equal(snapshot.beliefs.length, 1);
  assert.equal(snapshot.beliefs[0].failureCount, 1);
  assert.ok(snapshot.beliefs[0].confidence < 0.62);

  const exposed = brainCenter.getLearningSnapshot("test-user");
  assert.equal(exposed?.beliefs[0].id, snapshot.beliefs[0].id);
});

test("tool ranking can down-rank cautious namespaces learned from failures", () => {
  const plan = resolveChatToolPlanForStream("open something", {
    chatToolsBuiltin: [
      makeTool("world.link"),
      makeTool("world"),
      makeTool("web_search"),
    ],
    chatToolsExtra: [],
    toolExposureProfile: "full",
    toolRankingHint: {
      cautiousNamespaces: ["world"],
    },
  });

  const names = plan.visibleTools.map((tool) =>
    tool.type === "function" ? tool.function.name : "",
  );
  const firstDesktopIndex = names.findIndex((name) => name.startsWith("world"));
  const lastNonDesktopIndex = names.findLastIndex((name) => !name.startsWith("world"));
  assert.ok(firstDesktopIndex > lastNonDesktopIndex);
});

test("BrainCenter records explicit user corrections as learning feedback", async () => {
  const brainCenter = new BrainCenter();
  const memory = new MemoryCortex();
  const loop = new MemoryExperienceLearningLoop();
  memory.registerExperienceLearningLoop(loop);
  brainCenter.registerMemory(memory);

  brainCenter.recordUserCorrection("test-user", "不对，应该优先问我确认", "我直接执行了操作");

  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = loop.getSnapshot("test-user");
  assert.equal(snapshot.episodes.length, 1);
  assert.equal(snapshot.beliefs.length, 1);
  assert.equal(snapshot.beliefs[0].failureCount, 1);
  assert.equal(snapshot.beliefs[0].status, "disputed");
});
