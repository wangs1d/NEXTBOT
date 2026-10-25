/**
 * 流式输出标记防泄漏 guard（渲染管线 L2 的配套件）。
 *
 * 背景：L2 激活后，LLM 会在回复正文里输出展示形式标记
 * （[RENDER_HINT:xxx] / [AGENT_RESULT_CARD_START]{...}[END] / [RENDER_AS:xxx] /
 *  [DATA_BRIEF_START] / [VIDEO_MEDIA_START] / [CONTENT_SUMMARY_V2_START] 等）。
 * 这些标记在 assistant_done 的 finalText 里由前端确定性解析渲染，但流式阶段
 * delta 是原样推给用户打字机气泡的——标记/卡片 JSON 会以脏文本闪现在屏幕上。
 *
 * 本 guard 挂在 chunk 出口（sendAssistantChunk）：
 *   - 独占一行的标记：扣下不发（finalText 里权威存在，done 时统一渲染）；
 *   - 卡片 JSON 块：从 CARD_START 行进入丢弃态，直到 CARD_END 行，整块丢弃；
 *   - 行内嵌的完整标记 token：就地剥离，剩余文本照发；
 *   - 误伤保护：疑似半截标记的残段只扣留到断行/流结束，普通文本原样放行。
 *
 * 用法：
 *   const guard = createStreamMarkerGuard();
 *   chunk 出口：safe = guard.feed(chunk)   // 可能为空串
 *   流结束前：  rest = guard.flush()       // 放行误扣残段；标记一律丢弃
 */

/** 完整标记 token（无论是否独占一行）。注意：仅用于 replace，勿用于 test（/g 状态）。 */
const MARKER_TOKEN_RE =
  /\[(?:RENDER_HINT:[A-Za-z_]+|RENDER_AS:[A-Za-z_]+|AGENT_RESULT_CARD_START|AGENT_RESULT_CARD_END|DATA_BRIEF_START|DATA_BRIEF_END|VIDEO_MEDIA_START|VIDEO_MEDIA_END|CONTENT_SUMMARY_V2_START|CONTENT_SUMMARY_V2_END|CHAT_MEDIA_START|CHAT_MEDIA_END|IMAGE_RESULT_START|IMAGE_RESULT_END|NEXT_UP_START|NEXT_UP_END)\]/g;

/** 模型写歪的声明变体：`[RENDER_HINT]:brief` / `[RENDER_AS]: brief`（括号在冒号前
 *  闭合，2026-10-11 实机探针实证透进气泡）。规范形由 MARKER_TOKEN_RE 覆盖。 */
const RENDER_DECL_VARIANT_RE = /\[RENDER_(?:HINT|AS)\]\s*[:：]\s*[A-Za-z_]+\]?/g;

/** 独占一行的全大写方括号标记（防御未来新增的服务端标记类型） */
const MARKER_LINE_RE = /^[ \t]*\[[A-Z_]+(?::[A-Za-z_]+)?\][ \t]*$/;

/** 结构化产出标记 token：命中即意味着本轮 done 会携带卡片/媒体/渲染块。
 *  注意不含 NEXT_UP（只产 followups 字段，不改变正文渲染形态）与
 *  RENDER_HINT/RENDER_AS（文本形态声明，done 渲染与流式正文近似）。 */
const STRUCTURAL_MARKER_TOKEN_RE =
  /\[(?:AGENT_RESULT_CARD_(?:START|END)|DATA_BRIEF_(?:START|END)|VIDEO_MEDIA_(?:START|END)|CONTENT_SUMMARY_V2_(?:START|END)|CHAT_MEDIA_(?:START|END)|IMAGE_RESULT_(?:START|END))\]/;

const CARD_START_LINE = "[AGENT_RESULT_CARD_START]";
const CARD_END_LINE = "[AGENT_RESULT_CARD_END]";
/** NEXT_UP 标记容错：模型实测会漏写下划线（[NEXT_UPSTART]，2026-10-24 真机）。 */
const NEXT_UP_START_RE = /\[NEXT[ _]?UP[ _]?START\]/i;
const NEXT_UP_END_RE = /\[NEXT[ _]?UP[ _]?END\]/i;
const NEXT_UP_MARKER_TOKEN_RE = /\[NEXT[ _]?UP[ _]?(?:START|END)\]/gi;

/** 已知标记起始段：残段命中其前缀才继续扣留（普通方括号文本不受影响） */
const MARKER_HEADS = [
  "[RENDER_HINT:",
  "[RENDER_AS:",
  "[AGENT_RESULT_CARD_",
  "[DATA_BRIEF_",
  "[VIDEO_MEDIA_",
  "[CONTENT_SUMMARY_V2_",
  "[CHAT_MEDIA_",
  "[IMAGE_RESULT_",
  "[NEXT_UP_",
  "[NEXTUP", "[NEXT ",
  "[RENDER_", "[AGENT_", "[DATA_", "[VIDEO_", "[CONTENT_", "[CHAT_", "[IMAGE_", "[NEXT_",
];

/** 尾部残段是否"可能正在变成标记"：只有最后一个 [ 尚未闭合、且前缀命中已知标记时才扣留。
 *  已闭合的完整标记 token（如 "[RENDER_HINT:brief] 后接正文"）交给 judgeLine 就地剥离，不扣留。 */
function tailCouldBecomeMarker(text: string): boolean {
  const idx = text.lastIndexOf("[");
  if (idx === -1) return false;
  const tail = text.slice(idx);
  if (tail.includes("]")) return false;
  return MARKER_HEADS.some((h) => h.startsWith(tail) || tail.startsWith(h));
}

export interface StreamMarkerGuard {
  /** 喂入一段 delta，返回当前可以安全推给用户的部分（可能为空串） */
  feed(chunk: string): string;
  /** 流结束：放行被误扣的普通残段；标记/卡片块内容一律丢弃 */
  flush(): string;
  /** 流式期间是否见过结构化产出标记（卡片/媒体/数据简报等）。
   *  命中即意味着本轮 done 会携带结构化渲染——「会出卡片的轮次不流式」
   *  用此信号在 chunk 出口撤回已流正文并转静默。 */
  readonly sawStructuredBlock: boolean;
}

export function createStreamMarkerGuard(): StreamMarkerGuard {
  let pending = ""; // 尚未裁决的尾部残段（未断行，或疑似半截标记）
  let inCardBlock = false; // 已见 CARD_START，丢弃直到 CARD_END
  let inNextUpBlock = false; // 已见 NEXT_UP_START，丢弃直到 NEXT_UP_END（接续建议由 done 载荷承载）
  let sawStructured = false; // 流式期间见过结构化产出标记（done 将携带卡片/渲染块）

  /** 裁决一行完整文本；返回 null 表示整行丢弃，否则返回可发文本（无换行符） */
  const judgeLine = (line: string): string | null => {
    if (inCardBlock) {
      if (line.trim() === CARD_END_LINE) inCardBlock = false;
      return null;
    }
    if (line.trim() === CARD_START_LINE) {
      inCardBlock = true;
      sawStructured = true;
      return null;
    }
    // NEXT_UP 标记不再要求独占一行：模型实测会把 [NEXT_UP_START] 直接跟在正文
    // 句号后（违反「单独一行」协议），旧逻辑整行匹配不上 → 不进丢弃态，块内
    // 建议行原样流给用户，而 done 的 finalText 已被服务端正则剥干净——屏幕上
    // 留下「正文 + 建议拼接」的泄漏文本（2026-09-22 睡前提醒泄漏事故）。
    // 现按 token 在行内的实际位置裁决：丢弃态中整行扣下直到行内嵌 END（END 后
    // 的正文照发，与 extraction 的 replace 语义一致）；非丢弃态遇行内嵌 START，
    // START 前的正文照发并进入丢弃态；单行完整块（START…END 同行）取块外两段。
    const startMatch = NEXT_UP_START_RE.exec(line);
    const endMatch = NEXT_UP_END_RE.exec(line);
    const startIdx = startMatch ? startMatch.index : -1;
    const endIdx = endMatch ? endMatch.index : -1;
    const cleanInline = (part: string): string =>
      part.replace(MARKER_TOKEN_RE, "").replace(NEXT_UP_MARKER_TOKEN_RE, "").replace(RENDER_DECL_VARIANT_RE, "");
    if (inNextUpBlock) {
      if (endIdx === -1) return null;
      inNextUpBlock = false;
      const after = cleanInline(line.slice(endIdx + endMatch![0].length));
      return after.trim() ? after : null;
    }
    if (startIdx !== -1) {
      const before = cleanInline(line.slice(0, startIdx));
      if (endIdx > startIdx) {
        const after = cleanInline(line.slice(endIdx + endMatch![0].length));
        const merged = `${before}${after}`;
        return merged.trim() ? merged : null;
      }
      inNextUpBlock = true;
      return before.trim() ? before : null;
    }
    const stripped = cleanInline(line);
    if (stripped !== line) {
      if (STRUCTURAL_MARKER_TOKEN_RE.test(line)) sawStructured = true;
      // 行内嵌标记被剥离：剩余纯空白则整行丢弃，否则发剩余文本
      return stripped.trim() ? stripped : null;
    }
    if (MARKER_LINE_RE.test(line)) return null;
    return line;
  };

  const process = (text: string, isFinal: boolean): string => {
    let out = "";
    let rest = text;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl === -1) break;
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      const judged = judgeLine(line);
      if (judged !== null) out += judged + "\n";
    }
    if (rest === "") {
      pending = "";
      return out;
    }
    if (!isFinal && tailCouldBecomeMarker(rest)) {
      // 残段可能是半截标记：整段扣留，等下一段 delta 补全后裁决
      pending = rest;
      return out;
    }
    const judged = judgeLine(rest);
    pending = "";
    if (judged !== null) out += judged;
    return out;
  };

  return {
    feed(chunk: string): string {
      if (!chunk) return "";
      return process(pending + chunk, false);
    },
    flush(): string {
      if (inCardBlock) {
        // 未闭合的卡片块：全部丢弃（残缺 JSON 不可透出）
        pending = "";
        inCardBlock = false;
        return "";
      }
      inNextUpBlock = false; // 未闭合的接续建议块同样到流尾为止，内容不透出
      if (!pending) return "";
      const rest = pending;
      pending = "";
      if (tailCouldBecomeMarker(rest)) return ""; // 疑似半截标记，宁可不发
      const judged = judgeLine(rest);
      return judged ?? "";
    },
    get sawStructuredBlock(): boolean {
      return sawStructured;
    },
  };
}
