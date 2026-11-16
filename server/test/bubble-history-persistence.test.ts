/**
 * 真·分绿泡历史回填链路单测（2026-11-13 P0-A / P0-B）：
 *
 * 背景：分泡结构此前只活在当轮内存（BubbleTracker）+ 客户端本地 Isar；
 * turn WAL 只落合并 assistantText → 重装/换设备后 /api/chat-data/history?full=1
 * 只能回一条合并正文，历史「整轮塌成单泡内分段」。修复：
 * - P0-A：出口 replaceAssistantText 把 BubbleTracker.snapshot 落进 WAL 行
 *   （bubbles 字段），history 透传，客户端逐泡重建；
 * - P0-B：segmenter emit 前折叠泡内空白段（maxBubbles 封顶后的 continue
 *   残差 / 去重残行 / 空行残留），单泡内部不再出现空行间隙。
 *
 * 覆盖：
 * - replaceAssistantTextInJsonl：bubbles 随 assistantText 精准写入匹配行
 * - readActorTranscriptFromWal：WAL 行 → turn.bubbles 透传（脏结构过滤）
 * - StreamSegmenter bubbleMode：超 maxBubbles 的多段残差并入末泡时无空行
 * - StreamSegmenter 非 bubble 分段：flushFinal 残差空行折叠
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replaceAssistantTextInJsonl } from "../src/services/turn-wal-service.js";
import { readActorTranscriptFromWal } from "../src/services/wal-transcript.js";
import { StreamSegmenter } from "../src/agent/stream-segmenter.js";

const BLANK_LINE_RE = /\n[ \t]*\n/u;

test("replaceAssistantTextInJsonl：assistantText + bubbles 精准写入匹配行，其余行逐字保留", () => {
  const otherLine = JSON.stringify({
    ts: "2026-11-13T08:00:00.000Z",
    actorId: "actor-a",
    userText: "别的账号的一轮",
    assistantText: "别人的回复",
    messageId: "msg-other",
  });
  const targetLine = JSON.stringify({
    ts: "2026-11-13T08:01:00.000Z",
    actorId: "actor-1",
    userText: "明早叫我",
    assistantText: "[RENDER_HINT]旧的模型原文",
    messageId: "msg-1",
  });
  const raw = `${otherLine}\n${targetLine}\n`;

  const replaced = replaceAssistantTextInJsonl(raw, {
    actorId: "actor-1",
    messageId: "msg-1",
    assistantText: "好，到点叫你。\n不过你今晚得早点睡。",
    bubbles: [
      { id: "assistant-msg-1-b1", text: "好，到点叫你。" },
      { id: "assistant-msg-1-b2", text: "不过你今晚得早点睡。" },
    ],
  });

  assert.ok(replaced, "命中 (actorId, messageId) 必须返回重写结果");
  const lines = replaced!.split("\n");
  assert.equal(lines.length, 3, "行数不变（含尾空行）");
  assert.equal(lines[0], otherLine, "其他 actor 的行逐字保留");
  const rewritten = JSON.parse(lines[1]) as {
    assistantText: string;
    bubbles?: Array<{ id: string; text: string }>;
    userText: string;
  };
  assert.equal(rewritten.assistantText, "好，到点叫你。\n不过你今晚得早点睡。");
  assert.deepEqual(rewritten.bubbles, [
    { id: "assistant-msg-1-b1", text: "好，到点叫你。" },
    { id: "assistant-msg-1-b2", text: "不过你今晚得早点睡。" },
  ]);
  assert.equal(rewritten.userText, "明早叫我", "其余字段不动");
});

test("replaceAssistantTextInJsonl：未命中返回 null；空 bubbles 不写入", () => {
  const raw = `${JSON.stringify({ ts: "t", actorId: "a1", assistantText: "x", messageId: "m1" })}\n`;
  assert.equal(
    replaceAssistantTextInJsonl(raw, {
      actorId: "a1",
      messageId: "不存在",
      assistantText: "y",
    }),
    null,
  );
  const replaced = replaceAssistantTextInJsonl(raw, {
    actorId: "a1",
    messageId: "m1",
    assistantText: "y",
  });
  assert.ok(replaced);
  const parsed = JSON.parse(replaced!) as { bubbles?: unknown };
  assert.equal(parsed.bubbles, undefined, "无 bubbles 入参时不新增字段");
});

test("readActorTranscriptFromWal：bubbles 字段透传为 turn.bubbles，脏结构被过滤", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nb-wal-bubbles-"));
  const validBubbles = [
    { id: "assistant-msg-1-b1", text: "好，到点叫你。" },
    { id: "assistant-msg-1-b2", text: "不过你今晚得早点睡。" },
  ];
  const lines = [
    // 命中行：bubbles 有效（混入一条空 text 脏泡，应被过滤）
    JSON.stringify({
      ts: "2026-11-13T08:00:00.000Z",
      actorId: "actor-1",
      userText: "明早叫我",
      assistantText: "好，到点叫你。\n不过你今晚得早点睡。",
      messageId: "msg-1",
      bubbles: [...validBubbles, { id: "assistant-msg-1-b3", text: "   " }],
    }),
    // 旧行：无 bubbles
    JSON.stringify({
      ts: "2026-11-13T08:02:00.000Z",
      actorId: "actor-1",
      userText: "天气怎么样",
      assistantText: "晴。",
      messageId: "msg-2",
    }),
    // bubbles 是非数组脏结构
    JSON.stringify({
      ts: "2026-11-13T08:03:00.000Z",
      actorId: "actor-1",
      userText: "第三轮",
      assistantText: "嗯。",
      messageId: "msg-3",
      bubbles: "not-an-array",
    }),
    // 别的 actor 的行
    JSON.stringify({
      ts: "2026-11-13T08:04:00.000Z",
      actorId: "actor-2",
      userText: "别人的",
      assistantText: "回复",
      bubbles: validBubbles,
    }),
  ];
  await writeFile(join(dir, "2026-11-13.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const turns = await readActorTranscriptFromWal(dir, "actor-1");
  assert.equal(turns.length, 3);
  assert.deepEqual(
    turns[0].bubbles,
    validBubbles,
    "空 text 脏泡被过滤，有效泡原样透传",
  );
  assert.equal(turns[1].bubbles, undefined, "旧行无 bubbles");
  assert.equal(turns[2].bubbles, undefined, "非数组脏结构静默忽略");
});

/** 6 行 ≥12 可见字的消息行，行间空行（模型原文段落间隙）。 */
function longMultiParagraphReply(): string {
  const line = (i: number) => `第${i}条消息内容足够长可以单独成泡。`;
  return [1, 2, 3, 4, 5, 6].map(line).join("\n\n");
}

test("StreamSegmenter bubbleMode：maxBubbles 封顶后的多段残差并入末泡时无空行（P0-B 真机取证回归）", async () => {
  const emits: Array<{ text: string; meta?: { bubble?: "new" | "continue" } }> = [];
  const seg = new StreamSegmenter((segment, _phase, meta) => {
    emits.push({ text: segment, meta });
  }, {
    bubbleMode: true,
    bubbleGapMinMs: 1,
    bubbleGapMaxMs: 2,
    bubbleGapPerCharMs: 0,
  });

  seg.feed(longMultiParagraphReply());
  await seg.flushFinal();

  const newBubbles = emits.filter((e) => e.meta?.bubble === "new");
  assert.equal(newBubbles.length, 4, "maxBubbles=4：封顶前切出 4 个独立泡");
  const tail = emits[emits.length - 1];
  assert.equal(tail.meta?.bubble, "continue", "超出上限的残差并入末泡");
  assert.equal(
    BLANK_LINE_RE.test(tail.text),
    false,
    `末泡不得含空行（实际：${JSON.stringify(tail.text)}）`,
  );
  assert.equal(
    tail.text,
    "第5条消息内容足够长可以单独成泡。\n第6条消息内容足够长可以单独成泡。",
    "泡内空行折叠为单换行（两条消息边界保留为单换行）",
  );
  for (const e of emits) {
    assert.equal(BLANK_LINE_RE.test(e.text), false, `所有泡都不得含空白段：${JSON.stringify(e.text)}`);
  }
});

test("StreamSegmenter 非 bubble 分段：flushFinal 残差的空行同样折叠（P0-B）", async () => {
  const emits: string[] = [];
  const seg = new StreamSegmenter((segment) => {
    emits.push(segment);
  }, { segmentationEnabled: true, holdFirstSentence: false });

  seg.feed("第一句话已经说得很明白了。\n\n残留A段没有句末边界\n\n残留B段也没有");
  await seg.flushFinal();

  assert.ok(emits.length >= 2, "首句 + 尾部残差至少各 emit 一次");
  const last = emits[emits.length - 1];
  assert.equal(
    BLANK_LINE_RE.test(last),
    false,
    `同泡分段递进的尾段不得含空白段（实际：${JSON.stringify(last)}）`,
  );
  // 注：残差两段的拼接顺序（buffer 残句先于 blockBuffer 信息块）是非 bubble
  // 分段模式的既有行为（升级前如此），不属于本次 P0-B 范围——这里只断言
  // 空行折叠生效与两段内容都在。
  assert.ok(last.includes("残留A段没有句末边界"));
  assert.ok(last.includes("残留B段也没有"));
});
