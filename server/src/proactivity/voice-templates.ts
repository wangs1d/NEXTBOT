// 表达层辅助渲染（voice-templates）。
//
// 2026-10-27 架构调整：零 LLM 模板族（renderProactiveText / 各 kind 文案族 /
// hasProactiveTemplate）整体删除。私人管家语义下「有重要的事就开口」，话术
// 统一走 SpeechHub light（LLM 基于信号 title/summary/facts 组织语言，不否决、
// 单句必达）：
//   - hub 直达车道：ProactivityHub.submitDirectSpeak → speechHub.speak(light)
//   - 评估器事件：提案不带 directText → 管道 speak 兜底（装配层 → hub 闭环）
// 原模板把内部 title 原样直投给用户的兜底是漏点实证（定时任务错过通报整句
// 弹出）；LLM 全关时系统宁可沉默（沉默日志留痕），绝不吐系统态原句。
//
// 本文件仅保留结构化卡片渲染：简报类内容是数据拼装（多行信息卡），不是
// 话术，继续零 LLM。

/**
 * 晨间简报（morning_brief 映射规则）的卡片正文（多行模板拼接，零 LLM）。
 * 各段数据缺失自动跳段，全缺时输出一句极简开场（保证永不空洞）。
 */
export function renderDigestCard(parts: {
  slot: string;
  tasks?: string[];
  weather?: string | null;
  unread?: string[];
  interests?: string[];
  goals?: string[];
}): string {
  const lines: string[] = [];
  const slotLabel = parts.slot === "morning" ? "早上好" : parts.slot === "midday" ? "下午好" : "晚上好";
  lines.push(`${slotLabel}。今天的事我理了一遍：`);
  if (parts.tasks?.length) {
    lines.push(`· 日程：${parts.tasks.slice(0, 4).join("；")}${parts.tasks.length > 4 ? " 等" : ""}`);
  }
  if (parts.unread?.length) {
    lines.push(`· 未读消息：${parts.unread.slice(0, 3).join("、")}`);
  }
  if (parts.goals?.length) {
    lines.push(`· 我备好了：${parts.goals.slice(0, 3).join("；")}`);
  }
  if (parts.interests?.length) {
    lines.push(`· 你关注的话题：${parts.interests.slice(0, 2).join("；")}`);
  }
  if (parts.weather) {
    lines.push(`· 天气：${parts.weather}`);
  }
  if (lines.length === 1) {
    return "今天日程是空的。有想安排的随时说。";
  }
  return lines.join("\n");
}
