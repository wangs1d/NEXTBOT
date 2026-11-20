/**
 * 工具曝光层一致性守卫（2026-11-20 P0）。
 *
 * 锁三件事，防「ride_hailing 只写进两处清单」这类事故复发：
 *   1. 车道常驻名单必须与冻结快照一致（改名单必须同时改本快照，逼迫评审）；
 *   2. 声明源无重名；
 *   3. 曝光拆分恒等式：visible ∪ deferred = registry，且两者不相交
 *      （「既没进口袋也不在手上」在结构上不可能出现）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHAT_LANE_CORE_NAMES, TASK_LANE_CORE_NAMES } from "../src/external-model/lane-tool-sets.js";
import { RESIDENT_TOOLS } from "../src/tools/exposure/residency.js";
import { prepareToolsWithToolSearch } from "../src/tools/tool-search/index.js";
import { resetToolSearchConfigForTests } from "../src/tools/tool-search/env.js";

/** 冻结快照（2026-11-20）：改常驻名单必须同步这里，评审可见 diff。 */
const GOLDEN_CHAT = [
  "agent", "brain.recall", "calendar", "clock.get_user_location", "obs_recall", "phone",
  "profile.update", "ride_hailing", "task.cancel", "task.dispatch",
  "task.status", "web_fetch", "web_search", "world.link",
];
const GOLDEN_TASK = [
  "agent", "brain.recall", "browser.session.list", "calendar", "clock.get_user_location",
  "code.read_file", "code.run", "code.write_file", "obs_recall",
  "perception.overview", "task.cancel", "task.dispatch", "task.status", "tool_discover",
  "web_fetch", "web_search", "world.link",
];

const sorted = (xs: readonly string[]) => [...xs].sort();

test("chat 常驻名单与冻结快照一致", () => {
  assert.deepEqual(sorted(CHAT_LANE_CORE_NAMES), sorted(GOLDEN_CHAT));
});

test("task 常驻名单与冻结快照一致", () => {
  assert.deepEqual(sorted(TASK_LANE_CORE_NAMES), sorted(GOLDEN_TASK));
});

test("声明源无重名", () => {
  const names = RESIDENT_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `重复声明: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

test("曝光拆分恒等式：visible ∪ deferred = registry，且不相交", () => {
  // 大 schema 语料自动触发延迟目录激活（inactive 模式不建目录，恒等式不适用）
  resetToolSearchConfigForTests();
  const mk = (name: string) => ({
    type: "function" as const,
    function: { name, description: `${name} 测试工具` + "说明字段用于撑满 schema token 预算，触发延迟目录激活。".repeat(12), parameters: { type: "object" as const, properties: {} } },
  });
  const registry = Array.from({ length: 200 }, (_, i) => mk(`t.tool_${i}`));
  const visibleCandidate = registry.slice(0, 20);
  const prepared = prepareToolsWithToolSearch(visibleCandidate, registry);
  const visibleNames = new Set(
    prepared.visibleTools.map((t) => (t.type === "function" ? t.function?.name ?? "" : "")).filter(Boolean),
  );
  const deferredNames = new Set(prepared.deferredCatalog.entries.map((e) => e.registryName));
  const allRegistryNames = registry.map((t) => t.function.name);

  // 不相交
  for (const n of visibleNames) {
    assert.ok(!deferredNames.has(n), `${n} 同时出现在可见面与延迟目录`);
  }
  // 全集覆盖（桥工具不属于 registry，忽略）
  const bridgeNames = new Set(["tool_discover"]);
  const missing = allRegistryNames.filter((n) => !visibleNames.has(n) && !deferredNames.has(n));
  assert.deepEqual(missing, [], `以下工具既不可见也不在目录（本次事故形态）: ${missing.join(", ")}`);
  assert.ok(![...bridgeNames].some((b) => deferredNames.has(b)), "桥工具不应进入延迟目录");
});

// ── Skill 包守卫（2026-11-20）──
import { SKILL_BUNDLES, findSkillBundle, isSkillBundleId } from "../src/tools/exposure/skill-bundles.js";
import { buildCapabilityModules } from "../src/tools/capability-modules/index.js";

test("skill 引用的域必须真实存在（防 typo/下线域）", () => {
  const stub: unknown = new Proxy(function () { return stub; }, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
    apply: () => stub,
    construct: () => stub as object,
  });
  const realDomains = new Set(
    buildCapabilityModules(stub as never).map((m) => m.domain),
  );
  const bad: string[] = [];
  for (const skill of SKILL_BUNDLES) {
    assert.ok(skill.oneLiner.length > 0, `skill ${skill.id} 缺一句描述`);
    for (const d of skill.domains) {
      if (!realDomains.has(d)) bad.push(`${skill.id}→${d}`);
    }
  }
  assert.deepEqual(bad, [], `skill 引用了不存在的域: ${bad.join(", ")}`);
});

test("skill id 与域名的解析不冲突", () => {
  assert.equal(isSkillBundleId("ride"), true);
  assert.equal(isSkillBundleId("ride_hailing"), false);
  assert.deepEqual(findSkillBundle("ride")?.domains, ["ride_hailing"]);
});
