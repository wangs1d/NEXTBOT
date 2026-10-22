// 树枝闸单测（2026-10-22 树状架构 Phase 1）：L1 确定性规则 / L2 游标去重 /
// 现役闸委托（message 树枝零行为漂移）/ 豁免谓词 / 持久化游标。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BranchCursor } from "../src/proactivity/branches/branch-cursor.js";
import { BranchGate } from "../src/proactivity/branches/branch-gate.js";
import type { BranchManifest } from "../src/proactivity/branches/branch-types.js";

function makeManifest(overrides: Partial<BranchManifest> = {}): BranchManifest {
  return {
    id: "test_branch",
    stream: "message",
    mode: "streaming",
    label: "测试树枝",
    gate: { strongNoise: "(验证码|校验码|取件码|退订回[T]|中奖|贷款)" },
    ...overrides,
  };
}

function makeCursor(): BranchCursor {
  const dir = mkdtempSync(join(tmpdir(), "branch-gate-"));
  const cursor = new BranchCursor({ persistPath: join(dir, "cursors.json") });
  return cursor;
}

test("L1 强噪声：验证码/取件码命中即挡，普通文本放行", () => {
  const gate = new BranchGate({ manifest: makeManifest(), cursor: makeCursor() });
  assert.equal(gate.admit({ text: "你的验证码是 883920，请勿泄露", fingerprint: "fp1" }).allowed, false);
  assert.equal(gate.admit({ text: "取件码 7-2-1003，驿站营业到 21 点", fingerprint: "fp2" }).allowed, false);
  const ok = gate.admit({ text: "明天下午三点开会，别迟到", fingerprint: "fp3" });
  assert.equal(ok.allowed, true);
  assert.equal(ok.stage, "L2");
});

test("L1 商业密度：≥2 个不同商业词才挡（单词误杀率高）", () => {
  const gate = new BranchGate({ manifest: makeManifest({ gate: { commercialDensity: 2 } }), cursor: makeCursor() });
  // 单个商业词：朋友闲聊「这家店包邮」不该被挡
  assert.equal(gate.admit({ text: "这家店包邮，买了他家坚果", fingerprint: "fp4" }).allowed, true);
  // 堆词营销：挡
  assert.equal(gate.admit({ text: "限时秒杀满减包邮，点击购买", fingerprint: "fp5" }).allowed, false);
});

test("L1 豁免谓词先行：日程变动信号绕过强噪声正则", () => {
  const gate = new BranchGate({
    manifest: makeManifest({
      gate: {
        strongNoise: "(验证码|校验码)",
        exempt: (text) => /取消|改期/.test(text),
      },
    }),
    cursor: makeCursor(),
  });
  assert.equal(gate.admit({ text: "校验码……不，是说航班取消了", fingerprint: "fp6" }).allowed, true);
});

test("L2 游标：同指纹第二次上报被挡，跨树枝互不影响", () => {
  const cursor = makeCursor();
  const gateA = new BranchGate({ manifest: makeManifest({ id: "a", gate: { passthrough: true } }), cursor });
  const gateB = new BranchGate({ manifest: makeManifest({ id: "b", gate: { passthrough: true } }), cursor });
  assert.equal(gateA.admit({ text: "同一份课表", fingerprint: "same_fp" }).allowed, true);
  const dup = gateA.admit({ text: "同一份课表", fingerprint: "same_fp" });
  assert.equal(dup.allowed, false);
  assert.equal(dup.stage, "L2");
  assert.equal(dup.reason, "already_reported");
  // 另一根树枝同指纹：独立去重
  assert.equal(gateB.admit({ text: "同一份课表", fingerprint: "same_fp" }).allowed, true);
});

test("delegate：message 树枝委托现役闸语义，零行为漂移", () => {
  const gate = new BranchGate({
    manifest: makeManifest({
      id: "message",
      gate: { delegate: (text) => (text.includes("退订回T") ? { gated: true, reason: "strong_noise" } : { gated: false }) },
    }),
    cursor: makeCursor(),
  });
  assert.equal(gate.admit({ text: "回复TD退订回T", fingerprint: "fp7" }).allowed, false);
  assert.equal(gate.admit({ text: "正常消息", fingerprint: "fp8" }).allowed, true);
});

test("游标持久化：重建后指纹仍在（重启不重报）", () => {
  const dir = mkdtempSync(join(tmpdir(), "branch-gate-persist-"));
  const path = join(dir, "cursors.json");
  const c1 = new BranchCursor({ persistPath: path });
  assert.equal(c1.checkAndMark("branch_x", "fpA"), false);
  const c2 = new BranchCursor({ persistPath: path });
  assert.equal(c2.checkAndMark("branch_x", "fpA"), true);
  rmSync(dir, { recursive: true, force: true });
});
