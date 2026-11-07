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
   * 达成判据（一句话，用户能听懂、verifier 能判）。
   * 2026-11-07 手机端目标页展示用；缺省 = 未设置判据。
   */
  successCriteria?: string;
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
  /**
   * 是否附带已完成/已过期目标（2026-11-07 手机端「已完成」筛选）。
   * 缺省 false——桌面端「在办目标」面板口径不变（只读在办）。
   */
  includeCompleted?: boolean;
};

const GOAL_ACTIVE = new Set(["watching", "preparing", "ready"]);

/**
 * 标题净化（2026-11-07）：历史 eval 数据里存在模型自拟标题带「：undefined」尾巴
 * （如「会前准备：undefined」）。展示出口统一剥掉，剥完为空兜底「未命名目标」；
 * 不改落盘数据（goals.json 是事实源，脏数据留给过期收尾自然淘汰）。
 */
function sanitizeTitle(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[:：]\s*undefined\s*$/i, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "未命名目标";
}

export function buildUnifiedGoalView(deps: BuildUnifiedGoalViewDeps): UnifiedGoalView {
  const items: UnifiedItem[] = [];
  const completed: UnifiedItem[] = [];

  for (const goal of deps.goalBoard.list(deps.actorId)) {
    const isActive = GOAL_ACTIVE.has(goal.status);
    const isCompleted =
      Boolean(deps.includeCompleted) && (goal.status === "done" || goal.status === "expired");
    if (!isActive && !isCompleted) continue;
    const steps = (goal.payload as { steps?: Array<{ status: string }> } | undefined)?.steps;
    const needsUser =
      goal.verdict === "partial" ||
      Boolean(steps?.some((s) => s.status === "awaiting_confirm"));
    // 进度串只对有步骤的目标有意义：track/preexec 无步骤时 progressLine 会给
    // 「0/0 步」，展示是噪音（2026-11-07 手机端截图确认），直接不带 progress。
    const hasSteps = Array.isArray(steps) && steps.length > 0;
    const item: UnifiedItem = {
      source: "goal",
      id: goal.goalId,
      title: sanitizeTitle(goal.title),
      status: goal.status,
      kind: goal.kind,
      ...(deps.progressOf && hasSteps ? { progress: deps.progressOf(goal) } : {}),
      needsUser,
      ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
      ...(deps.pendingFindingsOf ? { pendingFindings: deps.pendingFindingsOf(goal.goalId) } : {}),
    };
    if (isActive) items.push(item);
    else completed.push(item);
  }

  // 等拍板的排前面（用户视角"该我做事了"），其余按标题稳定排序；
  // 已完成/已过期附在在办之后（recent 在前）
  items.sort((a, b) => Number(b.needsUser) - Number(a.needsUser) || a.title.localeCompare(b.title, "zh"));
  completed.sort((a, b) => a.title.localeCompare(b.title, "zh"));

  return {
    items: [...items, ...completed],
    counts: {
      goals: items.length,
      commitments: 0,
      needsUser: items.filter((i) => i.needsUser).length,
    },
  };
}
