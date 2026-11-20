import assert from "node:assert/strict";
import test from "node:test";

import {
  compileOpHash,
  compileRunInputHash,
  normalizeCompileDay,
  type CompileOp,
} from "../src/agentic-memory/memory-compile-keys.js";

const base: CompileOp = {
  actorId: "u1",
  day: "2026-11-20",
  stage: "extract",
  opType: "fact.profile",
  target: "居住地",
  value: "兴义",
};

test("同一 op 重放得到同一幂等键", () => {
  assert.equal(compileOpHash({ ...base }), compileOpHash({ ...base }));
});

test("值变化即新 op（旧值由业务侧 supersede）", () => {
  assert.notEqual(compileOpHash(base), compileOpHash({ ...base, value: "贵阳" }));
});

test("阶段/目标/actor 均参与幂等键", () => {
  assert.notEqual(compileOpHash(base), compileOpHash({ ...base, stage: "fixate" }));
  assert.notEqual(compileOpHash(base), compileOpHash({ ...base, target: "职业" }));
  assert.notEqual(compileOpHash(base), compileOpHash({ ...base, actorId: "u2" }));
});

test("day 归一化到日历日，时间后缀不影响幂等键", () => {
  assert.equal(normalizeCompileDay("2026-11-20T03:04:05Z"), "2026-11-20");
  assert.equal(
    compileOpHash({ ...base, day: "2026-11-20T23:59:59+08:00" }),
    compileOpHash(base),
  );
});

test("同批输入摘要稳定，内容变化摘要变化", () => {
  const a = compileRunInputHash("[11-20 10:00 U] 我住在兴义");
  const b = compileRunInputHash("[11-20 10:00 U] 我住在兴义");
  const c = compileRunInputHash("[11-20 10:01 U] 我住在贵阳");
  assert.equal(a, b);
  assert.notEqual(a, c);
});
