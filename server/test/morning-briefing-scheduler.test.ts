import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { MorningBriefingScheduler } from "../src/services/morning-briefing-scheduler.js";
import type { UserPreferences } from "../src/routes/http/user-preferences.js";

function makePrefs(overrides: Partial<UserPreferences["morningBriefing"]> = {}): UserPreferences {
  return {
    morningBriefing: {
      enabled: true,
      time: "08:00",
      mode: "card",
      showOnDesktopLaunch: true,
      sections: { schedule: true, notes: true },
      lastSentAt: null,
      deliveredAt: null,
      deliveredChannel: null,
      ...overrides,
    },
    agentProfile: {
      displayName: "测试",
      handle: "tester",
      signature: "",
      avatarUrl: null,
      moodStyle: "gentle",
      statusText: "",
      avatarPreset: "dawn",
      lastProfileEvent: "",
      updatedAt: null,
    },
  };
}

function makeScheduler() {
  const fired: string[] = [];
  const scheduler = new MorningBriefingScheduler({
    briefingService: {
      narrateBriefing: async (sessionId: string) => ({
        narrationText: "简报",
        briefing: {
          date: "2026-09-13",
          todaySchedule: [],
          pendingNotes: [],
          agentGreeting: "早上好",
        },
        // eslint-disable-next-line
        sessionIdUsed: sessionId,
      }),
    } as never,
    onBriefingTriggered: (sessionId) => {
      fired.push(sessionId);
    },
    getSessionPrefs: (sessionId) => makePrefs(),
  });
  return { scheduler, fired };
}

/** 把私有 tick 暴露给测试（与生产每分钟 tick 同一入口） */
async function tick(scheduler: MorningBriefingScheduler): Promise<void> {
  await (scheduler as unknown as { tick: () => Promise<void> }).tick();
}

describe("MorningBriefingScheduler：只在早上固定时段播报", () => {
  it("窗口外（下午/晚间/凌晨）一律不播报", async () => {
    for (const [h, m] of [
      [14, 0],
      [20, 0],
      [23, 59],
      [4, 59],
      [0, 30],
    ] as const) {
      using _m = mock.timers;
      mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, h, m) });
      const { scheduler, fired } = makeScheduler();
      scheduler.subscribe("s1", makePrefs());
      await tick(scheduler);
      assert.equal(fired.length, 0, `${h}:${m} 不应播报`);
      scheduler.stop();
    }
  });

  it("窗口内但未到配置时间 → 不播报；到点/错过精确分钟 → 窗口内补播一次", async () => {
    using _m = mock.timers;
    const setTime = (h: number, min: number) => {
      mock.timers.reset();
      mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, h, min) });
    };
    setTime(7, 0);
    const { scheduler, fired } = makeScheduler();
    scheduler.subscribe("s1", makePrefs({ time: "08:00" }));

    await tick(scheduler);
    assert.equal(fired.length, 0, "07:00 未到 08:00 不播报");

    setTime(8, 0);
    await tick(scheduler);
    assert.equal(fired.length, 1, "08:00 到点播报");

    setTime(9, 30);
    await tick(scheduler);
    assert.equal(fired.length, 1, "同日已播不重复");

    setTime(11, 59);
    await tick(scheduler);
    assert.equal(fired.length, 1, "窗口尾仍不重复");

    scheduler.stop();
  });

  it("服务错过精确分钟：窗口内首次 tick 补播（如 09:30 才连上）", async () => {
    using _m = mock.timers;
    mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, 9, 30) });
    const { scheduler, fired } = makeScheduler();
    scheduler.subscribe("s1", makePrefs({ time: "08:00" }));
    await tick(scheduler);
    assert.equal(fired.length, 1, "窗口内补播");
    scheduler.stop();
  });

  it("配置时间本身在窗口外（历史脏配置，如 20:00）→ 永不播报", async () => {
    using _m = mock.timers;
    mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, 20, 0) });
    const { scheduler, fired } = makeScheduler();
    scheduler.subscribe("s1", makePrefs({ time: "20:00" }));
    await tick(scheduler);
    assert.equal(fired.length, 0);
    scheduler.stop();
  });

  it("当日已从其他渠道投递（启动简报已展示）→ 调度器不再重复播报", async () => {
    using _m = mock.timers;
    mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, 8, 0) });
    const { scheduler, fired } = makeScheduler();
    scheduler.subscribe(
      "s1",
      makePrefs({
        deliveredAt: new Date(2026, 8, 13, 7, 50).toISOString(),
        deliveredChannel: "desktop",
      }),
    );
    await tick(scheduler);
    assert.equal(fired.length, 0, "当日已投递不重播");
    scheduler.stop();
  });

  it("禁用开关 → 不播报", async () => {
    using _m = mock.timers;
    mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 13, 8, 0) });
    const { scheduler, fired } = makeScheduler();
    scheduler.subscribe("s1", makePrefs({ enabled: false }));
    await tick(scheduler);
    assert.equal(fired.length, 0);
    scheduler.stop();
  });
});
