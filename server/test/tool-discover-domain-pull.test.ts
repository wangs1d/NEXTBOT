/**
 * 域拉取截断契约（2026-10-10 根修）：
 * 大域（成员数 > DOMAIN_PULL_LIMIT=12）被截断时，被截掉的工具【名字】必须随行下发
 * （more_names），否则域卡标了 (+N) 告诉模型「还有更多」，模型按域来拉却既看不到名、
 * 也无法用 name 模式补拉 → 大域尾部工具对模型事实不可枚举。
 *
 * 断言：matches ∪ more_names 恒等于该域全部成员（可达性不因截断而丢失）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-domain-pull-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);
const { domainsForTool } = await import("../src/tools/tool-search/tool-category.js");

/** 构造 N 个 wallet.* 工具（wallet 是显式域，前缀 "wallet."）。 */
function walletTools(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "function" as const,
    function: {
      name: `wallet.t${String(i + 1).padStart(2, "0")}`,
      description: `钱包测试工具 ${i + 1}`,
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

test("大域按域拉取：截断后 matches ∪ more_names 覆盖全族（可达性不丢）", async () => {
  const corpus = walletTools(15);
  const prepared = prepareToolsWithToolSearch([], corpus);
  const catalog = prepared.deferredCatalog;

  const res = await executeToolSearchBridge("tool_discover", { domain: "wallet" }, catalog);
  assert.equal(res.kind, "discover");
  assert.equal(res.ok, true);
  const result = res.result as {
    count: number;
    matches: Array<{ name: string }>;
    more?: number;
    more_names?: string[];
  };

  const members = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes("wallet"));
  assert.equal(members.length, 15);
  assert.equal(result.count, 15);
  assert.equal(result.matches.length, 12, "详细视图上限 12");
  assert.equal(result.more, 3);
  assert.ok(Array.isArray(result.more_names), "截断时必须下发 more_names");
  assert.equal(result.more_names!.length, 3);

  const reachable = new Set([
    ...result.matches.map((m) => m.name),
    ...(result.more_names ?? []),
  ]);
  assert.deepEqual([...reachable].sort(), [...members].sort(), "matches ∪ more_names 必须覆盖全族");
});

test("小域按域拉取：不触发截断，无 more 字段", async () => {
  const corpus = walletTools(5);
  const prepared = prepareToolsWithToolSearch([], corpus);
  const res = await executeToolSearchBridge(
    "tool_discover",
    { domain: "wallet" },
    prepared.deferredCatalog,
  );
  const result = res.result as { matches: unknown[]; more?: number; more_names?: unknown[] };
  assert.equal(result.matches.length, 5);
  assert.equal(result.more, undefined);
  assert.equal(result.more_names, undefined);
});
