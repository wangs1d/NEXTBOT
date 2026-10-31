/**
 * 事件记忆层（L0）单测：确定性构造 + 幂等写入 + 结构化/词面召回。
 * 测试封闭：临时 SQLite，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildEventId,
  buildEventJournalEntry,
  buildTurnEvent,
  kindForTool,
  type EventToolTrace,
} from "../src/agentic-memory/event-builder.js";
import { EventMemoryStore } from "../src/agentic-memory/event-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

function trace(partial: Partial<EventToolTrace> & { toolName: string }): EventToolTrace {
  return { input: {}, ok: true, result: {}, ...partial };
}

async function withStore(fn: (store: EventMemoryStore) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "event-memory-"));
  const store = new EventMemoryStore(openAgenticSqlite(join(dir, "events.db")));
  try {
    fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("kind 映射：比价/天气/日程写/纯闲聊", () => {
  assert.equal(kindForTool("shopping.compare.prices"), "price_compare");
  assert.equal(kindForTool("weather.get_local"), "weather_query");
  assert.equal(kindForTool("calendar.create_task"), "schedule_write");
  assert.equal(kindForTool("calendar.list_tasks"), "schedule_query");
  assert.equal(kindForTool("search_web"), "web_search");
  assert.equal(kindForTool("unknown.tool"), "tool:unknown");
});

test("status：无工具 ok、失败 failed、空结果 empty、混合 partial", () => {
  const base = { actorId: "u1", userText: "你好", assistantText: "嗯", ts: "2026-10-30T10:00:00.000Z" };
  assert.equal(buildTurnEvent(base).status, "ok");
  assert.equal(buildTurnEvent(base).kind, "chat_turn");

  const failed = buildTurnEvent({
    ...base,
    toolTraces: [trace({ toolName: "shopping.compare.prices", ok: false, result: { error: "登录失效" } })],
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.kind, "price_compare");

  const empty = buildTurnEvent({
    ...base,
    toolTraces: [trace({ toolName: "shopping.compare.prices", ok: true, result: { products: [] } })],
  });
  assert.equal(empty.status, "empty");

  const ok = buildTurnEvent({
    ...base,
    toolTraces: [trace({ toolName: "shopping.compare.prices", result: { products: [{ title: "x" }] } })],
  });
  assert.equal(ok.status, "ok");

  const partial = buildTurnEvent({
    ...base,
    toolTraces: [
      trace({ toolName: "shopping.compare.prices", result: { products: [{ title: "x" }] } }),
      trace({ toolName: "weather.get_local", ok: false, result: { error: "超时" } }),
    ],
  });
  assert.equal(partial.status, "partial");
});

test("实体抽取：型号正则 + 工具入参 query；原文脱敏截断", () => {
  const evt = buildTurnEvent({
    actorId: "u1",
    userText: "帮我比一下小米18 Pro 和 iPhone 16 Pro Max 的价，电话 13800138000",
    assistantText: "a".repeat(800),
    ts: "2026-10-30T10:00:00.000Z",
    toolTraces: [
      trace({ toolName: "shopping.compare.prices", input: { query: "小米18 Pro 12+256" } }),
    ],
  });
  assert.ok(evt.entities.includes("小米18 Pro"));
  assert.ok(evt.entities.includes("iPhone 16 Pro Max"));
  assert.ok(evt.entities.includes("小米18 Pro 12+256"));
  assert.ok(evt.userText.includes("***PHONE***"));
  assert.ok(!evt.userText.includes("13800138000"));
  assert.ok(evt.answerText.length <= 501);
});

test("摘要剥离协议标记与卡片块，只留可读正文", () => {
  const evt = buildTurnEvent({
    actorId: "u1",
    userText: "比一下价格",
    assistantText:
      '我查完了。\n[RENDER_HINT:card]\n[RENDER_HINT]:brief\n[AGENT_RESULT_CARD_START]{"title":"比价结果","items":[{"text":"小米15 ¥1979"}]}[AGENT_RESULT_CARD_END]',
    ts: "2026-10-30T10:00:00.000Z",
    toolTraces: [trace({ toolName: "shopping.compare.prices" })],
  });
  assert.ok(!evt.answerText.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(!evt.answerText.includes("RENDER_HINT"));
  assert.ok(evt.answerText.includes("比价结果"));
  assert.ok(evt.answerText.includes("小米15 ¥1979"));
});

test("比价品类闸：可比最低价是个位数 3C 价 → invalid + suspect；不可比/非 3C 不改判", () => {
  const base = {
    actorId: "u1",
    userText: "比价小米18 Pro",
    assistantText: "查到 ¥8",
    ts: "2026-10-30T10:00:00.000Z",
  };
  const suspect = buildTurnEvent({
    ...base,
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: {
          query: "小米18 Pro",
          bestIndex: 0,
          bestOffer: { platform: "tmall", priceCny: 8 },
          groups: [{}, {}],
        },
      }),
    ],
  });
  assert.equal(suspect.status, "invalid");
  assert.equal(suspect.payload.suspect, "accessory");

  const normal = buildTurnEvent({
    ...base,
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: { query: "小米18 Pro", bestIndex: 0, bestOffer: { priceCny: 4699 } },
      }),
    ],
  });
  assert.equal(normal.status, "ok");
  assert.equal(normal.payload.suspect, undefined);

  // 不可比（bestIndex=null）不宣称最低价，也就无从判可疑
  const incomparable = buildTurnEvent({
    ...base,
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: { query: "小米18 Pro", bestIndex: null, bestOffer: { priceCny: 8 } },
      }),
    ],
  });
  assert.equal(incomparable.status, "ok");

  // 非 3C 关键词：¥8 钢化膜就是真实价格
  const cheapThing = buildTurnEvent({
    ...base,
    userText: "比价钢化膜",
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: { query: "钢化膜", bestIndex: 0, bestOffer: { priceCny: 8 } },
      }),
    ],
  });
  assert.equal(cheapThing.status, "ok");
});

test("journal 事件行：比价结果压成可固化的 fact 行，聊天轮不写", () => {
  const ok = buildTurnEvent({
    actorId: "u1",
    userText: "比价小米15",
    assistantText: "淘宝 ¥1884",
    ts: "2026-10-28T08:00:00.000Z",
    messageId: "m-1",
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: {
          query: "小米15",
          bestIndex: 0,
          bestOffer: { platform: "taobao", priceCny: 1884 },
        },
      }),
    ],
  });
  const okEntry = buildEventJournalEntry(ok);
  assert.ok(okEntry);
  assert.equal(okEntry.content, "[比价] 小米15 → 淘宝 ¥1884");
  assert.match(okEntry.token, /^e-[\w-]{1,8}$/);

  // 配件价：结论必须是「未计入」，不能当真实最低价
  const suspect = buildTurnEvent({
    actorId: "u1",
    userText: "比价小米18 Pro",
    assistantText: "天猫 ¥8",
    ts: "2026-10-29T08:00:00.000Z",
    messageId: "m-2",
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: { query: "小米18 Pro", bestIndex: 0, bestOffer: { platform: "tmall", priceCny: 8 } },
      }),
    ],
  });
  const suspectEntry = buildEventJournalEntry(suspect);
  assert.ok(suspectEntry);
  assert.match(suspectEntry.content, /疑似配件/);
  assert.match(suspectEntry.content, /未计入最低价/);

  // 规格不可比：不得宣称最低价
  const incomparable = buildTurnEvent({
    actorId: "u1",
    userText: "比价红牛 2罐 vs 24瓶",
    assistantText: "规格不同",
    ts: "2026-10-29T09:00:00.000Z",
    toolTraces: [
      trace({
        toolName: "shopping.compare.prices",
        result: { query: "红牛", bestIndex: null, bestOffer: { platform: "jd", priceCny: 12 } },
      }),
    ],
  });
  assert.match(buildEventJournalEntry(incomparable)!.content, /未取得同规格可比最低价/);

  // 纯聊天轮不产生事件行（对话原文已由 journal 的 U/A 行承担）
  const chat = buildTurnEvent({
    actorId: "u1",
    userText: "今天天气不错",
    assistantText: "是呀",
    ts: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(buildEventJournalEntry(chat), null);
});

test("id 幂等：同 messageId 同 id；无 messageId 由 ts+文本稳定派生", () => {
  assert.equal(
    buildEventId("u1", "m-1", "2026-10-30T10:00:00.000Z", "你好"),
    buildEventId("u1", "m-1", "2026-10-30T11:00:00.000Z", "换个文本"),
  );
  assert.equal(
    buildEventId("u1", undefined, "2026-10-30T10:00:00.000Z", "你好"),
    buildEventId("u1", undefined, "2026-10-30T10:00:00.000Z", "你好"),
  );
});

test("写入幂等：同 messageId 覆盖不重复计数", async () => {
  await withStore((store) => {
    const input = {
      actorId: "u1",
      userText: "比价小米18 Pro",
      assistantText: "查到了",
      ts: "2026-10-30T10:00:00.000Z",
      messageId: "m-1",
      toolTraces: [trace({ toolName: "shopping.compare.prices", result: { products: [{ title: "x" }] } })],
    };
    store.recordTurn(input);
    store.recordTurn({ ...input, assistantText: "定稿文本" });
    assert.equal(store.stats().events, 1);
    const rows = store.recallEvents({ actorId: "u1" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].answerText, "定稿文本");
  });
});

test("召回：时间范围 / kind / status / 实体 / 词面", async () => {
  await withStore((store) => {
    store.recordTurn({
      actorId: "u1",
      userText: "比价小米18 Pro",
      assistantText: "天猫 ¥5999",
      ts: "2026-10-28T10:00:00.000Z",
      messageId: "m-1",
      toolTraces: [trace({ toolName: "shopping.compare.prices", result: { products: [{ title: "小米18 Pro" }] } })],
    });
    store.recordTurn({
      actorId: "u1",
      userText: "查下明天天气",
      assistantText: "晴 22 度",
      ts: "2026-10-29T10:00:00.000Z",
      messageId: "m-2",
      toolTraces: [trace({ toolName: "weather.get_local", result: { temperature: 22 } })],
    });
    store.recordTurn({
      actorId: "u1",
      userText: "再比一次小米18 Pro",
      assistantText: "登录失效没查到",
      ts: "2026-10-30T10:00:00.000Z",
      messageId: "m-3",
      toolTraces: [trace({ toolName: "shopping.compare.prices", ok: false, result: { error: "登录失效" } })],
    });

    assert.equal(store.recallEvents({ actorId: "u1" }).length, 3);
    assert.equal(store.recallEvents({ actorId: "u1", kinds: ["weather_query"] }).length, 1);
    assert.equal(store.recallEvents({ actorId: "u1", statuses: ["failed"] }).length, 1);
    assert.equal(
      store.recallEvents({ actorId: "u1", entities: ["小米18 Pro"] }).length,
      2,
    );
    assert.equal(
      store.recallEvents({ actorId: "u1", from: "2026-10-29T00:00:00.000Z" }).length,
      2,
    );
    const textHits = store.recallEvents({ actorId: "u1", query: "小米18 Pro" });
    assert.equal(textHits.length, 2);
    // 闲聊虚词不构成命中（否则「完全不存在的东西」会召回一堆无关记录）
    assert.equal(store.recallEvents({ actorId: "u1", query: "完全不存在的主题xyz" }).length, 0);
    // 其他 actor 不可见
    assert.equal(store.recallEvents({ actorId: "u2" }).length, 0);
  });
});

test("updateAnswerByMessageId：定稿文本同步到事件与索引", async () => {
  await withStore((store) => {
    store.recordTurn({
      actorId: "u1",
      userText: "比价小米18 Pro",
      assistantText: "原始文本",
      ts: "2026-10-30T10:00:00.000Z",
      messageId: "m-1",
    });
    assert.equal(store.updateAnswerByMessageId("u1", "m-1", "卡片定稿文本"), true);
    const [row] = store.recallEvents({ actorId: "u1" });
    assert.equal(row.answerText, "卡片定稿文本");
    assert.equal(store.updateAnswerByMessageId("u1", "missing", "x"), false);
  });
});
