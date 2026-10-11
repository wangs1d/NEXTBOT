import { requiresTaskDecomposition } from "./simple-task.js";
import type { TurnUnderstanding } from "./task-router.js";

export type TaskContextProfile = {
  complexity: "direct" | "multi_step";
  needsNarrativeRecall: boolean;
  likelyNeedsFreshFacts: boolean;
  likelyPersistsState: boolean;
  likelyCodeOrProjectWork: boolean;
};

// 导出供出口自检复用（agent-core 对话面闪避兜底：实时类请求 + 闪避话术 → 转任务面）。
export const FRESH_FACT_RE =
  /latest|recent|today|tomorrow|yesterday|current|now|news|price|weather|schedule|score|version|release|202[0-9]|最新|最近|今天|明天|昨天|现在|当前|新闻|价格|天气|日程|赛程|版本|发布|查一下|搜索|联网|浏览/i;

const PERSISTENT_ACTION_RE =
  /remind|schedule|calendar|book|buy|send|call|delete|update|create|save|commit|push|deploy|提醒|日程|预约|购买|发送|拨打|删除|更新|创建|保存|提交|推送|部署/i;

const CODE_OR_PROJECT_RE =
  /code|repo|project|file|bug|test|build|lint|typescript|javascript|flutter|server|client|代码|项目|文件|报错|测试|构建|类型|前端|后端|优化|修复|实现/i;

export function buildTaskContextProfile(
  message: string,
  understanding?: TurnUnderstanding,
): TaskContextProfile {
  const t = message.trim();
  return {
    complexity: requiresTaskDecomposition(t) ? "multi_step" : "direct",
    // 召回需求（2026-10-10 词表判定退役）：优先读模型判定（recallIntent/
    // memoryInstruction/锚定上文）；understanding 缺省（路由失败）退化为
    // 长度启发（短句不召回——原 shouldSkipNarrativeRecall 的非追问主干的近似）。
    needsNarrativeRecall: understanding
      ? understanding.recallIntent ||
        understanding.memoryInstruction ||
        understanding.reference !== "none"
      : t.length > 16,
    likelyNeedsFreshFacts: FRESH_FACT_RE.test(t),
    likelyPersistsState: PERSISTENT_ACTION_RE.test(t),
    likelyCodeOrProjectWork: CODE_OR_PROJECT_RE.test(t),
  };
}

function compactTaskFlags(profile: TaskContextProfile): string {
  const flags: string[] = [];
  if (profile.complexity === "multi_step") flags.push("multi-step");
  if (profile.needsNarrativeRecall) flags.push("recall");
  if (profile.likelyNeedsFreshFacts) flags.push("fresh-facts");
  if (profile.likelyPersistsState) flags.push("state-change");
  if (profile.likelyCodeOrProjectWork) flags.push("code");
  return flags.join(", ");
}

export function buildTaskContextPrompt(
  message: string,
  understanding?: TurnUnderstanding,
  now: Date = new Date(),
): string | undefined {
  const profile = buildTaskContextProfile(message, understanding);
  const flags = compactTaskFlags(profile);

  const needsDetailedPolicy =
    profile.complexity === "multi_step" ||
    profile.needsNarrativeRecall ||
    profile.likelyNeedsFreshFacts ||
    profile.likelyPersistsState ||
    profile.likelyCodeOrProjectWork;

  if (!needsDetailedPolicy) {
    return undefined;
  }

  return [
    `CTX|now=${now.toISOString()}|flags=${flags || "direct"}`,
    "POLICY|facts=tool-first|state=verify+report|code=inspect-first|final=state-blockers",
  ].join("\n");
}
