/**
 * 用户理解档案（User Understanding Store）单测 + 理解写入全链路贯通测试。
 *
 * 设计立场：记忆的最小有价值单元是「agent 对对话的理解」（含语气与性质判断），
 * 不是字面事实。例：用户说"我的老婆是刘浩存"（刘浩存为明星）→
 *   { topic: "老婆", kind: "fandom",
 *     note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系" }
 *
 * 覆盖：
 *   1. 理解档案：topic 级 upsert（新理解生效/同义确认/旧理解入演变历史）
 *   2. 问句主题寻址 + 理解块渲染（含演变历史）
 *   3. 统一抽取：understandings 协议解析（kind 校验）
 *   4. ingest 钩子贯通：understandings → Mem0WriteEvent
 *   5. 统一写入者贯通：低信号候选 → extractUnified → writeDecided(unified)
 *   6. 五维评分闸门贯通：无用消息（LLM 误标 remember）不落长期库
 *
 * 测试封闭：临时 SQLite / fake Mem0 / fake LLM 客户端，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UserUnderstandingStore,
  normalizeUnderstandingKind,
} from "../src/agentic-memory/user-understanding-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  normalize,
  parseJsonObject,
} from "../src/agentic-memory/unified-extractor.js";
import { AgenticMemoryIngestService } from "../src/agentic-memory/ingest.js";
import {
  MemoryConsolidationService,
  resetMemoryConsolidationForTests,
} from "../src/services/memory-consolidation-service.js";
import { resetMemoryEchoGuard } from "../src/services/memory-echo-guard.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";
import type { Memory } from "mem0ai/oss";

async function withStore(fn: (store: UserUnderstandingStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "user-understanding-"));
  const store = new UserUnderstandingStore(openAgenticSqlite(join(dir, "understanding.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ============================================================
// 1. topic 级 upsert（当前理解权威 + 演变历史）
// ============================================================

test("applyUnderstanding: 新话题入档；同义理解确认不重复", async () => {
  await withStore(async (store) => {
    const first = store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
      kind: "fandom",
      sourceRef: "chat:turn-1",
    });
    assert.ok(first);
    assert.equal(first.changed, true);
    assert.equal(first.note.kind, "fandom");
    assert.deepEqual(first.previous, []);

    const again = store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
      kind: "fandom",
    });
    assert.ok(again);
    assert.equal(again.changed, false);
    assert.equal(again.note.id, first.note.id);
    assert.equal(store.getActiveUnderstandings("user-1").length, 1);
  });
});

test("applyUnderstanding: 理解修订时旧理解入历史（不删除，可追溯）", async () => {
  await withStore(async (store) => {
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户提到过喜欢景甜",
      kind: "preference",
    });
    const revised = store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户改口说'老婆'是刘浩存（此前说是景甜）——仍是粉丝式称呼",
      kind: "correction",
    });
    assert.ok(revised);
    assert.equal(revised.changed, true);
    assert.equal(revised.previous.length, 1);
    assert.equal(revised.previous[0]!.note, "用户提到过喜欢景甜");

    // 活跃理解只剩当前值；历史沿链可回溯
    const actives = store.getActiveUnderstandings("user-1");
    assert.equal(actives.length, 1);
    assert.equal(actives[0]!.kind, "correction");
    const history = store.getHistoryFor("user-1", actives[0]!.id, 2);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.note, "用户提到过喜欢景甜");
  });
});

test("applyUnderstanding: 空/超长 topic 与 note 拒绝入档", async () => {
  await withStore(async (store) => {
    assert.equal(store.applyUnderstanding({ actorId: "user-1", topic: "  ", note: "x" }), null);
    assert.equal(store.applyUnderstanding({ actorId: "user-1", topic: "老婆", note: "  " }), null);
    assert.equal(
      store.applyUnderstanding({ actorId: "user-1", topic: "老婆", note: "一".repeat(201) }),
      null,
    );
  });
});

test("normalizeUnderstandingKind: 非法 kind 归为 other", () => {
  assert.equal(normalizeUnderstandingKind("fandom"), "fandom");
  assert.equal(normalizeUnderstandingKind("haha"), "other");
  assert.equal(normalizeUnderstandingKind(42), "other");
});

// ============================================================
// 2. 问句寻址 + 理解块渲染
// ============================================================

test("matchTopicsInText: 问句命中话题词直达当前理解", async () => {
  await withStore(async (store) => {
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼",
      kind: "fandom",
    });
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "工作",
      note: "用户在做后端开发",
      kind: "literal",
    });

    const matched = store.matchTopicsInText("user-1", "你知道我老婆是谁吗");
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.topic, "老婆");
    assert.ok(matched[0]!.note.includes("粉丝式"));
    assert.equal(store.matchTopicsInText("user-1", "今天天气怎么样").length, 0);
  });
});

test("renderForPrompt: 渲染理解块，命中主题带寻址标记，修订附演变历史", async () => {
  await withStore(async (store) => {
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户提到过喜欢景甜",
      kind: "preference",
    });
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "老婆",
      note: "用户改口说'老婆'是刘浩存——粉丝式称呼，并非真实关系",
      kind: "correction",
    });
    store.applyUnderstanding({
      actorId: "user-1",
      topic: "居住地",
      note: "用户住在杭州",
      kind: "literal",
    });

    const block = store.renderForPrompt("user-1", new Set(["老婆"]));
    assert.ok(block);
    assert.ok(block!.includes("【Agent 对用户的理解】"));
    // 人称视角铁律：块头不得以「我」开头（与用户第一人称记忆条目混淆）
    assert.ok(!block!.includes("【我对用户的理解】"));
    assert.ok(block!.includes("不要当作真实事实转述"));
    assert.ok(block!.includes("用户改口说'老婆'是刘浩存"));
    assert.ok(block!.includes("← 本轮提问相关，基于此理解回答"));
    assert.ok(block!.includes("理解演变：此前理解「用户提到过喜欢景甜」"));
    // 未命中的主题不带寻址标记
    assert.ok(!block!.includes("用户住在杭州 ←"));
    assert.equal(store.renderForPrompt("user-none"), null);
  });
});

test("purgeActor: 隐私清理移除该 actor 全部理解", async () => {
  await withStore(async (store) => {
    store.applyUnderstanding({ actorId: "user-1", topic: "老婆", note: "用户的'老婆'是刘浩存（粉丝式）" });
    assert.equal(store.purgeActor("user-1") > 0, true);
    assert.equal(store.getActiveUnderstandings("user-1").length, 0);
  });
});

// ============================================================
// 3. 统一抽取 understandings 协议
// ============================================================

test("normalize: 解析 understandings（非法 kind 归 other，丢弃缺字段项）", () => {
  const raw = parseJsonObject(
    JSON.stringify({
      decision: "remember",
      semanticClass: "人物",
      memories: ["用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼）"],
      commitments: [],
      corrections: [],
      understandings: [
        {
          topic: "老婆",
          note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
          kind: "fandom",
          confidence: 0.95,
        },
        { topic: "居住地", note: "用户住在杭州" },
        { topic: "", note: "缺话题" },
        { topic: "生日", note: "", kind: "literal" },
        { topic: "宠物", note: "用户养了金毛", kind: "不是合法kind" },
      ],
    }),
  );
  assert.ok(raw);
  const result = normalize(raw);
  assert.ok(result);
  assert.equal(result.understandings.length, 3);
  assert.equal(result.understandings[0]!.kind, "fandom");
  assert.equal(result.understandings[0]!.confidence, 0.95);
  assert.equal(result.understandings[1]!.kind, "other"); // 缺 kind → other
  assert.equal(result.understandings[2]!.kind, "other"); // 非法 kind → other
});

// ============================================================
// 4. ingest 钩子贯通：understandings 经 Mem0WriteEvent 到达钩子
// ============================================================

test("persistUnifiedExtraction: memories infer:false 直存 + 钩子携带 understandings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "understanding-ingest-"));
  try {
    const added: Array<{ content: string; infer: boolean }> = [];
    const fakeMemory = {
      async add(entries: Array<{ content: string }>, opts: { infer?: boolean }) {
        for (const e of entries) added.push({ content: e.content, infer: opts?.infer !== false });
        return { results: [{ id: "mem0-1", memory: entries[0]!.content }] };
      },
    } as unknown as Memory;
    const ingest = new AgenticMemoryIngestService(fakeMemory);

    let hookUnderstandings: Array<{ topic: string; kind: string }> | undefined = undefined;
    ingest.addWriteHook((event) => {
      hookUnderstandings = event.understandings;
    });

    await ingest.persistUnifiedExtraction(
      "user-1",
      "chat:turn-9",
      {
        decision: "remember",
        semanticClass: "人物",
        memories: ["用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼）"],
        commitments: [],
        corrections: [],
        understandings: [
          {
            topic: "老婆",
            note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
            kind: "fandom",
            confidence: 0.97,
          },
        ],
        facts: [],
      },
      "main",
      false,
    );

    assert.equal(added[0]!.infer, false); // 抽取产物直存，不再二次 infer
    assert.ok(hookUnderstandings);
    assert.equal(hookUnderstandings![0]!.topic, "老婆");
    assert.equal(hookUnderstandings![0]!.kind, "fandom");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("persistUnifiedExtraction: reject 决策记忆不落库，understandings 仍进钩子", async () => {
  const fakeMemory = {
    async add() {
      throw new Error("reject 路径不应落库");
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(fakeMemory);
  let hookUnderstandings: Array<{ topic: string }> | undefined;
  ingest.addWriteHook((event) => {
    hookUnderstandings = event.understandings;
  });

  const results = await ingest.persistUnifiedExtraction(
    "user-1",
    "chat:turn-10",
    {
      decision: "reject",
      memories: [],
      commitments: [],
      corrections: [],
      understandings: [{ topic: "宠物", note: "用户提到想养金毛", kind: "other" }],
      facts: [],
    },
    "main",
    false,
  );
  assert.equal(results.length, 0);
  assert.ok(hookUnderstandings);
  assert.equal(hookUnderstandings![0]!.topic, "宠物");
});

// ============================================================
// 5. 统一写入者贯通：低信号候选 → extractUnified → writeDecided(unified)
// ============================================================

test("统一写入者: 低信号闲聊（'我老婆是刘浩存'）走统一抽取产出理解", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-understanding-"));
  try {
    const unifiedCalls: Array<unknown> = [];
    const port: NarrativeMemoryPort = {
      async ingest() {},
      async writeDecided(
        _actorId: string,
        _text: string,
        _source: string,
        _opts: { context: string; highSignal: boolean },
        unified?: {
          understandings: Array<{ topic: string; note: string; kind: string }>;
          memories: string[];
        },
      ) {
        unifiedCalls.push(unified);
      },
      async buildNarrativeRecall() {
        return "";
      },
      async buildCrossContextRecall() {
        return "";
      },
      async buildDetailedRecall() {
        return "";
      },
      async buildSourceRecall() {
        return "";
      },
      async runSleepConsolidation() {
        return [];
      },
      async selfCheck() {
        return { exists: false, domainId: null, confidence: 0 };
      },
      getTelemetrySnapshot() {
        return {};
      },
    };
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync: null,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });
    // 模拟理解型抽取：memories 保留语气与性质，understandings 带 kind=fandom
    service.setUnifiedClient({
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "remember",
                      semanticClass: "人物",
                      memories: ["用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼，并非真实关系）"],
                      commitments: [],
                      corrections: [],
                      understandings: [
                        {
                          topic: "老婆",
                          note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
                          kind: "fandom",
                          confidence: 0.92,
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    });

    service.submitCandidate({
      actorId: "actor-x",
      text: "对了，我老婆是刘浩存",
      source: "chat:turn_archive",
      context: "main",
      highSignal: false, // 低信号闲聊：识别交给 LLM，不靠关键词
      createdAt: new Date().toISOString(),
    });
    await service.flushAll();

    assert.equal(unifiedCalls.length, 1);
    const unified = unifiedCalls[0] as {
      understandings: Array<{ topic: string; note: string; kind: string }>;
      memories: string[];
    };
    assert.equal(unified.understandings[0]!.topic, "老婆");
    assert.equal(unified.understandings[0]!.kind, "fandom");
    // memories 也保留理解（粉丝式标注），不是字面断言
    assert.ok(unified.memories[0]!.includes("粉丝式"));
  } finally {
    resetMemoryConsolidationForTests();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ============================================================
// 6. 五维评分闸门贯通：无用消息（LLM 误标 remember）不落长期库
// ============================================================

test("统一写入者: 无用消息（天气寒暄，LLM 误标 remember）被评分闸门拦截", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-gate-"));
  try {
    const writeCalls: Array<unknown> = [];
    const port: NarrativeMemoryPort = {
      async ingest() {},
      async writeDecided(...args: Array<unknown>) {
        writeCalls.push(args);
      },
      async buildNarrativeRecall() {
        return "";
      },
      async buildCrossContextRecall() {
        return "";
      },
      async buildDetailedRecall() {
        return "";
      },
      async buildSourceRecall() {
        return "";
      },
      async runSleepConsolidation() {
        return [];
      },
      async selfCheck() {
        return { exists: false, domainId: null, confidence: 0 };
      },
      getTelemetrySnapshot() {
        return {};
      },
    };
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync: null,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });
    // 模拟 LLM 手松：天气闲聊被误标 remember，但五维分暴露低持久+低影响
    service.setUnifiedClient({
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "remember",
                      semanticClass: "事件",
                      memories: ["用户说今天天气很好"],
                      commitments: [],
                      corrections: [],
                      understandings: [],
                      scores: { persistence: 0.05, frequency: 0.1, emotion: 0.3, impact: 0.05, certainty: 0.8 },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    });

    service.submitCandidate({
      actorId: "actor-x",
      text: "今天天气真好啊",
      source: "chat:turn_archive",
      context: "main",
      highSignal: false,
      createdAt: new Date().toISOString(),
    });
    await service.flushAll();

    // 综合分 ≈0.24 < 无用线 0.3 → reject：长期库出口零调用（不植入）
    assert.equal(writeCalls.length, 0);
  } finally {
    resetMemoryConsolidationForTests();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
