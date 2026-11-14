/**
 * schedule-grounding 单元测试：日程查询轮正文对账（2026-11-15「红树林赶海」
 * 编造事故根修）。正文里的日程主张必须与 list_tasks 回执对账，无依据的
 * 确定性剔除；没查过日程的轮次一律原样放行，绝不误伤。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { groundScheduleBody, parseClockClaim, collectGroundingTasks } from "../src/render/schedule-grounding.js";
import type { TurnEffect } from "../src/render/types.js";

const receipt = (tasks: unknown[]): TurnEffect => ({
  tool: "calendar",
  status: "ok",
  result: { ok: true, action: "list_tasks", count: tasks.length, tasks },
});

// 早市 11-15 08:00 北京 = 11-15T00:00Z（截图同款数据）
const MORSE_MARKET_TASKS = [
  {
    taskId: "t1",
    title: "该去逛早市啦",
    nextRunAt: "2026-11-15T00:00:00.000Z",
    runAt: "2026-11-15T00:00:00.000Z",
    timezone: "Asia/Shanghai",
  },
];

test("对账：截图场景——虚构日程被剔，有据句与语气句保留", () => {
  const body =
    "明天：八点早市，逛完顺路吃口早饭；十点半红树林赶海，记得看退潮时间，穿能下水的鞋；傍晚海边溜达一圈。\n\n就这些，别再问了，睡。";
  const r = groundScheduleBody(body, [receipt(MORSE_MARKET_TASKS)]);
  assert.equal(r.text, "明天：八点早市，逛完顺路吃口早饭。\n\n就这些，别再问了，睡。");
  assert.deepEqual(r.strippedClauses, [
    "十点半红树林赶海",
    "记得看退潮时间",
    "穿能下水的鞋",
    "傍晚海边溜达一圈",
  ]);
});

test("对账：全部有据时正文原样放行", () => {
  const body = "明天八点有早市，就这一件。";
  const r = groundScheduleBody(body, [receipt(MORSE_MARKET_TASKS)]);
  assert.equal(r.text, body);
  assert.equal(r.strippedClauses.length, 0);
});

test("对账：本轮没查过日程（无 list_tasks 回执）绝不误伤", () => {
  const body = "十点半红树林赶海，傍晚海边溜达一圈。";
  const r = groundScheduleBody(body, [
    { tool: "notes.save", status: "ok", result: { ok: true } },
  ]);
  assert.equal(r.text, body);
  assert.equal(r.strippedClauses.length, 0);
});

test("对账：count=0 当天没安排，编的时间主张全剔", () => {
  const body = "明天：十点半红树林赶海，晚上聚餐。就这些。";
  const r = groundScheduleBody(body, [receipt([])]);
  assert.equal(r.text, "就这些。");
});

test("对账：伪钟点（第一时间/退潮时间/时候）不构成主张", () => {
  const body = "你明天八点有早市，我会第一时间提醒你，记得看退潮时间，到时候穿能下水的鞋。";
  const r = groundScheduleBody(body, [receipt(MORSE_MARKET_TASKS)]);
  assert.equal(r.text, body);
});

test("对账：任务时间按任务时区换算后可被口语钟点命中", () => {
  // 08:30 北京 = 00:30Z
  const tasks = [
    { taskId: "t2", title: "开会", nextRunAt: "2026-11-15T00:30:00.000Z", runAt: "", timezone: "Asia/Shanghai" },
  ];
  const r = groundScheduleBody("明天八点半有开会。", [receipt(tasks)]);
  assert.equal(r.text, "明天八点半有开会。");
});

test("对账：孤立时段口语（晚上早点睡）不判不剔", () => {
  const body = "都安排好了。晚上早点睡哦。";
  const r = groundScheduleBody(body, [receipt(MORSE_MARKET_TASKS)]);
  assert.equal(r.text, body);
});

test("钟点主张解析：HH:MM / 半点 / 中文数字分钟 / 伪钟点", () => {
  assert.deepEqual(parseClockClaim("10:30 提醒"), { hour: 10, minute: 30 });
  assert.deepEqual(parseClockClaim("八点半"), { hour: 8, minute: 30 });
  assert.deepEqual(parseClockClaim("十点半"), { hour: 10, minute: 30 });
  assert.deepEqual(parseClockClaim("十一点五十五分"), { hour: 11, minute: 55 });
  assert.deepEqual(parseClockClaim("晚上八点"), { hour: 20, minute: 0 });
  assert.equal(parseClockClaim("记得看退潮时间"), null);
  assert.equal(parseClockClaim("第一时间回复你"), null);
  assert.equal(parseClockClaim("穿能下水的鞋"), null);
});

test("回执收集：任务按其时区换算本地钟点（UTC 00:00Z → 北京 08:00）", () => {
  const { queried, tasks } = collectGroundingTasks([receipt(MORSE_MARKET_TASKS)]);
  assert.equal(queried, true);
  assert.deepEqual(tasks, [{ hour: 8, minute: 0, title: "该去逛早市啦" }]);
});

test("回执收集：无 calendar 回执时 queried=false", () => {
  const { queried, tasks } = collectGroundingTasks([
    { tool: "weather.get_local", status: "ok", result: { ok: true } },
  ]);
  assert.equal(queried, false);
  assert.equal(tasks.length, 0);
});
