/**
 * 用户画像三层写入调度测试（2026-10-22）：
 *   T0  WAL 全文候选标记（turn-wal-service profileCandidate）
 *   T2  夜间批抽取（consolidateProfileFromWal：候选消费 / checkpoint 推进 /
 *       抽取失败不推进 / 空产物推进）+ WAL 候选读取过滤
 *   顺手修回归：样板行「会」漂移、basic ADD 按 label 去重、NAME_RE「我是」误捕
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTurnWalService, type TurnWalEntry } from "../src/services/turn-wal-service.js";
import { getCalendarDay } from "../src/services/short-term-memory-config.js";
import {
  readWalProfileCandidates,
  consolidateProfileFromWal,
  loadProfileCheckpoint,
} from "../src/services/profile-write-scheduler.js";
import { applyProfileOps, verifyProfileOps } from "../src/brain/user-profile-aggregator.js";
import { hasRealProfileContent } from "../src/services/user-personalization/user-profile-store.js";
import { extractProfilePatches } from "../src/services/user-personalization/profile-heuristics.js";
import type { UnifiedExtraction } from "../src/agentic-memory/unified-extractor.js";

/* ── T0：WAL 候选标记 ─────────────────────────────────────────── */

test("T0 TurnWalService：完整原文命中 hint → profileCandidate=true；闲聊=false；高信号恒 true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wal-flag-test-"));
  process.env.AGENT_TURN_WAL_DIR = dir;
  process.env.AGENT_TURN_WAL_ENABLED = "1";

  const wal = getTurnWalService();
  const mk = (over: Partial<TurnWalEntry>): TurnWalEntry => ({
    ts: "2026-10-22T10:00:00.000Z",
    actorId: "u1",
    userText: "",
    assistantText: "",
    ...over,
  });
  await wal.append(mk({ userText: "我叫王铭川，住兴义，记住没有" }));
  await wal.append(mk({ userText: "今天天气不错啊" }));
  await wal.append(mk({ userText: "随便聊聊", highSignal: true }));

  const day = getCalendarDay(new Date("2026-10-22T10:00:00.000Z"));
  const raw = await readFile(join(dir, `${day}.jsonl`), "utf8");
  const entries = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { userText: string; profileCandidate?: boolean });

  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.profileCandidate, true, "个人陈述命中 hint 正则（跑在完整原文上）");
  assert.equal(entries[1]!.profileCandidate, false, "闲聊不标记");
  assert.equal(entries[2]!.profileCandidate, true, "高信号轮恒为候选（夜间兜底）");
});

/* ── T2：WAL 候选读取 ─────────────────────────────────────────── */

async function seedWal(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const line = (o: Record<string, unknown>): string => JSON.stringify(o);
  const day21 = join(dir, "2026-10-21.jsonl");
  const day22 = join(dir, "2026-10-22.jsonl");
  await writeFile(
    day21,
    [
      line({ ts: "2026-10-21T01:00:00.000Z", actorId: "u1", userText: "我叫王铭川", profileCandidate: true }),
      line({ ts: "2026-10-21T02:00:00.000Z", actorId: "u1", userText: "今天不错" }), // 无标记
      line({ ts: "2026-10-21T03:00:00.000Z", actorId: "u2", userText: "我叫小李", profileCandidate: true }), // 他人
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    day22,
    [
      line({ ts: "2026-10-22T01:00:00.000Z", actorId: "u1", userText: "我住兴义", profileCandidate: true }),
      line({ ts: "2026-10-22T02:00:00.000Z", actorId: "u1", userText: "我是做后端的", profileCandidate: true }),
    ].join("\n") + "\n",
    "utf8",
  );
}

test("T2 readWalProfileCandidates：按 actor 过滤 + 只收候选 + sinceTs 之后 + ts 升序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wal-read-test-"));
  await seedWal(dir);
  const got = await readWalProfileCandidates("u1", "2026-10-21T00:00:00.000Z", { walDir: dir });
  assert.deepEqual(
    got.map((c) => c.userText),
    ["我叫王铭川", "我住兴义", "我是做后端的"],
    "他人条目与无标记条目应被过滤，按 ts 升序",
  );
  const since = await readWalProfileCandidates("u1", "2026-10-22T00:00:00.000Z", { walDir: dir });
  assert.deepEqual(since.map((c) => c.userText), ["我住兴义", "我是做后端的"], "sinceTs 之后才计入");
});

/* ── T2：夜间批抽取 + checkpoint ──────────────────────────────── */

function fakeExtraction(ops: UnifiedExtraction["profileOps"]): UnifiedExtraction {
  return {
    decision: "remember",
    memories: [],
    commitments: [],
    corrections: [],
    understandings: [],
    facts: [],
    forget: [],
    referents: [],
    importance: 0.7,
    ...(ops && ops.length > 0 ? { profileOps: ops } : {}),
  } as UnifiedExtraction;
}

test("T2 consolidateProfileFromWal：消费候选 → 落位 → 推进 checkpoint → 下次零候选", async () => {
  const walDir = await mkdtemp(join(tmpdir(), "wal-consol-test-"));
  const ckptFile = join(walDir, "checkpoint.json");
  await seedWal(walDir);

  const appliedOps: Array<{ line: string }> = [];
  const stats = await consolidateProfileFromWal(
    "u1",
    {
      readProfile: () => "# 用户画像\n\n## 基本信息\n\n- （待了解）\n",
      applyOps: async (ops) => {
        appliedOps.push(...ops);
        return true;
      },
      extractFn: async (_text, opts) => {
        // 输入应为 WAL 全文（非 120 字残片），且带当前画像上下文
        assert.ok(opts.profileContext.currentProfile.includes("用户画像"));
        assert.ok(_text.includes("我叫王铭川"));
        return fakeExtraction([{ op: "ADD", section: "basic", line: "称呼：王铭川", match: undefined }]);
      },
    },
    { walDir, checkpointFile: ckptFile },
  );

  assert.equal(stats.candidates, 3);
  assert.equal(stats.processed, 3);
  assert.equal(stats.opsCount, 1);
  assert.equal(stats.applied, true);
  assert.equal(stats.checkpointAdvanced, true);
  assert.equal(appliedOps.length, 1);
  assert.equal(appliedOps[0]!.line, "称呼：王铭川");

  const ckpt = await loadProfileCheckpoint(ckptFile);
  assert.equal(ckpt.actors["u1"], "2026-10-22T02:00:00.000Z", "checkpoint 推进到最后一条候选");

  // 第二晚：无新候选 → 零成本
  const again = await consolidateProfileFromWal(
    "u1",
    {
      readProfile: () => "",
      applyOps: async () => true,
      extractFn: async () => {
        throw new Error("不应再调用 LLM");
      },
    },
    { walDir, checkpointFile: ckptFile },
  );
  assert.equal(again.candidates, 0);
  assert.equal(again.checkpointAdvanced, false);
});

test("T2 consolidateProfileFromWal：抽取失败不推进 checkpoint（下晚重试）", async () => {
  const walDir = await mkdtemp(join(tmpdir(), "wal-fail-test-"));
  const ckptFile = join(walDir, "checkpoint.json");
  await seedWal(walDir);

  let calls = 0;
  const stats = await consolidateProfileFromWal(
    "u1",
    {
      readProfile: () => "",
      applyOps: async () => true,
      extractFn: async () => {
        calls++;
        return null; // LLM 失败
      },
    },
    { walDir, checkpointFile: ckptFile },
  );
  assert.equal(calls, 1);
  assert.equal(stats.extractionFailed, true, "抽取失败要显式标注");
  assert.equal(stats.checkpointAdvanced, false, "失败不得推进 checkpoint");

  const ckpt = await loadProfileCheckpoint(ckptFile);
  assert.equal(ckpt.actors["u1"], undefined, "checkpoint 应仍为空");

  // 下一晚成功 → 候选还在，正常推进
  const ok = await consolidateProfileFromWal(
    "u1",
    {
      readProfile: () => "",
      applyOps: async () => true,
      extractFn: async () => fakeExtraction([]),
    },
    { walDir, checkpointFile: ckptFile },
  );
  assert.equal(ok.candidates, 3, "候选未丢失（at-least-once）");
  assert.equal(ok.checkpointAdvanced, true);
});

test("T2 consolidateProfileFromWal：空产物也推进 checkpoint（避免每晚重跑无产出候选）", async () => {
  const walDir = await mkdtemp(join(tmpdir(), "wal-empty-test-"));
  const ckptFile = join(walDir, "checkpoint.json");
  await seedWal(walDir);
  const stats = await consolidateProfileFromWal(
    "u1",
    {
      readProfile: () => "",
      applyOps: async () => {
        throw new Error("空产物不应触发落位");
      },
      extractFn: async () => fakeExtraction([]),
    },
    { walDir, checkpointFile: ckptFile },
  );
  assert.equal(stats.opsCount, 0);
  assert.equal(stats.checkpointAdvanced, true);
});

/* ── 顺手修回归 ───────────────────────────────────────────────── */

const PROFILE_WITH_TONE = `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。

## 基本信息

- （待了解：称呼、常用语言、所在地等）

## 沟通偏好

- 语气风格：自然均衡（系统会根据对话自动调整）
`;

test("回归：writer 写「系统会根据对话自动调整」不再被误判为真实画像内容", () => {
  assert.equal(
    hasRealProfileContent(PROFILE_WITH_TONE),
    false,
    "纯模板 + tone 样板行（带「会」）应判为无真实内容，占位行不注入 prompt",
  );
  assert.equal(
    hasRealProfileContent(PROFILE_WITH_TONE.replace("- （待了解：称呼、常用语言、所在地等）", "- 称呼：王铭川")),
    true,
    "出现真实事实后应判为有内容",
  );
});

test("回归：basic 段 ADD 同字段不同值 → 原位替换（一字段一行）；同值幂等", () => {
  const base = "# 用户画像\n\n## 基本信息\n\n- 称呼：王哥\n\n## 备注\n\n- x\n";
  const r1 = applyProfileOps(base, [{ op: "ADD", section: "basic", line: "称呼：王king" }]);
  assert.equal(r1.profile.split("\n").filter((l) => l.includes("称呼：")).length, 1, "同字段只留一行");
  assert.ok(r1.profile.includes("称呼：王king"), "新值替换旧值");
  assert.ok(!r1.profile.includes("称呼：王哥"), "旧值被替换");
  assert.equal(verifyProfileOps(r1.profile, r1.applied).length, 0);

  const r2 = applyProfileOps(base, [{ op: "ADD", section: "basic", line: "称呼：王哥" }]);
  assert.equal(r2.profile.split("\n").filter((l) => l.includes("称呼：王哥")).length, 1, "同值幂等不重复");
});

test("回归：NAME_RE 不再把「我是做后端的」捕成称呼", () => {
  const patches = extractProfilePatches("我是做后端的");
  assert.equal(
    patches.some((p) => p.displayName),
    false,
    "「我是」是身份陈述不是称呼指定",
  );
  const name = extractProfilePatches("我叫王铭川");
  assert.equal(name[0]?.displayName, "王铭川", "「我叫」仍正常捕获");
});

test("批调度开关：默认 batch，legacy 显式关闭", async () => {
  const mod = await import("../src/services/profile-write-scheduler.js");
  const prev = process.env.PROFILE_WRITE_SCHEDULING;
  try {
    delete process.env.PROFILE_WRITE_SCHEDULING;
    assert.equal(mod.isProfileWriteBatchMode(), true, "默认 batch");
    process.env.PROFILE_WRITE_SCHEDULING = "legacy";
    assert.equal(mod.isProfileWriteBatchMode(), false);
    process.env.PROFILE_WRITE_SCHEDULING = "batch";
    assert.equal(mod.isProfileWriteBatchMode(), true);
  } finally {
    if (prev === undefined) delete process.env.PROFILE_WRITE_SCHEDULING;
    else process.env.PROFILE_WRITE_SCHEDULING = prev;
  }
});

test("seedWal 辅助自检：天文件落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wal-seed-check-"));
  await seedWal(dir);
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith(".jsonl")).sort(), ["2026-10-21.jsonl", "2026-10-22.jsonl"]);
});
