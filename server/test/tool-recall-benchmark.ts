/**
 * 工具召回五层根修（2026-10-09）：离线可达性基准（before vs after）。
 *
 * 运行：node --import tsx test/tool-recall-benchmark.ts
 * （文件名不带 .test.ts，不进全量回归；放 test/ 目录避 tsx watch 重启）
 *
 * 指标：意图工具「免 discover 直达率」——期望工具出现在组装出的本轮可见集中。
 *   before = AGENT_TOOL_RECALL=off（静态 Core 白名单，等价五层根修前）
 *   after  = Core ∪ 域预载(L1) ∪ top-K 兜底(L1) ∪ 晋升常驻(L4)
 *
 * 语料口径：getBuiltinAgentChatTools()（测试环境全量 builtin）+ media-music
 * 能力模块 + memory-governance 能力模块（测试环境 _capabilityModuleDeps 为 null
 * 需手动并入）+ travel 技能族（bootstrap 注册链同源构造，同
 * chat-lane-domain-preload.test.ts 口径）。
 * 生产语料还会多出少量技能注册工具，此处取的是保守下界。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";
// 基准进程退出 flush 会把模拟 actor 计数写进生产状态文件，持久化置 off
process.env.AGENT_TOOL_PROMOTION_STATE_PATH = "off";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  buildDomainPreloadTools,
  buildLaneCoreTools,
  CHAT_LANE_CORE_NAMES,
} = await import("../src/external-model/lane-tool-sets.js");
const {
  recordToolUsageForPromotion,
  getPromotedToolNames,
  resetToolPromotionState,
} = await import("../src/tools/tool-search/tool-promotion.js");
const { MEDIA_MUSIC_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/media-music/chat-tools.js"
);
const { MEMORY_GOVERNANCE_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/memory-governance/chat-tools.js"
);
const { topToolMatchesForQuery } = await import("../src/tools/tool-search/index.js");

function fn(name: string, description: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}

/** 生产语料 + media-music + memory-governance + travel 技能族（bootstrap 注册链同源构造，描述取生产原文） */
const corpus: ChatCompletionTool[] = [
  ...getBuiltinAgentChatTools(),
  ...MEDIA_MUSIC_CHAT_TOOLS,
  ...MEMORY_GOVERNANCE_CHAT_TOOLS,
];
const TRAVEL_DESCRIPTIONS: Record<string, string> = {
  "travel.plan-itinerary":
    "生成旅游行程规划：根据用户的目的地、天数与偏好生成完整结构化行程，按天拆分景点/酒店/餐厅，含时间安排、交通衔接、建议游览时长、小贴士、预订提示与价格汇总。" +
    "凡回复要给出具体行程安排（按天/按时段列景点、交通、餐厅的表格或清单），必须先调用本工具生成行程卡。触发表达包括「帮我规划去X的行程」「去X玩几天怎么安排」「X旅游攻略」「X自由行」「周末附近游玩」。",
  "travel.search-poi":
    "搜索目的地景点/酒店/餐厅：搜索指定目的地的景点、酒店、餐厅三类 POI（含名称/评分/地址/坐标）。当用户想了解「X 有什么好玩的/好吃的/住的」或在规划前查看目的地的 POI 候选时调用。",
  "travel.destination-info":
    "目的地实用信息：查询目的地的签证、货币、时差、插座、小费习惯、最佳旅行季节等实用信息。用户问「去X要注意什么」「X签证好办吗」时调用。",
  "travel.compute-route":
    "路线计算：计算两地之间的交通方式与耗时（驾车/高铁/飞行），规划去某地怎么走、多少公里时调用。",
  "travel.get-itinerary":
    "读取已生成的行程：按天返回行程明细（景点/酒店/餐厅与时间安排），用户想回看行程、看某天细节时调用。",
  "travel.edit-itinerary":
    "编辑已有行程：向行程中添加/删除/替换条目（景点/酒店/餐厅）或修改时间字段，用户说「把博物馆换成海底捞」「下午加个咖啡厅」时调用。",
};
for (const [n, description] of Object.entries(TRAVEL_DESCRIPTIONS)) {
  corpus.push(fn(n, description));
}

const corpusNames = new Set(
  corpus.map((t) => (t.type === "function" ? t.function?.name ?? "" : "")).filter(Boolean),
);

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? t.function?.name ?? "" : "";
}

/** 组装 chat 车道本轮可见集（与 agent-core buildChatLaneExplicitOpts 同构） */
function chatVisibleNames(query: string, promoted: string[] = []): Set<string> {
  const core = buildLaneCoreTools("chat", corpus);
  const coreNames = new Set(core.map(toolName).filter(Boolean));
  const preload = buildDomainPreloadTools(query, corpus, coreNames);
  const names = new Set([...coreNames, ...preload.map(toolName)]);
  for (const p of promoted) {
    if (corpusNames.has(p)) names.add(p);
  }
  return names;
}

interface Case {
  domain: string;
  query: string;
  expected: string[];
  /** true = 噪声对照组（期望预载为空） */
  noise?: boolean;
}

/** 31 条跨域基准：5 条 Core 锚点 + 21 条延迟域 + 1 条多意图 + 4 条噪声对照 */
const CASES: Case[] = [
  // ── Core 常驻锚点（before 也应过；回归保险丝） ──
  { domain: "weather", query: "遵义今天天气怎么样", expected: ["weather.get_local"] },
  { domain: "profile", query: "帮我记一下，我女儿叫小雨今年三岁", expected: ["profile.update"] },
  { domain: "reminder", query: "明早八点提醒我交周报", expected: ["reminder.plan"] },
  { domain: "search", query: "搜一下4090显卡评测", expected: ["search_web"] },
  // ── 延迟目录域（根因面：before 须 discover 才能到手） ──
  { domain: "travel", query: "帮我规划一个周末去兴义玩的行程", expected: ["travel.plan-itinerary"] },
  { domain: "travel", query: "十一去北京玩有什么攻略故宫门票好买吗", expected: ["travel.plan-itinerary", "travel.search-poi", "travel.destination-info"] },
  { domain: "smart_home", query: "把客厅的灯打开", expected: ["smart_home"] },
  { domain: "smart_home", query: "空调调到二十六度", expected: ["smart_home"] },
  { domain: "smart_home", query: "帮我打开回家模式", expected: ["smart_home"] },
  { domain: "media", query: "放一首周杰伦的晴天", expected: ["media.play"] },
  { domain: "media", query: "音乐暂停一下", expected: ["media.pause"] },
  { domain: "voice", query: "用语音给老板发条消息说方案已发", expected: ["voice.send_message"] },
  { domain: "voice", query: "把这段话念出来", expected: ["voice.speak"] },
  { domain: "phone", query: "给张三打个电话", expected: ["phone.dial"] },
  { domain: "phone", query: "看看我手机还有多少电", expected: ["phone.battery"] },
  { domain: "budget", query: "这个月餐饮预算还剩多少", expected: ["budget.calculate"] },
  { domain: "shopping", query: "双十一买什么耳机性价比高帮我看看", expected: ["shopping.suggest"] },
  { domain: "commitment", query: "记一下我答应了下周三前把报告交了", expected: ["commitment.create"] },
  { domain: "geofence", query: "到家的时候提醒我拿快递", expected: ["geofence"] },
  { domain: "care", query: "我妈生日是哪天来着", expected: ["care.get_important_dates"] },
  { domain: "interest", query: "帮我一直盯着这个话题有新消息就告诉我", expected: ["interest.manage"] },
  { domain: "embodiment", query: "让化身走到屏幕左边去", expected: ["embodiment.move"] },
  { domain: "desktop", query: "帮我打开Steam", expected: ["desktop.open"] },
  // ── 多意图（子句切分域多数票） ──
  { domain: "travel+weather", query: "帮我规划去成都的行程，顺便看下那边天气", expected: ["travel.plan-itinerary"] },
  // ── 噪声对照组（after 预载必须为空） ──
  { domain: "noise", query: "嗯嗯好的", expected: [], noise: true },
  { domain: "noise", query: "哈哈哈哈哈哈", expected: [], noise: true },
  { domain: "noise", query: "谢谢啦", expected: [], noise: true },
  { domain: "noise", query: "然后呢", expected: [], noise: true },
];

// ── before：AGENT_TOOL_RECALL=off（预载/晋升全关） ──
process.env.AGENT_TOOL_RECALL = "off";
const beforeCoreNames = new Set(buildLaneCoreTools("chat", corpus).map(toolName).filter(Boolean));

// ── after：恢复默认（on） ──
delete process.env.AGENT_TOOL_RECALL;

interface RowResult {
  c: Case;
  inCorpus: boolean;
  before: boolean;
  after: boolean;
  afterPreload: string[];
}

const rows: RowResult[] = [];
for (const c of CASES) {
  const inCorpus = c.noise || c.expected.some((n) => corpusNames.has(n));
  const afterVisible = chatVisibleNames(c.query);
  const preload = buildDomainPreloadTools(c.query, corpus, beforeCoreNames);
  rows.push({
    c,
    inCorpus,
    before: c.expected.some((n) => beforeCoreNames.has(n)),
    after: c.noise ? preload.length === 0 : c.expected.some((n) => afterVisible.has(n)),
    afterPreload: preload.map(toolName),
  });
}

const intent = rows.filter((r) => !r.c.noise && r.inCorpus);
const noise = rows.filter((r) => r.c.noise);
const beforeHit = intent.filter((r) => r.before).length;
const afterHit = intent.filter((r) => r.after).length;
const noiseFalsePositive = noise.filter((r) => !r.after).length;

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${(n / d * 100).toFixed(1)}%`);

console.log("=== 工具召回五层根修 · 离线可达性基准 ===");
console.log(`语料: ${corpus.length} 工具（builtin + media-music + memory-governance + travel 族；生产语料为保守下界）`);
console.log(`A/B: before = AGENT_TOOL_RECALL=off（静态 Core 白名单）; after = Core ∪ 域预载 ∪ top-K 兜底 ∪ 晋升常驻`);
console.log(`chat Core 解析: ${beforeCoreNames.size}/${CHAT_LANE_CORE_NAMES.length}（brain.recall 由 bootstrap 注入，测试环境缺省属正常）`);
console.log("");

console.log("## chat 车道 · 意图工具直达率（免 discover 到手）");
console.log(`| 域 | query | 期望工具 | before | after | after 实际预载 |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of intent) {
  const exp = r.c.expected.filter((n) => corpusNames.has(n)).join("/");
  const mark = (b: boolean) => (b ? "✓" : "✗");
  console.log(`| ${r.c.domain} | ${r.c.query} | ${exp} | ${mark(r.before)} | ${mark(r.after)} | ${r.afterPreload.join(",") || "∅"} |`);
}
console.log("");
console.log(`**总计: before ${beforeHit}/${intent.length}（${pct(beforeHit, intent.length)}） → after ${afterHit}/${intent.length}（${pct(afterHit, intent.length)}）**`);
console.log("");

const afterMiss = intent.filter((r) => !r.after);
if (afterMiss.length > 0) {
  console.log("## after 未命中明细（校准线索）");
  for (const r of afterMiss) {
    console.log(`- [${r.c.domain}] "${r.c.query}" → 期望 ${r.c.expected.join("/")}，实际预载: ${r.afterPreload.join(",") || "∅"}`);
  }
  console.log("");
}

console.log("## 噪声对照组（误注率，越低越好）");
for (const r of noise) {
  console.log(`- "${r.c.query}" → 预载 ${r.afterPreload.length > 0 ? r.afterPreload.join(",") + "（误注!）" : "∅ ✓"}`);
}
console.log(`**噪声误注率: ${noiseFalsePositive}/${noise.length}**`);
console.log("");

// ── L4 晋升：actor 常驻化演示 ──
console.log("## L4 晋升闭环（近窗成功 ≥3 次 → 常驻可见）");
resetToolPromotionState();
const ACTOR = "bench-actor";
for (let i = 0; i < 3; i++) recordToolUsageForPromotion(ACTOR, "media.play", true);
const promoted = getPromotedToolNames(ACTOR);
{
  const q = "帮我看看手机还有多少电";
  process.env.AGENT_TOOL_RECALL = "off";
  const beforeVisible = chatVisibleNames(q);
  delete process.env.AGENT_TOOL_RECALL;
  const afterVisible = chatVisibleNames(q, promoted);
  console.log(`- 模拟 actor 成功调用 media.play ×3 → 晋升名单: [${promoted.join(",")}]`);
  console.log(`- 无关 query "${q}"：before 含 media.play=${beforeVisible.has("media.play")} → after 含 media.play=${afterVisible.has("media.play")}`);
}
resetToolPromotionState();
console.log("");

// ── L3 错误即检索：幻觉名候选 ──
console.log("## L3 调用即发现（未知名 → 结构化错误 + BM25 top-3 候选）");
{
  const sugg = topToolMatchesForQuery("travel plan itinerary", corpus, 3, beforeCoreNames, { minScore: 0 });
  console.log(`- 模型直呼未知名 "travel plan itinerary" → 候选: ${sugg.map((s) => `${s.name}(${s.score})`).join(", ")}`);
}
console.log("");

// ── task 车道（router-first：可见集 = 轻量常驻 ∪ 预载，before = 纯桥） ──
console.log("## task 车道（router-first）· 意图工具直达率");
{
  const {
    buildTaskLaneRouterFirstLightTools,
  } = await import("../src/external-model/lane-tool-sets.js");
  const light = buildTaskLaneRouterFirstLightTools(corpus);
  const lightNames = new Set(light.map(toolName).filter(Boolean));
  // before（recall off）：router-first 可见集只剩桥+轻量常驻，业务工具 0 直达
  //（存量「意图预召回/请求卡」投机通道不在本离线口径内，此处为保守下界）
  const taskBefore = 0;
  let taskAfter = 0;
  const taskMiss: string[] = [];
  for (const r of intent) {
    const preload = buildDomainPreloadTools(r.c.query, corpus, lightNames).map(toolName);
    const visible = new Set([...lightNames, ...preload]);
    if (r.c.expected.some((n) => visible.has(n))) taskAfter++;
    else taskMiss.push(`- [${r.c.domain}] "${r.c.query}" → 期望 ${r.c.expected.join("/")}，预载: ${preload.join(",") || "∅"}`);
  }
  console.log(`轻量常驻: ${[...lightNames].join(", ")}`);
  console.log(`**总计: before ${taskBefore}/${intent.length}（${pct(taskBefore, intent.length)}，仅桥工具须两波 discover） → after ${taskAfter}/${intent.length}（${pct(taskAfter, intent.length)}，意图预载直转正）**`);
  if (taskMiss.length > 0) {
    console.log("未命中明细：");
    for (const m of taskMiss) console.log(m);
  }
}
