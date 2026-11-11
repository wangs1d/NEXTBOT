import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAndSelectStrategy } from "../src/agent/synthesis-strategy.js";

// ===== 办妥确认轮短路（2026-10-25）=====
// 提醒/日程创建回执是「已写入」状态，此前无豁免，low 档编号模板（honest_sparse，
// 已于 2026-11-05 删除）会把确认回复教成「已确定/目前未知/一句提醒」三段式盘点卡
// （真机：牙医提醒轮，「目前未知」四字即 prompt 原词）。用户拍板：已确定的不必说；
// 没说清的提醒保留但一句话就够。短路后注入 CONFIRM_RECEIPT_INSTRUCTION 专用收口指令。

test("calendar.create 成功轮短路为 confirm_receipt，且不再要求转告分级计划", () => {
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "calendar",
        ok: true,
        result: {
          ok: true,
          matched: true,
          summary: "提醒已写入日程",
          taskId: "task-1",
          whenSpoken: "明天上午十点",
          recurrence: "none",
          hasAdvanceReminder: true,
        },
      },
    ],
    "明天早上我10点我要去看牙医",
  );
  assert.equal(directive.strategy, "confirm_receipt");
  // 2026-11-05：分级计划不告诉用户——指令里不得再要求「转告预告段」
  assert.ok(!directive.instruction.includes("remindPlan"));
  assert.ok(!/转告|一并告知/.test(directive.instruction), "不得再要求播报分级计划");
  assert.ok(
    !directive.instruction.includes("nextRunAtLocal"),
    "nextRunAtLocal 是 11/6 11:00 的机器格式，指它必然说出「明天 11:00 会提醒你」",
  );
  assert.ok(!directive.instruction.includes("目前未知"));
  // 2026-11-05 第四轮（用户：「为什么回复那么相似 没有活人感 行 记上了 是固定模板？」）：
  // 指令里只要出现示例句子，模型就必然照抄成固定台词——连示例一并禁。
  for (const tpl of ["行，记上了", "好嘞", "到时候我喊你", "到时候提前喊你"]) {
    assert.ok(!directive.instruction.includes(tpl), `指令里不得出现示例台词：${tpl}`);
  }
  assert.ok(!/一句话收尾|一两句/.test(directive.instruction), "不得规定句数——那是模板的另一种写法");
  // 2026-11-05 第五轮（用户：「【回复策略】太啰嗦了」）：整段压成一句，锁死长度上限
  assert.ok(directive.instruction.length < 200, `确认轮指令必须精炼（当前 ${directive.instruction.length} 字）`);
  assert.match(directive.instruction, /whenSpoken/);
  assert.match(directive.instruction, /advanceReminderKinds/);
  assert.match(directive.instruction, /别重复时间/);
  assert.match(directive.instruction, /别提内部编排/);
  assert.match(directive.instruction, /别复述他的原话/);
  assert.equal(directive.quality.level, "high");
  assert.equal(directive.preamblePolicy, "suppress");
});

test("calendar.create 成功轮同样短路", () => {
  const directive = evaluateAndSelectStrategy(
    [{ toolName: "calendar", ok: true, result: { ok: true, matched: true } }],
    "帮我记一下周三下午3点开会",
  );
  assert.equal(directive.strategy, "confirm_receipt");
});

test("确认工具失败轮不短路：失败要向用户解释原因", () => {
  const directive = evaluateAndSelectStrategy(
    [{ toolName: "calendar", ok: false, result: { ok: false, error: "时间解析失败" } }],
    "明天早上我10点我要去看牙医",
  );
  assert.notEqual(directive.strategy, "confirm_receipt");
});

test("确认轮混检索轮不短路：真实数据仍按质量分档组织", () => {
  const mixed = evaluateAndSelectStrategy(
    [
      { toolName: "calendar", ok: true, result: { ok: true, summary: "提醒已写入日程" } },
      { toolName: "search_web", ok: true, result: { items: [{ title: "t", snippet: "s" }] } },
    ],
    "查一下协和牙科再帮我约明天10点",
  );
  assert.notEqual(mixed.strategy, "confirm_receipt");
});

test("calendar.create 解析失败（matched:false）不得当办妥确认", () => {
  // 2026-11-05 实测发现：ok:true + matched:false（未能解析时间或事项）也被判成
  // confirm_receipt，指令让模型说「已写入成功」——用户会以为提醒设好了。
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "calendar",
        ok: true,
        result: { ok: true, matched: false, hint: "未能解析时间或事项" },
      },
    ],
    "明天早上11点我预约了牙医",
  );
  assert.notEqual(directive.strategy, "confirm_receipt");
});
