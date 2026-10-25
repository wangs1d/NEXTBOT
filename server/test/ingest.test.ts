import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DdlRadarService,
  type IngestDeadlinesLike,
} from "../src/services/ddl-radar-service.js";
import {
  describeWeeklySlot,
  extractImage,
  extractProse,
  extractStructured,
  extractTabular,
  parsePeriods,
  type IngestChatLike,
} from "../src/services/ingest-extractors.js";
import { IngestService } from "../src/services/ingest-service.js";
import {
  computeNextWeeklyRunAt,
  materializeIngestedClasses,
} from "../src/services/ingest-schedule-bridge.js";
import { ScheduleTaskService, type ScheduleTaskRecord } from "../src/services/schedule-task-service.js";
import { ScheduleSensor } from "../src/proactivity/sensors/schedule-sensor.js";
import {
  detectPayloadKind,
  normalizeIngestTitle,
  validateIngestItem,
  type IngestItem,
  type IngestPayload,
} from "../src/services/ingest-types.js";

/** 固定"现在"：2026-10-22 10:00 本地（周四），避免随真实时钟漂移 */
const NOW = new Date(2026, 9, 22, 10, 0, 0);
const at = (dayOffset: number, h = 15, m = 0): string =>
  new Date(2026, 9, 22 + dayOffset, h, m, 0).toISOString();

function tempService(chat: IngestChatLike | null = null): {
  svc: IngestService;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "ingest-test-"));
  const svc = new IngestService({ now: () => NOW, rootDir: root, chat });
  return { svc, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:exam-1",
  "SUMMARY:数据结构期末考试",
  "DTSTART:20261024T010000Z",
  "DTEND:20261024T030000Z",
  "LOCATION:教三 201",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:club-1",
  "SUMMARY:社团例会",
  "DTSTART:20261025T110000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// ---------------------------------------------------------------------- //
// 载体判定：内容优先于称呼
// ---------------------------------------------------------------------- //

test("载体判定按内容走，不按用户怎么说", () => {
  assert.equal(detectPayloadKind({ kind: "prose", imageBase64: "AAA" }), "image");
  assert.equal(
    detectPayloadKind({ kind: "prose", text: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
    "structured",
    "内容是 ics 就必须走确定性解析，哪怕用户说是文本",
  );
  assert.equal(
    detectPayloadKind({ kind: "prose", text: "课程\t周一\n高数\t第1-2节" }),
    "tabular",
  );
  assert.equal(detectPayloadKind({ kind: "prose", text: "每周二三四上午有课" }), "prose");
});

// ---------------------------------------------------------------------- //
// ics：确定性解析
// ---------------------------------------------------------------------- //

test("ics：摘要含截止语义归 deadline，其余归 event", () => {
  const r = extractStructured(ICS, NOW);
  assert.equal(r.extractor, "ics");
  assert.equal(r.items.length, 2);
  const exam = r.items.find((i) => i.title.includes("数据结构"))!;
  assert.equal(exam.kind, "deadline");
  assert.ok(exam.dueAt, "截止项必须有截止时刻，否则进不了 DDL 雷达");
  assert.equal(exam.location, "教三 201");
  assert.equal(exam.confidence, 1, "确定性解析的置信度必须是 1");

  const club = r.items.find((i) => i.title.includes("社团"))!;
  assert.equal(club.kind, "event");
  assert.equal(club.dueAt, undefined);
});

test("ics：周期事件按次展开（课表每周一条，可直接排期）", () => {
  const weekly = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:math-101",
    "SUMMARY:高等数学",
    "DTSTART:20261023T010000Z",
    "DTEND:20261023T024000Z",
    "RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const r = extractStructured(weekly, NOW, 120);
  assert.equal(r.items.length, 4, "COUNT=4 应展开 4 次");
  assert.ok(r.items.every((i) => i.startsAt && i.durationMinutes === 100));
});

test("ics：空日历如实报错，不返回空数组假装成功", () => {
  const r = extractStructured("BEGIN:VCALENDAR\nEND:VCALENDAR", NOW);
  assert.equal(r.items.length, 0);
  assert.ok(r.dropped.length > 0, "必须说明为什么一条都没有");
});

// ---------------------------------------------------------------------- //
// 表格：矩阵式（课表）/ 长表式（DDL 清单）
// ---------------------------------------------------------------------- //

test("矩阵式课表：列头周几 → 课程条目，节次与教室都认得出", () => {
  const text = [
    "2026-2027学年第一学期课表",
    "节次\t周一\t周二\t周三",
    "第1-2节\t高等数学 A301\t\t大学英语 B202",
    "第3-4节\t\t线性代数 C101\t",
  ].join("\n");
  const r = extractTabular(text);
  assert.equal(r.extractor, "table-matrix");
  assert.equal(r.items.length, 3, "三个非空格子 = 三门课");

  const math = r.items.find((i) => i.title.includes("高等数学"))!;
  assert.equal(math.weeklySlot?.weekday, 1);
  assert.deepEqual(math.weeklySlot?.periods, [1, 2]);
  assert.equal(math.location, "A301");
  assert.equal(math.kind, "class");
  assert.match(describeWeeklySlot(math)!, /周一 第1、2节/);

  const english = r.items.find((i) => i.title.includes("大学英语"))!;
  assert.equal(english.weeklySlot?.weekday, 3);
  assert.equal(english.weeklySlot?.periods[0], 1);

  // 表头前面的学期标题行要显式说明被跳过，不能静默吞掉
  assert.ok(r.dropped.some((d) => d.reason.includes("标题")));
  assert.ok(r.needs?.some((n) => n.includes("校历")), "必须告诉用户缺校历");
});

test("矩阵式课表：认不出节次时退回行序，并把置信度降到 0.6", () => {
  const text = ["周一\t周二", "高数 A301\t英语 B202"].join("\n");
  const r = extractTabular(text);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].confidence, 0.6, "行序当节次是猜测，置信度必须降低");
  assert.deepEqual(r.items[0].weeklySlot?.periods, [1]);
});

test("长表式：截止日期列归 deadline，不会被当成星期列", () => {
  const text = ["事项\t截止时间", "数据结构作业\t2026-10-24 22:00"].join("\n");
  const r = extractTabular(text);
  assert.equal(r.extractor, "table-long");
  assert.equal(r.items.length, 1);
  const hw = r.items[0];
  assert.equal(hw.kind, "deadline", "「截止时间」必须归到 due 列，不能被「时间」抢成节次");
  assert.equal(hw.dueAt, at(2, 22, 0));
  assert.equal(hw.weeklySlot, undefined);
});

test("长表式：没有时间的行进 dropped 并说明原因", () => {
  const text = ["事项\t截止时间", "有时间的作业\t2026-10-24 22:00", "没时间的作业\t"].join("\n");
  const r = extractTabular(text);
  assert.equal(r.items.length, 1);
  assert.ok(r.dropped.some((d) => d.reason.includes("时间")));
});

test("表头不在第一行也能认（教务系统复制出来常带说明行）", () => {
  const text = [
    "姓名：张三  学号：20260001",
    "周一\t周二\t周三\t周四\t周五",
    "高数 A301\t\t英语\t\t体育",
  ].join("\n");
  const r = extractTabular(text);
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every((i) => i.weeklySlot));
});

// ---------------------------------------------------------------------- //
// 文本 / 图片：模型路径的诚实失败
// ---------------------------------------------------------------------- //

test("prose：没有可用模型时给明确原因，不返回空成功", async () => {
  const r = await extractProse("每周二三四上午有课", {
    chat: null,
    now: NOW,
    sessionId: "s1",
  });
  assert.equal(r.items.length, 0);
  assert.ok(r.error, "必须报错");
  assert.match(r.error!, /没有可用的语言模型/);
  assert.match(r.error!, /ics|表格/, "报错要给出替代路径，不要只说不行");
});

test("prose：模型输出经周几/节次解析成条目", async () => {
  const fakeChat: IngestChatLike = {
    isEnabled: () => true,
    streamCompletion: async () =>
      "```json\n" +
      JSON.stringify({
        items: [
          { kind: "class", title: "操作系统", weekday: "周三", periods: "5-6", location: "D404", confidence: 0.9 },
          { kind: "deadline", title: "编译原理实验报告", date: "2026-10-26", time: "23:59", confidence: 0.85 },
        ],
      }) +
      "\n```",
  };
  const r = await extractProse("材料", { chat: fakeChat, now: NOW, sessionId: "s1" });
  assert.equal(r.items.length, 2);
  const os = r.items.find((i) => i.title === "操作系统")!;
  assert.equal(os.weeklySlot?.weekday, 3);
  assert.deepEqual(os.weeklySlot?.periods, [5, 6]);
  const report = r.items.find((i) => i.title.includes("编译原理"))!;
  assert.equal(report.kind, "deadline");
  assert.equal(report.dueAt, at(4, 23, 59));
});

test("prose：模型不按 JSON 返回时报错，不静默吞掉", async () => {
  const badChat: IngestChatLike = {
    isEnabled: () => true,
    streamCompletion: async () => "好的，我看到了你的课表。",
  };
  const r = await extractProse("材料", { chat: badChat, now: NOW, sessionId: "s1" });
  assert.equal(r.items.length, 0);
  assert.match(r.error!, /不是结构化数据/);
});

test("图片：没有视觉模型时说明原因，并给出替代路径", async () => {
  const r = await extractImage("AAAA", "image/png", { visionExtract: null });
  assert.equal(r.items.length, 0);
  assert.match(r.error!, /视觉模型/);
  assert.match(r.error!, /ics|表格/);
});

test("图片：视觉模型返回 JSON 时正常成条目", async () => {
  const r = await extractImage("AAAA", "image/png", {
    visionExtract: async () =>
      JSON.stringify({
        items: [
          { kind: "class", title: "大学物理", weekday: "周四", periods: "1-2", location: "理教 302", confidence: 0.8 },
        ],
      }),
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].weeklySlot?.weekday, 4);
});

// ---------------------------------------------------------------------- //
// 条目闸门
// ---------------------------------------------------------------------- //

test("条目校验：截止项没截止时间、无时刻无周几，都必须拒绝", () => {
  const base: IngestItem = {
    key: "k",
    kind: "deadline",
    title: "作业",
    confidence: 1,
  };
  assert.match(validateIngestItem(base)!, /截止时间/);
  assert.match(validateIngestItem({ ...base, kind: "event" })!, /无法定位/);
  assert.equal(validateIngestItem({ ...base, dueAt: at(1) }), null);
  assert.equal(
    validateIngestItem({
      ...base,
      kind: "class",
      weeklySlot: { weekday: 2, periods: [1] },
    }),
    null,
  );
});

test("自然键：不含时间，换教室/改期仍是同一条", () => {
  const a = normalizeIngestTitle("高等数学（A301）");
  const b = normalizeIngestTitle("高等数学(A301)");
  assert.equal(a, b, "全半角括号必须归一，否则同一门课会变两条");
  assert.equal(parsePeriods("第3-4节").join(","), "3,4");
  assert.equal(parsePeriods("单周 5").join(","), "5");
});

// ---------------------------------------------------------------------- //
// 服务：preview → commit → 重复上传就是更新
// ---------------------------------------------------------------------- //

const TABLE: IngestPayload = {
  kind: "prose",
  text: ["事项\t截止时间", "数据结构作业\t2026-10-24 22:00"].join("\n"),
  fileName: "ddl.csv",
};

test("preview 不写台账；commit 才落库", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p = await svc.preview({ actorId: "u1", payload: TABLE });
    assert.equal(p.items.length, 1);
    assert.equal(p.summary.newCount, 1);
    assert.equal(svc.list("u1").items.length, 0, "预览阶段绝不能落库");

    const c = await svc.commit({ actorId: "u1", draftId: p.draftId });
    assert.equal(c.written, 1);
    assert.equal(c.added, 1);
    assert.equal(svc.list("u1").items.length, 1);
  } finally {
    cleanup();
  }
});

test("重复上传同一张表 = unchanged，不产生重复条目", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p1 = await svc.preview({ actorId: "u1", payload: TABLE });
    await svc.commit({ actorId: "u1", draftId: p1.draftId });

    const p2 = await svc.preview({ actorId: "u1", payload: TABLE });
    assert.equal(p2.summary.unchangedCount, 1);
    assert.equal(p2.summary.newCount, 0);

    await svc.commit({ actorId: "u1", draftId: p2.draftId });
    assert.equal(svc.list("u1").items.length, 1, "重传不能让台账变两条");
  } finally {
    cleanup();
  }
});

test("同一件事改期 = updated，台账仍是同一条且时间已换", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p1 = await svc.preview({ actorId: "u1", payload: TABLE });
    await svc.commit({ actorId: "u1", draftId: p1.draftId });

    const moved: IngestPayload = {
      ...TABLE,
      text: ["事项\t截止时间", "数据结构作业\t2026-10-27 22:00"].join("\n"),
    };
    const p2 = await svc.preview({ actorId: "u1", payload: moved });
    assert.equal(p2.summary.updatedCount, 1);
    assert.equal(p2.items[0].change, "updated");
    assert.equal(p2.items[0].previous?.dueAt, at(2, 22, 0), "预览要展示改前时间供核对");

    await svc.commit({ actorId: "u1", draftId: p2.draftId });
    const ledger = svc.list("u1");
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].dueAt, at(5, 22, 0));
  } finally {
    cleanup();
  }
});

test("只勾选一部分：没勾的条目不落库", async () => {
  const { svc, cleanup } = tempService();
  try {
    const two: IngestPayload = {
      kind: "prose",
      text: ["事项\t截止时间", "作业A\t2026-10-24 22:00", "作业B\t2026-10-25 22:00"].join("\n"),
      fileName: "x.csv",
    };
    const p = await svc.preview({ actorId: "u1", payload: two });
    assert.equal(p.items.length, 2);
    const keep = p.items[0].key;
    const c = await svc.commit({ actorId: "u1", draftId: p.draftId, keys: [keep] });
    assert.equal(c.written, 1);
    assert.equal(c.skipped, 1);
    const ledger = svc.list("u1");
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].key, keep);
  } finally {
    cleanup();
  }
});

test("别人的草稿写不进自己的台账", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p = await svc.preview({ actorId: "u1", payload: TABLE });
    const c = await svc.commit({ actorId: "u2", draftId: p.draftId });
    assert.equal(c.written, 0);
    assert.equal(svc.list("u2").items.length, 0);
    assert.equal(svc.list("u1").items.length, 0);
  } finally {
    cleanup();
  }
});

test("listDeadlines 只给截止项，课表不混进 DDL", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p1 = await svc.preview({
      actorId: "u1",
      payload: { kind: "prose", text: ["周一\t周二", "高数 A301\t英语"].join("\n") },
    });
    await svc.commit({ actorId: "u1", draftId: p1.draftId, keys: p1.items.map((i) => i.key) });
    const p2 = await svc.preview({ actorId: "u1", payload: TABLE });
    await svc.commit({ actorId: "u1", draftId: p2.draftId });

    const deadlines = svc.listDeadlines("u1");
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0].title, "数据结构作业");
  } finally {
    cleanup();
  }
});

test("xlsx：Excel 课表先解码成表格文本，再走同一套抽取", async () => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["节次", "周一", "周二"],
    ["第1-2节", "高等数学 A301", ""],
    ["第3-4节", "", "线性代数 C101"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "课表");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const { svc, cleanup } = tempService();
  try {
    const p = await svc.preview({
      actorId: "u1",
      payload: {
        kind: "prose",
        fileName: "我的课表.xlsx",
        fileBase64: buf.toString("base64"),
      },
    });
    assert.equal(p.error, undefined);
    assert.equal(p.items.length, 2, "两个非空格子 = 两门课");
    const math = p.items.find((i) => i.title.includes("高等数学"))!;
    assert.equal(math.weeklySlot?.weekday, 1);
    assert.deepEqual(math.weeklySlot?.periods, [1, 2]);
  } finally {
    cleanup();
  }
});

test("xlsx：解不出内容时如实报错，而不是静默返回 0 条", async () => {
  const { svc, cleanup } = tempService();
  try {
    const p = await svc.preview({
      actorId: "u1",
      payload: { kind: "prose", fileName: "坏文件.xlsx", fileBase64: "AAAA" },
    });
    assert.equal(p.items.length, 0);
    assert.match(p.error ?? "", /解不出内容/);
    assert.match(p.error ?? "", /csv|复制粘贴/, "报错要给出可执行的替代方案");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------- //
// DDL 雷达：fromIngested
// ---------------------------------------------------------------------- //

function ingestOf(
  rows: Array<{ key: string; title: string; dueAt: string; category?: string }>,
): IngestDeadlinesLike {
  return {
    listDeadlines: () =>
      rows.map((r) => ({ ...r, sourceLabel: "上传的 ddl.csv" })),
  };
}

test("fromIngested：按本地日历日分档，过期项归今天不消失", () => {
  const radar = new DdlRadarService({
    now: () => NOW,
    ingestService: ingestOf([
      { key: "d:past", title: "昨天的作业", dueAt: at(-1, 20, 0) },
      { key: "d:today", title: "今天的作业", dueAt: at(0, 20, 0) },
      { key: "d:tomorrow", title: "明天的作业", dueAt: at(1, 9, 0) },
      { key: "d:soon", title: "后天的作业", dueAt: at(2, 9, 0) },
      { key: "d:later", title: "下个月的作业", dueAt: at(30, 9, 0) },
    ]),
  });
  const r = radar.scan("u1", "u1");
  assert.deepEqual(
    r.today.map((i) => i.title),
    ["昨天的作业", "今天的作业"],
    "过期不许消失，留在 L3（按截止时间升序）",
  );
  assert.equal(r.today.find((i) => i.title === "昨天的作业")!.overdue, true);
  assert.equal(r.today.find((i) => i.title === "今天的作业")!.overdue, false);
  assert.deepEqual(r.tomorrow.map((i) => i.title), ["明天的作业"]);
  assert.deepEqual(r.soon.map((i) => i.title), ["后天的作业"]);
  assert.equal(r.total, 4, "超过 3 天的远期项不进三档");
});

test("fromIngested 的条目可以和日程同标题去重", () => {
  const radar = new DdlRadarService({
    now: () => NOW,
    scheduleTaskService: {
      listTasksBySession: () => [
        {
          taskId: "t1",
          title: "数据结构作业",
          description: "提交数据结构作业",
          runAt: at(1, 9, 0),
          nextRunAt: null,
          status: "pending",
          category: "study",
        },
      ],
    },
    ingestService: ingestOf([
      { key: "d:1", title: "数据结构作业", dueAt: at(2, 9, 0) },
    ]),
  });
  const r = radar.scan("u1", "u1");
  assert.equal(r.total, 1, "同一件事只出现一次");
  assert.equal(r.tomorrow.length, 1, "保留截止更早的那条");
  assert.equal(r.tomorrow[0].source, "schedule");
});

test("fromIngested：台账抛错不影响其他数据源", () => {
  const radar = new DdlRadarService({
    now: () => NOW,
    scheduleTaskService: {
      listTasksBySession: () => [
        {
          taskId: "t1",
          title: "论文初稿",
          description: "提交论文初稿",
          runAt: at(0, 23, 0),
          nextRunAt: null,
          status: "pending",
          category: "study",
        },
      ],
    },
    ingestService: {
      listDeadlines: () => {
        throw new Error("磁盘挂了");
      },
    },
  });
  const r = radar.scan("u1", "u1");
  assert.equal(r.today.length, 1, "上传数据源故障不能拖垮整个雷达");
});

// ---------------------------------------------------------------------- //
// 课表 → 周期日程（2026-10-22 收编）
//   课表的真实载体是日程（weekly 重复），台账只留去重索引。
//   这样一条上传的课表会：到点提醒 → 进「今日安排」→ schedule-sensor 扫进
//   世界板 → 晨报，而不是躺在台账里谁也不认识。
// ---------------------------------------------------------------------- //

const CLASS_TABLE = [
  "节次\t周一\t周三",
  "第1-2节\t高等数学 A301\t",
  "第3-4节\t\t大学英语 B202",
].join("\n");

/** 北京时间 2026-10-22 10:00（周四）：让"下一个周一"可断言，且不受测试机时区影响 */
const CN_NOW = new Date("2026-10-22T02:00:00Z");

async function withClassService(
  fn: (h: { svc: IngestService; tasks: ScheduleTaskService }) => Promise<void>,
  opts: { withSchedule?: boolean } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ingest-class-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(root, "schedule-tasks.json");
  const tasks = new ScheduleTaskService({ now: () => new Date(CN_NOW) });
  const svc = new IngestService({
    now: () => new Date(CN_NOW),
    rootDir: join(root, "ingest"),
    timezone: "Asia/Shanghai",
    ...(opts.withSchedule === false ? {} : { scheduleTasks: tasks }),
  });
  try {
    await fn({ svc, tasks });
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

test("课表 commit → 落成 weekly 日程，台账回写指针", async () => {
  await withClassService(async ({ svc, tasks }) => {
    const p = await svc.preview({ actorId: "u1", payload: { kind: "tabular", text: CLASS_TABLE } });
    const c = await svc.commit({ actorId: "u1", draftId: p.draftId });

    assert.equal(c.scheduled?.created, 2, "两门课各建一条日程");
    const all = tasks.listAllTasks();
    assert.equal(all.length, 2);

    const math = all.find((t) => t.title === "高等数学")!;
    assert.equal(math.recurrence, "weekly", "课表是周期事件，不是单次提醒");
    assert.equal(math.source, "ingest", "来源可追溯，不冒充用户手建");
    assert.equal(math.location, "A301");
    assert.equal(math.durationMinutes, 95, "第1-2节 = 45×2 + 5 课间");
    assert.equal(
      new Date(math.runAt).toISOString(),
      "2026-10-26T00:00:00.000Z",
      "北京 10-26（周一）08:00 首次触发",
    );

    const items = svc.list("u1").items;
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.scheduleTaskId), "每个课表条目都指回自己的日程");
  });
});

test("重传同一门课（换教室）= 更新那条日程，不新建", async () => {
  await withClassService(async ({ svc, tasks }) => {
    const p1 = await svc.preview({ actorId: "u1", payload: { kind: "tabular", text: CLASS_TABLE } });
    await svc.commit({ actorId: "u1", draftId: p1.draftId });

    const moved = CLASS_TABLE.replace("A301", "E505");
    const p2 = await svc.preview({ actorId: "u1", payload: { kind: "tabular", text: moved } });
    assert.equal(p2.items.find((i) => i.title === "高等数学")?.change, "updated");

    const c2 = await svc.commit({ actorId: "u1", draftId: p2.draftId });
    assert.equal(c2.scheduled?.created, 0, "一条都不该新建");
    assert.equal(c2.scheduled?.updated, 2);

    const all = tasks.listAllTasks();
    assert.equal(all.length, 2, "日程没变多");
    assert.equal(all.find((t) => t.title === "高等数学")?.location, "E505");
  });
});

test("删台账条目 → 对应日程一起删（不留继续响的课）", async () => {
  await withClassService(async ({ svc, tasks }) => {
    const p = await svc.preview({ actorId: "u1", payload: { kind: "tabular", text: CLASS_TABLE } });
    await svc.commit({ actorId: "u1", draftId: p.draftId });
    assert.equal(tasks.listAllTasks().length, 2);

    const target = svc.list("u1").items[0];
    const r = await svc.remove({ actorId: "u1", keys: [target.key] });
    assert.equal(r.removed, 1);
    assert.equal(r.removedSchedules, 1);
    assert.equal(tasks.listAllTasks().length, 1);
  });
});

test("未装配日程服务：课表不排期，也不假装排了", async () => {
  await withClassService(
    async ({ svc }) => {
      const p = await svc.preview({ actorId: "u1", payload: { kind: "tabular", text: CLASS_TABLE } });
      const c = await svc.commit({ actorId: "u1", draftId: p.draftId });
      assert.equal(c.scheduled, undefined, "没装配就缺省，不能给一个 created:0 让人以为排过");
      assert.equal(svc.list("u1").items.length, 2, "台账仍然可用");
    },
    { withSchedule: false },
  );
});

test("课表条目没有节次 → 不落日程，如实说原因", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-class-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(root, "schedule-tasks.json");
  const tasks = new ScheduleTaskService({ now: () => new Date(CN_NOW) });
  try {
    const r = await materializeIngestedClasses(
      [
        {
          key: "class:体育",
          kind: "class",
          title: "体育",
          weeklySlot: { weekday: 5, periods: [] },
          confidence: 0.7,
        },
      ],
      tasks,
      { sessionId: "s1", timezone: "Asia/Shanghai", now: CN_NOW },
    );
    assert.equal(r.created, 0);
    assert.equal(tasks.listAllTasks().length, 0);
    assert.match(r.skipped[0].reason, /节次|时间/);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("下一个周几：今天这节还没到就是今天，已过就排下周", () => {
  // 北京时间 2026-10-22 10:00，周四
  assert.equal(
    computeNextWeeklyRunAt({ weekday: 4, startMinutes: 14 * 60, now: CN_NOW, timezone: "Asia/Shanghai" }),
    "2026-10-22T14:00:00",
  );
  assert.equal(
    computeNextWeeklyRunAt({ weekday: 4, startMinutes: 8 * 60, now: CN_NOW, timezone: "Asia/Shanghai" }),
    "2026-10-29T08:00:00",
    "今天的早八已过，排下周四",
  );
  assert.equal(
    computeNextWeeklyRunAt({ weekday: 1, startMinutes: 8 * 60, now: CN_NOW, timezone: "Asia/Shanghai" }),
    "2026-10-26T08:00:00",
  );
});

test("课表落成的周期日程：推进一周后仍在日程扫描器视野里", async () => {
  // 收编的最后一环：课表进日程后要真的被 schedule-sensor 看见。
  // 它原来读 runAt（首次触发时刻），每周课在第一次响过之后就"消失"了。
  const scheduleSensor = new ScheduleSensor({
    listTasks: () =>
      [
        {
          taskId: "t1",
          title: "高等数学",
          runAt: "2026-10-19T00:00:00.000Z", // 上周一（已过去）
          nextRunAt: "2026-10-22T02:30:00.000Z", // 推进后的下一次：半小时后上课
          status: "active",
          recurrence: "weekly",
        } as unknown as ScheduleTaskRecord,
      ] as ScheduleTaskRecord[],
    nowFn: () => CN_NOW.getTime(),
  });
  const signals = scheduleSensor.collect(0);
  assert.ok(signals.length > 0, "推进过的周期任务不能从世界板视野里消失");
  assert.equal(signals[0].payload?.nextTitle, "高等数学");

  // 已完成的一次性任务不该被当成"下一个日程"
  const doneSensor = new ScheduleSensor({
    listTasks: () =>
      [
        {
          taskId: "t2",
          title: "交作业",
          runAt: "2026-10-23T00:00:00.000Z",
          nextRunAt: null,
          status: "completed",
          recurrence: "none",
        } as unknown as ScheduleTaskRecord,
      ] as ScheduleTaskRecord[],
    nowFn: () => CN_NOW.getTime(),
  });
  assert.equal(doneSensor.collect(0)[0]?.payload?.nextTitle ?? "", "");
});
