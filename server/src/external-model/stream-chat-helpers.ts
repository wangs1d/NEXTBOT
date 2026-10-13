/**
 * 流式聊天响应的 provider-agnostic 抽象层。
 *
 * 背景：
 *  - 思考类模型（Kimi K2.5 / o1* / DeepSeek-R1 / Qwen-QwQ / Claude thinking…）会先把推理过程放进
 *    流里，字段名五花八门：`reasoning_content`（Moonshot/DeepSeek）/ `reasoning`（部分代理）/
 *    `thinking`（个别本地推理端点）/ `reasoning_text`（Google）/ `reasoning_delta`（Anthropic）。
 *  - 历史上每个 Provider 自己写 `for await (const part of stream)` 的循环，只读 `content`，
 *    导致模型只推 reasoning 时 `full === ""` → 上层走兜底文案（"抱歉，我暂时无法生成回复…"）。
 *
 * 这个模块把累积逻辑收敛到一处，做到「任何模型都能修正」：
 *  - 定义一个与具体 SDK 解耦的统一 chunk 形态 `NormalChatChunk`。
 *  - 核心 consumer `consumeNormalizedStream` 只接受这个统一形态，**不耦合任何特定 provider 的字段名**。
 *  - 给出 OpenAI Chat Completions 的 normalizer adapter；其它 provider（Anthropic / Google /
 *    自研 SDK）只需写一个 normalizer 即可复用同一套兜底逻辑。
 *  - 内置一个**自适配的 generic normalizer**：当你不确定 provider 用的是哪个字段时，
 *    它会从首个 chunk 自动嗅探 reasoning 字段名，无需为每个厂商硬编码。
 *  - `pickVisibleText` 在 content 为空但 reasoning 非空时，自动降级到 reasoning（清掉 think 标签）。
 *  - `EmptyStreamContentError` 让上层能区分「真正失败」和「模型没出文本」两种语义。
 */

/* ------------------------------------------------------------------ *
 * 1. Provider-agnostic chunk 形态                                    *
 * ------------------------------------------------------------------ */

export type NormalToolCall = {
  /** stream 里 tool_calls 的 index（同一 index 跨 chunk 累积） */
  index: number;
  /** tool call id；中途可能为 null（由调用方决定兜底） */
  id?: string | null;
  /** 函数名 */
  name?: string;
  /** 增量参数（arguments JSON 字符串片段） */
  argumentsChunk?: string;
};

/** 流末尾 chunk 携带的 usage 摘要（provider-agnostic，供 token 审计采集真实计费/缓存数据）。 */
export type NormalUsage = {
  /** prefix cache 命中 token 数（OpenAI cached_tokens / DeepSeek prompt_cache_hit_tokens） */
  promptCacheHitTokens?: number;
  /** prefix cache 未命中 token 数（DeepSeek prompt_cache_miss_tokens；OpenAI 无此分离） */
  promptCacheMissTokens?: number;
  /** 输入 token 总数 */
  inputTokens?: number;
  /** 输出 token 总数 */
  outputTokens?: number;
};

/** 与具体 SDK 解耦的流式 chunk 形态。每个 provider 的 normalizer 把原生 chunk 映射到这里。 */
export type NormalChatChunk = {
  /** 正式回复文本增量（不包含思考过程） */
  content?: string;
  /** 思考/推理过程文本增量；可来自 reasoning_content / reasoning / thinking 等任意字段 */
  reasoning?: string;
  /** 流最后的 finish_reason；普通模式下通常 "stop" / "length" / "tool_calls" / "content_filter" */
  finishReason?: string | null;
  /** 工具调用增量；空数组 = 无 */
  toolCalls?: NormalToolCall[];
  /** usage 摘要（一般为最后一个 chunk） */
  usage?: NormalUsage;
};

/* ------------------------------------------------------------------ *
 * 2. 核心 consumer（provider-agnostic）                               *
 * ------------------------------------------------------------------ */

export type StreamConsumeOptions = {
  /** 每收到一段 content delta 触发；不传则只在 `pickVisibleText` 后统一推最终文本 */
  onContentDelta?: (delta: string) => void;
  /** 工具调用累积完成时触发（按 index 升序逐个调用） */
  onToolCallsComplete?: (calls: NormalToolCall[]) => void;
  /**
   * 流中**首个携带 tool_call 增量的 chunk** 到达时触发（仅一次，早于流结束）。
   * 「先一句话后结果」闸门配套（2026-10-11）：上层据此知道本波要调工具，
   * 可停止直推后续 content delta（关闸前已流出的文本 = 模型的自然确认语）。
   */
  onToolCallDeltaSeen?: () => void;
  /** 是否打印「content 为空、reasoning 兜底」等诊断日志。默认 true；`STREAM_CHAT_HELPERS_DEBUG=0` 关闭 */
  debug?: boolean;
  /** 标识 provider（"moonshot-kimi" / "openai" / "failover" / "anthropic" …） */
  providerId?: string;
  /** 标识 model，方便日志排错 */
  model?: string;
  /**
   * 两个 chunk 之间的最大空闲时间（毫秒）。超过则中断流并抛出 `StreamIdleTimeoutError`。
   * 默认从环境变量 `STREAM_IDLE_TIMEOUT_MS` 读取，未设则 30000ms。
   * 设为 0 可禁用。
   */
  idleTimeoutMs?: number;
};

export type StreamConsumeResult = {
  /** 累计的正式回复 content（原始，未 trim） */
  content: string;
  /** 累计的 reasoning（原始，未去 think 标签） */
  reasoning: string;
  /** 流最后给出的 finish_reason */
  finishReason: string | null;
  /** 累计到的 tool_calls（按 index 升序） */
  toolCalls: NormalToolCall[];
  /** 流末尾 chunk 携带的 usage 摘要（可能缺失——依赖 provider 是否流式返回 usage） */
  usage?: NormalUsage;
};

const REASONING_FALLBACK_LOG_PREFIX = "[stream-chat]";

/** 默认 chunk 间空闲超时：30s 无新 chunk 则判定流卡死。可用 `STREAM_IDLE_TIMEOUT_MS` 覆盖。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// 竖线字符类：兼容半角 `|` (U+007C) 与全角 `｜` (U+FF5C)。
// Moonshot/Kimi/DeepSeek 在不同 token 化下两种形式都会输出；此前只匹配半角，
// 全角变体的 DSML 块整段解析失败——parameter 值吞串后污染工具名，
// 触发"未找到延迟工具: voice.speak\"> <｜｜DSML｜｜parameter ..."这类执行失败。
const DSML_PIPE = "[\\|\\uFF5C]";
const DSML_TAG_PREFIX = `<\\s*\\/?\\s*${DSML_PIPE}\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*${DSML_PIPE}\\s*`;

function parseDsmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of raw.matchAll(attrRe)) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function decodeDsmlText(raw: string): string {
  return raw
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function extractDsmlToolCalls(content: string): NormalToolCall[] {
  if (!content || !/DSML/i.test(content)) return [];
  const calls: NormalToolCall[] = [];
  const invokeRe = new RegExp(
    `${DSML_TAG_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${DSML_TAG_PREFIX}invoke\\s*>`,
    "gi",
  );
  let index = 0;
  for (const invokeMatch of content.matchAll(invokeRe)) {
    const invokeAttrs = parseDsmlAttributes(invokeMatch[1] ?? "");
    const name = invokeAttrs.name?.trim();
    if (!name) continue;

    const args: Record<string, unknown> = {};
    const body = invokeMatch[2] ?? "";
    const parameterRe = new RegExp(
      `${DSML_TAG_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)${DSML_TAG_PREFIX}parameter\\s*>`,
      "gi",
    );
    for (const paramMatch of body.matchAll(parameterRe)) {
      const paramAttrs = parseDsmlAttributes(paramMatch[1] ?? "");
      const paramName = paramAttrs.name?.trim();
      if (!paramName) continue;
      const value = decodeDsmlText(paramMatch[2] ?? "");
      if (paramAttrs.number === "true") {
        const n = Number(value);
        args[paramName] = Number.isFinite(n) ? n : value;
      } else if (paramAttrs.boolean === "true") {
        args[paramName] = /^(true|1|yes)$/i.test(value);
      } else {
        args[paramName] = value;
      }
    }

    calls.push({
      index,
      id: `dsml_call_${Date.now().toString(36)}_${index}`,
      name,
      argumentsChunk: JSON.stringify(args),
    });
    index += 1;
  }
  return calls;
}

/* ------------------------------------------------------------------ *
 * 文本形态工具调用：声明式格式注册表 + 通用解析引擎 + 结构启发式兜底    *
 * （根因方案：换模型不再需要为每种泄漏格式人工写适配）                  *
 * ------------------------------------------------------------------ */

/**
 * 泄漏机理（2026-10-07 双向实测）：带 tools 的请求各厂商都返回结构化
 * tool_calls；泄漏只发生在**无工具/工具被裁轮次**——模型按各自训练格式把调用
 * 写进 content 正文（充要条件 = 模型自认能办事 × 无结构化通道）。MiniMax-M3
 * 形如 `<tool_call><invoke name="reminder_plan"><parameter name="title">…`；
 * Qwen/Hermes 系为 `<tool_call>{"name":"x","arguments":{…}}</tool_call>`。
 *
 * 根因方案分两层：
 *   1. 声明式注册表（TEXTUAL_TOOL_CALL_FORMATS）：已知厂商格式注册一条声明
 *      （标签名集合 + 可选 namespace 前缀 + JSON 载荷容器），提取（XML/JSON
 *      双形态）、流式净化、半截标签滞留、正文剥离全部由注册表派生自动生效——
 *      新模型适配 = 注册一行，零解析代码。
 *   2. 结构启发式兜底（extractHeuristicToolCalls）：完全未注册的格式按
 *      「标签名含工具词根（tool/invoke/call/param/function/arg）+ name 属性
 *      定性 + 键值参数/JSON 载荷」识别——保证任何新厂商的泄漏都能被提取升级
 *      到任务面、正文流末被剥离；仅流式半截拦截弱于注册格式（可随后补注册）。
 */

/** 一个「文本形态 XML 工具调用格式」的声明。 */
type XmlToolCallFormat = {
  /** 格式 id（日志/排错定位用） */
  id: string;
  /** 该格式的全部协议标签名（不带 namespace 前缀的裸名） */
  tagNames: readonly string[];
  /** 可选 namespace 前缀：匹配 `<prefix:tag>`；无前缀变体始终兼容 */
  namespacePrefixes?: readonly string[];
  /** JSON 载荷容器标签：`<tag>{"name":…,"arguments":{…}}</tag>` */
  jsonPayloadTags?: readonly string[];
};

/**
 * 已知厂商格式注册表。新模型泄漏新格式时：先在此注册一行（流式净化即全量
 * 生效）；来不及注册时结构启发式也能兜住提取与流末剥离。
 */
const TEXTUAL_TOOL_CALL_FORMATS: readonly XmlToolCallFormat[] = [
  {
    id: "minimax-m3",
    // MiniMax-M3 无工具轮训练格式；<minimax:tool_call> 为带前缀变体。
    // Qwen/Hermes 系复用 tool_call 标签但载荷为 JSON（jsonPayloadTags）。
    tagNames: ["tool_call", "invoke", "parameter"],
    namespacePrefixes: ["minimax"],
    jsonPayloadTags: ["tool_call"],
  },
];

/** 单格式的 namespace 前缀模式（整组可选）：`(?:(?:minimax)\s*:\s*)?` */
function formatNamespacePattern(fmt: XmlToolCallFormat): string {
  const prefixes = fmt.namespacePrefixes?.filter(Boolean) ?? [];
  return prefixes.length > 0 ? `(?:(?:${prefixes.join("|")})\\s*:\\s*)?` : "";
}

/** 启发式词根：标签名含这些词根即视为工具协议标签候选（定性靠 name 属性/JSON 载荷）。 */
const TOOLISH_NAME_ROOTS = ["tool", "invoke", "call", "param", "function", "arg"] as const;
/** 启发式标签名模式：词根可出现在任意命名段中（my_tool / function_call / parameter 等）。 */
const TOOLISH_NAME_PATTERN = "[a-z0-9_]*?(?:tool|invoke|call|param|function|arg)[a-z0-9_]*";
/** 启发式标签的通用 namespace 前缀（未知厂商的任意 `<ns:` 形态）。 */
const GENERIC_NS_PATTERN = "(?:[A-Za-z][\\w.-]*\\s*:\\s*)?";

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -- 由注册表派生的共享常量（提取/净化/滞留三处共用，注册即全量生效） -- */

/** 已知标签名全集（半截滞留判定用）。 */
const KNOWN_TEXTUAL_TAG_NAMES: readonly string[] =
  TEXTUAL_TOOL_CALL_FORMATS.flatMap((f) => f.tagNames);
/** 已知 namespace 前缀全集。 */
const KNOWN_TEXTUAL_NS_PREFIXES: readonly string[] =
  TEXTUAL_TOOL_CALL_FORMATS.flatMap((f) => f.namespacePrefixes ?? []);

/**
 * 完整协议标签联合模式（开/闭/自闭合）：
 *   - 注册格式：精确标签名（`[^>]*` 容纳属性）；
 *   - 启发式：带 name 属性的工具词根开标签 + 工具词根闭标签。
 * 流式净化 drain() 用它取「最早出现的协议标签」；name 属性定性把误伤收敛到
 * 「正文恰好出现 `<词根标签 name="…">`」的极端场景（与 think 净化器同款取舍：
 * 内部信号防透出的优先级更高）。
 */
const TEXTUAL_TOOL_ANY_TAG_RE = new RegExp(
  [
    ...TEXTUAL_TOOL_CALL_FORMATS.map((fmt) => {
      const ns = formatNamespacePattern(fmt);
      return `<\\s*\\/?\\s*${ns}(?:${fmt.tagNames.join("|")})\\b[^>]*>`;
    }),
    // 启发式闭标签（无属性要求——游离闭标签同样剥除）
    `<\\s*\\/\\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\\s*>`,
    // 启发式开标签：词根名 + 必须携带 name="…" 属性
    `<\\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\\s+[^>]*?\\bname\\s*=\\s*(?:"[^"]*"|'[^']*')[^>]*>`,
  ].join("|"),
  "i",
);
/** 快速判定：content 是否含已注册格式的协议标签（启发式另判）。 */
const TEXTUAL_TOOL_TAG_PROBE_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${TEXTUAL_TOOL_CALL_FORMATS.flatMap((f) => {
    const ns = formatNamespacePattern(f);
    return f.tagNames.map((t) => `${ns}${t}`);
  }).join("|")})\\b`,
  "i",
);

/** 文本形态参数值解码：HTML 实体 + 去包裹引号 + 数字/布尔字面量推断。 */
function coerceTextualParamValue(raw: string): unknown {
  const decoded = raw
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
  // 模型常给字符串参数画上引号（实测：title → "王哥，吃饭啦"），去掉包裹引号
  const unquoted =
    decoded.length >= 2 &&
    ((decoded.startsWith('"') && decoded.endsWith('"')) ||
      (decoded.startsWith("「") && decoded.endsWith("」")))
      ? decoded.slice(1, -1).trim()
      : decoded;
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) {
    const n = Number(unquoted);
    if (Number.isFinite(n)) return n;
  }
  if (/^(true|false)$/i.test(unquoted)) return /^true$/i.test(unquoted);
  return unquoted;
}

/** 单注册格式的提取：JSON 载荷形态 + XML invoke/parameter 形态。 */
function extractCallsForFormat(content: string, fmt: XmlToolCallFormat): NormalToolCall[] {
  const calls: NormalToolCall[] = [];
  let index = 0;
  const ns = formatNamespacePattern(fmt);
  const push = (name: string, args: Record<string, unknown>) => {
    calls.push({
      index,
      id: `xml_call_${fmt.id}_${Date.now().toString(36)}_${index}`,
      name,
      argumentsChunk: JSON.stringify(args),
    });
    index += 1;
  };

  // JSON 载荷形态：<tool_call>{"name":"x","arguments":{…}}</tool_call>
  for (const tag of fmt.jsonPayloadTags ?? []) {
    const jsonBlockRe = new RegExp(
      `<\\s*${ns}${tag}\\s*>\\s*([{\\[][\\s\\S]*[}\\]])\\s*<\\s*\\/\\s*${ns}${tag}\\s*>`,
      "gi",
    );
    for (const m of content.matchAll(jsonBlockRe)) {
      try {
        const parsed = JSON.parse(m[1]) as { name?: unknown; arguments?: unknown };
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          push(parsed.name.trim(), (parsed.arguments ?? {}) as Record<string, unknown>);
        }
      } catch {
        // 半截 JSON：按无效调用忽略（正文剥离仍会进行）
      }
    }
  }

  // XML invoke 形态：<invoke name="x"><parameter name="k">v</parameter></invoke>
  const invokeRe = new RegExp(
    `<\\s*${ns}invoke\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*${ns}invoke\\s*>`,
    "gi",
  );
  const parameterRe = new RegExp(
    `<\\s*${ns}parameter\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*${ns}parameter\\s*>`,
    "gi",
  );
  for (const invokeMatch of content.matchAll(invokeRe)) {
    const invokeAttrs = parseDsmlAttributes(invokeMatch[1] ?? "");
    const name = invokeAttrs.name?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const paramMatch of (invokeMatch[2] ?? "").matchAll(parameterRe)) {
      const paramAttrs = parseDsmlAttributes(paramMatch[1] ?? "");
      const paramName = paramAttrs.name?.trim();
      if (!paramName) continue;
      args[paramName] = coerceTextualParamValue(paramMatch[2] ?? "");
    }
    push(name, args);
  }
  return calls;
}

/**
 * 从 content 提取「已注册格式」的文本形态工具调用（与 extractDsmlToolCalls 互斥：
 * DSML 标签带竖线前缀，不会被这里的正则命中）。
 *
 * 覆盖格式（随注册表扩展）：
 *   A. `<tool_call>…<invoke name="x">…</invoke>…</tool_call>`（含 minimax: 变体、
 *      无外层包裹的裸 invoke）；
 *   B. `<tool_call>{"name":"x","arguments":{…}}</tool_call>`（Qwen/Hermes JSON）。
 */
export function extractTextualToolCalls(content: string): NormalToolCall[] {
  if (!content || !TEXTUAL_TOOL_TAG_PROBE_RE.test(content)) return [];
  const calls: NormalToolCall[] = [];
  for (const fmt of TEXTUAL_TOOL_CALL_FORMATS) {
    calls.push(...extractCallsForFormat(content, fmt));
  }
  return calls;
}

/* -- 结构启发式兜底（未注册格式的最后一道网） -- */

/** 启发式快速判定：content 含工具词根标签候选才进结构扫描。 */
const HEURISTIC_TOOL_TAG_PROBE_RE = new RegExp(
  `<\\s*\\/?\\s*${GENERIC_NS_PATTERN}[A-Za-z][\\w.-]*(?:tool|invoke|call|param|function|arg)`,
  "i",
);

/**
 * 未注册格式的结构启发式提取：不认识标签名没关系，只要结构像工具调用——
 * 容器标签名含工具词根，且（带 name 属性 → 工具名）或（载荷为含 name 字段的
 * JSON）；参数来自「带 name 属性的子标签」或容器附加属性。
 */
export function extractHeuristicToolCalls(content: string): NormalToolCall[] {
  if (!content || content.indexOf("<") < 0 || !HEURISTIC_TOOL_TAG_PROBE_RE.test(content)) {
    return [];
  }
  const calls: NormalToolCall[] = [];
  const openRe = /<\s*([A-Za-z][\w.-]*)(\s[^<>]*?)?\s*(\/?)>/g;
  // 已消费区间水印：外层容器提取为调用后，其内部标签（invoke 里的 parameter、
  // function_call 里的 arg）不再作为独立调用扫描——参数标签也带 name 属性，
  // 不做区间排除会把参数键名误判成工具名。
  let consumedUntil = 0;
  for (const open of content.matchAll(openRe)) {
    if ((open.index ?? 0) < consumedUntil) continue;
    const tagName = (open[1] ?? "").toLowerCase();
    if (!TOOLISH_NAME_ROOTS.some((root) => tagName.includes(root))) continue;
    const selfClosing = open[3] === "/";
    const attrs = parseDsmlAttributes((open[2] ?? "").replace(/\/\s*$/, ""));
    const after = content.slice((open.index ?? 0) + open[0].length);
    const closeMatch = new RegExp(
      `<\\s*\\/\\s*(?:${GENERIC_NS_PATTERN})?${escapeRegExp(tagName)}\\s*>`,
      "i",
    ).exec(after);
    if (!selfClosing && !closeMatch) continue;
    const body = selfClosing ? "" : after.slice(0, closeMatch!.index);

    let name = attrs.name?.trim() ?? "";
    let args: Record<string, unknown> = {};
    const trimmedBody = body.trim();
    // JSON 载荷（无 name 属性容器，如 <function_call>{"name":…}</function_call>）
    if (!name && trimmedBody.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmedBody) as { name?: unknown; arguments?: unknown };
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          name = parsed.name.trim();
          args = (parsed.arguments ?? {}) as Record<string, unknown>;
        }
      } catch {
        // 半截 JSON：忽略（正文剥离仍会进行）
      }
    }
    if (!name) continue;
    // 子标签参数：<arg name="city">北京</arg> / <parameter name="title">…</parameter>
    if (trimmedBody.startsWith("<")) {
      const childRe = /<\s*([A-Za-z][\w:.-]*)((?:\s[^<>]*?)?)\s*(\/?)>/g;
      for (const child of body.matchAll(childRe)) {
        if (child[3] === "/") continue;
        const childAttrs = parseDsmlAttributes(child[2] ?? "");
        const paramName = childAttrs.name?.trim();
        if (!paramName) continue;
        const rest = body.slice((child.index ?? 0) + child[0].length);
        const childClose = new RegExp(
          `<\\s*\\/\\s*${escapeRegExp(child[1] ?? "")}\\s*>`,
          "i",
        ).exec(rest);
        args[paramName] = coerceTextualParamValue(
          childClose ? rest.slice(0, childClose.index) : "",
        );
      }
    }
    // 容器附加属性视为参数（<invoke name="x" city="北京"/> 形态）
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== "name" && args[k] === undefined) args[k] = coerceTextualParamValue(v);
    }
    calls.push({
      index: calls.length,
      id: `htool_call_${Date.now().toString(36)}_${calls.length}`,
      name,
      argumentsChunk: JSON.stringify(args),
    });
    // 标记本调用区间已消费（含闭合标签），内部子标签不再重复扫描
    consumedUntil = selfClosing
      ? (open.index ?? 0) + open[0].length
      : (open.index ?? 0) + open[0].length + closeMatch!.index + closeMatch![0].length;
  }
  return calls;
}

/**
 * 统一提取入口：DSML（Kimi）+ 已注册格式 + 结构启发式，按「工具名+参数」去重
 * （启发式与注册引擎命中的同一调用只保留首个）。consumeNormalizedStream 一律
 * 走这里——新厂商格式未注册时也能被提取升级到任务面。
 */
export function extractAllTextualToolCalls(content: string): NormalToolCall[] {
  const merged = [
    ...extractDsmlToolCalls(content),
    ...extractTextualToolCalls(content),
    ...extractHeuristicToolCalls(content),
  ];
  if (merged.length <= 1) return merged;
  const seen = new Set<string>();
  const out: NormalToolCall[] = [];
  for (const call of merged) {
    const key = `${call.name ?? ""}\u0000${call.argumentsChunk ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...call, index: out.length });
  }
  return out;
}

function resolveIdleTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  const env = process.env.STREAM_IDLE_TIMEOUT_MS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function isDebugEnabled(opt?: boolean): boolean {
  if (opt === false) return false;
  const env = process.env.STREAM_CHAT_HELPERS_DEBUG;
  if (env === "0" || env === "false") return false;
  return true;
}

/**
 * 流式响应中两个 chunk 之间空闲超时（网络半开 / 模型卡住 / 代理中断但未关流）。
 * 抛出后上层可走 failover / 兜底文案，而不是干等到 OpenAI SDK 的 10 分钟默认超时。
 */
export class StreamIdleTimeoutError extends Error {
  readonly providerId?: string;
  readonly model?: string;
  readonly idleMs: number;
  readonly partialContent: string;

  constructor(params: {
    providerId?: string;
    model?: string;
    idleMs: number;
    partialContent: string;
  }) {
    super(
      `Stream idle timeout: no chunk for ${params.idleMs}ms ` +
        `(provider=${params.providerId ?? "?"} model=${params.model ?? "?"} ` +
        `partial_bytes=${params.partialContent.length})`,
    );
    this.name = "StreamIdleTimeoutError";
    this.providerId = params.providerId;
    this.model = params.model;
    this.idleMs = params.idleMs;
    this.partialContent = params.partialContent;
  }
}

/**
 * 消费一段 provider-agnostic 的流，自动处理：
 *  - content / reasoning 累积；
 *  - tool_calls 跨 chunk 累积（按 index 合并）；
 *  - finish_reason 取最后一个非空值；
 *  - **chunk 间空闲超时**：超过 `idleTimeoutMs` 无新 chunk 则抛 `StreamIdleTimeoutError`，
 *    避免网络半开 / 模型卡住时干等 OpenAI SDK 默认 10 分钟超时。
 *
 * 这个函数**不**关心来源是 OpenAI / Anthropic / 自研 SDK，只看 NormalChatChunk 形态。
 */
export async function consumeNormalizedStream(
  source: AsyncIterable<NormalChatChunk>,
  options: StreamConsumeOptions = {},
): Promise<StreamConsumeResult> {
  let content = "";
  // 咽喉处的「原文累积」：只剥内联 think 块、保留 DSML 标记的文本。流末用它做
  // DSML 工具调用提取（extractDsmlToolCalls）——提取必须看到完整标记，而流式
  // 发射必须看不到协议原文，两者只能分开累积。
  let rawContent = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: NormalUsage | undefined;
  // 流中是否已出现过 tool_call 增量（onToolCallDeltaSeen 只发一次）
  let toolCallDeltaSeen = false;
  const toolAccByIndex = new Map<number, NormalToolCall>();
  // content 内联思考块净化：部分思考型模型把 `<think>…</think>` 直接写进 content
  // （而非独立 reasoning 字段），在咽喉处统一剥除，保证所有 consumer 拿到的
  // content / onContentDelta 都是「正式回复文本」（见 stripInlineThinkBlocks 注释）。
  const thinkSanitizer = createStreamThinkSanitizer();
  // DSML 协议标记滞留净化（2026-09-11 根修）：模型在无工具/工具被裁的轮次会把
  // 工具调用按训练格式（<| | DSML | | calls/invoke/parameter…>）写进 content。
  // 历史上这段协议原文会随 onContentDelta 逐 chunk 直推前端（剥离只发生在流末，
  // 收不回已展示的内容）。现在 think 剥离后的文本再过一道跨 chunk 的 DSML 守卫：
  // 协议标记及其内部内容绝不发射，正文照常透传；流末再从 rawContent 提取工具调用。
  const dsmlSanitizer = createStreamDsmlSanitizer();

  const idleMs = resolveIdleTimeoutMs(options.idleTimeoutMs);
  const useIdleGuard = idleMs > 0;

  // 把 AsyncIterable 包装成「带空闲超时的 iterator」。
  // 每次取下一个 chunk 时用 Promise.race 让「下一个 chunk」与「超时定时器」竞速。
  // 超时则抛 StreamIdleTimeoutError，携带已累积的 partial content 供上层兜底。
  const iterator = source[Symbol.asyncIterator]();

  try {
    while (true) {
      const nextPromise = iterator.next();
      let result: IteratorResult<NormalChatChunk>;

      if (useIdleGuard) {
        let timer: NodeJS.Timeout | undefined;
        try {
          result = await Promise.race<IteratorResult<NormalChatChunk>>([
            nextPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new StreamIdleTimeoutError({
                      providerId: options.providerId,
                      model: options.model,
                      idleMs,
                      partialContent: content,
                    }),
                  ),
                idleMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        result = await nextPromise;
      }

      if (result.done) break;
      const chunk = result.value;

      if (chunk.content && chunk.content.length > 0) {
        const visibleDelta = thinkSanitizer.feed(chunk.content);
        if (visibleDelta) {
          rawContent += visibleDelta;
          const emitDelta = dsmlSanitizer.feed(visibleDelta);
          if (emitDelta) {
            content += emitDelta;
            options.onContentDelta?.(emitDelta);
          }
        }
      }
      if (chunk.reasoning && chunk.reasoning.length > 0) {
        reasoning += chunk.reasoning;
      }
      if (chunk.finishReason != null) {
        finishReason = chunk.finishReason;
      }
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        // 首个 tool_call 增量即通知（流中时点，非流末）：闸门类 consumer 依赖
        // 这个时点区分「确认语文本」与「工具调用之后的伴随文本」。
        if (!toolCallDeltaSeen) {
          toolCallDeltaSeen = true;
          options.onToolCallDeltaSeen?.();
        }
        for (const tc of chunk.toolCalls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolAccByIndex.get(idx);
          if (!acc) {
            acc = { index: idx };
            toolAccByIndex.set(idx, acc);
          }
          if (tc.id != null) acc.id = tc.id;
          if (tc.name) acc.name = tc.name;
          if (tc.argumentsChunk) acc.argumentsChunk = (acc.argumentsChunk ?? "") + tc.argumentsChunk;
        }
      }
      // usage 只出现在流末尾 chunk（OpenAI/DeepSeek/Kimi 均如此），后出现覆盖先出现
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } finally {
    // 确保底层 iterator 被释放（尤其是超时中断后，避免底层 HTTP 流泄漏）
    try {
      await iterator.return?.();
    } catch {
      // ignore
    }
  }

  // 流结束：冲出净化器滞留的尾巴（正常正文，或从未补全的伪标签前缀）。
  // 若思考块始终未闭合，flush 返回空——整段视为思考过程丢弃。
  const thinkTail = thinkSanitizer.flush();
  if (thinkTail) {
    rawContent += thinkTail;
    const thinkTailOut = dsmlSanitizer.feed(thinkTail);
    if (thinkTailOut) {
      content += thinkTailOut;
      options.onContentDelta?.(thinkTailOut);
    }
  }
  const dsmlTail = dsmlSanitizer.flush();
  if (dsmlTail) {
    content += dsmlTail;
    options.onContentDelta?.(dsmlTail);
  }

  let toolCalls: NormalToolCall[] = [...toolAccByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  // 提取必须用 rawContent（协议标记完好），发射给 consumer 的 content 已被
  // 守卫剥掉协议原文——否则提取不到任何调用（2026-09-11 根修）。
  // 2026-10-08 根因化：统一入口 = DSML（Kimi）+ 注册格式（声明式注册表派生）
  // + 结构启发式（未注册格式兜底）。任何厂商在无工具轮把调用写进 content，
  // 都能被提取升级到任务面执行 / 正文流末剥离——换模型不再需要人工适配。
  const extractedCalls = extractAllTextualToolCalls(rawContent);
  if (extractedCalls.length > 0) {
    const offset = toolCalls.length;
    toolCalls = toolCalls.concat(
      extractedCalls.map((call, i) => ({ ...call, index: offset + i })),
    );
    // content 已被守卫剥掉协议原文，strip 通常在此为 no-op（防守卫旁路的兜底）。
    // 但 no-op 不带 trim——历史行为里「有协议块的正文」会经 strip 收尾 trim，
    // 这里补 .trim() 保持契约（协议块被剥后正文不应残留尾随空行）。
    content = stripDsmlToolCallMarkup(content).trim();
    finishReason = "tool_calls";
  } else {
    content = stripDsmlToolCallMarkup(content);
  }
  if (toolCalls.length > 0) {
    options.onToolCallsComplete?.(toolCalls);
  }

  const debug = isDebugEnabled(options.debug);
  if (debug && !content.trim() && reasoning.trim()) {
    // eslint-disable-next-line no-console
    console.info(
      `${REASONING_FALLBACK_LOG_PREFIX} provider=${options.providerId ?? "?"} ` +
        `model=${options.model ?? "?"} content=empty, reasoning_len=${reasoning.length} ` +
        `→ will fall back to reasoning as visible text`,
    );
  }

  return { content, reasoning, finishReason, toolCalls, ...(usage ? { usage } : {}) };
}

/* ------------------------------------------------------------------ *
 * 3. 可见文本选择 + think-tag 清理                                    *
 * ------------------------------------------------------------------ */

/**
 * 清理 reasoning 中的 `<thinking>…</thinking>` / `<think>…</think>` 包裹（Kimi K2.5、DeepSeek-R1
 * 的 reasoning 经常把正式答案也写在 reasoning 里，外面包一层 think 标签）。
 * 同时把多余的空白行合并。
 */
export function stripThinkTags(reasoning: string): string {
  if (!reasoning) return "";
  let cleaned = reasoning;
  // 闭合标签包裹（think/thinging/reasoning）
  cleaned = cleaned.replace(/<\s*\/?\s*(?:think(?:ing)?|reasoning)\s*>/gi, "");
  // 处理未闭合的 <think>（部分模型在 reasoning 末尾忘了闭合）
  cleaned = cleaned.replace(/<\s*think(?:ing)?\s*>/gi, "");
  // 收尾的多余换行
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

/* ------------------------------------------------------------------ *
 * content 内联 <think> 块净化（思考透出防御，2026-09-05）              *
 * ------------------------------------------------------------------ */

/**
 * 部分"思考型"模型（Qwen3 / DeepSeek-R1 部分部署 / MiniMax M2.x 未走 reasoning_split
 * 的通用 OpenAI 兼容通路等）会把推理过程以内联 `<think>…</think>` 文本形式直接写进
 * `content` 字段，而不是放进独立的 `reasoning_content`。历史上的净化只覆盖：
 *   1) 独立 reasoning 字段（normalizer 嗅探 + pickVisibleText 兜底时 stripThinkTags）；
 *   2) Kimi 的 DSML 工具调用标记（stripDsmlToolCallMarkup）；
 * 「content 非空且内联 think 标签」这条路径完全裸奔——思考原文逐字透出到前端气泡
 * （实测截图：`<think>用户问了"几点了"…</think>晚上 11 点 25 分，星期六。`）。
 *
 * 与 stripThinkTags（只剥标签、保留内部文本，用于 reasoning 降级展示）不同，
 * 这里把**整个思考块连同内容一起删除**——content 是对用户的正式回复，思考不该可见。
 */

const THINK_OPEN_TAG_RE = /<\s*(?:think(?:ing)?|reasoning)\s*>/i;
const THINK_CLOSE_TAG_RE = /<\s*\/\s*(?:think(?:ing)?|reasoning)\s*>/i;
const THINK_ANY_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|reasoning)\s*>/gi;

/**
 * 整串剥离 content 里内联的思考块：
 *   - 成对的 `<think>…</think>`（含 thinking / reasoning 变体）：整块连同内容删除；
 *   - 游离的闭合标签：删除；
 *   - 未闭合的开标签（模型流被截断 / 忘了闭合）：其后内容视为思考过程，删到串尾。
 * 注意：如果正文本身需要输出字面 `<think>`（例如教用户写 HTML），会被误删——
 * 与 createStreamControlTagSanitizer 的取舍一致：内部信号防透出的优先级更高。
 */
export function stripInlineThinkBlocks(content: string): string {
  if (!content || content.indexOf("<") < 0) return content;
  let cleaned = content;
  // 成对块（非贪婪，逐对删除）
  cleaned = cleaned.replace(
    /<\s*(?:think(?:ing)?|reasoning)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|reasoning)\s*>/gi,
    "",
  );
  // 游离闭合标签（嵌套 / 成对删除后剩下的）
  cleaned = cleaned.replace(/<\s*\/\s*(?:think(?:ing)?|reasoning)\s*>/gi, "");
  // 未闭合的开标签：删到串尾
  cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|reasoning)\s*>[\s\S]*$/i, "");
  return cleaned;
}

/**
 * 识别 pending 末尾是否为「可能是半截 think 标签的前缀」（如 `<th` / `</ reas`）。
 * 是则返回应滞留的字符数（下一 chunk 到达后再判定），否则返回 0。
 * 也接受完整的 `<think>` 形态——调用方保证只在「未匹配到完整标签」时调用，
 * 此时完整形态不会出现；纯 `<` / `< `（比较运算等）会短暂滞留，下一 chunk 即放行。
 */
function thinkTagPartialSuffixLen(text: string): number {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return 0;
  const tail = text.slice(lt);
  if (tail.length > 32) return 0;
  const m = /^<\s*\/?\s*([A-Za-z]*)\s*>?$/.exec(tail);
  if (!m) return 0;
  const name = m[1].toLowerCase();
  // 名称为空（如 "<" / "</"）或为 think/thinking/reasoning 的前缀 → 可能是标签，滞留待判
  if (name === "" || "thinking".startsWith(name) || "reasoning".startsWith(name)) {
    return tail.length;
  }
  return 0;
}

/**
 * 流式内联思考块净化器（跨 chunk）。
 *
 * 用法：把 provider 推流的原始 content 增量喂给 `feed(delta)`，返回值是**可以推给
 * 前端/累积为正式回复**的净化后增量；流结束后调 `flush()` 冲出滞留的尾巴。
 *
 * 状态机：
 *   - 正常态：扫描 `<think>` / `<thinking>` / `<reasoning>` 开标签（含半角空白变体），
 *     命中则删除并进入思考态；末尾可能是半截标签的前缀则滞留待判。
 *   - 思考态：丢弃一切内容，直到出现闭合标签回到正常态；滞留可能是半截闭合标签的尾部。
 *   - `flush()`：正常态下滞留的是正常正文 / 从未补全的伪标签前缀，原样放行；
 *     思考态下说明模型始终未闭合（流被截断或忘了闭合），剩余内容全部视为思考丢弃。
 *
 * 内存有界：正常态每个 chunk 后 pending 只留 ≤32 字符的标签前缀尾巴；
 * 思考态只留闭合标签判定所需的尾部，思考正文即时丢弃，不需要保险丝。
 */
export function createStreamThinkSanitizer() {
  let pending = "";
  let inThink = false;

  function drain(): string {
    let out = "";
    while (true) {
      if (inThink) {
        const closeMatch = THINK_CLOSE_TAG_RE.exec(pending);
        if (closeMatch) {
          pending = pending.slice(closeMatch.index + closeMatch[0].length);
          inThink = false;
          continue;
        }
        // 未闭合：思考内容全部丢弃，只留可能是半截闭合标签的尾部
        const hold = thinkTagPartialSuffixLen(pending);
        pending = hold > 0 ? pending.slice(pending.length - hold) : "";
        return out;
      }
      THINK_ANY_TAG_RE.lastIndex = 0;
      const tagMatch = THINK_ANY_TAG_RE.exec(pending);
      if (!tagMatch) {
        const hold = thinkTagPartialSuffixLen(pending);
        if (hold > 0) {
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
        } else {
          out += pending;
          pending = "";
        }
        return out;
      }
      out += pending.slice(0, tagMatch.index);
      pending = pending.slice(tagMatch.index + tagMatch[0].length);
      if (tagMatch[1]) {
        // 游离闭合标签（正常态出现）：剥掉，保持与 stripInlineThinkBlocks 一致
        continue;
      }
      inThink = true;
    }
  }

  return {
    feed(delta: string): string {
      pending += delta;
      return drain();
    },
    flush(): string {
      const rest = pending;
      pending = "";
      if (inThink) return "";
      return rest;
    },
  };
}

/* ------------------------------------------------------------------ *
 * DSML 协议标记滞留净化器（2026-09-11 根修）                          *
 * ------------------------------------------------------------------ *
 * 模型在无工具/工具被裁的轮次会把工具调用按训练格式写进 content：
 *   `< | | DSML | | calls> … <| | DSML| | invoke name="tool_call"> …`
 * 历史缺陷：这段协议原文随 onContentDelta 逐 chunk 直推前端（服务端剥离只在
 * 流末，收不回已展示的气泡），客户端再拿原始流式缓冲做 done 兜底 → 协议原文
 * 定稿在聊天气泡里（2026-09-11 01:34 实测截图）。
 *
 * 本净化器与 createStreamThinkSanitizer 同构：跨 chunk 识别协议标记并整段
 * 丢弃，正文照常透传。与「流末整段 strip」的本质区别：**协议文本从一开始
 * 就不进入流式通道**，前端永远不会看到。
 *
 * 状态机：
 *   - 正常态：扫描完整 DSML 标签（开/闭，含半角 `|`、全角 `｜`、任意空白）。
 *     开标签 → 进入协议态（depth=1）；游离闭标签 → 只剥标签本身。
 *   - 协议态：丢弃一切内容，按深度计数嵌套（calls>invoke>parameter），
 *     depth 归零（最外层闭合）后回到正常态继续透传后续正文；
 *     未闭合（流被截断）则 flush 时整体丢弃。
 *   - 边界滞留：末尾是「可能是半截 DSML 标签」的前缀（`< |`、`</ | | DSML |`…）
 *     时滞留待下一 chunk 判定，上限 120 字符（真实标签最长约 50 字符）。
 *
 * 取舍：正文若恰好包含 `< |` 这类比较/管道写法会被短暂滞留（≤1 chunk），
 * 超过 120 字符无 `>` 即放行——与 think 净化器对裸 `<` 的取舍一致：
 * 内部信号防透出的优先级更高。
 */

/** 完整 DSML 标签（开或闭）：`<` 可选 `/`，两组竖线（间可夹空白），`DSML`，任意标签头到 `>`。 */
const DSML_ANY_TAG_RE = /<\s*\/?\s*[|｜]+\s*[|｜]+\s*DSML[^>]*>/i;

/**
 * 末尾滞留判定：是否为「可能是半截协议标签的前缀」。返回应滞留的字符数。
 * 策略：裸 `<`（`a<b`、`5<3`）不滞留；`<字母…` 名字段按「已知标签前缀 / 已知
 * ns 前缀 / 工具词根」定性后整段滞留（≤120，属性可含任意字符直到 `>`）；
 * 未知名且未长全也滞留到 `>`（未注册厂商标签不打字机漏出，正文 `<word`
 * 最多延迟一个 chunk，`>` 一到立即放行）。
 */
function textualToolPartialTagTailLen(text: string): number {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return 0;
  const tail = text.slice(lt);
  if (tail.length > 120) return 0;
  // `<` + 可选 `/` + 字母开头的名字段：先定性名字，未定性则滞留到标签长全。
  const m = /^<\s*\/?\s*(?:([A-Za-z][\w]*)\s*:\s*)?([a-zA-Z_][\w-]*)/.exec(tail);
  if (!m) return 0; // 裸 `<`（`a<b`、`5<3`）或非字母：正文太常见，不滞留
  const name = (m[2] ?? "").toLowerCase();
  // 已知注册标签 / 已知 ns 前缀（含 `<minimax` 未打出冒号）/ 工具词根候选：
  // 定性为协议候选，整段滞留（含属性与任意字符，≤120）等 `>`
  if (KNOWN_TEXTUAL_TAG_NAMES.some((k) => k.startsWith(name))) return tail.length;
  if (KNOWN_TEXTUAL_NS_PREFIXES.some((p) => p.toLowerCase().startsWith(name))) {
    return tail.length;
  }
  if (TOOLISH_NAME_ROOTS.some((r) => name.includes(r) || r.startsWith(name))) {
    return tail.length;
  }
  // 未知名字（如未注册厂商的 `<wrap_call`）：标签没长全前无法判——滞留到 `>`
  // 出现。`>` 一到即走完整标签分支（注册/启发式/裸标签留观）或立即放行，
  // 正文 `<word` 形态最多延迟一个 chunk（有界）。
  if (!tail.includes(">")) return tail.length;
  return 0;
}

function dsmlPartialTagTailLen(text: string): number {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return 0;
  const tail = text.slice(lt);
  if (tail.length > 120) return 0;
  // 已确认 `<` + 可选 `/` + 至少一条竖线：几乎必然是 DSML 标签，滞留到 `>` 或超限
  if (/^<\s*\/?\s*[|｜]/.test(tail)) return tail.length;
  // 尚未到竖线：`<`、`< `、`</`、`< |` 等纯前导组合，短暂滞留待判
  if (/^<\s*\/?\s*[|｜]{0,2}$/.test(tail)) return tail.length;
  return 0;
}

/**
 * 裸工具词根开标签（无 name 属性）：注册表与「name 属性定性」都不认的容器，
 * 但它可能是未知厂商的 JSON 载荷容器（如 <function_call>{"name":…}）或
 * 外层包裹（如 <wrap_call><invoke name=…>）。流式遇到时进入「留观」。
 */
function findBareToolishOpen(text: string): { index: number; tagName: string } | null {
  const openRe = new RegExp(
    `<\\s*${GENERIC_NS_PATTERN}(${TOOLISH_NAME_PATTERN})((?:\\s[^<>]*)?)>`,
    "gi",
  );
  for (const m of text.matchAll(openRe)) {
    const attrs = (m[2] ?? "").trimEnd();
    if (/\bname\s*=/i.test(attrs)) continue; // 带 name 属性的走完整启发式分支
    if (/\/\s*$/.test(attrs)) continue; // 自闭合无内容，无需留观
    return { index: m.index ?? -1, tagName: (m[1] ?? "").toLowerCase() };
  }
  return null;
}

/** 留观判决。 */
type ProbationVerdict = "confirm" | "release" | "hold";

/**
 * 留观证据判定（对「开标签之后的候选证据」）：
 *   - 首个非空白是 `{` 且出现 `"name":` 键 → JSON 载荷容器，确认；
 *   - 首个非空白是同名闭标签（成对）→ 确认；
 *   - 首个非空白是带 name 属性的工具词根开标签 → 外层包裹，确认；
 *   - 其余（正文文本 / 无关标签）→ 证伪，原样放行；
 *   - 证据未齐（纯空白 / JSON 还没出 "name" 键）→ 继续扣，超上限放行。
 * 确认成本有界：留观段 ≤ PROBATION_CAP；正文误扣在首个非空白字符即解除。
 */
function evaluateProbation(seg: string, tagName: string): ProbationVerdict {
  const PROBATION_CAP = 240;
  const tagEnd = seg.indexOf(">");
  if (tagEnd < 0) return seg.length > PROBATION_CAP ? "release" : "hold";
  const rest = seg.slice(tagEnd + 1);
  const trimmed = rest.replace(/^\s+/, "");
  if (trimmed.length === 0) return seg.length > PROBATION_CAP ? "release" : "hold";
  if (trimmed.startsWith("{")) {
    if (/^[\s\S]*?"name"\s*:/.test(trimmed)) return "confirm";
    return seg.length > PROBATION_CAP ? "release" : "hold";
  }
  if (trimmed.startsWith("<")) {
    const isClosing = /^<\s*\//.test(trimmed);
    const m = /^<\s*\/?\s*(?:[A-Za-z][\w.-]*\s*:\s*)?([a-zA-Z_][\w-]*)?/.exec(trimmed);
    const nm = (m?.[1] ?? "").toLowerCase();
    // 名字段还是半截（<、</、<inv…）或工具词根候选 → 可能长成 named child /
    // 同名闭标签，继续扣；确认不了的（<b>、</div> 等）放行
    const couldBeRelevant =
      nm === ""
        ? true
        : TOOLISH_NAME_ROOTS.some((r) => nm.includes(r) || r.startsWith(nm)) ||
          (isClosing && tagName.startsWith(nm));
    if (couldBeRelevant) {
      const closeSelfRe = new RegExp(
        `^<\\s*\\/\\s*(?:${GENERIC_NS_PATTERN})${escapeRegExp(tagName)}\\s*>`,
        "i",
      );
      if (closeSelfRe.test(trimmed)) return "confirm";
      const namedChildRe = new RegExp(
        `^<\\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\\s+[^>]*?\\bname\\s*=`,
        "i",
      );
      if (namedChildRe.test(trimmed)) return "confirm";
      return seg.length > PROBATION_CAP ? "release" : "hold";
    }
    return "release";
  }
  return "release";
}

export function createStreamDsmlSanitizer() {
  let pending = "";
  let depth = 0;
  /**
   * 留观段：裸工具词根开标签（无 name 属性、注册表也不认）扣住待判。
   * 确认 → 转协议态吞掉整块；证伪 → 原样放行（宁可透出也不吞正文）。
   * 解决未注册格式的流式透出：JSON 载荷容器 / 外层包裹的协议文本不再
   * 打进打字机，只等流末剥离。
   */
  let probation: { seg: string; tagName: string } | null = null;

  function drain(): string {
    let out = "";
    while (true) {
      if (probation) {
        // 留观中：新 chunk 全部并入留观段，直到判决
        probation.seg += pending;
        pending = "";
        const verdict = evaluateProbation(probation.seg, probation.tagName);
        if (verdict === "confirm") {
          // 转协议态：去掉开标签，其余内容（含已到达的闭标签）交回主循环按协议处理
          const tagEnd = probation.seg.indexOf(">");
          pending = tagEnd >= 0 ? probation.seg.slice(tagEnd + 1) : "";
          depth = 1;
          probation = null;
          continue;
        }
        if (verdict === "release") {
          out += probation.seg;
          probation = null;
          continue;
        }
        return out; // hold：证据未齐，等下一 chunk
      }
      // 两类协议标签取更早出现者：DSML（Kimi 竖线格式）/ 通用 XML（MiniMax M3、Qwen 系）
      const dsmlMatch = DSML_ANY_TAG_RE.exec(pending);
      const textualMatch = TEXTUAL_TOOL_ANY_TAG_RE.exec(pending);
      const tagMatch =
        dsmlMatch && (!textualMatch || dsmlMatch.index <= textualMatch.index)
          ? dsmlMatch
          : textualMatch;
      // 正常态：先看是否有更早的「裸工具词根开标签」要留观
      if (depth === 0) {
        const bare = findBareToolishOpen(pending);
        if (bare && (bare.index < (tagMatch?.index ?? pending.length))) {
          out += pending.slice(0, bare.index);
          probation = { seg: pending.slice(bare.index), tagName: bare.tagName };
          pending = "";
          return out;
        }
      }
      if (tagMatch) {
        const isClosing = /^<\s*\//.test(tagMatch[0]);
        const isSelfClosing = /\/\s*>$/.test(tagMatch[0]);
        if (depth > 0) {
          // 协议态：标签前的内容（参数值/工具名等协议正文）连同标签一并丢弃
          pending = pending.slice(tagMatch.index + tagMatch[0].length);
          if (isSelfClosing) continue; // 自闭合不改变深度
          if (isClosing) {
            depth -= 1;
          } else {
            depth += 1;
          }
          continue;
        }
        // 正常态：标签前是正常正文，放行；再处理标签本身
        out += pending.slice(0, tagMatch.index);
        pending = pending.slice(tagMatch.index + tagMatch[0].length);
        if (isClosing || isSelfClosing) {
          // 游离闭/自闭合标签：只剥标签，不出协议、不进协议态
          continue;
        }
        depth = 1;
        continue;
      }
      // 无完整标签：按状态滞留半截前缀，其余全部处理
      const hold = Math.max(
        dsmlPartialTagTailLen(pending),
        textualToolPartialTagTailLen(pending),
      );
      if (hold > 0) {
        if (depth > 0) {
          // 协议态：滞留尾部可能是半截闭标签，其余协议内容丢弃
          pending = pending.slice(pending.length - hold);
        } else {
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
        }
      } else if (depth > 0) {
        pending = "";
      } else {
        out += pending;
        pending = "";
      }
      return out;
    }
  }

  return {
    feed(delta: string): string {
      pending += delta;
      return drain();
    },
    flush(): string {
      const rest = pending;
      pending = "";
      // 协议块未闭合（流被截断）：剩余内容全部视为协议丢弃
      if (depth > 0) return "";
      // 留观中流就结束了（未确认）：JSON 形态大概率是截断的协议残渣，丢弃；
      // 其余（含孤立裸标签的正文用法）原样放行——宁可透出不吞正文。
      if (probation) {
        const held = probation.seg;
        probation = null;
        const tagEnd = held.indexOf(">");
        const restAfterTag = tagEnd >= 0 ? held.slice(tagEnd + 1).trim() : "";
        return restAfterTag.startsWith("{") ? "" : held;
      }
      // 正常态残留的半截协议前缀（如结尾悬着 `< |`、`<tool_call`）：协议残渣，丢弃
      if (dsmlPartialTagTailLen(rest) > 0) return "";
      if (textualToolPartialTagTailLen(rest) > 0) return "";
      return rest;
    },
  };
}

/**
 * 剥离 Moonshot/Kimi 在 `content` 字段里泄漏的 DSML 工具调用标记。
 *
 * 背景：Moonshot/Kimi 的部分模型/模式会同时把工具调用写到结构化 `tool_calls` 字段
 * 以及写到 `content` 文本里（DSML XML 格式：`<| | DSML| | tool_calls> ... </| | DSML| | tool_calls>`）。
 * 这种「双重写出」会让内部格式透出到用户可见的 assistant 消息里（截图里能看到完整的
 * `<| | DSML| | invoke name="fetch_web"><| | DSML| | parameter ...>...` 块），既影响体验
 * 也可能让前端模板解析炸掉。
 *
 * 实际观测到的格式变体（已覆盖）：
 *   - `<| | DSML| | tool_calls>...</| | DSML| | tool_calls>`（带前后两个 `| |`）
 *   - `<| | DSML| |tool_calls>...</| | DSML| |tool_calls>`（开标签无尾 `| |`，但闭合标签有）
 *   - `<||DSML||tool_calls>...</||DSML||tool_calls>`（紧凑无空格）
 *   - `<| | DSML| |invoke name="...">...</| | DSML| |invoke>`（invoke 块独立成行）
 *
 * 策略：只剥 `tool_calls` 块（连同其内容），其他 `DSML` 标签（如 `</DSML>` 之类的
 * 残留闭合）一并清掉；参数值（url 等）已经在结构化 tool_calls 里被使用，正文不需要再保留。
 */
/**
 * 启发式剥离探测：词根闭标签 / 带 name 属性的词根开标签 / 含 "name" 键 JSON
 * 载荷的词根容器——命中才进启发式剥离段（未注册格式的正文净化）。
 */
const HEURISTIC_STRIP_PROBE_RE = new RegExp(
  [
    String.raw`<\s*\/\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\s*>`,
    String.raw`<\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\s+[^>]*?\bname\s*=`,
    String.raw`<\s*${GENERIC_NS_PATTERN}${TOOLISH_NAME_PATTERN}\s*>\s*\{[\s\S]*?"name"\s*:`,
  ].join("|"),
  "i",
);

export function stripDsmlToolCallMarkup(content: string): string {
  if (!content) return content;
  // 2026-10-07 扩面：除 DSML 外，同时剥离通用 XML 文本形态工具调用
  // （MiniMax M3 线上泄漏的 <tool_call><invoke name=…>、Qwen JSON 变体）
  const hasDsml = /dsml/i.test(content);
  const hasTextualMarkup =
    /<\s*\/?\s*(?:minimax\s*:\s*)?(?:tool_call|invoke|parameter)\b/i.test(content);
  // 未注册格式：结构启发式探测（词根标签 + name 属性/JSON 载荷定性）
  const hasHeuristicMarkup = HEURISTIC_STRIP_PROBE_RE.test(content);
  if (!hasDsml && !hasTextualMarkup && !hasHeuristicMarkup) return content;
  let cleaned = content;

  const dsmlToolCallsBlock = new RegExp(
    `${DSML_TAG_PREFIX}tool_calls\\s*>[\\s\\S]*?${DSML_TAG_PREFIX}tool_calls\\s*>`,
    "gi",
  );
  cleaned = cleaned.replace(dsmlToolCallsBlock, "");
  cleaned = cleaned.replace(
    new RegExp(`${DSML_TAG_PREFIX}tool_calls\\s*>[\\s\\S]*$`, "gi"),
    "",
  );
  cleaned = cleaned.replace(
    new RegExp(`${DSML_TAG_PREFIX}(?:invoke|parameter)\\b[^>]*>[\\s\\S]*?${DSML_TAG_PREFIX}(?:invoke|parameter)\\s*>`, "gi"),
    "",
  );
  cleaned = cleaned.replace(
    new RegExp(`${DSML_TAG_PREFIX}[^>]*>`, "gi"),
    "",
  );

  // 竖线字符类：兼容半角 `|` (U+007C) 和全角 `｜` (U+FF5C)
  // Moonshot/Kimi 在不同 token 化下会输出两种形式，必须都覆盖。
  const pipe = DSML_PIPE;

  // 关键修复：DSML 实际格式里开标签在 `DSML` 之后**不一定有 `| |`**（`tool_calls` 直接接在 `|` 后面）。
  // 兼容形式：DSML 之后允许 `| |tool_calls` / `| | tool_calls` / `| |  tool_calls` 任意空白/无空白。
  // 主块：成对的 tool_calls ... /tool_calls（dotall 允许跨行）
  const toolCallsBlockPaired = new RegExp(
    `<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*tool_calls\\s*>[\\s\\S]*?<\\s*\\/\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*tool_calls\\s*>`,
    "gi",
  );
  cleaned = cleaned.replace(toolCallsBlockPaired, "");
  // 兜底：未闭合的开标签（模型偶尔切到一半就 finish），剥到行尾
  cleaned = cleaned.replace(
    new RegExp(`<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*tool_calls\\s*>[\\s\\S]*$`, "gi"),
    "",
  );

  // 额外修复：开标签无尾 `| |` 的格式（实测命中，如 `<| | DSML| |tool_calls>`）
  // 这种格式通常会与 invoke 块在同一段里整体出现。直接用更宽松的 `tool_calls` 块匹配。
  const looseToolCallsPaired = new RegExp(
    `<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?tool_calls\\s*>[\\s\\S]*?<\\s*\\/\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?tool_calls\\s*>`,
    "gi",
  );
  cleaned = cleaned.replace(looseToolCallsPaired, "");
  // 半截的 tool_calls 块（开标签匹配但无闭合）
  cleaned = cleaned.replace(
    new RegExp(`<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?tool_calls\\s*>[\\s\\S]*$`, "gi"),
    "",
  );

  // 单独存在的 invoke / parameter 块（紧跟 tool_calls 剥离后，避免孤立残留）
  // 形如 `<| | DSML| | invoke name="fetch_web">...<| | DSML| | parameter ...>...<| | DSML| | invoke>`
  const invokeBlockPaired = new RegExp(
    `<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?invoke\\b[^<>]*>[\\s\\S]*?<\\s*\\/\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?invoke\\s*>`,
    "gi",
  );
  cleaned = cleaned.replace(invokeBlockPaired, "");
  cleaned = cleaned.replace(
    new RegExp(`<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?invoke\\b[^<>]*\\/?><[\\s\\S]*?<\\s*\\/\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}[^<>]*?parameter\\s*>`, "gi"),
    "",
  );

  // 残留的关闭标签 / 空 invoke 块
  cleaned = cleaned.replace(
    new RegExp(`<\\s*\\/\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*(?:tool_calls|invoke|parameter)\\s*>`, "gi"),
    "",
  );
  cleaned = cleaned.replace(
    new RegExp(`<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*(?:invoke|parameter)\\b[^<>]*\\/?>`, "gi"),
    "",
  );
  // 兼容 `||` 紧贴的紧凑形式（含全角）
  cleaned = cleaned.replace(
    new RegExp(`<\\s*${pipe}\\s*${pipe}\\s*DSML\\s*${pipe}\\s*${pipe}\\s*[^<>]*?\\/?>`, "gi"),
    "",
  );

  // ── 通用 XML 文本形态（MiniMax M3 / Qwen 系，2026-10-07 扩面）──
  if (hasTextualMarkup) {
    const anyToolTag = String.raw`<\s*\/?\s*(?:minimax\s*:\s*)?(?:tool_call|invoke|parameter)\b[^>]*>`;
    // 成对 tool_call 块（含内部 invoke/parameter 与 JSON 变体）
    cleaned = cleaned.replace(
      /<\s*(?:minimax\s*:\s*)?tool_call\b[^>]*>[\s\S]*?<\s*\/\s*(?:minimax\s*:\s*)?tool_call\s*>/gi,
      "",
    );
    // 未闭合 tool_call 开块（流被截断）：剥到串尾
    cleaned = cleaned.replace(
      /<\s*(?:minimax\s*:\s*)?tool_call\b[^>]*>[\s\S]*$/gi,
      "",
    );
    // 孤立 invoke 块（无外层 tool_call 包裹）
    cleaned = cleaned.replace(
      /<\s*(?:minimax\s*:\s*)?invoke\b[^>]*>[\s\S]*?<\s*\/\s*(?:minimax\s*:\s*)?invoke\s*>/gi,
      "",
    );
    // 游离标签残渣（开/闭/自闭合 parameter 等）
    cleaned = cleaned.replace(new RegExp(anyToolTag, "gi"), "");
  }

  // ── 结构启发式（未注册格式：词根标签 + name 属性 / JSON 载荷定性）──
  if (hasHeuristicMarkup) {
    const ns = GENERIC_NS_PATTERN;
    const nm = `(${TOOLISH_NAME_PATTERN})`;
    // 成对 name-attr 容器（连同内部 invoke/参数与载荷，闭标签须同名）
    cleaned = cleaned.replace(
      new RegExp(
        String.raw`<\s*${ns}${nm}\s+[^>]*?\bname\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\s*\/\s*${ns}\1\s*>`,
        "gi",
      ),
      "",
    );
    // 成对 JSON 载荷容器（无属性定性，载荷含 "name": 键才剥）
    cleaned = cleaned.replace(
      new RegExp(
        String.raw`<\s*${ns}${nm}\s*>\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*<\s*\/\s*${ns}\1\s*>`,
        "gi",
      ),
      "",
    );
    // 未闭合 name-attr 开容器（流被截断）：剥到串尾
    cleaned = cleaned.replace(
      new RegExp(
        String.raw`<\s*${ns}${nm}\s+[^>]*?\bname\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*$`,
        "gi",
      ),
      "",
    );
    // 游离闭标签残渣
    cleaned = cleaned.replace(
      new RegExp(String.raw`<\s*\/\s*${ns}${nm}\s*>`, "gi"),
      "",
    );
  }

  // 合并多余空行/收尾空白
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return cleaned;
}

/**
 * 决定「对外展示什么文本」。
 * 规则（按顺序）：
 *  1. 若 `content.trim()` 非空：返回 content（已经是最终态）。
 *  2. 若 `content` 为空但 `reasoning` 非空：清洗掉 think 标签后返回 reasoning。
 *     这是关键兜底：思考模型经常把「思考过程 + 正式答案」都写进 reasoning，外面包 think 标签。
 *  3. 两者都为空：返回空串（让上层走 EmptyStreamContentError）。
 *
 * reasoning 兜底路径还要过一道 DSML 协议标记剥离（2026-09-12）：思考模型偶尔把
 * 工具调用按训练格式（<| | DSML | | invoke…>）写成 reasoning 草稿、content 留空，
 * 该路径此前的 stripThinkTags 不认识 DSML，协议原文会整段泄漏进正式回复。
 * （只剥展示，不执行——reasoning 里的调用是思考草稿，提取执行会放大误触发。）
 */
export function pickVisibleText(
  content: string,
  reasoning: string,
): string {
  const c = content.trim();
  if (c) return content;
  const r = reasoning.trim();
  if (!r) return "";
  return stripDsmlToolCallMarkup(stripThinkTags(reasoning));
}

/* ------------------------------------------------------------------ *
 * 内部控制信号标签净化（根源防透出）                                  *
 * ------------------------------------------------------------------ */

/**
 * 模型偶发会把「给自身的内部指令 / 控制信号」写成方括号标签混进正式回复，
 * 例如：
 *   - 话题切换标签：`[话题切换，只答这个]` / `[Topic switched — don't revisit.]`
 *   - 停止/待用户输入信号：`[STOP needs a message from the user]`
 *
 * 它们不是要给用户看的内容。此前只在 `finishLlmTurn` 里对最终文本剥一次，
 * 但**流式通路早就把这些标签逐字推给前端了**，后置剥离无法撤回已展示的气泡。
 * 因此必须在推流的咽喉处（provider delta 回调 / tool-loop 最终推送前）净化，
 * 本文件是 provider-agnostic 的公共底座，这里统一提供：
 *   - `stripInternalControlTags(text)`：整串剥离（用于一次性文本，如 tool-loop
 *     最终回复、emergency regenerate 等）。
 *   - `createStreamControlTagSanitizer()`：带缓冲的流式净化器（用于 provider
 *     逐 chunk 直推 onDelta 的场景，能跨多个 chunk 识别被切断的标签后丢弃）。
 */
const INTERNAL_CONTROL_TAG_FULL_RE =
  /^\s*(?:\[话题已?切换[^\]]*\]|\[[Tt]opic[^\]]*\]|\[STOP\s+[^\]]*\])[\s:：—-]*/g;
/** 是否为「可能是控制标签的开头」（用于流式缓冲：是则继续吞，避免把半截标签吐出去）。 */
const INTERNAL_CONTROL_TAG_PREFIX_RE =
  /^\s*\[(?:话题已?切换|Topic|STOP)/i;

/**
 * 线程内部帧（[上一轮回复中断…] / [不可信内容围栏…] / [session-recap] …）前缀探测。
 *
 * 2026-10-08 事故：这些帧以 assistant 角色存在于线程里，模型会把它们当成「自己
 * 上一轮说过的话」原样复读，顺着流式通道直穿气泡。词干从内部帧契约统一取，
 * 保证与 stripInternalFrames 的名单永不分叉（此前各写一份正则，新增帧就漏一种）。
 */
const INTERNAL_FRAME_STEM_PREFIX_RE = INTERNAL_FRAME_PREFIX_RE;

/* ------------------------------------------------------------------ *
 * 元术语整句净化（2026-08-29）                                        *
 * ------------------------------------------------------------------ *
 * 兜底防御 LLM 复读系统元术语（如「执行脑/规划任务/已接手/处理中」）
 * 混入回复文本。规则：单句内若同时出现 ≥2 个"内部机制"关键词（且无
 * 任何正常内容主题词），整句丢弃。流式场景下跨 chunk 缓冲：直到遇
 * 到句末标点（。！？!?\n）才提交判定。
 *
 * 触发关键词已结合 system prompt 实际出现的术语：对话脑/执行脑/
 * 规划任务/已接手/处理中/转交/后台处理/正在处理 等。
 * ------------------------------------------------------------------ */
const META_TERM_KEYWORDS = [
  "对话脑",
  "执行脑",
  "规划任务",
  "已接手",
  "转交",
  "后台处理",
  "正在处理",
  "上一轮",
  "任务规划",
  "执行脑已",
  "规划任务,",
  "执行脑,",
];
/** 单句内同时出现 ≥ MIN_HITS 个元术语即视为元描述整句，整句丢弃。 */
const MIN_META_HITS = 2;
const SENTENCE_END_RE = /[。！？!?\n]/;

/* ------------------------------------------------------------------ *
 * 元决策自述整句净化（2026-10-11，「问时间」4 泡事故）                   *
 * ------------------------------------------------------------------ *
 * 现象：用户问「现在几点」，模型把**该不该调工具**的内心权衡写进了 content
 * （不是 reasoning 通道——那条只累积不推流，客户端也没有渲染入口），随工具波
 * 前导话直穿气泡，被分泡器切成 4 条：
 *   ①（用户问现在几点，根据规范必须调用 clock.getcurrenttime，禁止臆测。）
 *   ② 系统已注入当前时间提示"…凌晨"，但强制规则要求必须调用工具以拿到…
 *   ③ 直接调用。王哥，现在是 … 贵州兴义这边的时间。
 *   ④ 这么晚还没睡?
 * 触发源已按「prompt 口径统一」根修（system 说"不要调工具查时间"、工具描述说
 * "必须调用"——同一上下文互斥，模型只能先自述再执行）。本过滤器是第二道保险：
 * 口径万一再漂，自述也出不了气泡。
 *
 * 与 isMetaOnlySentence（元术语需 ≥2 命中）的分工：这一族的判据是**单命中即删**，
 * 因为下列短语几乎不可能出现在对用户说话的正常正文里——它们是模型在跟自己讲规则。
 * 误删防护（宁漏勿残）：句内出现代码/URL/技术名词（豁免清单）或整句超长 → 放行。
 */
const META_DECISION_HARD_RE =
  /(根据(?:规范|规则|要求)|按照(?:规范|规则|要求)|遵守(?:规范|规则)|遵循(?:规范|规则)|强制(?:调用)?规则|必须调用|应当调用|禁止臆测|系统已注入|已注入[^。！？\n]{0,10}(?:提示|时间|上下文)|\[系统注入\]|\[system[-_ ]?context\]|（system注入）|已为你联网检索|已为你查到|已联网检索到|调用\s*clock)/;
/** 软判据：整句就是一句光秃秃的动作宣告（「直接调用。」「先调用工具。」），
 *  只在整句≤8 字且没有别的内容时删——避免误伤「直接调用这个接口就行」这类正文。 */
const META_DECISION_SOFT_RE =
  /^(?:好[的]?[，,]?\s*)?(?:那么|那就|我)?(?:直接)?(?:去|先)?(?:调用|调一下)(?:工具|本工具|clock(?:\.\w+)?|get_current_time)?\s*$/u;
/** 决策自述整句的长度上限：真自述都是短句；长句多半是有内容的正文。 */
const META_DECISION_MAX_CHARS = 90;
/** 代码/技术语境豁免：命中即放行（豁免无害，误删有害）。 */
const CODE_CONTEXT_RE =
  /(`|```|https?:\/\/|\b(?:API|JSON|HTTP|SDK)\b|函数|接口|方法|参数|变量|报错|编译|脚本)/;

function isMetaDecisionSentence(sentence: string): boolean {
  const raw = sentence.trim();
  if (!raw) return false;
  if (raw.length > META_DECISION_MAX_CHARS) return false;
  if (CODE_CONTEXT_RE.test(raw)) return false;
  // 比较前剥掉句末标点与括号（「直接调用。」→「直接调用」）
  const bare = raw.replace(/^[\s（(【\[]+|[\s。！？!?：:，,、）)】\]\n]+$/gu, "");
  if (!bare) return false;
  return META_DECISION_HARD_RE.test(raw) || META_DECISION_SOFT_RE.test(bare);
}

/** 括号净开合数：>0 表示该句有未闭合的开括号（其闭合括号会作为残渣留在后面）。 */
function bracketBalance(s: string): number {
  let bal = 0;
  for (const ch of s) {
    if (ch === "（" || ch === "(") bal++;
    else if (ch === "）" || ch === ")") bal--;
  }
  return bal;
}

/** 吞掉因整句删除而残留的孤立闭括号（「（…」被删后剩下的「）」）。返回吞掉的数量。 */
function stripLeadingOrphanClosers(text: string, max: number): { text: string; used: number } {
  let out = text;
  let used = 0;
  while (used < max) {
    const m = /^\s*[）)]/.exec(out);
    if (!m) break;
    out = out.slice(m[0].length);
    used++;
  }
  return { text: out, used };
}

const SENTENCE_SPLIT_RE = /(?<=[。！？!?\n])/;

/** 孤立闭括号的跨批状态（流式分块喂入时，「」的闭合括号可能落在下一批）。 */
type OrphanCloserState = { orphan: number };

/**
 * 按句末标点切片并逐句过滤（元术语句 / 元决策自述句），顺带吞掉孤立闭括号。
 * @param state 流式路径需跨批传入同一 state；整串路径省略（内部新建）。
 */
function filterMetaSentences(text: string, state?: OrphanCloserState): string {
  if (!text) return text;
  const st = state ?? { orphan: 0 };
  const kept: string[] = [];
  for (const piece of text.split(SENTENCE_SPLIT_RE)) {
    if (!piece) continue;
    if (isMetaOnlySentence(piece) || isMetaDecisionSentence(piece)) {
      const bal = bracketBalance(piece.replace(/[\s。！？!?\n]+$/u, ""));
      if (bal > 0) st.orphan += bal;
      continue;
    }
    let s = piece;
    if (st.orphan > 0) {
      const r = stripLeadingOrphanClosers(s, st.orphan);
      s = r.text;
      st.orphan -= r.used;
    }
    if (s) kept.push(s);
  }
  return kept.join("");
}

/**
 * 整串版的元句净化（用于**一次性**文本：tool-loop 的最终回复与前导话）。
 *
 * 与 `createStreamMetaSentenceFilter` 的区别：后者按 chunk 喂入、未遇句末标点的
 * 尾部留在缓冲里继续累积（对逐 delta 推流是对的）；对已经完整的整串来说那个行为
 * 会把**末尾无句末标点的残句直接吞掉**，所以整串路径必须用这个纯函数版本
 * （split→过滤→join，无残句，未命中的正文一个字节不动）。
 */
export function stripMetaSentences(text: string): string {
  return filterMetaSentences(text);
}


function isMetaOnlySentence(sentence: string): boolean {
  if (!sentence) return false;
  let hits = 0;
  for (const kw of META_TERM_KEYWORDS) {
    if (sentence.includes(kw)) hits++;
    if (hits >= MIN_META_HITS) return true;
  }
  return false;
}

/**
 * 流式元术语整句净化器（兜底）。
 *
 * 用法：把 provider 推流的原始增量喂给 `feed(delta)`，返回值为可推前端的
 * 净化后增量。判定粒度：按句末标点切片，每个完整句独立检查；未遇到句末
 * 标点的尾部内容留在缓冲里继续累积。
 *
 * 与 createStreamControlTagSanitizer 的区别：本函数针对的是「整句描述
 * 元机制」（如「上一轮转入规划任务，执行脑已接手处理中」），而非方括
 * 号控制标签。
 */
export function createStreamMetaSentenceFilter(maxPendingChars = 1024) {
  let pending = "";
  const state: OrphanCloserState = { orphan: 0 };

  return function feed(delta: string): string {
    pending += delta;
    // 保险丝：缓冲过长直接切到直通，避免长段落被无限拦截。
    if (pending.length > maxPendingChars) {
      const out = pending;
      pending = "";
      return out;
    }
    // 没有句末标点 → 继续累积，不输出
    const lastEnd = Math.max(
      pending.lastIndexOf("。"),
      pending.lastIndexOf("！"),
      pending.lastIndexOf("？"),
      pending.lastIndexOf("!"),
      pending.lastIndexOf("?"),
      pending.lastIndexOf("\n"),
    );
    if (lastEnd < 0) return "";
    // 切出已完成的句子，逐句过滤（元术语句 + 元决策自述句，孤立闭括号跨批吞掉）
    const complete = pending.slice(0, lastEnd + 1);
    pending = pending.slice(lastEnd + 1);
    return filterMetaSentences(complete, state);
  };
}

/** 整串剥离内部控制标签前缀（可匹配多个连续标签）。 */
export function stripInternalControlTags(text: string): string {
  if (!text) return text;
  // 先按内部帧契约做整串净化（围栏整块 / 帧整行 / 开头连续帧），
  // 再走原有的控制标签循环剥离。
  let out = stripInternalFrames(text);
  // 循环剥离，涵盖出现多次/中间含空白的情况
  for (let i = 0; i < 8; i++) {
    const next = out.replace(INTERNAL_CONTROL_TAG_FULL_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 流式内部控制标签净化器。
 *
 * 用法：把 provider 推流的原始增量喂给 `feed(delta)`，返回值是**可以推给前端**
 * 的净化后增量（返回空串表示这一段全被吞掉 / 仍在缓冲等待识别）。
 *
 * 原理：非工具分支是逐 chunk 直推 `onDelta`，`[STOP needs a message from the
 * user]` 可能被切成多个 chunk。这里维护一个缓冲：只要当前剩余内容是「可能是
 * 内部控制标签的前缀」，就继续吞住不输出；一旦确认不是标签（出现正常正文），
 * 就切到直通模式，把已累积内容一次性吐给前端。`maxPendingChars` 是保险丝，
 * 避免 tag 永不闭合导致无限缓冲。
 */
export function createStreamControlTagSanitizer(maxPendingChars = 512) {
  let pending = "";
  let passthrough = false;
  /**
   * 已确认进入「未终结的 `<system>` 控制帧体」：后续增量整段吞到帧体结束。
   *
   * 为什么需要这个独立状态：帧体是多行文本，前半段（opener + 控制标签行）在缓冲里
   * 能识别，但后半段的说明行**没有 opener**，逐 chunk 净化认不出来——一旦放通一次，
   * 整帧就直穿气泡（2026-10-11 实测：`<system>` 帧逐字符/3 字/10 字喂入全泄漏）。
   * 结束判据：出现 `</system>` 或帧体后出现空行分界（之后跟随的是正文）。
   */
  let swallowSystemFrame = false;
  /** 吞帧体时的缓冲上限（超过则只留尾部判界，避免内存无界）。 */
  const swallowCap = Math.max(4096, maxPendingChars * 8);

  return function feed(delta: string): string {
    if (swallowSystemFrame) {
      pending += delta;
      const terminated = /<\/system>/i.test(pending) || /\n[ \t]*\n/.test(pending);
      if (!terminated) {
        if (pending.length > swallowCap) pending = pending.slice(-64);
        return "";
      }
      const rest = stripInternalFrames(pending);
      pending = "";
      swallowSystemFrame = false;
      if (!rest) return "";
      passthrough = true;
      return rest;
    }

    if (passthrough) return delta;

    pending += delta;

    // 保险丝：pending 过长判定为正常正文，强制切到直通，避免无限吞。
    if (pending.length > maxPendingChars) {
      passthrough = true;
      const out = pending;
      pending = "";
      return out;
    }

    // `<system>` 控制帧（2026-10-11 事故根源）：未终结就先扣住整条流。
    // 顺序在一切剥离之前——半截 opener（首 chunk 往往只有 `<`）也要扣住，
    // 否则净化器直接切直通，整帧逐字穿到气泡。
    const sysState = systemFrameStreamState(pending);
    if (sysState === "body") {
      swallowSystemFrame = true;
      return "";
    }
    if (sysState === "pending") return "";
    if (isPartialSystemOpener(pending)) return "";

    // 先做整串剥离（循环剥掉完整标签，可能连着多个）。
    const stripped = stripInternalControlTags(pending);

    if (stripped.length > 0) {
      // 剥后还有内容：检查剩余内容是否仍可能是某个标签的前缀。
      // 若是（例如剥掉一个 tag 后又出现另一个 tag 的开头），继续吞；
      // 否则说明已经是正常正文，切直通并吐出去。
      if (
        INTERNAL_CONTROL_TAG_PREFIX_RE.test(stripped) ||
        INTERNAL_FRAME_STEM_PREFIX_RE.test(stripped)
      ) {
        pending = stripped;
        return "";
      }
      // XML 形态 <system-reminder>（2026-10-08 事故根源）：末尾是它的半截
      // 前缀（如 `<system-`）时扣住待判——整标签到齐后下一轮 feed 的整串
      // 剥离会连块删掉，半截先吐就撤不回了。
      if (systemReminderPartialTailLen(stripped) > 0) {
        pending = stripped;
        return "";
      }
      // XML 形态 <system> 控制帧（2026-10-11 事故根源）：同理扣住半截 opener
      // （`<sy…`）。整帧到齐后 stripInternalFrames 会整块剥掉；未闭合形态
      // （实测无 </system>）剥到块尾/EOF，全程不吐给用户。
      if (systemFramePartialTailLen(stripped) > 0) {
        pending = stripped;
        return "";
      }
      const rest = stripped.replace(INTERNAL_CONTROL_TAG_FULL_RE, "");
      if (
        rest !== stripped &&
        (INTERNAL_CONTROL_TAG_PREFIX_RE.test(rest) ||
          INTERNAL_FRAME_STEM_PREFIX_RE.test(rest))
      ) {
        pending = rest;
        return "";
      }
      passthrough = true;
      pending = "";
      return stripped;
    }

    // 全部被剥掉（只剩标签/空白）：可能还有更多标签进来，继续吞。
    pending = stripped;
    return "";
  };
}

/* ------------------------------------------------------------------ *
 * 4. 兜底异常                                                        *
 * ------------------------------------------------------------------ */

/**
 * 模型在**无工具轮次**（请求未携带 tools / 工具执行器缺位）用 DSML 文本形式
 * 发起了工具调用（2026-09-11 根修）。
 *
 * 触发场景：模型想调的工具不在本轮可见工具集里（对话面零工具、应急重生成、
 * 桥接离线剔除等），于是按训练格式把调用写成
 * `<| | DSML | | invoke name="tool_call">` 这类协议文本。历史上非工具分支把
 * consumeNormalizedStream 提取出的这些调用**静默丢弃**并返回空串——用户请求
 * 凭空消失；协议原文还可能已被流式推出。
 *
 * 上抛语义：调用方（agent-core runStandardLlmPath）捕获后升级到带工具的任务面
 * 重跑同一句用户消息——模型意图被真正执行，而不是丢给用户一句协议残渣。
 */
export class ToolIntentWithoutToolsError extends Error {
  readonly providerId?: string;
  readonly model?: string;
  /** 从协议标记（DSML / 通用 XML 文本形态）提取出的工具调用 */
  readonly toolCalls: NormalToolCall[];

  constructor(params: {
    providerId?: string;
    model?: string;
    toolCalls: NormalToolCall[];
  }) {
    const names = params.toolCalls.map((c) => c.name ?? "?").join(", ");
    super(
      `Tool intent on tool-less turn (provider=${params.providerId ?? "?"} ` +
        `model=${params.model ?? "?"}): ${params.toolCalls.length} text-protocol-extracted ` +
        `call(s) [${names}] cannot execute without a tool executor`,
    );
    this.name = "ToolIntentWithoutToolsError";
    this.providerId = params.providerId;
    this.model = params.model;
    this.toolCalls = params.toolCalls;
  }
}

export class EmptyStreamContentError extends Error {
  readonly providerId?: string;
  readonly model?: string;
  readonly finishReason: string | null;
  readonly reasoningBytes: number;
  readonly hadToolCalls: boolean;

  constructor(params: {
    providerId?: string;
    model?: string;
    finishReason: string | null;
    reasoningBytes: number;
    hadToolCalls: boolean;
  }) {
    super(
      `Empty streamed content (provider=${params.providerId ?? "?"} ` +
        `model=${params.model ?? "?"} finish_reason=${params.finishReason ?? "?"} ` +
        `reasoning_bytes=${params.reasoningBytes} tool_calls=${params.hadToolCalls})`,
    );
    this.name = "EmptyStreamContentError";
    this.providerId = params.providerId;
    this.model = params.model;
    this.finishReason = params.finishReason;
    this.reasoningBytes = params.reasoningBytes;
    this.hadToolCalls = params.hadToolCalls;
  }
}

/**
 * 一站式工具：消费流 → 决定可见文本 → 若空抛 EmptyStreamContentError。
 * 任何 provider 的非工具聊天路径都可以直接用这个，省掉重复 try/catch + 兜底模板。
 */
export async function consumeAndPickVisibleText(
  source: AsyncIterable<NormalChatChunk>,
  options: StreamConsumeOptions = {},
): Promise<{ text: string; result: StreamConsumeResult }> {
  const result = await consumeNormalizedStream(source, options);
  const text = pickVisibleText(result.content, result.reasoning);
  if (!text) {
    throw new EmptyStreamContentError({
      providerId: options.providerId,
      model: options.model,
      finishReason: result.finishReason,
      reasoningBytes: result.reasoning.length,
      hadToolCalls: result.toolCalls.length > 0,
    });
  }
  return { text, result };
}

/* ------------------------------------------------------------------ *
 * 5. Normalizer adapters                                             *
 * ------------------------------------------------------------------ */

/**
 * 把任意 plain object 形态的 chunk 适配成 NormalChatChunk 的「自适配」工厂。
 *
 * 工作机制：从首个非空 chunk 里**嗅探**出 content / reasoning / tool_calls / finish_reason
 * 实际使用的字段名（按下面的优先级匹配），然后用嗅探到的字段名去映射后续所有 chunk。
 * 之后再来新字段名也不会再切换。
 *
 * 嗅探优先级（reasoning 候选）：
 *   `reasoning_content` → `reasoning_text` → `reasoning` → `thinking` → `thinking_content` →
 *   `redacted_thinking` → `reasoning_delta`
 * 嗅探优先级（content 候选）：
 *   `content` → `text` → `delta` → `message`
 * 嗅探优先级（tool_calls 候选）：
 *   `tool_calls` → `tool_use` → `function_call` → `tool_call_delta`
 * 嗅探优先级（finish_reason 候选）：
 *   `finish_reason` → `stop_reason` → `finishReason`
 *
 * 适用场景：你不确定第三方代理 / 新厂商用的是哪个字段名。
 */
const REASONING_FIELD_CANDIDATES = [
  "reasoning_content",
  "reasoning_text",
  "reasoning",
  "thinking",
  "thinking_content",
  "redacted_thinking",
  "reasoning_delta",
] as const;
const CONTENT_FIELD_CANDIDATES = ["content", "text", "delta", "message"] as const;
const TOOL_CALL_FIELD_CANDIDATES = [
  "tool_calls",
  "tool_use",
  "function_call",
  "tool_call_delta",
] as const;
const FINISH_REASON_FIELD_CANDIDATES = [
  "finish_reason",
  "stop_reason",
  "finishReason",
] as const;

type GenericSourceChunk = {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
} & Record<string, unknown>;

function pickField(
  obj: Record<string, unknown>,
  candidates: readonly string[],
): string | null {
  for (const k of candidates) {
    if (k in obj && obj[k] != null) return k;
  }
  return null;
}

/**
 * 「自适配」normalizer：从首个非空 chunk 嗅探字段名后再做映射。
 * 强烈推荐用在不确定厂商字段名的场景（例如自建代理、第三方转发）。
 */
export function createAdaptiveNormalizer() {
  let resolved:
    | {
        contentField: string;
        reasoningField: string | null;
        toolCallField: string | null;
        finishReasonField: string | null;
      }
    | null = null;

  function resolveOnce(chunk: GenericSourceChunk): typeof resolved {
    if (resolved) return resolved;
    // 优先从 choices[0].delta 里找（OpenAI / Anthropic / Moonshot 都在这里）
    const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, unknown>;
    const finishReasonDelta = chunk.choices?.[0]?.finish_reason;
    const finishReasonRoot = pickField(chunk, FINISH_REASON_FIELD_CANDIDATES);

    // content：在 delta 里找第一个 string-typed candidate
    let contentField: string | null = null;
    for (const k of CONTENT_FIELD_CANDIDATES) {
      if (typeof delta[k] === "string" && (delta[k] as string).length > 0) {
        contentField = k;
        break;
      }
    }
    if (!contentField) {
      // 没找到就降级：把 delta 上 string-typed 的字段挨个试
      for (const k of Object.keys(delta)) {
        if (typeof delta[k] === "string" && k !== "role") {
          contentField = k;
          break;
        }
      }
    }

    // reasoning：嗅探后存为字段名
    const reasoningField = pickField(delta, REASONING_FIELD_CANDIDATES);

    // tool_calls：嗅探数组
    let toolCallField: string | null = null;
    for (const k of TOOL_CALL_FIELD_CANDIDATES) {
      if (Array.isArray(delta[k])) {
        toolCallField = k;
        break;
      }
    }

    // finish_reason：先看 choices[0]，再看根
    const finishReasonField =
      finishReasonDelta != null
        ? null // 直接从 choices[0].finish_reason 读，无需字段名
        : finishReasonRoot;

    resolved = {
      contentField: contentField ?? "content",
      reasoningField,
      toolCallField,
      finishReasonField,
    };
    return resolved;
  }

  function adapt(chunk: GenericSourceChunk): NormalChatChunk | null {
    if (!chunk || typeof chunk !== "object") return null;
    const fields = resolveOnce(chunk);
    if (!fields) return null;
    const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, unknown>;
    const choiceFinish = chunk.choices?.[0]?.finish_reason;

    const out: NormalChatChunk = {};

    const c = delta[fields.contentField];
    if (typeof c === "string" && c.length > 0) out.content = c;

    if (fields.reasoningField) {
      const r = delta[fields.reasoningField];
      if (typeof r === "string" && r.length > 0) out.reasoning = r;
    }

    if (fields.toolCallField) {
      const tcs = delta[fields.toolCallField];
      if (Array.isArray(tcs)) {
        out.toolCalls = (tcs as Array<Record<string, unknown>>).map((tc, i) => {
          const fn =
            (tc.function as Record<string, unknown> | undefined) ??
            (tc as Record<string, unknown>);
          return {
            index: typeof tc.index === "number" ? (tc.index as number) : i,
            id: (tc.id as string | null | undefined) ?? null,
            name: typeof fn.name === "string" ? (fn.name as string) : undefined,
            argumentsChunk:
              typeof fn.arguments === "string" ? (fn.arguments as string) : undefined,
          };
        });
      }
    }

    if (choiceFinish != null) {
      out.finishReason = String(choiceFinish);
    } else if (fields.finishReasonField) {
      const fr = chunk[fields.finishReasonField];
      if (typeof fr === "string" && fr.length > 0) out.finishReason = fr;
    }

    return out;
  }

  return { adapt, peek: () => resolved };
}

/* ------------------------------------------------------------------ *
 * 6. OpenAI 兼容 Chat Completions 专用 normalizer                     *
 * ------------------------------------------------------------------ */

import type OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import {
  INTERNAL_FRAME_PREFIX_RE,
  isPartialSystemOpener,
  stripInternalFrames,
  systemFramePartialTailLen,
  systemFrameStreamState,
  systemReminderPartialTailLen,
} from "./internal-frames.js";

/**
 * 把 OpenAI-compatible 的 usage 对象解析为 NormalUsage。
 * 兼容字段差异：
 * - DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * - OpenAI / Kimi：`prompt_tokens_details.cached_tokens`
 * - 公共：`prompt_tokens` / `completion_tokens`
 */
export function parseOpenAiUsage(raw: unknown): NormalUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  const hit =
    typeof u.prompt_cache_hit_tokens === "number"
      ? u.prompt_cache_hit_tokens
      : typeof u.prompt_tokens_details?.cached_tokens === "number"
        ? u.prompt_tokens_details.cached_tokens
        : undefined;
  const miss =
    typeof u.prompt_cache_miss_tokens === "number" ? u.prompt_cache_miss_tokens : undefined;
  const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const output = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  if (hit === undefined && miss === undefined && input === undefined && output === undefined) {
    return undefined;
  }
  return {
    ...(hit !== undefined ? { promptCacheHitTokens: hit } : {}),
    ...(miss !== undefined ? { promptCacheMissTokens: miss } : {}),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

/**
 * 把一个 OpenAI ChatCompletionChunk 适配成 NormalChatChunk。
 * 直接用 ChatCompletionChunk 类型，避免 any。
 */
export function adaptOpenAiChatCompletionChunk(
  chunk: ChatCompletionChunk,
): NormalChatChunk | null {
  const usage = parseOpenAiUsage(chunk.usage);
  const choice = chunk.choices?.[0];
  if (!choice) {
    // 纯 usage chunk：choices 为空数组（DeepSeek 等流式末尾在此返回 usage）→ 透出供审计采集
    return usage ? { usage } : null;
  }
  const out: NormalChatChunk = usage ? { usage } : {};

  if (typeof choice.finish_reason === "string") {
    out.finishReason = choice.finish_reason;
  }

  const delta = choice.delta as
    | (Record<string, unknown> & {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string | null;
          function?: { name?: string; arguments?: string };
        }>;
      })
    | null
    | undefined;
  if (!delta) return out;

  if (typeof delta.content === "string" && delta.content.length > 0) {
    out.content = delta.content;
  }

  // 嗅探 reasoning 字段（OpenAI 标准没有，但 Moonshot/DeepSeek 扩展为 reasoning_content）
  const rc =
    (delta as { reasoning_content?: unknown }).reasoning_content ??
    (delta as { reasoning?: unknown }).reasoning ??
    (delta as { thinking?: unknown }).thinking;
  if (typeof rc === "string" && rc.length > 0) {
    out.reasoning = rc;
  }

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    out.toolCalls = delta.tool_calls.map((tc, i) => ({
      index: typeof tc.index === "number" ? tc.index : i,
      id: tc.id ?? null,
      name: tc.function?.name,
      argumentsChunk: tc.function?.arguments,
    }));
  }

  return out;
}

/**
 * 把 OpenAI ChatCompletionChunk 流整条适配成 NormalChatChunk 流。
 * 这是最常用的入口：直接喂给 `consumeNormalizedStream` / `consumeAndPickVisibleText`。
 */
export async function* adaptOpenAiChatCompletionStream(
  source: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<NormalChatChunk> {
  for await (const chunk of source) {
    const n = adaptOpenAiChatCompletionChunk(chunk);
    if (n) yield n;
  }
}

/**
 * 把 NormalToolCall[] 物化为 OpenAI SDK 期望的 ChatCompletionMessageToolCall[] 形态。
 * 给那些仍然需要 SDK 类型（mongo 持久化 / protocol 序列化）的旧调用方使用。
 */
export function materializeOpenAiToolCalls(
  toolCalls: NormalToolCall[],
  model?: string,
): ChatCompletionMessageToolCall[] {
  return toolCalls.map((v, idx) => {
    let parsedArgs: Record<string, unknown> = {};
    const args = v.argumentsChunk ?? "";
    if (args) {
      try {
        const obj = JSON.parse(args);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsedArgs = obj as Record<string, unknown>;
        }
      } catch {
        // 半截 JSON 时保留空对象
      }
    }
    if (!v.id) {
      // eslint-disable-next-line no-console
      console.warn(
        `[openai-tool-loop] tool_calls[${idx}].id is empty from stream; ` +
          `fallback to random id. model=${model ?? "?"} name=${v.name ?? "?"}`,
      );
    }
    const callId =
      v.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${idx}`;
    return {
      id: callId,
      type: "function" as const,
      function: {
        name: v.name ?? "",
        arguments: args || "{}",
      },
      ...({ parsedArgs } as object),
    } as ChatCompletionMessageToolCall & { parsedArgs: Record<string, unknown> };
  });
}
