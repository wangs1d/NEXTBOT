import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DailyJournalService } from "../src/services/daily-journal-service.js";
import { TurnLedgerStore } from "../src/services/graph-sqlite-store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一真相源验收：
 *   hm_turns（L0 原文）是权威，journal md 只是派生视图；
 *   固化只关闭 turns/jobs，不删除原文。
 */
test("turns 保留全文：首句之外的内容也能进入长期固化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-truth-"));
  const ledger = new TurnLedgerStore(join(dir, "memory.sqlite"));
  const journal = new DailyJournalService(join(dir, "journal"), ledger);

  try {
    const user = "我住在杭州。第二句话里还有关键信息：我的项目叫 Private-Agent。";
    const assistant = "记住了，你住在杭州，项目叫 Private-Agent。";
    journal.appendTurn("actor-full", "sess-12345678", user, assistant);
    await sleep(50);

    const pending = ledger.listPendingTurns("actor-full");
    assert.equal(pending.length, 1, "每轮应写入一条 turns 记录");
    assert.equal(pending[0]!.userText, user, "turns 必须保存用户全文");
    assert.equal(pending[0]!.assistantText, assistant, "turns 必须保存助手全文");

    const groups = await journal.getUnconsolidatedLines("actor-full");
    assert.equal(groups.length, 1);
    const joined = groups[0]!.lines.join("\n");
    assert.ok(joined.includes("第二句话里还有关键信息"), "固化输入必须包含首句之外的全文");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("固化只关闭 job，不删 turns 原文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-truth-"));
  const ledger = new TurnLedgerStore(join(dir, "memory.sqlite"));
  const journal = new DailyJournalService(join(dir, "journal"), ledger);

  try {
    journal.appendTurn("actor-keep", "sess-abcdefgh", "我喜欢安静的早晨。", "记住了。");
    await sleep(50);

    const groups = await journal.getUnconsolidatedLines("actor-keep");
    assert.equal(groups.length, 1);
    await journal.markConsolidated("actor-keep", [groups[0]!.dateKey]);

    assert.deepEqual(ledger.stats("actor-keep"), { turns: 1, pending: 0 }, "固化后 job 关闭、原文保留");
    assert.equal((await journal.getUnconsolidatedLines("actor-keep")).length, 0, "已固化日期不再重复消费");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("工具事件行同样先落 turns（带来源 token）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-truth-"));
  const ledger = new TurnLedgerStore(join(dir, "memory.sqlite"));
  const journal = new DailyJournalService(join(dir, "journal"), ledger);

  try {
    journal.appendEventLine("actor-event", new Date().toISOString(), {
      token: "e-abc123",
      content: "航班 MU5101 已改签到 18:40",
    });
    await sleep(50);

    const pending = ledger.listPendingTurns("actor-event");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "event");
    assert.equal(pending[0]!.token, "e-abc123");

    const groups = await journal.getUnconsolidatedLines("actor-event");
    assert.ok(groups[0]!.lines.some((line) => line.includes("e-abc123 fact:")), "事件来源 token 应可追溯");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("历史 md 一次性迁入 turns，迁移后由同一链路固化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-truth-"));
  const ledger = new TurnLedgerStore(join(dir, "memory.sqlite"));
  const journal = new DailyJournalService(join(dir, "journal"), ledger);
  const legacyDir = join(dir, "journal", "legacy-actor");

  try {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "journal-2026-11-09.md"),
      [
        "- [09:00] abcdefgh U: 我计划下个月搬到上海。",
        "- [09:00] abcdefgh A: 好的，我会记住你的搬迁计划。",
        "",
      ].join("\n"),
      "utf8",
    );

    const groups = await journal.getUnconsolidatedLines("legacy-actor");
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.dateKey, "2026-11-09");
    assert.ok(ledger.hasTurnsForDate("legacy-actor", "2026-11-09"), "历史 md 应已迁入 turns");

    // 幂等：再跑一次不会重复迁移
    const before = ledger.stats("legacy-actor").turns;
    await journal.getUnconsolidatedLines("legacy-actor");
    assert.equal(ledger.stats("legacy-actor").turns, before, "迁移必须幂等");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
