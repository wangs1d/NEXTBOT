import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { EveningDigestScheduler } from "../src/services/evening-digest-scheduler.js";

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

function makeScheduler(bedtimeHour: number | null = null) {
  const fired: string[] = [];
  const scheduler = new EveningDigestScheduler({
    digestService: {
      generateDigest: async (sessionId: string) => {
        fired.push(sessionId);
        return {
          date: "2026-10-16",
          tomorrowSchedule: [],
          tomorrowWeather: null,
          outfitTip: null,
          narrationText: "明天没安排，想睡就多睡会儿。",
        };
      },
    } as never,
    onDigestTriggered: () => {},
    // 节律学习取用口（生产 = RhythmCore.learnedBedtimeHour，样本不足 null）
    bedtimeHourOf: () => bedtimeHour,
  });
  return { scheduler, fired };
}

/** 设定模拟时钟（HH:mm；mock.timers 需已在本用例作用域 enable） */
function setClock(h: number, min: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 16, h, min) });
}

afterEach(() => {
  mock.timers.reset();
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
      const { scheduler, fired } = makeScheduler(23.5);
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 0, "22:59 未到学到的 23:00 不发");
      setClock(23, 0);
      await tick(scheduler);
      assert.equal(fired.length, 1, "23:00 到点发");
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
      const { scheduler, fired } = makeScheduler(23.5); // 学到 23:00，此刻已过
      scheduler.subscribe("s1");
      await tick(scheduler);
      assert.equal(fired.length, 1, "错过 23:00 → 首次 tick 补发");
      setClock(23, 55);
      await tick(scheduler);
      assert.equal(fired.length, 1, "同日已发不重复");
      scheduler.stop();
    } finally {
      restoreEnv(saved);
    }
  });
});
