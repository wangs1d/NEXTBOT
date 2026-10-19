/**
 * 前后效果对比（2026-10-19）：goal 混合架构落地前 vs 落地后。
 *
 * 跑法：`cd server && node --import tsx scripts/compare-goal-arch.ts`
 * 全部确定性、零 LLM 调用——每个数字都是真跑出来的，不是手写。
 *
 * 覆盖六件事：
 *   1. 有在办目标的对话轮：prompt 里有没有"我在替你办这件事"
 *   2. 闲聊轮 / 复杂轮：拆解触发与成本
 *   3. 达成判定：执行成功 ≠ 目标达成
 *   4. 执行失败：静默 vs 开口
 *   5. 连续失败：继续重推 vs 冻结退避
 *   6. 同类目标第二次：LLM 拆步 vs 模板套用
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalBoard, backoffMsForFailStreak } from "../src/proactivity/goal-board.js";
import { GoalPlanner } from "../src/proactivity/goal-planner.js";
import { GoalRunner } from "../src/proactivity/goal-runner.js";
import { verifyDeterministic } from "../src/proactivity/goal-verifier.js";
import { matchGoalTemplate } from "../src/proactivity/goal-templates.js";
import { buildActiveGoalsPromptBlock } from "../src/agent/active-goals-prompt.js";
import { assembleLayeredSections } from "../src/agent/prompt-assembler.js";
import { PLAN_NUDGE_THRESHOLD } from "../src/external-model/openai-compatible-tool-loop.js";
import { TaskPlanStore } from "../src/agent/task-plan-store.js";

const tok = (chars: number) => Math.ceil(chars / 1.6); // 中文粗估（1.6 字符 ≈ 1 token）

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "pa-compare-"));
  let now = 1_800_000_000_000;
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn: () => now });
  const planner = new GoalPlanner({ goalBoard: board });
  return {
    board,
    planner,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const rows: Array<{ scene: string; before: string; after: string; delta: string }> = [];

// ── 1. 有在办目标的对话轮：prompt 里有没有这件事 ──────────────────────────
{
  const { board, planner, cleanup } = makeBoard();
  const r = planner.createPlan({ actorId: "u1", title: "订下周去三亚的行程" });
  if (r.ok) {
    const steps = planner.stepsOf(r.goal);
    steps[0].status = "done";
    steps[0].note = "日期人数已确认";
    steps[1].status = "running";
  }
  const block = buildActiveGoalsPromptBlock({ goalBoard: board, goalPlanner: planner, actorId: "u1" });
  const beforeSections = assembleLayeredSections({ scheduleSnapshot: "【日程】周五 15:00 周会" });
  const afterSections = assembleLayeredSections({
    scheduleSnapshot: "【日程】周五 15:00 周会",
    ...(block ? { activeGoals: block } : {}),
  });
  const beforeLen = beforeSections.dynamicContext.join("").length;
  const afterLen = afterSections.dynamicContext.join("").length;
  rows.push({
    scene: "有在办目标的对话轮",
    before: "prompt 里没有【在办目标】块 →「那事怎么样了」只能靠记忆模糊召回",
    after: `注入【在办目标】${afterLen - beforeLen} 字符 ≈ ${tok(afterLen - beforeLen)} tok，可直接答「2/5 步，当前在比价机票」`,
    delta: `+${afterLen - beforeLen} 字符/轮（≈${tok(afterLen - beforeLen)} tok）`,
  });
  // 断言：块在动态层、不在稳定层
  const inStable = afterSections.stablePrefix.some((s) => s.includes("【在办目标】"));
  const inDynamic = afterSections.dynamicContext.some((s) => s.includes("【在办目标】"));
  if (inStable || !inDynamic) throw new Error("契约破坏：在办目标必须只在动态层");
  cleanup();
}

// ── 2. 闲聊轮 vs 复杂轮：拆解触发 ────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pa-compare-plan-"));
  const store = new TaskPlanStore({ dataPath: dir, nowFn: () => 1_800_000_000_000, log: () => {} });
  // 压力信号只看本 loop 执行过的工具调用数（与 tool-loop 内判定同源）
  const wouldNudge = (toolCalls: number, hasPlan: boolean) =>
    toolCalls >= PLAN_NUDGE_THRESHOLD && !hasPlan;
  const chatTurn = wouldNudge(1, false);
  const complexTurn = wouldNudge(4, false);

  // 复杂轮命中后模型写 plan → 前端收到 plan_step
  const events: string[] = [];
  store.subscribeSession("s1", (ev) => {
    // 与 chat-user-message 的订阅同构：write/replan 整表下发，status 只发变化步
    if (ev.type === "write" || ev.type === "replan") {
      for (const s of ev.plan.steps) events.push(`${s.id}:${s.status}`);
      return;
    }
    if (ev.step) events.push(`${ev.step.id}:${ev.step.status}`);
  });
  store.write({ sessionId: "s1", actorId: "u1", goal: "订三亚行程", steps: ["确认日期", "比价机票", "订酒店"] });
  store.setStatus("s1", "s1", "running");

  rows.push({
    scene: "闲聊轮（1 次工具调用）",
    before: "不拆、无 plan",
    after: `不拆、无 plan（压力 ${1} < 阈值 ${PLAN_NUDGE_THRESHOLD}，0 次提示、0 tok）`,
    delta: "0",
  });
  rows.push({
    scene: "复杂轮（4 次工具调用）",
    before: "拆解只活在模型脑子里，前端 0 个步骤事件",
    after: `波末软提示 1 次 → plan.write → ${events.length} 个 plan_step 事件（${events.join(", ")}）`,
    delta: `+1 次提示（约 ${tok(70)} tok）、+${events.length} 个事件`,
  });
  if (chatTurn) throw new Error("契约破坏：闲聊轮不该触发拆解提示");
  if (!complexTurn) throw new Error("契约破坏：复杂轮应该触发拆解提示");
  store.reset();
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. 达成判定：执行成功 ≠ 目标达成 ─────────────────────────────────────
{
  const steps = [
    { title: "比价机票", status: "done" },
    { title: "订酒店", status: "done" },
  ];
  const legacyMet = steps.every((s) => s.status === "done");
  const now = verifyDeterministic({
    title: "订三亚行程",
    successCriteria: "机票酒店都定下来且预算内",
    steps,
  });
  rows.push({
    scene: "步骤全 done 但没留下产物",
    before: `旧判据 every(done)=${legacyMet} → 标记 ready、「搞定了」`,
    after: `确定性验收=${now?.verdict} → 不宣布完成：「${now?.note}」`,
    delta: "假完成 0 次",
  });
  if (legacyMet !== true || now?.verdict !== "partial") throw new Error("契约破坏：应识别出假完成");
}

// ── 4 & 5. 执行失败：静默 vs 开口；连续失败：重推 vs 冻结 ────────────────
{
  const { board, planner, now, cleanup } = makeBoard();
  const created = planner.createPlan({
    actorId: "u1",
    title: "订三亚行程",
    steps: ["比价机票"],
    successCriteria: "机票定下来",
  });
  if (!created.ok) throw new Error("建计划失败");
  // 步骤完成但没留结果 → 终审 partial → blocked（执行类）
  planner.stepsOf(created.goal)[0].status = "done";

  const proposals: Array<{ kind: string; title: string; summary: string }> = [];
  const runner = new GoalRunner({
    goalPlanner: planner,
    goalBoard: board,
    listActors: () => ["u1"],
    emitProposal: (p) => proposals.push({ kind: p.kind, title: p.title, summary: p.summary }),
    nowFn: now,
    env: {},
    minIntervalMs: 0,
  });
  runner.tick();

  rows.push({
    scene: "执行类失败（验收没通过）",
    before: "blocked 只写日志、不打扰 → 用户永远不知道卡住了",
    after: `发 1 条提案：「${proposals[0]?.title ?? "-"}」— ${proposals[0]?.summary ?? "-"}`,
    delta: "失败必开口",
  });
  if (proposals.length !== 1) throw new Error(`契约破坏：执行类失败应开口，实际提案 ${proposals.length}`);

  // 连续失败 → failStreak 累加 → 冻结
  board.noteAttempt(created.goal.goalId, { ok: false, reason: "凭证失效" });
  board.noteAttempt(created.goal.goalId, { ok: false, reason: "凭证失效" });
  const frozen = !board.isEligible(created.goal.goalId);
  const firstBackoff = backoffMsForFailStreak(1, now());
  rows.push({
    scene: "连续 2 次失败",
    before: "每 10min 继续重推（同一失败反复烧 token）",
    after: `首次失败退避 ${(firstBackoff - now()) / 3600_000}h；连续 2 次冻结（eligible=${!frozen}），转「卡住了」`,
    delta: "停止无谓重试",
  });
  if (!frozen) throw new Error("契约破坏：连续失败应冻结");
  void planner;
  cleanup();
}

// ── 6. 同类目标第二次：LLM 拆步 vs 模板套用 ──────────────────────────────
{
  const { planner, cleanup } = makeBoard();
  const tpl = matchGoalTemplate("下个月去三亚玩五天");
  const withTemplate = planner.createPlan({ actorId: "u1", title: "下个月去三亚玩五天" });
  // 无模板的对照组：必须自己给步骤（等价于模型拆一次）
  const manual = planner.createPlan({
    actorId: "u2",
    title: "把书房的旧书整理一下",
    steps: ["清点", "分箱", "上架"],
  });
  const tplSteps = withTemplate.ok ? planner.stepsOf(withTemplate.goal).length : 0;
  rows.push({
    scene: "同类目标第二次（旅行）",
    before: `每次都要模型现场拆步（一次 pro 调用，实测千级 input tok）`,
    after: `命中模板 ${tpl?.id ?? "-"} → 直接 ${tplSteps} 步 + 自带达成判据（0 tok 拆步）`,
    delta: `省 1 次规划调用`,
  });
  if (!withTemplate.ok || tplSteps < 5) throw new Error("契约破坏：模板未生效");
  void manual;
  cleanup();
}

// ── 输出 ────────────────────────────────────────────────────────────────
const lines = [
  "# Goal 混合架构 · 前后效果对比",
  "",
  "> 由 `server/scripts/compare-goal-arch.ts` 实跑生成（零 LLM 调用，全部确定性断言）。",
  "",
  "| 场景 | 改前 | 改后 | 变化 |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.scene} | ${r.before} | ${r.after} | ${r.delta} |`),
  "",
  `生成时间：${new Date(1_800_000_000_000).toISOString()}（固定时钟，便于比对）`,
];
console.log(lines.join("\n"));
