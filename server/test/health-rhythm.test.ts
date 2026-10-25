// 健康节奏档位单测 —— 身份识别 / 档位参数 / 匹配优先级（2026-10-23 第二版：只留久坐）
// 运行：npx tsx --test test/health-rhythm.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { resolveHealthRhythm } from "../src/services/health-rhythm-service.js";

test("未识别身份 → 保守默认：久坐 60 分钟，不再用旧版上班族节奏", () => {
  const p = resolveHealthRhythm([]);
  assert.equal(p.key, "default");
  assert.equal(p.source, "default");
  assert.equal(p.matched, null);
  assert.equal(p.sedentaryAfterMinutes, 60);
  // 旧版 50 分钟的激进阈值不允许回来
  assert.ok(p.sedentaryAfterMinutes! > 50, "久坐阈值必须比旧版 50 更保守");
});

test("职业事实命中 → 对应档位 + 保留命中原文", () => {
  const office = resolveHealthRhythm(["职业:后端开发"]);
  assert.equal(office.key, "office");
  assert.equal(office.source, "identity-fact");
  assert.equal(office.matched, "职业:后端开发");
  assert.equal(office.sedentaryAfterMinutes, 60);

  const student = resolveHealthRhythm(["我是大学生"]);
  assert.equal(student.key, "student");
  assert.equal(student.sedentaryAfterMinutes, 75);

  const driver = resolveHealthRhythm(["职业:网约车司机"]);
  assert.equal(driver.key, "driver");
  assert.equal(driver.sedentaryAfterMinutes, null, "驾驶不开久坐提醒");

  const active = resolveHealthRhythm(["职业:健身教练"]);
  assert.equal(active.key, "active");
  assert.equal(active.sedentaryAfterMinutes, null);
});

test("匹配优先级：复合身份按更特异的档位走", () => {
  // 学生 + 办公词并存 → 学生优先
  assert.equal(resolveHealthRhythm(["大学生", "做设计兼职"]).key, "student");
  // 司机 + 办公词并存 → 司机优先
  assert.equal(resolveHealthRhythm(["货车司机", "跑运输办公"]).key, "driver");
});

test("喝水/护眼参数不存在：档位结构里没有 water/eye 字段", () => {
  const p = resolveHealthRhythm(["职业:程序员"]) as Record<string, unknown>;
  const gone = Object.keys(p).filter((k) => /water|eye/i.test(k));
  assert.equal(gone.length, 0, "water/eye 字段必须已删除");
});
