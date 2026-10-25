/**
 * 统一盯梢门面（WatchBoard + watch.track 工具）单测。
 *
 * 覆盖：
 *   1. 路由：topic → WatchTaskStore（关键词盯梢）；price → 比价降价监控
 *   2. 统一视图：两源合并 + 创建时间倒序 + 单源故障降级
 *   3. 生命周期：close 路由（topic remove / price removeWatch）、setStatus
 *   4. 工具层：watch.track create/list/close 快乐路径 + 校验错误如实返回
 *
 * 测试封闭：内存 fake 双执行器、注入时钟、无网络。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WatchBoard, type PriceWatchServiceLike, type TopicWatchStoreLike } from "../src/services/watch-board.js";
import { registerWatchBoardTools } from "../src/tools/watch-board-tools.js";
import type { ToolContext, ToolRegistry } from "../src/tools/tool-registry.js";

// ───────────────────────── fakes ─────────────────────────

function makeTopicStore(): TopicWatchStoreLike & { _items: Array<{ id: string; actorId: string; label: string; keywords: string[]; active: boolean; createdAt: number }> } {
  const items: Array<{ id: string; actorId: string; label: string; keywords: string[]; active: boolean; createdAt: number }> = [];
  let seq = 0;
  return {
    _items: items,
    create(actorId, label, keywords) {
      const t = { id: `wa_${++seq}`, actorId, label, keywords: [...keywords], active: true, createdAt: Date.now() + seq };
      items.push(t);
      return t;
    },
    list(actorId) {
      return items.filter((t) => (actorId ? t.actorId === actorId : true));
    },
    setActive(actorId, id, active) {
      const t = items.find((x) => x.id === id && x.actorId === actorId);
      if (!t) return false;
      t.active = active;
      return true;
    },
    remove(actorId, id) {
      const i = items.findIndex((x) => x.id === id && x.actorId === actorId);
      if (i === -1) return false;
      items.splice(i, 1);
      return true;
    },
  };
}

type PriceRow = { id: string; query: string; platform: string; targetPrice: number; enabled: boolean; createdAt: number };

function makePriceService(): PriceWatchServiceLike & { _items: PriceRow[]; _removed: string[] } {
  const items: PriceRow[] = [];
  const removed: string[] = [];
  let seq = 0;
  return {
    _items: items,
    _removed: removed,
    async addWatch(actorId, query, platform, targetPrice) {
      const row: PriceRow = { id: `pw_${++seq}`, query, platform, targetPrice, enabled: true, createdAt: Date.now() + 1000 + seq };
      items.push(row);
      return [row];
    },
    listWatches(actorId) {
      void actorId;
      return [...items];
    },
    async removeWatch(actorId, target) {
      void actorId;
      removed.push(target);
      const i = items.findIndex((w) => w.query === target);
      if (i !== -1) items.splice(i, 1);
    },
  };
}

const CTX: ToolContext = { sessionId: "sess-1", userId: "user-1" } as ToolContext;

function makeRegistry(): { registry: ToolRegistry; handlers: Map<string, (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>> } {
  const handlers = new Map<string, (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>>();
  const registry = {
    register: (name: string, handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as ToolRegistry;
  return { registry, handlers };
}

// ───────────────────────── 服务层 ─────────────────────────

test("watch-board：topic 盯梢路由到 WatchTaskStore，返回统一视图记录", async () => {
  const topic = makeTopicStore();
  const board = new WatchBoard({ topic });
  const w = await board.create("u1", { kind: "topic", target: "学校保研通知", keywords: ["保研", "推免"] });
  assert.match(w.watchId, /^topic:wa_/);
  assert.equal(w.kind, "topic");
  assert.equal(w.status, "active");
  assert.deepEqual((w.detail.keywords as string[]), ["保研", "推免"]);
  assert.equal(topic._items.length, 1);
  assert.equal(topic._items[0].label, "学校保研通知");
});

test("watch-board：price 盯梢路由到比价服务，缺省平台生效", async () => {
  const price = makePriceService();
  const board = new WatchBoard({ price, defaultPlatform: "taobao" });
  const w = await board.create("u1", { kind: "price", target: "索尼 WH-1000XM6", targetPrice: 800 });
  assert.match(w.watchId, /^price:pw_/);
  assert.equal((w.detail.platform as string), "taobao");
  assert.equal((w.detail.targetPrice as number), 800);
  assert.equal(price._items[0].query, "索尼 WH-1000XM6");
});

test("watch-board：校验错误如实抛出（topic 缺 keywords / price 缺目标价）", async () => {
  const board = new WatchBoard({ topic: makeTopicStore(), price: makePriceService() });
  await assert.rejects(
    () => board.create("u1", { kind: "topic", target: "保研通知" }),
    /keywords/,
  );
  await assert.rejects(
    () => board.create("u1", { kind: "price", target: "索尼 XM6" }),
    /targetPrice/,
  );
  await assert.rejects(
    () => board.create("u1", { kind: "topic", target: "x" }),
    /target 至少 2 个字符/,
  );
});

test("watch-board：list 合并两源并按创建时间倒序，单源故障降级为空", async () => {
  const topic = makeTopicStore();
  const price = makePriceService();
  const board = new WatchBoard({ topic, price });
  const t = await board.create("u1", { kind: "topic", target: "回归消息", keywords: ["回归"] });
  const p = await board.create("u1", { kind: "price", target: "XM6", targetPrice: 800, platform: "jd" });
  const all = await board.list("u1");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((w) => w.kind), ["price", "topic"], "price 创建更晚 → 倒序在前");
  assert.ok(p.createdAt >= t.createdAt);

  const broken = new WatchBoard({
    topic: {
      ...topic,
      list: () => {
        throw new Error("disk full");
      },
    },
    price,
  });
  const only = await broken.list("u1");
  assert.equal(only.length, 1);
  assert.equal(only[0].kind, "price");
});

test("watch-board：close 路由（topic remove / price removeWatch 按 query），setStatus 路由 topic", async () => {
  const topic = makeTopicStore();
  const price = makePriceService();
  const board = new WatchBoard({ topic, price });

  const t = await board.create("u1", { kind: "topic", target: "保研通知", keywords: ["保研"] });
  assert.equal(await board.setStatus("u1", t.watchId, false), true);
  assert.equal(topic._items[0].active, false);
  assert.equal(await board.close("u1", t.watchId), true);
  assert.equal(topic._items.length, 0);

  const p = await board.create("u1", { kind: "price", target: "XM6", targetPrice: 800, platform: "jd" });
  assert.equal(await board.close("u1", p.watchId), true);
  assert.deepEqual(price._removed, ["XM6"]);
  assert.equal(price._items.length, 0);
  // price 暂停不支持：如实返回 false（模型转告用户 close 后重建）
  const p2 = await board.create("u1", { kind: "price", target: "XM6", targetPrice: 800, platform: "jd" });
  assert.equal(await board.setStatus("u1", p2.watchId, false), false);
});

// ───────────────────────── 工具层 ─────────────────────────

test("watch.track 工具：create/list/close 快乐路径与 summary 文案", async () => {
  const { registry, handlers } = makeRegistry();
  const board = new WatchBoard({ topic: makeTopicStore(), price: makePriceService(), defaultPlatform: "taobao" });
  registerWatchBoardTools(registry, board);
  const handler = handlers.get("watch.track")!;

  const created = (await handler(
    { action: "create", kind: "topic", target: "学校保研通知", keywords: ["保研", "推免"] },
    CTX,
  )) as { ok: boolean; watchId: string; summary: string };
  assert.equal(created.ok, true);
  assert.match(created.summary, /盯梢已建档/);
  assert.match(created.summary, /相关消息一到/);

  const priceCreated = (await handler(
    { action: "create", kind: "price", target: "XM6", targetPrice: 800 },
    CTX,
  )) as { ok: boolean; summary: string };
  assert.equal(priceCreated.ok, true);
  assert.match(priceCreated.summary, /降到 ¥800/);

  const listed = (await handler({ action: "list" }, CTX)) as { ok: boolean; watches: Array<{ kind: string }> };
  assert.equal(listed.ok, true);
  assert.equal(listed.watches.length, 2);

  const closed = (await handler({ action: "close", watchId: created.watchId }, CTX)) as { ok: boolean };
  assert.equal(closed.ok, true);

  const closeMissing = (await handler({ action: "close", watchId: "topic:ghost" }, CTX)) as { ok: boolean; error: string };
  assert.equal(closeMissing.ok, false);
  assert.match(closeMissing.error, /没找到/);
});

test("watch.track 工具：校验错误不抛出、如实返回 error（模型可转告）", async () => {
  const { registry, handlers } = makeRegistry();
  const board = new WatchBoard({ topic: makeTopicStore(), price: makePriceService() });
  registerWatchBoardTools(registry, board);
  const handler = handlers.get("watch.track")!;

  const noKw = (await handler({ action: "create", kind: "topic", target: "保研通知" }, CTX)) as { ok: boolean; error: string };
  assert.equal(noKw.ok, false);
  assert.match(noKw.error, /keywords/);

  const noPrice = (await handler({ action: "create", kind: "price", target: "XM6", platform: "jd" }, CTX)) as { ok: boolean; error: string };
  assert.equal(noPrice.ok, false);
  assert.match(noPrice.error, /targetPrice/);

  const badAction = (await handler({ action: "whatever" }, CTX)) as { ok: boolean; error: string };
  assert.equal(badAction.ok, false);
  assert.match(badAction.error, /未知 action/);
});
