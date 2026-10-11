/**
 * 线程内部帧契约（2026-10-08 根源修复）。
 *
 * 背景（真实事故）：手机端气泡里直接出现了
 *   [上一轮回复中断：最终回复未生成完整。…[不可信内容围栏 source=tool:weather.getLocal]…]
 * 这类文本。它们**不是给用户看的内容**，而是写进 LLM 线程的上下文帧：
 *   - [上一轮回复中断…] / [上一轮工具调用已完成但未生成可见回复]：thread 折叠占位（防串台）
 *   - [session-recap] / [unsummarized] / [关键钉]：滚动摘要区
 *   - [后台任务记录]：任务面回写
 *   - [不可信内容围栏 source=tool:x]：工具结果进消息流前的 prompt injection 围栏
 *   - [系统提示]：tool-loop 追加给模型的临时指令
 * 它们以 role:"assistant" 存在于线程里，模型下一轮容易把它们当成「自己上一轮说过的话」
 * 原样复读出来，顺着流式通道直穿到气泡——这就是泄漏的完整链路。
 *
 * 此前的问题：这些帧的文本特征散落在 3 处各写一份正则（tool-result-processor 的
 * system_frame 守卫、stream-chat-helpers 的控制标签净化、客户端 sanitizer），
 * 名单互不相同、且都不完整——新增一种帧就会漏一种（[不可信内容围栏] 就是这么漏的）。
 *
 * 本模块把「什么是内部帧」收敛成唯一权威定义，供四处共用：
 *   1. 出口咽喉 stream-chat-helpers（流式/整串净化，覆盖 WS/edit/task-plane/vision）
 *   2. ToolResultProcessor（finalText 收口守卫）
 *   3. chat-thread-store（占位帧生成时不再夹带别的帧原文）
 *   4. Flutter assistant_text_sanitizer.dart（客户端兜底，清单与本文件对齐）
 *
 * 设计取舍：
 *   - 宁可误删不可漏：这些标签在正常用户可见回复里几乎不出现（正常文案不会以
 *     「[上一轮回复中断」开头），误删代价远小于泄漏内部机制。
 *   - 词面防线，与 untrusted-content.ts 同哲学：挡不住模型「改写转述」（那是
 *     prompt 层的事），但能确定性挡住「逐字复读」这一占比最高的泄漏形态。
 */

/** 内部帧标签（方括号内首段的前缀文本）。新增系统帧必须登记到这里。 */
export const INTERNAL_FRAME_TAGS: ReadonlyArray<string> = [
  // thread 折叠占位（防串台）
  "上一轮回复中断",
  "上一轮工具调用已完成但未生成可见回复",
  // 滚动摘要区
  "session-recap",
  "unsummarized",
  "关键钉",
  // 任务面 / 工具结果围栏 / 临时系统指令
  "后台任务记录",
  "不可信内容围栏",
  "系统提示",
  // 主动行为与记忆注入
  "世界状态转移",
  "主动话术",
  "对话时间线",
  "节律提醒",
  "日志固化",
  "多模态消息",
  "已压缩·",
  "本轮用户明确要求不联网",
  // 内部控制信号（原 stream-chat-helpers 私有清单，统一收编）
  "话题切换",
  "话题已切换",
  // 上游 provider harness 的轨迹切分控制帧（2026-10-11 事故：整条回复都是它）
  "trajectory-slicing",
];

/**
 * 流式前缀探测用的「词干」：逐 chunk 到达时标签可能还没闭合（如 `[上一轮回复中`），
 * 必须按更短的词干判断是否继续缓冲，否则半截标签会先吐给用户。
 */
export const INTERNAL_FRAME_STEMS: ReadonlyArray<string> = [
  "上一轮回复",
  "上一轮工具",
  "session-recap",
  "unsummarized",
  "关键钉",
  "后台任务",
  "不可信内容",
  "系统提示",
  "世界状态",
  "主动话术",
  "对话时间线",
  "节律提醒",
  "日志固化",
  "多模态消息",
  "已压缩",
  "本轮用户明确要求",
  "话题切",
  "话题已切",
  "Topic",
  "STOP",
  // 上游 harness 轨迹切分帧（`[trajectory-slicing]`）
  "trajectory",
];

/**
 * XML 形态的上游 harness 注入提醒（2026-10-08 事故根源）。
 *
 * 真实事故：三连轮工具轮（天气/闹钟/天气）的模型原始输出开头出现
 *   <system-reminder>\nA reminder that the "session-recap" is the recap of
 *   earlier conversation. You MUST NOT respond to or reference the
 *   "session-recap" in your final response.\n起床闹钟已给你设好，明早 8 点…
 * 这是上游 provider harness（Claude-Code 式约定）在模型上下文里注入的
 * <system-reminder> 包裹（本工程从不产生该形态），模型把它当自己的输出
 * 原样复读。两种实测形态：
 *   1. 闭合：<system-reminder>…</system-reminder>\n\n正文
 *   2. 未闭合：<system-reminder>\n英文提醒行\n中文正文（XML 闭标签缺失）
 *   3. 纯泄漏：<system-reminder>\n英文提醒行（无任何正文）
 * 未闭合形态不能整块删到 EOF（会吞中文正文）——按「无 CJK 的行是英文提醒体」
 * 逐行吞，首个含 CJK 的行即正文起点。全英文的未闭合块（形态 3）吞到 EOF。
 */
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_REMINDER_OPEN_RE = /<system-reminder>/i;
/** CJK 表意文字（含扩展 A）——判定「英文提醒体」与「真实正文」的分界。 */
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 快速守卫：文本里是否疑似有 system-reminder（大小写不敏感）。 */
export const SYSTEM_REMINDER_ANY_RE = /<\s*\/?\s*system-reminder/i;

function stripOneUnclosedSystemReminder(text: string): string {
  const m = SYSTEM_REMINDER_OPEN_RE.exec(text);
  if (!m) return text;
  const start = m.index;
  const after = text.slice(start + m[0].length);
  const lines = after.split("\n");
  let consumed = 0;
  for (; consumed < lines.length; consumed++) {
    if (CJK_CHAR_RE.test(lines[consumed] ?? "")) break;
  }
  // 全部行都无 CJK → 整块（含 opener 到 EOF）是纯英文泄漏，全删。
  if (consumed >= lines.length) return text.slice(0, start);
  return text.slice(0, start) + lines.slice(consumed).join("\n");
}

/**
 * XML 形态的上游 harness **控制帧** `<system>…</system>`（2026-10-11 事故根源）。
 *
 * 真实事故：旅行规划轮的 assistant 正文**整条**只有 61 字，全部是它——
 *   <system>
 *   [trajectory-slicing]
 *   接下来的回复被分到两条轨迹，#1 紧接本段，#2 紧接 #1。
 * 这是上游 provider harness（agent 式调度器）塞进模型上下文的轨迹切分控制帧
 * （本工程从不产生该形态），模型把它当成「该输出的话」原样复读，顺着流式通道
 * 直穿气泡 → 用户看到「不相关的内容」，且本该有的行程叙述被整条挤掉。
 *
 * 与 `<system-reminder>` 的差别：本形态**不闭合**（实测无 `</system>`），且帧体
 * 的说明行带中文（「接下来的回复被分到两条轨迹…」），因此不能照搬「吞无 CJK 行」
 * 的策略（会把手写说明留下）。判据改为：**opener 后首个非空行是方括号控制标签**
 * （`[trajectory-slicing]` 这类纯拉丁标签，正常正文不会这样起头）→ 认定整个块
 * 都是 harness 帧体，吞到块尾（空行或 EOF）。
 */
const SYSTEM_FRAME_BLOCK_RE = /<system>[\s\S]*?<\/system>/gi;
const SYSTEM_FRAME_OPEN_RE = /<system>/i;
/** 快速守卫：文本里是否疑似有 `<system>` 控制帧（大小写/空白不敏感）。 */
export const SYSTEM_FRAME_ANY_RE = /<\s*system\s*>/i;
/** harness 控制标签行：`[trajectory-slicing]` / `[policy]` 这类纯拉丁方括号标签。 */
const HARNESS_TAG_LINE_RE = /^[ \t]*\[[A-Za-z][A-Za-z0-9._:\-/ ]*\][ \t]*$/;

function stripOneUnclosedSystemFrame(text: string): string {
  const m = SYSTEM_FRAME_OPEN_RE.exec(text);
  if (!m) return text;
  const start = m.index;
  const lines = text.slice(start + m[0].length).split("\n");
  let firstBody = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") {
      firstBody = i;
      break;
    }
  }
  if (firstBody >= 0 && HARNESS_TAG_LINE_RE.test(lines[firstBody] ?? "")) {
    // harness 帧体：吞到空行为止（无空行则吞到 EOF），块后若有正文原样保留
    let end = lines.length;
    for (let i = firstBody + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "") {
        end = i;
        break;
      }
    }
    return text.slice(0, start) + (end < lines.length ? lines.slice(end).join("\n") : "");
  }
  // 无控制标签行 → 保守：只吞 opener 之后的无 CJK 行（保留中文正文）
  let consumed = 0;
  for (; consumed < lines.length; consumed++) {
    if (CJK_CHAR_RE.test(lines[consumed] ?? "")) break;
  }
  if (consumed >= lines.length) return text.slice(0, start);
  return text.slice(0, start) + lines.slice(consumed).join("\n");
}

/**
 * 剥离 XML 形态的 `<system>` harness 控制帧。
 * 闭合块整块删；未闭合块按「控制标签行 → 吞到块尾」处理（见上）。
 * 另删孤立的 `<system>` / `</system>` 半截标签。
 */
export function stripSystemFrames(text: string): string {
  if (!text || !SYSTEM_FRAME_ANY_RE.test(text)) return text;
  let out = text.replace(SYSTEM_FRAME_BLOCK_RE, "");
  for (let i = 0; i < 8; i++) {
    const next = stripOneUnclosedSystemFrame(out);
    if (next === out) break;
    out = next;
  }
  out = out.replace(/<\/?system>/gi, "");
  // 接缝收敛：帧在开头时剥完会留下起首空行（气泡首行空白）。
  return out.replace(/^[ \t]*\n+/, "").replace(/\n{3,}/g, "\n\n");
}

/** 整条文本是否「只是一个/多个 `<system>` 控制帧」（剥完为空 → 不该下发气泡）。 */
export function isSystemFrameText(text: string): boolean {
  if (!text || !SYSTEM_FRAME_ANY_RE.test(text)) return false;
  return stripSystemFrames(text).trim() === "";
}

/**
 * 流式半截探测：缓冲内容是否为 `<system>` / `<system-reminder>` opener 的**真前缀**
 * （还没出现 `>`）。命中即应扣住待判。
 *
 * 为什么不能只靠 [systemReminderPartialTailLen] / [systemFramePartialTailLen]：
 * 那两个函数有「≥2 / ≥3 字符」的下限，首 chunk 常常只有 `<` 或 `<sy`——
 * 长度不足阈值时判不出来，净化器就直接切直通，整帧从此逐字穿到气泡
 * （2026-10-11 实测：`<system>` 帧逐字符/小块喂入 100% 泄漏）。
 */
export function isPartialSystemOpener(text: string): boolean {
  const t = text.replace(/^\s+/, "").toLowerCase();
  if (!t || t.includes(">")) return false;
  return "<system-reminder>".startsWith(t) || "<system>".startsWith(t);
}

/**
 * 流式状态判定：缓冲内容里 `<system>` 控制帧的进展。
 *   - `"none"`    ：没有控制帧（或帧已终结：见到 `</system>`、或帧体后出现空行分界，
 *                  或 opener 后首个非空行根本不是控制标签 → 是正文）
 *   - `"pending"` ：见到 opener，帧体还没能识别（还没换行 / 控制标签行只到一半）→ 继续扣住
 *   - `"body"`    ：确认是 harness 帧体（方括号控制标签行）且未终结 → 整段吞到帧体结束
 *
 * 关键：`"pending"` / `"body"` 两个状态都必须让调用方**保留缓冲**——一旦把已剥空的
 * 缓冲清掉，后续帧体碎片里没有 opener，净化器再也认不出来（实测泄漏路径）。
 */
export function systemFrameStreamState(text: string): "none" | "pending" | "body" {
  const m = SYSTEM_FRAME_OPEN_RE.exec(text);
  if (!m) return "none";
  if (/<\/system>/i.test(text)) return "none";
  const lines = text.slice(m.index + m[0].length).split("\n");
  let firstBody = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") {
      firstBody = i;
      break;
    }
  }
  if (firstBody < 0) return "pending"; // 帧体还没到
  const body = (lines[firstBody] ?? "").trim();
  if (!HARNESS_TAG_LINE_RE.test(body)) {
    // 控制标签可能还没收完（`[traj` / `[trajectory-slic`）→ 继续等
    if (body.startsWith("[") && body.length < 40 && !CJK_CHAR_RE.test(body)) return "pending";
    return "none";
  }
  for (let i = firstBody + 1; i < lines.length; i++) {
    // 末位空元素只是「流还在继续」（split 尾部残留），不是空行分界
    if ((lines[i] ?? "").trim() === "" && i !== lines.length - 1) return "none";
  }
  return "body";
}

/**
 * 剥离 XML 形态的 harness 注入块（`<system-reminder>` 与 `<system>` 两种），保留真实正文。
 * `<system>` 控制帧整块剥（含未闭合形态，见上）；`<system-reminder>` 闭合块整块删、
 * 未闭合块吞英文提醒行留 CJK 正文行。循环处理多个块。
 * 名称保留（两处历史调用点仍以它作为「线程内容净化」入口），实现已覆盖两种形态。
 */
export function stripSystemReminderBlocks(text: string): string {
  if (!text || (!SYSTEM_REMINDER_ANY_RE.test(text) && !SYSTEM_FRAME_ANY_RE.test(text))) {
    return text;
  }
  let out = stripSystemFrames(text).replace(SYSTEM_REMINDER_BLOCK_RE, "");
  for (let i = 0; i < 8; i++) {
    const next = stripOneUnclosedSystemReminder(out);
    if (next === out) break;
    out = next;
  }
  // 孤立的闭合标签行（模型只复读了一半时兜底）。
  return out.replace(/^[ \t]*<\/system-reminder>[ \t]*(?:\n|$)/gim, "").replace(/<\/?system-reminder>/gi, "");
}

/**
 * 流式半截探测：文本末尾是否为 "<system-reminder>" 的真前缀（≥2 字符）。
 * 命中说明标签可能尚未到达完整，调用方应扣住待判，防止半截标签先吐给用户。
 */
export function systemReminderPartialTailLen(text: string): number {
  if (!text) return 0;
  const target = "<system-reminder>";
  const max = Math.min(text.length, target.length - 1);
  for (let len = max; len >= 2; len--) {
    if (text.slice(-len).toLowerCase() === target.slice(0, len)) return len;
  }
  return 0;
}

/**
 * 流式半截探测：文本末尾是否为 `<system>` 控制帧 opener 的真前缀（≥3 字符）。
 * 与 [systemReminderPartialTailLen] 同理——半截 opener 先吐给用户就撤不回。
 * 只认 `<sy…` 起头（≥3 字符），避免把正文里的裸 `<` 误判成长缓冲。
 */
export function systemFramePartialTailLen(text: string): number {
  if (!text) return 0;
  const target = "<system>";
  const max = Math.min(text.length, target.length - 1);
  for (let len = max; len >= 3; len--) {
    if (text.slice(-len).toLowerCase() === target.slice(0, len)) return len;
  }
  return 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TAG_ALT = INTERNAL_FRAME_TAGS.map(escapeRegExp).join("|");
const STEM_ALT = INTERNAL_FRAME_STEMS.map(escapeRegExp).join("|");

/** 完整闭口标签：`[tag...]`。 */
const FRAME_TAG_RE = new RegExp(`\\[(?:${TAG_ALT})[^\\]]*\\]`, "i");

/** 整行就是一个内部帧（帧后即使跟同行内容也整行删）：多行删除。 */
const FRAME_LINE_RE = new RegExp(
  `^[ \\t]*\\[(?:${TAG_ALT})[^\\]]*\\][^\\n]*(?:\\n|$)`,
  "gim",
);

/** 文本开头的连续内部帧（可能连着多个），剥帧留正文。 */
const FRAME_LEADING_RE = new RegExp(
  `^[ \\t]*(?:\\[(?:${TAG_ALT})[^\\]]*\\][ \\t:：—–-]*)+`,
  "i",
);

/** 闭口的不可信内容围栏整块（多行）——块内是工具原始数据，一并删。 */
const FENCE_BLOCK_RE = /\[不可信内容围栏[^\]]*\][\s\S]*?\[\/不可信内容围栏\]/g;
/** 孤立的围栏开/闭标签行（模型只复读了一半时兜底）。 */
const FENCE_TAG_LINE_RE = /^[ \t]*\[\/?不可信内容围栏[^\]]*\][ \t]*(?:\n|$)/gm;

/** 流式前缀探测：当前文本是否「可能是某个内部帧的开头」。 */
export const INTERNAL_FRAME_PREFIX_RE = new RegExp(
  `^[ \\t]*\\[(?:${STEM_ALT})`,
  "i",
);

/**
 * 只剥「内部帧的标签外壳」，保留正文（与 stripInternalFrames 的区别）。
 *
 * 用途：thread 占位帧要摘录工具结果首行作为事实证据——此时围栏头/尾标签要删，
 * 但块内的真实数据（天气/搜索结果）必须留下，否则占位帧丢掉「已办了什么」的
 * 事实，模型会反复重做（实测：两条提醒已创建成功，agent 却反复追问）。
 */
export function stripInternalFrameMarkup(text: string): string {
  if (!text) return text;
  return text
    .replace(FENCE_TAG_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 文本（去空白后）是否以内部帧标签开头——即整条就是内部帧。 */
export function isInternalFrameText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return false;
  return FRAME_TAG_RE.test(trimmed);
}

/** 文本里是否含有任意内部帧标签。 */
export function hasInternalFrameTag(text: string): boolean {
  if (!text) return false;
  return FRAME_TAG_RE.test(text);
}

/**
 * 剥离文本中的内部帧，返回**可以给用户看**的文本。
 *
 * 四层，顺序不能换：
 *   0. XML 形态的 harness 注入块——`<system-reminder>`（2026-10-08 事故根源，
 *      闭合整块删 / 未闭合吞英文提醒行留 CJK 正文）与 `<system>` 控制帧
 *      （2026-10-11 事故根源，含未闭合形态，整块删）
 *   1. 闭口的 `[不可信内容围栏]…[/不可信内容围栏]` 整块删（块内是工具原始数据）
 *   2. 孤立围栏标签行删（防半截复读）
 *   3. 以内部帧标签开头的整行删（多行；覆盖 [后台任务记录] 目标：… 这类单行帧）
 *   4. 文本开头连续的内部帧标签剥掉，保留其后的正文
 *
 * 剥完为空则返回空串——调用方据此判断「本条不该下发气泡」。
 */
export function stripInternalFrames(text: string): string {
  if (!text) return text;
  let out = stripSystemReminderBlocks(text)
    .replace(FENCE_BLOCK_RE, "")
    .replace(FENCE_TAG_LINE_RE, "")
    .replace(FRAME_LINE_RE, "");

  // 开头连续帧：循环剥（可能连着多个），只动开头，不碰正文
  for (let i = 0; i < 8; i++) {
    const next = out.replace(FRAME_LEADING_RE, "");
    if (next === out) break;
    out = next;
  }

  out = out.replace(/\n{3,}/g, "\n\n");
  if (out.trim() === "") return "";
  return out;
}
