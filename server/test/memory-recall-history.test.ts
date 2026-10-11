/**
 * memory.recall_history（跨会话历史原文检索）单测（2026-10-10）。
 *
 * 背景：分类索引视图落地后，跨会话细节不常驻上下文，模型"知道有、查不了"。
 * 本文件锁定：
 *  - actor 隔离（只搜本 actor 名下线程，排除当前会话）；
 *  - 时间标签来自消息自带 [ts:] 前缀，缺省回退会话 updatedAt；
 *  - recap 摘要区 / system-reminder 注入块不算"历史原文"（跳过，防自引用）；
 *  - 相关度排序 + k 上限 + 空结果语义。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatThreadPersistence } from "../src/external-model/chat-thread-persist.js";
import {
  MEMORY_RECALL_CHAT_TOOLS,
  searchCrossSessionHistory,
} from "../src/tools/memory-recall-tools.js";

const TS = (dt: string) => `[ts:${dt}|周四|1d ago]`;

async function makePersistence(sessionsMain: object, sessionsNotes: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), "recall-history-"));
  const main = join(dir, "threads.json");
  const notes = join(dir, "threads-notes.json");
  await mkdir(dir, { recursive: true });
  await writeFile(main, JSON.stringify({ sessions: sessionsMain }));
  await writeFile(notes, JSON.stringify({ sessions: sessionsNotes }));
  const p = new ChatThreadPersistence(main, notes);
  await p.load();
  // Windows 上紧随文件写入的递归删除偶发 ENOTEMPTY（句柄延迟释放），重试兜底
  const cleanup = async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  };
  return { p, cleanup };
}

const ACTOR = "u@x.com";

function baseSessions() {
  return {
    // 当前会话（应被排除）
    [ACTOR]: {
      updatedAt: "2026-10-09T21:38:00.000Z",
      messages: [
        { role: "user", content: `${TS("2026-10-09 21:37:00")}今天晚上吃什么好呢` },
      ],
    },
    // 更早的主会话线程（master: 前缀）
    [`master:${ACTOR}`]: {
      updatedAt: "2026-10-08T14:10:00.000Z",
      messages: [
        { role: "system", content: "sys 应被忽略" },
        {
          role: "assistant",
          content:
            "[session-recap]\nEarlier conversation recap:\n- [2026/10/08 22:07] 用户表示好饿（摘要区不算原文，应跳过）",
        },
        {
          role: "user",
          content: `${TS("2026-10-08 22:07:00")}好饿，还没决定今晚吃什么`,
        },
        {
          role: "assistant",
          content: `${TS("2026-10-08 22:08:00")}附近有家火锅评分不错，要不要看看？`,
        },
        {
          role: "user",
          content: `<system-reminder>注入块不算原文，应跳过</system-reminder>顺便帮我记一下周三要还书`,
        },
      ],
    },
    // 主动会话线程
    [`proactive:${ACTOR}:1791542304532`]: {
      updatedAt: "2026-10-07T09:00:00.000Z",
      messages: [
        {
          role: "assistant",
          content: `${TS("2026-10-07 09:00:00")}提醒：你之前说好饿，让我帮你盯着兴义的火锅团购`,
        },
      ],
    },
    // 笔记线程（独立文件）
    [`notes:${ACTOR}`]: {
      updatedAt: "2026-10-05T10:00:00.000Z",
      messages: [{ role: "user", content: "记一下：周三要去图书馆还书" }],
    },
    // 其他 actor（必须隔离）
    "other@x.com": {
      updatedAt: "2026-10-08T15:00:00.000Z",
      messages: [{ role: "user", content: `${TS("2026-10-08 15:00:00")}好饿想吃火锅` }],
    },
  };
}

test("recall_history：跨会话命中、排除当前会话（裸 key）、master 历史线程可回查", async () => {
  const { p, cleanup } = await makePersistence(baseSessions());
  try {
    const hits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: ACTOR,
      query: "好饿 吃什么",
      k: 10,
    });
    // 运行时语义：裸 actorId=当前活跃线程（排除）；master:{actorId}=boot migrate
    // 合并出的历史线程（正当回查目标，不排除）。
    assert.ok(hits.every((h) => h.sessionId !== ACTOR), "当前活跃线程（裸 key）必须被排除");
    assert.ok(hits.length >= 2, `应命中更早会话的原文：${JSON.stringify(hits)}`);
    assert.ok(
      hits.every((h) => !h.text.includes("其他@x") && h.sessionId !== "other@x.com"),
      "不得跨 actor 泄漏",
    );
    assert.ok(hits.some((h) => h.sessionKind === "主动会话"), "主动会话线程应可检索");
    assert.ok(hits.some((h) => h.text.includes("好饿")), "应命中历史原话");
    assert.ok(hits.every((h) => !h.text.includes("[session-recap]")), "摘要区不算原文");
    assert.ok(hits.every((h) => !h.text.includes("system-reminder")), "注入块不算原文");
  } finally {
    await cleanup();
  }
});

test("recall_history：时间标签来自消息 [ts:] 前缀；notes 独立文件可检索", async () => {
  const { p, cleanup } = await makePersistence(baseSessions());
  try {
    const hits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: ACTOR,
      query: "火锅",
      k: 5,
    });
    assert.ok(hits.length > 0);
    const withTs = hits.find((h) => h.text.includes("好饿") || h.text.includes("团购"));
    assert.ok(withTs, `应命中带时间戳的历史消息：${JSON.stringify(hits)}`);
    assert.match(withTs!.time, /^2026-10-0[78] \d{2}:\d{2}$/, `时间应取自 [ts:] 前缀：${withTs!.time}`);
    const noteHit = hits.find((h) => h.sessionKind === "笔记");
    assert.ok(!noteHit, "火锅 query 不应命中笔记（相关性隔离）");
    const noteHits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: ACTOR,
      query: "图书馆 还书",
      k: 5,
    });
    assert.ok(noteHits.some((h) => h.sessionKind === "笔记"), "notes 独立文件的线程应可检索");
  } finally {
    await cleanup();
  }
});

test("recall_history：无时间戳消息回退会话 updatedAt；k 上限与空结果", async () => {
  const { p, cleanup } = await makePersistence({
    [`master:${ACTOR}`]: {
      updatedAt: "2026-10-01T08:30:00.000Z",
      messages: [{ role: "user", content: "裸消息没有时间戳，讨论一下投影仪的选购" }],
    },
  });
  try {
    const hits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: "another-session@x.com",
      query: "投影仪 选购",
      k: 5,
    });
    assert.equal(hits.length, 1);
    // updatedAt 为 UTC ISO，formatTime 按本地时区（GMT+8）渲染。
    // 回退时间必须带「约」前缀（2026-10-10 真实探针：线程 updatedAt 渲染成
    // 精确时刻会把旧消息显示成"刚刚"，诱导「刚才你说」式错位）。
    assert.equal(hits[0]!.time, "约 2026-10-01 16:30", "无 ts 时回退 updatedAt 且带「约」前缀");
    assert.equal(hits[0]!.timeSource, "session", "时间来源应标注为 session（粗粒度）");

    const none = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: "another-session@x.com",
      query: "完全无关的查询词",
      k: 5,
    });
    assert.equal(none.length, 0, "无命中返回空数组");
  } finally {
    await cleanup();
  }
});

test("recall_history：相关度排序（命中多的在前）+ k 截断", async () => {
  const { p, cleanup } = await makePersistence({
    [`master:${ACTOR}`]: {
      updatedAt: "2026-10-08T14:10:00.000Z",
      messages: [
        { role: "user", content: `${TS("2026-10-08 10:00:00")}火锅` },
        { role: "user", content: `${TS("2026-10-08 11:00:00")}火锅 火锅 好饿想吃火锅` },
        { role: "user", content: `${TS("2026-10-08 12:00:00")}火锅 火锅` },
      ],
    },
  });
  try {
    const hits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: "another-session@x.com",
      query: "火锅",
      k: 2,
    });
    assert.equal(hits.length, 2, "k 截断生效");
    assert.ok(hits[0]!.score >= hits[1]!.score, "按相关度降序");
    assert.ok(hits[0]!.text.includes("好饿想吃火锅"), "命中最多的排最前");
  } finally {
    await cleanup();
  }
});

test("工具定义：MEMORY_RECALL_CHAT_TOOLS 含 episodic 与 history 两个常驻工具", () => {
  const names = MEMORY_RECALL_CHAT_TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ["memory.recall_episodic", "memory.recall_history"]);
  const history = MEMORY_RECALL_CHAT_TOOLS[1]!.function;
  assert.match(history.description, /跨会话/);
  assert.match(history.description, /不要凭印象把旧事说成/);
  assert.deepEqual(history.parameters.required, ["query"]);
});

test("recall_history：exclude 裸 actorId 时 master: 历史线程仍可检索（运行时形态）", async () => {
  // 真实运行时：裸 key=当前活跃线程（运行中写入），master: key=上次退出前的
  // 历史合并线程。排除当前会话只应屏蔽裸 key，master 历史应能被回查。
  const { p, cleanup } = await makePersistence({
    [ACTOR]: {
      updatedAt: "2026-10-08T14:09:00.000Z",
      messages: [{ role: "user", content: "占位：load 时会被 migrate 合并进 master" }],
    },
    [`master:${ACTOR}`]: {
      updatedAt: "2026-10-08T14:10:00.000Z",
      messages: [
        { role: "user", content: `${TS("2026-10-08 22:07:00")}好饿，还没决定今晚吃什么` },
      ],
    },
  });
  // 模拟运行中当前会话再次以裸 key 落盘（load 的 migrate 已把启动时的裸 key
  // 合并进 master 并删除）——真实运行中「裸 key=活跃线程 + master=历史」并存。
  (
    p as unknown as {
      data: { sessions: Record<string, { updatedAt: string; messages: unknown[] }> };
    }
  ).data.sessions[ACTOR] = {
    updatedAt: "2026-10-10T01:00:00.000Z",
    messages: [{ role: "user", content: "刚才这句话是本会话的，不应出现在跨会话结果里" }],
  };
  try {
    const hits = searchCrossSessionHistory(p, {
      actorId: ACTOR,
      excludeSessionId: ACTOR,
      query: "好饿 吃什么",
      k: 10,
    });
    assert.ok(
      hits.every((h) => h.sessionId !== ACTOR),
      "裸 key（当前活跃线程）必须被排除",
    );
    assert.ok(hits.length === 1, `master 历史线程应可回查：${JSON.stringify(hits)}`);
    assert.equal(hits[0]!.sessionId, `master:${ACTOR}`);
    assert.ok(hits[0]!.text.includes("好饿"));
    assert.equal(hits[0]!.time, "2026-10-08 22:07", "时间取自 [ts:] 前缀（不带「约」）");
    assert.equal(hits[0]!.timeSource, "message", "消息自带时间戳时来源为 message");
  } finally {
    await cleanup();
  }
});
