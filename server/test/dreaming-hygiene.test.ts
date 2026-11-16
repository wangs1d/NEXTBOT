/**
 * dreaming 卫生回归（2026-11-12）
 *
 * 目标：证明夜间固化「过滤得掉噪音、固化得住有用记忆」。
 *   1. journal 写入剥掉卡片 JSON / RENDER_HINT / session-recap；
 *   2. 同日同轮只落一次（重投递不再产生三份重复）；
 *   3. 助手发言（A）不进长期记忆；
 *   4. 用户陈述的持久事实仍能作为固化候选（fact/prefer 标签不受影响）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeJournalText } from "../src/services/daily-journal-service.js";
import { shouldSolidifyJournalLine, isNoiseLogLine } from "../src/services/nightly-memory-task-service.js";

test("journal 净化：卡片 JSON / RENDER_HINT / session-recap 不入档", () => {
  const raw =
    '[AGENT_RESULT_CARD_START] {"cardType":"quote","items":[{"text":"已设好"}]} [AGENT_RESULT_CARD_END] 王哥，一分钟后我喊你';
  const clean = sanitizeJournalText(raw);
  assert.doesNotMatch(clean, /AGENT_RESULT_CARD/);
  assert.match(clean, /王哥，一分钟后我喊你/);

  assert.equal(
    sanitizeJournalText("[RENDER_HINT:structured] 明天有小雨"),
    "明天有小雨",
  );
  assert.equal(
    sanitizeJournalText("[session-recap] Earlier conversation recap: - user asked X"),
    "",
  );
  assert.equal(
    sanitizeJournalText("正常一句话\n[session-recap] recap line"),
    "正常一句话",
  );
});

test("固化过滤：助手发言一律不固化", () => {
  assert.deepEqual(shouldSolidifyJournalLine("A", "王哥，这个点才吃上，先吃，别边吃边干活"), {
    solidify: false,
    reason: "assistant_self_talk",
  });
  // 哪怕助手说的是"事实性"内容，也不作为用户记忆
  assert.equal(shouldSolidifyJournalLine("A", "明天兴义小雨，气温 12 到 18 度").solidify, false);
});

test("固化过滤：用户陈述的持久事实保留", () => {
  const cases: Array<[string, string]> = [
    ["U", "以后叫我王哥"],
    ["U", "我在兴义做独立开发，最近在赶一个语音项目"],
    ["prefer", "喜欢手冲咖啡，不加糖"],
    ["fact", "e-abc 明天下午三点在三亚凤凰机场接机"],
  ];
  for (const [role, text] of cases) {
    assert.equal(shouldSolidifyJournalLine(role, text).solidify, true, `${role}: ${text}`);
  }
});

test("固化过滤：寒暄、短问句、一次性提醒不固化", () => {
  assert.equal(shouldSolidifyJournalLine("U", "好的谢谢").reason, "noise");
  assert.equal(shouldSolidifyJournalLine("U", "明天天气怎么样？").reason, "bare_question");
  assert.equal(shouldSolidifyJournalLine("U", "一分钟后提醒我去游泳吧").reason, "one_shot_reminder");
  assert.equal(shouldSolidifyJournalLine("U", "三分钟内提醒我关火").reason, "one_shot_reminder");
});

test("journal 同日同轮去重：完全相同的问答只落一次", async (t) => {
  const { DailyJournalService } = await import("../src/services/daily-journal-service.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-journal-"));
  let svc: InstanceType<typeof DailyJournalService>;
  try {
    svc = new DailyJournalService(dir);
  } catch (err) {
    // 本地 Node 22 与 better-sqlite3 编译版本（137）不匹配时跳过；CI 的 Node 24 会正常跑
    if (/NODE_MODULE_VERSION|ERR_DLOPEN/.test(String(err))) {
      t.skip("better-sqlite3 ABI 不匹配（Node 22 vs 编译 137）");
      return;
    }
    throw err;
  }
  const actor = "dedup-actor";
  const user = "以后叫我王哥";
  const assistant = "记上了，王哥";

  svc.appendTurn(actor, "sess-1", user, assistant);
  svc.appendTurn(actor, "sess-1", user, assistant); // 重投递
  svc.appendTurn(actor, "sess-2", user, assistant); // 另一条路径
  await new Promise((r) => setTimeout(r, 120));

  const files = fs.readdirSync(path.join(dir, "dedup-actor")).filter((f) => f.startsWith("journal-"));
  const body = files.map((f) => fs.readFileSync(path.join(dir, "dedup-actor", f), "utf8")).join("");
  const hits = body.split("\n").filter((l) => l.includes("U: 以后叫我王哥")).length;
  assert.equal(hits, 1, `同轮应只落一次，实际 ${hits} 次：\n${body}`);
});

test("固化过滤：动作指令不进长期记忆", () => {
  const cases = [
    "请使用 agent.send_to_peer 工具给好友发一条消息",
    "帮我给好友 1657687600 发一条消息：今晚七点一起吃饭",
    "帮我规划这个周末附近游玩的路线",
    "帮我搜索几张马尔代夫的照片",
  ];
  for (const text of cases) {
    assert.equal(shouldSolidifyJournalLine("U", text).reason, "task_instruction", text);
  }
  // 状态陈述即便含动作词也保留（"我要赚钱"不是在让我操作）
  assert.equal(shouldSolidifyJournalLine("U", "哎 我要赚钱 娶刘浩存").solidify, true);
});

test("固化过滤：commit 行（助手承诺派生）不固化", () => {
  assert.equal(
    shouldSolidifyJournalLine("commit", "要是过两天还没动静，跟我说一声，我帮你再催一次").reason,
    "assistant_self_talk",
  );
});

test("固化过滤：无问号的短问句与钟点叫醒也过滤", () => {
  assert.equal(shouldSolidifyJournalLine("U", "明天天气").reason, "bare_question");
  assert.equal(shouldSolidifyJournalLine("U", "我帅吗").reason, "bare_question");
  assert.equal(shouldSolidifyJournalLine("U", "明天早上8点叫我起床").reason, "one_shot_reminder");
  assert.equal(shouldSolidifyJournalLine("U", "我就存").reason, "noise");
});

test("isNoiseLogLine 仍保留 fact/prefer 行", () => {
  assert.equal(isNoiseLogLine("fact", "好的"), false);
  assert.equal(isNoiseLogLine("prefer", "嗯"), false);
  assert.equal(isNoiseLogLine("U", "嗯嗯"), true);
});
