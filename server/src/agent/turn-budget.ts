/**
 * 单轮 LLM 主路径预算（阶段2-1：重试梯子收敛）。
 *
 * 背景：此前一次用户消息最坏要经历 主调用 → 多道升级闸各自整体重跑
 * runStandardLlmPath(task) → handleUserMessage 兜底 emergencyRegenerate，
 * 五个重试/升级点各有独立的「只触发一次」标志，没有共享预算——最坏耗时
 * 是各层上限的乘积级叠加，且无法观测。
 *
 * TurnBudget 用一个显式计数器把「本轮最多跑几次 LLM 主路径」变成构造保证：
 * 默认 3（1 次主调用 + 至多 2 次升级重跑），AGENT_TURN_BUDGET_MAX_PATHS 可调。
 * 预算耗尽时升级按各自语义降级：意图升级如实上抛、其余落到正常收尾。
 */
export class TurnBudget {
  private used = 0;

  constructor(readonly max: number = resolveTurnBudgetMaxPaths()) {}

  /** 主路径占用一个槽位（首次进入 runStandardLlmPath 时调用，始终放行）。 */
  consumeMainPath(): void {
    this.used += 1;
  }

  /** 升级重跑前调用：预算内则占用并放行，超限拒绝并记录。 */
  tryUpgrade(reason: string): boolean {
    this.used += 1;
    if (this.used > this.max) {
      console.warn(
        `[TurnBudget] 升级被拒（${reason}）：本轮 LLM 主路径预算耗尽（${this.used - 1}/${this.max}），按现有结果收尾`,
      );
      return false;
    }
    console.info(`[TurnBudget] 升级放行（${reason}）：${this.used}/${this.max}`);
    return true;
  }

  get usedCount(): number {
    return this.used;
  }
}

function resolveTurnBudgetMaxPaths(): number {
  const n = Number.parseInt(process.env.AGENT_TURN_BUDGET_MAX_PATHS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
