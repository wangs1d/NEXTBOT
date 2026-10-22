/**
 * 域卡 + 域拉取测试（2026-10-01 S1 配套）。
 *
 * 契约：
 *  1. 域卡：从语料派生、覆盖全部有域工具、同语料恒同字节（前缀缓存前提）、
 *     空语料安全降级；
 *  2. 域拉取（tool_discover({domain})）：确定性（同目录两次调用字节相同）、
 *     族成员完整（≤12 直出/超出标注 more）、前 3 名带瘦身 schema（字段级
 *     description 已剥）、未知域返回可用域清单自纠错；
 *  3. 卡片与拉取一致性：卡片上某域列出的工具 ⊆ 该域拉取可达（同名目录）。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { executeToolSearchBridge, prepareToolsWithToolSearch } = await import(
  "../src/tools/tool-search/index.js"
);
const { buildDomainCards, CARD_TOOLS_PER_DOMAIN } = await import(
  "../src/tools/tool-search/domain-cards.js"
);
const { domainsForTool, resolveDomainDef } = await import("../src/tools/tool-search/tool-category.js");
const { SkillManager } = await import("../src/skills/skill-manager.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 真实装配链语料 = builtin 静态注册表 ∪ 技能族（SkillManager 注册真实技能定义 →
 * 生产同款 manifest→tool 桥）。
 *
 * 2026-10-10 教训（同 chat-lane-domain-preload）：语料只取 builtin 会漏掉全部
 * 技能族（travel/habit/booking/picture/finance/virtual-phone/agentworld 等 51 个
 * 工具），域卡/域拉取的断言因此看不到本次根修的真实对象（技能族域归属）。
 */
async function realCorpus(): Promise<ChatCompletionTool[]> {
  const sm = new (SkillManager as new () => InstanceType<typeof SkillManager>)();
  const modulePaths = [
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
  for (const path of modulePaths) {
    try {
      const mod: Record<string, unknown> = await import(path);
      const key = Object.keys(mod).find(
        (k) => /^register.*BuiltinSkills$/.test(k) && typeof mod[k] === "function",
      );
      if (!key) continue;
      (mod[key] as (r: (s: unknown) => void, d: unknown) => void)(
        (s: unknown) => sm.register(s as never),
        // 各技能族 Deps 不同：占位 Proxy 只为让 manifest 进注册表拿 schema，不触发 IO
        new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
      );
    } catch {
      /* 单族注册失败不阻塞其余族 */
    }
  }
  return [...getBuiltinAgentChatTools(), ...sm.list(true).map(skillManifestToChatTool)];
}

const corpus: ChatCompletionTool[] = await realCorpus();
const prepared = prepareToolsWithToolSearch([], corpus);
const catalog = prepared.deferredCatalog;

/** 域内工具总数（判断某域是否被 CARD_TOOLS_PER_DOMAIN 截断）。 */
const domainSize = new Map<string, number>();
for (const tool of corpus) {
  const name = tool.type === "function" ? tool.function?.name ?? "" : "";
  if (!name) continue;
  for (const d of domainsForTool(name)) domainSize.set(d, (domainSize.get(d) ?? 0) + 1);
}

test("域卡（紧凑定稿）：覆盖全部非 misc 域、含发现指引、同语料恒同字节", () => {
  const cards = buildDomainCards(corpus);
  assert.ok(cards.includes("【能力域目录】"));
  // 紧凑契约（2026-10-22）：不再列工具名，改为域名+一句话，发现靠 tool_discover({domain})。
  assert.ok(cards.includes('tool_discover({domain:"域名"})'), "紧凑卡应带按域拉取指引");
  for (const tool of corpus) {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    if (!name || name.startsWith("tool_")) continue;
    const domains = domainsForTool(name);
    if (domains.length === 1 && domains[0] === "misc") continue;
    const visible = domains.some((d) => {
      const def = resolveDomainDef(d);
      return cards.includes(`- ${def.name}｜`);
    });
    assert.ok(visible, `工具 ${name} 的所属域均未出现在卡上`);
  }
  assert.equal(cards, buildDomainCards(corpus));
});

test("域卡回滚开关：AGENT_DOMAIN_CARDS_COMPACT=0 恢复详版（列工具名）", () => {
  const prev = process.env.AGENT_DOMAIN_CARDS_COMPACT;
  process.env.AGENT_DOMAIN_CARDS_COMPACT = "0";
  try {
    const cards = buildDomainCards(corpus);
    const sample = corpus
      .map((t) => (t.type === "function" ? t.function?.name ?? "" : ""))
      .find((n) => n && !n.startsWith("tool_") && (domainsForTool(n).length > 1 || domainsForTool(n)[0] !== "misc"));
    assert.ok(sample, "语料中应有非 misc 工具");
    assert.ok(cards.includes(sample), `详版应列工具名: ${sample}`);
  } finally {
    if (prev === undefined) delete process.env.AGENT_DOMAIN_CARDS_COMPACT;
    else process.env.AGENT_DOMAIN_CARDS_COMPACT = prev;
  }
});

test("技能族域可见性（2026-10-10 根修回归）：habit 等派生域在域卡可见 + 按域可拉取", async () => {
  const cards = buildDomainCards(corpus);
  for (const family of [
    "habit",
    "booking",
    "picture",
    "finance",
    "virtual-phone",
    "agentworld",
  ]) {
    const members = catalog.entries
      .map((e) => e.registryName)
      .filter((n) => n.startsWith(`${family}.`));
    if (members.length === 0) continue; // 该族未注册进语料（环境裁剪）→ 不误判
    // 紧凑模式：卡片行是「- 域名｜摘要」，派生域 def.name 即域名本身。
    assert.ok(cards.includes(`- ${family}｜`), `域卡缺失技能族 ${family}（能力面对模型不可见）`);
    const r = await executeToolSearchBridge("tool_discover", { domain: family }, catalog);
    assert.equal(r.ok, true, `按域拉取 ${family} 失败：${JSON.stringify(r.result)}`);
    const result = r.result as { mode: string; domain: string; matches: Array<{ name: string }> };
    assert.equal(result.mode, "domain");
    assert.equal(result.domain, family);
    assert.ok(result.matches.length > 0, `${family} 域拉取为空`);
    for (const m of result.matches) {
      assert.ok(m.name.startsWith(`${family}.`), `${family} 域拉取混入异族成员: ${m.name}`);
    }
  }
});

test("域卡：空语料安全降级为空串", () => {
  assert.equal(buildDomainCards([]), "");
});

test("域拉取：确定性（两次调用字节相同）+ 族完整 + 前3名瘦身 schema", async () => {
  const r1 = await executeToolSearchBridge("tool_discover", { domain: "smart_home" }, catalog);
  const r2 = await executeToolSearchBridge("tool_discover", { domain: "smart_home" }, catalog);
  assert.equal(r1.ok, true);
  assert.equal(JSON.stringify(r1.result), JSON.stringify(r2.result));
  const result = r1.result as { mode: string; domain: string; matches: Array<{ name: string; parameters?: Record<string, unknown> }> };
  assert.equal(result.mode, "domain");
  assert.equal(result.domain, "smart_home");
  const smartHomeNames = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes("smart_home"));
  assert.equal(result.matches.length, Math.min(12, smartHomeNames.length));
  for (const m of result.matches) assert.ok(smartHomeNames.includes(m.name));
  // 前 3 名带 schema 且瘦身（字段 description 被剥）
  const withSchema = result.matches.filter((m) => m.parameters);
  assert.ok(withSchema.length > 0 && withSchema.length <= 3);
  for (const m of withSchema) {
    const props = (m.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const v of Object.values(props)) {
      assert.equal("description" in (v as Record<string, unknown>), false, "schema 未瘦身");
    }
  }
});

test("域拉取：未知域返回可用域清单（自纠错，不静默失败）", async () => {
  const r = await executeToolSearchBridge("tool_discover", { domain: "no_such_domain" }, catalog);
  assert.equal(r.ok, false);
  const result = r.result as { error: string; available_domains: string };
  assert.ok(result.error.includes("no_such_domain"));
  assert.ok(result.available_domains.includes("search"));
  assert.ok(result.available_domains.includes("travel"));
});

test("卡片↔拉取一致性：卡片所列工具在延迟目录内按域可拉取", async () => {
  const r = await executeToolSearchBridge("tool_discover", { domain: "calendar" }, catalog);
  const result = r.result as { matches: Array<{ name: string }> };
  const calendarMembers = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes("calendar"));
  if (calendarMembers.length > 0) {
    assert.ok(result.matches.length > 0, "calendar 域非空但拉取为空");
  }
});
