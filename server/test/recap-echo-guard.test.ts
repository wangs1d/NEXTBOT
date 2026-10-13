import test from "node:test";
import assert from "node:assert/strict";

import {
  ChatThreadStore,
  isRecapEchoText,
} from "../src/external-model/chat-thread-store.js";

/**
 * recap 回显闸契约（2026-10-12 摘要直出事故）。
 *
 * 事故链路：模型把线程里的 [session-recap] 块（assistant 角色）整块复述 → 出口只剥
 * 标签行、正文照发并落库成普通 assistant 消息 → 下一轮模型看到「自己复述过」再复读，
 * /history 还把它当聊天记录下发手机端 → 自我维持循环。本组用例锁定四道闸：
 * 判据、appendTurn 落库口、afterTurnCompleted 收口、恢复路径存量自愈。
 */

const ECHO_UNTAGGED =
  "Earlier conversation recap:\n" +
  "（本块为历史摘要：行首是该事件发生的绝对时刻，紧随的括号是它距现在的时长；" +
  "叙述时必须按括号判断「多久前」——距今超过 1 小时不得说「刚才/刚刚/现在」。）\n" +
  "- [2026/10/12 周一 18:37] agent 交付贵阳两天行程初稿";

const REAL_RECAP =
  "[session-recap]\n" +
  "Earlier conversation recap:\n" +
  "- [2026/10/12 周一 18:37] agent 交付贵阳两天行程初稿";

test("isRecapEchoText：视图提示行/无标签标题开头=回显；真实 recap/正常回复不命中", () => {
  assert.equal(isRecapEchoText(ECHO_UNTAGGED), true, "无标签标题开头的复述残体是回显");
  assert.equal(isRecapEchoText("（本块为历史摘要：单独的视图提示行也拦"), true, "提示行只存在于 LLM 视图");
  assert.equal(isRecapEchoText(REAL_RECAP), false, "带 [session-recap] 标签的真实 recap 不是回显");
  assert.equal(isRecapEchoText("好嘞川哥，5分钟后准时喊您洗澡。"), false, "正常回复不误伤");
  assert.equal(isRecapEchoText(""), false);
});

test("appendTurn：回显正文不落库为 assistant 消息", () => {
  const store = new ChatThreadStore(null);
  const sid = "echo-append-test";
  store.appendTurn(sid, "sys", { text: "？", clientMessageId: "u-1" }, "正常回复");
  store.appendTurn(sid, "sys", { text: "？", clientMessageId: "u-2" }, ECHO_UNTAGGED);
  const msgs = store.thread(sid, "sys");
  assert.equal(
    JSON.stringify(msgs).includes("本块为历史摘要"),
    false,
    "回显正文不得进入线程",
  );
  assert.ok(
    msgs.some((m) => m.role === "assistant" && m.content === "正常回复"),
    "正常回复不受影响",
  );
});

test("afterTurnCompleted：剔除回写进线程的回显消息，真实 recap 原样保留", () => {
  const store = new ChatThreadStore(null);
  const sid = "echo-afterturn-test";
  const msgs = store.thread(sid, "sys");
  msgs.push({ role: "assistant", content: REAL_RECAP });
  msgs.push({ role: "user", content: "？" });
  msgs.push({ role: "assistant", content: ECHO_UNTAGGED });
  store.afterTurnCompleted(sid, msgs);
  const serialized = JSON.stringify(store.thread(sid, "sys"));
  assert.ok(serialized.includes("[session-recap]"), "真实 recap 保留");
  assert.equal(serialized.includes("本块为历史摘要"), false, "回显正文被剔除");
});

test("恢复路径存量自愈：落库已污染的线程在 restore 时剔除回显", () => {
  const persisted = [
    { role: "user", content: "？" },
    { role: "assistant", content: ECHO_UNTAGGED },
    { role: "user", content: "还在吗" },
  ];
  const fake = {
    loadRestoredMessages: (id: string) =>
      id === "restore-echo-test" ? persisted : null,
    hasPersistedMessages: () => true,
    scheduleSave: () => {},
  };
  const store = new ChatThreadStore(
    fake as unknown as ConstructorParameters<typeof ChatThreadStore>[0],
  );
  const t = store.peekThread("restore-echo-test");
  assert.ok(t, "线程应能从持久层恢复");
  assert.equal(
    t.some((m) => m.role === "assistant" && String(m.content).includes("本块为历史摘要")),
    false,
    "存量回显消息在恢复时被剔除",
  );
  assert.ok(
    t.some((m) => m.role === "user" && m.content === "还在吗"),
    "其余消息原样保留",
  );
});
