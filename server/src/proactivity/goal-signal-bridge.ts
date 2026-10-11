// GoalSignalBridge —— 感知层 ↔ 目标层双向桥（2026-10-10，docs/proactivity-goal-driven-architecture.md 阶段二）。
//
// 架构差距：传感层 → 9 条固定规则 → 仲裁；目标层 → goal_ready 事件。**两套并行、无交汇**。
// 结果：传感器看到"用户 coding 3 小时"，不会问"这是不是在推进某个目标"；规则产出的
// 主动内容因此"碎片化"（说不了"你计划今天学英语，现在还在写代码，要现在开始吗？"）。
//
// 本模块提供两个方向：
//  方向 A（感知 → 目标）：`activeGoalContext(actorId)` —— 给规则注入"用户当前活跃目标"，
//      让规则文案能带上目标上下文（如 work_marathon 附一句"你今天的计划还有 2 步"）。
//  方向 B（目标 → 感知）：`retrievalRequestFor(goal, step)` —— 判定某步骤是否需要
//      感知层检索（查邮件/日历/热搜），供 GoalRunner 按需发起（本版仅产出"检索意图"，
//      实际执行由装配层接 realtime search / SourceStore 查询完成）。
//
// 零 LLM：两个方向都是确定性判定（活跃目标过滤 + 关键词命中），不下发任何模型调用。
import type { GoalPlanner } from "./goal-planner.js";
import type { GoalRecord } from "./goal-board.js";

/** 活跃目标的最小投影（喂给规则文案，不暴露完整 payload） */
export type ActiveGoalBrief = {
  goalId: string;
  title: string;
  /** 进度一行话（如 "1/4 步，当前「查机票」进行中"） */
  progress: string;
  /** 未完成步数 */
  remaining: number;
  /** 下一步标题（todo 状态；无则空） */
  nextStep: string | null;
};

/** 感知检索请求（方向 B 产出；装配层据此发起 realtime_search / SourceStore 查询） */
export type GoalRetrievalRequest = {
  goalId: string;
  stepId: string;
  /** 检索查询词（纯代码构造，不含 LLM 改写） */
  query: string;
  /** 检索通道：realtime=联网检索；source=查统一采集库（邮件/日历/财务历史） */
  channel: "realtime" | "source";
};

/** 命中"需要外部信息"的步骤动词（比 GoalPlanner 的 act_external 更宽：含查询类） */
const RETRIEVAL_STEP_RE = /(查|搜|找|比价|对比|了解|调研|看看|查询|检索|行情|价格|航班|机票|酒店|天气|路线)/;
/** 命中"查历史数据"的动词（走 SourceStore 而非联网） */
const SOURCE_QUERY_RE = /(邮件|邮件里|日历|账单|记录|之前|上次|历史|我说过|提过)/;

export class GoalSignalBridge {
  constructor(private readonly deps: { goalPlanner: GoalPlanner }) {}

  /**
   * 方向 A：某 actor 当前活跃目标简报（供 mapping-rules 注入文案）。
   * 只取 watch/plan 且未完成的目标；plan 附进度与下一步。
   */
  activeGoalContext(actorId: string, limit = 2): ActiveGoalBrief[] {
    const plans = this.deps.goalPlanner
      .listPlans(actorId)
      .filter((g) => g.status !== "done" && g.status !== "expired" && g.status !== "ready");
    return plans.slice(0, limit).map((g) => this.briefOf(g));
  }

  /** 供规则文案用的"一句话目标上下文"（无活跃目标则返回 null） */
  goalLineFor(actorId: string): string | null {
    const goals = this.activeGoalContext(actorId, 1);
    if (goals.length === 0) return null;
    const g = goals[0];
    if (g.nextStep) return `你还在推进「${g.title}」（${g.progress}），下一步是「${g.nextStep}」`;
    return `你还在推进「${g.title}」（${g.progress}）`;
  }

  private briefOf(goal: GoalRecord): ActiveGoalBrief {
    const steps = this.deps.goalPlanner.stepsOf(goal);
    const remaining = steps.filter((s) => s.status === "todo" || s.status === "doing" || s.status === "awaiting_confirm").length;
    const next = steps.find((s) => s.status === "todo") ?? null;
    return {
      goalId: goal.goalId,
      title: goal.title,
      progress: this.deps.goalPlanner.progressLine(goal),
      remaining,
      nextStep: next?.title ?? null,
    };
  }

  /**
   * 方向 B：判定某步骤是否需要感知层检索，产出检索请求（无则 null）。
   * 查询词纯代码构造（步骤标题去动词），不交给 LLM——与 realtime_lookup 同构。
   */
  retrievalRequestFor(goal: GoalRecord, step: { id: string; title: string }): GoalRetrievalRequest | null {
    const title = String(step.title ?? "").trim();
    if (!title || !RETRIEVAL_STEP_RE.test(title)) return null;
    const channel: GoalRetrievalRequest["channel"] = SOURCE_QUERY_RE.test(title) ? "source" : "realtime";
    const query = composeRetrievalQuery(title);
    if (!query) return null;
    return { goalId: goal.goalId, stepId: step.id, query, channel };
  }
}

/**
 * 检索查询词构造（纯代码）：剥去步骤里的动词/连接词，剩余主体即查询词。
 * 与 media/realtime 查询构造同源纪律——"要不要搜"交代码，"搜什么词"也交代码。
 */
export function composeRetrievalQuery(stepTitle: string): string {
  let q = stepTitle;
  // 剥前导动词（长优先，避免"搜一搜"被"搜"截断；前导礼貌词/连接词一并剥）
  const lead =
    /^(?:(?:请|帮我|帮忙|麻烦|先|再|然后|顺便|给我)\s*)*(?:查一查|查一下|查询|查查|查|搜索一下|搜索|搜一搜|搜一下|搜搜|搜|找一下|找一找|找找|找|了解一下|了解|调研|研究|看看|看一下|看|比价|对比一下|对比)+/;
  q = q.replace(lead, "");
  // 剥尾缀语气词
  q = q.replace(/[吧呢啊呀。，,！!？?]+$/, "").trim();
  // 剥光后退回原步骤标题（恒非空——避免产出空查询词让下游白跑一次）
  return (q || stepTitle).slice(0, 40);
}
