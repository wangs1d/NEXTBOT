/**
 * 记忆权威源收敛的回归测试（2026-11-12）
 *
 * 覆盖用户在真机上遇到的形态，以及本次收敛后的契约：
 *   1. 每个概念只有一个写者（注册表）；
 *   2. 任务型句子只进 memory_summary，不再镜像进偏好/事实/未闭环槽；
 *   3. 摘要整串重写与追加并发时不丢行（单写者 + 读改写重试）；
 *   4. 画像不再写 KV 副本，只以 USER_PROFILE.md 为准；
 *   5. prompt 不再从 KV 的 user_profile 拉取画像。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { sliceMemoryEntriesToPromptContext } from "../src/agent/prompt-builder.js";
import { reconcileProfileFactsFromStores } from "../src/services/user-personalization/profile-fact-authority.js";
import {
  MEMORY_AUTHORITY,
  assertMemoryWriter,
} from "../src/memory/memory-authority.js";

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-mem-"));
  return path.join(dir, name);
}

const ACTOR = "test-actor";

test("注册表：每个槽位只有一个 owner，且禁止写入清单不含自身权威", () => {
  for (const spec of Object.values(MEMORY_AUTHORITY)) {
    assert.ok(spec.owner.trim().length > 0, `槽位缺 owner`);
    assert.ok(spec.authority.trim().length > 0, `槽位缺 authority`);
    for (const forbidden of spec.forbiddenWrites ?? []) {
      assert.notEqual(forbidden, spec.authority, `槽位权威源被列进禁止清单`);
    }
  }
});

test("注册表：越权写入一律抛错（恒为严格模式，无灰度开关）", () => {
  // 未登记的模块一律越权（2026-11-13：契约从「只有 owner 能写」改为
  // 「只有登记过的 producer 能写」——memory_summary 有 6 个合法生产者，
  // 它们都经 owner 落地，不再是各自直写）。
  assert.throws(
    () => assertMemoryWriter("memory_summary", "SomeUnregisteredModule"),
    /越权写入/,
  );
  assert.throws(
    () =>
      assertMemoryWriter(
        "memory_summary",
        "AgentMemorySyncService",
        "file:long-term-memory/x.json",
      ),
    /越权写入/,
  );
  assert.doesNotThrow(() => assertMemoryWriter("memory_summary", "AgentMemorySyncService"));
  // 登记过的生产者放行
  assert.doesNotThrow(() => assertMemoryWriter("memory_summary", "MemoryManagerService"));
  assert.doesNotThrow(() => assertMemoryWriter("memory_summary", "TurnLifecycle"));
  // 档案字段槽位：登记的写者放行，未登记的拦下
  assert.doesNotThrow(() => assertMemoryWriter("structured_facts", "UnifiedExtractionHook"));
  assert.throws(
    () => assertMemoryWriter("structured_facts", "SomeRandomModule"),
    /越权写入/,
  );
});

test("写入：任务型句子只进 memory_summary，不进偏好/事实/未闭环槽", async () => {
  const svc = new AgentMemorySyncService(tempFile("sync.json"));
  svc.appendMemorySummaryLine(ACTOR, "用户在为小米 18 Pro 比价，纠结性价比，后续还要再看看", "phone");
  svc.appendMemorySummaryLine(ACTOR, "别再提小米 18 Pro 比价的事了", "phone");
  await svc.flush();

  const snap = svc.getSnapshot(ACTOR, [
    "memory_summary",
    "memory_preferences",
    "memory_facts",
    "memory_commitments",
    "memory_open_loops",
  ]);
  const summary = String(snap.entries.memory_summary ?? "");
  assert.match(summary, /小米 18 Pro 比价/);
  for (const key of ["memory_preferences", "memory_facts", "memory_commitments", "memory_open_loops"]) {
    assert.equal(snap.entries[key], undefined, `${key} 不应再被写入（应只有权威源持有）`);
  }
});

test("并发：追加与整串重写不丢行", async () => {
  const svc = new AgentMemorySyncService(tempFile("sync.json"));
  svc.appendMemorySummaryLine(ACTOR, "用户称呼是王哥", "profile");

  // 模拟整理器在追加进行中的整串重写
  const replace = svc.replaceSummaryLines(ACTOR, (cur) => ({ summary: cur.summary, forgotten: cur.forgotten }));
  svc.appendMemorySummaryLine(ACTOR, "用户在兴义", "profile");
  svc.appendMemorySummaryLine(ACTOR, "用户在做独立开发", "profile");
  await Promise.all([replace, svc.flush()]);

  const summary = String(svc.getSnapshot(ACTOR, ["memory_summary"]).entries.memory_summary ?? "");
  assert.match(summary, /王哥/);
  assert.match(summary, /兴义/);
  assert.match(summary, /独立开发/);
});

test("画像：只投影到 USER_PROFILE.md，不再写 KV user_profile 副本", async () => {
  let md = "# 用户画像\n\n## 基本信息\n\n- 称呼：老王\n";
  const writes: Array<{ key: string; value: unknown }> = [];

  const deps = {
    profileStore: {
      read: async () => md,
      write: async (_actorId: string, content: string) => {
        md = content;
      },
    },
    factStore: {
      getActiveFacts: () => [{ field: "称呼", value: "王哥" }],
      getAllValuesForField: () => ["老王", "王哥"],
    },
    memorySync: {
      getSnapshot: () => ({
        revision: 1,
        entries: {
          memory_facts: "[2026-10-01T00:00:00.000Z] [topic:profile] 称呼：老王",
          user_profile: "# 旧的全文副本",
        },
      }),
      setEntry: (_actorId: string, key: string, value: unknown) => {
        writes.push({ key, value });
      },
    },
  };

  const report = await reconcileProfileFactsFromStores(ACTOR, deps);
  assert.equal(report.profileChanged, true);
  assert.match(md, /王哥/, "画像文件应被重渲染为权威值");

  // 不得再写入画像全文；对 user_profile 的唯一允许操作是「作废存量副本」（写空串）
  const profileWrites = writes.filter((w) => w.key === "user_profile");
  assert.equal(
    profileWrites.every((w) => String(w.value).trim() === ""),
    true,
    "user_profile 只允许被清空，不得写入全文副本",
  );
  assert.equal(report.legacyProfileKvCleared, true, "存量 KV 副本应被作废");
});

test("注入：prompt 不再从 KV user_profile 拉取画像", () => {
  const ctx = sliceMemoryEntriesToPromptContext(
    {
      user_profile: "# 用户画像\n- 称呼：王哥\n- 城市：兴义",
      memory_facts: "[2026-10-20T00:00:00.000Z] [topic:profile] 用户已婚",
    },
    "我是谁",
  );
  assert.equal(ctx.userProfile, undefined, "画像应由 USER_PROFILE.md 投影，不得走 KV 副本");
});

test("注入：memory_summary 仍是长期记忆的读取来源", () => {
  const ctx = sliceMemoryEntriesToPromptContext(
    {
      memory_summary:
        "[2026-11-05T10:00:00.000Z] [topic:phone] 用户在为小米 18 Pro 比价，纠结性价比",
    },
    "小米那个怎么样了",
  );
  assert.match(ctx.memorySummary ?? "", /小米 18 Pro/);
});

test("待办块：逾期优先、带截止日、最多 3 条", async () => {
  const { renderCommitmentBlock } = await import("../src/services/commitment-prompt-provider.js");
  const now = Date.parse("2026-11-12T10:00:00Z");
  const block = renderCommitmentBlock(
    [
      { id: "a", text: "周五前交付合同", deadline: "2026-11-14T10:00:00Z", createdAt: "2026-11-01T00:00:00Z" },
      { id: "b", text: "回款跟进", deadline: "2026-11-10T10:00:00Z", createdAt: "2026-11-02T00:00:00Z" },
      { id: "c", text: "没有截止的杂事", deadline: null, createdAt: "2026-11-03T00:00:00Z" },
      { id: "d", text: "第四条不该出现", deadline: "2026-11-20T10:00:00Z", createdAt: "2026-11-04T00:00:00Z" },
    ],
    now,
  );
  assert.ok(block);
  const lines = block!.split("\n");
  assert.equal(lines.length, 3, "最多 3 条");
  assert.match(lines[0]!, /逾期 2 天/);
  assert.match(block!, /周五前交付合同/);
  // 排序：逾期 → 最近截止 → 无截止/更远；容量 3 时挤掉"无截止"和"更远"中的后者
  assert.doesNotMatch(block!, /没有截止的杂事/);
});

test("待办块：空列表零注入", async () => {
  const { renderCommitmentBlock } = await import("../src/services/commitment-prompt-provider.js");
  assert.equal(renderCommitmentBlock([], Date.now()), undefined);
});
