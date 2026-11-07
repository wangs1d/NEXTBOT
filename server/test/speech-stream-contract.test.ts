import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 流式分层契约（2026-11-05 定稿，2026-11-06 按用户裁决二次修订）：
 *
 *   「流式」「打字机」「分泡」三件事分开：
 *     模型 stream:true → delta 实时进分段器 → 语音数据帧逐句播报（流式保留）
 *     单泡轮文字只由 done.finalText 一次性落屏（打字机退役，不回头）
 *     分泡轮按「信息块」出站整块 chunk —— 一个块 = 一个绿泡（或并回当前泡），
 *     逐泡实时出现；粒度是块不是字，打字机不借此复活。
 *     工具开始执行 = 信息/操作轮 → 冻结分泡，剩余内容并回当前泡（单泡发完）。
 *
 * 运行期行为由 scripts/probe-speech-stream.mjs 对真实服务取证；本文件是
 * 防回归的源码契约，锁住几个「一旦改回去就前功尽弃」的关键点。
 */
const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = (p: string) => readFileSync(join(here, "../src", p), "utf8");
const repoFile = (p: string) => readFileSync(join(here, "../../", p), "utf8");

const handler = serverSrc("ws/handlers/chat-user-message.ts");
const editRoute = serverSrc("routes/http/chat.ts");
const toolLoop = serverSrc("external-model/openai-compatible-tool-loop.ts");
const protocol = repoFile("packages/agent-protocol/src/events.ts");
const mainDart = repoFile("client/flutter_app/lib/main.dart");
const voiceDart = repoFile("client/flutter_app/lib/core/services/pure_voice_mode.dart");

test("模型上游仍是流式生成（stream:true 未被关成非流式）", () => {
  assert.match(toolLoop, /stream:\s*true/, "主 LLM 请求必须保持流式");
});

test("主链路 delta 实时进分段器，realtimeStream 默认开启", () => {
  assert.match(handler, /let realtimeStream = true;/, "流式管道不得默认关闭");
  assert.match(
    handler,
    /if \(realtimeStream && delta\) \{\s*streamSegmenter\.feed\(delta\);/,
    "delta 必须实时喂分段器",
  );
});

test("文字显示帧：分泡轮按泡出站整块 chunk，单泡正文仍只走 done", () => {
  // chunk 出站复活是 2026-11-06 用户裁决（逐泡实时出现），但必须严格圈在
  // bubbleTracker.active 分支内——单泡轮/卡片轮/语音轮永不出站显示帧。
  assert.match(
    handler,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "分泡轮需要按泡出站 chunk",
  );
  const gateIdx = handler.indexOf("if (bubbleTracker.active) {");
  const chunkIdx = handler.indexOf("ServerEventType.ChatAssistantChunk");
  const speechIdx = handler.indexOf("sendSpeechFrame(cleanedChunk, phase, false);");
  assert.ok(gateIdx > 0, "chunk 出站必须有 bubbleTracker.active 门禁");
  assert.ok(
    gateIdx < chunkIdx && chunkIdx < speechIdx,
    "chunk 出站必须圈在分泡分支内、语音帧之前",
  );
  assert.doesNotMatch(
    editRoute,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "编辑重答不得复活打字机",
  );
});

test("分泡裁决（2026-11-06 深夜收窄版）：仅信息域工具关泡，操作类照常分泡", () => {
  const startIdx = handler.indexOf("onExternalToolExecuteStart");
  assert.ok(startIdx > 0, "必须存在工具开始回调");
  const section = handler.slice(startIdx, startIdx + 3000);
  assert.doesNotMatch(
    section,
    /bubbleTracker\.freeze\(\)/,
    "禁止无差别冻结——操作轮并回一泡/空泡数组崩溃是截图事故根因",
  );
  assert.match(
    section,
    /SINGLE_BUBBLE_TOOL_DOMAINS/,
    "信息展示类单泡必须走显式域白名单（DOMAIN_REGISTRY 唯一事实源）",
  );
  assert.match(
    section,
    /streamSegmenter\.disableBubbleMode\(\)/,
    "检索/信息类工具关泡（剩余正文并回一个绿泡）",
  );
  // 发言模型的过程话截止语义保留：awaitPending + noteToolStart 必须还在
  assert.match(section, /awaitPending\(\)/, "工具边界的过程话屏障保留");
  assert.match(section, /noteToolStart/, "发言模型工具边界登记保留");
});

test("语音数据帧：协议登记 + 主链路与编辑重答都有收口 final 帧", () => {
  assert.match(protocol, /ChatAssistantSpeech:\s*"chat\.assistant_speech"/);
  assert.match(handler, /type:\s*ServerEventType\.ChatAssistantSpeech/);
  assert.match(editRoute, /type:\s*ServerEventType\.ChatAssistantSpeech/);
  assert.match(handler, /sendSpeechFrame\("", "stream", true, finalText\)/);
  assert.match(editRoute, /sendEditSpeechFrame\("", true, replyFinalText\)/);
});

test("final 帧恒在 done 之前，且 done 仍是唯一文字正文出口", () => {
  const finalIdx = handler.indexOf('sendSpeechFrame("", "stream", true, finalText)');
  const doneIdx = handler.indexOf("type: ServerEventType.ChatAssistantDone", finalIdx);
  assert.ok(finalIdx > 0, "必须存在语音收口帧");
  assert.ok(doneIdx > finalIdx, "收口帧必须先于 done 下发");
  assert.match(handler, /finalTextReplacesStream = true/, "done 仍按整段落屏");
});

test("收尾不再把 finalFeed 喂回分段器（否则 TTS 会把整段复播一遍）", () => {
  assert.doesNotMatch(
    handler,
    /streamSegmenter\.feed\(finalFeed\)/,
    "流式增量已经在生成过程中下发，收尾只 flush 尾部半句",
  );
  assert.match(handler, /await streamSegmenter\.flushFinal\(\)/);
});

test("客户端语音帧只进 TTS，绝不落消息列表", () => {
  const start = mainDart.indexOf('if (type == "chat.assistant_speech")');
  const end = mainDart.indexOf('if (type == "chat.assistant_chunk")', start);
  assert.ok(start > 0 && end > start, "main.dart 必须有语音数据帧分支");
  const branch = mainDart.slice(start, end);
  assert.match(branch, /onSpeechFrame\(/);
  assert.doesNotMatch(branch, /_appendChunkToMessageList|appendChunk\(/);
  assert.match(voiceDart, /_sentenceBoundary/);
  assert.match(voiceDart, /_enqueueSpeak/);
  assert.match(voiceDart, /_speechFinalReceived/);
});
