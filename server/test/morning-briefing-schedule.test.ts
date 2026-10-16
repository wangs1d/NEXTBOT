import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MorningBriefingService,
  buildNarrationFacts,
  buildNarrationPrompt,
  sanitizeNarrationText,
} from "../src/services/morning-briefing-service.js";

const SESSION = "test-briefing-schedule";

type TaskLike = {
  taskId: string;
  sessionId?: string;
  title?: string;
  reminderMessage?: string;
  description?: string;
  status?: string;
  runAt?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  recurrence?: string;
  category?: string;
};

function makeService(tasks: TaskLike[]) {
  return new MorningBriefingService({
    scheduleTaskService: {
      listTasksBySession: (_sessionId: string, range?: { from: string; to: string }) => {
        if (range) lastRange = range;
        return tasks;
      },
      listAllTasks: () => tasks,
    } as never,
  });
}

let lastRange: { from: string; to: string } | null = null;

test("今日日程：按本日区间查询 + 时间格式化为本地 HH:mm", async () => {
  const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const svc = makeService([
    {
      taskId: "t1",
      sessionId: SESSION,
      title: "产品评审会",
      reminderMessage: "产品评审会",
      description: "",
      status: "active",
      nextRunAt: at(9, 30),
      runAt: at(9, 30),
      recurrence: "none",
    },
    {
      taskId: "t2",
      sessionId: SESSION,
      title: "已完成晨跑",
      reminderMessage: "晨跑打卡",
      description: "",
      status: "completed",
      lastRunAt: at(7, 5),
      runAt: at(7, 5),
      nextRunAt: null,
      recurrence: "none",
    },
  ]);

  const briefing = await svc.generateBriefing(SESSION);

  // 查询区间必须是"本日"（本地 00:00 起、24 小时窗口），而非未来 7 天/∞
  assert.ok(lastRange, "listTasksBySession 必须带区间参数");
  const from = new Date(lastRange!.from);
  const to = new Date(lastRange!.to);
  assert.equal(from.getHours(), 0);
  assert.equal(from.getMinutes(), 0);
  assert.equal(Math.round((to.getTime() - from.getTime()) / 86_400_000), 1);

  // 时间为本地 HH:mm，不再是原始 ISO 串
  assert.deepEqual(
    briefing.todaySchedule.map((s) => [s.title, s.time]),
    [
      ["产品评审会", "09:30"],
      ["晨跑打卡", "07:05"],
    ],
  );

  // 播报稿用真实日程 + HH:mm 时间（可被口播高亮规则命中）
  const { narrationText } = await svc.narrateBriefing(SESSION);
  assert.match(narrationText, /09:30的产品评审会/);
});

test("今日日程：睡觉/喝水等琐事提醒不进播报（与今日安排同口径）", async () => {
  const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const svc = makeService([
    {
      taskId: "meet",
      sessionId: SESSION,
      title: "周会",
      reminderMessage: "周会",
      description: "",
      status: "active",
      nextRunAt: at(10, 0),
      runAt: at(10, 0),
      recurrence: "none",
    },
    // trivia 分类（睡觉/喝水这类节律琐事）
    {
      taskId: "sleep",
      sessionId: SESSION,
      title: "该睡觉了",
      reminderMessage: "该睡觉了",
      description: "",
      status: "active",
      nextRunAt: at(23, 0),
      runAt: at(23, 0),
      recurrence: "none",
      category: "trivia",
    },
    // 旧数据：description 带节律标记
    {
      taskId: "water",
      sessionId: SESSION,
      title: "喝水提醒",
      reminderMessage: "喝水",
      description: "[节律提醒:喝水] 该喝水了",
      status: "active",
      nextRunAt: at(14, 0),
      runAt: at(14, 0),
      recurrence: "none",
    },
  ]);

  const briefing = await svc.generateBriefing(SESSION);
  assert.deepEqual(
    briefing.todaySchedule.map((s) => s.title),
    ["周会"],
    "琐事类提醒不应出现在简报日程里",
  );
  const { narrationText } = await svc.narrateBriefing(SESSION);
  assert.doesNotMatch(narrationText, /睡觉|喝水/);
  assert.match(narrationText, /10:00的周会/);
});

test("已完成计数：琐事完成不算进「今天已完成 N 件安排」", async () => {
  const now = new Date();
  const at = (h: number, m: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    return d.toISOString();
  };
  const svc = makeService([
    {
      taskId: "done-meet",
      sessionId: SESSION,
      title: "项目汇报",
      reminderMessage: "项目汇报",
      description: "",
      status: "completed",
      lastRunAt: at(9, 0),
      runAt: at(9, 0),
      recurrence: "none",
    },
    {
      taskId: "done-water",
      sessionId: SESSION,
      title: "喝水",
      reminderMessage: "喝水",
      description: "",
      status: "completed",
      lastRunAt: at(9, 10),
      runAt: at(9, 10),
      recurrence: "none",
      category: "trivia",
    },
  ]);

  const briefing = await svc.generateBriefing(SESSION);
  assert.equal(briefing.todoFollowups?.doneTodayCount ?? 0, 1, "只有正经日程计入已完成");
});

test("问候语固定为早安（简报只在早上播报）", async () => {
  const svc = makeService([]);
  const briefing = await svc.generateBriefing(SESSION);
  assert.equal(briefing.agentGreeting, "早上好！新的一天开始了，这是你的早间简报。");
});

test("播报稿润色：注入 LLM 时用其口语输出", async () => {
  const svc = new MorningBriefingService({
    scheduleTaskService: {
      listTasksBySession: () => [
        {
          taskId: "t1",
          sessionId: SESSION,
          title: "产品评审会",
          reminderMessage: "产品评审会",
          description: "",
          status: "active",
          nextRunAt: new Date(new Date().setHours(9, 30, 0, 0)).toISOString(),
          runAt: "",
          recurrence: "none",
        },
      ],
      listAllTasks: () => [],
    } as never,
    llmComplete: async () =>
      "上午9点半的产品评审会别忘了，材料都在手边了，慢慢讲没问题。",
  });
  const { narrationText } = await svc.narrateBriefing(SESSION);
  assert.match(narrationText, /上午9点半的产品评审会/);
  // 2026-09-24 定调：短稿原样采用，不再补「祝你今天顺利」客套垫尾
  assert.doesNotMatch(narrationText, /祝你今天顺利/);

  // 足够长（≥80 字）的润色稿原样采用，不补收尾、不截断
  const long = new MorningBriefingService({
    scheduleTaskService: {
      listTasksBySession: () => [],
      listAllTasks: () => [],
    } as never,
    llmComplete: async () =>
      "早上一睁眼就有个产品评审会等着你，九点半开始，昨晚整理的材料都在手边，照着节奏讲就行。" +
      "下午没排硬日程，可以把评审纪要顺手写掉，再留十分钟过一遍下周的安排，晚上就能轻轻松松收工，顺便早点休息啦。",
  });
  const longText = (await long.narrateBriefing(SESSION)).narrationText;
  assert.doesNotMatch(longText, /祝你今天顺利/);
});

test("播报稿润色：LLM 失败/输出过短 → 回退确定性模板", async () => {
  const makeSvc = (llm: () => Promise<string>) =>
    new MorningBriefingService({
      scheduleTaskService: {
        listTasksBySession: () => [],
        listAllTasks: () => [],
      } as never,
      llmComplete: llm,
    });
  // LLM 抛错 → 回退模板（2026-09-24 定调：模板不再带客套垫尾）
  const fallback = await makeSvc(async () => {
    throw new Error("llm down");
  }).narrateBriefing(SESSION);
  assert.doesNotMatch(fallback.narrationText, /祝你今天顺利|我随时在这儿/);
  // 输出为空 → 回退模板
  const empty = await makeSvc(async () => "  ").narrateBriefing(SESSION);
  assert.doesNotMatch(empty.narrationText, /祝你今天顺利|我随时在这儿/);
});

test("sanitizeNarrationText：去围栏/引号/换行", () => {
  assert.equal(sanitizeNarrationText('```\n"上午有会，记得来。"\n```'), "上午有会，记得来。");
  assert.equal(sanitizeNarrationText("第一句。\n第二句。"), "第一句。 第二句。");
  assert.equal(sanitizeNarrationText("  "), "");
});

test("buildNarrationPrompt：事实材料只含真实数据且带口语化指令", () => {
  const briefing = {
    date: "2026-09-13",
    todaySchedule: [{ id: "m1", title: "周会", time: "10:00" }],
    pendingNotes: [],
    agentGreeting: "",
  };
  const facts = buildNarrationFacts(briefing as never);
  assert.match(facts, /今日日程：10:00 周会/);
  const prompt = buildNarrationPrompt(briefing as never);
  assert.match(prompt, /禁止编造/);
  assert.match(prompt, /私人智能管家/);
  // 2026-09-24 定调：润色 prompt 必须带禁空话/禁客套收尾规则
  assert.match(prompt, /想起来喊我一声/);
  assert.match(prompt, /宁短勿凑/);
});
