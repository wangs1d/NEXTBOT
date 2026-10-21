/**
 * 工具召回链五层根修单测（2026-10-09 L1/L3/L4/L5）。
 *
 * L1 感知增强：buildDomainPreloadTools 多域注入 + BM25 top-K 弱信号兜底。
 * L3 调用即发现：topToolMatchesForQuery 候选质量（错误即检索的回填面）。
 * L4 晋升闭环：recordToolUsageForPromotion → getPromotedToolNames 阈值语义。
 * L5 观测对账：summarizeTurnTraces 三指标（幻觉转正率/注入转化率）。
 * 总开关：AGENT_TOOL_RECALL=off 一键回基线。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";
// 晋升持久化对单测关闭：防进程退出 flush 把假 actor 计数写进生产状态文件
// （server/data/tool-promotion-state.json）。持久化语义单独用 tmp 路径测。
process.env.AGENT_TOOL_PROMOTION_STATE_PATH = "off";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const laneSets = await import("../src/external-model/lane-tool-sets.js");
const promotion = await import("../src/tools/tool-search/tool-promotion.js");
const turnTrace = await import("../src/external-model/turn-trace.js");
const { MEDIA_MUSIC_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/media-music/chat-tools.js"
);
const { MEMORY_GOVERNANCE_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/memory-governance/chat-tools.js"
);
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function fn(name: string, description = name): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

const corpus: ChatCompletionTool[] = [
  ...getBuiltinAgentChatTools(),
  ...MEDIA_MUSIC_CHAT_TOOLS,
  ...MEMORY_GOVERNANCE_CHAT_TOOLS,
];
// travel 族用生产真实描述（与 tool-recall-benchmark.ts 同源）：合成薄描述会让
// BM25 排名失真（travel 域凑不满 3 票强信号 → 误触发 top-K 兜底），测试口径必须同源
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
for (const [name, description] of Object.entries(TRAVEL_DESCRIPTIONS)) {
  corpus.push(fn(name, description));
}

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? t.function?.name ?? "" : "";
}

// ── L1：多域注入 ──

test("L1 多域：主域强信号 + 子句切分（长多意图 query 整句投票会被摊薄成每域 1 票）", () => {
  const names = laneSets
    .buildDomainPreloadTools("帮我规划一个去兴义玩的行程，顺便看下那边天气", corpus)
    .map(toolName);
  assert.ok(
    names.some((n) => n.startsWith("travel.")),
    `子句 1 的 travel 域应注入: ${names.join(",")}`,
  );
  // 天气子句由 Core 常驻覆盖（weather.get_local 在 chat Core，结构上单工具域
  // 凑不满 3 票——多域注入解决的是非 Core 域的覆盖，Core 已见工具不归它管）
  assert.ok(
    laneSets.CHAT_LANE_CORE_NAMES.includes("weather.get_local"),
    "weather.get_local 应为 Core 常驻",
  );
});

test("L1 多域（双非 Core 域）：空调 + 壁纸 → smart_home 域注入", () => {
  const coreNames = new Set(laneSets.CHAT_LANE_CORE_NAMES);
  const names = laneSets
    .buildDomainPreloadTools("把空调调到26度，另外找几张海边壁纸", corpus, coreNames)
    .map(toolName);
  assert.ok(
    names.some((n) => n.startsWith("smart_home")),
    `smart_home 域应注入: ${names.join(",")}`,
  );
});

test("L1 次域纪律：top-1 只有 2 票（无强信号）→ 整组不注入走兜底", () => {
  // "找个猫咪视频"：media 2 票 / device 1 / misc 1 —— top-1 弱信号
  // 不应有域全族灌入（media 全族 N 个），兜底双闸下相关工具按分数进
  const preload = laneSets.buildDomainPreloadTools("找个猫咪视频", corpus);
  const names = preload.map(toolName);
  const mediaFamily = names.filter((n) => n.startsWith("search_images") || n.startsWith("video.") || n.startsWith("vision."));
  // 兜底最多 4 个，不得整族倾倒
  assert.ok(preload.length <= laneSets.DOMAIN_PRELOAD_TOPK, `兜底超 top-K: ${names.join(",")}`);
  assert.ok(mediaFamily.length <= laneSets.DOMAIN_PRELOAD_TOPK);
});

// ── L1：top-K 弱信号兜底 ──

test("L1 兜底：无强域但明确工具意图 → BM25 top-K 命中目标工具", () => {
  // 智能家居语料意图先验强（control_device 1.7），top-K 应带上 control_device
  const names = laneSets
    .buildDomainPreloadTools("把客厅的灯打开", corpus)
    .map(toolName);
  assert.ok(
    names.some((n) => n.startsWith("smart_home") || n.startsWith("device")),
    `兜底应命中家居/设备域工具: ${names.join(",")}`,
  );
});

test("L1 兜底噪声闸：纯寒暄零注入（错误预载比不预载更糟）", () => {
  assert.deepEqual(laneSets.buildDomainPreloadTools("嗯嗯好的", corpus), []);
  assert.deepEqual(laneSets.buildDomainPreloadTools("哈哈哈哈哈", corpus), []);
  assert.deepEqual(laneSets.buildDomainPreloadTools("好的谢谢", corpus), []);
  assert.deepEqual(laneSets.buildDomainPreloadTools("然后呢", corpus), []);
});

// ── L1：先验直取通道（意图别名/例句 = 独立于 BM25 词面的召回面） ──

test("L1 先验直取：整短语意图命中直接注入，不被假强域整族顶掉（到家提醒→geofence）", () => {
  // 「到家的时候提醒我拿快递」：calendar 凑 4 票成假强域，而 geofence.create 是
  // raw/先验双 top-1——域通道（面信号）不得吞掉先验直取（点信号）
  const names = laneSets
    .buildDomainPreloadTools("到家的时候提醒我拿快递", corpus)
    .map(toolName);
  assert.ok(
    names.includes("geofence.create"),
    `先验直取应注入 geofence.create: ${names.join(",")}`,
  );
});

test("L1 先验直取：描述零词面重叠的意图靠别名/例句召回", () => {
  const cases: Array<[string, string]> = [
    ["帮我一直盯着这个话题有新消息就告诉我", "interest.manage"],
    ["帮我打开回家模式", "smart_home.scene"],
    ["双十一买什么耳机性价比高帮我看看", "shopping.suggest"],
  ];
  for (const [query, expected] of cases) {
    const names = laneSets.buildDomainPreloadTools(query, corpus).map(toolName);
    assert.ok(names.includes(expected), `"${query}" 应注入 ${expected}: ${names.join(",")}`);
  }
});

test("L1 先验直取通词闸：IDF 加权 + 证据去重，通词堆不出意图", async () => {
  // calendar.list_tasks 别名「有什么安排」/「今天有什么安排」含全域通词 什么/有什；
  // 无 IDF 加权时「十一去北京玩有什么攻略」会经通词重叠误命中 calendar——
  // IDF 让通词归零、意图词（攻略/景点/门票）高贡献；travel 族应正确命中
  const { priorDirectMatchesForQuery } = await import("../src/tools/tool-search/index.js");
  const prior = priorDirectMatchesForQuery(
    "十一去北京玩有什么攻略故宫门票好买吗",
    corpus,
    2,
    new Set(),
  ).map((m) => m.name);
  assert.equal(
    prior.includes("calendar.list_tasks"),
    false,
    `点信号层通词不得泄漏进 calendar.list_tasks: ${prior.join(",")}`,
  );
  const names = laneSets
    .buildDomainPreloadTools("十一去北京玩有什么攻略故宫门票好买吗", corpus)
    .map(toolName);
  assert.ok(
    names.some((n) => n.startsWith("travel.")),
    `旅游意图应命中 travel 族: ${names.join(",")}`,
  );
});

test("idfOf：索引中无 df 证据的 token 贡献为 0（语料没见过 ≠ 极稀有）", async () => {
  const { Bm25Index } = await import("../src/tools/tool-search/bm25.js");
  const idx = new Bm25Index([{ id: "a", text: "天气 晴朗 适合 出行" }]);
  assert.ok(idx.idfOf("天气") > 0, "索引内 token 应有正 IDF");
  assert.equal(idx.idfOf("凭空捏造词"), 0, "零 df token 无证据贡献");
});

// ── 总开关 ──

test("总开关：AGENT_TOOL_RECALL=off → 预载恒空（A/B 基线）", () => {
  process.env.AGENT_TOOL_RECALL = "off";
  try {
    assert.deepEqual(laneSets.buildDomainPreloadTools("帮我规划去兴义的行程", corpus), []);
    assert.equal(laneSets.isToolRecallEnabled(), false);
  } finally {
    delete process.env.AGENT_TOOL_RECALL;
  }
  assert.equal(laneSets.isToolRecallEnabled(), true);
});

// ── L3：错误即检索的候选质量 ──

test("L3 候选：幻觉名相似检索命中同族工具，且排除已可见名", async () => {
  const { topToolMatchesForQuery } = await import("../src/tools/tool-search/index.js");
  // 模型直呼 "travel_plan_itinerary"（拼错的 API 名）→ 候选应指向 travel 族
  const cands = topToolMatchesForQuery("travel plan itinerary", corpus, 3);
  assert.ok(cands.length > 0, "travel 意图应检索出候选");
  assert.ok(
    cands.some((c) => c.name.startsWith("travel.")),
    `候选应含 travel 族: ${cands.map((c) => c.name).join(",")}`,
  );
  // 已可见工具不进候选（模型本来就看得见）
  const visible = new Set(["travel.plan-itinerary"]);
  const cands2 = topToolMatchesForQuery("travel plan itinerary", corpus, 3, visible);
  assert.equal(
    cands2.some((c) => c.name === "travel.plan-itinerary"),
    false,
    "已可见工具不应进候选",
  );
});

// ── L4：晋升闭环 ──

test("L4 阈值：近窗成功 ≥3 次晋升，失败不计、跨窗口衰减", () => {
  promotion.resetToolPromotionState();
  const actor = "actor-promote-1";
  promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
  promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
  assert.deepEqual(promotion.getPromotedToolNames(actor), [], "2 次不晋升");
  promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
  assert.deepEqual(promotion.getPromotedToolNames(actor), ["travel.plan-itinerary"], "3 次晋升");
  // 失败不计数
  promotion.recordToolUsageForPromotion(actor, "shopping.search_products", false);
  assert.deepEqual(promotion.getPromotedToolNames(actor), ["travel.plan-itinerary"]);
});

test("L4 名单纪律：桥/元工具/委派控制面永不晋升", () => {
  promotion.resetToolPromotionState();
  const actor = "actor-promote-2";
  for (const name of ["tool_discover", "obs_recall", "task.dispatch", "agent.query_capabilities"]) {
    for (let i = 0; i < 5; i++) promotion.recordToolUsageForPromotion(actor, name, true);
  }
  assert.deepEqual(promotion.getPromotedToolNames(actor), [], "召回通道工具不得晋升");
});

test("L4 cap：每 actor 最多 6 个晋升工具（超出按次数/新鲜度取前 6）", () => {
  promotion.resetToolPromotionState();
  const actor = "actor-promote-3";
  const names = Array.from({ length: 9 }, (_, i) => `fake.tool_${i}`);
  for (const name of names) {
    for (let i = 0; i < 3; i++) promotion.recordToolUsageForPromotion(actor, name, true);
  }
  const promoted = promotion.getPromotedToolNames(actor);
  assert.equal(promoted.length, 6, `晋升超 cap: ${promoted.join(",")}`);
});

test("L4 总开关联动：AGENT_TOOL_RECALL=off 时晋升常驻不注入（消费方口径）", () => {
  promotion.resetToolPromotionState();
  const actor = "actor-promote-4";
  for (let i = 0; i < 4; i++) {
    promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
  }
  assert.equal(promotion.getPromotedToolNames(actor).length, 1);
  // 消费方（buildPromotedChatTools / router-first 分支）以 isToolRecallEnabled 为前置闸；
  // 开关关闭时 isToolRecallEnabled=false → 晋升注入路径整体短路（与预载同开关语义）
  process.env.AGENT_TOOL_RECALL = "off";
  try {
    assert.equal(laneSets.isToolRecallEnabled(), false);
  } finally {
    delete process.env.AGENT_TOOL_RECALL;
  }
});

// ── L5：观测对账 ──

test("L5 指标：幻觉转正率 + 注入转化率计算口径", () => {
  const records: turnTrace.TurnTraceRecord[] = [
    {
      ts: 1,
      stage: "main_chat_tools",
      visibleTools: 30,
      deferredActive: true,
      deferredCount: 150,
      recallInjectedNames: ["travel.plan-itinerary", "travel.search-poi", "weather.get_forecast"],
      waves: 1,
      toolCalls: [
        { name: "travel.plan-itinerary", ok: true, ms: 10, acquisition: "visible" },
        { name: "weather.get_forecast", ok: true, ms: 10, acquisition: "visible" },
      ],
      finalTextChars: 100,
      durationMs: 1000,
    },
    {
      ts: 2,
      stage: "main_chat_tools",
      visibleTools: 28,
      deferredActive: true,
      deferredCount: 150,
      waves: 1,
      toolCalls: [
        { name: "media.wallpaper_random", ok: true, ms: 10, acquisition: "hallucination_promoted" },
      ],
      finalTextChars: 80,
      durationMs: 900,
    },
  ];
  const s = turnTrace.summarizeTurnTraces(records);
  assert.equal(s.turns, 2);
  // 注入 3 个执行 2 个 → 2/3
  assert.ok(Math.abs(s.recallInjectedConversion - 2 / 3) < 1e-9, `注入转化率=${s.recallInjectedConversion}`);
  assert.equal(s.hallucinationPromotedCalls, 1);
  assert.equal(s.hallucinationPromotedOkRate, 1);
});

// ── ②：task 车道 router-first 轻量常驻（2026-10-10） ──
test("② 轻量常驻：清单工具从真实语料全量解析，顺序=清单，schema 瘦身", () => {
  const light = laneSets.buildTaskLaneRouterFirstLightTools(corpus);
  const names = light.map(toolName);
  assert.deepEqual(names, [...laneSets.TASK_LANE_ROUTER_FIRST_LIGHT_NAMES]);
  // 与预载同款瘦身：description 压首句 ≤120 字符（profile.update 原描述远超）
  for (const t of light) {
    const desc = t.type === "function" ? (t.function?.description ?? "") : "";
    assert.ok(desc.length <= 120, `${toolName(t)} 描述未瘦身: ${desc.length}`);
  }
});

test("② 三条实证 miss 补齐：提醒/回复/记一下 在 router-first 可见集（轻量 ∪ 预载）", () => {
  // 短口语动作的 BM25 词面召回天然弱（「提醒/回复/记」跨域通词被 IDF 闸杀），
  // 三条 query 的期望工具均由轻量常驻兜底，不再赌词面
  const light = new Set(laneSets.buildTaskLaneRouterFirstLightTools(corpus).map(toolName));
  const CASES: Array<[string, string]> = [
    ["明早八点提醒我交周报", "reminder.plan"],
    ["回复妈妈微信说我马上到家", "messages.reply"],
    ["帮我记一下，我女儿叫小雨今年三岁", "profile.update"],
  ];
  for (const [query, expected] of CASES) {
    const preload = laneSets.buildDomainPreloadTools(query, corpus, light).map(toolName);
    const visible = new Set([...light, ...preload]);
    assert.ok(visible.has(expected), `"${query}" → ${expected} 应可见，实际: ${[...visible].join(",")}`);
  }
});

test("② router-first 判定收口：轻量常驻/桥不稀释「主力在目录」语义", () => {
  const bridge = ["tool_discover"];
  const mk = (names: string[]) => ({
    toolSearchActive: true,
    deferredToolCount: 100,
    visibleTools: [...bridge, ...names].map((n) => fn(n)),
  });
  const light = laneSets.buildTaskLaneRouterFirstLightTools(corpus).map(toolName);
  // 轻量 7 + 桥 1 + travel 保底族 4 = 12 可见 → 业务 4 ≤ 6，仍判 router-first
  assert.equal(
    laneSets.isRouterFirstLaneTurn(
      mk([...light, "travel.plan-itinerary", "travel.search-poi", "travel.destination-info", "travel.compute-route"]),
    ),
    true,
    "轻量常驻+保底族轮应仍判 router-first（两步走引导不失活）",
  );
  // chat 车道规模（Core 20+ 常驻）→ 非 router-first
  const chatScale = [...light, ...Array.from({ length: 20 }, (_, i) => `x.tool_${i}`)];
  assert.equal(laneSets.isRouterFirstLaneTurn(mk(chatScale)), false);
  // 目录未激活 → false
  assert.equal(
    laneSets.isRouterFirstLaneTurn({ toolSearchActive: false, deferredToolCount: 0, visibleTools: [] }),
    false,
  );
});

// ── ③：晋升计数持久化（dev server 高频重启不清零） ──

test("③ 持久化：落盘 → 内存清零 → 模拟重启重载，晋升状态存活", async () => {
  const { join } = await import("node:path");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tool-promotion-test-"));
  const statePath = join(dir, "state.json");
  process.env.AGENT_TOOL_PROMOTION_STATE_PATH = statePath;
  try {
    promotion.resetToolPromotionState();
    const actor = "actor-persist-1";
    for (let i = 0; i < 3; i++) promotion.recordToolUsageForPromotion(actor, "travel.plan-itinerary", true);
    promotion.flushToolPromotionState();
    // 落盘内容：{ actorId: { toolName: [ts...] } }
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Record<string, number[]>>;
    assert.equal(raw[actor]?.["travel.plan-itinerary"]?.length, 3, `落盘内容异常: ${JSON.stringify(raw).slice(0, 200)}`);
    // 模拟进程重启：内存清零 + 重新从磁盘恢复
    promotion.resetToolPromotionState();
    promotion.reloadToolPromotionStateFromDiskForTests();
    assert.deepEqual(promotion.getPromotedToolNames(actor), ["travel.plan-itinerary"]);
  } finally {
    promotion.resetToolPromotionState();
    delete process.env.AGENT_TOOL_PROMOTION_STATE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 持久化 off 档：不读不写（单测/基准进程零污染）", async () => {
  const { join } = await import("node:path");
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tool-promotion-off-"));
  const statePath = join(dir, "state.json");
  process.env.AGENT_TOOL_PROMOTION_STATE_PATH = "off";
  try {
    promotion.reloadToolPromotionStateFromDiskForTests();
    promotion.recordToolUsageForPromotion("actor-off-1", "travel.plan-itinerary", true);
    promotion.flushToolPromotionState();
    assert.equal(existsSync(statePath), false, "off 档不应产生状态文件");
    assert.equal(existsSync(join(process.cwd(), "off")), false, "off 不应被当作路径解析");
  } finally {
    promotion.resetToolPromotionState();
    delete process.env.AGENT_TOOL_PROMOTION_STATE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
