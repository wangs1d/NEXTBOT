const DIRECT_CLOCK_RE =
  /现在.*几点|几点了|当前.*时间|今天.*几号|今天.*星期|我.*在哪|当前位置|current time|what time|where am i/i;

const RELATIVE_REMINDER_RE =
  /([一二三四五六七八九十\d]+)\s*(分钟|小时|天|周|minute|hour|day|week)\s*(后|later).{0,20}(提醒|叫|喊|remind|wake)/i;

const MULTI_STEP_RE =
  /然后|并且|同时|接着|再|以及|顺便|另外|先.+再|一方面|另一方面|第一步|第二步|首先|其次|最后/i;

const FACT_LOOKUP_RE =
  /搜索|查一下|查询|联网|浏览|天气|新闻|最新|最近|价格|赛程|日程|版本|电影|排片|热映|订票|购票|股价|行情|公告|search|look up|weather|news|latest|recent|price|schedule|version|movie|ticket|stock/i;

export function isSimpleDirectTask(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  if (DIRECT_CLOCK_RE.test(t)) return true;
  if (RELATIVE_REMINDER_RE.test(t)) return true;
  return false;
}

/**
 * 显式计划门槛（2026-10-21）：复杂任务才值得多一次规划调用。
 *
 * 与 requiresTaskDecomposition 的区别：后者把「查一下天气」这类单步事实查询也算
 * 需要拆解（它服务于工具面选择），而显式「计划→执行」只在真正多步/长任务上
 * 划算——加一次 LLM 调用必须换回更少的废波次。故这里排除简单直办、单独事实查询，
 * 只认多步连接词 / 多分句 / 长任务。
 */
export function requiresExplicitPlan(message: string): boolean {
  if (isSimpleDirectTask(message)) return false;
  const t = message.trim();
  if (!t) return false;
  if (MULTI_STEP_RE.test(t)) return true;
  const clauses = t.split(/[，；,;]/).filter((s) => s.trim().length > 4);
  if (clauses.length >= 3) return true;
  return t.length > 160;
}

export function requiresTaskDecomposition(message: string): boolean {
  if (isSimpleDirectTask(message)) return false;

  const t = message.trim();
  if (MULTI_STEP_RE.test(t)) return true;
  if (FACT_LOOKUP_RE.test(t)) return true;

  const clauses = t.split(/[，；,;]/).filter((s) => s.trim().length > 4);
  if (clauses.length >= 2) return true;

  return t.length > 96;
}
