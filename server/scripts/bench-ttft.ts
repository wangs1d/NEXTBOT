/**
 * 首 token（TTFT）压测：对比「优化前策略」与「当前策略」在相同 mock 延迟下的表现。
 *
 * 用法：
 *   npm run bench:ttft
 *   npm run bench:ttft -- --live   # 若配置了 MOONSHOT/OPENAI 密钥则打真实 API
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";

import { isAgentCapsPromptEnabled } from "../src/agent/agent-capabilities.js";
import {
  runPlanExecuteLoop,
  shouldUsePlanExecuteLoop,
} from "../src/agent/plan-execute-loop.js";
import { createExternalChatProviderFromEnv } from "../src/external-model/index.js";
import { AgentCore } from "../src/services/agent-core.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "../src/external-model/types.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDelayedProvider(
  firstTokenMs: number,
  responses: string[],
): ExternalChatProvider & { callCount: number } {
  let callIndex = 0;
  const provider: ExternalChatProvider & { callCount: number } = {
    id: "mock-delayed",
    displayLabel: "Mock Delayed",
    callCount: 0,
    isEnabled: () => true,
    clearSession: () => {},
    async streamCompletion(
      _sessionId: string,
      _userTurn: ChatUserTurn,
      onDelta: StreamDeltaHandler,
      _tools?: ChatToolExecutionContext,
      _streamOpts?: AgentStreamOptions,
    ): Promise<string> {
      const response = responses[Math.min(callIndex, responses.length - 1)] ?? "OK";
      callIndex += 1;
      provider.callCount += 1;
      await sleep(firstTokenMs);
      if (response.length > 0) {
        onDelta(response.slice(0, 1));
        if (response.length > 1) onDelta(response.slice(1));
      }
      return response;
    },
  };
  return provider;
}

function createSlowNarrative(delayMs: number): NarrativeMemoryPort {
  return {
    async ingest() {},
    async buildNarrativeRecall(_actorId: string, _query: string): Promise<string> {
      await sleep(delayMs);
      return "【mock memory】用户偏好简洁回复。";
    },
  };
}

async function measureAgentCoreTtft(args: {
  message: string;
  narrativeDelayMs: number;
  llmFirstTokenMs: number;
  narrative: NarrativeMemoryPort | null;
}): Promise<{ ttftMs: number; modelCalls: number }> {
  const provider = createDelayedProvider(args.llmFirstTokenMs, [
    "这是面向用户的最终回复，包含足够的信息量。",
  ]);
  const core = new AgentCore(
    new ToolRegistry(),
    provider,
    null,
    null,
    null,
    null,
    null,
    args.narrative,
  );
  const t0 = performance.now();
  let ttftMs = -1;
  await core.handleUserMessage("bench-actor", args.message, {
    onAssistantDelta: () => {
      if (ttftMs < 0) ttftMs = performance.now() - t0;
    },
  });
  return { ttftMs: ttftMs < 0 ? performance.now() - t0 : ttftMs, modelCalls: provider.callCount };
}

/** 优化前：短句也做完整记忆检索 + 大 prompt 额外延迟 */
async function simulateLegacyPipeline(args: {
  message: string;
  narrativeDelayMs: number;
  llmFirstTokenMs: number;
  worldCapsPenaltyMs: number;
}): Promise<number> {
  const t0 = performance.now();
  await sleep(args.narrativeDelayMs);
  await sleep(args.worldCapsPenaltyMs);
  await sleep(args.llmFirstTokenMs);
  return performance.now() - t0;
}

/**
 * understanding 缺省时的长度启发近似（与 task-context.ts 对齐）：
 * 真实管道的召回触发由 L1 路由 understanding 标记驱动，本基准无路由 LLM，
 * 用「短句不召回」近似模拟该路径的延迟形态。
 */
function skipNarrativeRecallByLength(message: string): boolean {
  return message.trim().length <= 16;
}

/** 优化后：启发式跳过 / 记忆超时 / 默认关闭 world caps */
async function simulateOptimizedPipeline(args: {
  message: string;
  narrativeDelayMs: number;
  llmFirstTokenMs: number;
  recallTimeoutMs: number;
}): Promise<number> {
  const t0 = performance.now();
  if (!skipNarrativeRecallByLength(args.message)) {
    await sleep(Math.min(args.narrativeDelayMs, args.recallTimeoutMs));
  }
  await sleep(args.llmFirstTokenMs);
  return performance.now() - t0;
}

async function measurePeExecuteTtft(args: {
  verboseInternal: boolean;
  planMs: number;
  executeMs: number;
}): Promise<{ usefulTtftMs: number; modelCalls: number }> {
  if (args.verboseInternal) {
    process.env.AGENT_PE_VERBOSE_STREAM = "1";
  } else {
    delete process.env.AGENT_PE_VERBOSE_STREAM;
  }

  const planJson =
    '{"goal":"整理新闻","steps":[{"id":"1","intent":"搜索并总结","successCriteria":"三点摘要","suggestedTools":["search_web"]}]}';
  const responses = [planJson, "1. 新闻A\n2. 新闻B\n3. 新闻C"];

  let call = 0;
  const provider: ExternalChatProvider & { callCount: number } = {
    id: "mock-pe",
    displayLabel: "Mock PE",
    callCount: 0,
    isEnabled: () => true,
    clearSession: () => {},
    async streamCompletion(_sessionId, _userTurn, onDelta) {
      call += 1;
      provider.callCount += 1;
      const delay =
        call === 1 ? args.planMs : args.executeMs;
      const response = responses[Math.min(call - 1, responses.length - 1)] ?? "OK";
      await sleep(delay);
      if (response.length > 0) {
        onDelta(response.slice(0, 1));
        if (response.length > 1) onDelta(response.slice(1));
      }
      return response;
    },
  };

  const t0 = performance.now();
  let usefulTtftMs = -1;
  await runPlanExecuteLoop({
    provider,
    planSessionId: `bench-pe-${args.verboseInternal}`,
    userText: "先帮我搜索今天 AI 新闻，然后整理成三点摘要",
    onDelta: (delta) => {
      const useful = !delta.includes("━━") && !delta.trimStart().startsWith("{");
      if (usefulTtftMs < 0 && useful) usefulTtftMs = performance.now() - t0;
    },
    toolCtx: undefined,
    baseStreamOpts: undefined,
  });

  return {
    usefulTtftMs: usefulTtftMs < 0 ? performance.now() - t0 : usefulTtftMs,
    modelCalls: provider.callCount,
  };
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function pctSaved(before: number, after: number): string {
  if (before <= 0) return "—";
  return `${Math.round((1 - after / before) * 100)}%`;
}

async function runLiveProbe(message: string): Promise<number | null> {
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) return null;
  const core = new AgentCore(new ToolRegistry(), provider, null, null, null, null, null, null);
  const t0 = performance.now();
  let ttftMs = -1;
  await core.handleUserMessage("bench-live", message, {
    onAssistantDelta: () => {
      if (ttftMs < 0) ttftMs = performance.now() - t0;
    },
  });
  return ttftMs < 0 ? performance.now() - t0 : ttftMs;
}

async function main(): Promise<void> {
  const savedEnv = {
    masterDelegate: process.env.ENABLE_MASTER_AGENT_DELEGATION,
    masterDelegateLegacy: process.env.ENABLE_MULTI_AGENT_COORDINATION,
    recallTimeout: process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS,
    worldCaps: process.env.AGENT_PROMPT_WORLD_CAPS,
    pe: process.env.AGENT_PLAN_EXECUTE_LOOP,
  };
  delete process.env.AGENT_PLAN_EXECUTE_LOOP;
  delete process.env.ENABLE_MASTER_AGENT_DELEGATION;
  delete process.env.ENABLE_MULTI_AGENT_COORDINATION;
  delete process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS;
  delete process.env.AGENT_PROMPT_WORLD_CAPS;
  const narrativeDelayMs = 800;
  const llmFirstTokenMs = 220;
  const recallTimeoutMs = 600;
  const worldCapsPenaltyMs = 90;
  const shortMessage = "你好";
  const longMessage =
    "请结合近年来产业落地案例，详细介绍一下量子计算在密码学、药物研发与金融风控三个方向的应用前景，并比较各方向的成熟度与主要挑战。";

  console.log("=== Agent TTFT 压测（mock 延迟）===");
  console.log(
    `假设：记忆检索 ${narrativeDelayMs} ms | 模型首 token ${llmFirstTokenMs} ms | 记忆超时 ${recallTimeoutMs} ms`,
  );
  console.log("");

  const shortLegacy = await simulateLegacyPipeline({
    message: shortMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    worldCapsPenaltyMs,
  });
  const shortOptimizedCore = await measureAgentCoreTtft({
    message: shortMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    narrative: createSlowNarrative(narrativeDelayMs),
  });
  const shortOptimizedSim = await simulateOptimizedPipeline({
    message: shortMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    recallTimeoutMs,
  });

  console.log(`【短句】${shortMessage}`);
  console.log(`  优化前（总是记忆检索 + 大 prompt）: ${fmtMs(shortLegacy)}`);
  console.log(`  优化后（AgentCore 实测）            : ${fmtMs(shortOptimizedCore.ttftMs)}`);
  console.log(
    `  节省: ${fmtMs(shortLegacy - shortOptimizedCore.ttftMs)} (${pctSaved(shortLegacy, shortOptimizedCore.ttftMs)})`,
  );
  console.log("");

  const longLegacy = await simulateLegacyPipeline({
    message: longMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    worldCapsPenaltyMs,
  });
  const longOptimizedCore = await measureAgentCoreTtft({
    message: longMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    narrative: createSlowNarrative(narrativeDelayMs),
  });
  const longOptimizedSim = await simulateOptimizedPipeline({
    message: longMessage,
    narrativeDelayMs,
    llmFirstTokenMs,
    recallTimeoutMs,
  });

  console.log(`【长句】${longMessage}`);
  console.log(`  优化前（完整记忆检索 + 大 prompt）: ${fmtMs(longLegacy)}`);
  console.log(`  优化后（AgentCore 实测，含超时）  : ${fmtMs(longOptimizedCore.ttftMs)}`);
  console.log(`  优化后（理论下限，超时截断）      : ${fmtMs(longOptimizedSim)}`);
  console.log(
    `  节省: ${fmtMs(longLegacy - longOptimizedCore.ttftMs)} (${pctSaved(longLegacy, longOptimizedCore.ttftMs)})`,
  );
  console.log("");

  process.env.AGENT_PLAN_EXECUTE_LOOP = "1";
  console.log("【Plan-Execute 路由】");
  console.log(`  「你好」跳过 PE: ${shouldUsePlanExecuteLoop("你好") ? "否" : "是"}`);
  console.log(
    `  多步任务启用 PE: ${shouldUsePlanExecuteLoop("先搜索新闻然后总结再设提醒") ? "是" : "否"}`,
  );

  // 优化前：旧版计划-执行-自检（3 次 LLM 调用）
  console.log("");
  console.log("【Plan-Execute 复杂任务 - 优化对比】");
  console.log(
    `  旧版（计划→执行→自检，3 次 LLM）: 约 ${180 + 220 + 160} ms | 模型 3 次`,
  );
  console.log(
    `  新版（计划→执行，2 次 LLM）      : 约 ${180 + 220} ms | 模型 2 次`,
  );
  console.log(
    `  性能提升: 约 33% 减少 LLM 调用次数`,
  );

  const peNew = await measurePeExecuteTtft({
    verboseInternal: false,
    planMs: 180,
    executeMs: 220,
  });

  console.log(
    `  新版实测: 可见首 token ${fmtMs(peNew.usefulTtftMs)} | 模型 ${peNew.modelCalls} 次`,
  );
  delete process.env.AGENT_PLAN_EXECUTE_LOOP;
  delete process.env.AGENT_PE_VERBOSE_STREAM;
  delete process.env.AGENT_PE_SKIP_VERIFY_SIMPLE;

  console.log("");
  console.log("【当前默认开关】");
  console.log(`  world caps prompt: ${isAgentCapsPromptEnabled() ? "开启" : "关闭（默认）"}`);
  console.log(`  短句跳过记忆检索: ${skipNarrativeRecallByLength(shortMessage) ? "是" : "否"}`);

  if (process.argv.includes("--live")) {
    console.log("");
    console.log("=== 真实 API 探针 ===");
    const live = await runLiveProbe("用一句话介绍你自己。");
    console.log(live == null ? "  跳过：未配置 MOONSHOT/OPENAI 密钥" : `  真实 TTFT: ${fmtMs(live)}`);
  } else {
    console.log("");
    console.log("提示: 追加 --live 可测量真实 API 首 token。");
  }

  if (savedEnv.pe) process.env.AGENT_PLAN_EXECUTE_LOOP = savedEnv.pe;
  else delete process.env.AGENT_PLAN_EXECUTE_LOOP;
  if (savedEnv.masterDelegate) process.env.ENABLE_MASTER_AGENT_DELEGATION = savedEnv.masterDelegate;
  else delete process.env.ENABLE_MASTER_AGENT_DELEGATION;
  if (savedEnv.masterDelegateLegacy) {
    process.env.ENABLE_MULTI_AGENT_COORDINATION = savedEnv.masterDelegateLegacy;
  } else {
    delete process.env.ENABLE_MULTI_AGENT_COORDINATION;
  }
  if (savedEnv.recallTimeout) process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS = savedEnv.recallTimeout;
  else delete process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS;
  if (savedEnv.worldCaps) process.env.AGENT_PROMPT_WORLD_CAPS = savedEnv.worldCaps;
  else delete process.env.AGENT_PROMPT_WORLD_CAPS;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
