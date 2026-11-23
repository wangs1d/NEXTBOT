/**
 * 档案页聚合读（/api/profile/overview 的纯函数部分，需求文档 §6.2/§6.4）单测。
 *
 * 契约：
 *   - 恒 ok:true、八个分区齐全；每个空分区都必须带诚实空态文案（不编数据）；
 *   - 条目带来源 + 时刻 + 删除句柄；health/感情/财务类打 sensitive（客户端折叠）；
 *   - 「最近新学到」只从内容分区派生，窗口外的条目不得混进来；
 *   - 作息条目只消费节律引擎给的结果：样本不足 → 空态；
 *   - 触点计划条目直接来自 planner 快照（时刻 / 窗口 / 状态 / 依据）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProfileOverview,
  hourLabel,
  sourceLabelOf,
  type OverviewEntity,
  type OverviewFact,
  type OverviewRelation,
  type OverviewRhythm,
  type ProfileOverviewSources,
} from "../src/routes/http/profile-overview.js";
import type { TouchpointPlan } from "../src/proactivity/touchpoint-planner.js";

const NOW = Date.parse("2026-11-23T12:00:00");
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function group(overview: ReturnType<typeof buildProfileOverview>, key: string) {
  const g = overview.groups.find((it) => it.key === key);
  assert.ok(g, `分区 ${key} 必须存在`);
  return g!;
}

test("空画像：八分区齐全，每区都给出诚实空态而不是套话填充", () => {
  const out = buildProfileOverview({ actorId: "u1" }, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.actorId, "u1");
  assert.equal(out.groups.length, 8);
  assert.deepEqual(
    out.groups.map((g) => g.key),
    ["rhythm", "habits", "places", "people", "recent", "plan", "watching", "feedback"],
  );
  for (const g of out.groups) {
    assert.equal(g.items.length, 0, `${g.key} 应无条目`);
    assert.ok(g.emptyText.length > 8, `${g.key} 空态文案要说清为什么是空的`);
    assert.equal(out.meta.counts[g.key], 0);
  }
  assert.equal(out.meta.plan, null, "没有触点计划快照时 meta.plan 为 null");
  assert.equal(out.meta.sensitiveCount, 0);
});

test("事实 / 生活模型 / 理解条目：分区归属、来源标签、敏感位与删除句柄", () => {
  const facts: OverviewFact[] = [
    {
      field: "饮食禁忌",
      value: "不吃香菜",
      category: "aversion",
      confidence: 0.9,
      sourceRef: "chat:turn-123",
      createdAt: iso(30 * DAY),
      updatedAt: iso(2 * DAY),
    },
    {
      field: "慢病史",
      value: "过敏性鼻炎",
      category: "health",
      confidence: 1,
      sourceRef: "ProfileManageRoute",
      createdAt: iso(3 * DAY),
      updatedAt: iso(3 * DAY),
    },
    {
      field: "睡觉时间",
      value: "23:30",
      category: "rhythm",
      confidence: 0.8,
      sourceRef: null,
      createdAt: iso(60 * DAY),
      updatedAt: iso(20 * DAY),
    },
  ];
  const entities: OverviewEntity[] = [
    {
      id: "e-sister",
      kind: "person",
      name: "小满",
      aliases: ["妹妹"],
      sensitivity: "normal",
      lastSeenAt: iso(1 * DAY),
      confidence: 0.85,
    },
    {
      id: "e-gym",
      kind: "place",
      name: "乐刻健身房",
      aliases: [],
      sensitivity: "normal",
      lastSeenAt: iso(12 * DAY),
      confidence: 0.6,
    },
  ];
  const relations: OverviewRelation[] = [
    {
      id: "r1",
      kind: "family",
      subKind: "妹妹",
      to: "小满",
      intimacy: 0.8,
      status: "active",
      sensitivity: "normal",
      updatedAt: iso(1 * DAY),
    },
    {
      id: "r2",
      kind: "romantic",
      subKind: null,
      to: "阿哲",
      intimacy: 0.9,
      status: "active",
      sensitivity: "sensitive",
      updatedAt: iso(4 * DAY),
    },
    {
      id: "r3",
      kind: "friend",
      subKind: null,
      to: "老王",
      intimacy: 0.4,
      status: "ended",
      sensitivity: "normal",
      updatedAt: iso(2 * DAY),
    },
  ];
  const out = buildProfileOverview(
    {
      actorId: "u1",
      facts,
      entities,
      relations,
      understandings: [{ topic: "靠窗座位", note: "坐高铁喜欢靠窗", kind: "preference" }],
      profileLines: [
        { section: "兴趣与习惯", line: "周末爬山", lastConfirmedAt: iso(40 * DAY) },
      ],
    },
    NOW,
  );

  const habits = group(out, "habits");
  const texts = habits.items.map((i) => i.text);
  assert.ok(texts.includes("饮食禁忌：不吃香菜"), `偏好区分区缺条目：${texts.join("|")}`);
  assert.ok(texts.includes("坐高铁喜欢靠窗"), "理解条目里的偏好应进偏好区");
  assert.ok(texts.includes("周末爬山"), "画像 md 行应进偏好区");
  const climb = habits.items.find((i) => i.text === "周末爬山")!;
  assert.deepEqual(
    climb.forget,
    { kind: "profileLine", ref: "interest::周末爬山" },
    "画像行删除句柄要带 /api/profile/manage/line 认得的 section 键",
  );
  assert.ok(texts.some((t) => t.includes("过敏性鼻炎")), "健康事实要看得见，只是默认折叠（§6.3）");

  // 健康条目：落在偏好区但必须标敏感（客户端默认折叠）
  const health = habits.items.find((i) => i.text.includes("过敏性鼻炎"))!;
  assert.ok(health.sensitive, "健康细节必须 sensitive");
  assert.equal(health.source, "你自己在设置里填的", "ProfileManageRoute 不是对话来源");
  assert.ok(health.pinned, "confidence=1 视为用户确认过");
  assert.deepEqual(health.forget, { kind: "fact", ref: "慢病史" });

  const aversion = habits.items.find((i) => i.text.includes("不吃香菜"))!;
  assert.equal(aversion.source, "对话里你说的");
  assert.equal(aversion.isNew, true, "2 天前变更 → 近 7 天内算新");
  assert.equal(aversion.at, Date.parse(iso(2 * DAY)));

  // 作息事实进作息分区，不混进偏好区
  assert.equal(habits.items.some((i) => i.text.includes("23:30")), false);
  const rhythm = group(out, "rhythm");
  assert.ok(rhythm.items.some((i) => i.text === "睡觉时间：23:30"));

  const people = group(out, "people");
  const peopleTexts = people.items.map((i) => i.text);
  assert.ok(peopleTexts.includes("妹妹·小满"), `关系边应渲染成「称谓·名字」：${peopleTexts.join("|")}`);
  assert.equal(peopleTexts.includes("老王"), false, "ended 关系不再当作「身边的人」");
  const romantic = people.items.find((i) => i.text.includes("阿哲"))!;
  assert.equal(romantic.sensitive, true, "感情类默认折叠");
  const sister = people.items.find((i) => i.text === "妹妹·小满")!;
  assert.deepEqual(sister.forget, { kind: "entity", ref: "e-sister" }, "删除句柄指向实体 id");
  assert.equal(romantic.forget, null, "对得上实体才给删除句柄，认不出就不给");

  const places = group(out, "places");
  assert.deepEqual(places.items.map((i) => i.text), ["乐刻健身房"]);
  assert.equal(places.items[0].isNew, false, "12 天前不算新学到");

  // 小红点口径：recent 只收内容分区里 isNew 的条目，且不带旧条目
  const recent = group(out, "recent");
  const recentTexts = recent.items.map((i) => i.text);
  assert.ok(recentTexts.includes("妹妹·小满"));
  assert.ok(recentTexts.includes("饮食禁忌：不吃香菜"));
  assert.equal(recentTexts.includes("乐刻健身房"), false);
  assert.equal(recentTexts.includes("周末爬山"), false);
  assert.ok(recent.items[0].at! >= recent.items[recent.items.length - 1].at!, "recent 按时间倒序");

  // sensitiveCount 不把派生视图（recent）重复计一次
  assert.equal(out.meta.sensitiveCount, 2, "健康 1 + 感情 1，recent 里重复出现不加倍");
});

test("作息分区：只读节律引擎推导结果；样本不足出空态，够则给时刻与漂移趋势", () => {
  const thin: OverviewRhythm = {
    sleepStartHour: null,
    wakeHour: null,
    nightCount: 1,
    days: [{ date: "2026-11-22", firstHour: 9.2, lastHour: 23.1 }],
  };
  const cold = buildProfileOverview({ actorId: "u1", rhythm: thin }, NOW);
  assert.equal(group(cold, "rhythm").items.length, 0);
  assert.match(group(cold, "rhythm").emptyText, /有效夜|才敢下结论/);

  const days = [
    { date: "2026-11-09", firstHour: 7.1, lastHour: 22.9 },
    { date: "2026-11-12", firstHour: 7.3, lastHour: 23.0 },
    { date: "2026-11-19", firstHour: 7.2, lastHour: 23.6 },
    { date: "2026-11-21", firstHour: 7.0, lastHour: 23.8 },
  ];
  const rich: OverviewRhythm = { sleepStartHour: 23.5, wakeHour: 7.2, nightCount: 6, days };
  const out = buildProfileOverview({ actorId: "u1", rhythm: rich }, NOW);
  const texts = group(out, "rhythm").items.map((i) => i.text);
  assert.ok(texts.includes("起床大概 07:12"), texts.join("|"));
  assert.ok(texts.includes("入睡大概 23:30"), texts.join("|"));
  const drift = group(out, "rhythm").items.find((i) => i.id === "rhythm:drift")!;
  assert.match(drift.text, /最近比之前晚睡约 \d+ 分钟/, drift.text);
  assert.equal(drift.source, "我观察出来的", "观察所得不能冒充用户说过的话");
  assert.equal(group(out, "rhythm").note, "观察样本：6 个有效夜（不足 3 夜我不下结论）");
});

test("触点计划分区：直接搬 planner 快照的时刻/窗口/状态，并把 dropped 写进口径", () => {
  const plan: TouchpointPlan = {
    actorId: "u1",
    date: "2026-11-23",
    frequencyTier: "normal",
    generatedAt: NOW,
    slots: [
      {
        slotId: "tp:u1:2026-11-23:morning",
        kind: "morning",
        minuteOf: 7 * 60 + 20,
        windowStart: 6 * 60,
        windowEnd: 9 * 60,
        trigger: "time",
        capacity: 3,
        candidates: ["k1", "k2"],
        status: "planned",
        basis: { source: "rhythm", confidence: 0.7 },
      },
      {
        slotId: "tp:u1:2026-11-23:tomorrow_preview",
        kind: "tomorrow_preview",
        minuteOf: 21 * 60 + 30,
        windowStart: 21 * 60,
        windowEnd: 22 * 60,
        trigger: "time",
        capacity: 1,
        candidates: [],
        status: "skipped",
        basis: { source: "default", confidence: 0.3 },
        reason: "no_candidate",
      },
    ],
  };
  const out = buildProfileOverview(
    { actorId: "u1", touchpoints: { plan, dropped: "超出当日额度：frequency_cap" } },
    NOW,
  );
  const g = group(out, "plan");
  assert.deepEqual(g.items.map((i) => i.text), ["早安简报 07:20", "明日速览 21:30"]);
  assert.match(g.items[0].detail!, /06:00–09:00 窗口 · 还没到点 · 攒了 2 条/);
  assert.equal(g.items[0].source, "按你的作息定的");
  assert.equal(g.items[1].source, "默认时间（还没学到你的作息）");
  assert.match(g.items[1].detail!, /这次跳过了 · no_candidate/);
  assert.equal(out.meta.plan?.slots, 2);
  assert.equal(out.meta.plan?.sent, 0);
  assert.match(g.note!, /频率档 normal · 没排进去的原因：超出当日额度/);
});

test("在办的事 / 反馈分寸：目标板、日程、台账、抑制表与 outcome 回声各自归位", () => {
  const out = buildProfileOverview(
    {
      actorId: "u1",
      goals: [
        {
          goalId: "g1",
          actorId: "u1",
          kind: "track",
          type: "custom",
          title: "盯演唱会开票",
          status: "watching",
          createdAt: NOW - 2 * DAY,
        },
        {
          goalId: "g2",
          actorId: "u1",
          kind: "plan",
          type: "custom",
          title: "已办结的旧目标",
          status: "done",
          createdAt: NOW - 40 * DAY,
        },
      ],
      suppressions: [
        {
          id: "s1",
          actorId: "u1",
          kind: "interest_alert",
          keywords: ["刘浩存"],
          note: "别再推这个演员",
          createdAt: iso(5 * DAY),
        },
      ],
      outcomes: [
        { deliveryId: "d1", actorId: "u1", kind: "greeting", channel: "ws", outcome: "replied", at: NOW - DAY },
        { deliveryId: "d2", actorId: "u1", kind: "weather_alert", channel: "push", outcome: "dismissed", at: NOW - 2 * DAY },
        { deliveryId: "d3", actorId: "u1", kind: "weather_alert", channel: "push", outcome: "dismissed", at: NOW - 3 * DAY },
        { deliveryId: "d4", actorId: "u2", kind: "greeting", channel: "ws", outcome: "accepted", at: NOW - DAY },
        { deliveryId: "d5", actorId: "u1", kind: "digest", channel: "ws", outcome: "viewed", at: NOW - DAY },
      ],
    },
    NOW,
  );
  const watching = group(out, "watching");
  assert.deepEqual(watching.items.map((i) => i.text), ["盯演唱会开票"], "done 目标不进在办区");
  assert.equal(watching.items[0].isNew, true);

  const feedback = group(out, "feedback");
  assert.equal(feedback.items[0].text, "别再提「刘浩存」");
  assert.equal(feedback.items[0].source, "你说过「别再提醒我这个」");
  const echo = feedback.items.find((i) => i.id === "outcome:echo")!;
  assert.equal(echo.text, "最近你回应了 3 次：认账 1、不认 2", "viewed 不算表态，别人的 outcome 不算进来");
  assert.match(echo.detail!, /最不待见的一类：weather_alert/);
});

test("来源标签与时刻换算的兜底口径：未知来源如实标注，不猜", () => {
  assert.equal(sourceLabelOf(null), "对话里你说的");
  assert.equal(sourceLabelOf("chat:turn-1"), "对话里你说的");
  assert.equal(sourceLabelOf("sms:1069"), "短信/邮件里看到的");
  assert.equal(sourceLabelOf("ingest:file-9"), "你上传的资料里");
  assert.equal(sourceLabelOf("profile-manage"), "你自己在设置里填的");
  assert.equal(sourceLabelOf("rhythm:nightly"), "我观察出来的");
  assert.equal(sourceLabelOf("weird-thing"), "来源标记：weird-thing");

  assert.equal(hourLabel(null), null);
  assert.equal(hourLabel(23.5), "23:30");
  assert.equal(hourLabel(7.05), "07:03");
  assert.equal(hourLabel(23.99), "23:59");
  assert.equal(hourLabel(23.9999), "00:00", "分钟进位不能写出 23:60");
  assert.equal(hourLabel(-0.5), "23:30", "跨日负值折回 24 小时制");

  const sources: ProfileOverviewSources = {
    actorId: "u1",
    facts: [
      {
        field: "怪来源",
        value: "x",
        category: "note",
        confidence: null,
        sourceRef: "weird-thing",
        createdAt: null,
        updatedAt: null,
      },
    ],
  };
  const item = group(buildProfileOverview(sources, NOW), "habits").items[0];
  assert.equal(item.source, "来源标记：weird-thing");
  assert.equal(item.at, null, "时刻未知就返回 null，不拿 now 冒充");
  assert.equal(item.confidence, null, "事实库没给置信度就不编");
  assert.equal(item.isNew, false, "没有时刻就不标新");
});
