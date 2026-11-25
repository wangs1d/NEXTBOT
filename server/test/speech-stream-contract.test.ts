import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 流式分层契约（2026-11-05 定稿 → 2026-11-25 车道架构修订）：
 *
 *   「流式」「文字块」「分泡」三件事分开，但共用同一条 WS 通道：
 *     模型 stream:true → delta 实时进分段器 → 语音数据帧逐句播报（流式保留）
 *     气泡车道（闲聊轮）：分段器切出的每个信息块 = 一个独立文字块
 *     （chat.assistant_chunk），块 id 由 BubbleTracker 统一分配；**流式块就是
 *     最终呈现**，done 只做对账定稿（bubbles 照实快照），绝不重建/替换/塌缩。
 *     单条车道（语音轮 / 任务面轮 / 整块交付场景）：不发文字块，文字由 done
 *     一次交付；语音数据帧两种车道照常流式。
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
const bubblePolicy = serverSrc("agent/bubble-policy.ts");
const bubbleTrackerSrc = serverSrc("agent/bubble-tracker.ts");
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

test("车道门在 T0：decideTextLane 定死车道，done 不再是第二个裁决者", () => {
  assert.match(bubblePolicy, /export function decideTextLane/, "车道裁决唯一出口");
  assert.match(bubblePolicy, /lane: TextLane/, "车道只有 bubbles | single 两种");
  assert.match(handler, /decideTextLane\(\{/, "车道必须在首个文字块外发前定死");
  // 旧 done 裁决退役：不存在整轮结束后的呈现权翻转（按代码形态匹配，不误伤注释）。
  assert.doesNotMatch(bubblePolicy, /export (async )?function (decidePresentation|splitReplyBubbles)/);
  assert.doesNotMatch(handler, /\bdecidePresentation\(|\bsplitReplyBubbles\(/, "done 阶段禁止重判呈现");
  assert.doesNotMatch(handler, /decideStreamPlan|decideFinalPlan/, "旧两阶段裁决必须删除");
  assert.doesNotMatch(handler, /renderedReply/, "旧 renderedReply 启发式必须删除");
  assert.doesNotMatch(handler, /shouldSplitBubbles|resolveBubbleCollapse/, "旧分泡判断必须删除");
  assert.doesNotMatch(handler, /enableBubbleMode|disableBubbleMode/, "旧流式开泡/关泡必须删除");
  // 车道只允许两处出现：初始声明 + 路由 .then 精化（首个主回复 delta 之前）。
  // 文字块出口（sendAssistantChunk）等任何流式路径不得改写车道。
  assert.match(handler, /let textStreamEnabled = textLane\.lane === "bubbles";/);
  const laneAssignments = handler.match(/textStreamEnabled =/g) ?? [];
  assert.equal(laneAssignments.length, 2, "车道只允许「初始声明 + 路由精化」两处赋值（T0 定死）");
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

test("撤回路径：stream_reset 后清账，done 回单条（不存在泡在 + 翻案并存）", () => {
  const resetFnIdx = handler.indexOf("const retractAndSuppressStream");
  assert.ok(resetFnIdx > 0, "撤回闸必须存在");
  const section = handler.slice(resetFnIdx, resetFnIdx + 1600);
  assert.match(section, /bubbleTracker\.reset\(\)/, "撤回后必须清空气泡账本");
  assert.match(section, /ChatStreamReset/, "撤回复用既有 stream_reset 事件");
});

test("文字块流式：chunk 携带块 id，done 用同源 bubbles 对账", () => {
  assert.match(
    handler,
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "气泡车道必须实时下发文字块（复用既有事件类型，不新开通道）",
  );
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
    /type:\s*ServerEventType\.ChatAssistantChunk/,
    "编辑重答不接流式块通道",
  );
});

test("工具回调不再开关气泡/拆分通道（车道在 T0 已定死）", () => {
  const startIdx = handler.indexOf("onExternalToolExecuteStart");
  assert.ok(startIdx > 0, "必须存在工具开始回调");
  const section = handler.slice(startIdx, startIdx + 3000);
  assert.doesNotMatch(section, /bubbleTracker\.freeze\(\)/, "禁止流式冻结气泡");
  assert.doesNotMatch(
    section,
    /SINGLE_BUBBLE_TOOL_DOMAINS|disableBubbleMode/,
    "工具域白名单/关泡逻辑必须删除（车道只在 T0 判一次）",
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
  assert.match(handler, /ChatAssistantChunk/, "文字块流式通道必须在");
});

test("正文重排信号由渲染层产出；气泡车道禁用形态接管", () => {
  const turn = serverSrc("render/turn.ts");
  const processor = serverSrc("services/tool-result-processor.ts");
  assert.match(turn, /bodyRewritten: mode === "full" && decision\.body\.form !== "plain"/);
  assert.match(
    processor,
    /opts\?\.textLane === "bubble" \? "cards-only" : "full"/,
    "气泡车道必须走 cards-only（形态接管 = done 翻案）",
  );
  assert.match(
    handler,
    /textLane: textStreamEnabled && !suppressStreamForCards \? "bubble" : "single"/,
    "主链路必须把车道传给渲染出口",
  );
});

test("兜底补漏剥离展示协议：气泡永不携带标记", () => {
  const guard = serverSrc("utils/stream-marker-guard.ts");
  assert.match(guard, /export function stripDisplayProtocol/, "补漏源必须过展示协议剥离");
  assert.match(handler, /stripDisplayProtocol\(/, "seal 补漏必须剥离卡片块/NEXT_UP/标记 token");
  assert.match(handler, /stripSentencesAlreadySaid\(/, "补漏按句去重，已流式内容不重发");
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
