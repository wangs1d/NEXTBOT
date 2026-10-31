import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { TravelTileCache } from "../src/services/travel-tile-cache.js";

/**
 * 底图代理的「过期不阻塞」契约。
 *
 * 钉住实测踩到的黑屏根因：清单类资源 10 分钟就过期，而上游抽风时一次回源要
 * 27~42s（实测 curl 40s 直接超时）。同步等回源 = 样式请求 502 = 整张底图
 * 永远画不出来。所以过期必须先发磁盘旧副本，回源放后台。
 */

const TILEJSON = "https://tiles.openfreemap.org/planet";

function keyOf(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

function seedDisk(dir: string, url: string, body: string, ageMs: number): void {
  const key = keyOf(url);
  const bodyPath = path.join(dir, key.slice(0, 2), `${key.slice(2)}.body`);
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, body);
  fs.writeFileSync(
    path.join(dir, key.slice(0, 2), `${key.slice(2)}.meta.json`),
    JSON.stringify({ url, contentType: "application/json", createdAt: Date.now() - ageMs }),
  );
}

function tempDir(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tile-")), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const realFetch = globalThis.fetch;

test("清单过期 + 上游挂住：立刻回旧副本，不等回源", async () => {
  const dir = tempDir("stale");
  process.env.TRAVEL_TILE_CACHE_DIR = dir;
  seedDisk(dir, TILEJSON, '{"old":true}', 20 * 60 * 1000);
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, 3000));
    return new Response('{"new":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cache = new TravelTileCache();
    const t0 = Date.now();
    const res = await cache.fetch(TILEJSON);
    assert.ok(res.ok, "有旧副本就不该失败");
    assert.equal(res.fromCache, true);
    assert.equal(res.body.toString(), '{"old":true}');
    assert.ok(Date.now() - t0 < 1000, "响应不该被上游拖住");
    assert.equal(upstreamCalls, 1, "回源转到了后台，仍然要发生");
    await new Promise((r) => setTimeout(r, 3500));
    const again = await cache.fetch(TILEJSON);
    assert.equal(again.body.toString(), '{"new":true}', "后台刷新要落到缓存里");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TRAVEL_TILE_CACHE_DIR;
  }
});

test("同一过期资源并发只回源一次", async () => {
  const dir = tempDir("dedupe");
  process.env.TRAVEL_TILE_CACHE_DIR = dir;
  seedDisk(dir, TILEJSON, '{"old":true}', 20 * 60 * 1000);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 200));
    return new Response('{"new":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cache = new TravelTileCache();
    await Promise.all(Array.from({ length: 8 }, () => cache.fetch(TILEJSON)));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls, 1, "后台回源要并发去重");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TRAVEL_TILE_CACHE_DIR;
  }
});

test("冷启动无副本：同步回源；上游失败就报失败，不编内容", async () => {
  const dir = tempDir("cold");
  process.env.TRAVEL_TILE_CACHE_DIR = dir;
  const url = "https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json";
  globalThis.fetch = (async () =>
    new Response('{"sprite":true}', { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const cache = new TravelTileCache();
    const first = await cache.fetch(url);
    assert.equal(first.ok, true);
    assert.equal(first.fromCache, false);
    assert.equal(first.body.toString(), '{"sprite":true}');

    const dead = new TravelTileCache();
    // 换个必然失败的上游地址（仍在白名单域内），且没有任何旧副本
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const miss = await dead.fetch("https://tiles.openfreemap.org/nothing-here.json");
    assert.equal(miss.ok, false);
    assert.equal(miss.status, 404);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TRAVEL_TILE_CACHE_DIR;
  }
});
