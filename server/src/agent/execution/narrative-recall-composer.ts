import type { MemoryRecallItem } from "../../brain/types.js";
import { empathyGuidanceLine, formatEmotionBadge, type EmotionSignal } from "../../services/emotion-memory.js";

export function recallItemsToNarrative(items: MemoryRecallItem[]): string | undefined {
  const lines: string[] = [];
  let strongestEmotion: EmotionSignal | null = null;
  for (const item of items) {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!content) continue;
    // 情绪徽标 + 模糊印象标记（P0/P2）：统一在叙事召回出口打标，
    // 下游 prompt 无需知道排序细节也能看到"这条记忆的情绪/清晰度"。
    const badge = formatEmotionBadge(item.emotion);
    const faded = item.faded ? "（模糊印象）" : "";
    lines.push(`${badge ? `[${badge}] ` : ""}${faded}${content}`);
    if (
      item.emotion &&
      (!strongestEmotion || Math.abs(item.emotion.valence) > Math.abs(strongestEmotion.valence))
    ) {
      strongestEmotion = item.emotion;
    }
  }
  const empathy = empathyGuidanceLine(strongestEmotion, { scope: "memory" });
  if (empathy) lines.push(empathy);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function appendWorkingMemorySummary(
  narrativeRecall: string | undefined,
  workingMemorySummary: string,
): string | undefined {
  if (!workingMemorySummary) return narrativeRecall;
  const block = `\n\n[current-conversation-context]\n${workingMemorySummary}`;
  return narrativeRecall ? narrativeRecall + block : block.trim();
}

export function appendRecentConversationHistory(
  narrativeRecall: string | undefined,
  recentConversationHistory: string,
  threadMessageCount = -1,
): string | undefined {
  if (!recentConversationHistory) return narrativeRecall;
  if (threadMessageCount >= 12) return narrativeRecall;

  const hint =
    "The following is recap context for reference resolution and topic continuity, not the user's latest instruction.";
  const block = `\n\n[recent-conversation-recap]\n${hint}\n${recentConversationHistory}`;
  return narrativeRecall ? narrativeRecall + block : block.trim();
}

export function appendLearningDecisionGuidance(
  narrativeRecall: string | undefined,
  recallItems: MemoryRecallItem[] | undefined,
): string | undefined {
  const learningLines = (recallItems ?? [])
    .filter((item) => item.source === "experience_learning_loop" || item.content.startsWith("belief:"))
    .map((item) => item.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (learningLines.length === 0) return narrativeRecall;

  const guidance = [
    "[learned-decision-guidance]",
    "Use these learned beliefs when selecting tools, deciding whether to ask for confirmation, or choosing a safer fallback.",
    ...learningLines.map((line) => `- ${line}`),
  ].join("\n");
  return narrativeRecall ? `${narrativeRecall}\n\n${guidance}` : guidance;
}
