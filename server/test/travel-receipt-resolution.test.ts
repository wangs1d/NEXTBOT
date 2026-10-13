import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 旅游行程卡 done 阶段投递链路回归（2026-09-18 漏卡根因锁定）：
 *
 * 真实轮次回放发现：任务面（task_plane）收尾此前没有冷层回捞兜底，且 WS 路径
 * 在 reply.toolName 落在其他工具（如 travel.destination-info）时会被短路掉
 * 冷层回捞——行程已生成落盘，但最终消息里没有 travel_itinerary 独立卡。
 *
 * 本文件锁定 resolveTravelReceipt 的三路裁决语义，以及
 * attach → normalizeReplyCardLayout → buildReplyBlocks 全链产物中
 * 行程卡必须作为最后一个 card 块下发。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-receipt-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

// 环境变量须在模块导入前设置（travelPlanStore 单例构造时读取）
const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const { resolveTravelReceipt, attachDeterministicCards, looksLikeHandwrittenItinerary, sniffItineraryDays, classifyTravelCardMissing } = await import(
  "../src/services/deterministic-card-chain.js"
);
const { normalizeReplyCardLayout, buildReplyBlocks } = await import(
  "../src/services/reply-envelope.js"
);

const NOW = Date.now();

function savePlan(
  planId: string,
  destination: string,
  createdAtOffsetMs: number,
): void {
  travelPlanStore.save({
    planId,
    destination,
    title: `${destination}3日游`,
    startDate: "2026-10-01",
    endDate: "2026-10-03",
    createdAt: NOW + createdAtOffsetMs,
    days: [
      {
        date: "2026-10-01",
        items: [
          {
            type: "attraction",
            name: `${destination}老城`,
            startTime: "09:00",
            latitude: 30,
            longitude: 120,
            address: "",
            priceInfo: "",
            description: "",
          },
        ],
      },
    ],
  });
}

const SLIM_RECEIPT = {
  ok: true,
  id: "plan-slim-1",
  title: "厦门3日游·海景/海鲜",
  destination: "厦门",
  dayCount: 3,
};

test("回执裁决：直跑瘦身回执（只有 id）→ 交给 attach 按 planId 冷层补全", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.plan-itinerary",
    replyToolResult: SLIM_RECEIPT,
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal(r.result?.id, "plan-slim-1");
});

test("回执裁决：reply.toolName 是其他工具（destination-info）不短路——捕获的行程回执仍生效", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.destination-info",
    replyToolResult: { ok: true, destination: "厦门", visa: "免签" },
    executedReceipt: SLIM_RECEIPT,
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal(r.result?.id, "plan-slim-1");
});

test("回执裁决：捕获漏拍 → 冷层近窗回捞，正文点名目的地优先", () => {
  savePlan("plan-old-1", "杭州", -10 * 60 * 1000); // 窗口外
  savePlan("plan-fresh-xian", "西安", -5 * 1000);
  savePlan("plan-fresh-xiamen", "厦门", -3 * 1000);
  const r = resolveTravelReceipt({
    goal: "帮我规划去厦门的行程",
    finalText: "你的行程已经排好了，重点帮你列一下。",
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal((r.result as { planId?: string }).planId, "plan-fresh-xiamen");
});

test("回执裁决：正文不含目的地 → 取窗口内最新一份", () => {
  const r = resolveTravelReceipt({
    goal: "帮我规划一下",
    finalText: "行程排好了。",
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal((r.result as { planId?: string }).planId, "plan-fresh-xiamen");
});

test("回执裁决：窗口内无行程 → 不附卡", () => {
  const r = resolveTravelReceipt({
    goal: "今天天气怎么样",
    finalText: "今天晴。",
    nowMs: NOW + 60 * 60 * 1000, // 全部超出窗口
  });
  assert.equal(r.toolName, undefined);
  assert.equal(r.result, undefined);
});

test("回执裁决：规划执行失败 → 不回捞旧行程误挂到失败轮", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.plan-itinerary",
    replyToolResult: { ok: false, error: "规划失败" },
    nowMs: NOW,
  });
  assert.equal(r.toolName, undefined);
  assert.equal(r.result, undefined);
});

test("全链产物：attach → 版式归一 → blocks，行程卡必须是最后一个 card 块", () => {
  savePlan("plan-tail-1", "厦门", 0);
  // 瘦身回执的 id 必须能在冷层命中（与真实链路一致：skill 先落盘再返回回执）
  const slimReceiptForTail = { ...SLIM_RECEIPT, id: "plan-tail-1", title: "厦门3日游" };
  const resolved = resolveTravelReceipt({
    executedReceipt: slimReceiptForTail,
    goal: "去厦门玩3天",
    finalText: "厦门的行程帮你排好了。",
    nowMs: NOW,
  });
  assert.ok(resolved.result);

  // 模型总览卡（LLM 口语回复被切成通用卡）+ 正文 + 确定性附行程卡
  let text =
    "[AGENT_RESULT_CARD_START]{\"title\":\"厦门行程概览\",\"items\":[{\"type\":\"num\",\"text\":\"Day 1 集美学村\"}],\"footer\":\"\"}[AGENT_RESULT_CARD_END]\n\n厦门的行程帮你排好了。";
  text = attachDeterministicCards({
    text,
    travelToolName: resolved.toolName,
    travelResult: resolved.result,
  });
  text = normalizeReplyCardLayout(text);
  const blocks = buildReplyBlocks(text);
  assert.ok(blocks, "blocks 应下发（无 v1 未支持标记）");

  const cardIdxs = blocks!
    .map((b, i) => (b.type === "card" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(cardIdxs.length, 2, "应有总览卡 + 行程卡两个 card 块");
  const first = blocks![cardIdxs[0]];
  const last = blocks![cardIdxs[1]];
  if (!("card" in first) || !("card" in last)) return assert.fail("unreachable");
  assert.notEqual(
    (first.card as Record<string, unknown>).cardType,
    "travel_itinerary",
    "总览卡置首",
  );
  assert.equal(
    (last.card as Record<string, unknown>).cardType,
    "travel_itinerary",
    "行程卡独立收尾在最后",
  );
  assert.ok(
    ((last.card as Record<string, unknown>).title as string).includes("厦门"),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 手写行程检测（2026-10-08 确定性兜底）：模型手写行程不调工具 → 代码补跑附卡
// ───────────────────────────────────────────────────────────────────────────

test("手写行程检测：时间表格行程（真实事故形态）命中", () => {
  const reply = [
    "## 🗓️ 兴义周末一日游 · 推荐方案",
    "### 方案 A · 自然风光线（推荐 ✅）",
    "| 时间 | 安排 | 关键信息 |",
    "|---|---|---|",
    "| 08:30 | 兴义市区出发 → 万峰林 | 打车约30分钟 |",
    "| 09:00–13:00 | **万峰林景区** | 开放 8:00–18:00 |",
    "| 14:30–17:30 | **马岭河峡谷** | 旺季门票 70元 |",
    "| 18:00 | 回市区，夜市觅食 | 推荐烧烤、羊肉粉 |",
    "门票和开放时间以景区当天公告为准。",
  ].join("\n");
  assert.equal(looksLikeHandwrittenItinerary(reply), true);
});

test("手写行程检测：多方案标题（无时间格）命中", () => {
  const reply = [
    "### 方案 A · 轻松市区线",
    "- 上午：地质公园博物馆",
    "- 下午：万峰湖码头散步",
    "### 方案 B · 户外挑战线",
    "- 马岭河漂流 + 万峰林骑行",
  ].join("\n");
  assert.equal(looksLikeHandwrittenItinerary(reply), true);
});

test("手写行程检测：多天标题命中", () => {
  const reply =
    "行程这样安排：\n第一天抵达大理古城逛逛，第二天环洱海骑行，景点门票都帮你留了弹性。";
  assert.equal(looksLikeHandwrittenItinerary(reply), true);
});

test("手写行程检测：日常日程表（会议/提醒带时间）不命中", () => {
  const reply =
    "明天的安排：09:00 站会，11:00 设计评审，14:00 与产品对齐，16:30 周报，18:00 下班。";
  assert.equal(looksLikeHandwrittenItinerary(reply), false);
});

test("手写行程检测：泛泛聊旅游（无行程结构）不命中", () => {
  assert.equal(
    looksLikeHandwrittenItinerary("兴义秋天挺适合旅游的，万峰林和马岭河都值得去，门票也不贵。"),
    false,
  );
  assert.equal(looksLikeHandwrittenItinerary("晴天 13–26°C，适合出门。"), false);
  assert.equal(looksLikeHandwrittenItinerary(""), false);
});

test("天数嗅探：两日/三天/一日 → 对应天数，说不清 → 缺省", () => {
  assert.equal(sniffItineraryDays(["帮我规划周末两日游", "兴义两日游安排如下"]), 2);
  assert.equal(sniffItineraryDays(["成都三日游怎么玩"]), 3);
  assert.equal(sniffItineraryDays(["周末一日游"]), 1);
  assert.equal(sniffItineraryDays(["出去玩"]), undefined);
});

// ───────────────────────────────────────────────────────────────────────────
// 行程卡缺席自检判据（2026-10-12 贵阳轮事故埋点）：classifyTravelCardMissing
//   硬档 = 跑过规划/拿到回执却无卡（确定性事实）；软档 = 路由判行程轮 + 手写行程。
// ───────────────────────────────────────────────────────────────────────────

/** 造一段「正文 + 真行程卡」文本（复用真实 attach 链，不手搓卡 JSON）。 */
function textWithTravelCard(destination: string): string {
  savePlan(`plan-gap-${destination}`, destination, 0);
  const resolved = resolveTravelReceipt({
    executedReceipt: { ...SLIM_RECEIPT, id: `plan-gap-${destination}`, title: `${destination}3日游` },
    goal: `去${destination}玩3天`,
    finalText: `${destination}的行程帮你排好了。`,
    nowMs: NOW,
  });
  const text = attachDeterministicCards({
    text: `${destination}的行程帮你排好了。`,
    travelToolName: resolved.toolName,
    travelResult: resolved.result,
  });
  return text;
}

test("缺席自检：有卡 → null（硬/软都不报）", () => {
  const text = textWithTravelCard("厦门");
  assert.equal(
    classifyTravelCardMissing({
      finalText: text,
      travelPlanningAttempted: true,
      travelReceiptPresent: true,
      travelQuery: true,
    }),
    null,
  );
});

test("缺席自检·硬档：跑过规划却无卡 → hard（事故核心形态）", () => {
  // 事故原形：工具被预算击杀 ok=false → 无卡，正文是模型手写的逐日行程
  const handwritten =
    "贵阳两天这样玩：\n第一天 09:00 甲秀楼，11:30 黔灵山，14:00 青岩古镇；\n第二天 09:00 花溪公园，12:00 天河潭，16:00 返程。景点门票都帮你留了弹性。";
  assert.equal(
    classifyTravelCardMissing({
      finalText: handwritten,
      travelPlanningAttempted: true, // executedTravelPlanAttempted
      travelReceiptPresent: false, // ok=false → 回执为空
      travelQuery: true,
    }),
    "hard",
  );
});

test("缺席自检·硬档：拿到回执却无卡 → hard（与 travelQuery 无关）", () => {
  assert.equal(
    classifyTravelCardMissing({
      finalText: "行程已经在路上了，稍等。",
      travelPlanningAttempted: false,
      travelReceiptPresent: true,
      travelQuery: undefined, // LLM 字段缺省也要报——不能单点靠它
    }),
    "hard",
  );
});

test("缺席自检·软档：路由判行程轮 + 手写行程 → soft（未尝试规划时的高置信兜底）", () => {
  const handwritten =
    "行程这样安排：\n第一天抵达大理古城逛逛，第二天环洱海骑行，景点门票都帮你留了弹性。";
  assert.equal(
    classifyTravelCardMissing({
      finalText: handwritten,
      travelPlanningAttempted: false,
      travelReceiptPresent: false,
      travelQuery: true,
    }),
    "soft",
  );
});

test("缺席自检：非行程轮闲聊/引用旧方案 → null（不刷告警）", () => {
  // 只是聊到旅游，无行程结构
  assert.equal(
    classifyTravelCardMissing({
      finalText: "兴义秋天挺适合旅游的，万峰林和马岭河都值得去。",
      travelPlanningAttempted: false,
      travelReceiptPresent: false,
      travelQuery: true,
    }),
    null,
  );
  // 路由判非行程轮（引用旧方案），即便有手写结构也不报
  assert.equal(
    classifyTravelCardMissing({
      finalText: "方案A/B/C 都在上面了，你挑一个？",
      travelPlanningAttempted: false,
      travelReceiptPresent: false,
      travelQuery: false,
    }),
    null,
  );
});
