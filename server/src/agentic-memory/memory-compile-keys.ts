/**
 * 编译幂等键（纯函数，无 IO）——单测直接引用，不加载 SQLite 原生依赖。
 * 账本实现见 memory-compile-ledger.ts。
 */

import { createHash } from "node:crypto";

export type CompileStage =
  | "extract" // L0 → L1：日志抽事实/偏好/承诺
  | "reconcile" // L1 冲突裁决 / 画像收敛
  | "abstract" // L1 → L2：场景抽象（dream）
  | "reflect" // L2 → L3：画像反思 / 灵魂
  | "fixate"; // L0 原文固化进长期图

export type CompileOp = {
  actorId: string;
  /** 事件所在日 `YYYY-MM-DD`（不是运行日） */
  day: string;
  stage: CompileStage;
  /** 语义类型，如 fact.profile / fact.tail / commitment / journal.line */
  opType: string;
  /** 去重目标：字段名、归一文本、日志行键 */
  target: string;
  value?: string;
  evidence?: string[];
  eventTime?: string;
};

export function normalizeCompileDay(day: string): string {
  const m = day.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : new Date().toISOString().slice(0, 10);
}

/**
 * op 指纹：同一天同一目标同值的重放是同一 op；值变了就是新 op
 * （由业务侧 supersede 旧值）。
 */
export function compileOpHash(op: CompileOp): string {
  return createHash("sha1")
    .update(
      [
        op.actorId,
        normalizeCompileDay(op.day),
        op.stage,
        op.opType,
        op.target,
        op.value ?? "",
      ].join("\u0001"),
    )
    .digest("hex");
}

export function compileRunInputHash(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
