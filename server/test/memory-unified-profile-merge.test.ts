/**
 * 抽取链路合并（2026-10-21）：画像增量不再单独发 LLM，而是与
 * 「记忆决策 + 记忆抽取 + 承诺 + 纠正 + 事实」走同一次统一抽取调用。
 *
 * 覆盖：
 *   1. 传 profileContext 时，同一次请求里带【当前用户画像】+ profileOps schema，
 *      返回的 profileOps 被严格解析；
 *   2. 不传 profileContext（普通轮）时 prompt 体积不变，不含画像段；
 *   3. ingest 低信号路径产出的 profileOps 经写入钩子透出（记忆写入行为不变）；
 *   4. 画像聚合器消费 profileOps 走确定性落位（无第二次 LLM）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Memory } from "mem0ai/oss";

import { AgenticMemoryIngestService, type Mem0WriteEvent } from "../src/agentic-memory/ingest.js";
import { extractUnified, type UnifiedLlmClient } from "../src/agentic-memory/unified-extractor.js";
import { UserProfileAggregator } from "../src/brain/user-profile-aggregator.js";

type ChatMessage = { role: string; content: string };

function capturingClient(payload: unknown): {
  client: UnifiedLlmClient;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  const client: UnifiedLlmClient = {
    chat: {
      completions: {
        create: async (args) => {
          calls.push(args.messages as ChatMessage[]);
          return { choices: [{ message: { content: JSON.stringify(payload) } }] };
        },
      },
    },
  };
  return { client, calls };
}

const BASE_PAYLOAD = {
  decision: "decay",
  memories: [],
  commitments: [],
  corrections: [],
  understandings: [],
  facts: [],
  forget: [],
  referents: [],
};

test("统一抽取：传 profileContext 时同一次调用捎带画像操作", async () => {
  const { client, calls } = capturingClient({
    decision: "remember",
    memories: ["用户住在成都"],
    commitments: [],
    corrections: [],
    understandings: [],
    facts: [{ field: "居住地", value: "成都", temporal: "current", confidence: 0.9 }],
    forget: [],
    referents: [],
    profileOps: [{ op: "ADD", section: "basic", line: "居住地：成都" }],
  });

  const out = await extractUnified("我从杭州搬到成都了", {
    client,
    profileContext: { currentProfile: "# 用户画像\n- 居住地：杭州" },
  });

  assert.ok(out, "抽取结果不应为空");
  assert.deepEqual(out!.profileOps, [{ op: "ADD", section: "basic", line: "居住地：成都" }]);
  // 记忆侧产物不受影响（合并后仍然照常写入）
  assert.equal(out!.decision, "remember");
  assert.deepEqual(out!.facts.map((f) => `${f.field}:${f.value}`), ["居住地:成都"]);

  const [system, user] = calls[0]!;
  assert.match(system!.content, /profileOps/, "system 应包含画像操作 schema");
  assert.match(user!.content, /【当前用户画像】/);
  assert.match(user!.content, /居住地：杭州/);
});

test("统一抽取：普通轮不带 profileContext 时 prompt 不增加画像段", async () => {
  const { client, calls } = capturingClient(BASE_PAYLOAD);
  await extractUnified("今天好累啊", { client });

  const [system, user] = calls[0]!;
  assert.ok(!system!.content.includes("profileOps"), "普通轮 system 不应有画像 schema");
  assert.ok(!user!.content.includes("【当前用户画像】"), "普通轮不应注入当前画像");
});

test("ingest 低信号：profileOps 随统一抽取产物经写入钩子透出", async () => {
  const { client } = capturingClient({
    ...BASE_PAYLOAD,
    profileOps: [{ op: "ADD", section: "interest", line: "喜欢钓鱼" }],
  });
  const memory = {
    add: async () => ({ results: [] }),
  } as unknown as Memory;

  const ingest = new AgenticMemoryIngestService(memory);
  ingest.setExtractionClient(client);
  let snapshotRequested = 0;
  ingest.setProfileSnapshotProvider(async () => {
    snapshotRequested += 1;
    return "# 用户画像\n- 居住地：杭州";
  });

  const events: Mem0WriteEvent[] = [];
  ingest.addWriteHook((e) => events.push(e));

  await ingest.ingestText("actor-merge-prof", "test-source", "我喜欢钓鱼", { context: "main" });
  // 低信号抽取是 fire-and-forget，等一拍让钩子落地
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(snapshotRequested, 1, "命中个人陈述预筛时应读取一次画像快照");
  assert.equal(events.length, 1, "应触发一次写入钩子");
  assert.deepEqual(events[0]!.profileOps, [{ op: "ADD", section: "interest", line: "喜欢钓鱼" }]);
});

test("画像聚合器：消费统一抽取的 profileOps 走确定性落位（不再调 LLM）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "profile-merge-"));
  const prev = process.env.AGENT_USER_PROFILE_DIR;
  process.env.AGENT_USER_PROFILE_DIR = dir;
  try {
    const agg = new UserProfileAggregator();
    const actor = "actor-merge-apply";
    const store = (agg as unknown as { store: { write: (a: string, t: string) => Promise<void> } }).store;
    await store.write(
      actor,
      "# 用户画像\n\n## 基本信息\n- 居住地：杭州\n\n## 兴趣与习惯\n\n## 沟通偏好\n\n## 备注\n",
    );

    const ok = await agg.applyProfileOpsFromUnified(actor, [
      { op: "UPDATE", section: "basic", line: "居住地：成都", match: "杭州" },
    ]);
    assert.equal(ok, true);

    const text = await agg.readProfile(actor);
    assert.match(text, /成都/, "新值应已落位");
    assert.ok(!text.includes("居住地：杭州"), "旧值应被替换");
  } finally {
    if (prev === undefined) delete process.env.AGENT_USER_PROFILE_DIR;
    else process.env.AGENT_USER_PROFILE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
