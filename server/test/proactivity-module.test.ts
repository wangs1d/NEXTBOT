// 统一模块层测试（2026-11-19）：注册表语义 + 内置目录全景 + 下线源不在册
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerProactiveSource,
  unregisterProactiveSource,
  setProactiveSourceEnabled,
  listProactiveSources,
  describeProactivity,
  resetProactiveSourcesForTest,
  registerBuiltinProactiveSources,
} from "../src/proactivity/module.js";

test("内置目录登记后 describeProactivity 输出全景，六层齐备", () => {
  resetProactiveSourcesForTest();
  registerBuiltinProactiveSources();
  const d = describeProactivity();
  assert.ok(d.total >= 20, `目录应覆盖全部内置触发源，实际 ${d.total}`);
  assert.equal(d.enabled, d.total, "目录默认全部启用");
  for (const layer of ["board_rule", "event_trigger", "branch", "scheduled", "sensor_intel", "goal"] as const) {
    assert.ok(d.byLayer[layer].length > 0, `层 ${layer} 不应为空`);
  }
});

test("2026-11-19 下线的四个触发源不在册（away_return/work_marathon/unread_burst/spend_alert）", () => {
  resetProactiveSourcesForTest();
  registerBuiltinProactiveSources();
  const ids = new Set(listProactiveSources().map((s) => s.id));
  for (const gone of ["away_return", "work_marathon", "unread_burst", "spend_alert"]) {
    assert.ok(!ids.has(gone), `${gone} 已下线，不应出现在统一模块层目录`);
  }
});

test("同 id 重复登记覆盖；启停覆盖与注销", () => {
  resetProactiveSourcesForTest();
  registerProactiveSource({ id: "demo", layer: "scheduled", kinds: ["k1"], trigger: "t" });
  registerProactiveSource({ id: "demo", layer: "scheduled", kinds: ["k1", "k2"], trigger: "t2" });
  const [one] = listProactiveSources({ layer: "scheduled" });
  assert.equal(one.kinds.length, 2, "后写覆盖");
  assert.ok(setProactiveSourceEnabled("demo", false), "启停覆盖成功");
  assert.equal(listProactiveSources().find((s) => s.id === "demo")?.enabled, false);
  assert.ok(!setProactiveSourceEnabled("nope", true), "未登记 id 返回 false");
  unregisterProactiveSource("demo");
  assert.equal(listProactiveSources().length, 0, "注销后清空");
});
