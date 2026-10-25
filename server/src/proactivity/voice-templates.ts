// 主动开口模板族（voice-templates）—— 表达层的零 LLM 基座。
//
// 设计（对应五层架构 L5）：主动性的决策（说不说/何时说/说什么重点）在传感/
// 评估/仲裁层已经完成，语言只负责包装。每个 kind 一组模板，按 dedupKey+小时
// 哈希选变体（有变化感但确定性可复现）。字段缺失时输出兜底句，永不返回空串
// ——LLM 全关，系统依然能自然开口。
//
// 模板原则：第一人称、先说缘由、一句话说重点、不说教不查户口。禁止任何
// "作为AI/根据记录"类机器腔。

export type TemplateCtx = {
  /** 去重键（参与变体选择，同事件重发文本稳定） */
  dedupKey?: string;
  now?: Date;
  // 各模板可选字段（缺了走兜底）
  title?: string;
  summary?: string;
  name?: string;
  sender?: string;
  excerpt?: string;
  hours?: number;
  minutes?: number;
  count?: number;
  /** 关怀类模板的触发原因（continuous_work / late_night_active），决定文案族 */
  reason?: string;
  firstTask?: string;
  weather?: string;
  topic?: string;
  body?: string;
  items?: string[];
};

/** 稳定字符串哈希（变体选择用，确定性） */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 从变体数组中确定性选一条（同 dedupKey+小时 → 同文本） */
function pick(variants: Array<(c: TemplateCtx) => string>, c: TemplateCtx): string {
  const hour = c.now ? c.now.getHours() : 0;
  const idx = hash32(`${c.dedupKey ?? ""}:${hour}`) % variants.length;
  return variants[idx](c);
}

/**
 * 主动开口文本渲染入口。kind 对应 ProactiveIntentKind / 评估器 id，
 * 未知 kind 落到通用族（用 title/body 兜底），永不返回空。
 */
export function renderProactiveText(kind: string, ctx: TemplateCtx): string {
  const now = ctx.now ?? new Date();
  const c: TemplateCtx = { ...ctx, now };
  switch (kind) {
    case "away_return":
      return pick(
        [
          (x) => `回来了？${x.topic ? `之前${x.topic}聊到一半。` : "缓过来了就说一声。"}`,
          () => "人回来了。有事直接说，没事我就在。",
        ],
        c,
      );
    // ── 关怀 ──
    // 2026-10-12 修订：overwork_care 按 reason 分文案——深夜活跃触发不再
    // 硬说「连续 N 小时」（实盘凌晨触发却报「连续3小时」，检测叙事失实）；
    // work_marathon（连续工作评估器）hours 恒有值，保持原话术。
    case "overwork_care":
      if (c.reason === "late_night_active") {
        return pick(
          [
            (x) => `都${x.now?.getHours() ?? 23}点了还醒着。轻音乐我放上了，听完这段就去休息。`,
            (x) => `${x.now?.getHours() ?? 23} 点了，屏幕还亮着。我放了首轻的，你也别硬撑。`,
          ],
          c,
        );
      }
      return pick(
        [
          (x) => (x.hours ? `连续${x.hours}小时了，屏幕都替你累。歇十分钟？我放点轻的。` : "忙了这么久，屏幕都替你累。歇十分钟？我放点轻的。"),
          (x) => (x.hours ? `都${x.hours}个小时没挪窝了。起来走走，水我提醒你接。` : "忙了这么久没挪窝。起来走走，水我提醒你接。"),
        ],
        c,
      );
    case "work_marathon":
      return pick(
        [
          (x) => `连续${x.hours ?? 3}小时了，屏幕都替你累。歇十分钟？我放点轻的。`,
          (x) => `都${x.hours ?? 3}个小时没挪窝了。起来走走，水我提醒你接。`,
        ],
        c,
      );
    case "sleep_boundary":
      return pick(
        [
          (x) => `${x.now?.getHours() ?? 23} 点了，屏幕还亮着。我把今晚的事都收尾了，你也歇着吧。`,
          () => "再熬就透支明天了。灯我给你调暗了。",
        ],
        c,
      );
    // ── 恭喜 ──
    case "task_celebration":
    case "loop_completed":
      return pick(
        [
          (x) => `搞定了：${x.title ?? "那件事"}。这单我记下了。`,
          (x) => `「${x.title ?? "任务"}」闭环。漂亮。`,
        ],
        c,
      );
    // ── 兴趣 ──
    case "interest_alert":
    case "interest_share":
      return pick(
        [
          (x) => `你关注的「${x.name ?? x.title ?? "那个"}」上热搜了：${x.excerpt ?? x.summary ?? ""}`,
          (x) => `刚刷到——「${x.name ?? x.title ?? "你关注的那个"}」有新动态：${x.excerpt ?? x.summary ?? ""}`,
        ],
        c,
      );
    // ── 消息/日程 ──
    case "schedule_change":
      return pick(
        [
          (x) => `${x.sender ?? "有人"}那边说「${x.excerpt ?? x.summary ?? ""}」。要动日程的话说一声，我来改。`,
          (x) => `盯着消息呢——${x.sender ?? "对方"}提到「${x.excerpt ?? x.summary ?? ""}」，需要我调整安排吗？`,
        ],
        c,
      );
    case "meeting_soon":
    case "meeting_prep":
      return pick(
        [
          (x) => `离「${x.title ?? "下一个安排"}」还有${x.minutes ?? 15}分钟${x.body ? `。${x.body}` : "。材料我看了一遍，没坑。"}`,
          (x) => `时间差不多了：「${x.title ?? "会议"}」${x.minutes ?? 15}分钟后开始。${x.body ?? ""}`,
        ],
        c,
      );
    case "weather_alert":
      return pick(
        [
          (x) => `今天${x.weather ?? "天气不好"}，出门记得带伞。`,
          (x) => `提醒一句：${x.weather ?? "外面天气比较极端"}，安排行程时留点余量。`,
        ],
        c,
      );
    // ── 财务/生活 ──
    case "budget_alert":
      return pick(
        [
          (x) => `这个月预算用到 ${x.count ?? 80}% 了。大头在${x.items?.[0] ?? "日常开销"}。`,
          () => "预算快到线了，给你看一眼去向？",
        ],
        c,
      );
    case "renewal_reminder":
    case "bill_due":
      return pick(
        [
          (x) => `「${x.title ?? "一项订阅"}」快到期了${x.count ? `，${x.count} 天后扣费` : ""}。要续还是趁早处理？`,
          () => "有笔费用快到日子了，别让它悄悄扣。",
        ],
        c,
      );
    // ── 目标/预执行 ──
    case "goal_ready":
    case "digest":
    case "morning_brief":
      return c.body ?? pick([() => "今天的事我提前理了一遍。"], c);
    case "initiative":
      return c.body ?? (c.title ? `跟你说个事：${c.title}` : "在忙吗？有件事想说一声。");
    // ── 通用兜底 ──
    default:
      if (c.body) return c.body;
      if (c.summary && c.title) return `${c.title}——${c.summary}`;
      if (c.title) return c.title;
      return "有个情况跟你说一声。";
  }
}

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
