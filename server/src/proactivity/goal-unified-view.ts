/**
 * 在办事项统一视图（2026-10-23 收敛为 GoalBoard 单源）。
 *
 * 原为 GoalBoard（goals.json）与承诺板的双源只读合并视图；承诺板已下线，
 * 本模块收敛为「在办目标」的单源只读视图，字段结构与前端面板保持不变
 * （source 恒为 "goal"，counts.commitments 恒为 0，避免前端 breaking change）。
 */
import type { GoalBoard, GoalRecord } from "./goal-board.js";

export type UnifiedItem = {
  source: "goal";
  id: string;
  title: string;
  status: string;
  /** track / preexec / plan */
  kind?: GoalRecord["kind"];
  /** goal 才有：`2/5 步，当前「比价酒店」` */
  progress?: string;
  /** 等用户拍板（外部动作待确认 / 已逾期待升级） */
  needsUser: boolean;
  /**
   * 共享发现层里该目标**尚未开口**的发现条数（2026-10-19）。
   * 面板与开口闸读的是同一份台账——"几层就同一件事攒了几条还没说"一眼可见。
   */
  pendingFindings?: number;
};

export type UnifiedGoalView = {
  items: UnifiedItem[];
  counts: {
    goals: number;
    /** 兼容保留（承诺板已下线，恒为 0） */
    commitments: number;
    needsUser: number;
  };
};

export type BuildUnifiedGoalViewDeps = {
  goalBoard: GoalBoard;
  actorId: string;
  /** 计划进度格式化（注入避免本模块依赖 GoalPlanner） */
  progressOf?: (goal: GoalRecord) => string | undefined;
  /** 共享发现层读点：该目标未开口的发现条数（注入避免本模块依赖 DiscoveryLayer） */
  pendingFindingsOf?: (goalId: string) => number;
  now?: () => number;
};

const GOAL_ACTIVE = new Set(["watching", "preparing", "ready"]);

export function buildUnifiedGoalView(deps: BuildUnifiedGoalViewDeps): UnifiedGoalView {
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
      ...(deps.pendingFindingsOf ? { pendingFindings: deps.pendingFindingsOf(goal.goalId) } : {}),
    });
  }

  // 等拍板的排前面（用户视角"该我做事了"），其余按标题稳定排序
  items.sort((a, b) => Number(b.needsUser) - Number(a.needsUser) || a.title.localeCompare(b.title, "zh"));

  return {
    items,
    counts: {
      goals: items.length,
      commitments: 0,
      needsUser: items.filter((i) => i.needsUser).length,
    },
  };
}
