/**
 * 域注册表一致性测试（2026-10-01 S0 统一配套）。
 *
 * 三张历史表（lane-tool-sets / resolve-chat-tools 各自的 CAPABILITY_TOOL_PREFIXES
 * 副本 + TOOL_CATEGORIES）已收敛为 domain-registry 单表。本文件锁定两件事：
 *  1. 束投影等价性：域投影结果 ⊇ 旧前缀表结果（media/write/desktop 精确等价；
 *     search 允许且有意识超集 = internet.* 归入检索域）；
 *  2. 覆盖完整性：全量延迟目录工具均有域归属，misc 兜底规模受控（防堆积成垃圾桶）。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  DOMAIN_REGISTRY,
  ROUTE_BEAM_DOMAINS,
  domainDefByName,
  domainsForTool,
  toolInCapabilityDomains,
} = await import("../src/tools/tool-search/tool-category.js");
const { toolsMatchingCapabilityBeam } = await import("../src/external-model/lane-tool-sets.js");
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 旧前缀表（S0 删除前的 lane-tool-sets 原文，等价性基准） */
const LEGACY_PREFIXES: Record<string, string[]> = {
  search: ["search_web", "search", "fetch_web", "deep_search", "hot_rankings", "info.", "weather.", "clock."],
  media: ["search_images", "search_videos", "photo", "vision.", "media", "image"],
  write: [
    "calendar.", "reminder", "voice.", "phone.", "shopping.", "commitment.",
    "wallet.", "agent.", "surface.", "smart_home.",
  ],
  desktop: ["desktop", "agent_browser", "shared_browser", "screen"],
};

const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools()];
const nameOf = (t: ChatCompletionTool): string => (t.type === "function" ? t.function?.name ?? "" : "");

const BRIDGES = new Set(["tool_search", "tool_discover", "tool_describe", "agent.query_capabilities"]);

function legacySet(cap: string): Set<string> {
  const prefixes = LEGACY_PREFIXES[cap] ?? [];
  return new Set(
    corpus.map(nameOf).filter(
      (n) => n && !BRIDGES.has(n) && prefixes.some((p) => n === p || n.startsWith(p)),
    ),
  );
}

test("束投影等价性：域投影 ⊇ 旧前缀表；media/write/desktop 精确等价；search 仅有意识超集 internet.*", () => {
  for (const cap of Object.keys(LEGACY_PREFIXES)) {
    const legacy = legacySet(cap);
    const modern = new Set(toolsMatchingCapabilityBeam(corpus, [cap]).map(nameOf));
    for (const name of legacy) {
      assert.ok(modern.has(name), `${cap} 束丢失旧成员: ${name}`);
    }
    const extra = [...modern].filter((n) => !legacy.has(n));
    // 有意识超集（评审过的增益，锁进测试防漂移）：
    //   search + internet.*（realtime 轮可用情报核实）
    //   write + budget.calculate（钱包域副成员，预算计算属写族）
    //   media + video.grab（2026-10-02 补模型入口：视频链接解析归 media 域，
    //   delegate 束投影与延迟目录按域召回需要它）
    const conscious: Record<string, string[]> = {
      search: ["internet."],
      write: ["budget.calculate"],
      desktop: ["browser.session.list"],
      media: ["video.grab"],
    };
    const allowed = conscious[cap] ?? [];
    const stray = extra.filter((n) => !allowed.some((a) => n === a || n.startsWith(a)));
    assert.deepEqual(stray, [], `${cap} 束超集漂移，多出: ${stray.join(",")}`);
  }
});

test("覆盖完整性：全量工具 ≥1 域归属；misc 兜底 ≤ 8 个", () => {
  const misc: string[] = [];
  for (const tool of corpus) {
    const name = nameOf(tool);
    if (!name) continue;
    const domains = domainsForTool(name);
    assert.ok(domains.length > 0, `${name} 无域归属`);
    if (domains.length === 1 && domains[0] === "misc") misc.push(name);
  }
  assert.ok(misc.length <= 8, `misc 兜底堆积(${misc.length}): ${misc.join(",")}`);
});

test("注册表自洽：域名唯一；束域引用全部存在；misc 无前缀", () => {
  const names = DOMAIN_REGISTRY.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const domains of Object.values(ROUTE_BEAM_DOMAINS)) {
    for (const d of domains) assert.ok(domainDefByName(d), `束引用了不存在的域: ${d}`);
  }
  assert.deepEqual(domainDefByName("misc")?.prefixes ?? [], []);
});

test("确定性：同一工具名多次查询恒同归属（域卡/域拉取的字节稳定性前提）", () => {
  for (const n of ["search_web", "calendar.create_task", "vision.see_device", "unknown.tool.x"]) {
    assert.deepEqual(domainsForTool(n), domainsForTool(n));
  }
});

test("full 束与空束不投影；桥工具无归属", () => {
  assert.deepEqual(toolsMatchingCapabilityBeam(corpus, ["full"]), []);
  assert.deepEqual(toolsMatchingCapabilityBeam(corpus, []), []);
  assert.equal(toolInCapabilityDomains("tool_discover", ["search"]), false);
});

/**
 * 技能族域归属完整性（2026-10-10 根修回归闸）。
 *
 * 断言的语料**必须含技能注册链的工具**——上方各测试用 builtin 语料（束投影口径
 * 需要），而根修对象（技能族域归属）根本不在 builtin 里。这正是历史坑：
 * 「misc ≤ 8」只在 builtin 下成立，技能工具一进来 misc 就 35（picture 全族被域卡
 * 14 上限截掉、按域 tool_discover 返回「未知能力域」、L1 预载整族漏召）。
 * 本测试用真实装配链语料守住「每个技能族都有专属域、misc 不堆积」。
 */
test("技能族域归属完整性（真实装配链语料）：无族落 misc、misc 规模受控", async () => {
  const { SkillManager } = await import("../src/skills/skill-manager.js");
  const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");
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
    const mod: Record<string, unknown> = await import(path);
    const key = Object.keys(mod).find(
      (k) => /^register.*BuiltinSkills$/.test(k) && typeof mod[k] === "function",
    );
    if (!key) continue;
    (mod[key] as (r: (s: unknown) => void, d: unknown) => void)(
      (s: unknown) => sm.register(s as never),
      new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
    );
  }
  const skillTools = sm.list(true).map(skillManifestToChatTool);
  assert.ok(skillTools.length > 0, "技能注册链未产出任何工具（测试语料失真）");

  const families = new Set<string>();
  for (const tool of skillTools) {
    const name = nameOf(tool);
    if (!name) continue;
    families.add(name.split(".")[0]);
    const domains = domainsForTool(name);
    assert.ok(
      !(domains.length === 1 && domains[0] === "misc"),
      `技能工具无专属域（落 misc，能力面对模型不可见）: ${name}`,
    );
  }

  // misc 规模在真实语料下同样受控（历史坑：misc 35 个 → picture 全族被域卡截断）
  const full = [...corpus, ...skillTools];
  const misc: string[] = [];
  for (const tool of full) {
    const name = nameOf(tool);
    if (!name) continue;
    const domains = domainsForTool(name);
    if (domains.length === 1 && domains[0] === "misc") misc.push(name);
  }
  assert.ok(misc.length <= 8, `真实语料下 misc 兜底堆积(${misc.length}): ${misc.join(",")}`);
  assert.ok(families.size >= 6, `技能族过少(${families.size})，覆盖断言失真`);
});
