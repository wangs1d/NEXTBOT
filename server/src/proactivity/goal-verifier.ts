/**
 * Goal 验收（2026-10-19，docs/goal-hybrid-architecture.md §4.2 / D3）。
 *
 * 问题的由来：`finishPlan` 的旧判据是「所有步骤 status === done」，而步骤 done 的
 * 判据是「后台任务返回 done」——**执行成功 ≠ 目标达成**。结果是两种病：
 * 假完成（跑完脚本就宣布搞定）、永不收敛（一直追着推）。
 *
 * 两路验收，成本可控：
 *  - **确定性**（0 token）：步骤都要有结果说明；有失败步按比例判 partial/failed。
 *    有 successCriteria 但 done 步骤没写结果 → partial（无法确证，不许宣布完成）。
 *  - **语义**：只在终审做一次，由装配层注入（light 车道 flash）。未注入则跳过，
 *    不阻断——验收是增强，不是关键路径。
 *
 * 铁律：绝不每步都做语义验收（那把成本乘以步数）。
 */
export type GoalVerdict = "met" | "partial" | "failed";

export type VerifyStep = {
  title: string;
  status: string;
  note?: string;
};

export type VerifyInput = {
  title: string;
  /** 达成判据（一句话）；有它才需要「确证」 */
  successCriteria?: string;
  steps: VerifyStep[];
};

export type SemanticVerifier = (
  input: VerifyInput,
) => Promise<{ verdict: GoalVerdict; note: string } | null> | { verdict: GoalVerdict; note: string } | null;

export type VerifyResult = {
  verdict: GoalVerdict;
  note: string;
  mode: "deterministic" | "semantic";
};

const DONE = new Set(["done"]);
const SKIPPED = new Set(["skipped"]);
const FAILED = new Set(["failed"]);

/**
 * 确定性验收（零 token，可测）。
 * 返回 null = 无法判定（步骤为空），调用方按「不阻断」处理。
 */
export function verifyDeterministic(input: VerifyInput): VerifyResult | null {
  const steps = input.steps ?? [];
  if (steps.length === 0) return null;

  const done = steps.filter((s) => DONE.has(s.status));
  const skipped = steps.filter((s) => SKIPPED.has(s.status));
  const failed = steps.filter((s) => FAILED.has(s.status));
  const settled = done.length + skipped.length + failed.length;

  // 还有步骤既没完成也没失败 → 不该走到终审（调用方 bug，保守判 partial）
  if (settled < steps.length) {
    return {
      verdict: "partial",
      note: `还有 ${steps.length - settled} 步没有结论，先不宣布完成`,
      mode: "deterministic",
    };
  }

  if (done.length === 0) {
    return {
      verdict: "failed",
      note: failed.length > 0 ? `没有一步办成（${failed.length} 步失败）` : "所有步骤都被跳过",
      mode: "deterministic",
    };
  }

  if (failed.length > 0) {
    const ratio = done.length / steps.length;
    return {
      verdict: ratio >= 0.5 ? "partial" : "failed",
      note: `${done.length}/${steps.length} 步办成，${failed.length} 步没办成`,
      mode: "deterministic",
    };
  }

  // 全部完成/跳过：有验收条款时，完成的步骤必须留下结果说明才算「确证」
  if (input.successCriteria) {
    const unproven = done.filter((s) => !s.note || !s.note.trim());
    if (unproven.length > 0) {
      return {
        verdict: "partial",
        note: `有 ${unproven.length} 步没留下结果，无法确认「${input.successCriteria}」是否达成`,
        mode: "deterministic",
      };
    }
  }

  return {
    verdict: "met",
    note: skipped.length > 0 ? `${done.length} 步办成、${skipped.length} 步跳过` : `${done.length} 步全部办成`,
    mode: "deterministic",
  };
}

/**
 * 两路验收入口：先确定性；有 successCriteria 且注入了语义验收器时，用语义结论
 * 覆盖（语义能判「办得对不对」，确定性只能判「做没做」）。
 *
 * 语义验收失败/超时 → 回落到确定性结论，绝不因为验收器故障把已办成的事判死。
 */
export async function verifyGoal(
  input: VerifyInput,
  semantic?: SemanticVerifier | null,
): Promise<VerifyResult | null> {
  const deterministic = verifyDeterministic(input);
  if (!semantic || !input.successCriteria) return deterministic;
  try {
    const semanticResult = await semantic(input);
    if (!semanticResult) return deterministic;
    return { ...semanticResult, mode: "semantic" };
  } catch {
    return deterministic;
  }
}
