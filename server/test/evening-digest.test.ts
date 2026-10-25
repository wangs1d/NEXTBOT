// Task 15 生活节律测试：
//  1. detectSevereWeatherAlerts：暴雨/雷暴/冻雨/大雪/高温/寒潮/大风 确定性检测
//  2. EveningDigestService：明日预告（次日日程 + 次日天气预警 + 穿衣）
//     确定性聚合 + 播报拼接 + 天气定位兜底
//  3. 晨报恶劣天气预警联动：预警 + 当日有日程 → 回调一次（同日去重）
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectSevereWeatherAlerts } from "../src/services/weather-service.js";
import { EveningDigestService } from "../src/services/evening-digest-service.js";
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

test("晚间 digest：明日行程 + 次日天气与穿衣确定性聚合与播报", async () => {
  // 明日行程 + 次日天气（mock）
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
    scheduleTaskService: scheduleTaskService as never,
    weatherService: weatherService as never,
    weatherPrefsService: weatherPrefsService as never,
  });

  const digest = await svc.generateDigest(SESSION);

  // 明日行程：只含明日的行程 + 次日天气与预警 + 穿衣建议（buildClothingAdvice 同源）
  assert.equal(digest.tomorrowSchedule.length, 1);
  assert.equal(digest.tomorrowSchedule[0]!.title, "项目周会");
  assert.equal(digest.tomorrowWeather?.text, "雷暴");
  assert.deepEqual(digest.tomorrowWeather?.alerts, ["雷暴"]);
  // 明日 17~23° 有雷暴雨 → 薄外套层 + 雨具（digest 数据块，全串口径）
  assert.equal(digest.outfitTip, "薄外套或长袖叠穿；携带雨具（伞或雨衣）");

  // 播报（2026-10-13 活人感定调）：只说明天，回顾/晚安套话不进文案；
  // 2026-10-16 天气/穿衣迁入且简短口径：一个层级 + 一个行动项，不念全串
  assert.match(digest.narrationText, /明天就一件事/);
  assert.match(digest.narrationText, /项目周会/);
  assert.match(digest.narrationText, /到点我叫你/);
  assert.match(digest.narrationText, /明天雷暴17~23度，长袖，记得带伞。/);
  assert.doesNotMatch(digest.narrationText, /回顾|晚安|新增\d+笔|薄外套或长袖叠穿/);
});

test("晚间 digest：依赖缺失/无数据时各块自然省略", async () => {
  const svc = new EveningDigestService({});
  const digest = await svc.generateDigest(SESSION);
  assert.deepEqual(digest.tomorrowSchedule, []);
  assert.equal(digest.tomorrowWeather, null);
  assert.equal(digest.outfitTip, null);
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
      // night_before 不进明日数据（只查数据段；写法段指令提及「睡前备忘」无妨）
      const dataSection = prompt.split("写法：")[0] ?? "";
      assert.doesNotMatch(dataSection, /睡前备忘/);
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

test("晚间 digest：无天气位置偏好时按定位兜底取明日天气", async () => {
  const calledWith: number[] = [];
  const weatherService = {
    getBrief: async (latitude: number) => {
      calledWith.push(latitude);
      return {
        source: "open-meteo" as const,
        latitude,
        longitude: 104.89,
        timezone: "Asia/Shanghai",
        locationLabel: "兴义市",
        currentTempC: 18,
        apparentTempC: 18,
        humidityPct: 70,
        windKmh: 8,
        precipitationMm: 0,
        weatherCode: 3,
        weatherText: "阴",
        todayMinC: 16,
        todayMaxC: 22,
        peakRainPct: 20,
        clothingAdvice: "",
        hourlyForecast: [],
        summaryLine: "",
        tomorrow: { weatherCode: 61, weatherText: "小雨", minC: 15, maxC: 19, rainPct: 80 },
      };
    },
  };
  const providerCalls: string[] = [];

  // 位置偏好空表（PUT /weather/prefs 客户端从不写）→ 兜底取最新定位
  const fallbackSvc = new EveningDigestService({
    weatherService: weatherService as never,
    weatherPrefsService: { get: () => undefined } as never,
    locationProvider: async (sessionId) => {
      providerCalls.push(sessionId);
      return { latitude: 25.09, longitude: 104.89, timezone: "Asia/Shanghai", label: "兴义市" };
    },
  });
  const fallbackDigest = await fallbackSvc.generateDigest(SESSION);
  assert.deepEqual(providerCalls, [SESSION]);
  assert.deepEqual(calledWith, [25.09]);
  assert.equal(fallbackDigest.tomorrowWeather?.text, "小雨");
  assert.match(fallbackDigest.narrationText, /明天没安排，小雨15~19度，外套，记得带伞/);

  // 显式位置偏好优先：有 prefs 时不打兜底口
  const prefsSvc = new EveningDigestService({
    weatherService: weatherService as never,
    weatherPrefsService: {
      get: () => ({
        sessionId: SESSION,
        latitude: 39.9,
        longitude: 116.4,
        timezone: "Asia/Shanghai",
      }),
    } as never,
    locationProvider: async () => {
      throw new Error("有显式位置偏好时不该走兜底");
    },
  });
  const prefsDigest = await prefsSvc.generateDigest(SESSION);
  assert.equal(prefsDigest.tomorrowWeather?.text, "小雨");
  assert.equal(calledWith[calledWith.length - 1], 39.9);

  // 兜底也拿不到定位 → 天气块整块省略（不许编）
  const noneSvc = new EveningDigestService({
    weatherService: weatherService as never,
    locationProvider: async () => null,
  });
  assert.equal((await noneSvc.generateDigest(SESSION)).tomorrowWeather, null);
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
