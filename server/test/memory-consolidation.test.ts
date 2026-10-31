/**
 * 记忆链路改造单元测试（统一写入者 / 回声守卫 / Supersession / 原子写备份 / 回查工具）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "../src/storage/atomic-json.js";
import {
  markInjectedMemory,
  isMemoryEcho,
  resetMemoryEchoGuard,
} from "../src/services/memory-echo-guard.js";
import {
  MemoryConsolidationService,
  resetMemoryConsolidationForTests,
  type MemoryCandidate,
} from "../src/services/memory-consolidation-service.js";
import { registerMemoryRecallTools } from "../src/tools/memory-recall-tools.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";

// 本文件全部为「unified 不可用回退路径」的行为锁定：统一抽取已默认启用，
// 环境里有真实 API key 时高/低信号候选会走 extractUnified（决策由 LLM 给出，
// 不再有本地启发式 overwrite）。关闭后 extractUnified 返回 null → 回退
// decideMemoryWrite 启发式路径，测试恢复确定性（统一抽取路径的覆盖在
// user-fact-registry.test.ts，注入 fake client）。
process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED = "0";

// ─── 原子写：pre-image .bak 备份 ───

test("writeJsonAtomic: 覆盖写保留上一版完整 .bak 备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-bak-"));
  try {
    const file = join(dir, "store.json");
    await writeJsonAtomic(file, { version: 1 });
    await writeJsonAtomic(file, { version: 2 });

    const bakRaw = await readFile(`${file}.bak`, "utf8");
    assert.deepEqual(JSON.parse(bakRaw), { version: 1 });
    const cur = JSON.parse(await readFile(file, "utf8"));
    assert.equal(cur.version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("writeJsonAtomic: 首次写入无 pre-image 时不报错且无 .bak", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-first-"));
  try {
    const file = join(dir, "store.json");
    await writeJsonAtomic(file, { version: 1 });
    await assert.rejects(readFile(`${file}.bak`, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ─── 回声守卫 ───

test("echo-guard: 注入过的记忆被复述时判为回声", () => {
  resetMemoryEchoGuard();
  markInjectedMemory("actor-a", "用户喜欢喝拿铁咖啡，不喜欢美式\n用户在深圳从事后端开发工作");
  // 同义复述（词法高重叠）
  assert.equal(isMemoryEcho("actor-a", "用户喜欢喝拿铁咖啡，不喜欢美式"), true);
  // 全新内容不判回声
  assert.equal(isMemoryEcho("actor-a", "用户明天下午三点要去打网球"), false);
  // 其他 actor 不受影响
  assert.equal(isMemoryEcho("actor-b", "用户喜欢喝拿铁咖啡，不喜欢美式"), false);
});

test("echo-guard: 空登记/空文本安全返回", () => {
  resetMemoryEchoGuard();
  assert.equal(isMemoryEcho("actor-c", "随便什么内容"), false);
  markInjectedMemory("actor-c", "  \n  ");
  assert.equal(isMemoryEcho("actor-c", ""), false);
});

// ─── 统一写入者 ───

type WriteDecidedCall = {
  actorId: string;
  text: string;
  source: string;
  opts: { context: string; highSignal: boolean; sourceEventId?: string; eventTime?: string };
};

function makeFakeNarrativePort() {
  const calls: WriteDecidedCall[] = [];
  const port: NarrativeMemoryPort = {
    async ingest() {},
    async writeDecided(actorId, text, source, opts) {
      calls.push({ actorId, text, source, opts });
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
  return { port, calls };
}

function makeFakeMem0Memory() {
  const added: Array<{ text: string; userId: string }> = [];
  const deleted: string[] = [];
  return {
    memory: {
      async add(entries: Array<{ content: string }>, opts: { userId: string }) {
        for (const e of entries) added.push({ text: e.content, userId: opts.userId });
        return { results: [] };
      },
      async search() {
        return {
          results: [
            { id: "old-1", memory: "用户喜欢喝美式咖啡", score: 0.92, metadata: {} },
            { id: "keep-1", memory: "用户在深圳工作", score: 0.4, metadata: {} },
          ],
        };
      },
      async delete(id: string) {
        deleted.push(id);
        return true;
      },
    },
    added,
    deleted,
  };
}

function submitCandidate(service: MemoryConsolidationService, partial: Partial<MemoryCandidate>): void {
  service.submitCandidate({
    actorId: "actor-x",
    text: "测试内容",
    source: "chat:turn_archive",
    context: "main",
    highSignal: true,
    createdAt: new Date().toISOString(),
    ...partial,
  });
}

test("统一写入者: 高信号候选 → 单次决策 → writeDecided + KV 行", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-"));
  try {
    const { port, calls } = makeFakeNarrativePort();
    const kvLines: string[] = [];
    const kvSync = { appendMemorySummaryLine: (_a: string, line: string) => kvLines.push(line) } as never;
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });

    // 过敏/避免 → stable_constraint remember（0.91，启发式可信，不触发 LLM 复判）
    submitCandidate(service, {
      text: "我对花生过敏，避免吃一切含花生的东西",
      source: "chat:fast_path",
      topicHint: "饮食",
    });
    await service.flushAll();

    // 决策为 remember → 长期图出口被调用一次
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.actorId, "actor-x");
    assert.ok(calls[0]!.text.includes("花生"));
    // KV summary 行按旧格式落一行（含决策标签）
    assert.equal(kvLines.length, 1);
    assert.match(kvLines[0]!, /^\[fast-path\]\[(remember|overwrite|decay)\]/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("统一写入者: 来源事件随候选透传到 writeDecided（LTM 可追溯）", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-provenance-"));
  try {
    const { port, calls } = makeFakeNarrativePort();
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync: null,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });

    submitCandidate(service, {
      text: "我对花生过敏，避免吃一切含花生的东西",
      source: "chat:fast_path",
      eventId: "evt:actor-x:m-1",
      eventTime: "2026-10-30T10:00:00.000Z",
    });
    await service.flushAll();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.sourceEventId, "evt:actor-x:m-1");
    assert.equal(calls[0]!.opts.eventTime, "2026-10-30T10:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("统一写入者: reject 候选不落长期图但 KV 行仍记录决策", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-reject-"));
  try {
    const { port, calls } = makeFakeNarrativePort();
    const kvLines: string[] = [];
    const kvSync = { appendMemorySummaryLine: (_a: string, line: string) => kvLines.push(line) } as never;
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });

    // 长度不足 6 字（归一化后）→ reject 0.98（too_short，启发式可信，不触发 LLM 复判）
    submitCandidate(service, { text: "好的呀！", source: "chat:fast_path" });
    await service.flushAll();

    assert.equal(calls.length, 0);
    assert.equal(kvLines.length, 1);
    assert.match(kvLines[0]!, /\[fast-path\]\[reject\]/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("统一写入者: 注入记忆的复述候选被回声守卫拦截", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-echo-"));
  try {
    const { port, calls } = makeFakeNarrativePort();
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync: null,
      memory: null,
      filePath: join(dir, "candidates.json"),
    });

    // 模拟 prompt 注入过的记忆 → turn archive 抽取到同义复述
    markInjectedMemory("actor-x", "用户喜欢喝拿铁咖啡，不喜欢美式");
    submitCandidate(service, { text: "用户喜欢喝拿铁咖啡，不喜欢美式" });
    await service.flushAll();

    assert.equal(calls.length, 0);
    assert.equal(service.pendingCount("actor-x"), 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("Supersession: overwrite 语义候选退役语义重合旧记忆", { timeout: 30_000 }, async () => {
  resetMemoryConsolidationForTests();
  resetMemoryEchoGuard();
  const dir = await mkdtemp(join(tmpdir(), "consolidation-supersede-"));
  try {
    const { port, calls } = makeFakeNarrativePort();
    const fake = makeFakeMem0Memory();
    const service = new MemoryConsolidationService({
      narrative: port,
      kvSync: null,
      memory: fake.memory as never,
      filePath: join(dir, "candidates.json"),
    });

    // mutable_fact 语义（"改成/不再" + 偏好词）→ overwrite → 触发退役
    submitCandidate(service, { text: "我不再喜欢美式了，现在改成只喝拿铁" });
    await service.flushAll();

    assert.deepEqual(fake.deleted, ["old-1"]);
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ─── 回查工具 ───

test("memory.recall_episodic: 命中情景轮次并格式化返回", async () => {
  const registryCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const fakeGateway = {
    searchEpisodic: (sessionId: string, query: string, k: number) => {
      registryCalls.push({ name: sessionId, input: { query, k } });
      return [
        { idx: 3, user: "帮我订明天下午三点的会议室", assistant: "已为你预订 A 栋 302 会议室。", ts: Date.now() },
      ];
    },
  };
  const handlers = new Map<string, (input: Record<string, unknown>, ctx: { sessionId: string }) => Promise<unknown>>();
  const registry = {
    register: (name: string, handler: (input: Record<string, unknown>, ctx: { sessionId: string }) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as never;
  registerMemoryRecallTools(registry as never, {
    shortTermMemoryGateway: fakeGateway as never,
  });
  const handler = handlers.get("memory.recall_episodic")!;
  const result = (await handler({ query: "会议室", k: 3 }, { sessionId: "sess-1" })) as {
    ok: boolean;
    turns: Array<{ idx: number; user: string }>;
    message: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0]!.idx, 3);
  assert.match(result.message, /1 轮/);
  assert.equal(registryCalls[0]!.input.k, 3);
});

test("memory.recall_episodic: 空 gateway 时不注册,空命中返回提示", async () => {
  const handlers = new Map<string, unknown>();
  const registry = {
    register: (name: string) => {
      handlers.set(name, true);
    },
  };
  registerMemoryRecallTools(registry as never, { shortTermMemoryGateway: null });
  assert.equal(handlers.size, 0);
});
