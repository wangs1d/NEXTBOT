/**
 * RhythmCore 状态落盘单测（2026-10-01 P1）：作息学习基线跨重启保留。
 * 就寝样本按日累积极慢（每天至多 1 个），不落盘则学习门槛（2 夜）在
 * 开发机 tsx watch 常态重启下永远攒不满。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RhythmCore } from "../src/body/rhythm-core.js";
import { BodyBus } from "../src/body/body-bus.js";

async function makeCore(dir?: string): Promise<RhythmCore> {
  return new RhythmCore({ bodyBus: new BodyBus() }, dir);
}

test("落盘→新实例恢复：最后活跃时刻与就寝学习基线都在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-core-"));
  try {
    const c1 = await makeCore(dir);
    // 两个「23:30 最后活跃」的夜晚 → 2 个就寝样本（达学习门槛）
    for (const [night, morning] of [
      ["2026-09-28T23:30:00", "2026-09-29T09:00:00"],
      ["2026-09-29T23:30:00", "2026-09-30T09:00:00"],
    ] as const) {
      c1.noteActivity("u@qq.com", "conversation", new Date(night));
      c1.noteActivity("u@qq.com", "conversation", new Date(morning));
    }
    assert.equal(c1.learnedBedtimeHour("u@qq.com"), 23.5);
    c1.flush();

    const c2 = await makeCore(dir);
    assert.equal(c2.learnedBedtimeHour("u@qq.com"), 23.5, "就寝学习基线跨重启保留");
    const after = (c2 as unknown as { actors: Map<string, { lastActiveAt: number | null }> }).actors.get("u@qq.com");
    assert.ok(after, "恢复出该用户状态");
    assert.equal(after!.lastActiveAt, new Date("2026-09-30T09:00:00").getTime(), "最后活跃时刻跨重启保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("恢复时防污染清洗：旧版本落盘的下午样本被拒收", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-core-"));
  try {
    await writeFile(
      join(dir, "rhythm-core-state.json"),
      JSON.stringify({
        version: 1,
        actors: {
          "u@qq.com": {
            state: { dateKey: "2026-10-01", lastActiveAt: null },
            learned: { bedtimes: [13, 23.5, 23.5] },
          },
        },
      }),
    );
    const core = await makeCore(dir);
    // 13 点样本（下午关 App）被清洗 → 剩 2 个有效样本 → 学出 23.5
    assert.equal(core.learnedBedtimeHour("u@qq.com"), 23.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
