import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const SAMPLE_MEMORY: AgentPromptMemoryContext = {
  persona: "【人格】\nprivate butler",
  toneGuidance: "brief",
  relationshipGuidance: "warm",
  taskContext: "Handle the current user request only.",
  userProfile: "Prefers conclusion first.",
  narrativeRecall: "The user has been tracking AI news recently.",
  memorySummary: "Has two meetings today.",
  memoryCurrentMission: "Check news and today's schedule.",
  currentTime: "2026-07-18 20:00:00",
};

test("dynamic mode strips stable prompt fields and keeps dynamic ones", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const sanitized = kernel.sanitizePromptMemory(SAMPLE_MEMORY, plan);

  assert.equal(plan.promptMode, "dynamic");
  assert.equal(plan.toolExposureProfile, "scoped");
  assert.deepEqual(plan.pinnedToolNames, [
    "calendar.list_tasks",
    "calendar.create",
    "search_web",
    "search_images",
    "search_videos",
    "fetch_web",
    "video.grab",
    "video.find",
  ]);
  // 人格正文是唯一人格出口，任何模式都不剥离；其余稳定字段照旧
  assert.equal(sanitized?.persona, SAMPLE_MEMORY.persona);
  assert.equal(sanitized?.toneGuidance, undefined);
  assert.equal(sanitized?.relationshipGuidance, undefined);
  assert.equal(sanitized?.taskContext?.includes("Handle the current user request only."), true);
  assert.equal(sanitized?.narrativeRecall, SAMPLE_MEMORY.narrativeRecall);
  assert.equal(sanitized?.memorySummary, SAMPLE_MEMORY.memorySummary);
});

test("minimal mode keeps on-demand event recall block", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "minimal" });

  const memory: AgentPromptMemoryContext = {
    ...SAMPLE_MEMORY,
    eventRecall: "【事件回忆】\n- 2026/10/28 15:37 比价 小米15 → 最低 ¥1884（taobao） [完成]",
  };
  const plan = kernel.planTurn("上次比价那个怎么样了", memory);
  const sanitized = kernel.sanitizePromptMemory(memory, plan);

  assert.equal(plan.promptMode, "minimal");
  assert.equal(sanitized?.eventRecall, memory.eventRecall);
  assert.equal(sanitized?.narrativeRecall, memory.narrativeRecall);
});

test("conversation_only mode collapses prompt memory to a micro prompt", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "conversation_only" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const sanitized = kernel.sanitizePromptMemory(SAMPLE_MEMORY, plan);

  assert.equal(plan.promptMode, "conversation_only");
  assert.deepEqual(Object.keys(sanitized ?? {}), ["taskContext"]);
  assert.equal(sanitized?.taskContext?.includes("Runtime Kernel"), true);
});

test("scoped tool exposure keeps only the pinned tool suite", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const resolved = resolveChatToolPlanForStream("today ai news and my schedule", {
    toolExposureProfile: plan.toolExposureProfile,
    pinnedToolNames: plan.pinnedToolNames,
    agentAccessMode: "sandbox",
    desktopBridgeOnline: false,
    phoneBridgeOnline: false,
  });
  const names = resolved.visibleTools
    .map((tool) => (tool.type === "function" ? tool.function?.name ?? "" : ""))
    .filter(Boolean)
    .sort();

  assert.deepEqual(names, [
    "calendar.create",
    "calendar.list_tasks",
    "fetch_web",
    "search_images",
    "search_videos",
    "search_web",
    "video.find",
    "video.grab",
  ]);
});

test("纯内容看片诉求：pin video.find 且剔除只出链接的 search_videos（动词与「视频」隔着片名也要命中）", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });

  // 关键词表只认「看视频/找个视频」这类动词紧贴的说法，真实说法是动词与「视频」
  // 之间隔着整段片名——这些必须命中，否则 search_videos 剔不掉，模型会只回链接列表。
  for (const text of [
    "来个王者荣耀李白打野教学的视频看看",
    "我想看刘德华演唱会现场的视频",
    "有没有讲量子力学的视频",
    "推荐个做红烧肉的视频",
    "给我放个猫猫搞笑视频",
  ]) {
    const pins = kernel.planTurn(text).pinnedToolNames;
    assert.ok(pins.includes("video.find"), `${text} 未 pin video.find：${pins.join(",")}`);
    assert.ok(!pins.includes("search_videos"), `${text} 仍暴露 search_videos：${pins.join(",")}`);
  }
});

test("贴链接要求解析时保留 search 束，不误判成看片诉求", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });
  const pins = kernel.planTurn("帮我解析一下这个视频，我要无水印的 https://v.douyin.com/abc/").pinnedToolNames;
  assert.ok(pins.includes("video.grab"), `链接解析未 pin video.grab：${pins.join(",")}`);
});

test("high-risk tools are blocked by runtime safety policy", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true });

  // 与 AgentTaskSafety 强制同口径（2026-09 重构）：理由文案统一走 HIGH_RISK_TOOL_REASON
  assert.deepEqual(kernel.checkToolAction("shopping.order.place"), {
    allowed: false,
    reason: "资金支付或对外发送类动作需要用户确认后才能执行。",
  });
  assert.deepEqual(kernel.checkToolAction("search_web"), { allowed: true });
});

test("read-only tools in high-risk families pass the gate (2026-09-28 root fix)", () => {
  const kernel = new RuntimeKernel();
  // 2026-09-28 前这些被 includes("payment"/"transfer"/"wallet") 子串规则误拦，
  // trajectories 实证 social.get_feed 被拦 6 次、wallet 查询 4 次
  assert.deepEqual(kernel.checkToolAction("wallet.get_balance"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("wallet.get_transactions"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("payment.query_order"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("payment.list_methods"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("social.get_feed"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("social.search_posts"), { allowed: true });
  // 写/外发动作照旧拦
  assert.equal(kernel.checkToolAction("social.post").allowed, false);
  assert.equal(kernel.checkToolAction("wallet.transfer").allowed, false);
});
