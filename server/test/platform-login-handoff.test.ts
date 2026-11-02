/**
 * 平台登录/补价交接：一轮里多个平台只建一个等待步，说明写清「在哪做、怎么算完」。
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
import { requestPlatformLoginHandoff } from "../src/agent/platform-login-handoff.js";

test("requestPlatformLoginHandoff: 多平台合成一次等待步（登录/验证），不逐平台弹", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-platform-handoff-"));
  try {
    initTaskPlanStore({ dataPath: dir, log: () => {} });
    const res = requestPlatformLoginHandoff({
      actorId: "u1",
      sessionId: "s1",
      platformLabels: ["京东", "拼多多"],
      reason: "captcha",
    });
    assert.equal(res.ok, true);
    const store = getTaskPlanStore()!;
    const step = store.blockingStep(taskPlanKey({ actorId: "u1", sessionId: "s1" }));
    assert.ok(step, "应存在等待步");
    assert.equal(step!.status, "awaiting_confirm");
    assert.ok(step!.title.includes("京东") && step!.title.includes("拼多多"));
    assert.ok(step!.title.includes("安全验证"));
    assert.ok(step!.handoff!.instruction.includes("京东、拼多多"));
    assert.ok(step!.handoff!.instruction.includes("安全验证"));
    assert.ok(step!.handoff!.instruction.includes("我已完成"));
    assert.equal(step!.handoff!.checkMode, "user_confirm");

    // 已有等待步时不再叠第二个（重复打扰 = 挤掉浏览器里的用户操作）
    const again = requestPlatformLoginHandoff({
      actorId: "u1",
      sessionId: "s1",
      platformLabels: ["淘宝"],
      reason: "login",
    });
    assert.equal(again.ok, false);
  } finally {
    __setTaskPlanStoreForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
