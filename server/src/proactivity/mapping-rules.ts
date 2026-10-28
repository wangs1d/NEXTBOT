// 映射规则表（mapping-rules）—— 主动性场景的声明式清单（一条规则 = 一个场景）。
//
// 设计定稿（2026-09-24 用户拍板）：决策=程序对号入座。每条规则每分钟读一次
// 世界状态板（分层"现在"），状态条件命中 → 模板直出正文（voice-templates，
// 零 LLM）→ 产出事件交仲裁层。加场景=在 buildBoardRules 数组里加一行，不改执行器。
//
// 规则来源：原 builtin-evaluators 九个确定性场景整体迁移（语义一一对应，
// 数据源从"信号缓冲窗口"换成"状态板字段"）：
//   away_return / meeting_soon / work_marathon / unread_burst / digest_beat /
//   goal_ready / sleep_boundary / morning_brief
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
/** 账本板值（finance 流收编后由世界板写入 current.recentTx） */
type LedgerTx = { at: number; id: string; amount: number; type: string; merchant?: string; category?: string };

/** 单笔支出提醒阈值（元）：低于此值静默入账，不打扰。env 可调。 */
const SPEND_ALERT_AMOUNT = (() => {
  const raw = Number(process.env.PROACTIVITY_SPEND_ALERT_AMOUNT);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

/**
 * 构建全部映射规则。services 全部可选——缺哪个数据源就自动跳过对应段，
 * 系统在最小依赖下也能运行（真实使用的鲁棒性要求）。
 */
export function buildBoardRules(services: RuleServices): BoardRule[] {
  return [
    // 1. away_return：用户长时间离开后回归 —— 久别问候 / 接续话题的时机
    //    只认"白天真实离开"：离开起点在 7-22 点、且离开窗口不跨静默时段——
    //    跨夜的"离开"是睡眠，晨间简报（morning_brief）已覆盖，不双发打扰
    {
      id: "away_return",
      layers: ["current"],
      eval(ctx) {
        const st = ctx.state;
        const idleSince = (st.get("idleSince") as number | null) ?? null;
        const presence = readField<Presence>(ctx.board, "current", "presence");
        const out: ReturnType<BoardRule["eval"]> = [];
        if (!presence) return out;
        if (presence.state === "idle" || presence.state === "offline") {
          if (idleSince === null) st.set("idleSince", presence.since);
          return out;
        }
        if (presence.state !== "active" || idleSince === null) return out;
        // 回归：离开时长 = 活跃起点 - 离开起点
        const awayMin = Math.round((presence.since - idleSince) / 60_000);
        st.set("idleSince", null);
        const since = new Date(idleSince);
        const back = new Date(presence.since);
        const overnight = back.getDate() !== since.getDate() || back.getMonth() !== since.getMonth();
        const spansQuiet = overnight || since.getHours() >= 23 || back.getHours() < 7;
        const hour = ctx.now.getHours();
        if (awayMin >= 240 && !spansQuiet && hour >= 7 && hour < 23) {
          const awayLabel = awayMin >= 480 ? `${Math.round(awayMin / 60)} 小时` : `${awayMin} 分钟`;
          out.push({
            kind: "away_return",
            // alert 档：久别问候值得中等打扰（用户刚"停下来"，是天然开口时机）
            urgency: "alert",
            proposalKind: "away_return", // 独立频控维度（不与晨间问候共享 24h 冷却）
            tier: "social",
            importance: "low",
            title: `用户离开了 ${awayLabel} 后回归`,
            // 事件背景：喂给 LLM 话术层的离开时长（body 留空 → 提案无 directText
            // → 管道 speak 兜底，LLM 基于素材开口；模板层 2026-10-27 已删）
            summary: awayLabel,
            body: "",
            dedupKey: `away_return:${new Date(presence.since).toISOString().slice(0, 10)}`,
            salience: "medium",
          });
        }
        return out;
      },
    },

    // 2. meeting_soon：临近日程双提前量（60min normal / 15min alert）+ 会前准备包
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
          const memoryLines = services.recallMemory ? await services.recallMemory(title, 2) : [];
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

    // 3. work_marathon：连续编码/终端 ≥3h —— 比 rhythm 过劳检测更实时的休息干预
    {
      id: "work_marathon",
      layers: ["current"],
      eval(ctx) {
        const st = ctx.state;
        const out: ReturnType<BoardRule["eval"]> = [];
        const focus = readField<ScreenFocus>(ctx.board, "current", "screenFocus");
        if (!focus) return out;
        const kind = focus.kind;
        const isWork = kind === "coding" || kind === "terminal";
        if (!isWork) {
          st.set("lastAlertAt", st.get("lastAlertAt") ?? 0);
          return out;
        }
        // 板上焦点可能是陈旧快照（屏幕传感心跳 15min）：超过 20min 没有新样本
        // 视为离开/关机，连续时长作废（防止休眠唤醒后误算出几十小时）
        if (ctx.nowMs - (focus.lastSeenAt ?? focus.since) > 20 * 60_000) return out;
        const workMin = Math.round((ctx.nowMs - focus.since) / 60_000);
        const lastAlertAt = (st.get("lastAlertAt") as number) ?? 0;
        if (workMin >= 180 && ctx.nowMs - lastAlertAt >= 4 * 3600_000) {
          st.set("lastAlertAt", ctx.nowMs);
          // 感知 → 目标桥（2026-10-10）：若用户有活跃目标，过劳关怀附带一句目标上下文
          // （"你还在推进「学英语」，下一步是「背 20 个词」"）——从"碎片化场景提醒"
          // 升级为"带目标上下文"，对齐 Muse 的目标驱动。无活跃目标时行为不变。
          const goalLine = services.activeGoalLine?.(ctx.actorId) ?? null;
          out.push({
            kind: "work_marathon",
            urgency: "alert",
            proposalKind: "overwork_care",
            tier: "social",
            importance: "medium",
            title: `连续工作 ${Math.round(workMin / 60)} 小时`,
            // 目标上下文作为素材喂 LLM 话术层（body 留空 → 管道 speak 兜底）
            ...(goalLine ? { summary: goalLine } : {}),
            body: "",
            dedupKey: `work_marathon:${new Date(ctx.nowMs).toISOString().slice(0, 10)}`,
            salience: "medium",
          });
        }
        return out;
      },
    },

    // 4. unread_burst：30min 内 ≥3 条入站消息 —— 有空时提一句，不抢话
    {
      id: "unread_burst",
      layers: ["current"],
      eval(ctx) {
        const st = ctx.state;
        const out: ReturnType<BoardRule["eval"]> = [];
        const recent = readField<Array<{ at: number; sender: string }>>(ctx.board, "current", "unreadRecent") ?? [];
        const fresh = recent.filter((m) => ctx.nowMs - m.at <= 30 * 60_000);
        const bucket = Math.floor(ctx.nowMs / (30 * 60_000));
        if (fresh.length >= 3 && !st.has(`burst:${bucket}`)) {
          st.set(`burst:${bucket}`, true);
          const senders = [...new Set(fresh.map((m) => m.sender))].slice(0, 3).join("、");
          out.push({
            kind: "unread_burst",
            urgency: "normal",
            proposalKind: "message_burst",
            tier: "social",
            importance: "low",
            title: `${fresh.length} 条新消息未读`,
            body: `有 ${fresh.length} 条新消息（${senders}），有空看一眼。急的话跟我说，我帮你盯着。`,
            dedupKey: `unread_burst:${bucket}`,
            salience: "low",
          });
        }
        return out;
      },
    },

    // 4b. spend_alert：外部账本大额支出 —— 跨源进场后的主动财务提醒
    //     （2026-10-11 新增：finance 流此前只进统一库、**无任何消费方**，
    //      账本永远不产生主动；补齐后「账单/比价」类主动才有触发源）
    {
      id: "spend_alert",
      layers: ["current"],
      tickEveryMs: 5 * 60_000,
      eval(ctx) {
        const st = ctx.state;
        const out: ReturnType<BoardRule["eval"]> = [];
        const txs = readField<LedgerTx[]>(ctx.board, "current", "recentTx") ?? [];
        const seen = (st.get("seen") as Map<string, number>) ?? new Map<string, number>();
        st.set("seen", seen);
        // 去重键保留 7 天：同一笔只提醒一次，重启不重发
        for (const [k, v] of seen) if (ctx.nowMs - v > 7 * 86400_000) seen.delete(k);
        for (const t of txs) {
          if (t.type !== "expense" || !(t.amount >= SPEND_ALERT_AMOUNT)) continue;
          const key = t.id || `${t.at}:${t.amount}`;
          if (seen.has(key)) continue;
          seen.set(key, ctx.nowMs);
          out.push({
            kind: "spend_alert",
            urgency: "normal",
            // 独立频控维度：不与 life_reminder（预算/天气/回顾）共享冷却
            proposalKind: "spend_alert",
            tier: "social",
            importance: "medium",
            title: `一笔 ${Math.round(t.amount)} 元的支出`,
            body: `刚记了一笔支出${t.merchant ? `：${t.merchant}` : ""} ¥${t.amount.toFixed(2)}。要我帮你看看同类有没有更划算的，或者记进本月预算吗？`,
            dedupKey: `spend_alert:${key}`,
            salience: "medium",
          });
        }
        return out;
      },
    },

    // 5. goal_ready：预执行目标就绪 —— "哇"时刻的投递触发
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
        const tasks = (services.listTodayTasks?.(ctx.actorId) ?? []).map((t) => t.title);
        const body = renderDigestCard({
          slot: "morning",
          tasks,
          weather: services.weatherLine?.() ?? null,
          unread: services.unreadSenders?.() ?? [],
          interests: services.interestLines?.() ?? [],
          goals: (services.readyGoals?.() ?? []).map((g) => g.title),
        });
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
          },
        ];
      },
    },
  ];
}
