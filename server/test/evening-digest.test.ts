// Task 15 生活节律测试：
//  1. detectSevereWeatherAlerts：暴雨/雷暴/冻雨/大雪/高温/寒潮/大风 确定性检测
//  2. EveningDigestService：今日回顾（journal 当日要点 + 当日账本新增）
//     + 明日预告（次日日程 + 次日天气预警）确定性聚合 + 播报拼接
//  3. 晨报恶劣天气预警联动：预警 + 当日有日程 → 回调一次（同日去重）
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detectSevereWeatherAlerts } from "../src/services/weather-service.js";
import { EveningDigestService } from "../src/services/evening-digest-service.js";
import { DailyJournalService } from "../src/services/daily-journal-service.js";
import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import { MorningBriefingService } from "../src/services/morning-briefing-service.js";

const SESSION = "actor-evening-digest-test";

// ── 1. 恶劣天气预警检测 ──────────────────────────────

test("预警检测：暴雨/雷暴/冻雨/大雪按天气码与文本兜底", () => {
  // 强降雨（大雨 WMO 65 / 强阵雨 82 / 文本"暴雨"）
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 65, weatherText: "大雨" }), ["强降雨"]);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 0, weatherText: "暴雨橙色预警" }), ["强降雨"]);
  // 雷暴
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 95, weatherText: "雷暴" }), ["雷暴"]);
  // 冻雨
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 66, weatherText: "冻雨" }), ["冻雨"]);
  // 大雪
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 75, weatherText: "大雪" }), ["大雪"]);
  // 无预警
  assert.deepEqual(detectSevereWeatherAlerts({ weatherCode: 1, weatherText: "大部晴朗", maxC: 26 }), []);
});

test("预警检测：高温/寒潮/大风按阈值", () => {
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", maxC: 36 }), ["高温"]);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", maxC: 34 }), []);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", minC: -10 }), ["寒潮"]);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", minC: -5 }), []);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", windKmh: 45 }), ["大风"]);
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", windKmh: 30 }), []);
  // 复合预警（高温 + 大风）
  assert.deepEqual(detectSevereWeatherAlerts({ weatherText: "晴", maxC: 37, windKmh: 50 }), ["高温", "大风"]);
});

// ── 2. EveningDigestService ──────────────────────────

async function makeJournalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evening-digest-journal-"));
  return dir;
}

function todayKeyShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

test("晚间 digest：今日回顾 + 明日预告确定性聚合与播报", async () => {
  const journalDir = await makeJournalDir();
  const financeDir = await mkdtemp(join(tmpdir(), "evening-digest-finance-"));
  try {
    // journal 当日记录（与 appendTurn 写入格式一致）
    const journal = new DailyJournalService(journalDir);
    const dateKey = todayKeyShanghai();
    await mkdir(join(journalDir, SESSION), { recursive: true });
    await writeFile(
      join(journalDir, SESSION, `journal-${dateKey}.md`),
      [
        `- [09:10] sess0001 U: 早上聊了周末爬山计划`,
        `- [09:10] sess0001 A: 帮你查了三条路线`,
        `- [14:30] sess0001 fact: 我最近在学日语`,
        `- [20:05] sess0001 prefer: 不喜欢太辣的`,
      ].join("\n") + "\n",
      "utf8",
    );

    // 当日账本新增（两笔支出一笔收入）
    const finance = new FinanceDeepService(financeDir);
    await finance.load();
    await finance.importTransactions(SESSION, [
      { id: "t1", date: new Date().toISOString(), amount: 35, type: "expense", category: "餐饮", description: "午饭" },
      { id: "t2", date: new Date().toISOString(), amount: 120, type: "expense", category: "购物", description: "日用品" },
      { id: "t3", date: new Date().toISOString(), amount: 5000, type: "income", category: "工资", description: "工资" },
    ]);

    // 明日日程 + 次日天气（mock）
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = new Date(
      tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9, 30,
    ).toISOString();

    const scheduleTaskService = {
      listTasksBySession: (sessionId: string) => {
        assert.equal(sessionId, SESSION);
        return [
          { taskId: "task-1", title: "项目周会", nextRunAt: tomorrowIso, runAt: tomorrowIso, reminderMessage: "" },
          // 后天的任务（不进明日预告）
          {
            taskId: "task-2",
            title: "后天的事",
            nextRunAt: new Date(tomorrow.getTime() + 86_400_000).toISOString(),
            runAt: "",
          },
        ];
      },
    };

    const weatherService = {
      getBrief: async () => ({
        source: "open-meteo" as const,
        latitude: 39.9,
        longitude: 116.4,
        timezone: "Asia/Shanghai",
        locationLabel: "北京市",
        currentTempC: 20,
        apparentTempC: 19,
        humidityPct: 60,
        windKmh: 10,
        precipitationMm: 0,
        weatherCode: 65,
        weatherText: "大雨",
        todayMinC: 18,
        todayMaxC: 24,
        peakRainPct: 90,
        clothingAdvice: "",
        hourlyForecast: [],
        summaryLine: "",
        tomorrow: { weatherCode: 95, weatherText: "雷暴", minC: 17, maxC: 23, rainPct: 85 },
      }),
    };
    const weatherPrefsService = {
      get: (sessionId: string) => {
        assert.equal(sessionId, SESSION);
        return { sessionId, latitude: 39.9, longitude: 116.4, timezone: "Asia/Shanghai", label: "北京市" };
      },
    };

    const svc = new EveningDigestService({
      journalService: journal,
      financeDeepService: finance,
      scheduleTaskService: scheduleTaskService as never,
      weatherService: weatherService as never,
      weatherPrefsService: weatherPrefsService as never,
    });

    const digest = await svc.generateDigest(SESSION);

    // 今日回顾：journal 要点（user/fact 优先）+ 当日账本新增
    assert.ok(digest.todayHighlights.length >= 3);
    assert.ok(digest.todayHighlights.some((h) => h.text.includes("爬山计划")));
    assert.equal(digest.todayLedger?.count, 3);
    assert.equal(digest.todayLedger?.expense, 155);
    assert.equal(digest.todayLedger?.income, 5000);

    // 明日预告：只含明日的日程 + 次日天气与预警
    assert.equal(digest.tomorrowSchedule.length, 1);
    assert.equal(digest.tomorrowSchedule[0]!.title, "项目周会");
    assert.equal(digest.tomorrowWeather?.text, "雷暴");
    assert.deepEqual(digest.tomorrowWeather?.alerts, ["雷暴"]);

    // 播报（2026-10-13 活人感定调）：只说明天，回顾/账本/晚安套话不进文案
    assert.match(digest.narrationText, /明天就一件事/);
    assert.match(digest.narrationText, /项目周会/);
    assert.match(digest.narrationText, /到点我叫你/);
    assert.match(digest.narrationText, /雷暴/);
    assert.doesNotMatch(digest.narrationText, /回顾|晚安|新增\d+笔/);
  } finally {
    await rm(journalDir, { recursive: true, force: true });
    await rm(financeDir, { recursive: true, force: true });
  }
});

test("晚间 digest：依赖缺失/无数据时各块自然省略", async () => {
  const svc = new EveningDigestService({});
  const digest = await svc.generateDigest(SESSION);
  assert.deepEqual(digest.todayHighlights, []);
  assert.equal(digest.todayLedger, null);
  assert.deepEqual(digest.tomorrowSchedule, []);
  assert.equal(digest.tomorrowWeather, null);
  // 无数据：明天没安排的不打扰文案（无天气源 → 无预警无雨分支）
  assert.match(digest.narrationText, /明天没安排/);
  assert.doesNotMatch(digest.narrationText, /晚上好|晚安/);
});

test("晚间 digest：文案交给 agent —— soul 进 system + 预告段进数据 + 失败回退", async () => {
  // 明日日程 mock：带预告段（起床闹钟 130min 前 = 7:20；night_before 不进）
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = new Date(
    tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9, 30,
  ).toISOString();
  const scheduleMock = {
    listTasksBySession: () => [
      {
        taskId: "task-1",
        title: "项目周会",
        nextRunAt: tomorrowIso,
        runAt: tomorrowIso,
        reminderMessage: "",
        preReminders: [
          { offsetMinutes: 700, stage: "night_before", label: "睡前备忘", message: "" },
          { offsetMinutes: 130, stage: "wake_alarm", label: "叫你起床", message: "" },
          { offsetMinutes: 40, stage: "depart", label: "该出门了", message: "" },
        ],
      },
    ],
  };

  let capturedSystem: string | undefined;
  const agentSvc = new EveningDigestService({
    scheduleTaskService: scheduleMock as never,
    soulProvider: () => "【人格·静态】\n你是用户的私人管家兼搭档，叫测试员。",
    llmComplete: async (prompt, opts) => {
      capturedSystem = opts?.systemPrompt;
      // 数据段口径：需要提前提醒的信息（含预告段时刻）；要求段 = 用户定稿
      assert.match(prompt, /需要提前提醒的信息/);
      assert.match(prompt, /项目周会/);
      assert.match(prompt, /叫你起床/);
      assert.match(prompt, /该出门了/);
      assert.doesNotMatch(prompt, /睡前备忘/); // night_before 不进明日数据
      assert.match(prompt, /最熟的那个朋友/);
      assert.match(prompt, /只挑最早或最要紧/);
      assert.match(prompt, /九点半有个周会/);
      return `明天九点半有个周会，八点五十我喊你出门。早点睡。`;
    },
  });
  const agentDigest = await agentSvc.generateDigest(SESSION);
  assert.equal(
    agentDigest.narrationText,
    "明天九点半有个周会，八点五十我喊你出门。早点睡。",
  );
  // soul 走 system（agent 人格影响文案）
  assert.match(capturedSystem ?? "", /人格·静态/);
  assert.match(capturedSystem ?? "", /测试员/);
  // 明日条目数据面：advanceNotes 预渲染（9:30 - 130min = 7:20）
  assert.deepEqual(agentDigest.tomorrowSchedule[0]!.advanceNotes, [
    "07:20叫你起床",
    "08:50该出门了",
  ]);

  // 包裹引号/围栏被净化剥掉
  const messySvc = new EveningDigestService({
    llmComplete: async () => "```「明天没安排，早点睡。」```",
  });
  const messyDigest = await messySvc.generateDigest(SESSION);
  assert.equal(messyDigest.narrationText, "明天没安排，早点睡。");

  // 失败回退：LLM 抛错 → 确定性模板顶上（无数据 → 「明天没安排」分支）
  const failSvc = new EveningDigestService({
    llmComplete: async () => {
      throw new Error("llm down");
    },
  });
  const failDigest = await failSvc.generateDigest(SESSION);
  assert.match(failDigest.narrationText, /明天没安排/);
  assert.doesNotMatch(failDigest.narrationText, /晚上好|晚安/);
});

// ── 3. 晨报恶劣天气预警联动 ──────────────────────────

test("晨报预警联动：预警 + 当日有日程 → 回调一次（同日去重）", async () => {
  const fired: Array<{ sessionId: string; alerts: string[]; scheduleCount: number }> = [];

  const weatherService = {
    getBrief: async () => ({
      source: "open-meteo" as const,
      latitude: 39.9,
      longitude: 116.4,
      timezone: "Asia/Shanghai",
      locationLabel: "北京市",
      currentTempC: 37,
      apparentTempC: 40,
      humidityPct: 40,
      windKmh: 50,
      precipitationMm: 0,
      weatherCode: 0,
      weatherText: "晴",
      todayMinC: 28,
      todayMaxC: 38,
      peakRainPct: 0,
      clothingAdvice: "",
      hourlyForecast: [],
      summaryLine: "",
    }),
  };
  const weatherPrefsService = {
    get: (sessionId: string) => ({ sessionId, latitude: 39.9, longitude: 116.4, timezone: "Asia/Shanghai" }),
  };
  const scheduleTaskService = {
    listTasksBySession: () => [
      { taskId: "task-1", title: "外出办事", description: "", nextRunAt: new Date().toISOString(), runAt: "" },
      { taskId: "task-2", title: "晚上聚餐", description: "", nextRunAt: new Date().toISOString(), runAt: "" },
    ],
  };

  const svc = new MorningBriefingService({
    weatherService: weatherService as never,
    weatherPrefsService: weatherPrefsService as never,
    scheduleTaskService: scheduleTaskService as never,
    onSevereWeatherAlert: (sessionId, alerts, scheduleCount) => {
      fired.push({ sessionId, alerts, scheduleCount });
    },
  });

  // 第一次生成：高温 + 大风预警，且有 2 项日程 → 触发
  await svc.generateBriefing(SESSION);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0]!.alerts, ["高温", "大风"]);
  assert.equal(fired[0]!.scheduleCount, 2);

  // 同日再次生成 → 去重
  await svc.generateBriefing(SESSION);
  assert.equal(fired.length, 1);
});

test("晨报预警联动：无预警或无日程 → 不触发", async () => {
  const fired: string[] = [];

  const makeSvc = (weatherText: string, hasSchedule: boolean) =>
    new MorningBriefingService({
      weatherService: {
        getBrief: async () => ({
          source: "open-meteo" as const,
          latitude: 39.9,
          longitude: 116.4,
          timezone: "Asia/Shanghai",
          locationLabel: "北京市",
          currentTempC: 25,
          apparentTempC: 25,
          humidityPct: 50,
          windKmh: 10,
          precipitationMm: 0,
          weatherCode: 1,
          weatherText,
          todayMinC: 20,
          todayMaxC: 28,
          peakRainPct: 0,
          clothingAdvice: "",
          hourlyForecast: [],
          summaryLine: "",
        }),
      } as never,
      weatherPrefsService: {
        get: (sessionId: string) => ({ sessionId, latitude: 39.9, longitude: 116.4, timezone: "Asia/Shanghai" }),
      } as never,
      scheduleTaskService: {
        listTasksBySession: () => (hasSchedule ? [{ taskId: "t", title: "事", description: "", nextRunAt: new Date().toISOString(), runAt: "" }] : []),
      } as never,
      onSevereWeatherAlert: () => {
        fired.push("hit");
      },
    });

  // 有预警但无日程 → 不触发
  await (await makeSvc("暴雨", false)).generateBriefing(`${SESSION}-a`);
  assert.equal(fired.length, 0);
  // 无预警有日程 → 不触发
  await (await makeSvc("晴", true)).generateBriefing(`${SESSION}-b`);
  assert.equal(fired.length, 0);
});
