/**
 * 记忆写入信号回归测试（2026-10-09 称呼事故）。
 *
 * 事故：用户 10-07 / 10-09 两次说「以后叫我王哥」，agent 口头答应
 * （「记上了，王哥」/「好的王哥，已经记上啦」），但结构化事实库的「称呼」
 * 始终是首启向导写入的「王king」，客户端空态问候一直显示王king。
 * 根因：写入闸门只认 memoryInstruction 与 AGENT_COMMITMENT_RE；「以后叫我
 * 王哥」被 L1 正确判为 personal_fact，而该信号此前只喂召回闸门（recall-gate），
 * 写入侧完全收不到，抽取链路（extractUnified → applyFact）从未触发。
 *
 * 本文件锁定三件事：
 *  - A. personalFact 进入高信号，并产出「[用户事实]」原子行；
 *  - B. agent 的「已经记上了」类话术被认作承诺（不落库的"我记上了"最伤）；
 *  - C. 无信号轮次保持低信号（不误放行）；D/E 锁定原有行为不回退。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { detectMemorySignals, AGENT_COMMITMENT_RE } from "../src/agent/memory-signal.js";
import { gateLtmWrite } from "../src/agentic-memory/ltm-write-gate.js";

test("A1 personalFact 单独触发高信号并产出用户事实原子行", () => {
  const r = detectMemorySignals("以后叫我王哥", "好的", false, true);
  assert.equal(r.isHighSignal, true);
  assert.deepEqual(r.reasons, ["personal_fact"]);
  assert.deepEqual(r.extractLines, ["[用户事实] 以后叫我王哥"]);
});

test("A2 不传 personalFact 保持向后兼容（旧调用点不误放行）", () => {
  const r = detectMemorySignals("以后叫我王哥", "好的");
  assert.equal(r.isHighSignal, false);
  assert.deepEqual(r.extractLines, []);
});

test("B1 agent 回「已经记上啦」被认作承诺话术", () => {
  const r = detectMemorySignals("以后叫我王哥", "好的王哥，已经记上啦");
  assert.equal(r.isHighSignal, true);
  assert.ok(r.reasons.includes("agent_commitment"));
});

test("B2 「记上了，王哥」被认作承诺话术", () => {
  assert.ok(AGENT_COMMITMENT_RE.test("记上了，王哥"));
  assert.ok(AGENT_COMMITMENT_RE.test("好，我记下来了"));
  assert.ok(AGENT_COMMITMENT_RE.test("已记录，王哥"));
});

test("C 普通闲聊保持低信号", () => {
  const r = detectMemorySignals("今天天气不错", "是啊，挺舒服的");
  assert.equal(r.isHighSignal, false);
  assert.deepEqual(r.extractLines, []);
});

test("D memoryInstruction 原有行为不变", () => {
  const r = detectMemorySignals("帮我记住我周三休息", "收到", true);
  assert.deepEqual(r.reasons, ["explicit_remember"]);
  assert.deepEqual(r.extractLines, ["[用户要求记住] 帮我记住我周三休息"]);
});

test("E 两类信号同时命中时两条原子行都产出", () => {
  const r = detectMemorySignals("以后叫我王哥", "好的王哥，已经记上啦", false, true);
  assert.deepEqual(r.reasons, ["personal_fact", "agent_commitment"]);
  assert.equal(r.extractLines.length, 2);
});

test("F 产出的原子行能通过 LTM 写入门（不被当提醒/协议残留误杀）", () => {
  const userFactLine = detectMemorySignals("以后叫我王哥", "好的", false, true).extractLines[0]!;
  const verdict = gateLtmWrite(userFactLine, "chat:fast_path");
  assert.equal(verdict.admit, true);
  assert.ok(verdict.cleaned.includes("以后叫我王哥"));
});
