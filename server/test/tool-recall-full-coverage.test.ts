/**
 * 全量工具检索召回覆盖测试（2026-09-11 检索收口验收）。
 *
 * 回答的问题：现有架构能否确保「所有被注册的工具」都能被正确调用，
 * 且调用方式是检索召回（tool_discover 加载 schema → 模型原生 tool_calls），
 * 不依赖全量 schema 常驻？
 *
 * 三层断言：
 *   A. 快速通道可见集 = 仅 tool_discover 桥，业务 schema 全部在延迟目录里——
 *      证明「不走全量暴露」这一前提成立；
 *   B. 对目录中【每一个】工具，用其别名/示例/名称构造用户式查询，至少一条
 *      查询能把它召回进 top-10——证明检索召回对全目录覆盖；
 *   C. 每一个工具都能取到完整参数 schema（describeDeferredTool）——证明召回
 *      之后模型有足够信息原生调用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-recall-cov-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);
const { describeDeferredTool } = await import("../src/tools/tool-search/catalog.js");
import type { DeferredToolCatalog } from "../src/tools/tool-search/catalog.js";

const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
const catalog: DeferredToolCatalog = prepared.deferredCatalog;

const BRIDGE_TOOLS = new Set(["tool_discover", "tool_search", "tool_describe"]);

/** 工具名的用户口语化形式：calendar.create_task → "calendar create task" */
function humanizeName(name: string): string {
  return name.replace(/[._-]+/g, " ").trim();
}

/** 每个工具的候选查询（按信号强度排序：别名 → 示例 → 口语化名称）。 */
function candidateQueries(entry: DeferredToolCatalog["entries"][number]): string[] {
  const queries: string[] = [];
  const fn = (entry.tool as { function?: { description?: string } }).function;
  if (entry.searchAliases.length > 0) queries.push(entry.searchAliases[0]!);
  if (entry.examples.length > 0) queries.push(entry.examples[0]!);
  queries.push(humanizeName(entry.registryName));
  // 兜底：描述首句（截前 24 字，模拟用户短表达）
  const desc = (fn?.description ?? "").replace(/\s+/g, " ").trim();
  if (desc.length >= 8) queries.push(desc.slice(0, 24));
  return [...new Set(queries.filter((q) => q && q.trim().length >= 2))];
}

async function recallTop10(query: string): Promise<Set<string>> {
  const result = await executeToolSearchBridge(
    "tool_discover",
    { query, limit: 10 },
    catalog,
  );
  const matches = (result.result as { matches?: Array<{ name: string }> }).matches ?? [];
  return new Set(matches.map((m) => m.name));
}

test("A. 快速通道可见集仅桥工具——业务工具不靠全量 schema", () => {
  assert.equal(prepared.toolSearchActive, true, "延迟目录应激活");
  assert.ok(prepared.deferredToolCount >= 50, `延迟目录应有足量工具（实际 ${prepared.deferredToolCount}）`);
  const visibleNames = prepared.visibleTools
    .map((t) => (t.type === "function" ? t.function?.name : null))
    .filter((n): n is string => Boolean(n));
  const nonBridge = visibleNames.filter((n) => !BRIDGE_TOOLS.has(n));
  assert.deepEqual(
    nonBridge,
    [],
    `可见集必须只含桥工具，混入了业务 schema: ${nonBridge.join(", ")}`,
  );
  assert.ok(visibleNames.includes("tool_discover"), "单一通道：只应产出 tool_discover 桥");
});

test("B. 全目录检索召回覆盖：每个工具至少一条用户式查询可召回进 top-10", async () => {
  const misses: Array<{ tool: string; queries: string[]; best: number }> = [];
  let checked = 0;
  for (const entry of catalog.entries) {
    checked += 1;
    const queries = candidateQueries(entry);
    assert.ok(queries.length > 0, `${entry.registryName} 无任何可构造查询信号`);
    let best = Number.POSITIVE_INFINITY;
    for (const query of queries) {
      const top10 = await recallTop10(query);
      if (top10.has(entry.registryName)) {
        best = -1;
        break;
      }
      // 未进前 10：记录该查询下的名次（供失败诊断）
      const all = await executeToolSearchBridge("tool_discover", { query, limit: 200 }, catalog);
      const names = ((all.result as { matches?: Array<{ name: string }> }).matches ?? []).map((m) => m.name);
      const rank = names.indexOf(entry.registryName);
      best = Math.min(best, rank < 0 ? Number.POSITIVE_INFINITY : rank + 1);
    }
    if (best !== -1) misses.push({ tool: entry.registryName, queries, best });
  }
  assert.equal(checked, catalog.entries.length, "应遍历目录全部条目");
  assert.deepEqual(misses, [], `召回覆盖失败 ${misses.length}/${checked}:\n` +
    misses.map((m) => `  ${m.tool}（最好名次 ${m.best}，查询: ${m.queries.map((q) => `「${q}」`).join(" / ")}）`).join("\n"));
});

test("C. 全目录 schema 可加载：召回后模型有足够信息原生调用", () => {
  const missing: string[] = [];
  for (const entry of catalog.entries) {
    if (!describeDeferredTool(catalog, entry.registryName)) missing.push(entry.registryName);
  }
  assert.deepEqual(missing, [], `以下工具无法加载 schema: ${missing.join(", ")}`);
});
