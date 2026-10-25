/**
 * POI 核实闸单测（travel 主线 F3）。
 *
 * 契约：核实是「规划后的确定性一遍」——开放时间只吃 POI 自带文本，解析不出就
 * 如实标 unknown，绝不编造时段；闭馆日/停止入场这类「那天进不去」判 block，
 * 窗口不足/需预约/排太满判 warn，只作诚实交代的判 info。
 * 日历锚点用 2026-11-02（周一）/ 11-03（周二）/ 11-07（周六）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  parseOpeningHours,
  minutesOfTime,
  findReservationRule,
  verifyItinerary,
  summarizeIssues,
  groupIssuesByDay,
  issuesForDay,
} = await import("../src/skills/travel-planning/travel-poi-dossier.js");

// ======================== 开放时间解析 ========================

test("开放时间：星期范围 + 闭馆日（全角与「至」归一）", () => {
  const p = parseOpeningHours("周二至周日 09：00-17：00，周一闭馆");
  assert.equal(p.parsed, true);
  assert.deepEqual(p.closedDays, [1]);
  assert.equal(p.ranges.length, 1);
  assert.deepEqual(p.ranges[0]!.days, [2, 3, 4, 5, 6, 0]);
  assert.equal(p.ranges[0]!.openMin, 9 * 60);
  assert.equal(p.ranges[0]!.closeMin, 17 * 60);
});

test("开放时间：停止入场是一道独立闸", () => {
  const p = parseOpeningHours("08:30-17:00（16:30停止入场）");
  assert.equal(p.lastEntryMin, 16 * 60 + 30);
  assert.equal(p.ranges[0]!.openMin, 8 * 60 + 30);
  assert.deepEqual(p.ranges[0]!.days, []);
});

test("开放时间：全天 / 多时段 / 解析不出", () => {
  assert.equal(parseOpeningHours("全天开放").allDay, true);
  assert.equal(parseOpeningHours("全天开放").parsed, true);
  const two = parseOpeningHours("09:00-12:00，14:00-17:30");
  assert.equal(two.ranges.length, 2);
  assert.equal(two.parsed, true);
  const unknown = parseOpeningHours("以官网为准");
  assert.equal(unknown.parsed, false);
  assert.equal(parseOpeningHours("").parsed, false);
});

test("开放时间：只标注周末的夜场，工作日不在范围内", () => {
  const p = parseOpeningHours("周五至周日 10:00-22:00");
  assert.deepEqual(p.ranges[0]!.days, [5, 6, 0]);
});

test("时刻解析：ISO / HH:mm / 中文时段", () => {
  assert.equal(minutesOfTime("2026-11-03T09:30:00"), 570);
  assert.equal(minutesOfTime("09:30"), 570);
  assert.equal(minutesOfTime("上午9点半"), 570);
  assert.equal(minutesOfTime("下午3点"), 15 * 60);
  assert.equal(minutesOfTime("Day 1 上午"), null);
});

// ======================== 预约规则 ========================

test("预约：内置知识只收有把握的场馆，带来源与基准日", () => {
  const r = findReservationRule("布达拉宫");
  assert.equal(r?.required, "yes");
  assert.equal(r?.source, "builtin-knowledge");
  assert.equal(r?.leadDays, 7);
  assert.ok(r!.advice.includes("预约"));
  const g = findReservationRule("故宫博物院");
  assert.equal(g?.required, "yes");
  assert.ok(g!.releaseTime, "故宫应有放票时刻");
});

test("预约：博物馆类目走 category-rule（likely），无特征的自由景点不给规则", () => {
  const c = findReservationRule("苏州博物馆");
  assert.equal(c?.source, "category-rule");
  assert.equal(c?.required, "likely");
  assert.equal(findReservationRule("平江路历史街区"), null);
});

test("预约：POI 原文写了需预约则直接采信", () => {
  const r = findReservationRule("某某美术馆", "需提前一天网上预约");
  assert.equal(r?.source, "poi-opening-hours");
  assert.equal(r?.required, "yes");
});

// ======================== 行程核实 ========================

const mon = "2026-11-02";
const tue = "2026-11-03";

function stop(patch: Record<string, unknown>): Record<string, unknown> {
  return { name: "点位", type: "attraction", startTime: `${tue}T10:00:00`, ...patch };
}

test("核实：周一闭馆撞上周二的排程 → block closed_day", () => {
  const issues = verifyItinerary({
    days: [
      {
        date: mon,
        items: [
          stop({ name: "苏州博物馆", startTime: `${mon}T10:00:00`, openingHours: "周二至周日 09:00-17:00，周一闭馆" }),
        ],
      },
    ],
  });
  const closed = issues.filter((i) => i.kind === "closed_day");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.level, "block");
  assert.ok(closed[0]!.message.includes("周一闭馆"), closed[0]!.message);
});

test("核实：到点早于开门 → block outside_hours", () => {
  const issues = verifyItinerary({
    days: [{ date: tue, items: [stop({ name: "拙政园", startTime: `${tue}T08:00:00`, openingHours: "09:00-17:00" })] }],
  });
  const hit = issues.find((i) => i.kind === "outside_hours");
  assert.equal(hit?.level, "block");
  assert.ok(hit!.suggestion.includes("09:00"), hit!.suggestion);
});

test("核实：过了停止入场 → block late_entry", () => {
  const issues = verifyItinerary({
    days: [
      {
        date: tue,
        items: [
          stop({ name: "三星堆博物馆", startTime: `${tue}T17:00:00`, visitDuration: 60, openingHours: "08:30-17:00（16:30停止入场）" }),
        ],
      },
    ],
  });
  const late = issues.find((i) => i.kind === "late_entry");
  assert.equal(late?.level, "block");
  assert.ok(late!.message.includes("16:30 停止入场"), late!.message);
});

test("核实：赶在闭馆前但时间不够 → warn short_window", () => {
  const issues = verifyItinerary({
    days: [
      {
        date: tue,
        items: [
          stop({ name: "西安博物院", startTime: `${tue}T16:00:00`, endTime: `${tue}T17:30:00`, openingHours: "09:00-17:00" }),
        ],
      },
    ],
  });
  const sw = issues.find((i) => i.kind === "short_window");
  assert.equal(sw?.level, "warn");
  assert.ok(sw!.message.includes("只剩 60 分钟"), sw!.message);
});

test("核实：只标了别的日子开放 → warn（当天未见开放）", () => {
  const issues = verifyItinerary({
    days: [{ date: tue, items: [stop({ name: "夜市街区", startTime: `${tue}T14:00:00`, openingHours: "周五至周日 18:00-23:00" })] }],
  });
  const ooh = issues.filter((i) => i.kind === "outside_hours");
  assert.equal(ooh.length, 1);
  assert.equal(ooh[0]!.level, "warn");
});

test("核实：开放时间没取到但有票价 → info 诚实交代，不猜时段", () => {
  const issues = verifyItinerary({
    days: [{ date: tue, items: [stop({ name: "某小馆子遗址", priceInfo: "门票 30元" })] }],
  });
  const u = issues.find((i) => i.kind === "unknown_hours");
  assert.equal(u?.level, "info");
  assert.ok(u!.suggestion?.includes("官方"), u!.suggestion);
});

test("核实：预约提示每类来源的档位——知名场馆 warn、类目惯例 info", () => {
  const builtin = verifyItinerary({ days: [{ date: tue, items: [stop({ name: "布达拉宫" })] }] });
  const b = builtin.find((i) => i.kind === "reservation");
  assert.equal(b?.level, "warn");
  assert.ok(b!.suggestion?.includes("出发前 7 天"), b!.suggestion);

  const category = verifyItinerary({ days: [{ date: tue, items: [stop({ name: "苏州博物馆" })] }] });
  const c = category.find((i) => i.kind === "reservation");
  assert.equal(c?.level, "info");
  assert.equal(c?.name, "苏州博物馆");
});

test("核实：排得太满 → warn density（只数景点，住宿餐饮不占额度）", () => {
  const days = [
    {
      date: tue,
      items: [
        stop({ name: "A" }),
        stop({ name: "B" }),
        stop({ name: "C" }),
        { name: "午饭", type: "restaurant", startTime: `${tue}T12:00:00` },
        { name: "酒店", type: "hotel", startTime: `${tue}T20:00:00` },
      ] as never,
    },
  ];
  const issues = verifyItinerary({ days, maxStopsPerDay: 2 });
  const d = issues.find((i) => i.kind === "density");
  assert.equal(d?.level, "warn");
  assert.equal(d?.stop, -1);
  assert.ok(d!.message.includes("3 个景点"), d!.message);
  assert.equal(verifyItinerary({ days, maxStopsPerDay: 5 }).find((i) => i.kind === "density"), undefined);
});

test("核实：餐厅与酒店默认不核实（时间来自排程约定，不是场馆约束）", () => {
  const items = [
    { name: "老馆子", type: "restaurant", startTime: `${tue}T18:00:00`, openingHours: "11:00-14:00" },
    { name: "住宿", type: "hotel", startTime: `${tue}T21:00:00`, openingHours: "14:00-次日12:00" },
  ] as never;
  assert.deepEqual(verifyItinerary({ days: [{ date: tue, items }] }), []);
  const withRest = verifyItinerary({ days: [{ date: tue, items }], verifyRestaurants: true });
  assert.equal(withRest.find((i) => i.kind === "outside_hours")?.level, "block");
});

test("核实：全天开放与合规排程零问题", () => {
  const issues = verifyItinerary({
    days: [
      {
        date: tue,
        items: [
          stop({ name: "平江路历史街区", openingHours: "全天开放", priceInfo: "免费" }),
          stop({ name: "拙政园", startTime: `${tue}T14:00:00`, endTime: `${tue}T16:00:00`, openingHours: "07:30-17:30（17:00停止入场）" }),
        ],
      },
    ],
  });
  assert.deepEqual(issues.map((i) => i.kind), []);
});

test("汇总与按天归组：0 条不硬凑，站点查询含天级问题", () => {
  const issues = verifyItinerary({
    days: [
      { date: mon, items: [stop({ name: "苏州博物馆", startTime: `${mon}T10:00:00`, openingHours: "周二至周日 09:00-17:00，周一闭馆" })] },
      { date: tue, items: [stop({ name: "布达拉宫" })] },
    ],
    maxStopsPerDay: 1,
  });
  const sum = summarizeIssues(issues);
  assert.ok(sum && /冲突/.test(sum) && /需调整/.test(sum), sum);
  assert.equal(summarizeIssues([]), null);
  const byDay = groupIssuesByDay(issues);
  assert.deepEqual(Object.keys(byDay).map(Number).sort(), [0, 1]);
  assert.equal(issuesForDay(issues, 0, 0).some((i) => i.kind === "closed_day"), true);
  assert.equal(issuesForDay(issues, 1, 0)[0]!.kind, "reservation");
});
