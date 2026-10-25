/**
 * 结构化事实库（Structured Fact Store）单测 + 实时更新链路贯通测试。
 *
 * 定位：记忆三层架构（向量库 / 知识图谱 / 结构化事实库）的第三层——
 * 确定性高、字段固定的用户信息（称呼/职业/居住地/技术栈…），KV 式精确
 * 寻址，实时更新（latest-wins + 演变历史），不做语义检索。
 *
 * 覆盖：
 *   1. 事实库：字段级 upsert（新字段/同值确认/换值覆盖 + 演变历史）
 *   2. 字段别名归一（名字→称呼、住址→居住地）+ 非法输入拒绝 + 匿名身份拦截
 *   3. 精确寻址：getFact / 问句字段命中 + 事实块渲染（寻址标记 + 演变历史）
 *   4. 统一抽取：facts 协议解析（非法项丢弃、confidence 截断）
 *   5. ingest 钩子贯通：facts → Mem0WriteEvent（高信号直写 / reject 旁路 /
 *      低信号 orphan 三条路径）
 *
 * 测试封闭：临时 SQLite / fake Mem0 / fake LLM 客户端，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  StructuredFactStore,
  canonicalFactField,
  normalizeFactField,
} from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  normalize,
  parseJsonObject,
} from "../src/agentic-memory/unified-extractor.js";
import { AgenticMemoryIngestService } from "../src/agentic-memory/ingest.js";
import type { Memory } from "mem0ai/oss";

async function withStore(fn: (store: StructuredFactStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ============================================================
// 1. 字段级 upsert（当前值权威 + 演变历史）
// ============================================================

test("applyFact: 新字段入档；同值确认不重复", async () => {
  await withStore(async (store) => {
    const first = store.applyFact({
      actorId: "user-1",
      field: "称呼",
      value: "张三",
      sourceRef: "chat:turn-1",
      confidence: 0.95,
    });
    assert.ok(first);
    assert.equal(first.changed, true);
    assert.equal(first.fact.value, "张三");
    assert.deepEqual(first.previous, []);

    const again = store.applyFact({ actorId: "user-1", field: "称呼", value: "张三" });
    assert.ok(again);
    assert.equal(again.changed, false);
    assert.equal(again.fact.id, first.fact.id);
    assert.equal(store.getActiveFacts("user-1").length, 1);
  });
});

test("applyFact: 换值覆盖（latest-wins），旧值入演变历史可追溯", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "居住地", value: "杭州" });
    const moved = store.applyFact({ actorId: "user-1", field: "居住地", value: "上海" });
    assert.ok(moved);
    assert.equal(moved.changed, true);
    assert.equal(moved.fact.value, "上海");
    assert.equal(moved.previous.length, 1);
    assert.equal(moved.previous[0]!.value, "杭州");

    // 活跃事实只剩当前值；历史沿链可回溯
    const actives = store.getActiveFacts("user-1");
    assert.equal(actives.length, 1);
    assert.equal(actives[0]!.value, "上海");
    const history = store.getHistoryFor("user-1", actives[0]!.id, 2);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.value, "杭州");
  });
});

test("applyFact: 同字段不同别名写法归并到同一行（别名归一）", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "名字", value: "张三" });
    store.applyFact({ actorId: "user-1", field: "姓名", value: "张三" });
    store.applyFact({ actorId: "user-1", field: "住址", value: "杭州" });
    store.applyFact({ actorId: "user-1", field: "所在地", value: "杭州" });
    const actives = store.getActiveFacts("user-1");
    assert.equal(actives.length, 2);
    const fields = actives.map((f) => f.field).sort();
    assert.deepEqual(fields, ["居住地", "称呼"]);
  });
});

test("applyFact: 空/超长值与匿名身份拒绝入档", async () => {
  await withStore(async (store) => {
    assert.equal(store.applyFact({ actorId: "user-1", field: "称呼", value: "  " }), null);
    assert.equal(store.applyFact({ actorId: "user-1", field: "", value: "张三" }), null);
    assert.equal(
      store.applyFact({ actorId: "user-1", field: "称呼", value: "一".repeat(81) }),
      null,
    );
    assert.equal(store.applyFact({ actorId: "anonymous", field: "称呼", value: "张三" }), null);
  });
});

test("canonicalFactField: 规范化与别名映射", () => {
  assert.equal(canonicalFactField(" 名字 "), "称呼");
  assert.equal(canonicalFactField("技术栈"), "技术栈");
  assert.equal(canonicalFactField("未知字段"), "未知字段");
  assert.equal(normalizeFactField("称呼："), "称呼");
  assert.equal(canonicalFactField("   "), "");
});

// ============================================================
// 1.5 主流对齐（2026-10-11）：字段级遗忘 + 低置信标注
// ============================================================

test("clearFact: 字段级遗忘（用户明确要求忘掉）supersede 下线，历史可追溯", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "居住地", value: "杭州" });
    store.applyFact({ actorId: "user-1", field: "居住地", value: "上海" });
    store.applyFact({ actorId: "user-1", field: "职业", value: "全栈开发" });

    const cleared = store.clearFact("user-1", "住址"); // 别名归一 → 居住地
    assert.equal(cleared, 1);
    assert.equal(store.getFact("user-1", "居住地"), null);
    // 其它字段不受牵连
    assert.equal(store.getFact("user-1", "职业")?.value, "全栈开发");
    // 历史行仍可追溯（非物理删除）
    const actives = store.getActiveFacts("user-1");
    assert.equal(actives.length, 1);
    assert.equal(store.stats("user-1").superseded, 2);
    // 再清一次：无可下线条目返回 0；非法字段返回 null
    assert.equal(store.clearFact("user-1", "居住地"), 0);
    assert.equal(store.clearFact("user-1", ""), null);
    assert.equal(store.clearFact("", "居住地"), null);
  });
});

test("renderForPrompt: 低置信条目带「不要把话说满」标注，高置信不带", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "居住地", value: "兴义", confidence: 0.9 });
    store.applyFact({ actorId: "user-1", field: "生日", value: "3 月 15 日", confidence: 0.4 });

    const block = store.renderForPrompt("user-1");
    assert.ok(block);
    assert.ok(block!.includes("- 居住地：兴义"));
    // 高置信条目不带标注
    const locationLine = block!
      .split("\n")
      .find((l) => l.startsWith("- 居住地："));
    assert.ok(locationLine);
    assert.ok(!locationLine!.includes("置信度低"));
    // 低置信条目有标注（断言标注紧跟在生日行）
    const birthdayLine = block!
      .split("\n")
      .find((l) => l.startsWith("- 生日："));
    assert.ok(birthdayLine);
    assert.ok(birthdayLine!.includes("置信度低"));
    assert.ok(birthdayLine!.includes("不要把话说满"));
  });
});

test("normalize: 解析 forget（用户明确要求忘掉的字段），reject 决策下清空", () => {
  const raw = parseJsonObject(
    JSON.stringify({
      decision: "remember",
      memories: ["用户要求忘掉居住地"],
      commitments: [],
      corrections: [],
      understandings: [],
      facts: [],
      forget: ["居住地", "生日", "  ", "一个超过十六个字符长度限制的字段名会被截断"],
    }),
  );
  assert.ok(raw);
  const result = normalize(raw);
  assert.ok(result);
  assert.equal(result.forget.length, 3);
  assert.deepEqual(result.forget, ["居住地", "生日", "一个超过十六个字符长度限制的字段"]);

  const rejected = normalize({
    decision: "reject",
    memories: [],
    commitments: [],
    corrections: [],
    understandings: [],
    facts: [],
    forget: ["居住地"],
  });
  assert.ok(rejected);
  // forget 是动作指令不随 reject 丢弃：「别记我家在哪了」常被判 reject，
  // 但遗忘恰恰要在这轮执行（与 commitments/corrections 同等地位）
  assert.deepEqual(rejected.forget, ["居住地"]);
});

// ============================================================
// 2. 精确寻址 + 事实块渲染
// ============================================================

test("getFact: 单字段精确取值（KV 语义，无向量检索）", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "职业", value: "全栈开发" });
    store.applyFact({ actorId: "user-1", field: "技术栈", value: "TS/Python" });
    assert.equal(store.getFact("user-1", "职业")?.value, "全栈开发");
    assert.equal(store.getFact("user-1", "职位")?.value, "全栈开发"); // 别名命中
    assert.equal(store.getFact("user-1", "生日"), null);
    assert.equal(store.getFact("user-none", "职业"), null);
  });
});

test("matchFieldsInText: 问句命中字段名直达当前值；单字字段不参与命中", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "职业", value: "全栈开发" });
    store.applyFact({ actorId: "user-1", field: "猫", value: "橘猫" }); // 单字字段

    const matched = store.matchFieldsInText("user-1", "我是做什么工作的？");
    assert.equal(matched.length, 0); // 问句没含「职业」二字 → 不命中（靠注入块兜底）

    const hit = store.matchFieldsInText("user-1", "我的职业是什么");
    assert.equal(hit.length, 1);
    assert.equal(hit[0]!.field, "职业");
    assert.equal(store.matchFieldsInText("user-1", "今天天气怎么样").length, 0);
  });
});

test("renderForPrompt: 渲染事实块，命中字段带寻址标记，换值附演变历史", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "居住地", value: "杭州" });
    store.applyFact({ actorId: "user-1", field: "居住地", value: "上海" });
    store.applyFact({ actorId: "user-1", field: "职业", value: "全栈开发" });

    const block = store.renderForPrompt("user-1", new Set(["职业"]));
    assert.ok(block);
    assert.ok(block!.includes("【用户档案·结构化事实】"));
    assert.ok(block!.includes("确定性高于其他记忆来源"));
    assert.ok(block!.includes("- 职业：全栈开发"));
    assert.ok(block!.includes("- 居住地：上海"));
    assert.ok(block!.includes("（此前：杭州"));
    assert.ok(block!.includes("← 本轮提问相关，基于此回答"));
    // 未命中的字段不带寻址标记
    const idx = block!.indexOf("居住地：上海");
    assert.ok(!block!.slice(idx, idx + 30).includes("←"));
    assert.equal(store.renderForPrompt("user-none"), null);
  });
});

test("purgeActor: 隐私清理移除该 actor 全部事实", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "user-1", field: "称呼", value: "张三" });
    store.applyFact({ actorId: "user-1", field: "职业", value: "全栈开发" });
    const stats = store.stats();
    assert.equal(stats.active, 2);
    assert.equal(store.purgeActor("user-1"), 2);
    assert.equal(store.getActiveFacts("user-1").length, 0);
    assert.equal(store.stats().active, 0);
  });
});

// ============================================================
// 3. 统一抽取 facts 协议
// ============================================================

test("normalize: 解析 facts（丢弃缺字段项，confidence 截断，上限 6 条）", () => {
  const raw = parseJsonObject(
    JSON.stringify({
      decision: "remember",
      semanticClass: "事实",
      memories: ["用户自我介绍：张三，住杭州，做全栈开发"],
      commitments: [],
      corrections: [],
      understandings: [],
      facts: [
        { field: "称呼", value: "张三", confidence: 0.98 },
        { field: "居住地", value: "杭州" },
        { field: "技术栈", value: "TS/Python", confidence: 5 },
        { field: "", value: "缺字段" },
        { field: "生日", value: "" },
      ],
    }),
  );
  assert.ok(raw);
  const result = normalize(raw);
  assert.ok(result);
  assert.equal(result.facts.length, 3);
  assert.equal(result.facts[0]!.field, "称呼");
  assert.equal(result.facts[0]!.value, "张三");
  assert.equal(result.facts[0]!.confidence, 0.98);
  assert.equal(result.facts[1]!.confidence, undefined); // 缺 confidence 不强造
  assert.equal(result.facts[2]!.confidence, 1); // 越界截断
  assert.ok(result.facts.every((f) => f.field && f.value));
});

test("normalize: 无 facts 键时返回空数组（旧输出协议兼容）", () => {
  const raw = parseJsonObject(
    JSON.stringify({
      decision: "decay",
      memories: [],
      commitments: [],
      corrections: [],
      understandings: [],
    }),
  );
  assert.ok(raw);
  const result = normalize(raw);
  assert.ok(result);
  assert.deepEqual(result.facts, []);
});

// ============================================================
// 4. ingest 钩子贯通：facts 经 Mem0WriteEvent 到达钩子
// ============================================================

test("persistUnifiedExtraction: 高信号直写路径钩子携带 facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-ingest-"));
  try {
    const fakeMemory = {
      async add(entries: Array<{ content: string }>, opts: { infer?: boolean }) {
        return { results: [{ id: "mem0-1", memory: entries[0]!.content, ...(opts ?? {}) }] };
      },
    } as unknown as Memory;
    const ingest = new AgenticMemoryIngestService(fakeMemory);

    let hookFacts: Array<{ field: string; value: string }> | undefined = undefined;
    ingest.addWriteHook((event) => {
      hookFacts = event.facts;
    });

    await ingest.persistUnifiedExtraction(
      "user-1",
      "chat:turn-1",
      {
        decision: "remember",
        semanticClass: "事实",
        memories: ["用户自我介绍：张三"],
        commitments: [],
        corrections: [],
        understandings: [],
        facts: [{ field: "称呼", value: "张三", confidence: 0.95 }],
      },
      "main",
      true,
    );

    assert.ok(hookFacts);
    assert.equal(hookFacts![0]!.field, "称呼");
    assert.equal(hookFacts![0]!.value, "张三");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("persistUnifiedExtraction: reject 决策记忆不落库，facts 仍进钩子", async () => {
  const fakeMemory = {
    async add() {
      throw new Error("reject 路径不应落库");
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(fakeMemory);
  let hookFacts: Array<{ field: string; value: string }> | undefined;
  ingest.addWriteHook((event) => {
    hookFacts = event.facts;
  });

  const results = await ingest.persistUnifiedExtraction(
    "user-1",
    "chat:turn-2",
    {
      decision: "reject",
      memories: [],
      commitments: [],
      corrections: [],
      understandings: [],
      facts: [{ field: "技术栈", value: "Rust" }],
    },
    "main",
    false,
  );
  assert.equal(results.length, 0);
  assert.ok(hookFacts);
  assert.equal(hookFacts![0]!.field, "技术栈");
});

test("persistUnifiedExtraction: forget 字段遗忘经钩子携带（钩子走字段级 supersede）", async () => {
  const fakeMemory = {
    async add() {
      throw new Error("forget 路径不应落库 Mem0");
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(fakeMemory);
  let hookForget: string[] | undefined;
  ingest.addWriteHook((event) => {
    hookForget = event.forget;
  });

  await ingest.persistUnifiedExtraction(
    "user-1",
    "chat:turn-4",
    {
      decision: "remember",
      memories: ["用户要求忘掉居住地"],
      commitments: [],
      corrections: [],
      understandings: [],
      facts: [],
      forget: ["居住地"],
    },
    "main",
    true,
  );
  assert.ok(hookForget);
  assert.deepEqual(hookForget, ["居住地"]);
});

// 低信号轮的捎带抽取已收进 PROFILE_WRITE_SCHEDULING=legacy 这一条回滚档
// （batch 默认档由统一写入者/夜间批覆盖，不再在压缩残片上二次抽取），本文件
// 跑在默认 batch 档，"orphan 路径 facts 进钩子" 不再成立；legacy 档的行为由
// test/memory-unified-profile-merge.test.ts 显式设 PROFILE_WRITE_SCHEDULING=legacy 守住。

// ============================================================
// 5. 端到端闭环：抽取 facts → 钩子落库 → 换值覆盖旧档
// ============================================================

test("端到端：'我叫张三'→'我叫李四' 实时更新称呼字段并保留历史", { timeout: 30_000 }, async () => {
  await withStore(async (store) => {
    const fakeMemory = { async add() { return { results: [] }; } } as unknown as Memory;
    const ingest = new AgenticMemoryIngestService(fakeMemory);
    ingest.addWriteHook((event) => {
      for (const fact of event.facts ?? []) {
        store.applyFact({
          actorId: event.actorId,
          field: fact.field,
          value: fact.value,
          sourceRef: event.sourceId,
          confidence: fact.confidence ?? null,
        });
      }
    });

    const apply = async (raw: Record<string, unknown>, sourceId: string) => {
      await ingest.persistUnifiedExtraction(
        "user-1",
        sourceId,
        normalize(raw as never)!,
        "main",
        true,
      );
    };

    await apply(
      {
        decision: "remember",
        memories: ["用户自我介绍叫张三"],
        commitments: [],
        corrections: [],
        understandings: [],
        facts: [{ field: "名字", value: "张三", confidence: 0.95 }],
      },
      "chat:turn-1",
    );
    assert.equal(store.getFact("user-1", "称呼")?.value, "张三");

    await apply(
      {
        decision: "remember",
        memories: ["用户改口：以后叫李四"],
        commitments: [],
        corrections: [],
        understandings: [],
        facts: [{ field: "姓名", value: "李四", confidence: 0.95 }],
      },
      "chat:turn-2",
    );

    // 别名归一后同字段：当前值已是李四，张三入历史
    const current = store.getFact("user-1", "称呼");
    assert.ok(current);
    assert.equal(current!.value, "李四");
    const history = store.getHistoryFor("user-1", current!.id, 2);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.value, "张三");
    assert.equal(store.getActiveFacts("user-1").length, 1);
  });
});
