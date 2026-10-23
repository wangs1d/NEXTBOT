// 稳定层三级易变性契约测试（2026-10-01 跨对话冷启动缓存修复）。
//
// 背景：真实用户逐笔取证（llm-token-audit.ndjson 2026-09-28~30）显示跨对话
// 冷启动命中恒为地板 ~1408 token——理解档案/事实库/长期画像这些「对话级」
// 块坐在稳定层中段，每轮对话收尾被后台抽取/画像聚合改写后，新对话从该块
// 起整体分歧，其后真正稳定的内容（人格/技能/夜间记忆）全部 miss。
//
// 契约（assembleLayeredSections 内注释为准）：
//   稳定层内部按写入频率分带排列：CORE 重配置级 → SLOW 夜间级 → MEMORY 对话级。
// 本测试以「字节公共前缀长度（LCP）」锁定行为，而非锁字符串顺序：
//   改写 MEMORY 层的任一块，只允许影响该块及其后内容——之前的内容必须
//   逐字节相等。任何把易变块插回稳定层中段的改动都会让 LCP 缩短、测试失败。
import assert from "node:assert/strict";
import test from "node:test";

import { assembleSystemPrompt } from "../src/agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function buildFullMemory(overrides?: Partial<AgentPromptMemoryContext>): AgentPromptMemoryContext {
  return {
    // CORE 重配置级
    personalityCore: "【人格内核】办事优先、表达克制。",
    persona: "【人格与角色】可靠私人管家。",
    values: "【价值观与原则】诚实、克制。",
    abilities: "联网检索、日程管理。",
    worldCaps: "【Agent World】工具全景。",
    skillIndex: "【技能索引】search_web、calendar.batch_create。",
    interestList: "【兴趣列表】编程、旅行。",
    personaStatic: "【人格·静态】称呼用户为「你」。",
    // SLOW 夜间级
    memoryInventory: "【记忆目录】条目索引若干。",
    relationshipMemory: "关系背景：多年搭档式协作。",
    lifeThemeMemory: "生活主题：工作密集期。",
    dreamMemory: "梦境整理：核心主题。",
    memoryContinuity: "连续性：背景。",
    yesterdayHighlight: "跨天回顾：昨日要点。",
    // MEMORY 对话级
    userUnderstanding: "【用户理解档案】\n用户偏好简洁直接的回复。",
    userFacts: "【用户事实库】\n所在城市：杭州",
    userProfileSummary: "用户是开发者，常调研 AI 产品。",
    memorySummary: "持久记忆：用户在做 NextBot 项目。",
    ...overrides,
  } as AgentPromptMemoryContext;
}

/** 两段文本的公共前缀长度（UTF-16 码元口径，与 String.indexOf 一致）。 */
function lcpBytes(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

test("三级分带排列：CORE 全部先于 SLOW，SLOW 全部先于 MEMORY", () => {
  const { stableSystemPrompt } = assembleSystemPrompt("你是助理。", buildFullMemory());
  // 各带代表块的首次出现位置必须单调递增
  const coreMarkers = ["【人格内核】", "【技能索引】", "【人格·静态】"];
  const slowMarkers = ["【记忆目录】", "【记忆整理】"];
  const memoryMarkers = ["【用户理解档案】", "【用户事实库】", "【用户长期画像】", "【持久记忆】"];
  const pos = (s: string) => {
    const i = stableSystemPrompt.indexOf(s);
    assert.ok(i >= 0, `稳定层缺少块 ${s}`);
    return i;
  };
  const maxCore = Math.max(...coreMarkers.map(pos));
  const minSlow = Math.min(...slowMarkers.map(pos));
  const maxSlow = Math.max(...slowMarkers.map(pos));
  const minMemory = Math.min(...memoryMarkers.map(pos));
  assert.ok(maxCore < minSlow, `CORE 块必须全部先于 SLOW（${maxCore} < ${minSlow}）`);
  assert.ok(maxSlow < minMemory, `SLOW 块必须全部先于 MEMORY（${maxSlow} < ${minMemory}）`);
});

test("改写 MEMORY 层（长期画像）：分歧落在该块内部，块前字节不变、块后不受牵连", () => {
  const a = assembleSystemPrompt("你是助理。", buildFullMemory());
  const b = assembleSystemPrompt(
    "你是助理。",
    buildFullMemory({ userProfileSummary: "这位用户是产品经理，关注 AI 硬件。" }),
  );
  const profilePos = a.stableSystemPrompt.indexOf("【用户长期画像】");
  const nextPos = a.stableSystemPrompt.indexOf("【持久记忆】");
  const lcp = lcpBytes(a.stableSystemPrompt, b.stableSystemPrompt);
  assert.ok(
    lcp >= profilePos,
    "画像块之前的内容（CORE+SLOW+理解/事实）必须逐字节相等",
  );
  assert.ok(
    lcp < nextPos,
    "分歧必须落在画像块内部——其后的持久记忆块不得被牵连移位",
  );
  // 架构收益断言：分歧点必须晚于 CORE 层全部内容（技能索引是 CORE 最靠后的块之一）
  const skillPos = a.stableSystemPrompt.indexOf("【技能索引】");
  assert.ok(
    profilePos > skillPos,
    "MEMORY 层必须沉底：其起点必须晚于 CORE 层（技能索引）",
  );
});

test("改写 MEMORY 层（理解档案）：理解档案之前的 CORE+SLOW 前缀不受影响", () => {
  const a = assembleSystemPrompt("你是助理。", buildFullMemory());
  const b = assembleSystemPrompt(
    "你是助理。",
    buildFullMemory({ userUnderstanding: "【用户理解档案】\n该用户反感客套，喜欢先结论。" }),
  );
  const understandingPos = a.stableSystemPrompt.indexOf("【用户理解档案】");
  const nextPos = a.stableSystemPrompt.indexOf("【用户事实库】");
  const lcp = lcpBytes(a.stableSystemPrompt, b.stableSystemPrompt);
  assert.ok(lcp >= understandingPos, "理解档案块之前的内容必须逐字节相等");
  assert.ok(lcp < nextPos, "分歧必须落在理解档案块内部——其后事实库不得被牵连");
});

test("改写 MEMORY 层（持久记忆）：分歧点之前含理解/事实/画像全部字节相等（分带收益）", () => {
  const t1 = assembleSystemPrompt("你是助理。", buildFullMemory({ memorySummary: "第一轮版本。" }));
  const t2 = assembleSystemPrompt("你是助理。", buildFullMemory({ memorySummary: "后续轮被后台抽取改写。" }));
  const memoryPos = t1.stableSystemPrompt.indexOf("【持久记忆】");
  const lcp = lcpBytes(t1.stableSystemPrompt, t2.stableSystemPrompt);
  assert.ok(lcp >= memoryPos, "持久记忆块之前的内容（含理解/事实/画像）必须逐字节相等");
  assert.notEqual(t1.stableSystemPrompt, t2.stableSystemPrompt, "内容确实不同（断言有效性）");
  // 分带收益：分歧点晚于夜间级——MEMORY 块改写不回溯打穿 CORE/SLOW
  assert.ok(memoryPos > t1.stableSystemPrompt.indexOf("【记忆整理】"), "分歧点晚于夜间级");
});
