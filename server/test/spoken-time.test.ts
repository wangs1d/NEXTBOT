/**
 * 口语化时间（2026-11-05）：回执给模型的时间必须是能直接说出口的说法。
 *
 * 事故：回执给 `11/6 11:00`，指令要求「时间用它」，模型照抄 → 「明天 11:00 会
 * 提醒你看牙医」。私人助理不这么讲话。改为「明天上午十一点」，模型能自然嵌进
 * 「行，明早十一点我叫你」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatNextRunAtSpoken } from "../src/tools/calendar-tools.js";

const TZ = "Asia/Shanghai";

/** 构造「上海本地 timezone 的 dayOffset 天后 hour:minute」对应 ISO（上海无夏令时，固定 +8） */
function shanghaiIso(dayOffset: number, hour: number, minute: number): string {
  const now = new Date();
  const sh = new Date(now.getTime() + 8 * 3_600_000);
  return new Date(
    Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + dayOffset, hour - 8, minute),
  ).toISOString();
}

test("相对日 + 时段 + 中文钟点", () => {
  const cases: Array<[string, string]> = [
    [shanghaiIso(1, 11, 0), "明天上午十一点"],
    [shanghaiIso(1, 9, 0), "明天上午九点"],
    [shanghaiIso(1, 15, 30), "明天下午三点半"],
    [shanghaiIso(1, 21, 0), "明晚九点"],
    [shanghaiIso(0, 21, 0), "今晚九点"],
    [shanghaiIso(0, 7, 0), "今早七点"],
    [shanghaiIso(1, 7, 0), "明早七点"],
    [shanghaiIso(2, 10, 0), "后天上午十点"],
    [shanghaiIso(1, 12, 0), "明天中午十二点"],
    [shanghaiIso(1, 0, 30), "明天凌晨零点三十分"],
    [shanghaiIso(1, 15, 5), "明天下午三点零五分"],
    [shanghaiIso(1, 20, 45), "明晚八点四十五分"],
  ];
  for (const [iso, expected] of cases) {
    assert.equal(formatNextRunAtSpoken(iso, TZ), expected, `输入 ${iso}`);
  }
});

test("没有冒号钟点、没有斜杠日期（模型会照抄）", () => {
  for (const iso of [shanghaiIso(1, 11, 0), shanghaiIso(0, 21, 15), shanghaiIso(40, 9, 0)]) {
    const out = formatNextRunAtSpoken(iso, TZ);
    assert.ok(!out.includes(":"), `不该出现冒号钟点：${out}`);
    assert.ok(!out.includes("/"), `不该出现斜杠日期：${out}`);
    assert.ok(/\d/.test(out) === false || /月|日/.test(out), `数字只允许出现在「N月N日」：${out}`);
  }
});

test("跨过三天用具体日期，不硬凑「大后天以后」", () => {
  const out = formatNextRunAtSpoken(shanghaiIso(40, 9, 0), TZ);
  assert.match(out, /^\d{1,2}月\d{1,2}日上午九点$/);
});

test("空值与非法值不炸", () => {
  assert.equal(formatNextRunAtSpoken(null, TZ), "");
  assert.equal(formatNextRunAtSpoken(undefined, TZ), "");
  assert.equal(formatNextRunAtSpoken("not-a-date", TZ), "not-a-date");
});
