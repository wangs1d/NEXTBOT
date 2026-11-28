// Task 15 生活节律测试：
//  1. detectSevereWeatherAlerts：暴雨/雷暴/冻雨/大雪/高温/寒潮/大风 确定性检测
//  2. EveningDigestService：明日预览主动推送面（只有天气 + 一两句闲聊，
//     2026-11-23 §3.4 分工）+ 问答数据面（行程/天气/DDL/重要日子照旧答全）
//     + 没内容不发（skipped）
//  3. 晨报恶劣天气预警联动：预警 + 当日有日程 → 回调一次（同日去重）
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectSevereWeatherAlerts } from "../src/services/weather-service.js";
import {
  EveningDigestService,
  hasEveningDigestContent,
} from "../src/services/evening-digest-service.js";
import { MorningBriefingService } from "../src/services/morning-briefing-service.js";
import { renderTomorrowPreviewFacts } from "../src/render/scenes/tomorrow-preview.scene.js";

const SESSION = "actor-evening-digest-test";

/** 与 EveningDigestService.localDateKey 同口径的本地日历日键 */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

// ── 2. EveningDigestService：一次取数、两个出口（§3.4）──────────────

/** 明天（真实明天，9:30「项目周会」）+ 一条后天的事（不该出现在明日数据里） */
function scheduleMock() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = new Date(
    tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9, 30,
  ).toISOString();
  return {
    listTasksBySession: (sessionId: string) => {
      assert.equal(sessionId, SESSION);
      return [
        { taskId: "task-1", title: "项目周会", nextRunAt: tomorrowIso, runAt: tomorrowIso, reminderMessage: "" },
        // 后天的任务（不进明日数据）
        {
          taskId: "task-2",
          title: "后天的事",
          nextRunAt: new Date(tomorrow.getTime() + 86_400_000).toISOString(),
          runAt: "",
        },
      ];
    },
  };
}

/** 明日天气报文：雷暴 17~23℃、雨集中下午 14–18 点（daily 按被预告那天取数） */
function weatherMock() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
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
      daily: [
        { date: dayKey(new Date()), weatherCode: 65, weatherText: "大雨", minC: 18, maxC: 24, rainPct: 90 },
        { date: dayKey(tomorrow), weatherCode: 95, weatherText: "雷暴", minC: 17, maxC: 23, rainPct: 85 },
      ],
      tomorrow: {
        weatherCode: 95,
        weatherText: "雷暴",
        minC: 17,
        maxC: 23,
        rainPct: 85,
        rainWindow: { period: "下午", startHour: 14, endHour: 18, peakPct: 85, label: "下午 14–18 点", alreadyPassed: false },
      },
    }),
  };
}

const prefsMock = {
  get: (sessionId: string) => {
    assert.equal(sessionId, SESSION);
    return { sessionId, latitude: 39.9, longitude: 116.4, timezone: "Asia/Shanghai", label: "北京市" };
  },
};

/** 行程 + 天气齐备的服务：两个出口都拿得到（默认无 LLM → 走确定性兜底文案） */
const makeFullService = (
  deps: ConstructorParameters<typeof EveningDigestService>[0] = {},
) =>
  new EveningDigestService({
    scheduleTaskService: scheduleMock() as never,
    weatherService: weatherMock() as never,
    weatherPrefsService: prefsMock as never,
    ...deps,
  });

test("明日预览推送面：只有天气与闲聊，载荷里没有行程/截止/重要日子（§3.4 分工写死）", async () => {
  // 3 天后的生日：7 天窗口内，问答面会有、推送面必须没有
  const soon = new Date();
  soon.setDate(soon.getDate() + 3);
  const soonMMDD = `${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  const svc = makeFullService({
    ddlRadar: {
      forEvening: () => ({
        tomorrow: [
          {
            id: "commitment:hw",
            title: "交数据结构作业",
            source: "commitment",
            tier: "tomorrow",
            dayDiff: 1,
            hoursLeft: 20,
            overdue: false,
            dueAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
          },
        ],
        overdue: [],
      }),
    },
    importantDaysStore: {
      getSnapshot: () => ({
        revision: 1,
        entries: {
          important_dates: [{ id: "d1", name: "妈妈", date: soonMMDD, type: "birthday" }],
        },
      }),
    } as never,
  });

  const digest = await svc.generateDigest(SESSION);

  // 天气在文案里（§3.4：天气就是这一格的正文，2026-11-06「天气不上文案」作废）
  assert.equal(digest.tomorrowWeather?.text, "雷暴");
  assert.deepEqual(digest.tomorrowWeather?.alerts, ["雷暴"]);
  assert.equal(digest.tomorrowWeather?.rainWindowLabel, "下午 14–18 点");
  assert.match(digest.narrationText, /雷暴/);
  assert.match(digest.narrationText, /17~23℃/);
  assert.match(digest.narrationText, /预警/);
  assert.match(digest.narrationText, /伞/);

  // 行程 / 截止 / 重要日子：不是空数组，是整块没有这个 key（卡面读不到 key 就什么都不出）
  assert.equal("tomorrowSchedule" in digest, false);
  assert.equal("deadlineReminders" in digest, false);
  assert.equal("importantDays" in digest, false);
  assert.doesNotMatch(digest.narrationText, /项目周会|数据结构作业|妈妈/);
  assert.equal(hasEveningDigestContent(digest), true);

  // 同一份数据的问答面三块都还在（§3.4 是搬家，不是删数据）
  const facts = await svc.generatePreviewFacts(SESSION);
  assert.equal(facts.tomorrowSchedule[0]?.title, "项目周会");
  assert.equal(facts.deadlineReminders?.[0]?.title, "交数据结构作业");
  assert.equal(facts.importantDays?.[0]?.name, "妈妈");
});

test("问答数据面不受分工限制：问「明天有什么安排」照旧拿到完整行程", async () => {
  const svc = makeFullService();
  const facts = await svc.generatePreviewFacts(SESSION);

  assert.equal(facts.tomorrowSchedule.length, 1);
  assert.equal(facts.tomorrowSchedule[0]!.title, "项目周会");
  assert.equal(facts.tomorrowWeather?.text, "雷暴");

  // 问答面喂给 tomorrow_preview 场景：事实块里行程行还在（模型据此答全）
  const factsBlock = renderTomorrowPreviewFacts(facts);
  assert.match(factsBlock, /行程：/);
  assert.match(factsBlock, /- 09:30 项目周会/);
  assert.match(factsBlock, /天气：雷暴 17–23℃|天气：雷暴 17~23℃/);

  // 推送面喂同一个场景也不会漏出行程——载荷里根本没有那一面（缺键 ≠ 没日程）
  const digest = await svc.generateDigest(SESSION);
  const pushBlock = renderTomorrowPreviewFacts(digest);
  assert.doesNotMatch(pushBlock, /行程：|项目周会/);
  assert.match(pushBlock, /雷暴/);
});

test("闲聊素材：取用口给的话进文案，最多两句、空行不凑数", async () => {
  const svc = makeFullService({
    previewMaterialProvider: () => ({
      lines: ["今天那篇你下午存的文章还没看", "这周都一两点才睡，有点晚", "", "第三条不会要"],
    }),
  });
  const digest = await svc.generateDigest(SESSION);
  assert.deepEqual(digest.chatLines, [
    "今天那篇你下午存的文章还没看",
    "这周都一两点才睡，有点晚",
  ]);
  assert.match(digest.narrationText, /雷暴/);
  assert.match(digest.narrationText, /你下午存的文章/);
  assert.doesNotMatch(digest.narrationText, /第三条/);
});

test("没内容不发兜底话术：天气拉不到且无闲聊素材 → 文案空串（调度器据此 skipped）", async () => {
  // 只有行程源活着：天气没配、素材没给 → 明日预览这一格无话可说
  const svc = new EveningDigestService({
    scheduleTaskService: scheduleMock() as never,
  });
  const digest = await svc.generateDigest(SESSION);
  assert.equal(digest.tomorrowWeather, null);
  assert.equal(digest.narrationText, "");
  assert.doesNotMatch(digest.narrationText, /明天没安排|早点睡|晚安/);
  assert.equal(hasEveningDigestContent(digest), false);

  // 问答面同一次取数照样有行程（数据没丢，只是不上睡前的卡）
  const facts = await svc.generatePreviewFacts(SESSION);
  assert.equal(facts.tomorrowSchedule.length, 1);
});

test("天气拿不到但有闲聊素材 → 照发，正文就是那一句", async () => {
  const svc = new EveningDigestService({
    previewMaterialProvider: () => ({ lines: ["这周都一两点才睡，试着提前半小时"] }),
  });
  const digest = await svc.generateDigest(SESSION);
  assert.equal(digest.tomorrowWeather, null);
  assert.match(digest.narrationText, /一两点才睡/);
  assert.equal(hasEveningDigestContent(digest), true);
});

test("作息周报只搭周日那一格（非周日给了也不上卡）", async () => {
  // previewDate = 下周一 → 虚拟"今天"是周日；再取下周三 = 虚拟"今天"周一
  const t = new Date();
  const nextMonday = new Date(
    t.getFullYear(), t.getMonth(), t.getDate() + ((8 - t.getDay()) % 7 || 7),
  );
  const nextWednesday = new Date(
    t.getFullYear(), t.getMonth(), t.getDate() + ((9 - t.getDay()) % 7 || 7),
  );
  const material = { weeklyRhythmReport: ["工作日平均 1:20 睡", 1, ""] };
  const make = (previewDate: Date) =>
    new EveningDigestService({
      previewMaterialProvider: () => material,
    } as never);

  const sunday = await make(nextMonday).generateDigest(SESSION, {
    previewDate: dayKey(nextMonday),
  });
  assert.deepEqual(sunday.rhythmReport, ["工作日平均 1:20 睡", "1"]);
  assert.match(sunday.narrationText, /工作日平均 1:20 睡/);

  const monday = await make(nextWednesday).generateDigest(SESSION, {
    previewDate: dayKey(nextWednesday),
  });
  assert.equal(monday.rhythmReport, undefined);
  assert.equal(hasEveningDigestContent(monday), false, "非周日 + 无天气 → 不发");
});

test("晚间 digest：天气取数失败（抛错）也只丢天气块，问答面数据不受影响", async () => {
  const svc = new EveningDigestService({
    scheduleTaskService: scheduleMock() as never,
    weatherService: {
      getBrief: async () => {
        throw new Error("open-meteo down");
      },
    } as never,
    weatherPrefsService: prefsMock as never,
  });
  const digest = await svc.generateDigest(SESSION);
  assert.equal(digest.tomorrowWeather, null);
  assert.equal(digest.narrationText, "");
  const facts = await svc.generatePreviewFacts(SESSION);
  assert.equal(facts.tomorrowSchedule.length, 1, "天气挂了不影响行程取数");
});

test("晚间 digest：文案主路交 agent —— system 走 soul、数据段只有天气与素材", async () => {
  let capturedSystem: string | undefined;
  let capturedPrompt = "";
  const svc = new EveningDigestService({
    scheduleTaskService: scheduleMock() as never,
    weatherService: weatherMock() as never,
    weatherPrefsService: prefsMock as never,
    previewMaterialProvider: () => ({ lines: ["今天下午聊的那件事"] }),
    soulProvider: () => "【人格·静态】\n你是用户的私人管家兼搭档，叫测试员。",
    ddlRadar: {
      forEvening: () => ({
        tomorrow: [
          {
            id: "commitment:hw",
            title: "交数据结构作业",
            source: "commitment",
            tier: "tomorrow",
            dayDiff: 1,
            hoursLeft: 20,
            overdue: false,
            dueAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
          },
        ],
        overdue: [],
      }),
    },
    llmComplete: async (prompt, opts) => {
      capturedPrompt = prompt;
      capturedSystem = opts?.systemPrompt;
      return "明天雷暴，雨大概集中在下午两点到六点，伞放包里。今天下午聊的那件事我记着。";
    },
  });
  const digest = await svc.generateDigest(SESSION);

  // 数据段：天气 + 素材；行程 / 截止在 prompt 里根本不存在（看不到就不会说）
  const dataSection = capturedPrompt.split("写法：")[0] ?? "";
  assert.match(dataSection, /明天（\d+月\d+日 周.）的天气：雷暴 17~23℃/);
  assert.match(dataSection, /雨集中在下午 14–18 点/);
  assert.match(dataSection, /今天下午聊的那件事/);
  assert.doesNotMatch(dataSection, /项目周会|交数据结构作业|截止事项|行程/);
  // 贫嘴禁令沿用（口吻纪律仍在写法段，人格走 system 单点）
  assert.match(capturedPrompt, /贫嘴/);
  assert.match(capturedSystem ?? "", /人格·静态/);
  assert.equal(
    digest.narrationText,
    "明天雷暴，雨大概集中在下午两点到六点，伞放包里。今天下午聊的那件事我记着。",
  );

  // 包裹引号/围栏被净化剥掉
  const messySvc = new EveningDigestService({
    weatherService: weatherMock() as never,
    weatherPrefsService: prefsMock as never,
    llmComplete: async () => "```「明天雷暴，伞放包里。」```",
  });
  assert.equal((await messySvc.generateDigest(SESSION)).narrationText, "明天雷暴，伞放包里。");

  // LLM 抛错 → 确定性兜底顶上（兜底也说天气，不说行程）
  const failSvc = makeFullService({
    llmComplete: async () => {
      throw new Error("llm down");
    },
  });
  const failDigest = await failSvc.generateDigest(SESSION);
  assert.match(failDigest.narrationText, /雷暴/);
  assert.doesNotMatch(failDigest.narrationText, /项目周会|晚上好|晚安/);
});

test("skipNarration：问答/补推路径只要数据，不白花一次 LLM", async () => {
  let llmCalls = 0;
  const svc = makeFullService({
    llmComplete: async () => {
      llmCalls += 1;
      return "不该被调用";
    },
  });
  const digest = await svc.generateDigest(SESSION, { skipNarration: true });
  assert.equal(llmCalls, 0);
  assert.equal(digest.narrationText, "");
  // 数据块照算（天气在，只是文案留给调用方另说）
  assert.equal(digest.tomorrowWeather?.text, "雷暴");
});

test("晚间 digest：无天气位置偏好时按定位兜底取明日天气", async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
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
        daily: [
          { date: dayKey(new Date()), weatherCode: 3, weatherText: "阴", minC: 16, maxC: 22, rainPct: 20 },
          { date: dayKey(tomorrow), weatherCode: 61, weatherText: "小雨", minC: 15, maxC: 19, rainPct: 80 },
        ],
        tomorrow: { weatherCode: 61, weatherText: "小雨", minC: 15, maxC: 19, rainPct: 80 },
      };
    },
  };
  const calledWith: number[] = [];
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
  // §3.4：兜底文案的正文就是天气（行程/「明天没安排」那句随行程块一起撤下）
  assert.equal(fallbackDigest.narrationText, "明天小雨，15~19℃。出门记得带伞。");

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

  // 兜底也拿不到定位 → 天气块整块省略（不许编），无素材时整格不发
  const noneSvc = new EveningDigestService({
    weatherService: weatherService as never,
    locationProvider: async () => null,
  });
  const noneDigest = await noneSvc.generateDigest(SESSION);
  assert.equal(noneDigest.tomorrowWeather, null);
  assert.equal(hasEveningDigestContent(noneDigest), false);
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

test("晨报照旧列今日日程（§3.4 分工：日程与截止只在早安出现）", async () => {
  const svc = new MorningBriefingService({
    scheduleTaskService: {
      listTasksBySession: () => [
        {
          taskId: "t-today",
          title: "今天的周会",
          description: "",
          nextRunAt: new Date().toISOString(),
          runAt: "",
        },
      ],
    } as never,
  });
  const briefing = await svc.generateBriefing(SESSION);
  assert.match(
    briefing.todaySchedule.map((i) => i.title).join("、"),
    /今天的周会/,
  );
});
