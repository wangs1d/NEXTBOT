/**
 * 探针：延迟目录「全目录是否都能被调用到」端到端覆盖（2026-10-10）。
 *
 * 回答的问题：修复域归属派生后，延迟目录里的【每一个】工具（含技能族）是否
 *   ① 能被检索召回进 top-10（tool_discover）
 *   ② 能被 tool_call 正确解析出注册名 + 透传参数
 *   ③ 能取到完整 schema（describeDeferredTool）
 *   ④ 是否在域卡上（可见性）；不在域卡上的，是否仍可按域 discover 拉到
 *
 * 走真实装配链（SkillManager 注册全部内建技能），只读，不写盘。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { dedupeToolsByName } = await import("../src/external-model/lane-tool-sets.js");
const { buildDomainCards, CARD_TOOLS_PER_DOMAIN } = await import(
  "../src/tools/tool-search/domain-cards.js"
);
const { domainsForTool } = await import("../src/tools/tool-search/tool-category.js");
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);
const { describeDeferredTool } = await import("../src/tools/tool-search/catalog.js");
const { SkillManager } = await import("../src/skills/skill-manager.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");

const toolName = (t: unknown): string =>
  (t as { function?: { name?: string } }).function?.name ?? "";

// ── 真实装配链 ──
const skillManager = new SkillManager();
const registerFns = [
  "../src/skills/travel-planning/travel-planning-skills.js",
  "../src/skills/builtin/booking-travel-skills.js",
  "../src/skills/builtin/merchant-order-skills.js",
  "../src/skills/builtin/alipay-payment-skills.js",
  "../src/skills/builtin/picture-skills.js",
  "../src/skills/builtin/habit-loop-skills.js",
  "../src/skills/builtin/arrival-concierge-skills.js",
  "../src/skills/builtin/finance-ingest-skills.js",
  "../src/skills/builtin/virtual-phone-skills.js",
  "../src/skills/builtin/agent-world-identity-skills.js",
] as const;

for (const modPath of registerFns) {
  try {
    const mod: Record<string, unknown> = await import(modPath);
    const key = Object.keys(mod).find(
      (k) => /^register.*BuiltinSkills$/.test(k) && typeof mod[k] === "function",
    );
    if (key) {
      (mod[key] as (r: (s: unknown) => void, d: unknown) => void)(
        (s: unknown) => skillManager.register(s as never),
        new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
      );
    }
  } catch {
    /* ignore */
  }
}

const builtin = getBuiltinAgentChatTools();
const skillTools = skillManager.list(true).map(skillManifestToChatTool);
const corpus = dedupeToolsByName([...builtin, ...skillTools]);

const prepared = prepareToolsWithToolSearch([], corpus);
const catalog = prepared.deferredCatalog;

console.log(
  `═══ 语料 ═══ builtin=${builtin.length} skill=${skillTools.length} 并集=${corpus.length} 延迟目录=${catalog.entries.length}\n`,
);

const BRIDGE_TOOLS = new Set(["tool_discover", "tool_call", "tool_search", "tool_describe"]);

function humanizeName(name: string): string {
  return name.replace(/[._-]+/g, " ").trim();
}
function candidateQueries(entry: (typeof catalog.entries)[number]): string[] {
  const queries: string[] = [];
  const fn = (entry.tool as { function?: { description?: string } }).function;
  if (entry.searchAliases.length > 0) queries.push(entry.searchAliases[0]!);
  if (entry.examples.length > 0) queries.push(entry.examples[0]!);
  queries.push(humanizeName(entry.registryName));
  const desc = (fn?.description ?? "").replace(/\s+/g, " ").trim();
  if (desc.length >= 8) queries.push(desc.slice(0, 24));
  return [...new Set(queries.filter((q) => q && q.trim().length >= 2))];
}

async function recallTop(query: string, limit: number): Promise<string[]> {
  const result = await executeToolSearchBridge("tool_discover", { query, limit }, catalog);
  const matches = (result.result as { matches?: Array<{ name: string }> }).matches ?? [];
  return matches.map((m) => m.name);
}

// ── B. 召回覆盖 ──
const recallMisses: Array<{ tool: string; queries: string[]; best: number }> = [];
for (const entry of catalog.entries) {
  const queries = candidateQueries(entry);
  let best = Number.POSITIVE_INFINITY;
  for (const q of queries) {
    const top10 = await recallTop(q, 10);
    if (top10.includes(entry.registryName)) {
      best = -1;
      break;
    }
    const all = await recallTop(q, 200);
    const rank = all.indexOf(entry.registryName);
    best = Math.min(best, rank < 0 ? Number.POSITIVE_INFINITY : rank + 1);
  }
  if (best !== -1) recallMisses.push({ tool: entry.registryName, queries, best });
}
console.log(`═══ B. 召回覆盖（每个工具能否被某条用户式 query 召回进 top-10）═══`);
console.log(`  覆盖 ${catalog.entries.length - recallMisses.length}/${catalog.entries.length} 个工具`);
if (recallMisses.length > 0) {
  for (const m of recallMisses) {
    console.log(`  ❌ ${m.tool}（最好名次 ${m.best}）查询=${m.queries.map((q) => `「${q}」`).join(" / ")}`);
  }
}

// ── C. tool_call 解析贯通 ──
const callFailures: string[] = [];
for (const entry of catalog.entries) {
  const r = await executeToolSearchBridge(
    "tool_call",
    { name: entry.registryName, arguments: JSON.stringify({ query: "覆盖测试" }) },
    catalog,
  );
  if (r.kind !== "call" || !r.ok || r.registryToolName !== entry.registryName) {
    callFailures.push(entry.registryName);
  }
}
console.log(`\n═══ C. tool_call 执行解析贯通 ═══`);
console.log(`  贯通 ${catalog.entries.length - callFailures.length}/${catalog.entries.length}`);
if (callFailures.length > 0) console.log(`  ❌ ${callFailures.join(", ")}`);

// ── D. schema 可取 ──
const schemaMisses = catalog.entries
  .filter((e) => !describeDeferredTool(catalog, e.registryName))
  .map((e) => e.registryName);
console.log(`\n═══ D. schema 可加载 ═══`);
console.log(`  可取 ${catalog.entries.length - schemaMisses.length}/${catalog.entries.length}`);
if (schemaMisses.length > 0) console.log(`  ❌ ${schemaMisses.join(", ")}`);

// ── E. 域卡可见性 + 域卡外工具可否按域 discover 拉到 ──
const cards = buildDomainCards(corpus);
const onCard = new Set<string>();
for (const entry of catalog.entries) {
  if (cards.includes(entry.registryName)) onCard.add(entry.registryName);
}
const offCard = catalog.entries.filter((e) => !onCard.has(e.registryName));
console.log(`\n═══ E. 便捷通道可达性（域卡 ∪ 按域 discover）═══`);
console.log(`  在域卡上 ${onCard.size}/${catalog.entries.length}；域卡外 ${offCard.length}`);

// 对每个工具：按它自己的域做 discover，看是否被拉回
const pullable = new Set<string>();
const pulledByDomain = new Map<string, string[]>();
for (const e of catalog.entries) {
  const dom = domainsForTool(e.registryName)[0] ?? "misc";
  if (!pulledByDomain.has(dom)) {
    const r = await executeToolSearchBridge("tool_discover", { domain: dom }, catalog);
    const res = r.result as {
      matches?: Array<{ name: string }>;
      more_names?: string[];
    };
    const names = [
      ...(res.matches ?? []).map((m) => m.name),
      ...(res.more_names ?? []),
    ];
    pulledByDomain.set(dom, names);
  }
  if (pulledByDomain.get(dom)!.includes(e.registryName)) pullable.add(e.registryName);
}
const convenience = new Set<string>([...onCard, ...pullable]);
const onlyQuery = catalog.entries.filter((e) => !convenience.has(e.registryName));
console.log(`  按域 discover 可拉到 ${pullable.size}/${catalog.entries.length}`);
console.log(`  便捷通道（域卡∪按域）可达 ${convenience.size}/${catalog.entries.length}`);
if (onlyQuery.length > 0) {
  console.log(`  ⚠️ 只能靠 query 检索调到（便捷通道够不到）${onlyQuery.length} 个：`);
  for (const e of onlyQuery) console.log(`     - ${e.registryName}（域 ${domainsForTool(e.registryName).join("/")}）`);
}
console.log(`\n（CARD_TOOLS_PER_DOMAIN=${CARD_TOOLS_PER_DOMAIN}，DOMAIN_PULL_LIMIT=12）`);
