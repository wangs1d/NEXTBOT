/**
 * 2026-09-08 事故回归测试：闲聊轮「刘浩存才是真主 未来的老婆」被出口诚实闸
 * 误派成后台任务并以裸气泡直推（「突然蹦出一句说媒拒绝」）；会议提醒已创建
 * 成功却被 recap/挂起栈记成「反复请求未完成」（agent 反复追问「要提前多久」）。
 *
 * 本文件锁定四类根源修复的行为契约：
 *  - A. recap 事件级去重：同一事件换措辞/重盖时间戳不得重复入区；
 *  - B. 未完成工具链折叠：占位符必须携带已执行工具的事实，不得留空话占位；
 *  - C. 后台任务记录：单条 assistant 角色事实记录，不再伪造 user 轮；
 *  - D. 中断轮次兜底记账：已送达的部分回复进入 STM 记账，挂起项可被澄清/结清。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const { ChatThreadStore, foldCompletedToolChains, pushRecapLinesUnique } = await import(
  "../src/external-model/chat-thread-store.js"
);
const { ShortTermMemoryGatewayService } = await import(
  "../src/services/short-term-memory-gateway.js"
);

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "recap-integrity-")), name);
}

/* ── A. recap 事件级去重 ─────────────────────────────────────────── */

test("A 事件级去重：同一事件换措辞/重盖时间戳不得重复入区（当晚实录三连）", () => {
  const existing = [
    "- [2026/09/08 周二 00:28] 用户请求今天中午12点有个会议要开，记得提前提醒。",
    // 00:29 与 00:30 的两次「重新盖戳」变体（当晚 recap 实录）
    "- [2026/09/08 周二 00:29] 用户重复请求「今天中午12点有个会议要开 记得提前提醒我」，工具调用被打断未完成。",
  ];
  const merged = pushRecapLinesUnique(existing, [
    "- [2026/09/08 周二 00:30] 用户再次重复请求「今天中午12点有个会议要开 记得提前提醒我」，工具调用被打断未完成。",
    "- [2026/09/08 周二 00:31] 用户重复请求「今天中午12点有个会议要开 记得提前提醒我」，工具调用被打断未完成。",
  ]);
  const meetingLines = merged.filter((l) => l.includes("12点有个会议"));
  assert.equal(meetingLines.length, 2, `同一会议事件不得再繁殖变体行：\n${meetingLines.join("\n")}`);
});

test("A 事件级去重：不同事件不得被误并（景甜 vs 刘浩存、睡觉 vs 会议）", () => {
  const merged = pushRecapLinesUnique(
    [
      "- [2026/09/08 周二 00:24] 用户要求半小时后（00:50）提醒睡觉。",
      "- [2026/09/08 周二 00:24] 用户请求搜索景甜的照片。",
    ],
    [
      "- [2026/09/08 周二 00:28] 用户要求今天中午12点有个会议要开，记得提前提醒。",
      "- [2026/09/08 周二 00:31] 用户请求搜索刘浩存最近的照片。",
      "- [2026/09/08 周二 00:31] 用户名叫王铭川，助手称其「王哥」。",
    ],
  );
  assert.equal(merged.length, 5, `全部新事件都应保留：\n${merged.join("\n")}`);
});

test("A 事件级去重：完全相同行（含标签）精确去重不变", () => {
  const line = "- [2026/09/08 周二 00:28] 用户请求今天中午12点有个会议要开。";
  const merged = pushRecapLinesUnique([line], [line]);
  assert.equal(merged.length, 1);
});

/* ── B. 未完成工具链折叠：占位符携带事实 ─────────────────────────── */

function toolCallMsg(names: string[]): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: names.map((name, i) => ({
      id: `call_${i}`,
      type: "function",
      function: { name, arguments: "{}" },
    })),
  } as unknown as ChatCompletionMessageParam;
}

test("B 折叠动作台账：携带已调用工具名与结果摘要，并禁止当悬空事项重提（2026-10-13 迁 system）", () => {
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "今天中午12点有个会议要开 记得提前提醒我" },
    toolCallMsg(["calendar.create_from_text"]),
    { role: "tool", content: JSON.stringify({ ok: true, summary: "提醒已写入日程" }) },
    // 链被中断：没有最终 assistant 正文
  ];
  foldCompletedToolChains(msgs);
  // 2026-10-13 根修：assistant 通道清零——事实记录以 system 动作台账承载
  const assistants = msgs.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 0, "assistant 通道不得再出现占位帧");
  const ledger = msgs.find((m) => m.role === "system" && String(m.content).startsWith("[动作台账"));
  assert.ok(ledger, "中断链应折叠出 system 动作台账");
  const text = String(ledger!.content);
  assert.match(text, /calendar\.create_from_text/, "台账应点名已调用的工具");
  assert.match(text, /提醒已写入日程/, "台账应携带工具结果摘要");
  assert.match(text, /不要把它当作用户重复请求或未处理的悬空事项重新提起/);
  assert.doesNotMatch(text, /尚未完成即被新消息打断/, "不得再出现空话式旧占位符");
});

test("B 折叠边界：空 tool_calls 不构成链，不折叠", () => {
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "小弟" },
    { role: "assistant", content: null, tool_calls: [] } as unknown as ChatCompletionMessageParam,
  ];
  foldCompletedToolChains(msgs);
  // 空 tool_calls 数组不构成工具链——消息保持原样，不产占位符
  assert.equal(msgs.length, 3);
  assert.equal(msgs.filter((m) => m.role === "assistant").length, 1);
});

test("B 折叠：完成的工具链保留最终回复正文（回归不破坏原契约）", () => {
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "今天中午12点有个会议要开 记得提前提醒我" },
    toolCallMsg(["calendar.create_from_text"]),
    { role: "tool", content: JSON.stringify({ ok: true }) },
    { role: "assistant", content: "安排好了：中午12点的会议记上了，11:30会先提醒你一次。" },
  ];
  foldCompletedToolChains(msgs);
  const assistant = msgs.filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.match(String(assistant[0]!.content), /11:30会先提醒你一次/);
});

/* ── C. 后台任务记录：单条 assistant 角色事实记录 ────────────────── */

test("C appendTaskRecord：单条 system 记录，不伪造 user 轮（2026-10-13 迁 system）", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "session-task-record-test";
  store.appendTaskRecord(
    sessionId,
    "system",
    "刘浩存才是真主 未来的老婆",
    "你这想法挺有意思的哈，不过我就是个小工具人，帮不了你说媒。",
  );
  const msgs = store.thread(sessionId, "system");
  const taskRecords = msgs.filter((m) => String(m.content).includes("[后台任务记录]"));
  assert.equal(taskRecords.length, 1, "应恰好一条任务记录");
  assert.equal(taskRecords[0]!.role, "system", "任务记录必须是 system 角色（assistant 通道清零）");
  assert.match(String(taskRecords[0]!.content), /目标：刘浩存才是真主/);
  assert.match(String(taskRecords[0]!.content), /结果：/);
  const userTurns = msgs.filter(
    (m) => m.role === "user" && String(m.content).includes("后台任务"),
  );
  assert.equal(userTurns.length, 0, "不得再伪造 user 轮 [后台任务] 原文");
});

/* ── D. 中断轮次兜底记账：部分回复进入 STM 记账 ──────────────────── */

test("D 中断轮兜底：已送达的部分回复进入 STM 记账（carryForward 可见 11:30 承诺）", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("integrity.json"));
  const sessionId = "session-interrupt-test";
  const request = "今天中午12点有个会议要开 记得提前提醒我";
  // 轮1：请求进入挂起栈（正常完成轮，回复无实质内容）
  service.reconcileTaskAfterTurn(sessionId, request, "好的。");
  // 轮2：回复流式送达后轮次被新消息打断。原始缺陷：执行路径 catch 直接返回，
  // reconcile 整体跳过——「安排好了…11:30」不进任何账本，挂起栈里只剩裸请求
  // （默认 TTL 6 小时反复注入，agent 反复追问「要提前多久叫你」）。
  // 兜底记账后以部分回复 reconcile，承诺句应入账：
  service.reconcileTaskAfterTurn(
    sessionId,
    request,
    "安排好了：中午12点的会议记上了，11:30会先提醒你一次。到点我叫你，放心。",
  );
  const state: any = service.getTaskState(sessionId);
  const carry = state.conversationMemory.carryForward.join("\n");
  assert.match(carry, /11:30会先提醒你一次/, "部分回复的承诺句必须进入短期记忆账本");
  // 注入 prompt 后可见（同话题追问轮），agent 据此不再追问「要提前多久」
  const prompt = service.buildPromptContext(sessionId, request) ?? "";
  assert.match(prompt, /11:30/, "追问轮的 STM 注入应包含已确认的提醒时刻");
});
