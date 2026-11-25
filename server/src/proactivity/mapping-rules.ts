// 映射规则表（mapping-rules）—— 主动性场景的声明式清单（一条规则 = 一个场景）。
//
// 设计定稿（2026-09-24 用户拍板）：决策=程序对号入座。每条规则每分钟读一次
// 世界状态板（分层"现在"），状态条件命中 → 模板直出正文（voice-templates，
// 零 LLM）→ 产出事件交仲裁层。加场景=在 buildBoardRules 数组里加一行，不改执行器。
//
// 规则来源：原 builtin-evaluators 确定性场景整体迁移（语义一一对应，
// 数据源从"信号缓冲窗口"换成"状态板字段"）：
//   meeting_soon / digest_beat / goal_ready / sleep_boundary / morning_brief
//   （away_return / work_marathon / unread_burst / spend_alert 已于 2026-11-19
//    按用户拍板整体下线，见 proactivity/module.ts 的模块层说明）
import { renderDigestCard } from "./voice-templates.js";
import type { BoardRule, RuleServices } from "./mapping-executor.js";

type BoardView = Parameters<BoardRule["eval"]>[0]["board"];

function readField<T>(board: BoardView, layer: "obligations" | "current" | "session" | "background", key: string): T | undefined {
  return board[layer]?.[key] as T | undefined;
}

/** 屏幕焦点板值 */
type ScreenFocus = { kind: string; since: number; lastSeenAt: number };
/** presence 板值 */
type Presence = { state: string; since: number };
/** 日程板值 */
type NextEvent = { title: string; runAt: number; updatedAt: number };

/** 本地当天的某个整点（毫秒）：给「只在上午有意义」的晨报做保质期 */
function localHourToday(now: Date, hour: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).getTime();
}

/**
 * 构建全部映射规则。services 全部可选——缺哪个数据源就自动跳过对应段，
 * 系统在最小依赖下也能运行（真实使用的鲁棒性要求）。
 */
export function buildBoardRules(services: RuleServices): BoardRule[] {
  return [
    // 1. meeting_soon：临近日程双提前量（60min normal / 15min alert）
    {
      id: "meeting_soon",
      layers: ["obligations"],
      async eval(ctx) {
        const st = ctx.state;
        const announced = (st.get("announced") as Map<string, number>) ?? new Map();
        st.set("announced", announced);
        const out: ReturnType<BoardRule["eval"]> = [];
        const next = readField<NextEvent>(ctx.board, "obligations", "nextEvent");
        if (!next) return out;
        // 距会分钟数现场推导：板上是任务集合变化时刻的快照，以 runAt 为基准
        // 换算当前剩余分钟才是活值
        const min = Math.round((next.runAt - ctx.nowMs) / 60_000);
        const title = next.title || "下一个安排";
        if (min <= 0) return out;
        // 过期清理（runAt 已过/已提醒超过一天的键）
        for (const [k, v] of announced) if (next.runAt - v > 24 * 3600_000) announced.delete(k);

        const briefMin = 15;
        const earlyMin = 60;
        if (min <= briefMin && !announced.has(`brief:${next.runAt}`)) {
          announced.set(`brief:${next.runAt}`, Date.now());
          const memoryLines = services.recallMemory ? await services.recallMemory(ctx.actorId, title, 2) : [];
          out.push({
            kind: "meeting_soon",
            urgency: "alert",
            proposalKind: "schedule_upcoming",
            // must 层：临会提醒是用户点名要的事，必达且不占社交预算
            tier: "must",
            importance: "high",
            title: `「${title}」${min} 分钟后开始`,
            // 相关记忆作为素材喂 LLM 话术层（body 留空 → 管道 speak 兜底）
            summary: memoryLines.length ? `相关记忆：${memoryLines.join("；")}` : "",
            body: "",
            dedupKey: `meeting_brief:${next.runAt}`,
            salience: "high",
            expiresAt: next.runAt,
          });
          return out;
        }
        if (min > briefMin && min <= earlyMin && !announced.has(`early:${next.runAt}`)) {
          announced.set(`early:${next.runAt}`, Date.now());
          out.push({
            kind: "meeting_soon_early",
            urgency: "normal",
            proposalKind: "meeting_early",
            tier: "social",
            importance: "low",
            title: `「${title}」1 小时内开始`,
            // body 留空 → 提案无 directText → 管道 speak 兜底（LLM 话术）
            body: "",
            dedupKey: `meeting_early:${next.runAt}`,
            salience: "low",
          });
        }
        return out;
      },
    },

    // 2. goal_ready：预执行目标就绪 —— "哇"时刻的投递触发
    {
      id: "goal_ready",
      layers: ["obligations"],
      eval(ctx) {
        const st = ctx.state;
        const out: ReturnType<BoardRule["eval"]> = [];
        const recent = readField<Array<{ at: number; goalId: string; title: string; body: string }>>(
          ctx.board,
          "obligations",
          "recentGoals",
        );
        for (const g of recent ?? []) {
          if (!g.goalId || st.has(`fired:${g.goalId}`)) continue;
          st.set(`fired:${g.goalId}`, true);
          out.push({
            kind: "goal_ready",
            urgency: "normal",
            proposalKind: "life_reminder",
            tier: "social",
            importance: "medium",
            title: g.title || "有结果了",
            // 生产者成稿优先；无成稿 body 留空 → 管道 speak 兜底（LLM 话术）
            body: g.body || "",
            dedupKey: `goal_ready:${g.goalId}`,
            salience: "medium",
          });
        }
        return out;
      },
    },

    // 6. sleep_boundary：23 点屏幕仍活跃 —— 节律关怀
    {
      id: "sleep_boundary",
      layers: ["current"],
      tickEveryMs: 15 * 60_000,
      eval(ctx) {
        if (ctx.now.getHours() !== 23) return [];
        const dayKey = ctx.now.toISOString().slice(0, 10);
        if (ctx.state.has(dayKey)) return [];
        const focus = readField<ScreenFocus>(ctx.board, "current", "screenFocus");
        const kind = focus?.kind ?? "";
        const activeKinds = ["coding", "terminal", "browsing", "video", "game", "office", "chat"];
        if (!activeKinds.includes(kind)) return [];
        ctx.state.set(dayKey, true);
        return [
          {
            kind: "sleep_boundary",
            urgency: "normal",
            proposalKind: "sleep_care",
            tier: "social",
            importance: "low",
            title: "深夜还在屏幕前",
            // body 留空 → 提案无 directText → 管道 speak 兜底（LLM 话术）
            body: "",
            dedupKey: `sleep_boundary:${dayKey}`,
            salience: "low",
            // 过了当晚就失去意义：早晨说「昨晚该睡了」是噪音，最多保留到凌晨 1 点
            expiresAt: ctx.nowMs + (60 - ctx.now.getMinutes()) * 60_000 + 60 * 60_000,
          },
        ];
      },
    },

    // 7. morning_brief：晨间唤醒触发（7-10 点首次活跃）—— 旗舰预执行场景
    {
      id: "morning_brief",
      layers: ["current"],
      tickEveryMs: 5 * 60_000,
      eval(ctx) {
        const st = ctx.state;
        const dayKey = ctx.now.toISOString().slice(0, 10);
        const hour = ctx.now.getHours();
        const presence = readField<Presence>(ctx.board, "current", "presence");
        const presenceState = presence?.state ?? "offline";
        const lastBriefDay = (st.get("lastBriefDay") as string | null) ?? null;
        if (lastBriefDay === dayKey) return [];
        // 触发：7-10 点且用户变为 active（唤醒/开机），或兜底 8:30 后仍无触发
        const wakeTrigger = presenceState === "active" && hour >= 7 && hour < 10;
        const fallbackTrigger = hour === 8 && ctx.now.getMinutes() >= 30;
        if (!wakeTrigger && !fallbackTrigger) return [];
        st.set("lastBriefDay", dayKey);
        const clean = (xs: string[]): string[] => xs.map((s) => String(s ?? "").trim()).filter(Boolean);
        const tasks = clean((services.listTodayTasks?.(ctx.actorId) ?? []).map((t) => t.title));
        const unread = clean(services.unreadSenders?.(ctx.actorId) ?? []);
        const interests = clean(services.interestLines?.(ctx.actorId) ?? []);
        const goals = clean((services.readyGoals?.(ctx.actorId) ?? []).map((g) => g.title));
        const body = renderDigestCard({ slot: "morning", tasks, unread, interests, goals });

        // 「需要你拍板」按钮按本条晨报真实内容生成（2026-11-19 用户拍板：动态、
        // 最多两个、不要硬编码）。主按钮文案跟着主导数据块走，次按钮固定「稍后再说」
        // （唯一有真执行器语义的推迟动作）。没有任何数据 → 不给按钮，整行不渲染。
        const notifyOptions: Array<{ action: "acknowledge" | "snooze"; label: string }> = [];
        const primary =
          unread.length ? "去看看消息"
          : tasks.length || goals.length ? "看看今天安排"
          : interests.length ? "聊聊这个话题"
          : "";
        if (primary) {
          notifyOptions.push({ action: "acknowledge", label: primary });
          notifyOptions.push({ action: "snooze", label: "稍后再说" });
        }
        return [
          {
            kind: "morning_brief",
            urgency: "normal",
            proposalKind: "greeting",
            tier: "social",
            importance: "low",
            // PROACTIVE_MORNING_CALL=1：晨间简报升级为来电汇报（通话内可对话）
            ...(process.env.PROACTIVE_MORNING_CALL === "1" ? { callPolicy: "always" as const } : {}),
            title: "晨间简报",
            body,
            dedupKey: `morning_brief:${dayKey}`,
            salience: "medium",
            // 晨报只在上午有意义（2026-11-25 实证）：保质期到当天中午。排槽若把它
            // 排到下午/夜里，或首次解锁拖到晚上，仲裁层按 expired 丢弃——绝不把
            // 「今天两场会」当晚安推。
            expiresAt: localHourToday(ctx.now, 12),
            ...(notifyOptions.length ? { notifyOptions } : {}),
          },
        ];
      },
    },
  ];
}
