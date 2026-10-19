/**
 * TaskPlanProbeRunner —— 等待步的客观完成探测（2026-10-19 handoff，checkMode="probe"）。
 *
 * 为什么要有它：把执行权交给用户后有两种收回方式——用户自己点（显式回执，已接）
 * 和「客观事实已经到了」（订单已签收/日历上已有那条日程/文件已存在）。后者不能靠
 * 模型猜，只能由代码定期查一次确定性事实。
 *
 * 设计纪律（与 GoalRunner 同款）：
 *  - **零 LLM 决策**：本模块只做「该不该查 / 查到了没」的确定性判定，查到即 resume。
 *    resume 之后谁去继续执行不在这里——由装配层注入的 onResumed 决定（起一轮受控
 *    续跑），本模块不碰 provider、不碰 token 预算。
 *  - **节流**：同一步的两次探测至少间隔 minProbeGapMs（默认 5 分钟），
 *    避免每 tick 都去打外部接口。
 *  - **只在能判定时判定**：没有 probe.tool 的等待步一律跳过（退化为用户回执）。
 *  - **不判主观事**：「用户做完了吗」这种没有客观事实的事不要配 probe，
 *    配了也只会在 expect 上永远不命中——所以这条通道不需要猜。
 */
import type { TaskPlan, TaskPlanStep } from "./task-plan-store.js";
import { TaskPlanStore, blockingStepOf } from "./task-plan-store.js";

export type ProbeExecResult = { ok: boolean; result: unknown };

export type TaskPlanProbeRunnerDeps = {
  store: TaskPlanStore;
  /** 执行只读查询工具（装配层接 toolRegistry.execute；工具选择由 plan 里的 probe.tool 决定） */
  executeProbe: (req: {
    actorId: string;
    sessionId: string;
    tool: string;
    args?: Record<string, unknown>;
  }) => Promise<ProbeExecResult>;
  /** 探测命中、步骤已置 done 时回调（装配层据此起一轮受控续跑） */
  onResumed: (input: {
    actorId: string;
    sessionId: string;
    plan: TaskPlan;
    step: TaskPlanStep;
    nextStep: TaskPlanStep | null;
  }) => void;
  nowFn?: () => number;
  /** tick 间隔（默认 60s） */
  intervalMs?: number;
  /** 同一步两次探测的最小间隔（默认 5min） */
  minProbeGapMs?: number;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MIN_PROBE_GAP_MS = 5 * 60_000;

export class TaskPlanProbeRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly nowFn: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly intervalMs: number;
  private readonly minProbeGapMs: number;
  private readonly log: (m: string) => void;
  /** `${planId}:${stepId}` → 最近一次探测时刻（内存节流） */
  private readonly lastProbeAt = new Map<string, number>();

  constructor(private readonly deps: TaskPlanProbeRunnerDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.env = deps.env ?? process.env;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.minProbeGapMs = deps.minProbeGapMs ?? DEFAULT_MIN_PROBE_GAP_MS;
    this.log = deps.log ?? ((m) => console.log(`[PlanProbe] ${m}`));
  }

  private enabled(): boolean {
    const raw = this.env.PLAN_PROBE_RUNNER_ENABLED?.trim().toLowerCase();
    return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
  }

  start(): void {
    if (!this.enabled() || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log(`tick 异常（忽略）：${err}`));
    }, this.intervalMs);
    // Node 不该为轮询保活进程
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 扫一遍所有计划。返回本次命中并已收回的步骤数（测试/观测用）。
   * 单步探测失败不抛出——探测是增强，失败只记日志，绝不影响其它计划。
   */
  async tick(): Promise<number> {
    if (!this.enabled()) return 0;
    const now = this.nowFn();
    let resumedCount = 0;

    for (const plan of this.deps.store.listAll()) {
      const blocking = blockingStepOf(plan);
      const handoff = blocking?.handoff;
      if (!blocking || !handoff || handoff.checkMode !== "probe" || !handoff.probe?.tool) continue;

      const throttleKey = `${plan.planId}:${blocking.id}`;
      const last = this.lastProbeAt.get(throttleKey) ?? 0;
      if (now - last < this.minProbeGapMs) continue;
      this.lastProbeAt.set(throttleKey, now);

      let outcome: ProbeExecResult;
      try {
        outcome = await this.deps.executeProbe({
          actorId: plan.actorId,
          sessionId: plan.sessionId,
          tool: handoff.probe.tool,
          ...(handoff.probe.args ? { args: handoff.probe.args } : {}),
        });
      } catch (err) {
        this.log(`探测失败 plan=${plan.planId} step=${blocking.id}：${err}`);
        continue;
      }
      if (!this.matches(outcome, handoff.probe.expect)) continue;

      const resumed = this.deps.store.resume(plan.sessionId, blocking.id, {
        by: "probe",
        note: `已通过事实探测确认（${handoff.probe.tool}）`,
      });
      if (!resumed.ok) {
        // 并发：用户刚好自己点了 / 计划被重排 → 不需要处理
        this.lastProbeAt.delete(throttleKey);
        continue;
      }
      resumedCount += 1;
      this.lastProbeAt.delete(throttleKey);
      try {
        this.deps.onResumed({
          actorId: plan.actorId,
          sessionId: plan.sessionId,
          plan: resumed.plan,
          step: resumed.step,
          nextStep: resumed.nextStep,
        });
      } catch (err) {
        this.log(`onResumed 回调失败（忽略）：${err}`);
      }
    }

    return resumedCount;
  }

  /**
   * 命中判定：有 expect 就做「结果序列化后包含该字符串」的确定性包含匹配；
   * 没有 expect 就要求工具 ok。**两者都不做语义理解**——这正是 probe 的价值。
   */
  private matches(outcome: ProbeExecResult, expect: string | undefined): boolean {
    const exp = String(expect ?? "").trim();
    if (!exp) return outcome.ok === true;
    let text: string;
    try {
      text = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result ?? "");
    } catch {
      text = "";
    }
    return text.includes(exp);
  }
}
