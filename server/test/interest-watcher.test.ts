// InterestWatcher 单元测试：兴趣池管理、匹配、去重、间隔、衰减、持久化。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InterestWatcher,
  normalizeFp,
  interestMatches,
  cosineSimilarity,
  type InterestHit,
} from "../src/proactivity/interest-watcher.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeWatcher(opts?: {
  hits?: InterestHit[];
  onHit?: (actorId: string, name: string, title: string) => void;
  now?: () => number;
  persistPath?: string;
  minPushIntervalMs?: number;
}) {
  const base = new InterestWatcher({
    fetchHot: async () => opts?.hits ?? [],
    now: opts?.now,
    minPushIntervalMs: opts?.minPushIntervalMs,
    persistPath: opts?.persistPath ?? join(tmpdir(), "iw-test.json"),
  });
  if (opts?.onHit) {
    base.setOnHit((actorId, interest, hit) => opts.onHit!(actorId, interest.name, hit.title));
  }
  return base;
}

test("addInterest：同名合并并自增 mentionCount，新对象保留 firstSeenAt", async () => {
  let ts = 1_000_000;
  const watcher = makeWatcher({ now: () => ts });
  await watcher.addInterest("u1", "刘浩存", "person");
  ts += 1000;
  await watcher.addInterest("u1", "刘浩存", "person");
  const list = watcher.listInterests("u1");
  assert.equal(list.length, 1);
  assert.equal(list[0].mentionCount, 2);
  assert.equal(list[0].firstSeenAt, 1_000_000);
  assert.equal(list[0].lastSeenAt, 1_001_000);
  assert.equal(list[0].type, "person");
});

test("addInterest：池容量上限 50 后拒绝新增", async () => {
  const watcher = makeWatcher();
  for (let i = 0; i < 50; i++) await watcher.addInterest("u1", `兴趣${i}`);
  await assert.rejects(() => watcher.addInterest("u1", "第51个"), /满/);
});

test("removeInterest：支持按名字和按 id 移除", async () => {
  const watcher = makeWatcher();
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  let list = await watcher.removeInterest("u1", "刘浩存");
  assert.deepEqual(list.map((i) => i.name), ["王者荣耀"]);
  const id = list[0].id;
  list = await watcher.removeInterest("u1", id);
  assert.equal(list.length, 0);
});

test("listForPrompt：只列出 enabled，无兴趣返回 null（零注入）", async () => {
  const watcher = makeWatcher();
  assert.equal(watcher.listForPrompt("u1"), null);
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  const text = watcher.listForPrompt("u1");
  assert.ok(text?.includes("刘浩存"));
  assert.ok(text?.includes("人物"));
  assert.ok(text?.includes("王者荣耀"));
});

test("持久化：load 恢复上次新增的兴趣", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iw-persist-"));
  const file = join(dir, "pool.json");
  const watcher = makeWatcher({ persistPath: file });
  await watcher.addInterest("u1", "刘浩存", "person");
  const reloaded = makeWatcher({ persistPath: file });
  await reloaded.load();
  const list = reloaded.listInterests("u1");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "刘浩存");
  assert.equal(list[0].type, "person");
  await rm(dir, { recursive: true, force: true });
});

test("interestMatches：归一化包含匹配（中文/符号容错）", () => {
  const interest = { name: "刘浩存" } as { name: string };
  assert.equal(interestMatches(interest as never, { title: "刘浩存新片官宣定档" }), true);
  assert.equal(interestMatches(interest as never, { title: "某某明星街拍" }), false);
  // 长度 <2 的泛词不参与匹配（防单字符误伤）
  assert.equal(interestMatches({ name: "V" } as never, { title: "V 时代来了" }), false);
});

test("normalizeFp：去符号小写", () => {
  assert.equal(normalizeFp("刘浩存 新片 官宣！"), "刘浩存新片官宣");
  assert.equal(normalizeFp("abc  Def-123"), "abcdef123");
});

test("checkInterest：热搜命中 → onHit + 指纹去重 + 间隔拦截", async () => {
  const hits: InterestHit[] = [];
  const pushed: Array<{ actorId: string; name: string; title: string }> = [];
  const watcher = makeWatcher({
    minPushIntervalMs: 2 * HOUR,
    hits,
    onHit: (actorId, name, title) => pushed.push({ actorId, name, title }),
  });
  await watcher.addInterest("u1", "刘浩存", "person");

  const now0 = 10_000_000;
  // 第 1 次：热搜命中 → 推
  hits.push({ title: "刘浩存新片官宣", platform: "weibo", hot: "热" });
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0), true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, "刘浩存新片官宣");

  // 第 2 次（同一条热搜仍在，1h 后）：指纹相同 → 不推
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + HOUR), false);
  assert.equal(pushed.length, 1);

  // 第 3 次（换新热搜，但距上次仅 1h < 2h 间隔）：不推
  hits[0] = { title: "刘浩存获奖实至名归", platform: "baidu" };
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + HOUR), false);
  assert.equal(pushed.length, 1);

  // 第 4 次（新热搜 + 已过 2h 间隔）：推新热点
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + 2 * HOUR + 1), true);
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].title, "刘浩存获奖实至名归");
});

test("checkInterest：未命中热搜时不动状态（不占推送位）", async () => {
  const pushed: string[] = [];
  const watcher = makeWatcher({
    hits: [{ title: "无关热点", platform: "weibo" }],
    onHit: (_a, _n, title) => pushed.push(title),
  });
  await watcher.addInterest("u1", "刘浩存", "person");
  const interest = watcher.listInterests("u1")[0];
  assert.equal(watcher.checkInterest(interest, watcher.listInterests("u1"), 1_000_000), false);
  assert.equal(pushed.length, 0);
  assert.equal(interest.lastPushedFp, null);
  // 热搜拉取失败/为空时 checkAll 静默跳过
  const empty = makeWatcher({ hits: [] });
  await empty.addInterest("u1", "刘浩存", "person");
  assert.equal(await empty.checkAll(1_000_000), 0);
});

test("checkAll：单次热搜匹配多用户多兴趣，仅对命中者推送", async () => {
  const pushed: string[] = [];
  const watcher = makeWatcher({
    hits: [
      { title: "刘浩存新片官宣", platform: "weibo" },
      { title: "王者荣耀S35赛季开启", platform: "baidu" },
    ],
    minPushIntervalMs: 0,
    onHit: (_a, name) => pushed.push(name),
  });
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  await watcher.addInterest("u1", "某不相关", "other");
  await watcher.addInterest("u2", "刘浩存", "person");

  const pushedCount = await watcher.checkAll(5_000_000);
  assert.equal(pushedCount, 3); // u1 两条 + u2 一条
  assert.deepEqual(pushed.sort(), ["刘浩存", "刘浩存", "王者荣耀"].sort());
});

test("applyDecay：30 天未提及降权（enabled=false），60 天移除", async () => {
  const watcher = makeWatcher();
  const now = Date.now();
  await watcher.addInterest("u1", "旧兴趣A");
  await watcher.addInterest("u1", "旧兴趣B");
  // 按名字拿稳定引用：A → 31 天前（降权线）；B → 61 天前（移除线）
  const a = watcher.listInterests("u1").find((i) => i.name === "旧兴趣A")!;
  const b = watcher.listInterests("u1").find((i) => i.name === "旧兴趣B")!;
  a.lastSeenAt = now - 31 * DAY;
  b.lastSeenAt = now - 61 * DAY;
  watcher.applyDecay(now);

  const after = watcher.listInterests("u1");
  assert.equal(after.length, 1); // B 已过 60 天 → 移除
  assert.equal(after[0].name, "旧兴趣A");
  assert.equal(after[0].enabled, false); // A 降权，不再推送

  // 降权后不参与推送，但 touchInterest 可重新激活
  await watcher.touchInterest("u1", "旧兴趣A");
  assert.equal(watcher.listInterests("u1")[0].enabled, true);
});
// ─── 语义兜底匹配（2026-10-01）───

/** 维度=3 的玩具嵌入：把文本哈希进固定平面，同义对人工给高相似 */
function toyEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    // 「苹果手机」与「iPhone 17 发布」人工映射到相近向量；其余随机但不稳也不影响断言
    if (t.includes("苹果手机")) return [0.9, 0.1, 0.2];
    if (/iphone\s*17/i.test(t)) return [0.85, 0.15, 0.25];
    if (t.includes("刘浩存")) return [0.1, 0.95, 0.1];
    if (t.includes("新电影定档")) return [0.15, 0.9, 0.15];
    return [0.1, 0.1, 0.99];
  });
}

function makeSemanticWatcher(opts: {
  hits: InterestHit[] | (() => InterestHit[]);
  onHit?: (actorId: string, name: string, title: string) => void;
  embed?: (texts: string[]) => Promise<number[][] | null>;
  minPushIntervalMs?: number;
}) {
  const watcher = new InterestWatcher({
    fetchHot: async () => (typeof opts.hits === "function" ? opts.hits() : opts.hits),
    embed: opts.embed ?? (async (texts) => toyEmbed(texts)),
    minPushIntervalMs: opts.minPushIntervalMs ?? 0,
    persistPath: join(tmpdir(), `iw-sem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
  });
  if (opts.onHit) {
    watcher.setOnHit((actorId, interest, hit) => opts.onHit!(actorId, interest.name, hit.title));
  }
  return watcher;
}

test("语义兜底：字面未命中的换说法热点经 embedding 命中", async () => {
  const pushed: string[] = [];
  const watcher = makeSemanticWatcher({
    hits: [{ title: "iPhone 17 全系发布", platform: "微博" }],
    onHit: (_a, name, title) => pushed.push(`${name}→${title}`),
  });
  await watcher.addInterest("u1", "苹果手机", "brand");
  // 字面包含不命中（标题无「苹果手机」），但语义相似度高
  const n = await watcher.checkAll();
  assert.equal(n, 1, "语义兜底命中");
  assert.ok(pushed[0]!.includes("iPhone 17"), pushed[0]);
});

test("语义兜底：相似度低于阈值不推（宁缺勿滥）", async () => {
  const pushed: string[] = [];
  const watcher = makeSemanticWatcher({
    hits: [{ title: "某地迎来大范围降雨", platform: "百度" }],
    onHit: (_a, name, title) => pushed.push(`${name}→${title}`),
  });
  await watcher.addInterest("u1", "苹果手机", "brand");
  const n = await watcher.checkAll();
  assert.equal(n, 0, "不相关向量（[0.1,0.1,0.99]，实测 cos≈0.32）低于阈值不推");
  assert.equal(pushed.length, 0);
});

test("语义兜底：embed 返回 null（引擎不可用）退回纯字面，静默不推", async () => {
  const watcher = makeSemanticWatcher({
    hits: [{ title: "iPhone 17 全系发布", platform: "微博" }],
    embed: async () => null,
  });
  await watcher.addInterest("u1", "苹果手机", "brand");
  const n = await watcher.checkAll();
  assert.equal(n, 0);
});

test("语义兜底：INTEREST_SEMANTIC_MATCH=0 一键关闭", async () => {
  process.env.INTEREST_SEMANTIC_MATCH = "0";
  try {
    const pushed: string[] = [];
    let embedCalls = 0;
    const watcher = makeSemanticWatcher({
      hits: [{ title: "iPhone 17 全系发布", platform: "微博" }],
      embed: async (texts) => {
        embedCalls += 1;
        return toyEmbed(texts);
      },
      onHit: (_a, name, title) => pushed.push(`${name}→${title}`),
    });
    await watcher.addInterest("u1", "苹果手机", "brand");
    assert.equal(await watcher.checkAll(), 0);
    assert.equal(pushed.length, 0);
    assert.equal(embedCalls, 0, "关闭语义匹配后不应嵌入兴趣名或热搜标题");
  } finally {
    delete process.env.INTEREST_SEMANTIC_MATCH;
  }
});

test("语义兜底：与字面命中共用指纹去重/间隔闸", async () => {
  let ts = 1_000_000;
  let current: InterestHit[] = [{ title: "iPhone 17 全系发布", platform: "微博" }];
  const watcher = makeSemanticWatcher({
    hits: () => current,
    minPushIntervalMs: 2 * HOUR,
  });
  watcher.setOnHit(() => {});
  await watcher.addInterest("u1", "苹果手机", "brand");
  assert.equal(await watcher.checkAll(ts), 1, "首轮语义命中一条");
  assert.equal(await watcher.checkAll(ts + 60_000), 0, "间隔内同指纹不推");
  current = [{ title: "iPhone 17 Pro 曝光", platform: "知乎" }];
  assert.equal(await watcher.checkAll(ts + 60_000), 0, "间隔内换了新热点也不推（间隔闸优先）");
  assert.equal(await watcher.checkAll(ts + 3 * HOUR), 1, "间隔过后新热点（指纹不同）可再推");
  assert.equal(await watcher.checkAll(ts + 3 * HOUR + 60_000), 0, "同指纹不重复推");
});

test("cosineSimilarity：正交为零、同向为一、未归一向量正确除模", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([2, 0], [5, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
  assert.equal(cosineSimilarity([1], [1, 2]), 0, "维度不匹配按 0 处理");
});
