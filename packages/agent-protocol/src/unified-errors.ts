export const UnifiedErrorCode = {
  ValidationError: "VALIDATION_ERROR",
  SessionRequired: "SESSION_REQUIRED",
  Forbidden: "FORBIDDEN",
  BadRequest: "BAD_REQUEST",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",

  // ── 工具调用链路错误码（2026-09-11 链路重构）──
  // 工具结果中的结构化错误分类：LLM 提示词、服务端 metrics、客户端展示共用一套
  // 词汇，替代此前 ad-hoc 的 `{ ok:false, error: string }` 字符串匹配。
  ToolTimeout: "TOOL_TIMEOUT",
  ToolUnknown: "TOOL_UNKNOWN",
  ToolDenied: "TOOL_DENIED",
  ToolUnavailable: "TOOL_UNAVAILABLE",
  ToolArgsMalformed: "TOOL_ARGS_MALFORMED",
  ToolExecutionFailed: "TOOL_EXECUTION_FAILED",
  RouterUnavailable: "ROUTER_UNAVAILABLE",
} as const;

export type UnifiedErrorCodeValue = (typeof UnifiedErrorCode)[keyof typeof UnifiedErrorCode];

/**
 * 工具失败结果的统一形态：任何工具执行失败都携带 `errorCode`，
 * 上层（failure reminder / 观测 / 客户端）按码分类，不再对 error 文本做正则猜测。
 */
export interface ToolFailureShape {
  ok: false;
  result: {
    error: string;
    errorCode?: UnifiedErrorCodeValue | string;
    toolName?: string;
    timeout?: boolean;
    [key: string]: unknown;
  };
}

/** 从工具失败结果中提取结构化错误码（无码时按超时标志与文本启发式兜底分类）。 */
export function classifyToolFailure(result: Record<string, unknown> | undefined): UnifiedErrorCodeValue {
  const code = result?.errorCode;
  if (typeof code === "string" && code.length > 0) {
    return code as UnifiedErrorCodeValue;
  }
  if (result?.timeout === true) return UnifiedErrorCode.ToolTimeout;
  const text = typeof result?.error === "string" ? result.error : "";
  // 超时文本兜底：工具执行超时经 `ToolExecutionTimeoutError` 只带 message
  // （「工具 "x" 执行超时 (30000ms)」），不带 errorCode 也不带 timeout 标志，
  // 此前一律被判成通用的 TOOL_EXECUTION_FAILED —— 超时在指标里与真实失败混在一起，
  // 掩盖了「预算不够而非能力不行」这类问题（2026-10-12 行程规划漏卡即由此隐藏）。
  if (text.includes("执行超时") || text.includes("timed out")) {
    return UnifiedErrorCode.ToolTimeout;
  }
  if (text.includes("未知工具")) return UnifiedErrorCode.ToolUnknown;
  if (text.includes("未拥有") || text.includes("不允许") || text.includes("沙箱")) {
    return UnifiedErrorCode.ToolDenied;
  }
  if (text.includes("不可用") || text.includes("离线") || text.includes("未连接")) {
    return UnifiedErrorCode.ToolUnavailable;
  }
  return UnifiedErrorCode.ToolExecutionFailed;
}
