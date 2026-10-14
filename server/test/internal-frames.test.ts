/**
 * 线程内部帧契约回归（2026-10-08 手机端事故气泡）。
 *
 * 锁定契约：
 *   1. 内部帧整条 → 剥离后为空（调用方据此不下发气泡）
 *   2. 围栏整块 / 围栏半截标签 → 删净，不留 source=tool:x 字样
 *   3. 内部帧 + 正常正文混排 → 只剥帧，正文一字不动
 *   4. 正常正文（含方括号文案）不受影响
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasInternalFrameTag,
  isInternalFrameText,
  isSystemFrameText,
  stripInternalFrames,
  stripSystemFrames,
} from "../src/external-model/internal-frames.js";
import { createStreamControlTagSanitizer } from "../src/external-model/stream-chat-helpers.js";

test("逐字复读的中断占位帧（含围栏原文）整条判为内部帧并剥净", () => {
  const leaked =
    "[上一轮回复中断：最终回复未生成完整。期间已调用工具 weather.getLocal（共 1 次），" +
    "收到结果：[不可信内容围栏 source=tool:weather.getLocal]\n兴义 26℃\n[/不可信内容围栏]。" +
    "这些动作可能已实际生效——引用本事项前先查证实际状态，" +
    "不要把它当作用户重复请求或未处理的悬空事项重新提起。]";
  assert.equal(isInternalFrameText(leaked), true);
  assert.equal(stripInternalFrames(leaked), "");
});

test("围栏整块与其半截标签都被删净", () => {
  const block =
    "我查了一下：\n[不可信内容围栏 source=tool:weather.getLocal]\n今天晴 26℃\n[/不可信内容围栏]\n要带伞吗？";
  const out = stripInternalFrames(block);
  assert.equal(out.includes("不可信内容围栏"), false);
  assert.equal(out.includes("source=tool:"), false);
  assert.ok(out.includes("我查了一下"));
  assert.ok(out.includes("要带伞吗"));

  const dangling = "[不可信内容围栏 source=tool:search_web]\n好嘞";
  const out2 = stripInternalFrames(dangling);
  assert.equal(out2.includes("不可信内容围栏"), false);
  assert.ok(out2.includes("好嘞"));
});

test("单行内部帧整行删除，正文保留", () => {
  const mixed =
    "[后台任务记录] 目标：查天气\n结果：26℃\n\n好的，我帮你看了下天气。";
  const out = stripInternalFrames(mixed);
  assert.equal(out.includes("后台任务记录"), false);
  assert.ok(out.includes("好的，我帮你看了下天气"));
});

test("开头连续帧剥离后保留其后正文", () => {
  const out = stripInternalFrames("[session-recap] Earlier conversation recap:\n正常回复在这");
  assert.ok(!out.includes("session-recap"));
  assert.ok(out.includes("正常回复在这"));
});

test("正常正文（含方括号表达）不受影响", () => {
  const normal = "已查到 3 家火锅店：[评分 4.8] 黔味老灶、[人均 ¥78] 巷子口。";
  assert.equal(stripInternalFrames(normal).trim(), normal);
  assert.equal(isInternalFrameText(normal), false);
  assert.equal(hasInternalFrameTag(normal), false);
});

test("空串与纯空白安全", () => {
  assert.equal(stripInternalFrames(""), "");
  assert.equal(stripInternalFrames("   \n\n "), "");
  assert.equal(isInternalFrameText(""), false);
});

/* ------------------------------------------------------------------ *
 * XML 形态 <system-reminder>（2026-10-08 上游 harness 注入复读事故）  *
 * 三种实测形态都取自 chat-threads.json 的真实落盘原文                  *
 * ------------------------------------------------------------------ */

const REMINDER_EN =
  'A reminder that the "session-recap" is the recap of earlier conversation. ' +
  'You MUST NOT respond to or reference the "session-recap" in your final response.';

test("闭合块整体删除，正文保留（天气轮真实形态）", () => {
  const leaked =
    `<system-reminder>\n${REMINDER_EN}\n</system-reminder>\n\n` +
    "好的，我立刻查兴义明天的天气。明天兴义是大晴天。";
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.equal(out.includes("session-recap"), false);
  assert.ok(out.includes("好的，我立刻查兴义明天的天气"));
});

test("未闭合块吞英文提醒行、保留中文正文（闹钟轮真实形态）", () => {
  const leaked =
    `<system-reminder>\n${REMINDER_EN}\n起床闹钟已给你设好，明早 8 点准时叫你，睡个好觉。`;
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.equal(out.includes("MUST NOT"), false);
  assert.ok(out.includes("起床闹钟已给你设好，明早 8 点准时叫你，睡个好觉。"));
});

test("纯英文未闭合块（无正文）剥完为空（泄漏轮真实形态）", () => {
  const leaked = `<system-reminder>\n${REMINDER_EN}`;
  assert.equal(stripInternalFrames(leaked), "");
});

test("中间出现的 XML 块也剥，前后正文都保留", () => {
  const leaked =
    `开头\n<system-reminder>\n${REMINDER_EN}\n</system-reminder>\n结尾`;
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.ok(out.includes("开头"));
  assert.ok(out.includes("结尾"));
});

test("正常正文含尖括号/英文不受影响", () => {
  const normal = "用 <b> 加粗，或者 <br> 换行都行，注意看温度 >25℃ 的日子。";
  assert.equal(stripInternalFrames(normal).trim(), normal);
});

test("流式半截探测：识别 <system-reminder> 的真前缀，放过普通文本", async () => {
  const { systemReminderPartialTailLen } = await import(
    "../src/external-model/internal-frames.js"
  );
  assert.ok(systemReminderPartialTailLen("<system-") > 0);
  assert.ok(systemReminderPartialTailLen("正文<sys") > 0);
  assert.ok(systemReminderPartialTailLen("<system-reminder>") === 0); // 完整标签已到，交给整串剥
  assert.ok(systemReminderPartialTailLen("<") === 0); // 单字符不扣，防误吞正文
  assert.ok(systemReminderPartialTailLen("今天天气不错") === 0);
});

test("端到端：thread 折叠出的中断链不再夹带围栏原文（system 动作台账，assistant 通道清零）", async () => {
  const { foldCompletedToolChains } = await import(
    "../src/external-model/chat-thread-store.js"
  );
  const msgs = [
    { role: "system", content: "sys" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "weather.getLocal", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "c1",
      content:
        "[不可信内容围栏 source=tool:weather.getLocal]\n兴义 26℃ 晴\n[/不可信内容围栏]",
    },
  ] as never[];
  const changed = foldCompletedToolChains(msgs);
  assert.equal(changed, true);
  // 2026-10-13 根修：折叠后 assistant 通道清零，事实记录以 system 动作台账承载
  const assistants = (msgs as Array<{ role: string; content?: unknown }>).filter(
    (m) => m.role === "assistant",
  );
  assert.equal(assistants.length, 0, "assistant 通道不得再出现占位帧");
  const ledger = (msgs as Array<{ role: string; content?: unknown }>).find(
    (m) => m.role === "system" && String(m.content ?? "").startsWith("[动作台账"),
  );
  assert.ok(ledger, "中断链必须折叠出 system 动作台账");
  const text = String(ledger?.content ?? "");
  // 契约核心：围栏原文（含 source=tool:）不得进入台账
  assert.equal(text.includes("不可信内容围栏"), false);
  assert.equal(text.includes("source=tool:"), false);
  // 工具事实仍在（天气数据本身，不是围栏头）
  assert.ok(text.includes("兴义 26℃ 晴"));
  // 单行契约：整行可被出口剥离器拦
  assert.equal(text.includes("\n"), false);
});


// ═══════════════════════════════════════════════════════════════════
// XML 形态 <system> harness 控制帧（2026-10-11 旅行规划轮事故）
//
// 事故原文（chat-threads.json 落库，finalTextChars=61 全是它）：
//   <system>\n[trajectory-slicing]\n接下来的回复被分到两条轨迹，#1 紧接本段，#2 紧接 #1。
// ═══════════════════════════════════════════════════════════════════

const LEAKED_SYSTEM_FRAME =
  "<system>\n[trajectory-slicing]\n接下来的回复被分到两条轨迹，#1 紧接本段，#2 紧接 #1。";

test("整条就是 <system> 控制帧 → 剥净且判为内部帧", () => {
  assert.equal(isSystemFrameText(LEAKED_SYSTEM_FRAME), true);
  assert.equal(stripInternalFrames(LEAKED_SYSTEM_FRAME), "");
  assert.equal(stripSystemFrames(LEAKED_SYSTEM_FRAME), "");
});

test("<system> 闭合帧剥掉后保留正文", () => {
  const closed =
    "<system>\n[trajectory-slicing]\n回执说明\n</system>\n王哥，马尔代夫七天我给你排好了。";
  assert.equal(stripInternalFrames(closed), "王哥，马尔代夫七天我给你排好了。");
});

test("<system> 未闭合帧按空行分界，块后正文保留", () => {
  const unclosed =
    "<system>\n[trajectory-slicing]\n接下来的回复被分到两条轨迹。\n\n王哥，马尔代夫七天我给你排好了。";
  assert.equal(stripInternalFrames(unclosed), "王哥，马尔代夫七天我给你排好了。");
  // 无空行分界 → 整块吞到 EOF
  assert.equal(stripInternalFrames(`${LEAKED_SYSTEM_FRAME}\n还有半句话`), "");
});

test("<system> 无控制标签行时保守：只吞 opener 与无 CJK 行", () => {
  const plain = "<system>\nsome english line\n真正的正文在这里。";
  assert.equal(stripInternalFrames(plain), "真正的正文在这里。");
});

test("<system> 帧体里的控制标签行也算内部帧标签", () => {
  assert.equal(hasInternalFrameTag("[trajectory-slicing]"), true);
  assert.equal(stripInternalFrames("正文在这\n[trajectory-slicing]\n尾部"), "正文在这\n尾部");
});

test("正常正文不受 <system> 规则影响", () => {
  const normal = "王哥，马尔代夫七天我给你排好了，先看卡片。";
  assert.equal(stripInternalFrames(normal), normal);
  assert.equal(isSystemFrameText(normal), false);
});

// ═══════════════════════════════════════════════════════════════════
// 流式净化：<system> 控制帧必须逐 chunk 也不吐（2026-10-11 泄漏真凶）
//
// 实测背景：帧体是多行文本，前半段（opener + 控制标签行）可识别，后半段说明行
// **没有 opener**——净化器一旦放通一次，整帧就逐字穿到气泡。修复前逐字符 / 3 字 /
// 10 字喂入 100% 泄漏（首 chunk 只有 `<`，长度不足旧的半截阈值）。
// ═══════════════════════════════════════════════════════════════════

function feedChunks(chunks: string[]): string {
  const feed = createStreamControlTagSanitizer();
  let out = "";
  for (const c of chunks) out += feed(c);
  return out;
}

test("流式：<system> 控制帧逐字符喂入也不吐（首 chunk = `<`）", () => {
  assert.equal(feedChunks([...LEAKED_SYSTEM_FRAME]), "");
});

test("流式：<system> 控制帧按 3 字 / 10 字切片喂入也不吐", () => {
  assert.equal(feedChunks(LEAKED_SYSTEM_FRAME.match(/.{1,3}/gs) ?? []), "");
  assert.equal(feedChunks(LEAKED_SYSTEM_FRAME.match(/.{1,10}/gs) ?? []), "");
});

test("流式：opener 被切断（`<sys` | `tem>` …）也不吐", () => {
  assert.equal(
    feedChunks(["<sys", "tem>\n[traj", "ectory-slicing]\n接下来的回复被分到", "两条轨迹。"]),
    "",
  );
});

test("流式：帧体后有正文（空行分界）只吐正文", () => {
  assert.equal(
    feedChunks(["<system>\n[trajectory-slicing]\n说明行\n\n王哥，马尔代夫七天我给你排好了。"]),
    "王哥，马尔代夫七天我给你排好了。",
  );
});

test("流式：正常回复逐段喂入原样吐出", () => {
  assert.equal(
    feedChunks(["王哥，", "马尔代夫七天", "我给你排好了，先看卡片。"]),
    "王哥，马尔代夫七天我给你排好了，先看卡片。",
  );
});

test("流式：正文里出现裸 <system> 前缀（不是帧）时不误吞", () => {
  // 首个非空行不是方括号控制标签 → 判为正文，剥掉孤标签后照常下发
  const out = feedChunks(["<system>", "\n王哥，这趟行程我按你的节奏排好了。"]);
  assert.ok(out.includes("王哥"));
});
