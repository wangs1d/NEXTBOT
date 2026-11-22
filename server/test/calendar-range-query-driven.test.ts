/**
 * calendar.list_tasks「用户原话驱动」查询范围契约（2026-11-21 根治 P1）。
 *
 * 背景：旧实现 from/to 完全交给模型，缺省 from=now——用户问「昨天有什么安排」
 * 「上周的会议」「今天早上那个提醒过了吗」时，模型漏传/传错 from 就查不到过去日程。
 * 根治：服务端读 context.userText 确定性解析相对时间，覆盖模型参数；模型参数降级兜底。
 *
 * 本文件锁死：原话优先于模型 from/to、相对日/周边界按用户时区、无原话时模型/缺省兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseScheduleRangeIntent } from "../src/tools/calendar-tools.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import type { ScheduleTaskService } from "../src/services/schedule-task-service.js";

// 固定时钟：2026-11-21T12:00Z = 北京时间 2026-11-21 20:00（周五）。
const NOW = new Date("2026-11-21T12:00:00.000Z");
const TZ = "Asia/Shanghai";
const localDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });

// ---------- 1. 纯函数：相对时间解析 ----------

test("parseScheduleRangeIntent：相对日边界按用户时区，长词优先", () => {
  const yesterday = parseScheduleRangeIntent("我昨天有什么安排", NOW, TZ);
  assert.ok(yesterday);
  assert.equal(yesterday.label, "昨天");
  assert.equal(localDate(yesterday.from), "2026-11-20", "昨天 00:00 起");
  assert.equal(localDate(yesterday.to), "2026-11-21", "今天 00:00 止");

  const today = parseScheduleRangeIntent("今天早上的提醒过了吗", NOW, TZ);
  assert.equal(today?.label, "今天");
  assert.equal(localDate(today!.from), "2026-11-21");
  assert.equal(localDate(today!.to), "2026-11-22");

  assert.equal(parseScheduleRangeIntent("前天的会议", NOW, TZ)?.label, "前天");
  assert.equal(parseScheduleRangeIntent("大前天", NOW, TZ)?.label, "大前天");
  assert.equal(parseScheduleRangeIntent("明天有哪些安排", NOW, TZ)?.label, "明天");
});

test("parseScheduleRangeIntent：自然周以周一为起点", () => {
  const week = parseScheduleRangeIntent("这周会议", NOW, TZ);
  assert.equal(week?.label, "本周");
  assert.equal(localDate(week!.from), "2026-11-16", "本周一");
  assert.equal(localDate(week!.to), "2026-11-23", "下周一");

  const last = parseScheduleRangeIntent("上周的安排", NOW, TZ);
  assert.equal(last?.label, "上周");
  assert.equal(localDate(last!.from), "2026-11-09", "上周一");
  assert.equal(localDate(last!.to), "2026-11-16", "本周一");

  const next = parseScheduleRangeIntent("下周计划", NOW, TZ);
  assert.equal(next?.label, "下周");
  assert.equal(localDate(next!.from), "2026-11-23", "下周一");
  assert.equal(localDate(next!.to), "2026-11-30");
});

test("parseScheduleRangeIntent：最近/未来 N 天", () => {
  const recent = parseScheduleRangeIntent("最近3天有什么安排", NOW, TZ);
  assert.equal(recent?.label, "最近3天");
  assert.equal(localDate(recent!.from), "2026-11-19", "含今天在内共 3 天：19/20/21");
  assert.equal(localDate(recent!.to), "2026-11-22");

  const future = parseScheduleRangeIntent("未来一周的日程", NOW, TZ);
  assert.equal(future?.label, "未来1周");
  assert.equal(localDate(future!.from), "2026-11-21");
  assert.equal(localDate(future!.to), "2026-11-28", "一周含今天共 7 天：21→28");

  const future3 = parseScheduleRangeIntent("未来3天的安排", NOW, TZ);
  assert.equal(future3?.label, "未来3天");
  assert.equal(localDate(future3!.to), "2026-11-24", "3 天含今天：21→24");
});

test("parseScheduleRangeIntent：泛问/空串返回 null（退回模型参数/缺省）", () => {
  assert.equal(parseScheduleRangeIntent("我的日程有哪些", NOW, TZ), null);
  assert.equal(parseScheduleRangeIntent("", NOW, TZ), null);
  assert.equal(parseScheduleRangeIntent(undefined, NOW, TZ), null);
});

// ---------- 2. 工具执行：原话覆盖模型参数 ----------

type SeenRange = { from?: string; to?: string };

function withRegistry(now: Date) {
  let seen: SeenRange | undefined;
  const svc = {
    currentTime: () => now,
    listTasksBySession: (_sessionId: string, range: SeenRange) => {
      seen = range;
      return [];
    },
  } as unknown as ScheduleTaskService;
  const registry = new ToolRegistry();
  registerCalendarTools(registry, svc, null as never);
  return { registry, seen: () => seen };
}

const ctx = (userText?: string): ToolContext => ({
  sessionId: "calendar-range-session",
  userId: "calendar-range-user",
  userText,
});

async function listTasks(userText: string | undefined, modelInput: Record<string, unknown>) {
  const { registry, seen } = withRegistry(NOW);
  const { result } = await registry.execute(
    "calendar",
    { action: "list_tasks", ...modelInput },
    ctx(userText),
  );
  return { result, range: seen() };
}

test("问「昨天有什么安排」：即使模型乱传未来 from/to，也按原话查昨天", async () => {
  const { result, range } = await listTasks("我昨天有什么安排", {
    from: "2099-01-01T00:00:00Z",
    to: "2099-12-31T00:00:00Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rangeFromUserText, true, "回执标注范围来自原话");
  assert.equal(result.rangeLabel, "昨天");
  assert.equal(localDate(String(range?.from)), "2026-11-20", "原话覆盖模型乱传的 from");
  assert.equal(localDate(String(range?.to)), "2026-11-21");
});

test("问「上周的会议」：模型啥都不传也查上周自然周", async () => {
  const { result, range } = await listTasks("上周的会议有哪些", {});
  assert.equal(result.rangeLabel, "上周");
  assert.equal(localDate(String(range?.from)), "2026-11-09");
  assert.equal(localDate(String(range?.to)), "2026-11-16");
});

test("问「今天早上的提醒过了吗」：查今天全天，completed/lastRunAt 由数据层判定", async () => {
  const { result, range } = await listTasks("今天早上的提醒过了吗", {});
  assert.equal(result.rangeLabel, "今天");
  assert.equal(localDate(String(range?.from)), "2026-11-21");
  assert.equal(localDate(String(range?.to)), "2026-11-22");
});

test("无原话：退回模型 from/to（主动任务等无 userText 场景不被改坏）", async () => {
  const { result, range } = await listTasks(undefined, {
    from: "2000-01-01T00:00:00Z",
    to: "2001-01-01T00:00:00Z",
  });
  assert.equal(result.rangeFromUserText, false);
  assert.equal(result.rangeLabel, "");
  assert.equal(range?.from, "2000-01-01T00:00:00Z", "无原话时模型参数生效");
});

test("无原话且无模型参数：缺省仍然只查未来 120 天（行为不回退）", async () => {
  const { result, range } = await listTasks("我的日程有哪些", {});
  assert.equal(result.rangeFromUserText, false);
  assert.equal(range?.from, NOW.toISOString());
  assert.equal(range?.to, new Date(NOW.getTime() + 120 * 86400000).toISOString());
});
