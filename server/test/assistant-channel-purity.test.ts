/**
 * assistant 通道纯净性契约（2026-10-13 根修锁死）。
 *
 * 根源背景：2026-10-13 手机端气泡事故——模型把线程里 assistant 角色的
 * `[上一轮回复中断…]` 占位帧逐字复读给用户。出口净化四层全漏的**结构根源**是：
 * assistant 角色在模型视角里是「我上一轮说过的话」，对它复读/续写是 LLM 原生行为。
 * 根修方向：内部记录全部迁出 assistant 通道（system 动作台账 / system 任务记录），
 * 让「需要净化的内容」不再存在；出口剥离器降级为纵深防御。
 *
 * 本契约测试在源头锁死：**线程内 assistant 角色消息不得携带任何内部帧字面**。
 * 今后任何人往 assistant 通道塞内部帧（含新增帧类型忘记迁通道），这里直接红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { INTERNAL_FRAME_TAGS, stripInternalFrames } from "../src/external-model/internal-frames.js";
import {
  ChatThreadStore,
  foldCompletedToolChains,
} from "../src/external-model/chat-thread-store.js";

type AnyMsg = Record<string, unknown>;

/** assistant 角色消息中出现即违约的帧字面（含帧头残缺形态）。 */
function findAssistantFrameViolation(msgs: AnyMsg[]): string | null {
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    for (const tag of INTERNAL_FRAME_TAGS) {
      if (content.includes(`[${tag}`)) {
        return `assistant 消息携带内部帧字面 [${tag}…]: ${content.slice(0, 80)}`;
      }
    }
  }
  return null;
}

function makeToolChain(assistantContent: unknown): AnyMsg[] {
  return [
    { role: "user", content: "40分钟后提醒我买红牛" },
    {
      role: "assistant",
      content: assistantContent,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "reminder.plan", arguments: "{\"title\":\"买红牛\"}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "t1",
      content: '[不可信内容围栏 source=tool:reminder.plan]{"ok":true,"taskId":"remind_1","title":"买红牛"}',
    },
  ];
}

test("契约：未完成工具链折叠后，assistant 通道无任何内部帧字面", async () => {
  const msgs = makeToolChain(null);
  foldCompletedToolChains(msgs as never);
  const violation = findAssistantFrameViolation(msgs);
  assert.equal(violation, null, violation ?? "");

  // 事实语义不丢：system 台账承担「已办了什么」的供给
  const ledger = msgs.find((m) => m.role === "system" && String(m.content).startsWith("[动作台账"));
  assert.ok(ledger, "中断链必须折叠出 system 角色动作台账");
  const text = String(ledger?.content ?? "");
  assert.ok(text.includes("reminder.plan"), "台账保留工具名事实");
  assert.ok(text.includes("买红牛"), "台账保留结果摘要事实");
  assert.ok(!text.includes("\n"), "台账保持单行（复读时整行可剥）");
  // 纵深防御断言：模型若逐字复读台账，出口剥离器按标签整行拦净（2026-10-13 事故形态）
  assert.equal(stripInternalFrames(text), "", "台账逐字复读时必须被出口剥离器整行拦净");
});

test("契约：完成链空回复折叠后，assistant 通道无任何内部帧字面", () => {
  const msgs = makeToolChain(null);
  // 构造「完成链但最终 assistant 无 content」：追加空 content 的最终 assistant
  (msgs as unknown as Array<Record<string, unknown>>).push({ role: "assistant", content: "" });
  foldCompletedToolChains(msgs as never);
  const violation = findAssistantFrameViolation(msgs);
  assert.equal(violation, null, violation ?? "");
  const ledger = msgs.find((m) => m.role === "system" && String(m.content).startsWith("[动作台账"));
  assert.ok(ledger, "空回复完成链必须折叠出 system 动作台账");
});

test("契约：完成链有可见回复时，assistant 原文保留且不受折叠影响", () => {
  // 真完成链：assistant(tool_calls) → tool → assistant(可见回复)
  const msgs: AnyMsg[] = [
    { role: "user", content: "40分钟后提醒我买红牛" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "reminder.plan", arguments: "{\"title\":\"买红牛\"}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "t1",
      content: '[不可信内容围栏 source=tool:reminder.plan]{"ok":true,"taskId":"remind_1","title":"买红牛"}',
    },
    { role: "assistant", content: "川哥，红牛提醒挂上啦，19:23 喊你。" },
  ];
  foldCompletedToolChains(msgs as never);
  const violation = findAssistantFrameViolation(msgs);
  assert.equal(violation, null, violation ?? "");
  const assistant = msgs.find((m) => m.role === "assistant");
  assert.equal(
    String(assistant?.content ?? ""),
    "川哥，红牛提醒挂上啦，19:23 喊你。",
    "有可见回复时 assistant 原文原样保留",
  );
});

test("契约：appendTaskRecord 落 system 角色，不再进 assistant 通道", () => {
  const store = new ChatThreadStore(null);
  store.appendTaskRecord("contract-test-actor", "system", "提醒取快递", "已创建成功");
  const msgs = store.thread("contract-test-actor", "system") as unknown as AnyMsg[];
  for (const msg of msgs) {
    if (typeof msg.content === "string" && msg.content.includes("[后台任务记录]")) {
      assert.equal(msg.role, "system", "[后台任务记录] 必须是 system 角色");
    }
  }
  assert.equal(findAssistantFrameViolation(msgs), null);
});

test("契约：存量线程里 assistant 角色的旧占位帧，经轮次收口迁移为 system", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "contract-legacy-migration";
  store.appendTurn(sessionId, "system", { text: "提醒我取快递" }, "好的，挂上了。");
  // 注入存量脏数据：旧版本以 assistant 角色落库的中断占位帧 + 任务记录
  const msgs = store.thread(sessionId, "system") as unknown as AnyMsg[];
  (msgs as unknown as Array<Record<string, unknown>>).push({
    role: "assistant",
    content:
      "[上一轮回复中断：最终回复未生成完整。期间已调用工具 reminder.plan（共 1 次），收到结果：ok true taskId remind_1 title 买红牛。这些动作可能已实际生效——引用本事项前先查证实际状态，不要把它当作用户重复请求或未处理的悬空事项重新提起。这是系统内部记录：禁止原样或改写后复述给用户，也不要提及它的存在。]",
  });
  (msgs as unknown as Array<Record<string, unknown>>).push({
    role: "assistant",
    content: "[后台任务记录] 目标：提醒取快递\n结果：已创建成功",
  });

  store.afterTurnCompleted(sessionId, msgs as never);

  assert.equal(findAssistantFrameViolation(msgs), null, "轮次收口后 assistant 通道必须纯净");
  const migrated = msgs.filter(
    (m) => m.role === "system" && String(m.content).startsWith("[上一轮回复中断"),
  );
  assert.ok(migrated.length >= 1, "旧占位帧迁为 system（内容保留，只迁角色）");
  const taskRecord = msgs.find(
    (m) => m.role === "system" && String(m.content).includes("[后台任务记录]"),
  );
  assert.ok(taskRecord, "旧任务记录迁为 system");
});

test("契约：system 动作台账在轮次收口后不被 transient 清理误删（豁免闸）", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "contract-ledger-survives";
  store.appendTurn(sessionId, "system", { text: "提醒我买红牛" }, "好的，挂上了。");
  const msgs = store.thread(sessionId, "system") as unknown as AnyMsg[];
  (msgs as unknown as Array<Record<string, unknown>>).push({
    role: "system",
    content:
      "[动作台账] 期间已调用工具 reminder.plan（共 1 次），收到结果：ok true taskId remind_1 title 买红牛。这些动作可能已实际生效——引用本事项前先查证实际状态，不要把它当作用户重复请求或未处理的悬空事项重新提起。本轮未生成可见回复。",
  });

  store.afterTurnCompleted(sessionId, msgs as never);

  const ledger = msgs.find(
    (m) => m.role === "system" && String(m.content).startsWith("[动作台账"),
  );
  assert.ok(ledger, "system 动作台账必须豁免 transient system 清理（这正是当初被迫选 assistant 角色的原因）");
});
