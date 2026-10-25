/**
 * WAL 定稿回写（2026-10-24）：聊天记录回放要能看到行程卡。
 *
 * 病根：turn-finalizer 落 WAL 的是模型原文，行程卡与协议标记剥离发生在
 * WS 出口更晚一步。回放（/api/chat-data/history?full=1）因此既丢卡、又把
 * [RENDER_HINT]/[NEXT_UP_START] 当正文渲染。这里钉住「按 messageId 覆盖
 * assistantText、其余行/字段不动」的契约。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { replaceAssistantTextInJsonl } from "../src/services/turn-wal-service.js";

const CARD_TEXT =
  '正文\n[AGENT_RESULT_CARD_START]\n{"cardType":"travel_itinerary"}\n[AGENT_RESULT_CARD_END]';

function line(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    ts: "2026-10-24T05:00:00.000Z",
    actorId: "a@x.com",
    userText: "帮我规划三亚2天",
    assistantText: "模型原文",
    messageId: "msg-1",
    highSignal: true,
    ...overrides,
  });
}

test("命中 (actorId, messageId)：只换 assistantText，其余字段与行原样保留", () => {
  const other = line({ messageId: "msg-0", assistantText: "上一轮" });
  const raw = `${other}\n${line({})}\n`;
  const out = replaceAssistantTextInJsonl(raw, {
    actorId: "a@x.com",
    messageId: "msg-1",
    assistantText: CARD_TEXT,
  });
  assert.ok(out, "应命中有一次替换");
  const lines = (out ?? "").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], other, "无关行必须逐字保留");

  const replaced = JSON.parse(lines[1]);
  assert.equal(replaced.assistantText, CARD_TEXT);
  assert.equal(replaced.highSignal, true, "记忆侧字段不能被回写抹掉");
  assert.equal(replaced.userText, "帮我规划三亚2天");
});

test("同 messageId 但 actor 不同：不覆盖", () => {
  const raw = line({ actorId: "b@x.com" });
  assert.equal(
    replaceAssistantTextInJsonl(raw, {
      actorId: "a@x.com",
      messageId: "msg-1",
      assistantText: CARD_TEXT,
    }),
    null,
  );
});

test("未命中 / 空输入：返回 null（调用方跳过重写）", () => {
  assert.equal(
    replaceAssistantTextInJsonl(line({ messageId: "msg-9" }), {
      actorId: "a@x.com",
      messageId: "msg-1",
      assistantText: CARD_TEXT,
    }),
    null,
  );
  assert.equal(
    replaceAssistantTextInJsonl("", { actorId: "a@x.com", messageId: "msg-1", assistantText: CARD_TEXT }),
    null,
  );
});

test("半截行（进程被杀）不阻断其余行解析", () => {
  const raw = `{"actorId":"a@x.com","messageId":"msg-1","assistantText":"旧","userText":"x"\n${line({})}`;
  const out = replaceAssistantTextInJsonl(raw, {
    actorId: "a@x.com",
    messageId: "msg-1",
    assistantText: CARD_TEXT,
  });
  const lines = (out ?? "").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('{"actorId":"a@x.com","messageId":"msg-1","assistantText":"旧"'));
  assert.equal(JSON.parse(lines[1]).assistantText, CARD_TEXT);
});
