/**
 * 浏览器 handoff 自动检测（2026-11-02 用户拍板：不要求用户点按钮）。
 *
 * 覆盖：
 *   1. requestBrowserHumanHandoff 带 probe → checkMode=probe + 探测配置落盘 +
 *      文案改为「自动检测，不需要点按钮」（按钮保留作兜底）
 *   2. 不带 probe → 维持 user_confirm 旧语义（回归）
 *   3. TaskPlanProbeRunner 尊重步级 probeGapMs：小 gap 下 tick 即探测，
 *      expect 命中 → 自动置 done + onResumed 回调（无需用户回执）
 *   4. 未命中 expect → 不收回，继续等
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __setTaskPlanStoreForTest,
  getTaskPlanStore,
  initTaskPlanStore,
  taskPlanKey,
} from "../src/agent/task-plan-store.js";
import { TaskPlanProbeRunner } from "../src/agent/task-plan-probe-runner.js";
import { requestBrowserHumanHandoff } from "../src/services/browser-runtime/browser-human-handoff.js";

test("handoff 带 probe → 自动检测模式：checkMode=probe + 文案不要求点按钮", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-handoff-auto-"));
  try {
    initTaskPlanStore({ dataPath: dir, log: () => {} });
    const res = requestBrowserHumanHandoff({
      actorId: "u1",
      sessionId: "s1",
      siteLabels: ["淘宝"],
      reason: "login",
      goal: "登录淘宝后继续抓取报价",
      continueStep: "继续抓取报价",
      probe: {
        tool: "shared_browser.panel_state",
        args: { siteId: "taobao" },
        expect: '"blocked":false',
        gapMs: 12_000,
      },
    });
    assert.equal(res.ok, true);
    const step = getTaskPlanStore()!.blockingStep(taskPlanKey({ actorId: "u1", sessionId: "s1" }));
    assert.ok(step, "应存在等待步");
    assert.equal(step!.handoff!.checkMode, "probe");
    assert.equal(step!.handoff!.probe?.tool, "shared_browser.panel_state");
    assert.equal(step!.handoff!.probe?.expect, '"blocked":false');
    assert.equal(step!.handoff!.probeGapMs, 12_000);
    // 文案：自动检测语义（不用点按钮），兜底按钮仍在
    assert.ok(step!.handoff!.instruction.includes("自动检测"), `instruction：${step!.handoff!.instruction}`);
    assert.ok(step!.handoff!.instruction.includes("不需要回来点任何按钮"));
    assert.equal(step!.handoff!.actions?.[0]?.label, "我已完成", "兜底按钮保留");
  } finally {
    __setTaskPlanStoreForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff 不带 probe → 维持 user_confirm 旧语义（回归）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-handoff-legacy-"));
  try {
    initTaskPlanStore({ dataPath: dir, log: () => {} });
    const res = requestBrowserHumanHandoff({
      actorId: "u2",
      sessionId: "s2",
      siteLabels: ["携程"],
      reason: "login",
    });
    assert.equal(res.ok, true);
    const step = getTaskPlanStore()!.blockingStep(taskPlanKey({ actorId: "u2", sessionId: "s2" }));
    assert.equal(step!.handoff!.checkMode, "user_confirm");
    assert.equal(step!.handoff!.probe, undefined);
    assert.ok(step!.handoff!.instruction.includes("我已完成"));
  } finally {
    __setTaskPlanStoreForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe runner：步级 probeGapMs 生效，expect 命中即自动收回并回调 onResumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-handoff-resume-"));
  try {
    initTaskPlanStore({ dataPath: dir, log: () => {} });
    const written = requestBrowserHumanHandoff({
      actorId: "u3",
      sessionId: "s3",
      siteLabels: ["天猫", "淘宝"],
      reason: "login",
      continueStep: "继续抓取报价",
      probe: {
        tool: "shared_browser.panel_state",
        args: { siteId: "taobao" },
        expect: '"blocked":false',
        gapMs: 12_000,
      },
    });
    assert.equal(written.ok, true);

    let probeCalls = 0;
    let resumed = 0;
    let nowMs = 1_000_000;
    const runner = new TaskPlanProbeRunner({
      store: getTaskPlanStore()!,
      // 第一次探测仍被墙（blocked:true，不命中 expect）；第二次墙已清除 → 自动续跑
      executeProbe: async () => {
        probeCalls += 1;
        const blocked = probeCalls === 1;
        return { ok: true, result: { ok: true, blocked } };
      },
      onResumed: () => {
        resumed += 1;
      },
      nowFn: () => nowMs,
      minProbeGapMs: 5 * 60_000, // 全局默认 5min——验证步级 12s 覆盖生效
      env: {},
    });

    const first = await runner.tick();
    assert.equal(first, 0, "第一次探测仍被墙 → 不收回");
    assert.equal(probeCalls, 1, "步级 gap=12s 覆盖全局 5min：立即探测");
    assert.equal(resumed, 0);

    nowMs += 13_000; // 前进 13s（> 12s 步级 gap），模拟真实等待用户登录
    const second = await runner.tick();
    assert.equal(second, 1, "第二次探测墙已清除 → 自动置 done 收回");
    assert.equal(resumed, 1, "onResumed 回调触发（装配层据此起受控续跑）");
    const plan = getTaskPlanStore()!.listAll().find((p) => p.sessionId === taskPlanKey({ actorId: "u3", sessionId: "s3" }));
    const step = plan?.steps.find((s) => s.title.includes("天猫"));
    assert.equal(step?.status, "done", "登录步被 probe 自动置 done（用户没点任何按钮）");
  } finally {
    __setTaskPlanStoreForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
