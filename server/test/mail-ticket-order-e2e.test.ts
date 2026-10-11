// 端到端探针：邮箱收到机票订单邮件 → 自动记录日程 → 设置提醒 → 真实提醒用户（2026-10-11）
//
// 目的：验证用户要求的完整场景——「邮箱接收到机票订单之后，是否会自动记录、设置提醒
// 并真实提醒用户」。用**真实组件**串起生产同款接线（只把 IMAP/WS 这两个外部 IO 换桩）：
//
//   真实机票订单 MIME（text/plain, utf-8）
//     → MailScheduleBridge.onMail()                        ← 生产：MailWatchService.onNewMessage
//                                                             票务支路（create-app-services.ts:5083）
//       ├─ isTicketLikeMail 粗筛 → extractMailCalendarParts 解 MIME
//       │    → extractMailScheduleDrafts（flight-ticket 模板规则，零 LLM）
//       └─ syncDrafts → scheduleTaskService.createTask(kind=reminder, category=itinerary,
//            source=email, sourceRefId=matchKey, runAt, reminderMessage)   ← 自动记录 + 设置提醒
//          → notifySummary → notify 回调（生产：proactivityHub.submitIntent）  ← 汇总轻提醒
//
//   到点：ScheduleTaskService.runSchedulerTick()
//     → executeTask(reminder) → reminderHandler
//       → wsConnectionRegistry.trySend(ScheduleReminderFired)  ← 生产：create-app-services.ts:1019
//       → 离线则转管道离线必达（create-app-services.ts:1044 / 6017）          ← 真实提醒用户
//
// 并行支路：同一封邮件也进统一采集库 + 世界板（MailSensor → SensorKernel → SourceStore/WorldBoard）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MailSensor } from "../src/proactivity/sensors/mail-sensor.js";
import { SensorKernel } from "../src/proactivity/sensors/kernel.js";
import { SourceStore } from "../src/proactivity/source-store.js";
import { WorldBoard, bridgeSensorKernelToBoard } from "../src/proactivity/world-board.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";
import { MailScheduleBridge, type MailScheduleSyncReport } from "../src/services/mail-schedule-extractor.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

/** 冻结时钟：2026-10-14 14:00（机票是次日 09:30，稳在"未来事件"时间闸内） */
const T0 = new Date(2026, 9, 14, 14, 0, 0).getTime();
const FLY_AT = "2026-10-15T09:30:00+08:00";
const ACTOR = "user-1";
const ORDER_ID = "880123456789";
const MATCH_KEY = `flight-ticket:${ORDER_ID}`;

type MailRow = {
  uid: number;
  mail: { actorId: string; from: string; subject: string; date?: string; textSnippet?: string };
  importance: string;
};

/** 真实机票订单邮件 MIME（从航司/OTA 公开模板取形状；UTF-8 明文正文） */
function ticketMime(bodyLines: string[]): Buffer {
  const mime = [
    "From: Trip.com <no-reply@trip.com>",
    "To: traveler@example.com",
    "Subject: =?utf-8?B?6K6i5Y2V?=",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    ...bodyLines,
  ].join("\r\n");
  return Buffer.from(mime, "utf8");
}

function ticketBody(opts: { date: string; time: string }): Buffer {
  return ticketMime([
    "尊敬的旅客，您的机票订单状态更新。",
    `订单号：${ORDER_ID}`,
    "航班：CA1234 三亚凤凰机场 至 北京首都机场",
    `日期：${opts.date}`,
    `时间：${opts.time} 起飞`,
    "请提前 2 小时到达机场办理登机手续。",
  ]);
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "mail-ticket-e2e-"));
  const prevTasksFile = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  const clock = { t: T0 };

  const tasks = new ScheduleTaskService({ now: () => new Date(clock.t) });

  const reminded: Array<{ taskId: string; title: string; message: string; preReminder: boolean }> = [];
  const wsFrames: Array<{ sessionId: string; json: string }> = [];
  const pipelineProposals: Array<{ actorId: string; kind: string; directText?: string }> = [];
  let wsOnline = true;

  // 离线必达桩（生产：onReminderOfflineToPipeline → proactivePipeline.submitProposal）
  const offlineToPipeline = (sessionId: string, message: string): void => {
    pipelineProposals.push({ actorId: sessionId, kind: "life_reminder", directText: message });
  };

  // 复刻生产接线 create-app-services.ts:1013-1056（在线走 WS，离线转管道必达）
  tasks.setReminderHandler(async (task, message, options) => {
    reminded.push({
      taskId: task.taskId,
      title: task.title ?? "",
      message,
      preReminder: options?.preReminder === true,
    });
    if (wsOnline) {
      wsFrames.push({
        sessionId: task.sessionId,
        json: JSON.stringify({
          type: "ScheduleReminderFired",
          payload: { taskId: task.taskId, title: task.title, message, preReminder: options?.preReminder === true },
        }),
      });
    } else {
      offlineToPipeline(task.sessionId, message);
    }
  });

  const notifyIntents: ProactiveIntent[] = [];
  const bridge = new MailScheduleBridge({
    tasks,
    notify: (intent) => notifyIntents.push(intent),
    now: () => new Date(clock.t),
  });

  // 并行支路：统一采集库 + 世界板（生产：SENSOR_FABRIC_MAIL 注册 + 两条 onSignal 订阅）
  const board = new WorldBoard({ nowFn: () => clock.t });
  const kernel = new SensorKernel({ dataPath: dir, nowFn: () => clock.t, disablePersist: true });
  const store = new SourceStore({ dataPath: dir, nowFn: () => clock.t, disablePersist: true });
  bridgeSensorKernelToBoard(kernel, board, ACTOR);
  kernel.onSignal((s) => store.feed(s));
  const mailRows: MailRow[] = [];
  kernel.register(new MailSensor({ fetchNewSince: () => mailRows }));

  return {
    dir,
    clock,
    tasks,
    bridge,
    reminded,
    wsFrames,
    pipelineProposals,
    notifyIntents,
    board,
    store,
    kernel,
    mailRows,
    setOnline: (v: boolean) => {
      wsOnline = v;
    },
    restore: () => {
      if (prevTasksFile === undefined) delete process.env.SCHEDULE_TASKS_FILE;
      else process.env.SCHEDULE_TASKS_FILE = prevTasksFile;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const order = (mime: Buffer) => ({
  actorId: ACTOR,
  from: "Trip.com <no-reply@trip.com>",
  subject: "您的机票订单已出票成功",
  source: mime,
});

/**
 * 到点执行是 fire-and-forget（生产 tick 里 `void executeTask(...)`），
 * 轮询等结果落地（含其内部 persist 完成），避免断言过早 + 文件写完前就清理目录。
 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─── 第一段：自动记录 + 设置提醒 ───

test("T1 机票订单邮件 → 自动落日程（kind=reminder/itinerary/email）+ 汇总轻提醒", async () => {
  const h = makeHarness();
  try {
    const report = await h.bridge.onMail(order(ticketBody({ date: "2026年10月15日", time: "09:30" })));
    assert.ok(report, "应识别为票务邮件");
    assert.equal((report as MailScheduleSyncReport).created, 1, `应新建 1 条日程：${JSON.stringify(report)}`);

    const task = h.tasks.findTaskBySourceRefId(MATCH_KEY);
    assert.ok(task, `应按 matchKey 落一条日程：${MATCH_KEY}`);
    assert.equal(task!.kind, "reminder", "类型应为提醒");
    assert.equal(task!.category, "itinerary", "应归入行程类");
    assert.equal(task!.source, "email", "来源应为邮件");
    assert.equal(task!.status, "active");
    assert.equal(Date.parse(task!.runAt), Date.parse(FLY_AT), `起飞时刻应解析正确：${task!.runAt}`);
    assert.match(task!.title, /【航班】CA1234/, `标题应含航班号：${task!.title}`);
    assert.match(task!.reminderMessage, /CA1234/, "提醒文案应含航班号");

    assert.equal(h.notifyIntents.length, 1, "应发一条汇总轻提醒");
    assert.equal(h.notifyIntents[0]!.kind, "life_reminder");
    assert.match(h.notifyIntents[0]!.summary ?? "", /日程/, `汇总应提到日程：${h.notifyIntents[0]!.summary}`);

    // 分级提醒策略（schedule-reminder-policy）对 itinerary 邮件额外挂"提前量"段
    assert.ok(
      (task!.preReminders ?? []).length > 0,
      `应生成分级提前量提醒（前晚/出发预留）：${JSON.stringify(task!.preReminders)}`,
    );
  } finally {
    h.restore();
  }
});

// ─── 第二段：到点真实提醒（在线 → WS 推送）───

test("T2 到点 → 真实推送提醒（WS ScheduleReminderFired 帧）", async () => {
  const h = makeHarness();
  try {
    await h.bridge.onMail(order(ticketBody({ date: "2026年10月15日", time: "09:30" })));
    // 时间推进到起飞当天 09:30 后
    h.clock.t = Date.parse("2026-10-15T09:30:10+08:00");
    await h.tasks.runSchedulerTick();
    await waitFor(() => h.wsFrames.length > 0);

    assert.equal(h.reminded.length, 1, "到点应触发一次提醒");
    assert.equal(h.reminded[0]!.preReminder, false, "到点提醒不是提前量");
    assert.equal(h.wsFrames.length, 1, "应真实推送到该用户设备");
    assert.equal(h.wsFrames[0]!.sessionId, ACTOR);
    const frame = JSON.parse(h.wsFrames[0]!.json) as { type: string; payload: { message: string } };
    assert.equal(frame.type, "ScheduleReminderFired");
    assert.match(frame.payload.message, /CA1234/, `提醒内容应含航班号：${frame.payload.message}`);
  } finally {
    h.restore();
  }
});

// ─── 第三段：设备离线 → 管道离线必达（不丢）───

test("T3 设备离线 → 提醒转管道离线必达（不丢提醒）", async () => {
  const h = makeHarness();
  try {
    await h.bridge.onMail(order(ticketBody({ date: "2026年10月15日", time: "09:30" })));
    h.setOnline(false);
    h.clock.t = Date.parse("2026-10-15T09:30:10+08:00");
    await h.tasks.runSchedulerTick();
    await waitFor(() => h.reminded.length > 0);

    assert.equal(h.wsFrames.length, 0, "离线不应产生 WS 帧");
    assert.equal(h.pipelineProposals.length, 1, "离线应转管道必达");
    assert.match(h.pipelineProposals[0]!.directText ?? "", /CA1234/, "管道文案应含航班号");
    assert.equal(h.pipelineProposals[0]!.actorId, ACTOR);
  } finally {
    h.restore();
  }
});

// ─── 第四段：同一订单改期 → 更新同一条（生命周期一致，不重复建）───

test("T4 同一订单改期邮件 → 更新原日程而非重复新建", async () => {
  const h = makeHarness();
  try {
    await h.bridge.onMail(order(ticketBody({ date: "2026年10月15日", time: "09:30" })));
    const before = h.tasks.listAllTasks().length;

    const report = await h.bridge.onMail({
      actorId: ACTOR,
      from: "Trip.com <no-reply@trip.com>",
      subject: "您的机票改期成功通知",
      source: ticketBody({ date: "2026年10月16日", time: "11:05" }),
    });
    assert.ok(report, "改期邮件也应识别");
    assert.equal((report as MailScheduleSyncReport).updated, 1, `应更新 1 条：${JSON.stringify(report)}`);
    assert.equal(h.tasks.listAllTasks().length, before, "不应新增重复日程");

    const task = h.tasks.findTaskBySourceRefId(MATCH_KEY);
    assert.equal(Date.parse(task!.runAt), Date.parse("2026-10-16T11:05:00+08:00"), "改期后时刻应更新");
  } finally {
    h.restore();
  }
});

// ─── 第五段：并行支路 —— 同一封邮件也进统一库 + 世界板 ───

test("T5 并行支路：邮件的 mail 信号同时进统一库与世界板", async () => {
  const h = makeHarness();
  try {
    h.mailRows.push({
      uid: 1,
      mail: {
        actorId: ACTOR,
        from: "Trip.com <no-reply@trip.com>",
        subject: "您的机票订单已出票成功",
        date: new Date(T0 + 1000).toISOString(),
        textSnippet: `订单号 ${ORDER_ID} 航班 CA1234 三亚凤凰机场 至 北京首都机场 2026年10月15日 09:30 起飞`,
      },
      importance: "high",
    });
    await h.kernel.pollOnce();

    assert.equal(h.store.stats().streams.mail, 1, `邮件应进统一库：${JSON.stringify(h.store.stats().streams)}`);
    const unread = h.board.read<unknown[]>(ACTOR, "current", "unreadRecent");
    assert.ok(Array.isArray(unread) && unread.length >= 1, "邮件应进世界板 unreadRecent");
  } finally {
    h.restore();
  }
});
