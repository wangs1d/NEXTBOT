import type { ScheduleDraft, ScheduleIntentParseResult } from "../services/schedule-intent-service.js";

/** 将 parseForCreate 结果转为工具返回值；创建方在 matched=true 时自行 createTask。 */
export function toolResultFromScheduleParse(
  parsed: ScheduleIntentParseResult,
): { proceed: true; draft: ScheduleDraft } | { proceed: false; result: Record<string, unknown> } {
  if (parsed.matched) {
    return { proceed: true, draft: parsed.draft };
  }
  // 重复方式的确认闸已删（2026-11-25）：解析层只表达"解析不出时间"，重复与否
  // 交给 agent 在工具参数里自己决定。
  return {
    proceed: false,
    result: {
      ok: true,
      matched: false,
      hint: parsed.hint,
    },
  };
}
