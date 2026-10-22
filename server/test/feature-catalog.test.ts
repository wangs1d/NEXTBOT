import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFeatureByName,
  classifyMcpTool,
  isClassifiedByRule,
  buildCatalogIntentRules,
} from "../src/catalog/class-map.js";
import { FeatureCatalog } from "../src/catalog/feature-catalog.js";
import { LIFE_DOMAINS, type LifeDomain, type UnifiedFeature } from "../src/catalog/types.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import type { SkillManager } from "../src/skills/index.js";

test("分类器：新功能四条线落对生活域与风险", () => {
  // 预订闭环
  assert.equal(classifyFeatureByName("booking.travel-pay").domain, "travel");
  assert.equal(classifyFeatureByName("booking.travel-pay").risk, "spend");
  assert.equal(classifyFeatureByName("booking.travel-issue").action, "manage");
  // 到站管家
  assert.equal(classifyFeatureByName("travel.pickup-send").risk, "outbound");
  assert.equal(classifyFeatureByName("travel.arrival-monitor").trigger, "proactive");
  assert.equal(classifyFeatureByName("travel.arrival-ride").risk, "spend");
  // 习惯闭环
  assert.equal(classifyFeatureByName("habit.mine").domain, "self");
  assert.equal(classifyFeatureByName("habit.create-rule").action, "automate");
  // 既有工具抽查
  assert.equal(classifyFeatureByName("alipay.submit-payment").risk, "spend");
  assert.equal(classifyFeatureByName("sms.send").risk, "outbound");
  assert.equal(classifyFeatureByName("wallet.transfer").risk, "spend");
  assert.equal(classifyFeatureByName("clock.get_current_time").domain, "system");
  assert.equal(classifyFeatureByName("calendar.create_task").domain, "work");
  assert.equal(classifyFeatureByName("meituan.create_order").domain, "dining");
  // 只读工具必须压过家族前缀的 spend/outbound（2026-09-28 根修：高危闸曾误拦），
  // 每个家族补一只代表，防止回退成前缀默认值
  assert.equal(classifyFeatureByName("social.get_feed").risk, "read");
  assert.equal(classifyFeatureByName("social.search_posts").risk, "read");
  assert.equal(classifyFeatureByName("social.post").risk, "outbound");
  assert.equal(classifyFeatureByName("wallet.get_balance").risk, "read");
  assert.equal(classifyFeatureByName("wallet.get_transactions").risk, "read");
  assert.equal(classifyFeatureByName("payment.list_methods").risk, "read");
  assert.equal(classifyFeatureByName("payment.query_order").risk, "read");
});

test("分类器：最长前缀优先（booking.travel-pay 不落 travel.* 泛规则）", () => {
  // travel.* 泛规则是 read，但 booking.travel-pay 有 exact 规则是 spend
  const cls = classifyFeatureByName("booking.travel-pay");
  assert.equal(cls.risk, "spend");
  assert.equal(cls.domain, "travel");
});

test("分类器：未命中规则可识别（isClassifiedByRule=false）", () => {
  assert.equal(isClassifiedByRule("totally.unknown_tool"), false);
  assert.equal(isClassifiedByRule("habit.mine"), true);
  const cls = classifyFeatureByName("totally.unknown_tool");
  assert.equal(cls.domain, "system");
});

test("分类器：MCP 按 server alias 落域（didi→travel，未登记→system）", () => {
  assert.equal(classifyMcpTool("mcp.didi.some_tool", "didi").domain, "travel");
  assert.equal(classifyMcpTool("mcp.unknown.foo", "unknown").domain, "system");
});

test("意图规则：12 域均有检索别名且来自映射表前缀", () => {
  const rules = buildCatalogIntentRules();
  assert.ok(rules.length >= LIFE_DOMAINS.length);
  for (const rule of rules) {
    assert.ok(rule.prefix.length > 0);
    assert.ok(rule.metadata.aliases.length > 0);
  }
});

/** 目录测试桩：最小 ToolRegistry/SkillManager 面。 */
function makeCatalog(
  tools: Array<{ name: string }>,
  skills: Array<{ name: string; description?: string; enabled?: boolean }> = [],
): FeatureCatalog {
  const toolRegistry = {
    listMetadata: () => tools.map((t) => ({ name: t.name })),
  } as unknown as ToolRegistry;
  const skillManager = {
    get: (name: string) => skills.find((s) => s.name === name),
    list: () => skills.map((s) => ({ name: s.name, description: s.description ?? "", enabled: s.enabled !== false })),
  } as unknown as SkillManager;
  return new FeatureCatalog(toolRegistry, skillManager, null);
}

test("FeatureCatalog：汇聚打标 + 12 域统计 + 未分类名单暴露", () => {
  const catalog = makeCatalog(
    [
      { name: "booking.travel-pay" },
      { name: "travel.arrival-ride" },
      { name: "habit.mine" },
      { name: "weird.unknown_thing" },
    ],
    [{ name: "travel.arrival-ride", description: "到站约车" }],
  );
  catalog.build();

  const all = catalog.all();
  assert.equal(all.length, 4);

  // skill 描述合并进目录
  const ride = catalog.classify("travel.arrival-ride") as UnifiedFeature;
  assert.equal(ride.surface, "skill");
  assert.equal(ride.description, "到站约车");
  assert.equal(ride.cls.risk, "spend");

  // 未命中规则的进 unclassified 并落兜底
  assert.deepEqual(catalog.getUnclassified(), ["weird.unknown_thing"]);
  assert.equal(catalog.classify("weird.unknown_thing")?.classifiedBy, "fallback");

  // 域统计：travel=2、self=1、system=1（兜底）
  const stats = new Map(catalog.domainStats().map((s) => [s.domain as string, s.count]));
  assert.equal(stats.get("travel"), 2);
  assert.equal(stats.get("self"), 1);
  assert.equal(stats.get("system"), 1);
});

test("FeatureCatalog：Markdown 视图包含全部 12 域（prompt 行视图已随 2026-10-22 复审退役）", () => {
  const catalog = makeCatalog([{ name: "habit.mine" }, { name: "clock.get_current_time" }]);
  catalog.build();

  const markdown = catalog.toMarkdown();
  for (const domain of LIFE_DOMAINS as readonly LifeDomain[]) {
    assert.ok(markdown.includes(`## ${""}${domain}`) || markdown.includes(`（${domain}）`), `Markdown 应含域 ${domain}`);
  }
  assert.ok(markdown.includes("未分类") === false, "全部分类命中时无未分类段");
});
