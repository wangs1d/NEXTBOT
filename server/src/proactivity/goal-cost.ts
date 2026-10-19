/**
 * Goal 成本-产出报告（2026-10-19，docs/goal-hybrid-architecture.md §4.4）。
 *
 * 存在的理由：没有这个闭环，能力不会自己变强——只是跑得更多。
 * 有了它才能回答：哪类目标花的 token 多、达成率高；哪些步骤总是失败该写回模板。
 *
 * 数据源两处，都不新增状态：
 *  - goalBoard / goalPlanner：目标数、步骤数、验收结论（确定性）
 *  - llm-token-audit：`goal_plan_stage` 的 token 占比（验收指标 ≤15%）
 */
import { getLlmUsageSummaryFromDisk } from "../services/llm-token-audit.js";
import type { GoalBoard, GoalRecord } from "./goal-board.js";
import type { GoalPlanner } from "./goal-planner.js";

export type GoalCostRow = {
  kind: GoalRecord["kind"];
  goals: number;
  steps: number;
  met: number;
  partial: number;
  failed: number;
  unresolved: number;
  /** 达成率 = met / (met+partial+failed)；无已验收目标时为 null */
  metRate: number | null;
};

export type GoalCostReport = {
  actorId: string | null;
  rows: GoalCostRow[];
  totals: {
    goals: number;
    steps: number;
    verified: number;
  };
  token: {
    /** goal 计划步骤专属 stage 的 token（审计口径） */
    goalStageTokens: number;
    allTokens: number;
    /** 占全量比例（0-1）；全量为 0 时为 null */
    goalStageShare: number | null;
  };
};

export type BuildGoalCostReportDeps = {
  goalBoard: GoalBoard;
  goalPlanner?: GoalPlanner | null;
  /** null = 全量（运维面） */
  actorId?: string | null;
  /** 测试注入：替代审计读取 */
  readAudit?: () => Array<{ stage: string; totalTokens: number }>;
};

function emptyRow(kind: GoalRecord["kind"]): GoalCostRow {
  return { kind, goals: 0, steps: 0, met: 0, partial: 0, failed: 0, unresolved: 0, metRate: null };
}

export function buildGoalCostReport(deps: BuildGoalCostReportDeps): GoalCostReport {
  const actorId = deps.actorId ?? null;
  const goals = actorId ? deps.goalBoard.list(actorId) : deps.goalBoard.list();

  const rowsByKind = new Map<GoalRecord["kind"], GoalCostRow>();
  let stepsTotal = 0;
  let verifiedTotal = 0;

  for (const goal of goals) {
    const row = rowsByKind.get(goal.kind) ?? emptyRow(goal.kind);
    row.goals += 1;
    const steps = goal.kind === "plan" && deps.goalPlanner ? deps.goalPlanner.stepsOf(goal).length : 0;
    row.steps += steps;
    stepsTotal += steps;
    if (goal.verdict === "met") {
      row.met += 1;
      verifiedTotal += 1;
    } else if (goal.verdict === "partial") {
      row.partial += 1;
      verifiedTotal += 1;
    } else if (goal.verdict === "failed") {
      row.failed += 1;
      verifiedTotal += 1;
    } else {
      row.unresolved += 1;
    }
    rowsByKind.set(goal.kind, row);
  }

  for (const row of rowsByKind.values()) {
    const settled = row.met + row.partial + row.failed;
    row.metRate = settled > 0 ? Number((row.met / settled).toFixed(3)) : null;
  }

  let goalStageTokens = 0;
  let allTokens = 0;
  try {
    const summary = deps.readAudit
      ? deps.readAudit()
      : getLlmUsageSummaryFromDisk().map((r) => ({ stage: r.stage, totalTokens: r.totalTokens }));
    for (const r of summary) {
      allTokens += r.totalTokens;
      if (r.stage === "goal_plan_stage") goalStageTokens += r.totalTokens;
    }
  } catch {
    /* 审计读不到不影响台账部分 */
  }

  return {
    actorId,
    rows: [...rowsByKind.values()].sort((a, b) => b.goals - a.goals),
    totals: { goals: goals.length, steps: stepsTotal, verified: verifiedTotal },
    token: {
      goalStageTokens,
      allTokens,
      goalStageShare: allTokens > 0 ? Number((goalStageTokens / allTokens).toFixed(4)) : null,
    },
  };
}
