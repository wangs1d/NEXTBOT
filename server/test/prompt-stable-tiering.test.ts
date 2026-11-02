// 稳定层三级易变性契约 + 「按轮召回不进稳定层」契约。
//
// 背景一（分带）：真实逐笔取证显示跨对话冷启动命中恒为地板 ~1408 token——
// 理解档案/事实库/长期画像这些「对话级」块坐在稳定层中段时，每轮对话收尾被
// 后台抽取改写后，新对话从该块起整体分歧，其后真正稳定的内容全部 miss。
// 契约：稳定层内部按写入频率分带 CORE 重配置级 → SLOW 夜间级 → MEMORY 对话级。
// 以「字节公共前缀长度（LCP）」锁定行为，而非锁字符串顺序。
//
// 背景二（召回归属）：内容由本轮 userQuery 决定的块（【持久记忆】= KV 长期摘要
// 的按轮召回结果）不得进稳定层——稳定层受会话冻结（freezeStableForSession）
// 覆盖，逐轮字节不变，召回结果会被冻在首轮：换话题拿不到新命中，首轮命中又
// 一直灌下去。本文件同时锁这条归属。
import assert from "node:assert/strict";
import test from "node:test";

import { assembleSystemPrompt } from "../src/agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function buildFullMemory(overrides?: Partial<AgentPromptMemoryContext>): AgentPromptMemoryContext {
  return {
    // CORE 重配置级
    persona: "【人格】\n你是用户的私人管家兼搭档。",
    agentCaps: "联网检索、日程管理。",
    skillIndex: "【技能索引】search_web、calendar.batch_create。",
    interestList: "【兴趣列表】编程、旅行。",
    // SLOW 夜间级
    memoryInventory: "【记忆目录】条目索引若干。",
    // MEMORY 对话级（稳定层沉底带：后台抽取可改写，但与本轮 query 无关）
    userUnderstanding: "【用户理解档案】\n用户偏好简洁直接的回复。",
    userFacts: "【用户事实库】\n所在城市：杭州",
    lifeRelations: "【用户关系一览】\n老婆：小王",
    userProfileSummary: "用户是开发者，常调研 AI 产品。",
    // 动态层：按本轮 query 召回
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
  const coreMarkers = ["【人格】", "【能力与工具】", "【技能索引】"];
  const slowMarkers = ["【记忆目录】"];
  const memoryMarkers = ["【用户理解档案】", "【用户事实库】", "【用户关系一览】", "【用户长期画像】"];
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

test("改写 MEMORY 带（长期画像）：分歧落在该块内部，块前字节不变、块后不受牵连", () => {
  const a = assembleSystemPrompt("你是助理。", buildFullMemory());
  const b = assembleSystemPrompt(
    "你是助理。",
    buildFullMemory({ userProfileSummary: "这位用户是产品经理，关注 AI 硬件。" }),
  );
  const profilePos = a.stableSystemPrompt.indexOf("【用户长期画像】");
  const lcp = lcpBytes(a.stableSystemPrompt, b.stableSystemPrompt);
  assert.ok(lcp >= profilePos, "画像块之前的内容（CORE+SLOW+理解/事实/关系）必须逐字节相等");
  // 架构收益断言：分歧点必须晚于 CORE 层全部内容（技能索引是 CORE 最靠后的块之一）
  assert.ok(
    profilePos > a.stableSystemPrompt.indexOf("【技能索引】"),
    "MEMORY 带必须沉底：其起点必须晚于 CORE 层（技能索引）",
  );
});

test("改写 MEMORY 带（理解档案）：理解档案之前的 CORE+SLOW 前缀不受影响", () => {
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

test("【持久记忆】留在动态层：召回内容不同不打断稳定前缀", () => {
  const t1 = assembleSystemPrompt("你是助理。", buildFullMemory({ memorySummary: "第一轮命中的行。" }));
  const t2 = assembleSystemPrompt(
    "你是助理。",
    buildFullMemory({ memorySummary: "换了话题后命中的另一批行。" }),
  );
  assert.notEqual(t1.dynamicSystemPrompt, t2.dynamicSystemPrompt, "召回内容确实不同（断言有效性）");
  assert.match(t1.dynamicSystemPrompt ?? "", /【持久记忆】/);
  assert.equal(
    t1.stableSystemPrompt,
    t2.stableSystemPrompt,
    "按轮召回内容改动不得影响稳定层字节——否则会话冻结会把首轮命中灌完全程",
  );
  assert.ok(
    (t1.fullSystemPrompt.indexOf("【持久记忆】")) > (t1.fullSystemPrompt.indexOf("【用户长期画像】")),
    "【持久记忆】必须排在稳定层之后（沉底），不能坐在稳定层中段",
  );
});

test("零命中零注入：memorySummary 缺省时两层都不出现【持久记忆】", () => {
  const { stableSystemPrompt, dynamicSystemPrompt, fullSystemPrompt } = assembleSystemPrompt(
    "你是助理。",
    buildFullMemory({ memorySummary: undefined }),
  );
  assert.doesNotMatch(stableSystemPrompt, /【持久记忆】/);
  assert.doesNotMatch(dynamicSystemPrompt ?? "", /【持久记忆】/);
  assert.doesNotMatch(fullSystemPrompt, /【持久记忆】/);
});
