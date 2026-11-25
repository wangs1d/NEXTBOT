import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 统一管道契约（2026-11-25 定稿，替代车道架构）：
 *
 * 两不变量：
 *   I1 正文 = 流式泡（恒流式）：只要有文字 delta 就经分段器实时落屏成独立
 *      气泡块（chat.assistant_chunk），闲聊与结构化内容并存于同一轮、互不吞；
 *      唯一例外是 debug 开关 AGENT_REALTIME_STREAM=0。
 *   I2 结构化产物 = done 封口附件：卡片/媒体/renderBlocks/followups 在 done
 *      阶段附加到最后一个气泡上，绝不改写/撤回已落屏正文。
 *
 * done = seal：只做残差回填（已说过的不重发）+ 对账快照下发。
 * 撤回 = 垃圾回收：只针对 recap echo（历史结论被复述回来）。
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
const agentCore = serverSrc("services/agent-core.ts");
const provider = serverSrc("external-model/abstract-chat-provider.ts");
const streamTypes = serverSrc("external-model/types.ts");
const replyTypes = serverSrc("agent/types.ts");
const protocol = repoFile("packages/agent-protocol/src/events.ts");
const bubbleTrackerSrc = serverSrc("agent/bubble-tracker.ts");
// chunk/done 帧构造抽到 assistant-turn-publisher（并行工作流 2026-11-25）：事件
// 类型字面量住在这里，handler 只经 buildChunkFrame/buildDoneFrame 外发。
const publisher = serverSrc("agent/assistant-turn-publisher.ts");
const voiceDart = repoFile("client/flutter_app/lib/core/services/pure_voice_mode.dart");

// ── I1 正文 = 流式泡（恒流式） ──────────────────────────────────────────────

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

test("文字出口恒开：不存在按轮次关闸的车道判定", () => {
  assert.doesNotMatch(handler, /decideTextLane|TextLanePlan/, "车道裁决已整体退役");
  assert.doesNotMatch(handler, /textStreamEnabled/, "文字出口闸已退役：chunk 恒外发");
  assert.doesNotMatch(
    handler,
    /if \(!textStreamEnabled\) return;/,
    "sendAssistantChunk 不得在语音帧之后对文字块关闸",
  );
  assert.doesNotMatch(
    toolLoop,
    /answerHeld|holdSummary/,
    "答案留存闸（holdAnswer）已退役：所有波次恒直推",
  );
  assert.doesNotMatch(toolLoop, /holdAnswer\?/, "AgentStreamOptions 上的 holdAnswer 选项已删除");
  assert.doesNotMatch(agentCore, /holdAnswer|answerStreamHeld/, "agent-core 留存记账已删除");
  assert.doesNotMatch(streamTypes, /holdAnswer/, "协议类型的 holdAnswer 字段已删除");
  assert.doesNotMatch(replyTypes, /answerStreamHeld/, "reply 类型的 answerStreamHeld 字段已删除");
  assert.doesNotMatch(provider, /holdAnswer/, "provider 白名单透传的 holdAnswer 已删除");
  assert.equal(
    existsSync(join(here, "../src/agent/bubble-policy.ts")),
    false,
    "bubble-policy（车道裁决模块）已删除",
  );
  assert.equal(
    existsSync(join(here, "../src/services/receipt-card-projection.ts")),
    false,
    "receiptProducesCard（出卡扣流判据）随留存闸一并退役",
  );
});

test("分段器恒气泡分段：块边界即气泡边界，不按轮次切换", () => {
  assert.match(
    handler,
    /bubbleMode: true,/,
    "统一管道下所有轮次走气泡分段（含语音轮：句子级分块对 TTS 更友好）",
  );
  assert.match(
    handler,
    /bubbleGapMinMs: voiceModeRound \? 0 : 400/,
    "语音轮保持零人工停顿档（2026-09-28 定稿：TTS 不吃 sleep）",
  );
});

test("结构化标记不再触发撤回：模型自产标记只在出口剥除", () => {
  assert.doesNotMatch(
    handler,
    /streamMarkerGuard\.sawStructuredBlock\)\s*\{\s*retractAndSuppressStream/,
    "sawStructuredBlock 撤回闸已退役：标记轮正文照常流式，done 附加卡片",
  );
});

// ── I2 结构化产物 = done 封口附件 ───────────────────────────────────────────

test("结构化恒附加：WS 主链路恒 cards-only 渲染（正文形态不被接管）", () => {
  const turn = serverSrc("render/turn.ts");
  const processor = serverSrc("services/tool-result-processor.ts");
  assert.match(
    handler,
    /textLane: "bubble",/,
    "主链路无条件传 bubble → cards-only：done 只附加，不重排已流式正文",
  );
  assert.match(
    processor,
    /opts\?\.textLane === "bubble" \? "cards-only" : "full"/,
    "cards-only 与 full 的分派映射保留（full 供非流式调用方）",
  );
  assert.match(turn, /bodyRewritten: mode === "full" && decision\.body\.form !== "plain"/);
});

test("done = 定稿（seal）：无塌缩通道、无整段替换信号", () => {
  assert.doesNotMatch(
    handler,
    /finalTextReplacesStream:\s*true/,
    "流式块即最终呈现，整段替换信号必须退役",
  );
  assert.doesNotMatch(handler, /let collapseStreamed|collapseStreamed =/, "塌缩判定必须删除");
  assert.doesNotMatch(handler, /streamSegmenter\.feed\(finalFeed\)/, "收尾不得把定稿整段喂回分段器");
  assert.match(handler, /await streamSegmenter\.flushFinal\(\)/);
  // 对账数组照实快照：done 的 bubbles 来自账本，不再有 done 重建入口。
  assert.doesNotMatch(bubbleTrackerSrc, /setFinalBubbles/, "气泡账本唯一写入路径是流式");
  assert.match(handler, /bubbleTracker\.hasBubbles \? \{ bubbles: bubbleTracker\.snapshot \}/);
});

test("正文单一出口：定稿 = 已放出，收尾 flush 流式净化器，done 不比对补推", () => {
  const guard = serverSrc("utils/stream-marker-guard.ts");
  assert.match(guard, /export function stripDisplayProtocol/);
  assert.match(handler, /streamMarkerGuard\.feed\(/, "出口必须剥离卡片块/NEXT_UP/标记 token");
  assert.match(handler, /streamMarkerGuard\.flush\(\)/, "出口净化器缓冲流末必须放出");
  // done 不再拿「已流文本 vs finalText」互相比对去补差——那会把已上屏内容再追加一遍。
  assert.doesNotMatch(handler, /unstreamedSuffix|stripSentencesAlreadySaid|seal backfill/, "done 收口不得比对补推");
  // provider 侧：流式净化器带缓冲，流结束必须 flush，缓冲经同一出口放出。
  assert.match(toolLoop, /waveMetaFilter\(waveTagSanitizer\.flush\(\)\)/, "tool-loop 收尾必须冲刷净化器缓冲");
  assert.match(toolLoop, /waveMetaFilter\.flush\(\)/);
  assert.match(provider, /metaFilter\(sanitizer\.flush\(\)\)/, "纯文本分支收尾必须冲刷净化器缓冲");
  assert.match(provider, /metaFilter\.flush\(\)/);
  // 定稿文本取已放出文本（waveStreamedText / streamedVisible），整串净化链只在
  // 没有任何流式产出时使用。
  assert.match(toolLoop, /sanitizedFinalText = stripRequestCardTags\(\s*stripAllTimestampFrameLines\(waveStreamedText\)\.trim\(\)/);
  assert.match(provider, /visible = streamedVisible\.trim\(\)\s*\?\s*streamedVisible\.trim\(\)/);
});

// ── 撤回 = 垃圾回收（recap echo 专用） ─────────────────────────────────────

test("撤回路径：recap echo 触发 stream_reset 并清账，done 回单条", () => {
  const resetFnIdx = handler.indexOf("const retractAndSuppressStream");
  assert.ok(resetFnIdx > 0, "撤回闸必须存在");
  const section = handler.slice(resetFnIdx, resetFnIdx + 1600);
  assert.match(section, /bubbleTracker\.reset\(\)/, "撤回后必须清空气泡账本");
  assert.match(section, /ChatStreamReset/, "撤回复用既有 stream_reset 事件");
  // 唯一触发点：recap echo。整份 handler 里 retractAndSuppressStream 的调用处
  // 只允许 isRecapEchoText 分支一处。
  const callSites = handler.match(/retractAndSuppressStream\(\);/g) ?? [];
  assert.equal(callSites.length, 1, "撤回只服务垃圾回收语义，不得再挂其他触发条件");
  const echoIdx = handler.indexOf("isRecapEchoText(cleanedChunk)");
  assert.ok(
    echoIdx > 0 && echoIdx > resetFnIdx,
    "recap echo 判定在撤回函数定义之后的主链路里触发撤回",
  );
});

// ── 通道与语音契约（不变量保持） ───────────────────────────────────────────

test("文字块流式：chunk 携带块 id，done 用同源 bubbles 对账", () => {
  assert.match(
    publisher,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "正文必须实时下发文字块（复用既有事件类型，不新开通道）",
  );
  assert.match(handler, /buildChunkFrame\(\s*\{/, "handler 的文字块必须经统一帧构造外发");
  assert.match(
    handler,
    /bubbleTracker\.appendStreamBlock\(/,
    "流式块 id 必须由 BubbleTracker 统一分配",
  );
  assert.match(handler, /messageId: blockId/, "chunk 的 messageId 必须是块 id");
  assert.match(
    handler,
    /messageId: bubbleTracker\.outboundDoneMessageId/,
    "done 的 messageId 指向末泡（按泡对账）",
  );
  assert.doesNotMatch(
    editRoute,
    /ChatAssistantChunk|buildChunkFrame\(/,
    "编辑重答不接流式块通道",
  );
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
  const doneIdx = handler.indexOf("buildDoneFrame({", finalIdx);
  assert.ok(finalIdx > 0, "必须存在语音收口帧");
  assert.ok(doneIdx > finalIdx, "收口帧必须先于 done 下发");
  assert.match(publisher, /type:\s*ServerEventType\.ChatAssistantDone/, "文字块流式通道必须在");
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
