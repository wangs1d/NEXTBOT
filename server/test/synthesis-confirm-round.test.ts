import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAndSelectStrategy } from "../src/agent/synthesis-strategy.js";

// ===== 办妥确认轮短路（2026-10-25）=====
// 提醒/日程创建回执是「已写入」状态，此前无豁免，low 档 honest_sparse 会把
// 确认回复教成「已确定/目前未知/一句提醒」三段式盘点卡（真机：牙医提醒轮，
// 「目前未知」四字即 prompt 原词）。用户拍板：已确定的不必说；没说清的提醒
// 保留但一句话就够。短路后注入 CONFIRM_RECEIPT_INSTRUCTION 专用收口指令。

test("reminder.plan 成功轮短路为 confirm_receipt，不再注入已知/未知盘点策略", () => {
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "reminder.plan",
        ok: true,
        result: {
          ok: true,
          matched: true,
          summary: "提醒已写入日程",
          taskId: "task-1",
          nextRunAtLocal: "10月26日（明天）早上10:00",
          recurrence: "none",
          remindPlan: { summary: "今晚21:00 睡前备忘 → 明早9:00 该出门了" },
        },
      },
    ],
    "明天早上我10点我要去看牙医",
  );
  assert.equal(directive.strategy, "confirm_receipt");
  assert.match(directive.instruction, /办妥确认/);
  assert.match(directive.instruction, /remindPlan/);
  assert.ok(!directive.instruction.includes("目前未知"));
  assert.equal(directive.quality.level, "high");
  assert.equal(directive.preamblePolicy, "suppress");
});

test("calendar.create_from_text 成功轮同样短路", () => {
  const directive = evaluateAndSelectStrategy(
    [{ toolName: "calendar.create_from_text", ok: true, result: { ok: true, matched: true } }],
    "帮我记一下周三下午3点开会",
  );
  assert.equal(directive.strategy, "confirm_receipt");
});

test("确认工具失败轮不短路：失败要向用户解释原因", () => {
  const directive = evaluateAndSelectStrategy(
    [{ toolName: "reminder.plan", ok: false, result: { ok: false, error: "时间解析失败" } }],
    "明天早上我10点我要去看牙医",
  );
  assert.notEqual(directive.strategy, "confirm_receipt");
});

test("确认轮混检索轮不短路：真实数据仍按质量分档组织", () => {
  const mixed = evaluateAndSelectStrategy(
    [
      { toolName: "reminder.plan", ok: true, result: { ok: true, summary: "提醒已写入日程" } },
      { toolName: "search_web", ok: true, result: { items: [{ title: "t", snippet: "s" }] } },
    ],
    "查一下协和牙科再帮我约明天10点",
  );
  assert.notEqual(mixed.strategy, "confirm_receipt");
});
