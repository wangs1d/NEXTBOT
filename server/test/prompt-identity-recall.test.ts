/**
 * 按需召回集成回归（2026-11-18 根修）。
 *
 * 锁定：用户问某个身份字段时，最终注入的 prompt 只能包含该字段（+ 称呼恒带），
 * 不能把画像里的姓名/年龄/住址/生日/兴趣/沟通偏好等一起摊出来。
 *
 * 覆盖通道：
 *   - 结构化事实块（T2 问法命中 → 只注入命中字段；T2 命中时不再补语义 top3）
 *   - USER_PROFILE.md 门控（身份字段只跟事实块；自由文本按 query 词面过滤）
 *   - 用户理解档案（onlyMatched：无命中零注入）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import { registerMemoryComponents } from "../src/agentic-memory/index.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { UserUnderstandingStore } from "../src/agentic-memory/user-understanding-store.js";

const ACTOR = "recall-scope-user";

const PROFILE = `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。
> 用户标识：\`${ACTOR}\`

## 基本信息

- 称呼：大哥
- 姓名：王铭川
- 年龄：20岁
- 居住地：贵州兴义下午屯九华苑
- 生日：6月18

## 兴趣与习惯

- 有早上游泳的习惯
- 喜欢刘浩存，粉丝式称她为老婆

## 沟通偏好

- 回复偏好：精简直接
- 不喜欢一味顺从道歉

## 备注

- 在考驾照，已考一年多
`;

/** 只看渲染出来的数据行（- 字段：值），不看块头的使用说明。 */
function dataLines(block: string | undefined): string {
  return (block ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .join("\n");
}

async function withAssembledMemory(
  fn: (assemble: (q: string) => Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "nb-recall-scope-"));
  const db = openAgenticSqlite(join(dir, "mem.db"));
  const factStore = new StructuredFactStore(db);
  const understandingStore = new UserUnderstandingStore(db);
  registerMemoryComponents({ factStore, understandingStore });

  for (const [field, value] of [
    ["姓名", "王铭川"],
    ["称呼", "大哥"],
    ["年龄", "20岁"],
    ["居住地", "贵州兴义下午屯九华苑"],
    ["生日", "6月18"],
    ["考驾照", "已考一年多"],
  ] as const) {
    factStore.applyFact({ actorId: ACTOR, field, value, confidence: 0.95 });
  }
  understandingStore.applyUnderstanding({
    actorId: ACTOR,
    topic: "老婆",
    note: "用户粉丝式称刘浩存为老婆，并非真实婚姻",
    kind: "fandom",
  });
  understandingStore.applyUnderstanding({
    actorId: ACTOR,
    topic: "居住地",
    note: "用户家在贵州兴义下午屯九华苑",
    kind: "literal",
  });

  const builder = new PromptContextBuilder({
    agentMemorySyncService: null,
    worldService: null,
    skillManager: null,
    virtualPhoneService: null,
  });
  // assembleMemory 是私有装配核心：测试直接调用，避免依赖完整 runtime 装配。
  const assemble = (q: string) =>
    (builder as unknown as {
      assembleMemory: (input: Record<string, unknown>) => Record<string, string | undefined>;
    }).assembleMemory({
      actorId: ACTOR,
      sessionId: ACTOR,
      userText: q,
      personalization: { userProfile: PROFILE },
    });

  try {
    await fn(assemble);
  } finally {
    registerMemoryComponents({ factStore: null, understandingStore: null });
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("问年龄：只召回年龄（+称呼恒带），不连带姓名/住址/生日/兴趣", async () => {
  await withAssembledMemory(async (assemble) => {
    const m = assemble("我几岁了");
    const facts = dataLines(m.userFacts);
    assert.match(facts, /年龄：20岁/);
    assert.match(facts, /称呼：大哥/);
    assert.doesNotMatch(facts, /王铭川/);
    assert.doesNotMatch(facts, /九华苑/);
    assert.doesNotMatch(facts, /生日/);
    assert.doesNotMatch(facts, /考驾照/);

    const profile = m.userProfileSummary ?? "";
    assert.doesNotMatch(profile, /王铭川/);
    assert.doesNotMatch(profile, /九华苑/);
    assert.doesNotMatch(profile, /生日/);
    assert.doesNotMatch(profile, /游泳/);
    assert.doesNotMatch(profile, /回复偏好/);

    // 没有「年龄」理解主题 → 理解档案零注入
    assert.equal(m.userUnderstanding, undefined);
  });
});

test("问名字：只召回姓名（+称呼），不连带年龄/住址/生日", async () => {
  await withAssembledMemory(async (assemble) => {
    const m = assemble("记得我叫什么吗");
    const facts = dataLines(m.userFacts);
    assert.match(facts, /姓名：王铭川/);
    assert.match(facts, /称呼：大哥/);
    assert.doesNotMatch(facts, /年龄/);
    assert.doesNotMatch(facts, /九华苑/);
    assert.doesNotMatch(facts, /生日/);
    assert.doesNotMatch(m.userProfileSummary ?? "", /九华苑/);
    assert.doesNotMatch(m.userProfileSummary ?? "", /游泳/);
  });
});

test("问生日：只召回生日；问称呼：只召回称呼", async () => {
  await withAssembledMemory(async (assemble) => {
    const birthday = assemble("我的生日是什么时候");
    assert.match(dataLines(birthday.userFacts), /生日：6月18/);
    assert.doesNotMatch(dataLines(birthday.userFacts), /王铭川|20岁|九华苑/);

    const appellation = assemble("你叫我什么");
    assert.match(dataLines(appellation.userFacts), /称呼：大哥/);
    assert.doesNotMatch(dataLines(appellation.userFacts), /王铭川|年龄|九华苑|生日/);
  });
});

test("同轮问多项：两个问法都命中时按需给两项", async () => {
  await withAssembledMemory(async (assemble) => {
    const m = assemble("我叫什么，几岁了");
    const facts = dataLines(m.userFacts);
    assert.match(facts, /姓名：王铭川/);
    assert.match(facts, /年龄：20岁/);
    assert.doesNotMatch(facts, /九华苑|生日/);
  });
});

test("问居住地：理解档案只渲染命中的居住地话题", async () => {
  await withAssembledMemory(async (assemble) => {
    const m = assemble("我现在住哪");
    assert.match(dataLines(m.userFacts), /居住地：贵州兴义下午屯九华苑/);
    assert.doesNotMatch(dataLines(m.userFacts), /王铭川|年龄|生日/);
    // 理解档案只保留 居住地 话题，不带 老婆
    if (m.userUnderstanding) {
      assert.match(m.userUnderstanding, /居住地/);
      assert.doesNotMatch(m.userUnderstanding, /老婆/);
    }
  });
});
