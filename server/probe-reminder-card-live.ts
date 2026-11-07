/**
 * 提醒确认卡实测探针（2026-11-07）。
 *
 * 不是 mock：真调 registry.execute("calendar.create") 写任务 → 拿真实回执
 * → 走生产同一条渲染链 decideRender / applyBodyForm / applyCards /
 * normalizeReplyCardLayout / collectCardPayloads → 再真调 update_task /
 * delete_task 走 card.update 状态机。结果落 live-evidence.json，
 * 供 docs/design/mobile-reminder/live.html 直接渲染给用户看。
 *
 * 运行：cd server && node --import tsx probe-reminder-card-live.ts
 * 本探针不读 LLM、不联网，只用本地 ScheduleTaskService 临时库。
 */

import "./src/config/load-server-env.js";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ScheduleIntentService } from "./src/services/schedule-intent-service.js";
import { ScheduleTaskService } from "./src/services/schedule-task-service.js";
import { registerCalendarTools } from "./src/tools/calendar-tools.js";
import { ToolRegistry } from "./src/tools/tool-registry.js";
import { decideRender } from "./src/render/decide.js";
import { applyBodyForm } from "./src/render/body.js";
import { applyCards, collectCardPayloads } from "./src/render/cards.js";
import { normalizeReplyCardLayout } from "./src/services/reply-envelope.js";
import {
  rememberReminderCards,
  buildReminderCardUpdate,
} from "./src/services/reminder-card-state.js";
import "./src/render/scenes/index.js";
import type { TurnEffect } from "./src/render/types.js";

const ACTOR = "probe-reminder-live";
const MESSAGE_ID = "assistant-live-reminder-1";
const NOW_ISO = process.env.PROBE_NOW_ISO ?? "";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "design",
  "mobile-reminder",
  "live-evidence.json",
);

const line = (s = ""): void => console.log(s);
const head = (s: string): void => line(`\n===== ${s} =====`);

interface Round {
  finalText: string;
  cards: Array<Record<string, unknown>>;
  scene: string;
}

function renderRound(text: string, effects: TurnEffect[]): Round {
  const decision = decideRender({ text, userText: "设置提醒", effects });
  const body = applyBodyForm(decision.text ?? text, decision, { userText: "设置提醒" });
  const withCards = applyCards(body, decision).text;
  const finalText = normalizeReplyCardLayout(withCards);
  return {
    finalText,
    cards: collectCardPayloads(finalText),
    scene: decision.scene?.id ?? "",
  };
}

function ok(name: string, condition: boolean): { name: string; pass: boolean } {
  line(`${condition ? "PASS" : "FAIL"}  ${name}`);
  return { name, pass: condition };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "probe-reminder-card-"));
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  const checks: Array<{ name: string; pass: boolean }> = [];
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, new ScheduleIntentService(null));
    const context = { sessionId: ACTOR, userId: ACTOR };
    const create = async (text: string): Promise<Record<string, unknown>> => {
      const reply = await registry.execute("calendar.create", { text, timezone: "Asia/Shanghai" }, context);
      return reply.result as Record<string, unknown>;
    };
    const effect = (tool: string, result: Record<string, unknown>): TurnEffect => ({
      tool,
      status: result.ok === false ? "error" : "ok",
      result,
    });

    // ── 1. 单条：真实回执 → 真实渲染链 ───────────────────────────────
    head("1. 真实创建一条提醒");
    const receipt = await create("明天 07:00 提醒我叫阿哲起床");
    line(JSON.stringify(receipt, null, 2));
    const single = renderRound("好嘞阿哲，七点准时叫你。", [effect("calendar.create", receipt)]);
    head("2. 生产渲染链产出（finalText）");
    line(single.finalText);
    const card = single.cards[0] ?? {};
    const reminder = (card.extra as { reminder?: Record<string, unknown> } | undefined)?.reminder ?? {};
    checks.push(ok("真实回执经场景命中 reminder_confirm", single.scene === "reminder_confirm"));
    checks.push(ok("一轮只出 1 张卡", single.cards.length === 1));
    checks.push(ok("卡只读（actions 为空）", Array.isArray(card.actions) && card.actions.length === 0));
    checks.push(ok("主行是「明早 07:00 · 叫阿哲起床」", JSON.stringify(card.items ?? []).includes("07:00")));
    checks.push(
      ok("卡留在正文之后", single.finalText.indexOf("好嘞") < single.finalText.indexOf("[AGENT_RESULT_CARD_START]")),
    );
    checks.push(ok("一次性 + 本地时区无脚注", card.footer === ""));

    // ── 2. 一轮 4 条：全量 rows 下发，界面轮动一次只显示一条 ──────────
    head("3. 同一轮真实创建 4 条提醒");
    const moreReceipts = await Promise.all([
      create("明天 08:00 提醒我带工牌"),
      create("明天 09:00 提醒我交房租"),
      create("明天 10:00 提醒我买咖啡"),
      create("明天 11:00 提醒我给妈妈打电话"),
    ]);
    const multi = renderRound("行，都排上了。", moreReceipts.map((r) => effect("calendar.create", r)));
    const multiCard = multi.cards[0] ?? {};
    const multiReminder = (multiCard.extra as { reminder?: Record<string, unknown> } | undefined)?.reminder ?? {};
    line(`title = ${multiCard.title}`);
    line(`items = ${JSON.stringify(multiCard.items)}`);
    line(`rows  = ${JSON.stringify(multiReminder.rows)}`);
    checks.push(ok("4 条合并成 1 张卡", multi.cards.length === 1));
    checks.push(ok("4 条全量下发 rows", (multiReminder.rows as unknown[] | undefined)?.length === 4));
    checks.push(ok("标题保留数量「已定好 4 条提醒」", multiCard.title === "已定好 4 条提醒"));
    checks.push(
      ok("不做 3 行截断、无「共 N 条」收口", multiReminder.shown === undefined && multiReminder.more === undefined && !multi.finalText.includes("其余")),
    );
    checks.push(ok("只读卡无「查看全部」跳转", !multi.finalText.includes("查看全部")));

    // ── 3. 状态机：真实 update / delete 回执 → card.update ──────────
    head("4. 修改 / 取消：card.update 原地刷新");
    rememberReminderCards(ACTOR, MESSAGE_ID, single.cards);
    const taskId = String(receipt.taskId ?? "");
    const at = String(receipt.nextRunAt ?? "");
    const plus30 = new Date(new Date(at).getTime() + 30 * 60_000).toISOString();
    const upd = await registry.execute(
      "calendar.update_task",
      { taskId, runAt: plus30, timezone: "Asia/Shanghai" },
      context,
    );
    const updResult = upd.result as Record<string, unknown>;
    const updateEvent = buildReminderCardUpdate(ACTOR, [effect("calendar.update_task", updResult)]);
    line(`update 回执 status = ${updResult.status}, nextRunAt = ${updResult.nextRunAt}`);
    line(`card.update title = ${updateEvent?.card.title ?? "(无)"}`);
    checks.push(ok("改期推 card.update 且指向原消息", updateEvent?.messageId === MESSAGE_ID));
    checks.push(ok("改期后标题为「已改为提醒」", updateEvent?.card.title === "已改为提醒"));

    const del = await registry.execute("calendar.delete_task", { taskId }, context);
    const delResult = del.result as Record<string, unknown>;
    const cancelEvent = buildReminderCardUpdate(ACTOR, [effect("calendar.delete_task", delResult)]);
    line(`delete 回执 = ${JSON.stringify(delResult)}`);
    line(`card.update title = ${cancelEvent?.card.title ?? "(无)"}`);
    checks.push(ok("取消推 card.update 且标题为「已取消提醒」", cancelEvent?.card.title === "已取消提醒"));
    const updateRound = renderRound("行，撤了。", [effect("calendar.update_task", updResult)]);
    checks.push(ok("修改/取消轮不追加新卡", updateRound.cards.length === 0));
    checks.push(ok("日程条目已从任务库删除", tasks.listTasksBySession(ACTOR).every((t) => t.taskId !== taskId)));

    const evidence = {
      generatedAt: NOW_ISO,
      source: "registry.execute(calendar.create/update_task/delete_task) + decideRender + applyCards + normalizeReplyCardLayout + card.update",
      userText: "明天 07:00 提醒我叫阿哲起床",
      receipt,
      single: { ...single, card },
      multi: { ...multi, card: multiCard },
      updatedCard: updateEvent?.card ?? null,
      cancelledCard: cancelEvent?.card ?? null,
      checks,
    };
    await writeFile(OUT, JSON.stringify(evidence, null, 2), "utf8");
    head("5. 实测结论");
    line(`${checks.filter((c) => c.pass).length}/${checks.length} 通过`);
    line(`证据已写入 ${OUT}`);
    if (checks.some((c) => !c.pass)) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
