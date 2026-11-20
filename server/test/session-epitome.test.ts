import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionEpitomeStore,
  SessionEpitomeTurnGate,
  classifyEpitomeLine,
  extractEpitomeEntries,
  loadSessionEpitomeEveryNTurns,
  EPITOME_KV_KEY,
  type EpitomeKvLike,
  type EpitomeTurnSnapshot,
} from "../src/services/session-epitome.js";
import type { MemoryItem } from "../src/brain/types.js";

function makeWrite(content: string, kind = "experience" as const): MemoryItem {
  return {
    actorId: "a1",
    kind,
    content,
    source: "chat",
    timestamp: new Date().toISOString(),
  };
}

/** 内存 KV 适配器 mock。 */
function makeMockKv(): {
  kv: EpitomeKvLike;
  persisted: Map<string, { revision: number; entries: Record<string, unknown> }>;
} {
  const persisted = new Map<string, { revision: number; entries: Record<string, unknown> }>();
  const kv: EpitomeKvLike = {
    getSnapshot(actorId, keys) {
      const raw = persisted.get(actorId);
      if (!raw) return null;
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw.entries)) {
        if (!keys || keys.includes(k)) entries[k] = v;
      }
      return { revision: raw.revision, entries };
    },
    setEntry(actorId, key, value) {
      const raw = persisted.get(actorId) ?? { revision: 0, entries: {} };
      raw.revision += 1;
      raw.entries[key] = value;
      persisted.set(actorId, raw);
    },
  };
  return { kv, persisted };
}

// ── 行归类 ─────────────────────────────────────────────

test("classifyEpitomeLine: 请求语义 → open_loop", () => {
  assert.equal(classifyEpitomeLine("帮我订北京回程的高铁票"), "open_loop");
  assert.equal(classifyEpitomeLine("下周三提醒我开会"), "open_loop");
});

test("classifyEpitomeLine: Agent 承诺 → commitment", () => {
  assert.equal(classifyEpitomeLine("已为你设置明天的提醒"), "commitment");
  assert.equal(classifyEpitomeLine("[Agent 承诺/结论] 已帮你记录出差安排"), "commitment");
});

test("classifyEpitomeLine: 偏好/记住 → preference", () => {
  assert.equal(classifyEpitomeLine("我喜欢吃素食"), "preference");
  assert.equal(classifyEpitomeLine("[用户要求记住] 生日是 3 月 8 日"), "preference");
});

test("classifyEpitomeLine: 短文本或无信号 → null", () => {
  assert.equal(classifyEpitomeLine("好的"), null);
  assert.equal(classifyEpitomeLine(""), null);
});

// ── 写入侧行体检（2026-11-20 根修：生产脏行回归，判据全部结构性）──────────────

test("classifyEpitomeLine: 协议残留行 → null", () => {
  assert.equal(classifyEpitomeLine("委派子 Agent 处理：还有我的生日是6月18"), null);
  assert.equal(classifyEpitomeLine("委派子Agent处理:记得我叫什么吗"), null);
});

test("classifyEpitomeLine: 分类语义不变（回归护栏）", () => {
  // 语言层分类保持原样：疑问句/确认句仍按 MEMORY_EXPLICIT_RE 走 preference，
  // 不做语言层硬编码拦截——这里钉住行为，防止未来无意改动
  assert.equal(classifyEpitomeLine("还有我的生日是6月18"), "preference");
  assert.equal(classifyEpitomeLine("记一下，我妈的生日是每年5月20号"), "preference");
  assert.equal(classifyEpitomeLine("帮我打辆车去街心花园。"), "open_loop");
});

test("SessionEpitomeStore: 存量协议残留行读取时清洗并回写 KV", () => {
  const { kv, persisted } = makeMockKv();
  // 直接种入生产实证的脏快照（模拟写入侧洞补上之前的存量）
  persisted.set("a1", {
    revision: 7,
    entries: {
      [EPITOME_KV_KEY]: {
        openLoops: [
          { text: "帮我打辆车去街心花园。", createdAt: "2026-11-19T15:50:10.284Z" },
          { text: "委派子 Agent 处理：帮我打辆车去街心花园。", createdAt: "2026-11-19T15:50:10.284Z" },
        ],
        commitments: [],
        preferences: [
          { text: "记得我叫什么吗", createdAt: "2026-11-18T10:48:34.319Z" },
          { text: "委派子 Agent 处理：还有我的生日是6月18", createdAt: "2026-11-18T10:48:34.319Z" },
          { text: "还有我的生日是6月18", createdAt: "2026-11-18T10:48:34.319Z" },
        ],
        updatedAt: "2026-11-19T15:50:10.284Z",
        revision: 7,
      },
    },
  });
  const store = new SessionEpitomeStore(kv);
  const snap = store.get("a1");
  // 只剔结构性残留（委派协议行），语言层分类语义不动
  assert.deepEqual(snap.preferences, ["记得我叫什么吗", "还有我的生日是6月18"]);
  assert.deepEqual(snap.openLoops, ["帮我打辆车去街心花园。"]);
  // 回写验证：重新实例化（模拟重启）后读取的仍是清洗后的快照
  const reloaded = new SessionEpitomeStore(kv);
  assert.deepEqual(reloaded.get("a1").preferences, ["记得我叫什么吗", "还有我的生日是6月18"]);
  assert.deepEqual(reloaded.get("a1").openLoops, ["帮我打辆车去街心花园。"]);
});

// ── 提取 ─────────────────────────────────────────────

test("extractEpitomeEntries: 从 query + writes 提取三类", () => {
  const entries = extractEpitomeEntries(
    "帮我订北京回程的高铁票",
    [
      makeWrite("已为你创建明天的提醒"),
      makeWrite("[用户要求记住] 用户偏好素食"),
    ],
    "已为你订好高铁票",
  );
  assert.ok(entries.openLoops.length > 0, "应提取开放环路（用户请求）");
  assert.ok(entries.commitments.length > 0, "应提取承诺（Agent 回复/写入）");
  assert.ok(entries.preferences.length > 0, "应提取偏好");
});

test("extractEpitomeEntries: 去重且限量", () => {
  const entries = extractEpitomeEntries(
    "",
    Array.from({ length: 10 }, (_, i) => makeWrite(`帮我安排第${i}个任务`)),
  );
  assert.ok(entries.openLoops.length <= 6, "open loops 限量 6 条");
  const keys = entries.openLoops.map((l) => l.slice(0, 20));
  assert.equal(new Set(keys).size, keys.length, "不应有重复");
});

// ── 存储与持久化 ─────────────────────────────────────────────

test("SessionEpitomeStore: record 增量合并 + KV 持久化", () => {
  const { kv, persisted } = makeMockKv();
  const store = new SessionEpitomeStore(kv);
  store.record("a1", { openLoops: ["帮我订票"], commitments: [], preferences: [] });
  store.record("a1", { openLoops: ["记得还书"], commitments: ["已为你设置提醒"], preferences: [] });

  const snapshot = store.get("a1");
  assert.ok(snapshot.openLoops.includes("帮我订票"), "已有条目应保留（增量）");
  assert.ok(snapshot.openLoops.includes("记得还书"), "新条目应加入");
  assert.ok(snapshot.commitments.includes("已为你设置提醒"));

  // 重新加载（模拟重启）
  const reloaded = new SessionEpitomeStore(kv);
  const again = reloaded.get("a1");
  assert.ok(again.openLoops.includes("帮我订票"), "重新加载后应恢复持久化数据");
  assert.ok(persisted.get("a1")!.entries[EPITOME_KV_KEY], "应写入 KV");
});

test("SessionEpitomeStore: 无 KV 时内存态正常", () => {
  const store = new SessionEpitomeStore(null);
  store.record("a1", { openLoops: ["帮忙订北京回程的高铁票"], commitments: [], preferences: [] });
  assert.ok(store.get("a1").openLoops.includes("帮忙订北京回程的高铁票"));
});

test("SessionEpitomeStore: attach 动态绑定 KV", () => {
  const { kv, persisted } = makeMockKv();
  const store = new SessionEpitomeStore(null);
  store.record("a1", { openLoops: ["内存态待办事项一"], commitments: [], preferences: [] });
  store.attach(kv);
  store.record("a1", { openLoops: ["持久态待办事项二"], commitments: [], preferences: [] });
  assert.ok(persisted.has("a1"), "attach 后应写入 KV");
  const reloaded = new SessionEpitomeStore(kv);
  assert.ok(reloaded.get("a1").openLoops.includes("持久态待办事项二"));
});

// ── 轮次门控（降频改造）─────────────────────────────────

function snap(query: string, assistantText?: string): EpitomeTurnSnapshot {
  return { query, writes: [], assistantText };
}

test("SessionEpitomeTurnGate: 每 N 轮批量触发，中间轮不提取", () => {
  const gate = new SessionEpitomeTurnGate(3);
  assert.deepEqual(gate.registerTurn("a1", snap("帮我订第一轮的票")), [], "第 1 轮不提取");
  assert.deepEqual(gate.registerTurn("a1", snap("帮我查第二轮的天气")), [], "第 2 轮不提取");
  const batch = gate.registerTurn("a1", snap("记得第三轮还书", "已为你记录"));
  assert.equal(batch.length, 3, "第 3 轮（=N）应返回累积的 3 轮批次");
  assert.equal(batch[0].query, "帮我订第一轮的票", "批次应含最早残留轮次");
  assert.equal(batch[2].assistantText, "已为你记录", "批次应含最后一轮");
  // 触发后计数清零：再过 N 轮才再次触发
  assert.deepEqual(gate.registerTurn("a1", snap("第四轮")), [], "触发后重新计数");
  assert.deepEqual(gate.registerTurn("a1", snap("第五轮")), [], "触发后重新计数");
  assert.equal(gate.registerTurn("a1", snap("第六轮")).length, 3, "满 N 轮再次触发");
});

test("SessionEpitomeTurnGate: 会话边界兜底——新会话开场轮立即提取上一会话残留", () => {
  const gate = new SessionEpitomeTurnGate(5);
  // 上一会话 2 轮（未到 N，无提取）
  assert.deepEqual(gate.registerTurn("a1", snap("帮我订上一会话的票")), []);
  assert.deepEqual(gate.registerTurn("a1", snap("记得帮我跟进报销")), []);
  // 新会话开场轮：兜底提取（含本轮）
  const batch = gate.registerTurn("a1", snap("新会话第一轮"), { newSession: true });
  assert.equal(batch.length, 3, "兜底应返回上一会话残留 2 轮 + 本轮");
  assert.equal(batch[0].query, "帮我订上一会话的票", "上一会话第一轮残留应保留");
  assert.equal(batch[2].query, "新会话第一轮", "兜底批次应包含本轮");
});

test("SessionEpitomeTurnGate: 新会话开场但无残留时不触发（首轮空提取）", () => {
  const gate = new SessionEpitomeTurnGate(5);
  assert.deepEqual(
    gate.registerTurn("a1", snap("全新进程的首轮"), { newSession: true }),
    [],
    "无 pending 残留时边界信号不产生空批次",
  );
});

test("SessionEpitomeTurnGate: N=1 退化为每轮提取（兼容旧行为）", () => {
  const gate = new SessionEpitomeTurnGate(1);
  assert.equal(gate.registerTurn("a1", snap("第一轮")).length, 1);
  assert.equal(gate.registerTurn("a1", snap("第二轮")).length, 1);
});

test("SessionEpitomeTurnGate: actor 间计数互不干扰", () => {
  const gate = new SessionEpitomeTurnGate(2);
  assert.deepEqual(gate.registerTurn("a1", snap("a1 第 1 轮")), []);
  assert.deepEqual(gate.registerTurn("a2", snap("a2 第 1 轮")), []);
  const batchA2 = gate.registerTurn("a2", snap("a2 第 2 轮"));
  assert.equal(batchA2.length, 2, "a2 满 2 轮触发");
  assert.ok(batchA2.every((t) => t.query.startsWith("a2")), "批次只含 a2 自己的轮次");
});

test("loadSessionEpitomeEveryNTurns: env 解析与默认值", () => {
  assert.equal(loadSessionEpitomeEveryNTurns(), 5, "默认 5");
  process.env.SESSION_EPITOME_EVERY_N_TURNS = "8";
  try {
    assert.equal(loadSessionEpitomeEveryNTurns(), 8, "合法整数生效");
    process.env.SESSION_EPITOME_EVERY_N_TURNS = "abc";
    assert.equal(loadSessionEpitomeEveryNTurns(), 5, "非法值回退默认 5");
    process.env.SESSION_EPITOME_EVERY_N_TURNS = "0";
    assert.equal(loadSessionEpitomeEveryNTurns(), 5, "<1 回退默认 5");
  } finally {
    delete process.env.SESSION_EPITOME_EVERY_N_TURNS;
  }
});
