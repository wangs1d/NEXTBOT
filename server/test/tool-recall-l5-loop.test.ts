/**
 * L5 数据回流 + 边界补齐单测（2026-10-10 六方向第二批）。
 *
 * L4 持久化：晋升计数落盘/重启恢复/测试零污染（方向三）。
 * 编排器协同：计划步 suggestedTools → 执行轮可见集转正（方向四）。
 * L5 负反馈：预载未调 → 冷却降权，真实成功执行即恢复（方向一a）。
 * L3 盲区观测：参数级失败指标口径（方向六）。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";
// 持久化路径指向临时文件（必须在首次访问前设置；node:test 每文件独立进程）
process.env.AGENT_TOOL_PROMOTION_STATE_PATH = new URL("./tmp-tool-promotion-state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

const promotion = await import("../src/tools/tool-search/tool-promotion.js");
const feedback = await import("../src/tools/tool-search/preload-feedback.js");
const laneSets = await import("../src/external-model/lane-tool-sets.js");
const turnTrace = await import("../src/external-model/turn-trace.js");
const peLoop = await import("../src/agent/plan-execute-loop.js");
const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { MEDIA_MUSIC_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/media-music/chat-tools.js"
);

const STATE_PATH = process.env.AGENT_TOOL_PROMOTION_STATE_PATH;

function fn(name: string, description = name): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? t.function?.name ?? "" : "";
}

// ── 方向三：L4 晋升持久化 ──

test("L4 持久化：计数落盘 + 重启恢复（冷启动不再归零）", () => {
  rmSync(STATE_PATH, { force: true });
  promotion.resetToolPromotionStateForRestartTest();
  const actor = "actor-persist-1";
  for (let i = 0; i < 3; i++) promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
  assert.deepEqual(promotion.getPromotedToolNames(actor), ["travel.plan-itinerary"]);
  promotion.flushToolPromotionState(); // 立即落盘（绕过 10s 防抖）
  assert.ok(existsSync(STATE_PATH), "flush 后状态文件应存在");
  const disk = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>;
  assert.ok(disk[actor], "磁盘状态应含该 actor");
  // 模拟重启：内存清空 + 允许重新加载
  promotion.resetToolPromotionStateForRestartTest();
  assert.deepEqual(promotion.getPromotedToolNames(actor), ["travel.plan-itinerary"], "重启后应从磁盘恢复晋升名单");
});

test("L4 持久化：测试 reset 不落盘（零测试污染）", () => {
  rmSync(STATE_PATH, { force: true });
  promotion.resetToolPromotionStateForRestartTest();
  promotion.recordToolUsageForPromotion("actor-persist-2", "media.play", true);
  promotion.resetToolPromotionState(); // 不 flush → dirty 清零、不写盘
  assert.equal(existsSync(STATE_PATH), false, "reset 不得触发落盘");
});

// ── 方向四：编排器计划直供预载 ──

test("suggestedTools 转正：语料内工具进可见集，幻觉名/已可见名过滤", () => {
  const travelTool = fn(
    "travel.plan-itinerary",
    "生成旅游行程规划：按天拆分景点/酒店/餐厅，含时间安排与交通衔接。",
  );
  const baseStreamOpts = {
    chatToolsBuiltin: [fn("search_web")],
    chatToolsExtra: [travelTool, fn("media.play")],
  } as Parameters<typeof peLoop.resolveSuggestedToolDefinitions>[1];
  const plan = {
    goal: "规划行程并搜索",
    steps: [
      { id: "1", intent: "规划去成都的行程", suggestedTools: ["travel.plan-itinerary", "ghost.tool"] },
      { id: "2", intent: "搜一下机票", suggestedTools: ["search_web", "travel.plan-itinerary"] },
    ],
  };
  const out = peLoop.resolveSuggestedToolDefinitions(plan as never, baseStreamOpts).map(toolName);
  assert.deepEqual(out, ["travel.plan-itinerary"], `幻觉名/已可见名应被过滤: ${out.join(",")}`);
});

test("suggestedTools 转正：未装配工具集（chatToolsExtra 空）时为空集（全量可见场景无需直供）", () => {
  const plan = { goal: "g", steps: [{ id: "1", intent: "i", suggestedTools: ["travel.plan-itinerary"] }] };
  assert.deepEqual(peLoop.resolveSuggestedToolDefinitions(plan as never, undefined), []);
  assert.deepEqual(peLoop.resolveSuggestedToolDefinitions(plan as never, { chatToolsExtra: [] } as never), []);
});

// ── 方向一a：预载负反馈 ──

test("L5 负反馈：预载 8 次零真实执行 → 冷却降权退出预载；真实成功执行立即恢复", () => {
  feedback.resetPreloadFeedbackState();
  process.env.AGENT_TOOL_PRELOAD_FEEDBACK = "on";
  try {
    const query = "音乐暂停一下";
    // 族序修正后（2026-10-10）：media 族按 BM25 相关度降序注入，media.pause 升到
    // 头部不再被截；仍占 cap 槽的是相关度靠后的混域尾槽工具——负反馈治的是这类
    // 「占槽零转化」。
    const before = laneSets.buildDomainPreloadTools(query, corpus).map(toolName);
    const noise = before.find((n) => n !== "media.pause" && !n.startsWith("media.")) ?? before[before.length - 1]!;
    assert.ok(noise && noise !== "media.pause", `应存在非目标噪声工具: ${before.join(",")}`);
    assert.ok(before.includes(noise), `噪声工具应占槽: ${before.join(",")}`);
    assert.ok(before.includes("media.pause"), `族序修正后 media.pause 应在头部: ${before.join(",")}`);
    // 打开真实执行闸（生产里由 ToolContextFactory.execute 触发；测试里用无关工具
    // 的真实执行置位，不碰目标工具的计数）
    feedback.recordPreloadExecution("media.search", true);
    // 模拟反复预载但从未被调：直接灌注入计数到阈值（buildDomainPreloadTools
    // 出口的副作用记录也会累积，这里再手动灌满，两侧同源）
    for (let i = 0; i < feedback.PRELOAD_DEWEIGHT_INJECTION_THRESHOLD; i++) {
      feedback.recordPreloadInjection([noise]);
    }
    assert.equal(feedback.isPreloadDeweighted(noise), true, "达到阈值零执行应降权");
    // 降权后退出预载，cap 空出的槽由族内下一候选补位
    const after = laneSets.buildDomainPreloadTools(query, corpus).map(toolName);
    assert.equal(after.includes(noise), false, `降权后应退出预载: ${after.join(",")}`);
    assert.ok(
      after.length >= before.length - 1,
      `退出后最多损失一个槽（候选池已随工具删除收缩）: before=${before.length} after=${after.length}`,
    );
    const backfilled = after.filter((n) => !before.includes(n));
    assert.ok(
      backfilled.length === 0 || after.length === before.length,
      `有补位候选时应填满空槽: ${after.join(",")}`,
    );
    // 真实成功执行 → 立即恢复
    feedback.recordPreloadExecution(noise, true);
    assert.equal(feedback.isPreloadDeweighted(noise), false, "成功执行应解除降权");
    const recovered = laneSets.buildDomainPreloadTools(query, corpus).map(toolName);
    assert.ok(recovered.includes(noise), `恢复后应重新进预载: ${recovered.join(",")}`);
  } finally {
    delete process.env.AGENT_TOOL_PRELOAD_FEEDBACK;
    feedback.resetPreloadFeedbackState();
  }
});

test("L5 负反馈：真实执行闸未开（单测/离线基准环境）→ 永不降权，预载确定性不受影响", () => {
  feedback.resetPreloadFeedbackState();
  for (let i = 0; i < 100; i++) feedback.recordPreloadInjection(["media.pause"]);
  assert.equal(feedback.isPreloadDeweighted("media.pause"), false, "无真实执行观测时不得降权");
});

test("L5 负反馈：AGENT_TOOL_PRELOAD_FEEDBACK=off → 一键关闭", () => {
  feedback.resetPreloadFeedbackState();
  feedback.recordPreloadExecution("gate.opener", true); // 置位真实执行闸
  process.env.AGENT_TOOL_PRELOAD_FEEDBACK = "off";
  try {
    for (let i = 0; i < 20; i++) feedback.recordPreloadInjection(["media.pause"]);
    assert.equal(feedback.isPreloadDeweighted("media.pause"), false, "开关关闭时不得降权");
  } finally {
    delete process.env.AGENT_TOOL_PRELOAD_FEEDBACK;
    feedback.resetPreloadFeedbackState();
  }
});

// ── 方向六：参数级失败指标 ──

test("L6 参数级失败率：paramError 调用计数与占比口径", () => {
  const records: turnTrace.TurnTraceRecord[] = [
    {
      ts: 1,
      stage: "task_plane_full",
      visibleTools: 10,
      deferredActive: true,
      deferredCount: 150,
      query: "帮我规划去成都的行程",
      waves: 2,
      toolCalls: [
        { name: "travel.plan-itinerary", ok: false, ms: 5, acquisition: "visible", paramError: true },
        { name: "travel.plan-itinerary", ok: true, ms: 50, acquisition: "visible" },
        { name: "search_web", ok: false, ms: 5, acquisition: "visible" },
      ],
      finalTextChars: 10,
      durationMs: 1000,
    },
  ];
  const s = turnTrace.summarizeTurnTraces(records);
  assert.equal(s.paramErrorCalls, 1);
  assert.ok(Math.abs(s.paramErrorRate - 1 / 3) < 1e-9, `paramErrorRate=${s.paramErrorRate}`);
});

// ── 语料（与 l1-l4 / benchmark 同口径：builtin + media-music + travel 族） ──

const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools(), ...MEDIA_MUSIC_CHAT_TOOLS];
const TRAVEL_DESCRIPTIONS: Record<string, string> = {
  "travel.plan-itinerary":
    "生成旅游行程规划：根据用户的目的地、天数与偏好生成完整结构化行程，按天拆分景点/酒店/餐厅，含时间安排、交通衔接、建议游览时长、小贴士、预订提示与价格汇总。" +
    "凡回复要给出具体行程安排（按天/按时段列景点、交通、餐厅的表格或清单），必须先调用本工具生成行程卡。触发表达包括「帮我规划去X的行程」「去X玩几天怎么安排」「X旅游攻略」「X自由行」「周末附近游玩」。",
  "travel.search-poi":
    "搜索目的地景点/酒店/餐厅：搜索指定目的地的景点、酒店、餐厅三类 POI（含名称/评分/地址/坐标）。当用户想了解「X 有什么好玩的/好吃的/住的」或在规划前查看目的地的 POI 候选时调用。",
  "travel.destination-info":
    "目的地实用信息：查询目的地的签证、货币、时差、插座、小费习惯、最佳旅行季节等实用信息。用户问「去X要注意什么」「X签证好办吗」时调用。",
  "travel.compute-route":
    "路线计算：计算两地之间的交通方式与耗时（驾车/高铁/飞行），规划去某地怎么走、多少公里时调用。",
  "travel.get-itinerary":
    "读取已生成的行程：按天返回行程明细（景点/酒店/餐厅与时间安排），用户想回看行程、看某天细节时调用。",
  "travel.edit-itinerary":
    "编辑已有行程：向行程中添加/删除/替换条目（景点/酒店/餐厅）或修改时间字段，用户说「把博物馆换成海底捞」「下午加个咖啡厅」时调用。",
};
for (const [name, description] of Object.entries(TRAVEL_DESCRIPTIONS)) {
  corpus.push(fn(name, description));
}
