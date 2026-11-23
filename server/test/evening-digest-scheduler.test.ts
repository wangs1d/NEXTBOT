import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EveningDigestScheduler } from "../src/services/evening-digest-scheduler.js";
import type {
  EveningDigest,
  TomorrowPreviewFacts,
} from "../src/services/evening-digest-service.js";

// 落盘隔离：已发标记文件指到一次性临时数据根，绝不碰真实数据
// （直跑 node --test 时 npm_lifecycle_event 为空，调度器的测试进程守卫不生效）
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "evening-digest-sched-test-"));
process.env.NEXTBOT_DATA_DIR = TMP_DATA_DIR;
const SENT_DAY_FILE = join(TMP_DATA_DIR, "evening-digest-sent.json");

/** 把私有 tick 暴露给测试（与生产每分钟 tick 同一入口） */
async function tick(scheduler: EveningDigestScheduler): Promise<void> {
  await (scheduler as unknown as { tick: () => Promise<void> }).tick();
}

/** 清空 EVENING_DIGEST_* env（各用例自管恢复，防外部环境/用例间污染） */
function clearEnv(): { hour?: string; minute?: string } {
  const saved = {
    hour: process.env.EVENING_DIGEST_HOUR,
    minute: process.env.EVENING_DIGEST_MINUTE,
  };
  delete process.env.EVENING_DIGEST_HOUR;
  delete process.env.EVENING_DIGEST_MINUTE;
  return saved;
}

function restoreEnv(saved: { hour?: string; minute?: string }): void {
  if (saved.hour === undefined) delete process.env.EVENING_DIGEST_HOUR;
  else process.env.EVENING_DIGEST_HOUR = saved.hour;
  if (saved.minute === undefined) delete process.env.EVENING_DIGEST_MINUTE;
  else process.env.EVENING_DIGEST_MINUTE = saved.minute;
}

/**
 * 推送面夹具（§3.4：主动推送只剩天气 + 闲聊）。
 * 默认「有天气、有话可说」= 有内容可发。
 */
const pushDigest = (over: Partial<EveningDigest> = {}): EveningDigest => ({
  date: "2026-10-16",
  tomorrowWeather: { text: "小雨", minC: 15, maxC: 19, alerts: [] },
  narrationText: "明天小雨，15~19℃。出门记得带伞。",
  ...over,
});

/** 问答面夹具：完整明日事实（行程 + 天气），推送跳过时也要能取到 */
const previewFacts = (over: Partial<TomorrowPreviewFacts> = {}): TomorrowPreviewFacts => ({
  date: "2026-10-16",
  tomorrowSchedule: [{ id: "t1", title: "部门例会", time: "09:30" }],
  tomorrowWeather: { text: "小雨", minC: 15, maxC: 19, alerts: [] },
  ...over,
});

function makeScheduler(
  bedtimeHour: number | null = null,
  bundle: { digest: EveningDigest; facts: TomorrowPreviewFacts } = {
    digest: pushDigest(),
    facts: previewFacts(),
  },
) {
  const fired: string[] = [];
  const delivered: EveningDigest[] = [];
  const skipped: Array<[string, string]> = [];
  const scheduler = new EveningDigestScheduler({
    digestService: {
      // 调度器走一次取数两个出口的口径（§3.4），不再单独跑 generateDigest
      buildPreviewBundle: async (sessionId: string) => {
        fired.push(sessionId);
        return bundle;
      },
    } as never,
    onDigestTriggered: (_sessionId, digest) => {
      delivered.push(digest);
    },
    // 没内容不发的留痕口（装配层可接诊断漏斗）
    onSkipped: (sessionId, reason) => {
      skipped.push([sessionId, reason]);
    },
    // 节律学习取用口（生产 = RhythmCore.learnedBedtimeHour，样本不足 null）
    bedtimeHourOf: () => bedtimeHour,
  });
  return { scheduler, fired, delivered, skipped };
}

/** 设定模拟时钟（HH:mm；mock.timers 需已在本用例作用域 enable） */
function setClock(h: number, min: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 16, h, min) });
}

afterEach(() => {
  mock.timers.reset();
  // 用例间清落盘标记：各用例共用 sessionId "s1"，磁盘残留会跨用例判「已发」
  rmSync(SENT_DAY_FILE, { force: true });
});

describe("EveningDigestScheduler：推送时刻动态学习（env 锁死 > 节律就寝前30min > 默认21点）", () => {
  it("env EVENING_DIGEST_HOUR 显式设置 → 锁死该整点（学习值不生效）", async () => {
    const saved = clearEnv();
    try {
      process.env.EVENING_DIGEST_HOUR = "22";
      using _m = mock.timers;
      setClock(21, 59);
      const { scheduler, fired } = makeScheduler(23.5);
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 0, "21:59 未到 env 锁死的 22:00 不发");
      setClock(22, 0);
      await tick(scheduler);
      assert.equal(fired.length, 1, "22:00 到点按 env 发");
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("节律学习生效：就寝 23:30 → 提前 30 分钟 = 23:00 推送", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(22, 59);
      const { scheduler, fired, delivered } = makeScheduler(23.5);
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 0, "22:59 未到学到的 23:00 不发");
      setClock(23, 0);
      await tick(scheduler);
      assert.equal(fired.length, 1, "23:00 到点发");
      assert.equal(delivered.length, 1, "有内容 → 投递一次");
      assert.match(delivered[0]!.narrationText, /小雨/);
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("熬夜就寝（凌晨 1:30 = 25.5h）钳位到 23:30，不把推送拖到次日凌晨", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(23, 29);
      const { scheduler, fired } = makeScheduler(25.5);
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 0, "23:29 未到钳位后的 23:30 不发");
      setClock(23, 30);
      await tick(scheduler);
      assert.equal(fired.length, 1, "23:30 钳位时刻发");
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("节律未学会（样本不足 → null）回退默认 21:00", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(20, 59);
      const { scheduler, fired } = makeScheduler(null);
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 0, "20:59 未到默认 21:00 不发");
      setClock(21, 0);
      await tick(scheduler);
      assert.equal(fired.length, 1, "21:00 默认时刻发");
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("错过时刻（服务器卡顿/休眠）在后续 tick 补发一次，同日不重复", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(23, 10);
      const { scheduler, fired, delivered } = makeScheduler(23.5); // 学到 23:00，此刻已过
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 1, "错过 23:00 → 首次 tick 补发");
      setClock(23, 55);
      await tick(scheduler);
      assert.equal(fired.length, 1, "同日已发不重复");
      assert.equal(delivered.length, 1);
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });
});

// ── 2026-11-23 §3.4「没内容时」：明日预览只剩天气 + 闲聊，没内容就整格 skipped ──
describe("EveningDigestScheduler：没内容不发兜底话术", () => {
  it("天气拉不到且无闲聊素材 → 不投递，走 onSkipped 留痕，当日额度仍占用", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(21, 0);
      const { scheduler, delivered, skipped } = makeScheduler(null, {
        digest: pushDigest({ tomorrowWeather: null, narrationText: "" }),
        facts: previewFacts({ tomorrowWeather: null }),
      });
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(delivered.length, 0, "空文案绝不投递（不硬凑「早点睡」）");
      assert.deepEqual(skipped, [["s1", "no_content"]], "跳过要留痕");
      // 当日额度已占：不重试、不因为反复 tick 刷天气接口
      setClock(21, 10);
      await tick(scheduler);
      assert.equal(delivered.length, 0);
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("只有闲聊素材（天气挂了）→ 照发那一句", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(21, 0);
      const { scheduler, delivered, skipped } = makeScheduler(null, {
        digest: pushDigest({
          tomorrowWeather: null,
          chatLines: ["这周都一两点才睡，试着提前半小时"],
          narrationText: "这周都一两点才睡，试着提前半小时。",
        }),
        facts: previewFacts({ tomorrowWeather: null }),
      });
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(skipped.length, 0);
      assert.equal(delivered.length, 1);
      assert.match(delivered[0]!.narrationText, /一两点才睡/);
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("推送跳过时问答面事实仍然记下（白天问「明天有什么安排」照样答得出）", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(21, 0);
      const { scheduler, delivered } = makeScheduler(null, {
        digest: pushDigest({ tomorrowWeather: null, narrationText: "" }),
        facts: previewFacts(),
      });
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(delivered.length, 0, "推送仍跳过");
      assert.equal(scheduler.latestDigest("s1"), undefined, "空载荷不记");
      const facts = scheduler.latestPreviewFacts("s1");
      assert.equal(facts?.tomorrowSchedule[0]?.title, "部门例会");
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });
});

// ── 2026-11-05 接生产投递：当日缓存（问答面供聊天出口、推送面供补推回看）─────
describe("latestDigest / latestPreviewFacts：当日缓存供应聊天里的明日预览", () => {
  const digestOf = (date: string) =>
    ({
      date,
      tomorrowWeather: { text: "小雨", minC: 15, maxC: 19, alerts: [] },
      narrationText: "明天小雨，15~19℃。",
    }) as EveningDigest;
  const factsOf = (date: string) =>
    ({
      date,
      tomorrowSchedule: [{ id: "t1", title: "部门例会", time: "09:30" }],
      tomorrowWeather: { text: "小雨", minC: 15, maxC: 19, alerts: [] },
    }) as TomorrowPreviewFacts;

  it("推送后两面都能取到当日数据", async () => {
    const saved = clearEnv();
    try {
      using _m = mock.timers;
      setClock(21, 0);
      const { scheduler } = makeScheduler();
      scheduler.subscribe("s1");
      await tick(scheduler);
      const latest = scheduler.latestDigest("s1");
      assert.ok(latest, "推送后应可回取推送面");
      assert.equal(latest?.date, "2026-10-16", "取到的必须是当日 digest");
      assert.equal(
        scheduler.latestPreviewFacts("s1")?.tomorrowSchedule.length,
        1,
        "问答面带完整行程（§3.4 之后聊天里的日程只能从这一面答）",
      );
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });

  it("跨日自动失效：昨天的数据不再当明日预览用", () => {
    const scheduler = new EveningDigestScheduler({
      digestService: { buildPreviewBundle: async () => ({ digest: digestOf("2020-01-01"), facts: factsOf("2020-01-01") }) },
      onDigestTriggered: () => {},
    } as unknown as ConstructorParameters<typeof EveningDigestScheduler>[0]);
    scheduler.rememberDigest("s1", digestOf("2020-01-01"));
    scheduler.rememberPreviewFacts("s1", factsOf("2020-01-01"));
    assert.equal(scheduler.latestDigest("s1"), undefined);
    assert.equal(scheduler.latestPreviewFacts("s1"), undefined);
  });

  it("未推送过的 session 返回 undefined（不凭空造预览）", () => {
    const scheduler = new EveningDigestScheduler({
      digestService: { generateDigest: async () => digestOf("2020-01-01") },
      onDigestTriggered: () => {},
    } as unknown as ConstructorParameters<typeof EveningDigestScheduler>[0]);
    assert.equal(scheduler.latestDigest("nobody"), undefined);
    assert.equal(scheduler.latestPreviewFacts("nobody"), undefined);
  });
});
