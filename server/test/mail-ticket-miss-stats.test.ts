/**
 * 票务邮件「漏检埋点」（mail-schedule-extractor 的 missStats）：
 *   预筛判定"像票务"但规则零产出 → 记一条；非票务 / 成功解析 / 时间闸跳过都**不**记。
 *   埋点只观测不改变行为，本文件同时断言"返回语义与埋点前逐字一致"。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MailScheduleBridge, type MailTicketMiss } from "../src/services/mail-schedule-extractor.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const NOW = new Date().toISOString();
const TRIP_BASE = Date.now() + 20 * 24 * 3600_000;
const cnDate = (offsetDays: number): string => {
  const d = new Date(TRIP_BASE + offsetDays * 24 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

function mime(from: string, subject: string, body: string): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      `To: user@example.com`,
      `Subject: ${subject}`,
      `Date: Thu, 24 Sep 2026 08:00:00 +0800`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="utf-8"`,
      "",
      body,
    ].join("\r\n"),
    "utf8",
  );
}

/** 预筛命中（trip.com 出票）但正文缺航班号/日期 → 规则解不出 → 漏检。 */
const MAIL_FLIGHT_UNPARSEABLE = mime(
  "携程旅行 <noreply@mail.ctrip.com>",
  "出票成功：您的机票已出票",
  ["尊敬的旅客，您的订单已出票，详情见附件图片。", "（本邮件为纯图卡片，无结构化字段）"].join("\r\n"),
);

/** 真票务：能解析成功 → 不应记漏检。 */
const MAIL_12306_BUY = mime(
  "中国铁路客户服务中心 <12306@rails.com.cn>",
  "[铁路客服] 网上购票成功",
  [
    "尊敬的旅客：",
    "您已成功购买车票，订单号 E987654321。",
    "车次：G101次",
    "乘车日期：" + cnDate(0) + " 09:15开",
    "北京南站 至 南京南站",
  ].join("\r\n"),
);

/** 过期票：解析成功但被时间闸 skipped —— 属"识别到了"，不应记漏检。 */
const MAIL_12306_PAST = mime(
  "中国铁路客户服务中心 <12306@rails.com.cn>",
  "网上购票成功",
  ["订单号 E1111222233。", "车次：G999次", "乘车日期：2025年1月1日 09:15开", "北京南站 至 上海站"].join("\r\n"),
);

/** 含 text/calendar 但无有效事件 → 仅 ICS 探针命中、解不出 → 漏检（ics_probe_no_draft）。 */
const MAIL_ICS_EMPTY = Buffer.from(
  [
    "From: 同事 <colleague@company.com>",
    "To: user@example.com",
    "Subject: 随便聊两句",
    "Date: Thu, 24 Sep 2026 09:00:00 +0800",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "正文。",
    "--b1",
    'Content-Type: text/calendar; charset="utf-8"; name="empty.ics"',
    "Content-Disposition: attachment; filename=empty.ics",
    "",
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "END:VCALENDAR",
    "--b1--",
  ].join("\r\n"),
  "utf8",
);

type Harness = {
  bridge: MailScheduleBridge;
  tasks: ScheduleTaskService;
  intents: ProactiveIntent[];
  misses: MailTicketMiss[];
};

async function withBridge(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mail-miss-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  const tasks = new ScheduleTaskService();
  const intents: ProactiveIntent[] = [];
  const misses: MailTicketMiss[] = [];
  const bridge = new MailScheduleBridge({
    tasks,
    notify: (intent) => intents.push(intent),
    now: () => new Date(NOW),
    onMiss: (m) => misses.push(m),
  });
  try {
    await fn({ bridge, tasks, intents, misses });
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("初始态：漏检统计为空", async () => {
  await withBridge(async ({ bridge }) => {
    const s = bridge.missStats();
    assert.equal(s.total, 0);
    assert.equal(s.lastAt, null);
    assert.deepEqual(s.samples, []);
    assert.deepEqual(s.byReason, { prefilter_hit_no_draft: 0, ics_probe_no_draft: 0 });
  });
});

test("预筛命中但规则零产出 → 记一次漏检，且返回仍为 null（行为不变）", async () => {
  await withBridge(async ({ bridge, tasks, intents, misses }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "携程旅行 <noreply@mail.ctrip.com>",
      subject: "出票成功：您的机票已出票",
      source: MAIL_FLIGHT_UNPARSEABLE,
    });
    assert.equal(report, null, "识别不出 → 仍返回 null（与埋点前一致）");
    assert.equal(tasks.listAllTasks().filter((t) => t.source === "email").length, 0, "不误建日程");
    assert.equal(intents.length, 0);

    const s = bridge.missStats();
    assert.equal(s.total, 1);
    assert.equal(s.byReason.prefilter_hit_no_draft, 1);
    assert.equal(s.byReason.ics_probe_no_draft, 0);
    assert.ok(s.lastAt, "记录漏检时刻");
    assert.equal(s.samples.length, 1);
    assert.equal(s.samples[0]!.reason, "prefilter_hit_no_draft");
    assert.equal(s.samples[0]!.subject, "出票成功：您的机票已出票");
    assert.ok(s.samples[0]!.bodyChars > 0, "正文长度可用于判断是否纯图片卡片");

    assert.equal(misses.length, 1, "onMiss 回调被调用");
  });
});

test("非票务邮件：预筛不过 → 不记漏检", async () => {
  await withBridge(async ({ bridge }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "friend@qq.com",
      subject: "周末聚餐",
      source: mime("friend@qq.com", "周末聚餐", "周六老地方见"),
    });
    assert.equal(report, null);
    assert.equal(bridge.missStats().total, 0, "与票务无关的邮件不摊入漏检");
  });
});

test("真票务解析成功 → 不记漏检", async () => {
  await withBridge(async ({ bridge }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "12306@rails.com.cn",
      subject: "网上购票成功",
      source: MAIL_12306_BUY,
    });
    assert.equal(report!.created, 1);
    assert.equal(bridge.missStats().total, 0);
  });
});

test("识别为票务但被时间闸 skipped（过期票）→ 不算漏检", async () => {
  await withBridge(async ({ bridge }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "12306@rails.com.cn",
      subject: "网上购票成功",
      source: MAIL_12306_PAST,
    });
    assert.equal(report!.skipped, 1, "解析成功、只是不建过去日程");
    assert.equal(bridge.missStats().total, 0, "「解析成功」的邮件即便没建日程也不算漏检——埋点只标解析失败");
  });
});

test("仅 ICS 探针命中、解不出事件 → 记 ics_probe_no_draft", async () => {
  await withBridge(async ({ bridge }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "colleague@company.com",
      subject: "随便聊两句",
      source: MAIL_ICS_EMPTY,
    });
    assert.equal(report, null);
    const s = bridge.missStats();
    assert.equal(s.total, 1);
    assert.equal(s.byReason.ics_probe_no_draft, 1);
    assert.equal(s.byReason.prefilter_hit_no_draft, 0);
  });
});

test("空正文但预筛命中 → 记漏检（bodyChars=0，揭示读不到正文的形态）", async () => {
  await withBridge(async ({ bridge }) => {
    const report = await bridge.onMail({
      actorId: "user1",
      from: "12306@rails.com.cn",
      subject: "网上购票成功",
      source: Buffer.alloc(0),
    });
    assert.equal(report, null);
    const s = bridge.missStats();
    assert.equal(s.total, 1);
    assert.equal(s.samples[0]!.bodyChars, 0);
  });
});

test("样本有界：超过上限只留最近 N 条，total 仍如实累计", async () => {
  await withBridge(async ({ bridge }) => {
    for (let i = 0; i < 55; i += 1) {
      await bridge.onMail({
        actorId: "user1",
        from: "携程旅行 <noreply@mail.ctrip.com>",
        subject: `出票成功 第${i}封`,
        source: MAIL_FLIGHT_UNPARSEABLE,
      });
    }
    const s = bridge.missStats();
    assert.equal(s.total, 55, "total 累计不失真");
    assert.equal(s.samples.length, 50, "样本有界保留最近 50 条");
    assert.equal(s.samples[s.samples.length - 1]!.subject, "出票成功 第54封", "保留的是最新的");
  });
});

test("onMiss 回调异常不影响主链路（返回语义不变）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-miss-err-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const bridge = new MailScheduleBridge({
      tasks: new ScheduleTaskService(),
      notify: () => {},
      now: () => new Date(NOW),
      onMiss: () => {
        throw new Error("埋点回调炸了");
      },
    });
    const report = await bridge.onMail({
      actorId: "user1",
      from: "携程旅行 <noreply@mail.ctrip.com>",
      subject: "出票成功",
      source: MAIL_FLIGHT_UNPARSEABLE,
    });
    assert.equal(report, null, "回调异常被吞，主链路照常返回");
    assert.equal(bridge.missStats().total, 1, "计数仍写入");
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
