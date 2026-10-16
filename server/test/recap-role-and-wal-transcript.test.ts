import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChatThreadStore,
  buildTimestampFreeLlmView,
} from "../src/external-model/chat-thread-store.js";
import {
  readActorTranscriptFromWal,
  setActorTranscriptClearedAt,
} from "../src/services/wal-transcript.js";

/**
 * P0-B 根修契约（2026-10-12）：recap 摘要角色 assistant → system。
 * 病根：assistant 角色的摘要在模型眼里是「自己说过的话」，是复读诱导的结构根源。
 * 根修后：摘要是 system（给模型看的上下文），模型不再有「复述自己发言」的角色诱导；
 * 存量 assistant 形态 recap 继续识别（迁移期兼容）。
 */

const RECAP_HEAD = "[session-recap]\nEarlier conversation recap:";

test("P0-B: trim 重建的 recap 是 system 角色，且位置在 system 主提示之后", () => {
  const store = new ChatThreadStore(null);
  const sid = "recap-role-test";
  for (let i = 1; i <= 30; i++) {
    store.appendTurn(sid, "sys", { text: `user turn ${i}`, clientMessageId: `u-${i}` }, `assistant turn ${i}`);
  }
  const msgs = store.thread(sid, "sys");
  const recaps = msgs.filter((m) => typeof m.content === "string" && m.content.startsWith("[session-recap]"));
  assert.ok(recaps.length > 0, "应有 recap 消息");
  assert.equal(recaps[0].role, "system", "recap 应为 system 角色");
  assert.equal(msgs.indexOf(recaps[0]) > 0, true, "recap 在主 system 之后");
});

test("P0-B: 存量 assistant 形态 recap 在轮次收口时迁移为 system", () => {
  const store = new ChatThreadStore(null);
  const sid = "recap-legacy-test";
  const msgs = store.thread(sid, "sys");
  msgs.push({ role: "assistant", content: `${RECAP_HEAD}\n- [2026/10/11] 旧形态摘要行` });
  msgs.push({ role: "user", content: "在吗" });
  // 迁移发生在 afterTurnCompleted（每轮真实收口必经的标注路径），不在 trimThread
  store.afterTurnCompleted(sid, msgs);
  const recap = msgs.find((m) => typeof m.content === "string" && m.content.startsWith("[session-recap]"));
  assert.ok(recap, "recap 仍在线程");
  assert.equal(recap.role, "system", "收口后迁移为 system");
  assert.ok(JSON.stringify(msgs).includes("旧形态摘要行"), "摘要行内容保留");
});

test("P0-B: removeTransientSystemMessages 豁免 recap（system 角色不被清理）", () => {
  const store = new ChatThreadStore(null);
  const sid = "recap-transient-test";
  const msgs = store.thread(sid, "sys");
  msgs.push({ role: "system", content: `${RECAP_HEAD}\n- [2026/10/12] 摘要` });
  msgs.push({ role: "system", content: "[工具调用原则] transient 指令" });
  msgs.push({ role: "user", content: "hi" });
  store.afterTurnCompleted(sid, msgs);
  const kept = msgs.filter((m) => m.role === "system");
  assert.equal(kept.length, 2, "主 system + recap 都保留");
  assert.ok(kept.some((m) => m.content.startsWith("[session-recap]")), "recap 未被 transient 清理误删");
});

test("P0-B: LLM 视图对 system recap 照常做年龄标注 + 时间锚提示注入", () => {
  const store = new ChatThreadStore(null);
  const sid = "recap-view-test";
  const msgs = store.thread(sid, "sys");
  const yesterday = new Date(Date.now() - 26 * 3600 * 1000);
  const stamp = `[2026/10/11] 测试摘要行`;
  msgs.push({
    role: "system",
    content: `${RECAP_HEAD}\n- ${stamp}`,
  });
  void yesterday;
  msgs.push({ role: "user", content: "今天天气如何" });
  const view = buildTimestampFreeLlmView(msgs, { now: new Date() });
  const recapView = view.messages.find(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("[session-recap]"),
  );
  assert.ok(recapView, "视图中有 recap");
  const text = recapView.content as string;
  assert.ok(text.includes("本块为历史摘要"), "时间锚提示已注入");
  assert.ok(text.includes("约1天前") || text.includes("约 1 天前") || text.includes("昨天"), "跨天年龄标注生效");
});

// ── P1: turn WAL 全量转史 ────────────────────────────────────────────

test("P1: WAL 反解转史——按 actor 过滤、升序、messageId 去重、notes 轮剔除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wal-test-"));
  try {
    const lines = [
      JSON.stringify({ ts: "2026-10-12T09:00:00+08:00", actorId: "a@x", userText: "早上好", assistantText: "早", messageId: "m1" }),
      JSON.stringify({ ts: "2026-10-12T09:05:00+08:00", actorId: "a@x", userText: "提醒我开会", assistantText: "已创建", messageId: "m2" }),
      // 重复行（重试补写）：同 messageId → 去重
      JSON.stringify({ ts: "2026-10-12T09:05:01+08:00", actorId: "a@x", userText: "提醒我开会", assistantText: "已创建", messageId: "m2" }),
      // 其他 actor 的轮次 → 过滤
      JSON.stringify({ ts: "2026-10-12T09:06:00+08:00", actorId: "b@x", userText: "别人的话", assistantText: "别人的回复" }),
      // notes 上下文 → 剔除
      JSON.stringify({ ts: "2026-10-12T09:07:00+08:00", actorId: "a@x", userText: "笔记内容", assistantText: "笔记回复", context: "notes" }),
      // 半截行（进程被杀）→ 跳过
      '{"ts":"2026-10-12T09:08',
    ].join("\n");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-10-12.jsonl"), lines + "\n", "utf8");

    const turns = await readActorTranscriptFromWal(dir, "a@x");
    assert.equal(turns.length, 2, "去重/过滤后剩 2 轮");
    assert.equal(turns[0].userText, "早上好");
    assert.equal(turns[1].clientMessageId, "m2");
    assert.ok(turns[0].ts! < turns[1].ts!, "按时间升序");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1: WAL 目录不存在/空 → 返回空数组不抛错", async () => {
  const missing = await readActorTranscriptFromWal(join(tmpdir(), "wal-not-exist-xyz"), "a@x");
  assert.deepEqual(missing, []);
});

test("清空可见性（2026-10-16）：cleared-at 之前的轮次不下发，之后的照常回填", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wal-cleared-"));
  try {
    await mkdir(dir, { recursive: true });
    const day = join(dir, "2026-10-16.jsonl");
    await writeFile(
      day,
      [
        JSON.stringify({ ts: "2026-10-16T09:00:00+08:00", actorId: "c@x", userText: "清空前的话", assistantText: "清空前的回复", messageId: "m1" }),
        JSON.stringify({ ts: "2026-10-16T11:00:00+08:00", actorId: "c@x", userText: "清空后的话", assistantText: "清空后的回复", messageId: "m2" }),
        "",
      ].join("\n"),
      "utf8",
    );

    // 清空点取两轮之间：第一轮被过滤，第二轮保留
    const clearAtMs = Date.parse("2026-10-16T10:00:00+08:00");
    await setActorTranscriptClearedAt(dir, "c@x", clearAtMs);
    const turns = await readActorTranscriptFromWal(dir, "c@x");
    assert.equal(turns.length, 1, "只回填清空点之后的轮次");
    assert.equal(turns[0].clientMessageId, "m2");

    // 重复清空（更早的时刻）幂等：不回退清空点
    await setActorTranscriptClearedAt(dir, "c@x", clearAtMs - 60_000);
    assert.equal((await readActorTranscriptFromWal(dir, "c@x")).length, 1);

    // 其他 actor 不受影响
    await writeFile(
      day,
      [
        JSON.stringify({ ts: "2026-10-16T09:00:00+08:00", actorId: "c@x", userText: "清空前的话", assistantText: "清空前的回复", messageId: "m1" }),
        JSON.stringify({ ts: "2026-10-16T11:00:00+08:00", actorId: "c@x", userText: "清空后的话", assistantText: "清空后的回复", messageId: "m2" }),
        JSON.stringify({ ts: "2026-10-16T09:30:00+08:00", actorId: "d@x", userText: "别人的话", assistantText: "别人的回复", messageId: "m3" }),
        "",
      ].join("\n"),
      "utf8",
    );
    const dTurns = await readActorTranscriptFromWal(dir, "d@x");
    assert.equal(dTurns.length, 1, "其他 actor 的历史不受 c@x 清空影响");
    assert.equal(dTurns[0].clientMessageId, "m3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
