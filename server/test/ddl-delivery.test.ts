import assert from "node:assert/strict";
import { test } from "node:test";

import { EveningDigestService } from "../src/services/evening-digest-service.js";
import { MorningBriefingService } from "../src/services/morning-briefing-service.js";
import type { DdlItem } from "../src/services/ddl-radar-service.js";

const NOW = new Date(2026, 9, 22, 20, 0, 0);

function item(over: Partial<DdlItem> & { id: string; title: string }): DdlItem {
  const due = new Date(2026, 9, 23, 15, 0, 0); // 明天 15:00
  return {
    dueAt: due.toISOString(),
    source: "commitment",
    tier: "tomorrow",
    dayDiff: 1,
    hoursLeft: 19,
    overdue: false,
    ...over,
  };
}

// ───────────────────────── 睡前备忘（L2） ─────────────────────────

test("晚间 digest 带上 L2 档：明天到期 + 今天已过期，且按截止时间升序", async () => {
  const overdue = item({
    id: "commitment:late",
    title: "交实习周报",
    dueAt: new Date(2026, 9, 22, 18, 0, 0).toISOString(),
    tier: "today",
    dayDiff: 0,
    overdue: true,
    hoursLeft: -2,
  });
  const tomorrow = item({ id: "commitment:tom", title: "交数据结构作业" });

  const svc = new EveningDigestService({
    ddlRadar: {
      forEvening: () => ({ tomorrow: [tomorrow], overdue: [overdue] }),
    },
  });
  const digest = await svc.generateDigest("s1");

  assert.equal(digest.deadlineReminders?.length, 2);
  assert.deepEqual(
    digest.deadlineReminders?.map((i) => i.title),
    ["交实习周报", "交数据结构作业"],
    "过期项按时间排在前面",
  );
});

test("没有 DDL 时字段整体省略（卡上不出现空块）", async () => {
  const svc = new EveningDigestService({
    ddlRadar: { forEvening: () => ({ tomorrow: [], overdue: [] }) },
  });
  const digest = await svc.generateDigest("s1");
  assert.equal(digest.deadlineReminders, undefined);
});

test("radar 抛错 → 降级省略，不影响 digest 主链路", async () => {
  const svc = new EveningDigestService({
    ddlRadar: {
      forEvening: () => {
        throw new Error("boom");
      },
    },
  });
  const digest = await svc.generateDigest("s1");
  assert.equal(digest.deadlineReminders, undefined);
  assert.equal(typeof digest.narrationText, "string");
});

test("确定性兜底文案带上要交的事（LLM 未注入时也不会漏）", async () => {
  const svc = new EveningDigestService({
    ddlRadar: {
      forEvening: () => ({
        tomorrow: [item({ id: "commitment:t", title: "交数据结构作业" })],
        overdue: [],
      }),
    },
  });
  const digest = await svc.generateDigest("s1");
  assert.match(digest.narrationText, /要交/);
  assert.match(digest.narrationText, /数据结构作业/);
});

// ───────────────────────── 晨间简报（L3 + L1） ─────────────────────────

test("晨报带上今天截止与这周还要交，且 L2（明天）不重复出现", async () => {
  const todayItem = item({
    id: "commitment:today",
    title: "交英语作业",
    dueAt: new Date(2026, 9, 22, 23, 0, 0).toISOString(),
    tier: "today",
    dayDiff: 0,
    hoursLeft: 3,
  });
  const soonItem = item({
    id: "commitment:soon",
    title: "交课程设计报告",
    tier: "soon",
    dayDiff: 3,
  });

  const svc = new MorningBriefingService({
    ddlRadar: { forMorning: () => ({ today: [todayItem], soon: [soonItem] }) },
  });
  const briefing = await svc.generateBriefing("s1");

  assert.equal(briefing.deadlines?.today.length, 1);
  assert.equal(briefing.deadlines?.soon.length, 1);

  // 无 llmComplete → 播报稿走确定性模板，验证兜底文案也带上了 DDL
  const { narrationText } = await svc.narrateBriefing("s1");
  assert.match(narrationText, /今天 .* 前要交/);
  assert.match(narrationText, /这周还有 1 项要交/);
});

test("晨报 DDL 两档皆空时整块省略", async () => {
  const svc = new MorningBriefingService({
    ddlRadar: { forMorning: () => ({ today: [], soon: [] }) },
  });
  const briefing = await svc.generateBriefing("s1");
  assert.equal(briefing.deadlines, undefined);
});
