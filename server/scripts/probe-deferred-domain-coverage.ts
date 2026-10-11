/**
 * 探针：延迟目录「模型不主动调取」根因诊断（2026-10-10）。
 *
 * 假设 H：技能族工具未在 DOMAIN_REGISTRY 登记前缀 → 落 misc 兜底域 →
 *   ① 域卡里没有该域（且 misc 被 CARD_TOOLS_PER_DOMAIN 截断）→ 模型不知道有这个能力；
 *   ② tool_discover({domain:"habit"}) 返回「未知能力域」→ 按域拉取路径死；
 *   ③ L1 域预载的域多数票也认不出该族 → 预载漏召 → 手上没工具 → 自己答。
 *
 * 走真实装配链（SkillManager 注册全部内建技能），只读，不写盘。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { buildDomainPreloadTools, buildLaneCoreTools, dedupeToolsByName } = await import(
  "../src/external-model/lane-tool-sets.js"
);
const { buildDomainCards } = await import("../src/tools/tool-search/domain-cards.js");
const { domainsForTool, DOMAIN_REGISTRY } = await import(
  "../src/tools/tool-search/tool-category.js"
);
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);
const { SkillManager } = await import("../src/skills/skill-manager.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");

const toolName = (t: unknown): string =>
  (t as { function?: { name?: string } }).function?.name ?? "";

// ── 真实装配链 ──
const skillManager = new SkillManager();
const registerFns = [
  ["travel-planning", "../src/skills/travel-planning/travel-planning-skills.js"],
  ["booking-travel", "../src/skills/builtin/booking-travel-skills.js"],
  ["merchant-order", "../src/skills/builtin/merchant-order-skills.js"],
  ["alipay-payment", "../src/skills/builtin/alipay-payment-skills.js"],
  ["picture", "../src/skills/builtin/picture-skills.js"],
  ["habit-loop", "../src/skills/builtin/habit-loop-skills.js"],
  ["arrival-concierge", "../src/skills/builtin/arrival-concierge-skills.js"],
  ["finance-ingest", "../src/skills/builtin/finance-ingest-skills.js"],
  ["virtual-phone", "../src/skills/builtin/virtual-phone-skills.js"],
  ["agent-world-identity", "../src/skills/builtin/agent-world-identity-skills.js"],
] as const;

for (const [, modPath] of registerFns) {
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
    /* 注册失败不阻塞诊断 */
  }
}

const builtin = getBuiltinAgentChatTools();
const skillTools = skillManager.list(true).map(skillManifestToChatTool);
const merged = dedupeToolsByName([...builtin, ...skillTools]);

console.log(`═══ 语料规模 ═══ builtin=${builtin.length} skill=${skillTools.length} 并集=${merged.length}\n`);

// ── ① 域分布：每个域挂了多少工具，谁落了 misc ──
const byDomain = new Map<string, string[]>();
for (const t of merged) {
  const n = toolName(t);
  if (!n) continue;
  for (const d of domainsForTool(n)) {
    const list = byDomain.get(d) ?? [];
    list.push(n);
    byDomain.set(d, list);
  }
}
const CARD_TOOLS_PER_DOMAIN = 14;

console.log("═══ ① 域分布（域卡 CARD_TOOLS_PER_DOMAIN=14，超出即从域卡消失）═══");
for (const def of DOMAIN_REGISTRY) {
  const names = byDomain.get(def.name);
  if (!names || names.length === 0) continue;
  const hidden = Math.max(0, names.length - CARD_TOOLS_PER_DOMAIN);
  const flag = hidden > 0 ? `  ⚠️ 域卡隐藏 ${hidden} 个` : "";
  console.log(`  ${def.name.padEnd(12)} ${String(names.length).padStart(3)} 个${flag}`);
}
const misc = byDomain.get("misc") ?? [];
console.log(`\n  ★ misc 兜底域共 ${misc.length} 个工具（无域归属）：`);
console.log(`    ${misc.join("、")}`);

// 技能族落在哪
console.log("\n═══ ①b 各技能族的域归属 ═══");
const families = new Map<string, Set<string>>();
for (const t of skillTools) {
  const n = toolName(t);
  const fam = n.split(".")[0] ?? n;
  if (!families.has(fam)) families.set(fam, new Set());
  for (const d of domainsForTool(n)) families.get(fam)!.add(d);
}
for (const [fam, doms] of families) {
  const onlyMisc = [...doms].every((d) => d === "misc");
  console.log(`  ${fam.padEnd(15)} → ${[...doms].join("+")}${onlyMisc ? "   ❌ 无专属域" : ""}`);
}

// ── ② 域卡实际文本 ──
console.log("\n═══ ② 域卡（模型每轮看到的「我有什么」）═══");
const cards = buildDomainCards(merged);
const cardDomainLines = cards.split("\n").filter((l) => l.startsWith("- "));
console.log(`  域卡列出 ${cardDomainLines.length} 个域：`);
for (const l of cardDomainLines) console.log(`    ${l.slice(0, 110)}`);
const cardCovers = (fam: string): boolean => cards.includes(`${fam}.`);
console.log("\n  技能族在域卡中的可见性：");
for (const fam of families.keys()) {
  console.log(`    ${fam.padEnd(15)} ${cardCovers(fam) ? "✅ 域卡可见" : "❌ 域卡完全不可见"}`);
}

// ── ③ L1 预载 vs tool_discover 实际召回 ──
const core = buildLaneCoreTools("chat", merged, []);
const coreNames = new Set(core.map(toolName));
const prepared = prepareToolsWithToolSearch(core, merged);
const catalog = prepared.deferredCatalog;

const cases: Array<{ q: string; expect: string; family: string }> = [
  { q: "记一下我每天早上要喝水的习惯", expect: "habit.create-rule", family: "habit" },
  { q: "帮我把健身房打卡设为每天的习惯", expect: "habit.create-rule", family: "habit" },
  { q: "帮我订一下去三亚的机票", expect: "booking.travel-pay", family: "booking" },
  { q: "把我这张照片修一下", expect: "picture.process", family: "picture" },
  { q: "帮我把这个月的账单导入记账", expect: "finance.ingest-text", family: "finance" },
  { q: "给我申请一个虚拟手机号", expect: "virtual-phone.ensure-my-number", family: "virtual-phone" },
];

console.log("\n═══ ③ 长尾域 query：L1 确定性预载 是否能召回本族 ═══");
for (const c of cases) {
  const preload = buildDomainPreloadTools(c.q, merged, coreNames).map(toolName);
  const famHit = preload.some((n) => n.startsWith(c.family + "."));
  console.log(`  「${c.q}」`);
  console.log(`    预载 ${preload.length} 个：${JSON.stringify(preload)}`);
  console.log(`    期望族 ${c.family} → ${famHit ? "✅ 命中" : "❌ 漏召（模型手上没有该族工具）"}`);
}

const { bm25HitsForQuery, domainVotesForQuery } = await import(
  "../src/tools/tool-search/index.js"
);

console.log("\n═══ ③b L1 预载为何漏召：BM25 裸排序 + 域票 ═══");
for (const c of cases) {
  const hits = bm25HitsForQuery(c.q, merged, 8);
  const votes = domainVotesForQuery(c.q, merged)
    .slice(0, 4)
    .map((v) => `${v.domain}:${v.votes}`)
    .join(" ");
  console.log(`  「${c.q}」`);
  console.log(`    BM25 top8: ${hits.map((h) => `${h.name}(${h.score.toFixed(3)})`).join(", ")}`);
  console.log(`    域票: ${votes || "(无)"}`);
}

console.log("\n═══ ③c 噪声对照：闲聊/无关 query 的派生域票（≥2 才有放宽资格）═══");
const explicitDomains = new Set(DOMAIN_REGISTRY.map((d) => d.name));
const noiseQueries = [
  "嗯嗯好的",
  "你好呀",
  "今天天气怎么样",
  "我回来了",
  "随便聊聊吧",
  "谢谢啦",
  "1加1等于几",
  "好无聊啊",
  "在吗",
  "周末想去哪儿玩好呢",
];
for (const q of noiseQueries) {
  const hits = bm25HitsForQuery(q, merged, 8);
  const votes = new Map<string, number>();
  for (const h of hits) {
    for (const d of domainsForTool(h.name)) {
      if (!explicitDomains.has(d)) votes.set(d, (votes.get(d) ?? 0) + 1);
    }
  }
  const flagged = [...votes].filter(([, v]) => v >= 2);
  console.log(`  「${q}」→ ${flagged.length ? JSON.stringify(flagged) : "无派生域≥2"}`);
}

console.log("\n═══ ④ 若模型主动 discover，能否拿到这些族？═══");
for (const c of cases) {
  const r1 = await executeToolSearchBridge("tool_discover", { query: c.q }, catalog);
  const hits =
    r1.ok && typeof r1.result === "object" && Array.isArray((r1.result as { matches?: unknown }).matches)
      ? ((r1.result as { matches: Array<{ name: string }> }).matches).map((m) => m.name)
      : [];
  const famHit = hits.some((n) => n.startsWith(c.family + "."));
  console.log(`  query 检索「${c.q.slice(0, 12)}…」→ ${famHit ? "✅" : "❌"} ${JSON.stringify(hits.slice(0, 5))}`);

  const r2 = await executeToolSearchBridge("tool_discover", { domain: c.family }, catalog);
  const ok2 = r2.ok;
  console.log(
    `    按域 discover({domain:"${c.family}"}) → ${ok2 ? "✅ 成功" : `❌ 失败：${String((r2.result as { error?: string }).error ?? "")}`}`,
  );
}
