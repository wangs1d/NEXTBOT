import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 流式分层契约（2026-11-05 定稿，2026-11-23 方案 C 修订）：
 *
 *   「流式」「文字块」「分泡」三件事分开，但共用同一条 WS 通道：
 *     模型 stream:true → delta 实时进分段器 → 语音数据帧逐句播报（流式保留）
 *     闲聊轮：分段器切出的每个信息块 = 一个独立文字块（chat.assistant_chunk），
 *     块 id 由 BubbleTracker 统一分配，与 done 的 bubbles 对账数组同源
 *     （assistant-$traceId-bN，按位置一一对应）——同 block 身份原地升级。
 *     语音轮 / 任务面轮：不发文字块，文字由 done 单条收口。
 *     流式后转渲染/塌缩：复用既有 chat.stream_reset + finalTextReplacesStream。
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

test("文字块流式（方案 C）：chunk 携带块 id，done 用同源 bubbles 对账", () => {
  // 2026-11-23 方案 C：闲聊轮实时外发文字块，块 id 与 done 的 bubbles
  // 按位置一一对应（同 base + 同序号），客户端原地 patch/追加。
  assert.match(
    handler,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "闲聊轮必须实时下发文字块（复用既有事件类型，不新开通道）",
  );
  assert.match(
    handler,
    /bubbleTracker\.appendStreamBlock\(/,
    "流式块 id 必须由 BubbleTracker 统一分配",
  );
  assert.match(handler, /messageId: blockId/, "chunk 的 messageId 必须是块 id");
  assert.match(
    handler,
    /bubbleTracker\.setFinalBubbles\(finalTexts\)/,
    "done 必须按同源 id 重排定稿（前 N 个 id 与流式块一致）",
  );
  assert.doesNotMatch(
    editRoute,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "编辑重答不接流式块通道",
  );
});

test("呈现裁决统一到整轮之后：工具回调不再开关气泡/拆分通道", () => {
  const startIdx = handler.indexOf("onExternalToolExecuteStart");
  assert.ok(startIdx > 0, "必须存在工具开始回调");
  const section = handler.slice(startIdx, startIdx + 3000);
  // 呈现裁决只在整轮之后判一次：流式阶段禁止任何「工具域开泡/关泡」旁路。
  assert.doesNotMatch(section, /bubbleTracker\.freeze\(\)/, "禁止流式冻结气泡");
  assert.doesNotMatch(
    section,
    /SINGLE_BUBBLE_TOOL_DOMAINS|disableBubbleMode/,
    "工具域白名单/关泡逻辑必须删除（呈现只在 done 判一次）",
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

test("final 语音帧恒在 done 之前，done 只做终态对账", () => {
  const finalIdx = handler.indexOf('sendSpeechFrame("", "stream", true, finalText)');
  const doneIdx = handler.indexOf("type: ServerEventType.ChatAssistantDone", finalIdx);
  assert.ok(finalIdx > 0, "必须存在语音收口帧");
  assert.ok(doneIdx > finalIdx, "收口帧必须先于 done 下发");
  // 文字由流式块实时落屏，done 只按同源 bubbles id 对账定稿。
  assert.match(handler, /ChatAssistantChunk/, "文字块流式通道必须在");
  assert.match(handler, /messageId: bubbleTracker\.outboundDoneMessageId/);
});

test("呈现裁决唯一出口：整轮结束后只判一次，旧双阶段判断已删净", () => {
  const bubblePolicy = serverSrc("agent/bubble-policy.ts");
  assert.match(bubblePolicy, /export function decidePresentation/);
  assert.match(handler, /decidePresentation\(\{/, "呈现裁决必须走统一出口");
  // 禁止再出现并行/两阶段判断：事故根因就是分泡与渲染各说各话。
  assert.doesNotMatch(handler, /decideStreamPlan|decideFinalPlan/, "旧两阶段裁决必须删除");
  assert.doesNotMatch(handler, /renderedReply/, "旧 renderedReply 启发式必须删除");
  assert.doesNotMatch(handler, /shouldSplitBubbles|resolveBubbleCollapse/, "旧分泡判断必须删除");
  // 流式后转渲染/塌缩轮复用既有 finalTextReplacesStream 通道（不是第二套管线）。
  assert.match(
    handler,
    /collapseStreamed \? \{ finalTextReplacesStream: true \}/,
    "仅流式后转单泡轮使用塌缩信号",
  );
  assert.doesNotMatch(handler, /enableBubbleMode|disableBubbleMode/, "旧流式开泡/关泡必须删除");
  assert.match(handler, /const bodyRewritten = doneSceneMeta\?\.bodyRewritten === true/);
});

test("正文重排信号由渲染层产出并透传到 done 信封", () => {
  const turn = serverSrc("render/turn.ts");
  const handlerSrc = handler;
  assert.match(turn, /bodyRewritten: mode === "full" && decision\.body\.form !== "plain"/);
  assert.match(handlerSrc, /const bodyRewritten = doneSceneMeta\?\.bodyRewritten === true/);
  assert.match(handlerSrc, /const presentationBlocks =/);
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
  // 2026-11-05 分层定稿：chat.assistant_speech 已从 main.dart 迁到纯语音总线
  // （PureVoiceModeController.onSpeechFrame），仍只消费、不写消息列表。
  assert.match(voiceDart, /void onSpeechFrame\(\{/, "语音帧由纯语音控制器消费");
  assert.match(voiceDart, /_speechBuffer \+= chunk;/, "增量帧只进语音缓冲");
  assert.doesNotMatch(
    voiceDart.slice(
      voiceDart.indexOf("void onSpeechFrame({"),
      voiceDart.indexOf("void _drainSpeechBuffer"),
    ),
    /_appendChunkToMessageList|appendChunk\(/,
    "语音帧不得落消息列表",
  );
  assert.match(voiceDart, /_sentenceBoundary/);
  assert.match(voiceDart, /_enqueueSpeak/);
  assert.match(voiceDart, /_speechFinalReceived/);
});
