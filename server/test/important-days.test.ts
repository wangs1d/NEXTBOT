// Task 17 人情关系管家测试：
//  1. daysUntilMMdd：当天命中 / 明天 / 7 天窗口 / 年度周期（今年已过按明年）
//  2. 明日速览：近期重要日子块（7 天窗口过滤 + 升序 + 无记录省略）
//     —— 2026-11-04 展示位从晨报迁到明日速览
//  3. 当天命中回调：onImportantDayToday 触发一次 + 同日去重（多次生成不重复打扰）
//     —— 晨报不再展示该块，但祝福回调仍在晨报侧触发（当天早上发出才有意义）
//  4. 祝福草稿：单次 LLM 生成 + 未注入 LLM 退化为确定性模板
import assert from "node:assert/strict";
import { test } from "node:test";

import { EveningDigestService } from "../src/services/evening-digest-service.js";
import {
  MorningBriefingService,
  daysUntilMMdd,
  generateImportantDayBlessing,
  importantDayTypeLabel,
  type MorningBriefingImportantDay,
} from "../src/services/morning-briefing-service.js";

const SESSION = "actor-important-days-test";

/** KV 存储 mock：important_dates 记录（结构与 care.set_important_date 写入一致） */
function makeStore(records: unknown[]) {
  return {
    getSnapshot(sessionId: string, keys?: string[]) {
      assert.equal(sessionId, SESSION);
      assert.deepEqual(keys, ["important_dates"]);
      return { revision: 1, entries: { important_dates: records } };
    },
  };
}

// ── 1. daysUntilMMdd ─────────────────────────────────

test("重要日子：daysUntilMMdd 距今天数计算", () => {
  const now = new Date("2026-08-29T10:30:00");

  // 今天命中
  assert.equal(daysUntilMMdd("08-29", now), 0);
  assert.equal(daysUntilMMdd("8-29", now), 0);
  // 明天 / 7 天后（窗口边界）
  assert.equal(daysUntilMMdd("08-30", now), 1);
  assert.equal(daysUntilMMdd("09-05", now), 7);
  // 窗口外
  assert.equal(daysUntilMMdd("09-06", now), 8);
  // 年度周期：今年已过 → 按明年计（永不返回负数）
  assert.equal(daysUntilMMdd("08-28", now), 364);
  assert.equal(daysUntilMMdd("01-01", now), 125);
  // 非法格式
  assert.equal(daysUntilMMdd("2026-08-29", now), -1);
  assert.equal(daysUntilMMdd("13-01", now), -1);
  assert.equal(daysUntilMMdd("", now), -1);
});

test("重要日子：类型中文标签", () => {
  assert.equal(importantDayTypeLabel("birthday"), "生日");
  assert.equal(importantDayTypeLabel("anniversary"), "纪念日");
  assert.equal(importantDayTypeLabel("custom"), "特殊日子");
});

// ── 2. 明日速览：近期重要日子块 ────────────────────

test("明日速览：近期重要日子块（7 天窗口过滤 + 按剩余天数升序）", async () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const far = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 20);

  const svc = new EveningDigestService({
    importantDaysStore: makeStore([
      // 今天命中（妈妈生日）
      { id: "d1", name: "妈妈", date: `${mm}-${dd}`, type: "birthday", relationship: "母亲", notes: "喜欢养花" },
      // 明天（纪念日）
      {
        id: "d2",
        name: "结婚纪念日",
        date: `${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
        type: "anniversary",
      },
      // 20 天后（窗口外，不出现）
      {
        id: "d3",
        name: "老王生日",
        date: `${String(far.getMonth() + 1).padStart(2, "0")}-${String(far.getDate()).padStart(2, "0")}`,
        type: "birthday",
      },
      // 脏数据（缺 name / 非法 date，跳过不崩）
      { id: "d4", date: "01-01", type: "birthday" },
      { id: "d5", name: "脏数据", date: "not-a-date", type: "birthday" },
    ]),
  });

  const digest = await svc.generateDigest(SESSION);
  const days = digest.importantDays ?? [];
  assert.equal(days.length, 2);
  // 升序：今天(0) → 明天(1)
  assert.equal(days[0]!.id, "d1");
  assert.equal(days[0]!.daysUntil, 0);
  assert.equal(days[0]!.relationship, "母亲");
  assert.equal(days[0]!.notes, "喜欢养花");
  assert.equal(days[1]!.id, "d2");
  assert.equal(days[1]!.daysUntil, 1);

  // 兜底文案带上最近的那一个
  assert.match(digest.narrationText, /妈妈的生日/);
});

test("明日速览：无重要日子记录时省略该块（结构不受影响）", async () => {
  const svc = new EveningDigestService({ importantDaysStore: makeStore([]) });
  const digest = await svc.generateDigest(SESSION);
  assert.equal(digest.importantDays, undefined);
});

test("晨报：不再展示近期重要日子（展示位迁往明日速览）", async () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const svc = new MorningBriefingService({
    agentMemorySyncService: makeStore([
      { id: "d1", name: "妈妈", date: `${mm}-${dd}`, type: "birthday" },
    ]),
  });
  const briefing = await svc.generateBriefing(SESSION);
  assert.equal("upcomingImportantDays" in briefing, false);
  assert.doesNotMatch(JSON.stringify(briefing), /妈妈/);
});

// ── 3. 当天命中回调 + 同日去重 ────────────────────────

test("当天命中：回调触发一次 + 同日去重（多次生成简报不重复打扰）", async () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const fired: string[] = [];

  const svc = new MorningBriefingService({
    agentMemorySyncService: makeStore([
      { id: "d1", name: "妈妈", date: `${mm}-${dd}`, type: "birthday", relationship: "母亲" },
    ]),
    onImportantDayToday: (sessionId, day) => {
      fired.push(`${sessionId}|${day.id}|${day.name}`);
    },
  });

  // 第一次生成 → 触发
  await svc.generateBriefing(SESSION);
  assert.equal(fired.length, 1);
  assert.equal(fired[0], `${SESSION}|d1|妈妈`);

  // 同日再次生成（手动触发简报/重复调度）→ 去重，不再触发
  await svc.generateBriefing(SESSION);
  await svc.generateBriefing(SESSION);
  assert.equal(fired.length, 1);
});

test("当天未命中（仅 7 天内预告）：不触发回调", async () => {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const fired: string[] = [];

  const svc = new MorningBriefingService({
    agentMemorySyncService: makeStore([
      {
        id: "d1",
        name: "爸爸",
        date: `${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
        type: "birthday",
      },
    ]),
    onImportantDayToday: () => {
      fired.push("hit");
    },
  });

  await svc.generateBriefing(SESSION);
  assert.equal(fired.length, 0);
  // 但 3 天后的日子会出现在明日速览的预告块里
  const digest = await new EveningDigestService({
    importantDaysStore: makeStore([
      {
        id: "d1",
        name: "爸爸",
        date: `${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
        type: "birthday",
      },
    ]),
  }).generateDigest(SESSION);
  assert.equal((digest.importantDays ?? [])[0]?.daysUntil, 3);
});

// ── 4. 祝福草稿 ──────────────────────────────────────

test("祝福草稿：单次 LLM 生成（关系标签+交往摘要进 prompt）", async () => {
  const day: MorningBriefingImportantDay = {
    id: "d1",
    name: "妈妈",
    date: "08-29",
    type: "birthday",
    relationship: "母亲",
    notes: "喜欢养花，最近在学国画",
    daysUntil: 0,
  };

  let calls = 0;
  let seenPrompt = "";
  const draft = await generateImportantDayBlessing(day, async (prompt) => {
    calls += 1;
    seenPrompt = prompt;
    return "妈，生日快乐！愿你像阳台上的花一样，每天都开开心心。";
  });

  assert.equal(calls, 1); // 克制原则：单次 LLM
  assert.match(seenPrompt, /母亲/);
  assert.match(seenPrompt, /妈妈/);
  assert.match(seenPrompt, /喜欢养花，最近在学国画/);
  assert.equal(draft, "妈，生日快乐！愿你像阳台上的花一样，每天都开开心心。");
});

test("祝福草稿：未注入 LLM / LLM 失败 → 确定性模板兜底", async () => {
  const day: MorningBriefingImportantDay = {
    id: "d1",
    name: "妈妈",
    date: "08-29",
    type: "birthday",
    daysUntil: 0,
  };

  // 未注入 LLM
  const fallback = await generateImportantDayBlessing(day);
  assert.match(fallback, /祝妈妈生日快乐/);

  // LLM 抛错 → 模板兜底（不阻塞提醒主链路）
  const errored = await generateImportantDayBlessing(day, async () => {
    throw new Error("LLM down");
  });
  assert.match(errored, /祝妈妈生日快乐/);
});
