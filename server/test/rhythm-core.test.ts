// RhythmCore（节律感知核心）单测：
// 就寝样本跨天结算、下午关 App 防污染、2 个有效夜晚门槛学习、sense/snapshot 视图。
// 用真实 BodyBus（纯内存），受控 Date 喂 noteActivity。
import assert from "node:assert/strict";
import test from "node:test";

import { BodyBus } from "../src/body/body-bus.js";
import { RhythmCore } from "../src/body/rhythm-core.js";

const ACTOR = "actor-1";

/** 造一个本地时间 Date（今天指定时分） */
function atHour(hour: number, minute = 0, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function makeRhythm(): { core: RhythmCore } {
  const core = new RhythmCore({ bodyBus: new BodyBus() });
  return { core };
}

test("act 恒拒绝（纯感知模块）；sense 返回追踪状态；snapshot 元数据", async () => {
  const { core } = makeRhythm();
  const actResult = await core.act({} as never);
  assert.equal(actResult.ok, false);

  core.noteActivity(ACTOR, "conversation", new Date());
  const sense = await core.sense({ actorId: ACTOR } as never);
  assert.equal(sense.ok, true);
  assert.equal((sense.data as { tracked: boolean }).tracked, true);

  const snap = core.snapshot();
  assert.equal(snap.name, "rhythm");
  assert.equal((snap.metadata as { trackedActors: number }).trackedActors, 1);
});

test("就寝样本防污染：下午关 App 的日子不计入就寝基线", () => {
  const { core } = makeRhythm();
  // 5 个「下午 14 点最后活跃」的昼夜：不是就寝，不应进样本
  for (let d = 0; d < 5; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(14, 0, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1)); // 跨天采样点
  }
  assert.equal(core.learnedBedtimeHour(ACTOR), null); // 样本被拒收 → 无学习值
});

test("作息基线：2 个有效夜晚即学习（不等 5 天，不落硬默认）", () => {
  const { core } = makeRhythm();
  // 两个「23:30 最后活跃」的夜晚 → 就寝样本 23.5×2
  for (let d = 0; d < 2; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(23, 30, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1)); // 跨天记样本
  }
  assert.equal(core.learnedBedtimeHour(ACTOR), 23.5); // 定时提醒将排在 23:00（就寝前 30min，UserTimingService 换算）
});

test("sense：暴露就寝样本数", async () => {
  const { core } = makeRhythm();
  // 两个「23:30 最后活跃」的夜晚 → 2 个就寝样本
  for (let d = 0; d < 2; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(23, 30, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1));
  }
  const sense = await core.sense({ actorId: ACTOR } as never);
  const data = sense.data as { bedtimeSamples: number };
  assert.equal(data.bedtimeSamples, 2);
});
