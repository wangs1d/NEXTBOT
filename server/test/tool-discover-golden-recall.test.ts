/**
 * tool_discover 召回黄金回归（2026-09-06）。
 *
 * 背景：前后台架构下，后台快速通道的可见工具只有桥工具（tool_discover/tool_call），
 * 业务工具全部靠 tool router 目录按需召回。召回 top-1 错 → 2 波预算耗尽 → 升级
 * 完整通道（多付 Pro + planner）。本文件把「典型用户表达 → 期望工具」锁成回归基线，
 * 防止目录/分词/路由表改动后召回静默退化。
 *
 * 契约：
 *   - 纯进程内 adaptive 管线（唯一检索管线）；
 *   - embedding 关闭 + 神经通道全关（离线可跑、结果确定——本机起过 sidecar
 *     也不能让结果漂移；神经路径的在线验收归 tool-discover-neural-recall.test.ts）；
 *   - 用真实内置工具集（getBuiltinAgentChatTools，~99 个）建目录，与线上 catalog 同源。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-golden-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
// desktop.* 需在基础工具集内（getDesktopVisualChatTools 的 env 门控），否则目录缺 desktop.open
process.env.DESKTOP_VISUAL_ENABLED = "1";
// 神经通道钉死关闭：URL 指向不可达端口 + 特性开关 off（双保险，保证确定性）
process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "openai";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);

type GoldenCase = {
  query: string;
  /** 任一命中即算通过（同义工具并存时给一组） */
  expect: string[];
  /** 期望出现在前 K 名（默认 1） */
  topK?: number;
};

/**
 * 黄金集分两档：
 *   - top1：单点快查，模型拿 matches[0] 直接 tool_call，错了就是 2 波预算白烧；
 *   - topK：同义工具并存（reminder.plan vs calendar.create_from_text）或表达偏口语，
 *     允许在前 3 内——模型会看 matches 列表的描述再选。
 */
const GOLDEN: GoldenCase[] = [
  // ── 单点快查（快速通道主战场）──
  { query: "北京今天天气怎么样", expect: ["weather.get_local"] },
  { query: "找几张猫的照片", expect: ["search_images", "search_images_batch"] },
  { query: "我在哪个城市", expect: ["clock.get_user_location"] },
  { query: "现在几点了", expect: ["clock.get_current_time"] },
  { query: "今天有什么热搜", expect: ["hot_rankings"] },
  { query: "我钱包还有多少钱", expect: ["wallet.get_balance"] },
  { query: "找个教做红烧肉的视频", expect: ["search_videos"] },
  { query: "把客厅的灯打开", expect: ["smart_home.control_device"] },
  // 2026-09-12：desktop.open 意图别名回归锁——「打开XX应用」此前 top5 无 desktop.open，
  // 任务面规划器漏选时 tool_discover 兜底召回必失败（模型只能口头推脱或编造工具名）。
  { query: "打开抖音", expect: ["desktop.open"] },
  { query: "打开网易云 播放影月", expect: ["desktop.open"] },
  // ── 需外部信息（search 族，允许同义）──
  { query: "比特币现在什么价", expect: ["search_web", "internet.research", "deep_search", "internet.live_check"], topK: 3 },
  { query: "帮我搜一下刘浩存最近的消息", expect: ["search_web", "internet.research", "deep_search"], topK: 3 },
  { query: "读一下这个网页 https://example.com 说了什么", expect: ["fetch_web", "info.inspect_webpage"], topK: 3 },
  // ── 写动作（完整通道也先经快速通道召回）──
  { query: "明天早上九点提醒我开会", expect: ["reminder.plan", "calendar.create_from_text", "calendar.create_task"], topK: 3 },
  { query: "我有哪些日程", expect: ["calendar.list_tasks"], topK: 3 },
  { query: "取消明天那个提醒", expect: ["calendar.delete_task", "calendar.list_tasks"], topK: 3 },
  { query: "记住我妈生日是5月20号", expect: ["care.set_important_date"], topK: 3 },
  { query: "到家的时候提醒我拿快递", expect: ["geofence.create"], topK: 3 },
  { query: "每天提醒我喝水", expect: ["care.rhythm_reminder", "reminder.plan"], topK: 3 },
  { query: "看一下门口摄像头", expect: ["vision.see_device", "vision.list_cameras"], topK: 3 },
  { query: "我答应过你什么", expect: ["commitment.list"], topK: 3 },
  // 2026-10-15：站内好友消息闭环回归锁——「给好友发消息」必须召回 world.link.send_message
  // （2026-10-16 工具归域改名：agent.send_to_peer / agent.link.* → world.link.*）
  { query: "给好友发消息", expect: ["world.link.send_message"] },
  { query: "回复好友消息", expect: ["world.link.send_message", "messages.reply"], topK: 2 },
];

type DiscoverMatch = { name: string; routing?: { confidence?: number } };

const catalog = (() => {
  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  assert.equal(prepared.toolSearchActive, true, "内置工具集应激活 tool search");
  assert.ok(prepared.deferredCatalog.entries.length >= 60, "延迟目录应包含绝大多数内置工具");
  return prepared.deferredCatalog;
})();

async function discover(query: string, limit = 5): Promise<DiscoverMatch[]> {
  const res = await executeToolSearchBridge("tool_discover", { query, limit }, catalog);
  assert.equal(res.ok, true, `tool_discover 应成功：${query}`);
  const matches = (res.result as { matches?: DiscoverMatch[] }).matches ?? [];
  return matches;
}

for (const c of GOLDEN) {
  const k = c.topK ?? 1;
  test(`golden@top${k}: 「${c.query}」→ ${c.expect.join(" | ")}`, async () => {
    const matches = await discover(c.query);
    const names = matches.map((m) => m.name);
    const hit = names.slice(0, k).some((n) => c.expect.includes(n));
    assert.ok(
      hit,
      `期望前 ${k} 名含 [${c.expect.join(", ")}]，实际：${names.slice(0, 5).join(" > ") || "(空)"}`,
    );
  });
}

test("golden 汇总：top-1 命中率不低于基线（防整体退化）", async () => {
  let top1 = 0;
  const misses: string[] = [];
  for (const c of GOLDEN) {
    const names = (await discover(c.query)).map((m) => m.name);
    if (names[0] && c.expect.includes(names[0])) top1 += 1;
    else misses.push(`${c.query} → ${names[0] ?? "(空)"}`);
  }
  const rate = top1 / GOLDEN.length;
  // 基线：写死当前实测下限；提升后可上调，不允许下调。
  // 2026-10-01 单评分器归一（IntentRouter/类别路由退役+负例入评分核心）后实测 21/21。
  const BASELINE = 0.9;
  assert.ok(
    rate >= BASELINE,
    `top-1 命中率 ${(rate * 100).toFixed(0)}% < 基线 ${BASELINE * 100}%；未命中：\n  ${misses.join("\n  ")}`,
  );
});

test("目录规模与桥工具：快速通道可见集仅桥工具", () => {
  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const visible = prepared.visibleTools
    .map((t) => (t.type === "function" ? t.function.name : ""))
    .filter(Boolean);
  assert.ok(visible.includes("tool_discover"), "可见集应含 tool_discover 桥工具");
  assert.equal(
    visible.filter((n) => n !== "tool_discover").length,
    0,
    `零业务 schema 契约：可见集只能是 tool_discover，实际：${visible.join(", ")}`,
  );
});
