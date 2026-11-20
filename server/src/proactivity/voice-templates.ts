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

/** 丢掉空串/纯空白项——数据源（如 interestLines）无数据时可能回 [""]，不能据此渲染空标题 */
function cleanLines(items: string[] | undefined): string[] {
  return (items ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
}

/**
 * 晨间简报（morning_brief 映射规则）的卡片正文（多行模板拼接，零 LLM）。
 *
 * 规则（2026-11-19 用户拍板）：
 *   - **天气不在此展示**（2026-10-16 已迁睡前提醒，这条路径此前漏改，现删）；
 *   - **只有有真实数据的段才渲染**（空串过滤后长度为 0 就跳段），
 *     例如「你关注的话题」无数据就整行不出现，不再留一个冒号吊着。
 * 各段数据缺失自动跳段，全缺时输出一句极简开场（保证永不空洞）。
 */
export function renderDigestCard(parts: {
  slot: string;
  tasks?: string[];
  unread?: string[];
  interests?: string[];
  goals?: string[];
  // weather 字段刻意移除：天气不进这条卡片（迁睡前提醒）。
}): string {
  const lines: string[] = [];
  const slotLabel = parts.slot === "morning" ? "早上好" : parts.slot === "midday" ? "下午好" : "晚上好";
  const tasks = cleanLines(parts.tasks);
  const unread = cleanLines(parts.unread);
  const goals = cleanLines(parts.goals);
  const interests = cleanLines(parts.interests);

  if (tasks.length) {
    lines.push(`· 日程：${tasks.slice(0, 4).join("；")}${tasks.length > 4 ? " 等" : ""}`);
  }
  if (unread.length) {
    lines.push(`· 未读消息：${unread.slice(0, 3).join("、")}`);
  }
  if (goals.length) {
    lines.push(`· 我备好了：${goals.slice(0, 3).join("；")}`);
  }
  if (interests.length) {
    lines.push(`· 你关注的话题：${interests.slice(0, 2).join("；")}`);
  }
  if (lines.length === 0) {
    return "今天日程是空的。有想安排的随时说。";
  }
  return `${slotLabel}。今天的事我理了一遍：\n${lines.join("\n")}`;
}
