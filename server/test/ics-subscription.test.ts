/**
 * ICS 日历订阅（ics-subscription-service）：
 *   RFC5545 子集解析（UTC/浮点/全天、WEEKLY BYDAY+COUNT、EXDATE、RECURRENCE-ID 覆盖、
 *   STATUS:CANCELLED）、窗口展开、config 解析，以及服务级 diff
 *   （首拉全量建日程 → 重拉零变更 → 改期/消失反向同步 → 汇总提醒）。
 *
 * 测试封闭：临时 SCHEDULE_TASKS_FILE + 临时状态文件 + 注入时钟与 fetch。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IcsSubscriptionService,
  parseIcsCalendar,
  readIcsWatchConfig,
  resolveIcsOccurrences,
  validateIcsFeedUrl,
} from "../src/services/ics-subscription-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const NOW = "2026-09-24T08:00:00Z";

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//CN",
  "BEGIN:VEVENT",
  "UID:weekly-meeting@example.com",
  "DTSTAMP:20260924T000000Z",
  "SUMMARY:项目周会",
  "LOCATION:大会议室",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T100000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:trip@example.com",
  "DTSTAMP:20260924T000000Z",
  "SUMMARY:出差上海",
  "DTSTART;VALUE=DATE:20261005",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gym@example.com",
  "DTSTAMP:20260924T000000Z",
  "SUMMARY:健身课",
  "DTSTART:20260928T190000Z",
  "DTEND:20260928T200000Z",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
  "EXDATE:20261005T190000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gym@example.com",
  "DTSTAMP:20260924T000000Z",
  "SUMMARY:健身课（改到周二）",
  "RECURRENCE-ID:20260930T190000Z",
  "DTSTART:20260929T190000Z",
  "DTEND:20260929T200000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:dropped@example.com",
  "DTSTAMP:20260924T000000Z",
  "SUMMARY:已取消的活动",
  "STATUS:CANCELLED",
  "DTSTART:20261002T120000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("parseIcsCalendar：基础字段与多形态时间", () => {
  const events = parseIcsCalendar(SAMPLE_ICS);
  assert.equal(events.length, 5);
  const weekly = events.find((e) => e.uid === "weekly-meeting@example.com")!;
  assert.equal(weekly.summary, "项目周会");
  assert.equal(weekly.location, "大会议室");
  assert.equal(weekly.start!.ms, Date.parse("2026-10-01T09:00:00Z"));
  assert.equal(weekly.durationMinutes, 60);

  const trip = events.find((e) => e.uid === "trip@example.com")!;
  assert.equal(trip.start!.allDay, true, "VALUE=DATE 识别为全天");

  // 浮点时间（无 Z）按 +08:00 固定偏移解释：09:00 本地 = 01:00Z
  const floating = parseIcsCalendar(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:f@x", "DTSTART:20261001T090000", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
  )[0]!;
  assert.equal(floating.start!.ms, Date.parse("2026-10-01T01:00:00Z"));
});

test("resolveIcsOccurrences：RRULE 展开 + EXDATE + 覆盖次 + 取消剔除", () => {
  const events = parseIcsCalendar(SAMPLE_ICS);
  const occ = resolveIcsOccurrences(events, Date.parse(NOW), Date.parse(NOW) + 35 * 24 * 3_600_000);
  // 周会 1 + 全天 1 + 健身课主事件 4（COUNT=6 − EXDATE − 覆盖次）+ 覆盖次 1 = 7
  assert.equal(occ.length, 7);
  const gymKeys = occ.filter((o) => o.uid === "gym@example.com").map((o) => o.startIso);
  assert.equal(gymKeys.length, 5);
  assert.ok(gymKeys.includes("2026-09-28T19:00:00.000Z"), "首课保留");
  assert.ok(!gymKeys.includes("2026-09-30T19:00:00.000Z"), "被覆盖次剔除");
  assert.ok(!gymKeys.includes("2026-10-05T19:00:00.000Z"), "EXDATE 剔除");
  assert.ok(gymKeys.includes("2026-09-29T19:00:00.000Z"), "覆盖次独立在场");
  assert.ok(occ.every((o) => !o.uid.includes("dropped")), "CANCELLED 不产出");
  const trip = occ.find((o) => o.uid === "trip@example.com")!;
  assert.equal(trip.allDay, true);
});

test("readIcsWatchConfig：名称=URL / 裸 URL / 间隔钳制", () => {
  const cfg = readIcsWatchConfig({
    ICS_SUB_ENABLED: "1",
    ICS_SUB_URLS: "工作=https://a.example.com/x.ics, https://b.example.com/y.ics",
    ICS_SUB_POLL_SEC: "5",
    ICS_SUB_LOOKAHEAD_DAYS: "9999",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(
    cfg.feeds.map((f) => f.name),
    ["工作", "b.example.com"],
  );
  assert.equal(cfg.pollSec, 300, "下限钳到 300");
  assert.equal(cfg.lookaheadDays, 180, "上限钳到 180");
});

type IcsHarness = {
  service: IcsSubscriptionService;
  tasks: ScheduleTaskService;
  intents: ProactiveIntent[];
  setIcs: (text: string) => void;
};

async function withIcsService(
  fn: (h: IcsHarness) => Promise<void>,
  overrides?: { fetchImpl?: typeof fetch },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ics-sub-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  let icsText = SAMPLE_ICS;
  const fetchImpl =
    overrides?.fetchImpl ??
    ((async () => new Response(icsText, { status: 200 })) as unknown as typeof fetch);
  // 时基贯通：日程服务用同一个冻结时钟，否则 createTask 的「runAt 必须在未来」
  // 按真实时钟判定，真实日期越过 fixture 后建日程全部失败（时间炸弹）。
  const tasks = new ScheduleTaskService({ now: () => new Date(NOW) });
  const intents: ProactiveIntent[] = [];
  const service = new IcsSubscriptionService({
    config: {
      enabled: true,
      feeds: [{ name: "测试日历", url: "http://example.com/cal.ics" }],
      pollSec: 900,
      actorId: "user1",
      lookaheadDays: 35,
    },
    tasks,
    notify: (intent) => intents.push(intent),
    statePath: join(dir, "state.json"),
    // 自助订阅源必须落在临时目录，否则会写进项目自己的 data/ics-sub/feeds.json
    feedsPath: join(dir, "feeds.json"),
    fetchImpl,
    now: () => new Date(NOW),
  });
  try {
    await fn({ service, tasks, intents, setIcs: (t) => (icsText = t) });
  } finally {
    service.stop();
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("ICS 服务 diff：首拉全量建日程 + 汇总提醒 → 重拉零变更", async () => {
  await withIcsService(async ({ service, tasks, intents }) => {
    const firstChanged = await service.pollAll();
    assert.equal(firstChanged, true);
    const icsTasks = tasks.listAllTasks().filter((t) => t.source === "ics");
    assert.equal(icsTasks.length, 7);
    assert.ok(icsTasks.every((t) => t.sessionId === "user1" && t.category === "itinerary"));
    const meeting = icsTasks.find((t) => t.title!.includes("项目周会"))!;
    assert.equal(meeting.runAt, "2026-10-01T09:00:00.000Z");
    assert.equal(meeting.durationMinutes, 60);
    assert.ok(meeting.description!.includes("大会议室"));
    const trip = icsTasks.find((t) => t.title!.includes("出差上海"))!;
    // 全天事件落到本地 08:30（= 00:00+08 后移 8.5h）
    assert.equal(trip.runAt, new Date(Date.parse("2026-10-04T16:00:00Z") + 8.5 * 3_600_000).toISOString());
    assert.equal(intents.length, 1, "首拉只发一条汇总提醒");
    assert.equal(intents[0]!.source, "ics");
    assert.ok(intents[0]!.title.includes("已接入"));

    const secondChanged = await service.pollAll();
    assert.equal(secondChanged, false, "重拉相同内容应零变更");
    assert.equal(tasks.listAllTasks().filter((t) => t.source === "ics").length, 7);
    assert.equal(intents.length, 1, "零变更不打扰");
  });
});

test("ICS 服务 diff：源里改期 → 日程改期；源里消失 → 日程软取消", async () => {
  await withIcsService(async ({ service, tasks, intents, setIcs }) => {
    await service.pollAll();
    const before = tasks.listAllTasks().filter((t) => t.source === "ics");
    assert.equal(before.length, 7);

    setIcs(
      SAMPLE_ICS.replace("DTSTART:20261001T090000Z", "DTSTART:20261001T110000Z").replace(
        /BEGIN:VEVENT\r?\nUID:trip@example\.com[\s\S]*?END:VEVENT/,
        "",
      ),
    );
    const changed = await service.pollAll();
    assert.equal(changed, true);

    const meeting = before.find((t) => t.title!.includes("项目周会"))!;
    const afterMeeting = tasks.getTask(meeting.taskId)!;
    assert.equal(afterMeeting.status, "cancelled", "改期 = 旧次取消");
    const newMeeting = tasks
      .listAllTasks()
      .find((t) => t.source === "ics" && t.title!.includes("项目周会") && t.status === "active")!;
    assert.equal(newMeeting.runAt, "2026-10-01T11:00:00.000Z");

    const trip = before.find((t) => t.title!.includes("出差上海"))!;
    assert.equal(tasks.getTask(trip.taskId)!.status, "cancelled", "源里消失 → 软取消");

    assert.equal(intents.length, 2, "第二轮发一条更新提醒");
    assert.ok(intents[1]!.title.includes("有更新"));
  });
});

// ---------------------------------------------------------------------- //
// 自助订阅（2026-10-22）：用户自己粘链接就能接日历，不用部署方改环境变量
// ---------------------------------------------------------------------- //

test("订阅链接校验：协议与内网地址（防 SSRF）", () => {
  assert.equal(validateIcsFeedUrl("https://calendar.example.com/team.ics").ok, true);
  assert.equal(validateIcsFeedUrl("http://cal.example.com/a.ics").ok, true);

  const ftp = validateIcsFeedUrl("ftp://example.com/a.ics");
  assert.equal(ftp.ok, false);

  for (const url of [
    "http://127.0.0.1:5232/a.ics",
    "http://localhost/a.ics",
    "http://10.0.0.5/a.ics",
    "http://192.168.1.10/a.ics",
    "http://172.20.0.3/a.ics",
  ]) {
    const r = validateIcsFeedUrl(url);
    assert.equal(r.ok, false, `${url} 必须被拦`);
    if (!r.ok) assert.match(r.error, /内网|本机/);
  }

  // 自建日历在内网时，部署方可用环境变量放行
  const allowed = validateIcsFeedUrl("http://192.168.1.10:5232/dav/cal.ics", {
    ICS_SUB_ALLOW_PRIVATE: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(allowed.ok, true);

  assert.equal(validateIcsFeedUrl("这不是链接").ok, false);
  assert.equal(validateIcsFeedUrl("").ok, false);
});

test("自助订阅：粘链接即完成接入，并立刻导入存量事件", async () => {
  await withIcsService(async ({ service, tasks }) => {
    const r = await service.addFeed({
      name: "公司日历",
      url: "https://calendar.example.com/team.ics",
    });
    assert.equal(r.ok, true, `addFeed 失败：${r.error ?? "(无 error)"}`);
    assert.equal(r.feed?.name, "公司日历");
    assert.ok((r.imported ?? 0) > 0, "添加后应立即拉一轮，让用户当场看到结果");

    const status = service.status();
    assert.equal(status.feeds.length, 2, "env 配置的源 + 用户自助的源都在");
    assert.ok(status.feeds.some((f) => f.name === "公司日历"));
    assert.equal(status.enabled, true);

    const icsTasks = tasks.listAllTasks().filter((t) => t.source === "ics");
    assert.ok(icsTasks.length > 0, "自助添加的源也会物化成日程");
  });
});

test("自助订阅：重复添加同一链接不产生第二个源", async () => {
  await withIcsService(async ({ service }) => {
    const url = "https://calendar.example.com/team.ics";
    await service.addFeed({ url });
    const again = await service.addFeed({ url });
    assert.equal(again.ok, true);
    assert.equal(service.status().feeds.length, 2, "同一链接只算一个源");
  });
});

test("自助订阅：拉不到日历就不落盘，避免留一个永远失败的源", async () => {
  const failing = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;
  await withIcsService(
    async ({ service }) => {
      const r = await service.addFeed({ url: "https://bad.example.com/x.ics" });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /拉不到日历/);
      assert.equal(service.status().feeds.length, 1, "失败的源不能留在系统里");
    },
    { fetchImpl: failing },
  );
});

test("自助订阅：用户能删自己加的源，但删不掉部署方配置的源", async () => {
  await withIcsService(async ({ service }) => {
    const added = await service.addFeed({
      name: "公司日历",
      url: "https://calendar.example.com/team.ics",
    });
    assert.equal(added.ok, true, `addFeed 失败：${added.error ?? "(无 error)"}`);

    const ok = service.removeFeed("公司日历");
    assert.equal(ok.ok, true, `removeFeed 失败：${ok.error ?? "(无 error)"}`);
    assert.equal(service.status().feeds.length, 1);

    const denied = service.removeFeed("测试日历");
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /环境变量/);
  });
});
