/**
 * 在办事项统一视图（2026-10-19，docs/goal-hybrid-architecture.md §2 / P2 台账收敛的过渡态）。
 *
 * 现状是两套台账各自为政：GoalBoard（goals.json，目标/预执行/计划）与
 * CommitmentBoard（SQLite，承诺契约，带证据链和升级策略）。
 *
 * **为什么不直接迁表**：承诺板的价值在证据链（evidenceLedgerIds）、梯度提醒、
 * 升级退避、第三方代催渠道——这些字段搬进 goals.json 等于把两套生命周期硬缝在
 * 一起，风险远大于收益。所以先做**一张只读视图**：一个口子看到"在办的事"，
 * 存储仍各自管；等视图跑顺、真正重叠的语义显形，再谈同表。
 *
 * 用户/前端拿它当"在办事项"面板；成本报告按 source 分别归因。
 */
import type { GoalBoard, GoalRecord } from "./goal-board.js";
import type { CommitmentBoard, CommitmentRecord } from "../agentic-memory/commitment-board.js";

export type UnifiedItem = {
  source: "goal" | "commitment";
  id: string;
  title: string;
  status: string;
  /** goal 才有：track / preexec / plan */
  kind?: GoalRecord["kind"];
  /** 承诺才有：截止时间 ISO */
  due?: string | null;
  /** goal 才有：`2/5 步，当前「比价酒店」` */
  progress?: string;
  /** 等用户拍板（外部动作待确认 / 承诺待确认 / 已逾期待升级） */
  needsUser: boolean;
};

export type UnifiedGoalView = {
  items: UnifiedItem[];
  counts: {
    goals: number;
    commitments: number;
    needsUser: number;
  };
};

export type BuildUnifiedGoalViewDeps = {
  goalBoard: GoalBoard;
  commitmentBoard?: CommitmentBoard | null;
  actorId: string;
  /** 计划进度格式化（注入避免本模块依赖 GoalPlanner） */
  progressOf?: (goal: GoalRecord) => string | undefined;
  now?: () => number;
};

const GOAL_ACTIVE = new Set(["watching", "preparing", "ready"]);
const COMMITMENT_ACTIVE = new Set(["pending_confirmation", "active"]);

export function buildUnifiedGoalView(deps: BuildUnifiedGoalViewDeps): UnifiedGoalView {
  const now = (deps.now ?? Date.now)();
  const items: UnifiedItem[] = [];

  for (const goal of deps.goalBoard.list(deps.actorId)) {
    if (!GOAL_ACTIVE.has(goal.status)) continue;
    const steps = (goal.payload as { steps?: Array<{ status: string }> } | undefined)?.steps;
    const needsUser =
      goal.verdict === "partial" ||
      Boolean(steps?.some((s) => s.status === "awaiting_confirm"));
    items.push({
      source: "goal",
      id: goal.goalId,
      title: goal.title,
      status: goal.status,
      kind: goal.kind,
      ...(deps.progressOf ? { progress: deps.progressOf(goal) } : {}),
      needsUser,
    });
  }

  let commitmentCount = 0;
  try {
    const rows: CommitmentRecord[] =
      deps.commitmentBoard?.list({ actorId: deps.actorId, limit: 50 }) ?? [];
    for (const c of rows) {
      if (!COMMITMENT_ACTIVE.has(c.status)) continue;
      commitmentCount += 1;
      const overdue = Boolean(c.deadline && new Date(c.deadline).getTime() < now);
      items.push({
        source: "commitment",
        id: c.id,
        title: c.text.slice(0, 120),
        status: c.status,
        due: c.deadline,
        needsUser: c.status === "pending_confirmation" || overdue,
      });
    }
  } catch {
    /* 承诺板未装配/查询失败：视图只出 goal 部分，不影响主流程 */
  }

  // 等拍板的排前面（用户视角"该我做事了"），其余按标题稳定排序
  items.sort((a, b) => Number(b.needsUser) - Number(a.needsUser) || a.title.localeCompare(b.title, "zh"));

  return {
    items,
    counts: {
      goals: items.filter((i) => i.source === "goal").length,
      commitments: commitmentCount,
      needsUser: items.filter((i) => i.needsUser).length,
    },
  };
}
