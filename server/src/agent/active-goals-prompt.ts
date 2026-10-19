/**
 * 【在办目标】prompt 块（2026-10-19 三层尺度架构 · P0-A）。
 *
 * 存在的理由（同一性，不是主动性问题）：goal 在后台跑而对话面不知道，
 * 用户问「那事怎么样了」只能靠记忆模糊召回——管家和工具人的分界线就是
 * 「我记得我在替你办，进度是这样」。
 *
 * 成本约束（≤200 tokens）：
 *  - 只取活跃目标前 3 条，一行一个
 *  - 标题截断 30 字，进度用 plan 的 N/M 步
 *  - 超出部分折叠成一句「共 N 个，需要时用 goal.plan.list」
 *
 * 位置约束：只能进动态层。目标进度随步骤推进而变，放稳定层会逐轮打断
 * 整个前缀缓存（实测代价 3-4K tokens/轮）。
 */
import type { GoalBoard, GoalRecord } from "../proactivity/goal-board.js";
import type { GoalPlanner } from "../proactivity/goal-planner.js";

/** 摘要条数上限（也是 token 上限的实际执行点） */
const MAX_SUMMARY_GOALS = 3;
/** 单条标题截断长度 */
const TITLE_MAX = 30;

/** 活跃 = 还在推进中的目标（ready 是"备好了待投递"，也算在办） */
function isActive(goal: GoalRecord): boolean {
  return goal.status !== "done" && goal.status !== "expired";
}

function oneLine(goal: GoalRecord, planner: GoalPlanner | null): string {
  const title = goal.title.length > TITLE_MAX ? `${goal.title.slice(0, TITLE_MAX)}…` : goal.title;
  const kindTag =
    goal.kind === "plan" ? "" : goal.kind === "preexec" ? "（备料）" : "（盯着）";
  // plan 型有步骤状态机，进度最有信息量；其余 kind 只有状态
  if (goal.kind === "plan" && planner) {
    return `· ${title}${kindTag} ${planner.progressLine(goal)}`;
  }
  const statusText =
    goal.status === "ready" ? "已备好，等你用" : goal.status === "preparing" ? "准备中" : "在盯";
  return `· ${title}${kindTag} ${statusText}`;
}

export type BuildActiveGoalsPromptDeps = {
  goalBoard: GoalBoard;
  goalPlanner?: GoalPlanner | null;
  actorId: string;
};

/**
 * 生成【在办目标】块；无活跃目标时返回 null（零注入）。
 * 失败一律返回 null——注入是增强，不是关键路径。
 */
export function buildActiveGoalsPromptBlock(deps: BuildActiveGoalsPromptDeps): string | null {
  const { goalBoard, goalPlanner, actorId } = deps;
  try {
    const active = goalBoard
      .list(actorId)
      .filter(isActive)
      // 计划型优先（有进度可报），其次按创建时间倒序
      .sort((a, b) => {
        const rank = (g: GoalRecord) => (g.kind === "plan" ? 0 : 1);
        return rank(a) - rank(b) || b.createdAt - a.createdAt;
      });
    if (active.length === 0) return null;

    const shown = active.slice(0, MAX_SUMMARY_GOALS).map((g) => oneLine(g, goalPlanner ?? null));
    const lines = [
      "【在办目标】",
      "（后台正在替用户推进的事。用户问起时按这里的进度如实答，别重新打听已知信息；" +
        "要改步骤用 goal.plan.replan，要推进用 goal.plan.advance）",
      ...shown,
    ];
    const rest = active.length - shown.length;
    if (rest > 0) lines.push(`（另有 ${rest} 个在办目标，需要时用 goal.plan.list 查）`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
