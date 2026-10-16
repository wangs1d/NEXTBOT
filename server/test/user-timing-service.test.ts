import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UserTimingService } from "../src/proactivity/user-timing-service.js";

describe("UserTimingService：用户时刻统一取用口", () => {
  it("多源按注册序取第一个非 null；全 null → null", () => {
    const svc = new UserTimingService();
    svc.registerSource({ name: "a", bedtimeHour: () => null, wakeHour: () => null });
    svc.registerSource({ name: "b", bedtimeHour: () => 23.5, wakeHour: () => 6.5 });
    svc.registerSource({ name: "c", bedtimeHour: () => 22, wakeHour: () => 7 });
    assert.equal(svc.bedtimeHour("u"), 23.5, "源 a 未学出 → 落到源 b");
    assert.equal(svc.wakeHour("u"), 6.5);

    const none = new UserTimingService();
    none.registerSource({ name: "a", bedtimeHour: () => null });
    none.registerSource({ name: "b", bedtimeHour: () => null });
    assert.equal(none.bedtimeHour("u"), null);
    assert.equal(none.sourceCount, 2);
  });

  it("单源抛错视为未学出，继续下一源（不阻断取数）", () => {
    const svc = new UserTimingService();
    svc.registerSource({
      name: "broken",
      bedtimeHour: () => {
        throw new Error("源炸了");
      },
    });
    svc.registerSource({ name: "ok", bedtimeHour: () => 23 });
    assert.equal(svc.bedtimeHour("u"), 23);
  });

  it("preBedtimeMinutes：就寝前 30 分钟，默认钳位 [20:00, 23:30]", () => {
    const svc = new UserTimingService();
    svc.registerSource({ name: "s", bedtimeHour: () => 23.5 });
    assert.equal(svc.preBedtimeMinutes("u"), 23 * 60, "23:30 就寝 → 23:00 提醒");

    svc.registerSource({ name: "late", bedtimeHour: () => 25.5 });
    // 多源先注册者胜出——重新建一个只有熬夜源的实例验证钳位
    const late = new UserTimingService();
    late.registerSource({ name: "late", bedtimeHour: () => 25.5 });
    assert.equal(late.preBedtimeMinutes("u"), 23 * 60 + 30, "凌晨 1:30 就寝 → 钳到当晚 23:30");

    const dawn = new UserTimingService();
    dawn.registerSource({ name: "dawn", bedtimeHour: () => 0.25 });
    assert.equal(dawn.preBedtimeMinutes("u"), 23 * 60 + 30, "0:15 就寝 − 30min 负值折回 → 钳 23:30");
  });

  it("preBedtimeMinutes：未学出走 fallback；无 fallback 返回 null", () => {
    const none = new UserTimingService();
    none.registerSource({ name: "a", bedtimeHour: () => null });
    assert.equal(none.preBedtimeMinutes("u"), null);
    assert.equal(none.preBedtimeMinutes("u", { fallbackMinutes: 21 * 60 }), 21 * 60);
  });

  it("preBedtimeMinutes：lead 与钳位区间可自定义", () => {
    const svc = new UserTimingService();
    svc.registerSource({ name: "s", bedtimeHour: () => 23 });
    assert.equal(
      svc.preBedtimeMinutes("u", { leadMinutes: 60, clampMinutes: [19 * 60, 23 * 60] }),
      22 * 60,
    );
  });

  it("postWakeMinutes：起床后 30 分钟，默认钳位 [06:00, 11:00]", () => {
    const svc = new UserTimingService();
    svc.registerSource({ name: "s", wakeHour: () => 6.5 });
    assert.equal(svc.postWakeMinutes("u"), 7 * 60, "6:30 起床 → 7:00 提醒");

    const early = new UserTimingService();
    early.registerSource({ name: "s", wakeHour: () => 5 });
    assert.equal(early.postWakeMinutes("u"), 6 * 60, "5:00 起床 → 钳到 6:00");

    assert.equal(early.postWakeMinutes("u", { fallbackMinutes: 8 * 60 }), 6 * 60, "已学出不用 fallback");
    const none = new UserTimingService();
    assert.equal(none.postWakeMinutes("u"), null);
    assert.equal(none.postWakeMinutes("u", { fallbackMinutes: 8 * 60 }), 8 * 60);
  });

  it("sleepWindow：入睡-醒来窗口多源取值（夜间模式判定场景）", () => {
    const svc = new UserTimingService();
    svc.registerSource({ name: "a", sleepWindow: () => null });
    svc.registerSource({
      name: "b",
      sleepWindow: (actorId) =>
        actorId === "u" ? { startHour: 23.5, endHour: 6.75, sampleCount: 7 } : null,
    });
    assert.deepEqual(svc.sleepWindow("u"), { startHour: 23.5, endHour: 6.75, sampleCount: 7 });
    assert.equal(svc.sleepWindow("other"), null, "窗口语义按 actor 区分");

    const none = new UserTimingService();
    none.registerSource({ name: "a" });
    assert.equal(none.sleepWindow("u"), null, "源未声明 sleepWindow → null");
  });
});
